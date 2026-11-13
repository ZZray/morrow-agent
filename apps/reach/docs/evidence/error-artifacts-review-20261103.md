# 长错误全文独立复核

作者：Ray Zhang（Ray）。日期：2026-11-03。执行者：独立 Codex 子代理 `/root/reach_plan_review`，应用 `ara-git-review` 与 `ara-rust-core-review`。

**结论：本限定执行点通过；两条 P2 溢出路径已关闭，无剩余确认阻断。** 接受有界长 MCP `isError` 正文保存、同一次调用的类型化证据、失败/未知状态保留及原产物取回。完整 T06、真实模型消费、安装版和首版全验收仍开放；基础 0/52、Reach Desk 0/5 不变。

## 固定目标与覆盖

目标为 `dev/90f2b1c` 基线上的未提交 WIP。[最终清单](error-artifacts-inputs-20261103.json) SHA256：`ada0daa65b4f468712b61ae0fea68627ae416d2a247cf35a534863eaa22b625d`；sourceIdentity：`4a5f22a08c64516b3b75f6f3317816294cd7d1d92ab72d796990f5710a43c21a`；快照 `work/error-artifacts-source-550775d6-2b2b-4077-867f-87eefd4531bf`。

已独立重算清单和 sourceIdentity，核当前来源及快照 75/75、普通程序 2/2、执行证据 22/22 的 SHA/字节数，全部一致；相对[文件产物固定点](file-artifacts-review-20261103.md)恰为 9 项增量。[逐项核对](error-artifacts-review-inputs-20261103.json)保留结果。

- **reviewed**：共享 MCP 的 `src/{tool,lib}.rs`、`tests/{result_props,stdio}.rs`、README；Reach 的 `desktop/src/{main,capture}.rs`、`tests/desktop-chain.integration.test.ts`、`tests/fixtures/error-mcp.py`。同时检查 Client 请求/取消/关闭、helper 身份和生命周期、Node 产物预检及原 outbox 调用链。
- **scope-excluded**：其余 66 项只核身份或相关调用段，不重新宣称完整语义审计；Core、Provider、全部平台和安装维护不扩入本点。
- **skipped**：本代理不重跑 Cargo、TS、桌面测试、完整载荷校验或安装。测试由主代理执行；本代理读原日志、独立读取数据库/文件及执行候选 `--inspect`。

## 两条缺陷关闭及合同

| P2 路径 | 最终修补与证据 |
|---|---|
| 错误 structuredContent 已拼进全文，又完整复制到 details；正文虽可保存，终态仍超过 Node 大小限制 | `isError` 的 details 不再重复内联 structuredContent；保存成功和失败均有大对象测试。实际 helper/Node 受控后端取回 1,260,033 字节全文，终态仅 24,306 字节 |
| 错误正文末尾的 `Reach UI Labels` 数组被当成标签再次复制到终态 | helper 在 `is_error` 时直接令 labels=None；实际 helper/Node 取回 1,100,037 字节标记正文，labels=null，终态仅 11,497 字节 |

`call_tool_with_evidence` 与普通 `execute` 共用一次 `client.request`；server、原工具名和 call_id 来自实际调用参数。普通接口仍把 MCP 错误映射为 `AgentError::Tool`，取消和未知效果规则保持。callId 关联不等于重试幂等；helper 的已见调用集合和 Node 原账本继续负责去重。

错误超过 11,000 Unicode scalars 时尝试保存完整 UTF-8 字节、SHA 和字符数；helper 校本代目录、同句柄普通文件与原摘要后附件化。保存内容是 adapter 拼接的错误文本，包含原 structuredContent 序列化规则，**不是 MCP wire 原文**。保存失败、文件损坏或丢失不产生完整证据。`isError` 不生成成功/新 snapshot；截图保留 failed，动作保留保守 unknown，错误后退役 helper。

## 主代理执行与独立原件

| 已读执行记录 | 结果与计数边界 |
|---|---|
| `error-mcp-tests-r1.log` | 初轮共享 MCP 26/26；中断 property 的源码配置为 256 cases，计作 1 个测试函数 |
| `error-mcp-result-tests-r3.log`、`error-mcp-consumers-r4.log` | 修补后 result 2 + stdio 11 + Harness 2 = 15 项受影响重跑；属于前述 26 项，不相加报 41 项，也不称最终重跑全部 26 项 |
| `error-helper-tests-r3.log` | helper 7/7；最终 labels 分支另外由下行普通程序实测覆盖 |
| 两个 fmt、两个 Clippy、TS check、普通 helper build | 主代理记录通过；doc-test 实际 0 项，不计成功用例 |
| `error-desktop-chain-final-r4.log` | 最终普通 helper 跑全部 6/6，156.678 秒；旧 3 项与新增 3 项均在本轮重跑 |

