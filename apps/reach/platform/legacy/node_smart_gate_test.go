package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// smartGateFixture tests the Hub gate using a stub directory/resolve/SSE server.
// It does not exercise shared Gateway policy; node_smart_integration_test.go does.
type smartGateFixture struct {
	t  *testing.T
	gw *gwFixture
	h  *hubSrv
	// Hub 的 /v1 代理入口。
	proxy *httptest.Server

	code     string
	run      string
	binding  string
	model    string
	protocol string
	decision string
}

func newSmartGateFixture(t *testing.T) *smartGateFixture {
	t.Helper()
	skillTestConf(t)
	f := newGatewayFixture(t, []gwTestModel{
		{ID: "glm-4.6", Protocols: []string{"openai-completions"}},
		{ID: "other-model", Protocols: []string{"openai-completions"}},
	})
	smartStore(f, "handwave-hub")
	h := &hubSrv{token: "test-root", gw: f.Store}

	mux := http.NewServeMux()
	h.routes(mux)
	proxy := httptest.NewServer(mux)
	t.Cleanup(proxy.Close)

	// Stub resolve supplies a deterministic tuple for these narrow gate tests.
	res, err := f.Store.resolveRouteOnce(context.Background(), "smart-gate-1", "读一遍日志并总结", false)
	if err != nil {
		t.Fatalf("resolve failed: %v", err)
	}
	exp, _ := time.Parse(time.RFC3339, strings.TrimSpace(res.ExpiresAt))
	pin, err := h.bindings().pinSession("fp-smart", sessionPin{
		FP:          "fp-smart",
		Model:       res.Decision.Model,
		Protocol:    res.Decision.Protocol,
		DecisionID:  res.Decision.DecisionID,
		DecisionExp: exp,
	})
	if err != nil {
		t.Fatal(err)
	}
	g, err := h.bindings().attachRun("fp-smart", "run-smart", pin.BindingID)
	if err != nil {
		t.Fatal(err)
	}
	return &smartGateFixture{t: t, gw: f, h: h, proxy: proxy,
		code: g.Code, run: g.RunID, binding: g.BindingID,
		model: res.Decision.Model, protocol: res.Decision.Protocol, decision: res.Decision.DecisionID}
}

func chatBodyFor(model string) []byte {
	b, _ := json.Marshal(map[string]any{"model": model, "messages": []map[string]string{{"role": "user", "content": "hi"}}})
	return b
}

// upstreamCalls 统计打到假上游 /v1/chat/completions 的次数（请求是否真的发出）。
func (f *smartGateFixture) upstreamCalls() int {
	n := 0
	for _, r := range f.gw.snapshotRecords() {
		if r.Path == "/v1/chat/completions" {
			n++
		}
	}
	return n
}

func (f *smartGateFixture) call(t *testing.T, path string, body []byte, run, binding string) (int, int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, f.proxy.URL+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+f.code)
	req.Header.Set("Content-Type", "application/json")
	if run != "" {
		req.Header.Set(smartRunHeader, run)
	}
	if binding != "" {
		req.Header.Set(smartBindingHeader, binding)
	}
	before := f.upstreamCalls()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(resp.Body)
	return resp.StatusCode, f.upstreamCalls() - before, buf.String()
}

// 正常智能请求：到达上游，且上游看到的决策头由 Hub 注入。
func TestSmartGateForwardsWithInjectedDecision(t *testing.T) {
	f := newSmartGateFixture(t)
	status, reached, body := f.call(t, "/v1/chat/completions", chatBodyFor(f.model), f.run, f.binding)
	if status != http.StatusOK || reached != 1 {
		t.Fatalf("smart request should be forwarded: status=%d reached=%d body=%s", status, reached, body)
	}
	found := false
	for _, r := range f.gw.snapshotRecords() {
		if r.Path != "/v1/chat/completions" {
			continue
		}
		if r.Header.Get("X-ARA-Route-Decision") == f.decision {
			found = true
		}
		// 关联头只是 Hub↔Node 之间的标识，绝不能流到上游。
		if r.Header.Get(smartRunHeader) != "" || r.Header.Get(smartBindingHeader) != "" {
			t.Fatalf("host association headers leaked upstream: %v", r.Header)
		}
	}
	if !found {
		t.Fatalf("decision header %q did not reach the upstream", f.decision)
	}
}

// HTTP 只带 bearer 无法辨认 Run：关联缺失即拒绝，且上游 0 请求。
func TestSmartGateRejectsMissingAssociation(t *testing.T) {
	f := newSmartGateFixture(t)
	if status, reached, _ := f.call(t, "/v1/chat/completions", chatBodyFor(f.model), "", ""); status != http.StatusForbidden || reached != 0 {
		t.Fatalf("missing association must be rejected: status=%d reached=%d", status, reached)
	}
	if status, reached, _ := f.call(t, "/v1/chat/completions", chatBodyFor(f.model), f.run, ""); status != http.StatusForbidden || reached != 0 {
		t.Fatalf("missing binding must be rejected: status=%d reached=%d", status, reached)
	}
}

