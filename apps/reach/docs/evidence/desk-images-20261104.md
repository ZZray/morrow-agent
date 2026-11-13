# Reach Desk 原图输入：本地分项证据

作者：Ray Zhang（Ray）。日期：2026-11-04。

只在本机执行 Reach HTTP/SQLite、共享 JSONL 程序、原生 Session 和受控 loopback 模型端点。设备配对、operation 及 PNG 产物由夹具按原账本协议入账；图片不是本轮现场截图，端点也不做真实视觉理解。未连接服务器、探测远端模型、安装、部署、提交或推送。基础0/52、Desk0/5保持，本记录不完成X03或R07。

## 实现与来源

`reach_image` 从当前账户、固定设备/epoch 和原 operation 的完整 PNG 产物取图，核 manifest、分段、整体SHA、尺寸和实际解码。原图保存到原 Task evidence，再以共享 `ToolReply.images` 引用进入 Core 的 typed image 内容。原账本、配对和设备操作没有复制；读取、失败和超预算不重拍。

共享接口仅在成功且Settled的回调中接受有界非空图片引用；路径必须规范化到原 Task evidence 中，Rust从同一已读字节完成摘要和PNG校验后编码。损坏图片、动画PNG、错误尺寸、越界路径和未知效果不作为图片送入模型。原回调与操作收据保留。

Core将已类型化图片数据与保守文字预算分开；用户文字及工具参数中的类似JSON不享受图片预算。图片数据不做凭据字符串替换。原生记录/checkpoint总上限24/32 MiB，文字4/8 MiB上限仍在；同一Run原图累计16 MiB，活动图片编码24 MiB。新Run前为较大旧图生成包含原图片块和来源标记的摘要，确认保存后归档闭合原生旧前缀；原 journal 不删图。运行中所有本Run索引使用绝对原生位置，归档的call-id缓存随raw_base更新。

普通候选由侧车在Harness已有锁内检查原生记录，生成绑定完整basis和原生图片字节的证明；Desk与原回调交叉核对。停止关闭另检查原生块和原操作收据。新消息在创建Task前检查字节、文件数和消息数，为原生检查保留下一轮空间。超额拒绝不更换Session或产生阻挡Task。

