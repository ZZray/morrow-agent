# Reach Desk 原生状态只读检查：Core 本地候选

作者：Ray Zhang（Ray）。日期：2026-11-03。只做本地开发与测试，不连接服务器、不请求远端模型、不部署、不安装、不提交或推送。

## 本轮实现及边界

新增共享 `ara_agent_lite_core::agent::inspect_session(&InspectionRequest)`。它不启动 Run，不读取模型凭据，不执行工具，不清理 marker，不迁移 checkpoint，也不判断 Task 已接受或效果已结算。它报告原生状态，供 Host 在原任务证据和同一 Session 锁下核对。

入口是[session_inspect.rs](../../../../crates/ara-agent-lite-core/src/session_inspect.rs)。本轮另改 [agent.rs](../../../../crates/ara-agent-lite-core/src/agent.rs) 的导出及共用 transcript validator、[session_journal.rs](../../../../crates/ara-agent-lite-core/src/session_journal.rs) 的纯读 head/Run index，以及 [context_memory.rs](../../../../crates/ara-agent-lite-core/src/context_memory.rs) 的精确字节检查。新增[实际 Core 集成测试](../../../../crates/ara-agent-lite-core/tests/session_inspection.rs)。以上五个文件是独立源码复核范围。

检查包括：

- 区分三个原件都不存在的运行前空基线与缺失 Journal、legacy checkpoint、残留 pending/context。后者拒绝，不当作新会话。
- 使用原生 Journal 读取并核对**全部记录**，而非仅看 head checksum 或 proof 端点。验证 from_raw 和 active_base 都落在完整交换边界，当前保留片段符合普通加载的条数及字节容量。
- 读取真实 Run index 的 Run、提交序号、原始 SHA 和可选 data。普通已完成 Run 的 data 可以为空；超过 64 个近期 Run 后仍核归档索引。pending、未配对调用及结构化未知效果明确报告。
- 复用 Store 的来源/summary 校验，验证精确读到的 context 字节，并核对下一次普通 Run 所需的 projection。原始 context SHA 与内存中可能归一化的旧 summary proof 分开记录，不写回原件。
- 将经验记录与完整原生回执重新构建比对，不能用截断摘录的形状校验代替完整输出核对。此比对证明回执内容一致；消息的 Run 归属仍需要 Host 保存的运行前基线和准入证据。
- 对 checkpoint、context、整个 Journal 目录、Run index、marker 及其存在状态前后做完整有界指纹；记录全历史 proof，供后续多轮基线使用。超过输入、记录、输出或文件数量预算时失败，不返回截断成功。

Core API 本身不取得 Session 锁。没有 Host 锁时，前后指纹只表示稳定观察，不能防 ABA、外部写者或恶意文件系统。接入关闭流程时必须在 Harness 已有 Session 锁内复核；这些后续接线尚未实现。`effects_unknown=false` 也不证明全部效果已结算。

## 最终执行

Windows，Rust 1.98.1（MSVC），`CARGO_BUILD_JOBS=1`，`RUSTFLAGS=-C target-feature=+crt-static`；缓存为 `E:/usr/var/cache/rust-target/reach-static`。全部 Cargo 操作串行，使用 `--offline --locked`。测试证据目录设为 `ARA_INSPECT_EVIDENCE_PARENT=E:/repos/ara/apps/reach/work`。

本轮最终版执行 **54 个不同函数，54 通过，0 失败/忽略**；均为本版新鲜执行，不把前一 r1/r2 或旧 Harness 矩阵合并计数。

| 命令选择（均加下方公共参数） | 结果 | 执行耗时 | 原日志 |
|---|---:|---:|---|
| `--lib session_inspect::tests` | 11/11 | 51.21s | [unit r4](../../work/desk-inspect-unit-r4.log) |
| `--lib context_memory::tests::` | 18/18 | 0.08s | [context 回归](../../work/desk-inspect-context-regression.log) |
| `--lib agent::tests::` | 12/12 | 13.86s | [agent 回归](../../work/desk-inspect-agent-regression.log) |
| `--lib session_journal::tests::` | 8/8 | 101.79s | [journal 回归](../../work/desk-inspect-journal-regression.log) |
| `--test session_inspection` | 5/5 | 21.33s | [实际 Core r4](../../work/desk-inspect-native-r4.log) |

