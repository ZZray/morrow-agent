# Reach Desk 可选云端 Host 独立复核

作者：Ray Zhang（Ray）。日期：2026-11-03。复核执行者：独立 Codex 子代理 `/root/reach_plan_review`，沿用已读 `ara-git-review` 与 `ara-rust-core-review` 的范围和证据约束。

**结论：接受受控模型下的可选 Host 机制执行点，无剩余确认阻断。真实模型对话未通过，Reach Desk 未上线；完整 R01–R07、X01–X05 和首版产品继续开放。** 本次接受范围是普通 Windows 开发环境中 Reach HTTP → 新 Desk Host → 既有 Node JSONL client → 原生 ARA Lite/Harness/Core 的装配、增量文本显示、身份隔离、停止及中断记录。没有聊天 UI、设备工具或现场委托，没有取消后在原 Session 内继续的交付。

## 固定对象与复核范围

[冻结清单](desk-host-inputs-20261103.json) 为 205,020 bytes，SHA256：`a06d2611ebe080588a3ec58a6c07b2df51fdecfdd18c5fd5c846993743aa5180`；sourceIdentity：`4e2a5ae376c4e981c34e949135078c4d2cb821a1a468efdceb67277ff7ecf769`。快照为 `work/desk-host-source-5d8fe647-ad58-4b58-8412-64778a513c84`，文中 work 路径均相对 `apps/reach/`。

独立重算 sourceIdentity，核当前来源 104/104、快照 104/104、普通 EXE 1/1、证据 685/685，共 894 项 SHA/字节数一致。普通 `ara-agent-lite-jsonl.exe` 为 22,582,784 bytes，SHA256 `9684d0e970234fd0e9a63b870994bfafd31f8b0ef792ca85734a13c0189acf2e`。检查时 Cargo 现有 rpi checkout 的 HEAD 是 `8ec462672d90e62712d96074638efef89436cebe`，无 tracked 工作区改动。仅按需阅读其流式实现，未做完整 rpi 审计。

清单是**运行后快照**，不能称为 r4 运行前已冻结。真实模型 r2 的 `started-inputs.json` 在启动前保存七项来源/EXE 摘要，本代理核对七项均与当前文件一致；r1 没有该文件。最终清单不追溯证明旧 r1/r2/r3 受控测试来源与最终测试相同。

- reviewed：`platform/src/{host,store,events,main}.ts`、六份 `platform/tests/` 文件、`src/service/{desk-extension,main,server}.ts` 相关入口；共享 JSONL client、Core 发射器、Harness 事件持久化及 pinned rpi 的流式调用段。
- 原件复核：只读打开五份 r4 Desk SQLite 和两份真实模型 Desk SQLite，核十一条 Task/Run 身份、请求、原生事件及存在的 result/client-finished/review 回执；核 provider wire、生命周期和测试断言来源。正常 candidate 的事件摘要、terminal 的 outcome_ref 摘要及 client-finished 的对象摘要均一致。对象摘要按 client 的 `JSON.stringify(outcome)` 合同核对，不与带换行的文件字节摘要混用。
- scope-excluded：其余清单文件只核身份或相关调用段；未审计整个 Core、所有 Provider、旧 Go 平台、全部 Reach、安装器或线上系统。本代理未重跑测试、模型、Cargo、安装或部署；执行日志来自主代理，本代理独立读取其原件。

## r4 原件与因果

`work/desk-cloud-tests-r4.log`：**8/8 通过，0 skipped，34.283106 秒**。其中前五组使用真实普通 Rust sidecar 和受控 HTTP 模型，事件/关闭响应测试使用各自有限 fixture；信号测试是独立 Node 进程调用生产注册的信号处理器。

