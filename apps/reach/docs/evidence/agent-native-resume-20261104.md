# 原 Task 原生恢复：本地分项

作者：Ray Zhang（Ray）。日期：2026-11-04。

本点接通实际 Node → JSONL → Harness 的 `start_task.resume`，沿原 Task、Session、模型路由、工具、侧车镜像、endpoint/token 和本地绝对 deadline 继续执行。服务 schema9 将恢复回执、Run 注册、原生准入、复核发布和最终释放分别记录。仅本地测试；没有服务器访问、组织模型探测、安装、Git 同步、提交、推送或部署。完整 R06、基础 0/52、Desk 0/5 不变。

## 固定输入

`work/agent-native-resume-20261104/inputs-r6.json` SHA：
`3bfef69159a6e8c3f847a92846ab257f0f85bea42bea5c85eef1487ac49c4c09`。
193 份源文件及副本；Git 为 `dev` / `90f2b1cdd138129e2d331d89a37d70852e849739`，保留原 WIP。

实际运行物在该目录的 `runtime-r5/`：

| 运行物 | SHA256 |
|---|---|
| reach.exe | `2d58319577fc4c2fe57c3fb31fca206e8d23eee643dc61d2f34221a4abf3b464` |
| ara-agent-lite-jsonl.exe | `c5b47fea1ab97745d93f7918b8c6ec2f6e246cc122201a25fab2e76a4ee5101f` |

侧车/Core/Harness 未修改；Node 重新构建为静态 CRT。安装候选未更新。R5 manifest 保留，R6 只改服务迁移 proof 的键序比较和四个测试/夹具文件；Rust 源与镜像相同。R6 happy 新跑包含实际服务重启，其余 R5 行为使用该明确差异桥，不能称全部 R6 新跑。

## 已执行结果

全部日志位于 `work/agent-native-resume-20261104/`：

| 记录 | 结果与边界 |
|---|---|
| build-r5.log | 静态 CRT Node 构建通过，3.17 s |
| clippy-r5.log | all-targets / all-features / `-D warnings` 通过，3.11 s |
| rust-tests-r5.log | 12/12，编译 9.25 s，执行 3.80 s |
| typecheck-r6.log | 基础及管理页类型检查通过 |
| deny-r6.log | 离线 advisories/bans/licenses/sources 通过；重复版本警告保留，不代表发布审计完成 |
| native-r5.log | 16/16，406.680 s：下列十种恢复、只读检查一项及既有闭合预算五项 |
| native-service-restart-r6.log | 1/1，30.765 s：最终 proof 按真实 Rust 键序入账后重启服务，原 Task 的释放状态保持 |
| service-r6-final.log | schema9 服务 10/10，40.785 s；原生文件为 synthetic，不能替代普通 Node 证据 |
| service-cancel-r6.log | 两组通过，20.165 s；包含强制凭据前缀的五种中止及流消歧 |
| service-r4.log | 76 项：69 通过、2 失败、5 个未提供旧版本模块的可选测试跳过；两失败均保留并由上述 R6 记录纠正 |

十种实际恢复：正常接续、恢复后继续反馈、最终 ACK 丢失、恢复后新 child、多份 1 MiB 原结果、错误 fence、原端口占用、reconcile ACK 丢失、admission ACK 丢失、未知模型经准确停止回执结算。每项均运行普通 Node 和固定侧车，模型为受控 loopback SSE，不能当作组织推理或视觉理解验收。

首个非幂等命令先追加文件，服务提交 child 成功后将 ACK 改为 503，再 SIGKILL Node。重启仅补传原 outbox；锁内 Host 核服务与本地原件，回填开放工具文本结果而不调用 execute_child。文件始终一行。正常恢复实际两次模型请求，逻辑消费为三次：原崩溃 Run 缺 observation 扣满原 cap=2，再加新 Run 一次。缺 observation 的扣费不是模型请求数。

reconcile ACK 丢失保留原 fence；下一代复用未准入的 Run UUID/序号。admission ACK 丢失后再强杀，下一代继承新的 resume.json 并扣原已准入 cap，既不退款也不按 attempt 重复叠加。模型 unknown 的原状态、usage 和请求不改，只有被本代 receipt 精确引用的停止项才解释为可继续；本代新 unknown 仍阻挡。

