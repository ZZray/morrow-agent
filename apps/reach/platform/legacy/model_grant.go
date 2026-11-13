package main

// 本次执行访问码：已授权且在线的 node 向 hub 申请短期码，只用于 /v1 调模型。
// 入网令牌不能开控制台，也不能直接打 /v1。

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

const modelGrantTTL = 15 * time.Minute

// smartRunHeader / smartBindingHeader 是 Node 随请求送来的**关联**信息。
//
// HTTP 只带 bearer 无法辨认调用方私下的 Run，因此智能请求额外带上这两个头，
// 由 Hub 与 code 的可信记录比对。它们明确**不是**权限来源：不能防持有正确
// bearer 与关联的重放，也不能防凭据盗用——权限仍只由 code 与绑定记录决定。
// Hub 转发前会剥离它们，绝不带到上游。
const (
	smartRunHeader     = "X-HandWave-Run"
	smartBindingHeader = "X-HandWave-Binding"
)

type modelGrant struct {
	FP    string
	RunID string
	Exp   time.Time
}

type grantBook struct {
	mu sync.Mutex
	by map[string]*modelGrant // code -> grant
}

func (h *hubSrv) grants() *grantBook {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.grant == nil {
		h.grant = &grantBook{by: map[string]*modelGrant{}}
	}
	return h.grant
}

// bindings 返回智能路径的可信绑定账本。它与 grants() 分开：
// grant 只回答"这个 code 现在有效吗"，bindings 回答"这一 run 被授权了哪个具体元组/决策"。
func (h *hubSrv) bindings() *bindingBook {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.bind == nil {
		h.bind = newBindingBook()
	}
	return h.bind
}

func (g *grantBook) put(code string, gr *modelGrant) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	for k, v := range g.by {
		if v.Exp.Before(now) {
			delete(g.by, k)
		}
	}
	g.by[code] = gr
}

func (g *grantBook) lookup(code string) (*modelGrant, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	gr, ok := g.by[code]
	if !ok || gr.Exp.Before(time.Now()) {
		if ok {
			delete(g.by, code)
		}
		return nil, false
	}
	return gr, true
}

func (g *grantBook) dropFP(fp string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for k, v := range g.by {
		if v.FP == fp {
			delete(g.by, k)
		}
	}
}

// deviceEligible 是设备资格门禁：屏蔽、离线、未批准一律拒绝。
// 智能路径**必须**与旧路径共用它——join 只建立节点映射，并不代表设备已获批。
func (h *hubSrv) deviceEligible(fp string) error {
	fp = strings.TrimSpace(fp)
	if fp == "" {
		return fmt.Errorf("fp required")
	}
	h.mu.Lock()
	err := h.deviceEligibleLocked(fp, nil)
	h.mu.Unlock()
	return err
}

// deviceEligibleLocked optionally also proves that the current FP mapping is
// still the WebSocket which requested the grant. That closes disconnect/rejoin
// and revoke races without changing the existing device lifecycle.
func (h *hubSrv) deviceEligibleLocked(fp string, c *websocket.Conn) error {
	if h.denied[fp] {
		return fmt.Errorf("device denied")
	}
	nid := h.devNode[fp]
	if nid == "" {
		return fmt.Errorf("device offline")
	}
	if c != nil {
		n := h.nodes[nid]
		if n == nil || n.ws != c {
			return fmt.Errorf("device connection changed")
		}
	}
	if !h.approvals[fp].live() {
		return fmt.Errorf("device not approved")
	}
	if !h.nodeApprovalMatchesLocked(h.nodes[nid]) {
		return fmt.Errorf("device identity requires renewed approval")
	}
	return nil
}

