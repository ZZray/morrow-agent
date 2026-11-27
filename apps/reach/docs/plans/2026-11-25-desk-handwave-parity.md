# Reach Desk 补齐 HandWave 对话能力：差距与分期计划

作者：Ray Zhang（Ray）。日期：2026-11-25。状态：用户 2026-11-26 要求「列计划逐步完成」，按分期执行中。

## 来源

用户 2026-11-24 原话：「Reach项目，的助手那 handwave，调整主题符合当前reach主题，后面要部署到rayworkbench里面」「要集成到Reach，融入一体」。2026-11-25：「handwave的，技能，记忆等核心工具，这边reach似乎没有了，缺少很多功能。补上」「我记得是要你复刻那个功能，只是改改主题和接入」。

结论：目标是 **HandWave 对话体验在 Reach 里的复刻**，换 Reach 主题与 Reach 的登录、设备、模型接入；不是只做一个最小对话页。2026-11-24 的实现（`src/admin/desk.ts`，约 200 行）只接了 Morrow Desk Host 的基本对话，HandWave 的大部分对话功能没有迁过来。

## 现状证据

| 方面 | HandWave（`E:/repos/ara/apps/handwave`，线上 `/handwave/`） | Reach Desk（`apps/reach`） |
|---|---|---|
| 前端规模 | `web/app.js` 3940 行、`skills-ui.js` 647 行、`render.js` 150 行；Ray 入口另有续写建议、云端记忆、上下文链接适配（RayWorkbench `cmd/ray_front/next_suggestion.go`、`cloud_memory.go`、`context_links.go`） | `src/admin/desk.ts` 197 行、`desk-images.ts`、`desk-settlement.ts`、`artifacts.ts` |
| 后端 | HandWave Hub（Go）：工作区、会话、技能、知识库、上传、模型配置、Agent 运行与队列 | Morrow Desk Host（`platform/`）+ `morrow-agent-jsonl` 运行组件；Morrow 核心有技能库（`skill_library.rs`，Agent 工具 `skill_create/enable/install/read/remove`）、经验记忆（`experience.rs`）、上下文记忆（`context_memory.rs`），但 Reach 没有为它们提供 API 或界面 |

## 功能差距

| # | HandWave 功能 | Reach Desk 现状 | 补齐需要 |
|---|---|---|---|
| 1 | 输入框：`/` 技能菜单、已附技能条 | 无 | 前端 + 技能列表 API |
| 2 | 输入框：附件上传（文件、图片） | 只有图片展示 | 前端 + 上传 API（大小、类型边界） |
| 3 | 输入框：续写建议（灰字，Tab 采纳） | 无 | 前端 + 建议 API（调用当前 Desk 模型） |
| 4 | 输入框：模型选择（auto、协议） | 只在设置页选 | 前端；按对话覆盖需后端支持 |
| 5 | 澄清回复条（Agent 提问时快捷回答） | 无 | 前端 + 事件里的提问结构 |
| 6 | 忙时消息排队（队列、清空） | 忙时拒绝（`desk_conversation_busy`） | 前端队列或服务端队列 |
| 7 | 欢迎页：问候与推荐提示 | 无 | 前端 |
| 8 | 思考过程面板、工具调用日志 | 只有最终输出与操作记录 | 前端 + 事件流透出 `tool_start/tool_end/model_call` |
| 9 | 左栏：工作区树、会话列表、右键改名/删除 | 只有对话列表 | 前端 + 工作区/改名/删除 API |
| 10 | 右栏：知识库（全局 / 项目）、记忆 | 无 | 后端：记忆存储（接 Morrow 经验记忆或新建）、API、前端 |
| 11 | 右栏：工具开关、子 Agent 开关 | 无 | 后端配置项 + 前端 |
| 12 | 右栏：设备列表、项目文件树 | 只有执行位置下拉 | 前端 + 设备文件树 API（经 Reach 操作） |
| 13 | Agent 面板：任务清单、队列、子 Agent 名单、时间线、引导/跟进/中止/重试 | 只有停止 | 前端 + Desk Host 透出任务与子 Agent 事件 |
| 14 | 技能管理器：增删改、AI 生成技能 | 无 | 前端 + 技能 CRUD API（Morrow 技能库） |
| 15 | 账户菜单：主题、云端模型、技能管理、退出 | 主题/强调色在 Reach 头像菜单；模型在设置页 | 合并入口即可 |

## 分期

1. **对话体验（只改前端为主）**：#7 欢迎页、#8 思考与工具日志、#6 排队、#5 澄清条、#9 会话改名/删除、#4 输入框模型选择（只读当前模型 + 跳设置）。依赖：Desk Host 事件流已有 `tool_start/tool_end/model_call`，需确认透出到浏览器。
2. **技能**：#14 技能管理器 + #1 `/` 技能菜单。后端用 Morrow 技能库目录，新增 Reach API（列、读、建、改、删、启用）。
3. **记忆与知识库**：#10。需要先定：沿用 Morrow 经验/上下文记忆，还是迁 HandWave 知识库与 Ray 云端记忆的数据。
4. **附件与续写建议**：#2、#3。
5. **Agent 面板与设备工作区**：#13、#12、#11。

每期：迁移前逐项对照 HandWave 实际行为（线上 `/handwave/` 与源码），Reach 主题按 `docs` 与 RayWorkbench `docs/ui/README.md` 的令牌和控件，单测 + 浏览器明暗两套验收。

## 待用户决定

1. 先做哪一期（建议 1 → 2 → 3）。
2. 记忆与知识库：用 Morrow 现有记忆，还是把 HandWave 知识库与 Ray 云端记忆的数据迁过来。
3. HandWave 现有数据（工作区、会话、技能）是否需要导入 Reach。

## 进度

