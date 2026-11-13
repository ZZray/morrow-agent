package main

// 本机 node 执行端到端：测试扮演 hub（信令+中继）与控制器，node 走 relay 模式，
// 覆盖 model-grant 申请/使用 → 共享原生引擎回合（SSE 流式）→ 宿主工具落盘 →
// 事件与 out 回传 → 同一 session 续接。上游是本地 SSE fixture，不调用真实模型。

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"ara/internal/providers"

	"nhooyr.io/websocket"
)

func stubHubWS(t *testing.T, frames chan dcf, grants chan string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
					case grants <- s.ID:
					default:
					}
					// 默认模型/协议与真实 Hub 一样随 grant 下发（非敏感元数据，无 key）。
					_ = c.Write(ctx, websocket.MessageText, []byte(mustJSON(&sig{K: "model-grant", ID: s.ID, D: "grantcode",
						DefaultModel: nodeTestDefaultModel, DefaultProtocol: providers.OpenAICompletions})))
				case "dc":
					var f dcf
					if json.Unmarshal(unb64(s.D), &f) == nil {
						select {
						case frames <- f:
						default:
						}
					}
				}
			}
		}()
		<-ctx.Done()
	}))
}

func flattenChatContent(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case []any:
		var b strings.Builder
		for _, part := range t {
			if m, ok := part.(map[string]any); ok {
				if s, ok := m["text"].(string); ok {
					b.WriteString(s)
				}
			}
		}
		return b.String()
	}
	return ""
}

func writeNodeSSEToolCall(w http.ResponseWriter, id, name, args string) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":%q,\"type\":\"function\",\"function\":{\"name\":%q,\"arguments\":%q}}]}}]}\n\n", id, name, args)
	fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n")
	fmt.Fprint(w, "data: [DONE]\n\n")
}

type chatRound struct {
	auth   string
	system string
	user   string
}

// e2eHarness 起一个假 hub + 假上游，并把 nodeAgent 接上中继通道。
type e2eHarness struct {
	a          *nodeAgent
	cn         *conn
	frames     chan dcf
	grants     chan string
	rounds     []chatRound
	eventTypes []string
	mu         sync.Mutex
	upstream   *httptest.Server
	hub        *httptest.Server
}

// runTurn 发一帧 agent-loop 并等到 out done，返回该 out 帧与本次收到的事件类型。
func (h *e2eHarness) runTurn(t *testing.T, runID, msg, brief, model string) (dcf, []string) {
	t.Helper()
	h.mu.Lock()
	h.eventTypes = nil
	h.mu.Unlock()
	go h.a.runLocalAgent(h.cn, &dcf{K: "agent-loop", ID: runID, Msg: msg, Model: model, Brief: brief})
	deadline := time.After(30 * time.Second)
	var done *dcf
wait:
	for {
		select {
		case f := <-h.frames:
			switch f.K {
			case "agent-event":
				if f.Event != nil {
					h.mu.Lock()
					h.eventTypes = append(h.eventTypes, f.Event.Type)
					h.mu.Unlock()
				}
			case "out":
				if f.Done && f.ID == runID {
					copied := f
					done = &copied
					break wait
				}
			}
		case <-deadline:
			h.mu.Lock()
			types := strings.Join(h.eventTypes, ",")
			h.mu.Unlock()
			t.Fatal("timeout waiting for out done; events=" + types)
		}
	}
	h.mu.Lock()
	types := append([]string(nil), h.eventTypes...)
	h.mu.Unlock()
	return *done, types
}

// nodeTestDirectoryModels 是 node 夹具目录里的模型：node 现在先用 model-grant 读
// /v1/models 解析协议，所以夹具必须真的提供目录（不绕过生产目录解析）。
var nodeTestDirectoryModels = []gwTestModel{
	{ID: nodeTestDefaultModel, Protocols: []string{"openai-completions"}},
	{ID: "model-a", Protocols: []string{"openai-completions"}},
	{ID: "model-b", Protocols: []string{"openai-completions"}},
}

// nodeTestDefaultModel 是夹具里 Hub 保存的默认模型：目录里只有真实 id，没有字面 default。
const nodeTestDefaultModel = "default-model"

// nodeGatewayFixture 在假上游前面挂上 Hub 目录：GET /v1/models 由夹具回答，
// 其余请求原样交给 handler（因此目录请求不会出现在回合记录里）。
func nodeGatewayFixture(t *testing.T, handler http.HandlerFunc) http.Handler {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": nodeTestDirectoryModels})
	})
	mux.HandleFunc("/", handler)
	return mux
}

