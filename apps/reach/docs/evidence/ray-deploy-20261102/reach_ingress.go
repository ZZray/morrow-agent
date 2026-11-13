// Copyright (c) Ray Zhang. Independent Reach ingress; no Ray identity bridge.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const reachCookie = "reach_session"

func selectRequestCookies(r *http.Request, keep func(string) bool) {
	var cookies []string
	for _, cookie := range r.Cookies() {
		if keep(cookie.Name) {
			cookies = append(cookies, cookie.Name+"="+cookie.Value)
		}
	}
	r.Header.Del("Cookie")
	if len(cookies) > 0 {
		r.Header.Set("Cookie", strings.Join(cookies, "; "))
	}
}

func selectResponseCookies(response *http.Response, keep func(string) bool) {
	values := response.Header.Values("Set-Cookie")
	response.Header.Del("Set-Cookie")
	for _, value := range values {
		cookie, err := http.ParseSetCookie(value)
		if err == nil && keep(cookie.Name) {
			response.Header.Add("Set-Cookie", value)
		}
	}
}

func excludeReachCookie(response *http.Response) error {
	selectResponseCookies(response, func(name string) bool { return name != reachCookie })
	return nil
}

// Different ports on one IP share cookies. Every other application must exclude
// Reach's cookie in both directions; Reach forwards only its own cookie.
func newReachHandler(publicIP, upstream string) (http.Handler, error) {
	u, err := url.Parse(upstream)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("Reach upstream must be a literal loopback HTTP origin")
	}
	if net.ParseIP(publicIP) == nil {
		return nil, errors.New("Reach public IP is invalid")
	}
	proxy := httputil.NewSingleHostReverseProxy(u)
	proxy.FlushInterval = -1
	proxy.ModifyResponse = func(response *http.Response) error {
		selectResponseCookies(response, func(name string) bool { return name == reachCookie })
		return nil
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":{"code":"reach_unavailable","message":"Reach 服务暂时不可用，请稍后重试"}}`))
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != net.JoinHostPort(publicIP, "8443") {
			http.Error(w, "invalid Reach host", http.StatusBadRequest)
			return
		}
		if r.TLS == nil {
			http.Error(w, "Reach requires HTTPS", http.StatusUpgradeRequired)
			return
		}
		client, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil || net.ParseIP(client) == nil {
			http.Error(w, "invalid client address", http.StatusBadRequest)
			return
		}
		r = r.Clone(r.Context())
		selectRequestCookies(r, func(name string) bool { return name == reachCookie })
		for name := range r.Header {
			lower := strings.ToLower(name)
			if strings.HasPrefix(lower, "x-ray-") || strings.HasPrefix(lower, "x-forwarded-") || lower == "forwarded" || lower == "x-reach-client-ip" {
				r.Header.Del(name)
			}
		}
		r.Header.Set("X-Reach-Client-IP", client)
		// Origin, X-Reach-CSRF and Authorization retain their original values.
		// Reach authenticates both browser and machine requests independently.
		proxy.ServeHTTP(w, r)
	}), nil
}

// Portal activation is separate from application deployment. Existing bridge.json
// remains compatible with the previous Ray binary during rollback.
func reachPortalOrigin(r *http.Request) string {
	value := os.Getenv("REACH_PORTAL_ORIGIN")
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Port() != "8443" {
		return ""
	}
	host := (&url.URL{Host: r.Host}).Hostname()
	if net.ParseIP(host) == nil || u.Hostname() != host {
		return ""
	}
	return value
}

func runReachIngress(cfg config) error {
	handler, err := newReachHandler(cfg.PublicIP, "http://127.0.0.1:18910")
	if err != nil {
		return err
	}
	cache := &certificateCache{cert: cfg.TLSCert, key: cfg.TLSKey}
	if _, err = cache.get(nil); err != nil {
		return err
	}
	listener, err := net.Listen("tcp", ":8443")
	if err != nil {
		return err
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 15 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 1 << 20}
	stopped := make(chan error, 1)
	go func() {
		stopped <- server.Serve(tls.NewListener(listener, &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: cache.get}))
	}()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	select {
	case err = <-stopped:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return server.Shutdown(shutdown)
}
