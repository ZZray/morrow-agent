package main

// 本机 Agent 的宿主接线：HandWave 不再自己跑模型循环。
//
// 一回合 = 一次 nativeapp.Run：
//   - 模型实现由 hub /v1 的访问码构造（providers.New），只在本进程内存里；
//   - 模型循环、协议解析、供应商重试分类与会话 journal 全部来自共享核心
//     （internal/agent + internal/nativeapp + internal/providers）；
//   - 设备授权、访问码、工具面、任务板、UI 确认与旁路命令仍留在 node。
//
// 这里没有任何第二套循环、模型解析或 journal：只有宿主契约、事件映射和访问码。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"ara/internal/agent"
	"ara/internal/nativeapp"
	"ara/internal/providers"
)

type modelGrantReply struct {
	id, code, errText string
	ttl               int64
	// Hub 保存的默认模型/协议（非敏感元数据）：只在本次 run 首次解析时使用。
	defaultModel    string
	defaultProtocol string
	// 智能路径的可信绑定：由 Hub 侧记录签发，node 照用，不自造授权。
	bindingID        string
	boundModel       string
	boundProtocol    string
	boundDecision    string
	boundDecisionExp string
	boundMaxOutput   int
	boundTools       bool
}

// validateSmartGrant checks the complete trusted tuple before directory assembly
// or model execution. Incomplete smart replies must never enter the default path.
func validateSmartGrant(g modelGrantReply, previous *modelGrantReply) error {
	if strings.TrimSpace(g.code) == "" || strings.TrimSpace(g.bindingID) == "" ||
		strings.TrimSpace(g.boundModel) == "" || strings.TrimSpace(g.boundProtocol) == "" ||
		strings.TrimSpace(g.boundDecision) == "" || g.boundMaxOutput <= 0 || !g.boundTools {
		return fmt.Errorf("smart grant is incomplete or does not authorize the agent's tools")
	}
	expires, err := time.Parse(time.RFC3339Nano, g.boundDecisionExp)
	if err != nil || !expires.After(time.Now()) {
		return fmt.Errorf("smart decision is expired or has an invalid expiry; existing session history is preserved")
	}
	if previous != nil && (g.bindingID != previous.bindingID || g.boundModel != previous.boundModel ||
		g.boundProtocol != previous.boundProtocol || g.boundDecision != previous.boundDecision ||
		g.boundDecisionExp != previous.boundDecisionExp || g.boundMaxOutput != previous.boundMaxOutput ||
		g.boundTools != previous.boundTools) {
		return fmt.Errorf("smart renewal changed the trusted session binding or request constraints")
	}
	return nil
}

func (a *nodeAgent) deliverModelGrant(e ev) {
	reply := modelGrantReply{id: e.ID, code: string(e.Msg), errText: e.Err, ttl: e.TTL,
		defaultModel: e.DefaultModel, defaultProtocol: e.DefaultProtocol,
		bindingID: e.BindingID, boundModel: e.BoundModel, boundProtocol: e.BoundProtocol,
		boundDecision: e.BoundDecision, boundDecisionExp: e.BoundDecisionExp,
		boundMaxOutput: e.BoundMaxOutput, boundTools: e.BoundTools}
	a.grantMu.Lock()
	ch := a.grantWaiters[e.ID]
	a.grantMu.Unlock()
	if ch == nil {
		log.Printf("model grant dropped: no waiter run=%s", e.ID)
		return
	}
	select {
	case ch <- reply:
	default:
		log.Printf("model grant dropped: waiter busy run=%s", e.ID)
	}
}

// smartSummaryRunes 是发给 Hub 的摘要上限。共享契约要求摘要非空且不超过
// taskrouting.MaxSummaryRunes（4096）；这里取一个远小于上限的有界值，
// 避免把整段用户内容搬上信令。
const smartSummaryRunes = 512

// boundedSummary 由本次回合的目标文本形成有界摘要。空摘要会被共享路由直接拒绝
// （internal/taskrouting/encode.go:32-34），所以这里保证至少给出一个可操作摘要。
func boundedSummary(text string) string {
	s := strings.TrimSpace(text)
	if s == "" {
		return "本地智能回合"
	}
	runes := []rune(s)
	if len(runes) <= smartSummaryRunes {
		return s
	}
	return string(runes[:smartSummaryRunes-1]) + "…"
}

// requestModelGrant 申请一次访问码。
//
// runID 是**稳定**的回合标识，correlation 只用于匹配本次请求与回复。两者必须分开：
// 若把 "run-1-refresh" 当成 run 发给 Hub，同一个 run 会在 Hub 侧留下两个 RunID，
// 续签就查不到原绑定。旧行为（用 runID+"-refresh" 当 ID）因此改为：ID 变、Run 不变。
// smart 为真时请求 Hub 代选型；binding 非空表示要复用已存在的可信绑定。
// brief/requiresTools 只在首次智能选型时使用（Hub 侧 resolve 需要真实摘要与工具需求）。
// notifyRunEnd 用现有 model-grant 信令的窄操作通知 Hub：本回合已结束。
// 它不是新的调度器，也不改变会话绑定——Hub 侧只清该 Run 的授权。
func (a *nodeAgent) notifyRunEnd(runID string) {
	a.cmu.Lock()
	cn := a.cn
	a.cmu.Unlock()
	if cn == nil {
		return
	}
	if err := cn.sendSig(&sig{K: "model-grant-end", Run: strings.TrimSpace(runID), FP: a.id.FP}); err != nil {
		log.Printf("run end notify failed: run=%s err=%v", runID, err)
	}
}

