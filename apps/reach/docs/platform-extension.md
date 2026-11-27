# Reach Desk 云端对话扩展

作者 Ray Zhang（Ray）。建立于 2026-11-02，更新于 2026-11-25。正式名称为 Reach Desk，命令为 `reach-desk`。自 2026-11-24 起 Reach 默认带云端对话：前端并入控制台，服务默认组合对话运行时（见[统一前端决定](knowledge/product-decisions.md#unified-frontend-20261124)）。真实模型的纯云端流式对话已在本地验证，nmrkit 部署待实施。

用户原话及对旧“无云端聊天”要求的修正见[产品决定](knowledge/product-decisions.md)。基础 52 项保持原 ID 与范围，另设 X01–X05 选装任务，统一维护在[任务清单](task-checklist.md)。

nmrkit 使用 Morrow 中现有的 Reach Desk。HandWave 提供对话与工具过程的交互参考。旧代码的迁入及兼容记录保留在本文后半部分，活动 Host 的维护入口见 [platform/README.md](../platform/README.md)。

## 交付形态（2026-11-24 起）

Reach 只有一种交付形态：默认带云端对话。原「默认 Reach / Reach + Reach Desk 按站点启用」两种组合不再区分。

| 部分 | 现状 |
|---|---|
| 前端 | 对话是控制台里的一个页面（`#/desk/<对话 ID>`），与设备、操作、设置共用外框、导航、登录会话和主题。代码在 `src/admin/desk*.ts`，由控制台构建统一编译。旧 `/desk/?c=` 地址由基础服务 308 跳转。 |
| 服务 | `src/service/main.ts` 启动时由 `src/service/desk-runtime.ts` 默认组合 Desk Host；`platform/src/main.ts` 仅作兼容入口。 |
| 运行组件 | `morrow-agent-jsonl` 取自 `REACH_DESK_SIDECAR`（绝对路径）或 PATH；状态目录默认 `<REACH_DATA_DIR>/desk`，可用 `REACH_DESK_STATE_DIR` 覆盖。 |
| 模型 | 在设置页配置供应商与模型，测试通过并启用后立即生效；`REACH_DESK_ENDPOINT/MODEL/MODEL_TOKEN` 只在首次启动时导入。 |
| 缺组件或缺模型 | 服务照常启动；对话接口不开放；设置页与对话页如实显示原因与补齐方法。 |

现场 Windows 仍使用同一个 Reach Worker 与 Morrow Agent，不维护第二套被控端、配对或操作账本。

## nmrkit 启用目标

从 `https://nmrkit.ciqtek.com/reach/` 登录后进入「对话」（`/reach/#/desk`）。浏览器复用 Reach PIN 会话及写请求 CSRF 校验；会话过期回到控制台登录页，登录后回到原对话。部署到 RayWorkbench 时改用工作台的同一套认证（待实施）。

部署还需要：

- 与服务器平台匹配的 `morrow-agent-jsonl`（Linux）；
- 受保护的数据目录（含 `desk/`）；
- 编译后的 `dist/admin`；
- 在设置页启用生产模型。

上线验收应覆盖：

- 用 PIN 进入；
- 纯云端流式对话；
- 选定已配对设备发出真实 Agent 任务，并读取原回执；
- 会话刷新后结果保留。

2026-11-24 的公开检查中，`/reach/healthz` 返回 200，`/reach/desk/` 返回 404（线上仍是旧版）。2026-11-25 本地以真实模型（CAS，经只在内存持有密钥的本地转发器）验证了纯云端流式对话、停止和刷新找回。

不需要设备也能完成纯云端对话。选择设备后，操作以明确的 Node ID、配对 epoch 和工作目录为目标；云端对话不会因为缺少目标而默认在 Ray 服务器运行命令。切换目标作用于后续提交，正在执行的 Run 和 operation 保留原目标，避免同一动作跨机器重做。这是执行位置合同，不是权限分层。

本地候选现接受 `POST /api/v1/desk/conversations/:id/messages` 的可选 `target:{nodeId,epoch,cwd}`。缺省保持纯云端对话；设备目标要求该用户当前配对与设备上的绝对工作目录。目标随原消息持久保存，同一消息 ID 改目标返回冲突。平台和显示名称由服务读取，不信任页面参数。Windows 拒绝盘符相对路径 `C:foo`；相对文件路径以目标 cwd 解析，命令 cwd 与所选目标一致。此规则不限制用户操作工作目录之外的绝对路径。

新调用在 Reach 原事务中核对账户、epoch 和实际能力；按原 requestId 找回已入账操作、查询、取消和取证则沿用原 operation 的账户及目标绑定，不依赖当前节点是否重配。Desk schema v3 只记录消息目标与工具调用映射，设备、配对和实际 operation 仍归唯一的 Reach 账本。关闭、退出或重启只核对和取消原操作，不重新提交已有 intent。已知 failed 不等于无副作用，unknown 不因进程树已停止而自动解锁。

当前八个云端设备工具提供单次执行、原操作查询、结果/事件分页、产物清单、范围读取及 `reach_image`。PNG 范围返回是字节数据；`reach_image` 则从原操作的完整产物核来源、字节和尺寸，经公共 typed image 送入共享侧车，不能拿文字或 base64 范围冒充图片输入。单次 JSONL 工具文字结果仍限 128 KiB，长正文保留完整 SHA、总字节数及游标。图片预算及大图恢复见[原图输入分项](evidence/desk-images-20261104.md)；[真实截图分项](evidence/desk-image-preview-20261104.md)验证本机截图到受控 provider 的图片请求，仍不等于真实视觉模型理解或现场 Agent 委托，不据此验收完整 X03。

消息内的原图来源独立于读取状态。历史读取只投影元数据；用户按需通过认证 `GET /api/v1/desk/messages/:id/images/:callKey` 取回原 PNG。服务核原账户、消息、调用及固定收据、operation/manifest 和缓存原件；原图读取不要求当前配对仍有效，不因同消息另一 unknown 调用而丢失已完成的证据。浏览器核长度、SHA 和解码尺寸，下载复用已校验原字节。读取失败保留来源并允许重新读取，取回或重试不提交截图；退出或切换会话后旧图片不能装载到新页面。

## 职责与数据

| 持有者 | 权威数据和行为 |
|---|---|
| Reach | 用户与认证、安装身份、设备配对、连接、操作投递、取消请求、结果/未知状态及证据索引 |
| Reach Desk | 对话、消息、附件引用、云端 Host 配置，以及消息到 Session/Run/operation 的映射；不复制设备或配对表 |
| Lite/Harness | 共享循环、原生 Session/Run 与 Task 恢复机制；Host 决定存储位置，Core 不导入 Reach/HandWave 状态 |
| Node | 现场执行、原始输出及持久账本；截图和文件等证据来源 |
| Ray 工作台 | 平台登录及可选扩展的部署装配；不替代 Reach 的操作账本 |

建议将云端 Host 作为可选独立进程，通过小型宿主协议接到扩展服务，便于在默认包中完全省略；具体目录、协议和打包由 X01 冻结，不建立通用动态插件市场或加载框架。

云端 Host 和 Node Host 都复用现有 ARA Lite/Harness 实现。一个 Run 只有一个推进者；若云端 Run 委托 Node，则建立关联的远端任务，云端等待其原收据，不能为同一动作同时启动两套循环。消息历史、原生模型历史和操作账本是不同记录，聊天转录不能代替原生恢复状态。

## 身份与调用合同

Ray 浏览器继续使用已上线的统一登录。扩展 HTTP 入口验证同一平台会话、Reach 账户归属及写请求 CSRF，不能使用旧 HandWave 共享 bearer 来冒充当前用户。扩展内调用服务时携带经过校验的用户上下文，并按原 Reach 合同查询设备和提交操作；具体进程间身份传递在 X01 设计并测试。模型密钥不发送给浏览器或现场用户，不进入对话正文、工具参数和证据日志。

对话每次提交携带稳定消息/提交 ID；重复 POST、浏览器重连或 SSE 恢复查询原 Run/operation，不重新执行工具。浏览器连接断开与任务状态分开处理：本扩展首版不把关页当作后台运行授权，断开后请求取消并保存真实结算状态；刷新后仍能读原记录。用户明确要求继续执行的持久后台目标，另复用 Harness 的目标合同后验收。Ray 退出或会话到期停止新的访问与提交，并请求取消该浏览器启动的活跃 Run；已发生效果与未知结果仍由原账本记录，不能声称已撤销。

同一对话首版只允许一个活跃 Run，期间的新消息返回忙碌或已记录的状态；不暗中并发推进同一 Session。消息排队和转向是旧 HandWave 的独立能力，后续若迁移必须分别保留入队、接纳、应用及停止语义，不能以简单流式文本冒充兼容。

页面必须区分模型在回答、工具已提交、现场执行中、成功、失败、取消请求及效果未知。最终成功依据 Reach 收据和实际产物，而不是模型说“完成”。模型可读取的图片/文件与页面缩略展示分别验证；聊天窗口出现图片不证明模型已接收到图片。


Reach Desk 宿主同样默认启用 `artifact_review: true` 与 `guidance: true`：已结算设备工具调用生成 `verified` `ToolArtifact`（`verifier = "reach-desk-host"`），通过 `GET /api/v1/desk/conversations/:id/provenance` 跨同会话历史任务聚合 `provenance_query`；运行中消息支持 `POST/GET /api/v1/desk/messages/:id/guidance` 幂等引导（中途取消的引导引用在 `effects-review.json` 中与 `jsonl-guidance.json` 逐条核对，进程中断保留 `unknown`）；显式声明多 Run 额度的已完成消息支持 `POST /api/v1/desk/messages/:id/continue` 跨进程 `continue_reviewed` 续作，篡改 `released.json` 直接拒绝准入。
## 已核对的来源与可复用部分

以下为迁入前核对的固定来源，不能据此推定线上二进制版本。源码迁入与兼容构建结果另见[迁入证据](evidence/platform-migration-20261102.md)：

| 来源 | 已见事实 | 本次用途 |
|---|---|---|
| 旧 Go 仓库 `llm-im.git`，`0b9cb7c3eabf1e4d82bfc1d6147786c2d883721c`，`apps/handwave/api.go` | 已有 `/chat`、`/chat/continue`、`/cloud/chat` 和会话消息路由 | 盘点聊天、续接、数据结构与可保留测试，不直接沿用旧身份 |
| 同版本 `apps/handwave/chat.go`、`agents.go` | 使用旧 `ara/internal/agent`；包含设备工具和独立云端 Agent 接线 | 迁移对话能力合同；新扩展仍使用 ARA Lite/Harness，不复制旧 Go 循环 |
| 同版本 `apps/provider/cmd/ray_front/main.go`、`web.go` | `/handwave/` 仍有独立卡片与旧身份转发 | 未来入口收敛及回退清单；当前未改动这些路由 |
| ARA `90f2b1cdd138129e2d331d89a37d70852e849739`，`apps/handwave-node/README.md` 及 `src/` | 已有 Rust Host、独立安装身份和 transport；文档描述聊天、队列及恢复边界 | 对照能力差异；不能以旧客户端存在代替 Reach Windows 服务、桌面或委托验收 |
| 同一 ARA 基线的 Lite Core/Harness/MCP | 固定依赖调查见 [reuse-map.md](reuse-map.md) | 新云端/现场 Host 共用公共库，保留许可与来源 |

优先复用经过核对的对话呈现、消息历史、模型输出和工具结果展示合同。旧设备连接、第二套配对、旧权限模式及独立被控端不作为新扩展依赖。可移植代码须记录来源、许可、差异与测试；仅有旧资料或通过旧测试不算新扩展交付。

## 迁移顺序与退役条件

1. 实现可选装配：默认无扩展也可运行，扩展安装/启用/关闭对基础 Reach 的状态无破坏；配置缺失时明确返回扩展不可用。
2. 交付无设备的真实模型对话：统一登录、持久会话、流式输出、取消与刷新恢复。这一步可以先于现场完整委托完成，不宣称远端任务已接通。
3. 接入 Reach 设备工具与 R01–R07 委托合同，验证真实文件/命令/图片效果及未知状态，保留稳定 operation ID。
4. 盘点旧 HandWave 数据与能力：旧对话保留来源和原 ID，能证明原生 Session 兼容才允许继续；其他历史以可读归档保留。旧设备 ID 不能按名称直接合并到 Reach，需配对迁移并保存映射。未结算任务留在原系统处理，不搬成新任务执行。
5. Ray 选装版本通过独立验收后，将工作台主要入口收敛到 Reach，Reach Desk 成为其中的可选对话入口；旧书签按兼容情况跳转或显示历史入口。确认旧活跃任务、设备依赖和历史读取均有去处后，才退役原独立产品入口及服务。

“旧 HandWave 退役”不等于只删除卡片。必须列出已经迁移、保留只读、明确延期的能力；不丢失现有任务或历史。扩展关闭前结算活跃 Run，保留聊天数据和原 operation 引用；恢复旧入口不重新投递已有动作。关闭扩展不卸载 Reach Node，不影响本地 CLI/MCP。

平台应用的 142 个来源文件已迁入 platform/legacy 与 provenance；Ray 平台 UI 及相关后端的 70 个来源文件迁入 platform/adapters/ray/_source。新构建入口在子项目内，旧仓只作为固定共享依赖来源，后续维护在 Reach。过渡 Go 后端仍保留旧协议，Ray UI 适配尚未加入构建；这不是最终 Reach 身份、设备或 Lite/Harness 接入。未更改生产服务、旧入口或用户数据，默认发行不包含平台。完整基础安装、桌面和远端委托缺口仍按原 52 项推进；Ray 是否实际启用以及退役步骤以 X05 的具体交付和运行证据为准。

## 首次设计检查（源码迁入前）

独立复核者为本会话 Codex 子代理 `/root/reach_plan_review`。复核默认装配、身份与账本归属、单 Run 推进者、纯云端对话前置、旧数据/设备迁移及任务依赖，结论为无确认阻断缺口；这只接受设计一致性，不接受扩展功能。

[文档检查记录](evidence/handwave-extension-plan-20261102.json)包含本地链接与任务依赖结果，基础 52 项、选装 5 项，均未勾选。`git diff --check` 通过；全仓 `python scripts/verify_bootstrap.py` 仍报告既有 Reach 外断链，本轮不扩修其他项目。humanizer 在项目和已安装技能中未找到，已人工审读。未运行应用测试，因为本轮只改文档；未提交、推送或部署。
