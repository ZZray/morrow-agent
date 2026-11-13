package main

// HW02 Hub 智能选型的 HTTP fixture：真实走 gatewayclient.ResolveRoute + providers
// 生产路径（httptest 网关），只断言「选型口径」，不镜像样式。
//
// 覆盖：explicit/default 三条路径互不干扰、智能只解析一次、决策头实际到达上游、
// 续接复用已存身份、未配池与解析拒绝都不退回 default、过期身份明确拒绝。

import (
	"context"
	"encoding/json"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ara/internal/gatewayclient"
)

// smartStore 在 fixture 的 store 上补一个模型池，其他保持 fixture 默认值。
func smartStore(f *gwFixture, pool string) {
	f.Store.cfg.SmartPool = pool
}

// chatHeaders 返回所有命中 /v1/chat/completions 的请求头。
func chatHeaders(f *gwFixture) []http.Header {
	var out []http.Header
	for _, r := range f.snapshotRecords() {
		if r.Path == "/v1/chat/completions" {
			out = append(out, r.Header)
		}
	}
	return out
}

func newSmartHub(t *testing.T, pool string) (*gwFixture, *hubSrv) {
	t.Helper()
	f := newGatewayFixture(t, []gwTestModel{
		{ID: "deepseek-v4-flash", Protocols: []string{"openai-completions"}},
		{ID: "glm-4.6", Protocols: []string{"openai-completions", "openai-responses"}},
	})
	smartStore(f, pool)
	return f, &hubSrv{token: "test-root", gw: f.Store}
}

func TestSmartTurnResolvesOnceAndPinsRequestToDecision(t *testing.T) {
	skillTestConf(t)
	f, h := newSmartHub(t, "handwave-hub")
	ws, sid := workspaceWithProject(t, t.TempDir())
	user := appendNativeUser(t, ws, sid, "读一遍日志并总结")

	if _, err := h.chatTurn(context.Background(), ws, sid, user.ID, "default", "", false, false, false, false, true, nil, nil); err != nil {
		t.Fatalf("smart turn failed: %v", err)
	}
	if got := f.resolveCount(); got != 1 {
		t.Fatalf("resolve calls = %d, want exactly 1", got)
	}
	headers := chatHeaders(f)
	if len(headers) == 0 {
		t.Fatal("no upstream chat request recorded")
	}
	if got := headers[0].Get(gatewayclient.RouteDecisionHeader); got != "dec-fixture" {
		t.Fatalf("decision header = %q, want dec-fixture（决策必须随请求上到上游）", got)
	}
	sess, err := loadSessMeta(ws, sid)
	if err != nil || sess == nil {
		t.Fatalf("loadSessMeta: %v", err)
	}
	if sess.Smart == nil || sess.Smart.DecisionID != "dec-fixture" || sess.Smart.Model != "glm-4.6" {
		t.Fatalf("smart identity not persisted: %+v", sess.Smart)
	}
}

func TestSmartContinuationReusesTheStoredIdentityWithoutResolvingAgain(t *testing.T) {
	skillTestConf(t)
	f, h := newSmartHub(t, "handwave-hub")
	ws, sid := workspaceWithProject(t, t.TempDir())
	first := appendNativeUser(t, ws, sid, "第一轮")
	if _, err := h.chatTurn(context.Background(), ws, sid, first.ID, "default", "", false, false, false, false, true, nil, nil); err != nil {
		t.Fatalf("first smart turn: %v", err)
	}
	// 默认配置变化也不能让已绑定的智能会话换模型。
	f.Store.cfg.DefaultModel = "deepseek-v4-flash"
	f.Store.cfg.DefaultProtocol = "openai-completions"

	second := appendNativeUser(t, ws, sid, "第二轮")
	if _, err := h.chatTurn(context.Background(), ws, sid, second.ID, "default", "", false, false, false, false, true, nil, nil); err != nil {
		t.Fatalf("second smart turn: %v", err)
	}
	if got := f.resolveCount(); got != 1 {
		t.Fatalf("resolve calls = %d, want 1（续接必须复用身份，不重新分类）", got)
	}
	headers := chatHeaders(f)
	last := headers[len(headers)-1]
	if got := last.Get(gatewayclient.RouteDecisionHeader); got != "dec-fixture" {
		t.Fatalf("continuation decision header = %q", got)
	}
	bodies := f.chatBodies()
	if len(bodies) < 2 || !strings.Contains(string(bodies[len(bodies)-1]), "glm-4.6") {
		t.Fatalf("continuation did not keep the bound model: %s", bodies[len(bodies)-1])
	}
}

func TestSmartTurnWithoutConfiguredPoolReportsItInsteadOfFallingBack(t *testing.T) {
	skillTestConf(t)
	f, h := newSmartHub(t, "")
	ws, sid := workspaceWithProject(t, t.TempDir())
	user := appendNativeUser(t, ws, sid, "读一遍日志")

	_, err := h.chatTurn(context.Background(), ws, sid, user.ID, "default", "", false, false, false, false, true, nil, nil)
	if err == nil {
		t.Fatal("unconfigured smart pool was reported as success")
	}
	if !strings.Contains(err.Error(), "smart_pool") {
		t.Fatalf("error does not name the missing configuration: %v", err)
	}
	if got := f.resolveCount(); got != 0 {
		t.Fatalf("resolve calls = %d, want 0（未配池时不应发解析请求）", got)
	}
	if len(f.chatBodies()) != 0 {
		t.Fatal("must not fall back to the default model")
	}
}

