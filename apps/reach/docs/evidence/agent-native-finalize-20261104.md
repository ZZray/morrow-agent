# 原生 Released 后的只读收尾：本地执行记录

作者：Ray Zhang（Ray）。日期：2026-11-04。

本点实现 `agent.finalize`：原 Task 已写出 Released，但 Node 未保存最终结果时，沿原 Task/Session 核清原件并提交新的服务执行结果。不创建原生 Task、Run、模型请求或工具调用，不接受业务 Task。只在本机运行；服务器、SSH、远端模型、安装、部署及 Git 同步/提交/推送均未执行。完整 R06、基础 **0/52**、Desk **0/5** 不变。

当前状态：候选实现已冻结，主代理原件回读、针对性本地回归及源码/已执行边界的独立复核通过。共享 JSONL 依赖审计未通过，发布门保持开放，`deliveryAccepted=false`，不声明完整交付。

## 代码与证明边界

服务 schema10 为 finalizer 建立独立 execution/generation，始终没有模型、工具、Run 注册或原生恢复准入权限。可超过原 deadline 做只读收尾，但不延长 deadline、不退款或扩大 cap。source 指向最后实际原生 owner；其后只允许没有新增权威或效果的失败执行。取消、当前代、配对、效果摘要与最终事件、计费、完成记录、pending 清除仍在服务事务中核验。

Windows Node 在发送 start_task 前创建唯一命名 Job，将原 Host/sidecar PID、无损 creation FILETIME、boot ID、镜像和 Job 名持久保存并 ACK 到服务。恢复核同 boot、原进程已退出和 Job 无存活子孙。权限错误不当作退出。正常 join 与 `recovered_process_exit` 分开；后者不补造 terminal.json、task_result 或 local_callbacks_finished。旧匿名 Job 或缺 owner 的记录拒绝收尾。Unix 不声明此能力。

原生 inspector 清空组织凭据，持原 Session 锁输出完整快照，并保持有界 lease。Node 核原 Head 原始字段序摘要、range proof、review、消费链、完整模型/child/outbox 和原件。随后保存 prepared result，请 inspector 在原 guard 内产生不可变 seal：暂存文件完整同步后，以 create-new hard link 发布固定 seal.json。seal 绑定 request、lease、snapshot 和最终 commitment。准确重复返回同一回执，改 commitment 拒绝。完整 seal 已发布后，检查进程退出或输出 ACK 丢失不撤销该封存资格；服务仍须核本代和效果集合。Node 自写的 prepared-result.json 不构成持锁证明。

最终结果包含原 commitmentJson 与 hash，服务解析后对比准确的本代、source、state、result；仅排除 inspectionSeal 避免自引用。已经存入 outbox 的原终态精确补传，不因 ACK 丢失追加 unknown。Node 在 outbox 前也崩溃时，原执行仍可记 unknown，由后继只读代重新核验；旧 seal 不跨代授权。

resume source 的 admission 中保存了历史 fence 引用，而正常原生释放会删除该 fence。Node 将完整 admission（含实际发送的 dispatch/hash）与服务 runOrigins.admission_json 对比，核准确的原 Session fence 已不存在后，才排除这一历史引用；其余引用仍须逐一存在且 hash 匹配。不修改或重建原 fence。

`agent.inspect` 继续返回 `unlocked_readonly/nativeAuthorityVerified:false/taskAccepted:false`。NoFence 时新增 sourceExecutionId/releasedSha256 候选，不输出本地路径或凭据。原 source 镜像与升级后的 inspector 分别核验，resumeRuntimeMatches 明确报告是否可按原镜像续跑；候选不是收尾授权。

## 冻结身份

- 仓库 `E:/repos/ara`，分支 dev，HEAD `90f2b1cdd138129e2d331d89a37d70852e849739` 加原有 WIP。
- `work/agent-native-finalize-20261104/inputs-r15.json`，SHA `4b490192ce87ef587560b95340d2e67a8692a161f91fad9933716c8d5a079364`；228 份源码/输入及 source-r15 副本。与上点摘要的 60 项差异包括本次首次覆盖的历史依赖，不能说成 60 个新增实现。
- Node `runtime-r13/reach.exe`，SHA `af970efed24a1e71135a3e2fb3c8580cfee76e78973b7f963ec5f01d846dd3d6`；与实测 r11 镜像相同。
- inspector `runtime-r13/ara-agent-lite-jsonl.exe`，SHA `d7b4182d74bea47fdf210c54952fe1c33f24cd0379c107636c00035fa9f71439`；与 r11 相同。
- gen1 源侧车使用前点冻结 c5b47fea…；新 inspector 不能替代其 source authority。安装包尚未更新。

