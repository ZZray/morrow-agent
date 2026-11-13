# 显式网关配置迁移（handwave migrate-gateway）

把旧的 Hub 模型/供应商配置迁移到共享网关时，用一条**显式**、默认只读的 CLI 完成，
不需要启动 hub server，也不会改动任何旧源文件。

## 命令

```
handwave migrate-gateway [-config-dir DIR] -gateway URL -model M [-protocol P] [-gateway_token_env ENV] [-allow_loopback] [--apply]
```

- 显式输入：`-gateway`（网关 root）、`-model`（默认模型 id）必填；`-protocol`
  在模型声明多协议时必须显式选择；`-gateway_token_env` 默认 `HW_GATEWAY_TOKEN`。
- **配置目录必须显式给出**：`-config-dir` 优先，其次 `HW_CONF`；两者都缺失时明确
  报错。本命令**不调用带副作用的 `confDir()`**，绝不猜测可写目录、绝不写 `.wtest`
  探针，dryrun 也不创建目录。这是新命令，无历史 flag 兼容负担。
- **不从旧配置的显示名或 `plan_model` 猜测模型**，也不复制旧 raw keys、不读取 OMP。
- 默认 **dryrun 零写**；只有 `--apply` 才写入 `gateway.json`，并在通过全部校验后才
  创建配置目录与备份。

## 校验（复用既有生产路径）

- 复用 `normalizeGatewayConfig`（root/协议/环境变量名合法性）、`validateCloudTarget`
  （HTTPS / SSRF / `allow_loopback` 策略，与持久加载、PUT、CLI 覆盖一致）。
- 复用共享 `gatewayclient` 拉取 `GET {root}/v1/models` 并 `Config`：默认模型必须存在，
  协议必须唯一可解析（缺失/歧义/不兼容都是拒绝，绝不静默回退）。目录通过**不等于**
  余额或供应商健康。

## 安全与幂等

- 旧源 `cloud-model.json` / `upstreams.conf` / `hub.conf` 只被**快照、备份、提示**，
  字节永不修改，其供应商密钥不被读取用于任何请求，输出也不含其内容。
- `--apply` 先比较目标快照，再创建 0700、名字唯一（已存在即失败，绝不覆盖）的备份
  目录写入旧源原始字节；**备份完成后再次比较旧源**防并发变更；最后原子落盘。
- 新建目标用 **no-replace 原子发布**：同 volume 临时文件 + `fsync` +
  `restrictFileAccess` 后用 `os.Link` 发布，目标已存在即拒绝（并发进程抢建的
  `gateway.json` 绝不被覆盖）；文件系统不支持硬链接则**明确失败**，绝不退回会覆盖的
  `rename`。该函数只用于迁移新建目标，不改动既有 `gatewayStore.save` 的稳定路径。
- 目标快照与候选序列化都受运行时 `maxGatewayConfigJSON` 上界约束，避免写入后 Hub
  读取时拒绝；未改动全局 schema。
- 既有 `gateway.json` 归一化后与请求**等价 → byte-exact no-op**（保护已绑定的
  history，离线可判）；**不同 → 明确拒绝**（本 slice 不支持换 gateway root 或覆盖绑定
  history，也不做通用跨网关转换）。目标非普通文件或损坏 → 拒绝且不覆盖。
- 输出只含目录状态 / 路径 / 模型 / 协议 / env 名称，绝不含令牌值或旧源内容。

## 权限说明

- `restrictFileAccess` 在 Windows 上只**收紧单个文件的 ACL**（当前用户 + SYSTEM 的
  DACL）；它对**目录不生效**，也不保证目录权限。目录仅以 `MkdirAll(0o700)` 创建，在
  Windows 上 mode 基本被忽略，故**不声称 Windows 上目录 0700 生效**。非 Windows 平台
  仍按 `chmod 0600` 收紧文件。

## 边界

- 只迁移 `gateway.json` 的显式 root/model/protocol/token_env；多个旧源同时存在不会
  阻断已明确 root/model 的输入。
- 不触碰 device 授权、Node/UI、tool-loop 与原真实配置服务；不新造第二套 registry 或
  server。凭证仍只由网关持有（Hub 只存环境变量名）。
- 证据：`apps/handwave/gateway_migrate_test.go`（dryrun 零写、apply/readback、apply 新
  目录、目录零写、旧源字节保留 + 备份相等、幂等、既有不同/损坏/非普通目标拒绝、目录
  失败/不兼容/歧义不写、并发变更拒绝、no-replace 拒绝既有目标、目标/候选上界拒绝、
  SSRF 拒绝、输出无 secret）与 `coordinator_migrate_probe_test.go`（并发抢建
  `gateway.json` 不被覆盖、dryrun 不创建配置目录）。
