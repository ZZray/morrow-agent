package main

import (
	"context"
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"
)

func TestSecurityControllerOwnerIsServerAssignedBeforeHello(t *testing.T) {
	h, server := newIdentityFixtureHub(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/ws?role=ctl", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer fixture-root"}}, Subprotocols: []string{"handwave"}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseNow()
	var identity sig
	if err := wsjson.Read(ctx, client, &identity); err != nil || identity.K != "controller-identity" || identity.FP != h.controllerIdentity() {
		t.Fatalf("server identity absent: %+v %v", identity, err)
	}
	if err := wsjson.Write(ctx, client, &sig{K: "hello", FP: "victim-controller"}); err != nil {
		t.Fatal(err)
	}
	var status sig
	if err := wsjson.Read(ctx, client, &status); err != nil || status.K != "status" {
		t.Fatalf("hello: %+v %v", status, err)
	}
	if err := wsjson.Write(ctx, client, &sig{K: "batch", Op: "approve", FPs: []string{"not-online"}, SelfFP: "victim-controller"}); err != nil {
		t.Fatal(err)
	}
	// Processing the response creates a synchronization boundary with Hub.
	if err := wsjson.Read(ctx, client, &status); err != nil {
		t.Fatal(err)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, cc := range h.ctlws {
		if cc.fp != identity.FP {
			t.Fatal("client changed authenticated owner")
		}
	}
	if ap := h.approvals["not-online"]; ap != nil && ap.CtlFP == "victim-controller" {
		t.Fatal("SelfFP supplied authority")
	}
	other := &hubSrv{token: "another-root"}
	if other.controllerIdentity() == identity.FP || len(identity.FP) != 32 {
		t.Fatal("controller authority separation")
	}
}

func TestSecurityNodeIngressTokenCannotOpenController(t *testing.T) {
	_, server := newIdentityFixtureHub(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	client, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/ws?role=ctl", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer fixture-node"}}})
	if client != nil {
		client.CloseNow()
	}
	if err == nil || response == nil || response.StatusCode != 401 {
		t.Fatal("node token obtained controller authority")
	}
}

func TestSecurityHubOriginHasExactSchemeHostAndPort(t *testing.T) {
	for _, origin := range []string{"null", "https://evil.test", "http://127.0.0.1:444", "https://127.0.0.1", "http://127.0.0.1/path", ""} {
		r := httptest.NewRequest("GET", "http://127.0.0.1/ws?role=ctl", nil)
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		if validSocketOrigin(r) {
			t.Fatalf("untrusted Origin accepted: %q", origin)
		}
	}
	r := httptest.NewRequest("GET", "https://127.0.0.1/ws?role=ctl", nil)
	r.TLS = &tls.ConnectionState{}
	r.Header.Set("Origin", "https://127.0.0.1")
	if !validSocketOrigin(r) {
		t.Fatal("valid Origin refused")
	}
	r.Header.Add("Origin", "https://127.0.0.1")
	if validSocketOrigin(r) {
		t.Fatal("multiple Origins accepted")
	}
	r.Header.Del("Origin")
	r.Header.Set("Authorization", "Bearer fixture-root")
	if !(&hubSrv{token: "fixture-root"}).socketOriginAllowed(r) {
		t.Fatal("originless authenticated server hop refused")
	}
}

func TestSecurityOriginlessCookieAndBogusHeaderCannotUseNativeException(t *testing.T) {
	h, _ := newIdentityFixtureHub(t)
	sid := h.newAuthSession()
	for _, header := range []string{"", "garbage", "Bearer invalid", "Basic fixture-root"} {
		r := httptest.NewRequest("GET", "http://127.0.0.1/ws?role=ctl", nil)
		r.AddCookie(&http.Cookie{Name: authCookie, Value: sid})
		if header != "" {
			r.Header.Set("Authorization", header)
		}
		w := httptest.NewRecorder()
		h.wrapWS(h.wsH)(w, r)
		if w.Code != 403 {
			t.Fatalf("cookie gained originless exception: %q %d", header, w.Code)
		}
	}
}

func TestSecurityGoClientRejectsPlaintextPublicBeforeDial(t *testing.T) {
	for _, address := range []string{"ws://example.com/ws", "ws://192.0.2.1/ws", "ws://localhost/ws", "http://127.0.0.1/ws", "wss://user:secret@example.com/ws"} {
		if validateControllerTransport(address) == nil {
			t.Fatalf("unsafe transport accepted: %s", address)
		}
	}
	for _, address := range []string{"wss://example.com/ws", "ws://127.0.0.1:1234/ws", "ws://[::1]:1234/ws"} {
		if err := validateControllerTransport(address); err != nil {
			t.Fatal(err)
		}
	}
	cn := newConn("ws://192.0.2.1:1/ws?role=node", "fixture-secret", true)
	if err := cn.dial(context.Background()); err == nil || !strings.Contains(err.Error(), "requires WSS") {
		t.Fatal("client did not fail before dialing")
	}
}

func TestSecurityGoWebSocketClientDoesNotFollowTLSRedirect(t *testing.T) {
	var plaintext atomic.Int32
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		plaintext.Add(1)
		http.Error(w, "plaintext reached", 500)
	}))
	defer plain.Close()
	secure := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, plain.URL+"/ws?role=ctl", http.StatusFound)
	}))
	defer secure.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	client, response, err := websocket.Dial(ctx, "wss"+strings.TrimPrefix(secure.URL, "https")+"/ws?role=ctl", &websocket.DialOptions{HTTPClient: websocketHTTPClient(secure.Client()), HTTPHeader: http.Header{"Authorization": []string{"Bearer fixture-root"}}})
	if client != nil {
		client.CloseNow()
	}
	if err == nil || response == nil || response.StatusCode != 302 || plaintext.Load() != 0 {
		t.Fatal("TLS WebSocket redirect was followed")
	}
}
