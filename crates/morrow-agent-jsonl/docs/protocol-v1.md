# JSONL v1 协议

每条消息是严格 UTF-8 JSON 对象，以 LF 结束。整帧含 LF 不超过 262144 字节；
工具 `result` 子对象不超过 131072 序列化字节。输入拒绝未知字段、错误版本、
重复回复和未请求的回复。stdout 仅作协议通道；stderr 只报告固定错误类别。

## 初始帧

每个进程接受一个初始请求。任务使用 `start_task`，管理使用文末的 `manage` 入口。Host 必须提供实际模型入口、
有效的绝对截止时间和新目录，不应直接执行示例中的占位值。

```json
{
  "kind": "start_task",
  "version": 1,
  "task": {
    "task_id": "task-1",
    "criteria_revision": "criteria-v1",
    "authorization_revision": "grant-v1",
    "kind": "Coding",
    "evidence_dir": "D:/isolated/new-task-evidence",
    "max_runs": 2,
    "max_calls": 8,
    "deadline_unix_ms": 0
  },
  "run": {
    "run_id": "run-1",
    "objective": "Use the registered business tools and submit the actual artifact.",
    "cwd": "D:/isolated/workspace",
    "session_path": "D:/isolated/state/session.json",
    "environment_state": "D:/isolated/state/environment",
    "device_fp": "host-device",
    "session_key": "host-session",
    "mode": "execute",
    "endpoint": "http://127.0.0.1:12345/v1",
    "model": "host-model-id",
    "max_calls": 8,
    "max_seconds": 120,
    "max_output": 2048,
    "model_resolution": {
      "kind": "host_declared_loopback",
      "capabilities": { "context_window": null, "max_tokens": 8192, "input": ["text"] }
    },
    "tools": [{
      "name": "lookup",
      "description": "Host-owned lookup",
      "parameters": { "type": "object", "properties": {}, "additionalProperties": false },
      "allow_in_plan": true
    }]
  },
  "cancel_grace_ms": 5000,
  "emit_events": false
}
```

`model_resolution` 也可以为 `{"kind":"catalog"}`。`max_output` 范围为 1 至 8192；
`cancel_grace_ms` 为 1000 至 15000，默认 5000。`kind` 使用公共 Harness 的
`TaskKind` 编码。凭据只来自子环境 `MORROW_AGENT_MODEL_TOKEN`。

实验性：`model_resolution` 还可以为 `{"kind":"catalog_capped","context_window_cap":N}`。
它按 `catalog` 读取模型能力，再把上下文窗口压低到不超过 N 个 token（目录没有声明窗口时取 N），
用于让声明百万级窗口的模型在较短的 Task 内触发压缩。`N` 范围为 1024 至 10000000；
超出范围、类型不符、缺少 `context_window_cap` 或含未知字段时，stderr 写 `start_config_rejected`，
退出码 2，stdout 零帧（范围错误的内部拒绝码为 `context_window_cap_out_of_range`）。
`model_capabilities` 事件的 `declared.context_window` 记录压低后的值，`source` 仍为 `hub_model_directory`。
该取值不属于 v1 稳定契约，后续版本可能调整或移除。

可选 `run.length_recovery` 使用字符串 `"stop"`（默认）或 `"replan_once"`。
后者仅允许 Execute，并由 Core 在同一 Run 最多安排一次无工具 Length 重规划。
它不增加预算、不修改原截断消息；再次无工具 Length、未知效果、取消和持久化失败仍停止。
`prepare_reply` 不能更换这一固定 Host 策略。

可选 `run.generation_policy` 是 Core 的封闭枚举：`"provider_default"`（默认）或
`"thinking_type_disabled"`。后者在解析后的 `openai-completions` 路由上发送固定
`thinking.type=disabled`，其余协议由 Core 在模型和工具调用前拒绝。宿主负责确认
实际服务支持这一契约，不能从模型名称推断。它不改变模型、输出上限、累计调用数或截止时间。
策略固定于整个 Task，反馈后的 Run 和同 Run 长度恢复继续沿用。

可选 `run.worker_executable` 由 Host 指定已存在的绝对可执行文件路径，作为原 Task authority 的一部分保存。后台 Job 创建还需要 Goal lease 的 `allow_jobs:true`。JSONL 的通用本地工具开关保持关闭，Worker 路径由固定 Run 模板传递，模型只能调用已注册的 Job 工具。兼容 Worker 可采用 Core 的 `business_host` 示例，其入口优先处理 `managed_jobs::worker_entry_from_args()`。

## Goal and guided continuation opt-ins

Existing start frames remain unchanged when these fields are omitted. A Host may
set `goal` to select Goal mode with a fixed `goal_id`, up to eight completion
criteria and a serialized Core Goal lease. The lease identity must match
`goal_id`, and the sidecar passes it to the Rust Core without extending it.
Goal state changes use the management `goal_control` endpoint, which checks
its required `expected_revision` and `reviewed_run`. Ordinary Goal slices use
Goal identity, lease and Harness continuation evidence for admission. The nested
`goal.expected_revision` and `goal.reviewed_run_id` fields remain accepted for wire
compatibility. A continued slice reuses the original Session and cumulative Task budget.

`guidance: true` enables Host `guide` frames during the admitted Task.

```json
{"kind":"guide","version":1,"task_id":"task-1","message_id":"msg-1","text":"Continue with the next authorized slice."}
```

