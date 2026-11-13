package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// ---- node：目标机被控端（双击即用的那一个文件）----
//
// 零输入：内置默认 hub 地址与入网令牌，双击即连云端 -> 设备进入操作端「待允许」
// 列表 -> 有人点允许后 hub 推 pair-req，本机建立 WebRTC DC（或 hub 中继）执行命令/传文件。
// 断线自动重连；授权由 hub 持久化，重连免审。被允许前，本机对操作端只暴露指纹与主机名。

const (
	maxFile = 64 << 20 // 单文件传输上限
	// DC 帧是 JSON+base64：块体 24KB -> b64 约 32KB，整帧稳在 pion/浏览器
	// WebRTC DataChannel 64KB 默认单消息上限内（超了 node 侧会静默丢帧）。
	maxChunk = 24 * 1024
)

type putSess struct {
	fp   *os.File
	path string
	n    int64
}

type nodeAgent struct {
	conf map[string]string
	id   *identity

	cmu   sync.Mutex
	cn    *conn
	curFP string // 当前配对 ctl 的指纹

	sessMu sync.Mutex
	puts   map[string]*putSess           // put 接收会话：id -> 文件
	acks   map[string]chan struct{}      // get 发送会话：id -> 对端 ack
	runs   map[string]context.CancelFunc // 单次命令：id -> cancel
	tasks  map[string]context.CancelFunc // Agent 任务：task id -> cancel

	quit chan struct{}

	grantMu      sync.Mutex
	grantWaiters map[string]chan modelGrantReply

	// accepted 记录「帧已经收到、goroutine 还没登记取消」的 run（agent-loop /
	// agent-task）。abort 早于登记到达时只标记这里真实存在的一条，登记时立刻生效；
	// run 一旦登记或结束就清除。绝不记忆任意未知 ID（那会取消未来某个同 ID 的
	// run），也不靠 TTL 猜调度窗口。
	accepted map[string]*acceptedRun

	// hostSess 是宿主会话层（原生会话标识、控制队列、任务板、UI 等待、旁路命令）。
	// 模型循环、协议解析、重试与会话 journal 全部在共享核心，不在这里。
	hostSess *hostSession
}

// wsURL：hub 地址（http/https/ws/wss/host:port 都收）→ ws 信令端点
func wsURL(hub, role string) string {
	h := strings.TrimSpace(hub)
	switch {
	case strings.HasPrefix(h, "wss://"), strings.HasPrefix(h, "ws://"):
	case strings.HasPrefix(h, "https://"):
		h = "wss" + h[len("https"):]
	case strings.HasPrefix(h, "http://"):
		h = "ws" + h[len("http"):]
	default:
		h = "ws://" + h
	}
	h = strings.TrimRight(h, "/")
	if !strings.Contains(h[strings.Index(h, "://")+3:], "/") {
		h += "/ws"
	}
	return h + "?role=" + role
}

// 内置默认值：入网令牌只能以 node 身份上线，不能开控制台/下载中心，可随 exe 分发。
const (
	defaultHub   = "118.25.103.226"
	defaultToken = ""
)

func runNode(args []string) error {
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		switch args[0] {
		case "install":
			err := nodeServiceInstall(args[1:])
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		case "uninstall":
			return nodeServiceUninstall(args[1:])
		case "start":
			return nodeServiceStart(args[1:])
		case "stop":
			return nodeServiceStop(args[1:])
		case "status":
			return nodeServiceStatus(args[1:])
		case "autostart":
			err := nodeAutostart(args[1:])
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
	}
	if os.Getenv(daemonChildEnv) == "1" {
		return superviseNode()
	}
	hubFlag, tokFlag, daemon, dirFlag, err := parseRunFlags(args)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Fprint(os.Stderr, nodeUsage())
			return nil
		}
		return err
	}
	// 启动边界固定配置目录：入口、supervisor、worker 与开机启动都用这一个绝对路径。
	if err := applyConfigDirFlag(dirFlag); err != nil {
		return err
	}
	if daemon {
		if _, _, err := saveNodeEndpoint(hubFlag, tokFlag); err != nil {
			return err
		}
		return startBuiltInDaemon()
	}
	hub, tok, err := resolveNodeConfig(hubFlag, tokFlag)
	if err != nil {
		return err
	}
	if isWindowsService() {
		return runNodeAsService(hub, tok)
	}
	a, err := newNodeAgent(hub, tok)
	if err != nil {
		return err
	}
	fmt.Printf("handwave node %s  本机指纹 %s\n", versionStr, a.id.FP)
	fmt.Printf("已连云端 %s，等待操作端在网页点「允许」接入（无需任何操作）\n", hub)
	return a.loop()
}

