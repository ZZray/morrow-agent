# Ray 部署：统一前端、默认带云端对话（2026-11-25）

作者：Ray Zhang（Ray）。日期：2026-11-25。用户授权原话：「授权部署」。

## 范围

只更新 Ray 上的 Reach 应用（`reach.service`）。`ray-front`、Ray 登录密钥和工作台卡片未改动。

## 发行包

- 文件 `reach-20261125-unified.tar.gz`，SHA-256 `d0b1ab4b596eddf7b72c9ec9565fa869abc33b2f7a2bdbf68c46565a1a788516`，共 976 个以上文件，约 9MB。来源为 `E:/repos/morrow-agent` 的工作区（含未提交改动）。
- 结构：`morrow/apps/reach`（应用）、`morrow/crates/morrow-agent-jsonl/clients/node`（两个客户端模块）、`bin/morrow-agent-jsonl`。部署脚本另建 `service → morrow/apps/reach` 软链接，以保持仓库相对层级，systemd 单元不用改。
- 引用链：从 `src/service/main.ts`、`platform/src/host.ts` 递归收集，共 70 个本地文件；第三方依赖为 `zod`、`pngjs`。
- 对话运行组件 `morrow-agent-jsonl`：在本机 WSL（Ubuntu 24.04）用 `x86_64-unknown-linux-musl` 编译为静态程序（static-pie），SHA-256 `cd7c4da080cec4adf1ccf31228ac2d167ccd08d9b69a3e41ead48adc3a8cbfca`。服务器无 Rust，内存 1.9G，未在服务器上编译。

## 预演（正式服务不受影响）

在 `/root/reach-stage-20261125` 解压，用数据库副本在 `127.0.0.1:18919` 启动。

- **第一次预演：** 发现发行包缺 `src/controller/artifacts.ts`、`client.ts` 和 `pngjs`。服务照常启动，对话运行时按设计降级为「不可用」并给出原因。补齐后重新打包。
- **第二次预演：**
  - 健康检查 200，控制台 200，`/assets/desk.js` 200，旧 `/desk/` 308 跳到 `#/desk`；
  - `deskAvailable: true`，设备 1 台；
  - 数据库副本从第 1 版升级到第 11 版，操作 2 条、设备 1 台不变。
- **对话运行时创建：** 用占位模型配置（不连外部）启动，对话运行时在服务器上创建成功：`desk.sqlite` 已建，`/api/v1/desk/conversations` 返回 200。

## 正式切换

切换脚本 `deploy/update-unified.py` 的执行收据：

- `status: updated-ledger-preserved`
- 旧版本 `/opt/reach/releases/20261102-sso-stable-05d25e8c84eb` → 新版本 `/opt/reach/releases/20261125-unified-d0b1ab4b596e`
- 切换前后账本一致：users 1、nodes 1、operations 2、operation_events 10
- `/etc/reach/service.env` 新增 `REACH_DESK_SIDECAR=/opt/reach/current/bin/morrow-agent-jsonl`
- 备份：`/root/reach-unified-backup-20261125-095319`，含切换前的 `service.env`、`reach.sqlite`、`ray-auth.sqlite`（及 wal/shm）和收据

## 线上检查

- `reach`、`ray-front` 均为 active。日志只有 `reach_listening`，没有 `reach_desk_unavailable`，说明对话运行时已加载，模型未配置所以未运行。
- 公网 `https://bigrayzhang.cn/reach/healthz` 200。
- 未登录访问页面和资源时，303 跳到 `/ray/login?next=…`，统一认证生效。
- 无会话访问 `/reach/api/v1/auth/me` 返回 401。
- 原生 Bearer（无 Origin）请求经代理到达 Reach，用无效令牌时返回 401。

## 浏览器核对（用户本人登录 Ray 工作台后）

用户在内置浏览器面板里登录 Ray，由我核对，只读，未写任何生产配置。

- **进入。** 打开 `https://bigrayzhang.cn/reach/` 直接进入控制台，没有出现第二次登录。登录方式为 `ray`，账户 `ray`。
- **Ray 模式。** 不显示 PIN 输入框和默认 PIN 提醒；「账户与设备」里没有「登录 PIN」项。
- **页面。**
  - 导航依次为：设备、操作、对话、统计、下载、MCP 接入、设置。
  - 原有设备（11 月 2 日公网验证、已解绑）和 2 条「运行命令」操作都在。
- **对话页。** 进入后为一屏布局，显示「对话还没有启用：还没有启用云端对话模型……」并给出「去设置模型」入口（运行时已加载，模型未配置）。
- **设置页。** Reach Desk、现场 Agent 两张卡均为「未配置」，供应商为空，读接口正常。
- **网络请求。** 后台轮询（overview、device-events）均为 200。我导航页面时出现过一次 `/api/v1/overview` 401，随后 `auth/me` 等全部 200，未能复现，原因待查（疑似页面跳转时未完成的请求）。

## 第二次切换：模型能力声明与本机网关（2026-11-25 13:55）

用户要求：Reach 使用服务器本机的 OMP 网关；供应商目录缺上下文等信息时，用常规 AI 配置补上。

- **改动。**
  - Desk 也带模型能力：上下文、单次输出、图片。
  - 本机回环端点按设置声明能力（`host_declared_loopback`）。
  - 获取模型时采用供应商声明的能力（OMP `omp.*`、通用 `context_window`、CAS `input_modalities`），缺的项用默认值补上。
  - 新增 `REACH_MODEL_LOOPBACK=1`，允许生产环境使用本机回环端点。
- **本地验证。** 经本地转发器接入真实 CAS，对话请求的能力为 `host_declared_loopback`（上下文 1000000，输出 8192），流式完成。连接测试曾如实报出 CAS「servers are currently overloaded」，重试通过。
- **发行包。** 首次改由 `deploy/build-release.mjs` 按引用链生成：`reach-20261125-caps.tar.gz`，SHA-256 `9da1143147d85cbdf9a0d9ae67480d93d6ce42780a241df2073e0b40e29c51ea`，70 个源文件，依赖 `pngjs`、`zod`。运行组件不变（`cd7c4da0…bfca`）。
- **预演。** 健康检查、控制台、`desk.js` 正常；`deskAvailable: true`；本机网关地址 `http://127.0.0.1:18799/v1` 可作为供应商添加。
- **切换。**
  - 收据 `updated-ledger-preserved`；
  - 版本 `20261125-unified-d0b1ab4b596e` → `20261125-caps-9da1143147d8`；
  - 账本一致：1 / 1 / 2 / 10；
  - 备份目录 `/root/reach-unified-backup-20261125-135537`；
  - `service.env` 含 `REACH_DESK_SIDECAR` 与 `REACH_MODEL_LOOPBACK=1`；
  - 公网 healthz 200。

## 回退方法

1. 停止 `reach`；
2. 把 `/opt/reach/current` 指回旧版本；
3. 用备份目录里的 `service.env` 与数据库文件覆盖，并 `chown reach:reach`；
4. 启动 `reach`。

新版本已升级数据库结构，回退必须连同数据库一起恢复。

## 未完成

- 生产模型尚未在设置页配置，对话暂不可用。
- 未验证选定已配对设备的真实 Agent 任务回执。
