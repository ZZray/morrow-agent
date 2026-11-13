# 本机 Agent：共享原生核心 + 宿主层

HandWave node 的 `agent-loop` 不再跑自己的模型循环。一回合 = 一次
`nativeapp.Run`，模型循环、协议解析、流式增量、会话 journal 全部来自共享核心；
node 只保留必须留在宿主的东西。

## 分层

| 层 | 归属 | 职责 |
|----|------|------|
| 模型循环 / 工具批次 / journal | `internal/agent.Engine` + `internal/nativeapp`（共享） | 回合、工具配对、压缩、恢复绑定、原子 journal |
| 模型协议 / SSE 解析 / 供应商错误分类 | `internal/providers`（共享） | `/v1/chat/completions` 流式请求与解析；`HTTPError`/`TransportError` |
| 宿主接线 | `apps/handwave/node_loop.go` | `nativeapp.Host` 组装、访问码、事件映射、工具面 |
| 宿主会话层 | `apps/handwave/node_session.go` | 原生会话标识、控制队列、任务板、ask_user 等待、旁路命令、状态落盘 |
| 旧历史迁移 | `apps/handwave/node_legacy.go` | 原字节备份、结构验证、映射后交 `Store.ImportHistory` |
| 本机文件工具实现 | `apps/handwave/node_local_tools.go` | `list_dir` / `search_text` / `patch_file` |

依赖方向：`apps/handwave -> internal/nativeapp -> internal/agent -> internal/providers`。
已删除 `apps/handwave/agentloop/`（loop/model/sched/runtime/persist 与它们的测试）。

## 一回合怎么跑

1. `agent-loop` 帧带 `msg`/`model`/`protocol`/`brief`。model 与云端同源（`web/app.js` 的 `agentLoopModelSelection()` 包 `chatModelSelection()`）：显式模型发送经目录校验后的协议；Auto（`model:"default"`）一律发空 protocol，由 Node 根据本次 Hub grant 按 显式协议 > 已保存 session hint > Hub 默认 解析。浏览器缓存的 `gatewayPublic.default_protocol` 不算显式选择，不允许覆盖自动续接（Go `dcf.Protocol json:"protocol,omitempty"`：空串/缺省即未提供）。**在任何网络等待之前**原子占位唯一回合
   （`reserveTurn`）；占位失败即排队（`session busy; follow-up queued`），绝不并行开第二个引擎。
   占位在成功、失败、拒绝、取消与重复 run id 路径上都会释放（`releaseTurn`），
   所以授权等待期间 `agent-abort` 也生效（等待本身可被上下文取消）。
2. `requestModelGrant(ctx, runID)` 取短期访问码；用 `providers.New` 构造只存在于内存的 provider。
3. `nativeapp.Run(Host{Provider, ProviderID: "handwave-node", Model, System, Tools})`：
   - `ProviderID`/`Model` 精确绑定并随会话保存，续接时先校验再调模型；
   - `System` 是新会话的基础提示，保存后按精确文本绑定，续接不再重算；
   - `Tools` 是**完整**工具源（本机工具 + `todo_write` + `ask_user` + `bash` + `delegate`），
     不回退到 MCP 或内核自带工具；
   - `Control` 是共享的跨回合控制队列，直接提供 `all`/`one-at-a-time` 与 `immediate`/`wait`。
4. 原生事件映射到现 Web 的 `agent-event`：`text_delta` / `text` / `tool_start` / `tool_end` /
   `task_update` / `compact` / `retry` / `ui_request` / `bash_start` / `bash_end` / `steer` /
   `agent_end`；最终结果仍走 `out`（成功 0，失败/取消非 0 且带 err）。

## 访问码与续签边界

- 只做**一次有界**续签：provider 返回 401/403 且本次尚未流出任何增量时，重新申请一次
  访问码并用它重试一次。
- 已经流出过内容（`text_delta` 等）绝不重放：重复增量会被当成新输出，失败原样上报。
- 其余供应商错误（429/5xx、传输失败）**不在宿主重试**，直接交共享 gateway/providers 的分类结果。
- 访问码只在内存里，不落盘、不打日志。

## 留在宿主的业务

- 设备授权、审批、WebRTC/grant、UI 帧协议（`agent-steer`/`agent-follow`/`agent-abort`/
  `agent-bash`/`agent-bash-abort`/`agent-mode`/`agent-ui`）。
- 任务板：`todo_write` 与回合生命周期更新宿主状态，配对成功后 `publishLoopBoard` 推回 UI。
- `ask_user`：宿主等待 `agent-ui` 回帧（2 分钟上限），拒绝返回 `User rejected: …`，绝不变成成功。
- 旁路命令：独立于回合、可单独取消，同一时刻只允许一条。
- `delegate`：窄子任务，每回合最多 3 个，用**同一条 `nativeapp.Run` 的独立会话**执行，不再嵌套旧循环。
  子会话事件与父回合隔离：`text_delta` 不进入父的流式气泡（Web 的 `onLocalAgentEvent`
  会把任意 `text_delta` 追加进当前气泡），`text`/`agent_end` 也不会由子会话发出；
  子任务的任务板与工具事件按子任务 id 归属（`sub-N`）保持可观察，最终答复仍通过工具返回值回到父回合。
