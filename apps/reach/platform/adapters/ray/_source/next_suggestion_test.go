package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type suggestionFixture struct {
	p           *platform
	token       string
	mu          sync.Mutex
	messages    string
	workspaceFP string
	model       func(http.ResponseWriter, *http.Request, suggestionInput)
	calls       atomic.Int32
	bodies      [][]byte
}

func newSuggestionFixture(t *testing.T) *suggestionFixture {
	t.Helper()
	p, token := testPlatform(t)
	f := &suggestionFixture{p: p, token: token, workspaceFP: "A", messages: `[{"role":"user","content":"定位 /var/log/demo.log 的超时，先只读检查。","native":{"thinking":"PRIVATE_THINKING"},"provider_data":"PRIVATE_PROVIDER"},{"role":"assistant","content":"已定位 retry timeout，尚未验证修复。"}]`}
	f.model = func(w http.ResponseWriter, _ *http.Request, in suggestionInput) {
		f.reply(w, in, "先检查 /var/log/demo.log 的 retry timeout 前后日志，核实失败原因。")
	}
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer private-hub-bridge" || strings.Contains(r.Header.Get("Cookie"), sessionCookie) {
			t.Error("suggestion leaked/changed bridge authority")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/handwave/api/workspaces":
			f.mu.Lock()
			fp := f.workspaceFP
			f.mu.Unlock()
			fmt.Fprintf(w, `[{"id":"wa","device_fp":%q},{"id":"wb","device_fp":"B"}]`, fp)
		case "/handwave/api/workspaces/wa/sessions", "/handwave/api/workspaces/wb/sessions":
			io.WriteString(w, `[{"id":"sa"}]`)
		case "/handwave/api/workspaces/wa/sessions/sa/messages", "/handwave/api/workspaces/wb/sessions/sa/messages":
			f.mu.Lock()
			m := f.messages
			f.mu.Unlock()
			io.WriteString(w, m)
		case "/handwave/v1/chat/completions":
			body, err := io.ReadAll(r.Body)
			if err != nil {
				t.Error(err)
				return
			}
			if len(body) > suggestionInputLimit || bytes.Contains(body, []byte("PRIVATE_THINKING")) || bytes.Contains(body, []byte("PRIVATE_PROVIDER")) {
				t.Error("unsafe suggestion context")
			}
			var request struct {
				Model    string          `json:"model"`
				Max      int             `json:"max_tokens"`
				Stream   bool            `json:"stream"`
				Tools    json.RawMessage `json:"tools"`
				Messages []struct {
					Role    string `json:"role"`
					Content string `json:"content"`
				} `json:"messages"`
			}
			if json.Unmarshal(body, &request) != nil || request.Model != "auto" || request.Max != 1536 || request.Stream || len(request.Tools) > 0 || len(request.Messages) != 2 || request.Messages[0].Role != "system" {
				t.Error("model request exceeded contract")
				return
			}
			var input suggestionInput
			if json.Unmarshal([]byte(request.Messages[1].Content), &input) != nil {
				t.Error("input JSON")
				return
			}
			f.mu.Lock()
			f.bodies = append(f.bodies, body)
			callback := f.model
			f.mu.Unlock()
			f.calls.Add(1)
			callback(w, r, input)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(hub.Close)
	p.edge = reverseProxy(hub.URL)
	return f
}
func (f *suggestionFixture) reply(w http.ResponseWriter, in suggestionInput, prompt string) {
	ids := []string{}
	for _, s := range in.Sources {
		ids = append(ids, s.ID)
		if len(ids) == 16 {
			break
		}
	}
	content, _ := json.Marshal(suggestionOutput{Summary: "当前目标是只读定位 demo.log 超时；已有线索但修复尚未验证。", NextPrompt: prompt, SourceIDs: ids})
	_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": string(content)}}}})
}
func (f *suggestionFixture) request(q suggestionRequest) *httptest.ResponseRecorder {
	body, _ := json.Marshal(q)
	r := testRequest("POST", nextSuggestionPath, f.token)
	r.Header.Set("Origin", "https://127.0.0.1")
	r.Body = io.NopCloser(bytes.NewReader(body))
	w := httptest.NewRecorder()
	f.p.handler("primary").ServeHTTP(w, r)
	return w
}
func suggestionQ() suggestionRequest {
	return suggestionRequest{WorkspaceID: "wa", SessionID: "sa", DeviceFP: "A"}
}
func (f *suggestionFixture) advance(d time.Duration) {
	now := f.p.suggestions.now().Add(d)
	f.p.suggestions.now = func() time.Time { return now }
}
func TestSuggestionAuthorityAndSessionMembership(t *testing.T) {
	f := newSuggestionFixture(t)
	r := testRequest("POST", nextSuggestionPath, "")
	r.Header.Set("Authorization", "Bearer private-hub-bridge")
	w := httptest.NewRecorder()
	f.p.handler("primary").ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("machine bearer admitted")
	}
	r = testRequest("POST", nextSuggestionPath, f.token)
	w = httptest.NewRecorder()
	f.p.handler("primary").ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross-origin admitted")
	}
	for _, mutate := range []func(*suggestionRequest){func(q *suggestionRequest) { q.SessionID = "../sa" }, func(q *suggestionRequest) { q.WorkspaceID = "wa/other" }, func(q *suggestionRequest) { q.DeviceFP = "A?token=x" }} {
		q := suggestionQ()
		mutate(&q)
		if f.request(q).Code != 400 {
			t.Fatal("unsafe owner ID")
		}
	}
	q := suggestionQ()
	q.SessionID = "absent"
	if f.request(q).Code != 409 {
		t.Fatal("empty messages admitted absent session")
	}
	q = suggestionQ()
	q.DeviceFP = "B"
	if f.request(q).Code != 409 {
		t.Fatal("wrong device admitted")
	}
	if f.calls.Load() != 0 {
		t.Fatal("authority failure reached model")
	}
}
func TestSuggestionCanonicalContextCacheMemoryAndPreferences(t *testing.T) {
	f := newSuggestionFixture(t)
	if _, err := f.p.memory.Write("device", "A", strings.Repeat("1", 32), "", 0, "preference", "日志规则", "先保留原日志，不要直接删除。"); err != nil {
		t.Fatal(err)
	}
	q := suggestionQ()
	q.RecentResult = &suggestionObservation{RunID: "runA", Status: "failed", Tools: []suggestionTool{{Name: "read_file", Status: "completed"}}}
	w := f.request(q)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var result suggestionResponse
	if json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Summary == "" || result.NextPrompt == "" || result.Revision == "" {
		t.Fatal("missing suggestion")
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("cached browser response")
	}
	f.mu.Lock()
	wire := string(f.bodies[0])
	f.mu.Unlock()
	if !strings.Contains(wire, "不要直接删除") || !strings.Contains(wire, "尚未验证") || !strings.Contains(wire, "controller_observation_not_independent_verification") {
		t.Fatal("context/memory/receipt not joined")
	}
	if again := f.request(q); again.Code != 200 || again.Body.String() != w.Body.String() || f.calls.Load() != 1 {
		t.Fatal("same canonical revision called model again")
	}
	f.advance(4 * time.Second)
	off := false
	q.IncludeMemory = &off
	w = f.request(q)
	if w.Code != 200 || f.calls.Load() != 2 {
		t.Fatal("memory preference not separated")
	}
	f.mu.Lock()
	wire = string(f.bodies[1])
	f.mu.Unlock()
	if strings.Contains(wire, "不要直接删除") {
		t.Fatal("excluded memory in request")
	}
	f.advance(4 * time.Second)
	q = suggestionQ()
	q.WorkspaceID = "wb"
	q.DeviceFP = "B"
	if f.request(q).Code != 200 || f.calls.Load() != 3 {
		t.Fatal("different device used old cache")
	}
	f.mu.Lock()
	wire = string(f.bodies[2])
	f.mu.Unlock()
	if strings.Contains(wire, "不要直接删除") {
		t.Fatal("other device leaked memory")
	}
}
func TestSuggestionMalformedTruncatedToolsAndUnknownSources(t *testing.T) {
	for _, mode := range []string{"malformed", "fenced", "truncated", "tool", "unknown-source", "duplicate-key", "too-long", "extra-key"} {
		t.Run(mode, func(t *testing.T) {
			f := newSuggestionFixture(t)
			f.model = func(w http.ResponseWriter, _ *http.Request, in suggestionInput) {
				output := map[string]any{"summary": "summary", "next_prompt": "检查日志。", "source_ids": []string{in.Sources[0].ID}}
				finish := "stop"
				message := map[string]any{}
				switch mode {
				case "truncated":
					finish = "length"
				case "tool":
					message["tool_calls"] = []any{map[string]string{"id": "call"}}
				case "unknown-source":
					output["source_ids"] = []string{"not-provided"}
				case "too-long":
					output["next_prompt"] = strings.Repeat("长", 121)
				case "extra-key":
					output["execute"] = true
				}
				b, _ := json.Marshal(output)
				content := string(b)
				if mode == "malformed" {
					content = "{"
				}
				if mode == "fenced" {
					content = "```json\n" + content + "\n```"
				}
				if mode == "duplicate-key" {
					content = `{"summary":"a","summary":"b","next_prompt":"check","source_ids":["` + in.Sources[0].ID + `"]}`
				}
				message["content"] = content
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": finish, "message": message}}})
			}
			if f.request(suggestionQ()).Code != 503 {
				t.Fatal("invalid result displayed")
			}
			if f.request(suggestionQ()).Code != 429 || f.calls.Load() != 1 {
				t.Fatal("failure bypassed cooldown")
			}
		})
	}
}
func TestSuggestionMemoryAndMessageChangeDuringGeneration(t *testing.T) {
	for _, change := range []string{"memory", "messages", "binding"} {
		t.Run(change, func(t *testing.T) {
			f := newSuggestionFixture(t)
			f.model = func(w http.ResponseWriter, _ *http.Request, in suggestionInput) {
				switch change {
				case "memory":
					if _, err := f.p.memory.Write("device", "A", strings.Repeat("2", 32), "", 0, "fact", "changed", "New fact"); err != nil {
						t.Error(err)
					}
				case "messages":
					f.mu.Lock()
					f.messages = `[{"role":"user","content":"新的任务"}]`
					f.mu.Unlock()
				case "binding":
					f.mu.Lock()
					f.workspaceFP = "B"
					f.mu.Unlock()
				}
				f.reply(w, in, "检查日志。")
			}
			if f.request(suggestionQ()).Code != 503 || len(f.p.suggestions.cache) != 0 {
				t.Fatal("stale generation cached")
			}
		})
	}
}
func TestSuggestionSingleflightConcurrencyCancellationAndTimeout(t *testing.T) {
	f := newSuggestionFixture(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	f.model = func(w http.ResponseWriter, r *http.Request, in suggestionInput) {
		select {
		case entered <- struct{}{}:
		default:
		}
		select {
		case <-release:
			f.reply(w, in, "检查日志。")
		case <-r.Context().Done():
		}
	}
	first := make(chan *httptest.ResponseRecorder, 1)
	go func() { first <- f.request(suggestionQ()) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("model never started")
	}
	second := make(chan *httptest.ResponseRecorder, 1)
	go func() { second <- f.request(suggestionQ()) }()
	joined := false
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		f.p.suggestions.mu.Lock()
		for _, flight := range f.p.suggestions.flights {
			joined = flight.waiters >= 2
		}
		f.p.suggestions.mu.Unlock()
		if joined {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if !joined {
		close(release)
		t.Fatal("follower did not join active flight")
	}
	close(release)
	if (<-first).Code != 200 || (<-second).Code != 200 || f.calls.Load() != 1 {
		t.Fatal("singleflight issued duplicate model calls")
	}
	f = newSuggestionFixture(t)
	f.p.suggestions.modelTimeout = 30 * time.Millisecond
	f.model = func(_ http.ResponseWriter, r *http.Request, _ suggestionInput) { <-r.Context().Done() }
	if f.request(suggestionQ()).Code != 503 || len(f.p.suggestions.cache) != 0 || f.calls.Load() != 1 {
		t.Fatal("timeout retained candidate")
	}
	if f.request(suggestionQ()).Code != 429 || f.calls.Load() != 1 {
		t.Fatal("timeout automatically replayed")
	}
}
func TestSuggestionCompleteWireBudgetAndWholeMemoryRecords(t *testing.T) {
	f := newSuggestionFixture(t)
	f.mu.Lock()
	f.messages = `[{"role":"user","content":` + fmtJSON(strings.Repeat("目标", 12000)) + `}]`
	f.mu.Unlock()
	for i := 0; i < 8; i++ {
		_, err := f.p.memory.Write("device", "A", fmt.Sprintf("%032x", i+20), "", 0, "fact", "record", strings.Repeat("memory ", 900))
		if err != nil {
			t.Fatal(err)
		}
	}
	f.model = func(w http.ResponseWriter, _ *http.Request, in suggestionInput) {
		for _, s := range in.Sources {
			if strings.HasPrefix(s.Kind, "accepted_memory") && suggestionHash([]byte(s.Text)) != s.Hash {
				t.Error("memory was truncated under original hash")
			}
		}
		f.reply(w, in, "检查目标并确认下一步。")
	}
	if w := f.request(suggestionQ()); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}
func fmtJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func TestSuggestionRequestCancellation(t *testing.T) {
	f := newSuggestionFixture(t)
	entered := make(chan struct{})
	f.model = func(_ http.ResponseWriter, r *http.Request, _ suggestionInput) { close(entered); <-r.Context().Done() }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	body, _ := json.Marshal(suggestionQ())
	r := testRequest("POST", nextSuggestionPath, f.token).WithContext(ctx)
	r.Header.Set("Origin", "https://127.0.0.1")
	r.Body = io.NopCloser(bytes.NewReader(body))
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { w := httptest.NewRecorder(); f.p.handler("primary").ServeHTTP(w, r); done <- w }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("model not entered")
	}
	cancel()
	select {
	case w := <-done:
		if w.Code != 503 {
			t.Fatal(w.Code)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation hung")
	}
	if len(f.p.suggestions.cache) != 0 || f.calls.Load() != 1 {
		t.Fatal("canceled output cached or replayed")
	}
	if f.request(suggestionQ()).Code != 429 {
		t.Fatal("cancel cooldown missing")
	}
}

func TestSuggestionBookLimitsAndExpiry(t *testing.T) {
	b := newSuggestionBook()
	now := time.Now()
	b.now = func() time.Time { return now }
	_, f, leader, err := b.reserve("a", "a", "a")
	if err != nil || !leader {
		t.Fatal(err)
	}
	for i := 1; i < 16; i++ {
		_, ff, l, e := b.reserve("a", "a", "a")
		if e != nil || l || ff != f {
			t.Fatal("flight join", i)
		}
	}
	if _, _, _, e := b.reserve("a", "a", "a"); e == nil {
		t.Fatal("unbounded waiters")
	}
	_, f2, _, e := b.reserve("b", "b", "b")
	if e != nil {
		t.Fatal(e)
	}
	if _, _, _, e := b.reserve("c", "c", "c"); e == nil {
		t.Fatal("global concurrency bypass")
	}
	b.finish("a", f, suggestionResponse{}, fmt.Errorf("failure"))
	b.finish("b", f2, suggestionResponse{}, fmt.Errorf("failure"))
	if _, _, _, e := b.reserve("a", "a", "a2"); e == nil {
		t.Fatal("failure cooldown bypass")
	}
	now = now.Add(4 * time.Second)
	for i := 0; i < 3; i++ {
		key := fmt.Sprint(i)
		_, ff, _, e := b.reserve("owner"+key, "a", key)
		if e != nil {
			t.Fatal(e)
		}
		b.finish(key, ff, suggestionResponse{}, fmt.Errorf("failure"))
	}
	if _, _, _, e := b.reserve("last", "a", "last"); e == nil {
		t.Fatal("actor rate bypass")
	}
	now = now.Add(time.Minute)
	_, f, _, e = b.reserve("a", "a", "valid")
	if e != nil {
		t.Fatal(e)
	}
	response := suggestionResponse{ExpiresAt: now.Add(time.Minute).UTC().Format(time.RFC3339), suggestionOutput: suggestionOutput{Summary: "cached"}}
	b.finish("valid", f, response, nil)
	cached, ff, _, e := b.reserve("a", "a", "valid")
	if e != nil || ff != nil || cached.Summary != "cached" {
		t.Fatal("cache miss")
	}
	now = now.Add(time.Minute)
	_, f, leader, e = b.reserve("a", "a", "valid")
	if e != nil || !leader || f == nil {
		t.Fatal("expired cache served")
	}
	b.finish("valid", f, suggestionResponse{}, fmt.Errorf("failure"))
}

func TestSuggestionBookGlobalRateAndLRU(t *testing.T) {
	b := newSuggestionBook()
	now := time.Now()
	b.now = func() time.Time { return now }
	for i := 0; i < 20; i++ {
		k := fmt.Sprint(i)
		_, f, _, e := b.reserve(k, k, k)
		if e != nil {
			t.Fatal(e)
		}
		b.finish(k, f, suggestionResponse{}, fmt.Errorf("failure"))
	}
	if _, _, _, e := b.reserve("21", "21", "21"); e == nil {
		t.Fatal("global rate bypass")
	}
	b = newSuggestionBook()
	b.now = func() time.Time { return now }
	for i := 0; i < 130; i++ {
		k := fmt.Sprint(i)
		f := &suggestionFlight{done: make(chan struct{})}
		b.slots <- struct{}{}
		b.flights[k] = f
		b.finish(k, f, suggestionResponse{ExpiresAt: now.Add(time.Minute).UTC().Format(time.RFC3339)}, nil)
		now = now.Add(time.Millisecond)
	}
	if len(b.cache) != 128 || b.cacheBytes > 512<<10 {
		t.Fatal("cache bounds")
	}
	if _, ok := b.cache["0"]; ok {
		t.Fatal("oldest cache retained")
	}
}
