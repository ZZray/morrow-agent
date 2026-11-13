# Reach 迁入 Morrow Agent：交接与未完成项

作者：Ray Zhang（Ray）。日期：2026-11-13（Asia/Hong_Kong）。

## 当前结论

Reach 现在位于 **`ZZray/morrow-agent` 的 `apps/reach/`**，是 Morrow Agent 的远程协助子项目和实际业务用例。后续在这里维护；旧 `E:/repos/ara/apps/reach` 原件保留供核对。本次是源码迁移与 WIP 交接，不是首版交付。基础任务仍为 **0/52**，Desk 选装仍为 **0/5**，以[清单](../task-checklist.md)为准。

当前本地目录 `E:/repos/morrow-agent`，迁移分支 `codex/reach-subproject`，目标远端 `https://github.com/ZZray/morrow-agent.git`，父仓基线 `a3e4f2a`。用户先要求“写一个交接文档 然后提交推送 reach项目”，随后改为迁入 Morrow，并明确上述推送仓库。这覆盖本次迁移、提交和推送的旧限制；服务器访问、远端模型探测、安装、上线仍暂停。

用户最初给出的 `youyuwangzi0001/Morrow` 是另一套 Electron 项目，本次最终提交不包含它的源码、依赖或分支历史。

## 源码范围与归属

- 来源为旧 ARA `dev` 的 `90f2b1cdd138129e2d331d89a37d70852e849739` **加其 Reach 未提交工作区**，不是该提交的干净导出。应用、桌面 Host、安装脚本、Desk 平台、文档、测试和原版权一并迁入。逐文件源 SHA256 与迁入后的改动见[清单](../../provenance/migration-20261113.json)。
- 只导入 Reach。旧 Full ARA、第二份 Lite Core、其他仓库业务与本机配置没有迁入。旧工作区未 reset、删除或提交。
- 不迁入 `.env`、账户/配对状态、SQLite、运行目录、安装产物、`node_modules` 或 `target`。带日期的文档/来源清单/截图仍为历史证据；旧 `work/` 原始日志、DB 和冻结运行时留在旧本机目录，不宣称在新检出中可重现其历史哈希。
- `platform/legacy/release-web` 中的归档是原固定来源的 Web 快照，连同来源清单保留；不是本次生成或推荐发布的制品。
- `tests/fixtures/historical/schema8` 仅保存包括旧 Store 在内的 15 个源码文件的导入闭包，用于真正生成 schema8 数据库验证迁移，避免测试暗中依赖忽略的 `work/source-r3`。没有复制旧用户数据库；夹具保留原字节与哈希。

Reach 负责身份、设备配对、组织模型路由、HTTP/SQLite、原操作收据、安装和业务验收。Morrow 负责通用循环、Session、Harness 与 MCP。不能把 Reach 的服务或账本放进 Core，也不能把一次 Run 成功当作业务 Task 被接受。

## 本次接线

| 入口 | 当前目标 |
|---|---|
| Rust 桌面 Host | `../../../crates/morrow-agent-core`、`morrow-agent-mcp`；独立 Cargo.lock |
| Node 委托侧车 | `morrow-agent-jsonl.exe`，模型变量 `MORROW_AGENT_MODEL_TOKEN` |
| Desk 的 Node SDK | 父仓 `crates/morrow-agent-jsonl/clients/node/` |
| Windows 载荷与依赖审计 | 新包名、侧车名及父仓真实 manifest；Agent 明确使用根 `../../Cargo.lock`，其余三个独立项目保留自己的锁文件 |
| 原生 fence | **保留 `.ara-lite-harness-*.fence.json`**，因为当前 Morrow `storage.rs` 仍使用该格式；不是遗漏改名 |
| Cargo 边界 | Reach Node、desktop、setup 为独立 workspace，根 workspace 显式 exclude；默认库构建不启动 Reach |

包名与导入改为 Morrow 不等于旧协议扩展全部已移植。桌面 Host 的首次编译暴露缺少 `call_tool_with_evidence` 和 `convert_result_with_evidence`；本次将旧 Reach 实际依赖的 MCP 原件回执扩展前移到 Morrow MCP，保留原单次调用、错误语义、全文大小/SHA 与 unknown，不再执行一次工具来取证。来源及四份实现/测试文件的原 SHA 在迁移清单 `sharedAdapterPort` 中。没有覆盖 Morrow Core、Harness 或 JSONL，也没有移植整套旧运行时。

真实 Node 联调还发现普通 JSONL 的 native candidate 包含 `session_id`、legacy review receipt 不包含。依照父仓 [legacy review 合同](../../../../docs/design/jsonl-legacy-review.md)，Node 先严格验证 candidate 的原 Session ID，再严格比较其余全部字段；错误/缺少 Session、原 proof 变化或多余字段均拒绝。不会改写回执，冒充调用方曾核对未传递的字段。该修正后真实文件闭环已通过。

## 已有能力与证据边界

旧版本已有服务、前台 Node、CLI/MCP、配对、文件/命令、Windows 桌面和 Ray 统一登录的分项证据。组织模型代理、多 Run、累计预算、原图传递、原生恢复和资料候选→验证→明确采用→复用也有本地分项。索引见[技术文档](../INDEX.md)，资料闭环见[前次交接](2026-11-04-source-library-local.md)。

