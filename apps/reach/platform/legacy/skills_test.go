package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func skillTestConf(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HW_CONF", dir)
	if got := confDir(); got != dir {
		t.Fatalf("confDir() = %q, want %q", got, dir)
	}
	return dir
}

func skillTestCreate(t *testing.T, name, content string) *skillSnapshot {
	t.Helper()
	s, err := createSkill(name, "description", content)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func skillTestRequest(t *testing.T, handler http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var raw []byte
	var err error
	if body != nil {
		raw, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(raw))
	r.Header.Set("Authorization", "Bearer test-root")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func skillTestSession(t *testing.T) (string, string) {
	t.Helper()
	ws, err := createWorkspace("test")
	if err != nil {
		t.Fatal(err)
	}
	sess, err := createSession(ws.ID, "test")
	if err != nil {
		t.Fatal(err)
	}
	return ws.ID, sess.ID
}

func TestSkillsCRUDPersistence(t *testing.T) {
	dir := skillTestConf(t)
	list, err := listSkills()
	if err != nil || list == nil || len(list) != 0 {
		t.Fatalf("empty list = %#v, %v", list, err)
	}
	content := "# Review\n\n  Keep Markdown whitespace.\n"
	s := skillTestCreate(t, " Review ", content)
	if !validSkillID(s.ID) || s.Name != "Review" {
		t.Fatalf("unexpected skill: %#v", s)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "data", "skills", s.ID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var persisted skillSnapshot
	if err := json.Unmarshal(raw, &persisted); err != nil || !reflect.DeepEqual(persisted, *s) {
		t.Fatalf("persisted = %#v, %v", persisted, err)
	}
	resolved, err := resolveSkills([]string{s.ID})
	if err != nil || len(resolved) != 1 || !reflect.DeepEqual(resolved[0], *s) {
		t.Fatalf("resolved = %#v, %v", resolved, err)
	}
	other := skillTestCreate(t, "Review", content)
	if other.ID == s.ID {
		t.Fatal("duplicate random ID")
	}
	list, err = listSkills()
	if err != nil || len(list) != 2 {
		t.Fatalf("list = %#v, %v", list, err)
	}
	for _, id := range []string{s.ID, other.ID} {
		if err := deleteSkill(id); err != nil {
			t.Fatal(err)
		}
		if _, err := resolveSkills([]string{id}); !errors.Is(err, errSkillNotFound) {
			t.Fatalf("deleted skill resolved: %v", err)
		}
		if err := deleteSkill(id); !errors.Is(err, errSkillNotFound) {
			t.Fatalf("second delete = %v", err)
		}
	}
	list, err = listSkills()
	if err != nil || list == nil || len(list) != 0 {
		t.Fatalf("deleted list = %#v, %v", list, err)
	}
}

func TestSkillsInvalidIDs(t *testing.T) {
	skillTestConf(t)
	ids := []string{"", ".", "..", "../outside", `..\outside`, "/tmp/skill", `C:\skill`, "%2e%2e", strings.Repeat("a", 31), strings.Repeat("a", 33), strings.Repeat("A", 32), strings.Repeat("g", 32), strings.Repeat("a", 30) + ":x", strings.Repeat("a", 31) + "\x00"}
	for _, id := range ids {
		t.Run(id, func(t *testing.T) {
			if validSkillID(id) {
				t.Fatal("accepted invalid ID")
			}
			if _, err := resolveSkills([]string{id}); !errors.Is(err, errSkillInvalid) {
				t.Fatalf("resolve = %v", err)
			}
			if err := deleteSkill(id); !errors.Is(err, errSkillInvalid) {
				t.Fatalf("delete = %v", err)
			}
		})
	}
}

func TestSkillsLimits(t *testing.T) {
	skillTestConf(t)
	cases := []struct {
		name, description, content string
		want                       error
	}{
		{" ", "", "body", errSkillInvalid},
		{"name", "", "\n\t", errSkillInvalid},
		{strings.Repeat("n", maxSkillName+1), "", "body", errSkillTooLarge},
		{"name", strings.Repeat("d", maxSkillDescription+1), "body", errSkillTooLarge},
		{"name", "", strings.Repeat("b", maxSkillContent+1), errSkillTooLarge},
		{"name", "", string([]byte{0xff}), errSkillInvalid},
	}
	for i, tc := range cases {
		if _, err := createSkill(tc.name, tc.description, tc.content); !errors.Is(err, tc.want) {
			t.Fatalf("case %d = %v, want %v", i, err, tc.want)
		}
	}
	list, err := listSkills()
	if err != nil || len(list) != 0 {
		t.Fatalf("invalid skills persisted: %#v, %v", list, err)
	}
	s, err := createSkill(strings.Repeat("n", maxSkillName), strings.Repeat("d", maxSkillDescription), strings.Repeat("x", maxSkillContent))
	if err != nil {
		t.Fatal(err)
	}
	second := skillTestCreate(t, "second", strings.Repeat("y", maxSkillContent))
	third := skillTestCreate(t, "third", "z")
	if _, err := resolveSkills([]string{s.ID, second.ID}); err != nil {
		t.Fatalf("exact total limit rejected: %v", err)
	}
	if _, err := resolveSkills([]string{s.ID, second.ID, third.ID}); !errors.Is(err, errSkillTooLarge) {
		t.Fatalf("total content limit = %v", err)
	}
	if _, err := resolveSkills([]string{s.ID, s.ID}); !errors.Is(err, errSkillInvalid) {
		t.Fatalf("duplicate IDs = %v", err)
	}
	var ids []string
	for i := 0; i < maxSelectedSkills; i++ {
		ids = append(ids, skillTestCreate(t, "small", "body").ID)
	}
	if _, err := resolveSkills(ids); err != nil {
		t.Fatalf("eight skills rejected: %v", err)
	}
	if _, err := resolveSkills(append(ids, third.ID)); !errors.Is(err, errSkillTooLarge) {
		t.Fatalf("selection count limit = %v", err)
	}
}

func TestSkillsAPI(t *testing.T) {
	skillTestConf(t)
	h := &hubSrv{token: "test-root", nodeTok: "test-node"}
	mux := http.NewServeMux()
	h.routes(mux)
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
		path := "/api/skills"
		if method == http.MethodDelete {
			path += "/" + strings.Repeat("a", 32)
		}
		for _, token := range []string{"", "test-node"} {
			r := httptest.NewRequest(method, path, nil)
			if token != "" {
				r.Header.Set("Authorization", "Bearer "+token)
			}
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("unauthenticated %s = %d", method, w.Code)
			}
		}
	}
	w := skillTestRequest(t, mux, "GET", "/api/skills", nil)
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatalf("empty API = %d %s", w.Code, w.Body.String())
	}
	w = skillTestRequest(t, mux, "POST", "/api/skills", map[string]string{"name": "Review", "description": "desc", "content": "# Instructions"})
	var meta skillMeta
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &meta) != nil || !validSkillID(meta.ID) {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}
	w = skillTestRequest(t, mux, "GET", "/api/skills/", nil)
	var list []map[string]string
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &list) != nil || len(list) != 1 || len(list[0]) != 3 || list[0]["id"] != meta.ID || list[0]["name"] != "Review" || list[0]["description"] != "desc" {
		t.Fatalf("metadata list = %d %s", w.Code, w.Body.String())
	}
	for _, tc := range []struct {
		method, path string
		code         int
	}{
		{"PUT", "/api/skills", 405},
		{"POST", "/api/skills/" + meta.ID, 405},
		{"DELETE", "/api/skills/not-an-id", 400},
		{"DELETE", "/api/skills/%2e%2e%2foutside", 400},
		{"DELETE", "/api/skills/" + strings.Repeat("0", 32), 404},
		{"DELETE", "/api/skills/" + meta.ID, 200},
		{"DELETE", "/api/skills/" + meta.ID, 404},
	} {
		w = skillTestRequest(t, mux, tc.method, tc.path, nil)
		if w.Code != tc.code {
			t.Fatalf("%s %s = %d %s, want %d", tc.method, tc.path, w.Code, w.Body.String(), tc.code)
		}
	}
	w = skillTestRequest(t, mux, "GET", "/api/skills", nil)
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatalf("deleted API list = %d %s", w.Code, w.Body.String())
	}
}

