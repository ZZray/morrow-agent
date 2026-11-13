package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

const referenceFileLimit = 2 << 20
const referenceTextLimit = 4096

var referenceIdentity = regexp.MustCompile(`^[A-Za-z0-9_-]{1,96}$`)
var errReferenceSource = errors.New("reference source unavailable or incomplete")

type sessionReference struct {
	SourceID     string   `json:"source_id"`
	WorkspaceID  string   `json:"workspace_id"`
	SessionID    string   `json:"session_id"`
	Title        string   `json:"title"`
	Hash         string   `json:"hash"`
	Version      int      `json:"version"`
	Text         string   `json:"text"`
	Truncated    bool     `json:"truncated"`
	OmittedTypes []string `json:"omitted_types"`
	Origin       string   `json:"origin"`
}

// readSessionReference reads a bounded public-text projection, never a provider
// replay. Browser-written assistant text is narrative, not a verified receipt.
func readSessionReference(ws, sid string) (sessionReference, error) {
	if !referenceIdentity.MatchString(ws) || !referenceIdentity.MatchString(sid) {
		return sessionReference{}, errReferenceSource
	}
	if _, err := loadWSMeta(ws); err != nil {
		return sessionReference{}, errReferenceSource
	}
	sessionMessagesMu.RLock()
	defer sessionMessagesMu.RUnlock()
	sessIdentityMu.RLock()
	meta, _, err := loadReferenceMeta(ws, sid)
	sessIdentityMu.RUnlock()
	if err != nil || meta.ID != sid {
		return sessionReference{}, errReferenceSource
	}
	path := sessPath(ws, sid)
	lstat, err := os.Lstat(path)
	if err != nil || !lstat.Mode().IsRegular() {
		return sessionReference{}, errReferenceSource
	}
	f, err := os.Open(path)
	if err != nil {
		return sessionReference{}, errReferenceSource
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() > referenceFileLimit {
		return sessionReference{}, errReferenceSource
	}
	type publicMessage struct {
		ID      string `json:"id"`
		Role    string `json:"role"`
		Content string `json:"content"`
		TS      string `json:"ts"`
	}
	public := []publicMessage{}
	omitted := map[string]bool{}
	limited := &io.LimitedReader{R: f, N: referenceFileLimit + 1}
	sc := bufio.NewScanner(limited)
	sc.Buffer(make([]byte, 4096), 256<<10)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if !utf8.ValidString(line) {
			return sessionReference{}, errReferenceSource
		}
		var raw map[string]json.RawMessage
		var m publicMessage
		if json.Unmarshal([]byte(line), &raw) != nil || raw == nil || json.Unmarshal([]byte(line), &m) != nil {
			return sessionReference{}, errReferenceSource
		}
		switch m.Role {
		case "user", "assistant", "tool", "system", "developer":
		default:
			return sessionReference{}, errReferenceSource
		}
		if _, ok := raw["native"]; ok {
			omitted["native"] = true
		}
		for _, key := range []string{"attachments", "thinking", "events", "tool_calls"} {
			if _, ok := raw[key]; ok {
				omitted[key] = true
			}
		}
		if m.Role != "user" && m.Role != "assistant" {
			omitted["non_public_roles"] = true
			continue
		}
		if strings.TrimSpace(m.Content) != "" {
			public = append(public, m)
		}
	}
	if sc.Err() != nil || limited.N <= 0 {
		return sessionReference{}, errReferenceSource
	}
	canonical, _ := json.Marshal(struct {
		Title    string          `json:"title"`
		Messages []publicMessage `json:"messages"`
	}{meta.Title, public})
	sum := sha256.Sum256(canonical)
	hash := hex.EncodeToString(sum[:])
	ref := sessionReference{SourceID: "session-" + sid + "-" + hash[:12], WorkspaceID: ws, SessionID: sid, Title: meta.Title, Hash: hash, Version: 1, Origin: "browser_history_narrative", OmittedTypes: []string{}}
	for _, key := range []string{"native", "attachments", "thinking", "events", "tool_calls", "non_public_roles"} {
		if omitted[key] {
			ref.OmittedTypes = append(ref.OmittedTypes, key)
		}
	}
	// Retain the newest public text. Bound UTF-8 bytes without slicing a rune.
	parts := []string{}
	used := 0
	for i := len(public) - 1; i >= 0; i-- {
		part := public[i].Role + ": " + public[i].Content
		separator := 0
		if len(parts) > 0 {
			separator = 2
		}
		remaining := referenceTextLimit - used - separator
		if remaining <= 0 {
			ref.Truncated = true
			break
		}
		if len(part) > remaining {
			n := remaining
			for n > 0 && !utf8.RuneStart(part[n]) {
				n--
			}
			part = part[:n]
			ref.Truncated = true
		}
		parts = append(parts, part)
		used += len(part) + separator
		if ref.Truncated {
			break
		}
	}
	for i, j := 0, len(parts)-1; i < j; i, j = i+1, j-1 {
		parts[i], parts[j] = parts[j], parts[i]
	}
	ref.Text = strings.Join(parts, "\n\n")
	return ref, nil
}

