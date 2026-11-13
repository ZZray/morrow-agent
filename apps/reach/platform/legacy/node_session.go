package main

// node 的宿主会话层。
//
// HandWave 不再自己跑模型循环：每一回合都由共享原生引擎执行
// （internal/nativeapp.Host + internal/agent.Engine）。本文件只保留必须留在宿主
// 的东西：原生会话标识、跨回合控制队列（steer / follow / interrupt）、任务板、
// ask_user 等待、旁路命令运行器和宿主状态落盘。
//
// 它不是一个执行引擎：这里没有模型调用、没有协议解析、没有供应商重试、没有
// 第二套 journal。
//
// 排队消息按共享核心的投递标识（agent.DeliveryReceipt.ID）记账：
//   - 入队先持久化再交给 Control，保存失败绝不假装排队成功；
//   - 回执只按 ID 精确匹配（绝不按文本、顺序或“本轮第几条”）；
//   - 恢复时先读对应原生 journal，丢弃已经提交过的 ID，
//     因此「journal 已提交但 host ack 未落盘就崩溃」不会重复投递。

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"ara/internal/agent"
	"ara/internal/providers"
)

const (
	// hostProviderID is the stable provider identity.
	hostProviderID = "handwave-node"
	// hostStateFile 是新的宿主状态文件；旧 agent-loop.json 原字节保留不动。
	hostStateFile = "node-agent-state.json"
	// hostNativeDir 存放共享核心的会话 journal。
	hostNativeDir = "native-sessions"
	// hostMaxTurns 沿用旧本机循环的 16 回合上限。
	hostMaxTurns = 16
	// hostDelegateLimit 沿用旧循环「每回合最多 3 个 delegate」。
	hostDelegateLimit = 3
	// maxBoardTasks 沿用旧任务板 40 项上限。
	maxBoardTasks = 40
	uiWait        = 2 * time.Minute

	// hostStateVersion 2 起，待投递队列带投递标识。版本 1 的纯文本队列无法证明
	// 是否已投递，只能显式保留为 paused，绝不猜文本、绝不自动重投。
	hostStateVersion = 2

	// 旧的压缩策略是「≥10 条消息、保留尾部 6 条」，共享引擎只认 token 阈值。
	// 这里给一个等价的保守阈值，宿主不按回合改动它。
	hostCompactThresholdTokens = 24000
	hostCompactSummaryTokens   = 4000
)

type uiAnswer struct {
	text string
	ok   bool
}

// hostTask 是任务板一项，可见字段与旧 agentloop.Task 一致。
type hostTask struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
	Kind   string `json:"kind"`
	Detail string `json:"detail,omitempty"`
}

// hostPending 是一条宿主排队的消息。ID 是提交进原生 journal 的投递标识，
// 也是唯一用来确认投递的键。
type hostPending struct {
	ID   string `json:"id"`
	Kind string `json:"kind"` // steer | follow_up
	Text string `json:"text"`
}

// hostState 是 node 自有的持久状态：会话标识、任务板、待投递队列和迁移记录。
// 不含凭据，也不含对话——对话在原生 journal 里，这里只存引用。
type hostState struct {
	Version         int    `json:"version"`
	NativeSessionID string `json:"native_session_id,omitempty"`
	PrevSessionID   string `json:"prev_session_id,omitempty"`
	Model           string `json:"model,omitempty"`
	// Protocol 与 Model 一起构成宿主会话身份。旧状态没有这个字段：那些会话是本变更
	// 之前（只有 chat 接线）创建的，因此按 chat 续接，绝不猜成别的协议。
	Protocol string `json:"protocol,omitempty"`
	// Binding 是智能路径的可信绑定引用（非敏感，只是 Hub 侧记录的 id）。
	// Decision 是对应的决策 ID。两者只用于"下一个 run 继续用同一绑定"，
	// **不是新的授权来源**：真正的授权事实仍在 Hub 侧记录里。
	Binding     string        `json:"binding,omitempty"`
	Decision    string        `json:"decision,omitempty"`
	Tasks       []hostTask    `json:"tasks,omitempty"`
	Pending     []hostPending `json:"pending,omitempty"`
	AutoCompact *bool         `json:"auto_compact,omitempty"`
	Legacy      *legacyRecord `json:"legacy,omitempty"`

	// Steer/Follow 是版本 1 的纯文本队列输入，只读兼容：装载时搬到 UnverifiedQueue，
	// 不再写回、不再入队。
	Steer  []string `json:"steer,omitempty"`
	Follow []string `json:"follow,omitempty"`
	// UnverifiedQueue 是「没有投递标识、也无法证明未投递」的旧宿主状态队列输入。
	// 它们被显式保留并可见，但绝不会被自动投递，也不会按文本去猜是否已投递；只能由
	// 已经配对的 controller 显式处置（见 node_queue_recovery.go）。
	UnverifiedQueue hostPausedQueue `json:"unverified_queue,omitempty"`
	// LegacyPausedQueue 是旧 agent-loop.json 的 steer/follow 队列。它同样没有投递
	// 标识、无法证明未投递，所以保持 paused 可见，只能由已配对的 controller 显式处置，
	// 绝不自动投递。
	LegacyPausedQueue hostPausedQueue `json:"legacy_paused_queue,omitempty"`
	// QueueRevision 是 paused 队列的预览版本：只有带上当前版本的处置请求才会被接受，
	// 过期视图与重复请求都被明确拒绝。
	QueueRevision uint64 `json:"queue_revision,omitempty"`
	// QueueAudit 是处置审计（谁、什么时候、对哪一条做了什么）。它只记在这里，绝不改
	// 旧 agent-loop.json 与它的备份。
	QueueAudit []hostQueueAudit `json:"queue_audit,omitempty"`
}

