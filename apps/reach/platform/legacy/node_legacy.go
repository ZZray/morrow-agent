package main

// 旧 agentloop 状态（confDir()/agent-loop.json）的迁移。
//
// 迁移只做四件事：原字节备份、结构验证、把完整历史映射成原生消息、把旧任务板与
// 待投递队列保留为 paused 可见状态。它不执行任何工具、不重放旧轮次、不把损坏或
// 未决的工具轮次当成新的空会话，也不覆盖旧文件。
//
// 真正的写入交给共享核心 agent.SessionStore.ImportHistory：宿主只解析自己的格式、
// 备份自己的文件、自己保留 pending 队列；核心负责原子 journal 发布与来源幂等。
// 导入在第一次真正跑回合时进行（那时才知道本次的 model），所以导入出来的会话
// 精确绑定本次使用的 provider/model/system。

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"ara/internal/agent"
)

// legacyStateFile 是旧循环的落盘文件名，保持原样、只读不写。
const legacyStateFile = "agent-loop.json"

// legacySourceVersion 参与来源标识：格式变了就换版本，旧来源不会被误认成同一个。
const legacySourceVersion = "v1"

// legacyState 是旧 agent-loop.json 的结构。字段名与旧 agentloop.State 一致。
type legacyState struct {
	Tasks       []hostTask       `json:"tasks"`
	Steer       []string         `json:"steer,omitempty"`
	Follow      []string         `json:"follow,omitempty"`
	History     []map[string]any `json:"history,omitempty"`
	AutoCompact *bool            `json:"auto_compact,omitempty"`
}

// legacyRecord 记录一次迁移：来源、校验和、备份位置与结果。它让迁移按来源幂等
// （同一文件同一校验和只导入一次），也让旧队列保持可见。
type legacyRecord struct {
	Source     string `json:"source"`
	SHA256     string `json:"sha256"`
	Backup     string `json:"backup,omitempty"`
	Tasks      int    `json:"tasks,omitempty"`
	Steer      int    `json:"steer,omitempty"`
	Follow     int    `json:"follow,omitempty"`
	Messages   int    `json:"messages,omitempty"`
	Imported   bool   `json:"imported"`
	ImportedID string `json:"imported_session_id,omitempty"`
	Pending    bool   `json:"pending_import,omitempty"`
	Error      string `json:"error,omitempty"`
	// LegacySystem 是旧历史里被宿主基础提示取代的首条 system 消息原文。它被记录
	// 下来而不是静默丢弃：原文件字节不变，但取代动作必须可见。
	LegacySystem string `json:"legacy_system,omitempty"`
}

func (s *hostSession) legacySource() string {
	return filepath.Join(confDir(), legacyStateFile)
}

// legacySourceID 是 ImportHistory 的来源标识：旧文件内容摘要 + 格式版本。同一份
// 旧文件永远映射到同一个原生会话，重复导入返回同一个会话而不是新建。
func (s *hostSession) legacySourceID() string {
	if s.state.Legacy == nil {
		return ""
	}
	return "handwave-agent-loop/" + legacySourceVersion + "/sha256:" + s.state.Legacy.SHA256
}

