package main

// 工作区 / 会话 / 附件 文件存储（hub 配置目录下）。

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"ara/internal/agent"
)

type wsMeta struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	DeviceFP   string `json:"device_fp,omitempty"`
	DeviceName string `json:"device_name,omitempty"` // 主机名或别名，便于侧栏展示
	ProjectPath string `json:"project_path,omitempty"` // 本地项目目录，AI 云端模式可读取
	CreatedAt  string `json:"created_at"`
	UpdatedAt  string `json:"updated_at"`
}

type sessMeta struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Pinned    bool   `json:"pinned,omitempty"`
	Model     string `json:"model,omitempty"`    // 会话绑定的模型身份
	Protocol  string `json:"protocol,omitempty"` // 会话绑定的协议身份（历史重放边界）
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
	MsgCount  int    `json:"msg_count"`
	// Smart 是智能会话解析一次后被钉住的身份。它只在该会话首次智能请求时写入，
	// 之后默认配置变化、目录刷新都不能让它换模型或改协议。
	Smart *smartIdentity `json:"smart,omitempty"`
}

// smartIdentity 保存一次选型决策的具体身份与可核对的版本。
type smartIdentity struct {
	DecisionID     string `json:"decision_id"`
	Model          string `json:"model"`
	Protocol       string `json:"protocol"`
	Pool           string `json:"pool,omitempty"`
	PolicyVersion  string `json:"policy_version,omitempty"`
	CatalogVersion string `json:"catalog_version,omitempty"`
	ExpiresAt      string `json:"expires_at"`
}

type chatMsg struct {
	ID            string          `json:"id"`
	Role          string          `json:"role"` // user|assistant|system|tool
	Content       string          `json:"content,omitempty"`
	ToolCalls     []toolCallOut   `json:"tool_calls,omitempty"`
	ToolCallID    string          `json:"tool_call_id,omitempty"`
	TurnID        string          `json:"turn_id,omitempty"`
	ContextSize   int             `json:"context_size,omitempty"`
	ContextFrozen bool            `json:"context_frozen,omitempty"`
	Name          string          `json:"name,omitempty"`
	Attachments   []attachRef     `json:"attachments,omitempty"`
	TS            string          `json:"ts"`
	Skills        []skillSnapshot `json:"skills,omitempty"`
	Events        []agentEvent    `json:"events,omitempty"`
	Clarify       []clarifyOption `json:"clarify,omitempty"`
	ApplyPending  *ApplyConfirm `json:"apply_pending,omitempty"`
	// Native 保存该消息的原生 agent 载体（含 ProviderData 不透明块），使网关换
	// 协议时仍能保真重放。缺失 Native 的旧消息只能按已知旧 chat 协议转换。
	Native     *agent.Message `json:"native,omitempty"`
	Usage      *agent.Usage   `json:"usage,omitempty"`
	StopReason string         `json:"stop_reason,omitempty"`
}

type ApplyConfirm struct {
	WorkspaceID string `json:"workspace_id"`
	ToolCallID  string `json:"tool_call_id"`
	Path        string `json:"path"`
	Content     string `json:"content"` // new content to be written
	Diff        string `json:"diff"`
}

type clarifyOption struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

type toolCallOut struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type attachRef struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	MIME    string `json:"mime"`
	Size    int64  `json:"size"`
	Path    string `json:"path,omitempty"`     // hub 相对路径
	Text    string `json:"text,omitempty"`     // 已抽取文本
	DataURL string `json:"data_url,omitempty"` // 小图 data URL（仅内存/消息用）
}

var sessionMessagesMu sync.RWMutex

func dataRoot() string {
	return filepath.Join(confDir(), "data")
}

func wsDir(id string) string {
	return filepath.Join(dataRoot(), "workspaces", id)
}

func globalKBDir() string {
	return filepath.Join(dataRoot(), "global", "kb")
}

func ensureDir(p string) error {
	return os.MkdirAll(p, 0o700)
}

