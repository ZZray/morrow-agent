# Agent 运行库审计与完整安装候选：本地证据

作者：Ray Zhang（Ray）。日期：2026-11-04。

本点让新版 Windows 完整候选携带 Agent 侧车、相对配置和完整许可材料，并执行解包后的真实 Node/工具链。没有安装、UAC、SCM、机器 PATH 写入、服务器访问、远端模型或部署；Git 未同步、提交或推送，原 WIP 保留。基础 **0/52**、Desk **0/5**、完整 R06 与首版目标不因本点改变。

当前候选已构建、完成本地执行并通过独立复核，结论为 **ACCEPTED_LOCAL_CANDIDATE_POINT**；不是生产安装验收。前点 [NoFence](agent-native-finalize-20261104.md) 的原始失败、审计记录和封存保留。

## 审计问题的核实

前点将 JSONL 独立 workspace 套入仓库根 Full Core policy，实际得到来源、许可、wildcard 拒绝。根 policy 本来针对 Full 的固定依赖，其中 webpki-roots 例外只匹配1.0.11；JSONL 当前锁为1.0.10。进一步查到 Lite Core 已有自己的 policy，桌面 Host 也已有相应独立 policy。

本点首先对**同一份未修改的锁文件**执行 `cargo deny --offline --locked --config ../ara-agent-lite-core/deny.toml check`，advisories/bans/licenses/sources 四项通过。没有修改根、Lite、Desktop、Reach 的 policy，没有添加公告、许可或来源豁免，也没有修改依赖锁。旧 Full-policy 失败不能删去或改称成功；本点为实际产品选择正确的独立 workspace 策略。

新增 `packaging/windows/audit-dependencies.ps1`，完整构建必须先审 Node、Desktop、Setup、JSONL 四个 workspace。Node/Setup 使用 Reach policy，Desktop 使用自己的 policy，JSONL 使用既有 Lite policy。每组记录 manifest/lock/policy/metadata/原日志摘要，并在检查后及整个构建结束再核输入未变。所有 Cargo 调用 locked/offline；公告检查基于本机缓存，不是在线实时扫描。

Lite 原 policy 的 git allow 是仓库级，构建门另外核实际 metadata 的 rpi-agent/rpi-ai/rpi-telemetry：版本均为0.3.23，revision及解析commit均精确为 `8ec462672d90e62712d96074638efef89436cebe`。Agent/Desktop 不得缺任何一个包；换仓库、revision、版本或包名都拒绝。固定来源正负例7/7通过，未使用任选一个能过的策略来替代这条合同。

## 新包合同与原件

本次提升的是 **payload-manifest schema2**。既有 install.json 的完整包 schema2、journal schema4、Node账本 schema1不变。

- 新完整构建必须带 `agent/ara-agent-lite-jsonl.exe` 与 `agent-runtime.json`；配置固定包内相对路径、完整SHA及整数 `inspectionLeaseVersion:1`。
- ZIP、已解包/已装目录、Setup 内嵌验证共同核配置、清单及实际侧车同一SHA。缺件、路径重定向、类型错误、摘要不符明确拒绝。
- 旧 payload schema1仍可验证、回滚或导入；不得夹带新Agent字段/文件来降级绕过。新Setup明确绑定预期Agent SHA，不能把缺Agent的schema1当成新完整包。
- Node在同目录schema2声明下要求配置和准确侧车；缺配置、缺程序、坏镜像、非法lease或开发覆盖均报错，不继续公布基础能力。旧无包声明及旧schema1保留可选Agent行为。
- Agent文件随manifest全文件表进入版本归属、回滚和卸载名单；没有新增SCM或身份账本。

最终候选：

`outputs/windows-complete-117a183476413d54-b9740de53fe3/Reach-Setup-0.1.0-preview-b916f8872cab131b.exe`

| 身份 | SHA256 |
|---|---|
| Setup | `b916f8872cab131baf029c4eaa34e4aeba33f85a2ec84ac9a11786924c930d1d` |
| 内嵌ZIP | `117a183476413d54c2de5e97ded9c14578e0b59089e628e4f8ae4d52a73e101d` |
| payload-manifest | `c4fb9c5815292e70a176961b398bbd3d81873c04baba89acb84fb6b1c626a91e` |
| Node | `5e9837e5fd39d240f37289612a5ab71eaeb451ce6640f37878b543d02ce14904` |
| Agent侧车 | `d7b4182d74bea47fdf210c54952fe1c33f24cd0379c107636c00035fa9f71439` |
| 静态桌面helper | `0ea7c0b2c6117b04163614010771d1b1532f7b8dc49fa47af8dda5dc7778eea2` |

6,329个载荷文件，222,390,804展开字节。桌面helper/便携Python沿用已有固定来源，本点没有重写其行为。候选 `installationTested=false/codeSigned=false`，不得视为真实安装通过。

R2与最终R3候选内嵌ZIP、Node、Agent、helper、配置**字节相同**，Setup EXE摘要不同。R2已实际解包执行；最终R3另外执行自己的 `--inspect/--verify-payload`，再核同ZIP实际存在于EXE及原解包全部文件。`candidate-r3.json` 明确这个桥接，不说整个EXE相同或重新执行了两套安装。

## 许可证与发布材料

collector将JSONL的实际依赖图纳入已有Node/Desktop/Setup集合，生成262项原始Rust依赖记录及全文。补充材料不再仅在crate完全没有LICENSE时使用，避免遗漏位于固定rpi仓库根的NOTICE。原rpi LICENSE/NOTICE、webpki-roots1.0.10的CDLA-Permissive-2.0全文及现有Python/桌面运行时声明进入同一候选。

