# Reach 独立复验与安装测试阻断记录

作者：Ray Zhang（Ray）。日期：2026-11-14（Asia/Taipei）。

案例 ID：`CASE-20261114-Reach-resident-starferry`。来源会话：`01a1a973-7823-77f1-b547-1a77b78cbe39`。最新状态见末节“修复与复测”。原独立复验失败和安装策略阻断按当时事实保留。

## 对象与授权

用户要求检查已完成代码、进行隔离测试，并允许在 RyDev 及其他机器安装测试；随后指定服务器为 `https://bigrayzhang.cn/ray/login?next=%2F`，Ray 工作台源码位于 `E:/repos/RayWorkbench`。

实际 Reach 维护源为 `ZZray/morrow-agent` 的 `apps/reach/`。本轮基线为父仓 `4f258264405049ace92afba31b0497e21f6057b8` 加未提交工作区，不是干净提交。ARA 原规划目录不是本轮实现。源码、测试及构建输入共 1219 个文件在测试前后计算 SHA-256，复核无变化；本轮只新增/更新说明及验证状态，没有修改功能代码、配置策略或锁文件。

本轮范围是审查和执行测试，不自动包含修复、生产服务器部署或重启。基础验收维持 0/52、Desk 维持 0/5。

## 环境与隔离边界

- 本地：Windows，Node `v24.18.0`、Bun `1.4.4`、Cargo `1.97.1`。项目声明 Node `>=24.20.0`，本轮没有安装或切换运行时；TypeScript 测试结果仅证明所记录环境，不能作为声明运行时范围已验收。
- 本地测试使用真实 Rust 进程、独立状态/数据库目录、环回服务与故障注入。SSH 客户端为真实 `ssh.exe`，服务端为协议夹具；这不等于独立 Windows VM、真实系统 OpenSSH 服务或跨公网 NAT 验收。
- RyDev：通过已登记别名和严格主机密钥校验，只读确认现有 OpenSSH 及管理员 token，未发现 Reach 安装；详细机器路由和账户映射留在本机知识库。

原始日志、源码清单及原件保存在本次会话的本机可视化目录 `reach-validation-20261114/`，没有将配对数据库、测试凭据或私有配置复制到 Git。

## 本轮执行结果

| 检查 | 实际结果 | 覆盖与限制 |
|---|---|---|
| `cargo build --locked --offline --manifest-path Cargo.toml --bins` | PASS | 当前 `reach` / `ryreach` 开发产物 |
| `cargo test --locked --offline --manifest-path Cargo.toml --bins -- --test-threads=2` | PASS，26 + 26 项，0 skip | 两个入口编译同一批模块；不是 52 个不同语义场景 |
| `cargo fmt --manifest-path Cargo.toml --all -- --check` | PASS | 未自动格式化 |
| `cargo clippy --manifest-path Cargo.toml --locked --offline --all-targets -- -D warnings` | PASS | Node 独立 workspace，不代表所有父仓 WIP 已审查 |
| `bun run check` | PASS | TypeScript 和管理页类型检查 |
| M11 resident 两项 | PASS，2/2 | 首次配置、无 stdin 常驻、地址切换隔离及预配置 |
| M12 heartbeat | PASS，1/1 | 夹具覆盖的心跳配置、断网和回执场景；待上传事件的断网路径另有源码发现 |
| M13 SSH | PASS，1/1 | 真实客户端对协议服务端及受管公钥文件；不是 SCM/LocalSystem 账号路径 |
| M14 Starferry | **FAIL，0/1** | 多流隧道正常命令返回 `unknown`，预期 `succeeded` |
| 上述 TS 多进程测试合计 | **4 PASS / 1 FAIL / 0 skip，退出码 1** | 原失败保留，没有修复或反复运行到通过 |
| Node 依赖策略 | PASS | `cargo deny --manifest-path Cargo.toml --config deny.toml --all-features --locked --offline check`；存在重复版本及未遇到许可的警告，未改豁免 |
| 静态 Windows Node release 构建及 Node-only Setup 构建/inspect | PASS | 不包含桌面后端或 Agent 侧车，不代表正式安装通过 |
| RyDev 安装前置 | PASS，只读 | 未发现 `RYReach`、程序目录或安装记录，已有 OpenSSH Running/Automatic |
| RyDev 实际安装 | **BLOCKED，未执行** | 执行安装器的工具调用被自动审批拒绝 |

M11–M14 命令：

