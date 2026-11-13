# Reach 桌面开发候选交接

作者：Ray Zhang（Ray）。日期：2026-11-02。继续当前 active 目标，不把开发候选当作完整清单交付；全部 57 个任务 ID 保持原范围。

用户已确认 Reach Desk；源码在 platform/ 维护，默认不启用，Ray 可选。基础 Ray 443 和 SSO 本轮未改变。最新桌面代码位于 desktop/，证据见 [desktop-host](../evidence/desktop-host-20261102.md)。保留父仓 dev 的全部 WIP，不提交或推送。

当前普通二进制为 E:/usr/var/cache/rust-target/reach-desktop/debug/reach-desktop.exe；运行时为 E:/usr/opt/python/reach-desktop-94de2b4-reach3/Scripts/python.exe。固定后端 source 仍在 E:/usr/var/cache/reach/windows-mcp-94de2b4-reach1，当前内部版本为 0.8.8+reach.3；目录后缀不是版本证据。独立 recipe 复现位于 windows-mcp-94de2b4-recipe 和 reach-desktop-94de2b4-recipe。原始 pristine source 94de2b4 保持干净。

先读最终证据/manifest，不重做旧 Node 安装候选。下一工作包：让普通 Node host 通过固定 desktop supervisor 调用，沿原操作 ID、账本和 outbox 保存文本/图片 manifest 与原始分段；控制端核对尺寸/哈希并输出真实 MCP image。之后补生产 WTS/CreateProcessAsUser、认证 pipe 和会话专属 Job，在维护停止 ACK 前停止空闲 helper。不要把开发 stdin 或隐藏 worker 参数当认证边界。

Windows 安装候选仍是 [此前交接](2026-11-02-node-installer.md) 的 21142b4d…；本机未发现 RYReach 服务，未收到用户完成 UAC 的回复。等待安装状态期间可继续独立接线，不重复请求许可。最终发行需按包含 helper/Python/依赖的 package manifest 摘要定版本目录，不能只按旧 Node SHA 覆盖版本内容。
