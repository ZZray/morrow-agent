package memorystore

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func oid(n int) string { return fmt.Sprintf("%032x", n) }
func fresh(t *testing.T) *Store {
	t.Helper()
	s, e := New(filepath.Join(t.TempDir(), "memory.json"))
	if e != nil {
		t.Fatal(e)
	}
	return s
}
func save(t *testing.T, s *Store, scope, id, kind, text string, n int) Record {
	t.Helper()
	r, e := s.Write(scope, id, oid(n), "", 0, kind, "source", text)
	if e != nil {
		t.Fatal(e)
	}
	return r
}

func TestRevisionRetryHistoryAndRestart(t *testing.T) {
	s := fresh(t)
	r := save(t, s, "device", "A", "fact", "original", 1)
	if r.SourceHash != textHash("original") || r.SourceID != r.ID || r.Origin != "Ray_user_input" {
		t.Fatal(r)
	}
	again, e := s.Write("device", "A", oid(1), "", 0, "fact", "source", "original")
	if e != nil || again != r {
		t.Fatal(again, e)
	}
	if _, e = s.Write("device", "A", oid(1), "", 0, "fact", "source", "different"); !errors.Is(e, ErrConflict) {
		t.Fatal(e)
	}
	if _, e = s.Write("device", "B", oid(1), "", 0, "fact", "source", "original"); !errors.Is(e, ErrConflict) {
		t.Fatal(e)
	}
	r2, e := s.Write("device", "A", oid(2), r.ID, 1, "fact", "corrected", "replacement")
	if e != nil || r2.Revision != 2 || r2.CreatedAt != r.CreatedAt {
		t.Fatal(r2, e)
	}
	if _, e = s.Write("device", "A", oid(3), r.ID, 1, "fact", "stale", "bad"); !errors.Is(e, ErrConflict) {
		t.Fatal(e)
	}
	r3, e := s.Revoke("device", "A", oid(4), r.ID, 2)
	if e != nil || r3.Revision != 3 || r3.Status != "revoked" {
		t.Fatal(r3, e)
	}
	s, e = New(s.path)
	if e != nil {
		t.Fatal(e)
	}
	h, e := s.History("device", "A", r.ID)
	if e != nil || len(h) != 3 || h[0].Text != "original" || h[1].Text != "replacement" || h[2].Text != "replacement" {
		t.Fatal(h, e)
	}
	l, e := s.List("device", "A", false)
	if e != nil || len(l) != 0 {
		t.Fatal(l, e)
	}
	l, e = s.List("device", "A", true)
	if e != nil || len(l) != 1 || l[0].Status != "revoked" {
		t.Fatal(l, e)
	}
	again, e = s.Revoke("device", "A", oid(4), r.ID, 2)
	if e != nil || again != r3 {
		t.Fatal(again, e)
	}
	if _, e = s.Write("device", "A", oid(5), r.ID, 3, "fact", "revive", "forbidden"); !errors.Is(e, ErrConflict) {
		t.Fatal(e)
	}
	if _, e = s.History("device", "B", r.ID); !errors.Is(e, ErrNotFound) {
		t.Fatal(e)
	}
	if runtime.GOOS != "windows" {
		st, e := os.Stat(s.path)
		if e != nil || st.Mode().Perm() != 0600 {
			t.Fatal(st, e)
		}
	}
}

