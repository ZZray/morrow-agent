# Reach Desk 设备工具：本地接线证据

作者：Ray Zhang（Ray）。日期：2026-11-04。范围为本机普通 Reach Node、共享 JSONL 侧车、真实 Reach HTTP/SQLite、受控 loopback 模型及 Chrome。两台测试 Node 是同一 Windows 主机上的隔离实例，不是跨两台物理机器的验收。未访问服务器、探测远端模型、部署、安装、提交或推送。

基础任务仍为 0/52，Desk 选装仍为 0/5。本证据不完成整个 X03，也不替代 R01–R07 委托及图片输入。

## 用户可做的事

页面可选择已配对设备及其绝对工作目录，再提交消息。每条消息保存自己的 nodeId、epoch、cwd，以及服务核实的平台和名称；新选择只影响后续消息。模型的设备工具说明包含本 Run 固定目标，原用户正文和管理命令保持原样。没有目标时继续纯云端对话，不注册设备执行工具，设备命令不在云 Host 的 Session 工作区运行。

云端工具提供一次执行、原 operation 查询、结果/事件正文分页、产物清单及范围读取。沿用 Reach 的账户、配对、队列和操作账本；Desk schema v3 仅增加消息目标及调用到 operation 的映射。内部 submit 在原事务中核对当前账户、配对 epoch 和实际能力。Windows 拒绝依赖隐含盘符状态的 `C:relative` 路径；命令使用所选 cwd，相对文件路径按目标平台解析，绝对路径不被额外限制到 cwd 内。

每个工具调用在产生设备效果前保存完整 intent：用户、消息、Task、Run、native call ID、原参数及摘要、固定目标、规范化命令和确定的 requestId。已入账的原请求可按账户/requestId 查回，旧回执和取消不依赖当前节点是否重配；不得用原 ID 改参数或改目标。同一调用的重复 callback 读取原回执，不另建操作。

正常回答验证和停止结算都枚举全部持久调用。已知失败保留失败收据；未知效果保持阻挡，进程树停止不表示效果已撤销。设备效果已完整结算时，Host 复核原生调用/结果、完整事件、SDK RPC 关联、原始设备收据及当前原 operation 终态，再使用原声明关闭 Task，允许原 Session 续聊。没有复制 Core 循环。

重启使用服务装配提供的账户级原操作能力，按当前 conversation blocker 枚举相关 intent，覆盖 cancelled+blocked 的消息。服务已入账但 Desk 丢失 operationId 时，按原 requestId 找回并核对规范化 command/payloadHash，补足映射，只取消原操作、不重新提交。恢复报告不把原 unknown 改成成功，也不接受业务 Task。

## 冻结版本和测试

[第一阶段输入](../../work/desk-devices-20261104/inputs.json) SHA `6cd99ebb887f9466e8dfbe4c56d6974cf844e0c5095c985fd9af141ff374479c`，包含 18 个源码/构建/测试输入及对应源副本，快照目录为 `work/desk-devices-20261104/source-1793723930087`。该阶段 r1/r2 运行期间源码未改。收尾另补页面已知拒绝状态，只改 `desk.ts`、生成的 `desk.js` 和追加的浏览器测试；[补丁输入](../../work/desk-devices-20261104/inputs-r2.json) SHA `ba3c366d3ecfd14afa6266271b4ba4a905af2c07b26b8764533eaf56cc53977a` 单独保存，不覆盖旧快照。后端未变。普通侧车仍为上一版本 SHA `2f858a77ba86bd8b201f7184b5afb7a10afc674ad8668cf49354c44174dc8353`；本次没有修改或重编 Rust。

本轮 53 个不同测试函数取得通过证据：设备集成 6、后端/服务 39、Chrome 8。原阶段 52 个函数与 UI 补丁新增 1 个函数分开绑定；不是 53 个都在最后 UI SHA 下重新执行。函数数不等于任务清单完成数。

| 执行原件 | 实际结果 | 范围 |
|---|---|---|
| [native-r1.log](../../work/desk-devices-20261104/native-r1.log) | 6/6，270.162s | 普通 Node + 侧车的文件/命令、已结算后停止、运行中 unknown、重配、能力/参数拒绝，以及新 Chrome A/B 选择 |
| [backend-r1.log](../../work/desk-devices-20261104/backend-r1.log) | 37 通过、2 超时取消，共 39；349.251s | 真实服务进程、身份/原账本、schema v3、Host/原会话、调用映射、UTF-8及基础无 Desk |
| [backend-r2.log](../../work/desk-devices-20261104/backend-r2.log) | 2/2，40.375s | 原 60s 测试预算下串行重跑候选/命令/续聊和断流/显式停止，分别 24.525s、15.708s |
| [browser-r1.log](../../work/desk-devices-20261104/browser-r1.log) | 6/7，200.186s | 既有浏览器登录、历史、停止、旧查询/事件、版本冲突；断流夹具未读到首段而失败 |
| [browser-r2.log](../../work/desk-devices-20261104/browser-r2.log) | 1/1，17.153s | 原预算和源码下串行重跑该断流恢复函数 |
| [browser-r3.log](../../work/desk-devices-20261104/browser-r3.log) | 2/2，28.567s | UI补丁后的真实断流回归和新增已知目标拒绝/草稿保留；前者与上文重叠，不重复计数 |

