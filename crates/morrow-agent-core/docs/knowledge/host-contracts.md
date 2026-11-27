# 宿主边界与兼容

2026-10-21。来源：从 HandWave 0.2.8 提取运行库时，对当前源码、独立宿主和
HandWave 回归的核查。具体执行版本与结果以交付收据为准。

## 状态与授权

宿主选择会话文件、运行环境状态和工作目录，并在调用 Core 前验证业务授权。
Core 保留原生历史、调用与工具收据、取消、预算、Goal 进度和待处理状态。
成功 Run 仍需宿主对照业务任务验收；Core 不自动接受 Task。
未知副作用、未完成原生会话和已完成 Run 不能通过换会话、换 ID 或重试来掩盖。

`enable_local_tools` 默认关闭，构造器默认 Plan。业务工具由宿主注册；
Plan 工具许可是宿主声明，不是操作系统只读保证。内置名称在关闭时也保留，
避免业务工具覆盖 `exec`、知识与记忆工具等名称。

模型解析发生在原有 Run 准入顺序中。`ModelHost` 提供 route、client、能力和 headers；
HandWave 的 grant、binding header、设备连接和调度留在 HandWave。
原 route 的四个序列化字段保持不变，以保留旧会话的模型与绑定连续性。

## 四方职责与依赖方向

下面四节按需求 27.4 划分 Lite_Core、Harness_Lite、JSONL_Sidecar 与 Host 的职责，每个事项只归一方负责。agent loop 只在 Lite_Core 中实现；Harness_Lite、JSONL_Sidecar 和 Host 都通过 Core 的 `execute` 运行它，不各自实现“模型调用—工具执行—结果回填”循环。哪些接口可长期依赖见 [稳定性规则](../stability.md)。

依赖方向（需求 27.1、27.2）：

```text
Rust Host ──Cargo──> Harness_Lite ──path──> Lite_Core
跨语言 Host ══v1 帧══> JSONL_Sidecar ──path──> Harness_Lite
JSONL_Sidecar ──path──> morrow-agent-mcp ──path──> Lite_Core
```

`morrow-agent-mcp`（需求 42）是可选的工具来源库，它把 MCP server 的工具包装成普通 `AgentTool`，不构成第五方。经 JSONL 的 `mcp_servers` 使用时，连接与转发归 JSONL_Sidecar；Rust Host 直接调用 `McpSession::connect` 时，配置、连接生命周期与关闭归 Host。

- Lite_Core 只依赖 crates.io 包和固定提交的 `rpi-ai`、`rpi-agent`（同一 rev 带入 `rpi-telemetry`）。它的 normal、build、dev 依赖中都没有 Harness_Lite、JSONL_Sidecar、`morrow-agent-mcp`、产品 crate，也没有 Core 工作区之外的 path 依赖。
- Harness_Lite 以 path 依赖引用 `crates/morrow-agent-core`，只使用其公共 API。它的依赖图中只有这一个 Core 实例，不存在 git 或 crates.io 来源的副本。JSONL_Sidecar 与 `morrow-agent-mcp` 同样只有一个 path 来源的 Core 实例。
- 2026-10-29 在 `dev` @ `c061062`（含未提交改动）上，对 Core、Harness、JSONL、MCP 四个工作区分别运行 `cargo metadata --locked --offline --format-version 1`，四个都成功，结果符合以上两条：Core 图有 253 个包，ARA 包只有 Core 自身，git 包只有上述三个固定 rev；Harness、JSONL、MCP 图中的 Core 都是 `crates/morrow-agent-core` 的单一 path 实例。这是一次手工核对，不能代替任务 34.2 的 Dependency_Check_Test（`tools/lite-eval/tests/dependency_direction.rs`，尚未实现）。

### Lite_Core

- 运行 agent loop：模型请求、流式解析、工具调度与结果回填、Length 恢复、上下文压缩与摘要。
- Run 准入：模式（Plan／Execute／Goal）对应的工具许可、内置工具名保留、自定义工具名校验、单 Run 调用与时间预算、输出上限。
- 原生 Session 与 Journal 的持久化、未完成 Run 的 fence 标记、按 Host 结算关闭中断 Run。
- 可选的内置本机工具、后台 Job、知识与 Skills 工具；默认关闭，只在 Host 授权时启用。
- 事件发送（JSON 值与 `LiteEvent` 类型）、工具结果中结构化未知副作用的标注、闭合预算与停止证据。
- P2 的可选 Run 策略（Completion_Gate、Stuck_Detector、Compaction_Refresh）在 Core 循环内执行，由 Host 注册与配置。

### Harness_Lite

- 把一个业务 Task 拆成有界的多个 Run：Task 调用预算与绝对截止时间跨 Run 累计，不退还。
- 每个 Run 的准入记录、事件文件与观察记录；候选产物交 Host 复核，按复核结论续写或停止。
- 续写时核对 authority 不变：同一 Session、ModelHost、steering、工具 Arc 与授权字段；拒绝重复 Run ID。
- 跨 Run 的 Session 所有权、fence 文件与 `ReconciliationRequired` 停止；`resume`／`resume_checked` 在调用 Host 前做的条款、哈希与预算检查。
- 可选的预算停止快照、Length／NoProgress 停止快照复核流程，以及 `TaskOutcome` 中的未知副作用记录。
- 不执行模型调用或工具，不判定业务 Task 是否验收（`task_accepted` 恒为 false）。

### JSONL_Sidecar