func listWorkspaces() ([]wsMeta, error) {
	root := filepath.Join(dataRoot(), "workspaces")
	_ = ensureDir(root)
	ents, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var out []wsMeta
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		m, err := loadWSMeta(e.Name())
		if err != nil {
			continue
		}
		out = append(out, *m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out, nil
}

func loadWSMeta(id string) (*wsMeta, error) {
	b, err := os.ReadFile(filepath.Join(wsDir(id), "meta.json"))
	if err != nil {
		return nil, err
	}
	var m wsMeta
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

func saveWSMeta(m *wsMeta) error {
	dir := wsDir(m.ID)
	if err := ensureDir(dir); err != nil {
		return err
	}
	_ = ensureDir(filepath.Join(dir, "sessions"))
	_ = ensureDir(filepath.Join(dir, "kb"))
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "meta.json"), b, 0o600)
}

func createWorkspace(name string) (*wsMeta, error) {
	id := hexID()
	now := time.Now().UTC().Format(time.RFC3339)
	m := &wsMeta{ID: id, Name: strings.TrimSpace(name), CreatedAt: now, UpdatedAt: now}
	if m.Name == "" {
		m.Name = "工作区 " + id[:6]
	}
	if err := saveWSMeta(m); err != nil {
		return nil, err
	}
	return m, nil
}

func deleteWorkspace(id string) error {
	return os.RemoveAll(wsDir(id))
}

// projectTreeEntry represents a file or directory in the project tree.
type projectTreeEntry struct {
	Name     string              `json:"name"`
	Path     string              `json:"path"` // relative to project root
	Type     string              `json:"type"` // "file" or "dir"
	Children []*projectTreeEntry `json:"children,omitempty"`
}

// listProjectTree returns a hierarchical file tree for the given project root.
// Excludes common VCS/artifact directories and files.
func listProjectTree(root string) []*projectTreeEntry {
	const maxDepth = 6
	ignored := map[string]bool{
		".git":          true,
		".svn":          true,
		".hg":           true,
		"node_modules":  true,
		"vendor":        true,
		".venv":         true,
		"venv":          true,
		"__pycache__":   true,
		".pytest_cache": true,
		"dist":          true,
		"build":         true,
		"target":        true,
		".idea":         true,
		".vscode":       true,
		".DS_Store":     true,
		"Thumbs.db":     true,
	}
	ignoreExt := map[string]bool{
		".exe":  true,
		".dll":  true,
		".so":   true,
		".a":    true,
		".o":    true,
		".obj":  true,
		".bin":  true,
		".png":  true,
		".jpg":  true,
		".jpeg": true,
		".gif":  true,
		".ico":  true,
		".zip":  true,
		".tar":  true,
		".gz":   true,
		".7z":   true,
		".rar":  true,
		".pdf":  true,
		".mp3":  true,
		".mp4":  true,
		".wav":  true,
		".avi":  true,
		".mov":  true,
	}

	var walk func(dir string, depth int) []*projectTreeEntry
	walk = func(dir string, depth int) []*projectTreeEntry {
		if depth > maxDepth {
			return nil
		}
		ents, err := os.ReadDir(dir)
		if err != nil {
			return nil
		}
		var out []*projectTreeEntry
		for _, e := range ents {
			name := e.Name()
			if ignored[name] {
				continue
			}
			if !e.IsDir() {
				ext := filepath.Ext(name)
				if ignoreExt[ext] {
					continue
				}
			}
			rel, _ := filepath.Rel(root, filepath.Join(dir, name))
			entry := &projectTreeEntry{
				Name: name,
				Path: filepath.ToSlash(rel),
				Type: "file",
			}
			if e.IsDir() {
				entry.Type = "dir"
				entry.Children = walk(filepath.Join(dir, name), depth+1)
			}
			out = append(out, entry)
		}
		sort.Slice(out, func(i, j int) bool {
			if out[i].Type != out[j].Type {
				return out[i].Type == "dir"
			}
			return out[i].Name < out[j].Name
		})
		return out
	}

	// Check root exists
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return nil
	}
	return walk(root, 0)
}

