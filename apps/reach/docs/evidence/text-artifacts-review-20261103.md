# 原始全文、产物消费者与完整候选独立复核

作者：Ray Zhang（Ray）。日期：2026-11-03。

复核执行者：独立 Codex 子代理 `/root/reach_plan_review`，按 `ara-git-review` 的目标版本及覆盖边界要求复核。主代理负责实现、构建、测试与浏览器操作；本复核执行源码检查、只读原始证据核对及候选 EXE `--inspect`，没有重跑测试、安装或部署。

**结论：本限定执行点通过，未留下新增确认阻断项。** 接受范围为成功长正文恢复、原操作产物上传与读取、管理页消费者以及新候选载荷身份。此前确认的四项问题已修复并有对应证据。完整 T06、基础清单 0/52、Reach Desk 0/5 均保持开放；不能据此宣布首版、安装版或模型端到端验收完成。

## 目标版本与复核覆盖

目标为 `dev` 分支、HEAD `90f2b1cdd138129e2d331d89a37d70852e849739` 之上的冻结 WIP，包含未跟踪文件，不是一个已提交交付版本。精确输入见[冻结清单](text-artifacts-inputs-20261103.json)：

| 项目 | 身份 |
|---|---|
| 清单 SHA256 | `a8d27f6e688de21b5cb3445fef07ea4b48b40f5279b9a2ac6c6401a07a0d2db0` |
| sourceIdentity | `289c29ebafc39375db265ade0b107bb29413cb27d336922585d31e92b14e75d7` |
| 快照目录 | `E:/repos/ara/apps/reach/work/text-artifacts-source-9d181291-d2ba-4eab-b300-4fa4d9452c75` |

已独立核对 69/69 当前源码及快照副本的 SHA256/字节数、2/2 普通 EXE 和 16/16 执行证据；重新计算 `SHA256(UTF-8(JSON.stringify(sources)))` 与 sourceIdentity 一致。原始核对结果见[输入核对](text-artifacts-review-input-checks-20261103.json)。清单路径相对 ARA 根目录，快照保留相同目录结构。

摘要一致不表示对所有文件做了完整语义审查。逐文件状态及证据摘要见[69 项覆盖表](text-artifacts-review-coverage-20261103.json)。以下路径除共享 crate 外相对 `apps/reach/`：

| 状态 | 数量 | 实际范围 |
|---|---:|---|
| reviewed：产物相关逻辑 | 13 | `src/contracts/{artifacts,protocol}.ts`、`src/service/{artifacts,admin}.ts`、`src/controller/{artifacts,mcp,main}.ts`、`src/admin/{artifacts,admin}.ts`、`desktop/src/{capture,main}.rs`、`src/node/desktop.rs`、共享 MCP `src/tool.rs`；审查本次合同及相关控制流，不宣称整文件所有旧功能重新审计 |
| reviewed：相关调用段 | 7 | Controller client、service store/server、Node ledger/runtime/windows_desktop、helper supervise；核产物路径、原事件账本和生命周期接口 |
| reviewed：相关测试与夹具 | 9 | artifacts、text-artifacts、admin-artifacts、admin-http、desktop-chain、node.integration、native-fixture、浏览器夹具及共享 result_props；node.integration 仅本轮选中的两个完整测试及所用夹具 |
| 限定检查 | 2 | `dist/admin/{admin,artifacts}.js` 的摘要及最终不完整文案/接线；未另作全量生成代码语义审计 |
| 限定检查 | 4 | desktop/shared MCP 的 Cargo manifest/lock 中 sha2 与 Windows 文件系统功能相关变更；不是完整依赖安全审计 |
| scope-excluded：仅身份核对 | 34 | 其余基线源码、构建输入、CSS、HTML、图标、占位文件等；未将其纳入本次完整语义复审 |

skipped：未重复主代理已执行的 Cargo、TS、原生集成或完整载荷校验；未重新操作浏览器。真实安装、SYSTEM/WTS、部署及真实模型消费属于本执行点之外，后文单列。

## 已解决的问题与当前合同

