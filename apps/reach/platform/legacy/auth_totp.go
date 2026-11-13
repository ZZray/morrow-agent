package main

// 工作台 TOTP 二次验证：微软 Authenticator / Google Authenticator 等扫码绑定，
// 之后登录 = 根令牌 + 定时一次性验证码（RFC 6238，HMAC-SHA1，30s，6 位，±1 窗口）。
//
//	POST /auth/login     令牌通过 → 返回 {ok, totp: enroll|verify, preauth}（不发会话 cookie）
//	GET  /auth/totp/qr   ?preauth= → 待绑定密钥的 otpauth:// QR（PNG，仅 enroll 阶段）
//	POST /auth/totp      {preauth, code} → enroll 校验后落盘密钥；verify 校验已绑定密钥；成功发会话 cookie
//
//	密钥存 confDir()/totp.key（0600，base32）。删除该文件可重置绑定。

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

const (
	totpPeriod   = 30 * time.Second
	totpPreTTL   = 5 * time.Minute
	totpKeyFile  = "totp.key"
	totpMinBytes = 16
)

type totpPre struct {
	exp    time.Time
	secret []byte // 仅 enroll 阶段：待绑定密钥
}

var totpB32 = base32.StdEncoding.WithPadding(base32.NoPadding)

func totpCounter(t time.Time) int64 {
	return t.Unix() / int64(totpPeriod.Seconds())
}

func totpCodeAt(secret []byte, counter int64) string {
	buf := make([]byte, 8)
	binary.BigEndian.PutUint64(buf, uint64(counter))
	mac := hmac.New(sha1.New, secret)
	mac.Write(buf)
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	code := (uint32(sum[off])&0x7f)<<24 | uint32(sum[off+1])<<16 | uint32(sum[off+2])<<8 | uint32(sum[off+3])
	return fmt.Sprintf("%06d", code%1000000)
}

func totpCode(secret []byte, t time.Time) string {
	return totpCodeAt(secret, totpCounter(t))
}

// totpVerify 校验 ±1 窗口，返回命中的计数器（供重放守卫）与是否通过。
func totpVerify(secret []byte, code string, now time.Time) (int64, bool) {
	code = strings.ReplaceAll(strings.TrimSpace(code), " ", "")
	if len(code) != 6 {
		return 0, false
	}
	base := totpCounter(now)
	for _, drift := range []int64{-1, 0, 1} {
		counter := base + drift
		if subtle.ConstantTimeCompare([]byte(totpCodeAt(secret, counter)), []byte(code)) == 1 {
			return counter, true
		}
	}
	return 0, false
}

// totpAcceptCounter 拒绝重放：同一计数器只能用一次。
func (h *hubSrv) totpAcceptCounter(counter int64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if counter <= h.totpLastCounter {
		return false
	}
	h.totpLastCounter = counter
	return true
}

func totpNewSecret() ([]byte, error) {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, nil
}

func otpauthURI(secret []byte) string {
	return "otpauth://totp/handwave:workbench?secret=" + totpB32.EncodeToString(secret) +
		"&issuer=handwave&algorithm=SHA1&digits=6&period=30"
}

// totpLoad 每次登录读盘（登录低频，不缓存），删文件即立即重置绑定。
func (h *hubSrv) totpLoad() []byte {
	raw, err := os.ReadFile(filepath.Join(confDir(), totpKeyFile))
	if err != nil {
		return nil
	}
	b, err := totpB32.DecodeString(strings.TrimSpace(strings.ToUpper(string(raw))))
	if err != nil || len(b) < totpMinBytes {
		return nil
	}
	return b
}

func (h *hubSrv) totpSave(secret []byte) error {
	return os.WriteFile(filepath.Join(confDir(), totpKeyFile), []byte(totpB32.EncodeToString(secret)), 0o600)
}

func (h *hubSrv) newTotpPre(pending []byte) string {
	sid := hexID() + hexID()
	h.mu.Lock()
	if h.totpPreauth == nil {
		h.totpPreauth = map[string]totpPre{}
	}
	now := time.Now()
	for k, v := range h.totpPreauth {
		if v.exp.Before(now) {
			delete(h.totpPreauth, k)
		}
	}
	h.totpPreauth[sid] = totpPre{exp: now.Add(totpPreTTL), secret: pending}
	h.mu.Unlock()
	return sid
}

func (h *hubSrv) takeTotpPre(sid string) (totpPre, bool) {
	h.mu.Lock()
	p, ok := h.totpPreauth[sid]
	if ok {
		delete(h.totpPreauth, sid)
	}
	h.mu.Unlock()
	if !ok || p.exp.Before(time.Now()) {
		return totpPre{}, false
	}
	return p, true
}

func (h *hubSrv) peekTotpPre(sid string) (totpPre, bool) {
	h.mu.Lock()
	p, ok := h.totpPreauth[sid]
	h.mu.Unlock()
	if !ok || p.exp.Before(time.Now()) {
		return totpPre{}, false
	}
	return p, true
}

// authLoginStage 在令牌校验通过后调用：决定 TOTP 阶段并签发预授权。
func (h *hubSrv) authLoginStage(w http.ResponseWriter) {
	enrolled := h.totpLoad() != nil
	var pending []byte
	mode := "verify"
	if !enrolled {
		sec, err := totpNewSecret()
		if err != nil {
			http.Error(w, `{"error":"secret"}`, http.StatusInternalServerError)
			return
		}
		pending = sec
		mode = "enroll"
	}
	pre := h.newTotpPre(pending)
	w.Header().Set("Content-Type", "application/json")
	out := map[string]any{"ok": true, "totp": mode, "preauth": pre}
	if mode == "enroll" {
		out["secret"] = totpB32.EncodeToString(pending)
	}
	_ = json.NewEncoder(w).Encode(out)
}

func (h *hubSrv) totpQRH(w http.ResponseWriter, r *http.Request) {
	p, ok := h.peekTotpPre(r.URL.Query().Get("preauth"))
	if !ok || p.secret == nil {
		http.Error(w, `{"error":"no pending enrollment"}`, http.StatusNotFound)
		return
	}
	png, err := qrcode.Encode(otpauthURI(p.secret), qrcode.Medium, 256)
	if err != nil {
		http.Error(w, `{"error":"qr"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(png)
}

func (h *hubSrv) totpH(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Preauth string `json:"preauth"`
		Code    string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad json"})
		return
	}
	p, ok := h.takeTotpPre(body.Preauth)
	if !ok {
		writeJSON(w, 401, map[string]string{"error": "预授权无效或已过期"})
		return
	}
	stored := h.totpLoad()
	if stored == nil {
		if p.secret == nil {
			writeJSON(w, 400, map[string]string{"error": "no pending enrollment"})
			return
		}
		counter, ok := totpVerify(p.secret, body.Code, time.Now())
		if !ok || !h.totpAcceptCounter(counter) {
			writeJSON(w, 401, map[string]string{"error": "验证码不正确或已使用"})
			return
		}
		if err := h.totpSave(p.secret); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		log.Printf("totp bound: new device enrollment")
	} else {
		counter, ok := totpVerify(stored, body.Code, time.Now())
		if !ok || !h.totpAcceptCounter(counter) {
			writeJSON(w, 401, map[string]string{"error": "验证码不正确或已使用"})
			return
		}
	}
	sid := h.newAuthSession()
	if sid == "" {
		http.Error(w, `{"error":"session"}`, http.StatusInternalServerError)
		return
	}
	h.setAuthCookie(w, sid)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
