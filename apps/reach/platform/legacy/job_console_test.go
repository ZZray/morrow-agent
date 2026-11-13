package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"
)

func consoleFixture(t *testing.T) (*hubSrv, *longTaskRecord, *websocket.Conn, *sig) {
	h, r := goalTestHub(t)
	c := &websocket.Conn{}
	h.nodes["n1"].ws = &websocket.Conn{}
	h.ctlws["c"] = &ctlConn{ws: c, fp: "ctl"}
	h.peers["c"], h.peers["n1"] = "n1", "c"
	r.Lease.AllowJobs = true
	r.Goal = json.RawMessage(`{"id":"g","status":"running"}`)
	return h, r, c, &sig{K: "job-command", CommandID: "cmd", GoalID: "g", SessionKey: "w/s", FP: "fp", JobAction: "input", JobID: "job", JobInputID: "in", JobText: "private-input\n"}
}

func TestConsoleTransientInputTrustedIdentityAndEOF(t *testing.T) {
	h, r, c, s := consoleFixture(t)
	s.CtlFP = "forged"
	s.D = "untrusted"
	s.GoalLease = &goalLease{Controller: "forged"}
	_, out, err := h.prepareJobCommandLocked("c", c, s)
	if err != nil || out.CtlFP != "ctl" || out.FP != "fp" || out.JobText != s.JobText || out.D != "" || out.GoalLease != nil {
		t.Fatalf("trusted projection: %v %+v", err, out)
	}
	// Repeated packets are forwarded with the exact stable input identity; only
	// Node's atomic input receipt may deduplicate actual writes.
	_, again, err := h.prepareJobCommandLocked("c", c, s)
	if err != nil || again.JobInputID != out.JobInputID {
		t.Fatal("input identity changed")
	}
	if len(r.Commands) != 0 || len(r.Receipts) != 0 {
		t.Fatal("secret entered durable Goal ledger")
	}
	s.JobText, s.JobEOF = "", true
	if _, out, err = h.prepareJobCommandLocked("c", c, s); err != nil || !out.JobEOF {
		t.Fatal("EOF rejected", err)
	}
}

func TestConsoleOwnerAndInputLeaseBoundaries(t *testing.T) {
	for _, boundary := range []string{"socket", "pair", "reverse_pair", "fingerprint", "session", "controller", "denied", "grant", "revoked", "expired", "no_jobs", "paused", "accepted", "awaiting_review", "canceled"} {
		t.Run(boundary, func(t *testing.T) {
			h, r, c, s := consoleFixture(t)
			switch boundary {
			case "socket":
				c = &websocket.Conn{}
			case "pair":
				delete(h.peers, "c")
			case "reverse_pair":
				h.peers["n1"] = "other"
			case "fingerprint":
				s.FP = "other"
			case "session":
				s.SessionKey = "w/other"
			case "controller":
				r.Lease.Controller = "other"
			case "denied":
				h.denied["fp"] = true
			case "grant":
				h.approvals["fp"].Exp = time.Now().Add(-time.Minute)
			case "revoked":
				r.Revoked = true
			case "expired":
				r.Lease.ExpiresAt = time.Now().Add(-time.Minute).Unix()
			case "no_jobs":
				r.Lease.AllowJobs = false
			default:
				r.Goal = json.RawMessage(`{"id":"g","status":"` + boundary + `"}`)
			}
			if _, _, err := h.prepareJobCommandLocked("c", c, s); err == nil {
				t.Fatal("input crossed", boundary)
			}
		})
	}
}

func TestConsoleExpiredGoalStillObservableAndCancelable(t *testing.T) {
	h, r, c, s := consoleFixture(t)
	r.Lease.ExpiresAt = time.Now().Add(-time.Hour).Unix()
	for _, action := range []string{"list", "status", "log", "input_status", "cancel"} {
		s.JobAction, s.JobText, s.JobStream = action, "", "stdout"
		if _, _, err := h.prepareJobCommandLocked("c", c, s); err != nil {
			t.Fatalf("%s: %v", action, err)
		}
	}
}

func TestConsoleResultsRejectReplacedNodeAndControllerWithoutEcho(t *testing.T) {
	h, _, c, s := consoleFixture(t)
	s.K, s.CtlFP, s.JobOK, s.JobData = "job-command-result", "ctl", true, json.RawMessage(`{"state":"written"}`)
	n := h.nodes["n1"]
	target, out := h.jobResultTargetLocked("n1", n.ws, s)
	if target != c || out == nil {
		t.Fatal("valid response dropped")
	}
	raw, _ := json.Marshal(out)
	if strings.Contains(string(raw), "private-input") || out.JobText != "" {
		t.Fatal("input echoed")
	}
	if target, _ = h.jobResultTargetLocked("n1", &websocket.Conn{}, s); target != nil {
		t.Fatal("stale node socket")
	}
	h.ctlws["c"].fp = "other"
	if target, _ = h.jobResultTargetLocked("n1", n.ws, s); target != nil {
		t.Fatal("cross-controller leak")
	}
	h.ctlws["c"].fp = "ctl"
	h.peers["c"] = "new-node"
	if target, _ = h.jobResultTargetLocked("n1", n.ws, s); target != nil {
		t.Fatal("old pair leaked")
	}
}

