# Codex 通过 Reach 读取原截图

作者：Ray Zhang（Ray）。日期：2026-11-03。范围：C06/C07/T06 的图片消费证据，完整任务保持进行中；不接受 R07、跨机或安装生命周期。

真实 Codex CLI 经 Reach MCP 读取了一次 Windows 桌面截图，正确回答仅绘制在像素中的随机码和图形顺序。主代理直接查看原图，并核对模型工具事件、PNG 字节和 Node/服务账本。此次没有修改生产代码、构建 EXE、更新 Ray 或安装程序。

## 执行和结果

隔离服务、账户、Controller 和普通 Node/helper 先完成配对。WinForms Paint 绘制七字符随机码及打乱顺序的三个图形，不把答案放进控件文本。真实 Screenshot 操作完成后，Controller 下载原 PNG 并核 SHA；窗口可见/前台和三处中心 RGB 全部通过，才允许启动模型。画面随即关闭，模型只能取回原 operation 的图片。

使用本机已登录的 Codex CLI `0.166.0-alpha.5.1`、`gpt-6.1-sol`、low reasoning、OpenAI Responses HTTP 路由。未读取或复制登录秘密。临时配置关闭 shell、view_image、apps、web，空工作目录只开放三个 Reach 读取工具。这是隔离验证配置，不是 Reach 产品权限模式，也不证明 OS 沙箱。模型限时 180 秒、最多转发 6 次工具调用，任何超额尝试都使测试失败；外层测试 240 秒并中止自身进程。CLI 没有本轮已知硬 token 限制，记录实际 usage，不声称具备 token 硬预算。

最终 r3：1/1 通过，总耗时 38.809 秒。原件目录 `work/codex-vision-dd565079-c3b5-4062-b8f1-3f49c6531cdc`，日志 `work/codex-vision-real-r3.log`。

| 项目 | 实际结果 |
|---|---|
| 原操作 | `e76c8f03-a121-477c-ae40-df06c9e59ded` |
| 原产物 | `4b5e5e56-0317-4764-864a-772c37413538` |
| PNG | 656×359，9,353 bytes，SHA256 `b97c1212b282e898d83d0b8138c1d0b0ada18f3ca2ba3f3902ef8322960c840d` |
| 答案 | `AMC7VYL`；从左到右：蓝三角、绿圆、红方形，全部匹配 |
| 模型调用工具 | `reach_operation`、`reach_artifact`，2 次尝试、2 次转发，无超额或其他工具事件 |
| usage | input 47,278，cached input 34,048，output 344；缓存是输入的子集 |
| 账本 | 只有 describe 和 Screenshot 两项操作；原 Screenshot 两端各 6 条事件完全对应，全部 ACK，终态 succeeded |

prompt、工具参数及 MCP 文本回执均无随机码。Codex 原事件内的 image、observer 摘要和下载文件 SHA 一致。正确答案与原图片、调用链共同支持模型消费结论；observer 单独只证明图片送达。Host 合作停止及 finally 清理完成后才写 passed 回执。收尾检查没有本轮 Reach/helper、画面进程或服务监听残留。

## 保留的失败与修复

三次测试尝试实际只有两次启动模型，不能把准备阶段失败计作模型调用。

| 尝试 | 原件与结果 | 后续处理 |
|---|---|---|
| r1 | `work/codex-vision-f80357b0-b98d-40e3-bb01-9c1a732b7312`；截到下层 Codex 页面。模型答 unreadable，与期望不符；没有 passed 回执。2 次 MCP，PNG 13,665 bytes，SHA `9096904420cec9fae7016881c63fa0f0a7a571085308291681e91265889624f2` | 增加窗口前台确认和模型前像素门禁。保留 5 次 WebSocket 失败及 HTTP 回退，后续显式 HTTP-only |
| r2 | `work/codex-vision-6ffe8156-4b61-4bae-8602-c18067ca97c3`；21.414 秒后等待 surface.json 超时，stderr 空；没有图片、trial 或模型事件 | 给 PowerShell 数组中的减法补括号，Timer 异常写独立文件。r2 没有异常原件，不能把怀疑的解析问题当已证实根因 |
| r3 | 上述最终成功目录 | 三色像素门禁和实际模型图片识别通过 |

