# Reach 跨平台下载与 Gitee 整包更新

作者 Ray Zhang（Ray）。2026-11-27。来源为 Codex 会话 `01a21c34-06ca-77b2-8972-20db91913656`。

2026-11-28 补充：下文保留当时的 Gitee 方案和测试结果。用户随后决定由 Worker 向绑定的 Reach 站点查询更新；nmrkit 使用 OSS，Ray 使用本站文件。[当前更新合同](../installation-update.md#site-worker-update)

## 现象与原因

用户看到下载页只有 Windows，并要求本次一并实现完整 Worker + Agent 自动更新，最终确认使用 Gitee 的 `rzjw/morrow-agent`。发布标签 `reach-v0.1.9-preview` 对应 `87af0a7b`，已发布的 Worker + Agent 是 Windows EXE。GitHub/Gitee 的旧更新链路只能更新 Node-only 安装。

Unix 已有前台 `ryreach`、配对、心跳、命令和文件操作。缺口在原生打包和下载页。更新器、Setup 和安装事务分别限制了旧自动更新版本，整包在三个入口都需要接通。

## 改动和验证

|范围|结果|
|---|---|
|便携 Worker|在 WSL Linux x64 构建并校验 0.1.9 归档。用解压出来的 `ryreach` 在本地测试服务配对、上线、执行命令、写入和读回文件。第一次冒烟检查在配对完成后过早读取能力，改为等待真实能力报告后通过。四平台工作流通过 `actionlint` 检查。|
|下载页|Chromium 以 1360 px 浅色、390 px 深色打开下载页，在同一发行清单中核对 macOS、Linux、旧 Windows 和历史链接。HTTP 管理与发行测试 8 项通过。|
|Windows 更新器|Gitee 版 `ryreach` Debug 构建和 `cargo-test` 退出码均为 0。单测覆盖来源、稳定标签、签名、提交和包类型。 [QBuild 记录](http://127.0.0.1:38420/#task/642c5bcd6f6d48aab9c2c75001f79e88)|
|安装事务|Windows PowerShell 5.1 的两项自动更新用例通过。生产安装流程真实操作隔离文件、锁和 HKCU，SCM、ACL 和 Node 使用适配桩。测试确认失败恢复旧版，随后可替换 Worker 与 Agent，同时保留绑定主体和账本。|
|Windows 测试签名包|本地构建 0.1.10 Setup。Setup 核对 5 项内嵌文件，签名脚本输出 schema 2 清单，使用一次性 Ed25519 密钥验签。向 Setup 传入错误 Agent 摘要时拒绝。该包用于验证打包和验签。|

已安装的 0.1.9 预览版需先手动安装带 Gitee 更新器和公钥的新包，再验证后续整包自动升级。实际 Gitee 发行、Windows LocalSystem 服务升级、macOS 和 Linux ARM64 原生验证均待完成。网页安装包的 OSS 分发方向已有[产品记录](product-decisions.md#installer-download-oss-20261127)。本次新增的自动更新源规则只适用于 Windows Worker + Agent。

后续范围见[交付目标](../task-checklist.md#desktop-delivery-goals-20261127)和[安装更新合同](../installation-update.md#site-worker-update)。Linux x64 本地归档 SHA-256 为 `4296deb9fb54dd71a68c51adbc51f4c86fb3d7add7547b463e10ad6e1262b6c1`。无可比耗时基线。

## 2026-11-28 便携包权限与覆盖修复

上述 Linux x64 归档的 156 个目录和 275 个普通文件在 TAR 头中均为 `0777`，包括不应对所有用户可写的 Worker 和许可证文件。打包脚本现将目录和根目录 `ryreach` 写为 `0755`，其余普通文件写为 `0644`。归档和 `.sha256` 使用输出目录中的临时文件创建，目标已存在时拒绝覆盖；第二个链接创建失败时，只撤回本次创建的归档。进程被强制中断仍可能留下单独的归档，重试不会覆盖该残留文件。

使用旧归档实际内容重新打包后，逐文件摘要、156 个目录及 275 个文件均一致，新归档的权限和校验文件通过核对。Linux x64 原生 Python 打包测试 8 项通过，包含真实悬空符号链接；Windows 本机同样运行了 8 项，其中两个真实符号链接子项因创建权限不足跳过。Linux 上另以模拟可执行文件验证了解包和运行：首次夹具的脚本换行转义错误导致运行失败，修正夹具后通过。这项检查不代表新 Worker 在设备上运行通过。

四平台工作流增加归档权限检查和原生 Worker 测试。独立复核了四个矩阵的脚本语法，并确认权限检查拒绝旧归档、接受正确的对照样本。macOS 两种架构和 Linux ARM64 的原生构建、运行及发行仍待实际工作流回执；此次验证没有发布便携包。
