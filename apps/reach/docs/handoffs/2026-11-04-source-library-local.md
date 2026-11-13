# Reach 本地接续：跨任务资料闭环

作者：Ray Zhang（Ray）。日期：2026-11-04。

用户最新限制仍是仅本地，不访问服务器/SSH/远端模型，不部署、安装或Git同步/提交/推送。`E:/repos/ara`，dev，HEAD90f2b1c加保留WIP。Goal active，基础0/52、Desk0/5；LabSlot延期，Desk可选。

[本地资料闭环](../evidence/source-library-20261104.md)已跑通：A真实留证→候选→新Session B实际验证→外部Controller明确采用→服务重启→新Session C复用→撤销后新提交和排队claim阻挡。一次成功不自动采用，Core的Session candidates没有同步。只设备owner/Node/epoch范围，不从cwd推断项目。候选全文/requirements/范围/出处共同绑定版本；临时上下文仅留原Task审计，资料出处只存头和SHA。详细API见[唯一合同](../source-library.md)。

普通gen1在执行前协商新完结协议，原native Released/回调结束/正常join后从原文件发证明，服务与原终态同事务保存marker。旧schema成功或普通reconcile不能伪造验证资格。HTTP故障后的原Released沿只读finalize完成；资料库分别核finalProof/finalizationProof，原unknown不重开。新Node接真实旧service正常完成，不调用不存在的新API。

修复了finalizer将业务收据path/hash当内部原件的问题：先核Ledger/service/callback/full-result，再只从内存引用视图剥业务正文；保留原文、resultRef和typed图校验。失败child沿原合同没有typed图，不为收尾新造PNG；开放typed图片恢复仍拒绝，不当作本点已完成。

最终普通Node `work/agent-library-20261104/runtime-r7/reach.exe` SHA3350f831917f5da3d67c6c69796cfcbf19b7afa8f3fd449089b53fe8e413a2e4；JSONL仍d7b4182d…。schema11，owner协议仍10。Node22/22、来源/迁移7/7、最终服务101通过/6既有输入skip、本地三种资料流程/大结果、真实旧服务和gen2收尾回归通过；准确日志/输入和边界见证据，测试重叠不相加。早期失败全部保留。

独立设计/实现挑战已修复，[最终独立复核](../../work/agent-library-independent-review-20261104.md)接受 `ACCEPTED_LOCAL_R05_POINT`：27个冻结源/副本、运行时和日志全部回读，0 confirmed finding；报告SHA `5e894b9b772f71b5992309e4b805d50571a33ea08225ee6ec4b821d0eeb76ecb`，JSON SHA `b9c74d1d6f008d6b7fcab420426b8c0aef25924f0656afe43935b828cba30e68`，readback SHA `7c765984b576c4640c670000af60f9136078beec9136fb13fd5658adaba6bbe5`。未把完整R05或首版勾选。现有安装包仍在[旧完整包交接](2026-11-04-agent-package-local.md)所列路径，没有包含本点Node；不要据此安装、部署或改服务器。

下一步继续R06：typed图片恢复合同已在 Core/JSONL 本地分项通过，需用真实桌面截图、Node强杀、服务重启、原件删除/篡改完成端到端故障矩阵。随后再做完整首版剩余工具、管理/产品与安装验收。最终R05源码/报告/原件/文档摘要保存在 `work/agent-library-20261104/`；旧R04与安装点的冻结副本不改写。
