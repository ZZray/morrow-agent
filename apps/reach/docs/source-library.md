# 任务资料、候选与复用

作者：Ray Zhang（Ray）。日期：2026-11-04。状态：本地实现和测试中；本点不代表完整 R05、组织模型或首版验收。

Reach service 保存跨 Task 的资料版本、验证依据和外部控制器审核。Lite Core 继续维护原 Session 的引用、上下文和候选记忆；两者不相互自动导入。源码权威是 `src/contracts/source-library.ts`、`src/service/source-library.ts` 和 `protocol.ts` 的 source.library。

## 三种资料

| 层次 | 保存和使用 |
|---|---|
| 任务上下文 | 原 `command.sources` 及 Node/原生 Session 的审计记录。没有全局自动注入。资料版本的出处仅引用原 Task、原文 SHA 和来源头，不重复保存临时正文 |
| 候选技能/知识 | 外部控制器依据一个真实闭合任务编写，明确标为 `controller_authored_from_task_evidence`。正文、revision、适用要求、设备配对范围和出处共同形成不可变 versionSha256；不是 Core 原生候选或原工具正文 |
| 已采用资料 | 另一个实际 Task 明确选入候选并执行后，服务生成执行依据；外部控制器再对准确版本和验证回执填写理由、明确采用。一次成功不会自动进入此层 |

当前只支持设备范围：账户、Node ID 和配对 epoch。没有项目范围，也不从 cwd、Session、设备名称推断项目身份；重新配对不继承旧资料。改正文、revision、requirements、范围或出处需创建新候选，旧版本不覆盖。

## 最小闭环

1. Task A 真实执行并闭合，保留原 Node 成功事件和完整效果依据。
2. Controller 登记候选 V1。普通列表默认只列当前设备范围的已采用 metadata，候选须明确查询。
3. 显式取回 V1 的 candidate source，放进 Task B 的 sources。B 的原输入同时保存 Task→版本→用途关联；没有隐式注入。
4. B 闭合后提交它的 root Task ID。服务核对 B 与 A 不同、创建时已选入准确版本、全部效果已结算、至少一个真实成功 child、模型运输及原生释放/进程收尾证明。回执证明实际执行和对应关系，不自动判断经验语义正确。
5. 外部已认证 Controller 对 V1 和该回执作显式审核，记录 actor、reason 和时间。Controller 可以是本地 Codex；这不表示人亲自审核。被委托模型的 Host 工具中没有资料采用入口，Host 也不向它提供 Controller 登录身份。
6. 显式取回 adopted source，交给另一个 Task 使用。新 Session 和服务重启不丢失版本、原文或审核。

验证不要求产品始终换 Session；本地验收的 B/C 使用全新 Session，并在 C 前重启服务，排除前一轮会话上下文冒充持久复用。

`source` 保留原 `id/kind/source/revision/sha256/text/requirements`，另携带：

```json
{"library":{"id":"<entry UUID>","versionSha256":"<完整版本 SHA256>","stage":"candidate"}}
```

`candidate` 是未采用的验证/参考资料；`adopted` 要求当前采用状态。服务同时核对正文、revision、来源 URI 和适用要求，不能换文字或放宽能力条件后继续借用旧验证。没有该字段的普通来源继续按原合同处理，但不能借用 `reach-library:`/`reach-library://` 的注册身份。

## 完结证据等级

schema11 只新增登记和关联，不把旧 Task、旧 Session 候选或普通 succeeded 补造为资料验证。

Windows Node 在组织模型 route 中、执行任何侧车/模型/工具前协商 `nativeClosureVersion=1`。新 service 支持时，Node 在原 native Task Released、回调结束、原侧车正常 join、Job 为空后，读取原 Task/terminal/outcome/进程文件，核原字节并取得服务当前效果快照。原成功/闭合失败终态携带 nativeClosure；服务核准确派发、启动前进程归属、原件目录、真实最后 Run/顺序/预算、模型 join、完整 child 和快照，然后同事务保存 `agent_native_closures` 标记与原终态事件。历史数据只有相似字段不获得资格。

完结快照是只读收尾，截止时间和取消不变成新增执行权限，也不会抹掉已经 Released 的结果。明确对账后的晚到原终态仍可补传历史，但不新增资料验证标记。新 Node 接旧 service 时，没有协商标记便保留普通完成语义，不在效果发生后调用不存在的接口；这种普通结果没有新增资料验证资格。

恢复成功沿原 finalProof；原 Released 的只读收尾沿原 finalizationProof；两者都须有与准确终态事件同事务保存的 `agent_task_finishes`。证明传输失败可保留 unknown 后沿原件只读结算，不启动新 Task/Run，不重放工具。普通对账改写的成功不能代替这些原件。

只读收尾区分内部原件引用与业务结果中的 path/hash。child/RPC/full-result wrapper 先与原 Ledger、service 关系、Run、call 和参数核对，再从内存引用视图排除业务正文；磁盘原文保留。resultRef 的原路径、完整字节和 SHA，以及成功 child 的 typed PNG 继续校验。失败 child 按原合同没有 typed images；不能为收尾新造 PNG。

## 撤销和重试

撤销保留正文、版本、出处、验证和审核。新的正式取回、提交、未派发 Task 领取及新恢复执行都会按最新登记状态拒绝；等待任务保留原 ID 和临时阻挡原因，其他兼容任务继续运行。已派发任务保留原冻结输入，撤销不声称回滚效果；要停止它沿原取消 API 操作。原件读取和只读结算仍可进行。

幂等请求按账户和 requestId 绑定完整输入。原采用请求在撤销后重试只返回原审核和 `currentState:revoked`，不会重新激活。完全控制的 Controller 仍可复制文字作为普通上下文；本合同保证的是注册资料的身份和复用关系，不承诺禁止某些字节再次出现。

## 控制器入口

CLI 均接收一个 JSON 文件，并与 MCP 使用相同校验/客户端：

| CLI | MCP | 用途 |
|---|---|---|
| library-list | reach_library_list | 按 nodeId/epoch 列 metadata，默认 adopted |
| library-read | reach_library_read | 按 entryId 读取原版本和历史，不代表当前可正式复用 |
| library-source | reach_library_source | 按完整版本与明确 stage 取回 Task source |
| library-propose | reach_library_propose | 依据 sourceTaskId 创建候选 |
| library-validate | reach_library_validate | 关联 validationTaskId 的实际执行证据 |
| library-review | reach_library_review | 按版本、验证回执及理由采用或撤销 |

开发版示例：`node src/controller/main.ts library-propose proposal.json`。HTTP 为 `/api/v1/library` 和 `/:entryId/{source,validate,review}`，沿既有身份/CSRF 合同；没有新的工具审批模式。

当前 schema 为11，模型 owner 协议仍为10。真实 schema10 副本迁移需逐表保留原操作、事件、恢复/收尾和预算；失败整体回滚，结构或必需关系丢失时拒绝重建。旧 service 拒绝 schema11。

本地实际证据见[资料闭环](evidence/source-library-20261104.md)，后续任务仍见[唯一清单](task-checklist.md)。