func resolveNodeConfig(flagHub, flagTok string) (hub, tok string, err error) {
	conf := readConf("node.conf")
	hub = firstNonEmpty(flagHub, conf["hub"], os.Getenv("HW_HUB"), defaultHub)
	tok = firstNonEmpty(flagTok, conf["token"], os.Getenv("HW_TOKEN"), defaultToken)
	return hub, tok, nil
}

func newNodeAgent(hub, tok string) (*nodeAgent, error) {
	id, err := loadOrCreateIdentity(confDir())
	if err != nil {
		return nil, err
	}
	return &nodeAgent{
		conf:         map[string]string{"hub": hub, "token": tok},
		id:           id,
		puts:         map[string]*putSess{},
		acks:         map[string]chan struct{}{},
		runs:         map[string]context.CancelFunc{},
		tasks:        map[string]context.CancelFunc{},
		accepted:     map[string]*acceptedRun{},
		quit:         make(chan struct{}),
		grantWaiters: map[string]chan modelGrantReply{},
	}, nil
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v != "" {
			return v
		}
	}
	return ""
}

// loop：断线自动重连（指数退避，封顶 30s；连稳后重置）
func (a *nodeAgent) loop() error {
	back := time.Second
	for {
		start := time.Now()
		err := a.session()
		select {
		case <-a.quit:
			return nil
		default:
		}
		if time.Since(start) > 20*time.Second {
			back = time.Second
		}
		if err != nil {
			fmt.Printf("连接中断：%v（%s 后重连）\n", err, back)
		} else {
			fmt.Printf("连接结束（%s 后重连）\n", back)
		}
		timer := time.NewTimer(back)
		select {
		case <-a.quit:
			timer.Stop()
			return nil
		case <-timer.C:
		}
		if back < 30*time.Second {
			back *= 2
			if back > 30*time.Second {
				back = 30 * time.Second
			}
		}
	}
}

func (a *nodeAgent) session() error {
	cn := newConn(wsURL(a.conf["hub"], "node"), a.conf["token"], true)
	cn.nodeIdentity = a.id
	if err := cn.dial(detachCtx()); err != nil {
		cn.close()
		return err
	}
	a.cmu.Lock()
	a.cn = cn
	a.cmu.Unlock()
	defer func() {
		a.cancelAllRuns("session closed")
		a.cmu.Lock()
		a.cn = nil
		a.cmu.Unlock()
		cn.close()
	}()

	inPair := false
	for {
		select {
		case <-a.quit:
			return nil
		case e := <-cn.ev:
			switch e.Ctrl {
			case "pair-req":
				a.startPair(cn, string(e.Msg))
				inPair = true
			case "p2p-up":
				a.sendHello(cn)
				a.publishLoopBoard(cn)
				fmt.Println("P2P 直连成功")
			case "unpaired":
				if inPair {
					inPair = false
					a.cancelAllRuns("controller disconnected")
					cn.teardownPC()
					if len(e.Msg) > 0 {
						fmt.Printf("配对结束：%s\n", e.Msg)
					}
				}
			case "pair-fail":
				fmt.Printf("%s\n", e.Msg)
			case "model-grant":
				a.deliverModelGrant(e)
			case "ws-close":
				return fmt.Errorf("与 hub 断开")
			default: // DC 帧
				if !inPair || len(e.Msg) == 0 {
					continue
				}
				var f dcf
				if json.Unmarshal(e.Msg, &f) != nil {
					continue
				}
				a.onFrame(cn, &f)
			}
		}
	}
}

func (a *nodeAgent) startPair(cn *conn, ctlFP string) {
	a.curFP = ctlFP
	if ctlFP != "" {
		fmt.Printf("操作端 %s 已获授权，正在建立通道\n", ctlFP)
	}
	if cn.rel { // 中继模式：DC 事件不会来，立刻发 hello
		_ = a.sendHello(cn)
		a.publishLoopBoard(cn)
		return
	}
	if err := cn.startOffer(); err != nil {
		fmt.Printf("P2P 建立失败：%v\n", err)
	}
}

func (a *nodeAgent) sendHello(cn *conn) error {
	b, _ := json.Marshal(dcf{K: "node-hello", FP: a.id.FP, Info: selfHello()})
	return cn.sendMsg(b)
}

