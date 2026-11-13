# Reach 图标与 Windows 资源

作者：Ray Zhang（Ray）。日期：2026-11-02。来源：用户对 Node 安装候选提出“你好歹设计一个现代化的图标”。

本次增加蓝紫圆角几何 R 图标，保留透明边缘与可编辑 SVG。图标已接入 Node、桌面助手、安装器的构建入口，以及管理页品牌和 favicon。未执行 UAC 或实际安装，也未把本机管理页资源更新部署到 Ray；完整清单仍保持进行中。

## 源码与生成

- 源稿：[reach.svg](../../assets/brand/reach.svg)，无外部字体、图片或脚本。
- 生成器：[build-icons.ts](../../scripts/build-icons.ts)，`bun run build:icons`，固定 `@resvg/resvg-js@2.6.2`。
- [ICO](../../assets/brand/reach.ico) 共十档：16/20/24/32/40/48/64/96/128/256，RGBA PNG 帧；SHA256 `fe2ee6dfef2435aa8cc3a660c9c4abe263f30bf35522a1f27f4b902356cb5fda`。
- 共享 Windows 资源构建使用固定 `winresource 0.1.34`，无默认特性；只嵌入图标和产品属性，不设置 UAC manifest。非 Windows target 不调用资源编译器。
- Node/helper 的运行源码未因图标修改。管理页继续使用明确静态路由与已有 CSP。

## 已执行证据

- `bun run check`、`bun run build:admin` 通过。
- [管理页回归](brand-icon-admin-tests-final.log)：4/4，无 skip；包括 SVG 路由、类型及限制性响应头。
- [Node release 构建](brand-icon-node-build.log)：85 秒；静态 VC runtime。新二进制 SHA256 `9b721f7cb798ab25dfe12181985f0fd94a6beb8f596789547b3fab64360549e6`，启动 `--help` 成功。
- [安装器构建与 inspect](brand-icon-setup-build.log)：5.08 秒，内嵌 Node、安装脚本和 notices 的哈希校验通过；PE import 检查通过。
- [Node 图标提取](brand-icon-node-resources.json)、[安装器图标提取](brand-icon-setup-resources.json)：通过 Windows `LoadLibraryEx(DATAFILE | IMAGE_RESOURCE)` 只读提取资源，逐字节核对全部十档图标；同时验证产品名 Reach 和作者 Ray Zhang。
- [助手构建](brand-icon-helper-build.log)：179 秒；[助手图标提取](brand-icon-helper-resources.json)通过十档原字节及产品属性核对。三个 workspace 的 `cargo fmt --check` 通过。
- [静态 Node 全套回归](brand-icon-node-native.log)：26/27，272.058 秒，无 skip；大于 2 MiB 输出分页用例得到 `unknown / descendant_kept_output_open`，因此未通过。安装候选不能据此标成完整回归通过。
- [该失败项独立复测](brand-icon-node-large-output-recheck.log)：0/1，84.809 秒，相同失败；未通过调整期望或重跑掩盖。

新安装候选位于 `outputs/windows-node-9b721f7cb798ab25/Reach-Node-Setup-0.1.0-preview-007487edce0403cb.exe`。旧 `windows-node-4e2f2786c67f886e` 候选保留。新候选仍是 Node-only，不含桌面 Python 运行时；包上的 `desktopBundled=false`、`installationTested=false`、`codeSigned=false` 均保留。

## 验收边界

图标是原生 SVG 源稿及确定性栅格转换，不是由图片模型生成。主代理与独立复核 `/root/reach_plan_review` 均查看了 512 像素图。独立复核直接解析三个 PE，确认 30/30 图标帧原字节一致，三个旧新 EXE 均无 RT_MANIFEST；安装器运行源码、安装脚本与前轮清单覆盖的 70 个 Rust 运行源码文件均未改。复核接受品牌资源接入，明确不接受失败的大输出回归或真实安装。

锁文件调整过程中误用 `cargo generate-lockfile` 触发 Node 依赖重新解析，随后按旧候选依赖清单恢复全部 Windows 可达 name/version。helper/setup 去掉新增 winresource 后与原 lock 哈希完全相同；Node lock 与原文件仍有差异，不能声称原锁逐字节恢复。该差异及非 Windows 构建状态须在后续打包前继续核对。