| 原件目录 | 独立确认的行为 |
|---|---|
| `desk-cloud-6874352d-3022-4b39-bb67-e67f2e30a4c5` | 两条消息共两个 Task/Run，使用同一个原生 Session；重复 POST 未增加 provider 请求，内容改变返回冲突。两次生命周期均为 `started → client_saw_delta → finished → closed`，Core seq 5 为精确首段、seq 6 为尾段，Desk 只保存对应两条 delta。两条最终回答与原件一致。 |
| `desk-cloud-ce8618fc-8e38-4626-a8bc-273d2da4a27f` | 断连和显式停止的 provider 均实际进入 `waiting:true`，关闭时 `finished:false`；原生 `agent_end` 为 canceled，结果为 `Cancelled`，围栏 Present，对话 blocked。重复原提交只取原记录，后续新提交被拒绝，没有重复 provider 请求。 |
| `desk-cloud-6c44353f-87ba-4145-96d2-70a57f071995` | 受保护 HTTP 路径覆盖 Cookie CSRF、跨账户归属、退出和到期。两条原始流均在上游未完成时取消；退出原因 `session_revoked`，另一登录当时仍保留，随后到期原因 `session_expired`。最终均 Cancelled/Present/blocked。 |
| `desk-cloud-c7d01806-44ed-4da2-aa43-4c00e81d1cce` | 独立可选入口进程被 kill-tree 后重启。原 Task `dce16143-4db7-4e79-80c7-f0595585bee9` / Run `eaad1d73-3cd2-4f33-b821-36916bc6016c` 保留，原上游关闭且未完成；无 result/client-finished，重启记录 unknown/host_interrupted，原对话 blocked。重试不重投；明确新建对话才产生第二个请求并正常完成。 |
| `desk-cloud-9d369bf4-845e-411f-8b69-d2c80b07c9cb` | 两次并发 close 共用关闭过程，活跃上游未完成即关闭，原 Task Cancelled/Present，关闭后接口 503。没有把结束的 SSE close 当成正常回答后的取消请求。 |
| `desk-shutdown-08b210db-5799-4374-820a-5126ebd750b6` | 脚本在同一进程内依次 `process.emit('SIGINT')`、`process.emit('SIGTERM')`，生产 shutdown 只调用扩展 close 一次；原始 count 为 1，stderr 为空，测试等待子进程 exit 0。此项不是 Windows SCM 或真实 OS 双信号投递验收。 |

另外两项检查：事件读取器等待完整 admission 换行和完整 UTF-8 帧，不重复展示终态全文，拒绝错误 Task 身份；真实 socket 在异步 body 返回前已经关闭时，零消息入账、零 Task 启动。这两个 fixture 的临时目录按测试清理，独立依据最终源码和 r4 执行日志，不声称留有各自完整运行目录。

五个 r4 模型目录共九次 provider 请求：三个正常回答、五个取消、一个进程中断。正常三条回执均 `delivery=validated`、`AwaitingHostAcceptance`、fence Released、exit 0、callbacks finished，**`task_accepted=false`**。五条取消保留 reconciliation fence；中断没有伪造完成回执。崩溃状态 DB 对应的 230,752 bytes Desk WAL 和 185,432 bytes Reach WAL 已在清单内，未仅保存空主库代替账本。

这里的 `client_saw_delta` 来自 Node `fetch`/ReadableStream 测试消费者，**不是聊天页面或真实浏览器 UI 验收**。首段是有意义的 84-byte 中文文本；provider 必须等消费端收到精确首段且 `finished=false` 后，才发送尾段和完成标记，等待有六秒上限。因此本轮证明 EOF 前实际增量消费，而不是“Desk 状态仍 running 时收到最终全文”。

## 实现与修补边界

默认 service 只导入扩展类型，可选 `platform/src/main.ts` 注入 Desk。Host 使用既有 `crates/ara-agent-lite-jsonl/clients/node/client.mjs`，没有复制 Agent 循环；每次提交新建一个 `max_runs=1` 的 Task，同一对话的正常后续消息继续使用同一个原生 Session。稳定提交 ID、输入摘要、SQLite 事务和单活跃消息索引约束重复及并发推进。

已复查并由最终有限路径覆盖的修补包括：先结束 SSE 定时器/close 回调再关 SQLite；幂等关闭；等待完整 admission 后解析；body 等待期间已断连时不接纳；启动前再次检查取消/登录/连接持有者；SIGINT/SIGTERM 共用 stopping guard。

Host `run.tools=[]` 只表示**零外部工具绑定**。原始请求仍有 Core 的八个 Session 工具：`task_update`、`history_read`、`history_search`、`reference_read`、`reference_search`、`memory_propose`、`experience_propose`、`experience_search`。最终 review 回执已写 `externalTools:0, coreSessionTools:true`。受控模型没有执行这些工具；本点未启用 MCP、设备或云端本地命令，工具列表也不是 OS 沙箱证明。

JSONL v1 的 event 通知只包含身份和事件类型，不包含回答文本；Desk 的显示适配器读取 Harness 已写入并 sync 的固定事件文件，验证 Task/Run/连续 seq，只转发 `text_delta`。这是当前固定来源下的适配，不宣称存在通用、稳定的 JSONL 文本流协议。

