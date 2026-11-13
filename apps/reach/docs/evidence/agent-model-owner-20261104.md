# 模型请求归属与未知运输停止：本地证据

作者：Ray Zhang（Ray）。日期：2026-11-04。

本点实现服务实例独占、原模型请求归属及精确停止对账。仅本地开发和测试；没有服务器、SSH、远端模型访问、安装、部署或 Git 同步/提交/推送。基础仍为0/52，Desk仍为0/5。**停止回执不授权接管原执行，原Task崩溃恢复尚未完成。**

## 实现范围

`src/service/owner.ts` 在打开业务数据库前取得独立 `<db>.owner.sqlite` 的独占事务，核 DELETE journal mode并持有至关闭。锁身份绑定规范路径及物理锁文件；拒绝硬链接别名、文件替换及复制数据库后的错误认领。`:memory:` 只提供临时身份，不能证明跨重启退出。关闭不删除锁文件。

schema7新增 `agent_service_instances`、`agent_model_owners` 和 `agent_model_stops`。预占模型请求与记录owner在同一事务；运输持有冻结的 instance/execution/generation/route/run/body 快照，streaming、finish及joined写入重新校验完整快照，旧continuation不能污染其他代。旧请求不补造owner。新锁也不能证明升级前已运行、未参与锁协议的schema6进程已退出，升级须先离线停止旧服务。

每个Store仅绑定一个Broker。Broker.close共享Promise，封准入、abort并等待输入迭代器及上游reader/body取消和全部continuation，然后持久joined。HTTP server.shutdown同样共享Promise，等待pending listen、HTTP/Desk continuation及模型关闭，再关DB与释锁；关闭后禁止重新监听。启动及监听失败走同一清理路径。

调用方可通过 `GET /api/v1/operations/:id/agent-models` 查询，通过同路径POST提交停止对账；CLI为 `agent-models ID`、`agent-model-stop INPUT.json`，MCP为 `reach_agent_models`、`reach_agent_model_stop`。POST严格绑定原dispatch/hash/request/run/body/owner、reconciliationId及原证据文本；认证、账户隔离与浏览器CSRF沿用。当前仅接受unknown/failed/cancelled不可重开父、原root execution及generation1的未知模型请求。

同owner须实际abort/join并核持久joined，active map空不构成证明；不同owner须证明同物理锁、同协议的旧实例已退出。ownerless旧行及复制到其他锁环境的库拒绝认领。回执不可变，同内容重试幂等、改内容冲突；不改原state/usage或父事件，不退款、不重发、taskAccepted=false。所有非stream_complete仍为unsettled，继续阻挡新模型、工具和原父成功。停止运输不等于供应商停止计费。

## 版本与执行

仓库 `E:/repos/ara`，dev，HEAD `90f2b1cdd138129e2d331d89a37d70852e849739` 加原WIP。最终冻结 `work/agent-model-owner-20261104/inputs-r4.json` SHA `281bd88ac8831acef9afdd02cdcb487a01cf4c1546593adccd2f63013760824f`，184源/副本、22语义目标及4个既有runtime。主要产品执行为R3，manifest SHA `188de29ee61434e9441be31407b7e9afb4c5b24c04e6d4f7eacfcb244bcaf4c6`；R3到R4仅fixture最终peer close等待观察补丁，产品源码相同。

Node沿用 `work/agent-budget-20261104/runtime-r1/reach.exe` SHA `65e2f635ffb5152a9a0ee9c5203fa626c38b8658f7b652a7f785ee34ba029f0e`，同目录侧车SHA `c5b47fea1ab97745d93f7918b8c6ec2f6e246cc122201a25fab2e76a4ee5101f`；desktop/Python仅核身份，本点未新增桌面执行。Rust/Core/Harness、依赖及lock无本点变化，不重复Cargo/deny，也未更新安装包。

从 `apps/reach/` 执行的入口如下。旧schema6探针显式提供 `REACH_SCHEMA6_SERVICE_MODULE` 为消费点冻结Store的绝对路径；默认未提供会skip，本机实际启用且核SHA。native入口另设置上述 `REACH_NODE_BINARY` 与 `REACH_DESK_SIDECAR`。

```powershell
node --test --test-concurrency=1 tests/agent-model-stop.test.ts
node --test --test-concurrency=1 tests/agent-model.test.ts tests/artifacts.test.ts
node --test --test-concurrency=1 --test-name-pattern='fixed one-call Runs|hard-exited real service owner' tests/agent-budget.integration.test.ts tests/agent-model-stop.integration.test.ts
node --test --test-concurrency=1 --test-name-pattern='explicit stopping joins|a second broker' tests/agent-model-stop.test.ts
node --test --test-concurrency=1 tests/agent-consumption.test.ts tests/agent-budget.test.ts tests/agent-reviews.test.ts tests/agent-calls.test.ts
bun run check
```

