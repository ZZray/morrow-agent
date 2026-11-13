package main

import (
	"context"
	"crypto/subtle"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"ara/apps/reach/platform/legacy/websafe"
	"ara/internal/gatewayclient"
	"nhooyr.io/websocket"
)

//go:embed web
var webFS embed.FS

// ---- hub：信令 + 审批授权 + AI 反代 + 工作台 API + 兜底中继 ----
//
//	GET  /healthz           开放健康检查
//	GET  /login             登录页（公开）
//	POST /auth/login        工作台会话 cookie
//	GET  /                  工作台（需登录）
//	/api/*                  工作区/会话/聊天/知识库（需登录）
//	GET  /ws?role=...       信令（Bearer / cookie / node 入网令牌）
//	GET  /download          安装包下载中心（可选）
//
// 审批模型（取代一次性配对码/TOFU/pinned）：
//	1. node 上线 join(fp,info) -> 登记为「待允许」设备（重复 join 顶掉旧连接）
//	2. ctl approve{nid,ttl} -> hub 记授权（approvals.json 持久化）-> 自动配对
//	3. 免码重连：ctl hello 或 node join 时，若存在有效授权且双方空闲 -> 自动配对
//	4. deny=屏蔽（黑名单）/ restore=解禁 / revoke=删授权 / setttl=改失效时间
//	5. 授权到期 -> 巡检解绑并通知双方；hub 重启授权不丢
//	6. SDP/ICE 经 hub 中继；DC 帧 base64 透传（hub 不解内容）

const approvalTick = 5 * time.Second // 授权过期巡检周期

type nodeConn struct {
	ws        *websocket.Conn
	fp        string // short display fingerprint; full key possession checked at join
	publicKey string
	seen      time.Time
	info      *Hello
}

// approval 设备授权：由哪个操作端指纹允许、何时失效（零值=永久）
type approval struct {
	CtlFP         string    `json:"ctlfp"`
	Exp           time.Time `json:"exp"`
	NodePublicKey string    `json:"node_public_key,omitempty"`
}

func (a *approval) live() bool {
	return a != nil && (a.Exp.IsZero() || time.Now().Before(a.Exp))
}

// smartFlight is one in-flight first selection of a session. Concurrent requests
// of the same session join it instead of resolving on their own: two independent
// resolves would each read an unpinned session and overwrite the other's identity.
// The mutex below only guards the map — the network resolve never runs under it.
type smartFlight struct {
	done chan struct{}
	dec  *gatewayclient.RouteDecision
	err  error
}

type hubSrv struct {
	token   string        // 根令牌：ctl / 控制台 / 下载中心 / 模型代理
	nodeTok string        // 入网令牌：仅允许 role=node 上线（可随 exe 公开分发）
	gw      *gatewayStore // 共享网关客户端（可空）
	dl      *dlRegistry   // 安装包下载（nil=未配置目录）
	dev     bool          // 调试模式：跳过工作台登录

	flightMu sync.Mutex
	flights  map[string]*smartFlight // "workspace\x00session" -> 首次选型

	// testBeforeIdentityCommit, when set by a test, runs at the identity commit
	// race boundary (after network resolve / providerConfig, before the atomic
	// read-validate-save). turnID tells the test which turn arrived, because a
	// single hub serves concurrent turns. Production leaves it nil.
	testBeforeIdentityCommit func(turnID string)

	mu        sync.Mutex
	nodes     map[string]*nodeConn // connID -> node
	ctlws     map[string]*ctlConn  // connID -> ctl
	peers     map[string]string    // 双向 nodeID<->ctlID
	devNode   map[string]string    // 设备指纹 -> 在线 connID
	approvals map[string]*approval // 设备指纹 -> 授权（持久化）
	denied    map[string]bool      // 屏蔽名单（持久化）
	aliases   map[string]string    // 设备指纹 -> 别名（持久化，独立于授权）
	dlses     map[string]time.Time // 下载会话 sid -> 过期
	auths     map[string]time.Time // 工作台会话 sid -> idle 过期
	seq       int
	execMu    sync.Mutex
	execRes   map[string]chan string // execID -> result channel
	grant     *grantBook             // node 本次执行访问码
	bind      *bindingBook           // 智能路径的可信绑定（与可过期 code 分离）
	longTasks *longTaskBook          // Explicit bounded Goal authorization; no scheduler.
	schedules *scheduleBook          // Once-only resume commands for explicitly paused Goals.

	// TOTP 二次验证（微软 Authenticator 等）
	totpLastCounter int64              // 已用过的最大 TOTP 计数器（重放守卫）
	totpPreauth     map[string]totpPre // 令牌校验通过后的短命预授权 sid -> 记录
}

type applyDecision struct {
	OK      bool
	Content string
}

type ctlConn struct {
	ws *websocket.Conn
	fp string
}

// newHubSrv 创建 Hub。overrides 为 CLI 显式覆盖的网关配置（空字段不覆盖）。
// distDir 非空则启用公开下载中心（目录应已存在或由调用方 MkdirAll；运行时每次现扫）
func newHubSrv(token, nodeTok string, overrides gatewayConfig, distDir string) (*hubSrv, error) {
	gw, err := newGatewayStore()
	if err != nil {
		return nil, err
	}
	if err := gw.applyOverrides(context.Background(), overrides); err != nil {
		return nil, err
	}
	var dl *dlRegistry
	if distDir != "" {
		if st, err := os.Stat(distDir); err == nil && st.IsDir() {
			dl = &dlRegistry{dir: distDir}
		}
	}
	h := &hubSrv{
		token:     token,
		nodeTok:   nodeTok,
		gw:        gw,
		dl:        dl,
		nodes:     map[string]*nodeConn{},
		ctlws:     map[string]*ctlConn{},
		peers:     map[string]string{},
		devNode:   map[string]string{},
		approvals: map[string]*approval{},
		denied:    map[string]bool{},
		aliases:   map[string]string{},
		dlses:     map[string]time.Time{},
		auths:     map[string]time.Time{},
	}
	h.loadApprovals()
	return h, nil
}

