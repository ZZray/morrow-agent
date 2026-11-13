package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

// Exercise the actual routes -> wrapAuth -> apiH dispatcher, rather than the
// direct helper seam, so a missing API registration cannot pass this test.
func TestReferenceAPIsAuthenticatedDispatcher(t *testing.T) {
	skillTestConf(t)
	ws, sid := skillTestSession(t)
	if err := appendMessage(ws, sid, &chatMsg{Role: "user", Content: "public source"}); err != nil {
		t.Fatal(err)
	}
	h := &hubSrv{token: "fixture-root"}
	mux := http.NewServeMux()
	h.routes(mux)
	server := httptest.NewServer(mux)
	defer server.Close()
	paths := []string{"/api/reference-sessions?workspace_id=" + ws, "/api/reference-source?workspace_id=" + ws + "&session_id=" + sid}
	for _, path := range paths {
		for _, authorized := range []bool{false, true} {
			request, err := http.NewRequest("GET", server.URL+path, nil)
			if err != nil {
				t.Fatal(err)
			}
			if authorized {
				request.Header.Set("Authorization", "Bearer fixture-root")
			}
			response, err := server.Client().Do(request)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil {
				t.Fatal(err)
			}
			want := 401
			if authorized {
				want = 200
			}
			if response.StatusCode != want {
				t.Fatalf("%s authorized=%v status=%d body=%s", path, authorized, response.StatusCode, body)
			}
			if authorized && !json.Valid(body) {
				t.Fatal("invalid API JSON", string(body))
			}
			if !authorized && strings.Contains(string(body), "public source") {
				t.Fatal("unauthed source leaked")
			}
		}
	}
}

func TestSessionReferencePublicProjectionAndVersion(t *testing.T) {
	skillTestConf(t)
	ws, sid := skillTestSession(t)
	for _, m := range []*chatMsg{{Role: "user", Content: "用户目标"}, {Role: "assistant", Content: "公开答复", Events: []agentEvent{{Output: "PRIVATE_EVENT"}}}, {Role: "tool", Content: "PRIVATE_TOOL"}, {Role: "system", Content: "PRIVATE_SYSTEM"}} {
		if err := appendMessage(ws, sid, m); err != nil {
			t.Fatal(err)
		}
	}
	f, err := os.OpenFile(sessPath(ws, sid), os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.WriteString("{\"role\":\"assistant\",\"content\":\"public text\",\"native\":{\"thinking\":\"PRIVATE_NATIVE\"},\"thinking\":\"PRIVATE_THINKING\",\"attachments\":[{\"data_url\":\"PRIVATE_ATTACHMENT\"}]}\n")
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	a, err := readSessionReference(ws, sid)
	if err != nil || a.Origin != "browser_history_narrative" || a.Version != 1 || !strings.Contains(a.Text, "公开答复") || strings.Contains(a.Text, "PRIVATE_") || a.Truncated {
		t.Fatal(a, err)
	}
	b, err := readSessionReference(ws, sid)
	if err != nil || a.Hash != b.Hash {
		t.Fatal(b, err)
	}
	if err := appendMessage(ws, sid, &chatMsg{Role: "assistant", Content: "新的答复"}); err != nil {
		t.Fatal(err)
	}
	b, err = readSessionReference(ws, sid)
	if err != nil || a.Hash == b.Hash {
		t.Fatal(b, err)
	}
	other, _ := createWorkspace("other")
	if _, err := readSessionReference(other.ID, sid); err == nil {
		t.Fatal("cross workspace")
	}
	if _, err := readSessionReference("../bad", sid); err == nil {
		t.Fatal("unsafe identity")
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/reference-source?workspace_id="+ws+"&session_id="+sid, nil)
	(&hubSrv{}).apiReferenceSource(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestSessionReferenceUTF8BudgetAndCorruptSource(t *testing.T) {
	skillTestConf(t)
	ws, sid := skillTestSession(t)
	if err := appendMessage(ws, sid, &chatMsg{Role: "assistant", Content: strings.Repeat("中文", 3000)}); err != nil {
		t.Fatal(err)
	}
	a, err := readSessionReference(ws, sid)
	if err != nil || !a.Truncated || len(a.Text) > 4096 || !utf8.ValidString(a.Text) {
		t.Fatal(a, err)
	}
	for _, body := range []string{"{bad}\n", "{\"unexpected\":true}\n", strings.Repeat("x", referenceFileLimit+1), `{"role":"user","content":` + strings.Repeat("x", 256<<10)} {
		if err := os.WriteFile(sessPath(ws, sid), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readSessionReference(ws, sid); err == nil {
			t.Fatal("accepted incomplete source")
		}
	}
	valid, _ := json.Marshal(chatMsg{Role: "user", Content: "safe"})
	if err := os.WriteFile(sessPath(ws, sid), append(valid, []byte("\n{broken}\n")...), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readSessionReference(ws, sid); err == nil {
		t.Fatal("silently skipped broken line")
	}
	// The chooser reads metadata only, even when a transcript is corrupt.
	rows, err := listReferenceSessions(ws)
	if err != nil || len(rows) != 1 || rows[0].ID != sid {
		t.Fatal(rows, err)
	}
	if err := os.WriteFile(sessMetaPath(ws, sid), []byte(strings.Repeat("x", 65537)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := listReferenceSessions(ws); err == nil {
		t.Fatal("oversized metadata accepted")
	}
}
