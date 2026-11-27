# CAS 真实模型与视觉委托本地验证证据（2026-11-14）

作者：Ray Zhang（Ray）。日期：2026-11-14。范围：M08 本地真实文本/视觉模型委托、跨进程 `continue_reviewed`、`ToolArtifact` 溯源查询与 Reach Desk 多轮/配对设备联调。仅在本地环回进程与受控环境内存中注入 `CAS_API_KEY` 访问 `https://cas.ciqtek.com/v1`，未访问 Ray 服务器，未部署或发布安装包；基础清单仍保持 `0/52`，Reach Desk 清单仍保持 `0/5`。

## 运行时身份

| 组件 | SHA-256 / 版本 |
| --- | --- |
| `morrow-agent-jsonl.exe` | `03c55e6204035096d7fa7244ebecafa5ce9f9edefe7a78f01e24223cdb650242`（M10 独立复核加固后镜像：`7988f6450379115f659e0ade5cfae48db89cb8a56bda517e925c1ee247cc4a41`） |
| `reach.exe`（M07 + `review_artifacts` 过滤修复后） | 本地 `dev` 构建（`D:\workspace\env\cache\rust-target-reach\debug\reach.exe`） |
| `reach-desktop.exe` | 本地 `dev` 构建（`D:\workspace\env\cache\rust-target-reach\debug\reach-desktop.exe`） |
| `windows-mcp` 开发运行时 | `0.8.8+reach.4`（CPython 3.14.6，`uv.lock` 锁定） |
| 测试套件 | `apps/reach/tests/cas-real-model.integration.test.ts` |

## 实跑结果（3/3 通过，0 跳过，52.802 秒）

1. **Node 真实文本多工具委托 + 跨进程 `continue_reviewed` + `provenance_query`**
   - 证据目录：`work/cas-real-node-text-7f40a9e3-3bd6-4110-95e8-4d03da0b2f4a`
   - 模型：`deepseek-v4.1-flash`（经 Reach `AgentModelBroker` 访问 `https://cas.ciqtek.com/v1`）
   - 过程与结论：首轮委托（`d2d0053d-d693-4c7a-911a-8d6036090f12`）调用 `file.read` 读取本地随机校验码并释放 `released.json`；跨进程续作（`98fbb61e-e546-4cc7-83cf-47d8181218da`）在新侧车进程中调用 `file.write` 写出匹配的 `summary.txt`；只读溯源（`00bd9d80-2be8-445e-8b4c-3001a8ad1f24`）返回 `3` 条 `reach-node-host` 已验证 `ToolArtifact` 记录，`scopeErrors: []`，`taskAccepted: false`。
   - 真实模型发现并修复的缺陷：真实模型在业务工具外主动调用 Core 内置 `task_update` 工具；初版 `review_artifacts` 回调将未验证的内置 `candidate` 原样回传，触发 Harness `Verified review references an unverified artifact` 拒绝。已在 `src/node/agent.rs` 与 `platform/src/host.ts` 修正为仅回传宿主已转移的业务工具记录（`verified` / `unknown`）。

2. **Node 真实桌面隔离窗口截图 + 真实视觉模型像素识别**
   - 证据目录：`work/cas-real-node-vision-270395e9-8997-46a4-9d9f-d6f426a940bb`
   - 模型：`gpt-5.6-luna`（`REACH_AGENT_MODEL_IMAGE_INPUT=1`）
   - 过程与结论：委托任务（`03bbcaa8-0f81-443d-a4ec-5d4d485e6d06`）依次执行 `desktop.describe` 与 `desktop.call`（`Screenshot`），捕获仅存在于渲染像素中的随机 6 位码与三图形颜色排列；原生图片证明 `run-1-tool-images.json`（`jsonl-native-images-v1`）记录原图 SHA-256 `6a7a620c80a405abf7e9c80a5039a480bd3cca222414ce02696f489aa6b99afb`，模型精确返回 `recognizedCode: "6XJ9DP"`（期望 `"6XJ9DP"`）与 `recognizedColors: ["blue", "red", "green"]`（期望 `["blue", "red", "green"]`），`verifiedArtifacts: 2`，`taskAccepted: false`。

3. **Reach Desk 真实多轮原生会话记忆回忆 + 已配对 Node 设备读取与溯源**
   - 证据目录：`work/cas-real-desk-61f97036-01ba-42f6-b5d0-5c966728c5fa`
   - 模型：`gpt-5.6-luna`（通过仅驻留进程闭包内存的本地环回转发器接入 `https://cas.ciqtek.com/v1`，侧车仅持一次性占位凭据）
   - 过程与结论：会话 `77b3e357-52f2-4cc8-982f-32852be3b12a` 首轮记住随机校验码并计算 `37 + 5 = 42`；次轮在不重传校验码条件下从同一原生 `session.json` 准确取回校验码并计算 `8 * 7 = 56`；第三轮绑定本机已配对 Node 执行 `file.read` 解码设备侧随机凭条，`GET /api/v1/desk/conversations/:id/provenance?status=verified` 返回 `reach-desk-host` 已验证 `ToolArtifact`（`verifiedDeskArtifacts: 1`，`taskAccepted: false`）。

## 零密钥持久化核查与边界声明

- 上述三次运行生成文件及 `apps/reach` 非 `node_modules` 全部跟踪/未跟踪文件合计 **1,155 个文件** 已执行精确字节扫描，`CAS_API_KEY` 出现次数为 **0**。
- 本证据证明本地进程下真实外部 LLM/VLM 与 Morrow/Reach 账本、原生图片输入、跨进程续作及 `ToolArtifact` 溯源的端到端互通；**不代表**线上服务器部署、Ray 网关统一身份或 SYSTEM/WTS 服务态验收（区别于 `agent-desktop.integration.test.ts` 等受控环回替身测试）。
