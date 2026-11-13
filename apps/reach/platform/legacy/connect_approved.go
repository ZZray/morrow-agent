package main

import (
	"context"
	"encoding/json"
	"strings"

	"nhooyr.io/websocket"
)

// connectApprovedDecisionLocked inspects only existing grants and connections.
// The caller holds h.mu. A selected machine never creates/extends approval.
func (h *hubSrv) connectApprovedDecisionLocked(id string, c *websocket.Conn, s *sig) (string, string) {
	cc := h.ctlws[id]
	if cc == nil || cc.ws == nil || cc.ws != c || strings.TrimSpace(cc.fp) == "" {
		return "controller-unavailable", "操作端未完成连接，请刷新后重试"
	}
	n := h.nodes[s.NID]
	if n == nil || n.ws == nil || strings.TrimSpace(n.fp) == "" || h.devNode[n.fp] != s.NID {
		return "device-offline", "设备已离线，请刷新列表"
	}
	if s.FP != "" && s.FP != n.fp {
		return "device-changed", "设备连接已变化，请刷新列表"
	}
	if h.denied[n.fp] {
		return "device-denied", "该设备已被屏蔽"
	}
	ap := h.approvals[n.fp]
	if !ap.live() {
		return "approval-expired", "设备未授权或授权已过期，请在设备管理中明确授权"
	}
	if !h.nodeApprovalMatchesLocked(n) {
		return "approval-required", "设备身份需要重新批准，请在设备管理中明确授权"
	}
	if ap.CtlFP != cc.fp {
		return "approval-owner", "该设备的授权不属于当前操作端"
	}
	nodePeer, nodeBound := h.peers[s.NID]
	ctlPeer, ctlBound := h.peers[id]
	if nodeBound && ctlBound && nodePeer == id && ctlPeer == s.NID {
		return "already-connected", ""
	}
	if nodeBound {
		return "device-busy", "设备已有连接，请勿中断现有任务"
	}
	if ctlBound {
		return "controller-busy", "当前已连接另一台电脑，请先断开后再选择"
	}
	return "connected", ""
}

func (h *hubSrv) handleConnectApproved(ctx context.Context, id string, c *websocket.Conn, s *sig) {
	h.mu.Lock()
	state, message := h.connectApprovedDecisionLocked(id, c, s)
	fp := ""
	if n := h.nodes[s.NID]; n != nil {
		fp = n.fp
	}
	if state == "connected" {
		h.autoPairLocked(ctx, s.NID, id, s.Relay)
		h.broadcastStatusLocked()
	}
	h.mu.Unlock()
	// This distinct receipt must not reset an existing pair on a refused switch.
	wsSend(ctx, c, &sig{K: "connect-approved-result", ID: s.ID, NID: s.NID, FP: fp, Msg: state, Err: message})
}

// Status capabilities describe this Hub's protocol, never a device permission.
func statusSignal(data []byte) []byte {
	b, _ := json.Marshal(struct {
		K       string   `json:"k"`
		D       string   `json:"d"`
		HubCaps []string `json:"hub_caps"`
	}{"status", string(data), []string{"connect-approved-v1", "schedule-resume-v1"}})
	return b
}
