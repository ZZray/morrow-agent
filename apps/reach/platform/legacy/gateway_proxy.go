package main

// Hub 的模型代理：把 node / 浏览器的原生模型请求透明转发到共享网关。
//
// 网关是唯一的模型核心，Hub 不再持有供应商路由、不再解析 HTTP/SSE 响应，也
// 不做第二套 retry / key 池。这里只做三件事：
//  1. 把窄白名单里的原生模型路径映射到网关路径（Gemini 与 Ollama 需要换前缀）；
//  2. 清除客户端携带的一切凭据别名，再注入网关服务令牌；
//  3. 原样透传网关响应（含 SSE），出错时返回固定、无凭据的错误。
//
// 授权门仍是 wrap(authOK || modelGrantOK)：根令牌或本次执行的短期 model-grant
// 码都能过；入网令牌不行。响应不会回显网关令牌。

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"

	"ara/internal/gatewayclient"
)

type smartAuthContextKey struct{}

func markSmartAuth(r *http.Request) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), smartAuthContextKey{}, true))
}

func wasSmartAuth(r *http.Request) bool {
	v, _ := r.Context().Value(smartAuthContextKey{}).(bool)
	return v
}

// gatewayHopHeaders 是不会被透传的逐跳头。
var gatewayHopHeaders = map[string]bool{
	"connection":          true,
	"proxy-connection":    true,
	"keep-alive":          true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"te":                  true,
	"trailer":             true,
	"transfer-encoding":   true,
	"upgrade":             true,
}

// gatewayCredentialHeaders 是客户端可能携带的所有凭据别名；转发前一律清除，
// 再由 Hub 注入唯一的网关服务令牌，避免旧上游 key 或网关令牌互相串用。
var gatewayCredentialHeaders = []string{
	"authorization",
	"x-api-key",
	"api-key",
	"x-goog-api-key",
	"x-handwave-upstream",
	"cookie",
	"proxy-authorization",
}

// gatewayResponseDrop 是绝不回传给浏览器的响应头：Set-Cookie 会把网关源
// cookie 写进 Hub 源，Location 会把服务端可控的跳转目标泄给浏览器。
var gatewayResponseDrop = map[string]bool{
	"set-cookie":  true,
	"set-cookie2": true,
	"location":    true,
}

// gatewayQueryCredentials 是查询串里可能承载宿主令牌/model-grant/上游 key 的
// 参数名；转发前逐个剥离，其余参数（alt、api-version 等）按原字节保留。
var gatewayQueryCredentials = map[string]bool{
	"token":          true,
	"access_token":   true,
	"api_key":        true,
	"apikey":         true,
	"api-key":        true,
	"key":            true,
	"authorization":  true,
	"auth":           true,
	"x-api-key":      true,
	"x-goog-api-key": true,
	"model_grant":    true,
	"modelgrant":     true,
}

// mapGatewayPath 只放行网关的原生模型端点，输入为“转义后的路径”（EscapedPath），
// 因此 Gemini 模型段里的 %2F 不会被提前解码。未列入的路径（例如 /v1/admin、
// /v1/keys、/v1beta/models/...）返回 false，避免暴露网关管理面。
func mapGatewayPath(escaped string) (string, bool) {
	switch escaped {
	case "/v1/models", "/v1/chat/completions", "/v1/responses", "/v1/messages":
		return escaped, true
	case "/v1/ollama/api/chat":
		return "/api/chat", true
	}
	if rest, ok := strings.CutPrefix(escaped, "/v1/gemini/models/"); ok && rest != "" {
		return "/v1beta/models/" + rest, true
	}
	return "", false
}

func stripCredentialHeaders(header http.Header) {
	for _, name := range gatewayCredentialHeaders {
		header.Del(name)
	}
}

// stripCredentialQuery 去掉查询串里的凭据参数，其余参数保持原始字节与顺序，
// 使宿主令牌/model-grant 只能到 Hub，不能被转送给网关。
func stripCredentialQuery(raw string) string {
	if raw == "" {
		return ""
	}
	var kept []string
	for _, part := range strings.Split(raw, "&") {
		if part == "" {
			continue
		}
		name := part
		if i := strings.IndexByte(part, '='); i >= 0 {
			name = part[:i]
		}
		if dec, err := url.QueryUnescape(name); err == nil {
			name = dec
		}
		if gatewayQueryCredentials[strings.ToLower(name)] {
			continue
		}
		kept = append(kept, part)
	}
	return strings.Join(kept, "&")
}

func joinGatewayPath(root, path string) string {
	if root == "" || root == "/" {
		return path
	}
	return strings.TrimRight(root, "/") + path
}

