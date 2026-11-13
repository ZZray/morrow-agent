# 原 Task 与恢复执行关联：本地实施证据

作者：Ray Zhang（Ray）。日期：2026-11-04。

本点建立恢复准备所需的服务关系和门禁，**没有实现原 Task 继续执行**。仅本地开发测试；没有服务器/SSH/远端模型访问、安装、部署或Git同步/提交/推送。基础0/52、Desk0/5不变。

## 已实现及未开放的边界

schema8新增 `agent_tasks`、`agent_executions` 和 `agent_child_executions`。首次delegate与其gen1关系同事务创建，首次claim同事务固定原 `claimed_at + maxSeconds`。旧库只回填可从原操作推导的gen1及child归属，保留原command、hash、事件、预算和owner，不补造native admission。已经schema8的缺行或冲突映射拒绝重开。

`agent.resume`沿原提交API，只接收rootOperationId、previousExecutionId、fenceSha256和恢复原文instruction。它不接收新Session、cwd、模型、工具、预算或deadline。原文不trim并保存SHA；expected fence只是调用方提供的前置值，尚未由Harness验证。同requestId精确幂等、变更冲突；不同并发请求只能一个切换current与generation，旧operation及事件保留。

原root必须已派发且原deadline仍有效。previous须是同root、账户、Node/epoch的current，处于unknown/failed/cancelled；精确未派发且已取消的reconciling attempt可作为后继，generation不回退。同Session新delegate与resume事务互斥；原root之后已有同Session Task时拒绝恢复，包括created_at同毫秒、后续已终态的情况。

所有新attempt始终为 **reconciling**，Task的requires_reconciliation置1，本点没有清除或激活入口。该attempt被取消、failed、通用对账或设备撤销都不释放原Task/Session与重新配对阻挡。phase是服务准入阶段，current可以指向已终态的attempt，不代表仍在运行。Node尚未实现或声明agent.resume；原submit和claim的最新capability检查继续阻止旧Node收到它。

统一resolver区分root权威与本次execution。模型/Run/child/review仍按root累计；新效果同时核current/generation、phase、running ACK、Node/epoch、取消位和原deadline。测试中即使synthetic Node把新attempt回执到running，模型路由/请求、Run预占、新child、新候选、新反馈、succeeded及成功reconcile仍拒绝。跨execution的原child重取会核归属并明确evidenceOnly，不产生新派发。

取消root定位当前attempt；取消非root旧attempt只处理本代child。child control沿创建它的execution，时间仍沿root。旧ACK与原child回执继续归档；已显式对账后的迟到原始成功仅追加历史，不改变独立对账结果、current、generation或pending。模型owner锁协议仍为7，停止入口仍严格root/gen1，所有非stream_complete继续unsettled；本点不豁免未知模型、不退款、不重发、不接受业务Task。

只读入口为 `GET /api/v1/operations/:id/agent-task`，CLI `agent-task ID`、MCP `reach_agent_task`；可见原Task、当前执行及完整执行历史。Node的 `POST /api/v1/node/agents/:executionId/context` 精确绑定本次dispatch/hash，返回原root派发、原descriptor或null及原deadline，不重新绑定当前组织配置、不输出组织密钥。HTTP/MCP调用函数有本地证据；新agent-task CLI及MCP stdio进程未另做端到端执行，不将源码接线等同于该项验收。

## 固定源与执行

仓库 `E:/repos/ara`，dev，HEAD90f2b1c加原WIP。最终 `work/agent-executions-20261104/inputs-r4.json` SHA `8c6ed122c30653576b95166c326788f30cc6c20443fd51dd77f8b51ea60438ac`：186源/副本、18语义目标、4既有runtime。Rust/Core/Harness、依赖和lock未改；不重复Cargo/deny、不更新安装候选。

主要既有回归执行于R2；R2→R4产品仅加强启动时child provenance的缺失目标检查，其他产品字节相同。R4重新执行新服务组、迁移相关函数与两个实际Node流程。各版本冻结、失败及原件均保留，不合并称为一次R4全量测试。

| work/日志 | 实际结果 |
|---|---|
| agent-executions-service-r4.log | 12/12，零skip，24.839秒；新请求/并发/取消/身份/原deadline/历史/重开及损坏库 |
| agent-executions-migration-r4.log | 8个具名函数通过，33.127秒；Node汇总9pass中的第9项为空匹配文件容器，不作行为函数计数 |
| agent-executions-native-r4.log | 实际Node两函数2/2，零skip，49.087秒；正常多Run及旧owner硬杀停止，不是resume |
| agent-executions-typecheck-r4.log | 基础/admin类型通过 |
| agent-executions-regression-r2.log | service/calls/reviews/budget/consumption五文件36/36，零skip，71.152秒；R4沿精确SQL差异桥引用 |
| agent-executions-model-regression-r2.log | 模型与owner停止31/31，零skip，118.997秒；R4沿差异桥引用 |

从 `apps/reach/` 执行：

