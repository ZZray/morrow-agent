package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"
)

// The controlled resolve stub only opens the publication race window. Full
// shared Gateway behavior is exercised separately by the real-chain fixtures.
func TestNodeSmartResolveDoesNotPublishAfterApprovalRevocation(t *testing.T) {
	skillTestConf(t)
	f := newGatewayFixture(t, []gwTestModel{{ID: "glm-4.6", Protocols: []string{"openai-completions"}}})
	smartStore(f, "handwave-hub")
	h := testHubWithNode("fp", true)
	h.gw = f.Store
	entered, release := make(chan struct{}), make(chan struct{})
	f.Resolve = func(w http.ResponseWriter, r *http.Request) bool {
		close(entered)
		<-release
		writeResolveOK(w, "decision", "glm-4.6", "openai-completions")
		return true
	}
	go func() { <-entered; h.mu.Lock(); delete(h.approvals, "fp"); h.mu.Unlock(); close(release) }()
	reply := reviewerGrantReply(t, h, &sig{K: "model-grant", ID: "first", Run: "run", Smart: true, Brief: "summarize", RequiresTools: true})
	if reply.Err == "" {
		t.Fatal("grant published after approval was revoked during resolve")
	}
	b := h.bindings()
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.runs) != 0 || len(b.pins) != 0 || len(b.byCode) != 0 {
		t.Fatal("revoked resolve left usable authorization records")
	}
}

func TestNodeSmartConcurrentFirstIssuePublishesOneBinding(t *testing.T) {
	skillTestConf(t)
	f := newGatewayFixture(t, []gwTestModel{{ID: "glm-4.6", Protocols: []string{"openai-completions"}}})
	smartStore(f, "handwave-hub")
	h := testHubWithNode("fp", true)
	h.gw = f.Store
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	f.Resolve = func(w http.ResponseWriter, r *http.Request) bool {
		once.Do(func() { close(entered) })
		<-release
		writeResolveOK(w, "decision", "glm-4.6", "openai-completions")
		return true
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		h.mu.Lock()
		h.nodes["n1"].ws = c
		h.mu.Unlock()
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			h.issueModelGrant(r.Context(), "n1", c, &sig{ID: "first", Run: "run", Smart: true, Brief: "summarize", RequiresTools: true})
		}()
		select {
		case <-entered:
		case <-r.Context().Done():
			return
		}
		go func() {
			defer wg.Done()
			h.issueModelGrant(r.Context(), "n1", c, &sig{ID: "second", Run: "run", Smart: true, Brief: "summarize", RequiresTools: true})
		}()
		close(release)
		wg.Wait()
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	var replies [2]sig
	for i := range replies {
		if err := wsjson.Read(ctx, c, &replies[i]); err != nil {
			t.Fatal(err)
		}
		if replies[i].Err != "" {
			t.Fatal(replies[i].Err)
		}
	}
	if replies[0].BindingID == "" || replies[0].BindingID != replies[1].BindingID || replies[0].D != replies[1].D {
		t.Fatal("duplicate first issue produced conflicting authorization")
	}
	f.mu.Lock()
	calls := f.resolveCalls
	f.mu.Unlock()
	if calls != 1 {
		t.Fatalf("first issue resolved %d times", calls)
	}
}

func TestNodeSmartRejectsInvalidDecisionExpiry(t *testing.T) {
	for _, expiry := range []string{"", "invalid", "2000-01-01T00:00:00Z"} {
		t.Run(expiry, func(t *testing.T) {
			skillTestConf(t)
			f := newGatewayFixture(t, []gwTestModel{{ID: "glm-4.6", Protocols: []string{"openai-completions"}}})
			smartStore(f, "handwave-hub")
			f.Resolve = func(w http.ResponseWriter, r *http.Request) bool {
				recorder := httptest.NewRecorder()
				writeResolveOK(recorder, "d", "glm-4.6", "openai-completions")
				var result map[string]any
				if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
					t.Error(err)
				}
				result["expires_at"] = expiry
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(result)
				return true
			}
			h := testHubWithNode("fp", true)
			h.gw = f.Store
			if reply := reviewerGrantReply(t, h, &sig{ID: "first", Run: "run", Smart: true, Brief: "summarize", RequiresTools: true}); reply.Err == "" {
				t.Fatal("invalid decision expiry accepted")
			}
		})
	}
}
