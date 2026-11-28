# Reach 项目知识库

作者：Ray Zhang（Ray）。

这里保存不能仅靠代码或 Git 差异解释的耐久决定、限制和经验。

| 条目 | 内容 | 来源与状态 |
|---|---|---|
| [操作记录搜索聚焦、分页与 7 天滚动清理](product-decisions.md#operations-search-pagination-cleanup-20261128) | 修复 `.find` 聚焦竖线与窄屏折行、真服务端 `20/50` 分页、去小字备注右键删除、4 范围物理清理与默认 7 天自动滚动保留 | 2026-11-28 用户确认；124/124 单测通过，4bbc977 已同步并双端部署（Ray 733752、nmrkit 956058） |
| [侧栏右键与「⋯」菜单视口定位约束](product-decisions.md#desk-ctxmenu-viewport-20261127) | `.desk::before` 隔离 `backdrop-filter` 包含块、`.ctx-menu` 挂至 `body` 及 `desk-menu.ts` 视口翻转算法 | 2026-11-27 用户报错；120/120 单测与 18921 浏览器通过，40bd8a6 已同步并双端部署 |
| [Reach Desk 布局、悬浮气泡与多平台下载](product-decisions.md#desk-bubble-multidownload-20261127) | HandWave 布局与 Codex 队列、顶栏与窄屏断点、悬浮胶囊操作栏与状态精简，以及多平台下载 UI 与指令直出 | 2026-11-26/27 用户要求；Service 11/11、Admin 53/53、Platform 55/55 单测与浏览器核验通过 |
| [安装包通过阿里云 OSS 下载](product-decisions.md#installer-download-oss-20261127) | 安装包上传 OSS，下载页使用 OSS 地址的发布方向 | 2026-11-27 用户提出并要求记录；尚未实施、切换或验证 |
| [Codex 直接调用远端 Agent 验收](product-decisions.md#codex-remote-agent-test-20261127) | 后续远端 Agent 验收入口及 Ray Desk 线上证据 | 2026-11-27 用户决定。RyDev 远端实测和原始回执已核对；工具面板发送现象暂缓处理 |
| [Windows 必装 Agent、SSH 按需启用及 nmrkit 对话](product-decisions.md#worker-agent-desk-20261124) | Worker 与 Agent 独立上线，离线 OpenSSH 随包，启用现有 Reach Desk 与 PIN 会话 | 2026-11-24 用户决定。首装行为与 Desk 上线待实施和验收 |
| [Windows 双击安装后配置地址](product-decisions.md#windows-双击安装后配置地址2026-11-24) | 安装后弹窗、原启动身份及现有配置入口 | 2026-11-24 用户决定；隔离验证通过，RyDev 待重试 |
| [双端 Git 发布与独立 Web 管理](product-decisions.md#release-web-20261124) | Morrow 唯一维护位置、GitHub/Gitee、Git 自更新、Windows 服务恢复及独立控制台范围 | 2026-11-24 用户决定；镜像首同步、更新、身份及新入口待交付 |
| [产品决定及来源](product-decisions.md) | Reach 命名、作者、完全控制、Ray 统一登录、Reach Desk 归属，以及本地测试/部署暂缓 | 2026-11-01/02/03 用户会话；要求与运行验收分别记录 |
| [迁入 Morrow Agent](product-decisions.md#迁入-morrow-agent2026-11-13) | 当前父仓、业务用例边界和本次 Git 授权 | 2026-11-13 用户直接指定；源码迁移不等于功能验收 |
| [常驻与 Starferry 独立复验案例](../evidence/independent-validation-20261114.md) | 多网卡提名竞态、服务 SSH 身份、离线准备、outbox 退避、STUN 与健康路由修复，保留首次失败 | 2026-11-14；本地回归通过，SCM/公网 NAT 待验，真实安装工具策略阻断 |
| [先接入适配 Morrow 新 Agent 能力](product-decisions.md#先接入适配-morrow-新-agent-能力并按-tasksmd-执行2026-11-13) | 优先适配 Morrow 标准能力、建立 `docs/tasks.md` 执行单、授权本地 `CAS_API_KEY` 真实模型测试（服务器部署仍暂停） | 2026-11-13 用户直接指定；严禁凭据落盘 |
| [常驻服务与 Starferry 合并、QSpin 仅负责安装接线](product-decisions.md#常驻服务与-starferry-合并2026-11-13) | Starferry 归入 Reach、独立常驻、`ryreach` 配置、心跳与断网退避；QSpin 负责自己的安装接线 | 2026-11-13 用户决定。首装默认启用 SSH 的部分由 11 月 24 日决定更新 |

新增知识应说明来源、日期、适用范围和验证状态。用户明确修正可以直接记录为当前产品约束；推测、方案建议和一次任务结果不能自动晋升为稳定事实。

临时进度与交接放入需要时建立的 `docs/handoffs/`，测试输出放入需要时建立的 `docs/evidence/`。运行时 Agent 的任务上下文、技能和持久知识与本项目知识库分别设计。

返回[技术文档索引](../INDEX.md)。
