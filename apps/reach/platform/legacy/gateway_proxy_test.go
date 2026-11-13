package main

// 模型代理（/v1/*）与原生协议选择/历史的聚焦 fixtures：
// 授权门、凭据隔离、Gemini/Ollama 映射、非模型路径拒绝、取消、离线、多协议。

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ara/internal/agent"
)

func gatewayProxyHub(t *testing.T, f *gwFixture) *httptest.Server {
	t.Helper()
	h := &hubSrv{token: "tk", dev: false, gw: f.Store}
	mux := http.NewServeMux()
	h.routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestGatewayProxyStripsClientCredentialsAndInjectsGatewayToken(t *testing.T) {
	skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	f.Chat = func(w http.ResponseWriter, r *http.Request) bool {
		_, _ = io.WriteString(w, "proxied-ok")
		return true
	}
	srv := gatewayProxyHub(t, f)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/v1/chat/completions", strings.NewReader(`{"model":"m1"}`))
	if err != nil {
		t.Fatal(err)
	}
	// Hub 授权用根令牌；其余凭据别名是客户端可能携带的旧上游 key，必须被清除。
	req.Header.Set("Authorization", "Bearer tk")
	req.Header.Set("x-api-key", "client-key-must-not-leak")
	req.Header.Set("api-key", "client-key-must-not-leak")
	req.Header.Set("x-goog-api-key", "client-key-must-not-leak")
	req.Header.Set("Cookie", "session=client")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "proxied-ok" {
		t.Fatalf("proxy response = %d %q", resp.StatusCode, body)
	}
	recs := f.snapshotRecords()
	if len(recs) != 1 || recs[0].Path != "/v1/chat/completions" {
		t.Fatalf("unexpected upstream records: %#v", recs)
	}
	if recs[0].Auth != "Bearer "+gwTestSecret {
		t.Fatalf("gateway token not injected: %q", recs[0].Auth)
	}
	for _, h := range []string{"X-Api-Key", "Api-Key", "X-Goog-Api-Key", "Cookie"} {
		if v := recs[0].Header.Get(h); v != "" {
			t.Fatalf("client credential %s was forwarded: %q", h, v)
		}
	}
	if strings.Contains(string(body), gwTestSecret) {
		t.Fatal("gateway token leaked into the response")
	}
}

func TestGatewayProxyMapsGeminiAndOllamaPaths(t *testing.T) {
	skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	f.Chat = func(w http.ResponseWriter, r *http.Request) bool {
		_, _ = io.WriteString(w, "ok")
		return true
	}
	srv := gatewayProxyHub(t, f)

	get := func(path string) {
		req, _ := http.NewRequest(http.MethodPost, srv.URL+path, nil)
		req.Header.Set("Authorization", "Bearer tk")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}
	get("/v1/gemini/models/gemini-2.0-flash:generateContent?alt=sse")
	get("/v1/ollama/api/chat")
	get("/v1/messages")

	recs := f.snapshotRecords()
	want := map[string]string{
		"/v1beta/models/gemini-2.0-flash:generateContent": "alt=sse",
		"/api/chat":    "",
		"/v1/messages": "",
	}
	seen := map[string]bool{}
	for _, rec := range recs {
		if _, ok := want[rec.Path]; !ok {
			t.Fatalf("unexpected upstream path %q", rec.Path)
		}
		if rec.Query != want[rec.Path] {
			t.Fatalf("query for %s = %q", rec.Path, rec.Query)
		}
		seen[rec.Path] = true
	}
	if len(seen) != 3 {
		t.Fatalf("mapped paths = %#v", seen)
	}
}

func TestGatewayProxyRejectsNonModelPathsAndWrongGrant(t *testing.T) {
	skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	f.Chat = func(w http.ResponseWriter, r *http.Request) bool {
		_, _ = io.WriteString(w, "ok")
		return true
	}
	h := &hubSrv{token: "tk", dev: false, gw: f.Store}
	mux := http.NewServeMux()
	h.routes(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// 非模型路径（网关管理面）不暴露。
	for _, path := range []string{"/v1/admin/keys", "/v1/keys", "/v1beta/models/x"} {
		req, _ := http.NewRequest(http.MethodGet, srv.URL+path, nil)
		req.Header.Set("Authorization", "Bearer tk")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("%s = %d, want 404", path, resp.StatusCode)
		}
	}
	// 错误授权 -> 401。
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer not-a-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong token = %d, want 401", resp.StatusCode)
	}
	if len(f.snapshotRecords()) != 0 {
		t.Fatal("unauthorized request reached the gateway")
	}
}

