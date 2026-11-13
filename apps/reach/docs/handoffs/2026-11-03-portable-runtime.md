# 输出修复与便携桌面运行时接续

作者：Ray Zhang（Ray）。日期：2026-11-03。

全量目标仍为 `docs/task-checklist.md`，52 基础项和 5 可选项均保持开放。本轮有实际代码、候选及运行证据进展，不是全量交付。仓库仍为 ARA `dev`，保留已有 WIP；未提交或推送。不要套用 cwd Lumen 的分支或 TS-only 约定。

## 已完成的本执行点

输出收尾修复和新 Node-only 安装候选见[证据](../evidence/output-drain-20261102.md)与[独立复核](../evidence/output-drain-review-20261103.md)。新包为 `outputs/windows-node-5029a53f90e50384/Reach-Node-Setup-0.1.0-preview-bb7709390cdb14a8.exe`，包含图标和修复后的 5029a53f Node。未签名、未安装、不含桌面后端；不要再拿旧 9b721f7c 候选作为修复版，也不要重复索要同一次 UAC。

便携运行时 `work/portable-runtime-r1d/python` 已从固定官方 embed 与源码构建；详细来源、原始日志、失败与组合证据见[本轮记录](../evidence/portable-runtime-20261103.md)。3 种导入、6 次 DLL 核验、6 次 COM 恢复、真实只读中文路径和原生桌面 6 项通过。最后 r1g wrapper 完整退出 0；r1d/r1e 权限恢复失败和 r1f 控制标记比较失败仍保留，测试目录均恢复。helper 最新 debug SHA256 为 `6f6980acaae4aa431c783378964fcd605a0a5c87ef69c4042bf36b0aa6986560`，新增 -B 和每代 TEMP/TMP，Rust4/4、fmt/clippy 通过。

主机已于 11 月 3 日重启，旧 exec handles 均不存在；重启不是旧测试清理的证据。随后只读核实 Ray 当前仍为 `/opt/reach/releases/20261102-sso-stable-05d25e8c84eb`，reach/ray-front 均 active，TLS 正常的 `/reach/healthz` 返回 0.1.0-dev.1。Go SHA 保持 `3b21deba87a5df87b19942a7b9557ab842ff92147e5103125d1d4a2b45fe7bd9`。本轮图标、Node 和运行时均未部署线上。

## 紧接工作

1. 完成便携载荷原生依赖与许可闭合。两份补充许可已在 `desktop/runtime/notices/`，来源记录为 staged-not-yet-bundled；接入构建并生成新候选。dnspython 锁定 sdist 没有 LICENSE，固定 Git 归档才有。cryptography sdist 与 dnspython sdist 缓存在 `E:/usr/var/cache/reach/runtime-license-sources/`，都已核 uv.lock SHA。
2. CPython v3.14.7 tag 当前固定 `dccefbc14adf6cd13693f3b6b2802945c4e23e01`；继续从固定构建来源核实际原生组件。不要猜 libtommath 是否实际在 embed 中。候选的附带 Pythonwin/MAPI 模块尚有 mfc140u/msvcp140 包外依赖；本机已安装不代表干净机。VS 位于 `C:/Program Files/Microsoft Visual Studio/18/Community`，VC Redist 14.51.36231 中发现 x64 msvcp140，但尚未确认 MFC 的可再发行来源。不要直接把任意系统 DLL 当作已许可载荷。
3. 从最终载荷构建静态 helper，完成带内容摘要的版本目录、桌面配置、完整 installer/uninstaller、升级/回滚接线，随后再做真实 UAC/SCM/SYSTEM/WTS。现在 build.ps1 仍是 Node-only，不能把运行时目录存在视为已纳入安装器。
4. 继续完整文本 artifact、实际 Codex MCP 加载/看图、Lite/Harness 远端 Host、Reach Desk 云端对话及最终 Ray 部署。Reach Desk 已迁到 `platform/`，默认关闭、Ray 可选；不返回旧项目维护。

继续遵循一次一个 Cargo、固定锁不随意升级、失败证据保留、独立复核及主代理回查。现有用户部署授权有效；不得读取 OTP 种子或退出用户 Ray 登录。humanizer 本机检索仍未找到，文档由人工审读并保留准确未验证边界。
