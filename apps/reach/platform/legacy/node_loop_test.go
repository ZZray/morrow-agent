package main

// 宿主契约的离线 fixtures：本机工具、宿主状态、ask_user、旁路命令、delegate、
// 访问码续签与「不重放」边界。共享引擎自身的循环语义由 internal/agent 的测试覆盖。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"ara/internal/agent"
	"ara/internal/nativeapp"
	"ara/internal/providers"

	"nhooyr.io/websocket"
)

// scriptedProvider 是测试用的模型实现：不联网、不解析协议，只按脚本返回一个
// 终态响应，并记录它看到的请求。
type scriptedProvider struct {
	mu        sync.Mutex
	responses []agent.Response
	calls     int
	requests  []agent.Request
}

func (p *scriptedProvider) Complete(ctx context.Context, request agent.Request, emit func(agent.Event)) (agent.Response, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls++
	p.requests = append(p.requests, request)
	if len(p.responses) == 0 {
		return agent.Response{
			Message:    agent.Message{Role: "assistant", Content: []agent.Content{{Type: "text", Text: "child"}}},
			StopReason: "stop",
		}, nil
	}
	resp := p.responses[0]
	p.responses = p.responses[1:]
	return resp, nil
}

func (p *scriptedProvider) lastRequest() (agent.Request, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.requests) == 0 {
		return agent.Request{}, false
	}
	return p.requests[len(p.requests)-1], true
}

func newTestNodeAgent(t *testing.T) *nodeAgent {
	t.Helper()
	t.Setenv("HW_CONF", t.TempDir())
	return &nodeAgent{
		conf:         map[string]string{"hub": "http://127.0.0.1:1"},
		id:           &identity{FP: "fp-test"},
		runs:         map[string]context.CancelFunc{},
		tasks:        map[string]context.CancelFunc{},
		quit:         make(chan struct{}),
		grantWaiters: map[string]chan modelGrantReply{},
	}
}

func runAgentTool(t *testing.T, tools []agent.Tool, name string, args map[string]any) (string, error) {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range tools {
		if tool.Spec().Name != name {
			continue
		}
		result, err := tool.Execute(context.Background(), raw)
		if err != nil {
			return "", err
		}
		return resultText(&result), nil
	}
	t.Fatalf("tool %s missing", name)
	return "", nil
}

