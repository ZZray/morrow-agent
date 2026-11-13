# Reach Desk 本地接续：设备文本/文件工具已接线

作者：Ray Zhang（Ray）。日期：2026-11-04。

保持仅本地开发测试：禁止 SSH、服务器读取、远端模型探测、部署，等待用户明确恢复。完整目标仍 active，基础 0/52、Desk 0/5。仓库 `E:/repos/ara`、`dev`、HEAD `90f2b1c` 加既有 WIP，不提交、推送、安装或清理；不要套用 Lumen 分支/TS-only 约定。不重复询问 UAC；安装候选仍 60a6、现代图标已完成，18912 为已停旧代理。

当前[证据](../evidence/desk-devices-20261104.md)和[扩展合同](../platform-extension.md)已更新。上一[Host 结算交接](2026-11-03-desk-settlement-local.md)作为纯云端历史固定点保留。

## 当前实现

- `src/contracts/device-target.ts`、`src/service/desk-devices.ts` 提供账户级原 Reach 账本闭包；新动作在 Store.submit 原事务核当前 epoch。旧 operation 查回/取消/取证不依赖节点当前配对，但始终核原账户、目标、command/payloadHash。没有第二套设备凭据。
- Desk schema v3：turn.target_json；device_calls 保存完整 intent、固定 requestId、operationId 和不可变回执引用。schema v1/v2 迁移保留旧消息及锁。跨库映射缺失按原 requestId 查回，不补发 intent。
- 七个 device-tools 经 JSONL callback 运行原 Node 操作，不在云 Session cwd 执行。模型目标说明放在固定的 reach_execute 工具 description；JSONL v1 不支持 run.brief，不能再加该字段。原用户正文和管理命令保留。工具 schema 使用 Zod input 模式，默认字段不强制模型填写。
- DeviceToolsHost 有界等原 operation，取消最多额外等待5秒，超时/unknown保持阻挡。正常验证/关闭检查全部 intent 和回执；失败外壳按固定 EXE 的 `tool error:` 核对，Core 在调用前拒绝 schema 时不制造 Host intent。读取错误不取消原运行操作。UTF-8 页过小时明确拒绝，不能返回零进展游标。
- 启动 factory 独立于旧 HTTP context，仅查回并清理 conversation 当前 blocker 的原操作，覆盖 cancelled+blocked，回填 operationId。恢复不自动解除未知 Task。
- UI 原生选择框+远端 cwd，切换只影响下一条消息；显式草稿选择优先，否则从加载完成的历史推导，不能在 paint 读取历史前缓存 null。消息保存自己的目标，页面展示原 operation 状态；顶栏标“下次”目标，避免把在途任务改到新机器。

共享普通 sidecar 和 Node Rust 本轮未改、未编译。侧车路径 `E:/usr/var/cache/rust-target/reach-static/x86_64-pc-windows-msvc/debug/ara-agent-lite-jsonl.exe`，SHA `2f858a77ba86bd8b201f7184b5afb7a10afc674ad8668cf49354c44174dc8353`；Node 普通程序为同目录 reach.exe。实际 EXE 摘要均在本轮 checked-inputs.json。

## 固定证据

第一阶段 `work/desk-devices-20261104/inputs.json` SHA `6cd99ebb887f9466e8dfbe4c56d6974cf844e0c5095c985fd9af141ff374479c`，18源文件及快照 `source-1793723930087`。原清单 `checked-inputs.json` SHA `4496081978e7351472a9fb6149d2867f68e79416be5977f8a8d6ccfc85d502fc` 保留。收尾UI已知4xx拒绝补丁另存 `inputs-r2.json` SHA `ba3c366d3ecfd14afa6266271b4ba4a905af2c07b26b8764533eaf56cc53977a`（desk.ts/js+新浏览器函数），后端不变。最终分层清单 `checked-inputs-r2.json` SHA `86b2bb89c0ca782d1d98a29f6bbd81ea9cf4fba4b385e8d55e1e2210774bb542`：19当前输入、18原副本+3补丁副本、39测试根、294引用、19设备回执、21released链匹配。它们不是独立功能数。

53个不同测试函数取得通过证据：第一阶段新设备/Chrome6、后端/服务39、旧Chrome7，共52；后加UI已知拒绝1个新函数，browser-r3 2/2(28.567s)，另1个为重跑的真实断流。53项不全在最后UI源码SHA下新跑。首批三组并行：native6/6(270.162s)，backend37pass+2timeout(349.251s)，browser6/7(200.186s)。原句柄终态后不改A源码/预算，串行重跑两backend2/2(40.375s)及断流browser1/1(17.153s)。不认定具体性能根因；原失败保留。不可说首批一次全绿，也不把重复执行累加。类型/Web构建及diff-check通过；不重跑未改的SDK/Cargo矩阵。

UI拒绝补丁区分明确提交前4xx白名单和传输/5xx未知：前者保留页面消息/草稿且不查不存在的Task，后者继续查询原记录。新Chrome证明坏cwd没有创建turn或调用模型、恢复原正文且不覆盖等待期间的新草稿；不把seeded配对当真实Node效果。

独立 `/root/reach_plan_review` 的 A/B 最终报告为 `work/desk-device-review-20261104.md`，SHA `fee09f135356205e6f43f75baa2087cfc50fb74f608516344aa65f440e7430fe`；没有剩余已确认阻断缺陷。A 的18源/副本、4个轻量探针和真实Node原件已复核；B 另核3文件、2组浏览器原件及实际 stream 函数的18个隔离分支。探针不加入53个业务测试函数数，不能称为额外现场效果。主代理已完整回读最终报告、B探针结果及分层回查，核对报告/探针/当前源摘要，并看过新Chrome两图。最后7份文档的本地链接检查及diff-check通过。前次独立报告仍只属于前次源码，不拿旧41函数替代新接线验收。

## 直接继续的事项

1. 完成真正的图片工具结果到模型输入。当前 JSONL BusinessTool 只生成 JSON 文本，`reach_artifact_range` 的 PNG base64 只是数据，不能宣称模型看图。需要公共 typed image 接口、原图引用/路径/摘要/尺寸/大小校验、真实共享侧车受控视觉请求与失败路径，固定新镜像后再接 Desk，不复制 Core。
2. 继续 R01–R07 现场 Agent/任务委托、技能/来源传递和恢复，不把当前 cloud Agent→Node 单次工具等同于现场 Agent 完成。完整历史/旧功能迁移仍按 X04 保留来源与差异。
3. 真正组织模型多轮、跨物理机器、SYSTEM/锁屏/切换、UAC、升级卸载与正式部署仍未验收。用户未恢复服务器访问，不为补证据探测公网或远端模型。

已有失败和复测原因详见主证据。下一点按新改动选择验证，不无改动重复本点52函数或上一Core长矩阵。Goal 未完成，不改变总范围或勾选整项 X03。
