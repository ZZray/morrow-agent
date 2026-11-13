# Reach Desk 本地接续：Store v2 与页面状态

作者：Ray Zhang（Ray）。日期：2026-11-03。

仍只做本地开发与测试；禁止 SSH、服务器读取、远端模型探测和部署，等待用户明确恢复。完整首版范围保留，基础 0/52、Desk 0/5；不提交、不推送、不安装。ARA 仓库 `E:/repos/ara`、dev、HEAD 90f2b1c 加保留 WIP；不要套用 Lumen 规则。用户没有报告 UAC 结果，不重复安装请求。现代图标已完成，完整安装候选仍 60a6；18912 不是当前预览。

本轮已完成 Store schema v2 与页面版本状态的本地基础点，具体见[证据](../evidence/desk-versioned-state-20261103.md)。七个改动入口为 platform/src/{store,web}.ts、platform/web/{desk,settlement}.ts、platform/tests/{store,settlement-view,web.browser}.test.ts。

Store 保存 blocker Task、settlement revision 和声明 SHA，迁移保留无法归属的旧 blocked。先持久化关闭意图，再 claim 持久化尝试次数；精确三项匹配后同事务释放、保留 Cancelled 和写 settled。重启保留匹配的 cancelling 意图，不给 unknown 造声明。页面列表/GET/SSE 使用同一元组；旧版本丢弃，同版本矛盾禁发并 GET；恢复时删除旧对象 conflict 标记，草稿保留。

最终本地回归 24/24、失败/取消/跳过 0，175537.9657 ms，日志 work/desk-versioned-local-r1.log。含实际共享 EXE 的 HTTP 5组、实际 Chrome 7组、Store 5组、纯状态 3组及基础等 4组。两份 TS 检查/构建通过。三组 Chrome 事件排序与 Store 的关闭回执是受控种子数据，不能当 Core 结算证明；实际原生停止仍 blocked，测试有此断言。

[清单](../evidence/desk-versioned-inputs-20261103.json)SHA `5dcfb8f93044843f177f51e67667e3c8b491666176f3956046c40802f825a921`，168 来源、3 JS、393 原件、126 启动 pin；sourceIdentity `3e5832d895049c5b35d96b472e5faf18092f07a700696d84f387fd53a4af8a28`；副本 work/desk-versioned-source-17dc0c7d-267c-40d9-a7b4-795498471d52。127 项旧共享来源不变。侧车 SHA 仍 8888878cf51bafb40b28c33e9c2662fd9e072f11e72f4b4c693b3af969244bb0、23147520 bytes，路径 E:/usr/var/cache/rust-target/reach-static/x86_64-pc-windows-msvc/debug/ara-agent-lite-jsonl.exe。本轮无 Cargo，不重跑旧 78 项长矩阵。

独立复核复用 /root/reach_plan_review，报告 work/desk-versioned-review-20261103.md。它发现 Object.assign 残留 conflict 的 P2，已修复，实际 Chrome 核对后可输入发送。主代理已查看恢复截图。本轮首次 Store fixture SQL 占位符失败、首次冻结 SVG 路径失败均保留为失败记录，最终断言未放松。

主代理已完整回读独立报告；work/desk-versioned-final-check.json 直接核对168当前来源、171来源/JS副本、393原件、两个EXE路径及126启动pin，全匹配；5文档104本地链接通过，git diff --check exit0。清单不包含报告/主证据/本交接/最终检查自身，避免循环摘要。

独立报告最终SHA为 `71abc0384bf75fb2b9431d6fb248c3984f77a33da32ec3647d2d15e2a328019e`，主代理已回读最终补充并直接验SHA。接受范围仅Store/UI状态基础；Host自动结算和实际停止续聊保持未完成。

**Host 尚未接 SDK closeTask 或 Store 新入口。** 不要因为存储/页面基础已实现就声称停止后续聊可用。下一步先做完整 Core 只读 inspect，再接 Host；共享关闭合同继续以[前一交接](2026-11-03-desk-close-local.md)为准。

独立调查重点：memory_propose/experience_propose 写候选，管理命令能 accept/revoke/correct；普通对话还写引用、summary/cloud 状态。纯文本或八工具白名单都不是零效果。可复用 Core 私有 SessionState 与 validate_transcript、公开 Store::load_window、Journal::read；需拆开 Journal::open 的 migration 清理来获得纯读模式。Journal::proof 只校验边界，不代表全范围已读。先保存原 Task 前只读基线和最终持久快照，在 close 同一 Session 锁下复核指纹，重复 released 复用旧存证，不能读新 Task 状态重建旧结算。

待验：真实 propose/命令/summary 与错误或取消后的最终状态，缺失/损坏 context、外来 Run/旧快照拒绝；原固定 EXE/profile、声明先落盘、Store 三项匹配后实际原会话续聊；设备/Node/委托及其余首版事项。服务器与真实模型待明确恢复。没有活跃本点测试进程，fixture/Chrome 已关闭；无需重跑本轮未变范围。
