---
name: multi-agent-delegation
description: Hub/Node 轻量级多智能体委派架构 — delegate_agent、run_node_task、事件流与限额
metadata:
  type: reference
---

# 多智能体委派架构

## 核心定位

Hub 支持**协调者 + 子智能体**两层模型，Node 支持**本机多步任务**。两种能力独立启用/关闭，互不依赖。

```
用户请求
  └─ chat/chatTurn() — 协调者模型调用
       ├─ [agents=true] inject 协调提示词
       │    └─ 调用 delegate_agent → /api/agents/run (隔离子智能体)
       │         └─ 子智能体 chat 调用（无工具）
       └─ [remote connected] 调用 run_node_task → DataChannel.agent-task
            └─ Node runAgentTask() — exec/read_file/write_file 顺序执行
```

## delegate_agent（Hub 侧隔离委派）

- **端点**: `POST /api/agents/run`，走 SSE 流
- **隔离保证**: 子智能体收到 `tools: []`，无递归工具调用
- **工具暴露逻辑**:
  ```go
  // agents.go — tools 由 chatTools(remote, agents) 决定
  func chatTools(remote, agents bool) []*Tool {
      if agents { return delegateAgentTool + nodeTaskTool }  // 协调者用
      if remote  { return execTool + readTool + writeTool + fileTreeTool }
      return execTool + readTool + writeTool
  }
  // 子智能体永远无工具（见 apiAgentRun）
  ```
- **委托限额**: 每轮最多 3 个并行委派；超出返回 `'Delegate limit reached (max 3 per round).'`
- **任务帧上限**: `maxAgentTaskLen = 12KB`（含 JSON 元数据 + task 内容）
- **Agent 名称上限**: `maxAgentNameLen = 80`

## run_node_task（Node 侧本机任务）

- **传输**: DataChannel `k:"agent-task"` 帧，JSON 序列化后 base64 编码
- **任务帧上限**: `maxNodeTaskFrame = 48KB`（Node 和 Web 两侧均验证）
- **步骤数**: 1–8 步；超过拒绝执行
- **允许步骤类型**: `exec` / `read_file` / `write_file`；其他类型拒绝
- **输出限额**: 单步 `maxNodeAgentStepOutput = 128KB`；累计报告 `maxNodeAgentReport = 512KB`
- **取消**: Hub 通过 `cancelRun()` / `cancelAllRuns()` 向 Node 发送 context 取消信号

## 事件类型

| 事件 | 方向 | 内容 |
|------|------|------|
| `model_request` | Hub→Web | 消息 ID、模型、输入 token |
| `model_response` | Hub→Web | 消息 ID、完成原因、输出 token |
| `agent_start` | Hub→Web | agentID、角色（coordinator/delegate/node）、名称 |
| `agent_finish` | Hub→Web | agentID、最终状态（done/cancelled/error）、耗时 ms |
| `task_start` | Hub→Web | agentID、taskID、目标 |
| `task_finish` | Hub→Web | agentID、taskID、状态 |
| `step_start` | Hub→Web | agentID、taskID、stepIndex、步骤类型+参数 |
| `step_output` | Hub→Web | agentID、taskID、stepIndex、输出片段（chunked） |
| `step_finish` | Hub→Web | agentID、taskID、stepIndex、状态 |
| `tool_start` | Web→记录 | toolID、工具名、参数摘要 |
| `tool_finish` | Web→记录 | toolID、工具名、结果摘要 |

## 并行策略

```javascript
// app.js runToolCalls()
const indexed = new Map(calls.map((tc, i) => [i, tc]));
const delegates = indexed.filter(isDelegate);      // max 3
const others    = indexed.filter(notDelegate);      // 串行

// 委托并行执行（Promise.all），结果写回原索引位置
// 最终按索引顺序合并输出，保持 UI 顺序正确
```

## Node 端取消机制

```go
// node.go
type nodeSession struct {
    runs  map[string]context.CancelFunc  // runID → cancel
    tasks map[string]context.CancelFunc  // taskID → cancel
}
func cancelRun(runID string)    { runs[runID]() }
func cancelAllRuns()            { for _, c := range runs { c() } }
// Session Disconnect → cancelAllRuns()
```

## Web 端取消机制

```javascript
// app.js
let stopRequested = false;
const stopCtl = { abort: null };

function cancelActiveWork() {
    stopRequested = true;
    stopCtl.abort?.();
    for (const w of Object.values(activeWork)) w.abort?.();
}
// 轮次开始时 resetAgentRun() → stopRequested = false
```

## Web 端事件持久化

`store.go` 中 `chatMsg` 新增 `Events []agentEvent`，每次 SSE `trace` 事件追加；用于历史回放和结果页展示。

**Why:** 工具结果中透出完整事件链，让用户看到模型→工具→Node→结果的完整过程，无需打开 DevTools。

**How to apply:** 参照 `chat.go:runToolCalls()` 和 `store.go:chatMsg` 的 `Events` 字段。事件按时间顺序追加，服务端按 `trace` 帧逐条透出，客户端 `recordAgentEvent()` 合并到内存 roster。

---

相关: [[chat-turn-context]] · [[cloud-model-omp]]
