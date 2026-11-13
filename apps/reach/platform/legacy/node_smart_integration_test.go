package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"ara/internal/agent"
	"ara/internal/nativeapp"
	"ara/internal/providers"
)

// TestNodeSmartRealChainToolLoopAndSessionReuse is the discriminating S04 path:
// runLocalAgent -> real WS grant -> Hub smart resolve -> shared gateway.Server ->
// native fake upstream. The upstream asks for a real host tool before returning
// the final answer, so a mere one-shot provider or hand-filled decision cannot pass.
func TestNodeSmartRealChainToolLoopAndSessionReuse(t *testing.T) {
	h := newNodeProtocolHarnessWith(t, nodeHarnessOptions{
		defaultModel: "chat-model", defaultProtocol: providers.OpenAICompletions,
		smartModel: "chat-model", smartProtocol: providers.OpenAICompletions,
	})
	h.approveNode("fp-smart-entry")
	a := h.agent(t)
	cn := h.connectNode(t, a, "fp-smart-entry")

	up := h.ups["up-"+providers.OpenAICompletions]
	var callMu sync.Mutex
	modelCalls := 0
	up.setHandle(func(w http.ResponseWriter, r *http.Request) bool {
		callMu.Lock()
		modelCalls++
		n := modelCalls
		callMu.Unlock()
		if n%2 == 1 {
			writeSSEToolCall(w, fmt.Sprintf("smart-list-%d", n), "list_dir", `{"path":"."}`)
		} else {
			writeSSEText(w, "smart-final")
		}
		return true
	})

	runSmart := func(runID, objective string) hostTask {
		done := make(chan struct{})
		go func() {
			defer close(done)
			a.runLocalAgent(cn, &dcf{K: "agent-loop", ID: runID, Msg: objective, Smart: true})
		}()
		<-done
		for _, task := range a.hostSession().tasks() {
			if task.Kind == "turn" && task.Title == clipText(objective, 80) {
				return task
			}
		}
		return hostTask{}
	}

	first := runSmart("smart-run-1", "inspect the current directory and summarize it")
	if first.Status != "completed" {
		t.Fatalf("first smart tool run must complete: %+v", first)
	}
	sess := a.hostSession()
	nativeID, bindingID := sess.state.NativeSessionID, sess.state.Binding
	if nativeID == "" || bindingID == "" || sess.state.Decision == "" {
		t.Fatalf("smart identity was not persisted: %+v", sess.state)
	}
	journal := filepath.Join(a.nativeSessionDir(), nativeID+".jsonl")
	before, err := os.ReadFile(journal)
	if err != nil || len(before) == 0 {
		t.Fatalf("first run must create a durable native journal: bytes=%d err=%v", len(before), err)
	}

	second := runSmart("smart-run-2", "inspect it once more and give the final answer")
	if second.Status != "completed" {
		t.Fatalf("second smart tool run must complete: %+v", second)
	}
	if sess.state.NativeSessionID != nativeID || sess.state.Binding != bindingID {
		t.Fatalf("different runs must reuse the session binding and journal: before=%s/%s after=%s/%s",
			nativeID, bindingID, sess.state.NativeSessionID, sess.state.Binding)
	}
	if got := h.smartResolveCalls(); got != 1 {
		t.Fatalf("one smart session must resolve exactly once, got %d", got)
	}
	after, err := os.ReadFile(journal)
	if err != nil || len(after) <= len(before) {
		t.Fatalf("second run must append to the same journal: before=%d after=%d err=%v", len(before), len(after), err)
	}
	callMu.Lock()
	gotCalls := modelCalls
	callMu.Unlock()
	if gotCalls != 4 {
		t.Fatalf("each run must execute one tool call and one final model call, got %d calls", gotCalls)
	}

	var codes []string
	for _, hit := range h.nodeHits() {
		if hit.Path != "/v1/chat/completions" {
			continue
		}
		code := strings.TrimPrefix(hit.Header.Get("Authorization"), "Bearer ")
		if code != "" && (len(codes) == 0 || codes[len(codes)-1] != code) {
			codes = append(codes, code)
		}
	}
	if len(codes) != 2 || codes[0] == codes[1] {
		t.Fatalf("different runs must use different short-lived codes, got %d distinct codes", len(codes))
	}

	for _, req := range up.snapshot() {
		if req.Header.Get(smartRunHeader) != "" || req.Header.Get(smartBindingHeader) != "" {
			t.Fatal("Hub association headers must be stripped before the native upstream")
		}
		var body struct {
			MaxTokens int `json:"max_completion_tokens"`
		}
		if err := json.Unmarshal(req.Body, &body); err != nil || body.MaxTokens <= 0 || body.MaxTokens > smartMaxOutputTokens {
			t.Fatalf("request output cap widened beyond the decision: %d", body.MaxTokens)
		}
	}
}

