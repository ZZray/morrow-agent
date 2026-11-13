package main

// 宿主状态「落盘事务」的离线 fixtures：
//   - 并发保存：快照到 rename 全程串行，旧快照不会覆盖新快照；
//   - 失败入队：内存回滚，不被别人一次成功的保存带上盘；
//   - 绑定失败：不留未持久 binding，journal 保留；
//   - 回合结束保存失败：不得报成功；
//   - 模型换绑：先按旧 journal 确认 pending，内存与磁盘快照一致，确认不了就阻断。
//
// 全部使用本地 fixture（scriptedProvider / 假 hub / 假上游），不调用真实模型。

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ara/internal/agent"
	"ara/internal/nativeapp"
	"ara/internal/providers"
)

// setHostWriteHook 在「取快照之后、原子 rename 之前」插入 fixture 钩子。生产路径
// 的 beforeWrite 永远是 nil。
func setHostWriteHook(t *testing.T, sess *hostSession, hook func(raw []byte) error) {
	t.Helper()
	sess.mu.Lock()
	sess.beforeWrite = hook
	sess.mu.Unlock()
	t.Cleanup(func() {
		sess.mu.Lock()
		sess.beforeWrite = nil
		sess.mu.Unlock()
	})
}

func readHostStateAt(t *testing.T, path string) hostState {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("host state must exist: %v", err)
	}
	var st hostState
	if err := json.Unmarshal(raw, &st); err != nil {
		t.Fatalf("host state must stay readable: %v (%q)", err, raw)
	}
	return st
}

func readHostState(t *testing.T, a *nodeAgent) hostState {
	t.Helper()
	return readHostStateAt(t, a.hostStatePath())
}

func boundSessionID(t *testing.T, sess *hostSession) string {
	t.Helper()
	sess.mu.Lock()
	defer sess.mu.Unlock()
	return sess.state.NativeSessionID
}

func pendingSnapshot(t *testing.T, sess *hostSession) []hostPending {
	t.Helper()
	sess.mu.Lock()
	defer sess.mu.Unlock()
	return append([]hostPending(nil), sess.state.Pending...)
}

func pendingTexts(entries []hostPending) string {
	out := make([]string, 0, len(entries))
	for _, p := range entries {
		out = append(out, p.Kind+":"+p.Text)
	}
	return strings.Join(out, "|")
}

// 并发入队必须整段串行（append → 落盘 → 才曝光给 Control）：第一次落盘还停在
// rename 之前时，第二次入队既不能追加，也不能用旧快照覆盖新快照。
func TestHostConcurrentEnqueueSerializesSnapshotToRename(t *testing.T) {
	a := newTestNodeAgent(t)
	sess := a.hostSession()
	entered := make(chan struct{})
	releaseWrite := make(chan struct{})
	var once sync.Once
	setHostWriteHook(t, sess, func(raw []byte) error {
		once.Do(func() { close(entered) })
		select {
		case <-releaseWrite:
			return nil
		case <-time.After(20 * time.Second):
			return errors.New("fixture barrier timeout")
		}
	})

	first := make(chan error, 1)
	go func() { first <- sess.steer("first") }()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the first save never reached the write barrier")
	}

	second := make(chan error, 1)
	go func() { second <- sess.steer("second") }()
	// 给第二个 goroutine 足够时间撞上锁：串行时它只能等，非串行时它会立刻追加。
	time.Sleep(50 * time.Millisecond)
	if n := sess.pendingQueued(); n != 1 {
		t.Fatalf("the second enqueue must wait for the first snapshot-to-rename transaction: pending=%d", n)
	}
	if n := sess.control.QueuedMessageCount(); n != 0 {
		t.Fatalf("nothing may reach the engine before its own save completed: control=%d", n)
	}

	close(releaseWrite)
	if err := <-first; err != nil {
		t.Fatalf("first enqueue: %v", err)
	}
	if err := <-second; err != nil {
		t.Fatalf("second enqueue: %v", err)
	}
	st := readHostState(t, a)
	if got := pendingTexts(st.Pending); got != "steer:first|steer:second" {
		t.Fatalf("concurrent saves must not lose or reorder the queue: %q", got)
	}
	if n := sess.control.QueuedMessageCount(); n != 2 {
		t.Fatalf("both messages must be exposed exactly once: control=%d", n)
	}
}