type hostSession struct {
	mu   sync.Mutex
	path string
	// ioMu 串行化「取快照 → 原子落盘」的全过程（temp + fsync + rename 都在锁内），
	// 也串行化入队事务（append → save → Control 曝光）。只有 mu 时，两个并发保存
	// 各自取快照再各自写文件，先取的旧快照会覆盖后取的新快照。
	ioMu    sync.Mutex
	state   hostState
	control *agent.Control
	ui      map[string]chan uiAnswer

	// beforeWrite 只在离线 fixture 里设置：在快照之后、rename 之前调用，用来证明
	// 落盘全程持锁、以及保存失败时绝不假装成功。生产路径为 nil。
	beforeWrite func(raw []byte) error

	// loadErr 非 nil 表示宿主状态不可信（损坏或非 NotExist 的 IO 失败）：
	// 原文件原样保留，保存与回合都被拒绝，绝不用空状态覆盖它。
	loadErr error

	bashCancel context.CancelFunc
	bashID     string

	busy      bool
	seq       int
	delegates int
	runCancel context.CancelFunc
	// runID 是当前占用回合的 run 标识：abort 只按它精确匹配，未知/旧 ID 绝不取消
	// 当前另一个 run 的回合。
	runID string

	// openStore 打开原生会话 journal 目录（恢复过滤与旧历史导入用）。
	openStore func() (*agent.SessionStore, error)
	// legacyMessages 是已验证、等待导入的旧历史（只在内存里，导入后清空）。
	legacyMessages []agent.Message
}

func newHostSession(path string, openStore func() (*agent.SessionStore, error)) *hostSession {
	s := &hostSession{path: path, control: agent.NewControl(), ui: map[string]chan uiAnswer{}, openStore: openStore}
	s.load()
	return s
}

// blockedErr 返回宿主状态不可信的原因；非 nil 时调用方必须阻断保存与回合。
func (s *hostSession) blockedErr() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadErr
}

// load 读取宿主状态、把待投递队列按投递标识恢复到控制队列，并做旧历史迁移。
// 恢复不等于执行：只有一次显式回合才会投递它们。
func (s *hostSession) load() {
	raw, err := os.ReadFile(s.path)
	switch {
	case err == nil:
		var st hostState
		if jerr := json.Unmarshal(raw, &st); jerr != nil {
			// 损坏状态原样保留并阻断：不 empty 继续，也不覆盖。
			s.loadErr = fmt.Errorf("node host state is corrupt (preserved, not overwritten): %w", jerr)
			log.Printf("node host state blocked: path=%s err=%v", s.path, jerr)
			return
		}
		s.state = st
	case errors.Is(err, os.ErrNotExist):
		// 首次运行：没有状态文件是正常的。
	default:
		// 非 NotExist 的 IO 失败（权限/目录/设备错误）同样必须阻断，不能当成空状态。
		s.loadErr = fmt.Errorf("node host state unreadable (preserved): %w", err)
		log.Printf("node host state blocked: path=%s err=%v", s.path, err)
		return
	}
	if s.state.Version < hostStateVersion {
		// 版本 1 的纯文本队列没有投递标识，无法证明未投递：显式保留、绝不猜文本。
		// 它原本的类别还在（steer/follow 是两个数组），所以照实记下来，不做默认猜测。
		for _, text := range s.state.Steer {
			s.state.UnverifiedQueue = append(s.state.UnverifiedQueue,
				hostPausedEntry{Source: pausedSourceHostV1, Text: text, Kind: string(agent.DeliverySteer)})
		}
		for _, text := range s.state.Follow {
			s.state.UnverifiedQueue = append(s.state.UnverifiedQueue,
				hostPausedEntry{Source: pausedSourceHostV1, Text: text, Kind: string(agent.DeliveryFollowUp)})
		}
		if n := len(s.state.Steer) + len(s.state.Follow); n > 0 {
			log.Printf("node host state: %d id-less queued message(s) from version 1 kept paused (never auto-delivered)", n)
		}
		s.state.Steer, s.state.Follow = nil, nil
	}
	s.assignPausedIDs()
	if err := s.restorePending(); err != nil {
		// 无法证明待投递队列的真实状态（journal 缺失/读不到、条目损坏）：原样保留
		// 状态文件与内存里的 pending，Control 保持为空，并阻断保存与回合。
		// 绝不静默丢弃、绝不按文本猜、绝不用新会话顶替。
		s.loadErr = err
		s.control.Clear()
		log.Printf("node host state blocked: %v", err)
		return
	}
	for _, p := range s.state.Pending {
		if err := s.enqueueControl(p); err != nil {
			s.loadErr = fmt.Errorf("node host pending %s not queued (preserved, not delivered): %w", p.ID, err)
			s.control.Clear()
			log.Printf("node host state blocked: %v", s.loadErr)
			return
		}
	}
	s.migrateLegacy()
	s.assignPausedIDs()
	log.Printf("node host session: native=%q model=%q pending=%d unverified=%d tasks=%d",
		s.state.NativeSessionID, s.state.Model, len(s.state.Pending), len(s.state.UnverifiedQueue), len(s.state.Tasks))
}

