# Reach 本地接续：原 Task 已能原生续跑

作者：Ray Zhang（Ray）。日期：2026-11-04。

继续完整首版目标，仅本地开发测试。禁止服务器/SSH/远端模型、部署、安装、Git 同步/提交/推送及清理原 WIP。仓库 E:/repos/ara，dev，HEAD 90f2b1c；不套用 Lumen 分支或 TS-only 规则。Goal 保持 active，基础 0/52、Desk 0/5，默认包不依赖 Desk，LabSlot 延期。

本点已接 schema9 与实际 Node `start_task.resume`。恢复先提交 immutable receipt，再核新 fence/resume/admission 授权本代效果；pending 到原生 Released、sidecar/Job 结算及最终事件同事务提交才清除。Run 注册和 admitted owner 分开；未知原模型逐请求解释，不退款、不重发；旧 root、旧 task.json 与历史原件保留，attempt 写独立目录。Node 现在声明 agent.resume，旧“未声明”的交接是历史状态。

见[证据及所有边界](../evidence/agent-native-resume-20261104.md)。十种真实恢复和 inspect/预算共 16 项通过；R6 新跑 happy 包含真实服务重启。模型只是受控 loopback SSE。schema9 服务 10 项、流中止/消歧两组、Rust 12 项及类型/clippy/离线 deny 通过。R4 的 69 pass/2 fail/5 skip 与修后记录分别保留，不能说全部检查一次全绿。

冻结 `work/agent-native-resume-20261104/inputs-r6.json` SHA：
`3bfef69159a6e8c3f847a92846ab257f0f85bea42bea5c85eef1487ac49c4c09`。
193 源/副本；R5→R6 五文件差异明确，Rust/Node/侧车不变。Node SHA `2d58319577fc4c2fe57c3fb31fca206e8d23eee643dc61d2f34221a4abf3b464`，侧车仍 c5b47f…；在 runtime-r5，安装包未更新。

下一步先补原生 Released、Node 最终事件尚未保存时的**只读 finalization**。已有最终 outbox 丢 ACK 可以精确重传，但 NoFence 且没有最终事件时仍明确拒绝、保留 pending。不能启动新的 native Run 来绕过。

随后补无首 admission、takeover 后 admission 前、待 prepare、重复崩溃和完整拒绝矩阵；开放 typed 图片工具保持拒绝，需共享合同与真实图片恢复证据后才放开。原始 deadline、cap、endpoint/token、模型/工具/镜像与 Session 不改变。继续 R04/R05、安装生命周期和实际产品验收；不标完整 R06 或 Goal complete。

独立[限定复核报告](../../work/agent-native-resume-independent-review-r6-20261104.md)已通过，SHA `352a2574b1d3ab9d72a781e834564a4a7b69ecebf1ef0fe00c18da3a12216b62`，16 语义目标无未关闭确认缺陷，不接受完整 R06。主代理完整回读，另核 11 根的 302 个原事件、25 个实际模型、13 个 child、38 次逻辑消费与 48 个直接进程退出记录；checked-r6.json SHA `24e0f1652aa08cd4b811a5834ef588c57cd2bcd1fa31b14a123ab2f0491b0f75`。最终封存写本点 checked-final.json，不覆盖前点。

六活动文档链接/空白检查通过，root bootstrap 原样执行仍为815失败，本点活动文档0；humanizer缺失，人工审读。测试句柄均已终态，未留下本点运行中的测试。安装包未更新，服务器未访问。