func (h *hubSrv) mintModelGrant(fp, runID string) (string, time.Time, error) {
	fp = strings.TrimSpace(fp)
	runID = strings.TrimSpace(runID)
	if fp == "" || runID == "" {
		return "", time.Time{}, fmt.Errorf("fp/run required")
	}
	if err := h.deviceEligible(fp); err != nil {
		return "", time.Time{}, err
	}
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", time.Time{}, err
	}
	code := hex.EncodeToString(buf)
	exp := time.Now().Add(modelGrantTTL)
	h.grants().put(code, &modelGrant{FP: fp, RunID: runID, Exp: exp})
	log.Printf("model grant issued: fp=%s run=%s ttl=%s", fp, runID, modelGrantTTL)
	return code, exp, nil
}

// endModelGrantRun 处理 Run 结束通知：只清该回合自身的授权，保留仍有效的会话 pin。
// FP 由**连接**确认（不是客户端自报），因此别的设备不能借通知清别人的记录。
// 异常丢通知时由绑定账本的有界到期清理兜底，这里不做重试、不建第二套调度。
func (h *hubSrv) endModelGrantRun(ctx context.Context, id string, s *sig) {
	h.mu.Lock()
	n := h.nodes[id]
	bk := h.bind
	fp := ""
	if n != nil {
		fp = n.fp
	}
	h.mu.Unlock()
	run := strings.TrimSpace(s.Run)
	if fp == "" || run == "" {
		log.Printf("run end ignored: conn=%s run=%q reason=not joined", id, run)
		return
	}
	if bk == nil {
		return
	}
	bk.endRun(fp, run)
	log.Printf("smart run ended: fp=%s run=%s", fp, run)
}

