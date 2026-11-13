# Reach 本地接续：普通Node委托Host

作者：Ray Zhang（Ray）。日期：2026-11-04。

继续完整清单/原goal，上一轮为progress：真实Rust Node单Run文件/命令委托、relay和原账本已接通并做本地验证。基础仍0/52、Desk0/5。最新用户限制优先：**只本地，不SSH/服务器/远端模型，不部署/安装/提交/推送，不清理原WIP**。`E:/repos/ara`、dev、HEAD `90f2b1c`；不要套用Lumen分支或TS-only规则。不询问旧候选UAC，18912旧代理仍停。

权威[合同](../agent-delegation.md)、[本轮证据](../evidence/agent-node-20261104.md)。前阶段[模型broker交接](2026-11-04-agent-model-local.md)为历史点，不能在新源码上重跑旧冻结checker冒称仍匹配。共享Core/Harness/侧车代码未改，仍复用027镜像。

## 已实施及实际边界

新 `src/node/agent.rs`、`agent_relay.rs`，接入原runtime/ledger/api/protocol/main。默认无侧车配置不声明agent.delegate；配置镜像SHA及服务模型同时存在才声明。开发使用绝对REACH_AGENT_CONFIG，字段sidecar/sha256；包内查agent-runtime.json，安装候选尚未装配此运行时。

父原running ACK后才启动侧车；Task ID=父operation ID，初始Run另建UUID并与原dispatch一起保存。原JSONL arguments通过serde_json RawValue保留顺序/SHA，不启用全局preserve_order。每callback拿真实child Dispatch，原Ledger.accept/running后复用worker/Desktop，子终态先outbox并获ACK才回侧车。独立JSONL读循环在执行工具时仍能处理callback_cancel；watch覆盖父取消/截止时间、host stop、控制丢失及uploader退出，先收实际工具再收侧车Job。

relay专用流客户端不借12秒Api.call；Node身份只给broker，侧车env.clear后只拿本机token。chunked防止中断伪装EOF；DONE须等新增Node POST原request/status确认stream_complete/Run/body SHA并保存证明才释放。验证和成功重核完整模型集合。原服务deadline-serverNow减RTT换成本机单调剩余时间，不把两机时钟混用。

Node沿原事务累计child output/已知终态JSON字节32 MiB，超限仍可记小unknown；真实结果另保rejected-result，不返回空成功。>4 KiB结果保留原件/SHA并给4 KiB窗口，可继续file.read。已有resultRef文件逐字节核一致；图片从outbox重建并对消费proof，但**本轮未执行真实截图委托**。

Host Verified只验原件完整，父结果仍taskAccepted:false/awaiting_review。普通单Run已测；prepare/multi-Run、原Task恢复和组织模型unknown对账未完成，不开旧unknown父、不换Session绕过fence。服务默认不依赖Desk，LabSlot延期。

## 固定版本、原件与复核

冻结 `work/agent-node-20261104/inputs-r1.json` SHA `f759c75996c2c2d7fc99acf4b25892154d7a46c15379d2558a5774d47ef32fbf`：167身份源/副本、13语义目标、2镜像。Node `work/agent-node-20261104/runtime-r6/reach.exe` SHA `f3f92fae9e2827ead074de441a25a0f617c9bc7069f95240ac1b2eada6f1df9f`，侧车0275185不变。只加现有serde_json raw_value特性，Cargo.lock不变；旧69b Node是历史镜像，不声称继续匹配新源码。

- 最终 `work/agent-node-r4.log`9/9、131.200s；9函数10原件，13模型/7child/131原outbox事件。两文件3模型；180k大文件2模型；父ACK门闩；真Windows后代取消；finish后截断；上传409后停止并重启补原件不重放；预算边界；原结果冲突；正负六分钟时钟偏差。根路径均在日志，不再重跑这些已通过矩阵。
- 旧basic受影响 `agent-node-basic-regression-r1.log`3/3、24.882s，原件 `work/agent-node-20261104/regression/`；状态API `agent-node-model-status-r1.log`1/1、3.982s。
- Rust `agent-node-rust-tests-r1.log`10/10；Clippy r2全targets/Dwarnings、fmt、离线frozen cargo-deny通过；缓存advisory未联机刷新，不报在线最新审计。最终基础/admin/platform类型检查通过。r1/r2 native失败、Clippy r1和中间r3 7/7保留，不重复累计。

主代理 `work/agent-node-20261104/check.mjs`回查10场景实际SQLite、文件、原事件/模型proof/预算，`checked-r1.json` SHA `18e6772cd8abb706b1f9b0bd4246059ca8e82e58f5e47447cd7def49aeee6c9e`。

独立reviewer `/root/reach_plan_review`，最终 `work/agent-node-independent-review-20261104.md` SHA `1b126e2d62c927f26c036098b3e2859aa57b586498f5256a45c7472f445da6af`。固定r6独立重放两例关闭截断P1与resultRef冲突P2，原件 `work/agent-node-independent-final-9f2a06b6-f5ef-4e9b-bf41-266a9c012871`，review-final.json SHA `c98c597c804d367c287ed9878cc14318bad67b6dcde309ccf8630e64f248e805`。独立核12场景149 outbox/15intent/13完整transport，8个独立PID退出。主代理已完整回读报告并运行check-review.mjs回查原库。只接受所列普通Windows单Run文件/命令范围，不接受整个R01–R07。

全部本轮执行句柄已终态，无已知遗留Node/服务测试进程。humanizer未找到，人工审读；五文档110条本地链接、13目标源/配置/测试的空白及仓库根diff检查通过，结果在本轮work内，不冒称全仓绿。

## 下一步保持完整目标

1. 同一个真实Node委托完成desktop.describe及两次实际Screenshot，核每child独立artifact index、原SHA/像素、typed图到受控provider、Node原outbox和原生消费proof。先复用已有真实截图夹具/运行时，勿用服务seeded PNG代替；保留default32k旧失败，不以大上下文窄测宣称默认全过。
2. 补完整多Run prepare/目标反馈，以及同Task新恢复operation关联原fence、固定endpoint/token、原Run/剩余预算；原端口不能重绑则拒绝。模型status是只读证据接口，不是unknown恢复API。
3. 继续R04/R05来源、技能、经验晋升和旧Desk历史迁移；节点验证/安装runtime装配、SCM/SYSTEM/锁屏等仍开放。禁止把本轮普通进程配置当一键安装完成。
4. 真实组织模型、Ray服务器和部署等用户明确恢复远端访问后再做。原首版52项与Desk5项范围保留，不缩成仅文件/命令或仅Desk。
