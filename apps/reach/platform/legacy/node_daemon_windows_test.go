//go:build windows

package main

import (
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// TestSupervisorTerminationKillsWorker 复现缺陷：Windows 上 supervisor 被强制终止
// （TerminateProcess，不投递信号）后，worker 必须随之退出，且不能留下测试进程。
// 这是真实进程实测，不是模拟。
func TestSupervisorTerminationKillsWorker(t *testing.T) {
	dir := t.TempDir()
	sup, buf := startDaemonHelper(t, roleSupervisor, dir, "")
	t.Cleanup(func() {
		if sup.Process != nil {
			_ = sup.Process.Kill()
		}
	})

	workerPID := 0
	raw := waitForFileContent(t, filepath.Join(dir, daemonWorkerPID), 60*time.Second)
	pid, err := strconv.Atoi(raw)
	if err != nil {
		t.Fatalf("worker pid file %q: %v (supervisor output: %s)", raw, err, buf.String())
	}
	workerPID = pid
	t.Cleanup(func() {
		if pidAlive(workerPID) {
			t.Errorf("worker pid %d was left behind", workerPID)
		}
	})
	if !pidAlive(workerPID) {
		t.Fatalf("worker pid %d is not running before the supervisor is killed", workerPID)
	}
	if !pidAlive(sup.Process.Pid) {
		t.Fatalf("supervisor pid %d is not running", sup.Process.Pid)
	}

	// 强制终止 supervisor：Windows 上等价于 taskkill /F，不给它任何清理机会。
	if err := sup.Process.Kill(); err != nil {
		t.Fatalf("kill supervisor: %v", err)
	}
	_, _ = sup.Process.Wait()

	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if !pidAlive(workerPID) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("worker pid %d survived supervisor termination (supervisor output: %s)", workerPID, buf.String())
}
