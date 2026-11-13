package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

const versionStr = "0.1.0"

// ---- 线路协议 ----
//
// WS 信令（node/ctl <-> hub），k：
//
//	join        node 上线（fp=设备指纹, info）→ 登记为待允许设备
//	hello       ctl 上线（fp；已授权设备据此自动配对=免码重连）
//	approve     ctl 允许设备接入 {nid, ttl(秒,0=永久)} → hub 记授权并配对
//	deny        ctl 把设备移入屏蔽名单 {fp}
//	restore     ctl 解除屏蔽 {fp}
//	setttl      ctl 修改授权失效时间 {fp, ttl}
//	revoke      ctl 撤销授权/删除记录 {fp}（设备回待允许）
//	pair-req    hub→node：授权成立，开始建通道（ctlfp/relay）
//	paired      hub→ctl：配对成立
//	status      ctl→hub 查询；hub→ctl 推送设备表 JSON
//	sdp/cand    WebRTC 信令中继
//	dc          relay 兜底透传 DC 帧（b64；hub 不解内容）
//	pair-fail   操作被拒（设备占用/屏蔽/本端已绑定）
//	unpaired    对端断开、bye、撤销或授权过期
//	model-grant hub→node：本次执行访问码（d=码，ttl=秒）；失败时 err 非空
//	bye         ctl 主动结束配对
//
// DataChannel 帧（ctl <-> node，JSON）：
//
//	exec  {k,id,cmd,cwd,timeout}     -> out×N（末帧 done:true 带 exit code）
//	put   {k,id,path,size}           -> 就绪 out -> chunk{k,id,b64,done}×N(每块 ack) -> out
//	get   {k,id,path}                -> out×N（b64 分块，done:true 收尾；每块回 ack）
//	ack   {k,id}                     流控：收方确认一块
//	hello {k:node-hello,fp,info}     通道建立确认帧（node 上报主机与自身指纹）
//	bye   {k:bye,msg}                结束配对
//	ping/pong                        连通性
//	agent-loop {k,id,msg|task,model,brief} 本机调度循环：访问码、模型、本地工具、云端组装上下文
//	agent-steer {k,msg}              插入当前回合（工具间隙生效）
//	agent-follow {k,msg}             当前回合结束后继续
//	agent-abort {k,id}               取消当前回合
//	agent-bash {k,id,cmd,cwd}        独立命令通道，不取消回合
//	agent-bash-abort {k}             取消独立命令
//	agent-mode {k,msg}               打断方式：immediate 立刻停工具，wait 等当前工具结束
//	agent-ui {k,id,msg,code}         回应 ui_request；code=0 且 err 空为同意