func TestDeviceIsolationExplicitProjectAndStableEpoch(t *testing.T) {
	s := fresh(t)
	a := save(t, s, "device", "A", "fact", "A private path", 1)
	save(t, s, "device", "B", "fact", "B private path", 2)
	p := save(t, s, "project", "P", "knowledge", "shared project rule", 3)
	save(t, s, "workspace", "ray", "preference", "workspace preference", 4)
	sa, _ := s.Snapshot("A", "W", "private")
	sb, _ := s.Snapshot("B", "W", "private")
	has := func(s Snapshot, id string) bool {
		for _, r := range s.Records {
			if r.ID == id {
				return true
			}
		}
		return false
	}
	if !has(sa, a.ID) || has(sb, a.ID) || has(sa, p.ID) || has(sb, p.ID) {
		t.Fatal(sa, sb)
	}
	b, e := s.GetBinding("W", "A")
	if e != nil || b.ProjectID != "" || b.Revision != 0 {
		t.Fatal(b, e)
	}
	b, e = s.BindProject("W", "A", "P", 0, oid(5))
	if e != nil || b.Revision != 1 {
		t.Fatal(b, e)
	}
	again, e := s.BindProject("W", "A", "P", 0, oid(5))
	if e != nil || again != b {
		t.Fatal(again, e)
	}
	sa, _ = s.Snapshot("A", "W", "shared")
	otherQuery, _ := s.Snapshot("A", "W", "unrelated query")
	otherWS, _ := s.Snapshot("A", "other", "shared")
	if !has(sa, p.ID) || has(otherWS, p.ID) || sa.Epoch != otherQuery.Epoch {
		t.Fatal(sa, otherQuery, otherWS)
	}
	sb, _ = s.Snapshot("B", "W", "shared")
	if has(sb, p.ID) {
		t.Fatal(sb)
	}
	_, e = s.BindProject("W", "B", "P", 0, oid(6))
	if e != nil {
		t.Fatal(e)
	}
	sb, _ = s.Snapshot("B", "W", "shared")
	if !has(sb, p.ID) || has(sb, a.ID) {
		t.Fatal(sb)
	}
	if _, e = s.BindProject("W", "A", "", 0, oid(7)); !errors.Is(e, ErrConflict) {
		t.Fatal(e)
	}
	_, e = s.BindProject("W", "A", "", 1, oid(8))
	if e != nil {
		t.Fatal(e)
	}
	left, _ := s.Snapshot("A", "W", "shared")
	if has(left, p.ID) || left.Epoch == sa.Epoch {
		t.Fatal(left)
	}
	before, _ := s.Snapshot("B", "W", "no match")
	_, e = s.Revoke("project", "P", oid(9), p.ID, 1)
	if e != nil {
		t.Fatal(e)
	}
	after, _ := s.Snapshot("B", "W", "no match")
	if has(after, p.ID) || after.Epoch == before.Epoch {
		t.Fatal(before, after)
	}
	s, e = New(s.path)
	if e != nil {
		t.Fatal(e)
	}
	afterRestart, _ := s.Snapshot("B", "W", "no match")
	if afterRestart.Epoch != after.Epoch || has(afterRestart, p.ID) {
		t.Fatal(afterRestart)
	}
}

func TestWriteFailureDoesNotChangeMemoryOrConsumeOperation(t *testing.T) {
	s := fresh(t)
	r := save(t, s, "device", "A", "fact", "before", 1)
	before, e := os.ReadFile(s.path)
	if e != nil {
		t.Fatal(e)
	}
	fault := errors.New("disk unavailable")
	s.writeFile = func(string, []byte) error { return fault }
	if _, e = s.Write("device", "A", oid(2), r.ID, 1, "fact", "title", "after"); !errors.Is(e, fault) {
		t.Fatal(e)
	}
	if _, e = s.Revoke("device", "A", oid(3), r.ID, 1); !errors.Is(e, fault) {
		t.Fatal(e)
	}
	if _, e = s.BindProject("W", "A", "P", 0, oid(4)); !errors.Is(e, fault) {
		t.Fatal(e)
	}
	l, _ := s.List("device", "A", false)
	b, _ := s.GetBinding("W", "A")
	if len(l) != 1 || l[0] != r || b.Revision != 0 || len(s.data.Operations) != 1 {
		t.Fatal(l, b)
	}
	after, _ := os.ReadFile(s.path)
	if string(before) != string(after) {
		t.Fatal("failed write changed disk")
	}
	s.writeFile = atomicWrite
	if _, e = s.Write("device", "A", oid(2), r.ID, 1, "fact", "title", "after"); e != nil {
		t.Fatal(e)
	}
}

