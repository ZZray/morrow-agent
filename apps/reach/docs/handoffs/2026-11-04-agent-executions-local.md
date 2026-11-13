# Reach 本地接续：原 Task 与恢复执行的服务关系

作者：Ray Zhang（Ray）。日期：2026-11-04。

继续完整首版目标，仅本地开发测试；禁止服务器/SSH/远端模型、部署、安装、Git同步/提交/推送及清理原WIP。仓库 `E:/repos/ara`、dev、HEAD90f2b1c，不套用Lumen规则。基础0/52、Desk0/5，默认不依赖Desk、LabSlot延期；Goal保持active。

本点新增schema8、原root/current execution/gen关联及agent.resume请求登记，**所有新attempt始终reconciling，没有继续执行、原生准入或Node恢复能力**。当前Node不声明agent.resume，submit/claim按最新capability拒绝旧Node。详见[证据](../evidence/agent-executions-20261104.md)与[合同](../agent-delegation.md)。

## 当前固定点

- R4 manifest `work/agent-executions-20261104/inputs-r4.json` SHA `8c6ed122c30653576b95166c326788f30cc6c20443fd51dd77f8b51ea60438ac`，186源/副本、18目标、4旧runtime。新表agent_tasks/executions/child_executions；旧operation/事件/预算/owner保留，不造native admission。
- root首次claim固定原deadline；resume只接原root/previous/fenceSHA/instruction，同request精确幂等、不同request并发CAS单current。expected fence尚未由Harness核验。
- 新attempt置requires_reconciliation=1，本点无清除或激活接口。queued取消、failed或通用对账不能释放原Task/Session/re-pair；精确未派发取消可作下一previous，generation只增。已有同Session后续Task时不能回头恢复旧root，按持久插入顺序区分同毫秒。
- resolver明确root权威与本次执行；模型/Run/child/review保持root键。root取消定位current，旧非root attempt只取消本代child。跨执行重取原child核归属并标evidenceOnly。已显式对账后迟到原成功只归档历史，不改变current与原对账结果。
- GET agent-task、CLI agent-task、MCP reach_agent_task及Node POST context提供只读状态/原权威。context绑定本次派发，不重绑模型配置或返回组织密钥。新CLI及MCP stdio进程未另做端到端执行。
- 模型owner协议仍7、stop仍严格root/gen1、unsettled未放宽。不退款/重发/接受Task，不因服务已有resume parser就启动没有实现的Node路径。
- R4新服务12/12，24.839秒；迁移8具名函数+1空匹配文件容器，33.127秒；实际native2/2，49.087秒；类型通过，均零skip。R2既有36/36及模型/owner31/31沿精确SQL guard差异桥，不称一次R4全量。
- R4实际native仍为两个gen1 Task、合计4Run/4模型/2child/44全ACK；正常文件once，硬杀原模型streaming、父unknown，不是resume。未设置额外退出记录开关，无fixture-exit.json，不补造全PID证据。所有exec测试句柄已收终态。
- Rust/Core/Harness、依赖及lock未改，runtime未重建、安装包未更新；不重复Cargo/deny。

独立设计 `work/agent-execution-design-review-20261104.md` SHA `461c0cf78ec72f88009fb5da2bdcfc139c1d38fa8bb348f3cfd666abcd41333c`。独立实现报告 `work/agent-executions-independent-review-20261104.md` SHA `2300483ed6b14de30fafb1217b980a62d5eb1de5b50db2d3fe815a1399de8bd9`，接受限定服务层，P2已关闭、无未关闭发现，不接受原Task恢复。主代理完整回读并核22链接/105引用，`review-checked-r4.json` SHA `8f278e78fa4759ebb6a2bf19822832215083161ee820f3149fb35607680dd8c5`。主原件核验 `checked-r4.json` SHA `ade6229a1805f9ccaafbc4a633028667194f3963da931102191fd9f9407426d4`。文档复核使用 `work/agent-executions-doc-review-20261104.md` 及同名JSON；复核后再生成 `work/agent-executions-20261104/checked-final.json`，不覆盖旧定稿。

R1夹具候选身份错误与首次类型错误保留；R3真实复现离线缺失execution目标被启动SQL漏检，R4显式NULL/关联目标检查通过。三个故意破坏的原库是拒绝证据，不能列为正常库。humanizer缺失，文档人工审读。

七文档164本地链接、18目标空白及根diff检查通过。根bootstrap退出1、516失败；比前点新增145=143旧文档快照+2本轮独立报告本地行号链接（源文件及:41行实际存在，checker未解析）。本点七活动文档0失败，没有移除原件。原日志与bootstrap-audit-r4.json保留，检查发生在本点文档快照生成前，不称全仓已绿。

## 下一步：接通原生恢复，不能只改phase

沿完整设计 `work/agent-resume-design-r2-20261104.md` SHA `ed329dee5d45f441cb6b119a965674a6c3871e77113370eaf255fb34d3cdf452`。本点只完成服务准备门禁，下面仍须实现与真实Node验证：

1. Node显式agent.resume能力/派发；按原root目录读取task.json，attempt证据写独立目录。保持原Task/Session/侧车镜像、工具声明、route、relay endpoint/token及本地绝对deadline；原端口不能重绑则拒绝。
2. 复用JSONL start.resume与Harness resume_checked；在Session锁内核完整fence/ResumeReview、admission/observation、原模型/child/输出。不得手改fence或新建Session替代。
3. 将owner/stop接入准确execution/generation resolver及新恢复receipt，仍核真实join/同锁退出。只有特定已核原请求可被恢复准入解释，不能blanket豁免所有unsettled或重发旧请求。
4. 提交绑定本attempt的消费/效果receipt，Node持久准确回复后才发stdin。缺observation全cap扣，actual/floor分栏，不按attempt重复扣；已预占但无admission槽按原证据复用UUID。
5. Run预占归属与首次native admission归属分开；首个新模型/child前核本次实际admission。当前reviews.length+1仍不能跨无review崩溃Run，旧pending review不得随current resolver自动变成新代反馈。
6. 开放工具按原顺序精确匹配child收据，不重放未知效果。文本ResumeReceipt不能冒充typed图片恢复；缺合同的组合须明确拒绝。
7. 只有原生接管、effects结算、实际最终proof和fence释放齐全，才能新增清pending及Session释放机制。实测硬中断→同Task继续、无admission/待prepare/重复崩溃/丢ACK及并发、错fence/epoch/route/镜像、端口占用和deadline拒绝矩阵。

R04/R05、真实安装、SCM/SYSTEM/锁屏/切用户、旧Desk历史、组织模型、跨机和部署仍开放。服务器暂停不构成本地实现阻塞，不标Goal complete/paused/blocked。
