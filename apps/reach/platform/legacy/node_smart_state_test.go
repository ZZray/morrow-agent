package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"
	"time"

	"ara/internal/agent"
	"ara/internal/providers"
)

func validNodeSmartReply() modelGrantReply {
	return modelGrantReply{code: "code", bindingID: "binding", boundModel: "test-model",
		boundProtocol: providers.OpenAICompletions, boundDecision: "decision",
		boundDecisionExp: time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano),
		boundMaxOutput:   4096, boundTools: true}
}

func TestNodeSmartGrantRejectsIncompleteOrChangedAuthorization(t *testing.T) {
	original := validNodeSmartReply()
	if err := validateSmartGrant(original, nil); err != nil {
		t.Fatal(err)
	}
	cases := map[string]func(*modelGrantReply){
		"code":     func(g *modelGrantReply) { g.code = "" },
		"binding":  func(g *modelGrantReply) { g.bindingID = "" },
		"model":    func(g *modelGrantReply) { g.boundModel = "" },
		"protocol": func(g *modelGrantReply) { g.boundProtocol = "" },
		"decision": func(g *modelGrantReply) { g.boundDecision = "" },
		"expiry":   func(g *modelGrantReply) { g.boundDecisionExp = "invalid" },
		"expired":  func(g *modelGrantReply) { g.boundDecisionExp = time.Now().Add(-time.Hour).Format(time.RFC3339Nano) },
		"cap":      func(g *modelGrantReply) { g.boundMaxOutput = 0 },
		"tools":    func(g *modelGrantReply) { g.boundTools = false },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			g := original
			mutate(&g)
			if err := validateSmartGrant(g, nil); err == nil {
				t.Fatal("incomplete authorization accepted")
			}
		})
	}
	changes := map[string]func(*modelGrantReply){
		"binding":  func(g *modelGrantReply) { g.bindingID += "-new" },
		"model":    func(g *modelGrantReply) { g.boundModel += "-new" },
		"protocol": func(g *modelGrantReply) { g.boundProtocol = providers.AnthropicMessages },
		"decision": func(g *modelGrantReply) { g.boundDecision += "-new" },
		"expiry":   func(g *modelGrantReply) { g.boundDecisionExp = time.Now().Add(2 * time.Hour).Format(time.RFC3339Nano) },
		"cap":      func(g *modelGrantReply) { g.boundMaxOutput-- },
	}
	for name, mutate := range changes {
		t.Run("renew-"+name, func(t *testing.T) {
			g := original
			mutate(&g)
			if err := validateSmartGrant(g, &original); err == nil {
				t.Fatal("renewal changed trusted tuple")
			}
		})
	}
	next := original
	next.code = "new-code"
	if err := validateSmartGrant(next, &original); err != nil {
		t.Fatal(err)
	}
}

func TestNodeSmartSessionBindingAtomicAndImmutable(t *testing.T) {
	a := newTestNodeAgent(t)
	s := a.hostSession()
	if err := s.save(); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(s.path)
	if err != nil {
		t.Fatal(err)
	}
	s.beforeWrite = func(raw []byte) error {
		var state hostState
		if err := json.Unmarshal(raw, &state); err != nil {
			t.Fatal(err)
		}
		if state.Model != "m" || state.Protocol != "openai-completions" || state.Binding != "b" || state.Decision != "d" {
			t.Fatalf("partial binding reached persistence: %+v", state)
		}
		return errors.New("fixture disk failure")
	}
	if _, err := s.smartSessionBinding("m", "openai-completions", "b", "d"); err == nil {
		t.Fatal("write failure hidden")
	}
	after, _ := os.ReadFile(s.path)
	if string(before) != string(after) || s.bindingID() != "" {
		t.Fatal("failed write changed state")
	}
	if _, ok := s.currentIdentity(); ok {
		t.Fatal("partial identity retained")
	}
	s.beforeWrite = nil
	if _, err := s.smartSessionBinding("m", "openai-completions", "b", "d"); err != nil {
		t.Fatal(err)
	}
	before, _ = os.ReadFile(s.path)
	for _, fields := range [][4]string{{"other", "openai-completions", "b", "d"}, {"m", "other", "b", "d"}, {"m", "openai-completions", "other", "d"}, {"m", "openai-completions", "b", "other"}} {
		if _, err := s.smartSessionBinding(fields[0], fields[1], fields[2], fields[3]); err == nil {
			t.Fatal("smart rebind accepted")
		}
	}
	after, _ = os.ReadFile(s.path)
	if string(before) != string(after) {
		t.Fatal("rejected rebind changed disk")
	}
}

func TestNodeSmartSessionRejectsLegacyAndPartialIdentity(t *testing.T) {
	for _, state := range []hostState{
		{Model: "m", Protocol: providers.OpenAICompletions}, {NativeSessionID: "legacy"},
		{Binding: "b"}, {Decision: "d"}, {Legacy: &legacyRecord{Pending: true}},
	} {
		a := newTestNodeAgent(t)
		s := a.hostSession()
		s.state = state
		if _, err := s.smartSessionBinding("m", providers.OpenAICompletions, "b", "d"); err == nil {
			t.Fatalf("adopted partial/legacy state: %+v", state)
		}
		if !reflect.DeepEqual(s.state, state) {
			t.Fatal("rejected adoption changed state")
		}
	}
}

func TestNodeSmartProviderCapsEveryCompleteWithoutRemovingTools(t *testing.T) {
	var limits []int
	var toolCounts []int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			MaxTokens int               `json:"max_completion_tokens"`
			Tools     []json.RawMessage `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		limits = append(limits, body.MaxTokens)
		toolCounts = append(toolCounts, len(body.Tools))
		writeNodeSSEText(w, "ok")
	}))
	defer server.Close()
	p := newTestHostProvider(t, server.URL, "grant", nil, nil)
	p.maxOutputTokens = 4096
	// Every call to the same host provider is constrained, including a normal
	// tool-bearing request, a subsequent tool turn, and a tool-free summary.
	for _, req := range []agent.Request{
		{Model: "test-model", Tools: []agent.ToolSpec{{Name: "read_file", Parameters: json.RawMessage(`{"type":"object"}`)}}},
		{Model: "test-model", MaxTokens: 9000}, {Model: "test-model", MaxTokens: 4000},
	} {
		if _, err := p.Complete(context.Background(), req, nil); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(limits, []int{4096, 4096, 4000}) || !reflect.DeepEqual(toolCounts, []int{1, 0, 0}) {
		t.Fatalf("limits=%v tools=%v", limits, toolCounts)
	}
}
