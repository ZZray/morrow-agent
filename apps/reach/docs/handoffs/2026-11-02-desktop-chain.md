# Reach 桌面链路交接

作者：Ray Zhang（Ray）。日期：2026-11-02。

用户命名已确定为 Reach Desk：`platform/` 内的可选云端对话子项目，默认不集成，Ray可选装。普通 `desktop/` 是基础Reach的现场桌面能力，不是另一个Desk产品。

本次完成普通用户开发 Node 的持续helper、原图outbox、服务分块校验和Controller MCP image。固定实现、8项实际桌面测试、受影响回归及保留的失败见[证据](../evidence/desktop-chain-20261102.md)。源码/运行时/产物哈希见[manifest](../evidence/desktop-chain-20261102.json)。未提交、推送或部署；所有原WIP保留。

下一步先补生产 SYSTEM/WTS 与双向认证管道，使同一个持续helper合同在安装服务中成立；不能让SYSTEM直接使用开发stdin。随后补完整文本artifact、离线打包、真实安装和界面/模型消费证据，再完成Reach Desk的云端Host和Reach设备适配。不要再复制Agent循环，继续复用ARA Lite/Harness/MCP。

Node：`E:\usr\var\cache\rust-target\reach-node\debug\reach.exe`。Desktop：`E:\usr\var\cache\rust-target\reach-desktop\debug\reach-desktop.exe`。Python继续使用 `E:\usr\opt\python\reach-desktop-94de2b4-reach3\Scripts\python.exe`，不能换回旧补丁venv。开发接线参数见[desktop README](../../desktop/README.md)，运行时配置和测试凭据留在被忽略的work目录。安装候选仍是之前的Node-only版，未包含本次helper；下一制品须按完整组件manifest生成版本目录。

测试已退出，无当前Node/desktop/Python测试进程。既有安装候选的UAC回复尚未收到，不代点、不重复问。线上地址仍为 `https://118.25.103.226/reach/`，本次未重新核实或变更服务状态。

独立最终复核由 `/root/reach_plan_review` 完成：622/622固定项匹配，无缺失或哈希漂移；直接查看最终PNG、取消/crash/维护停止及失败截图证据，接受本次普通用户开发链路增量。主代理另行复验同一622项并查看最终图像。D06/T05/T06、生产WTS、安装、全文产物、模型看图和Reach Desk仍未整体验收。
