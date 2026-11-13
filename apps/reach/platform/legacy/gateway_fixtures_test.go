package main

// 离线 httptest 网关 fixtures：真实 HTTP 目录 + 模型端点，替代旧测试里的
// upRegistry / OMP 文件 / http.DefaultClient mock。所有断言都跑在真实的
// gatewayclient + providers 生产路径上。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// gwTestModel 是测试网关目录里的一个逻辑模型。
type gwTestModel struct {
	ID        string   `json:"id"`
	Protocols []string `json:"protocols,omitempty"`
}

type gwRecorded struct {
	Method string
	Path   string
	Query  string
	Auth   string
	Header http.Header
	Body   []byte
}

// gwFixture 是一个离线网关：GET /v1/models 返回目录，/v1/chat/completions
// 默认返回 SSE 文本；其余路径交给 Chat 处理器（返回 true 表示已处理）。
type gwFixture struct {
	t      *testing.T
	Server *httptest.Server
	Store  *gatewayStore

	mu       sync.Mutex
	records  []gwRecorded
	Chat     func(w http.ResponseWriter, r *http.Request) bool
	ChatText string
	// Directory 非 nil 时用于覆盖 GET /v1/models 的响应。
	Directory func(w http.ResponseWriter, r *http.Request) bool
	// Resolve 非 nil 时用于覆盖 POST /v1/route/resolve 的响应（智能选型）。
	Resolve func(w http.ResponseWriter, r *http.Request) bool
	// resolveCalls 只统计打到 /v1/route/resolve 的次数，用于验证「只解析一次」。
	resolveCalls int
}

func newGatewayFixture(t *testing.T, models []gwTestModel) *gwFixture {
	t.Helper()
	f := &gwFixture{t: t, ChatText: "ok"}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 8<<20))
		r.Body = io.NopCloser(bytes.NewReader(body))
		f.mu.Lock()
		f.records = append(f.records, gwRecorded{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Auth: r.Header.Get("Authorization"), Header: r.Header.Clone(), Body: body})
		if r.URL.Path == "/v1/route/resolve" {
			f.resolveCalls++
		}
		f.mu.Unlock()
		if r.URL.Path == "/v1/route/resolve" {
			if f.Resolve != nil && f.Resolve(w, r) {
				return
			}
			writeResolveOK(w, "dec-fixture", "glm-4.6", "openai-completions")
			return
		}
		if r.URL.Path == "/v1/models" {
			if f.Directory != nil && f.Directory(w, r) {
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"data": models})
			return
		}
		if f.Chat != nil && f.Chat(w, r) {
			return
		}
		if r.URL.Path == "/v1/chat/completions" && r.Method == http.MethodPost {
			writeSSEText(w, f.ChatText)
			return
		}
		http.NotFound(w, r)
	})
	f.Server = httptest.NewServer(mux)
	t.Cleanup(f.Server.Close)
	f.Store = newGatewayStoreForTest(t, f.Server.URL, models[0].ID)
	return f
}

// newGatewayStoreForTest 构造一个指向 httptest 网关、允许回环的 store。
func newGatewayStoreForTest(t *testing.T, root, defaultModel string) *gatewayStore {
	t.Helper()
	return &gatewayStore{
		path: filepath.Join(t.TempDir(), gatewayConfigFile),
		cfg:  gatewayConfig{Root: root, DefaultModel: defaultModel, AllowLoopback: true},
		lookupIP: func(ctx context.Context, host string) ([]net.IPAddr, error) {
			return net.DefaultResolver.LookupIPAddr(ctx, host)
		},
	}
}

// newGatewayHub 返回 fixture 与一个直接使用该网关的 hub。
func newGatewayHub(t *testing.T, models []gwTestModel) (*gwFixture, *hubSrv) {
	t.Helper()
	f := newGatewayFixture(t, models)
	return f, &hubSrv{token: "tk", dev: true, gw: f.Store}
}

