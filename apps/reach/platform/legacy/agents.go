package main

// 轻量 Agent 协作：Hub 负责模型委派，Node 负责受控的多步骤任务执行。

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"ara/internal/agent"
)

const (
	maxAgentTaskLen  = 12 << 10
	maxAgentNameLen  = 80
	maxAgentSteps    = 8
	maxNodeTaskFrame = 48 << 10
)

type agentStep struct {
	ID      string `json:"id,omitempty"`
	Kind    string `json:"kind"` // exec | read_file | write_file
	Title   string `json:"title,omitempty"`
	Cmd     string `json:"cmd,omitempty"`
	Cwd     string `json:"cwd,omitempty"`
	Path    string `json:"path,omitempty"`
	Content string `json:"content,omitempty"`
	Timeout int    `json:"timeout,omitempty"`
}

// agentEvent 是 node/hub → web 看板的稳定事件契约（agent-event 帧 / SSE 载荷）。
// 换 Agent 内核或换 UI 实现时必须保持兼容；web 侧依赖的语义：
//   - type：agent_start|text|text_delta|tool_start|tool_end|task_update|steer|compact|retry|
//     bash_start|bash_end|ui_request|agent_end 等（展示名见 web agentEventLabel）。
//   - step_id：任务板行对齐键（task_update 时即任务 id）；output：展示文本；detail：状态/错误。
//   - status：queued|running|completed|failed|canceled；ts：RFC3339Nano UTC。
// 演进规则：字段只可追加（均 omitempty），不得改名或改义，保证旧前端仍可解析。
type agentEvent struct {
	ID        string `json:"id,omitempty"`
	TS        string `json:"ts"`
	Type      string `json:"type"`
	Status    string `json:"status,omitempty"`
	AgentID   string `json:"agent_id,omitempty"`
	AgentName string `json:"agent_name,omitempty"`
	AgentRole string `json:"agent_role,omitempty"`
	TaskID    string `json:"task_id,omitempty"`
	StepID    string `json:"step_id,omitempty"`
	Index     int    `json:"index,omitempty"`
	Total     int    `json:"total,omitempty"`
	Title     string `json:"title,omitempty"`
	Detail    string `json:"detail,omitempty"`
	Output    string `json:"output,omitempty"`
	Code      int    `json:"code,omitempty"`
}

func newAgentEvent(kind, status, agentID, name, role, title, detail string) agentEvent {
	return agentEvent{
		ID: hexID(), TS: time.Now().UTC().Format(time.RFC3339Nano), Type: kind, Status: status,
		AgentID: agentID, AgentName: name, AgentRole: role, Title: title, Detail: detail,
	}
}

var delegateAgentTool = map[string]any{
	"type": "function",
	"function": map[string]any{
		"name":        "delegate_agent",
		"description": "Delegate one focused analysis task to an isolated lightweight subagent. Use only when an independent perspective materially helps; at most three delegates per round.",
		"parameters": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"name": map[string]any{"type": "string", "description": "Short human-readable agent name"},
				"role": map[string]any{"type": "string", "enum": []string{"researcher", "planner", "reviewer"}},
				"task": map[string]any{"type": "string", "description": "Narrow assignment and expected result"},
			},
			"required": []string{"name", "role", "task"},
		},
	},
}

var nodeTaskTool = map[string]any{
	"type": "function",
	"function": map[string]any{
		"name":        "run_node_task",
		"description": "Assign an ordered multi-step task to the connected Node agent. Prefer direct tools for a single operation and this tool for two to eight related local steps.",
		"parameters": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"name":      map[string]any{"type": "string", "description": "Short human-readable agent name"},
				"role":      map[string]any{"type": "string", "enum": []string{"investigator", "operator", "builder", "reviewer"}},
				"objective": map[string]any{"type": "string"},
				"steps": map[string]any{
					"type":     "array",
					"minItems": 1,
					"maxItems": maxAgentSteps,
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"id":      map[string]any{"type": "string"},
							"kind":    map[string]any{"type": "string", "enum": []string{"exec", "read_file", "write_file"}},
							"title":   map[string]any{"type": "string"},
							"cmd":     map[string]any{"type": "string"},
							"cwd":     map[string]any{"type": "string"},
							"path":    map[string]any{"type": "string"},
							"content": map[string]any{"type": "string"},
							"timeout": map[string]any{"type": "integer", "minimum": 1, "maximum": 600},
						},
						"required": []string{"kind", "title"},
					},
				},
			},
			"required": []string{"name", "role", "objective", "steps"},
		},
	},
}

