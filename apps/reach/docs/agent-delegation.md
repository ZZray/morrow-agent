# 现场 Agent 委托合同

作者：Ray Zhang（Ray）。日期：2026-11-04。状态：普通 Windows Node 文件/命令、跨 Run 实际截图、闭合预算、模型 owner/停止及原 Task 原生续跑已有本地分项；恢复先核对、实际准入后 active，最终原件与事件同事务释放。完整恢复矩阵、R01–R07 及生产安装仍开放。本阶段禁止服务器访问、远端模型探测及部署。

本合同沿用[工具与收据](tools-tasks.md)。源码权威为 `src/contracts/protocol.ts` 的 `delegateSchema`、`delegatedCallSchema`及`src/contracts/agent-review.ts`的候选/反馈合同，服务关系与生命周期由 `src/service/agent-calls.ts`和`agent-reviews.ts`实现；模型预占和流式边界见 `src/service/agent-model-store.ts` 与 `agent-model.ts`。普通Node Host见 `src/node/agent.rs`、`agent_relay.rs`。新增能力不进入工具权限模式；Node仅在固定侧车配置存在、镜像SHA匹配且服务已配置组织模型时声明 `agent.delegate`，默认基础包不会凭目录存在就声明可用。

## 父任务与原操作

控制端沿现有 `/api/v1/operations` 提交 `agent.delegate`，保留稳定 requestId。请求包含 Session UUID、设备绝对 cwd、目标、来源原文/版本/SHA，以及 Run、模型调用、工具调用、时间和输出预算。来源原文合计最多64 KiB，各来源ID唯一，服务核原UTF-8字节摘要；来源是任务资料，不是额外操作授权，也不自动晋升组织知识。

父 operation 固定账户、Node、配对 epoch、请求摘要和唯一 dispatch。Host以父operation ID作为Task ID，创建并保存独立的初始Run UUID，同时固定原dispatch、侧车、路由和原生Session；实际实现采用单独Run UUID，替代早期“直接把dispatch用作Run”的方案。服务同一Node/epoch/Session中的未结算父任务或子操作阻止新委托；重复原requestId仍返回原操作。

服务另持久保存root Task、current execution和generation；首次execution=root/gen1，首次claim固定原deadline。显式恢复登记创建新的operation和原root映射，旧command/hash/事件不重开。模型/Run/child/review预算键继续沿root；认证、回执及取消绑定本次execution。当前Task投影不把旧root的unknown改成新attempt状态。

模型最终文本、Run 结束或父 `succeeded` 都不是业务 Task 接受。正常交付结果必须保留 `taskAccepted:false`、原 Task/Session 和 `status:awaiting_review`。本地控制端结合源码与原子操作证据判断目标是否完成。

## 工具说明与任务来源

R04 的本地实现沿用 `sources`，不另建技能传输或工具授权系统。每项仍保存 `id/kind/source/revision/sha256/text`，摘要仅核原 UTF-8 正文；整个派发摘要同时绑定元数据和适用要求。`revision` 是调用者提供的准确来源版本，不代表 Node 已安装或自动核对了组织技能仓库。

来源可选携带 `requirements`，存在时须完整提供以下字段：

```json
{"protocolVersion":1,"toolContractVersion":1,"platforms":["windows"],"capabilities":["file.write"]}
```

平台是 `windows/linux/darwin` 中的适用集合；能力须全部包含。`agent.guidance.v1` 明确表示协议1和工具说明1，hello 的 `version` 仍是产品版本。服务提交时按当前 Node 声明核对；恢复提交按 root 原来源核对，拒绝会回滚新 operation 和 generation。派发前再读最新 hello：换回旧程序或缺能力时保留同一 queued operation，无 dispatch；`result_json.type=agent_dispatch_blocked` 是临时等待诊断，不是业务终态或消费收据。后续兼容操作仍可派发，能力恢复后派发原 ID 并清诊断；取消和解绑也清诊断。