// migrateLegacy 读取旧状态文件并做备份 + 验证 + 映射。任何失败都只记录在宿主状态
// 里：旧文件、旧任务板与旧队列原样保留，不会被清空、重放或被新空会话顶替。
//
// 迁移按「来源 + 校验和」记账，所以重复装载（重启）不会重复 adoption 旧任务板与旧
// 队列；来源缺失、不可读或在迁移之后被改动时，记录必须明确报错——绝不替换原
// provenance，也绝不假装这份来源已经导入。
func (s *hostSession) migrateLegacy() {
	source := s.legacySource()
	s.mu.Lock()
	rec := s.state.Legacy
	s.mu.Unlock()

	raw, err := os.ReadFile(source)
	if errors.Is(err, os.ErrNotExist) {
		if rec != nil && rec.Source == source {
			// 记录在、来源不在：原 provenance 与错误都保留，绝不假装「没有旧历史」。
			s.blockLegacy(rec, "legacy agent-loop state is missing (record kept, never re-imported)")
		}
		return
	}
	if err != nil {
		if rec != nil && rec.Source == source {
			s.blockLegacy(rec, "legacy agent-loop state unreadable: "+err.Error())
		} else {
			log.Printf("legacy agent-loop state unreadable: path=%s err=%v", source, err)
		}
		return
	}
	sum := shaHex(raw)
	if rec != nil && rec.Source == source {
		if rec.SHA256 != sum {
			// 来源在迁移之后被改动：旧记录不能代表这份内容，绝不替换 provenance，
			// 也绝不假装这次导入仍然有效。
			s.blockLegacy(rec, fmt.Sprintf(
				"legacy agent-loop state changed after migration (record kept): recorded=%s current=%s",
				clipSHA(rec.SHA256), clipSHA(sum)))
			return
		}
		if rec.Imported {
			// 已导入：按来源幂等，绝不重复 adoption。但如果记录里还留着一个「来源曾经
			// 被改动/缺失」的错误，而来源、备份与 journal 现在重新一致，就必须清掉它：
			// 否则一个已经恢复的来源会永远误阻合法换绑。只清这一条可证明已恢复的错误。
			if rec.Error != "" {
				s.clearRecoveredLegacyError(rec, sum)
			}
			return
		}
		if rec.Error != "" && !rec.Pending {
			return // 已经明确记录的永久失败：保留原样，不重试、不重复 adoption。
		}
		// 还没导入（Pending，含上次导入失败待重试）：内存里的待导入历史不落盘，
		// 只重新验证它，绝不重复 adoption 旧任务板与旧队列。
		var st legacyState
		if err := json.Unmarshal(raw, &st); err != nil {
			s.blockLegacy(rec, "legacy state is not valid JSON: "+err.Error())
			return
		}
		s.verifyLegacy(rec, st)
		return
	}

	// 首次迁移：先做排他创建的原字节备份，再做结构验证与映射。
	backup, err := backupLegacy(source, sum, raw)
	if err != nil {
		// 备份冲突（同名不同内容）或写不进去：不导入、不覆盖，明确记录并保留来源。
		s.recordLegacyFailure(source, sum, err.Error())
		log.Printf("legacy agent-loop backup blocked: path=%s err=%v", source, err)
		return
	}
	rec = &legacyRecord{Source: source, SHA256: sum, Backup: backup}
	s.mu.Lock()
	s.state.Legacy = rec
	s.legacyMessages = nil
	s.mu.Unlock()

	var st legacyState
	if err := json.Unmarshal(raw, &st); err != nil {
		s.blockLegacy(rec, "legacy state is not valid JSON: "+err.Error())
		log.Printf("legacy agent-loop state rejected: err=%v", err)
		return
	}
	s.mu.Lock()
	rec.Tasks, rec.Steer, rec.Follow = len(st.Tasks), len(st.Steer), len(st.Follow)
	if st.AutoCompact != nil {
		s.state.AutoCompact = st.AutoCompact
	}
	s.mu.Unlock()
	s.adoptLegacyBoard(st.Tasks)
	s.adoptLegacyQueue(st.Steer, st.Follow)
	s.verifyLegacy(rec, st)
}

