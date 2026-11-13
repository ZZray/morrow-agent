package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	daemonChildEnv  = "HW_DAEMON_CHILD"
	confDirEnv      = "HW_CONF"
	daemonLockName  = "node.lock"
	daemonPIDName   = "node.pid"
	nodeUnitName    = "handwave-node.service"
	nodeSystemUnit  = "/etc/systemd/system/handwave-node.service"
	windowsRunKey   = `Software\Microsoft\Windows\CurrentVersion\Run`
	windowsRunValue = "HandwaveNode"
)

func nodeUsage() string {
	return `handwave node [--hub URL] [--token T] [--daemon] [--config-dir DIR]
  默认前台程序。--daemon 启动内置守护：脱离终端，进程退出后重新拉起。
handwave node install --hub URL --token T
  安装为系统服务并开机启动。Windows 需管理员，Linux 需 root。
handwave node uninstall
  卸载系统服务。
handwave node autostart [--hub URL] [--token T]
  不安装系统服务，开机或登录时启动同一个程序。
handwave node autostart --off
  关闭开机启动。
handwave node start|stop|status
`
}

func parseServiceFlags(args []string) (hub, token string, err error) {
	fs := flag.NewFlagSet("node install", flag.ContinueOnError)
	var buf strings.Builder
	fs.SetOutput(&buf)
	hubF := fs.String("hub", "", "hub 地址")
	tokF := fs.String("token", "", "入网令牌")
	if err = fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Fprint(os.Stderr, nodeUsage())
			return "", "", flag.ErrHelp
		}
		msg := strings.TrimSpace(buf.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", "", fmt.Errorf("%s", msg)
	}
	if fs.NArg() > 0 {
		return "", "", fmt.Errorf("无法识别的参数：%s", strings.Join(fs.Args(), " "))
	}
	return *hubF, *tokF, nil
}

func parseRunFlags(args []string) (hub, token string, daemon bool, dir string, err error) {
	fs := flag.NewFlagSet("node", flag.ContinueOnError)
	var buf strings.Builder
	fs.SetOutput(&buf)
	hubF := fs.String("hub", "", "hub 地址")
	tokF := fs.String("token", "", "入网令牌")
	daemonF := fs.Bool("daemon", false, "内置守护：脱离终端，退出后重新拉起")
	dirF := fs.String("config-dir", "", "配置目录（缺省读 HW_CONF，再缺省按 exe 同级 / ~/.handwave 定位）")
	if err = fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return "", "", false, "", flag.ErrHelp
		}
		msg := strings.TrimSpace(buf.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", "", false, "", fmt.Errorf("%s", msg)
	}
	if fs.NArg() > 0 {
		return "", "", false, "", fmt.Errorf("无法识别的参数：%s", strings.Join(fs.Args(), " "))
	}
	return *hubF, *tokF, *daemonF, *dirF, nil
}

func parseAutostartFlags(args []string) (hub, token string, off bool, err error) {
	fs := flag.NewFlagSet("node autostart", flag.ContinueOnError)
	var buf strings.Builder
	fs.SetOutput(&buf)
	hubF := fs.String("hub", "", "hub 地址")
	tokF := fs.String("token", "", "入网令牌")
	offF := fs.Bool("off", false, "关闭开机启动")
	if err = fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Fprint(os.Stderr, nodeUsage())
			return "", "", false, flag.ErrHelp
		}
		msg := strings.TrimSpace(buf.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", "", false, fmt.Errorf("%s", msg)
	}
	if fs.NArg() > 0 {
		return "", "", false, fmt.Errorf("无法识别的参数：%s", strings.Join(fs.Args(), " "))
	}
	return *hubF, *tokF, *offF, nil
}

func saveNodeEndpoint(flagHub, flagTok string) (hub, tok string, err error) {
	conf := readConf("node.conf")
	hub = firstNonEmpty(flagHub, conf["hub"], os.Getenv("HW_HUB"), defaultHub)
	tok = firstNonEmpty(flagTok, conf["token"], os.Getenv("HW_TOKEN"), defaultToken)
	conf["hub"] = hub
	conf["token"] = tok
	if err = writeConf("node.conf", conf); err != nil {
		return "", "", fmt.Errorf("写 node.conf：%w", err)
	}
	return hub, tok, nil
}

func nodeExe() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Abs(exe)
}

