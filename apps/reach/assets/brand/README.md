# Reach 图标

作者：Ray Zhang（Ray）。日期：2026-11-02。

`reach.svg` 是可编辑源稿，用于 Reach 的 Windows 安装器、Node、桌面助手及管理页；Reach Desk 仍是可选云端扩展。

2026-11-24 按用户要求改为与 QBuild、Keel、Helm 同一套图块规格：白底圆角（rx 56/256）、浅竖向渐变、发丝描边，笔画扁平、平头端点。图形是字母 R：深蓝竖干代表本机控制端，蓝色字碗代表连接，绿色斜腿伸向右下，腿端的橙色方块代表被够到的远端设备。用色与 Keel、Helm 一致：蓝 `#2F6BDB`、绿 `#22AC38`、深蓝 `#1F3A6B`、橙 `#FF8D35`。旧版蓝紫图标的哈希仍保留在历史证据中，作为历史记录；安装包要重新构建后才会带上新图标。

在 Reach 目录执行 `bun run build:icons`，使用锁定的 resvg 2.6.2 生成透明 PNG 和 Windows ICO。ICO 包含 16、20、24、32、40、48、64、96、128、256 像素的 RGBA 图像；512 像素 PNG 用于预览。源稿没有字体或外部资源依赖。

三个 Rust 构建入口通过 `packaging/windows/resources.rs` 嵌入同一 ICO 与产品属性，不改变提权或运行行为。管理页通过明确的 `/assets/reach.svg` 路由读取同一源稿；部署时须携带 `assets/brand/reach.svg`，相对服务目录位置保持不变。

资源构建与运行证据见 [图标交付记录](../../docs/evidence/brand-icon-20261102.md)。
