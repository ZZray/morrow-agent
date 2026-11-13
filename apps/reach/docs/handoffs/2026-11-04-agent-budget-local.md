# Reach 本地接续：跨 Run 原图与闭合预算

作者：Ray Zhang（Ray）。日期：2026-11-04。

本点补齐[同 Task 跨 Run 实图](../evidence/agent-cross-run-images-20261104.md)，实现[固定单 Run cap 与原生预算复核/prepare](../evidence/agent-budget-20261104.md)。完整基础仍0/52、Desk0/5；原 Task 崩溃恢复、安装及上线尚未完成。合同见[现场委托](../agent-delegation.md)，不把局部分项或成功 Run 当作业务 Task 接受。

继续原首版目标，但只做本地开发测试：不访问服务器/SSH/远端模型，不部署、安装、提交、推送或清理原 WIP。仓库 `E:/repos/ara`、dev、HEAD `90f2b1cdd138129e2d331d89a37d70852e849739`；不套用环境 cwd Lumen 的 TS-only、分支及提交规则。默认包不依赖 Desk，LabSlot 延期；安装候选未更新，不再询问旧 UAC。

## 当前固定版本

- 最终 R3 `work/agent-budget-20261104/inputs-r3.json` SHA `b332c4ebacc0d42eebcf0110bb7e9641b852cd7f3a64f4e4f40457e91a8601d2`，175 源/副本、19 语义目标、4 runtime。R1 为schema4六组原生场景，R2为schema5 guard和两组smoke，R3仅拆测试入口；不得补称全矩阵在v5重跑。
- 新 Node `work/agent-budget-20261104/runtime-r1/reach.exe` SHA `65e2f635ffb5152a9a0ee9c5203fa626c38b8658f7b652a7f785ee34ba029f0e`，同目录侧车 SHA `c5b47fea1ab97745d93f7918b8c6ec2f6e246cc122201a25fab2e76a4ee5101f`。desktop/Python未变。Node静态CRT，侧车RUSTFLAGS为空，未并发Cargo。
- runCallLimit可选且不超过maxCalls，缺省保留旧行为；Task总额与每Run预占同时限制，不退款。显式cap启用原生闭合预算snapshot；与普通Candidate严格二选一，public subjectKind=closed_budget，last_candidate=null。
- Node已接verify_budget/prepare_budget；图片证明在原Session锁内生成并由Node SDK传给预算回调。Python只容忍新增字段，未自动提供或校验预算图片proof。
- schema5是持久语义升级，不是新增列。旧v4服务必须拒绝v5，新服务拒绝future6；保留旧操作、模型、事件及review。

## 已执行与独立复核

普通跨Run实图旧镜像两组2/2、74.292秒；131072/32768各两图，同Task/Session，provider图数[0,0,1,1,2]。旧Node f324/侧车027不可当作新镜像证据。

新镜像预算首批4/4、63.337秒；v5两项2/2、28.110秒（一个重测、一个新增取消）；两组实图2/2、65.163秒，图数[0,0,1,2]，第二Run第3次请求才消费首图。默认无cap的CLI/MCP多Run另1/1、52.019秒。服务最终4/4、迁移4/4、定向旧服务/模型/review回归6/6；Rust Node10/10、JSONL16/16、fmt/Clippy和最终类型通过。

SDK实际新侧车预算图片回调1/1、6.297秒，图片为生成的1×1 PNG，不是截图。SDK回归首批11pass/1 timeout-cancelled，原8秒timeout不改、独跑取消函数通过3.328秒；不是一次12/12全绿。图片首批0/2是provider测试分支把两图误断言为一图，修测试后通过；原日志/原件保留。历史服务测试的隐式work依赖已拆成显式 `REACH_PREVIOUS_SERVICE_MODULE` 探针，需绝对路径和旧SHA；默认skip，本机显式启用后4/4零skip，不声称历史制品已随干净仓库提供。

主check回查8组：8Task/12Run/202outbox全ACK/16模型/13child/8预算review；checked-r3.json SHA `fc7880084b45bfc81428760ee9fd8a01bc0f04d2927cbe886f7b1ee5055cf368`。独立另核默认回归1Task/2Run/37事件/4模型/2child；42原PID在独立检查时均退出。

独立复核者 `/root/reach_plan_review` 接受有界本地范围，无未关闭确认产品阻断。预算报告 `work/agent-budget-independent-review-20261104.md` SHA `eb02e267f095017a5ae9a3e72634244774db6083177714d783f5815fd973368b`；普通跨Run图片报告SHA `d7a1a269c6e6bdcc08d41965ed30841f83cec179a305c9d48eed463af33b7239`。主代理已完整回读并核22份审计引用与关键原件，保存 `review-checked-r3.json`。最终来源/文档检查清单为同目录 `checked-final.json`。

八文档159本地链接、19目标空白及根diff检查通过。另按知识维护流程跑根 `scripts/verify_bootstrap.py`，234条失败、退出1，均为这八文档之外的临时路径/旧源码/归档等链接；原日志 `work/agent-budget-20261104/bootstrap-r3.log`。全仓文档门禁没有通过，勿扩写为全仓已绿。

复核接续时误fetch，origin/dev现在9a65b79、领先本地7提交，均为ssh-tunnel/Starferry工作。没有merge/pull或改本地分支和产品源；不要现在同步或覆盖冻结。该偏离已向用户说明。

## 下一点：原 Task 显式恢复

设计 `work/agent-resume-budget-design-review-20261104.md` SHA `6807f654a920f751ec8c4c4a32290ed147cadc545506c664726914f30a55a9cc` 仅前半部cap/预算接线已落地，后半部不能标完成。

1. 复用Harness/JSONL的resume_checked/reconcile，不改shared Core业务循环。缺observation时，按原admission.remaining_calls全额扣；服务须持久保守charge floor，实际模型计数和逻辑扣减分开，不能退款。
2. 新恢复operation承载本次执行；旧unknown原事件不改。Task/root预算、Session、工具/镜像、endpoint/token和绝对deadline保持原值；原端口不能重绑就拒绝。模型/child/32MiB累计到root，不因attempt重置。
3. 模型unknown没有显式结算API，父reconcile不能清掉它。当前publish的runNumber===reviews.length+1会错误拒绝无review的崩溃Run之后恢复，应基于原admission/resume关联，不能补造review。
4. 已预占nextRun但未发送prepare时，恢复不能再吃一个Run槽。原ResumeReceipt的开放工具settlement仅文本output，typed图片恢复需另核，不假定图片已重新进入模型。
5. R04/R05、旧Desk历史、安装runtime装配仍待做；SCM/SYSTEM/锁屏/切用户、干净机升级卸载、真实组织模型、跨机和Ray部署保持开放，远端操作须等用户明确恢复。

全部已启动测试句柄已收终态，包括6900的v5两项及9367的迁移四项；不重跑无变化矩阵。不要覆盖旧镜像、Task/close intent或失败日志。humanizer缺失，文档人工审读。Goal保持active，不将本点通过当作完整首版完成。