// onFrame：单一消费者路由，避免双 reader 抢事件通道
func (a *nodeAgent) onFrame(cn *conn, f *dcf) {
	switch f.K {
	case "exec":
		// 与 agent-loop 同口径：收到帧就同步登记「已接收、待启动」，早到的 cancel
		// 命中这条真实存在的登记，而不是被记成一个未知 ID 去取消未来的 run。
		if id := strings.TrimSpace(f.ID); id != "" && a.acceptRun(id) {
			go func() {
				defer a.finishAccepted(id)
				a.exec(cn, f)
			}()
			return
		}
		go a.exec(cn, f)
	case "agent-task":
		if f.Task == nil {
			a.out(cn, f.ID, nil, true, -1, "task required")
			return
		}
		// 取消登记用的 ID 必须在收到帧的这一刻就确定：提前到达的 abort 才能对上，
		// 而不是靠记住一个未知 ID。
		if strings.TrimSpace(f.Task.ID) == "" {
			f.Task.ID = f.ID
		}
		if raw, err := json.Marshal(f.Task); err != nil || len(raw) > maxNodeTaskFrame {
			a.out(cn, f.ID, nil, true, -1, "task payload too large")
			return
		}
		if !a.acceptRun(f.Task.ID) {
			if strings.TrimSpace(f.Task.ID) == "" {
				// 空 ID 由 runAgentTask 报 "task id required"，不在这里改语义。
				go a.runAgentTask(cn, f)
			} else {
				a.out(cn, f.Task.ID, nil, true, -1, "duplicate task id")
			}
			return
		}
		go func() {
			defer a.finishAccepted(f.Task.ID)
			a.runAgentTask(cn, f)
		}()
	case "agent-loop":
		// 收到帧就同步登记「已接收、待启动」，再 go 执行：随后到达的 abort 命中
		// 这条真实存在的登记，回合不启动引擎、也不申请访问码。
		id := strings.TrimSpace(f.ID)
		if id == "" {
			id = hexID()
			f.ID = id
		}
		if !a.acceptRun(id) {
			a.out(cn, id, nil, true, -1, "duplicate task id")
			return
		}
		go func() {
			defer a.finishAccepted(id)
			a.runLocalAgent(cn, f)
		}()
	case "agent-steer":
		// 入队先持久化再交给 Control；失败必须回到调用方，不能假装排队成功。
		if err := a.hostSession().steer(frameText(f)); err != nil {
			log.Printf("agent steer rejected: err=%v", err)
			a.out(cn, f.ID, nil, true, -1, err.Error())
		}
	case "agent-follow":
		if err := a.hostSession().followUp(frameText(f)); err != nil {
			log.Printf("agent follow-up rejected: err=%v", err)
			a.out(cn, f.ID, nil, true, -1, err.Error())
		}
	case "agent-abort":
		if !a.hostSession().abortRun(f.ID) {
			// 只取消 ID 与当前占用的回合一致的 run：未知 ID 或已经结束的旧 ID 绝不
			// 取消当前另一个 run 的回合（帧已收到、还没启动的 run 由 cancelRun 的
			// accepted 登记处理，这里绝不记忆未知 ID）。
			log.Printf("agent abort did not match the running turn: run=%q", strings.TrimSpace(f.ID))
		}
		a.cancelRun(cn, f.ID)
	case "agent-queue-recovery":
		// 旧 ID-less paused 队列的查看与显式处置：绝不自动重放、绝不按文本猜。
		a.handleQueueRecovery(cn, f)
	case "agent-bash":
		go a.runSideBash(cn, f)
	case "agent-bash-abort":
		if !a.hostSession().abortBash() {
			log.Printf("agent bash abort: nothing running")
		}
	case "agent-mode":
		mode := strings.TrimSpace(frameText(f))
		if err := a.hostSession().setInterruptMode(mode); err != nil {
			a.out(cn, f.ID, nil, true, -1, err.Error())
		}
	case "agent-ui":
		ok := f.Err == "" && f.Code == 0
		if !a.hostSession().resolveUI(f.ID, frameText(f), ok) {
			log.Printf("agent ui resolve missed: id=%s", f.ID)
		}
	case "cancel":
		a.cancelRun(cn, f.ID)
	case "get":
		go a.get(cn, f)
	case "put":
		a.beginPut(cn, f)
	case "chunk":
		a.chunkPut(cn, f)
	case "ack":
		a.sessMu.Lock()
		ch := a.acks[f.ID]
		a.sessMu.Unlock()
		if ch != nil {
			select {
			case ch <- struct{}{}:
			default:
			}
		}
	case "bye":
		cn.teardownPC()
		fmt.Println("操作端已结束配对")
	case "ping":
		b, _ := json.Marshal(dcf{K: "pong"})
		_ = cn.sendMsg(b)
	default:
		a.out(cn, f.ID, nil, true, -1, "未知帧类型: "+f.K)
	}
}

