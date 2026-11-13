package main

// The cloud clock dispatches one previously authorized resume command. Native
// Goals still own execution, model-call budgets, Jobs, and completion review.
import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

const scheduleCapacity = 64 // Includes terminal history; evidence is never silently evicted.
const scheduleReceiptWait = 120 * time.Second
const scheduleMaxLateness = 5 * time.Second

type scheduleRequest struct {
	ID               string `json:"id"`
	Device           string `json:"device,omitempty"`
	GoalID           string `json:"goal_id,omitempty"`
	Session          string `json:"session,omitempty"`
	ExpectedRevision uint64 `json:"expected_revision,omitempty"`
	WriterEpoch      string `json:"writer_epoch,omitempty"`
	DueAt            int64  `json:"due_at,omitempty"`
}
type scheduleView struct {
	scheduleRequest
	Status    string          `json:"status"`
	CommandID string          `json:"command_id"`
	CreatedAt int64           `json:"created_at"`
	UpdatedAt int64           `json:"updated_at"`
	Reason    string          `json:"reason,omitempty"`
	Receipt   json.RawMessage `json:"receipt,omitempty"`
}
type scheduleRecord struct {
	scheduleView
	Controller string `json:"controller"`
	Writer     string `json:"writer"` // Original live Node connection, never replaced on rejoin.
}
type scheduleBook struct {
	Records map[string]*scheduleRecord `json:"records"`
	loadErr error
}

func scheduleKey(controller, id string) string { return controller + "\x00" + id }
func scheduleID(id string) bool {
	if id == "" || len(id) > 96 {
		return false
	}
	for _, c := range id {
		if c != '-' && c != '_' && (c < '0' || c > '9') && (c < 'A' || c > 'Z') && (c < 'a' || c > 'z') {
			return false
		}
	}
	return true
}
func scheduleCommandID(controller, id string) string {
	hash := sha256.Sum256([]byte(scheduleKey(controller, id)))
	return "schedule-" + hex.EncodeToString(hash[:])
}
func decodeSchedule(raw json.RawMessage) (scheduleRequest, error) {
	var q scheduleRequest
	if len(raw) == 0 || len(raw) > 2048 {
		return q, errors.New("schedule request exceeds limit or is missing")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&q); err != nil {
		return q, errors.New("invalid schedule request")
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return q, errors.New("invalid schedule request")
	}
	if !scheduleID(q.ID) {
		return q, errors.New("schedule id must contain 1..96 ASCII letters, digits, underscores or hyphens")
	}
	return q, nil
}
func (h *hubSrv) schedulesLocked(now time.Time) *scheduleBook {
	if h.schedules != nil {
		return h.schedules
	}
	b := &scheduleBook{Records: map[string]*scheduleRecord{}}
	raw, err := os.ReadFile(filepath.Join(confDir(), "schedules.json"))
	if err == nil {
		if len(raw) > 128<<10 {
			b.loadErr = errors.New("schedule store exceeds limit")
		} else if json.Unmarshal(raw, b) != nil || len(b.Records) > scheduleCapacity {
			b.loadErr = errors.New("invalid schedule store")
		}
	} else if !os.IsNotExist(err) {
		b.loadErr = errors.New("schedule store unreadable")
	}
	if b.Records == nil {
		b.Records = map[string]*scheduleRecord{}
	}
	h.schedules = b
	if b.loadErr != nil {
		return b
	}
	changed := false
	for key, r := range b.Records {
		if r == nil || key != scheduleKey(r.Controller, r.ID) || !scheduleID(r.ID) || r.Controller == "" || r.CommandID != scheduleCommandID(r.Controller, r.ID) {
			b.loadErr = errors.New("invalid schedule record")
			return b
		}
		switch r.Status {
		case "dispatching":
			r.Status, r.Reason, r.UpdatedAt = "unknown", "Hub restarted after dispatch intent; inspect the Goal and command receipt before any new action", now.Unix()
			changed = true
		case "scheduled":
			if r.DueAt <= now.Unix() {
				r.Status, r.Reason, r.UpdatedAt = "missed", "Hub was not active at the scheduled time; no catch-up dispatch", now.Unix()
				changed = true
			}
		case "paused", "canceled", "triggered", "failed", "missed", "unknown":
		default:
			b.loadErr = errors.New("invalid schedule status")
			return b
		}
	}
	if changed {
		if err := h.saveSchedulesLocked(); err != nil {
			b.loadErr = errors.New("schedule recovery persistence failed")
		}
	}
	return b
}
func (h *hubSrv) saveSchedulesLocked() error {
	b := h.schedules
	if b == nil || b.loadErr != nil {
		return errors.New("schedule store unavailable")
	}
	raw, err := json.Marshal(b)
	if err != nil {
		return err
	}
	if len(raw) > 128<<10 {
		return errors.New("schedule store exceeds limit")
	}
	return atomicWriteFile(filepath.Join(confDir(), "schedules.json"), raw)
}

