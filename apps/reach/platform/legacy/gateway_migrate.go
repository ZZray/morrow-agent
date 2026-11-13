package main

// handwave migrate-gateway：显式网关配置迁移入口（默认只读预览，--apply 才写）。
//
// 旧的 cloud-model.json / upstreams.conf / hub.conf 只被快照、备份与提示，字节
// 永不修改，其供应商密钥不会被读取用于任何请求。新的 gateway.json 由显式给出的
// gateway root / 默认 model / 可选 protocol 与 token_env 生成，复用
// normalizeGatewayConfig、validateCloudTarget、gatewayclient、restrictFileAccess，
// 不新造第二套 registry 或 server，也不需要 hub server 在运行。
//
// 安全边界：
//   - 配置目录必须显式给出（-config-dir 或 HW_CONF）；缺失即报错，绝不猜测可写
//     目录、绝不写 .wtest 探针。dryrun 不创建任何目录/文件（零写）。
//   - --apply 时才创建配置目录与备份；目标 gateway.json 用“临时文件 + sync +
//     restrictFileAccess + 同 volume 硬链接”原子 no-replace 发布：目标已存在即
//     拒绝，平台不支持硬链接则明确失败，绝不退回会覆盖的 rename。
//   - 既有 gateway.json 归一化后等价 → byte-exact no-op（保护已绑定的 history）；
//     不同 → 明确拒绝（本 slice 不支持换 gateway root 或覆盖绑定 history）。目标非
//     普通文件或损坏 → 拒绝且不覆盖。
//   - 目标快照与候选序列化都受 maxGatewayConfigJSON 上界约束，避免写入后 Hub 拒绝。
//   - 输出只含目录状态 / 路径 / 模型 / 协议 / env 名称，绝不含令牌值或旧源内容。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// gatewayMigrateBackupPrefix 是迁移备份目录名的前缀（后接 UTC 时间戳）。
	gatewayMigrateBackupPrefix = "gateway-migrate-backup-"
	// maxMigrateSourceBytes 限制被快照/备份的旧源文件大小，避免误读巨物。
	maxMigrateSourceBytes = 1 << 20
)

var errMigrateRefused = errors.New("gateway migration refused")

// legacySourceNames 是需要预览与备份的旧 Hub 模型/供应商配置文件。它们只被快照
// 与备份，永不进入请求路径，也永不被修改。
var legacySourceNames = []string{"cloud-model.json", "upstreams.conf", "hub.conf"}

// migrateSnapshot 是单个文件在迁移开始时的一次快照（存在性 + 原始字节）。
type migrateSnapshot struct {
	name   string
	path   string
	exists bool
	bytes  []byte
}

// snapshotMigrateFile 读取一次快照。maxBytes 是运行时上界：目标用
// maxGatewayConfigJSON，旧源用 maxMigrateSourceBytes。非普通文件与超界都拒绝。
func snapshotMigrateFile(path string, maxBytes int64) (migrateSnapshot, error) {
	s := migrateSnapshot{name: filepath.Base(path), path: path}
	st, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	if !st.Mode().IsRegular() {
		return s, fmt.Errorf("%w: %s is not a regular file", errMigrateRefused, s.name)
	}
	if st.Size() > maxBytes {
		return s, fmt.Errorf("%w: %s is too large to snapshot", errMigrateRefused, s.name)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return s, err
	}
	s.exists = true
	s.bytes = b
	return s, nil
}

func sameMigrateSnapshot(a, b migrateSnapshot) bool {
	return a.exists == b.exists && bytes.Equal(a.bytes, b.bytes)
}

// migrateReport 是迁移结果的对外视图，只含非敏感信息。
type migrateReport struct {
	Dir        string   // 配置目录
	Root       string   // gateway root 主机名（不含路径）
	Model      string   // 默认模型 id
	Protocol   string   // 默认协议（可空）
	TokenEnv   string   // 令牌环境变量名（非值）
	ModelCount int      // 目录中的模型数量
	Noop       bool     // 既有配置等价，未写入
	Applied    bool     // 已写入 gateway.json
	Backup     string   // 备份目录路径（无备份时为空）
	Legacy     []string // 存在的旧源文件名
}