The sidecar acknowledges a queued message with `guidance_ack`. Within the same
sidecar process, the same ID and text returns `duplicate`; the same ID with
different text stops the request with `guidance_identity_conflict`. Guidance
uses the existing SteeringBuffer and does not create a Run or increase a budget.
Before the terminal frame, the sidecar records `jsonl-guidance.json` and emits
`applied`, `unapplied`, or `unknown` for each accepted message. `applied` means
the source was saved and admitted to the execution context, not that the model
read or obeyed it. A killed process can leave delivery unknown. Cross-process
controllers must inspect the stored receipts instead of replaying messages.

`event_payloads: true`, together with `emit_events: true`, adds the original typed
event payload to each best-effort event frame. The payload is observational
evidence and does not replace the durable outcome or Host acceptance.

### Reviewed continuation

`continue_reviewed` selects the existing Harness continuation API. It is
mutually exclusive with `resume`; neither field accepts `null`.

```json
{"continue_reviewed":{"previous_evidence_dir":"C:/host/task/first/evidence","expected_released_sha256":"<64 lowercase hex digits>","review":{"basis":"<original ReviewBasis>","committed":true,"settlement":"Settled","verdict":{"NeedsChanges":{"feedback":"Verify the source citation."}},"evidence":["host-correction-receipt"]}}}
```

The new start frame retains the original Task ID, terms, deadline, lease and
authority, uses a new Run ID and evidence directory, and supplies the exact hash
of the previous `released.json`. The Harness validates the review and original
evidence, carries cumulative Runs/Calls forward, and claims the released result
for one successor. Unknown effects or an existing fence require checked resume;
they cannot enter this path. Transport success still leaves `task_accepted`
false. `review` may be omitted only when the original settled receipt already
contains `NeedsChanges` feedback.

### Host management

A separate process accepts a `manage` first frame with version 1, a command ID
and a typed operation. It requires no model token and never starts an Agent loop.
The Node entry is `@ry/morrow-agent/management`.

```json
{"kind":"manage","version":1,"id":"inspect-queue","request":{"operation":"queue_snapshot","directory":"C:/host/queue"}}
```

Operations cover library root resolution, Skill catalog/read/create/install/
enable/remove/verification, context snapshots and explicit memory/reference
commands, and queue enqueue/snapshot/events/cancel/watchdog. Skill removal
preserves the bundle in its library's retired directory. Builtins are read-only.
Host management may inspect a disabled bundle; runtime discovery and reads
exclude disabled bundles. Installing or enabling a bundle is not execution
verification or a grant of tool/device authority.

Management requests reject unknown fields and duplicate typed fields. The Node
client bounds frames, output and execution time, and reports `not_started`,
`validated`, or `unknown` delivery on failure. After timeout or output loss, a
Host must inspect state before retrying a mutation.

## 工具回调

sidecar 发 `tool_call`：

```json
{
  "kind": "tool_call", "version": 1,
  "rpc_id": "rpc-1", "task_id": "task-1", "run_id": "run-1",
  "native_call_id": "call-1", "tool_name": "lookup",
  "args_sha256": "original-argument-hash", "arguments": {}
}
```

Host 回 `tool_reply`，精确复制原关联字段，不能重算或改写参数后复用旧 hash：

```json
{
  "kind": "tool_reply", "version": 1,
  "rpc_id": "rpc-1", "task_id": "task-1", "run_id": "run-1",
  "native_call_id": "call-1", "tool_name": "lookup",
  "args_sha256": "original-argument-hash",
  "result": {
    "value": { "found": true }, "is_error": false,
    "settlement": "Settled", "operation_receipt": "original-host-receipt"
  }
}
```

`settlement` 为 `Settled` 或 `Unknown`。传输完成、业务成功和效果结算分别表达；
已知失败可以结算，未知效果会阻止成功和自动续作。Host 保管原操作收据，sidecar
记录回调关联与结果。工具文本不能触发控制回调。

## 产物检查和续作

所有控制请求及回复都有 `kind/version/rpc_id/task_id/run_id`。

| sidecar 请求 | 内容 | Host 回复 |
| --- | --- | --- |
| `verify_request` | `candidate` 或 `candidate_ref`，二选一 | `verify_reply`，包含 `receipt` |
| `prepare_request` | `continuation` 或 `continuation_ref`，二选一 | `prepare_reply`，包含 `run_id_next` 和 `objective` |

`candidate` 包含 `basis/output/goal`。普通检查在缺省或
`artifact_review: false` 时使用原有 v1 basis 字段，省略 `session_id`。
启用 artifact review 后携带完整 Harness basis。Harness 的原始候选文件
始终保存 Session 身份。大型旧格式候选通过 `candidate_ref` 引用
`jsonl-candidate-N.json`，其内容与 inline 候选一致，原件及投影文件都在
回调前后接受核验。

Host 原样复制收到的完整 basis 到 `receipt.basis`，保存实际检查证据后返回以下回执。

```json
{
  "basis": "copy-the-complete-actual-candidate-basis-object",
  "committed": true,
  "settlement": "Settled",
  "verdict": { "NeedsChanges": { "feedback": "Actual check failed; correct the authorized artifact." } },
  "evidence": ["original-host-check-receipt"]
}
```

这里的 basis 字符串仅说明位置；线上必须是原始对象。`verdict` 的其他编码是字符串
`Verified` 和 `Unknown`。`continuation` 包含原 `previous`、检查 `receipt`、
`next_run_number`、`remaining_calls` 和原 `deadline_unix_ms`。
Host 的新 objective 应包含实际失败反馈；reply 无法更换其余配置。

