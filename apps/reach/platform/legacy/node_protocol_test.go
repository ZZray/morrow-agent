package main

// node 协议接线的真实链路：node provider → Hub 授权门 → 真实共享网关（随机端口上的
// gateway.Server）→ fake native upstream。覆盖七协议目录/路径/认证边界、grant 缺失与
// 刷新一次、目录与 Complete 的取消、partial 流不重放、协议歧义与显式选择、会话按
// (model, protocol) 绑定与切换。
//
// 断言发生在两个边界上：
//   - node → Hub：请求路径必须是 Hub 代理放行的路径，Authorization 只带本次 model-grant，
//     绝没有 x-api-key / x-goog-api-key / api-key 这些 raw 凭据；
//   - Hub → 网关 → 上游：网关按协议注入上游自己的 key（node 与 Hub 都不持有它）。
//
// 这里不复制网关实现：网关用公开的 gateway.NewServer 起在回环随机端口，测试结束关闭。

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"ara/internal/agent"
	"ara/internal/gateway"
	"ara/internal/providers"
)

const nodeProtocolServiceToken = "node-gateway-service-token"

// nodeProtocolModel 把一个逻辑模型绑到一个协议的 fake 上游。
type nodeProtocolModel struct {
	model    string
	protocol string
	upstream string
}

// nodeUpstreamFixture 是某协议的 fake native upstream：记录请求并按协议回一个完整流。
type nodeUpstreamFixture struct {
	protocol string
	Server   *httptest.Server

	mu     sync.Mutex
	reqs   []gwRecorded
	handle func(w http.ResponseWriter, r *http.Request) bool // 返回 true 表示已处理
	block  bool
}

func newNodeUpstreamFixture(t *testing.T, protocol string) *nodeUpstreamFixture {
	t.Helper()
	u := &nodeUpstreamFixture{protocol: protocol}
	u.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 8<<20))
		u.mu.Lock()
		u.reqs = append(u.reqs, gwRecorded{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery,
			Auth: r.Header.Get("Authorization"), Header: r.Header.Clone(), Body: body})
		handle, block := u.handle, u.block
		u.mu.Unlock()
		if handle != nil && handle(w, r) {
			return
		}
		if block {
			<-r.Context().Done()
			return
		}
		writeNodeProtocolStream(w, protocol)
	}))
	t.Cleanup(u.Server.Close)
	return u
}

func (u *nodeUpstreamFixture) snapshot() []gwRecorded {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]gwRecorded(nil), u.reqs...)
}

func (u *nodeUpstreamFixture) calls() int { return len(u.snapshot()) }

// bodiesFor 返回命中指定模型 id 的请求体（上游是网关按模型路由的，多个模型共用一个夹具）。
func (u *nodeUpstreamFixture) bodiesFor(model string) []string {
	var out []string
	for _, r := range u.snapshot() {
		if strings.Contains(string(r.Body), `"model":"`+model+`"`) {
			out = append(out, string(r.Body))
		}
	}
	return out
}

func (u *nodeUpstreamFixture) setHandle(fn func(w http.ResponseWriter, r *http.Request) bool) {
	u.mu.Lock()
	u.handle = fn
	u.mu.Unlock()
}

// writeNodeProtocolStream 按协议写一条最小的、语义完整的流。终止事件必须存在，
// 否则 providers 会把「没有终止」当成失败。
func writeNodeProtocolStream(w http.ResponseWriter, protocol string) {
	switch protocol {
	case providers.OllamaChat:
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "{\"message\":{\"role\":\"assistant\",\"content\":\"ollama-ok\"},\"done\":false}\n")
		fmt.Fprint(w, "{\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true}\n")
	case providers.GoogleGenerativeAI:
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"gemini-ok\"}]},\"finishReason\":\"STOP\"}]}\n\n")
	case providers.AnthropicMessages:
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "data: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"role\":\"assistant\",\"content\":[]}}\n\n")
		fmt.Fprint(w, "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n")
		fmt.Fprint(w, "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"anthropic-ok\"}}\n\n")
		fmt.Fprint(w, "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n")
		fmt.Fprint(w, "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n")
		fmt.Fprint(w, "data: {\"type\":\"message_stop\"}\n\n")
	case providers.OpenAIResponses, providers.AzureOpenAIResponses:
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\n")
		fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"responses-ok\"}\n\n")
		fmt.Fprint(w, "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"responses-ok\"}]}}\n\n")
		fmt.Fprint(w, "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"responses-ok\"}]}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n")
	default: // openai-completions / openrouter-chat
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"chat-ok\"}}]}\n\n")
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}
}

func nodeProtocolExpectedText(protocol string) string {
	switch protocol {
	case providers.OllamaChat:
		return "ollama-ok"
	case providers.GoogleGenerativeAI:
		return "gemini-ok"
	case providers.AnthropicMessages:
		return "anthropic-ok"
	case providers.OpenAIResponses, providers.AzureOpenAIResponses:
		return "responses-ok"
	default:
		return "chat-ok"
	}
}

// nodeHubRecord 是 node 打到 Hub 的一个请求（授权门之前）。
type nodeHubRecord struct {
	Path   string
	Query  string
	Header http.Header
}

// nodeProtocolHarness 把三层接起来：真实共享网关（随机端口）→ 真实 Hub → node provider。
type nodeProtocolHarness struct {
	Gateway *httptest.Server
	Hub     *httptest.Server
	hubSrv  *hubSrv

	mu      sync.Mutex
	nodeHit []nodeHubRecord
	// beforeModel 在授权门之前被调用（目录请求除外）：夹具用它模拟授权门的一次拒绝。
	beforeModel func(w http.ResponseWriter, r *http.Request) bool

	ups map[string]*nodeUpstreamFixture

	resolveCalls int
}

