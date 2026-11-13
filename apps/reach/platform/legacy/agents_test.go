package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func toolNames(defs []map[string]any) map[string]bool {
	out := map[string]bool{}
	for _, def := range defs {
		fn, _ := def["function"].(map[string]any)
		name, _ := fn["name"].(string)
		out[name] = true
	}
	return out
}

func TestChatToolsExposeOnlyEnabledCapabilities(t *testing.T) {
	cases := []struct {
		remote, agents, cloudAgent bool
		want                      []string
	}{
		{false, false, false, nil},
		{true, false, false, []string{"exec", "read_file", "write_file"}},
		{false, true, false, []string{"delegate_agent"}},
		{true, true, false, []string{"exec", "read_file", "write_file", "delegate_agent", "run_node_task"}},
		{false, false, true, []string{"search_codebase", "read_file", "apply_code"}},
		{true, true, true, []string{"exec", "read_file", "write_file", "search_codebase", "apply_code", "delegate_agent", "run_node_task"}},
	}
	for _, tc := range cases {
		got := toolNames(chatTools(tc.remote, tc.agents, tc.cloudAgent))
		if len(got) != len(tc.want) {
			t.Fatalf("tools(%t,%t,%t) = %#v", tc.remote, tc.agents, tc.cloudAgent, got)
		}
		for _, name := range tc.want {
			if !got[name] {
				t.Fatalf("tools(%t,%t,%t) missing %s", tc.remote, tc.agents, tc.cloudAgent, name)
			}
		}
	}
}

func TestValidateAgentTask(t *testing.T) {
	valid := &agentTask{ID: "task", Steps: []agentStep{{Kind: "exec", Title: "Check", Cmd: "true"}, {Kind: "read_file", Path: "file.txt"}}}
	if err := validateAgentTask(valid); err != nil {
		t.Fatal(err)
	}
	if valid.Steps[0].ID != "step-1" || valid.Steps[1].Title != "Step 2" {
		t.Fatalf("defaults not applied: %#v", valid.Steps)
	}
	for _, task := range []*agentTask{
		nil,
		{ID: "task"},
		{ID: "task", Steps: []agentStep{{Kind: "exec"}}},
		{ID: "task", Steps: []agentStep{{Kind: "read_file"}}},
		{ID: "task", Steps: []agentStep{{Kind: "unknown", Title: "x"}}},
	} {
		if err := validateAgentTask(task); err == nil {
			t.Fatalf("accepted invalid task: %#v", task)
		}
	}
}

func TestNodeAgentReadWriteStepsAndOutputLimit(t *testing.T) {
	dir := t.TempDir()
	a := &nodeAgent{}
	path := filepath.Join(dir, "nested", "result.txt")
	write := agentStep{Kind: "write_file", Path: path, Content: "hello"}
	out, code, errMsg := a.runAgentStep(context.Background(), nil, "task", write, func([]byte) {})
	if code != 0 || errMsg != "" || !strings.Contains(out, "written") {
		t.Fatalf("write = %q, %d, %q", out, code, errMsg)
	}
	read := agentStep{Kind: "read_file", Path: path}
	var streamed bytes.Buffer
	out, code, errMsg = a.runAgentStep(context.Background(), nil, "task", read, func(raw []byte) { streamed.Write(raw) })
	if out != "hello" || streamed.String() != "hello" || code != 0 || errMsg != "" {
		t.Fatalf("read = %q/%q, %d, %q", out, streamed.String(), code, errMsg)
	}
	large := filepath.Join(dir, "large.txt")
	if err := os.WriteFile(large, bytes.Repeat([]byte("x"), maxNodeAgentStepOutput+100), 0o600); err != nil {
		t.Fatal(err)
	}
	var maxChunkSeen int
	out, code, errMsg = a.runAgentStep(context.Background(), nil, "task", agentStep{Kind: "read_file", Path: large}, func(raw []byte) {
		if len(raw) > maxChunkSeen {
			maxChunkSeen = len(raw)
		}
	})
	if len(out) != maxNodeAgentStepOutput || maxChunkSeen > maxChunk || code != 0 || errMsg != "" {
		t.Fatalf("large read len=%d maxChunk=%d code=%d err=%q", len(out), maxChunkSeen, code, errMsg)
	}
}

func TestNodeAgentExecCancellation(t *testing.T) {
	a := &nodeAgent{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	_, errMsg := a.execCommand(ctx, nil, "cancel-test", longRunningCommand(), "", 30, "", func([]byte) {})
	if errMsg != "canceled" {
		t.Fatalf("cancel err = %q", errMsg)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("cancellation took %s", time.Since(start))
	}
}

func longRunningCommand() string {
	if os.PathSeparator == '\\' {
		return "ping -n 30 127.0.0.1 >nul"
	}
	return "sleep 30"
}

func TestAgentRunDoesNotExposeRecursiveTools(t *testing.T) {
	skillTestConf(t)
	ws, sid := skillTestSession(t)
	user := &chatMsg{Role: "user", Content: "parent"}
	if err := appendUserMessage(ws, sid, user); err != nil {
		t.Fatal(err)
	}
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	f.ChatText = "delegate result"
	h := &hubSrv{token: "tk", dev: true, gw: f.Store}
	w := skillTestRequest(t, http.HandlerFunc(h.apiH), http.MethodPost, "/api/agents/run", agentRunReq{
		WorkspaceID: ws, SessionID: sid, TurnID: user.ID, AgentID: "delegate-1", Name: "Researcher", Role: "researcher", Task: "check one thing",
	})
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "event: trace") || !strings.Contains(w.Body.String(), "delegate result") {
		t.Fatalf("agent response = %d %s", w.Code, w.Body.String())
	}
	bodies := f.chatBodies()
	if len(bodies) != 1 {
		t.Fatalf("delegate model calls = %d", len(bodies))
	}
	var request struct {
		Messages []map[string]any `json:"messages"`
		Tools    json.RawMessage  `json:"tools"`
	}
	if err := json.Unmarshal(bodies[0], &request); err != nil {
		t.Fatal(err)
	}
	if len(request.Tools) != 0 {
		t.Fatalf("delegate received recursive tools: %s", request.Tools)
	}
	prompt := messagesText(request.Messages)
	if !strings.Contains(prompt, "cannot delegate") || !strings.Contains(prompt, "focused researcher subagent") {
		t.Fatalf("missing delegate boundary: %q", prompt)
	}
}