// restorePending 在把队列放回控制队列之前，先校验条目本身，再用原生 journal 过滤
// 已经提交过的投递标识。崩溃可能发生在「journal 已提交」与「host ack 已落盘」之间，
// 这一步保证那种崩溃不会重复投递，而不是靠比对文本。
//
// 任何无法证明的情况都返回错误（调用方必须阻断），并且**原样保留** pending：
//   - 没有投递标识、重复标识、未知 kind、空文本：损坏条目显式报错，不静默 drop，
//     也不把未知 kind 默认当成 follow_up（那会把一条 steer 静默降级成不中断的跟进）；
//   - journal 读不到（缺失/忙/IO 失败）：无法证明是否已投递，保留原文并阻断。
func (s *hostSession) restorePending() error {
	s.mu.Lock()
	pending := append([]hostPending(nil), s.state.Pending...)
	sessionID := s.state.NativeSessionID
	openStore := s.openStore
	s.mu.Unlock()
	if len(pending) == 0 {
		return nil
	}
	seen := map[string]int{}
	for i, p := range pending {
		if strings.TrimSpace(p.ID) == "" {
			return fmt.Errorf("node host pending %d has no delivery id (kept, never delivered): kind=%q text=%q",
				i+1, p.Kind, clipText(p.Text, 80))
		}
		if first, dup := seen[p.ID]; dup {
			return fmt.Errorf("node host pending %d repeats delivery id %s (first at %d; kept, never delivered)",
				i+1, p.ID, first)
		}
		seen[p.ID] = i + 1
		switch agent.DeliveryKind(p.Kind) {
		case agent.DeliverySteer, agent.DeliveryFollowUp:
		default:
			return fmt.Errorf("node host pending %d has unsupported delivery kind %q (kept, never delivered): id=%s",
				i+1, p.Kind, p.ID)
		}
		if strings.TrimSpace(p.Text) == "" {
			return fmt.Errorf("node host pending %d has empty text (kept, never delivered): id=%s kind=%s",
				i+1, p.ID, p.Kind)
		}
	}
	if sessionID != "" {
		if openStore == nil {
			return fmt.Errorf("node host pending cannot be verified without a session store opener: session=%s", sessionID)
		}
		store, err := openStore()
		if err != nil {
			return fmt.Errorf("node host pending cannot be verified (journal store unavailable): session=%s err=%w", sessionID, err)
		}
		session, err := store.Load(sessionID)
		if err != nil {
			// 读不到 journal 就无法证明是否已投递：保留原文并阻断，等状态被修好。
			return fmt.Errorf("node host pending cannot be verified against its journal (kept, never delivered): session=%s err=%w", sessionID, err)
		}
		kept := make([]hostPending, 0, len(pending))
		for _, p := range pending {
			if session.HasDelivery(p.ID) {
				log.Printf("node host pending dropped (already committed in journal): id=%s kind=%s", p.ID, p.Kind)
				continue
			}
			kept = append(kept, p)
		}
		pending = kept
	}
	s.mu.Lock()
	s.state.Pending = pending
	s.mu.Unlock()
	return nil
}

