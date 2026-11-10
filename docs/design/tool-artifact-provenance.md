# ToolArtifact 与 SkillProvenance

## 范围

Morrow 需要把一次工具调用产生的可复核产物交给业务 Host。现有
`experience::Receipt` 只记录当前 Run 的原生工具结果摘要，`skill_library`
只把 exact bundle hash 与当前 Run 的成功回执关联起来。两者都没有统一的
产物身份、任务边界和 Host 验证状态。

本设计增加两个产品中立的数据契约：

- `ToolArtifact` 记录一个工具产物及其输入、输出摘要、来源 Run 和 Host
  证据引用。
- `SkillProvenance` 记录一个 Skill bundle 由哪些已验证产物支持，以及验证者
  和验证回执。

执行循环、工具注册和 Skill 安装流程保持不变。Harness 在已确认的 Run Journal
范围内自动派生 journal-backed candidate，绑定原生 ToolCall、ToolResult、
Task/Session/Run 和输入输出摘要。该 candidate 只证明原生调用与回执的配对，
不代表业务文件已经生成。Host 继续检查真实文件或业务结果，写入或确认自己的
产物记录，并决定是否写入验证记录。ReviewReceipt 保持当前稳定字段，
避免要求既有 Rust Host 和 JSONL 客户端同时升级；新的结构化引用通过 Harness
的实验性回调和 review 侧车接入。

## 数据契约

### ToolArtifact

`morrow-agent-core::artifact_provenance::ToolArtifact` 的固定字段如下：

- `version` 当前为 `1`。
- `artifact_id`、`task_id`、`session_id`、`run_id`、`native_call_id` 是有界
  的 Host 标识。
- `tool` 是产生结果的原生工具名。
- `input_sha256` 和 `output_sha256` 是 Host 对完整输入和输出字节计算的
  小写 SHA-256。正文不写入 Core 证据文件。
- `artifact_ref` 是 Host 定义的相对或不透明引用。Core 拒绝绝对路径、路径
  穿越、URL、查询串和片段，Host 不应把凭据放入其中。
- `status` 是 `candidate`、`verified`、`revoked` 或 `unknown`。
- `created_at` 由回执时间或 Host 提供，作为不透明的有界时间标识保存。
- `host_receipt` 在 Host 验证后保存，包含 receipt ID、相同的来源标识和
  输入输出摘要，以及 `committed` 和 `settled`。

候选产物不允许带 Host receipt。只有 `committed=true` 且 `settled=true` 的
receipt 可以把同一组来源标识和摘要的候选产物提升为 `verified`。Host 可以把
产物标为 `revoked` 或 `unknown`，这两种状态都不能作为 Skill provenance
来源。

### SkillProvenance

`SkillProvenance` 保存：

- `skill_name`、当前 `bundle_hash` 和版本 `1`。
- `source_artifact_ids`，要求每个 ID 在同一 evidence 目录的已验证产物记录
  中存在。
- `task_id`、`session_id`、`run_id`，要求与来源产物一致。
- `validation_receipts` 是结构化的 Host 回执。每条回执包含 Skill 名称、
  exact bundle hash、来源产物 ID、每个来源的 Host receipt ID 与输入输出摘要、
  Task/Session/Run、验证者版本和 `committed`/`settled`。
- `verifier` 和 `verifier_version`。
- `status`、`verified_hash`、`verified_at`。

`verified` 记录必须满足 `verified_hash == bundle_hash`，并且至少有一个来源
产物和一个与 bundle hash、来源产物 ID 完全匹配的已提交回执。读取到新的
bundle hash 后，Host 应调用 `refresh_status`。Hash 变化会保留原始
`bundle_hash` 和 `verified_hash`，把当前观察到的 hash 写入
`observed_bundle_hash`，状态变为 `revoked`。
只有 `verified` 记录可以写入 Harness 的 provenance JSONL。

## 持久化边界

Harness 在每个 evidence 目录提供两个固定路径：

- `tool-artifacts.jsonl`
- `skill-provenance.jsonl`

