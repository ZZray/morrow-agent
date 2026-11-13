package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

func approvedConnectFixture() (*hubSrv, *websocket.Conn) {
	c, n := &websocket.Conn{}, &websocket.Conn{}
	h := &hubSrv{ctlws: map[string]*ctlConn{"c1": {ws: c, fp: "controller"}}, nodes: map[string]*nodeConn{"n1": {ws: n, fp: "device", publicKey: identityFixturePublicKey(), info: &Hello{Hostname: "fixture"}}}, devNode: map[string]string{"device": "n1"}, approvals: map[string]*approval{"device": {CtlFP: "controller", NodePublicKey: identityFixturePublicKey(), Exp: time.Now().Add(time.Hour)}}, denied: map[string]bool{}, peers: map[string]string{}, aliases: map[string]string{}}
	return h, c
}

func TestConnectApprovedDecisionDoesNotChangeGrants(t *testing.T) {
	for _, tc := range []struct {
		name, want string
		mutate     func(*hubSrv)
	}{
		{"allowed", "connected", func(*hubSrv) {}},
		{"expired", "approval-expired", func(h *hubSrv) { h.approvals["device"].Exp = time.Now().Add(-time.Second) }},
		{"no grant", "approval-expired", func(h *hubSrv) { delete(h.approvals, "device") }},
		{"other owner", "approval-owner", func(h *hubSrv) { h.approvals["device"].CtlFP = "someone-else" }},
		{"denied", "device-denied", func(h *hubSrv) { h.denied["device"] = true }},
		{"offline", "device-offline", func(h *hubSrv) { delete(h.nodes, "n1") }},
		{"stale node", "device-offline", func(h *hubSrv) { h.devNode["device"] = "replacement" }},
		{"target busy", "device-busy", func(h *hubSrv) { h.peers["n1"] = "c2" }},
		{"controller busy", "controller-busy", func(h *hubSrv) { h.peers["c1"] = "n2" }},
		{"already paired", "already-connected", func(h *hubSrv) { h.peers["c1"] = "n1"; h.peers["n1"] = "c1" }},
		{"one-sided pair", "device-busy", func(h *hubSrv) { h.peers["n1"] = "c1" }},
		{"no hello", "controller-unavailable", func(h *hubSrv) { h.ctlws["c1"].fp = " " }},
		{"controller offline", "controller-unavailable", func(h *hubSrv) { delete(h.ctlws, "c1") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, c := approvedConnectFixture()
			tc.mutate(h)
			before, _ := json.Marshal(h.approvals)
			peers, _ := json.Marshal(h.peers)
			state, _ := h.connectApprovedDecisionLocked("c1", c, &sig{NID: "n1", FP: "device", TTL: 0})
			if state != tc.want {
				t.Fatal(state, tc.want)
			}
			after, _ := json.Marshal(h.approvals)
			afterPeers, _ := json.Marshal(h.peers)
			if string(before) != string(after) || string(peers) != string(afterPeers) {
				t.Fatal("decision mutated grant/pair")
			}
		})
	}
	h, c := approvedConnectFixture()
	if state, _ := h.connectApprovedDecisionLocked("c1", c, &sig{NID: "n1", FP: "different"}); state != "device-changed" {
		t.Fatal(state)
	}
	if state, _ := h.connectApprovedDecisionLocked("c1", &websocket.Conn{}, &sig{NID: "n1"}); state != "controller-unavailable" {
		t.Fatal(state)
	}
}