// confirmPending 按指定 session 的 journal 确认待投递队列：已提交的丢弃，其余原样
// 保留。读不到 journal 时返回错误并且不改动任何状态（不按文本猜、不默认丢弃）。
func (s *hostSession) confirmPending(sessionID string) error {
	s.mu.Lock()
	pending := append([]hostPending(nil), s.state.Pending...)
	openStore := s.openStore
	s.mu.Unlock()
	if len(pending) == 0 || sessionID == "" {
		return nil
	}
	if openStore == nil {
		return fmt.Errorf("pending queue cannot be confirmed without a session store opener: session=%s", sessionID)
	}
	store, err := openStore()
	if err != nil {
		return fmt.Errorf("pending queue cannot be confirmed (journal store unavailable): session=%s err=%w", sessionID, err)
	}
	session, err := store.Load(sessionID)
	if err != nil {
		return fmt.Errorf("pending queue cannot be confirmed against journal %s: %w", sessionID, err)
	}
	kept := make([]hostPending, 0, len(pending))
	for _, p := range pending {
		if session.HasDelivery(p.ID) {
			log.Printf("node host pending dropped before session switch (committed in journal %s): id=%s kind=%s",
				sessionID, p.ID, p.Kind)
			continue
		}
		kept = append(kept, p)
	}
	if len(kept) == len(pending) {
		return nil
	}
	s.mu.Lock()
	s.state.Pending = kept
	s.mu.Unlock()
	return nil
}

// enqueueControl 把一条已校验的 pending 曝光给共享控制队列。未知 kind 是错误，
// 绝不默认走 follow_up。
func (s *hostSession) enqueueControl(p hostPending) error {
	var err error
	switch agent.DeliveryKind(p.Kind) {
	case agent.DeliverySteer:
		err = s.control.SteerWithID(p.ID, p.Text)
	case agent.DeliveryFollowUp:
		err = s.control.FollowUpWithID(p.ID, p.Text)
	default:
		return fmt.Errorf("unsupported delivery kind %q", p.Kind)
	}
	if err != nil {
		return err
	}
	return nil
}

// saveBestEffort 记录保存失败但继续：只用于迁移/回执这类非入队路径，入队路径必须
// 让错误回到调用方。
func (s *hostSession) saveBestEffort(what string) {
	if err := s.save(); err != nil {
		log.Printf("node host state save failed: what=%s err=%v", what, err)
	}
}

// save 取快照并原子落盘（同目录 temp + fsync + rename）。快照到 rename 的整个过程
// 都在 ioMu 之内：并发保存不会让先取的旧快照覆盖后取的新快照。错误可观察，调用方
// 必须处理，不能假设保存成功。
func (s *hostSession) save() error {
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	return s.writeState()
}

// writeState 是 save 的锁内实现：调用方必须已经持有 ioMu。
func (s *hostSession) writeState() error {
	s.mu.Lock()
	if s.loadErr != nil {
		err := s.loadErr
		s.mu.Unlock()
		return err
	}
	s.state.Version = hostStateVersion
	raw, err := json.MarshalIndent(s.state, "", "  ")
	path, hook := s.path, s.beforeWrite
	s.mu.Unlock()
	if err != nil {
		log.Printf("node host state marshal failed: err=%v", err)
		return err
	}
	if hook != nil {
		if err := hook(raw); err != nil {
			log.Printf("node host state write refused: path=%s err=%v", path, err)
			return err
		}
	}
	if err := atomicWriteFile(path, raw); err != nil {
		log.Printf("node host state save failed: path=%s err=%v", path, err)
		return err
	}
	return nil
}

// atomicWriteFile 写同目录临时文件、fsync 后 rename 覆盖，避免半截状态。
func atomicWriteFile(path string, raw []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+"-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	done := false
	defer func() {
		if !done {
			_ = os.Remove(name)
		}
	}()
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, path); err != nil {
		return err
	}
	done = true
	return nil
}

// ---- 任务板 ----

func (s *hostSession) tasks() []hostTask {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]hostTask(nil), s.state.Tasks...)
}

func (s *hostSession) upsertTask(t hostTask, emit func(agentEvent)) {
	s.mu.Lock()
	found := false
	for i := range s.state.Tasks {
		if s.state.Tasks[i].ID == t.ID {
			s.state.Tasks[i] = t
			found = true
			break
		}
	}
	if !found {
		s.state.Tasks = append(s.state.Tasks, t)
	}
	if len(s.state.Tasks) > maxBoardTasks {
		s.state.Tasks = pruneBoard(s.state.Tasks, maxBoardTasks)
	}
	s.mu.Unlock()
	if emit != nil {
		emit(boardEvent(t))
	}
}

func (s *hostSession) finishTurn(id, status, detail string) hostTask {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.state.Tasks {
		if s.state.Tasks[i].ID == id {
			s.state.Tasks[i].Status = status
			s.state.Tasks[i].Detail = detail
			return s.state.Tasks[i]
		}
	}
	return hostTask{ID: id, Status: status, Kind: "turn", Detail: detail}
}

