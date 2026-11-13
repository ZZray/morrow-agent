# 现场委托组织模型通道：本地分项证据

作者：Ray Zhang（Ray）。日期：2026-11-04。范围：Reach服务端模型broker、共享Run/调用预占及固定Rust侧车的本机文件链路。仅本地，未访问服务器或远端模型，未部署、安装、提交或推送。

服务已能保管组织模型配置，以原Node身份、父dispatch/epoch及固定路由接收有界SSE请求。原请求占用一次预算，断流与未知不重发。**生产Rust Node委托Host和本机relay仍未实现**；真实侧车串联中的relay和父子生命周期适配器由测试提供，不能称完整R01/R02/R03完成。基础仍0/52，Desk仍0/5。

## 交付范围与固定输入

仓库 `E:/repos/ara`，dev，HEAD `90f2b1cdd138129e2d331d89a37d70852e849739` 加原WIP。合同见[现场委托](../agent-delegation.md)。

- `agent-model-store.ts` 实现固定路由、共享Run和模型调用原子预占；schema v3新增 `agent_runs`、`agent_task_models` 和 `agent_model_calls`，从v2回填已有子调用Run。原operations/events/dispatch保留。
- `agent-model.ts` 实现可选组织配置、路由HMAC、32 MiB请求/8 MiB响应/2 MiB帧与待核缓冲、严格UTF-8、SSE及背压。只向固定 `/v1/chat/completions` 发送组织Bearer，不透传Node身份、Cookie、上游错误正文或响应头。
- `store.ts`、`agent-calls.ts` 将模型记录纳入父成功、对账、共享Run和同Session检查。reserved/streaming/unknown阻止新模型调用、新工具和成功；已有模型预占不能声明未执行。
- `server.ts` 新增Node模型元数据、父路由绑定和流请求入口；`main.ts` 读取后删除组织密钥环境项，停服先中断并等待模型流，再关闭数据库。默认Reach不要求模型或Desk。

冻结 `work/agent-model-20261104/inputs-r1.json` SHA `266e4067aabbcdd8feedb13961eba6fc732575fac7203fbb8983f7b57ba8640a`：157个选定源/副本用于依赖身份核对，语义复核仅其中12个目标文件，2个既有运行镜像。固定rpi参考为 `8ec4626/crates/rpi-ai/src/providers/openai_completions.rs`，其文件SHA也在清单中；不是重新验收157个文件。

本轮未改Rust、依赖或锁文件，未重新构建/打包。侧车仍为0275185113786a971fad17307c4cefcd0de4d2c0666bcb857d9cc20b2e26a344，普通Node/worker为69b14cfebbff4dd63fe755bd870afe5d83e469fb25f5eb260a432c5dc4231727。无UI变动，不重跑无变化的浏览器/截图/Cargo全矩阵；它们不是本点验收证据。

## 执行结果

命令从 `apps/reach/` 运行，测试全部指向本机loopback。配置能力来源为组织声明，未探测真实 `/models`。

| 检查 | 实际结果 | 原件与边界 |
|---|---|---|
| `tsc.exe --noEmit`、admin与platform类型组 | 最终通过，无输出 | 当前冻结源码；无UI构建 |
| `node --test --test-concurrency=1 tests/agent-model.test.ts` | r2为15/15，86.691s | `work/agent-model-r2.log`；随后只追加默认无模型测试，没有修改原15函数或生产代码 |
| 默认Reach无模型HTTP测试 | 1/1，1.116s | `work/agent-model-default-r1.log`；Node认证保留、configured:false、绑定返回明确503 |
| 真实Rust侧车和普通Rust文件worker串联 | r4为1/1，15.803s | `work/agent-model-native-r4.log`；3模型请求、2worker、两个原child，测试relay/lifecycle |
| 原服务、进程重启与父子合同回归 | 19/19，30.792s | `work/agent-model-regression-r1.log`；后续guard修补不影响默认无模型路径，v1夹具修改另单测 |
| v1迁移结构夹具最终版本 | 1/1，3.014s | `work/agent-model-migration-r2.log`；不重复计入19个原函数 |
| 普通真实Node配对/唯一owner/命令流/文件效果 | 1/1，12.002s | `work/agent-model-node-r1.log`；使用旧Node镜像，不声明委托能力 |

16个模型合同函数覆盖配置、实时首delta、请求去重/Run预算、身份与输出字段、错误/UTF-8/半帧/回显、CR/EOF/DONE、thinking及工具参数解码、usage、32 MiB请求/半上传取消、终态落库失败、父取消/解绑/deadline/断客/停服、帧/响应上限、真实背压、重开/凭据变化及v2回填。

