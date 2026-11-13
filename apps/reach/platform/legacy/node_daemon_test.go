package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	daemonHelperEnv   = "HW_DAEMON_TEST_ROLE"
	daemonHelperDir   = "HW_DAEMON_TEST_DIR"
	daemonHelperOut   = "HW_DAEMON_TEST_OUT"
	daemonReleaseFile = "release"
	daemonWorkerPID   = "worker.pid"
)

const (
	roleAcquire    = "acquire"
	roleHold       = "hold"
	roleSupervisor = "supervisor"
	roleWorker     = "worker"
)

// TestHelperDaemonProcess 是被 re-exec 出来的子进程入口。它只在设置了
// HW_DAEMON_TEST_ROLE 时执行，正常跑 go test 会直接跳过。
func TestHelperDaemonProcess(t *testing.T) {
	role := os.Getenv(daemonHelperEnv)
	if role == "" {
		t.Skip("not a daemon helper process")
	}
	switch role {
	case roleAcquire:
		helperAcquire(t)
	case roleHold:
		helperHold(t)
	case roleSupervisor:
		helperSupervisor(t)
	case roleWorker:
		helperWorker(t)
	default:
		t.Fatalf("unknown helper role %q", role)
	}
}

func helperDir(t *testing.T) string {
	d := os.Getenv(daemonHelperDir)
	if d == "" {
		t.Fatal("helper has no " + daemonHelperDir)
	}
	return d
}

// helperAcquire 尝试取得守护所有权并把结果写进结果文件；取得后一直持有，
// 直到父进程写下 release 标记，保证所有并发尝试都发生在持有期间。
func helperAcquire(t *testing.T) {
	dir := helperDir(t)
	t.Setenv(confDirEnv, dir)
	lock, err := acquireDaemonLock()
	res := "ok"
	if err != nil {
		res = "busy"
	} else {
		defer lock.release()
	}
	if err := os.WriteFile(os.Getenv(daemonHelperOut), []byte(res), 0o644); err != nil {
		t.Fatal(err)
	}
	if err != nil {
		return
	}
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join(dir, daemonReleaseFile)); err == nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// helperHold 取得所有权后一直持有，直到被父进程强制终止（模拟异常退出）。
func helperHold(t *testing.T) {
	dir := helperDir(t)
	t.Setenv(confDirEnv, dir)
	lock, err := acquireDaemonLock()
	if err != nil {
		t.Fatalf("helper could not take the lock: %v", err)
	}
	defer lock.release()
	if err := os.WriteFile(os.Getenv(daemonHelperOut), []byte("ready"), 0o644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Minute)
}

func helperWorker(t *testing.T) {
	dir := helperDir(t)
	if err := os.WriteFile(filepath.Join(dir, daemonWorkerPID), []byte(itoa(os.Getpid())), 0o644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Minute)
}

// helperSupervisor 以测试的 worker 子进程跑真正的 superviseNode。
// 把自己的角色改成 worker，子进程继承环境后就会变成 worker。
func helperSupervisor(t *testing.T) {
	dir := helperDir(t)
	os.Setenv(confDirEnv, dir)
	os.Setenv(daemonHelperEnv, roleWorker)
	nodeWorkerArgs = []string{"-test.run=TestHelperDaemonProcess", "-test.timeout=5m"}
	if err := superviseNode(); err != nil {
		t.Logf("supervisor stopped: %v", err)
	}
}

func startDaemonHelper(t *testing.T, role, dir, out string) (*exec.Cmd, *bytes.Buffer) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=TestHelperDaemonProcess", "-test.timeout=5m")
	cmd.Env = append(os.Environ(),
		daemonHelperEnv+"="+role,
		daemonHelperDir+"="+dir,
	)
	if out != "" {
		cmd.Env = append(cmd.Env, daemonHelperOut+"="+out)
	}
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	if err := cmd.Start(); err != nil {
		t.Fatalf("start helper %s: %v", role, err)
	}
	return cmd, &buf
}

