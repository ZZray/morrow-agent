# 卸载文件与事务机制的独立复核

作者：Ray Zhang（Ray）。日期：2026-11-03（Asia/Hong_Kong）。
独立复核：Codex `/root/reach_plan_review`；实现与主测试执行：`/root`。

## 本执行点结论

固定版本的纯文件删除/PATH 模块和卸载事务模块，在下述限定范围内未发现尚未修复的可证实缺陷。文件组最终 16 项由主实现和独立复核者各执行一次通过；事务组 40 项由主实现执行通过，独立复核者读取全部对应实现、测试与日志，并执行一个额外的写前失败/同对象重试探针。

**只接受两个机制模块，不能据此宣布 Windows 卸载已实现或验收。** 生产 host、可信文件归属 catalog、两把真实维护锁、系统 PowerShell/UAC/应用列表入口和下载 Setup 装配均不在本次已完成范围。真实 SCM、生产 Owner/DACL、SYSTEM/WTS、HKLM PATH、原子持久化和真实安装/卸载仍待实现或验证。

设计见 [uninstaller-design-review-20261103.md](uninstaller-design-review-20261103.md)。设计已采用系统 PowerShell 外部脚本和下载 Setup `--uninstall`，根目录与 legacy 锁保留；`root/install-journal.json` 是 schema 3 卸载事务的唯一权威，同时作为旧版屏障，没有第二份外部 journal。设计报告本次摘要为 `b3905579bd5b90951d33dc2d4a8456097aed99c35800ecf07836d4438c974818`。

## 固定审查对象

| 文件 | 字节 | SHA256 |
|---|---:|---|
| `packaging/windows/uninstall-files.ps1` | 10382 | `ac9eb912229683bc7e068eb0fc9f4cda0b26933051f39d6df0398b255e1a84fc` |
| `tests/windows-uninstall-files.test.ps1` | 10860 | `0739c80e04aef8ee5ad196f8275a62312e85c766abf61108697ab88b6ca6aecc` |
| `packaging/windows/uninstall-transaction.ps1` | 12415 | `d726484b229d70d1f64aaa2112ad6d4bfbbd7565496ffe6c4b739275a9967a7e` |
| `tests/windows-uninstall-transaction.test.ps1` | 17811 | `2db4104ed50b82907b007030df4afa004f110eb0f7bfeba9ab7f341002b50bd9` |

依赖的路径/流校验来自既有 `packaging/windows/payload.ps1`，SHA256 `e157371a0ca649dd260a2cdaa3bb426db6eb35a35413a17941b79c7bcb51b57e`。本轮没有修改这些实现或测试文件。

## 文件模块：实际发现、修复和复验

初始 `uninstall-files.ps1` SHA256 为 `010f4a03061afd1ffc37e5fc62d5dea02f862ad6c6aaa89438de6d665a8180c6`。它的 13 项测试通过，但独立隔离探针确认了三个遗漏：

1. 计划生成后，在根目录新增文件/空目录，或在保留元数据的父目录里新增文件，执行仍返回成功，未知内容留在现场但没有拒绝。原测试只将未知文件放在待删 versions 子树，所以没有发现该情况。
2. 持久 plan 的 `directories` 可额外声明一个并非 owned/retained 文件父目录的空目录；执行会删除该目录。目录集合没有和实际文件归属关系绑定。
3. PATH 记录 `applied='false'` 为字符串时被 PowerShell 当成真值，实际修改了隔离 HKCU PATH 并返回 removed；非布尔记录没有拒绝。

原始复现见 [uninstaller-files-probes-r1.log](uninstaller-files-probes-r1.log)，SHA256 `69f640a4526d95ba7327ce919bc0ac3f4be8193892e2c06f5ee68b590d0d0d00`。夹具位于 `work/uninstall-review-623d1987c9664039a2f9093cfdf042c6`，只涉及工作区普通文件和随机 HKCU 测试键；没有服务、机器 PATH 或生产 ACL 操作。

最终版本作了直接修复：