## 已执行的关键场景

所有模型 HTTP 都是受控 loopback SSE，只证明协议和执行路径，不证明组织模型推理。

| 场景 | 结果与原件 |
|---|---|
| gen1 真实 Released、Node terminal/process-settled 保存前硬杀 | 原命令效果仅一次；新 finalizer 完成；原 Session/evidence/task.json hash 不变，模型/child/Run 不增加，服务重启后完成状态仍在 |
| 错误 released SHA 后重试 | 第一次 unknown、pending 保留；后继只读代沿同 source 成功，无重放 |
| inspector 在 final snapshot 返回前被杀 | 用记录的 PID/creation 定位实际进程；不能封存，pending 保留；后继只读代成功 |
| 服务已提交、最终 ACK 返回 503，再杀 Node | 重启补传原 eventId/sequence/data；本地原 outbox 不变，服务仅一个终态 |
| seal/outbox 已保存，但原事件未上传时取消或解绑 | 截住原事件后操作，再杀 Node；重启能准确补传，仅一个 finish，取消标志及解绑状态保留，新检查与效果入口仍拒绝 |
| 解绑后试图通用对账覆盖 finalizer | succeeded、failed、not_executed 全拒绝；没有独立对账记录，准确原封存事件仍可结算；普通操作的历史收据对账回归不变 |
| 实际原生 BudgetExhausted | failed/未完成、last_candidate=null、taskAccepted=false；核清后可完成生命周期，不变成成功候选 |
| 实际 resume gen2 Released 后硬杀，再经过无效果失败 gen3 | gen4 只读收尾仍指向 gen2 source；累计两 Run、三次逻辑调用，原效果一次 |
| 原模型请求真实中断，精确 stop receipt 后 resume，再收尾 | 历史模型保持 unknown；仅沿 source 的准确 resume receipt 解释，不豁免其他 stop；累计消费不退款，模型请求仍为原两次 |
| 普通 native resume 回归 | 同 Task/Session 正常续跑及最终释放通过 |
| 持锁 inspector 协议 | 13 个场景、10 个实际进程：旧形状、预读错误 release、错误 snapshot、锁竞争、错误/重复/变更 seal、超时、EOF、硬杀、发布后 stdout ACK 丢失及重取锁 |
| 实际 schema9 数据副本升级 | 两组前点已验收数据库的副本升级至10；原 operations/events、Run、review、模型 owner、消费、receipt/finish 全表不变；10重开通过，旧9关闭锁后明确拒绝；源数据库字节不变 |

原件目录由对应日志逐项给出，均保留在 work/。最终 gen1 五组和普通 resume 的成功记录在 `native-final-r10.log`；该次命令本身为 **6 pass/2 fail**。修复仅影响 gen2 历史 admission 对比后的两组在 `native-resume-finalize-r11.log` **2/2** 通过。八个不同场景具有成功证据，不能把两个命令合称一次 8/8 全绿。R10→R11 的四行修补限定于 resume admission 的 dispatch/hash 比对，gen1 不含该记录。

最后的服务改动只影响原封存结果的提交仲裁与 finalizer 对账门禁，Rust/JSONL 镜像不变。`native-sealed-r13.log` 的取消/解绑两组通过；收紧通用对账后的实际解绑重启场景在 `native-unpair-r15.log` 再通过。九种不同 NoFence 场景和一组普通 resume 均有本地成功证据，不能说成一次十项全绿。

已完成检查：Reach Rust15/15、JSONL Rust16/16、旧无hold SDK7/7、真实非空Session旧inspection/close probe、Reach类型检查及两个独立workspace fmt/clippy通过。最终 `service-settlement-r15.log` 为19/19，其中finalizer9组、普通服务10组；实际旧库迁移另有2/2。较早的广批 `service-final-r11.log` 为91pass/1fail/6skip，6项依赖显式提供旧Store的环境变量，未提供则skip，不计通过。唯一失败是响应大小负例的随机token首字母恰为x，连续x正文使保密前缀缓存先达上限；现为大小测试固定无歧义前缀，保留原大小断言，`bounds-r12.log` 该函数（含frame/response两case）通过，未修改broker。

Reach本包 `cargo deny --offline check` 通过，带既有重复依赖和未用license allowance警告。额外以仓库根Full policy检查共享JSONL，`deny-jsonl-r14.log` exit14：三处固定rpi git来源不在allow中、webpki-roots1.0.10的CDLA-Permissive-2.0未在该policy许可例外内，以及core/harness/jsonl的path wildcard依赖被拒；advisories通过，bans/licenses/sources失败。本点未改这些lock、依赖声明或policy，也未扩大豁免。共享运行库的依赖发布门仍开放，不能称全部审计通过。首次命令把--config放在check后导致参数错误的日志另行保留。