公共命令：

```powershell
cargo test --manifest-path crates/ara-agent-lite-core/Cargo.toml --target x86_64-pc-windows-msvc --offline --locked <上表选择> -- --test-threads=1 --nocapture
```

`cargo test` 的最终编译时间依次为 3.84s、0.19s、0.18s、0.19s、4.98s。`--doc` 0 项、exit 0，见[日志](../../work/desk-inspect-doc.log)。`cargo fmt --manifest-path crates/ara-agent-lite-core/Cargo.toml --all -- --check` exit 0，见[实际退出记录](../../work/desk-inspect-fmt.log)。最初无 stdout 的 Tee 没有建 fmt 文件，第一次冻结因此未完成；重跑此短检查并记录退出码后才完成冻结。

`cargo clippy --manifest-path crates/ara-agent-lite-core/Cargo.toml --target x86_64-pc-windows-msvc --offline --locked --lib --tests --all-features -- -D warnings` 通过，6.75s，见[最终日志](../../work/desk-inspect-clippy-r3.log)。不把编译其他测试写成执行过其他测试。

`cargo deny --manifest-path crates/ara-agent-lite-core/Cargo.toml --config crates/ara-agent-lite-core/deny.toml --offline --locked check advisories bans licenses sources --show-stats` exit 0，见[日志](../../work/desk-inspect-deny.log)：四项均 0 errors；bans 保留 8 个 duplicate warnings，licenses 保留 1 个未遇到许可警告。缓存数据库未刷新，不是最新在线公告审计。

## 实际效果与故障证据

五组实际 Core 测试合计 **14 次 loopback 模型请求、11 份状态观察**。这里是原生 Core 调用和真实本地持久效果；上游回答由受控本地 HTTP provider 提供，没有外部组织模型。

| 场景及原件目录 | 核对到的事实 |
|---|---|
| [候选与管理命令](../../work/desk-inspect-native-commands-0970175f2da560e4a4efde83/observations.json) | 实际 memory_propose 写 candidate；实际 accept/revoke/correct/revoke 分别保存；只有最初 2 次模型请求。连续零新增 raw 的命令仍可沿完整 proof 核对下一基线，没有重投旧调用。 |
| [写入后取消](../../work/desk-inspect-native-cancel-proposal-5fd16220adcdfebcfe1948ab/observations.json) | 第二次模型请求到达时取消，Run 保留取消结果；此前保存的候选仍存在且未采用。 |
| [实际文件失败后成功及经验](../../work/desk-inspect-native-experience-d1a3da2ba8c1e2d38c9c2aa3/observations.json) | 内置 read_file 读取不存在文件失败，再读真实 present.txt 成功，experience_propose 保存未采用候选；检查重建两份原生回执。此组启用本地工具，不冒充 Desk 当前八工具配置。 |
| [当前 Desk 工具下拒绝伪造经验](../../work/desk-inspect-native-desk-experience-rejected-0ff6b2fd188e3e06bb606910/observations.json) | local tools 关闭，虚构回执 ID 被真实 experience_propose 拒绝，无候选保存。 |
| [自动摘要与候选](../../work/desk-inspect-native-summary-a1ff9a0a9229ffbaa29ea7d7/observations.json) | 实际自动 summary 模型请求、持久 summary 和 candidate 保留，全归档和本轮范围检查通过。 |

每组旁边保存 `provider-requests.json`、`events.json` 和 `native/` 原件副本。观察中的原始路径属于已退出测试的临时根；副本按该根下的相同相对路径映射，不能假称临时根仍存在。

11 项检查用例另验证：只读空基线、legacy/残留拒绝、有效 cleanup marker 原样保留、未确认 marker 拒绝、归档内部同长度损坏（端点 proof 仍合法）、活动片段切半/513 条超界、缺失或损坏 context、缺失 summary.refresh、错误 cwd/Run、future-seq index、工具对切半和旧基线拒绝、预算失败、旧 summary 只在内存归一化，以及截断经验内容篡改拒绝。最后输入守卫对 context/head/marker 变化的测试是直接调用该守卫，不是并发写入或 ABA 试验。

