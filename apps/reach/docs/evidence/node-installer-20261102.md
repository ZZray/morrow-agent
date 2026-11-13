# Windows Node 维护停止与安装候选

作者：Ray Zhang（Ray）。日期：2026-11-02。范围：D05、C03/C04、I01–I04 的局部实现。仓库为 `E:/repos/ara`、分支 `dev`、基线 `90f2b1c` 加未提交工作区。没有提交、推送或改动 Ray 线上服务；Reach Desk 的名称和内部子项目归属保持不变。

本页记录 Node 安装候选，不接受完整 I01–I06。真实 UAC/SCM/SYSTEM、安装 Owner 写入、机器 PATH、升级故障、系统重启、卸载和干净机器桌面操作均未执行。普通用户的进程、临时文件、用户测试注册表及只读系统锚点检查分别标明。

## 实现与候选

`maintenance-stop` 通过现有认证管道进入唯一账本宿主，和配对互斥。在途请求结束且旧上传任务退出后，核对 pending pair、本地活跃操作/未 ACK 收据和远端 pending；不确定时拒绝，成功后停止领取并退出。安装器必须收到明确 ACK，等待 SCM stopped 和原进程句柄退出；丢失 ACK 不作为继续切换的证据。

安装候选具备受保护目录/Owner、固定绑定 SID、跨进程事务锁、SCM 自动延迟启动、原始机器 PATH 文本/类型保留、版本及完整性检查。系统 PowerShell 路径由 Windows API 获取，SID 直接读当前进程 token，脚本与载荷通过私有 stdin 传入。回滚保留数据库；先合作停止候选，再恢复旧程序。旧程序在 restored journal 落盘前保持 disabled，之后恢复自动延迟启动。最终成功以相同 SHA 的 committed journal 为准，提交前 validationPassed 不能单独表示成功。

候选目录为 `outputs/windows-node-4e2f2786c67f886e/`，不进入 Git：

| 内容 | SHA256 |
|---|---|
| `Reach-Node-Setup-0.1.0-preview-21142b4d8913879c.exe` | `21142b4d8913879c342dd58cc61bf00c23265f272e5fc2bf853b1d529c640d93` |
| 内嵌普通 Node，Windows x64 release / 静态 VC runtime | `4e2f2786c67f886e4e3cc840901cd3f824eb574cd64a42c5e7b9f04c2d92929a` |
| 内嵌 `install.ps1` | `9759670a9d9130ed524ced7bb2c6ce9a6b6ead3df71cb1b0ef8c4de21aedfe7a` |
| 内嵌第三方许可 | `5d89caacd9bd27e8bf07a2aa10cb343152aa7eea0f818f2ace8cc7de8efb7131` |

Node 为 5,699,584 bytes。候选含 149 个 Cargo 可达依赖的许可证及 Rust 运行时原始版权资料，不含桌面后端。setup 未代码签名。`package.json` 保存导入 DLL 清单与验证边界；`dependency-inventory.json` 保存许可文件哈希。早期候选仍保留，不能混用其 SHA 或作为最终制品。

固定 `--target x86_64-pc-windows-msvc`，Node 与 setup 使用 `RUSTFLAGS=-C target-feature=+crt-static`。打包脚本拒绝还导入 VC/UCRT DLL 的输入，并比较 `--inspect` 返回的 Node、脚本和许可三项哈希与构建前输入。检查到的最终导入均为 Windows 系统 DLL；这不替代干净机器启动验证。

## 执行记录

