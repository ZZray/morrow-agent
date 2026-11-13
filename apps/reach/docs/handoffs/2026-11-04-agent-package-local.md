# Reach 本地接续：完整候选已带 Agent

作者：Ray Zhang（Ray）。日期：2026-11-04。

完整首版目标继续；用户最新要求仍是先本地测试，不部署。没有服务器/SSH/远端模型、安装、Git同步/提交/推送或清理原WIP。仓库 `E:/repos/ara`，dev，HEAD 90f2b1c。基础0/52、Desk0/5、Goal active，LabSlot延期、Desk可选。

已实现新的payload-manifest schema2完整候选，包含新版Node、桌面helper/Python、JSONL Agent及包内相对配置。安装记录schema2、journal schema4、Node账本schema1没有变化。新Setup、ZIP/已装校验与Node加载绑定同一Agent SHA；配置丢失或镜像损坏不能在声明必带Agent的包中退回基础能力。旧schema1仅保留历史兼容。

最新候选：

`outputs/windows-complete-117a183476413d54-b9740de53fe3/Reach-Setup-0.1.0-preview-b916f8872cab131b.exe`

Setup SHA `b916f8872cab131baf029c4eaa34e4aeba33f85a2ec84ac9a11786924c930d1d`；ZIP SHA `117a183476413d54c2de5e97ded9c14578e0b59089e628e4f8ae4d52a73e101d`。6329文件，222390804展开字节。Node5e9837e5…，Agent d7b4182d…，helper0ea7c0b2…。未签名、未安装，不要启动UAC或部署来代替本地边界验证。

前点JSONL deny失败是套用了Full policy。本点固定使用各独立workspace既有策略，4/4审计通过，另核rpi三包精确0.3.23/8ec固定rev及commit；没有改policy、锁或新增豁免。原Full-policy失败日志仍保留。262项Rust原许可、rpi根NOTICE、CDLA全文及既有Python/桌面声明实际进入候选。

本地证据见[Agent完整候选](../evidence/agent-package-20261104.md)：WinPS5.1包合同21/21，旧安装编排22/22（SCM/ACL/Node适配），新Agent升级归属1/1，来源门7/7，Node15/15、Setup2/2及类型/fmt/clippy通过。实际解包清除所有REACH开发覆盖，从包外cwd自动发现侧车，真实2个受控模型请求和1次文件工具、原outbox、进程join及服务重启；5种坏目录拒绝，6/6通过。候选R2/R3 ZIP字节相同，最终Setup另验6329文件，桥接已单列。

冻结 `work/agent-dependencies-20261104/inputs-r3.json` SHA `b9067bddd3d8c3882f7ae54771b0221a63e46e9832dbce50d40ff9c309cbaa8b`，266源/副本。主代理 `checked-primary-r3.json` SHA `037c5b057ea979ca94ae87619e162020f662825bd1f37e15d3a8cc251ed4e9ce`，已回读全部6329文件、4审计、262许可（468原文+10补充）和6个smoke根/20原事件。

[独立复核](../../work/agent-package-independent-review-r3-20261104.md)接受本地候选点，13份实现/测试语义及14份支持文件覆盖，无confirmed finding。报告SHA `9e778c1dbe2d2038f23ae212627ef4f5935a5f19aabcff90a197d6eaf3d964f1`，JSON SHA `f0e5bae04b8aca238d3c3848bf7228bb5adc681f1b33528046208e94e1128432`。独立也实际执行最终Setup的inspect/verify-payload并回读原件；不与主代理统计相加。最终封存在本点checked-final.json，前点封存及旧失败保留。

下一步继续R04/R05、开放typed图片恢复与完整R06、真实Windows安装/升级/卸载及干净机验收。当前包内Agent测试使用匹配的本地服务代码；线上旧服务未升级，不据此宣称线上Agent可用。服务器和真实组织模型的验证等待用户明确恢复。
