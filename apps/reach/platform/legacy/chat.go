package main

// 工作台聊天：组提示词、KB 注入、转发上游、写 jsonl。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"ara/internal/agent"
	"ara/internal/gatewayclient"
	"ara/internal/providers"
)

var defaultTools = []map[string]any{
	{
		"type": "function",
		"function": map[string]any{
			"name":        "exec",
			"description": "在已连接的远程主机上执行 shell 命令，返回 stdout/stderr 与退出码。",
			"parameters": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"cmd":     map[string]any{"type": "string", "description": "要执行的命令"},
					"cwd":     map[string]any{"type": "string", "description": "工作目录（可选）"},
					"timeout": map[string]any{"type": "integer", "description": "超时秒数，默认 60"},
				},
				"required": []string{"cmd"},
			},
		},
	},
	{
		"type": "function",
		"function": map[string]any{
			"name":        "read_file",
			"description": "读取远程主机上的文件内容（小文件）。",
			"parameters": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path": map[string]any{"type": "string"},
				},
				"required": []string{"path"},
			},
		},
	},
	{
		"type": "function",
		"function": map[string]any{
			"name":        "write_file",
			"description": "向远程主机写入文件内容（覆盖）。",
			"parameters": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path":    map[string]any{"type": "string"},
					"content": map[string]any{"type": "string"},
				},
				"required": []string{"path", "content"},
			},
		},
	},
}

type chatReq struct {
	WorkspaceID string      `json:"workspace_id"`
	SessionID   string      `json:"session_id"`
	Content     string      `json:"content"`
	Model       string      `json:"model"`
	Protocol    string      `json:"protocol"` // 多协议模型必须显式选择
	KBGlobal    bool        `json:"kb_global"`
	KBProject   bool        `json:"kb_project"`
	Tools       bool        `json:"tools"` // 是否启用远程工具
	Attachments []attachRef `json:"attachments"`
	Skills      []string    `json:"skills"`
	Agents      bool        `json:"agents"` // 是否启用轻量 subagent / Node 任务
	// Smart 请求走共享选型契约。它只是「请求」，不是授权：池、预算与权限由
	// 服务端按已鉴权会话与网关配置决定，浏览器不能指定。
	Smart bool `json:"smart"`
}

type chatContinueReq struct {
	WorkspaceID string    `json:"workspace_id"`
	SessionID   string    `json:"session_id"`
	TurnID      string    `json:"turn_id"`
	Model       string    `json:"model"`
	Protocol    string    `json:"protocol"`
	KBGlobal    bool      `json:"kb_global"`
	KBProject   bool      `json:"kb_project"`
	Tools       bool      `json:"tools"`
	Agents      bool      `json:"agents"`
	Smart       bool      `json:"smart"`
	ToolResults []chatMsg `json:"tool_results"`
}

func (h *hubSrv) buildSystemPrompt(wsID, userQuery string, kbG, kbP bool) string {
	var b strings.Builder
	b.WriteString("你是 handwave 智能协作助手。\n")
	b.WriteString("【目标机器】默认是已连接的 Node（用户的本机，如 RayWork）。")
	b.WriteString("如果用户说「本机」「我的电脑」「工作区电脑」，指的就是 Node。")
	b.WriteString("工具（exec/read_file/write_file）都在 Node 上执行，不是在云服务器上。\n")
	b.WriteString("【工具可用性】如果 Node 未连接，工具不可用，必须明确告知用户「未连接 Node，无法执行命令」。")
	b.WriteString("不要在没有执行工具的情况下编造结果。\n")
	b.WriteString("【澄清格式】当问题涉及多个目标且你不确定时，使用以下格式让用户选择：\n")
	b.WriteString("[?OPT:我的电脑(RayWork):我的电脑|云服务器:云服务器]\n")
	b.WriteString(kbExcerpt(wsID, userQuery, kbG, kbP, 6))
	return b.String()
}

