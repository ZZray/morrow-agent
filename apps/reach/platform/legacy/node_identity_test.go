package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
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

func identityFixtureKey() ed25519.PrivateKey {
	return ed25519.NewKeyFromSeed([]byte("01234567890123456789012345678901"))
}
func identityFixturePublicKey() string {
	return base64.StdEncoding.EncodeToString(identityFixtureKey().Public().(ed25519.PublicKey))
}
func signedNodeFixture(challenge sig, key ed25519.PrivateKey) sig {
	publicKey := base64.StdEncoding.EncodeToString(key.Public().(ed25519.PublicKey))
	fp := fpOf(key.Public().(ed25519.PublicKey))
	return sig{K: "join", FP: fp, Info: &Hello{Hostname: "identity-fixture"}, NodeNonce: challenge.NodeNonce, NodeExpiresAt: challenge.NodeExpiresAt, NodePublicKey: publicKey, NodeSignature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, nodeIdentityMessage(challenge.NodeNonce, challenge.NodeExpiresAt, fp, publicKey)))}
}

func newIdentityFixtureHub(t *testing.T) (*hubSrv, *httptest.Server) {
	t.Helper()
	t.Setenv("HW_CONF", t.TempDir())
	h := &hubSrv{token: "fixture-root", nodeTok: "fixture-node", nodes: map[string]*nodeConn{}, devNode: map[string]string{}, approvals: map[string]*approval{}, ctlws: map[string]*ctlConn{}, peers: map[string]string{}, denied: map[string]bool{}, aliases: map[string]string{}}
	srv := httptest.NewServer(http.HandlerFunc(h.wrapWS(h.wsH)))
	t.Cleanup(srv.Close)
	return h, srv
}

func identityFixtureSocket(t *testing.T, server *httptest.Server) (*websocket.Conn, sig) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	client, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/ws?role=node", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer fixture-node"}}, Subprotocols: []string{"handwave"}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.CloseNow() })
	var challenge sig
	if err := wsjson.Read(ctx, client, &challenge); err != nil || challenge.K != "node-challenge" {
		t.Fatalf("challenge: %v %+v", err, challenge)
	}
	return client, challenge
}

func identityFixtureSend(t *testing.T, client *websocket.Conn, proof sig, success bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, client, proof); err != nil {
		t.Fatal(err)
	}
	var ack sig
	err := wsjson.Read(ctx, client, &ack)
	if success && (err != nil || ack.K != "node-joined" || ack.FP != proof.FP) {
		t.Fatalf("signed join rejected: %v %+v", err, ack)
	}
	if !success && err == nil {
		t.Fatalf("unsafe join admitted: %+v", ack)
	}
}

