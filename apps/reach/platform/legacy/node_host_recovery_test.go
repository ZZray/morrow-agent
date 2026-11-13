package main

// 宿主队列恢复 / 原子保存 / 取消登记的离线 fixtures。
// 全部使用本地 fixture（scriptedProvider 或 gated hub），不调用真实模型。

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ara/internal/agent"
	"ara/internal/nativeapp"
)

// 回执只按投递标识确认：两条文本完全相同的排队消息必须能被区分。
func TestHostPendingAckIsByDeliveryIDNotText(t *testing.T) {
	a := newTestNodeAgent(t)
	sess := a.hostSession()
	if err := sess.followUp("same text"); err != nil {
		t.Fatal(err)
	}
	if err := sess.steer("same text"); err != nil {
		t.Fatal(err)
	}
	sess.mu.Lock()
	entries := append([]hostPending(nil), sess.state.Pending...)
	sess.mu.Unlock()
	if len(entries) != 2 || entries[0].ID == "" || entries[1].ID == "" || entries[0].ID == entries[1].ID {
		t.Fatalf("ids must be stable and distinct: %+v", entries)
	}
	// 只确认第二条（steer）：第一条必须原样留着，绝不按文本匹配。
	sess.ackDelivery(&agent.DeliveryReceipt{ID: entries[1].ID, Kind: agent.DeliverySteer})
	sess.mu.Lock()
	left := append([]hostPending(nil), sess.state.Pending...)
	sess.mu.Unlock()
	if len(left) != 1 || left[0].ID != entries[0].ID {
		t.Fatalf("ack must be by id only: %+v", left)
	}
	// 控制队列由共享引擎消费（投递时 drop）；host ack 只对账宿主自己的持久记录。
	if sess.control.QueuedMessageCount() != 2 {
		t.Fatalf("the engine owns the control queue: %d", sess.control.QueuedMessageCount())
	}
}

