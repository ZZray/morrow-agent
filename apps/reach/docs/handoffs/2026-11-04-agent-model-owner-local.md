# Reach 本地接续：模型请求归属与停止对账

作者：Ray Zhang（Ray）。日期：2026-11-04。

继续首版目标，仅本地开发测试。禁止服务器/SSH/远端模型访问、部署、安装、提交、推送、Git同步或清理原WIP。仓库 `E:/repos/ara`，dev，HEAD90f2b1c；不套用cwd Lumen约定。基础0/52、Desk0/5，默认不依赖Desk，LabSlot延期。Goal保持active。

本点已完成并独立复核：模型owner生命周期独占、未知运输精确停止对账及服务关闭顺序。**没有agent.resume API或Node恢复能力，没有接管原Task。** 详细结果见[证据](../evidence/agent-model-owner-20261104.md)，当前行为见[合同](../agent-delegation.md)。

## 当前固定点

- R4 manifest `work/agent-model-owner-20261104/inputs-r4.json` SHA `281bd88ac8831acef9afdd02cdcb487a01cf4c1546593adccd2f63013760824f`：184源/副本、22语义目标、4旧runtime。R3主要产品执行与R4产品源码相同，仅fixture最终peer close观察等待变化。
- schema7新增instances/owners/stops；独立SQLite锁先于业务DB取得，规范路径及物理身份绑定、硬链接拒绝。旧schema6无owner行不得认领；新锁不证明未参与协议的旧活进程已死。
- 模型预占/owner同事务；冻结完整instance/execution/generation/route/run/body，streaming/finish/joined核原快照。Broker及HTTP shutdown共享Promise，等待运输与HTTP/Desk continuation、pending listen后才关DB释锁。
- GET/POST `/api/v1/operations/:id/agent-models`，CLI `agent-models`/`agent-model-stop`，MCP `reach_agent_models`/`reach_agent_model_stop`。只接受不可重开的unknown/failed/cancelled父，当前仅root/generation1；实际join或同物理锁证明退出才给不可变停止回执。
- 原state/usage、父事件及预算不改，不退款/重发/接受Task。非stream_complete仍为unsettled，继续阻挡模型/工具/原父成功；停止运输不保证供应商停止计费。
- R3服务14/14、模型及附件20/20、实际native2/2；R4定向观察2/2、消费/预算/review/calls26/26，均零skip。基础/admin类型通过。R2组合29/30原失败保留，基础service十函数沿未变源码桥，不报R4重跑全绿。
- 实际native合计2Task/4Run/4模型/2child/44全ACK；正常多轮根文件once，硬杀根原模型streaming/父unknown/fence active_or_unknown、resumed_from=null。CLI及MCP真实stdio停止回执幂等，未新增模型或Run；两根都有本轮退出原件。
- Rust/Core/Harness、依赖及lock未改，运行物沿预算点，不重跑Cargo/deny。安装候选未更新。

主检查 `checked-r4.json` SHA `a9f35f21b379804c8841f128584598603e165745806623003d2293eec4d12c2a`。独立报告 `work/agent-model-owner-independent-review-20261104.md` SHA `1595148a97f51db3ddd24678657277cada5b1dc38a08a0f05abf6568ad6cf8a1`；接受本层，无确认遗留阻断，未接受Task恢复。主代理已完整读报告、核12链接及16bridge引用，`review-checked-r4.json` SHA `53ef786eff0d25b91f993c10127f3432273067dd4557c6e25064366f746dc7cf`。文档复核记录为 `work/agent-model-owner-doc-review-20261104.md` 及同名JSON；复核后生成最终来源/文档绑定 `work/agent-model-owner-20261104/checked-final.json`，不覆盖旧定稿。

R1生命周期漏洞与停止归因问题、R2附件keepalive失败、R3两份peer close快照缺口均保留旧原件。R4两个新根最终观察2/2、1/1，不回写旧快照。独立最终16记录PID于其检查时均不存在；所有测试句柄已收终态。

七文档162本地链接、22目标空白及根diff检查通过。根bootstrap退出1、371失败，比前点多137条，逐条核实均为前点documents-r6局部快照链接，本点活动文档0失败；检查发生在本点快照生成前。原日志及bootstrap-audit-r4.json保留，不称全仓已绿。humanizer缺失，文档人工审读。

## 下一步仍是完整原Task恢复

沿用 `work/agent-resume-design-r2-20261104.md` SHA `ed329dee5d45f441cb6b119a965674a6c3871e77113370eaf255fb34d3cdf452`，以及[前一交接](2026-11-04-agent-consumption-local.md)的完整恢复约束。先前第二步owner/停止基础层已有本地证据，其余不能据此省略。

1. 新agent.resume operation关联原root/previous execution，统一resolver区分权威root和本次execution；CAS单active generation。Ledger/outbox/认证沿本次execution，预算/Session/route沿root，旧unknown事件保留。
2. 把本层完整OwnerBinding及停止入口接入execution/generation resolver；旧回执不能用于新代，不能blanket放开unsettled。原root取消、同Session后续Task和重配须结合active attempt处理。
3. 固定原Task/Session、侧车镜像/工具、route、relay endpoint/token及原本地绝对deadline。原端口不能重绑则拒绝；新watchdog不延长root原deadline。
4. Harness锁内核完整ResumeReview/效果和模型集合，提交绑定本attempt的消费/效果receipt并持久准确回复后才能继续。缺observation全admission cap扣；actual/floor分开，receipt本身不授权执行。
5. 服务已预占但未native admitted的Run在证明无效果后复用原UUID/槽。admitted零模型Run仍占槽；接管后再崩溃与丢ACK不得重复扣。当前publish仍依赖reviews.length+1，须处理无review的崩溃Run。
6. 开放工具精确匹配原child收据，未知效果不得再次tool()。区分Node intent未HTTP预占、服务complete但缺本地transport与真正unknown；文本ResumeReceipt不能冒充typed图片恢复。
7. 实测硬中断→原Task继续执行，以及无admission、待prepare槽、重复崩溃、并发接管、原owner仍活、wrong fence、端口占用和deadline等拒绝矩阵。

R04/R05、安装、SYSTEM/SCM/锁屏/切用户、旧Desk历史、真实组织模型、跨机和部署仍开放。服务器暂停不妨碍这些本地恢复工作，不标Goal complete/paused/blocked。
