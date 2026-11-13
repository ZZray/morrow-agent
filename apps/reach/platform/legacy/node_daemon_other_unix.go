//go:build unix && !linux

package main

import "syscall"

func workerProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{}
}
