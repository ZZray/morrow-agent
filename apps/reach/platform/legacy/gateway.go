package main

// Hub 网关客户端：Hub 只持有共享网关的 root、服务令牌环境变量名、显式默认
// model/protocol 以及 SSRF 策略。模型目录与协议解析复用 internal/gatewayclient，
// 模型请求复用 internal/providers。Hub 不再读取 OMP 配置，也不再自建第二套
// HTTP/SSE 解析或供应商路由。
//
// 令牌只来自环境变量（默认 HW_GATEWAY_TOKEN），永不落盘、永不返回给浏览器、
// 永不写日志。旧的 cloud-model.json / upstreams.conf 只被检测并提示迁移，原文件
// 字节保持不变，也不会被自动当作网关使用。

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"sort"

	"ara/internal/agent"
	"ara/internal/gatewayclient"
	"ara/internal/providers"
	"ara/internal/taskrouting"
)

const (
	gatewayConfigFile       = "gateway.json"
	gatewayProviderName     = "handwave-gateway"
	defaultGatewayTokenEnv  = "HW_GATEWAY_TOKEN"
	maxGatewayConfigJSON    = 32 << 10
	maxSkillPrompt          = 8 << 10
	skillDraftMaxTokens     = 6000
	gatewayDirectoryTimeout = 15 * time.Second
	gatewayTestTimeout      = 120 * time.Second
)

var (
	errCloudInvalid       = errors.New("invalid gateway configuration")
	errCloudNotConfigured = errors.New("gateway is not configured")
	errCloudUnsafeTarget  = errors.New("gateway target is not allowed")
	errCloudUnavailable   = errors.New("gateway is unavailable")
	errCloudOutput        = errors.New("gateway model returned an invalid skill draft")
	// errCloudModelSelection 是目录成功后、模型/协议选择失败时的窄 sentinel。
	// 它只在 providerConfig 中由 gatewayclient.Config 的失败映射而来，与目录
	// 鉴权/连接失败（errCloudUnavailable）严格区分，并携带固定的、可操作且无
	// 凭据的文案：核对模型 ID，多协议时显式选择协议。
	errCloudModelSelection = errors.New("invalid gateway model selection: check the model id and select one protocol explicitly when the model offers more than one")
)

// gatewayConfig is the whole Hub model configuration. It never holds a token
// value, only the name of the environment variable that carries it.
type gatewayConfig struct {
	Root            string `json:"gateway_root,omitempty"`
	TokenEnv        string `json:"gateway_token_env,omitempty"`
	DefaultModel    string `json:"default_model,omitempty"`
	DefaultProtocol string `json:"default_protocol,omitempty"`
	AllowLoopback   bool   `json:"allow_loopback,omitempty"`
	// SmartPool 是智能选型使用的模型池名。它是服务端侧的授权约束，只能由配置
	// 给出；浏览器请求不得指定池、预算或权限。
	SmartPool string `json:"smart_pool,omitempty"`
}

// gatewayModelOption is one entry of the public catalog returned to the UI.
type gatewayModelOption struct {
	ID        string   `json:"id"`
	Protocols []string `json:"protocols,omitempty"`
	Name      string   `json:"name,omitempty"`
}

// gatewayPublic is the credential-free view the model-config REST API returns.
type gatewayPublic struct {
	Root            string               `json:"gateway_root"`
	TokenEnv        string               `json:"gateway_token_env"`
	DefaultModel    string               `json:"default_model"`
	DefaultProtocol string               `json:"default_protocol,omitempty"`
	AllowLoopback   bool                 `json:"allow_loopback"`
	HasToken        bool                 `json:"has_token"`
	Configured      bool                 `json:"configured"`
	Models          []gatewayModelOption `json:"models"`
	Migration       []string             `json:"migration,omitempty"`
	CatalogError    string               `json:"catalog_error,omitempty"`
}

type gatewayStore struct {
	mu       sync.RWMutex
	saveMu   sync.Mutex
	path     string
	cfg      gatewayConfig
	legacy   []string
	lookupIP func(context.Context, string) ([]net.IPAddr, error)
}

