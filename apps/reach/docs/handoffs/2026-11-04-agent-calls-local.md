# Reach 本地接续：现场委托服务合同

作者：Ray Zhang（Ray）。日期：2026-11-04。

继续完整清单/原goal，本轮是progress：新增并验证服务端父子操作合同，另补本地传输证据。基础仍0/52、Desk0/5。先遵守用户限制：不SSH、不访问服务器、不探测远端模型、不部署、不安装、不提交/推送、不清理已有WIP。仓库`E:/repos/ara`、dev、HEAD`90f2b1c`；不要套用Lumen分支或TS-only规则。不重复询问UAC，安装候选仍60a6，18912旧代理已停。

当前权威[合同](../agent-delegation.md)及[证据](../evidence/agent-calls-20261104.md)。普通Rust Node还不声明agent.delegate；Node现场Host、组织model relay、恢复API与累计字节预算**尚未接通**，不能称R01/R02/R03完成。

## 已实施

`src/contracts/protocol.ts`分出basicCommandSchema，增加delegateSchema和原参数JSON/SHA回调schema。`src/service/agent-calls.ts`实现父身份/来源/预算、同事务submit+claim+map、原call重复读取、固定cwd、父deadline/取消、成功及reconcile完整child集合。`ReachStore`迁移v2新增agent_calls并支持嵌套SAVEPOINT，原operations/events/产物仍唯一；HTTP新增Node calls和账户children读取。父taskAccepted始终false、awaiting_review。

内层使用真实子operation而不是替换父Dispatch：现有Ledger会拒绝改写原dispatch_json，Desktop又要求独立dispatchId；父operation的contentIndex全局唯一，直接混写两次截图会冲突。每child保留现有16MiB/4图产物上限，父只引用child ID。现有Desk8工具保持basic schema，与前一实际r8的start.run.tools逐项精确相等，没有无条件增加委托schema/递归能力。

独立发现并修复：父5秒下600秒子命令到6秒仍control.cancel=0；现在timeout封顶到父remaining，control和重复响应保留parentDeadlineUnixMs，超时有效取消。服务取消/未知不等于撤销，现有child只读不重claim。未知child阻止父成功与后续原Session委托；父reconcile成功也不能绕过，已有child不能宣称not_executed。

## 固定版本与验证

最终freeze `work/agent-calls-20261104/inputs-r2.json` SHA `d0724a646f414e6b90ac1c201567e3bfafd8b06fec45f3840ab810a79aba788f`：151选定源/副本、7旧镜像；r1的149源没变，新增原生测试与可选保留证据夹具。没有Rust、锁文件或依赖改动/重建；侧车0275185、Node69b14c、helper0ea7c0，旧26d9/2f858各Task继续用原镜像。旧preview清单留作旧版本，不覆盖冒称匹配新Store。

日志按层分开，不重复计函数：

- `work/desk-transport-first.log`2/2、24.575s，四场景真实共享侧车，每场景2请求/1回调/一次文件效果；keepalive活连接、idle关闭重连、显式关闭均续接，drop followup则保留ReconciliationRequired/fence零重放。未复现旧24/28KB故障，不改pool/retry。
- `work/agent-calls-r2.log`27/27、73.730s（7新+20相关旧）；扩展r4为8/8、18.945s；最后补duplicate deadline字段，r5受影响2/2、5.146s。r3保留7/8重开服务附近ECONNRESET；图事务夹具随后用Connection:close隔离传输变量，无自动retry。
- `work/agent-image-regression.log`4/4、17.536s；默认无Desk装配、上下文与原图API。
- `work/agent-node-retained.log`3/3、21.069s；实际普通RustNode文件/命令、取消树、杀Node重启零重放。原件保留在`work/agent-calls-20261104/native/reach-native-H2GiMd`、`WN4wqo`、`LuXmkd`，包含node/service SQLite、效果文件和fixture-exit.json。首轮26.327s临时目录被既有夹具删除，仅日志，不重复计数。

新增服务PNG与Node生命周期是seeded合同证据；真实Node三组只是既有基本工具回归。此前真正截图→Desk→provider→Chrome同字节仍见[原点](2026-11-04-desk-preview-local.md)，未重跑无变化大图/浏览器矩阵。当前所有执行句柄均终态，无遗留Node/服务；主代理已核保留的fixture PID和取消场景descendant PID均不在。

独立reviewer `/root/reach_plan_review`接受本次限定服务合同，报告`work/agent-calls-independent-review-20261104.md` SHA `af1c3ff710a7ce78f5adaa88346f8c09d9b19b65c56b6ee6a4858005c358c36c`；151只是选定hash覆盖，语义范围限定新增服务/协议/接线及测试。独立原件JSON SHA `ccd8b458ac2594feb29fe257bfbafea8e8962369587efb7950486ffaa419a2a0`。主代理完整回读报告，并用`work/agent-calls-20261104/check.mjs`逐核源码镜像、4组重点图、迁移全文、3组原生原件/退出、4个transport场景。最终`checked-final.json` SHA `5a040218509ac32b3a52a04f152bfd67fc625eddced15d7d129513434ffcdf7e`；6文档112条链接及diff检查通过，bootstrap仍234既有断链。humanizer缺失，人工审读。

## 下一步，继续实现而非重写循环

1. 接服务端组织模型broker/relay：客户不配模型；固定父operation/dispatch/路由/能力来源/预算，组织密钥留服务，Node本机专用随机relay token。每请求先原子占模型调用预算，取消/epoch/截止时间贯穿SSE，未知不返还预算/不重发。现Node Api.call为12秒/2MiB/JSON，不能拿来传SSE。
2. Rust Node增加现场Host，启动固定侧车，运行前等父running ACK；内层call用已实施API取真实child Dispatch，在原Ledger.accept+running后复用现有worker/Desktop，不伪造Dispatch或混父终态。子终态先落outbox，才回侧车；已有执行意图不重做。Tool、模型和验证各阶段全程看父取消，停兄弟worker/Desktop后再收侧车。先做真实Node两文件/命令贯通，再两次实际截图，不以本轮seeded PNG代替。
3. 原Task endpoint/token/镜像/工具/预算/绝对deadline必须固定；原端口不能重绑就拒绝，不换Session绕过Harness authority。恢复使用新operation明确关联原Task/fence，不能重开已unknown的旧父。首个Task正常交付仍awaiting_review；真实组织模型、生产安装/SCM/SYSTEM/锁屏和部署继续等待相应阶段。
4. 继续R04/R05来源、技能、经验晋升及旧平台历史完整迁移。临时来源不自动晋升。默认Reach不加载Desk，LabSlot延期。

本地transport仍有旧异常未定因：固定rpi只保存send错误Display，source链丢失；当前小探针排除“所有idle关闭必败”，不覆盖旧较大请求/同步持久化边界。不要全局加retry或在缓存中改rpi源码。已通过点不重跑大矩阵，按具体新变化选验证。