func TestSkillsAPIBadBodies(t *testing.T) {
	skillTestConf(t)
	h := &hubSrv{}
	for _, tc := range []struct {
		body string
		code int
	}{
		{"", 400}, {"null", 400}, {"{}", 400}, {"[]", 400}, {"{", 400},
		{`{"name":"n","content":"c"} {}`, 400},
		{`{"name":1,"content":"c"}`, 400},
		{`{"name":"n","content":"` + strings.Repeat("x", maxSkillContent+1) + `"}`, 413},
		{`{"name":"` + strings.Repeat("n", maxSkillName+1) + `","content":"c"}`, 413},
		{`{"name":"n","description":"` + strings.Repeat("d", maxSkillDescription+1) + `","content":"c"}`, 413},
		{`{"name":"n","content":"c"}` + strings.Repeat(" ", maxSkillJSON), 413},
	} {
		w := httptest.NewRecorder()
		h.apiH(w, httptest.NewRequest("POST", "/api/skills", strings.NewReader(tc.body)))
		if w.Code != tc.code {
			t.Fatalf("body length %d = %d %s, want %d", len(tc.body), w.Code, w.Body.String(), tc.code)
		}
	}
	list, err := listSkills()
	if err != nil || len(list) != 0 {
		t.Fatalf("bad bodies persisted: %#v, %v", list, err)
	}
	w := skillTestRequest(t, http.HandlerFunc(h.apiH), "POST", "/api/skills", map[string]string{"name": "escaped", "content": strings.Repeat("<", maxSkillContent)})
	if w.Code != 201 {
		t.Fatalf("valid escaped Markdown rejected: %d %s", w.Code, w.Body.String())
	}
}

