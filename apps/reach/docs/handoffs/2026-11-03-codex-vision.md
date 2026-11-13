# Codex 图片消费接续

作者：Ray Zhang（Ray）。日期：2026-11-03。

活跃目标仍为完整首版及 Ray 部署，基础0/52、Reach Desk0/5。E:/repos/ara 的 dev、HEAD90f2b1c，大量WIP保留；不套用Lumen规则。图标已完成，不重做；用户尚未报告UAC结果，不重复同次请求。本轮无生产代码、EXE、安装、提交/推送或线上变化。

[真实 Codex 图片证据](../evidence/codex-vision-20261103.md)已完成：r3 1/1通过38.809s；gpt-6.1-sol由Reach MCP取回原PNG，识别AMC7VYL、蓝三角/绿圆/红方。2次工具调用，原PNG SHA b97c1212b282e898d83d0b8138c1d0b0ada18f3ca2ba3f3902ef8322960c840d。只有describe和Screenshot，两端原截图事件6/6全部ACK。原件work/codex-vision-dd565079-c3b5-4062-b8f1-3f49c6531cdc。不是R07或完整C07/T06验收。

r1截到下层页面而失败，真实模型usage保留；r2仅画面准备超时，无模型；r3成功。两次模型总input125441/cached91136/output659，无硬token限制；限180s/6工具调用。无模型observer真实双进程边界1/1通过201.189ms；最终TS检查通过。当前79来源/41原件清单SHA feebd101e78256ca25d09d53a522343ff99d81fde15e7c6993ad4aeb0af11ab6，sourceIdentity93f300fce5723e19a6ed9c717fabc3a16be284ff60b1566e603cab9baab3fc44，见[清单](../evidence/codex-vision-inputs-20261103.json)。这是后验源码/mtime/行为对应，r3没有执行前源码冻结。74旧项及2EXE未变，native-fixture为唯一旧项漂移；新增4测试文件。快照work/codex-vision-source-5f03c1b0-a30c-422a-aa19-5fccdb998da5。服务数据库必须和828152bytes原WAL一起保存，已补入清单；不可仅保留4096bytes主库，未checkpoint原件。

独立复核仍为/root/reach_plan_review，见[报告](../evidence/codex-vision-review-20261103.md)；主代理已核图片、模型事件原字节、提示无答案及两端原事件。不再运行模型补元数据。当前无测试session/Cargo运行，普通Node/helper及测试画面已退出。

最终报告SHA434bbbd50b1dd955f1097bb062692c31af8a92490d4f21788d79583436f3e578，已由主代理完整回读并接受限定结论。最终7文档/108本地链接及79来源/2EXE/41原件核验全部通过，work/codex-vision-final-check.json；diff-check通过，历史全仓断链未重跑。

完整候选沿用[前轮交接](2026-11-03-error-artifacts.md)：outputs/windows-complete-1fab0ba3b8239354-93fe5dccdd7f/Reach-Setup-0.1.0-preview-60a6bfdfd7879528.exe，未签名未实际安装，不重打。

下一步推进Lite/Harness Host及Reach Desk。已只读发现现有 crates/ara-agent-lite-jsonl 与 clients/node/client.mjs 能直接复用Harness/原生Session、tool/verify/prepare/cancel和证据合同，可供TS云端Host调用，不必再写Agent循环。此方案尚未实现/冻结；需要核protocol-v1、实际模型路由和原生恢复合同，默认基础包不得引入Desk依赖。Ray仍为20261102-sso-stable-05d25e8c84eb，本轮未再读线上；部署前复核，不能重复执行旧删SSO会话的update-ray-service.py。一次一个Cargo，缓存E:/usr，work中间产物，outputs交付。
