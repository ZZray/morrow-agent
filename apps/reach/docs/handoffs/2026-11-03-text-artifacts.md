# 原始全文与管理页接续

作者：Ray Zhang（Ray）。日期：2026-11-03。

活跃目标仍为完整首版及 Ray 部署，基础 0/52、Reach Desk 0/5。分支 dev，大量 WIP 保留；本轮没有提交、推送、线上更新或真实安装。cwd 可能为 Lumen，不套用其分支/TS-only/自动推送规则。图标已完成并接入，不能重做；用户未报告 UAC 安装结果，不重复发同一次安装请求。

最新局部结果：[原始全文与管理页证据](../evidence/text-artifacts-20261103.md)。冻结来源 [69 项清单](../evidence/text-artifacts-inputs-20261103.json)，SHA `a8d27f6e688de21b5cb3445fef07ea4b48b40f5279b9a2ac6c6401a07a0d2db0`；source identity `289c29ebafc39375db265ade0b107bb29413cb27d336922585d31e92b14e75d7`。快照 `work/text-artifacts-source-9d181291-d2ba-4eab-b300-4fa4d9452c75`。独立复核继续复用 `/root/reach_plan_review`；其[最终报告](../evidence/text-artifacts-review-20261103.md)限定范围通过，SHA `45e35918168f4d77fcfe2794f30fab5f3af2036b41f12ea466a7aaa5ff537f4f`，主代理已完整回读及核对摘要。69/2/16冻结条目与本轮7份Markdown链接已再次检查一致；全仓bootstrap仍有历史及外部断链，未宣称通过。

新候选 `outputs/windows-complete-ba1ecd6da6c93150-93fe5dccdd7f/Reach-Setup-0.1.0-preview-45f2fc3b79528f41.exe`，SHA `45f2fc3b79528f41c0919af79a38aa9b261d4a6a01f88a12aebd4ab97ddca66d`。内嵌 ZIP `ba1ecd6da6c9315001eb6d61f0d14f301aca9405d4346fd95b71f19882c72516`，实际 WinPS5 私有校验 6,327 文件、201,828,703 字节通过；十档图标/版本核对通过。旧83a2固定点保留。仍未签名、未安装。Setup维护源未改，Node/helper换成本轮通过测试的普通dev profile程序。

实现：PNG v1保持；v2 text/plain、octet-stream清单及范围读取；4PNG+4非图/总16MiB。共享MCP adapter仅增保存成功全文的原bytes/SHA元数据，不含Reach业务状态。helper每代独占目录、同句柄路径/常规文件/bytes/SHA/scalar验证，恢复全文后先parse labels/errors再附件化；有保存路径时强制附件化第一正文。Node整组/终态体积预校验后才写outbox，含内容failed/unknown也核generation/session。CLI `artifacts`/`artifact --output NEW_FILE`/`artifact-range`；MCP增加`reach_artifact_range`。CLI拒覆盖，但写失败可能留部分新文件，尚非原子发布。

管理页新增纯浏览器模块 `src/admin/artifacts.ts`，经tsc产出`dist/admin/artifacts.js`，`service/admin.ts`已加白名单路由。当前是无bundler静态ESM，不可引入Node/Zod运行模块。详情里完整产物分段预览、下载前全SHA验证；流式UTF8保留BOM/CRLF/跨段字符。旧视图/退出后的响应不显示、不下载。不完整文案改“未完整收到”，不保证继续传输。已读应用emil-design-eng/ui-delight，沿用现有静态界面；Cua实际预览、下载、损坏、空文本、切页和退出验证见证据。

本轮验证：TS12/12，末次UI受影响7/7为子集；Node3/helper4/sharedMCP1；三个changed target clippy通过。真实桌面3/3（96.149s）与Node/Controller影响2/2（84.453s）通过。不能用旧r1代替r2。普通exe在`E:/usr/var/cache/rust-target/reach-static/x86_64-pc-windows-msvc/debug/`：Node SHA `83297d6d18aa4e0847d09dcfcc345ba2459188f1c347ac2d0f0c35dd9354c4b0`，helper SHA `cf03b5d14e55e613a2d2b2a1682a97b2bc492c59200155074b41573198e4a9b1`。固定Python `work/portable-runtime-r4/python/python.exe`。

真实链路目录 `work/desktop-chain-7ebeb16c-a851-4ea9-9e87-324b6b2e68fc`：原长正文378025bytes，经lostACK+双重启后CLI/MCP exact，effects once。浏览器目录 `work/text-browser-6ee0835e-5d51-4224-89a3-9e102e0249c2` 为合成回执UI夹具，实际下载93503bytes SHA `4cff3eabc4846b2de7e115c5db3ead4b56b558b11a99843389d2fd1c7d0be1b3`，截图preview.png。早期hold探针未正确隔离release标志，不算竞态成功；最终06:47:42Z、06:48:27Z核held后release，各仅offset0、无下载。主代理工具会话观察无浏览器trace，独立复核不得冒称重演。

下一步：长错误全文/实际file.read二进制/真实Codex模型看图；Lite/Harness云端Host与Reach Desk装配；真实UAC/SCM/SYSTEM/WTS、机器PATH、配对升级卸载重装干净机；最终Ray部署。上游MCP帧8MiB、helper/Node16MiB，不将产物通道容量当作端到端实测容量。T06尚不能整项勾选。

Ray已本轮只读复核：`ray-dev`，current仍`/opt/reach/releases/20261102-sso-stable-05d25e8c84eb`，Go SHA `3b21deba87a5df87b19942a7b9557ab842ff92147e5103125d1d4a2b45fe7bd9`，服务均active，Node/操作/事件1/2/10，active0。新服务/UI尚未上线。`deploy/update-ray-service.py`绑定旧SSO迁移前置并删旧SSO会话，不能直接重复使用；下一更新应保留现有Ray/Reach登录、密钥和账本，先准备新固定包与适用更新/恢复路径。

只运行一个Cargo；缓存E:/usr，中间产物work，交付outputs。所有本轮Cargo/native测试session已完成。浏览器夹具原exec session93632/PID26292已核身份后停止，18914/18915无监听；夹具数据和截图保留。humanizer此前未找到，文档人工审读。无相关memory用于本轮结论。