首批三组并行运行。保留两项超时及一项断流失败，未因通过复测删除原件，也未认定具体性能根因。原批句柄全部终态后，才按原源码、原预算串行复测三项；没有为通过而提高时限或改断言。此前独立 13 项/3 项试跑与这里重叠，不重复累加；SDK/Rust 长矩阵没有无改动重跑。

`tsc --noEmit`、platform 类型检查和 Web 构建均 exit 0；UI补丁后 Web 再构建，`git diff --check` exit 0。[第一阶段检查](../../work/desk-devices-20261104/check.mjs)核 18 个输入/副本、37 个测试根、294 个原件引用、19 份设备回执和 21 条 released 关闭链，摘要全部匹配；[原结果清单](../../work/desk-devices-20261104/checked-inputs.json) SHA `4496081978e7351472a9fb6149d2867f68e79416be5977f8a8d6ccfc85d502fc` 保留。[分层检查](../../work/desk-devices-20261104/check-ui.mjs)再核 19 个当前输入、18 个原副本、3 个补丁副本和 39 个测试根，原引用/回执/关闭链未变；[最终清单](../../work/desk-devices-20261104/checked-inputs-r2.json) SHA `86b2bb89c0ca782d1d98a29f6bbd81ea9cf4fba4b385e8d55e1e2210774bb542`。这些数量不等于独立功能数。

## 实际效果和页面

- 文件/命令组在选定 Node 目录写入 UTF-8 文件和一次 `effect.txt=once`，读回并列目录；四个 operation 都为原 Node/epoch 的 succeeded，云端 Session 工作区没有该命令产物。随后同一 Session 纯云端续聊，重复原消息没有新 operation。根为 `work/desk-device-440e800c-7e06-4146-948a-87ea33383881`。
- 设备写入已结算后取消模型回答，原消息仍 cancelled，完整原回执进入关闭声明，同 Session 继续且原写入未重做。根为 `work/desk-device-3bc36bbf-743b-4c0b-beec-1b12dd94ea37`。
- 运行中命令先真实写入一次前缀，再取消；Node 返回 unknown 和 processTreeStopped=true，完成标记不存在，聊天保持 blocked，原消息重读不执行。根为 `work/desk-device-96253347-544c-4066-9733-010a18581855`。
- 真实 CLI 重配后，旧 Run 的工具在入账前拒绝旧 epoch；重复旧消息返回旧 Run，新消息使用旧 epoch 或用旧消息 ID 改目标均冲突。能力缺失保留 Settled+error 原回执；Core 在调用前拒绝坏 schema 时，不补造 Host intent。对应根为 `work/desk-device-eed64caa-4a9f-44e2-a466-6e19c3bb2c5a` 和 `work/desk-device-4e3b91a0-ed7d-4f81-b2d9-c96c31cff049`。
- 新 Chrome 组在 A 执行中改选 B；A/B 目录分别只有 `switch.txt=A/B`，总共两个 operation。刷新保留 B 的目标和 cwd、两条消息各自的原目标、两个成功收据；390px 页面无横向溢出，退出清除设备选择界面。根为 `work/desk-device-ce927267-1716-45fe-880e-769afcdc00f5`。
- 收尾 UI 补丁用真实 HTTP 校验坏 cwd：明确的提交前 4xx 白名单返回“本次提交未被接受”，不查不存在的消息、不伪造 Task。原输入恢复，稍后输入的新草稿优先保留。Node/模型均未调用；配对由夹具建立，不能冒充设备效果。原件根为 `work/desk-browser-177d37b5-f670-4b16-a12b-8b0deb9ac4ff`。补丁后的断流仍通过 GET 观察同一原消息，根为 `work/desk-browser-93824643-16b9-42c5-8a86-49e7a1db943f`。

主代理实际查看了[桌面截图](../../work/desk-device-ce927267-1716-45fe-880e-769afcdc00f5/targets-desktop.png)和[390px截图](../../work/desk-device-ce927267-1716-45fe-880e-769afcdc00f5/targets-mobile.png)。按 emil-design-eng 和 ui-delight 延续现有安静的工作台主题，不增加高频切换动画。

