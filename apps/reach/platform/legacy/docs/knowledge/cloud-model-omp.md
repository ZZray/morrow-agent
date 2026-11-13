# Hub 网关模型配置（原 OMP provider 已退役）

## 现状（自 snapshot e6fdc9c 起）

- Hub 只有一份模型配置 `gateway.json`：`gateway_root` / `gateway_token_env` / `default_model` / `default_protocol` / `allow_loopback`。
- 模型目录与协议解析复用 `internal/gatewayclient`（`GET {root}/v1/models`），模型请求复用 `internal/providers`。Hub 不再读 OMP 配置，也不再自建第二套 HTTP/SSE 解析或供应商路由。
- 令牌只来自环境变量（默认 `HW_GATEWAY_TOKEN`，可用 `gateway_token_env` 改名）：不落盘、不进 REST 响应、不写日志。UI 只显示变量名 + `has_token` 存在状态，没有也不该有密钥输入框。
- 聊天与 Skills 草稿生成共用同一份配置：`POST /api/chat`、`/api/chat/continue` 每次都带 `model` + `protocol`；`POST /api/skills/generate` 用已保存的默认模型。

## UI 接线（apps/handwave/web）

- 配置对话框 `#cloudModelDialog`（`web/skills-ui.js`）读写同一份 `gatewayPublic`。字段名以 `apps/handwave/gateway.go` 的 json tag 为准——是 `gateway_token_env`，不是 `token_env`；fixture 也必须用真名，否则错误会被测试掩盖。
- 「可信目录」判定：只有输入的 root 与令牌环境变量名都和**已保存**配置一致时，服务器目录才能当默认模型建议与协议约束。候选地址或改名后立刻撤销旧目录约束，但保留用户已显式填写的值。
- 首次配置没有目录可用：`default_model` 是可手输 ID 的 input + datalist（保存过的目录只作建议）；协议可显式选 7 种受支持值，或留空由服务器按目录唯一解析——界面不自动猜。
- 「保存并测试目录连通」= PUT 成功后 `POST /api/model-config/test`，只验证目录鉴权与连通（返回 `models` / `model` / `protocol`），文案不得写成模型生成成功。
- 「刷新已保存配置的目录」只 GET 已保存配置；输入与已保存值不一致时拒绝并提示先保存并测试，不声称验证了新地址。
- `migration[]` 与 `catalog_error` 原样可见（一律 textContent，避免注入）；目录为空/失败时保留显式选择，不回退 `auto` 或第一个模型。
- 模型悬浮菜单（`web/app.js`）的 Auto = 服务端已保存的 `default_model` + `default_protocol`，不是第三种解析规则。`chatModelSelection()` 是菜单解析 model+protocol 的唯一口径，云端 `POST /api/chat`、`/api/chat/continue` 与消息队列直接用它；本机 `agent-loop` 两处发送点（`startLocalRun`、忙时排队回合）改用 `agentLoopModelSelection()` 包装：model 同源，但 `model==='default'` 时 protocol 一律留空，交 Node 的 fresh Hub grant（显式协议 > 已保存 session hint > Hub 默认）解析，浏览器缓存的默认协议不得冒充显式选择。回归见 `web/agent-loop-protocol.test.cjs`。

## 历史（已退役，勿再照此实现）

- 旧 Hub 从 `~/.omp/用户.ry_switch` 读 CAS / OpenRouter 密钥，配置写在 `cloud-model.json`，聊天路由另有 `upstreams.conf`；UI 是「来源 = OMP / 自定义 + API Key」表单。
- 现在这两个文件只被检测并出现在 `migration[]` 提示里，Hub 不再读取，原文件字节不改；旧供应商/明文密钥 UI 已删除，Hub 不再复制供应商密钥。

## 网络边界（保存与每次请求都校验）

- `gateway_root` 解析后：公网必须 HTTPS；私网、链路本地、组播、保留段拒绝；回环目标必须显式 `allow_loopback`。
- 环境代理只在无凭据且全部解析地址均为回环时接受；重定向始终拒绝；连接 / TLS / 首包有超时，响应体有上限，不重试。
- 目录失败映射为固定、无凭据文案（`gatewayCatalogError`），不回显 URL、token 或 body。`GET /api/models` 现在把目录失败返回非 2xx（不再空 200）。
- 真实连通验证使用 CAS `deepseek-flash` 一类推理模型时，连接测试请求至少 256 tokens，否则正文可能只有 `reasoning_content`。
