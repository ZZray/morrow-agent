# 原 Task 保守消费账本：本地实施证据

作者：Ray Zhang（Ray）。日期：2026-11-04。范围：原 Task 恢复所需的服务内部预算基础层。只做本地开发测试，没有 Ray 服务器、SSH、远端模型、安装、部署或 Git 同步/提交/推送。基础仍0/52、Desk仍0/5，**显式原 Task 崩溃恢复尚未接通**。

## 实现及边界

`src/service/agent-budgets.ts` 统一记录原Run顺序、首次 `reserved_cap`、实际原生 `admitted_cap`、单调 `charge_floor` 和恢复封存状态。模型、child与review的现有准入改用同一账本：Task消费为每个唯一Run的 `max(actualReservations, charge_floor)` 之和，普通/摘要模型预占同计，未知请求不退款。实际模型行数和保守逻辑扣减分开，不伪造请求凑数。

`recordNativeConsumption` 是内部原语，没有新增HTTP入口或Node能力声明。未来调用方必须在原Harness Session锁内核原admission/observation/fence与全部效果，并接执行记录门禁；现在的函数只保存消费，不清unknown、不接管执行、不放行新Run、不延长deadline。当前测试中的原生文件引用是明确的synthetic Node attestation，不能当成真正读取了原生崩溃原件。

缺observation须扣完整原准入cap；有observation可按准确观察值，但不得低于服务预占数或既有floor。重复receipt须原文身份一致，重复相同floor不叠加。消费前缀必须连续；已admitted但零模型的Run仍消耗Run槽，不能退成空前缀。真实尚未admitted的Task允许精确 `(0,0,[])`，保留已预占UUID，不另授权一个Run。

`reserved_cap` 不变，未admitted的槽可在原范围内首次绑定较小的 `admitted_cap`；已绑定值不能改变。消费封存的Run拒绝新模型与新child。Task总额检查与本次模型预占仍在同一事务，不能并发多放一条请求。

持久语义升级为 **schema6**，新增 `agent_run_budgets` 与 `agent_budget_reconciliations`。建表、旧数据回填及版本修改在同一个事务，失败整体回滚并关闭初始化连接。旧schema5服务拒绝新库；当前库若丢失预算行不会按actual重造退款。旧库迁移只推导服务预占cap，`admitted_cap=null`，不补造native admission。旧v5允许登记剩余为零的无模型Run槽，迁移保留其UUID/顺序和零cap；新注册仍要求正余额。

## 固定版本

仓库 `E:/repos/ara`、dev、HEAD `90f2b1cdd138129e2d331d89a37d70852e849739` 加原WIP。最终 `work/agent-consumption-20261104/inputs-r6.json` SHA `54f55f618a327d82c444355441a496ccf1747210daac13f78b0d8d2c2773e5a0`：177源/副本、11个增量目标、4个未变runtime。

产品变更为新增AgentBudgets以及store、agent-model-store、agent-calls、agent-reviews；测试为新增agent-consumption以及agent-budget、agent-model、service、agent-calls、agent-reviews。共享Rust/Core/Harness/JSONL、依赖和lock没有修改，不重复Cargo或依赖审计。

实际Node仍为 `work/agent-budget-20261104/runtime-r1/reach.exe` SHA `65e2f635ffb5152a9a0ee9c5203fa626c38b8658f7b652a7f785ee34ba029f0e`，同目录侧车SHA `c5b47fea1ab97745d93f7918b8c6ec2f6e246cc122201a25fab2e76a4ee5101f`。新服务源与旧运行物分别绑定，未更新安装候选。

R1为最初11函数通过；R2新增零模型Run退槽断言并实测失败；R3修复封存前缀、12函数通过及两条实际Node回归；R4/R5补真实旧服务零槽探针，R4另有夹具清理失败，R5正常退出并复现产品迁移拒绝；R6仅修legacy零cap分支、补reserved/admitted重开及两处旧schema断言。各版冻结/失败原件保留。

## 已执行

以下从 `apps/reach/` 执行。两个旧制品探针需要显式绝对路径；没有提供时各自skip。本机最终均提供并核固定SHA，13函数零skip，不声称历史work制品随干净仓库交付。

```powershell
$env:REACH_PREVIOUS_SERVICE_MODULE='E:/repos/ara/apps/reach/work/agent-cross-run-images-20261104/source-r1/apps/reach/src/service/store.ts'
$env:REACH_SCHEMA5_SERVICE_MODULE='E:/repos/ara/apps/reach/work/agent-budget-20261104/source-r3/apps/reach/src/service/store.ts'
node --test --test-concurrency=1 tests/agent-consumption.test.ts tests/agent-budget.test.ts
node --test --test-concurrency=1 --test-name-pattern='version one receipts|failed decision transaction' tests/agent-calls.test.ts tests/agent-reviews.test.ts
bun run check
```

schema5旧Store必须为SHA `54194ddb997e601044a2b3290a602d51795258672131ab15e77a4059acd7fb04`；schema4探针沿用前点固定旧Store。后者不能代替schema5的实际降级保护。

