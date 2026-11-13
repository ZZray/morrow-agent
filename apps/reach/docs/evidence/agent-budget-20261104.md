# 固定单 Run 上限与闭合预算续接：本地证据

作者：Ray Zhang（Ray）。日期：2026-11-04。范围：R01/R03/R06 的 runCallLimit、原生闭合预算复核/prepare、图片证明及持久语义升级。只在本机开发测试；没有 Ray 服务器/SSH/远端模型访问、部署、安装、提交或推送。完整基础仍 0/52、Desk 仍 0/5，原 Task 崩溃恢复没有完成。

本文固定schema5预算点的证据；后续[保守消费内部账本](agent-consumption-20261104.md)升级schema6，尚未接显式原Task恢复。最新接续见[本地交接](../handoffs/2026-11-04-agent-consumption-local.md)。

## 行为与实现

委托可选 `runCallLimit`，必须不超过 Task 的 `maxCalls`；省略时保留原行为。服务在同一事务分别限制 Task 总预占数与 Run 预占数，所有已预占状态均计数，不退款。Node 固定首次 Run cap、Task 总额及原截止时间，显式 cap 时使用 Harness 的 `review_closed_tool_round`。

闭合工具轮次耗尽模型额度时，复核对象为原生 `BudgetStopSnapshot`，携带 `native_round_closed:true`、`model_final_stop:false`，没有伪造普通 Candidate。API 严格接受 candidate/snapshot 二选一；public review 的 `subjectKind` 分别为 `candidate` 或 `closed_budget`。原 CLI/MCP 的 continue/return_result 仍绑定准确 basis，返回仍 taskAccepted:false。

Node 接通 `verify_budget_request`/`prepare_budget_request`，复用原 Session、relay、累计预算和绝对 deadline；等待决定后及 prepare 前重核原 snapshot、事件、模型收据和图片。预算终态必须核 `budget_review_ref → index → snapshot/receipt`，`last_candidate=null`。单 Run cap 已结算但目标未完成时为 failed/BudgetExhausted/Released；等待时取消或原件变化则 unknown/Present，保留原效果，不重放。

共享 JSONL 的图片证明接入 ReviewBasis，在原 Harness Session 锁内生成可选 `tool_images_ref`。Node SDK 向预算回调传入 frame；Python 目前仅容忍字段，未自动传递或校验预算图片 proof，不宣称两种 SDK 对等。没有复制 Agent 循环或修改 shared Core 业务循环。

数据库列虽未增加，`agent_run_reviews.candidate_json` 现在保存两类原生 subject，持久语义因此升级 **schema 5**。旧 schema 4 服务须拒绝新库；新服务拒绝未来 v6。迁移不能改写旧 operation/dispatch/events/models/review。合同以[现场委托](../agent-delegation.md)和实际 schema 为准。

## 固定版本与分层执行

仓库 `E:/repos/ara`、dev、HEAD `90f2b1cdd138129e2d331d89a37d70852e849739` 加原 WIP。最终快照 `work/agent-budget-20261104/inputs-r3.json` SHA `b332c4ebacc0d42eebcf0110bb7e9641b852cd7f3a64f4e4f40457e91a8601d2`：175 源/副本、19 个语义增量目标、4 个 runtime。175 是身份覆盖，不是 175 项新语义审查。

| 冻结 | 用途与摘要 |
|---|---|
| inputs-r1.json | schema4 下四个预算函数及两组预算截图、默认多 Run 回归；SHA `0a96ded117312e8ab341e031a8ca8fbe52dfc886c7c826f9acc1aa09e457b33d` |
| inputs-r2.json | schema5 guard、迁移及两组 v5 原生 smoke；SHA `ea7e64f43d3e554226993464e4491a4a152cd7a28bf3805ff68c914bda601070` |
| inputs-r3.json | 只拆分历史服务测试入口；产品及 runtime 与 R2 相同 |

实际 Node `work/agent-budget-20261104/runtime-r1/reach.exe` SHA `65e2f635ffb5152a9a0ee9c5203fa626c38b8658f7b652a7f785ee34ba029f0e`，同目录侧车 `ara-agent-lite-jsonl.exe` SHA `c5b47fea1ab97745d93f7918b8c6ec2f6e246cc122201a25fab2e76a4ee5101f`。desktop/Python 沿用[跨 Run 实图](agent-cross-run-images-20261104.md)固定物。Node 使用静态 CRT，侧车 RUSTFLAGS 为空；复用既有 target 缓存，单 job、离线 locked、未并发 Cargo。依赖/lock 未变，沿用既有离线 deny，不称为本轮在线审计。

R1 六个主场景是实际 schema4 原件；后续 v5 smoke 与服务迁移形成分层验证，没有把旧执行补称为 schema5 全矩阵。每根原 started-inputs 匹配其当时冻结源及运行物，未事后补造启动清单。

## 测试入口与结果

