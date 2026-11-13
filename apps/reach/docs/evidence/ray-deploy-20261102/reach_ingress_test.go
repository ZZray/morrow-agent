// Copyright (c) Ray Zhang.
package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReachIndependentIdentityHeadersAndCookieBoundary(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "reach_session=reach-private" || r.Header.Get("Authorization") != "Bearer reach-controller" {
			t.Error("Reach authentication values changed or foreign cookie forwarded")
		}
		if r.Header.Get("Origin") != "https://127.0.0.1:8443" || r.Header.Get("X-Reach-CSRF") != "reach-csrf" {
			t.Error("Reach browser CSRF contract changed")
		}
		if r.Header.Get("X-Reach-Client-IP") != "198.51.100.25" || r.Header.Get("X-Ray-Authenticated") != "" || r.Header.Get("Forwarded") != "" {
			t.Error("untrusted ingress headers forwarded")
		}
		w.Header().Add("Set-Cookie", "reach_session=fresh; Path=/; Secure; HttpOnly; SameSite=Strict")
		w.Header().Add("Set-Cookie", "ray_platform_session=forged; Path=/")
		w.Header().Add("Set-Cookie", "omp_admin_sess=forged; Path=/")
		w.WriteHeader(201)
		_, _ = io.WriteString(w, "original-upstream-result")
	}))
	defer upstream.Close()
	handler, err := newReachHandler("127.0.0.1", upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "https://127.0.0.1:8443/api/v1/pairing-codes", strings.NewReader("{}"))
	r.RemoteAddr = "198.51.100.25:1234"
	r.Header.Set("Cookie", "ray_platform_session=private; reach_session=reach-private; omp_admin_sess=private")
	r.Header.Set("Authorization", "Bearer reach-controller")
	r.Header.Set("Origin", "https://127.0.0.1:8443")
	r.Header.Set("X-Reach-CSRF", "reach-csrf")
	r.Header.Set("X-Reach-Client-IP", "203.0.113.1")
	r.Header.Set("X-Ray-Authenticated", "true")
	r.Header.Set("Forwarded", "for=203.0.113.2")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 201 || w.Body.String() != "original-upstream-result" {
		t.Fatalf("upstream result lost: %d", w.Code)
	}
	if len(w.Result().Cookies()) != 1 || w.Result().Cookies()[0].Name != reachCookie {
		t.Fatal("foreign response cookie escaped")
	}
	for _, target := range []string{"http://127.0.0.1:8443/api/v1/nodes", "https://127.0.0.1/api/v1/nodes", "https://evil.test:8443/"} {
		bad := httptest.NewRequest("GET", target, nil)
		out := httptest.NewRecorder()
		handler.ServeHTTP(out, bad)
		if out.Code != 400 && out.Code != 426 {
			t.Fatalf("invalid ingress accepted: %s %d", target, out.Code)
		}
	}
	for _, target := range []string{"http://example.test:18910", "https://127.0.0.1:18910", "http://localhost:18910", "http://127.0.0.1:18910/private", "http://user@127.0.0.1:18910"} {
		if _, err := newReachHandler("127.0.0.1", target); err == nil {
			t.Fatalf("untrusted upstream accepted: %s", target)
		}
	}
}

func TestOtherApplicationsNeverReceiveOrOverwriteReachCookie(t *testing.T) {
	p, token := testPlatform(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := r.Cookie(reachCookie); err == nil {
			t.Error("Reach cookie leaked to another application")
		}
		w.Header().Add("Set-Cookie", "reach_session=forged; Path=/; Max-Age=0")
		w.Header().Add("Set-Cookie", "app_session=kept; Path=/; HttpOnly")
		_, _ = w.Write([]byte("ok"))
	}))
	defer upstream.Close()
	p.edge = reverseProxy(upstream.URL)
	p.arena = reverseProxy(upstream.URL)
	p.rainflow = reverseProxy(upstream.URL)
	t.Setenv("SHIFT_UPSTREAM", upstream.URL)
	secretFile := filepath.Join(t.TempDir(), "shift-token")
	if err := os.WriteFile(secretFile, []byte(strings.Repeat("s", 40)), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHIFT_PROXY_TOKEN_FILE", secretFile)
	for _, row := range []struct{ role, path string }{{"primary", "/handwave/api/models"}, {"primary", "/omp/"}, {"arena", "/arena/api/me"}, {"rainflow", "/api/positions/latest"}, {"primary", "/shift/api/v1/workspace"}} {
		r := testRequest("GET", row.path, token)
		r.AddCookie(&http.Cookie{Name: reachCookie, Value: "private-reach"})
		w := httptest.NewRecorder()
		p.handler(row.role).ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("%s %s: %d", row.role, row.path, w.Code)
		}
		cookies := w.Result().Cookies()
		if len(cookies) != 1 || cookies[0].Name != "app_session" {
			t.Fatalf("wrong cookie boundary: %v", cookies)
		}
	}
}

func TestReachPortalOptInAndExistingEntries(t *testing.T) {
	p, token := testPlatform(t)
	for _, value := range []string{"", "https://127.0.0.1:8443", "https://evil.test:8443", "http://127.0.0.1:8443", "https://127.0.0.1:8443/?token=secret"} {
		t.Setenv("REACH_PORTAL_ORIGIN", value)
		w := httptest.NewRecorder()
		p.handler("primary").ServeHTTP(w, testRequest("GET", "/", token))
		if w.Code != 200 {
			t.Fatal(w.Code)
		}
		for _, label := range []string{"Shift", "HandWave", "OMP Manager", "Code Arena", "RainFlow"} {
			if !strings.Contains(w.Body.String(), label) {
				t.Fatalf("missing original entry %s", label)
			}
		}
		has := strings.Contains(w.Body.String(), ">Reach<br>")
		if has != (value == "https://127.0.0.1:8443") {
			t.Fatalf("incorrect Reach opt-in: %q", value)
		}
	}
}

func TestReachListenerFailureDoesNotStopExistingIngress(t *testing.T) {
	// Separate Reach process mode owns its listener. Its error never enters the
	// existing Ray listener error channel. Exercise a real bind failure.
	occupied, err := net.Listen("tcp", ":8443")
	if err != nil {
		t.Fatalf("cannot reserve test port: %v", err)
	}
	defer occupied.Close()
	existing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "existing-ingress-alive") }))
	defer existing.Close()
	tlsFixture := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer tlsFixture.Close()
	certificate := tlsFixture.TLS.Certificates[0]
	key, err := x509.MarshalPKCS8PrivateKey(certificate.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")
	if err = os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Certificate[0]}), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}), 0600); err != nil {
		t.Fatal(err)
	}
	if err = runReachIngress(config{PublicIP: "127.0.0.1", TLSCert: certPath, TLSKey: keyPath}); err == nil {
		t.Fatal("occupied Reach port unexpectedly started")
	}
	response, err := http.Get(existing.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if string(body) != "existing-ingress-alive" {
		t.Fatal("existing ingress changed")
	}
	// TLS boundary is real in the independent handler, not inferred from a header.
	handler, err := newReachHandler("127.0.0.1", existing.URL)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "https://127.0.0.1:8443/", nil)
	req.TLS = &tls.ConnectionState{}
	out := httptest.NewRecorder()
	handler.ServeHTTP(out, req)
	if out.Code != 200 {
		t.Fatal(out.Code)
	}
}
