package main

// 旧 ID-less paused 队列的查看与显式处置（agent-queue-recovery）离线 fixtures：
// 预览与稳定 ID、显式重排队的事务性与重放拒绝、忙/阻断时拒绝、未知原类别必须显式选择、
// 放弃保留审计且重启不再出现。全部使用 tempdir + 已配对 datachannel fixture。

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

// sendQueueFrame 通过已配对的 datachannel fixture 发一帧 agent-queue-recovery 并读回 out。
func sendQueueFrame(t *testing.T, h *gatedNodeHarness, f dcf) (hostQueueResponse, dcf) {
	t.Helper()
	h.a.onFrame(h.cn, &f)
	done := h.waitOut(t, f.ID)
	var resp hostQueueResponse
	if done.Code == 0 {
		raw := unb64(done.B64)
		if err := json.Unmarshal(raw, &resp); err != nil {
			t.Fatalf("queue recovery payload: %v (%q)", err, raw)
		}
	}
	return resp, done
}

func TestQueueRecoveryListPreviewAndStableIDs(t *testing.T) {
	h := newGatedNodeHarness(t)
	writeLegacyFile(t, legacyHistoryJSON(t, completeLegacyHistory(), map[string]any{
		"steer":  []string{"once", "same"},
		"follow": []string{"same"},
	}))
	resp, done := sendQueueFrame(t, h, dcf{K: "agent-queue-recovery", ID: "q-list", Msg: "list"})
	if done.Code != 0 || done.Err != "" {
		t.Fatalf("list must succeed: %+v", done)
	}
	if resp.Action != "list" || resp.Blocked != "" || resp.Busy {
		t.Fatalf("preview=%+v", resp)
	}
	if len(resp.Entries) != 3 {
		t.Fatalf("entries=%+v", resp.Entries)
	}
	// 来源与原来的类别照实记下来（steer/follow 是两个数组，绝不合并猜测）。
	if resp.Entries[0].Kind != "steer" || !resp.Entries[0].KindKnown || resp.Entries[2].Kind != "follow_up" {
		t.Fatalf("kinds=%+v", resp.Entries)
	}
	for _, e := range resp.Entries {
		if e.Source != legacyStateFile || e.ID == "" {
			t.Fatalf("entry=%+v", e)
		}
	}
	// 文本相同的两条必须能被区分：ID 由来源 + 位置 + 原文决定。
	if resp.Entries[1].Text != resp.Entries[2].Text || resp.Entries[1].ID == resp.Entries[2].ID {
		t.Fatalf("identical texts must stay distinguishable: %+v", resp.Entries)
	}
	// 重启（重新装载同一份状态与旧文件）后条目与 ID 必须稳定，也不重复 adoption。
	next := reloadCoordinatorHost(h.a)
	after := next.pausedQueuePreview()
	if after.Revision != resp.Revision || len(after.Entries) != len(resp.Entries) {
		t.Fatalf("a restart must not change the preview: %+v vs %+v", after, resp)
	}
	for i := range after.Entries {
		if after.Entries[i].ID != resp.Entries[i].ID || after.Entries[i].Source != resp.Entries[i].Source {
			t.Fatalf("entry %d changed across a restart: %+v vs %+v", i, after.Entries[i], resp.Entries[i])
		}
	}
}

