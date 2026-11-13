//go:build windows

package main

import (
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func supervisorProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		CreationFlags: windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP,
	}
}

func workerProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
}

func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	_ = windows.CloseHandle(h)
	return true
}

// lockFile 取跨进程排他锁，非阻塞。持有进程异常退出时由操作系统释放句柄，
// 残留的锁文件因此不会永久阻止下一次启动。
func lockFile(f *os.File) error {
	var ov windows.Overlapped
	return windows.LockFileEx(windows.Handle(f.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &ov)
}

func unlockFile(f *os.File) {
	var ov windows.Overlapped
	_ = windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &ov)
}

// jobGroup 是 supervisor 私有的 Job Object。加入其中的 worker 会在 supervisor
// 进程消失（包括被强制终止）时由操作系统一并终止。
type jobGroup struct {
	handle windows.Handle
}

func newProcessGroup() (processGroup, error) {
	h, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return noopGroup{}, err
	}
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(h, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(h)
		return noopGroup{}, err
	}
	return &jobGroup{handle: h}, nil
}

func (j *jobGroup) add(pid int) error {
	p, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(p)
	return windows.AssignProcessToJobObject(j.handle, p)
}

func (j *jobGroup) terminate() error {
	return windows.TerminateJobObject(j.handle, 1)
}

func (j *jobGroup) release() {
	_ = windows.CloseHandle(j.handle)
}
