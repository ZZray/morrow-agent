package main

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseRunFlagsLongOptions(t *testing.T) {
	hub, tok, daemon, dir, err := parseRunFlags([]string{"--hub", "hub.example", "--token", "secret", "--daemon"})
	if err != nil {
		t.Fatal(err)
	}
	if hub != "hub.example" || tok != "secret" || !daemon {
		t.Fatalf("hub=%q token=%q daemon=%v", hub, tok, daemon)
	}
	if dir != "" {
		t.Fatalf("dir=%q", dir)
	}
}

func TestParseRunFlagsConfigDir(t *testing.T) {
	_, _, _, dir, err := parseRunFlags([]string{"--config-dir", `C:\cfg dir`, "--daemon"})
	if err != nil {
		t.Fatal(err)
	}
	if dir != `C:\cfg dir` {
		t.Fatalf("dir=%q", dir)
	}
}

func TestParseServiceFlagsRejectsExtras(t *testing.T) {
	_, _, err := parseServiceFlags([]string{"--hub", "h", "extra"})
	if err == nil || !strings.Contains(err.Error(), "extra") {
		t.Fatalf("err=%v", err)
	}
}

func TestAutostartOff(t *testing.T) {
	_, _, off, err := parseAutostartFlags([]string{"--off"})
	if err != nil || !off {
		t.Fatalf("off=%v err=%v", off, err)
	}
}

func TestSystemdUnitsStayForeground(t *testing.T) {
	exe := `/opt/handwave/handwave`
	dir := `/var/lib/handwave`
	system := systemdSystemUnit(exe, dir)
	user := systemdUserUnit(exe, dir)
	for _, body := range []string{system, user} {
		if strings.Contains(body, "--daemon") {
			t.Fatalf("service unit must not nest the built-in daemon:\n%s", body)
		}
		if !strings.Contains(body, "ExecStart="+exe+" node\n") {
			t.Fatalf("exec start:\n%s", body)
		}
		if strings.Contains(body, "secret-token") {
			t.Fatal("unit must not carry the enrollment token")
		}
	}
	if !strings.Contains(system, "WantedBy=multi-user.target") {
		t.Fatal(system)
	}
	if !strings.Contains(user, "WantedBy=default.target") {
		t.Fatal(user)
	}
}

func TestWindowsAutostartUsesDaemon(t *testing.T) {
	got := windowsAutostartCommand(`C:\Program Files\handwave.exe`, `C:\ProgramData\handwave`)
	want := `"C:\Program Files\handwave.exe" node --daemon --config-dir C:\ProgramData\handwave`
	if got != want {
		t.Fatalf("got %q", got)
	}
}

// 开机启动的进程拿不到原终端的 HW_CONF，配置目录必须固化在命令行里。
func TestAutostartCommandKeepsConfigDirWithSpaces(t *testing.T) {
	dir := `C:\my handwave conf`
	got := windowsAutostartCommand(`C:\Program Files\handwave.exe`, dir)
	if !strings.Contains(got, "--config-dir "+quoteCmd(dir)) {
		t.Fatalf("autostart command lost the config dir: %q", got)
	}
	if !strings.Contains(got, `"C:\my handwave conf"`) {
		t.Fatalf("config dir is not quoted: %q", got)
	}
}

// 结尾反斜杠不能把闭合引号转义掉。
func TestQuoteCmdTrailingBackslash(t *testing.T) {
	got := quoteCmd(`D:\my conf\`)
	if got != `"D:\my conf\\"` {
		t.Fatalf("got %q", got)
	}
}

// 模拟登录环境：没有 HW_CONF 时，自启动命令行仍能定位原配置目录。
func TestAutostartConfigDirSurvivesCleanEnv(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "conf dir")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := windowsAutostartCommand(`C:\Program Files\handwave.exe`, dir)

	// 解析出 --config-dir 的值（按 Windows 引号规则还原）。
	_, rest, ok := strings.Cut(cmd, " --config-dir ")
	if !ok {
		t.Fatalf("autostart command has no config dir: %q", cmd)
	}
	quoted := strings.TrimSpace(rest)
	if !strings.HasPrefix(quoted, `"`) || !strings.HasSuffix(quoted, `"`) {
		t.Fatalf("config dir is not quoted: %q", quoted)
	}
	flagDir := strings.ReplaceAll(quoted[1:len(quoted)-1], `""`, `"`)

	t.Setenv(confDirEnv, "")
	if err := applyConfigDirFlag(flagDir); err != nil {
		t.Fatal(err)
	}
	if got := confDir(); got != dir {
		t.Fatalf("clean-env conf dir=%q want %q", got, dir)
	}
}

func TestDaemonLoopStops(t *testing.T) {
	n := 0
	stop := make(chan struct{})
	daemonLoop(func() error {
		n++
		if n == 2 {
			close(stop)
		}
		return nil
	}, stop, func(time.Duration) {})
	if n != 2 {
		t.Fatalf("restarts=%d", n)
	}
}

func TestEnvWithoutDaemonMarker(t *testing.T) {
	got := envWithout([]string{"A=1", daemonChildEnv + "=1", "B=2"}, daemonChildEnv)
	if strings.Join(got, ",") != "A=1,B=2" {
		t.Fatalf("%v", got)
	}
}

func TestParseRunFlagsHelp(t *testing.T) {
	_, _, _, _, err := parseRunFlags([]string{"--help"})
	if err != flag.ErrHelp {
		t.Fatalf("err=%v", err)
	}
}