func TestNodeSmartRealChainSevenProtocolsAndSameWireCandidates(t *testing.T) {
	cases := []struct{ model, protocol string }{
		{"chat-model", providers.OpenAICompletions}, {"responses-model", providers.OpenAIResponses},
		{"anthropic-model", providers.AnthropicMessages}, {"gemini-model", providers.GoogleGenerativeAI},
		{"ollama-model", providers.OllamaChat}, {"azure-model", providers.AzureOpenAIResponses},
		{"openrouter-model", providers.OpenRouterChat},
		{"same-wire-model", providers.OpenRouterChat}, {"same-wire-model", providers.OpenAICompletions},
	}
	for _, tc := range cases {
		t.Run(tc.model+"-"+tc.protocol, func(t *testing.T) {
			h := newNodeProtocolHarnessWith(t, nodeHarnessOptions{defaultModel: tc.model, defaultProtocol: tc.protocol, smartModel: tc.model, smartProtocol: tc.protocol})
			h.approveNode("fp-seven")
			a := h.agent(t)
			cn := h.connectNode(t, a, "fp-seven")
			a.runLocalAgent(cn, &dcf{K: "agent-loop", ID: "seven-run", Msg: "Reply with a short answer", Smart: true})
			tasks := a.hostSession().tasks()
			if len(tasks) == 0 || tasks[len(tasks)-1].Status != "completed" {
				t.Fatalf("smart native run failed: %+v", tasks)
			}
			if a.hostSession().state.Protocol != tc.protocol {
				t.Fatal("concrete protocol was replaced by wire type")
			}
			for id, up := range h.ups {
				want := 0
				if id == "up-"+tc.protocol {
					want = 1
				}
				if up.calls() != want {
					t.Fatalf("candidate %s calls=%d want=%d", id, up.calls(), want)
				}
			}
			if h.smartResolveCalls() != 1 {
				t.Fatal("unexpected repeated selection")
			}
		})
	}
}