// readProjectFile reads a file under the project root, with size limit (512KB).
func readProjectFile(root, filePath string) (string, error) {
	// Security: ensure file is under root (no path traversal)
	absRoot, _ := filepath.Abs(root)
	absFile, err := filepath.Abs(filepath.Join(root, filePath))
	if err != nil {
		return "", fmt.Errorf("invalid path")
	}
	// Must be under root
	if !strings.HasPrefix(absFile, absRoot+string(filepath.Separator)) && absFile != absRoot {
		return "", fmt.Errorf("access denied: path outside project")
	}
	data, err := os.ReadFile(absFile)
	if err != nil {
		return "", fmt.Errorf("read error: %w", err)
	}
	if len(data) > 512<<10 {
		return "", fmt.Errorf("file too large (max 512KB)")
	}
	return string(data), nil
}

// searchProjectFiles searches for files matching a glob pattern or regex content.
func searchProjectFiles(root, pattern, searchPath string, isRegex, fileOnly bool) ([]string, error) {
	searchDir := root
	if searchPath != "" {
		searchDir = filepath.Join(root, searchPath)
	}
	info, err := os.Stat(searchDir)
	if err != nil || !info.IsDir() {
		return nil, fmt.Errorf("invalid search path")
	}
	if isRegex {
		re, err := regexp.Compile(pattern)
		if err != nil {
			return nil, fmt.Errorf("invalid regex: %w", err)
		}
		var matches []string
		err = filepath.Walk(searchDir, func(path string, info os.FileInfo, walkErr error) error {
			if walkErr != nil || info.IsDir() {
				return nil
			}
			// Respect ignored dirs
			rel, _ := filepath.Rel(root, path)
			parts := strings.Split(filepath.ToSlash(rel), "/")
			for _, p := range parts[:len(parts)-1] {
				if p == ".git" || p == "node_modules" || p == "vendor" || p == ".venv" || p == "__pycache__" {
					return filepath.SkipDir
				}
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			if re.Match(data) {
				rel, _ := filepath.Rel(root, path)
				matches = append(matches, rel)
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
		return matches, nil
	}
	// Glob mode
	matches, err := filepath.Glob(filepath.Join(searchDir, pattern))
	if err != nil {
		return nil, err
	}
	var out []string
	for _, m := range matches {
		info, err := os.Stat(m)
		if err != nil || info.IsDir() {
			continue
		}
		rel, _ := filepath.Rel(root, m)
		out = append(out, rel)
	}
	return out, nil
}

// writeProjectFile writes content to a file under the project root.
func writeProjectFile(root, filePath string, content []byte) error {
	// Security: ensure file is under root (no path traversal)
	absRoot, _ := filepath.Abs(root)
	absFile, err := filepath.Abs(filepath.Join(root, filePath))
	if err != nil {
		return fmt.Errorf("invalid path")
	}
	if !strings.HasPrefix(absFile, absRoot+string(filepath.Separator)) && absFile != absRoot {
		return fmt.Errorf("access denied: path outside project")
	}
	dir := filepath.Dir(absFile)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir error: %w", err)
	}
	if err := os.WriteFile(absFile, content, 0o644); err != nil {
		return fmt.Errorf("write error: %w", err)
	}
	return nil
}

func listSessions(wsID string) ([]sessMeta, error) {
	dir := filepath.Join(wsDir(wsID), "sessions")
	_ = ensureDir(dir)
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []sessMeta
	for _, e := range ents {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		sid := strings.TrimSuffix(name, ".jsonl")
		meta := sessMeta{ID: sid, Title: "新会话"}
		// Read under the identity lock so the list never sees a half-written
		// metadata file while another request is committing an identity.
		sessIdentityMu.RLock()
		if b, err := os.ReadFile(filepath.Join(dir, sid+".meta.json")); err == nil {
			_ = json.Unmarshal(b, &meta)
		}
		sessIdentityMu.RUnlock()
		// The list now holds this snapshot; a concurrent pin can make it stale.
		// readMessages stays outside the identity lock, so the existing
		// message-lock -> identity-lock order is unchanged.
		if testAfterListSessionsMetaRead != nil {
			testAfterListSessionsMetaRead()
		}
		msgs, _ := readMessages(wsID, sid)
		meta.MsgCount = len(msgs)
		if isDefaultSessTitle(meta.Title) {
			for _, m := range msgs {
				if m.Role == "user" {
					if t := titleFromUserText(m.Content); t != "" {
						// Repair the title through the identity commit boundary so a
						// stale list snapshot cannot erase a pin committed meanwhile.
						title := t
						_ = updateSessMeta(wsID, sid, func(live *sessMeta) error {
							if isDefaultSessTitle(live.Title) {
								live.Title = title
							}
							return nil
						})
						meta.Title = t
						break
					}
				}
			}
		}
		st, _ := e.Info()
		if st != nil {
			meta.UpdatedAt = st.ModTime().UTC().Format(time.RFC3339)
		}
		out = append(out, meta)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Pinned != out[j].Pinned {
			return out[i].Pinned
		}
		return out[i].UpdatedAt > out[j].UpdatedAt
	})
	return out, nil
}

// isDefaultSessTitle 占位标题：首条用户消息到达后应被主题摘要替换。
func isDefaultSessTitle(t string) bool {
	t = strings.TrimSpace(t)
	if t == "" || t == "新会话" {
		return true
	}
	return strings.HasPrefix(t, "会话 ") && len([]rune(t)) <= 12
}

// titleFromUserText 从首条用户输入提炼侧栏主题（首行、压空白、截断）。
func titleFromUserText(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		s = strings.TrimSpace(s[:i])
	}
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) > 28 {
		return string(r[:28]) + "…"
	}
	return s
}