普通旧格式 continuation 中的 `previous.basis` 和 `receipt.basis`
采用相同字段。budget 和 length 的显式 opt-in 回调使用完整 basis，
并继续校验其固定来源文件。Host 应原样保留收到的额外 basis 字段。

## ToolArtifact 回调

初始帧可设置 `artifact_review: true` 启用结构化产物检查。缺省或 `false` 时
沿用原有回调。字段必须是布尔值。Python Host 提供异步
`review_artifacts(review, cancelled)`，Node callbacks 提供
`reviewArtifacts(review, { signal, frame })`。两者返回 ToolArtifact 记录数组。

| sidecar 请求 | 内容 | Host 回复 |
| --- | --- | --- |
| `review_artifacts_request` | `review` 或 `review_ref`，二选一 | `review_artifacts_reply`，包含 `artifacts` |

`review` 包含当前 `basis` 和同一 Task/Session/Run 的 `artifacts`。每项使用
Core 的 ToolArtifact 版本 1 格式。输入摘要使用 canonical JSON 参数，输出摘要
覆盖完整 typed ToolResult。Host 检查业务产物后可返回原 candidate、同 ID 的
verified/revoked 转移记录或自己的业务产物记录。验证原 candidate 时保留来源字段，
在 `host_receipt` 写入匹配的来源标识、摘要、验证者、时间和已提交/已结算标记。

Rust Bridge 核对请求与回复的 `version/rpc_id/task_id/run_id`，Harness 检查来源、
状态和回执绑定。Rust 负责持久化返回的记录，Python/Node Host 通过回调提交结果。
完全相同的已有记录可作为引用返回，合法状态转移追加到 provenance 日志。
失败保留原 RPC 收据和 fence，部分追加保留已经写入的现场证据。

超限请求使用 `review_ref` 指向当前 evidence 目录中的
`jsonl-artifact-review-N.json`，其中 N 为累计 Run 编号。引用沿用原件路径与
实际字节 SHA-256 校验，原件上限为 16 MiB。回复仍受 262144 字节帧限制。调用异常和取消沿用
既有 Host 操作收据及 callback cancellation 流程。

普通、预算、长度和恢复后的 Run 共享此回调。最终已接受的引用通过原
`outcome_ref` 指向的 `TaskOutcome.artifacts` 返回，原 ReviewReceipt 字段和
task_result 帧保持原契约。启用该字段的消费者需使用支持它的 sidecar 和客户端。

## 原件引用与终态

超限候选和续作使用 `{ "path": "absolute-original-path", "sha256": "actual-bytes-sha256" }`
引用。客户端只接受原 Task 证据目录内、实际字节 hash 匹配的文件。Python 客户端
和 Node 客户端的引用读取上限均为 16 MiB。Rust 的 artifact、budget 和 stop
固定原件检查也使用 16 MiB 上限，通用候选原件读取函数沿用已有行为。
这些检查不构成不可信文件系统沙箱。引用中的完整 JSON 必须与本地权威对象一致。

`task_result` 总是包含 `outcome_ref`，并附 `task_id/stop/task_accepted/runs/observed_calls/`
`fence_presence/reconciliation_fence/local_callbacks_finished`。客户端核对引用原件与摘要；
`Released` 使用 `released.json`，其余使用 `outcome.json`。
`task_accepted` 始终为 false，产品自行接受业务 Task。

## 取消、断连和事件

Host 可发送 `{"kind":"cancel","version":1,"task_id":"task-1"}`。
sidecar 对在途回调发 `callback_cancel`，包含原关联字段及 `reason`。
Host 需要在结算原操作后回复同一 RPC；不能用新操作或新 Session 代替。
grace、EOF 或进程退出无法证明远端回调已结束或效果已回滚。

开启 `emit_events` 后会收到 `event`，带 `seq/event_type` 和
`delivery="best_effort_not_complete_evidence"`。慢观察者可以丢 UI 事件，原 Core 事件
仍由 Harness 持久化。控制帧写失败会保守停止；不重发原 RPC。
若终态传输失败，先查原件和收据，不能仅凭没收到 `task_result` 推断外部效果。

原始 Core 的 `length_recovery` 事件标记 `scheduled`，包含截断原消息的全局 raw index、
typed source SHA、自动控制 reference ID/SHA 和当时预算。它不是 HTTP 已执行或恢复成功
的收据。`source_hash_format=serde_json_agent_message` 要求将原记录解析成固定版本的
typed `AgentMessage` 后直接 serde 序列化；不能用 checkpoint 字典的 JSON hash 代替。
固定 rpi 的 `Content` typed 编码包含重复的同值 `type` 标签，`Value` 会将其归一。
原消息 typed hash、Journal 文件/链 hash、控制正文 UTF-8 hash 分别校验。

## MCP server（可选）

start 帧可带两个可选字段。不带时帧与行为和以前相同。

| 字段 | 类型 | 说明 |
|---|---|---|
| `mcp_servers` | 对象 | 与 Claude Code `.mcp.json` 的 `mcpServers` 相同：键是 server 名，值是 stdio（`command`、`args`、`env`）或 `{"type":"http","url":..,"headers":..}`。`${VAR}` 与 `${VAR:-default}` 按 sidecar 进程环境展开。解析由 `morrow-agent-mcp` 完成，规则见该 crate 的 README。 |
| `mcp_options` | 对象，可选 | `required`（server 名数组，其中任一连接失败即拒绝 start）、`startup_timeout_ms`、`call_timeout_ms`。没有 `mcp_servers` 时出现此字段视为配置错误。 |

