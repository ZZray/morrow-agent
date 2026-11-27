# Reach 设置与 Desk 前端交接

作者 Ray Zhang（Ray）。2026-11-24（Asia/Taipei）。

## 可直接交给前端 AI 的任务

在 `E:/repos/morrow-agent/apps/reach` 的现有 Reach 控制台中实现「设置」和「对话」入口，目标站点为 `https://nmrkit.ciqtek.com/reach/`。让 Ray 用现有 PIN 登录后，在页面配置和验证模型，打开 Reach Desk 对话，并查看设备的 Agent、SSH 和操作回执。沿用现有 Reach 界面与交互，参考 HandWave 的对话和工具过程呈现。使用 Morrow 中正在维护的 TypeScript Reach Desk。

工作区有用户和其他任务的未提交改动。先读 Reach 和 `platform/` 的 `AGENTS.md`，核对现有源文件与下面的本地候选，再按实际差异接线。Windows 安装包和受管 SSH 的 Windows 实现由并行任务维护。

## 设置页

在基础控制台提供「设置」入口。配置缺失时也能用现有 PIN 进入设置。给两个用途分别显示有效配置、测试结果和启用状态。

| 设置项 | 对应服务配置 | 界面要求 |
| --- | --- | --- |
| Reach Desk 云端对话 | `REACH_DESK_ENDPOINT`、`REACH_DESK_MODEL`、`REACH_DESK_MODEL_TOKEN` | HTTPS `/v1` 模型入口、完整模型 ID、可替换令牌。显示已保存、连接测试、启用和实际可对话状态 |
| 现场 Agent 模型 | `REACH_AGENT_MODEL_URL`、`REACH_AGENT_MODEL_ID`、`REACH_AGENT_MODEL_TOKEN`、`REACH_AGENT_MODEL_CONTEXT`、`REACH_AGENT_MODEL_MAX_OUTPUT`、`REACH_AGENT_MODEL_IMAGE_INPUT` | 同上，并填写实际上下文长度、单次输出上限和图片输入支持。可以沿用同一生产模型配置，两个用途分别核验 |

用户已经选择由网页配置生产模型。前端应走真实的 Reach 服务设置接口，完成读取状态、保存、测试和启用。当前服务从环境读取模型配置，页面保存接口待实现。接手时先定读写和测试合同，再接通 UI。以下是可采用的最小接口形状，路径可随现有路由约定调整。

- `GET /api/v1/settings/models` 返回当前模型、令牌是否已配置、配置代际及运行状态。
- `PUT /api/v1/settings/models` 在现有会话和 CSRF 校验下保存配置。未提交新令牌时保留旧值，替换通过明确操作完成。令牌只在本次提交送到服务端，后续响应只返回是否已配置。使用服务端受保护的持久配置承接生产令牌，并确认日志与浏览器存储无令牌。
- 测试动作由后端验证实际模型入口及一次有界请求，返回脱敏的真实错误。保存和启用结果分别显示，配置无效时保留上一份有效配置。现有环境配置需要有明确的初始化或迁移路径，用户在网页完成配置后应看到实际生效的模型。

需要统一入口时，链接到这些已有页面或调用现有 API。

| 位置 | 管理项和状态 |
| --- | --- |
| 账户 | 修改 Reach PIN，保留现有登录、失败锁定与会话处理 |
| 设备 | 新建或重新配对、解绑、最后心跳与心跳配置。配置显示待处理、已生效或拒绝及原回执。安装地址展示 `https://nmrkit.ciqtek.com/reach`，配对命令从现有接口生成 |
| 上线通知 | 复用控制台的事件收件箱和已读状态。通知来自设备上报 |
| 下载 | 展示已发布版本、安装步骤、服务地址和 SHA-256。清单没有发行项时显示真实发布状态 |
| MCP | 复用「MCP 接入」页的服务地址和配置说明，连接与授权沿用 Reach |

## Reach Desk

