package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
)

func validateControllerTransport(address string) error {
	u, err := url.Parse(address)
	if err != nil || u.Hostname() == "" || u.User != nil {
		return errors.New("invalid HandWave WebSocket URL")
	}
	if u.Scheme == "wss" {
		return nil
	}
	if ip := net.ParseIP(u.Hostname()); u.Scheme == "ws" && ip != nil && ip.IsLoopback() {
		return nil
	}
	return errors.New("HandWave requires WSS; plaintext WS is permitted only for literal loopback development endpoints")
}

func websocketHTTPClient(base *http.Client) *http.Client {
	client := *base
	// Validate the one intended endpoint. A redirect must never carry bearer
	// credentials to a downgraded transport or a different application.
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &client
}

// This product has one shared administrator authority. A browser fingerprint is
// a display label, never a claim of ownership. Different root authorities must
// not share an owner; rotating the root token intentionally changes this ID.
func (h *hubSrv) controllerIdentity() string {
	sum := sha256.Sum256([]byte("handwave-shared-admin-v1\x00" + h.token))
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(sum[:20])
}

func validSocketOrigin(r *http.Request) bool {
	values := r.Header.Values("Origin")
	if len(values) == 0 {
		// Native bearer clients and the already-verified Ray server hop do not
		// use browser cookies. Browsers always send Origin when opening a WS.
		return false
	}
	if len(values) != 1 {
		return false
	}
	u, err := url.Parse(values[0])
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return err == nil && u.Scheme == scheme && u.Host == r.Host && u.User == nil &&
		u.Path == "" && u.RawQuery == "" && u.Fragment == ""
}

func (h *hubSrv) socketOriginAllowed(r *http.Request) bool {
	if len(r.Header.Values("Origin")) != 0 {
		return validSocketOrigin(r)
	}
	// An absent Origin is a native/server exception only after independent
	// bearer verification. authOK's browser-cookie fallback cannot grant it.
	values := r.Header.Values("Authorization")
	if len(values) != 1 || len(values[0]) <= 7 || !strings.EqualFold(values[0][:7], "Bearer ") {
		return false
	}
	token := values[0][7:]
	if h.token != "" && subtle.ConstantTimeCompare([]byte(token), []byte(h.token)) == 1 {
		return true
	}
	return r.URL.Query().Get("role") == "node" && h.nodeTok != "" && subtle.ConstantTimeCompare([]byte(token), []byte(h.nodeTok)) == 1
}