// No pairing or lease extension occurs here. A changed transport/writer is a
// failed precondition, even if a new connection advertises the same fingerprint.
func (h *hubSrv) admitScheduleLocked(q scheduleRequest, controller, writer string, now time.Time, dispatch bool) (*longTaskRecord, error) {
	if !validGoalID(q.Device) || !validGoalID(q.GoalID) || !validGoalSession(q.Session) || q.ExpectedRevision == 0 || !validGoalID(q.WriterEpoch) {
		return nil, errors.New("schedule requires a versioned paused Goal and Session")
	}
	if !dispatch && q.DueAt <= now.Unix() {
		return nil, errors.New("schedule time must be in the future")
	}
	b := h.longTasksLocked()
	if b.loadErr != nil {
		return nil, errors.New("Goal lease store unavailable")
	}
	r := b.Records[longTaskKey(q.Device, q.GoalID)]
	if r == nil || r.Revoked || r.Lease.Controller != controller || r.Lease.Session != q.Session || r.Lease.ExpiresAt <= now.Unix() || !h.goalLiveLocked(r) {
		return nil, errors.New("Goal lease is not live for this controller and Session")
	}
	if q.DueAt >= r.Lease.ExpiresAt {
		return nil, errors.New("schedule must precede the original Goal lease expiry")
	}
	ap := h.approvals[q.Device]
	if ap == nil || ap.CtlFP != controller || !ap.live() || (!ap.Exp.IsZero() && ap.Exp.Unix() <= now.Unix()) || (!ap.Exp.IsZero() && q.DueAt >= ap.Exp.Unix()) {
		return nil, errors.New("schedule must remain within the original device approval")
	}
	nid := h.devNode[q.Device]
	n := h.nodes[nid]
	if n == nil || n.ws == nil || h.deviceEligibleLocked(q.Device, n.ws) != nil {
		return nil, errors.New("scheduled device is offline or unauthorized")
	}
	if r.Writer != nid || r.Epoch != q.WriterEpoch || writer != "" && writer != nid {
		return nil, errors.New("Goal writer connection changed; reconnect and inspect before creating a new schedule")
	}
	// A live pair to a different controller must never be stolen by the clock.
	if peer := h.peers[nid]; peer != "" {
		cc := h.ctlws[peer]
		if cc == nil || cc.fp != controller {
			return nil, errors.New("device is connected to another controller")
		}
	}
	var goal goalMirror
	if json.Unmarshal(r.Goal, &goal) != nil || goal.ID != q.GoalID || goal.Status != "paused" || goal.Revision != q.ExpectedRevision || r.Revision != q.ExpectedRevision {
		return nil, errors.New("Goal is not paused at the scheduled revision")
	}
	if r.Calls >= r.Lease.MaxCalls || uint32(len(r.Runs)) >= r.Lease.MaxSlices {
		return nil, errors.New("Goal root budget is exhausted")
	}
	return r, nil
}
func (h *hubSrv) scheduleActionLocked(controller, operation string, q scheduleRequest, now time.Time) error {
	b := h.schedulesLocked(now)
	if b.loadErr != nil {
		return b.loadErr
	}
	key := scheduleKey(controller, q.ID)
	r := b.Records[key]
	if operation == "schedule-save" {
		if r != nil && r.scheduleRequest != q {
			return errors.New("schedule id already belongs to different content")
		}
		if r != nil && r.Status != "paused" {
			return nil
		} // Exact transport retry never resets a terminal result.
		if _, err := h.admitScheduleLocked(q, controller, "", now, false); err != nil {
			return err
		}
		for otherKey, other := range b.Records {
			if otherKey != key && other.Controller == controller && other.Device == q.Device && other.GoalID == q.GoalID && (other.Status == "scheduled" || other.Status == "paused" || other.Status == "dispatching" || other.Status == "unknown") {
				return errors.New("this Goal already has a retained active or unresolved schedule")
			}
		}
		if r == nil && len(b.Records) >= scheduleCapacity {
			return errors.New("schedule capacity reached (64 retained records); history is preserved")
		}
		entry := &scheduleRecord{scheduleView: scheduleView{scheduleRequest: q, Status: "scheduled", CommandID: scheduleCommandID(controller, q.ID), CreatedAt: now.Unix(), UpdatedAt: now.Unix()}, Controller: controller, Writer: h.devNode[q.Device]}
		if r != nil {
			entry.CreatedAt = r.CreatedAt
			entry.Writer = r.Writer
			if _, err := h.admitScheduleLocked(q, controller, r.Writer, now, false); err != nil {
				return err
			}
		}
		b.Records[key] = entry
		if err := h.saveSchedulesLocked(); err != nil {
			if r == nil {
				delete(b.Records, key)
			} else {
				b.Records[key] = r
			}
			return errors.New("schedule persistence failed")
		}
		return nil
	}
	if r == nil {
		return errors.New("schedule not found")
	}
	next := "paused"
	if operation == "schedule-cancel" {
		next = "canceled"
	}
	if r.Status == next {
		return nil
	}
	if r.Status != "scheduled" && r.Status != "paused" {
		return errors.New("schedule already dispatched or settled; inspect the Goal instead")
	}
	if r.DueAt <= now.Unix() {
		return errors.New("schedule time reached; refresh its dispatch status")
	}
	old := *r
	r.Status, r.UpdatedAt = next, now.Unix()
	if err := h.saveSchedulesLocked(); err != nil {
		*r = old
		return errors.New("schedule persistence failed")
	}
	return nil
}
func (h *hubSrv) scheduleListLocked(controller string) json.RawMessage {
	items := make([]scheduleView, 0)
	if h.schedules != nil && h.schedules.loadErr == nil {
		for _, r := range h.schedules.Records {
			if r.Controller == controller {
				items = append(items, r.scheduleView)
			}
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].CreatedAt != items[j].CreatedAt {
			return items[i].CreatedAt > items[j].CreatedAt
		}
		return items[i].ID < items[j].ID
	})
	raw, _ := json.Marshal(struct {
		Items []scheduleView `json:"items"`
	}{items})
	return raw
}
func (h *hubSrv) handleSchedule(ctx context.Context, id string, c *websocket.Conn, s *sig) {
	h.mu.Lock()
	defer h.mu.Unlock()
	cc := h.ctlws[id]
	if cc == nil || cc.ws != c || strings.TrimSpace(cc.fp) == "" {
		wsSend(ctx, c, &sig{K: "schedule-result", ID: s.ID, Err: "authenticated controller required"})
		return
	}
	var err error
	b := h.schedulesLocked(time.Now())
	if b.loadErr != nil {
		err = b.loadErr
	} else if s.K != "schedule-list" {
		var q scheduleRequest
		q, err = decodeSchedule(s.Schedule)
		if err == nil {
			err = h.scheduleActionLocked(cc.fp, s.K, q, time.Now())
		}
	}
	reply := &sig{K: "schedule-result", ID: s.ID, Schedule: h.scheduleListLocked(cc.fp)}
	if err != nil {
		reply.Err = err.Error()
	}
	wsSend(ctx, c, reply)
}