func TestConnectApprovedRealWebSocketPairAndIdempotence(t *testing.T) {
	dir := skillTestConf(t)
	expiry := time.Now().UTC().Add(time.Hour)
	h := &hubSrv{ctlws: map[string]*ctlConn{}, nodes: map[string]*nodeConn{}, devNode: map[string]string{}, approvals: map[string]*approval{"device": {CtlFP: "controller", NodePublicKey: identityFixturePublicKey(), Exp: expiry}}, denied: map[string]bool{}, peers: map[string]string{}, aliases: map[string]string{}}
	// A sentinel also detects accidental saveApprovalsLocked calls.
	path := filepath.Join(dir, "approvals.json")
	if err := os.WriteFile(path, []byte("do-not-rewrite"), 0600); err != nil {
		t.Fatal(err)
	}
	nodeReady, ctlReady := make(chan struct{}), make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		h.mu.Lock()
		if r.URL.Path == "/node" {
			h.nodes["n1"] = &nodeConn{ws: c, fp: "device", publicKey: identityFixturePublicKey(), info: &Hello{Hostname: "test"}}
			h.devNode["device"] = "n1"
			close(nodeReady)
		} else {
			h.ctlws["c1"] = &ctlConn{ws: c, fp: "controller"}
			close(ctlReady)
		}
		h.mu.Unlock()
		for {
			_, raw, err := c.Read(r.Context())
			if err != nil {
				return
			}
			var s sig
			if json.Unmarshal(raw, &s) != nil {
				continue
			}
			if r.URL.Path == "/ctl" && s.K == "connect-approved" {
				h.handleConnectApproved(r.Context(), "c1", c, &s)
			}
		}
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	node, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/node", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer node.CloseNow()
	<-nodeReady
	ctl, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ctl", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ctl.CloseNow()
	<-ctlReady
	nodeFrames := make(chan sig, 4)
	go func() {
		for {
			_, raw, err := node.Read(ctx)
			if err != nil {
				return
			}
			var s sig
			if json.Unmarshal(raw, &s) == nil {
				select {
				case nodeFrames <- s:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	request := func(id string) sig {
		t.Helper()
		b, _ := json.Marshal(sig{K: "connect-approved", ID: id, NID: "n1", FP: "device", TTL: 0, Relay: true})
		if err := ctl.Write(ctx, websocket.MessageText, b); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 8; i++ {
			_, raw, err := ctl.Read(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var s sig
			if json.Unmarshal(raw, &s) != nil {
				t.Fatal("invalid receipt")
			}
			if s.K == "connect-approved-result" {
				if s.ID != id {
					t.Fatal(s)
				}
				return s
			}
		}
		t.Fatal("missing receipt")
		return sig{}
	}
	result := request("first")
	if result.Msg != "connected" || result.Err != "" {
		t.Fatal(result)
	}
	select {
	case frame := <-nodeFrames:
		if frame.K != "pair-req" || frame.CtlFP != "controller" || !frame.Relay {
			t.Fatal(frame)
		}
	case <-ctx.Done():
		t.Fatal("node did not receive pair request")
	}
	result = request("repeat")
	if result.Msg != "already-connected" || result.Err != "" {
		t.Fatal(result)
	}
	select {
	case frame := <-nodeFrames:
		t.Fatal("duplicate pair interrupted existing connection", frame)
	case <-time.After(100 * time.Millisecond):
	}
	h.mu.Lock()
	grant := *h.approvals["device"]
	pairs := map[string]string{}
	for k, v := range h.peers {
		pairs[k] = v
	}
	h.mu.Unlock()
	if !grant.Exp.Equal(expiry) || grant.CtlFP != "controller" || !reflect.DeepEqual(pairs, map[string]string{"c1": "n1", "n1": "c1"}) {
		t.Fatal(grant, pairs)
	}
	b, err := os.ReadFile(path)
	if err != nil || string(b) != "do-not-rewrite" {
		t.Fatal("grant persisted/changed", string(b), err)
	}
}

func TestStatusSignalCapabilityDoesNotChangeDeviceData(t *testing.T) {
	data := []byte(`[{"fp":"device","state":"approved"}]`)
	var result struct {
		K, D    string
		HubCaps []string `json:"hub_caps"`
	}
	if json.Unmarshal(statusSignal(data), &result) != nil || result.K != "status" || result.D != string(data) || !reflect.DeepEqual(result.HubCaps, []string{"connect-approved-v1", "schedule-resume-v1"}) {
		t.Fatal(result)
	}
}