func waitForFileContent(t *testing.T, path string, timeout time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(path); err == nil && len(b) > 0 {
			return strings.TrimSpace(string(b))
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", path)
	return ""
}

// TestDaemonLockSingleOwnerAcrossProcesses 同目录并发启动只能有一个所有者。
func TestDaemonLockSingleOwnerAcrossProcesses(t *testing.T) {
	dir := t.TempDir()
	const n = 6
	cmds := make([]*exec.Cmd, n)
	outs := make([]string, n)
	for i := 0; i < n; i++ {
		outs[i] = filepath.Join(dir, "res"+itoa(i))
		cmds[i], _ = startDaemonHelper(t, roleAcquire, dir, outs[i])
	}
	for i := 0; i < n; i++ {
		waitForFileContent(t, outs[i], 60*time.Second)
	}
	// 所有尝试都出结果后，才让持有者释放。
	if err := os.WriteFile(filepath.Join(dir, daemonReleaseFile), []byte("go"), 0o644); err != nil {
		t.Fatal(err)
	}
	ok := 0
	for i := 0; i < n; i++ {
		if err := cmds[i].Wait(); err != nil {
			t.Fatalf("helper %d exited: %v", i, err)
		}
		if waitForFileContent(t, outs[i], time.Second) == "ok" {
			ok++
		}
	}
	if ok != 1 {
		t.Fatalf("owners=%d want exactly 1", ok)
	}
}

// TestDaemonLockReleasedAfterAbnormalExit supervisor 异常退出后必须能重新取得所有权。
func TestDaemonLockReleasedAfterAbnormalExit(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "hold.out")
	cmd, buf := startDaemonHelper(t, roleHold, dir, out)
	if got := waitForFileContent(t, out, 60*time.Second); got != "ready" {
		t.Fatalf("helper state=%q", got)
	}
	if pid, owned := probeDaemonLockWithDir(t, dir); !owned {
		t.Fatalf("lock was not held by the helper (pid %d)", pid)
	}
	// 强制终止：不给它任何清理机会，模拟异常退出。
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_, _ = cmd.Process.Wait()

	t.Setenv(confDirEnv, dir)
	lock, err := acquireDaemonLock()
	if err != nil {
		t.Fatalf("stale lock permanently blocked restart: %v (helper output: %s)", err, buf.String())
	}
	lock.release()
	if _, owned := probeDaemonLockWithDir(t, dir); owned {
		t.Fatal("lock still held after release")
	}
}

// TestDaemonLockScopedPerConfigDir 不同配置目录互不干扰。
func TestDaemonLockScopedPerConfigDir(t *testing.T) {
	a := t.TempDir()
	b := t.TempDir()
	t.Setenv(confDirEnv, a)
	lockA, err := acquireDaemonLock()
	if err != nil {
		t.Fatal(err)
	}
	defer lockA.release()
	t.Setenv(confDirEnv, b)
	lockB, err := acquireDaemonLock()
	if err != nil {
		t.Fatalf("another config dir must not be blocked: %v", err)
	}
	defer lockB.release()
}

// TestAcquireDaemonLockSurfacesOwner 未取得所有权时错误必须可定位。
func TestAcquireDaemonLockSurfacesOwner(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(confDirEnv, dir)
	lock, err := acquireDaemonLock()
	if err != nil {
		t.Fatal(err)
	}
	defer lock.release()
	_, err = acquireDaemonLock()
	if err == nil {
		t.Fatal("second acquire must fail")
	}
	if !strings.Contains(err.Error(), "已在运行") {
		t.Fatalf("error is not actionable: %v", err)
	}
}

// TestStartBuiltInDaemonWaitDoesNotStealLock 父进程等待子进程启动时绝不能抢锁：
// 一旦抢到，还没拿到锁的子进程就会误判"已在运行"而退出。
func TestStartBuiltInDaemonWaitDoesNotStealLock(t *testing.T) {
	dir := t.TempDir()
	sup, buf := startDaemonHelper(t, roleSupervisor, dir, "")
	t.Cleanup(func() {
		if sup.Process != nil {
			_ = sup.Process.Kill()
			_, _ = sup.Process.Wait()
		}
	})
	t.Setenv(confDirEnv, dir)
	waitForFileContent(t, filepath.Join(dir, daemonPIDName), 60*time.Second)

	owner := 0
	if err := waitForDaemonOwner(sup.Process.Pid, 10*time.Second, func(o int) { owner = o }); err != nil {
		t.Fatalf("wait for owner: %v (supervisor output: %s)", err, buf.String())
	}
	if owner != sup.Process.Pid {
		t.Fatalf("owner=%d want %d", owner, sup.Process.Pid)
	}
	// 关键：等待结束后锁必须仍然在子进程手里，没有被父进程抢走。
	if pid, owned := probeDaemonLock(); !owned {
		t.Fatalf("lock was stolen from the supervisor (pid file says %d)", pid)
	}
	if !pidAlive(sup.Process.Pid) {
		t.Fatal("supervisor died during the parent wait")
	}
}

// TestWaitForDaemonOwnerReportsExistingOwner 子进程抢不到锁时，父进程要说"已在运行"，
// 而不是含糊的"启动后立即退出"。
func TestWaitForDaemonOwnerReportsExistingOwner(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(confDirEnv, dir)
	foreign, _ := startDaemonHelper(t, roleHold, dir, filepath.Join(dir, "foreign.out"))
	t.Cleanup(func() {
		if foreign.Process != nil {
			_ = foreign.Process.Kill()
			_, _ = foreign.Process.Wait()
		}
	})
	waitForFileContent(t, filepath.Join(dir, "foreign.out"), 60*time.Second)

	// childPID 已不存在：父进程应当据此报出真正的持有者。
	err := waitForDaemonOwner(0, 2*time.Second, func(int) { t.Fatal("must not report success") })
	if err == nil {
		t.Fatal("expected an error when the child is gone")
	}
	if !strings.Contains(err.Error(), "已在运行") {
		t.Fatalf("error should name the running owner: %v", err)
	}
}