// newNodeProtocolHarness 起真实网关（七个协议各一个上游，外加一个多协议模型），
// 再把真实 Hub 指向它。deadGatewayRoot 非空时 Hub 指向一个不可达的网关。
func newNodeProtocolHarness(t *testing.T, deadGatewayRoot string) *nodeProtocolHarness {
	t.Helper()
	return newNodeProtocolHarnessWith(t, nodeHarnessOptions{deadGatewayRoot: deadGatewayRoot,
		defaultModel: "multi-model", defaultProtocol: providers.AnthropicMessages})
}

// nodeHarnessOptions 描述 Hub 保存的网关配置。defaultModel 为空表示 Hub 没有保存默认模型
// （也没有配置网关）：grant 里就没有默认元数据，用来验证缺默认时的可操作错误。
type nodeHarnessOptions struct {
	deadGatewayRoot string
	defaultModel    string
	defaultProtocol string
	smartModel      string
	smartProtocol   string
}

func newNodeProtocolHarnessWith(t *testing.T, opts nodeHarnessOptions) *nodeProtocolHarness {
	t.Helper()
	t.Setenv("HW_CONF", t.TempDir())
	t.Setenv("HW_GATEWAY_TOKEN", nodeProtocolServiceToken)
	deadGatewayRoot := opts.deadGatewayRoot

	h := &nodeProtocolHarness{ups: map[string]*nodeUpstreamFixture{}}
	models := []nodeProtocolModel{
		{model: "default-model", protocol: providers.OpenAICompletions},
		{model: "chat-model", protocol: providers.OpenAICompletions},
		{model: "responses-model", protocol: providers.OpenAIResponses},
		{model: "anthropic-model", protocol: providers.AnthropicMessages},
		{model: "gemini-model", protocol: providers.GoogleGenerativeAI},
		{model: "ollama-model", protocol: providers.OllamaChat},
		{model: "azure-model", protocol: providers.AzureOpenAIResponses},
		{model: "openrouter-model", protocol: providers.OpenRouterChat},
		// 同一 model id 由 chat 与 anthropic 两个上游提供：目录里它是多协议模型。
		{model: "multi-model", protocol: providers.OpenAICompletions},
		{model: "multi-model", protocol: providers.AnthropicMessages},
		// Same model and same wire, but distinct concrete protocols/candidates.
		{model: "same-wire-model", protocol: providers.OpenAICompletions},
		{model: "same-wire-model", protocol: providers.OpenRouterChat},
	}
	upstreams := map[string]*gateway.Upstream{}
	for _, m := range models {
		id := "up-" + m.protocol
		up, ok := h.ups[id]
		if !ok {
			up = newNodeUpstreamFixture(t, m.protocol)
			h.ups[id] = up
		}
		u, ok := upstreams[id]
		if !ok {
			// 上游 base_url 的约定与生产一致：chat 家族带 /v1（网关会去掉客户端路径的
			// /v1 前缀再拼到 base 上），Gemini/Ollama 的 base 不带协议前缀。
			base := up.Server.URL
			if m.protocol != providers.GoogleGenerativeAI && m.protocol != providers.OllamaChat {
				base += "/v1"
			}
			u = &gateway.Upstream{
				BaseURL:  base,
				Protocol: m.protocol,
				Models:   map[string]*gateway.ModelMeta{},
			}
			if m.protocol == providers.OllamaChat {
				// 本机 Ollama 没有 key：必须显式声明 no-auth，而不是用 dummy key 假装。
				u.Auth = gateway.AuthNone
			} else {
				u.Keys = []string{"up-" + m.protocol}
			}
			upstreams[id] = u
		}
		u.Models[m.model] = &gateway.ModelMeta{Name: m.model, ContextWindow: 128000, MaxTokens: 8192,
			Input: []string{"text"}, SupportsTools: boolPtr(true), TaskTier: 3}
	}

	if deadGatewayRoot == "" && opts.defaultModel != "" {
		token := gateway.Token{ID: "svc", Key: nodeProtocolServiceToken}
		if opts.smartModel != "" {
			token.AllowedPools = []string{"smart-test"}
		}
		cfg := &gateway.Config{
			Listen:    freeLoopbackAddr(t),
			Auth:      gateway.AuthConfig{Tokens: []gateway.Token{token}},
			LB:        "round_robin",
			Sticky:    "none",
			Upstreams: upstreams,
		}
		if opts.smartModel != "" {
			candidate := "up-" + opts.smartProtocol + "/" + opts.smartModel + "@" + opts.smartProtocol
			cfg.Auto = gateway.AutoConfig{Mode: gateway.AutoModePolicy, DefaultPool: "smart-test"}
			cfg.Pools = map[string]*gateway.PoolConfig{"smart-test": {Members: []gateway.PoolMemberConfig{{
				Upstream: "up-" + opts.smartProtocol, Model: opts.smartModel, Protocol: opts.smartProtocol,
			}}}}
			cfg.Routing = gateway.RoutingConfig{PolicyVersion: "node-smart-test-v1", Fallback: []string{candidate}}
		}
		if err := cfg.Normalize(); err != nil {
			t.Fatal(err)
		}
		srv := gateway.NewServer(cfg, func(string, ...any) {})
		go func() { _ = srv.ListenAndServe() }()
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = srv.Shutdown(ctx)
		})
		waitGatewayReady(t, cfg.Listen)
		gatewayURL, err := url.Parse("http://" + cfg.Listen)
		if err != nil {
			t.Fatal(err)
		}
		proxy := httputil.NewSingleHostReverseProxy(gatewayURL)
		h.Gateway = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/v1/route/resolve" {
				h.mu.Lock()
				h.resolveCalls++
				h.mu.Unlock()
			}
			proxy.ServeHTTP(w, r)
		}))
		t.Cleanup(h.Gateway.Close)
		deadGatewayRoot = h.Gateway.URL
	}

	if opts.defaultModel != "" || opts.defaultProtocol != "" {
		writeGatewayConfig(t, gatewayConfig{Root: deadGatewayRoot, DefaultModel: opts.defaultModel,
			DefaultProtocol: opts.defaultProtocol, AllowLoopback: true,
			SmartPool: func() string {
				if opts.smartModel != "" {
					return "smart-test"
				}
				return ""
			}()})
	}
	hub, err := newHubSrv("test-root", "test-node", gatewayConfig{}, "")
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	hub.routes(mux)
	h.hubSrv = hub
	h.Hub = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		h.nodeHit = append(h.nodeHit, nodeHubRecord{Path: r.URL.EscapedPath(), Query: r.URL.RawQuery, Header: r.Header.Clone()})
		before := h.beforeModel
		h.mu.Unlock()
		if before != nil && r.URL.EscapedPath() != "/v1/models" && before(w, r) {
			return
		}
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(h.Hub.Close)
	return h
}

