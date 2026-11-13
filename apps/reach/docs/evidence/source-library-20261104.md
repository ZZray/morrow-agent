# Reach 跨任务资料与完结证明：本地执行点

作者：Ray Zhang（Ray）。日期：2026-11-04。状态：本地限定点已通过独立复核。完整R04/R05/R06与首版仍开放。

用户最新限制保持：只本地开发测试，不访问服务器/SSH/远端模型，不部署、安装或Git同步/提交/推送。仓库 `E:/repos/ara`，dev，HEAD `90f2b1cdd138129e2d331d89a37d70852e849739` 加保留WIP。基础0/52、Desk0/5；本点没有通过缩减清单改变计数。

## 实现与交付边界

[资料合同](../source-library.md)维护唯一行为说明。Reach service 复用原身份、Task/Session/Node/epoch和SQLite账本，新增设备范围的候选版本、真实验证、Controller审核、采用、取回和撤销；新Source引用与Task同事务关联。Core/JSONL及其会话内候选没有改动或自动同步。临时来源正文仍在原Task审计中，资料版本仅保存原来源头和SHA。

schema11新增四个资料/关联表，以及与原Node终态事件同事务保存的 `agent_native_closures`。旧库不回填验证或采用资格；模型owner协议仍10。普通gen1新增完结证明须核原进程/原件、真实Run、完整效果及预算；传输失败可沿原Released只读结算，恢复/只读收尾分别核原finalProof/finalizationProof。旧服务在执行前协商为普通低等级结果，不在效果后才调用不存在的接口。

独立挑战中发现并修正：收尾快照错误沿用deadline/cancel执行准入、只读收尾证明类型误判、失败child无typed图片却被强制读PNG、同步伪造两个Run ID的绑定缺口。新增marker避免从旧库任意相似字段推断曾经通过校验；晚到的已对账原事件保持历史补传但不新增资格。

真实故障流程还发现已有finalizer把业务结果的path/hash误当内部原件。现先核child/RPC/full-result的原Ledger/关系/参数/完整正文，再仅从内存引用视图排除业务正文；磁盘原文不改。resultRef及成功typed图继续核原路径、长度、字节与SHA；失败child不新建PNG。此修复不扩大允许目录，也不绕过开放图片恢复拒绝。

本点普通Node：`work/agent-library-20261104/runtime-r7/reach.exe`，SHA `3350f831917f5da3d67c6c69796cfcbf19b7afa8f3fd449089b53fe8e413a2e4`。JSONL沿用固定 `d7b4182d74bea47fdf210c54952fe1c33f24cd0379c107636c00035fa9f71439`，未重编Core/JSONL。现有安装候选仍是[Agent包执行点](agent-package-20261104.md)的旧冻结包，没有装入本点Node；未安装或部署。

## 执行记录

日志和运行原件均在 `apps/reach/work/agent-library-20261104/` 及下列独立GUID目录。Cargo 使用共享 `E:/usr/var/cache/rust-target/reach-static`、单job、静态CRT、`--target x86_64-pc-windows-msvc --locked --offline`；未并发Cargo。

| 检查 | 实际结果 |
|---|---|
| Node fmt/clippy/test/build | fmt、all-targets/all-features clippy `-D warnings`、构建通过；22/22测试，含6个原结果视图/大结果/typed图/失败图/恢复callback反例。`fmt-r9.log`、`clippy-r7.log`、`node-tests-r7.log`、`build-r7.log` |
| 依赖 | 原锁/policy未改；Node deny的advisories/bans/licenses/sources四项通过，`deny-r9.log` |
| 类型 | `bun run check` 通过含管理页；`typecheck-r10.log` |
| 新服务合同与迁移 | 7/7，无skip，`library-service-r9.log`；真实旧库扩大到28张原领域表的核对另3/3，`library-migration-r10.log`。4个合同函数使用真实完成记录的明确副本，不产生新native效果；3个迁移函数含真实schema10副本、原子回滚和缺结构拒绝 |
| 广泛服务回归 | `service-regression-r9.log`：107函数，101通过、0失败、6个既有历史输入未提供而skip；不算本点成功。覆盖service、calls、guidance、resumes、finalizations、迁移、model、reviews、executions、budget、consumption、stop |
| 全新Session资料闭环 | `library-native-r8.log`：2/2，两个独立真实流程，各6个受控provider请求、3次实际file.write、7种坏完结证明HTTP拒绝；合计14次坏证明拒绝 |
| 大原结果/删除源文件 | `library-large-finalized-r9.log`：1/1，实际file.read取240000字节，传输故障后删除源文件，再沿原Task只读收尾并登记候选；原resultRef全文字节仍匹配，无重新读取 |
| 新Node/真实旧service | `library-old-service-r7.log`：1/1，运行冻结schema10服务源码，2个请求、1次实际写；没有closure路由调用，没有新增验证资格 |
| 已有gen2只读收尾回归 | `finalize-gen2-regression-r7.log`：1/1，原Task/Session恢复后再次只读收尾，原非幂等命令仍一次，无新增效果或模型调用 |

