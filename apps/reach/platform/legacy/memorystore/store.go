// Package memorystore owns bounded, sourced HandWave memory. The Host must
// authenticate callers and validate device/project identities before calling it.
// The store is single-process; its mutex is not an inter-process file lock.
package memorystore

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

var (
	ErrConflict = errors.New("memory revision or operation conflict")
	ErrInvalid  = errors.New("invalid memory input")
	ErrNotFound = errors.New("memory not found")
	ErrLimit    = errors.New("memory capacity reached")
)

const maxFile = 16 << 20
const maxRevisions = 4096

type Record struct {
	ID         string `json:"id"`
	Scope      string `json:"scope"`
	ScopeID    string `json:"scope_id"`
	Kind       string `json:"kind"`
	Title      string `json:"title"`
	Text       string `json:"text"`
	Revision   int    `json:"revision"`
	Status     string `json:"status"`
	SourceID   string `json:"source_id"`
	SourceHash string `json:"source_hash"`
	UpdatedAt  string `json:"updated_at"`
	CreatedAt  string `json:"created_at"`
	Origin     string `json:"origin"`
}

type ProjectBinding struct {
	WorkspaceID string `json:"workspace_id"`
	DeviceFP    string `json:"device_fp"`
	ProjectID   string `json:"project_id"`
	Revision    int    `json:"revision"`
}

type SnapshotRecord struct {
	ID       string `json:"id"`
	Revision int    `json:"revision"`
	Kind     string `json:"kind"`
	Text     string `json:"text"`
	Hash     string `json:"hash"`
	Scope    string `json:"scope"`
	ScopeID  string `json:"scope_id"`
}

type Snapshot struct {
	Version  int              `json:"version"`
	Status   string           `json:"status"`
	DeviceID string           `json:"device_id"`
	Epoch    string           `json:"epoch"`
	Records  []SnapshotRecord `json:"records"`
}

type operation struct {
	Digest  string          `json:"digest"`
	Record  *Record         `json:"record,omitempty"`
	Binding *ProjectBinding `json:"binding,omitempty"`
}

type state struct {
	Version    int                  `json:"version"`
	Records    []Record             `json:"records"`
	Bindings   []ProjectBinding     `json:"bindings"`
	Operations map[string]operation `json:"operations"`
}

type Store struct {
	mu   sync.Mutex
	path string
	data state
	// Test seam for deterministic storage faults; never exported to the Host.
	writeFile func(string, []byte) error
}

func New(path string) (*Store, error) {
	if path == "" {
		return nil, ErrInvalid
	}
	s := &Store{path: path, data: state{Version: 1, Records: []Record{}, Bindings: []ProjectBinding{}, Operations: map[string]operation{}}, writeFile: atomicWrite}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxFile+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxFile {
		return nil, ErrLimit
	}
	if err = json.Unmarshal(b, &s.data); err != nil {
		return nil, fmt.Errorf("load memory: %w", err)
	}
	if err = validateState(s.data); err != nil {
		return nil, err
	}
	return s, nil
}

func digest(v any) string {
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func textHash(v string) string { h := sha256.Sum256([]byte(v)); return hex.EncodeToString(h[:]) }
func identity(v string) bool {
	return strings.TrimSpace(v) == v && v != "" && len(v) <= 128 && !strings.ContainsAny(v, "\x00\r\n") && utf8.ValidString(v)
}
func scopeValid(scope, id string) bool {
	return identity(id) && (scope == "device" || scope == "project" || scope == "workspace" && id == "ray")
}
func kindValid(v string) bool {
	switch v {
	case "knowledge", "fact", "preference", "decision", "lesson":
		return true
	}
	return false
}
func opValid(v string) bool {
	if len(v) < 32 || len(v) > 64 {
		return false
	}
	for _, c := range v {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F' || c == '-') {
			return false
		}
	}
	return true
}
func bodyValid(kind, title, text string) bool {
	return kindValid(kind) && utf8.ValidString(title) && utf8.ValidString(text) && utf8.RuneCountInString(title) <= 120 && strings.TrimSpace(text) != "" && len(text) <= 8192
}

