package main

// model_binding.go 是智能路径的可信绑定记录，与 model_grant.go 的可过期访问码**明确分开**：
//
//	code        = 这次请求带没带有效访问码（短期、可轮换、过期即被清理）
//	sessionPin  = 这一会话被授权了哪个具体元组/决策（按 FP+BindingID 定位）
//	runGrant    = 这一 Node 回合（稳定 RunID）绑定到哪个 Binding、当前 code 是什么
//
// 之所以分开：`grantBook` 只按 code 索引，且 put/lookup 会顺带删除过期 code
// （model_grant.go:43-65）。如果续签要靠"已被删除的旧 code"反查原授权，就会丢失绑定，
// 或退化成按客户端自报字段重建宽授权。这里改为：续签按 (FP, 稳定 Run) 查可信运行记录，
// 再经 BindingID 回到会话 pin，只换 code/TTL，元组与决策一律不变。
//
// 它不是一个调度器：记录只随 run 结束、决策失效/撤销、设备断连做有界清理。

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	// modelBindingCodeTTL 与旧 model-grant 的 TTL 语义保持一致，不扩大旧授权生命周期。
	modelBindingCodeTTL = 15 * time.Minute
	// runGraceAfterCodeExpiry 是 code 过期后回合记录仍可续签的宽限期。
	// code 过期只让"这个 code 不能再用"，不结束回合授权；超过宽限期才清理，
	// 这样续签既不必依赖已删除的旧 code，也不会让记录无界增长。
	runGraceAfterCodeExpiry = time.Hour
	// maxSessionPins 限制驻留的会话绑定数量，避免长跑进程无界增长。
	maxSessionPins = 512
	// maxRunGrants 限制驻留的回合授权数量。
	maxRunGrants = 1024
)

// sessionPin 是一次智能选型后的可信会话绑定。它持有**具体**元组与决策，
// 不持有任何凭据；code 绝不存在这里。
type sessionPin struct {
	FP        string
	BindingID string
	Model     string
	Protocol  string
	// DecisionID 与 DecisionExp 来自网关决策：短期、可过期，不决定原生会话身份。
	DecisionID  string
	DecisionExp time.Time
	// host-explicit identifies a Hub catalog-validated fixed choice. It is
	// never sent to the Gateway as if it were a Gateway-issued route decision.
	DecisionSource string
	// 请求约束：真实请求必须满足，不能只带决策头而让请求全部被拒。
	MaxOutputTokens int
	RequiresTools   bool
	CreatedAt       time.Time
}

// runGrant 是一个 Node 回合（稳定 RunID）对本会话绑定的一次授权。
// Code 是当前有效访问码；换 code 时旧码立即失效。
type runGrant struct {
	FP        string
	RunID     string
	BindingID string
	Code      string
	Exp       time.Time
}

type bindingBook struct {
	mu sync.Mutex
	// pins: fp\x00bindingID -> pin；runs: fp\x00runID -> grant；byCode: code -> fp\x00runID
	pins   map[string]*sessionPin
	runs   map[string]*runGrant
	byCode map[string]string
	// issuing serializes the first publication for one stable Node Run. The
	// route resolve itself remains outside both Hub and book locks.
	issuing map[string]*runIssueFlight
}

type runIssueFlight struct {
	done chan struct{}
	err  error
}

func newBindingBook() *bindingBook {
	return &bindingBook{
		pins:    map[string]*sessionPin{},
		runs:    map[string]*runGrant{},
		byCode:  map[string]string{},
		issuing: map[string]*runIssueFlight{},
	}
}

func bindingKey(fp, id string) string { return fp + "\x00" + id }