// ---- 授权持久化（confDir/approvals.json；hub 重启不丢授权/屏蔽） ----

type approvalFile struct {
	Approvals map[string]*approval `json:"approvals"`
	Denied    []string             `json:"denied,omitempty"`
	Aliases   map[string]string    `json:"aliases,omitempty"` // 设备指纹 -> 别名
}

func (h *hubSrv) loadApprovals() {
	b, err := os.ReadFile(filepath.Join(confDir(), "approvals.json"))
	if err != nil {
		return
	}
	var f approvalFile
	if json.Unmarshal(b, &f) != nil {
		return
	}
	for k, v := range f.Approvals {
		if v != nil && v.CtlFP != "" {
			if v.NodePublicKey != "" {
				if _, err := parseNodePublicKey(v.NodePublicKey, k); err != nil {
					continue
				}
			}
			h.approvals[k] = v
		}
	}
	for _, d := range f.Denied {
		h.denied[d] = true
	}
	for fp, name := range f.Aliases {
		if n := strings.TrimSpace(name); n != "" {
			h.aliases[fp] = n
		}
	}
}

// saveApprovalsLocked 原子落盘（调用方须持 h.mu）。失败静默：内存态仍正确。
func (h *hubSrv) saveApprovalsLocked() error {
	f := approvalFile{Approvals: h.approvals}
	for d := range h.denied {
		f.Denied = append(f.Denied, d)
	}
	sort.Strings(f.Denied)
	if len(h.aliases) > 0 {
		f.Aliases = h.aliases
	}
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	dir := confDir()
	return atomicWriteFile(filepath.Join(dir, "approvals.json"), b)
}

// auth：Bearer 头（CLI 用）或 ?token= 查询参数（浏览器 WebSocket 无法带自定义头）。
// role=node 时入网令牌 nodeTok 亦可（只能以上位者身份上线，开不了控制台）。
func (h *hubSrv) auth(r *http.Request, nodeOK bool) bool {
	got := r.Header.Get("authorization")
	if len(got) > 7 {
		got = got[7:]
	} else {
		got = r.URL.Query().Get("token")
	}
	if subtle.ConstantTimeCompare([]byte(got), []byte(h.token)) == 1 {
		return true
	}
	return nodeOK && h.nodeTok != "" && subtle.ConstantTimeCompare([]byte(got), []byte(h.nodeTok)) == 1
}

// certConfig TLS 由 main.go 决定（可 http/https 裸跑，反代交给 nginx）

func (h *hubSrv) routes(mux *http.ServeMux) {
	static, err := fs.Sub(webFS, "web")
	if err != nil {
		panic("web 资产缺失: " + err.Error())
	}
	fileServer := http.FileServer(http.FS(static))

	// 公开：健康检查、登录页、样式（登录页依赖）
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "handwave hub ok\n")
	})
	mux.HandleFunc("/home", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		h.renderStatic(w, "home.html")
	})
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		if h.dev {
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		if r.Method == http.MethodGet {
			h.renderStatic(w, "login.html")
			return
		}
		// POST 兼容下载中心旧表单；工作台用 /auth/login
		if h.dl != nil {
			h.loginH(w, r)
			return
		}
		h.authLoginH(w, r)
	})
	mux.HandleFunc("/auth/login", h.authLoginH)
	mux.HandleFunc("/auth/logout", h.authLogoutH)
	mux.HandleFunc("/auth/me", h.authMeH)
	mux.HandleFunc("/auth/totp", h.totpH)
	mux.HandleFunc("/auth/totp/qr", h.totpQRH)
	mux.Handle("/style.css", fileServer)

	// 工作台首页（需登录）
	mux.HandleFunc("/", h.wrapAuth(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		b, err := fs.ReadFile(static, "index.html")
		if err != nil {
			http.Error(w, "index 缺失", 500)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(b)
	}))
	mux.HandleFunc("/app.js", h.wrapAuth(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		body, err := fs.ReadFile(static, "app.js")
		if err == nil {
			body, err = websafe.AdaptApp(body)
		}
		if err != nil {
			http.Error(w, "HandWave script requires review", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write(body)
	}))
	mux.HandleFunc("/render.js", h.wrapAuth(func(w http.ResponseWriter, r *http.Request) {
		http.StripPrefix("/", fileServer).ServeHTTP(w, r)
	}))
	for _, asset := range []string{"/skills-ui.js", "/skills-ui.css"} {
		mux.HandleFunc(asset, h.wrapAuth(func(w http.ResponseWriter, r *http.Request) {
			http.StripPrefix("/", fileServer).ServeHTTP(w, r)
		}))
	}

	mux.HandleFunc("/api/", h.wrapAuth(h.apiH))
	mux.HandleFunc("/api", h.wrapAuth(h.apiH))

	mux.HandleFunc("/ws", h.wrapWS(h.wsH))
	mux.HandleFunc("/v1/", h.wrap(h.gatewayProxy))

	if h.dl != nil {
		mux.HandleFunc("/logout", h.logoutH)
		mux.HandleFunc("/download", h.downloadH)
		mux.HandleFunc("/dl/file", h.dlFileH)
	}
}

func (h *hubSrv) wrap(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h.authOK(r) {
			next(w, r)
			return
		}
		if ok, smart := h.modelGrantKind(r); ok {
			if smart {
				r = markSmartAuth(r)
			}
			next(w, r)
			return
		}
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
	}
}