| 已确认问题 | 最终源码与证据 |
|---|---|
| 已保存文本缺少原始字节数/SHA，不能证明取回的是原始 MCP 正文 | 共享 adapter 从原始 `text.as_bytes()` 产生字节数与 SHA256；helper 对同一打开文件读取的字节核对，而非只给落盘内容重新计算摘要。helper 测试及实际长文本原文件比对覆盖此修补 |
| 已被 adapter 保存的 50,001–65,536 ASCII 字符正文仍可能内联，漏过 artifact 通道 | `text_sources` 对存在保存全文的第一正文强制附件化；测试覆盖该边界以及多字节字符 |
| failed/unknown 携带证据时缺 helper generation/session 核对 | Node 在处理任何含证据的回复前调用 `validate_reply_identity`，并保持原失败/未知状态；Node 单测覆盖错误身份 |
| 管理页把 `complete=false` 写成“仍在传输”，错误暗示将继续接收 | 最终 TS 和 dist 均为“未完整收到”，不完整项不提供预览/下载；受影响 7 项回归及截图对应最终版本 |

关键源码摘要：

| 文件 | SHA256 |
|---|---|
| `desktop/src/capture.rs` | `1b55009df0f1dd1ba4dddd54f5cd3b2e3f35a487c1ba5fe3acc7748c3022f195` |
| `desktop/src/main.rs` | `e439fdde1003085333176ac8b3c7bf1afb646b45dca40e86f1759b564070cd5e` |
| `src/node/desktop.rs` | `7bceb529dd0624aa100f12ab4eb965ece98bacf47bc90a44345605a56637c966` |
| `src/admin/admin.ts` | `cde7dfb08b2065a485f8783e2469f56e189f978b75b879c86768470e3b3ae680` |
| `src/admin/artifacts.ts` | `e9e5febc5fd28f20f82173a8514ccd451b0f6dceee0049d96450ac69e7d941c7` |
| 共享 MCP `src/tool.rs` | `713ae5a0f5ac00bc7e409ae80546be6f496cd843fded4aaed1103551509d70e9` |

保留 PNG v1；新增 text/plain UTF-8 与 application/octet-stream v2。通道限制为每项 8 MiB、64 KiB 分块、每操作最多 4 PNG 加 4 非图片且总计 16 MiB。Node 在第一条产物事件写入前校验整组以及替换后的终态体积（不超过 1,047,552 字节）；引用绑定原操作，失败/未知的完整证据不会把原动作改为成功，也不触发重放。

helper 使用本代专属目录，以 `OPEN_REPARSE_POINT`、只读共享、文件属性及 `GetFinalPathNameByHandleW` 核同一打开句柄的直属普通文件；校验原字节数、SHA、严格 UTF-8 和 Unicode scalar 数。先用恢复后的全文判定 labels/错误，再附件化。

CLI 在完成内容校验后以 `wx` 排他创建新文件；MCP 对非 PNG 返回清单和有界字节范围，对 PNG 保留校验后的图片返回。管理页校验绑定、清单、base64、分段 SHA、最终 SHA、流式 UTF-8 与字符数；切换视图后的旧响应不得展示或下载。文本通过 `textContent` 展示，不解释为 HTML。

## 已读执行日志与独立复核的区别

以下均由主代理执行，本复核读取日志、核其摘要和相应测试逻辑；不是复核代理重新运行所得：

| 执行 | 结果 | 日志 |
|---|---|---|
| Node 相关 Rust 单测 | 3/3，另 5 项被筛选 | `work/text-node-tests-r2.log` |
| helper capture 单测 | 4/4，另 2 项被筛选；包含真实文件和共享 adapter | `work/text-helper-tests-r2.log` |
| shared MCP property test | 1/1；源码配置 256 cases，不将其计作 256 个测试函数 | `work/text-mcp-tests-r2.log` |
| TS 产物/管理页消费者/HTTP 回归 | 12/12 | `work/text-artifacts-ts-r2.log` |
| 最终 UI 文案修补后的受影响回归 | 7/7，是前述组的子集 | `work/text-admin-final-r3.log` |
| 普通程序真实桌面链路 | 3/3 | `work/text-desktop-chain-r2.log` |
| 受影响 Node/Controller 原生回归 | 2/2 | `work/text-node-integration-r2.log` |
| 三个变更目标 Clippy | 通过 | `work/text-{node,helper,mcp}-clippy-r2.log` |
| 普通 Node/helper 构建 | 通过，dev profile/static CRT | `work/text-{node,helper}-build-r2.log` |