// chatTools returns the tool list for Hub/Node chat mode.
// remote: include exec/read/write (Node tools)
// agents: include delegate/node-task (agent coordination)
// cloudAgent: include search/read/apply (local project tools for cloud mode)
func chatTools(remote, agents, cloudAgent bool) []map[string]any {
	tools := make([]map[string]any, 0, len(defaultTools)+3)
	// Remote tools. When cloud project tools are on, drop node read_file so the
	// model sees one read_file (the workspace one). Node files stay on run_node_task.
	if remote {
		for _, t := range defaultTools {
			if cloudAgent && toolDefName(t) == "read_file" {
				continue
			}
			tools = append(tools, t)
		}
	}
	if cloudAgent {
		tools = append(tools, cloudProjectTools()...)
	}
	// Agent coordination tools (delegate_agent, run_node_task) when agents are enabled
	// These work with or without Node; run_node_task degrades gracefully if no Node
	if agents {
		tools = append(tools, delegateAgentTool)
		if remote {
			tools = append(tools, nodeTaskTool)
		}
	}
	return tools
}

func toolDefName(def map[string]any) string {
	fn, _ := def["function"].(map[string]any)
	name, _ := fn["name"].(string)
	return name
}

func hubExecutesTool(name string) bool {
	switch name {
	case "search_codebase", "read_file", "apply_code", "exec":
		return true
	default:
		return false
	}
}

// cloudProjectTools returns search/read/apply tools for cloud agent mode.
// These tools operate on the local project directory.
func cloudProjectTools() []map[string]any {
	return []map[string]any{
		{
			"type": "function",
			"function": map[string]any{
				"name":        "search_codebase",
				"description": "Search files and content in the workspace project. Use glob patterns (e.g. '**/*.go') for file search, or content search with is_regex=true.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"pattern":   map[string]any{"type": "string", "description": "Glob pattern (e.g. '**/*.ts') or regex for content search"},
						"path":      map[string]any{"type": "string", "description": "Directory to search within (defaults to project root)"},
						"is_regex":  map[string]any{"type": "boolean", "description": "If true, pattern is a regex; otherwise glob"},
						"file_only": map[string]any{"type": "boolean", "description": "If true, only return file names"},
					},
					"required": []string{"pattern"},
				},
			},
		},
		{
			"type": "function",
			"function": map[string]any{
				"name":        "read_file",
				"description": "Read file content. For large files (>1000 lines) use start_line and end_line.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"path":       map[string]any{"type": "string"},
						"start_line": map[string]any{"type": "integer"},
						"end_line":   map[string]any{"type": "integer"},
					},
					"required": []string{"path"},
				},
			},
		},
		{
			"type": "function",
			"function": map[string]any{
				"name":        "apply_code",
				"description": "Write or overwrite a file with new content. Always read the existing file first. The change will be sent for user confirmation.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"path":    map[string]any{"type": "string"},
						"content": map[string]any{"type": "string"},
						"reason":  map[string]any{"type": "string", "description": "Brief explanation of the change"},
					},
					"required": []string{"path", "content"},
				},
			},
		},
	}
}

func agentCoordinationPrompt(remote bool) string {
	var b strings.Builder
	b.WriteString("\n## Lightweight agent coordination\n")
	b.WriteString("You are the coordinator. Keep trivial work in this turn. For substantial work, delegate up to three narrow independent analysis tasks with delegate_agent, then synthesize their tool results. Give each delegate a short descriptive name. ")
	if remote {
		b.WriteString("For two to eight related operations on the connected machine, use run_node_task so the Node can own progress, cancellation, and cleanup. Use exec/read_file/write_file for a single operation. ")
	}
	b.WriteString("Do not recursively delegate, invent completed work, or expose hidden chain-of-thought. Report observable actions, results, and concise rationale only.\n")
	return b.String()
}

type agentRunReq struct {
	WorkspaceID string `json:"workspace_id"`
	SessionID   string `json:"session_id"`
	TurnID      string `json:"turn_id"`
	AgentID     string `json:"agent_id"`
	Name        string `json:"name"`
	Role        string `json:"role"`
	Task        string `json:"task"`
	Model       string `json:"model"`
	Protocol    string `json:"protocol"`
	KBGlobal    bool   `json:"kb_global"`
	KBProject   bool   `json:"kb_project"`
}