- sidecar 在 Task 准入之前连接全部 server。配置无效、`required` 中有未配置的名字，或 `required` server 连接失败时，stderr 写 `start_config_rejected`，退出码 2，stdout 零帧，不向上游发请求。
- 连接完成后、任何 Task 帧之前输出一帧 `{"kind":"mcp_status","version":1,"task_id":..,"servers":{<name>:{"status":"connected","tools":n,"instructions":..}|{"status":"failed","reason":..}},"excluded":[{"server":..,"tool":..,"reason":..}]}`。错误与原因中不出现 `env`、`headers` 的取值。
- MCP 工具以 `mcp__<server>__<tool>` 命名加入本次 Task，与 Host 工具或内置工具重名时拒绝 start。Plan 模式下不提供 MCP 工具。Task 结束后 sidecar 关闭全部 server。
- stdio server 继承 sidecar 的环境再叠加 `env`。Python 与 Node 客户端只把白名单变量传给 sidecar（含 `PATH`、`SYSTEMROOT`、`SYSTEMDRIVE`、`TEMP`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`PROGRAMDATA` 等 Windows 基础变量），server 需要的其他变量写进它自己的 `env`。

## 长度截断停止审查（可选）

start 帧 `length_stop_review` 与 Harness `TaskOptions.length_stop_review` 相同，只在 Execute 模式可用，默认关闭。开启后 Run 因模型输出达到长度上限停止时，sidecar 依次发出：

1. `verify_stop_request`：body 为 `{"snapshot":..}`，超过帧上限时改为 `{"snapshot_ref":{"path":..,"sha256":..}}`。Host 回 `{"kind":"verify_stop_reply","version":1,"rpc_id":..,"task_id":..,"run_id":..,"receipt":<ReviewReceipt>}`。
2. receipt 为 `NeedsChanges` 且还有 Run 预算时，发 `prepare_stop_request`：body 为 `{"stop_continuation":{"previous":..,"receipt":..,"next_run_number":..,"remaining_calls":..,"deadline_unix_ms":..}}`，过大时为 `{"stop_continuation_ref":..}`，内容同时写入证据目录 `jsonl-stop-continuation-<n>.json`。Host 回 `{"kind":"prepare_stop_reply","version":1,"rpc_id":..,"task_id":..,"run_id":..,"run_id_next":..,"objective":..}`。

快照或续作文件在 Host 处理期间被改动时，sidecar 以 `stop_snapshot_changed_during_verify` 或 `stop_continuation_changed_during_prepare` 失败。Python 客户端对应 `verify_stop_snapshot` / `prepare_stop_continuation`，Node 客户端对应 `callbacks.verifyStopSnapshot` / `callbacks.prepareStopContinuation`；开启该选项却缺少回调时，客户端在启动 sidecar 之前报错。

## 未知副作用回执引用

外部工具回调失败，或 Host 回复 `settlement=Unknown` 时，该调用的工具结果 details 为 `{"executed":"unknown","source":"jsonl_external_callback","receipt_ref":{"path":..,"sha256":..}}`。`receipt_ref` 指向证据目录中的 `jsonl-rpc-<rpc_id>-unknown.json`，其中记录 `native_call_id`、`tool_name`、`args_sha256` 与 `reason`（`callback_unknown` 或 `host_declared_unknown`）。Task 结束时 `outcome.json` 的 `unknown_effects` 列出这些调用；`task_result` 帧的键集合不变。Python 客户端用 `parse_unknown_effects(outcome)` 读取，Node 客户端在 `wait()` 结果中提供 `unknownEffects`。

## 恢复被 fence 的 Task（resume，可选）

约束：

- `resume` 字段可选。省略时 start 帧按原有行为执行，帧序列与以前相同。
- 带 `resume` 时，sidecar 不新建 Task，而是对 `task` 与 `run` 指定的 Session 调用一次 Harness `resume_checked`（`refuse_larger_run_caps=true`）。
- `reconcile_request` 携带请求 ID `rpc_id` 与 Harness `ResumeReview` 内容。
- `reconcile_reply` 必须携带与对应 `reconcile_request` 相同的请求 ID（`version`、`task_id`、`run_id` 也相同），在 Task 的 `deadline_unix_ms` 之前写入 stdin；其 `receipt` 按 Harness `ResumeReceipt` 解析。

`task` 必须与原 Task 相同，`evidence_dir` 除外，它必须是新的、尚不存在的目录。`run` 中只有 `run_id`、`objective`、`max_calls`、`max_seconds` 可以不同，其余字段进入 Host authority 哈希；`max_calls`、`max_seconds` 不得大于原 Task 首次准入的值。

start 帧的 `resume` 字段：

| 字段 | JSON 类型 | 必填或可选 | 取值约束 | 含义 |
|---|---|---|---|---|
| `resume` | 对象 | 可选 | 恰含下面两个子字段 | 选择 resume 路径 |
| `resume.version` | 整数 | 必填 | 等于 1 | resume 子对象版本 |
| `resume.fence_sha256` | 字符串 | 必填 | 64 位小写十六进制 | Host 检查过的 fence 文件字节的 SHA-256；fence 已变化时拒绝 |

`resume` 为 `null`、类型不符、缺少子字段或含未知子字段时，stderr 写 `start_config_rejected`，退出码 2，stdout 零帧。

sidecar 在 Harness 准入之前启动 stdin 读取，然后发出一帧结算请求 `reconcile_request`：