两份旧正常 wire 的 `stream` 已为 true。两段短 SSE 合为一条 delta 的原因在 pinned rpi `openai_completions.rs`：累计 64 bytes，或下一次 push_text 时距上次输出已过 40 ms 才 flush；结束/通道边界输出尾段。**没有独立每 40 ms 的 flush 定时器**，短首段后上游沉默仍可等到下一段或边界。Core 本身直接转发原生 TextDelta，当前 ModelHost 是 resolve 接口，未见仅返回终态文本的 `JsonlHost.complete/ModelResponse` 路径。本轮不修改共享 Core，也不保证每个上游小 chunk 都立即出字。

取消或中断后，对话保留原 Session 及围栏并阻止新提交。`max_runs=1` 使现有 `resume_checked` 遇到已耗尽 Run 预算时拒绝继续；本点没有删除围栏、偷偷换 Session 或把聊天转录重放成新恢复。**记录可查询不等于原 Session 已可恢复执行。**

## 默认隔离、回归与失败成本

`work/desk-default-test.log`：独立默认服务进程 **1/1 通过，1.228127 秒**；只复制 service/contracts，运行目录无 platform 树，去掉所有 REACH_DESK 配置后 `/healthz=200`、Desk route=404。原件 `desk-default-d5d2bde4-a18d-4657-962e-5a6abce4f3da/verified.json` 与源码相符。这支持默认启动无平台依赖，不接受完整发布包/安装器隔离或默认 CLI/MCP 全流程。

基础回归 `work/desk-base-regression.log` 为 **15/15，18.641174 秒**。最终 platform 类型检查日志为空；基础类型检查记录两份 tsc 命令，主代理报告通过。`desk-diff-check.log` 只有既有 CRLF 警告。当前普通 sidecar 构建成功日志为 **11.31 秒**；前次 `--locked` 因 lockfile 需更新失败仍保留，不能记为一次无失败构建。

旧受控 r1 为 0/1，8.374 秒；r2 为 2/3，21.456 秒；r3 为 6/6，34.214 秒。r1 的历史断言曾把 Host 派生上下文内的原文引用算作再次提交，r2 曾错误要求 wire 完全没有工具。r3 又存在两个覆盖缺口：把 Core 追加的预算 user 当作业务 user 判 wait，使挂起分支没有被执行；只检查 running 状态，未证明 provider 完成前客户端收到了文本。最终 r4 已修复这两项测试并保留生命周期原件。**r3 的通过数不再作为真实挂起取消或 EOF 前流式的证据。** 旧日志及失败不被覆盖；最终快照不冒充旧轮次源码。

## 两轮真实模型均未通过

| 原件 | 模型 | 结果与耗时 |
|---|---|---|
| `desk-real-ff0f0fba-1388-4c4d-b37b-e9aa51eab3cd`，日志 `desk-real-model-r1.log` | `opencode/mimo-v2.6-flash-free` | 0/1；总测试 62.435 秒；60 秒 Run 预算内无正文，unknown / ReconciliationRequired / Present |
| `desk-real-932edf81-09ee-4fb4-841e-d229a7e7b903`，日志 `desk-real-model-r2.log` | `opencode/nemotron-3.5-lightning-free` | 0/1；总测试 62.624 秒；60 秒 Run 预算内无正文，unknown / ReconciliationRequired / Present |

两轮 `/models` 原件均列有所选模型，路径是 SSH 转发到既有 Ray opencode2api；每轮配置 maxRuns=1、maxCalls=1、maxOutput=512、maxSeconds=60。十一条 Task 复核中的这两条没有任何 text_delta，Desk output 为空，对话 blocked，无 reply-review 或成功 receipt。两条进程均正常结算并写 `delivery=validated`，这仅证明终态交付，**不能覆盖回答失败**。Core 的 deadline failed 和 Harness 的 unknown/ReconciliationRequired 一起保留。

这只是两轮真实试验，不证明只有两个上游传输请求；Core maxCalls 是逻辑预算，不能替代网关重试计数。未取得有效用量/费用，不把未知记零。尚无证据将无正文准确归因于模型本身或网关某一层；本代理没有换模型继续试跑。

## 仍开放的交付

真实云端回答及稳定模型路由、聊天 UI、真实跨 Ray 代理的退出/到期取消、设备选择和委托、图片/文件模型消费、取消后原 Session 恢复、扩展完整打包安装、旧平台能力/数据迁移、生产启用与回退均未由本点完成。现有 Ray 源码有会话到期 deadline 与退出连接撤销机制；本轮本地 auth 测试不能代替已部署代理链验收，也不据此声称 Ray 缺失该机制。

本次未提交、推送、部署、安装或修改线上入口。完整基础清单和 X 清单不由本报告自动勾选。已完成人工事实和措辞审读；先前在项目及列出的宿主技能目录未找到 humanizer 入口，未记作已执行工具。