type sig struct {
	K                string          `json:"k"`
	NodeNonce        string          `json:"node_nonce,omitempty"`
	NodeExpiresAt    int64           `json:"node_expires_at,omitempty"`
	NodePublicKey    string          `json:"node_public_key,omitempty"`
	NodeSignature    string          `json:"node_signature,omitempty"`
	JobAction        string          `json:"job_action,omitempty"`
	JobID            string          `json:"job_id,omitempty"`
	JobInputID       string          `json:"job_input_id,omitempty"`
	JobText          string          `json:"job_text,omitempty"`
	JobEOF           bool            `json:"job_eof,omitempty"`
	JobSignal        string          `json:"job_signal,omitempty"`
	JobRows          uint16          `json:"job_rows,omitempty"`
	JobCols          uint16          `json:"job_cols,omitempty"`
	JobStream        string          `json:"job_stream,omitempty"`
	JobCursor        uint64          `json:"job_cursor,omitempty"`
	JobLimit         uint32          `json:"job_limit,omitempty"`
	JobData          json.RawMessage `json:"job_data,omitempty"`
	JobOK            bool            `json:"job_ok,omitempty"`
	Schedule         json.RawMessage `json:"schedule,omitempty"`
	GoalID           string          `json:"goal_id,omitempty"`
	SessionKey       string          `json:"session_key,omitempty"`
	GoalLease        *goalLease      `json:"goal_lease,omitempty"`
	Goal             json.RawMessage `json:"goal,omitempty"`
	WriterEpoch      string          `json:"writer_epoch,omitempty"`
	CommandID        string          `json:"command_id,omitempty"`
	Command          string          `json:"command,omitempty"`
	ExpectedRevision uint64          `json:"expected_revision,omitempty"`
	ReviewedRunID    string          `json:"reviewed_run_id,omitempty"`
	Model            string          `json:"model,omitempty"`
	Protocol         string          `json:"protocol,omitempty"`
	ID               string          `json:"id,omitempty"`    // exec/out result ID
	FP               string          `json:"fp,omitempty"`    // 设备/操作端自报指纹（join/hello/pair 类帧）
	NID              string          `json:"nid,omitempty"`   // approve：目标设备连接 id
	TTL              int64           `json:"ttl,omitempty"`   // approve/setttl：有效秒数；0=永久
	CtlFP            string          `json:"ctlfp,omitempty"` // pair-req：来者 ctl 指纹
	Info             *Hello          `json:"info,omitempty"`
	SDP              string          `json:"sdp,omitempty"`
	Cand             string          `json:"cand,omitempty"`
	Relay            bool            `json:"relay,omitempty"`   // hello/pair-req：走 hub 中继
	Name             string          `json:"name,omitempty"`    // rename：设备别名（空串=清除别名）
	Op               string          `json:"op,omitempty"`      // batch：批量动作 approve|deny|restore|revoke|remove
	FPs              []string        `json:"fps,omitempty"`     // batch：目标设备指纹列表
	SelfFP           string          `json:"selffp,omitempty"`  // batch：操作端自报指纹（CLI 未 hello 时兜底）
	Done             int             `json:"done,omitempty"`    // op-ok：成功条数
	Skipped          int             `json:"skipped,omitempty"` // op-ok：跳过条数（如被屏蔽/离线）
	D                string          `json:"d,omitempty"`       // dc 帧 b64 / status JSON
	Err              string          `json:"err,omitempty"`
	Msg              string          `json:"msg,omitempty"`  // exec/out result message
	Code             int             `json:"code,omitempty"` // exec/out exit code
	// model-grant：Hub 保存的默认模型/协议（非敏感元数据，绝不含 key）。node 用它把
	// 空/default 选择解析成真实 model+protocol，而不是把 "default" 当字面模型 id。
	DefaultModel    string `json:"default_model,omitempty"`
	DefaultProtocol string `json:"default_protocol,omitempty"`
	// model-grant 请求侧：Smart 是显式智能路径开关（与 dcf.Smart 同义，用在 WS 信令上）。
	Smart bool `json:"smart,omitempty"`
	// model-grant 请求侧：稳定 run 归属、要复用的绑定、以及选型所需的摘要/工具需求。
	// Run 是**稳定**的回合标识；ID 只用于匹配本次请求与回复（correlation），
	// 两者混用会让续签在 Hub 侧留下第二个 RunID。
	Run           string `json:"run,omitempty"`
	Renew         bool   `json:"renew,omitempty"` // existing Run only; never recreates an ended authorization
	Binding       string `json:"binding,omitempty"`
	Brief         string `json:"brief,omitempty"`
	RequiresTools bool   `json:"requires_tools,omitempty"`
	// model-grant：智能路径下发的可信绑定（同样是非敏感元数据，绝不含 key）。
	// 具体元组与决策由 Hub 侧的可信记录持有，node 只是照用，不得据此自造授权。
	BindingID        string `json:"binding_id,omitempty"`
	BoundModel       string `json:"bound_model,omitempty"`
	BoundProtocol    string `json:"bound_protocol,omitempty"`
	BoundDecision    string `json:"bound_decision,omitempty"`
	BoundDecisionExp string `json:"bound_decision_exp,omitempty"` // RFC3339
	BoundMaxOutput   int    `json:"bound_max_output,omitempty"`
	BoundTools       bool   `json:"bound_tools,omitempty"`
}

type Hello struct {
	Hostname string   `json:"hostname"`
	User     string   `json:"user"`
	OS       string   `json:"os"`
	Arch     string   `json:"arch"`
	Version  string   `json:"version"`
	Caps     []string `json:"caps,omitempty"`
}

// agentTask 是浏览器交给 Node 的有界、顺序任务。Node 不持有模型密钥。
type agentTask struct {
	ID        string      `json:"id"`
	AgentID   string      `json:"agent_id"`
	Name      string      `json:"name"`
	Role      string      `json:"role"`
	Objective string      `json:"objective"`
	Steps     []agentStep `json:"steps"`
}

