# 长错误正文的保存与取回

作者：Ray Zhang（Ray）。日期：2026-11-03。范围：T04/T06 的错误证据与 I01 候选，完整清单仍为基础 0/52、Reach Desk 0/5。没有提交、推送、安装或更新线上。

共享 MCP 新增 `call_tool_with_evidence`，helper 从同一次调用取得绑定身份的正文与错误状态，恢复完整文本后进入已有产物 outbox。普通 Core 工具接口仍返回 `AgentError::Tool`，没有修改 Core 或复制 Agent 循环。合同见[工具与收据](../tools-tasks.md)和[共享 MCP 说明](../../../../crates/ara-agent-lite-mcp/README.md)。

## 固定来源

目标为 dev / `90f2b1c` 加 WIP。[最终输入清单](error-artifacts-inputs-20261103.json) SHA `ada0daa65b4f468712b61ae0fea68627ae416d2a247cf35a534863eaa22b625d`，sourceIdentity `4a5f22a08c64516b3b75f6f3317816294cd7d1d92ab72d796990f5710a43c21a`；75 项范围来源、2 个普通程序及 22 份执行记录。快照为 `work/error-artifacts-source-550775d6-2b2b-4077-867f-87eefd4531bf`。

相对[文件固定点](file-artifacts-20261103.md)改动 4 个生产文件、4 个测试/夹具和 1 份共享说明。Node 未变；新 helper SHA `a679c452c8741fe3a83d3006bea1627aad6a520786d89142d190db4a05e657d1`。旧 r2/r3 日志保留，但最终桌面链路全部用这一普通程序执行。

独立源码复核发现同一 P2 的两条路径：错误 structuredContent 在归档后仍复制到 details，以及错误正文中的大型 `Reach UI Labels` 数组仍复制到 labels；都可能在第一条产物事件前撑爆终态预检。已分别取消错误 details 的重复内联和错误 labels 解析，并用实际 helper/Node 受控后端覆盖两种原反例。

## 验证与原件

执行环境为本机 Windows 普通交互用户、Node 24、固定便携 Python 3.14.7 与真实 Windows-MCP。Cargo 使用独立 MCP/helper workspace，`--locked --target x86_64-pc-windows-msvc -j 1`、静态 CRT，缓存位于 E:/usr；未构建 Full workspace。

| 执行 | 结果 |
|---|---|
| MCP `cargo test --all-targets` | 初轮 26/26，包含 256 次中断属性案例；原日志 error-mcp-tests-r1 |
| P2 修补后 MCP 受影响组 | result_props 2、stdio 11、harness_mcp 2 均通过；是原26项的子集，不叠加计数 |
| helper 单元及管道组 | 7/7；error-helper-tests-r3 |
| 两个 workspace fmt / changed workspace clippy | 通过；clippy 为 all-targets/all-features、`-D warnings` |
| MCP doc test | 0例，命令退出0；不称文档行为验收 |
| TS 类型检查 | `bun run check` 通过 |
| 最终实际桌面链路 | `node --test --test-concurrency=1 tests/desktop-chain.integration.test.ts`，6/6，156.678s |

各原日志路径和 SHA 均在输入清单。初轮 MCP 全套在重复元数据修补前执行；最终重跑了受影响的15项，其他旧接口/中断分支未改变。锁文件和依赖图没有本点增量，未重复依赖审计，也未宣称完整发行依赖通过。

最终实际目录 `work/desktop-chain-563b2029-7850-47bc-949a-800ae7a2ac78`：

- 原3组重新验证实际中文输入/点击、丢失 ACK 图片、取消/Node崩溃/失败退役，以及 378,025 bytes 成功长正文双重启取回；真实效果仍为 once。
- Windows-MCP 的实际长 schema 错误：截图 114,243 bytes 保持 failed；PowerShell 114,242 bytes 保持 unknown。两者经丢失 ACK、Node/服务重启后由 CLI/MCP 取回，原 requestId 重试不改变事件。PowerShell 被 schema 拒绝，证明保守 unknown，不代表已经发生副作用后才失败。
- 把夹具的空结果目录替换为普通文件：保存失败仍保留有界原错误和 truncated/evidenceError，不发 complete、不生成快照，状态 failed。
- 隔离复制固定 Python 的受控 stdio 后端，经普通 helper/Node 捕获 1,260,033 bytes structuredContent 错误和 1,100,037 bytes labels 尾标记错误。均 failed、labels=null、终态小于40KB，全文逐字节下载；后端总计两次调用。该夹具不是 Windows-MCP 原工具。

[主代理原件核对](error-artifacts-owner-check-20261103.json)直接重组四个错误操作的原 outbox，与服务事件 ID/种类/数据/序号、保存正文及 CLI 下载比较，分别为 7/7/25/22 条连续事件，全部 ACK，无 succeeded，bytes/SHA 一致。归档对象是 adapter 合并的完整错误文本，不是原始 MCP wire 字节。

## 安装候选与边界

候选 `outputs/windows-complete-1fab0ba3b8239354-93fe5dccdd7f/Reach-Setup-0.1.0-preview-60a6bfdfd7879528.exe`，SHA `60a6bfdfd7879528231a2300533f6c99ebdd21168dd584b11992a164e85d2b80`。ZIP SHA `1fab0ba3b823935428aca08b0bafe0ad2b7531f5451894a607792d3bdf24580f`；payload manifest SHA `dd77efb19113d9be7f08fb0bc3d91ba0032186993b0f74d2e89d3754a5a89c16`。

实际 WinPS 5 私有 stdin 校验 6,327 文件 / 201,904,479 bytes 通过。Node/helper/Setup 的十档图标原字节及 Reach/Ray Zhang 版本品牌均已核对，见[资源记录](error-artifacts-icons-20261103.json)。维护源 identity 仍为 `93fe5dccdd7fdee344180610faaae42a12154ef0d5f07f9279394df00e34b9bf`。未签名、未真实安装；旧候选保留。

独立 `/root/reach_plan_review` 的[最终报告](error-artifacts-review-20261103.md)限定通过，无剩余确认阻断，SHA `ec7db23875a8b89c7f4b1a795eca41cfe1b83f4711ed90c15825bffbcba22b3a`。主代理完整回读并核报告摘要、关键原件和候选信息。7份改动文档107个本地链接及 `git diff --check` 通过；全仓bootstrap仍因既有历史/外部路径断链退出1，日志 `work/error-bootstrap-doc-check.log`，未宣称全仓通过。

真实模型图片消费、SYSTEM/WTS、安装生命周期、Reach Desk和新版Ray部署仍开放；本点不接受完整T06。文档人工审读，未调用此前未找到的humanizer。收尾只读核实Ray仍为旧SSO稳定release，reach/ray-front均active，Node/操作/事件1/2/10、活动0；没有线上变更。