// verifyLegacy 验证旧历史并把可迁移的对话映射成原生消息，供第一次真正跑回合时导入。
// 它只改「待导入历史」与记录里的结果字段（都在同一把锁内），绝不 adoption 任务板或
// 队列：adoption 只发生在首次迁移。
func (s *hostSession) verifyLegacy(rec *legacyRecord, st legacyState) {
	if len(st.History) == 0 {
		// 空历史不需要导入（ImportHistory 也拒绝空 transcript）：允许普通新会话，
		// 但任务板与队列仍然保留。
		s.mu.Lock()
		rec.Imported, rec.Pending, rec.Error = true, false, ""
		s.legacyMessages = nil
		s.mu.Unlock()
		s.saveBestEffort("legacy empty history")
		log.Printf("legacy agent-loop state migrated: tasks=%d steer=%d follow=%d history=0", rec.Tasks, rec.Steer, rec.Follow)
		return
	}
	messages, legacySystem, err := legacyMessages(st.History)
	if err != nil {
		s.blockLegacy(rec, err.Error())
		log.Printf("legacy agent-loop history rejected (kept, not replayed, not replaced): err=%v", err)
		return
	}
	s.mu.Lock()
	rec.Error = ""
	if legacySystem != "" {
		// 旧循环 persona 被宿主基础提示取代：记录原文 + 明确日志，不静默丢弃，
		// 也绝不把它注入新会话的 host base。
		rec.LegacySystem = legacySystem
	}
	if len(messages) == 0 {
		// 旧历史只有系统提示（旧循环的本机 persona）：它由宿主基础提示取代，
		// 没有可迁移的对话内容。
		rec.Imported, rec.Pending = true, false
		s.legacyMessages = nil
	} else {
		rec.Messages, rec.Pending = len(messages), true
		s.legacyMessages = messages
	}
	s.mu.Unlock()
	if legacySystem != "" {
		log.Printf("legacy agent-loop system prompt superseded by the host base (kept in state, never injected): bytes=%d", len(legacySystem))
	}
	s.saveBestEffort("legacy verified")
	log.Printf("legacy agent-loop history verified: messages=%d source_id=%s (import deferred to the first turn)", len(messages), s.legacySourceID())
}

// blockLegacy 明确记录旧来源的失败：原 provenance（来源、校验和、已导入的会话）原样
// 保留，只追加错误，并丢弃已经不代表当前来源的待导入历史。它绝不把记录伪造成
// 「已导入」，也绝不清掉旧来源的原始字节。
func (s *hostSession) blockLegacy(rec *legacyRecord, msg string) {
	s.mu.Lock()
	rec.Error = msg
	rec.Pending = false
	s.legacyMessages = nil
	s.mu.Unlock()
	s.saveBestEffort("legacy blocked")
}

// recordLegacyFailure 安装一条新的旧来源记录并记录失败：来源与校验和保留，不假装导入。
func (s *hostSession) recordLegacyFailure(source, sum, msg string) *legacyRecord {
	rec := &legacyRecord{Source: source, SHA256: sum, Error: msg}
	s.mu.Lock()
	s.state.Legacy = rec
	s.legacyMessages = nil
	s.mu.Unlock()
	s.saveBestEffort("legacy rejected")
	return rec
}

// backupLegacy 用排他创建写原字节备份：同名备份已存在且内容一致时复用它；内容不同
// 时绝不覆盖（冲突必须可见），返回错误让迁移阻断。
func backupLegacy(source, sum string, raw []byte) (string, error) {
	backup := source + ".backup-" + clipSHA(sum)
	if existing, err := os.ReadFile(backup); err == nil {
		if shaHex(existing) == sum {
			return backup, nil
		}
		return "", fmt.Errorf("legacy backup %s already exists with different content (kept, not overwritten)", filepath.Base(backup))
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("legacy backup %s unreadable: %w", filepath.Base(backup), err)
	}
	f, err := os.OpenFile(backup, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			// 竞态：别人刚建了同名备份。只有内容一致才复用，否则阻断。
			if existing, rerr := os.ReadFile(backup); rerr == nil && shaHex(existing) == sum {
				return backup, nil
			}
			return "", fmt.Errorf("legacy backup %s exists with different content (kept, not overwritten)", filepath.Base(backup))
		}
		return "", fmt.Errorf("legacy backup failed: %w", err)
	}
	if _, err := f.Write(raw); err != nil {
		_ = f.Close()
		return "", fmt.Errorf("legacy backup write failed: %w", err)
	}
	if err := f.Close(); err != nil {
		return "", fmt.Errorf("legacy backup close failed: %w", err)
	}
	return backup, nil
}

