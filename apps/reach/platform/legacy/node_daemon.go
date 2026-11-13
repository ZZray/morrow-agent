package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// daemonStartTimeout 是父进程等待子进程真正取得守护所有权的上限。
const daemonStartTimeout = 10 * time.Second

// nodeWorkerArgs 是被守护进程的命令行参数。测试可把它替换成测试用子进程。
var nodeWorkerArgs = []string{"node"}

// processGroup 收拢 supervisor 本次启动拥有的子进程。supervisor 被终止时，
// 组内进程必须一起退出，且只能影响本 supervisor 自己启动的进程。
type processGroup interface {
	add(pid int) error
	terminate() error
	release()
}

// noopGroup 用于没有跨进程进程组概念的平台（Linux 已用 Pdeathsig 覆盖）。
type noopGroup struct{}

func (noopGroup) add(int) error    { return nil }
func (noopGroup) terminate() error { return nil }
func (noopGroup) release()         {}

// daemonLock 是对 node.lock 持有的跨进程排他锁。操作系统在进程异常退出时
// 自动释放，因此残留文件不会永久阻止重新启动。
type daemonLock struct {
	file *os.File
}

func startBuiltInDaemon() error {
	if pid, ok := probeDaemonLock(); ok {
		if pid > 0 {
			return fmt.Errorf("内置守护已在运行（pid %d）", pid)
		}
		return fmt.Errorf("内置守护已在运行")
	}
	exe, err := nodeExe()
	if err != nil {
		return err
	}
	dir := confDir()
	logPath := filepath.Join(dir, "node.log")
	logf, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "node")
	cmd.Env = nodeChildEnv(os.Environ(), true)
	cmd.Dir = dir
	cmd.Stdout = logf
	cmd.Stderr = logf
	cmd.Stdin = nil
	cmd.SysProcAttr = supervisorProcAttr()
	if err := cmd.Start(); err != nil {
		logf.Close()
		return err
	}
	logf.Close()
	return waitForDaemonOwner(cmd.Process.Pid, daemonStartTimeout, func(owner int) {
		fmt.Printf("内置守护已启动 pid %d\n日志 %s\n停止：向该 pid 发送终止信号\n", owner, logPath)
	})
}

// waitForDaemonOwner 等子进程真正取得守护所有权后才算启动成功。
// 这里只读 node.pid 这个诊断信号（子进程取到锁之后才写、退出时删除），
// 绝不再去抢锁：父进程一旦抢到，还没拿到锁的子进程就会误判"已在运行"而退出。
func waitForDaemonOwner(childPID int, timeout time.Duration, done func(owner int)) error {
	time.Sleep(200 * time.Millisecond)
	deadline := time.Now().Add(timeout)
	logPath := filepath.Join(confDir(), "node.log")
	for {
		if pid, ok := readPIDFile(daemonPIDPath()); ok && pid == childPID && pidAlive(pid) {
			done(pid)
			return nil
		}
		if !pidAlive(childPID) {
			// 子进程已经没了，此时才敢去查锁：另一个守护可能刚抢在我们前面起来。
			if pid, owned := probeDaemonLock(); owned {
				return fmt.Errorf("%s", daemonRunningMessage(pid))
			}
			return fmt.Errorf("内置守护进程启动后立即退出（pid %d），原因见 %s", childPID, logPath)
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("内置守护未能在 %s 内取得所有权，原因见 %s", timeout, logPath)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func superviseNode() error {
	exe, err := nodeExe()
	if err != nil {
		return err
	}
	dir := confDir()
	lock, err := acquireDaemonLock()
	if err != nil {
		// 未取得所有权：不写 pid、不覆盖他人的记录，直接把原因交给调用方。
		return err
	}
	defer lock.release()

	pidPath := daemonPIDPath()
	if err := os.WriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())), 0o644); err != nil {
		return err
	}
	defer removeOwnPIDFile(pidPath)

	logPath := filepath.Join(dir, "node.log")
	logf, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer logf.Close()

	group, err := newProcessGroup()
	if err != nil {
		nodeLogf(logf, "supervisor process group unavailable, worker dies only on explicit stop: %v", err)
	}
	defer group.release()

	stop := make(chan struct{})
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sig)

	var mu sync.Mutex
	var current *os.Process
	go func() {
		<-sig
		close(stop)
		mu.Lock()
		p := current
		mu.Unlock()
		if p != nil {
			_ = p.Kill()
		}
	}()

	nodeLogf(logf, "supervisor start pid=%d conf=%s", os.Getpid(), dir)
	err = daemonLoop(func() error {
		cmd := exec.Command(exe, nodeWorkerArgs...)
		cmd.Env = nodeChildEnv(os.Environ(), false)
		cmd.Dir = dir
		cmd.Stdout = logf
		cmd.Stderr = logf
		cmd.SysProcAttr = workerProcAttr()
		if err := cmd.Start(); err != nil {
			nodeLogf(logf, "worker start failed: %v", err)
			return err
		}
		mu.Lock()
		current = cmd.Process
		stopped := false
		select {
		case <-stop:
			stopped = true
		default:
		}
		mu.Unlock()
		if stopped {
			_ = cmd.Process.Kill()
		}
		if err := group.add(cmd.Process.Pid); err != nil {
			nodeLogf(logf, "worker pid=%d not attached to supervisor group: %v", cmd.Process.Pid, err)
		}
		err := cmd.Wait()
		mu.Lock()
		current = nil
		mu.Unlock()
		nodeLogf(logf, "worker pid=%d exited: %v", cmd.Process.Pid, err)
		return err
	}, stop, time.Sleep)
	// 用户停止不是失败：不要把一个"被杀"的 worker 退出码当成守护错误报出去。
	select {
	case <-stop:
		err = nil
	default:
	}
	// 停止后收拢本次拥有的进程组：只作用于本 supervisor 加入的进程。
	if gerr := group.terminate(); gerr != nil {
		nodeLogf(logf, "supervisor group terminate: %v", gerr)
	}
	nodeLogf(logf, "supervisor stop pid=%d", os.Getpid())
	return err
}

