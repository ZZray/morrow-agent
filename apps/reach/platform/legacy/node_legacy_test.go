package main

// 旧 agent-loop.json 迁移的离线 fixtures：完整/截断/未知内容/空/幂等原字节，
// 以及导入后的会话续接。

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ara/internal/agent"
	"ara/internal/nativeapp"
	"ara/internal/providers"
)

func legacyHistoryJSON(t *testing.T, history []map[string]any, extra map[string]any) []byte {
	t.Helper()
	state := map[string]any{"history": history, "auto_compact": true}
	for k, v := range extra {
		state[k] = v
	}
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func writeLegacyFile(t *testing.T, raw []byte) (string, string) {
	t.Helper()
	source := filepath.Join(confDir(), legacyStateFile)
	if err := os.WriteFile(source, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return source, shaHex(raw)
}

func completeLegacyHistory() []map[string]any {
	return []map[string]any{
		{"role": "system", "content": "You are a local coding agent."},
		{"role": "user", "content": "write hi"},
		{"role": "assistant", "content": "", "tool_calls": []any{map[string]any{
			"id": "c1", "type": "function",
			"function": map[string]any{"name": "write_file", "arguments": `{"path":"a.txt","content":"hi"}`},
		}}},
		{"role": "tool", "tool_call_id": "c1", "content": "written a.txt (2 bytes)"},
		{"role": "assistant", "content": "done"},
	}
}

func TestLegacyCompleteHistoryImportedAndIdempotent(t *testing.T) {
	a := newTestNodeAgent(t)
	raw := legacyHistoryJSON(t, completeLegacyHistory(), map[string]any{
		"tasks":  []map[string]any{{"id": "t1", "title": "old task", "status": "running", "kind": "turn"}},
		"steer":  []string{"old steer"},
		"follow": []string{"old follow"},
	})
	source, sum := writeLegacyFile(t, raw)

	sess := a.hostSession()
	rec := sess.state.Legacy
	if rec == nil || !rec.Pending || rec.Error != "" {
		t.Fatalf("legacy record=%+v", rec)
	}
	// 旧循环的 persona 由宿主基础提示取代：只迁移 4 条对话消息。
	if rec.Messages != 4 {
		t.Fatalf("messages=%d", rec.Messages)
	}
	// 原字节备份 + 旧文件不动。
	backup := source + ".backup-" + sum[:12]
	got, err := os.ReadFile(backup)
	if err != nil || shaHex(got) != sum {
		t.Fatalf("backup missing or changed: err=%v", err)
	}
	still, err := os.ReadFile(source)
	if err != nil || shaHex(still) != sum {
		t.Fatalf("legacy file must stay byte-identical: err=%v", err)
	}
	// 旧任务板 paused 可见；旧队列保留但不在启动时执行。
	tasks := sess.tasks()
	if len(tasks) != 1 || tasks[0].Status != "paused" {
		t.Fatalf("board=%+v", tasks)
	}
	if len(sess.state.LegacyPausedQueue) != 2 {
		t.Fatalf("id-less legacy queue must stay paused and visible: %+v", sess.state.LegacyPausedQueue)
	}
	if sess.control.QueuedMessageCount() != 0 {
		t.Fatal("a paused queue must not run at startup")
	}

	// 第一次真正跑回合时（已知 model）才导入。
	id, err := sess.importLegacyHistory("test-model")
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if id == "" || sess.state.NativeSessionID != id || !sess.state.Legacy.Imported || sess.state.Legacy.Pending {
		t.Fatalf("import result id=%q state=%+v", id, sess.state)
	}

	store, err := agent.OpenSessionStore(a.nativeSessionDir())
	if err != nil {
		t.Fatal(err)
	}
	imported, err := store.Load(id)
	if err != nil {
		t.Fatal(err)
	}
	if len(imported.Messages) != 4 {
		t.Fatalf("imported messages=%d", len(imported.Messages))
	}
	if imported.ProviderID != hostProviderID || imported.Model != "test-model" {
		t.Fatalf("binding provider=%q model=%q", imported.ProviderID, imported.Model)
	}
	if imported.System != hostSystemPrompt() {
		t.Fatalf("system binding differs: %q", imported.System)
	}
	if imported.Import == nil || imported.Import.ID != sess.legacySourceID() {
		t.Fatalf("import provenance=%+v", imported.Import)
	}
	// 旧循环的 persona 不在 transcript 里：第一条是 user，工具调用与结果成对。
	if imported.Messages[0].Text() != "write hi" || imported.Messages[1].ToolCalls[0].Name != "write_file" {
		t.Fatalf("imported transcript=%+v", imported.Messages)
	}

	// 幂等：再导入返回同一个会话，且 store 里只有一个 journal。
	again, err := sess.importLegacyHistory("test-model")
	if err != nil || again != id {
		t.Fatalf("re-import id=%q err=%v", again, err)
	}
	list, err := store.List()
	if err != nil || len(list) != 1 {
		t.Fatalf("journals=%d err=%v", len(list), err)
	}

	// 宿主状态丢失（重启）后重新迁移：来源幂等仍然命中同一个会话，不新建。
	if err := os.Remove(a.hostStatePath()); err != nil {
		t.Fatal(err)
	}
	fresh := newHostSession(a.hostStatePath(), func() (*agent.SessionStore, error) {
		return agent.OpenSessionStore(a.nativeSessionDir())
	})
	reimported, err := fresh.importLegacyHistory("test-model")
	if err != nil || reimported != id {
		t.Fatalf("source idempotency lost: id=%q err=%v", reimported, err)
	}
	if list, err := store.List(); err != nil || len(list) != 1 {
		t.Fatalf("journals after re-migration=%d err=%v", len(list), err)
	}

	// 同一 session 续接：模型看到导入的历史。
	provider := &scriptedProvider{}
	if _, err := nativeapp.Run(context.Background(), nativeapp.Options{
		SessionDir: a.nativeSessionDir(),
		SessionID:  id,
		Cwd:        currentCwd(),
		Prompt:     "next",
		MaxTurns:   4,
		Host: &nativeapp.Host{
			Provider:   provider,
			ProviderID: hostProviderID,
			Model:      "test-model",
			System:     hostSystemPrompt(),
			Tools: func(agent.Session) ([]agent.Tool, func() error, error) {
				return a.localTools(), nil, nil
			},
		},
	}, nil); err != nil {
		t.Fatalf("resume run: %v", err)
	}
	request, ok := provider.lastRequest()
	if !ok {
		t.Fatal("provider was never called")
	}
	if len(request.Messages) < 5 {
		t.Fatalf("resume lost the imported history: %d messages", len(request.Messages))
	}
	if request.Messages[0].Text() != "write hi" {
		t.Fatalf("resume history[0]=%+v", request.Messages[0])
	}

	// 无投递标识的旧队列保持 paused：不自动投递，也不按文本猜。
	if len(sess.state.LegacyPausedQueue) != 2 || sess.control.QueuedMessageCount() != 0 {
		t.Fatalf("id-less legacy queue must stay paused: %+v control=%d", sess.state.LegacyPausedQueue, sess.control.QueuedMessageCount())
	}
}

func TestLegacyTruncatedHistoryRejectedWithoutReplay(t *testing.T) {
	a := newTestNodeAgent(t)
	truncated := completeLegacyHistory()[:3] // assistant tool_calls 没有结果
	raw := legacyHistoryJSON(t, truncated, map[string]any{
		"tasks": []map[string]any{{"id": "t1", "title": "old task", "status": "running", "kind": "turn"}},
		"steer": []string{"old steer"},
	})
	source, sum := writeLegacyFile(t, raw)

	sess := a.hostSession()
	rec := sess.state.Legacy
	if rec == nil || rec.Imported || rec.Pending {
		t.Fatalf("a truncated history must not be imported: %+v", rec)
	}
	if !strings.Contains(rec.Error, "truncated") {
		t.Fatalf("error must be visible: %q", rec.Error)
	}
	still, err := os.ReadFile(source)
	if err != nil || shaHex(still) != sum {
		t.Fatalf("legacy file must stay byte-identical: err=%v", err)
	}
	if len(sess.tasks()) != 1 || len(sess.state.LegacyPausedQueue) != 1 {
		t.Fatal("board and pending queue must be preserved")
	}
	// 没有任何 journal 被发布：拒绝就是拒绝。
	if files, _ := filepath.Glob(filepath.Join(a.nativeSessionDir(), "*.jsonl")); len(files) != 0 {
		t.Fatalf("a rejected import published a journal: %v", files)
	}
	// 损坏的旧历史必须阻断回合，而不是起一个空会话顶替它。
	id, err := sess.importLegacyHistory("test-model")
	if err == nil || id != "" || !strings.Contains(err.Error(), "not migrated") {
		t.Fatalf("rejected history must block: id=%q err=%v", id, err)
	}
	if sess.state.NativeSessionID != "" {
		t.Fatal("a blocked legacy import must not fabricate a session")
	}
}

func TestLegacyUnknownContentRejected(t *testing.T) {
	a := newTestNodeAgent(t)
	history := completeLegacyHistory()
	history[1] = map[string]any{"role": "user", "content": []any{map[string]any{"type": "image", "url": "http://x/y.png"}}}
	writeLegacyFile(t, legacyHistoryJSON(t, history, nil))

	rec := a.hostSession().state.Legacy
	if rec == nil || rec.Imported || rec.Error == "" {
		t.Fatalf("opaque content must be rejected: %+v", rec)
	}
}

func TestLegacyCorruptStateRejected(t *testing.T) {
	a := newTestNodeAgent(t)
	source, sum := writeLegacyFile(t, []byte("{not json"))
	rec := a.hostSession().state.Legacy
	if rec == nil || rec.Imported || !strings.Contains(rec.Error, "not valid JSON") {
		t.Fatalf("record=%+v", rec)
	}
	if still, err := os.ReadFile(source); err != nil || shaHex(still) != sum {
		t.Fatal("a corrupt legacy file must stay untouched")
	}
}

func TestLegacyEmptyHistoryAllowsNewSession(t *testing.T) {
	a := newTestNodeAgent(t)
	raw, err := json.Marshal(map[string]any{
		"tasks":  []map[string]any{{"id": "t1", "title": "old task", "status": "done", "kind": "todo"}},
		"steer":  []string{"old steer"},
		"follow": []string{"old follow"},
	})
	if err != nil {
		t.Fatal(err)
	}
	writeLegacyFile(t, raw)

	sess := a.hostSession()
	rec := sess.state.Legacy
	if rec == nil || !rec.Imported || rec.Pending {
		t.Fatalf("an empty history needs no import: %+v", rec)
	}
	if sess.state.NativeSessionID != "" {
		t.Fatalf("empty history must not fabricate a session: %q", sess.state.NativeSessionID)
	}
	if len(sess.tasks()) != 1 || len(sess.state.LegacyPausedQueue) != 2 {
		t.Fatal("board and queues must survive an empty history")
	}
	// 空历史允许普通新会话。
	provider := &scriptedProvider{}
	result, err := nativeapp.Run(context.Background(), nativeapp.Options{
		SessionDir: a.nativeSessionDir(),
		Cwd:        currentCwd(),
		Prompt:     "fresh objective",
		MaxTurns:   4,
		Host: &nativeapp.Host{
			Provider:   provider,
			ProviderID: hostProviderID,
			Model:      "test-model",
			System:     hostSystemPrompt(),
			Tools: func(agent.Session) ([]agent.Tool, func() error, error) {
				return a.localTools(), nil, nil
			},
		},
	}, nil)
	if err != nil || result.SessionID == "" {
		t.Fatalf("new session failed: err=%v id=%q", err, result.SessionID)
	}
	if sess.control.QueuedMessageCount() != 0 {
		t.Fatal("the paused queue must not run at startup")
	}
	if len(sess.state.LegacyPausedQueue) != 2 {
		t.Fatalf("the paused queue must stay visible: %+v", sess.state.LegacyPausedQueue)
	}
}

// 来源被改动后又精确还原：重新装载时必须只清掉那条「已恢复」的错误，否则一个已经
// 恢复的来源会永远误阻合法换绑（Imported==true 的早返回）。
func TestLegacyRestoredSourceClearsTheRecoveredError(t *testing.T) {
	a := newTestNodeAgent(t)
	raw := legacyHistoryJSON(t, completeLegacyHistory(), nil)
	source, sum := writeLegacyFile(t, raw)
	first := a.hostSession()
	id, err := first.importLegacyHistory("test-model")
	if err != nil || id == "" {
		t.Fatalf("import: id=%q err=%v", id, err)
	}
	// 改坏来源：重新装载必须记录错误并阻断，但原 provenance（已导入的会话）保留。
	changed := completeLegacyHistory()
	changed[1]["content"] = "different source transcript"
	if err := os.WriteFile(source, legacyHistoryJSON(t, changed, nil), 0o600); err != nil {
		t.Fatal(err)
	}
	broken := reloadCoordinatorHost(a)
	if _, err := broken.importLegacyHistory("test-model"); err == nil {
		t.Fatal("a changed source must block")
	}
	broken.mu.Lock()
	blockedErr, stillImported := broken.state.Legacy.Error, broken.state.Legacy.Imported
	broken.mu.Unlock()
	if blockedErr == "" || !stillImported {
		t.Fatalf("the record must keep its provenance and record the error: err=%q imported=%v", blockedErr, stillImported)
	}
	// 精确还原原字节：来源、备份与 journal 重新一致，那条错误必须被清掉。
	if err := os.WriteFile(source, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	restored := reloadCoordinatorHost(a)
	if err := restored.blockedErr(); err != nil {
		t.Fatal(err)
	}
	restored.mu.Lock()
	cleared := restored.state.Legacy.Error
	restored.mu.Unlock()
	if cleared != "" {
		t.Fatalf("a restored source must clear the recovered error: %q", cleared)
	}
	got, err := restored.importLegacyHistory("test-model")
	if err != nil || got != id {
		t.Fatalf("the restored source must resolve to the imported session: id=%q err=%v", got, err)
	}
	// 合法换绑不再被误阻：来源一致、journal 在。
	if _, switchedFrom, err := restored.sessionBinding("model-b", providers.OpenAICompletions); err != nil || switchedFrom != id {
		t.Fatalf("a restored source must not block a model switch: from=%q err=%v", switchedFrom, err)
	}
	if shaHex(raw) != sum {
		t.Fatal("fixture changed the original bytes")
	}
	// 备份被改坏（与记录不一致）时绝不盲目清除：来源还原了也必须保留错误。
	if err := os.WriteFile(source+".backup-"+sum[:12], []byte("tampered backup"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, legacyHistoryJSON(t, changed, nil), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := reloadCoordinatorHost(a).importLegacyHistory("test-model"); err == nil {
		t.Fatal("a changed source must still block")
	}
	if err := os.WriteFile(source, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	notProven := reloadCoordinatorHost(a)
	notProven.mu.Lock()
	keptErr := notProven.state.Legacy.Error
	notProven.mu.Unlock()
	if keptErr == "" {
		t.Fatal("a tampered backup must keep the error: recovery is not proven")
	}
}
