package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---- ctl：操作端。审批接入一次 -> 交互式会话（等价 ssh 体验）----
//
//	handwave pair          已授权设备上线即由 hub 自动配对（免码免确认）
//	handwave pair          首次：列出待允许设备，选号 -> 点允许（可带失效时间）
//	handwave pair -dev <指纹前缀> [-ttl 秒]   非交互批准并接入（脚本用）
//	会话内直接输命令；:get/:put 传文件；:exit 结束（授权保留，下次免审）
//	handwave status        列出 hub 上的设备与授权状态

type outSess struct {
	w     io.Writer
	file  *os.File // get：写 .part 完成后改名
	tmp   string
	final string
	ack   bool
	n     int64
	ready chan struct{} // put：等 node 就绪
	done  chan *dcf     // 终帧（done:true）
}

type ctlAgent struct {
	cn *conn
	id *identity

	mu   sync.Mutex
	sess map[string]*outSess

	pairedCh chan struct{}
	failCh   chan string
	helloCh  chan dcf
	dropCh   chan string
	statusCh chan []byte
}

// parseMix 支持 flag 与位置参数混排：handwave pair -dev ABC -ttl 60 == -dev ABC -ttl 60
func parseMix(fs *flag.FlagSet, args []string) []string {
	var pos []string
	for {
		_ = fs.Parse(args)
		rest := fs.Args()
		if len(rest) == 0 {
			return pos
		}
		pos = append(pos, rest[0])
		args = rest[1:]
	}
}

func (ca *ctlAgent) newSess(id string, s *outSess) {
	ca.mu.Lock()
	ca.sess[id] = s
	ca.mu.Unlock()
}

func (ca *ctlAgent) dropSess(id string) {
	ca.mu.Lock()
	delete(ca.sess, id)
	ca.mu.Unlock()
}

func (ca *ctlAgent) sessOf(id string) *outSess {
	ca.mu.Lock()
	defer ca.mu.Unlock()
	return ca.sess[id]
}

// devRow 对应 hub status JSON 的一项（与 hub.go devStatus 字段一致）
type devRow struct {
	NID      string `json:"nid"`
	State    string `json:"state"`
	FP       string `json:"fp"`
	Hostname string `json:"hostname"`
	User     string `json:"user"`
	OS       string `json:"os"`
	Arch     string `json:"arch"`
	Seen     string `json:"seen"`
	Exp      string `json:"exp"`
	By       string `json:"by"`
	Name     string `json:"name"` // 别名（hub 持久化，独立于授权）
}

// disp 返回展示名：优先别名，其次主机名，最后指纹前缀
func (r devRow) disp() string {
	if r.Name != "" {
		return r.Name
	}
	if r.Hostname != "" {
		return r.Hostname
	}
	if len(r.FP) >= 6 {
		return r.FP[:6]
	}
	return r.FP
}

