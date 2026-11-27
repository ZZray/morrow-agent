# Reach 接入 Morrow Agent 与新能力适配任务单（tasks.md）

作者：Ray Zhang（Ray）。命名空间：`RY`。
日期：2026-11-13。状态：执行中（M01–M03 已完成，已并入 2026-11-13 独立常驻与 Starferry 合并计划 M11–M14）。

## 背景与定位

Reach 首轮实现（2026-11-02 至 2026-11-05）早于 Morrow Agent 独立建仓与新协议演进（2026-11-10 至 2026-11-13）。迁入 `apps/reach/` 时仅完成了包名切换、MCP 单次调用原件回执前移与普通文件委托最小跑通；Reach 内部仍残留旧 ARA 工作区时期的私有侧车接口（`inspect_session`、`settled_task_close`、旧侧车固定 SHA 白名单、未提取的 typed image 传输与恢复字段），同时尚未接入 Morrow 新增的标准 Agent 能力。

本文件（`docs/tasks.md`）作为当前 **Morrow 接入、新 Agent 能力适配、独立常驻/Starferry 合并计划与本地闭环执行单**（编号 `M01`–`M14`）。产品首版 52 项基础验收与 5 项 Reach Desk 选装验收仍以 [task-checklist.md](task-checklist.md) 为唯一验收台账，不因本执行单缩减或提前勾选。

## 执行边界与测试环境

- **本地开发与真实模型验证**：按 2026-11-13 用户明确授权，可使用本机环境变量 `CAS_API_KEY` 与 CAS OpenAI-compatible 接口（`https://cas.ciqtek.com/v1`，含文本及视觉模型）进行本地真实模型与视觉委托联调。
- **保密硬约束**：严禁将任何 API Key、令牌、私有配置文件原件或未脱敏请求头写入仓库源码、文档、测试夹具、证据文件或日志。
- **服务器与测试授权**：2026-11-14 用户已授权域名入口验证及 RyDev 等机器安装测试，并随后授权缺陷修复。生产部署与重启仍待授权，LabSlot 集成继续延期。
- **完全控制原则不变**：不引入 Auto / Full Access 模式、工具权限开关或逐次操作审批；`taskAccepted` 始终由控制端或上层业务决定，Run 结束不自动代表业务 Task 被接受。
- **独立常驻与 QSpin 安装边界（2026-11-13 最新修正）**：Reach 目标机服务独立后台常驻，合并 Starferry（SSH + UDP 直连 + 中转）、默认启用 SSH、注册 `ryreach` 命令并在首次未预配置时输入服务器地址、支持分钟级可远程调整心跳与有上限断网退避；**QSpin 只负责安装时默认安装 Reach 并配置服务器地址，具体接线由 QSpin 处理**，Reach 仅提供通用安装与预配置合同，不做 QSpin 运行时/网关/IPC/子进程集成。

## Morrow 新能力与 Reach 适配映射

| 领域 | Reach 旧实现（ARA WIP 时期） | Morrow 现有标准能力 | 本轮适配决策 |
|---|---|---|---|
| 多模态工具结果与恢复 | `tool_reply.result.images`、`tool_images_ref`、`ToolCallSettlement::Completed.images`（未进入 Morrow） | Core 有 `Content::Image`，但 JSONL 与 `ToolCallSettlement` 尚无 typed image 通道 | **补齐到 Morrow 公共层**（M04）：在 `morrow-agent-core` / `harness` / `jsonl` 及 Node SDK 正式提供可选 typed image 工具结果、消费证明与中断恢复原图回填，不含 Reach 私有字段 |
| 会话只读检查与关闭结算 | Node `agent_finalize.rs` 调私有 `inspect_session(hold)`；Desk `settlement.ts` 硬编码旧 SHA 并调不存在的 `inspectSession` / `closeTask` | `@ry/morrow-agent/management`（`context_snapshot` 等）与 Harness 锁内检查/结算原语 | **收敛到 Morrow `manage` 标准入口**（M05）：在 `morrow-agent-jsonl` 的 `manage` 协议补齐标准持锁会话检查与已核对任务关闭结算，改造 `agent_finalize` 与 Desk `settlement.ts` 使用 `@ry/morrow-agent/management` 并绑定当前构建侧车 |
| 结构化工具产物溯源 | Node / Desk 仅靠自定义 JSON 收据核对，无跨层 `ToolArtifact` 账本绑定 | `artifact_review: true`、Journal 派生的 `ToolArtifact`、中断恢复产物重核与 `provenance_query` | **接入 Reach Host**（M06）：在 Reach Node 与 Desk Host 接入 `artifact_review` 回调与 `provenance_query` 管理查询，使 Reach 子操作/文件/截图收据与 Morrow `ToolArtifact` 双向可追溯 |
| 多轮续作与执行中引导 | `maxRuns>1` 时单侧车进程阻塞等待 HTTP 反馈；无运行中补充引导 | `continue_reviewed`（跨进程凭 `released.json` + 审核回执续跑）与 `guidance: true`（幂等 `guide` 帧及 `jsonl-guidance.json` 回执） | **接入 Reach 委托与 Desk**（M07）：支持基于 `continue_reviewed` 的跨进程已审核续作及 `guidance` 定向补充说明，保留累计预算与原截止时间 |
| 方法库 / 技能验证与持久队列 | Reach 自建 `source-library.ts` 设备资料表，与 Morrow Skill / Queue 隔离 | `manage` 的 `skill_catalog` / `record_skill_verification` / `verified_skill_provenance`、Goal `job_snapshot` 及 `orchestration::Store` | **打通验证桥接**（M07）：保持 Reach 设备/epoch 账本权威，同时支持对 `skill` 类来源绑定 Morrow 原生 `skill_verify` / provenance 校验，并在 Desk 云端任务宿主对齐 Morrow 管理接口 |