func validateState(d state) error {
	if d.Version != 1 || d.Operations == nil {
		return ErrInvalid
	}
	if len(d.Records)+len(d.Bindings) > maxRevisions || len(d.Operations) > maxRevisions {
		return ErrLimit
	}
	latest := map[string]Record{}
	for _, r := range d.Records {
		if !identity(r.ID) || !scopeValid(r.Scope, r.ScopeID) || !bodyValid(r.Kind, r.Title, r.Text) || r.SourceID != r.ID || r.SourceHash != textHash(r.Text) || r.Origin != "Ray_user_input" || (r.Status != "active" && r.Status != "revoked") {
			return ErrInvalid
		}
		old, ok := latest[r.ID]
		if (!ok && r.Revision != 1) || (ok && (r.Revision != old.Revision+1 || r.Scope != old.Scope || r.ScopeID != old.ScopeID || r.CreatedAt != old.CreatedAt || old.Status == "revoked")) {
			return ErrInvalid
		}
		if _, err := time.Parse(time.RFC3339Nano, r.CreatedAt); err != nil {
			return ErrInvalid
		}
		if _, err := time.Parse(time.RFC3339Nano, r.UpdatedAt); err != nil {
			return ErrInvalid
		}
		latest[r.ID] = r
	}
	bindings := map[string]int{}
	for _, b := range d.Bindings {
		if !identity(b.WorkspaceID) || !identity(b.DeviceFP) || (b.ProjectID != "" && !identity(b.ProjectID)) || b.Revision != bindings[b.WorkspaceID+"\x00"+b.DeviceFP]+1 {
			return ErrInvalid
		}
		bindings[b.WorkspaceID+"\x00"+b.DeviceFP] = b.Revision
	}
	for id, op := range d.Operations {
		if !opValid(id) || len(op.Digest) != 64 || (op.Record == nil) == (op.Binding == nil) {
			return ErrInvalid
		}
	}
	return nil
}

func atomicWrite(path string, b []byte) (err error) {
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".handwave-memory-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	// Rename is the commit point. A later directory-sync failure cannot truthfully
	// be reported as an uncommitted write; the file itself has been synced above.
	if err = os.Rename(name, path); err != nil {
		return err
	}
	return nil
}

func (s *Store) clone() state {
	d := s.data
	d.Records = append([]Record{}, d.Records...)
	d.Bindings = append([]ProjectBinding{}, d.Bindings...)
	d.Operations = map[string]operation{}
	for k, v := range s.data.Operations {
		d.Operations[k] = v
	}
	return d
}
func (s *Store) commit(d state) error {
	if err := validateState(d); err != nil {
		return err
	}
	b, err := json.Marshal(d)
	if err != nil {
		return err
	}
	if len(b) > maxFile {
		return ErrLimit
	}
	if err = s.writeFile(s.path, b); err != nil {
		return err
	}
	s.data = d
	return nil
}
func (s *Store) retry(opID, hash string) (operation, bool, error) {
	if !opValid(opID) {
		return operation{}, false, ErrInvalid
	}
	op, ok := s.data.Operations[opID]
	if ok && op.Digest != hash {
		return operation{}, false, ErrConflict
	}
	return op, ok, nil
}
func latestRecords(records []Record) []Record {
	m := map[string]Record{}
	for _, r := range records {
		m[r.ID] = r
	}
	out := make([]Record, 0, len(m))
	for _, r := range m {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].UpdatedAt == out[j].UpdatedAt {
			return out[i].ID < out[j].ID
		}
		return out[i].UpdatedAt > out[j].UpdatedAt
	})
	return out
}

