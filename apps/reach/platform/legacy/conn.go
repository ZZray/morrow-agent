package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v3"
	"nhooyr.io/websocket"
)

// ---- 共享连接层：hub 信令 + WebRTC DataChannel + relay 兜底 ----
//
// 方向约定：node 永远是 offerer / DC 创建方；ctl 是 answerer。
// DC 未打通（或 ctl 指定 --relay / pair-req 携带 relay）时，dc 帧自动经 hub ws 透传；
// P2P 就绪后同一 sendMsg 走 DataChannel。hub 只见 base64 帧，不解内容。
// 配对信令（joined/recode/pair-req/pair-fail/paired/unpaired/status）统一转成
// 事件给上层（node/ctl），sdp/cand 在本层直接驱动 WebRTC。

const (
	wsMsgMax  = 4 << 20 // 信令帧上限（含 relay dc 帧）
	writeWait = 15 * time.Second
)

type ev struct {
	Msg  []byte // DC 帧原文；或 code/pair-req/unpaired/status 的载荷字符串
	Ctrl string // ""(=dc 帧) | code | pair-req | pair-fail | paired | p2p-up | unpaired | ws-close | status | op-ok | op-fail | model-grant
	ID   string
	Err  string
	TTL  int64
	// model-grant-end：结束通知的稳定 Run（只用于清理该回合的授权）。
	Run string
	// model-grant：随访问码一起下发的 Hub 默认模型/协议（非敏感元数据）。
	DefaultModel    string
	DefaultProtocol string
	// model-grant：智能路径的可信绑定（非敏感元数据）。字段必须在这里**显式**复制：
	// conn.go 的 sig→ev 转换是手工的，不是自动透传，漏一个字段整条链就断。
	BindingID        string
	BoundModel       string
	BoundProtocol    string
	BoundDecision    string
	BoundDecisionExp string
	BoundMaxOutput   int
	BoundTools       bool
	GoalLease        *goalLease
}

type conn struct {
	hub          string // wss://host/ws?role=node
	token        string
	rel          bool      // true：只用 hub 中继
	offerer      bool      // node=true：配对成功后由本端发 offer
	nodeIdentity *identity // immutable; set before dialing, never a public FP alone

	ws  *websocket.Conn
	pc  *webrtc.PeerConnection
	dc  *webrtc.DataChannel
	mu  sync.Mutex
	wmu sync.Mutex // websocket 不允许并发写

	remoteSet bool
	pending   []webrtc.ICECandidateInit

	rcancel context.CancelFunc
	ev      chan ev
}

func newConn(hubURL, token string, offerer bool) *conn {
	return &conn{hub: hubURL, token: token, offerer: offerer, ev: make(chan ev, 256)}
}

// ---- 信令 I/O ----

func (cn *conn) dial(ctx context.Context) error {
	if err := validateControllerTransport(cn.hub); err != nil {
		return err
	}
	dialCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(dialCtx, cn.hub, &websocket.DialOptions{
		HTTPClient:   websocketHTTPClient(http.DefaultClient),
		HTTPHeader:   map[string][]string{"authorization": {"Bearer " + cn.token}},
		Subprotocols: []string{"handwave"},
	})
	if err != nil {
		return err
	}
	c.SetReadLimit(wsMsgMax)
	_, rcancel := context.WithCancel(context.Background())
	cn.mu.Lock()
	cn.ws = c
	cn.rcancel = rcancel
	cn.mu.Unlock()
	go cn.recvLoop(ctx)
	return nil
}

func (cn *conn) sendSig(s *sig) error {
	b, _ := json.Marshal(s)
	cn.wmu.Lock()
	defer cn.wmu.Unlock()
	cn.mu.Lock()
	w := cn.ws
	cn.mu.Unlock()
	if w == nil {
		return fmt.Errorf("未连接")
	}
	ctx, cancel := context.WithTimeout(context.Background(), writeWait)
	defer cancel()
	return w.Write(ctx, websocket.MessageText, b)
}