// wrapWS：node 可用入网令牌；ctl/浏览器用根令牌或会话 cookie
func (h *hubSrv) wrapWS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		role := r.URL.Query().Get("role")
		if role == "node" {
			if !h.auth(r, true) {
				http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
				return
			}
		} else if !h.authOK(r) {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

// ---- ws 主循环 ----

func (h *hubSrv) wsH(w http.ResponseWriter, r *http.Request) {
	role := r.URL.Query().Get("role")
	if (role != "node" && role != "ctl") || !h.socketOriginAllowed(r) {
		http.Error(w, "invalid websocket role or origin", http.StatusForbidden)
		return
	}
	// Subprotocols 必须显式声明才会回显 Sec-WebSocket-Protocol —— 浏览器强制校验
	// 回显（Go 客户端宽松），缺失会导致网页控制台握手即 1006 断开
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols: []string{"handwave"},
	})
	if err != nil {
		return
	}
	defer c.Close(websocket.StatusNormalClosure, "")
	ctx := r.Context()
	c.SetReadLimit(wsMsgMax)

	id := h.newID(role)
	h.mu.Lock()
	if role == "ctl" {
		h.ctlws[id] = &ctlConn{ws: c, fp: h.controllerIdentity()}
	}
	h.mu.Unlock()
	defer h.cleanup(id)
	if role == "ctl" {
		wsSend(ctx, c, &sig{K: "controller-identity", FP: h.controllerIdentity()})
	}
	if role == "node" {
		if err := h.authenticateNode(ctx, id, c); err != nil {
			_ = c.Close(websocket.StatusPolicyViolation, "device identity proof rejected")
			return
		}
	}

	hbDone := make(chan struct{})
	defer close(hbDone)
	go func() {
		t := time.NewTicker(45 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-hbDone:
				return
			case <-t.C:
				wh, cancel := context.WithTimeout(ctx, writeWait)
				err := c.Ping(wh)
				cancel()
				if err != nil {
					// A missing Pong does not close nhooyr's Read loop by itself.
					// Closing this exact connection releases Read and the normal cleanup.
					_ = c.CloseNow()
					return
				}
			}
		}
	}()

	for {
		_, raw, err := c.Read(ctx)
		if err != nil {
			return
		}
		var s sig
		if json.Unmarshal(raw, &s) != nil {
			continue
		}
		if role == "node" {
			h.nodeMsg(ctx, id, c, &s)
		} else {
			h.ctlMsg(ctx, id, c, &s)
		}
	}
}

func (h *hubSrv) newID(role string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.seq++
	p := "c"
	if role == "node" {
		p = "n"
	}
	return fmt.Sprintf("%s%d", p, h.seq)
}

func wsSend(ctx context.Context, c *websocket.Conn, s *sig) {
	b, _ := json.Marshal(s)
	wh, cancel := context.WithTimeout(ctx, writeWait)
	defer cancel()
	_ = c.Write(wh, websocket.MessageText, b)
}

// wsSendJSON sends a raw JSON message to a WebSocket connection.
func wsSendJSON(ctx context.Context, c *websocket.Conn, raw []byte) {
	wh, cancel := context.WithTimeout(ctx, writeWait)
	defer cancel()
	_ = c.Write(wh, websocket.MessageText, raw)
}

// autoPairLocked 绑定 + 通知双方（需持锁调用）。调用前须校验双方在线且空闲。
func (h *hubSrv) autoPairLocked(ctx context.Context, nid, cid string, relay bool) {
	n := h.nodes[nid]
	cc := h.ctlws[cid]
	if n == nil || cc == nil || !h.nodeApprovalMatchesLocked(n) || h.approvals[n.fp].CtlFP != cc.fp {
		return
	}
	h.bindLocked(nid, cid)
	wsSend(ctx, n.ws, &sig{K: "pair-req", CtlFP: cc.fp, Relay: relay})
	wsSend(ctx, cc.ws, &sig{K: "paired"})
}

// tryAutoPairLocked 免码重连：设备存在有效授权、授权方 ctl 在线、双方空闲。
// 返回是否触发配对（需持锁调用）。
func (h *hubSrv) tryAutoPairLocked(ctx context.Context, devFP string, relay bool) bool {
	nid := h.devNode[devFP]
	if nid == "" || h.denied[devFP] {
		return false
	}
	ap := h.approvals[devFP]
	if !ap.live() {
		return false
	}
	if !h.nodeApprovalMatchesLocked(h.nodes[nid]) {
		return false
	}
	cid := ""
	for id, cc := range h.ctlws {
		if cc.fp == ap.CtlFP {
			cid = id
			break
		}
	}
	if cid == "" {
		return false
	}
	if _, busy := h.peers[nid]; busy {
		return false
	}
	if _, busy := h.peers[cid]; busy {
		return false
	}
	h.autoPairLocked(ctx, nid, cid, relay)
	return true
}

// ---- node 消息 ----

func (h *hubSrv) nodeMsg(ctx context.Context, id string, c *websocket.Conn, s *sig) {
	switch s.K {
	case "join":
		// The only join is consumed by authenticateNode before the read loop.
		_ = c.Close(websocket.StatusPolicyViolation, "device identity proof cannot be replayed")
	case "sdp", "cand", "dc":
		h.toPeer(ctx, id, s)
	case "model-grant":
		h.issueModelGrant(ctx, id, c, s)
	case "model-grant-end":
		h.endModelGrantRun(ctx, id, s)
	case "goal-state":
		h.recordGoalState(ctx, id, c, s)
	case "job-command-result":
		h.forwardJobResult(ctx, id, c, s)
	case "goal-command-result":
		h.recordGoalCommandResult(ctx, id, c, s)
	case "out":
		// Forward exec result to waiting goroutine
		if s.ID != "" {
			h.execMu.Lock()
			ch := h.execRes[s.ID]
			delete(h.execRes, s.ID)
			h.execMu.Unlock()
			if ch != nil {
				result := s.Msg
				if s.Code != 0 {
					result = fmt.Sprintf("exit %d: %s", s.Code, s.Msg)
				}
				select {
				case ch <- result:
				default:
				}
			}
		}
	default:
	}
}

// ---- ctl 消息 ----

