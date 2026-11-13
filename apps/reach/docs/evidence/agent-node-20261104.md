# 普通Windows Node委托：本地执行证据

作者：Ray Zhang（Ray）。日期：2026-11-04。范围：实际Rust Node、固定Lite/Harness侧车、本机relay、原Node Ledger/outbox与文件/命令worker。仅本地受控模型，未访问服务器/远端模型，未部署、安装、提交或推送。

本轮把前一[模型broker](agent-model-20261104.md)的测试relay/lifecycle替换为真实Node执行链路，完成单Run文件/命令及指定故障验证。业务Task仍待调用方审核。**真实截图委托、完整多Run prepare、同Task恢复、安装/SYSTEM与真实组织模型未验收**；基础仍0/52、Desk0/5，不因分项通过勾选整项。

## 交付代码与版本

仓库 `E:/repos/ara`，dev，HEAD `90f2b1cdd138129e2d331d89a37d70852e849739` 加原WIP。合同见[现场委托](../agent-delegation.md)。

- 新 `src/node/agent.rs` 直接驱动固定JSONL侧车，复用原Core/Harness循环；只有侧车配置/SHA及组织模型同时可用才声明agent.delegate。父received/running沿原账本上传，running ACK后才启动侧车。
- 新 `agent_relay.rs` 使用独立流客户端和本机随机token。组织密钥不下发，侧车环境清空后只加入必要系统变量与本机token。Task固定父dispatch、独立Run UUID、路由/镜像/Session/endpoint/token/预算和deadline；不自动恢复旧Task。
- 工具回调保留原JSON字节和SHA，经服务取得真实child Dispatch，再用原Ledger.accept、running和worker/Desktop路径。子终态先落原outbox，再等原ACK才回复侧车。读控制帧与执行工具分开，callback_cancel、父取消、uploader停止和deadline能触达实际Job。
- 原Node事务累计子output/已知终态实际JSON字节32 MiB；小型unknown诊断保留通道。超限后仍保留真实文件效果及完整rejected-result，停止后续执行。
- 大结果保留完整原件，返回4 KiB UTF-8窗口、nextOffset与SHA/resultRef；同名原件必须字节一致。图像重建与消费proof已有代码，本点没有执行真实截图。
- relay使用chunked，DONE保留到原服务模型请求状态确认stream_complete且Run/body SHA匹配；Host还核完整模型证明集合、候选basis/事件摘要/原child及最终released引用。新增Node只读模型status接口不重发、不退预算。

冻结 `work/agent-node-20261104/inputs-r1.json` SHA `f759c75996c2c2d7fc99acf4b25892154d7a46c15379d2558a5774d47ef32fbf`：167源/副本作身份覆盖，语义范围13文件，2镜像。Node为 `work/agent-node-20261104/runtime-r6/reach.exe`，SHA `f3f92fae9e2827ead074de441a25a0f617c9bc7069f95240ac1b2eada6f1df9f`；侧车仍0275185113786a971fad17307c4cefcd0de4d2c0666bcb857d9cc20b2e26a344。旧Task侧车及旧冻结清单保留，前阶段69b Node是历史版本，不冒称仍匹配新源码。

Node只启用现有serde_json的raw_value特性，未引入新依赖版本，Cargo.lock未变。不能全局启用preserve_order：Reach派发摘要仍依赖键排序，固定侧车回调则保留其原顺序。没有改共享Core/Harness/provider或Cargo缓存源码。

## 最终执行

命令从 `apps/reach/` 运行，Cargo用固定Windows静态CRT目标、单job、locked/offline；未联机更新依赖或探测模型。

| 检查 | 实际结果 | 原始记录 |
|---|---|---|
| `cargo build --target x86_64-pc-windows-msvc --locked --offline` | 最终r6通过，4.92s | `work/agent-node-build-r6.log`；六次增量构建原日志保留 |
| `cargo fmt -- --check` | 通过 | 当前冻结源码 |
| `cargo clippy ... --all-targets -- -D warnings` | r2通过 | `work/agent-node-clippy-r2.log`；r1保留needless_question_mark失败 |
| `cargo test ... --all-targets` | 10/10；构建7.43s，执行1.87s | `work/agent-node-rust-tests-r1.log`；含原参数次序、未认证relay不取消Task及原事务/IPC回归 |
| `cargo deny ... --frozen check` | advisories/bans/licenses/sources通过 | `work/agent-node-deny-r1.log`；使用缓存数据库，保留既有警告，不宣称在线最新审计 |
| `node --test --test-concurrency=1 tests/agent-node.integration.test.ts` | 最终r4为9/9，131.200s | `work/agent-node-r4.log`；时钟函数有两个场景，共10份原件 |
| 受影响普通Node原回归 | 3/3，24.882s | `work/agent-node-basic-regression-r1.log`；正常文件/命令、取消树、杀Node重启零重放 |
| 新Node模型status接口 | 1/1，3.982s | `work/agent-node-model-status-r1.log`；原父/Run/body绑定、账户凭据拒绝、解绑后原证据读取 |
| 基础/admin/platform类型检查 | 全通过，无输出 | 最终冻结版本；无UI改动或浏览器矩阵重跑 |

