package main

// node 侧的共享网关接线。
//
// node 不持有网关服务令牌，也不自己解析模型目录：它用本次执行的短期 model-grant
// 读 Hub 的 /v1/models（复用 internal/gatewayclient），显式选出 model + protocol，
// 再把原生请求交给 providers —— 与 Hub 的 /v1 代理、共享网关同一条生产路径。
//
// 这里只做三件事：
//  1. 把 providers 生成的原生请求路径改写成 Hub 代理放行的路径
//     （Gemini /v1beta/models/... → /v1/gemini/models/...，
//     Ollama /api/chat → /v1/ollama/api/chat），并保持 Hub root 的路径前缀；
//  2. 注入唯一的 Authorization: Bearer <model-grant>，并清掉 providers 按协议自带的
//     raw 凭据（x-api-key / x-goog-api-key / api-key）。Hub 的授权门只认 Authorization
//     Bearer 或查询 token，原生 provider 的默认头不会被识别，而网关服务令牌由 Hub 注入；
//  3. 目录与模型请求共用同一个 grant 持有者，401/403 时只续签一次。

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"ara/internal/gatewayclient"
	"ara/internal/providers"
)

// nodeGrant 是本次 run 的 model-grant 持有者。它只在内存里：绝不落盘、绝不打印，
// 也绝不出现在错误信息里。
type nodeGrant struct {
	mu    sync.Mutex
	token string
	// run / binding 是本次 run 的**关联**信息：随每个请求送到 Hub，由 Hub 与 code 的可信
	// 记录比对。它们不是权限来源，也不改变归属——真正的授权事实在 Hub 侧记录里。
	run     string
	binding string
}

// setAssociation 记录本次 run 的关联信息（只在智能路径下发后设置）。
func (g *nodeGrant) setAssociation(run, binding string) {
	g.mu.Lock()
	g.run = strings.TrimSpace(run)
	g.binding = strings.TrimSpace(binding)
	g.mu.Unlock()
}

func (g *nodeGrant) association() (string, string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.run, g.binding
}

func newNodeGrant(token string) *nodeGrant {
	return &nodeGrant{token: strings.TrimSpace(token)}
}

func (g *nodeGrant) get() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.token
}

func (g *nodeGrant) set(token string) {
	g.mu.Lock()
	g.token = strings.TrimSpace(token)
	g.mu.Unlock()
}

// nodeRawCredentialHeaders 是 providers 会按协议自带的 raw 凭据头。它们只对真实厂商
// 有意义，对 Hub 的授权门无效；必须清掉，再由 transport 注入 model-grant。
var nodeRawCredentialHeaders = []string{"x-api-key", "x-goog-api-key", "api-key"}

// mapNodeGatewayPath 把 providers 的原生请求路径映射成 Hub /v1 代理放行的路径。输入是
// 转义后的路径（EscapedPath），因此 Gemini 模型段里的 %2F 不会被提前解码。未列入的
// 路径返回 false：node 绝不去打 Hub 没有放行的端点。
func mapNodeGatewayPath(escaped string) (string, bool) {
	switch escaped {
	case "/v1/models", "/v1/chat/completions", "/v1/responses", "/v1/messages":
		return escaped, true
	case "/api/chat":
		return "/v1/ollama/api/chat", true
	}
	if rest, ok := strings.CutPrefix(escaped, "/v1beta/models/"); ok && rest != "" {
		return "/v1/gemini/models/" + rest, true
	}
	return "", false
}

// nodeGatewayTransport 是注入给 gatewayclient 与 providers 的 RoundTripper：改写路径、
// 清 raw 凭据、注入 model-grant。prefix 是 Hub root 的路径前缀（例如 "/hub"），保持
// 与 Hub 的 /root-prefix 一致。
type nodeGatewayTransport struct {
	base   http.RoundTripper
	grant  *nodeGrant
	prefix string
}

func (t *nodeGatewayTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	out := req.Clone(req.Context())
	esc := out.URL.EscapedPath()
	rest := esc
	if t.prefix != "" {
		var ok bool
		rest, ok = strings.CutPrefix(esc, t.prefix)
		if !ok {
			return nil, fmt.Errorf("node gateway path is outside the hub prefix")
		}
	}
	mapped, ok := mapNodeGatewayPath(rest)
	if !ok {
		// 不回显完整路径：它可能带查询串里的凭据。这里只说明形状不合法。
		return nil, fmt.Errorf("node gateway path is not allowed by the hub proxy")
	}
	full := t.prefix + mapped
	decoded, err := url.PathUnescape(full)
	if err != nil {
		return nil, fmt.Errorf("node gateway path is not a valid escaped path")
	}
	out.URL.Path = decoded
	if decoded == full {
		out.URL.RawPath = ""
	} else {
		out.URL.RawPath = full
	}
	for _, name := range nodeRawCredentialHeaders {
		out.Header.Del(name)
	}
	if token := t.grant.get(); token != "" {
		out.Header.Set("Authorization", "Bearer "+token)
	}
	// Run/Binding 关联随请求送到 Hub：Hub 用它对照 code 的可信记录。
	// 关联缺失或错配由 Hub 拒绝；Hub 转发前会把这些宿主头剥离，不会流到上游。
	if run, binding := t.grant.association(); run != "" && binding != "" {
		out.Header.Set(smartRunHeader, run)
		out.Header.Set(smartBindingHeader, binding)
	}
	base := t.base
	if base == nil {
		base = http.DefaultTransport
	}
	return base.RoundTrip(out)
}

