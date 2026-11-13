# SpinMind 管理与长任务协议验证

作者：Ray Zhang

## 范围

基于 `a3e4f2ae29b444cf29db3b1f8a8e8cdb1b51517a`，本次将 Goal、定向补充消息、已审核续作、持久 dispatcher、方法管理、上下文管理、来源查询和后台 Job 接入 JSONL 与 Node 客户端。管理调用复用 Core 与 Harness；业务身份、配置、凭据和界面仍由 SpinMind Host 持有。

新增协议均由 Host 显式选择。普通 v1 Start 保留原事件形状；完整事件仍是 best-effort，持久证据用于补读。Job worker 由 Host 指定，Goal lease 限制创建权限，启用 worker 不开放本地 exec/read/write/web 工具。

## 交付代码回归

2026-11-13 主线程执行：

| 入口 | 结果 | 本机日志 |
|---|---|---|
| Node 客户端目录全部 `*.test.mjs` | 95 通过，0 失败、0 跳过 | `C:/Users/loveu/AppData/Local/Temp/morrow-final-node-20261113.log` |
| Python `test_start_golden test_jsonl_resume test_resume_cross_language test_artifact_review` | 30 通过，41.172 秒 | `C:/Users/loveu/AppData/Local/Temp/morrow-final-python-20261113.log` |

测试使用 `D:/workspace/env/cache/rust-target/debug/morrow-agent-jsonl.exe` 和受控 loopback provider。Job 使用真实 worker 子进程。结果证明协议、进程、持久化和恢复行为；没有使用真实仪器，也未执行物理断电。

Node 覆盖方法安装/读取/启停/退休、40 项目录分页、大结果引用、路径与 hash 校验、上下文与来源查询、Goal 控制、消息关联、持久队列、取消、跨进程续作及后台 Job。Python 覆盖原 Start golden、原生恢复、跨语言恢复和 artifact review。

## 审查与已修问题

暂停/恢复 Goal 会更新 Journal metadata。已审核续作现在逐项核验其间已提交的 Goal 命令及原 Journal、事件证据；只允许 status/pause/resume，不放宽普通 review 的原 head 校验。

等待 Job 时原 Task fence 保留，Host 使用 `job_snapshot` 观察当前 Goal 的原生 Job 回执。独立业务审查发现用要求已释放 fence 的 `goal_snapshot` 判断等待状态会失败，业务接线已纳入修复与回归。

最终 `cargo fmt --all -- --check` 通过；Core、Harness、JSONL 三个 crate 的 all-targets clippy 在 `-D warnings` 下通过。Core 管理目录分页目标测试 1 项、JSONL lib 23 项通过。日志分别为本机 Temp 下的 `morrow-final-fmt-20261113.log`、`morrow-final-clippy-20261113.log`、`morrow-final-core-management-20261113.log` 和 `morrow-final-jsonl-lib-20261113.log`。

补充 `job_snapshot.goal_status` 后增量构建成功，真实 Job 回归 3 项通过；正向证据为 `C:/Users/loveu/AppData/Local/Temp/morrow-jsonl-jobs-z5z4Ja`。等待期间保持原 fence，查询回执去掉 worker nonce，错误 owner 被拒绝，checked resume 后原副作用计数仍为 1。

Core Job 库存目标测试另有 1 项通过，覆盖当前 Goal 过滤、中断状态及原 intent 不重放，日志为 `morrow-final-job-inventory-20261113.log`。

实现者 `/root/event_protocol_repair` 执行协议与 Rust 检查；主线程检查 management、orchestration、continuation、skill 和 runtime/RPC 变更，并运行 Node、Python 回归。业务层另由该子代理独立审查。未把先前 workspace 全量测试记为本次重新执行。