不将 12+7 算成 19 项独立测试，也不声称最后一次文案改动后重跑了全部 12 项。该改动之外的产物源码在冻结快照中未变。旧 r1 结果不用于证明 r2 修补。两个 Node 回归实际覆盖配对/单实例/流式命令/重复请求/文件效果及 2,400,000 字节 stdout 的连续 MCP 分页；后者仍为 events 合同，不是二进制 artifact 实测。

## 独立原始证据核对

独立只读 SQLite/文件探针结果见[原始证据核对](text-artifacts-originals-review-20261103.json)。实际桌面目录为 `work/desktop-chain-7ebeb16c-a851-4ea9-9e87-324b6b2e68fc/full-text`。

| 项目 | 核对结果 |
|---|---|
| operationId | `d866b042-b673-497f-8d64-b6919767c96c` |
| artifactId | `03dcc6ea-fe1e-4b89-8185-b547e811b55e` |
| 原正文 | 378,025 字节、162,025 Unicode scalars |
| 原正文 SHA256 | `eecaa1587bc8321a9edb45592a45f3bd790ba57e1330ff5aadc6b2c0d4b977af` |
| Node 与服务账本 | 11 条原事件 ID、种类、数据与连续序号一致；Node outbox 全部已确认 |
| 产物 | 独立重组 6 块并核每块索引/SHA；adapter 原文件、CLI 下载、Node 分块与服务记录逐字节一致 |
| 动作与效果 | 原终态 succeeded，元数据与引用匹配；效果文件恰为 `once` |

相应集成测试源码确实先让首块到达服务后丢 ACK，阻断后续上传，待 Node 终态落盘后重启 Node 与服务，再恢复原 outbox。主代理运行日志通过；复核代理核对的是保留下来的原文件、数据库与效果，没有重新执行动作，也没有独立重演断网/重启时序。CLI 拒覆盖与 MCP 首 64 KiB/后续 4,096 字节由同一实际集成测试验证。

## 浏览器证据及其限制

浏览器使用实际服务和管理页，但输入为合成操作回执，目录为 `work/text-browser-6ee0835e-5d51-4224-89a3-9e102e0249c2`。它不代表浏览器到真实桌面的整链联合验证。

复核代理独立比对 `expected.txt` 与实际 Downloads 文件，均为 93,503 字节，SHA256 `4cff3eabc4846b2de7e115c5db3ead4b56b558b11a99843389d2fd1c7d0be1b3`；该 operationId 前缀仅有一份下载。实际文件名为 `d98bc208-58a4-44b2-99dd-f11bb08fb698-ac48af24-1b8a-4efd-967e-a361e8d5df7d.txt`。已查看保留截图：原操作 unknown 提示仍在、多语言预览及全文校验状态可见、不完整项标为“未完整收到”。这不是完整视觉设计审查。

主代理 Cua 观察记录显示空文本、损坏分段拒绝，以及最终两次延迟响应：06:47:42.182Z 切页，06:48:27.110Z 退出。主代理先清旧 release/held 标志，确认本次 held 后注册下载等待器再释放；各观察 2.5 秒无下载。复核代理独立读取请求日志，最终两次确实各只有 offset 0、没有后续范围请求。

此处证据等级为“主代理工具会话观察 + 独立请求日志佐证”，没有保存浏览器 trace，复核代理没有重演；请求日志本身不能证明 held-before-release 或页面状态。早期 06:45/06:46 探针有残留 release 标志，不计为有效竞态证据。消费者单测与实际 HTTP 测试提供另外的程序化校验，不能改称独立浏览器重演。

## 新完整候选身份