type agentRunResult struct {
	AgentID string       `json:"agent_id"`
	Name    string       `json:"name"`
	Role    string       `json:"role"`
	Content string       `json:"content"`
	Events  []agentEvent `json:"events,omitempty"`
}

func cleanAgentLabel(s, fallback string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return fallback
	}
	r := []rune(s)
	if len(r) > maxAgentNameLen {
		s = string(r[:maxAgentNameLen])
	}
	return s
}

func validDelegateRole(role string) bool {
	switch role {
	case "researcher", "planner", "reviewer":
		return true
	default:
		return false
	}
}

// apiAgentRun 执行一次隔离、无工具递归的轻量 subagent 调用，并以 SSE 暴露过程。
func (h *hubSrv) apiAgentRun(w http.ResponseWriter, r *http.Request) {
	var req agentRunReq
	if err := json.NewDecoder(io.LimitReader(r.Body, maxAgentTaskLen+16<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad json"})
		return
	}
	req.AgentID = cleanAgentLabel(req.AgentID, hexID())
	req.Name = cleanAgentLabel(req.Name, "Delegate")
	req.Role = strings.TrimSpace(req.Role)
	req.Task = strings.TrimSpace(req.Task)
	if req.WorkspaceID == "" || req.SessionID == "" || req.TurnID == "" || req.Task == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "workspace_id/session_id/turn_id/task required"})
		return
	}
	if len(req.Task) > maxAgentTaskLen {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "agent task too large"})
		return
	}
	if !validDelegateRole(req.Role) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid agent role"})
		return
	}
	hist, err := readMessages(req.WorkspaceID, req.SessionID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	turnIndex := findUserTurn(hist, req.TurnID)
	if turnIndex < 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "chat turn not found"})
		return
	}
	parent := hist[turnIndex]
	if req.Model == "" {
		req.Model = "default"
	}
	flush := startSSE(w)
	events := make([]agentEvent, 0, 3)
	emit := func(e agentEvent) {
		events = append(events, e)
		_ = sse(w, flush, "trace", e)
	}
	start := newAgentEvent("agent_start", "running", req.AgentID, req.Name, req.Role, "Delegate started", req.Task)
	emit(start)
	log.Printf("agent delegate start: workspace=%s session=%s turn=%s agent=%s role=%s task_bytes=%d", req.WorkspaceID, req.SessionID, req.TurnID, req.AgentID, req.Role, len(req.Task))

	sys := h.buildSystemPrompt(req.WorkspaceID, parent.Content, req.KBGlobal, req.KBProject) + skillPrompt(parent.Skills)
	sys += fmt.Sprintf("\nYou are %s, a focused %s subagent. Work only on the assigned task. You have no tools and cannot delegate. Return concise findings with evidence, assumptions, and unresolved risks. Do not claim actions you did not perform.\n", req.Name, req.Role)
	modelEvent := newAgentEvent("model_request", "running", req.AgentID, req.Name, req.Role, "Model request", fmt.Sprintf("model=%s", req.Model))
	emit(modelEvent)
	var content string
	pc, _, err := h.gw.providerConfig(r.Context(), req.Model, req.Protocol)
	if err == nil {
		var resp agent.Response
		resp, err = complete(r.Context(), pc, agent.Request{
			Model:    pc.Model,
			System:   sys,
			Messages: []agent.Message{agent.TextMessage("user", "Parent request:\n" + parent.Content + "\n\nAssigned task:\n" + req.Task)},
		}, func(e agent.Event) {
			if e.Type == "text_delta" {
				_ = sse(w, flush, "agent_delta", map[string]string{"agent_id": req.AgentID, "text": e.Text})
			}
		})
		if err == nil {
			content = resp.Message.Text()
		}
	}
	if err != nil {
		failed := newAgentEvent("agent_finish", "failed", req.AgentID, req.Name, req.Role, "Delegate failed", err.Error())
		emit(failed)
		log.Printf("agent delegate failed: workspace=%s session=%s turn=%s agent=%s error=%T: %v", req.WorkspaceID, req.SessionID, req.TurnID, req.AgentID, err, err)
		_ = sse(w, flush, "error", map[string]string{"error": err.Error(), "agent_id": req.AgentID})
		return
	}
	finished := newAgentEvent("agent_finish", "completed", req.AgentID, req.Name, req.Role, "Delegate completed", fmt.Sprintf("result_bytes=%d", len(content)))
	emit(finished)
	log.Printf("agent delegate finish: workspace=%s session=%s turn=%s agent=%s result_bytes=%d", req.WorkspaceID, req.SessionID, req.TurnID, req.AgentID, len(content))
	_ = sse(w, flush, "done", agentRunResult{AgentID: req.AgentID, Name: req.Name, Role: req.Role, Content: content, Events: events})
}

