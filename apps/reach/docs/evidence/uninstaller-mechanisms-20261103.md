# 卸载文件归属检查与恢复状态机

作者：Ray Zhang（Ray）。日期：2026-11-03。状态：隔离机制测试通过；生产安装/卸载尚未接入。

本执行点新增文件删除/PATH 模块和可重试卸载状态机。它们尚未由 `install.ps1` 或 Setup 调用，不构成可用卸载入口。现有完整安装候选 fe1506344bd265a1 不含本次模块；该候选及上一执行点的 374 项清单保持原始历史快照，不能用来证明当前新增代码。

## 行为与边界

- 删除范围由调用方提供可信文件归属；模块不从目录名推断归属。计划记录实际文件大小和 SHA256，恢复时允许缺失文件，拒绝变化或新增的文件。遍历前后核对整个程序树，包含根目录和保留目录。仅删除逐个文件和已空目录，保留根目录、锁和明确元数据。
- PATH 只在 `applied` 为布尔真、原文和类型有效、变更确为本安装 bin 的追加、当前值仍精确等于归属记录时还原。外部改动完整保留，收据明确写 `retained_ambiguous`； malformed 记录不能授权写注册表。
- journal 使用 schema3、operation=uninstall；原安装器确实拒绝该 journal 和 schema3 tombstone。根目录永久保留，因此 `install-journal.json` 同时作为唯一事务权威与旧安装器屏障，不另建双写的外部 journal。
- 停止通过 host 的 SCM 适配完成，不调用要求在线且 outbox 为空的 `maintenance-stop`。已停止服务不重启。原进程身份落盘，SCM stopped 与进程退出分别等待；删除服务后还须确认真正不存在。
- 独立 deploymentGeneration 阻止旧 journal 操作同包重装的新一代，即使 installationId 相同。生产 host 仍须提供受保护的代次及安装记录核验。
- 顺序为停止/删除服务、移除程序、处理 PATH、移除系统卸载注册、删除外部恢复脚本、写 tombstone/收据、提交 journal。注册存在时脚本必须完整；注册删除后的恢复由未来的下载 Setup `--uninstall` 或新安装器提供。
- 每个阶段先落盘再执行相应动作。写入失败恢复内存阶段；成功返回前回读实际 committed journal，严格核验终态身份、布尔结果、PATH disposition 和时间。仅内存里出现 committed 不算成功。

## 直接执行

实际命令均为系统 Windows PowerShell 5.1，`-NoLogo -NoProfile -NonInteractive -File`：

| 测试 | 最终结果 | 原始输出 |
|---|---|---|
| `tests/windows-uninstall-files.test.ps1` | 16/16 | [files-r2](uninstaller-files-r2.log) |
| `tests/windows-uninstall-transaction.test.ps1` | 40/40 | [transaction-r4](uninstaller-transaction-r4.log) |

真实效果包含隔离目录内文件删除/保留、持有实际文件句柄时删除失败及释放后恢复、序列化 journal 重读、隔离 HKCU 子键的 PATH 原文及 RegistryValueKind 恢复。测试结束删除自己的 HKCU 子键，机器 PATH 未改。

事务测试包含各阶段持久化前后中断、PATH 已写而结果未记、服务标记删除适配、文件被锁、注册/脚本替换、每个阶段的同包新 generation 拒绝、最终提交写前失败及复用内存对象不能伪报成功。最终 r4 使用 55 个独立夹具目录，40 是测试组数；其中有故意保留的异常/陈旧 journal，不把所有目录称为已完成卸载。主代理回查了 journal 阶段分布、42 份收据和 55 个保留账本文件。

实际目录：

- 文件测试：`work/uninstall-files-fe0f8b4d463e4642a5268e0e9817fd49`。
- 事务测试：`work/uninstall-transaction-6121fe17df8443edb60240a91bcd7c1e`。

测试适配而非实际执行的部分：生产 Owner/DACL、两把安装锁、SCM、工作进程身份与结算、Windows 卸载注册、外部脚本受保护入口、原子替换及 flush、UAC。测试中的登记/脚本使用隔离文件，进程状态为明确适配，账本是未触碰的内容标记。不能称为真实离线 Node 卸载、真实系统安装或干净机验证。本次没有 Cargo、提权、生产安装或线上修改。