旧文本镜像`2f858a77…`、已验证图片候选`26d9e993…`及最终`02751851…`使用各自固定镜像，旧Task关闭沿用原声明和原binary。旧七工具profile和默认纯文字loopback路由保留；图片能力只在受控Relay显式开启或模型目录实际声明时生效。完整字段见[共享协议](../../../../crates/ara-agent-lite-jsonl/docs/protocol-v1.md#原图输入2026-11-04-可选字段)。

## 版本及原件

- [第一工作快照](../../work/desk-images-20261104/inputs-r1.json)：125源，SHA `276ae868c3e80b33712b70d0a8661d24bb69de2452f234dde0235d186741b801`，不作为最后实现通过声明。
- [大图/恢复冻结](../../work/desk-images-20261104/inputs-r2.json)：129源，SHA `f017e3d3fe6a59f68c8a1483887208d152e444599153e7d1a94d16f8a402cb8a`。原普通镜像26d9已另保存在`work/desk-images-20261104/runtime-r2/`，避免缓存重建后丢失原字节。
- [最终分层冻结](../../work/desk-images-20261104/inputs-r3.json)：129源/副本，SHA `95daaf0402d4f616024dc05cebba52795e428da16d51b7c0b4c39f064228afc4`。相较r2的12个文件，Rust为格式/模块顺序/类型推导/测试from_ref；业务差异为容量准入的文件/消息余量，以及Host识别最终镜像且保留原26d9profile。
- 最终普通程序SHA `0275185113786a971fad17307c4cefcd0de4d2c0666bcb857d9cc20b2e26a344`，不可变副本`work/desk-images-20261104/runtime-final/ara-agent-lite-jsonl.exe`；旧文本程序原字节保存在`runtime-baseline/`。本轮只重编共享侧车，没有修改Node或安装候选60a6。

所有测试日志在`work/desk-images-20261104/`。分层证据分别属于其执行源码与镜像，不能把此前执行写成最终SHA下全部重新运行。

## 已执行检查

| 日志 | 实际结果与范围 |
|---|---|
| `image-r3.log` | 26d9镜像，1/1，88.726秒：完整大图、两图累计/第三图超额拒绝、正常候选、摘要、停止关闭和原Session归档后工具续聊 |
| `image-r4.log` | 最终0275镜像，同一完整测试1/1，87.584秒；原预算和大图夹具保持 |
| `cloud-r1.log` | 26d9镜像，8/8，193.377秒：原会话、多轮、候选、摘要、取消、登录/退出、进程崩溃及二次关闭后恢复 |
| `legacy-runtime-r1.log` | 2f858旧镜像，1/1，14.443秒：第二次关闭后数据库释放前重启恢复，同Session继续；与上一行函数重叠，不另计新覆盖 |
| `host-policy-r2.log` | 11/11，50.777秒：重复调用、原图/损坏/不完整/取消、候选原生证明、原op恢复和结算；容量逻辑后来加强，另见下一行 |
| `capacity-r2.log` | 1/1，2.745秒：真实HTTP字节/消息超限拒绝，零turn、blocked0；稀疏历史文件只作元数据夹具 |
| `sdk-r2.log` | Node客户端8/8，9.190秒：原回调身份、取消/断流、原件引用及typed图片元数据；假侧车测试不冒充Rust像素消费 |
| `core-context-r3.log` | 34/34，6.11秒 |
| `core-agent-r3.log` | 12/12，14.55秒 |
| `core-journal-r3.log` | 8/8，173.59秒 |
| `core-caps-r3.log`、`core-image-bytes-r3.log` | 4/4、1/1 |
| `core-job-retest-r3.log` | 原失败函数串行1/1，2.95秒，未提高原预算 |
| `jsonl-r3.log`、`jsonl-r4.log` | 均16/16；后者绑定最终格式与lint修补，5.33秒，不重复累计函数数 |

Core后续受影响6组共60个函数有成功证据，不是最终源码下重跑全部Core。首次`core-r2.log`为252通过、3失败、1 ignored，342.25秒：图片摘要沿用旧文字额度断言、历史读取沿用旧8MiB常量断言，以及Job输入时已非活跃。前两项按新合同改正断言并复测；Job原源码和预算下串行复测通过，不认定第一次失败的具体性能根因。

Core与JSONL的fmt最终检查均exit0；两者all-targets/all-features clippy在修正冗余类型与单测clone后通过。共享JSONL整个依赖图使用既有Core策略执行`cargo deny --offline --locked check`，advisories/bans/licenses/sources均通过，重复版本警告保留；未访问网络刷新审计数据库。TS主项目/platform检查及Web构建通过。Python客户端只核语法，没有把它写成图片消费端到端通过。

## 大图和恢复的可复核事实

26d9完整原件根为`work/desk-image-e92b066e-84c6-472e-a1a3-3b0ab0bef9da`。原图为1024×1536随机像素PNG，超过6 MiB且小于8 MiB；原文件、Reach原分块、保存图片、原生ToolResult及实际loopback请求图片字节一致。

一个模型轮请求三次原图，前两次合计仍在16 MiB以内，第三次明确返回`desk_image_budget`且无图片。正常回答的原生证明核到两张图。后续大图摘要仍接收实际图片块，模型停止后关闭原Task，再沿同Session执行查询；原Reach operation总数始终为1。模型凭据特意取无真实秘密的PNG前缀`iVBOR`，核原图未因字符串脱敏而改变。独立复核解码8条请求中的6个图片块：普通2、摘要2、取消前1、摘要1，均匹配原图。

独立中断探针根`work/desk-image-interrupt-review-ea1733a0-5782-4c17-8500-d8d2afe55c39`：Windows锁分别造成摘要已保存/native保存前失败，及journal提交后/checkpoint替换前失败。两个原Task均保留ReconciliationRequired、fence/pendingRun，compact事件0、原图片工具各调用1次；释放锁后公开inspectSession读到原摘要且不修改原生原件。探针不重放动作、不关闭已关闭Task。具体报告与主代理回查见下文。

最终0275镜像原件根为`work/desk-image-e156b098-59a1-4fa9-abd4-b89a2d7cff68`，同样8条实际请求/6个图片块、三个Task为completed/cancelled/completed、原账本1个seeded operation。独立分层回查为`work/desk-images-review-evidence-r3-20261104.json`；最终大图不是仅沿用26d9的历史结果。

独立[最终报告](../../work/desk-images-independent-review-20261104.md) SHA `14b5b199674affbb54c0554f85d9abae57806baf3764b5456f5d0eb4ea3eed6e`，所审范围无剩余确认阻断缺陷。主代理已完整回读报告，运行[分项回查](../../work/desk-images-20261104/check.mjs)核129当前源/副本、三个镜像、8请求/6原图块、三个Task、1个原operation、5份设备回执、34份稳定引用和两个中断窗口。最终[原件清单](../../work/desk-images-20261104/checked-inputs.json)另列对应原件，历史可变Session路径没有被伪装成稳定字节。

最终原件清单SHA `78e2064ef1bcd226ef06d4589b4e54cda7d0f08ac0de340f055030256e1dec5f`，文档不作为该清单的自引用哈希输入。

文档手工审读，未运行缺失的humanizer。相关7份文档的新增链接存在；唯一缺失是Core README在HEAD已存在的`stage-publication-0.2.10-20261022.md`历史引用。全仓`verify_bootstrap.py`报告234项断链，包含依赖、忽略的work与旧归档；该全仓检查未通过，日志保留，没有把排除旧项或文档检查当作Agent验收。

## 保留的失败与剩余范围

`image-r1.log`在真正工具前被原loopback文字能力限制拒绝，未送图；初次Core图像单测误把ToolResult直接按AgentMessage反序列化，夹具缺kind。两者都保留，修正后再运行。`image-r2.log`已通过第一Task的双图/预算/原生候选；第二Task先因夹具摘要不是严格JSON而被阻挡，不把该失败当作后续源码缺陷的执行证明。

复核另指出并修复：重复统计已摘要旧图、rpi旧窗口hot判断、实际原生checkpoint未及时归档、归档后本Run索引及call-id缓存、typed图片被通用脱敏改字节，以及误用context路径保存native状态。后两项错保存路径和hot修补在r5镜像已修，未拿中间r4构建宣告恢复通过。初次fmt/clippy失败记录也保留。

当前仍需新一轮真实Node/desktop截图直接进入Desk及浏览器图片呈现、实际组织视觉模型任务、现场Agent委托/技能与来源传递、旧平台历史和完整能力迁移、跨物理机器、SYSTEM/UAC/升级卸载，以及用户恢复后的Ray发布。不得用本地受控端点证明模型视觉理解或把分项测试数当作完整清单完成数。
