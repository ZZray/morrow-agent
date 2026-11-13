package main

// 旧 ID-less paused 队列（agent-loop.json 的 steer/follow 与版本 1 宿主状态的纯文本
// 队列）的查看与显式处置。
//
// 这些条目没有投递标识，无法证明是否已经投递，所以宿主绝不自动重放、也绝不按文本猜。
// 它们必须可查看，并且只能由已经配对的 controller 显式处置：
//   - list    只读：返回稳定条目 ID、来源、原文、原 kind 是否已知，以及阻断/忙状态；
//   - requeue 把一条 paused 变成带投递标识的 Pending，并与处置审计、paused 队列的移除
//             在**同一个宿主状态事务**里落盘，成功之后才曝光给共享 Control；
//   - discard 明确放弃这一条（同样先落盘审计），旧文件与其备份一个字节都不改。
//
// 变更只在当前回合 idle、宿主状态可信（没有 loadErr/未知 journal）时允许，并且必须带上
// 调用方看到的预览版本（revision）与条目 ID：过期视图、重复请求、未知条目都会被明确
// 拒绝，绝不按文本去重、也绝不对未知的原 kind 默认猜测。

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"ara/internal/agent"
)

const (
	// pausedSourceLegacy 是旧 agent-loop.json 的 steer/follow 队列来源标签。
	pausedSourceLegacy = legacyStateFile
	// pausedSourceHostV1 是版本 1 宿主状态（node-agent-state.json）纯文本队列的来源标签。
	pausedSourceHostV1 = hostStateFile + "#v1"
	// maxQueueAudit 限制落盘的处置审计条数，避免状态文件无限增长。
	maxQueueAudit = 200
	// queueAuditTail 是每次回给 controller 的审计条数。
	queueAuditTail = 20
	// queueAuditTextLimit 是审计里保留的原文长度（原文仍在旧文件里，不改）。
	queueAuditTextLimit = 200
)

// hostPausedEntry 是一条 paused 旧队列条目：稳定 ID + 来源 + 原文 + 原 kind。
type hostPausedEntry struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Text   string `json:"text"`
	// Kind 是这一条原本的类别（steer/follow_up）。空串表示来源已经丢了类别（本切片之前
	// 落盘的纯文本数组）：绝不当成 follow_up 猜，必须由操作者显式选择。
	Kind string `json:"kind,omitempty"`
}

// hostPausedQueue 兼容两种落盘形态：新形态是带 ID/来源的条目数组，旧形态（本切片之前
// 写入的 legacy_paused_queue/unverified_queue）是纯文本数组——那种形态已经丢了类别，
// 所以按「原 kind 未知」装载，只能由操作者显式处置。
type hostPausedQueue []hostPausedEntry

func (q *hostPausedQueue) UnmarshalJSON(raw []byte) error {
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return err
	}
	out := make(hostPausedQueue, 0, len(items))
	for _, item := range items {
		var text string
		if err := json.Unmarshal(item, &text); err == nil {
			out = append(out, hostPausedEntry{Text: text})
			continue
		}
		var e hostPausedEntry
		if err := json.Unmarshal(item, &e); err != nil {
			return err
		}
		out = append(out, e)
	}
	*q = out
	return nil
}

// hostQueueAudit 是一条处置审计：谁、什么时候、对哪一条、做了什么。它只记在宿主状态
// 文件里，绝不动旧文件与备份。
type hostQueueAudit struct {
	At         string `json:"at"`
	Action     string `json:"action"` // requeue | discard
	Entry      string `json:"entry"`
	Source     string `json:"source"`
	Kind       string `json:"kind,omitempty"`          // 本次显式选择的类别
	Original   string `json:"original_kind,omitempty"` // 条目原本的类别（空=来源未知）
	Delivery   string `json:"delivery_id,omitempty"`   // requeue 生成的投递标识
	Text       string `json:"text,omitempty"`
	Controller string `json:"controller,omitempty"`
	Revision   uint64 `json:"revision"`
}

// hostQueueEntryView 是回给 controller 的条目视图。
type hostQueueEntryView struct {
	ID        string `json:"id"`
	Source    string `json:"source"`
	Text      string `json:"text"`
	Kind      string `json:"kind,omitempty"`
	KindKnown bool   `json:"kind_known"`
}

// hostQueueResponse 是 agent-queue-recovery 三种 action 共用的响应体。
type hostQueueResponse struct {
	Action   string               `json:"action"`
	Entry    string               `json:"entry,omitempty"`
	Kind     string               `json:"kind,omitempty"`
	Delivery string               `json:"delivery,omitempty"`
	Revision uint64               `json:"revision"`
	Busy     bool                 `json:"busy"`
	Blocked  string               `json:"blocked,omitempty"`
	Entries  []hostQueueEntryView `json:"entries"`
	Audit    []hostQueueAudit     `json:"audit,omitempty"`
}