func newGatewayStore() (*gatewayStore, error) {
	s := &gatewayStore{
		path: filepath.Join(confDir(), gatewayConfigFile),
		lookupIP: func(ctx context.Context, host string) ([]net.IPAddr, error) {
			return net.DefaultResolver.LookupIPAddr(ctx, host)
		},
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	s.legacy = detectLegacyModelConfig()
	return s, nil
}

func (s *gatewayStore) load() error {
	st, err := os.Lstat(s.path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() || st.Size() > maxGatewayConfigJSON {
		return fmt.Errorf("invalid gateway configuration file")
	}
	b, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}
	var cfg gatewayConfig
	if err := decodeStrictJSON(b, &cfg); err != nil {
		return fmt.Errorf("invalid gateway configuration file")
	}
	normalized, err := normalizeGatewayConfig(cfg)
	if err != nil {
		return fmt.Errorf("invalid gateway configuration file")
	}
	// 持久加载与 PUT/CLI 使用同一 HTTPS/SSRF/allow_loopback 策略：明文公网目标
	// 在启动时就失败关闭，绝不把令牌经明文发出。
	if normalized.Root != "" {
		if err := validateGatewayTargetStatic(normalized.Root, normalized.AllowLoopback); err != nil {
			return fmt.Errorf("gateway configuration target is not allowed: %w", errCloudUnsafeTarget)
		}
	}
	if err := restrictFileAccess(s.path); err != nil {
		return fmt.Errorf("secure gateway configuration: %w", err)
	}
	s.cfg = normalized
	return nil
}

func (s *gatewayStore) snapshot() gatewayConfig {
	if s == nil {
		return gatewayConfig{}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg
}

// applyOverrides merges CLI-provided values over the persisted configuration.
// Only non-empty fields win; the result is validated but not persisted.
func (s *gatewayStore) applyOverrides(_ context.Context, over gatewayConfig) error {
	if over.Root == "" && over.TokenEnv == "" && over.DefaultModel == "" && over.DefaultProtocol == "" && !over.AllowLoopback {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.cfg
	if over.Root != "" {
		next.Root = over.Root
	}
	if over.TokenEnv != "" {
		next.TokenEnv = over.TokenEnv
	}
	if over.DefaultModel != "" {
		next.DefaultModel = over.DefaultModel
	}
	if over.DefaultProtocol != "" {
		next.DefaultProtocol = over.DefaultProtocol
	}
	if over.AllowLoopback {
		next.AllowLoopback = true
	}
	normalized, err := normalizeGatewayConfig(next)
	if err != nil {
		return err
	}
	if normalized.Root != "" {
		if err := validateGatewayTargetStatic(normalized.Root, normalized.AllowLoopback); err != nil {
			return err
		}
	}
	s.cfg = normalized
	return nil
}

// normalizeGatewayConfig validates the configuration and applies defaults.
// An empty configuration (no root) is valid and means "gateway not configured".
func normalizeGatewayConfig(cfg gatewayConfig) (gatewayConfig, error) {
	cfg.Root = strings.TrimSpace(cfg.Root)
	cfg.TokenEnv = strings.TrimSpace(cfg.TokenEnv)
	cfg.DefaultModel = strings.TrimSpace(cfg.DefaultModel)
	cfg.DefaultProtocol = strings.ToLower(strings.TrimSpace(cfg.DefaultProtocol))
	if cfg.Root == "" {
		if cfg.DefaultModel != "" || cfg.TokenEnv != "" || cfg.DefaultProtocol != "" {
			return gatewayConfig{}, errCloudInvalid
		}
		return cfg, nil
	}
	if cfg.DefaultModel == "" || len(cfg.DefaultModel) > 256 || !utf8.ValidString(cfg.DefaultModel) || strings.ContainsAny(cfg.DefaultModel, "\r\n") {
		return gatewayConfig{}, errCloudInvalid
	}
	if cfg.TokenEnv != "" && !validEnvName(cfg.TokenEnv) {
		return gatewayConfig{}, errCloudInvalid
	}
	if cfg.DefaultProtocol != "" && !isKnownProtocol(cfg.DefaultProtocol) {
		return gatewayConfig{}, errCloudInvalid
	}
	u, err := url.Parse(cfg.Root)
	if err != nil || u.Opaque != "" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" ||
		(u.Scheme != "https" && u.Scheme != "http") {
		return gatewayConfig{}, errCloudInvalid
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return gatewayConfig{}, errCloudInvalid
		}
	}
	u.Path = strings.TrimRight(u.Path, "/")
	cfg.Root = u.String()
	return cfg, nil
}

func validEnvName(name string) bool {
	for i, r := range name {
		ok := r == '_' || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (i > 0 && r >= '0' && r <= '9')
		if !ok {
			return false
		}
	}
	return name != ""
}

func isKnownProtocol(p string) bool {
	switch p {
	case providers.OpenAICompletions, providers.OpenAIResponses, providers.AnthropicMessages,
		providers.GoogleGenerativeAI, providers.OllamaChat, providers.AzureOpenAIResponses, providers.OpenRouterChat:
		return true
	}
	return false
}

func effectiveTokenEnv(cfg gatewayConfig) string {
	if cfg.TokenEnv != "" {
		return cfg.TokenEnv
	}
	return defaultGatewayTokenEnv
}

func gatewayToken(cfg gatewayConfig) string {
	return strings.TrimSpace(os.Getenv(effectiveTokenEnv(cfg)))
}

// client builds the shared directory client. The injected HTTP client keeps the
// Hub SSRF policy (DNS resolution, dial restrictions, redirect refusal) so the
// directory request obeys the same boundary as a model request.
func (s *gatewayStore) client(cfg gatewayConfig) (*gatewayclient.Client, error) {
	if s == nil || cfg.Root == "" {
		return nil, errCloudNotConfigured
	}
	return &gatewayclient.Client{
		BaseURL:    cfg.Root,
		Token:      gatewayToken(cfg),
		HTTPClient: s.httpClient(cfg),
	}, nil
}

// providerConfig resolves one logical model to a providers.Config through the
// gateway directory. protocol may be empty only when the model advertises a
// single protocol; an ambiguous or missing protocol is an error, never a silent
// fallback. The gateway token is placed in memory only.
func (s *gatewayStore) providerConfig(ctx context.Context, model, protocol string) (providers.Config, []gatewayclient.Model, error) {
	if s == nil {
		return providers.Config{}, nil, errCloudNotConfigured
	}
	cfg := s.snapshot()
	if cfg.Root == "" {
		return providers.Config{}, nil, errCloudNotConfigured
	}
	cl, err := s.client(cfg)
	if err != nil {
		return providers.Config{}, nil, err
	}
	catalog, err := cl.Models(ctx)
	if err != nil {
		// 目录阶段的鉴权/连接/传输失败属于“不可用”，保留取消与超时的可判别性，
		// 其余统一归为 errCloudUnavailable；绝不与后续的模型/协议选择错误混淆。
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return providers.Config{}, nil, err
		}
		return providers.Config{}, nil, fmt.Errorf("%w", errCloudUnavailable)
	}
	modelID := strings.TrimSpace(model)
	if modelID == "" || modelID == "default" {
		modelID = cfg.DefaultModel
	}
	proto := strings.ToLower(strings.TrimSpace(protocol))
	if proto == "" && modelID == cfg.DefaultModel {
		proto = cfg.DefaultProtocol
	}
	pc, err := cl.Config(gatewayProviderName, modelID, proto, catalog)
	if err != nil {
		// 目录已成功，这里的失败只可能来自模型/协议选择（未知模型、缺省或歧义
		// 协议）。映射为窄 sentinel，向调用方给出固定、可操作、无凭据的配置错误，
		// 不回显内部错误文本（可能含模型 ID 或网关细节）。
		return providers.Config{}, catalog, errCloudModelSelection
	}
	return pc, catalog, nil
}

// ---- 智能选型：共享契约每会话解析一次，身份与决策一起固定 ----

const (
	smartContextTokenBound = 32000
	smartMaxOutputTokens   = 4096
	smartQualityFloor      = 2
)

// errSmartPoolMissing 是「未配置模型池」的固定原因。它既不是目录故障也不是凭据
// 问题，不能混进 errCloudUnavailable 让调用方以为网关挂了。
var errSmartPoolMissing = errors.New("smart selection is not configured: set smart_pool in the gateway configuration")

// resolveRouteOnce 按共享 v1 契约解析一次选型。池取自网关配置，任务摘要与工具
// 标记取自本次请求；浏览器不能指定池、预算或权限。
func (s *gatewayStore) resolveRouteOnce(ctx context.Context, requestID, summary string, requiresTools bool) (gatewayclient.ResolveResult, error) {
	var empty gatewayclient.ResolveResult
	if s == nil {
		return empty, errCloudNotConfigured
	}
	cfg := s.snapshot()
	if cfg.Root == "" {
		return empty, errCloudNotConfigured
	}
	pool := strings.TrimSpace(cfg.SmartPool)
	if pool == "" {
		return empty, errSmartPoolMissing
	}
	cl, err := s.client(cfg)
	if err != nil {
		return empty, err
	}
	// 允许协议取本次目录实际声明的并集：不复制一份硬编码协议清单，也不放宽成「任意」。
	catalog, err := cl.Models(ctx)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return empty, err
		}
		return empty, fmt.Errorf("%w", errCloudUnavailable)
	}
	allowed, err := catalogProtocols(catalog)
	if err != nil {
		return empty, err
	}
	payload, err := taskrouting.EncodeRequest(taskrouting.Request{
		Version:   taskrouting.Version,
		RequestID: requestID,
		Task:      taskrouting.Task{Summary: summary},
		Requirements: taskrouting.Requirements{
			Modalities:              []string{"text"},
			AllowedProtocols:        allowed,
			RequiresTools:           requiresTools,
			ContextTokensUpperBound: smartContextTokenBound,
			MaxOutputTokens:         smartMaxOutputTokens,
			QualityFloor:            smartQualityFloor,
		},
		Selection: taskrouting.Selection{Mode: taskrouting.ModeAuto, Pool: pool, Strategy: taskrouting.StrategyBalanced},
	})
	if err != nil {
		return empty, fmt.Errorf("%w: %v", errCloudInvalid, err)
	}
	return cl.ResolveRoute(ctx, payload)
}