// importLegacyHistory 把已验证的旧历史交给共享核心原子写入原生 journal，并记录
// 绑定信息。它只在第一次真正跑回合时调用（那时才知道 model），因此导入出来的会话
// 与本次运行的 provider/model/system 精确一致，下一次运行就能续接它。
//
// 返回 ("", nil) 表示没有待导入的历史。
func (s *hostSession) importLegacyHistory(model string) (string, error) {
	s.mu.Lock()
	rec := s.state.Legacy
	messages := s.legacyMessages
	existing := s.state.NativeSessionID
	s.mu.Unlock()
	if rec == nil {
		return "", nil
	}
	if rec.Error != "" && !rec.Pending {
		// 旧来源损坏、被改动或导入被核心拒绝（不可重试）：阻断本回合，绝不用新空
		// 会话顶替它，也绝不假装已经导入。
		return "", fmt.Errorf("legacy agent-loop history is not migrated: %s", rec.Error)
	}
	if existing != "" {
		// 已经有原生会话（旧历史已导入或已经跑过）：先核对这些 journal 确实还在，
		// 再按来源幂等返回同一个会话——绝不对缺失的 journal 假成功。
		if err := s.verifyNativeJournal(existing); err != nil {
			return "", err
		}
		return existing, nil
	}
	if len(messages) == 0 {
		// 没有待导入的历史（空历史/只有旧 persona）：允许普通新会话。
		return "", nil
	}
	if s.openStore == nil {
		return "", errors.New("legacy import requires a session store opener")
	}
	store, err := s.openStore()
	if err != nil {
		return "", fmt.Errorf("legacy import store: %w", err)
	}
	session, err := store.ImportHistory(agent.SessionOptions{
		ProviderID: hostProviderID,
		Model:      model,
		System:     hostSystemPrompt(),
		Cwd:        currentCwd(),
	}, s.legacySourceID(), messages)
	if err != nil {
		// 结构问题（核心拒绝）重试也不会变好；忙/IO 问题保留 pending 让下次回合再试。
		retryable := !errors.Is(err, agent.ErrInvalidImportHistory)
		s.mu.Lock()
		rec.Error = err.Error()
		rec.Pending = retryable
		s.mu.Unlock()
		s.saveBestEffort("legacy import rejected")
		return "", fmt.Errorf("legacy import rejected: %w", err)
	}
	// 绑定与 Imported 必须在同一把锁内改，并且整体落盘：保存失败就整体回滚内存，
	// 绝不留一份没落盘的绑定让下一次 existing!=空 绕过预保存。journal 原样留在
	// 磁盘上，下一次导入会用同一个 source ID 幂等命中它。
	s.mu.Lock()
	prevRec, prevNative, prevModel, prevMessages := *rec, s.state.NativeSessionID, s.state.Model, s.legacyMessages
	rec.Imported = true
	rec.Pending = false
	rec.Error = ""
	rec.ImportedID = session.ID
	s.state.NativeSessionID = session.ID
	s.state.Model = model
	s.legacyMessages = nil
	s.mu.Unlock()
	if err := s.save(); err != nil {
		s.mu.Lock()
		*rec = prevRec
		s.state.NativeSessionID = prevNative
		s.state.Model = prevModel
		s.legacyMessages = prevMessages
		s.mu.Unlock()
		log.Printf("legacy agent-loop import binding rolled back (journal kept): session=%s err=%v", session.ID, err)
		return "", fmt.Errorf("legacy import binding not persisted: %w", err)
	}
	log.Printf("legacy agent-loop history imported: session=%s messages=%d source_id=%s", session.ID, len(messages), s.legacySourceID())
	return session.ID, nil
}

// clearRecoveredLegacyError 只在「来源字节、备份与已导入的 journal 三者重新一致」时清掉
// 记录里的错误；证明不了就原样保留，绝不盲目清其他未知错误。
func (s *hostSession) clearRecoveredLegacyError(rec *legacyRecord, sum string) {
	if rec.SHA256 != sum || rec.Backup == "" || rec.ImportedID == "" {
		return
	}
	backup, err := os.ReadFile(rec.Backup)
	if err != nil || shaHex(backup) != rec.SHA256 {
		return
	}
	if err := s.verifyNativeJournal(rec.ImportedID); err != nil {
		return
	}
	s.mu.Lock()
	if rec.Error == "" {
		s.mu.Unlock()
		return
	}
	rec.Error = ""
	s.mu.Unlock()
	s.saveBestEffort("legacy error cleared after recovery")
	log.Printf("legacy agent-loop error cleared (source, backup and journal agree again): session=%s", rec.ImportedID)
}