func (h *nodeProtocolHarness) smartResolveCalls() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.resolveCalls
}

func boolPtr(v bool) *bool { return &v }

func freeLoopbackAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	_ = l.Close()
	return addr
}

// waitGatewayReady 等到真实网关开始接受连接：ListenAndServe 用公开接口绑定随机端口，
// 这里只做连通性等待，不复制网关实现。
func waitGatewayReady(t *testing.T, addr string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("the shared gateway never accepted connections on %s", addr)
}

func (h *nodeProtocolHarness) nodeHits() []nodeHubRecord {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]nodeHubRecord(nil), h.nodeHit...)
}

// grant 往真实授权簿里放一个本次执行的 model-grant（Hub 的授权门就是按它校验的）。
// setBeforeModel 安装「授权门之前的」夹具钩子。
func (h *nodeProtocolHarness) setBeforeModel(fn func(w http.ResponseWriter, r *http.Request) bool) {
	h.mu.Lock()
	h.beforeModel = fn
	h.mu.Unlock()
}

func (h *nodeProtocolHarness) grant(t *testing.T, code string) {
	t.Helper()
	h.hubSrv.grants().put(code, &modelGrant{FP: "fp-node", RunID: "run-1", Exp: time.Now().Add(time.Minute)})
}

func (h *nodeProtocolHarness) agent(t *testing.T) *nodeAgent {
	t.Helper()
	return &nodeAgent{
		conf:         map[string]string{"hub": h.Hub.URL},
		id:           &identity{FP: "fp-node"},
		runs:         map[string]context.CancelFunc{},
		tasks:        map[string]context.CancelFunc{},
		quit:         make(chan struct{}),
		grantWaiters: map[string]chan modelGrantReply{},
	}
}

func (h *nodeProtocolHarness) complete(t *testing.T, a *nodeAgent, model, protocol, code string, refresh func(context.Context) (string, error)) (string, *hostProvider, error) {
	t.Helper()
	p, err := a.newNodeProvider(context.Background(), "run-1", model, protocol, code, "", "", 0, refresh, nil)
	if err != nil {
		return "", nil, err
	}
	resp, err := p.Complete(context.Background(), agent.Request{Model: model}, func(agent.Event) {})
	if err != nil {
		return "", p, err
	}
	return resp.Message.Text(), p, nil
}

// 七协议：目录 → 明确 protocol → Hub 授权门 → 网关 → 协议自己的上游。
func TestNodeGatewaySpeaksSevenProtocols(t *testing.T) {
	h := newNodeProtocolHarness(t, "")
	h.grant(t, "grant-7")

	cases := []struct {
		model    string
		protocol string
		// node → Hub 的路径（Hub 代理放行的形状）
		hubPath string
		// 上游看到的路径与查询
		upPath  string
		upQuery string
	}{
		{"chat-model", providers.OpenAICompletions, "/v1/chat/completions", "/v1/chat/completions", ""},
		{"responses-model", providers.OpenAIResponses, "/v1/responses", "/v1/responses", ""},
		{"anthropic-model", providers.AnthropicMessages, "/v1/messages", "/v1/messages", ""},
		{"gemini-model", providers.GoogleGenerativeAI, "/v1/gemini/models/gemini-model:streamGenerateContent", "/v1beta/models/gemini-model:streamGenerateContent", "alt=sse"},
		{"ollama-model", providers.OllamaChat, "/v1/ollama/api/chat", "/api/chat", ""},
		{"azure-model", providers.AzureOpenAIResponses, "/v1/responses", "/v1/responses", "api-version=v1"},
		{"openrouter-model", providers.OpenRouterChat, "/v1/chat/completions", "/v1/chat/completions", ""},
	}
	for _, tc := range cases {
		t.Run(tc.protocol, func(t *testing.T) {
			a := h.agent(t)
			text, _, err := h.complete(t, a, tc.model, tc.protocol, "grant-7", nil)
			if err != nil {
				t.Fatalf("%s: %v", tc.protocol, err)
			}
			if want := nodeProtocolExpectedText(tc.protocol); text != want {
				t.Fatalf("%s: text=%q want %q", tc.protocol, text, want)
			}
			// node → Hub：只带 model-grant，且只打 Hub 放行的路径。
			hits := h.nodeHits()
			last := hits[len(hits)-1]
			if last.Path != tc.hubPath {
				t.Fatalf("%s: node hit %s want %s", tc.protocol, last.Path, tc.hubPath)
			}
			if got := last.Header.Get("Authorization"); got != "Bearer grant-7" {
				t.Fatalf("%s: node authorization=%q", tc.protocol, got)
			}
			for _, raw := range nodeRawCredentialHeaders {
				if v := last.Header.Get(raw); v != "" {
					t.Fatalf("%s: node leaked raw credential %s=%q to the hub", tc.protocol, raw, v)
				}
			}
			// Hub → 网关 → 上游：网关按协议注入上游自己的 key。
			up := h.ups["up-"+tc.protocol]
			reqs := up.snapshot()
			if len(reqs) != 1 {
				t.Fatalf("%s: upstream calls=%d", tc.protocol, len(reqs))
			}
			got := reqs[0]
			if got.Path != tc.upPath {
				t.Fatalf("%s: upstream path=%s want %s", tc.protocol, got.Path, tc.upPath)
			}
			if tc.upQuery != "" && got.Query != tc.upQuery {
				t.Fatalf("%s: upstream query=%q want %q", tc.protocol, got.Query, tc.upQuery)
			}
			wantKey := "up-" + tc.protocol
			switch tc.protocol {
			case providers.OllamaChat:
				if got.Auth != "" || got.Header.Get("x-api-key") != "" || got.Header.Get("x-goog-api-key") != "" {
					t.Fatalf("ollama upstream must be called without credentials: %+v", got.Header)
				}
			case providers.AnthropicMessages:
				if got.Header.Get("x-api-key") != wantKey {
					t.Fatalf("anthropic upstream key=%q", got.Header.Get("x-api-key"))
				}
			case providers.GoogleGenerativeAI:
				if got.Header.Get("x-goog-api-key") != wantKey {
					t.Fatalf("gemini upstream key=%q", got.Header.Get("x-goog-api-key"))
				}
			case providers.AzureOpenAIResponses:
				if got.Header.Get("api-key") != wantKey {
					t.Fatalf("azure upstream key=%q", got.Header.Get("api-key"))
				}
			default:
				if got.Auth != "Bearer "+wantKey {
					t.Fatalf("%s upstream authorization=%q", tc.protocol, got.Auth)
				}
			}
			// 网关服务令牌绝不来自 node：node 只用 model-grant。
			if strings.Contains(fmt.Sprint(got.Header), nodeProtocolServiceToken) {
				t.Fatalf("%s: the node forwarded the gateway service token", tc.protocol)
			}
		})
	}
}

