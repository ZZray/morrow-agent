# Node 输出收尾修复：独立复核

复核日期：2026-11-03。作者：Ray Zhang（Ray）；独立复核代理：`/root/reach_plan_review`。

## 结论与范围

接受本执行点的输出收尾修复、真实背压前后对照，以及 32 个原生测试身份的组合通过证据。没有发现阻止本点验收的实现缺陷。这里的 32 是不同测试身份的并集；首轮实际结果仍为 29/32，另三项分别经补跑通过，不是一次全绿的 32/32。

本复核没有运行 Cargo、原生测试或安装程序。测试由主代理执行；本代理独立检查源码、原始帧、日志、SQLite 台账、收据和真实进程/文件效果。台账及 PID 消失核对在主机重启前完成；重启后重新核对源码与二进制哈希、测试日志及源码等价桥。主机重启本身不作为测试进程清理的证据。

本点不代表完整 T02、全部 Reach 任务、安装/UAC、真实 SYSTEM/SCM/WTS、便携 Python 桌面运行时、真实模型或新版 Ray 部署已经验收。16 MiB cap 验证本地台账和终止，不证明该批全部输出已完成远端上传；远端分页证据来自原有 2.4 MiB 测试。旧安装候选仍包含修复前 Node。

## 固定目标与源码桥

2026-11-03 重新计算的 SHA256：

| 对象 | SHA256 |
|---|---|
| `src/node/worker.rs` | `186ae9e6af328ef113790f4b03c0dde8821d3cbb9e7f972ab227ece69f7b36be` |
| `E:/usr/var/cache/rust-target/reach-static/x86_64-pc-windows-msvc/release/reach.exe` | `5029a53f90e50384c41165e72436185f6834b29bcb116c9ea8d04b4034703dc7` |
| `tests/output-drain.integration.test.ts` | `a363c2d7f22a2e5564c658d3977fcfab0533b46a1877e26e0dc482b38c3395df` |
| `work/output-drain/native-cases-v2.ts` | `833c6d705dc56d72ceef07f53b41baeff1d84e0f6e5ad6ccba1f81fd770ab116` |
| `tests/output-drain-descendant.ps1` | `41d8b09af95a6b0bbad1fff55ebf1846f25a985aec02a84dd8d32faf6991e065` |
| `tests/node.integration.test.ts` | `ffe82da388988c9de901cb14dc9be06db09cf2051848e47b7dead09d479d7082` |
| `tests/native-fixture.ts` | `cc0c3cc692ab5ffe69eda11f165e103c7b02ecd1d77e91ea840eadce947396c0` |

`git diff --no-index` 再次确认：实际 cap 成功运行的 `native-cases-v2.ts` 与当前五项测试源码只差 idle 的一行 command 构造。cap、双流、deadline、cancel 四个函数逐字相同。当前 idle 使用显式原生标准句柄夹具，并有对应的新鲜通过日志。原 27 项来源于同一份 `node.integration.test.ts`，其中 CLI/MCP 用 `/` 和 `/reach` 两次实例化，因此是 27 个运行身份。

cap 首轮与成功补跑之间只调整该 case 的操作/测试/等待预算：120000→600000、150000→650000、125000→610000 ms；没有放宽 cap 字节、终态或清理断言。独立 4 秒 deadline case、2 秒读取停滞阈值和 Rust 实现均未随补跑改变。cancel 以原源码及参数补跑。

## 实现与真实背压

读取线程仅在 `pipe.read` 正在等待时保留 `reading_since`；每次 read 返回（包括 EOF/错误）后清除。计数、编码和 `frame()` 发送/背压期间保持空值。shell 已退出至少 2 秒，且所有未完成 reader 都已连续 Reading 至少 2 秒，才判 `output_drain_stalled`；至少要有一个未完成 reader，候选停滞判定重新检查完成状态。锁不跨 I/O、发送或 join。

原两个线程、8192 字节缓冲、共享 16 MiB 输出上限，以及 Node deadline/cancel/Job 终止和清空确认均保留。已独立检查该设计与实际源码，未发现阻断问题。

受控对照 `tests/output-drain-backpressure.py` 在发送 worker 输入前将进程加入真实 Windows Job；逐字节读取 processStarted，确认 shell 退出 0 后停读 3250 ms。管道容量 4096，shell 退出时实际待取 11344 字节，少于完整 16384 字节原始输出对应的至少 21848 字节 base64，因而不是仅在消费者侧已缓存所有输出。

独立解析 `work/output-drain/backpressure-{before,after}.stdout` 与 `.json`，两个版本都还原 16384 个 `x`，SHA256 为 `1536c422c31cc98834759d7085cda394a3510a03d78188248986a6b1a7207d03`。旧版帧序为 output×3、unknown、output；新版为 output×4、succeeded，终态最后。两份最终收据均没有畸形帧，Job 活跃进程为 0。早期不足以产生背压的 4096 字节夹具、旧版截断帧失败尝试不计为通过。