// nodeGatewayClient 构造只把 model-grant 送到 Hub 的 HTTP 客户端。重定向由 providers /
// gatewayclient 显式拒绝，这里不额外设置超时，避免把流式响应截断。
func nodeGatewayClient(root string, grant *nodeGrant) *http.Client {
	prefix := ""
	if u, err := url.Parse(root); err == nil {
		prefix = strings.TrimRight(u.EscapedPath(), "/")
	}
	return &http.Client{Transport: &nodeGatewayTransport{base: http.DefaultTransport, grant: grant, prefix: prefix}}
}

// nodeDirectoryAuthExpired 识别 gatewayclient 报出的 401/403。gatewayclient 只回一个
// 固定形状、无凭据的错误（"gateway directory returned HTTP <code> <text> (body withheld)"），
// 所以这里按状态码文本判定；其他错误（含取消、超时、重定向、非 2xx 的其它状态）原样返回。
func nodeDirectoryAuthExpired(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "HTTP 401 ") || strings.Contains(msg, "HTTP 403 ")
}

// autoModelSentinel 是 Web 端 Auto 选择发来的模型哨兵（见 web/app.js）。
const autoModelSentinel = "default"

// resolveFrameModel 把帧里的模型选择解析成真实模型 id：空/default 用 Hub 随 grant 下发的
// 默认模型；没有默认就是可操作错误——绝不把 "default" 当字面 id，也不回退到别的模型。
func resolveFrameModel(frameModel, defaultModel string) (string, error) {
	model := strings.TrimSpace(frameModel)
	if model != "" && model != autoModelSentinel {
		return model, nil
	}
	if def := strings.TrimSpace(defaultModel); def != "" {
		return def, nil
	}
	return "", fmt.Errorf("no model selected and the hub grant carries no default model; select a model explicitly")
}

// resolveFrameProtocol 解析本次 run 的协议：显式选择最优先，其次是续接同一模型的已有会话
// 记录（旧会话只有 chat），最后才是默认模型的默认协议。默认协议绝不套用到显式选择的其他模型。
func resolveFrameProtocol(frameProtocol, hint, defaultProtocol string, isDefaultModel bool) string {
	if p := strings.TrimSpace(frameProtocol); p != "" {
		return p
	}
	if p := strings.TrimSpace(hint); p != "" {
		return p
	}
	if !isDefaultModel {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(defaultProtocol))
}

// gatewayRoot 是 Hub 的根地址（不带 /v1）；路径前缀原样保留。
func (a *nodeAgent) gatewayRoot() string {
	return hubAPIBase(a.conf["hub"])
}

// newNodeProvider 用本次 run 的 model-grant 读取 Hub 目录，解析出明确的 model/protocol，
// 再构造宿主 provider。protocol 为空时只接受目录里恰好一个协议；多协议且没有显式选择
// 会被拒绝，绝不自动回退到 chat。目录遇到 401/403 时只续签一次，绝不重复申请。
func (a *nodeAgent) newNodeProvider(ctx context.Context, runID, model, protocol, code string,
	assocRun, assocBinding string, maxOutput int,
	refresh func(context.Context) (string, error), emit func(agentEvent)) (*hostProvider, error) {
	root := a.gatewayRoot()
	grant := newNodeGrant(code)
	// 关联只在智能路径下发：空值表示旧路径，transport 不会加关联头。
	grant.setAssociation(assocRun, assocBinding)
	cl := &gatewayclient.Client{BaseURL: root, Token: code, HTTPClient: nodeGatewayClient(root, grant)}

	catalog, err := cl.Models(ctx)
	if err != nil && nodeDirectoryAuthExpired(err) && refresh != nil {
		next, rerr := refresh(ctx)
		if rerr != nil || strings.TrimSpace(next) == "" {
			log.Printf("node gateway directory grant refresh failed: run=%s err=%v", runID, rerr)
		} else {
			grant.set(next)
			cl.Token = next
			log.Printf("node gateway directory grant refreshed: run=%s", runID)
			if emit != nil {
				e := hostEventBase("retry", "", "refreshed model grant")
				e.Output = "auth"
				emit(e)
			}
			catalog, err = cl.Models(ctx)
		}
	}
	if err != nil {
		return nil, err
	}
	cl.Token = grant.get()
	cfg, err := cl.Config(hostProviderID, model, protocol, catalog)
	if err != nil {
		return nil, err
	}
	log.Printf("node gateway model resolved: run=%s model=%s protocol=%s", runID, cfg.Model, cfg.API)
	return newHostProvider(cfg, grant, maxOutput, refresh, emit)
}

// hostAuthExpired 判断错误是否是「本次授权失效」：401/403。它既覆盖 providers 的
// HTTPError（模型请求），也覆盖 Hub 目录的授权门拒绝。
func hostAuthExpired(err error) bool {
	var he *providers.HTTPError
	if !errors.As(err, &he) {
		return false
	}
	return he.Status == http.StatusUnauthorized || he.Status == http.StatusForbidden
}
