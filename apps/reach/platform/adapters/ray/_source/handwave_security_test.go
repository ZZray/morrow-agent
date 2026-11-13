package main

import (
	"ara/apps/handwave/websafe"
	"archive/tar"
	"bytes"
	"compress/gzip"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestHandWaveSecurityAdapterRejectsDrift(t *testing.T) {
	for _, source := range []string{"function escHtml(s) { changed }", "function showToast(changed) {}"} {
		if _, err := adaptHandWaveSecurity([]byte(source)); err == nil {
			t.Fatal("unreviewed security call site accepted")
		}
	}
	source := []byte("unrelated script")
	got, err := adaptHandWaveSecurity(source)
	if err != nil || !bytes.Equal(got, source) {
		t.Fatal("unrelated source changed")
	}
}

func TestHandWaveSecurityFinalAdapterRegression(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is required for the executable security fixture")
	}
	archive, err := os.Open(filepath.Join("..", "..", "..", "handwave", "release-web", "stable-web-f2a01bedb53562b8.tar.gz"))
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	z, err := gzip.NewReader(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer z.Close()
	reader := tar.NewReader(z)
	assets := map[string][]byte{}
	for {
		h, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if h.Name == "app.js" || h.Name == "render.js" {
			assets[h.Name], err = io.ReadAll(reader)
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	if len(assets["app.js"]) == 0 || len(assets["render.js"]) == 0 {
		t.Fatal("missing stable assets")
	}
	response := scriptResponse("/handwave/app.js", string(assets["app.js"]))
	if err := adaptHandWaveUI(response); err != nil {
		t.Fatal(err)
	}
	adapted, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	hubFixed, err := websafe.AdaptApp(assets["app.js"])
	if err != nil {
		t.Fatal(err)
	}
	fromHub := scriptResponse("/handwave/app.js", string(hubFixed))
	if err = adaptHandWaveUI(fromHub); err != nil {
		t.Fatal(err)
	}
	fromHubBody, err := io.ReadAll(fromHub.Body)
	if err != nil || !bytes.Equal(adapted, fromHubBody) {
		t.Fatal("Ray differs when upstream Hub has already repaired the script")
	}
	dir := t.TempDir()
	if path := os.Getenv("RAY_SECURITY_FIXTURE_OUT"); path != "" {
		dir = path
		if err = os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for name, data := range map[string][]byte{"render.js": assets["render.js"], "adapted-app.js": adapted} {
		if err = os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	cmd := exec.Command(node, "handwave_security.test.cjs", filepath.Join(dir, "render.js"), filepath.Join(dir, "adapted-app.js"), filepath.Join(dir, "browser.html"))
	output, err := cmd.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatal(err)
	}
}
