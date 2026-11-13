package main

// handwave migrate-gateway 的聚焦测试：dryrun 零写、apply/readback、旧源字节保留
// 与备份相等、幂等、既有不同/损坏目标拒绝、目录失败/不兼容/歧义不写、并发变更拒绝、
// 输出不泄 secret。全部走真实的 gatewayclient + SSRF 生产路径（离线 httptest 网关）。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newMigratorForTest(dir string) (*gatewayMigrator, *bytes.Buffer) {
	out := &bytes.Buffer{}
	return &gatewayMigrator{
		dir:      dir,
		lookupIP: net.DefaultResolver.LookupIPAddr,
		now:      time.Now,
		out:      out,
	}, out
}

func migrateCandidate(url, model string) gatewayConfig {
	return gatewayConfig{Root: url, DefaultModel: model, TokenEnv: "HW_GATEWAY_TOKEN", AllowLoopback: true}
}

func writeFileAt(t *testing.T, dir, name string, data []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func backupDirs(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), gatewayMigrateBackupPrefix) {
			out = append(out, e.Name())
		}
	}
	return out
}

func assertNoSecret(t *testing.T, s string) {
	t.Helper()
	for _, secret := range []string{gwTestSecret, "legacy-secret-key", "root-secret"} {
		if strings.Contains(s, secret) {
			t.Fatalf("migration output leaked a secret %q: %q", secret, s)
		}
	}
}

func TestMigrateGatewayDryRunWritesNothing(t *testing.T) {
	dir := skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "deepseek-flash", Protocols: []string{"openai-completions"}}})
	cloud := []byte(`{"source":"omp","provider":"cas"}`)
	upstreams := []byte("[cas]\nbase_url=https://x.invalid/v1\napi_key=legacy-secret-key\n")
	hub := []byte("listen=:8443\ntoken=root-secret\ngateway=https://gw.example\n")
	writeFileAt(t, dir, "cloud-model.json", cloud)
	writeFileAt(t, dir, "upstreams.conf", upstreams)
	writeFileAt(t, dir, "hub.conf", hub)

	m, out := newMigratorForTest(dir)
	rep, err := m.run(context.Background(), migrateCandidate(f.Server.URL, "deepseek-flash"), false)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Applied || rep.Noop {
		t.Fatalf("dryrun reported a write: %#v", rep)
	}
	if _, err := os.Stat(filepath.Join(dir, gatewayConfigFile)); !os.IsNotExist(err) {
		t.Fatal("dryrun created gateway.json")
	}
	if dirs := backupDirs(t, dir); len(dirs) != 0 {
		t.Fatalf("dryrun created backups: %v", dirs)
	}
	for name, want := range map[string][]byte{"cloud-model.json": cloud, "upstreams.conf": upstreams, "hub.conf": hub} {
		if got, _ := os.ReadFile(filepath.Join(dir, name)); !bytes.Equal(got, want) {
			t.Fatalf("dryrun modified legacy source %s", name)
		}
	}
	if len(rep.Legacy) != 3 {
		t.Fatalf("legacy sources not listed: %v", rep.Legacy)
	}
	printMigrateReport(out, rep)
	assertNoSecret(t, out.String())
}

