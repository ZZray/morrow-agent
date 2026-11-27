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
