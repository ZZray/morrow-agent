# Reach 共享 Task 关闭链路独立复核

作者：Ray Zhang（Ray）。日期：2026-11-03。复核执行者：独立 Codex 子代理 `/root/reach_plan_review`；沿用 `ara-git-review`、`ara-rust-core-review` 的只读源码及原件复核方法。

**结论：本地点的共享 Harness → JSONL → Node SDK 关闭链路通过限定范围复核，没有剩余已确认缺陷。** 已有当前源码的关闭/恢复测试及普通 Windows sidecar 实际执行证据。Reach Desk 的 HTTP、数据库和页面尚未接入此能力，不能据此声称停止后页面续聊已完成，也不关闭 X02 或首版验收项。

本代理没有运行 Cargo、模型或测试，没有访问服务器、部署、安装、提交或推送。执行由主代理完成；本代理独立读取源码、日志和保留原件，重算摘要并检查测试断言。当前用户要求仅本地开发和测试，远端操作继续暂停。

## 固定对象与覆盖

仓库为 `E:/repos/ara`，分支 `dev`，HEAD `90f2b1cdd138129e2d331d89a37d70852e849739` 加既有工作区。以下 work 路径均相对 `apps/reach/`。

[r8 源输入清单](../../work/desk-close-source-inputs-r8.json) 的 SHA256 为 `190021793ee027d71b8c739ef0929d448c186cf0c76a4258d6bb4947d43282e0`；sourceIdentity 为 `ad376ab5303c1f4f99bdae72586ce716f0dfc1ee9087f76d494b22125fbc00ef`。快照为 `work/desk-close-source-b1e75466-2295-4c2e-9154-b7df13201b7c`。本代理独立重算 sourceIdentity，并核对当前来源 127/127、快照 127/127 的字节数和 SHA256，合计 254 项一致。

| 核心对象 | 本次复核的 SHA256 |
|---|---|
| Harness `src/close.rs` | `d0d829746f8ec355b98ef022bcdf97b487ea70e26aa6c1ef85c6305ee03742d4` |
| JSONL `src/close.rs` | `0859ebb5c55de6aca0dc99553e86a546512ba42274338cab7af7cf4817bec534` |
| Node `clients/node/close.mjs` | `70f17b75a2c1b9c95cf70cc13cfc4e3a1dc3281264aaccfdf4d35b556f817b17` |
| 普通 `ara-agent-lite-jsonl.exe` | `8888878cf51bafb40b28c33e9c2662fd9e072f11e72f4b4c693b3af969244bb0` |

普通 EXE 为 23,147,520 bytes，位置为 `E:/usr/var/cache/rust-target/reach-static/x86_64-pc-windows-msvc/debug/ara-agent-lite-jsonl.exe`。本代理实际读取该文件，其摘要与原生探针和 Host 结算原件中的摘要一致。构建日志为 [JSONL build r1](../../work/desk-close-jsonl-build-r1.log)，完成时间 11.77 秒。

- reviewed：Harness `src/close.rs`，`src/{lib,storage,runner}.rs` 的相关变更和 `tests/resume.rs` 的关闭、恢复及 fixture 改动；JSONL `src/close.rs`、`src/lib.rs` 首帧分流；Node `close.mjs`、`client.mjs` 的导出及引用读取路径、`close.test.mjs`、`client.test.mjs` 的断连修补、`native-close-probe.mjs`。按需追踪 Core 的 interrupted Run、Journal 提交与 checkpoint 路径。
- evidence-reviewed：r8 关闭测试、旧全目标矩阵、当前 Clippy/JSONL/Node 日志、原生探针脚本、实际声明及 Host 证据、三段提交摘要、原 Task 文件、两条模型请求、原/新 Task 结果与当前 Session/fence。
- identity-only / scope-excluded：其余清单文件仅核摘要或相关调用段，不代表完整审计 127 个文件。未审计全部 Core/Provider、旧 Go 平台、全部 Reach、安装器或线上系统。

