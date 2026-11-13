# Reach 桌面 Host 开发候选

作者：Ray Zhang（Ray）。日期：2026-11-02。范围：D06/T05 的普通 Windows 交互用户链路。基线 `90f2b1c` 加未提交工作区，分支 `dev`。没有更改线上 Ray、注册服务、提升权限或更改机器 PATH。

这是基础 Reach 的现场桌面组件。Reach Desk 已由用户定名，是 platform/ 中的可选云端对话子项目；两者仍须接通同一 Reach 设备、操作及证据链路。

## 已实现范围

独立 Rust `desktop/` 通过原 `ara-agent-lite-mcp` 调用 Windows-MCP，复用 Core 的工具/图片类型，没有新增 Agent 循环。开发父进程先装 Windows Job，再转发 start；普通 helper 校验 SID、Session ID、logon LUID、WTSActive、WinSta0/Default，记录设备、边界、主屏、DPI 和显示方向。请求绑定 helperGeneration、sessionRef 与一次性 snapshotId；Screenshot 无标签，Snapshot 的标签直接来自后端动作查询使用的数组。

返回 PNG 经过完整解码检查，保留原字节并记录尺寸/哈希。失败捕获不产生可用快照。执行中监听停止、EOF 和会话/显示变化；工具错误后废弃本代后端。非捕获动作错误保守记 unknown，明确错误不压成成功，不推断已有效果被撤销。

父级最终收据 `desktop_host_exited` 只在终止外层 Job、查询 ActiveProcesses 为 0 并等 worker 退出后产生。Windows Shell broker 或已有外部应用不一定属于 Job，进程树已空不能代替外部效果核对。

## 固定来源和制品

- Windows-MCP：`94de2b4a5e1f2c52aad6003d5e60af28f57b8c8b` / 0.8.8，Reach 补丁版本 `0.8.8+reach.3`。补丁、uv.lock、上游 MIT 声明及可复现开发安装脚本均在 desktop/runtime/。
- Python：CPython 3.14.7。当前独立 venv 有 89 个 distribution；没有 fuzzywuzzy/python-Levenshtein/Levenshtein；certifi 使用 MPL-2.0，其他具体许可见 [metadata](desktop-runtime-licenses-final.json)。这不是完整离线发行包的许可验收。
- Rust：共享 Lite Core 0.1.1 / MCP 0.1.0 的当前源码；rpi 固定 `8ec462672d90e62712d96074638efef89436cebe`。没有修改共享库。
- 普通 debug binary SHA256：`6a27481ec9a5d77a78302f6ab02577bf3932ceee6826716d3abd3bf053aac7e5`；非发行安装包。
- 原始截图/工具帧/状态在忽略的 work/desktop-native-*；源码、运行时及产物绑定另见 [manifest](desktop-host-20261102.json)。

## 验证

最终同一普通 binary、runtime.3 的原生测试 **6/6 通过，0 skip，48.486 秒**，日志为 [desktop-native-final-v3.log](desktop-native-final-v3.log)。这 6 个测试函数包含真实交互、三种中断、捕获/参数失败及五类实际工具错误；不把函数数等同于任务完成数。本页不接受完整 D06/T05。

已执行的检查包括：普通 binary 经实际 Windows-MCP 操作独立 WinForms 窗口，中文输入和单次按钮点击由窗口自身状态文件独立核对；旧快照、错误 generation/logon 及 Screenshot 后标签请求被拒绝。开始写入标记后，分别停止、关闭父端 stdin 和杀掉 worker，核对 unknown/进程树退出与未发生延迟写入。文件写目录、删除不存在文件、Shell 部分写入后 exit 7、读取不存在注册表项、滚动方向不匹配均须保持错误/未知。

7 项运行时测试中，文件效果和依赖检查是真实调用；通知/注册表状态码和部分进程终止使用明确故障桩，不代表发出真实通知或终止其他应用。全新固定 SHA checkout 经 prepare.ps1 创建第二套独立 venv 后，这 7 项也通过。两套运行时的 80 个 Python 源文件在 CRLF 转 LF 后完全一致；其中 67 个原字节也一致，13 个因 Git 换行约定不同。manifest 保留各自原始哈希，不声称字节全同。

Rust 的 PNG 损坏/缺图及标签截断 2 项测试通过；fmt、Clippy 全目标全特性和 cargo-deny 的 advisories/bans/licenses/sources 通过。此 crate 只有 binary，无 library doctest。独立审查者 `/root/reach_plan_review` 接受本开发候选范围：直接核对 76 个源文件、80 个运行时文件、34 份执行日志和 71 个产物的哈希，以及最终截图、窗口状态、错误和中断收据，未发现新增确定阻断问题。随后追加的 2 份文档检查记录由主代理核对；不扩大为生产服务或完整 D06/T05 验收。

活动文档检查覆盖 36 个文件、240 条本地链接、57 个唯一任务 ID，无断链。`git diff --check -- apps/reach` 通过。全仓 bootstrap 仍失败：38 条既有 Reach 外断链，加 4 条忽略目录 work/windows-mcp-source 中调查用 README 副本的缺失链接；不将全仓检查报为通过。humanizer 先前未找到，本轮人工审读。结束时未发现 reach-desktop 或 windows_mcp 测试进程残留。

## 保留的失败与修复

1. 初次 cargo check 在线依赖拉取反复超时，主动停止；offline 检查缺 vte，后使用已存在本机代理取得依赖。没有把下载失败算编译通过。
2. native v1 未找到测试输入框：隐藏 PowerShell 的启动属性同时隐藏了测试 Form。截图证实未显示；显式 ShowWindow 后才进行输入/点击，未盲点其他应用。
3. native v3 的 EOF 用例失败：AsyncWrite shutdown 未关闭仍被借用的 ChildStdin，父级 5 秒期限后才强杀，丢失工具结算帧。改为移动所有权并 drop 管道后，v4 5/5 通过。
4. runtime.1/.2 的初次错误修正遗漏捕获分支及状态码。独立复核给出真实可达反例后，runtime.3 修正文件 catch、Registry/Shell、App、Notification、Process 和 Scroll，并新增独立效果负例。
5. Clippy 报告测试中不必要 clone，已修复；最终普通 binary 因源码变化产生新哈希，因此重跑相同原生组，未沿用旧 binary 的结果。cargo-deny 初次参数位置错误也保留日志，修正后实际通过。

## 未覆盖项

SYSTEM/WTS 启动和会话选择、双向认证 named pipe、Node 的账本/维护停止接线、服务上传图片分段、Controller 的 MCP image、锁屏/UAC/RDP/显示热切换、离线可分发包及完整许可证资源、真实安装/升级/卸载/干净机。仍不能从公网 Reach 或 Reach Desk 调用此桌面候选。旧 Node 安装候选未因此自动包含新的 helper/运行时；实际安装请求仍待用户结果。