// pausedEntryID 由「来源 + 该来源里的位置 + 原文」决定：同一份旧文件每次装载都得到同一个
// ID，文本相同的两条也彼此不同；一旦落盘就不再重算（条目只会被显式处置掉，不会重排）。
func pausedEntryID(source string, index int, text string) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%s", source, index, text)))
	return "pq-" + hex.EncodeToString(sum[:6])
}

// assignPausedIDs 给还没有 ID 的 paused 条目补上稳定 ID（装载时调用，幂等）。
func (s *hostSession) assignPausedIDs() {
	s.mu.Lock()
	defer s.mu.Unlock()
	assign := func(q hostPausedQueue, source string) {
		for i := range q {
			if strings.TrimSpace(q[i].Source) == "" {
				// 旧落盘形态只有纯文本，但字段本身说明了它来自哪个文件。
				q[i].Source = source
			}
			if strings.TrimSpace(q[i].ID) != "" {
				continue
			}
			q[i].ID = pausedEntryID(q[i].Source, i, q[i].Text)
		}
	}
	assign(s.state.LegacyPausedQueue, pausedSourceLegacy)
	assign(s.state.UnverifiedQueue, pausedSourceHostV1)
}

// pausedQueuePreview 只读地返回当前 paused 预览。list 在宿主状态被阻断时也必须可读：
// 阻断原因放在 Blocked 里，变更操作才被拒绝。
func (s *hostSession) pausedQueuePreview() hostQueueResponse {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pausedPreviewLocked("list")
}

func (s *hostSession) pausedPreviewLocked(action string) hostQueueResponse {
	resp := hostQueueResponse{
		Action:   action,
		Revision: s.state.QueueRevision,
		Busy:     s.busy,
		Entries:  []hostQueueEntryView{},
	}
	if s.loadErr != nil {
		resp.Blocked = s.loadErr.Error()
	}
	for _, e := range s.state.LegacyPausedQueue {
		resp.Entries = append(resp.Entries, pausedEntryView(e))
	}
	for _, e := range s.state.UnverifiedQueue {
		resp.Entries = append(resp.Entries, pausedEntryView(e))
	}
	if n := len(s.state.QueueAudit); n > 0 {
		from := 0
		if n > queueAuditTail {
			from = n - queueAuditTail
		}
		resp.Audit = append([]hostQueueAudit(nil), s.state.QueueAudit[from:]...)
	}
	return resp
}

func pausedEntryView(e hostPausedEntry) hostQueueEntryView {
	return hostQueueEntryView{
		ID:        e.ID,
		Source:    e.Source,
		Text:      e.Text,
		Kind:      e.Kind,
		KindKnown: strings.TrimSpace(e.Kind) != "",
	}
}

// pausedChangeAllowedLocked 判断现在能不能变更 paused 队列：宿主状态必须可信（没有
// loadErr/未知 journal）、当前没有回合在跑，并且调用方看到的预览版本必须是当前版本。
func (s *hostSession) pausedChangeAllowedLocked(action string, revision uint64) error {
	if s.loadErr != nil {
		return fmt.Errorf("host state is blocked (%v); %s refused", s.loadErr, action)
	}
	if s.busy {
		return fmt.Errorf("a local turn is running; %s needs an idle session", action)
	}
	if revision != s.state.QueueRevision {
		return fmt.Errorf("stale preview: revision %d is no longer current (%d); refresh and retry", revision, s.state.QueueRevision)
	}
	return nil
}

// findPausedLocked 按 ID 在两个 paused 队列里找条目。ID 是唯一匹配键，绝不按文本找。
func (s *hostSession) findPausedLocked(id string) (hostPausedEntry, bool) {
	for _, q := range []hostPausedQueue{s.state.LegacyPausedQueue, s.state.UnverifiedQueue} {
		for _, e := range q {
			if e.ID == id {
				return e, true
			}
		}
	}
	return hostPausedEntry{}, false
}

func (s *hostSession) removePausedLocked(id string) {
	drop := func(q hostPausedQueue) hostPausedQueue {
		kept := make(hostPausedQueue, 0, len(q))
		for _, e := range q {
			if e.ID == id {
				continue
			}
			kept = append(kept, e)
		}
		return kept
	}
	s.state.LegacyPausedQueue = drop(s.state.LegacyPausedQueue)
	s.state.UnverifiedQueue = drop(s.state.UnverifiedQueue)
}