func TestQueueRecoveryRequeueIsAtomicAndReplayRefused(t *testing.T) {
	h := newGatedNodeHarness(t)
	writeLegacyFile(t, legacyHistoryJSON(t, completeLegacyHistory(), map[string]any{
		"steer":  []string{"old steer"},
		"follow": []string{"old follow"},
	}))
	preview, done := sendQueueFrame(t, h, dcf{K: "agent-queue-recovery", ID: "q-list", Msg: "list"})
	if done.Code != 0 || len(preview.Entries) != 2 {
		t.Fatalf("preview=%+v done=%+v", preview, done)
	}
	target := preview.Entries[0] // 原类别 steer，操作者显式改成 follow_up
	requeued, done := sendQueueFrame(t, h, dcf{
		K: "agent-queue-recovery", ID: "q-req", Msg: "requeue",
		Entry: target.ID, Kind: "follow_up", Rev: preview.Revision,
	})
	if done.Code != 0 {
		t.Fatalf("requeue rejected: %+v", done)
	}
	if requeued.Action != "requeue" || requeued.Delivery == "" || requeued.Revision != preview.Revision+1 {
		t.Fatalf("requeue result=%+v", requeued)
	}
	if len(requeued.Entries) != 1 || requeued.Entries[0].ID == target.ID {
		t.Fatalf("the requeued entry must leave the paused queue: %+v", requeued.Entries)
	}
	// 同一个宿主状态事务：paused 少一条、Pending 多一条带投递标识的、审计记下这次处置。
	st := readHostState(t, h.a)
	if len(st.Pending) != 1 || st.Pending[0].ID != requeued.Delivery ||
		st.Pending[0].Kind != "follow_up" || st.Pending[0].Text != "old steer" {
		t.Fatalf("pending=%+v", st.Pending)
	}
	if len(st.LegacyPausedQueue) != 1 || st.LegacyPausedQueue[0].Text != "old follow" {
		t.Fatalf("paused=%+v", st.LegacyPausedQueue)
	}
	if st.QueueRevision != requeued.Revision {
		t.Fatalf("revision=%d want %d", st.QueueRevision, requeued.Revision)
	}
	if len(st.QueueAudit) != 1 || st.QueueAudit[0].Action != "requeue" || st.QueueAudit[0].Entry != target.ID ||
		st.QueueAudit[0].Kind != "follow_up" || st.QueueAudit[0].Original != "steer" || st.QueueAudit[0].Delivery != requeued.Delivery {
		t.Fatalf("audit=%+v", st.QueueAudit)
	}
	if n := h.a.hostSession().control.QueuedMessageCount(); n != 1 {
		t.Fatalf("the engine must see exactly one delivery: %d", n)
	}
	// 重放同一个请求（同一旧版本、同一条目）：必须明确拒绝，绝不二次入队。
	if _, replay := sendQueueFrame(t, h, dcf{
		K: "agent-queue-recovery", ID: "q-replay", Msg: "requeue",
		Entry: target.ID, Kind: "follow_up", Rev: preview.Revision,
	}); replay.Code == 0 || !strings.Contains(replay.Err, "stale preview") {
		t.Fatalf("a replayed request must be refused precisely: %+v", replay)
	}
	if again := readHostState(t, h.a); len(again.Pending) != 1 || again.QueueRevision != requeued.Revision {
		t.Fatalf("a replayed request must not change anything: %+v", again)
	}
	if n := h.a.hostSession().control.QueuedMessageCount(); n != 1 {
		t.Fatalf("a replayed request must not enqueue a second delivery: %d", n)
	}
	// 用当前版本放弃剩下那一条：审计追加，且没有任何新投递。
	discarded, done := sendQueueFrame(t, h, dcf{
		K: "agent-queue-recovery", ID: "q-discard", Msg: "discard",
		Entry: requeued.Entries[0].ID, Rev: requeued.Revision,
	})
	if done.Code != 0 || len(discarded.Entries) != 0 || len(discarded.Audit) != 2 {
		t.Fatalf("discard result=%+v done=%+v", discarded, done)
	}
	if discarded.Audit[1].Action != "discard" || discarded.Audit[1].Entry != requeued.Entries[0].ID {
		t.Fatalf("audit=%+v", discarded.Audit)
	}
	sess := h.a.hostSession()
	if sess.pendingQueued() != 1 || sess.control.QueuedMessageCount() != 1 {
		t.Fatalf("discard must not queue anything: pending=%d control=%d", sess.pendingQueued(), sess.control.QueuedMessageCount())
	}
}