// mintCode 生成不可猜测的访问码。
func mintCode() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// sweepExpired 清理过期记录。返回的布尔值表示是否有记录被移除（供测试与日志观察）。
//
// 两种生命周期必须分开：
//   - code 过期只让"这个 code 不能再用"（从 byCode 摘掉），**回合记录保留**，
//     否则 grant 到期后续签就查不到可信运行记录，只能退化成按客户端字段重建；
//   - 会话 pin 过期/撤销 → 该回合失去可信绑定，连带清理；
//   - 超过宽限期仍未续签的回合才被清理，保证记录有界。
func (b *bindingBook) sweepExpired(now time.Time) bool {
	removed := false
	for k, p := range b.pins {
		if !p.DecisionExp.IsZero() && !p.DecisionExp.After(now) {
			delete(b.pins, k)
			removed = true
		}
	}
	for k, g := range b.runs {
		if _, ok := b.pins[bindingKey(g.FP, g.BindingID)]; !ok {
			delete(b.byCode, g.Code)
			delete(b.runs, k)
			removed = true
			continue
		}
		if !g.Exp.After(now) {
			delete(b.byCode, g.Code)
			removed = true
			if now.After(g.Exp.Add(runGraceAfterCodeExpiry)) {
				delete(b.runs, k)
			}
		}
	}
	return removed
}