// 保存失败的入队必须回滚内存、不曝光给 Control，也不能被后面一次成功的保存带上盘。
func TestHostFailedEnqueueIsRolledBackNotLaundered(t *testing.T) {
	a := newTestNodeAgent(t)
	sess := a.hostSession()
	var failing atomic.Bool
	setHostWriteHook(t, sess, func(raw []byte) error {
		if failing.Load() {
			return errors.New("disk full (fixture)")
		}
		return nil
	})
	if err := sess.steer("kept"); err != nil {
		t.Fatal(err)
	}
	failing.Store(true)
	if err := sess.steer("lost"); err == nil {
		t.Fatal("a save failure must not pretend the message was queued")
	}
	failing.Store(false)
	if err := sess.followUp("kept-2"); err != nil {
		t.Fatal(err)
	}

	st := readHostState(t, a)
	if got := pendingTexts(st.Pending); got != "steer:kept|follow_up:kept-2" {
		t.Fatalf("a failed enqueue must never be persisted by somebody else's save: %q", got)
	}
	if got := pendingTexts(pendingSnapshot(t, sess)); got != "steer:kept|follow_up:kept-2" {
		t.Fatalf("memory must be rolled back to the persisted snapshot: %q", got)
	}
	if n := sess.control.QueuedMessageCount(); n != 2 {
		t.Fatalf("a failed enqueue must never reach the engine: control=%d", n)
	}
}

// 绑定保存失败必须回滚：绝不留一份没落盘的 binding 让下一次 Run 绕过预保存。
func TestHostBindingSaveFailureRollsBack(t *testing.T) {
	a := newTestNodeAgent(t)
	sess := a.hostSession()
	const first = "session_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const second = "session_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	var failing atomic.Bool
	setHostWriteHook(t, sess, func(raw []byte) error {
		if failing.Load() {
			return errors.New("disk full (fixture)")
		}
		return nil
	})
	if err := sess.setNativeID(first); err != nil {
		t.Fatal(err)
	}
	failing.Store(true)
	if err := sess.setNativeID(second); err == nil {
		t.Fatal("an unpersisted binding must be reported")
	}
	if got := boundSessionID(t, sess); got != first {
		t.Fatalf("the unpersisted binding must be rolled back, not kept for the next run: %q", got)
	}
	if st := readHostState(t, a); st.NativeSessionID != first {
		t.Fatalf("the persisted binding must be unchanged: %q", st.NativeSessionID)
	}
	failing.Store(false)
	// 绑定没变时是幂等的（不重复落盘），变了才必须成功落盘。
	if err := sess.setNativeID(first); err != nil {
		t.Fatal(err)
	}
	if err := sess.setNativeID(second); err != nil {
		t.Fatal(err)
	}
	if st := readHostState(t, a); st.NativeSessionID != second {
		t.Fatalf("a persisted binding must be visible on disk: %q", st.NativeSessionID)
	}
}