// kbExcerpt 把工作区 KB 命中拼成「知识库摘录」段；无命中返回空串。
// 云端对话与本机 agent-loop 共用此口径，避免两处格式化漂移。
func kbExcerpt(wsID, userQuery string, kbG, kbP bool, topK int) string {
	hits := searchKBScoped(wsID, userQuery, kbG, kbP, topK)
	if len(hits) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n## 知识库摘录\n")
	for i, hit := range hits {
		b.WriteString(fmt.Sprintf("### [%d] %s\n%s\n\n", i+1, hit.Name, hit.Text))
	}
	return b.String()
}

// toolSpecs 把 Hub 的业务工具定义（OpenAI function 形状）窄桥到 agent.ToolSpec。
// 这里只做形状转换，不新增任何工具能力，也不改变授权口径。
func toolSpecs(defs []map[string]any) []agent.ToolSpec {
	specs := make([]agent.ToolSpec, 0, len(defs))
	for _, def := range defs {
		fn, _ := def["function"].(map[string]any)
		name, _ := fn["name"].(string)
		if name == "" {
			continue
		}
		desc, _ := fn["description"].(string)
		params, _ := json.Marshal(fn["parameters"])
		specs = append(specs, agent.ToolSpec{Name: name, Description: desc, Parameters: params})
	}
	return specs
}

// errLegacyHistoryProtocol：旧历史缺少原生载体，只能按旧 chat 协议转换。
var errLegacyHistoryProtocol = errors.New("会话历史缺少原生载体，只能按已知旧 chat 协议重放；请在 openai-completions 协议下继续，或另开会话")

// hasLegacyHistory 判断历史中是否存在没有原生载体的旧消息。
func hasLegacyHistory(hist []chatMsg) bool {
	for _, m := range hist {
		if m.Native == nil {
			return true
		}
	}
	return false
}

// buildAgentMessages 把工作台历史转成原生 agent 消息。带 Native 的消息原样复用
// （保真 ProviderData 不透明块）；旧消息只允许在旧 chat 协议下转换，绝不为缺失
// 来源/模型的历史捏造 origin 跨协议重放。
func buildAgentMessages(protocol string, hist []chatMsg) ([]agent.Message, error) {
	out := make([]agent.Message, 0, len(hist))
	for _, m := range hist {
		if m.Native != nil {
			out = append(out, *m.Native)
			continue
		}
		if protocol != providers.OpenAICompletions {
			return nil, errLegacyHistoryProtocol
		}
		out = append(out, legacyAgentMessage(m))
	}
	return out, nil
}

func legacyAgentMessage(m chatMsg) agent.Message {
	switch m.Role {
	case "user":
		if msg := nativeUserMessage(m.Content, m.Attachments); msg != nil {
			return *msg
		}
		return agent.TextMessage("user", m.Content)
	case "assistant":
		msg := agent.Message{Role: "assistant"}
		if m.Content != "" {
			msg.Content = append(msg.Content, agent.Content{Type: "text", Text: m.Content})
		}
		for _, tc := range m.ToolCalls {
			msg.ToolCalls = append(msg.ToolCalls, agent.ToolCall{ID: tc.ID, Name: tc.Function.Name, Arguments: json.RawMessage(tc.Function.Arguments)})
		}
		return msg
	case "tool":
		return agent.Message{Role: "tool", ToolCallID: m.ToolCallID, ToolName: m.Name, Content: []agent.Content{{Type: "text", Text: m.Content}}}
	default:
		return agent.Message{Role: m.Role, Content: []agent.Content{{Type: "text", Text: m.Content}}}
	}
}

// nativeUserMessage 把用户消息（含附件）转成原生载体：文本与图片作为同一消息的
// 内容块，附件文本并入文本，非文本附件保留类型提示，绝不静默丢弃。
func nativeUserMessage(content string, atts []attachRef) *agent.Message {
	text := content
	var images []agent.Content
	for _, a := range atts {
		switch {
		case a.Text != "":
			text += "\n\n[附件 " + a.Name + "]\n" + a.Text
		case strings.HasPrefix(a.MIME, "image/") && a.DataURL != "":
			images = append(images, agent.Content{Type: "image", MIMEType: a.MIME, URL: a.DataURL})
		case strings.HasPrefix(a.MIME, "image/"):
			text += "\n\n[图片附件 " + a.Name + "：上游若无多模态，请告知用户无法直接看图]"
		default:
			text += "\n\n[附件 " + a.Name + "：类型 " + a.MIME + "，未提取文本]"
		}
	}
	if text == "" && len(images) == 0 {
		return nil
	}
	msg := &agent.Message{Role: "user"}
	if text != "" {
		msg.Content = append(msg.Content, agent.Content{Type: "text", Text: text})
	}
	msg.Content = append(msg.Content, images...)
	return msg
}