## 32 个测试身份的组合证据

独立解析四份日志，在每份 `ℹ tests` 汇总之前读取结果行，排除失败详情的重复名称；首轮身份集合为 32，所有通过名称并集也为 32，缺失集合和额外集合均为空。

| 日志（本目录） | 实际结果 | 纳入组合的成功身份 |
|---|---|---|
| `output-drain-native-final.log` | 29/32；438542.9979 ms；0 skipped | 原 27 项、双流、4 秒 deadline |
| `output-drain-cancel-recheck.log` | 1/1；37120.9021 ms；0 skipped | cancel |
| `output-drain-idle-limit-recheck.log` | 1/2；227008.5835 ms；0 skipped | cap；此轮 idle 仍失败 |
| `output-drain-idle-native-handles.log` | 1/1；17483.8708 ms；0 skipped | idle |

原 27 个通过身份，按首轮日志顺序：

1. native pair, single owner, streamed command, duplicate request and file effects
2. lost pairing response retries one persisted binding; rejected expired code can be replaced
3. cancel stops actual Windows descendants and records uncertain effects
4. killed Node retains receipts and never reexecutes a command on restart
5. server claim lost before local admission becomes unknown at the original cursor
6. lost server ACK and unavailable uploads replay original events only, even after unpair
7. pending service outage recovers on the same Node process
8. lost accepted pair response followed by unpair recovers installation before new pairing
9. CLI and MCP control the same real Node and preserve request identity at /
10. CLI and MCP control the same real Node and preserve request identity at /reach
11. interrupted local running state must recover original receipts before re-pair after reconciliation
12. MCP retrieves more than 2 MiB of real output in bounded consecutive pages
13. service host waits unpaired, pairs and replaces binding through authenticated IPC without reopening the ledger
14. service host rejects pairing during execution and cooperatively stops the tree with an unknown receipt
15. service host owns pairing after IPC client disconnect and replays the durable receipt after restart
16. control pipe rejects an unexpected server PID before transmitting pairing input
17. control pipe DACL rejects a Windows user outside the configured binding identity
18. service host releases execution state after a durable journal failure and can pair after reconciliation
19. service host handles pairing after pending recovery before issuing another old-identity poll
20. service host removes unexpected explicit ACL entries from protected state and credential files
21. service host refuses a junction state path before changing the destination ACL
22. service host acknowledges stop during pending recovery and never starts a new poll
23. maintenance stop exits an unpaired host and preserves its installation across restart
24. maintenance stop waits for the pending request barrier and never issues a later poll
25. maintenance stop refuses unacknowledged receipts without stopping the host
26. maintenance stop refuses an unresolved remote unknown but accepts the original reconciliation
27. maintenance stop fails closed on remote outage and leaves the original host usable

新增 5 个身份及最终通过来源：

| 身份 | 通过来源 | 单项耗时 |
|---|---|---|
| an exited shell with inherited idle output pipes is unknown and the real descendant is reaped | idle-native-handles | 14202.231 ms |
| both output streams drain completely and preserve the command failure exit code | native-final | 9850.9838 ms |
| continuously streaming output remains bounded by the original Node deadline | native-final | 13801.4035 ms |
| cancelling a large active output stops the real process and retains the single original effect | cancel-recheck | 25096.0878 ms |
| stdout and stderr share the original 16 MiB cap and persist output_limit before remote upload completes | idle-limit-recheck | 211956.2518 ms |

原 2.4 MiB MCP 分页用例本次耗时 68176.9497 ms，原字节、哈希和连续分页断言保留。Rust 7/7、clippy/fmt 和离线 deny 是另一层检查，不能再算成 7 个输出收尾身份。

## 留存台账、收据与效果核对

以下目录均相对于 `apps/reach/work/`。SQLite 用只读连接读取，包括现存 WAL；逐行处理 outbox，没有使用忽略 WAL 的 immutable 方式，也没有将 16 MiB 内容汇总成一个数组。对有台账的 case 均验证 operation/dispatch/payload 身份、序号连续、操作最终 sequence、一份终态和终态后无 output。普通 receipt 比较事件序号/kind/data；cap 的 receipt 是汇总结构，其 `events` 为数量，另外核对最终事件、计数、字节与本地状态。

