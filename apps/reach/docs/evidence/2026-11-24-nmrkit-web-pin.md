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
