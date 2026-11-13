package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// The older reducer fixture and the maintained public release are different
// sources. Exercise the actual pinned release as well before publishing adapters.
func TestMaintainedReleaseRecoveryAdapter(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "handwave", "release-web")
	var manifest struct {
		Archive, SHA256 string
		Files           map[string]string
	}
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	bundle, err := os.ReadFile(filepath.Join(dir, manifest.Archive))
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(bundle)
	if hex.EncodeToString(digest[:]) != manifest.SHA256 {
		t.Fatal("stable Web archive changed")
	}
	z, err := gzip.NewReader(bytes.NewReader(bundle))
	if err != nil {
		t.Fatal(err)
	}
	defer z.Close()
	archive := tar.NewReader(z)
	var app []byte
	for {
		h, err := archive.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if h.Name == "app.js" {
			app, err = io.ReadAll(archive)
			if err != nil {
				t.Fatal(err)
			}
			break
		}
	}
	digest = sha256.Sum256(app)
	if len(app) == 0 || hex.EncodeToString(digest[:]) != manifest.Files["app.js"] {
		t.Fatal("stable app source missing or changed")
	}
	response := scriptResponse("/handwave/app.js", string(app))
	if err = adaptHandWaveUI(response); err != nil {
		t.Fatal(err)
	}
	result, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Count(result, handWaveRecoveryJS) != 1 {
		t.Fatal("stable release must include recovery exactly once")
	}
	if path := os.Getenv("RAY_MAINTAINED_REWRITTEN_APP_OUT"); path != "" {
		if err = os.WriteFile(path, result, 0600); err != nil {
			t.Fatal(err)
		}
	}
}