主代理逐一回读468份原始文本和10份补充文本的来源SHA、全文在实际notices中的存在，以及rpi三包对应固定revision。四个PE的导入表另存 `pe-imports-r3.json`，通过现有系统运行库依赖校验。这里只关闭本点的锁定依赖审计与材料装配缺口；签名、干净机器和正式发布仍未验收。

## 已执行验证

以下日志均在 `work/agent-dependencies-20261104/`，实际命令和artifact路径由本点输入清单、构建package.json与日志保存。

| 检查 | 实际结果 | 范围 |
|---|---|---|
| 最终完整构建 | complete-build-r3.log通过 | 四workspace审计、262项许可、真实EXE内嵌6329文件，经系统WinPS5.1私有stdin全部核验；未安装 |
| 包内自动发现与实际Agent任务 | packaged-agent-r2.log 6/6 | 包外cwd，Node清除所有REACH开发覆盖；真实配对、2个受控模型请求、1次文件工具、正常进程join、原outbox及服务重启；5组坏目录明确拒绝且未公布新能力/领取操作 |
| ZIP/已装树合同 | payload-tests-r2.log 21/21 | WinPS5.1，schema、完整集合、路径、大小、摘要、新Agent强绑定和缺件/改写；已装树为隔离文件夹具 |
| 既有安装编排 | catalog-tests-r1.log 22/22 | 实际生产编排、文件/锁/原子写/隔离HKCU；SCM、ACL与Node为明确适配 |
| 旧包升级到Agent包的归属 | catalog-agent-r2.log 1/1 | 实际隔离版本目录，11个新包文件归属、旧回滚目录保留，卸载计划包含侧车/配置；载荷为明确夹具 |
| 固定上游来源门 | source-gate-r1.log 7/7 | 真实metadata及修改后仓库/rev/version/name/缺包负例 |
| Node | fmt/clippy与15/15通过 | 本点交付Rust源码；实际进程/管道/Job与既有机制回归 |
| Setup | fmt/clippy与2/2通过 | 实际WinPS私有传输与完整恢复脚本解析，不执行安装 |
| TypeScript | typecheck-r2.log通过 | 包含新实际程序测试；服务业务源码未改 |

前点JSONL镜像没有变化，本点不重复宣称其全部业务测试。包内实际模型是受控loopback SSE，不证明组织模型推理、视觉能力或线上工作台集成。

初版包目录测试为0/6：实际文件任务和五个拒绝路径已运行，但断言把Windows命名空间路径当成不同文件，并误以为配对后last_seen应为null。现在统一路径表示，并与**配对后的真实基线**比较，仍核零新能力/零操作、准确错误、原摘要和实际效果；相同Node/侧车随后6/6通过。另一次已装目录测试使用含 `..` 的未规范绝对路径，修正夹具后21/21。所有失败及旧候选保留，没有修改产品结果来迎合断言。

## 冻结与当前边界

`inputs-r3.json` SHA `b9067bddd3d8c3882f7ae54771b0221a63e46e9832dbce50d40ff9c309cbaa8b`，266份源码/输入及source-r3副本；基线为前点NoFence R15和既有维护入口冻结。27项差异包含首次纳入manifest的历史文件，不代表27项新功能。

主代理 `checked-primary-r3.json` SHA `037c5b057ea979ca94ae87619e162020f662825bd1f37e15d3a8cc251ed4e9ce`，回读266源与副本、4审计、262许可、6329解包文件、6个smoke根、20条原outbox与服务事件/ACK。

当前设计复核见 `work/agent-package-design-review-20261104.md`（CONDITIONAL_DESIGN_APPROVAL）。真实UAC/SCM/SYSTEM、机器PATH、Windows服务下桌面会话、实际安装/升级/卸载、签名、干净机、完整R06、R04/R05与真实组织模型仍开放。服务器继续暂停访问，Goal保持active。

最终[独立实现及原件报告](../../work/agent-package-independent-review-r3-20261104.md)已完整回读，SHA `9e778c1dbe2d2038f23ae212627ef4f5935a5f19aabcff90a197d6eaf3d964f1`；同名JSON SHA `f0e5bae04b8aca238d3c3848bf7228bb5adc681f1b33528046208e94e1128432`。Codex `/root/reach_plan_review` 完成13份实现/测试语义、14份支持文件内容/身份复核，无confirmed finding，接受仅限本地候选点。

独立核验器另核266源/副本、7 artifacts、R2/R3原ZIP桥接、6329文件、4审计、262许可、6个smoke根/20原事件的dispatch/hash/规范化digest/ACK与归属原件，并实际运行最终Setup的两个只读入口。其 `work/agent-package-independent-readback-r3-20261104.json` SHA `67887ac65a81d644328e1c53d0a1503e5254fb1f3daf12f21b166508a88808bc`。独立计数与主代理不相加。核验器首轮误将服务digest理解为原JSON摘要，按服务递归排序合同修正后通过；失败保留，产品未改。

完整模型上游request body未另存原文，本点由受控端点断言、服务调用记录、JSONL事件和真实文件共同证明有限执行合同，不能扩成组织模型或视觉验收。九份活动/合同/证据文档按链接、空白和57个稳定任务ID检查；humanizer未提供，主代理人工审读。前点九份文档的原字节另存baseline-documents，原封存未改写。本点最终checked-final.json单独保存，安装和部署继续暂缓。