func TestInputLimitsAndCorruptStoreFailClosed(t *testing.T) {
	s := fresh(t)
	for _, tc := range []struct{ scope, id, kind, title, text, op string }{
		{"personal", "A", "fact", "x", "x", oid(1)}, {"workspace", "other", "fact", "x", "x", oid(1)},
		{"device", "A", "unknown", "x", "x", oid(1)}, {"device", "A", "fact", strings.Repeat("界", 121), "x", oid(1)},
		{"device", "A", "fact", "x", strings.Repeat("a", 8193), oid(1)}, {"device", "A", "fact", "x", "  ", oid(1)},
		{"device", "A", "fact", "x", "x", "short"}, {"device", "A", "fact", "x", "x", strings.Repeat("z", 32)},
	} {
		if _, e := s.Write(tc.scope, tc.id, tc.op, "", 0, tc.kind, tc.title, tc.text); !errors.Is(e, ErrInvalid) {
			t.Fatal(tc, e)
		}
	}
	if _, e := s.Snapshot("A", "W", strings.Repeat("x", 65537)); !errors.Is(e, ErrInvalid) {
		t.Fatal(e)
	}
	r := save(t, s, "device", "A", "fact", "secret", 1)
	d := s.clone()
	d.Records[0].Text = "tampered"
	raw, _ := json.Marshal(d)
	os.WriteFile(s.path, raw, 0600)
	if _, e := New(s.path); !errors.Is(e, ErrInvalid) {
		t.Fatal(e)
	}
	d = s.clone()
	d.Records[0].ID = r.ID
	d.Records[0].Revision = 2
	raw, _ = json.Marshal(d)
	os.WriteFile(s.path, raw, 0600)
	if _, e := New(s.path); !errors.Is(e, ErrInvalid) {
		t.Fatal(e)
	}
	os.WriteFile(s.path, []byte(strings.Repeat("x", maxFile+1)), 0600)
	if _, e := New(s.path); !errors.Is(e, ErrLimit) {
		t.Fatal(e)
	}
}

func TestSnapshotBoundsAndCASConcurrency(t *testing.T) {
	s := fresh(t)
	r := save(t, s, "device", "A", "fact", "initial", 1)
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i := 2; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, e := s.Write("device", "A", oid(i), r.ID, 1, "fact", "title", fmt.Sprint(i))
			errs <- e
		}(i)
	}
	wg.Wait()
	close(errs)
	success, conflict := 0, 0
	for e := range errs {
		if e == nil {
			success++
		} else if errors.Is(e, ErrConflict) {
			conflict++
		} else {
			t.Fatal(e)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal(success, conflict)
	}
	for i := 10; i < 50; i++ {
		save(t, s, "device", "A", "knowledge", strings.Repeat("x", 8192), i)
	}
	snap, e := s.Snapshot("A", "W", "x")
	if e != nil {
		t.Fatal(e)
	}
	n := 0
	for _, r := range snap.Records {
		n += len(r.Text)
		if r.Hash != textHash(r.Text) {
			t.Fatal(r)
		}
	}
	if len(snap.Records) > 32 || n > 32768 {
		t.Fatal(len(snap.Records), n)
	}
	wire, _ := json.Marshal(snap)
	if len(wire) > 32768 {
		t.Fatal("wire budget", len(wire))
	}
	if _, e = s.Snapshot("B", "W", "x"); e != nil {
		t.Fatal(e)
	}
}

func TestSnapshotEscapedJSONBudget(t *testing.T) {
	s := fresh(t)
	for i := 1; i <= 32; i++ {
		save(t, s, "device", "A", "knowledge", strings.Repeat("\"\\\n\t", 2048), i)
	}
	// Knowledge now requires an association; this query matches the escaped
	// fixture so the test still exercises the complete JSON wire budget.
	snap, e := s.Snapshot("A", "W", "\"")
	if e != nil {
		t.Fatal(e)
	}
	wire, e := json.Marshal(snap)
	if e != nil || len(wire) > 32768 || len(snap.Records) == 0 {
		t.Fatal(len(wire), e)
	}
}

func TestRevisionCapacityDoesNotDeleteEvidence(t *testing.T) {
	s := fresh(t)
	r := save(t, s, "device", "A", "fact", "v1", 1)
	// A populated fixture avoids quadratic real disk writes while exercising the
	// actual mutation/commit capacity gate and preservation of the old state.
	for i := 2; i <= maxRevisions; i++ {
		next := r
		next.Revision = i
		s.data.Records = append(s.data.Records, next)
	}
	if _, e := s.Write("device", "A", oid(2), r.ID, maxRevisions, "fact", "title", "over capacity"); !errors.Is(e, ErrLimit) {
		t.Fatal(e)
	}
	if len(s.data.Records) != maxRevisions || s.data.Records[maxRevisions-1].Text != "v1" {
		t.Fatal("evidence lost")
	}
}