## 独立复核、失败记录及固定来源

独立 Codex `/root/reach_plan_review` 按 `ara-git-review`、`ara-rust-core-review` 复核五个目标，发现 P2：完整 Journal 合法时 active_base 仍可能切在工具对中，或活动容量超过普通加载边界。已补同一合同的校验和反例；未配对调用的效果未知标记也已补齐。另核对 projection 为纯读操作，以及原测试中 `chunks_exact(2)` 到 `as_chunks::<2>().0.iter()` 的等价替换。最终结论见[独立报告](../../work/desk-inspect-review-20261103.md)。

保留的失败：

- [unit r3，10/11](../../work/desk-inspect-unit-r3.log)：新缺失 refresh fixture 的 sources 为空，提前被合法来源校验拒绝。补真实 reference 的 ID/hash 后才到目标守卫；未放宽生产校验或原断言。
- [首次 Clippy](../../work/desk-inspect-clippy-r1.log)：受影响文件中的旧测试触发 Rust 1.98 chunks_exact lint。仅作等价迭代 API 替换，不关闭 lint。
- [首次离线 deny](../../work/desk-inspect-deny-r1-failed.log)：直接 cargo-deny 没继承本机 cargo.cmd 的 PATH 初始化，metadata 未启动；改经现有 cargo 包装器执行后通过，没有安装新工具或刷新网络缓存。

仓库 dev、HEAD `90f2b1cdd138129e2d331d89a37d70852e849739` 加保留 WIP。[冻结清单](desk-inspect-inputs-20261103.json) SHA256 `8810cc44c9a6dee92983cca34506250c47485e6efea115923b2078c2799fcc64`；129 来源、2 个实际测试 EXE 及副本、20 个证据根、221 项原件。来源身份 `5407bd20e628bc49877016e2463b7b5176d9207aea5fa28653b805f2cf91ffc1`；副本 `work/desk-inspect-source-8af43740-f8a2-4dc4-b285-7f7d5a5da3b7`。来源数量不是源码审查或测试覆盖率。

主代理完整回读独立报告并[直接复核](../../work/desk-inspect-final-check.json)483项当前来源/快照/原件/测试EXE摘要、54个不同通过身份，以及14次请求/11份观察和35个最终原件映射，全部匹配。6份文档127个本地链接、`git diff --check`通过。独立报告最终SHA为 `10ebe91cc021bffbb10868108a1c0f503d1e56137056fcf93c8a8f49534973d2`，该报告、本文和最终检查在清单之外单独核查，避免循环摘要。

当前普通 JSONL EXE **未重编**，仍为 SHA `8888878cf51bafb40b28c33e9c2662fd9e072f11e72f4b4c693b3af969244bb0`；它尚无本次 inspect 协议。服务器和安装包也未更新。本点没有重跑 Core 全部测试/目标、旧 Harness 78 项长矩阵、Windows SCM/SYSTEM/UAC、干净机、远端模型或 Ray 长流。旧全仓链接检查失败仍保留，不能称全仓全绿。humanizer 未安装，本轮文档人工审读。

## 继续完整首版

本点只完成共享 Core 检查候选。基础 0/52、Desk 0/5 不变，`platform/src/host.ts` 仍未接关闭或自动续聊。

下一步新增 tokenless JSONL/SDK 检查薄包装，处理 256 KiB 控制帧与完整 context/回执可能更大的边界；可以用完整有界文件及 SHA 引用，不能截断后返回成功。由 Harness 持原 Session 锁调用检查，并在真正关闭的同一把锁内核对存证指纹；prepared/released 重试复用原存证，不能读新 Task 状态重建旧结果。之后接实际执行 profile、运行前基线、join/效果核对、不可变关闭声明、已完成的 Store 三项匹配和持久重试预算，再跑实际 Chrome 停止后原 Session 新消息。其他设备/委托/安装任务继续保留，服务器限制不变。