func (a *nodeAgent) out(cn *conn, id string, raw []byte, done bool, code int, errMsg string) {
	if cn == nil {
		return
	}
	f := dcf{K: "out", ID: id, Done: done, Code: code, Err: errMsg}
	if len(raw) > 0 {
		f.B64 = b64(raw)
	}
	b, _ := json.Marshal(f)
	_ = cn.sendMsg(b)
}

func shellOf(line string) *exec.Cmd {
	var c *exec.Cmd
	if runtime.GOOS == "windows" {
		c = exec.Command("cmd.exe", "/c", line)
	} else {
		c = exec.Command("/bin/sh", "-c", line)
	}
	c.SysProcAttr = sysProcAttr()
	return c
}

// streamWriter：子进程输出按 ≤maxChunk 分块推 DC（满块或 >200ms 即刷）
type streamWriter struct {
	a       *nodeAgent
	cn      *conn
	sid     string
	mu      sync.Mutex
	pending []byte
	last    time.Time
	onData  func([]byte)
}

func (w *streamWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	w.pending = append(w.pending, p...)
	if len(w.pending) >= maxChunk || time.Since(w.last) > 200*time.Millisecond {
		w.flushLocked()
	}
	w.mu.Unlock()
	return len(p), nil
}

func (w *streamWriter) flushLocked() {
	for len(w.pending) > 0 {
		n := min(maxChunk, len(w.pending))
		chunk := append([]byte(nil), w.pending[:n]...)
		if w.onData != nil {
			w.onData(chunk)
		} else {
			w.a.out(w.cn, w.sid, chunk, false, 0, "")
		}
		w.pending = w.pending[n:]
		w.last = time.Now()
	}
}

func (w *streamWriter) flush() {
	w.mu.Lock()
	w.flushLocked()
	w.mu.Unlock()
}

func (a *nodeAgent) exec(cn *conn, f *dcf) {
	ctx, cancel := context.WithCancel(context.Background())
	if !a.registerRun(f.ID, cancel, false) {
		cancel()
		a.out(cn, f.ID, nil, true, -1, "duplicate task id")
		return
	}
	defer func() {
		cancel()
		a.unregisterRun(f.ID, false)
	}()
	code, errMsg := a.execCommand(ctx, cn, f.ID, f.Cmd, f.Cwd, f.Timeout, f.Enc, func(raw []byte) {
		a.out(cn, f.ID, raw, false, 0, "")
	})
	a.out(cn, f.ID, nil, true, code, errMsg)
}

// acceptedRun 是一条已经收到帧、还没登记取消的 run。
type acceptedRun struct {
	// aborted 表示中止帧早于登记到达：登记时立刻取消，这一回合不启动。
	aborted bool
}

// acceptRun 在收到帧的同一把锁下登记「已接收、待启动」的 run id；重复 ID 返回
// false。登记的只有真实收到过的帧，所以它不会取消未来某个同 ID 的 run。
func (a *nodeAgent) acceptRun(id string) bool {
	if strings.TrimSpace(id) == "" {
		return false
	}
	a.sessMu.Lock()
	defer a.sessMu.Unlock()
	if a.accepted == nil {
		a.accepted = map[string]*acceptedRun{}
	}
	if _, exists := a.accepted[id]; exists {
		return false
	}
	if _, exists := a.tasks[id]; exists {
		return false
	}
	a.accepted[id] = &acceptedRun{}
	return true
}

// abortAccepted 标记一条已接收但还没启动的 run，让它在登记时立刻取消。未知 ID
// 返回 false：绝不把它记下来去取消未来的 run。
func (a *nodeAgent) abortAccepted(id string) bool {
	a.sessMu.Lock()
	defer a.sessMu.Unlock()
	rec := a.accepted[id]
	if rec == nil {
		return false
	}
	rec.aborted = true
	return true
}

// finishAccepted 清除登记：run 已经登记进 tasks、已经结束，或者根本没启动。
func (a *nodeAgent) finishAccepted(id string) {
	a.sessMu.Lock()
	delete(a.accepted, id)
	a.sessMu.Unlock()
}

