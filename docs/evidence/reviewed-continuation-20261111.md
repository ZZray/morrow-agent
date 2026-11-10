# 审核后同 Task 继续验证记录

作者 Ray Zhang

## 版本与范围

测试仓库为 `E:/repos/morrow-agent`，测试时 HEAD 为 `745811a9fa68937753bbdd788c0d735854941e7d`。本记录覆盖该基线上的 Harness 工作区增量，包括审核后继续、共享累计消耗与 authority 持久化接线，以及同时交付的 artifact recovery。

实现规范见[审核后继续同一 Task](../design/reviewed-continuation.md)。以下 SHA-256 按测试机上的实际文件字节计算。

| 源码文件 | SHA-256 |
|---|---|
| `crates/morrow-agent-harness/src/continuation.rs` | `3eef18e3462627ca04e4328ea42e86fccb21db44eba5271ea1d3c5e4340ddc7f` |
| `crates/morrow-agent-harness/src/runner.rs` | `b0b0689f052ba951c35aee6544489489f3287974d4ac84974a5d1973d487102c` |
| `crates/morrow-agent-harness/src/storage.rs` | `ef7de2119d90ff65f452eb41d1e0c0660042fa39242e2919fc96dd810a40e877` |
| `crates/morrow-agent-harness/src/lib.rs` | `2edcb3aa3735bb72b61965c057c48f5d7b6f9a6dcaa86186d7df558a1d1fd502` |
| `crates/morrow-agent-harness/tests/reviewed_continuation.rs` | `681ce857b3fb9c92ffcb2d015f8a98505db43a08f99724c2db76b48684ee6295` |
| `crates/morrow-agent-harness/tests/resume.rs` | `d659f8750abe6680edbf964ed8d69821bf197ffdc0355da7d4b5f1e312140613` |

## 最终执行

两份测试程序在主仓重新构建后复制到 `C:/Users/loveu/AppData/Local/Temp/morrow-harness-final-20261111/`。执行期间没有 Cargo 或其他测试竞争，两个目标依次运行，各目标使用 `--nocapture --test-threads=1`。Task 保持原 30 秒截止时间及原断言。

| 测试程序 | SHA-256 | 结果 | 耗时 |
|---|---|---|---|
| `reviewed_continuation.exe` | `d42480171a5c67d14f7023e8fee95c338b62e1f9d799961781a98e647a077bd5` | 6/6 通过 | 1.12 秒 |
| `resume.exe` | `03bc0c25decfa466345d2b942081e5985a6bca07fec32977bce722b3c0fc181a` | 9/9 通过 | 1.85 秒 |

原构建目标分别为 `reviewed_continuation-67e823afb7e72e58.exe` 和 `resume-e7e105b1e0ffb14b.exe`，位于共享 target 的 `debug/deps`。C 盘副本的 `current_exe` 用于后续子进程启动。

```powershell
$finalDir = 'C:/Users/loveu/AppData/Local/Temp/morrow-harness-final-20261111'
$env:MORROW_CONTINUATION_EVIDENCE = "$finalDir/continuation"
& "$finalDir/reviewed_continuation.exe" --nocapture --test-threads=1
$env:MORROW_RECOVERY_EVIDENCE = "$finalDir/resume"
& "$finalDir/resume.exe" --nocapture --test-threads=1
```

该目录中的 `continuation-results.txt` 与 `resume-results.txt` 保存最终输出。完整案例保存在 `continuation/`，resume 的公开入口案例保存在 `resume/public-resume-pXzs2a/`。

| continuation 场景 | 对应 Requirements | 结果 |
|---|---|---|
| 多次新进程继续，保持 Task、Session 与累计预算，并拒绝耗尽后的请求 | RC-1、RC-6、RC-7 | 通过 |
| 工具先写实际效果收据，再以 `exit(73)` 终止进程，后续进程恢复并继续原 Task | RC-1、RC-5、RC-6 | 通过 |
| 重建 claim 已提交、fence 未发布的持久状态，恢复同一 successor 并拒绝竞争 successor | RC-5、RC-7 | 通过 |
| 已释放 `NeedsChanges` 接收已提交的新反馈并将反馈传入模型请求 | RC-2、RC-3 | 通过 |
| 拒绝授权变化、扩大上限、未提交或不匹配的审核、缺少反馈及旧 evidence 缺少上限 | RC-1、RC-3、RC-4 | 通过 |
| 子进程测试入口 | 支持上述真实进程用例 | 通过 |

## 静态检查与独立审查

最终执行以下检查，均通过。

```text
cargo clippy -p morrow-agent-harness --all-targets --locked --offline -j 2 -- -D warnings
rustfmt --edition 2021 --check --config skip_children=true crates/morrow-agent-harness/src/lib.rs crates/morrow-agent-harness/src/runner.rs crates/morrow-agent-harness/src/storage.rs crates/morrow-agent-harness/src/continuation.rs crates/morrow-agent-harness/tests/reviewed_continuation.rs
git diff --check
```