普通 Node 在写 `running` 前以当前进程的配置能力再次核对。不兼容返回 `failed`、`started:false` 和逐来源问题，不建本次 Agent 目录，不启动侧车、模型或工具。恢复时此处只表示本次 execution 未开始；原任务效果、fence、预算和恢复归属保留。配置能力只说明已配置，不证明 helper 文件此刻可访问或桌面已解锁；工具自身仍按原合同报告实际失败。

`src/contracts/agent-guidance.ts` 从 `basicCommandSchema` 输入合同生成六种基础命令参数；运行 `node scripts/build-agent-contract.ts` 生成 Rust 内嵌的 `agent-tool-contract-v1.json`，`--check` 与测试检查漂移。说明补充路径 NUL、有限 JSON 对象、完整参数1 MiB运输上限、字节/base64、相对 cwd、版本守卫、桌面 session/snapshot、原结果读取及未知效果不可重放等语义。JSON Schema 提供结构，额外语义仍由服务校验。

新任务将说明、启动时环境快照、原来源和工具合同 SHA 放入真实模型输入及 `task.json`；后续 Run 保留原来源。原生恢复复制原保存的 `start.tools/objective/guidance`，只追加既有恢复指令，不把新版工具说明换入旧任务。未带 requirements 的历史来源仍可用，也不被推断成已验证适用。资料不会自动安装或晋升为持久知识；R05 另行验收。实际受控模型链和旧程序任务恢复见[本地证据](evidence/agent-guidance-20261104.md)。

## 子操作与一次执行

跨 Task 的候选资料、实际验证、Controller 审核、采用/撤销及完结证据等级由[资料合同](source-library.md)维护。它复用原 Task/Session/Node/账本，不自动导入 Core 候选，也不新增工具权限模式。

内层工具调用使用原 Reach `operations`、`operation_events` 和 Node outbox，不另建领取队列。v2 引入父/Run/native call 到 child 的 `agent_calls`；v3 增加模型路由、预占和共享 Run；v4 新增 `agent_run_reviews`；v5 在原 `candidate_json` 保存普通 Candidate 或 BudgetStopSnapshot；v6 新增 `agent_run_budgets` 及 `agent_budget_reconciliations`；v7 新增服务实例、模型 owner 和 stop；v8 新增 root/current execution 及 child 执行归属。v9 增加恢复 plan/receipt、逐请求模型解释、Run 注册/准入 owner、复核发布归属及最终释放记录。旧库只回填可推导的 gen1 注册/发布，不造 native admission；已有必需关系缺行或冲突拒绝重开。原模型行/owner/事件保留，迁移同事务、失败整体回滚。新模型 owner 锁协议为9，既有协议7只能证明原 gen1，不能推断后继归属。当前服务 schema 为 **v11**，v10 的只读 finalization 记录保留；v11 新增资料/关联和普通完结标记，模型 owner 协议仍为10。见资料合同与后文只读收尾合同。

Node 通过 `POST /api/v1/node/agents/:parentId/calls`，携带父 dispatch/hash、Run UUID、native call ID、工具名、原参数JSON字符串与其SHA。当前内层工具为 `reach_execute`，只接受基础命令/文件/桌面操作，不递归创建委托。`argumentsJson` 是原调用JSON字节，SHA先于解析/补默认值核对；不能把重新序列化的数值或不同原文冒充同一次调用。

创建流程在同一 SQLite 事务中核父身份和运行状态，预占工具次数，创建原 child、生成其唯一 dispatch、改为 claimed，并插入关系。子操作不会以 queued 状态对普通poll可见。任一步失败均回滚，包含嵌套提交的audit记录；重试同一调用返回原 child/dispatch/current 与原父截止时间，不重新claim。更改原参数、工具名或原父依据返回冲突。父停止、解绑或超时后，原调用可继续取证，新调用拒绝。

相对文件路径以父固定 cwd 解析，命令 cwd 必须一致；不限制工作目录外的完整绝对路径。子命令持久保存实际执行路径和超时上限，再计算原派发摘要。每个 child 有独立产物编号和现有4图/4文件/16 MiB产物上限；同一委托两次截图可以各用 index0，父结果只引用 child ID，不把子产物重新入账到父操作。