// 新会话绑定落盘失败：回合必须可见地失败，内存里不留未持久 binding，
// 但已经创建的 journal 保留在磁盘上。
func TestHostTurnFailsWhenBindingCannotBePersisted(t *testing.T) {
	h := newGatedNodeHarness(t)
	sess := h.a.hostSession()
	var writes atomic.Int32
	setHostWriteHook(t, sess, func(raw []byte) error {
		// 第 1 次写记录本次 model，第 2 次写是新会话的绑定落盘。
		if writes.Add(1) >= 2 {
			return errors.New("disk full (fixture)")
		}
		return nil
	})
	go h.a.runLocalAgent(h.cn, &dcf{K: "agent-loop", ID: "run-bind", Msg: "objective", Model: "default"})
	select {
	case <-h.grants:
	case <-time.After(10 * time.Second):
		t.Fatal("no grant request")
	}
	close(h.release)
	done := h.waitOut(t, "run-bind")
	if done.Code == 0 || !strings.Contains(done.Err, "persisted") {
		t.Fatalf("an unpersisted binding must fail the turn visibly: %+v", done)
	}
	if got := boundSessionID(t, sess); got != "" {
		t.Fatalf("the unpersisted binding must not stay in memory: %q", got)
	}
	files, err := filepath.Glob(filepath.Join(h.a.nativeSessionDir(), "*.jsonl"))
	if err != nil || len(files) != 1 {
		t.Fatalf("the created journal must be kept, not deleted: %v err=%v", files, err)
	}
	h.waitReleased(t, sess)
}

// 回合结束的宿主状态保存失败不得报成功（journal 与已落盘的绑定都保留）。
func TestHostTurnEndSaveFailureIsNotSuccess(t *testing.T) {
	h := newE2EHarness(t, func(w http.ResponseWriter, r *http.Request) {
		writeNodeSSEText(w, "ok")
	})
	done, _ := h.runTurn(t, "run-a", "first", "", "default")
	if done.Code != 0 || done.Err != "" {
		t.Fatalf("the first turn must succeed: %+v", done)
	}
	sess := h.a.hostSession()
	first := boundSessionID(t, sess)
	if first == "" {
		t.Fatal("the first turn must persist its binding")
	}

	setHostWriteHook(t, sess, func(raw []byte) error { return errors.New("disk full (fixture)") })
	done, types := h.runTurn(t, "run-b", "second", "", "default")
	if done.Code == 0 || !strings.Contains(done.Err, "persisted") {
		t.Fatalf("a turn whose host state could not be saved must not report success: %+v events=%v", done, types)
	}
	if got := boundSessionID(t, sess); got != first {
		t.Fatalf("the already persisted binding must be kept for the next resume: %q -> %q", first, got)
	}
	if _, err := os.Stat(filepath.Join(h.a.nativeSessionDir(), first+".jsonl")); err != nil {
		t.Fatalf("the journal must be kept: %v", err)
	}
}

