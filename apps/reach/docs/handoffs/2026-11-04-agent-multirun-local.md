# Reach 本地接续：调用方反馈与原Task多Run

作者：Ray Zhang（Ray）。日期：2026-11-04。

本轮完成普通Node同Task/Session的调用方反馈、CLI/MCP读写原候选、NeedsChanges→prepare→下一Run、预算未完成结算及取消/截止时间。见[合同](../agent-delegation.md)、[证据](../evidence/agent-multirun-20261104.md)。完整基础仍0/52、Desk0/5，原Task恢复尚未实现。

继续完整首版目标，但仍只做本地开发测试：禁止服务器/SSH/远端模型、部署、安装、提交、推送，不清理原WIP。仓库`E:/repos/ara`、dev、HEAD90f2b1c；不套用Lumen分支或TS-only规则。安装候选未更新，不询问旧UAC；默认包不依赖Desk，LabSlot延期。

## 当前固定版本

- 最终Node `work/agent-multirun-20261104/runtime-r4/reach.exe` SHA `f32434dbb5ed4e5ebe119893627d0a32cbc9ce2f4fead4cb246762b33cc64dd1`，侧车仍0275185原镜像。共享Core/Harness/JSONL/provider与依赖版本本点未改。
- 快照`work/agent-multirun-20261104/inputs-r2.json` SHA `441abbe167314b5313d7e6d11bd357962e0764ecd5544fb3090949a15b180443`，172源/副本、16语义目标、4镜像。r1仅两个测试前置不同，原件保留，不覆盖旧清单。
- schema4新增`agent_run_reviews`。maxRuns默认1行为保留，显式>1每轮候选等待调用方continue+反馈或return_result，原deadline继续计时。不是权限审批，返回仍taskAccepted:false。
- Node先持久候选、再发布；决定及原文/SHA/verify_reply先落盘；prepare核完整原依据、累计预算及原deadline，先预占Run与切relay，再发送。planned reply不是已发送证明。已发布Run拒绝新模型/child，重复原child可取证。
- 等反馈后及prepare前重核原图/事件/模型。预算已结算但未完成为failed/BudgetExhausted/Released；真实unknown保留fence。不要把二者混成一条恢复路径。

## 已执行

实际Node最终r4为5/5、107.764秒；两项真实desktop为2/2、127.812秒。Rust10/10、fmt/clippy与最终类型通过。五文件服务首批41函数40通过/1epoch夹具失败；修正后review文件5/5，其他36沿未变证据，不报一次全量41/41。原MCP/密码/20秒前置及一次Rust编译失败全部保留。

主`check.mjs`回查5组：6Task、3child、11模型、7review、9Run预占、113outbox全ACK；`checked-r2.json` SHA `76c03aadbef992aab2edce3a6f442fafb400b555774e0bc6e96ea54c298d48fe`。多Run每例started-inputs记录实际启动源与镜像，旧normal-r2没有补造身份。

独立复核确认的两个缺陷（等待反馈时PNG漏检、发布Run新增效果）均已修复，接受本点有界本地范围，无未关闭确认阻断。最终报告`work/agent-multirun-independent-review-20261104.md` SHA `c401ed0dbc7a496809bc1f745b6c57860e8ec599d837399b1602333695ff0277`：七组实际场景共8Task/19模型/196outbox/4PNG，另核五服务夹具及6模型；38个原进程退出，未重跑矩阵。主代理已完整回读并核10份独立审计引用及原件摘要，保存`review-checked-r2.json`。

6文档142链接、16目标空白与根diff检查通过，最终来源清单`work/agent-multirun-20261104/checked-final.json`。不要把旧失败或当前fence当作仍在运行的进程；检查PID时也须考虑Windows复用。

## 下一步保持完整目标

1. 先补同Task跨Run图片消费的完整正例；当前两Run正例为文件/文本，等待反馈时图片篡改负例没有进入第二Run。随后实现原Task显式恢复，先处理首次固定per-Run cap。Harness在缺observation的崩溃窗口会按原admission额度保守扣减，不能按服务只见1次模型就退款。闭合预算停止续接需接公共verify_budget/prepare_budget，不能伪装普通候选。
2. 新恢复operation只承载本次执行，旧unknown原件不改；Task/Session/root预算、镜像、工具、endpoint/token和原绝对deadline保留。模型/child/32MiB累计到root Task，不因新attempt重置；原端口不能重绑就拒绝，不换Session绕过fence。
3. 模型unknown仍没有显式结算API，不能靠父reconcile假清零。原生开放工具的ResumeReceipt只有文本output，恢复截图时不能宣称typed图已补回模型；需保守核原图片取回链。
4. 继续R04/R05来源/技能/经验晋升、旧Desk历史及安装runtime装配。SYSTEM/SCM/锁屏/切用户/干净机/升级卸载、真实组织模型、跨机和Ray上线仍开放；远端操作等用户明确恢复。

不要重跑无变化的大矩阵。后续修改按受影响路径验证，旧失败和旧镜像保留；humanizer缺失，文档人工审读。全部本轮exec测试句柄已终态，没有把fence或数据库running字段当作进程仍活着的证明。
