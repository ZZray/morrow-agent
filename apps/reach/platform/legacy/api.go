package main

// 工作台 REST：工作区 / 会话 / 聊天 / 知识库 / 上传。

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"ara/internal/agent"
)

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (h *hubSrv) apiH(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api")
	path = strings.TrimSuffix(path, "/")
	if path == "" {
		path = "/"
	}

	switch {
	case path == "/apply/pending":
		h.apiApplyPending(w, r)

	case path == "/apply/resolve" && r.Method == http.MethodPost:
		h.apiApplyResolve(w, r)

	case path == "/model-config":
		h.apiCloudModel(w, r)

	case path == "/model-config/test":
		h.apiCloudModelTest(w, r)

	case path == "/skills/generate":
		h.apiSkillGenerate(w, r)

	case path == "/skills" || strings.HasPrefix(path, "/skills/"):
		h.apiSkills(w, r, path)

	case path == "/workspaces" && r.Method == http.MethodGet:
		list, err := listWorkspaces()
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		if list == nil {
			list = []wsMeta{}
		}
		writeJSON(w, 200, list)

	case path == "/workspaces" && r.Method == http.MethodPost:
		var body struct {
			Name string `json:"name"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body)
		m, err := createWorkspace(body.Name)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, m)

	case strings.HasPrefix(path, "/workspaces/") && strings.Count(path, "/") == 2 && r.Method == http.MethodPatch:
		id := strings.TrimPrefix(path, "/workspaces/")
		var body struct {
			Name        string `json:"name"`
			DeviceFP    string `json:"device_fp"`
			DeviceName  string `json:"device_name"`
			ProjectPath string `json:"project_path"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body)
		m, err := loadWSMeta(id)
		if err != nil {
			writeJSON(w, 404, map[string]string{"error": "not found"})
			return
		}
		if body.Name != "" {
			m.Name = body.Name
		}
		if r.URL.Query().Get("clear_device") == "1" {
			m.DeviceFP = ""
			m.DeviceName = ""
		} else if body.DeviceFP != "" {
			m.DeviceFP = body.DeviceFP
			if body.DeviceName != "" {
				m.DeviceName = body.DeviceName
			}
		} else if body.DeviceName != "" {
			m.DeviceName = body.DeviceName
		}
		if body.ProjectPath != "" {
			m.ProjectPath = body.ProjectPath
		}
		if err := saveWSMeta(m); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, m)

	case strings.HasPrefix(path, "/workspaces/") && strings.Count(path, "/") == 2 && r.Method == http.MethodDelete:
		id := strings.TrimPrefix(path, "/workspaces/")
		if err := deleteWorkspace(id); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})

	case strings.HasSuffix(path, "/sessions") && strings.HasPrefix(path, "/workspaces/") && r.Method == http.MethodGet:
		wsID := strings.TrimSuffix(strings.TrimPrefix(path, "/workspaces/"), "/sessions")
		list, err := listSessions(wsID)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		if list == nil {
			list = []sessMeta{}
		}
		writeJSON(w, 200, list)

	case strings.HasSuffix(path, "/sessions") && strings.HasPrefix(path, "/workspaces/") && r.Method == http.MethodPost:
		wsID := strings.TrimSuffix(strings.TrimPrefix(path, "/workspaces/"), "/sessions")
		var body struct {
			Title string `json:"title"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body)
		m, err := createSession(wsID, body.Title)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, m)

	case strings.HasPrefix(path, "/workspaces/") && strings.HasSuffix(path, "/files") && r.Method == http.MethodGet:
		// GET /workspaces/{wsID}/files — list project file tree
		wsID := strings.TrimSuffix(strings.TrimPrefix(path, "/workspaces/"), "/files")
		m, err := loadWSMeta(wsID)
		if err != nil {
			writeJSON(w, 404, map[string]string{"error": "workspace not found"})
			return
		}
		if m.ProjectPath == "" {
			writeJSON(w, 200, []any{})
			return
		}
		tree := listProjectTree(m.ProjectPath)
		writeJSON(w, 200, tree)

	case strings.HasPrefix(path, "/workspaces/") && strings.Contains(path, "/apply-code-confirm") && r.Method == http.MethodPost:
		// POST /workspaces/{wsID}/apply-code-confirm — apply code after user confirmation
		wsID := strings.TrimPrefix(path, "/workspaces/")
		wsID = strings.TrimSuffix(wsID, "/apply-code-confirm")
		parts := strings.Split(wsID, "/")
		wsID = parts[0]
		// Legacy route — redirect to apply/resolve
		var body struct {
			ToolCallID string `json:"tool_call_id"`
			Content    string `json:"content"`
			Reject     bool   `json:"reject"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&body)
		ResolveApply(body.ToolCallID, !body.Reject, body.Content)
		writeJSON(w, 200, map[string]any{"ok": true})

	case strings.HasPrefix(path, "/workspaces/") && strings.HasSuffix(path, "/file") && r.Method == http.MethodGet:
		// GET /workspaces/{wsID}/file?path=... — read project file content
		wsID := strings.TrimSuffix(strings.TrimPrefix(path, "/workspaces/"), "/file")
		m, err := loadWSMeta(wsID)
		if err != nil {
			writeJSON(w, 404, map[string]string{"error": "workspace not found"})
			return
		}
		if m.ProjectPath == "" {
			writeJSON(w, 400, map[string]string{"error": "no project path configured"})
			return
		}
		filePath := r.URL.Query().Get("path")
		if filePath == "" {
			writeJSON(w, 400, map[string]string{"error": "path query required"})
			return
		}
		content, err := readProjectFile(m.ProjectPath, filePath)
		if err != nil {
			writeJSON(w, 404, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]string{"content": content})

	case strings.Contains(path, "/sessions/") && strings.HasSuffix(path, "/messages") && (r.Method == http.MethodGet || r.Method == http.MethodPost):
		// /workspaces/{ws}/sessions/{sid}/messages
		rest := strings.TrimPrefix(path, "/workspaces/")
		parts := strings.Split(rest, "/")
		if len(parts) != 4 {
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodPost {
			noteSessionMessage(w, r, parts[0], parts[2])
			return
		}
		msgs, err := readMessages(parts[0], parts[2])
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		if msgs == nil {
			msgs = []chatMsg{}
		}
		writeJSON(w, 200, msgs)

	case strings.Contains(path, "/sessions/") && r.Method == http.MethodPatch:
		rest := strings.TrimPrefix(path, "/workspaces/")
		parts := strings.Split(rest, "/")
		if len(parts) != 3 || parts[1] != "sessions" {
			http.NotFound(w, r)
			return
		}
		var body struct {
			Title  *string `json:"title"`
			Pinned *bool   `json:"pinned"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body)
		if body.Title == nil && body.Pinned == nil {
			writeJSON(w, 400, map[string]string{"error": "title or pinned required"})
			return
		}
		m, err := updateSession(parts[0], parts[2], body.Title, body.Pinned)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, m)

	case strings.Contains(path, "/sessions/") && r.Method == http.MethodDelete:
		rest := strings.TrimPrefix(path, "/workspaces/")
		parts := strings.Split(rest, "/")
		if len(parts) != 3 || parts[1] != "sessions" {
			http.NotFound(w, r)
			return
		}
		if err := deleteSession(parts[0], parts[2]); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})

	case path == "/chat" && r.Method == http.MethodPost:
		h.apiChat(w, r)

	case path == "/chat/continue" && r.Method == http.MethodPost:
		h.apiChatContinue(w, r)

	case path == "/chat/clarify-reply" && r.Method == http.MethodPost:
		h.apiClarifyReply(w, r)

	case path == "/agents/run" && r.Method == http.MethodPost:
		h.apiAgentRun(w, r)

	case path == "/cloud/chat" && r.Method == http.MethodPost:
		h.apiCloudAgent(w, r)

	case path == "/agent-context" && r.Method == http.MethodPost:
		h.apiAgentContext(w, r)

	case path == "/reference-source" && r.Method == http.MethodGet:
		h.apiReferenceSource(w, r)

	case path == "/reference-sessions" && r.Method == http.MethodGet:
		h.apiReferenceSessions(w, r)

	case path == "/kb" && r.Method == http.MethodGet:
		scope := r.URL.Query().Get("scope")
		wsID := r.URL.Query().Get("ws")
		if scope == "" {
			scope = "project"
		}
		docs := listKBDocs(scope, wsID)
		if docs == nil {
			docs = []kbDoc{}
		}
		writeJSON(w, 200, docs)

	case path == "/kb" && r.Method == http.MethodPost:
		h.apiKBUpload(w, r)

	case strings.HasPrefix(path, "/kb/") && r.Method == http.MethodDelete:
		docID := strings.TrimPrefix(path, "/kb/")
		scope := r.URL.Query().Get("scope")
		wsID := r.URL.Query().Get("ws")
		if scope == "" {
			scope = "project"
		}
		if err := deleteKBDoc(scope, wsID, docID); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})

	case path == "/kb/search" && r.Method == http.MethodGet:
		q := r.URL.Query().Get("q")
		wsID := r.URL.Query().Get("ws")
		hits := searchKBScoped(wsID, q, r.URL.Query().Get("global") != "0", r.URL.Query().Get("project") != "0", 8)
		if hits == nil {
			hits = []kbHit{}
		}
		writeJSON(w, 200, hits)

	case path == "/upload" && r.Method == http.MethodPost:
		h.apiUpload(w, r)

	case path == "/models" && r.Method == http.MethodGet:
		h.apiModels(w, r)

	default:
		http.NotFound(w, r)
	}
}

// sse 写一条事件；返回 false 表示客户端已断开。
func sse(w http.ResponseWriter, flush func(), event string, v any) bool {
	b, err := json.Marshal(v)
	if err != nil {
		return false
	}
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b); err != nil {
		return false
	}
	flush()
	return true
}

func startSSE(w http.ResponseWriter) func() {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	fl, _ := w.(http.Flusher)
	return func() {
		if fl != nil {
			fl.Flush()
		}
	}
}

// streamChat 以 SSE 推送增量；结束时发 done（含 tool_calls）或 error。
func (h *hubSrv) streamChat(w http.ResponseWriter, r *http.Request, wsID, sid, turnID, model, protocol string, kbG, kbP, tools, agents, smart bool) {
	flush := startSSE(w)
	ctx := r.Context()
	done := make(chan struct{})
	var asst *chatMsg
	var turnErr error
	go func() {
		defer close(done)
		asst, turnErr = h.chatTurn(ctx, wsID, sid, turnID, model, protocol, kbG, kbP, tools, agents, smart, func(e agentEvent) {
			sse(w, flush, "trace", e)
		}, func(s string) {
			sse(w, flush, "delta", map[string]string{"text": s})
		})
	}()
	select {
	case <-done:
	case <-ctx.Done():
		log.Printf("chat stream canceled: workspace=%s session=%s turn=%s error=%T: %v", wsID, sid, turnID, ctx.Err(), ctx.Err())
		return
	}
	if turnErr != nil {
		log.Printf("chat stream failed: workspace=%s session=%s turn=%s error=%T: %v", wsID, sid, turnID, turnErr, turnErr)
		sse(w, flush, "error", map[string]string{"error": turnErr.Error()})
		return
	}
	asst.TurnID = turnID
	sse(w, flush, "done", asst)
}

func (h *hubSrv) apiChat(w http.ResponseWriter, r *http.Request) {
	var req chatReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<20)).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad json"})
		return
	}
	if req.WorkspaceID == "" || req.SessionID == "" {
		writeJSON(w, 400, map[string]string{"error": "workspace_id/session_id required"})
		return
	}
	skills, err := resolveSkills(req.Skills)
	if err != nil {
		writeSkillError(w, err)
		return
	}
	um := &chatMsg{Role: "user", Content: req.Content, Attachments: req.Attachments, Skills: skills}
	um.Native = nativeUserMessage(req.Content, req.Attachments)
	if err := appendUserMessage(req.WorkspaceID, req.SessionID, um); err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	h.streamChat(w, r, req.WorkspaceID, req.SessionID, um.ID, req.Model, req.Protocol, req.KBGlobal, req.KBProject, req.Tools, req.Agents, req.Smart)
}

// apiAgentContext 给本机 agent-loop 下发云端组装的工作区上下文（KB 摘录 + 选中 skills）。
// 复用云端对话同源口径（kbExcerpt/skillPrompt），由已鉴权的工作台请求，node 不获得任何新特权。
func (h *hubSrv) apiAgentContext(w http.ResponseWriter, r *http.Request) {
	var req chatReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad json"})
		return
	}
	if strings.TrimSpace(req.WorkspaceID) == "" {
		writeJSON(w, 400, map[string]string{"error": "workspace_id required"})
		return
	}
	skills, err := resolveSkills(req.Skills)
	if err != nil {
		writeSkillError(w, err)
		return
	}
	brief := strings.TrimSpace(kbExcerpt(req.WorkspaceID, req.Content, req.KBGlobal, req.KBProject, 6) + skillPrompt(skills))
	log.Printf("agent context assembled: workspace=%s skills=%d brief_bytes=%d", req.WorkspaceID, len(skills), len(brief))
	writeJSON(w, 200, map[string]string{"brief": brief})
}

func (h *hubSrv) apiChatContinue(w http.ResponseWriter, r *http.Request) {
	var req chatContinueReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<20)).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad json"})
		return
	}
	if req.WorkspaceID == "" || req.SessionID == "" || req.TurnID == "" {
		writeJSON(w, 400, map[string]string{"error": "workspace_id/session_id/turn_id required"})
		return
	}
	hist, err := readMessages(req.WorkspaceID, req.SessionID)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	if findUserTurn(hist, req.TurnID) < 0 {
		writeJSON(w, 404, map[string]string{"error": "chat turn not found"})
		return
	}
	for i := range req.ToolResults {
		src := &req.ToolResults[i]
		// 只信任允许的 tool 结果字段，服务器自行构造可信原生 tool message：
		// 忽略客户端传入的 Native，避免伪造 native 角色/内容。
		tr := &chatMsg{
			Role:       "tool",
			ToolCallID: src.ToolCallID,
			Name:       src.Name,
			Content:    src.Content,
			TurnID:     req.TurnID,
			Native: &agent.Message{
				Role:       "tool",
				ToolCallID: src.ToolCallID,
				ToolName:   src.Name,
				Content:    []agent.Content{{Type: "text", Text: src.Content}},
			},
		}
		if err := appendMessage(req.WorkspaceID, req.SessionID, tr); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
	}
	h.streamChat(w, r, req.WorkspaceID, req.SessionID, req.TurnID, req.Model, req.Protocol, req.KBGlobal, req.KBProject, req.Tools, req.Agents, req.Smart)
}

func (h *hubSrv) apiClarifyReply(w http.ResponseWriter, r *http.Request) {
	var req struct {
		WorkspaceID string `json:"workspace_id"`
		SessionID   string `json:"session_id"`
		TurnID      string `json:"turn_id"`
		Content     string `json:"content"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad json"})
		return
	}
	if req.WorkspaceID == "" || req.SessionID == "" || req.TurnID == "" {
		writeJSON(w, 400, map[string]string{"error": "workspace_id/session_id/turn_id required"})
		return
	}
	hist, err := readMessages(req.WorkspaceID, req.SessionID)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	if findUserTurn(hist, req.TurnID) < 0 {
		writeJSON(w, 404, map[string]string{"error": "chat turn not found"})
		return
	}
	um := &chatMsg{Role: "user", Content: req.Content, TurnID: req.TurnID}
	um.Native = nativeUserMessage(req.Content, nil)
	if err := appendMessage(req.WorkspaceID, req.SessionID, um); err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (h *hubSrv) apiKBUpload(w http.ResponseWriter, r *http.Request) {
	scope := r.URL.Query().Get("scope")
	wsID := r.URL.Query().Get("ws")
	if scope == "" {
		scope = "project"
	}
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		writeJSON(w, 400, map[string]string{"error": "multipart"})
		return
	}
	f, hdr, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "file required"})
		return
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 8<<20))
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	mime := httpDetectMIME(hdr.Filename, data)
	doc, err := addKBDoc(scope, wsID, hdr.Filename, mime, data)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, doc)
}