// verifyNativeJournal 核对一个已经绑定的原生会话 journal 仍然存在且可读。读不到就
// 明确报错，绝不假装续接成功。
func (s *hostSession) verifyNativeJournal(id string) error {
	if id == "" {
		return nil
	}
	if s.openStore == nil {
		return fmt.Errorf("native session %s cannot be verified without a session store opener", id)
	}
	store, err := s.openStore()
	if err != nil {
		return fmt.Errorf("native session %s cannot be verified (journal store unavailable): %w", id, err)
	}
	if _, err := store.Load(id); err != nil {
		return fmt.Errorf("native session %s cannot be verified (journal missing or unreadable, kept): %w", id, err)
	}
	return nil
}

// adoptLegacyQueue 把旧 agent-loop.json 的 steer/follow 队列保留为 paused 可见状态。
// 它们没有投递标识、无法证明未投递，所以绝不自动投递、也绝不按文本猜；并入控制
// 队列属于下一片 legacy 收尾范围。它只在首次迁移时调用：重启重新装载绝不重复 append。
func (s *hostSession) adoptLegacyQueue(steer, follow []string) {
	if len(steer)+len(follow) == 0 {
		return
	}
	s.mu.Lock()
	for _, text := range steer {
		s.state.LegacyPausedQueue = append(s.state.LegacyPausedQueue,
			hostPausedEntry{Source: pausedSourceLegacy, Text: text, Kind: string(agent.DeliverySteer)})
	}
	for _, text := range follow {
		s.state.LegacyPausedQueue = append(s.state.LegacyPausedQueue,
			hostPausedEntry{Source: pausedSourceLegacy, Text: text, Kind: string(agent.DeliveryFollowUp)})
	}
	// 条目变了，预览版本必须跟着变：旧视图的处置请求随后会被拒绝。
	s.state.QueueRevision++
	s.mu.Unlock()
	log.Printf("legacy agent-loop queue kept paused (no delivery id): steer=%d follow=%d", len(steer), len(follow))
}

func clipSHA(sum string) string {
	if len(sum) > 12 {
		return sum[:12]
	}
	return sum
}

// adoptLegacyBoard 把旧任务板并入当前板。旧文件里仍是 running 的项降级为 paused，
// 保持可见但不假装还在跑。只有当当前板为空时才并入，避免旧文件覆盖实时状态。
func (s *hostSession) adoptLegacyBoard(tasks []hostTask) {
	if len(tasks) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.state.Tasks) != 0 {
		return
	}
	adopted := make([]hostTask, 0, len(tasks))
	for _, t := range tasks {
		if strings.TrimSpace(t.ID) == "" || strings.TrimSpace(t.Title) == "" {
			continue
		}
		if t.Status == "running" {
			t.Status = "paused"
		}
		if t.Kind == "" {
			t.Kind = "todo"
		}
		adopted = append(adopted, t)
	}
	s.state.Tasks = pruneBoard(adopted, maxBoardTasks)
}

