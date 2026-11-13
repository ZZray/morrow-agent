package main

import (
	"context"
	"path/filepath"
	"testing"

	"ara/internal/agent"
	"ara/internal/nativeapp"
)

func TestCoordinatorQueuedFollowAckKeepsNewSteer(t *testing.T) {
	a := newTestNodeAgent(t)
	sess := a.hostSession()
	if err := sess.followUp("pending-follow"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	delivered := false
	_, _ = nativeapp.Run(ctx, nativeapp.Options{
		Cwd: t.TempDir(), SessionDir: filepath.Join(t.TempDir(), "sessions"),
		Prompt: "initial", Control: sess.control,
		Host: &nativeapp.Host{Provider: &scriptedProvider{}, ProviderID: "fixture", Model: "fixture"},
	}, func(ev agent.Event) {
		if ev.Type != "message" || ev.Message == nil || ev.Message.Role != "user" || ev.Message.Text() != "pending-follow" {
			return
		}
		delivered = true
		// A new steering frame can arrive after the engine commits the follow-up,
		// before the host consumes its delivery event.
		if err := sess.steer("new-steer"); err != nil {
			t.Error(err)
		}
		// Ack by the committed delivery receipt only: never by text or order.
		sess.ackDelivery(ev.Delivery)
		cancel()
	})
	if !delivered {
		t.Fatal("fixture did not deliver the queued follow-up")
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if len(sess.state.Pending) != 1 || sess.state.Pending[0].Text != "new-steer" || sess.state.Pending[0].Kind != "steer" {
		t.Fatalf("recovery queue must retain only the undelivered steer: pending=%+v", sess.state.Pending)
	}
}
