package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ara/internal/gatewayclient"
	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"
)

func goalTestHub(t *testing.T) (*hubSrv, *longTaskRecord) {
	t.Helper()
	t.Setenv("HW_CONF", t.TempDir())
	h := testHubWithNode("fp", true)
	h.ctlws = map[string]*ctlConn{}
	h.peers = map[string]string{}
	r := &longTaskRecord{Lease: goalLease{GoalID: "g", Controller: "ctl", Device: "fp", Session: "w/s", goalPolicy: goalPolicy{ExpiresAt: time.Now().Add(time.Hour).Unix(), MaxCalls: 2, MaxSlices: 2}}, Runs: map[string]bool{"r1": true}, Commands: map[string]string{}}
	h.longTasks = &longTaskBook{Records: map[string]*longTaskRecord{longTaskKey("fp", "g"): r}}
	return h, r
}
func goalControllerFrame(p goalPolicy) *sig {
	raw, _ := json.Marshal(map[string]any{"k": "agent-loop", "id": "first", "execution_mode": "goal", "session_key": "w/s", "goal_policy": p, "model": "chosen", "protocol": "openai-completions"})
	return &sig{K: "dc", D: base64.StdEncoding.EncodeToString(raw)}
}
func TestGoalPolicyBounds(t *testing.T) {
	now := time.Now()
	p := goalPolicy{ExpiresAt: now.Add(time.Hour).Unix(), MaxCalls: 48, MaxSlices: 8}
	if !p.valid(now) {
		t.Fatal("defaults rejected")
	}
	for _, v := range []goalPolicy{{ExpiresAt: now.Unix(), MaxCalls: 1, MaxSlices: 1}, {ExpiresAt: now.Add(25 * time.Hour).Unix(), MaxCalls: 1, MaxSlices: 1}, {ExpiresAt: p.ExpiresAt, MaxCalls: 257, MaxSlices: 1}, {ExpiresAt: p.ExpiresAt, MaxCalls: 1, MaxSlices: 33}, {ExpiresAt: p.ExpiresAt, MaxSlices: 1}} {
		if v.valid(now) {
			t.Fatalf("invalid policy admitted: %+v", v)
		}
	}
}
func TestGoalRelayAuthenticatesPairedControllerAndPersists(t *testing.T) {
	h, _ := goalTestHub(t)
	h.longTasks.Records = map[string]*longTaskRecord{}
	controller := &websocket.Conn{}
	h.ctlws["c1"] = &ctlConn{fp: "ctl", ws: controller}
	h.peers["c1"] = "n1"
	p := goalPolicy{ExpiresAt: time.Now().Add(time.Hour).Unix(), MaxCalls: 48, MaxSlices: 8}
	s := goalControllerFrame(p)
	if err := h.registerGoalRelay("c1", &websocket.Conn{}, s); err == nil {
		t.Fatal("wrong socket admitted")
	}
	h.peers["c1"] = ""
	if err := h.registerGoalRelay("c1", controller, s); err == nil {
		t.Fatal("unpaired admitted")
	}
	h.peers["c1"] = "n1"
	if err := h.registerGoalRelay("c1", controller, s); err != nil {
		t.Fatal(err)
	}
	r := h.longTasks.Records[longTaskKey("fp", "first")]
	if r.Lease.Session != "w/s" || r.RequestedModel != "chosen" {
		t.Fatal("lost trusted owner/session/model")
	}
	if err := h.registerGoalRelay("c1", controller, s); err != nil {
		t.Fatal("exact retry", err)
	}
	p.ExpiresAt++
	if err := h.registerGoalRelay("c1", controller, goalControllerFrame(p)); err == nil {
		t.Fatal("lease extended")
	}
	restored := testHubWithNode("fp", true)
	restored.mu.Lock()
	got := restored.longTasksLocked()
	restored.mu.Unlock()
	if got.loadErr != nil || got.Records[longTaskKey("fp", "first")].Lease != r.Lease {
		t.Fatal("lease did not survive restart")
	}
}
func TestGoalRelayWriteFailureDoesNotPublishAuthorization(t *testing.T) {
	h, _ := goalTestHub(t)
	h.longTasks.Records = map[string]*longTaskRecord{}
	c := &websocket.Conn{}
	h.ctlws["c"] = &ctlConn{fp: "ctl", ws: c}
	h.peers["c"] = "n1"
	if err := os.Mkdir(filepath.Join(confDir(), "goal-leases.json"), 0700); err != nil {
		t.Fatal(err)
	}
	if h.registerGoalRelay("c", c, goalControllerFrame(goalPolicy{ExpiresAt: time.Now().Add(time.Hour).Unix(), MaxCalls: 1, MaxSlices: 1})) == nil {
		t.Fatal("write failure ignored")
	}
	if h.longTasks.Records[longTaskKey("fp", "first")] != nil {
		t.Fatal("undurable lease published")
	}
}
func TestGoalRelayCapsLeaseAtDeviceApprovalAndRetryIsStable(t *testing.T) {
	h, _ := goalTestHub(t)
	h.longTasks.Records = map[string]*longTaskRecord{}
	c := &websocket.Conn{}
	h.ctlws["c"] = &ctlConn{fp: "ctl", ws: c}
	h.peers["c"] = "n1"
	h.approvals["fp"].Exp = time.Now().Add(5 * time.Minute)
	s := goalControllerFrame(goalPolicy{ExpiresAt: time.Now().Add(24 * time.Hour).Unix(), MaxCalls: 48, MaxSlices: 8, AllowJobs: true})
	if err := h.registerGoalRelay("c", c, s); err != nil {
		t.Fatal(err)
	}
	r := h.longTasks.Records[longTaskKey("fp", "first")]
	if r.Lease.ExpiresAt != h.approvals["fp"].Exp.Unix() {
		t.Fatal("goal/worker lease exceeds device approval")
	}
	if err := h.registerGoalRelay("c", c, s); err != nil {
		t.Fatal("capped exact retry changed contract", err)
	}
}
func TestGoalFinalizeCapsGrantAndRejectsTupleChange(t *testing.T) {
	h, r := goalTestHub(t)
	r.Lease.ExpiresAt = time.Now().Add(time.Minute).Unix()
	h.bind = newBindingBook()
	p, err := h.bind.pinSession("fp", testPin("fp", "model", "openai-completions", "decision"))
	if err != nil {
		t.Fatal(err)
	}
	g, err := h.bind.attachRun("fp", "r1", p.BindingID)
	if err != nil {
		t.Fatal(err)
	}
	lease, capped, err := h.finalizeGoalGrant("fp", p, g)
	if err != nil || lease == nil || capped.Exp.Unix() != r.Lease.ExpiresAt {
		t.Fatalf("uncapped lease: %v %+v", err, capped)
	}
	altered := *p
	altered.Model = "different"
	if _, _, err := h.finalizeGoalGrant("fp", &altered, g); err == nil {
		t.Fatal("tuple change admitted")
	}
	r.Revoked = true
	if _, _, err := h.finalizeGoalGrant("fp", p, g); err == nil {
		t.Fatal("revoked grant admitted")
	}
}
func TestGoalHTTPCallBudgetIsDurableAndFailClosed(t *testing.T) {
	h, r := goalTestHub(t)
	if h.chargeGoalCall("other", "r1") != nil || r.Calls != 0 {
		t.Fatal("charged unrelated device")
	}
	if h.chargeGoalCall("fp", "r1") != nil || h.chargeGoalCall("fp", "r1") != nil {
		t.Fatal("valid call refused")
	}
	if h.chargeGoalCall("fp", "r1") == nil || r.Calls != 2 {
		t.Fatal("budget exceeded")
	}
	h2 := testHubWithNode("fp", true)
	h2.mu.Lock()
	count := h2.longTasksLocked().Records[longTaskKey("fp", "g")].Calls
	h2.mu.Unlock()
	if count != 2 {
		t.Fatal("usage lost on restart")
	}
	r.Calls = 0
	r.Lease.ExpiresAt = time.Now().Add(-time.Second).Unix()
	if h.chargeGoalCall("fp", "r1") == nil {
		t.Fatal("expired lease called upstream")
	}
}
func TestGoalDetachOnlyExplicitLiveOwnerLease(t *testing.T) {
	h, r := goalTestHub(t)
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.detachGoalControllerLocked("ctl", "fp") || h.detachGoalControllerLocked("other", "fp") || h.detachGoalControllerLocked("ctl", "other") {
		t.Fatal("detach owner scope broken")
	}
	r.Lease.ExpiresAt = time.Now().Add(-time.Second).Unix()
	if h.detachGoalControllerLocked("ctl", "fp") {
		t.Fatal("expired background admitted")
	}
}
func TestGoalMirrorRevisionEpochAndRunFence(t *testing.T) {
	h, r := goalTestHub(t)
	c := &websocket.Conn{}
	h.nodes["n1"].ws = c
	publish := func(epoch string, rev uint64, run string) {
		raw, _ := json.Marshal(map[string]any{"id": "g", "revision": rev, "run": run, "last_settled_run": "r1", "status": "awaiting_review"})
		h.recordGoalState(context.Background(), "n1", c, &sig{Goal: raw, SessionKey: "w/s", WriterEpoch: epoch})
	}
	publish("epoch1", 2, "r1")
	if r.Revision != 2 {
		t.Fatal("valid mirror rejected")
	}
	publish("epoch1", 1, "r1")
	publish("epoch2", 3, "r1")
	publish("epoch1", 3, "unknown")
	if r.Revision != 2 || r.Epoch != "epoch1" {
		t.Fatal("stale/foreign epoch/run published")
	}
	r.Commands["command"] = "pause/2/"
	publish("epoch1", 3, "command")
	if r.Revision != 3 {
		t.Fatal("reviewed management run rejected")
	}
}

