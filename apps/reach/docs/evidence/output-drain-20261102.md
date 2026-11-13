# Node 输出收尾修复

作者：Ray Zhang（Ray）。运行日期：2026-11-02；收尾复核：2026-11-03。

本点修复命令进程退出后，输出消费者暂时变慢导致 worker 过早返回 unknown 的问题。范围为 `src/node/worker.rs` 和相关原生验证；主代理原始产物回查及[独立复核](output-drain-review-20261103.md)已通过。不代表完整 T02、安装或清单验收。

## 行为与版本

旧版从 shell 退出起绝对等待 2 秒，无法区分读线程在等待管道数据，还是正在向 Node 发送已有数据。Node 同步持久化较慢时，后者被误判为后代占用管道，甚至在终态之后继续出现输出帧。

现在每个输出线程在 `pipe.read` 前记录读取开始时间，返回后立即清除；计数、编码和发送期间不计入读取停滞。只有 shell 已退出至少 2 秒，且所有未结束的 reader 均持续等待读取至少 2 秒，才返回 `unknown/output_drain_stalled`。短锁不跨越 I/O、发送或线程等待；终止判断前检查 reader 是否已经结束。原两个读取线程、8192 字节缓冲、共享 16 MiB 上限以及 Node deadline/cancel/Job 清理保持。

验证使用的 Windows x64 静态 Node 为 `E:/usr/var/cache/rust-target/reach-static/x86_64-pc-windows-msvc/release/reach.exe`，SHA256 `5029a53f90e50384c41165e72436185f6834b29bcb116c9ea8d04b4034703dc7`。旧图标版保存在 `work/output-drain/reach-before.exe`。本点没有重新生成普通 debug Node。

## 真实背压对照

`tests/output-drain-backpressure.py` 先将 worker 放入真实 Windows Job，才打开 stdin 指令 gate。读取 processStarted 帧后等待 shell 退出，确认 exitCode=0，再停止消费 3250 ms。此时管道有 11344 字节待取，小于完整输出所需的至少 21848 字节 base64，证明仍有发送背压。

旧版返回 unknown，随后仍有 output；新版完整返回 16384 个 x，最后一帧为 succeeded。两次输出 SHA256 均为 `1536c422c31cc98834759d7085cda394a3510a03d78188248986a6b1a7207d03`，Job 活跃进程数均为 0。原始帧与收据分别保存在 `work/output-drain/backpressure-{before,after}.stdout/.json`；运行输出为 `output-drain-backpressure-{before,after}-final.log`。独立 reviewer 已逐帧核对这两份原始 stdout。

## 测试记录

以下是组合证据，不能称为一次 32/32 整批通过。日志均位于本文同目录。

| 运行 | 实际结果 | 解释 |
|---|---|---|
| `output-drain-node-build.log` | release 构建通过 | 约 67 秒，产物为上述 5029a53f 版本 |
| `output-drain-clippy.log`、`output-drain-rust-tests.log` | clippy 通过；Rust 7/7 | fmt 同时通过 |
| `output-drain-deny.log` | 离线依赖审计通过 | 原重复版本警告保留，未重新升级依赖锁 |
| `output-drain-native-final.log` | 29/32，438.543 秒 | 原有 27 项全部通过；新双流和 4 秒 deadline 通过；idle、cancel、cap 失败 |
| `output-drain-cancel-recheck.log` | cancel 1/1，整体 37.121 秒 | 首轮失败在服务启动事件等待，实际取消 case 未开始；同源码和参数重跑通过 |
| `output-drain-idle-limit-recheck.log` | 1/2 | cap 在 211.956 秒通过；旧 idle 夹具仍失败 |
| `output-drain-idle-native-handles.log` | idle 1/1，整体 17.484 秒 | 显式设置继承的标准句柄后，真实父子输出、unknown 与后代清理均通过 |

原 2.4 MiB 输出分页在 27 项原测试中通过，耗时 68.177 秒。双流各 32768 字节完整且保持 exitCode=7；流式输出仍受原 4 秒 deadline 限制。取消 case 在输出活动期间停止原进程，原效果文件恰为 `once`，后续 `ended` 文件不存在。

18 MiB cap 负载最初给 120 秒操作预算，仅持久化 5914880 字节便正确触发 deadline，没有触及字节上限。为隔离测试共享字节上限，该 case 改为 600 秒操作预算；独立 4 秒 deadline 和 2 秒读取停滞阈值均未改变。通过运行实际保存 stdout 9437184 字节、stderr 7332096 字节，合计 16769280 字节；终态为 unknown/output_limit，原进程已消失。这里验证本地完整台账和终止，未等待全部输出远端上传。

旧 idle 夹具的 .NET ProcessStartInfo 虽继承句柄，却没有显式绑定子进程标准句柄，缺少真实 child-started 输出。新 `tests/output-drain-descendant.ps1` 使用 CreateProcessW 和 STARTF_USESTDHANDLES，明确绑定原标准句柄；它仍在原 Job 中。成功运行观察到 parent-exiting 和 child-started，exitCode=0、outputComplete=false、后代死亡且延迟效果未发生。早期失败日志保留，不将其记为通过。

32 个身份由原 27 项和新 5 项组成。双流、deadline、cancel 的最终函数与成功运行一致；cap 成功源码副本为 `work/output-drain/native-cases-v2.ts`，当前只改变了独立 idle 夹具；idle 使用最终源码新鲜运行。独立复核已核对源码等价桥、32 身份并集无缺失，以及[103 项清单](output-drain-20261102.json)的大小与哈希。清单覆盖成功 case 产物、背压原帧、源码/二进制和保留的失败日志；原失败目录仍保留，但其全部文件没有纳入该版清单。

## 验收边界与接续

独立 reviewer `/root/reach_plan_review` 已接受修复设计、Rust 源码、受控背压和组合运行。其逐行核对实际台账，确认身份、序号、单一终态及终态后无输出。主代理以 `work/output-drain/audit-evidence.py` 再查五个成功 case 的 SQLite/WAL、两流实际字节、收据投影和效果文件，并逐帧重读旧/新背压原始 stdout。103 项清单 SHA256 为 `5d684d5bf22708b40dce47bc0717936e643b6f90e5d498aaae6134a6b871a49f`。进程死亡断言来自重启前的执行，不将 11 月 3 日主机重启当作清理证据。

新 Node-only 安装候选已生成：`outputs/windows-node-5029a53f90e50384/Reach-Node-Setup-0.1.0-preview-bb7709390cdb14a8.exe`，SHA256 `bb7709390cdb14a8707f1bec905e1b07384370987837517fcbecb70f0a4a04e2`。`--inspect` 核对内嵌 Node 为上述 5029a53f 版本，脚本/许可哈希匹配；安装器与 Node 的十档图标逐帧与原 ICO 相同。构建日志为 `output-drain-installer-build.log`，图标收据为 `output-drain-{installer,node}-icon.json`。这次打包记录晚于 103 项清单，单独保存于制品目录的 `package.json`。旧 9b721f7c 候选保留，不能作为修复版。

新包仍未签名、未安装、不含桌面运行时。UAC、真实 SYSTEM/SCM、完整便携桌面运行时、真实模型与 Ray 新版部署均不由本点测试证明。全任务清单保持开放。
