# Reach Desk 本地接续：原图传递与大图恢复

作者：Ray Zhang（Ray）。日期：2026-11-04。

当前仍只做本地开发测试；禁止SSH、服务器读取、远端模型探测和部署，等待用户明确恢复。完整goal保持active；基础0/52、Desk0/5。仓库为`E:/repos/ara`、分支dev、HEAD90f2b1c加既有WIP。不提交、推送、安装或清理，不套用Lumen分支/TS-only规则。不重复询问UAC；安装候选60a6和Node未更新。18912是此前已停旧代理。

本轮[证据](../evidence/desk-images-20261104.md)补足共享JSONL与Desk的typed PNG传递、独立图像字节预算、普通候选原生证明，以及大图摘要/停止/归档后原Session续聊。原设备operation账本唯一；PNG与operation由测试夹具入账，本轮没有实际Node/desktop截图或真正组织视觉模型。不要称为已完成X03/R07。

## 当前实现与镜像

- 新`platform/src/device-images.ts`及`reach_image`工具：原账户/target/epoch/operation/complete manifest→原分段/全文摘要→原Task evidence中的完整PNG→公共typed image。损坏、不完整、取消和16MiB本轮预算拒绝不重拍、不取消原成功操作。
- JSONL `ToolReply.images`严格可选，旧文本四字段保留；仅成功Settled允许非空PNG引用。Rust验证同一已读字节、绝对路径及规范化范围、大小/尺寸/CRC/完整解码/APNG拒绝，然后生成真正ImageContent。Node与Python SDK接受新字段；Python只核了语法，没有新增其图片端到端证据。
- Core `image_bytes.rs`只从已类型化图片中分离传输字节，不给文本/工具参数中的类似JSON额外预算。活动编码24MiB，原生record/checkpoint24/32MiB但文字4/8MiB硬限制保留。同Run原图累计16MiB。旧图超过1MiB编码时，新Run先摘要，durable成功后立刻归档实际原生旧前缀；rpi/Store保留原窗口索引，runtimeState用previous_raw_count换算。
- `redact_message`保留typed图片数据和MIME；普通文字及工具参数继续脱敏。测试token`iVBOR`不改原PNG。普通候选proof在已有Harness锁内从native读取并绑定完整basis，Desk核全部原回调及原图；不能在verify里另抢inspectSession锁。
- `session-capacity.ts`在admit前预留容量：新/旧历史1GiB/64MiB，分别预留128/16MiB；最多14000 entries、96000 raw_count，头最大4MiB。超量为明确4xx，零新Task/零阻挡，前端保留输入；不另造Session。

当前普通侧车SHA `0275185113786a971fad17307c4cefcd0de4d2c0666bcb857d9cc20b2e26a344`，来自默认本地调试构建（本轮RUSTFLAGS为空，不是重发安装包）。不可变副本：`work/desk-images-20261104/runtime-final/ara-agent-lite-jsonl.exe`。原图片候选26d9和旧文本2f858分别保存在runtime-r2、runtime-baseline；Host支持它们各自原Task的关闭。不要将新SHA直接覆盖旧close intent。新工具8个，2f858旧profile仍7个；默认loopback文字路由不变，视觉测试显式`developmentImageInput=true`。

## 冻结与验证

最终`work/desk-images-20261104/inputs-r3.json` SHA `95daaf0402d4f616024dc05cebba52795e428da16d51b7c0b4c39f064228afc4`，129源/副本、三个固定镜像。r1/r2快照保留。r2→r3的12文件差异为Rust格式/推导/测试from_ref、容量余量、Host/settlement识别最终SHA并保留26d9；分层日志不冒称全部在最新源码重新运行。

最终大图`image-r4.log`1/1，87.584秒，根`work/desk-image-e156b098-59a1-4fa9-abd4-b89a2d7cff68`：双6MiB原图、第三图预算拒绝、正常原生证明、两次真实传图摘要、取消close、同Session归档后再工具。8请求中的6个图片块匹配原PNG，三个Task completed/cancelled/completed，原账本始终1个seeded operation。前一26d9 `image-r3`同函数1/1(88.726s)，不重复计数。

其余：Core受影响60函数通过（context34、agent12、journal8、caps4、image1、Job1）；JSONL最终lib16/16；SDK8/8；Desk策略11/11；最终容量1/1；新bin云端8/8；旧2f858二次关闭重启恢复1/1（与云端函数重叠）。类型/Web构建、Core及JSONL fmt/clippy、离线deny检查通过。不要据此写整Core全量绿：原批252pass/3fail/1ignored(342.25s)保留，两个新合同断言修改后按组复测；Job原源码/预算串行复测通过，不推断首次失败根因。

独立`/root/reach_plan_review`最终报告为`work/desk-images-independent-review-20261104.md`，SHA `14b5b199674affbb54c0554f85d9abae57806baf3764b5456f5d0eb4ea3eed6e`，范围内没有剩余确认阻断缺陷。已回查129源/副本、三个镜像、最终6个实际图片块/18引用、旧镜像恢复，并通过两个真实Windows文件锁中断探针（摘要durable/native前、journal提交/checkpoint替换前）：原Task保持ReconciliationRequired/fence/pending，compact0、原图工具各一次，公开inspection不改原件。主代理完整回读报告，再运行`work/desk-images-20261104/check.mjs`，核129源/副本、3镜像、8请求/6图、3Task、1op、5回执、34稳定引用及两窗口。

7份相关文档的新增链接存在；Core README有一条HEAD已存在的0.2.10历史断链。全仓bootstrap仍报告234项断链，包含node_modules、忽略work与旧归档，未把全仓检查报为通过。humanizer缺失，已人工审读。所有本轮exec测试句柄均已终态，未留下运行中的侧车；不能因保留fence就误判测试进程仍活跃。

最终原件清单`work/desk-images-20261104/checked-inputs.json` SHA `78e2064ef1bcd226ef06d4589b4e54cda7d0f08ac0de340f055030256e1dec5f`。该清单不把引用它的文档再纳入哈希，避免循环证明。

## 下一步

1. 本点报告、最终清单和主代理回查已经收尾，直接继续后续工作，不重跑无变化的大矩阵。
2. 使用既有普通用户desktop/Node链路，验证真实截图→原Reach产物→Desk→typed模型请求，并补Desk图片来源/预览。受控端点与实际视觉理解分别报告；用户未恢复远端模型，不能为验证而探测公网。
3. 继续R01–R07现场Agent委托、任务/技能与来源传递、恢复；不复制Core，不将云Agent单次Node工具当作现场Agent完成。
4. 旧平台历史/完整能力迁移、组织模型、跨物理机器、SYSTEM/锁屏/UAC/升级卸载及Ray部署仍开放。安装60a6不因本轮侧车开发而自动更新。

此前[设备文本/文件交接](2026-11-04-desk-devices-local.md)及原快照保留；旧`checked-inputs-r2.json`引用的缓存普通EXE已在新点重建，原SHA仍有各Task pinned runtime及本轮runtime-baseline副本，不能覆盖旧清单伪造“当前全部匹配”。