Node Host先 `Ledger.accept(child)`、保存running/执行意图，再调用原worker/Desktop。当前文件/命令链路已经使用真实子Dispatch、原Node outbox和实际worker。子终态先落outbox，再等原终态ACK，才生成侧车 `operation_receipt` 并回复；上传永久失败会停止后续效果，重启仅补传原事件。重复调用若本地已有可靠终态，只读取原件；原received/running/unknown不得因丢失响应重新执行。JSONL回调的原arguments字节顺序通过RawValue保留，不把Reach用于派发摘要的排序序列化改成preserve_order。

child另记录创建execution及generation；control和取消沿该执行，deadline沿root。跨execution重取准确原child须核归属，并返回evidenceOnly与原execution/gen，不构成新效果准入。取消root是定位当前attempt的特例；取消非root旧attempt只处理本代child。

## 预算、取消与父结算

服务按父命令限制最多16个子操作、4个Run、32次模型请求，以及从父claimed时间算起的原截止时间。`agent_runs` 同时累计工具、普通模型及摘要模型请求，不能用没有工具的Run绕过预算。子命令超时不能长于父剩余时间，子control同时返回原父截止时间；父取消、终态或截止时间到达，都让子control报告停止。该检查不把原成功回执改写为取消，也不声称已经撤销效果。

可选`runCallLimit`固定每个Run的模型请求上限，须在1至maxCalls内；省略时保留原行为。Task总预占与当前Run预占在同一事务检查，reserved/streaming/unknown等已预占状态均计数，不退款。显式cap时Node设置原`start.run.max_calls`并启用`budget_stop_review=review_closed_tool_round`，Task的`maxCalls`、Run次数、工具/输出额度与原deadline不变；后续Run仍受剩余Task额度约束。

服务持久保存每个Run首次`reserved_cap`，以及在恢复核原件时绑定的`admitted_cap`和单调`charge_floor`。Task逻辑消费为各唯一Run的max(实际预占,floor)之和，现有model/child/review准入同读该账本；普通未恢复 Task 的 floor 仍 0；原生恢复在锁内核原件后写入累计 floor。旧库迁移只推导服务cap，admitted_cap保持null；旧v5曾允许余额0的无模型预占槽，迁移保留UUID/顺序及cap0，新注册仍需正余额。

内部`recordNativeConsumption`不单独授权恢复；schema9 的 reconcile 事务在 Harness 锁内 Host 核完整原件与效果后调用：缺observation按原准入全额扣，精确空前缀只覆盖未admitted；已admitted零调用Run仍占槽。按原Run单调floor去重，不按attempt叠加，不退款；不能据消费receipt清unknown或放行新执行。服务分项与synthetic输入边界见[本地消费证据](evidence/agent-consumption-20261104.md)。

父 `succeeded` 必须由服务重新读取完整 `agent_calls` 集合：不存在运行中或unknown子操作，结果引用集合与原child集合完全相同，且Task仍待复核。模型请求须 `stream_complete`，或由本代恢复 receipt 按准确原请求/owner/stop 摘要解释历史运输；新 unknown 仍阻挡。流完整不代表客户端消费、业务成功或Task接受。通用reconcile入口执行相同成功检查；已有child或模型预占的父不能声明 `not_executed`。子操作的原unknown事件、单独对账结论和后来取得的证据分别保留。

Node保存父running后等待服务ACK才启动侧车。独立JSONL读取器在工具执行期间继续处理取消；父取消、控制丢失、绝对剩余时间、host stop及uploader退出覆盖模型/工具/验证阶段。停止时先停止并结算真正拥有的worker/Desktop，再收侧车Job；父成功不等于Task接受。

原Node事务按子操作实际序列化的output和已知终态事件累计32 MiB，不为重传重复扣减。额度不足时保留小型unknown诊断；若实际效果已发生而成功结果不能入账，另存完整 `rejected-result-<childId>.json`，不能把它变成空成功。每child原有产物限制仍独立生效；截图组合和累计上限的完整实际矩阵尚未验收。