func TestConsoleMalformedAndOverlargeInputRejected(t *testing.T) {
	_, _, _, s := consoleFixture(t)
	for _, action := range []string{"spawn", "write", ""} {
		s.JobAction = action
		if validJobAction(s) {
			t.Fatal(action)
		}
	}
	s.JobAction, s.JobText = "input", strings.Repeat("x", 8193)
	if validJobAction(s) {
		t.Fatal("oversized input")
	}
	s.JobText, s.JobInputID = "input", ""
	if validJobAction(s) {
		t.Fatal("missing idempotency identity")
	}
}

func TestConsoleTerminalControlsAreBoundedAndLeased(t *testing.T) {
	for _, action := range []string{"resize", "signal"} {
		t.Run(action, func(t *testing.T) {
			h, r, c, s := consoleFixture(t)
			s.JobText, s.JobAction = "", action
			if action == "resize" {
				s.JobRows, s.JobCols = 24, 80
			} else {
				s.JobSignal = "interrupt"
			}
			_, out, err := h.prepareJobCommandLocked("c", c, s)
			if err != nil || out.JobRows != s.JobRows || out.JobCols != s.JobCols || out.JobSignal != s.JobSignal || out.JobInputID != s.JobInputID {
				t.Fatalf("control projection: %+v %v", out, err)
			}
			r.Goal = json.RawMessage(`{"id":"g","status":"paused"}`)
			if _, _, err = h.prepareJobCommandLocked("c", c, s); err == nil {
				t.Fatal("paused control allowed")
			}
			r.Goal = json.RawMessage(`{"id":"g","status":"running"}`)
			r.Lease.ExpiresAt = time.Now().Add(-time.Hour).Unix()
			if _, _, err = h.prepareJobCommandLocked("c", c, s); err == nil {
				t.Fatal("expired control allowed")
			}
			if len(r.Commands) != 0 {
				t.Fatal("control entered Goal replay ledger")
			}
		})
	}
	_, _, _, s := consoleFixture(t)
	s.JobText, s.JobAction, s.JobSignal = "", "signal", "eof"
	if !validJobAction(s) {
		t.Fatal("terminal eof rejected")
	}
	for _, signal := range []string{"kill", "terminate", "ctrl-z", ""} {
		s.JobSignal = signal
		if validJobAction(s) {
			t.Fatal("unbounded signal", signal)
		}
	}
	s.JobAction, s.JobSignal = "resize", ""
	for _, dimensions := range [][2]uint16{{10, 20}, {300, 500}, {24, 80}} {
		s.JobRows, s.JobCols = dimensions[0], dimensions[1]
		if !validJobAction(s) {
			t.Fatal("valid dimensions")
		}
	}
	for _, dimensions := range [][2]uint16{{9, 80}, {301, 80}, {24, 19}, {24, 501}, {0, 0}} {
		s.JobRows, s.JobCols = dimensions[0], dimensions[1]
		if validJobAction(s) {
			t.Fatal("invalid dimensions")
		}
	}
	s.JobRows, s.JobCols, s.JobInputID = 24, 80, ""
	if validJobAction(s) {
		t.Fatal("control without stable input receipt ID")
	}
}

func consoleSocketPair(t *testing.T) (*websocket.Conn, *websocket.Conn) {
	t.Helper()
	accepted := make(chan *websocket.Conn, 1)
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		accepted <- c
		<-done
	}))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		close(done)
		server.Close()
		t.Fatal(err)
	}
	var socket *websocket.Conn
	select {
	case socket = <-accepted:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	t.Cleanup(func() { client.CloseNow(); socket.CloseNow(); close(done); server.Close() })
	return socket, client
}

func TestConsoleActualWebSocketProjection(t *testing.T) {
	h, _, _, s := consoleFixture(t)
	controller, browser := consoleSocketPair(t)
	node, worker := consoleSocketPair(t)
	h.ctlws["c"].ws, h.nodes["n1"].ws = controller, node
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s.CtlFP = "forged"
	h.forwardJobCommand(ctx, "c", controller, s)
	var received sig
	if err := wsjson.Read(ctx, worker, &received); err != nil {
		t.Fatal(err)
	}
	if received.JobText != "private-input\n" || received.CtlFP != "ctl" || received.CommandID != s.CommandID {
		t.Fatal("wire projection changed")
	}
	received.K, received.JobOK, received.JobData = "job-command-result", true, json.RawMessage(`{"state":"written","bytes":14}`)
	h.forwardJobResult(ctx, "n1", node, &received)
	var result map[string]any
	if err := wsjson.Read(ctx, browser, &result); err != nil {
		t.Fatal(err)
	}
	if _, present := result["job_text"]; present {
		t.Fatal("secret echoed to browser")
	}
	if result["job_ok"] != true || result["job_input_id"] != "in" {
		t.Fatal("receipt correlation lost")
	}
}