// 目录多协议且没有显式选择：拒绝，且绝不自动回退到 chat；显式选择才放行。
func TestNodeGatewayRejectsAmbiguousProtocol(t *testing.T) {
	h := newNodeProtocolHarness(t, "")
	h.grant(t, "grant-amb")

	a := h.agent(t)
	if _, err := a.newNodeProvider(context.Background(), "run-1", "multi-model", "", "grant-amb", "", "", 0, nil, nil); err == nil {
		t.Fatal("a multi-protocol model without an explicit protocol must be rejected")
	} else if !strings.Contains(err.Error(), "protocol") {
		t.Fatalf("the rejection must name the protocol problem: %v", err)
	}
	if len(h.ups["up-"+providers.OpenAICompletions].snapshot()) != 0 {
		t.Fatal("an ambiguous selection must not reach any upstream")
	}
	// 显式选择 anthropic：只命中 anthropic 上游，chat 上游一个请求都不该有。
	text, p, err := h.complete(t, a, "multi-model", providers.AnthropicMessages, "grant-amb", nil)
	if err != nil {
		t.Fatal(err)
	}
	if p.protocol() != providers.AnthropicMessages || text != "anthropic-ok" {
		t.Fatalf("explicit protocol selection failed: %q %q", p.protocol(), text)
	}
	chatCalls := 0
	for _, r := range h.ups["up-"+providers.OpenAICompletions].snapshot() {
		if strings.HasSuffix(r.Path, "/v1/chat/completions") {
			chatCalls++
		}
	}
	if chatCalls != 0 {
		t.Fatalf("an anthropic selection must not be sent to the chat upstream: %d", chatCalls)
	}
}

// 目录多协议、但已有会话记录了协议：续接沿用它，不要求调用方重复选择。
func TestNodeGatewayResumesRecordedProtocol(t *testing.T) {
	h := newNodeProtocolHarness(t, "")
	h.grant(t, "grant-resume")
	a := h.agent(t)
	sess := a.hostSession()

	if hint := sess.sessionProtocolHint("multi-model"); hint != "" {
		t.Fatalf("a new session must not be pre-bound to a protocol: %q", hint)
	}
	if _, _, err := sess.sessionBinding("multi-model", providers.AnthropicMessages); err != nil {
		t.Fatal(err)
	}
	if err := sess.setNativeID("sess-multi"); err != nil {
		t.Fatal(err)
	}
	if hint := sess.sessionProtocolHint("multi-model"); hint != providers.AnthropicMessages {
		t.Fatalf("the recorded protocol must be resumed: %q", hint)
	}
	// 续接：同一个 (model, protocol) 复用同一个会话。
	id, switched, err := sess.sessionBinding("multi-model", providers.AnthropicMessages)
	if err != nil || switched != "" || id != "sess-multi" {
		t.Fatalf("resume must keep the session: id=%q switched=%q err=%v", id, switched, err)
	}
	// 显式换协议：开新会话并保留前驱，绝不把 anthropic 历史接到 chat 上。
	id, switched, err = sess.sessionBinding("multi-model", providers.OpenAICompletions)
	if err != nil {
		t.Fatal(err)
	}
	if id != "" || switched != "sess-multi" {
		t.Fatalf("a protocol switch must start a new session: id=%q switched=%q", id, switched)
	}
	if got := sess.state.PrevSessionID; got != "sess-multi" {
		t.Fatalf("the previous session must be recorded: %q", got)
	}
	if got := sess.state.Protocol; got != providers.OpenAICompletions {
		t.Fatalf("the new binding must be recorded: %q", got)
	}
	// 换协议后本回合会创建新会话；之后续接必须沿用新协议。
	if err := sess.setNativeID("sess-multi-chat"); err != nil {
		t.Fatal(err)
	}
	if hint := sess.sessionProtocolHint("multi-model"); hint != providers.OpenAICompletions {
		t.Fatalf("hint must follow the new binding: %q", hint)
	}
	if id, switched, err := sess.sessionBinding("multi-model", providers.OpenAICompletions); err != nil || switched != "" || id != "sess-multi-chat" {
		t.Fatalf("the new protocol's session must resume: id=%q switched=%q err=%v", id, switched, err)
	}
	_ = h
}