| 字段 | JSON 类型 | 必填或可选 | 取值约束 | 含义 |
|---|---|---|---|---|
| `kind` | 字符串 | 必填 | `reconcile_request` | 帧类型 |
| `version` | 整数 | 必填 | 1 | 协议版本 |
| `rpc_id` | 字符串 | 必填 | 本进程内唯一 | 请求 ID，回复须原样带回 |
| `task_id` | 字符串 | 必填 | 等于 start 帧 `task.task_id` | 原 Task |
| `run_id` | 字符串 | 必填 | 等于 start 帧 `run.run_id` | resume 后新 Run 的 ID |
| `review` | 对象 | 与 `review_ref` 二选一 | Harness `ResumeReview` | 待结算内容：`task_id`、`session_path`、`resume_evidence_dir`、`fenced_evidence_dir`、`fence`（原 fence 文件 JSON）、`fenced_outcome`（原 `outcome.json` 或 null）、`interrupted_run`（null 或 `{run_id, open_tool_calls:[{id,name,arguments}], raw_count}`）、`consumed_runs`、`consumed_calls`（不退还的累计消耗） |
| `review_ref` | 对象 `{"path","sha256"}` | 与 `review` 二选一 | 帧超过 262144 字节时使用 | 指向新证据目录下的 `jsonl-resume-review.json` |

Host 在 Task deadline 之前回一帧 `reconcile_reply`：

| 字段 | JSON 类型 | 必填或可选 | 取值约束 | 含义 |
|---|---|---|---|---|
| `kind` | 字符串 | 必填 | `reconcile_reply` | 帧类型 |
| `version`、`rpc_id`、`task_id`、`run_id` | 整数、字符串 | 必填 | 与对应 `reconcile_request` 完全相同 | 关联到唯一的待处理请求 |
| `receipt` | 对象 | 必填 | 恰含下面四个字段 | Harness `ResumeReceipt` |
| `receipt.committed` | 布尔 | 必填 | 为 false 时拒绝 | Host 已保存本次结算 |
| `receipt.settlement` | 字符串 | 必填 | `Settled` 或 `Unknown`；`Unknown` 时拒绝 | 结算是否完成 |
| `receipt.tool_calls` | 数组 | 必填 | 与 `interrupted_run.open_tool_calls` 一一对应且顺序相同；没有开放调用时为空数组 | 每个开放调用的结算 |
| `receipt.tool_calls[].call_id` | 字符串 | 必填 | 等于对应开放调用的 `id` | 被结算的调用 |
| `receipt.tool_calls[].settlement` | 对象 | 必填 | `{"kind":"not_executed"}`，或 `{"kind":"completed"或"failed","output":字符串}` | Host 依据自己的回执得出的结果，写入该调用唯一的 ToolResult |
| `receipt.evidence` | 字符串数组 | 必填 | 为空时拒绝 | Host 自己的操作回执引用 |

请求与回复按现有方式写入新证据目录的 `jsonl-rpc-<n>-request.json`、`jsonl-rpc-<n>-reply.json`。回复写盘后才交给 Harness 校验，是否放行以 Harness 结果为准。请求只发一次，从不重发。

任一拒绝都发生在首次上游请求之前：stderr 只写 `task_admission_rejected`，退出码 2，fence 文件与原有回执不变。Harness 在调用 Host 前就拒绝时（Task 不存在、没有 fence、fence 哈希不符、Task 条款或 authority 改变、预算改变或单 Run 上限增大），stdout 零帧，也不创建新证据目录。已发出 `reconcile_request` 后被拒绝时，新证据目录中写 `jsonl-resume-rejected.json`：`{"category":<类别>,"no_replay":true}`。类别：

| 类别 | 原因 |
|---|---|
| `rpc_mismatch` | 回复的 `rpc_id`、`task_id`、`run_id` 或 `version` 与待处理请求不一致，或它是另一种已知回复 |
| `invalid_reply_fields` | 回复不是合法的单行 JSON、`kind` 未知，或缺少字段、含未知字段、字段类型不符 |
| `stdin_closed` | 回复之前 stdin 已关闭 |
| `reconcile_timeout` | Task deadline 到达：sidecar 发 `callback_cancel`，等待 `cancel_grace_ms` 后拒绝 |
| `resume_cancelled` | 回复之前收到 `cancel` |
| `receipt_uncommitted`、`settlement_unknown`、`evidence_empty`、`call_mismatch` | Harness 拒绝了已关联的回执 |
| `harness_refused` | 其他 Harness 拒绝 |

Python 客户端：Host 提供 `async reconcile_resume(review, cancelled)`。config 含 `resume` 而没有该回调时，在启动 sidecar 之前抛 `ValueError`。回调异常、返回值字段或类型不符、回复帧超过 262144 字节、deadline 前未返回时，不写回复，抛 `ReconciliationRequired`，消息首段为 `reconcile_callback_exception`、`reconcile_receipt_invalid`、`reconcile_frame_too_large` 或 `reconcile_timeout`。不含 `resume` 时收到 `reconcile_request`，或同一次 `run_task` 收到第二个，消息首段为 `reconcile_request_unexpected`。

Node 客户端：`callbacks.reconcileResume(review, {signal, frame})`。`start.resume` 存在而回调缺失时，`startTask` 在 spawn 之前抛 `Error('reconcile_callback_missing')`。失败时不写回复，`wait()` 结果的 `fault` 为 `reconcile_callback_threw`、`reconcile_receipt_invalid`、`reconcile_timeout`、`reconcile_aborted` 或 `reconcile_request_unexpected`，不含回调异常原文和 `modelToken`。`cancel()` 与 deadline 都会中止传给回调的 `signal`。