// recvLoop：hub 帧路由。信令转事件；sdp 直接推进 WebRTC
func (cn *conn) recvLoop(ctx context.Context) {
	for {
		cn.mu.Lock()
		w := cn.ws
		cn.mu.Unlock()
		if w == nil {
			return
		}
		_, raw, err := w.Read(ctx)
		if err != nil {
			cn.mu.Lock()
			alive := cn.ws != nil
			cn.mu.Unlock()
			if alive {
				cn.pushEv(ev{Ctrl: "ws-close"})
			}
			return
		}
		var s sig
		if json.Unmarshal(raw, &s) != nil {
			continue
		}
		switch s.K {
		case "node-challenge":
			if !cn.offerer {
				continue
			}
			proof, err := signedNodeJoin(&s, cn.nodeIdentity, selfHello())
			if err != nil || cn.sendSig(proof) != nil {
				cn.pushEv(ev{Ctrl: "ws-close", Err: "device identity authentication failed"})
				return
			}
		case "node-joined":
			cn.pushEv(ev{Ctrl: "node-joined", Msg: []byte(s.FP)})
		case "controller-identity":
			cn.pushEv(ev{Ctrl: "controller-identity", Msg: []byte(s.FP)})
		case "cand":
			var init webrtc.ICECandidateInit
			if json.Unmarshal([]byte(s.Cand), &init) == nil {
				cn.addCand(init)
			}
		case "sdp":
			if cn.offerer {
				// 本端发的 offer，收到对端 answer
				if err := cn.acceptSDP(s.SDP, true); err != nil {
					cn.pushEv(ev{Ctrl: "pair-fail", Msg: []byte(err.Error())})
				}
			} else {
				// 对端（node）offer：建 PC 并回 answer
				if err := cn.acceptOffer(s.SDP); err != nil {
					cn.pushEv(ev{Ctrl: "pair-fail", Msg: []byte(err.Error())})
				}
			}
		case "dc":
			if s.D != "" {
				cn.pushEv(ev{Msg: unb64(s.D)})
			}
		case "pair-req":
			if s.Relay {
				cn.rel = true
			}
			cn.pushEv(ev{Ctrl: "pair-req", Msg: []byte(s.CtlFP)})
		case "pair-fail":
			cn.pushEv(ev{Ctrl: "pair-fail", Msg: []byte(s.Err)})
		case "paired":
			cn.pushEv(ev{Ctrl: "paired"})
		case "unpaired":
			cn.teardownPC()
			cn.pushEv(ev{Ctrl: "unpaired", Msg: []byte(s.Err)})
		case "status":
			cn.pushEv(ev{Ctrl: "status", Msg: []byte(s.D)})
		case "op-ok":
			// 批量操作会带条数；单设备操作只有 Name（rename 时非空）
			payload := s.Name
			if s.Done > 0 || s.Skipped > 0 {
				payload = fmt.Sprintf("%d/%d", s.Done, s.Done+s.Skipped)
			}
			cn.pushEv(ev{Ctrl: "op-ok", Msg: []byte(payload)})
		case "op-fail":
			cn.pushEv(ev{Ctrl: "op-fail", Msg: []byte(s.Err)})
		case "model-grant-end":
			cn.pushEv(ev{Ctrl: "model-grant-end", ID: s.ID, Run: strings.TrimSpace(s.Run)})
		case "model-grant":
			cn.pushEv(ev{Ctrl: "model-grant", ID: s.ID, Msg: []byte(s.D), Err: s.Err, TTL: s.TTL,
				DefaultModel: s.DefaultModel, DefaultProtocol: s.DefaultProtocol,
				BindingID: s.BindingID, BoundModel: s.BoundModel, BoundProtocol: s.BoundProtocol,
				BoundDecision: s.BoundDecision, BoundDecisionExp: s.BoundDecisionExp,
				BoundMaxOutput: s.BoundMaxOutput, BoundTools: s.BoundTools, GoalLease: s.GoalLease})
		}
	}
}

func (cn *conn) pushEv(e ev) {
	select {
	case cn.ev <- e:
	default: // 缓冲满：丢帧好于阻塞读循环
	}
}

// ---- WebRTC ----

var iceConfig = webrtc.Configuration{
	ICEServers: []webrtc.ICEServer{
		{URLs: []string{"stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"}},
	},
}

// startOffer：node 收到 pair-req 后调用（offerer 专用）；旧 PC 让位
func (cn *conn) startOffer() error {
	cn.teardownPC()
	pc, err := webrtc.NewPeerConnection(iceConfig)
	if err != nil {
		return err
	}
	cn.mu.Lock()
	cn.pc = pc
	cn.remoteSet = false
	cn.pending = nil
	cn.mu.Unlock()
	cn.wirePC(pc)
	dc, err := pc.CreateDataChannel("hw", &webrtc.DataChannelInit{Ordered: new(true)})
	if err != nil {
		return err
	}
	cn.bindDC(dc)
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		return err
	}
	return cn.sendSig(&sig{K: "sdp", SDP: offer.SDP})
}