func runPair(args []string) error {
	fs := flag.NewFlagSet("pair", flag.ExitOnError)
	hubF := fs.String("hub", "", "hub 地址")
	tokF := fs.String("token", "", "hub 访问令牌（根令牌）")
	relayF := fs.Bool("relay", false, "强制走 hub 中继（不尝试 P2P 打洞）")
	devF := fs.String("dev", "", "非交互：按设备指纹前缀批准并接入（脚本用）")
	ttlF := fs.Int64("ttl", 0, "授权有效秒数（0=永久；配合 -dev 或交互选择）")
	cmdF := fs.String("c", "", "非交互：执行一条命令后退出（远程输出打到 stdout）")
	pos := parseMix(fs, args)
	conf := readConf("ctl.conf")

	hub := firstNonEmpty(*hubF, conf["hub"], os.Getenv("HW_HUB"))
	tok := firstNonEmpty(*tokF, conf["token"], os.Getenv("HW_TOKEN"))
	if hub == "" || tok == "" {
		return fmt.Errorf("未配置 hub/token：-hub/-token 参数、环境变量 HW_HUB/HW_TOKEN、或 ctl.conf（hub=... token=...）")
	}
	if len(pos) > 0 {
		fmt.Fprintf(os.Stderr, "提示：已改为审批制，配对码作废；直接 handwave pair 选择设备即可\n")
	}

	id, err := loadOrCreateIdentity(confDir(), "ctl.key")
	if err != nil {
		return err
	}
	cn := newConn(wsURL(hub, "ctl"), tok, false)
	cn.rel = *relayF
	if err := cn.dial(detachCtx()); err != nil {
		cn.close()
		return fmt.Errorf("连接 hub 失败：%w", err)
	}
	defer cn.close()

	ca := &ctlAgent{
		cn: cn, id: id,
		sess:     map[string]*outSess{},
		pairedCh: make(chan struct{}, 1),
		failCh:   make(chan string, 1),
		helloCh:  make(chan dcf, 1),
		dropCh:   make(chan string, 4),
		statusCh: make(chan []byte, 4),
	}
	go ca.pump()

	// hello：带自身指纹；hub 若发现已授权设备在线即自动配对
	if err := cn.sendSig(&sig{K: "hello", FP: id.FP, Relay: *relayF}); err != nil {
		return err
	}

	// 自动配对可能已发生：先短等 paired；未中则拉设备表走审批
	var rows []devRow
	autoPaired := false
	select {
	case <-ca.pairedCh:
		autoPaired = true
	case msg := <-ca.dropCh:
		return fmt.Errorf("hub 连接断开：%s", msg)
	case <-time.After(2 * time.Second):
	}

	if !autoPaired {
		// hub 会因状态变化主动推 status，这里请求一次兜底
		if err := cn.sendSig(&sig{K: "status"}); err != nil {
			return err
		}
		select {
		case b := <-ca.statusCh:
			_ = json.Unmarshal(b, &rows)
		case <-ca.pairedCh: // 竞态：期间自动配对成功
			autoPaired = true
		case msg := <-ca.failCh:
			return fmt.Errorf("%s", msg)
		case msg := <-ca.dropCh:
			return fmt.Errorf("hub 连接断开：%s", msg)
		case <-time.After(8 * time.Second):
			return fmt.Errorf("hub 无响应（检查 hub 地址 / token / 网络）")
		}
	}

	if !autoPaired {
		target := pickDevice(rows, *devF, id.FP)
		if target == nil {
			return fmt.Errorf("没有可接入的设备（待允许/已授权在线设备为空）。目标机需先运行 handwave node")
		}
		needsApprove := target.State == "pending" || target.State == "approved-offline" ||
			(target.State == "approved" && target.By != id.FP)
		if needsApprove {
			if *devF == "" {
				fmt.Printf("允许设备 %s（%s@%s）接入？有效期秒数（0=永久）：", target.FP, target.User, target.Hostname)
				var ans string
				sc := bufio.NewScanner(os.Stdin)
				if sc.Scan() {
					ans = strings.TrimSpace(sc.Text())
				}
				if ans == "" || strings.EqualFold(ans, "n") {
					return fmt.Errorf("已取消")
				}
				if v, cerr := strconv.ParseInt(ans, 10, 64); cerr == nil && v > 0 {
					*ttlF = v
				}
			}
			if err := cn.sendSig(&sig{K: "approve", NID: target.NID, FP: target.FP, TTL: *ttlF, Relay: *relayF}); err != nil {
				return err
			}
			fmt.Printf("已允许 %s（%s），等待通道建立…\n", target.Hostname, target.FP)
		} else {
			fmt.Printf("设备 %s（%s）已授权，等待通道建立…\n", target.Hostname, target.FP)
		}
		select {
		case <-ca.pairedCh:
		case msg := <-ca.failCh:
			return fmt.Errorf("接入失败：%s", msg)
		case msg := <-ca.dropCh:
			return fmt.Errorf("hub 连接断开：%s", msg)
		case <-time.After(25 * time.Second):
			return fmt.Errorf("25 秒内未建立配对（设备可能离线或正被占用）")
		}
	}

	fmt.Println("已配对，等待目标机建立通道…")

	// 等 node-hello（P2P 打洞或 hub 中继由 conn 层自动处理）
	var nh dcf
	select {
	case nh = <-ca.helloCh:
	case msg := <-ca.failCh:
		return fmt.Errorf("通道建立失败：%s", msg)
	case msg := <-ca.dropCh:
		return fmt.Errorf("配对中断：%s", msg)
	case <-time.After(60 * time.Second):
		return fmt.Errorf("目标机 60 秒无响应（若网络限制 WebRTC，试 handwave pair -relay）")
	}

	info := nh.Info
	if info == nil {
		info = &Hello{}
	}
	fmt.Printf("已连接：%s@%s（%s/%s，node %s）设备指纹 %s\n",
		info.User, info.Hostname, info.OS, info.Arch, info.Version, nh.FP)

	if *cmdF != "" {
		return ca.execPrint(*cmdF)
	}
	return ca.shell()
}