| Before | After | Why |
|---|---|---|
| 页面只有云端对话位置提示 | 原生选择框、设备 cwd、下次目标摘要 | 持续显示下一条消息的执行位置，保持键盘可用 |
| 历史消息没有设备来源 | 消息保存名称/cwd，原 operation 状态单独显示 | 切换目标后仍能核对实际发生位置 |
| 刷新中无消息时缓存默认云端 | 用户显式选择优先，否则从已加载历史推导 | 避免刷新后丢失设备目标，同时保留明确选择的云端模式 |

## 复核和保留的失败

独立 `/root/reach_plan_review` 按 ara-git-review 复核 11 个生产/UI 文件及相关调用链/测试，并补审收尾 UI 拒绝补丁。其 [报告](../../work/desk-device-review-20261104.md)明确范围、阶段与未覆盖内容。第一阶段四个轻量检查的[原件](../../work/desk-device-review-final-probes-20261104-dc08c991-3c4e-49e3-ab68-a95075ce448c/results.json)核对历史目标/显式云端选择、UTF-8分页、两类重启状态查原 op、只清理原操作。它们与 A 冻结输入一致，不冒充后加的拒绝分支测试；UI补丁由新 Chrome 函数和独立补审验证。主代理回读最终报告，不把中途混合快照探针计入通过。

A/B 最终报告 SHA `fee09f135356205e6f43f75baa2087cfc50fb74f608516344aa65f440e7430fe`，结论为未发现剩余已确认阻断缺陷，范围仅限本执行点。B 的[独立结果](../../work/desk-ui-rejection-review-probe-results-20261104.json)为实际 stream 函数的18个隔离分支通过：白名单拒绝、后续草稿、切换会话、迟到旧登录响应及各类未知传输路径；未启动浏览器/服务/设备/模型。主代理完整回读报告、该结果及[分层回查](../../work/desk-ui-rejection-review-checks-20261104.json)，核对摘要。独立探针不计入53个业务测试函数。最后7份相关文档的本地链接检查及diff-check通过。

审查发现并已修复：历史请求前 paint 缓存 null 导致刷新丢目标；过小 UTF-8 页返回零进展游标；重启遗漏 cancelled+blocked 消息；跨库入账后丢映射未回填。另检查并修复读取错误误取消正在读取的原 operation、恢复的 command/payloadHash 绑定。

实施中失败均保留：

- `work/desk-device-cdc9ff2d-5037-49fa-a9fc-2947bda20e30`：给不支持 brief 的 JSONL v1 添加 run.brief，start_config_rejected、exit 2，未执行设备动作。改用已固定工具说明承载目标，没有扩大共享协议。
- `work/desk-device-0f5afc2f-144e-46b7-861a-dd19432bcfc9`：内部富目标的名称/平台被 strict 输入 schema 拒绝，已修为只传绑定字段。
- `work/desk-device-db53984f-c705-4e88-b003-667889e02cac`：生成 output schema 错将默认 offset 设为 Core 必填，且 Store 从错误层级读取结算字段；返回保守阻挡，未误放行。现使用 input schema 并读取 reply.settlement。
- `work/desk-device-46da981b-0667-42e8-a4bc-3ad48bd185de`：原生失败结果带固定 `tool error:` 外壳，初版直接解析 JSON 而拒绝关闭；现按固定镜像格式核对正文和原 Host 回执。
- 新浏览器早期分别暴露夹具 publicOrigin 缺实际端口、select 缺稳定 accessible name、历史目标缓存问题；失败根为 `b6a418f1`、`e3cb5dc0`、`2f33a255` 对应的 `work/desk-device-*` 原目录。当前集中组实际通过。
- 首次 device-tools 单测夹具多传 revoked 字段被拒绝；修夹具后重新运行。它不作为产品操作失败或真实 Node 效果证明。

人工 Node 回执的 Store/Host 夹具与真实 Node 集成分开报告。跨库保存故障测试在真实两个 Store 上注入映射写入错误后重新装配 Host，不称为一次物理掉电或真实 OS 崩溃。

## 剩余工作

真正图片输入需要共享 typed image 结果及原图校验；当前 base64 范围读取只证明原始字节可取回。现场 Agent 委托、任务/技能传递、旧平台历史与完整能力迁移、正式组织模型多轮、真实跨机、SYSTEM/UAC/升级卸载和 Ray 上线仍需继续。当前普通安装候选和服务器未更新，用户的仅本地限制继续生效。文档手工审读并检查本地链接，没有声称运行缺失的 humanizer。
