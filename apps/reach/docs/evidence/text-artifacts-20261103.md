# 原始全文、范围读取与管理页

作者：Ray Zhang（Ray）。日期：2026-11-03。

本执行点已把桌面后端保存的成功长正文接到原操作产物通道，支持 CLI/MCP 范围读取及管理页预览、校验后下载。真实桌面链路、浏览器下载和完整候选已验证。它不是完整 T06 验收：长错误原文、实际文件工具的二进制产物、模型实际看图等仍未闭环。基础清单保持 0/52，Reach Desk 0/5；没有提交、推送或更新线上。

## 来源与候选

[冻结清单](text-artifacts-inputs-20261103.json)包含 69 项源码/构建输入、2 个普通程序和 16 项执行证据。清单 SHA256 为 `a8d27f6e688de21b5cb3445fef07ea4b48b40f5279b9a2ac6c6401a07a0d2db0`；source identity 为 `289c29ebafc39375db265ade0b107bb29413cb27d336922585d31e92b14e75d7`。快照目录为 `work/text-artifacts-source-9d181291-d2ba-4eab-b300-4fa4d9452c75`。

新完整安装候选：

`outputs/windows-complete-ba1ecd6da6c93150-93fe5dccdd7f/Reach-Setup-0.1.0-preview-45f2fc3b79528f41.exe`

| 项目 | SHA256 / 结果 |
|---|---|
| Setup EXE | `45f2fc3b79528f41c0919af79a38aa9b261d4a6a01f88a12aebd4ab97ddca66d` |
| 内嵌 ZIP | `ba1ecd6da6c9315001eb6d61f0d14f301aca9405d4346fd95b71f19882c72516` |
| Node 普通程序 | `83297d6d18aa4e0847d09dcfcc345ba2459188f1c347ac2d0f0c35dd9354c4b0` |
| 桌面宿主普通程序 | `cf03b5d14e55e613a2d2b2a1682a97b2bc492c59200155074b41573198e4a9b1` |
| 便携运行时清单 | `6cecc584a2c8cb755c277bf8a0a6be4c08403898525d7ef41fb477083ef5af0a` |
| 实际 EXE 内嵌校验 | WinPS 5.1 私有 stdin 校验 6,327 文件、201,828,703 展开字节通过 |
| 图标 | [10 档 PNG 原字节及版本属性](text-artifacts-setup-icons-20261103.json)一致 |

Node/helper 是本轮测试的普通 dev profile 程序，Setup 为 release profile；不以测试程序冒充普通程序。原 83a2 候选保留。维护入口源码 identity 仍为 `93fe5dccdd7fdee344180610faaae42a12154ef0d5f07f9279394df00e34b9bf`。此次只更换 Node/helper 载荷，维护实现沿用上一固定点。本候选 `installationTested=false`、`codeSigned=false`；没有执行真实 UAC/SCM 安装或机器 PATH 写入。

## 实现合同

- PNG v1 保持兼容；新增 v2 UTF-8 文本和通用二进制文件。每项至多 8 MiB，以 64 KiB 分块；每操作保留 4 个 PNG 加 4 个非图片、总计 16 MiB 的通道上限，空文本/文件合法。
- 原内容位置、MIME、完整 SHA256 与原操作绑定。`images` 仅含图片，`artifacts` 列出全部引用；终态保留 failed/unknown 的真实状态，不因能取回产物改成成功。
- 共享 MCP adapter 保存成功全文时附原始字节数和 SHA256。helper 只读本代独占目录的直属普通文件，核同一打开句柄的最终路径、原字节数/SHA、UTF-8 和 Unicode scalar 数；恢复正文后先识别 labels/捕获错误，再附件化。存在已保存全文时，50,001–65,536 ASCII 字符也必须走产物通道。
- Node 在第一条 outbox 写入前检查整组附件、索引、大小、终态体积；含内容的 failed/unknown 与成功一样核 helper generation/session。丢失确认只重传原事件，不重新执行动作。
- CLI 支持 `artifacts`、`artifact --output NEW_FILE`、`artifact-range`；下载校验整体 SHA 后以排他创建写入新文件，拒绝覆盖已有文件。磁盘写入失败可能留下部分新文件，不报告成功；尚未改成临时文件原子发布。
- MCP 的 `reach_artifact` 对图片保留 image 返回，对非图片给清单和第一段；`reach_artifact_range` 按字节续读。单段切开 UTF-8 字符时保留原 base64，不用替换字符伪装可读文本。
- 管理页显示产物类型、大小、完整接收状态；分段文本预览连续解码，空文本明确显示。完整文件校验后才交给浏览器下载；切页、刷新或退出后的旧响应不显示、不触发下载。未完整收到的内容不提供下载，也不暗示一定会继续传输。