```text
node --test --test-concurrency=1 tests/resident-m11.integration.test.ts tests/heartbeat-m12.integration.test.ts tests/ssh-m13.integration.test.ts tests/starferry-m14.integration.test.ts
```

测试显式设置本次构建的 `REACH_NODE_BINARY` 和独立 `REACH_NATIVE_EVIDENCE_ROOT`。完整日志为 `m11-m14.log`，本轮共 174.232 秒，包含失败后的宿主收尾等待；M14 单项在约 6.150 秒报告断言失败。

## M14 实际失败与未定位项

失败位置：[starferry-m14.integration.test.ts](../../tests/starferry-m14.integration.test.ts) 的 `pre-sever-stream` 检查（本轮源码第 164 行）。同一多流隧道首个正常命令得到：

```text
actual:   unknown
expected: succeeded
```

前面的单命令 UDP direct 和显式 relay 已分别通过断言并留下成功操作收据。失败发生在后续多流隧道的正常流，不是在测试主动切断 UDP 之后。因此本轮未覆盖到后面的断链零重放和同隧道新流回退断言，不能报告整个 M14 通过。

断言失败后测试文件的清理路径留下自建 host，主代理向本次独立状态目录发送 `host-stop`，收到 `stopRequested:true`、退出码 0，随后测试进程以失败结果结束。收尾查询未发现本轮测试进程残留。原状态目录、数据库和日志保留，没有重放未知命令。

根因尚未定位：可能涉及多流实现、超时或夹具生命周期；本地 Node 低于声明版本也是环境缺口。已有证据不足以把失败归因于某一项，需要在支持运行时及同一份原件下继续验证。本轮没有修改测试、超时或产品代码。

## 源码审查发现

两名独立 Codex reviewer 为 `reach_current_review` 和 `reach_installer_review`；主代理回读关键源码。审查按 ara-git-review / ara-rust-core-review，使用 Git 范围和目标源码；未执行 OCR，不宣称全量 Core/Agent WIP 审查。

| 优先级 | 触发与后果 | 关键来源 | 本轮证据等级 |
|---|---|---|---|
| P1 | 正式 Node 为 LocalSystem 服务，SSH 目标却从该进程的 `USERNAME/USER` 取得账号，可能发布 SYSTEM 而非实际可登录用户。前台开发夹具注入用户，不能覆盖此路径 | [install.ps1](../../packaging/windows/install.ps1) 第 88 行；[ssh.rs](../../src/node/ssh.rs) 第 204、413 行 | 源码支持，实际 SCM 登录尚未验证 |
| P2 | 断网发生在 outbox 存在待上传事件时，上传器固定 1 秒重试，主循环等待 outbox，不进入外层指数退避与心跳状态更新 | [runtime.rs](../../src/node/runtime.rs) 第 50、149 行；[windows_host.rs](../../src/node/windows_host.rs) 第 363 行 | 源码支持，尚未注入该具体故障 |
| P2 | 默认安装没有双端完整 STUN 公网候选获取：Node 仅在 `REACH_STUN_SERVER` 存在时获取 srflx，Controller 默认仅枚举本机网卡；不同 NAT 后不能靠私网 host 候选证明公网打洞 | [starferry.rs](../../src/node/starferry.rs) 第 170–195 行；[controller/starferry.ts](../../src/controller/starferry.ts) 第 157、248 行 | 源码支持；未做跨公网 NAT 测试 |
| 未完成能力 | 缺失 sshd 时目前返回 `missing_sshd` 诊断，没有接入离线 OpenSSH 安装；不能把此测试写成干净机已默认启用 SSH | [ssh.rs](../../src/node/ssh.rs) 第 349 行 | 源码支持；真实干净机未验收 |

最小后续方向是确定真实可登录 SSH 用户及其密钥路径、统一 outbox 失败与连接退避、明确双端公网候选合同，并定位多流正常命令的 unknown。以上是审查建议，不是本轮已实施修复。

## 域名入口与 RyDev 安装阻断

域名 TLS 只读探测确认登录页返回 200。匿名 `/reach/api/...` 返回 401，受保护页面返回到 Ray 登录的 303；这证明入口可达和匿名拦截，不证明登录后业务可用或线上版本已包含本轮实现。

Node 的地址合同只接受 HTTPS origin 或 origin 后的 `/reach`，不接受登录路径及 query；按实际挂载，预配置地址应为 `https://bigrayzhang.cn/reach`，不是用户提供的浏览器登录 URL。当前未执行真实登录、配对或线上写入。首次交互配置会探测 `/healthz`，与 Ray 页面认证的兼容性仍需单独核对，不能把匿名页探测当作该流程通过。

