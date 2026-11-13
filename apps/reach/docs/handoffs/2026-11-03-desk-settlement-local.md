# Reach Desk 本地接续：Host 已接通原任务结算

作者：Ray Zhang（Ray）。日期：2026-11-03。

只做本地开发和测试。禁止 SSH、服务器读取、远端模型探测与部署，等待用户明确恢复。ARA `E:/repos/ara`、`dev`、原 HEAD `90f2b1c` 加既有 WIP；不提交、推送、安装或清理。不要套用 Lumen 分支或 TS-only 规则。完整目标仍 active，基础 0/52、Desk 0/5。

当前证据：[Host 本地结算](../evidence/desk-host-settlement-20261103.md)。上一交接的共享 Core/Harness/JSONL 观察和关闭协议保持原样；普通 EXE SHA 仍 `2f858a77ba86bd8b201f7184b5afb7a10afc674ad8668cf49354c44174dc8353`，路径仍在 `E:/usr/var/cache/rust-target/reach-static/x86_64-pc-windows-msvc/debug/ara-agent-lite-jsonl.exe`。服务器、安装候选 60a6 及现代图标未更新；未收到 UAC 结果，不重复询问。18912 是已停旧代理。

新 `platform/src/settlement.ts` 固定 EXE、存 baseline，结合原 start/admission/完整 observation 与事件、最终锁内 snapshot 核对效果；保留全部八个 Session 工具。关闭声明直接绑定依赖的每个原件 ref，不能只把路径列表嵌在说明 JSON。固定原声明，Store begin/claim 持久化两次预算；SDK 验证关闭后 CAS 释放。同原生 Session 新 Task 续聊已接通；不改原取消状态、不接受业务 Task、不回滚候选或命令效果。

管理命令 Core 返回 Informational，不是普通候选。CloseIntent 可含 `terminalStatus:completed`，不伪造 cancel_requested；完成后保存原命令输出。AnswerEvents 仅在无 delta 时从 agent_end 显示原输出。失败或不足证明仍 blocked；旧 cloud 状态、未知 EXE、未归属效果与无原生完成证明不自动处理。

SDK 新 `close.mjs:readCloseOperation` 供重启复核已保存的成功关闭链。它不启动进程或读新 Task 原生状态。Host 在 claim 前优先读原 operation，包括次数已到 2 的情况。实际 process.exit(37) 在第二次 native close 成功、Store CAS 前的重启已通过；缺少已退出成功收据时不凭 released 文件补造交付。

41 个不同本地函数有成功证据：后端 26、Chrome 7、SDK close 8。r1 后端 25/26，认证夹具把 Host 预算当末条用户消息而提前回答；r2 修夹具后重跑受影响 7/7，浏览器首组再跑 1/1。其他未影响函数沿用 r1，不能说 41 项都在最终测试源码 SHA 下全新运行。详见证据表。未改 Rust、不重编 Cargo，不运行 real-model.integration.test.ts。

只读 check-evidence.mjs 核 25 源码输入、31 测试根、276 声明原件、23 released 链全部匹配；清单 `work/desk-host-settlement-20261103/checked-inputs.json` SHA `d4a47eb49f2b9bcf1b004e8a3e3624c7dd7042efef537156b0a30ffe7b234368`。独立复核报告 `work/desk-host-settlement-review-20261103.md`，SHA `dbea5e8bc4d42e1c05e71019bed3c9bceb7c903d2ccb5b328a806b1330143e81`，主代理已完整回读；独立 12 函数与集中函数重叠，不相加。错误原件与修复均保留，先读报告和主证据再安排新测试，不无改动重复长矩阵。

下一步从完整清单继续推进云端设备工具、现场任务委托和旧能力迁移的本地闭环；不能因文本续聊通过就勾选整个 X02 或 X03。还需补 Host 层发布失败同声明重试、更多未支持状态/工具的可操作恢复；底层已有机制探针不替代产品验收。安装真实 UAC/SYSTEM、锁屏与切换、升级卸载仍未验收。组织模型和 Ray 上线只在用户明确恢复后执行。