func (a *nodeAgent) requestModelGrant(ctx context.Context, runID, correlation string, smart bool, binding, brief string, requiresTools bool) (modelGrantReply, error) {
	return a.requestModelGrantOp(ctx, runID, correlation, smart, binding, brief, requiresTools, false)
}

func (a *nodeAgent) renewModelGrant(ctx context.Context, runID, correlation string, smart bool, binding string) (modelGrantReply, error) {
	return a.requestModelGrantOp(ctx, runID, correlation, smart, binding, "", false, true)
}

func (a *nodeAgent) requestModelGrantOp(ctx context.Context, runID, correlation string, smart bool, binding, brief string, requiresTools, renew bool) (modelGrantReply, error) {
	runID = strings.TrimSpace(runID)
	correlation = strings.TrimSpace(correlation)
	if runID == "" {
		return modelGrantReply{}, fmt.Errorf("grant run id required")
	}
	if correlation == "" {
		correlation = runID
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return modelGrantReply{}, err
	}
	a.cmu.Lock()
	cn := a.cn
	a.cmu.Unlock()
	if cn == nil {
		return modelGrantReply{}, fmt.Errorf("not connected")
	}
	ch := make(chan modelGrantReply, 1)
	a.grantMu.Lock()
	if a.grantWaiters == nil {
		a.grantWaiters = map[string]chan modelGrantReply{}
	}
	if _, exists := a.grantWaiters[correlation]; exists {
		a.grantMu.Unlock()
		return modelGrantReply{}, fmt.Errorf("duplicate grant waiter")
	}
	a.grantWaiters[correlation] = ch
	a.grantMu.Unlock()
	defer func() {
		a.grantMu.Lock()
		delete(a.grantWaiters, correlation)
		a.grantMu.Unlock()
	}()

	log.Printf("model grant request: run=%s correlation=%s smart=%v fp=%s", runID, correlation, smart, a.id.FP)
	if err := cn.sendSig(&sig{K: "model-grant", ID: correlation, FP: a.id.FP,
		Run: runID, Smart: smart, Binding: binding, Renew: renew,
		Brief: brief, RequiresTools: requiresTools}); err != nil {
		return modelGrantReply{}, err
	}
	timer := time.NewTimer(12 * time.Second)
	defer timer.Stop()
	select {
	case <-a.quit:
		return modelGrantReply{}, fmt.Errorf("node stopping")
	case <-ctx.Done():
		// 授权等待期 abort：不把取消当成拿到码，也不把它当成成功。
		return modelGrantReply{}, ctx.Err()
	case <-timer.C:
		return modelGrantReply{}, fmt.Errorf("model grant timeout")
	case reply := <-ch:
		if reply.errText != "" {
			return modelGrantReply{}, fmt.Errorf("%s", reply.errText)
		}
		if reply.code == "" {
			return modelGrantReply{}, fmt.Errorf("empty model grant")
		}
		log.Printf("model grant received: run=%s ttl=%d", runID, reply.ttl)
		return reply, nil
	}
}

// ---- 宿主会话 ----

func (a *nodeAgent) hostStatePath() string {
	return filepath.Join(confDir(), hostStateFile)
}

func (a *nodeAgent) nativeSessionDir() string {
	return filepath.Join(confDir(), hostNativeDir)
}

func (a *nodeAgent) hostSession() *hostSession {
	a.sessMu.Lock()
	defer a.sessMu.Unlock()
	if a.hostSess == nil {
		a.hostSess = newHostSession(a.hostStatePath(), func() (*agent.SessionStore, error) {
			return agent.OpenSessionStore(a.nativeSessionDir())
		})
	}
	return a.hostSess
}

func (a *nodeAgent) saveHostState() error {
	return a.hostSession().save()
}

// currentCwd 是本机 Agent 的运行目录：node 进程自己的工作目录，与旧循环一致。
func currentCwd() string {
	if wd, err := os.Getwd(); err == nil && strings.TrimSpace(wd) != "" {
		return wd
	}
	return "."
}

func (a *nodeAgent) agentCwd() string { return currentCwd() }

// hostSystemPrompt 是宿主基础系统提示（新会话保存一次，续接时按精确文本绑定）。
func hostSystemPrompt() string {
	wd, err := os.Getwd()
	if err != nil || strings.TrimSpace(wd) == "" {
		wd = "."
	}
	return fmt.Sprintf(
		"You are a local coding agent on %s/%s. Working directory: %s. "+
			"Use tools for files and commands. Keep a short task board with todo_write when work has multiple steps. "+
			"Ask the user with ask_user before destructive changes. Stop when the objective is done and answer concisely.",
		runtime.GOOS, runtime.GOARCH, wd,
	)
}

// ---- 访问码 + hub /v1 的 agent.Provider 适配 ----
//
// 只在 401/403 时做一次有界刷新，重试分类复用 providers；模型协议解析与流式增量
// 全部由 providers 完成，node 不复制一份 model.go。