func TestNodeSmartRealRenewalAfterHTTPExpiryAndEndedRun(t *testing.T) {
	h := newNodeProtocolHarnessWith(t, nodeHarnessOptions{defaultModel: "chat-model", defaultProtocol: providers.OpenAICompletions, smartModel: "chat-model", smartProtocol: providers.OpenAICompletions})
	h.approveNode("fp-renew")
	a := h.agent(t)
	h.connectNode(t, a, "fp-renew")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	g, err := a.requestModelGrant(ctx, "renew-run", "first", true, "", "summarize", true)
	if err != nil {
		t.Fatal(err)
	}
	bk := h.hubSrv.bindings()
	bk.mu.Lock()
	bk.runs[bindingKey(nodeProtocolFixtureFP("fp-renew"), "renew-run")].Exp = time.Now().Add(-time.Second)
	bk.mu.Unlock()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, h.Hub.URL+"/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+g.code)
	req.Header.Set(smartRunHeader, "renew-run")
	req.Header.Set(smartBindingHeader, g.bindingID)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expired HTTP=%d", resp.StatusCode)
	}
	bk.mu.Lock()
	_, codeStillPresent := bk.byCode[g.code]
	_, runStillPresent := bk.runs[bindingKey(nodeProtocolFixtureFP("fp-renew"), "renew-run")]
	bk.mu.Unlock()
	if codeStillPresent || !runStillPresent {
		t.Fatal("expired lookup must delete only the code")
	}
	for _, binding := range []string{"", "forged"} {
		if _, err := a.renewModelGrant(ctx, "renew-run", "bad-"+binding, true, binding); err == nil {
			t.Fatal("renewal accepted missing/wrong binding")
		}
	}
	next, err := a.renewModelGrant(ctx, "renew-run", "refresh", true, g.bindingID)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateSmartGrant(next, &g); err != nil {
		t.Fatal(err)
	}
	if next.code == g.code {
		t.Fatal("renewal did not rotate code")
	}
	p, err := a.newNodeProvider(ctx, "renew-run", next.boundModel, next.boundProtocol, next.code, "renew-run", next.bindingID, next.boundMaxOutput, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Complete(ctx, agent.Request{Model: next.boundModel}, nil); err != nil {
		t.Fatal(err)
	}
	a.notifyRunEnd("renew-run")
	// WS writes are ordered: renewal follows end and must never recreate Run.
	if _, err := a.renewModelGrant(ctx, "renew-run", "after-end", true, next.bindingID); err == nil {
		t.Fatal("ended Run was resurrected")
	}
	if _, ok := bk.findPin(nodeProtocolFixtureFP("fp-renew"), g.bindingID); !ok {
		t.Fatal("ending Run removed valid session")
	}
	if h.smartResolveCalls() != 1 {
		t.Fatal("renewal performed fresh selection")
	}
}

func TestNodeSmartRealChainRejectsWrongAssociationsAndLostBinding(t *testing.T) {
	h := newNodeProtocolHarnessWith(t, nodeHarnessOptions{defaultModel: "chat-model", defaultProtocol: providers.OpenAICompletions, smartModel: "chat-model", smartProtocol: providers.OpenAICompletions})
	h.approveNode("fp-owner")
	a := h.agent(t)
	h.connectNode(t, a, "fp-owner")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	g, err := a.requestModelGrant(ctx, "run-owner", "first", true, "", "summarize", true)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, path, code, run, binding, model string }{
		{"missing-code", "/v1/chat/completions", "", "run-owner", g.bindingID, g.boundModel},
		{"forged-code", "/v1/chat/completions", "forged", "run-owner", g.bindingID, g.boundModel},
		{"wrong-run", "/v1/chat/completions", g.code, "other", g.bindingID, g.boundModel},
		{"wrong-binding", "/v1/chat/completions", g.code, "run-owner", "other", g.boundModel},
		{"wrong-model", "/v1/chat/completions", g.code, "run-owner", g.bindingID, "other"},
		{"wrong-wire", "/v1/messages", g.code, "run-owner", g.bindingID, g.boundModel},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := fmt.Sprintf(`{"model":%q,"messages":[{"role":"user","content":"hi"}],"max_completion_tokens":100}`, tc.model)
			req, _ := http.NewRequestWithContext(ctx, http.MethodPost, h.Hub.URL+tc.path, strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+tc.code)
			req.Header.Set(smartRunHeader, tc.run)
			req.Header.Set(smartBindingHeader, tc.binding)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode < 400 {
				t.Fatalf("invalid request accepted: %d", resp.StatusCode)
			}
		})
	}
	h.approveNode("fp-other")
	other := h.agent(t)
	h.connectNode(t, other, "fp-other")
	if _, err := other.requestModelGrant(ctx, "run-other", "cross-fp", true, g.bindingID, "", true); err == nil {
		t.Fatal("binding reused across FP")
	}
	h.hubSrv.bindings().revokePin(nodeProtocolFixtureFP("fp-owner"), g.bindingID)
	if _, err := a.renewModelGrant(ctx, "run-owner", "lost", true, g.bindingID); err == nil {
		t.Fatal("lost binding silently renewed")
	}
	if _, err := a.requestModelGrant(ctx, "run-new", "lost-new", true, g.bindingID, "", true); err == nil {
		t.Fatal("lost binding silently reselected")
	}
	for _, up := range h.ups {
		if up.calls() != 0 {
			t.Fatal("rejected authorization reached upstream")
		}
	}
	if h.smartResolveCalls() != 1 {
		t.Fatal("lost/cross-FP binding silently selected again")
	}
}