// Real local WebSockets exercise controller commands; no real upstream model.
func goalCommandRoundTrip(t *testing.T, h *hubSrv, s *sig) sig {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		h.mu.Lock()
		h.ctlws["c1"] = &ctlConn{fp: "ctl", ws: c}
		h.nodes["n1"].ws = c
		h.mu.Unlock()
		h.forwardGoalCommand(r.Context(), "c1", c, s)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	var reply sig
	if err := wsjson.Read(ctx, c, &reply); err != nil {
		t.Fatal(err)
	}
	return reply
}
func TestGoalCommandsRejectStaleAcceptAndKeepStableRetries(t *testing.T) {
	h, r := goalTestHub(t)
	r.Revision = 4
	r.Goal = json.RawMessage(`{"id":"g","revision":4,"run":"r1","last_settled_run":"r1","status":"awaiting_review"}`)
	s := &sig{K: "goal-command", GoalID: "g", CommandID: "cmd", FP: "fp", SessionKey: "w/s", Command: "accept", ExpectedRevision: 3, ReviewedRunID: "r1"}
	if goalCommandRoundTrip(t, h, s).Err == "" {
		t.Fatal("old revision accepted")
	}
	s.ExpectedRevision = 4
	s.ReviewedRunID = "other"
	if goalCommandRoundTrip(t, h, s).Err == "" {
		t.Fatal("wrong reviewed run accepted")
	}
	s.ReviewedRunID = "r1"
	if reply := goalCommandRoundTrip(t, h, s); reply.Err != "" || reply.CommandID != "cmd" {
		t.Fatalf("valid command denied %+v", reply)
	}
	r.Revision = 5
	if goalCommandRoundTrip(t, h, s).Err != "" {
		t.Fatal("stable retry rejected after newer revision")
	}
	s.Command = "resume"
	if goalCommandRoundTrip(t, h, s).Err == "" {
		t.Fatal("command id reused with new operation")
	}
}