type hostProvider struct {
	// cfg 是 Hub 目录解析出来的配置（含 nodeGatewayClient 注入的 transport）；APIKey
	// 每次续签都会刷新。它绝不含网关服务令牌——node 只有本次执行的 model-grant。
	cfg   providers.Config
	grant *nodeGrant
	// maxOutputTokens 是本次可信授权的输出上限：由 Hub 下发，必须落在真实请求上，
	// 否则共享网关会按"无上限/超上限"拒绝（routing.go:493-505）。
	// 0 表示旧 default/explicit 路径，不施加新约束。
	maxOutputTokens int

	refresh func(context.Context) (string, error)
	emit    func(agentEvent)

	mu    sync.Mutex
	inner agent.Provider
}

// protocol 是本次 run 解析出来的协议，也是宿主会话身份的一半（见 sessionBinding）。
func (p *hostProvider) protocol() string { return p.cfg.API }

// model 是目录解析后的真实模型 id：绑定与宿主都用它，而不是帧里的 default 哨兵。
func (p *hostProvider) model() string { return p.cfg.Model }

func newHostProvider(cfg providers.Config, grant *nodeGrant, maxOutputTokens int, refresh func(context.Context) (string, error), emit func(agentEvent)) (*hostProvider, error) {
	if grant == nil {
		grant = newNodeGrant(cfg.APIKey)
	}
	p := &hostProvider{cfg: cfg, grant: grant, maxOutputTokens: maxOutputTokens, refresh: refresh, emit: emit}
	if err := p.setToken(grant.get()); err != nil {
		return nil, err
	}
	return p, nil
}

// setToken 更新本次 run 的 model-grant：grant 持有者（transport 注入的 Authorization）
// 与 providers 自己的配置一起换，保证重试用的是同一个新码。只在本进程内存中；
// 绝不落盘、绝不打印。
func (p *hostProvider) setToken(token string) error {
	cfg := p.cfg
	cfg.APIKey = token
	inner, err := providers.New(cfg)
	if err != nil {
		return err
	}
	p.grant.set(token)
	p.mu.Lock()
	p.inner = inner
	p.mu.Unlock()
	return nil
}

func (p *hostProvider) current() agent.Provider {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.inner
}

func (p *hostProvider) retryEvent(detail, text string) {
	if p.emit == nil {
		return
	}
	e := hostEventBase("retry", "", detail)
	e.Output = text
	p.emit(e)
}

func (p *hostProvider) Complete(ctx context.Context, request agent.Request, emit func(agent.Event)) (agent.Response, error) {
	streamed := false
	wrap := func(e agent.Event) {
		if e.Type != "usage" {
			streamed = true
		}
		if emit != nil {
			emit(e)
		}
	}
	// 收紧输出上限：只在可信授权给出上限时生效（旧路径不改变行为）。
	if p.maxOutputTokens > 0 && (request.MaxTokens <= 0 || request.MaxTokens > p.maxOutputTokens) {
		request.MaxTokens = p.maxOutputTokens
	}
	resp, err := p.current().Complete(ctx, request, wrap)
	if err == nil {
		return resp, nil
	}
	if ctx.Err() != nil {
		return resp, ctx.Err()
	}
	// 已经流出过内容就绝不重放：重复的增量会被当成新输出。
	if streamed || !hostAuthExpired(err) || p.refresh == nil {
		return resp, err
	}
	// 只做一次有界续签：访问码过期（401/403）时重新要一次码，然后用它重试一次。
	// 供应商错误本身交共享 gateway/providers 处理，宿主不自造通用重试层。
	next, rerr := p.refresh(ctx)
	if rerr != nil || strings.TrimSpace(next) == "" {
		log.Printf("node model grant refresh failed: err=%v", rerr)
		return resp, err
	}
	if serr := p.setToken(next); serr != nil {
		log.Printf("node model grant refresh rejected: err=%v", serr)
		return resp, err
	}
	p.retryEvent("refreshed model grant", "auth")
	retry, retryErr := p.current().Complete(ctx, request, emit)
	if retryErr == nil {
		return retry, nil
	}
	if ctx.Err() != nil {
		return retry, ctx.Err()
	}
	return retry, retryErr
}

// ---- 事件映射：原生事件 -> 现 Web 的 agent-event ----

func hostEventBase(kind, title, detail string) agentEvent {
	return newAgentEvent(kind, "running", "local", "Local Agent", "operator", title, detail)
}

func boardEvent(t hostTask) agentEvent {
	e := hostEventBase("task_update", t.ID, t.Status)
	e.StepID = t.ID
	e.Output = t.Title
	return e
}

func bashEvent(kind, id, text, detail string) agentEvent {
	e := hostEventBase(kind, "", detail)
	e.StepID = id
	e.Output = text
	return e
}

func callName(call *agent.ToolCall) string {
	if call == nil {
		return ""
	}
	return call.Name
}

func callID(call *agent.ToolCall) string {
	if call == nil {
		return ""
	}
	return call.ID
}

func resultText(result *agent.ToolResult) string {
	if result == nil {
		return ""
	}
	var b strings.Builder
	for _, c := range result.Content {
		if c.Type == "text" {
			b.WriteString(c.Text)
		}
	}
	return b.String()
}

// hostLoopEvent 映射共享引擎的回合内事件。返回 false 表示该事件不在 Web 协议里
// （例如 usage、thinking_delta、tool_call_delta），不是错误。
func hostLoopEvent(ev agent.Event) (agentEvent, bool) {
	switch ev.Type {
	case "text_delta":
		e := hostEventBase("text_delta", "", "")
		e.Output = ev.Text
		return e, true
	case "tool_start":
		e := hostEventBase("tool_start", callName(ev.Call), "")
		e.StepID = callID(ev.Call)
		return e, true
	case "tool_result":
		status := "ok"
		if ev.Result != nil && ev.Result.IsError {
			status = "error"
		}
		e := hostEventBase("tool_end", callName(ev.Call), status)
		e.StepID = callID(ev.Call)
		e.Output = clipText(resultText(ev.Result), 500)
		return e, true
	case "compaction_start", "compaction_done", "compaction_error":
		e := hostEventBase("compact", "", ev.Text)
		return e, true
	}
	return agentEvent{}, false
}