// apiReferenceSource is registered by the authenticated Hub API dispatcher.
func (h *hubSrv) apiReferenceSource(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		writeJSON(w, 405, map[string]string{"error": "method not allowed"})
		return
	}
	ref, err := readSessionReference(r.URL.Query().Get("workspace_id"), r.URL.Query().Get("session_id"))
	if err != nil {
		writeJSON(w, 409, map[string]string{"error": "reference source unavailable or incomplete"})
		return
	}
	writeJSON(w, 200, ref)
}

type referenceSessionMeta struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	UpdatedAt string `json:"updated_at"`
}

// Caller holds the existing metadata identity lock.
func loadReferenceMeta(ws, sid string) (*sessMeta, int, error) {
	path := sessMetaPath(ws, sid)
	st, err := os.Lstat(path)
	if err != nil || !st.Mode().IsRegular() || st.Size() > 65536 {
		return nil, 0, errReferenceSource
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, errReferenceSource
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 65537))
	if err != nil || len(b) > 65536 {
		return nil, 0, errReferenceSource
	}
	var meta sessMeta
	if json.Unmarshal(b, &meta) != nil || meta.ID != "" && meta.ID != sid || !utf8.ValidString(meta.Title) {
		return nil, 0, errReferenceSource
	}
	meta.ID = sid
	return &meta, len(b), nil
}

// Metadata discovery never reads session transcripts. Bounds protect both the
// chooser and source membership checks from a large/corrupt local collection.
func listReferenceSessions(ws string) ([]referenceSessionMeta, error) {
	if !referenceIdentity.MatchString(ws) {
		return nil, errReferenceSource
	}
	if _, err := loadWSMeta(ws); err != nil {
		return nil, errReferenceSource
	}
	dir := filepath.Join(wsDir(ws), "sessions")
	f, err := os.Open(dir)
	if err != nil {
		return nil, errReferenceSource
	}
	defer f.Close()
	entries, err := f.Readdir(8193)
	if err != nil && !errors.Is(err, io.EOF) || len(entries) > 8192 {
		return nil, errReferenceSource
	}
	sessions := map[string]bool{}
	for _, e := range entries {
		if e.Mode().IsRegular() && strings.HasSuffix(e.Name(), ".jsonl") {
			sid := strings.TrimSuffix(e.Name(), ".jsonl")
			if referenceIdentity.MatchString(sid) {
				sessions[sid] = true
			}
		}
	}
	if len(sessions) > 4096 {
		return nil, errReferenceSource
	}
	out := []referenceSessionMeta{}
	budget := 4 << 20
	sessIdentityMu.RLock()
	defer sessIdentityMu.RUnlock()
	for sid := range sessions {
		meta, n, err := loadReferenceMeta(ws, sid)
		budget -= n
		if err != nil || budget < 0 {
			return nil, errReferenceSource
		}
		title := meta.Title
		if len(title) > 240 {
			n := 240
			for n > 0 && !utf8.RuneStart(title[n]) {
				n--
			}
			title = title[:n]
		}
		out = append(out, referenceSessionMeta{sid, title, meta.UpdatedAt})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].UpdatedAt == out[j].UpdatedAt {
			return out[i].ID < out[j].ID
		}
		return out[i].UpdatedAt > out[j].UpdatedAt
	})
	return out, nil
}

func (h *hubSrv) apiReferenceSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		writeJSON(w, 405, map[string]string{"error": "method not allowed"})
		return
	}
	rows, err := listReferenceSessions(r.URL.Query().Get("workspace_id"))
	if err != nil {
		writeJSON(w, 409, map[string]string{"error": "reference session metadata unavailable"})
		return
	}
	writeJSON(w, 200, rows)
}
