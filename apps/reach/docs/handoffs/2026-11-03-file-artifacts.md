# 文件范围产物接续

作者：Ray Zhang（Ray）。日期：2026-11-03。

活跃目标仍为完整首版及 Ray 部署，基础 0/52、Reach Desk 0/5。仓库 E:/repos/ara，分支 dev，HEAD 90f2b1c，大量 WIP 保留。没有提交、推送、线上更新或真实安装。现代化图标已完成并接入；用户未报告 UAC 结果，不重做图标或重复同次安装请求。

本点[实际文件证据](../evidence/file-artifacts-20261103.md)与[独立限定报告](../evidence/file-artifacts-review-20261103.md)已写。最终[71项来源清单](../evidence/file-artifacts-inputs-20261103-r2.json) SHA `937f737448022d545e56b1b999d59cb7521c57f41dc790cdf1b6dfcd8340e56c`；sourceIdentity `624346f1cd36be2adc920567f5fda219278d3ca5dde553b9511785349d060c00`。独立报告 SHA `f95173e6676a5f9576aa8cee5e3b8c5ba6a403df6f8cee024d5ec202d24227df`，主代理完整回读并回核。r1清单保留旧claim缺口，不作为最终版本。

新候选 `outputs/windows-complete-a409468ed8848393-93fe5dccdd7f/Reach-Setup-0.1.0-preview-04e4505e8316b0ca.exe`。实际内嵌校验 6,327文件/201,868,639bytes，图标和版本通过；未签名、未安装。Node SHA `69b14cfebbff4dd63fe755bd870afe5d83e469fb25f5eb260a432c5dc4231727`；helper仍为 `cf03b5d14e55e613a2d2b2a1682a97b2bc492c59200155074b41573198e4a9b1`。二者位于 E:/usr/var/cache/rust-target/reach-static/x86_64-pc-windows-msvc/debug。固定 Python 为 work/portable-runtime-r4/python/python.exe。后续helper变动不能借用此候选的执行结论。

实际file.read已输出octet-stream范围产物，旧1MiB inline保留。新resultFormat/expectedFileVersion可选无默认，submit和claim均检查扩展能力；claim在事务内重读当前epoch能力，旧Node跳过不兼容排队请求。Windows同句柄捕获、前后元数据守卫，含ChangeTime；版本不是全文件SHA。file.capture先于manifest/chunks/complete/terminal入outbox。4个不同native场景覆盖源删除恢复、连续范围/改写/替换/空文件、终态入账失败和第二块失败；最终claim后重跑其中2项，不额外计数。全部Cargo/native session已退出。

下一步：共享MCP按callId提供长isError原文证据，helper恢复全文但保留failed/unknown；随后真实模型消费、Lite/Harness Host与Reach Desk装配、Ray部署。完整安装验收仍等待用户实际UAC结果。当前长错误实现若在工作区已出现，是后续执行点WIP，须单独构建验证与固定。

上一[全文/管理页交接](2026-11-03-text-artifacts.md)保留真实浏览器与原正文证据；对应夹具进程和临时tab均已关闭。不要重复Cargo或全套测试。Ray上一只读固定点仍为20261102-sso-stable-05d25e8c84eb，本轮未变更线上，部署前重新核对。deploy/update-ray-service.py绑定旧SSO迁移并删除旧会话，不能直接重复执行；新更新必须保留当前登录、密钥和账本。