| 项 | 状态 | 证据 / 剩余 |
|---|---|---|
| 0 控制台操作后闪烁 | 完成（本地） | `admin.ts`：同页刷新改为离屏缓冲区画完再整体换上，旧内容不清空；按钮超过 150ms 显示进行中，并保持到新内容换上；刷新后焦点回到原按钮。本地 800ms 延迟下用 DOM 观察器核对：同页刷新 0 次空白/加载态，换页仍有加载态（预期）。`test:admin` 43/43。未部署。 |
| 1a 工具调用过程 | 完成（本地与真实模型端到端通过） | 服务端 `events.ts` 从 Morrow 运行事件提取 `tool_start`/`tool_end`（标题、参数、输出各截断 2000 字），写入对话事件流；读历史消息时合并为 `steps`。前端 `desk-steps.ts` 在回答上方显示「工具调用 · N 步」，进行中/完成/失败/效果未知四态，流式原地更新、保留展开状态。`platform/tests/events.test.ts` 4/4。2026-11-26 用真实模型 `deepseek-v4.1-flash` 接已配对节点「本机测试」实测通过（3 步工具调用及刷新保留）。 |
| 1a 思考面板 | 不做（上游限制） | Morrow 核心不落盘思考文本（`context_memory.rs`「never persist response or reasoning text」），需上游先提供才可显示。 |
| 1b 欢迎页 | 完成（本地端到端） | 按时段问候 +「在设备上执行 / 分析日志 / 排查故障 / 理清思路」推荐，点一下填进输入框并聚焦，不直接发送。 |
| 1b 忙时排队 | 完成（Codex / HandWave 队列已对齐，真实验收通过） | `desk-queue.ts` + `desk.ts`：回答进行中发送默认进入输入框上方紧凑队列卡，显示计数、状态提示与队首「立即发送」钮，每条带单条发送箭头（`→`）、编辑与删除；运行中点「立即发送」或 `→` 直接作为引导发给当前模型，空闲时直接发下一轮；最多 20 条，只存在本页内存。2026-11-26 真实浏览器 + `deepseek-v4.1-flash` 实测通过（`已采纳` 并输出约定标记）。 |
| 1b 输入框模型 | 完成（本地端到端） | 输入框旁显示当前运行的对话模型（`running.model`，没有时取 `enabled.model`）与「更改」入口（跳设置）；按对话切换模型未做（需服务端支持按对话覆盖）。 |
| 1c 对话改名与删除 | 完成（工作区树、置顶与右键菜单已补齐） | 服务端 `platform/src/store.ts` 与 `host.ts` 保留原表兼容（`PRAGMA user_version = 3`），新增独立表 `desk_workspaces` 与 `conversation_meta` 与 `GET/POST/PATCH/DELETE /api/v1/desk/workspaces`，并扩展 `PATCH /api/v1/desk/conversations/:id` 支持 `title`/`pinned`/`workspaceId`（置顶会话优先排序，删除工作区隐藏已结算会话且进行中/待核对返回 409）。前端 `desk.ts` / `desk.css` 对齐 HandWave 统一双栏侧边栏（`新建会话 Ctrl+N`、`新建工作区`、可折叠工作区文件夹+设备徽标、置顶/改名/删除视口限位右键菜单、顶栏侧栏折叠钮及窄屏抽屉、工作区↔设备/目录双向记忆）。`conversation-manage.test.ts` + `store.test.ts` 11/11 通过，真实浏览器明暗双主题验收通过。 |
| 2 技能 | 完成（本地端到端）；「AI 生成技能」未做 | 方案 B（用户决定前的实现口径）：Reach 自管技能库，语义与上限沿用 HandWave——用户写的 Markdown 指令，按条消息显式选择（≤8 个、合计 ≤128 KB），服务端把「用户为本条消息明确选择的技能」段落接到该任务目标后面；用户消息原文不变。存储 `platform/src/skills.ts`：每用户一目录、每技能一 JSON，写入先临时文件再改名；发送时快照存 `turn_skills` 表（不升 `user_version`），之后改技能不影响已发消息。接口 `GET/POST /api/v1/desk/skills`、`GET/PUT/DELETE /api/v1/desk/skills/:id`，沿用 CSRF。前端 `desk-skills.ts`：输入框「技能」按钮与「/」触发的选择器（搜索、勾选、已选 x/8）、已选技能条、技能管理对话框（增删改，删除两步确认），用户消息标注所用技能，排队消息保留排队时的技能。本地端到端：建技能 → 「/日志」选用 → 发送，假模型收到的请求含用户问题、技能标题与技能正文；刷新后消息仍标注技能；明暗两套截图。`platform/tests/skills.test.ts` 4/4，前端纯逻辑 3/3。 |
| 3 记忆按用户共享 | 完成（本地端到端） | 用户 2026-11-26 选「Share per user」，见[产品决定](../knowledge/product-decisions.md#desk-shared-memory-20261126)。`platform/src/environment.ts`：新对话用 `desk/users/<用户哈希>/environment`，旧对话保留独立目录，选择写入 `environment-path.txt` 后不变。本地核对：新对话写入共享路径、旧对话保留原路径。Agent 在共享环境里建的技能与知识从此跨对话可见。 |
| 3 记忆与知识库面板 | 完成（已补只读宿主工具，真实模型检索通过）；旧记忆迁入未做 | `platform/src/memory.ts` + `desk-memory.ts`：对话顶栏「记忆」打开面板，我的笔记可增删改，Agent 记下的知识与建的技能只读，忙时写笔记返回 409 `memory_busy`。为解决 Morrow 侧车 `enable_local_tools=false` 不注册 `knowledge_search` 的问题，在 `memory.ts` / `host.ts` / `settlement.ts` 接入只读宿主工具 `reach_memory_search` 与 `reach_memory_read`（含 SHA-256 证据落盘与幂等）。2026-11-26 真实模型 `deepseek-v4.1-flash` 在纯云端对话下实测调用两工具并准确检出「我的笔记」内容；`memory.test.ts`、`settlement.test.ts`、`device-tools.test.ts` 16/16 通过。 |
| 4 附件 | 完成（本地端到端）；图片交给模型未做 | `platform/src/attachments.ts` + `desk-attachments.ts`：「附件」按钮、粘贴图片、拖放到输入框；单个 ≤ 1 MB（沿用现有 2 MiB JSON 请求上限，未放宽），每条 ≤ 6 个；上传中禁止发送，过大在浏览器里先挡掉并说明。文本类（UTF-8）随消息接到任务目标后（合计 ≤ 96 KB），图片与其他文件只保存并在目标里如实说明。附件快照存 `turn_attachments`（不升 `user_version`）。读取接口按用户隔离，只有 PNG/JPEG/GIF/WebP 内联显示（SVG 等一律下载），带 `nosniff` 与 `default-src 'none'`，未登录 401。本地端到端：日志 + PNG 上传、超限拦截、发送后假模型请求含日志全文与图片说明、消息上图片可显示。**缺口：** Morrow 只在工具结果里传图片，把用户图片交给视觉模型需要 Reach 新增「读取附件」宿主工具并接入现有证据与结算校验，单独设计。 |
| 4 续写建议 | 完成（真实模型端到端通过） | `platform/src/suggestion.ts`：回答完成后用当前对话模型取最近三轮，生成「下一句最可能想发的话」（≤ 40 字，「无」或多行过长当作没有），12 秒超时，失败返回空。前端：输入框为空且无排队、无进行中时以灰字显示，Tab 采纳、Esc 关闭，输入即收起，60 秒过期，同一条回答只取一次。2026-11-26 真实模型 `deepseek-v4.1-flash` 实测通过：生成贴合上下文的单行建议，无明确下一步时返回 `null`，Tab 采纳不自动发送，清空后重现，Esc 关闭。 |
| 5 Agent 面板 | 完成（队列与引导交互已对齐，真实验收通过）；任务清单与子 Agent 名单未做 | `desk-agent.ts` + `desk.ts`：运行中展示紧凑计时与步骤计数，以及已发送引导回执列表（`已送达，等待采纳` / `已采纳` / `未采纳` / `无法确认`），不再在消息下重复堆放独立引导输入框；引导统一经输入框入队后点「立即发送」直发模型。回答结束后末条提供「重新回答」。**未做：** 任务清单（`GoalState`）与子 Agent 名单。 |
| 5 设备工作区目录树 | 完成（已迁入右侧「工具与连接」抽屉，真实验收通过） | `desk-files.ts` + `desk.ts`：按 HandWave 结构将远程主机（按机器 ID 在 `localStorage` 各自记忆目录）、内嵌设备目录树（`mountWorkspaceTree`，点文件插入相对路径）、记忆概览与实时「工具明细」整合进右侧可展开抽屉；顶栏状态胶囊与底栏目标胶囊均可直达抽屉，输入框上方不再常驻占位双空框，底部收拢为 `＋` 号菜单（附件/技能）、目标胶囊、模型胶囊与圆形发送钮。 |

## 2026-11-26 接手验收记录

本节记录 `apps/reach` 下 Reach Desk 阶段 0–5 的独立接手验收结果、仓库改动归属核对及用户现场复核反馈。本轮仅做验收、核对与记录，未修改源码，未执行 `git add`、`git commit`、`git push` 或部署。

### 一、改动归属与提交范围核对

父仓 `E:/repos/morrow-agent`（`main` 分支，HEAD `4f25826`）当前混有 `crates/morrow-agent-*`（27 个修改文件、4 个未跟踪文件）以及 `apps/reach` 下 2026-11-13 至 2026-11-25 13:55 的前序迁移与控制台 WIP（141 个旧未提交文件及 7 个已删旧 `platform/web/*`、`platform/src/web.ts`）。

对照交接文档第 2 节，Reach Desk 阶段 0–5 实际触达 33 个文件（修改时间集中于 `2026-11-25 20:02` 至 `2026-11-26 15:00`）：

1. **纯本线新增（21 个，归属明确）**：
   - 前端模块（7）：`src/admin/desk-agent.ts`、`desk-attachments.ts`、`desk-files.ts`、`desk-memory.ts`、`desk-queue.ts`、`desk-skills.ts`、`desk-steps.ts`。
   - 服务端模块（5）：`platform/src/attachments.ts`、`environment.ts`、`memory.ts`、`skills.ts`、`suggestion.ts`。
   - 测试文件（7）：`tests/desk-panels.test.ts`、`platform/tests/attachments.test.ts`、`conversation-manage.test.ts`、`environment.test.ts`、`memory.test.ts`、`skills.test.ts`、`suggestion.test.ts`。
   - 计划与交接文档（2）：`docs/plans/2026-11-25-desk-handwave-parity.md`、`docs/handoffs/2026-11-26-desk-handwave-parity.md`。
2. **纯本线修改（2 个，全部 hunk 归属本线）**：
   - `platform/src/events.ts`、`platform/tests/events.test.ts`。
3. **归属争议未跟踪文件（2 个，需与统一前端迁移线共同确认）**：
   - `src/admin/desk.ts`（325 行）与 `src/admin/desk.css`（299 行）：初版由 2026-11-24 统一前端迁移 WIP 创建，随后在本线阶段 1a–5 大量改写并接入 7 个 `desk-*.ts` 子模块。两文件在 HEAD 中不存在，无法脱离统一前端单独拆分提交。
4. **混入前序 WIP 的已跟踪文件（8 个，单独提交时需逐 hunk 拆分）**：
   - `src/admin/admin.ts`（混入 11-24 新控制台骨架与阶段 0 离屏缓冲 `pendingSwap` / 150ms 进行中态）。
   - `src/admin/admin.css`（混入 11-24 样式、`dialog` `@starting-style` 与阶段 0 `.btn.busy::after`）。
   - `src/service/admin.ts`（混入 11-24 新静态资源与本线 7 个 `desk-*.js` 映射）。
   - `tests/admin-http.test.ts`（混入 11-24 资源断言、`308` 跳转测试与本线 7 个 `desk-*.js` 断言）。
   - `package.json`（`test:admin` 混入 11-24/25 测试脚本与本线 `tests/desk-panels.test.ts`）。
   - `platform/src/host.ts`（混入 11-13/14 `provenance`/`guidance`/`continue` 与 11-24 模型切换逻辑 + 本线阶段 1–5 路由与校验）。
   - `platform/src/store.ts`（混入 11-13/14 `turn_task_meta`/`turn_continuations`/`turn_guidance` + 本线 `conversation_hidden`/`turn_skills`/`turn_attachments`）。
   - `docs/knowledge/product-decisions.md`（混入 11-13 至 11-24 多条产品决定 + 本线 `#desk-shared-memory-20261126`）。

**跨线依赖说明**：阶段 0–5 代码在导入和运行时依赖 2026-11-24 统一前端与多供应商模型设置等未提交文件（如 `tokens.css`、`controls.css`、`dropdown.ts`、`shell.ts`、`desk-settlement.ts`、`desk-images.ts`、`model-settings.ts`、`desk-runtime.ts`）以及 `crates/morrow-agent-*` 改动。如果只提交本线文件而不合入前序 WIP，独立检出无法编译。

### 二、回归测试、类型检查与构建（在 `apps/reach` 目录执行）

| 检查项 | 执行命令 | 实测结果 | 耗时 |
|---|---|---|---|
| TypeScript 主检查 | `.\node_modules\.bin\tsc.exe --noEmit` | 退出码 0（无报错） | — |
| 管理端类型检查 | `.\node_modules\.bin\tsc.exe --project tsconfig.admin.json --noEmit` | 退出码 0（无报错） | — |
| 管理端前端构建 | `.\node_modules\.bin\tsc.exe --project tsconfig.admin.json` | 退出码 0（无报错） | — |
| 管理端测试（12 文件） | `node --test --test-concurrency=1 tests/admin-http.test.ts tests/admin-model.test.ts tests/admin-artifacts.test.ts tests/admin-charts.test.ts tests/desk-panels.test.ts tests/device-events.test.ts tests/stats.test.ts tests/pin-login.test.ts tests/model-settings.test.ts tests/desk-runtime.test.ts tests/ray-login.test.ts tests/ray-desk.test.ts` | 49/49 通过，0 失败，0 跳过 | 9801.1ms |
| Platform 非集成测试（16 文件） | `node --test --test-concurrency=1 platform/tests/attachments.test.ts platform/tests/conversation-manage.test.ts platform/tests/default.test.ts platform/tests/device-tools.test.ts platform/tests/environment.test.ts platform/tests/events.test.ts platform/tests/image-preview.test.ts platform/tests/lifecycle.test.ts platform/tests/memory.test.ts platform/tests/session-capacity.test.ts platform/tests/settlement.test.ts platform/tests/settlement-view.test.ts platform/tests/shutdown.test.ts platform/tests/skills.test.ts platform/tests/store.test.ts platform/tests/suggestion.test.ts` | 50/50 通过，0 失败，0 跳过 | 9686.8ms |

### 三、真实浏览器与真实模型验收

真实模型测试通过仅驻留内存的本地环回转发代理（`127.0.0.1:18903`）接入 `https://cas.ciqtek.com/v1`，使用模型 `deepseek-v4.1-flash`，测试节点使用已配对的 `reach.exe`（「本机测试」）。验收后已切回 `fake-stream`、删除临时供应商与测试笔记并停掉代理与节点进程。

| 验收项 | 结果 | 实测观测与原因 | 证据目录（会话 evidence/） |
|---|---|---|---|
| 真实浏览器对话框关闭与不透明（记忆 / 技能管理 / 工作区） | 通过 | 明暗双主题（显式深色、显式浅色）均目视完全实底不透明，背景模糊遮罩正常；点击「关闭」或按 `Esc` 后 `dialog` 从 DOM 移除（由原生 `close` 事件监听执行 `dialog.remove()`），`locator('dialog').count()` 由 1 变为 0。（注：浏览器测试沙箱禁用 `page.evaluate`，未直接读取计算样式数值。） | `dialog-step_10_shot_1.png`、`dialog-step_14_shot_1.png`、`dialog-step_24_shot_1.png`、`dialog-step_28_shot_1.png` |
| 真实模型工具调用步骤 | 通过 | 对话 `41a3a182-cffa-4d3c-a12d-d47796f0038a` 调用 `本机测试` 执行 3 步（`directory.list` + 2 次 `file.read`），准确读出 `README.md`（`hi`）与 `src/lib/util.ts`（`y`）；界面展示「工具调用 · 3 步」与完成状态，刷新页面后历史步骤完整保留。 | `steps-step_48_shot_1.png`、`steps-final_step_54.png`、`real-model-steps.json` |
| 真实模型补充引导回执「已采纳」 | 通过 | 对话 `f73369bd-cd8b-446b-847b-050a599656d3` 运行中提交补充引导后先显示「已送达，等待采纳」，随后转为绿色「已采纳」，回答末尾按要求输出 `GUIDANCE-ACK-9527`，刷新后状态与正文均保留。 | `guidance-step_66_shot_1.png`、`guidance-final_step_68.png`、`real-model-guidance.json` |
| 真实模型续写建议质量 | 通过 | 首轮实测返回「继续列出 src 目录下的所有文件并读取内容。」及接口返回「好，继续看看 src 目录下还有哪些文件。」；无明确下一步时返回 `null`；列出文件清单后返回单行建议「那就按这个清单开始创建和修改文件吧。」（`placeholder` 带 `· Tab 采纳`）。按 `Tab` 填入输入框且不自动发送，清空后重现，按 `Esc` 关闭。 | `suggestion-step_105_shot_1.png`、`suggestion-step_107_shot_1.png`、`real-model-suggestion.json` |
| 真实模型检索「我的笔记」 | **失败** | 创建笔记「验收专用内部环境记录」后，共享环境 `library/knowledge/INDEX.md` 的 `reach-notes` 链接段写入正常，「Agent 记下的知识」面板无 `indexDamaged` 警告。但新对话 `ec7213f4-2959-4b00-9a4a-419634336ce2` 中，`deepseek-v4.1-flash` 仅收到 `reference_*`、`history_*`、`memory_propose`/`experience_search` 等工具，没有 `knowledge_search`/`knowledge_read`，回答明确报告缺少知识库检索工具而未返回笔记内容。核对源码确认 `crates/morrow-agent-jsonl/src/runtime.rs` 第 413 行硬编码 `request.enable_local_tools = false`，导致 `crates/morrow-agent-core/src/agent.rs` 第 2383 行不注册 `environment_tools`。 | `memory-step_134_shot_1_agent_memory_tab.png`、`memory-step_136_shot_1_steps_and_answer.png`、`real-model-memory.json`、`real-model-memory-index.txt` |

**零密钥核查**：清理完成后，对 `E:/repos/morrow-agent/apps/reach`（排除 `node_modules`、`target`）、本地运行数据目录 `scratchpad/reach-local` 与证据目录 `evidence/` 做全量原始字节扫描，`CAS_API_KEY` 命中数为 `0`。

### 四、2026-11-26 用户现场复核反馈与待对齐缺口

用户在本地控制台（`http://127.0.0.1:18921/`）查看后指出当前实现尚未完整复刻原 HandWave（`E:/repos/ara/apps/handwave`），界面与交互细节差距明显，后续需单独安排重对齐与修复：

1. **队列与发送交互（对照 Codex 样式及原 HandWave）**：发送消息默认进入排队区，队列卡片顶部显示数量与等待状态，右上提供全局「立即发送 / Send Now」，每条队列项自带单条「立即发送」箭头与编辑、删除按钮，点击可直接中断当前等待或发给模型，而不是只在忙时切换为「加入队列」并把补充引导拆成另一处输入框。
2. **输入区精简**：输入区底部整合 `+` 号菜单（附件 / 技能）等紧凑控件，去掉输入框上方占位的常驻选机/路径大控件。
3. **按机器区分显示目录与执行工具展示**：恢复原 HandWave 按设备/机器区分显示工作区目录树和工具明细的体验，提升整体视觉精致度。
4. **笔记检索缺陷**：解决 `morrow-agent-jsonl` 向 Desk 暴露只读知识检索工具（或合理受控的 `knowledge_search`/`knowledge_read`）的问题，使 Agent 能在不暴露通用本机命令/写文件工具的前提下检索「我的笔记」。

## 2026-11-26 HandWave 原版对齐与笔记检索修复记录

按用户 2026-11-26 要求（见[产品决定](../knowledge/product-decisions.md#desk-handwave-layout-20261126)），在仅改动 `apps/reach/`、不碰 `crates/` 与其他会话 WIP 的边界内完成对齐改造与只读记忆宿主工具修复；仍未执行 `git add`、`git commit`、`git push` 或部署。

### 一、改动清单（全部位于 `apps/reach/`）

- 服务端（3 个）：`platform/src/memory.ts`（`MemoryLibrary.search` + 只读宿主工具 `reach_memory_search`/`reach_memory_read` 及 `MemoryToolsHost`）、`platform/src/host.ts`、`platform/src/settlement.ts`。
- 测试（1 个）：`platform/tests/memory.test.ts`（新增检索与宿主工具幂等/路径边界单测）。
- 前端（7 个）：`src/admin/desk.ts`、`desk.css`、`desk-queue.ts`、`desk-files.ts`、`desk-agent.ts`、`desk-skills.ts`、`desk-attachments.ts`。
- 文档（2 个）：`docs/knowledge/product-decisions.md`、本文件。

### 二、回归、真实浏览器与真实模型复测

| 检查项 | 命令 / 条件 | 实测结果 | 证据 |
|---|---|---|---|
| TypeScript 检查与管理端构建 | `tsc --noEmit`、`tsc --project tsconfig.admin.json --noEmit`、`tsc --project tsconfig.admin.json` | 全部退出码 0 | — |
| 管理端测试（12 文件） | `node --test --test-concurrency=1 tests/admin-*.ts ...` | 49/49 通过（0 失败，9180.8ms） | — |
| Platform 非集成测试（16 文件） | `node --test --test-concurrency=1 platform/tests/...` | 51/51 通过（含新增记忆工具用例，0 失败，7469.9ms） | — |
| 极简输入区与明暗双主题布局 | 真实浏览器，`http://127.0.0.1:18921/#/desk` | 去掉输入区上方双空框与底部页脚；`＋` 号菜单（附件/选择技能/管理技能）、目标胶囊、模型胶囊、圆形发送钮在暗/亮两套主题下布局正常 | `handwave-realign-dark.png`、`handwave-realign-light.png`、`handwave-realign-plus-menu.png` |
| 右侧「工具与连接」抽屉 | 切换 `本机测试` ↔ `云端直接对话`，加载 `ws-demo` | 选中机器自动恢复各自记住的目录路径；内嵌目录树加载 `src` 与 `README.md`，点文件插入相对路径 `README.md` | `handwave-realign-drawer-tree.png` |
| Codex 风格队列与「立即发送」 | 对话 `5fdedcf0`，`deepseek-v4.1-flash` + `本机测试` | 运行中发送默认进入队列卡；点「立即发送」转为运行中引导并获绿色「已采纳」，回答末尾输出 `REALIGN-QUEUE-7741` | `handwave-realign-queue.png`、`handwave-realign-queue-applied.png`、`handwave-realign-queue.json` |
| Agent 检索「我的笔记」复测 | 对话 `cd5b47d1`，纯云端 `deepseek-v4.1-flash` | 依次调用 `reach_memory_search` 与 `reach_memory_read`（2 步完成），准确返回 `MORROW-NOTE-8314` 与 `24488` | `handwave-realign-memory-fixed.png`、`handwave-realign-memory.json` |

### 三、本地只读代码复审与环境清理

- **代码复审（`ocr-code-review` + `code-reviewer`）**：通过 `ocr delegate preview --format json` 与 `ocr delegate rule --format json` 确定上述 11 个代码与测试文件的审查规则，完成只读语义与回归检查。在已审查范围内未发现高置信度缺陷；记录 1 项低优先级使用边界：运行中通过队列「立即发送」触发 `guide()` 时只发送文本引导，若该条队列消息同时勾选了新的设备目标、技能或附件不会在当前运行中生效（需等待下一轮）。
- **清理与零密钥扫描**：本地 Reach（`18921`）已恢复为 `fake-stream`，临时供应商、测试笔记、CAS 代理与测试节点已清理停止；对 `apps/reach`、`scratchpad/reach-local` 与 `evidence/` 共 `47,106` 个文件执行原始字节扫描，`CAS_API_KEY` 命中数为 `0`。

## 2026-11-26 HandWave 左侧边栏补齐与验收记录

按用户「侧边栏不对吧，继续补齐」要求，在 `apps/reach/` 内补齐 HandWave 工作区树、会话置顶、侧栏折叠与统一双栏视觉：

- **改动文件（7 个，均在 `apps/reach/`）**：`platform/src/store.ts`、`platform/src/host.ts`、`platform/tests/conversation-manage.test.ts`、`src/admin/desk.ts`、`src/admin/desk.css`、`docs/knowledge/product-decisions.md`、本文件。
- **构建与测试**：`tsc --noEmit`、`tsc --project tsconfig.admin.json --noEmit`、`tsc --project tsconfig.admin.json` 全部退出码 `0`；管理端测试 12 文件 **49/49** 通过（9990.3ms）；Platform 非集成测试 16 文件 **53/53** 通过（含新增工作区 CRUD / 设备绑定 / 置顶与 `user_version=3` 兼容性单测，10485.0ms）。
- **真实浏览器明暗双主题验收**：验证 `http://127.0.0.1:18921/#/desk` 统一双栏外观与亮暗主题（`handwave-sidebar-dark.png`、`handwave-sidebar-light.png`）、新建「后端排查」工作区与工作区折叠（`handwave-sidebar-workspaces.png`）、视口限位右键/`⋯` 菜单与置顶/取消置顶（`handwave-sidebar-ctx-menu.png`、`handwave-sidebar-ctx-pin.png`）、桌面端侧栏收起展开（`handwave-sidebar-collapsed.png`）与移动端 `390x844` 浮层抽屉（`handwave-sidebar-mobile.png`），临时测试工作区与会话已删除恢复干净状态。
- **只读代码复审（`ocr-code-review` + `code-reviewer`）**：对本轮 5 个源码与测试文件完成只读复审，在已审查范围内未发现高置信度缺陷；`crates/` 无新增改动。

## 2026-11-26 HandWave 剩余可对齐能力补齐与验收记录

按用户「再核对还要补充什么，都请你补上」要求，在不改动 `crates/` 的边界内完成 6 项 HandWave 剩余可对齐能力（Markdown 与代码块/回答复制、输入区模型切换菜单、AI 创建技能草稿、PNG 视觉附件工具 `reach_attachment_image`、右抽屉「对话选项 + `+ 笔记`」、侧边栏筛选框）：

- **改动文件（13 个代码/测试 + 2 个文档，均在 `apps/reach/`）**：
  - 服务端（4 个）：`platform/src/attachments.ts`（`attachmentTools` / `reach_attachment_image` / `AttachmentToolsHost` 与 PNG/APNG 校验、原图核验与幂等收据）、`platform/src/skills.ts`（`parseSkillDraft` / `generateSkillDraft`）、`platform/src/host.ts`（`POST /api/v1/desk/skills/generate`、`options.memory`、接入 `AttachmentToolsHost`）、`platform/src/settlement.ts`（`profile()` 与 `reviewEffects()` 支持可选宿主工具组合）。
  - 前端与静态资源（5 个）：`src/admin/desk-markdown.ts`（新增，先转义 HTML 再格式化 Markdown 与代码块行号/复制）、`src/admin/desk-skills.ts`（`让 AI 创建技能` 区域与二次确认防误覆盖）、`src/admin/desk.ts`（`renderMarkdown`、`.copy-answer`、`.model-menu`、`.rail-search`、`对话选项` 开关与 `+ 笔记`）、`src/admin/desk.css`、`src/service/admin.ts`（注册 `/assets/desk-markdown.js`）。
  - 测试（4 个）：`platform/tests/attachments.test.ts`、`platform/tests/skills.test.ts`、`tests/admin-http.test.ts`、`tests/desk-panels.test.ts`。
  - 文档（2 个）：`docs/knowledge/product-decisions.md`、本文件。
- **构建与回归测试**：
  - `tsc --noEmit`、`tsc --project tsconfig.admin.json --noEmit`、`npm run build:admin` 全部退出码 `0`。
  - 管理端测试（12 文件）：**50/50** 通过（0 失败，0 跳过，9908.2ms）。
  - Platform 非集成测试（16 文件）：**55/55** 通过（0 失败，0 跳过，9104.8ms）。
- **真实浏览器验证（`http://127.0.0.1:18921/#/desk`，`/healthz` 返回 `{"service":"Reach","version":"0.1.0-dev.1","protocol":1}`）**：
  - 侧边栏 `.rail-search` 输入 `502` 由 13 条收敛为 2 条匹配会话，清空恢复 13 条。
  - 输入区 `.model-menu`（`handwave-parity-model-menu.png`）正常弹出搜索框、供应商分组、当前激活标记与「管理供应商与模型…」。
  - 右抽屉「对话选项（记忆检索 / 远程设备工具）」与「+ 笔记」在暗/亮双主题下清晰可读（`handwave-parity-drawer-opts-dark.png`、`handwave-parity-drawer-opts-light.png`），关闭「远程设备工具」时胶囊联动显示「云端（已暂停设备）」，重新开启后恢复。
  - 技能管理弹窗展示透明不遮挡的「让 AI 创建技能」输入区（`handwave-parity-skill-ai.png`）。
  - Markdown 输出（`.body.md` 表格、列表、行内代码、代码块复制）与底部「复制回答」切换为「已复制」验证通过（`handwave-parity-markdown-copy.png`），临时测试对话已删除恢复干净列表。
- **只读代码复审（`ocr-code-review` + `code-reviewer`）与边界**：
  - 使用 `ocr delegate preview --format json` 与 `ocr delegate rule --format json` 检查全部 13 个源码与测试文件，完成只读语义、XSS/输入校验、幂等收据与状态边界审查，未发现高/中置信度缺陷（低优先级说明：`.model-menu` 高亮仅按 `model.id` 匹配，未同时比对 `providerId`）；`crates/` 在本轮 `15:20` 后无任何文件改动。
  - 明确保留至上游运行时或专项迁移范围（本次按约定未改 `crates/`）：模型思考/推理面板、`GoalState` 任务清单与子 Agent 名单、交互式澄清条、以及旧 HandWave/Ray 记忆数据迁入（另见本文前序未包含项与 `product-decisions.md`）。

## 2026-11-27 顶栏与 Desk 窄屏/移动端兼容修复与验收

按用户截图反馈「变形了，注意移动端，窄屏兼容」完成响应式修复（均在 `apps/reach/src/admin/`）：

- **改动文件（4 个源码 + 文档）**：`src/admin/controls.css`、`src/admin/admin.css`、`src/admin/admin.ts`、`src/admin/desk.css`。
- **修复内容**：
  - 顶栏 `.top` 在 `<= 1080px` 切为双行，`.brand`、`.fresh`、`.btn.icon`、`.round` 均固定 `flex: none` 与 `white-space: nowrap`，杜绝中窄屏下「刚刚同步」换行与铃铛按钮被压扁成椭圆。
  - `.nav` 窄屏支持横向滚动且隐藏滚动条，`placeNavIndicator` 在溢出时调用 `scrollIntoView` 保持当前页签可见；`.popover` 与 `.model-menu` 改用视口相对限宽。
  - `desk.css` 补齐 `960px / 860px / 720px / 520px / 360px` 断点：`100dvh` 移动端满高、仅 `.drawer-toggle` 在 `<= 720px` 隐藏文字收为 `32×32` 圆钮（保留「记忆」按钮文字）、`<= 520px` 顶栏隐藏冗余连接胶囊并压缩输入区胶囊宽与弹窗内边距。
- **构建、测试与多视口浏览器验收**：
  - `tsc --noEmit`、`tsc --project tsconfig.admin.json --noEmit`、`npm run build:admin` 退出码 `0`；管理端测试 12 文件 **50/50** 通过（0 失败，0 跳过，9094.6ms）。
  - 真实浏览器（`http://127.0.0.1:18921/?v=202611270908#/desk`）核对 `900×800` 暗色（`responsive-900-dark.png`）、`1024×800` 亮色（`responsive-1024-light.png`）、`768×900` 暗色（`responsive-768-dark.png`）、`390×844` 手机端（对话页、`.model-menu`、`工具与连接`抽屉、设置页：`responsive-390-*.png`）与 `1280×860` 桌面恢复态（`responsive-1280-dark.png`）。所有断点零页面横向溢出、`.fresh` 保持单行、铃铛与 `+`/发送钮保持 1:1 正圆；在 `390px` 窄手机端 `.nav` 7 项横向可滚且首尾项紧贴胶囊边缘。
- **只读代码复审（`ocr-code-review` + `code-reviewer`）**：对 4 个修改文件通过 `ocr delegate rule --format json` 完成审查，0 高/中置信度缺陷，未修改 `crates/`。

<a id="desk-ray-live-20261127"></a>
## 2026-11-27 Ray 线上验收

发行版本 `20261127-a0d6bd039365`，生产模型 `deepseek-flash`。用户完成 Ray 登录后直达 Reach Desk。首轮回复、笔记搜索和读取、刷新后在原会话续聊均通过。服务器确认同一 Morrow Journal 中的 3 个 Run 均已完成并通过交付校验，5 次模型调用均收到结果。保留了专用对话和合成笔记。[验收对话](https://bigrayzhang.cn/reach/#/desk/dd2c96fc-d53c-417b-904f-8522122a2b98)

工具面板展开时，有一次点击「发送消息」后内容仍留在草稿。收起面板后，同一草稿提交成功。目前只观察到一次，原因尚未定位。用户确认暂缓处理。

本轮覆盖云端对话。后续使用 [Codex 调用入口](../knowledge/product-decisions.md#codex-remote-agent-test-20261127)完成 RyDev 远端 Agent 执行及原始回执核对，结果见[验收记录](../evidence/2026-11-24-rydev-service-update.md#rydev-019-preview-20261127)。

## 2026-11-27 对话气泡悬浮操作栏与多平台下载页设计与验收

按用户两项反馈（「这个样式要改改，对话气泡，改完我看看效果。有些操作按钮可以悬浮的时候显示」与「同时设计，这里应该是多平台的，注意好好设计下载页面」）完成设计与验收（均在 `apps/reach/`）：

- **改动文件（9 个，未动 `crates/`，未提交）**：
  - 对话气泡与悬浮操作：`src/admin/desk-agent.ts`、`src/admin/desk.ts`、`src/admin/desk.css`。
  - 多平台下载页与测试：`src/service/releases.ts`、`src/admin/model.ts`、`src/admin/admin.ts`、`src/admin/admin.css`、`tests/admin-model.test.ts`、`tests/device-events.test.ts`。
- **实现要点**：
  - **对话气泡与单行悬浮操作栏**：用户消息改为右对齐柔和描边气泡（隐藏冗余「你」文字、`.sr-only` 保留可读、悬浮显示「复制」）；助手正文以圆角卡片包覆（`:empty` 隐藏），保留 `.message-status` 文案「回答已保存」并与「复制回答 / 重新回答 / 查询原记录」合入 `.message-foot` 同一水平行；桌面端（`hover: hover` + `> 720px`）闲置隐藏操作按钮，于消息悬浮/聚焦/复制锁定时淡入，运行中、异常态及 `<= 720px` / 触屏常显。
  - **多平台下载页（Windows / macOS / Linux）**：`releases.ts` 兼容可选 `os`、`format` 与 `universal` 架构并保留 macOS / Linux 便携 Worker 规则；页面顶部按本机系统预选并提供三平台切换与架构筛选，单包以 `s5 ink` 主推荐卡 + `s7` 详情卡并排消除留白，多包采用 `s5 + s7` 快速指南配多列详情卡，无包平台如实说明状态并提供源码编译与 MCP 入口；附系统原生哈希校验命令（`Get-FileHash` / `shasum -a 256` / `sha256sum`）及可按平台切换的历史版本列表。
- **构建、测试与真实浏览器验收**：
  - `tsc --noEmit`、`tsc --project tsconfig.admin.json --noEmit`、`npm run build:admin` 全部退出码 `0`；管理端 12 个测试文件 **52/52** 通过（0 失败，0 跳过，10857.1ms）。
  - 真实浏览器在 `18921` 核验气泡暗/亮主题闲置与悬停态（`复制回答` 与 `重新回答` 严格同行 `y=644.47`、`sameRow: true`）、`390×844` 手机端及未配置多平台下载页（`bubble-idle-dark.png`、`bubble-hover-dark.png`、`bubble-hover-light.png`、`bubble-mobile-390.png`、`downloads-unconfigured-macos.png`）；在临时 `18929` 隔离服务核验多平台 `releases.json`（Windows/macOS/Linux 切换、ARM64 筛选、历史切换、亮色主题稳态胶囊对比、`390×844` 三栏单行选项卡：`downloads-multi-{win-dark,win-light,mac-dark,linux-dark,mobile-390}.png`），临时服务已停用。
  - 已知现象记录：在包含超长无空格设备路径的历史会话中，`.transcript` 在 `390px` 视口底部仍有一条横向滚动条（`.message-target` 未强制全断行）。
- **只读代码复审**：通过 `ocr delegate rule --format json` 核对全部 9 个文件，0 高/中置信度缺陷，无虚构发行包与无秘密凭据泄露。

<a id="downloads-concrete-commands-20261127"></a>
## 2026-11-27 下载页具体服务地址与安装后执行指令直出

按用户反馈（「下载页面要优化的另一个是, 安装完成后要执行什么指令，填写什么地址都要写上，步骤清晰，而不是根据xxx。ok？」）完成跟进优化，并顺带修复 `390px` 移动端「待发布」标签换行：

- **改动文件（4 个核心文件 + 文档，未动 `crates/`，未提交）**：`src/admin/model.ts`、`src/admin/admin.ts`、`src/admin/admin.css`、`tests/admin-model.test.ts`（CLI 参数核对自 `src/node/main.rs` 实码：`config set server-url`、`pair`、`status`、`run`、`ssh enable`）。
- **实现要点**：
  - 在 `model.ts` 抽离并单测覆盖 `isDevelopmentServer`、`configServerCommand`、带可定制命令前缀的 `pairCommand` 及 `archiveExtractCommand`。
  - 下载页所有流程块（Hero、多包接入卡、单包「怎么装」、未发布空态源码编译指引）直接展示实时 `M.serverBase(location.href)` 服务地址及逐条可一键复制命令框 `.dl-cmd`（带绿色 `.copied` 即时反馈），消除「填写本服务地址/按说明操作」等模糊描述。
  - 修复 `@media (max-width: 640px)` `.dl-os-tabs`：改为 `flex: 1 0 auto` + `white-space: nowrap` 避免 `待发布` 状态在 `Windows / macOS` tab 中竖向折字；`.dl-hero` 增加 `grid-template-columns: minmax(0, 1fr)` 确保长网址与命令在 `390px` 窄屏正常换行、零溢出。
- **构建、测试与真实浏览器验收**：
  - 末次修改后通过 `tsc --noEmit`、`tsc --project tsconfig.admin.json --noEmit`、`npm run build:admin` 与 12 份管理端测试 **53/53** 通过（0 失败，0 跳过，9563.5ms；另有 `tests/portable-worker.test.ts` 需设置 `REACH_NODE_BINARY` 才能独立运行）。
  - 真实浏览器先后在临时隔离 `18929`（Windows 双包、macOS 亮色单包与一键复制 `.copied` 状态；测试后已停止清理）及本地 `18921`（暗色 `1280×860` 未配置态、亮色 `390×844` 顶部 `Windows 待发布 / macOS 待发布 / Linux 待发布` 单行等高及滚动后 6 个 `.dl-cmd` 命令框无溢出）完成验收，并恢复 `18921/#/desk` 暗色 `1280×860` 登录态。
- **待处理**：`crates/` 未改动；待用户明确提交范围与推送目标分支/远端后再执行 Git 提交推送。

<a id="desk-hover-toolbar-20261127"></a>
## 2026-11-27 对话消息悬浮胶囊小工具栏与隐藏「回答已保存」

按用户反馈（「这个俩操作，包括复制等操作。建议悬浮的时候增加小工具栏，参考页面风格。而不是直接显示到页面上，回答已保存也不用显示，除非保存失败。可以吗？」）完成二次打磨（`apps/reach/src/admin/desk.ts`、`apps/reach/src/admin/desk.css`）：

- **实现要点**：
  - 将消息操作按钮（用户「复制」；助手「复制回答 / 重新回答 / 查询原记录」）收拢为贴合 Reach `.nav` / `.popover` 风格的半透明圆角胶囊工具栏（`.message-actions`），抽取 `bindMessageCopyButton` 去重且点击仅高亮当前复制钮（`.is-copied`）。
  - 桌面端（`hover: hover` + `> 720px`）闲置时零高隐藏；悬停或聚焦气泡时在卡片右下角沿下缘无缝浮现（用户消息通过 `.user-bubble-wrap` 及 `margin-top: 20px` 为下方技能/目标元数据保留 `+10px` 盒模型净空）。
  - 正常完成且无观测丢失的回答（`completed`）通过 `.is-settled`（`1×1px clip` 零高隐身）在界面上完全隐藏「回答已保存」；运行中、停止（`已停止`）及失败/未确认态继续在 `.message-foot` 左侧可见提示并与操作胶囊同排常驻；`<= 720px` / 触屏保持右对齐内联胶囊。
- **构建、测试、浏览器验收与边界**：
  - 末次 CSS 修改后 `tsc --noEmit`、`tsc --project tsconfig.admin.json --noEmit`、`npm run build:admin` 与 12 份管理端单测 **53/53** 通过（0 失败，0 跳过）。
  - 真实浏览器在 `18921` 核验闲置零噪声（`hover-toolbar-idle-dark.png`）、助手明暗双主题悬浮与复制高亮（`hover-toolbar-assistant-{dark,light}.png`）、用户带技能气泡悬浮净空 `+10px`（`hover-toolbar-user-dark.png`）、停止回答 `已停止` 内联显现（`hover-toolbar-alert-status.png`）与 `390×844` 窄屏表现（`hover-toolbar-mobile-390.png`），0 控制台报错且已清理临时测试会话还原干净工作区。
  - **边界记录**：`ocr delegate preview/rule` 与 `code-reviewer` 只读复审 0 高/中缺陷；因当前环境未安装 Node Playwright 包（`REACH_PLAYWRIGHT_ENTRY` 未设），尚未实跑 `platform/tests/web.browser.test.ts` 验证其对 `.is-settled`（`clip: rect(0,0,0,0)`）定位器可见性的实际兼容性（注：浏览器沙箱 `webview_browser` 对 `.is-settled` 报告不可见）。

<a id="deploy-receipt-20261127"></a>
## 2026-11-27 提交推送与 Ray / nmrkit 上线回执

- **源码提交与远端同步**：多平台下载页面设计与安装指令、Desk 对话气泡悬浮胶囊工具栏及隐藏常态「回答已保存」已限定范围提交至 `main`（提交 `f26e9ae84526797226d5ab0fd27337c1bba5e60a`，12 个文件 +806/-95 行；提交前跑完 `tsc`、管理端 53/53、服务端 11/11、平台 55/55 共 119/119 用例与 OCR/只读复审），并同步推送至 `origin/main` 与 `gitee/main`；同仓未纳入本次交付的便携版 Worker WIP 与 `E:\repos\RayWorkbench` 均未改动。
- **打包产物**：`reach-20261127-f26e9ae-ui.tar.gz`（973 文件，9,284,981 字节，SHA-256 `c539b622ba362b74e9e27db465827a55e928f682bd826ed6c8d94c3c571e1949`；Linux 侧车 `morrow-agent-jsonl` SHA-256 `b46a6406d1986d0a6c91df3c5b666d1bf3afdd83fab1214e8b00413160f868e6`）。
- **上线站点与核验**：Ray（PID `523163`，备份 `/root/reach-deploy-backup-20261127-224459`）与 nmrkit（PID `3086684`，备份 `/root/reach-deploy-backup-20261127-224743`）均已切换至 `/opt/reach/releases/20261127-f26e9ae-ui-c539b622`，站点 `deploy/{ray,nmrkit}-releases.json`、`/etc/reach/service.env` 及 SQLite 账本完整保留；两站 `reach`、`ray-front`、`nginx` 活跃，模型启用与本地监听日志正常，且回环/公网获取的 `admin.js`、`desk.js`、`admin.css`、`desk.css` 均返回 HTTP `200` 并与发布包 SHA-256 一致。明细见 [2026-11-24-nmrkit-web-pin.md](../evidence/2026-11-24-nmrkit-web-pin.md)。
- **未覆盖边界**：生产站未通过 SSO / PIN 登录执行真实浏览器点击验收，需已登录用户打开两站控制台确认页面渲染与交互。