// 旧宿主状态（没有 protocol 字段）对应的会话是本变更之前的 chat 会话：按 chat 续接。
func TestNodeGatewayLegacySessionKeepsChatProtocol(t *testing.T) {
	a := newTestNodeAgent(t)
	sess := a.hostSession()
	sess.mu.Lock()
	sess.state.Model = "legacy-model"
	sess.state.NativeSessionID = "sess-legacy"
	sess.state.Protocol = ""
	sess.mu.Unlock()
	if hint := sess.sessionProtocolHint("legacy-model"); hint != providers.OpenAICompletions {
		t.Fatalf("a legacy session must keep its chat protocol: %q", hint)
	}
	id, switched, err := sess.sessionBinding("legacy-model", providers.OpenAICompletions)
	if err != nil || switched != "" || id != "sess-legacy" {
		t.Fatalf("a legacy session must be resumed as chat: id=%q switched=%q err=%v", id, switched, err)
	}
	if got := sess.state.Protocol; got != providers.OpenAICompletions {
		t.Fatalf("the resumed legacy session must record its protocol: %q", got)
	}
}

// grant 缺失：Hub 授权门拒绝，node 不会拿到目录，也不会回退到别的模型。
func TestNodeGatewayRejectsMissingGrant(t *testing.T) {
	h := newNodeProtocolHarness(t, "")
	a := h.agent(t)
	if _, err := a.newNodeProvider(context.Background(), "run-1", "chat-model", providers.OpenAICompletions, "", "", "", 0, nil, nil); err == nil {
		t.Fatal("a missing model grant must be rejected by the hub gate")
	}
	if n := len(h.ups["up-"+providers.OpenAICompletions].snapshot()); n != 0 {
		t.Fatalf("no upstream request may happen without a grant: %d", n)
	}
}

// 目录 401：只续签一次，然后用新码把整条链路跑通。
func TestNodeGatewayRefreshesGrantOnceForDirectory(t *testing.T) {
	h := newNodeProtocolHarness(t, "")
	h.grant(t, "grant-good")
	a := h.agent(t)
	refreshes := 0
	text, _, err := h.complete(t, a, "chat-model", providers.OpenAICompletions, "grant-stale", func(context.Context) (string, error) {
		refreshes++
		return "grant-good", nil
	})
	if err != nil {
		t.Fatalf("a stale grant must be refreshed once: %v", err)
	}
	if text != "chat-ok" {
		t.Fatalf("text=%q", text)
	}
	if refreshes != 1 {
		t.Fatalf("refresh must happen exactly once: %d", refreshes)
	}
	// 目录与模型请求都必须带上续签后的码。
	grants := map[string]bool{}
	for _, hit := range h.nodeHits() {
		grants[hit.Header.Get("Authorization")] = true
	}
	if !grants["Bearer grant-good"] {
		t.Fatalf("the refreshed grant must be used for the directory and the model call: %v", grants)
	}
}

// 网关不可达（Hub 代理失败）：目录请求失败，回合可见地失败，不静默回退。
func TestNodeGatewayDirectoryFailsWhenGatewayUnreachable(t *testing.T) {
	dead := "http://" + freeLoopbackAddr(t)
	h := newNodeProtocolHarness(t, dead)
	h.grant(t, "grant-dead")
	a := h.agent(t)
	if _, err := a.newNodeProvider(context.Background(), "run-1", "chat-model", providers.OpenAICompletions, "grant-dead", "", "", 0, nil, nil); err == nil {
		t.Fatal("an unreachable gateway must fail the directory read")
	}
}

// 取消：目录请求与模型请求都必须保持取消，而不是变成成功或超时。
func TestNodeGatewayCancellationStaysCancellation(t *testing.T) {
	h := newNodeProtocolHarness(t, "")
	h.grant(t, "grant-cancel")
	a := h.agent(t)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := a.newNodeProvider(ctx, "run-1", "chat-model", providers.OpenAICompletions, "grant-cancel", "", "", 0, nil, nil); err == nil {
		t.Fatal("a canceled directory read must not succeed")
	} else if !strings.Contains(err.Error(), "canceled") {
		t.Fatalf("the directory cancellation must stay a cancellation: %v", err)
	}

	// 模型请求：上游挂起，客户端取消。
	up := h.ups["up-"+providers.OpenAICompletions]
	up.mu.Lock()
	up.block = true
	up.mu.Unlock()
	p, err := a.newNodeProvider(context.Background(), "run-1", "chat-model", providers.OpenAICompletions, "grant-cancel", "", "", 0, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	runCtx, runCancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		runCancel()
	}()
	if _, err := p.Complete(runCtx, agent.Request{Model: "chat-model"}, func(agent.Event) {}); err == nil {
		t.Fatal("a canceled model call must not report success")
	} else if !strings.Contains(err.Error(), "context canceled") {
		t.Fatalf("the model cancellation must stay a cancellation: %v", err)
	}
}

