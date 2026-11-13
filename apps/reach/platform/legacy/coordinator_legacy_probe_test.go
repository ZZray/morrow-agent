package main

import (
	"ara/internal/agent"
	"os"
	"testing"
)

func reloadCoordinatorHost(a *nodeAgent) *hostSession {
	return newHostSession(a.hostStatePath(), func() (*agent.SessionStore, error) { return agent.OpenSessionStore(a.nativeSessionDir()) })
}

func TestCoordinatorLegacyPendingReloadDoesNotDuplicateQueue(t *testing.T) {
	a := newTestNodeAgent(t)
	raw := legacyHistoryJSON(t, completeLegacyHistory(), map[string]any{"steer": []string{"once"}})
	writeLegacyFile(t, raw)
	first := a.hostSession()
	if len(first.state.LegacyPausedQueue) != 1 {
		t.Fatal("fixture did not adopt initial pending queue")
	}
	next := reloadCoordinatorHost(a)
	if got := len(next.state.LegacyPausedQueue); got != 1 {
		t.Fatalf("restart duplicated paused queue: %d", got)
	}
}

func TestCoordinatorLegacyBackupConflictPreserved(t *testing.T) {
	a := newTestNodeAgent(t)
	raw := legacyHistoryJSON(t, completeLegacyHistory(), nil)
	source, sum := writeLegacyFile(t, raw)
	backup := source + ".backup-" + sum[:12]
	sentinel := []byte("existing backup must remain untouched")
	if err := os.WriteFile(backup, sentinel, 0600); err != nil {
		t.Fatal(err)
	}
	sess := a.hostSession()
	got, err := os.ReadFile(backup)
	if err != nil || string(got) != string(sentinel) {
		t.Fatalf("conflicting backup overwritten: %v", err)
	}
	if _, err := sess.importLegacyHistory("test-model"); err == nil {
		t.Fatal("conflicting backup must block import")
	}
}

func TestCoordinatorLegacyChangedSourceCannotReuseOldImport(t *testing.T) {
	a := newTestNodeAgent(t)
	raw := legacyHistoryJSON(t, completeLegacyHistory(), nil)
	source, _ := writeLegacyFile(t, raw)
	first := a.hostSession()
	if _, err := first.importLegacyHistory("test-model"); err != nil {
		t.Fatal(err)
	}
	changed := completeLegacyHistory()
	changed[1]["content"] = "different source transcript"
	if err := os.WriteFile(source, legacyHistoryJSON(t, changed, nil), 0600); err != nil {
		t.Fatal(err)
	}
	next := reloadCoordinatorHost(a)
	if next.blockedErr() != nil {
		return
	}
	if _, err := next.importLegacyHistory("test-model"); err == nil {
		t.Fatal("changed legacy source silently reused a prior native session")
	}
}