- v1 协议帧的读写、帧大小与 UTF-8 校验、请求关联字段（`rpc_id`、`task_id`、`run_id`）核对。
- 把 Host 进程的工具调用、复核、续写、停止复核与 resume 结算转发为帧，并把回复交给 Harness_Lite。
- start 帧配置的准入校验（含 `generation_policy`、`length_recovery`、`mcp_servers`、`resume`），拒绝时不发上游请求。
- 证据目录中的 sidecar 记录（`jsonl-resume-rejected.json`、未知分支的 `receipt_ref` 等）。
- 按 start 帧的 `mcp_servers` 建立 MCP 连接、报告 `mcp_status`，并把连接得到的工具作为普通工具交给 Harness_Lite。
- Python 与 Node 客户端只是帧的编解码与回调封装，同样属于这一方。

### Host

Host 集成时必须自行实现以下事项，Lite 不代为完成：

- 用户、设备与租户身份，业务授权判断，以及据此选择的 `session_key`、`device_fp`、模式与工具授权。
- 模型凭据的获取与保管、端点与模型选择；需要非目录模型时自行实现 `ModelHost`。
- 所有路径的选择与隔离：工作目录、Session 文件、环境状态、证据目录、知识根目录；多租户的账户或容器隔离。
- 业务工具的实现与授权（经 `rpi_agent::AgentTool` 注册），包括参数在执行端的校验和取消处理；内置工具的允许名单不是 OS 沙箱。
- 产物复核：`HarnessHost::verify` 依据实际文件、测试或外部系统状态给出回执，不以模型自述为依据；续写目标与反馈的内容。
- 外部副作用结算：效果未知的调用由 Host 依据自己的操作回执判断，结算期间不重放；resume 前提交结算回执（见下一节）。
- 业务 Task 的最终验收、事件展示、队列与调度、跨进程的 Session 串行。
- 选用 MCP 时提供 `mcpServers` 配置及其中的凭据环境变量，决定哪些 server 为 `required`；Rust Host 直接使用 `morrow-agent-mcp` 时还要负责连接与关闭。

## resume 结算义务

Harness `resume`／`resume_checked`（JSONL 的 `resume` start 字段走同一入口）在接管 fence
之前调用一次 `HarnessHost::reconcile_resume(ResumeReview)`。Host 只依据自己的操作回执、
产物和外部系统状态回答，返回的 `ResumeReceipt` 必须满足五项义务：

1. `committed` 为 true：Host 已把这次结算保存到自己的记录。
2. 每个开放调用的结算为 Settled：`settlement` 为 `Settled`，每个调用都有确定结果
   （`not_executed`、`completed` 或 `failed`），不能是 `Unknown`。
3. 证据非空：`evidence` 至少列出一条 Host 自己的操作回执引用。
4. 回执与开放调用逐一对应：`tool_calls` 与 `ResumeReview.interrupted_run.open_tool_calls`
   数量相同、顺序一致，`call_id` 逐条等于对应调用的 `id`；没有开放调用时为空数组。
5. 结算过程中不执行、不重放效果未知的调用：只查收据和状态，不为“确认”而再做一次操作。

违反前四项中任一项时，Harness 拒绝 resume（`ResumeRefusal` 依次为 `ReceiptUncommitted`、
`SettlementUnknown`、`EvidenceEmpty`、`CallMismatch`），不接管 fence；fence 文件与原有回执
保持不变，上游 HTTP 请求数为零，Session 的 pending_run 保留。JSONL 在新证据目录写
`jsonl-resume-rejected.json`，类别与上述四种拒绝同名。第 5 项无法从回执检查，
由 Host 自己保证；违反时产生的重复外部效果，Core 和 Harness 都无法撤回。

接受的回执作为该调用唯一的 ToolResult（`details.source=host_reconciled_interrupted_run`）
写入原 Session，工具不再执行；被中断 Run 按准入上限全额计入消耗。真实进程中断与七种拒绝
条件的验证见 `crates/morrow-agent-jsonl/tests/test_resume_process.py`。

## 后台 Worker

原精简端可重启自身进入 Worker。通用库无法推断任意业务 EXE 是否支持这个入口，
因此要求宿主提供 `worker_executable`，且目标程序在正常启动前处理 Worker 参数。
未配置时不注册启动能力，直接 `Manager::start` 也在写入启动意图前拒绝。

作业目录、`op_id`、输入回执和未知结果规则保持原实现。同一操作读取原收据，
不会因为新 Run 或新模型回复而重新执行。事件通道在 Run 期间必须被消费；
通道关闭或取消不能证明外部效果已经撤销。

## 存储与外部记忆

本轮保留原 Session、Journal、Goal、知识索引和 Skill 格式。
`.handwave` 目录及相关版本字符串作为兼容标识继续存在。移除这些名称会形成
额外的数据迁移，不能当作代码抽取的一部分悄悄执行。

运行环境和项目的知识／技能根目录由宿主路径或显式 `knowledge_roots` 控制。
跨用户隔离应由宿主配置不同状态和知识目录。外部快照作为有来源的数据注入，
仍检查身份、范围、哈希和大小；不能授权工具、采纳记忆或取消撤销规则。
HandWave 专用消息分隔符仅由其宿主解析。

2026-10-20 的真实模型测试未证明新会话读取已沉淀的知识正文。
本次提取保留这个缺口；独立宿主的工具和进程验证不代表它已经关闭。

## 压缩摘要与中断结算的落盘边界

2026-11-27 发布候选 `deb40b53a` 的审查发现，压缩先更新 Journal 的 `active_base`，再保存新的 `.context.json`。两次写入之间发生中断或摘要保存失败时，冷启动读取到的旧摘要无法覆盖已归档的前缀。先保存新摘要，再推进归档。摘要先落盘时，旧窗口仍含相同的原始记录，按该窗口重开可校验摘要的前缀证明。回归使用本地模型夹具，在下一次摘要写盘前阻断临时文件，检查上一份摘要仍能覆盖冷启动读取的 Journal 窗口。

