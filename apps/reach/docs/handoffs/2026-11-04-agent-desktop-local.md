# Reach 本地接续：Node委托实际截图

作者：Ray Zhang（Ray）。日期：2026-11-04。

本轮完成同一真实Node委托的desktop.describe与两次Screenshot，以及32K配置、非空原Session新Task接续、消费后篡改拒绝。见[证据](../evidence/agent-desktop-20261104.md)、[当前合同](../agent-delegation.md)。基础仍0/52、Desk0/5；完整首版没有完成。

继续遵守用户“先本地测试先不部署”：不SSH/访问服务器、不探测远端模型、不部署/安装/提交/推送，不清理原WIP。服务器备案期间，本地工作不依赖它。仓库为`E:/repos/ara`、dev、HEAD90f2b1c加既有WIP，不套用Lumen分支与TS-only规则。旧18912代理已停，安装候选未更新，不重复询问旧UAC。

## 当前版本与实际验证

- `src/node/agent.rs`按contextWindow/32分配256–4096字节的UTF-8结果预览，完整原件保留；非空Session的完整历史证明与当前Run证明分开核对，原范围/callback/图片校验保留。共享Core/Harness/provider没有在本点改变。
- 新Node：`work/agent-desktop-20261104/runtime-r2/reach.exe`，SHA `230ce49def22fc7e5670e9080e0240f996eec14f7cd89739f50c802ae657e46c`；侧车继续0275185原镜像。不覆盖旧Task或旧close intent的固定运行时。
- 快照`work/agent-desktop-20261104/inputs-r1.json` SHA `b522f03cb3072dca89e4577c4dc85bfa4425d4ad1c41784d36a751524248f6dc`：168源/副本、4镜像，相比前点只有agent.rs修改及截图测试新增；vision-fixture原SHA未变。
- 最终`work/agent-desktop-r3.log`4/4，121.682秒；受影响普通文件流程2/2，31.112秒；当前Rust10/10、fmt/clippy、基础/admin类型通过。依赖身份未变，沿用前点离线deny证据，不报本轮重新审计。
- 主`check.mjs`核4场景/12child/16当前模型/175原事件/12typed图片块，`checked-r1.json` SHA `0ab9b7f78b99a86a97402d781a8cafeaad0b0ecf5194797a8aab470baf8eab7b`。两图是真实可见隔离窗口的PNG，模型端点为本机受控脚本，未证明视觉理解。新Task沿原Session成功，不等于原Task恢复已实现。
- 消费后篡改第二PNG时父unknown、原fence保留、三个child成功收据和原图上传不改、零重拍；helper/窗口和测试进程已退出。前三场景父awaiting_review、taskAccepted:false，不替业务目标自动验收。

旧32K超文字预算、非空Session证明误比、开发配置和一次中间编译失败均保留原日志。不要重跑无变化大矩阵；后续变更按受影响路径验证，不把新运行覆盖到历史冻结清单。

## 下一步

1. 完成多Run prepare及目标反馈，沿用Core/Harness，不复制循环；父/子/Run模型预算按原Task累计。
2. 为原Task恢复建立明确恢复operation、原fence与Run关联，保留镜像/工具/endpoint/token/剩余预算和绝对deadline。端口不能重绑时拒绝，不换Session绕过，不重新打开旧unknown父。
3. 完成R04/R05的技能版本、来源与作用域、临时上下文和候选经验的审核晋升，以及旧Reach Desk历史/能力迁移。默认基础包仍不加载Desk，LabSlot延期。
4. 安装runtime装配、真实UAC/SCM/SYSTEM/锁屏/切用户/干净机/升级卸载仍开放；真实组织模型、跨物理机和Ray部署等待用户恢复远端访问。

独立复核`/root/reach_plan_review`接受所声明本地执行点，无未关闭阻断；`work/agent-desktop-independent-review-20261104.md` SHA `2668f1b5aba680d0e68075e71840abbb93cba4f4720059554623a8309630a001`。独立逐条核原native journal及range/full，只额外执行一次公共只读inspectSession；29个不同PID全退出。主代理已完整回读报告并回查原件。最终来源清单为`work/agent-desktop-20261104/checked-final.json`，不包含引用它的文档本身哈希。

6文档136条本地链接、4目标空白及根diff检查通过；humanizer未安装，人工审读。未完成项不因本地分项通过而勾选。所有本轮exec句柄已终态，没有已知遗留Node/侧车/helper测试进程；篡改例保留的fence不是活进程。