func clipText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// ---- 宿主工具 ----

type hostTool struct {
	spec agent.ToolSpec
	run  func(ctx context.Context, args map[string]any) (string, error)
}

func (t hostTool) Spec() agent.ToolSpec { return t.spec }

func (t hostTool) Execute(ctx context.Context, raw json.RawMessage) (agent.ToolResult, error) {
	args := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return agent.ToolResult{}, fmt.Errorf("bad tool arguments: %v", err)
		}
	}
	out, err := t.run(ctx, args)
	if err != nil {
		return agent.ToolResult{}, err
	}
	return agent.ToolResult{Content: []agent.Content{{Type: "text", Text: out}}}, nil
}

func toolSpec(name, description string, props map[string]any, required []string, readOnly bool) agent.ToolSpec {
	schema, _ := json.Marshal(map[string]any{"type": "object", "properties": props, "required": required})
	return agent.ToolSpec{Name: name, Description: description, Parameters: schema, ReadOnly: readOnly}
}

func objProp(kind string) map[string]any { return map[string]any{"type": kind} }

// localTools 是本机文件/命令工具，全部经宿主注册（Host.Tools 是完整工具源）。
func (a *nodeAgent) localTools() []agent.Tool {
	return []agent.Tool{
		hostTool{
			spec: toolSpec("exec", "Run a shell command on this machine.",
				map[string]any{"cmd": objProp("string"), "cwd": objProp("string")}, []string{"cmd"}, false),
			run: func(ctx context.Context, args map[string]any) (string, error) {
				cmd, _ := args["cmd"].(string)
				cwd, _ := args["cwd"].(string)
				return a.runLocalExec(ctx, cmd, cwd)
			},
		},
		hostTool{
			spec: toolSpec("read_file", "Read a text file on this machine.",
				map[string]any{"path": objProp("string")}, []string{"path"}, true),
			run: func(ctx context.Context, args map[string]any) (string, error) {
				p, _ := args["path"].(string)
				path, err := expandPath(p)
				if err != nil {
					return "", err
				}
				raw, err := os.ReadFile(path)
				if err != nil {
					return "", err
				}
				if len(raw) > maxNodeAgentStepOutput {
					raw = raw[:maxNodeAgentStepOutput]
				}
				return string(raw), nil
			},
		},
		hostTool{
			spec: toolSpec("write_file", "Write a text file on this machine. Parent directories are created.",
				map[string]any{"path": objProp("string"), "content": objProp("string")}, []string{"path", "content"}, false),
			run: func(ctx context.Context, args map[string]any) (string, error) {
				p, _ := args["path"].(string)
				content, _ := args["content"].(string)
				path, err := expandPath(p)
				if err != nil {
					return "", err
				}
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					return "", err
				}
				log.Printf("local agent write: path=%s bytes=%d", path, len(content))
				if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
					return "", err
				}
				return fmt.Sprintf("written %s (%d bytes)", path, len(content)), nil
			},
		},
		hostTool{
			spec: toolSpec("list_dir", "List files and directories at a path on this machine.",
				map[string]any{"path": objProp("string")}, []string{"path"}, true),
			run: func(ctx context.Context, args map[string]any) (string, error) {
				p, _ := args["path"].(string)
				return a.listDir(p)
			},
		},
		hostTool{
			spec: toolSpec("search_text", "Search file contents on this machine by regex. Skips .git/node_modules/dist/data and files over 1MB. Returns path:line matches.",
				map[string]any{"path": objProp("string"), "pattern": objProp("string")}, []string{"path", "pattern"}, true),
			run: func(ctx context.Context, args map[string]any) (string, error) {
				p, _ := args["path"].(string)
				pat, _ := args["pattern"].(string)
				return a.searchText(ctx, p, pat)
			},
		},
		hostTool{
			spec: toolSpec("patch_file", "Replace an exact string in a text file on this machine. Fails if old occurs 0 or >1 times unless all=true.",
				map[string]any{"path": objProp("string"), "old": objProp("string"), "new": objProp("string"), "all": objProp("boolean")}, []string{"path", "old", "new"}, false),
			run: func(ctx context.Context, args map[string]any) (string, error) {
				p, _ := args["path"].(string)
				old, _ := args["old"].(string)
				next, _ := args["new"].(string)
				all, _ := args["all"].(bool)
				return a.patchFile(p, old, next, all)
			},
		},
	}
}

func (a *nodeAgent) runLocalExec(ctx context.Context, cmd, cwd string) (string, error) {
	var b strings.Builder
	code, errMsg := a.execCommand(ctx, nil, "loop", cmd, cwd, 0, "utf8", func(raw []byte) { b.Write(raw) })
	if errMsg != "" {
		return b.String(), fmt.Errorf("%s", errMsg)
	}
	if code != 0 {
		return b.String(), fmt.Errorf("exit %d", code)
	}
	return b.String(), nil
}

