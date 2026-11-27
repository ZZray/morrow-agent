# Reach 正式上线交接

作者 Ray Zhang（Ray）。2026-11-24（Asia/Taipei）。

## 版本与入口

| 项目 | 现状 |
| --- | --- |
| 源码 | Morrow 的 `E:/repos/morrow-agent/apps/reach`，发布分支 `codex/reach-web`。[GitHub](https://github.com/ZZray/morrow-agent/tree/codex/reach-web) · [Gitee](https://gitee.com/rzjw/morrow-agent/tree/codex/reach-web) |
| Web 版本 | GitHub、Gitee 和 Linux 正式服务均为 `ebd997134a7029d7f57ebee72ac34c7f3c8230d8` |
| 正式页面 | [控制台](https://nmrkit.ciqtek.com/reach/) · [Worker 下载](https://nmrkit.ciqtek.com/reach/#/downloads) · [健康检查](https://nmrkit.ciqtek.com/reach/healthz) |
| 登录 | Reach PIN。数据库已使用非默认 PIN，接手时通过用户取得现行登录信息。启动配置中的初始值只在初始化或显式重置时生效。 |
| Worker | `0.1.3` Windows x64 预览包，Git 标签 `reach-v0.1.3` 在两端均指向 `aaebd6b776aa47ace0be0bdbc63878cd62338aa0` |

开发机的 Morrow `main` 有既有未提交工作。后续发布以远端 `codex/reach-web` 为基线，从干净检出验证。LabSlot 与 Reach 使用各自的应用、账户和 SQLite。GitHub 与 Gitee 按同一提交同步。

## Worker 安装

1. 在被控 Windows [下载安装包](https://nmrkit.ciqtek.com/reach/downloads/reach-v0.1.3/Reach-Node-Setup-x64.exe)，双击并按提示允许安装。安装器会注册和启动 `RYReach` Windows 服务。
2. 新装完成后，弹窗填 `https://nmrkit.ciqtek.com/reach`，结尾不带斜杠，点击「保存」。已有地址时用 `ryreach config set server-url https://nmrkit.ciqtek.com/reach` 修改。切换服务端后需按新服务端重新配对。
3. 在正式网页「设备」生成配对码，把页面给出的 `ryreach pair` 命令复制到被控 Windows 运行。网页收到首次有效状态上报后显示在线。

镜像安装包为 16,691,200 字节。SHA-256 为 `14dfc49356f78e1e7421818a88b988f264e769b13cadbb9347fcc6a2fbbcb8cc`。Ed25519 对更新清单签名，清单绑定安装包字节。Windows Authenticode 状态为 `NotSigned`。GitHub 和 Reach 镜像有同一安装包、清单和分离签名，Gitee 发行附件待上传。

## 部署与验证

- Linux 运行独立的 `reach.service`，Node 24.22.3 监听 `127.0.0.1:18910`。应用版本由 `/opt/reach/current` 指向，数据在 `/var/lib/reach`。已有 PIN、配对和账本存于 SQLite。服务环境由 root 管理。
- Nginx 的独立 Reach snippet 将 `/reach/` 转给应用，`/reach/downloads/` 指向 `/srv/reach-downloads/`。网页发行清单位于 `/opt/reach/current/deploy/nmrkit-releases.json`。正式站运行的服务身份已成功读取清单，来源顺序为 Reach 镜像、GitHub。主页、既有 SSH 隧道健康状态与切换前一致。
- 本次前端通过 TypeScript 检查和 27 项 Web 测试。独立复核通过预览标识、安装步骤和清单。公网回下载的 `admin.js`、更新清单和分离签名的 SHA-256 与发布包一致。工作站慢速下载安装包时发生超时，经 HTTP 206 续传拿到全部 16,691,200 字节，SHA-256 一致。正式 PIN 已改，自动浏览器在登录处停止，登录后的页面和复制按钮待用现行 PIN 复核。 [下载收据](../../outputs/web-download-release/verified-public/setup-receipt.json)
- 本地产物和部署收据位于 `E:/repos/morrow-agent/apps/reach/outputs/web-download-release`。源码入口是 [下载卡与安装说明](../../src/admin/admin.ts)、[发布清单接口](../../src/service/releases.ts) 与 [Web 实现交接](2026-11-24-web-console-impl.md)。

## 待接手

本地 0.1.8 预览包已实现 Worker 和 Morrow Agent 先安装，随包 OpenSSH 按需启用。本机无 SSH 条件下通过实际包内 Worker 配对和 Agent 文件操作。新测试机双击、LocalSystem 服务、正式配对及按需启用 SSH 待复试。[0.1.8 验证](../evidence/2026-11-24-rydev-service-update.md#018-worker-和-agent-首装预览)

Reach Desk 目标沿用现有控制台 PIN 与设备配对。在正式部署前接通网页模型设置，完成云端对话和设备 Agent 回执验收。现场模型由用户在网页设置，服务端持久保存并验证。设置 API、浏览器验收和正式部署待办。[设置与 Desk 前端交接](2026-11-24-reach-desk-settings-frontend.md)

0.1.3 在缺少 OpenSSH 的机器上可触发安装写入报错。0.1.5 修复写入，0.1.6 增加监听复查。新机 LocalSystem 启动日志确认默认主机私钥所有者或权限不合规。[本地 0.1.7 Windows x64 重试包](../../outputs/ssh-hostkey-retest/Reach-Node-Setup-0.1.7-preview-0f474fa011b415ae.exe) 修复默认私钥 ACL，覆盖旧半装服务恢复。等待同一新机双击复试。[OpenSSH 首装案例与验证](../evidence/2026-11-24-rydev-service-update.md#新机-localsystem-拒绝主机私钥)

1. **正式 Worker 验收。** 用一台获授权的 Windows 新装当前预览包，使用正式地址配对。记录实际版本、`RYReach`、网页首次在线、上线通知和一次 `hostname` 原回执。需要验配置时，另核对心跳请求从待处理变为已生效。使用现行 PIN 在正式下载页核对下载和地址复制。
2. **Gitee 和两轮自动更新。** 保持 RyDev 原测试环境。当前实查 RyDev（CAN00）为 `0.1.2`、服务 Running，PID 30028。它缺少更新验签公钥。先用同一份 `0.1.3` 覆盖作基线，并核对原配对和原 `hostname` 回执。上传 Gitee 的三个真实附件，核对两端公开下载摘要。目标 `0.1.4` 已构建签名，基线确认前保留待发布。两轮都从同一个 `0.1.3` 出发，分别记录 GitHub 正常更新和 GitHub 请求失败后的 Gitee 更新。核对实际安装器和运行中 Node 的 SHA-256、更新尝试来源、网页心跳、原配对和原回执。
3. **保留原 RyDev 证据。** 原测试安装 ID 为 `00daffa8-c621-492e-9901-2a83ae539a20`，原 Node ID 为 `ced7fbd3-b2ff-4d3f-beae-14130b51a0b1`，epoch 为 1。原操作 ID 为 `79544e3c-ebcf-47bd-a10e-8b127c098cfe`，输出 `CAN00`、退出码 0。原记录属于隔离测试入口 `https://127.0.0.1:43143`。改绑正式地址前应先保全这套证据，双源测试以原测试记录为准。详细见 [RyDev 服务与更新记录](../evidence/2026-11-24-rydev-service-update.md)。

正式 Web 上线记录见 [PIN 与部署验收](../evidence/2026-11-24-nmrkit-web-pin.md)。

