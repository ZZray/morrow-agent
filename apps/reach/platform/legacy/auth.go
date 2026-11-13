package main

// 工作台全站认证：根令牌登录 → 会话 cookie；刷新/离开失效（见 web 端配合）。
//
//	POST /auth/login   {"token"} → Set-Cookie hwses（HttpOnly，无 Max-Age）
//	POST /auth/logout  清会话
//	GET  /auth/me      当前是否已登录

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

const (
	authCookie   = "hwses"
	authIdleTTL  = 2 * time.Hour // 服务端兜底 idle；刷新重登由前端强制 logout
)

func (h *hubSrv) ensureAuthMap() {
	if h.auths == nil {
		h.auths = map[string]time.Time{}
	}
}

func (h *hubSrv) newAuthSession() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	sid := hex.EncodeToString(b)
	h.mu.Lock()
	h.ensureAuthMap()
	now := time.Now()
	for k, exp := range h.auths {
		if exp.Before(now) {
			delete(h.auths, k)
		}
	}
	h.auths[sid] = now.Add(authIdleTTL)
	h.mu.Unlock()
	return sid
}

func (h *hubSrv) dropAuthSession(sid string) {
	if sid == "" {
		return
	}
	h.mu.Lock()
	delete(h.auths, sid)
	h.mu.Unlock()
}

func (h *hubSrv) touchAuth(sid string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.ensureAuthMap()
	exp, ok := h.auths[sid]
	if !ok {
		return false
	}
	if exp.Before(time.Now()) {
		delete(h.auths, sid)
		return false
	}
	h.auths[sid] = time.Now().Add(authIdleTTL)
	return true
}

func (h *hubSrv) authCookieOK(r *http.Request) bool {
	c, err := r.Cookie(authCookie)
	if err != nil || c.Value == "" {
		return false
	}
	return h.touchAuth(c.Value)
}

// authOK：根令牌 Bearer / ?token=，或有效工作台会话 cookie。node 入网令牌仅 wrapWS 使用。
func (h *hubSrv) authOK(r *http.Request) bool {
	if h.dev {
		return true
	}
	got := r.Header.Get("authorization")
	if len(got) > 7 && (got[:7] == "Bearer " || got[:7] == "bearer ") {
		got = got[7:]
	} else if len(got) > 7 {
		got = got[7:]
	} else {
		got = r.URL.Query().Get("token")
	}
	if got != "" && subtle.ConstantTimeCompare([]byte(got), []byte(h.token)) == 1 {
		return true
	}
	return h.authCookieOK(r)
}

func (h *hubSrv) setAuthCookie(w http.ResponseWriter, sid string) {
	http.SetCookie(w, &http.Cookie{
		Name:     authCookie,
		Value:    sid,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		// 无 Max-Age / Expires → 浏览器会话级；关浏览器即丢
	})
}

func (h *hubSrv) clearAuthCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     authCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
		SameSite: http.SameSiteLaxMode,
	})
}

func (h *hubSrv) authLoginH(w http.ResponseWriter, r *http.Request) {
	if h.dev {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	if r.Method == http.MethodGet {
		h.renderStatic(w, "login.html")
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	tok := body.Token
	if tok == "" {
		tok = r.FormValue("token")
	}
	if subtle.ConstantTimeCompare([]byte(tok), []byte(h.token)) != 1 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"令牌无效"}`))
		return
	}
	h.authLoginStage(w)
}

func (h *hubSrv) authLogoutH(w http.ResponseWriter, r *http.Request) {
	if h.dev {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"dev":true}`))
		return
	}
	if c, err := r.Cookie(authCookie); err == nil {
		h.dropAuthSession(c.Value)
	}
	h.clearAuthCookie(w)
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func (h *hubSrv) authMeH(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if h.dev {
		_, _ = w.Write([]byte(`{"ok":true,"dev":true}`))
		return
	}
	if h.authOK(r) {
		_, _ = w.Write([]byte(`{"ok":true}`))
		return
	}
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = w.Write([]byte(`{"ok":false}`))
}

// wrapAuth：API / 页面门禁（根令牌或会话 cookie）
func (h *hubSrv) wrapAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !h.authOK(r) {
			acc := r.Header.Get("Accept")
			if strings.Contains(acc, "text/html") {
				http.Redirect(w, r, "/home", http.StatusFound)
				return
			}
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}