九个函数的实际场景：

1. 实际Node完成write-once/read-once，3模型、2独立child，文件为 `once\n`。原child与父所有事件走同一Node outbox；父awaiting_review、taskAccepted:false。
2. 读取180000字节原文件，完整原结果约240 KiB保留，4 KiB窗口与原SHA可核；2模型完成续接，没有128 KiB回复或Core上下文超限。
3. 拦住父running ACK时，服务仍received且0模型/0工具；允许原ACK后才开始模型请求。
4. 真正Windows委托命令启动隐藏后代，取消父后后代PID退出，child/parent均unknown，没有新模型请求。
5. finish之后截断broker→Node传输，父与模型unknown，原Native fence保留；没有本地假成功。
6. 原child成功事件上传被409拒绝，Node停止，实际文件只写一次；重启只补原outbox，child原成功和父unknown上传，文件仍一次，没有第二模型。
7. 注入“32 MiB只剩100B”边界后实际写文件；成功结果入账被拒绝，完整rejected-result保留，父/child unknown，没有空成功或重放。这是实际效果加预算边界注入，不是生成32 MiB产物的完整压力测试。
8. 预置同名冲突result文件，真正读取大文件后拒绝返回错误引用，冲突原件不变，父unknown。
9. 服务时钟响应分别偏移正负六分钟，Node按剩余时间和往返耗时换算本地期限，两次都正常结束且没有获得额外六分钟。

主代理 `work/agent-node-20261104/check.mjs`直接检查10份实际SQLite、文件、原Task/模型proof、outbox及预算计数：13模型请求、7个child、131个原outbox事件；输出 `checked-r1.json` SHA `18e6772cd8abb706b1f9b0bd4246059ca8e82e58f5e47447cd7def49aeee6c9e`。原Node的三组回归保存在 `work/agent-node-20261104/regression/`，未把它们算成新委托函数。

## 独立复核与保留失败

独立reviewer为 `/root/reach_plan_review`。最终报告 `work/agent-node-independent-review-20261104.md` SHA `1b126e2d62c927f26c036098b3e2859aa57b586498f5256a45c7472f445da6af`，只接受本地普通Windows单Run文件/命令及指定故障边界。

早期原件保留：r1两个函数因重排原参数而失败；r2首个功能已执行成功，但测试过早读取本地ACK产生断言失败，第二个因64 KiB窗口超过Core62976B投影预算停止。修补后r3中间7/7，最终r4九函数重新执行。r3不重复累计为新功能。

独立复现过两个实际缺陷：旧relay把finish后断流误呈现为干净EOF，曾造成Node本地succeeded而服务模型unknown；旧resultRef在文件已存在时不核字节，曾向侧车发出错误引用。两者均在冻结版本修复并各实际重放一次，不以最终服务器拒绝成功代替修复本地假成功。

独立最终原件 `work/agent-node-independent-final-9f2a06b6-f5ef-4e9b-bf41-266a9c012871/`，`review-final.json` SHA `c98c597c804d367c287ed9878cc14318bad67b6dcde309ccf8630e64f248e805`。另读取主10份原件，合计12场景、149条outbox、15模型intent、13完整transport均匹配；相关结果 `work/agent-node-review-artifacts-20261104.json` SHA `ec64c7265f59bd0002f721753d1ac437e5483c272d3b370671ef125af6df8117`。独立两例8个具体PID已退出。主代理完整回读报告，再以 `check-review.mjs`只读复查两例实际库与冲突原文件，保留 `review-checked-r1.json`。

独立检查脚本初稿曾把成功时初始保守outcome.json当成最终释放记录；已改为跟随原outcome_ref/released.json，不修改产品或任务原件，不重跑任务来掩盖该检查错误。

主代理完成五份当前文档110条本地链接及13个目标源码/测试/配置文件的空白检查，结果在 `work/agent-node-20261104/docs-checked-r1.json`；仓库根diff检查通过，仅保留既有CRLF提示。未宣称全仓历史链接或完整产品已通过。

## 剩余工作

下一步是真实Node同一委托两次截图，核独立child产物index、typed图原字节和消费proof；不能沿用服务seeded PNG作为真实委托证据。随后完成多Run prepare、原Task/Session恢复、模型unknown显式核对、R04/R05技能/来源/知识及旧平台历史。当前安装候选未加入此运行时，SYSTEM/SCM/锁屏、真实组织模型和部署保持开放。humanizer未找到，文档已人工审读。
