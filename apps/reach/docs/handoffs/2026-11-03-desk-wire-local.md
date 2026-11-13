# Reach Desk 本地接续：共享观察/关闭协议已接通

作者：Ray Zhang（Ray）。日期：2026-11-03。

**只做本地开发与测试，禁止SSH、服务器读取、远端模型探测和部署，等待用户明确恢复。** goal仍是完整首版，基础0/52、Desk0/5，不提交/推送/安装。ARA E:/repos/ara、dev、HEAD90f2b1c加保留WIP，不套Lumen规则。未收到UAC结果，不重复询问；图标不重做、安装候选仍60a6，18912不是当前预览。

本 goal turn 是 progress：Core只读检查已包进Harness锁→JSONL→Node/Bun SDK，并在close同锁复核原快照。详见[证据](../evidence/desk-wire-20261103.md)。Host/Store/UI本轮未改，**页面自动原会话续聊尚未接通**。

当前普通sidecar缓存 E:/usr/var/cache/rust-target/reach-static/x86_64-pc-windows-msvc/debug/ara-agent-lite-jsonl.exe，23862784bytes、SHA `2f858a77ba86bd8b201f7184b5afb7a10afc674ad8668cf49354c44174dc8353`。旧888...已为历史，只在旧snapshot保留。服务器/安装包没更新。

新API：Harness inspect_session_locked 返回guard持原Session锁到drop，snapshot是Core事实+fence/closing；output_directory拒绝原生根/保留namespace。JSONL inspect_session在Start/token/MCP前，原请求帧SHA，固定目录inspection.json完整typed文件（外壳NL合计16MiB）+小终帧ref，guard活到发送完成。SDK inspectSession复制调用参数、拒绝opdir污染原生、等真实process close/exit0/单完整帧，核固定real根/junction、ref/请求/inputs/context/run/call及字节预算；absent不能带旧prefix。哈希不是认证，validated不是Task接受/效果结算。

close声明可选session_inspection_ref，default+skipNone保持旧六字段字节合同，显式null/未知字段拒绝。ref必须同path/SHA出现在evidence_refs。无prepared时DeclaredHost.check_close在已持锁内调用Core（不可重入guard）比较同request和完整Core事实，fence独立绑定。closing marker正常变化不当成Core过期；prepared/released重试核旧review/receipt/ref，不读取新Task状态。Core interrupted_run改纯读load_inner，close::head用inspect_head，合法migration/pending cleanup不被预检清理。

独立修复点：Value会重排typed字段造成非空SDK摘要失败，现typed Record一次序列化原字节保存；固定operationRoot并拒绝result父junction；facade首次await前克隆参数；SDK补文件字节总和/Core输出budget及absent旧prefix拒绝。

最终63不同函数通过：Core12+marker1、Harness resume17(84.86s)、JSONL13(4.50s)、Node SDK20(12.080s)。三包fmt exit0/doc0，Harness lib/tests全特性Clippy10.19s、JSONL全targets/features3.92s过，普通build3.31s。一次一个Cargo，offline/locked，CRT static，target E:/usr。JSONL图deny四项0error，8重复+1license告警、缓存未刷新。没重跑Core全量/旧Harness78长矩阵，不冒充全仓绿。

最终普通进程3探针：

- Node新链路 work/desk-inspection-wire-ffb0c295-53ad-4330-befa-803fbe250474，271642byte非空快照。
- Bun同一脚本 work/desk-inspection-wire-8aea0860-2924-4673-be87-db90867d6899，271641byte快照。
- 旧六字段无ref声明兼容 work/desk-close-jsonl-8bac4ba4-2051-4f2a-9df9-569ff28ed07b，7旧场景/2请求。

