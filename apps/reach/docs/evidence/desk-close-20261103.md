# Reach Task 关闭与原会话接续：本地机制证据

作者：Ray Zhang（Ray）。日期：2026-11-03。命名空间：RY。

**共享 Harness → JSONL → Node SDK 的关闭与恢复链路已在本地通过验证和独立复核；Reach Desk 的 HTTP/数据库/页面尚未接入。** 这一步不关闭 X02，不代表页面已经支持停止后继续对话。完整基础验收仍为 0/52、Desk 仍为 0/5。

用户要求服务器关机备案、先本地测试。本点没有 SSH、服务器读取、远端模型调用、部署、安装、提交或推送。原生产发布快照不作为当前运行证明；图标和 60a6 完整安装候选没有更新。

## 来源与交付对象

仓库 `E:/repos/ara`，分支 dev，HEAD `90f2b1cdd138129e2d331d89a37d70852e849739` 加保留的既有工作区。Core 源码没有改动；新逻辑位于共享 Harness 的 close.rs、storage/runner/lib 的必要接线、JSONL 首帧分流及 close.rs、Node closeTask 客户端和对应测试/探针。没有复制 Agent loop，也没有引入 Reach 身份或设备状态到 Core。

[最终输入与原件清单](desk-close-inputs-20261103.json)固定 127 项来源、21 个 EXE 副本和 237 个原件；SHA256 为 `02942b3a1686d88bc39b9605dce32cce13791f4a0978405bf3bf1fc473e75b65`。sourceIdentity 为 `ad376ab5303c1f4f99bdae72586ce716f0dfc1ee9087f76d494b22125fbc00ef`，对应 [r8 输入](../../work/desk-close-source-inputs-r8.json)，源码副本为 `work/desk-close-source-b1e75466-2295-4c2e-9154-b7df13201b7c`。主证据、独立报告和交接另行核对，避免摘要自引用。

| 对象 | SHA256 |
|---|---|
| Harness close.rs | d0d829746f8ec355b98ef022bcdf97b487ea70e26aa6c1ef85c6305ee03742d4 |
| JSONL close.rs | 0859ebb5c55de6aca0dc99553e86a546512ba42274338cab7af7cf4817bec534 |
| Node close.mjs | 70f17b75a2c1b9c95cf70cc13cfc4e3a1dc3281264aaccfdf4d35b556f817b17 |
| 普通 sidecar EXE | 8888878cf51bafb40b28c33e9c2662fd9e072f11e72f4b4c693b3af969244bb0 |

普通 EXE 位于 `E:/usr/var/cache/rust-target/reach-static/x86_64-pc-windows-msvc/debug/ara-agent-lite-jsonl.exe`，23,147,520 bytes。[独立报告](desk-close-review-20261103.md)由 `/root/reach_plan_review` 读取实际源码及原件、重算摘要后编写；主代理也完整回读并核重要状态。报告范围、来源桥接和未覆盖项不扩成全产品验收。

## 实现合同

`close_task(CloseRequest, CloseHost, deadline)` 独立于 RunRequest 和模型配置，不启动 Run、不执行模型或工具，不延长旧 Task、不退还旧消耗。原 Task 过期或预算耗尽仍可核对关闭；当前用户身份及 Task 归属由 Host 负责，authority SHA 仅引用原入场声明。调用须使用启用时间驱动的 Tokio；没有运行时时在任何关闭发布前返回错误。

同一 Session 锁内，先构造真实 review 并执行同步只读 `check_close`，再发布 request/index/closing marker。预检不能产生效果；错误依据不会占用关闭身份。真正结算回调仍在 marker 后，必须保存实际证据、明确 Settled，并响应取消且完成 join。空 open calls 不代表效果已结算。

全部 resume 前驱的 admission 与消耗逐一核对。正消耗但没有原 Session/Journal、缺原 admission、pending 不属原 Task，或关闭目录误用任一原证据目录时拒绝。零 Run 须原 joined 零消耗 outcome。原生已闭合核原 Run 索引及不变的 Journal；原生 pending 按 Host 回执闭合准确调用，验证 prefix proof、提交代次、reconciliation 来源和每条新增 ToolResult。

事务顺序为 prepared → 原生闭合证明 → committed → 精确旧 fence 释放 → released → 自己的 marker 删除。普通 start/resume 在 marker 存在时拒绝。记录原子发布并补目录同步；同一 Session/closure ID 永久绑定同请求。重复结果按完整 request/prepared/committed 重建，不读取后来 Task 的 Journal/fence；旧 outcome、Cancelled/Unknown、原消耗和 task_accepted=false 保留。下一条用户消息才创建新 Task，继续使用原 Session。

