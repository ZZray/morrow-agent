# Reach

作者：Ray Zhang（Ray）。命名空间：`RY`。

组织通用的远程操作与协助工具。产品名为 **Reach**，命令名为 `reach`。

当前阶段：**设计与实现进行中**。独立服务已部署到 Ray 的 `/reach/`，登录 Ray 后可直接进入 Reach；Rust 前台 Node、CLI/MCP 控制器和管理页已有真实进程、跨机及浏览器证据。Windows 服务宿主与本机 IPC 已实现；正式安装、桌面和 Agent 委托仍待完成。完整功能验收仍为 **0/52**。

自 2026-11-13 起，Reach 迁入 **[Morrow Agent](https://github.com/ZZray/morrow-agent)** 的 `apps/reach/`，作为远程协助子项目和实际业务用例，由父仓统一管理版本。产品仍独立部署；设备身份、服务、操作账本和业务验收归 Reach，通用 Agent 循环归 Morrow。迁入不是完整产品验收。

## 阅读入口

- [最新迁移与实现交接](docs/handoffs/2026-11-13-morrow-subproject.md)：Morrow 依赖、迁入范围、最新验证、R06 失败点与下一步。
- [前轮本地实现交接](docs/handoffs/2026-11-04-source-library-local.md)：资料候选、验证、明确采用及复用的历史本地证据，完整 R04/R05 仍开放。
- [Ray 部署交接](docs/handoffs/2026-11-02-admin-ray.md)：管理页、Ray 服务与 Reach Desk 迁入。
- [Node/控制器验证](docs/evidence/node-controller-20261102.md)：最终源码与真实进程执行证据。
- [独立管理页验证](docs/evidence/admin-20261102.md)：25 项回归、真实浏览器与故障恢复记录。
- [Ray 统一登录验证](docs/evidence/ray-sso-20261102.md)：443 入口、免二次登录、多标签会话与部署收据。
- [迁入 ARA 交接](docs/handoffs/2026-11-02-ara-subproject.md)：仓库迁移背景。
- [项目目标与实施计划](docs/project-plan.md)：8 个阶段、里程碑、依赖和完成标准。
- [52 项分步骤清单](docs/task-checklist.md)：交付物、前置任务与验收条件；当前 0/52。
- [项目计划 HTML 阅读版](docs/plans/project-plan-20261101/index.html)：2026-11-01 快照，持续状态以 Markdown 清单为准。
- [产品范围与已确认方向](docs/product-scope.md)：用户已经确定的行为，以及仍待讨论的设计。
- [文档设计](docs/document-design.md)：文档如何组织、各文件负责什么、按什么顺序讨论。
- [技术文档索引](docs/INDEX.md)。
- [架构](docs/architecture.md)、[身份配对](docs/identity-pairing.md)、[工具收据](docs/tools-tasks.md)与[复用调查](docs/reuse-map.md)。
- [本轮服务基础验证](docs/evidence/service-foundation-20261102.md)：实际执行范围与未完成项。
- [项目知识库](docs/knowledge/INDEX.md)：耐久的决定、约束与后续验证经验。
- [源码目录说明](src/README.md)：候选组件及职责，尚未选择全部技术栈。

- [Reach Desk 源码迁入验证](docs/evidence/platform-migration-20261102.md)：正式定名、固定来源、独立兼容构建及未接通范围。

## 当前产品方向

本地 Codex 等 Agent 结合源码分析问题，通过 Reach 调用远端能力。远端可以操作系统、文件、进程、桌面以及接入的产品工具，也可以承接需要现场连续取证的 Agent 子任务。

Reach 独立于 LabSlot、QSpin 和其他业务产品。首版作为独立应用部署到 Ray 工作台服务器，工作台已增加 Reach 入口并复用 Ray 浏览器登录；原生客户端独立认证。LabSlot 集成延期，产品关联可为空。

**Reach Desk** 是 Reach 内部的可选云端对话子项目：默认 Reach 不带聊天，Ray 可以选装，在网页直接对话或选择 Reach 设备执行任务。平台源码与 Ray 界面适配来源已迁入 [platform/](platform/README.md)，后续在这里维护。兼容构建与最终[扩展接线](docs/platform-extension.md)分别验证；Reach Desk 尚未在线上启用，旧 HandWave 服务保留。基础任务 52 项与选装任务 5 项分别验收。

配对后统一采用完全控制，不设计 Auto / Full Access 模式切换、工具权限分层或逐次操作审批。登录和配对用于识别身份、建立连接；完全控制的产品行为见[产品范围](docs/product-scope.md)。

开发版已支持命令行首次配对和再次配对。目标安装体验仍待实现：双击安装、自动注册服务、加入 PATH、启动服务并退出安装器；安装版配对还需接通服务 IPC。

## 仓库状态

- Morrow Agent 的 `apps/reach/` 子项目，使用父仓 Git；没有嵌套 Git。逐文件来源见 [迁移清单](provenance/migration-20261113.json)。
- 当前已有 `src/contracts/`、`src/service/`、`src/node/` 和 `src/controller/` 的基础实现。
- 技术文档以 Markdown 为可评审源文件，v1 请求合同由 Zod schema 生成。
- 功能实现已开始；Ray 部署已有证据，安装包及完整现场验收尚未完成。

## 服务开发入口

在 `apps/reach` 使用 Node 24.20 及以上版本：

```text
bun install --frozen-lockfile
bun run check
bun run build:admin
bun run test
node --env-file=.env src/service/main.ts
```

首次启动前按 `.env.example` 配置受保护的 `.env`，设置随机 bootstrap 密码。默认开发服务仅监听环回；公网部署必须配置 HTTPS 入口并关闭开发选项。访问服务根路径即可进入独立登录和管理页；部署时包含 `src/admin` 静态文件及 `dist/admin/admin.js`。凭据不写入源码、日志或 MCP 工具参数。

Node 从本目录的独立 Cargo workspace 构建，避免构建 Full workspace：`cargo build --locked --manifest-path Cargo.toml`。开发前台模式显式使用 `reach --state-dir <开发目录> pair --server <HTTPS origin> --code <code>` 和同目录的 `run`。Windows 默认 `pair/status` 只访问安装服务；开发验证可在明确的目录运行 `host`，随后同目录 `pair/status` 经本机 IPC 完成，`host-stop` 请求合作停止。正式 SCM 安装及更新仍未验收，合同见 [installation-update.md](docs/installation-update.md)。

控制器开发入口为 `node src/controller/main.ts help`。`login` 通过 `REACH_PASSWORD` 环境变量接收密码，本地会话配置受 ACL 保护；`mcp` 提供 stdio JSON-RPC，和 CLI 共用连接、请求 ID 与事件读取逻辑。`request-id` 生成一次请求 ID，`call` 读取包含 requestId/nodeId/command 的 JSON 文件，网络重试须使用原文件和原 ID。

真实 Node 测试需先设置 `REACH_NODE_BINARY` 为本次构建的 reach.exe 完整路径，再运行 `bun run test:node`。服务检查仍使用 `bun run check` 和 `bun run test`。测试可执行文件不等于完成安装包或公网部署。
