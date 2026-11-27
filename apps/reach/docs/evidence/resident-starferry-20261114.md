# 常驻服务、`ryreach`、受管 OpenSSH 与 Starferry 连接合并验证证据（2026-11-14）

作者：Ray Zhang（Ray）。日期：2026-11-14（Asia/Taipei）。命名空间：RY。

范围：M11–M14（对应 `REQ-01`–`REQ-06`）本地常驻状态机、`ryreach` CLI 初始化/预配置、分钟级远程可调心跳与断网退避、默认 OpenSSH 检测与配对受管公钥生命周期、Starferry（UDP 直连 + 云端中转回退 + 零自动重放）合并实现与独立安全复核。主任务验收计数严格保持 **0/52**（Reach Desk 保持 **0/5**），未访问 Ray 服务器，未建设 QSpin 运行时/网关/IPC/子进程集成。

## 1. 实现与上游出处说明

| 模块 | 新增/更新文件 | 核心能力与安全不变量 |
| --- | --- | --- |
| M11 独立常驻与 `ryreach`（REQ-03 / REQ-05 / REQ-06） | `src/node/resident.rs`、`src/node/ryreach_main.rs`、`src/node/{main.rs,control.rs,windows_host.rs,pairing.rs,api.rs}`、`packaging/windows/{install.ps1,ownership.ps1,maintenance-writes.ps1}`、`packaging/windows/setup/src/main.rs` | 六态可观察状态机（`等待初始化` / `等待配对` / `连接中` / `已连接` / `离线退避` / `认证/配置错误`）；服务绝不读 `stdin`；首次交互 `ryreach` 输入地址后不再重问；按规范化源地址隔离凭据（换服务器绝不向新服务器发送旧凭据）；提供幂等防覆盖 `preconfigure` 与安装器 `--server-url` 入口 |
| M12 分钟级远程可调心跳与退避（REQ-04） | `src/service/node-runtime-store.ts`、`src/contracts/protocol.ts`、`src/node/runtime.rs`、`src/controller/{mcp.ts,main.ts}` | 即时控制轮询（`/api/v1/node/poll`）与分钟级状态心跳（`/api/v1/node/heartbeat`，默认 60s，支持 `30..3600s` 远程调整）完全解耦；离线期间下发配置保持 `pending` 不冒充已生效；回执丢失自动重发收敛；单一调度器有上限指数退避（默认 5s 起、5min 上限、含抖动），未知操作零重放 |
| M13 默认启用 SSH 与受管配对授权（REQ-02） | `src/node/ssh.rs`、`packaging/windows/{uninstall-host.ps1,uninstall-transaction.ps1}` | 检测本机 `sshd` 服务与监听状态，复用既有配置与主机密钥；严格校验无选项单行 RFC-4253 `ssh-ed25519` 公钥（不使用共享万能私钥）；以 `ry-reach:<nodeId>:e<epoch>:<grantId>` 原子写入并持锁记录前缀摘要；断网退避保留授权，解绑、换服、重配对及卸载仅精准移除受管行，完整保留他人密钥与注释 |
| M14 Starferry 连接合并（REQ-01） | `src/node/starferry.rs`、`src/service/starferry-store.ts`、`src/controller/starferry.ts` | 源自原 ARA `tools/ssh-tunnel/`（Starferry，Copyright 2026 Ray Zhang，MIT），对齐 Reach 持久 `(nodeId, epoch)` 身份与操作账本收据；支持 STUN/UDP 直连打洞（`RY.Starferry.Direct.v1` 定向长度前缀派生密钥 + 常量时间 HMAC + 首包对端固定 + 单调流号防重放）与有界 16 流云端双工中转回退；半途断链结算为 `unknown`（`replayed: false`），仅后续新流回退中转 |

## 2. 实跑测试与离线审计结果

所有测试均在本机 Windows 11 Pro 工作站实跑，使用系统自带真实 OpenSSH 客户端 `C:\Windows\System32\OpenSSH\ssh.exe` 与 `ssh-keygen.exe`：

