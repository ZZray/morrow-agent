# Reach 图标

作者：Ray Zhang（Ray）。日期：2026-11-02。

`reach.svg` 是可编辑源稿。蓝紫圆角底和开放式 R 用于 Reach 的 Windows 安装器、Node、桌面助手及管理页；Reach Desk 仍是可选云端扩展。

在 Reach 目录执行 `bun run build:icons`，使用锁定的 resvg 2.6.2 生成透明 PNG 和 Windows ICO。ICO 包含 16、20、24、32、40、48、64、96、128、256 像素的 RGBA 图像；512 像素 PNG 用于预览。源稿没有字体或外部资源依赖。

三个 Rust 构建入口通过 `packaging/windows/resources.rs` 嵌入同一 ICO 与产品属性，不改变提权或运行行为。管理页通过明确的 `/assets/reach.svg` 路由读取同一源稿；部署时须携带 `assets/brand/reach.svg`，相对服务目录位置保持不变。

资源构建与运行证据见 [图标交付记录](../../docs/evidence/brand-icon-20261102.md)。