// smartGateError 是逐请求门禁的拒绝。状态码与消息都不含凭据。
type smartGateError struct {
	status int
	msg    string
}

func (e *smartGateError) Error() string { return e.msg }

// smartRunForRequest 判断本次请求是否属于一条智能运行记录。
// 返回 false 表示这是旧 default/explicit code，交给既有路径处理，不加任何新限制。
func (h *hubSrv) smartRunForRequest(r *http.Request) (*runGrant, bool) {
	h.mu.Lock()
	bk := h.bind
	h.mu.Unlock()
	if bk == nil {
		return nil, false
	}
	code := bearerToken(r)
	if code == "" {
		return nil, false
	}
	return bk.runForCode(code)
}

// checkSmartRequest 是智能请求在 Hub 侧的窄门禁。
//
// Gateway 只能验证它自己的令牌与 decision，**不能替 Hub 验证 Node 的 FP/Run**，
// 所以这条门必须留在 Hub：code → 可信运行记录 → 会话绑定，再与实际请求比对。
// 具体 protocol 只来自可信绑定；path/body 仅用于验证 wire 兼容与模型名，
// 绝不自报 protocol 头当证据（两个协议 id 可共用同一 wire）。
func (h *hubSrv) checkSmartRequest(r *http.Request, gwEscaped string, body []byte) (*sessionPin, *smartGateError) {
	g, ok := h.smartRunForRequest(r)
	if !ok {
		return nil, nil // 旧路径：不当作智能请求，也不施加新限制
	}
	pin, ok := h.bindings().findPin(g.FP, g.BindingID)
	if !ok {
		return nil, &smartGateError{http.StatusForbidden, "smart session binding is no longer trusted"}
	}
	if r.Header.Get(smartRunHeader) != g.RunID {
		return nil, &smartGateError{http.StatusForbidden, "run association mismatch"}
	}
	if r.Header.Get(smartBindingHeader) != g.BindingID {
		return nil, &smartGateError{http.StatusForbidden, "binding association mismatch"}
	}
	// 目录请求没有模型体：只要 code 与关联对得上就放行（单独目录规则）。
	if gwEscaped == "/v1/models" {
		return pin, nil
	}
	if got, want := gatewayPathWire(gwEscaped), protocolWire(pin.Protocol); got != want {
		return nil, &smartGateError{http.StatusConflict, "request wire is not compatible with the bound protocol"}
	}
	if got := requestModelOf(gwEscaped, body); got != pin.Model {
		return nil, &smartGateError{http.StatusConflict, "request model does not match the bound model"}
	}
	if err := h.chargeGoalCall(g.FP, g.RunID); err != nil {
		return nil, &smartGateError{http.StatusForbidden, err.Error()}
	}
	return pin, nil
}

// protocolWire 把具体协议映射到它说的 wire。两个协议 id 可共用同一 wire
// （openai-completions/openrouter-chat、openai-responses/azure-openai-responses）。
func protocolWire(protocol string) string {
	switch protocol {
	case "openai-responses", "azure-openai-responses":
		return "responses"
	case "anthropic-messages":
		return "anthropic"
	case "google-generative-ai":
		return "gemini"
	case "ollama-chat":
		return "ollama"
	default:
		return "chat"
	}
}

// gatewayPathWire 由网关侧路径判定 wire（不做协议反推）。
func gatewayPathWire(gwEscaped string) string {
	switch {
	case strings.HasPrefix(gwEscaped, "/v1beta/models/"):
		return "gemini"
	case gwEscaped == "/v1/responses":
		return "responses"
	case gwEscaped == "/v1/messages":
		return "anthropic"
	case gwEscaped == "/api/chat":
		return "ollama"
	default:
		return "chat"
	}
}

// requestModelOf 取出请求实际要用的模型：Gemini 在路径里（只解码一次，保护 %2F），
// 其余协议在 body 的 model 字段里。取不到返回空，由调用方判为不匹配。
func requestModelOf(gwEscaped string, body []byte) string {
	if rest, ok := strings.CutPrefix(gwEscaped, "/v1beta/models/"); ok && rest != "" {
		name := rest
		if i := strings.IndexByte(name, ':'); i >= 0 {
			name = name[:i]
		}
		if dec, err := url.PathUnescape(name); err == nil {
			name = dec
		}
		return strings.TrimSpace(name)
	}
	var payload struct {
		Model string `json:"model"`
	}
	if len(body) > 0 && json.Unmarshal(body, &payload) == nil {
		return strings.TrimSpace(payload.Model)
	}
	return ""
}

// stripHostAssociationHeaders 去掉 Hub 与 Node 之间的关联头，绝不把它们带去上游。
func stripHostAssociationHeaders(header http.Header) {
	header.Del(smartRunHeader)
	header.Del(smartBindingHeader)
}