中断结算先写关闭标记，再向原 Session 写入 Host 收据与原生结果，最后释放 fence。进程在原生写入完成后中断时，同一关闭声明可以续做发布回执和释放。重试核对关闭标记、原 inspection 前缀、原生结算记录和每条工具结果。缺少结算证据或收据冲突时保留 fence。关闭标记、释放结果和回执先写入同目录临时文件，完整落盘后发布，遇到已有文件就拒绝覆盖。对应回归检查匹配的重试只释放一次，原始记录数保持不变。

同一候选在 CIQTEK 的 Windows 终端中断测试等待 12 秒后失败。本机用同一旧测试程序对照，普通启动能收到 Ctrl+C，使用 `CREATE_NEW_PROCESS_GROUP` 后出现相同的超时。测试子进程现在先清除继承的 Ctrl+C 忽略位，再安装 SIGINT 处理器。ConPTY 仍输入原 ETX，测试仍要求退出码 23。CIQTEK 复跑本项通过。

## 会话记忆的自动注入与按需检索

2026-11-27，Ray Zhang（Ray）。

原生 Journal 保存会话原文和工具收据，`history_search` 和 `history_read` 可在可见范围内回查。压缩摘要用于当前会话续作。已采纳笔记存放在原有 v1 `.context.json`，可供同一 Session 后续 Run 使用。宿主指定的环境或项目知识库承担跨 Session 的技术知识复用。

工作上下文按提案时间从近到远挑选仍有效的普通笔记，最多注入 8 条，整个笔记数组最多占 8 KiB JSON，并受工作上下文的剩余预算限制。条目过大时继续尝试后面的条目。`session_memory_search` 支持按 ID 或字面文本查找，也可分页浏览。字面命中的 `match_offset` 是笔记正文的 UTF-8 字节位置，可以直接传给 `session_memory_read` 的 `offset`。按 ID 查找和浏览时，该字段为 `null`。

只传 `id` 会从笔记开头读起。可选的 `limit` 按原文 UTF-8 字节计，范围为 1 至 8,192，默认 8,192。每页返回 `text`、起点 `offset`、全文字节数 `bytes` 以及原始来源的 ID 和哈希。模型应使用本次收到的 `next_offset` 续读，直到它为 `null`。Core 会根据工具消息转义后的投影大小和完整请求的剩余额度缩短当前页。每次续读都重新检查笔记和来源的有效性。需要核对原始证据时，使用 `reference_read`。

预算紧张时，同一笔记连续向后翻页，只保留最近一次纯读取的调用和结果。`prior_read_offsets` 记录被折叠的读取起点，正文后的 `next_offset` 指向下一页。折叠要求旧调用成功，且助手在该轮没有给用户附加可见回答。其他已消费的笔记正文可缩为带有 ID、字节位置和来源的定位信息。Journal 保留工具实际读取的窗口，所以原始收据和模型看到的页长可能不同。来源目录、外部快照与摘要仍受原有的 96 KiB 工作上下文上限约束。

候选由 `/memory accept` 显式采纳。笔记撤销、来源撤销或更正、依赖的外部快照切换后，自动注入与按需检索都会排除失效的笔记。两个检索工具可在 Plan 模式使用，宿主若固定校验原生工具名，应把它们登记为只读收据。Reach Desk 的应用级笔记继续由 Reach 宿主管理。