// catalogProtocols 汇总目录里声明的协议（去重、排序）。一份空目录不能支撑智能
// 选型，宁可明确失败也不放宽约束。
func catalogProtocols(catalog []gatewayclient.Model) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	for _, m := range catalog {
		for _, p := range m.Protocols {
			p = strings.TrimSpace(p)
			if p == "" || !gatewayclient.SupportsProtocol(p) || seen[p] {
				continue
			}
			seen[p] = true
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%w: 目录没有声明任何可用协议", errCloudUnavailable)
	}
	sort.Strings(out)
	return out, nil
}

// smartProviderConfig 把请求钉在决策上并带上关联头。目录解析结果与决策不一致时
// 直接报错，不用目录值悄悄改写决策。
func (s *gatewayStore) smartProviderConfig(ctx context.Context, dec gatewayclient.RouteDecision) (providers.Config, error) {
	pc, _, err := s.providerConfig(ctx, dec.Model, dec.Protocol)
	if err != nil {
		return providers.Config{}, err
	}
	if pc.Model != dec.Model || pc.API != dec.Protocol {
		return providers.Config{}, fmt.Errorf("%w: 目录解析为 %s/%s，决策为 %s/%s", errCloudModelSelection, pc.Model, pc.API, dec.Model, dec.Protocol)
	}
	headers := map[string]string{}
	for k, v := range pc.Headers {
		headers[k] = v
	}
	headers[gatewayclient.RouteDecisionHeader] = dec.DecisionID
	pc.Headers = headers
	return pc, nil
}

