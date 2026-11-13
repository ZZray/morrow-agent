package main

// The Hub records bounded authorization and mirrors Node state. It never runs
// a Goal, schedules a slice, or treats a successful Run as user acceptance.
import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"nhooyr.io/websocket"
)

type goalPolicy struct {
	ExpiresAt int64  `json:"expires_at"`
	MaxCalls  uint32 `json:"max_calls"`
	MaxSlices uint32 `json:"max_slices"`
	AllowJobs bool   `json:"allow_jobs"`
}
type goalLease struct {
	GoalID     string `json:"goal_id"`
	Controller string `json:"controller"`
	Device     string `json:"device"`
	Session    string `json:"session"`
	goalPolicy
}
type goalMirror struct {
	ID             string `json:"id"`
	Revision       uint64 `json:"revision"`
	Run            string `json:"run"`
	LastSettledRun string `json:"last_settled_run"`
	Status         string `json:"status"`
}
type longTaskRecord struct {
	RequestedModel    string                     `json:"requested_model,omitempty"`
	RequestedProtocol string                     `json:"requested_protocol,omitempty"`
	Lease             goalLease                  `json:"lease"`
	Pin               *sessionPin                `json:"pin,omitempty"`
	Runs              map[string]bool            `json:"runs"`
	Commands          map[string]string          `json:"commands"`
	Receipts          map[string]json.RawMessage `json:"receipts,omitempty"`
	Goal              json.RawMessage            `json:"goal,omitempty"`
	Epoch             string                     `json:"epoch,omitempty"`
	Revision          uint64                     `json:"revision"`
	Calls             uint32                     `json:"calls"`
	Writer            string                     `json:"-"`
	Revoked           bool                       `json:"revoked,omitempty"`
}
type longTaskBook struct {
	Records map[string]*longTaskRecord `json:"records"`
	loadErr error
}

func longTaskKey(device, goal string) string { return device + "\x00" + goal }
func validGoalID(s string) bool {
	return s != "" && len(s) <= 192 && !strings.ContainsAny(s, "\x00\r\n")
}
func validGoalSession(s string) bool {
	p := strings.Split(s, "/")
	return len(p) == 2 && validGoalID(p[0]) && validGoalID(p[1])
}
func (p goalPolicy) valid(now time.Time) bool {
	return p.ExpiresAt > now.Unix() && p.ExpiresAt <= now.Add(24*time.Hour).Unix() && p.MaxCalls >= 1 && p.MaxCalls <= 256 && p.MaxSlices >= 1 && p.MaxSlices <= 32
}

// All book access and durable CAS transactions are under h.mu. A failed write
// is reported before forwarding controller authorization or acknowledging state.
func (h *hubSrv) longTasksLocked() *longTaskBook {
	if h.longTasks != nil {
		return h.longTasks
	}
	b := &longTaskBook{Records: map[string]*longTaskRecord{}}
	raw, err := os.ReadFile(filepath.Join(confDir(), "goal-leases.json"))
	if err == nil {
		if len(raw) > 4<<20 {
			b.loadErr = errors.New("goal lease store exceeds limit")
		} else if err = json.Unmarshal(raw, b); err != nil {
			b.loadErr = errors.New("invalid goal lease store")
		}
	} else if !os.IsNotExist(err) {
		b.loadErr = err
	}
	if b.Records == nil {
		b.Records = map[string]*longTaskRecord{}
	}
	h.longTasks = b
	return b
}
func (h *hubSrv) saveLongTasksLocked() error {
	b := h.longTasksLocked()
	if b.loadErr != nil {
		return b.loadErr
	}
	raw, err := json.Marshal(b)
	if err != nil {
		return err
	}
	if len(raw) > 4<<20 {
		return errors.New("goal lease store exceeds limit")
	}
	return atomicWriteFile(filepath.Join(confDir(), "goal-leases.json"), raw)
}
func (h *hubSrv) goalLiveLocked(r *longTaskRecord) bool {
	if r != nil && len(r.Goal) > 0 {
		var m goalMirror
		if json.Unmarshal(r.Goal, &m) != nil || m.Status == "accepted" || m.Status == "canceled" {
			return false
		}
	}
	return r != nil && !r.Revoked && r.Lease.ExpiresAt > time.Now().Unix() && h.approvals[r.Lease.Device].live() && !h.denied[r.Lease.Device] && h.approvals[r.Lease.Device].CtlFP == r.Lease.Controller
}