func TestSkillsGetAndUpdate(t *testing.T) {
	skillTestConf(t)
	h := &hubSrv{}
	handler := http.HandlerFunc(h.apiH)
	s := skillTestCreate(t, "original", "ORIGINAL")

	// GET returns the full snapshot (meta + content).
	w := skillTestRequest(t, handler, "GET", "/api/skills/"+s.ID, nil)
	var got skillSnapshot
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &got) != nil || !reflect.DeepEqual(got, *s) {
		t.Fatalf("get = %d %s", w.Code, w.Body.String())
	}

	// PUT replaces name/description/content and preserves the ID.
	w = skillTestRequest(t, handler, "PUT", "/api/skills/"+s.ID, map[string]string{"name": " updated ", "description": "new desc", "content": "UPDATED\nBODY"})
	var updated skillSnapshot
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &updated) != nil {
		t.Fatalf("update = %d %s", w.Code, w.Body.String())
	}
	if updated.ID != s.ID || updated.Name != "updated" || updated.Description != "new desc" || updated.Content != "UPDATED\nBODY" {
		t.Fatalf("updated = %#v", updated)
	}
	// Change is durable: same result on a fresh read.
	again, err := getSkill(s.ID)
	if err != nil || !reflect.DeepEqual(again, &updated) {
		t.Fatalf("reloaded = %#v, %v", again, err)
	}
	// Metadata list reflects the change and still has exactly one entry.
	w = skillTestRequest(t, handler, "GET", "/api/skills/", nil)
	var list []skillMeta
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &list) != nil || len(list) != 1 || list[0].ID != s.ID || list[0].Name != "updated" {
		t.Fatalf("list after update = %d %s", w.Code, w.Body.String())
	}

	// Oversize, invalid, and missing bodies / IDs.
	for _, tc := range []struct {
		method, path string
		body         any
		code         int
	}{
		{"GET", "/api/skills/" + strings.Repeat("0", 32), nil, 404},
		{"PUT", "/api/skills/" + strings.Repeat("0", 32), map[string]string{"name": "n", "content": "c"}, 404},
		{"GET", "/api/skills/../outside", nil, 400},
		{"PUT", "/api/skills/" + strings.Repeat("g", 32), map[string]string{"name": "n", "content": "c"}, 400},
		{"PUT", "/api/skills/" + s.ID, map[string]string{"name": "", "content": "c"}, 400},
		{"PUT", "/api/skills/" + s.ID, map[string]string{"name": "n", "content": strings.Repeat("x", maxSkillContent+1)}, 413},
		{"PUT", "/api/skills/" + s.ID, nil, 400},
	} {
		w = skillTestRequest(t, handler, tc.method, tc.path, tc.body)
		if w.Code != tc.code {
			t.Fatalf("%s %s = %d %s, want %d", tc.method, tc.path, w.Code, w.Body.String(), tc.code)
		}
	}
	// Failed updates left the stored skill untouched.
	if after, err := getSkill(s.ID); err != nil || !reflect.DeepEqual(after, &updated) {
		t.Fatalf("failed update modified skill: %#v, %v", after, err)
	}
	// Other methods stay rejected.
	w = skillTestRequest(t, handler, "POST", "/api/skills/"+s.ID, map[string]string{"name": "n", "content": "c"})
	if w.Code != 405 {
		t.Fatalf("POST by id = %d %s", w.Code, w.Body.String())
	}
}

