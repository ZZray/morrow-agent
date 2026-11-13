# 现场委托父子操作与本地传输分项

作者：Ray Zhang（Ray）。日期：2026-11-04。范围：服务端委托关系、原收据生命周期与普通侧车的本地HTTP传输；仅本地，无服务器访问、远端模型探测、部署、安装、提交或推送。

本轮继续完整清单，没有把范围改成只做Desk。服务现在可以原子创建并派发真实子operation、取回原调用关系、传递父取消/截止时间，并拒绝不完整的父成功与对账。**Rust Node委托Host、组织模型relay和完整R01–R07尚未接通**；当前Rust Node不声明`agent.delegate`。服务测试中的Node生命周期和两张PNG为夹具入账，不能当作实际委托或截图。

## 源码与合同

仓库`E:/repos/ara`，分支dev，HEAD`90f2b1cdd138129e2d331d89a37d70852e849739`加既有WIP。设计见[现场委托合同](../agent-delegation.md)，源码为`protocol.ts`、`agent-calls.ts`及Store/HTTP调用方。

- 新`agent.delegate`请求保存固定Session/cwd、目标、来源原文/版本/SHA和预算。服务校验来源ID、原UTF-8摘要和64 KiB合计限额；来源不自动成为权限或组织知识。
- 服务schema v2在原库增加`agent_calls`，不新增领取队列；父/子仍在原`operations`和`operation_events`。同事务内核父→建child→唯一dispatch/claimed→建映射，失败整体回滚；嵌套提交使用SAVEPOINT。重复call返回原child，不重新claim；改参数/dispatch/hash拒绝。
- 子操作按固定cwd解析真实路径，有独立artifact index与原产物限制。父结果只引用完整child集合，不能混用子manifest，也不能将Task自动接受。父成功及通用reconcile都重核子集合；已有子项的父不能声明未执行。
- 父取消传播到子操作；child control叠加父终态与原deadline。命令/桌面超时cap到父remaining，响应保留父绝对deadline，重复读取也不改变。新子项在父停止/超时/解绑后拒绝，原映射仍可读。
- `basicCommandSchema`保留原Desk八工具的实际schema，未把委托与递归能力无条件加进旧云端Run。与前一实际截图Task的`start.run.tools`逐项精确相等，见`work/agent-calls-20261104/schema-bridge.json`。

最终选定源码冻结：`work/agent-calls-20261104/inputs-r2.json` SHA `d0724a646f414e6b90ac1c201567e3bfafd8b06fec45f3840ab810a79aba788f`，151源码/副本、7已有镜像。r1为149源，SHA`ba3dc86e08e4038d0d4cba467aff0d3337d42df197106801a05f7d9a7eb07582`；r2只补原生测试及可选证据保留夹具，原149源相同。旧[原图查看点](desk-image-preview-20261104.md)的冻结保留，不声称它继续匹配新Store源码。

未改Rust源码、依赖或锁文件，未重建/重发安装包。侧车仍为固定0275185，Node仍为69b14c；三个历史侧车镜像按原Task保留。7个镜像哈希核对不是第三方运行时整树重新打包。

## 实际运行

以下命令从`apps/reach/`运行。Web无改动；本轮只运行受影响TS检查，没有重跑无变化的UI构建/Cargo矩阵。

| 检查 | 结果 | 原始记录及版本范围 |
|---|---|---|
| `tsc.exe --noEmit`与`tsc.exe --project platform/tsconfig.json --noEmit` | 最终通过 | 包含新的服务合同、测试及保留原件开关 |
| 普通JSONL侧车传输测试 | 2/2，24.575s | `work/desk-transport-first.log`；当前测试源未再改变，四种loopback场景 |
| agent-calls + service + service-process + desk-devices + device-tools | 27/27，73.730s | `work/agent-calls-r2.log`；7个当时的新函数及20个相关旧函数，先于最后duplicate deadline响应字段补齐 |
| agent-calls扩展后 | 8/8，18.945s | `work/agent-calls-r4.log`；增加HTTP服务重开、双child PNG等；Node生命周期为夹具 |
| duplicate deadline受影响复测 | 2/2，5.146s | `work/agent-calls-r5.log`；最后字段补齐后复测创建/重开/重复读取和父deadline |
| 默认Reach与原图API回归 | 4/4，17.536s | `work/agent-image-regression.log`；默认无Desk树/配置可启动；登录/原图/损坏/旧route等 |
| 真实Rust Node三个受影响函数 | 3/3，21.069s | `work/agent-node-retained.log`；保留原SQLite/效果文件/退出记录；首次26.327s只有清理前断言日志，不重复计数 |

各行存在重叠，不能相加成“最终源码新跑了全部矩阵”。服务端首批5/5保留于`agent-calls-first.log`，后续版本桥接如表；没有据此完成任何一项完整清单。

### 普通侧车传输

固定共享JSONL镜像直接执行一次真实本地文件回调，随后继续受控模型请求，不使用桌面、Reach账号或远端模型。四个原件根分别为：

- `work/desk-transport-live-2758d2a0-6097-49bc-b6c8-50b733dbe132`：2模型请求复用同一连接。
- `work/desk-transport-idle-close-beb37ea0-8069-475b-a675-fcb1ef3c4e5b`：回调结束前服务器关闭空闲连接，第二请求建立新连接。
- `work/desk-transport-explicit-close-b4167561-3448-4069-855e-e758311a1b8a`：显式关闭响应连接，第二请求新连接。
- `work/desk-transport-dropped-followup-aedbc434-2cb9-42b5-9925-16273f0072f9`：第二请求到达后丢弃，保留ReconciliationRequired/fence，不重发模型请求或工具。