- `agent-task`（Hub `run_node_task`）与 Hub `delegate_agent` 是另一套业务，语义未改。

## 宿主状态与待投递队列

- 新状态文件：`confDir()/node-agent-state.json`（会话标识、model、任务板、带投递标识的队列、迁移记录），不含凭据与对话。
- 入队是一次**串行事务**：`append → 落盘 → 才曝光给 Control`（`steer`/`followUp` 生成稳定随机
  投递 ID `d-<hex>`）。保存失败会回滚内存并返回错误，**绝不假装排队成功**（帧路径把该错误
  回给调用方），也不会被并发里另一次成功的保存「顺手带上盘」。
- 回执只按共享核心的 `Event.Delivery.ID` 精确确认（`Session.HasDelivery`/`Delivery`），
  绝不按文本、顺序或「本轮第几条」。
- 恢复时先读对应原生 journal，丢弃已经提交过的投递 ID，因此
  「journal 已提交但 host ack 未落盘就崩溃」不会重复投递；同一 ID 也不会重复入队。
- 恢复**证明不了**就阻断（原状态与原文原样保留，`Control` 保持为空，保存与回合都被拒绝）：
  journal 缺失/读不到/store 打不开，或条目缺投递 ID、重复 ID、未知 kind、空文本。
  未知 kind 绝不默认按 `follow_up` 投递（那会把 steer 静默降级成不中断的跟进）。
- 状态文件的「取快照 → temp → fsync → rename」全程在**同一把串行锁**（`ioMu`）内，
  并发保存不会让先取的旧快照覆盖后取的新快照；错误可观察。
  损坏或非 `NotExist` 的 IO 失败会**原样保留**该文件并阻断保存与回合，绝不用空状态覆盖。
- 没有投递 ID 的旧队列（`agent-loop.json` 的 steer/follow、版本 1 状态的纯文本队列）
  无法证明未投递：显式保留为 paused 可见状态，绝不自动投递、绝不按文本猜。
- `agent-queue-recovery` 帧（`list`/`requeue`/`discard`）让已经配对的 controller 查看并显式处置它们：
  `list` 只读（宿主状态被阻断时也返回原因），`requeue` 由操作者**显式**选 steer/follow_up，并把
  paused → 带 `d-<hex>` 投递 ID 的 Pending、处置审计、队列移除与 `queue_revision` 递增放在
  **同一个宿主状态事务**（`ioMu` + `writeState`）里落盘，成功之后才曝光给共享 Control；任何一步失败
  都整体回滚内存，绝不假成功、绝不半条入队。`discard` 只移除并记审计，不投递。
  变更要求当前回合 idle 且宿主状态可信（没有 `loadErr`/未知 journal），并且必须带上调用方看到的
  预览版本与条目 ID：过期视图、重复请求、未知条目都被明确拒绝，绝不按文本去重；来源已经丢了原类别
  的条目必须由操作者显式选择，绝不默认猜 `follow_up`。处置审计只记在宿主状态里，旧
  `agent-loop.json` 与它的备份一个字节都不改，重启也不会重新出现已处置项。
- 新会话先 `nativeapp.CreateSession` 取得 ID 并**原子保存绑定**，再 `Run`：回合中途崩溃
  也能找到 journal。绑定保存失败会**回滚内存里的绑定**并让回合可见地失败，绝不留一份
  没落盘的 binding 让下一次 `Run` 绕过预保存；已创建的 journal 保留在磁盘上不删。
- 回合结束的 `setNativeID`/`saveHostState` 失败同样是**可见失败**（`out` 非 0 + `agent_end`
  记 failed），不是「只记日志再 out code 0」；journal 与已落盘的绑定都保留，修好磁盘后仍可续接。
- 模型显式换绑会开新会话并记 `prev_session_id`，不跨模型重解释历史。换绑**之前**先按旧
  session 的 journal 确认 pending（已提交的丢弃、未投递的保留），并把换绑结果原子落盘，
  所以内存快照与状态文件始终一致；确认不了（journal 读不到）或落盘失败就回滚并让回合失败。
- 唯一回合的占位与取消登记在同一把锁下完成（`reserveTurn` 返回该回合的 ctx+cancel），
  因此占位后立刻到达的 `agent-abort` 不丢。`agent-loop`/`agent-task` 帧在 `onFrame` 里
  **同步登记**为「已接收、待启动」（`acceptRun`）再 `go` 执行：早于登记到达的中止只标记这条
  真实存在的登记，登记时立刻取消，该回合不启动引擎、也不申请访问码（不靠 sleep 猜调度窗口）。
  未知 ID 的中止**不记忆**（没有 TTL、没有永久列表），因此不会取消未来某个同 ID 的 run。