// pickDevice：-dev 给了前缀就非交互匹配；否则交互列出可接入设备选号。
// 可接入 = pending（在线待允许）、approved（已授权：by==selfFP 自动配对；否则需重新批准）、
// approved-offline（需先批准，等上线）、paired 且授权方是本机（重接）。
// selectDevice 让用户从全部设备中挑一个（含已屏蔽/离线），供 rename / remove 用。
// 与 pickDevice 不同：不筛状态、不打印「接入」字样。
func selectDevice(rows []devRow, devPrefix string) *devRow {
	sorted := append([]devRow(nil), rows...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].FP < sorted[j].FP })
	if devPrefix != "" {
		for i := range sorted {
			if strings.HasPrefix(strings.ToUpper(sorted[i].FP), strings.ToUpper(devPrefix)) {
				return &sorted[i]
			}
		}
		fmt.Fprintf(os.Stderr, "没有指纹前缀 %s 的设备\n", devPrefix)
		return nil
	}
	if len(sorted) == 1 {
		return &sorted[0]
	}
	fmt.Println("可选设备：")
	fmt.Printf("%-4s %-16s %-22s %-14s %s\n", "序号", "状态", "设备", "指纹", "别名")
	for i, r := range sorted {
		fmt.Printf("%-5d %-15s %-23s %-14s %s\n", i+1, r.State, trunc(r.disp(), 21), r.FP,
			map[bool]string{true: "(有)", false: "-"}[r.Name != ""])
	}
	fmt.Print("输入序号：")
	sc := bufio.NewScanner(os.Stdin)
	if !sc.Scan() {
		return nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(sc.Text()))
	if err != nil || n < 1 || n > len(sorted) {
		return nil
	}
	return &sorted[n-1]
}

func pickDevice(rows []devRow, devPrefix, selfFP string) *devRow {
	var ok []devRow
	for i := range rows {
		r := rows[i]
		switch r.State {
		case "pending", "approved", "approved-offline", "paired":
			ok = append(ok, r)
		}
	}
	sort.SliceStable(ok, func(i, j int) bool { return ok[i].FP < ok[j].FP })
	if devPrefix != "" {
		for i := range ok {
			if strings.HasPrefix(strings.ToUpper(ok[i].FP), strings.ToUpper(devPrefix)) {
				return &ok[i]
			}
		}
		fmt.Fprintf(os.Stderr, "没有指纹前缀 %s 的可接入设备\n", devPrefix)
		return nil
	}
	if len(ok) == 0 {
		return nil
	}
	if len(ok) == 1 && ok[0].State != "pending" {
		return &ok[0] // 唯一已授权设备：直接接入
	}
	fmt.Println("可选设备：")
	fmt.Printf("%-4s %-16s %-24s %-14s %s\n", "序号", "状态", "设备", "指纹", "备注")
	for i, r := range ok {
		host := r.disp()
		exp := ""
		if r.Exp != "" {
			exp = "失效 " + r.Exp
		}
		fmt.Printf("%-5d %-15s %-25s %-14s %s\n", i+1, r.State, host, r.FP, exp)
	}
	fmt.Print("输入序号接入：")
	sc := bufio.NewScanner(os.Stdin)
	if !sc.Scan() {
		return nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(sc.Text()))
	if err != nil || n < 1 || n > len(ok) {
		return nil
	}
	return &ok[n-1]
}

// ---- 帧路由 ----

func (ca *ctlAgent) pump() {
	for e := range ca.cn.ev {
		switch e.Ctrl {
		case "paired":
			ca.signal(ca.pairedCh, struct{}{})
		case "pair-fail":
			ca.pushFail(string(e.Msg))
		case "unpaired":
			msg := "对端或 hub 结束配对"
			if len(e.Msg) > 0 {
				msg += "：" + string(e.Msg)
			}
			ca.pushDrop(msg)
		case "status":
			select {
			case ca.statusCh <- append([]byte(nil), e.Msg...):
			default:
			}
		case "ws-close":
			ca.pushDrop("hub 连接断开")
		case "": // DC 帧
			var f dcf
			if json.Unmarshal(e.Msg, &f) != nil {
				continue
			}
			ca.route(&f)
		}
	}
	ca.pushDrop("连接已关闭")
}

