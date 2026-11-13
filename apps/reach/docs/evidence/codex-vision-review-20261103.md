# Codex 真实读取 Reach 截图独立复核

作者：Ray Zhang（Ray）。日期：2026-11-03。执行者：独立 Codex 子代理 `/root/reach_plan_review`，沿用已读 `ara-git-review` 与 `ara-rust-core-review` 的证据边界。

**结论：接受本次 C07/T06 的图片消费执行点，无剩余确认阻断。** 真实 Codex CLI 经生产 Reach MCP 控制器取回原截图，正确识别随机码及图形顺序。服务、Node 和桌面位于同一 Windows 主机的隔离开发环境；不据此接受跨机器模型执行、完整 C07/T06、R07、安装版或首版产品。

## 目标与覆盖

[最终冻结清单](codex-vision-inputs-20261103.json) SHA256：`feebd101e78256ca25d09d53a522343ff99d81fde15e7c6993ad4aeb0af11ab6`；sourceIdentity：`93f300fce5723e19a6ed9c717fabc3a16be284ff60b1566e603cab9baab3fc44`。快照：`work/codex-vision-source-5f03c1b0-a30c-422a-aa19-5fccdb998da5`。

独立重算 sourceIdentity，核当前来源 79/79、快照 79/79、普通 EXE 2/2、证据文件 41/41、Codex/Python 可执行文件 2/2 及父清单，SHA/字节数全部一致。相对前轮 75 项，74 项未变，修改 `tests/native-fixture.ts`，新增四个测试文件；生产源码和两份 Rust EXE 沿用[长错误全文固定点](error-artifacts-review-20261103.md)。

- **reviewed**：`codex-vision.integration.test.ts`、`vision-fixture.ps1`、`fixtures/mcp-observer.ts`、`mcp-observer.test.ts` 及 `native-fixture.ts` 的初始化/清理；追查生产 MCP 的 operation/artifact 返回路径。
- **scope-excluded**：其余来源只核身份或相关调用段，不宣称完成全量生产代码、Core、Provider 或安装器审计。
- **skipped**：本代理未重跑模型、测试、Cargo、安装或部署；独立读取原始日志、图片和 SQLite，核进程/监听状态。执行日志来自主代理。

**源码关联是运行后的桥接。** r3 的 `trial.json` 只有参数，没有运行前源码 SHA/快照。参与 r3 的四份测试来源最后修改于 UTC 07:58:02–07:59:06，早于 trial 的 07:59:18 和成功回执的 07:59:45；当前源码、修改时间及运行行为相符。最终清单明确这一限制，不称运行前已冻结。后来新增的 observer 单测由另一份无模型日志覆盖。

## 原始运行与成本

| 轮次 | 结果 | 模型用量：输入 / 其中缓存输入 / 输出 |
|---|---|---|
| r1 | 1 项失败，47.604 秒；答案为 unreadable，码和图形不符，无 passed 回执 | 78,163 / 57,088 / 315 tokens；2 次 Reach MCP 调用 |
| r2 | 1 项失败，21.534 秒；表面就绪超时，无 passed 回执 | 未生成 trial、截图或 Codex 事件，未启动模型试验 |
| r3 | 1/1 通过，38.809 秒；配置模型 gpt-6.1-sol，停止及 finally 清理后写 passed | 47,278 / 34,048 / 344 tokens；2 次 attempted/forwarded |

原日志为 `work/codex-vision-real-r{1,2,3}.log`。三轮原件目录后缀依次为 `f80357b0-b98d-40e3-bb01-9c1a732b7312`、`6ffe8156-4b61-4bae-8602-c18067ca97c3`、`dd565079-c3b5-4062-b8f1-3f49c6531cdc`，前缀均为 `work/codex-vision-`。这是三次测试尝试、两次真实 Codex 试验轮次，不等于两次上游 API 请求。失败成本保留；缓存输入不再次相加，不声称费用或硬 token 上限。

另有真实 observer/后端双进程的无模型单测：`work/codex-observer-check.log`，1/1 通过，201.189 毫秒；验证六次原响应透明转发、第七次只在 observer 拒绝且后端未收到。测试使用不透明字节，不是实际 PNG。最终两项 TypeScript 检查见 `work/codex-vision-final-typecheck.log`，主代理记录通过。

## 消费证据与修补

r3 原 PNG 为 656 × 359、9,353 字节，SHA256：`b97c1212b282e898d83d0b8138c1d0b0ada18f3ca2ba3f3902ef8322960c840d`。独立目视确认 `AMC7VYL` 与蓝三角、绿圆、红方；模型答案和测试定义一致。实际 Codex 完成 `reach_operation`、`reach_artifact` 两次调用，事件内 MCP image 的原字节、下载图片、observer 摘要和 manifest 一致。

随机答案存在测试定义文件供绘制/断言，但 prompt、参数、schema 和 MCP 文本没有给出随机码。图形选项由 schema 给定，随机码与顺序仍须从图片取得。实际事件仅有 agent_message/mcp_tool_call，无 shell、Web、协作、文件修改或直接看图文件事件。observer 摘要单独只能证明输出侧转发，结合 CLI 图片事件及正确随机答案才支持消费结论；工具白名单不等于 OS 沙箱。

只读 SQLite 核对：服务仅有 describe 和 Screenshot 两个操作；截图的六条 Node/service 事件序号、种类、数据一致，全部 ACK，无另一个动作或重放。独立检查时 Node PID 16872、表面 PID 23600 均已退出，代理端口 52649 无监听。这证明观察到的正常收尾，不扩为所有故障路径保证。

| 确认缺口 | 已核修补及边界 |
|---|---|
| 第七次调用只记 overflow，验收却只数前六次，可能错误接受 | 验收拒绝任何 overflow，记录 attempted/forwarded；无模型双进程单测验证第七次未转发 |
| 清理前先写 passed，后续失败仍留下成功回执 | 回执移至停止及整个 finally 完成后，r3 顺序与源码一致 |
| form 先于 fixture/try 启动；外层超时不能阻止后续模型或 passed | fixture 在 try 内完成后再启动 form；补初始化失败清理、TestContext.signal、模型前/回执前中止检查。模型 180 秒、测试 240 秒、host-stop 20 秒有界；极端超时分支本轮仅源码复查，未额外故障注入 |
| 冻结仅包含 4,096 字节 service SQLite，漏掉实际记录依赖的 WAL | 已补 828,152 字节 WAL，SHA `d54850d4261ffac36c61eef91385e856752c26ffce1e27ebe8d9ed6faed7b705`；DB/WAL 成对保留，未 checkpoint 改写 |

前台显示、像素门禁和 PowerShell 表达式修补对应早先失败，原失败记录均保留。r3 通过不抹去 r1/r2。

## 验收边界

参数、prompt、observer 日志未发现账号密钥/token；使用既有 Codex 登录与隔离 Reach 测试会话，work 目录被 Git 忽略。本代理未读取凭据文件、未抓取上游鉴权流量，不宣称所有环境变量或账号状态已审计。

本点接受普通开发 Node/helper → 生产 Reach MCP 控制器 → 真实 Codex 的原截图消费。完整远程任务、跨机器组合、所有图片情形、长期运行、SYSTEM/SCM、安装升级卸载、签名和干净机验收继续开放；基础清单和 Reach Desk 不由本点自动完成。

已完成人工事实与措辞审读。项目及本次列出的宿主技能目录未找到 humanizer 入口，未记为已执行工具。
