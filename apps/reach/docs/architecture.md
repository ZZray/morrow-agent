# Reach 首版架构

作者：Ray Zhang（Ray）。命名空间：RY。
日期：2026-11-02。状态：实施设计；各能力的实际验收仍以任务清单为准。

用户在当前会话要求按 52 项任务清单实现一个版本，并部署到 Ray 工作台服务器。本设计据此推进，产品目标沿用 product-scope.md。

## 组成

| 组件 | 实现选择 | 职责与部署 |
|---|---|---|
| service | TypeScript、Node.js 24、node:sqlite | 一个组织服务进程；账户、配对、设备连接、操作投递、事件索引、产品配置和管理 API |
| node | 独立 Rust workspace，命令 reach | Windows 系统服务、现场工具、实际操作账本、持久结果上传；远端 Agent 经原 Lite/Harness 调用 |
| controller | TypeScript CLI/MCP 适配；发行时打包所需运行时 | 开发机登录、目标选择、工具调用、状态及证据读取；对本地 Codex 提供 MCP Server |
| admin | 浏览器管理页面，由 Reach 服务提供 | 设备、配对、连接和运行记录；独立部署支持自身登录，Ray 部署复用平台浏览器登录，LabSlot 集成延期 |
| desktop helper | 交互用户会话中的开源 MCP 后端及受控接线 | 读取真实桌面、截图、键鼠或控件操作；不在 Windows Session 0 中假定用户桌面可用 |

四个源码目录是职责边界。现场用户只需安装发行包，不要求自行安装 Node、Rust 或 Python。现场 pair/status/unpair 命令由 Rust reach.exe 提供；开发机控制器发行命令须避免覆盖现场命令。

用户新增的 Reach Desk 云端对话作为独立选装组件，不改变以上基础安装。扩展拥有聊天界面、消息历史和云端 Host，复用 Reach 身份、设备查询、操作及委托合同。基础发行无聊天依赖；Ray 可装配扩展。源码位于 platform/；最终接线与运行方式仍在实施，实际实现和迁移条件见[云端平台扩展设计](platform-extension.md)。

## 调用关系

本地 Codex → controller MCP → Reach service → Node → 系统/桌面/产品工具。

远端委托沿同一条连接到达 Node，由 Node 组装 Lite Harness Host。模型入口和凭据由组织管理，Core 不拥有 Reach 账户或设备表。直接工具调用不经过模型。

选装后的另一路入口为：浏览器对话 → Reach Desk 云端 Host → 原 Lite/Harness。纯对话不要求设备；设备工具或远端子任务通过 Reach service 到指定 Node，沿用同一操作账本和证据查询。云端 Host 与 Node Host 复用循环实现，各自拥有明确的 Session/Run，不复制循环或让两个 Host 同时推进同一 Run。

Node 主动发起 HTTPS 请求，首个实现使用一秒短轮询，后续可改为有界长轮询；两种方式沿用同一收据合同。操作执行、取消查询、结果上传分别推进，长命令不能阻塞取消。领取响应丢失后仅查询原操作，不能领取同一操作作为新工作。

## 数据归属

| 数据 | 权威持有者 |
|---|---|
| 用户、会话、安装绑定、配对 epoch | Reach service |
| 控制端请求、投递状态、管理页事件索引 | Reach service |
| 已接收输入、执行前记录、文件/进程实际结果、结果 outbox | Node 本地持久账本 |
| 原生 Agent Session、Run 及 Harness 证据 | Lite/Harness；路径与业务映射由 Reach Node Host 管理 |
| 现场截图、输出文件、日志片段 | Node 产物及内容哈希；服务保存索引和已上传副本 |
| 产品业务数据、机器资产主数据 | 来源产品；Reach 保存来源 ID、版本和必要快照 |

服务数据库采用 WAL、synchronous=FULL。配对消费、领取和事件落账使用不跨 await 的事务，提交后应答。业务操作 ID、Node ID、配对 epoch 和规范输入哈希共同绑定一次执行。Node 必须先持久入场、再执行，单实例执行锁防止两个进程重复入场。

数据库初始化与升级需要检查 schema 版本；后续版本以显式迁移推进，不将未知新版本改回旧版本。备份需使用 SQLite 一致性备份，不能在进程运行时只复制主文件而漏掉 WAL。

## Windows 进程与状态

安装身份和账本统一放在受保护的 ProgramData/RY/Reach。服务账户拥有写权限；安装时确定的绑定用户通过经过认证的本机 IPC 调用 pair/status，解绑流程继续按配对合同实现，不各建一套 AppData 身份。安装器负责 ACL，并测试普通本机用户不能直接读安装凭据。

桌面助手绑定明确的 Windows session。退出登录、锁屏、UAC 安全桌面和会话替换均作为实际能力状态反馈；正在执行的未知操作不能换到另一个用户会话重做。

已实现的生产候选按绑定 SID 选择唯一 WTSActive 会话，绑定 Session ID、用户 SID、AuthenticationId 与 logon SID。暂停创建 helper，先纳入 Job 再恢复；外部认证管道由 supervisor 持有，worker 的 PID 只用于结果记录。helper 通过 SCM 状态/账户/PID 识别服务，Node 通过持有的创建进程句柄验证 helper；服务运行中再次检查 WTS 的原 logon 身份。可写 spool 与安装账本分离。普通用户管道链路已有实测，生产 SCM/WTS 权限及会话切换仍待实际安装验证，见[管道候选](evidence/desktop-pipe-20261102.md)。

服务启动选择为 Windows 自动延迟启动；桌面助手在用户登录时按会话启动。这是本次实现选择，需 I06/V03 实测后才能声称支持。

## 部署

2026-11-02 已部署：Reach 使用 Node v24.20.0、独立 systemd 单元及环回端口 18910，持久数据和配置独立保存。ray-front 在现有 443 下提供 `/reach/`，并增加工作台卡片；原 8443 入口已停用。

工作台源码固定于旧 Go 仓库 `llm-im.git` 的 `0b9cb7c`，与当前 Morrow Agent 父仓独立维护。浏览器先由 Ray 验证平台会话，再通过专用密钥签名换取绑定该会话的 Reach Cookie；每次浏览器 API 访问均复核绑定。原生控制器和 Node 保留独立认证。来源、同源信任边界与会话合同见[系统集成](integrations.md)，发布和恢复见[部署说明](deployment-ray.md)。

## 当前实现边界

TypeScript 服务、独立 Rust 前台 Node、CLI/MCP 控制器已实现首批工具链路。真实进程测试覆盖命令、文件、取消、重启和原回执恢复；管理页已有真实浏览器记录。另有 Linux 控制器经公网 443 调用 Windows Node 的文件效果、运行中事件、重复请求与原回执查询证据。Ray 登录后直接进入及多标签写请求已在部署版本验证。Windows 服务入口与本机 IPC 已实现，普通 host 验证另记证据；正式 SCM/SYSTEM、安装包、完整证据能力、真实桌面、模型委托和实际 Codex MCP 加载仍未验收。安装与更新边界见[安装合同](installation-update.md)。