// acceptSDP：answer 模式（node 收 answer）；非 answer 则建 answer 回发
func (cn *conn) acceptSDP(sdp string, answer bool) error {
	cn.mu.Lock()
	pc := cn.pc
	cn.mu.Unlock()
	if pc == nil {
		return fmt.Errorf("尚未创建 PeerConnection")
	}
	t := webrtc.SDPTypeAnswer
	if !answer {
		t = webrtc.SDPTypeOffer
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: t, SDP: sdp}); err != nil {
		return err
	}
	cn.setRemoteDone()
	if !answer {
		ans, err := pc.CreateAnswer(nil)
		if err != nil {
			return err
		}
		if err := pc.SetLocalDescription(ans); err != nil {
			return err
		}
		return cn.sendSig(&sig{K: "sdp", SDP: ans.SDP})
	}
	return nil
}

// acceptOffer：ctl 收到 offer（answerer 专用）：建 PC、OnDataChannel、回 answer
func (cn *conn) acceptOffer(sdp string) error {
	pc, err := webrtc.NewPeerConnection(iceConfig)
	if err != nil {
		return err
	}
	cn.mu.Lock()
	old := cn.pc
	cn.pc = pc
	cn.remoteSet = false
	cn.pending = nil
	cn.mu.Unlock()
	if old != nil {
		_ = old.Close() // 重配对：旧 PC 让位
	}
	cn.wirePC(pc)
	pc.OnDataChannel(func(dc *webrtc.DataChannel) { cn.bindDC(dc) })
	return cn.acceptSDP(sdp, false)
}

func (cn *conn) setRemoteDone() {
	cn.mu.Lock()
	defer cn.mu.Unlock()
	cn.remoteSet = true
	if cn.pc != nil {
		for _, c := range cn.pending {
			_ = cn.pc.AddICECandidate(c)
		}
	}
	cn.pending = nil
}

func (cn *conn) addCand(init webrtc.ICECandidateInit) {
	cn.mu.Lock()
	pc := cn.pc
	ready := cn.remoteSet
	if pc != nil && !ready {
		cn.pending = append(cn.pending, init)
	}
	cn.mu.Unlock()
	if pc != nil && ready {
		_ = pc.AddICECandidate(init)
	}
}

func (cn *conn) wirePC(pc *webrtc.PeerConnection) {
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		_ = cn.sendSig(&sig{K: "cand", Cand: mustJSON(c.ToJSON())})
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		switch st {
		case webrtc.PeerConnectionStateFailed:
			cn.pushEv(ev{Ctrl: "pair-fail", Msg: []byte("P2P 协商失败，继续走 hub 中继")})
		case webrtc.PeerConnectionStateClosed:
			cn.pushEv(ev{Ctrl: "unpaired", Msg: []byte("连接已关闭")})
		}
	})
}

func (cn *conn) bindDC(dc *webrtc.DataChannel) {
	dc.OnOpen(func() {
		cn.mu.Lock()
		cn.dc = dc
		cn.mu.Unlock()
		cn.pushEv(ev{Ctrl: "p2p-up"})
	})
	dc.OnClose(func() {
		cn.mu.Lock()
		if cn.dc == dc {
			cn.dc = nil
		}
		cn.mu.Unlock()
	})
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		cn.pushEv(ev{Msg: m.Data})
	})
}

// sendMsg：一条 DC 帧。P2P open 走 DataChannel，否则 hub 中继
func (cn *conn) sendMsg(b []byte) error {
	if !cn.rel {
		cn.mu.Lock()
		dc := cn.dc
		cn.mu.Unlock()
		if dc != nil && dc.ReadyState() == webrtc.DataChannelStateOpen {
			return dc.Send(b)
		}
	}
	return cn.sendSig(&sig{K: "dc", D: b64(b)})
}

func (cn *conn) p2p() bool {
	cn.mu.Lock()
	defer cn.mu.Unlock()
	return cn.dc != nil && cn.dc.ReadyState() == webrtc.DataChannelStateOpen
}

func (cn *conn) teardownPC() {
	cn.mu.Lock()
	pc := cn.pc
	cn.pc = nil
	cn.dc = nil
	cn.remoteSet = false
	cn.pending = nil
	cn.mu.Unlock()
	if pc != nil {
		_ = pc.Close()
	}
}

// close：停 recvLoop、关 ws（调用后此 conn 报废）
func (cn *conn) close() {
	cn.teardownPC()
	cn.mu.Lock()
	w := cn.ws
	rc := cn.rcancel
	cn.ws = nil
	cn.rcancel = nil
	cn.mu.Unlock()
	if rc != nil {
		rc()
	}
	if w != nil {
		_ = w.Close(websocket.StatusNormalClosure, "")
	}
}