func (a *nodeAgent) registerRun(id string, cancel context.CancelFunc, task bool) bool {
	if id == "" {
		return false
	}
	a.sessMu.Lock()
	defer a.sessMu.Unlock()
	m := a.runs
	if task {
		m = a.tasks
	}
	if _, exists := m[id]; exists {
		return false
	}
	m[id] = cancel
	// 中止帧早于本 goroutine 的登记到达：在同一把锁下立刻生效，这一回合不启动。
	if rec := a.accepted[id]; rec != nil {
		delete(a.accepted, id)
		if rec.aborted {
			cancel()
		}
	}
	return true
}

func (a *nodeAgent) unregisterRun(id string, task bool) {
	a.sessMu.Lock()
	if task {
		delete(a.tasks, id)
	} else {
		delete(a.runs, id)
	}
	a.sessMu.Unlock()
}

func (a *nodeAgent) cancelAllRuns(reason string) {
	a.sessMu.Lock()
	cancels := make([]context.CancelFunc, 0, len(a.tasks)+len(a.runs))
	for _, cancel := range a.tasks {
		cancels = append(cancels, cancel)
	}
	for _, cancel := range a.runs {
		cancels = append(cancels, cancel)
	}
	// 已接收但还没启动的 run 也属于这个控制端：标记为已取消，登记时立刻生效。
	accepted := 0
	for _, rec := range a.accepted {
		rec.aborted = true
		accepted++
	}
	a.sessMu.Unlock()
	if accepted > 0 {
		log.Printf("node runs abort accepted: count=%d reason=%s", accepted, reason)
	}
	if len(cancels) == 0 {
		return
	}
	log.Printf("node runs cancel all: count=%d reason=%s controller=%s", len(cancels), reason, a.curFP)
	for _, cancel := range cancels {
		cancel()
	}
}

func (a *nodeAgent) cancelRun(cn *conn, id string) {
	a.sessMu.Lock()
	cancel := a.tasks[id]
	if cancel == nil {
		cancel = a.runs[id]
	}
	a.sessMu.Unlock()
	if cancel == nil {
		// 帧已经收到、goroutine 还没登记取消：标记这条真实的待启动 run，登记时
		// 立刻取消。未知 ID 不记忆——那会取消未来某个同 ID 的 run。
		if a.abortAccepted(id) {
			log.Printf("node task abort before start: task=%s controller=%s", id, a.curFP)
		}
		a.out(cn, id, nil, true, -1, "task not running")
		return
	}
	log.Printf("node task cancel: task=%s controller=%s", id, a.curFP)
	cancel()
}

