//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// 子进程独立控制台，避免继承 reach.exe 的控制台；taskkill /T 杀整棵进程树。
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true}
}

func killTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	k := exec.Command("taskkill", "/PID", itoa(cmd.Process.Pid), "/T", "/F")
	k.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = k.Run()
}