// complete runs one providers request against a resolved configuration. The
// provider inherits the injected SSRF HTTP client, refuses redirects and never
// retries.
func complete(ctx context.Context, cfg providers.Config, req agent.Request, emit func(agent.Event)) (agent.Response, error) {
	p, err := providers.New(cfg)
	if err != nil {
		return agent.Response{}, err
	}
	if req.Model == "" {
		req.Model = cfg.Model
	}
	if emit == nil {
		emit = func(agent.Event) {}
	}
	return p.Complete(ctx, req, emit)
}

// completeDefault resolves the (possibly default) model and runs it.
func (s *gatewayStore) completeDefault(ctx context.Context, model, protocol string, req agent.Request, emit func(agent.Event)) (agent.Response, error) {
	pc, _, err := s.providerConfig(ctx, model, protocol)
	if err != nil {
		return agent.Response{}, err
	}
	return complete(ctx, pc, req, emit)
}

func (s *gatewayStore) public(ctx context.Context) gatewayPublic {
	if s == nil {
		return gatewayPublic{Models: []gatewayModelOption{}}
	}
	cfg := s.snapshot()
	pub := gatewayPublic{
		Root:            cfg.Root,
		TokenEnv:        effectiveTokenEnv(cfg),
		DefaultModel:    cfg.DefaultModel,
		DefaultProtocol: cfg.DefaultProtocol,
		AllowLoopback:   cfg.AllowLoopback,
		HasToken:        gatewayToken(cfg) != "",
		Configured:      cfg.Root != "",
		Models:          []gatewayModelOption{},
		Migration:       append([]string(nil), s.legacy...),
	}
	if cfg.Root == "" {
		return pub
	}
	cl, err := s.client(cfg)
	if err != nil {
		pub.CatalogError = "网关配置无效"
		return pub
	}
	fetchCtx, cancel := context.WithTimeout(ctx, gatewayDirectoryTimeout)
	defer cancel()
	catalog, err := cl.Models(fetchCtx)
	if err != nil {
		pub.CatalogError = gatewayCatalogError(err)
		return pub
	}
	for _, m := range catalog {
		pub.Models = append(pub.Models, gatewayModelOption{ID: m.ID, Protocols: m.Protocols, Name: m.OMP.Name})
	}
	return pub
}