func TestHostLocalToolsWriteListSearchPatch(t *testing.T) {
	a := newTestNodeAgent(t)
	dir := t.TempDir()

	path := filepath.Join(dir, "sub", "note.txt")
	out, err := runAgentTool(t, a.localTools(), "write_file", map[string]any{"path": path, "content": "hi"})
	if err != nil || out == "" {
		t.Fatalf("write_file out=%q err=%v", out, err)
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != "hi" {
		t.Fatalf("file=%q err=%v", raw, err)
	}

	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	out, err = runAgentTool(t, a.localTools(), "list_dir", map[string]any{"path": dir})
	if err != nil || !strings.Contains(out, "a.txt") || !strings.Contains(out, "nested/") {
		t.Fatalf("list_dir out=%q err=%v", out, err)
	}

	if err := os.WriteFile(filepath.Join(dir, "b.go"), []byte("package main\nfunc target() {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "node_modules", "skip.js"), []byte("target\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err = runAgentTool(t, a.localTools(), "search_text", map[string]any{"path": dir, "pattern": `func\s+target`})
	if err != nil || !strings.Contains(out, "b.go:2:") || strings.Contains(out, "skip.js") {
		t.Fatalf("search_text out=%q err=%v", out, err)
	}
	if _, err := runAgentTool(t, a.localTools(), "search_text", map[string]any{"path": dir, "pattern": "("}); err == nil {
		t.Fatal("bad regex accepted")
	}

	p := filepath.Join(dir, "f.txt")
	if err := os.WriteFile(p, []byte("one two one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := runAgentTool(t, a.localTools(), "patch_file", map[string]any{"path": p, "old": "one", "new": "1"}); err == nil {
		t.Fatal("multiple occurrences without all accepted")
	}
	if _, err := runAgentTool(t, a.localTools(), "patch_file", map[string]any{"path": p, "old": "two", "new": "2"}); err != nil {
		t.Fatal(err)
	}
	if _, err := runAgentTool(t, a.localTools(), "patch_file", map[string]any{"path": p, "old": "one", "new": "1", "all": true}); err != nil {
		t.Fatal(err)
	}
	raw, err = os.ReadFile(p)
	if err != nil || string(raw) != "1 2 1\n" {
		t.Fatalf("content=%q err=%v", raw, err)
	}
	if _, err := runAgentTool(t, a.localTools(), "patch_file", map[string]any{"path": p, "old": "zzz", "new": "z"}); err == nil {
		t.Fatal("missing old text accepted")
	}
}

func TestGrantWaitersAreIsolatedByRunID(t *testing.T) {
	a := &nodeAgent{grantWaiters: map[string]chan modelGrantReply{}}
	ch1 := make(chan modelGrantReply, 1)
	ch2 := make(chan modelGrantReply, 1)
	a.grantMu.Lock()
	a.grantWaiters["run-a"] = ch1
	a.grantWaiters["run-b"] = ch2
	a.grantMu.Unlock()
	a.deliverModelGrant(ev{ID: "run-b", Msg: []byte("token-b")})
	select {
	case got := <-ch2:
		if got.code != "token-b" {
			t.Fatalf("code=%q", got.code)
		}
	default:
		t.Fatal("run-b grant not delivered")
	}
	select {
	case <-ch1:
		t.Fatal("run-a should stay empty")
	default:
	}
}

func writeNodeSSEText(w http.ResponseWriter, text string) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":%q}}]}\n\n", text)
	fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
	fmt.Fprint(w, "data: [DONE]\n\n")
}

// newTestHostProvider 用给定上游构造宿主 provider。目录解析与七协议覆盖由
// node_protocol_test.go 的真实网关链路负责，这里只验证 provider 自身的续签/不重放边界。
func newTestHostProvider(t *testing.T, upstreamURL, token string, refresh func(context.Context) (string, error), emit func(agentEvent)) *hostProvider {
	t.Helper()
	grant := newNodeGrant(token)
	p, err := newHostProvider(providers.Config{
		Name:       hostProviderID,
		API:        providers.OpenAICompletions,
		BaseURL:    upstreamURL + "/v1",
		Model:      "test-model",
		APIKey:     token,
		HTTPClient: nodeGatewayClient(upstreamURL, grant),
	}, grant, 0, refresh, emit)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestHostProviderRefreshesGrantOnceOnUnauthorized(t *testing.T) {
	checkGrantRefreshOnce(t, http.StatusUnauthorized)
}

func TestHostProviderRefreshesGrantOnceOnForbidden(t *testing.T) {
	checkGrantRefreshOnce(t, http.StatusForbidden)
}

func checkGrantRefreshOnce(t *testing.T, status int) {
	var mu sync.Mutex
	var auths []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		auths = append(auths, r.Header.Get("Authorization"))
		n := len(auths)
		mu.Unlock()
		if n == 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_, _ = io.WriteString(w, `{"error":{"message":"grant expired"}}`)
			return
		}
		writeNodeSSEText(w, "hello")
	}))
	defer upstream.Close()

	var refreshes int
	var events []agentEvent
	p := newTestHostProvider(t, upstream.URL, "grant-1", func(context.Context) (string, error) {
		refreshes++
		return "grant-2", nil
	}, func(e agentEvent) { events = append(events, e) })
	resp, err := p.Complete(context.Background(), agent.Request{Model: "test-model"}, func(agent.Event) {})
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if resp.Message.Text() != "hello" {
		t.Fatalf("text=%q", resp.Message.Text())
	}
	if refreshes != 1 {
		t.Fatalf("grant refresh must happen exactly once, got %d", refreshes)
	}
	if len(auths) != 2 || auths[0] != "Bearer grant-1" || auths[1] != "Bearer grant-2" {
		t.Fatalf("auth headers=%q", auths)
	}
	found := false
	for _, e := range events {
		if e.Type == "retry" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a retry event for the grant refresh, got %+v", events)
	}
}