RyDev 安装调用在执行前被工具自动审批拒绝，返回原文包含 `blocked by policy`，没有进一步具体原因。拒绝覆盖了该整次命令，因此没有进行文件传输、启动安装器或注册服务；没有改用另一种执行机制重试。后续只读检查仍确认无 Reach 程序、安装记录或本轮远端暂存目录，已有 OpenSSH 继续 Running/Automatic。

当前 Node-only 候选：

| 制品 | SHA-256 |
|---|---|
| `Reach-Node-Setup-0.1.0-preview-3efbc992696f3b3b.exe` | `3efbc992696f3b3bca9498e39602b0f1adfb0d4038ba06db5843c21fa3d41add` |
| 内嵌静态 Node | `3945dc95469636511c85f4911507bb67ee7c1e35c7c492c7c3bed5b5566b7820` |

构建输出在本地被忽略的 `outputs/windows-node-3945dc9546963651/`。候选未签名，包记录保持 `installationTested:false`。安装及卸载入口已审查，但由于策略阻断，没有真实安装、升级或卸载执行证据。

## 结论与后续

本轮不能接受 M14 或正式安装能力。M14 执行项重新标为待处理，保留原历史通过记录；52 项基础任务和 5 项扩展的验收计数不变。M11–M13 的本轮夹具通过不覆盖源码发现及真实 SCM、干净机、跨 NAT 或生产服务。

若后续获修复授权，应先定位失败并修复上述缺陷，再在支持运行时、真实 LocalSystem 服务、已有/缺失 OpenSSH 和跨 NAT 环境分别验收。自动安装仍取决于工具策略允许，不能承诺凭此前用户授权绕过工具拒绝。未提交、推送或部署；无人工对照基线，不估算提效。

## 修复与复测（2026-11-14）

用户随后明确要求“修复遇到的问题”。本轮修改实际维护仓的 Reach 及 RayWorkbench 本地入口源码。既有 Core/Harness/JSONL 与门户页面 WIP 保留，未提交、推送或部署。修改前保存 `src`、`tests`、`packaging` 原件，修复差异为 Morrow 17 个代码/测试/打包文件和 RayWorkbench 2 个入口/测试文件。

### 根因与处理

| 问题 | 核对结果与修复 | 验证 |
|---|---|---|
| M14 多流 unknown | 原两端独立固定首个认证 UDP 包的来源，多网卡候选竞态会令双方选中不同路径。Node 改由 Controller HELLO 提名，Controller 收到 HELLO_ACK 后确认路径 | 同一确定性用例对旧 Controller 快照失败，15 次 OPEN 发向错误端点；修复版通过。M14 连续正常流、执行后断链 unknown、效果恰好一次、后续中转通过。原失败未保留完整抓包，根因由受控对照支持 |
| LocalSystem SSH 身份 | 从安装记录的 `bindingOwner` SID 解析真实用户，结合实际服务 `-f`、`sshd -T` 的 loopback 匹配和 profile 取授权路径。支持多授权文件，管理第一项 | 真实当前 SID 在 USERNAME=SYSTEM 环境下正确解析；原厂 sshd 与临时主机密钥验证有效配置；RyDev 只读实测正确返回 dev 与管理员授权文件 |
| 缺失 sshd | Setup 嵌入固定摘要原厂离线包，准备配置/缺失主机密钥、注册并启动 sshd。共享依赖留存并记录准备收据 | 真实 ZIP 解包和有效配置检查，加隔离 SCM/ACL 适配测试通过。真实服务注册和干净机安装待验 |
| outbox 固定重试 | 暂态上传失败复用常驻退避函数，更新 offline_backoff，ACK 后复位。上传任务保持存活，避免停止正在运行的 Agent | 原二进制在新增 running-receipt 503 用例中持续显示 connected，回归失败。修复后退避递增、原收据持久保留、恢复成功且操作仅执行一次 |
| 默认公网候选 | Node 与 Controller 使用同一传输 socket 获取 STUN 候选，设置默认服务器和有界超时 | 两端本地 STUN 响应、transaction 校验、超时及候选不可达后中转通过；真实公网双 NAT 待验 |
| 域名首次配置 | RayWorkbench 原入口将 `/reach/healthz` 转入浏览器认证，阻断凭据建立前探测。仅为该精确 GET 路径增加原生健康路由 | 实际 handler 到受控上游验证通过，相邻页面、API 和非 GET 继续拦截；线上入口尚未部署此修复 |