func sessPath(wsID, sid string) string {
	return filepath.Join(wsDir(wsID), "sessions", sid+".jsonl")
}

func sessMetaPath(wsID, sid string) string {
	return filepath.Join(wsDir(wsID), "sessions", sid+".meta.json")
}

func createSession(wsID, title string) (*sessMeta, error) {
	if _, err := loadWSMeta(wsID); err != nil {
		return nil, fmt.Errorf("workspace not found")
	}
	sid := hexID()
	now := time.Now().UTC().Format(time.RFC3339)
	m := &sessMeta{ID: sid, Title: strings.TrimSpace(title), CreatedAt: now, UpdatedAt: now}
	if m.Title == "" {
		m.Title = "新会话"
	}
	_ = ensureDir(filepath.Join(wsDir(wsID), "sessions"))
	if err := os.WriteFile(sessPath(wsID, sid), nil, 0o600); err != nil {
		return nil, err
	}
	b, _ := json.MarshalIndent(m, "", "  ")
	_ = os.WriteFile(sessMetaPath(wsID, sid), b, 0o600)
	if wm, err := loadWSMeta(wsID); err == nil {
		wm.UpdatedAt = now
		_ = saveWSMeta(wm)
	}
	return m, nil
}

func deleteSession(wsID, sid string) error {
	_ = os.Remove(sessMetaPath(wsID, sid))
	return os.Remove(sessPath(wsID, sid))
}

// loadSessMeta reads a session's metadata. It takes the identity lock for
// reading: every writer holds it for the whole load-mutate-save, so a reader can
// never observe a half-written file (a plain truncate-write would hand back
// empty or torn JSON, which surfaced as "unexpected end of JSON input" in a
// chat turn that read while another request was committing an identity).
func loadSessMeta(wsID, sid string) (*sessMeta, error) {
	sessIdentityMu.RLock()
	defer sessIdentityMu.RUnlock()
	return loadSessMetaUnlocked(wsID, sid)
}