func (h *hubSrv) apiUpload(w http.ResponseWriter, r *http.Request) {
	wsID := r.URL.Query().Get("ws")
	sid := r.URL.Query().Get("session")
	if wsID == "" || sid == "" {
		writeJSON(w, 400, map[string]string{"error": "ws/session required"})
		return
	}
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		writeJSON(w, 400, map[string]string{"error": "multipart"})
		return
	}
	f, hdr, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "file required"})
		return
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 8<<20))
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	a, err := saveUpload(wsID, sid, hdr.Filename, data)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	if strings.HasPrefix(a.MIME, "image/") && len(data) < 2<<20 {
		a.DataURL = "data:" + a.MIME + ";base64," + base64.StdEncoding.EncodeToString(data)
	}
	writeJSON(w, 200, a)
}

func (h *hubSrv) apiModels(w http.ResponseWriter, r *http.Request) {
	if h.gw == nil {
		writeJSON(w, 200, []any{})
		return
	}
	pub := h.gw.public(r.Context())
	if pub.CatalogError != "" {
		// 目录不可用时不能把错误吞成空清单：返回安全错误，避免 UI 误以为没有模型。
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": pub.CatalogError})
		return
	}
	type m struct {
		ID        string   `json:"id"`
		OwnedBy   string   `json:"owned_by"`
		Protocols []string `json:"protocols,omitempty"`
	}
	out := make([]m, 0, len(pub.Models))
	for _, mo := range pub.Models {
		owned := "gateway"
		if len(mo.Protocols) > 0 {
			owned = strings.Join(mo.Protocols, ",")
		}
		out = append(out, m{ID: mo.ID, OwnedBy: owned, Protocols: mo.Protocols})
	}
	writeJSON(w, 200, out)
}

