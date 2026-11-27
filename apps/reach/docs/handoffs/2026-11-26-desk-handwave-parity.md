# 交接：Reach Desk 复刻 HandWave（阶段 0–5）与 Ray 门户遗留

- 日期：2026-11-26
- 状态：本地完成、未提交、未部署
- 关联：[对齐计划与逐项进度](../plans/2026-11-25-desk-handwave-parity.md)、[产品决定：记忆按用户共享](../knowledge/product-decisions.md#desk-shared-memory-20261126)

## 1. 现在是什么状态

Reach Desk 按 HandWave 功能逐项补齐，阶段 0–5 均在本地用真实 `morrow-agent-jsonl` 运行组件 + 流式假模型跑通（阶段 5 的目录树另用真实 `reach` 节点）。逐项证据见对齐计划「进度」表，这里只列结论：

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 控制台同页刷新不闪烁（离屏缓冲 + 按钮进行中态） | 完成 |
| 1a | 工具调用步骤 | 完成；真实模型的工具调用端到端待验 |
| 1b | 欢迎页、忙时排队、输入框显示模型 | 完成；按对话切换模型未做 |
| 1c | 对话改名 / 删除（隐藏，记录保留） | 完成 |
| 2 | 技能（`/` 选择、技能管理） | 完成；「AI 生成技能」未做 |
| 3 | 记忆按用户共享 + 记忆与知识库面板 | 完成；HandWave/Ray 旧记忆数据迁入未做 |
| 4 | 附件、续写建议 | 完成；图片交给视觉模型未做 |
| 5 | Agent 面板（运行时长、补充引导、重新回答）、设备工作区目录树 | 完成；任务清单、子 Agent 名单未做 |

验证（2026-11-26 最后一次）：管理端测试 49/49（`test:admin` 那组文件）、platform 非集成测试 50/50、`tsc --noEmit` 与 `tsconfig.admin.json` 构建通过。

## 2. 改动范围（未提交）

工作区与其他会话的 Reach 迁移 WIP 混在一起（例如 `platform/src/web.ts`、`platform/web/*` 的删除不是本线做的）。**提交时只 `git add` 下列本线文件，并逐个核对 hunk**：

- 前端新文件：`src/admin/desk-{agent,attachments,files,memory,queue,skills,steps}.ts`；本线也大量改了 `src/admin/desk.ts`、`src/admin/desk.css`（这两个文件本身是迁移 WIP 的新文件，需和迁移那条线一起确认归属）。
- 前端改动：`src/admin/admin.ts`、`src/admin/admin.css`（阶段 0 防闪烁）、`src/service/admin.ts`（静态资源白名单）。
- 服务端新文件：`platform/src/{skills,environment,memory,attachments,suggestion}.ts`。
- 服务端改动：`platform/src/{host,store,events}.ts`（路由、新表、步骤事件、引导事件带正文、`present()` 附 steps/skills/attachments/guidance）。新表全部 `CREATE TABLE IF NOT EXISTS`，不升 `user_version`。
- 测试：`tests/desk-panels.test.ts`、`tests/admin-http.test.ts`、`platform/tests/{events,conversation-manage,skills,environment,memory,attachments,suggestion}.test.ts`；`package.json` 的 `test:admin` 已加入 `desk-panels.test.ts`。
- 文档：`docs/plans/2026-11-25-desk-handwave-parity.md`、`docs/knowledge/product-decisions.md`、本文件。

## 3. 后续任务（按建议顺序）

1. **提交本线改动**（需用户明说才提交）：中文 commit message、无 AI 署名，按第 2 节逐文件核对后限定路径提交；`desk.ts`/`desk.css` 先和 Reach 迁移那条线确认归属。
2. **部署前验收**（需用户授权部署）：在真实浏览器（非预览面板）复核对话框关闭与不透明；用真实模型验证工具步骤、引导「已采纳」、续写建议质量、Agent 检索「我的笔记」。
3. **图片附件交给视觉模型**：Morrow 只在工具结果里传图片。方案是新增 Reach 宿主工具「读取附件」，接入现有证据与结算校验；需单独设计后再做。
4. **任务清单 / 子 Agent 名单**：任务清单依赖 Morrow 目标模式（`GoalState`，≤ 8 步），Reach 目前不启动目标模式，是否启用是产品决定；子 Agent 名单需 Desk Host 先透出委托事件。
5. **小缺口**：按对话切换模型（服务端按对话覆盖）、「AI 生成技能」、HandWave 工作区分组（左栏）、工具开关 / 子 Agent 开关（右栏，对齐表第 11 项）、澄清回复条（第 5 项，需事件里的提问结构）。
6. **旧记忆迁入**：HandWave / Ray 云端记忆迁入用户共享环境，需先盘点源数据格式。

## 4. Ray 门户与网关的遗留（RayWorkbench，`E:/repos/RayWorkbench`）

- 已上线未提交：门户去掉 HandWave 卡片、「Ray AI Gateway」卡片文案与布局、RainFlow 链接按请求域名生成（解决 IP 与域名 Cookie 不一致导致的重复登录）。未提交文件：`cmd/ray_front/pages/portal.html`、`cmd/ray_front/portal_rainflow_test.go`、`docs/provenance/deploy-20261125b-ray-front-source-manifest.txt`，以及 `cmd/ray_front/main.go` 中 `rainflowURL` 的改动（该文件还混有其他会话的改动，提交前逐 hunk 核对）。
- 网关改名 S2–S5（服务名、路径、配置键等对外名称）：计划在 `docs/plans/2026-11-25-ray-ai-gateway-rename.md`，每一步都需用户授权，尤其涉及服务器的部分。
- 读取服务器 `gateway.yaml` 时只按字段白名单输出，不得打印 key、token、secret。

## 5. 工作目录

### 5.1 代码仓库（持久）

| 目录 | 内容 | 状态 |
|---|---|---|
| `E:/repos/morrow-agent` | Morrow 主仓（分支 `main`） | 本线改动在 `apps/reach` 下，未提交，与其他会话 WIP 混在一起 |
| `E:/repos/morrow-agent/apps/reach` | Reach：Desk 前端 `src/admin/`、服务 `src/service/`、Desk Host `platform/`、节点 `src/node/` | 本线主要工作目录；文件清单见第 2 节 |
| `E:/repos/RayWorkbench` | Ray AI Gateway（`cmd/ray_gateway`、`internal/`）、门户 `cmd/ray_front`、UI Kit `internal/webkit`、UI 方案 `docs/ui/README.md`、改名计划 `docs/plans/2026-11-25-ray-ai-gateway-rename.md`、部署记录 `docs/provenance/` | 已提交并推送到 `cffc018`；门户遗留见第 4 节 |
| `E:/repos/ara` | 网关原仓 | 网关代码已删除并推送（`110a81e`），无遗留 |

### 5.2 构建产物（持久）

| 路径 | 内容 |
|---|---|
| `D:/workspace/env/cache/rust-target/release/morrow-agent-jsonl.exe` | Desk 运行组件（sidecar），本地 Reach 用它 |
| `D:/workspace/env/cache/rust-target/release/reach.exe` | Reach 节点，2026-11-26 用 `cargo build --release --bin reach` 构建（约 3.5 分钟） |
| `E:/repos/morrow-agent/apps/reach/dist/admin/` | 前端构建输出：`./node_modules/.bin/tsc.exe --project tsconfig.admin.json` |

### 5.3 测试工具（已转存，持久）

会话临时目录随时可能被清理，可复用的脚本已复制到共享笔记目录：
`C:/Users/loveu/AppData/Local/Claude-Data/claude_pzs8sxrjxfjjc/side-session-notes/local_8c1b4089-1ec4-4fd8-8229-0e537a9571fa/desk-handoff-tools/`

| 文件 | 用途 |
|---|---|
| `fake_stream_upstream.py` | OpenAI 兼容假模型，支持慢速流式输出，模型名 `fake-stream`。用法 `python fake_stream_upstream.py 18902`，会在当前目录写 `last_request.json`（用来核对技能、附件是否进了请求） |
| `fake_upstream.py` | 非流式假上游，网关本地验收用 |
| `load.py` | 网关本地负载（只含本地测试 token，打 `127.0.0.1:18910`），用来生成统计图表数据 |

### 5.4 会话临时目录（会被清理，丢了就重建）

根目录：`C:/Users/loveu/AppData/Local/Temp/claude/e894dcdda504b055/bf5d47d3-dac0-4b4b-8ca2-9f14dd78dc17/scratchpad/`

| 子目录 | 内容 | 丢失后怎么办 |
|---|---|---|
| `reach-local/` | 本地 Reach 数据（SQLite、Desk 会话与证据、技能、附件，约 27 MB，全是测试数据） | 新建空目录重新启动即可，首次需在页面上建用户 / 设 PIN、在设置页把模型指向假模型 |
| `reach-node/` | 测试节点「本机测试」的配对状态 | 重新取配对码再 `pair` |
| `ws-demo/` | 目录树测试用的示例目录（`README.md`、`src/main.ts`、`src/lib/util.ts`） | 随手重建 |
| `gwtest/` | 网关本地验收：`ray_gateway.exe`、测试 `gateway.yaml`、`totp.secret` 及日志 | 测试配置含本地 TOTP 种子，不要外传；需要时按 RayWorkbench 文档重建 |
| `rayfront/`、`gw-s1/`、`live/` | 门户与网关部署前的本地构建与核对副本 | 以 RayWorkbench 仓库与 `docs/provenance/` 记录为准，可丢弃 |
| `edit_*.py` | 各阶段一次性改代码脚本 | 改动已在仓库里，可丢弃 |

### 5.5 启动本地环境

```powershell
python <desk-handoff-tools>/fake_stream_upstream.py 18902
```

```bash
cd E:/repos/morrow-agent/apps/reach
REACH_DESK_SIDECAR='D:/workspace/env/cache/rust-target/release/morrow-agent-jsonl.exe' REACH_DATA_DIR='<数据目录>' REACH_PORT=18921 REACH_DEVELOPMENT=1 REACH_MODEL_LOOPBACK=1 node src/service/main.ts
```

测试节点：控制台「设备」页或 `POST /api/v1/pairing-codes` 取配对码（约 10 分钟过期），然后

```bash
reach.exe --state-dir <节点目录> pair --server http://127.0.0.1:18921 --code <配对码> --name 本机测试 --development
reach.exe --state-dir <节点目录> run
```

当前进程：本地 Reach 仍在 `127.0.0.1:18921` 运行，假模型在 `18902`；测试节点已停止。

### 5.6 注意

- 前端改动后浏览器需 `fetch(url,{cache:'reload'})` 刷新缓存再重载。
- 应用内预览面板不出帧（`requestAnimationFrame` 不触发）：截图里对话框显得半透明、`<dialog>` 的 `close` 事件不触发，以计算样式为准，真实浏览器需复核。
- `platform/tests/store.test.ts` 依赖相对路径，测试要在 `apps/reach` 目录下跑。
