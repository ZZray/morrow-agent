package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
)

func scriptResponse(path, body string) *http.Response {
	return &http.Response{Request: &http.Request{Method: "GET", URL: &url.URL{Path: path}}, Header: http.Header{"Content-Type": []string{"text/javascript"}, "Etag": []string{"old"}}, Body: io.NopCloser(strings.NewReader(body))}
}

func TestHandWaveMainCardGuardPreservesToolTimeline(t *testing.T) {
	body := "function recordAgentEvent(evt) { const id = agentIdentity(evt); " + oldAgentStatus + " agentRun.events.push(evt); }"
	response := scriptResponse("/handwave/app.js", body)
	if err := adaptHandWaveUI(response); err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(response.Body)
	if !bytes.Contains(got, []byte(rayAgentStatus)) || !bytes.Contains(got, []byte("agentRun.events.push(evt)")) {
		t.Fatal("reducer/timeline contract changed")
	}
	if response.Header.Get("ETag") != "" || int64(len(got)) != response.ContentLength {
		t.Fatal("stale script validator/length")
	}
	other := scriptResponse("/arena/app.js", body)
	if err := adaptHandWaveUI(other); err != nil {
		t.Fatal(err)
	}
	got, _ = io.ReadAll(other.Body)
	if string(got) != body {
		t.Fatal("another application's JavaScript changed")
	}
	unknown := scriptResponse("/handwave/app.js", "unexpected new source")
	if adaptHandWaveUI(unknown) == nil {
		t.Fatal("silently accepted unreviewed reducer")
	}
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	gz.Write([]byte(body))
	gz.Close()
	response = scriptResponse("/handwave/app.js", "")
	response.Body = io.NopCloser(bytes.NewReader(compressed.Bytes()))
	response.Header.Set("Content-Encoding", "gzip")
	if err := adaptHandWaveUI(response); err != nil {
		t.Fatal(err)
	}
	got, _ = io.ReadAll(response.Body)
	if !bytes.Contains(got, []byte(rayAgentStatus)) || response.Header.Get("Content-Encoding") != "" {
		t.Fatal("gzip script adaptation failed")
	}
}