| 检查 | 证据与结果 |
|---|---|
| Node 格式/Clippy | fmt 通过；[Clippy](node-maintenance-clippy-v1.log)通过，同一份 Node 源码 |
| Node 原生开发构建/单测 | [构建](node-maintenance-build-v1.log)、[2/2 单测](node-maintenance-rust-v1.log)通过 |
| Node 普通进程回归 | [开发版完整回归](node-maintenance-native-v3.log)27/27，0 skip，226.306 秒 |
| Node 最终静态制品 | [release 构建](node-static-build-v1.log)成功；[最终普通制品回归](node-installer-native-final.log)27/27，0 skip，212.065 秒；[单测](node-installer-rust-final.log)2/2 |
| 安装事务 | [15/15](node-installer-transactions-v4.log)，真实临时文件/用户测试注册表，SCM/ACL 使用明确适配桩 |
| setup 静态制品 | [构建与 inspect](node-setup-build-final.log)通过；[私有 stdin/native SID 单测](node-setup-rust-final.log)1/1；[Clippy](node-setup-clippy-v2.log)通过 |
| 依赖审计 | [Node](node-maintenance-dependencies-v1.log)、[setup](node-setup-dependencies-v1.log)的 advisories/bans/licenses/sources 均通过；已有重复版本/许可未出现警告保留，无新豁免 |
| 本机只读预检 | [系统锚点](node-installer-preflight-v1.log)及祖先 Owner/危险 ACL 校验通过；Program Files/ProgramData 下 RY 尚不存在，当前 shell 非管理员，没有创建安装目录 |

最终源码、二进制与日志绑定见[快照](node-installer-20261102.json)。两个 Rust workspace 均为 binary，无 doctest 目标。本轮没有模型请求。

文档收尾检查为[33 个活动页面、226 个本地链接、57 个唯一任务 ID](node-installer-docs.log)，Reach 无断链，`git diff --check` 通过。[全仓 bootstrap](node-installer-bootstrap.log)仍有 38 个既有 Reach 外断链，不称全仓通过。

新增真实 host 场景覆盖未配对停止并原身份重启、pending 在途屏障、执行中 busy、未 ACK 收据拒绝、远端 unknown 拒绝直至原操作对账、远端网络故障拒绝且 host 继续可用。运行后读取原身份、账本和真实效果文件，确认没有重做动作。

事务测试通过抽取生产 PowerShell 函数执行，覆盖独占安装锁、PATH 缺失/空值/原始展开字符串/等价路径/并发变更、丢失维护 ACK、先停候选再恢复旧程序、原 stopped 状态、第三方服务配置拒绝、首次安装失败精确撤销及 journal 恢复幂等性。它不调用真实 SCM，不写机器 PATH，不创建管理员 Owner。

## 失败、审查与限制

第一轮完整开发版回归为 26/27：[大输出分页返回 unknown](node-maintenance-native-v1.log)。该次断言未保留完整末端原因，不能断言已经定位或修复根因。增加失败诊断后，[原单项](node-maintenance-output-diagnostic-v2.log)与随后完整开发版回归通过；没有删断言、改成功语义或重放动作。此失败保留为稳定性观察，不能被后续通过抹去。

初次 Node 和 setup 导入检查发现 VCRUNTIME140/UCRT 依赖，[原导入表](node-installer-imports-v1.log)保留；改为静态链接，打包门禁现在拒绝同类制品。早期构建日志 v1–v3 只属于早期候选，最终以 final 为准。

独立审查者 `/root/reach_plan_review` 按 ara-git-review / ara-rust-core-review 只读核对维护协议、安装器及打包代码。审查推动修复事务锁、UAC 子进程错误可见性、锚点写权限、提交后回滚、PATH 归属不明时误删、恢复旧服务后重复停止及构建 target/内嵌哈希核验。主任务回查相关代码并执行适用测试；独立审查没有运行 UAC/SCM 或安装。

最终独立复核确认50/50输入、当时28/28日志哈希匹配，Node/setup/脚本/许可四项实物与快照一致；实际PE导入与清单一致，未发现新增确定缺陷。接受范围明确限定为Node安装开发候选。随后仅补文档链接并由主任务重查至226条，刷新对应文档日志哈希；代码及制品未改。主任务再次确认源文件无差异、安装器SHA匹配，测试结束后无reach进程残留。

候选只支持程序 0.1.0 / Node schema 1，不能外推为跨 schema 更新。PATH 并发改动/写入归属不明时保留现状，可能留下待下次安装核对的项。新候选启动至验收间可领取工作，失败回滚会合作停止并留下可能的 unknown，绝不恢复旧账本。真实断电/重启、SCM 停止、安装失败回退和完整桌面安装仍须实测。Humanizer 在当前可用目录未找到，本页已人工按事实、来源与边界审读，未称已调用该工具。