func (ca *ctlAgent) signal(ch chan struct{}, v struct{}) {
	select {
	case ch <- v:
	default:
	}
}

func (ca *ctlAgent) pushFail(msg string) {
	select {
	case ca.failCh <- msg:
	default:
	}
}

func (ca *ctlAgent) pushDrop(msg string) {
	select {
	case ca.dropCh <- msg:
	default:
	}
	// 打断所有进行中的会话
	ca.mu.Lock()
	for _, s := range ca.sess {
		if s.done != nil {
			select {
			case s.done <- &dcf{Err: msg}:
			default:
			}
		}
	}
	ca.mu.Unlock()
}

func (ca *ctlAgent) route(f *dcf) {
	switch f.K {
	case "node-hello":
		select {
		case ca.helloCh <- *f:
		default:
		}
	case "pong":
		fmt.Println("pong")
	case "out":
		s := ca.sessOf(f.ID)
		if s == nil {
			return
		}
		// 就绪信号（put）：done:false 空 out -> 向 ready 发一枚信号
		if !f.Done && f.B64 == "" {
			select {
			case s.ready <- struct{}{}:
			default:
			}
			return
		}
		if len(f.B64) > 0 {
			raw := unb64(f.B64)
			if _, err := s.w.Write(raw); err != nil {
				s.finish(f)
				return
			}
			s.n += int64(len(raw))
		}
		if s.ack && !f.Done {
			ca.sendAck(f.ID)
		}
		if f.Done {
			s.finish(f)
		}
	case "ack":
		s := ca.sessOf(f.ID)
		if s != nil {
			select {
			case s.ready <- struct{}{}:
			default:
			}
		}
	default:
	}
}

// finish 把终帧投给会话的 done 通道（done 缓冲为 1）
func (s *outSess) finish(f *dcf) {
	if s.file != nil {
		s.file.Close()
		s.file = nil
	}
	select {
	case s.done <- f:
	default:
	}
}

func (ca *ctlAgent) sendAck(id string) {
	b, _ := json.Marshal(dcf{K: "ack", ID: id})
	_ = ca.cn.sendMsg(b)
}

func (ca *ctlAgent) sendBye(why string) {
	b, _ := json.Marshal(dcf{K: "bye", Msg: why})
	_ = ca.cn.sendMsg(b)
	_ = ca.cn.sendSig(&sig{K: "bye"})
}

// ---- 会话原语 ----

func (ca *ctlAgent) execPrint(line string) error {
	id := hexID()
	s := &outSess{w: os.Stdout, done: make(chan *dcf, 1), ready: make(chan struct{}, 1)}
	ca.newSess(id, s)
	defer ca.dropSess(id)
	b, _ := json.Marshal(dcf{K: "exec", ID: id, Cmd: line, Timeout: 300})
	if err := ca.cn.sendMsg(b); err != nil {
		return err
	}
	select {
	case f := <-s.done:
		if f.Err != "" {
			return fmt.Errorf("%s (exit %d)", f.Err, f.Code)
		}
		return nil
	case msg := <-ca.dropCh:
		return fmt.Errorf("会话中断：%s", msg)
	case <-time.After(10 * time.Minute):
		return fmt.Errorf("命令超时")
	}
}

