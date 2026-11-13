package main

// A shared enrollment bearer admits a connection, never a device identity.
// Every connection proves possession before entering nodes/devNode. Nonces are
// local to that read loop; no successful or failed proof can be reused.
import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"nhooyr.io/websocket"
)

const nodeChallengeTTL = 30 * time.Second

type nodeChallenge struct {
	nonce   string
	expires int64
}

func newNodeChallenge(now time.Time) (nodeChallenge, error) {
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nodeChallenge{}, err
	}
	return nodeChallenge{hex.EncodeToString(nonce[:]), now.Add(nodeChallengeTTL).Unix()}, nil
}

func nodeIdentityMessage(nonce string, expires int64, fp, publicKey string) []byte {
	return []byte(fmt.Sprintf("handwave-node-identity-v1\n%s\n%d\n%s\n%s", nonce, expires, fp, publicKey))
}

// Existing Go nodes use the same seed format and proof as the standalone Rust
// host. There is deliberately no unsigned fallback for older Hubs.
func signedNodeJoin(challenge *sig, identity *identity, info *Hello) (*sig, error) {
	if identity == nil || len(identity.priv) != ed25519.PrivateKeySize || challenge.K != "node-challenge" || len(challenge.NodeNonce) != 64 {
		return nil, errors.New("device identity challenge or private key required")
	}
	nonce, err := hex.DecodeString(challenge.NodeNonce)
	if err != nil || len(nonce) != 32 || hex.EncodeToString(nonce) != challenge.NodeNonce {
		return nil, errors.New("invalid device identity challenge nonce")
	}
	now := time.Now().Unix()
	if challenge.NodeExpiresAt <= now || challenge.NodeExpiresAt > now+60 {
		return nil, errors.New("device identity challenge expired or outside allowed lifetime")
	}
	publicKey := base64.StdEncoding.EncodeToString(identity.priv.Public().(ed25519.PublicKey))
	if _, err := parseNodePublicKey(publicKey, identity.FP); err != nil {
		return nil, err
	}
	return &sig{K: "join", FP: identity.FP, Info: info, NodeNonce: challenge.NodeNonce, NodeExpiresAt: challenge.NodeExpiresAt, NodePublicKey: publicKey, NodeSignature: base64.StdEncoding.EncodeToString(ed25519.Sign(identity.priv, nodeIdentityMessage(challenge.NodeNonce, challenge.NodeExpiresAt, identity.FP, publicKey)))}, nil
}

func parseNodePublicKey(value, fp string) (ed25519.PublicKey, error) {
	key, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil || len(key) != ed25519.PublicKeySize || base64.StdEncoding.EncodeToString(key) != value || fpOf(key) != fp {
		return nil, errors.New("invalid device public key or fingerprint")
	}
	return ed25519.PublicKey(key), nil
}

func verifyNodeProof(proof *sig, challenge nodeChallenge, now time.Time) (string, error) {
	if proof.K != "join" || proof.NodeNonce != challenge.nonce || proof.NodeExpiresAt != challenge.expires || challenge.expires <= now.Unix() || challenge.expires > now.Add(nodeChallengeTTL).Unix() {
		return "", errors.New("device identity challenge mismatch or expired")
	}
	key, err := parseNodePublicKey(proof.NodePublicKey, proof.FP)
	if err != nil {
		return "", err
	}
	signature, err := base64.StdEncoding.Strict().DecodeString(proof.NodeSignature)
	if err != nil || len(signature) != ed25519.SignatureSize || !ed25519.Verify(key, nodeIdentityMessage(challenge.nonce, challenge.expires, proof.FP, proof.NodePublicKey), signature) {
		return "", errors.New("invalid device identity signature")
	}
	return proof.NodePublicKey, nil
}

func (h *hubSrv) authenticateNode(ctx context.Context, id string, c *websocket.Conn) error {
	challenge, err := newNodeChallenge(time.Now())
	if err != nil {
		return err
	}
	return h.authenticateNodeChallenge(ctx, id, c, challenge)
}

func (h *hubSrv) authenticateNodeChallenge(ctx context.Context, id string, c *websocket.Conn, challenge nodeChallenge) error {
	deadline, cancel := context.WithDeadline(ctx, time.Unix(challenge.expires, 0))
	defer cancel()
	wsSend(deadline, c, &sig{K: "node-challenge", NodeNonce: challenge.nonce, NodeExpiresAt: challenge.expires})
	_, raw, err := c.Read(deadline)
	if err != nil {
		return errors.New("device identity proof not received before deadline")
	}
	var proof sig
	if json.Unmarshal(raw, &proof) != nil {
		return errors.New("invalid device identity proof")
	}
	publicKey, err := verifyNodeProof(&proof, challenge, time.Now())
	if err != nil {
		return err
	}
	n := &nodeConn{ws: c, fp: proof.FP, publicKey: publicKey, info: proof.Info, seen: time.Now()}
	if n.info == nil {
		n.info = &Hello{}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	// A pre-migration approval has no key. It must remain pending until the
	// owner explicitly approves this proven key; never silently TOFU-upgrade it.
	if ap := h.approvals[n.fp]; ap != nil && ap.NodePublicKey != "" && ap.NodePublicKey != publicKey {
		return errors.New("device key differs from approved identity")
	}
	if old := h.devNode[n.fp]; old != "" && old != id {
		previous := h.nodes[old]
		if previous != nil && previous.publicKey != "" && previous.publicKey != publicKey {
			return errors.New("device key differs from current identity")
		}
		h.dropLocked(old)
		if previous != nil {
			_ = previous.ws.CloseNow()
		}
	}
	h.nodes[id], h.devNode[n.fp] = n, id
	wsSend(ctx, c, &sig{K: "node-joined", FP: n.fp})
	h.tryAutoPairLocked(ctx, n.fp, false)
	h.broadcastStatusLocked()
	return nil
}

// Caller holds h.mu. Proof was checked before constructing a live nodeConn.
func (h *hubSrv) nodeApprovalMatchesLocked(n *nodeConn) bool {
	if n == nil || n.publicKey == "" {
		return false
	}
	ap := h.approvals[n.fp]
	return ap.live() && ap.NodePublicKey != "" && ap.NodePublicKey == n.publicKey
}

// pinApprovalLocked persists the complete key before exposing approval in a
// pairing. Offline reapproval can only retain an existing complete key pin.
func (h *hubSrv) pinApprovalLocked(fp, controller string, expiry time.Time) error {
	if controller == "" {
		return errors.New("controller identity required")
	}
	previous := h.approvals[fp]
	publicKey := ""
	if previous != nil {
		publicKey = previous.NodePublicKey
	}
	if n := h.nodes[h.devNode[fp]]; n != nil {
		publicKey = n.publicKey
	}
	if _, err := parseNodePublicKey(publicKey, fp); err != nil {
		return errors.New("verified device key required; reconnect and approve again")
	}
	h.approvals[fp] = &approval{CtlFP: controller, Exp: expiry, NodePublicKey: publicKey}
	if err := h.saveApprovalsLocked(); err != nil {
		if previous == nil {
			delete(h.approvals, fp)
		} else {
			h.approvals[fp] = previous
		}
		return errors.New("device approval could not be saved")
	}
	return nil
}