func newE2EHarness(t *testing.T, handler http.HandlerFunc) *e2eHarness {
	t.Helper()
	t.Setenv("HW_CONF", t.TempDir())
	h := &e2eHarness{
		frames: make(chan dcf, 256),
		grants: make(chan string, 16),
	}
	h.upstream = httptest.NewServer(nodeGatewayFixture(t, handler))
	h.hub = stubHubWS(t, h.frames, h.grants)
	t.Cleanup(h.upstream.Close)
	t.Cleanup(h.hub.Close)

	cn := newConn("ws"+strings.TrimPrefix(h.hub.URL, "http")+"/ws", "tok", true)
	cn.rel = true
	if err := cn.dial(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cn.close)
	h.cn = cn

	h.a = &nodeAgent{
		conf:         map[string]string{"hub": h.upstream.URL},
		id:           &identity{FP: "fp-e2e"},
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

func TestLocalNodeRunEndToEnd(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "out.txt")
	args, _ := json.Marshal(map[string]string{"path": target, "content": "hi"})

	var h *e2eHarness
	h = newE2EHarness(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var req struct {
			Messages []struct {
				Role    string `json:"role"`
				Content any    `json:"content"`
			} `json:"messages"`
		}
		_ = json.Unmarshal(raw, &req)
		round := chatRound{auth: r.Header.Get("Authorization")}
		for _, m := range req.Messages {
			switch m.Role {
			case "system":
				round.system += flattenChatContent(m.Content)
			case "user":
				round.user += "\n" + flattenChatContent(m.Content)
			}
		}
		h.mu.Lock()
		h.rounds = append(h.rounds, round)
		n := len(h.rounds)
		h.mu.Unlock()
		if n == 1 {
			writeNodeSSEToolCall(w, "c1", "write_file", string(args))
			return
		}
		writeNodeSSEText(w, "done-local")
	})

	done, types := h.runTurn(t, "run-e2e", "write hi to file", "CTX_BRIEF", "default")
	if done.Code != 0 || done.Err != "" {
		t.Fatalf("out code=%d err=%q events=%s", done.Code, done.Err, strings.Join(types, ","))
	}
	select {
	case g := <-h.grants:
		if g != "run-e2e" {
			t.Fatalf("grant run id=%q", g)
		}
	default:
		t.Fatal("model-grant was not requested")
	}
	h.mu.Lock()
	rounds := append([]chatRound(nil), h.rounds...)
	h.mu.Unlock()
	if len(rounds) == 0 || rounds[0].auth != "Bearer grantcode" {
		t.Fatalf("model auth=%q", rounds)
	}
	raw, err := os.ReadFile(target)
	if err != nil || string(raw) != "hi" {
		t.Fatalf("host tool did not write the file: %q err=%v", raw, err)
	}
	if !strings.Contains(rounds[0].system, "local coding agent") {
		t.Fatalf("system prompt lost the local persona: %q", rounds[0].system)
	}
	if !strings.Contains(rounds[0].user, "CTX_BRIEF") {
		t.Fatalf("this turn's workspace context must reach the prompt: %q", rounds[0].user)
	}
	if strings.Contains(rounds[0].system, "CTX_BRIEF") {
		t.Fatalf("the saved system binding must not change per turn: %q", rounds[0].system)
	}
	joined := strings.Join(types, ",")
	for _, want := range []string{"task_update", "tool_start", "tool_end", "text_delta", "agent_end"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %s in events %q", want, joined)
		}
	}

	// 同一 session 续接：第二次回合复用同一个原生会话，模型看到上一轮历史。
	sess := h.a.hostSession()
	first := sess.state.NativeSessionID
	if first == "" {
		t.Fatal("native session id was not persisted")
	}
	done2, _ := h.runTurn(t, "run-e2e-2", "continue", "", "default")
	if done2.Code != 0 || done2.Err != "" {
		t.Fatalf("second out code=%d err=%q", done2.Code, done2.Err)
	}
	if got := h.a.hostSession().state.NativeSessionID; got != first {
		t.Fatalf("a resume must keep the same native session: %q -> %q", first, got)
	}
	h.mu.Lock()
	rounds = append([]chatRound(nil), h.rounds...)
	h.mu.Unlock()
	if len(rounds) < 3 {
		t.Fatalf("expected a second run to reach the model, got %d calls", len(rounds))
	}
	last := rounds[len(rounds)-1]
	if !strings.Contains(last.user, "write hi to file") || !strings.Contains(last.user, "continue") {
		t.Fatalf("the resumed session must carry the earlier turn: %q", last.user)
	}
	if last.system != rounds[0].system {
		t.Fatalf("a resume must reuse the saved system prompt: %q vs %q", last.system, rounds[0].system)
	}
}