候选为 `outputs/windows-complete-ba1ecd6da6c93150-93fe5dccdd7f/Reach-Setup-0.1.0-preview-45f2fc3b79528f41.exe`。复核代理实际运行其 `--inspect`，并独立计算 EXE/ZIP 摘要、流式读取 ZIP 中的两个 EXE、核对全部 16 项安装器 sourceInputs。见[候选检查](text-artifacts-candidate-review-20261103.json)及[实际 inspect 输出](text-artifacts-candidate-inspect-review-20261103.log)。

| 项目 | 核对结果 |
|---|---|
| Setup SHA256 | `45f2fc3b79528f41c0919af79a38aa9b261d4a6a01f88a12aebd4ab97ddca66d` |
| ZIP SHA256 | `ba1ecd6da6c9315001eb6d61f0d14f301aca9405d4346fd95b71f19882c72516` |
| payload manifest SHA256 | `41cfb1f6b96be69c78c5c36c93128f7160c6ae586b3e4e5a8ff1d7d5216b6c46` |
| ZIP/载荷 | 6,328 ZIP entries，含清单；载荷 6,327 文件、201,828,703 字节 |
| Node | 11,884,544 字节，SHA `83297d6d18aa4e0847d09dcfcc345ba2459188f1c347ac2d0f0c35dd9354c4b0` |
| helper | 10,942,464 字节，SHA `cf03b5d14e55e613a2d2b2a1682a97b2bc492c59200155074b41573198e4a9b1` |
| 维护源 identity | `93fe5dccdd7fdee344180610faaae42a12154ef0d5f07f9279394df00e34b9bf`，16 项 sourceInputs 全部一致 |
| recovery script SHA256 | `134bf3659e9d58e36d5771800f6b69fdb02abe2aabdfe41e416072dd784cb0f5`，维护固定点未变 |

两个 ZIP 内 EXE 与冻结清单中的普通程序完全一致。主代理实际 WinPS 5.1 `--verify-payload` 输出 `verified_files=6327; bytes=201828703; powershell=5.1.26100.9711`，复核代理已读原日志，未重复全载荷校验。十档图标/版本检查属于主代理证据，本复核核其文件身份，不冒称独立重新提取全部 PE 资源。

旧 83a2 候选继续作为旧固定点保留，不能代表本轮文本代码。新候选仍为 `installationTested=false`、`codeSigned=false`；以上结果没有覆盖真实 UAC、SCM、机器 PATH 或生产卸载。

## 接受边界与后续目标

以下仍开放，不因本报告通过而勾选完整清单：

- 长错误原文：共享 adapter 对 `isError` 仍可能只返回截断 Err；保存失败或原文件缺失/损坏不得标为完整。
- 通用二进制：v2 服务/Controller/UI 合同及夹具通过，但实际 Node `file.read` 尚未输出对应二进制 artifact。
- 容量：上游 MCP transport 帧仍为 8 MiB，helper/Node 帧为 16 MiB；总产物通道上限不是 16 MiB 原始桌面结果的端到端实测保证。
- 模型消费：MCP 协议客户端成功不能证明真实 Codex 模型收到并使用全文/图片；该闭环尚未执行。
- CLI 文件发布：拒覆盖已实现；写盘失败可能留下部分新文件且报告失败，尚不是临时文件原子发布。
- 实际安装与宿主：UAC/SCM/SYSTEM/WTS、升级、卸载、重装、干净机与新候选全生命周期未验收。
- 产品：Lite/Harness 云端 Host、Reach Desk 装配、最终完整 Ray 部署及完整首版仍开放。本复核没有独立连接或检查 Ray，不对线上状态作独立确认。

本报告只声明以上冻结目标的限定复核结果，没有运行全仓文档验收，也不以本报告推翻主代理另记的全仓历史链接检查失败。文档经过人工文字审读；humanizer 此前未找到，未声称调用该工具。

四项独立证据与候选附加证据的字节数/SHA256已保存在[覆盖与证据摘要](text-artifacts-review-coverage-20261103.json)。实际实现与主代理执行记录另见[原始全文执行证据](text-artifacts-20261103.md)，任务状态仍以[任务清单](../task-checklist.md)为准。
