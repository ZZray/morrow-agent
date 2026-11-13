# Reach Desk 会话阻挡与页面恢复：本地验证

作者：Ray Zhang（Ray）。日期：2026-11-03。

本轮只做本地开发与测试，没有 SSH、服务器读取、远端模型请求、部署、提交、推送或安装。用户要求服务器关机备案期间先本地测试。基础任务仍为 0/52，Desk 仍为 0/5。

## 本轮改动

数据库升级到 schema v2。会话保存 `blocker_task_id`、`settlement_revision` 和 `declaration_sha`；旧版无法确认归属的 blocked 会话继续阻挡。关闭意图和原进程 joined 结果先在事务中保存，随后才能领取一次关闭尝试。重启保留意图、原状态和已用次数，不为旧 unknown 补造声明。

Store 的释放入口同时匹配 Task、版本和声明 SHA，在同一事务内释放会话、保留消息的 Cancelled 状态并写 settled 事件。迟到的旧任务完成不能覆盖新 blocker；失败的关闭保留阻挡。这里提供的是 Host 使用的存储机制，Store 本身不证明 Core 效果已结算。

列表、会话 GET 和 SSE 使用同一版本状态。页面忽略较旧版本的 true/false；同版本矛盾暂时禁发并重新 GET 核对。核对成功后删除原对象残留的冲突标记，恢复输入，保留草稿。页面沿用现有设计，反馈只说明真实核对状态，不新增动画。

实际修改的七个源码/测试文件：

- `platform/src/store.ts`
- `platform/src/web.ts`
- `platform/web/desk.ts`
- `platform/web/settlement.ts`
- `platform/tests/store.test.ts`
- `platform/tests/settlement-view.test.ts`
- `platform/tests/web.browser.test.ts`

新增的 settlement JS 仅由选装静态资源白名单提供，默认基础服务仍不加载 Desk。

## 已执行结果

Windows；Node 24.21.0、Bun 1.4.3、TypeScript 5.9.3；Chrome 156.0.8078.80、Playwright Core 1.64.1。

工作目录为 `E:/repos/ara/apps/reach`。最终两份 TS 检查/构建均 exit 0：

```powershell
node_modules/.bin/tsc --project platform/tsconfig.web.json
node_modules/.bin/tsc --project platform/tsconfig.json --noEmit
```

最终回归命令：

```powershell
$env:REACH_DESK_SIDECAR='E:/usr/var/cache/rust-target/reach-static/x86_64-pc-windows-msvc/debug/ara-agent-lite-jsonl.exe'
$env:REACH_PLAYWRIGHT_ENTRY='E:/usr/opt/playwright-core-1.64.1/node_modules/playwright-core/index.mjs'
node --test --test-concurrency=1 platform/tests/store.test.ts platform/tests/settlement-view.test.ts platform/tests/events.test.ts platform/tests/lifecycle.test.ts platform/tests/default.test.ts platform/tests/shutdown.test.ts platform/tests/cloud.integration.test.ts platform/tests/web.browser.test.ts
```

**24/24 通过，失败/取消/跳过均为 0，175537.9657 ms，exit 0。** 原始输出为 [完整本地日志](../../work/desk-versioned-local-r1.log)。

| 范围 | 数量 | 证据边界 |
|---|---:|---|
| Store | 5 | v1 迁移、真实子进程自然退出后恢复意图、三项匹配及旧完成晚到、次数耗尽重启、事务回滚；关闭结果由受控 fixture 提供 |
| 页面状态合并 | 3 | 旧 true/false、同版本冲突、缺失/非法元组；不依赖 DOM |
| 实际共享 Rust 进程与 HTTP | 5 | 同原生 Session 两任务、去重、断线/主动停止、认证退出过期、杀进程与重启、Host 关闭；上游仅 loopback |
| 实际 Chrome | 7 | 三组实际原生对话/断流/晚到 GET；同 Cookie 入口；三组受控事件排序；包含 390px、草稿、停止 partial 和退出 |
| 基础/事件/生命周期/关闭 | 4 | 无平台及无模型配置启动、原始 UTF-8 事件、提交前 socket 关闭、并发信号共用一次关闭 |

七组 Chrome 启动各固定 18 项来源/生成 JS/EXE，共 126 项 SHA 与最终来源一致。真实原生停止的测试仍断言输入被阻挡，并未把种子数据里的释放当作 Core 成功。

关键原件：