Clippy 原始日志为 `D:/WorkSpace/tmp/morrow-continuation-20261111/final-clippy.txt`，耗时 10.23 秒。独立 Codex reviewer `/root/morrow_diff_review` 核对 `continuation`、`storage`、`runner` 的累计消耗和 takeover 接线、授权声明、ReviewBasis 检查、测试及设计文档，报告无阻断项。主线程负责接受和提交。

## 失败与纠正记录

### 重复原生工具调用 ID

早期夹具在多个 Run 中复用了 `write-correct`，两个跨进程场景被 Core 的 Session 级防重放检查拒绝。夹具改为逐 Run 唯一 ID，随后 6/6 通过。原防重放实现得到保留。

### Session 锁尚未释放

一次 D 盘 resume 回归为 8/9，耗时 3.19 秒。公开 recovery 重试案例在第一次 resume 时收到 Windows OS33 文件锁错误。原始输出仅存在于执行会话 `47897` 的终态输出 `5e6624`，未另存 stdout 文件。现场位于 `D:/WorkSpace/tmp/morrow-recovery-20261111/public-resume-fZiZSv/`。该次失败与后续编译失败使用不同证据，后续 fixture 调整及恢复验证由 artifact recovery 记录说明。

### 临时快照复用了共享构建产物

临时源码快照与主仓使用同名 workspace package 和共享 Cargo target 后，测试编译报 `ReviewedContinuation`、`continue_reviewed` 导出不存在。当前主仓 `lib.rs` 已有这两个导出，dep-info 同时显示含新模块和缺新模块的产物版本。核对后刷新主仓 `lib.rs` 的修改时间，强制本 crate 重建，导出缺失错误消失。后续临时快照采用独立 target。

编译失败完整日志为 `D:/WorkSpace/tmp/morrow-continuation-20261111/final-tests.txt`。

### D 盘留证运行达到截止时间

| 目标 | 当次结果 | 观察 | 日志 |
|---|---|---|---|
| resume | 8/9，30.12 秒 | recovery 重试返回 `BudgetExhausted`，累计 Run 为 1、调用为 4 | `D:/WorkSpace/tmp/morrow-continuation-20261111/final-tests-rebuilt.txt` |
| continuation | 2/6，35.50 秒 | 四个执行场景返回 `Cancelled` 或达到原截止时间 | `D:/WorkSpace/tmp/morrow-continuation-20261111/final-continuation.txt` |

resume 现场为 `D:/WorkSpace/tmp/morrow-recovery-20261111/public-resume-mDoNG5/`。continuation 五个场景的目录在当次日志中逐一列出，均保留在 `D:/WorkSpace/tmp/morrow-continuation-20261111/`。

随后在 C 盘安静环境中串行执行相同预算和断言的程序，得到本记录的最终通过结果。路径和竞争条件同时变化，因此该对照只确认 C 盘安静串行环境下的行为，D 盘原失败仍保留。

## 交付前 Harness 回归

在 `825df7c486b2e4afd1e36508fc062e774159a24c` 上核对同一组源码摘要后，重新编译库测试和全部 17 个已交付 integration targets。构建使用 `--locked --offline -j 2 --no-run --message-format=json`，耗时 30.17 秒。下一阶段的 `orchestration` 尚在实施，本次编译时其公开导出暂未接入。

测试程序复制到 `C:/Users/loveu/AppData/Local/Temp/morrow-harness-regression-20261111/`，依次以 `--nocapture --test-threads=1` 执行，`TEMP`、`TMP` 和恢复证据均指向该目录。18 个程序合计 133 项通过，0 失败、0 忽略，执行耗时合计 152.76 秒。包含库测试 37 项、continuation 6 项、resume 9 项，以及 artifact review、budget snapshots、completion gate、outcome compatibility、provenance query、Skill provenance、stability surface、stop review、summary budget、TaskSet、Task 和 unknown effects 回归。

该目录保留 `build.jsonl`、`build-stderr.txt`、`test-targets.txt`、`binaries.json`、`results.json` 及逐目标日志。`binaries.json` 保存实际执行程序的 SHA-256。

随后对同一库、17 个 integration targets 和现有 examples 执行 `cargo clippy --locked --offline -j 2 -- -D warnings`，通过，耗时 3 分 05 秒。`cargo test -p morrow-agent-harness --doc --locked --offline -j 2` 通过，当前有 0 个 doctest。对应日志为 `clippy.txt` 和 `doc-tests.txt`。独立 Codex reviewer `/root/morrow_diff_review` 再次核对 13 个恢复与续作交付文件，源码摘要、共享入口、设计与验证记录一致，允许按该范围提交。

## 覆盖范围

真实进程验证覆盖跨进程 Session 所有权、多次继续、工具写入后进程退出、fenced resume 和累计预算。pre-fence 认领窗口使用受控持久状态重建。HTTP provider 的响应由夹具控制，真实在线模型、业务产品接入、持续高 I/O 负载下的性能及完整应用流程尚未验证。
