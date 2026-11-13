package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"
	"strings"
	"testing"
	"time"
)

func TestReviewerExpiredCodeLookupKeepsRenewalRecord(t *testing.T) {
	b := newBindingBook()
	p, err := b.pinSession("fp", testPin("fp", "m", "openai-completions", "d"))
	if err != nil {
		t.Fatal(err)
	}
	g, err := b.attachRun("fp", "run", p.BindingID)
	if err != nil {
		t.Fatal(err)
	}
	b.mu.Lock()
	g.Exp = time.Now().Add(-time.Second)
	b.mu.Unlock()
	if _, ok := b.runForCode(g.Code); ok {
		t.Fatal("expired code accepted")
	}
	if _, err := b.renewRun("fp", "run"); err != nil {
		t.Fatalf("HTTP expired-code lookup destroyed renewable run: %v", err)
	}
}
func TestReviewerDisconnectRevokesSmartCode(t *testing.T) {
	h := testHubWithNode("fp", true)
	p, err := h.bindings().pinSession("fp", testPin("fp", "m", "openai-completions", "d"))
	if err != nil {
		t.Fatal(err)
	}
	g, err := h.bindings().attachRun("fp", "run", p.BindingID)
	if err != nil {
		t.Fatal(err)
	}
	h.mu.Lock()
	h.dropLocked("n1")
	h.mu.Unlock()
	r := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	r.Header.Set("Authorization", "Bearer "+g.Code)
	if h.modelGrantOK(r) {
		t.Fatal("smart code still authorizes after real Hub dropLocked")
	}
}
func reviewerGrantReply(t *testing.T, h *hubSrv, s *sig) sig {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		h.mu.Lock()
		h.nodes["n1"].ws = c
		h.mu.Unlock()
		h.issueModelGrant(r.Context(), "n1", c, s)
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	var got sig
	if err := wsjson.Read(ctx, c, &got); err != nil {
		t.Fatal(err)
	}
	return got
}
func TestReviewerSmartRequiresDeviceApproval(t *testing.T) {
	skillTestConf(t)
	f := newGatewayFixture(t, []gwTestModel{{ID: "glm-4.6", Protocols: []string{"openai-completions"}}})
	smartStore(f, "handwave-hub")
	h := testHubWithNode("fp", false)
	h.gw = f.Store
	got := reviewerGrantReply(t, h, &sig{K: "model-grant", ID: "first", Run: "run", Smart: true, Brief: "summarize source"})
	if got.Err == "" {
		t.Fatal("unapproved device received successful smart grant over WebSocket")
	}
}
func TestReviewerLegacyRenewalEchoesCorrelation(t *testing.T) {
	skillTestConf(t)
	f := newGatewayFixture(t, []gwTestModel{{ID: "glm-4.6", Protocols: []string{"openai-completions"}}})
	h := testHubWithNode("fp", true)
	h.gw = f.Store
	got := reviewerGrantReply(t, h, &sig{K: "model-grant", ID: "run-refresh", Run: "run"})
	if got.ID != "run-refresh" {
		t.Fatalf("response correlation=%q, waiter expects run-refresh", got.ID)
	}
}

type reviewerHeldBody struct {
	entered chan struct{}
	release chan struct{}
	data    io.Reader
	started bool
}

func (b *reviewerHeldBody) Read(p []byte) (int, error) {
	if !b.started {
		b.started = true
		close(b.entered)
		<-b.release
	}
	return b.data.Read(p)
}
func (b *reviewerHeldBody) Close() error { return nil }
func TestReviewerSmartGateRejectsRotationWhileReadingBody(t *testing.T) {
	f := newSmartGateFixture(t)
	body := &reviewerHeldBody{entered: make(chan struct{}), release: make(chan struct{}), data: strings.NewReader(string(chatBodyFor("other-model")))}
	r := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	r.Body = body
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+f.code)
	r.Header.Set(smartRunHeader, f.run)
	r.Header.Set(smartBindingHeader, f.binding)
	if !f.h.modelGrantOK(r) {
		t.Fatal("fixture authorization failed")
	}
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { defer close(done); f.h.gatewayProxy(w, r) }()
	select {
	case <-body.entered:
	case <-time.After(3 * time.Second):
		close(body.release)
		t.Fatal("body read not reached")
	}
	_, err := f.h.bindings().attachRun("fp-smart", f.run, f.binding)
	close(body.release)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("proxy did not complete")
	}
	if f.upstreamCalls() != 0 || w.Code == http.StatusOK {
		t.Fatalf("revoked smart request with wrong model escaped gate: status=%d upstream=%d", w.Code, f.upstreamCalls())
	}
}

func TestSmartGateRejectsRotationBetweenWrapAndProxy(t *testing.T) {
	f := newSmartGateFixture(t)
	r := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(string(chatBodyFor("other-model"))))
	r.Header.Set("Authorization", "Bearer "+f.code)
	r.Header.Set(smartRunHeader, f.run)
	r.Header.Set(smartBindingHeader, f.binding)
	w := httptest.NewRecorder()
	f.h.wrap(func(w http.ResponseWriter, r *http.Request) {
		if _, err := f.h.bindings().renewRun("fp-smart", f.run); err != nil {
			t.Fatal(err)
		}
		f.h.gatewayProxy(w, r)
	})(w, r)
	if w.Code < 400 || f.upstreamCalls() != 0 {
		t.Fatalf("rotated authorization downgraded: status=%d calls=%d", w.Code, f.upstreamCalls())
	}
}