func pruneBoard(tasks []hostTask, keep int) []hostTask {
	if len(tasks) <= keep {
		return tasks
	}
	drop := len(tasks) - keep
	out := make([]hostTask, 0, keep)
	for _, t := range tasks {
		if drop > 0 && (t.Status == "done" || t.Status == "failed" || t.Status == "canceled") {
			drop--
			continue
		}
		out = append(out, t)
	}
	if len(out) > keep {
		out = out[len(out)-keep:]
	}
	return out
}

func (s *hostSession) nextID(prefix string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seq++
	return fmt.Sprintf("%s-%d", prefix, s.seq)
}

// ---- 回合生命周期 ----

func (s *hostSession) busyNow() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.busy
}

// reserveTurn 原子占用本机唯一的回合，并在同一个锁下登记取消与本回合的 run ID。
// 这样「占位成功但取消还没登记」的窗口不存在：匹配本 run 的 abort 在任何时刻都有效，
// 而不匹配的 abort（未知/旧 ID）在同一个锁下就被拒绝。
func (s *hostSession) reserveTurn(runID string) (context.Context, context.CancelFunc, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.busy {
		return nil, nil, false
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.busy = true
	s.delegates = 0
	s.runCancel = cancel
	s.runID = strings.TrimSpace(runID)
	return ctx, cancel, true
}

// releaseTurn 释放占用。成功、失败、拒绝、取消与重复 run id 都必须走到它。
func (s *hostSession) releaseTurn() {
	s.mu.Lock()
	if s.runCancel != nil {
		s.runCancel()
		s.runCancel = nil
	}
	s.busy = false
	s.delegates = 0
	s.runID = ""
	s.mu.Unlock()
}

func (s *hostSession) beginTurn(title string) string {
	id := s.nextID("turn")
	s.upsertTask(hostTask{ID: id, Title: clipText(title, 80), Status: "running", Kind: "turn"}, nil)
	return id
}

// abortRun 取消指定 run 占用的回合（含仍在等访问码的回合）。它只取消上下文，不伪造
// 终态；并且只在 ID 与当前占用的 run 完全一致时生效——未知 ID、已经结束的旧 ID、
// 以及没有 ID 的帧都绝不取消当前另一个 run 的回合。返回值表示是否真的取消了。
func (s *hostSession) abortRun(id string) bool {
	id = strings.TrimSpace(id)
	if id == "" {
		return false
	}
	s.mu.Lock()
	if s.runCancel == nil || s.runID != id {
		s.mu.Unlock()
		return false
	}
	cancel := s.runCancel
	s.mu.Unlock()
	log.Printf("node host session abort: run=%s", id)
	cancel()
	return true
}

// ---- 控制队列（steer / follow / interrupt）----

func newDeliveryID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		// 熵不可用时不生成可猜的 ID，让调用方看到错误。
		return ""
	}
	return "d-" + hex.EncodeToString(buf)
}

// enqueuePending 是一次串行事务：append → 落盘 → 才曝光给共享 Control。整个过程
// 持有 ioMu，所以并发的另一次保存不会替一次失败的入队落盘；保存失败会回滚内存并
// 返回错误（绝不假装排队成功）。
func (s *hostSession) enqueuePending(kind agent.DeliveryKind, text string) error {
	text = strings.TrimSpace(text)
	if text == "" {
		return agent.ErrEmptyControlMessage
	}
	if kind != agent.DeliverySteer && kind != agent.DeliveryFollowUp {
		return fmt.Errorf("unsupported delivery kind %q", kind)
	}
	id := newDeliveryID()
	if id == "" {
		return errors.New("delivery id entropy unavailable")
	}
	entry := hostPending{ID: id, Kind: string(kind), Text: text}
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	s.mu.Lock()
	s.state.Pending = append(s.state.Pending, entry)
	s.mu.Unlock()
	if err := s.writeState(); err != nil {
		// 没落盘就等于没排队：回滚内存，Control 也绝不曝光这一条。
		s.dropPending(id)
		return fmt.Errorf("queue not persisted: %w", err)
	}
	if err := s.enqueueControl(entry); err != nil {
		s.dropPending(id)
		if werr := s.writeState(); werr != nil {
			// 回滚写不回去，内存与磁盘已经不一致：阻断，绝不让一条已经报失败的
			// 消息在下次装载时被投递。
			s.mu.Lock()
			s.loadErr = fmt.Errorf("queue rollback not persisted (state preserved): %w", werr)
			s.mu.Unlock()
		}
		return fmt.Errorf("queue not handed to the engine: %w", err)
	}
	log.Printf("node host pending queued: id=%s kind=%s", id, kind)
	return nil
}

func (s *hostSession) dropPending(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := make([]hostPending, 0, len(s.state.Pending))
	for _, p := range s.state.Pending {
		if p.ID == id {
			continue
		}
		kept = append(kept, p)
	}
	s.state.Pending = kept
}

