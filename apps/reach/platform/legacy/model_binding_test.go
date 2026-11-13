package main

import (
	"strings"
	"sync"
	"testing"
	"time"
)

func TestBindingBookFirstRunIssueIsSingleFlight(t *testing.T) {
	b := newBindingBook()
	first, leader := b.joinRunIssue("fp-a", "run-1")
	if !leader {
		t.Fatal("first caller must lead")
	}
	second, leader := b.joinRunIssue("fp-a", "run-1")
	if leader || second != first {
		t.Fatal("duplicate first issue must join the same flight")
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-second.done
	}()
	b.finishRunIssue("fp-a", "run-1", first, nil)
	wg.Wait()
	if second.err != nil {
		t.Fatalf("joined flight received unexpected error: %v", second.err)
	}
	if _, leader := b.joinRunIssue("fp-a", "run-1"); !leader {
		t.Fatal("completed flight was not removed")
	}
}

func testPin(fp, model, protocol, decision string) sessionPin {
	return sessionPin{
		FP:              fp,
		Model:           model,
		Protocol:        protocol,
		DecisionID:      decision,
		DecisionExp:     time.Now().Add(time.Hour),
		MaxOutputTokens: 4096,
		RequiresTools:   true,
	}
}

// 首次绑定：签发 code 后逐请求可按 code 反查到回合与绑定，且不持有任何凭据。
func TestBindingBookPinsConcreteTupleAndAttachesRun(t *testing.T) {
	b := newBindingBook()
	pin, err := b.pinSession("fp-a", testPin("fp-a", "chat-model", "openai-completions", "rd-1"))
	if err != nil {
		t.Fatal(err)
	}
	if pin.BindingID == "" || !strings.HasPrefix(pin.BindingID, "b-") {
		t.Fatalf("binding id not generated: %+v", pin)
	}
	g, err := b.attachRun("fp-a", "run-1", pin.BindingID)
	if err != nil {
		t.Fatal(err)
	}
	if g.BindingID != pin.BindingID {
		t.Fatalf("run bound to the wrong binding: %+v", g)
	}
	got, ok := b.runForCode(g.Code)
	if !ok || got.RunID != "run-1" {
		t.Fatalf("code does not resolve to the run: %+v", got)
	}
	back, ok := b.findPin("fp-a", pin.BindingID)
	if !ok || back.Model != "chat-model" || back.Protocol != "openai-completions" || back.DecisionID != "rd-1" {
		t.Fatalf("pin lost the concrete tuple: %+v", back)
	}
}

// 元组不完整不能建绑定：具体 protocol 缺失会让后续请求无法校验。
func TestBindingBookRejectsIncompleteTuple(t *testing.T) {
	b := newBindingBook()
	if _, err := b.pinSession("fp-a", sessionPin{FP: "fp-a", Model: "chat-model"}); err == nil {
		t.Fatal("missing protocol must be rejected")
	}
	if _, err := b.pinSession("", testPin("", "chat-model", "openai-completions", "rd-1")); err == nil {
		t.Fatal("missing fingerprint must be rejected")
	}
}

// 续签不得依赖已删除的旧 code：过期清理之后，按 FP+Run 仍能续签，
// 且 binding/元组不变、旧码立即失效。
func TestBindingBookRenewalSurvivesExpiredCode(t *testing.T) {
	b := newBindingBook()
	pin, err := b.pinSession("fp-a", testPin("fp-a", "chat-model", "openai-completions", "rd-1"))
	if err != nil {
		t.Fatal(err)
	}
	first, err := b.attachRun("fp-a", "run-1", pin.BindingID)
	if err != nil {
		t.Fatal(err)
	}
	// 让 code 过期并被清理：模拟 grantBook 会删除过期 code 的真实行为。
	b.mu.Lock()
	b.runs[bindingKey("fp-a", "run-1")].Exp = time.Now().Add(-time.Second)
	b.sweepExpired(time.Now())
	b.mu.Unlock()
	if _, ok := b.runForCode(first.Code); ok {
		t.Fatal("expired code still resolves")
	}

	next, err := b.renewRun("fp-a", "run-1")
	if err != nil {
		t.Fatalf("renewal must not depend on the deleted code: %v", err)
	}
	if next.BindingID != pin.BindingID {
		t.Fatalf("renewal changed the binding: %+v", next)
	}
	if next.Code == first.Code {
		t.Fatal("renewal must mint a new code")
	}
	if _, ok := b.runForCode(first.Code); ok {
		t.Fatal("old code must be invalid after renewal")
	}
	back, ok := b.findPin("fp-a", pin.BindingID)
	if !ok || back.DecisionID != "rd-1" {
		t.Fatalf("renewal lost the session binding: %+v", back)
	}
}