type scheduledDelivery struct {
	node    *nodeConn
	command *sig
}

func (h *hubSrv) persistScheduleStateLocked(r *scheduleRecord, status, reason string, now time.Time) error {
	old := *r
	r.Status, r.Reason, r.UpdatedAt = status, reason, now.Unix()
	if err := h.saveSchedulesLocked(); err != nil {
		*r = old
		h.schedules.loadErr = errors.New("schedule state persistence failed; dispatch is fenced")
		return err
	}
	log.Printf("schedule id=%s status=%s", r.ID, status)
	return nil
}

// prepareSchedules is a durable outbox boundary. Deliveries may be sent only
// once in this process; neither a missing receipt nor a restart retries them.
func (h *hubSrv) prepareSchedules(now time.Time) []scheduledDelivery {
	h.mu.Lock()
	defer h.mu.Unlock()
	b := h.schedulesLocked(now)
	if b.loadErr != nil {
		return nil
	}
	deliveries := make([]scheduledDelivery, 0)
	for _, r := range b.Records {
		if r.Status == "dispatching" {
			goal := h.longTasksLocked().Records[longTaskKey(r.Device, r.GoalID)]
			if goal != nil && len(goal.Receipts[r.CommandID]) > 0 {
				var receipt sig
				if json.Unmarshal(goal.Receipts[r.CommandID], &receipt) == nil && receipt.GoalID == r.GoalID && receipt.SessionKey == r.Session && receipt.CommandID == r.CommandID && receipt.FP == r.Device && receipt.WriterEpoch == r.WriterEpoch {
					status, reason := "triggered", "Node acknowledged resume; Goal execution and review remain separate"
					if receipt.Err != "" {
						status, reason = "failed", "Node rejected the resume command; inspect its Goal state"
					}
					// No prompt or native Goal body is copied into the schedule store.
					raw, _ := json.Marshal(map[string]any{"command_id": receipt.CommandID, "acknowledged": receipt.Err == "", "writer_epoch": receipt.WriterEpoch})
					r.Receipt = raw
					if h.persistScheduleStateLocked(r, status, reason, now) != nil {
						return deliveries
					}
					continue
				}
			}
			if now.Unix()-r.UpdatedAt >= int64(scheduleReceiptWait/time.Second) {
				if h.persistScheduleStateLocked(r, "unknown", "No durable matching Node receipt; inspect the Goal before any new action", now) != nil {
					return deliveries
				}
			}
			continue
		}
		if r.Status != "scheduled" || r.DueAt > now.Unix() {
			continue
		}
		if now.Unix()-r.DueAt > int64(scheduleMaxLateness/time.Second) {
			if h.persistScheduleStateLocked(r, "missed", "Scheduled time elapsed; no catch-up dispatch", now) != nil {
				return deliveries
			}
			continue
		}
		goal, err := h.admitScheduleLocked(r.scheduleRequest, r.Controller, r.Writer, now, true)
		if err != nil {
			if h.persistScheduleStateLocked(r, "failed", err.Error(), now) != nil {
				return deliveries
			}
			continue
		}
		if _, exists := goal.Commands[r.CommandID]; exists {
			if h.persistScheduleStateLocked(r, "unknown", "Command identity already reserved; no replay", now) != nil {
				return deliveries
			}
			continue
		}
		if h.persistScheduleStateLocked(r, "dispatching", "Resume intent saved; awaiting Node receipt", now) != nil {
			return deliveries
		}
		command := &sig{K: "goal-command", FP: r.Device, GoalID: r.GoalID, SessionKey: r.Session, CommandID: r.CommandID, Command: "resume", ExpectedRevision: r.ExpectedRevision}
		n, receipt, err := h.prepareGoalCommandLocked(r.Controller, command)
		if err != nil || receipt != nil {
			if h.persistScheduleStateLocked(r, "unknown", "Command reservation failed or already exists; no dispatch retry", now) != nil {
				return deliveries
			}
			continue
		}
		deliveries = append(deliveries, scheduledDelivery{n, command})
	}
	return deliveries
}
func (h *hubSrv) scheduleSweep() {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for now := range tick.C {
		deliveries := h.prepareSchedules(now)
		// Network writes never hold h.mu. The bounded batch has no retry path.
		var pending sync.WaitGroup
		for _, delivery := range deliveries {
			pending.Add(1)
			go func(d scheduledDelivery) {
				defer pending.Done()
				ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
				defer cancel()
				wsSend(ctx, d.node.ws, d.command)
			}(delivery)
		}
		pending.Wait()
	}
}
