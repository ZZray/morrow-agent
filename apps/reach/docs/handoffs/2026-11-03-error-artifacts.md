# 长错误证据接续

作者：Ray Zhang（Ray）。日期：2026-11-03。

活跃目标仍为完整首版及 Ray 部署，基础0/52、Reach Desk0/5。E:/repos/ara 的 dev，HEAD90f2b1c，大量WIP保留；不套用Lumen分支/TS-only/推送规则。没有提交、推送、线上更新或真实安装。现代化图标已完成并接入，不重做。用户未报告UAC结果，不重复同次安装请求。

本点[证据](../evidence/error-artifacts-20261103.md)与[75项输入清单](../evidence/error-artifacts-inputs-20261103.json)已写，清单SHA `ada0daa65b4f468712b61ae0fea68627ae416d2a247cf35a534863eaa22b625d`，sourceIdentity `4a5f22a08c64516b3b75f6f3317816294cd7d1d92ab72d796990f5710a43c21a`，快照 `work/error-artifacts-source-550775d6-2b2b-4077-867f-87eefd4531bf`。9项增量为MCP tool/lib、helper main/capture、result_props/stdio/desktop-chain/error-mcp.py四测试文件与共享README。

共享MCP的ToolCallEvidence绑定server/tool/callId，原execute仍Err；helper仅调用一次typed接口。错误长正文使用原bytes/SHA/scalar校验及outbox；isError截图failed、动作unknown，不能据全文完整改成功。复核发现的structuredContent及labels重复内联P2已修；错误不产生labels。归档的是合并错误正文，不是wire。调用ID关联不是重复调用幂等保证。

最终普通helper SHA `a679c452c8741fe3a83d3006bea1627aad6a520786d89142d190db4a05e657d1`，Node仍 `69b14cfebbff4dd63fe755bd870afe5d83e469fb25f5eb260a432c5dc4231727`，位置 E:/usr/var/cache/rust-target/reach-static/x86_64-pc-windows-msvc/debug。固定Python work/portable-runtime-r4/python/python.exe。新完整候选 `outputs/windows-complete-1fab0ba3b8239354-93fe5dccdd7f/Reach-Setup-0.1.0-preview-60a6bfdfd7879528.exe`；实际WinPS5校验6,327文件/201,904,479bytes，三个exe图标版本通过；未签名未安装。

最终桌面6/6、156.678s，目录 `work/desktop-chain-563b2029-7850-47bc-949a-800ae7a2ac78`。包括旧3组实际输入/点击/恢复以及长schema错误双重启、保存失败、受控大型structured/labels两模式。Windows-MCP PowerShell错误是schema拒绝，不代表已执行副作用后失败。MCP初轮26全过，修后15受影响项重跑；helper7、fmt2/clippy2、TS通过；doc0。主代理已直接核75/2/22摘要和四错误操作Node/服务原事件及下载字节。所有本轮Cargo/native session已完成，无reach/reach-desktop进程。

独立[最终报告](../evidence/error-artifacts-review-20261103.md)已限定通过，SHA `ec7db23875a8b89c7f4b1a795eca41cfe1b83f4711ed90c15825bffbcba22b3a`；主代理完整回读并回核，无剩余确认阻断。复核使用/root/reach_plan_review，后续继续复用，不另起重复审查。新增来源/报告均已固定。

下一步推进实际模型消费、Lite/Harness云端Host与Reach Desk装配，以及Ray更新。完整安装还需真实UAC/SCM/SYSTEM/WTS、PATH/配对/升级/卸载/干净机，不提前勾选。旧[文件交接](2026-11-03-file-artifacts.md)和[全文交接](2026-11-03-text-artifacts.md)保留原证据。

Ray在收尾只读核实，仍为20261102-sso-stable-05d25e8c84eb，Go SHA `3b21deba87a5df87b19942a7b9557ab842ff92147e5103125d1d4a2b45fe7bd9`；reach/ray-front均active，Node/操作/事件1/2/10、活动0。记录 work/ray-before-error-release-readonly-20261103.json。没有线上变更，部署前再核。deploy/update-ray-service.py绑定旧SSO迁移并删旧会话，不能直接执行；新更新须保留登录、密钥、原账本并准备适用回退。只运行一个Cargo，缓存E:/usr、中间产物work、交付outputs。7份改动文档107本地链接及diff-check通过；全仓bootstrap既有历史/外部断链仍未通过，日志work/error-bootstrap-doc-check.log。