### resume 示例

下面的代码块由 `tests/test_protocol_doc_examples.py` 直接从本文件读取并在受控 provider 下执行。信息串格式为 `jsonl-example id=<序列>.<序号> from=<host|sidecar> expect=<帧类型,...>`：

- `from=host`：Host 写入 stdin 的一帧。`expect` 列出 sidecar 收到它之后、Host 下一帧之前输出的帧类型及顺序；`none` 表示不再输出任何帧，进程以退出码 2 结束。
- `from=sidecar`：sidecar 输出的一帧，`expect` 是它自己的类型。路径在实际帧中是 Harness 规范化后的绝对路径（Windows 上为 `\\?\` 形式）；`fence` 与 `candidate.basis` 只列出部分字段，实际帧带原对象的全部字段。
- 同一序列的块按序号在一个新 sidecar 进程中执行。

示例只使用下列占位符，Host 按表替换后再写入；示例不含凭据，凭据仍只来自子环境 `MORROW_AGENT_MODEL_TOKEN`。

| 占位符 | 出现位置 | 替换为 |
|---|---|---|
| `<ROOT>` | 字符串开头 | Host 为该 Task 准备的绝对目录（正斜杠写法）；Host 预先创建 `<ROOT>/workspace` 与 `<ROOT>/state` |
| `<ENDPOINT>` | 整个字符串 | 模型入口 URL；示例声明 loopback 模型 |
| `"<DEADLINE_UNIX_MS>"` | 整个 JSON 值 | 原 Task 的 `deadline_unix_ms`，写成 JSON 整数 |
| `<FENCE_SHA256>` | 整个字符串 | Host 读取的 fence 文件字节的 SHA-256 |
| `"<CANDIDATE_BASIS>"` | 整个 JSON 值 | 前一帧 `verify_request` 的 `candidate.basis` 对象，原样复制 |
| `<SHA256>` | 整个字符串，仅 sidecar 帧 | 实际文件字节的 SHA-256 |

示例中被 fence 的原 Task 由同一个 start 帧启动，区别只在没有 `resume`、`evidence_dir` 为 `<ROOT>/evidence-first`、`run.run_id` 为 `run-1`、`run.objective` 为原任务目标。它的第一个 Run 在 `deploy` 调用 `call-1`（参数 `{"step":"a"}`）执行期间进程被终止，Session 中留下这个没有结果的开放调用。

成功 resume 的完整帧序列：

```jsonl-example id=resume-ok.1 from=host expect=reconcile_request
{"kind": "start_task", "version": 1,
 "task": {"task_id": "task-1", "criteria_revision": "criteria-v1", "authorization_revision": "grant-v1", "kind": "Coding",
          "evidence_dir": "<ROOT>/evidence-resume", "max_runs": 2, "max_calls": 8, "deadline_unix_ms": "<DEADLINE_UNIX_MS>"},
 "run": {"run_id": "run-2", "objective": "Continue after the Host settled the interrupted deploy.",
         "cwd": "<ROOT>/workspace", "session_path": "<ROOT>/state/session.json", "environment_state": "<ROOT>/state/environment",
         "device_fp": "host-device", "session_key": "host-session", "mode": "execute",
         "endpoint": "<ENDPOINT>", "model": "host-model-id", "max_calls": 4, "max_seconds": 60, "max_output": 2048,
         "model_resolution": {"kind": "host_declared_loopback",
                              "capabilities": {"context_window": null, "max_tokens": 8192, "input": ["text"]}},
         "tools": [{"name": "deploy", "description": "Host-owned deploy step",
                    "parameters": {"type": "object", "properties": {"step": {"type": "string"}}, "required": ["step"],
                                   "additionalProperties": false},
                    "allow_in_plan": false}]},
 "cancel_grace_ms": 1000,
 "resume": {"version": 1, "fence_sha256": "<FENCE_SHA256>"}}
```

```jsonl-example id=resume-ok.2 from=sidecar expect=reconcile_request
{"kind": "reconcile_request", "version": 1, "rpc_id": "rpc-1", "task_id": "task-1", "run_id": "run-2",
 "review": {"task_id": "task-1", "session_path": "<ROOT>/state/session.json",
            "resume_evidence_dir": "<ROOT>/evidence-resume", "fenced_evidence_dir": "<ROOT>/evidence-first",
            "fence": {"version": 1, "task_id": "task-1", "state": "active_or_unknown"},
            "fenced_outcome": null,
            "interrupted_run": {"run_id": "run-1",
                                "open_tool_calls": [{"id": "call-1", "name": "deploy", "arguments": {"step": "a"}}],
                                "raw_count": 2},
            "consumed_runs": 1, "consumed_calls": 4}}
```

被终止的 Run 没有观测记录，按准入上限 4 全额计入 `consumed_calls`。Host 依据自己的操作回执结算 `call-1`：

```jsonl-example id=resume-ok.3 from=host expect=verify_request
{"kind": "reconcile_reply", "version": 1, "rpc_id": "rpc-1", "task_id": "task-1", "run_id": "run-2",
 "receipt": {"committed": true, "settlement": "Settled",
             "tool_calls": [{"call_id": "call-1",
                             "settlement": {"kind": "completed", "output": "deploy step a applied once (Host receipt deploy-call-1)"}}],
             "evidence": ["host-receipt:deploy-call-1"]}}