## 旧历史迁移
- 旧 `confDir()/agent-loop.json` **原字节不动**：另写 `.backup-<sha12>` 备份，校验和相同则不重复写。
- 结构验证：只接受纯文本、工具调用与结果成对且顺序完整的历史；截断尾部、孤立结果、未知角色/未知内容一律报错并停（不重放、不用空会话顶替）。
- 验证通过后由 `agent.SessionStore.ImportHistory(opts, sourceID, messages)` 原子发布，`sourceID = handwave-agent-loop/v1/sha256:<旧文件摘要>`，来源幂等：同一份旧文件永远映射到同一个原生会话。
- 旧循环的本机 persona（首条 system 消息）由宿主基础提示取代，不进入 transcript；原文记入
  `legacy.legacy_system` 并明确记日志，不静默丢弃。
- 旧任务板并入后 `running` 降级为 `paused` 可见；旧 steer/follow 队列保留为
  `legacy_paused_queue`（无投递标识，不自动投递）：装载时按「来源 + 位置 + 原文」给稳定条目 ID，
  原类别（steer/follow_up）照实记下来，重新装载不重复 adoption，只能由已配对的 controller
  用 `agent-queue-recovery` 显式处置。
- 空历史允许普通新会话，但任务板与队列仍然保留。
- 旧历史损坏/未决/核心拒绝时**阻断该回合并报错**（`legacy agent-loop history is not migrated`），
  绝不用新空会话顶替；导入成功时先落盘绑定再继续。
- 来源在迁移之后被改动/缺失会记错误并阻断；**只有在来源字节、备份与已导入 journal 三者重新一致时**
  才清掉这条已恢复的错误（否则一个已经还原的来源会永远误阻合法换绑）。备份用排他创建，同名不同内容
  一律保留并阻断，绝不覆盖。

## 已知局限

- 模型绑定是精确的：换 model 会显式开新会话（发 `session` 事件 + 日志，旧 journal 留在磁盘并记入 `prev_session_id`），不会把历史静默接到另一个模型上。
- 续接要求运行目录与基础提示与保存时一致（共享核心的绑定校验）；不一致时明确报错，不静默新建。
- 旧队列的自动压缩开关沿用旧文件；压缩阈值从旧的「≥10 条消息」换成 token 阈值（24000/4000），因为共享引擎只认 token。
- paused 旧队列的重排队**不判断「这条是否已经执行过」**（旧条目本来就没有投递标识）：本机只保证不重复
  入队，是否真的执行取决于当前回合的投递模式（等工具结束 / 立即），Web 入口因此明示要核对。
- `web/app.js` 在本次切片之前就有两处重复的 `const steerInput` 声明（都在 `bindLocalAgent` 内），
  `node --check web/app.js` 因此报 `Identifier 'steerInput' has already been declared`。本次只加了
  两处挂钩（`onFrame` 的 `out` 分支、`bindLocalAgent` 的 `#agentQueueBtn`），没有改这一区域，
  修它需要协调者决定归属。
- 根 `docs/subprojects.md`、`docs/unified-core-plan.md`、`README.md` 仍写着「agentloop 待替换」，属根 docs 范围，未在本次改动内。

## 验证

离线 fixtures：`go test -race ./apps/handwave`。覆盖本机工具、宿主状态往返、
访问码只续签一次、5xx 不重试、流出后不重放、ask_user 同意/拒绝、旁路命令取消与互斥、
忙时排队、delegate 限额、SSE 端到端（grant → 工具落盘 → 事件/out）与同 session 续接、
旧历史完整/截断/未知内容/损坏/空/来源幂等与原字节备份，以及本切片的落盘事务：
并发入队串行（快照→rename 全程一把锁）、失败入队回滚且不被别人的保存带上盘、
绑定保存失败回滚 + 回合可见失败、回合结束保存失败不报成功、journal 缺失时恢复被阻断、
无效 pending（缺 ID/重复 ID/未知 kind/空文本）原样保留并阻断、换绑前按旧 journal 确认
pending 且内存与磁盘一致、换绑确认不了就阻断、已接收 run 的立即 abort 与未知 ID abort
不记忆，以及旧 paused 队列的查看与显式处置：预览与稳定条目 ID、文本相同的两条互相区分、重排队的
原子失败回滚与重放/过期视图拒绝、忙与阻断时拒绝、未知原类别必须显式选择、放弃保留审计且重启不再
出现、来源还原后只清已恢复错误。Web 入口 `web/node-queue-recovery.js` 用
`node --check` 与 `node --test web/node-queue-recovery.test.cjs` 验证。