// issueSmartGrant 是智能路径的签发。
//
// 授权事实只来自 Hub 自己：pool/令牌是 Hub 配置的，resolve 由 Hub 发起，得到的
// 具体元组与决策钉到 (FP, BindingID)，再为本次 run 签一个 code。
// 客户端自报的 binding 只用于**指认**一个已存在的可信记录，找不到就拒绝，
// 绝不据此新建授权；自报的 model/protocol/decision 一律不作为授权事实。
func (h *hubSrv) issueSmartGrant(ctx context.Context, correlation string, c *websocket.Conn, s *sig, fp, run string) {
	// 智能路径不得绕过设备资格门禁：join 不等于批准。
	h.mu.Lock()
	eligibleErr := h.deviceEligibleLocked(fp, c)
	h.mu.Unlock()
	if eligibleErr != nil {
		log.Printf("smart grant denied: fp=%s run=%s reason=%v", fp, run, eligibleErr)
		h.denySmartGrant(ctx, c, correlation, eligibleErr.Error())
		return
	}
	bk := h.bindings()

	// 续签必须显式声明，并精确匹配原 Run/Binding。记录缺失或已结束时
	// 明确拒绝，绝不能把 refresh 当成新 Run 重新挂回去。
	if s.Renew {
		h.renewSmartGrant(ctx, correlation, c, fp, run, strings.TrimSpace(s.Binding))
		return
	}
	if existing, exists := bk.findRun(fp, run); exists {
		want := strings.TrimSpace(s.Binding)
		if want != "" && want != existing.BindingID {
			h.denySmartGrant(ctx, c, correlation, "run is already attached to a different binding")
			return
		}
		pin, ok := bk.findPin(fp, existing.BindingID)
		if !ok {
			h.denySmartGrant(ctx, c, correlation, "session binding is no longer trusted")
			return
		}
		h.sendSmartGrant(ctx, c, correlation, pin, existing)
		return
	}

	flight, leader := bk.joinRunIssue(fp, run)
	if !leader {
		select {
		case <-ctx.Done():
			h.denySmartGrant(ctx, c, correlation, ctx.Err().Error())
			return
		case <-flight.done:
		}
		if flight.err != nil {
			h.denySmartGrant(ctx, c, correlation, flight.err.Error())
			return
		}
		g, ok := bk.findRun(fp, run)
		if !ok {
			h.denySmartGrant(ctx, c, correlation, "run authorization was not published")
			return
		}
		want := strings.TrimSpace(s.Binding)
		if want != "" && want != g.BindingID {
			h.denySmartGrant(ctx, c, correlation, "run is already attached to a different binding")
			return
		}
		pin, ok := bk.findPin(fp, g.BindingID)
		if !ok {
			h.denySmartGrant(ctx, c, correlation, "session binding is no longer trusted")
			return
		}
		h.sendSmartGrant(ctx, c, correlation, pin, g)
		return
	}
	var issueErr error
	defer func() { bk.finishRunIssue(fp, run, flight, issueErr) }()
	// Another leader may have finished between the first lookup and joining.
	// Recheck after acquiring the flight before performing any fresh selection.
	if existing, exists := bk.findRun(fp, run); exists {
		want := strings.TrimSpace(s.Binding)
		pin, ok := bk.findPin(fp, existing.BindingID)
		if !ok || (want != "" && want != existing.BindingID) {
			issueErr = fmt.Errorf("run binding is missing or does not match")
			h.denySmartGrant(ctx, c, correlation, issueErr.Error())
			return
		}
		h.sendSmartGrant(ctx, c, correlation, pin, existing)
		return
	}

	var candidate sessionPin
	wantBinding := strings.TrimSpace(s.Binding)
	if wantBinding != "" {
		// 同会话的新 run：复用已有绑定，绝不再次 resolve（累计首次 auto resolve=1）。
		found, ok := bk.findPin(fp, wantBinding)
		if !ok {
			issueErr = fmt.Errorf("session binding is not trusted; start a new smart session")
			log.Printf("smart grant denied: fp=%s run=%s binding=%s reason=binding not trusted", fp, run, wantBinding)
			wsSend(ctx, c, &sig{K: "model-grant", ID: correlation, Err: "session binding is not trusted; start a new smart session"})
			return
		}
		candidate = *found
	} else {
		// 首次：Hub 侧 resolve 一次。summary/工具需求取自请求，元组取自网关决策。
		if h.gw == nil {
			issueErr = fmt.Errorf("gateway not configured")
			h.denySmartGrant(ctx, c, correlation, "gateway not configured")
			return
		}
		res, rerr := h.gw.resolveRouteOnce(ctx, correlation, strings.TrimSpace(s.Brief), s.RequiresTools)
		if rerr != nil {
			issueErr = rerr
			h.denySmartGrant(ctx, c, correlation, rerr.Error())
			return
		}
		dec := res.Decision
		if strings.TrimSpace(dec.Model) == "" || strings.TrimSpace(dec.Protocol) == "" || strings.TrimSpace(dec.DecisionID) == "" {
			issueErr = fmt.Errorf("route decision is incomplete")
			h.denySmartGrant(ctx, c, correlation, "route decision is incomplete")
			return
		}
		exp, xerr := time.Parse(time.RFC3339, strings.TrimSpace(res.ExpiresAt))
		if xerr != nil || !exp.After(time.Now()) {
			issueErr = fmt.Errorf("route decision expiry is missing, invalid or already expired")
			h.denySmartGrant(ctx, c, correlation, issueErr.Error())
			return
		}
		// 约束必须与 Hub 实际请求 resolve 时的一致（gateway.go:380-381）：
		// 共享网关会拒绝无输出上限或超上限的请求，写 0 等于把约束丢了，
		// 真实请求在网关侧会被拒（含 Anthropic 默认 8192 超过 4096 的情况）。
		candidate = sessionPin{
			Model:           dec.Model,
			Protocol:        dec.Protocol,
			DecisionID:      dec.DecisionID,
			DecisionExp:     exp,
			RequiresTools:   s.RequiresTools,
			MaxOutputTokens: smartMaxOutputTokens,
		}
	}

	// Publish only after rechecking the exact requesting connection while h.mu
	// is held. dropLocked/deny/revoke use the same h.mu -> bindingBook order, so
	// an approved connection cannot be revoked between this check and publish.
	h.mu.Lock()
	if issueErr = h.deviceEligibleLocked(fp, c); issueErr != nil {
		h.mu.Unlock()
		h.denySmartGrant(ctx, c, correlation, issueErr.Error())
		return
	}
	var pin *sessionPin
	if wantBinding != "" {
		pin, _ = bk.findPin(fp, wantBinding)
		if pin == nil {
			issueErr = fmt.Errorf("session binding is no longer trusted")
		}
	} else {
		pin, issueErr = bk.pinSession(fp, candidate)
	}
	var g *runGrant
	if issueErr == nil {
		g, issueErr = bk.attachRun(fp, run, pin.BindingID)
	}
	h.mu.Unlock()
	if issueErr != nil {
		h.denySmartGrant(ctx, c, correlation, issueErr.Error())
		return
	}
	log.Printf("smart grant issued: fp=%s run=%s binding=%s model=%s protocol=%s decision=%s",
		fp, run, pin.BindingID, pin.Model, pin.Protocol, pin.DecisionID)
	h.sendSmartGrant(ctx, c, correlation, pin, g)
}

