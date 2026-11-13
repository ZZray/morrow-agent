// Copyright (c) Ray Zhang.
package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDeskStateRejectsInvalidLocations(t *testing.T) {
	original := deskStateDir
	t.Cleanup(func() { deskStateDir = original })
	t.Setenv("HW_CONF", t.TempDir())
	blocked := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocked, []byte("occupied"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"", "relative", blocked, filepath.Join(blocked, "child")} {
		deskStateDir = ""
		if err := configureDeskState(path); err == nil {
			t.Fatalf("accepted invalid state path %q", path)
		}
		if deskStateDir != "" {
			t.Fatalf("selected invalid state path %q", deskStateDir)
		}
	}
}

func TestDeskStateNeverFallsBackAfterDirectoryLoss(t *testing.T) {
	original := deskStateDir
	t.Cleanup(func() { deskStateDir = original })
	legacy := t.TempDir()
	t.Setenv("HW_CONF", legacy)
	if err := os.WriteFile(filepath.Join(legacy, "hub.conf"), []byte("token=legacy-sentinel"), 0o600); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(t.TempDir(), "desk")
	if err := configureDeskState(state); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(state); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(state, []byte("directory replaced"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Even an inherited legacy setting cannot redirect the pinned Desk state.
	t.Setenv("HW_CONF", legacy)
	if got := confDir(); got != state {
		t.Fatalf("state redirected to %q", got)
	}
	if got := readConf("hub.conf")["token"]; got != "" {
		t.Fatal("read legacy state after directory loss")
	}
}
