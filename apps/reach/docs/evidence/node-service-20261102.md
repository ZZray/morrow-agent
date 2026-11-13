# Windows 常驻宿主与本机配对

作者：Ray Zhang（Ray）。日期：2026-11-02。范围：C03/C04 的常驻进程、认证 IPC、配对事务与停止恢复；D05 安装合同。正式 SCM/SYSTEM、安装包与干净机器验收未完成，本次不勾选完整任务。

## 已实现行为

- 隐藏的 `service --binding-owner <SID>` 进入 Windows SCM dispatcher；stop/shutdown 设置合作停止信号。该路径已编译和静态审查，尚未实际注册、启动或停止 Windows 服务。
- Windows 默认 `pair/status` 访问生产管道，发送任何配对码前检查 SCM 当前 PID 与连接实际 PID；服务不可用不直接打开账本。管道拒绝远程客户端，绑定主体只获明确的数据访问位，客户端采用 identification-only SQOS。
- 显式开发目录下 `host` 持有唯一账本，随机命名管道通过受保护的 `control-owner.json` 发布。其创建实例的执行主体与生产 SYSTEM 分开记录；同用户开发模式不冒充服务权限隔离。
- 配对前处理已有 poll、停止旧身份循环并 join uploader。执行中的新配对返回 busy，不自动排在任务后。身份和本机配对收据在同一 SQLite 事务提交；网络结果未知保留原 pending，IPC 丢失答复不取消宿主事务。
- 合作停止实际回收 Job 进程树。已经开始的动作保留 unknown 及 `processTreeStopped`；重启上传原 outbox，不重做动作。尚未配对时常驻等待，不反复创建身份。
- reparse/junction 在 canonicalize 前拒绝。状态目录与六个关键状态文件替换完整 DACL，清除非预期显式 ACE。生产目录 Owner 与父目录信任仍必须由安装器建立，不能用本轮 DACL 验证替代。

源码、测试和普通程序绑定见 [版本快照](node-service-20261102.json)。新模块为 `control.rs`、`pairing.rs`、`windows_host.rs`，调用方在 `main.rs/runtime.rs/ledger.rs`；共享 ARA Core 未修改。未提交、推送、部署或安装机器服务。

## 最终验证

工作目录为 `apps/reach`，目标目录为持久的 Reach 独立 Rust target。最终执行结果：

| 检查 | 结果与证据 |
|---|---|
| `cargo fmt --all -- --check` | 通过，终版无格式差异 |
| `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings` | [通过](node-service-clippy-v4.log) |
| `cargo build --locked` | [Windows 普通程序构建成功](node-service-build-v4.log) |
| `cargo test --locked --workspace --all-targets` | [2/2 通过](node-service-rust-v4.log)；本 workspace 只有 binary，无 doctest 目标 |
| `node --test --test-concurrency=1 tests/node.integration.test.ts` | [22/22 通过](node-service-all-native-v4.log)，0 跳过，184.531 秒；测试使用快照中的普通 reach.exe |
| cargo-deny 0.20.2，frozen Windows 图 | [advisories/bans/licenses/sources 均通过](node-service-dependencies-final.log)；保留已有多版本及未匹配许可项警告，无新增豁免 |

22 项真实进程测试包含原 12 项 Node/CLI/MCP 回归，以及 10 项新增场景：

1. 未配对常驻、IPC 状态、首次配对、重配到 epoch 2、旧配对收据重读、原身份重启。
2. 实际命令写文件后保持运行，重配被拒绝；停止回收工作树，本地及服务原操作成为 unknown，重启文件仍只有一次写入。
3. 服务已接受配对后杀掉 IPC 客户端，宿主仍提交身份；宿主重启后原输入返回缓存收据，网络配对调用总数仍为 1。
4. 假管道 PID 不匹配时拒绝，服务端接收的配对字节为 0。
5. 当前 Windows 用户不在指定绑定主体内时，实际管道访问返回 OS error 5。
6. 通过 SQLite trigger 注入 running 收据失败，实际命令未执行，恢复记录 unknown；阶段复位后对账并成功重配。
7. 阻塞 `/node/pending`，此间提出配对；释放后直接处理配对，旧身份新增 poll 为 0。
8. 向目录与数据库增加 Everyone 显式权限后启动 host，再读实际 ACL，额外权限已清除。
9. 通过真实 Windows junction 指向状态目录，host 拒绝该入口。
10. 阻塞 pending，等待 `host-stop` 的真实 ACK 再释放响应；宿主退出且新增 poll 为 0。

测试会自行清理隔离目录和进程；验收内容包括实际文件读取、数据库记录、进程结果、原操作事件和服务返回，不仅检查 HTTP 状态。没有使用生产身份、配对码或数据库。

## 保留的失败与复核

初次编译发现局部变量遮蔽，已修复。首轮普通 host 测试为 2/5：普通用户执行主体没有创建后继管道实例的权限，首连接导致 EOF；现给执行主体单独的实例创建位，生产绑定用户仍不含该权限。第二轮 4/5 的剩余失败来自测试在新 host 发布前读取旧 descriptor，已改为核对新 PID 就绪。

第一次完整回归为 19/21：测试辅助连接缺少 SQLite busy timeout，且 Windows PowerShell 5 的模块环境无法加载 Get-Acl；分别加上 5000 ms busy timeout、改用 .NET ACL 读取，没有删去断言。初次 cargo-deny 因 PATH 只有 cargo.cmd 失败，补齐当前进程的实际 cargo.exe 路径后通过，未更改全局环境。相关 `initial/v2/all-native/dependencies.log` 文件保留，最终结论只依据 v4 与 final 日志。

独立审查者为 `/root/reach_plan_review`，按 ara-git-review / ara-rust-core-review 只读核对目标源码及原 WIP 基线。复核推动修复后继管道权限、异常时残留 busy、pending 恢复后的新领取以及 stop 消费后的漏检查；最终静态复核未发现新的确定性缺陷。主任务核对了最终执行终态、普通程序和源文件快照。收尾独立核验确认 41 个输入文件、3 份 WIP 基线和普通程序哈希均匹配，日志与本页结论一致。

文档检查覆盖 34 个活动文件、200 个本地链接和 57 个唯一任务 ID，无 Reach 断链；`git diff --check` 通过。全仓 bootstrap 仍报告 38 项既有 Reach 外断链，记录在 `node-service-bootstrap.log`；不称全仓通过。

## 下一步

按照 [安装合同](../installation-update.md)实现可信安装目录/Owner、无引导安装器、自动延迟服务、机器 PATH、升级维护停领与恢复，再进行实际 SCM/SYSTEM 和普通用户验收。本机当前进程不是管理员，以上生产验证尚未执行；这不阻塞继续准备可评审的安装制品。桌面、完整证据、Lite/Harness 委托、真实 Codex 加载、Reach Desk 接线仍按原 52＋5 项推进。