func TestGoalExplicitActualGrantAndHTTPKeepHostDecisionLocal(t *testing.T) {
	h, r := goalTestHub(t)
	r.RequestedModel = "fixture-model"
	r.RequestedProtocol = "openai-completions"
	f := newGatewayFixture(t, []gwTestModel{{ID: "fixture-model", Protocols: []string{"openai-completions"}}})
	h.gw = f.Store
	reply := reviewerGrantReply(t, h, &sig{K: "model-grant", ID: "req1", Run: "r1", GoalID: "g", SessionKey: "w/s", RequiresTools: true, Model: "untrusted-other", Protocol: "other"})
	if reply.Err != "" || reply.GoalLease == nil || reply.D == "" || reply.BindingID == "" || reply.BoundModel != "fixture-model" || reply.BoundProtocol != "openai-completions" || !strings.HasPrefix(reply.BoundDecision, "host-explicit-") {
		t.Fatalf("incomplete trusted grant: %+v", reply)
	}
	exp, err := time.Parse(time.RFC3339, reply.BoundDecisionExp)
	if err != nil || !exp.After(time.Now()) || exp.Unix() != r.Lease.ExpiresAt {
		t.Fatalf("invalid explicit decision expiry %q", reply.BoundDecisionExp)
	}
	mux := http.NewServeMux()
	h.routes(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/chat/completions", strings.NewReader(`{"model":"fixture-model","messages":[{"role":"user","content":"inspect"}]}`))
	req.Header.Set("Authorization", "Bearer "+reply.D)
	req.Header.Set(smartRunHeader, "r1")
	req.Header.Set(smartBindingHeader, reply.BindingID)
	req.Header.Set(gatewayclient.RouteDecisionHeader, "client-forged")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "ok") {
		t.Fatalf("explicit HTTP failed %d %s", resp.StatusCode, body)
	}
	records := f.snapshotRecords()
	seen := false
	for _, rec := range records {
		if rec.Path == "/v1/chat/completions" {
			seen = true
			if rec.Header.Get(gatewayclient.RouteDecisionHeader) != "" {
				t.Fatal("host or client decision impersonated upstream authorization")
			}
		}
	}
	if !seen || r.Calls != 1 {
		t.Fatal("real model request/call receipt absent")
	}
}

