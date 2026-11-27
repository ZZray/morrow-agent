# Reach contributor rules

作者：Ray Zhang（Ray）。

先读 `docs/INDEX.md` 和 `docs/knowledge/INDEX.md`，再按任务读取相关文件。

本文件中的路径相对于 `apps/reach/`。Reach 自 2026-11-13 起迁入 `ZZray/morrow-agent`，作为 Morrow Agent 的远程协助子项目与实际业务用例，使用父仓 Git，不建立嵌套仓库。先读 [最新交接](docs/handoffs/2026-11-13-morrow-subproject.md)。ARA 原目录仅保留历史核对用途；不在旧项目继续维护，也不推进旧 Full 移植目标。

## 当前阶段与范围

- 用户已于 2026-11-02 授权按任务清单实现首版并部署到 Ray 工作台；Reach 独立运行并增加工作台入口，LabSlot 集成按最新要求延期。实施状态与证据见 docs/task-checklist.md。
- 用户于 2026-11-03 改为先本地开发和测试，服务器将关机备案；停止服务器访问、远端模型探测及部署，等待用户明确恢复。原首版范围保留，此阶段限制优先于先前部署授权。
- 用户于 2026-11-13 授权写交接、迁入 Morrow 并提交推送到 `https://github.com/ZZray/morrow-agent.git`。这覆盖本次 Git 操作的旧限制；服务器访问、模型探测、安装和部署仍未恢复。
- 用户于 2026-11-13 进一步明确：因编写 Reach 时 Morrow 尚未形成，先将 Reach 接入并适配 Morrow 新 Agent 能力，建立 `docs/tasks.md` 按计划执行，并授权在本地验证时从环境变量 `CAS_API_KEY` 读取测试凭据调用 CAS 模型入口；生产服务器访问与线上部署仍暂停，严禁任何密钥或私密配置落盘。
- 用户于 2026-11-14 要求检查当前实现、隔离测试，并授权 RyDev 及其他机器的安装测试；本轮服务器采用 `https://bigrayzhang.cn` 的 Reach 入口，Ray 工作台源码为 `E:/repos/RayWorkbench`。本轮允许该入口的验证，未授权修改/部署或重启生产服务；工具策略拒绝仍须保留并停止相应动作，不能绕过。具体证据见 `docs/evidence/independent-validation-20261114.md`。
- 用户随后明确要求“修复遇到的问题”，授权修复上述审查与测试缺陷及必要回归。RayWorkbench 的本地健康路由接线属于首配缺陷修复；生产部署与重启仍待授权。修复过程续写同一独立验证记录。
- 默认中文沟通。产品名 Reach，配置与控制命令名 `ryreach`（2026-11-13 用户更新；现有开发源码中的 `reach` 命令待按常驻合同对齐或决定兼容别名），命名空间 `RY`。
- 新建项目文件和文档在适用的作者字段署名 Ray Zhang，简写为 Ray；保留第三方作者和许可证声明，不用 AI 署名替代用户署名。
- 明确区分用户已确定的行为、设计建议、已实现能力和实际运行证据。文档完成不等于功能完成。
- Reach 基础包独立于 QSpin 和 LabSlot。自 2026-11-24 起 Reach 默认带云端对话（原 Reach Desk）：前端只有一套，对话是其中一个页面；服务默认组合对话运行时，缺少运行组件或模型时照常启动并如实报告。nmrkit 是用户指定的启用站点，部署到 RayWorkbench 时沿用工作台的同一套认证。见[统一前端决定](docs/knowledge/product-decisions.md#unified-frontend-20261124)。跨仓接入按用户已授权范围推进。

## 产品约束

- 用户明确要求完全控制。不要自行增加 Auto / Full Access 模式、默认只读范围、工具权限开关、角色权限分层或逐次操作审批。
- 登录认证和配对连接仍保留。不要把完全控制解释为取消控制端身份识别，或把配对重新扩展为一套工具授权中心。
- 安装目标为一次启动安装器后自动完成安装、注册服务、加入 PATH、启动服务并退出；避免额外的产品引导步骤。服务启动类型在后续安装设计中确定。
- Starferry 功能归入 Reach。后续默认 Windows 包必须安装 Reach Worker 与 Morrow Agent，并随包带离线 OpenSSH。SSH 按需启用，失败时保留 Worker 和 Agent 的安装、配对和上线能力。首次配置使用安装后地址弹窗或 `ryreach`，预配置地址直接复用；分钟级心跳可远程调整，无网按有上限退避重连。见 [11 月 24 日产品决定](docs/knowledge/product-decisions.md#worker-agent-desk-20261124)。
- QSpin 默认安装 Reach 和配置服务器地址归 QSpin 项目，本项目仅提供通用安装与预配置入口；不建设 QSpin 网关、IPC、产品托管子进程或进程内集成。
- Agent 可以不关联任何业务产品。产品接口是可选能力，不能成为通用连接的前置条件。
- 默认 Reach 由本地 Agent 主导源码分析，管理页面负责设备、连接、配对和运行记录。云端对话可直接对话并通过 Reach 调用设备；不维护第二套被控端、配对或操作账本。扩展合同见 docs/platform-extension.md。

## 技术与证据

- Agent 循环、Harness 和 MCP 复用父仓的 `morrow-agent-*` 包；Node/Desk 使用 `morrow-agent-jsonl`。Reach 保持独立 manifest/lockfile，不复制旧 ARA 运行时，不把 HTTP、设备、身份或业务验收放进 Core。
- 迁入时的旧 Reach WIP 使用过未被 Morrow 提取的 inspection/close/typed 图片恢复接口；逐项核对当前协议，缺失时如实失败。旧二进制哈希、旧 fence、旧安装包和旧证据不能自动变成 Morrow 的授权或通过证明。
- Computer Use 优先集成现有开源实现。nmrkit 的对话启用 Morrow 中现有 Reach Desk，HandWave 作为交互参考。既有来源记录、版本与许可证继续保留。
- 组件与技术选择见 docs/architecture.md；源码存在、编译通过和产品验收分别记录，不把占位目录当作已实现能力。
- 已执行、失败、取消和结果未知必须分别报告。网络重连不等于动作重放；取消不等于撤销已发生的效果。
- 验证应匹配本次改动。当前文档改动检查链接、状态、术语与范围；实现后再使用相应构建、合同和真实流程验证。

## 文档与 Git

- 自 2026-11-24 起，Reach 后续开发、文档、验证与发布的唯一维护目录为 `E:/repos/morrow-agent/apps/reach`。对 Reach 相关分支和发行标签已获授权的推送，在父仓提交一次，把同一提交和标签同步推送到 GitHub `origin` 与 Gitee `gitee`，分别核对远端 SHA。两端发行附件也需分别发布并核对字节摘要。见[双端 Git 发布与独立 Web 管理](docs/knowledge/product-decisions.md#release-web-20261124)。
- 用户原话和明确修正写入项目知识库，保留来源、日期、作用域与验证状态；实施计划和临时进度不当作耐久知识。
- 技术文档按 `docs/document-design.md` 分工，避免多份文件维护同一合同。
- 实质改写文档后使用 humanizer 做文字审读，保留事实、来源、术语及未验证状态。
- 非平凡设计或实现使用独立复核；主代理回查关键证据，并明确复核范围。
- 保留已有 WIP；未获用户指令不提交、推送、部署、安装或迁移其他仓库。
- 不提交凭据、客户原始数据、运行状态或本机配置。