func TestMigrateGatewayApplyWritesBackupAndPreservesLegacy(t *testing.T) {
	dir := skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1", Protocols: []string{"openai-completions"}}})
	cloud := []byte(`{"source":"omp"}`)
	upstreams := []byte("[cas]\napi_key=legacy-secret-key\n")
	writeFileAt(t, dir, "cloud-model.json", cloud)
	writeFileAt(t, dir, "upstreams.conf", upstreams)

	m, _ := newMigratorForTest(dir)
	rep, err := m.run(context.Background(), migrateCandidate(f.Server.URL, "m1"), true)
	if err != nil {
		t.Fatal(err)
	}
	if !rep.Applied || rep.Backup == "" {
		t.Fatalf("apply did not report a write and backup: %#v", rep)
	}
	b, err := os.ReadFile(filepath.Join(dir, gatewayConfigFile))
	if err != nil {
		t.Fatal(err)
	}
	var cfg gatewayConfig
	if err := json.Unmarshal(b, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Root != f.Server.URL || cfg.DefaultModel != "m1" || cfg.TokenEnv != "HW_GATEWAY_TOKEN" {
		t.Fatalf("written config mismatch: %#v", cfg)
	}
	if bytes.Contains(b, []byte(gwTestSecret)) {
		t.Fatal("gateway token value was written to gateway.json")
	}
	// 旧源字节保持不变。
	for name, want := range map[string][]byte{"cloud-model.json": cloud, "upstreams.conf": upstreams} {
		if got, _ := os.ReadFile(filepath.Join(dir, name)); !bytes.Equal(got, want) {
			t.Fatalf("apply modified legacy source %s", name)
		}
		got, err := os.ReadFile(filepath.Join(rep.Backup, name))
		if err != nil {
			t.Fatalf("backup missing %s: %v", name, err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("backup of %s does not equal the original bytes", name)
		}
	}
}

func TestMigrateGatewayApplyIsIdempotent(t *testing.T) {
	dir := skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	m, _ := newMigratorForTest(dir)
	cand := migrateCandidate(f.Server.URL, "m1")

	first, err := m.run(context.Background(), cand, true)
	if err != nil || !first.Applied {
		t.Fatalf("first apply: %#v %v", first, err)
	}
	before, err := os.ReadFile(filepath.Join(dir, gatewayConfigFile))
	if err != nil {
		t.Fatal(err)
	}
	backups := backupDirs(t, dir)

	second, err := m.run(context.Background(), cand, true)
	if err != nil {
		t.Fatal(err)
	}
	if !second.Noop || second.Applied {
		t.Fatalf("second run was not a no-op: %#v", second)
	}
	after, err := os.ReadFile(filepath.Join(dir, gatewayConfigFile))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("idempotent run rewrote gateway.json")
	}
	if got := backupDirs(t, dir); len(got) != len(backups) {
		t.Fatalf("idempotent run created a backup: %v", got)
	}
}

func TestMigrateGatewayRefusesExistingDifferentOrCorruptOrNonRegular(t *testing.T) {
	dir := skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	m, _ := newMigratorForTest(dir)
	cand := migrateCandidate(f.Server.URL, "m1")

	// 既有不同 gateway 配置：拒绝且不覆盖，以保护已绑定的 history。
	existing := []byte(`{"gateway_root":"https://other.example","default_model":"m1"}`)
	writeFileAt(t, dir, gatewayConfigFile, existing)
	if _, err := m.run(context.Background(), cand, true); !errors.Is(err, errMigrateRefused) {
		t.Fatalf("different existing config accepted: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, gatewayConfigFile)); !bytes.Equal(got, existing) {
		t.Fatal("refused run modified gateway.json")
	}
	if dirs := backupDirs(t, dir); len(dirs) != 0 {
		t.Fatalf("refused run created a backup: %v", dirs)
	}

	// 损坏目标：拒绝且不覆盖。
	corrupt := []byte("{not json")
	writeFileAt(t, dir, gatewayConfigFile, corrupt)
	if _, err := m.run(context.Background(), cand, true); !errors.Is(err, errMigrateRefused) {
		t.Fatalf("corrupt target accepted: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, gatewayConfigFile)); !bytes.Equal(got, corrupt) {
		t.Fatal("corrupt target was overwritten")
	}

	// 非普通目标（目录）：拒绝。
	if err := os.Remove(filepath.Join(dir, gatewayConfigFile)); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, gatewayConfigFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := m.run(context.Background(), cand, true); !errors.Is(err, errMigrateRefused) {
		t.Fatalf("non-regular target accepted: %v", err)
	}
}

func TestMigrateGatewayDirectoryValidationRefusesWithoutWriting(t *testing.T) {
	dir := skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	m, _ := newMigratorForTest(dir)
	target := filepath.Join(dir, gatewayConfigFile)

	// 目录不可用。
	down := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	down.Directory = func(w http.ResponseWriter, r *http.Request) bool {
		http.Error(w, "boom "+gwTestSecret, http.StatusInternalServerError)
		return true
	}
	if _, err := m.run(context.Background(), migrateCandidate(down.Server.URL, "m1"), true); !errors.Is(err, errMigrateRefused) {
		t.Fatalf("directory failure accepted: %v", err)
	}

	// 协议不兼容（模型未声明该协议）。
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1", Protocols: []string{"openai-completions"}}})
	incompatible := migrateCandidate(f.Server.URL, "m1")
	incompatible.DefaultProtocol = "anthropic-messages"
	if _, err := m.run(context.Background(), incompatible, true); !errors.Is(err, errMigrateRefused) {
		t.Fatalf("incompatible protocol accepted: %v", err)
	}

	// 协议歧义（多协议未显式选择）。
	f2 := newGatewayFixture(t, []gwTestModel{{ID: "m1", Protocols: []string{"openai-completions", "anthropic-messages"}}})
	if _, err := m.run(context.Background(), migrateCandidate(f2.Server.URL, "m1"), true); !errors.Is(err, errMigrateRefused) {
		t.Fatalf("ambiguous protocol accepted: %v", err)
	}

	// 模型不存在。
	if _, err := m.run(context.Background(), migrateCandidate(f.Server.URL, "nope"), true); !errors.Is(err, errMigrateRefused) {
		t.Fatalf("missing model accepted: %v", err)
	}

	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("a directory validation failure still wrote gateway.json")
	}
}

func TestMigrateGatewayRefusesConcurrentSourceChange(t *testing.T) {
	dir := skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	writeFileAt(t, dir, "upstreams.conf", []byte("api_key=before\n"))

	m, _ := newMigratorForTest(dir)
	m.beforeApply = func() {
		writeFileAt(t, dir, "upstreams.conf", []byte("api_key=after\n"))
	}
	if _, err := m.run(context.Background(), migrateCandidate(f.Server.URL, "m1"), true); !errors.Is(err, errMigrateRefused) {
		t.Fatalf("concurrent source change accepted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, gatewayConfigFile)); !os.IsNotExist(err) {
		t.Fatal("concurrent source change still wrote gateway.json")
	}
}

func TestMigrateGatewayRejectsUnsafeTargets(t *testing.T) {
	dir := skillTestConf(t)
	m, _ := newMigratorForTest(dir)
	m.lookupIP = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("10.0.0.8")}}, nil
	}
	if _, err := m.run(context.Background(), gatewayConfig{Root: "https://private.example", DefaultModel: "m"}, true); !errors.Is(err, errCloudUnsafeTarget) {
		t.Fatalf("private target accepted: %v", err)
	}
	// 回环未显式开启 -> 拒绝（真实解析器）。
	m.lookupIP = net.DefaultResolver.LookupIPAddr
	if _, err := m.run(context.Background(), gatewayConfig{Root: "http://127.0.0.1:9", DefaultModel: "m"}, true); !errors.Is(err, errCloudUnsafeTarget) {
		t.Fatalf("loopback without opt-in accepted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, gatewayConfigFile)); !os.IsNotExist(err) {
		t.Fatal("an unsafe target still wrote gateway.json")
	}
}

func TestMigrateGatewayCLIRequiresExplicitInputsAndLeaksNoSecret(t *testing.T) {
	dir := skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	if err := runMigrateGateway(nil); err == nil {
		t.Fatal("missing -gateway was accepted")
	}
	if err := runMigrateGateway([]string{"-gateway", "https://gw.example"}); err == nil {
		t.Fatal("missing -model was accepted")
	}

	f := newGatewayFixture(t, []gwTestModel{{ID: "m1", Protocols: []string{"openai-completions"}}})
	writeFileAt(t, dir, "cloud-model.json", []byte(`{"api_key":"legacy-secret-key"}`))
	out, err := captureStdout(t, func() error {
		return runMigrateGateway([]string{"-gateway", f.Server.URL, "-model", "m1", "-allow_loopback", "--apply"})
	})
	if err != nil {
		t.Fatal(err)
	}
	assertNoSecret(t, out)
	if !strings.Contains(out, "已写入") {
		t.Fatalf("apply output missing: %q", out)
	}
	if _, err := os.Stat(filepath.Join(dir, gatewayConfigFile)); err != nil {
		t.Fatalf("CLI apply did not write gateway.json: %v", err)
	}
}

func captureStdout(t *testing.T, fn func() error) (string, error) {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	runErr := fn()
	_ = w.Close()
	os.Stdout = old
	b, _ := io.ReadAll(r)
	_ = r.Close()
	return string(b), runErr
}

func TestMigrateGatewayApplyCreatesNewConfigDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "not-created")
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("precondition: config dir should not exist")
	}
	m, _ := newMigratorForTest(dir)
	rep, err := m.run(context.Background(), migrateCandidate(f.Server.URL, "m1"), true)
	if err != nil {
		t.Fatal(err)
	}
	if !rep.Applied || rep.Backup == "" {
		t.Fatalf("apply to a new dir did not write and back up: %#v", rep)
	}
	if _, err := os.Stat(filepath.Join(dir, gatewayConfigFile)); err != nil {
		t.Fatalf("gateway.json not created in the new dir: %v", err)
	}
}