func TestQueueRecoveryRequeueRollsBackWhenStateCannotBeSaved(t *testing.T) {
	h := newGatedNodeHarness(t)
	writeLegacyFile(t, legacyHistoryJSON(t, completeLegacyHistory(), map[string]any{"steer": []string{"kept"}}))
	sess := h.a.hostSession()
	preview := sess.pausedQueuePreview()
	if len(preview.Entries) != 1 {
		t.Fatalf("preview=%+v", preview)
	}
	target := preview.Entries[0]
	setHostWriteHook(t, sess, func(raw []byte) error { return errors.New("disk full (fixture)") })
	if _, done := sendQueueFrame(t, h, dcf{
		K: "agent-queue-recovery", ID: "q-fail", Msg: "requeue",
		Entry: target.ID, Kind: "steer", Rev: preview.Revision,
	}); done.Code == 0 || !strings.Contains(done.Err, "not persisted") {
		t.Fatalf("a failed transaction must be visible: %+v", done)
	}
	after := sess.pausedQueuePreview()
	if len(after.Entries) != 1 || after.Entries[0].ID != target.ID || after.Revision != preview.Revision {
		t.Fatalf("a failed transaction must be rolled back in memory: %+v", after)
	}
	if sess.pendingQueued() != 0 || sess.control.QueuedMessageCount() != 0 {
		t.Fatalf("a failed transaction must not queue anything: pending=%d control=%d",
			sess.pendingQueued(), sess.control.QueuedMessageCount())
	}
	st := readHostState(t, h.a)
	if len(st.Pending) != 0 || len(st.QueueAudit) != 0 || len(st.LegacyPausedQueue) != 1 || st.QueueRevision != preview.Revision {
		t.Fatalf("disk must keep the pre-change snapshot: %+v", st)
	}
	// 修好之后，同一个视图重试必须成功：那次失败没有改动版本。
	setHostWriteHook(t, sess, nil)
	retried, done := sendQueueFrame(t, h, dcf{
		K: "agent-queue-recovery", ID: "q-retry", Msg: "requeue",
		Entry: target.ID, Kind: "steer", Rev: preview.Revision,
	})
	if done.Code != 0 || retried.Delivery == "" {
		t.Fatalf("the retry must succeed: %+v %+v", done, retried)
	}
}

func TestQueueRecoveryRefusedWhileBusy(t *testing.T) {
	h := newGatedNodeHarness(t)
	writeLegacyFile(t, legacyHistoryJSON(t, completeLegacyHistory(), map[string]any{"steer": []string{"pending one"}}))
	sess := h.a.hostSession()
	preview := sess.pausedQueuePreview()
	if _, _, ok := sess.reserveTurn("run-busy"); !ok {
		t.Fatal("reserveTurn failed on an idle session")
	}
	defer sess.releaseTurn()
	busy, done := sendQueueFrame(t, h, dcf{K: "agent-queue-recovery", ID: "q-list", Msg: "list"})
	if done.Code != 0 || !busy.Busy || len(busy.Entries) != 1 {
		t.Fatalf("list must stay readable while a turn runs: %+v done=%+v", busy, done)
	}
	if _, refused := sendQueueFrame(t, h, dcf{
		K: "agent-queue-recovery", ID: "q-busy", Msg: "discard",
		Entry: preview.Entries[0].ID, Rev: preview.Revision,
	}); refused.Code == 0 || !strings.Contains(refused.Err, "idle") {
		t.Fatalf("a change must be refused while a turn runs: %+v", refused)
	}
}

func TestQueueRecoveryUnknownKindNeedsExplicitChoice(t *testing.T) {
	a := newTestNodeAgent(t)
	s := a.hostSession()
	// 本切片之前落盘的是纯文本数组：类别已经丢了，必须按「未知」装载，绝不默认猜。
	stale := []byte(`{"version":2,"legacy_paused_queue":["old text"]}`)
	if err := os.WriteFile(s.path, stale, 0o600); err != nil {
		t.Fatal(err)
	}
	restored := newHostSession(s.path, s.openStore)
	preview := restored.pausedQueuePreview()
	if len(preview.Entries) != 1 || preview.Entries[0].KindKnown || preview.Entries[0].Kind != "" {
		t.Fatalf("a text-only legacy entry must be unknown-kind: %+v", preview.Entries)
	}
	if preview.Entries[0].ID == "" || preview.Entries[0].Source != legacyStateFile {
		t.Fatalf("entry=%+v", preview.Entries[0])
	}
	if _, err := restored.requeuePaused(preview.Entries[0].ID, "", "fp-test", preview.Revision); err == nil {
		t.Fatal("an unknown original kind must not be defaulted")
	}
	if restored.pendingQueued() != 0 || restored.control.QueuedMessageCount() != 0 {
		t.Fatal("a refused requeue must not queue anything")
	}
	resp, err := restored.requeuePaused(preview.Entries[0].ID, "follow_up", "fp-test", preview.Revision)
	if err != nil || resp.Delivery == "" {
		t.Fatalf("an explicit kind must be accepted: %+v err=%v", resp, err)
	}
}

