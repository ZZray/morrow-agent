//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	nodeServiceName = "HandwaveNode"
	nodeServiceDisp = "handwave Node"
	nodeServiceDesc = "handwave thin remote agent：连 hub，执行命令与文件读写"
)

func isWindowsService() bool {
	ok, err := svc.IsWindowsService()
	return err == nil && ok
}

func runNodeAsService(hub, tok string) error {
	return svc.Run(nodeServiceName, &nodeSVC{hub: hub, tok: tok})
}

type nodeSVC struct {
	hub, tok string
}

func (m *nodeSVC) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}

	a, err := newNodeAgent(m.hub, m.tok)
	if err != nil {
		return true, 1
	}
	done := make(chan error, 1)
	go func() { done <- a.loop() }()

	changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	_ = eventlogInfo("handwave node 已启动，指纹 " + a.id.FP)

	for {
		select {
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				changes <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				changes <- svc.Status{State: svc.StopPending}
				select {
				case <-a.quit:
				default:
					close(a.quit)
				}
				select {
				case <-done:
				case <-time.After(15 * time.Second):
				}
				changes <- svc.Status{State: svc.Stopped}
				return false, 0
			}
		case err := <-done:
			if err != nil {
				_ = eventlogError("handwave node 退出: " + err.Error())
				return true, 1
			}
			changes <- svc.Status{State: svc.Stopped}
			return false, 0
		}
	}
}

func eventlogInfo(msg string) error {
	el, err := eventlog.Open(nodeServiceName)
	if err != nil {
		return err
	}
	defer el.Close()
	return el.Info(1, msg)
}

func eventlogError(msg string) error {
	el, err := eventlog.Open(nodeServiceName)
	if err != nil {
		return err
	}
	defer el.Close()
	return el.Error(1, msg)
}

func nodeServiceInstall(args []string) error {
	hubFlag, tokFlag, err := parseServiceFlags(args)
	if err != nil {
		return err
	}
	if windowsAutostartSet() {
		return fmt.Errorf("已设置开机启动，请先执行：handwave node autostart --off")
	}
	if pid, ok := readPIDFile(daemonPIDPath()); ok && pidAlive(pid) {
		return fmt.Errorf("内置守护已在运行（pid %d）。先停止该进程，再安装服务", pid)
	}
	hub, _, err := saveNodeEndpoint(hubFlag, tokFlag)
	if err != nil {
		return err
	}

	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, err = filepath.Abs(exe)
	if err != nil {
		return err
	}

	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("连接服务管理器失败（需管理员权限）：%w", err)
	}
	defer m.Disconnect()

	if s, err := m.OpenService(nodeServiceName); err == nil {
		s.Close()
		return fmt.Errorf("服务 %s 已存在；先执行：handwave node uninstall", nodeServiceName)
	}

	s, err := m.CreateService(nodeServiceName, exe, mgr.Config{
		DisplayName:      nodeServiceDisp,
		Description:      nodeServiceDesc,
		StartType:        mgr.StartAutomatic,
		ServiceStartName: "",
	}, "node")
	if err != nil {
		return fmt.Errorf("创建服务失败：%w", err)
	}
	defer s.Close()

	_ = eventlog.InstallAsEventCreate(nodeServiceName, eventlog.Error|eventlog.Warning|eventlog.Info)
	_ = s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 15 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 60 * time.Second},
	}, uint32((24 * time.Hour).Seconds()))

	if err := s.Start(); err != nil {
		fmt.Printf("服务已安装但启动失败：%v\n可手动：handwave node start\n", err)
		return nil
	}
	fmt.Printf("已安装并启动 Windows 服务 %s\n  exe: %s node\n  hub: %s\n  conf: %s\n",
		nodeServiceName, exe, hub, filepath.Join(confDir(), "node.conf"))
	return nil
}

func nodeServiceUninstall(args []string) error {
	_ = args
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("连接服务管理器失败（需管理员权限）：%w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(nodeServiceName)
	if err != nil {
		return fmt.Errorf("服务不存在：%s", nodeServiceName)
	}
	defer s.Close()
	_, _ = s.Control(svc.Stop)
	for i := 0; i < 30; i++ {
		st, err := s.Query()
		if err != nil || st.State == svc.Stopped {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if err := s.Delete(); err != nil {
		return err
	}
	_ = eventlog.Remove(nodeServiceName)
	fmt.Printf("已卸载服务 %s\n", nodeServiceName)
	return nil
}

func nodeServiceStart(args []string) error {
	_ = args
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(nodeServiceName)
	if err != nil {
		return err
	}
	defer s.Close()
	if err := s.Start(); err != nil {
		return err
	}
	fmt.Println("服务已启动")
	return nil
}

func nodeServiceStop(args []string) error {
	_ = args
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(nodeServiceName)
	if err != nil {
		return err
	}
	defer s.Close()
	if _, err := s.Control(svc.Stop); err != nil {
		return err
	}
	fmt.Println("服务已停止")
	return nil
}

func nodeServiceStatus(args []string) error {
	_ = args
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(nodeServiceName)
	if err != nil {
		fmt.Printf("服务 %s：未安装\n", nodeServiceName)
		return nil
	}
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return err
	}
	state := map[svc.State]string{
		svc.Stopped:         "已停止",
		svc.StartPending:    "正在启动",
		svc.StopPending:     "正在停止",
		svc.Running:         "运行中",
		svc.ContinuePending: "继续中",
		svc.PausePending:    "暂停中",
		svc.Paused:          "已暂停",
	}[st.State]
	if state == "" {
		state = fmt.Sprintf("状态码 %d", st.State)
	}
	fmt.Printf("服务 %s：%s\n", nodeServiceName, state)
	return nil
}

func windowsAutostartSet() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, windowsRunKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	_, _, err = k.GetStringValue(windowsRunValue)
	return err == nil
}

func nodeAutostart(args []string) error {
	hubFlag, tokFlag, off, err := parseAutostartFlags(args)
	if err != nil {
		return err
	}
	k, _, err := registry.CreateKey(registry.CURRENT_USER, windowsRunKey, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return fmt.Errorf("打开启动项失败：%w", err)
	}
	defer k.Close()
	if off {
		if err := k.DeleteValue(windowsRunValue); err != nil && !errors.Is(err, registry.ErrNotExist) {
			return err
		}
		fmt.Println("已关闭开机启动")
		return nil
	}
	if windowsServiceInstalled() {
		return fmt.Errorf("已安装系统服务。若只想要开机启动，请先：handwave node uninstall")
	}
	if _, _, err := saveNodeEndpoint(hubFlag, tokFlag); err != nil {
		return err
	}
	exe, err := nodeExe()
	if err != nil {
		return err
	}
	cmd := windowsAutostartCommand(exe, confDir())
	if err := k.SetStringValue(windowsRunValue, cmd); err != nil {
		return err
	}
	fmt.Printf("已设置开机启动（当前用户登录时拉起内置守护）\n  %s\n", cmd)
	return nil
}

func windowsServiceInstalled() bool {
	m, err := mgr.Connect()
	if err != nil {
		return false
	}
	defer m.Disconnect()
	s, err := m.OpenService(nodeServiceName)
	if err != nil {
		return false
	}
	s.Close()
	return true
}