JSONL 的 close_task 首帧在 Start、模型 token 和 MCP 准备前分流。Host 先固定不可变声明，包含完整原条款、expected review、已提交的 Settled 回执和实际证据 SHA refs；receipt.evidence 与 refs 路径逐项对应。声明字节 SHA 派生 closure ID，没有自引用路径。一次读取字节同时验 SHA 与解析；每次（含 prepared/released 重试）都核声明、refs 和完整回执。新的结算必须 Settled，旧 Task 的 Unknown/Cancelled 历史不改写。

Node closeTask 不接收/传递模型密钥。等实际子进程关闭、唯一完整终帧和 exit 0 后，核固定根 released.json 的 lexical/real 身份、完整 request/review/receipt、三段 SHA 与原 outcome/消耗；stdout/stderr 错误保守记录 unknown。丢失终态只能查询或重试原声明，不重投旧 Task，也不新建 Session。声明内容哈希不是身份授权。

## 执行矩阵

Windows、Rust1.98.1、x86_64-pc-windows-msvc、静态 CRT，单 Cargo 编译，缓存 E:/usr。Node24.21.0、Bun1.4.3。全部模型响应来自受控 loopback HTTP，未使用远端模型。

| 命令或入口 | 实际结果 | 边界 |
|---|---|---|
| [当前 Harness resume r8](../../work/desk-close-resume-r8.log) | 17/17，0 ignored，编译6.62s、执行83.26s | 当前源码，7组原resume＋10组close |
| [旧全目标 r2](../../work/desk-close-all-targets-r2.log) | 78/78、0 failed/ignored，完整属性循环结束 | 12ac/r6来源，不称最终全量重跑 |
| [JSONL all-targets](../../work/desk-close-jsonl-tests-r1.log) | 12/12、3.20s | 当前JSONL单元/协议测试 |
| [当前 Harness lib/tests Clippy](../../work/desk-close-clippy-scoped-r8.log) | exit0，-D warnings | 不含既有告警示例 |
| [JSONL workspace/all-targets/all-features Clippy](../../work/desk-close-jsonl-clippy-r1.log) | exit0，-D warnings | 当前JSONL包 |
| [Harness fmt](../../work/desk-close-fmt-harness.log)、[JSONL fmt](../../work/desk-close-fmt-jsonl.log) | exit0 | --all --check |
| [Harness doc](../../work/desk-close-doc-harness.log)、[JSONL doc](../../work/desk-close-doc-jsonl.log) | exit0，均0测试 | 不计行为覆盖 |
| [原Node start/resume](../../work/desk-close-node-regression-r2.log) | 14/14，13.460s | 协议fixture回归 |
| [新Node close](../../work/desk-close-node-sdk-fixture-r1.log) | 6/6，5.133s | fixture子进程，不代表Core结算 |
| [Node实际sidecar探针](../../work/desk-close-native-r1.log) | exit0、7场景通过 | 普通EXE，真实Core/Journal |
| [Bun实际sidecar探针](../../work/desk-close-native-bun-r1.log) | exit0、相同7场景通过 | 产品所用JS运行时，仍非DeskHTTP/UI |
| [Harness离线依赖](../../work/desk-close-deny-offline-r2.log)、[JSONL离线依赖](../../work/desk-close-jsonl-deny-offline.log) | 四项通过 | Core既有deny.toml/锁文件；数据库缓存未刷新 |

完整 Harness Clippy 的 [r1失败](../../work/desk-close-clippy-r1.log)仍保留：未改示例 examples/capability/process.rs:28 的 chunks_exact_to_as_chunks，未降级警告或改无关文件，不能写成全目标Clippy全绿。离线审计首次找不到cargo.cmd子进程；本次PATH前置已有cargo.exe后通过，未装工具或改全局环境。

[来源比较](../../work/desk-close-source-comparison.json)显示 r6/r8 共同来源只有 README、close.rs、resume.rs 改动。旧16个resume函数由当前17个替换，另外62个函数的测试来源和原有路径未变且不调用close；本点是 **17当前执行＋62明确来源桥接＝79不同函数**，不是79个都在最终版本重跑。独立复核核过这项差异；共享Core和原start/resume实现来源相同。JSONL及两套JS实际探针为当前代码额外执行证据。

## 实际进程与原件

