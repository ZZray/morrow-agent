# Node 与 CLI/MCP 基础链路验证

作者：Ray Zhang（Ray）。日期：2026-11-02（Asia/Hong_Kong）。

## 范围与版本

本批验证独立服务、Windows 前台 Node、命令/文件工具、持久收据和本地 CLI/MCP 控制器。仓库基线为 `90f2b1cdd138129e2d331d89a37d70852e849739`，交付对象是 UI 开发前的未提交固定快照。24 个源码/测试/配置文件与普通 reach.exe 的 SHA-256 见 [固定快照](node-controller-20261102/source-snapshot.json)。后续管理 UI 改动另行验证，本页结果不自动适用于当前工作区。

环境：Windows 11 专业版 10.0.26200，x64 MSVC；Rust 1.98.1、Node 24.21.0、Bun 1.4.3。Cargo 使用独立 `apps/reach/Cargo.toml`，产物放在 `E:/usr/var/cache/rust-target/reach`，没有构建 Full workspace。服务和 Node 均以普通独立进程运行，经受控环回 HTTP 代理注入响应丢失和暂时故障。本批没有调用模型，也没有部署到服务器。

执行检查及最终独立复核已通过，仅接受上述固定快照的基础交付点。完整任务清单仍为 0/52，不以本批代替 C07 跨机、T07 完整工具、安装、桌面、Agent 委托或发布验收。

## 实际结果

| 验证 | 命令与结果 | 原始记录 |
|---|---|---|
| 普通 Node 构建 | `cargo build --locked --offline -j 2`，通过，11.26 秒 | [构建](node-controller-20261102/build-final.txt) |
| 格式 | `cargo fmt --all -- --check`，退出 0 | 无诊断输出 |
| Clippy | `cargo clippy --workspace --all-targets --all-features --locked --offline -j 2 -- -D warnings`，通过，5.14 秒 | [Clippy](node-controller-20261102/clippy-final.txt) |
| Rust 事务故障 | `cargo test --workspace --all-targets --locked --offline -j 2`，1/1 通过，执行 1.18 秒 | [Rust 测试](node-controller-20261102/rust-tests-final.txt) |
| TS 类型 | `bun run check`，通过 | [类型检查](node-controller-20261102/check-final.txt) |
| 普通服务、Node、CLI/MCP 进程及服务合同 | 设置 `REACH_NODE_BINARY` 后运行 `node --test --test-concurrency=1 tests/service.test.ts tests/service-process.test.ts tests/node.integration.test.ts`；22/22 通过，无跳过，187.989 秒 | [最终集成测试](node-controller-20261102/tests-final.txt) |
| Windows 依赖图 | cwd 为 `apps/reach`，cargo-deny 0.20.2：`cargo-deny --manifest-path Cargo.toml --config deny.toml --color never --frozen --target x86_64-pc-windows-msvc check --hide-inclusion-graph`；advisories/bans/licenses/sources 全通过 | [最终依赖检查](node-controller-20261102/dependencies-final.txt) |
| Node 依赖 | `bun audit --json`，退出 0，结果 `{}` | [Node 审计](node-controller-20261102/node-dependencies-final.json) |

这是 22 个不同 TS 测试加 1 个 Rust 测试。中途重跑同一用例不重复计数。当前包只有二进制目标，没有可运行的库 doctest。

真实效果检查包括：

- 配对输入先落盘；丢响应后重试恢复同一安装；已接受后被解绑的尝试恢复原凭据及 revoked 状态，新码重配仍保留安装 ID。
- 第二个 Node 进程被同一状态目录的锁拒绝。命令输出在命令结束和文件写入之前被控制端观察到；重复 requestId 返回原操作，实际文件只有一次追加。
- 文件写入读回、SHA-256 条件拒绝、UTF-8 内容、目录结果均核对；改写既有文件后硬链接仍指向同一内容。
- 真实 PowerShell 子孙进程在取消后停止；结果记录 unknown 与已观察到的进程树停止，不声称副作用回滚。
- 强杀 Node 后恢复原收据，不再次执行命令；本地回执缺失时从服务原序号追加 unknown；已为 unknown 的服务快照不再追加重复终态。
- 上传 ACK 丢失重用同一事件，解绑后仍能补传原收据；未 ACK outbox 和 received/running 遗留阻止换 epoch。先人工对账、后恢复 Node 时保留原迟到证据及独立对账结果。
- 服务 pending 接口连续故障后，同一 Node 进程恢复连接。CLI 和 MCP 对同一 Node 及操作返回一致身份，实际文件由 MCP 提交产生。
- 240 万字节真实 stdout 经多页完整读取，序号连续、nextAfter 正确、内容 SHA-256 与原始输出一致；最终版本此例用时 67.266 秒。
- SQLite 触发器真实拒绝 outbox INSERT 时，入场记录与终态变更一起回滚，不产生没有回执的已接收/终态记录。