// gatewayCatalogError maps a directory failure to a fixed, credential-free
// message. The token, URL and body are never echoed.
func gatewayCatalogError(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "网关目录请求被取消"
	case errors.Is(err, context.DeadlineExceeded):
		return "网关目录请求超时"
	default:
		return "网关目录不可用（详情已隐去）"
	}
}

func (s *gatewayStore) save(ctx context.Context, next gatewayConfig) error {
	normalized, err := normalizeGatewayConfig(next)
	if err != nil {
		return err
	}
	if normalized.Root != "" {
		if err := validateCloudTarget(ctx, normalized.Root, normalized.AllowLoopback, s.lookupIP); err != nil {
			return err
		}
	}
	b, err := json.MarshalIndent(normalized, "", "  ")
	if err != nil {
		return err
	}
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	if err := writeSecretAtomic(s.path, b); err != nil {
		return err
	}
	s.mu.Lock()
	s.cfg = normalized
	s.mu.Unlock()
	return nil
}

// detectLegacyModelConfig reports old Hub model configuration that must be
// migrated. It only inspects file presence and never reads the bytes into the
// runtime path, so a legacy supplier or OMP file can never become a bypass.
func detectLegacyModelConfig() []string {
	var out []string
	if legacyRegularFile(filepath.Join(confDir(), "cloud-model.json")) {
		out = append(out, "检测到旧的 cloud-model.json（OMP / 自定义直连模型）。Hub 已不再读取它；请在网关配置中填写 gateway root 与默认模型后手动删除该文件。原文件字节未被修改。")
	}
	if legacyRegularFile(filepath.Join(confDir(), "upstreams.conf")) {
		out = append(out, "检测到旧的 upstreams.conf（多供应商直连路由）。Hub 已不再读取它；请把供应商迁移到共享网关。原文件字节未被修改。")
	}
	return out
}

func legacyRegularFile(path string) bool {
	st, err := os.Lstat(path)
	return err == nil && st.Mode().IsRegular()
}

func writeSecretAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if st, err := os.Lstat(path); err == nil && !st.Mode().IsRegular() {
		return fmt.Errorf("refusing non-regular configuration file")
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	f, err := os.CreateTemp(dir, ".gateway-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := restrictFileAccess(tmp); err != nil {
		f.Close()
		return err
	}
	_, writeErr := f.Write(data)
	syncErr := f.Sync()
	closeErr := f.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	return restrictFileAccess(path)
}

func decodeStrictJSON(data []byte, dst any) error {
	if !utf8.Valid(data) {
		return errCloudInvalid
	}
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return errCloudInvalid
		}
		return err
	}
	return nil
}