最终原件目录 `work/desktop-chain-563b2029-7850-47bc-949a-800ae7a2ac78`。[独立只读原件核验](error-artifacts-originals-review-20261103.json)覆盖 11 个操作的 Node/service 原事件及相关真实文件：事件 ID、种类、数据、连续序号一致，全部 ACK。

| 场景 | 独立核对结果 |
|---|---|
| 真实 Windows-MCP Screenshot 长 schema 错误 | 7 事件、2 块、114,243 字节；原保存文件、CLI 下载及两端分块一致，终态 failed，无 succeeded |
| 真实 Windows-MCP PowerShell 长 schema 错误 | 7 事件、2 块、114,242 字节；同样逐字节一致，终态 unknown，无 succeeded |
| 受控 structured / labels 错误 | 25/22 事件、20/17 块；1,260,033 / 1,100,037 字节与夹具定义及下载一致，两项均 failed、labels=null、无重复 structuredContent |
| 保存目录被文件占用 | 3 事件、failed、truncated=true，保留 evidenceError；无 artifact 事件，占位文件内容未变 |
| 旧成功正文/图片/中断回归 | 378,025 字节正文、3 份原 PNG 与下载/账本一致；点击效果为 1；取消及 Node crash 均保留 unknown、效果文件恰为 once、结束文件不存在 |

独立核对受控后端 calls.log 恰为 2 次，5 个 Python 副本与固定解释器源字节相同，夹具模块与冻结源码一致，隔离 `_pth` 正确。受控后端使用实际 helper/Node/HTTP/outbox，但其大 structured/labels 响应是故障夹具，不能称真实 Windows-MCP 产生了这两种响应。

ACK 丢失、双重启及同 requestId 不重放的时序由测试体和主代理执行日志证明；本代理只读核其保留的原件，没有重演故障。两项真实长错误均来自 **schema 拒绝，PowerShell 动作没有实际生效**；其 unknown 证明保守状态合同，不等于实测“副作用发生后工具返回 isError”。旧取消/crash 的 once 效果是另两个场景，不混作该证明。

## 完整候选与边界

新候选 `outputs/windows-complete-1fab0ba3b8239354-93fe5dccdd7f/Reach-Setup-0.1.0-preview-60a6bfdfd7879528.exe`。已独立运行实际 EXE `--inspect`，退出 0、stderr 空；核 EXE/ZIP、ZIP 内两 EXE 与 payload manifest，以及全部 16 项安装器 sourceInputs。见[候选核对](error-artifacts-candidate-review-20261103.json)和[实际 inspect](error-artifacts-candidate-inspect-review-20261103.log)。

| 对象 | SHA256 |
|---|---|
| Setup | `60a6bfdfd7879528231a2300533f6c99ebdd21168dd584b11992a164e85d2b80` |
| ZIP | `1fab0ba3b823935428aca08b0bafe0ad2b7531f5451894a607792d3bdf24580f` |
| Node，11,924,480 字节，沿用 | `69b14cfebbff4dd63fe755bd870afe5d83e469fb25f5eb260a432c5dc4231727` |
| helper，10,978,304 字节，新构建 | `a679c452c8741fe3a83d3006bea1627aad6a520786d89142d190db4a05e657d1` |
| payload manifest | `dd77efb19113d9be7f08fb0bc3d91ba0032186993b0f74d2e89d3754a5a89c16` |

ZIP 共 6,328 entries（含清单）。主代理实际 WinPS 5.1 内嵌校验 6,327 载荷文件、201,904,479 字节，并核三个 EXE 的十档图标/版本；本代理读原记录，不宣称独立重复全载荷或全部资源提取。安装维护源 identity 仍为 `93fe5dccdd7fdee344180610faaae42a12154ef0d5f07f9279394df00e34b9bf`。

候选仍未签名、未安装。本点没有验收 UAC/SCM/SYSTEM/WTS、升级卸载、干净机、真实 Codex 模型使用全文/图片或 Ray 更新。MCP 上游 8 MiB 帧及既有产物大小界限继续适用；不承诺无限错误正文。没有以文档链接检查代替全仓验收，也不覆盖既有全仓历史链接失败。文档为人工审读，未调用缺失的 humanizer。