| 日志（work/） | 实际结果 |
|---|---|
| agent-model-owner-service-r3.log | 14/14，零skip，65.198秒；owner、定向停止、晚写拒绝、生命周期、旧版本拒绝 |
| agent-model-owner-model-regression-r3.log | 模型及附件20/20，零skip，158.185秒 |
| agent-model-owner-native-r3.log | 实际Node两函数2/2，零skip，62.661秒 |
| agent-model-owner-observation-r4.log | 两个关闭观察用例2/2，零skip，11.204秒 |
| agent-model-owner-budget-regression-r4.log | 四文件26/26，零skip，70.129秒；消费探针同时显式启用旧v4/v5制品 |
| agent-model-owner-typecheck-r4.log | 基础/admin类型通过 |
| agent-model-owner-regression-r2.log | 29/30；附件reopen的ECONNRESET失败保留。基础service十函数沿未变源码桥引用，不称R4重新执行 |

以上是分版本、分组证据，不合并宣称一次最终全量测试。历史work中的冻结旧制品不随干净仓库自动提供。

## 原件及故障核验

实际Node正常根 `work/agent-budget-414f9166-10ee-4062-b9c1-044174a27191` 有1Task/3Run/3完整模型/2child及36全ACK事件。文件为 `once\n`，两个闭合预算快照后普通候选，fence Released、TaskAccepted=false；这是正常多轮回归。

硬杀根 `work/agent-model-owner-native-1b3a2903-243b-49ff-bc16-fe3fc39c2cc2` 有1Task/1Run/1真实模型/0child及8全ACK事件。服务子进程实际SIGKILL并等待退出，新实例取得同物理锁；真实CLI和MCP stdio停止原请求及幂等重试。原模型仍streaming、usage null、owner admitted，父与Node unknown；原fence active_or_unknown、resumed_from=null，没有新增Task/Run或第二模型。保留fixture-exit.json和旧/新服务PID退出记录。两根合计2Task/4Run/4模型/2child/44全ACK事件，不能据此声称Task已恢复。

服务fixture的父运行回执为synthetic，与上述真实Node分开。R3的11根含9模型行、8真实HTTP及7stop；R4两项重测增加3模型行/3HTTP/2stop，是重复执行补证。R3两份最终快照只保存peer close的1/2及0/1，原件不改写；R4等待提供方res.close后新根分别记录2/2及1/1。定向停止命中agent_model_explicit_stop，另一root仍运行至全局关闭。

R1 pending listen提前释锁及退休后relisten漏洞经独立复核发现，R2修复并实测；R1所谓显式停止其实parent monitor先abort，后续同JS turn停止并核准确error。R2附件连接重置来自重开后复用旧keepalive，fixture.api增加connection:close，R3完整附件组通过。失败fixture重建的快照后还有一次额外Store开关，最终DB多一条instance属已记录时点差异。只读审计可能创建空WAL协调文件，业务DB及既有WAL不改；审计自身初次失败说明保留。

主代理 `check.mjs` 直接核184源/副本、runtime、服务原根及两native原件，`checked-r4.json` SHA `a9f35f21b379804c8841f128584598603e165745806623003d2293eec4d12c2a`。独立复核 `/root/reach_plan_review` 接受本地owner及停止对账，无未关闭确认阻断；报告 `work/agent-model-owner-independent-review-20261104.md` SHA `1595148a97f51db3ddd24678657277cada5b1dc38a08a0f05abf6568ad6cf8a1`。主代理完整回读，核12报告链接和16份bridge引用，`review-checked-r4.json` SHA `53ef786eff0d25b91f993c10127f3432273067dd4557c6e25064366f746dc7cf`。独立进程快照于01:02:29 UTC确认原件记录16个PID均不存在，未终止进程；不是全机进程清单。

七文档162本地链接、22目标空白和根git diff --check通过。根bootstrap原样执行退出1，共371条失败；相比前点234条，多137条均来自前点保留的documents-r6局部文档快照，本点七份活动文档0失败。原日志及逐条差异审计在 `work/agent-model-owner-20261104/bootstrap-r4.log` 和 `bootstrap-audit-r4.json`，执行时尚未生成本点文档快照。不报告全仓文档门禁通过，不清理历史原件来消除失败。独立文档复核路径为 `work/agent-model-owner-doc-review-20261104.md` 及同名JSON；文档复核后生成最终绑定清单 `work/agent-model-owner-20261104/checked-final.json`。humanizer未安装，本文人工审读。

## 后续

原Task恢复仍需root/execution关联、单active generation、原relay/deadline重绑、Harness锁内核原件和消费、待prepare槽复用、原child精确对账与真实硬中断后继续。当前owner/停止入口只支持root/generation1，不能直接推广到未来attempt，也不能让停止回执豁免所有unsettled。typed截图恢复、R04/R05、安装、SYSTEM/SCM/锁屏、旧Desk历史、真实模型及部署仍开放。见[委托合同](../agent-delegation.md)及[本地接续](../handoffs/2026-11-04-agent-model-owner-local.md)。

后续[恢复准备服务层](agent-executions-20261104.md)已建立root/execution与当前代关系，但所有新attempt仍为reconciling；本点owner/停止执行范围保持不变，原Task继续执行仍待接通。