// pinSession 记录一次智能选型的可信结果，返回新生成的 BindingID。
// 决策有效期为零表示"不设过期"，由调用方（撤销/容量）负责边界。
func (b *bindingBook) pinSession(fp string, p sessionPin) (*sessionPin, error) {
	fp = strings.TrimSpace(fp)
	if fp == "" {
		return nil, fmt.Errorf("binding requires a confirmed device fingerprint")
	}
	if strings.TrimSpace(p.Model) == "" || strings.TrimSpace(p.Protocol) == "" {
		return nil, fmt.Errorf("binding requires a concrete model and protocol")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.sweepExpired(time.Now())
	if len(b.pins) >= maxSessionPins {
		return nil, fmt.Errorf("session pin capacity reached (%d)", maxSessionPins)
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	id := "b-" + hex.EncodeToString(buf)
	p.FP = fp
	p.BindingID = id
	if p.CreatedAt.IsZero() {
		p.CreatedAt = time.Now()
	}
	b.pins[bindingKey(fp, id)] = &p
	return &p, nil
}

// findPin 按 FP+BindingID 查会话绑定；决策过期即视为不可用并移除。
func (b *bindingBook) findPin(fp, bindingID string) (*sessionPin, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	k := bindingKey(fp, bindingID)
	p, ok := b.pins[k]
	if !ok {
		return nil, false
	}
	if !p.DecisionExp.IsZero() && !time.Now().Before(p.DecisionExp) {
		delete(b.pins, k)
		return nil, false
	}
	return p, true
}

// attachRun 为一个回合（稳定 RunID）签发访问码并绑定到已有会话 pin。
// 同一 RunID 重复调用是**换码**而不是新建绑定：原子替换 code 并让旧码立即失效。
func (b *bindingBook) attachRun(fp, runID, bindingID string) (*runGrant, error) {
	fp, runID, bindingID = strings.TrimSpace(fp), strings.TrimSpace(runID), strings.TrimSpace(bindingID)
	if fp == "" || runID == "" || bindingID == "" {
		return nil, fmt.Errorf("run binding requires fp, run and binding")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.sweepExpired(time.Now())
	if _, ok := b.pins[bindingKey(fp, bindingID)]; !ok {
		return nil, fmt.Errorf("no trusted session binding for this run")
	}
	if len(b.runs) >= maxRunGrants {
		return nil, fmt.Errorf("run authorization capacity reached (%d)", maxRunGrants)
	}
	code, err := mintCode()
	if err != nil {
		return nil, err
	}
	return b.replaceCodeLocked(fp, runID, bindingID, code), nil
}

// renewRun 在 code 过期后按 (FP, Run) 续签：**不依赖旧 code**，
// 只换 code/TTL，BindingID 与会话 pin 一律不变。
func (b *bindingBook) renewRun(fp, runID string) (*runGrant, error) {
	fp, runID = strings.TrimSpace(fp), strings.TrimSpace(runID)
	if fp == "" || runID == "" {
		return nil, fmt.Errorf("renewal requires fp and run")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	b.sweepExpired(now)
	old, ok := b.runs[bindingKey(fp, runID)]
	if !ok {
		return nil, fmt.Errorf("no trusted run record to renew")
	}
	if _, ok := b.pins[bindingKey(fp, old.BindingID)]; !ok {
		// 会话 pin 已失效/被撤销：不得按客户端字段重建，也不能退回旧宽授权。
		delete(b.byCode, old.Code)
		delete(b.runs, bindingKey(fp, runID))
		return nil, fmt.Errorf("session binding is no longer trusted")
	}
	code, err := mintCode()
	if err != nil {
		return nil, err
	}
	return b.replaceCodeLocked(fp, runID, old.BindingID, code), nil
}

// replaceCodeLocked 原子换码：旧 code 立即失效，不会与新 code 并存。
// 调用方必须持有 b.mu。
func (b *bindingBook) replaceCodeLocked(fp, runID, bindingID, code string) *runGrant {
	k := bindingKey(fp, runID)
	if old, ok := b.runs[k]; ok {
		delete(b.byCode, old.Code)
	}
	g := &runGrant{FP: fp, RunID: runID, BindingID: bindingID, Code: code, Exp: time.Now().Add(modelBindingCodeTTL)}
	b.runs[k] = g
	b.byCode[code] = k
	return g
}

// findRun 按 (FP, 稳定 Run) 查回合记录，**不看 code 是否过期**：
// code 过期只换码，不结束回合授权。找不到才说明这是该 run 的首次签发。
func (b *bindingBook) findRun(fp, runID string) (*runGrant, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	g, ok := b.runs[bindingKey(fp, runID)]
	return g, ok
}

// joinRunIssue elects one publisher for the first grant of a stable Run. It
// does not cover renewal: renewal must explicitly name an existing Run and
// Binding and is handled separately.
func (b *bindingBook) joinRunIssue(fp, runID string) (*runIssueFlight, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	k := bindingKey(fp, runID)
	if f := b.issuing[k]; f != nil {
		return f, false
	}
	f := &runIssueFlight{done: make(chan struct{})}
	b.issuing[k] = f
	return f, true
}

func (b *bindingBook) finishRunIssue(fp, runID string, f *runIssueFlight, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	f.err = err
	delete(b.issuing, bindingKey(fp, runID))
	close(f.done)
}

// runForCode 按当前有效 code 反查回合记录（逐请求门禁用）。
func (b *bindingBook) runForCode(code string) (*runGrant, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	k, ok := b.byCode[code]
	if !ok {
		return nil, false
	}
	g, ok := b.runs[k]
	if !ok {
		return nil, false
	}
	if !g.Exp.After(time.Now()) {
		// code 过期只废止这个码，**必须保留回合记录**：续签正是靠 (FP, Run) 查它的。
		// 删掉 runs 会让"真实 HTTP 401 后再走 WS 同 Run 续签"直接失败。
		delete(b.byCode, code)
		return nil, false
	}
	return g, true
}

// endRun 只清理该回合自身的授权，**保留仍有效的会话 pin**。
// 这保证"结束 Run 不得删除仍有效会话绑定"。
func (b *bindingBook) endRun(fp, runID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	k := bindingKey(fp, runID)
	if g, ok := b.runs[k]; ok {
		delete(b.byCode, g.Code)
		delete(b.runs, k)
	}
}

// dropFP 设备断连清理：该设备的回合授权与会话 pin 一并移除（有界）。
func (b *bindingBook) dropFP(fp string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for k, g := range b.runs {
		if g.FP == fp {
			delete(b.byCode, g.Code)
			delete(b.runs, k)
		}
	}
	for k, p := range b.pins {
		if p.FP == fp {
			delete(b.pins, k)
		}
	}
}

// revokePin 撤销一个会话绑定（决策失效/人工撤销）。
func (b *bindingBook) revokePin(fp, bindingID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.pins, bindingKey(fp, bindingID))
}