- 删除前后完整遍历允许集合，包含根目录和 retained 父目录；未知项拒绝，且非递归删除目录，不把后来出现的内容卷入删除。
- 从 owned/retained 文件重新推导全部父目录，要求与 journal 目录集合精确一致；拒绝增加、遗漏、重复和文件/目录前缀冲突。
- PATH applied/exists/kind/raw/after 严格检查类型，要求 after 确实是当前安装 bin 对 before 的精确追加；未归属、未确认或有后续编辑的值保持原样并明确返回 disposition。

独立复核者重新执行最终 16 项，全部通过，日志 [uninstaller-files-independent-r2.log](uninstaller-files-independent-r2.log)，SHA256 `8811ea0c140eed6395f73849a603e73dcef71e56f7a4e643eae59a463dd8d453`；夹具 `work/uninstall-files-4f2a23ce7ea24d7a861a02c9bab99b7e`。

主执行最终日志 [uninstaller-files-r2.log](uninstaller-files-r2.log)，SHA256 `2f6e298c0052eb0d6ebbda576dc3601386516ec276f00d6e748381c8891dd5ad`。初始主 13 项日志 SHA256 `b976f889536f7bab7f1845946228a3c53f91294c49d51ea294e9bed0d0e71a73`，独立 13 项日志 SHA256 `0e7373f16a989e5a91aba53bc74e224a8599cf48f67da6365d853c8a8659572e`，均保留；不能因为它们通过而隐去上述反例。

## 事务模块：关键状态复核

**原进程与重试。** 当前原进程仍在时，先持其对象并记录身份，再执行停止；不会因为 journal 已有该同一记录就先永远等待它自然退出。SCM 已报告 PID 0 时保留较早 originalProcess，之后仍调用 WaitRecordedExit。新捕获对象与旧 PID/创建时间不同则先核旧对象退出。服务不存在的重试分支也等待已记录对象，且必须由 host 证明 DeleteService 后的真实不存在，才推进文件删除。

**部署归属。** 每个阶段通过 `AssertReachCurrentDeployment` 核实时刻的部署身份；相同包、相同 installationId 但新 generation 的八种旧阶段均在适配测试中被拒绝。程序计划必须保留 `install.lock`、`install.json`、`install-journal.json`、`deployment.json`、`last-uninstall-result.json`。模块本身不从目录名推断归属，也不因此获得生产删除权限。

**顺序。** 服务停止及删除确认在程序删除之前；程序与 PATH 结果在 Uninstall 注册删除之前；注册确认移除后才删除恢复脚本。后续阶段再次检查服务未重现、完整 root inventory、程序不存在和 PATH result。注册仍存在但恢复脚本缺失/变化时拒绝开始破坏性动作。下载恢复如何重建可信脚本仍是生产 host 的装配责任。

**写前失败与终态。** 审查指出早期 `SaveReachUninstallPhase` 先推进内存 phase，而测试仅在 WriteJson 写完后注入失败；生产写前失败可能使内存领先于磁盘。主实现随后修复：写入失败恢复原内存 phase，committed 分支重新读取真实 journal，要求同代 committed，再用磁盘版本核验 tombstone/receipt。终态同时严格核对 schema/operation、generation、SID/installationId、布尔结果、PATH disposition/changed 和时间，不能只凭一个 `requiresCommittedJournal` 真值返回成功。

独立探针运行时已经加载到最终 `d726484b…`，故它是**修复后验证**，不是对早期错误版本的动态复现：在 committed 写入前抛错后，内存和磁盘都为 committing；复用同一个对象重试后，实际磁盘写成 committed 才返回成功。日志 [uninstaller-transaction-probes-r1.log](uninstaller-transaction-probes-r1.log)，SHA256 `28efcd9cca101038a4f87712a58dfaffdf377c7c0e645eee645bca101578d834`；隔离夹具 `work/uninstall-transaction-review-abf92c5569af4ac0bd1d7e9bbc4085d0`。

## 40 项事务证据的边界

主执行最终 [uninstaller-transaction-r4.log](uninstaller-transaction-r4.log) 为 40 项通过，SHA256 `f29557b9eaa537dc5ee026cbce354bf74a7782d96d612696f368c735fa02c847`，夹具 `work/uninstall-transaction-6121fe17df8443edb60240a91bcd7c1e`。独立复核者读取了测试函数、写前/写后故障注入、所有 40 项原始结果，没有再次运行这整组测试。