| 日志（相对work/） | 原结果与范围 |
|---|---|
| agent-consumption-service-r1.log | 11/11，23.298秒；不是最终版本的完整执行 |
| agent-consumption-service-r3.log | 12/12，26.445秒；含并发Task总额检查 |
| agent-consumption-service-r6.log | **13/13、零skip，31.921秒**；含实际旧v5零余额槽、reserved2/admitted1重开、原子回滚和旧版本拒绝 |
| agent-consumption-regression-r3.log | 9函数7通过/2失败；两处仍期待schema5，原数据保存断言未改 |
| agent-consumption-regression-r6.log | 两处schema断言同步6后精确2/2，7.032秒；另7函数沿未变证据，不报一次9/9全绿 |
| agent-consumption-native-r3.log | 实际普通Node两函数2/2，65.908秒；一条原生budget prepare、一条CLI/MCP普通反馈续接 |
| agent-consumption-typecheck-r6.log | 基础/admin类型通过 |

两条真实Node入口设置 `REACH_NODE_BINARY` 与 `REACH_DESK_SIDECAR` 为上述固定运行物，再运行：

```powershell
node --test --test-concurrency=1 --test-name-pattern='fixed one-call Runs|caller feedback continues' tests/agent-budget.integration.test.ts tests/agent-multirun.integration.test.ts
```

这些在R3服务执行，不称为R6重跑。R3→R6唯一产品差异是旧库回填的 `cap>0` 改为 `cap>=0`；两根实际场景为新建schema6库、所有cap为正、floor0、admitted=null，无恢复消费receipt。主/独立复核对该分支差异作明确source bridge，其他产品源完全相同；不以这两条正常路径证明崩溃恢复或保守扣减已进入native Host。

## 原件、失败与主回查

最终13函数有12个保留的modelFixture SQLite根，另一个旧v4临时serviceFixture清理其DB。主代理直接核12根原模型行、upstream计数、budget/receipt、迁移版本与原事件；其中故意破坏旧预算的根应保持schema5且无新表，不能当成正常schema6库。旧v5零槽探针以真实冻结旧Store直接reserve/finish生成**合成模型行**，实际upstream为0，不记作真实模型调用。

正常Node原件为 `agent-budget-53d3b6d1-7cce-4efb-af69-0dfaaf98e424`、`agent-multirun-d97c8545-7c9f-4148-8fdd-4cd38c948b16`，合计 **2 Task / 5 Run / 73原outbox全ACK / 7实际模型 / 4 child**，两个effect.txt均为 `once\n`。核原Task/Session、模型intent/transport/provider、feedback/budget subject/prepare及TaskAccepted=false/Released。无图片，不扩大为图片恢复或真实组织模型。

`work/agent-consumption-20261104/check.mjs` 回查最终177源/副本、4runtime、R3→R6差异桥及上述原件，`checked-r6.json` SHA `a9bb9e1ee22fb27eaf423f2f0e9f2c39d99dbf848100c55a29e3f34c365f3031`。两根native未设置fixture的额外退出记录开关，未生成fixture-exit.json；依据原终态及await cleanup代码记录执行结束，不补造全服务/侧车PID退出原件。

独立复核 `/root/reach_plan_review` 接受内部消费与迁移范围，两个确认缺陷已关闭，无未关闭确认阻断；报告 `work/agent-consumption-independent-review-20261104.md` SHA `1426aa8ff41ad1f4bf195d893fa0755271f1cbe93aa9c3ff0c9798dde2cc48d4`。独立逐根核服务原DB、native journal链与收据、旧失败原件及差异桥，未重跑矩阵。主代理完整回读报告并核17份审计引用，`review-checked-r6.json` SHA `aba8cbd4fecf5000e70000b044b3fc6a0836e105f0111b12b55787817a29c68a`。最终文件绑定清单为同目录 `checked-final.json`；该结论不包含原Task恢复。

七份改动文档159本地链接、11目标空白与根diff检查通过。另按知识维护流程跑根 `scripts/verify_bootstrap.py`，退出1、234条失败，均在本点文档外；原日志 `work/agent-consumption-20261104/bootstrap-r6.log`。全仓旧临时路径、旧源码及归档等链接仍未修，不报告全仓文档门禁通过。

保留两条确认缺陷的负例：R2零调用已准入Run被空前缀退槽，`agent-consumption-empty-before-fix-r2.log`为1失败；R5真实旧v5零余额槽被新迁移拒绝，`agent-consumption-zero-before-fix-r5.log`为1失败且正常清理。修复后相同判据在最终13函数中通过。

R4历史探针在预期迁移失败后再次调用已经部分关闭的fixture，清理漏掉upstream，两个测试Node进程保持存活。主代理保存 `zero-before-fix-processes.json` 的原PID/命令/创建时间，只停止这两个失败探针进程；不把强制停止当作测试通过。R5改为在安静原fixture连接旁用新ReachStore执行迁移，成功/失败均正常cleanup。原R4日志只有失败行，不伪报完整测试终态。

## 下一步

完整恢复设计为 `work/agent-resume-design-r2-20261104.md` SHA `ed329dee5d45f441cb6b119a965674a6c3871e77113370eaf255fb34d3cdf452`。后续[模型owner与停止对账](agent-model-owner-20261104.md)已完成生命周期及未知运输停止基础层，不改变本点执行范围。root/新execution关联、原deadline/relay精确重绑、Session锁内reconcile消费与效果、待prepare槽复用及真实硬中断原Task恢复仍待完成。开放typed截图工具的文本settlement不能冒充图片恢复。

R04/R05、安装、SYSTEM/SCM/锁屏、旧Desk历史、真实模型和部署仍开放。humanizer缺失，本文人工审读。当前合同见[现场委托](../agent-delegation.md)，下一入口见[本地交接](../handoffs/2026-11-04-agent-consumption-local.md)。