func writeCloudError(w http.ResponseWriter, err error) {
	code := http.StatusInternalServerError
	message := "gateway request failed"
	switch {
	case errors.Is(err, errCloudModelSelection):
		code, message = http.StatusBadRequest, errCloudModelSelection.Error()
	case errors.Is(err, errCloudInvalid):
		code, message = http.StatusBadRequest, errCloudInvalid.Error()
	case errors.Is(err, errCloudUnsafeTarget):
		code, message = http.StatusBadRequest, errCloudUnsafeTarget.Error()
	case errors.Is(err, errCloudNotConfigured):
		code, message = http.StatusConflict, errCloudNotConfigured.Error()
	case errors.Is(err, errCloudUnavailable):
		code, message = http.StatusBadGateway, errCloudUnavailable.Error()
	case errors.Is(err, errCloudOutput):
		code, message = http.StatusBadGateway, errCloudOutput.Error()
	case errors.Is(err, context.DeadlineExceeded):
		code, message = http.StatusGatewayTimeout, "gateway request timed out"
	}
	writeJSON(w, code, map[string]string{"error": message})
}

func decodeCloudJSON(w http.ResponseWriter, r *http.Request, dst any, limit int64) error {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil || decodeStrictJSON(b, dst) != nil {
		return errCloudInvalid
	}
	return nil
}

func mustURLHost(raw string) string {
	u, _ := url.Parse(raw)
	return u.Hostname()
}

// ---- SSRF 网络边界（保存与每次连接都解析并校验；重定向始终拒绝）----

func resolveCloudHost(ctx context.Context, host string, lookup func(context.Context, string) ([]net.IPAddr, error)) ([]net.IPAddr, error) {
	if ip := net.ParseIP(host); ip != nil {
		return []net.IPAddr{{IP: ip}}, nil
	}
	addrs, err := lookup(ctx, host)
	if err != nil || len(addrs) == 0 {
		return nil, fmt.Errorf("%w: host could not be resolved", errCloudUnavailable)
	}
	return addrs, nil
}

// validateGatewayTargetStatic 只做不需要 DNS 的静态策略：URL 形状、协议，以及
// 主机为字面 IP 时的 allow_loopback 判定。启动/CLI 用它，避免临时 DNS 故障阻断
// 整个 Hub（设备/无模型业务仍可启动）；真正的 DNS 解析与 rebinding 校验仍由 PUT
// 保存与每次拨号执行，明文公网目标一律拒绝。
func validateGatewayTargetStatic(raw string, allowLoopback bool) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return errCloudInvalid
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
	default:
		return errCloudInvalid
	}
	ip := net.ParseIP(u.Hostname())
	if ip == nil {
		return fmt.Errorf("%w: HTTPS is required", errCloudUnsafeTarget)
	}
	loopback, allowed := cloudIPAllowed(ip, allowLoopback)
	if !allowed || !loopback {
		return errCloudUnsafeTarget
	}
	return nil
}

func validateCloudTarget(ctx context.Context, raw string, allowLoopback bool, lookup func(context.Context, string) ([]net.IPAddr, error)) error {
	u, err := url.Parse(raw)
	if err != nil {
		return errCloudInvalid
	}
	addrs, err := resolveCloudHost(ctx, u.Hostname(), lookup)
	if err != nil {
		return err
	}
	allLoopback := true
	for _, addr := range addrs {
		loopback, allowed := cloudIPAllowed(addr.IP, allowLoopback)
		if !allowed {
			return errCloudUnsafeTarget
		}
		allLoopback = allLoopback && loopback
	}
	if u.Scheme == "http" && !allLoopback {
		return fmt.Errorf("%w: HTTPS is required", errCloudUnsafeTarget)
	}
	return nil
}

func cloudIPAllowed(ip net.IP, allowLoopback bool) (loopback, allowed bool) {
	addr, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false, false
	}
	addr = addr.Unmap()
	if addr.IsLoopback() {
		return true, allowLoopback
	}
	if !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() || addr.IsMulticast() || addr.IsUnspecified() {
		return false, false
	}
	for _, prefix := range blockedCloudPrefixes {
		if prefix.Contains(addr) {
			return false, false
		}
	}
	return false, true
}

var blockedCloudPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("fc00::/7"),
}