// toolCallsFromMessage 把原生响应的工具调用转回工作台历史形状。
func toolCallsFromMessage(m agent.Message) []toolCallOut {
	if len(m.ToolCalls) == 0 {
		return nil
	}
	out := make([]toolCallOut, 0, len(m.ToolCalls))
	for _, c := range m.ToolCalls {
		var tc toolCallOut
		tc.ID = c.ID
		tc.Type = "function"
		tc.Function.Name = c.Name
		tc.Function.Arguments = string(c.Arguments)
		out = append(out, tc)
	}
	return out
}

func findUserTurn(hist []chatMsg, turnID string) int {
	for i := len(hist) - 1; i >= 0; i-- {
		if hist[i].Role == "user" && (turnID == "" || hist[i].ID == turnID) {
			return i
		}
	}
	return -1
}

// turnHistory 只接纳提交时冻结前缀中的完整轮次，再追加当前轮的续接消息。
func turnHistory(hist []chatMsg, turnIndex int) ([]chatMsg, error) {
	target := hist[turnIndex]
	if !target.ContextFrozen {
		out := append([]chatMsg(nil), hist[:turnIndex+1]...)
		for i := turnIndex + 1; i < len(hist); i++ {
			if hist[i].TurnID == target.ID {
				out = append(out, hist[i])
			}
		}
		return out, nil
	}

	cutoff := target.ContextSize
	if cutoff < 0 || cutoff > turnIndex {
		return nil, fmt.Errorf("invalid chat context")
	}

	legacyEnd := cutoff
	for i := 0; i < cutoff; i++ {
		if hist[i].Role == "user" && hist[i].ContextFrozen {
			legacyEnd = i
			break
		}
	}
	out := append([]chatMsg(nil), hist[:legacyEnd]...)
	var users []chatMsg
	turnMessages := make(map[string][]chatMsg)
	turnComplete := make(map[string]bool)
	for i := legacyEnd; i < cutoff; i++ {
		m := hist[i]
		if m.Role == "user" {
			users = append(users, m)
			continue
		}
		if m.TurnID == "" {
			continue
		}
		turnMessages[m.TurnID] = append(turnMessages[m.TurnID], m)
		if m.Role == "assistant" {
			turnComplete[m.TurnID] = len(m.ToolCalls) == 0
		}
	}
	for _, user := range users {
		if !turnComplete[user.ID] {
			continue
		}
		out = append(out, user)
		out = append(out, turnMessages[user.ID]...)
	}
	out = append(out, target)
	for i := turnIndex + 1; i < len(hist); i++ {
		if hist[i].TurnID == target.ID {
			out = append(out, hist[i])
		}
	}
	return out, nil
}

// smartDecisionForTurn 给出本次智能请求的决策。
//
// 会话已有智能身份时直接复用（不重新解析）：默认配置变化、目录刷新都不会让它换
// 模型或改协议。身份过期或决策要求的模型已不在目录里时明确拒绝，不静默重新分类。
// 解析在宿主状态锁之外执行（gatewayStore 只取快照），并绑定本次 turn 作为请求
// 身份；ctx 取消时直接返回取消，不留下半个运行。
// decisionFromIdentity is the one place a pinned session identity becomes a route
// decision: reuse, commit re-check and the re-read before writing must agree.
func decisionFromIdentity(id *smartIdentity) *gatewayclient.RouteDecision {
	return &gatewayclient.RouteDecision{
		DecisionID:     id.DecisionID,
		Model:          id.Model,
		Protocol:       id.Protocol,
		Pool:           id.Pool,
		PolicyVersion:  id.PolicyVersion,
		CatalogVersion: id.CatalogVersion,
	}
}

