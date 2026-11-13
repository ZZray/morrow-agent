# Reach Desk 关闭与恢复：本地接续

作者：Ray Zhang（Ray）。日期：2026-11-03。

**只做本地开发和测试，禁止SSH、服务器读取、远端模型探测及部署，等待用户明确恢复。** 服务器将关机备案。完整首版目标仍有效，基础0/52、Desk0/5；不要停止本地工作，也不要把当前机制点当完整交付。

仓库 E:/repos/ara，dev、HEAD90f2b1c加大量保留WIP。不要套用Lumen的分支/TS-only/推送规则，不提交或推送。用户没有报告UAC结果，不重复安装请求；现代Reach图标已完成，不重做。完整安装候选仍60a6，18912是之前已停的故障代理。

## 已完成固定点

[本地关闭证据](../evidence/desk-close-20261103.md)和[独立报告](../evidence/desk-close-review-20261103.md)记录共享Harness→JSONL→Node SDK关闭链路。当前Desk Host/Store/页面完全尚未接此入口，UI blocked仍单调true，停止后仍不能原会话续聊。旧[UI交接](2026-11-03-desk-ui-local.md)保留五组Chrome固定点，不重跑未改页面来冒充新接线验收。

当前127来源清单 sourceIdentity=`ad376ab5303c1f4f99bdae72586ce716f0dfc1ee9087f76d494b22125fbc00ef`，work/desk-close-source-inputs-r8.json；副本 work/desk-close-source-b1e75466-2295-4c2e-9154-b7df13201b7c。最终[输入与原件清单](../evidence/desk-close-inputs-20261103.json)SHA02942b3a1686d88bc39b9605dce32cce13791f4a0978405bf3bf1fc473e75b65，127源/21EXE副本/237原件；报告/主证据/交接另外核查，避免摘要环。

源码入口：crates/ara-agent-lite-harness/src/close.rs（d0d829746f8ec355b98ef022bcdf97b487ea70e26aa6c1ef85c6305ee03742d4）；crates/ara-agent-lite-jsonl/src/close.rs（0859ebb5c55de6aca0dc99553e86a546512ba42274338cab7af7cf4817bec534）；clients/node/close.mjs（70f17b75a2c1b9c95cf70cc13cfc4e3a1dc3281264aaccfdf4d35b556f817b17）。client.mjs仅加动态closeTask导出，旧start逻辑未改。原client断线测试改为entered屏障及aborted-aware等待，原超时/结果断言保留。

新普通sidecar在 E:/usr/var/cache/rust-target/reach-static/x86_64-pc-windows-msvc/debug/ara-agent-lite-jsonl.exe，23147520bytes，SHA8888878cf51bafb40b28c33e9c2662fd9e072f11e72f4b4c693b3af969244bb0。旧9684d...是历史版本，不能再当当前cache EXE。没有更新服务器或安装包。

当前验证：Harness17/17、83.26s；JSONL12/12；Node旧start/resume14/14；新close协议fixture6/6（不是Core验收）；Node24.21.0和Bun1.4.3分别运行同一真实sidecar探针，七个场景全过。当前lib/tests Clippy、JSONL全部目标/特性Clippy、两包fmt、doc0均通过。离线deny两图四项通过，数据库未刷新。

旧完整Harness r2矩阵78/78通过，三个重I/O属性完整跑完，日志 desk-close-all-targets-r2.log。它是r6/12ac来源，不能称最终全部新鲜运行。r6/r8交集仅README/close.rs/resume.rs不同；独立报告接受17当前＋62来源桥接＝79不同函数，不是79全重跑。完整Harness Clippy仍有未改examples/capability/process.rs:28 chunks_exact_to_as_chunks，完整bootstrap旧坏链接仍失败，不宣称全仓全绿。所有失败原件保留。

真实Node原件 work/desk-close-jsonl-b49a3820-e122-473e-8c6e-15e6402cdd25；Bun原件 work/desk-close-jsonl-3ccbec9e-cdd4-477d-b1f7-ec86d01a49ef。各只有2个loopback模型请求和0外部tool callbacks。stale依据/错call IDs/无关refs拒绝不留marker；released.staged目录冲突真正越过fence删除后进程正常exit2，再用原声明新进程恢复；同Session下一Task的实际请求含旧回答；旧close重复不动新fence。不是SIGKILL/掉电试验。当前三子PID Harness原件 work/native-close-FLIkOn。

## 必须保留的关闭合同