func validateLoopbackProxy(addrs []net.IPAddr) error {
	if len(addrs) == 0 {
		return errCloudUnsafeTarget
	}
	for _, addr := range addrs {
		loopback, _ := cloudIPAllowed(addr.IP, true)
		if !loopback {
			return errCloudUnsafeTarget
		}
	}
	return nil
}

func (s *gatewayStore) trustedProxy(req *http.Request) (*url.URL, error) {
	proxy, err := http.ProxyFromEnvironment(req)
	if err != nil || proxy == nil {
		return proxy, err
	}
	if proxy.Scheme != "http" && proxy.Scheme != "https" || proxy.User != nil {
		return nil, errCloudUnsafeTarget
	}
	addrs, err := resolveCloudHost(req.Context(), proxy.Hostname(), s.lookupIP)
	if err != nil {
		return nil, err
	}
	if err := validateLoopbackProxy(addrs); err != nil {
		return nil, err
	}
	return proxy, nil
}

// transport builds the SSRF-restricted transport: every dial resolves and
// validates the destination, an environment proxy is only honored when it is
// credential-free and resolves entirely to loopback, and TLS is at least 1.2.
func (s *gatewayStore) transport(cfg gatewayConfig) *http.Transport {
	dialer := &net.Dialer{Timeout: 8 * time.Second, KeepAlive: 30 * time.Second}
	var proxyURL *url.URL
	if probe, err := http.NewRequest(http.MethodGet, cfg.Root, nil); err == nil {
		if proxy, perr := s.trustedProxy(probe); perr == nil {
			proxyURL = proxy
		}
	}
	var proxy func(*http.Request) (*url.URL, error)
	if proxyURL != nil {
		proxy = http.ProxyURL(proxyURL)
	}
	transport := &http.Transport{
		Proxy:                 proxy,
		ForceAttemptHTTP2:     true,
		TLSHandshakeTimeout:   8 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		IdleConnTimeout:       30 * time.Second,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
	}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, errCloudUnsafeTarget
		}
		addrs, err := resolveCloudHost(ctx, host, s.lookupIP)
		if err != nil {
			return nil, err
		}
		if proxyURL != nil {
			for _, addr := range addrs {
				loopback, _ := cloudIPAllowed(addr.IP, true)
				if !loopback {
					return nil, errCloudUnsafeTarget
				}
			}
		} else {
			for _, addr := range addrs {
				if _, allowed := cloudIPAllowed(addr.IP, cfg.AllowLoopback); !allowed {
					return nil, errCloudUnsafeTarget
				}
			}
		}
		var lastErr error
		for _, addr := range addrs {
			conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(addr.IP.String(), port))
			if err == nil {
				return conn, nil
			}
			lastErr = err
		}
		return nil, fmt.Errorf("%w: connection failed: %v", errCloudUnavailable, lastErr)
	}
	return transport
}

// httpClient is the injected client for gatewayclient and providers. It carries
// no global timeout (the transport bounds connection and header waits), so a
// streamed model response is never cut short by the client itself.
func (s *gatewayStore) httpClient(cfg gatewayConfig) *http.Client {
	return &http.Client{
		Transport: s.transport(cfg),
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return fmt.Errorf("%w: redirects are not allowed", errCloudUnsafeTarget)
		},
	}
}

// ---- 管理动作：连接测试与 Skills 草稿 ----

func (h *hubSrv) apiCloudModel(w http.ResponseWriter, r *http.Request) {
	if h.gw == nil {
		writeCloudError(w, errCloudNotConfigured)
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, h.gw.public(r.Context()))
	case http.MethodPut:
		var body struct {
			Root            string `json:"gateway_root"`
			TokenEnv        string `json:"gateway_token_env"`
			DefaultModel    string `json:"default_model"`
			DefaultProtocol string `json:"default_protocol"`
			AllowLoopback   bool   `json:"allow_loopback"`
		}
		if err := decodeCloudJSON(w, r, &body, maxGatewayConfigJSON); err != nil {
			writeCloudError(w, err)
			return
		}
		next := gatewayConfig{
			Root:            body.Root,
			TokenEnv:        body.TokenEnv,
			DefaultModel:    body.DefaultModel,
			DefaultProtocol: body.DefaultProtocol,
			AllowLoopback:   body.AllowLoopback,
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		if err := h.gw.save(ctx, next); err != nil {
			log.Printf("gateway configuration save failed: error=%T: %v", err, err)
			writeCloudError(w, err)
			return
		}
		pub := h.gw.public(r.Context())
		log.Printf("gateway configuration save finish: host=%q model=%q protocol=%q allow_loopback=%t token_env=%q",
			mustURLHost(pub.Root), pub.DefaultModel, pub.DefaultProtocol, pub.AllowLoopback, pub.TokenEnv)
		writeJSON(w, http.StatusOK, pub)
	default:
		w.Header().Set("Allow", "GET, PUT")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (h *hubSrv) apiCloudModelTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h.gw == nil {
		writeCloudError(w, errCloudNotConfigured)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), gatewayDirectoryTimeout)
	defer cancel()
	pc, catalog, err := h.gw.providerConfig(ctx, "", "")
	if err != nil {
		writeCloudError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"models":   len(catalog),
		"model":    pc.Model,
		"protocol": pc.API,
	})
}

