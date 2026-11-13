//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func isWindowsService() bool { return false }

func runNodeAsService(hub, tok string) error {
	_ = hub
	_ = tok
	return fmt.Errorf("Linux 被控端不走 Windows 服务；请直接运行，或使用 handwave node install")
}

func nodeServiceInstall(args []string) error {
	hubFlag, tokFlag, err := parseServiceFlags(args)
	if err != nil {
		return err
	}
	if os.Geteuid() != 0 {
		return fmt.Errorf("安装系统服务需要 root：sudo handwave node install --hub <地址> --token <入网令牌>")
	}
	if fileExists(userUnitPath()) {
		return fmt.Errorf("已设置开机启动，请先执行：handwave node autostart --off")
	}
	if pid, ok := readPIDFile(daemonPIDPath()); ok && pidAlive(pid) {
		return fmt.Errorf("内置守护已在运行（pid %d）。先停止该进程，再安装服务", pid)
	}
	hub, _, err := saveNodeEndpoint(hubFlag, tokFlag)
	if err != nil {
		return err
	}
	exe, err := nodeExe()
	if err != nil {
		return err
	}
	dir := confDir()
	if err := os.WriteFile(nodeSystemUnit, []byte(systemdSystemUnit(exe, dir)), 0o644); err != nil {
		return fmt.Errorf("写入 %s：%w", nodeSystemUnit, err)
	}
	if err := runSystemctl("daemon-reload"); err != nil {
		return err
	}
	if err := runSystemctl("enable", "--now", nodeUnitName); err != nil {
		return err
	}
	fmt.Printf("已安装并启动 systemd 服务 %s\n  exe: %s node\n  hub: %s\n  conf: %s\n",
		nodeUnitName, exe, hub, dir+"/node.conf")
	return nil
}

func nodeServiceUninstall(args []string) error {
	if len(args) > 0 {
		return fmt.Errorf("uninstall 不接受参数")
	}
	if os.Geteuid() != 0 {
		return fmt.Errorf("卸载系统服务需要 root：sudo handwave node uninstall")
	}
	if !fileExists(nodeSystemUnit) {
		return fmt.Errorf("服务未安装")
	}
	_ = runSystemctl("disable", "--now", nodeUnitName)
	if err := os.Remove(nodeSystemUnit); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := runSystemctl("daemon-reload"); err != nil {
		return err
	}
	fmt.Printf("已卸载服务 %s\n", nodeUnitName)
	return nil
}

func nodeServiceStart(args []string) error {
	_ = args
	if !fileExists(nodeSystemUnit) {
		return fmt.Errorf("服务未安装，先执行：sudo handwave node install --hub <地址> --token <入网令牌>")
	}
	if err := runSystemctl("start", nodeUnitName); err != nil {
		return err
	}
	fmt.Println("服务已启动")
	return nil
}

func nodeServiceStop(args []string) error {
	_ = args
	if !fileExists(nodeSystemUnit) {
		return fmt.Errorf("服务未安装")
	}
	if err := runSystemctl("stop", nodeUnitName); err != nil {
		return err
	}
	fmt.Println("服务已停止")
	return nil
}

func nodeServiceStatus(args []string) error {
	_ = args
	if !fileExists(nodeSystemUnit) {
		fmt.Printf("服务 %s：未安装\n", nodeUnitName)
		return nil
	}
	out, err := exec.Command("systemctl", "is-active", nodeUnitName).CombinedOutput()
	state := strings.TrimSpace(string(out))
	if state == "" && err != nil {
		state = err.Error()
	}
	fmt.Printf("服务 %s：%s\n", nodeUnitName, state)
	return nil
}

func nodeAutostart(args []string) error {
	hubFlag, tokFlag, off, err := parseAutostartFlags(args)
	if err != nil {
		return err
	}
	path := userUnitPath()
	if path == "" {
		return fmt.Errorf("无法定位用户配置目录")
	}
	if off {
		_ = runSystemctl("--user", "disable", "--now", nodeUnitName)
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		_ = runSystemctl("--user", "daemon-reload")
		fmt.Println("已关闭开机启动")
		return nil
	}
	if fileExists(nodeSystemUnit) {
		return fmt.Errorf("已安装系统服务。若只想要开机启动，请先：sudo handwave node uninstall")
	}
	if _, _, err := saveNodeEndpoint(hubFlag, tokFlag); err != nil {
		return err
	}
	exe, err := nodeExe()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(systemdUserUnit(exe, confDir())), 0o644); err != nil {
		return err
	}
	if err := runSystemctl("--user", "daemon-reload"); err != nil {
		return err
	}
	if err := runSystemctl("--user", "enable", "--now", nodeUnitName); err != nil {
		return err
	}
	fmt.Printf("已设置开机启动（用户服务，同一个被控端程序）\n  %s\n", path)
	user := os.Getenv("USER")
	if user == "" {
		user = os.Getenv("LOGNAME")
	}
	if err := exec.Command("loginctl", "enable-linger", user).Run(); err != nil {
		fmt.Println("未打开 linger：当前会在登录后启动。若要未登录也开机启动，请执行：sudo loginctl enable-linger $USER")
	} else {
		fmt.Println("已打开 linger：未登录也会在开机时启动")
	}
	return nil
}

func runSystemctl(args ...string) error {
	cmd := exec.Command("systemctl", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			return err
		}
		return fmt.Errorf("%s: %s", err, msg)
	}
	return nil
}
