package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func testHubWithNode(fp string, approved bool) *hubSrv {
	h := &hubSrv{
		nodes:     map[string]*nodeConn{"n1": {fp: fp, publicKey: identityFixturePublicKey(), seen: time.Now()}},
		devNode:   map[string]string{fp: "n1"},
		approvals: map[string]*approval{},
		denied:    map[string]bool{},
	}
	if approved {
		h.approvals[fp] = &approval{CtlFP: "ctl", NodePublicKey: identityFixturePublicKey()}
	}
	return h
}

func TestMintModelGrantRequiresApproval(t *testing.T) {
	h := testHubWithNode("FP1", false)
	if _, _, err := h.mintModelGrant("FP1", "run"); err == nil {
		t.Fatal("expected not approved")
	}
	h = testHubWithNode("FP1", true)
	code, exp, err := h.mintModelGrant("FP1", "run")
	if err != nil {
		t.Fatal(err)
	}
	if !exp.After(time.Now()) || !grantMatches(code, code) {
		t.Fatalf("code/exp invalid: %s %v", code, exp)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer "+code)
	if !h.modelGrantOK(req) {
		t.Fatal("grant should authorize /v1")
	}
	req.Header.Set("Authorization", "Bearer not-the-code")
	if h.modelGrantOK(req) {
		t.Fatal("wrong code accepted")
	}
}

func TestMintModelGrantRejectsDenied(t *testing.T) {
	h := testHubWithNode("FP1", true)
	h.denied["FP1"] = true
	if _, _, err := h.mintModelGrant("FP1", "run"); err == nil {
		t.Fatal("expected denied")
	}
}
