# Reach → Morrow Agent 迁移验证

作者：Ray Zhang（Ray）。日期：2026-11-13（Asia/Hong_Kong）。

范围：源码迁入、包名/路径/环境变量与独立构建；不是首版、安装、真实模型或 R06 图片恢复验收。初始父仓基线 `a3e4f2a`，推送前已接到新增的 `a0c30e0`；原检查及重基后的检查分列，源码来源与逐文件摘要见[迁移清单](../../provenance/migration-20261113.json)。

## 当前执行记录

| 检查 | 结果 | 覆盖边界 |
|---|---|---|
| `bun install --frozen-lockfile --ignore-scripts` | 通过 | 新 Reach 目录，固定 8 个包；无旧 node_modules |
| `bun run check`、`bun run build:admin` | 通过 | 最终包括历史 schema8 源码夹具的服务/管理页 TS 与管理页构建 |
| `platform/tsconfig.json`、`platform/tsconfig.web.json` 的 `tsc --noEmit` | 通过 | Desk 服务/测试与网页类型；不代表缺失动态 SDK 已可执行 |
| Reach Rust `cargo test --manifest-path apps/reach/Cargo.toml --locked --offline` | 最终 23/23 通过 | 包括 legacy basis 的 Session/原 proof/额外字段拒绝；早期 22 项结果不另累加 |
| 8 个明确文件的服务回归 | 59 通过、2 条件 skip、0 失败 | service/process、agent calls/budget/model/model-stop/reviews、Desk 默认隔离；本地 HTTP/SQLite/受控模型 |
| `tests/agent-resumes.test.ts` | 10/10 通过 | 新目录真实 HTTP/SQLite 与版本化 schema8 源码；证明服务合同，非原生截图恢复 |
| 桌面 Host 首次 `cargo test` | 未通过 | 当前 Morrow MCP 缺两个原件回执 API；不是假成功或测试 skip |
| 补齐 MCP 回执后的桌面 Host `cargo test --locked --offline` | 7/7 通过 | 原 PNG、全文/哈希、原错误与真实本机 pipe；不是完整桌面安装 |
| 根库、Node、桌面 Host 的 `cargo fmt -- --check` | 通过 | 最终源码格式 |
| 原侧车 offline 构建尝试 | 未通过 | 本机缺 root lock 要求的 `syn 3.0.10`；不改锁降级，随后按锁下载依赖 |
| `cargo test -p morrow-agent-mcp --all-targets --locked --offline` | 26/26 通过 | 包含真实 stdio 单次调用、原错误全文/哈希、unknown 及属性测试 |
| MCP/Node 的 `cargo clippy --all-targets --locked --offline -- -D warnings` | 通过 | 最终两组受影响源码 |
| 当前 `morrow-agent-jsonl` 与 `reach.exe` 开发二进制构建 | 通过 | 下载锁定依赖后完成；适配移植期间的一次并发旧图构建失败已由最终固定源码重建替代 |
| 真实 Node + Morrow 侧车第一次文件委托 | 未通过 | 文件写读已执行；native candidate 多 `session_id`，legacy receipt 缺字段，原样严格比对拒绝，未伪造成功 |
| legacy Session 显式绑定后，同一文件委托测试的新运行 | 1/1 通过、0 skip | 3 个受控模型请求、write/read 各一次、同一原 Run/账本；返回待复核，`taskAccepted:false` |
| `windows-agent-audit.test.ps1` | 8/8 通过 | 实际 Morrow metadata、父仓根锁及错 SHA/来源/版本/包集拒绝 |
| `audit-dependencies.ps1` | 四组通过 | Node、desktop、setup 独立 workspace 与 Morrow Agent 根 workspace，离线 cargo-deny，锁/策略不变 |
| 新交接/入口文档与任务清单检查 | 通过 | 8 文档、最终链接数见机器摘要；57 个唯一任务 ID，全未勾选 |
| 暂存差异 `git diff --cached --check` | 通过 | 三处自有源码空白已清理；原历史 patch、法律文本、证据及第三方来源由属性保留，不为格式检查改写原件 |

完整服务命令：

```powershell
node --test --test-concurrency=1 tests/service.test.ts tests/service-process.test.ts tests/agent-calls.test.ts tests/agent-budget.test.ts tests/agent-model.test.ts tests/agent-model-stop.test.ts tests/agent-reviews.test.ts platform/tests/default.test.ts
```

## 独立复核与原件

推送前发现远端新增 `a0c30e0`（goal lifecycle / persistent Host management），已将迁移提交接在其后，保留该提交全部源码。对这一基线重新构建侧车，桌面 Host 7/7、MCP stdio/result 属性重点回归 13/13、MCP Clippy `-D warnings`、根库格式检查及真实 Node 文件闭环 1/1 均通过。新实际 Node 原件为 `apps/reach/work/agent-node-3745868d-0089-47a6-9a44-e2f07f9f1651/`；Node 源码与其 23 项检查、服务源码、依赖锁及审计策略未被该上游提交改变。上述数字不与旧基线的测试相加。

未执行父仓整个 Core/Harness/JSONL 全测试或 Reach 全部集成矩阵；不能称完整 workspace/package 或产品验收通过。

独立 Codex 复核 `/root/reach_migration_review` 检查 MCP 原件回执、普通 basis 的 Session 绑定、活动依赖路径、打包脚本和交接范围。发现 Agent 审计仍按成员目录找锁文件；主任务修为根 `../../Cargo.lock`，复核者回查修复后未报告新的高置信缺陷。主任务随后执行真实 Cargo metadata、8 项审计回归及四组完整依赖审计。该结论限于迁移差异，不是完整产品审查。

原始日志保留在本次本机 `tmp/reach-migration-20261113/`；初始基线通过的实际 Node 原件在 `apps/reach/work/agent-node-e0fe6647-905c-44a3-94d5-d61dae8170db/`，最新基线原件如上。没有把运行身份、请求/数据库或本机凭据加入 Git。提交内[机器摘要](morrow-migration-20261113.json)记录日志摘要、当前二进制与检查范围；[迁移清单](../../provenance/migration-20261113.json)记录源字节 SHA 与最终 Git blob SHA，换行转换不冒充字节相同。旧截图崩溃恢复仍为失败/未完成，见[交接](../handoffs/2026-11-13-morrow-subproject.md)。