每场景均2请求、1回调、一次`effect.txt=once\n`，侧车退出0，Task未接受。前三个AwaitingHostAcceptance，最后一个ReconciliationRequired。独立读取原请求、event、文件和结果引用；此探针证明“空闲关闭不必然失败”，没有复现或解决前一点24/28KB请求与持久化时序下的transport故障。

固定rpi 8ec4626 的provider复用reqwest client，ARA显式`max_retries=Some(0)`；`send()`错误只保留Display，底层source链缺失。JSONL虽为单线程Tokio，但stdin/stdout独立线程、回调oneshot.await；不能仅据单线程推断网络被整段工具等待阻塞。旧故障根因继续开放，本轮未改连接池、retry或上游缓存源码。

### 服务关系与真实Node旧链

最终服务8函数覆盖：6次并发提交只建1child；完整源绑定与路径；跨账户/Node/错dispatch/hash；服务关闭重开返回原child/dispatch；解绑或超时后只读旧调用；父取消、预算、在途child deadline；成功和reconcile完整集合；映射提交故障回滚；v1回执迁移及v2重开；两child各自index0且父无混合manifest。

两PNG夹具根`work/agent-calls-219963ca-04ed-4f3e-bf65-0a7b81802a19`有3个operation/2条映射/两张独立PNG；它不是实际Screenshot。成功对账根`work/agent-calls-6b5593fd-adbe-481c-b4e4-e2ad66a119ff`保留child原unknown事件、其failed对账与父succeeded对账。迁移根`work/agent-migration-983c3809-f5b0-4b6c-806f-221643851429`保留原operation/event的前后核对依据。

真实Node回归使用已有普通`reach.exe`，测试主机效果保留于：

- `work/agent-calls-20261104/native/reach-native-H2GiMd`：单次命令、流输出、重复requestId、实际文件与硬链接更新、陈旧SHA拒绝、读取/目录；5个原operation为succeeded/succeeded/failed/succeeded/succeeded。
- `.../reach-native-WN4wqo`：真实Windows子孙进程取消后停止，原操作unknown且processTreeStopped，不将取消说成撤销。
- `.../reach-native-LuXmkd`：杀Node后重启，原操作unknown/node_process_interrupted，实际文件仍只有一次`once`。

这三项验证新服务未破坏既有Node工具，不证明Rust Node已经执行`agent.delegate`。可选`REACH_NATIVE_EVIDENCE_ROOT`仅让测试保留其原件及PID/退出状态，默认临时夹具行为不变。配置和凭据仍只在忽略的work目录，不写Git。

## 发现与保留失败

独立复核发现父deadline未作用于已运行child：5秒父任务下600秒子命令，在第6秒仍返回cancel=0。已修复control的父截止时间与子timeout，并以原deadline、停止信号及零新child复测。未来Node Host仍须使用原绝对deadline和全程监督，不能只依赖每500ms的控制轮询。

既有未来schema测试原用v2，当前已升2；改为拒绝v3且不降级，并实际测试v1操作/回执迁移和重开。新增reopen夹具一轮7/8，因测试客户端复用被重启服务关闭的连接而ECONNRESET；随后夹具显式Connection:close隔离图事务，8/8通过。没有加自动重试，也不将此夹具选择当作生产连接池修复。

最初类型检查暴露control递归返回类型/旧投影不完整，已保持原控制投影并显式定义类型；无扩大普通node/control字段。清单脚本一度把`resolve`直接传map而收到索引/数组，生成前退出，修正后重新生成；没有覆盖先前清单。

服务库已升v2，新库不能交给旧v1服务继续写入；真实升级/回滚仍按安装部署合同单独验收。本轮未升级实际服务或安装包。

独立reviewer `/root/reach_plan_review`接受本次限定的本地服务端合同，最终报告`work/agent-calls-independent-review-20261104.md` SHA `af1c3ff710a7ce78f5adaa88346f8c09d9b19b65c56b6ee6a4858005c358c36c`。范围内无新的确认阻断；独立核151源/副本、7镜像、8组服务原件、3组普通Node原件，并重测先前5秒deadline内存反例。独立结果JSON SHA `ccd8b458ac2594feb29fe257bfbafea8e8962369587efb7950486ffaa419a2a0`；全部151文件是hash覆盖，并非全部重新语义审查。

主代理完整回读报告后，用`work/agent-calls-20261104/check.mjs`复核当前源/副本/镜像、4组重点父子图、两PNG原分块、迁移前后完整事件、3组真实Node原件/退出和4个transport场景。原件清单`checked-inputs.json` SHA `d106a109c849352ab82c3cdb3e022c57da8a7aa275f3dddedc8737a0df4bd619`；最终`checked-final.json` SHA `5a040218509ac32b3a52a04f152bfd67fc625eddced15d7d129513434ffcdf7e`绑定冻结、报告、脚本和分层日志，不将引用本清单的文档放回摘要。

6文档112条本地链接通过、`git diff --check`通过（既有CRLF提示保留）。全仓bootstrap仍234条既有断链退出1，日志`work/agent-calls-bootstrap.log`，未报全仓通过。humanizer不可用，人工审读。所有本轮exec已终态，没有为了失败清理旧Task、fence或WIP。

完整基础仍0/52、Desk0/5；模型relay、Node Host、ACK屏障、累计字节预算、原Task恢复和真实组织模型仍开放。下一步按[本轮交接](../handoffs/2026-11-04-agent-calls-local.md)继续贯通，不重跑无变化大矩阵。