func (h *hubSrv) ctlMsg(ctx context.Context, id string, c *websocket.Conn, s *sig) {
	switch s.K {
	case "schedule-list", "schedule-save", "schedule-pause", "schedule-cancel":
		h.handleSchedule(ctx, id, c, s)
	case "job-command":
		h.forwardJobCommand(ctx, id, c, s)
	case "goal-command":
		h.forwardGoalCommand(ctx, id, c, s)
	case "goal-inspect":
		h.sendControllerGoals(ctx, id, c, s)
	case "hello":
		h.mu.Lock()
		cc := h.ctlws[id]
		if cc == nil {
			h.mu.Unlock()
			return
		}
		// Ownership was established at authenticated socket admission. Ignore
		// all client-supplied fingerprints, including repeated hello messages.
		// 免码重连：找授权给本指纹且空闲的在线设备
		if _, bound := h.peers[id]; !bound {
			for devFP, ap := range h.approvals {
				if ap.CtlFP == cc.fp && ap.live() && h.tryAutoPairLocked(ctx, devFP, s.Relay) {
					break
				}
			}
		}
		h.broadcastStatusLocked()
		h.mu.Unlock()
	case "connect-approved":
		h.handleConnectApproved(ctx, id, c, s)
	case "approve":
		h.mu.Lock()
		n := h.nodes[s.NID]
		switch {
		case n == nil:
			h.mu.Unlock()
			wsSend(ctx, c, &sig{K: "pair-fail", Err: "设备已离线，请刷新列表"})
		case h.denied[n.fp]:
			h.mu.Unlock()
			wsSend(ctx, c, &sig{K: "pair-fail", Err: "该设备在屏蔽名单中，先解除屏蔽"})
		case func() bool { _, busy := h.peers[s.NID]; return busy }():
			h.mu.Unlock()
			wsSend(ctx, c, &sig{K: "pair-fail", Err: "该设备正被另一操作端占用"})
		case func() bool { _, bound := h.peers[id]; return bound }():
			h.mu.Unlock()
			wsSend(ctx, c, &sig{K: "pair-fail", Err: "本端已有另一配对，先断开再试"})
		default:
			var exp time.Time
			if s.TTL > 0 {
				exp = time.Now().Add(time.Duration(s.TTL) * time.Second)
			}
			cc := h.ctlws[id]
			if err := h.pinApprovalLocked(n.fp, cc.fp, exp); err != nil {
				h.mu.Unlock()
				wsSend(ctx, c, &sig{K: "pair-fail", Err: err.Error()})
				return
			}
			h.autoPairLocked(ctx, s.NID, id, s.Relay)
			h.broadcastStatusLocked()
			h.mu.Unlock()
		}
	case "deny":
		h.mu.Lock()
		h.denied[s.FP] = true
		delete(h.approvals, s.FP)
		if nid := h.devNode[s.FP]; nid != "" {
			if peer, ok := h.peers[nid]; ok {
				delete(h.peers, peer)
				delete(h.peers, nid)
				if pc := h.ctlws[peer]; pc != nil {
					wsSend(ctx, pc.ws, &sig{K: "unpaired", Err: "设备已被屏蔽"})
				}
			}
		}
		h.saveApprovalsLocked()
		h.broadcastStatusLocked()
		// 屏蔽：该设备的可信绑定必须立刻失效，不能等断连。
		if h.bind != nil {
			h.bind.dropFP(s.FP)
		}
		h.mu.Unlock()
	case "restore":
		h.mu.Lock()
		delete(h.denied, s.FP)
		h.saveApprovalsLocked()
		h.broadcastStatusLocked()
		h.mu.Unlock()
	case "revoke":
		h.mu.Lock()
		delete(h.approvals, s.FP)
		if nid := h.devNode[s.FP]; nid != "" {
			if peer, ok := h.peers[nid]; ok {
				delete(h.peers, peer)
				delete(h.peers, nid)
				if pc := h.ctlws[peer]; pc != nil {
					wsSend(ctx, pc.ws, &sig{K: "unpaired", Err: "授权已撤销"})
				}
			}
		}
		h.saveApprovalsLocked()
		h.broadcastStatusLocked()
		if h.bind != nil {
			h.bind.dropFP(s.FP)
		}
		h.mu.Unlock()
	case "setttl":
		h.mu.Lock()
		if ap := h.approvals[s.FP]; ap != nil {
			if s.TTL > 0 {
				ap.Exp = time.Now().Add(time.Duration(s.TTL) * time.Second)
			} else {
				ap.Exp = time.Time{}
			}
			// 立即生效：若目标已到期由巡检处理；这里只可能延长或置永久
			h.saveApprovalsLocked()
		}
		h.broadcastStatusLocked()
		h.mu.Unlock()
	case "rename":
		// 设置/清除设备别名。别名独立于授权：离线或未授权设备也能命名。
		h.mu.Lock()
		if s.FP == "" {
			h.mu.Unlock()
			wsSend(ctx, c, &sig{K: "op-fail", Err: "缺少设备指纹"})
			break
		}
		name := strings.TrimSpace(s.Name)
		if len([]rune(name)) > 32 {
			name = string([]rune(name)[:32])
		}
		if name == "" {
			delete(h.aliases, s.FP)
		} else {
			h.aliases[s.FP] = name
		}
		h.saveApprovalsLocked()
		h.broadcastStatusLocked()
		h.mu.Unlock()
		wsSend(ctx, c, &sig{K: "op-ok", Name: name})
	case "remove":
		// 彻底删除设备记录：别名 + 授权 + 屏蔽一并清除；在线则断开。
		// 与 revoke（只删授权）不同 —— 这是把设备从列表里完全移除。
		h.mu.Lock()
		if s.FP == "" {
			h.mu.Unlock()
			wsSend(ctx, c, &sig{K: "op-fail", Err: "缺少设备指纹"})
			break
		}
		delete(h.aliases, s.FP)
		delete(h.approvals, s.FP)
		delete(h.denied, s.FP)
		if nid := h.devNode[s.FP]; nid != "" {
			if peer, ok := h.peers[nid]; ok {
				delete(h.peers, peer)
				delete(h.peers, nid)
				if pc := h.ctlws[peer]; pc != nil {
					wsSend(ctx, pc.ws, &sig{K: "unpaired", Err: "设备记录已删除"})
				}
			}
			// 在线 node 保留连接（仍可重新审批），只清记录
		}
		h.saveApprovalsLocked()
		h.broadcastStatusLocked()
		h.mu.Unlock()
		wsSend(ctx, c, &sig{K: "op-ok"})
	case "retry":
		// 重新尝试接入：对已授权且在线、但当前空闲的设备重发配对。
		// 等价于前端原本的「接入」（重发 hello），但以 nid 精确指定目标。
		h.mu.Lock()
		n := h.nodes[s.NID]
		switch {
		case n == nil:
			h.mu.Unlock()
			wsSend(ctx, c, &sig{K: "op-fail", Err: "设备已离线，请刷新列表"})
		case h.denied[n.fp]:
			h.mu.Unlock()
			wsSend(ctx, c, &sig{K: "op-fail", Err: "该设备在屏蔽名单中，先解除屏蔽"})
		case !h.nodeApprovalMatchesLocked(n):
			h.mu.Unlock()
			wsSend(ctx, c, &sig{K: "op-fail", Err: "该设备尚未获授权"})
		case func() bool { _, busy := h.peers[s.NID]; return busy }():
			h.mu.Unlock()
			wsSend(ctx, c, &sig{K: "op-fail", Err: "该设备已在会话中"})
		case func() bool { _, bound := h.peers[id]; return bound }():
			h.mu.Unlock()
			wsSend(ctx, c, &sig{K: "op-fail", Err: "本端已有另一配对，先断开再试"})
		default:
			h.autoPairLocked(ctx, s.NID, id, s.Relay)
			h.broadcastStatusLocked()
			h.mu.Unlock()
		}
	case "batch":
		// 批量操作：对多个设备依次执行同一动作，语义与单设备一致。
		// op=approve：批量写入授权（TTL 一致）；只有第一台会立即配对，
		//   其余留作「已授权」，避免一次绑多台（一个操作端同时只能接一台）。
		// op=deny/restore/revoke/remove：逐个应用，互不影响。
		h.mu.Lock()
		cc := h.ctlws[id]
		// The authenticated connection owns the operation, never SelfFP.
		ctlFP := ""
		if cc != nil {
			ctlFP = cc.fp
		}
		var exp time.Time
		if s.TTL > 0 {
			exp = time.Now().Add(time.Duration(s.TTL) * time.Second)
		}
		done, skipped := 0, 0
		pairTarget := ""
		bound := false
		if _, ok := h.peers[id]; ok {
			bound = true
		}
		for _, fp := range s.FPs {
			switch s.Op {
			case "approve":
				nid := h.devNode[fp]
				if h.denied[fp] {
					skipped++
					log.Printf("batch approve: %s 在屏蔽名单", fp)
					continue
				}
				if ctlFP == "" {
					skipped++
					continue
				}
				if err := h.pinApprovalLocked(fp, ctlFP, exp); err != nil {
					skipped++
					continue
				}
				done++
				// 只挑一台在线且空闲的设备立即配对
				if !bound && pairTarget == "" && nid != "" {
					if _, busy := h.peers[nid]; !busy {
						pairTarget = nid
					}
				}
			case "deny":
				if nid := h.devNode[fp]; nid != "" {
					if peer, ok := h.peers[nid]; ok {
						delete(h.peers, peer)
						delete(h.peers, nid)
						if pc := h.ctlws[peer]; pc != nil {
							wsSend(ctx, pc.ws, &sig{K: "unpaired", Err: "设备已被屏蔽"})
						}
					}
				}
				h.denied[fp] = true
				delete(h.approvals, fp)
				done++
			case "restore":
				delete(h.denied, fp)
				done++
			case "revoke":
				delete(h.approvals, fp)
				if nid := h.devNode[fp]; nid != "" {
					if peer, ok := h.peers[nid]; ok {
						delete(h.peers, peer)
						delete(h.peers, nid)
						if pc := h.ctlws[peer]; pc != nil {
							wsSend(ctx, pc.ws, &sig{K: "unpaired", Err: "授权已撤销"})
						}
					}
				}
				done++
			case "remove":
				delete(h.aliases, fp)
				delete(h.approvals, fp)
				delete(h.denied, fp)
				if nid := h.devNode[fp]; nid != "" {
					if peer, ok := h.peers[nid]; ok {
						delete(h.peers, peer)
						delete(h.peers, nid)
						if pc := h.ctlws[peer]; pc != nil {
							wsSend(ctx, pc.ws, &sig{K: "unpaired", Err: "设备记录已删除"})
						}
					}
				}
				done++
			}
		}
		if s.Op == "approve" && pairTarget != "" {
			h.autoPairLocked(ctx, pairTarget, id, s.Relay)
		}
		h.saveApprovalsLocked()
		h.broadcastStatusLocked()
		h.mu.Unlock()
		wsSend(ctx, c, &sig{K: "op-ok", Done: done, Skipped: skipped})
	case "bye":
		h.mu.Lock()
		if peer, ok := h.peers[id]; ok {
			delete(h.peers, peer)
			delete(h.peers, id)
			if pn := h.nodes[peer]; pn != nil {
				if cc := h.ctlws[id]; cc != nil {
					h.revokeControllerGoalsLocked(cc.fp, pn.fp)
				}
				wsSend(ctx, pn.ws, &sig{K: "unpaired"})
			}
		}
		h.broadcastStatusLocked()
		h.mu.Unlock()
		wsSend(ctx, c, &sig{K: "unpaired"})
	case "dc":
		if err := h.registerGoalRelay(id, c, s); err != nil {
			wsSend(ctx, c, &sig{K: "op-fail", Err: err.Error()})
			return
		}
		h.toPeer(ctx, id, s)
	case "sdp", "cand":
		h.toPeer(ctx, id, s)
	case "status":
		h.mu.Lock()
		h.sendStatusLocked(c)
		h.mu.Unlock()
	default:
	}
}

