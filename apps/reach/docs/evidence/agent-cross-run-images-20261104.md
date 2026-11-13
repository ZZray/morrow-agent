# 同 Task 跨 Run 截图：本地证据

作者：Ray Zhang（Ray）。日期：2026-11-04。范围：R01/R03 普通候选反馈后的原图接续。本点只使用本机受控端点，没有访问服务器、远端模型、部署或安装；基础清单仍 0/52，Desk 仍 0/5。

同一 Task/Session 的两个 Run 各取得一张实际 Screenshot。调用方提交 continue 后，第二 Run 的首个模型请求保留图 1，后续请求同时包含图 1 和图 2。131072 与 32768 两种 contextWindow 均通过，最终为 awaiting_review、taskAccepted:false。这证明图片传输和原件连续性，未证明真实模型的视觉理解。

## 固定身份与运行

父仓 dev、HEAD `90f2b1cdd138129e2d331d89a37d70852e849739` 加原 WIP。快照 `work/agent-cross-run-images-20261104/inputs-r1.json` SHA256 `ecf2213ff491b689be4b35670e816dabae0be1c90c90d379588b69052b572f29`，172 源文件及副本、4 个 runtime；相对前一多 Run 点只新增截图测试分支和两个函数。

- Node：`work/agent-multirun-20261104/runtime-r4/reach.exe`，SHA `f32434dbb5ed4e5ebe119893627d0a32cbc9ce2f4fead4cb246762b33cc64dd1`。
- 侧车：`work/desk-images-20261104/runtime-final/ara-agent-lite-jsonl.exe`，SHA `0275185113786a971fad17307c4cefcd0de4d2c0666bcb857d9cc20b2e26a344`。
- desktop/Python：分别为 `0ea7c0b2c6117b04163614010771d1b1532f7b8dc49fa47af8dda5dc7778eea2`、`4942b86a6597e5aee0128daa00050ed79bc21f6e709a78eb19cbfeb0c2f39ac9`。

从 `apps/reach/`，设置 `REACH_NODE_BINARY`、`REACH_DESK_SIDECAR`、`REACH_DESKTOP_BIN`、`REACH_DESKTOP_PYTHON` 为上述固定运行物后，测试入口为：

```powershell
node --test --test-concurrency=1 --test-name-pattern='two original screenshots cross|a 32768 context retains' tests/agent-desktop.integration.test.ts
bun run check
```

`work/agent-cross-run-images-r1.log` 为 **2/2、零跳过、74.292 秒**，类型检查见 `agent-cross-run-images-typecheck-r1.log`。测试时源与后续预算点不同，不能把这两次运行称为新预算镜像的执行证据；新镜像另见[预算证据](agent-budget-20261104.md)。

## 原件与独立回查

| 原件根（相对 work/） | 实际结果 |
|---|---|
| `agent-desktop-131072-381f3c97-251b-4cc6-b839-17a1cc54544d` | 同 Task/Session、2 Run、5 模型、3 child、51 outbox、2 PNG |
| `agent-desktop-32768-51ec0017-090d-49d6-bce2-67e77c2a111a` | 同型较小 context 流程；同上计数 |

两组 provider 请求的图片数量均为 `[0,0,1,1,2]`。原 Run 1 的 raw range 为 `[0,6)`，Run 2 为 `[6,10)`；Run 2 的 full_proof 覆盖 `[0,10)`，与当前 Run 的 range_proof 分别核对。每张 656×359 PNG 从原 outbox chunks 重建，逐字节绑定 Task 原图、native typed ToolResult、图片 proof 和 provider 图片输入；按原窗口定义核过色块像素。每根 started-inputs 的六项实际启动测量均匹配冻结，未冒充启动时测量全部 172 份源。

独立复核 `/root/reach_plan_review` 完整读取测试增量、原 SQLite/journal、模型 intent/transport、反馈及 prepare、候选/receipt 和原图片，接受本机范围，无新增确认缺陷。合计 **2 Task / 4 Run / 6 child / 102 outbox 全 ACK / 10 模型 / 4 PNG**；原 14 个不同 PID 在独立检查时均不存在，未停止进程。

独立报告 `work/agent-cross-run-images-independent-review-20261104.md` SHA `d7a1a269c6e6bdcc08d41965ed30841f83cec179a305c9d48eed463af33b7239`，审计脚本/JSON/退出记录四份摘要在报告内。主代理已完整回读；随后与预算报告一起复核全部 22 个审计引用，见 `work/agent-budget-20261104/review-checked-r3.json`。

该点未修改共享 Core、Harness 或产品代码，没有重跑无变化矩阵。原 Task 崩溃恢复、真实组织模型、安装及上线仍开放。此前失败记录保留于[多 Run 证据](agent-multirun-20261104.md)。humanizer 未安装，本文人工审读。