func systemdQuote(s string) string {
	if s == "" {
		return `""`
	}
	if strings.ContainsAny(s, " \t\n\"'\\") {
		return strconv.Quote(s)
	}
	return s
}

func systemdExec(exe string, args ...string) string {
	parts := append([]string{exe}, args...)
	var b strings.Builder
	for i, p := range parts {
		if i > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(systemdQuote(p))
	}
	return b.String()
}

func systemdSystemUnit(exe, dir string) string {
	return "[Unit]\n" +
		"Description=handwave node\n" +
		"After=network-online.target\n" +
		"Wants=network-online.target\n\n" +
		"[Service]\n" +
		"Type=simple\n" +
		"Environment=HW_CONF=" + systemdQuote(dir) + "\n" +
		"WorkingDirectory=" + systemdQuote(dir) + "\n" +
		"ExecStart=" + systemdExec(exe, "node") + "\n" +
		"Restart=on-failure\n" +
		"RestartSec=3\n\n" +
		"[Install]\n" +
		"WantedBy=multi-user.target\n"
}

func systemdUserUnit(exe, dir string) string {
	return "[Unit]\n" +
		"Description=handwave node\n" +
		"After=network-online.target\n\n" +
		"[Service]\n" +
		"Type=simple\n" +
		"Environment=HW_CONF=" + systemdQuote(dir) + "\n" +
		"WorkingDirectory=" + systemdQuote(dir) + "\n" +
		"ExecStart=" + systemdExec(exe, "node") + "\n" +
		"Restart=on-failure\n" +
		"RestartSec=3\n\n" +
		"[Install]\n" +
		"WantedBy=default.target\n"
}

func userUnitPath() string {
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "systemd", "user", nodeUnitName)
	}
	h, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(h, ".config", "systemd", "user", nodeUnitName)
}

// windowsAutostartCommand 生成登录时拉起的命令。配置目录必须写进命令行：
// 开机启动的进程拿不到原终端的环境变量，否则会退回默认目录。
func windowsAutostartCommand(exe, dir string) string {
	cmd := quoteCmd(exe) + " node --daemon"
	if dir = strings.TrimSpace(dir); dir != "" {
		cmd += " --config-dir " + quoteCmd(dir)
	}
	return cmd
}

// quoteCmd 按 Windows 命令行规则加引号：内部引号翻倍，结尾反斜杠成对，
// 避免结尾的 \ 把闭合引号转义掉。
func quoteCmd(s string) string {
	if !strings.ContainsAny(s, " \t\"") {
		return s
	}
	body := strings.ReplaceAll(s, `"`, `""`)
	if strings.HasSuffix(body, `\`) {
		body += `\`
	}
	return `"` + body + `"`
}

func fileExists(path string) bool {
	st, err := os.Stat(path)
	return err == nil && !st.IsDir()
}

func daemonPIDPath() string {
	return filepath.Join(confDir(), daemonPIDName)
}

func daemonLockPath() string {
	return filepath.Join(confDir(), daemonLockName)
}

// applyConfigDirFlag 在启动边界把配置目录解析并固定为绝对路径，
// 之后入口、supervisor、worker 与开机启动都使用同一个目录。
func applyConfigDirFlag(dir string) error {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return nil
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return fmt.Errorf("解析配置目录 %q：%w", dir, err)
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return fmt.Errorf("创建配置目录 %s：%w", abs, err)
	}
	return os.Setenv(confDirEnv, abs)
}

func readPIDFile(path string) (int, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || n <= 0 {
		return 0, false
	}
	return n, true
}

func envWithout(base []string, key string) []string {
	prefix := key + "="
	out := make([]string, 0, len(base))
	for _, e := range base {
		if strings.HasPrefix(e, prefix) {
			continue
		}
		out = append(out, e)
	}
	return out
}

// daemonLoop restarts run until stop is closed. sleep is called between attempts.
// 返回最后一次运行的错误：worker 自身的退出码不视为守护失败。
func daemonLoop(run func() error, stop <-chan struct{}, sleep func(time.Duration)) error {
	back := time.Second
	var last error
	for {
		select {
		case <-stop:
			return last
		default:
		}
		last = run()
		select {
		case <-stop:
			return last
		default:
		}
		sleep(back)
		if back < 30*time.Second {
			back *= 2
			if back > 30*time.Second {
				back = 30 * time.Second
			}
		}
	}
}