func (s *hostSession) steer(text string) error {
	return s.enqueuePending(agent.DeliverySteer, text)
}

func (s *hostSession) followUp(text string) error {
	return s.enqueuePending(agent.DeliveryFollowUp, text)
}

// ackDelivery 只按共享核心回执里的投递标识确认，绝不按文本、顺序或回合位置。
func (s *hostSession) ackDelivery(receipt *agent.DeliveryReceipt) {
	if receipt == nil || receipt.ID == "" {
		return
	}
	s.mu.Lock()
	kept := make([]hostPending, 0, len(s.state.Pending))
	acked := false
	for _, p := range s.state.Pending {
		if p.ID == receipt.ID {
			acked = true
			continue
		}
		kept = append(kept, p)
	}
	s.state.Pending = kept
	s.mu.Unlock()
	if acked {
		log.Printf("node host pending acked: id=%s kind=%s", receipt.ID, receipt.Kind)
	}
}

func (s *hostSession) pendingQueued() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.state.Pending)
}

func (s *hostSession) setInterruptMode(mode string) error {
	mode = strings.TrimSpace(mode)
	if err := s.control.SetInterruptMode(agent.InterruptMode(mode)); err != nil {
		log.Printf("node host session mode rejected: mode=%q err=%v", mode, err)
		return err
	}
	log.Printf("node host session interrupt mode: %s", mode)
	return nil
}

// ---- 会话绑定 ----

// sessionProtocolHint 返回续接同一模型的已有会话时要沿用的协议：已有会话记录过的协议，
// 或者旧会话（本变更之前只有 chat 接线）未记录协议时的 chat。没有可续接的会话时返回
// 空，让 Hub 目录决定协议——绝不把新会话隐式绑到 chat。
func (s *hostSession) sessionProtocolHint(model string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.NativeSessionID == "" || strings.TrimSpace(s.state.Model) != strings.TrimSpace(model) {
		return ""
	}
	if p := strings.TrimSpace(s.state.Protocol); p != "" {
		return p
	}
	return providers.OpenAICompletions
}

// currentIdentity 返回宿主会话已建立的身份（model + 协议），没有则返回 false。
// 旧状态没有 Protocol 时按 chat 计（与 sessionProtocolHint 同口径）。
func (s *hostSession) currentIdentity() (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	model := strings.TrimSpace(s.state.Model)
	if model == "" {
		return "", false
	}
	p := strings.TrimSpace(s.state.Protocol)
	if p == "" {
		p = providers.OpenAICompletions
	}
	return model + " (" + p + ")", true
}

// bindingID 返回持久化的可信绑定引用（空表示本会话没有智能绑定）。
func (s *hostSession) bindingID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return strings.TrimSpace(s.state.Binding)
}

// smartSessionBinding commits the concrete identity and the trusted reference in
// one host-state transaction. Smart continuation never switches or imports an
// existing unbound history; only the legacy explicit path may do that.
func (s *hostSession) smartSessionBinding(model, protocol, binding, decision string) (string, error) {
	if model == "" || protocol == "" || binding == "" || decision == "" {
		return "", fmt.Errorf("smart session requires a complete binding")
	}
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	s.mu.Lock()
	oldModel, oldProtocol := s.state.Model, s.state.Protocol
	oldBinding, oldDecision := s.state.Binding, s.state.Decision
	id := s.state.NativeSessionID
	if len(s.legacyMessages) > 0 || (s.state.Legacy != nil && s.state.Legacy.Pending) {
		s.mu.Unlock()
		return "", fmt.Errorf("smart mode cannot adopt pending legacy history; resume it explicitly first")
	}
	if oldModel != "" || oldProtocol != "" || oldBinding != "" || oldDecision != "" || id != "" {
		if oldModel != model || oldProtocol != protocol || oldBinding != binding || oldDecision != decision {
			s.mu.Unlock()
			return "", fmt.Errorf("smart session identity or binding mismatch; existing history is preserved")
		}
		s.mu.Unlock()
		return id, nil
	}
	s.state.Model, s.state.Protocol = model, protocol
	s.state.Binding, s.state.Decision = binding, decision
	s.mu.Unlock()
	if err := s.writeState(); err != nil {
		s.mu.Lock()
		s.state.Model, s.state.Protocol = oldModel, oldProtocol
		s.state.Binding, s.state.Decision = oldBinding, oldDecision
		s.mu.Unlock()
		return "", fmt.Errorf("smart session binding not persisted: %w", err)
	}
	return id, nil
}