新 child 沿 root Task 的唯一 `agent-bytes:<root>` 桶累计。大结果保留原文件，快照只带摘要、事件集合指纹和计数；原 arguments 按不超过 64 KiB 的窗口读取并核整体 SHA，普通 API 的 2 MiB 限额未扩大。最终快照等待当前模型 owner 实际 joined，再由终态事件同事务核 proof、写释放依据并清 pending。成功仍 `awaiting_review/taskAccepted:false`。

实际服务重启样本：
`work/agent-native-resume-1d113151-fcf2-49d5-a353-e2a8bc007817/`。
R5 全部根路径在日志中，分别保留 provider 请求、原 Session、admission/resume/review/terminal、Node SQLite/outbox、服务 SQLite 及 `asserted-native-resume.json`。`fixture-exit.json` 只记录夹具直接进程，不宣称逐 PID 审计全部工具子孙。

## 保留的失败与修正

- 独立复核发现新 child 原先使用 execution ID 新建输出计数桶，已改为 root Task，并通过实际新 child 检查。
- 独立复核发现两个合法 inline 大结果会撑爆 2 MiB 快照，已改为摘要和窗口，并执行多份 1 MiB 文件读取恢复。
- final-snapshot 可能看见 stream_complete 但运输尚未 joined。现在返回 `ready:false` 等待真实 join，最终事务再核；服务测试显式建立该窗口，不能冒充原生竞态注入。
- 主代理发现 Zod 字段顺序与 Rust 排序字段不同，不能比较序列化后的 proof 字符串；已改为语义摘要，执行排序 proof 及真实服务重启。
- R4 流测试的 `active` 尾字母可能与随机 token 前缀相同，凭据过滤器会等后续字节。测试改为 `active.` 并强制 e 前缀；另测先保留 e、收到句点后实时释放。生产过滤器未改。
- R4 schema8 拒绝测试在当前 Store 未关闭时先遇生命周期锁，未到版本判断；已关闭当前 Store 后检查旧实现拒绝 schema9，原操作与 gen1 注册归属保留。
- 早期 check/clippy 和旧 schema 数字断言的失败日志不覆盖；修后重新执行受影响项。

## 仍开放

原生已 Released、Node 尚未保存最终事件便崩溃时，尚无只读 finalization 路径。当前 NoFence 明确拒绝，保留 pending，不新建 Session、fence 或模型请求。已有终态 outbox 的丢 ACK 重传已经验证，二者不能混为一谈。

开放图片工具缺 typed 恢复合同会拒绝，不能重拍或把图片路径当原图回填。无首 admission、接管到 admission 之间硬杀、待 prepare、多次崩溃、锁/owner/route/epoch/deadline/未知 child 等完整组合矩阵仍未收齐；现有分项不能外推全部 R06。真实组织模型、跨机、SCM/SYSTEM、安装升级、Desk 旧历史及部署仍开放。

独立复核 `/root/reach_plan_review` 已给出 [APPROVE_BOUNDED_R6](../../work/agent-native-resume-independent-review-r6-20261104.md)，SHA `352a2574b1d3ab9d72a781e834564a4a7b69ecebf1ef0fe00c18da3a12216b62`：16 个语义目标及两个测试依赖全部覆盖，无未关闭的已确认缺陷；其余源码只核身份。独立审计还核 16 个服务夹具的实际账本，明确 synthetic 证明与真实运输的范围。

主代理完整回读报告，并另用 `check-final.mjs` 回查 193 源及副本、两个普通镜像和测试镜像、11 个实际恢复根。302 条原 outbox 均 ACK 并与服务原事件一致；25 个实际模型请求、13 个 child、38 次逻辑消费、48 个夹具直接进程退出记录分别核对。`checked-r6.json` SHA `24e0f1652aa08cd4b811a5834ef588c57cd2bcd1fa31b14a123ab2f0491b0f75`，不是只读他人的通过结论。

六活动文档的相对链接与空白检查通过；根 `verify_bootstrap.py` 仍退出1、815条失败，其中含历史及临时快照链接，本点六活动文档0条。日志保留，不声称全仓文档已绿。humanizer 在项目及全局 Skill 中未找到，已人工通读并修正过时合同。合同见[现场委托](../agent-delegation.md)，下一步见[本地接续](../handoffs/2026-11-04-agent-native-resume-local.md)。