---

## 分阶段执行清单（M01–M10）

### 阶段 0 · 落档与全量基线摸底

- [x] **M01 记录讨论决定并建立 `docs/tasks.md`**
  - **范围**：将 2026-11-13 用户关于“先接入 Morrow 适配新 Agent 能力、按 `tasks.md` 执行、授权本地 `CAS_API_KEY` 测试环境”的原话与边界写入 `docs/knowledge/product-decisions.md`，同步更新 `AGENTS.md`、`docs/INDEX.md`、`README.md`。
  - **验收**：链接有效、术语一致、无任何密钥或敏感路径落盘。

- [x] **M02 父仓 Morrow 全量测试与 Reach 本地回归摸底**
  - **范围**：执行父仓 `morrow-agent-core`、`morrow-agent-harness`、`morrow-agent-jsonl`、`morrow-agent-mcp` 全量单元/集成测试（含 Node 客户端 `*.test.mjs`），以及 `apps/reach` 现有 Rust / TypeScript / Desk 测试；排查历史记录提及的 `managed_jobs` 偶发/既有问题。
  - **前置**：M01。
  - **验收**：形成真实通过/失败清单；若有父仓既有不稳定测试，先定位根因并修复至绿灯基线。
  - **已完成结果**：父仓 `morrow-agent-core`、`morrow-agent-harness`（77）、`morrow-agent-jsonl`（23 + Node SDK 95/95）、`morrow-agent-mcp`（26）及 `apps/reach` Rust Node（23/23）、Desktop（7/7）、Service/Desk 单测（88/88）全部通过（本机代理环境下环回测试需 `NO_PROXY=127.0.0.1,localhost`，并隔离 `CARGO_TARGET_DIR` 锁竞争）。

- [x] **M03 冻结 Morrow ↔ Reach 适配接口规格**
  - **范围**：核对 `crates/morrow-agent-jsonl/docs/protocol-v1.md`、`apps/reach/docs/agent-delegation.md` 与 `platform-extension.md`，明确 typed image、持锁会话检查/关闭结算、`artifact_review`、`continue_reviewed`、`guidance` 的字段与错误码，确保不破坏既有 SpinMind / Python / Node 95+30 项回归。
  - **前置**：M02。
  - **验收**：接口边界无 Reach 私有表耦合，兼容既有 `start_task` 与 `manage` 调用方。
  - **已完成结果**：已核对 `desk-images`、`desk-inspect`、`desk-close`、`desk-wire` 与 `protocol-v1.md` 全部字节预算（文字 4/8 MiB、图片 24 MiB、总上限 32 MiB）、`HostEmitter`/`transform_context` 凭据脱敏不破坏 base64 图片、压缩后即时归档，以及 `manage` 持锁 `session_inspect`/`settled_task_close` 合同边界。

### 阶段 1 · Morrow 多模态与会话结算公共能力补齐