// Only the authenticated, currently paired controller may create authorization.
// DC-provided goal_lease is deliberately ignored; only goal_policy is a request.
func (h *hubSrv) registerGoalRelay(id string, c *websocket.Conn, s *sig) error {
	if s.K != "dc" {
		return nil
	}
	raw, err := base64.StdEncoding.DecodeString(s.D)
	if err != nil {
		return err
	}
	var f struct {
		K        string      `json:"k"`
		ID       string      `json:"id"`
		Mode     string      `json:"execution_mode"`
		GoalID   string      `json:"goal_id"`
		Session  string      `json:"session_key"`
		Policy   *goalPolicy `json:"goal_policy"`
		Model    string      `json:"model"`
		Protocol string      `json:"protocol"`
	}
	if json.Unmarshal(raw, &f) != nil || f.K != "agent-loop" || f.Policy == nil {
		return nil
	}
	if f.Mode != "goal" || !validGoalID(f.ID) || !validGoalSession(f.Session) || !f.Policy.valid(time.Now()) {
		return errors.New("invalid bounded goal policy")
	}
	goal := f.GoalID
	if goal == "" {
		goal = f.ID
	}
	if !validGoalID(goal) {
		return errors.New("invalid goal id")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	cc := h.ctlws[id]
	n := h.nodes[h.peers[id]]
	if cc == nil || cc.ws != c || cc.fp == "" || n == nil || h.deviceEligibleLocked(n.fp, n.ws) != nil || h.approvals[n.fp].CtlFP != cc.fp {
		return errors.New("goal authorization requires the approved paired controller")
	}
	b := h.longTasksLocked()
	if b.loadErr != nil {
		return b.loadErr
	}
	key := longTaskKey(n.fp, goal)
	lease := goalLease{GoalID: goal, Controller: cc.fp, Device: n.fp, Session: f.Session, goalPolicy: *f.Policy}
	// A disconnected independent worker can only enforce the expiry in its
	// signed-by-Host contract, so never give it longer than device approval.
	if approvedUntil := h.approvals[n.fp].Exp; !approvedUntil.IsZero() && approvedUntil.Unix() < lease.ExpiresAt {
		lease.ExpiresAt = approvedUntil.Unix()
	}
	if lease.ExpiresAt <= time.Now().Unix() {
		return errors.New("device approval expires before goal authorization can start")
	}
	if old := b.Records[key]; old != nil {
		if old.Lease != lease || !h.goalLiveLocked(old) {
			return errors.New("goal lease cannot be replaced or extended")
		}
		return nil
	}
	for _, other := range b.Records {
		if other.Lease.Controller == cc.fp && other.Lease.Device == n.fp && other.Lease.Session == f.Session && !other.Revoked {
			var m goalMirror
			if json.Unmarshal(other.Goal, &m) != nil || (m.Status != "accepted" && m.Status != "canceled") {
				return errors.New("this Session already has an unresolved goal; explicitly accept or stop it first")
			}
		}
	}
	if len(b.Records) >= 256 {
		return errors.New("goal lease capacity reached")
	}
	b.Records[key] = &longTaskRecord{Lease: lease, Runs: map[string]bool{}, Commands: map[string]string{}, RequestedModel: f.Model, RequestedProtocol: f.Protocol}
	if err := h.saveLongTasksLocked(); err != nil {
		delete(b.Records, key)
		return err
	}
	return nil
}

// Each new Run reserves one slice before network work. A duplicate Run never
// consumes another slice; failed reservations remain charged conservatively.
func (h *hubSrv) issueGoalGrant(ctx context.Context, id string, c *websocket.Conn, s *sig) bool {
	if s.GoalID == "" {
		return false
	}
	deny := func(err error) bool { h.denySmartGrant(ctx, c, s.ID, err.Error()); return true }
	h.mu.Lock()
	n := h.nodes[id]
	if n == nil || n.ws != c || h.deviceEligibleLocked(n.fp, c) != nil {
		h.mu.Unlock()
		return deny(errors.New("goal device connection is not authorized"))
	}
	fp := n.fp
	b := h.longTasksLocked()
	r := b.Records[longTaskKey(fp, s.GoalID)]
	if b.loadErr != nil || !h.goalLiveLocked(r) || r.Lease.Session != s.SessionKey || !validGoalID(s.Run) {
		h.mu.Unlock()
		return deny(errors.New("no live matching controller goal lease"))
	}
	if r.Runs == nil {
		r.Runs = map[string]bool{}
	}
	for _, other := range b.Records {
		if other != r && other.Lease.Device == fp && other.Runs[s.Run] {
			h.mu.Unlock()
			return deny(errors.New("run already belongs to another goal"))
		}
	}
	if !r.Runs[s.Run] {
		if s.Renew || uint32(len(r.Runs)) >= r.Lease.MaxSlices {
			h.mu.Unlock()
			return deny(errors.New("goal slice budget exhausted or unknown renewal"))
		}
		r.Runs[s.Run] = true
		if err := h.saveLongTasksLocked(); err != nil {
			delete(r.Runs, s.Run)
			h.mu.Unlock()
			return deny(err)
		}
	}
	pin := r.Pin
	requestedModel, requestedProtocol := r.RequestedModel, r.RequestedProtocol
	h.mu.Unlock()
	copySig := *s
	copySig.Smart = true
	if pin != nil {
		if !pin.DecisionExp.IsZero() && !time.Now().Before(pin.DecisionExp) {
			return deny(errors.New("waiting_authorization: trusted goal decision expired"))
		}
		bk := h.bindings()
		if _, ok := bk.findPin(fp, pin.BindingID); !ok {
			return deny(errors.New("waiting_authorization: trusted binding was lost; reconnect requires review"))
		}
		copySig.Binding = pin.BindingID
	} else {
		// Auto/default remain the configured logical model. Background authority
		// does not require a routing model or turn a random alias into a physical pin.
		pc, _, err := h.gw.providerConfig(ctx, requestedModel, requestedProtocol)
		if err != nil {
			return deny(err)
		}
		h.mu.Lock()
		if !h.goalLiveLocked(r) || h.deviceEligibleLocked(fp, c) != nil {
			h.mu.Unlock()
			return deny(errors.New("goal authorization changed"))
		}
		if h.bind == nil {
			h.bind = newBindingBook()
		}
		decision, err := mintCode()
		if err != nil {
			h.mu.Unlock()
			return deny(err)
		}
		p, err := h.bind.pinSession(fp, sessionPin{Model: pc.Model, Protocol: pc.API, DecisionID: "host-explicit-" + decision, DecisionExp: time.Unix(r.Lease.ExpiresAt, 0), DecisionSource: "host-explicit", MaxOutputTokens: smartMaxOutputTokens, RequiresTools: s.RequiresTools})
		h.mu.Unlock()
		if err != nil {
			return deny(err)
		}
		copySig.Binding = p.BindingID
	}
	if s.Renew {
		h.renewSmartGrant(ctx, s.ID, c, fp, s.Run, copySig.Binding)
	} else {
		h.issueSmartGrant(ctx, s.ID, c, &copySig, fp, s.Run)
	}
	return true
}

// Called immediately before a trusted smart grant is sent. Captures the first
// Hub-selected tuple and caps the access code at the absolute Goal expiry.
func (h *hubSrv) finalizeGoalGrant(fp string, pin *sessionPin, g *runGrant) (*goalLease, *runGrant, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.longTasks == nil {
		return nil, g, nil
	}
	for _, r := range h.longTasks.Records {
		if r.Lease.Device != fp || !r.Runs[g.RunID] {
			continue
		}
		if !h.goalLiveLocked(r) {
			return nil, g, errors.New("goal lease expired or revoked")
		}
		if r.Pin != nil && (r.Pin.BindingID != pin.BindingID || r.Pin.Model != pin.Model || r.Pin.Protocol != pin.Protocol) {
			return nil, g, errors.New("goal trusted tuple changed")
		}
		old := r.Pin
		if old == nil {
			p := *pin
			r.Pin = &p
			if err := h.saveLongTasksLocked(); err != nil {
				r.Pin = old
				return nil, g, err
			}
		}
		lease := r.Lease
		capped := *g
		if exp := time.Unix(lease.ExpiresAt, 0); exp.Before(capped.Exp) {
			capped.Exp = exp
			h.bind.mu.Lock()
			h.bind.runs[bindingKey(fp, g.RunID)] = &capped
			h.bind.mu.Unlock()
		}
		return &lease, &capped, nil
	}
	return nil, g, nil
}

func (h *hubSrv) detachGoalControllerLocked(controller, device string) bool {
	for _, r := range h.longTasksLocked().Records {
		if r.Lease.Controller == controller && r.Lease.Device == device && h.goalLiveLocked(r) {
			return true
		}
	}
	return false
}
func (h *hubSrv) revokeControllerGoalsLocked(controller, device string) {
	for _, r := range h.longTasksLocked().Records {
		if r.Lease.Controller == controller && r.Lease.Device == device {
			r.Revoked = true
			if h.bind != nil {
				for run := range r.Runs {
					h.bind.endRun(device, run)
				}
			}
		}
	}
	_ = h.saveLongTasksLocked()
}
func (h *hubSrv) goalNodeOfflineLocked(device string) { // No resumption or replay is scheduled here.
	if h.longTasks == nil {
		return
	}
	for _, r := range h.longTasks.Records {
		if r.Lease.Device == device {
			r.Writer = ""
		}
	}
}

// Each actual model HTTP attempt is charged before proxying. Catalog reads are
// not model calls. Retries count; persistence failure refuses the upstream call.
func (h *hubSrv) chargeGoalCall(fp, run string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.longTasks == nil {
		return nil
	}
	for _, r := range h.longTasks.Records {
		if r.Lease.Device != fp || !r.Runs[run] {
			continue
		}
		if !h.goalLiveLocked(r) {
			return errors.New("goal lease expired or revoked")
		}
		if r.Calls >= r.Lease.MaxCalls {
			return errors.New("goal model-call budget exhausted")
		}
		r.Calls++
		if err := h.saveLongTasksLocked(); err != nil {
			r.Calls--
			return errors.New("goal call receipt persistence failed")
		}
		return nil
	}
	return nil
}
func (h *hubSrv) recordGoalState(ctx context.Context, id string, c *websocket.Conn, s *sig) {
	var m goalMirror
	if len(s.Goal) > 32<<10 || json.Unmarshal(s.Goal, &m) != nil || !validGoalID(m.ID) || m.Revision == 0 || !validGoalID(s.WriterEpoch) {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	n := h.nodes[id]
	if n == nil || n.ws != c || h.deviceEligibleLocked(n.fp, c) != nil {
		return
	}
	r := h.longTasksLocked().Records[longTaskKey(n.fp, m.ID)]
	if r == nil || r.Lease.Session != s.SessionKey || r.Revoked || (r.Writer != "" && r.Writer == id && r.Epoch != s.WriterEpoch) || m.Revision <= r.Revision {
		return
	}
	if m.Run != "" && !r.Runs[m.Run] && r.Commands[m.Run] == "" || m.LastSettledRun != "" && !r.Runs[m.LastSettledRun] {
		return
	}
	prev := *r
	r.Goal = append(json.RawMessage(nil), s.Goal...)
	r.Revision = m.Revision
	r.Epoch = s.WriterEpoch
	r.Writer = id
	if err := h.saveLongTasksLocked(); err != nil {
		*r = prev
		return
	}
	for _, cc := range h.ctlws {
		if cc.fp == r.Lease.Controller {
			wsSend(ctx, cc.ws, &sig{K: "goal-state", Goal: s.Goal, WriterEpoch: s.WriterEpoch, SessionKey: s.SessionKey, GoalLease: &r.Lease, FP: n.fp})
		}
	}
}

// prepareGoalCommandLocked shares the existing command ledger with scheduled
// resumes. The caller owns h.mu and supplies an already authenticated controller.
// Manual retries retain their original receipt/retransmission semantics; a
// scheduler must separately refuse any pre-existing command identity.
func (h *hubSrv) prepareGoalCommandLocked(controller string, s *sig) (*nodeConn, *sig, error) {
	if controller == "" || !validGoalID(s.GoalID) || !validGoalID(s.CommandID) || (s.Command != "accept" && s.Command != "resume" && s.Command != "pause" && s.Command != "stop") {
		return nil, nil, errors.New("invalid goal command")
	}
	r := h.longTasksLocked().Records[longTaskKey(s.FP, s.GoalID)]
	if r == nil || r.Lease.Controller != controller || r.Lease.Session != s.SessionKey || r.Revoked {
		return nil, nil, errors.New("goal controller/session mismatch")
	}
	payload := fmt.Sprintf("%s/%d/%s", s.Command, s.ExpectedRevision, s.ReviewedRunID)
	if r.Commands == nil {
		r.Commands = map[string]string{}
	}
	old, duplicate := r.Commands[s.CommandID]
	if duplicate && old != payload {
		return nil, nil, errors.New("command id reused with different content")
	}
	if duplicate && len(r.Receipts[s.CommandID]) > 0 {
		var receipt sig
		if json.Unmarshal(r.Receipts[s.CommandID], &receipt) != nil {
			return nil, nil, errors.New("invalid durable command receipt")
		}
		return nil, &receipt, nil
	}
	n := h.nodes[h.devNode[r.Lease.Device]]
	if n == nil || h.deviceEligibleLocked(n.fp, n.ws) != nil {
		return nil, nil, errors.New("goal device offline or unauthorized")
	}
	if !duplicate {
		if s.ExpectedRevision != r.Revision {
			return nil, nil, errors.New("stale goal revision")
		}
		var m goalMirror
		_ = json.Unmarshal(r.Goal, &m)
		if s.Command == "accept" && (m.Status != "awaiting_review" || s.ReviewedRunID == "" || s.ReviewedRunID != m.LastSettledRun) {
			return nil, nil, errors.New("accept requires the reviewed settled Run")
		}
		if len(r.Commands) >= 128 {
			return nil, nil, errors.New("goal command capacity reached")
		}
		r.Commands[s.CommandID] = payload
		if err := h.saveLongTasksLocked(); err != nil {
			delete(r.Commands, s.CommandID)
			return nil, nil, errors.New("goal command persistence failed")
		}
	}
	return n, nil, nil
}
func (h *hubSrv) forwardGoalCommand(ctx context.Context, id string, c *websocket.Conn, s *sig) {
	h.mu.Lock()
	defer h.mu.Unlock()
	cc := h.ctlws[id]
	if cc == nil || cc.ws != c {
		wsSend(ctx, c, &sig{K: "goal-command", CommandID: s.CommandID, Err: "invalid goal command"})
		return
	}
	n, receipt, err := h.prepareGoalCommandLocked(cc.fp, s)
	if err != nil {
		wsSend(ctx, c, &sig{K: "goal-command", CommandID: s.CommandID, Err: err.Error()})
	} else if receipt != nil {
		wsSend(ctx, c, receipt)
	} else {
		wsSend(ctx, n.ws, s) // Only a durable Node receipt confirms the command.
	}
}
func (h *hubSrv) recordGoalCommandResult(ctx context.Context, id string, c *websocket.Conn, s *sig) {
	if len(s.Goal) > 0 {
		h.recordGoalState(ctx, id, c, s)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	n := h.nodes[id]
	if n == nil || n.ws != c || h.deviceEligibleLocked(n.fp, c) != nil {
		return
	}
	r := h.longTasksLocked().Records[longTaskKey(n.fp, s.GoalID)]
	if r == nil || r.Lease.Session != s.SessionKey || r.Commands[s.CommandID] == "" {
		return
	}
	result := &sig{K: "goal-command-result", CommandID: s.CommandID, GoalID: s.GoalID, SessionKey: s.SessionKey, FP: n.fp, Err: s.Err, Goal: append(json.RawMessage(nil), s.Goal...), WriterEpoch: s.WriterEpoch}
	if r.Receipts == nil {
		r.Receipts = map[string]json.RawMessage{}
	}
	if old := r.Receipts[s.CommandID]; len(old) > 0 {
		if json.Unmarshal(old, result) != nil {
			return
		}
	} else {
		raw, err := json.Marshal(result)
		if err != nil {
			return
		}
		r.Receipts[s.CommandID] = raw
		if h.saveLongTasksLocked() != nil {
			delete(r.Receipts, s.CommandID)
			return
		}
	}
	for _, cc := range h.ctlws {
		if cc.fp == r.Lease.Controller {
			wsSend(ctx, cc.ws, result)
		}
	}
}
func (h *hubSrv) sendControllerGoals(ctx context.Context, id string, c *websocket.Conn, s *sig) {
	h.mu.Lock()
	defer h.mu.Unlock()
	cc := h.ctlws[id]
	if cc == nil || cc.ws != c || !validGoalSession(s.SessionKey) {
		return
	}
	for _, r := range h.longTasksLocked().Records {
		if r.Lease.Controller == cc.fp && r.Lease.Device == s.FP && r.Lease.Session == s.SessionKey && len(r.Goal) > 0 {
			wsSend(ctx, c, &sig{K: "goal-state", FP: r.Lease.Device, SessionKey: r.Lease.Session, GoalLease: &r.Lease, Goal: r.Goal, WriterEpoch: r.Epoch})
		}
	}
}