// dcf 一帧 DC 消息（字段并集，按 k 取用）
type dcf struct {
	K       string `json:"k"`
	ID      string `json:"id,omitempty"`
	Cmd     string `json:"cmd,omitempty"`
	Cwd     string `json:"cwd,omitempty"`
	Path    string `json:"path,omitempty"`
	Size    int64  `json:"size,omitempty"`
	Timeout int    `json:"timeout,omitempty"`
	Enc     string `json:"enc,omitempty"` // exec:"utf8"：网页控制台请求输出转 UTF-8
	B64     string `json:"b64,omitempty"`
	Done    bool   `json:"done,omitempty"`
	Code    int    `json:"code,omitempty"`
	Err     string `json:"err,omitempty"`
	Msg     string `json:"msg,omitempty"`
	Model   string `json:"model,omitempty"`
	// Protocol 是调用方显式选择的原生协议（七协议之一）。目录里同一模型提供多个协议
	// 而这里为空时，node 必须拒绝而不是回退到 chat。
	Protocol string `json:"protocol,omitempty"`
	// Smart 是显式的智能路径开关：true 表示请求 Hub 代选型并下发可信绑定。
	// 它是独立于 Model 的字段，**不改变**旧 default/explicit 语义：
	// Model 为空或 "default" 仍是"用 Hub 保存的默认模型"，显式 model id 仍是显式选择。
	Smart bool   `json:"smart,omitempty"`
	Brief string `json:"brief,omitempty"` // agent-loop：云端组装的工作区上下文（skills+KB 摘录），node 前置到系统提示
	Info  *Hello `json:"info,omitempty"`
	FP    string `json:"fp,omitempty"`
	// agent-queue-recovery：旧 ID-less paused 队列的查看与显式处置（msg=list/requeue/discard）。
	Entry string      `json:"entry,omitempty"` // 处置的条目 ID（稳定，绝不按文本匹配）
	Kind  string      `json:"kind,omitempty"`  // requeue 时显式选择的类别：steer / follow_up
	Rev   uint64      `json:"rev,omitempty"`   // 调用方看到的预览版本，过期视图必须被拒绝
	Task  *agentTask  `json:"task,omitempty"`
	Event *agentEvent `json:"event,omitempty"`
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func b64(s []byte) string { return base64.StdEncoding.EncodeToString(s) }

func unb64(s string) []byte { x, _ := base64.StdEncoding.DecodeString(s); return x }

func hexID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ---- 身份密钥：每机一份 ed25519；配对时出示指纹 ----

type identity struct {
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
	FP   string
}

// loadOrCreateIdentity name 可省略（默认 identity.key；ctl 用 ctl.key）
func loadOrCreateIdentity(dir string, name ...string) (*identity, error) {
	fn := "identity.key"
	if len(name) > 0 && name[0] != "" {
		fn = name[0]
	}
	path := filepath.Join(dir, fn)
	if raw, err := os.ReadFile(path); err == nil && len(raw) == ed25519.SeedSize {
		priv := ed25519.NewKeyFromSeed(raw)
		pub := priv.Public().(ed25519.PublicKey)
		return &identity{pub: pub, priv: priv, FP: fpOf(pub)}, nil
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, seed, 0o600); err != nil {
		return nil, err
	}
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)
	return &identity{pub: pub, priv: priv, FP: fpOf(pub)}, nil
}

// fpOf 11 位 base32 指纹（8 字节前缀，肉眼可核）
func fpOf(pub ed25519.PublicKey) string {
	return strings.TrimRight(base32.StdEncoding.EncodeToString(pub[:8]), "=")
}

// ---- 配置（绿色便携：exe 同级优先，不可写退 ~/.handwave）----

func confDir() string {
	// Reach Desk fixes this path before loading any state. Never fall back to
	// legacy locations if the selected directory later becomes unavailable.
	if deskStateDir != "" {
		return deskStateDir
	}
	// HW_CONF 显式指定配置目录（Linux 服务端惯例：/etc/handwave）。
	// 必须落成绝对路径：子进程会切换工作目录，相对路径会在子进程里再次拼接。
	if d := os.Getenv("HW_CONF"); d != "" {
		if abs, err := filepath.Abs(d); err == nil {
			d = abs
		}
		if err := os.MkdirAll(d, 0o755); err == nil {
			return d
		}
	}
	if exe, err := os.Executable(); err == nil {
		d := filepath.Dir(exe)
		if f, err := os.OpenFile(filepath.Join(d, ".wtest"), os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
			f.Close()
			os.Remove(filepath.Join(d, ".wtest"))
			return d
		}
	}
	h, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	dir := filepath.Join(h, ".handwave")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

// readConf 返回可增删的 map（保留未知键，写回不丢）
func readConf(name string) map[string]string {
	m := map[string]string{}
	raw, err := os.ReadFile(filepath.Join(confDir(), name))
	if err != nil {
		return m
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if k, v, ok := strings.Cut(line, "="); ok && k != "" {
			m[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	return m
}

func writeConf(name string, kv map[string]string) error {
	var b strings.Builder
	for k, v := range kv {
		fmt.Fprintf(&b, "%s=%s\n", k, v)
	}
	return os.WriteFile(filepath.Join(confDir(), name), []byte(b.String()), 0o600)
}

// ---- AI 反代（reach 实测移植）：真实 key 只注入在 hub，永不下目标机 ----

func selfHello() *Hello {
	host, _ := os.Hostname()
	user := os.Getenv("USERNAME")
	if user == "" {
		user = os.Getenv("USER")
	}
	if user == "" {
		user = "unknown"
	}
	return &Hello{Hostname: host, User: user, OS: runtime.GOOS, Arch: runtime.GOARCH, Version: versionStr, Caps: []string{"exec", "files", "agent-task", "agent-loop", "cancel"}}
}

func itoa(n int) string { return strconv.Itoa(n) }

func detachCtx() context.Context { return context.Background() }
