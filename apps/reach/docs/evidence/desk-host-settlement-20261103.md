# Reach Desk Host 本地结算与原会话续聊

作者：Ray Zhang（Ray）。日期：2026-11-03。范围：Windows 本地 Reach HTTP、普通共享侧车、受控 loopback 模型与 Chrome。未访问服务器、调用远端模型、部署、安装、提交或推送。基础清单仍为 0/52，Desk 选装仍为 0/5。

## 本次实现

`platform/src/settlement.ts` 将实际侧车复制到状态目录的 SHA 缓存并复核；当前支持的 Session 工具配置对应普通 EXE SHA `2f858a77ba86bd8b201f7184b5afb7a10afc674ad8668cf49354c44174dc8353`。沿用八个 Core Session 工具，不增加本地执行工具、MCP、Goal 或设备工具。其他二进制仍可按原入口运行，但不能凭当前配置自动获得这一结算能力。

Host 在启动前保存锁内 baseline，结束后核真实 SDK join、原始请求、Task/Run admission、完整事件及其 observation SHA/数量/消费，再调用共享锁内检查。核对旧 Run index、原引用和记忆的全部变化，以及新增候选的正文、来源、状态和回执。失败提案按实际持久变化区分已保存、未保存或无法归属；无法归属继续阻挡。摘要及其候选按本 Run 的持久变化组记录，现有事件不足以给每个摘要候选分配单次模型调用来源。

原件引用直接进入声明的 `receipt.evidence/evidence_refs`，不只嵌在说明文件里。声明和固定二进制先落盘，Store 再写关闭意图与尝试次数。最多两次关闭，成功后以 Task/revision/declaration SHA 同事务释放会话。取消消息保持 cancelled、已有文字保留、Task 未被接受；关闭不会撤销已采纳记忆。管理命令的 Informational 结果走同一检查链，正常关闭后显示 completed 和原命令输出，`cancel_requested` 保持 0。

重启先读取已保存的成功 SDK operation。新增 `close.mjs:readCloseOperation` 校验旧声明、已退出进程记录、原始证据及完整关闭链；不启动进程、不检查新 Task 的原生状态、不补充次数。未保存成功收据、旧 unknown、未知工具效果、旧 cloud 迁移状态或缺少原生完成证明时继续 blocked。

## 验证及原件

本次覆盖 41 个不同测试函数：TS 后端 26、Chrome 7、SDK close 8。不是一次全仓运行，也不是全部在同一个最终测试文件 SHA 下重新执行。

| 证据 | 实际结果 | 覆盖和版本说明 |
|---|---|---|
| [backend-r1.log](../../work/desk-host-settlement-20261103/backend-r1.log) | 25/26；232.633s | 保留认证用例失败；其他 18 个非受影响函数沿用这次执行证据 |
| [backend-r2.log](../../work/desk-host-settlement-20261103/backend-r2.log) | 7/7；138.150s | 仅重跑修正夹具影响的候选、停止、摘要、认证、崩溃、关闭与重启；普通两轮流式函数从 r1 沿用，前后夹具均判定其普通请求为非等待 |
| [browser-r1.log](../../work/desk-host-settlement-20261103/browser-r1.log) | 7/7；161.206s | 其中六个无 wait 请求或无模型请求的函数沿用；页面/Host 生产源码此后未变 |
| [browser-r2.log](../../work/desk-host-settlement-20261103/browser-r2.log) | 1/1；47.453s | 重跑真实 submit/delta/停止/刷新/原 Session 续聊/窄屏/退出 |
| [SDK 工具输出转录](../../work/desk-host-settlement-20261103/sdk-close-tool-output.json) | 8/8；12.835s | 原 exec session 44713 的实际输出转录，明确不是原始 shell 日志；含成功 operation 恢复与更改/未退出证据拒绝 |

类型检查及 Web 构建 exit 0。Rust 源码和普通 EXE 本次未改，不重编 Cargo、不重跑上一交接的长矩阵。Node Host 已测；没有把上一轮 Bun SDK 探针当作本次 Bun Host 验证。

实际过程包括：