// acquireDaemonLock 取得守护所有权；已被持有时返回可定位的错误。
func acquireDaemonLock() (*daemonLock, error) {
	path := daemonLockPath()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, fmt.Errorf("打开守护锁 %s：%w", path, err)
	}
	if err := lockFile(f); err != nil {
		f.Close()
		if pid, ok := readPIDFile(path); ok && pid != os.Getpid() {
			return nil, fmt.Errorf("内置守护已在运行（pid %d，锁 %s）", pid, path)
		}
		return nil, fmt.Errorf("内置守护已在运行（锁 %s）", path)
	}
	if err := f.Truncate(0); err == nil {
		if _, err := f.Seek(0, io.SeekStart); err == nil {
			// 仅作诊断记录，互斥由上面的锁保证。
			fmt.Fprintf(f, "%d\n", os.Getpid())
		}
	}
	return &daemonLock{file: f}, nil
}

// probeDaemonLock 探测锁是否已被持有，返回持有者 pid（可能读不到）。
func probeDaemonLock() (int, bool) {
	path := daemonLockPath()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return 0, false
	}
	defer f.Close()
	if err := lockFile(f); err != nil {
		// 锁被别人持有。Windows 上 LockFileEx 是强制锁，被锁住的文件别的进程读不到，
		// 所以持有者 pid 要从诊断用的 node.pid 拿，而不是去读锁文件。
		pid, _ := daemonOwnerPID()
		return pid, true
	}
	unlockFile(f)
	return 0, false
}

// daemonOwnerPID 读出当前守护持有者的 pid 供提示用；读不到返回 false。
func daemonOwnerPID() (int, bool) {
	if pid, ok := readPIDFile(daemonPIDPath()); ok {
		return pid, true
	}
	return readPIDFile(daemonLockPath())
}

// daemonRunningMessage 生成"已在运行"的可定位提示。
func daemonRunningMessage(pid int) string {
	if pid > 0 {
		return fmt.Sprintf("内置守护已在运行（pid %d）", pid)
	}
	return fmt.Sprintf("内置守护已在运行（另一进程持有 %s）", daemonLockPath())
}

func (l *daemonLock) release() {
	if l == nil || l.file == nil {
		return
	}
	unlockFile(l.file)
	_ = l.file.Close()
	l.file = nil
}

// removeOwnPIDFile 只在 pid 文件仍属于自己的时候清理，避免删掉别人的诊断记录。
func removeOwnPIDFile(path string) {
	if pid, ok := readPIDFile(path); !ok || pid != os.Getpid() {
		return
	}
	_ = os.Remove(path)
}

// nodeChildEnv 固定子进程使用的配置目录（绝对路径），避免相对 HW_CONF 随工作目录漂移。
func nodeChildEnv(base []string, daemonChild bool) []string {
	env := envWithout(base, confDirEnv)
	env = append(env, confDirEnv+"="+confDir())
	if daemonChild {
		return append(env, daemonChildEnv+"=1")
	}
	return envWithout(env, daemonChildEnv)
}

func nodeLogf(w io.Writer, format string, args ...any) {
	if w == nil {
		return
	}
	fmt.Fprintf(w, "%s "+format+"\n", append([]any{time.Now().Format(time.RFC3339)}, args...)...)
}