## 组织模型通道

客户机不填写组织模型密钥。Reach服务可选配置模型地址、ID、密钥、上下文、输出上限及明确的图像能力声明；部分配置缺失则启动失败，全部留空则基础Reach正常启动。地址限定 HTTPS 的 `/v1` 根路径；开发模式额外允许字面环回 HTTP，不跟随重定向。能力来源标为 `organization-config`，本地测试不把它冒充真实模型探测结果。服务读取后删除环境中的组织密钥，Node查询仅得到模型/能力和路由HMAC，不得到组织地址或密钥。

`GET /api/v1/node/agent-model` 返回是否配置。Node以父dispatch/hash调用 `POST /api/v1/node/agents/:parentId/model/route`，将模型、协议、能力及凭据身份固定到原Task。随后以唯一request UUID向 `POST /api/v1/node/agents/:parentId/model/requests/:requestId` 发送原Chat Completions JSON，四个头分别为 `X-Reach-Dispatch-Id`、`X-Reach-Payload-Hash`、`X-Reach-Run-Id` 和 `X-Reach-Model-Route`；HTTP认证仍使用原Node身份。流请求固定模型、`stream:true`、单choice，明确一个 `max_tokens` 或 `max_completion_tokens`，不能同时提供或超过父/组织上限。

请求完整校验后，在同一事务中核父账户、Node/epoch、运行ACK、路由、截止时间和预算，记录原请求SHA并占用一次模型调用。原requestId无论正常、失败或断流，都不得再次调用上游；内容改变另报冲突。账本不存prompt或密钥。未知不返还预算，并阻止新模型请求、新工具、父成功及同Session新委托。服务重开保留原状态，不把旧reserved/streaming推断为仍有活owner，也不自动重发。

流式通道单请求上限32 MiB、响应8 MiB、单帧及待核缓冲2 MiB；普通Reach API仍为2 MiB JSON。它检查UTF-8和完整SSE，支持LF/CRLF/CR、finish后usage、DONE后保持连接以及明确finish后的干净EOF。正常文本首delta可在上游结束前到达；工具参数帧保留至完整终态，按固定rpi的二次JSON解码检查后才释放。SSE注释和上游HTTP错误正文不转发；JSON文本、thinking别名与工具参数中的明文及协议JSON转义回显受到检查，不承诺识别任意额外编码。遇到非法、半帧或超限，保留unknown且无自动retry。

父取消、解绑、终态、deadline、客户端断开和停服均可中断接收请求、等待上游及背压等待。停服先关闭模型准入、中断并等待活流，再关闭数据库。终态边界重新核父后先记录 `stream_complete`，再发布DONE；usage缺失仍为unknown，length/content_filter不被当作业务成功。

## 模型owner与未知运输停止

每个可写Store在打开业务DB前持有独立`<db>.owner.sqlite`的EXCLUSIVE事务，核DELETE journal mode。锁身份绑定规范路径与物理锁文件；拒绝硬链接别名和文件替换，关闭不删除锁文件。`:memory:`身份不提供跨重启证明。旧schema6已运行进程未参加该协议，新锁不证明它已退出；升级须先离线停止旧服务。

每个Store仅有一个Broker。模型预占及owner同事务，运输捕获冻结的instanceId/executionId/generation/routeHash/runId/bodySha256；streaming、finish及joined核对完整快照。Broker.close封准入、abort并await输入/上游取消和全部continuation后才完成；HTTP shutdown还等待pending listen及HTTP/Desk callbacks，最后关闭DB和释放锁。关闭后不得重新listen。

控制端`GET /api/v1/operations/:id/agent-models`查询原模型/owner/stop；同路径POST接受`reconciliationId/dispatchId/payloadHash/requestId/runId/bodySha256/ownerInstanceId/decision/evidence`，decision固定`transport_stopped`。仅接受不可重开的unknown/failed/cancelled父及未知请求，原证据文本须保留。CLI为`agent-models ID`和`agent-model-stop INPUT.json`，MCP为`reach_agent_models`和`reach_agent_model_stop`；认证、账户归属和浏览器CSRF沿用。

