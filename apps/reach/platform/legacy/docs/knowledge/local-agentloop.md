# 本机 agentloop 调度（已替换）

> 状态：**旧本机循环已删除**。`apps/handwave/agentloop/` 不再存在，node 的
> `agent-loop` 回合现在由共享原生核心执行，宿主层见
> [本机 Agent：共享原生核心 + 宿主层](shared-native-agent.md)。
> 本文件只保留旧口径，用于理解线上旧文件与旧帧语义。

## 旧分工

| 层 | 职责 |
|----|------|
| Hub | 校验已授权在线 node，签发 `/v1` 短期码（约 15 分钟） |
| Node `agentloop`（已删除） | Prompt 循环、steer/follow、todo/delegate、compact、retry、旁路 bash、ask_user |
| 工作台 | `本机` 模式发 `agent-loop`；收 `agent-event` 渲染任务板/确认/流式气泡 |

## 关键帧（未变）

- 下行：`agent-loop` / `agent-steer` / `agent-follow` / `agent-abort` / `agent-bash` / `agent-bash-abort` / `agent-mode` / `agent-ui`
- 上行：`agent-event`（含 `text_delta`/`text`/`task_update`/`ui_request`/`retry`/`compact`…）与最终 `out`

## 旧落盘（只读保留）

`confDir()/agent-loop.json`：任务板、steer/follow 队列、历史消息。不含 token。
现在**原字节保留**并另存 `.backup-<sha12>`；新状态在
`confDir()/node-agent-state.json`，对话在 `confDir()/native-sessions/` 的原生 journal。

## 续码

长任务若 grant 过期返回 401/403：旧循环按通用重试循环续码重试；现在宿主只做
**一次有界**续签，且已经流出过内容绝不重放。供应商其它错误不再由宿主重试。

## 工具面（语义保留，注册处已换）

本机：`exec` / `read_file` / `write_file` / `list_dir` / `search_text` / `patch_file`；
会话内置：`todo_write` / `delegate` / `ask_user` / `bash`。它们现在通过
`nativeapp.Host.Tools` 完整注入，而不是旧 `agentloop` 的 `coreTools`。