```powershell
node --test --test-concurrency=1 tests/agent-executions.test.ts
node --test --test-concurrency=1 tests/service.test.ts tests/agent-calls.test.ts tests/agent-reviews.test.ts tests/agent-budget.test.ts tests/agent-consumption.test.ts
node --test --test-concurrency=1 tests/agent-model.test.ts tests/agent-model-stop.test.ts
node --test --test-concurrency=1 --test-name-pattern='migration|migrate|migrates|schema|version one receipts' tests/agent-calls.test.ts tests/agent-reviews.test.ts tests/agent-budget.test.ts tests/agent-consumption.test.ts tests/agent-model.test.ts
node --test --test-concurrency=1 --test-name-pattern='fixed one-call Runs|hard-exited real service owner' tests/agent-budget.integration.test.ts tests/agent-model-stop.integration.test.ts
bun run check
```

新服务组显式设置REACH_SCHEMA7_SERVICE_MODULE为owner R4冻结Store绝对路径，原字节SHA `5b8b130b2dae52583af0866dee29f49cb1b5df721c51ed147fb54b42569d02af`；旧v4/v5/v6探针分别显式使用前点固定制品，未提供时默认skip。本机相关分组显式启用且零skip，不声称这些work旧制品随干净仓库提供。native沿用预算点Node `65e2f635ffb5152a9a0ee9c5203fa626c38b8658f7b652a7f785ee34ba029f0e` 与侧车 `c5b47fea1ab97745d93f7918b8c6ec2f6e246cc122201a25fab2e76a4ee5101f`。

## 原件与故障

R4新服务组有11个modelFixture原根、一个实际冻结schema7 Store迁移根、一个回滚根；所有父/child生命周期为synthetic Node，只有并发场景的一次模型SSE是真实本地HTTP。三个故意破坏provenance的根必须保持损坏并被拒绝，不能按正常库审计。legacy迁移只推导服务归属，不证明曾运行原生Task。

实际Node正常根为 `work/agent-budget-eae9a9c4-7682-4e15-abd4-74c03c9a9d93`，1Task/3Run/3完整模型/2child/36全ACK，effect.txt为once换行；硬杀根为 `work/agent-model-owner-native-aeaf7b4b-8ebd-4bd3-b00e-21d7b104018d`，1Task/1Run/1模型/0child/8全ACK。两者均gen1/current=root，没有新resume execution。硬杀根原streaming/usage null、父unknown及精确停止回执保留。两根合计2Task/4Run/4模型/2child/44全ACK，不能作为崩溃后继续执行证据。

本轮未设置REACH_NATIVE_EVIDENCE_ROOT，R2/R4 native没有额外fixture-exit.json。依据原测试终态、显式硬杀等待及fixture await cleanup代码记录流程结束，不补造历史全PID退出清单。主审计首次因误期待该可选文件出现ENOENT，修正为明确记录缺失边界；说明保存在main-first-audit-note.json，不当产品失败。

冻结前的初次类型检查因参数属性不符合erasableSyntaxOnly及漏导入失败，修正后通过；该早期日志名含r1，不将其诊断绑定为冻结R1源码。R1服务9pass/1fail是夹具误把修改既有review作为首次发布，先命中candidate_conflict；R2用新Run身份核真正首次发布，10/10通过。独立复核发现启动SQL的NULL/INNER JOIN遗漏：R3离线把child归属改为不存在的execution，实际开库未拒绝，负例失败。R4改为显式检查关联目标缺失，并覆盖额外孤立child operation；原失败日志 `agent-executions-dangling-before-fix-r3.log` 和损坏原库保留。

主 `work/agent-executions-20261104/check.mjs` 核最终源、四次冻结、精确R2→R4产品差异、上述原库与两native原件；`checked-r4.json` SHA `ade6229a1805f9ccaafbc4a633028667194f3963da931102191fd9f9407426d4`。独立设计及实现复核分别记录在 `work/agent-execution-design-review-20261104.md` 与 `work/agent-executions-independent-review-20261104.md`。实现报告SHA `2300483ed6b14de30fafb1217b980a62d5eb1de5b50db2d3fe815a1399de8bd9`，接受限定服务层、确认P2已关闭，无未关闭发现；未接受原Task恢复。主代理完整回读并核22报告链接、105个原件/审计引用，`review-checked-r4.json` SHA `8f278e78fa4759ebb6a2bf19822832215083161ee820f3149fb35607680dd8c5`。

七文档164本地链接、18目标空白和根diff检查通过。根bootstrap原样退出1、516条失败；相比前点371条新增145，其中143来自前点局部文档快照，2来自本轮独立报告的本地:41行号链接（目标源码及行存在，根checker未解析行号语法）。本点七活动文档0失败，无移除；原日志与逐条分类保存在 `work/agent-executions-20261104/bootstrap-r4.log` 和 `bootstrap-audit-r4.json`。检查时尚未生成本点文档快照，不称全仓文档门禁通过。

文档复核使用 `work/agent-executions-doc-review-20261104.md` 及同名JSON；复核后再生成 `work/agent-executions-20261104/checked-final.json`。不把文档检查当产品运行验收；humanizer缺失，文档人工审读。见[当前合同](../agent-delegation.md)和[接续交接](../handoffs/2026-11-04-agent-executions-local.md)。
