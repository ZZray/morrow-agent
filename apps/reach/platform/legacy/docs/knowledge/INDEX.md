# 项目知识库

- [One-time paused-Goal appointments](scheduled-goal-resume.md) — cloud clock, original authority, native command receipts and unknown-effect recovery; no new-prompt/recurrent scheduling.

- [本机 Agent：共享原生核心 + 宿主层](shared-native-agent.md) — nativeapp.Host + 唯一 Engine、访问码续签边界、事件映射、宿主状态与旧历史迁移
- [多智能体委派架构](multi-agent-delegation.md) — delegate_agent、run_node_task、事件流与并行限额
- [本机 agentloop 调度（已替换）](local-agentloop.md) — 旧循环的帧与落盘口径；执行已由共享原生核心接管
- [聊天轮次上下文冻结](chat-turn-context.md) — 同会话并发请求必须按提交时快照隔离，并只继承已完整结束的轮次。
- [Hub 网关模型配置（原 OMP provider 已退役）](cloud-model-omp.md) — gateway.json 与 gatewayPublic schema、UI 可信目录与协议选择、令牌只显示环境变量名、目录测试语义、旧 cloud-model.json/upstreams.conf 迁移提示、网络边界。
- [显式网关配置迁移](gateway-migration.md) — `handwave migrate-gateway` 只读预览/`--apply`：显式 root/model/protocol/token_env、显式配置目录（-config-dir/HW_CONF，dryrun 零写不建目录）、目录与 SSRF 校验、备份与并发防护、no-replace 原子发布、等价 no-op 与不同拒绝。