// hostTools 是完整工具源：本机工具 + 任务板 + UI 确认 + 旁路命令 + delegate。
// emitTo 按任务 id 投递事件，让子会话的事件不会挂到父回合的 runID 上。
func (a *nodeAgent) hostTools(cn *conn, runID, model string, provider agent.Provider, emit func(agentEvent)) nativeapp.ToolFactory {
	emitTo := func(taskID string, e agentEvent) { a.sendAgentEvent(cn, taskID, e) }
	return func(session agent.Session) ([]agent.Tool, func() error, error) {
		sess := a.hostSession()
		tools := a.localTools()
		tools = append(tools,
			sess.todoTool(emit),
			sess.askTool(emit),
			a.bashTool(sess),
			a.delegateTool(sess, model, provider, emitTo),
		)
		return tools, nil, nil
	}
}

func (a *nodeAgent) bashTool(sess *hostSession) agent.Tool {
	return hostTool{
		spec: toolSpec("bash", "Run a shell command on a side channel. It can be aborted without canceling the agent turn.",
			map[string]any{"cmd": objProp("string"), "cwd": objProp("string")}, []string{"cmd"}, false),
		run: func(ctx context.Context, args map[string]any) (string, error) {
			cmd, _ := args["cmd"].(string)
			cwd, _ := args["cwd"].(string)
			return a.runSideCommand(ctx, sess, "", cmd, cwd, nil)
		},
	}
}

// delegateTool 保留旧语义：一个窄子任务、不能再次委派、每回合最多 3 个。子任务
// 用同一条 nativeapp.Run 独立会话执行，而不是旧循环里的同会话嵌套。
func (a *nodeAgent) delegateTool(sess *hostSession, model string, provider agent.Provider, emitTo func(taskID string, e agentEvent)) agent.Tool {
	return hostTool{
		spec: toolSpec("delegate", "Run one narrow subagent on this machine. It can use local tools but cannot delegate again. At most 3 delegates per turn.",
			map[string]any{"title": objProp("string"), "objective": objProp("string")}, []string{"objective"}, false),
		run: func(ctx context.Context, args map[string]any) (string, error) {
			objective, _ := args["objective"].(string)
			title, _ := args["title"].(string)
			objective = strings.TrimSpace(objective)
			if objective == "" {
				return "", fmt.Errorf("objective required")
			}
			if strings.TrimSpace(title) == "" {
				title = clipText(objective, 60)
			}
			if !sess.reserveDelegate() {
				return "", fmt.Errorf("delegate limit reached")
			}
			id := sess.nextID("sub")
			board := func(t hostTask) { sess.upsertTask(t, func(e agentEvent) { emitTo(id, e) }) }
			board(hostTask{ID: id, Title: title, Status: "running", Kind: "subagent", Detail: objective})
			started := time.Now()
			result, err := nativeapp.Run(ctx, nativeapp.Options{
				SessionDir: a.nativeSessionDir(),
				Cwd:        a.agentCwd(),
				Prompt:     objective,
				MaxTurns:   hostMaxTurns,
				Host: &nativeapp.Host{
					Provider:   provider,
					ProviderID: hostProviderID,
					Model:      model,
					System:     hostSystemPrompt(),
					Tools: func(agent.Session) ([]agent.Tool, func() error, error) {
						return a.localTools(), nil, nil
					},
				},
			}, func(ev agent.Event) {
				// 子会话的事件必须与父回合隔离：
				//   - text_delta 会被 Web 的 onLocalAgentEvent 追加进父的流式气泡；
				//   - text/agent_end 会结束父回合。
				// 所以只保留子任务可观察的进度与工具事件，且按子任务 id 归属；
				// 子任务的最终答复仍通过本工具的返回值回到父回合。
				if ev.Type == "text_delta" {
					return
				}
				if mapped, ok := hostLoopEvent(ev); ok {
					emitTo(id, mapped)
				}
			})
			if err != nil {
				board(hostTask{ID: id, Title: title, Status: "failed", Kind: "subagent", Detail: err.Error()})
				return "", err
			}
			board(hostTask{ID: id, Title: title, Status: "done", Kind: "subagent"})
			log.Printf("local agent subagent finish: id=%s elapsed=%s", id, time.Since(started).Round(time.Millisecond))
			return result.Message.Text(), nil
		},
	}
}

// ---- 旁路命令：独立于回合，可单独取消 ----

func (a *nodeAgent) runSideBash(cn *conn, f *dcf) {
	id := f.ID
	if id == "" {
		id = hexID()
	}
	cmd := strings.TrimSpace(f.Cmd)
	if cmd == "" {
		cmd = strings.TrimSpace(f.Msg)
	}
	log.Printf("side bash request: id=%s", id)
	_, err := a.runSideCommand(context.Background(), a.hostSession(), id, cmd, f.Cwd, func(e agentEvent) {
		a.sendAgentEvent(cn, id, e)
	})
	if err != nil {
		log.Printf("side bash failed: id=%s err=%v", id, err)
		a.out(cn, id, nil, true, -1, err.Error())
		return
	}
	a.out(cn, id, nil, true, 0, "")
}

