package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

// Exercise the actual production 45s Ping + 15s deadline. The client accepts
// the upgrade but deliberately never reads (and consequently never answers a
// Ping). nhooyr v1.8.17 returns a Ping deadline without closing Read by itself.
func TestHubHeartbeatTimeoutClosesReadAndCleansController(t *testing.T) {
	h := &hubSrv{token: "heartbeat-fixture-root", ctlws: map[string]*ctlConn{}, nodes: map[string]*nodeConn{}, devNode: map[string]string{}, approvals: map[string]*approval{}, denied: map[string]bool{}, peers: map[string]string{}, aliases: map[string]string{}}
	finished := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(finished)
		h.wrapWS(h.wsH)(w, r)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 70*time.Second)
	defer cancel()
	client, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/ws?role=ctl", &websocket.DialOptions{Subprotocols: []string{"handwave"}, HTTPHeader: http.Header{"Authorization": []string{"Bearer heartbeat-fixture-root"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseNow()
	deadline := time.Now().Add(time.Second)
	for {
		h.mu.Lock()
		count := len(h.ctlws)
		h.mu.Unlock()
		if count == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("controller was not registered")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case <-finished:
	case <-time.After(65 * time.Second):
		t.Fatal("missing Pong left the actual Hub Read/cleanup hung")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.ctlws) != 0 {
		t.Fatal("dead controller still appears connected")
	}
}