// ---- 设备表推送 ----

type devStatus struct {
	NID      string   `json:"nid"`
	State    string   `json:"state"` // pending | paired | denied | approved
	FP       string   `json:"fp"`
	Hostname string   `json:"hostname"`
	User     string   `json:"user"`
	OS       string   `json:"os"`
	Arch     string   `json:"arch,omitempty"`
	Seen     string   `json:"seen"`
	Exp      string   `json:"exp,omitempty"`  // RFC3339；空=永久
	By       string   `json:"by,omitempty"`   // 授权操作端指纹
	Name     string   `json:"name,omitempty"` // 别名（用户设置，独立于授权）
	Mine     bool     `json:"mine,omitempty"`
	Caps     []string `json:"caps,omitempty"`
}

// buildStatusLocked 汇总在线设备 + 离线但保留授权的设备（需持锁调用）
func (h *hubSrv) buildStatusLocked() []devStatus {
	var out []devStatus
	for nid, n := range h.nodes {
		st := "pending"
		if h.denied[n.fp] {
			st = "denied"
		} else if _, busy := h.peers[nid]; busy {
			st = "paired"
		} else if h.nodeApprovalMatchesLocked(n) {
			st = "approved"
		}
		d := devStatus{NID: nid, State: st, FP: n.fp, Hostname: n.info.Hostname,
			User: n.info.User, OS: n.info.OS, Arch: n.info.Arch, Name: h.aliases[n.fp], Caps: n.info.Caps,
			Seen: time.Since(n.seen).Round(time.Second).String()}
		if ap := h.approvals[n.fp]; ap != nil {
			d.By = ap.CtlFP
			if !ap.Exp.IsZero() {
				d.Exp = ap.Exp.Format(time.RFC3339)
			}
		}
		out = append(out, d)
	}
	// 离线设备：授权/屏蔽记录仍要展示，便于删除
	offline := 1
	for fp, ap := range h.approvals {
		if _, online := h.devNode[fp]; online {
			continue
		}
		nid := fmt.Sprintf("off%d", offline)
		offline++
		d := devStatus{NID: nid, State: "approved-offline", FP: fp, By: ap.CtlFP,
			Name: h.aliases[fp]}
		if !ap.Exp.IsZero() {
			d.Exp = ap.Exp.Format(time.RFC3339)
		}
		out = append(out, d)
	}
	for fp := range h.denied {
		if _, online := h.devNode[fp]; online {
			continue
		}
		out = append(out, devStatus{NID: "offd" + fp[:4], State: "denied", FP: fp,
			Name: h.aliases[fp]})
	}
	// 仅有别名、无授权也无屏蔽的设备：仍需列出，否则别名会变成看不见的孤儿数据
	for fp, name := range h.aliases {
		if _, online := h.devNode[fp]; online {
			continue
		}
		if _, hasAp := h.approvals[fp]; hasAp {
			continue // 已在上面作为 approved-offline 列出
		}
		if h.denied[fp] {
			continue // 已在上面作为 denied 列出
		}
		out = append(out, devStatus{NID: "offn" + fp[:4], State: "known", FP: fp, Name: name})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].FP < out[j].FP })
	return out
}

