//go:build unix

package main

import (
	"os"
	"syscall"
)

func supervisorProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	return syscall.Kill(pid, 0) == nil
}

// lockFile 取跨进程排他劝告锁，非阻塞。持有进程异常退出时由内核释放。
func lockFile(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}

func unlockFile(f *os.File) {
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
}

// newProcessGroup 在 unix 上不建组：Linux 已用 Pdeathsig 让 worker 随父进程退出。
func newProcessGroup() (processGroup, error) {
	return noopGroup{}, nil
}