以下入口从 `apps/reach/` 执行，运行物通过 `REACH_NODE_BINARY`、`REACH_DESK_SIDECAR` 配置；桌面测试另需 `REACH_DESKTOP_BIN`、`REACH_DESKTOP_PYTHON`。记录以各版原日志为准，当前测试源已包含后来新增的取消函数。

```powershell
node --test --test-concurrency=1 tests/agent-budget.integration.test.ts
node --test --test-concurrency=1 --test-name-pattern='return_result from a closed-budget|cancelling a pending closed-budget' tests/agent-budget.integration.test.ts
node --test --test-concurrency=1 --test-name-pattern='a closed budget screenshot|a 32768 closed budget' tests/agent-desktop.integration.test.ts
node --test --test-concurrency=1 --test-name-pattern='caller feedback continues' tests/agent-multirun.integration.test.ts
node --test --test-concurrency=1 tests/agent-budget.test.ts
bun run check
```

历史旧服务探针默认 skip，需要显式 `REACH_PREVIOUS_SERVICE_MODULE`，必须是绝对路径且文件 SHA 为 `ffce8452517461eec645f8559984b383616cde2e50405736c5135a64328223f9`。本机最终服务执行显式提供 `work/agent-cross-run-images-20261104/source-r1/apps/reach/src/service/store.ts` 的绝对路径，**4/4、零 skip**。一般 v4→v5 测试不依赖该历史模块；不声称忽略目录的历史制品已随干净仓库提供。

| 原日志（相对 work/） | 实际结果 |
|---|---|
| agent-budget-r1.log | 4/4，63.337 秒；首次 cap、两次 budget prepare、return_result、单 Run 已知未完成及原件篡改 |
| agent-budget-v5-r2.log | 2/2，28.110 秒；v5 return_result 重测与新增等待取消，预算函数共五个不同函数 |
| agent-budget-images-r2.log | 2/2，65.163 秒；131072/32768 实际截图 |
| agent-budget-default-regression-r1.log | 1/1，52.019 秒；新镜像无显式 cap 的原 CLI/MCP 多 Run |
| agent-budget-service-r1.log / agent-budget-service-regression-r1.log | 2/2，7.038 秒；6/6，43.342 秒，含原 Task 总额及已发布 Run 封存 |
| agent-budget-service-r2.log / agent-budget-migrations-r2.log | 3/3，7.397 秒；v1/v2/事务/future6 四项 4/4，13.467 秒 |
| agent-budget-service-r3.log | 4/4，8.428 秒；实际旧服务探针显式启用 |
| agent-budget-sdk-images-r1.log | 实际 Node SDK + 新侧车预算回调 1/1，6.297 秒；1×1 生成 PNG，非截图或视觉理解 |
| agent-budget-sdk-regression-r1.log / r2.log | 首批 11 pass / 1 timeout-cancelled；唯一取消函数保持原 8 秒 timeout 独跑通过，3.328 秒；不是一次全批 12/12 |
| agent-budget-node-tests-r1.log / agent-budget-sidecar-tests-r1.log | Rust Node 10/10，执行 4.67 秒；JSONL 16/16，执行 10.72 秒；main/example/doc 零案例不算覆盖 |
| agent-budget-node-fmt/clippy-r1.log、agent-budget-sidecar-fmt/clippy-r1.log、agent-budget-typecheck-r3.log | 对应 fmt、Clippy、基础/admin 类型检查通过；完整文件名见最终清单 |

Rust 入口分别在 Reach 和 JSONL 独立 workspace 使用 `cargo build/test/clippy --target x86_64-pc-windows-msvc --locked --offline`，test/clippy 含 `--all-targets --all-features`，Clippy 含 `-- -D warnings`；fmt 为 `cargo fmt --all -- --check`。SDK 入口从父仓运行 `node --test crates/ara-agent-lite-jsonl/clients/node/budget-images.integration.test.mjs`，设 `ARA_AGENT_LITE_JSONL_BINARY` 为固定新侧车、`ARA_AGENT_LITE_EVIDENCE_ROOT` 为绝对本机证据目录。没有重跑无变化矩阵。

## 实际原件与回查

| 原件根（相对 work/） | schema | 结果 |
|---|---:|---|
| agent-budget-7bfa0dd5-8284-4614-be1a-12d001ea9acd | 4 | Task 总5/Run cap1；写 once、读原文件，两次预算 prepare 后第三 Run 普通候选；3模型/2child |
| agent-budget-521d5ca0-fd33-4a31-b06c-92014f8c2df7 | 4 | budget return_result；null Candidate、精确 index、待复核/Released |
| agent-budget-dc5bca87-aaf4-4ee3-bf8f-e3d1663ef01c | 4 | 单 Run cap，文件一次效果；failed/BudgetExhausted/Released，无假恢复 fence |
| agent-budget-50ce5fc4-b143-4947-acf1-83e0bff31fb9 | 4 | 等待时改 snapshot，unknown/Present；原效果保留，无伪造 reply/index |
| agent-desktop-131072-c0e6e131-48da-41fe-963b-3c2a8db18dd1 | 4 | 两窗口/两原 PNG；闭合预算后的下一 Run 消费，4模型/3child |
| agent-desktop-32768-e6b8c0ce-b318-4f52-8f51-c5be94a58e49 | 4 | 较小 context 下同型预算图片路径 |
| agent-budget-cd37d3a9-6572-4a4f-b2f0-34a9608e90c1 | 5 | return_result 重测；原 index、receipt 与预算终态一致 |
| agent-budget-a52427bd-9d29-4c46-9808-db215de565bb | 5 | 等待预算决定时取消，decision=null、unknown/Present；1模型/1child，原效果保留，无 prepare/新 Run |