func (h *hubSrv) sendStatusLocked(target *websocket.Conn) {
	b, _ := json.Marshal(h.buildStatusLocked())
	wsSendJSON(context.Background(), target, statusSignal(b))
}

// broadcastStatusLocked 向全部在线 ctl 推送设备表（需持锁调用）。
// wsSend 带 ctx 超时，持锁发送最坏 ctlws×writeWait；当前 ctl 数量级远小于此风险。
func (h *hubSrv) broadcastStatusLocked() {
	b, _ := json.Marshal(h.buildStatusLocked())
	for _, cc := range h.ctlws {
		wsSendJSON(context.Background(), cc.ws, statusSignal(b))
	}
}

// ---- 注册表（*Locked 需持锁调用）----

func (h *hubSrv) bindLocked(nid, cid string) {
	h.peers[nid] = cid
	h.peers[cid] = nid
}

// dropLocked 清理 node 及其配对关系；ctl 侧回 unpaired。授权记录保留（重连免审）。
func (h *hubSrv) dropLocked(id string) {
	n := h.nodes[id]
	if n == nil {
		return
	}
	h.goalNodeOfflineLocked(n.fp)
	if h.devNode[n.fp] == id {
		delete(h.devNode, n.fp)
	}
	if h.grant != nil {
		h.grant.dropFP(n.fp)
	}
	// 智能路径的新记录必须接入同一断连清理：否则断连后旧 smart 码仍被 modelGrantOK 接受。
	if h.bind != nil {
		h.bind.dropFP(n.fp)
	}
	delete(h.nodes, id)
	if peer, ok := h.peers[id]; ok {
		delete(h.peers, peer)
		delete(h.peers, id)
		if pc := h.ctlws[peer]; pc != nil {
			wsSend(context.Background(), pc.ws, &sig{K: "unpaired", Err: "目标机已离线"})
		}
	}
}

// cleanup 连接断开：node 走 drop（授权保留）；ctl 仅解绑。
func (h *hubSrv) cleanup(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.nodes[id]; ok {
		h.dropLocked(id)
		h.broadcastStatusLocked()
		return
	}
	cc := h.ctlws[id]
	delete(h.ctlws, id)
	if peer, ok := h.peers[id]; ok {
		delete(h.peers, peer)
		delete(h.peers, id)
		if n := h.nodes[peer]; n != nil {
			if cc != nil && h.detachGoalControllerLocked(cc.fp, n.fp) {
				wsSend(context.Background(), n.ws, &sig{K: "controller-detached"})
			} else {
				wsSend(context.Background(), n.ws, &sig{K: "unpaired"})
			}
		}
	}
	h.broadcastStatusLocked()
}

// expireSweep 授权过期巡检：到期 -> 删授权 + 解绑通知双方 + 落盘。
func (h *hubSrv) expireSweep() {
	t := time.NewTicker(approvalTick)
	defer t.Stop()
	for range t.C {
		h.mu.Lock()
		changed := false
		for fp, ap := range h.approvals {
			if ap.live() {
				continue
			}
			delete(h.approvals, fp)
			changed = true
			if nid := h.devNode[fp]; nid != "" {
				if peer, ok := h.peers[nid]; ok {
					delete(h.peers, peer)
					delete(h.peers, nid)
					if pc := h.ctlws[peer]; pc != nil {
						wsSend(context.Background(), pc.ws, &sig{K: "unpaired", Err: "授权已过期"})
					}
				}
				if n := h.nodes[nid]; n != nil {
					wsSend(context.Background(), n.ws, &sig{K: "unpaired", Err: "授权已过期"})
				}
			}
		}
		if changed {
			h.saveApprovalsLocked()
			h.broadcastStatusLocked()
		}
		h.mu.Unlock()
	}
}

