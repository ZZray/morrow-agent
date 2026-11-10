# 原 Run 对账产物恢复

作者 Ray Zhang

## 需求

- R1　Host 对账为崩溃原 Run 补入的 ToolResult 能生成 ToolArtifact，来源绑定原 Task、Session、Run 和 native call。缺少 Session 身份的历史输入按 R4 记录覆盖缺口。
- R2　对账提交后再次退出，恢复仍能发现并完成尚未完成的产物补写。
- R3　部分追加、全部追加但未写完成记录等情况下可再次补写。已有验证或撤销状态及 Host receipt 得到保留，来源冲突明确报错。
- R4　已有数据继续走恢复入口。可确定的来源范围准确记录，缺少 Run 边界时只派生已精确定位的原调用。缺少 Session 身份时保留原生恢复，并记录产物覆盖不可用。
- R5　恢复遵守现有 Session 所有权、Host settlement、累计预算和 fence 契约。工具执行由原生调用与已有对账约束管理。

## 改动前的恢复缺口

基线 `745811a9fa68937753bbdd788c0d735854941e7d` 的 `resume_checked` 在新 fence 与 resume 记录落盘后直接调用 Core reconciliation。Core 提交结果后清除 pending Run。此后进程退出，下一次 inspection 得到的 interrupted Run 为空，原调用的产物补写缺少持续追踪。

当时原 Run 的 `raw_start` 只存在于执行过程内存，admission 未持久化该值。普通 Journal Run receipt 也缺少完整对账范围。逐条 artifact append 会拒绝重复的同状态记录，需要在补写入口核对并复用已有记录。

## 持久化与恢复顺序

1. `prepare` 读取前序恢复计划，核对当前 Task、Session、目录、Journal 和原 Host settlement。
2. 在本次 `resume.json.artifact_recovery` 中保存计划，固定原 Run 身份、首次补写目标目录、admission 摘要、原始范围或精确 call/result 索引、范围 proof 及原收据。
3. 沿现有 `take_over` 顺序持久化 resume 记录并发布新 fence。
4. `recover` 先处理计划。原 Run 仍 pending 时调用 Core 对账。已完成时核对 `contains_run` 和原 ToolResult，复用已落盘结果。
5. 核验 Journal 字节、范围 proof、工具名称、调用 ID、对账状态、输出和证据引用，再派生并追加缺失产物。
6. 完整复核目标 ledger 后，原子保存 `recovered-run-N-artifacts.json`，随后进入下一 Run 的正常启动流程。

完成记录包含计划摘要、固定 `raw_end`、范围 proof、artifact ID 清单和覆盖类型。再次读取已有完成记录时，继续核验原来源与 ledger。原对账结果的范围终点为原 `raw_count` 加对账调用数，后续 Run 的消息具有独立范围。

Session 锁覆盖接管和恢复过程。计划随接管链继承，首次补写目标目录保持固定。已有原 Run 计划与新的 pending Run 共存时，原产物批次必须已经完整发布并能核验，随后补齐缺失完成记录。

## 来源覆盖

| 输入 | 完成记录中的覆盖 | 处理 |
| --- | --- | --- |
| admission 含 `raw_start` 和非空 `session_id` | `full_run` | 派生原 Run 精确范围内的已闭合调用，包括对账前已完成的调用 |
| 旧 admission 同时缺少两个字段，Host 提供非空 Session key | `reconciled_calls` | 从 inspected open calls、原 `raw_count` 和最后 Assistant 定位调用，只保留精确确认的对账调用 |
| Native Host 的 Session key 为空 | `unavailable_session` | 完成原生对账与恢复，核验原结果，artifact ID 清单为空，并明确记录身份缺口 |

新 admission 持久化 `raw_start` 和 `session_id`。旧数据中更早已闭合调用缺少 Run 归属证据时，该部分保持未覆盖。Native Host 历来允许空 Session key，此类输入沿用原恢复入口。产物覆盖需要具备可用的 Session 身份。

## 旧 resume 已对账且缺少补写计划

当前 fence 指向的旧 `resume.json` 缺少 `artifact_recovery`，且 Core 当前 pending Run 为空时，`prepare` 检查旧记录保存的 `interrupted_run`、原收据、Run 计数和前序目录。证据完整时重建原调用的精确计划，目标设为本次首次补写目录。

计划的 `previous_reconciliation` 保存旧记录目录与原始字节 SHA-256。恢复时核对旧记录的版本、类型、Task 条款、Session 路径、原收据和调用范围，并确认该目录处于合法接管链中。Core 的 durable 完成状态和精确 ToolResult 也必须匹配。旧 resume 文件保持原样。后续接管继承新计划及其固定目标。

历史补写覆盖当前 fence 所指旧 resume 记录中的原 Run。`artifact_recovery` 为 `null`、错误结构或损坏数组时按格式错误处理。缺少该字段才进入旧格式兼容路径。

## 产物状态与故障

补写复用既有 artifact ID 和 hash 算法。相同来源的 Candidate、Verified 和 Revoked 记录保留当前状态及 Host receipt，Unknown 状态继续保留。不可变来源冲突、Journal 或原收据变化时返回错误，保留现场与 fence。

Completed、Failed 和 NotExecuted 对账均核验对应 ToolResult。恢复使用原 Task 的累计调用消费和截止时间，补写期间消耗的时间也计入原期限。

## 验证任务

- [x] 1. Completed、Failed、NotExecuted 对账分别关联原 Run 的真实 Journal 结果。公共恢复用例检查受控工具调用计数为 1。Requirements R1、R5。
- [x] 2. 新旧 admission 分别覆盖对账前、对账后、部分产物、全部产物无完成记录、已有完成记录五个真实子进程退出窗口。Requirements R2、R3、R4。
- [x] 3. Verified、Revoked、Unknown 状态保留，后继 Run 来源隔离，缺少完成记录可补齐。Requirements R1、R3。
- [x] 4. 旧 admission 精确覆盖、空 Session 有无 open calls、旧 resume 无计划且已对账后的再次接管。Requirements R4。
- [x] 5. 身份、索引、receipt、proof、原始 Journal 字节及历史对账记录变化均拒绝。Requirements R1、R3、R4。
- [x] 6. 公共恢复检查累计预算、fence、原证据字节，以及对账已提交后产物发布失败的再次恢复。Requirements R2、R5。
- [x] 7. 恢复模块 11/11、C 盘 quiet 环境原 30 秒夹具的 resume 9/9、Harness clippy 通过，独立 Codex 终审无阻断。Requirements R1–R5。

D 盘留证运行的锁冲突与截止失败均保留。运行环境、各次结果和真实模型未验收范围见[恢复验证记录](../evidence/resume-artifacts-20261111.md)。