Core Run 已 joined 且 Journal 范围可读后，Harness 从 `raw_start..raw_end`
配对 Assistant `ToolCall` 与 `ToolResult`，按 canonical JSON 计算输入参数和
完整 typed ToolResult 的 SHA-256，生成 `journal-<sha256>` candidate，引用形如
`journal/<tool-call-raw-index>/result-<result-raw-index>`。工具结果声明
`effects_unknown` 时，自动记录为 `unknown`，不进入 Verified 路径。普通完成路径要求
范围内的调用全部闭合。取消或中断路径允许范围内存在未结算调用，原调用保存在 Journal。
已闭合的结果仍会落盘。Review 阶段会用
`ReviewBasis.raw_proof` 校验 Journal 没有变化。配对失败、Review proof 变化或候选
写入失败时，Task 保留 fence 并进入 `ReconciliationRequired`，不继续 Host review。

候选写入按记录顺序进行。中途写入失败时，已经落盘的记录保留为现场证据，Task
仍进入 `ReconciliationRequired`，Host 不能据此继续 review。

Host review 可实现 `HarnessHost::review_artifacts`，返回绑定当前
`ReviewBasis`（含 Task、Session、Run）的 `ArtifactReceiptRef`。Host 可以引用
Harness 自动生成的 candidate，也可以追加自己的业务产物记录。Harness 在原始
`run-N-(review|budget-review|stop-review).json` 回执写入后，重新读取
`tool-artifacts.jsonl`，逐字段核对 ID、引用、Task/Session/Run、native call、输入输出
摘要和状态。`Verified` 回执还要求每个引用实际为 `verified`，并带已提交且已结算的
Host receipt。通过后写入 `run-N-artifacts.json`，并将同一组引用放入
`TaskOutcome.artifacts`。如果回执未提交、结算未知或 verdict 为 `Unknown`，引用仍
   写入 `run-N-artifacts-callback.json` 作为未接受的回调证据，`TaskOutcome` 不发布
   这些引用；校验失败保留原始回执、保持 fence，不继续 Run，也不释放 Session。没有
   引用的旧 Host 仍走空列表路径。

`append_tool_artifact` 先校验记录，再在 evidence 目录锁下追加一行并同步文件。
同一 `artifact_id` 的后续记录只能表示允许的状态转移：`candidate` 可以变为
`verified` 或 `revoked`，`verified` 可以变为 `revoked`。所有来源字段和已验证
receipt 保持不变，`unknown` 不能提升为 `verified`。读取时限制单行和总大小，按
artifact ID 保留首次出现的位置和最后一个状态，因此追加的转移记录不会被误判为
重复记录。同状态重复、来源字段变化和非法转移均会被拒绝。旧版仅接受唯一 ID 的
reader 无法读取包含状态转移的文件，使用这些文件的 Host 需升级 Harness reader。
旧的唯一 ID 文件仍可读取。记录一致性检查无法检测攻击者对文件及全部对应回执的
一致重写，业务存储的访问控制仍由 Host 提供。`append_skill_provenance` 会读取同目录的
ToolArtifact 记录，确认所有来源 ID 都是 `verified`，并逐项核对 Host receipt ID 与输入输出摘要，再追加 Skill 记录。读取 Skill provenance 时也会重新执行这组核对。Core
不自动创建这些记录，也不把它们接入 Agent 主循环。

现有 `experience.json`、Skill metadata 和旧 evidence 文件继续按原格式读取。
缺少本设计字段的旧记录不会被推断为产物或验证过的 Skill。Skill metadata
中的 `verified_hash` 仍表示现有 `skill_verify` 的当前 Run 回执绑定，新的
Harness provenance 是额外的 Host 证据，不覆盖旧字段。

## 验收

1. 两种记录都能 JSON round-trip，非法标识、摘要、状态和版本会被拒绝。
2. 修改输入输出摘要或 Host receipt 的来源标识会拒绝验证。
3. `candidate`、`unknown`、`revoked` 产物不能进入 Skill provenance。
4. 当前 bundle hash 改变后，Skill provenance 变为 `revoked`。
5. Harness 固定路径能追加、读取和拒绝重复或篡改记录。
6. `ReviewArtifactManifest` 能 round-trip；缺失、篡改、Task/Session/Run 不匹配、
   candidate/unknown/revoked 产物不能支撑 `Verified`，而 `NeedsChanges`/`Unknown`
   的引用保留为证据。
7. 现有 Core/Harness 测试和 workspace 编译继续通过。

真实模型、业务文件、设备和生产效果仍由 Host 验收，本功能只保存 Host 已经
提交的证据边界。