同owner必须实际abort/join且持久joined，active map为空不是证明；不同owner须持有同物理锁、同协议并核旧实例已退出。ownerless旧行或复制到新锁环境的库拒绝认领。回执不可变、同内容重试幂等，变更身份或证据冲突。schema9 停止入口核原 execution/generation/route/run/body 与同锁实例；协议7只证明既有 gen1，协议9可证明准确的后继。后继真实运输 join 的服务分项已执行，完整跨机生命周期仍未验收。

停止回执不改原模型state/usage、原父事件或预算，不退款、不重发、taskAccepted=false。停止回执本身仍阻挡新效果；只有锁内恢复 receipt 精确绑定的历史请求才可解释为足以续跑，新 unknown 不在该集合中。后续新 Task 还须原 Task 的最终释放 proof。运输停止也不证明供应商停止计费。[本地证据](evidence/agent-model-owner-20261104.md)含真实服务硬杀及CLI/MCP回执；原 Task 继续执行的后续证据见[原生续跑](evidence/agent-native-resume-20261104.md)，不外推完整 R06。

## Node模型relay

[前一模型通道证据](evidence/agent-model-20261104.md)中的relay/lifecycle是测试适配器；后续[普通Node委托证据](evidence/agent-node-20261104.md)已接入实际Rust Host、本机relay和原Node账本。R02整体仍需真实组织模型、视觉能力与安装装配验收。

Node使用专用reqwest流客户端，经父固定路由转发原请求。回给侧车的HTTP正文采用chunked；断流不能伪装成干净EOF。DONE保留至服务端原request状态确认stream_complete、Run/body SHA一致，并保存本地结算证明后才释放。新增 `POST /api/v1/node/agents/:parentId/model/requests/:requestId/status` 只读接口，以原父dispatch/hash查询原预占；不重发请求或返还预算。验证候选及父成功还会重新核本地完整模型请求集合。

客户机不配置组织密钥；侧车环境清空后仅保留必要系统变量和本机relay token。Task原件中的本机token与endpoint保存在受保护的Node状态目录。原服务deadline和serverNow扣除请求往返时间后换算为本机单调剩余时间，避免客户机时钟偏差延长授权；新Run不得重置预算。

## 普通Node运行时与结果窗口

Node查找程序目录的 `agent-runtime.json`，字段为 `sidecar` 和 `sha256`。包内路径应相对配置目录且规范化后仍在包内；开发配对可用绝对 `REACH_AGENT_CONFIG` 指向本机候选。镜像在声明能力及实际启动前均核SHA。现有安装候选未更新为包含此运行时，不把开发配置当作一键安装完成。

侧车工具结果上限128 KiB，Core还有限定上下文字节预算。Host按固定路由的contextWindow分配结果预览字节：contextWindow/32，限制在256至4096字节；32K配置为1024字节，131072配置为4096字节。这是Host的预览分配，不是token用量估算。超过窗口的原结果保留完整文件与SHA，返回UTF-8窗口、nextOffset及resultRef；可继续用file.read读取原件。原文件已存在时必须逐字节一致，不能返回指向错误旧文件的引用。桌面身份字段另附，避免大描述结果隐藏generation/session依据。

图片从原outbox分块重建，给侧车typed images并核消费proof。固定侧车在Session锁内核原生range_proof与候选basis.raw_proof；full_proof覆盖完整历史，非空Session中不能要求它等于当前Run的raw_proof。Node核精确basis、原callback/结果/图片集合及每个result_raw_index属于当前Run范围，重新读取原PNG核SHA；已有原件被改写时拒绝验证，不重拍或覆盖原收据。[本地截图证据](evidence/agent-desktop-20261104.md)覆盖同一Task的两次实际截图、32K配置、新Task沿原非空Session接续和消费后篡改拒绝。