func TestActualDeployedHandWaveReducerAdapter(t *testing.T) {
	path := os.Getenv("RAY_DEPLOYED_APP_FIXTURE")
	if path == "" {
		path = "testdata/handwave-app-7ae318fe.js"
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	if hex.EncodeToString(digest[:]) != "7ae318fe13a6fd35cd652c3fed7ee51134ca7808d14aab8f1be0c18aa44a15b2" {
		t.Fatal("reviewed deployed HandWave fixture changed")
	}
	response := scriptResponse("/handwave/app.js", string(body))
	if err = adaptHandWaveUI(response); err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(response.Body)
	if bytes.Count(got, []byte(rayAgentStatus)) != 1 || bytes.Count(got, []byte(oldAgentStatus)) != 0 {
		t.Fatal("exact deployed reducer guard missing")
	}
	if bytes.Contains(got, []byte("// Show thinking panel for reasoning content")) || !bytes.Contains(got, []byte("stream.append(text);")) {
		t.Fatal("ordinary answer text still treated as reasoning, or streaming text removed")
	}
	for _, module := range [][]byte{handWaveMotionJS, handWaveContextJS, handWaveSuggestJS, handWaveMemoryJS, handWaveMemoryTransportJS, handWaveSettingsJS, handWaveLinksJS, handWaveMachineTargetJS, handWaveQueueJS, handWaveRecoveryJS} {
		if len(module) == 0 || bytes.Count(got, module) != 1 {
			t.Fatal("complete deployed script must contain each embedded module exactly once")
		}
	}
	if out := os.Getenv("RAY_REWRITTEN_APP_OUT"); out != "" {
		if err = os.WriteFile(out, got, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCompactModelMenuRejectsChangedSource(t *testing.T) {
	if _, err := compactModelMenu([]byte("function bindModelPicker() { unreviewed(); }")); err == nil {
		t.Fatal("unreviewed model picker accepted")
	}
	plain := []byte("unrelated script")
	got, err := compactModelMenu(plain)
	if err != nil || !bytes.Equal(plain, got) {
		t.Fatal("unrelated script changed")
	}
}

func TestComposerFocusStyleOnlyChangesCompleteStylesheet(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusPartialContent, http.StatusNotModified, http.StatusNotFound} {
		response := scriptResponse("/handwave/style.css", "/* existing stylesheet */")
		response.StatusCode = status
		response.Header.Set("Content-Type", "text/css; charset=utf-8")
		if err := adaptHandWaveUI(response); err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		if status == http.StatusOK {
			if !bytes.HasSuffix(body, []byte(composerFocusCSS)) || response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("ETag") != "" {
				t.Fatal("composer override/cache contract missing")
			}
		} else if string(body) != "/* existing stylesheet */" {
			t.Fatal("partial, cached or error entity changed")
		}
	}
	for _, item := range []struct{ path, method, media string }{
		{"/arena/style.css", "GET", "text/css"},
		{"/handwave/style.css", "HEAD", "text/css"},
		{"/handwave/style.css", "GET", "text/html"},
	} {
		response := scriptResponse(item.path, "unchanged")
		response.StatusCode = http.StatusOK
		response.Request.Method = item.method
		response.Header.Set("Content-Type", item.media)
		if err := adaptHandWaveUI(response); err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		if string(body) != "unchanged" {
			t.Fatal("unrelated response changed")
		}
	}
}

func TestHandWaveMotionBundleIsScopedAndPreservesFocusFix(t *testing.T) {
	css := scriptResponse("/handwave/style.css", "/* original */")
	css.StatusCode = http.StatusOK
	css.Header.Set("Content-Type", "text/css")
	if err := adaptHandWaveUI(css); err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(css.Body)
	if bytes.Count(body, handWaveMotionCSS) != 1 || !bytes.HasPrefix(body, []byte("/* original */")) || !bytes.HasSuffix(body, []byte(composerFocusCSS)) {
		t.Fatal("motion asset replaced original CSS or composer focus guard")
	}
	for _, module := range [][]byte{handWaveMotionCSS, handWaveContextCSS, handWaveMemoryCSS, handWaveScheduleCSS, handWaveSettingsCSS, handWaveLinksCSS, handWaveQueueCSS, handWaveRecoveryCSS, handWaveComposerCSS, []byte(composerFocusCSS)} {
		if len(module) == 0 || bytes.Count(body, module) != 1 {
			t.Fatal("complete stylesheet must contain each embedded module exactly once")
		}
	}
	js := scriptResponse("/app.js", oldAgentStatus)
	if err := adaptHandWaveUI(js); err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(js.Body)
	if bytes.Count(body, handWaveMotionJS) != 1 || !bytes.HasSuffix(body, handWaveRecoveryJS) || bytes.Count(body, handWaveQueueJS) != 1 || !bytes.Contains(body, handWaveContextJS) || !bytes.Contains(body, []byte(rayAgentStatus)) {
		t.Fatal("motion helper missing or existing reducer guard changed")
	}
	for _, module := range [][]byte{handWaveComposerMenuJS, handWaveScheduleJS} {
		if len(module) == 0 || bytes.Count(body, module) != 1 {
			t.Fatal("composer/schedule module missing or duplicated")
		}
	}
}

func TestHandWaveRecoveryAdapterPinsFaultBoundaries(t *testing.T) {
	body, err := os.ReadFile("testdata/handwave-app-7ae318fe.js")
	if err != nil {
		t.Fatal(err)
	}
	got, err := adaptHandWaveRecovery(body)
	if err != nil {
		t.Fatal(err)
	}
	for _, marker := range []string{"window.HandwaveRecovery.authRequired()", "window.HandwaveRecovery.checkToolFence(base, card, content)", "window.HandwaveRecovery.checkContinuation(toolBase)", "if (!toolSess.has(id)) return;", "window.HandwaveRecovery.streamIncomplete()", "finishAgentRun(interrupted ? 'interrupted'"} {
		if !bytes.Contains(got, []byte(marker)) {
			t.Fatalf("missing recovery boundary: %s", marker)
		}
	}
	changed := bytes.Replace(body, []byte("    await readyP;"), []byte("    await changedReady;"), 1)
	if _, err := adaptHandWaveRecovery(changed); err == nil {
		t.Fatal("accepted unreviewed transfer readiness boundary")
	}
}

func TestHandWaveContextPatchRejectsChangedSSE(t *testing.T) {
	if _, err := adaptHandWaveContext([]byte("async function consumeSSE(path, body, stream) { changed(); }")); err == nil {
		t.Fatal("unreviewed SSE renderer accepted")
	}
	plain := []byte("unrelated script")
	got, err := adaptHandWaveContext(plain)
	if err != nil || !bytes.Equal(plain, got) {
		t.Fatal("unrelated script changed")
	}
}

func TestHandWaveNodeBindingGuardIsVersioned(t *testing.T) {
	if _, err := adaptHandWaveNodeBinding([]byte("if (f.k === 'node-hello') { changed(); }")); err == nil {
		t.Fatal("unreviewed node binding accepted")
	}
	plain := []byte("unrelated script")
	got, err := adaptHandWaveNodeBinding(plain)
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatal("unrelated script changed")
	}
	body, err := os.ReadFile("testdata/handwave-app-7ae318fe.js")
	if err != nil {
		t.Fatal(err)
	}
	got, err = adaptHandWaveNodeBinding(body)
	if err != nil || bytes.Count(got, []byte("if (curWS !== boundWorkspace || curSess !== boundSession) return;")) != 1 {
		t.Fatal("node binding owner guard missing", err)
	}
}

func TestHandWaveContextBundlePreservesSourceAndScope(t *testing.T) {
	css := scriptResponse("/handwave/style.css", "/* original stylesheet */")
	css.StatusCode = http.StatusOK
	css.Header.Set("Content-Type", "text/css")
	if err := adaptHandWaveUI(css); err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(css.Body)
	if bytes.Count(body, handWaveContextCSS) != 1 || !bytes.HasPrefix(body, []byte("/* original stylesheet */")) || !bytes.HasSuffix(body, []byte(composerFocusCSS)) {
		t.Fatal("context view replaced original CSS or focus fix")
	}
	js := scriptResponse("/handwave/app.js", oldAgentStatus)
	if err := adaptHandWaveUI(js); err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(js.Body)
	if bytes.Count(body, handWaveContextJS) != 1 || !bytes.Contains(body, handWaveMotionJS) {
		t.Fatal("context/motion bundle missing")
	}
}