func (a *nodeAgent) execCommand(ctx context.Context, cn *conn, id, line, cwd string, timeoutSeconds int, encName string, onData func([]byte)) (int, string) {
	timeout := 5 * time.Minute
	if timeoutSeconds > 0 {
		timeout = time.Duration(timeoutSeconds) * time.Second
	}
	if timeout > 10*time.Minute {
		timeout = 10 * time.Minute
	}
	cmd := shellOf(line)
	if encName == "utf8" && runtime.GOOS == "windows" {
		cmd = shellOf("(chcp 65001>nul) >nul 2>nul & (" + line + ")")
	}
	if cwd != "" {
		cmd.Dir = cwd
	}
	w := &streamWriter{a: a, cn: cn, sid: id, last: time.Now(), onData: onData}
	cmd.Stdout = w
	cmd.Stderr = w
	log.Printf("node exec start: task=%s controller=%s cwd=%q timeout=%s command_bytes=%d", id, a.curFP, cwd, timeout, len(line))
	if err := cmd.Start(); err != nil {
		msg := "start failed: " + err.Error()
		onData([]byte(msg))
		log.Printf("node exec failed: task=%s error=%T: %v", id, err, err)
		return -1, err.Error()
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	to := time.NewTimer(timeout)
	defer to.Stop()
	for {
		select {
		case err := <-done:
			w.flush()
			code := 0
			if err != nil {
				if ee, ok := err.(*exec.ExitError); ok {
					code = ee.ExitCode()
				} else {
					code = -1
				}
			}
			log.Printf("node exec finish: task=%s controller=%s code=%d", id, a.curFP, code)
			return code, ""
		case <-ctx.Done():
			killTree(cmd)
			w.flush()
			log.Printf("node exec canceled: task=%s controller=%s error=%T: %v", id, a.curFP, ctx.Err(), ctx.Err())
			return -1, "canceled"
		case <-to.C:
			killTree(cmd)
			w.flush()
			onData([]byte("command timed out\n"))
			log.Printf("node exec timeout: task=%s controller=%s timeout=%s", id, a.curFP, timeout)
			return -1, "timeout"
		case <-tick.C:
			w.flush()
		}
	}
}

// ---- put：ctl 推文件到本机（node 逐块 ack 流控）----

func (a *nodeAgent) beginPut(cn *conn, f *dcf) {
	if f.Size > maxFile {
		a.out(cn, f.ID, nil, true, -1, fmt.Sprintf("文件过大（>64MB）"))
		return
	}
	path, err := expandPath(f.Path)
	if err != nil {
		a.out(cn, f.ID, nil, true, -1, err.Error())
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		a.out(cn, f.ID, nil, true, -1, err.Error())
		return
	}
	fp, err := os.Create(path + ".part")
	if err != nil {
		a.out(cn, f.ID, nil, true, -1, err.Error())
		return
	}
	a.sessMu.Lock()
	a.puts[f.ID] = &putSess{fp: fp, path: path}
	a.sessMu.Unlock()
	a.out(cn, f.ID, nil, false, 0, "") // 就绪信号（done:false 空块）
}

func (a *nodeAgent) chunkPut(cn *conn, f *dcf) {
	a.sessMu.Lock()
	s := a.puts[f.ID]
	a.sessMu.Unlock()
	if s == nil {
		a.out(cn, f.ID, nil, true, -1, "未知上传会话")
		return
	}
	raw := unb64(f.B64)
	if _, err := s.fp.Write(raw); err != nil {
		s.fp.Close()
		a.sessMu.Lock()
		delete(a.puts, f.ID)
		a.sessMu.Unlock()
		a.out(cn, f.ID, nil, true, -1, err.Error())
		return
	}
	s.n += int64(len(raw))
	if f.Done {
		s.fp.Close()
		if err := os.Rename(s.path+".part", s.path); err != nil {
			a.sessMu.Lock()
			delete(a.puts, f.ID)
			a.sessMu.Unlock()
			a.out(cn, f.ID, nil, true, -1, err.Error())
			return
		}
		a.sessMu.Lock()
		delete(a.puts, f.ID)
		a.sessMu.Unlock()
		a.out(cn, f.ID, []byte(fmt.Sprintf("已写入 %s（%d 字节）", s.path, s.n)), true, 0, "")
		return
	}
	b, _ := json.Marshal(dcf{K: "ack", ID: f.ID})
	_ = cn.sendMsg(b)
}

// ---- get：本机文件推给 ctl（逐块等 ack）----

func (a *nodeAgent) get(cn *conn, f *dcf) {
	path, err := expandPath(f.Path)
	if err != nil {
		a.out(cn, f.ID, nil, true, -1, err.Error())
		return
	}
	st, err := os.Stat(path)
	if err != nil {
		a.out(cn, f.ID, nil, true, -1, err.Error())
		return
	}
	if st.Size() > maxFile {
		a.out(cn, f.ID, nil, true, -1, fmt.Sprintf("文件过大（>64MB）"))
		return
	}
	fp, err := os.Open(path)
	if err != nil {
		a.out(cn, f.ID, nil, true, -1, err.Error())
		return
	}
	defer fp.Close()
	ack := make(chan struct{}, 1)
	a.sessMu.Lock()
	a.acks[f.ID] = ack
	a.sessMu.Unlock()
	defer func() {
		a.sessMu.Lock()
		delete(a.acks, f.ID)
		a.sessMu.Unlock()
	}()
	buf := make([]byte, maxChunk)
	for {
		nr, rerr := fp.Read(buf)
		if nr > 0 {
			a.out(cn, f.ID, buf[:nr], false, 0, "")
			select {
			case <-ack:
			case <-time.After(30 * time.Second):
				a.out(cn, f.ID, nil, true, -1, "对端无响应（ack 超时）")
				return
			}
		}
		if rerr == io.EOF {
			a.out(cn, f.ID, nil, true, 0, "")
			return
		}
		if rerr != nil {
			a.out(cn, f.ID, nil, true, -1, rerr.Error())
			return
		}
	}
}

func expandPath(p string) (string, error) {
	if p == "" {
		return "", fmt.Errorf("空路径")
	}
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		h, err := os.UserHomeDir()
		if err == nil {
			return filepath.Join(h, filepath.FromSlash(strings.TrimPrefix(strings.TrimPrefix(p, "~"), "/"))), nil
		}
	}
	return filepath.Clean(p), nil
}
