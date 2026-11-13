package main

// 网关配置 / 目录 / Skills 草稿 / SSRF / 迁移边界的聚焦测试。
// 全部走真实的 gatewayclient + providers 生产路径（离线 httptest 网关）。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const gwTestSecret = "gw-secret-must-not-leak"

func writeGatewayConfig(t *testing.T, cfg gatewayConfig) {
	t.Helper()
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(confDir(), gatewayConfigFile), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func gatewayTestRequest(t *testing.T, handler http.Handler, method, path string, body any, token string) *httptest.ResponseRecorder {
	t.Helper()
	var raw []byte
	var err error
	if body != nil {
		raw, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(raw))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestGatewayConfigAPICatalogAndSkillPreview(t *testing.T) {
	skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "deepseek-flash", Protocols: []string{"openai-completions"}}})
	writeGatewayConfig(t, gatewayConfig{Root: f.Server.URL, DefaultModel: "deepseek-flash", AllowLoopback: true})

	h, err := newHubSrv("test-root", "test-node", gatewayConfig{}, "")
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	h.routes(mux)

	// 授权门：根令牌以外（含 node 入网令牌）读不到配置。
	for _, token := range []string{"", "test-node"} {
		if w := gatewayTestRequest(t, mux, http.MethodGet, "/api/model-config", nil, token); w.Code != http.StatusUnauthorized {
			t.Fatalf("unauthorized config GET = %d", w.Code)
		}
	}

	w := gatewayTestRequest(t, mux, http.MethodGet, "/api/model-config", nil, "test-root")
	if w.Code != http.StatusOK {
		t.Fatalf("config GET = %d %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), gwTestSecret) || strings.Contains(w.Body.String(), `"api_key"`) || strings.Contains(w.Body.String(), `"gateway_token"`) {
		t.Fatal("config GET leaked a token value")
	}
	var pub gatewayPublic
	if err := json.Unmarshal(w.Body.Bytes(), &pub); err != nil {
		t.Fatal(err)
	}
	if !pub.Configured || !pub.HasToken || pub.TokenEnv != "HW_GATEWAY_TOKEN" || len(pub.Models) != 1 || pub.Models[0].ID != "deepseek-flash" {
		t.Fatalf("unexpected public config: %#v", pub)
	}

	// 目录 + 鉴权探活（不做真实模型生成）。
	w = gatewayTestRequest(t, mux, http.MethodPost, "/api/model-config/test", nil, "test-root")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"ok":true`) || !strings.Contains(w.Body.String(), `"deepseek-flash"`) {
		t.Fatalf("directory probe = %d %s", w.Code, w.Body.String())
	}

	// Skills 草稿：真实 providers 调用，只返回预览，不落库。
	f.ChatText = `{"name":"incident-review","description":"Review an incident","content":"# Instructions\n\nReview evidence before proposing fixes."}`
	w = gatewayTestRequest(t, mux, http.MethodPost, "/api/skills/generate", map[string]string{"prompt": "Create an incident review skill"}, "test-root")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"name":"incident-review"`) || strings.Contains(w.Body.String(), `"id"`) {
		t.Fatalf("skill preview = %d %s", w.Code, w.Body.String())
	}
	if list, err := listSkills(); err != nil || len(list) != 0 {
		t.Fatalf("preview persisted a skill: %#v, %v", list, err)
	}

	// 所有模型调用都必须携带网关令牌、指向默认模型、且不带业务工具。
	bodies := f.chatBodies()
	if len(bodies) == 0 {
		t.Fatal("no model request reached the gateway")
	}
	for _, body := range bodies {
		var parsed struct {
			Model string          `json:"model"`
			Tools json.RawMessage `json:"tools"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			t.Fatal(err)
		}
		if parsed.Model != "deepseek-flash" || len(parsed.Tools) != 0 {
			t.Fatalf("unexpected model request: model=%q tools=%s", parsed.Model, parsed.Tools)
		}
	}
	for _, rec := range f.snapshotRecords() {
		if rec.Path != "/v1/chat/completions" {
			continue
		}
		if rec.Auth != "Bearer "+gwTestSecret {
			t.Fatalf("model request did not carry the gateway token: %q", rec.Auth)
		}
	}
}

func TestGatewaySavePersistsNoTokenAndReloads(t *testing.T) {
	skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	h, err := newHubSrv("test-root", "test-node", gatewayConfig{}, "")
	if err != nil {
		t.Fatal(err)
	}
	handler := http.HandlerFunc(h.apiH)
	w := gatewayTestRequest(t, handler, http.MethodPut, "/api/model-config", map[string]any{
		"gateway_root": f.Server.URL, "gateway_token_env": "HW_GATEWAY_TOKEN", "default_model": "m1", "allow_loopback": true,
	}, "test-root")
	if w.Code != http.StatusOK {
		t.Fatalf("save config = %d %s", w.Code, w.Body.String())
	}
	persisted, err := os.ReadFile(filepath.Join(confDir(), gatewayConfigFile))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(persisted, []byte(gwTestSecret)) || bytes.Contains(persisted, []byte("token_value")) {
		t.Fatal("gateway token value was written to disk")
	}
	// 重新加载后配置一致，且仍不含令牌值。
	reloaded, err := newGatewayStore()
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.snapshot(); got.Root != h.gw.snapshot().Root || got.DefaultModel != "m1" {
		t.Fatalf("reloaded config mismatch: %#v", got)
	}
	if !reloaded.public(context.Background()).HasToken {
		t.Fatal("reloaded store lost the env token")
	}
}

func TestGatewayMigrationNoteForLegacyFiles(t *testing.T) {
	dir := skillTestConf(t)
	legacy := filepath.Join(dir, "cloud-model.json")
	original := []byte(`{"source":"omp","provider":"cas","model":"deepseek-flash"}`)
	if err := os.WriteFile(legacy, original, 0o600); err != nil {
		t.Fatal(err)
	}
	upstreams := filepath.Join(dir, "upstreams.conf")
	upstreamsBody := []byte("[cas]\nbase_url=https://x.invalid/v1\napi_key=secret\n")
	if err := os.WriteFile(upstreams, upstreamsBody, 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := newGatewayStore()
	if err != nil {
		t.Fatal(err)
	}
	pub := store.public(context.Background())
	if len(pub.Migration) < 2 {
		t.Fatalf("expected migration notes for legacy files: %#v", pub.Migration)
	}
	if store.snapshot().Root != "" {
		t.Fatal("legacy config was adopted as a gateway")
	}
	// 原文件字节保持不变。
	if got, _ := os.ReadFile(legacy); !bytes.Equal(got, original) {
		t.Fatal("legacy cloud-model.json was modified")
	}
	if got, _ := os.ReadFile(upstreams); !bytes.Equal(got, upstreamsBody) {
		t.Fatal("legacy upstreams.conf was modified")
	}
}

func TestGatewayCatalogErrorSurfacesSafeError(t *testing.T) {
	skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	f.Directory = func(w http.ResponseWriter, r *http.Request) bool {
		http.Error(w, "boom "+gwTestSecret, http.StatusInternalServerError)
		return true
	}
	writeGatewayConfig(t, gatewayConfig{Root: f.Server.URL, DefaultModel: "m1", AllowLoopback: true})
	h, err := newHubSrv("test-root", "test-node", gatewayConfig{}, "")
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	h.routes(mux)
	w := gatewayTestRequest(t, mux, http.MethodGet, "/api/models", nil, "test-root")
	if w.Code != http.StatusBadGateway {
		t.Fatalf("catalog failure should not become an empty 200: %d %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), gwTestSecret) || strings.Contains(w.Body.String(), f.Server.URL) {
		t.Fatal("catalog error leaked the token or URL")
	}
}

func TestGatewayRejectsUnsafeAndInvalidInputs(t *testing.T) {
	skillTestConf(t)
	store := newGatewayStoreForTest(t, "http://127.0.0.1:9999", "m")
	// 回环目标未显式开启 -> 拒绝。
	store.cfg.AllowLoopback = false
	if err := store.save(t.Context(), gatewayConfig{Root: "http://127.0.0.1:9999", DefaultModel: "m"}); !errors.Is(err, errCloudUnsafeTarget) {
		t.Fatalf("loopback without opt-in = %v", err)
	}
	store.lookupIP = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("10.0.0.8")}}, nil
	}
	if err := store.save(t.Context(), gatewayConfig{Root: "https://private.example", DefaultModel: "m"}); !errors.Is(err, errCloudUnsafeTarget) {
		t.Fatalf("private target = %v", err)
	}
	// 配置校验：多协议未显式选择时由 gatewayclient 报错；协议名必须已知。
	if _, err := normalizeGatewayConfig(gatewayConfig{Root: "https://gw.example", DefaultModel: "m", DefaultProtocol: "nope"}); !errors.Is(err, errCloudInvalid) {
		t.Fatalf("unknown protocol accepted: %v", err)
	}
	if _, err := normalizeGatewayConfig(gatewayConfig{Root: "https://user:pass@gw.example", DefaultModel: "m"}); !errors.Is(err, errCloudInvalid) {
		t.Fatalf("credentialed root accepted: %v", err)
	}
	if err := validateLoopbackProxy([]net.IPAddr{{IP: net.ParseIP("127.0.0.1")}, {IP: net.ParseIP("::1")}}); err != nil {
		t.Fatalf("loopback proxy rejected: %v", err)
	}
	if err := validateLoopbackProxy([]net.IPAddr{{IP: net.ParseIP("127.0.0.1")}, {IP: net.ParseIP("192.168.1.5")}}); !errors.Is(err, errCloudUnsafeTarget) {
		t.Fatalf("non-loopback proxy accepted: %v", err)
	}
	for _, tc := range []struct {
		raw  string
		want bool
	}{
		{`{"name":"n","description":"d","content":"c","extra":true}`, true},
		{`{"name":"n","description":"d","content":"c"} {}`, false},
		{`{"name":"","description":"d","content":"c"}`, false},
		{`{"name":"n","description":"d","content":"c","name":1}`, false},
	} {
		draft, err := parseSkillDraft(tc.raw)
		if tc.want {
			if err != nil || draft.Name != "n" || draft.Description != "d" || draft.Content != "c" {
				t.Fatalf("safe draft metadata not filtered: %#v, %v", draft, err)
			}
		} else if !errors.Is(err, errCloudOutput) {
			t.Fatalf("invalid draft accepted: %v", err)
		}
	}
}

func TestGatewayConcurrentSavesKeepDiskAndMemoryAligned(t *testing.T) {
	skillTestConf(t)
	store := newGatewayStoreForTest(t, "http://127.0.0.1:18001", "m")
	store.lookupIP = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
	}
	configs := []gatewayConfig{
		{Root: "http://127.0.0.1:18001", DefaultModel: "first", AllowLoopback: true},
		{Root: "http://127.0.0.1:18002", DefaultModel: "second", AllowLoopback: true},
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	errs := make(chan error, len(configs))
	for _, cfg := range configs {
		cfg := cfg
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			errs <- store.save(t.Context(), cfg)
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(store.path)
	if err != nil {
		t.Fatal(err)
	}
	var disk gatewayConfig
	if err := json.Unmarshal(data, &disk); err != nil {
		t.Fatal(err)
	}
	if memory := store.snapshot(); memory != disk {
		t.Fatalf("memory/disk mismatch: memory=%#v disk=%#v", memory, disk)
	}
}

func TestGatewayConfigCLIAndLoadEnforceSSRFPolicy(t *testing.T) {
	skillTestConf(t)
	public := func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("93.184.216.34")}}, nil
	}
	store := newGatewayStoreForTest(t, "http://127.0.0.1:9", "m")
	store.lookupIP = public
	// CLI：公网 HTTP 必须拒绝，令牌不得经明文发出。
	if err := store.applyOverrides(context.Background(), gatewayConfig{Root: "http://gw.example", DefaultModel: "m"}); !errors.Is(err, errCloudUnsafeTarget) {
		t.Fatalf("CLI public http override accepted: %v", err)
	}
	// 公网 HTTPS 允许。
	if err := store.applyOverrides(context.Background(), gatewayConfig{Root: "https://gw.example", DefaultModel: "m"}); err != nil {
		t.Fatalf("CLI public https override rejected: %v", err)
	}
	// 持久加载同样拒绝公网 HTTP（启动即失败关闭）。
	b, err := json.Marshal(gatewayConfig{Root: "http://gw.example", DefaultModel: "m"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store.path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	loaded := &gatewayStore{path: store.path, lookupIP: public}
	if err := loaded.load(); !errors.Is(err, errCloudUnsafeTarget) {
		t.Fatalf("persisted public http accepted: %v", err)
	}
	// 回环 + allow_loopback 仍可用（本地 httptest）。
	loop := newGatewayStoreForTest(t, "http://127.0.0.1:9", "m")
	loop.lookupIP = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
	}
	if err := loop.applyOverrides(context.Background(), gatewayConfig{Root: "http://127.0.0.1:9", DefaultModel: "m", AllowLoopback: true}); err != nil {
		t.Fatalf("loopback override rejected: %v", err)
	}
}

func TestGatewayStartupDoesNotResolveDNS(t *testing.T) {
	skillTestConf(t)
	resolved := 0
	failing := func(context.Context, string) ([]net.IPAddr, error) {
		resolved++
		return nil, errors.New("dns unavailable")
	}
	store := newGatewayStoreForTest(t, "https://gw.example", "m")
	store.lookupIP = failing
	// 启动/CLI 只做静态策略：HTTPS 域名不解析 DNS 即可通过。
	if err := store.applyOverrides(context.Background(), gatewayConfig{Root: "https://gw.example", DefaultModel: "m"}); err != nil {
		t.Fatalf("https override rejected: %v", err)
	}
	if resolved != 0 {
		t.Fatalf("startup path resolved DNS %d times", resolved)
	}
	// 持久加载同样不解析 DNS。
	b, err := json.Marshal(gatewayConfig{Root: "https://gw.example", DefaultModel: "m"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store.path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	loaded := &gatewayStore{path: store.path, lookupIP: failing}
	if err := loaded.load(); err != nil {
		t.Fatalf("load rejected https domain: %v", err)
	}
	if resolved != 0 {
		t.Fatalf("load resolved DNS %d times", resolved)
	}
	// 公网 HTTP 仍静态拒绝。
	if err := store.applyOverrides(context.Background(), gatewayConfig{Root: "http://gw.example", DefaultModel: "m"}); !errors.Is(err, errCloudUnsafeTarget) {
		t.Fatalf("public http override accepted: %v", err)
	}
	// 实际目录请求在 DNS 失败时安全失败，不泄露令牌/URL。
	loaded.cfg = gatewayConfig{Root: "https://gw.example", DefaultModel: "m"}
	if _, _, err := loaded.providerConfig(context.Background(), "m", ""); err == nil {
		t.Fatal("offline gateway resolved a model")
	} else if strings.Contains(err.Error(), gwTestSecret) || strings.Contains(err.Error(), "gw.example") {
		t.Fatalf("catalog error leaked details: %v", err)
	}
}

// TestGatewayModelConfigTestSelectionErrorsAreActionable 覆盖首次配置时的两阶段
// 反馈：目录成功后，未知模型 / 多协议未显式选择必须返回安全可操作的 4xx，正常
// 选择 200；目录鉴权或连接失败仍归为 unavailable（5xx），两个阶段不混淆。断言
// 全程不泄露网关令牌、根 URL 或内部错误文本。
func TestGatewayModelConfigTestSelectionErrorsAreActionable(t *testing.T) {
	skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)

	post := func(gw *gatewayStore) *httptest.ResponseRecorder {
		t.Helper()
		h := &hubSrv{token: "tk", dev: true, gw: gw}
		mux := http.NewServeMux()
		h.routes(mux)
		return gatewayTestRequest(t, mux, http.MethodPost, "/api/model-config/test", nil, "tk")
	}

	// 目录成功，但默认模型不在目录中 -> 可操作 4xx，不回显令牌/URL/内部文本。
	unknown := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	unknown.Store.cfg.DefaultModel = "not-in-directory"
	w := post(unknown.Store)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown model = %d %s", w.Code, w.Body.String())
	}
	assertActionableSelectionError(t, w.Body.String(), unknown.Server.URL)

	// 多协议未显式选择 -> 可操作 4xx。
	dual := newGatewayFixture(t, []gwTestModel{{ID: "dual", Protocols: []string{"openai-completions", "anthropic-messages"}}})
	dual.Store.cfg.DefaultModel = "dual"
	dual.Store.cfg.DefaultProtocol = ""
	w = post(dual.Store)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("ambiguous protocol = %d %s", w.Code, w.Body.String())
	}
	assertActionableSelectionError(t, w.Body.String(), dual.Server.URL)

	// 正常选择 -> 200。
	ok := newGatewayFixture(t, []gwTestModel{{ID: "m1", Protocols: []string{"openai-completions"}}})
	ok.Store.cfg.DefaultModel = "m1"
	w = post(ok.Store)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"ok":true`) {
		t.Fatalf("valid selection = %d %s", w.Code, w.Body.String())
	}

	// 目录鉴权失败 -> 保持 unavailable（5xx），绝不变成配置 4xx，也不泄露正文。
	denied := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	denied.Directory = func(w http.ResponseWriter, r *http.Request) bool {
		http.Error(w, "denied "+gwTestSecret, http.StatusUnauthorized)
		return true
	}
	denied.Store.cfg.DefaultModel = "m1"
	w = post(denied.Store)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("directory auth failure must stay unavailable: %d %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), gwTestSecret) || strings.Contains(w.Body.String(), denied.Server.URL) {
		t.Fatal("directory failure leaked the token or URL")
	}
}

// assertActionableSelectionError 断言选择错误的响应体安全（无令牌/URL）且可操作
// （固定文案同时点出模型与协议）。
func assertActionableSelectionError(t *testing.T, body, serverURL string) {
	t.Helper()
	if strings.Contains(body, gwTestSecret) || strings.Contains(body, serverURL) {
		t.Fatalf("selection error leaked the token or URL: %s", body)
	}
	lower := strings.ToLower(body)
	if !strings.Contains(lower, "model") || !strings.Contains(lower, "protocol") {
		t.Fatalf("selection error is not actionable: %s", body)
	}
}
