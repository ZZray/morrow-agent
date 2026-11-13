# 工具、任务和操作收据

作者：Ray Zhang（Ray）。更新：2026-11-04。状态：协议 v1 实施中；PNG 产物 v1、文本/二进制产物 v2；Desk 目标/调用映射 schema v3。

## 合同来源

机器可读请求合同由 `src/contracts/protocol.ts` 中的 Zod schema 生成，已登录客户端通过 `/api/v1/protocol` 读取。TypeScript 类型直接从 schema 推导。Rust 消费者须用同一协议夹具验证字段、默认值和拒绝行为，不能独立改变线上语义。

初始工具为 command.run、file.read、file.write、directory.list。节点只声明实际接通的能力；未声明的操作返回 capability_unavailable。后续按 T01–T07/R01–R07 增加日志、进程、桌面、产品 MCP 和 Agent 委托。能力声明用于描述实现，不新增运行时工具权限模式。

## 操作身份

控制端持久保存 requestId 和原请求再提交。服务对同一账户/requestId 返回原 operationId；更改目标、配对 epoch 或参数时返回冲突。操作固定 nodeId、epoch、payloadHash；服务领取生成一次 dispatchId。

payloadHash 是规范 JSON 的 SHA-256。对象键按 Unicode 码元字典序排列，数组保留顺序，字符串使用 JSON 转义；当前请求字段为固定 ASCII 字段，Rust 对照测试需核对最终字节。

桌面参数使用 `desktop.call.argumentsJson` 保存原始 JSON 字符串。服务校验对象、有限数字、合法 Unicode 和深度，但不重新序列化；Rust 先验证外层哈希再解析。MCP 的 `reach_desktop_call` 接收普通 `arguments` 对象，在控制端序列化一次并保存原提交，避免 Unicode 键序与指数数字在两种语言间产生不同哈希。

## 两类状态

| 层 | 状态 | 含义 |
|---|---|---|
| 服务投递 | queued、claimed、uncertain、acknowledged、cancelled | 是否排队、是否曾派发、是否观察到节点回执；不能直接表示工具实际成功 |
| 节点执行 | not_observed、received、running、succeeded、failed、cancelled、unknown | 节点原操作状态；最终结果须附真实工具或产物证据 |

领取在服务事务中从 queued 改为 claimed。领取超时、网络重连或服务重启不把它变回 queued。服务看到派发超时只能改为 uncertain；Node 查原操作和本地账本，不自动重放。

Node 在实际执行前持久保存完整输入绑定和 received，再保存 running/执行意图，然后产生效果。进程在执行意图后中断时保留 unknown；不能仅凭没有结果文件断言未执行。

已认证控制端在核对原进程/产物后，可调用原操作的 reconcile 接口，绑定原 dispatchId/payloadHash，提交唯一 reconciliationId、结论和依据。对账记录单独保存，原 unknown 事件保留；确认未执行时结算为 cancelled，不重新排队。未取得实际依据时保持 unknown。该入口为事后结果核对，不是执行前审批。

人工对账后到达的原节点回执仍须保持原事件 ID、顺序与原始执行状态转换；服务保存并 ACK 这份迟到证据，保留对账者的独立结论。节点不能用迟到 running 覆盖已经存在的节点终态，也不能因此重执行动作。

## 事件和取消

Node 先将输出和终态保存到本地 outbox，再上传。每操作事件序号从 1 连续增加，eventId 固定。同 ID/同内容重传返回原确认；修改内容或跳序返回冲突。收到确认后才能推进已确认游标。成功必须在 running 之后；终态不被迟到 running 覆盖。

控制端按 after 序号和 limit（1–200，默认 64）读取持久事件。服务同时按页字节数约束响应，返回 nextAfter/hasMore。服务响应缺失不丢弃原事件；客户端不得用空输出推断成功。大产物通过内容哈希和分段取回接口交付，不能塞进无限 JSON。

本地接收记录、状态变化和 outbox 在同一 SQLite 写事务中提交。Node 启动时将未结算记录恢复为 unknown；如果服务有原操作而本地证据缺失，则沿服务 last_sequence 附加 local_receipt_missing，不构造已经存在的旧事件，也不推断未执行。

当前命令输出为原始字节的 base64，合计上限 16 MiB；超限会终止所拥有的进程树并明确保留效果未知。file.read 按 offset/length 读取、每段最多 1 MiB。file.write 对既有文件通过同一个打开句柄校验与写入，保留 ACL/硬链接，完成后读回核对；它不是文件系统 CAS 或原子替换，中途错误及读回不符记为 unknown。Windows Job 已空仅证明进程停止，不代表先前效果已撤销。