func TestHostProviderSurfacesSupplierErrorWithoutHostRetry(t *testing.T) {
	var calls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, `{"error":{"message":"upstream down"}}`)
	}))
	defer upstream.Close()

	var refreshes int
	p := newTestHostProvider(t, upstream.URL, "grant-1", func(context.Context) (string, error) {
		refreshes++
		return "grant-2", nil
	}, nil)
	_, err := p.Complete(context.Background(), agent.Request{Model: "test-model"}, nil)
	if err == nil {
		t.Fatal("supplier failure must surface as an error")
	}
	if calls != 1 {
		t.Fatalf("host must not retry supplier errors: calls=%d", calls)
	}
	if refreshes != 0 {
		t.Fatalf("a 5xx must not trigger a grant refresh: %d", refreshes)
	}
	var he *providers.HTTPError
	if !errors.As(err, &he) || he.Status != http.StatusInternalServerError {
		t.Fatalf("err=%v", err)
	}
}

func TestHostProviderDoesNotReplayAfterStreamedOutput(t *testing.T) {
	var calls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n")
		fmt.Fprint(w, "data: {\"error\":{\"message\":\"stream broke\"}}\n\n")
	}))
	defer upstream.Close()

	p := newTestHostProvider(t, upstream.URL, "grant-1", func(context.Context) (string, error) {
		t.Error("refresh must not run for a stream failure")
		return "", nil
	}, nil)
	var streamed bool
	_, err := p.Complete(context.Background(), agent.Request{Model: "test-model"}, func(e agent.Event) {
		if e.Type == "text_delta" {
			streamed = true
		}
	})
	if err == nil {
		t.Fatal("a stream failure must not become success")
	}
	if !streamed {
		t.Fatal("expected the partial delta to reach the caller")
	}
	if calls != 1 {
		t.Fatalf("output must never be replayed: calls=%d", calls)
	}
}