// apiApplyPending is an SSE endpoint that streams pending apply_code confirmations
// for a workspace. Web clients subscribe to this to receive apply confirm dialogs.
func (h *hubSrv) apiApplyPending(w http.ResponseWriter, r *http.Request) {
	wsID := r.URL.Query().Get("ws")
	if wsID == "" {
		writeJSON(w, 400, map[string]string{"error": "ws required"})
		return
	}
	flush := startSSE(w)
	sseDone := make(chan struct{})
	// Hook: when a pending apply is registered, broadcast it to this client
	hook := func(tcID string) {
		applyPendingMu.Lock()
		meta := applyPendingMeta[tcID]
		applyPendingMu.Unlock()
		if meta != nil && meta.WorkspaceID == wsID {
			_ = sse(w, flush, "apply_pending", meta)
		}
	}
	RegisterApplyPendingHook(hook)
	// Clean up hook on disconnect
	go func() {
		<-r.Context().Done()
		UnregisterApplyPendingHook(hook)
		close(sseDone)
	}()
	// Send heartbeat
	_ = sse(w, flush, "ping", map[string]string{"ts": time.Now().Format(time.RFC3339)})
	<-sseDone
}

func (h *hubSrv) apiApplyResolve(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ToolCallID  string `json:"tool_call_id"`
		WorkspaceID string `json:"workspace_id"`
		Confirm     bool   `json:"confirm"`
		Path        string `json:"path"`
		Content     string `json:"content"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid body"})
		return
	}
	if body.ToolCallID == "" {
		writeJSON(w, 400, map[string]string{"error": "tool_call_id required"})
		return
	}

	// Inline apply: no pending channel, write directly
	if strings.HasPrefix(body.ToolCallID, "inline_") {
		if !body.Confirm {
			writeJSON(w, 200, map[string]any{"ok": true, "tool_call_id": body.ToolCallID, "rejected": true})
			return
		}
		if body.Path == "" || body.Content == "" {
			writeJSON(w, 400, map[string]string{"error": "path and content required for inline apply"})
			return
		}
		// Get project root from workspace
		ws, err := loadWSMeta(body.WorkspaceID)
		if err != nil || ws.ProjectPath == "" {
			writeJSON(w, 400, map[string]string{"error": "no project path configured for workspace"})
			return
		}
		if err := writeProjectFile(ws.ProjectPath, body.Path, []byte(body.Content)); err != nil {
			writeJSON(w, 500, map[string]string{"error": "write failed: " + err.Error()})
			return
		}
		log.Printf("inline apply: path=%s workspace=%s", body.Path, body.WorkspaceID)
		writeJSON(w, 200, map[string]any{"ok": true, "tool_call_id": body.ToolCallID})
		return
	}

	ResolveApply(body.ToolCallID, body.Confirm, "")
	log.Printf("apply resolve: tool_call_id=%s confirm=%v", body.ToolCallID, body.Confirm)
	writeJSON(w, 200, map[string]any{"ok": true, "tool_call_id": body.ToolCallID})
}

func noteSessionMessage(w http.ResponseWriter, r *http.Request, wsID, sid string) {
	var body struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad json"})
		return
	}
	body.Role = strings.TrimSpace(body.Role)
	body.Content = strings.TrimSpace(body.Content)
	switch body.Role {
	case "user", "assistant", "system":
	default:
		writeJSON(w, 400, map[string]string{"error": "role must be user, assistant, or system"})
		return
	}
	if body.Content == "" {
		writeJSON(w, 400, map[string]string{"error": "content required"})
		return
	}
	note := &chatMsg{Role: body.Role, Content: body.Content}
	note.Native = &agent.Message{Role: body.Role, Content: []agent.Content{{Type: "text", Text: body.Content}}}
	if err := appendMessage(wsID, sid, note); err != nil {
		log.Printf("note message failed: ws=%s sid=%s err=%v", wsID, sid, err)
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("note message: ws=%s sid=%s role=%s bytes=%d", wsID, sid, body.Role, len(body.Content))
	writeJSON(w, 200, map[string]bool{"ok": true})
}
