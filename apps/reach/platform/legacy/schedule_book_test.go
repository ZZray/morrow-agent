package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"
)

func scheduleFixture(t *testing.T) (*hubSrv, *longTaskRecord, scheduleRequest, time.Time) {
	t.Helper()
	h, goal := goalTestHub(t)
	h.nodes["n1"].ws = &websocket.Conn{}
	goal.Revision, goal.Writer, goal.Epoch = 7, "n1", "epoch-1"
	goal.Goal = json.RawMessage(`{"id":"g","revision":7,"status":"paused"}`)
	now := time.Now().Truncate(time.Second)
	q := scheduleRequest{ID: "once-1", Device: "fp", GoalID: "g", Session: "w/s", ExpectedRevision: 7, WriterEpoch: "epoch-1", DueAt: now.Add(time.Minute).Unix()}
	return h, goal, q, now
}
func saveSchedule(t *testing.T, h *hubSrv, q scheduleRequest, now time.Time) *scheduleRecord {
	t.Helper()
	if err := h.scheduleActionLocked("ctl", "schedule-save", q, now); err != nil {
		t.Fatal(err)
	}
	return h.schedules.Records[scheduleKey("ctl", q.ID)]
}
func TestScheduleStrictWireAndScope(t *testing.T) {
	h, _, q, now := scheduleFixture(t)
	for _, raw := range []string{``, `null`, `{}`, `{"id":"x","extra":1}`, `{"id":"x","due_at":"1"}`, `{"id":"x","due_at":1.5}`, `{"id":"x","due_at":9223372036854775808}`, `{"id":"x"} {"id":"y"}`, `{"id":"../x"}`, `{"id":"中文"}`} {
		if _, err := decodeSchedule(json.RawMessage(raw)); err == nil {
			t.Fatalf("invalid request admitted: %s", raw)
		}
	}
	if _, err := decodeSchedule(json.RawMessage(strings.Repeat(" ", 2049))); err == nil {
		t.Fatal("oversize request admitted")
	}
	raw, _ := json.Marshal(q)
	if decoded, err := decodeSchedule(raw); err != nil || decoded != q {
		t.Fatal("valid wire rejected", err)
	}
	saveSchedule(t, h, q, now)
	view := string(h.scheduleListLocked("ctl"))
	if !strings.Contains(view, "once-1") || strings.Contains(view, `"controller"`) || strings.Contains(view, `"writer"`) || strings.Contains(view, "prompt") {
		t.Fatal("invalid public view", view)
	}
	if got := string(h.scheduleListLocked("other")); got != `{"items":[]}` {
		t.Fatal("other controller saw schedules", got)
	}
	if err := h.scheduleActionLocked("other", "schedule-cancel", scheduleRequest{ID: q.ID}, now); err == nil {
		t.Fatal("another controller canceled schedule")
	}
}
func TestScheduleAdmissionBoundaries(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*hubSrv, *longTaskRecord, *scheduleRequest, time.Time)
	}{
		{"due now", func(h *hubSrv, g *longTaskRecord, q *scheduleRequest, n time.Time) { q.DueAt = n.Unix() }},
		{"due at lease", func(h *hubSrv, g *longTaskRecord, q *scheduleRequest, n time.Time) { q.DueAt = g.Lease.ExpiresAt }},
		{"due at approval", func(h *hubSrv, g *longTaskRecord, q *scheduleRequest, n time.Time) {
			h.approvals[q.Device].Exp = time.Unix(q.DueAt, 0)
		}},
		{"wrong owner", func(h *hubSrv, g *longTaskRecord, q *scheduleRequest, n time.Time) { g.Lease.Controller = "another" }},
		{"revoked", func(h *hubSrv, g *longTaskRecord, q *scheduleRequest, n time.Time) { g.Revoked = true }},
		{"denied", func(h *hubSrv, g *longTaskRecord, q *scheduleRequest, n time.Time) { h.denied[q.Device] = true }},
		{"expired", func(h *hubSrv, g *longTaskRecord, q *scheduleRequest, n time.Time) { g.Lease.ExpiresAt = n.Unix() }},
		{"session", func(h *hubSrv, g *longTaskRecord, q *scheduleRequest, n time.Time) { q.Session = "w/other" }},
		{"revision", func(h *hubSrv, g *longTaskRecord, q *scheduleRequest, n time.Time) { q.ExpectedRevision++ }},
		{"epoch", func(h *hubSrv, g *longTaskRecord, q *scheduleRequest, n time.Time) { q.WriterEpoch = "another" }},
		{"running", func(h *hubSrv, g *longTaskRecord, q *scheduleRequest, n time.Time) {
			g.Goal = json.RawMessage(`{"id":"g","revision":7,"status":"running"}`)
		}},
		{"offline", func(h *hubSrv, g *longTaskRecord, q *scheduleRequest, n time.Time) { delete(h.nodes, "n1") }},
		{"call budget", func(h *hubSrv, g *longTaskRecord, q *scheduleRequest, n time.Time) { g.Calls = g.Lease.MaxCalls }},
		{"slice budget", func(h *hubSrv, g *longTaskRecord, q *scheduleRequest, n time.Time) { g.Lease.MaxSlices = 1 }},
		{"same fingerprint new socket", func(h *hubSrv, g *longTaskRecord, q *scheduleRequest, n time.Time) {
			h.nodes["n2"] = &nodeConn{fp: q.Device, ws: &websocket.Conn{}}
			h.devNode[q.Device] = "n2"
		}},
		{"other pair", func(h *hubSrv, g *longTaskRecord, q *scheduleRequest, n time.Time) {
			h.peers["n1"] = "other"
			h.ctlws["other"] = &ctlConn{fp: "another", ws: &websocket.Conn{}}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, g, q, n := scheduleFixture(t)
			tc.mutate(h, g, &q, n)
			if err := h.scheduleActionLocked("ctl", "schedule-save", q, n); err == nil {
				t.Fatal("unsafe schedule admitted")
			}
			if len(h.schedules.Records) != 0 {
				t.Fatal("invalid schedule published")
			}
		})
	}
}
func TestScheduleIdempotencyPauseCancelAndCapacity(t *testing.T) {
	h, _, q, now := scheduleFixture(t)
	r := saveSchedule(t, h, q, now)
	if err := h.scheduleActionLocked("ctl", "schedule-save", q, now); err != nil || h.schedules.Records[scheduleKey("ctl", q.ID)] != r {
		t.Fatal("exact save retry changed identity", err)
	}
	changed := q
	changed.DueAt++
	if h.scheduleActionLocked("ctl", "schedule-save", changed, now) == nil {
		t.Fatal("changed duplicate admitted")
	}
	other := q
	other.ID = "another"
	if h.scheduleActionLocked("ctl", "schedule-save", other, now) == nil {
		t.Fatal("duplicate Goal schedule admitted")
	}
	if err := h.scheduleActionLocked("ctl", "schedule-pause", scheduleRequest{ID: q.ID}, now); err != nil || r.Status != "paused" {
		t.Fatal("pause failed", err)
	}
	if len(h.prepareSchedules(time.Unix(q.DueAt, 0))) != 0 {
		t.Fatal("paused schedule dispatched")
	}
	if err := h.scheduleActionLocked("ctl", "schedule-save", q, now); err != nil {
		t.Fatal("explicit future reactivation rejected", err)
	}
	r = h.schedules.Records[scheduleKey("ctl", q.ID)]
	if err := h.scheduleActionLocked("ctl", "schedule-cancel", scheduleRequest{ID: q.ID}, now); err != nil || r.Status != "canceled" {
		t.Fatal("cancel failed", err)
	}
	if err := h.scheduleActionLocked("ctl", "schedule-save", q, now); err != nil || r.Status != "canceled" {
		t.Fatal("save retry resurrected canceled schedule", err)
	}
	for i := 1; i < scheduleCapacity; i++ {
		id := fmt.Sprintf("history-%d", i)
		h.schedules.Records[scheduleKey("ctl", id)] = &scheduleRecord{scheduleView: scheduleView{scheduleRequest: scheduleRequest{ID: id}, Status: "canceled", CommandID: scheduleCommandID("ctl", id)}, Controller: "ctl"}
	}
	if h.scheduleActionLocked("ctl", "schedule-save", other, now) == nil {
		t.Fatal("capacity not enforced")
	}
}
func TestScheduleDispatchWithoutBrowserAndDurableAcknowledgement(t *testing.T) {
	h, g, q, now := scheduleFixture(t)
	r := saveSchedule(t, h, q, now)
	delete(h.ctlws, "c") // Clock authority is the saved controller lease, never a fabricated ctl connection.
	due := time.Unix(q.DueAt, 0)
	deliveries := h.prepareSchedules(due)
	if len(deliveries) != 1 || r.Status != "dispatching" || deliveries[0].command.Command != "resume" || g.Commands[r.CommandID] != "resume/7/" {
		t.Fatal("dispatch not reserved exactly once")
	}
	if len(h.prepareSchedules(due.Add(time.Second))) != 0 {
		t.Fatal("unacknowledged command replayed")
	}
	if h.scheduleActionLocked("ctl", "schedule-cancel", scheduleRequest{ID: q.ID}, now) == nil {
		t.Fatal("dispatching plan falsely canceled")
	}
	var disk scheduleBook
	raw, err := os.ReadFile(filepath.Join(confDir(), "schedules.json"))
	if err != nil || json.Unmarshal(raw, &disk) != nil || disk.Records[scheduleKey("ctl", q.ID)].Status != "dispatching" {
		t.Fatal("dispatch intent not durable", err)
	}
	command := deliveries[0].command
	h.recordGoalCommandResult(context.Background(), "n1", h.nodes["n1"].ws, &sig{K: "goal-command-result", GoalID: q.GoalID, SessionKey: q.Session, CommandID: command.CommandID, WriterEpoch: q.WriterEpoch, Goal: json.RawMessage(`{"id":"g","revision":8,"status":"running"}`)})
	if len(h.prepareSchedules(due.Add(2*time.Second))) != 0 || r.Status != "triggered" || len(r.Receipt) == 0 {
		t.Fatal("durable matching Node acknowledgement not reflected", r.Status)
	}
	if strings.Contains(string(r.Receipt), `"goal"`) || strings.Contains(string(r.Receipt), `"status":"completed"`) {
		t.Fatal("resume acknowledgement conflated with Goal completion")
	}
}
func TestScheduleDispatchRevalidatesOriginalAuthority(t *testing.T) {
	for _, mutation := range []string{"new-node", "epoch", "revision", "revoke", "expiry", "denied", "running", "owner"} {
		t.Run(mutation, func(t *testing.T) {
			h, g, q, now := scheduleFixture(t)
			r := saveSchedule(t, h, q, now)
			switch mutation {
			case "new-node":
				h.nodes["n2"] = &nodeConn{fp: q.Device, ws: &websocket.Conn{}}
				h.devNode[q.Device] = "n2"
				g.Writer = "n2"
			case "epoch":
				g.Epoch = "new-epoch"
			case "revision":
				g.Revision++
			case "revoke":
				g.Revoked = true
			case "expiry":
				h.approvals[q.Device].Exp = time.Unix(q.DueAt, 0)
			case "denied":
				h.denied[q.Device] = true
			case "running":
				g.Goal = json.RawMessage(`{"id":"g","revision":7,"status":"running"}`)
			case "owner":
				h.approvals[q.Device].CtlFP = "someone-else"
			}
			if len(h.prepareSchedules(time.Unix(q.DueAt, 0))) != 0 || r.Status != "failed" || len(g.Commands) != 0 {
				t.Fatal("changed authority dispatched", mutation, r.Status)
			}
		})
	}
}
func TestScheduleRestartAndReceiptTimeoutNeverReplay(t *testing.T) {
	h, _, q, now := scheduleFixture(t)
	r := saveSchedule(t, h, q, now)
	due := time.Unix(q.DueAt, 0)
	if len(h.prepareSchedules(due)) != 1 {
		t.Fatal("initial dispatch missing")
	}
	h.schedules = nil
	if len(h.prepareSchedules(due.Add(time.Second))) != 0 {
		t.Fatal("restart replayed unknown dispatch")
	}
	r = h.schedules.Records[scheduleKey("ctl", q.ID)]
	if r.Status != "unknown" {
		t.Fatal("restart did not preserve unknown effect", r.Status)
	}
	// Even an exact save transport retry cannot resurrect an unknown operation.
	if h.scheduleActionLocked("ctl", "schedule-save", q, now) != nil || r.Status != "unknown" {
		t.Fatal("unknown reset by duplicate save")
	}
	t.Run("no receipt", func(t *testing.T) {
		h, _, q, now := scheduleFixture(t)
		r := saveSchedule(t, h, q, now)
		due := time.Unix(q.DueAt, 0)
		h.prepareSchedules(due)
		if len(h.prepareSchedules(due.Add(scheduleReceiptWait))) != 0 || r.Status != "unknown" {
			t.Fatal("missing receipt not fenced")
		}
	})
	t.Run("restart missed", func(t *testing.T) {
		h, g, q, now := scheduleFixture(t)
		saveSchedule(t, h, q, now)
		h.schedules = nil
		if len(h.prepareSchedules(time.Unix(q.DueAt, 0))) != 0 || h.schedules.Records[scheduleKey("ctl", q.ID)].Status != "missed" || len(g.Commands) != 0 {
			t.Fatal("restart caught up expired schedule")
		}
	})
	t.Run("late tick", func(t *testing.T) {
		h, g, q, now := scheduleFixture(t)
		r := saveSchedule(t, h, q, now)
		if len(h.prepareSchedules(time.Unix(q.DueAt, 0).Add(scheduleMaxLateness+time.Second))) != 0 || r.Status != "missed" || len(g.Commands) != 0 {
			t.Fatal("late tick caught up schedule")
		}
	})
}
func TestScheduleCommandCollisionAndWrongReceiptDoNotSucceed(t *testing.T) {
	h, g, q, now := scheduleFixture(t)
	r := saveSchedule(t, h, q, now)
	g.Commands[r.CommandID] = "resume/7/"
	if len(h.prepareSchedules(time.Unix(q.DueAt, 0))) != 0 || r.Status != "unknown" {
		t.Fatal("reserved command identity replayed")
	}
	for _, field := range []string{"goal", "session", "command", "device", "epoch"} {
		t.Run(field, func(t *testing.T) {
			h, g, q, now := scheduleFixture(t)
			r := saveSchedule(t, h, q, now)
			due := time.Unix(q.DueAt, 0)
			h.prepareSchedules(due)
			receipt := sig{K: "goal-command-result", GoalID: q.GoalID, SessionKey: q.Session, CommandID: r.CommandID, FP: q.Device, WriterEpoch: q.WriterEpoch}
			switch field {
			case "goal":
				receipt.GoalID = "wrong"
			case "session":
				receipt.SessionKey = "w/wrong"
			case "command":
				receipt.CommandID = "wrong"
			case "device":
				receipt.FP = "wrong"
			case "epoch":
				receipt.WriterEpoch = "wrong"
			}
			g.Receipts = map[string]json.RawMessage{r.CommandID: json.RawMessage(mustJSON(receipt))}
			h.prepareSchedules(due.Add(time.Second))
			if r.Status != "dispatching" {
				t.Fatal("unrelated receipt accepted", field, r.Status)
			}
		})
	}
	t.Run("Node rejection", func(t *testing.T) {
		h, g, q, now := scheduleFixture(t)
		r := saveSchedule(t, h, q, now)
		due := time.Unix(q.DueAt, 0)
		h.prepareSchedules(due)
		g.Receipts = map[string]json.RawMessage{r.CommandID: json.RawMessage(mustJSON(sig{K: "goal-command-result", GoalID: q.GoalID, SessionKey: q.Session, CommandID: r.CommandID, FP: q.Device, WriterEpoch: q.WriterEpoch, Err: "rejected"}))}
		h.prepareSchedules(due.Add(time.Second))
		if r.Status != "failed" {
			t.Fatal("Node rejection called successful")
		}
	})
}
func TestSchedulePersistenceFailuresFenceAllDispatch(t *testing.T) {
	t.Run("save", func(t *testing.T) {
		h, g, q, now := scheduleFixture(t)
		if err := os.Mkdir(filepath.Join(confDir(), "schedules.json"), 0700); err != nil {
			t.Fatal(err)
		}
		if h.scheduleActionLocked("ctl", "schedule-save", q, now) == nil || len(h.schedules.Records) != 0 || len(g.Commands) != 0 {
			t.Fatal("save failure published intent")
		}
	})
	t.Run("dispatch intent", func(t *testing.T) {
		h, g, q, now := scheduleFixture(t)
		saveSchedule(t, h, q, now)
		path := filepath.Join(confDir(), "schedules.json")
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		if len(h.prepareSchedules(time.Unix(q.DueAt, 0))) != 0 || len(g.Commands) != 0 || h.schedules.loadErr == nil {
			t.Fatal("undurable dispatch sent")
		}
		if len(h.prepareSchedules(time.Unix(q.DueAt+1, 0))) != 0 {
			t.Fatal("fenced store retried")
		}
	})
	t.Run("command reservation", func(t *testing.T) {
		h, g, q, now := scheduleFixture(t)
		r := saveSchedule(t, h, q, now)
		if err := os.Mkdir(filepath.Join(confDir(), "goal-leases.json"), 0700); err != nil {
			t.Fatal(err)
		}
		if len(h.prepareSchedules(time.Unix(q.DueAt, 0))) != 0 || len(g.Commands) != 0 || r.Status != "unknown" {
			t.Fatal("failed command reservation sent", r.Status)
		}
	})
}
func TestScheduleCancelDueRaceHasOneWinner(t *testing.T) {
	for i := 0; i < 10; i++ {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			h, g, q, now := scheduleFixture(t)
			r := saveSchedule(t, h, q, now)
			var wg sync.WaitGroup
			var deliveries []scheduledDelivery
			var canceled error
			start := make(chan struct{})
			wg.Add(2)
			go func() { defer wg.Done(); <-start; deliveries = h.prepareSchedules(time.Unix(q.DueAt, 0)) }()
			go func() {
				defer wg.Done()
				<-start
				h.mu.Lock()
				defer h.mu.Unlock()
				canceled = h.scheduleActionLocked("ctl", "schedule-cancel", scheduleRequest{ID: q.ID}, now)
			}()
			close(start)
			wg.Wait()
			if r.Status == "canceled" {
				if canceled != nil || len(deliveries) != 0 || len(g.Commands) != 0 {
					t.Fatal("canceled plan dispatched")
				}
			} else if r.Status == "dispatching" {
				if canceled == nil || len(deliveries) != 1 || len(g.Commands) != 1 {
					t.Fatal("dispatch claimed canceled")
				}
			} else {
				t.Fatal("unexpected race state", r.Status)
			}
		})
	}
}
func TestScheduleActualControllerWebSocket(t *testing.T) {
	h, _, q, _ := scheduleFixture(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		h.mu.Lock()
		h.ctlws["browser"] = &ctlConn{fp: "ctl", ws: c}
		h.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		for {
			var incoming sig
			if wsjson.Read(ctx, c, &incoming) != nil {
				return
			}
			h.ctlMsg(ctx, "browser", c, &incoming)
		}
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	for _, operation := range []string{"schedule-list", "schedule-save", "schedule-pause", "schedule-cancel"} {
		raw, _ := json.Marshal(q)
		if operation == "schedule-list" {
			raw = nil
		}
		if err := wsjson.Write(ctx, c, sig{K: operation, ID: operation, Schedule: raw}); err != nil {
			t.Fatal(err)
		}
		var reply sig
		if err := wsjson.Read(ctx, c, &reply); err != nil {
			t.Fatal(err)
		}
		if reply.K != "schedule-result" || reply.ID != operation || reply.Err != "" {
			t.Fatal("actual WS operation failed", operation, reply.Err)
		}
	}
}

func TestScheduleActualNodeCommandAndReceiptWebSocket(t *testing.T) {
	h, _, q, now := scheduleFixture(t)
	ready, acknowledged := make(chan struct{}), make(chan error, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		c, err := websocket.Accept(w, request, nil)
		if err != nil {
			acknowledged <- err
			return
		}
		defer c.CloseNow()
		h.mu.Lock()
		h.nodes["n1"].ws = c
		h.mu.Unlock()
		close(ready)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var incoming sig
		if err := wsjson.Read(ctx, c, &incoming); err != nil {
			acknowledged <- err
			return
		}
		h.nodeMsg(ctx, "n1", c, &incoming)
		acknowledged <- nil
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	<-ready
	r := saveSchedule(t, h, q, now)
	due := time.Unix(q.DueAt, 0)
	deliveries := h.prepareSchedules(due)
	if len(deliveries) != 1 {
		t.Fatal("missing exactly-once command delivery")
	}
	wsSend(ctx, deliveries[0].node.ws, deliveries[0].command)
	var command sig
	if err := wsjson.Read(ctx, c, &command); err != nil {
		t.Fatal(err)
	}
	if command.K != "goal-command" || command.Command != "resume" || command.CommandID != r.CommandID || command.ExpectedRevision != q.ExpectedRevision {
		t.Fatal("wrong actual Node wire command")
	}
	if err := wsjson.Write(ctx, c, sig{K: "goal-command-result", CommandID: command.CommandID, GoalID: q.GoalID, SessionKey: q.Session, WriterEpoch: q.WriterEpoch, Goal: json.RawMessage(`{"id":"g","revision":8,"status":"running"}`)}); err != nil {
		t.Fatal(err)
	}
	if err := <-acknowledged; err != nil {
		t.Fatal(err)
	}
	h.prepareSchedules(due.Add(time.Second))
	if r.Status != "triggered" {
		t.Fatal("actual Node acknowledgement not observed", r.Status)
	}
}