func TestGoalAutoUsesConfiguredLogicalModelWithoutRouteResolve(t *testing.T) {
	for _, requested := range []string{"fixture-model", "auto", "default", ""} {
		t.Run("selection="+requested, func(t *testing.T) {
			h, record := goalTestHub(t)
			record.RequestedModel = requested
			fixture := newGatewayFixture(t, []gwTestModel{{ID: "auto", Protocols: []string{"openai-completions"}}, {ID: "fixture-model", Protocols: []string{"openai-completions"}}})
			h.gw = fixture.Store
			want := "auto"
			if requested == "fixture-model" {
				want = requested
			}
			first := reviewerGrantReply(t, h, &sig{K: "model-grant", ID: "req1", Run: "r1", GoalID: "g", SessionKey: "w/s", RequiresTools: true})
			if first.Err != "" || first.D == "" || first.BindingID == "" || first.BoundModel != want || first.BoundProtocol != "openai-completions" {
				t.Fatalf("logical model not granted: %+v", first)
			}
			mux := http.NewServeMux()
			h.routes(mux)
			server := httptest.NewServer(mux)
			defer server.Close()
			request := func(grant sig, run string) int {
				body, _ := json.Marshal(map[string]any{"model": want, "messages": []map[string]string{{"role": "user", "content": "inspect"}}})
				req, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/chat/completions", strings.NewReader(string(body)))
				req.Header.Set("Authorization", "Bearer "+grant.D)
				req.Header.Set(smartRunHeader, run)
				req.Header.Set(smartBindingHeader, grant.BindingID)
				req.Header.Set(gatewayclient.RouteDecisionHeader, "client-forged")
				response, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				io.Copy(io.Discard, response.Body)
				response.Body.Close()
				return response.StatusCode
			}
			if code := request(first, "r1"); code != http.StatusOK {
				t.Fatalf("first logical model HTTP: %d", code)
			}
			h.bindings().endRun("fp", "r1")
			if code := request(first, "r1"); code != http.StatusUnauthorized {
				t.Fatalf("ended grant still accepted: %d", code)
			}
			// A later default change must not retarget an existing Goal.
			fixture.Store.mu.Lock()
			fixture.Store.cfg.DefaultModel = "fixture-model"
			fixture.Store.mu.Unlock()
			second := reviewerGrantReply(t, h, &sig{K: "model-grant", ID: "req2", Run: "r2", GoalID: "g", SessionKey: "w/s", RequiresTools: true})
			if second.Err != "" || second.D == first.D || second.BindingID != first.BindingID || second.BoundModel != want {
				t.Fatalf("continuation replaced pin or reused grant: %+v", second)
			}
			if code := request(second, "r2"); code != http.StatusOK {
				t.Fatalf("second logical model HTTP: %d", code)
			}
			if record.Calls != 2 || len(record.Runs) != 2 {
				t.Fatal("root ledger reset between Runs")
			}
			if code := request(second, "r2"); code != http.StatusForbidden {
				t.Fatalf("root call limit ignored: %d", code)
			}
			models := 0
			for _, rec := range fixture.snapshotRecords() {
				if rec.Path == "/v1/route/resolve" {
					t.Fatal("Goal introduced route resolve")
				}
				if rec.Path != "/v1/chat/completions" {
					continue
				}
				models++
				var body struct{ Model string }
				if json.Unmarshal(rec.Body, &body) != nil || body.Model != want || rec.Header.Get(gatewayclient.RouteDecisionHeader) != "" || rec.Header.Get(smartRunHeader) != "" || rec.Header.Get(smartBindingHeader) != "" {
					t.Fatal("logical alias or Host-only association changed upstream")
				}
			}
			if models != 2 {
				t.Fatalf("model HTTP attempts = %d", models)
			}
		})
	}
}