CloseRequest独立于Run/model，原Task过期/预算耗尽可关闭，不退预算、不启动Run，不改原Cancelled/Unknown和task_accepted=false。要求启用time driver的Tokio；无runtime在任何关闭发布前Err。独立attempt deadline不进入不可变声明。

同Session锁下构造真实review→同步只读check_close→request/index/marker→真正settlement回调(join)→prepared→Core证明→committed→精确旧fence删除→released→marker删除。所有resume前驱admission/消费核对，缺原生状态/准入原件拒绝，关闭目录不得误用任一原证据目录。重复prepared/released用原review做预检，不读新Task journal/fence；NoFence本身不证明成功。

JSONL先按kind分流，在Start/token/MCP前。Host声明含规范化request除closure_id字段、expected review除request依据、完整Settled receipt、实际证据refs；receipt.evidence逐项等于refs路径。文件读一次验SHA并解析，byteSHA派生jsonl-close-H，所有重试复用原字节；路径先独立选定不能依赖H。原Unknown历史保留，新结算必须Settled。预检核完整review及精确pending call ID列表，错误声明在任何关闭发布前返回；不能把真正effectful reconcile提前到marker之前。

Node closeTask等待真实process close，唯一完整终帧/exit0/固定root released lexical+realpath/三段SHA/完整request、review、receipt、原outcome和消耗通过才validated。管道故障保守unknown，不重投旧Task/新Session。Hash不是认证；Host证据文件必须不可变。

Core Journal head提交前未确认尾部仍拒绝读取，不能截断/删pending。自动恢复只覆盖已有可验证提交后的checkpoint/外层发布失败。Unix目录同步只静态复核，Windows目录helper no-op。JSONL探针只NativeAlreadyClosed；pending/真实cancel/checkpoint/跨resume等由Harness17覆盖，不说全部经JSONL验证。

## 下一步：接入真正Desk

1. 读platform/src/host.ts/store.ts/events.ts/web.ts与旧UI交接，沿现有同Cookie/CSRF/User归属和原Session实现，默认基础包保持无平台/无模型依赖。
2. 原Task入场保存可核的execution profile（实际binary SHA、已提交start hash、实际能力/事件/回执来源）。自动结算要求原process和callback实际结束、无native pending/unknownEffect/未支持GoalJob，并证明过去没有外部执行；不能仅看当前config.tools=[]或callback计数0。已有未知/崩溃状态无法证明则保留blocked，不清fence。
3. 仅正常取消且上述证据充分时，保存Host结算原件/不可变声明，调用SDK closeTask；丢终态或发布失败只重试原声明和新operationDirectory，不生成新声明/Task来假装恢复。从原fence/head取Windows canonical路径，原Task task.json evidence_dir用fence规范值；probe脚本有可运行例子。不再读旧模型token。
4. SQLite增加blockerTaskId/settlementRevision或等效版本；只有匹配当前blocker的有效closure才解锁。UI三处单调blocked=true须换为版本比较，避免旧false解新锁、旧true重新锁住已释放会话。旧数据库保守迁移；登录/会话切换保护沿原逻辑，用户下一条消息才新Task并用原Session。
5. 停止状态仍Cancelled/Unknown，不能改completed；草稿/partial原事件仍保留。退出后的旧用户结算不能更新新登录视图。同步真实Chrome stop→settle→continue、刷新、旧SSE晚到、重复POST、丢终态同声明恢复，基础无平台回归。
6. 再继续设备目标/Reach工具、Node Host、委托、产品源/完整首版其余事项。安装真实SCM/SYSTEM/UAC/干净机仍开放；不重复UAC提问。远端恢复前不探模型、不部署。

独立复核复用/root/reach_plan_review，不另起重复reviewer。一次一个Cargo，缓存E:/usr，work中间证据，outputs交付。此固定点完成时无构建/测试/模型/SSH会话在跑；旧exec74630已exit0并收割，不再等待或重跑其长矩阵。

主代理最终直接核对：127项当前来源及127项快照、237原件和21个原EXE/副本摘要全部匹配；Node/Bun声明与request/prepared/committed/released、各10项原Task文件、两个实际模型请求及新fence均回查通过。7文档137本地链接通过，diff-check通过。最终检查为work/desk-close-final-check.json；全仓work/desk-close-bootstrap-final.log仍exit1（既有绝对D:/C:/归档坏链接），不称全仓通过。两份最终检查在冻结清单外单列。独立报告最终SHA66562b7cc2550b999f43408cb15fc5d371a994676669abd6116f472847308d58，主代理已完整回读（含Bun补验）并接受限定结论；当前无构建/测试/模型/SSH会话。