UI 沿用已有面板、按钮和静态反馈，无新增动画。体贴之处是把“原动作的结果未知”与“某份证据已完整收到”分别表达，避免用一个绿色成功状态掩盖另一项未知。应用 emil-design-eng 与 ui-delight；没有另造导航或品牌样式。

## 实际执行

| 检查 | 结果 | 证据 |
|---|---|---|
| 类型与管理页编译 | 通过 | 最终 `bun run check`、`bun run build:admin`；dist 摘要已冻结 |
| HTTP/Controller/浏览器消费者 | 12/12 | `work/text-artifacts-ts-r2.log` |
| 最终 UI 文案修补后受影响组 | 7/7，属于上行子集 | `work/text-admin-final-r3.log` |
| Node transport 单测 | 3/3 | `work/text-node-tests-r2.log` |
| helper capture 单测 | 4/4 | `work/text-helper-tests-r2.log` |
| shared MCP result property | 1/1 | `work/text-mcp-tests-r2.log` |
| 三个变更目标 Clippy | 通过，`-D warnings` | `work/text-{node,helper,mcp}-clippy-r2.log` |
| 普通程序真实桌面链路 | 3/3，96.149 秒 | `work/text-desktop-chain-r2.log` |
| 受影响原生 Controller 回归 | 2/2，84.453 秒 | `work/text-node-integration-r2.log` |
| 完整包与实际 EXE 校验 | 通过 | `work/text-complete-build-r2.log` 及候选目录的 package/inspect/verify |

真实桌面证据目录 `work/desktop-chain-7ebeb16c-a851-4ea9-9e87-324b6b2e68fc`。前两项保留原图取回、中文输入、单击、取消、Node crash、错误捕获和 helper 退役行为。新增正文由真实桌面 PowerShell 工具产生，效果文件只追加 `once`；首次分块已到服务但确认被丢弃，随后重启 Node 与服务，再从原 outbox 续传。

该操作 ID 为 `d866b042-b673-497f-8d64-b6919767c96c`，正文 378,025 字节，SHA256 为 `eecaa1587bc8321a9edb45592a45f3bd790ba57e1330ff5aadc6b2c0d4b977af`。CLI 下载与 adapter 原落盘逐字节一致；已有路径二次下载拒绝覆盖；MCP 首段及后续范围与同一原文件一致。对应 `full-text/full-text-evidence.json` 和实际文件均保留。另两项原生回归验证工具列表、真实命令/文件效果及超过 2 MiB stdout 的分页取回；命令输出仍为原 events 合同。

## 浏览器实测及来源边界

主代理通过 Cua 操作隔离本地站点 `http://127.0.0.1:18915/`。此处的操作回执为合成夹具，用于 UI；不替代上一节真实桌面执行。工作目录 `work/text-browser-6ee0835e-5d51-4224-89a3-9e102e0249c2`，保留 `metadata.json`、`range-requests.jsonl`、`expected.txt` 与截图。

实见中文、emoji、BOM、组合字符及 CRLF 的两段文本，最终显示全文校验通过。浏览器实际下载到：

`C:/Users/loveu/Downloads/d98bc208-58a4-44b2-99dd-f11bb08fb698-ac48af24-1b8a-4efd-967e-a361e8d5df7d.txt`