func TestGatewayProxyAcceptsModelGrant(t *testing.T) {
	skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	f.Chat = func(w http.ResponseWriter, r *http.Request) bool {
		_, _ = io.WriteString(w, "grant-ok")
		return true
	}
	h := testHubWithNode("FP1", true)
	h.token = "tk"
	h.gw = f.Store
	code, _, err := h.mintModelGrant("FP1", "run")
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	h.routes(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/chat/completions", strings.NewReader(`{"model":"m1"}`))
	req.Header.Set("Authorization", "Bearer "+code)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "grant-ok" {
		t.Fatalf("grant proxy = %d %q", resp.StatusCode, body)
	}
}

func TestGatewayMultiProtocolRequiresExplicitSelection(t *testing.T) {
	f := newGatewayFixture(t, []gwTestModel{{ID: "dual", Protocols: []string{"openai-completions", "anthropic-messages"}}})
	if _, _, err := f.Store.providerConfig(context.Background(), "dual", ""); err == nil {
		t.Fatal("multi-protocol model resolved without an explicit protocol")
	}
	pc, _, err := f.Store.providerConfig(context.Background(), "dual", "anthropic-messages")
	if err != nil {
		t.Fatal(err)
	}
	if pc.API != "anthropic-messages" || !strings.HasSuffix(pc.BaseURL, "/v1") {
		t.Fatalf("unexpected config: api=%q base=%q", pc.API, pc.BaseURL)
	}
	// 无协议旧目录 -> 仅 chat。
	f2 := newGatewayFixture(t, []gwTestModel{{ID: "legacy"}})
	pc2, _, err := f2.Store.providerConfig(context.Background(), "legacy", "")
	if err != nil || pc2.API != "openai-completions" {
		t.Fatalf("legacy directory should default to chat: %#v, %v", pc2, err)
	}
}

func TestGatewayNativeHistoryRoundTripPreservesProviderData(t *testing.T) {
	skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1", Protocols: []string{"openai-completions"}}})
	f.Chat = func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path == "/v1/chat/completions" {
			writeSSEToolCall(w, "call_native_1", "exec", `{"cmd":"echo hi"}`)
			return true
		}
		return false
	}
	pc, _, err := f.Store.providerConfig(context.Background(), "m1", "")
	if err != nil {
		t.Fatal(err)
	}
	resp, err := complete(context.Background(), pc, agentRequestForTest("do it"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Message.ToolCalls) != 1 || len(resp.Message.ToolCalls[0].ProviderData) == 0 {
		t.Fatalf("provider did not return a native tool call: %#v", resp.Message)
	}
	// 原生载体跨轮重放必须保真（id/name/arguments 不丢）。
	hist := []chatMsg{
		{Role: "user", Content: "do it", Native: nativeUserMessage("do it", nil)},
		{Role: "assistant", Native: &resp.Message, ToolCalls: toolCallsFromMessage(resp.Message)},
		{Role: "tool", ToolCallID: "call_native_1", Name: "exec", Content: "hi",
			Native: agentMessageForTest("call_native_1", "exec", "hi")},
	}
	msgs, err := buildAgentMessages("openai-completions", hist)
	if err != nil {
		t.Fatal(err)
	}
	before := len(f.chatBodies())
	if _, err := complete(context.Background(), pc, agentRequestWithMessages(msgs), nil); err != nil {
		t.Fatal(err)
	}
	bodies := f.chatBodies()
	if len(bodies) != before+1 {
		t.Fatalf("expected one more model call, got %d", len(bodies)-before)
	}
	replay := string(bodies[len(bodies)-1])
	for _, want := range []string{"call_native_1", "exec", "echo hi", "hi"} {
		if !strings.Contains(replay, want) {
			t.Fatalf("native history replay lost %q: %s", want, replay)
		}
	}
	// 缺原生载体的旧历史在非 chat 协议下必须报错，不得捏造 origin 重放。
	if _, err := buildAgentMessages("anthropic-messages", []chatMsg{{Role: "assistant", Content: "legacy"}}); !errors.Is(err, errLegacyHistoryProtocol) {
		t.Fatalf("legacy history accepted under a foreign protocol: %v", err)
	}
}

func TestGatewayOfflineAndCancelDoNotBecomeSuccess(t *testing.T) {
	skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	store := f.Store
	pc, _, err := store.providerConfig(context.Background(), "m1", "")
	if err != nil {
		t.Fatal(err)
	}
	// 取消：即使请求未发出，也必须返回 context.Canceled。
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := complete(ctx, pc, agentRequestForTest("x"), nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled request did not surface context.Canceled: %v", err)
	}
	// 离线：目录抓取失败不得变成空成功，且不得泄露令牌/URL。
	f.Server.Close()
	if _, _, err := store.providerConfig(context.Background(), "m1", ""); err == nil {
		t.Fatal("offline gateway resolved a model")
	} else if strings.Contains(err.Error(), gwTestSecret) || strings.Contains(err.Error(), f.Server.URL) {
		t.Fatalf("offline error leaked details: %v", err)
	}
}

// 测试小助手：直接构造真实的 agent 请求/消息。
func agentRequestForTest(prompt string) agent.Request {
	return agent.Request{System: "sys", Messages: []agent.Message{agent.TextMessage("user", prompt)}}
}

func agentRequestWithMessages(msgs []agent.Message) agent.Request {
	return agent.Request{System: "sys", Messages: msgs}
}

func agentMessageForTest(id, name, text string) *agent.Message {
	return &agent.Message{Role: "tool", ToolCallID: id, ToolName: name, Content: []agent.Content{{Type: "text", Text: text}}}
}

func TestGatewayProxyStripsHostCredentialsFromQuery(t *testing.T) {
	skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	f.Chat = func(w http.ResponseWriter, r *http.Request) bool {
		w.Header().Set("X-Fixture-Query", r.URL.RawQuery)
		_, _ = io.WriteString(w, "ok")
		return true
	}
	srv := gatewayProxyHub(t, f)
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/chat/completions?token=tk&key=client-secret&api_key=k2&access_token=a3&alt=sse&api-version=2024-01-01", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("authorized fixture rejected: %d", res.StatusCode)
	}
	if got := res.Header.Get("X-Fixture-Query"); got != "alt=sse&api-version=2024-01-01" {
		t.Fatalf("host credentials crossed gateway boundary: %q", got)
	}
}

func TestGatewayProxyRefusesUpstreamRedirectAndCookies(t *testing.T) {
	skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	f.Chat = func(w http.ResponseWriter, r *http.Request) bool {
		w.Header().Set("Location", "https://evil.example/steal?t="+gwTestSecret)
		w.Header().Add("Set-Cookie", "hwses=from-gateway; Path=/")
		w.WriteHeader(http.StatusFound)
		return true
	}
	srv := gatewayProxyHub(t, f)
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer tk")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode < 400 {
		t.Fatalf("upstream redirect became success: %d", res.StatusCode)
	}
	if res.Header.Get("Location") != "" || res.Header.Get("Set-Cookie") != "" {
		t.Fatalf("redirect/cookie leaked to browser: location=%q cookie=%q", res.Header.Get("Location"), res.Header.Get("Set-Cookie"))
	}
	if strings.Contains(string(body), gwTestSecret) || strings.Contains(string(body), "evil.example") {
		t.Fatalf("redirect details leaked: %s", body)
	}
}
