# Reach Web 正式部署与 PIN 验收

作者 Ray Zhang（Ray）。2026-11-24（Asia/Taipei）。

用户随后确认正式站使用 `2026`。现行版本和实测见文末。

正式入口为 [nmrkit.ciqtek.com/reach/](https://nmrkit.ciqtek.com/reach/)。GitHub 和 Gitee 的 `codex/reach-web` 均指向 `1e19868262abcdde8fc02ead618c92b9a4054773`。生产 `/opt/reach/current` 指向同一版本，systemd 进程 3776656 使用 Reach 独立的 Node 24.22.3。服务为 active，开机启动已启用。

| 证据 | 结果 |
| --- | --- |
| 发布包 SHA-256 | `f9033e320791a3103dee4b6f63f212351951c8979741c2c763edceaac124f63f` |
| 正式 `admin.js` SHA-256 | `84985c648b064d29e786609df36a272fd92cc8d80c1713c2739792cd001f6770` |
| 代码验证 | 从发布提交构建，TypeScript 检查、Web 26 项和服务 11 项通过。修订 PIN 找回提示后，Web 26 项重跑通过。 |
| 公网验证 | `/reach` 跳转到 `/reach/`，8 项网页资源完整回下载后与发布包 SHA-256 相同。匿名 API 返回 401，旧密码和 Ray 登录返回 404。 |
| PIN 与 API | 私有 PIN 在移除引导环境变量并重启后可用，Cookie 设置 `Path=/reach/`、`Secure`、`HttpOnly` 和 `SameSite=Strict`。验证设备概览、设备列表、通知、统计、发行接口、CSRF 拒绝、注销后会话失效和 MCP 设备列表。 |
| 浏览器 | 正式页面显示一个 PIN 输入框，包含三次失败锁一小时的提示与找回入口说明。 |
| 共用主机 | NMR 平台根路径保持 307，SSH 隧道健康入口保持 200。Reach 使用自己的服务账户、数据目录和登录会话。 |

首次 Nginx reload 后，检查请求仍落到旧入口，发布脚本恢复了原配置。重新切换时等到 `/reach/healthz` 返回与回环后端一致的正文，再核对旧入口状态。随后通过版本目录指针切换 PIN 找回提示修订，使用同一个 Reach 数据库。

生产库验收时有 0 台设备和 0 条操作。正式服务接收新设备、实际执行操作、发行清单与双源安装包更新另行验收。RyDev 既有配对和回执属于原测试实例。

[公网复核](../../outputs/web-pin-nmrkit/public-verification.json) · [服务发布收据](../../outputs/web-pin-nmrkit/final-deployment.txt) · [PIN 页面截图](../../outputs/web-pin-nmrkit/online-pin-login.jpg)

## 正式 PIN 修订

用户确认正式站只用 `2026` 后，GitHub、Gitee 的 `codex/reach-web` 与 Linux 正式服务同步到 `e3a4250e05cfdfc38f42fac3f16341787c9b9b33`。服务在同一个数据库上重置一次 PIN，移除一次性重置变量后正常重启。数据库失败计数为 0，锁定时间为空。公网用 `2026` 登录和注销均返回 200，旧密码登录返回 404。发布快照通过类型检查和 27 项 Web 测试。

[服务收据](../../outputs/web-pin-2026/deployment.txt) · [公网复核](../../outputs/web-pin-2026/public-verification.json)

## 2026-11-27 升级到统一 Reach

用户指定 `https://nmrkit.ciqtek.com/reach/` 后，将站点从 `ebd997134a7029d7f57ebee72ac34c7f3c8230d8` 升级到 `20261127-da3909f-nmrkit-c38fd34b`。发行归档 SHA-256 为 `c38fd34b2bb93cff6aec355ef52d8fc7865a8cae9989f79662db85db78a10897`，解包后的 973 个文件逐项核对。运行中的 Morrow 侧车 SHA-256 为 `b46a6406d1986d0a6c91df3c5b666d1bf3afdd83fab1214e8b00413160f868e6`。原站点发行清单以 SHA-256 `b7563217df6ed579d4115916ce1b6c0f61b9984546ba77441e0937dd0e723b6b` 保留在新发行目录。

升级前使用原数据库的隔离副本验证旧版到新版及回退。测试用 PIN、既有 Cookie 和 Controller Bearer 在版本切换后可用，下载清单内容一致。正式切换前备份数据库及环境文件，前后账户、设备、操作和事件计数均为 1、0、0、0。备份位于服务器 `/root/reach-nmrkit-backup-2ry2uf72`。

正式服务使用独立 Node 24.22.3，Reach 和 Nginx 均正常。公网控制台、健康检查、静态资源、既有下载清单和 SSH 隧道健康检查返回预期状态，匿名设备 API 返回 401。原浏览器 PIN 会话在刷新后仍可进入统计页，下载页当时显示 0.1.3 安装包。对话入口已显示，当时站点尚未配置云端对话模型；模型与下载更新结果见下节。

<a id="nmrkit-model-download-20261127"></a>
## 2026-11-27 更新模型与下载清单

按用户选择，nmrkit 的 Desk 和 Agent 使用与 Ray 相同的 `deepseek-flash` 模型。两项配置分别通过真实流式连接测试并启用；服务重启后均确认运行。浏览器使用既有 PIN 会话进入对话，首轮会话 `2e3f2a63-1fb9-48de-ac74-80be9da5cd84` 的回合 `7b52907e-5669-4192-9af1-44101d0c5e9c` 已完成，回复与指定标记一致。原任务的两次模型调用均收到响应，进程正常退出。该站点尚无配对设备；笔记检索和续聊未在该站验证。

nmrkit 与 Ray 均切换到发行目录 `20261127-87af0a7-download-0ca9c51c`。发行归档 SHA-256 为 `0ca9c51cbd48abbe1a93904efbeea6b859ae377158313d7f536563e7b9cf3885`，每站 973 个文件逐项核对。两站发行清单最新项为 `0.1.9-preview`，页面脚本支持 Worker + Agent 包。Ray 的已登录 Controller 实际读取到该清单；nmrkit 的运行代码和公网 `admin.js` 已核对，切换后的浏览器页面尚未复验。公网完整下载 `Reach-Setup-0.1.9-preview-41fc956066c8dff4.exe`，24,837,120 字节，SHA-256 为 `41fc956066c8dff4b385649ecf9e8c00ac716afe11b9cac54e074be9c2f4cea5`。

切换前后，nmrkit 保留 1 个对话、1 个回合和 6 条事件；Ray 保留 2 台设备、4 个操作及 37 条操作事件，Desk 保留 1 个对话和 3 个回合。两站模型及账户/PIN 指纹未变化。该安装器是未做 Windows 代码签名的手动安装预览版；完整 Worker + Agent 的自动更新尚未实现。GitHub/Gitee 预览标签已同步；核对时 GitHub 尚无该标签的 Release，Gitee 公开发行列表为空，发行附件尚未核验。

## 2026-11-27 晚间更新：悬浮胶囊工具栏与多平台下载指令（f26e9ae）

`origin/main` 与 `gitee/main` 已推送并核对为提交 `f26e9ae84526797226d5ab0fd27337c1bba5e60a`（范围限定为下载页多平台设计及安装指令、Desk 对话气泡悬浮胶囊工具栏与隐藏已保存状态，以及对应单元测试和知识库条目，共 12 个文件；同仓另一会话未暂存的便携版 Worker 改动保持原样）。提交前 `tsc --noEmit`、`tsc --project tsconfig.admin.json --noEmit`、`npm run build:admin`、管理端 12 份测试（53/53）、服务端测试（11/11）及平台单元测试（55/55）全部通过，共 119/119 通过；`platform/tests/web.browser.test.ts` 因本机未安装 Playwright（未设置 `REACH_PLAYWRIGHT_ENTRY`）未运行。

发行包基于该提交构建，合入从 `ray-dev` 提取的静态 Linux 侧车 `morrow-agent-jsonl`（SHA-256 为 `b46a6406d1986d0a6c91df3c5b666d1bf3afdd83fab1214e8b00413160f868e6`），发行归档 `reach-20261127-f26e9ae-ui.tar.gz` 共 973 个文件、9,284,981 字节，SHA-256 为 `c539b622ba362b74e9e27db465827a55e928f682bd826ed6c8d94c3c571e1949`；构建产物前端资源 SHA-256 为：

- `admin.js`: `415effe014f93ab8c84167afff5df6fafb8378b20e3fd96781db07d4c9f09627`
- `desk.js`: `935a41f88908edd6bf71b2f46768edddbc16f802d3f6e55acfcc79580137b934b`
- `admin.css`: `fa765392a898e3f885b1a72d5d4ff7bcffb1b8119e8327c0e3e4123e32c68c36`
- `desk.css`: `95ecae2834092d15477b0a07b6493ae6ad3280b786e0bf48cf08ac5bde6ddd8c`

两站均由 `/opt/reach/releases/20261127-87af0a7-download-0ca9c51c` 切换至 `/opt/reach/releases/20261127-f26e9ae-ui-c539b622`，保留现有 `/etc/reach/service.env` 与站点专属发行清单（`ray-releases.json` 与 `nmrkit-releases.json` 迁移后 SHA-256 均为 `72be31701b3249fc0793d17e070138542c8d871a639af941db2f74a21b696052`），临时切换文件均已清理：

- **Ray（`ray-dev`，`118.25.103.226`）**：状态 `updated-ledger-preserved`，`reach` 主进程 PID `523163`，备份目录 `/root/reach-deploy-backup-20261127-224459`。`reach` 与 `ray-front` 服务运行正常，`journalctl -u reach` 记录 `reach_model_enabled`（`agent` 与 `desk` 使用 `deepseek-flash`）及 `reach_listening` `127.0.0.1:18910`。账本保持为 1 位用户、2 台设备、4 个操作、37 条操作事件与 Desk 1 个对话、3 个回合、14 条事件。本机回环 `http://127.0.0.1:18910/assets/{admin.js,desk.js,admin.css,desk.css}` 返回 HTTP `200` 且 SHA-256 与发布包逐一吻合；公网 `https://bigrayzhang.cn/reach/healthz` 返回 `200`（`{"service":"Reach","version":"0.1.0-dev.1","protocol":1}`），`https://bigrayzhang.cn/reach/` 返回 `303` 跳转至 `https://bigrayzhang.cn/ray/login?next=%2Freach%2F`（登录页 `200`），未登录请求 `/reach/api/v1/auth/me` 与 `/reach/api/v1/releases` 返回 `401`。
- **nmrkit（`labslot-prod-root`，`101.37.76.80:31565`）**：状态 `updated-ledger-preserved`，`reach` 主进程 PID `3086684`，备份目录 `/root/reach-deploy-backup-20261127-224743`，`/etc/reach/service.env` 保持 `REACH_PIN_ONLY=1` 与 `REACH_PUBLIC_ORIGIN=https://nmrkit.ciqtek.com` 未变。`reach` 与 `nginx` 服务运行正常，`journalctl -u reach` 记录 `reach_model_enabled`（`agent` 与 `desk` 使用 `deepseek-flash`）及 `reach_listening` `127.0.0.1:18910`。账本保持为 1 位用户、1 台设备、17 个操作、375 条操作事件与 Desk 1 个对话、1 个回合、6 条事件。公网 HTTPS 下载 `https://nmrkit.ciqtek.com/reach/assets/{admin.js,desk.js,admin.css,desk.css}` 均返回 `200` 且 SHA-256 与发布包逐一吻合；`https://nmrkit.ciqtek.com/reach/healthz` 返回 `200`，`/reach/` 返回 `200`，主站 `/` 返回 `307`，未登录请求 `/reach/api/v1/auth/me` 与 `/reach/api/v1/releases` 返回 `401`。

上线后，两站在未登录态下的服务进程、静态资源哈希与鉴权入口已确认就绪；登录态浏览器（Ray SSO 与 nmrkit PIN）中的 Desk 悬浮工具栏及下载页交互未在生产站模拟账号测试，需由已登录用户实机页面确认。

## 2026-11-27 晚间更新：侧栏右键与「⋯」菜单视口包含块修复（40bd8a6）

`origin/main` 与 `gitee/main` 已推送并核对为提交 `40bd8a607103528fe553a12c738a007d746e15f6`（范围限定为 `.desk::before` 隔离 `backdrop-filter`、`.ctx-menu` 挂至 `document.body`、`desk-menu.ts` 视口翻转与键盘锚点、`/assets/desk-menu.js` 注册及对应单测与知识库条目，共 8 个文件；同仓另一会话未暂存 WIP 保留未动）。提交前 `tsc --noEmit`、`tsconfig.admin.json`、`npm run build:admin`、管理端 12 份测试（54/54）、服务端测试（11/11）及平台单元测试（55/55）全部通过，共 120/120 通过；本地 `127.0.0.1:18921` 无头 Chromium 核验工作区右键零偏差、底边上翻、`⋯` 按钮亮色、`.desk-aside` 视口边距与 `390×844` 窄屏表现。

发行包合入同一静态 Linux 侧车 `morrow-agent-jsonl`（SHA-256 `b46a6406d1986d0a6c91df3c5b666d1bf3afdd83fab1214e8b00413160f868e6`），打包 `reach-20261127-40bd8a6-ctx.tar.gz` 共 975 个文件、9,246,780 字节，SHA-256 为 `5d93f4c0f3be27283a1ba258debd8849ebf85c03479c878ceabbdb5f21e9c899`；静态资源 SHA-256 为：

- `admin.js`: `415effe014f93ab8c84167afff5df6fafb8378b20e3fd96781db07d4c9f09627`
- `desk.js`: `68c82d25fb4906a1d2e45d625449ed7fd8372fbb033924ba00ab80b864a1cbdd`
- `desk-menu.js`: `9f017f733fbd449e51d8eea5835c4b77fb2d907419d395a8377d35f21c32c724`
- `admin.css`: `fa765392a898e3f885b1a72d5d4ff7bcffb1b8119e8327c0e3e4123e32c68c36`
- `desk.css`: `720851c7d34d660be7a918d553f2301c30957e99e4cdf148f1a3603befc72cf5`

两站均由 `/opt/reach/releases/20261127-f26e9ae-ui-c539b622` 切换至 `/opt/reach/releases/20261127-40bd8a6-ctx-5d93f4c0`，保留 `/etc/reach/service.env` 与站点专属发行清单（`ray-releases.json` 与 `nmrkit-releases.json` SHA-256 均为 `72be31701b3249fc0793d17e070138542c8d871a639af941db2f74a21b696052`），临时部署文件已清理：

- **Ray（`ray-dev`，`118.25.103.226`）**：状态 `updated-ledger-preserved`，`reach` PID `531052`，备份 `/root/reach-deploy-backup-20261127-231930`。`reach` 与 `ray-front` 运行正常，`journalctl -u reach` 记录 `reach_model_enabled`（`agent` 与 `desk` 使用 `deepseek-flash`）及 `127.0.0.1:18910` 监听。账本保留 1 位用户、2 台设备、4 个操作、37 条操作事件及 Desk 1 个对话、3 个回合、14 条事件。本机回环 `/assets/{admin.js,desk.js,desk-menu.js,admin.css,desk.css}` 均返回 HTTP `200` 且 SHA-256 与发布包一致；公网 `https://bigrayzhang.cn/reach/healthz` 返回 `200`，`/reach/` 返回 `303` 跳转至 `/ray/login?next=%2Freach%2F`（`/ray/login` `200`），匿名 `/reach/api/v1/auth/me` 与 `/reach/api/v1/releases` 返回 `401`。
- **nmrkit（`labslot-prod-root`，`101.37.76.80:31565`）**：状态 `updated-ledger-preserved`，`reach` PID `3121422`，备份 `/root/reach-deploy-backup-20261127-232005`，`/etc/reach/service.env` 保持 `REACH_PIN_ONLY=1` 与 `REACH_PUBLIC_ORIGIN=https://nmrkit.ciqtek.com` 未变。`reach` 与 `nginx` 运行正常，`journalctl -u reach` 记录 `reach_model_enabled`（`agent` 与 `desk` 使用 `deepseek-flash`）及 `127.0.0.1:18910` 监听。账本保留 1 位用户、1 台设备、17 个操作、375 条操作事件及 Desk 1 个对话、1 个回合、6 条事件。公网 HTTPS 下载 `https://nmrkit.ciqtek.com/reach/assets/{admin.js,desk.js,desk-menu.js,admin.css,desk.css}` 均返回 `200` 且 SHA-256 与发布包一致；`/reach/healthz` 与 `/reach/` 返回 `200`，主站 `/` 返回 `307`，匿名 `/reach/api/v1/auth/me` 与 `/reach/api/v1/releases` 返回 `401`。

两站在登录态（Ray SSO / nmrkit PIN）浏览器中的右键菜单、抽屉与界面交互需由已登录用户实机刷新核对。

## 2026-11-28 更新：操作页搜索竖线、分页、清理与 7 天滚动保留（4bbc977）

`origin/main` 与 `gitee/main` 已推送并核对为提交 `4bbc9771ebacbd297308c9b548fe48270d05611c`（范围限定为 `.find` 焦点竖线修复与 `390px` 表头/筛选胶囊不折行、服务端 `GET /api/v1/operations` 分页检索与 `20/50 条/页`、去掉右键 `.ctx-note` 小字备注的单删与 4 范围批量物理清理、`ReachStore.pruneExpiredOperations(7)` 启动与每小时 `unref` 定时器 7 天滚动保留、对应测试及知识库条目，共 11 个文件；同仓另一会话 Starferry/便携包 WIP 保留未动）。提交前 `tsc --noEmit`、`tsconfig.admin.json`、`npm run build:admin`、服务端 `14/14`（含 7 天启动剪除与滚动定时器）、管理端 `55/55`、平台单元测试 `55/55` 共 `124/124` 全部通过；本地 `18931` 隔离无头 Chromium 验证亮/暗主题、分页、清理预览、统计联动与 `390×844` 移动端排版。

发行包基于该提交构建，合入同一静态 Linux 侧车 `morrow-agent-jsonl`（SHA-256 `b46a6406d1986d0a6c91df3c5b666d1bf3afdd83fab1214e8b00413160f868e6`），打包 `reach-20261128-4bbc977-ops.tar.gz` 共 1,028 个文件、9,301,438 字节，SHA-256 为 `64a5114cd44d7a7cd1258c28c005b55223e71c3fa9da664f8780b0e31205330e`；前端静态资源 SHA-256 为：

- `admin.js`: `1d2717288a57f6c5cca7c8007261d82be1157ee42c508dc94377bad280a11715`
- `model.js`: `82c5c692b83aef1325c9e6843968675f24eb8dd37b21d8e8385c9ff79da0f8ec`
- `desk.js`: `68c82d25fb4906a1d2e45d625449ed7fd8372fbb033924ba00ab80b864a1cbdd`
- `desk-menu.js`: `9f017f733fbd449e51d8eea5835c4b77fb2d907419d395a8377d35f21c32c724`
- `admin.css`: `5ad9c48e3429836ea269f28eaa4a3c03e1cee0df50e40fed78b21b3c169f7849`
- `desk.css`: `fc54a3789c73cefa4838f77fa95b501553f5146011dd7bf22786e487d0a9cb62`

两站均由 `/opt/reach/releases/20261127-40bd8a6-ctx-5d93f4c0` 切换至 `/opt/reach/releases/20261128-4bbc977-ops-64a5114c`，保留 `/etc/reach/service.env` 与站点专属清单（`ray-releases.json` 与 `nmrkit-releases.json` 均保持 `72be31701b3249fc0793d17e070138542c8d871a639af941db2f74a21b696052`），临时安装包均已清理：

- **Ray（`ray-dev`，`118.25.103.226`）**：状态 `updated-ledger-preserved`，`reach` PID `733752`，备份 `/root/reach-deploy-backup-20261128-141843`。`reach` 与 `ray-front` 运行正常，`journalctl -u reach` 记录 `reach_operations_pruned`（`retentionDays: 7, deleted: 2, skippedProtected: 0`）与 `127.0.0.1:18910` 监听；操作账本按预期由 9 条/56 事件滚动剪除超期记录后保留 7 条/46 事件，用户（1）、设备（2）与 Desk（1 对话 / 3 回合 / 14 事件）不变。回环 6 项前端资源均返回 `200` 且 SHA-256 与发布包一致；公网 `https://bigrayzhang.cn/reach/healthz` 返回 `200`，`/reach/` 返回 `303` 至 `/ray/login?next=%2Freach%2F`（`200`），匿名 `/reach/api/v1/auth/me` 与 `/reach/api/v1/releases` 返回 `401`。
- **nmrkit（`labslot-prod-root`，`101.37.76.80:31565`）**：状态 `updated-ledger-preserved`，`reach` PID `956058`，备份 `/root/reach-deploy-backup-20261128-141958`，`/etc/reach/service.env` 保持 `REACH_PIN_ONLY=1` 与 `REACH_PUBLIC_ORIGIN=https://nmrkit.ciqtek.com` 未变。`reach` 与 `nginx` 运行正常，账本保持 1 位用户、1 台设备、17 个操作、375 条事件（0 条超 7 天）及 Desk 1 对话/1 回合/6 事件。公网 HTTPS `/reach/assets/{admin.js,model.js,desk.js,desk-menu.js,admin.css,desk.css}` 均返回 `200` 且 SHA-256 与发布包一致；`/reach/healthz` 与 `/reach/` 返回 `200`，`/` 返回 `307`，匿名 API 返回 `401`。

两站在登录态（Ray SSO / nmrkit PIN）浏览器中去掉小字备注后的右键菜单与 `#/operations` 分页清理需由已登录用户实机刷新核对。

<a id="reach-worker-agent-0110-git-oss-20261128"></a>

## 2026-11-28 Windows Worker + Agent 0.1.10 下载发布

Windows x64 Worker、Agent 和 Setup 由 `reach-worker-agent-v0.1.10` 对应的 Git 提交 `4786bd65183db38cc9a127c12f29e04d7bb9d1bb` 构建。GitHub 和 Gitee 的标签均解析到该提交。安装器 `Reach-Worker-Agent-Setup-x64.exe` 为 24,843,776 字节，SHA-256 为 `8005da6c941a2ba6024be599fb8b4bb1564fd70de92ae2b1f8febedbd92f1d7d`。

`reach-update.json` 和 `reach-update.sig` 分别为更新清单和对应的 Ed25519 签名。清单绑定发行标签、源码提交、版本和安装包摘要。EXE 未加 Windows Authenticode 签名。GitHub 的三个发行附件已重新下载并核对摘要。Gitee 的源码和标签已推送，三个自动更新附件待有发行权限的账号登录后发布。 [GitHub 发行版](https://github.com/ZZray/morrow-agent/releases/tag/reach-worker-agent-v0.1.10) · [Gitee 发行页](https://gitee.com/rzjw/morrow-agent/releases)

手动安装包已上传到阿里云 `ciqtek-update-dev/reach/releases/` 下的 `reach-worker-agent-v0.1.10` 目录。nmrkit 使用公网 HTTPS 地址完整下载，响应为 HTTP 200，文件大小和 SHA-256 与 Git 构建产物一致。 [OSS 安装包](https://ciqtek-update-dev.oss-cn-hangzhou.aliyuncs.com/reach/releases/reach-worker-agent-v0.1.10/Reach-Worker-Agent-Setup-x64.exe)

Ray 和 nmrkit 的下载清单均已切换到 `0.1.10`，共用上述 OSS 地址。清单 SHA-256 由 `72be31701b3249fc0793d17e070138542c8d871a639af941db2f74a21b696052` 更新为 `e102fdb587c41813f8e4fccabb689ec2363028f343f0afaab9685e5bb5c9ecd3`。两站按实际运行服务的用户和读取入口复核，Reach PID 分别为 `733752` 与 `956058`，公网健康检查均返回 HTTP 200。Ray 的已登录 `/api/v1/releases` 返回 `0.1.10`、正确摘要和 OSS 地址。两站分别将旧清单备份到 `/root/reach-git-0.1.10-4786bd6/manifest-original.json`。

从 `0.1.9-preview` 迁移到该更新通道需先手动安装 0.1.10。Windows 安装事务 26 项和 OpenSSH 7 项回归通过。nmrkit 登录态页面、Windows 服务跨版本自动更新和公网 IPv6 SSH 仍待实测。
