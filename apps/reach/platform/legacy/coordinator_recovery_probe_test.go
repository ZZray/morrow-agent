package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestCoordinatorMissingJournalBlocksPendingRestore(t *testing.T) {
	a := newTestNodeAgent(t)
	s := a.hostSession()
	st := hostState{Version: hostStateVersion, NativeSessionID: "session_11111111111111111111111111111111", Pending: []hostPending{{ID: "delivery-kept", Kind: "follow_up", Text: "must not replay without journal"}}}
	raw, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(s.path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	restored := newHostSession(s.path, s.openStore)
	if restored.blockedErr() == nil {
		t.Error("missing journal must block rather than allow a fresh execution")
	}
	if n := restored.control.QueuedMessageCount(); n != 0 {
		t.Fatalf("unverified pending input was requeued despite missing journal: %d", n)
	}
}
