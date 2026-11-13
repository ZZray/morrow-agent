# Reach 本地接续：Released 后只读收尾

作者：Ray Zhang（Ray）。日期：2026-11-04。

完整首版目标继续，仅本地开发测试。禁止服务器/SSH/远端模型、部署、安装、Git 同步/提交/推送和清理原 WIP。仓库 `E:/repos/ara`，dev，HEAD 90f2b1c；不要套用 Lumen 的分支或 TS-only 约定。基础0/52、Desk0/5，Goal active，LabSlot延期，Desk仍为可选扩展。

当前候选新增 schema10 和 Windows `agent.finalize`。原生 Released 后 Node 尚未保存终态的窗口已真实命中；持原 Session 锁的独立 inspector 核原件并发布不可变 seal，随后提交新的服务 execution。finalizer 没有模型/工具/Run权限，不替换原 source、Task、Session、deadline或消费。旧 owner 记录缺失明确拒绝。gen2 source 及旧模型 unknown 的准确原 receipt 路径已有成功证据。

完整范围、失败和原件见[本地证据](../evidence/agent-native-finalize-20261104.md)。本地九种NoFence场景、普通resume、19组最终服务回归及主代理原件回读通过；源码/已执行边界的[独立复核](../../work/agent-native-finalize-independent-review-r15-20261104.md)通过，三个P1入口关闭。共享JSONL依赖审计未通过，`deliveryAccepted=false`，不把本候选标为完整接受。

冻结 `work/agent-native-finalize-20261104/inputs-r15.json` SHA `4b490192ce87ef587560b95340d2e67a8692a161f91fad9933716c8d5a079364`，228份输入及副本。Node在runtime-r13，与r11实测字节相同，SHA af970efed24a…；inspector SHA d7b4182d74be…；原c5源侧车另核。安装包未更新，前点resume的checked-final.json保持不变。

封存后取消/解绑不再永久拒绝原outbox；仅准确原结果允许收据提交，不恢复效果权限。finalizer全部拒绝通用reconcile，避免failed对账覆盖原封存事件。主代理checked-primary-r15核9种原件、255原事件和110次引用摘要。广批91pass/1fail/6skip与修后19/19分开记录，不报一次全绿。

Reach本包离线deny通过；共享JSONL套根policy时git来源、webpki-roots1.0.10许可例外和path wildcard被拒。保持原lock和policy，不能擅自扩大豁免；这是后续发布前必须处理的真实缺口。

源码/已执行本地边界独立结论为LOCAL_SOURCE_AND_EXECUTED_SCOPE_REVIEWED__DELIVERY_ACCEPTANCE_OPEN。报告SHA `0de7500d90a92aa7c57122ae1846af90a418a249e2b57f1ff0b8343800d75b2d`；独立12根含复测、339事件、426次引用与主代理统计分开。最终封存为本点checked-final.json，不覆盖前点。

继续处理共享依赖发布门，再推进开放typed图片恢复、重复崩溃及完整拒绝矩阵和R04/R05、安装生命周期。NeedsChanges、全部seal边界崩溃排列和所有进程负例未完整验证，不能宣称完整R06。服务器访问及部署等待用户明确恢复。