func (f *gwFixture) snapshotRecords() []gwRecorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]gwRecorded(nil), f.records...)
}

// resolveCalls 返回打到 /v1/route/resolve 的次数。
func (f *gwFixture) resolveCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.resolveCalls
}

// writeResolveOK 写一个能通过 gatewayclient 校验的最小决策。
func writeResolveOK(w http.ResponseWriter, decisionID, model, protocol string) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"decision": map[string]any{
			"decision_id":     decisionID,
			"model":           model,
			"protocol":        protocol,
			"pool":            "handwave-hub",
			"profile_hash":    "prof-1",
			"policy_version":  "pol-1",
			"catalog_version": "cat-1",
			"source":          "classifier",
		},
		"expires_at":      time.Now().Add(time.Hour).Format(time.RFC3339),
		"eligible_count":  2,
		"catalog_version": "cat-1",
	})
}

// chatBodies 返回所有命中 /v1/chat/completions 的请求体。
func (f *gwFixture) chatBodies() [][]byte {
	var out [][]byte
	for _, r := range f.snapshotRecords() {
		if r.Path == "/v1/chat/completions" {
			out = append(out, r.Body)
		}
	}
	return out
}

func writeSSEText(w http.ResponseWriter, text string) {
	w.Header().Set("Content-Type", "text/event-stream")
	fl, _ := w.(http.Flusher)
	chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": text}, "finish_reason": nil}}})
	fmt.Fprintf(w, "data: %s"+"\n"+"\n", chunk)
	if fl != nil {
		fl.Flush()
	}
	fmt.Fprint(w, "data: "+`{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`+"\n"+"\n")
	if fl != nil {
		fl.Flush()
	}
	fmt.Fprint(w, "data: [DONE]"+"\n"+"\n")
	if fl != nil {
		fl.Flush()
	}
}

// gwToolCall 是一次工具调用（id/name/参数 JSON）。
type gwToolCall struct{ ID, Name, Args string }

// writeSSEToolCall 返回一次工具调用流（单 call 便捷封装）。
func writeSSEToolCall(w http.ResponseWriter, id, name, args string) {
	writeSSEToolCalls(w, []gwToolCall{{ID: id, Name: name, Args: args}})
}

// writeSSEToolCalls 返回包含多个工具调用的流式响应（按 index 聚合）。
func writeSSEToolCalls(w http.ResponseWriter, calls []gwToolCall) {
	w.Header().Set("Content-Type", "text/event-stream")
	fl, _ := w.(http.Flusher)
	first := make([]any, 0, len(calls))
	second := make([]any, 0, len(calls))
	for i, c := range calls {
		first = append(first, map[string]any{"index": i, "id": c.ID, "type": "function", "function": map[string]any{"name": c.Name, "arguments": ""}})
		second = append(second, map[string]any{"index": i, "function": map[string]any{"arguments": c.Args}})
	}
	f1, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": first}}}})
	f2, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": second}}}})
	fmt.Fprintf(w, "data: %s"+"\n"+"\n"+"data: %s"+"\n"+"\n", f1, f2)
	fmt.Fprint(w, "data: "+`{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`+"\n"+"\n")
	fmt.Fprint(w, "data: [DONE]"+"\n"+"\n")
	if fl != nil {
		fl.Flush()
	}
}

// msgText 取一条 OpenAI 消息的文本：内容可能是字符串或内容块数组（providers 用数组）。
func msgText(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case []any:
		var b strings.Builder
		for _, p := range t {
			if m, ok := p.(map[string]any); ok {
				if s, ok := m["text"].(string); ok {
					b.WriteString(s)
				}
			}
		}
		return b.String()
	}
	return ""
}

// messagesText 把一组消息的所有文本拼起来，便于 contains 断言。
func messagesText(msgs []map[string]any) string {
	var b strings.Builder
	for _, m := range msgs {
		b.WriteString(msgText(m["content"]))
		b.WriteString("\n")
	}
	return b.String()
}
