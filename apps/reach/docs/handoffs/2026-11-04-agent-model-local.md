# Reach 本地接续：组织模型流式通道

作者：Ray Zhang（Ray）。日期：2026-11-04。

继续完整清单/原goal，本轮是progress：服务端组织模型broker已实现并完成本地分项验证。基础仍0/52、Desk0/5。用户最新限制继续优先：**只本地，不SSH、不访问服务器、不探测远端模型、不部署、不安装、不提交/推送、不清理原WIP**。仓库 `E:/repos/ara`、dev、HEAD `90f2b1c`；不要套用Lumen的分支/TS-only规则。不再询问旧安装器UAC；18912旧代理仍关闭。

当前权威[合同](../agent-delegation.md)及[本轮证据](../evidence/agent-model-20261104.md)。先前父子合同保留在[原交接](2026-11-04-agent-calls-local.md)，不要重跑无变化大矩阵。普通Rust Node仍不声明agent.delegate，**生产委托Host与本机relay尚未接通**。

## 本轮完成

新 `src/service/agent-model.ts` 及 `agent-model-store.ts`；Store schema v3新增共享Run、固定路由与模型预占。v2回填agent_calls的Run，原operations/events/dispatch不变。Node GET模型元数据、POST父model/route、POST父model/requests/:UUID已接HTTP。配置全空时不加载模型，部分配置缺失拒绝启动；能力来源明确organization-config，不探测远端。

模型密钥只在服务内，读取后删除环境项；Node不收到组织URL/密钥。路由HMAC绑定endpoint/model/能力/凭据身份；配置变化旧Task拒绝。每请求事务占一次maxCalls，模型和工具共享maxRuns；重复ID零上游重发、参数变化冲突，reserved/streaming/unknown不退还预算且阻止新模型/工具/父成功/同Session新委托。模型记录不存prompt。流完整仍不代表Task接受。

专用SSE支持32 MiB请求、8 MiB响应、2 MiB帧与待核缓冲，UTF-8、LF/CRLF/CR、finish后usage、DONE后连接保持及明确finish+干净EOF。首正常文本delta实时通过；工具参数帧缓冲至终态，按第二层JSON解码检查。取消/解绑/父终态/deadline/断客/停服覆盖上传、fetch、读取、drain；停服先abort/await活流再关Store。普通Node Api.call的12秒/2 MiB/JSON不用于SSE。

独立复核曾复现注释/思考别名/工具参数二次解码的密钥回显；已修补并重测。未知模型记录目前没有显式核对API，仍按unknown保留；不能通过退预算、换Task或换Session绕过。

## 固定版本与验证

冻结 `work/agent-model-20261104/inputs-r1.json` SHA `266e4067aabbcdd8feedb13961eba6fc732575fac7203fbb8983f7b57ba8640a`，157源/副本仅作身份覆盖，语义范围12文件，2旧镜像。没有Rust/依赖/锁文件改动或重建，侧车0275185、Node69b14c不变。固定rpi参考8ec4626只读，不在Cargo缓存修改。

- `work/agent-model-r2.log`15/15、86.691s；随后只追加默认无模型HTTP函数，`agent-model-default-r1.log`1/1；16合同函数分层列出，不声称同一批执行16。
- `agent-model-native-r4.log`1/1、15.803s；根 `work/agent-model-4795afc0-420c-43c9-9ea4-48906870b01c`：真实普通侧车3模型请求、2普通Rust文件worker、两个独立child，实际once换行文件，原生Task AwaitingHostAcceptance且task_accepted:false。**relay/父子生命周期适配器是测试夹具，没有真实Node Ledger/outbox的委托接线**。
- `agent-model-regression-r1.log`19/19、30.792s；后续仅guard及v1夹具变化，最终v1结构另跑 `agent-model-migration-r2.log`1/1、3.014s，不重复计原函数。
- `agent-model-node-r1.log`普通真实Node1/1、12.002s；保留 `work/agent-model-20261104/native/reach-native-FPYDku`，实际文件/硬链接、原outbox，5个服务/进程PID已退出，仍无委托能力。
- 最终基础/admin/platform三组TS无输出通过。无UI变化，没有重跑截图/Chrome或完整Cargo；本轮未发安装包。

主代理 `work/agent-model-20261104/check.mjs`核35场景实际SQLite、34模型预占（9完整/24unknown/1模拟崩溃reserved）、真实背压24252B>16384B及取消176ms/停服85ms、原生Task/worker事件/文件与镜像。`checked-r1.json`留原件。早期native r1/r2的入场失败与中间窄测试日志保留，不隐藏、不重复累计。

独立reviewer继续为 `/root/reach_plan_review`，最终报告 `work/agent-model-independent-review-20261104.md` SHA `ce3b4117676c7e519d9176d90cb99a858f738cb341af186560fc6495c8ae46e8`，结果JSON SHA `87486dcf8c78b959e0894f6f60e5871175efe6188f8fc3d440a43385939683c2`。主代理完整回读并回查原件；`checked-r1.json` SHA `4a78660837dcfa9aa58fee0fa681047669c8f416f6722de9e081d3ae0916045a`。只接受本地broker/共享预算，不接受完整委托或真实组织模型。五文档106本地链接、12目标源/五文档空白及仓库根diff检查通过；全仓既有断链不在本点。humanizer未找到，人工审读。

## 下一步实施

1. Rust Node增加专用流式HTTP客户端和固定本机relay：组织密钥不下发，侧车只拿本机随机token；原Task端口/token/路由/镜像/工具/预算/deadline持久固定，原端口无法重绑就拒绝。不要借12秒Api.call，不要为传输异常加全局retry。
2. 父running回执须获服务ACK后才启动侧车。Tool回调拿真实child Dispatch，原 `Ledger.accept`、running/意图后复用worker/Desktop；子终态先落outbox再回侧车。不能替换父Dispatch、混写父子终态或截图产物索引。
3. 全程看父取消，先停止拥有的worker/Desktop真实效果，再收侧车和父；补累计输出/产物预算。实际Node先两次文件/命令，再同委托两次真实截图，不能用本轮fixture生命周期或旧seeded PNG代替。
4. R06补模型unknown显式核对和新恢复operation关联原Task/fence/剩余预算，不能重开已unknown父。R04/R05来源/技能/经验晋升及旧平台完整历史仍开放。默认Reach无Desk，LabSlot延期；真实组织模型与上线等待用户明确恢复远端访问。

所有本轮exec测试均已终态，无已知仍运行的Node/服务测试进程。继续前先核工作区，不重复已完成的调查或冻结旧版本冒充当前。