r1 实际 usage 为 input 78,163、cached 57,088、output 315。两次真实模型试验累计 input **125,441**、其中 cached **91,136**、output **659**；不只报告成功轮成本。r3 stderr 保留 PowerShell shell snapshot 不支持和本机 script-master Skill frontmatter 错误；这两项未阻止任务完成，不扩修其他配置。

## 测试变化、复核与来源

新增 `tests/codex-vision.integration.test.ts`、`tests/vision-fixture.ps1`、`tests/fixtures/mcp-observer.ts`；`tests/native-fixture.ts` 补初始化失败清理。独立复核发现并修补了超预算尝试未拒绝、过早写 passed、form 在 try 前创建、外层超时未停止测试异步体四处验证缺口；最终源码由 r3 执行行为及后验来源检查支持。

另加 `tests/mcp-observer.test.ts`：真实 observer 与受控后端两个进程，无模型，验证前六次原图片回执逐字节透传，第七次拒绝且后端未收到。1/1 通过，201.189 ms，原件 `work/codex-observer-check.log`。最终 `bun run check` 通过，日志 `work/codex-vision-final-typecheck.log`。生产源码和两个普通 EXE 与前轮相同，未重复 Cargo 或六组桌面回归。

[输入清单](codex-vision-inputs-20261103.json)固定当前 79 项源码、两个 Reach EXE、实际 CLI/Python 摘要及 41 项原件。前轮 75 项中 74 项相同，唯一漂移为 native-fixture；新增四个测试文件。sourceIdentity 为 `93f300fce5723e19a6ed9c717fabc3a16be284ff60b1566e603cab9baab3fc44`，清单 SHA `feebd101e78256ca25d09d53a522343ff99d81fde15e7c6993ad4aeb0af11ab6`。源码快照在 `work/codex-vision-source-5f03c1b0-a30c-422a-aa19-5fccdb998da5`。

独立复核指出服务 SQLite 的已核事件仍在 WAL：4,096 bytes 的主文件不能单独绑定这些记录。最终清单已补原 828,152 bytes 的 `service/reach.sqlite-wal`，SHA `d54850d4261ffac36c61eef91385e856752c26ffce1e27ebe8d9ed6faed7b705`；两个文件须成对保存，未 checkpoint 改写原件。Node 库无待保存 WAL。

限制：r3 的 trial.json 未在执行前记录源码摘要；当前清单是**后验源码、mtime 和实际行为的对应核查**，不是执行前内容冻结证明。核心测试 mtime 07:59:06 UTC，其他三个执行源 07:58:02 UTC，原运行目录从 07:59:07 UTC 开始。保留该限制，不为补元数据重耗真实模型。

独立复核使用既有 `/root/reach_plan_review`，范围和结论见[复核报告](codex-vision-review-20261103.md)。主代理已核原图、两次 MCP 图片及文本、实际两端事件和 74 项来源/两个 EXE；直接核查结果在 `work/codex-vision-direct-verification.json`。按项目 point-delivery-audit 收尾；humanizer 未找到可用入口，文字人工审读。此点补足实际 Codex 加载及图片识别证据；完整 C07 的 Codex 跨机命令/文件故障链、R01–R07、SYSTEM/WTS 和真实安装仍开放，基础 0/52、选装 0/5 不变。

主代理已完整回读最终报告，SHA `434bbbd50b1dd955f1097bb062692c31af8a92490d4f21788d79583436f3e578`，结论仅接受上述图片消费执行点，无剩余确认阻断。最终核对 7 份文档、108 个本地链接、79 项当前/快照来源、2 个 EXE、41 项证据均通过，原件 `work/codex-vision-final-check.json`；`git diff --check` 通过。全仓历史/外部断链没有重跑或宣称关闭。

收尾时另一次临时设置 `core.autocrlf=false` 的 diff 检查将既有 CRLF 报为 trailing whitespace；未据此改写已冻结来源。恢复仓库原配置的 `git diff --check` 返回 0，日志 `work/codex-vision-diff-check.log`。
