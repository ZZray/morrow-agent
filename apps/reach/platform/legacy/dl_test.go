package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDownloadLabelsARMLinuxUbuntu(t *testing.T) {
	dir := t.TempDir()
	name := "handwave-linux-arm64.zip"
	if err := os.WriteFile(filepath.Join(dir, name), []byte("not-a-real-zip"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := &hubSrv{token: "tk", dl: &dlRegistry{dir: dir}}
	mux := http.NewServeMux()
	h.routes(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/download")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	page := string(body)
	for _, want := range []string{
		"ARM Linux（Ubuntu）",
		"handwave-linux-arm64.zip",
		`href="/dl/file?f=handwave-linux-arm64.zip"`,
		"node --daemon",
		"node uninstall",
		"node autostart",
	} {
		if !strings.Contains(page, want) {
			t.Fatalf("download page missing %q", want)
		}
	}
	if strings.Contains(page, `class="os">linux-arm64<`) {
		t.Fatal("raw linux-arm64 must not be the visible platform title")
	}
}