func TestMigrateGatewayDryRunDoesNotCreateDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "not-created")
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	m, _ := newMigratorForTest(dir)
	if _, err := m.run(context.Background(), migrateCandidate(f.Server.URL, "m1"), false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("dryrun created the configuration directory: %v", err)
	}
}

func TestWriteSecretAtomicNoReplaceRefusesExisting(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, gatewayConfigFile)
	original := []byte("existing-bytes")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeSecretAtomicNoReplace(path, []byte("new-bytes")); err == nil {
		t.Fatal("no-replace install overwrote an existing target")
	}
	if got, _ := os.ReadFile(path); !bytes.Equal(got, original) {
		t.Fatal("existing target was modified")
	}
	fresh := filepath.Join(dir, "fresh.json")
	if err := writeSecretAtomicNoReplace(fresh, []byte("hello")); err != nil {
		t.Fatalf("no-replace install failed on a fresh target: %v", err)
	}
	if got, _ := os.ReadFile(fresh); string(got) != "hello" {
		t.Fatalf("fresh install content = %q", got)
	}
}

func TestMigrateGatewayRejectsOversizeTargetSnapshot(t *testing.T) {
	dir := skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	big := bytes.Repeat([]byte("a"), maxGatewayConfigJSON+1)
	writeFileAt(t, dir, gatewayConfigFile, big)
	m, _ := newMigratorForTest(dir)
	if _, err := m.run(context.Background(), migrateCandidate(f.Server.URL, "m1"), true); !errors.Is(err, errMigrateRefused) {
		t.Fatalf("oversize target accepted: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, gatewayConfigFile)); !bytes.Equal(got, big) {
		t.Fatal("oversize target was modified")
	}
}

func TestMarshalGatewayConfigEnforcesSizeBound(t *testing.T) {
	huge := gatewayConfig{Root: "https://" + strings.Repeat("a", maxGatewayConfigJSON) + ".example", DefaultModel: "m"}
	if _, err := marshalGatewayConfig(huge); !errors.Is(err, errMigrateRefused) {
		t.Fatalf("oversize candidate accepted: %v", err)
	}
	b, err := marshalGatewayConfig(gatewayConfig{Root: "https://gw.example", DefaultModel: "m"})
	if err != nil || len(b) == 0 {
		t.Fatalf("valid candidate rejected: %v", err)
	}
}