// gatewayProxy 是 hub 的 /v1/ 总入口。它在 wrap 之后运行，因此已通过根令牌或
// model-grant 校验。
func (h *hubSrv) gatewayProxy(w http.ResponseWriter, r *http.Request) {
	if h.gw == nil {
		http.Error(w, `{"error":"gateway not configured"}`, http.StatusServiceUnavailable)
		return
	}
	cfg := h.gw.snapshot()
	if cfg.Root == "" {
		http.Error(w, `{"error":"gateway not configured"}`, http.StatusServiceUnavailable)
		return
	}
	gwEscaped, ok := mapGatewayPath(r.URL.EscapedPath())
	if !ok {
		http.NotFound(w, r)
		return
	}
	gwDecoded, err := url.PathUnescape(gwEscaped)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	// 智能请求逐请求门禁：只在这条 code 属于智能运行记录时才读 body 校验，
	// 旧 default/explicit 请求完全不进这条路径（行为不变）。
	var smartPin *sessionPin
	_, codeIsSmart := h.smartRunForRequest(r)
	if wasSmartAuth(r) || codeIsSmart {
		raw, rerr := io.ReadAll(r.Body)
		if rerr != nil {
			http.Error(w, `{"error":"request body unreadable"}`, http.StatusBadRequest)
			return
		}
		// 读出来的 body 必须还原：后面的转发还要用它。
		r.Body = io.NopCloser(bytes.NewReader(raw))
		var gerr *smartGateError
		smartPin, gerr = h.checkSmartRequest(r, gwEscaped, raw)
		if gerr == nil && smartPin == nil {
			// 进来时已识别为智能请求，读到 body 之后记录却被换掉/过期了：
			// 绝不能降级成旧路径放行（那样会漏掉 model/wire/Run/Binding 检查
			// 与可信 decision 注入，等于把 Hub 服务令牌用于一次未校验的请求）。
			gerr = &smartGateError{http.StatusForbidden, "smart authorization changed while the request was being read"}
		}
		if gerr != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(gerr.status)
			_, _ = w.Write([]byte(`{"error":"` + gerr.msg + `"}`))
			return
		}
	}
	root, err := url.Parse(cfg.Root)
	if err != nil {
		http.Error(w, `{"error":"gateway not configured"}`, http.StatusServiceUnavailable)
		return
	}
	outReq := r.Clone(r.Context())
	outReq.URL.Scheme = root.Scheme
	outReq.URL.Host = root.Host
	// Path 与 RawPath 同步设置：单次解码后的 Path 供路由，RawPath 保留原始转义，
	// 使 %2F / %252F 在转发中不失真。
	outReq.URL.Path = joinGatewayPath(root.Path, gwDecoded)
	outReq.URL.RawPath = joinGatewayPath(root.EscapedPath(), gwEscaped)
	outReq.URL.RawQuery = stripCredentialQuery(r.URL.RawQuery)
	outReq.RequestURI = ""
	outReq.Host = root.Host
	stripCredentialHeaders(outReq.Header)
	// 关联头只是 Hub↔Node 之间的标识，绝不转发到上游。
	stripHostAssociationHeaders(outReq.Header)
	// A client decision header never authorizes a Host-fixed explicit choice.
	outReq.Header.Del(gatewayclient.RouteDecisionHeader)
	// 决策头由 Hub（可信绑定的持有者）注入：Node 自报不可信。
	if smartPin != nil && smartPin.DecisionSource != "host-explicit" && strings.TrimSpace(smartPin.DecisionID) != "" {
		outReq.Header.Set(gatewayclient.RouteDecisionHeader, smartPin.DecisionID)
	}
	if token := gatewayToken(cfg); token != "" {
		outReq.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := h.gw.httpClient(cfg).Do(outReq)
	if err != nil {
		// 取消必须保持取消：客户端断开时不再写任何响应。
		if r.Context().Err() != nil {
			return
		}
		http.Error(w, `{"error":"gateway upstream failed"}`, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	// 网关重定向不得跟随，也不得把 Location 转给浏览器：作为安全非成功处理。
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		http.Error(w, `{"error":"gateway upstream redirect refused"}`, http.StatusBadGateway)
		return
	}
	dst := w.Header()
	for name, values := range resp.Header {
		lower := strings.ToLower(name)
		if gatewayHopHeaders[lower] || gatewayResponseDrop[lower] {
			continue
		}
		for _, v := range values {
			dst.Add(name, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	streamCopy(w, resp.Body)
}

// streamCopy 逐块透传响应体（SSE 需要即时 flush），从不缓冲整包。
func streamCopy(w http.ResponseWriter, src io.Reader) {
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32<<10)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}
