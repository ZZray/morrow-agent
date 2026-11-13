# 完整 Windows 安装包：实现前独立设计复核

日期：2026-11-03。作者：Ray Zhang（Ray）；独立复核代理：`/root/reach_plan_review`。

本次仅审读现有代码、安装合同和测试，没有实施安装器变更，没有运行 Cargo、安装、卸载、服务或 ACL 修改。结论是接受以完整版本目录为单位扩展现有安装事务的方向；以下兼容、恢复与卸载要求需要随本执行点落实，不能只把 Node 字节替换成 ZIP 就宣称完成。

## 当前基线

| 文件 | SHA256 |
|---|---|
| `packaging/windows/setup/src/main.rs` | `b9392e5d362697542394f63a053cbebf92fef1d1dfa2a29ed1db8041af0e160e` |
| `packaging/windows/setup/build.rs` | `d013e147ef40c5e140cbfcacd93e559071270e8b9d2ed7df90710d31f2414cfe` |
| `packaging/windows/build.ps1` | `dbe198a9dcff7dc55b3b62cda5580c39f3ed6c0ff4c9a993ff534f681e04e0d4` |
| `packaging/windows/install.ps1` | `9759670a9d9130ed524ced7bb2c6ce9a6b6ead3df71cb1b0ef8c4de21aedfe7a` |
| `src/node/desktop.rs` | `9e61362492baf610092040efcbb62490d7f1cce550a0a1e18db1bf8519c14178` |
| `src/node/windows_desktop.rs` | `33797e6bd97b21c63e0b06ba015aaee22d441aa69ab6e5342d208cc89ce8d11f` |
| `src/node/ledger.rs` | `58965a676f4dd190fdde21b7856143b78a52b6b8a3bc4ea0775fd3d42dafa194` |
| `tests/windows-installer.test.ps1` | `8fc07fd06b35b6b0c1245af90eaf4bd4e1dddafb007d27b1af857ea21f6d5913` |

当前 setup 只内嵌 NODE、SCRIPT、NOTICES；`--inspect` 只核这些对象。安装版本目录由 Node SHA 的前 16 位命名，安装 manifest schema=1 中的 `sha256` 实际就是 Node 摘要。`ValidateManifest`、CLI 替换/回滚、首次失败清理和提交收据均直接使用该字段。

现有安装器已经具备可复用的关键事务边界：受保护目录/Owner、拒绝 reparse、不可信服务路径拒绝、安装锁、maintenance-stop 明确 ACK、SCM stopped 加原进程句柄退出、恢复旧程序前 disabled、持久化 restored 后才重新启动、committed 不自动回滚、保留账本和 unknown/outbox。不要为整包接入重做这些合同。

## 载荷与版本身份

最小完整版本内容包括根目录 Node、独立 helper、embedded Python 及其分发文件、桌面 backend 配置、生产 desktop-runtime.json、许可与 provenance，以及该版本的逐文件 manifest。安装记录和版本内容分开；账本、操作结果与临时 spool 不进入 ZIP。

建议明确 `packageSha256` 为封存后完整 ZIP 的 SHA256，另固定 `payloadManifestSha256`，使安装后不保留 ZIP 也可校验逐文件清单及其全部内容。清单不列自己的 hash；它作为单独受摘要约束的元数据，避免自引用。若 ZIP 可重建，固定文件排序与 ZIP 时间等元数据，减少内容相同却版本身份变化的情况。Node SHA 只代表 Node，不能继续兼任完整包身份。

安装 manifest schema=2 保留 `sha256` 的旧含义（Node SHA），新增 `packageSha256`、逐文件清单摘要/位置和明确的桌面载荷标志。`nodeStateSchema` 仍为 1，安装 schema 的变化不升级账本 schema。版本目录按 packageSha256 命名；相同 Node、不同 Python/helper/config/notices 必须进入不同目录。目录名即便采用摘要前缀，也必须核对完整摘要，不合并发生前缀冲突的内容。