// runSideCommand 一次只允许一条旁路命令（沿用旧 StartBash 的互斥语义）。
func (a *nodeAgent) runSideCommand(ctx context.Context, sess *hostSession, id, cmd, cwd string, emit func(agentEvent)) (string, error) {
	cmd = strings.TrimSpace(cmd)
	if cmd == "" {
		return "", fmt.Errorf("cmd required")
	}
	if id == "" {
		id = hexID()
	}
	runCtx, cancel := context.WithCancel(ctx)
	if err := sess.beginBash(id, cancel); err != nil {
		cancel()
		return "", err
	}
	defer func() {
		cancel()
		sess.endBash(id)
	}()
	if emit != nil {
		emit(bashEvent("bash_start", id, cmd, ""))
	}
	log.Printf("side bash start: id=%s", id)
	var b strings.Builder
	code, errMsg := a.execCommand(runCtx, nil, "bash", cmd, cwd, 0, "utf8", func(raw []byte) { b.Write(raw) })
	out := b.String()
	status := "done"
	var err error
	switch {
	case errMsg != "":
		err = errors.New(errMsg)
		status = errMsg
	case code != 0:
		err = fmt.Errorf("exit %d", code)
		status = err.Error()
	}
	if emit != nil {
		emit(bashEvent("bash_end", id, clipText(out, 500), status))
	}
	log.Printf("side bash finish: id=%s status=%s", id, status)
	return out, err
}

func frameText(f *dcf) string {
	if f == nil {
		return ""
	}
	if f.Task != nil && strings.TrimSpace(f.Task.Objective) != "" {
		return f.Task.Objective
	}
	return f.Msg
}

func hubAPIBase(hub string) string {
	h := strings.TrimSpace(hub)
	switch {
	case strings.HasPrefix(h, "https://"), strings.HasPrefix(h, "http://"):
	case strings.HasPrefix(h, "wss://"):
		h = "https://" + strings.TrimPrefix(h, "wss://")
	case strings.HasPrefix(h, "ws://"):
		h = "http://" + strings.TrimPrefix(h, "ws://")
	default:
		h = "http://" + h
	}
	h = strings.TrimRight(h, "/")
	h = strings.TrimSuffix(h, "/ws")
	return h
}