两组截图都是 Task 总6/Run cap2，每组 provider 图数为 `[0,0,1,2]`。Run 1 两次模型请求执行 describe 和 Screenshot，产生 typed ToolResult/proof；Run 2 第三个模型请求才真正消费图 1，第四个同时消费两图。两 Run 的 proof.calls 分别为2、1，原 656×359 PNG 直接从 native typed ToolResult、outbox 与 provider 输入解码核对，没有把 Run 1 取到图片写成模型已看图。

主代理 `work/agent-budget-20261104/check.mjs` 回查八组原 SQLite、Task cap、全部 outbox/digest/ACK、subject/index、原文件、模型 intent/transport 及实际启动身份：**8 Task / 12 Run / 202 outbox 全 ACK / 16 模型 / 13 child / 8 budget reviews**。结果 `checked-r3.json` SHA `fc7880084b45bfc81428760ee9fd8a01bc0f04d2927cbe886f7b1ee5055cf368`。

独立 `/root/reach_plan_review` 另从原 journal 链、原生 admission、typed ToolResult、PNG 与 provider 字节复算，同意本点有界本地范围，无未关闭确认产品阻断。新镜像默认回归另有 **1 Task / 2 Run / 37 outbox / 4 模型 / 2 child**，不混进上面八组统计；return_result 的两版重测也不重复计为不同功能。原42个PID在独立检查时均不存在，主代理只核退出原件，没有停止进程。

独立报告 `work/agent-budget-independent-review-20261104.md` SHA `eb02e267f095017a5ae9a3e72634244774db6083177714d783f5815fd973368b`。主代理完整回读该报告及跨 Run 图片报告，核22份审计引用摘要和主/独立统计，保存 `review-checked-r3.json` SHA `7f272fe0317baee98a2f05d6b20f2366103900a38ae2074cfb5a7e49cd2e0517`。最终来源、文档及检查绑定到同目录 `checked-final.json`，不包含自引用摘要。

本点八份文档的159条本地链接、19个语义目标空白及根 `git diff --check` 通过。另按知识维护流程运行 `python scripts/verify_bootstrap.py`，退出1、234条文档链接失败，原日志 `work/agent-budget-20261104/bootstrap-r3.log`；涉及全仓临时绝对路径、旧HandWave源路径及归档等，均不在本点八份文档。未修改这些无关历史，也未将全仓文档门禁报告为通过。

## 修补与保留失败

预算图片首批 `agent-budget-images-r1.log` 为 0/2：测试 provider 在第4次请求误进入普通跨 Run 分支，将实际两图断言为一图并断流。只给测试分支增加 `runCallLimit!==2` 后 r2 通过，产品未因此改变；旧测试保存在 `images-test-before-drive-fix.ts`，两根原失败目录及日志保留。

独立复核发现历史服务探针无条件 import 本机忽略目录，干净检出缺依赖。R3 将其与一般迁移测试分开，显式参数、绝对路径和旧 SHA 先验后才启用；本机实际启用的 4/4 已核，未声称做过全新检出全量测试。SDK 首批 8 秒 timeout、错误 cwd 的 freeze 失败也保留，不报一次全绿。

独立复核接续时误执行一次 `git fetch origin`，将远端跟踪 origin/dev 从90f2b1c更新为9a65b79；没有 merge/pull，本地 HEAD、索引及源目标未改变。本点仍固定原 HEAD 加 WIP，不合并远端七个提交。

## 开放范围

原 Task 显式崩溃恢复仍需保守 charge floor、root Task/attempt 归属、模型 unknown 对账、原 relay endpoint/token/工具/镜像及绝对 deadline；不能用服务只见少量模型行数给缺 observation 的 Harness 退款，也不能造 review 绕过 Run 序号。ResumeReceipt 的文本结果不自动证明恢复了 typed 图片。

R04/R05、真实组织模型及视觉结论、旧 Desk 历史、安装 runtime 装配、SCM/SYSTEM/锁屏/切用户、干净机升级卸载、跨物理机器与 Ray 上线各自开放。现有安装候选未更新。humanizer 未安装，本文人工审读。下一步见[本地交接](../handoffs/2026-11-04-agent-budget-local.md)。