测试临时文件在断言实际内容、哈希与进程状态后清理；证据保留可复查的测试源码、版本哈希和原始执行日志，不把临时路径当作仍存在的发行产物。

## 发现、修正与失败保留

初轮 native 6 项有 1 项失败：事件事务读取后升级写锁与上传 ACK 写入竞争，SQLite 返回锁错误。改为 BEGIN IMMEDIATE 后基础组合用例通过。

随后 240 万字节用例发现，持续入场输出让 ACK 写入超过 busy timeout，uploader 退出；本地已有完整结果，服务仅收到早期事件。当前仅对同一本地 ACK 的 Busy/Locked 做异步等待重试，保留原 eventId；其他错误仍明确返回。原失败及恢复批次见 [恢复/分页早期记录](node-controller-20261102/recovery-pagination-tests.txt)，修正后单例记录见 [大输出复验](node-controller-20261102/large-output-tests.txt)，最终统一版本见上表。

独立源码复核发现并修正：无效配对输入永久 pending、旧 epoch 未结算本地记录重配、已接纳配对被解绑后的身份恢复、pending 网络故障导致 Node 退出、人工对账后的迟到证据、事件页超过客户端响应上限。保持原事件身份，未通过重新排队掩盖错误。

第一次 Windows 依赖审计发现 rustls 0.23.45 的 RUSTSEC-2026-0346/0347/0348/0349、rustls-webpki 0.103.15 的 0382、Tokio 1.53.1 的 0386。分别升级到 0.23.46、0.103.16、1.53.3 后通过；没有添加通告豁免。原审计见 [失败记录](node-controller-20261102/dependencies-offline.txt)。最终锁文件 SHA-256 为 `1fc450d7b3cc8cacfd6cfac9c53fae5ffd1b339ec11ef655f48617459087570b`。

cargo-deny 的两个未匹配许可条目和 base64/getrandom/windows-sys 多版本仍是警告，非审计失败。数据库通过 `cargo-deny fetch db` 刷新，固定为 `2295466c4e9df26647fd67d8fa1c705ac2fc7f81`，详见 [数据库版本](node-controller-20261102/advisory-db.txt)。下载不稳定时使用官方 static.crates.io 包地址，并按 Cargo.lock SHA-256 核对后放入持久缓存；没有换镜像或改锁校验值。

## 未覆盖

没有证明公网 HTTPS/跨机执行、实际 Codex 配置加载、Windows 系统服务和配对 IPC、干净机安装/更新、桌面会话后端、完整日志/进程/传输工具、管理页、远端 Lite/Harness/模型、产品适配或生产部署。Job 分配失败、16 MiB 输出上限等路径尚无独立故障运行记录。本次没有声称多版本 Windows 或 Unix 支持。

用户最新要求是独立 Reach 应用和 Ray 工作台入口，LabSlot 集成延期；该范围变更已记录于任务清单，不以本批测试代替新入口验收。

## 独立复核

复核者 `/root/reach_plan_review` 使用 ara-git-review、ara-rust-core-review 和 point-delivery-audit，读完 Node manifest/lock、7 个 Rust 源码、Controller 3 文件、相关服务合同与全部 native 测试，逐项复核上述修正。最终结论：接受固定快照的 Node/controller 基础交付点，指定范围无未闭合缺陷。

复核者首次最终核验确认 24/24 输入及普通 reach.exe 哈希匹配；核对 22/22 TS、1/1 Rust 和构建/检查日志，三个升级后的实际缓存包 SHA-256 与锁一致，RustSec HEAD 与审计记录一致。主代理直接核对原日志与哈希。最终核验期间已开始后续 UI 开发，package.json、server.ts、tsconfig.json 首先发生漂移；保留原快照，不用旧 22/22 声称含 UI 的版本通过。公网、安装、桌面、模型、管理 UI 与工作台入口均不在本次接受范围。