取消排队任务可以立即确认 cancelled。取消已派发任务只设置 cancel_requested，Node 必须核对实际进程与工具结果后给出终态。取消轮询与结果上报独立于任务执行；终态取消不等于撤销已发生的文件或外部效果。

## 开发桌面与原始产物取回

已显式配置开发运行时的 Windows Node 声明 `desktop.describe` 与 `desktop.call`。describe 启动或复用一个持续的桌面实例，返回真实工具 schema、helperGeneration 与 sessionRef；call 必须使用当前代次，不能自动启动替代实例或重做动作。截图返回 snapshotId；后续动作消耗快照。普通调用成功后 helper 保持运行，回执不会声称进程树已经停止。维护停止、重配、取消和观察失败先关闭整个所属 Job，再交还宿主控制。

产物通过原 outbox 依次保存 `artifact.manifest`、连续 `artifact.chunk`、`artifact.complete`，再保存终态引用。PNG 保持 v1；UTF-8 文本和通用二进制为 v2。每块最多 64 KiB，单项最多 8 MiB，图片最多 8,388,608 像素；每操作至多 4 张图片加 4 项非图片，全部合计不超过 16 MiB。空文本/文件允许零分块。文本严格验证 UTF-8 与 Unicode scalar 数，保留原 BOM 和换行。

读取接口先校验原 operation 的账户归属；分块与整体 SHA、长度和顺序均须一致，终态引用必须属于原操作且已完整上传。`images` 只列 PNG，`artifacts` 列出全部引用；非图片不能借用图片 MIME。断线和重启只补传原事件。完整产物在操作 unknown/failed 时也能取回，操作结果不会因此改为成功。未完整产物不触发重执行；若节点已经提交终态，缺失内容可能无法补齐。

`reach_artifacts` 查询接收状态；`reach_artifact` 对 PNG 完整校验后返回 MCP image，对非图片返回清单与第一段。`reach_artifact_range` 按字节 offset/length 续读，单次不超过 64 KiB；切开 UTF-8 字符的单段不附伪造解码文本，原始 base64 保留。Controller 在 PNG 解码前检查唯一 IHDR、像素与调色板边界，当前不接受交错 PNG。

CLI 提供 `artifacts OPERATION_ID`、`artifact OPERATION_ID ARTIFACT_ID --output NEW_FILE`、`artifact-range OPERATION_ID ARTIFACT_ID --offset N --length N`。完整下载先核 SHA，再排他创建新文件，拒绝覆盖；写入失败可能留下部分新文件，不报告成功。管理页显示接收状态、分页预览文本，并在校验完整文件后发起浏览器下载；切页或退出后不显示/下载旧响应。

桌面 helper 将 MCP adapter 保存的长正文恢复为原字节，核本代目录、同句柄路径、bytes/SHA/scalar，再送入产物通道。[真实桌面/管理页证据](evidence/text-artifacts-20261103.md)已覆盖成功正文丢失 ACK、Node/服务双重启、CLI/MCP 同字节取回及浏览器下载；[此前图片链路](evidence/desktop-chain-20261102.md)保留真实中文输入/点击。后续[真实 Codex 图片识别](evidence/codex-vision-20261103.md)通过原 PNG 随机码/图形任务验证了模型消费；它不替代远端 Agent 委托。上游 MCP 帧 8 MiB 与 helper/Node 帧 16 MiB 仍是独立限制。SYSTEM/WTS 和完整 T06 仍未验收。

长 `isError` 通过共享 MCP 的 `call_tool_with_evidence` 获取同一次调用的 typed 证据，绑定调用方 server/tool/callId；普通 `AgentTool::execute` 仍返回原有有界 `AgentError::Tool`。超过 11000 字符的错误正文也尝试保存，保存失败标明 truncated，helper 不将摘录冒充全文。归档的是 adapter 合并后的错误文本（含 structuredContent 的序列化），不是原 MCP wire 字节。错误全文不重复放入终态的 structuredContent，也不解析为 UI labels；截图错误保持 failed，动作错误保守记 unknown，均不生成新快照并退役 helper。身份关联不是幂等执行 API；同请求重试仍依赖原 Node 账本，不能为补证据再次调用工具。[长错误执行证据](evidence/error-artifacts-20261103.md)覆盖重启恢复和大型错误元数据反例。

## 文件范围产物

