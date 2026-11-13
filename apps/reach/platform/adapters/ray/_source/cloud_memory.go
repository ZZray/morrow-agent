package main

import (
	"ara/apps/handwave/memorystore"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"
)

const cloudMemoryPrefix = "/handwave/api/cloud-memory"
const agentContextPath = "/handwave/api/agent-context"

func cloudBrowserOnly(path string) bool {
	return path == nextSuggestionPath || path == agentContextPath || path == cloudMemoryPrefix || strings.HasPrefix(path, cloudMemoryPrefix+"/")
}
func (p *platform) initCloudMemory() {
	p.memory, p.memoryErr = memorystore.New(filepath.Join(filepath.Dir(p.auth.path), "handwave-memory.json"))
}

type memoryWorkspace struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	DeviceFP string `json:"device_fp"`
}
type memoryRequest struct {
	WorkspaceID      string `json:"workspace_id"`
	DeviceFP         string `json:"device_fp"`
	Scope            string `json:"scope"`
	ID               string `json:"id"`
	Kind             string `json:"kind"`
	Title            string `json:"title"`
	Text             string `json:"text"`
	ExpectedRevision int    `json:"expected_revision"`
	OpID             string `json:"op_id"`
	ProjectID        string `json:"project_id"`
}

func memoryJSON(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}
func memoryError(w http.ResponseWriter, err error) {
	code, message := 503, "云端记忆暂时不可用；请刷新确认状态后再操作"
	switch {
	case errors.Is(err, memorystore.ErrConflict):
		code, message = 409, "记忆版本已变化或操作编号冲突，请刷新后再操作"
	case errors.Is(err, memorystore.ErrInvalid):
		code, message = 400, "记忆参数无效"
	case errors.Is(err, memorystore.ErrNotFound):
		code, message = 404, "记忆不存在"
	case errors.Is(err, memorystore.ErrLimit):
		code, message = 413, "记忆达到容量限制，请缩短内容"
	}
	memoryJSON(w, code, map[string]string{"error": message})
}
func (p *platform) hubJSON(r *http.Request, method, path string, body []byte) ([]byte, int, error) {
	return p.hubJSONTarget(r, method, path, "", body)
}
func (p *platform) hubJSONTarget(r *http.Request, method, path, rawQuery string, body []byte) ([]byte, int, error) {
	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
	defer cancel()
	u := &url.URL{Scheme: "http", Host: p.cfg.PublicIP, Path: path, RawQuery: rawQuery}
	q, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	q.Header.Set("Authorization", "Bearer "+p.cfg.HandWaveToken)
	q.Header.Set("Content-Type", "application/json")
	p.edge.Director(q)
	client := &http.Client{Transport: p.edge.Transport, Timeout: 6 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(q)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if len(data) > 1<<20 {
		return nil, response.StatusCode, errors.New("Hub response limit")
	}
	return data, response.StatusCode, err
}
func (p *platform) memoryScope(r *http.Request, ws, fp string) ([]memoryWorkspace, error) {
	if ws == "" || fp == "" || len(ws) > 100 || len(fp) > 100 {
		return nil, memorystore.ErrConflict
	}
	data, status, err := p.hubJSON(r, "GET", "/handwave/api/workspaces", nil)
	if err != nil || status != 200 {
		return nil, errors.New("workspace verification unavailable")
	}
	var all []memoryWorkspace
	if json.Unmarshal(data, &all) != nil || len(all) > 4096 {
		return nil, errors.New("workspace verification malformed")
	}
	for _, row := range all {
		if row.ID == ws && row.DeviceFP == fp && row.DeviceFP != "" {
			return all, nil
		}
	}
	return nil, memorystore.ErrConflict
}
func memoryScopeID(scope string, binding memorystore.ProjectBinding, fp string) (string, error) {
	switch scope {
	case "device":
		return fp, nil
	case "workspace":
		return "ray", nil
	case "project":
		if binding.ProjectID != "" {
			return binding.ProjectID, nil
		}
	}
	return "", memorystore.ErrInvalid
}
func (p *platform) cloudMemoryH(w http.ResponseWriter, r *http.Request) {
	if p.memoryErr != nil || p.memory == nil {
		memoryError(w, errors.New("store unavailable"))
		return
	}
	var req memoryRequest
	if r.Method == "GET" {
		req.WorkspaceID = r.URL.Query().Get("workspace_id")
		req.DeviceFP = r.URL.Query().Get("device_fp")
		req.Scope = r.URL.Query().Get("scope")
		req.ID = r.URL.Query().Get("id")
	} else if r.Method == "POST" {
		if !sameOrigin(r) {
			memoryJSON(w, 403, map[string]string{"error": "需要同源操作"})
			return
		}
		dec := json.NewDecoder(io.LimitReader(r.Body, 64<<10))
		dec.DisallowUnknownFields()
		if dec.Decode(&req) != nil {
			memoryError(w, memorystore.ErrInvalid)
			return
		}
		var extra any
		if dec.Decode(&extra) != io.EOF {
			memoryError(w, memorystore.ErrInvalid)
			return
		}
	} else {
		w.Header().Set("Allow", "GET, POST")
		memoryJSON(w, 405, map[string]string{"error": "method not allowed"})
		return
	}
	all, err := p.memoryScope(r, req.WorkspaceID, req.DeviceFP)
	if err != nil {
		memoryError(w, err)
		return
	}
	binding, err := p.memory.GetBinding(req.WorkspaceID, req.DeviceFP)
	if err != nil {
		memoryError(w, err)
		return
	}
	if req.Scope == "" {
		req.Scope = "device"
	}
	path := strings.TrimPrefix(r.URL.Path, cloudMemoryPrefix)
	if path == "/project" && r.Method == "POST" {
		valid := req.ProjectID == ""
		for _, row := range all {
			if row.ID == req.ProjectID {
				valid = true
			}
		}
		if !valid {
			memoryError(w, memorystore.ErrInvalid)
			return
		}
		result, err := p.memory.BindProject(req.WorkspaceID, req.DeviceFP, req.ProjectID, req.ExpectedRevision, req.OpID)
		if err != nil {
			memoryError(w, err)
			return
		}
		memoryJSON(w, 200, result)
		return
	}
	scopeID, err := memoryScopeID(req.Scope, binding, req.DeviceFP)
	if err != nil {
		if req.Scope == "project" && r.Method == "GET" && path == "" {
			memoryJSON(w, 200, map[string]any{"binding": binding, "projects": all, "records": []any{}})
			return
		}
		memoryError(w, err)
		return
	}
	if path == "" && r.Method == "GET" {
		records, err := p.memory.List(req.Scope, scopeID, false)
		if err != nil {
			memoryError(w, err)
			return
		}
		if records == nil {
			records = []memorystore.Record{}
		}
		memoryJSON(w, 200, map[string]any{"binding": binding, "projects": all, "records": records})
		return
	}
	if path == "/history" && r.Method == "GET" {
		history, err := p.memory.History(req.Scope, scopeID, req.ID)
		if err != nil {
			memoryError(w, err)
			return
		}
		memoryJSON(w, 200, history)
		return
	}
	if path == "/records" && r.Method == "POST" {
		result, err := p.memory.Write(req.Scope, scopeID, req.OpID, req.ID, req.ExpectedRevision, req.Kind, req.Title, req.Text)
		if err != nil {
			memoryError(w, err)
			return
		}
		memoryJSON(w, 200, result)
		return
	}
	if path == "/revoke" && r.Method == "POST" {
		result, err := p.memory.Revoke(req.Scope, scopeID, req.OpID, req.ID, req.ExpectedRevision)
		if err != nil {
			memoryError(w, err)
			return
		}
		memoryJSON(w, 200, result)
		return
	}
	memoryJSON(w, 404, map[string]string{"error": "unknown memory operation"})
}

// Intercept only controller context assembly. Nodes never receive a memory API
// credential. The carrier is source data; it is not a signature/adoption receipt.
func (p *platform) cloudAgentContextH(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		memoryJSON(w, 405, map[string]string{"error": "method not allowed"})
		return
	}
	if !sameOrigin(r) {
		memoryJSON(w, 403, map[string]string{"error": "需要同源请求"})
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		memoryError(w, memorystore.ErrInvalid)
		return
	}
	var req map[string]json.RawMessage
	if json.Unmarshal(data, &req) != nil {
		memoryError(w, memorystore.ErrInvalid)
		return
	}
	var ws, fp, query string
	var enabled bool
	_ = json.Unmarshal(req["workspace_id"], &ws)
	_ = json.Unmarshal(req["device_fp"], &fp)
	_ = json.Unmarshal(req["content"], &query)
	_ = json.Unmarshal(req["cloud_memory_v1"], &enabled)
	if err = contextMode(req); err != nil {
		memoryError(w, err)
		return
	}
	var sessionRequests []contextSessionRequest
	if raw, ok := req["reference_sessions"]; ok {
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.DisallowUnknownFields()
		if dec.Decode(&sessionRequests) != nil {
			memoryError(w, memorystore.ErrInvalid)
			return
		}
	}
	// New data fields are assembled here; the legacy Hub owns only its existing
	// chatReq fields and must not interpret execution modes as authorization.
	delete(req, "reference_sessions")
	delete(req, "execution_mode")
	delete(req, "device_fp")
	delete(req, "cloud_memory_v1")
	upstream, _ := json.Marshal(req)
	briefBody, status, err := p.hubJSON(r, "POST", agentContextPath, upstream)
	if err != nil || status != 200 {
		memoryError(w, errors.New("legacy context unavailable"))
		return
	}
	var result struct {
		Brief string `json:"brief"`
	}
	if json.Unmarshal(briefBody, &result) != nil {
		memoryError(w, errors.New("invalid legacy context"))
		return
	}
	if !enabled {
		if len(sessionRequests) != 0 {
			memoryError(w, memorystore.ErrInvalid)
			return
		}
		memoryJSON(w, 200, map[string]any{"brief": result.Brief, "cloud_memory": "node_upgrade_required"})
		return
	}
	if _, err = p.memoryScope(r, ws, fp); err != nil {
		memoryError(w, err)
		return
	}
	refs, err := p.resolveContextSessions(r, ws, sessionRequests)
	if err != nil {
		memoryError(w, err)
		return
	}
	if p.memory == nil || p.memoryErr != nil {
		memoryError(w, errors.New("store unavailable"))
		return
	}
	snapshot, err := p.memory.Snapshot(fp, ws, query)
	if err != nil {
		memoryError(w, err)
		return
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil || len(encoded) > 32768 {
		memoryError(w, memorystore.ErrLimit)
		return
	}
	brief := "HANDWAVE_CLOUD_SNAPSHOT_V1\n" + string(encoded) + "\nHANDWAVE_BRIEF\n" + result.Brief + sessionReferenceBrief(refs)
	memoryJSON(w, 200, map[string]any{"brief": brief, "memory_receipt": snapshot, "workspace_id": ws, "device_fp": fp, "session_references": refs})
}
