//go:build !windows && !linux

package main

import "fmt"

func isWindowsService() bool { return false }

func runNodeAsService(hub, tok string) error {
	_ = hub
	_ = tok
	return fmt.Errorf("当前平台不支持以 Windows 服务方式运行")
}

func nodeServiceInstall(args []string) error {
	_ = args
	return fmt.Errorf("node install 仅支持 Windows（管理员）：handwave node install")
}

func nodeServiceUninstall(args []string) error {
	_ = args
	return fmt.Errorf("node uninstall 仅支持 Windows")
}

func nodeServiceStart(args []string) error {
	_ = args
	return fmt.Errorf("node start 仅支持 Windows")
}

func nodeServiceStop(args []string) error {
	_ = args
	return fmt.Errorf("node stop 仅支持 Windows")
}

func nodeServiceStatus(args []string) error {
	_ = args
	return fmt.Errorf("node status 仅支持 Windows 与 Linux；前台运行请直接：handwave node")
}

func nodeAutostart(args []string) error {
	_ = args
	return fmt.Errorf("开机启动仅支持 Windows 与 Linux")
}