// CloudAgentReq — standalone cloud agent (Codex-style) request.
type cloudAgentReq struct {
	WorkspaceID string   `json:"workspace_id"`
	SessionID   string   `json:"session_id"`
	Content     string   `json:"content"`
	Model       string   `json:"model"`
	Protocol    string   `json:"protocol"`
	Attachments []any    `json:"attachments,omitempty"`
}

// CloudAgentReqContinue — continue cloud agent with tool results.
type cloudAgentReqContinue struct {
	TurnID      string   `json:"turn_id"`
	SessionID   string   `json:"session_id"`
	Model       string   `json:"model"`
	Protocol    string   `json:"protocol"`
	ToolResults []any    `json:"tool_results"`
}

// buildCloudSystemPrompt returns the system prompt for cloud agent mode.
func buildCloudSystemPrompt(wsID string) string {
	var b strings.Builder
	b.WriteString("You are an expert AI coding assistant, similar to GitHub Copilot or OpenAI Codex. ")
	b.WriteString("You help users write, review, and refactor code in their workspace. ")
	b.WriteString("You have access to search, read, and modify files in the workspace. ")
	b.WriteString("Always be precise, helpful, and concise. Provide code with proper formatting. ")
	b.WriteString("When making file changes, explain what you changed and why.\n")
	b.WriteString("## Workspace\n")
	b.WriteString("The workspace is a project directory accessible via the search_codebase, read_file, and apply_code tools.\n")
	return b.String()
}

// apiCloudAgent is the SSE endpoint for standalone cloud agent mode.
// Runs synchronously with a cancellable context.
func (h *hubSrv) apiCloudAgent(w http.ResponseWriter, r *http.Request) {
	flush := startSSE(w)
	ctx := r.Context()

	var req cloudAgentReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<20)).Decode(&req); err != nil {
		_ = sse(w, flush, "error", map[string]string{"error": "bad json"})
		return
	}
	if req.WorkspaceID == "" || req.SessionID == "" {
		_ = sse(w, flush, "error", map[string]string{"error": "workspace_id/session_id required"})
		return
	}
	if req.Content == "" && len(req.Attachments) == 0 {
		_ = sse(w, flush, "error", map[string]string{"error": "content required"})
		return
	}

	// Build messages — standalone context, no Hub history
	sys := buildCloudSystemPrompt(req.WorkspaceID)
	var messages []agent.Message
	if req.Content != "" {
		messages = append(messages, agent.TextMessage("user", req.Content))
	}

	pc, _, err := h.gw.providerConfig(ctx, req.Model, req.Protocol)
	if err != nil {
		log.Printf("cloud agent error: %v", err)
		_ = sse(w, flush, "error", map[string]string{"error": err.Error()})
		return
	}
	_ = sse(w, flush, "trace", map[string]string{"type": "model_request", "status": "running", "detail": "model=" + pc.Model})

	resp, err := complete(ctx, pc, agent.Request{Model: pc.Model, System: sys, Messages: messages, Tools: toolSpecs(cloudProjectTools())}, func(e agent.Event) {
		if e.Type == "text_delta" {
			_ = sse(w, flush, "delta", map[string]string{"text": e.Text})
		}
	})
	if err != nil {
		log.Printf("cloud agent error: %v", err)
		_ = sse(w, flush, "error", map[string]string{"error": err.Error()})
		return
	}
	content := resp.Message.Text()
	toolCalls := toolCallsFromMessage(resp.Message)
	_ = sse(w, flush, "trace", map[string]string{"type": "model_response", "status": "completed", "detail": fmt.Sprintf("tool_calls=%d", len(toolCalls))})
	_ = sse(w, flush, "done", map[string]any{"content": content, "tool_calls": toolCalls})
}
