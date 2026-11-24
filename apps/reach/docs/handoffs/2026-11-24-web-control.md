# Reach Web 控制台设计交接

登录方案已更新。正式控制台使用 Reach PIN，见[实现交接](2026-11-24-web-console-impl.md)。下文 Microsoft 登录内容保留为原设计记录。

作者 Ray Zhang（Ray）。日期 2026-11-24（Asia/Taipei）。目标入口 [nmrkit.ciqtek.com/reach/](https://nmrkit.ciqtek.com/reach/)。本稿供前端设计及后续接线使用。

## 项目与当前版本

**Reach** 是 Morrow Agent 的独立远程协助应用。维护入口在 `E:/repos/morrow-agent/apps/reach`，受控节点在 Windows 后台常驻，独立服务管理设备和配对。本机 CLI/MCP 发起运维操作，现有网页管理设备和查看原收据，网页发起操作属于本次设计目标。Morrow 提供通用 Agent 能力，Reach 持有自己的身份和操作账本。 [迁移交接](2026-11-13-morrow-subproject.md) · [产品范围](../product-scope.md)

本机与 GitHub `main` 均为 `4f258264405049ace92afba31b0497e21f6057b8`，该提交已合入 Reach。当前工作区另外有未提交的常驻、SSH/Starferry、Node 运行态和 Morrow 能力适配改动。Morrow 基础验收以本仓 **0/52** 和 Desk 选装 **0/5** 的[任务清单](../task-checklist.md)为准。旧 ARA Go 原型与其 RyDev 测试单独保留。 [GitHub 合并提交](https://github.com/ZZray/morrow-agent/commit/4f258264405049ace92afba31b0497e21f6057b8)

### 已有的实现和证据

| 部分 | 真实状态 |
|---|---|
| 基础管理页 | `src/admin/` 已有独立登录、设备列表、配对码、解绑、操作列表和详情、取消、分页事件及操作产物下载。历史版本已在 Ray `/reach/` 页面和真实浏览器中验证。可复用页面 API、状态和错误语义。 |
| Reach 服务 | `src/service/server.ts` 经 SQLite 维护登录、设备、配对和操作账本。服务已有发起操作 API，当前基础页用来查看和取消，网页发起操作需要补接。 |
| Windows Node | `src/node/` 为 Rust。当前工作区已有常驻、`ryreach`、受管 SSH、Starferry、心跳与退避本地回归。Node-only 安装包有候选，正式 SCM/UAC 安装、异常恢复和公网验收仍开放。 |
| CLI 与 MCP | `src/controller/` 管理配对、调用、状态和收据。当前开发入口为 `node src/controller/main.ts mcp`，使用 stdio 和本机认证配置。`ryreach` 是 Windows 节点的配置命令。 |
| 目标站点 | 原 Ray 的历史部署有原件；本次 `nmrkit` 公共路径仅观察到重定向，现有应答无法确认 Reach 版本，后续部署核对入口归属。 |

[历史管理页验收](../evidence/admin-20261102.md) · [历史 Ray 登录部署](../evidence/ray-sso-20261102.md) · [Morrow 常驻与网络复测](../evidence/independent-validation-20261114.md) · [现有前端](../../src/admin/admin.ts) · [当前服务](../../src/service/server.ts)

## 控制台页面

| 页面 | 首版内容与状态 |
|---|---|
| 登录 | 提供「使用 Microsoft 登录」。设计假设为独立 Microsoft OIDC、Windows Hello 处理 PIN 或生物验证。覆盖登录取消、无权限、会话失效。账户类型、租户和允许范围在接入时决定。 |
| 设备 | 展示名称、Node ID、在线状态、最后心跳、版本与可用能力。支持筛选、搜索、生成一次性配对码、重新配对和解绑。设备详情显示配对主体、连接状态、SSH 最近检查及最近操作。 |
| 配置与操作 | 心跳设置同时显示「已请求」和「已生效」，带请求 ID、版本和错误。支持从设备详情发起现有合同覆盖的命令、文件或桌面操作，明确目标与能力就绪情况。操作详情显示输出、原操作 ID、退出或错误、分页事件、取消状态和可下载产物。 |
| 上线通知 | 界面内通知中心显示首次上线、断线恢复及发生时间，可点入设备，支持未读。事件按设备和实际状态变化去重，浏览器重连后接着读原事件。外部推送渠道待定。 |
| 下载 | 展示已签名的 Windows 安装包、版本、架构、发布日期及 SHA-256，提供 GitHub、Gitee、Reach 下载源和历史版本。无已发布签名包时显示发布状态。 |
| MCP | 提供本地控制器安装说明、设备配对引导、当前版 stdio MCP 配置与复制入口。在 Codex 等客户端支持通过 `reach_nodes`、`reach_submit`、`reach_operation` 和 `reach_events` 选设备、提交及查原收据。需交付与网页登录关联到同一 Reach 账户的本地认证；接通前明确显示该状态。 |

登录和设备配对建立管理边界。已配对者统一使用设备已有能力。基础控制台保持运维入口，Reach Desk 可选云端对话使用自己的扩展入口。

### 新设备从安装到上线

下载对应安装包 → 安装 Windows 服务 → 本机 `ryreach` 配置 HTTPS 地址 → 控制台生成配对码 → 在本机配对 → 控制台出现设备 → 首次有效状态上报后显示在线并生成通知。配对命令以最终安装版 CLI 为准，现有页生成的旧 `reach pair` 示例需要核对。

现有服务在配对时创建账户名下的 Node。安装完成但未配对的设备只有本机等待提示，服务端列表因此为空。若后续要求未配对的新安装也可见，需要新增带归属的可信登记，设计可预留「待确认登记」状态。 [配对入库](../../src/service/store.ts) · [身份合同](../identity-pairing.md)

### 操作与状态的显示口径

- 读取 `online`、最近联系 `last_seen`、最近心跳 `lastHeartbeatAt` 和有效间隔 `effectiveHeartbeatSeconds`。配对本身会设置 `last_seen`，因此设备在首次有效联系及能力上报前仍显示「等 Node 上线」。首次上线通知以 Node 实际上报为准。工作区已有动态判断，原页面写死的「最近 30 秒」文案需更新。SSH 状态显示最近一次有效探测。
- 操作分开显示投递、设备接收、执行、执行结果与请求取消。出现结果未知时保留原 ID，默认入口是查询或刷新该操作。展示 `cancelled` 时采用服务的最终结果。
- 使用同一个设备与操作账本。现有事件是单个操作的分页记录，上线通知需要新增设备事件来源和读取协议。

## 现有接口和新增接线

以下路径为 Morrow 服务内部根路径。当前前端按相对路径调 API，公开部署在 `/reach/` 下。

| 接线 | 现有合同或待开发内容 |
|---|---|
| 登录 | 现有 `/api/v1/auth/login`、`me`、`logout` 和历史 Ray 会话桥接。新部署接 Microsoft OIDC 回调，登录后建立独立 Reach 会话。 |
| 设备与配对 | `GET /api/v1/overview`、`POST /api/v1/pairing-codes`、`POST /api/v1/nodes/:id/unpair`。 |
| 运行态与配置 | 当前未提交工作区有 `GET /api/v1/nodes/:id/runtime`、`POST /api/v1/nodes/:id/config`。设置请求为 `requestId` 与 `heartbeatIntervalSeconds`（30–3600），需以交付版本和其回执确认。 |
| 操作 | `POST /api/v1/operations`，已有目标 Node 和调用请求 ID。操作详情、事件游标、取消和产物接口沿用当前服务，网页发起表单和实际接线需补。 |
| 通知、发行下载 | 新增服务端设备上线事件及已签名发行清单。设计稿和交互样例将模拟数据标为演示。 |

[API 源码](../../src/service/server.ts) · [浏览器调用现状](../../src/admin/admin.ts) · [协议约束](../../src/contracts/protocol.ts) · [MCP 实现](../../src/controller/mcp.ts)

## 登录、部署与发布边界

- 现有 CLI/MCP 使用独立签发并保存在本机的 Reach 令牌，设备按 Reach 账户归属。新 Microsoft 入口需补上本机授权或显式账户绑定，保证同一主体在网页与 MCP 能访问同一批已配对设备。网页会话与本机凭据各自管理。 [现有控制器登录](../../src/controller/main.ts) · [设备账户归属](../../src/service/store.ts)
- Reach 采用独立注册的 Microsoft 应用、回调、会话和 CSRF 校验，LabSlot 不参与。候选回调为 `https://nmrkit.ciqtek.com/reach/auth/callback`，最终以 Microsoft 应用登记为准。在 Windows Hello 和账户策略支持时，Microsoft 或 Windows 提示 PIN，由 Windows Hello 解锁本机凭据。Reach 只接收登录结果，页面提供 Microsoft 登录入口。共用域名时核对跨应用 Cookie、Origin 和脚本信任。 [Microsoft OpenID Connect](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc) · [Windows Hello 认证](https://learn.microsoft.com/en-us/windows/security/identity-protection/hello-for-business/hello-how-it-works)
- 浏览器入口使用 `https://nmrkit.ciqtek.com/reach/`，页面和静态资源保留 `/reach/` 基路径，刷新详情仍可进入。Node 和 CLI 配置使用末尾无斜杠的 `https://nmrkit.ciqtek.com/reach`。反代移除一次公开前缀，后端继续处理根 `/api/v1/` 路由。上线前核对浏览器登录、API 和 Node 流量均路由到同一发布版本。 [控制器地址解析](../../src/controller/client.ts) · [Node 地址解析](../../src/node/api.rs) · [历史反代合同](../integrations.md)
- GitHub 和 Gitee 使用同一提交、发行标签和安装包。GitHub 不可达时由 Gitee 分发，备用为 Reach HTTPS 的已验证同版本安装包。发布、验签、自动更新和 SCM 异常恢复的标准见[安装更新合同](../installation-update.md#git-自更新与-windows-服务恢复)。

## 给前端设计者的验收目标

1. 交付登录、设备列表与详情、配对、配置、操作、通知、下载和 MCP 的桌面浏览器设计，含空态、离线、失败及未知结果。各入口直接对应本稿约定的职责。
2. 用同一条样例路径贯通安装、待配对、首次在线通知、远程改心跳、执行操作和取回原收据。明确哪些步骤由现有 API 支撑，哪些使用待开发的接口。
3. 接线后用真实新安装设备验收上线与通知、实际配置生效、操作效果、原收据和幂等行为。Microsoft 登录、下载签名包和 `/reach/` 前缀各自验收。设计交付本身按上述页面与状态检查。