93,503 字节，下载文件与 expected SHA256 均为 `4cff3eabc4846b2de7e115c5db3ead4b56b558b11a99843389d2fd1c7d0be1b3`。空文本显示“（空文本）”及 0–0；注入坏分段 SHA 后显示“原始产物分段校验失败”。未完整项显示“未完整收到”，没有预览/下载入口。

最终两次延迟响应在 06:47:42.182Z（切页）和 06:48:27.110Z（退出）。先清理旧 release/held 标志，再设置 hold；Cua 发起下载后返回列表/退出，确认服务器已写 `held`，注册 download 观察器后释放响应。两次 2.5 秒观察均无下载；列表/登录页保持正确，range 日志各只有 offset 0，未继续请求下一段，下载目录仍只有原成功文件。这是主代理工具会话观察，未保存浏览器 trace；请求日志只能佐证读取范围，不能独自证明 UI 行为。

![本地原始产物预览](../../work/text-browser-6ee0835e-5d51-4224-89a3-9e102e0249c2/preview.png)

## 已保留的问题与未验收范围

独立源码复核先指出全文缺原始 SHA、较短已截断正文漏走 artifact、failed/unknown 内容缺身份核对；三项已修并以 r2 Rust/真实桌面验证。UI 复核指出 `complete=false` 不一定表示仍在传输；终态后可能永久不完整，已改成事实标签并通过最终受影响测试。

首次 shared MCP offline metadata 缺 proptest，联网补齐测试依赖后成功；lock diff 只新增已有 sha2 依赖边，未升级锁定包。首次浏览器夹具用不合法 platform，服务拒绝并退出，改为合法 Windows 测试节点。早期延迟探针中一次等满 20 秒触发请求超时，随后 release 标志残留；这些探针不计为成功响应竞态证据，最终两次清理标志并核 held 后重测。旧 r1 Rust 测试不用于证明 r2 修补。

- adapter 对 `isError` 长错误仍只给截断 Err，无法取回原全文；保存失败也不能标为完整。helper 对缺失/损坏原文如实失败并退役。
- 通用二进制的服务/Controller/UI 合同已实现；实际 Node file.read 尚未输出二进制 artifact。
- 上游 MCP transport 帧仍为 8 MiB，helper/Node 为 16 MiB；产物通道总限额不是桌面后端单次实测容量保证。
- 未完成真实 Codex MCP 模型看图、SYSTEM/WTS、UAC/SCM 安装/升级/卸载/重装/干净机、Lite/Harness 云端 Host、Reach Desk 装配及最终完整部署。
- 本轮只读核实 Ray：current 仍 `/opt/reach/releases/20261102-sso-stable-05d25e8c84eb`，Go SHA 保持 `3b21deba87a5df87b19942a7b9557ab842ff92147e5103125d1d4a2b45fe7bd9`，Reach/Ray 均 active，Node/操作/事件 1/2/10，活动操作 0。未更改线上。

独立最终复核见 [text-artifacts-review-20261103.md](text-artifacts-review-20261103.md)，报告 SHA256 `45e35918168f4d77fcfe2794f30fab5f3af2036b41f12ea466a7aaa5ff537f4f`。本限定执行点通过，无新增确认阻断；主代理完整回读报告并核摘要、实际测试、产物与冻结清单。独立核验将 Node/服务账本 6 块重组为同一原文，11 条事件一致、全部 ACK，效果文件仍为 once；独立报告不替代主代理执行或完整产品验收。

humanizer 本机先前未找到，本文人工审读；不声称已调用。全仓 `python scripts/verify_bootstrap.py` 仍失败，包含既有历史/外部路径及 work 运行时 NOTICE 链接，日志 `work/text-bootstrap-doc-check.log` 保留，不能报告全仓文档通过。[本轮文档检查](text-artifacts-doc-check-20261103.json)单独核对改动文档链接与冻结来源；全部清单仍以任务文档为准。