独立 reviewer `review_fixes` 使用 OCR delegate preview/rule 和目标原件差异审查。Morrow 目标 17 项中 3 个 TS 测试被 OCR 默认路径规则排除，已人工补审；Ray 2 项也完成复审。复审提出的多授权文件兼容和同步探测频率问题已修正，常规 SSH 探测移至心跳到期分支。最终已审范围没有剩余高置信度缺陷。

### 当前验证结果

本轮使用官方校验摘要的便携 Node `24.22.3`，避免前轮 Node `24.18.0` 的版本缺口。Rust 编译并行度为 4。

| 检查 | 结果 | 边界 |
|---|---|---|
| 最终 Node fmt、Clippy `-D warnings`、debug 构建 | PASS | Reach 独立 workspace |
| Setup fmt 与 Clippy `-D warnings` | PASS | 使用实际内嵌 Node、OpenSSH 和许可输入 |
| 最终 Rust 单测 | PASS，28 项 × 2 入口 | 共 56 次执行，包含 2 个新增 UDP/STUN 场景 |
| 最终类型检查 | PASS | `bun run check`，含管理页类型检查 |
| M11/M12/M13/M14 与传输回归 | PASS，debug 和候选静态 release 各 8/8，0 skip | 同一组 8 场景重复验证两种产物；真实 Rust、ssh.exe 与隔离服务/协议夹具，其中 M12 2 项、M11 2 项、M13 1 项、M14 1 项、传输 2 项 |
| 原有 `node.integration.test.ts` | PASS，27/27，0 skip | 候选静态 release，覆盖配对、断线、收据、IPC、停止与维护入口，73.774 秒 |
| Windows 既有脚本回归 | PASS，144 项 | 8 套测试，隔离文件/HKCU，SCM/UAC/生产 ACL 使用适配边界 |
| 新增 SSH 准备专项 | PASS | 绑定用户、domain/profile、自定义配置、多授权路径、原厂许可、真实 sshd -T 和适配的缺失安装流程 |
| RayWorkbench `scripts/check.ps1` | PASS | Go vet、3 个包测试及入口 JS fixtures，受控上游验证 |
| 静态 Windows release 与 Node-only Setup 构建/inspect | PASS | 记录下表精确摘要；未签名，installationTested=false |

批量 Windows 脚本首次调用漏传 `windows-agent-audit.test.ps1` 的必需 Metadata 参数，未执行该项断言；随后用当前锁定、离线 Cargo metadata 补齐参数，8 个来源审计场景通过。首次调用失败日志保留。此处修正调用前置条件，未改测试期望。

### 当前安装候选

| 制品 | SHA-256 |
|---|---|
| `Reach-Node-Setup-0.1.0-preview-5a9f77497874d73f.exe` | `5a9f77497874d73ffd149b4a71ae333a78e2bbafbdc9e983e3b499d13c345141` |
| 内嵌静态 Node | `8fda80c7612594ccc7c0ed7130a519a6f3d2a1c662816b5f0a125db3a679c5bb` |
| 原厂 OpenSSH ZIP | `23f50f3458c4c5d0b12217c6a5ddfde0137210a30fa870e98b29827f7b43aba5` |

候选位于本地 `outputs/windows-node-8fda80c7612594cc/`，包含独立 Node 和离线 OpenSSH，桌面后端及 Agent 侧车未加入这个 Node-only 包。预配置参数为 `--server-url https://bigrayzhang.cn/reach`。构建和安装合同见[安装更新文档](../installation-update.md)。

修复原件、各检查日志、源码差异清单和隔离运行记录位于本会话本机目录 `reach-fixes-20261114/`；握手前后对照另存 `reach-starferry-fix-20261114/`，SSH 专项原件存 `reach-ssh-fix-baseline/`。测试数据库和凭据保留本机，未加入 Git。

### 剩余验收

RyDev 本轮执行了只读账号及有效配置解析，SSH 严格主机校验通过。此前“传包并执行 Setup”的动作被自动审批以 `blocked by policy` 拒绝，具体原因未提供，本轮没有换机制执行安装。实际 LocalSystem 服务运行、SCM/UAC/ACL、干净机和升级/卸载验证仍待完成。

公网双 NAT 与旧新协议版本混用尚未实测。握手修复应作为 Controller 与 Node 同一候选版本交付。RayWorkbench 健康路由只完成本地修复及测试，生产入口继续使用原版本。M14 记录本地修复通过，正式网络和安装验收继续开放，基础 52 项及 Desk 5 项验收计数维持原状。