func (h *hubSrv) smartDecisionForTurn(ctx context.Context, wsID, sid, turnID, summary string, requiresTools bool) (*gatewayclient.RouteDecision, error) {
	if h.gw == nil {
		return nil, errCloudNotConfigured
	}
	sess, err := loadSessMeta(wsID, sid)
	if err != nil {
		return nil, err
	}
	if sess == nil {
		return nil, fmt.Errorf("会话不存在：%s/%s", wsID, sid)
	}
	if sess.Smart != nil && sess.Smart.DecisionID != "" {
		if sess.Smart.ExpiresAt != "" {
			exp, perr := time.Parse(time.RFC3339, sess.Smart.ExpiresAt)
			if perr == nil && !time.Now().Before(exp) {
				return nil, fmt.Errorf("本会话的智能决策已于 %s 过期：请另开会话重新选型，不会自动重新分类", sess.Smart.ExpiresAt)
			}
		}
		protocols, _, perr := h.gw.providerConfig(ctx, sess.Smart.Model, sess.Smart.Protocol)
		if perr != nil {
			return nil, perr
		}
		if protocols.Model != sess.Smart.Model || protocols.API != sess.Smart.Protocol {
			return nil, fmt.Errorf("本会话已绑定 %s/%s，当前目录无法复现该身份：请另开会话，不会静默换模型", sess.Smart.Model, sess.Smart.Protocol)
		}
		return decisionFromIdentity(sess.Smart), nil
	}
	// The first selection of a session is single-flight: concurrent requests of one
	// session each reading an unpinned identity would resolve twice and overwrite each
	// other. Only the leader resolves; everyone else waits for that one decision.
	flight, leader := h.joinSmartFlight(wsID, sid)
	if leader {
		h.leadSmartFlight(flight, wsID, sid, ctx, turnID, summary, requiresTools, sess)
	} else {
		select {
		case <-flight.done:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if flight.err != nil {
		return nil, flight.err
	}
	// A leader that ended abnormally wakes its waiters with neither a decision nor an
	// error; that must become an explicit failure instead of a nil decision.
	if flight.dec == nil {
		return nil, fmt.Errorf("本会话的智能选型未能产生决策（选型被中断），请重试或另开会话")
	}
	// Commit re-check: whatever the session has pinned now is authoritative. A waiter
	// never returns its own idea of the identity when the session was pinned in the
	// meantime, so two concurrent requests can never end up with two identities.
	if pinned, perr := loadSessMeta(wsID, sid); perr == nil && pinned != nil && pinned.Smart != nil && pinned.Smart.DecisionID != "" {
		return decisionFromIdentity(pinned.Smart), nil
	}
	return flight.dec, nil
}

// joinSmartFlight returns the session's in-flight first selection and whether this
// caller is its leader. The mutex guards the map only — never a network call.
// leadSmartFlight resolves for the leader and always releases the flight, even if
// the resolve ends abnormally: a flight that is never closed would hang every
// waiter that joined it.
func (h *hubSrv) leadSmartFlight(flight *smartFlight, wsID, sid string, ctx context.Context, turnID, summary string, requiresTools bool, sess *sessMeta) {
	defer func() {
		close(flight.done)
		h.flightMu.Lock()
		delete(h.flights, wsID+"\x00"+sid)
		h.flightMu.Unlock()
	}()
	flight.dec, flight.err = h.resolveAndPinSmart(ctx, wsID, sid, turnID, summary, requiresTools, sess)
}

func (h *hubSrv) joinSmartFlight(wsID, sid string) (*smartFlight, bool) {
	h.flightMu.Lock()
	defer h.flightMu.Unlock()
	if h.flights == nil {
		h.flights = map[string]*smartFlight{}
	}
	key := wsID + "\x00" + sid
	if existing, ok := h.flights[key]; ok {
		return existing, false
	}
	flight := &smartFlight{done: make(chan struct{})}
	h.flights[key] = flight
	return flight, true
}

// identityCompatible reports whether an existing concrete identity field may be
// filled with want: empty means still unbound, an equal value is already the
// same tuple. A different non-empty value must be left alone.
func identityCompatible(have, want string) bool { return have == "" || have == want }

// resolveAndPinSmart performs the one resolve of a session and pins its result.
func (h *hubSrv) resolveAndPinSmart(ctx context.Context, wsID, sid, turnID, summary string, requiresTools bool, sess *sessMeta) (*gatewayclient.RouteDecision, error) {
	// A leader may start only after an earlier flight already pinned this
	// session: the delayed request had read an unpinned snapshot and joined the
	// flight map after that flight was released. Check the latest bound identity
	// before any resolve so it cannot classify the same session twice.
	if latest, lerr := loadSessMeta(wsID, sid); lerr == nil && latest != nil && latest.Smart != nil && latest.Smart.DecisionID != "" {
		if latest.Smart.ExpiresAt != "" {
			if exp, perr := time.Parse(time.RFC3339, latest.Smart.ExpiresAt); perr == nil && !time.Now().Before(exp) {
				return nil, fmt.Errorf("本会话的智能决策已于 %s 过期：请另开会话重新选型，不会自动重新分类", latest.Smart.ExpiresAt)
			}
		}
		protocols, _, perr := h.gw.providerConfig(ctx, latest.Smart.Model, latest.Smart.Protocol)
		if perr != nil {
			return nil, perr
		}
		if protocols.Model != latest.Smart.Model || protocols.API != latest.Smart.Protocol {
			return nil, fmt.Errorf("本会话已绑定 %s/%s，当前目录无法复现该身份：请另开会话，不会静默换模型", latest.Smart.Model, latest.Smart.Protocol)
		}
		return decisionFromIdentity(latest.Smart), nil
	}
	res, err := h.gw.resolveRouteOnce(ctx, turnID, summary, requiresTools)
	if err != nil {
		return nil, err
	}
	dec := res.Decision
	// Commit boundary: read-validate-save happens atomically via updateSessMeta,
	// so a pin that landed while the resolve was in flight (an explicit first
	// turn, or another flight) is authoritative and the caller's stale snapshot
	// can never overwrite it. Network resolve above stays outside the lock.
	if h.testBeforeIdentityCommit != nil {
		h.testBeforeIdentityCommit(turnID)
	}
	var adopted *gatewayclient.RouteDecision
	err = updateSessMeta(wsID, sid, func(pinned *sessMeta) error {
		if pinned.Smart != nil && pinned.Smart.DecisionID != "" {
			adopted = decisionFromIdentity(pinned.Smart)
			return nil
		}
		// The session already carries a concrete identity (both fields set), so
		// the smart path may only join it, never replace it: comparing protocols
		// alone would let another model of the same protocol take the session
		// over. A historical record with an empty model is not a bound identity
		// and keeps its compatible behaviour.
		if pinned.Model != "" && pinned.Protocol != "" && (dec.Model != pinned.Model || dec.Protocol != pinned.Protocol) {
			return fmt.Errorf("本会话已绑定 %s/%s，智能选型给出 %s/%s：请另开会话，不会在同一会话里换身份",
				pinned.Model, pinned.Protocol, dec.Model, dec.Protocol)
		}
		pinned.Smart = &smartIdentity{
			DecisionID:     dec.DecisionID,
			Model:          dec.Model,
			Protocol:       dec.Protocol,
			Pool:           dec.Pool,
			PolicyVersion:  dec.PolicyVersion,
			CatalogVersion: dec.CatalogVersion,
			ExpiresAt:      res.ExpiresAt,
		}
		// Smart alone is not the external contract: the UI restores the binding
		// from sess.Model/sess.Protocol. Land the equivalent concrete fields in
		// the same atomic commit so a successful first smart never leaves them
		// empty. Only unbound (empty) or already-agreeing fields are written, so
		// an existing inconsistent tuple is never silently rewritten.
		if identityCompatible(pinned.Model, dec.Model) && identityCompatible(pinned.Protocol, dec.Protocol) {
			pinned.Model = dec.Model
			pinned.Protocol = dec.Protocol
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if adopted != nil {
		return adopted, nil
	}
	log.Printf("smart route resolved: workspace=%s session=%s turn=%s model=%s protocol=%s decision=%s eligible=%d",
		wsID, sid, turnID, dec.Model, dec.Protocol, dec.DecisionID, res.EligibleCount)
	return &dec, nil
}

func (h *hubSrv) chatTurn(ctx context.Context, wsID, sid, turnID, model, protocol string, kbG, kbP, tools, agents, smart bool, onTrace func(agentEvent), onDelta func(string)) (*chatMsg, error) {
	hist, err := readMessages(wsID, sid)
	if err != nil {
		return nil, err
	}
	turnIndex := findUserTurn(hist, turnID)
	if turnIndex < 0 {
		return nil, fmt.Errorf("chat turn not found")
	}
	userQ := hist[turnIndex].Content
	skills := hist[turnIndex].Skills
	turnID = hist[turnIndex].ID
	turnHist, err := turnHistory(hist, turnIndex)
	if err != nil {
		return nil, err
	}
	log.Printf("chat turn start: workspace=%s session=%s turn=%s skills=%d tools=%t agents=%t", wsID, sid, turnID, len(skills), tools, agents)

	// 唯一的模型核心：目录与协议解析经 gatewayclient，请求经 providers。
	var pc providers.Config
	if smart {
		// 智能选型：运行身份建立前解析一次，之后固定 (model, protocol, decision)。
		dec, derr := h.smartDecisionForTurn(ctx, wsID, sid, turnID, userQ, tools)
		if derr != nil {
			return nil, derr // 结构化拒绝，绝不退回 default 或更贵的模型
		}
		pc, err = h.gw.smartProviderConfig(ctx, *dec)
	} else {
		pc, _, err = h.gw.providerConfig(ctx, model, protocol)
	}
	if err != nil {
		return nil, err
	}
	// 会话协议身份：首次记录协议+模型；跨协议重放旧历史必须显式另开会话，
	// 绝不改写旧 jsonl 或捏造 origin。提交与 smart 身份共用同一窄原子边界，
	// 避免与并发钉住互相用旧对象覆盖。
	if h.testBeforeIdentityCommit != nil {
		h.testBeforeIdentityCommit(turnID)
	}
	if serr := updateSessMeta(wsID, sid, func(sess *sessMeta) error {
		if sess.Protocol != "" && sess.Protocol != pc.API && hasLegacyHistory(turnHist) {
			return fmt.Errorf("会话历史来自 %s 协议，无法在当前 %s 协议下重放；请另开会话", sess.Protocol, pc.API)
		}
		// A smart pin is a concrete identity: this request may only join it.
		// Writing Model/Protocol from a stale snapshot would fork or erase it.
		if sess.Smart != nil && sess.Smart.DecisionID != "" {
			if sess.Smart.Model != pc.Model || sess.Smart.Protocol != pc.API {
				return fmt.Errorf("本会话已绑定 %s/%s，当前请求给出 %s/%s：请另开会话，不会在同一会话里换身份",
					sess.Smart.Model, sess.Smart.Protocol, pc.Model, pc.API)
			}
			// Same tuple: fall through and fill the concrete fields the UI reads.
		}
		if sess.Protocol == "" {
			sess.Protocol = pc.API
			sess.Model = pc.Model
		}
		return nil
	}); serr != nil {
		return nil, serr
	}
	oa, err := buildAgentMessages(pc.API, turnHist)
	if err != nil {
		return nil, err
	}

	wsMeta, _ := loadWSMeta(wsID)
	projectPath := ""
	if wsMeta != nil {
		projectPath = wsMeta.ProjectPath
	}

	sys := h.buildSystemPrompt(wsID, userQ, kbG, kbP) + skillPrompt(skills)
	if projectPath != "" {
		sys += buildProjectContext(wsMeta, projectPath)
	}
	if agents {
		sys += agentCoordinationPrompt(tools)
	}
	if model == "" {
		model = "default"
	}
	var events []agentEvent
	emitTrace := func(e agentEvent) {
		events = append(events, e)
		if onTrace != nil {
			onTrace(e)
		}
	}
	emitTrace(newAgentEvent("model_request", "running", "coordinator", "Coordinator", "coordinator", "Planning response", fmt.Sprintf("model=%s", pc.Model)))
	cloudAgent := projectPath != ""
	specs := toolSpecs(chatTools(tools, agents, cloudAgent))
	emit := func(e agent.Event) {
		if e.Type == "text_delta" && onDelta != nil {
			onDelta(e.Text)
		}
	}
	resp, err := complete(ctx, pc, agent.Request{Model: pc.Model, System: sys, Messages: oa, Tools: specs}, emit)
	if err != nil {
		return nil, err
	}
	content := resp.Message.Text()
	tcs := toolCallsFromMessage(resp.Message)
	responseStatus := "completed"
	if len(tcs) > 0 {
		responseStatus = "running"
	}
	emitTrace(newAgentEvent("model_response", responseStatus, "coordinator", "Coordinator", "coordinator", "Response planned", fmt.Sprintf("tool_calls=%d", len(tcs))))
	nativeMsg := resp.Message

	// Detect clarify markers: [?OPT:label:value|label:value]
	clarifyOpts := extractClarify(&content)
	if len(clarifyOpts) > 0 {
		m := &chatMsg{Role: "assistant", Content: content, TurnID: turnID, Events: events, Clarify: clarifyOpts, Native: &nativeMsg, Usage: resp.Usage, StopReason: resp.StopReason}
		if err := appendMessage(wsID, sid, m); err != nil {
			return nil, err
		}
		log.Printf("chat turn clarify: workspace=%s session=%s turn=%s options=%d", wsID, sid, turnID, len(clarifyOpts))
		return m, nil // no tool calls when clarifying
	}

	// Hub 执行 search/read/apply/exec；delegate / node task 留给浏览器。
	// 每轮必须重读 jsonl，否则模型看不到工具结果。
	if cloudAgent && len(tcs) > 0 {
		round := 0
		maxRounds := 10
		for len(tcs) > 0 {
			var hubTCs, clientTCs []toolCallOut
			for _, tc := range tcs {
				if hubExecutesTool(tc.Function.Name) {
					hubTCs = append(hubTCs, tc)
				} else {
					clientTCs = append(clientTCs, tc)
				}
			}
			if len(hubTCs) == 0 {
				// 纯 client：持久化单条完整 assistant 并 handoff，不受 Hub 执行上限影响。
				asstMsg := &chatMsg{Role: "assistant", Content: content, ToolCalls: tcs, TurnID: turnID, Events: events, Native: &nativeMsg, Usage: resp.Usage, StopReason: resp.StopReason}
				if err := appendMessage(wsID, sid, asstMsg); err != nil {
					return nil, err
				}
				handoff := *asstMsg
				handoff.ToolCalls = clientTCs
				log.Printf("chat turn handoff: workspace=%s session=%s turn=%s client_tools=%d", wsID, sid, turnID, len(clientTCs))
				return &handoff, nil
			}
			if round >= maxRounds {
				return nil, fmt.Errorf("tool call loop reached max rounds")
			}
			round++
			// 持久化单条完整 native assistant：全部 calls + 原始 opaque，绝不拆分或复制。
			asstMsg := &chatMsg{Role: "assistant", Content: content, ToolCalls: tcs, TurnID: turnID, Events: events, Native: &nativeMsg, Usage: resp.Usage, StopReason: resp.StopReason}
			if err := appendMessage(wsID, sid, asstMsg); err != nil {
				return nil, err
			}
			for _, tc := range hubTCs {
				var args map[string]any
				_ = json.Unmarshal([]byte(tc.Function.Arguments), &args)
				result := h.cloudToolCall(ctx, wsMeta, tc.Function.Name, args, tc.ID)
				body := result.Content
				isErr := result.Status != "done"
				if isErr {
					body = "Error: " + result.Error
				}
				trMsg := &chatMsg{Role: "tool", ToolCallID: tc.ID, Name: tc.Function.Name, Content: body, TurnID: turnID}
				trMsg.Native = &agent.Message{Role: "tool", ToolCallID: tc.ID, ToolName: tc.Function.Name, IsError: isErr, Content: []agent.Content{{Type: "text", Text: body}}}
				if err := appendMessage(wsID, sid, trMsg); err != nil {
					return nil, err
				}
				log.Printf("chat turn tool: workspace=%s session=%s turn=%s name=%s status=%s", wsID, sid, turnID, tc.Function.Name, result.Status)
			}
			if len(clientTCs) > 0 {
				// 交给浏览器：只把 client subset 暴露给 UI；持久化仍是完整 assistant。
				handoff := *asstMsg
				handoff.ToolCalls = clientTCs
				log.Printf("chat turn handoff: workspace=%s session=%s turn=%s client_tools=%d", wsID, sid, turnID, len(clientTCs))
				return &handoff, nil
			}
			hist, err = readMessages(wsID, sid)
			if err != nil {
				return nil, err
			}
			updatedHist, err := turnHistory(hist, turnIndex)
			if err != nil {
				return nil, err
			}
			oa, err = buildAgentMessages(pc.API, updatedHist)
			if err != nil {
				return nil, err
			}
			resp, err = complete(ctx, pc, agent.Request{Model: pc.Model, System: sys, Messages: oa, Tools: specs}, emit)
			if err != nil {
				// 工具已执行并落库；二次调用失败必须错误结束，绝不复用旧 content/tcs，
				// 也不重复执行或重复写入同一 tool call。
				log.Printf("chat turn gateway tool loop failed: workspace=%s session=%s turn=%s err=%v", wsID, sid, turnID, err)
				return nil, fmt.Errorf("gateway tool loop failed after tool execution: %w", err)
			}
			content = resp.Message.Text()
			tcs = toolCallsFromMessage(resp.Message)
			nativeMsg = resp.Message
		}
	}

	m := &chatMsg{Role: "assistant", Content: content, ToolCalls: tcs, TurnID: turnID, Events: events, Usage: resp.Usage, StopReason: resp.StopReason}
	if nativeMsg.Role != "" {
		m.Native = &nativeMsg
	}
	if err := appendMessage(wsID, sid, m); err != nil {
		return nil, err
	}
	log.Printf("chat turn finish: workspace=%s session=%s turn=%s assistant=%s tool_calls=%d", wsID, sid, turnID, m.ID, len(tcs))
	return m, nil
}

// extractClarify parses [?OPT:label:value|label:value] markers from content.
// Returns nil if no markers found; caller mutates *content in place.
func extractClarify(content *string) []clarifyOption {
	const marker = "[?OPT:"
	idx := strings.Index(*content, marker)
	if idx < 0 {
		return nil
	}
	end := strings.Index((*content)[idx:], "]")
	if end < 0 {
		return nil
	}
	end += idx // absolute position
	raw := (*content)[idx+len(marker) : end]
	*content = strings.TrimSpace((*content)[:idx] + (*content)[end+1:]) // remove marker from content

	var opts []clarifyOption
	for _, pair := range strings.Split(raw, "|") {
		parts := strings.SplitN(pair, ":", 2)
		if len(parts) != 2 {
			continue
		}
		label := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])
		if label == "" || value == "" {
			continue
		}
		opts = append(opts, clarifyOption{Label: label, Value: value})
	}
	if len(opts) < 2 {
		return nil // need at least 2 options
	}
	return opts
}

// buildProjectContext injects the project file tree into the system prompt
// when a workspace has project_path configured.
func buildProjectContext(wsMeta *wsMeta, projectPath string) string {
	var b strings.Builder
	b.WriteString("\n## Project Context\n")
	if wsMeta != nil && wsMeta.Name != "" {
		b.WriteString("Project: " + wsMeta.Name + "\n")
	}
	b.WriteString("Project root: " + projectPath + "\n")

	// List top-level structure (2 levels deep max for prompt)
	tree := listProjectTree(projectPath)
	if len(tree) > 0 {
		b.WriteString("File structure:\n")
		for _, entry := range tree {
			if entry.Type == "dir" {
				b.WriteString("  " + entry.Name + "/\n")
				if entry.Children != nil {
					for _, child := range entry.Children {
						if child.Type == "dir" {
							b.WriteString("    " + child.Name + "/\n")
						} else {
							b.WriteString("    " + child.Name + "\n")
						}
					}
				}
			} else {
				b.WriteString("  " + entry.Name + "\n")
			}
		}
	}
	b.WriteString("You can use search_codebase, read_file, and apply_code to explore and modify the project.\n")
	return b.String()
}
