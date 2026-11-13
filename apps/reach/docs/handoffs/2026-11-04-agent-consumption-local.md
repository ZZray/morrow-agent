# Reach 本地接续：原 Task 保守消费基础层

作者：Ray Zhang（Ray）。日期：2026-11-04。

继续完整首版目标，仅本地开发和测试。禁止服务器/SSH/远端模型访问、部署、安装、提交、推送或清理原WIP。仓库 `E:/repos/ara`、dev、HEAD90f2b1c；不套用cwd Lumen的分支/TS-only/自动提交规则。基础0/52、Desk0/5，默认Reach不依赖Desk，LabSlot延期。此前误fetch已在预算交接记录，未merge/pull；本点没有Git同步。

当前完成服务内部保守消费账本，**没有新增agent.resume API或Node能力，也未完成原Task恢复**。见[证据](../evidence/agent-consumption-20261104.md)、[合同](../agent-delegation.md)。不要因内部receipt已持久化就放行执行或清unknown。

## 固定版本与结果

- 最终 `work/agent-consumption-20261104/inputs-r6.json` SHA `54f55f618a327d82c444355441a496ccf1747210daac13f78b0d8d2c2773e5a0`，177源/副本、11增量、4旧runtime。新增AgentBudgets，现有model/child/review准入读同一charged账本。schema6，新表/回填/版本同事务；v5拒绝新库。
- `reserved_cap`固定首次预占，`admitted_cap`保留实际准入，floor按每唯一Run取max而不按attempt重复加。缺observation全cap扣，actual与charged分开；零调用已admitted仍占Run，精确空前缀仅未admitted允许。历史零余额预占迁移保留UUID和cap0，新准入仍需正余额。
- R6服务13/13零skip、31.921秒；两旧schema断言精确回归2/2、7.032秒及类型通过。原9回归7pass/2fail与修正后两项分层引用，不报一次全量9/9。R1/R3旧11/12函数不当成最终版执行。
- 实际Node的budget prepare与默认CLI/MCP多Run在R3执行2/2、65.908秒；R6唯一产品变化是legacy零cap回填，正cap正常路径有明确source bridge，不冒充R6重新执行。2Task/5Run/73全ACK事件/7模型/4child，两个文件once，TaskAccepted=false。未运行崩溃恢复或截图恢复。
- 两旧制品探针须显式 `REACH_PREVIOUS_SERVICE_MODULE`（旧v4）与 `REACH_SCHEMA5_SERVICE_MODULE`（旧v5）绝对路径及固定SHA。默认skip，本机显式启用零skip；不声称ignored work制品随干净仓库提供。
- 主check `checked-r6.json` SHA `a9bb9e1ee22fb27eaf423f2f0e9f2c39d99dbf848100c55a29e3f34c365f3031` 核12服务原根及两native原件。旧v5零槽的模型行由旧库直接reserve/finish合成，0upstream；不算实际模型调用。两native无fixture-exit.json，不补造服务/侧车退出清单。

R2零调用Run退槽负例与R5旧零余额槽迁移拒绝已复现并修复。R4负例夹具清理错误曾留两个测试Node，记录原PID/命令后仅停止它们；该日志不是通过。R5修夹具再正常复现，R6同判据通过。所有冻结、失败和原Task/fence/close intent保留。安装候选未更新，不再询问旧UAC。

独立复核者 `/root/reach_plan_review` 接受内部账本与迁移范围，无未关闭确认阻断；报告 `work/agent-consumption-independent-review-20261104.md` SHA `1426aa8ff41ad1f4bf195d893fa0755271f1cbe93aa9c3ff0c9798dde2cc48d4`。主代理已完整回读并核17审计引用，保存 `review-checked-r6.json` SHA `aba8cbd4fecf5000e70000b044b3fc6a0836e105f0111b12b55787817a29c68a`。最终来源/文档检查绑定 `checked-final.json`；不将内部机制通过当作原Task恢复完成。

七文档159本地链接、11目标空白与根diff通过。根bootstrap按要求执行，仍234条失败、退出1，本点文档0失败；保留 `bootstrap-r6.log`，不称全仓已绿。除R4已记录的失败探针外，所有测试句柄已收终态；两native缺额外退出清单与进程活跃是不同问题。

## 下一实现点，保持完整恢复目标

已完整读独立设计 `work/agent-resume-design-r2-20261104.md` SHA `ed329dee5d45f441cb6b119a965674a6c3871e77113370eaf255fb34d3cdf452`，其输入SHA `68c50fcd0ef28da59763c5afd2087252b0755b5a7e2680dddcbdc7123ff1234f`；这是待实现设计，不是恢复验收。

1. 显式agent.resume新operation关联原root/previous execution；统一resolver返回root权威与当前execution，CAS只允许一个active generation。模型/Run/child/32MiB预算键沿root，Ledger/outbox/watchdog/API认证用新execution，旧unknown事件不改。
2. 先建立服务模型实例生命周期独占所有权及root/request/execution/generation的定向quiesce。封旧准入、abort并await真实运输finally后，写独立unknown停止对账；重启后map空不证明原owner死。可用独立SQLite文件持有独占事务，不阻塞业务DB。原模型state/usage不漂白、不退款、不重发；父reconcile不能清模型unknown。
3. 原task.json、Session、镜像/工具/route/endpoint/token及native本地绝对deadline逐值保留。relay必须绑定原端口，失败不回退；server deadline仍原root.claimed_at+maxSeconds，新的单调watchdog不能延长它。
4. start.resume用原fenceSHA，在Harness锁内核完整ResumeReview及所有root模型/child原件，再调用内部消费原语。服务先提交绑定本attempt的原生消费/效果receipt，Node持久准确回复后才发stdin；消费记录自身绝不是执行授权。
5. plannedRunId在start前固定；服务已预占但无native admission且无模型/child效果时复用原UUID/槽。已有admission即使0模型仍消耗Run。接管后admission前再次崩溃、receipt已提交但丢ACK都不重复扣或吃新槽。
6. 首个新model/child前核本次native admission并激活Run；原publish按reviews.length+1尚不能跨无review的崩溃Run，须改为真实Run/恢复前驱。旧execution不得新建效果、决定反馈或成功声明。
7. 所有历史child/实际模型/输出额度累计。开放工具按原调用顺序核完整收据，不通过再次tool()执行补结果；Node intent早于HTTP预占需区分not_reserved、服务complete而本地transport缺失、真正unknown，不补造旧transport。开放截图typed结果不能由文本ResumeReceipt恢复，须另补合同或明确拒绝。
8. 原root.cancel需定位active attempt；完成后同Session新Task/再配对不能因保留历史unknown永久阻挡。根状态读取同时展示历史失败与当前attempt，业务Task仍不自动接受。调用方需要真实只读fenceSHA入口。

后续至少跑真实硬中断/无首admission/待prepare槽/接管后再次崩溃/模型unknown停止/并发恢复及原owner活着、端口占用、deadline、wrong fence等拒绝矩阵。不要用本点synthetic消费证明这些已执行。R04/R05、安装runtime装配、SYSTEM/SCM/锁屏/切用户、旧Desk历史、真实组织模型、跨机/上线仍开放，远端操作等用户明确恢复。

Goal保持active。后续只重测受影响路径，不重跑无变化的大矩阵。humanizer未安装，文档人工审读。
