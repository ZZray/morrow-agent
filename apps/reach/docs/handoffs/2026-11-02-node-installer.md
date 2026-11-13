# 接续：Node 安装候选与 Reach 首版

作者：Ray Zhang（Ray）。日期：2026-11-02。目标仍是完整清单 52 项基础＋5 项 Reach Desk 选装，实现并部署到 Ray；本轮没有缩减目标，也没有改动线上。

仓库 `E:/repos/ara`、分支 `dev`、基线 `90f2b1c` 加未提交 WIP。保留所有工作；没有新提交或推送授权。Reach Desk 已定名、已迁入 `apps/reach/platform/`，默认不集成；真实云端 Host/设备接线和 Ray 启用尚未做。

本轮完成维护停止和 Windows Node 安装候选，具体[证据及边界](../evidence/node-installer-20261102.md)、[安装合同](../installation-update.md)。Node 使用静态 VC runtime 的 release 程序，候选 `outputs/windows-node-4e2f2786c67f886e/Reach-Node-Setup-0.1.0-preview-21142b4d8913879c.exe`；所有哈希以证据和 JSON 为准。未执行真实 UAC/SCM/SYSTEM 安装，未注册服务或写机器 PATH；当前 shell 非管理员。

最终候选同一 Node 的普通进程回归27/27、静态release单测2/2、setup静态release单测1/1、隔离安装事务15/15通过，全部进程和工具session已结束；无需继续等待本轮旧句柄。依赖审计、fmt/Clippy、内嵌三项哈希、静态运行库导入表及只读锚点预检均已记录。Reach活动文档33页/226链接通过，全仓38个既有外部断链仍在。

下一步在用户完成候选的系统 UAC 后，验证真实 Owner/DACL、RYReach SCM 运行和映像、普通用户 status/pair、PATH、新安装与升级前后身份、失败恢复及重新启动。维护 ACK 丢失不能继续切换；不能回滚数据库。完整 I01/I06 仍缺桌面后端、交互用户会话、卸载及干净机器验收，Node 候选不代替这些项目。

已向用户发出候选的实际安装/UAC操作请求，尚未收到完成回复；不能据时间流逝推断已安装或已批准新操作。独立复核已核对50输入、28日志、全部制品哈希及实际PE导入，接受开发候选范围。可在等待时继续桌面后端等不依赖安装的工作，不标记整个goal blocked。

等待期间按tool-environment技能检查了现有Python/uv，固定Windows-MCP来源的pyproject/README/LICENSE下载在忽略的`work/windows-mcp-source/`。确认该版本需Python >=3.14、包版本0.8.8、含posthog；本机默认Python3.12不满足，尚未安装新Python或桌面后端，未启动遥测或操作桌面。可复用环境和下载缓存须放E:/usr，任务材料仍放work/outputs。

继续 T05/D06 桌面后端、文件/日志与完整证据、真实 Codex MCP、Lite/Harness 委托以及 Reach Desk 接线。前台 host、测试注册表和事务函数桩不代表 SYSTEM/真实 SCM 通过。测试第一轮的大输出 unknown 原因未定，失败记录保留，后续通过不可抹去。

编译一次只运行一个 Cargo。最终 Node 目录 `E:/usr/var/cache/rust-target/reach-static/x86_64-pc-windows-msvc/release/`；setup 缓存 `E:/usr/var/cache/rust-target/reach-setup/`。打包入口 `packaging/windows/build.ps1` 要求已验证 Node 路径与完整 SHA，固定 target，核验内嵌三个哈希，收集149个 Cargo依赖许可及Rust运行时版权，拒绝额外 VC DLL。具体运行终态和仍在执行的句柄应以当前工具状态为准，不重复等历史 session。