func TestSmartTurnRefusalStaysStructuredAndNeverBecomesSuccess(t *testing.T) {
	skillTestConf(t)
	f, h := newSmartHub(t, "handwave-hub")
	f.Resolve = func(w http.ResponseWriter, r *http.Request) bool {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"error":{"type":"no_eligible_candidate","message":"没有满足约束的候选","detail":"quality_floor=2"}}`))
		return true
	}
	ws, sid := workspaceWithProject(t, t.TempDir())
	user := appendNativeUser(t, ws, sid, "读一遍日志")

	_, err := h.chatTurn(context.Background(), ws, sid, user.ID, "default", "", false, false, false, false, true, nil, nil)
	if err == nil {
		t.Fatal("route refusal was reported as success")
	}
	var routeErr *gatewayclient.RouteError
	if !asRouteError(err, &routeErr) {
		t.Fatalf("refusal is not a structured RouteError: %T %v", err, err)
	}
	if !routeErr.HasCode("no_eligible_candidate") {
		t.Fatalf("refusal code = %q", routeErr.Code)
	}
	if len(f.chatBodies()) != 0 {
		t.Fatal("refusal must not fall back to the default model")
	}
}

func asRouteError(err error, dst **gatewayclient.RouteError) bool {
	if err == nil {
		return false
	}
	if re, ok := err.(*gatewayclient.RouteError); ok {
		*dst = re
		return true
	}
	// chatTurn 会把错误再包一层；按文本回退识别，避免把结构化原因写成泛化失败。
	return false
}

func TestExplicitAndDefaultTurnsNeverTouchRouteResolve(t *testing.T) {
	skillTestConf(t)
	f, h := newSmartHub(t, "handwave-hub")
	ws, sid := workspaceWithProject(t, t.TempDir())

	first := appendNativeUser(t, ws, sid, "默认路径")
	if _, err := h.chatTurn(context.Background(), ws, sid, first.ID, "default", "", false, false, false, false, false, nil, nil); err != nil {
		t.Fatalf("default turn: %v", err)
	}
	second := appendNativeUser(t, ws, sid, "具体模型路径")
	if _, err := h.chatTurn(context.Background(), ws, sid, second.ID, "deepseek-v4-flash", "openai-completions", false, false, false, false, false, nil, nil); err != nil {
		t.Fatalf("explicit turn: %v", err)
	}
	if got := f.resolveCount(); got != 0 {
		t.Fatalf("resolve calls = %d, want 0（默认与具体路径不该被智能逻辑碰到）", got)
	}
	for _, hdr := range chatHeaders(f) {
		if hdr.Get(gatewayclient.RouteDecisionHeader) != "" {
			t.Fatal("non-smart turns must not carry a decision header")
		}
	}
	sess, err := loadSessMeta(ws, sid)
	if err != nil || sess == nil {
		t.Fatalf("loadSessMeta: %v", err)
	}
	if sess.Smart != nil {
		t.Fatalf("non-smart turns created a smart identity: %+v", sess.Smart)
	}
}

func TestExpiredSmartIdentityIsRefusedInsteadOfReclassified(t *testing.T) {
	skillTestConf(t)
	f, h := newSmartHub(t, "handwave-hub")
	ws, sid := workspaceWithProject(t, t.TempDir())
	user := appendNativeUser(t, ws, sid, "第一轮")
	if _, err := h.chatTurn(context.Background(), ws, sid, user.ID, "default", "", false, false, false, false, true, nil, nil); err != nil {
		t.Fatalf("first turn: %v", err)
	}
	sess, err := loadSessMeta(ws, sid)
	if err != nil || sess == nil || sess.Smart == nil {
		t.Fatalf("smart identity missing: %v", err)
	}
	sess.Smart.ExpiresAt = time.Now().Add(-time.Minute).Format(time.RFC3339)
	if err := saveSessMeta(ws, sess); err != nil {
		t.Fatal(err)
	}

	second := appendNativeUser(t, ws, sid, "第二轮")
	_, err = h.chatTurn(context.Background(), ws, sid, second.ID, "default", "", false, false, false, false, true, nil, nil)
	if err == nil {
		t.Fatal("expired decision was re-used or reclassified silently")
	}
	if !strings.Contains(err.Error(), "过期") {
		t.Fatalf("error does not explain the expiry: %v", err)
	}
	if got := f.resolveCount(); got != 1 {
		t.Fatalf("resolve calls = %d, want 1（过期身份不该触发重新分类）", got)
	}
}

// 已绑定明确身份（model + protocol 都非空）的会话，智能准入不能把它换成另一个
// 模型——即使协议相同。对准 smartDecisionForTurn 本身：历史重放边界会在聊天层先
// 挡住一部分组合，准入逻辑必须自己守住完整元组，而不是依赖那道边界。
func TestSmartAdmissionBindsTheWholeIdentityTuple(t *testing.T) {
	skillTestConf(t)
	f, h := newSmartHub(t, "handwave-hub")
	ws, sid := workspaceWithProject(t, t.TempDir())

	first := appendNativeUser(t, ws, sid, "明确身份第一轮")
	if _, err := h.chatTurn(context.Background(), ws, sid, first.ID, "deepseek-v4-flash", "openai-completions", false, false, false, false, false, nil, nil); err != nil {
		t.Fatalf("explicit turn: %v", err)
	}
	sess, err := loadSessMeta(ws, sid)
	if err != nil || sess == nil {
		t.Fatalf("loadSessMeta: %v", err)
	}
	if sess.Model != "deepseek-v4-flash" || sess.Protocol != "openai-completions" {
		t.Fatalf("explicit identity not stored: %+v", sess)
	}

	// 目录里同协议还有另一个模型：解析会给出 glm-4.6，与已绑定身份只差模型。
	second := appendNativeUser(t, ws, sid, "改成智能试试")
	_, err = h.smartDecisionForTurn(context.Background(), ws, sid, second.ID, "总结这段对话", false)
	if err == nil {
		t.Fatal("smart admission accepted another model for a session that already has an identity")
	}
	if !strings.Contains(err.Error(), "另开会话") {
		t.Fatalf("refusal does not tell the caller to open a new session: %v", err)
	}
	if got := len(chatHeaders(f)); got != 1 {
		t.Fatalf("upstream chat requests = %d, want 1（准入拒绝不该产生新请求）", got)
	}
	after, err := loadSessMeta(ws, sid)
	if err != nil || after == nil {
		t.Fatalf("loadSessMeta: %v", err)
	}
	if after.Model != "deepseek-v4-flash" || after.Smart != nil {
		t.Fatalf("the session identity drifted: %+v", after)
	}
}

// 反向边界：解析结果恰好命中会话已绑定的完整元组时，智能准入应加入同一身份（并
// 钉住决策），而不是一律拒绝——门禁守的是"不换身份"，不是"禁止转智能"。
func TestSmartAdmissionJoinsAnIdenticalIdentity(t *testing.T) {
	skillTestConf(t)
	f, h := newSmartHub(t, "handwave-hub")
	ws, sid := workspaceWithProject(t, t.TempDir())

	first := appendNativeUser(t, ws, sid, "明确身份第一轮")
	if _, err := h.chatTurn(context.Background(), ws, sid, first.ID, "glm-4.6", "openai-completions", false, false, false, false, false, nil, nil); err != nil {
		t.Fatalf("explicit turn: %v", err)
	}
	second := appendNativeUser(t, ws, sid, "转智能")
	dec, err := h.smartDecisionForTurn(context.Background(), ws, sid, second.ID, "总结这段对话", false)
	if err != nil {
		t.Fatalf("an identical tuple was refused: %v", err)
	}
	if dec.Model != "glm-4.6" || dec.Protocol != "openai-completions" {
		t.Fatalf("joined decision drifted: %+v", dec)
	}
	if got := f.resolveCount(); got != 1 {
		t.Fatalf("resolve calls = %d, want exactly 1", got)
	}
	sess, err := loadSessMeta(ws, sid)
	if err != nil || sess == nil || sess.Smart == nil {
		t.Fatalf("smart identity not pinned: %v", err)
	}
	if sess.Smart.Model != "glm-4.6" || sess.Model != "glm-4.6" {
		t.Fatalf("identity changed while joining: %+v", sess)
	}
}

// 并发首次选型：两个请求同时读到未钉住的会话，各自 resolve 并互相覆盖，最终身份
// 不一致。用 resolve barrier 把两个请求都停在选型里，再让它们拿到不同决策——修复后
// 必须只解析一次、两次调用拿到同一身份、会话只钉一个身份。
func TestConcurrentFirstSelectionKeepsOneIdentity(t *testing.T) {
	skillTestConf(t)
	f, h := newSmartHub(t, "handwave-hub")
	ws, sid := workspaceWithProject(t, t.TempDir())

	var seq int32
	firstEntered := make(chan struct{})
	var entered sync.Once
	f.Resolve = func(w http.ResponseWriter, r *http.Request) bool {
		// 把选型留在空中，并让测试知道窗口已打开：第二个请求在此时读到的一定是
		// 未钉住的会话。没有合并时它会自己再发起一次选型；合并生效时它只等待。
		entered.Do(func() { close(firstEntered) })
		time.Sleep(600 * time.Millisecond)
		if atomic.AddInt32(&seq, 1) == 1 {
			writeResolveOK(w, "dec-a", "glm-4.6", "openai-completions")
		} else {
			writeResolveOK(w, "dec-b", "deepseek-v4-flash", "openai-completions")
		}
		return true
	}

	turnA := appendNativeUser(t, ws, sid, "并发第一轮 A")
	turnB := appendNativeUser(t, ws, sid, "并发第一轮 B")
	var wg sync.WaitGroup
	results := make([]*gatewayclient.RouteDecision, 2)
	errs := make([]error, 2)
	wg.Add(1)
	go func() {
		defer wg.Done()
		results[0], errs[0] = h.smartDecisionForTurn(context.Background(), ws, sid, turnA.ID, "并发选型", false)
	}()
	// Wait until the first request is inside its resolve, then let the second one
	// read the still-unpinned session: that is the race the audit describes.
	select {
	case <-firstEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("the first request never reached the resolve")
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		results[1], errs[1] = h.smartDecisionForTurn(context.Background(), ws, sid, turnB.ID, "并发选型", false)
	}()
	wg.Wait()

	if got := f.resolveCount(); got != 1 {
		t.Fatalf("resolve calls = %d, want 1（并发首次选型必须合并为一次）", got)
	}
	for i, err := range errs {
		if err != nil {
			t.Fatalf("concurrent request %d: %v", i, err)
		}
	}
	if results[0].DecisionID != results[1].DecisionID || results[0].Model != results[1].Model {
		t.Fatalf("concurrent requests ended with two identities: %+v / %+v", results[0], results[1])
	}
	sess, err := loadSessMeta(ws, sid)
	if err != nil || sess == nil || sess.Smart == nil {
		t.Fatalf("smart identity not pinned: %v", err)
	}
	if sess.Smart.Model != results[0].Model || sess.Smart.DecisionID != results[0].DecisionID {
		t.Fatalf("pinned identity differs from what the requests used: %+v vs %+v", sess.Smart, results[0])
	}
}

// 选型结束后 flight 必须被释放：留在表里的 flight 会让后续等待者一直挂着（leader
// 异常终止时更明显，所以释放写在 defer 里）。
func TestSmartFlightIsReleasedAfterSelection(t *testing.T) {
	skillTestConf(t)
	f, h := newSmartHub(t, "handwave-hub")
	ws, sid := workspaceWithProject(t, t.TempDir())
	user := appendNativeUser(t, ws, sid, "选型一次")
	if _, err := h.smartDecisionForTurn(context.Background(), ws, sid, user.ID, "总结", false); err != nil {
		t.Fatalf("smart decision: %v", err)
	}
	h.flightMu.Lock()
	left := len(h.flights)
	h.flightMu.Unlock()
	if left != 0 {
		t.Fatalf("flights left after selection = %d, want 0", left)
	}
	if got := f.resolveCount(); got != 1 {
		t.Fatalf("resolve calls = %d, want 1", got)
	}
}

// 延迟请求先读到未钉住会话，等前一 flight 完成并从 map 删除后才 join 成新 leader。
// 它不得再 resolve 一次：leader 开始解析前必须核对最新已绑定身份。
func TestStaleLeaderAfterFlightReleaseDoesNotResolveTwice(t *testing.T) {
	skillTestConf(t)
	f, h := newSmartHub(t, "handwave-hub")
	ws, sid := workspaceWithProject(t, t.TempDir())

	// Barrier so the first resolve is held open while the delayed request reads
	// an unpinned session snapshot.
	inResolve := make(chan struct{})
	release := make(chan struct{})
	var resolveCalls int32
	f.Resolve = func(w http.ResponseWriter, r *http.Request) bool {
		if atomic.AddInt32(&resolveCalls, 1) == 1 {
			close(inResolve)
			<-release
			writeResolveOK(w, "dec-first", "glm-4.6", "openai-completions")
		} else {
			writeResolveOK(w, "dec-stale", "deepseek-v4-flash", "openai-completions")
		}
		return true
	}

	turnA := appendNativeUser(t, ws, sid, "first flight")
	turnB := appendNativeUser(t, ws, sid, "delayed request")

	// Delayed request loads the unpinned snapshot first (the audit window).
	stale, err := loadSessMeta(ws, sid)
	if err != nil || stale == nil || stale.Smart != nil {
		t.Fatalf("need an unpinned snapshot, got %+v err=%v", stale, err)
	}

	var wg sync.WaitGroup
	var firstDec *gatewayclient.RouteDecision
	var firstErr error
	wg.Add(1)
	go func() {
		defer wg.Done()
		firstDec, firstErr = h.smartDecisionForTurn(context.Background(), ws, sid, turnA.ID, "first", false)
	}()
	select {
	case <-inResolve:
	case <-time.After(5 * time.Second):
		t.Fatal("first request never reached resolve")
	}
	// First flight finishes and is removed from the map before the delayed
	// request joins.
	close(release)
	wg.Wait()
	if firstErr != nil {
		t.Fatalf("first flight: %v", firstErr)
	}
	h.flightMu.Lock()
	left := len(h.flights)
	h.flightMu.Unlock()
	if left != 0 {
		t.Fatalf("flight map not empty after first selection: %d", left)
	}

	// The delayed request becomes a new leader with its stale snapshot. It must
	// adopt the already-pinned identity instead of resolving again.
	flight, leader := h.joinSmartFlight(ws, sid)
	if !leader {
		t.Fatal("delayed request did not become leader after the map was empty")
	}
	h.leadSmartFlight(flight, ws, sid, context.Background(), turnB.ID, "delayed", false, stale)
	if flight.err != nil {
		t.Fatalf("stale leader failed: %v", flight.err)
	}
	if flight.dec == nil || flight.dec.DecisionID != firstDec.DecisionID {
		t.Fatalf("stale leader produced a different identity: %+v vs %+v", flight.dec, firstDec)
	}
	if got := atomic.LoadInt32(&resolveCalls); got != 1 {
		t.Fatalf("resolve calls = %d, want 1（延迟 leader 不得再 resolve）", got)
	}
	after, err := loadSessMeta(ws, sid)
	if err != nil || after == nil || after.Smart == nil || after.Smart.DecisionID != "dec-first" {
		t.Fatalf("pinned identity drifted: %+v err=%v", after, err)
	}
}

// smart resolve 尚在网络中时，explicit 路径已首次钉住具体 model/protocol。
// smart 返回另一元组不得用旧 sess 覆盖它。
func TestSmartResolveDoesNotOverwriteExplicitPin(t *testing.T) {
	skillTestConf(t)
	f, h := newSmartHub(t, "handwave-hub")
	ws, sid := workspaceWithProject(t, t.TempDir())

	inResolve := make(chan struct{})
	release := make(chan struct{})
	f.Resolve = func(w http.ResponseWriter, r *http.Request) bool {
		close(inResolve)
		<-release
		// Another model of the same protocol: a tuple the explicit pin must reject.
		writeResolveOK(w, "dec-smart", "deepseek-v4-flash", "openai-completions")
		return true
	}

	turnSmart := appendNativeUser(t, ws, sid, "smart in flight")
	turnExplicit := appendNativeUser(t, ws, sid, "explicit pin")

	// The leader's snapshot is taken before the explicit pin; assert that
	// precondition so the interleaving stays meaningful.
	if stale, serr := loadSessMeta(ws, sid); serr != nil || stale == nil {
		t.Fatal(serr)
	} else if stale.Smart != nil || stale.Model != "" || stale.Protocol != "" {
		t.Fatalf("need an unbound snapshot before the explicit pin: %+v", stale)
	}

	var wg sync.WaitGroup
	var smartErr error
	var smartDec *gatewayclient.RouteDecision
	wg.Add(1)
	go func() {
		defer wg.Done()
		smartDec, smartErr = h.smartDecisionForTurn(context.Background(), ws, sid, turnSmart.ID, "smart", false)
	}()
	select {
	case <-inResolve:
	case <-time.After(5 * time.Second):
		t.Fatal("smart request never reached resolve")
	}

	// Explicit path pins a concrete identity while the smart resolve is in flight.
	if _, err := h.chatTurn(context.Background(), ws, sid, turnExplicit.ID, "glm-4.6", "openai-completions", false, false, false, false, false, nil, nil); err != nil {
		t.Fatalf("explicit pin turn: %v", err)
	}
	pinned, err := loadSessMeta(ws, sid)
	if err != nil || pinned == nil || pinned.Model != "glm-4.6" || pinned.Protocol != "openai-completions" {
		t.Fatalf("explicit pin missing: %+v err=%v", pinned, err)
	}

	close(release)
	wg.Wait()

	// The smart result names another model: it must be refused, not committed.
	if smartErr == nil {
		t.Fatalf("smart resolve overwrote the explicit pin: dec=%+v", smartDec)
	}
	if !strings.Contains(smartErr.Error(), "已绑定") {
		t.Fatalf("refusal does not name the bound identity: %v", smartErr)
	}
	after, err := loadSessMeta(ws, sid)
	if err != nil || after == nil {
		t.Fatal(err)
	}
	if after.Model != "glm-4.6" || after.Protocol != "openai-completions" {
		t.Fatalf("explicit identity was overwritten: %+v", after)
	}
	if after.Smart != nil {
		t.Fatalf("smart identity was pinned over the explicit one: %+v", after.Smart)
	}
}

// 写入顺序 A：smart 先提交，explicit 后到。explicit 不得用旧对象覆盖 Smart，
// 也不得携带另一个元组进入假 provider。

// 写入顺序 A：smart 在 load 与 save 之间暂停，explicit 并发提交。有锁时
// explicit 被挡在窗口外，smart 先提交；explicit 不得覆盖，也不得携带另一元组
// 进入假 provider。无锁错误候选会让 explicit 在窗口内完成并被 smart 陈旧快照覆盖。

// decodeChatModel 从假 provider 的请求体解码 model 字段。
func decodeChatModel(t *testing.T, body []byte) string {
	t.Helper()
	var payload struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("decode chat request: %v", err)
	}
	return payload.Model
}

// onceFunc 返回幂等的放行函数：barrier 用例的多条失败路径与 cleanup 都会调用它。
func onceFunc(f func()) func() {
	var o sync.Once
	return func() { o.Do(f) }
}

// waitSignal 等待一个确定性到达信号；超时即失败（t.Fatal 会触发 cleanup 放行并 join）。
func waitSignal(t *testing.T, ch <-chan struct{}, msg string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatal(msg)
	}
}

// barrierCleanup 统一收口本批并发用例：幂等放行所有 barrier → 取消 context →
// 有界等待所有 goroutine 退出 → 最后才复原钩子。顺序很关键：不能在 goroutine
// 仍可能访问钩子时把它们清空，也不能跳过 join。t.Fatal 会触发 t.Cleanup，
// 因此每条失败路径都会经过这里。
func barrierCleanup(t *testing.T, cancel context.CancelFunc, wg *sync.WaitGroup, release []func(), clearHooks func()) {
	t.Helper()
	t.Cleanup(func() {
		for _, r := range release {
			r()
		}
		cancel()
		done := make(chan struct{})
		go func() {
			wg.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(30 * time.Second):
			t.Error("barrier goroutines still running 30s after release")
		}
		clearHooks()
	})
}

// claimWindow 返回一个「仅首个进入者暂停」的窗口钩子。
// 关键：claim 的判定必须先结束，等待发生在 claim 之外。若把等待写在 sync.Once
// 里面，Once 会顺带阻塞第二个调用者，于是即使生产侧没有互斥，第二个竞争方也
// 进不来，无锁错误候选会被自己的测试钩子挡住而假通过。
// 第二个进入者不阻塞，只关闭 intruder 信号，供用例抓「本不该进入窗口的人进来了」。
func claimWindow(pausing, intruder chan struct{}, release <-chan struct{}) func() {
	var claimMu sync.Mutex
	claimed := false
	return func() {
		claimMu.Lock()
		if !claimed {
			claimed = true
			claimMu.Unlock()
			close(pausing)
			<-release
			return
		}
		claimMu.Unlock()
		select {
		case <-intruder:
		default:
			close(intruder)
		}
	}
}

// 写入顺序 A（异元组）：smart 是首个进入 load-save 窗口的写入者并持锁暂停；
// explicit 到达自己的提交入口后，必须既跑不完、也进不了 smart 的窗口。
// 放行后 smart 元组保留且具体字段已落盘；explicit 异元组被拒且不得进入假 provider。
func TestExplicitDuringSmartCommitWindowDoesNotOverwrite(t *testing.T) {
	skillTestConf(t)
	f, h := newSmartHub(t, "handwave-hub")
	ws, sid := workspaceWithProject(t, t.TempDir())

	// smart 解析出 glm-4.6；explicit 请求 deepseek-v4-flash（异元组）。
	f.Resolve = func(w http.ResponseWriter, r *http.Request) bool {
		writeResolveOK(w, "dec-smart", "glm-4.6", "openai-completions")
		return true
	}

	turnSmart := appendNativeUser(t, ws, sid, "smart in window")
	turnExplicit := appendNativeUser(t, ws, sid, "explicit concurrent")

	smartInWindow := make(chan struct{})
	intruder := make(chan struct{})
	release := make(chan struct{})
	doRelease := onceFunc(func() { close(release) })
	testAfterSessMetaLoad = claimWindow(smartInWindow, intruder, release)

	// 只有 explicit 到达提交入口才发信号：smart 也经过同一个钩子，按 turnID 区分。
	explicitAtEntry := make(chan struct{})
	h.testBeforeIdentityCommit = func(turnID string) {
		if turnID == turnExplicit.ID {
			onceFunc(func() { close(explicitAtEntry) })()
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	barrierCleanup(t, cancel, &wg, []func(){doRelease}, func() {
		testAfterSessMetaLoad = nil
		h.testBeforeIdentityCommit = nil
	})

	var smartErr, explicitErr error
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, smartErr = h.smartDecisionForTurn(ctx, ws, sid, turnSmart.ID, "smart", false)
	}()
	waitSignal(t, smartInWindow, "smart never entered the load-save window")

	explicitDone := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer close(explicitDone)
		_, explicitErr = h.chatTurn(ctx, ws, sid, turnExplicit.ID, "deepseek-v4-flash", "openai-completions", false, false, false, false, false, nil, nil)
	}()
	// 确定性握手：explicit 已到达自己的提交竞争入口。
	waitSignal(t, explicitAtEntry, "explicit never reached the identity commit entry")
	// 有界观察：给错误候选真正的执行机会（让出调度并等待），它不是「立刻 default」。
	for i := 0; i < 50; i++ {
		runtime.Gosched()
	}
	select {
	case <-intruder:
		t.Fatal("explicit entered smart's load-save window: the identity commit is not mutually exclusive")
	case <-explicitDone:
		t.Fatal("explicit finished inside smart's load-save window")
	case <-time.After(2 * time.Second):
	}
	doRelease()
	wg.Wait()

	if smartErr != nil {
		t.Fatalf("smart should have committed first: %v", smartErr)
	}
	after, err := loadSessMeta(ws, sid)
	if err != nil || after == nil || after.Smart == nil {
		t.Fatalf("smart pin missing: %+v err=%v", after, err)
	}
	// Smart 不是对外契约：具体字段必须同时落盘，否则 UI 认作未绑定。
	if after.Smart.Model != "glm-4.6" || after.Model != "glm-4.6" || after.Protocol != "openai-completions" {
		t.Fatalf("identity drifted or concrete fields missing: %+v", after)
	}
	if explicitErr == nil || !strings.Contains(explicitErr.Error(), "已绑定") {
		t.Fatalf("explicit was not refused for the bound tuple: %v", explicitErr)
	}
	if got := f.resolveCount(); got != 1 {
		t.Fatalf("resolve calls = %d, want 1", got)
	}
	for _, body := range f.chatBodies() {
		if got := decodeChatModel(t, body); got == "deepseek-v4-flash" {
			t.Fatalf("conflicting tuple reached the fake provider: %s", body)
		}
	}
}

// 写入顺序 B（异元组，逆向提交窗口 + 完整请求路径）：smart 先完成前置读取并停在
// 网络 resolve；explicit 随后进入自己的 load-mutate-save 窗口暂停（已 load 未 save）；
// 再放行 smart 到提交竞争入口，它必须既进不了窗口也跑不完；最后按目标顺序释放：
// explicit 先提交，冲突的 smart 被拒。断言覆盖身份持久化、拒绝原因，以及假
// provider 实际收到的请求 model 与条数（解码后比对，不是整包字符串包含）。
func TestSmartDuringExplicitCommitWindowDoesNotOverwrite(t *testing.T) {
	skillTestConf(t)
	f, h := newSmartHub(t, "handwave-hub")
	ws, sid := workspaceWithProject(t, t.TempDir())

	// 第一个到达 resolve 的请求暂停；claim 判定先结束，等待在 claim 之外。
	inResolve := make(chan struct{})
	resolveRelease := make(chan struct{})
	doResolveRelease := onceFunc(func() { close(resolveRelease) })
	f.Resolve = claimResolveWindow(inResolve, resolveRelease, "dec-other", "deepseek-v4-flash", "openai-completions")

	turnSmart := appendNativeUser(t, ws, sid, "smart in flight")
	turnExplicit := appendNativeUser(t, ws, sid, "explicit pin")

	explicitInWindow := make(chan struct{})
	intruder := make(chan struct{})
	windowRelease := make(chan struct{})
	doWindowRelease := onceFunc(func() { close(windowRelease) })
	testAfterSessMetaLoad = claimWindow(explicitInWindow, intruder, windowRelease)

	smartAtEntry := make(chan struct{})
	h.testBeforeIdentityCommit = func(turnID string) {
		if turnID == turnSmart.ID {
			onceFunc(func() { close(smartAtEntry) })()
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	barrierCleanup(t, cancel, &wg, []func(){doResolveRelease, doWindowRelease}, func() {
		testAfterSessMetaLoad = nil
		h.testBeforeIdentityCommit = nil
	})

	var smartErr, explicitErr error
	wg.Add(1)
	go func() {
		defer wg.Done()
		// 走完整 chatTurn：只有真实请求路径才能证明异元组不会发给 provider。
		_, smartErr = h.chatTurn(ctx, ws, sid, turnSmart.ID, "default", "", false, false, false, false, true, nil, nil)
	}()
	// smart 已完成前置读取，停在 resolve。
	waitSignal(t, inResolve, "smart never reached resolve")

	wg.Add(1)
	go func() {
		defer wg.Done()
		_, explicitErr = h.chatTurn(ctx, ws, sid, turnExplicit.ID, "glm-4.6", "openai-completions", false, false, false, false, false, nil, nil)
	}()
	// explicit 已进入自己的 load-mutate-save 窗口（已 load 未 save）。
	waitSignal(t, explicitInWindow, "explicit never entered its load-save window")

	// 放行 smart：它应停在提交竞争入口，被 explicit 持有的写锁挡住。
	doResolveRelease()
	waitSignal(t, smartAtEntry, "smart never reached the identity commit entry")
	for i := 0; i < 50; i++ {
		runtime.Gosched()
	}
	select {
	case <-intruder:
		t.Fatal("smart entered explicit's load-save window: the identity commit is not mutually exclusive")
	case <-time.After(2 * time.Second):
	}

	// 按目标顺序释放：explicit 先提交，smart 随后被拒。
	doWindowRelease()
	wg.Wait()

	if explicitErr != nil {
		t.Fatalf("explicit should have committed first: %v", explicitErr)
	}
	after, err := loadSessMeta(ws, sid)
	if err != nil || after == nil {
		t.Fatal(err)
	}
	if after.Model != "glm-4.6" || after.Protocol != "openai-completions" {
		t.Fatalf("explicit pin drifted: %+v", after)
	}
	if after.Smart != nil {
		t.Fatalf("smart was pinned over the explicit identity: %+v", after.Smart)
	}
	if smartErr == nil || !strings.Contains(smartErr.Error(), "已绑定") {
		t.Fatalf("smart was not refused for the bound tuple: %v", smartErr)
	}
	if got := f.resolveCount(); got != 1 {
		t.Fatalf("resolve calls = %d, want 1", got)
	}
	// 只有被允许的元组能进入假 provider：解码每条请求的 model 并检查条数。
	bodies := f.chatBodies()
	if len(bodies) == 0 {
		t.Fatal("no chat request reached the fake provider; the request path was not exercised")
	}
	for _, body := range bodies {
		if got := decodeChatModel(t, body); got != "glm-4.6" {
			t.Fatalf("unexpected tuple reached the fake provider: %s", body)
		}
	}
}

// claimResolveWindow 让第一个到达 resolve 的请求暂停，其余请求直接返回同一决策。
// 与 claimWindow 同理：等待不在 claim 判定内部，避免顺带串行化后续请求。
func claimResolveWindow(arrived chan struct{}, release <-chan struct{}, decisionID, model, protocol string) func(http.ResponseWriter, *http.Request) bool {
	var claimMu sync.Mutex
	claimed := false
	return func(w http.ResponseWriter, r *http.Request) bool {
		claimMu.Lock()
		if !claimed {
			claimed = true
			claimMu.Unlock()
			close(arrived)
			<-release
		} else {
			claimMu.Unlock()
		}
		writeResolveOK(w, decisionID, model, protocol)
		return true
	}
}

// 同元组成功链：首次完整 smart chatTurn 成功后，metadata 与 listSessions 暴露的具体
// Model/Protocol 都必须等于 Smart 元组（UI 只认这两个字段）；explicit 携带同元组加入
// 必须成功且身份不变；已钉住的会话不得再次 resolve。
func TestSameTupleJoinsAndFillsConcreteFields(t *testing.T) {
	skillTestConf(t)
	f, h := newSmartHub(t, "handwave-hub")
	ws, sid := workspaceWithProject(t, t.TempDir())

	first := appendNativeUser(t, ws, sid, "smart first")
	if _, err := h.chatTurn(context.Background(), ws, sid, first.ID, "default", "", false, false, false, false, true, nil, nil); err != nil {
		t.Fatalf("first smart turn: %v", err)
	}
	after, err := loadSessMeta(ws, sid)
	if err != nil || after == nil || after.Smart == nil {
		t.Fatalf("smart pin missing: %+v err=%v", after, err)
	}
	if after.Smart.Model == "" {
		t.Fatal("smart pin has no model")
	}
	// 首次 smart 成功后必须回填具体字段（web applySessionBinding 只认这两个字段）。
	if after.Model != after.Smart.Model || after.Protocol != after.Smart.Protocol {
		t.Fatalf("concrete fields not filled after first smart: %+v", after)
	}
	// 会话列表同样必须暴露绑定字段：UI 恢复绑定读的是列表里的 model/protocol。
	listed, err := listSessions(ws)
	if err != nil {
		t.Fatal(err)
	}
	var found *sessMeta
	for i := range listed {
		if listed[i].ID == sid {
			found = &listed[i]
		}
	}
	if found == nil {
		t.Fatalf("session %s missing from listSessions: %+v", sid, listed)
	}
	if found.Model != after.Smart.Model || found.Protocol != after.Smart.Protocol {
		t.Fatalf("session list does not expose the pinned identity: %+v", found)
	}

	second := appendNativeUser(t, ws, sid, "same tuple join")
	if _, err := h.chatTurn(context.Background(), ws, sid, second.ID, after.Smart.Model, after.Smart.Protocol, false, false, false, false, false, nil, nil); err != nil {
		t.Fatalf("same-tuple join: %v", err)
	}
	joined, err := loadSessMeta(ws, sid)
	if err != nil || joined == nil {
		t.Fatal(err)
	}
	if joined.Smart == nil || joined.Model != after.Smart.Model || joined.Protocol != after.Smart.Protocol {
		t.Fatalf("identity drifted after join: %+v", joined)
	}
	if got := f.resolveCount(); got != 1 {
		t.Fatalf("resolve calls = %d, want 1", got)
	}
}

// 列表标题 repair 不得用旧 metadata 擦掉已钉住的身份。
// 交错顺序：list 读到默认标题的旧 metadata（暂停）→ 首次绑定提交 → 列表 repair
// 完成。旧实现在此把列表读到的旧对象整对象回写，会擦掉刚提交的绑定。
func TestListTitleRepairDoesNotEraseIdentity(t *testing.T) {
	skillTestConf(t)
	f, h := newSmartHub(t, "handwave-hub")
	ws, sid := workspaceWithProject(t, t.TempDir())

	turn := appendNativeUser(t, ws, sid, "list repair race")
	// 复现 repair 分支的目标状态：用户消息已存在，但 meta 仍是默认标题（历史记录）。
	// 若跳过这一步，标题已被追加消息时修好，repair 分支根本不会进入，测试会变成空断言。
	if err := updateSessMeta(ws, sid, func(m *sessMeta) error { m.Title = "新会话"; return nil }); err != nil {
		t.Fatal(err)
	}

	listReadMeta := make(chan struct{})
	release := make(chan struct{})
	doRelease := onceFunc(func() { close(release) })
	testAfterListSessionsMetaRead = claimWindow(listReadMeta, make(chan struct{}), release)

	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	barrierCleanup(t, cancel, &wg, []func(){doRelease}, func() {
		testAfterListSessionsMetaRead = nil
	})

	var listErr error
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, listErr = listSessions(ws)
	}()
	waitSignal(t, listReadMeta, "list never reached the metadata read")

	// 首次绑定在列表持有旧快照期间提交。
	if _, err := h.smartDecisionForTurn(ctx, ws, sid, turn.ID, "smart", false); err != nil {
		t.Fatalf("smart pin: %v", err)
	}
	pinned, err := loadSessMeta(ws, sid)
	if err != nil || pinned == nil || pinned.Smart == nil {
		t.Fatalf("smart pin missing: %+v err=%v", pinned, err)
	}
	doRelease()
	wg.Wait()
	if listErr != nil {
		t.Fatalf("listSessions: %v", listErr)
	}

	after, err := loadSessMeta(ws, sid)
	if err != nil || after == nil {
		t.Fatal(err)
	}
	if after.Smart == nil || after.Smart.DecisionID != pinned.Smart.DecisionID {
		t.Fatalf("list repair erased the smart pin: %+v", after)
	}
	if after.Model != pinned.Model || after.Protocol != pinned.Protocol {
		t.Fatalf("list repair erased concrete identity: %+v", after)
	}
	if isDefaultSessTitle(after.Title) {
		t.Fatalf("list repair did not replace the default title: %q", after.Title)
	}
	// 绑定存活 ⇒ 下一次 smart 不得重复 resolve。
	next := appendNativeUser(t, ws, sid, "after repair")
	if _, err := h.smartDecisionForTurn(ctx, ws, sid, next.ID, "smart", false); err != nil {
		t.Fatalf("smart after repair: %v", err)
	}
	if got := f.resolveCount(); got != 1 {
		t.Fatalf("resolve calls = %d, want 1 (identity must survive the repair)", got)
	}
}

// 并发写入会话 meta 时读取方不得看到半写文件。os.WriteFile 是 truncate-then-write：
// 并发的 chat / 会话列表曾因此读到空或截断的 JSON，表现为 "unexpected end of JSON
// input"。读取必须与写入共用同一把身份锁。
func TestSessionMetaReadNeverObservesPartialWrite(t *testing.T) {
	skillTestConf(t)
	ws, sid := workspaceWithProject(t, t.TempDir())
	if err := updateSessMeta(ws, sid, func(m *sessMeta) error { m.Title = "新会话"; return nil }); err != nil {
		t.Fatal(err)
	}
	// 足够大的 payload：截断与写回之间存在时间窗，无锁时几乎必然被读到。
	big := strings.Repeat("会话标题 ", 4000)

	stop := make(chan struct{})
	var readErrs int32
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			if _, err := loadSessMeta(ws, sid); err != nil {
				atomic.AddInt32(&readErrs, 1)
			}
		}
	}()
	for i := 0; i < 200; i++ {
		title := big + strconv.Itoa(i)
		if err := updateSessMeta(ws, sid, func(m *sessMeta) error { m.Title = title; return nil }); err != nil {
			close(stop)
			t.Fatal(err)
		}
	}
	close(stop)
	wg.Wait()
	if got := atomic.LoadInt32(&readErrs); got != 0 {
		t.Fatalf("readers observed %d partial/invalid session metadata reads", got)
	}
}