## 测试结果与来源桥接

执行环境记录为 Rust 1.98.1、`x86_64-pc-windows-msvc`、静态 CRT；Cargo 缓存为 `E:/usr/var/cache/rust-target/reach-static`。所有模型响应均来自受控 loopback HTTP 服务。

| 证据 | 独立核对结果 | 证明边界 |
|---|---|---|
| [Harness resume r8](../../work/desk-close-resume-r8.log) | 17/17，0 failed、0 ignored，83.26 秒 | 当前源码；10 个关闭用例和 7 个既有 resume 回归 |
| [Harness 全目标 r2](../../work/desk-close-all-targets-r2.log) | 78/78，0 failed、0 ignored；属性组完整结束 | 较早来源，不能称为最终源码全量重跑 |
| [当前库/测试 Clippy](../../work/desk-close-clippy-scoped-r8.log) | 完成，无报错 | 不包含已知失败的无关示例范围 |
| [JSONL Clippy](../../work/desk-close-jsonl-clippy-r1.log)、[JSONL tests](../../work/desk-close-jsonl-tests-r1.log) | all-targets/all-features Clippy 完成；12/12，3.20 秒 | JSONL 包内测试，不单独替代实际关闭探针 |
| [Node start/resume 回归](../../work/desk-close-node-regression-r2.log) | 14/14，0 cancelled，13.4603677 秒 | 既有客户端路径回归 |
| [Node close 协议夹具](../../work/desk-close-node-sdk-fixture-r1.log) | 6/6，5.1333831 秒 | 独立 fixture 子进程；不是 Rust/Core Task 执行 |
| [实际 sidecar + SDK](../../work/desk-close-native-r1.log) | 探针完成，七个场景的断言通过 | 普通 Windows、无外部工具回调的受控关闭路径，详见下节 |

本代理独立比较 r6 与 r8 清单的共同来源，变化仅为 Harness 的 `README.md`、`src/close.rs`、`tests/resume.rs`，与 [来源比较记录](../../work/desk-close-source-comparison.json) 一致。旧矩阵中的 16 个 resume 函数由当前 17 个结果替换，其余 62 个函数的测试来源及原有运行路径未变；它们没有调用新关闭入口。本次证据合并为 **79 个不同函数：17 个当前执行，62 个旧来源桥接**，不是 79 个都在最终版本重跑。当前关闭实现另有当前 Clippy、JSONL 构建和实际 sidecar 探针。

两包 fmt 日志为空，主代理记录退出成功；本代理没有重跑格式命令。[Harness doc-test](../../work/desk-close-doc-harness.log) 和 [JSONL doc-test](../../work/desk-close-doc-jsonl.log) 均为 0 个测试，不能计作新增行为覆盖。[Harness 离线 deny](../../work/desk-close-deny-offline-r2.log) 和 [JSONL 离线 deny](../../work/desk-close-jsonl-deny-offline.log) 均显示 advisories、bans、licenses、sources 四项通过，保留重复依赖及未遇到许可的警告；使用现有离线缓存，未刷新数据库，不宣称安全公告数据最新。

早期失败没有被后续结果覆盖删除：旧 crash fixture 未等实际 advisory lock 释放、过短原 deadline、重复 native call ID、测试编译错误，以及 Node 固定 60 ms 断连竞争均有原日志。Node 修补现在等待 callback 安装能够识别已取消信号的等待器并写 entered 标记后再断连；原 5 秒超时、unknown 结果、回调 join、只执行一次、收据保留和 Token 不泄漏断言未放宽。它覆盖进行中的回调遇断连，不能称作额外验证了回调开始前的所有断连状态。完整 Harness Clippy 仍保留 [r1 失败](../../work/desk-close-clippy-r1.log)：未改示例 `examples/capability/process.rs:28` 触发 `chunks_exact_to_as_chunks`，不能把 scoped pass 写成全目标 Clippy 全绿。