// runLocalAgent 处理 agent-loop：一次 nativeapp.Run。
func (a *nodeAgent) runLocalAgent(cn *conn, f *dcf) {
	objective := strings.TrimSpace(f.Msg)
	if f.Task != nil && strings.TrimSpace(f.Task.Objective) != "" {
		objective = strings.TrimSpace(f.Task.Objective)
	}
	runID := f.ID
	if runID == "" {
		runID = hexID()
	}
	if objective == "" {
		a.out(cn, runID, nil, true, -1, "objective required")
		return
	}
	sess := a.hostSession()
	// 宿主状态不可信（损坏/IO 失败）时阻断回合：不用空状态继续，也不覆盖原文件。
	if err := sess.blockedErr(); err != nil {
		a.out(cn, runID, nil, true, -1, err.Error())
		return
	}
	// 原子占位在任何网络等待之前完成，并在同一把锁下登记取消：abort 不丢。
	// 两个并发 agent-loop 只有一个能进入引擎，另一个按既有排队语义处理。
	ctx, cancel, ok := sess.reserveTurn(runID)
	if !ok {
		if err := sess.followUp(objective); err != nil {
			a.out(cn, runID, nil, true, -1, err.Error())
			return
		}
		log.Printf("local agent follow-up queued: run=%s", runID)
		a.out(cn, runID, nil, true, -1, "session busy; follow-up queued")
		return
	}
	// 从这里开始每条失败/拒绝/取消路径都必须释放占位。
	released := false
	release := func() {
		if released {
			return
		}
		released = true
		sess.releaseTurn()
	}
	defer release()

	if !a.registerRun(runID, cancel, true) {
		cancel()
		a.out(cn, runID, nil, true, -1, "duplicate task id")
		return
	}
	defer func() {
		cancel()
		a.unregisterRun(runID, true)
		// Run 结束通知：成功、失败、取消都走这里，让 Hub 只清这次回合的授权
		// （仍有效的会话 pin 保留）。异常丢通知时由 Hub 侧有界到期清理兜底，
		// 不因此引入重试或第二套调度。
		if f.Smart {
			a.notifyRunEnd(runID)
		}
	}()
	// 中止帧可能早于本 goroutine 登记到达：registerRun 已让它立刻生效。
	if err := ctx.Err(); err != nil {
		log.Printf("local agent aborted before start: run=%s", runID)
		a.out(cn, runID, nil, true, -1, err.Error())
		return
	}

	frameModel := strings.TrimSpace(f.Model)
	log.Printf("local agent start: run=%s fp=%s model=%q protocol=%q smart=%v", runID, a.id.FP, frameModel, strings.TrimSpace(f.Protocol), f.Smart)
	// 智能路径：Smart 与显式 Model/Protocol 同时给出是冲突组合，必须在发起模型调用前
	// 明确拒绝，不能静默忽略本地输入。
	if f.Smart && (frameModel != "" || strings.TrimSpace(f.Protocol) != "") {
		log.Printf("local agent smart conflict: run=%s model=%q protocol=%q", runID, frameModel, strings.TrimSpace(f.Protocol))
		a.out(cn, runID, nil, true, -1, "smart 路径不接受同时指定 model/protocol：请只勾选智能，或改回显式选择")
		return
	}
	// 已有非智能会话不能被智能接管：本片没有能力证明是同一身份，保留原历史。
	existing, hasIdentity := sess.currentIdentity()
	if !f.Smart && sess.bindingID() != "" {
		a.out(cn, runID, nil, true, -1, "this session has a smart binding; continue in smart mode or start a new session")
		return
	}
	if f.Smart && hasIdentity && sess.bindingID() == "" {
		log.Printf("local agent smart takeover refused: run=%s existing=%s", runID, existing)
		a.out(cn, runID, nil, true, -1, "本会话已按 "+existing+" 建立身份，智能路径不接管既有历史：请新建会话")
		return
	}
	// 首次智能选型需要真实摘要与工具需求：空摘要会被共享路由直接拒绝。
	grant, err := a.requestModelGrant(ctx, runID, runID, f.Smart, sess.bindingID(),
		boundedSummary(frameText(f)), true)
	if err != nil {
		log.Printf("local agent grant failed: run=%s err=%v", runID, err)
		a.out(cn, runID, nil, true, -1, err.Error())
		return
	}
	if f.Smart {
		if err := validateSmartGrant(grant, nil); err != nil {
			a.out(cn, runID, nil, true, -1, err.Error())
			return
		}
	}
	emit := func(e agentEvent) { a.sendAgentEvent(cn, runID, e) }
	// 空/default 由 Hub 随 grant 下发的默认模型解析（缺默认是可操作错误，不猜字面 id）。
	// 协议优先级：显式 > 续接同一模型的已有会话记录（旧会话只有 chat）> 默认模型的默认协议；
	// 都没有时留空交给 Hub 目录，绝不把新会话隐式绑到 chat。
	// 智能路径用 Hub 下发的**可信**元组，不走"默认模型兜底"：元组只来自 Hub 侧的可信
	// 绑定记录，客户端自报字段一律不作为授权事实。
	var model, protocol string
	if f.Smart {
		model = strings.TrimSpace(grant.boundModel)
		protocol = strings.TrimSpace(grant.boundProtocol)
	} else {
		model, err = resolveFrameModel(frameModel, grant.defaultModel)
		if err != nil {
			log.Printf("local agent model selection failed: run=%s err=%v", runID, err)
			a.out(cn, runID, nil, true, -1, err.Error())
			return
		}
		protocol = resolveFrameProtocol(f.Protocol, sess.sessionProtocolHint(model), grant.defaultProtocol,
			model == strings.TrimSpace(grant.defaultModel))
	}
	provider, err := a.newNodeProvider(ctx, runID, model, protocol, grant.code, runID, grant.bindingID, grant.boundMaxOutput, func(ctx context.Context) (string, error) {
		// 续签只换令牌：它绝不改变本次 run 已经确定的 model/protocol，元数据一律忽略。
		// Run 保持同一个，只有 correlation 变化——否则 Hub 侧会多出一个 RunID。
		// 智能续签必须显式携带同一可信 Run/Binding，否则会退入旧宽授权。
		next, err := a.renewModelGrant(ctx, runID, runID+"-refresh", f.Smart, grant.bindingID)
		if err != nil {
			return "", err
		}
		if f.Smart {
			if err := validateSmartGrant(next, &grant); err != nil {
				return "", err
			}
		}
		log.Printf("local agent grant refreshed: run=%s", runID)
		return next.code, nil
	}, emit)
	if err != nil {
		log.Printf("local agent provider failed: run=%s err=%v", runID, err)
		a.out(cn, runID, nil, true, -1, err.Error())
		return
	}
	// 目录解析后的真实 model/protocol 才是本次 run 的身份：绑定、宿主与事件都用它。
	model, protocol = provider.model(), provider.protocol()
	if f.Smart && (model != grant.boundModel || protocol != grant.boundProtocol) {
		a.out(cn, runID, nil, true, -1, "directory identity differs from the trusted smart binding")
		return
	}
	log.Printf("local agent selection resolved: run=%s model=%s protocol=%s", runID, model, protocol)
	var sessionID, switchedFrom string
	if f.Smart {
		sessionID, err = sess.smartSessionBinding(model, protocol, grant.bindingID, grant.boundDecision)
	} else {
		sessionID, switchedFrom, err = sess.sessionBinding(model, protocol)
	}
	if err != nil {
		// 换绑/绑定没法确认或没法落盘：本回合可见地失败，绝不留一份没落盘的绑定。
		log.Printf("local agent session binding failed: run=%s err=%v", runID, err)
		a.out(cn, runID, nil, true, -1, err.Error())
		return
	}
	if switchedFrom != "" {
		log.Printf("local agent session switch: run=%s from=%s model=%s protocol=%s", runID, switchedFrom, model, protocol)
		e := hostEventBase("session", "", "switch to "+model+" over "+protocol+"; a new native session was started")
		e.Output = "session switch: " + model + " (" + protocol + ")"
		emit(e)
	}
	// 旧 agent-loop.json 的历史是在 chat wire 上录下来的：只有本次协议也是 chat 才导入，
	// 否则就是跨协议重新解释 opaque 历史。不导入时旧记录原样保留（不删除、不假装已迁移）。
	if sessionID == "" && protocol == providers.OpenAICompletions {
		// 旧历史在这里（已知本次 model）交给共享核心导入。导入失败（损坏/未决/核心拒绝）
		// 必须阻断本回合：不用新空会话顶替旧历史。
		id, err := sess.importLegacyHistory(model)
		if err != nil {
			log.Printf("legacy agent-loop history blocked: run=%s err=%v", runID, err)
			a.out(cn, runID, nil, true, -1, err.Error())
			return
		}
		if id != "" {
			sessionID = id
			log.Printf("local agent resumes imported legacy history: run=%s session=%s", runID, id)
		}
	} else if sessionID == "" {
		log.Printf("legacy agent-loop history kept pending: protocol=%s is not the chat wire it was recorded on: run=%s", protocol, runID)
	}
	// 旧队列（无投递标识）保持 paused：本切片不自动投递，见 node_legacy.go。
	turnID := sess.beginTurn(objective)
	emit(boardEvent(hostTask{ID: turnID, Title: clipText(objective, 80), Status: "running", Kind: "turn"}))

	// 本轮工作区上下文按显式上下文附加到 prompt 上，不改变已保存的 system 绑定。
	prompt := objective
	if brief := strings.TrimSpace(f.Brief); brief != "" {
		prompt = objective + "\n\n[本轮工作区上下文 / workspace context, this turn only]\n" + brief
	}
	runEmit := func(ev agent.Event) {
		switch ev.Type {
		case "message":
			if ev.Message == nil {
				return
			}
			// 只按共享核心的投递回执确认：不按文本、不按顺序、不按回合位置。
			if ev.Delivery != nil {
				sess.ackDelivery(ev.Delivery)
			}
			switch ev.Message.Role {
			case "user":
				if ev.Delivery == nil {
					return // 本轮 prompt 不是排队投递
				}
				e := hostEventBase("steer", "", "")
				e.Output = ev.Message.Text()
				emit(e)
			case "assistant":
				if len(ev.Message.ToolCalls) == 0 {
					e := hostEventBase("text", "", "")
					e.Output = ev.Message.Text()
					emit(e)
				}
			}
			return
		}
		if mapped, ok := hostLoopEvent(ev); ok {
			emit(mapped)
		}
	}

	host := &nativeapp.Host{
		Provider:   provider,
		ProviderID: hostProviderID,
		Model:      model,
		System:     hostSystemPrompt(),
		Tools:      a.hostTools(cn, runID, model, provider, emit),
	}
	runOpts := nativeapp.Options{
		SessionDir:  a.nativeSessionDir(),
		SessionID:   sessionID,
		Cwd:         a.agentCwd(),
		Prompt:      prompt,
		MaxTurns:    hostMaxTurns,
		Control:     sess.control,
		AutoCompact: sess.compactionPolicy(),
		Host:        host,
	}
	if sessionID == "" {
		// 新会话先取得 ID 并原子落盘绑定，再跑回合：回合结束前崩溃也能找到 journal，
		// 而不是留下一份无人引用的会话。
		createOpts := runOpts
		createOpts.SessionID = ""
		createOpts.Prompt = ""
		created, err := nativeapp.CreateSession(ctx, createOpts)
		if err != nil {
			log.Printf("local agent session create failed: run=%s err=%v", runID, err)
			a.out(cn, runID, nil, true, -1, err.Error())
			return
		}
		if err := sess.setNativeID(created.ID); err != nil {
			log.Printf("local agent session binding not persisted: run=%s err=%v", runID, err)
			a.out(cn, runID, nil, true, -1, "session binding not persisted: "+err.Error())
			return
		}
		sessionID = created.ID
		runOpts.SessionID = created.ID
		log.Printf("local agent session created: run=%s session=%s", runID, created.ID)
	}
	result, runErr := nativeapp.Run(ctx, runOpts, runEmit)
	release()

	status, detail := "completed", ""
	if runErr != nil {
		status, detail = "failed", runErr.Error()
		if errors.Is(runErr, context.Canceled) || errors.Is(runErr, context.DeadlineExceeded) {
			status = "canceled"
		}
	}
	// 回合结束的绑定与宿主状态必须真正落盘。保存失败是**可见的回合失败**：
	// 不能只记日志再 out code 0，也不留下一份没落盘的绑定（setNativeID 会回滚）。
	// journal 原样留在磁盘上，修好状态文件后仍然可以续接。
	persistErr := sess.setNativeID(result.SessionID)
	if persistErr != nil && status == "completed" {
		status, detail = "failed", persistErr.Error()
	}
	emit(boardEvent(sess.finishTurn(turnID, status, detail)))
	if persistErr == nil {
		if err := a.saveHostState(); err != nil {
			persistErr = err
			if status == "completed" {
				status, detail = "failed", "host state not persisted: "+err.Error()
				emit(boardEvent(sess.finishTurn(turnID, status, detail)))
			}
		}
	}

	text := result.Message.Text()
	emit(hostEventBase("agent_end", status, detail))
	if runErr != nil {
		log.Printf("local agent failed: run=%s err=%v", runID, runErr)
		a.out(cn, runID, []byte(text), true, -1, detail)
		return
	}
	if persistErr != nil {
		log.Printf("local agent finished but host state was not persisted: run=%s session=%s err=%v",
			runID, result.SessionID, persistErr)
		a.out(cn, runID, []byte(text), true, -1, detail)
		return
	}
	log.Printf("local agent finish: run=%s bytes=%d session=%s", runID, len(text), result.SessionID)
	a.out(cn, runID, []byte(text), true, 0, "")
}

// publishLoopBoard 把任务板推回 UI（配对成功时调用）。
func (a *nodeAgent) publishLoopBoard(cn *conn) {
	if cn == nil {
		return
	}
	tasks := a.hostSession().tasks()
	log.Printf("node board publish: tasks=%d", len(tasks))
	for _, t := range tasks {
		a.sendAgentEvent(cn, "board", boardEvent(t))
	}
}