// gatewayMigrator 承载一次迁移的全部依赖，便于测试注入目录与解析器。
type gatewayMigrator struct {
	dir      string
	lookupIP func(context.Context, string) ([]net.IPAddr, error)
	now      func() time.Time
	out      io.Writer
	// beforeApply 是测试接缝：在“比较快照防并发变更”之前调用，生产为 nil。
	beforeApply func()
}

func newGatewayMigrator(dir string, out io.Writer) *gatewayMigrator {
	return &gatewayMigrator{
		dir: dir,
		lookupIP: func(ctx context.Context, host string) ([]net.IPAddr, error) {
			return net.DefaultResolver.LookupIPAddr(ctx, host)
		},
		now: time.Now,
		out: out,
	}
}

// resolveMigrateConfigDir 解析配置目录且无副作用：显式 -config-dir 优先，其次
// HW_CONF；两者都缺失时明确报错，绝不猜测可写目录、绝不创建目录。
func resolveMigrateConfigDir(explicit string) (string, error) {
	if d := strings.TrimSpace(explicit); d != "" {
		return filepath.Clean(d), nil
	}
	if d := strings.TrimSpace(os.Getenv("HW_CONF")); d != "" {
		return filepath.Clean(d), nil
	}
	return "", errors.New("必须显式指定配置目录：用 -config-dir 或设置 HW_CONF（不会猜测可写目录，也不会创建目录）")
}

func (m *gatewayMigrator) timestamp() time.Time {
	if m.now == nil {
		return time.Now()
	}
	return m.now()
}

// run 执行一次迁移。apply 为 false 时是只读预览（零写入，不创建目录）。candidate
// 必须已通过 normalizeGatewayConfig 校验且 root/model 非空。
func (m *gatewayMigrator) run(ctx context.Context, candidate gatewayConfig, apply bool) (migrateReport, error) {
	rep := migrateReport{
		Dir:      m.dir,
		Root:     mustURLHost(candidate.Root),
		Model:    candidate.DefaultModel,
		Protocol: candidate.DefaultProtocol,
		TokenEnv: effectiveTokenEnv(candidate),
	}
	targetPath := filepath.Join(m.dir, gatewayConfigFile)

	// 读取目标与旧源快照（仅在 CLI 运行时，绝不进入请求路径）。
	target, err := snapshotMigrateFile(targetPath, maxGatewayConfigJSON)
	if err != nil {
		return rep, err
	}
	sources, err := m.snapshotSources()
	if err != nil {
		return rep, err
	}
	for _, s := range sources {
		if s.exists {
			rep.Legacy = append(rep.Legacy, s.name)
		}
	}

	// 既有 gateway.json：等价 → no-op；损坏或不同 → 拒绝且不覆盖。
	if target.exists {
		var existing gatewayConfig
		if err := decodeStrictJSON(target.bytes, &existing); err != nil {
			return rep, fmt.Errorf("%w: existing %s is not a valid gateway configuration", errMigrateRefused, gatewayConfigFile)
		}
		norm, err := normalizeGatewayConfig(existing)
		if err != nil {
			return rep, fmt.Errorf("%w: existing %s is not a valid gateway configuration", errMigrateRefused, gatewayConfigFile)
		}
		if norm == candidate {
			// 既有配置等价：byte-exact no-op，保护已绑定的 history。
			rep.Noop = true
			return rep, nil
		}
		return rep, fmt.Errorf("%w: existing %s differs from the requested configuration; this slice does not replace a gateway root or overwrite history bound to it", errMigrateRefused, gatewayConfigFile)
	}

	// SSRF / HTTPS 策略与持久加载、PUT、CLI 覆盖一致。
	if err := validateCloudTarget(ctx, candidate.Root, candidate.AllowLoopback, m.lookupIP); err != nil {
		return rep, fmt.Errorf("gateway target rejected: %w", err)
	}

	// 候选目录校验：默认 model 必须存在，protocol 必须唯一可解析（否则拒绝）。
	store := &gatewayStore{path: targetPath, lookupIP: m.lookupIP}
	store.cfg = candidate
	cl, err := store.client(candidate)
	if err != nil {
		return rep, err
	}
	catalog, err := cl.Models(ctx)
	if err != nil {
		return rep, fmt.Errorf("%w: gateway directory unavailable: %v", errMigrateRefused, err)
	}
	if _, err := cl.Config(gatewayProviderName, candidate.DefaultModel, candidate.DefaultProtocol, catalog); err != nil {
		return rep, fmt.Errorf("%w: %v", errMigrateRefused, err)
	}
	rep.ModelCount = len(catalog)

	// 候选序列化上界：写入前先确认不会超过 Hub 读取上限。
	payload, err := marshalGatewayConfig(candidate)
	if err != nil {
		return rep, err
	}

	if !apply {
		// dryrun：只读预览，零写入（不创建配置目录、不写探针）。
		return rep, nil
	}

	if m.beforeApply != nil {
		m.beforeApply()
	}

	// 并发变更防护：先比较目标快照；备份完成后再比较旧源。目标的最后竞态由
	// 原子 no-replace 发布兜底。
	targetNow, err := snapshotMigrateFile(targetPath, maxGatewayConfigJSON)
	if err != nil {
		return rep, err
	}
	if !sameMigrateSnapshot(target, targetNow) {
		return rep, fmt.Errorf("%w: %s changed during migration", errMigrateRefused, gatewayConfigFile)
	}

	// apply 通过校验后才创建配置目录与备份。
	if err := os.MkdirAll(m.dir, 0o700); err != nil {
		return rep, fmt.Errorf("%w: cannot create configuration directory", errMigrateRefused)
	}
	backup, err := m.writeBackup(sources)
	if err != nil {
		return rep, err
	}
	rep.Backup = backup

	// 备份完成后再比较旧源（覆盖备份窗口内的并发变更）。
	if err := m.compareSources(sources); err != nil {
		return rep, err
	}

	if err := writeSecretAtomicNoReplace(targetPath, payload); err != nil {
		return rep, fmt.Errorf("%w: %v", errMigrateRefused, err)
	}
	rep.Applied = true
	return rep, nil
}