- [x] **M04 在 Morrow Core / Harness / JSONL 补齐通用 Typed Image 传输、证明与中断恢复**
  - **范围**：
    1. `morrow-agent-core`：`ToolCallSettlement::Completed` 支持可选已校验图片列表，恢复时按原路径重核字节大小、PNG 尺寸与 SHA-256，写回 `Content::Image` 且不重执行工具；
    2. `morrow-agent-jsonl`（Rust + Node `client.mjs` + Python 客户端兼容）：`tool_reply.result` 支持可选 `images`（转换为原生 `Content::Image`），`verify_request` / `verify_budget_request` / `verify_stop_request` 在含图时生成受检 `tool_images_ref`（`jsonl-native-images-v1`），`reconcile_reply` 支持 `completed.images`；
    3. 同步更新 `crates/morrow-agent-jsonl/docs/protocol-v1.md`。
  - **前置**：M03。
  - **验收**：Core / Harness / JSONL 新增单测与反例（坏哈希、缺文件、超限、失败调用带图拒绝）全部通过，既有 JSONL Node/Python 测试零退化。
  - **已完成结果**：新增 `png_image.rs`（RFC-2083 块/CRC/尺寸/灰度 PLTE 校验与 `SettledToolImage.root` 规范路径包含校验）、分离 Journal/Context 文字与图片字节预算、脱敏跳过 `Content::Image` base64、补齐 `run-N-tool-images.json`（`jsonl-native-images-v1`）与 Node/Python SDK 支持；Rust 24/24、Node SDK 95/95、Python 45/45 全部通过。

- [x] **M05 在 Morrow `manage` 补齐会话检查与受控关闭结算，接通 `agent_finalize` 与 Reach Desk**
  - **范围**：
    1. 在 `morrow-agent-jsonl` 管理入口（及 `@ry/morrow-agent/management`）提供标准持锁只读会话检查（含可选 lease hold 与完整 Journal/Context/Fence 快照）及受控任务关闭结算（`settled_task_close` 语义），消除未实现的旧独立首帧；
    2. 改造 `apps/reach/src/node/agent_finalize.rs` 与 `apps/reach/platform/src/settlement.ts`、`host.ts` 对接新标准接口，以实际通过验证的当前 `morrow-agent-jsonl` 构建更新运行时策略（支持受控显式配置与打包固定 SHA 校验，不再保留失效的旧 ARA 常量）。
  - **前置**：M04。
  - **验收**：`tests/agent-finalizations.test.ts`、`tests/agent-finalize.integration.test.ts` 与 `platform/tests/*`（含 `settlement.test.ts`、`lifecycle.test.ts`、`device.integration.test.ts`、`desktop-image.integration.test.ts`）实跑通过。
  - **已完成结果**：新增 `session_inspect.rs` 与持锁 `session_inspect`（支持带真实超时信道守护的 `hold`/`seal`/`release`）及防符号链接幂等 `settled_task_close`；`agent-finalizations` 9/9、`agent-finalize.integration` 7/7、Desk 单元与 `cloud.integration` 32/32、`image.integration` 1/1 全部通过。

### 阶段 2 · 修复 R06 与接入 Morrow 新 Agent 能力

- [x] **M06 修复 R06 跨语言事件摘要不一致并跑通真实桌面截图恢复矩阵**
  - **范围**：
    1. 定位并修复 Reach Service（`store.ts` / `agent-resumes.ts`）对 `operation_events.data_json`、`result_json` 执行 `JSON.parse` → `JSON.stringify` 重序列化导致与 Rust Node `outbox.event_json`（`serde_json` 原始字节）SHA-256 不一致的缺陷，保留原幂等与防篡改约束；
    2. 结合 M04/M05，在真实构建的 `morrow-agent-jsonl.exe`、`reach.exe`、`reach-desktop.exe` 上跑通 `tests/agent-desktop.integration.test.ts` 全部 10 个场景（含 `crashed Node resumes a completed screenshot child with the exact original PNG and no reshoot`）与 `tests/agent-resume.integration.test.ts`。
  - **前置**：M04、M05。
  - **验收**：10/10 真实桌面截图与强杀恢复用例通过（0 skip），截图不重拍、原 PNG 字节一致、损坏原件明确拒绝。
  - **已完成结果**：`store.ts`/`server.ts` 严格提取并保留 `/api/v1/node/events` 顶层 `data` 原始 JSON 字节且递归拒绝重复 JSON 键；`agent-resumes` 11/11、`agent-desktop.integration` 10/10（含 R06 真机截图强杀恢复零重拍）、`desktop-image.integration` 1/1、`device.integration` 6/6、`web.browser` 8/8 全部零跳过通过。