func TestGoalAutoStillRejectsMissingOrAmbiguousDirectorySelection(t *testing.T) {
	for _, protocols := range [][]string{nil, {"openai-completions", "openrouter-chat"}} {
		t.Run(strings.Join(protocols, "+"), func(t *testing.T) {
			h, record := goalTestHub(t)
			record.RequestedModel = "auto"
			models := []gwTestModel{{ID: "other", Protocols: []string{"openai-completions"}}}
			if protocols != nil {
				models = []gwTestModel{{ID: "auto", Protocols: protocols}}
			}
			fixture := newGatewayFixture(t, models)
			h.gw = fixture.Store
			reply := reviewerGrantReply(t, h, &sig{K: "model-grant", ID: "req", Run: "r1", GoalID: "g", SessionKey: "w/s"})
			if reply.Err == "" || reply.D != "" || record.Pin != nil {
				t.Fatal("invalid logical model selection authorized")
			}
			for _, rec := range fixture.snapshotRecords() {
				if rec.Path != "/v1/models" {
					t.Fatal("invalid selection reached model or route")
				}
			}
		})
	}
}

func TestGoalCommandCompletedErrorReceiptReplaysWithoutDeviceRetry(t *testing.T) {
	h, r := goalTestHub(t)
	r.Commands["cmd"] = "pause/2/"
	original := sig{K: "goal-command-result", CommandID: "cmd", GoalID: "g", SessionKey: "w/s", FP: "fp", Err: "original temporary error"}
	r.Receipts = map[string]json.RawMessage{"cmd": json.RawMessage(mustJSON(original))}
	r.Revision = 99
	s := &sig{K: "goal-command", CommandID: "cmd", GoalID: "g", SessionKey: "w/s", FP: "fp", Command: "pause", ExpectedRevision: 2}
	reply := goalCommandRoundTrip(t, h, s)
	if reply.K != "goal-command-result" || reply.Err != original.Err {
		t.Fatalf("durable original receipt was not replayed: %+v", reply)
	}
}

