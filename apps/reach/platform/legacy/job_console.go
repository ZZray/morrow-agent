package main

// Console input is transient. Never place it in the durable Goal command ledger,
// replay it after reconnect, or echo it in a result/error.
import (
	"context"
	"encoding/json"
	"errors"

	"nhooyr.io/websocket"
)

func validJobAction(s *sig) bool {
	if !validGoalID(s.CommandID) || !validGoalID(s.GoalID) || !validGoalSession(s.SessionKey) {
		return false
	}
	if s.JobAction != "list" && !validGoalID(s.JobID) {
		return false
	}
	if s.JobAction != "signal" && s.JobSignal != "" || s.JobAction != "resize" && (s.JobRows != 0 || s.JobCols != 0) {
		return false
	}
	switch s.JobAction {
	case "list", "status", "cancel":
		return s.JobText == "" && !s.JobEOF
	case "log":
		return s.JobText == "" && !s.JobEOF && (s.JobStream == "stdout" || s.JobStream == "stderr") && s.JobLimit <= 32768
	case "input":
		return validGoalID(s.JobInputID) && len(s.JobText) <= 8192 && (s.JobText != "" || s.JobEOF)
	case "input_status":
		return validGoalID(s.JobInputID) && s.JobText == "" && !s.JobEOF
	case "signal":
		return validGoalID(s.JobInputID) && s.JobText == "" && !s.JobEOF && (s.JobSignal == "interrupt" || s.JobSignal == "eof")
	case "resize":
		return validGoalID(s.JobInputID) && s.JobText == "" && !s.JobEOF && s.JobRows >= 10 && s.JobRows <= 300 && s.JobCols >= 20 && s.JobCols <= 500
	}
	return false
}

// Caller holds h.mu. Identity comes exclusively from this live controller socket.
func (h *hubSrv) prepareJobCommandLocked(id string, c *websocket.Conn, s *sig) (*nodeConn, *sig, error) {
	cc := h.ctlws[id]
	nid := h.peers[id]
	n := h.nodes[nid]
	if !validJobAction(s) || cc == nil || cc.ws != c || cc.fp == "" || n == nil || h.peers[nid] != id || h.devNode[n.fp] != nid || s.FP != n.fp || h.deviceEligibleLocked(n.fp, n.ws) != nil || h.approvals[n.fp].CtlFP != cc.fp {
		return nil, nil, errors.New("console requires the current approved paired controller")
	}
	b := h.longTasksLocked()
	r := b.Records[longTaskKey(n.fp, s.GoalID)]
	if b.loadErr != nil || r == nil || r.Revoked || r.Lease.Controller != cc.fp || r.Lease.Session != s.SessionKey {
		return nil, nil, errors.New("console goal owner/session mismatch")
	}
	if s.JobAction == "input" || s.JobAction == "signal" || s.JobAction == "resize" {
		var m goalMirror
		if !r.Lease.AllowJobs || !h.goalLiveLocked(r) || json.Unmarshal(r.Goal, &m) != nil || (m.Status != "running" && m.Status != "yielded" && m.Status != "waiting_job") {
			return nil, nil, errors.New("console input requires an active unexpired job authorization")
		}
	}
	// Explicit allowlist: controller-supplied ownership/response/payload fields
	// cannot smuggle a lease or output into Node.
	out := &sig{K: "job-command", CommandID: s.CommandID, GoalID: r.Lease.GoalID, SessionKey: r.Lease.Session, FP: n.fp, CtlFP: cc.fp, JobAction: s.JobAction, JobID: s.JobID, JobInputID: s.JobInputID, JobText: s.JobText, JobEOF: s.JobEOF, JobSignal: s.JobSignal, JobRows: s.JobRows, JobCols: s.JobCols, JobStream: s.JobStream, JobCursor: s.JobCursor, JobLimit: s.JobLimit}
	return n, out, nil
}

func (h *hubSrv) forwardJobCommand(ctx context.Context, id string, c *websocket.Conn, s *sig) {
	h.mu.Lock()
	defer h.mu.Unlock()
	n, out, err := h.prepareJobCommandLocked(id, c, s)
	if err != nil {
		wsSend(ctx, c, &sig{K: "job-command-result", CommandID: s.CommandID, GoalID: s.GoalID, SessionKey: s.SessionKey, FP: s.FP, JobAction: s.JobAction, JobID: s.JobID, JobInputID: s.JobInputID, Err: err.Error()})
		return
	}
	wsSend(ctx, n.ws, out)
}

func (h *hubSrv) jobResultTargetLocked(id string, c *websocket.Conn, s *sig) (*websocket.Conn, *sig) {
	n := h.nodes[id]
	cc := h.ctlws[h.peers[id]]
	if n == nil || n.ws != c || h.devNode[n.fp] != id || h.deviceEligibleLocked(n.fp, c) != nil || cc == nil || h.peers[h.peers[id]] != id || cc.fp != s.CtlFP || h.approvals[n.fp].CtlFP != cc.fp || s.FP != n.fp || !validGoalID(s.CommandID) || len(s.JobData) > 128<<10 {
		return nil, nil
	}
	b := h.longTasksLocked()
	r := b.Records[longTaskKey(n.fp, s.GoalID)]
	if b.loadErr != nil || r == nil || r.Revoked || r.Lease.Controller != cc.fp || r.Lease.Session != s.SessionKey {
		return nil, nil
	}
	return cc.ws, &sig{K: "job-command-result", CommandID: s.CommandID, GoalID: s.GoalID, SessionKey: s.SessionKey, FP: n.fp, CtlFP: cc.fp, JobAction: s.JobAction, JobID: s.JobID, JobInputID: s.JobInputID, JobOK: s.JobOK, JobData: s.JobData, Err: s.Err}
}

func (h *hubSrv) forwardJobResult(ctx context.Context, id string, c *websocket.Conn, s *sig) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if target, out := h.jobResultTargetLocked(id, c, s); target != nil {
		wsSend(ctx, target, out)
	}
}