func TestNodeSmartRealProviderCoversLeafAndCompaction(t *testing.T) {
	h := newNodeProtocolHarnessWith(t, nodeHarnessOptions{defaultModel: "chat-model", defaultProtocol: providers.OpenAICompletions, smartModel: "chat-model", smartProtocol: providers.OpenAICompletions})
	h.approveNode("fp-core")
	a := h.agent(t)
	h.connectNode(t, a, "fp-core")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	g, err := a.requestModelGrant(ctx, "core-run", "first", true, "", "summarize workspace", true)
	if err != nil {
		t.Fatal(err)
	}
	p, err := a.newNodeProvider(ctx, "core-run", g.boundModel, g.boundProtocol, g.code, "core-run", g.bindingID, g.boundMaxOutput, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	s := a.hostSession()
	leaf := a.delegateTool(s, g.boundModel, p, func(string, agentEvent) {})
	if result, err := leaf.Execute(ctx, json.RawMessage(`{"objective":"Give a short workspace summary"}`)); err != nil || result.IsError {
		t.Fatalf("leaf failed: %v %+v", err, result)
	}
	host := &nativeapp.Host{Provider: p, ProviderID: hostProviderID, Model: g.boundModel, System: hostSystemPrompt()}
	opts := nativeapp.Options{Cwd: a.agentCwd(), SessionDir: a.nativeSessionDir(), Host: host, Prompt: strings.Repeat("first turn source context ", 80)}
	first, err := nativeapp.Run(ctx, opts, nil)
	if err != nil {
		t.Fatal(err)
	}
	opts.SessionID = first.SessionID
	opts.Prompt = "second turn"
	if _, err := nativeapp.Run(ctx, opts, nil); err != nil {
		t.Fatal(err)
	}
	opts.Prompt = ""
	compact, err := nativeapp.Compact(ctx, opts, "retain the goal", nil)
	if err != nil || !compact.ModelCalled || compact.Summary == "" {
		t.Fatalf("compaction did not really complete: %+v err=%v", compact, err)
	}
	requests := h.ups["up-"+providers.OpenAICompletions].snapshot()
	if len(requests) != 4 {
		t.Fatalf("want leaf + two main + compact requests, got %d", len(requests))
	}
	for i, req := range requests {
		var b struct {
			MaxTokens int               `json:"max_completion_tokens"`
			Tools     []json.RawMessage `json:"tools"`
		}
		if err := json.Unmarshal(req.Body, &b); err != nil || b.MaxTokens <= 0 || b.MaxTokens > g.boundMaxOutput {
			t.Fatalf("call %d cap=%d err=%v", i, b.MaxTokens, err)
		}
		if i == 0 && len(b.Tools) == 0 {
			t.Fatal("leaf lost its local tools")
		}
		if i == 3 && len(b.Tools) != 0 {
			t.Fatal("summary call unexpectedly has tools")
		}
	}
	a.notifyRunEnd("core-run")
}

func TestNodeSmartRealEntryPersistenceFailureAndExpiryPreserveHistory(t *testing.T) {
	h := newNodeProtocolHarnessWith(t, nodeHarnessOptions{defaultModel: "chat-model", defaultProtocol: providers.OpenAICompletions, smartModel: "chat-model", smartProtocol: providers.OpenAICompletions})
	h.approveNode("fp-state")
	a := h.agent(t)
	cn := h.connectNode(t, a, "fp-state")
	s := a.hostSession()
	s.beforeWrite = func([]byte) error { return errors.New("fixture disk failure") }
	a.runLocalAgent(cn, &dcf{K: "agent-loop", ID: "failed-write", Msg: "summarize", Smart: true})
	if h.ups["up-"+providers.OpenAICompletions].calls() != 0 || s.state.NativeSessionID != "" || s.state.Binding != "" || s.state.Model != "" {
		t.Fatal("failed state write leaked model execution or partial identity")
	}
	s.beforeWrite = nil
	a.runLocalAgent(cn, &dcf{K: "agent-loop", ID: "good-write", Msg: "summarize", Smart: true})
	id, binding := s.state.NativeSessionID, s.state.Binding
	if id == "" || binding == "" {
		t.Fatal("valid smart entry did not persist session")
	}
	journal := filepath.Join(a.nativeSessionDir(), id+".jsonl")
	before, _ := os.ReadFile(journal)
	bk := h.hubSrv.bindings()
	bk.mu.Lock()
	bk.pins[bindingKey(nodeProtocolFixtureFP("fp-state"), binding)].DecisionExp = time.Now().Add(-time.Second)
	bk.mu.Unlock()
	calls := h.ups["up-"+providers.OpenAICompletions].calls()
	resolves := h.smartResolveCalls()
	a.runLocalAgent(cn, &dcf{K: "agent-loop", ID: "expired-session", Msg: "continue", Smart: true})
	// A mode change cannot silently turn the same smart session into a wide grant.
	a.runLocalAgent(cn, &dcf{K: "agent-loop", ID: "implicit-downgrade", Msg: "continue"})
	after, _ := os.ReadFile(journal)
	if s.state.NativeSessionID != id || s.state.Binding != binding || string(before) != string(after) {
		t.Fatal("expired session lost or changed history")
	}
	if h.smartResolveCalls() != resolves || h.ups["up-"+providers.OpenAICompletions].calls() != calls {
		t.Fatal("expired or non-smart continuation silently executed")
	}
}

func TestNodeSmartDirectoryAndEachCompleteRefreshIndependently(t *testing.T) {
	h := newNodeProtocolHarnessWith(t, nodeHarnessOptions{defaultModel: "chat-model", defaultProtocol: providers.OpenAICompletions, smartModel: "chat-model", smartProtocol: providers.OpenAICompletions})
	h.approveNode("fp-refresh")
	a := h.agent(t)
	h.connectNode(t, a, "fp-refresh")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	g, err := a.requestModelGrant(ctx, "refresh-run", "first", true, "", "summarize", true)
	if err != nil {
		t.Fatal(err)
	}
	bk := h.hubSrv.bindings()
	expire := func() {
		bk.mu.Lock()
		bk.runs[bindingKey(nodeProtocolFixtureFP("fp-refresh"), "refresh-run")].Exp = time.Now().Add(-time.Second)
		bk.mu.Unlock()
	}
	expire()
	refreshes := 0
	refresh := func(ctx context.Context) (string, error) {
		refreshes++
		next, err := a.renewModelGrant(ctx, "refresh-run", fmt.Sprintf("refresh-%d", refreshes), true, g.bindingID)
		if err != nil {
			return "", err
		}
		if err := validateSmartGrant(next, &g); err != nil {
			return "", err
		}
		return next.code, nil
	}
	p, err := a.newNodeProvider(ctx, "refresh-run", g.boundModel, g.boundProtocol, g.code, "refresh-run", g.bindingID, g.boundMaxOutput, refresh, nil)
	if err != nil {
		t.Fatal(err)
	}
	if refreshes != 1 {
		t.Fatalf("directory refreshes=%d", refreshes)
	}
	for i := 0; i < 2; i++ {
		expire()
		if _, err := p.Complete(ctx, agent.Request{Model: g.boundModel}, nil); err != nil {
			t.Fatal(err)
		}
	}
	if refreshes != 3 {
		t.Fatalf("directory + two independent Complete must each refresh once, got %d", refreshes)
	}
	if h.ups["up-"+providers.OpenAICompletions].calls() != 2 {
		t.Fatal("authorization failures reached model or retry duplicated output")
	}
	dead, cancelDead := context.WithCancel(ctx)
	cancelDead()
	if _, err := a.renewModelGrant(dead, "refresh-run", "cancelled", true, g.bindingID); err == nil {
		t.Fatal("canceled renewal accepted")
	}
}