- [x] **M07 在 Reach Node / Service / Controller / Desk 接入 Morrow 新 Agent 能力**
  - **范围**：
    1. **结构化产物审查（`artifact_review` + `provenance_query`）**：Reach Node Host 与 Desk Host 启用 `artifact_review: true`，将已落账子操作/文件/截图收据绑定为已验证 `ToolArtifact`，提供跨 Task 来源查询核验；
    2. **跨进程已审核续作（`continue_reviewed`）与运行中引导（`guidance`）**：在委托与 Desk 会话中接入 `continue_reviewed`（支持释放侧车后按提交的 `NeedsChanges` 回执启动下一 Run）及 `guidance` 幂等补充指令（含 `applied/unapplied/unknown` 真实结算回执），通过 CLI/MCP 暴露对应控制入口且不引入权限审批模式；
    3. 更新 `apps/reach/docs/agent-delegation.md`、`tools-tasks.md` 与 `platform-extension.md`。
  - **前置**：M05、M06。
  - **验收**：新增单元与真实侧车集成测试覆盖正常续作、篡改 `released.json` 拒绝、重复/冲突 `guide` 消息、进程强杀后 `unknown` 保留。
  - **已完成结果**：在 Node、Service、Controller CLI/MCP 与 Desk 全链路接通 `artifact_review: true`（仅回传已验证宿主业务 `ToolArtifact`）、`provenance_query`、跨进程 `continue_reviewed`（启动前同步校验 `released.json` SHA-256 并重绑本地 Relay）与幂等有上限 `guidance`（强杀中断保留 `unknown`），`agent-m07.integration` 3/3 实跑通过并同步更新三份合同文档。


### 阶段 2B · 2026-11-13 独立常驻、Starferry 合并与 `ryreach` 计划实施（REQ-01–REQ-06）