```

```jsonl-example id=resume-ok.4 from=sidecar expect=verify_request
{"kind": "verify_request", "version": 1, "rpc_id": "rpc-2", "task_id": "task-1", "run_id": "run-2",
 "candidate": {"basis": {"task_id": "task-1", "criteria_revision": "criteria-v1", "authorization_revision": "grant-v1",
                         "run_id": "run-2", "run_number": 2},
               "output": "Deployed after the Host settlement.", "goal": null}}
```

```jsonl-example id=resume-ok.5 from=host expect=task_result
{"kind": "verify_reply", "version": 1, "rpc_id": "rpc-2", "task_id": "task-1", "run_id": "run-2",
 "receipt": {"basis": "<CANDIDATE_BASIS>", "committed": true, "settlement": "Settled", "verdict": "Verified",
             "evidence": ["host-check:after-resume"]}}
```

```jsonl-example id=resume-ok.6 from=sidecar expect=task_result
{"kind": "task_result", "version": 1, "task_id": "task-1", "stop": "AwaitingHostAcceptance", "task_accepted": false,
 "runs": 2, "observed_calls": 5, "fence_presence": "Released", "reconciliation_fence": null,
 "outcome_ref": {"path": "<ROOT>/evidence-resume/released.json", "sha256": "<SHA256>"},
 "local_callbacks_finished": true}
```

`resume` 字段格式无效（含未知子字段 `mode`）的 start 帧：stdout 零帧，stderr `start_config_rejected`，fence 与原有回执不变。

```jsonl-example id=resume-invalid-field.1 from=host expect=none
{"kind": "start_task", "version": 1,
 "task": {"task_id": "task-1", "criteria_revision": "criteria-v1", "authorization_revision": "grant-v1", "kind": "Coding",
          "evidence_dir": "<ROOT>/evidence-resume", "max_runs": 2, "max_calls": 8, "deadline_unix_ms": "<DEADLINE_UNIX_MS>"},
 "run": {"run_id": "run-2", "objective": "Continue after the Host settled the interrupted deploy.",
         "cwd": "<ROOT>/workspace", "session_path": "<ROOT>/state/session.json", "environment_state": "<ROOT>/state/environment",
         "device_fp": "host-device", "session_key": "host-session", "mode": "execute",
         "endpoint": "<ENDPOINT>", "model": "host-model-id", "max_calls": 4, "max_seconds": 60, "max_output": 2048,
         "model_resolution": {"kind": "host_declared_loopback",
                              "capabilities": {"context_window": null, "max_tokens": 8192, "input": ["text"]}},
         "tools": [{"name": "deploy", "description": "Host-owned deploy step",
                    "parameters": {"type": "object", "properties": {"step": {"type": "string"}}, "required": ["step"],
                                   "additionalProperties": false},
                    "allow_in_plan": false}]},
 "cancel_grace_ms": 1000,
 "resume": {"version": 1, "fence_sha256": "<FENCE_SHA256>", "mode": "force"}}
```

请求 ID 与 `reconcile_request` 不匹配的 `reconcile_reply`：sidecar 不把它交给 Harness，不再输出帧，stderr `task_admission_rejected`，新证据目录写 `jsonl-resume-rejected.json`（类别 `rpc_mismatch`），fence 与原有回执不变。

```jsonl-example id=resume-rpc-mismatch.1 from=host expect=reconcile_request
{"kind": "start_task", "version": 1,
 "task": {"task_id": "task-1", "criteria_revision": "criteria-v1", "authorization_revision": "grant-v1", "kind": "Coding",
          "evidence_dir": "<ROOT>/evidence-resume", "max_runs": 2, "max_calls": 8, "deadline_unix_ms": "<DEADLINE_UNIX_MS>"},
 "run": {"run_id": "run-2", "objective": "Continue after the Host settled the interrupted deploy.",
         "cwd": "<ROOT>/workspace", "session_path": "<ROOT>/state/session.json", "environment_state": "<ROOT>/state/environment",
         "device_fp": "host-device", "session_key": "host-session", "mode": "execute",
         "endpoint": "<ENDPOINT>", "model": "host-model-id", "max_calls": 4, "max_seconds": 60, "max_output": 2048,
         "model_resolution": {"kind": "host_declared_loopback",
                              "capabilities": {"context_window": null, "max_tokens": 8192, "input": ["text"]}},
         "tools": [{"name": "deploy", "description": "Host-owned deploy step",
                    "parameters": {"type": "object", "properties": {"step": {"type": "string"}}, "required": ["step"],
                                   "additionalProperties": false},
                    "allow_in_plan": false}]},
 "cancel_grace_ms": 1000,
 "resume": {"version": 1, "fence_sha256": "<FENCE_SHA256>"}}
```

```jsonl-example id=resume-rpc-mismatch.2 from=host expect=none
{"kind": "reconcile_reply", "version": 1, "rpc_id": "rpc-9", "task_id": "task-1", "run_id": "run-2",
 "receipt": {"committed": true, "settlement": "Settled",
             "tool_calls": [{"call_id": "call-1",
                             "settlement": {"kind": "completed", "output": "deploy step a applied once (Host receipt deploy-call-1)"}}],
             "evidence": ["host-receipt:deploy-call-1"]}}