// shell：交互式 REPL
func (ca *ctlAgent) shell() error {
	fmt.Println("会话就绪：直接输入远程命令")
	fmt.Println("  :get <远端路径> [本地名]   :put <本地路径> [远端名]   :ping   :exit")
	sc := bufio.NewScanner(os.Stdin)
	for {
		fmt.Print("hw> ")
		if !sc.Scan() {
			ca.sendBye("eof")
			return nil
		}
		line := strings.TrimSpace(sc.Text())
		switch {
		case line == "":
		case line == ":exit" || line == ":bye" || line == ":quit":
			ca.sendBye("exit")
			return nil
		case line == ":ping":
			b, _ := json.Marshal(dcf{K: "ping"})
			if err := ca.cn.sendMsg(b); err != nil {
				fmt.Println("发送失败:", err)
			}
		case strings.HasPrefix(line, ":get "):
			rest := strings.Fields(line[5:])
			if len(rest) == 0 {
				fmt.Println("用法 :get <远端路径> [本地路径]")
				continue
			}
			local := filepath.Base(strings.ReplaceAll(rest[0], `\`, `/`))
			if len(rest) > 1 {
				local = rest[1]
			}
			if err := ca.get(rest[0], local); err != nil {
				fmt.Println("下载失败:", err)
			}
		case strings.HasPrefix(line, ":put "):
			rest := strings.Fields(line[5:])
			if len(rest) == 0 {
				fmt.Println("用法 :put <本地路径> [远端路径]")
				continue
			}
			remote := filepath.Base(rest[0])
			if len(rest) > 1 {
				remote = rest[1]
			}
			if err := ca.put(rest[0], remote); err != nil {
				fmt.Println("上传失败:", err)
			}
		default:
			if err := ca.execPrint(line); err != nil {
				fmt.Println("执行失败:", err)
			}
		}
		select {
		case msg := <-ca.dropCh:
			return fmt.Errorf("配对已结束：%s", msg)
		default:
		}
	}
}

func (ca *ctlAgent) get(remote, local string) error {
	id := hexID()
	tmp := local + ".part"
	fp, err := os.Create(tmp)
	if err != nil {
		return err
	}
	s := &outSess{w: fp, file: fp, tmp: tmp, final: local, ack: true, done: make(chan *dcf, 1), ready: make(chan struct{}, 1)}
	ca.newSess(id, s)
	defer func() {
		ca.dropSess(id)
		if s.file != nil {
			s.file.Close()
		}
	}()
	b, _ := json.Marshal(dcf{K: "get", ID: id, Path: remote})
	if err := ca.cn.sendMsg(b); err != nil {
		return err
	}
	fmt.Printf("下载 %s -> %s …\n", remote, local)
	select {
	case f := <-s.done:
		if s.file != nil {
			s.file.Close()
			s.file = nil
		}
		if f.Err != "" {
			os.Remove(tmp)
			return fmt.Errorf("%s", f.Err)
		}
		if err := os.Rename(tmp, local); err != nil {
			return err
		}
		fmt.Printf("完成：%s（%s）\n", local, human(s.n))
		return nil
	case msg := <-ca.dropCh:
		os.Remove(tmp)
		return fmt.Errorf("会话中断：%s", msg)
	case <-time.After(10 * time.Minute):
		os.Remove(tmp)
		return fmt.Errorf("下载超时")
	}
}

func (ca *ctlAgent) put(local, remote string) error {
	st, err := os.Stat(local)
	if err != nil {
		return err
	}
	if st.Size() > maxFile {
		return fmt.Errorf("文件过大（>64MB）")
	}
	fp, err := os.Open(local)
	if err != nil {
		return err
	}
	defer fp.Close()
	id := hexID()
	s := &outSess{w: io.Discard, done: make(chan *dcf, 1), ready: make(chan struct{}, 2)}
	ca.newSess(id, s)
	defer ca.dropSess(id)
	b, _ := json.Marshal(dcf{K: "put", ID: id, Path: remote, Size: st.Size()})
	if err := ca.cn.sendMsg(b); err != nil {
		return err
	}
	// 等就绪：node 回 done:false 空 out（route 里 close(s.ready)）
	select {
	case <-s.ready:
	case f := <-s.done:
		return fmt.Errorf("远端拒绝：%s", firstNonEmpty(f.Err, "未知原因"))
	case msg := <-ca.dropCh:
		return fmt.Errorf("会话中断：%s", msg)
	case <-time.After(15 * time.Second):
		return fmt.Errorf("远端无响应")
	}
	fmt.Printf("上传 %s -> %s（%s）…\n", local, remote, human(st.Size()))
	buf := make([]byte, maxChunk)
	for {
		nr, rerr := fp.Read(buf)
		if rerr != nil && rerr != io.EOF {
			return rerr
		}
		last := rerr == io.EOF || nr == 0
		cb, _ := json.Marshal(dcf{K: "chunk", ID: id, B64: b64(buf[:nr]), Done: last})
		if err := ca.cn.sendMsg(cb); err != nil {
			return err
		}
		if last {
			break
		}
		// 等 node 的 ack（route 的 ack 分支向 ready 发信号）
		select {
		case <-s.ready:
		case msg := <-ca.dropCh:
			return fmt.Errorf("会话中断：%s", msg)
		case <-time.After(30 * time.Second):
			return fmt.Errorf("远端 ack 超时")
		}
	}
	select {
	case f := <-s.done:
		if f.Err != "" {
			return fmt.Errorf("%s", f.Err)
		}
		if len(f.B64) > 0 {
			fmt.Printf("%s\n", string(unb64(f.B64)))
		}
		return nil
	case msg := <-ca.dropCh:
		return fmt.Errorf("会话中断：%s", msg)
	case <-time.After(10 * time.Minute):
		return fmt.Errorf("上传超时")
	}
}

// ---- status ----

// batchTTL 批量 approve 使用的失效秒数（由 -ttl 设置，0=永久）。
var batchTTL int64

// runDeviceOp 实现 rename / remove / approve / deny：按指纹前缀定位设备后下发对应信令。
func runDeviceOp(cmd string, args []string) error {
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	hubF := fs.String("hub", "", "hub 地址")
	tokF := fs.String("token", "", "hub 访问令牌")
	devF := fs.String("dev", "", "设备指纹前缀（留空则交互选择）")
	nameF := fs.String("name", "", "新别名（rename 用；空串=清除别名）")
	ttlF := fs.Int64("ttl", 0, "批量 approve：授权有效秒数（0=永久）")
	allF := fs.Bool("all", false, "对所有可操作设备执行（批量）")
	stF := fs.String("state", "", "配合 -all：只作用于该状态的设备（如 pending）")
	_ = fs.Parse(args)

	conf := readConf("ctl.conf")
	hub := firstNonEmpty(*hubF, conf["hub"], os.Getenv("HW_HUB"))
	tok := firstNonEmpty(*tokF, conf["token"], os.Getenv("HW_TOKEN"))
	if hub == "" || tok == "" {
		return fmt.Errorf("未配置 hub/token（ctl.conf / 环境变量 HW_HUB/HW_TOKEN / -hub -token）")
	}

	// CLI 未走 hello，hub 侧不知道本端指纹 —— 批量授权要记「谁允许的」，
	// 故在此加载身份并随请求自报。
	id, err := loadOrCreateIdentity(confDir(), "ctl.key")
	if err != nil {
		return err
	}
	selfFP := ""
	if id != nil {
		selfFP = id.FP
	}

	cn := newConn(wsURL(hub, "ctl"), tok, false)
	if err := cn.dial(detachCtx()); err != nil {
		cn.close()
		return err
	}
	defer cn.close()
	if err := cn.sendSig(&sig{K: "status"}); err != nil {
		return err
	}

	var rows []devRow
	deadline := time.After(10 * time.Second)
	for rows == nil {
		select {
		case e := <-cn.ev:
			if e.Ctrl == "status" {
				_ = json.Unmarshal(e.Msg, &rows)
			}
		case <-deadline:
			return fmt.Errorf("hub 无响应")
		}
	}
	if len(rows) == 0 {
		return fmt.Errorf("当前无设备")
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].FP < rows[j].FP })

	// 批量模式：-all（可选 -state 过滤）直接对所有目标下发
	if *allF {
		batchTTL = *ttlF
		return runBatch(cn, rows, cmd, *stF, *nameF, selfFP)
	}

	// 定位目标：按前缀过滤，或交互选择（显示别名）
	r := selectDevice(rows, *devF)
	if r == nil {
		return fmt.Errorf("未选择设备")
	}

	out := &sig{K: cmd, FP: r.FP, NID: r.NID, SelfFP: selfFP}
	if cmd == "rename" {
		out.Name = *nameF
	}
	if err := cn.sendSig(out); err != nil {
		return err
	}

	for {
		select {
		case e := <-cn.ev:
			switch e.Ctrl {
			case "op-ok":
				switch cmd {
				case "rename":
					if *nameF == "" {
						fmt.Printf("已清除 %s（%s）的别名\n", r.disp(), r.FP)
					} else {
						fmt.Printf("已重命名：%s → %s（%s）\n", r.disp(), *nameF, r.FP)
					}
				case "remove":
					fmt.Printf("已删除设备记录 %s（%s）：别名/授权/屏蔽一并清除\n", r.disp(), r.FP)
				}
				return nil
			case "op-fail":
				return fmt.Errorf("%s", string(e.Msg))
			case "status":
				// 忽略中间状态推送
			}
		case <-time.After(10 * time.Second):
			return fmt.Errorf("hub 无响应")
		}
	}
}

// runBatch 对一批设备下发同一动作。
//
//	handwave approve -all [-state pending]  → 批量授权（只第一台立即配对）
//	handwave remove  -all                   → 批量删除记录
//	handwave deny    -all                   → 批量屏蔽
func runBatch(cn *conn, rows []devRow, op, stateFilter, name, selfFP string) error {
	var fps []string
	for _, r := range rows {
		if stateFilter != "" && r.State != stateFilter {
			continue
		}
		fps = append(fps, r.FP)
	}
	if len(fps) == 0 {
		return fmt.Errorf("没有匹配的设备（状态过滤：%s）", firstNonEmpty(stateFilter, "无"))
	}
	// 批量 approve 允许通过 -ttl 指定统一失效时间
	ttl := int64(0)
	if op == "approve" {
		ttl = batchTTL
	}
	if err := cn.sendSig(&sig{K: "batch", Op: op, FPs: fps, TTL: ttl, SelfFP: selfFP}); err != nil {
		return err
	}
	for {
		select {
		case e := <-cn.ev:
			if e.Ctrl == "op-ok" {
				fmt.Printf("%s：%s（共 %d 台）\n", op, string(e.Msg), len(fps))
				return nil
			}
			if e.Ctrl == "op-fail" {
				return fmt.Errorf("%s", string(e.Msg))
			}
		case <-time.After(15 * time.Second):
			return fmt.Errorf("hub 无响应")
		}
	}
}

func runStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	hubF := fs.String("hub", "", "hub 地址")
	tokF := fs.String("token", "", "hub 访问令牌")
	_ = fs.Parse(args)
	conf := readConf("ctl.conf")
	hub := firstNonEmpty(*hubF, conf["hub"], os.Getenv("HW_HUB"))
	tok := firstNonEmpty(*tokF, conf["token"], os.Getenv("HW_TOKEN"))
	if hub == "" || tok == "" {
		return fmt.Errorf("未配置 hub/token（ctl.conf / 环境变量 HW_HUB/HW_TOKEN / -hub -token）")
	}
	cn := newConn(wsURL(hub, "ctl"), tok, false)
	if err := cn.dial(detachCtx()); err != nil {
		cn.close()
		return err
	}
	defer cn.close()
	if err := cn.sendSig(&sig{K: "status"}); err != nil {
		return err
	}
	for {
		select {
		case e := <-cn.ev:
			if e.Ctrl != "status" {
				continue
			}
			var nodes []devRow
			_ = json.Unmarshal(e.Msg, &nodes)
			if len(nodes) == 0 {
				fmt.Println("（当前无设备；目标机运行 handwave node 后即出现在此）")
				return nil
			}
			sort.SliceStable(nodes, func(i, j int) bool { return nodes[i].FP < nodes[j].FP })
			fmt.Printf("%-22s %-18s %-18s %-8s %-10s %-12s %s\n", "设备", "指纹", "状态", "用户", "系统", "最近活动", "失效")
			for _, n := range nodes {
				fmt.Printf("%-22s %-18s %-18s %-8s %-10s %-12s %s\n",
					trunc(n.disp(), 20), n.FP, n.State, n.User, n.OS, n.Seen, n.Exp)
			}
			return nil
		case <-time.After(10 * time.Second):
			return fmt.Errorf("hub 无响应")
		}
	}
}

// trunc 按「显示宽度」截断：CJK 记 2 列，避免中文别名把表格挤歪。
func trunc(s string, w int) string {
	if w <= 0 {
		return ""
	}
	var b strings.Builder
	cur := 0
	for _, r := range s {
		rw := 1
		if r >= 0x1100 && (r <= 0x115F || r == 0x2329 || r == 0x232A ||
			(r >= 0x2E80 && r <= 0xA4CF) || (r >= 0xAC00 && r <= 0xD7A3) ||
			(r >= 0xF900 && r <= 0xFAFF) || (r >= 0xFE30 && r <= 0xFE6F) ||
			(r >= 0xFF00 && r <= 0xFF60) || (r >= 0xFFE0 && r <= 0xFFE6) ||
			(r >= 0x20000 && r <= 0x3FFFD)) {
			rw = 2
		}
		if cur+rw > w {
			return b.String() + "…"
		}
		b.WriteRune(r)
		cur += rw
	}
	return b.String()
}

func human(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/float64(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/float64(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}
