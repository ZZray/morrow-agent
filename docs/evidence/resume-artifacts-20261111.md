# 原 Run 产物恢复验证

作者 Ray Zhang

交付前在 `825df7c` 上复核相同源码摘要，并重新运行全部已交付 Harness 库与集成测试，133 项通过。执行程序、SHA-256、逐目标日志及耗时见[同批交付回归记录](reviewed-continuation-20261111.md#交付前-harness-回归)。

## 版本与范围

工作区为 `E:/repos/morrow-agent`，基线提交为 `745811a9fa68937753bbdd788c0d735854941e7d`。本记录对应提交前已验证的恢复增量，设计与 Requirements 见[原 Run 对账产物恢复](../design/resume-artifacts.md)。

实现增加 `recovery_artifacts.rs`、接入 `runner.rs` 的 prepare/recover 顺序，并保存 admission 的 Run 范围与 Session 身份。测试覆盖原调用对账、产物补写、旧格式恢复、来源校验和重复接管。

| 文件 | SHA-256 |
| --- | --- |
| `crates/morrow-agent-harness/src/recovery_artifacts.rs` | `0CBE429F205E7388B39B792DEB1CF351D67DF643AFBD2347F0A76203E5AF1EC9` |
| `crates/morrow-agent-harness/src/recovery_artifacts_tests.rs` | `B004B8DECC24F8237E34520B5BF67063D24FB068FAE266AF08E15401E20F649C` |
| `crates/morrow-agent-harness/tests/resume.rs` | `D659F8750ABE6680EDBF964ED8D69821BF197FFDC0355DA7D4B5F1E312140613` |

最终 C 盘 `resume.exe` 与 D 盘原测试镜像 SHA-256 一致，均为 `03BC0C25DECFA466345D2B942081E5985A6BCA07FEC32977BCE722B3C0FC181A`。该镜像包含原 30 秒 Task 夹具和原验收断言。

## 最终执行结果

| 检查 | 结果与覆盖 |
| --- | --- |
| `cargo test -p morrow-agent-harness --lib --locked --offline -j 2 recovery_artifacts -- --nocapture` | 11/11 通过，执行 84.96 秒，含 10 个行为测试和 1 个子进程入口 |
| 最终源码的 `cargo test -p morrow-agent-harness --test resume --locked --offline -j 2 -- --nocapture` | 实施代理运行 9/9 通过，执行 0.85 秒。原始工具输出为 session `27287`、chunk `5f8ccf` |
| C 盘 quiet 环境执行同一 `resume.exe --test-threads=1 --nocapture` | 9/9 通过，执行 1.85 秒，原 Task 期限为 30 秒 |
| `cargo clippy -p morrow-agent-harness --all-targets --locked --offline -j 2 -- -D warnings` | 通过，10.23 秒，覆盖最终 legacy 恢复增量 |
| `git diff --check` | 通过 |

恢复模块日志在 `D:/WorkSpace/tmp/morrow-recovery-20261111/final-recovery-module.txt`。最终 resume 日志在 `C:/Users/loveu/AppData/Local/Temp/morrow-harness-final-20261111/resume-results.txt`，clippy 日志在 `D:/WorkSpace/tmp/morrow-continuation-20261111/final-clippy.txt`。

## 恢复模块覆盖

| 场景 | 实际检查 |
| --- | --- |
| 新旧 admission 的退出窗口 | 两种格式各执行对账前、对账后、部分产物、全部产物无 marker、已有 marker，共 10 个组合。子进程以 `process::exit(86)` 退出 |
| Failed、NotExecuted | 两种 settlement 各覆盖对账前后退出，共 4 个组合。检查落盘结果、错误标志和重复恢复后的记录数 |
| 已有产物状态 | Verified、Revoked 状态及 Host receipt 保留。重复恢复的 ledger 字节一致。不可变来源冲突拒绝 |
| 后继 Run | 原批次不完整时拒绝。完整但缺 marker 时保留原计划与新计划。原 marker 完整时只处理新计划 |
| 计划与来源变化 | target、Task、Session、Run、索引、receipt、proof 变化，以及等长 Journal 字节篡改均拒绝 |
| 旧字段兼容 | 旧 resume 缺少恢复字段时可恢复。`null`、对象和损坏数组拒绝 |
| 空 Session 身份 | 新旧 admission、有无 open calls、对账前后退出共 8 个组合。原生对账完成，marker 明确 `unavailable_session`，产物清单为空 |
| 旧 resume 无计划且已完成对账 | 新旧 admission 各覆盖准备后、部分产物、已有完成记录三个状态，再进行第三次接管，共 6 个组合。保留旧 resume 字节，固定新补写目标 |
| 历史对账来源变化 | 计划保存后改变原 receipt 证据，恢复拒绝发布产物 |

模块夹具直接构造受控 Journal 输入，实际运行 Core reconciliation、Harness 接管、文件落盘和子进程退出。新 admission 夹具的原 Run 范围为 `[2, 6)`，生成三个记录，其中较早闭合调用保留 Unknown。旧 admission 精确生成两个对账调用记录。

## 公共 resume 入口

新增用例在第一次恢复时将 `tool-artifacts.jsonl` 路径设为目录，制造产物发布失败。Core 对账已提交，pending Run 已清除，下一 Run 尚未发出模型请求。移除夹具障碍后再次调用公开 `resume`，核对原结果复用和产物补写。

最终 C 盘现场位于 `C:/Users/loveu/AppData/Local/Temp/morrow-harness-final-20261111/resume/public-resume-pXzs2a`。

- `first/recovered-run-1-artifacts.json` 绑定原 Run，范围为 `[0, 3)`，包含一个原生调用产物。
- `second/released.json` 为 `AwaitingHostAcceptance`，累计 2 个 Run、6 次调用，fence 已释放，`task_accepted` 为 false。
- 原工具的测试计数为 1，原 evidence 字节保持一致，第二个 Run 的 manifest 只引用自己的产物。

公共恢复测试使用受控 HTTP provider 和计数工具。原 owner 丢失由关闭独立 Tokio runtime 模拟。模块的退出窗口使用真实子进程。空 Session key 的公共回归还覆盖旧 admission、已打开工具调用及显式不可用产物覆盖。

## 保留的失败与处理

### Session 锁仍被占用

一次 D 盘留证运行得到 resume 8/9，执行 3.19 秒，新增恢复重试用例在首次 `resume` 遇到 Windows OS 33。现场保存在 `D:/WorkSpace/tmp/morrow-recovery-20261111/public-resume-fZiZSv`，尚未创建第一次恢复目录。原始工具输出为 session `47897`、chunk `5e6624`，该次 stdout 未保存为独立日志文件。

夹具原先调用 `runtime.shutdown_timeout(Duration::from_millis(0))`。锁文件由 runtime 内的 Harness owner 持有，零等待允许测试线程在 worker 释放资源前继续。锁定的 Tokio 1.54.1 文档明确将零时长调用等同于不等待 spawned work 的 `shutdown_background`。

夹具改为有界等待 5 秒，使接管测试在被取消 worker 有机会退出后开始。后续相同断言通过。

### D 盘运行耗尽原 Task 期限

重建后的 D 盘运行再次得到 resume 8/9。失败用例在第二次接管完成产物补写后，下一 Run 准入返回 `BudgetExhausted`，累计仍为 1 个 Run、4 次调用。运行用时 30.12 秒。

现场 `public-resume-mDoNG5` 的写入时间从 UTC `17:41:36` 的 Session lock 延续到 `17:42:02` 的 artifact、`17:42:03` 的 marker 和 `17:42:04` 的 task-options。原 Task 截止为 `17:42:05.428`，下一 Run 已没有足够时间预算。日志在 `D:/WorkSpace/tmp/morrow-continuation-20261111/final-tests-rebuilt.txt`。

主线程随后安排 C 盘 quiet 环境串行对照，使用同一已构建镜像、原 30 秒期限和原断言，resume 9/9 在 1.85 秒内通过。对照同时改变了存储位置与并发负载，结果记录为运行环境差异。D 盘原失败继续保留。曾拟将该夹具期限设为 120 秒，该修改已撤回，最终源码与测试镜像使用原期限。

### 共享构建缓存

跨目录快照构建与主仓共用 target 后，一次构建未解析到 `ReviewedContinuation` 和 `continue_reviewed` 导出。主线程核对缓存来源后授权重建主仓 Harness，后续成功生成当前镜像。该编译失败保存在 `D:/WorkSpace/tmp/morrow-continuation-20261111/final-tests.txt`。

## 独立审查与验收边界

独立 Codex reviewer `/root/core_scope_review` 审查了恢复实现、runner 接线和测试。审查发现 Native 空 Session key 的恢复回归，随后增加 `UnavailableSession` 并通过对应测试。主线程进一步要求补齐旧 resume 无计划且 Core 已对账的历史输入，最终 reviewer 回源核对 `previous_reconciliation` 的字节摘要、合法链、原 Task/Session/admission、收据与精确结果，结论为无阻断。

实施代理 `/root/morrow_diff_review` 执行恢复模块和初次完整 resume 回归。`/root/morrow_post_diff_review` 执行最终 Harness clippy、D 盘留证与 C 盘 quiet 对照。实施代理已回读最终日志、原 Task、恢复 marker 和 released outcome。

本阶段验收覆盖受控模型响应、真实本机 Journal 与文件、实际子进程退出以及公开 Harness 恢复入口。真实在线模型、业务产品 Host 和生产环境验收仍未执行。旧 admission 的早期闭合调用缺少归属证据时保持未覆盖。空 Session 身份通过 marker 明确记录产物覆盖不可用。