其中实际执行普通文件删除、保留、占用失败、JSON 读写以及随机 HKCU PATH 修改；SCM、原进程对象、注册入口、Owner/DACL 和原子 WriteJson 均有明确适配。测试的“注册入口”使用夹具文件表示，不是实际 Windows 应用列表注册项；`node.sqlite` 是保留字符串的夹具，不是一次真实 SQLite 停服/outbox 结算。WriteJson 使用 WriteAllText 和故障边界，不证明生产 flush、原子替换或断电持久性。

覆盖包括：不依赖网络 ACK、原已停止服务不重启；各阶段写前/写后和 PATH 写后中断；同对象提交重试；原进程未退出及服务删除 pending；文件占用/变化/未知项；第三方服务或注册；恢复脚本缺失/变化；PATH 歧义；新 generation 拒绝旧 journal；committed 重试不再删文件或改 PATH；终态字段损坏拒绝；固定旧安装器拒绝新 schema。

初始 28 项日志 [uninstaller-transaction-r1.log](uninstaller-transaction-r1.log)，SHA256 `27c03ae1753add7875a23bb9aae86d75b0c64e132f18c177f114917a1339af78` 保留。它和后来 40 项不是 68 个独立生产验证项。

## 生产 host 必须落实的合同

这些是尚未装配部分的必要接口合同，不列为当前纯模块已经解决的能力：

1. **锁与记录可信性。** 调用前取得 external→legacy 两把真实锁，校验祖先/Owner/DACL/reparse，使用真正原子、flush 的 WriteJson。先把 planned journal 持久化为旧版屏障，再调用事务；重试从真实 journal 进入。根目录永久保留，不能在锁外删除或替换 legacy lock。
2. **catalog 与完整身份绑定。** `AssertReachCurrentDeployment` 不能仅复刻测试中 generation/SID/installationId 三字段比较；还须将 root、nodePath、精确 servicePath、programPlan、canonical retained 集合与受保护安装记录/catalog 对上。只有 ExpectedRoot 或一个随机 UUID，不足以授予文件删除归属。最终包可从已验证 manifest 导入；旧 current/previous 必须按可信记录导入，不能扫版本目录名称认领。
3. **partial stage。** 主设计拟在创建 stage 前预登记明确文件路径，用 CreateNew 写已登记路径，方向正确。旧 `.new-GUID` 临时文件没有完整归属记录时应保留并拒绝，不能凭后缀猜测。该 catalog 方案尚未在本两个模块中实施或验证。
4. **SCM 与真实进程。** 实现函数必须区分 1060、访问失败、marked-for-deletion；持有真实句柄并核 PID/创建时间/映像，确认服务及工作树结算。禁用/停止前的归属检查不能只信 journal 提供的任意 servicePath；同名第三方服务不能被误禁用。适配里的 `running=false` 不等于生产退出证据。
5. **入口、UAC 和自删除。** 安装侧先持久化完整保护脚本，再注册精确 64 位自有入口。普通用户先完成系统 UAC 再读取受保护脚本；完整读入并关闭脚本句柄后执行。下载 Setup 的同源嵌入逻辑负责最后窗口恢复。注册仍存在时，若需要修复缺失脚本，须从与本代期望摘要一致的可信代码恢复，不得绕开模块的“可用恢复入口”条件或运行任意修改后的脚本。
6. **保留数据与重装。** 实际账本、WAL/SHM、unknown/outbox、原 SID/installationId 和 ReachDesktop spool 不在 programPlan 中。新安装器先处理未完成卸载，接受可信 uninstalled tombstone 后创建新 generation；不能把旧 journal 当安装 rollback，也不能新建第二套身份来绕过问题。

以上合同完成并取得真实证据前，本报告只支持继续生产装配，不支持安装/卸载成功声明。没有因本轮机制测试修改基础 0/52 或 Reach Desk 0/5 的完整任务验收状态。