// 模型显式换绑之前必须按**旧 session 的 journal** 确认 pending，并把换绑结果
// 原子落盘：内存与磁盘快照一致，已提交的投递被确认丢弃，未投递的原样保留。
func TestHostModelSwitchConfirmsPendingAgainstOldJournal(t *testing.T) {
	a := newTestNodeAgent(t)
	sess := a.hostSession()
	store, err := agent.OpenSessionStore(a.nativeSessionDir())
	if err != nil {
		t.Fatal(err)
	}
	created, err := store.Create(agent.SessionOptions{
		ProviderID: hostProviderID, Model: "model-a", System: hostSystemPrompt(), Cwd: currentCwd(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := sess.setNativeID(created.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := sess.sessionBinding("model-a", providers.OpenAICompletions); err != nil {
		t.Fatal(err)
	}
	if err := sess.steer("committed-steer"); err != nil {
		t.Fatal(err)
	}
	if err := sess.followUp("undelivered-follow"); err != nil {
		t.Fatal(err)
	}
	committed := pendingSnapshot(t, sess)[0].ID

	// 用共享引擎把第一条真正提交进旧会话的 journal（携带同一个投递标识）。
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
			Provider: &scriptedProvider{}, ProviderID: hostProviderID, Model: "model-a", System: hostSystemPrompt(),
		},
	}, nil); err != nil {
		t.Fatalf("engine run: %v", err)
	}

	id, switchedFrom, err := sess.sessionBinding("model-b", providers.OpenAICompletions)
	if err != nil {
		t.Fatal(err)
	}
	if id != "" || switchedFrom != created.ID {
		t.Fatalf("a model switch must start a new session: id=%q switchedFrom=%q", id, switchedFrom)
	}
	st := readHostState(t, a)
	if st.NativeSessionID != "" || st.PrevSessionID != created.ID || st.Model != "model-b" {
		t.Fatalf("the switch must be persisted atomically: %+v", st)
	}
	if len(st.Pending) != 1 || st.Pending[0].ID == committed || st.Pending[0].Kind != "follow_up" {
		t.Fatalf("only the journal-committed delivery may be dropped: %+v", st.Pending)
	}
	if got, disk := pendingTexts(pendingSnapshot(t, sess)), pendingTexts(st.Pending); got != disk {
		t.Fatalf("memory and the persisted snapshot must agree: %q vs %q", got, disk)
	}
}

// 旧 journal 读不到时无法确认 pending：换绑必须显式失败，持久快照原样保留。
func TestHostModelSwitchBlockedWhenOldJournalUnreadable(t *testing.T) {
	a := newTestNodeAgent(t)
	sess := a.hostSession()
	store, err := agent.OpenSessionStore(a.nativeSessionDir())
	if err != nil {
		t.Fatal(err)
	}
	created, err := store.Create(agent.SessionOptions{
		ProviderID: hostProviderID, Model: "model-a", System: hostSystemPrompt(), Cwd: currentCwd(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := sess.setNativeID(created.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := sess.sessionBinding("model-a", providers.OpenAICompletions); err != nil {
		t.Fatal(err)
	}
	if err := sess.steer("queued"); err != nil {
		t.Fatal(err)
	}
	before := readHostState(t, a)
	if err := os.Remove(filepath.Join(a.nativeSessionDir(), created.ID+".jsonl")); err != nil {
		t.Fatal(err)
	}
	id, switchedFrom, err := sess.sessionBinding("model-b", providers.OpenAICompletions)
	if err == nil {
		t.Fatalf("a switch must be blocked when the old journal cannot confirm the queue: id=%q from=%q", id, switchedFrom)
	}
	after := readHostState(t, a)
	if after.NativeSessionID != before.NativeSessionID || after.Model != before.Model ||
		pendingTexts(after.Pending) != pendingTexts(before.Pending) {
		t.Fatalf("a blocked switch must leave the persisted snapshot untouched: %+v -> %+v", before, after)
	}
	if got := boundSessionID(t, sess); got != created.ID {
		t.Fatalf("a blocked switch must not clear the binding in memory: %q", got)
	}
}

// 无法证明的 pending 条目（缺 ID / 未知 kind / 重复 ID）必须阻断装载并原样保留：
// 不静默 drop，也不把未知 kind 默认当成 follow_up。
func TestHostInvalidPendingBlocksAndIsPreserved(t *testing.T) {
	cases := []struct {
		name    string
		pending []hostPending
		want    string
	}{
		{"missing delivery id", []hostPending{{Kind: "steer", Text: "no id"}}, "no delivery id"},
		{"unsupported kind", []hostPending{{ID: "d-1", Kind: "interrupt", Text: "unknown kind"}}, "unsupported delivery kind"},
		{"duplicate delivery id", []hostPending{
			{ID: "d-1", Kind: "steer", Text: "first"},
			{ID: "d-1", Kind: "follow_up", Text: "second"},
		}, "repeats delivery id"},
		{"empty text", []hostPending{{ID: "d-1", Kind: "steer"}}, "empty text"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := newTestNodeAgent(t)
			s := a.hostSession()
			raw, err := json.Marshal(hostState{Version: hostStateVersion, Pending: tc.pending})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(s.path, raw, 0o600); err != nil {
				t.Fatal(err)
			}
			restored := newHostSession(s.path, s.openStore)
			blocked := restored.blockedErr()
			if blocked == nil {
				t.Fatal("an unverifiable pending entry must block instead of being dropped or defaulted")
			}
			if !strings.Contains(blocked.Error(), tc.want) {
				t.Fatalf("the block reason must name the problem: %v", blocked)
			}
			if n := restored.control.QueuedMessageCount(); n != 0 {
				t.Fatalf("a blocked queue must not be exposed to the engine: %d", n)
			}
			kept := readHostStateAt(t, s.path)
			if len(kept.Pending) != len(tc.pending) {
				t.Fatalf("the original entries must be preserved on disk: %+v", kept.Pending)
			}
			for i := range kept.Pending {
				if kept.Pending[i].Text != tc.pending[i].Text || kept.Pending[i].ID != tc.pending[i].ID {
					t.Fatalf("entry %d was rewritten: %+v", i+1, kept.Pending[i])
				}
			}
			// 阻断期间保存与入队都被拒绝，原文件不会被空状态覆盖。
			if err := restored.save(); err == nil {
				t.Fatal("save must be refused while blocked")
			}
			if err := restored.steer("must not queue"); err == nil {
				t.Fatal("enqueue must be refused while blocked")
			}
			if got := readHostStateAt(t, s.path); len(got.Pending) != len(tc.pending) {
				t.Fatalf("a refused save must not touch the file: %+v", got.Pending)
			}
		})
	}
}

// 旧历史导入的绑定落盘失败必须整体回滚内存（Imported/绑定/待导入历史），journal
// 原样保留：重启后用同一个 source ID 幂等命中它，绝不新建第二个会话、也绝不丢历史。
func TestLegacyImportBindingFailureRollsBackAndRetries(t *testing.T) {
	a := newTestNodeAgent(t)
	raw := legacyHistoryJSON(t, completeLegacyHistory(), nil)
	writeLegacyFile(t, raw)
	sess := a.hostSession()
	if rec := sess.state.Legacy; rec == nil || !rec.Pending || rec.Messages != 4 {
		t.Fatalf("fixture did not verify the legacy history: %+v", rec)
	}
	var failing atomic.Bool
	failing.Store(true)
	setHostWriteHook(t, sess, func(raw []byte) error {
		if failing.Load() {
			return errors.New("disk full (fixture)")
		}
		return nil
	})
	id, err := sess.importLegacyHistory("test-model")
	if err == nil || !strings.Contains(err.Error(), "not persisted") {
		t.Fatalf("an unpersisted binding must be reported: id=%q err=%v", id, err)
	}
	if id != "" {
		t.Fatalf("a failed binding must not report a session id: %q", id)
	}
	sess.mu.Lock()
	rolledBack := !sess.state.Legacy.Imported && sess.state.Legacy.Pending &&
		sess.state.NativeSessionID == "" && len(sess.legacyMessages) == 4
	sess.mu.Unlock()
	if !rolledBack {
		t.Fatal("the unpersisted import must be rolled back in memory")
	}
	if st := readHostState(t, a); st.NativeSessionID != "" || st.Legacy == nil || st.Legacy.Imported {
		t.Fatalf("the persisted snapshot must not claim an unpersisted import: %+v", st)
	}
	// 重启：状态文件里没有绑定，但 journal 还在。同一个 source ID 幂等命中它。
	fresh := newHostSession(a.hostStatePath(), func() (*agent.SessionStore, error) {
		return agent.OpenSessionStore(a.nativeSessionDir())
	})
	if err := fresh.blockedErr(); err != nil {
		t.Fatal(err)
	}
	fresh.mu.Lock()
	reverified := len(fresh.legacyMessages)
	fresh.mu.Unlock()
	if reverified != 4 {
		t.Fatalf("a restart must re-derive the pending history, not lose it: %d", reverified)
	}
	got, err := fresh.importLegacyHistory("test-model")
	if err != nil || got == "" {
		t.Fatalf("the retry must reuse the kept journal: id=%q err=%v", got, err)
	}
	store, err := agent.OpenSessionStore(a.nativeSessionDir())
	if err != nil {
		t.Fatal(err)
	}
	list, err := store.List()
	if err != nil || len(list) != 1 || list[0].ID != got {
		t.Fatalf("the journal must be kept and reused, never duplicated: %v err=%v", list, err)
	}
	if st := readHostState(t, a); st.NativeSessionID != got {
		t.Fatalf("the retried binding must be persisted: %q", st.NativeSessionID)
	}
}
