# 实现接续：Windows Node 与控制器

作者：Ray Zhang（Ray）。日期：2026-11-02。会话：01a19a2e-6694-7a51-a3fb-37a35a8946a6。

## 持续目标及最新修正

用户授权按 52 项清单实现首版并部署到 Ray 工作台。最新要求：暂不集成 LabSlot，做独立 Reach 程序，并在 Ray 工作台增加入口。D07、A04–A06、V01 已调整，原 ID 保留。系统、桌面、安装、管理、Lite/Harness 委托和可选产品能力继续推进。目标保持 active，未缩减为本批 Node 基础。当前未发生连续阻断，没有应标 blocked 的情况。

## 当前工作区与执行证据

E:/repos/ara，dev，基线 90f2b1c；Reach 全部为未提交 WIP，不能清理或重置。已有 Node 24 服务、独立 Rust Node、TS CLI/MCP 控制器。最终 Windows 普通进程测试 22/22、Rust 事务单测 1/1 通过；fmt、Clippy、TS check、cargo-deny Windows 图和 Bun audit 通过。详细源码/二进制哈希、原始日志及边界见 [验证记录](../evidence/node-controller-20261102.md)。完整任务验收仍 0/52。

普通二进制：E:/usr/var/cache/rust-target/reach/debug/reach.exe。开发阶段先 pair，再前台 run；系统服务和配对 IPC 尚未实现。Controller：`node src/controller/main.ts help`，MCP 子命令 `mcp`；真实 stdio 客户端已验证，实际 Codex 加载未做。

Node 有持久身份、幂等配对尝试、SQLite 立即写事务、本地事件 outbox、单实例锁、Windows kill-on-close Job、独立上传与取消检查。command.run、file.read、file.write、directory.list 已实际执行。结果不确定不会重放；人工对账后的迟到原回执保留但不覆盖对账结论。事件可按 after/limit/nextAfter/hasMore 分页。

最终依赖锁已将 rustls/webpki/Tokio 修复版本固定为 0.23.46/0.103.16/1.53.3，无 advisory 豁免。cargo-deny 0.20.2 从官方发行包安装到 E:/usr/opt/cargo-deny-0.20.2，E:/usr/local/bin/cargo-deny.exe 为硬链接，安装归档已按 GitHub digest 校验。

## 下一步

1. 新锁/最终证据独立复核已接受 UI 前固定 Node/controller 基础快照；后续管理 UI 改动另建快照和执行证据，不把这批当 52 项已完成。
2. 补齐 P0 安装、集成、完整验收合同；继续 P1 真实跨机、控制器发行及实际 Codex 接入。
3. 实现独立管理页与 Ray 工作台入口。UI 开始前读 emil-design-eng 和 ui-delight；不做云端聊天页或权限模式。
4. Windows 服务/本机认证 IPC、桌面会话助手与安装包是后续必要工作。Windows-MCP 固定候选 94de2b4a5e1f2c52aad6003d5e60af28f57b8c8b，尚未安装、打包和实测。
5. 远端 Agent 必须接 Lite/Harness 原循环，不能复制；QSpin 等仍为可选产品能力。用户只明确延期 LabSlot，未取消其他清单。

## Ray 部署调查

没有改线上配置、安装产品或重启服务。ray-dev 在线，Node 24.20.0，Reach 拟用环回 18910；ray-front 当前掌管 80/443/8080/8000。配置 /etc/ray-front/bridge.json 的键为 acme_root、arena_token、auth_state、gateway_session_secret、handwave_token、public_ip、tls_cert、tls_key；无发现可配置的新应用路由，不打印秘密值。

当前 ray-front Go 模块为 `ara/apps/provider/cmd/ray_front`，源码尚未定位。其 2026-10-21 部署记录 `/opt/ray-front/deploy-node-029-20261021/deploy-plan.json` 标注 commit `0b9cb7c3eabf1e4d82bfc1d6147786c2d883721c`；该提交不在本地 Rust ARA 对象库中。记录 source_name 为 handwave-node-source-c66c50a8d91d0a3c.tar.gz，可能只是 Node 发行源码，不能未经检查当作 ray-front 源码。仅有新旧二进制和部署脚本，未查明 source archive 路径。

/opt/ray-front-tools 只有 TLS 工具；/root/ray-reviewed-cutover-* 有旧切换脚本，未见 Go 源码。E:/workspace/omp-claude-compat 只有旧网关二进制和 preflight。继续定位当前入口的可维护源码或正式扩展方式；不要对未知版本二进制直接补丁。

远端证书路径 /etc/letsencrypt/live/ray-front-ip/fullchain.pem，观察到有效期 2026-10-29 至 2026-11-04，短期证书需沿用现有自动续期。独立 HTTPS 端口方案的网络可达性尚未验证。用户已明确授权增加工作台入口，现有服务可用性仍需独立检查。

## 工具与文档

Cargo 一次只跑一个构建/检查。cargo-deny 在线 fetch 会占 package cache 锁；优先先固定精确依赖、完成下载，再用 frozen Windows 图检查。遇到 crates.io 的 `/version/download` 超时，可从官方 `.crate` 地址下载并按锁校验；不改 registry 校验值。

旧 HTML 计划保留 2026-11-01 快照，最新范围只以 Markdown 清单为准。humanizer 仍缺失，文字由人工审读并记录该工具缺口。全局 memory 未写入。