// journal 已提交、host ack 还没落盘就崩溃：恢复必须按 journal 里的投递标识过滤，
// 而不是重复投递，也不是按文本猜。
func TestHostPendingRestoreSkipsCommittedDelivery(t *testing.T) {
	a := newTestNodeAgent(t)
	sess := a.hostSession()
	if err := sess.steer("committed-steer"); err != nil {
		t.Fatal(err)
	}
	if err := sess.steer("undelivered-steer"); err != nil {
		t.Fatal(err)
	}
	sess.mu.Lock()
	committed := sess.state.Pending[0].ID
	undelivered := sess.state.Pending[1].ID
	sess.mu.Unlock()

	store, err := agent.OpenSessionStore(a.nativeSessionDir())
	if err != nil {
		t.Fatal(err)
	}
	created, err := store.Create(agent.SessionOptions{
		ProviderID: hostProviderID, Model: "test-model", System: hostSystemPrompt(), Cwd: currentCwd(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := sess.setNativeID(created.ID); err != nil {
		t.Fatal(err)
	}
	// 用共享引擎把第一条真正提交进 journal（携带同一个投递标识）。
	control := agent.NewControl()
	if err := control.SteerWithID(committed, "committed-steer"); err != nil {
		t.Fatal(err)
	}
	if _, err := nativeapp.Run(context.Background(), nativeapp.Options{
		SessionDir: a.nativeSessionDir(),
		SessionID:  created.ID,
		Cwd:        currentCwd(),
		Control:    control,
		Host: &nativeapp.Host{
			Provider: &scriptedProvider{}, ProviderID: hostProviderID, Model: "test-model", System: hostSystemPrompt(),
		},
	}, nil); err != nil {
		t.Fatalf("engine run: %v", err)
	}
	// 状态文件里仍然留着两条（模拟 ack 未落盘就崩溃）。
	sess.mu.Lock()
	stillPersisted := len(sess.state.Pending)
	sess.mu.Unlock()
	if stillPersisted != 2 {
		t.Fatalf("fixture expects the stale state to still hold both entries: %d", stillPersisted)
	}

	fresh := newHostSession(a.hostStatePath(), func() (*agent.SessionStore, error) {
		return agent.OpenSessionStore(a.nativeSessionDir())
	})
	if err := fresh.blockedErr(); err != nil {
		t.Fatal(err)
	}
	fresh.mu.Lock()
	restored := append([]hostPending(nil), fresh.state.Pending...)
	fresh.mu.Unlock()
	if len(restored) != 1 || restored[0].ID != undelivered {
		t.Fatalf("restore must drop only the committed delivery: %+v (committed=%s)", restored, committed)
	}
	if fresh.control.QueuedMessageCount() != 1 {
		t.Fatalf("restored control queue=%d", fresh.control.QueuedMessageCount())
	}
}

// 版本 1 的纯文本队列没有投递标识，无法证明未投递：保留可见、绝不自动投递。
func TestHostStateIdlessQueueStaysPaused(t *testing.T) {
	a := newTestNodeAgent(t)
	stale := []byte(`{"version":1,"steer":["old steer"],"follow":["old follow"]}`)
	if err := os.WriteFile(a.hostStatePath(), stale, 0o600); err != nil {
		t.Fatal(err)
	}
	sess := a.hostSession()
	if len(sess.state.UnverifiedQueue) != 2 {
		t.Fatalf("id-less queue must be kept visible: %+v", sess.state.UnverifiedQueue)
	}
	if sess.pendingQueued() != 0 || sess.control.QueuedMessageCount() != 0 {
		t.Fatalf("id-less queue must never be auto-delivered: pending=%d control=%d", sess.pendingQueued(), sess.control.QueuedMessageCount())
	}
}

// 损坏状态与非 NotExist 的 IO 失败都必须原样保留并阻断，不能 empty 继续再覆盖。
func TestHostStateBlockedOnCorruptOrUnreadable(t *testing.T) {
	a := newTestNodeAgent(t)
	corrupt := []byte("{not json")
	if err := os.WriteFile(a.hostStatePath(), corrupt, 0o600); err != nil {
		t.Fatal(err)
	}
	sess := a.hostSession()
	if err := sess.blockedErr(); err == nil {
		t.Fatal("a corrupt state must block the session")
	}
	if err := sess.save(); err == nil {
		t.Fatal("save must be refused while blocked")
	}
	if err := sess.steer("must not queue"); err == nil {
		t.Fatal("enqueue must be refused while blocked")
	}
	raw, err := os.ReadFile(a.hostStatePath())
	if err != nil || string(raw) != string(corrupt) {
		t.Fatalf("the original state must be preserved byte for byte: %q err=%v", raw, err)
	}

	// 非 NotExist 的 IO 失败：把状态路径指向一个目录。
	dir := t.TempDir()
	asDir := filepath.Join(dir, "state.json")
	if err := os.Mkdir(asDir, 0o700); err != nil {
		t.Fatal(err)
	}
	blocked := newHostSession(asDir, nil)
	if blocked.blockedErr() == nil {
		t.Fatal("an unreadable state path must block the session")
	}
	if err := blocked.save(); err == nil {
		t.Fatal("save must be refused for an unreadable state path")
	}
}

// 入队必须先持久化：保存失败时不能假装排队成功，也不能留下半条队列。
func TestHostEnqueueFailsWhenStateCannotBeSaved(t *testing.T) {
	a := newTestNodeAgent(t)
	sess := a.hostSession()
	sess.mu.Lock()
	sess.path = filepath.Join(t.TempDir(), "missing-dir", "state.json")
	sess.mu.Unlock()
	if err := sess.steer("must not be queued"); err == nil {
		t.Fatal("enqueue must fail when it cannot be persisted")
	}
	if sess.pendingQueued() != 0 || sess.control.QueuedMessageCount() != 0 {
		t.Fatalf("a failed append must not fake a queued message: pending=%d control=%d",
			sess.pendingQueued(), sess.control.QueuedMessageCount())
	}
}

// 新会话的 ID 与绑定必须在回合开始前就落盘：回合中途崩溃也能找到 journal。
func TestHostSessionIDPersistedBeforeTheTurn(t *testing.T) {
	h := newGatedNodeHarness(t)
	go h.a.runLocalAgent(h.cn, &dcf{K: "agent-loop", ID: "run-pre", Msg: "objective", Model: "default"})
	select {
	case <-h.grants:
	case <-time.After(10 * time.Second):
		t.Fatal("no grant request")
	}
	close(h.release)
	done := h.waitOut(t, "run-pre")
	if done.Code == 0 {
		t.Fatalf("this fixture expects the turn to fail at the provider: %+v", done)
	}
	sess := h.a.hostSession()
	sess.mu.Lock()
	id := sess.state.NativeSessionID
	sess.mu.Unlock()
	if id == "" {
		t.Fatal("the session id must be persisted before the turn runs")
	}
	if _, err := os.Stat(filepath.Join(h.a.nativeSessionDir(), id+".jsonl")); err != nil {
		t.Fatalf("the persisted session must have a journal: %v", err)
	}
	h.waitReleased(t, sess)
}

// 中止帧早于回合的取消登记到达（帧已收到、goroutine 还没启动引擎）：这次取消不能
// 被丢掉，该回合不得启动引擎，也不得申请访问码。
func TestHostAbortBeforeRegistrationIsNotLost(t *testing.T) {
	h := newGatedNodeHarness(t)
	sess := h.a.hostSession()
	// onFrame 在收到 agent-loop 的那一刻同步登记；这里复现「已登记、还没启动」。
	if !h.a.acceptRun("run-early") {
		t.Fatal("a received run must be registered at frame receipt")
	}
	h.a.onFrame(h.cn, &dcf{K: "agent-abort", ID: "run-early"})
	ack := h.waitOut(t, "run-early")
	if ack.Err != "task not running" {
		t.Fatalf("the pre-arrived abort must be acknowledged: %+v", ack)
	}
	go func() {
		defer h.a.finishAccepted("run-early")
		h.a.runLocalAgent(h.cn, &dcf{K: "agent-loop", ID: "run-early", Msg: "objective", Model: "default"})
	}()
	done := h.waitOut(t, "run-early")
	if done.Code == 0 || !strings.Contains(done.Err, "canceled") {
		t.Fatalf("a pre-arrived abort must cancel the turn: %+v", done)
	}
	if len(h.grants) != 0 {
		t.Fatalf("an aborted turn must not request a model grant: %d", len(h.grants))
	}
	h.a.sessMu.Lock()
	left := len(h.a.accepted)
	h.a.sessMu.Unlock()
	if left != 0 {
		t.Fatalf("an accepted run must be cleared once it registered: %d", left)
	}
	h.waitReleased(t, sess)
}

// 未知 ID 的中止帧绝不被记住：它不得取消未来某个同 ID 的 run。
func TestHostAbortForUnknownRunDoesNotCancelAFutureRun(t *testing.T) {
	h := newGatedNodeHarness(t)
	sess := h.a.hostSession()
	h.a.onFrame(h.cn, &dcf{K: "agent-abort", ID: "run-later"})
	if ack := h.waitOut(t, "run-later"); ack.Err != "task not running" {
		t.Fatalf("an unknown abort must still be acknowledged: %+v", ack)
	}
	h.a.sessMu.Lock()
	remembered := len(h.a.accepted)
	h.a.sessMu.Unlock()
	if remembered != 0 {
		t.Fatalf("an unknown abort must not be remembered for a future run: %d", remembered)
	}
	// 同一个 ID 后来到达：必须正常启动（申请访问码），而不是被那次未知中止取消。
	go h.a.runLocalAgent(h.cn, &dcf{K: "agent-loop", ID: "run-later", Msg: "objective", Model: "default"})
	select {
	case g := <-h.grants:
		if g != "run-later" {
			t.Fatalf("grant run=%q", g)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a later run with the same id must not be canceled by a stale unknown abort")
	}
	close(h.release)
	h.waitOut(t, "run-later")
	h.waitReleased(t, sess)
}

// 收到帧就同步登记，所以重复的 agent-loop 在接收时就被拒绝（不会开第二个引擎）。
func TestHostDuplicateAgentLoopIsRejectedAtReceipt(t *testing.T) {
	h := newGatedNodeHarness(t)
	if !h.a.acceptRun("run-dup") {
		t.Fatal("the first run must be accepted")
	}
	h.a.onFrame(h.cn, &dcf{K: "agent-loop", ID: "run-dup", Msg: "objective", Model: "default"})
	if done := h.waitOut(t, "run-dup"); done.Err != "duplicate task id" {
		t.Fatalf("a duplicate agent-loop must be rejected at frame receipt: %+v", done)
	}
	if len(h.grants) != 0 {
		t.Fatalf("a rejected duplicate must not request a model grant: %d", len(h.grants))
	}
	if h.a.hostSession().busyNow() {
		t.Fatal("a rejected duplicate must not reserve the only turn")
	}
	h.a.finishAccepted("run-dup")
}

// 旧历史损坏/导入失败必须阻断回合，绝不用新空会话顶替旧历史。
func TestLegacyImportErrorBlocksTheTurn(t *testing.T) {
	h := newGatedNodeHarness(t)
	writeLegacyFile(t, legacyHistoryJSON(t, completeLegacyHistory()[:3], nil))
	go h.a.runLocalAgent(h.cn, &dcf{K: "agent-loop", ID: "run-legacy", Msg: "objective", Model: "default"})
	select {
	case <-h.grants:
	case <-time.After(10 * time.Second):
		t.Fatal("no grant request")
	}
	close(h.release)
	done := h.waitOut(t, "run-legacy")
	if done.Code == 0 || !strings.Contains(done.Err, "legacy") {
		t.Fatalf("a blocked legacy import must fail the turn: %+v", done)
	}
	if files, _ := filepath.Glob(filepath.Join(h.a.nativeSessionDir(), "*.jsonl")); len(files) != 0 {
		t.Fatalf("a blocked legacy import must not create a session: %v", files)
	}
	h.waitReleased(t, h.a.hostSession())
}

// 未知 ID 与上一回合的旧 ID 的中止帧绝不取消当前占位的另一个 run：B 仍必须成功。
func TestHostUnrelatedAbortKeepsTheRunningTurnAlive(t *testing.T) {
	h := newGatedNodeHarnessWithUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		writeNodeSSEText(w, "ok")
	})
	sess := h.a.hostSession()
	go h.a.runLocalAgent(h.cn, &dcf{K: "agent-loop", ID: "run-b", Msg: "objective", Model: "default"})
	select {
	case g := <-h.grants:
		if g != "run-b" {
			t.Fatalf("grant run=%q", g)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no grant request")
	}
	// 未知 ID 与上一回合的旧 ID：都只被拒绝，绝不取消当前 run-b 的回合。
	for _, stale := range []string{"run-unknown", "run-previous"} {
		h.a.onFrame(h.cn, &dcf{K: "agent-abort", ID: stale})
		if ack := h.waitOut(t, stale); ack.Err != "task not running" {
			t.Fatalf("an abort for %s must be acknowledged as not running: %+v", stale, ack)
		}
	}
	if !sess.busyNow() {
		t.Fatal("an unrelated abort must not cancel the running turn")
	}
	close(h.release)
	done := h.waitOut(t, "run-b")
	if done.Code != 0 || done.Err != "" {
		t.Fatalf("run-b must still succeed after unrelated aborts: %+v", done)
	}
	if sess.pendingQueued() != 0 {
		t.Fatalf("the unrelated abort must not queue anything: %d", sess.pendingQueued())
	}
	h.waitReleased(t, sess)
}

// 匹配当前 run ID 的中止帧必须立刻取消（即使还在等访问码），并且绝不报成功。
func TestHostMatchingAbortCancelsTheRunningTurn(t *testing.T) {
	h := newGatedNodeHarnessWithUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		writeNodeSSEText(w, "ok")
	})
	sess := h.a.hostSession()
	go h.a.runLocalAgent(h.cn, &dcf{K: "agent-loop", ID: "run-b", Msg: "objective", Model: "default"})
	select {
	case <-h.grants:
	case <-time.After(10 * time.Second):
		t.Fatal("no grant request")
	}
	h.a.onFrame(h.cn, &dcf{K: "agent-abort", ID: "run-b"})
	done := h.waitOut(t, "run-b")
	if done.Code == 0 || !strings.Contains(done.Err, "canceled") {
		t.Fatalf("a matching abort must cancel the turn: %+v", done)
	}
	close(h.release)
	h.waitReleased(t, sess)
	if files, _ := filepath.Glob(filepath.Join(h.a.nativeSessionDir(), "*.jsonl")); len(files) != 0 {
		t.Fatalf("an aborted grant wait must not create a session: %v", files)
	}
}

// abort 只按当前占用的 run ID 精确匹配：未知 ID、没有 ID、以及已经结束的旧 ID 都绝不
// 取消当前另一个 run 的回合。
func TestHostAbortRunMatchesOnlyTheCurrentRunID(t *testing.T) {
	a := newTestNodeAgent(t)
	sess := a.hostSession()
	ctxA, _, ok := sess.reserveTurn("run-a")
	if !ok {
		t.Fatal("reserveTurn failed on an idle session")
	}
	if sess.abortRun("run-b") {
		t.Fatal("an unrelated run id must not cancel the turn")
	}
	if sess.abortRun("") {
		t.Fatal("an abort without a run id must not cancel the turn")
	}
	if ctxA.Err() != nil {
		t.Fatal("an unrelated abort must not cancel the reserved turn")
	}
	if !sess.abortRun("run-a") {
		t.Fatal("the matching run id must cancel the turn")
	}
	if ctxA.Err() == nil {
		t.Fatal("a matching abort must cancel the turn context")
	}
	sess.releaseTurn()
	ctxB, _, ok := sess.reserveTurn("run-b")
	if !ok {
		t.Fatal("reserveTurn failed on an idle session")
	}
	if sess.abortRun("run-a") {
		t.Fatal("a finished run id must not cancel the next turn")
	}
	if ctxB.Err() != nil {
		t.Fatal("a stale abort must not cancel the next turn")
	}
	sess.releaseTurn()
}
