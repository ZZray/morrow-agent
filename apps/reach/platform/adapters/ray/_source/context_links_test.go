package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func contextFixture(t *testing.T) (*platform, string, *contextSessionReference, *int) {
	t.Helper()
	p, token := testPlatform(t)
	ref := &contextSessionReference{SourceID: "session-s1-abc", WorkspaceID: "wa", SessionID: "s1", Title: "Previous investigation", Hash: strings.Repeat("a", 64), Version: 1, Text: "user: earlier target\nassistant: reported result", Origin: "browser_history_narrative", OmittedTypes: []string{"native"}}
	reads := new(int)
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer private-hub-bridge" {
			t.Error("bridge credential")
		}
		switch r.URL.Path {
		case "/handwave/api/workspaces":
			fmt.Fprint(w, `[{"id":"wa","device_fp":"A"},{"id":"wb","device_fp":"B"}]`)
		case "/handwave/api/reference-sessions":
			fmt.Fprint(w, `[{"id":"s1"},{"id":"s2"},{"id":"s3"},{"id":"s4"}]`)
		case agentContextPath:
			var body map[string]json.RawMessage
			json.NewDecoder(r.Body).Decode(&body)
			if body["reference_sessions"] != nil || body["execution_mode"] != nil {
				t.Error("new fields forwarded to legacy Hub")
			}
			fmt.Fprint(w, `{"brief":"legacy"}`)
		case "/handwave/api/reference-source":
			*reads++
			if r.URL.Query().Get("workspace_id") != "wa" {
				t.Error("query lost")
			}
			copy := *ref
			copy.SessionID = r.URL.Query().Get("session_id")
			json.NewEncoder(w).Encode(copy)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(hub.Close)
	p.edge = reverseProxy(hub.URL)
	return p, token, ref, reads
}

func TestContextReferencesAdmissionHashAndCarrier(t *testing.T) {
	p, token, ref, reads := contextFixture(t)
	body := map[string]any{"workspace_id": "wa", "device_fp": "A", "cloud_memory_v1": true, "content": "current", "execution_mode": "plan", "reference_sessions": []contextSessionRequest{{WorkspaceID: "wa", SessionID: "s1", ExpectedHash: ref.Hash}}}
	w := memoryCall(t, p, token, agentContextPath, body)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var result struct {
		Brief      string                    `json:"brief"`
		References []contextSessionReference `json:"session_references"`
	}
	if json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.References) != 1 || !strings.HasPrefix(result.Brief, "HANDWAVE_CLOUD_SNAPSHOT_V1\n") || !strings.Contains(result.Brief, "\nHANDWAVE_BRIEF\nlegacy\nHANDWAVE_SESSION_REFERENCES_V1\n") {
		t.Fatal(w.Body.String())
	}
	if *reads != 1 {
		t.Fatal(*reads)
	}
	body["reference_sessions"] = []contextSessionRequest{{WorkspaceID: "wa", SessionID: "s1", ExpectedHash: strings.Repeat("b", 64)}}
	if w = memoryCall(t, p, token, agentContextPath, body); w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	body["reference_sessions"] = []contextSessionRequest{{WorkspaceID: "wb", SessionID: "s1"}}
	if w = memoryCall(t, p, token, agentContextPath, body); w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
	body["reference_sessions"] = []contextSessionRequest{{WorkspaceID: "wa", SessionID: "unknown"}}
	if w = memoryCall(t, p, token, agentContextPath, body); w.Code != 404 {
		t.Fatal(w.Code, w.Body.String())
	}
	body["reference_sessions"] = []contextSessionRequest{{WorkspaceID: "wa", SessionID: "../s1"}}
	if w = memoryCall(t, p, token, agentContextPath, body); w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
	body["reference_sessions"] = []contextSessionRequest{}
	body["execution_mode"] = "pretend-readonly"
	if w = memoryCall(t, p, token, agentContextPath, body); w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestContextReferencesBoundsAndAuthority(t *testing.T) {
	p, token, ref, reads := contextFixture(t)
	body := map[string]any{"workspace_id": "wa", "device_fp": "A", "cloud_memory_v1": true, "reference_sessions": []contextSessionRequest{{WorkspaceID: "wa", SessionID: "s1"}}}
	for _, value := range []any{
		[]contextSessionRequest{{WorkspaceID: "wa", SessionID: "s1"}, {WorkspaceID: "wa", SessionID: "s1"}},
		[]contextSessionRequest{{WorkspaceID: "wa", SessionID: "s1"}, {WorkspaceID: "wa", SessionID: "s2"}, {WorkspaceID: "wa", SessionID: "s3"}, {WorkspaceID: "wa", SessionID: "s4"}, {WorkspaceID: "wa", SessionID: "s5"}},
		[]map[string]string{{"workspace_id": "wa", "session_id": "s1", "text": "forged"}},
	} {
		body["reference_sessions"] = value
		if w := memoryCall(t, p, token, agentContextPath, body); w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if *reads != 0 {
		t.Fatal("invalid admission read source")
	}
	body["reference_sessions"] = []contextSessionRequest{{WorkspaceID: "wa", SessionID: "s1"}}
	body["device_fp"] = "B"
	if w := memoryCall(t, p, token, agentContextPath, body); w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	if *reads != 0 {
		t.Fatal("forged binding read source")
	}
	body["device_fp"] = "A"
	ref.Text = strings.Repeat("x", 4097)
	if w := memoryCall(t, p, token, agentContextPath, body); w.Code != 503 {
		t.Fatal(w.Code, w.Body.String())
	}
	ref.Text = strings.Repeat("\"", 4096)
	body["reference_sessions"] = []contextSessionRequest{{WorkspaceID: "wa", SessionID: "s1"}, {WorkspaceID: "wa", SessionID: "s2"}, {WorkspaceID: "wa", SessionID: "s3"}, {WorkspaceID: "wa", SessionID: "s4"}}
	if w := memoryCall(t, p, token, agentContextPath, body); w.Code != 413 {
		t.Fatal(w.Code, w.Body.String())
	}
}