// 会话 pin 消失后不得续签：既不能按客户端字段重建，也不能退回旧宽授权。
func TestBindingBookRenewalRejectedWhenPinRevoked(t *testing.T) {
	b := newBindingBook()
	pin, err := b.pinSession("fp-a", testPin("fp-a", "chat-model", "openai-completions", "rd-1"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.attachRun("fp-a", "run-1", pin.BindingID); err != nil {
		t.Fatal(err)
	}
	b.revokePin("fp-a", pin.BindingID)
	if _, err := b.renewRun("fp-a", "run-1"); err == nil {
		t.Fatal("renewal must be rejected without a trusted binding")
	}
	if _, ok := b.runForCode(""); ok {
		t.Fatal("empty code must not resolve")
	}
}

// 决策过期后 pin 不可用，因此续签同样被拒（不静默重新选型）。
func TestBindingBookRenewalRejectedWhenDecisionExpired(t *testing.T) {
	b := newBindingBook()
	p := testPin("fp-a", "chat-model", "openai-completions", "rd-1")
	p.DecisionExp = time.Now().Add(time.Second)
	pin, err := b.pinSession("fp-a", p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.attachRun("fp-a", "run-1", pin.BindingID); err != nil {
		t.Fatal(err)
	}
	b.mu.Lock()
	b.pins[bindingKey("fp-a", pin.BindingID)].DecisionExp = time.Now().Add(-time.Second)
	b.mu.Unlock()
	if _, err := b.renewRun("fp-a", "run-1"); err == nil {
		t.Fatal("renewal must be rejected once the decision expired")
	}
}

// 结束 Run 只清自身授权，不得删除仍有效的会话绑定。
func TestBindingBookEndRunKeepsSessionPin(t *testing.T) {
	b := newBindingBook()
	pin, err := b.pinSession("fp-a", testPin("fp-a", "chat-model", "openai-completions", "rd-1"))
	if err != nil {
		t.Fatal(err)
	}
	g, err := b.attachRun("fp-a", "run-1", pin.BindingID)
	if err != nil {
		t.Fatal(err)
	}
	b.endRun("fp-a", "run-1")
	if _, ok := b.runForCode(g.Code); ok {
		t.Fatal("run authorization must be cleared")
	}
	if _, ok := b.findPin("fp-a", pin.BindingID); !ok {
		t.Fatal("ending a run must not delete a still-valid session pin")
	}
	// 后续 Run 可以复用同一绑定（新 Run 新 code、同 binding）。
	second, err := b.attachRun("fp-a", "run-2", pin.BindingID)
	if err != nil {
		t.Fatal(err)
	}
	if second.BindingID != pin.BindingID || second.Code == g.Code {
		t.Fatalf("second run must reuse the binding with a fresh code: %+v", second)
	}
}

// 换码是原子的：旧码立即失效，不会与新码并存。
func TestBindingBookCodeSwapInvalidatesOldCode(t *testing.T) {
	b := newBindingBook()
	pin, err := b.pinSession("fp-a", testPin("fp-a", "chat-model", "openai-completions", "rd-1"))
	if err != nil {
		t.Fatal(err)
	}
	first, err := b.attachRun("fp-a", "run-1", pin.BindingID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := b.attachRun("fp-a", "run-1", pin.BindingID)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := b.runForCode(first.Code); ok {
		t.Fatal("old code must be invalid immediately after the swap")
	}
	if got, ok := b.runForCode(second.Code); !ok || got.RunID != "run-1" {
		t.Fatalf("new code must resolve to the run: %+v", got)
	}
}

// 跨设备不可访问：另一 FP 既拿不到 pin，也不能挂到该 binding 上。
func TestBindingBookIsolatesFingerprints(t *testing.T) {
	b := newBindingBook()
	pin, err := b.pinSession("fp-a", testPin("fp-a", "chat-model", "openai-completions", "rd-1"))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := b.findPin("fp-b", pin.BindingID); ok {
		t.Fatal("another fingerprint must not read the pin")
	}
	if _, err := b.attachRun("fp-b", "run-1", pin.BindingID); err == nil {
		t.Fatal("another fingerprint must not attach to the binding")
	}
	if _, err := b.renewRun("fp-b", "run-1"); err == nil {
		t.Fatal("another fingerprint must not renew the run")
	}
}

// 设备断连清理：该 FP 的回合与 pin 一并移除，不影响其他设备。
func TestBindingBookDropFingerprint(t *testing.T) {
	b := newBindingBook()
	pinA, err := b.pinSession("fp-a", testPin("fp-a", "chat-model", "openai-completions", "rd-1"))
	if err != nil {
		t.Fatal(err)
	}
	pinB, err := b.pinSession("fp-b", testPin("fp-b", "chat-model", "openai-completions", "rd-2"))
	if err != nil {
		t.Fatal(err)
	}
	ga, err := b.attachRun("fp-a", "run-1", pinA.BindingID)
	if err != nil {
		t.Fatal(err)
	}
	b.dropFP("fp-a")
	if _, ok := b.runForCode(ga.Code); ok {
		t.Fatal("dropped device must lose its run authorization")
	}
	if _, ok := b.findPin("fp-a", pinA.BindingID); ok {
		t.Fatal("dropped device must lose its session pin")
	}
	if _, ok := b.findPin("fp-b", pinB.BindingID); !ok {
		t.Fatal("dropFP must not touch other devices")
	}
}