func (s *Store) Write(scope, scopeID, operationID, id string, expectedRevision int, kind, title, text string) (Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !scopeValid(scope, scopeID) || !bodyValid(kind, title, text) || expectedRevision < 0 {
		return Record{}, ErrInvalid
	}
	h := digest([]any{"write", scope, scopeID, id, expectedRevision, kind, title, text})
	op, ok, err := s.retry(operationID, h)
	if err != nil {
		return Record{}, err
	}
	if ok {
		if op.Record == nil {
			return Record{}, ErrConflict
		}
		return *op.Record, nil
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	r := Record{ID: id, Scope: scope, ScopeID: scopeID, Kind: kind, Title: title, Text: text, Revision: 1, Status: "active", SourceHash: textHash(text), CreatedAt: now, UpdatedAt: now, Origin: "Ray_user_input"}
	if id == "" {
		if expectedRevision != 0 {
			return Record{}, ErrConflict
		}
		var raw [16]byte
		if _, err = rand.Read(raw[:]); err != nil {
			return Record{}, err
		}
		r.ID = hex.EncodeToString(raw[:])
	} else {
		found := false
		for _, old := range latestRecords(s.data.Records) {
			if old.ID == id && old.Scope == scope && old.ScopeID == scopeID {
				if old.Revision != expectedRevision || old.Status != "active" {
					return Record{}, ErrConflict
				}
				r.Revision = old.Revision + 1
				r.CreatedAt = old.CreatedAt
				found = true
				break
			}
		}
		if !found {
			return Record{}, ErrNotFound
		}
	}
	r.SourceID = r.ID
	d := s.clone()
	d.Records = append(d.Records, r)
	d.Operations[operationID] = operation{Digest: h, Record: &r}
	if err = s.commit(d); err != nil {
		return Record{}, err
	}
	return r, nil
}

func (s *Store) Revoke(scope, scopeID, operationID, id string, expectedRevision int) (Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !scopeValid(scope, scopeID) || !identity(id) || expectedRevision < 1 {
		return Record{}, ErrInvalid
	}
	h := digest([]any{"revoke", scope, scopeID, id, expectedRevision})
	op, ok, err := s.retry(operationID, h)
	if err != nil {
		return Record{}, err
	}
	if ok {
		if op.Record == nil {
			return Record{}, ErrConflict
		}
		return *op.Record, nil
	}
	for _, r := range latestRecords(s.data.Records) {
		if r.ID == id && r.Scope == scope && r.ScopeID == scopeID {
			if r.Revision != expectedRevision || r.Status != "active" {
				return Record{}, ErrConflict
			}
			r.Revision++
			r.Status = "revoked"
			r.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
			d := s.clone()
			d.Records = append(d.Records, r)
			d.Operations[operationID] = operation{Digest: h, Record: &r}
			if err = s.commit(d); err != nil {
				return Record{}, err
			}
			return r, nil
		}
	}
	return Record{}, ErrNotFound
}

func (s *Store) List(scope, scopeID string, includeRevoked bool) ([]Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !scopeValid(scope, scopeID) {
		return nil, ErrInvalid
	}
	out := []Record{}
	for _, r := range latestRecords(s.data.Records) {
		if r.Scope == scope && r.ScopeID == scopeID && (includeRevoked || r.Status == "active") {
			out = append(out, r)
		}
	}
	return out, nil
}
func (s *Store) History(scope, scopeID, id string) ([]Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !scopeValid(scope, scopeID) || !identity(id) {
		return nil, ErrInvalid
	}
	out := []Record{}
	for _, r := range s.data.Records {
		if r.ID == id && r.Scope == scope && r.ScopeID == scopeID {
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		return nil, ErrNotFound
	}
	return out, nil
}
func (s *Store) binding(ws, fp string) ProjectBinding {
	b := ProjectBinding{WorkspaceID: ws, DeviceFP: fp}
	for _, v := range s.data.Bindings {
		if v.WorkspaceID == ws && v.DeviceFP == fp {
			b = v
		}
	}
	return b
}
func (s *Store) GetBinding(ws, fp string) (ProjectBinding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !identity(ws) || !identity(fp) {
		return ProjectBinding{}, ErrInvalid
	}
	return s.binding(ws, fp), nil
}
func (s *Store) BindProject(ws, fp, projectID string, expectedRevision int, opID string) (ProjectBinding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !identity(ws) || !identity(fp) || (projectID != "" && !identity(projectID)) || expectedRevision < 0 {
		return ProjectBinding{}, ErrInvalid
	}
	h := digest([]any{"bind", ws, fp, projectID, expectedRevision})
	op, ok, err := s.retry(opID, h)
	if err != nil {
		return ProjectBinding{}, err
	}
	if ok {
		if op.Binding == nil {
			return ProjectBinding{}, ErrConflict
		}
		return *op.Binding, nil
	}
	b := s.binding(ws, fp)
	if b.Revision != expectedRevision {
		return ProjectBinding{}, ErrConflict
	}
	b.ProjectID = projectID
	b.Revision++
	d := s.clone()
	d.Bindings = append(d.Bindings, b)
	d.Operations[opID] = operation{Digest: h, Binding: &b}
	if err = s.commit(d); err != nil {
		return ProjectBinding{}, err
	}
	return b, nil
}

func (s *Store) Snapshot(deviceID, workspaceID, query string) (Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !identity(deviceID) || !identity(workspaceID) || !utf8.ValidString(query) || len(query) > 65536 {
		return Snapshot{}, ErrInvalid
	}
	b := s.binding(workspaceID, deviceID)
	selected := []Record{}
	for _, r := range latestRecords(s.data.Records) {
		if r.Scope == "workspace" && r.ScopeID == "ray" || r.Scope == "device" && r.ScopeID == deviceID || b.ProjectID != "" && r.Scope == "project" && r.ScopeID == b.ProjectID {
			selected = append(selected, r)
		}
	}
	// Epoch covers every current record in the selected authorized scopes, not
	// only search hits. Revocation and project leave invalidate prior projections.
	epochRecords := append([]Record{}, selected...)
	sort.Slice(epochRecords, func(i, j int) bool { return epochRecords[i].ID < epochRecords[j].ID })
	epoch := digest(struct {
		Binding ProjectBinding
		Records []Record
	}{b, epochRecords})
	selected = rankRecords(selected, query)
	out := Snapshot{Version: 1, Status: "ready", DeviceID: deviceID, Epoch: epoch, Records: []SnapshotRecord{}}
	for _, r := range selected {
		if r.Status != "active" {
			continue
		}
		if len(out.Records) >= 32 {
			break
		}
		out.Records = append(out.Records, SnapshotRecord{ID: r.ID, Revision: r.Revision, Kind: r.Kind, Text: r.Text, Hash: r.SourceHash, Scope: r.Scope, ScopeID: r.ScopeID})
		// Bound the complete wire JSON, including escaping and source metadata,
		// to the Node parser's limit rather than estimating from text bytes.
		encoded, err := json.Marshal(out)
		if err != nil {
			return Snapshot{}, err
		}
		if len(encoded) > 32768 {
			out.Records = out.Records[:len(out.Records)-1]
		}
	}
	return out, nil
}