func shaHex(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// legacyMessages 把旧历史映射成原生消息。只接受结构完整、工具调用与结果成对且
// 顺序正确、内容为纯文本的历史；截断的尾部、孤立的工具结果、未知角色或未知内容
// 一律报错——绝不重放，也绝不补齐。
//
// 旧循环把本机 persona 作为第一条 system 消息存在历史里，它由宿主基础提示取代，
// 所以只允许出现在最前面的 system 消息被丢弃（ImportHistory 本身不接受 system
// 角色）；出现在别处一律报错。
func legacyMessages(history []map[string]any) ([]agent.Message, string, error) {
	out := make([]agent.Message, 0, len(history))
	legacySystem := ""
	var open []string
	openSet := map[string]bool{}
	for i, raw := range history {
		if raw == nil {
			return nil, "", fmt.Errorf("legacy history record %d is empty", i+1)
		}
		for key := range raw {
			switch key {
			case "role", "content", "tool_calls", "tool_call_id":
			default:
				return nil, "", fmt.Errorf("legacy history record %d: unknown field %q", i+1, key)
			}
		}
		role, _ := raw["role"].(string)
		content, err := legacyText(raw["content"])
		if err != nil {
			return nil, "", fmt.Errorf("legacy history record %d: %v", i+1, err)
		}
		switch role {
		case "system":
			if i == 0 {
				legacySystem = content
			}
			if i != 0 {
				return nil, "", fmt.Errorf("legacy history record %d: system message outside the leading position", i+1)
			}
			if len(open) != 0 {
				return nil, "", fmt.Errorf("legacy history record %d: system message before outstanding tool results", i+1)
			}
		case "user":
			if len(open) != 0 {
				return nil, "", fmt.Errorf("legacy history record %d: user message inserted before outstanding tool results", i+1)
			}
			if content == "" {
				return nil, "", fmt.Errorf("legacy history record %d: empty user content", i+1)
			}
			out = append(out, agent.TextMessage(role, content))
		case "assistant":
			if len(open) != 0 {
				return nil, "", fmt.Errorf("legacy history record %d: assistant message inserted before outstanding tool results", i+1)
			}
			calls, err := legacyToolCalls(raw["tool_calls"])
			if err != nil {
				return nil, "", fmt.Errorf("legacy history record %d: %v", i+1, err)
			}
			message := agent.Message{Role: "assistant"}
			if content != "" {
				message.Content = []agent.Content{{Type: "text", Text: content}}
			}
			message.ToolCalls = calls
			if len(message.Content) == 0 && len(calls) == 0 {
				return nil, "", fmt.Errorf("legacy history record %d: empty assistant message", i+1)
			}
			out = append(out, message)
			for _, call := range calls {
				open = append(open, call.ID)
				openSet[call.ID] = true
			}
		case "tool":
			id, _ := raw["tool_call_id"].(string)
			if strings.TrimSpace(id) == "" {
				return nil, "", fmt.Errorf("legacy history record %d: tool result without tool_call_id", i+1)
			}
			if !openSet[id] {
				return nil, "", fmt.Errorf("legacy history record %d: tool result %q has no matching tool call", i+1, id)
			}
			delete(openSet, id)
			for j, openID := range open {
				if openID == id {
					open = append(open[:j], open[j+1:]...)
					break
				}
			}
			out = append(out, agent.Message{
				Role:       "tool",
				ToolCallID: id,
				Content:    []agent.Content{{Type: "text", Text: content}},
			})
		default:
			return nil, "", fmt.Errorf("legacy history record %d: unsupported role %q", i+1, role)
		}
	}
	if len(open) != 0 {
		return nil, "", fmt.Errorf("legacy history is truncated: tool call %q has no result", open[0])
	}
	return out, legacySystem, nil
}

// legacyText 只接受纯文本内容。旧循环之外的多模态/结构化内容无法无损映射，直接
// 报错而不是丢弃或猜造。
func legacyText(v any) (string, error) {
	switch t := v.(type) {
	case nil:
		return "", nil
	case string:
		return t, nil
	default:
		return "", errors.New("unsupported message content (only text can be migrated)")
	}
}

func legacyToolCalls(v any) ([]agent.ToolCall, error) {
	if v == nil {
		return nil, nil
	}
	raw, ok := v.([]any)
	if !ok {
		return nil, errors.New("tool_calls must be a list")
	}
	calls := make([]agent.ToolCall, 0, len(raw))
	for i, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("tool call %d is not an object", i+1)
		}
		id, _ := m["id"].(string)
		fn, _ := m["function"].(map[string]any)
		name, _ := fn["name"].(string)
		args, _ := fn["arguments"].(string)
		if strings.TrimSpace(id) == "" || strings.TrimSpace(name) == "" {
			return nil, fmt.Errorf("tool call %d lacks id or name", i+1)
		}
		if args == "" {
			// 旧循环允许空参数字符串；原生调用要求一个完整的 JSON 对象。
			args = "{}"
		}
		var parsed map[string]json.RawMessage
		if err := json.Unmarshal([]byte(args), &parsed); err != nil || parsed == nil {
			return nil, fmt.Errorf("tool call %d arguments are not a complete JSON object", i+1)
		}
		calls = append(calls, agent.ToolCall{ID: id, Name: name, Arguments: json.RawMessage(args)})
	}
	return calls, nil
}