[同Task跨Run实图](evidence/agent-cross-run-images-20261104.md)另外覆盖普通候选反馈后两Run各截图一次，provider图片数[0,0,1,1,2]；[闭合预算实图](evidence/agent-budget-20261104.md)图数[0,0,1,2]，Run1取得typed图后额度用尽，Run2第3次模型请求才真正消费首图。两者均为受控端点传输证据，不等于真实模型视觉理解。JSONL在原Harness锁内按ReviewBasis生成可选tool_images_ref，Node SDK将预算回调frame传给Host；Python目前只容忍附加字段，未自动提供或核验预算图片proof。

当前Host的Verified只核原候选、事件摘要、已结算子操作和图片/模型收据完整性；成功交付仍awaiting_review、taskAccepted:false。业务目标是否达到由原控制端结合源码与实际效果判断。新Task沿已结算原Session接续、同Task普通多Run及原生恢复均有本地分项；完整恢复矩阵和旧平台历史迁移仍未验收。

## 调用方反馈与同Task多Run

`maxRuns=1`保留原单Run完整性核验后返回待复核结果；显式请求`maxRuns>1`时，每个普通候选发布后等待调用方反馈，原截止时间继续计时。这是任务目标反馈，不是工具权限审批。反馈不增加Run、模型、工具、输出或时间额度，也不自动接受业务Task。

Node先在本地校验并持久保存原候选、当前Run图片证明、全部已结算子操作与模型transport，再发布候选。服务按原parent/dispatch/hash、Run顺序、真实调用计数和完整child集合绑定；重复发布须与原正文一致。该Run从发布时起封存，不论决定为pending、continue还是return_result，都不能新增模型或工具效果。重复原child调用仍只读原件，原模型请求仍拒绝重发。

控制端使用`GET /api/v1/operations/:id/agent-reviews`取原候选，以`POST`同一路径提交`reviewId/runId/basisSha256/decision/feedback`。`continue`要求非空修正原文；`return_result`不携带修正，只请求返回当前结果，仍taskAccepted:false。决定按原候选只提交一次；相同reviewId及原文可重取，改ID、改原文、错basis或旧epoch的新决定拒绝。已提交决定可以历史读取，不意味着下一Run或结果发布已经发生。

Node端接口为`POST /api/v1/node/agents/:id/reviews`发布、`POST .../reviews/:runId`读取决定、`POST .../runs`幂等登记原Run预算。调用方的CLI为`agent-reviews OPERATION_ID`和`agent-review INPUT.json`，MCP为`reach_agent_reviews`和`reach_agent_review`。普通登录、账户归属和浏览器CSRF合同沿用，不另建身份或操作队列。

发布API严格接受`candidate`或`snapshot`二选一。public review包含`subjectKind:'candidate'`和candidate，或`subjectKind:'closed_budget'`和snapshot。BudgetStopSnapshot保留原`termination={version:1,cause:'call_budget_exhausted',native_round_closed:true,model_final_stop:false}`，diagnostic_output不能冒充模型最终回答。两类对象使用同一basis绑定、不可改写决定、Run封存及反馈接口。

Node取得决定后重新读取原事件、模型集合和每张Task PNG，再将准确决定、反馈SHA及即将发送的verify_reply持久落盘。`continue`映射为原Harness的NeedsChanges；`return_result`映射为Verified。等待期间原件被改写仍为unknown并保留原fence，不以调用方决定覆盖完整性失败，也不重拍。

普通prepare须与已保存candidate/receipt完全相同，核下一Run序号、剩余模型数和原deadline。先保存nextRun记录、服务预占Run，等待旧relay请求完整结算并切换activeRun；然后重核上一依据，再发送prepare_reply。新Run复用同一侧车、Session、endpoint/token、模型/工具声明；原目标、来源和当前反馈进入新objective。每个请求固定当时Run归属，当前Run的tool/image证明分别检查，child与预算按原Task累计。

闭合预算走原生`verify_budget_request/prepare_budget_request`，Node支持inline及ref并保存准确snapshot/receipt，不转成普通candidate。等待后及prepare前重核原snapshot、图片、事件及模型transport；终态严格核`budget_review_ref → index → snapshot/receipt`，原outcome的`last_candidate=null`。单Run显式cap没有调用方反馈时，Node以空NeedsChanges交Harness结算，结果为failed/BudgetExhausted/Released；不会自动接受目标。