[Node原件](../../work/desk-close-jsonl-b49a3820-e122-473e-8c6e-15e6402cdd25/probe-result.json)与[Bun原件](../../work/desk-close-jsonl-3ccbec9e-cdd4-477d-b1f7-ec86d01a49ef/probe-result.json)均保留绝对引用有效的完整目录。

1. 第一 Task 通过普通sidecar和真实Core取得回答，Host原review明确Unknown，留下原 fence 和 ReconciliationRequired。原进程及回调实际结束，原生pending/Goal均空。
2. 错消费量、错调用ID、证据引用不对应，原生关闭进程拒绝且不写index/marker/prepared，原fence字节不变。错调用ID确实进入共享预检，并非只靠JSON反序列化失败。
3. released.staged 的真实目录冲突阻止回执发布，已越过原fence删除；committed存在，marker保留，SDK记录unknown。移除仅用于故障注入的目录后，用同一声明及新进程恢复，不手动改marker/fence。
4. 第二Task使用同一原生Session；实际第二条模型请求包含第一回答。旧关闭再由新进程查询，返回相同结果，第二Task新fence字节不变。

每套探针只有2个loopback模型请求、0外部tool callback。关闭进程没有模型token；Host原件和探针都固定普通EXE SHA。Node关闭PID9684（exit2）、23404/25136（exit0）；三段摘要链、10项原Task文件、Hostrefs、原/新结果和新fence由独立复核回查。Bun原件单列，不能当作另一个模型任务计数的Node重复。

当前 Harness 三独立PID原件另在 [native-close-FLIkOn](../../work/native-close-FLIkOn/processes.jsonl)。真实Cancelled回调join、原生pending调用、expired/budget耗尽、缺原件/缺admission、原checkpoint发布失败后journal提交恢复、跨resume累计2runs/4calls、无Tokio、只读预检拒绝与前驱目录拒绝由17组验证。JSONL实际探针走NativeAlreadyClosed，不能把这些Harness分支全写成JSONL也逐一实测。

## 失败保留及限制

r1/r2/r4/r5和第一全目标、第一Node回归日志均在冻结清单。旧crash fixture原先在shutdown_timeout(0)返回后未等实际锁释放，现有界核实际锁；过短deadline碰到秒数取整/I/O，最终单调用并实际等过原10秒期限；原生fixture重复native call ID已修为不同ID且核两条候选；Arc候选移动的测试编译错误改为借用。r6的keep must_use已显式丢弃并以当前构建/Clippy复测。

Node断线fixture原60ms退出可能先于callback安装abort监听，现先装已aborted-aware等待、写entered再让子进程断连；原5秒、1次、unknown/joined/原件保留和Token不泄漏断言未放宽。它验证进行中断连，不冒充回调尚未开始时的所有情况。

Host仍负责身份、归属及证据真实性；哈希只证明内容。预检必须只读，关闭future不能被丢弃而宣称已join。Journal在head提交前有未确认尾部仍拒绝读取，不截断、不删除pending。支持补完的窗口是已有可验证Journal提交后checkpoint/外层回执失败。

Windows目录同步helper为no-op；Unix顺序只做静态复核，没有Linux掉电实测。此处发布错误后的进程正常结束/另一PID恢复，不是SIGKILL或整机断电。SDK所有OS管道错误、spawn/强制超时组合未逐一注入。

下一步是把已验证SDK接到Desk Host，保存原profile/join证据、仅对匹配blockerTaskId的有效关闭增加settlementRevision并解锁，再做真实Chrome stop→settle→同Session新Task及旧SSE晚到。真实模型多轮、设备/Node工具、SCM/SYSTEM/UAC安装、Ray长流/上线仍开放。按用户要求继续本地，远端恢复前不取模型凭据或部署。

主代理最终直接核对：127项当前来源及127项快照、237原件和21个原EXE/副本摘要全部匹配；Node/Bun声明与request/prepared/committed/released、各10项原Task文件、两个实际模型请求及新fence均回查通过。7文档137本地链接通过，diff-check通过。最终检查为work/desk-close-final-check.json；全仓work/desk-close-bootstrap-final.log仍exit1（既有绝对D:/C:/归档坏链接），不称全仓通过。两份最终检查在冻结清单外单列。独立报告最终SHA66562b7cc2550b999f43408cb15fc5d371a994676669abd6116f472847308d58，主代理已完整回读（含Bun补验）并接受限定结论；当前无构建/测试/模型/SSH会话。