`file.read` 保留原 inline `contentBase64` 返回，也可显式传 `resultFormat: "artifact"`。两种形式每次最多读取 1 MiB；artifact 表示本次捕获的字节范围，`artifactScope` 为 `file_byte_range`，不是源文件整包。来源记录包含 path、workingDirectory、offset、length、totalBytes、nextOffset、eof、capturedAt 和 fileVersion。`file.capture` 来源先于清单写入 outbox，即使完整产物之后的成功终态入账失败，仍能核对来源并保留 unknown。

后续范围可带 `expectedFileVersion`（64位小写十六进制）拒绝读取已经改变的来源。版本是文件身份、大小和时间元数据的摘要；Windows 还含 ChangeTime，能识别保持长度并恢复 mtime 的改写。它不是整个源文件的内容 SHA，也不承诺跨多次操作的不可变文件快照。Windows 单次捕获使用同一只读共享句柄，核对读取前后版本，再从同一缓冲区生成产物；Unix 实现尚无本轮实机证据。

上述任一新字段均要求节点声明 `file.read.artifact`。服务在提交和实际领取的事务中检查当前配对 epoch 的节点能力；暂不支持的请求保留 queued，兼容请求仍可领取。新字段无默认值，旧请求的序列化与哈希保持。原 requestId 重试查询原操作，不重新捕获文件。[文件产物证据](evidence/file-artifacts-20261103.md)覆盖源文件删除后的恢复、跨范围拼接、改写/替换拒绝和部分入账故障。

## 委托任务

Reach Desk 的本地设备候选先通过现有 Node 操作接线：每个云端工具调用保存用户/消息/Task/Run/native call ID、原参数、固定目标和规范化命令，再按确定的 requestId 投入原 Reach 队列。schema v3 保存跨库映射；服务已提交而 Desk 尚未保存 operationId 时，重启按原 requestId 查回并补足关联，只取消原操作、不重新提交。读取失败不会取消被读取的运行中操作。

页面选择作用于下一条消息，原消息显示自己的设备和工作目录，操作状态来自原 ledger。已完成且结算依据完整的设备调用可以随原 Task 关闭后沿同一 Session 继续；运行中取消通常保留 unknown，不能把进程已停止当作效果已撤销。工具 JSON、事件、结果和产物按有界范围读取，UTF-8 页必须推进游标，长度不足以容纳下一个字符时明确拒绝。该文本/文件接线本身不代表 R01–R07 委托，图片输入的后续证据另列。

后续[现场委托合同](agent-delegation.md)引入`agent.delegate`及服务schema v2的`agent_calls`：内层调用创建并唯一claim原账本的真实child operation，不另建队列，不改父Dispatch或混用子产物索引。父成功/对账核完整child集合及未知状态，保留Task待复核；父取消和deadline传给子control。当前只有[服务合同分项](evidence/agent-calls-20261104.md)，Rust Node还不声明此能力，现场Host/组织relay/完整恢复未接通。

Task/Session/Run 使用 Lite/Harness 原身份与累计预算。Reach Host 实现实际效果验收和反馈续作；模型最终文本、HTTP 成功和 Run 结束都不能直接作为业务 Task 验收。参考图以真实图片内容传入模型，文本描述或文件名不能替代图片。

2026-11-04 的图片候选另增加 `reach_image`：只读取当前账户、固定目标/epoch 和原 operation 已完整入账的 PNG，核原 manifest、分段及整体摘要、尺寸和解码后保存到本 Task evidence。通过共享 JSONL 的 typed image 引用送入模型，不借正文 base64 冒充图片。正常候选核原生图片证明，停止时核完整原生块与原图字节；读取失败、图片预算不足或传输未知均不重拍。每消息原图累计16 MiB，单图仍8 MiB。新旧侧车各自固定 SHA/profile，旧 Task 关闭仍使用原镜像。受控大图、摘要/停止/归档续聊及后续[真实截图到Desk/provider/Chrome同字节](evidence/desk-image-preview-20261104.md)分别有本地证据；组织视觉模型和完整X03/R07仍开放。

新消息准入前检查原生历史容量并预留下一 Run 空间：当前新镜像历史输入预算1 GiB，预留128 MiB；旧镜像64 MiB，预留16 MiB。预检最多14,000项和96,000条原始消息，低于后续原生检查的16,384项/100,000条上限。超限返回明确提交拒绝，保留原会话和原记录，不创建替代 Session 或未结算 Task。

任务上下文、候选技能和持久知识分别保存来源、版本和作用域；只有经过验证与审核才能晋升复用。[现场合同](agent-delegation.md)先冻结服务关系，组织模型、Node Host及原Task恢复随R01–R07继续补齐，不复制Agent循环。
