# 源码目录

作者：Ray Zhang（Ray）。命名空间：`RY`。

状态：service/contracts、Rust 前台 Node、CLI/MCP 控制器及独立管理页已有基础实现。Windows 服务宿主/IPC 已实现；正式安装、桌面与模型委托仍待验收。实际增量验证见技术文档索引与 evidence；源码存在不等于完整功能验收。

| 目录 | 候选职责 | 当前未决定的内容 |
|---|---|---|
| `service/` | Node 24/TypeScript HTTP 服务；SQLite 身份、配对、操作收据和管理页资源 | Ray 已部署；模型委托接入仍待完成 |
| `contracts/` | Zod 请求校验和机器可读协议 | Rust 消费者须使用同一合同夹具验证 |
| `node/` | 客户端 Host、系统服务、工具后端、按需桌面会话接入、安装身份和执行记录 | 普通服务宿主与本机 IPC 已接通；SCM 安装、打包及具体桌面后端仍待完成 |
| `controller/` | TypeScript CLI 与 MCP stdio；共享登录、稳定请求 ID 和分页事件读取 | 发行打包及实际 Codex 加载验收 |
| `admin/` | 独立登录、连接、配对和运行记录管理页 | 本机与 Ray 统一登录已有证据；完整功能继续按清单验收 |

这些目录描述代码职责，不要求每个目录都成为独立进程或独立发布产品。服务入口为 `src/service/main.ts`，节点与控制器按架构继续实现。

## 依赖归属

- 复用 Morrow 父仓 `crates/morrow-agent-core`、`morrow-agent-harness`、`morrow-agent-jsonl` 与 `morrow-agent-mcp`，不依赖旧 ARA 检出或复制其 Core；当前接线与缺口见[最新交接](../docs/handoffs/2026-11-13-morrow-subproject.md)。
- 产品业务 API/MCP 继续由相应产品维护，Reach 通过公开接口和能力配置接入。
- 通用 Agent 功能在本仓库实现。Ray 工作台提供独立应用入口；LabSlot 集成延期。
- `contracts/` 和 `tests/` 已有实际代码；`integrations/`、`packaging/` 按后续功能需要建立。
- Reach Desk 云端对话是默认不装载的扩展。源码已迁入 [platform/](../platform/README.md)，兼容程序与 Ray 适配来源分别保留；Reach 身份、设备和 Lite/Harness 接线尚未完成；设计见 [platform-extension.md](../docs/platform-extension.md)。

本地恢复候选：`node/agent_finalize.rs` 和 `service/agent-finalizations.ts` 为原生 Released、原 Node 未保存终态提供只读收尾；复用 JSONL 持锁 inspection/seal，不启动原生 Run。schema10、原进程归属及本次候选的实际范围见[证据](../docs/evidence/agent-native-finalize-20261104.md)，完整 R06 尚未验收。

完整Windows候选现按payload-manifest schema2带Agent侧车和相对配置；`node/agent.rs`在声明必带Agent的目录核配置、包清单与实际镜像，不静默退回基础能力。打包入口按独立workspace策略审计并收集原许可；包外自动发现和真实文件工具已验证，见[完整候选证据](../docs/evidence/agent-package-20261104.md)。实际安装和上线仍未执行。