func TestGoalCommandReceiptPersistsOriginalGoalSnapshotAndWriterEpoch(t *testing.T) {
	h, r := goalTestHub(t)
	r.Commands["pause-cmd"] = "pause/4/"
	nodeSocket := &websocket.Conn{}
	h.nodes["n1"].ws = nodeSocket
	originalGoal := json.RawMessage(`{"id":"g","revision":5,"run":"pause-cmd","last_settled_run":"r1","status":"paused","steps":[]}`)
	h.recordGoalCommandResult(context.Background(), "n1", nodeSocket, &sig{K: "goal-command-result", CommandID: "pause-cmd", GoalID: "g", SessionKey: "w/s", WriterEpoch: "writer-original", Goal: originalGoal})
	var first sig
	if err := json.Unmarshal(r.Receipts["pause-cmd"], &first); err != nil {
		t.Fatal(err)
	}
	if first.WriterEpoch != "writer-original" || string(first.Goal) != string(originalGoal) || first.Err != "" {
		t.Fatalf("original result snapshot lost: %+v", first)
	}
	// A replay with a different transient error cannot replace a completed receipt.
	h.recordGoalCommandResult(context.Background(), "n1", nodeSocket, &sig{K: "goal-command-result", CommandID: "pause-cmd", GoalID: "g", SessionKey: "w/s", WriterEpoch: "writer-late", Err: "late transient error"})
	var retained sig
	if err := json.Unmarshal(r.Receipts["pause-cmd"], &retained); err != nil {
		t.Fatal(err)
	}
	if retained.WriterEpoch != first.WriterEpoch || string(retained.Goal) != string(first.Goal) || retained.Err != first.Err {
		t.Fatal("completed receipt changed after replay")
	}
	restored := testHubWithNode("fp", true)
	restored.mu.Lock()
	record := restored.longTasksLocked().Records[longTaskKey("fp", "g")]
	restored.mu.Unlock()
	if record == nil {
		t.Fatal("receipt store missing after restart")
	}
	var durable sig
	if err := json.Unmarshal(record.Receipts["pause-cmd"], &durable); err != nil {
		t.Fatal(err)
	}
	if durable.WriterEpoch != first.WriterEpoch || string(durable.Goal) != string(first.Goal) {
		t.Fatal("durable result snapshot/epoch lost after restart")
	}
	reply := goalCommandRoundTrip(t, h, &sig{K: "goal-command", CommandID: "pause-cmd", GoalID: "g", SessionKey: "w/s", FP: "fp", Command: "pause", ExpectedRevision: 4})
	if reply.K != "goal-command-result" || reply.WriterEpoch != first.WriterEpoch || string(reply.Goal) != string(first.Goal) || reply.Err != "" {
		t.Fatalf("retry did not return original reviewable snapshot: %+v", reply)
	}
}
func TestGoalRelayCannotReplaceUnresolvedSameSessionGoal(t *testing.T) {
	h, r := goalTestHub(t)
	c := &websocket.Conn{}
	h.ctlws["c"] = &ctlConn{fp: "ctl", ws: c}
	h.peers["c"] = "n1"
	s := goalControllerFrame(goalPolicy{ExpiresAt: time.Now().Add(time.Hour).Unix(), MaxCalls: 48, MaxSlices: 8})
	for _, status := range []string{"running", "waiting_job", "waiting_recovery", "paused", "awaiting_review"} {
		r.Goal = json.RawMessage(mustJSON(goalMirror{ID: "g", Status: status}))
		if h.registerGoalRelay("c", c, s) == nil {
			t.Fatalf("unresolved %s goal replaced", status)
		}
	}
	r.Goal = json.RawMessage(mustJSON(goalMirror{ID: "g", Status: "accepted"}))
	if err := h.registerGoalRelay("c", c, s); err != nil {
		t.Fatal("accepted old goal blocked new authorization", err)
	}
}