// partial 流：已经流出过内容就不再续签、不重放，失败如实返回。
func TestNodeGatewayDoesNotReplayPartialStream(t *testing.T) {
	h := newNodeProtocolHarness(t, "")
	h.grant(t, "grant-partial")
	a := h.agent(t)
	up := h.ups["up-"+providers.OpenAICompletions]
	up.setHandle(func(w http.ResponseWriter, r *http.Request) bool {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n")
		fmt.Fprint(w, "data: {\"error\":{\"message\":\"stream broke\"}}\n\n")
		return true
	})
	p, err := a.newNodeProvider(context.Background(), "run-1", "chat-model", providers.OpenAICompletions, "grant-partial", "", "", 0, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	refreshes := 0
	p.refresh = func(context.Context) (string, error) {
		refreshes++
		return "grant-partial", nil
	}
	var streamed bool
	_, err = p.Complete(context.Background(), agent.Request{Model: "chat-model"}, func(e agent.Event) {
		if e.Type == "text_delta" {
			streamed = true
		}
	})
	if err == nil {
		t.Fatal("a broken stream must not become success")
	}
	if !streamed {
		t.Fatal("the partial delta must reach the caller")
	}
	if refreshes != 0 {
		t.Fatalf("a partial stream must never trigger a grant refresh: %d", refreshes)
	}
	if n := up.calls(); n != 1 {
		t.Fatalf("output must never be replayed: %d calls", n)
	}
}

// 鉴权失败发生在任何输出之前（401）：只续签一次并重试一次。
func TestNodeGatewayRefreshesGrantOnceOnUnauthorized(t *testing.T) {
	h := newNodeProtocolHarness(t, "")
	h.grant(t, "grant-good")
	h.grant(t, "grant-2")
	a := h.agent(t)
	// 授权门（Hub）在第一个模型请求上返回 401 一次：这正是「输出之前的鉴权失败」。
	// 用授权门而不是上游 401，是因为上游 401 会让网关把上游 key 置为冷却，测不到 node 的重试。
	var mu sync.Mutex
	rejected := 0
	h.setBeforeModel(func(w http.ResponseWriter, r *http.Request) bool {
		mu.Lock()
		rejected++
		n := rejected
		mu.Unlock()
		if n > 1 {
			return false
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":"unauthorized"}`)
		return true
	})
	p, err := a.newNodeProvider(context.Background(), "run-1", "chat-model", providers.OpenAICompletions, "grant-good", "", "", 0, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	refreshes := 0
	p.refresh = func(context.Context) (string, error) {
		refreshes++
		return "grant-2", nil
	}
	resp, err := p.Complete(context.Background(), agent.Request{Model: "chat-model"}, func(agent.Event) {})
	if err != nil {
		t.Fatalf("a 401 before any output must be retried once: %v", err)
	}
	if resp.Message.Text() != "chat-ok" {
		t.Fatalf("text=%q", resp.Message.Text())
	}
	if refreshes != 1 {
		t.Fatalf("refresh must happen exactly once: %d", refreshes)
	}
	mu.Lock()
	rejects := rejected
	mu.Unlock()
	if rejects != 2 {
		t.Fatalf("the gate must see the rejected call and its single retry: %d", rejects)
	}
	// 重试用的是续签后的码，而且只多打了一次。
	var modelAuth []string
	for _, hit := range h.nodeHits() {
		if hit.Path == "/v1/chat/completions" {
			modelAuth = append(modelAuth, hit.Header.Get("Authorization"))
		}
	}
	if len(modelAuth) != 2 || modelAuth[0] != "Bearer grant-good" || modelAuth[1] != "Bearer grant-2" {
		t.Fatalf("model request authorizations=%q", modelAuth)
	}
	if n := h.ups["up-"+providers.OpenAICompletions].calls(); n != 1 {
		t.Fatalf("only the retried request may reach the gateway: %d", n)
	}
}

// node 侧路径映射：Hub root 的路径前缀必须保留，未放行的原生路径直接拒绝。
func TestNodeGatewayPathMapping(t *testing.T) {
	if got, ok := mapNodeGatewayPath("/v1beta/models/a%2Fb:streamGenerateContent"); !ok || got != "/v1/gemini/models/a%2Fb:streamGenerateContent" {
		t.Fatalf("gemini path=%q ok=%t", got, ok)
	}
	if got, ok := mapNodeGatewayPath("/api/chat"); !ok || got != "/v1/ollama/api/chat" {
		t.Fatalf("ollama path=%q ok=%t", got, ok)
	}
	if _, ok := mapNodeGatewayPath("/v1/admin/upstreams"); ok {
		t.Fatal("the node must not be able to reach gateway admin paths")
	}
	grant := newNodeGrant("grant-prefix")
	client := nodeGatewayClient("https://hub.example/hub", grant)
	tr := client.Transport.(*nodeGatewayTransport)
	if tr.prefix != "/hub" {
		t.Fatalf("prefix=%q", tr.prefix)
	}
	req, err := http.NewRequest(http.MethodPost, "https://hub.example/hub/v1beta/models/m:streamGenerateContent?alt=sse", nil)
	if err != nil {
		t.Fatal(err)
	}
	rec := &recordingRoundTripper{}
	tr.base = rec
	if _, err := tr.RoundTrip(req); err != nil {
		t.Fatal(err)
	}
	if rec.path != "/hub/v1/gemini/models/m:streamGenerateContent" || rec.query != "alt=sse" {
		t.Fatalf("root prefix must be preserved: %q %q", rec.path, rec.query)
	}
	if rec.auth != "Bearer grant-prefix" {
		t.Fatalf("auth=%q", rec.auth)
	}
}

type recordingRoundTripper struct {
	path, query, auth string
}

func (r *recordingRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	r.path, r.query, r.auth = req.URL.EscapedPath(), req.URL.RawQuery, req.Header.Get("Authorization")
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}}, nil
}

// 目录解码失败（网关目录形状非法）必须报错，而不是当成空目录。
func TestNodeGatewayRejectsBrokenDirectory(t *testing.T) {
	h := newNodeProtocolHarness(t, "")
	h.grant(t, "grant-broken")
	a := h.agent(t)
	// 让 Hub 目录返回一个空目录：gatewayclient 必须报错，node 必须失败。
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"data":[]}`)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(broken.Close)
	a.conf["hub"] = broken.URL
	if _, err := a.newNodeProvider(context.Background(), "run-1", "chat-model", providers.OpenAICompletions, "grant-broken", "", "", 0, nil, nil); err == nil {
		t.Fatal("an empty gateway directory must be an error")
	}
}

// ---- 真实入口 fixtures：runLocalAgent → 真实 WS grant 签发 → Hub 授权门 → 共享网关 ----
//
// 这些用例从 runLocalAgent 入口走完整链路：grant 由真实 Hub 的 issueModelGrant/wsSend
// 经真实 WS 下发（conn 的 model-grant 事件），不手工构造 grant 回复。

// approveNode 记录设备的授权状态（不是 grant 本身）：真实 Hub 只对已授权且在线的设备签发
// model-grant。签发与信令全部走真实 issueModelGrant/wsSend/conn。
func nodeProtocolFixtureIdentity(label string) *identity {
	seed := sha256.Sum256([]byte("handwave-node-protocol-fixture-v1\x00" + label))
	key := ed25519.NewKeyFromSeed(seed[:])
	pub := key.Public().(ed25519.PublicKey)
	return &identity{FP: fpOf(pub), pub: pub, priv: key}
}
func nodeProtocolFixtureFP(label string) string { return nodeProtocolFixtureIdentity(label).FP }

func (h *nodeProtocolHarness) approveNode(label string) {
	id := nodeProtocolFixtureIdentity(label)
	fp := id.FP
	h.hubSrv.mu.Lock()
	h.hubSrv.approvals[fp] = &approval{CtlFP: "ctl-test", Exp: time.Now().Add(time.Hour), NodePublicKey: base64.StdEncoding.EncodeToString(id.pub)}
	h.hubSrv.mu.Unlock()
}

// connectNode 把 nodeAgent 用真实 WS 接到真实 Hub：join 信令 + model-grant 事件投递。
func (h *nodeProtocolHarness) connectNode(t *testing.T, a *nodeAgent, label string) *conn {
	t.Helper()
	cn := newConn("ws"+strings.TrimPrefix(h.Hub.URL, "http")+"/ws?role=node", "test-node", true)
	cn.rel = true
	a.id = nodeProtocolFixtureIdentity(label)
	fp := a.id.FP
	cn.nodeIdentity = a.id
	if err := cn.dial(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cn.close)
	a.cmu.Lock()
	a.cn = cn
	a.cmu.Unlock()
	select {
	case joined := <-cn.ev:
		if joined.Ctrl != "node-joined" || string(joined.Msg) != fp {
			t.Fatalf("device identity handshake failed: %+v", joined)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("device identity handshake timed out")
	}
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	go func() {
		for {
			select {
			case e := <-cn.ev:
				if e.Ctrl == "model-grant" {
					a.deliverModelGrant(e)
				}
			case <-stop:
				return
			}
		}
	}()
	return cn
}

// runTurn 走真实入口跑一回合，等到 runLocalAgent 返回（回合结束：完成/失败/回合前拒绝），
// 再读任务板：回合内失败会留下终态任务，回合在创建任务之前被拒绝时没有任务。
func (h *nodeProtocolHarness) runTurn(t *testing.T, a *nodeAgent, cn *conn, runID, msg, model, protocol string) hostTask {
	t.Helper()
	sess := a.hostSession()
	done := make(chan struct{})
	go func() {
		defer close(done)
		a.runLocalAgent(cn, &dcf{K: "agent-loop", ID: runID, Msg: msg, Model: model, Protocol: protocol})
	}()
	select {
	case <-done:
	case <-time.After(60 * time.Second):
		t.Fatalf("run %s never finished", runID)
	}
	// 按目标标题找本回合任务（任务板 id 在宿主重启后从 1 重新计数，会覆盖同名旧项，
	// 所以不能按数量或下标判定）。
	title := clipText(msg, 80)
	for _, task := range sess.tasks() {
		if task.Kind == "turn" && task.Title == title {
			return task
		}
	}
	return hostTask{}
}

// 模型/协议选择的优先级：缺默认是可操作错误；显式 > 续接记录 > 默认模型的默认协议。
func TestNodeModelProtocolSelection(t *testing.T) {
	if _, err := resolveFrameModel("default", ""); err == nil || !strings.Contains(err.Error(), "default model") {
		t.Fatalf("a missing default must be an actionable error: %v", err)
	}
	if _, err := resolveFrameModel("", ""); err == nil {
		t.Fatal("an empty selection without a hub default must fail")
	}
	for _, frame := range []string{"", "default"} {
		if m, err := resolveFrameModel(frame, "multi-model"); err != nil || m != "multi-model" {
			t.Fatalf("frame %q must resolve to the hub default: %q %v", frame, m, err)
		}
	}
	if m, err := resolveFrameModel("chat-model", "multi-model"); err != nil || m != "chat-model" {
		t.Fatalf("an explicit model must be kept: %q %v", m, err)
	}
	cases := []struct {
		explicit, hint, def string
		isDefault           bool
		want                string
	}{
		{providers.AnthropicMessages, providers.OpenAICompletions, providers.OpenAICompletions, true, providers.AnthropicMessages},
		{"", providers.OpenAICompletions, providers.AnthropicMessages, true, providers.OpenAICompletions},
		{"", "", providers.AnthropicMessages, true, providers.AnthropicMessages},
		{"", "", providers.AnthropicMessages, false, ""},
		{"", "", "", false, ""},
	}
	for _, tc := range cases {
		if got := resolveFrameProtocol(tc.explicit, tc.hint, tc.def, tc.isDefault); got != tc.want {
			t.Fatalf("explicit=%q hint=%q default=%q isDefault=%t → %q want %q",
				tc.explicit, tc.hint, tc.def, tc.isDefault, got, tc.want)
		}
	}
	// 信令字段必须真的序列化并往返：Hub→node 的默认元数据靠这些 json tag。
	raw := mustJSON(&sig{K: "model-grant", ID: "r1", D: "code", DefaultModel: "multi-model", DefaultProtocol: providers.AnthropicMessages})
	if !strings.Contains(raw, `"default_model":"multi-model"`) || !strings.Contains(raw, `"default_protocol":"anthropic-messages"`) {
		t.Fatalf("the model-grant signal must carry the defaults: %s", raw)
	}
	var back sig
	if err := json.Unmarshal([]byte(raw), &back); err != nil || back.DefaultModel != "multi-model" || back.DefaultProtocol != providers.AnthropicMessages {
		t.Fatalf("the model-grant signal must round-trip: %+v %v", back, err)
	}
}

// 真实入口：目录里没有字面 default，只有真实 id。空/default 由 Hub 随 grant 下发的默认
// 模型/协议解析，(model, protocol) 一起决定会话身份。
func TestNodeRunLocalAgentEntryResolvesModelAndProtocol(t *testing.T) {
	h := newNodeProtocolHarness(t, "")
	h.approveNode("fp-entry")
	a := h.agent(t)
	cn := h.connectNode(t, a, "fp-entry")
	sess := a.hostSession()

	// (a) Auto：帧里是哨兵 default、协议为空。目录里没有 default，所以这次成功本身就证明
	// 默认模型与默认协议是经真实 WS grant 元数据解析出来的（multi-model 有两个协议，
	// 没有默认协议会被歧义拒绝）。
	if task := h.runTurn(t, a, cn, "run-auto", "auto goal", "default", ""); task.Status != "completed" {
		t.Fatalf("auto run must complete: %+v", task)
	}
	if sess.state.Model != "multi-model" || sess.state.Protocol != providers.AnthropicMessages {
		t.Fatalf("the hub default must be resolved and recorded: %q/%q", sess.state.Model, sess.state.Protocol)
	}
	autoSession := sess.state.NativeSessionID
	if autoSession == "" {
		t.Fatal("the auto run must persist a native session")
	}
	anthUp := h.ups["up-"+providers.AnthropicMessages]
	if n := anthUp.calls(); n != 1 {
		t.Fatalf("the default protocol must route to the anthropic upstream: %d", n)
	}
	if got := anthUp.bodiesFor("multi-model"); len(got) != 1 || !strings.Contains(got[0], "auto goal") {
		t.Fatalf("the resolved model must be sent upstream: %v", got)
	}
	if n := h.ups["up-"+providers.OpenAICompletions].calls(); n != 0 {
		t.Fatalf("the default protocol must not fall back to chat: %d", n)
	}

	// (b) 同一个模型显式换协议：开新会话并保留前驱，绝不跨协议复用。
	if task := h.runTurn(t, a, cn, "run-switch", "switch goal", "multi-model", providers.OpenAICompletions); task.Status != "completed" {
		t.Fatalf("the explicit protocol run must complete: %+v", task)
	}
	if sess.state.Protocol != providers.OpenAICompletions || sess.state.NativeSessionID == autoSession || sess.state.NativeSessionID == "" {
		t.Fatalf("a protocol switch must start a new session: %q %q", sess.state.Protocol, sess.state.NativeSessionID)
	}
	if sess.state.PrevSessionID != autoSession {
		t.Fatalf("the previous session must be kept: %q", sess.state.PrevSessionID)
	}
	chatSession := sess.state.NativeSessionID

	// (c) 同模型同协议（帧里不带协议）：续接记录里的协议，而不是回落到默认协议。
	if task := h.runTurn(t, a, cn, "run-resume", "resume goal", "multi-model", ""); task.Status != "completed" {
		t.Fatalf("the resume run must complete: %+v", task)
	}
	if sess.state.NativeSessionID != chatSession || sess.state.Protocol != providers.OpenAICompletions {
		t.Fatalf("the recorded protocol must be resumed: %q/%q", sess.state.NativeSessionID, sess.state.Protocol)
	}
	chatUp := h.ups["up-"+providers.OpenAICompletions]
	if got := chatUp.bodiesFor("multi-model"); len(got) != 2 || !strings.Contains(got[1], "switch goal") || !strings.Contains(got[1], "resume goal") {
		t.Fatalf("the resumed session must carry its history: %v", got)
	}

	// (d) 显式选择别的模型且不带协议：默认协议绝不套用到它（否则目录会以协议不匹配拒绝）。
	if task := h.runTurn(t, a, cn, "run-other", "other model goal", "chat-model", ""); task.Status != "completed" {
		t.Fatalf("an explicit other model must not inherit the default protocol: %+v", task)
	}
	if sess.state.Model != "chat-model" || sess.state.NativeSessionID == chatSession {
		t.Fatalf("a model switch must start a new session: %q", sess.state.NativeSessionID)
	}
	otherSession := sess.state.NativeSessionID

	// (e) 重启（新 nodeAgent，同一 conf 目录）后同模型同协议：续接同一个原生会话。
	a2 := h.agent(t)
	cn2 := h.connectNode(t, a2, "fp-entry")
	sess2 := a2.hostSession()
	if sess2.state.NativeSessionID != otherSession {
		t.Fatalf("the restart must reload the same binding: %q", sess2.state.NativeSessionID)
	}
	if task := h.runTurn(t, a2, cn2, "run-restart", "after restart", "chat-model", ""); task.Status != "completed" {
		t.Fatalf("the resumed run must complete: %+v", task)
	}
	if sess2.state.NativeSessionID != otherSession {
		t.Fatalf("a restart must resume the same native session: %q -> %q", otherSession, sess2.state.NativeSessionID)
	}
	bodies := chatUp.bodiesFor("chat-model")
	last := bodies[len(bodies)-1]
	if !strings.Contains(last, "other model goal") || !strings.Contains(last, "after restart") {
		t.Fatalf("the resumed session must carry the earlier turn across the restart: %s", last)
	}
}

// 缺默认：帧里是 default 而 Hub 没有保存默认模型（也没有配置网关）→ 可操作错误，不建会话、
// 不触达任何上游。
func TestNodeRunLocalAgentEntryFailsWithoutDefaultModel(t *testing.T) {
	h := newNodeProtocolHarnessWith(t, nodeHarnessOptions{})
	h.approveNode("fp-entry")
	a := h.agent(t)
	cn := h.connectNode(t, a, "fp-entry")
	if task := h.runTurn(t, a, cn, "run-nodefault", "goal", "default", ""); task.Status != "" {
		t.Fatalf("a rejected turn must not open a turn task: %+v", task)
	}
	if id := a.hostSession().state.NativeSessionID; id != "" {
		t.Fatalf("a missing default must not create a session: %q", id)
	}
	if n := h.ups["up-"+providers.OpenAICompletions].calls(); n != 0 {
		t.Fatalf("no upstream call may happen without a model: %d", n)
	}
}