| 验证套件 | 结果 | 关键可核对证明 |
| --- | --- | --- |
| Rust Node 单元测试（`reach` + `ryreach`） | **52/52 PASS** | 含 `resident::tests` 指数退避上限、`ssh::tests` Ed25519 校验与 UTF-8 BOM 并发撤销、`starferry::tests` 定向 HMAC 防篡改 |
| `tests/resident-m11.integration.test.ts` | **2/2 PASS** | 未配置常驻不阻塞 `stdin`、首次交互 `ryreach` 初始化、位置参数 `ryreach pair <code>` 连接执行、切换 `serverB` 零旧令牌泄露、自签名 TLS 显式报 `tls_handshake_failed`、外部 `preconfigure` 幂等与防覆盖 |
| `tests/heartbeat-m12.integration.test.ts` | **1/1 PASS** | 即时命令不等待 60s 心跳、MCP `reach_node_config` 远程修改生效、断网期间配置保持 `pending`、有上限指数退避、回执丢失自动重传收敛、丢失认领结算为 `unknown` 零重放 |
| `tests/ssh-m13.integration.test.ts` | **1/1 PASS** | 缺失 `sshd` 显式诊断；真实 `ssh-keygen.exe` 生成独立 Ed25519 密钥；真实 `ssh.exe` 配对前/未配对密钥报 `Permission denied`、配对授权后执行成功、断网退避期间保持可连、解绑与 PowerShell 卸载清理后拒绝登录并完整保留第三方管理员公钥 |
| `tests/starferry-m14.integration.test.ts` | **1/1 PASS** | 真实 `ssh.exe` 经 MCP `reach_ssh_exec` 在 `udp_direct` 与 `allowDirect: false` `cloud_relay` 下均返回精确结果与持久收据；直连半途断链返回 `status: "unknown", replayed: false` 且目标端零重放，同一隧道后续新流自动切换 `cloud_relay` 成功，关闭后临时公钥自动撤销 |
| 既有全链路回归（`node.integration` 27/27 + `agent-m07` 3/3 + `cloud.integration` 9/9） | **39/39 PASS** | 与第一里程碑 Morrow 新能力及既有 Node/Service/MCP/Desk 完全兼容零退化 |
| 四组 Cargo workspace 离线 `audit-dependencies.ps1` + 8 套 Windows PS5.1 测试 | **4/4 + 144/144 PASS** | 四组 `Cargo.lock` 与 `bun.lock` 零改动通过 `--locked --offline` 审计，含 `bin/ryreach.exe` 归属与卸载清理 |

## 3. 独立安全与正确性复核闭环（M15）

完成无历史分片独立复核（原始报告存档于 `apps/reach/work/m15-independent-review-20261114.md`），并已全部闭环修复验证：
- **SSH 客户端参数与 `known_hosts` 隔离加固（`controller/starferry.ts`）**：严格校验目标用户名正则（拒绝前导 `-` 与空白控制字符）与单行 51 字节 `ssh-ed25519` 主机公钥；调用 `ssh.exe` 强制传入 `-F none -o GlobalKnownHostsFile=none -o ForwardAgent=no -o IdentityAgent=none -o ClearAllForwardings=yes -l <user> -- 127.0.0.1`，剥离环境变量 `SSH_AUTH_SOCK`；本地转发监听限制 `maxConnections = 1` 并在首连后立即关闭监听端口。
- **UDP 直连防重放/防劫持与资源上界（`node/starferry.rs`、`service/starferry-store.ts`）**：长度前缀域分离派生会话密钥；首包通过 HMAC 后固定对端 `SocketAddr` 防止重放劫持；强制单调递增 `stream_id` 与带序号 `PKT_EOF`；以 `AtomicU32 + Notify` 替代无界 ACK 通道；新增 `SessionGrantGuard` 与 `ShutdownOnDrop` 确保任意早退路径自动撤销会话公钥并停止后台任务；服务端限制总会话数、单会话流数、队列深度并拒绝向已关闭流注入数据。
- **受管 `authorized_keys` 锁、路径与 BOM 兼容（`node/ssh.rs`、`uninstall-host.ps1`）**：全祖先路径非符号链接/非重解析点核验、`ssh-key-intents.lock` 互斥锁、1 MiB 文件读取上限、`cleaned` 历史记录定长裁剪、并发编辑回退分支兼容 UTF-8 BOM，且启动 `sshd` 固定调用 `%SystemRoot%\System32\sc.exe`。

## 4. 诚实证明边界

1. 本工作站未安装系统级 Windows `sshd.exe` 服务，真实 `ssh.exe` 登录与隧道流量系针对读取同一受管 `authorized_keys` 文件的本机 RFC-4253/4252/4254 SSH-2.0 协议服务端实跑验证；干净 Windows 虚拟机内置离线 `OpenSSH-Win64` 安装、公网跨运营商 NAT/STUN 打洞与 Windows SCM `LocalSystem` 正式安装升级仍须在后续 I06/V02/V03 阶段实机验收。
2. QSpin 默认安装 Reach 与配置服务器地址的外部接线按用户决定归属 QSpin 项目，本仓仅提供并验证通用安装与 `preconfigure` 合同。

## 5. 后续独立复验（2026-11-14）

后续对当前未提交工作区的[独立复验](independent-validation-20261114.md)得到 M11–M14 合计 4 通过、1 失败：M14 的多流正常命令返回 `unknown`，尚未执行到后续断链回退断言。测试运行时 Node `24.18.0` 低于项目声明的 `24.20.0`，根因未定位。M14 执行项已重新打开；本页上文保留原运行结果，不作为本轮失败已消失或已修复的证明。真实 RyDev 安装被工具策略拒绝，未执行。

## 6. 同日修复后的复测

用户随后授权修复。已修正多候选 UDP 握手、绑定用户 SSH、缺失 OpenSSH 安装准备、收据退避、双端 STUN 和 Ray 首配健康路由。Node 24.22.3 下最终 debug 与候选静态 release 分别通过同一套 8 项回归，包含 M14 执行中断链后的零重放。上文“首个 HMAC 包固定对端”已由 Controller HELLO 与 Node HELLO_ACK 的提名合同取代。完整前后证据、候选摘要和剩余 SCM/公网验收见[原案例续记](independent-validation-20261114.md#修复与复测2026-11-14)。