// loadSessMetaUnlocked is loadSessMeta without the lock, for callers that
// already hold it for writing.
func loadSessMetaUnlocked(wsID, sid string) (*sessMeta, error) {
	b, err := os.ReadFile(sessMetaPath(wsID, sid))
	if err != nil {
		return nil, err
	}
	var m sessMeta
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	if m.ID == "" {
		m.ID = sid
	}
	return &m, nil
}

func saveSessMeta(wsID string, m *sessMeta) error {
	if m == nil {
		return fmt.Errorf("nil session meta")
	}
	now := time.Now().UTC().Format(time.RFC3339)
	m.UpdatedAt = now
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(sessMetaPath(wsID, m.ID), b, 0o600); err != nil {
		return err
	}
	if wm, err := loadWSMeta(wsID); err == nil {
		wm.UpdatedAt = now
		_ = saveWSMeta(wm)
	}
	return nil
}

// sessIdentityMu is the narrow commit boundary for session identity fields
// (Model / Protocol / Smart). Every whole-object sessMeta writer that can run
// concurrently with an identity pin takes it for writing around
// load-mutate-save so a stale snapshot cannot erase a pin another request just
// committed, and readers take it for reading so no one can observe a partially
// written metadata file. Network calls (resolve / providerConfig / model) stay
// outside this lock.
var sessIdentityMu sync.RWMutex

// testAfterSessMetaLoad, when set by a test, runs after the live meta is loaded
// and before mutate/save, still inside the identity lock. That is the real
// read-write race window a non-atomic candidate would leave open.
var testAfterSessMetaLoad func()

// testAfterListSessionsMetaRead, when set by a test, runs after listSessions has
// read a session's metadata and before it may repair the default title. That is
// the window in which the list holds a snapshot that a concurrent pin can make
// stale. Production leaves it nil.
var testAfterListSessionsMetaRead func()

// updateSessMeta loads the live session meta, applies mutate and saves it, all
// under sessIdentityMu. mutate may refuse the commit by returning an error.
func updateSessMeta(wsID, sid string, mutate func(*sessMeta) error) error {
	sessIdentityMu.Lock()
	defer sessIdentityMu.Unlock()
	m, err := loadSessMetaUnlocked(wsID, sid)
	if err != nil {
		return err
	}
	if m == nil {
		return fmt.Errorf("session not found: %s", sid)
	}
	if testAfterSessMetaLoad != nil {
		testAfterSessMetaLoad()
	}
	if err := mutate(m); err != nil {
		return err
	}
	return saveSessMeta(wsID, m)
}

