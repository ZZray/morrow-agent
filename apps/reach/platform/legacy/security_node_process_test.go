package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func securityTLSFixture(t *testing.T) (tls.Certificate, []byte) {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "isolated-security-fixture-ca"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "isolated-node-server"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour), BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	pair, err := tls.X509KeyPair(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}))
	if err != nil {
		t.Fatal(err)
	}
	return pair, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
}

// This is a real delivered-Node test, kept opt-in so normal Go-only contributors
// need not build another repository. Release evidence must explicitly run it.
func TestSecurityActualRustNodeTLS(t *testing.T) {
	binary := os.Getenv("HW_SECURITY_NODE_BINARY")
	if binary == "" {
		t.Skip("set HW_SECURITY_NODE_BINARY to the delivered standalone Rust Node")
	}
	for _, mode := range []string{"trusted", "trusted-proxy", "untrusted", "untrusted-proxy", "wrong-host", "redirect"} {
		t.Run(mode, func(t *testing.T) {
			h, _ := newIdentityFixtureHub(t)
			var requests, plainRequests, tlsConnections, proxyRequests atomic.Int32
			plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { plainRequests.Add(1); w.WriteHeader(500) }))
			defer plain.Close()
			tlsServer := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if mode == "redirect" {
					http.Redirect(w, r, plain.URL+"/ws?role=node", 302)
					return
				}
				h.wrapWS(h.wsH)(w, r)
			}))
			tlsServer.Config.ConnState = func(_ net.Conn, state http.ConnState) {
				if state == http.StateNew {
					tlsConnections.Add(1)
				}
			}
			pair, caPEM := securityTLSFixture(t)
			tlsServer.TLS = &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{pair}}
			tlsServer.StartTLS()
			defer tlsServer.Close()
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				proxyRequests.Add(1)
				if r.Method != "CONNECT" || r.Host != tlsServer.Listener.Addr().String() {
					http.Error(w, "target", 403)
					return
				}
				upstream, err := net.DialTimeout("tcp", tlsServer.Listener.Addr().String(), time.Second)
				if err != nil {
					http.Error(w, "connect", 502)
					return
				}
				defer upstream.Close()
				client, buffer, err := w.(http.Hijacker).Hijack()
				if err != nil {
					return
				}
				defer client.Close()
				fmt.Fprint(buffer, "HTTP/1.1 200 Connection Established\r\n\r\n")
				if buffer.Flush() != nil {
					return
				}
				go func() { _, _ = io.Copy(upstream, buffer); _ = upstream.Close() }()
				_, _ = io.Copy(client, upstream)
			}))
			defer proxy.Close()
			dir := t.TempDir()
			certPath := filepath.Join(dir, "ca.pem")
			cert := caPEM
			if strings.HasPrefix(mode, "untrusted") {
				_, cert = securityTLSFixture(t)
			}
			if err := os.WriteFile(certPath, cert, 0600); err != nil {
				t.Fatal(err)
			}
			endpoint := tlsServer.URL
			if mode == "wrong-host" {
				endpoint = strings.Replace(endpoint, "127.0.0.1", "localhost", 1)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, binary, "--hub", endpoint, "--token", "fixture-node", "--cwd", dir, "--state-dir", filepath.Join(dir, "state"))
			for _, value := range os.Environ() {
				key := strings.ToUpper(strings.SplitN(value, "=", 2)[0])
				if strings.HasPrefix(key, "HW_") || strings.Contains(key, "PROXY") || key == "SSL_CERT_FILE" || key == "SSL_CERT_DIR" {
					continue
				}
				cmd.Env = append(cmd.Env, value)
			}
			cmd.Env = append(cmd.Env, "NO_PROXY=*", "SSL_CERT_FILE="+certPath, "SSL_CERT_DIR="+dir)
			if strings.HasSuffix(mode, "-proxy") {
				cmd.Env = append(cmd.Env, "NO_PROXY=", "HTTPS_PROXY="+proxy.URL)
			}
			var output bytes.Buffer
			cmd.Stdout, cmd.Stderr = &output, &output
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			joined := false
			deadline := time.Now().Add(3 * time.Second)
			for time.Now().Before(deadline) {
				h.mu.Lock()
				joined = len(h.nodes) > 0
				h.mu.Unlock()
				if joined {
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
			cancel()
			_ = cmd.Wait()
			trusted := strings.HasPrefix(mode, "trusted")
			if trusted && !joined {
				t.Fatalf("trusted TLS/signed join failed: %s", output.String())
			}
			if !trusted && joined {
				t.Fatal("unsafe connection joined Hub")
			}
			if (strings.HasPrefix(mode, "untrusted") || mode == "wrong-host") && requests.Load() != 0 {
				t.Fatal("bearer sent before certificate verification")
			}
			if (strings.HasPrefix(mode, "untrusted") || mode == "wrong-host") && (tlsConnections.Load() == 0 || !strings.Contains(strings.ToLower(output.String()), "certificate")) {
				t.Fatalf("certificate rejection was not actually observed: connections=%d output=%s", tlsConnections.Load(), output.String())
			}
			if mode == "wrong-host" && !strings.Contains(strings.ToLower(output.String()), "certificate not valid for name") {
				t.Fatalf("hostname mismatch not observed: %s", output.String())
			}
			if mode == "redirect" && (requests.Load() == 0 || plainRequests.Load() != 0) {
				t.Fatal("TLS redirect either not attempted or downgraded")
			}
			if strings.HasSuffix(mode, "-proxy") && proxyRequests.Load() == 0 {
				t.Fatal("secure proxy route was not exercised")
			}
			if strings.Contains(output.String(), "fixture-node") {
				t.Fatal("credential appeared in diagnostics")
			}
		})
	}
}