func TestNodeIdentitySignedJoinReconnectAndPersistentPin(t *testing.T) {
	h, server := newIdentityFixtureHub(t)
	key := identityFixtureKey()
	fp := fpOf(key.Public().(ed25519.PublicKey))
	client, challenge := identityFixtureSocket(t, server)
	identityFixtureSend(t, client, signedNodeFixture(challenge, key), true)
	h.mu.Lock()
	first := h.devNode[fp]
	if first == "" || h.nodeApprovalMatchesLocked(h.nodes[first]) {
		t.Fatal("unapproved signed node was authorized")
	}
	if err := h.pinApprovalLocked(fp, "controller", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if !h.nodeApprovalMatchesLocked(h.nodes[first]) {
		t.Fatal("pinned node unauthorized")
	}
	h.mu.Unlock()
	second, newChallenge := identityFixtureSocket(t, server)
	if challenge.NodeNonce == newChallenge.NodeNonce {
		t.Fatal("challenge reused")
	}
	identityFixtureSend(t, second, signedNodeFixture(newChallenge, key), true)
	h.mu.Lock()
	if h.devNode[fp] == first || h.nodes[first] != nil || !h.nodeApprovalMatchesLocked(h.nodes[h.devNode[fp]]) {
		t.Fatal("signed reconnect did not replace old socket with pinned identity")
	}
	h.mu.Unlock()
	restarted := &hubSrv{approvals: map[string]*approval{}, denied: map[string]bool{}, aliases: map[string]string{}}
	restarted.loadApprovals()
	if restarted.approvals[fp] == nil || restarted.approvals[fp].NodePublicKey != identityFixturePublicKey() {
		t.Fatal("full public key pin did not survive restart")
	}
}

func TestNodeIdentityInvalidProofCannotReplaceApprovedSocket(t *testing.T) {
	h, server := newIdentityFixtureHub(t)
	key := identityFixtureKey()
	fp := fpOf(key.Public().(ed25519.PublicKey))
	client, challenge := identityFixtureSocket(t, server)
	identityFixtureSend(t, client, signedNodeFixture(challenge, key), true)
	h.mu.Lock()
	original := h.devNode[fp]
	if err := h.pinApprovalLocked(fp, "controller", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	h.mu.Unlock()
	for _, mode := range []string{"unsigned", "signature", "fingerprint", "expiry", "cross_socket", "replay"} {
		t.Run(mode, func(t *testing.T) {
			attacker, next := identityFixtureSocket(t, server)
			proof := signedNodeFixture(next, key)
			switch mode {
			case "unsigned":
				proof.NodeSignature = ""
				proof.NodePublicKey = ""
			case "signature":
				proof.NodeSignature = base64.StdEncoding.EncodeToString(make([]byte, 64))
			case "fingerprint":
				proof.FP = "VICTIM"
			case "expiry":
				proof.NodeExpiresAt = time.Now().Add(-time.Minute).Unix()
			case "cross_socket":
				_, other := identityFixtureSocket(t, server)
				proof = signedNodeFixture(other, key)
			case "replay":
				proof = signedNodeFixture(challenge, key)
			}
			identityFixtureSend(t, attacker, proof, false)
			h.mu.Lock()
			defer h.mu.Unlock()
			if h.devNode[fp] != original || !h.nodeApprovalMatchesLocked(h.nodes[original]) {
				t.Fatal("invalid proof displaced approved device")
			}
		})
	}
}

func TestNodeIdentityLegacyApprovalRequiresExplicitReapproval(t *testing.T) {
	h, server := newIdentityFixtureHub(t)
	key := identityFixtureKey()
	fp := fpOf(key.Public().(ed25519.PublicKey))
	h.mu.Lock()
	h.approvals[fp] = &approval{CtlFP: "controller", Exp: time.Now().Add(time.Hour)}
	h.mu.Unlock()
	client, challenge := identityFixtureSocket(t, server)
	identityFixtureSend(t, client, signedNodeFixture(challenge, key), true)
	h.mu.Lock()
	defer h.mu.Unlock()
	n := h.nodes[h.devNode[fp]]
	if h.nodeApprovalMatchesLocked(n) || h.tryAutoPairLocked(context.Background(), fp, false) || h.deviceEligibleLocked(fp, n.ws) == nil {
		t.Fatal("legacy approval silently pinned a key")
	}
	if h.approvals[fp].NodePublicKey != "" {
		t.Fatal("legacy approval mutated during signed join")
	}
	if err := h.pinApprovalLocked(fp, "controller", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if !h.nodeApprovalMatchesLocked(n) {
		t.Fatal("explicit reapproval did not pin proven key")
	}
}

func TestNodeIdentityExpiredNonceDomainAndKeyMismatch(t *testing.T) {
	key := identityFixtureKey()
	challenge, err := newNodeChallenge(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	proof := signedNodeFixture(sig{NodeNonce: challenge.nonce, NodeExpiresAt: challenge.expires}, key)
	if _, err := verifyNodeProof(&proof, challenge, time.Unix(challenge.expires, 0)); err == nil {
		t.Fatal("expired nonce admitted")
	}
	wrong := proof
	wrongMessage := append([]byte("another-domain\n"), nodeIdentityMessage(challenge.nonce, challenge.expires, proof.FP, proof.NodePublicKey)...)
	wrong.NodeSignature = base64.StdEncoding.EncodeToString(ed25519.Sign(key, wrongMessage))
	if _, err := verifyNodeProof(&wrong, challenge, time.Now()); err == nil {
		t.Fatal("wrong signature domain admitted")
	}
	// Simulate a stored full-key mismatch: the 8-byte display FP is never the pin.
	h, server := newIdentityFixtureHub(t)
	other := ed25519.NewKeyFromSeed(make([]byte, 32))
	h.approvals[proof.FP] = &approval{CtlFP: "controller", NodePublicKey: base64.StdEncoding.EncodeToString(other.Public().(ed25519.PublicKey))}
	client, next := identityFixtureSocket(t, server)
	identityFixtureSend(t, client, signedNodeFixture(next, key), false)
}

func TestNodeIdentityPinWriteFailureAndConcurrentReconnect(t *testing.T) {
	h, server := newIdentityFixtureHub(t)
	key := identityFixtureKey()
	fp := fpOf(key.Public().(ed25519.PublicKey))
	client, challenge := identityFixtureSocket(t, server)
	identityFixtureSend(t, client, signedNodeFixture(challenge, key), true)
	path := filepath.Join(confDir(), "approvals.json")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	h.mu.Lock()
	err := h.pinApprovalLocked(fp, "controller", time.Now().Add(time.Hour))
	_, exists := h.approvals[fp]
	h.mu.Unlock()
	if err == nil || exists {
		t.Fatal("undurable key pin published")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	h.mu.Lock()
	err = h.pinApprovalLocked(fp, "controller", time.Now().Add(time.Hour))
	h.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, ch := identityFixtureSocket(t, server)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := wsjson.Write(ctx, c, signedNodeFixture(ch, key)); err != nil {
				t.Error(err)
			}
			var ack sig
			_ = wsjson.Read(ctx, c, &ack)
		}()
	}
	wg.Wait()
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.nodes) != 1 || len(h.devNode) != 1 || !h.nodeApprovalMatchesLocked(h.nodes[h.devNode[fp]]) {
		raw, _ := json.Marshal(h.devNode)
		t.Fatalf("concurrent joins lost identity consistency: %s nodes=%d", raw, len(h.nodes))
	}
}