func TestChatSnapshotPreservedAfterSkillEdit(t *testing.T) {
	skillTestConf(t)
	ws, sid := skillTestSession(t)
	s := skillTestCreate(t, "snapshot-skill", "SNAPSHOT_CONTENT")
	um := &chatMsg{Role: "user", Content: "query", Skills: []skillSnapshot{*s}}
	if err := appendMessage(ws, sid, um); err != nil {
		t.Fatal(err)
	}
	before, err := readMessages(ws, sid)
	if err != nil || len(before) != 1 || !reflect.DeepEqual(before[0].Skills[0], *s) {
		t.Fatalf("snapshot before edit: %#v, %v", before, err)
	}
	h := &hubSrv{}
	handler := http.HandlerFunc(h.apiH)
	// Edit the skill on disk through the API; the chat snapshot must keep the old copy.
	w := skillTestRequest(t, handler, "PUT", "/api/skills/"+s.ID, map[string]string{"name": "edited", "description": "changed", "content": "EDITED_CONTENT"})
	if w.Code != 200 {
		t.Fatalf("edit = %d %s", w.Code, w.Body.String())
	}
	after, err := readMessages(ws, sid)
	if err != nil || len(after) != 1 || !reflect.DeepEqual(after[0].Skills[0], *s) {
		t.Fatalf("snapshot changed by skill edit: %#v, %v", after, err)
	}
	if after[0].Skills[0].Content != "SNAPSHOT_CONTENT" || after[0].Skills[0].Name != "snapshot-skill" {
		t.Fatalf("snapshot mutated: %#v", after[0].Skills[0])
	}
	// The edit is visible to later skill resolution, but the old snapshot is intact.
	resolved, err := resolveSkills([]string{s.ID})
	if err != nil || len(resolved) != 1 || resolved[0].Content != "EDITED_CONTENT" {
		t.Fatalf("resolve after edit = %#v, %v", resolved, err)
	}
}