// updateSession 更新标题 / 置顶；nil 指针表示不改该字段。
func updateSession(wsID, sid string, title *string, pinned *bool) (*sessMeta, error) {
	err := updateSessMeta(wsID, sid, func(m *sessMeta) error {
		if title != nil {
			t := strings.TrimSpace(*title)
			if t == "" {
				t = "新会话"
			}
			m.Title = t
		}
		if pinned != nil {
			m.Pinned = *pinned
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	m, err := loadSessMeta(wsID, sid)
	if err != nil {
		return nil, err
	}
	msgs, _ := readMessages(wsID, sid)
	m.MsgCount = len(msgs)
	return m, nil
}

func readMessagesUnlocked(wsID, sid string) ([]chatMsg, error) {
	f, err := os.Open(sessPath(wsID, sid))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()
	var out []chatMsg
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var m chatMsg
		if json.Unmarshal([]byte(line), &m) == nil {
			out = append(out, m)
		}
	}
	return out, sc.Err()
}

func readMessages(wsID, sid string) ([]chatMsg, error) {
	sessionMessagesMu.RLock()
	defer sessionMessagesMu.RUnlock()
	return readMessagesUnlocked(wsID, sid)
}

func appendMessageUnlocked(wsID, sid string, m *chatMsg) error {
	if m.ID == "" {
		m.ID = hexID()
	}
	if m.TS == "" {
		m.TS = time.Now().UTC().Format(time.RFC3339)
	}
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(sessPath(wsID, sid), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(append(b, '\n'))
	f.Close()
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	// Meta title/updated-at must not race an identity pin: a stale whole-object
	// write here could erase Model/Protocol/Smart committed meanwhile.
	sessIdentityMu.Lock()
	meta := sessMeta{ID: sid, UpdatedAt: now}
	if b, err := os.ReadFile(sessMetaPath(wsID, sid)); err == nil {
		_ = json.Unmarshal(b, &meta)
	}
	meta.UpdatedAt = now
	if m.Role == "user" && isDefaultSessTitle(meta.Title) {
		if t := titleFromUserText(m.Content); t != "" {
			meta.Title = t
		}
	}
	mb, _ := json.MarshalIndent(meta, "", "  ")
	_ = os.WriteFile(sessMetaPath(wsID, sid), mb, 0o600)
	sessIdentityMu.Unlock()
	if wm, err := loadWSMeta(wsID); err == nil {
		wm.UpdatedAt = now
		_ = saveWSMeta(wm)
	}
	return nil
}

func appendMessage(wsID, sid string, m *chatMsg) error {
	sessionMessagesMu.Lock()
	defer sessionMessagesMu.Unlock()
	return appendMessageUnlocked(wsID, sid, m)
}

// appendUserMessage 将可见历史长度与用户消息原子落盘，供并发请求隔离上下文。
func appendUserMessage(wsID, sid string, m *chatMsg) error {
	sessionMessagesMu.Lock()
	defer sessionMessagesMu.Unlock()
	hist, err := readMessagesUnlocked(wsID, sid)
	if err != nil {
		return err
	}
	m.ContextFrozen = true
	m.ContextSize = len(hist)
	return appendMessageUnlocked(wsID, sid, m)
}

func uploadDir(wsID, sid string) string {
	return filepath.Join(dataRoot(), "uploads", wsID, sid)
}

func saveUpload(wsID, sid, name string, data []byte) (*attachRef, error) {
	dir := uploadDir(wsID, sid)
	if err := ensureDir(dir); err != nil {
		return nil, err
	}
	id := hexID()
	safe := filepath.Base(name)
	if safe == "" || safe == "." || safe == ".." {
		safe = "file"
	}
	path := filepath.Join(dir, id+"_"+safe)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return nil, err
	}
	rel, _ := filepath.Rel(dataRoot(), path)
	mime := httpDetectMIME(safe, data)
	a := &attachRef{
		ID:   id,
		Name: safe,
		MIME: mime,
		Size: int64(len(data)),
		Path: rel,
	}
	if strings.HasPrefix(mime, "text/") || strings.HasSuffix(strings.ToLower(safe), ".md") ||
		strings.HasSuffix(strings.ToLower(safe), ".json") || strings.HasSuffix(strings.ToLower(safe), ".csv") {
		a.Text = string(data)
		if len([]rune(a.Text)) > 100000 {
			a.Text = string([]rune(a.Text)[:100000]) + "\n…(截断)"
		}
	}
	return a, nil
}

func httpDetectMIME(name string, data []byte) string {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".md", ".txt", ".log", ".csv", ".json", ".yml", ".yaml", ".toml", ".go", ".py", ".js", ".ts", ".css", ".html":
		return "text/plain"
	}
	if len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 {
		return "image/jpeg"
	}
	if len(data) >= 8 && string(data[:8]) == "\x89PNG\r\n\x1a\n" {
		return "image/png"
	}
	return "application/octet-stream"
}

func readUploadFile(rel string) ([]byte, error) {
	rel = filepath.Clean(rel)
	if strings.Contains(rel, "..") {
		return nil, fmt.Errorf("bad path")
	}
	return os.ReadFile(filepath.Join(dataRoot(), rel))
}