func TestQueueRecoveryDiscardKeepsAuditAndSurvivesRestart(t *testing.T) {
	a := newTestNodeAgent(t)
	raw := legacyHistoryJSON(t, completeLegacyHistory(), map[string]any{"steer": []string{"first", "second"}})
	source, sum := writeLegacyFile(t, raw)
	sess := a.hostSession()
	preview := sess.pausedQueuePreview()
	if len(preview.Entries) != 2 {
		t.Fatalf("preview=%+v", preview)
	}
	target := preview.Entries[0]
	resp, err := sess.discardPaused(target.ID, "fp-test", preview.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Action != "discard" || resp.Revision != preview.Revision+1 || len(resp.Entries) != 1 || resp.Entries[0].ID == target.ID {
		t.Fatalf("discard result=%+v", resp)
	}
	if len(resp.Audit) != 1 || resp.Audit[0].Action != "discard" || resp.Audit[0].Entry != target.ID ||
		resp.Audit[0].Controller != "fp-test" || resp.Audit[0].Text != "first" {
		t.Fatalf("audit=%+v", resp.Audit)
	}
	if sess.pendingQueued() != 0 || sess.control.QueuedMessageCount() != 0 {
		t.Fatalf("discard must not deliver anything: pending=%d control=%d", sess.pendingQueued(), sess.control.QueuedMessageCount())
	}
	// 旧 agent-loop.json 与它的备份一个字节都不改。
	if still, err := os.ReadFile(source); err != nil || shaHex(still) != sum {
		t.Fatalf("the legacy file must stay byte-identical: err=%v", err)
	}
	if backup, err := os.ReadFile(source + ".backup-" + sum[:12]); err != nil || shaHex(backup) != sum {
		t.Fatalf("the backup must stay byte-identical: err=%v", err)
	}
	// 重启：已处置项不再出现、也不重复 adoption，审计与版本保留。
	next := reloadCoordinatorHost(a)
	after := next.pausedQueuePreview()
	if len(after.Entries) != 1 || after.Entries[0].ID != resp.Entries[0].ID || after.Revision != resp.Revision {
		t.Fatalf("a disposed entry must not come back: %+v", after)
	}
	if len(after.Audit) != 1 || after.Audit[0].Action != "discard" {
		t.Fatalf("the audit must survive a restart: %+v", after.Audit)
	}
	if next.control.QueuedMessageCount() != 0 {
		t.Fatal("a restart must not deliver a disposed entry")
	}
}

func TestQueueRecoveryListReadsBlockedState(t *testing.T) {
	a := newTestNodeAgent(t)
	s := a.hostSession()
	if err := os.WriteFile(s.path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	blocked := newHostSession(s.path, s.openStore)
	preview := blocked.pausedQueuePreview()
	if preview.Blocked == "" {
		t.Fatal("list must still report why the host state is blocked")
	}
	if _, err := blocked.discardPaused("pq-1", "fp-test", preview.Revision); err == nil {
		t.Fatal("a blocked state must refuse queue changes")
	}
	if _, err := blocked.requeuePaused("pq-1", "steer", "fp-test", preview.Revision); err == nil {
		t.Fatal("a blocked state must refuse queue changes")
	}
}

func TestQueueRecoveryFrameErrors(t *testing.T) {
	h := newGatedNodeHarness(t)
	if _, done := sendQueueFrame(t, h, dcf{K: "agent-queue-recovery", ID: "q-1", Msg: "nope"}); done.Code == 0 ||
		!strings.Contains(done.Err, "unknown queue recovery action") {
		t.Fatalf("an unknown action must be refused: %+v", done)
	}
	if _, done := sendQueueFrame(t, h, dcf{K: "agent-queue-recovery", ID: "q-2", Msg: "discard"}); done.Code == 0 ||
		!strings.Contains(done.Err, "entry id required") {
		t.Fatalf("a missing entry id must be refused: %+v", done)
	}
	if _, done := sendQueueFrame(t, h, dcf{
		K: "agent-queue-recovery", ID: "q-3", Msg: "discard", Entry: "pq-missing", Rev: 0,
	}); done.Code == 0 || !strings.Contains(done.Err, "not in the current preview") {
		t.Fatalf("an unknown entry must be refused: %+v", done)
	}
}