func probeDaemonLockWithDir(t *testing.T, dir string) (int, bool) {
	t.Helper()
	prev := os.Getenv(confDirEnv)
	t.Setenv(confDirEnv, dir)
	pid, owned := probeDaemonLock()
	t.Setenv(confDirEnv, prev)
	return pid, owned
}

// TestConfDirIsAbsoluteAndStable 相对 HW_CONF 只解析一次，子进程不会漂移到嵌套目录。
func TestConfDirIsAbsoluteAndStable(t *testing.T) {
	root := t.TempDir()
	t.Chdir(root)
	t.Setenv(confDirEnv, filepath.Join("cfg dir", "node"))
	want := filepath.Join(root, "cfg dir", "node")
	got := confDir()
	if got != want {
		t.Fatalf("confDir=%q want %q", got, want)
	}
	if !filepath.IsAbs(got) {
		t.Fatalf("confDir is not absolute: %q", got)
	}
	// 子进程切到配置目录后再解析，必须还是同一个目录。
	env := nodeChildEnv(os.Environ(), false)
	var pinned string
	for _, e := range env {
		if strings.HasPrefix(e, confDirEnv+"=") {
			pinned = strings.TrimPrefix(e, confDirEnv+"=")
		}
	}
	if pinned != want {
		t.Fatalf("child env %s=%q want %q", confDirEnv, pinned, want)
	}
	t.Chdir(got)
	if err := applyConfigDirFlag(pinned); err != nil {
		t.Fatal(err)
	}
	if after := confDir(); after != want {
		t.Fatalf("child confDir=%q want %q", after, want)
	}
	if _, err := os.Stat(filepath.Join(want, "cfg dir")); !os.IsNotExist(err) {
		t.Fatal("nested config directory was created")
	}
}

// TestAbsoluteConfDirSharedByProcesses 绝对 HW_CONF 下各进程读到同一份配置。
func TestAbsoluteConfDirSharedByProcesses(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(confDirEnv, dir)
	if got := confDir(); got != dir {
		t.Fatalf("confDir=%q want %q", got, dir)
	}
	if err := writeConf("node.conf", map[string]string{"hub": "hub.example"}); err != nil {
		t.Fatal(err)
	}
	if got := readConf("node.conf")["hub"]; got != "hub.example" {
		t.Fatalf("hub=%q", got)
	}
	if daemonLockPath() != filepath.Join(dir, daemonLockName) {
		t.Fatalf("lock path=%q", daemonLockPath())
	}
}

// TestDaemonChildEnvPinsConfDir 子进程环境固定绝对配置目录且不重复。
func TestDaemonChildEnvPinsConfDir(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(confDirEnv, dir)
	env := nodeChildEnv([]string{"HW_CONF=relative", "HW_DAEMON_CHILD=1", "OTHER=1"}, false)
	seen := 0
	for _, e := range env {
		switch {
		case e == confDirEnv+"="+dir:
			seen++
		case strings.HasPrefix(e, "HW_DAEMON_CHILD="):
			t.Fatalf("worker must not inherit the supervisor marker: %q", e)
		}
	}
	if seen != 1 {
		t.Fatalf("HW_CONF entries=%d in %v", seen, env)
	}
	sup := nodeChildEnv([]string{"OTHER=1"}, true)
	if !hasEnv(sup, daemonChildEnv+"=1") {
		t.Fatalf("supervisor env missing marker: %v", sup)
	}
}

func hasEnv(env []string, want string) bool {
	for _, e := range env {
		if e == want {
			return true
		}
	}
	return false
}

// TestDaemonLoopStopsAfterWorkerFailure worker 异常退出后按退避重启，停止后不再重启。
func TestDaemonLoopStopsAfterWorkerFailure(t *testing.T) {
	runs := 0
	sleeps := 0
	stop := make(chan struct{})
	last := daemonLoop(func() error {
		runs++
		if runs == 3 {
			close(stop)
		}
		return os.ErrClosed
	}, stop, func(time.Duration) { sleeps++ })
	if runs != 3 {
		t.Fatalf("runs=%d want 3", runs)
	}
	if sleeps != 2 {
		t.Fatalf("backoff sleeps=%d want 2", sleeps)
	}
	if last == nil {
		t.Fatal("daemonLoop must surface the last worker error")
	}
}

// TestRemoveOwnPIDFileLeavesForeignRecord 只清理属于自己的诊断记录。
func TestRemoveOwnPIDFileLeavesForeignRecord(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, daemonPIDName)
	if err := os.WriteFile(path, []byte("999999"), 0o644); err != nil {
		t.Fatal(err)
	}
	removeOwnPIDFile(path)
	if _, err := os.Stat(path); err != nil {
		t.Fatal("foreign pid record was removed")
	}
}