## 独立复核发现与修复

独立复核者为 Codex `/root/reach_plan_review`，设计见 [设计报告](uninstaller-design-review-20261103.md)。原 13 项测试通过后，独立探针仍发现三个真实缺口：

1. 计划后新增在根目录/保留目录中的未知项未被发现，可能返回成功。
2. 向 `directories` 添加未知空目录即可删除它，未核对该目录是否由文件父路径推导。
3. PATH 的字符串 `applied='false'` 被当作真，能导致注册表写入。

原始输出保留在 [独立文件测试](uninstaller-files-independent-r1.log) 和 [反例探针](uninstaller-files-probes-r1.log)。修复为完整树重核、目录集合严格推导相等、PATH 字段类型及追加关系验证。最终 16 项含对应反例。

独立复核随后要求覆盖持久化写前失败；本次实现显式恢复内存阶段并回读磁盘 committed，最终 40 项包含各阶段写前故障及同对象伪造 committed 拒绝。独立 [写前故障探针](uninstaller-transaction-probes-r1.log) 实际加载的是修复后的 d726484b，已验证正确行为，不能将它描述为复现旧版缺陷。

最终 [独立机制报告](uninstaller-mechanism-review-20261103.md) SHA256 为 `df5dd625cd31e4627cde4fad58460a3bf3ccf77578cd1b2be149a69358634c49`。复核者独立执行最终文件组 16 项通过；事务组读取固定源码/测试/40 项原日志，另执行上述写前失败探针，没有重复整组 40 项。主代理回读完整报告并直接核对报告摘要及最终设计摘要 `b3905579bd5b90951d33dc2d4a8456097aed99c35800ecf07836d4438c974818`，另核 55 个夹具账本内容保持原样。接受范围只限本次两个机制模块，不代替生产装配复核。

## 最终源码与输出摘要

| 文件 | SHA256 |
|---|---|
| `packaging/windows/uninstall-files.ps1` | `ac9eb912229683bc7e068eb0fc9f4cda0b26933051f39d6df0398b255e1a84fc` |
| `packaging/windows/uninstall-transaction.ps1` | `d726484b229d70d1f64aaa2112ad6d4bfbbd7565496ffe6c4b739275a9967a7e` |
| `tests/windows-uninstall-files.test.ps1` | `0739c80e04aef8ee5ad196f8275a62312e85c766abf61108697ab88b6ca6aecc` |
| `tests/windows-uninstall-transaction.test.ps1` | `2db4104ed50b82907b007030df4afa004f110eb0f7bfeba9ab7f341002b50bd9` |
| `uninstaller-files-r2.log` | `2f6e298c0052eb0d6ebbda576dc3601386516ec276f00d6e748381c8891dd5ad` |
| `uninstaller-transaction-r4.log` | `f29557b9eaa537dc5ee026cbce354bf74a7782d96d612696f368c735fa02c847` |

## 未完成的生产接入

1. 安装时预登记明确文件归属 catalog，完整旧版本由可信 current/previous 记录及清单导入；stage 创建前登记。旧随机 `.new-GUID` 残留不猜测归属。新 stage 可对已登记路径直接 CreateNew 写入，发布前全量验证，避免未登记临时文件。
2. 受保护 deploymentGeneration、原安装记录摘要与 catalog 绑定，external→legacy 两锁顺序、schema3 卸载分派及保留 SID/installationId 的重装。
3. 实际 SCM 查询/停服/进程等待/删除并确认 1060，系统 PATH、64 位自有 Uninstall 注册和外部脚本的真实 host。
4. `install.ps1` 安装/回滚脚本及注册、Setup `--uninstall`、按需 UAC 的系统 PowerShell bootstrap，注册已删除后的恢复。脚本已经损坏/缺失时，下载入口如何先恢复可用入口也须落地，当前模块会明确拒绝。
5. 新完整候选构建、独立装配审查、真实 UAC/SCM/SYSTEM/WTS、配对、卸载/重装与干净机验证。

基础清单保持 0/52，Reach Desk 0/5。本记录接受的只是上述已执行机制范围，完整卸载和 I01–I06 仍开放。