func TestLocalNodeAbortIsNotSuccess(t *testing.T) {
	h := newE2EHarness(t, func(w http.ResponseWriter, r *http.Request) {
		// 永不返回的流：等客户端断开。
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if fl, ok := w.(http.Flusher); ok {
			fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"start\"}}]}\n\n")
			fl.Flush()
		}
		<-r.Context().Done()
	})

	sess := h.a.hostSession()
	go h.a.runLocalAgent(h.cn, &dcf{K: "agent-loop", ID: "run-abort", Msg: "long job", Model: "default"})
	deadline := time.After(20 * time.Second)
	for !sess.busyNow() {
		select {
		case <-deadline:
			t.Fatal("run never became busy")
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}
	h.a.onFrame(h.cn, &dcf{K: "agent-abort", ID: "run-abort"})

	deadline = time.After(20 * time.Second)
	for {
		select {
		case f := <-h.frames:
			if f.K == "out" && f.Done && f.ID == "run-abort" {
				if f.Code == 0 || f.Err == "" {
					t.Fatalf("an aborted run must not report success: %+v", f)
				}
				if len(sess.tasks()) == 0 {
					t.Fatal("board missing")
				}
				return
			}
		case <-deadline:
			t.Fatal("aborted run never finished")
		}
	}
}

// 模型显式换绑必须开新会话，而不是把旧历史静默接到另一个模型上。
func TestLocalNodeModelSwitchStartsNewSession(t *testing.T) {
	var h *e2eHarness
	h = newE2EHarness(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var req struct {
			Messages []struct {
				Role    string `json:"role"`
				Content any    `json:"content"`
			} `json:"messages"`
		}
		_ = json.Unmarshal(raw, &req)
		round := chatRound{auth: r.Header.Get("Authorization")}
		for _, m := range req.Messages {
			if m.Role == "user" {
				round.user += flattenChatContent(m.Content)
			}
		}
		h.mu.Lock()
		h.rounds = append(h.rounds, round)
		h.mu.Unlock()
		writeNodeSSEText(w, "ok")
	})
	if done, _ := h.runTurn(t, "run-1", "first goal", "", "model-a"); done.Code != 0 || done.Err != "" {
		t.Fatalf("first run: %+v", done)
	}
	sess := h.a.hostSession()
	first := sess.state.NativeSessionID
	if first == "" {
		t.Fatal("no native session was persisted")
	}
	done, types := h.runTurn(t, "run-2", "second goal", "", "model-b")
	if done.Code != 0 || done.Err != "" {
		t.Fatalf("second run: %+v", done)
	}
	switched := false
	for _, ty := range types {
		if ty == "session" {
			switched = true
		}
	}
	if !switched {
		t.Fatalf("a model switch must be visible in the event stream: %v", types)
	}
	second := h.a.hostSession().state.NativeSessionID
	if second == "" || second == first {
		t.Fatalf("a model switch must start a new session: %q -> %q", first, second)
	}
	if prev := h.a.hostSession().state.PrevSessionID; prev != first {
		t.Fatalf("the previous session must be recorded, not silently dropped: %q", prev)
	}
	h.mu.Lock()
	rounds := append([]chatRound(nil), h.rounds...)
	h.mu.Unlock()
	last := rounds[len(rounds)-1]
	if strings.Contains(last.user, "first goal") {
		t.Fatalf("the new session must not continue the old model's history: %q", last.user)
	}
	if !strings.Contains(last.user, "second goal") {
		t.Fatalf("the new session must carry its own prompt: %q", last.user)
	}
	// 同一模型继续续接同一个会话。
	if done, _ := h.runTurn(t, "run-3", "third goal", "", "model-b"); done.Code != 0 {
		t.Fatalf("third run: %+v", done)
	}
	if got := h.a.hostSession().state.NativeSessionID; got != second {
		t.Fatalf("the same model must keep resuming its session: %q -> %q", second, got)
	}
}