func (h *hubSrv) sendSmartGrant(ctx context.Context, c *websocket.Conn, correlation string, pin *sessionPin, g *runGrant) {
	lease, capped, err := h.finalizeGoalGrant(g.FP, pin, g)
	if err != nil {
		h.bindings().endRun(g.FP, g.RunID)
		h.denySmartGrant(ctx, c, correlation, err.Error())
		return
	}
	g = capped
	wsSend(ctx, c, &sig{K: "model-grant", ID: correlation, D: g.Code, TTL: int64(time.Until(g.Exp).Seconds()),
		GoalLease: lease,
		BindingID: pin.BindingID, BoundModel: pin.Model, BoundProtocol: pin.Protocol,
		BoundDecision: pin.DecisionID, BoundDecisionExp: pin.DecisionExp.UTC().Format(time.RFC3339),
		BoundMaxOutput: pin.MaxOutputTokens, BoundTools: pin.RequiresTools})
}

func (h *hubSrv) denySmartGrant(ctx context.Context, c *websocket.Conn, correlation, reason string) {
	wsSend(ctx, c, &sig{K: "model-grant", ID: correlation, Err: reason})
}

// renewSmartGrant 在 code 过期后按 (FP, 稳定 Run) 续签：不依赖已删除的旧 code，
// 只换 code/TTL，binding 与元组/决策一律不变。
func (h *hubSrv) renewSmartGrant(ctx context.Context, correlation string, c *websocket.Conn, fp, run, binding string) {
	if binding == "" {
		h.denySmartGrant(ctx, c, correlation, "smart renewal requires binding")
		return
	}
	// 续签同样要先过设备资格门禁：断连/撤销后不得再签发新码。
	bk := h.bindings()
	h.mu.Lock()
	if err := h.deviceEligibleLocked(fp, c); err != nil {
		h.mu.Unlock()
		log.Printf("smart grant renewal denied: fp=%s run=%s reason=%v", fp, run, err)
		wsSend(ctx, c, &sig{K: "model-grant", ID: correlation, Err: err.Error()})
		return
	}
	old, exists := bk.findRun(fp, run)
	if !exists || old.BindingID != binding {
		h.mu.Unlock()
		h.denySmartGrant(ctx, c, correlation, "no matching trusted run record to renew")
		return
	}
	g, err := bk.renewRun(fp, run)
	if err != nil {
		h.mu.Unlock()
		log.Printf("smart grant renewal denied: fp=%s run=%s reason=%v", fp, run, err)
		wsSend(ctx, c, &sig{K: "model-grant", ID: correlation, Err: err.Error()})
		return
	}
	pin, ok := bk.findPin(fp, g.BindingID)
	h.mu.Unlock()
	if !ok {
		wsSend(ctx, c, &sig{K: "model-grant", ID: correlation, Err: "session binding is not trusted"})
		return
	}
	log.Printf("smart grant renewed: fp=%s run=%s binding=%s", fp, run, g.BindingID)
	h.sendSmartGrant(ctx, c, correlation, pin, g)
}