首delta门闩在客户端收到“先看到这段”后才让上游结束；当时账本仍streaming，父成功被拒绝。finish_reason=length被原样保存，用量11/7/18，Task仍running；缺失usage保留null。DONE后保持上游连接的场景仍能结束，干净finish+CR/EOF也能完整结算。

慢客户端实际暂停读取，并观察Reach `ServerResponse.writableNeedDrain=true`，缓冲24252B超过16384B高水位；取消176ms、停服85ms内退出并中断上游，原调用unknown。不是仅创建一个“慢客户端”便假定发生了背压。

主代理用 `work/agent-model-20261104/check.mjs` 回查35个最终合同场景的实际SQLite：34次模型预占，9个stream_complete、24个unknown及1个模拟崩溃后保留reserved。检查原件和镜像、父/子原dispatch、完整事件及实际文件；不以asserted JSON代替数据库。

## 真实侧车与文件效果

最终根目录 `work/agent-model-4795afc0-420c-43c9-9ea4-48906870b01c`。普通027侧车通过测试本机relay调用真正的Reach broker，再到受控上游：

1. 模型请求原生 `write-once`，服务建立独立child dispatch，普通 `reach.exe worker` 写入 `effect.txt`。
2. 回传原工具收据后，第二次模型请求发出 `read-original`；另一个普通worker读取原文件。
3. 第三次模型请求收到原call ID和原内容，返回 `Original file read and verified.`；Harness停止于 `AwaitingHostAcceptance`，`task_accepted:false`，fence释放。

实际文件字节为 `once\n`，SHA `ad06e72726f6d8ff00228160453949c1ceb89571c99332e4815f9edce2acad07`。两个child各有received/running/succeeded与独立dispatch，模型账本3个stream_complete；worker均退出。最终父结果引用两个child并保留taskAccepted:false。Tool参数摘要与JSONL回调依据一致；这是侧车回调的序列化参数，不声称保存了模型原始arguments文本的排版。

本测试没有执行生产Node的Ledger.accept/outbox/委托Host，不能代替下一步真实Node两次文件/命令或两次截图。普通Node另外的FPYDku回归使用真实原outbox，实际“新内容”与硬链接一致；5个操作状态为succeeded/succeeded/failed/succeeded/succeeded，5个保留的服务/进程PID均已退出。

## 失败保留与独立复核

早期r1的11合同函数通过，但没有覆盖后来独立发现的三类回显路径，因此不作为最终安全结论。独立reviewer `/root/reach_plan_review` 复现了SSE注释、thinking别名与工具参数第二层JSON解码的回显；修补后仅重建已检查data帧、按固定rpi思考流语义拼接，工具参数缓冲至完整JSON语义检查。最终测试包含Unicode转义、跨delta和缺省tool-index反例。待核缓冲有2 MiB硬上限，不承诺检测任意额外编码。

`agent-model-native-r1.log`、r2分别保留1/1失败：夹具错误使用提交时的claimed_at=null，以及预建Harness要求全新的evidence目录；均在模型接触前被拒绝，没有文件效果。r3通过后，因guard修补再执行r4。`agent-model-expanded-r1.log`的5函数是中间修补证据，不累计成额外功能数。

独立最终报告为 `work/agent-model-independent-review-20261104.md`，SHA `ce3b4117676c7e519d9176d90cb99a858f738cb341af186560fc6495c8ae46e8`，结果JSON SHA `87486dcf8c78b959e0894f6f60e5871175efe6188f8fc3d440a43385939683c2`。它独立重放4个最小反例并只接受本地broker/共享预算边界，不接受完整R01/R02/R03/R07或生产发布。主代理已完整回读报告，检查结果保存在 `work/agent-model-20261104/checked-r1.json`，SHA `4a78660837dcfa9aa58fee0fa681047669c8f416f6722de9e081d3ae0916045a`。五文档106个本地链接和12个源/配置/测试文件空白检查通过，仓库根diff检查通过；没有宣称全仓链接检查通过。humanizer未找到，已人工审读。

## 仍需完成

Rust Node委托Host、本机固定端口/token的relay、父running ACK后启动、真实child Ledger/outbox接线、累计输出/产物预算和全阶段取消监督仍待实施。模型unknown的显式核对/恢复API、同Task恢复与剩余预算也未完成。真实组织模型及视觉能力、默认完整上下文、安装/SCM/SYSTEM/锁屏、完整历史迁移和部署仍未验收；当前远端访问限制继续生效。