func (m *gatewayMigrator) snapshotSources() ([]migrateSnapshot, error) {
	sources := make([]migrateSnapshot, 0, len(legacySourceNames))
	for _, name := range legacySourceNames {
		s, err := snapshotMigrateFile(filepath.Join(m.dir, name), maxMigrateSourceBytes)
		if err != nil {
			return nil, err
		}
		sources = append(sources, s)
	}
	return sources, nil
}

func (m *gatewayMigrator) compareSources(want []migrateSnapshot) error {
	for i, name := range legacySourceNames {
		now, err := snapshotMigrateFile(filepath.Join(m.dir, name), maxMigrateSourceBytes)
		if err != nil {
			return err
		}
		if !sameMigrateSnapshot(want[i], now) {
			return fmt.Errorf("%w: legacy source %s changed during migration", errMigrateRefused, name)
		}
	}
	return nil
}

// marshalGatewayConfig 序列化候选配置并强制 maxGatewayConfigJSON 上界，保证写入的
// gateway.json 一定能被 Hub 读取。
func marshalGatewayConfig(cfg gatewayConfig) ([]byte, error) {
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return nil, err
	}
	if len(b) > maxGatewayConfigJSON {
		return nil, fmt.Errorf("%w: %s would exceed the %d-byte limit", errMigrateRefused, gatewayConfigFile, maxGatewayConfigJSON)
	}
	return b, nil
}

// writeBackup 在配置目录下创建 0700、名字唯一（不可覆盖）的备份目录，写入所有存在
// 的旧源原始字节。Mkdir 在已存在时失败，绝不覆盖既有备份。
func (m *gatewayMigrator) writeBackup(sources []migrateSnapshot) (string, error) {
	dir := filepath.Join(m.dir, gatewayMigrateBackupPrefix+m.timestamp().UTC().Format("20060102T150405.000000000Z"))
	if err := os.Mkdir(dir, 0o700); err != nil {
		return "", fmt.Errorf("%w: cannot create backup directory", errMigrateRefused)
	}
	for _, s := range sources {
		if !s.exists {
			continue
		}
		if err := writeSecretAtomic(filepath.Join(dir, s.name), s.bytes); err != nil {
			return "", err
		}
	}
	return dir, nil
}