// sessionBinding 返回要续接的原生会话 ID。宿主会话身份是 (model, protocol) 的组合：
// 模型或协议任一显式变化都开一个新会话（旧 journal 原样留在磁盘上，并记录到
// PrevSessionID），不把历史静默接到另一个模型/协议上，也不跨协议重新解释 opaque 历史。
//
// 旧宿主状态没有记录 protocol：它对应的会话是本变更之前的 chat 会话，因此按 chat 续接
// （与 sessionProtocolHint 同口径），并在续接时把该协议补记下来。
//
// 换绑之前先按**旧 session 的 journal** 确认待投递队列（已提交的丢弃，其余保留），
// 然后把换绑结果原子落盘：内存快照与状态文件始终一致。任何一步失败都回滚内存并
// 返回错误，让回合可见地失败，而不是留下一份没落盘的换绑。
func (s *hostSession) sessionBinding(model, protocol string) (id, switchedFrom string, err error) {
	model = strings.TrimSpace(model)
	protocol = strings.TrimSpace(protocol)
	if protocol == "" {
		return "", "", fmt.Errorf("session binding requires an explicit protocol")
	}
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	s.mu.Lock()
	current, currentModel, currentProtocol, prevSession := s.state.NativeSessionID, s.state.Model, s.state.Protocol, s.state.PrevSessionID
	s.mu.Unlock()
	if current != "" {
		effective := strings.TrimSpace(currentProtocol)
		if effective == "" {
			// 旧会话：本变更之前只有 chat 接线。
			effective = providers.OpenAICompletions
		}
		unknownModel := strings.TrimSpace(currentModel) == ""
		switch {
		case (!unknownModel && strings.TrimSpace(currentModel) != model) || effective != protocol:
			// 模型或协议变化（含「旧状态没有记录 model 但协议不同」）都开新会话：前者换了
			// 模型，后者无从证明是同一模型，跨协议复用 opaque 历史都不允许。
			if cerr := s.confirmPending(current); cerr != nil {
				return "", "", fmt.Errorf("session switch to %s/%s blocked: %w", model, protocol, cerr)
			}
			s.mu.Lock()
			s.state.PrevSessionID = current
			s.state.NativeSessionID = ""
			s.state.Model = model
			s.state.Protocol = protocol
			s.mu.Unlock()
			if werr := s.writeState(); werr != nil {
				s.mu.Lock()
				s.state.PrevSessionID = prevSession
				s.state.NativeSessionID = current
				s.state.Model = currentModel
				s.state.Protocol = currentProtocol
				s.mu.Unlock()
				return "", "", fmt.Errorf("session switch to %s/%s not persisted: %w", model, protocol, werr)
			}
			log.Printf("node host session switch: from=%s model=%s protocol=%s (pending confirmed against the old journal)",
				current, model, protocol)
			return "", current, nil
		default:
			// 同一模型同一协议：续接。旧状态没有记录 model 或 protocol 时把它们补记下来
			// （旧会话只有 chat），保证内存与状态文件一致。
			if unknownModel || strings.TrimSpace(currentProtocol) != protocol {
				if err := s.recordBinding(model, protocol); err != nil {
					return "", "", err
				}
			}
			return current, "", nil
		}
	}
	// 还没有可续接的会话：把本次 (model, protocol) 落盘，保证「内存里的绑定」与
	// 「状态文件里的绑定」始终一致。
	if err := s.recordBinding(model, protocol); err != nil {
		return "", "", err
	}
	return "", "", nil
}

// recordBinding 在锁内记录 (model, protocol)，保存失败就回滚内存。调用方必须持有 ioMu。
func (s *hostSession) recordBinding(model, protocol string) error {
	s.mu.Lock()
	prevModel, prevProtocol := s.state.Model, s.state.Protocol
	s.state.Model = model
	s.state.Protocol = protocol
	s.mu.Unlock()
	if werr := s.writeState(); werr != nil {
		s.mu.Lock()
		s.state.Model = prevModel
		s.state.Protocol = prevProtocol
		s.mu.Unlock()
		return fmt.Errorf("model binding %s/%s not persisted: %w", model, protocol, werr)
	}
	return nil
}

// setNativeID 记录并**立即原子保存**新会话的绑定，避免回合结束前崩溃后找不到 journal。
// 保存失败时回滚内存里的绑定：绝不留一份没落盘的 binding 让下一次 Run 绕过预保存。
// journal 本身保留在磁盘上（不删），失败对调用方可见。
func (s *hostSession) setNativeID(id string) error {
	if id == "" {
		return nil
	}
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	s.mu.Lock()
	prev := s.state.NativeSessionID
	if prev == id {
		// 绑定没变（同一会话续接）：不需要重复落盘。
		s.mu.Unlock()
		return nil
	}
	s.state.NativeSessionID = id
	s.mu.Unlock()
	if err := s.writeState(); err != nil {
		s.mu.Lock()
		if s.state.NativeSessionID == id {
			s.state.NativeSessionID = prev
		}
		s.mu.Unlock()
		return fmt.Errorf("session binding %s not persisted: %w", id, err)
	}
	return nil
}

