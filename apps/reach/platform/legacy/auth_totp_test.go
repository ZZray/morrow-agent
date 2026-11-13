package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestTOTPVerifyWindow(t *testing.T) {
	secret := []byte("0123456789abcdef0123")
	now := time.Now()
	cur := totpCode(secret, now)
	if _, ok := totpVerify(secret, cur, now); !ok {
		t.Fatal("current code rejected")
	}
	if _, ok := totpVerify(secret, totpCode(secret, now.Add(-totpPeriod)), now); !ok {
		t.Fatal("previous-window code rejected")
	}
	if _, ok := totpVerify(secret, totpCode(secret, now.Add(totpPeriod)), now); !ok {
		t.Fatal("next-window code rejected")
	}
	if _, ok := totpVerify(secret, totpCode(secret, now.Add(-3*totpPeriod)), now); ok {
		t.Fatal("stale code accepted")
	}
	if _, ok := totpVerify(secret, "12345", now); ok {
		t.Fatal("short code accepted")
	}
	if _, ok := totpVerify([]byte("other-secret-0123"), cur, now); ok {
		t.Fatal("code from other secret accepted")
	}
}

func totpLogin(t *testing.T, h *hubSrv) (mode, preauth, secret string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/auth/login", strings.NewReader(`{"token":"root-token"}`))
	h.authLoginH(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("login code=%d body=%s", rec.Code, rec.Body.String())
	}
	var j struct {
		OK      bool   `json:"ok"`
		TOTP    string `json:"totp"`
		Preauth string `json:"preauth"`
		Secret  string `json:"secret"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &j); err != nil {
		t.Fatal(err)
	}
	return j.TOTP, j.Preauth, j.Secret
}

func totpSubmit(t *testing.T, h *hubSrv, preauth, code string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	body, _ := json.Marshal(map[string]string{"preauth": preauth, "code": code})
	req := httptest.NewRequest("POST", "/auth/totp", strings.NewReader(string(body)))
	h.totpH(rec, req)
	return rec
}

func TestTOTPLoginFlow(t *testing.T) {
	t.Setenv("HW_CONF", t.TempDir())
	h := &hubSrv{token: "root-token"}

	mode, pre, secretB32 := totpLogin(t, h)
	if mode != "enroll" || pre == "" || secretB32 == "" {
		t.Fatalf("first login stage: mode=%q pre=%q secret=%q", mode, pre, secretB32)
	}

	// 错误验证码：拒绝且不发 cookie
	if rec := totpSubmit(t, h, pre, "000000"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong code code=%d", rec.Code)
	}
	recWrong := totpSubmit(t, h, pre, "000000")
	if recWrong.Header().Get("Set-Cookie") != "" {
		t.Fatal("wrong code set a cookie")
	}

	// 预授权一次性：重用已消费的 pre 应失败
	if _, pre2, _ := totpLogin(t, h); pre2 == pre {
		t.Fatal("preauth reused across logins")
	}

	// 正确验证码：绑定 + 发会话 cookie（enroll 每次登录生成新待绑定密钥，须用当次的）
	mode, pre, bindB32 := totpLogin(t, h)
	bindSecret, err := totpB32.DecodeString(bindB32)
	if err != nil {
		t.Fatal(err)
	}
	rec := totpSubmit(t, h, pre, totpCode(bindSecret, time.Now()))
	if rec.Code != http.StatusOK {
		t.Fatalf("bind code=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Set-Cookie") == "" {
		t.Fatal("bind did not set session cookie")
	}

	// 已绑定：再次登录进入 verify 阶段；绑定已占用当前计数器，故用下一窗口码
	mode, pre, secret2 := totpLogin(t, h)
	if mode != "verify" || secret2 != "" {
		t.Fatalf("second login stage: mode=%q secret=%q", mode, secret2)
	}
	nextCode := totpCode(bindSecret, time.Now().Add(totpPeriod))
	if rec := totpSubmit(t, h, pre, nextCode); rec.Code != http.StatusOK {
		t.Fatalf("verify code=%d", rec.Code)
	}
	if rec := totpSubmit(t, h, pre, "000000"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("verify wrong code code=%d", rec.Code)
	}

	// 重放守卫：同一验证码（同计数器）再次登录应被拒
	_, preReplay, _ := totpLogin(t, h)
	if rec := totpSubmit(t, h, preReplay, nextCode); rec.Code != http.StatusUnauthorized {
		t.Fatalf("replayed code accepted: code=%d", rec.Code)
	}
}