主代理运行 `work/agent-native-finalize-20261104/primary-readback.mjs`，逐一核228份当前源码及副本、3个镜像、9种NoFence原件、255条本地outbox与服务原事件/ACK、110次文件引用摘要、原Session/evidence、seal/prepared/最终结果及单次效果。`checked-primary-r15.json` SHA `a3d5e6bb8e115a483e907aad6be52fd1b7913246013bc9daf725b0d70dab3a2e`。这是直接回读，不是重新执行全部历史场景。

## 失败记录与未覆盖项

早期 Released 观测后立即读取 Windows 锁文件遇到 EBUSY，改为有界观测重试，没有重放任务；早期子孙测试发现 Job ActiveProcesses=0 与进程 signaled 可有短暂间隔，现同时等待真实退出。原失败日志保留。

`native-finalize-r3.log` 为3/4、r4为4/5；inspector_killed 的失败均在故障注入之前，原审阅等待20秒短于工具30秒上限。现在等待45秒并保留 source-host-logs，r5及r10该场景通过。服务 seal 接线后，预算负例第一次先被 seal/state 不匹配拦下；已为该负例构造准确的错误 state seal，重新验证 BudgetExhausted 即使持准确 seal 也不能报成功。

实际 resume finalization 的首批2/2失败于已删除的历史 fence；下一批又因本地保存输入不含 API 添加的 dispatch/hash 而拒绝。两次均保留 pending，没有新效果；r11校正实际发送输入的完整比对后2/2通过。失败和修复日志分别保留，不删除旧现场。

独立复核另外复现三条同一类卡死入口：封存后取消、封存后解绑、解绑后用通用failed对账覆盖原事件。修复限定于已封存准确终态的收据提交：允许同epoch原uncertain/已撤销凭据结算，保留current/generation及所有原件核验，不恢复Node权限；finalizer完全拒绝通用对账。实际Node重启和服务负例已通过。新增解绑服务测试第一次误预期HTTP401，实际是准确的409/agent_finalizer_inactive；修正为核具体拒绝码后，未更改生产行为即通过。

本点未完整实测 NeedsChanges 的独立终态、所有进程访问失败/跨 boot、seal 发布边界的全部主进程崩溃排列、开放 typed 图片恢复、多次原生崩溃及完整 R06。已测试的检查进程中断点位于封存前；发布后 ACK 丢失的协议场景与 Node 最终事件 ACK 丢失分开记录。真实组织模型、Windows UAC/SCM 安装、更新/卸载和部署继续开放。

独立设计报告是 `work/agent-finalize-design-review-20261104.md`，结论仅 CONDITIONAL_DESIGN_APPROVAL；最终实现审阅不能用它代替。用户要求先本地测试，未访问服务器。

## 独立最终复核与交接

最终[独立报告](../../work/agent-native-finalize-independent-review-r15-20261104.md)已回读，SHA `0de7500d90a92aa7c57122ae1846af90a418a249e2b57f1ff0b8343800d75b2d`；同名JSON SHA `956b272889dd4e5db2c9d08e00d4751cc2aed71a590ba4b9ec55dcab564e0cbd`。复核者为Codex `/root/reach_plan_review`，结论为 `LOCAL_SOURCE_AND_EXECUTED_SCOPE_REVIEWED__DELIVERY_ACCEPTANCE_OPEN`。

取消、解绑、通用对账覆盖原封存事件的三个P1入口均关闭，没有剩余本点已确认产品缺陷。独立复核核12个运行根（9个不同场景，含复测）、339条原事件、426次引用检查（403唯一），另执行两组实际HTTP/SQLite仲裁探针；其seal为synthetic，与普通Node原生测试分开。独立统计与主代理9根/255事件/110次引用不相加。

复核记录20项语义与调用链、5项行为测试、9项schema断言及fixture差异；另26项是manifest首次纳入的历史依赖，只核身份，不声明全文件语义覆盖。主代理回读完整报告、最终输入摘要与关键原件；九份活动/证据/协议文档181个链接检查通过、57个任务ID唯一、零勾选、无行尾空白。humanizer未提供，文字由主代理人工审读。测试句柄均已终态；旧失败、迁移源库和前点封存保持原样。下一步是依赖发布门、完整恢复矩阵及安装验收，远端继续暂停。