func (s *hostSession) compactionPolicy() *agent.CompactionPolicy {
	s.mu.Lock()
	on := true
	if s.state.AutoCompact != nil {
		on = *s.state.AutoCompact
	}
	s.mu.Unlock()
	if !on {
		return nil
	}
	return &agent.CompactionPolicy{ThresholdTokens: hostCompactThresholdTokens, MaxSummaryTokens: hostCompactSummaryTokens}
}

// ---- ask_user：等待宿主 UI 回帧，不取消回合 ----

func (s *hostSession) ask(ctx context.Context, id, prompt string, emit func(agentEvent)) (string, bool, error) {
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return "", false, fmt.Errorf("prompt required")
	}
	if id == "" {
		id = s.nextID("ui")
	}
	ch := make(chan uiAnswer, 1)
	s.mu.Lock()
	if s.ui == nil {
		s.ui = map[string]chan uiAnswer{}
	}
	s.ui[id] = ch
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.ui, id)
		s.mu.Unlock()
	}()
	if emit != nil {
		e := hostEventBase("ui_request", "", "")
		e.StepID = id
		e.Output = prompt
		emit(e)
	}
	log.Printf("node ui request: id=%s", id)
	timer := time.NewTimer(uiWait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return "", false, ctx.Err()
	case <-timer.C:
		return "", false, fmt.Errorf("ui request timeout")
	case ans := <-ch:
		log.Printf("node ui resolved: id=%s ok=%t", id, ans.ok)
		return ans.text, ans.ok, nil
	}
}

func (s *hostSession) resolveUI(id, answer string, ok bool) bool {
	if id == "" {
		return false
	}
	s.mu.Lock()
	ch := s.ui[id]
	s.mu.Unlock()
	if ch == nil {
		return false
	}
	select {
	case ch <- uiAnswer{text: answer, ok: ok}:
		return true
	default:
		return false
	}
}

// ---- 旁路命令：独立于回合，可单独取消 ----

func (s *hostSession) beginBash(id string, cancel context.CancelFunc) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.bashCancel != nil {
		return fmt.Errorf("bash already running")
	}
	s.bashCancel, s.bashID = cancel, id
	return nil
}

func (s *hostSession) endBash(id string) {
	s.mu.Lock()
	if s.bashID == id {
		s.bashCancel, s.bashID = nil, ""
	}
	s.mu.Unlock()
}

func (s *hostSession) abortBash() bool {
	s.mu.Lock()
	cancel := s.bashCancel
	s.mu.Unlock()
	if cancel == nil {
		return false
	}
	log.Printf("node host session bash abort")
	cancel()
	return true
}

// ---- delegate 限额：每回合最多 hostDelegateLimit 个，回合开始时清零 ----

func (s *hostSession) reserveDelegate() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.delegates >= hostDelegateLimit {
		return false
	}
	s.delegates++
	return true
}

// ---- 会话内置工具：todo_write / ask_user ----
//
// 这些是宿主业务（任务板、UI 确认），不是模型循环的一部分：它们只提供工具，
// 循环、重试与 journal 仍由共享核心负责。

func (s *hostSession) todoTool(emit func(agentEvent)) agent.Tool {
	return hostTool{
		spec: toolSpec("todo_write",
			"Replace the task board. Each item needs id, title, and status pending|running|done|failed|canceled.",
			map[string]any{"items": map[string]any{"type": "array"}}, []string{"items"}, false),
		run: func(ctx context.Context, args map[string]any) (string, error) {
			raw, _ := args["items"].([]any)
			if len(raw) == 0 {
				return "", fmt.Errorf("items required")
			}
			for _, item := range raw {
				m, _ := item.(map[string]any)
				id, _ := m["id"].(string)
				title, _ := m["title"].(string)
				status, _ := m["status"].(string)
				if id == "" || title == "" {
					continue
				}
				if status == "" {
					status = "pending"
				}
				s.upsertTask(hostTask{ID: id, Title: title, Status: status, Kind: "todo"}, emit)
			}
			return fmt.Sprintf("%d tasks", len(s.tasks())), nil
		},
	}
}

func (s *hostSession) askTool(emit func(agentEvent)) agent.Tool {
	return hostTool{
		spec: toolSpec("ask_user",
			"Ask the user a yes/no or short question and wait for the UI answer before continuing.",
			map[string]any{"prompt": map[string]any{"type": "string"}}, []string{"prompt"}, false),
		run: func(ctx context.Context, args map[string]any) (string, error) {
			prompt, _ := args["prompt"].(string)
			answer, ok, err := s.ask(ctx, "", prompt, emit)
			if err != nil {
				return "", err
			}
			if !ok {
				return "User rejected: " + answer, nil
			}
			if answer == "" {
				answer = "yes"
			}
			return answer, nil
		},
	}
}