| case 目录后缀 | 独立核对结果 |
|---|---|
| `output-drain-two-streams-099245e1-2216-41d9-b970-7ae1f54b4f4c` | operation `d3fbcd97-a815-42c0-90eb-ec634f3a0eba`；29 events；stdout 32768 个 O、stderr 32768 个 E；failed/exitCode=7、processTreeStopped=true；receipt 与 DB 对应；PID 35252 消失 |
| `output-drain-deadline-a5d94b15-786f-40c8-82f6-542f12ccdc4a` | operation `62cb793c-8047-4cac-a737-b4e7f5df5c69`；timeout 4000；13 events、stdout 36；unknown/deadline_exceeded、processTreeStopped=true；receipt 对应；PID 4532 消失 |
| `output-drain-cancel-8e661b37-aa81-4800-a96b-ce9affe0602c` | operation `51712ca6-5ae1-4cae-a975-9dddaf7be8f2`；timeout 60000；36 events、stdout 216064；unknown/cancel_requested_or_control_lost、processTreeStopped=true；receipt 对应；effect.txt 恰为 once、ended.txt 不存在；PID 31716 消失 |
| `output-drain-idle-3674d128-e925-49a7-95fd-7c1be28735ee` | operation `5a1098ff-aa8c-416d-b36f-f39b0644ec2d`；7 events；stdout 恰为 child-started\r\nparent-exiting\r\n（31 字节），stderr 为 #< CLIXML\r\n（11 字节）；unknown/output_drain_stalled、exitCode=0、outputComplete=false、processTreeStopped=true；receipt 对应；ready 存在、延迟 effect 不存在；父 PID 37580、子 PID 51696 均消失 |
| `output-drain-limit-4a8387e0-cf0a-4684-91ce-51e248d4056b` | operation `39511daa-2e8a-4e6e-9eb5-d8f90bac706d`；timeout 600000；2053 events；stdout 9437184 个 O、stderr 7332096 个 E，合计 16769280，距 16 MiB 少 7936 字节；unknown/output_limit、effectsMayHaveOccurred=true、processTreeStopped=true；汇总 receipt 对应且 remoteUploadCompletionTested=false；PID 51220 消失 |

双流 stdout/stderr SHA256 分别为 `0bd547ca8bf53392d8fda2ec1d09df1202f782feeadba35fc26ea565867eb879`、`28b2b10e53ed0c4a489465c86870d558564efd814e6c7604df76a3de153259a0`。成功 cap 两流分别为 `a976302378c2c5a0958238f9fcbfdbad19cd0eb9aecbac9c8e154ec7bb4fdcdf`、`53c7dc04b89a02e46b18108a041104144f8d546b3cf98ae54c9215d4a349b9e8`。

失败证据保留，原因与补跑范围可以对应：

- `output-drain-cancel-0b2f2692-a536-496a-878c-5eb7e5876af6` 没有 Node DB/receipt；日志在 fixture 的 readyService 等待失败，尚未开始取消操作。补跑未放宽源码或参数。
- 原 idle `output-drain-idle-257e97ec-16de-41d6-b8b4-5f9322562007`、补跑旧 idle `output-drain-idle-182d3c27-1197-44bc-afca-01538d0366fd` 均只有 parent-exiting 的 16 字节 stdout、5 events；ready 文件存在但缺少 child-started 输出，因此原断言正确失败。两次均记 unknown/output_drain_stalled、exitCode=0、输出不完整且树已停止；父子 PID 消失，延迟 effect 不存在。最终夹具用 CreateProcess、STARTF_USESTDHANDLES、显式可继承的标准句柄，未要求 Job breakaway。
- 原 cap `output-drain-limit-f2999fd5-3ee0-4ad8-a29a-6328dfb55195`：operation `8abcec12-5be3-491f-aaba-ab68f9ab5712`；timeout 120000；727 events，stdout 5914880 个 O、stderr 0；unknown/deadline_exceeded、树停止、PID 48860 消失；没有成功 receipt。它证明原预算先到，不能当 cap 通过。

## Evidence manifest 核对

独立读取 `docs/evidence/output-drain-20261102.json`，逐个流式重算其中全部文件的大小和 SHA256：103 个条目、103 个唯一位置、合计 56211238 字节，无缺失、大小不符或哈希不符。清单自身 SHA256 为 `5d684d5bf22708b40dce47bc0717936e643b6f90e5d498aaae6134a6b871a49f`。五个成功 case 的事件数、两流字节、终态与 reason 全部匹配本代理的独立台账结果。

同时阅读了主代理的 `work/output-drain/audit-evidence.py`，其台账读取包含 WAL，检查终态与原始帧，并明确记录主机已重启，未把重启后的 PID 不存在作为清理证据。本代理没有执行该写清单脚本。

这份 103 项清单覆盖五个成功 case 的留存产物、前后背压原始帧/收据、源码/锁文件/构建配置/二进制以及 output-drain 日志。失败日志在清单中；原失败 cancel、两次旧 idle、原失败 cap 的各自目录内台账/文件未列入该版清单。它不是对所有失败目录产物的完整归档声明；这些原失败目录仍按上文独立核对并保留，不能删去或改记通过。

## 交接边界

`output-drain-20261102.md` 的行为、日志、失败保留和验收边界与本次复核一致。本点行为、32 身份组合证据及上述 103 项清单对应关系可以验收。新安装候选须实际包含 `5029a53f…` Node 后另行验证；本记录不能代替安装、提权、桌面会话或便携运行时验收。
