# Reach 常驻服务计划文档检查

作者：Ray Zhang（Ray）。日期：2026-11-13（Asia/Taipei）。

来源会话：`01a1a973-7823-77f1-b547-1a77b78cbe39`（原基线：ARA `dev`，`28ac6dcd73eebe07ca3b403b2e6fa26c8985a30e`）；同日在会话 `01a1d3b5-a33a-7141-8659-07fe325e5117` 同步并入 `ZZray/morrow-agent` 的 `apps/reach/`。

## 范围与结果

本轮将 Starferry 合并、默认 SSH、独立常驻服务、分钟级可远程配置心跳、断网退避、首次服务地址和 `ryreach` 命令写入[产品范围](../product-scope.md)、[架构](../architecture.md)及[任务清单](../task-checklist.md)，同步[流程图](../starferry-reach-workflows.md)、索引、[知识库决定](../knowledge/product-decisions.md)与[Morrow 接入与常驻改造执行单](../tasks.md)。按用户最后修正，QSpin 的默认安装及地址配置归 QSpin，不设计其运行时集成。

保留原 52 个基础主任务（及 5 个选装任务 X01–X05）和既有前置依赖，21 个主任务补入 `REQ-01`–`REQ-06` 新需求引用及近端验收补充。所有主任务与选装任务均未勾选，功能验收仍为 0/52 与 0/5。

| 检查 | 原会话（ARA 基线）结果 | 迁入 Morrow 同步核对结果 | 证明边界 |
|---|---|---|---|
| 本次变更 Markdown 的本地链接与锚点 | PASS：153 个本地链接、79 个锚点引用可解析 | PASS：同步更新后的全部 Reach Markdown 本地路径与 `#req-01`–`#req-06` 锚点可解析 | 路径和锚点存在，不表示接口已实现 |
| 任务结构 | PASS：52 个唯一主任务、全部未勾选，140 条依赖有效且无环 | PASS：52 个基础主任务 + 5 个 Desk 选装任务全部未勾选，依赖引用有效无环 | 没有通过文档改写增加完成数 |
| 新需求引用 | PASS：REQ-01–REQ-06 的引用有效 | PASS：21 个任务对 REQ-01–REQ-06 的链接与锚点全部有效 | 需求与任务可追溯，不表示需求验收通过 |
| Mermaid 基本结构 | PASS：5 个图块，围栏及节点分隔符配对 | PASS：架构与工作流共 5 个 Mermaid 图块围栏及节点分隔符配对 | 未运行 Mermaid 渲染器，不证明最终视觉排版 |
| `git diff --check` | PASS | PASS | 本次差异无空白或冲突标记错误 |

## 独立复核与修改

独立 Codex reviewer `reach_practical_plan`、`reach_maintenance_plan`、`reach_runtime_plan` 分别检查实施、维护和运行故障边界。三个视角均建议常驻服务优先、心跳与即时控制分开。用户随后取消 QSpin 运行时集成，计划按最后范围收敛。

`reach_maintenance_plan` 最终检查文档并提出两项修改，已落实并通过复查：

1. 流程文档不再写“是否依赖 OpenSSH 待定”，统一为默认准备 SSH、复用已有 OpenSSH，具体提取和缺失安装由 D02/D05 确定。
2. C03 提供最小目标机 `ryreach` 地址初始化入口，再进入 C04 配对、C05 连接及收据、C06 完整控制器，避免首次配置入口晚于配对前置。

## 原会话全仓检查记录与 Morrow 边界说明

原 ARA `dev` 仓库运行 `python scripts/verify_bootstrap.py` 时，曾报告旧 `crates/ara-agent-lite-core/docs/evidence/` 与 `apps/handwave-node/` 的历史断链失败（不在 Reach 本次修改范围）。迁入 `ZZray/morrow-agent` 后，原 ARA `tools/ssh-tunnel/`（Starferry 源码）尚未迁入本仓，文档中对原仓库 Starferry 文件引用均明确标注原仓库路径，不伪造本地文件链接。

本轮同步仅更新需求、架构草案、知识库与任务清单，未实施 Starferry 连接合并、`ryreach` 命令改名、默认 SSH 准备或心跳退避代码改动，不能作为 Node 常驻、SSH、心跳、断网恢复或产品验收证据。