// writeSecretAtomicNoReplace 像 writeSecretAtomic 一样安全地写临时文件（0700 父目录、
// restrictFileAccess、fsync），但用同 volume 硬链接发布：目标已存在则拒绝，平台不
// 支持硬链接则明确失败，绝不退回会覆盖的 rename。仅用于迁移新建 gateway.json，不改
// 动既有 gatewayStore.save 的稳定路径。
func writeSecretAtomicNoReplace(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if st, err := os.Lstat(path); err == nil && !st.Mode().IsRegular() {
		return errors.New("refusing non-regular configuration file")
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	f, err := os.CreateTemp(dir, ".gateway-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := restrictFileAccess(tmp); err != nil {
		f.Close()
		return err
	}
	_, writeErr := f.Write(data)
	syncErr := f.Sync()
	closeErr := f.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		return err
	}
	if err := os.Link(tmp, path); err != nil {
		if os.IsExist(err) || errors.Is(err, os.ErrExist) {
			return errors.New("target already exists; refusing to replace it")
		}
		return errors.New("atomic no-replace install is not supported on this filesystem")
	}
	// Both names refer to the same secured file. Reapplying its ACL after
	// publication could report failure even though the new target is installed.
	return nil
}

// printMigrateReport 只输出目录状态 / 路径 / 模型 / 协议 / env 名称，绝不含令牌值
// 或旧源内容。
func printMigrateReport(out io.Writer, rep migrateReport) {
	where := fmt.Sprintf("%s（模型 %s%s，token_env=%s）", rep.Root, rep.Model, protocolSuffix(rep.Protocol), rep.TokenEnv)
	fmt.Fprintf(out, "配置目录：%s\n", rep.Dir)
	switch {
	case rep.Noop:
		fmt.Fprintf(out, "网关配置已等价存在：%s；byte-exact no-op，未写入任何文件。\n", where)
	case rep.Applied:
		fmt.Fprintf(out, "已写入 %s：%s（目录 %d 个模型）。\n", gatewayConfigFile, where, rep.ModelCount)
	default:
		fmt.Fprintf(out, "[dryrun] 预览：将写入 %s：%s（目录 %d 个模型）；未写入任何文件（加 --apply 才写入）。\n", gatewayConfigFile, where, rep.ModelCount)
	}
	if len(rep.Legacy) > 0 {
		fmt.Fprintf(out, "检测到旧模型/供应商配置：%s（仅快照与备份，字节未改，未读取其密钥）。\n", strings.Join(rep.Legacy, ", "))
	}
	if rep.Backup != "" {
		fmt.Fprintf(out, "备份目录：%s\n", rep.Backup)
	}
}

// runMigrateGateway 是 handwave migrate-gateway 的 CLI 入口。
func runMigrateGateway(args []string) error {
	fs := flag.NewFlagSet("migrate-gateway", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	configDirF := fs.String("config-dir", "", "配置目录（缺省读 HW_CONF；两者都缺失则报错，不会猜测）")
	gatewayF := fs.String("gateway", "", "共享网关 root（如 https://gw.example；必填）")
	modelF := fs.String("model", "", "显式默认模型 id（必填；不从旧配置显示名或 plan_model 推断）")
	protocolF := fs.String("protocol", "", "显式默认协议（多协议模型必须显式选择）")
	tokenEnvF := fs.String("gateway_token_env", "", "网关服务令牌所在环境变量名（默认 HW_GATEWAY_TOKEN）")
	loopbackF := fs.Bool("allow_loopback", false, "允许网关 root 指向本机回环地址（默认拒绝）")
	applyF := fs.Bool("apply", false, "真正写入 gateway.json（默认仅只读预览）")
	if err := fs.Parse(args); err != nil {
		return err
	}
	root := strings.TrimSpace(*gatewayF)
	model := strings.TrimSpace(*modelF)
	if root == "" {
		return errors.New("必须显式提供 -gateway 网关 root")
	}
	if model == "" {
		return errors.New("必须显式提供 -model 默认模型 id")
	}
	dir, err := resolveMigrateConfigDir(*configDirF)
	if err != nil {
		return err
	}
	candidate, err := normalizeGatewayConfig(gatewayConfig{
		Root:            root,
		TokenEnv:        strings.TrimSpace(*tokenEnvF),
		DefaultModel:    model,
		DefaultProtocol: strings.TrimSpace(*protocolF),
		AllowLoopback:   *loopbackF,
	})
	if err != nil {
		return err
	}
	m := newGatewayMigrator(dir, os.Stdout)
	ctx, cancel := context.WithTimeout(context.Background(), gatewayTestTimeout)
	defer cancel()
	rep, err := m.run(ctx, candidate, *applyF)
	if err != nil {
		return err
	}
	printMigrateReport(m.out, rep)
	return nil
}
