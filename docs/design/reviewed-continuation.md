# 审核后继续同一 Task

作者 Ray Zhang

## 目标与 Requirements

Host 在收到已释放 Session 所有权的 Task 结果后，可以提交追加审核意见，在新进程中继续该 Task。入口为 `continue_reviewed`，执行复用 Harness 的 `spawn` 和 `run_task`。

| 编号 | 验收条件 |
|---|---|
| RC-1 | 多次跨进程继续保持原 Task、Session、任务类型、验收版本、授权版本、总预算和截止时间 |
| RC-2 | 只有已释放且副作用已结清的 `NeedsChanges` 或 `AwaitingHostAcceptance` 结果可进入此入口 |
| RC-3 | Host 提交绑定原 `ReviewBasis` 的、已持久化且已结清的 `NeedsChanges` 收据，提供非空反馈与证据引用 |
| RC-4 | 原始模型、路径、工具声明和凭据摘要一致，单 Run 上限不超过前序授权 |
| RC-5 | 原结果只认领一个 successor，重试定位同一 evidence 和 Run，已存在 fence 的状态进入 `resume_checked` |
| RC-6 | 累计消耗跨 continue 和 crash resume 保留，缺少完成观察的 Run 按 admission 中调用上限计费 |
| RC-7 | 原 `released.json`、事件与 Journal 证据可核验，Host 可检查完整前序引用与追加审核收据 |

## 审核语义

`ReviewedContinuation` 包含前序 evidence 目录、预期 `released.json` SHA-256 和可选追加 `ReviewReceipt`。Host 在调用前提交自己的审核证据。

原结果为 `NeedsChanges` 且原收据已有非空反馈时，可以省略追加收据。当前 Harness 会自动执行非空反馈的普通 Run 内继续，正常释放为 `NeedsChanges` 的常见情形是反馈为空。此时 Host 需要补充带非空反馈的已提交收据。

原结果为 `AwaitingHostAcceptance` 且原收据为 `Verified` 时，Host 必须提交新的 `NeedsChanges` 收据。追加反馈仍以原验收条件为准。调整验收版本、授权范围、总预算或截止时间会被拒绝。业务侧接受状态由 Host 管理，Host 负责在已接受 Task 的业务入口拒绝追加工作。

新收据的 `ReviewBasis` 必须逐字段等于原收据。入口在 Session 独占锁内重新校验原事件摘要、Journal head、原始记录范围及 proof。反馈被加入下一 Run 的 objective，并随 continuation 证据保存。

## 持久化顺序

1. 获取原 Session 独占锁，确认当前无 fence。
2. 校验 released 摘要、Task 条款、原审核收据、权限、预算和 Journal。
3. 在新 evidence 目录保存 `task.json`、`task-options.json`、`authority-record.json`、授权快照及 `continuation.json`。
4. 在前序 evidence 中新增 `continuation-claim.json`，绑定完整 successor 元数据及反馈收据。
5. 写入新 Session fence，然后调用正常 Harness 执行入口。

每个新 admission 都保存无凭据明文的 `authority-record.json`，包含 authority 声明摘要、单 Run 调用与时间上限。旧 evidence 缺少该记录时，入口明确报告无法确定原始单 Run 上限。

`continuation.json` 保存累计 Run 与调用消耗。`consumed` 读取该基数，继续扫描当前 evidence 的 admission 与 observation，再与 outcome 核对。后续 fenced resume 使用相同计数逻辑。

## 崩溃与重试

| 中断位置 | 后续处理 |
|---|---|
| successor evidence 写入期间，claim 尚未提交 | 原结果仍可用，Host 使用新的 evidence 目录重新提交，保留未完成目录供检查 |
| claim 已提交，fence 尚未写入 | 使用完全一致的 successor 请求重试，核对已有 continuation 记录后完成 admission |
| fence 已写入 | 通过 `resume_checked` 核对原工具副作用和累计消耗 |
| successor 已执行或已有 outcome | 返回已认领状态，Host 读取 successor 结果或现有 fence |
| 文件残缺、来源证据变化或 Journal 发生后续修改 | 返回明确错误，保留原证据和所有权记录 |

Session 锁保持至 Harness supervisor 完成。进程死亡由 OS 释放文件锁。业务队列 lease 过期时，需要另行检查实际锁、fence 和执行收据。

## 实现与验证清单

- [x] 1. 新增 `ReviewedContinuation` 与 `continue_reviewed`，核验已释放结果和 Host 反馈。Requirements RC-1、RC-2、RC-3。
- [x] 2. 持久化原 authority record，校验 TaskOptions 和单 Run 上限。Requirements RC-4。
- [x] 3. 持久 successor 认领，准备证据后发布 fence。Requirements RC-5、RC-7。
- [x] 4. 复用 `consumed` 的累计基数与正常执行路径。Requirements RC-6。
- [x] 5. 运行多次真实子进程继续、进程在工具中退出后 resume、预算和审核拒绝测试。Requirements RC-1 至 RC-7。针对性测试 6/6 通过，包含子进程入口与 5 个场景。
- [x] 6. 完成最终留证回归并交主线程验收。

2026-11-11 最终验证在 C 盘安静环境中按 `--test-threads=1` 串行执行，continuation 6/6、resume 9/9 通过，保留原 Task 30 秒截止时间及断言。最终 Harness clippy、rustfmt 和 diff-check 通过。独立 Codex reviewer `/root/morrow_diff_review` 回读实现、共享接线、测试和本设计后，未发现阻断项。主线程负责最终接受和提交。

真实子进程覆盖多次继续及工具执行后 `exit(73)` 的恢复。claim 已提交、fence 尚未发布的窗口通过重建对应持久文件状态验证。真实在线模型与业务产品接入尚未覆盖。测试程序身份、源码摘要、失败记录和最终日志见[验证记录](../evidence/reviewed-continuation-20261111.md)。