func TestHostStateRoundTripKeepsPendingQueueAndBoard(t *testing.T) {
	a := newTestNodeAgent(t)
	sess := a.hostSession()
	if err := sess.steer("steer-a"); err != nil {
		t.Fatal(err)
	}
	if err := sess.followUp("follow-b"); err != nil {
		t.Fatal(err)
	}
	sess.upsertTask(hostTask{ID: "t1", Title: "board item", Status: "running", Kind: "todo"}, nil)
	// 绑定必须指向一个真实存在的 journal：恢复时要按 journal 确认待投递队列，
	// 读不到 journal 的绑定会（并且必须）阻断装载。
	store, err := agent.OpenSessionStore(a.nativeSessionDir())
	if err != nil {
		t.Fatal(err)
	}
	created, err := store.Create(agent.SessionOptions{
		ProviderID: hostProviderID, Model: "test-model", System: hostSystemPrompt(), Cwd: currentCwd(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := sess.setNativeID(created.ID); err != nil {
		t.Fatal(err)
	}
	if err := sess.save(); err != nil {
		t.Fatal(err)
	}

	reloaded := newHostSession(a.hostStatePath(), func() (*agent.SessionStore, error) {
		return agent.OpenSessionStore(a.nativeSessionDir())
	})
	if err := reloaded.blockedErr(); err != nil {
		t.Fatalf("a consistent state must reload without blocking: %v", err)
	}
	if reloaded.state.NativeSessionID != created.ID {
		t.Fatalf("native session=%q", reloaded.state.NativeSessionID)
	}
	if reloaded.pendingQueued() != 2 || reloaded.control.QueuedMessageCount() != 2 {
		t.Fatalf("pending=%d control=%d", reloaded.pendingQueued(), reloaded.control.QueuedMessageCount())
	}
	tasks := reloaded.tasks()
	if len(tasks) != 1 || tasks[0].Title != "board item" {
		t.Fatalf("tasks=%+v", tasks)
	}
	if reloaded.busyNow() {
		t.Fatal("a reloaded session must not be running")
	}
}

func nextUIRequest(t *testing.T, events chan agentEvent) agentEvent {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case e := <-events:
			if e.Type == "ui_request" {
				return e
			}
		case <-deadline:
			t.Fatal("no ui_request event")
		}
	}
}

func TestHostAskUserResolvesAndRejects(t *testing.T) {
	a := newTestNodeAgent(t)
	sess := a.hostSession()
	events := make(chan agentEvent, 8)
	emit := func(e agentEvent) { events <- e }

	type answer struct {
		text string
		ok   bool
		err  error
	}
	got := make(chan answer, 1)
	go func() {
		text, ok, err := sess.ask(context.Background(), "q1", "apply this?", emit)
		got <- answer{text, ok, err}
	}()
	if e := nextUIRequest(t, events); e.StepID != "q1" || e.Output != "apply this?" {
		t.Fatalf("ui_request=%+v", e)
	}
	if !sess.resolveUI("q1", "ship it", true) {
		t.Fatal("resolve failed")
	}
	select {
	case ans := <-got:
		if ans.err != nil || !ans.ok || ans.text != "ship it" {
			t.Fatalf("answer=%+v", ans)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ask did not return")
	}

	// 审批拒绝：工具必须回一条明确的拒绝文本，而不是成功。
	tool := sess.askTool(emit)
	results := make(chan string, 1)
	go func() {
		res, err := tool.Execute(context.Background(), json.RawMessage(`{"prompt":"dangerous?"}`))
		if err != nil {
			results <- "error: " + err.Error()
			return
		}
		results <- resultText(&res)
	}()
	deny := nextUIRequest(t, events)
	if !sess.resolveUI(deny.StepID, "no", false) {
		t.Fatal("resolve deny failed")
	}
	select {
	case text := <-results:
		if !strings.HasPrefix(text, "User rejected:") {
			t.Fatalf("denied approval must not become success: %q", text)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ask tool did not return")
	}
}

func blockingCommand() string {
	if runtime.GOOS == "windows" {
		return "ping -n 30 127.0.0.1 >NUL"
	}
	return "sleep 30"
}

func TestHostSideBashAbortAndMutex(t *testing.T) {
	a := newTestNodeAgent(t)
	sess := a.hostSession()
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := a.runSideCommand(context.Background(), sess, "b1", blockingCommand(), "", func(e agentEvent) {
			if e.Type == "bash_start" {
				select {
				case <-started:
				default:
					close(started)
				}
			}
		})
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("side bash did not start")
	}
	if _, err := a.runSideCommand(context.Background(), sess, "b2", "echo hi", "", nil); err == nil {
		t.Fatal("a second concurrent side command must be rejected")
	}
	if !sess.abortBash() {
		t.Fatal("abort found nothing to cancel")
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("aborted side command must not report success")
		}
	case <-time.After(15 * time.Second):
		t.Fatal("side bash did not stop")
	}
}

func TestRunLocalAgentQueuesWhenBusy(t *testing.T) {
	a := newTestNodeAgent(t)
	sess := a.hostSession()
	if _, _, ok := sess.reserveTurn("run-turn"); !ok {
		t.Fatal("reserveTurn failed on an idle session")
	}
	a.runLocalAgent(nil, &dcf{K: "agent-loop", ID: "run-1", Msg: "second goal", Model: "default"})
	if sess.pendingQueued() != 1 || sess.control.QueuedMessageCount() != 1 {
		t.Fatalf("busy goal must be queued once: pending=%d control=%d", sess.pendingQueued(), sess.control.QueuedMessageCount())
	}
	if !sess.busyNow() {
		t.Fatal("queuing must not disturb the running turn")
	}
	if len(sess.tasks()) != 0 {
		t.Fatalf("queuing must not open a new turn: %+v", sess.tasks())
	}
}

func TestHostSteerAndFollowReachTheEngine(t *testing.T) {
	a := newTestNodeAgent(t)
	sess := a.hostSession()

	// 打断方式直接复用共享 Control 的取值域；非法值必须被拒绝。
	if err := sess.setInterruptMode("immediate"); err != nil {
		t.Fatalf("immediate: %v", err)
	}
	if err := sess.setInterruptMode("bogus"); err == nil {
		t.Fatal("an invalid interrupt mode must be rejected")
	}
	if err := sess.setInterruptMode("wait"); err != nil {
		t.Fatalf("wait: %v", err)
	}

	// 回合中插入 steer：引擎在安全边界投递它，下一次请求必须带上。
	provider := &scriptedProvider{responses: []agent.Response{
		{
			Message: agent.Message{Role: "assistant", ToolCalls: []agent.ToolCall{
				{ID: "c1", Name: "mark", Arguments: json.RawMessage(`{}`)},
			}},
			StopReason: "tool_use",
		},
		{
			Message:    agent.Message{Role: "assistant", Content: []agent.Content{{Type: "text", Text: "done"}}},
			StopReason: "stop",
		},
	}}
	mark := hostTool{
		spec: toolSpec("mark", "mark", map[string]any{}, nil, false),
		run: func(ctx context.Context, args map[string]any) (string, error) {
			if err := sess.steer("use the new plan"); err != nil {
				return "", err
			}
			return "ok", nil
		},
	}
	if err := sess.followUp("second job"); err != nil {
		t.Fatal(err)
	}
	// 与 runLocalAgent 相同的排队镜像口径：引擎投递一条排队消息后从镜像里去掉队首。
	emit := func(ev agent.Event) {
		if ev.Type == "message" && ev.Message != nil && ev.Message.Role == "user" {
			if ev.Delivery == nil {
				return
			}
			sess.ackDelivery(ev.Delivery)
		}
	}
	_, err := nativeapp.Run(context.Background(), nativeapp.Options{
		SessionDir: a.nativeSessionDir(),
		Cwd:        currentCwd(),
		Prompt:     "first job",
		MaxTurns:   4,
		Control:    sess.control,
		Host: &nativeapp.Host{
			Provider:   provider,
			ProviderID: hostProviderID,
			Model:      "test-model",
			System:     hostSystemPrompt(),
			Tools: func(agent.Session) ([]agent.Tool, func() error, error) {
				return []agent.Tool{mark}, nil, nil
			},
		},
	}, emit)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if provider.calls != 3 {
		t.Fatalf("prompt + queued steer + queued follow-up must each start a turn: calls=%d", provider.calls)
	}
	request, ok := provider.lastRequest()
	if !ok {
		t.Fatal("provider was never called")
	}
	last := request.Messages[len(request.Messages)-1].Text()
	if last != "second job" {
		t.Fatalf("the queued follow-up must be the last prompt: %q", last)
	}
	steered := false
	for _, m := range request.Messages {
		if m.Role == "user" && strings.Contains(m.Text(), "use the new plan") {
			steered = true
		}
	}
	if !steered {
		t.Fatal("the queued steer never reached the model")
	}
	if sess.pendingQueued() != 0 {
		t.Fatalf("delivered queued messages must leave the mirror: %d", sess.pendingQueued())
	}
}

func TestDelegateLimit(t *testing.T) {
	a := newTestNodeAgent(t)
	sess := a.hostSession()
	provider := &scriptedProvider{}
	var childEvents []agentEvent
	var childTasks []string
	tool := a.delegateTool(sess, "test-model", provider, func(taskID string, e agentEvent) {
		childTasks = append(childTasks, taskID)
		childEvents = append(childEvents, e)
	})
	for i := 0; i < hostDelegateLimit; i++ {
		if _, err := tool.Execute(context.Background(), json.RawMessage(`{"objective":"look"}`)); err != nil {
			t.Fatalf("delegate %d: %v", i, err)
		}
	}
	if _, err := tool.Execute(context.Background(), json.RawMessage(`{"objective":"again"}`)); err == nil {
		t.Fatal("expected delegate limit")
	}
	if provider.calls != hostDelegateLimit {
		t.Fatalf("each delegate must run its own session: calls=%d", provider.calls)
	}
	// 子任务进度可观察，且归属子任务 id（不是父回合的 runID）。
	if len(childTasks) == 0 {
		t.Fatal("subagent progress must stay observable")
	}
	for _, taskID := range childTasks {
		if !strings.HasPrefix(taskID, "sub-") {
			t.Fatalf("subagent events must be attributed to the sub task: %q", taskID)
		}
	}
	sawBoard := false
	for _, e := range childEvents {
		if e.Type == "task_update" && e.StepID != "" && strings.HasPrefix(e.StepID, "sub-") {
			sawBoard = true
		}
	}
	if !sawBoard {
		t.Fatalf("subagent board progress missing: %+v", childEvents)
	}
}

// delegateTool 的子会话事件隔离：text_delta 绝不进入父回合的流式气泡，
// 而子会话的工具事件仍按子任务 id 可观察。
func TestDelegateChildEventsAreIsolated(t *testing.T) {
	a := newTestNodeAgent(t)
	sess := a.hostSession()
	provider := &childTextProvider{}
	var parent []agentEvent
	var child []agentEvent
	tool := a.delegateTool(sess, "test-model", provider, func(taskID string, e agentEvent) {
		child = append(child, e)
	})
	parent = append(parent, agentEvent{Type: "parent-sentinel"})
	if _, err := tool.Execute(context.Background(), json.RawMessage(`{"objective":"look"}`)); err != nil {
		t.Fatal(err)
	}
	for _, e := range child {
		if e.Type == "text_delta" || e.Type == "text" || e.Type == "agent_end" {
			t.Fatalf("subagent run-level event leaked into the host stream: %+v", e)
		}
	}
	sawTool := false
	for _, e := range child {
		if e.Type == "tool_start" || e.Type == "tool_end" {
			sawTool = true
		}
	}
	if !sawTool {
		t.Fatalf("subagent tool events must stay observable: %+v", child)
	}
	if len(parent) != 1 || parent[0].Type != "parent-sentinel" {
		t.Fatalf("parent stream was polluted: %+v", parent)
	}
}

// childTextProvider 让子会话先流一段增量、再调一个工具、最后给出终态。
type childTextProvider struct {
	mu    sync.Mutex
	calls int
}

func (p *childTextProvider) Complete(ctx context.Context, request agent.Request, emit func(agent.Event)) (agent.Response, error) {
	p.mu.Lock()
	p.calls++
	n := p.calls
	p.mu.Unlock()
	emit(agent.Event{Type: "text_delta", Text: "child-partial"})
	if n == 1 {
		return agent.Response{
			Message: agent.Message{Role: "assistant", ToolCalls: []agent.ToolCall{
				{ID: "c1", Name: "list_dir", Arguments: json.RawMessage(`{"path":"."}`)},
			}},
			StopReason: "tool_use",
		}, nil
	}
	return agent.Response{
		Message:    agent.Message{Role: "assistant", Content: []agent.Content{{Type: "text", Text: "child done"}}},
		StopReason: "stop",
	}, nil
}

// gatedNodeHarness 起一个假 hub：model-grant 的回复一直阻塞到 release 关闭，
// 用来证明占位发生在任何网络等待之前，以及授权等待期 abort 有效。
type gatedNodeHarness struct {
	a       *nodeAgent
	cn      *conn
	frames  chan dcf
	grants  chan string
	release chan struct{}
}

// newGatedNodeHarness 起一个假 hub：model-grant 的回复一直阻塞到 release 关闭，
// 用来证明占位发生在任何网络等待之前，以及授权等待期 abort 有效。conf["hub"] 同时
// 当上游用，所以授权放行后的回合必然失败。
func newGatedNodeHarness(t *testing.T) *gatedNodeHarness {
	t.Helper()
	return newGatedNodeHarnessWithUpstream(t, nil)
}

// newGatedNodeHarnessWithUpstream 与 newGatedNodeHarness 相同，但额外挂一个假模型
// 上游：授权放行后的回合能真正成功，用来证明「无关/未知 ID 的 abort 不影响这一回合」。
func newGatedNodeHarnessWithUpstream(t *testing.T, upstream http.HandlerFunc) *gatedNodeHarness {
	t.Helper()
	t.Setenv("HW_CONF", t.TempDir())
	modelHandler := upstream
	if modelHandler == nil {
		// 没有假上游时：目录可用，模型端点必然失败——正好用来验证失败路径会释放占位。
		modelHandler = func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "no model upstream", http.StatusBadGateway)
		}
	}
	up := httptest.NewServer(nodeGatewayFixture(t, modelHandler))
	t.Cleanup(up.Close)
	upstreamURL := up.URL
	h := &gatedNodeHarness{frames: make(chan dcf, 64), grants: make(chan string, 8), release: make(chan struct{})}
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ctx := r.Context()
		go func() {
			for {
				_, raw, err := c.Read(ctx)
				if err != nil {
					return
				}
				var s sig
				if json.Unmarshal(raw, &s) != nil {
					continue
				}
				switch s.K {
				case "model-grant":
					select {
					case h.grants <- s.ID:
					default:
					}
					go func(id string) {
						<-h.release
						_ = c.Write(ctx, websocket.MessageText, []byte(mustJSON(&sig{K: "model-grant", ID: id, D: "grantcode",
							DefaultModel: nodeTestDefaultModel, DefaultProtocol: providers.OpenAICompletions})))
					}(s.ID)
				case "dc":
					var f dcf
					if json.Unmarshal(unb64(s.D), &f) == nil {
						select {
						case h.frames <- f:
						default:
						}
					}
				}
			}
		}()
		<-ctx.Done()
	}))
	t.Cleanup(hub.Close)

	cn := newConn("ws"+strings.TrimPrefix(hub.URL, "http")+"/ws", "tok", true)
	cn.rel = true
	if err := cn.dial(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cn.close)
	h.cn = cn
	conf := map[string]string{"hub": upstreamURL}
	h.a = &nodeAgent{
		// 默认（没有假上游时）hub 地址同时是「上游」：POST /v1/chat/completions 会打到
		// 非 WS 端点，于是授权放行后的回合必然失败——正好用来验证失败路径会释放占位。
		conf:         conf,
		id:           &identity{FP: "fp-gate"},
		runs:         map[string]context.CancelFunc{},
		tasks:        map[string]context.CancelFunc{},
		quit:         make(chan struct{}),
		grantWaiters: map[string]chan modelGrantReply{},
	}
	h.a.cmu.Lock()
	h.a.cn = cn
	h.a.cmu.Unlock()
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	go func() {
		for {
			select {
			case e := <-cn.ev:
				if e.Ctrl == "model-grant" {
					h.a.deliverModelGrant(e)
				}
			case <-stop:
				return
			}
		}
	}()
	return h
}

