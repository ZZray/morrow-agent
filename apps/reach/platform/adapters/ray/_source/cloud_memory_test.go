package main

import (
	"ara/apps/handwave/memorystore"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func cloudFixture(t *testing.T) (*platform, string) {
	t.Helper()
	p, token := testPlatform(t)
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer private-hub-bridge" || strings.Contains(r.Header.Get("Cookie"), sessionCookie) {
			t.Error("Hub auth boundary")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/handwave/api/workspaces":
			w.Write([]byte(`[{"id":"wa","name":"Alpha","device_fp":"A"},{"id":"wb","name":"Beta","device_fp":"B"}]`))
		case agentContextPath:
			w.Write([]byte(`{"brief":"legacy knowledge source"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(hub.Close)
	p.edge = reverseProxy(hub.URL)
	return p, token
}
func memoryCall(t *testing.T, p *platform, token, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	method := "GET"
	var b []byte
	if body != nil {
		method = "POST"
		b, _ = json.Marshal(body)
	}
	r := testRequest(method, path, token)
	r.Body = http.NoBody
	if body != nil {
		r.Body = ioBody(b)
		r.Header.Set("Origin", "https://127.0.0.1")
	}
	w := httptest.NewRecorder()
	p.handler("primary").ServeHTTP(w, r)
	return w
}
func ioBody(b []byte) io.ReadCloser { return io.NopCloser(bytes.NewReader(b)) }
func request(ws, fp string, n int) map[string]any {
	return map[string]any{"workspace_id": ws, "device_fp": fp, "op_id": fmt.Sprintf("%032x", n)}
}
func TestMemoryAPIGatesBearerAndCSRF(t *testing.T) {
	p, token := cloudFixture(t)
	for _, path := range []string{cloudMemoryPrefix, cloudMemoryPrefix + "/records", agentContextPath} {
		r := testRequest("POST", path, "")
		r.Header.Set("Authorization", "Bearer private-hub-bridge")
		w := httptest.NewRecorder()
		p.handler("primary").ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatalf("bearer bypass %s: %d", path, w.Code)
		}
	}
	r := testRequest("POST", cloudMemoryPrefix+"/records", token)
	r.Body = ioBody([]byte("{}"))
	w := httptest.NewRecorder()
	p.handler("primary").ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross-origin memory write")
	}
	r = testRequest("GET", cloudMemoryPrefix+"?workspace_id=wa&device_fp=B", token)
	w = httptest.NewRecorder()
	p.handler("primary").ServeHTTP(w, r)
	if w.Code != 409 {
		t.Fatal("forged binding accepted")
	}
}
func TestCloudMemoryIsolationSharingCorrectionRevocationAndRestart(t *testing.T) {
	p, token := cloudFixture(t)
	body := request("wa", "A", 1)
	body["scope"] = "device"
	body["kind"] = "fact"
	body["title"] = "private"
	body["text"] = "ONLY_A_PATH"
	body["expected_revision"] = 0
	saved := memoryCall(t, p, token, cloudMemoryPrefix+"/records", body)
	if saved.Code != 200 {
		t.Fatalf("save %d %s", saved.Code, saved.Body.String())
	}
	var record memorystore.Record
	json.Unmarshal(saved.Body.Bytes(), &record)
	repeat := memoryCall(t, p, token, cloudMemoryPrefix+"/records", body)
	if repeat.Code != 200 || repeat.Body.String() != saved.Body.String() {
		t.Fatal("idempotent save")
	}
	b := memoryCall(t, p, token, cloudMemoryPrefix+"?workspace_id=wb&device_fp=B", nil)
	if b.Code != 200 || strings.Contains(b.Body.String(), "ONLY_A_PATH") {
		t.Fatal("device B leaked A")
	}
	// Explicit membership is required even for the current workspace.
	project := request("wa", "A", 2)
	project["scope"] = "project"
	project["kind"] = "decision"
	project["title"] = "shared"
	project["text"] = "SHARED_PROJECT_RULE"
	project["expected_revision"] = 0
	if memoryCall(t, p, token, cloudMemoryPrefix+"/records", project).Code != 400 {
		t.Fatal("implicit project membership")
	}
	for i, pair := range [][2]string{{"wa", "A"}, {"wb", "B"}} {
		join := request(pair[0], pair[1], 10+i)
		join["project_id"] = "wa"
		join["expected_revision"] = 0
		if memoryCall(t, p, token, cloudMemoryPrefix+"/project", join).Code != 200 {
			t.Fatal("explicit join failed")
		}
	}
	if memoryCall(t, p, token, cloudMemoryPrefix+"/records", project).Code != 200 {
		t.Fatal("project save")
	}
	context := memoryCall(t, p, token, agentContextPath, map[string]any{"workspace_id": "wb", "device_fp": "B", "cloud_memory_v1": true, "content": "SHARED_PROJECT_RULE"})
	if context.Code != 200 || !strings.Contains(context.Body.String(), "SHARED_PROJECT_RULE") || strings.Contains(context.Body.String(), "ONLY_A_PATH") {
		t.Fatal("snapshot scope filtering")
	}
	edit := request("wa", "A", 20)
	edit["scope"] = "device"
	edit["id"] = record.ID
	edit["expected_revision"] = record.Revision
	edit["kind"] = "fact"
	edit["title"] = "fixed"
	edit["text"] = "NEW_A_PATH"
	if memoryCall(t, p, token, cloudMemoryPrefix+"/records", edit).Code != 200 {
		t.Fatal("edit failed")
	}
	edit["op_id"] = fmt.Sprintf("%032x", 21)
	if memoryCall(t, p, token, cloudMemoryPrefix+"/records", edit).Code != 409 {
		t.Fatal("stale revision accepted")
	}
	revoke := request("wa", "A", 30)
	revoke["scope"] = "device"
	revoke["id"] = record.ID
	revoke["expected_revision"] = 2
	if memoryCall(t, p, token, cloudMemoryPrefix+"/revoke", revoke).Code != 200 {
		t.Fatal("revoke failed")
	}
	var err error
	p.memory, err = memorystore.New(filepath.Join(filepath.Dir(p.auth.path), "handwave-memory.json"))
	if err != nil {
		t.Fatal(err)
	}
	a := memoryCall(t, p, token, cloudMemoryPrefix+"?workspace_id=wa&device_fp=A", nil)
	if a.Code != 200 || strings.Contains(a.Body.String(), "NEW_A_PATH") {
		t.Fatal("revoked memory resurrected")
	}
	h := memoryCall(t, p, token, cloudMemoryPrefix+"/history?workspace_id=wa&device_fp=A&id="+record.ID, nil)
	if h.Code != 200 || !strings.Contains(h.Body.String(), "ONLY_A_PATH") || !strings.Contains(h.Body.String(), "NEW_A_PATH") {
		t.Fatal("source history erased")
	}
}