Node/Bun各13组语义、16真实memory_propose写入后cancel、3loopback模型请求/0外部callback；16candidate都未采用，第三请求含mem-16原回执。不是26种能力，也不合并进63函数。SDK+raw CLI原生/marker/已有目录拒绝、真实跨进程锁竞争、四类stale/four bad declarations不留新marker、合法cleanup保留、fence删除后发布故障→原声明恢复、原Session下一Task及旧released保护新fence全过。受控fixture主动加入合法cleanup marker，不称做过一次legacy导入；目录故障exit2不是SIGKILL或掉电试验。

失败保留：SDK fixtures r1 11/12是异步改参，r2 12/12也不是最终20/20；probe r1 work/desk-inspection-wire-48c1e377-9454-4566-b921-9e9388ac9330 的start漏host_output_ceiling，Task准入前exit2/closed/无forced，控制器盲等屏障后被核实停掉；现Promise.race观察原wait，不再盲等。该失败根无stdout/Tee文件，仅真实client-finished原件，不伪造成功。大参数探针必须同时设max_output32768和host_output_ceiling32768；正常Desk配置不受此fixture参数影响。

[冻结清单](../evidence/desk-wire-inputs-20261103.json)SHA `92ccdfe2710ad0d22bb3facf8ffb11dc0367c9e48de6688fec8ce6a70c8bd7f2`，134source/269原件/3成功+1失败根/普通EXE两处；identity `f910c76fef6c3226a9a8925ec2ab34508bc744b35b33ce9aed64eedd277f3c12`，snapshot work/desk-wire-source-4cb20fc3-8111-457e-9c42-c5570a0f0ddb。独立/root/reach_plan_review审14代码+2README，报告work/desk-wire-review-20261103.md，SHA `3f4b9867d895104bb37f07810212f958c376011c3d72105734d91b2c4985ee1e`。不是134文件全语义审查。

主代理完整回读报告，work/desk-wire-final-check.json核539清单项+2实际Node/Bun EXE副本共541项SHA/bytes匹配，另核两份观察请求/引用、四证据refs及关闭链和新fence。6文档128本地链接通过、git diff --check exit0。最终检查/报告/本文在清单外，后续不要因其不在清单就生成循环摘要。

下一步直接接Host：

1. platform/src/host.ts仍旧startTask/wait/finish，不调用inspectSession或closeTask。先把实际EXE复制到state/runtime/sha缓存并验SHA，保存原start frame/hash、SDK client-started、admission/observation/events与运行前锁内baseline。支持profile必须证明JSONL固定local_tools=false/worker=None、实际tools=[]/无MCP；不能只看当前配置或callbacks0。
2. 结束后要求实际wait validated、closed/exit0/无forced、callbacks_finished及原outcome/消费量一致；用同原Session、原Task实际admission Run集合和baseline范围检查context/命令/工具效果。16memory真实探针可作实现参考，不能只限定无tool_start文本当最终方案。管理命令/summary也会写context；zero-Run依据按真实0消费处理，不为legacy unknown造收据。
3. Host保存不可变inspection ref、效果原件和声明，之后Store.beginSettlement→claim（已持久次数）→closeTask；同声明新operation目录重试，固定原EXE，最多次数不可重启重置。只有SDK validated且原Task/revision/declSHA一致才Store.completeSettlement，保留原Cancelled/Unknown/task_accepted=false；证据不足继续blocked。
4. Store v2/UI已在前一versioned交接完成，复用三元组版本与pending SSE。关闭期间cancelling保持one_live_turn和SSE；最终Cancelled/partial/draft保存，旧true/false不影响新版本，登录epoch保护不漏旧用户。构造器保留匹配closing意图，但Host尚无恢复器；完成时需等恢复promise，停止服务也join。
5. 实际Chrome stop→settle→同Session新消息、refresh/GET断流、late事件、logout/expiry、发布失败同声明恢复、缺证据继续blocked，以及基础无Desk回归。再做设备工具/委托等完整首版事项。

本点结束无活跃测试、Cargo、模型或SSH会话。后续仅按新改动验证，不重复本轮已冻结长矩阵；全仓历史坏链接仍未扩修。服务器及真实组织模型待明确恢复。