预算已用尽而调用方仍要求修正时，Harness可返回BudgetExhausted且Released，Node返回明确failed/未完成，不冒充需要恢复的unknown。等待预算反馈取消或原snapshot变更则unknown/Present，原效果和fence保留，没有追加Run或重放工具。完整原 Task 崩溃恢复矩阵及真实组织模型仍待完成。执行记录见[多Run](evidence/agent-multirun-20261104.md)和[闭合预算](evidence/agent-budget-20261104.md)本地证据。

## 恢复请求、锁内核对与原生准入

调用方可提交独立`agent.inspect`操作，指定原rootOperationId；同账户/Node/epoch及Node声明的inspect能力须匹配。Node只读核选定原Task/Session/镜像字段，返回存在的fence原字节SHA、观测时间及原Task身份，不返回本地凭据、原文件内容或状态目录路径。结果固定`unlocked_readonly/nativeAuthorityVerified:false/taskAccepted:false`；检查不会改变原操作、fence、Session、预算、generation或pending。I/O错误不当作fence缺失，指纹仍需Harness锁内核验；NoFence不证明可清pending或接受Task。真实强杀及准确验证范围见[原生前置证据](evidence/agent-native-preflight-20261104.md)。

`agent.resume`沿原operations提交，只接rootOperationId、previousExecutionId、fenceSha256及原文instruction，不接收新Session、cwd、工具、路由、预算或deadline。原文不trim并保存SHA；fenceSha256仍是expected值，不是已核原件。同request精确幂等、变更冲突，不同并发request以current/generation CAS只接受一个。root须已实际派发且原deadline有效，previous属于同root/账户/Node/epoch并是current，已unknown/failed/cancelled；精确未派发且已取消的reconciling attempt允许再形成后继，代数不倒退。

新 attempt 先为 `reconciling`，Task 的 requires_reconciliation 置1。Node 现已声明 agent.resume；旧 Node 仍不能领取。plan 只固定 Run UUID 与消费前缀，不授权效果。Harness 持原 Session 锁后发 reconcile_request，Host 核完整本地/服务模型、child、原 outbox/ACK、fence、镜像、工具与消费，再提交不可变 receipt。原 task.json 不覆盖，attempt 原件独立保存。缺 observation 扣满原 cap；未 admitted 的预占槽保留 UUID/序号/注册来源，实际 cap 只能缩小。已有同 Session 后续 Task 时拒绝恢复旧 root，持久插入顺序区分同毫秒。

新 fence、resume.json 和准确 run-N-admission 原件齐全后，由 `resume/admit` 固定 admitted owner 并置 active；relay 首个请求在写 intent 前检查，tool/verify/prepare 同用门禁。新效果均核 current/generation、active、准确 Run admission、running ACK、当前 Node/epoch、取消及原 deadline。pending 继续挡新 Task/re-pair，不能拿它持续取消已准入的新 child。复核发布 owner 分代，无 review 的崩溃序号空档须有消费前缀依据；旧 pending review 不能重绑成新反馈。已显式对账后的合法迟到原成功只追加历史，保留独立对账结果，不改变current/generation/pending；新success或成功reconcile不能据此绕过。

`POST /api/v1/node/agents/:executionId/resume/{plan,snapshot,arguments,reconcile,admit,final-snapshot}` 使用本次 dispatch/hash。大原件留在原账本，snapshot 只含摘要，参数按最多 64 KiB 窗口读取并核整体 SHA；不扩大普通 2 MiB API。最终快照等待当前模型 owner joined，native Released、侧车/Job 结算与完整效果 proof 随原终态事件同事务提交后才清 pending。failed/cancelled/通用 reconcile 不自动清位；成功仍 awaiting_review/taskAccepted:false。