## 真实 sidecar 原件

实际原件目录为 [desk-close-jsonl-b49a3820-e122-473e-8c6e-15e6402cdd25](../../work/desk-close-jsonl-b49a3820-e122-473e-8c6e-15e6402cdd25/probe-result.json)。脚本为冻结清单中的 `crates/ara-agent-lite-jsonl/clients/node/native-close-probe.mjs`，SHA256 `8e7877a9517fd4e724c7ff4cd916e772f825b15fe9f734529180179242266441`。

第一 Task 通过真正的普通 sidecar、Lite Harness/Core 和 loopback 模型生成 `First actual native answer.`；Host 初次 review 明确返回 Unknown，留下 `ReconciliationRequired` 和原 fence。原进程 exit 0、callbacks_finished 为 true，原生 pending 和 Goal 均为空。Host 随后核对进程、事件、工具调用和回答原件，保存独立 Settled 声明。原 Unknown review 和 Task outcome 没有被改成成功。

| 实际场景 | 核对的行为与原件 |
|---|---|
| 错误消费量 | 原生关闭进程 stderr 为 `task_closure_rejected`，stdout 为空；脚本直接核原 fence 字节未变，无 index/marker/prepared |
| 错误调用 ID | 声明通过 JSON 和 settlement 解析，进入共享关闭预检后返回 `task_closure_rejected` |
| 回执引用无关文件 | 返回 `close_evidence_rejected`；原 fence 与关闭状态未变 |
| 释放回执发布失败 | 通过真实 `released.staged` 目录冲突阻止发布，已经越过原 fence 删除；committed 存在，closing marker 保留，SDK 记录 unknown。PID 9684，exit 2，无强杀 |
| 相同声明恢复 | 移除测试刻意建立的 staging 目录冲突后，用原声明和新进程恢复；PID 23404，exit 0，SDK validated，消费仍为 1 Run / 1 call，原 stop 保持 `ReconciliationRequired` |
| 原 Session 下一 Task | 第二 Task 得到 `Second answer in the original Session.`；第二条模型请求确实含第一条回答，使用同一原生 Session |
| 旧关闭重复请求 | PID 25136，exit 0，返回与恢复时完全相同的关闭结果；第二 Task 的新 fence 字节不变 |

原声明字节 SHA256 为 `a9c613b873220e529da0da17e65c3bbb50fe420dddc432f119b5a900af46357c`。本代理独立核对由它派生的 closure ID、完整 request、prepared.review/receipt、request/prepared/committed/released 的摘要关联、10 个原 Task 文件摘要和 Host evidence ref。恢复及重复调用结果与原 released 完全一致。当前 fence 归属于第二 Task `5eb93648-7ad3-4102-8f5a-5e66de0f33a4`，Journal 保留两个不同的已完成 Run。

保留的模型请求恰为两条；第二条包含第一回答，Host 原件中的外部 tool callback 计数为 0。关闭进程通过环境白名单启动，不传 `ARA_AGENT_MODEL_TOKEN`；Rust 在 Start、Token 和 MCP 准备之前分流。这里没有真实远端模型、设备操作或未知外部效果结算。发布失败后的进程正常退出和另一 PID 恢复是实际执行；它不是 SIGKILL、整机掉电或 Linux 文件系统故障测试。

## Bun 运行时补验

主代理补跑同一冻结的 `native-close-probe.mjs`，使用 Bun 1.4.3 和上述 SHA256 为 `8888878c…` 的普通 sidecar。[运行时记录](../../work/desk-close-js-runtimes.log) 分别记录 Node v24.21.0、Bun 1.4.3；[Bun 执行日志](../../work/desk-close-native-bun-r1.log) 显示探针完成。原件位于 [desk-close-jsonl-3ccbec9e-cdd4-477d-b1f7-ec86d01a49ef](../../work/desk-close-jsonl-3ccbec9e-cdd4-477d-b1f7-ec86d01a49ef/probe-result.json)。本代理没有重跑 Bun；独立核对这批原件，确认与 Node 探针相同的七个场景成立。