func (h *hubSrv) issueModelGrant(ctx context.Context, id string, c *websocket.Conn, s *sig) {
	if h.issueGoalGrant(ctx, id, c, s) {
		return
	}
	h.mu.Lock()
	n := h.nodes[id]
	fp := ""
	if n != nil {
		fp = n.fp
	}
	h.mu.Unlock()
	// Run 是稳定回合标识；ID 只用于匹配请求与回复。旧客户端不带 Run 时退回 ID，
	// 保持旧 default/explicit 路径行为不变。
	runID := strings.TrimSpace(s.Run)
	if runID == "" {
		runID = strings.TrimSpace(s.ID)
	}
	if fp == "" {
		log.Printf("model grant denied: conn=%s run=%s reason=not joined", id, runID)
		wsSend(ctx, c, &sig{K: "model-grant", ID: s.ID, Err: "not joined"})
		return
	}
	if s.Smart || strings.TrimSpace(s.Binding) != "" {
		h.issueSmartGrant(ctx, strings.TrimSpace(s.ID), c, s, fp, runID)
		return
	}
	// 回复一律 echo 请求的 correlation（s.ID）：Node 按它等待。
	// 不能用稳定 RunID 回复——续签请求的 ID 是 "<run>-refresh"，回成 run 会让所有
	// 旧 default/explicit 续签等 12 秒超时。RunID 只用于账本归属。
	replyID := strings.TrimSpace(s.ID)
	if replyID == "" {
		replyID = runID
	}
	code, exp, err := h.mintModelGrant(fp, runID)
	if err != nil {
		log.Printf("model grant denied: fp=%s run=%s reason=%v", fp, runID, err)
		wsSend(ctx, c, &sig{K: "model-grant", ID: replyID, Err: err.Error()})
		return
	}
	// 默认模型/协议来自 Hub 自己保存的配置（可能为空 = 未配置）；只下发元数据，绝不下发 key。
	def := h.gw.snapshot()
	wsSend(ctx, c, &sig{K: "model-grant", ID: replyID, D: code, TTL: int64(time.Until(exp).Seconds()),
		DefaultModel: strings.TrimSpace(def.DefaultModel), DefaultProtocol: strings.TrimSpace(def.DefaultProtocol)})
}

// modelGrantOK 判断请求带的是不是一次有效的执行访问码。
//
// 两类并存：旧 default/explicit 的 grantBook code，以及智能路径的 bindingBook code。
// 后者只说明"带了一个有效 code"，**具体元组是否匹配由逐请求门禁再判**——
// 这里放宽不等于授权放宽，authOK 分支语义完全不变。
func (h *hubSrv) modelGrantOK(r *http.Request) bool {
	ok, _ := h.modelGrantKind(r)
	return ok
}

// modelGrantKind lets wrap carry the smart classification into gatewayProxy.
// Once auth accepted a smart code, later rotation/expiry must reject instead
// of reclassifying that same request as a legacy grant.
func (h *hubSrv) modelGrantKind(r *http.Request) (ok, smart bool) {
	got := bearerToken(r)
	if got == "" {
		return false, false
	}
	// These books are lazily published under h.mu. Copy their pointers with
	// that same lock before taking either book's own mutex.
	h.mu.Lock()
	legacy, smartBook := h.grant, h.bind
	h.mu.Unlock()
	if legacy != nil {
		if _, ok := legacy.lookup(got); ok {
			return true, false
		}
	}
	if smartBook != nil {
		if _, ok := smartBook.runForCode(got); ok {
			return true, true
		}
	}
	return false, false
}

func bearerToken(r *http.Request) string {
	got := r.Header.Get("authorization")
	if len(got) > 7 && strings.EqualFold(got[:7], "bearer ") {
		return strings.TrimSpace(got[7:])
	}
	return strings.TrimSpace(r.URL.Query().Get("token"))
}

func grantMatches(got, want string) bool {
	if len(got) != len(want) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}