已有最终 outbox 的丢 ACK 可精确重传。native 已 Released、Node 尚未保存最终事件时，Windows Node 的 `agent.finalize` 候选沿原 source 只读收尾；旧 owner 不齐、没有原 Released 或未知效果仍拒绝，不启动新 Session/fence/模型。开放图片工具缺 typed 回填合同也拒绝，不能重拍或伪装文本。完整续跑范围见[原生续跑证据](evidence/agent-native-resume-20261104.md)，新增收尾的执行范围及未测项见[只读收尾证据](evidence/agent-native-finalize-20261104.md)。

`agent.finalize` 接收 rootOperationId、previousExecutionId、sourceExecutionId、releasedSha256。source 必须是最后实际原生 owner，previous 可为其后的无效果失败代。服务建立新 generation 并保持 pending，永不授予模型、工具、Run、review 或 resume admission 权限。超过原 deadline 只可收尾，不修改额度。Node 先核同 boot 的原进程/命名 Job 退出，再以持原 Session 锁的 inspector 核完整快照和原件；inspector 原 guard 发布的 seal 绑定本代、source、snapshot、最终状态和正文。缺 seal 的 prepared 结果不能提交，合法封存后的 outbox 丢 ACK 只补传原事件。取消或解绑停止新的检查与效果，但不撤销同epoch准确原封存结果的收据提交资格；Node仍保持解绑，finalizer一律拒绝通用reconcile覆盖。服务在同事务核 current、epoch、封存仲裁、效果摘要、原消费和终态后才清 pending。成功仍为 awaiting_review/taskAccepted:false；BudgetExhausted/NeedsChanges 保持 failed/未完成。

`GET /api/v1/operations/:id/agent-task`同时返回root、current、generation、phase、recoveryRequired、原deadline及执行历史；CLI为`agent-task ID`，MCP为`reach_agent_task`。Node `POST /api/v1/node/agents/:executionId/context`核本次dispatch/hash，只读返回原root派发及固定descriptor或null，不重新绑定组织配置、不返回组织密钥。源码接线和实际进程验收范围见[恢复准备证据](evidence/agent-executions-20261104.md)。

同一Task恢复必须保留侧车镜像、原endpoint/token、工具声明、预算和绝对截止时间。Harness会核endpoint和token摘要；本地relay端口/token须按原Task持久固定，无法重绑原端口时明确拒绝，不通过换Session绕过。新Task沿用原Session前须结算并关闭原Task，保留组织路由版本。

Node 启动把未结算原操作记 unknown，终态后不能追加运行事件。恢复使用新的 execution 关联原 root/previous 与 expected fence；实际 Node 接线和 Harness 锁内核验已有本地分项。不能重新打开旧父或单改 phase 代替恢复。

Harness 缺 observation 时按原 admission.remaining_calls 保守消费，服务仅见少量模型请求不能退款；root 的模型/Run/child/32 MiB 预算不随 attempt 重置。schema9 已区分 Run 注册与首次原生准入，使用准确消费前缀解释无 review 的崩溃空档，不补造 review 或重占未准入槽。旧 pending review 不变成新代授权，模型停止也不作通用豁免。完整故障矩阵仍开放，文本 ResumeReceipt 不能冒充 typed 图片恢复。

## 验证与剩余工作

服务端分项包含事务回滚、并发去重、HTTP服务重新打开后的原Dispatch恢复、身份/预算/截止时间、取消/对账、两child的独立index0产物，以及v1→v2保存原操作和回执。其Node生命周期/PNG由夹具入账，不能代替真实委托Host或真实截图。

普通Node两文件操作、实际命令取消、上传拒绝后重启补传、模型结束附近断流、累计预算与时钟偏差已有本地证据；跨Run实际截图、预算反馈、模型owner/停止及原生续跑也已有分项。NoFence 只读收尾的源码和已执行本地边界独立复核通过，共享运行库已按既有Lite策略审计并装入[完整候选](evidence/agent-package-20261104.md)，完整恢复故障矩阵及 R04/R05 仍待完成，不通过退款、换 Task 或换 Session 绕过。真实组织模型和上线等待用户恢复远端访问。按原件报告已执行范围，不提前勾选完整清单。