本次采用文章中的分层召回和简短自动注入。离线整理仍是后续设计项，需由宿主确定触发条件、允许使用的原始证据和采纳流程。 [Anthropic《The components of agent memory》](https://www.anthropic.com/research/components-of-agent-memory)

### Reach 的跨对话知识与会话输入

同一 Reach 对话的普通续聊创建新 Task 和 Run，沿用该对话的 `session.json`。新建对话有独立的 Session，同一账号的新对话共享环境知识目录。旧对话沿用首次记录的环境路径，旧环境和 Ray 云端记忆尚未迁入。Reach 的「我的笔记」写入共享目录，`reach_memory_search` 和 `reach_memory_read` 按需读取 Markdown。关闭「记忆检索」只移除该条消息的共享知识工具。会话原文、压缩摘要和 `/memory accept` 的笔记归原 Session，采纳时不会写入共享知识库。见 [Reach 按用户共享环境决定](../../../../apps/reach/docs/knowledge/product-decisions.md#desk-shared-memory-20261126)。

Reach 先校验对话归属和工具权限，再将当前消息及选中的文本附件、技能正文交给 Core。这些文本可成为会话原始来源。选中的 PNG 由该消息的只读工具取回，其他二进制附件只携带说明。已选设备的操作权限由 Host 校验，设备操作结果可以进入会话 Journal。旧轮次压缩后，模型仍可按来源 ID 和哈希回查当前可见范围内的原件。来源更正或撤销可能推进历史可见边界。审计原件仍保留，模型只能在更新后的范围内回查。

验证基于 `4f25826` 的工作区。Core Clippy 和 44 项定向测试通过，覆盖记忆、Plan、压缩、宿主合同和公开 Run。首次离线编译缺少 `ppv-lite86`，补齐锁定依赖后完成同范围验证。

### Reach 与 JSONL 联调结果

联调使用上述工作区本机构建的 Windows 侧车，SHA-256 为 `0c4f5a30cdc2aee07cea8ebc7e74c221412a75473b4fb6e50f6b64054c61580d`。QBuild 在接收 Reach 旧版的中文文件名时失败，本机构建通过。测试使用隔离状态和合成笔记。

- Reach 的实际取消结算记录了两条 `native-receipt`，关闭回执为 `validated`，会话锁已释放。现有云端用例一过一失败，失败项的固定清单漏列了默认启用的 `reach_memory_*`。专项夹具的显示时序断言和复跑超时另行保留，专项续聊未完成。
- 2026-11-27 修正工具清单断言。首轮验证 Core 工具与 Reach 只读笔记工具，次轮关闭记忆检索后验证只有 Core 工具。Node 24.20.0 与实际 Linux 侧车通过 10 项回环模型集成。
- JSONL SDK、当前侧车与本地 ACR ModelRelay 的受控回环测试通过。新笔记经原生管理接口采纳，Plan 召回的第三次请求携带两项工具结果，原文及来源哈希一致。预算回归也通过。单独使用 ACR `d833e554` 的原生工具清单发起新版工具请求时，Relay 返回 `relay_tool_denied`，上游请求为零。此结果适用于未来接入新版侧车的兼容性检查。
- 真实 CAS `deepseek-v4.1-flash` 在同一预算下召回了 8,192 字节的普通文本笔记。隐藏校验码从第三次模型请求的完整读取结果才出现，模型精确回传。原始来源更正后，搜索结果为空，按旧 ID 读取返回找不到笔记，模型输出 `UNAVAILABLE`。两个场景共 6 次真实模型请求，均返回 HTTP 200。
- 转义密集的 8,008 字节笔记在真实模型测试中触发预算失败。两项工具均已完成，读取结果嵌入工具消息后约为 28 KiB，超过本地 Reach 环回配置的 13,312 字节投影预算。第三次模型请求未发出，Reach 将该轮记为 `unknown`。两次真实模型证据目录均未检出 CAS 凭据。

### 长任务的上下文成本与回查

2026-11-27 调研建议。HySparse2 从模型侧减少预填充计算和 KV 缓存，并细化注意力选择。Morrow 通过 API 调用模型，可控制送入模型的内容及其排列。DeepSeek Harness 的 Spill 文档提供了宿主侧做法：完整结果保留原文，模型先获得定位符和读取提示。 [HySparse2 论文](https://arxiv.org/abs/2609.26368) · [DeepSeek Spill 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/spill.md)

1. 优先为 `session_memory_read` 增加 UTF-8 窗口。搜索给出命中位置，读取保留来源 ID 和哈希，并按编码后工具消息的大小和当前 Run 的剩余预算返回下一页位置。用已复现的转义密集笔记、中文和普通短文本验收，核对末尾唯一值可找回、来源更正后无法取回、普通短文本继续可读。
2. 实测重复输入的代价。在同一模型路由回放相同的多轮任务，记录请求字节、供应商上报的未缓存及缓存读取 token、首字延迟和完成时间，同时检查证据匹配和工具调用数。支持前缀缓存的路由可对照稳定的系统指令与工具声明，实际命中以当前路由回执为准。现有遥测提供请求字节和适配器用量，首字延迟需要独立计时。 [DeepSeek API 缓存规则](https://api-docs.deepseek.com/guides/kv_cache/)
3. 有多任务需求时，以已有 Harness Task、Session 和回执承接独立执行。Reach 对话只接收状态、待决问题和结果来源，细节按 Task、Run 或原始来源回查。跨 Session 查证由宿主校验来源权限。 [DeepSeek Super-agent 原型架构](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md) · [Morrow 持久任务编排](../../../../docs/design/orchestration.md)

### 会话笔记分页的 Reach 环回验收

2026-11-27，Ray Zhang（Ray）。在 `4f25826` 的工作区使用本地 Reach Desk、Windows JSONL 侧车和真实 CAS `deepseek-v4.1-flash`。沿用原来的 13,312 字节投影上限，每轮最多 8 次模型调用、90 秒。8,008 字节笔记含大量引号和换行，随机校验码位于末尾。

首版缩短了工具结果，真实模型读到字节 4,150 后改用 `reference_search` 找到了校验码。这次只证明原始来源可回查。要求模型只用会话笔记工具后，另一轮在字节 5,492 处耗尽投影预算。Journal 显示，已经消费的助手工具调用也占空间，单删旧页正文仍然会中断续读。成对折叠旧调用和收据后，模型拿到了下一页位置 6,547，却从零重读并停止。折叠时还需保留已读位置，让模型看得见此前的进度。

最终验收使用独立路径中的同一份侧车，SHA-256 为 `0150e0dec6cc0c39cfab0b0e7b4a75598cc3f61f3f623dcef17405df80f5ac8d`。

| 场景 | 模型请求中的实测结果 |
| --- | --- |
| 长笔记顺序读尾 | 4 页的起点依次为 0、2,229、4,252、6,166，最后一页返回 `next_offset: null`。拼接正文与存储的 8,008 字节逐字节相同，四页的来源 ID 和哈希一致。校验码首次出现在第 6 次模型请求中，模型精确回传。投影峰值 13,311 字节。 |
| 长笔记来源更正 | 搜索无命中，用原笔记 ID 和旧游标 2,229 读取时返回找不到笔记。3 次请求均未携带旧码，模型回答 `UNAVAILABLE`。 |
| 普通短笔记 | 仅传 ID，一次读取全部 432 字节，`next_offset` 为 `null`。更正来源后，用偏移 1 也无法读回旧值。 |

两条本地环回链路的召回和更正共发出 15 次真实模型请求，均返回 HTTP 200。上述结论还核对了请求正文、工具收据和最终回答。长短场景的本机原始记录分别为 `D:/Temp/morrow-memory-pages-escaped-7NWceM/receipt.json` 和 `D:/Temp/morrow-memory-pages-short-IBoNe6/receipt.json`。

Core 的 44 项上下文单元测试和 1 项公开 Run 集成测试通过，覆盖中文与 emoji 字节边界、同批多读、完整请求预算和历史摘要。Clippy 与格式检查通过。一次并行运行中，既有测试夹具创建临时目录时发生重名，保留原断言串行运行通过。QBuild 任务 `f72712b12e5c41ac876494c079ddfda4` 在接收旧版 Reach 中文文件名时失败，侧车由本机 Cargo 离线构建。此次未测试生产部署、缓存命中或延迟收益。

提交前从 `4f25826` 加入本次改动，重新构建 JSONL 侧车（SHA-256 `85efa8ed9a31069f60ed5c1593171552e568fdb176dffe87439270d10453b082`）。本地 Reach Desk 经真实 `deepseek-v4.1-flash` 按偏移 0、2,247、4,373、6,280 读完 8,008 字节，第六次请求带入末尾校验码，最大投影为 13,312 字节。432 字节短笔记一次读完。两条来源经 JSONL 管理接口更正后，原会话均搜不到旧笔记，用旧 ID 和非零偏移读取也均失败。四个 Reach 回合完成，15 次模型请求均返回 HTTP 200。

可复跑的 Reach 回归使用受控模型。将 `REACH_DESK_SIDECAR` 指向本次构建的 JSONL 侧车，在 `apps/reach` 运行 `node --test --test-name-pattern="Desk reads an adopted" platform/tests/cloud.integration.test.ts`。两个用例核对每次请求的投影预算、逐页拼回的正文与来源哈希，以及更正后旧 ID 和偏移的读取结果。

## 依赖修复

提取时的依赖审计报告 RUSTSEC-2026-0381 与 RUSTSEC-2026-0382，涉及
`webpki-roots 1.0.9` 和 `rustls-webpki 0.103.15` 的证书信任问题。
Core 将修复版本作为解析下界，避免嵌入已有旧锁文件的业务时再次选中这些版本。
完整版 ARA 的锁文件不属于本次修改范围。

## CASE-20261022：普通进程输出的证据保留

长编译或分析输出的中段可能被模型返回限额丢弃。原执行器会继续读走这些字节，
因此后续回读无法恢复；这能从 `drain` 的保留逻辑确认，但不能据此认定所有编码失败
都由日志缺失造成。Managed Job 的日志是另一条所属和配额链路，不代表普通执行已有归档。

2026-10-22 的首批增强只给普通 `exec/run_script` 增加显式 `capture_dir`。
父目录现存、最终目录独占创建，按流保留最多 8 MiB 原字节，摘要和收据分开。
完整性、已知退出状态和未知副作用分别表达；超额继续排空，不为取日志重放原操作。
现有编辑、Run/Job、身份、权限、模型及固定 OMP marker 不随本点改变。

收据 hash 以当时实际文件回读为依据，不是文件不可变、原子写入、脱敏或断电持久化保证。
取消可能沿原 `Abort` 丢失工具文本收据，原文件仍在调用参数给出的目录；硬终止还可能
留下部分文件。同步磁盘 I/O 没有独立硬截止，日志留存、清理和宿主隔离由调用者负责。

验证与独立审查见 [本次增强记录](../evidence/coding-reverse-enhancement-20261022.html)。
中段回读的受控 Host 任务与真实模型结果分开记录；任务未验收、日志超额和失败不会被
归档机制改成成功。静态反编译、动态调试和一般编码成功率仍需要各自的留出任务与成对实验。

本次验收也暴露了三个容易误判的前置条件：Python 临时脚本的模块搜索路径不自动等于
工作目录；Windows `\\?\` 与普通路径可指向同一对象，应核实际文件身份；工具允许的
128 KiB 预览可能超过小上下文声明下的保守字节预算。当前 Run 的完整工具结果不能靠
删除或改写活跃证据来压缩过关。最大预览测试因此明确使用受控 1M 模型目录，并检查
Host 观察到该声明；这没有放宽生产预算，也不接受较小声明下同样预览可以继续。

## CASE-20261023：静态分析的 Windows 路径与空结果

来源为 2026-10-22 至 23 日的自有样本与真实 Ctags/GNU 后端验证，范围是独立 Lite
宿主，不代表完整版 OMP 或产品验收。首轮 Host 仅 15/23 通过；原始失败保留。

同一份快照使用 Windows `\\?\` 绝对参数时，Ctags 可退出 0 却没有任何定义，
GNU objdump/nm 则报文件不存在。独立对照确认快照 SHA 未变、目录指向同一对象：
Ctags 使用普通目录表示和固定 ASCII 文件名后返回 4 个实际定义；GNU 工具也能读取
样本。可执行文件使用普通或规范路径的结果相同，问题在后端对目标与工作目录的处理。
因此不能把空结果或进程退出 0 单独作为“文件已分析且无符号”的证据。

修复保留 Host 提供的绝对 `artifact_root` 表示，并核对规范路径身份。
分析目录由这个根和新归档目录名组成，执行前再次核对它就是收据目录；
后端仅读取该目录中的固定 ASCII 快照名。原文件路径、快照路径和哈希仍保留在结果中。
不删除路径前缀，也不切换到猜测目录；Host 本身提供不兼容路径时仍可能明确失败。

同批审查还发现：原字段字节预算允许的记录，在 JSON 转义后可能超过整页预算。
若预算循环退到零条却仍返回原游标，调用者会反复取得同一空页。现在该情况明确失败，
保留原件与收据；真正没有记录的结果另行处理。源码修复已独立复审，执行结果与
后续任务级验证见 [增强记录](../evidence/coding-reverse-enhancement-20261022.html)。

## CASE-20261023：关闭思考的本地枚举与实际请求

原 R1 两次真实逆向 Run 的末次响应均为 `finish_reason:length`，没有最终正文；
服务端报告的 4096 completion tokens 全部计入 reasoning。固定 rpi 提交
`8ec462672d90e62712d96074638efef89436cebe` 的 OpenAI adapter 将
`ThinkingLevel::Off` 映射为省略 `reasoning_effort`。实际请求也没有 `thinking` 字段，
因此本地 Off 不能作为该服务已关闭思考的证据。

DeepSeek 的 [Thinking Mode 协议](https://api-docs.deepseek.com/guides/thinking_mode/)
使用请求根字段 `thinking.type=disabled`。Lite 通过宿主显式策略发送这个固定字段，
默认请求保持原样。该契约需宿主确认服务支持，不能只根据模型名称自动套用。
字段存在也只证明发送行为，模型能否完成任务仍看最终提交与独立检查。

上下文摘要已有独立模型配置，其输出上限最多 4096，并在部分既定路由发送 disabled。
诊断主任务策略时必须按 `model_call.call/phase` 对应实际请求；若对摘要套用主任务的
输出预算或字段预期，会把合法摘要误报成策略失效。摘要仍计入同一 Run 调用预算。

增加输出额度也不能补齐 thinking 模式的工具历史回放。官方协议要求相关轮次保留
`reasoning_content`，当前 adapter 的普通 assistant 投影没有这一字段；
本点只验证显式禁用契约，没有接受 thinking-enabled 工具回放。
原失败与新实验分别保留，见 [增强记录](../evidence/coding-reverse-enhancement-20261022.html)。

## CASE-20261023：nullable schema 与原生工具实参

H2-G 的原始服务响应填入了互斥的全部可选字段，本地 adapter 没有补参。
当时的 outbound schema 只要求 `path` 或 `path/action`，因此现有证据还不能区分
服务端转换与模型主动选参。保留原工具错误及后续服务过载，不据此认定模型能力差。

固定 rpi 提交 `8ec462672d90e62712d96074638efef89436cebe` 的
`rpi-ai/src/schema.rs` 会先移除 schema 不接受的 optional null，再做类型转换和验证。
把字段改为 nullable 后，这些 null 会保留并进入工具。只修改 schema 可能让原先未到达
工具的参数直接触发冲突；当前实现因此在三个指定工具入口按专属白名单移除 null，
其余字段交回原校验。未知字段不能用全局“删除所有 null”掩盖。

直接调用工具的测试和真实 AgentLoop 的行为也要分开：例如编辑工具的可选 null
可能被 rpi 先变成省略，不能根据直接 parser 会拒绝 null 就推断模型调用一定被拒绝。
必填字段还有既有类型转换，拒绝阶段应按原生回执记录。这一点未通过修改共享编辑
解析器或 rpi 来统一处理。

2026-10-23 的 v6 原生契约检查保留了旧非空冲突、错误指纹和分页保护。
首批有一组本地连接失败，5 个通过组与新会话中单独通过的 1 个组显式组合，原 FAIL
不覆盖。机制验证与真实模型是否采用 null 分开，见
[契约证据](../evidence/coding-nullable-20261023.result.json)。

## CASE-20261023：请求预算、Host 额度与真实 C++ 产物

S3 的两个诊断请求写入 `max_calls:40`，但固定 v6 的 `business_host.rs`
先将它裁剪到 32，再构造 Core 请求。原生模型请求中的预算观察始终显示
`call_limit:32`：基础组末次为剩余 1 次，符号工具组末次为剩余 2 次。
harness 与 PRE 漏核了示例入口的限制；原计划保留，请求 40 和实际 32 分账，
不能据此认定模型在还有 8 次额度时无故停止。此限制属于示例 Host，不代表 Core
固定只允许 32 次，也没有在本轮放宽它。

两次 Run 都正常结束，模型正文明确报告未完成。独立评估封存候选源码和模型收据，
在全新目录配置和编译，公开 10 项分别通过 5 项和 0 项，留出 48 项分别通过
4 项和 0 项。实际失败反馈已进入后续模型请求，因此不能把“读到了测试结果”当成
已经完成正确修复。第二组提出的旧对象文件解释也被干净重编译反证。

同次 PRE 还发现：取消或 deadline 后，Host 可以输出业务终态，而 Core 明确报告
`partial effects may remain`。仅判断进程退出和业务 result 存在，会错误放行隐藏评估。
当前 S3 harness 另外检查原生 `agent_end`、已知未知状态以及五类本地副作用工具的
start/end 配对。44 项受控自测覆盖这条门禁；任意外部副作用仍不在穷尽观察范围内。
这没有改变 Core 取消或 Run 生命周期，也不是操作系统隔离证明。

两组均未调用新增的 `source_symbols`，也未观察到可选 null 实参；不能将结果归因于
符号工具或 nullable 契约。原失败、版本指纹和检查边界见
[C++ 任务记录](../evidence/coding-stream-cpp-20261023.result.json)。

## CASE-20261025：大来源整篇读取耗尽当前 Run 上下文

公共 `/reference correct` 保存更正原文及来源版本，不把更正正文追加到原生消息。
因此，原文只存在于来源库时，不能依靠 `history_read` 恢复它。旧 `reference_search`
虽然能匹配深处字面量，却只返回正文开头的摘录；旧 `reference_read` 则返回整篇。

实际公共 Core 消费者复现了这一链路：49,152 字节的更正来源，关键字段位于
24 KiB 之后；受控目录声明 context 32,768、请求输出 512，对应 request 28,160
和 projection 14,080 字节预算。读取工具成功返回整篇，下一模型调用前的投影检查
失败。来源及 Session 没有损坏，失败是整篇工具结果不能装入当前 Run。

同一来源、任务和 3 次调用额度下，分窗版本通过检索偏移直接读回 4 KiB 原文，
得到正确原生答案，由 Host 原样保存并独立核对。另有 7 项实际进程故障检查覆盖
UTF-8 非法偏移、非法长度、EOF 和来源更正／撤销；6 项新库测试覆盖窗口重组、
整篇哈希、元数据和较长 Unicode 命中。这些均使用受控 provider，不能证明模型智能提升。

默认 8 KiB 窗口改变了大来源的响应范围。全文哈希与分页状态必须分别处理；
尾页的 `truncated` 仍为 true，是否继续取页应比较 `next_offset < bytes`。
来源窗口不会绕过上下文保护，也不保证顺序读完整篇后累计历史仍装得下。
参数及兼容规则见 [来源读取接口](../ai-integration.md#56-原始来源检索与分窗读取)。

同日单次真实模型试验未通过。模型成功检索来源并完成三次窗口读取，但没有读取
包含随机目标值的区间；主任务用了 5/6 次调用后返回三个 null。原生 Run 正常结束，
独立任务校验仍判 FAIL。未观察到上下文超限、长度截断或工具错误，也没有重跑该例。
这条证据保留为自主取证与完成判断的缺口；不能用增加调用额度或接受空答案消除失败。

## CASE-20261025：生成策略接线、空提交反馈与预算停止交接

Core 已有的封闭 `GenerationPolicy` 需要由公共 JSONL 入口显式透传。当前工作区
支持可选 `run.generation_policy`，默认仍为 provider_default；配置和同一个模型 Host
沿整个 Task 复用。产品 Relay 的 provider 字段白名单是另一条边界：AI Code Review
当前 Relay 不转发 thinking，且产品仍固定旧 Core。本点不代表产品迁移或线上生效。

公共 AI Code Review 示例原先直接调用 Workspace.checks 验收空补丁，触发检查前提
异常，无法给模型反馈。示例现仅对“没有补丁”这一已知前提保存 NeedsChanges，
明确测试进程没有启动；意外错误与未知结果继续阻断。相同两次错误提交在旧版只执行
一个 Run 并保留 fence，当前版保存两次反馈后按原预算停止，不能将空产物接受为成功。

同次真实模型试验使用固定历史故障副本；当前产品 HEAD 已修复该问题。模型在
24 次调用内执行了 8 次源码替换，最后一次调用完成最终修改，随后因调用预算耗尽
停止，没有普通最终答复。Host 没有收到候选，原 Task 仍为 ReconciliationRequired。
在全新目录独立检查冻结的最终源码，七项原测试全部通过，原 Workspace 和失败收据未改写。
最终补丁通过了这七项固定回归，原任务仍未验收，预算停止后的交接缺口保留。

Core 的 budget_hit 不只在闭合工具轮次设置，模型调用准入失败也可能设置它。
Session 的 pending_run 为空或错误文本包含 budget，都不足以证明可安全交接。
后续需分别评审原生闭合证据、明确停止原因、实际副作用结算和 Host 独立验收，
保留取消、超时、持久化失败及未知工具效果的阻断。
上述失败对应[策略与历史修复验证](../../../morrow-agent-jsonl/docs/evidence/generation-policy-20261025.html)
时点，原 Task 和 fence 不因后续实现改写。

后续实现把预算原因、闭合工具轮次和成功持久化同时绑定到唯一 `agent_end` 的可选
`termination`，保留原 Run 的失败与公开 `RunResult` 字段。Harness 默认拒绝；显式
启用的 Execute Host 使用独立快照、专用复核和完整 typed continuation，不构造普通
Candidate。快照检查对同一次有界读取的 bytes 验证大小、哈希及 JSON 内容，并在回调
前后复查来源。可信索引只引用当前已提交、已结算的收据。

原生闭合与外部结算必须分开：JSONL 可先取得完整原生 ToolResult，内含外部效果未知的
标记；此时 Core 可能仍能证明原生轮次闭合，Harness 必须继续拒绝快照。取消任务与
原生未知效果扫描的调度先后可分别产生 `Cancelled` 或 `ReconciliationRequired`，
两条路径都要绑定原始未知收据、保留 fence，且不得调用复核或重放工具。测试不能只接受
两个状态名，也不能要求 Core 的闭合标记替代外部结算。

当前受控与真实模型结果、保留的测试预期失败和未强制覆盖的组合见
[预算停止复核记录](../../../morrow-agent-jsonl/docs/evidence/closed-budget-snapshot-20261025.html)。

## CASE-20261101：TaskSet 消息准入与重复投递判据

来源：`e229fb9ab8` 基线上的 TaskSet 工作区实现及
[2026-11-01 验证记录](../../../morrow-agent-harness/docs/evidence/task-set-20261101.md)。

原 Core/Harness 不自动 `finish` Host steering。补充消息可能在模型 Run 停止后、
Host 验收尚未结束时到达；只检查 Task 是否已有 outcome 不能保证消息还会进入模型。
TaskSet 因此只承诺 `Queued`，在原 Task 和回调结算后清理 pending，并分别返回
`AppliedToContext`、`Unapplied` 或 `Unknown`。前者也只证明上下文准入；Host 不能据此
宣称模型已经处理了新要求，更不能自动将它变为新 Run。各任务独立 buffer、原续作
沿用原 Arc；长生命周期的去重和恢复由 Host 的持久协调层负责。

本轮首次幂等测试用整个 wire JSON 的原文出现次数断言“只投递一次”，实际得到两次。
回源与独立审查确认：同一 steering 既进入原生 user 消息，也成为原始来源引用；
上下文目录会带来源 excerpt。两处可见不代表两次投递。最终测试分别检查原文 user
消息、同 Run 的 steering 引用和终态回执各自唯一，并核对另一 Task 的请求与来源
均不含该消息。产品契约没有放宽，Core 投影没有因此修改。

受控屏障测试还覆盖 Host 验收期间入队后成为 `Unapplied`、取消完成等待后仍可收割、
原工具结算前不能报告取消完成，以及未知副作用仍保留 fence。该证据不覆盖持久
消息队列、跨进程去重或真实产品部署；两次真实模型排程任务不构成性能提升对照。

## CASE-20261101：持久 Host 与原生恢复边界

来源：`e229fb9ab8` 基线上的可选 `Morrow persistence Host (planned)-host`，见
[实现与进程验证](../../../../docs/integration.md)。
原 ara-lite 协调消息保留 24 小时，不能作为长期输入去重依据。Host 使用自己的持久
事件身份与完整 payload 摘要；业务 Task、worker 和 generation 仍归原 Store，
模型循环、Session、预算与效果结算仍归 Harness/Core。

投递意图必须早于 steering 调用持久化。崩溃使 Dispatching 变为 Unknown，不能从
内存回执缺失推断未应用，也不能重投来试。启动意图同样必须早于模型准入；否则
模型回调已经保存 WaitingHuman/ReadyForReview 后，旧 Running 会覆盖真实阶段。
准入后立即保留原 TaskHandle，持久化失败也不能丢失运行中的所有权。

人审崩溃恢复须核对原候选、委托实物检查收据、事件 hash、闭合原生 Run 和工作区
snapshot。审核 pass 可形成独立 recovered_human_review 业务交接，原生 fence 保留，
不生成 Harness TaskOutcome 或 Released，也不再次启动该 Session。返工才沿原预算
明确恢复。事件对账、通知 ACK 和业务审核是三种操作，普通 answer 不能替代它们。

原生试验发现 heartbeat 与 submit 会竞争协调 version；两者必须在实际修改边界
协调。Windows 心跳原子替换还会遇到短暂共享冲突，最终实现仅对已观察的 OS 5/32/33
做有界重试，保留持续错误，并用真实拒绝删除句柄验证。不同平台的 rename 和锁行为
需各自验收，不能将 Windows 通过外推为跨平台结论。

## CASE-20261101：视觉输入与能力后端的边界

来源：`a8aa9f4` 基线上的 Core 视觉修复，执行证据见
[视觉验证记录](../evidence/vision-20261101.md)。原实现已解析 `ModelCaps.input`，
但构造实际 `Model` 时遗漏了映射；固定 Chat provider 因此不附加工具图片。
接上图片工具并不能单独证明模型收到或理解了图片。

Core 现在把可信模型声明中的 `text/image` 传给 provider。未声明模态时保留旧文本
兼容行为，但不推定支持图片。每次 Agent 或摘要请求在调用预算预留前检查实际内容；
图片遇到未声明视觉能力的模型会明确失败。当前固定 provider 不编码 Assistant
图片，因此该角色的图片在 Agent 请求中也明确拒绝，不静默省略。

需要压缩的旧图片随摘要请求作为真正的图片块发送。JSON 转录中的图片位置改为
`summary_image` 标签，包含绝对 `message_index`、`content_index`、MIME 和
`base64_sha256`；相同标签放在对应附件之前。这里的 hash 是原 base64 字符串的
SHA256，不是解码图像字节的 hash。转换仅作用于摘要用的克隆，原始 Session/journal
保持不变。历史引用撤销与未采纳记忆过滤继续先于摘要附件提取。

无图片时仍走原文本摘要及预算语义。旧 `summary_input_with_limit` 文本接口保持
签名，对图片摘要显式拒绝；运行时使用内部多模态接口。图片附件计入现有序列化字节
上限，完整请求仍需通过预算检查；这不是图像 token 估算，也不保证供应商的图像
计费或上下文限制。摘要是模型生成的工作记忆，不能替代原图或业务验证。

能力扩展按以下职责接入：

| 层 | 职责 | Computer Use / QSpin 示例 |
|---|---|---|
| Core | 唯一 Agent 循环、通用模态与工具收据、Run 预算和原生历史 | 消费图片，调用普通 AgentTool；不认识 Windows 窗口或 QSpin 方法 |
| Harness | 跨 Run 预算、验证回调、续作、恢复与未知效果阻断 | 调用 Host 检查实际结果，依据回执推进任务 |
| Host | 身份授权、能力选择、生命周期、存储位置、脱敏与业务验收 | 启动授权用户会话内的 Windows 后端，限定窗口/设备/操作，验证后置状态 |
| 工具后端及适配器 | 实现具体能力并遵守执行端授权 | 开源 Windows MCP、QSpin V2/V3 MCP、日志工具；通过 extra_tools 接入 |

插件是工具的交付方式，Host 是选择、授权和管理它的责任方。当前已有 MCP 到
AgentTool 的适配，不为新增能力另建 Agent 循环或通用插件框架。MCP 错误到产品
未知效果的语义映射、Windows 用户会话、截图脱敏和 QSpin 验收仍由相应 Host 实现；
本次视觉修复不自动补齐这些产品接线。普通 JSONL 外部 `tool_reply` 的文本限制也
不因本次修改改变，图片工具须使用已有保留图片的 MCP/原生工具路径。
