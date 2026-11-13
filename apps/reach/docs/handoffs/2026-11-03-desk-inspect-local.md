# Reach Desk 本地接续：共享 Core 只读检查

作者：Ray Zhang（Ray）。日期：2026-11-03。

**继续只做本地开发与测试，禁止 SSH、服务器读取、远端模型探测和部署，等待用户明确恢复。** 完整首版仍为原目标，基础 0/52、Desk 0/5；不提交、不推送、不安装。ARA `E:/repos/ara`、dev、HEAD90f2b1c 加保留 WIP，别套用 Lumen 规则。用户未报告 UAC，不重复询问；图标已完成不重做，完整安装候选仍60a6，18912不是当前预览。

上一 goal turn 为 progress：Store v2 + UI版本基础已实现，24项本地测试通过。本轮又实现 Core 原生状态检查候选，详见[证据](../evidence/desk-inspect-20261103.md)，不是停留在计划，也不是完整 Desk 验收。

入口 `ara_agent_lite_core::agent::inspect_session(&InspectionRequest)`，代码 crates/ara-agent-lite-core/src/session_inspect.rs；另改 agent.rs 的共用 transcript validator、session_journal.rs 的 inspect_head/inspect_run、context_memory.rs 的精确字节 validate_window，新增 tests/session_inspection.rs。独立源码复核只覆盖这5目标。

API 不启动 Run、读 token、执行工具、迁移、清 marker 或声明 settled。区分干净 absent 与残留原件；完整 Journal 逐条校验，from_raw/active_base边界闭合，active容量沿普通加载；读真实Run index（data=None正常），pending/未配对/unknown明示；检查 context、projection、实际经验完整回执；原始SHA与归一化snapshot分开。full_proof(0,to_raw)供下一基线，别把range_proof(from,to)当全前缀。消息本身无Run归属，仍需Host基线/准入绑定。

API本身无Session锁；前后完整输入清单只能作稳定观察，不能防ABA。用于关闭必须持Harness同一Session锁；检查报告不等于Host对全部效果的结算。默认输入64MiB、输出16MiB、消息100000，超预算报错不截断；无JSONL/SDK包装。

最终本版54不同函数全通过：inspection11（51.21s）、旧context18（0.08s）、agent12（13.86s）、journal8（101.79s）、真实Core集成5（21.33s）；doc0、Core lib/tests全特性Clippy6.75s通过、fmt exit0。所有Cargo串行offline/locked，target E:/usr/var/cache/rust-target/reach-static，CRT static，Rust1.98.1。旧Core全量及Harness78长矩阵没重跑，不称全仓完成。

五组实际Core共14次loopback请求、11观察：真实memory_propose保存及管理命令accept/revoke/correct/revoke、proposal写后取消仍candidate、内置read_file真实缺失/存在后experience候选、Desk8tools拒绝伪回执、自动summary候选。实际副本在work/desk-inspect-native-{commands-0970175f2da560e4a4efde83,cancel-proposal-5fd16220adcdfebcfe1948ab,experience-d1a3da2ba8c1e2d38c9c2aa3,desk-experience-rejected-0ff6b2fd188e3e06bb606910,summary-a1ff9a0a9229ffbaa29ea7d7}。临时源已退出删除，副本按原根相对路径保留；不要把原绝对路径当活目录。

主要日志 work/desk-inspect-{unit-r4,native-r4,context-regression,agent-regression,journal-regression,doc,fmt,clippy-r3,deny}.log。deny四项0error，但8 duplicate及1 license警告，缓存公告未刷新；首次PATH失败保留deny-r1-failed。unit-r3 10/11是新增fixture空sources提前失败，已补真实来源，不放松校验；clippy-r1是旧测试chunks_exact lint，作等价as_chunks替换后通过。失败不计通过。

[清单](../evidence/desk-inspect-inputs-20261103.json)SHA `8810cc44c9a6dee92983cca34506250c47485e6efea115923b2078c2799fcc64`，129source/2测试EXE及副本/20roots/221原件；sourceIdentity `5407bd20e628bc49877016e2463b7b5176d9207aea5fa28653b805f2cf91ffc1`；快照work/desk-inspect-source-8af43740-f8a2-4dc4-b285-7f7d5a5da3b7，stage work/desk-inspect-sources-r4.json。不是129文件都独立审过。

普通sidecar未重编，仍 E:/usr/var/cache/rust-target/reach-static/x86_64-pc-windows-msvc/debug/ara-agent-lite-jsonl.exe、SHA8888878cf51bafb40b28c33e9c2662fd9e072f11e72f4b4c693b3af969244bb0；无本次inspect协议。不要把Core测试EXE能力当普通sidecar能力。服务器、安装包均未改。

独立复核仍/root/reach_plan_review，唯一报告work/desk-inspect-review-20261103.md。发现并修复active_base切工具对/容量P2；未配对效果unknown补true；新projection只读守卫防缺失refresh；输入守卫变化测试为直接调用守卫，不是并发/ABA试验。前一Store/UI及共享close交接继续有效，但当前Core三个共享文件已更新，不能再说上一127源全与当前相同。

独立报告最终SHA `10ebe91cc021bffbb10868108a1c0f503d1e56137056fcf93c8a8f49534973d2`。主代理已完整回读；work/desk-inspect-final-check.json直接核对483项摘要、54不同函数、14请求/11观察、35最终原件映射，全匹配；6文档127本地链接及git diff --check通过。接受范围仅Core只读检查候选，不把它标成完整X02或正式产品交付。

**下一步继续JSONL→SDK→Host完整接线。** tokenless检查须在Start/token/MCP之前分流，由Harness同Session锁保护；用固定根有界文件+SHA引用承载完整结果，避免256KiB帧截断成功。Host保存原固定EXE/profile、运行前基线和实际准入/原进程+callback join，核实际context/命令/工具效果；声明先持久化再Store begin/claim，重试原字节声明+新operation目录；关闭同锁复核snapshot，prepared/released重复用旧存证。再验证实际Chrome stop→settle→原Session新Task，仍保留原Cancelled/Unknown和task_accepted=false。没有Host自动续聊代码，不缩成“纯文本能取消”作为最终方案。

设备工具、Node Host/委托、完整安装及干净机等继续；远端恢复需用户明确，不能探测服务器或模型。此点完成后没有Cargo/模型/SSH会话在跑。