```

## 持久队列执行

Host 先通过 `queue_enqueue` 保存 Trigger、Mandate 和 Assignment，再在原任务 Start 帧中增加 `orchestration`。

```json
{"orchestration":{"directory":"C:/host/queue","assignment_id":"assignment-1","worker_id":"host-worker-1","lease_expires_at_ms":0,"configuration_sha256":"<64 lowercase hex digits>","attempt_id":"attempt-1"}}
```

`lease_expires_at_ms` 必须采用实际未来时间。Assignment 的 Task ID、预算、截止时间、criteria/authorization revision、Session、cwd、TaskOptions 和配置 hash 与 Start 保持一致。首次执行使用原证据目录，后续 Resume 或 Continue 使用新目录与新的 attempt/Run ID。Harness 的原 supervisor 持有进程锁、续租、取消、执行和结果落盘职责，JSONL 复用它实际创建的 TaskHandle。`task_result` 发送前，原 Harness outcome 已记录到队列。

已审核续作在同一 Assignment 下传原有 `continue_reviewed`。故障恢复传原有 `resume`，Host 回调 `reconcileResume` 结算原工具效果。Watchdog 或取消后的恢复还需 `orchestration.recovery_authorization_ref`，引用原生 `RecoveryAuthorization`，decision 为 `continue_after_reconciliation`。尚未准入的原 intent 可通过 `retry_unadmitted_ref` 加 `never_admitted` 授权重试，保留原 attempt ID、Run ID 和证据目录，并省略顶层 resume/continue_reviewed。

`queue_snapshot` 中的 phase 记录执行阶段。`queued` 等待领取，`claimed/dispatching/running` 表示 supervisor 的领取、准入与执行阶段，`recovery_required` 需要原效果对账，`settled` 表示队列已收齐结果。业务验收继续由 Host 根据原 outcome 和明确审核操作决定。

## Host 管理入口

每个管理进程接收一帧 `{"kind":"manage","version":1,"id":"请求 ID","request":{...}}`。`request.operation` 选择方法库、上下文、Goal 或持久队列操作。管理请求沿用 256 KiB 帧限制，重复字段、未知字段和不匹配的版本会被拒绝。Node 入口为 `@ry/morrow-agent/management` 的 `sendManagement`。

`skill_catalog` 接受 `roots`、可选 `offset` 和 `limit`。默认 offset 为 0，limit 为 32，可配置范围为 1–64。管理目录按 scope/name 排序，返回 `skills`、`offset`、`next_offset`、`total_candidates`、`partial` 和 `issues`。`next_offset` 为 null 时已到末页，`partial` 表示来源读取错误，详情位于 `issues`。单页结果预算为 128 KiB，每个库最多枚举 8192 个有效名称。Host 应连续读取后续页，并向用户展示来源错误。

上下文操作使用原 Session 的规范化路径。`context_snapshot` 返回来源、记忆和摘要。`context_command` 支持 Core 原生 `/memory` 与 `/reference` 命令，`context_add_reference` 保存带来源 hash 的引用。这两个写操作可传 `compact:true`，分别返回 `command_id/output` 或 `command_id/reference_id`。默认响应保留原有 context 字段。

小响应在 `management_result.value` 中返回。超过单帧大小的 Session 或队列结果使用互斥的 `value_ref`，包含文件 `path` 和 `sha256`。Session 结果文件位于 `<session>.management`，队列结果文件位于 `<directory>/management-results`。文件采用独立名称并在发布引用前落盘，最大结果为 64 MiB。Node 客户端从原始请求推导允许目录，复用 `readCheckedJsonReference` 校验 hash、路径、链接和大小，然后返回与小响应相同的值结构。文件引用写入失败、超时和传输失败可能发生在操作已提交之后，Host 应先检查原状态。

`goal_snapshot` 接受 `session/cwd`，返回当前 Goal 或 null。`goal_control` 接受 `session/cwd/goal_id/command/command_id/expected_revision/reviewed_run`，command 支持 `status/accept/pause/resume/stop`。`command_id` 是 Core 持久化幂等键，外层 `id` 用于传输关联。操作取得已释放 Session 的锁后调用 Core，审核接受会检查最新 settled Run 和 revision。未知副作用留下的 Session fence 需要先对账恢复。

`job_snapshot` 接受 `session/cwd/device/session_id` 和可选 `job_id`。Host 从持久 Goal lease 核对 owner，返回该 Goal 的 `goal_id/goal_status/device/session_id/jobs`。Job 状态来自原生 Manager，保留 `interrupted`、`effects_unknown` 和终态时间，响应省略私有 `worker_nonce`。此观察入口可在等待 Job 的 Task fence 存在时调用。

Job 回执的 `terminal` 表示 PTY 终端模式。正常结束以 `finished_at` 非 null 为准；worker 丢失时可能为 `state=interrupted`、`effects_unknown=true` 且 `finished_at=null`。Host 应显示待对账状态并更新恢复入口，不能把中断当作成功，也不能仅依据 `terminal` 判断完成。

启动后台 Job 后，Core 可返回 `GoalWaiting` 并保留 fence。Host 等待原生 Job 终态回执，保存观察证据，再通过原 Task 的 checked resume 继续。已闭合的 job_start 工具回合通常没有待结算 open tool calls，Host 仍须按实际 ResumeReview 返回对应回执。后续 Run 继承原 lease、worker、Task 预算和截止时间。

`provenance_query` 接受 `scopes` 和原生 `ProvenanceQuery` 的 `query` 过滤字段。每次请求提供一个明确的 Task/Session/evidence_dir scope，Host 逐 Task 汇总跨任务查询。返回原生 `entries/scope_errors`，保留 ledger hash 和来源状态。大结果引用仅位于所授予 evidence_dir 下的 `management-results`，查询结果的来源证明与业务 Task acceptance 各自保留。