func (h *hubSrv) toPeer(ctx context.Context, from string, s *sig) {
	h.mu.Lock()
	to := h.peers[from]
	var tc *websocket.Conn
	if to != "" {
		if n := h.nodes[to]; n != nil {
			tc = n.ws
		} else if cc := h.ctlws[to]; cc != nil {
			tc = cc.ws
		}
	}
	h.mu.Unlock()
	if tc != nil {
		wsSend(ctx, tc, s)
	}
}

// cloudToolResult is the result of a cloud tool execution.
// Status values:
//   - "done": execution complete, Content contains result
//   - "pending": waiting for user confirmation (apply_code only), Diff contains the diff
type cloudToolResult struct {
	Status     string `json:"status"` // "done" | "pending" | "error"
	Content    string `json:"content,omitempty"`
	Diff       string `json:"diff,omitempty"`
	ToolCallID string `json:"tool_call_id,omitempty"`
	Name       string `json:"name,omitempty"`
	Error      string `json:"error,omitempty"`
}

// cloudToolCall is an alias for cloudToolCallWithGlobalPending.
func (h *hubSrv) cloudToolCall(ctx context.Context, wsMeta *wsMeta, name string, args map[string]any, toolCallID string) cloudToolResult {
	return h.cloudToolCallWithGlobalPending(ctx, wsMeta, name, args, toolCallID)
}

// computeDiff generates a unified diff between existing file content and new content.
func computeDiff(root, filePath, newContent string) (string, error) {
	tmp := filepath.Join(os.TempDir(), "handwave_apply_"+fmt.Sprintf("%d", time.Now().UnixNano())+".tmp")
	defer os.Remove(tmp)
	existingContent := ""
	absPath := filepath.Join(root, filePath)
	if data, err := os.ReadFile(absPath); err == nil {
		existingContent = string(data)
	}
	if err := os.WriteFile(tmp, []byte(newContent), 0o644); err != nil {
		return "", fmt.Errorf("temp write failed: %w", err)
	}
	var diffOut strings.Builder
	if existingContent != "" {
		cmd := exec.Command("diff", "-u", "--label", filePath, "--label", filePath, absPath, tmp)
		cmd.Dir = root
		out, err := cmd.Output()
		if err != nil && len(out) == 0 {
			return simpleUnifiedDiff(filePath, existingContent, newContent), nil
		}
		diffOut.Write(out)
	} else {
		diffOut.WriteString("--- /dev/null\n")
		diffOut.WriteString("+++ " + filePath + "\n")
		n := strings.Count(newContent, "\n") + 1
		diffOut.WriteString("@@ -0,0 +1," + fmt.Sprintf("%d", n) + " @@\n")
		for i, line := range strings.Split(newContent, "\n") {
			diffOut.WriteString("+" + line)
			if i < strings.Count(newContent, "\n") {
				diffOut.WriteString("\n")
			}
		}
	}
	return diffOut.String(), nil
}

// simpleUnifiedDiff is used when the diff binary is missing (typical on Windows).
func simpleUnifiedDiff(name, oldText, newText string) string {
	oldLines := strings.Split(oldText, "\n")
	newLines := strings.Split(newText, "\n")
	var b strings.Builder
	fmt.Fprintf(&b, "--- %s\n+++ %s\n@@ -1,%d +1,%d @@\n", name, name, len(oldLines), len(newLines))
	for _, line := range oldLines {
		b.WriteString("-" + line + "\n")
	}
	for _, line := range newLines {
		b.WriteString("+" + line + "\n")
	}
	return b.String()
}

// Global pending apply registry — shared across all chat sessions.
var applyPendingMu sync.Mutex
var applyPending = make(map[string]chan applyDecision) // toolCallID -> confirm channel
var applyPendingMeta = make(map[string]*ApplyConfirm)  // toolCallID -> metadata
var applyPendingHooks []func(string)                   // registered SSE subscribers

// RegisterApplyPendingHook registers an SSE subscriber for apply pending events.
func RegisterApplyPendingHook(h func(string)) {
	applyPendingMu.Lock()
	defer applyPendingMu.Unlock()
	applyPendingHooks = append(applyPendingHooks, h)
}

// UnregisterApplyPendingHook removes a subscriber.
func UnregisterApplyPendingHook(h func(string)) {
	applyPendingMu.Lock()
	defer applyPendingMu.Unlock()
	for i := len(applyPendingHooks) - 1; i >= 0; i-- {
		if &applyPendingHooks[i] == &h {
			applyPendingHooks = append(applyPendingHooks[:i], applyPendingHooks[i+1:]...)
			break
		}
	}
}

// RegisterApplyPending registers a pending apply_code confirmation.
// Returns the channel to wait on.
func RegisterApplyPending(tcID string, meta *ApplyConfirm) chan applyDecision {
	applyPendingMu.Lock()
	defer applyPendingMu.Unlock()
	ch := make(chan applyDecision, 1)
	applyPending[tcID] = ch
	applyPendingMeta[tcID] = meta
	for _, h := range applyPendingHooks {
		h(tcID)
	}
	return ch
}

// ResolveApply resolves or rejects a pending apply_code by toolCallID.
func ResolveApply(tcID string, ok bool, content string) {
	applyPendingMu.Lock()
	defer applyPendingMu.Unlock()
	ch, exists := applyPending[tcID]
	if !exists {
		return
	}
	delete(applyPending, tcID)
	delete(applyPendingMeta, tcID)
	ch <- applyDecision{OK: ok, Content: content}
}

// GetApplyPendingMeta returns the metadata for a pending apply.
func GetApplyPendingMeta(tcID string) *ApplyConfirm {
	applyPendingMu.Lock()
	defer applyPendingMu.Unlock()
	return applyPendingMeta[tcID]
}