- 入口为 `/reach/desk/`。从控制台进入时延用现有 Reach PIN 会话，直接打开或登录过期时按已有 PIN 流程回跳。请求沿用 `/reach` 前缀和现有 CSRF 校验。
- 纯云端对话可以直接发送，显示流式输出、运行状态、停止和历史。缺配置时提供进入设置的入口，配置失败时显示实际原因。
- 设备对话从当前账户已经配对的设备中选择。显示设备在线、Agent 可用和 SSH 状态，设备与工作目录跟随本次发送。现场 Agent 执行走既有 `agent.delegate`、`/api/v1/operations` 和原回执。将工具进度、最终输出、取消和未知状态显示到同一条消息，刷新后能按原 ID 找回。
- SSH 状态和 Agent 状态分别显示。Windows 0.1.8 本地候选提供 `ryreach ssh enable`。已配对且具备维护权限的 Agent 可以调用该入口，并以 `file.read` 读回 `%ProgramFiles%\RY\Reach\last-ssh-preparation.json`。最终状态取自该回执及 SSH 状态查询。旧版设备缺少能力时显示原因。新机的真实启用尚待验收。

## 可复用的代码与当前证据

- 控制台和登录在 [admin.ts](../../src/admin/admin.ts)、[server.ts](../../src/service/server.ts) 与 [pin-login.ts](../../src/service/pin-login.ts)。已有设备、操作和配置入口可直接复用。
- Desk 使用 [平台启动入口](../../platform/src/main.ts)、[对话页面](../../platform/web/desk.ts) 和 [Desk 设备 Host](../../platform/src/device-tools.ts)。现场委派复用 [Agent 委派合同](../agent-delegation.md)。
- 公共 API 基址是 `/reach/api/v1/`。登录使用 `POST auth/pin`，会话由 `GET auth/me` 查询，写请求附 `x-reach-csrf`。Desk 使用 `desk/devices`、`desk/conversations` 与 `desk/conversations/:id/messages`。发送消息带 `id`、`content` 和可选的 `target:{nodeId,epoch,cwd}`，返回 SSE。`desk/messages/:id/events` 可用 `after` 续读，`POST desk/messages/:id/cancel` 请求停止，原操作从 `operations/:id` 查询。`cwd` 使用目标设备上的绝对路径。`reach_agent_delegate` 由 Desk Host 提供给模型，浏览器从消息和操作接口读执行结果。
- 当前工作区已有未发布的 PIN 会话接线、`?next=desk` 回跳和 `reach_agent_delegate` 候选。服务与 Desk TypeScript 检查通过。本地 15 项测试通过，其中设备委派使用实际 SQLite 和模拟 Node 回执覆盖稳定请求与目标校验。浏览器 PIN 流程、真正的已配对 Agent 回执和 nmrkit 部署待验收。
- 正式 nmrkit 本次核对仍运行基础 Reach，`/reach/healthz` 为 200，`/reach/desk/` 为 404。生产的 Reach 模型配置待产品设置页接通。Desk 发布还需要匹配 Morrow SDK 的 Linux 侧车、受保护的对话目录，以及编译后的页面资源。部署切换见 [nmrkit 启用目标](../platform-extension.md#nmrkit-启用目标)。

## 提交验收结果

1. 用 PIN 从实际页面保存并测试一份模型配置，刷新后状态一致。凭据不出现在读接口、日志或浏览器持久存储。配置错误可修正，已生效的配置仍可查看。
2. 通过 `/reach/desk/` 完成 PIN 回跳、纯云端流式对话、停止和刷新恢复。用真实模型回执区分代码接通与实际可用。
3. 选已配对 Windows 设备，执行一次现场 Agent 任务，按同一操作 ID 核对页面、设备输出和原回执。先在 SSH 关闭时验 Agent，随后验 SSH 启用或失败状态和回执。
4. 核对原设备、配对、下载清单、MCP 和 PIN 在改版后仍可用。交付列出实际改动、真实运行范围和待联调项。

## 实施进度（2026-11-24，设置页）

用户在实施中追加了两项决定，见[知识库](../knowledge/product-decisions.md#model-providers-20261124)：

- 启用后立即切换。
- 模型配置改为多个 OpenAI 兼容供应商，可自定义请求地址、获取模型列表、按模型标注图片识别，上下文默认 1M。

下面是本地实现和验证的结果，尚未部署。

### 接口合同

- **读取。** `GET /api/v1/settings/models` 返回 `providers`（不含令牌，只有 `tokenConfigured`）。另外按用途（`desk`、`agent`）返回各自的已保存、最近测试、已启用、当前运行四层状态。
- **供应商。**
  - `POST /api/v1/settings/providers` 新建，字段为 `{name, baseUrl, token}`。
  - `PUT .../providers/:id` 修改；不带 `token` 时保留原令牌。
  - `DELETE .../providers/:id` 删除；有用途正在引用时返回 409。
  - `POST .../providers/:id/models/fetch` 调供应商的 `GET {baseUrl}/models`。已标注的能力按模型 ID 保留，手动添加的模型不会被抹掉。
  - `PUT .../providers/:id/models` 保存每个模型的 `imageInput`、`contextWindow`（默认 1,000,000）和 `maxOutput`（默认 8192，受 Agent 通道上限约束）。
- **用途。**
  - `PUT /api/v1/settings/models/:purpose` 选定 `{providerId, model}`，每次保存生成新的代际号。
  - 供应商或模型能力变化后，引用它的用途会自动生成新草稿，需要重新测试并启用；运行中的配置不受影响。
- **测试与启用。**
  - `POST .../:purpose/test` 发一次有界请求，失败时返回脱敏后的真实错误。
  - `POST .../:purpose/enable {generation}` 要求这一代测试通过且之后没有改动。启用在同一事务里先替换运行中的模型通道；替换失败时整次启用回滚，旧配置照常运行。
- 所有写接口都走现有会话与 CSRF 校验。实现在 `src/service/model-settings.ts`，路由在 `server.ts`。

### 立即切换的口径

- **现场 Agent。**
  - 通道 `AgentModelBroker.reconfigure` 原地替换地址、令牌和描述；之前没有配置时现场创建通道。
  - 正在传输的模型流沿用开始时的地址和令牌。
  - 按旧路由绑定的任务再请求模型时，按既有合同返回「组织模型路由已变化」，不会悄悄改用新模型。
- **Reach Desk。**
  - `DeskHost.reconfigure` 替换路由；Desk 之前没有加载、但服务以 Desk 组合启动时现场创建。
  - 已开始的回合沿用开始时的路由和令牌。
  - 旧对话按既有合同提示「模型配置已变化，请新建对话」。
  - 基础 Reach 没有加载 Desk 时，Desk 配置可以启用并记录，但不会运行。
- **启动时。** 启动读取已启用的配置。配置被拒绝时服务照常启动，设置页显示原因。

### 存储与迁移

- 供应商和令牌存放在 `reach.sqlite` 的 `model_providers`、`model_settings` 表里，没有另外加密，靠状态目录的文件权限保护。备份状态库会连带备份令牌。
- 某个用途在库里还没有记录时，启动会把现有的 `REACH_AGENT_MODEL_*`、`REACH_DESK_*` 导入为一个名为「环境变量导入」的供应商，并作为第 1 版已启用配置；之后以网页设置为准。
- `platform/src/main.ts` 不再强制要求 Desk 模型环境变量。

### 合同变化

- Agent 通道原先只接受 `/v1` 根路径，现在接受任意 OpenAI 兼容的版本路径（如 `/api/paas/v4`），在其后接 `/chat/completions`；带 `/chat/completions` 的地址仍然拒绝。
- `tests/agent-model.test.ts` 里相应的断言已按用户的新要求调整。
- Desk 侧车仍要求 `/v1`。非 `/v1` 地址启用到 Desk 时，会以 `desk_endpoint_invalid` 明确失败，不会切换。

### 界面

- 设置页从上到下依次是：Reach Desk 卡、现场 Agent 卡、模型供应商卡、账户与设备区。
- 两张用途卡各自选「供应商 + 模型」，显示能力（如「上下文 1M · 输出 8K · 图片识别」），提供测试连接、启用和保存选择。
- 供应商卡可以添加、编辑、删除供应商，获取模型，并在模型表里逐个标注能力或手动添加模型。添加供应商后会自动获取一次模型列表；只填域名时自动补 `/v1`。
- **控件自绘。** 下拉框换成自绘的 `Dropdown`：按钮加列表，列表放在顶层弹层里，能盖住对话框；支持 ↑↓、Home/End、Enter/空格、Esc、Tab 和按字母跳转，有完整的 combobox/listbox 读屏语义。发起操作对话框和模型卡都已改用。复选框、数字输入（去掉微调箭头）和展开箭头也都自绘。
- **动效。** 全部用 CSS 过渡/动画或 WAAPI，只动 `transform` 和 `opacity`。曲线用强 ease-out 与 ease-in-out，界面动效不超过 300ms。
  - 进入新页面时，标题和卡片依次升起；图表折线描出、条形伸展、仪表弹入。同一页的后台刷新重绘不会重复播放。
  - 导航的选中底在两项之间滑动。
  - 弹层从触发点展开，并原路退出。对话框和遮罩有进场和更快的退场。
  - 提示条内容变化时轻微落入；按钮有按压反馈。
  - 减少动效设置下只保留淡入淡出，去掉位移、缩放、描线和脉冲。

### 验证

- `bun run check` 通过；`test:admin` 30/30（模型设置 3 项，模型端为本地协议桩）；`bun run test` 11/11。
- `tests/agent-model.test.ts` 18/18；`platform` 类型检查和 `shutdown.test.ts` 通过。
- 浏览器在明暗两种主题下，对本地协议桩走通了：添加供应商 → 自动获取 4 个模型 → 标注图片识别 → 现场 Agent 选模型 → 测试 → 启用后立即显示「运行中」。
- 读接口、页面和浏览器存储中均无令牌。

### 未做或待联调

- 没有接真实生产模型，也没有在 nmrkit 上部署。
- `DeskHost.reconfigure` 只经过类型检查，没有用真实 Desk 侧车做运行验证。
- Desk 页面本身（设备对话、SSH/Agent 状态、工具过程、刷新找回）未改。
- 同一用途同时使用多个模型（例如由 Agent 自选模型）需要改 Node 协议，不在本次范围内。
- 现场 Agent 的真实回执和 SSH 关闭时的 Agent 通道验收，依赖已配对的 Windows 设备和打包任务。

## 已部署到 Ray（2026-11-25）

用户授权「授权部署」。Ray 上的 Reach 已切换到 `/opt/reach/releases/20261125-unified-d0b1ab4b596e`，切换前后账本一致，自动回退未触发。

- 详细过程、哈希、预演与回退方法见[部署证据](../evidence/ray-unified-20261125.md)。
- 预演发现发行包漏了 `src/controller/artifacts.ts`、`client.ts` 和 `pngjs`，已改为按引用链生成文件清单。
- 对话运行组件在本机 WSL 编译为静态 Linux 程序。
- 待办：
  - 用户登录 Ray 后核对页面；
  - 在设置页配置生产模型；
  - 真实设备 Agent 任务。

## 上 RayWorkbench 的就绪情况（2026-11-25）

接入方式按 `E:/repos/RayWorkbench/cmd/ray_front/reach_ingress.go` 只读核对：

- `ray-front` 把 `/reach/` 反向代理到 `127.0.0.1:18910`。
- 认证：用 Ray 会话签一次性凭证，换取 Reach 会话（`/api/v1/auth/ray`）。
- 代理设置 `FlushInterval=-1`，且没有写超时，流式对话可直接通过。

**已满足（源码与测试确认）**

- 统一认证：Ray 桥接会话可访问对话与设置接口，写请求仍需 CSRF；PIN 会话不能冒充浏览器 Ray 会话（`tests/ray-desk.test.ts`）。
- 前端在 Ray 模式下：隐藏 PIN 相关入口，退出走 `/ray/logout`。
- `/reach/` 前缀下资源与接口全部走相对路径，旧 `/reach/desk/` 跳到 `/reach/#/desk`。
- Ray 登录过期跳回后，回到原来的页面或对话（本标签页暂存）。
- 发行包缺对话代码或运行组件时，服务照常启动并说明原因。此前基础服务静态引用 `platform/`，按现有发行包结构（`service/` 只含 `src/contracts`、`src/service`、`src/admin`、`dist/admin`）会直接起不来；已改为动态加载，并按该结构做了冒烟测试。

**还缺（上线前必须补）**

1. **发行包。** 要带上 `platform/src` 和 `crates/morrow-agent-jsonl/clients/node`。`platform/src/settlement.ts` 用相对路径 `../../../../crates/...` 引用后者，因此发行目录需保持仓库的相对层级，或调整这个引用。
2. **运行组件。** 需要 Linux x86_64 版 `morrow-agent-jsonl`，由 `REACH_DESK_SIDECAR` 指定。
3. **服务配置。** `/etc/reach/service.env` 需保留 `REACH_RAY_SSO_KEY_FILE`、`REACH_COOKIE_PATH=/reach/`、`REACH_TRUSTED_PROXY_ADDRESSES=127.0.0.1`，并有可写的 `/var/lib/reach/desk`。
4. **模型。** 部署后在设置页配置生产模型并启用。
5. **其他。** 线上仍是 2026-11-02 版本；部署与 `ray-front` 切换需要用户授权，按 `docs/deployment-ray.md` 的备份与恢复步骤进行。

## 真实模型验证与收尾（2026-11-25）

- **真实模型。** 本地用 CAS 跑通了纯云端流式对话。
  - 链路：普通入口 `src/service/main.ts` → 设置页添加供应商（指向本地环回转发器）→ 获取 14 个模型 → 选 `gpt-5.6-luna` → 测试 → 启用 → `#/desk` 发消息。
  - 结果：
    - 回答逐段到达，并保存为「回答已保存」；
    - 刷新后按原对话 ID 找回完整回答；
    - 长回答中途「停止回答」显示「已停止」，结算后输入框恢复。
  - 转发器只在自身进程内存里持有 `CAS_API_KEY`，Reach 的设置库和对话运行时只持占位令牌。对 `apps/reach`、本次运行数据和后台任务输出共 46,388 个文件做字节扫描，密钥出现 0 次。
  - 网关把请求的 `gpt-5.6-luna` 映射为 `gpt-6.2-sol`，连接测试如实显示网关返回的模型名。
- **真实模型发现的问题，已修。**
  - 问题：连接测试原先发非流式请求，CAS 网关返回「Stream must be set to true」。
  - 修法：改为与实际调用一致的流式请求，读到第一帧有效回答即结束。
  - 新增「只接受流式的网关也能通过」单测。
- **界面问题，已修。** 外框上边距穿透 `body`，所有页面都比一屏多出 51px，在固定一屏的对话页上表现为整页可滚动。给 `body` 设 `display: flow-root` 后，对话页正好一屏。
- **浏览器测试。** `platform/tests/web.browser.test.ts` 已按统一前端改写：
  - 入口 `#/desk`；
  - 控制台 PIN 登录；
  - 头像菜单退出；
  - 「执行位置」用自绘下拉框；
  - 控制台与对话页互相切换。
  本机没有 Playwright（旧证据中的安装路径已不存在），这 9 项仍跳过，**改写后未运行**。
- **文档。** `docs/platform-extension.md` 的交付形态与 nmrkit 启用目标已按「默认带对话」改写。
- **验证。**
  - 类型检查（Reach 与 `platform`）通过；
  - `test:admin` 37/37；
  - `bun run test` 11/11；
  - `platform` 及 `agent-model` 36 项通过，另 9 项浏览器测试跳过。
- **仍未做。**
  - Linux 版 `morrow-agent-jsonl` 的打包与 nmrkit 部署；
  - RayWorkbench 统一认证；
  - 选定已配对设备的真实 Agent 任务回执；
  - 安装 Playwright 后实际运行浏览器测试。

## 服务端默认带对话（2026-11-24）

用户回复「接着做服务端」，确认服务端默认带对话运行时。

- **启动组合。** `src/service/desk-runtime.ts` 负责启动时的组合，`startReach()` 不传参数时默认调用它；`platform/src/main.ts` 只保留为兼容入口，启动同一套服务。
- **运行组件与状态目录。**
  - `morrow-agent-jsonl` 优先取 `REACH_DESK_SIDECAR`（必须是绝对路径），否则在 PATH 里查找。
  - 状态目录默认为 `<REACH_DATA_DIR>/desk`，可用 `REACH_DESK_STATE_DIR` 覆盖，真正创建运行时才建目录。
  - `REACH_DESK_ENDPOINT/MODEL/MODEL_TOKEN` 仍只在首次启动时导入；令牌读后立即从环境移除。
- **缺组件时。**
  - 服务照常启动，日志记一条 `reach_desk_unavailable`。
  - 设置接口返回 `deskUnavailable` 原因，设置页的 Desk 卡和对话页的空状态都显示这条原因。
- **合同变化。** `platform/tests/default.test.ts` 原本断言「基础进程不带 Desk 代码也能跑」，现改为新合同：缺组件、缺模型时照常启动，对话接口不开放，设置接口报告原因，不建状态目录。
- **验证。**
  - `test:admin` 36/36（新增 `tests/desk-runtime.test.ts` 3 项）；`bun run test` 11/11；`platform` 默认进程、关停、生命周期、结算视图及 `agent-model` 共 24 项通过。
  - 端到端（普通入口，模型端为本地协议桩）：启动后对话接口 404 → 添加供应商、获取 4 个模型、测试、启用 → 对话运行时当场创建，`deskRunning` 为 true，对话与设备接口 200；旧 `/desk/` 跳到 `#/desk`。
- **未做。**
  - Linux 版 `morrow-agent-jsonl` 的打包与 nmrkit 部署；
  - RayWorkbench 统一认证；
  - 真实模型的流式对话；
  - `platform/tests/web.browser.test.ts` 按统一前端重写；
  - `docs/platform-extension.md` 里仍按「可选扩展、`platform/src/main.ts` 入口」描述，需要同步。

## 统一前端（2026-11-24）

按用户决定（见[知识库](../knowledge/product-decisions.md#unified-frontend-20261124)），对话并入 Reach 控制台，只有一套前端。本节取代此前「Desk 页面套用控制台外框」的过渡做法。

- **代码位置。**
  - 对话前端从 `platform/web/` 移到控制台构建：`src/admin/desk.ts`（挂载到 `#/desk`）、`src/admin/desk-settlement.ts`、`src/admin/desk-images.ts`、`src/admin/desk.css`（样式限定在 `.desk` 内）。
  - 由 `tsconfig.admin.json` 统一编译，由 `/assets/*` 提供。
  - `platform/web/`、`platform/tsconfig.web.json`、`platform/src/web.ts` 已删除；`DeskHost` 不再提供静态页面，只提供 `/api/v1/desk/*`。
- **沿用的部分。** 流式、停止、结算核对、按原 ID 找回、图片原图、设备目标等逻辑原样保留。登录、顶栏、主题、下拉框改为直接使用控制台的实现；会话过期时回到控制台登录页。
- **新增的衔接。**
  - 对话 ID 记在路由里，刷新、分享链接能回到原对话。
  - 回答里的设备操作可以点进控制台的原操作记录。
  - 导航顺序：设备、操作、对话、统计、下载、MCP 接入、设置（定义在 `src/admin/shell.ts`）。
- **可用状态。** 进入对话页时实时查询 `/api/v1/settings/models`，因此在设置页启用模型后切回对话页即可使用。三种状态分别显示：
  - 可对话；
  - 运行时已加载、模型未启用；
  - 这台服务没有加载对话运行时。
- **旧地址。** `/desk/?c=<ID>` 由基础服务 308 跳到 `#/desk/<ID>`，与对话运行时是否加载无关。
- **验证。**
  - 检查与测试：类型检查（Reach 与 `platform`）通过；`test:admin` 33/33（新增对话路由和旧地址跳转测试）；`platform` 的结算视图测试改为从新位置导入并通过。
  - 浏览器核对（明暗两种主题）：旧链接跳转、登录后停留在对话页、页面间来回切换（离开对话页时中止读取流）、没有对话运行时的空状态。
- **未做。**
  - `platform/tests/web.browser.test.ts` 仍按独立 `/desk/` 页面编写（需要 Playwright，本机跳过），需要按统一前端重写。
  - 真实模型的流式对话没有跑。
  - 服务端默认加载对话运行时、RayWorkbench 统一认证、部署都未做。

## Desk 融入 Reach（2026-11-24）

用户要求把 Reach Desk 的界面改成当前 Reach 的主题，「集成到 Reach，融入一体」。后续还要部署到 Ray 工作台（RayWorkbench），本次未部署。

- **共享资源。** 控制台与 Desk 共用同源的四份资源，Desk 不再维护第二套视觉：
  - `src/admin/tokens.css`：字体、颜色、明暗主题、动效曲线，从 `admin.css` 抽出，作为唯一来源。
  - `src/admin/controls.css`：自绘下拉框和顶栏。
  - `src/admin/dropdown.ts`：自绘下拉框组件，从 `admin.ts` 抽出。
  - `src/admin/shell.ts`：顶部导航的唯一定义（设备、操作、统计、下载、MCP 接入、对话、设置）。
- **加载方式。** 这些资源由 `/assets/*` 提供；Desk 页面以 `../assets/` 引用 CSS，并动态加载 `theme.js`、`dropdown.js`、`shell.js`。
- **Desk 界面。**
  - 和控制台同一个居中大圆角面板、同一条顶栏，导航里「对话」为当前页，从任一入口切换都像同一个应用。
  - 下方是墨色的对话列表卡和半透明的对话卡；暗色主题下侧栏保持深色。
  - 明暗与强调色跟随控制台的本机偏好，另一个标签页修改后会同步。
  - 「执行位置」改用同一个自绘下拉框。
  - Desk 页面的 CSP 增加了 `font-src 'self'`，以加载 Outfit 字体。
- **命名变化。** 控制台导航里的 Desk 入口从「Reach Desk」改名为「对话」，`platform/tests/web.browser.test.ts` 里的两处链接名已同步。
- **验证。**
  - 类型检查（`bun run check`、`platform` 的两个 tsconfig）通过；`test:admin` 31/31；`platform` 单测 29 项通过，9 项需要 Playwright、本机跳过。
  - 用本地 Desk 组合服务（模型端为本地协议桩）在明暗两种主题下核对了：从控制台进入、顶栏导航、执行位置下拉框，以及在浏览器里临时插入的示例消息的样式。
- **未做。**
  - 真实对话流式输出没有跑（协议桩不支持流式）。
  - 部署到 RayWorkbench 未做，需要确认嵌入方式（同源反向代理挂载 `/reach/`，还是 iframe）。
  - 控制台与 Desk 仍是两个页面，切换时整页加载；合成单页应用需要把 Desk 逻辑并入控制台构建。