func TestSkillsStorageErrors(t *testing.T) {
	for _, kind := range []string{"corrupt", "oversize", "mismatched-id", "oversize-content", "directory"} {
		t.Run(kind, func(t *testing.T) {
			skillTestConf(t)
			s := skillTestCreate(t, "skill", "body")
			path := filepath.Join(skillsDir(), s.ID+".json")
			var raw []byte
			switch kind {
			case "corrupt":
				raw = []byte("{")
			case "oversize":
				raw = bytes.Repeat([]byte("x"), maxSkillJSON+1)
			case "mismatched-id":
				s.ID = strings.Repeat("0", 32)
				raw, _ = json.Marshal(s)
			case "oversize-content":
				s.Content = strings.Repeat("x", maxSkillContent+1)
				raw, _ = json.Marshal(s)
			case "directory":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(path, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if kind != "directory" {
				if err := os.WriteFile(path, raw, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			h := &hubSrv{}
			w := skillTestRequest(t, http.HandlerFunc(h.apiH), "GET", "/api/skills", nil)
			if w.Code != 500 || strings.Contains(w.Body.String(), confDir()) {
				t.Fatalf("storage error = %d %s", w.Code, w.Body.String())
			}
		})
	}
	t.Run("root-is-file", func(t *testing.T) {
		skillTestConf(t)
		if err := ensureDir(dataRoot()); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(skillsDir(), []byte("blocked"), 0o600); err != nil {
			t.Fatal(err)
		}
		h := &hubSrv{}
		for _, method := range []string{"GET", "POST"} {
			w := skillTestRequest(t, http.HandlerFunc(h.apiH), method, "/api/skills", map[string]string{"name": "n", "content": "c"})
			if w.Code != 500 {
				t.Fatalf("blocked storage %s = %d %s", method, w.Code, w.Body.String())
			}
		}
	})
}

func TestChatRejectsSkillsBeforeAppend(t *testing.T) {
	skillTestConf(t)
	ws, sid := skillTestSession(t)
	s := skillTestCreate(t, "first", strings.Repeat("x", maxSkillContent))
	second := skillTestCreate(t, "second", strings.Repeat("y", maxSkillContent))
	third := skillTestCreate(t, "third", "z")
	before, err := os.ReadFile(sessPath(ws, sid))
	if err != nil {
		t.Fatal(err)
	}
	h := &hubSrv{}
	for _, tc := range []struct {
		skills any
		code   int
	}{
		{[]string{s.ID, strings.Repeat("0", 32)}, 404},
		{[]string{s.ID, "../outside"}, 400},
		{[]string{s.ID, s.ID}, 400},
		{make([]string, maxSelectedSkills+1), 413},
		{[]string{s.ID, second.ID, third.ID}, 413},
		{[]skillSnapshot{*s}, 400},
	} {
		w := skillTestRequest(t, http.HandlerFunc(h.apiH), "POST", "/api/chat", map[string]any{"workspace_id": ws, "session_id": sid, "content": "query", "skills": tc.skills})
		if w.Code != tc.code {
			t.Fatalf("rejected chat = %d %s, want %d", w.Code, w.Body.String(), tc.code)
		}
		after, err := os.ReadFile(sessPath(ws, sid))
		if err != nil || !bytes.Equal(before, after) {
			t.Fatalf("rejected request changed messages: %v", err)
		}
	}
}

func TestChatTurnUsesRequestedSkillSnapshot(t *testing.T) {
	skillTestConf(t)
	ws, sid := skillTestSession(t)
	firstSkill := skillTestCreate(t, "first-skill", "FIRST_SKILL_CONTENT")
	secondSkill := skillTestCreate(t, "second-skill", "SECOND_SKILL_CONTENT")
	first := &chatMsg{Role: "user", Content: "first question", Skills: []skillSnapshot{*firstSkill}}
	if err := appendUserMessage(ws, sid, first); err != nil {
		t.Fatal(err)
	}
	var toolCall toolCallOut
	toolCall.ID = "first-tool-call"
	toolCall.Type = "function"
	toolCall.Function.Name = "exec"
	toolCall.Function.Arguments = `{"cmd":"first-command"}`
	if err := appendMessage(ws, sid, &chatMsg{Role: "assistant", TurnID: first.ID, ToolCalls: []toolCallOut{toolCall}}); err != nil {
		t.Fatal(err)
	}
	second := &chatMsg{Role: "user", Content: "second question", Skills: []skillSnapshot{*secondSkill}}
	if err := appendUserMessage(ws, sid, second); err != nil {
		t.Fatal(err)
	}
	if err := appendMessage(ws, sid, &chatMsg{Role: "tool", TurnID: first.ID, ToolCallID: toolCall.ID, Content: "FIRST_TOOL_RESULT"}); err != nil {
		t.Fatal(err)
	}

	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	f.ChatText = "ok"
	h := &hubSrv{token: "tk", dev: true, gw: f.Store}
	marshalMessages := func(i int) string {
		bodies := f.chatBodies()
		if i >= len(bodies) {
			t.Fatalf("missing model call %d (have %d)", i, len(bodies))
		}
		var parsed struct {
			Messages []map[string]any `json:"messages"`
		}
		if err := json.Unmarshal(bodies[i], &parsed); err != nil {
			t.Fatal(err)
		}
		raw, err := json.Marshal(parsed.Messages)
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}

	secondAsst, err := h.chatTurn(context.Background(), ws, sid, second.ID, "default", "", false, false, false, false, false, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	firstAsst, err := h.chatTurn(context.Background(), ws, sid, first.ID, "default", "", false, false, false, false, false, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if secondAsst.TurnID != second.ID || firstAsst.TurnID != first.ID || len(f.chatBodies()) != 2 {
		t.Fatalf("assistant turns = %q, %q; calls = %d", secondAsst.TurnID, firstAsst.TurnID, len(f.chatBodies()))
	}

	secondRaw := marshalMessages(0)
	for _, want := range []string{"second question", secondSkill.Name, secondSkill.Content} {
		if !strings.Contains(secondRaw, want) {
			t.Fatalf("second turn omitted %q: %s", want, secondRaw)
		}
	}
	for _, unwanted := range []string{"first question", firstSkill.Name, firstSkill.Content, toolCall.ID, "FIRST_TOOL_RESULT"} {
		if strings.Contains(secondRaw, unwanted) {
			t.Fatalf("second turn crossed into first with %q: %s", unwanted, secondRaw)
		}
	}

	firstRaw := marshalMessages(1)
	for _, want := range []string{"first question", firstSkill.Name, firstSkill.Content, toolCall.ID, "FIRST_TOOL_RESULT"} {
		if !strings.Contains(firstRaw, want) {
			t.Fatalf("first turn omitted %q: %s", want, firstRaw)
		}
	}
	for _, unwanted := range []string{"second question", secondSkill.Name, secondSkill.Content} {
		if strings.Contains(firstRaw, unwanted) {
			t.Fatalf("first turn crossed into second with %q: %s", unwanted, firstRaw)
		}
	}

	third := &chatMsg{Role: "user", Content: "third question"}
	if err := appendUserMessage(ws, sid, third); err != nil {
		t.Fatal(err)
	}
	if _, err := h.chatTurn(context.Background(), ws, sid, third.ID, "default", "", false, false, false, false, false, nil, nil); err != nil {
		t.Fatal(err)
	}
	if len(f.chatBodies()) != 3 {
		t.Fatalf("calls after third turn = %d", len(f.chatBodies()))
	}
	thirdRaw := marshalMessages(2)
	for _, want := range []string{"first question", toolCall.ID, "FIRST_TOOL_RESULT", "second question", "third question"} {
		if !strings.Contains(thirdRaw, want) {
			t.Fatalf("third turn omitted completed history %q: %s", want, thirdRaw)
		}
	}

	handler := http.HandlerFunc(h.apiH)
	before, err := os.ReadFile(sessPath(ws, sid))
	if err != nil {
		t.Fatal(err)
	}
	w := skillTestRequest(t, handler, http.MethodPost, "/api/chat/continue", chatContinueReq{
		WorkspaceID: ws,
		SessionID:   sid,
		TurnID:      strings.Repeat("0", 16),
		ToolResults: []chatMsg{{Content: "must not persist", ToolCallID: "missing-turn"}},
	})
	if w.Code != http.StatusNotFound {
		t.Fatalf("missing turn continuation = %d %s", w.Code, w.Body.String())
	}
	after, err := os.ReadFile(sessPath(ws, sid))
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("missing turn continuation changed history: %v", err)
	}
}

func TestChatSkillSnapshotContinueAndNewMessage(t *testing.T) {
	skillTestConf(t)
	ws, sid := skillTestSession(t)
	s := skillTestCreate(t, "selected-skill", "ORIGINAL_SKILL_MARKDOWN")
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	f.ChatText = "ok"
	h := &hubSrv{token: "tk", dev: true, gw: f.Store}
	decode := func(i int) []map[string]any {
		bodies := f.chatBodies()
		if i >= len(bodies) {
			t.Fatalf("missing model call %d (have %d)", i, len(bodies))
		}
		var parsed struct {
			Messages []map[string]any `json:"messages"`
		}
		if err := json.Unmarshal(bodies[i], &parsed); err != nil {
			t.Fatal(err)
		}
		return parsed.Messages
	}
	handler := http.HandlerFunc(h.apiH)
	w := skillTestRequest(t, handler, "POST", "/api/chat", chatReq{WorkspaceID: ws, SessionID: sid, Content: "first", Skills: []string{s.ID}})
	if w.Code != 200 || !strings.Contains(w.Body.String(), "event: done") || len(f.chatBodies()) != 1 {
		t.Fatalf("chat = %d %s", w.Code, w.Body.String())
	}
	firstPrompt := msgText(decode(0)[0]["content"])
	if !strings.Contains(firstPrompt, "用户为本条消息明确选择的技能") || !strings.Contains(firstPrompt, s.Content) || !strings.Contains(firstPrompt, s.Name) || !strings.Contains(firstPrompt, s.Description) || bytes.Contains(f.chatBodies()[0], []byte(`"tools"`)) {
		t.Fatalf("unexpected skill prompt/tools: %s", f.chatBodies()[0])
	}
	hist, err := readMessages(ws, sid)
	if err != nil || len(hist) != 2 || len(hist[0].Skills) != 1 || !reflect.DeepEqual(hist[0].Skills[0], *s) {
		t.Fatalf("snapshot not persisted: %#v, %v", hist, err)
	}
	changed := *s
	changed.Content = "CHANGED_DISK_CONTENT"
	raw, err := json.Marshal(changed)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillsDir(), s.ID+".json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if i == 1 {
			if err := deleteSkill(s.ID); err != nil {
				t.Fatal(err)
			}
		}
		w = skillTestRequest(t, handler, "POST", "/api/chat/continue", chatContinueReq{WorkspaceID: ws, SessionID: sid, TurnID: hist[0].ID, ToolResults: []chatMsg{{Role: "user", Content: "tool output", ToolCallID: "test-call", Skills: []skillSnapshot{changed}}}})
		if w.Code != 200 || !strings.Contains(w.Body.String(), "event: done") || len(f.chatBodies()) != i+2 {
			t.Fatalf("continue = %d %s", w.Code, w.Body.String())
		}
		if msgText(decode(i + 1)[0]["content"]) != firstPrompt {
			t.Fatal("continue changed snapshot prompt")
		}
	}
	w = skillTestRequest(t, handler, "POST", "/api/chat", chatReq{WorkspaceID: ws, SessionID: sid, Content: "new without skills"})
	if w.Code != 200 || !strings.Contains(w.Body.String(), "event: done") || len(f.chatBodies()) != 4 {
		t.Fatalf("new chat = %d %s", w.Code, w.Body.String())
	}
	lastRaw := string(f.chatBodies()[3])
	if strings.Contains(lastRaw, s.Content) || strings.Contains(lastRaw, changed.Content) || strings.Contains(lastRaw, "用户为本条消息明确选择的技能") {
		t.Fatal("new user message inherited old skills")
	}
	hist, err = readMessages(ws, sid)
	if err != nil || len(hist) != 8 {
		t.Fatalf("history = %#v, %v", hist, err)
	}
	for i, m := range hist {
		if i == 0 {
			continue
		}
		b, err := json.Marshal(m)
		if err != nil || len(m.Skills) != 0 || bytes.Contains(b, []byte(`"skills"`)) {
			t.Fatalf("unexpected snapshot on message %d: %s, %v", i, b, err)
		}
	}
}
