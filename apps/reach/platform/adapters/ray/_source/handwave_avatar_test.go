package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestAssistantAvatarMaintainedRelease(t *testing.T) {
	f, err := os.Open("../../../handwave/release-web/stable-web-f2a01bedb53562b8.tar.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	defer z.Close()
	archive := tar.NewReader(z)
	for {
		h, err := archive.Next()
		if err != nil {
			t.Fatal("maintained app missing", err)
		}
		if h.Name != "app.js" {
			continue
		}
		body, err := io.ReadAll(archive)
		if err != nil {
			t.Fatal(err)
		}
		r := scriptResponse("/handwave/app.js", string(body))
		r.StatusCode = 200
		if err = adaptHandWaveAvatar(r); err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(r.Body)
		if err != nil || bytes.Count(got, []byte("function makeHandWaveAssistantAvatar(")) != 1 {
			t.Fatal("maintained avatar missing", err)
		}
		if out := os.Getenv("RAY_AVATAR_MAINTAINED_APP_OUT"); out != "" {
			if err := os.WriteFile(out, got, 0600); err != nil {
				t.Fatal(err)
			}
		}
		return
	}
}

func TestAssistantAvatarAssetAndGate(t *testing.T) {
	if fmt.Sprintf("%x", sha256.Sum256(handWaveAssistantAvatar)) != handWaveAvatarSHA {
		t.Fatal("unreviewed avatar bytes")
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(handWaveAssistantAvatar))
	if err != nil || cfg.Width < 256 || cfg.Width != cfg.Height || cfg.Width > 2048 {
		t.Fatalf("unexpected avatar: %+v %v", cfg, err)
	}
	t.Logf("PNG %dx%d, %d bytes", cfg.Width, cfg.Height, len(handWaveAssistantAvatar))
	image, err := png.Decode(bytes.NewReader(handWaveAssistantAvatar))
	if err != nil {
		t.Fatal(err)
	}
	for _, point := range [][2]int{{0, 0}, {cfg.Width - 1, 0}, {0, cfg.Height - 1}, {cfg.Width - 1, cfg.Height - 1}} {
		if _, _, _, alpha := image.At(point[0], point[1]).RGBA(); alpha != 0 {
			t.Fatal("brand icon must retain transparent corners")
		}
	}
	if _, _, _, alpha := image.At(cfg.Width/2, cfg.Height/2).RGBA(); alpha == 0 {
		t.Fatal("brand character is empty")
	}
	p, token := testPlatform(t)
	for _, method := range []string{"GET", "HEAD"} {
		w := httptest.NewRecorder()
		p.handler("primary").ServeHTTP(w, testRequest(method, handWaveAvatarPath, token))
		if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" || w.Header().Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(w.Header().Get("Cache-Control"), "private") {
			t.Fatalf("asset %s: %d %v", method, w.Code, w.Header())
		}
		if method == "GET" && !bytes.Equal(w.Body.Bytes(), handWaveAssistantAvatar) || method == "HEAD" && w.Body.Len() != 0 {
			t.Fatal("GET/HEAD body changed")
		}
	}
	w := httptest.NewRecorder()
	p.handler("primary").ServeHTTP(w, testRequest("GET", handWaveAvatarPath, ""))
	if w.Code != http.StatusSeeOther {
		t.Fatalf("unauthenticated asset: %d", w.Code)
	}
	r := testRequest("GET", handWaveAvatarPath, token)
	r.Header.Set("If-None-Match", `"`+handWaveAvatarSHA+`"`)
	w = httptest.NewRecorder()
	p.handler("primary").ServeHTTP(w, r)
	if w.Code != 304 || w.Body.Len() != 0 {
		t.Fatal("ETag conditional response failed")
	}
	w = httptest.NewRecorder()
	if !serveHandWaveAvatar(w, testRequest("POST", handWaveAvatarPath, "")) || w.Code != 405 || w.Header().Get("Allow") != "GET, HEAD" {
		t.Fatal("asset method contract")
	}
	for _, path := range []string{"/ray/assets/unknown.png", "/ray/assets/../bridge.json", handWaveAvatarPath + "/other"} {
		if serveHandWaveAvatar(httptest.NewRecorder(), testRequest("GET", path, "")) {
			t.Fatal("generic path accepted")
		}
	}
}

func TestAssistantAvatarCreationSites(t *testing.T) {
	source := "function addBubble(role, content, extra) {\n" +
		"row.appendChild(el('span', 'msg-ava', 'hw'));\n" +
		"const ava = el('span', 'msg-ava loading');\n  ava.textContent = 'hw';\n" +
		"const avatar = el('span', 'agent-avatar', (a.name || 'A').slice(0, 1).toUpperCase());\n}"
	got, err := adaptHandWaveAvatarScript([]byte(source))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"makeHandWaveAssistantAvatar('msg-ava')", "makeHandWaveAssistantAvatar('msg-ava loading')", "a.id === 'local' ? makeHandWaveAssistantAvatar('agent-avatar')", handWaveAvatarPath} {
		if !bytes.Contains(got, []byte(want)) {
			t.Fatal("missing", want)
		}
	}
	if bytes.Contains(got, []byte("ava.textContent = 'hw'")) || bytes.Contains(got, []byte("@AVATAR_PATH@")) {
		t.Fatal("image cleared or unbound")
	}
	if _, err := adaptHandWaveAvatarScript([]byte(strings.Replace(source, "row.appendChild", "row.prepend", 1))); err == nil {
		t.Fatal("source drift accepted")
	}
	if _, err := adaptHandWaveAvatarScript([]byte(source + source)); err == nil {
		t.Fatal("duplicate creation sites accepted")
	}
}

func TestAssistantAvatarCompleteAdapter(t *testing.T) {
	// This is the pinned Edge-to-Ray input, not the older raw Hub archive.
	body, err := os.ReadFile("testdata/handwave-app-7ae318fe.js")
	if err != nil {
		t.Fatal(err)
	}
	r := scriptResponse("/handwave/app.js", string(body))
	r.StatusCode = 200
	if err = adaptHandWaveAvatar(r); err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Count(got, []byte("function makeHandWaveAssistantAvatar(")) != 1 || !bytes.Contains(got, []byte(rayAgentStatus)) || r.ContentLength != int64(len(got)) || r.Header.Get("ETag") != "" || r.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("full adapter/security/length contract")
	}
	if out := os.Getenv("RAY_AVATAR_APP_OUT"); out != "" {
		if err := os.WriteFile(out, got, 0600); err != nil {
			t.Fatal(err)
		}
	}
	r = scriptResponse("/handwave/style.css", "body{}")
	r.StatusCode = 200
	r.Header.Set("Content-Type", "text/css")
	if err = adaptHandWaveAvatar(r); err != nil {
		t.Fatal(err)
	}
	got, _ = io.ReadAll(r.Body)
	if bytes.Count(got, handWaveAvatarCSS) != 1 {
		t.Fatal("avatar CSS missing")
	}
	for _, status := range []int{206, 304, 404} {
		r = scriptResponse("/handwave/style.css", "unchanged")
		r.Header.Set("Content-Type", "text/css")
		r.StatusCode = status
		if err := adaptHandWaveAvatar(r); err != nil {
			t.Fatal(err)
		}
		got, _ = io.ReadAll(r.Body)
		if string(got) != "unchanged" {
			t.Fatal("non-complete response altered")
		}
	}
}