这些是不同源码与二进制的历史证据。服务器目前未访问；不能据此描述当前在线状态，也不能将旧安装包当作已包含 Morrow 的新包。完整安装、干净机器、真实组织视觉模型、产品集成与最终端到端仍未完成。

## 最后中断点：R06 真实截图崩溃恢复

原聊天标题“检查 ARA 仓库并查看交接说明”，ID `01a19a2e-6694-7a51-a3fb-37a35a8946a6`，归在 Lumen 项目下。最后一轮 interrupted，没有成功收尾。

故障场景为：截图 child 已成功 → 截断 ACK → 强杀 Node → 恢复原 Task/Session → 模型接收同一 PNG → 截图不重放。

1. 原夹具未设 per-Run cap，中断且缺 observation 时按 `maxCalls=6` 保守计费，导致 `agent_resume_budget`；已仅为崩溃场景加 `runCallLimit=2`，不能退款或放宽产品预算。
2. 后续仍报 `original child event set changed`，未发布复核候选。曾尝试允许本机 ACK 未确认、用 RawValue 比对 JSON；**最后测试仍失败**。已有失败案例的 ACK 全为 true，不能笼统归咎于 ACK=false。
3. 一组留存原件在 `E:/repos/ara/apps/reach/work/agent-desktop-131072-9cf4128d-2a1f-4644-96e7-57a7786ccda5/`，其截图 child `726bc4fc-59cb-4845-bb6e-e93dbede62f3`。该路径是旧本机证据，不是新仓库夹具。继续前先核对最新失败运行，不能把它自动当作最终实例。
4. 比较服务 `operation_events.data_json`、Node outbox 原 `event_json` 与两端 `eventsProof` 的事件 ID、顺序、原始字节及 SHA；单条离线探针匹配不代表完整恢复通过。保留原 unknown，不重拍成功截图、不更换 Session 掩盖失败。

[typed 恢复旧分项](../evidence/agent-typed-resume-20261105.md)记载 Core/JSONL 单测和全 Core 的一个既有 managed-job 失败，不是上述真实桌面流程通过证明。

## Morrow 接入的开放缺口

- 迁入时的 Reach WIP 使用过旧 ARA 未提交的 `inspect_session`、持锁 inspection lease、close/seal、`tool_images_ref` 和 `completed.images`。当前 Morrow 基线没有相同的一整套接口；不能拿旧 ARA 二进制替代或伪造这些证明。
- Desk `settlement.ts` 中固定的旧镜像 SHA 是旧协议接受条件。新侧车不应通过替换常量自动获得旧图片/关闭能力；先适配协议，实际验证后再登记新镜像。
- 旧 Session、安装清单、Agent runtime 配置、原生证明和未知操作没有自动迁移。新二进制不能接管旧在途任务；需要单独设计并验证身份、预算、fence 与原件兼容策略。
- 本次没有执行完整 Windows 桌面故障矩阵、SCM/UAC/安装卸载、真实模型或线上部署；没有把 52/5 项任务勾选。限定迁移的独立代码复核已完成，不是完整产品审查。

## 本次验证

实际命令、结果与源码摘要见[迁移验证记录](../evidence/morrow-migration-20261113.md)。检查从新检出执行；旧工作区或临时 Electron 副本上的检查不算此版本证据。

## 接续顺序

1. 先读本交接、任务清单与父仓[业务接入说明](../../../../docs/integration.md)，在 `apps/reach` 保持独立数据目录。不要开始部署。
2. 本次已跑通“真实 Node → 本地受控模型 → 文件写入/读回 → 原账本 → 待复核候选”；以最终记录的 Node/侧车 SHA 作为接续基线，继续扩大多 Run、取消、重启和故障覆盖，组织账户与真实模型另验。
3. 逐项适配缺失的恢复、inspection/close 和 typed 原图协议，再回到 R06。按最新失败原件缩小事件摘要问题，最后再跑真实截图强杀用例，不以 compile 或 skip 收口。
4. 修完后对交付源码运行定向测试、真实 Host 效果和相关失败路径，独立复核；再考虑安装候选及后续首版能力。用户未恢复服务器权限前继续只做本地。

构建入口（仓库根）与服务检查（应用目录）：

```powershell
cargo build --locked -p morrow-agent-jsonl
cargo test --manifest-path apps/reach/Cargo.toml --locked --offline
cargo test --manifest-path apps/reach/desktop/Cargo.toml --locked --offline
cd apps/reach
bun install --frozen-lockfile --ignore-scripts
bun run check
node --test --test-concurrency=1 tests/agent-resumes.test.ts
```

截图恢复聚焦命令仍为 `node --test --test-concurrency=1 --test-name-pattern='crashed Node resumes' tests/agent-desktop.integration.test.ts`，需显式配置当前二进制、桌面后端和 Python；缺环境导致 skip 不算通过。历史 schema9 数据迁移测试另需旧本机原件，本次不导入数据库来填补它。

文字已人工审读。项目提及的 humanizer 未安装，未声称运行该技能。