func (h *hubSrv) apiSkillGenerate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if h.gw == nil {
		writeCloudError(w, errCloudNotConfigured)
		return
	}
	var body struct {
		Prompt string `json:"prompt"`
	}
	if err := decodeCloudJSON(w, r, &body, maxSkillPrompt+1024); err != nil {
		writeCloudError(w, err)
		return
	}
	body.Prompt = strings.TrimSpace(body.Prompt)
	if body.Prompt == "" || !utf8.ValidString(body.Prompt) || len(body.Prompt) > maxSkillPrompt {
		writeCloudError(w, errCloudInvalid)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), gatewayTestTimeout)
	defer cancel()
	pc, _, err := h.gw.providerConfig(ctx, "", "")
	if err != nil {
		writeCloudError(w, err)
		return
	}
	system := "Create one reusable Markdown instruction skill from the user's request. Return only one JSON object with the required string fields name, description, and content. Extra metadata fields are ignored. Name must be concise. Content must be actionable Markdown instructions for an AI assistant. Do not include scripts to execute automatically and do not claim extra tool permissions."
	draft, err := h.skillDraft(ctx, pc, system, body.Prompt)
	if err != nil {
		if errors.Is(err, errCloudOutput) {
			log.Printf("gateway skill draft retry: first_output_invalid=true")
			draft, err = h.skillDraft(ctx, pc, system, body.Prompt+"\n\nThe previous response was invalid. Return a single valid JSON object now. It must contain non-empty string fields name, description, and content. Do not use a code fence or add prose outside the JSON.")
		}
	}
	if err != nil {
		writeCloudError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Content     string `json:"content"`
	}{Name: draft.Name, Description: draft.Description, Content: draft.Content})
}

func (h *hubSrv) skillDraft(ctx context.Context, pc providers.Config, system, prompt string) (*skillSnapshot, error) {
	resp, err := complete(ctx, pc, agent.Request{
		System:    system,
		Messages:  []agent.Message{agent.TextMessage("user", prompt)},
		MaxTokens: skillDraftMaxTokens,
	}, nil)
	if err != nil {
		return nil, err
	}
	return parseSkillDraft(resp.Message.Text())
}

func parseSkillDraft(content string) (*skillSnapshot, error) {
	content = strings.TrimSpace(content)
	if strings.HasPrefix(content, "```") {
		if i := strings.Index(content, "\n"); i >= 0 {
			content = content[i+1:]
		}
		content = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(content), "```"))
	}
	var raw map[string]json.RawMessage
	if err := decodeStrictJSON([]byte(content), &raw); err != nil {
		return nil, errCloudOutput
	}
	var draft struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Content     string `json:"content"`
	}
	for key, dst := range map[string]*string{
		"name": &draft.Name, "description": &draft.Description, "content": &draft.Content,
	} {
		value, ok := raw[key]
		if !ok || json.Unmarshal(value, dst) != nil {
			return nil, errCloudOutput
		}
	}
	if err := validateSkill(draft.Name, draft.Description, draft.Content); err != nil {
		return nil, errCloudOutput
	}
	return &skillSnapshot{
		skillMeta: skillMeta{Name: strings.TrimSpace(draft.Name), Description: strings.TrimSpace(draft.Description)},
		Content:   draft.Content,
	}, nil
}