func (h *gatedNodeHarness) waitOut(t *testing.T, id string) dcf {
	t.Helper()
	deadline := time.After(20 * time.Second)
	for {
		select {
		case f := <-h.frames:
			if f.K == "out" && f.Done && f.ID == id {
				return f
			}
		case <-deadline:
			t.Fatalf("no out frame for %s", id)
		}
	}
}

func (h *gatedNodeHarness) waitReleased(t *testing.T, sess *hostSession) {
	t.Helper()
	deadline := time.After(15 * time.Second)
	for sess.busyNow() {
		select {
		case <-deadline:
			t.Fatal("the turn reservation was never released")
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}
}

func TestRunLocalAgentReservesTurnBeforeGrantWait(t *testing.T) {
	h := newGatedNodeHarness(t)
	sess := h.a.hostSession()
	go h.a.runLocalAgent(h.cn, &dcf{K: "agent-loop", ID: "run-a", Msg: "first", Model: "default"})
	select {
	case g := <-h.grants:
		if g != "run-a" {
			t.Fatalf("grant run=%q", g)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("run-a never asked for a grant")
	}
	// 占位在授权等待期间已经生效：并发帧必须走排队语义。
	if !sess.busyNow() {
		t.Fatal("the turn must be reserved before the grant wait")
	}
	go h.a.runLocalAgent(h.cn, &dcf{K: "agent-loop", ID: "run-b", Msg: "second", Model: "default"})
	queued := h.waitOut(t, "run-b")
	if queued.Code == 0 || queued.Err != "session busy; follow-up queued" {
		t.Fatalf("the concurrent turn must be queued, not run: %+v", queued)
	}
	select {
	case g := <-h.grants:
		t.Fatalf("a second engine asked for a grant: %s", g)
	case <-time.After(300 * time.Millisecond):
	}
	if sess.pendingQueued() != 1 {
		t.Fatalf("queued goal lost: %d", sess.pendingQueued())
	}
	close(h.release)
	failed := h.waitOut(t, "run-a")
	if failed.Code == 0 || failed.Err == "" {
		t.Fatalf("run-a must not report success: %+v", failed)
	}
	h.waitReleased(t, sess)
	if sess.pendingQueued() != 1 {
		t.Fatalf("the queued goal must survive a failed turn: %d", sess.pendingQueued())
	}
}

func TestRunLocalAgentAbortDuringGrantWait(t *testing.T) {
	h := newGatedNodeHarness(t)
	sess := h.a.hostSession()
	go h.a.runLocalAgent(h.cn, &dcf{K: "agent-loop", ID: "run-abort", Msg: "slow", Model: "default"})
	select {
	case <-h.grants:
	case <-time.After(10 * time.Second):
		t.Fatal("no grant request")
	}
	h.a.onFrame(h.cn, &dcf{K: "agent-abort", ID: "run-abort"})
	done := h.waitOut(t, "run-abort")
	if done.Code == 0 || done.Err == "" {
		t.Fatalf("an aborted grant wait must not report success: %+v", done)
	}
	close(h.release)
	h.waitReleased(t, sess)
}
