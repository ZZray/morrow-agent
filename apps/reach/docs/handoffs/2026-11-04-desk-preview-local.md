# Reach Desk 本地接续：真实截图与原图查看

作者：Ray Zhang（Ray）。日期：2026-11-04。

先遵守本地限制：禁止 SSH、服务器读取、远端模型探测及部署，等待用户明确恢复。仓库 `E:/repos/ara`、分支 dev、HEAD `90f2b1c` 加既有 WIP。不提交、推送、安装或清理；不套用 Lumen 分支/TS-only 规则。完整 goal 保持 active，基础 **0/52**、Desk **0/5**；不重复询问 UAC，旧代理 18912 已停，安装候选仍为上一轮 60a6。

本点[证据](../evidence/desk-image-preview-20261104.md)补实际受控窗口截图→Node 原 outbox/服务账本→Desk 缓存→共享侧车 typed image→受控 provider 请求→Chrome 预览/下载，同字节。与[上一点](2026-11-04-desk-images-local.md)的 seeded PNG 分开。最终 5 provider 请求、4 工具、2 operation（describe+一次 Screenshot），没有真实视觉模型理解或现场 Agent 委托证据。

新增原图来源投影、认证 PNG GET、`device_image` 持久事件和按需预览/下载。取图按账户/turn/call/proof/原 operation/manifest 校验；不依赖当前配对，不受同消息另一 unknown 调用阻挡。浏览器校验长度/SHA/尺寸，卡片失效时取消并回收 URL。已修复摘要期间超时错过取消，以及 390px 下 workspace 隐式列被撑宽的问题。

最终源码冻结：`work/desk-preview-20261104/inputs-r3.json`，SHA `1bc57d7deb1d841a5bca499caf41ab42f8e0dc9cee6ea85f88aa1294eb311ed6`，143 源及副本、7 镜像。r1/r2 保留；r3补静态资源和 tsconfig，之前的清单不冒称包含它们。

侧车沿用 `027518…a344`，固定副本仍在 `work/desk-images-20261104/runtime-final/`；Node `69b14c…1727`、release helper `0ea7c0…eea2`、portable-runtime-r4 Python。没有 Rust 或依赖变更、没有重建安装包。旧 26d9/2f858 原 Task 继续用各自镜像，不能改旧 close intent。

最终 `work/desk-desktop-image-r8.log` 1/1、38.737s，根 `work/desk-desktop-image-96d69628-0abd-423c-9fe6-9425f7f63363`。PNG 9145 字节、656×359、SHA `2bae7a5601ab673c12f2cfd5f8839119cf293ad3e65bc948bd00a9f5f2e47ca2`。Node/账本/缓存/provider/download 相等，三颜色像素通过；哈希/解码确定性超时、body/hash/decode 切会话、迟到401、新登录、390px 和原件重试均通过。最终 Node/Form 正常退出，helper21240已核退出，未留运行服务。

API `desk-image-preview-r4.log` 3/3、13.194s；device/default7/7、浏览器旧组8/8分别在上下文参数与最终窄屏修复之前，具体版本桥接见证据页，不声称全部在最后源码重跑。最终 Web 生成和 TS 类型通过。既有独立 reviewer `/root/reach_plan_review` 已接受这个限定本地执行点：报告 `work/desk-preview-independent-review-20261104.md` SHA `2988c57eb6340a2d2a5884b41e1e259a8a470b47ec010d2c9eadfc2cc4b41e81`；主代理已完整回读并核正任务标识，再次运行原件checker。最终 `work/desk-preview-20261104/checked-final.json` SHA `19c5213edfd5d3e6dc644c81be7e3b0e85a6c4abd49e7169d54a253e46e7837a`。6文档110本地链接通过，bootstrap仍234既有断链；humanizer缺失，人工审读。

保留失败：前台焦点拒绝、过短等待、默认32768文字预算不足、本地连接复用方向的 transport error、首次窄屏修复不足。最终夹具显式声明 developmentContextWindow=131072（仅loopback、默认32768不变、routeHash绑定，max_tokens及图片硬限额不变）；provider显式Connection:close，无重试。生产catalog、32k完整桌面流程、HTTP连接复用根因都未因此验收。不要为了转绿重跑/改写旧 operation/Task/fence。

下一步先在本机隔离loopback夹具中定位空闲连接复用后的发送失败，可用有界工具延迟而不反复打开桌面；不要修改或重拍旧Task。然后从完整清单继续 R01–R07 现场 Agent 委托、任务/技能和来源传递、恢复，以及旧平台历史与完整能力迁移；组织视觉模型和部署须等用户恢复远端访问。默认 Reach 继续独立，不加载 Desk；LabSlot 仍延期。按主代理和独立复核的最终原件清单接续，不重跑无变化的大矩阵。本轮8个隔离流程的22个已知PID已补核均不在，相关exec均终态。