- [迁移结果](../../work/desk-store-v1-a545a8a2-6591-4b7d-aa69-ae16514b7f3f/verified.json)；[真实子进程退出及重启](../../work/desk-store-restart-7b2022c1-378c-4f0e-af1c-9410523d4105/verified.json)。
- [实际 Chrome 主流程](../../work/desk-browser-42878291-6a69-4ea4-9371-cd36b4fc8247/verified.json)；[390px 停止页面](../../work/desk-browser-42878291-6a69-4ea4-9371-cd36b4fc8247/stopped-mobile.png)。
- [旧 false 不能释放新 blocker](../../work/desk-browser-b3fc5767-2a69-4b28-abd9-fadc1346cb0f/blocked-replay-verified.json)。
- [旧 true 不能重新阻挡已释放状态](../../work/desk-browser-9cc85d7a-612e-4d0a-b384-c973607fb8ed/released-replay-verified.json)。
- [同版本矛盾、第二次 GET 恢复及草稿](../../work/desk-browser-36d8388a-7087-418c-b4a1-9f0941ecdaba/conflict-verified.json)；[恢复截图](../../work/desk-browser-36d8388a-7087-418c-b4a1-9f0941ecdaba/conflict-recovered.png)。主代理与独立复核均查看截图。
- [默认无 Desk 进程](../../work/desk-default-81a4b7ca-ce06-48ba-8f41-26b976026bda/verified.json)。

最初 Store 单跑有一个 v1 fixture SQL 占位符比字段多一项，修正后 5/5；未削弱断言。冻结脚本首次使用了不存在的 SVG 路径，原失败保存在 [首次冻结日志](../../work/desk-versioned-freeze.log)，改用实际 `assets/brand/reach.svg` 后成功。两次故障均不是通过记录。

## 来源及复核

仓库 dev，基准 HEAD `90f2b1cdd138129e2d331d89a37d70852e849739` 加保留 WIP；七个目标仍未跟踪，不以 HEAD 差异冒充当前内容。

[冻结清单](desk-versioned-inputs-20261103.json)包含 168 项来源、3 项生成 JS、393 项原件和当前侧车副本；SHA256 为 `5dcfb8f93044843f177f51e67667e3c8b491666176f3956046c40802f825a921`。来源身份 `3e5832d895049c5b35d96b472e5faf18092f07a700696d84f387fd53a4af8a28`；副本位于 `work/desk-versioned-source-17dc0c7d-267c-40d9-a7b4-795498471d52`。来源数量不是测试覆盖率。

当前普通侧车仍为 23147520 bytes、SHA256 `8888878cf51bafb40b28c33e9c2662fd9e072f11e72f4b4c693b3af969244bb0`。与[上一关闭机制固定点](desk-close-20261103.md)的 127 项共享来源逐项相同；本轮未改 Rust、未跑 Cargo、未重跑旧耗时矩阵或依赖公告检查。实际 HTTP/Chrome 使用该原生 EXE，不把旧源码检查当作本轮全 Rust 验收。

独立 Codex `/root/reach_plan_review` 按 `ara-git-review` 只读检查七个文件及调用方/原件，发现 P2：`Object.assign` 不会删除旧 `settlement_conflict`，GET 成功后仍禁发。已修复，并由实际 Chrome 验证复用对象恢复。[独立报告](../../work/desk-versioned-review-20261103.md)记录最终结论。此报告不扩大为完整 X02 验收。

主代理已完整回读独立报告，并[直接核对](../../work/desk-versioned-final-check.json)全部 168 项当前来源、171 项来源/JS 副本、393 项原件、两个 EXE 路径与 126 项浏览器启动 pin，摘要均匹配。5 份文档 104 个本地链接通过，`git diff --check` exit 0；这些摘要和链接检查不代替行为断言。

humanizer 在项目技能、已安装技能和本机知识目录未找到，已人工审读术语、状态和链接。全仓旧归档链接失败见上一固定点，本轮不重跑未改全仓检查，不称全仓全绿。

## 尚未完成：停止后在原 Session 续聊

`platform/src/host.ts` 本轮没有修改，**尚未调用 Store 的关闭意图/释放入口或 SDK closeTask**。自动原会话续聊仍未实现，不能用上述两组种子释放/冲突场景替代实际停止结算。

独立调查确认，八个内置 Session 工具并非零效果：`memory_propose`、`experience_propose` 会写 context 候选；管理命令能 accept/revoke/correct；普通对话的引用和自动 summary 也会更新 context。进程 joined、无外部工具或 pending 为空，不能单独证明这些状态已核对。

下一步先补共享 Core 只读检查：复用原生 transcript/Journal/context 校验，记录原 Task 前后原件和实际效果；`Journal::open` 会清理 migration 标记，不能直接当作纯读；`Journal::proof` 本身不逐条校验整个范围。需要真实候选写入、管理命令、summary、错误/取消写入、损坏/缺失 context 与旧快照拒绝测试。然后接原执行 profile、不可变声明、原固定 EXE 的有界同声明重试，以及实际 Chrome 停止 → 结算 → 同 Session 新消息。

设备调用、委托、完整安装/SCM/SYSTEM/干净机、真实远端模型和 Ray 长流/上线仍未验收。服务器限制继续有效，未等待用户重复授权本地工作。