// hostQueueSnapshot 是一次处置事务的回滚快照（都在同一把锁下取/还原）。
type hostQueueSnapshot struct {
	pending    []hostPending
	audit      []hostQueueAudit
	legacy     hostPausedQueue
	unverified hostPausedQueue
	revision   uint64
}

func (s *hostSession) queueSnapshotLocked() hostQueueSnapshot {
	return hostQueueSnapshot{
		pending:    append([]hostPending(nil), s.state.Pending...),
		audit:      append([]hostQueueAudit(nil), s.state.QueueAudit...),
		legacy:     append(hostPausedQueue(nil), s.state.LegacyPausedQueue...),
		unverified: append(hostPausedQueue(nil), s.state.UnverifiedQueue...),
		revision:   s.state.QueueRevision,
	}
}

func (s *hostSession) restoreQueueSnapshot(snap hostQueueSnapshot) {
	s.mu.Lock()
	s.state.Pending = snap.pending
	s.state.QueueAudit = snap.audit
	s.state.LegacyPausedQueue = snap.legacy
	s.state.UnverifiedQueue = snap.unverified
	s.state.QueueRevision = snap.revision
	s.mu.Unlock()
}

// resolvePausedKind 决定这一条要按哪种类别投递：操作者显式给出的类别优先；没给时只有
// 来源仍然记着原类别才能沿用，来源丢了类别就必须显式选择（绝不默认猜 follow_up）。
func resolvePausedKind(entry hostPausedEntry, requested string) (agent.DeliveryKind, error) {
	kind := strings.TrimSpace(requested)
	if kind == "" {
		kind = strings.TrimSpace(entry.Kind)
		if kind == "" {
			return "", fmt.Errorf("entry %s has no original kind; choose steer or follow_up explicitly", entry.ID)
		}
	}
	switch agent.DeliveryKind(kind) {
	case agent.DeliverySteer, agent.DeliveryFollowUp:
		return agent.DeliveryKind(kind), nil
	}
	return "", fmt.Errorf("unsupported delivery kind %q (want steer or follow_up)", requested)
}

func appendQueueAudit(list []hostQueueAudit, rec hostQueueAudit) []hostQueueAudit {
	rec.Text = clipText(rec.Text, queueAuditTextLimit)
	list = append(list, rec)
	if len(list) > maxQueueAudit {
		list = list[len(list)-maxQueueAudit:]
	}
	return list
}

func queueAuditNow() string { return time.Now().UTC().Format(time.RFC3339) }

// requeuePaused 把一条 paused 显式改成带投递标识的 Pending：Pending、处置审计、paused
// 队列的移除与版本号在**同一个**宿主状态事务里落盘，成功之后才曝光给共享 Control。
// 任何一步失败都回滚内存，绝不假装处置成功、也绝不半条入队。
func (s *hostSession) requeuePaused(id, kind, controller string, revision uint64) (hostQueueResponse, error) {
	s.ioMu.Lock()
	defer s.ioMu.Unlock()

	s.mu.Lock()
	if err := s.pausedChangeAllowedLocked("requeue", revision); err != nil {
		s.mu.Unlock()
		return hostQueueResponse{}, err
	}
	entry, ok := s.findPausedLocked(id)
	if !ok {
		s.mu.Unlock()
		return hostQueueResponse{}, fmt.Errorf("entry %s is not in the current preview", id)
	}
	resolved, err := resolvePausedKind(entry, kind)
	if err != nil {
		s.mu.Unlock()
		return hostQueueResponse{}, err
	}
	delivery := newDeliveryID()
	if delivery == "" {
		s.mu.Unlock()
		return hostQueueResponse{}, errors.New("delivery id entropy unavailable")
	}
	pending := hostPending{ID: delivery, Kind: string(resolved), Text: entry.Text}
	snap := s.queueSnapshotLocked()
	s.state.Pending = append(s.state.Pending, pending)
	s.state.QueueAudit = appendQueueAudit(s.state.QueueAudit, hostQueueAudit{
		At: queueAuditNow(), Action: "requeue", Entry: entry.ID, Source: entry.Source,
		Kind: string(resolved), Original: entry.Kind, Delivery: delivery,
		Text: entry.Text, Controller: controller, Revision: snap.revision + 1,
	})
	s.removePausedLocked(id)
	s.state.QueueRevision++
	s.mu.Unlock()

	if err := s.writeState(); err != nil {
		// 没落盘就等于没处置：整份内存快照回滚，Control 也绝不曝光这一条。
		s.restoreQueueSnapshot(snap)
		log.Printf("paused queue requeue not persisted: entry=%s err=%v", id, err)
		return hostQueueResponse{}, fmt.Errorf("queue recovery not persisted: %w", err)
	}
	if err := s.enqueueControl(pending); err != nil {
		s.restoreQueueSnapshot(snap)
		if werr := s.writeState(); werr != nil {
			// 回滚写不回去，内存与磁盘已经不一致：阻断，绝不让一条已经报失败的处置
			// 在下次装载时被投递。
			s.mu.Lock()
			s.loadErr = fmt.Errorf("queue recovery rollback not persisted (state preserved): %w", werr)
			s.mu.Unlock()
		}
		log.Printf("paused queue requeue not handed to the engine: entry=%s err=%v", id, err)
		return hostQueueResponse{}, fmt.Errorf("queue recovery not handed to the engine: %w", err)
	}
	log.Printf("paused queue requeued: entry=%s kind=%s delivery=%s revision=%d controller=%s",
		id, resolved, delivery, snap.revision+1, controller)

	resp := s.pausedQueuePreview()
	resp.Action, resp.Entry, resp.Kind, resp.Delivery = "requeue", id, string(resolved), delivery
	return resp, nil
}