关联需求与设计：[产品范围 REQ-01–REQ-06](product-scope.md#2026-11-13-新增需求与验收条件)、[常驻服务架构草案](architecture.md#2026-11-13-常驻服务与-starferry-合并架构草案待实施)、[Starferry 与 Reach 工作流程](starferry-reach-workflows.md)。

- [x] **M11 独立常驻状态机、首次 `ryreach` 地址初始化与通用第三方预配置入口（REQ-03 / REQ-05 / REQ-06）**
  - **范围**：
    1. 固定 D03/D05 配置与命令合同（含 `ryreach` PATH 注册及旧 `reach` 兼容策略），实现 Node `等待初始化 / 等待配对 / 连接中 / 已连接 / 离线退避 / 认证或配置错误` 可观察状态机，系统服务绝不阻塞读 stdin；
    2. 实现首次交互运行 `ryreach` 输入服务器地址、后续 `ryreach` 查询/修改配置与换服务器隔离（不向新地址发送旧服务器凭据），支持第三方安装器预配置地址时自动跳过首次询问；
    3. 提供通用安装与地址预配置/状态查询入口供外部安装器复用同一单实例 Reach（QSpin 安装器默认安装与地址配置接线归 QSpin 项目，本仓不建设 QSpin 运行时/网关/IPC/子进程集成）。
  - **对应主清单**：D03、D05、D07、C03、C06、I02、I03、I05、P04、P05。
  - **验收**：关闭 `ryreach` 终端或外部产品进程后 Node 常驻服务保持运行；未配置、预配置、换服务器、错误地址/TLS 与重复调用安装预配置均有真实进程测试证明。
  - **已完成结果**：新增 `ryreach` 二进制目标与安装包 `bin/ryreach.exe`（保留 `reach` 兼容），实现 `resident.rs` 六态状态机（`等待初始化` / `等待配对` / `连接中` / `已连接` / `离线退避` / `认证/配置错误`）、首次交互 `ryreach` 地址初始化、按服务器源隔离凭据轮换、TLS/离线显式诊断及幂等防覆盖 `preconfigure` 入口；`resident-m11.integration` 2/2、`node.integration` 27/27 与 Windows PS 安装套件 136/136 全部通过，证据见 [resident-starferry-20261114.md](evidence/resident-starferry-20261114.md)。

  - **当前验证边界（2026-11-14）**。本项勾选保留实施执行记录。首次交互、普通 host 常驻和预配置已通过本地真实进程测试，实际 SCM/LocalSystem 安装后的常驻运行仍待验收。

- [x] **M12 分钟级可远程调整心跳、配置生效回执与有上限断网退避（REQ-04）**
  - **范围**：
    1. 将长期出站即时控制连接与分钟级状态心跳解耦（即时命令不等待下一轮心跳），实现服务端最近心跳时间、有效间隔与实际生效配置版本记录；
    2. 支持经已认证控制连接远程调整心跳间隔（关联请求 ID、目标版本、生效版本与待应用/失败状态，离线期间不把已下发冒充已生效）；
    3. 实现单一重连调度器的有上限指数退避与随机抖动，受控断网期间服务保持运行、网络恢复自动重连并按原操作 ID 查询收据，绝不重放未知效果操作。
  - **对应主清单**：D03、D04、D05、C05、C07、A01、V02。
  - **验收**：受控断网退避频率、恢复自动重连、远程修改心跳生效查询及配置回执丢失重查全部通过集成验证。
  - **已完成结果**：新增 `node-runtime-store.ts` 与 `/api/v1/node/heartbeat`、`/api/v1/nodes/:id/{runtime,config}` 及 CLI/MCP `reach_node_runtime` / `reach_node_config`，将即时控制轮询与分钟级状态心跳解耦，严格区分离线 `pending` 与回执确认 `applied`，支持回执丢失自动重发对齐与单一调度器有上限指数退避（零未知重放）；`heartbeat-m12.integration` 实跑通过。

- [x] **M13 默认启用 SSH 与受管配对授权生命周期（REQ-02）**
  - **范围**：
    1. 实现干净机与已有 OpenSSH 环境下的默认 SSH 准备、状态检测与失败原因报告，完整保留既有 OpenSSH 配置、主机密钥与非 Reach 授权；
    2. 将可信配对与受管 SSH 公钥授权绑定（禁止共享万能私钥，未配对者不可凭默认启用 SSH 登录），实现解绑与卸载时仅清理 Reach 受管授权且不误删他人密钥（短暂断网不销毁安装身份或受管授权）。
  - **对应主清单**：D02、D03、D05、C03、C04、I01、I02、I06、V02。
  - **验收**：已有 OpenSSH 与缺失路径、配对后 SSH 访问、未配对拒绝、解绑撤销受管密钥及保留他人密钥均有实测记录。
  - **已完成结果**：新增 `src/node/ssh.rs` 与卸载清理 `RevokeReachManagedSshKeys`，实现 Windows OpenSSH 服务/监听状态检测、RFC-4253 Ed25519 公钥结构校验、配对绑定 `ry-reach:<nodeId>:e<epoch>:<grantId>` 原子落盘（含全路径防重解析点、文件锁与 UTF-8 BOM 兼容）及解绑/换服/重配对/卸载精准撤销（断网退避保留授权且绝不误删第三方管理员公钥）；基于真实 `C:\Windows\System32\OpenSSH\ssh.exe` + `ssh-keygen.exe` 的 `ssh-m13.integration` 实跑通过。

  - **当前验证边界（2026-11-14）**。本项勾选保留实施执行记录。后续已补齐绑定用户与离线 OpenSSH 准备，本地协议、有效配置及隔离安装适配测试通过，真实 SCM/ACL 和干净机安装仍待验收。

- [ ] **M14 Starferry 连接能力（SSH / UDP 直连 / 云端中转）归入 Reach（REQ-01）**
  - **范围**：
    1. 完成 D02 对原 ARA 仓库 `tools/ssh-tunnel/`（Starferry）连接模块的提取/协议整合方案，保留上游许可与出处；
    2. 将 Starferry 的 SSH 访问、ICE/STUN UDP 直连打洞与云端中转回退接入 Reach 常驻连接层，使一次性会话升级对齐到 Reach 持久安装身份与结构化收据，保持“直连失败或禁直连时后续新流回退中转、已尝试操作不自动重放”不变量。
  - **对应主清单**：D01、D02、D04、C05、C06、C07、I01、I06、V02。
  - **验收**：从 Reach 控制入口对已配对目标取得真实 SSH 执行结果与所选网络路径（直连及禁直连回退中转），链路切换零自动重放。
  - **已完成结果**：提取原 ARA `tools/ssh-tunnel/`（Starferry）核心连接语义合入 `src/node/starferry.rs`、`src/service/starferry-store.ts` 与 `src/controller/starferry.ts`（CLI `ssh-exec` / MCP `reach_ssh_exec`），对齐持久 `(nodeId, epoch)` 身份与结构化操作收据，实现 STUN/UDP 直连打洞（`RY.Starferry.Direct.v1` 定向 HMAC 认证、对端固定与单调流号防重放）及有界 16 流云端中转自动回退；基于真实 `ssh.exe` 的 `starferry-m14.integration` 证明直连、禁直连中转、半途断链零自动重放及同会话后续新流自动回退全部通过。
  - **2026-11-14 首次独立复验失败**。多流隧道正常 `pre-sever-stream` 命令返回 `unknown`，预期 `succeeded`，后续断链断言未执行到。该轮 Node 版本低于声明范围，真实安装被工具策略阻断。原失败保留在[独立验证记录](evidence/independent-validation-20261114.md)。
  - **同日授权修复后，本地回归通过**。多网卡提名竞态通过旧快照与修复版的同一确定性测试核对；双端 STUN、M14 连续流/执行中断链/零重放/后续中转、M11–M13 及新传输测试在 Node 24.22.3 下共 8/8 通过。正式跨 NAT 和安装验收继续开放，不据本地测试关闭整项。

### 阶段 3 · 本地真实模型联调、打包更新与独立复核

- [x] **M08 基于 `CAS_API_KEY` 完成本地真实模型与视觉委托验证**
  - **范围**：通过环境变量注入 `CAS_API_KEY` 与 CAS `/v1` 模型配置（不写入任何跟踪文件），在本地真实运行：
    1. Reach Node 委托任务（真实文本模型多轮工具取证 + 反馈续作 + `ToolArtifact` 收据）；
    2. Reach Node 真实桌面截图 + 视觉模型消费原图并基于真实画面内容返回可独立核对结论；
    3. Reach Desk 纯云端真实多轮对话与关联本地 Reach Node 的设备操作/截图读取。
  - **前置**：M06、M07。
  - **验收**：生成脱敏证据记录至 `docs/evidence/`，严格核查零密钥泄露，真实模型结果与受控替身结果分开标注。
  - **已完成结果**：通过内存环境变量注入 `CAS_API_KEY` 实跑 `cas-real-model.integration.test.ts` 3/3 通过（`deepseek-v4.1-flash` 多工具+跨进程续作+溯源、`gpt-5.6-luna` 真机窗口截图像素随机码与色块识别、Reach Desk 多轮原生会话回忆+配对设备读取），1,155 个文件字节级扫描确认零密钥落盘，证据见 [cas-real-model-20261114.md](evidence/cas-real-model-20261114.md)。

- [x] **M09 同步更新 Windows 载荷审计与本地剩余基础工具检查**
  - **范围**：确保 `packaging/windows/` 的侧车打包、四组 Cargo workspace 离线 `cargo-deny` 审计（`audit-dependencies.ps1`）、`windows-agent-audit.test.ps1` 及安装包归属/卸载隔离测试在更新后的 Morrow 依赖与二进制上全部通过。
  - **前置**：M07。
  - **验收**：四 workspace 审计全绿，包外实跑与维护/卸载事务回归全绿。
  - **已完成结果**：`audit-dependencies.ps1` 四组独立 Cargo workspace（`node`/`desktop`/`setup`/`agent`）离线 `--locked --offline` `cargo-deny` 审计 4/4 通过，8 套 Windows PowerShell 5.1 载荷/安装/维护/卸载测试 144/144 通过，`packaged-agent.integration` 包外提取实跑与防篡改拒绝 6/6 通过。

- [x] **M10 独立复核、文档对齐与任务状态收口**
  - **范围**：运行 `cargo fmt`、`clippy -D warnings`、父仓全测试、Reach 服务/Node/Desk 全回归；派出独立 `reviewer` 子代理复核 Morrow 公共层改动与 Reach 接线安全性；回查修复所有确认问题，更新 `docs/tasks.md`、`docs/task-checklist.md`（仅更新分项进展证据，未达整项退出条件的不提前勾选）与最新交接记录。
  - **前置**：M08、M09。
  - **验收**：独立复核无未解决高置信缺陷，`git diff --check` 干净，所有验证均有真实命令与原件摘要支撑。
  - **已完成结果**：四组 Cargo workspace 全部通过 `cargo fmt --check` 与 `cargo clippy --all-targets -- -D warnings`；完成 5 分片无历史独立安全与正确性复核（存档 `work/m10-independent-review-20261114.md`），并将全部确认边界项（灰度 `PLTE`、持锁 `recv_timeout`、`close_settled_task` 符号链接防护、嵌套重复 JSON 键、Desk 续作同步摘要预检与引导状态单调转移等）闭环修复验证，`git diff --check` 零错误。