安装结果、提交 journal、`--inspect`、package.json 都应同时给出包摘要与 Node 摘要，并以同一 packageSha256 的 committed journal 判断安装完成，避免相同 Node 的旧运行时收据被当成新版本成功。

## 解包和发布的最小要求

1. 在停旧服务之前验证 ZIP 摘要、清单摘要、完整条目集合、每个文件的实际解压尺寸和 SHA256；必需角色及生产配置指向必须存在。Node/helper/setup 固定为 Windows x64，setup 自身必须能在未安装运行库时启动，Python 和各 native DLL 按最终核定集合验架构和依赖。缺项、额外文件、截断、重复条目都拒绝，不按 ZIP header 的声明大小代替实际读取。
2. Windows 路径按大小写不敏感的规范键去重，拒绝绝对/UNC/盘符路径、父目录、ADS 冒号、尾部点或空格、设备名、NUL、文件/目录冲突及链接/reparse 类型；统一 `/` 与 `\` 后再判包含关系。不要直接把不验证的 ZIP entry 交给 Expand-Archive 写入特权位置。
3. 从已验证的受保护父目录逐级创建目录；使用现有 `Security`/`Directory`/`WriteFile` 能力，载荷按普通用户只读执行安装。安装记录、事务 journal、归属元数据保持非公开。普通用户不能修改可被 SYSTEM 或交互 helper 执行的文件。
4. 在同卷、受保护的新 staging 目录完成整包写入和复核，再发布成完整版本目录；禁止向当前活动版本原地补 Python 或覆盖 DLL。已有同 package 目录只能完全相符后复用；不同/多余/坏字节拒绝，不能覆盖成“相同版本”。部分 staging 可以保留供核对，但不得被 servicePath 引用。
5. 预检真实目的路径及 `.new-<guid>` 临时文件长度。当前 r1d 最长相对文件在默认 Program Files 路径下，64 位完整摘要目录的正式路径约 218 字符；临时后缀会继续增加，staging 目录名不能无限叠加。使用实际系统目录测量，避免到了停机阶段才发现 WinPS 5.1 路径限制。
6. setup build.rs 必须对 ZIP、清单及相应摘要环境变量设置 rerun-if-changed/rerun-if-env-changed；运行时和 `--inspect` 再核实际内嵌 bytes。保留现有私有 stdin 脚本传输和系统 PowerShell 路径，不引入用户可写临时脚本或额外引导页。完整 ZIP 会比现有 3 MB 私有传输测试大很多，必须用实际载荷大小验证传输、解析与内存占用。

## schema 兼容和回滚

`ValidateManifest` 应明确支持两类已知记录：schema1 的旧 Node-only 记录按原 Node SHA 路径校验；schema2 按 package 身份和逐文件清单校验。不要把 schema1 的 `sha256` 重新解释为包 SHA，也不要把任何未知版本/schema 自动归一化成已知格式。

主代理已接受把“事务对象身份可信”与“准备启动的版本完整可用”分开校验。当前 `Restore` 首先调用 `ValidateManifest(target)`；如果直接扩展为目标整包必须完整，候选恰因 Python/config/文件损坏失败时会阻断旧版本恢复。回滚停止目标时核事务身份、受保护路径、实际 SCM/进程映像和受信记录；准备重新启动 previous 时才要求 previous 全包完整。外部改写为第三方服务路径仍必须拒绝，不能借此放宽服务归属。

安装主顺序保持：完整 stage → journal → 请求旧 maintenance-stop → 明确 ACK → 原服务与原句柄退出 → 切换整个版本的 servicePath/CLI → 启动并核身份、epoch、真实 PID → PATH/manifest → committed。回滚只恢复程序、CLI 与服务指向，不回滚 SQLite/WAL、identity、unknown/outbox 或已经产生的效果。schema2→schema1 回滚意味着恢复原 Node-only 版本，不残留指向新桌面目录的全局配置。

新 journal 必须有明确的安装/卸载操作类型及版本。建议新事务使用 journal schema2，读取旧 schema1 时仅执行其已知安装状态机；不要把带新卸载阶段的记录塞进旧 schema1，以免旧恢复器按安装含义处理。未知阶段拒绝；restored、committed 和已完成卸载的重试都不得重放停止/动作。第一次安装失败仍只撤销本次已登记的程序/服务/PATH，保留已建立的状态。

## 生产桌面配置

现有 `src/node/desktop.rs:125` 已从 SYSTEM 服务自身 executable 的目录读取 desktop-runtime.json，核整树 Owner/DACL，按同一目录解析 helper/python/config，并拒绝 venv、包外 _pth 和 import site。`windows_desktop.rs` 已执行受限相对路径检查、明确 logon 选择和挂起创建/Job 后恢复；不需要为打包另加 development 环境变量回退。

生产 desktop-runtime.json 当前受 `deny_unknown_fields` 约束，且最多 16384 字节，只接受下面三个字段；完整逐文件清单必须另存，不能塞进这个文件：

```json
{"helper":"desktop/reach-desktop.exe","python":"desktop/python/python.exe","config":"desktop/config.toml"}
```

路径以实际最终布局为准，但必须同版本且角色明确。用现有 WriteJson 或 UTF8Encoding(false) 写 JSON，避免 Windows PowerShell 5.1 的 Set-Content -Encoding utf8 引入 BOM。打包/安装先核这些字段与清单角色的对应；未配对服务只处于等待状态时，SCM running 本身不能替代桌面配置和载荷检查。

完整载荷使用已核摘要的静态 release helper，不能把此前只验过的 debug helper 混进最终安装包。普通用户需要读取整个 runtime/config；可写 TEMP/TMP 和 COM 锁留在每代 spool，不把安装目录改成可写。

## 默认保留状态的独立卸载

现有 `Ledger::Identity` 不保存 bindingOwner，SID 目前只在服务参数和 Program Files 安装记录中。如果卸载删除这两处但保留账本，重装会把已有配对归给新启动安装器的 SID。主代理已采纳在 `%ProgramData%/RY/Reach.installation.json` 保存受保护的安装归属元数据，默认卸载保留它与账本；新安装/升级核其 installationId、bindingOwner、state schema 的一致性，不另造 Node 身份。

该元数据使用账本目录的兄弟路径。`Ledger::open` 在 node.sqlite 不存在且状态目录非空时拒绝启动，不能在首次 Node 启动前向新的账本目录塞入 owner/installer 文件。不得将配对 secret 写进公开程序目录。

卸载至少还需要以下落地：

1. 与安装共用安装互斥；只处理受信安装记录匹配的 RYReach 服务、程序根和 PATH 项。第三方同名服务、不同映像、未知归属立即拒绝，RY 共享父目录和其他产品不动。
2. 停止并结算本服务的真实进程/Job 后才移除注册与程序。卸载可以保留未上传/unknown 收据，不应把远端 ACK 当成删除本机程序的唯一前提；但没有确认本进程树退出时不能删正在使用的载荷。
3. 将 PATH 添加归属持久化到安装记录，升级时继承，不能只保存在最近一次 journal。当前 PlanPath 在已存在项时返回 null；首次添加后再升级会失去原归属。schema1 无足够归属证据时保留歧义项并记录，不能根据相同文本删他人预先存在的 PATH。保留其他文本、分隔符和 RegistryValueKind。
4. 独立入口应能从 Windows 卸载入口或命令触发，按系统 UAC 提权且不增加产品引导页。必须设计自身 executable 和 install.lock 句柄的释放后删除：当前安装器会等待 PowerShell 返回，若照搬该结构，PowerShell 不能递归删除仍在运行的卸载器/持有的锁。最终清理须有明确进程交接和可核对结果，不能吞掉删除失败报成功。
5. 卸载 journal 要能恢复服务已删、程序部分删、PATH 未处理等阶段。进入删除阶段后，重试不能先要求已删除的整包仍然完整；按已记录的受保护归属、清单和阶段处理剩余文件。未知额外文件/路径不顺带递归删除。账本、安装归属、原收据和 ReachDesktop 证据默认保留，不新增自动清数据动作。

## 可执行验收顺序

先完成可检视候选与非提权检查，再做隔离环境中的实际安装；本设计复核本身不表示这些测试已执行。

| 层次 | 最小新增或保留的验收 |
|---|---|
| 完整载荷检查 | 正常 ZIP/清单；每类缺文件、额外文件、错 hash/尺寸、大小写重复、路径逃逸/ADS/链接、文件目录冲突均拒绝；同 Node 不同 runtime 产生不同包身份；--inspect 与全部构建输入/实际内嵌对象一致 |
| 普通用户事务函数 | 保留现有 15 项；增加 schema1→2、schema2→2、相同 Node 的 runtime-only 更新、2→1/2→2 回滚、未知 schema 拒绝、坏目标仍可恢复完整 previous、previous 损坏拒绝启动、各阶段重试不重停已恢复服务；账本和 candidate 效果保留 |
| PATH/归属/卸载函数 | 首装添加后多次升级再卸载、预先存在路径、并发编辑、未确认写入、未知 schema1 归属、保留原 SID 重装、服务变为第三方拒绝；卸载部分删除后的重试；默认不清 ledger/证据 |
| Windows PowerShell 5.1 | 用 setup 实际选择的系统解释器跑生产函数/ZIP/JSON/路径测试，不能只用 pwsh7；实际大小的私有 stdin 传输没有截断，退出码和错误可见；新代码不依赖该 .NET Framework 环境缺少的 Convert.ToHexString、Path.IsPathFullyQualified 等 API |
| 非提权真实 runtime | 从最终待嵌入载荷取出的 static helper 与 Python，继续验证中文空格路径、真实只读目录、原生桌面及恢复；这层仍不代替 SYSTEM/WTS |
| 实际新安装 | 同一具体包/hash，在隔离 Windows 环境走真实 UAC；Owner/DACL、RYReach LocalSystem/延迟启动、普通用户 status/pair、机器 PATH、独立卸载入口、无第二 Node identity；无开发 Python/工具依赖 |
| 实际更新与故障 | Node-only→完整包，完整包→同 Node 不同 runtime；检查全版本配置无混用、installationId/epoch/SID 保留；维护 ACK 丢失不得切换；在 stage/停止/切换/启动/提交/恢复边界注入故障后，只恢复程序且不重放效果 |
| 实际生产桌面 | 真实 SYSTEM 服务通过 WTS 启动绑定用户 helper，原截图/中文输入/一次点击/Job 收尾；锁屏、无用户、多个同 owner 活跃会话和会话切换不得借 development 入口伪造成功 |
| 实际卸载与重装 | 先停结算自身服务，默认保留身份/账本/收据/spool，删除本程序与已确认归属的 PATH/注册；重装恢复原 SID/installationId/epoch，未 ACK 事件原样上传，不重做旧动作；自身删除与中断重试有明确终态 |

普通用户事务测试的生产解释器入口应明确使用：

```powershell
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -File .\tests\windows-installer.test.ps1
```

扩展后的载荷/卸载函数测试同样使用该解释器；原生 desktop 测试继续使用精确候选的 REACH_DESKTOP_BIN/REACH_DESKTOP_PYTHON 和 `node --test --test-concurrency=1 tests/desktop.integration.test.ts`。执行完真实 UAC/SCM/WTS 前，普通适配器测试只能报告函数/协议覆盖。

## 留给实现后的复核

实施前必须固定：packageSha256 与清单摘要的定义、schema2 归一化规则、卸载 journal/自身删除交接和 PATH 所有权格式。其余优先复用现有事务与生产桌面路径合同。实现后按具体 diff、固定 payload/installer hash 和上述故障结果重新审查，设计接受不等于实现验收。

主代理正在闭合原生许可/VC 来源；其已报告从微软签名 VC_redist 提取材料但未运行安装。此设计记录不审核或批准尚未读取的新增 DLL/许可成品，也不因为本机已有运行库而宣称干净机通过。