// cloudToolCallWithGlobalPending is like cloudToolCall but uses the global pending registry.
// This version does not block — it returns "pending" immediately after registering.
func (h *hubSrv) cloudToolCallWithGlobalPending(ctx context.Context, wsMeta *wsMeta, name string, args map[string]any, toolCallID string) cloudToolResult {
	// Node tools (exec/read_file/write_file) need project path configured
	needsProjectPath := name == "search_codebase" || name == "read_file" || name == "apply_code"
	if needsProjectPath && (wsMeta == nil || wsMeta.ProjectPath == "") {
		return cloudToolResult{Status: "error", Error: "no project path configured"}
	}
	root := wsMeta.ProjectPath
	switch name {
	case "exec":
		// Execute command on connected Node
		cmd, _ := args["cmd"].(string)
		if cmd == "" {
			return cloudToolResult{Status: "error", Error: "cmd required"}
		}
		// Find the paired node for this workspace
		nid := ""
		if wsMeta != nil && wsMeta.DeviceFP != "" {
			nid = h.devNode[wsMeta.DeviceFP]
		}
		if nid == "" {
			// Try to find any paired node
			for _, peerID := range h.peers {
				if n := h.nodes[peerID]; n != nil {
					nid = peerID
					break
				}
			}
		}
		if nid == "" {
			return cloudToolResult{Status: "error", Error: "no Node connected"}
		}
		// Send exec command to node
		cwd, _ := args["cwd"].(string)
		timeout, _ := args["timeout"].(float64)
		if timeout == 0 {
			timeout = 300
		}
		resultCh := make(chan string, 1)
		execID := fmt.Sprintf("exec_%d", time.Now().UnixNano())
		// Register pending exec
		h.execMu.Lock()
		if h.execRes == nil {
			h.execRes = make(map[string]chan string)
		}
		h.execRes[execID] = resultCh
		h.execMu.Unlock()
		// Send exec signal to node
		h.mu.Lock()
		if n := h.nodes[nid]; n != nil && n.ws != nil {
			b, _ := json.Marshal(dcf{K: "exec", ID: execID, Cmd: cmd, Cwd: cwd, Timeout: int(timeout)})
			wsSendJSON(context.Background(), n.ws, b)
		}
		h.mu.Unlock()
		// Wait for result with timeout
		select {
		case <-ctx.Done():
			return cloudToolResult{Status: "error", Error: "execution cancelled"}
		case result := <-resultCh:
			return cloudToolResult{Status: "done", Content: result}
		case <-time.After(time.Duration(timeout) * time.Second):
			return cloudToolResult{Status: "error", Error: "execution timeout"}
		}

	case "search_codebase":
		pattern, _ := args["pattern"].(string)
		searchPath, _ := args["path"].(string)
		isRegex, _ := args["is_regex"].(bool)
		fileOnly, _ := args["file_only"].(bool)
		if pattern == "" {
			return cloudToolResult{Status: "error", Error: "pattern required"}
		}
		matches, err := searchProjectFiles(root, pattern, searchPath, isRegex, fileOnly)
		if err != nil {
			return cloudToolResult{Status: "error", Error: err.Error()}
		}
		if len(matches) == 0 {
			return cloudToolResult{Status: "done", Content: "No matches found."}
		}
		return cloudToolResult{Status: "done", Content: strings.Join(matches, "\n")}

	case "read_file":
		filePath, _ := args["path"].(string)
		if filePath == "" {
			return cloudToolResult{Status: "error", Error: "path required"}
		}
		content, err := readProjectFile(root, filePath)
		if err != nil {
			return cloudToolResult{Status: "error", Error: err.Error()}
		}
		startLine, _ := args["start_line"].(float64)
		endLine, _ := args["end_line"].(float64)
		if startLine > 0 || endLine > 0 {
			lines := strings.Split(content, "\n")
			s := int(startLine) - 1
			if s < 0 {
				s = 0
			}
			e := int(endLine)
			if e > len(lines) {
				e = len(lines)
			}
			if e <= s {
				return cloudToolResult{Status: "error", Error: "invalid line range"}
			}
			content = strings.Join(lines[s:e], "\n")
		}
		return cloudToolResult{Status: "done", Content: content}

	case "apply_code":
		filePath, _ := args["path"].(string)
		newContent, _ := args["content"].(string)
		if filePath == "" || newContent == "" {
			return cloudToolResult{Status: "error", Error: "path and content required"}
		}
		diff, diffErr := computeDiff(root, filePath, newContent)
		if diffErr != nil {
			return cloudToolResult{Status: "error", Error: diffErr.Error()}
		}
		tcID := toolCallID
		if tcID == "" {
			tcID = fmt.Sprintf("apply_%d", time.Now().UnixNano())
		}
		// Register globally and wait for user confirmation — blocks until resolved or timeout
		meta := &ApplyConfirm{WorkspaceID: wsMeta.ID, ToolCallID: tcID, Path: filePath, Content: newContent, Diff: diff}
		ch := RegisterApplyPending(tcID, meta)
		// Wait on the channel with context deadline
		select {
		case <-ctx.Done():
			return cloudToolResult{Status: "error", ToolCallID: tcID, Name: "apply_code", Error: "cancelled (timeout or disconnect)"}
		case dec := <-ch:
			if !dec.OK || dec.Content == "" {
				return cloudToolResult{Status: "error", ToolCallID: tcID, Name: "apply_code", Error: "rejected by user"}
			}
			// Apply confirmed content
			if err := writeProjectFile(root, filePath, []byte(dec.Content)); err != nil {
				return cloudToolResult{Status: "error", ToolCallID: tcID, Name: "apply_code", Error: "apply failed: " + err.Error()}
			}
			return cloudToolResult{Status: "done", ToolCallID: tcID, Name: "apply_code", Content: "Applied " + filePath + " successfully."}
		}

	default:
		return cloudToolResult{Status: "error", Error: "unknown tool: " + name}
	}
}
