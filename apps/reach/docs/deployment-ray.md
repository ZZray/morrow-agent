# Ray 部署与恢复

作者：Ray Zhang（Ray）。日期：2026-11-02。状态：443 路径与 Ray 统一登录已部署；实际工作台进入、多标签写请求与原生跨机链路已有证据。

部署三层分别记录：Reach Node 24 应用、现有 ray-front.service 的 443 路径入口、Ray 工作台卡片。首次尝试的 8443 独立 HTTPS 单元已停用，步骤仅作历史记录。用户已授权部署与增加入口；LabSlot 延期。工作台源版本及 Cookie 合同见[系统集成](integrations.md)。

## 构建与目录

Reach 使用 Node >=24.20.0。在 apps/reach 执行 `bun install --frozen-lockfile`、`bun run check`、`bun run build:admin` 和对应测试。发行 service/ 只包含 package.json、bun.lock、src/contracts、src/service、src/admin、dist/admin 及固定 zod 运行依赖和许可证；不包含 work、.env、SQLite、控制端会话或测试账户。

工作台固定检出使用 `scripts/build.ps1 -Target RayFront` 执行目标 Go 测试、vet、既有 JS 合同和 Linux amd64 构建。handwave_security.test.cjs 由 Go 包装测试传入实际适配夹具运行，不作为无参数独立脚本启动。Avatar JS 夹具通过 HW_DOM_MODULE 指向已固定的 linkedom 0.18.12。需要一并检出 handwave 的 memorystore、websafe、release-web 与 web 测试资源。普通产物为 bin/ray-front-linux-amd64，版本与 SHA-256 写入部署收据。

服务器目录：

- `/opt/reach/releases/<版本>/service`：只读应用与运行依赖。
- `/opt/reach/releases/<版本>/bin/ray-front`：随包保留的工作台候选二进制；当前主服务实际运行 `/opt/ray-front/bin/ray-front`。
- `/opt/reach/current`：当前发行目录链接，切换前保存原目标。
- `/var/lib/reach`：Reach 用户独占的数据库，不随程序回滚覆盖。
- `/etc/reach/service.env`：root 管理的私有环境；独立账户初始化密码只用于首次引导。
- `/etc/reach/ingress.json`：历史 8443 单元的 TLS-only 配置，只有 public_ip、tls_cert、tls_key，不含 Ray 身份/桥接秘密；当前 443 主服务不使用此文件。

应用服务由独立 reach 用户运行；当前 HTTPS 由原 ray-front.service 承担，使用原 `/etc/ray-front/bridge.json` 启动配置和平台身份状态，读取已续期的 `/var/lib/ray-front/tls/combined.pem`。历史 8443 独立单元才使用 TLS-only 配置及 systemd 路径限制隐藏 Ray auth.json 和 bridge.json；不能把这种隔离套用到需要验证平台登录的主服务。证书沿用实际维护文件，不读取原始 ACME 私钥。

## 历史首次发布顺序（8443）

1. 核对运行中的 Ray 二进制 SHA、原入口状态和端口占用；保存二进制与环境 drop-in 备份，记录版本，不导出身份秘密。
2. 验证完整发行包 SHA 和源码快照，解包到新发行目录；准备独立环境、用户与 systemd 单元。环境启用 HTTPS public origin，关闭开发选项，只信任 127.0.0.1。
3. 启动 Reach 与独立 HTTPS 单元。先用不保存 Cookie jar 的原生/Bearer 客户端正常校验证书，检查匿名 API 拒绝、账户登录、Windows Node 配对与操作/收据；同时检查原工作台入口未中断。此时不要在浏览器登录 Reach，避免旧工作台代理转发同 IP 共享的 Reach Cookie。
4. 首次账户已持久化后移除环境文件中的引导密码并重启应用，确认原账户仍可登录。凭据保存在受保护交付文件，不写入日志/仓库。
5. 只在独立入口通过原生验证后，按已保存 SHA 前置条件替换含双向 Cookie 过滤的工作台候选二进制，增加独立 drop-in 卡片开关并重启 ray-front。失败立即恢复二进制和 drop-in，再验原服务；恢复旧代理前须先停止 Reach 浏览器入口并清除/失效测试会话，避免回滚重新引入 Cookie 转发。
6. 确认新工作台过滤已经生效后，再登录 Reach 浏览器并从实际工作台点击卡片验证，分别记录登录、配对、文件/命令效果与原操作 ID。只检查页面 200 不构成入口和远程操作验收。

## 当前 443 路径迁移

用户要求更换公网不可达的 8443 后，使用 deploy/switch-ray-path.py 一次性迁移到 `/reach/`，已执行，不能重复用于更新。迁移前后均核对零 Node/零操作，备份二进制、环境和 current 链接；停止独立入口、失效旧 Reach 会话，更新服务 origin/Cookie Path 与工作台二进制。真实切换前后原入口健康保持一致；公网证书、真实跨机文件效果及工作台卡片均已核对。旧 8443 单元已停止并禁用。

Ray 统一登录另用 deploy/enable-ray-sso.py 升级。它核对当前发布哈希、保留既有 Node/操作/事件数量，单独创建两份受保护的专用密钥。服务与工作台版本一起切换，失败先失效 Reach 会话，再恢复旧程序/环境/链接；不覆盖操作账本或 Ray 登录状态。最终实际证据以相应部署收据为准。

并发首次开页的稳定会话修正使用 deploy/update-ray-service.py，已执行。该脚本固定旧 release、归档哈希和原 Go 二进制哈希，停服前后均拒绝活动操作，只删除侧库标记的旧 SSO 会话，再切换 Reach 应用；原生会话、Ray 登录、密钥及操作账本保留。失败恢复旧应用并检查健康，不恢复旧数据库。此脚本绑定本次发布前置条件，不能直接重复用于后续更新。

当前 release 为 `/opt/reach/releases/20261102-sso-stable-05d25e8c84eb`。部署收据及准确源码/产物快照见[Ray 统一登录证据](evidence/ray-sso-20261102.md)。SSO 启用与更新脚本的失败恢复经过源码复核，但尚未执行独立故障回滚试验；443 迁移脚本的两项受控回滚测试不替代此项。

## 恢复与证据

若独立应用失败，停止 reach/reach-ingress，恢复 current 链接及先前服务配置；保留数据库与失败收据，不重新投递未知操作。若仅卡片/工作台变更失败，恢复原二进制及卡片 drop-in，原 bridge.json、auth_state 和其他应用状态保持原有数据。新发行目录保留以便取证，不用清理动作掩盖失败。

部署记录必须包含：源 SHA 与差异、发行/普通二进制哈希、原二进制前置条件、实际服务状态、TLS 校验、跨机操作 ID/产物哈希、浏览器入口结果、失败及恢复记录。本文是操作合同；只有对应实际日志与收据出现后才更新为已部署。
