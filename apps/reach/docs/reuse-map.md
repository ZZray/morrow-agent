# 固定来源与复用调查

作者：Ray Zhang（Ray）。日期：2026-11-02。状态：第一批源码调查；D02/D06 未验收。

下表保留 2026-11-02 的来源调查。2026-11-13 起，Reach 已迁入 Morrow Agent，实际依赖为父仓 `morrow-agent-*`，不再引用旧 ARA 检出；源工作区包含下述基线之外的未提交改动，详见[迁移清单](../provenance/migration-20261113.json)与[交接](handoffs/2026-11-13-morrow-subproject.md)。历史能力不等于当前 Morrow 版本通过。

| 来源 | 核对结果 | Reach 接入方式与待验证项 |
|---|---|---|
| ara-agent-lite-core 0.1.1 | 模型工具循环、原生 Session、取消、预算、本地工具；11 月 1 日记录了真实图片工具请求和多模态摘要接线 | Node 嵌入公共 API；仍需验证 Reach 的工作目录、进程、截图、模型路由与实际结果 |
| ara-agent-lite-harness 0.1.0 | verify/prepare_continuation、Task 累计预算和恢复合同 | 实现 Reach HarnessHost；不把模型完成当作业务验收 |
| ara-agent-lite-mcp 0.1.0 | experimental；stdio/Streamable HTTP 客户端，工具/图片结果转换 | 用于 Node 接入产品/桌面工具；不替代 controller 对外 MCP Server |
| tools/ara-lite-host | experimental 持久收件箱、输入摘要、Unknown、执行绑定与恢复 | 参考 journal 和恢复合同；其 Git 工作区、模式和人审示例不整体搬入 Reach |
| HandWave Node | 独立 Rust Host、身份和操作代码；旧 Receipts 只保存 id 到状态字串 | 参考接线，单独实现完整输入绑定、outbox、Windows 状态 ACL 与服务生命周期 |
| CursorTouch/Windows-MCP | 固定 `94de2b4a5e1f2c52aad6003d5e60af28f57b8c8b`，pyproject 为 0.8.8，Python >=3.14，MIT，Windows 10/11 | 首选评估候选；需打包 Python 与依赖、关闭非必要遥测、核对交互会话/截图/输入，尚未安装或实测 |

Windows-MCP 的原许可证为 LICENSE.md，版权 JEOMON GEORGE，2025。源码引用：https://github.com/CursorTouch/Windows-MCP/tree/94de2b4a5e1f2c52aad6003d5e60af28f57b8c8b 。首次读取错误文件名 LICENSE 得到 404，随后实际读取 LICENSE.md 确认 MIT；未把错误响应当作许可证。

## 技术选择与环境证据

- service/controller 采用 TypeScript。现机 Node v24.21.0，Ray 服务器 Node v24.20.0；服务使用内置 HTTP、crypto、SQLite，避免首次部署另添数据库进程。
- 请求验证依赖 Zod 4.6.6，类型检查 TypeScript 5.9.3。bun.lock 固定 Node 包版本；生产仍以 Node 24 执行。初始 4.1.12 的审计报告 GHSA-mrhx-c7xc-m3w5 高危（受影响 <4.6.6），已升级，最终审计结果见本轮证据。
- Node 使用 Rust；安装服务与交互桌面分别管理。当前 Node 与 setup 均有独立 manifest/lockfile，不借用 Core 的依赖锁。Node 安装候选固定 Windows x64、静态 VC runtime，并收集149个 Cargo可达依赖及Rust运行时许可，见[候选证据](evidence/node-installer-20261102.md)。
- service 初始依赖安装和类型检查已运行；本文件不宣称 Node/桌面构建或发行依赖审计已通过。

## 剩余调查

用户新增 Reach 可选云端对话方向。旧 Go `llm-im.git` 固定 `0b9cb7c3eabf1e4d82bfc1d6147786c2d883721c` 的 `apps/handwave/api.go`、`chat.go`、`agents.go` 已只读核对聊天/云端路由及旧 Go Agent 依赖；可复用呈现和会话合同，新扩展复用当前 Lite/Harness，不能复制旧循环或第二套设备连接。完整来源、默认不装载及迁移边界见 [云端平台扩展设计](platform-extension.md)。此调查不证明线上 HandWave 的二进制版本或新扩展已工作。

D02 还需包含桌面后端的 Node 最终包及 controller 分发方案；已有 Node候选的依赖图/许可不代替完整产品发行。D06 需固定桌面后端运行时、打包及实际桌面验证。当前未估算完整交付日历工期。