// discardPaused 明确放弃一条 paused：移除与审计在同一个宿主状态事务里落盘，绝不投递、
// 也绝不动旧文件与备份。
func (s *hostSession) discardPaused(id, controller string, revision uint64) (hostQueueResponse, error) {
	s.ioMu.Lock()
	defer s.ioMu.Unlock()

	s.mu.Lock()
	if err := s.pausedChangeAllowedLocked("discard", revision); err != nil {
		s.mu.Unlock()
		return hostQueueResponse{}, err
	}
	entry, ok := s.findPausedLocked(id)
	if !ok {
		s.mu.Unlock()
		return hostQueueResponse{}, fmt.Errorf("entry %s is not in the current preview", id)
	}
	snap := s.queueSnapshotLocked()
	s.state.QueueAudit = appendQueueAudit(s.state.QueueAudit, hostQueueAudit{
		At: queueAuditNow(), Action: "discard", Entry: entry.ID, Source: entry.Source,
		Original: entry.Kind, Text: entry.Text, Controller: controller, Revision: snap.revision + 1,
	})
	s.removePausedLocked(id)
	s.state.QueueRevision++
	s.mu.Unlock()

	if err := s.writeState(); err != nil {
		s.restoreQueueSnapshot(snap)
		log.Printf("paused queue discard not persisted: entry=%s err=%v", id, err)
		return hostQueueResponse{}, fmt.Errorf("queue recovery not persisted: %w", err)
	}
	log.Printf("paused queue discarded: entry=%s revision=%d controller=%s", id, snap.revision+1, controller)

	resp := s.pausedQueuePreview()
	resp.Action, resp.Entry = "discard", id
	return resp, nil
}

// handleQueueRecovery 处理 agent-queue-recovery 帧（list/requeue/discard）。
func (a *nodeAgent) handleQueueRecovery(cn *conn, f *dcf) {
	action := strings.ToLower(strings.TrimSpace(f.Msg))
	sess := a.hostSession()
	switch action {
	case "list":
		a.outQueueRecovery(cn, f.ID, sess.pausedQueuePreview(), nil)
	case "requeue", "discard":
		id := strings.TrimSpace(f.Entry)
		if id == "" {
			a.outQueueRecovery(cn, f.ID, hostQueueResponse{}, errors.New("entry id required"))
			return
		}
		var (
			resp hostQueueResponse
			err  error
		)
		if action == "requeue" {
			resp, err = sess.requeuePaused(id, f.Kind, a.curFP, f.Rev)
		} else {
			resp, err = sess.discardPaused(id, a.curFP, f.Rev)
		}
		a.outQueueRecovery(cn, f.ID, resp, err)
	default:
		a.outQueueRecovery(cn, f.ID, hostQueueResponse{},
			fmt.Errorf("unknown queue recovery action %q (want list/requeue/discard)", action))
	}
}

func (a *nodeAgent) outQueueRecovery(cn *conn, id string, resp hostQueueResponse, err error) {
	if err != nil {
		log.Printf("queue recovery rejected: id=%s err=%v", id, err)
		a.out(cn, id, nil, true, -1, err.Error())
		return
	}
	raw, merr := json.Marshal(resp)
	if merr != nil {
		a.out(cn, id, nil, true, -1, merr.Error())
		return
	}
	a.out(cn, id, raw, true, 0, "")
}