- 保存真实 memory_propose 候选、拒绝错误来源提案、读取引用和原生历史后取消；随后同一 Session 继续。候选保持未采用。另通过原生命令采纳记忆、修正引用，后续取消不回滚这些变化。
- 多轮原文触发真实 Core summary，保存摘要及未采用候选后取消；核对后原 Session 继续。
- 真实进程在第二次 close 已保存成功记录、数据库释放之前 `process.exit(37)`；重启使用原成功 operation 完成本地 CAS，次数仍为 2，再提交新 Task。该窗口是主动退出测试，不称为掉电。
- 原进程树被测试终止但无可靠关闭意图时，重启保持原 Task/Run 的 unknown 和 blocked，不重新提交。
- Chrome 验证同一次 Reach 登录、原生流在完成前可见、停止后续聊、刷新部分回答、断流 GET 恢复、迟到查询与旧版本事件、同版本矛盾、草稿及退出隔离。种子状态排序场景仍明确只证明页面/Store 顺序。

[只读原件核验清单](../../work/desk-host-settlement-20261103/checked-inputs.json) SHA `d4a47eb49f2b9bcf1b004e8a3e3624c7dd7042efef537156b0a30ffe7b234368`：25 个当前源码/构建输入、31 个成功或失败测试根、276 个直接声明原件引用、23 条 released 关闭链。所有列出的原件 SHA 和 request/prepared/committed/released 绑定匹配。31 个根和 23 条关闭链不是独立功能计数。[核验脚本](../../work/desk-host-settlement-20261103/check-evidence.mjs)只读测试证据，输出清单不写产品状态。

## 保留的失败与独立复核

初版两次文本取消测试已生成声明，但 Windows closure 目录没有使用与共享 canonical path 一致的形式，关闭拒绝、会话未被误释放。失败根为 `work/desk-cloud-8e52488f-b982-4b43-8369-ffeefb509ad0` 和 `work/desk-cloud-95c93273-7cc4-42d2-aaab-be81b2f27a28`；修正路径后通过。首次管理命令测试暴露 Informational 未接线，原件位于 `work/desk-cloud-6a2e1683-a5d3-4264-85b5-bd4f71bbea63`。一次后续断言错误要求修正来源后的投影仍显示旧候选 ID，改为核实际替代来源，失败根 `work/desk-cloud-1b00682b-c89d-4761-83c9-aca3d554eebc` 保留。

集中 r1 认证失败根 `work/desk-cloud-d13112ab-aa20-4ade-b006-566022844e93` 中，第一个请求实际为 wait expiry，但夹具取到末尾的 Core 预算提示，记录 waiting=false，回答提前完成。它不是 Host 把取消伪装为完成。修正两个受控模型夹具，排除已知的 Host context/budget 消息后读取当前原始用户消息；[r1 夹具源码](../../work/desk-host-settlement-20261103/backend-r1-fixture.ts)和失败原件保留。r2 的认证、停止和重启等待均重新执行通过。

独立 `/root/reach_plan_review` 按 ara-git-review 只读复核生产 Host、效果政策、Store/事件及 SDK 恢复依赖，另检查两个受影响夹具片段；不称为整个仓库审查。发现并修复 objective 引用修正误拒、第二次关闭后的数据库恢复遗漏，以及嵌套原件引用未直接绑定声明的问题；增加新候选 active source、唯一来源、cloud 状态及命令变化数量检查。其 [报告](../../work/desk-host-settlement-review-20261103.md)区分独立执行的 12 个重叠函数、隔离真实侧车的原件篡改拒绝、政策反例及主代理集中证据，不累计为额外功能数。主代理回读报告并直接复核原件清单。

文档已逐句检查事实、范围及本地链接；本机没有可用 humanizer skill，未声称运行该工具。

## 尚未交付

本次只完成受控本地会话结算连接。真实组织模型多轮、Ray 长流、云端设备工具与现场委托、旧平台完整能力及历史迁移、安装 UAC/SYSTEM/实际升级卸载、完整首版验收均未因此完成。服务器与安装候选未更新。按用户最新要求继续仅本地开发测试，等待明确恢复部署。