错误消费量、错误调用 ID 的 stderr 均为 `task_closure_rejected`，无关回执引用为 `close_evidence_rejected`，三个负例 stdout 均为空。脚本保留原 fence、无关闭 index/marker/prepared 的断言未变。真实发布冲突后的 SDK 结果为 unknown，PID 14140、exit 2；同声明恢复为 validated，PID 11644、exit 0；第二 Task 创建后再次关闭旧 Task 仍为 validated，PID 14168、exit 0，三个进程均未强杀。

本代理重算 Bun 原声明字节 SHA256 `46f782a2921412e2e54ebf81c3c63dc5d7347f60dc32a72c3f6ba02cf1c185d9`，核对派生 closure ID、完整 request/review/receipt、request/prepared/committed/released 摘要链、10 个原 Task 文件及 Host evidence ref。恢复和重复结果完全一致；当前 fence 属于第二 Task `ce4e16ea-54aa-418a-975f-ef8fe627ad58`，原生 Journal 保留两个完成 Run 且无 pending。

这批模型请求也恰为两条，第二条包含 `First actual native answer.`；原/新 Task 各 1 call、各 8 条事件，均无 tool_start，外部工具回调为 0。旧 Task 的 `ReconciliationRequired`、1 Run / 1 call 和 `task_accepted=false` 保留。关闭仍走不传模型 Token 的环境白名单。再次核对 127 项当前来源和 sidecar 摘要均无漂移。

该补验增加 Bun 执行共享 SDK 和真实 sidecar 的证据，不改变前述 17 项当前测试与 62 项来源桥接的计数；也不代表 Reach Desk HTTP、数据库或 UI 已接入、用户链路已验收。

## 修复核对与未覆盖项

本轮发现并复核修复的主要问题包括：消耗过的 Task 丢失原生证明仍可能释放；重复 released 结果校验不完整；重试目录同步顺序遗漏；无 Tokio runtime 时先写 marker 再 panic；不可变声明的过期依据或错误调用列表在 marker 后才拒绝；关闭目录误用 resume 前驱目录；回执与实际 refs 没有关联；SDK 管道错误未捕获，以及嵌套同名 released 文件被接受。最终相关拒绝位于适当的发布之前，prepared/released 重试核原 review，不读取后来 Task 的 Journal/fence 来重建旧结果。

仍有以下明确边界：

- 当前原生 JSONL 探针走已经闭合的 Run；pending 调用结算、真正取消、跨 resume 累计消耗、缺失原件和 checkpoint 发布失败由当前 Harness 17 组证明，不能说这些分支全部经过 JSONL/Node 原生探针。
- Windows 目录同步 helper 为 no-op；Unix 目录同步顺序只作源码复核，没有 Linux 掉电实测。Core 在 head 提交前留下未确认尾部时仍拒绝恢复；本点不截断日志、不删除 pending。
- Host 仍负责认证、原 Task 所有权及效果证据真实性。哈希证明内容身份，不证明业务效果。只读预检不能启动效果，结算回调必须幂等并在取消时 join；调用方必须保持关闭 future 存活直到完成。
- Node 的管道 error 分支已静态复核；本次六组协议夹具没有逐一注入所有 OS 管道错误、spawn 失败和强制超时。协议夹具不能代替真实 Core 状态转换。
- Reach Desk 的 HTTP/数据库解锁、用户身份链和停止后页面续聊尚未接入；真实模型多轮、设备/Node 工具、SCM/SYSTEM/UAC 安装、Ray 长流及部署均未验收。基础清单 0/52、Desk 选装 0/5 的完整验收状态不由本报告改变。

本报告仅接受上述本地共享关闭实现点及明确列出的证据，不将源码存在、旧来源桥接或受控成功扩展为完整 Reach Desk 交付。