// 错 Run / 错 Binding 都拒绝，上游 0 请求。
func TestSmartGateRejectsWrongAssociation(t *testing.T) {
	f := newSmartGateFixture(t)
	if status, reached, _ := f.call(t, "/v1/chat/completions", chatBodyFor(f.model), "run-other", f.binding); status != http.StatusForbidden || reached != 0 {
		t.Fatalf("wrong run must be rejected: status=%d reached=%d", status, reached)
	}
	if status, reached, _ := f.call(t, "/v1/chat/completions", chatBodyFor(f.model), f.run, "b-other"); status != http.StatusForbidden || reached != 0 {
		t.Fatalf("wrong binding must be rejected: status=%d reached=%d", status, reached)
	}
}

// 实际模型与绑定元组不一致 → 拒绝，上游 0 请求。
func TestSmartGateRejectsModelMismatch(t *testing.T) {
	f := newSmartGateFixture(t)
	if status, reached, _ := f.call(t, "/v1/chat/completions", chatBodyFor("other-model"), f.run, f.binding); status != http.StatusConflict || reached != 0 {
		t.Fatalf("model mismatch must be rejected: status=%d reached=%d", status, reached)
	}
}

// 目录请求没有模型体：单独规则，只要 code 与关联对得上就放行。
func TestSmartGateAllowsDirectoryRequest(t *testing.T) {
	f := newSmartGateFixture(t)
	req, err := http.NewRequest(http.MethodGet, f.proxy.URL+"/v1/models", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+f.code)
	req.Header.Set(smartRunHeader, f.run)
	req.Header.Set(smartBindingHeader, f.binding)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("directory request must be allowed, got %d", resp.StatusCode)
	}
}

// 绑定被撤销后必须失败，不得静默退回旧宽授权。
func TestSmartGateRejectsAfterBindingRevoked(t *testing.T) {
	f := newSmartGateFixture(t)
	f.h.bindings().revokePin("fp-smart", f.binding)
	if status, reached, _ := f.call(t, "/v1/chat/completions", chatBodyFor(f.model), f.run, f.binding); status != http.StatusForbidden || reached != 0 {
		t.Fatalf("revoked binding must be rejected: status=%d reached=%d", status, reached)
	}
}

// 换码后旧码立即失效，新码仍可用：不允许两个 code 并行可用。
func TestSmartGateOldCodeInvalidAfterSwap(t *testing.T) {
	f := newSmartGateFixture(t)
	old := f.code
	next, err := f.h.bindings().attachRun("fp-smart", f.run, f.binding)
	if err != nil {
		t.Fatal(err)
	}
	if next.Code == old {
		t.Fatal("swap must mint a new code")
	}
	if status, _, _ := f.call(t, "/v1/chat/completions", chatBodyFor(f.model), f.run, f.binding); status == http.StatusOK {
		t.Fatal("old code must not work after the swap")
	}
	f.code = next.Code
	if status, reached, body := f.call(t, "/v1/chat/completions", chatBodyFor(f.model), f.run, f.binding); status != http.StatusOK || reached != 1 {
		t.Fatalf("new code must work: status=%d reached=%d body=%s", status, reached, body)
	}
}

// 关联头必须能被剥离，且不得与凭据头重名。
func TestSmartAssociationHeadersAreStripped(t *testing.T) {
	h := http.Header{}
	h.Set(smartRunHeader, "run-1")
	h.Set(smartBindingHeader, "b-1")
	stripHostAssociationHeaders(h)
	if h.Get(smartRunHeader) != "" || h.Get(smartBindingHeader) != "" {
		t.Fatal("association headers must be stripped")
	}
	for _, name := range gatewayCredentialHeaders {
		if strings.EqualFold(name, smartRunHeader) || strings.EqualFold(name, smartBindingHeader) {
			t.Fatalf("association header collides with credential header %q", name)
		}
	}
}

// wire 判定：两个协议 id 可共用同一 wire，path 只定 wire，不能反推具体协议。
func TestProtocolWireMappingIsShared(t *testing.T) {
	if got := protocolWire("openai-completions"); got != "chat" {
		t.Fatalf("got %q", got)
	}
	if got := protocolWire("openrouter-chat"); got != "chat" {
		t.Fatalf("openrouter-chat shares the chat wire, got %q", got)
	}
	if got := protocolWire("azure-openai-responses"); got != "responses" {
		t.Fatalf("got %q", got)
	}
	if got := gatewayPathWire("/v1/chat/completions"); got != "chat" {
		t.Fatalf("got %q", got)
	}
	if got := gatewayPathWire("/v1beta/models/gemini-model:generateContent"); got != "gemini" {
		t.Fatalf("got %q", got)
	}
	// Gemini 模型段只解码一次，%2F 解码后应保留在模型名里。
	if got := requestModelOf("/v1beta/models/a%2Fb:generateContent", nil); got != "a/b" {
		t.Fatalf("got %q", got)
	}
}