上述五个native函数全部使用最终3350…普通EXE和固定d7…侧车；没有用HTTP 200或seeded图片冒充实际执行。`library-native-r8`完成时，后续仅增加标题/revision的UTF-8输入校验及large-finalized测试分支；原两种流程的输入/产品执行路径相同，新输入反例由后续服务测试覆盖。

### 两个完整资料流程

- `work/source-library-native-1c22eba3-a2cc-437d-8c93-dfadc85db0dd`：普通完结。A留下真实文件/进程证据；Controller登记候选；B在新Session使用准确candidate正文和要求执行；服务计算验证依据；CLI填写理由采用；重启服务；C在另一新Session显式取回adopted版本并写出候选中的随机文件名/原base64字节。随后撤销，新的正式取回/提交拒绝；先已排队的D被最新claim守门阻挡，无dispatch、Session目录、模型或工具。历史原文、验证和两个审核保留，重复采用不能复活撤销版本。
- `work/source-library-native-8590c835-c565-4858-8b2e-9c153f382a61`：A在原生Released/正常join后故意让closure HTTP返回503，原父保留unknown。原Released只读finalize成功后，再完成同样的B验证→采用→重启→C复用→撤销。原父unknown不改成新执行，原文件不重写。

两个流程都实际走CLI和MCP。B/C的模型输入包含同一原版本、准确stage、完整参数和说明，没有前一Session历史；候选正文以外没有该随机文件名/内容。外部Controller审核不是人工审核证明；被委托模型的工具表没有资料采用入口。七种坏证明覆盖错快照、原进程正文SHA、异常join、错最后Run、错消费、同步替换证明与basis两个Run ID，以及跨Task原件路径；正确原事件随后一次入账，坏请求不留marker。

### 其他原运行根

- 大结果：`work/source-library-native-2a160ad0-223f-45b2-8dee-a5637dc03adb`，`asserted-large.json`记录原输入SHA、完整result文件SHA及源删除；只有A和只读finalizer，没有借此宣称B/C复用也在本函数执行。
- 冻结旧服务：`work/source-library-old-service-73ac1b6d-6d8b-4b61-b9ba-142deee9ff15`；入口 `work/agent-guidance-20261104/source-r2/apps/reach/src/service/main.ts`，是真实旧源码进程，不是删一个字段的假服务。
- gen2回归：`work/agent-native-resume-8feff38e-6ba9-4737-aa98-beb05d7c143f`，原恢复/进程/封存记录保留。
- 28表迁移：`work/source-library-migration-a78402e7-a64c-4b8b-95dc-f789f142f145`。来源为前点实际旧Node→新Node恢复后的schema10数据库 `work/agent-guidance-native-0eb9cb50-c11e-4f81-bdf2-178ff687c820/service/reach.sqlite`，没有改PRAGMA伪造旧版本。账户、配对、操作/事件、路由/复核、预算、恢复/收尾和audit逐行相同；service_instances新增本实例是预期生命周期，未将其当旧业务表不变。
- 故意损坏旧Run关系的迁移在新事务中失败，保持原坏记录和schema10，五个新表全部回滚；schema11缺必需表拒绝空重建。旧service拒绝schema11。原Scope中的旧PID/配对/调用身份没有重造。

## 失败与复核

早期日志保留：`library-native-r1.log`误把MCP的错误code当中文消息；`library-contract-r1.log`重配夹具遗漏原凭据；`library-native-r3.log`触发业务path/hash误判；`library-finalized-r4.log`记录首版修复误将JSONL v1的operation_receipt字符串当引用对象，已按真实协议修正。`clippy-r5.log`保留测试模块位置诊断，移动模块后通过，未加豁免。

`service-regression-r1.log`为99通过/2失败/6skip：背压等待在当时并发负载下超时；“更高schema”用例仍把11当未来版本，实际打开成功但未关闭的Store使cleanup报EPERM。已把该未来版本改为12；没有杀遗留进程或放宽产品条件。定点复测和最终107函数回归均通过，旧失败不改写。

`/root/reach_plan_review`已独立挑战普通完成、scope/版本身份、只读收尾、失败图片和真实Run绑定，修复已落实。最终结论为 `ACCEPTED_LOCAL_R05_POINT`，27个冻结源/副本和运行时、日志 hash 全部回读，0 confirmed finding。报告 [Markdown](../../work/agent-library-independent-review-20261104.md) SHA `5e894b9b772f71b5992309e4b805d50571a33ea08225ee6ec4b821d0eeb76ecb`；[JSON](../../work/agent-library-independent-review-20261104.json) SHA `b9c74d1d6f008d6b7fcab420426b8c0aef25924f0656afe43935b828cba30e68`；[独立回读](../../work/agent-library-independent-review-20261104.readback.json) SHA `7c765984b576c4640c670000af60f9136078beec9136fb13fd5658adaba6bbe5`。humanizer未提供，文档人工审读；该接受仅限本地点，不以准备清单代替完整行为验收。

## 未覆盖

本地provider按收到的资料发出确定性调用，证明传输、状态和真实工具链，不证明真实模型理解或经验语义正确。组织模型、完整R04/R05、typed开放图片恢复及完整R06、Windows正式安装/升级/卸载、签名与干净机、服务器和部署仍开放。没有自动Skill安装、项目范围或跨设备资料继承；本点的设备范围是明确实现范围，未声称全部知识形态已交付。
