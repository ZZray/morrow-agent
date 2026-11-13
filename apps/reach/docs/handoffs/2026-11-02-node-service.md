# 接续：Windows 常驻宿主与安装器

作者：Ray Zhang（Ray）。日期：2026-11-02。持续目标仍是完整 Reach 首版与 Ray 部署，基础 52 项、Reach Desk 选装 5 项分别验收，未改为仅做服务宿主。

本轮已完成实际代码进展，不是等待或阻断。Windows `service` 入口、开发 `host`、本机认证管道、常驻配对、持久配对收据、执行阶段清理与合作停止均已实现；[最终证据](../evidence/node-service-20261102.md)及 [源码/二进制快照](../evidence/node-service-20261102.json)明确实际覆盖。最终 22/22 普通进程、2/2 Rust 单测、Clippy/fmt/依赖审计通过；独立审查 `/root/reach_plan_review` 的已确认问题均已修复。所有测试进程已终结，不存在应续等的 Cargo/测试句柄。

仓库仍为 `E:/repos/ara`、`dev`、基线 `90f2b1c` 加未提交 WIP。保留全部先前工作。普通 Node 二进制位于 `E:/usr/var/cache/rust-target/reach/debug/reach.exe`；代码主要为 `src/node/control.rs`、`pairing.rs`、`windows_host.rs` 及主入口/运行循环/账本。旧 WIP 对照只在忽略的 `work/service-before/`，不要当作当前实现。未提交、推送或改动线上服务。

## 下一动作

1. 按 [安装合同](../installation-update.md)制作真正的无引导安装制品：可信安装父目录、SYSTEM/Administrators Owner、显式绑定主体、SCM 自动延迟启动、机器 PATH、实际启动检查及失败恢复。先完成可评审制品，再处理所需 UAC；当前 shell 非管理员，不把普通 host 验证当作 SYSTEM 或 SCM 通过。
2. 保护已有安装和状态。当前程序能设置完整 DACL，但不负责把不可信 Windows Owner 变为可信；安装器不能静默采用其他普通用户预先建立的 ProgramData 状态。升级需维护停领，不能仅查询一次 status 后就切换。
3. 补 T05/D06 桌面后端和交互会话。既有固定 Windows-MCP 来源仍只是调查，不能据此打勾或要求现场用户安装 Python。
4. 继续文件/日志/完整证据、真实 Codex MCP、Lite/Harness 委托及产品可选接入。Reach Desk 名称及内部迁入已完成兼容验证，真实云端 Host/Reach 身份设备接线和 Ray 切换仍未做；见 [平台迁入证据](../evidence/platform-migration-20261102.md)。

## 已确定的实现边界

生产默认 `pair/status` 查询 SCM 与固定管道，不回退到直接打开机器账本。开发 `--state-dir` 在存在 host descriptor 时使用独立随机管道，残留 descriptor 不触发回退。普通 host 的创建主体和绑定主体可为同 SID，属于同一开发信任域；生产绑定用户不应获得管道实例创建权限。

配对缓存返回原 `pairingReceipt` 与当前绑定两项事实。状态 SQLite 的网络 pending 与已完成配对收据分开保存，身份与完成收据同事务。IPC 客户端退出后，服务仍完成已接纳的事务。停止是请求加实际结算，开始过的动作仍可为 unknown；恢复只上传原 outbox。

本轮失败日志保留：初次变量遮蔽、普通 pipe 后继实例无权限、测试读取旧 descriptor 的竞态、测试辅助 SQLite busy timeout 缺失和 PowerShell 模块读取 ACL 失败。最终日志是 `node-service-*-v4.log` 和 `node-service-dependencies-final.log`，不要引用较早失败产物为当前版本。后续修改必须针对新源码重新验证受影响检查。
