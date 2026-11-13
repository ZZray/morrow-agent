# Reach Windows maintenance integration review — 2026-11-03

结论：本轮冻结版本的维护入口、卸载生产绑定和重装接管已完成限定范围复审；两项实际 ACL 问题修复后，未再确认阻断该范围的缺陷。完整安装候选已独立执行只读 `--inspect` 并与冻结源码对应。此结论不构成真实 Windows 安装、UAC、SCM 或 Apps UI 验收；产品验收仍为 **0/52**，Reach Desk 仍为 **0/5**。

本报告使用 `ara-git-review`，审查者未修改实现、未运行 Cargo、未安装、未提权、未写生产 HKLM/SCM。仅新增本报告及独立核查证据。此前的 catalog/mechanism 报告保留原结论和版本边界，不覆盖为本轮证明。

## 目标版本与覆盖

- 仓库 `E:/repos/ara`，项目 `apps/reach`，分支 `dev`；检查时 HEAD 为 `90f2b1cdd138129e2d331d89a37d70852e849739`。
- 目标是指定 WIP 文件及物理快照，不是 staged/commit diff。下列 18 项 Git 状态均为 `??`，不能用 HEAD 代替其内容；本轮未提交、推送。
- 最终清单 [maintenance-integration-inputs-20261103-r2.json](maintenance-integration-inputs-20261103-r2.json)，SHA256 `b374152a9048109cd33d4dc620950ed6a8df99fa899d81eff45bc9c6f2a26be9`。
- 对应物理快照 `work/maintenance-source-6921cecb3f8b477b95645bc72379a020`。独立逐项计算当前文件和快照 SHA，**18/18 均匹配**，详细结果见 [maintenance-source-review-r2.json](maintenance-source-review-r2.json)。
- 初版 17 项清单及其快照也已核对：快照 17/17 匹配；当前唯一变化为旧卸载机制测试改用历史 fixture。r2 新增 fixture，全部生产源码保持不变。

路径均相对 `E:/repos/ara/apps/reach`。`reviewed` 包括本轮生产接线审阅及明确注明的前轮不变内容复核；身份核对不算重新完成语义审查。

| 状态 | 路径 | 范围 |
| --- | --- | --- |
| reviewed | `packaging/windows/install.ps1` | 统一初始化、双锁、C# owned SCM 方法、回滚、恢复及安装尾部接线 |
| reviewed | `packaging/windows/ownership.ps1` | recovery 属性、部署归属与恢复身份；与前轮 catalog 合同结合核查 |
| reviewed | `packaging/windows/maintenance-entry.ps1` | 全文件；ACL、Apps 命令、发布/回滚、缺失脚本修复、移除 |
| reviewed | `packaging/windows/uninstall-host.ps1` | 全文件；当前归属验证、SCM absence、安装/卸载分派和 prepared 接管 |
| reviewed | `packaging/windows/uninstall-transaction.ps1` | 全文件；阶段顺序、提交恢复；新增 deployment/record SHA 绑定 |
| reviewed | `packaging/windows/setup/src/main.rs` | 实际共享模块组装、`--uninstall` 参数/提权传递、恢复脚本、私有管道、两项测试 |
| reviewed | `packaging/windows/setup/build.rs` | 模块重建声明与构建输入 |
| reviewed | `packaging/windows/build-complete.ps1` | 源码身份、嵌入散列、完整候选与 payload 检查 |
| reviewed, unchanged | `packaging/windows/payload.ps1` | 前轮 payload 审查内容不变；核本轮调用与 SHA |
| reviewed, unchanged | `packaging/windows/maintenance-writes.ps1` | 前轮原子写审查内容不变；核本轮调用与 SHA |
| reviewed, unchanged | `packaging/windows/uninstall-files.ps1` | 前轮文件/PATH 机制内容不变；核本轮调用与 SHA |
| reviewed | `tests/windows-install-catalog.test.ps1` | 12 catalog + 10 maintenance 用例、实际主流程提取边界、替身和故障注入 |
| reviewed | `tests/windows-installer.test.ps1` | 本轮新增 `WaitReachServiceAbsent` 测试适配函数；核安装恢复测试、本轮日志及新 C# 实际编译；SCM/UAC/ACL 边界仍未覆盖 |
| reviewed, unchanged | `tests/windows-uninstall-files.test.ps1` | 前轮文件/PATH 用例和本轮 16 组日志 |
| reviewed | `tests/windows-uninstall-transaction.test.ps1` | 40 组机制范围；历史 fixture 目标修正 |
| reviewed | `tests/fixtures/windows-legacy-install-recovery.ps1` | 两个函数与历史源码逐字符匹配 |
| scope-excluded: semantic dependency re-audit | `packaging/windows/setup/Cargo.toml` | 检查清单、内容和构建身份；本轮没有重新审计依赖实现 |
| scope-excluded: semantic dependency re-audit | `packaging/windows/setup/Cargo.lock` | SHA 与快照一致；本轮没有重新审计依赖实现 |

`skipped`：上述已承诺生产接线审查范围内无跳过文件。附加构建输入 `resources.rs`、`src/windows_identity.rs`、`assets/brand/reach.ico` 仅核 package.json SHA；其实现和视觉设计不计入本轮复审覆盖。其余仓库文件、Node/Hub/Desk 产品行为及新功能开发均 scope-excluded。指定文件目标直接由清单和 Git 状态确定，未调用 OCR、未安装工具、未另派子代理。

## 已修复的实际问题与独立证据

本轮初始 `maintenance-entry.ps1` SHA 为 `7c00b92412408b60043da8e77de56b00ca260a9692db71872676567bf8f17ac7`。以下早期反例是当时实际工具输出的摘记，未保存成完整原始日志，不能将摘记冒充原始运行记录。修复后的执行另有完整日志。

1. **共享 HKLM 卸载父键被当作私有产品键拒绝。** 在 WinPS `5.1.26100.9711` 只读打开 Registry64 的 `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`，owner 为 SYSTEM；标准 `S-1-5-13` ACE 含 `SetValue, CreateSubKey, Delete, ReadKey`，原检查抛出 `Untrusted uninstall registry write access`。这会阻止正常入口初始化。当前 [maintenance-entry.ps1](../../packaging/windows/maintenance-entry.ps1) 第 9 行起区分共享 anchor 与受保护产品子键，并跳过 anchor 上不生效的 InheritOnly ACE。
2. **产品 ACL 漏检 GA/GW。** 使用内存 `RegistrySecurity`，owner Administrators、protected DACL、Everyone GA/GW；实际 `RegistryRights` 分别为 `268435456` 和 `1073741824`，原函数均接受。当前检查显式识别通用权限；产品键拒绝 GA/GW，anchor 拒绝有效 GA 及改权限/夺取所有权。

早期另在唯一 HKCU fixture `Software\RY\ReachReview-7a14062a02e24e1f80b68d7c8330854a` 验证父键写权限并不能直接绕过受保护子键：子键拒绝当前用户 Delete/WriteKey 后，`RegRenameKey` 返回 5，`DeleteSubKey` 被拒绝。第一次组合探针因清理 ACL 对象未标记修改而以失败结束；随后仅针对该唯一 key 显式恢复 ACL 并删除，确认 fixture 不存在。不能把第一次探针报告为 exit 0，也未改生产注册表。

**修复后独立探针 6/6**：从冻结文件读取一次 bytes，计算 SHA 后加载同一 bytes 中的函数；实际 WinPS 5.1 运行。实际 HKLM64 anchor 只读通过，生成的 protected Reach ACL 通过；Everyone GA/GW 产品键及有效 GA anchor 拒绝；InheritOnly GA anchor 正确跳过。日志 [maintenance-registry-acl-review-r1.log](maintenance-registry-acl-review-r1.log)，SHA256 `35c3697cc8f38d34486907f1d06706b7df5f717e86159a595a3549cdeba37e01`。生产模块 SHA `0a6b8569ba60bda4a1a361b624952ad77340672066dc2a34552919da8bd281ac`；测试产品 ACL 为内存对象，没有写 HKLM。

**启动脚本执行 4/4**：同样绑定上述模块 bytes，执行其实际双层 EncodedCommand。路径包含中文、空格及 `O'Brien`；命令长 10,435 字符。仅替换管理员门禁、移除 runas 请求并屏蔽错误对话框，保留外层等待/退出码、内层读取/校验/ScriptBlock 执行。

| 输入 | 实际结果 |
| --- | --- |
| 脚本执行后删除自身 | exit 0，marker 存在，脚本已删除；generation 传递成功 |
| payload `exit 17` | 外层 exit 17，marker 存在 |
| payload throw | exit 2，无 marker |
| SHA 不匹配 | exit 2，脚本未执行、无 marker |

日志 [maintenance-entry-bootstrap-review-r1.log](maintenance-entry-bootstrap-review-r1.log)，SHA256 `d1340567008bd82cce26516fecd7f614c128a1b8a85491b67b38ef1993e60c06`。该探针证明已加载脚本可自删及退出码传递，不证明真实 UAC 或 Windows Apps UI 启动。

## 生产接线判断

- 安装先持久化 `entryChange`，写私有脚本后发布注册表；失败恢复入口后才写 restored 边界、重启旧版本。注册表部分写入仅允许本事务 before/target 中的值，外来字段拒绝覆盖。
- 已安装入口和下载 Setup 共用同一维护模块；卸载不要求 payload 解码或新 owner。缺失脚本仅允许与已登记 SHA 完全相同的内嵌 bytes 修复，其他版本失败保留现场。
- 卸载 journal 绑定实际 deployment 文件 SHA、原 record SHA、generation、精确文件清单和入口。仅 committing/committed 允许同代 tombstone 替代原 record；注册项/脚本已删除的重试路径仍受身份和阶段约束。
- C# `AssertOwned` / `DisableOwned` / `RemoveOwned` 在同一个服务 handle 上核 exact binary path、独立进程服务类型和 LocalSystem；停用只改 start type。1072 表示待删除；后续必须等到真正 1060/null，不能将 DeleteService 成功当作已消失。源码判断已审，真实 SCM 效果仍待测。
- 卸载不依赖在线 maintenance ACK，等待原进程实际退出后才删程序。保留 canonical 锁、root metadata、ledger/outbox/spool；文件/PATH 移除依赖归属并保留不明内容。
- 重装先将 schema 4 `prepared` journal 落盘，再换 inactive catalog / 创建 stage。重试保留中途 stage 归属，回滚保留 tombstone。未发现新的接管断点。

## 已读测试证据及其边界

下列大组测试由主代理执行；本审查者读取最终日志和对应实现，没有重复运行或将其计作独立执行。日志 SHA 全部存于 [maintenance-review-artifact-hashes-r1.json](maintenance-review-artifact-hashes-r1.json)，其 SHA256 为 `8eb06d6316545d990e08461eea3795caa56dff78776e0009d853c828a2717c01`。

| 最终证据 | 结果 | 实际覆盖与替身 |
| --- | --- | --- |
| `maintenance-integration-final-r1.log` | 22/22 | 生产安装尾部及维护函数，真实普通文件、双锁、原子写、HKCU；SCM/进程、生产 ACL、Node 状态为替身 |
| `maintenance-windows-uninstall-transaction-final-r2.log` | 40/40 | 卸载阶段及故障恢复，真实隔离文件/HKCU；SCM、ACL、原子写为替身 |
| `maintenance-windows-uninstall-files-final.log` | 16/16 | 普通文件和 HKCU PATH；无生产服务/ACL |
| `work/maintenance-legacy-tests.log` | 22/22 | 旧安装恢复组，包含当前 C# 实际编译；不执行 SCM/UAC/ACL |
| `maintenance-setup-test-r1.log` | 2/2 | 实际 WinPS 私有管道和恢复脚本解析；不执行安装脚本 |
| `maintenance-setup-clippy-r1.log` | 成功 | 主代理 Setup clippy 日志；不是产品运行证据 |

旧 40 组首次最终运行只通过前 39 组，最后一项仍动态提取当前 `install.ps1` 并假设它拒绝卸载 journal，因此测试目标已过时。保留失败日志 `maintenance-windows-uninstall-transaction-final.log`（SHA `5decf0e223ed4603aba72881a97d4f283fa1540078b7957e36d67de36a553691`），没有计成全绿。

r2 改为固定历史 fixture 后，完整 40 组重新通过。独立 AST 对比确认 fixture 两个函数各唯一，`Extent.Text` 与历史 `f221fdc37835b3be9a400d7e0cc2fcc236ed2374438a99895272b55ba59fdfd6` 安装源码逐字符一致；fixture SHA `3f71e03e16d2f7872d505bb61351dd2741b1f851734af4f6134bb331b1fceeac`，证据 [maintenance-legacy-fixture-review-r1.json](maintenance-legacy-fixture-review-r1.json)。这项仅证明旧 **08a3 候选** writer 的 schema barrier，不声称当前安装器拒绝卸载，也不把旧候选说成正式发布安装。

## 最终完整候选

候选为 `outputs/windows-complete-716a23ad70230a1c-93fe5dccdd7f/Reach-Setup-0.1.0-preview-83a2a8e840a43c36.exe`；独立计算 EXE SHA256：

`83a2a8e840a43c36a3662d02d0c53a473825bf14cde73c79c5d6a9a9f82a491d`

实际运行该 EXE 的只读 `--inspect` 成功，嵌入安装脚本和全部维护模块 SHA 与冻结内容一致。独立重组恢复脚本得 SHA `134bf3659e9d58e36d5771800f6b69fdb02abe2aabdfe41e416072dd784cb0f5`，与 EXE 报告一致；package.json 的 16 项源码输入逐项匹配。见 [maintenance-candidate-review-r1.json](maintenance-candidate-review-r1.json) 及 [maintenance-candidate-inspect-review-r1.log](maintenance-candidate-inspect-review-r1.log)。

主代理实际构建/`--verify-payload` 日志显示 6,327 文件、190,316,383 bytes 在 WinPS `5.1.26100.9711` 通过；本审查者读取该日志，没有再次做 payload 执行。ZIP SHA `716a23ad70230a1c4619b83c49569f69257f49ba58e31c6eeb0c0cdf7a82ac63` 与旧候选 payload 一致，维护源码和 EXE 已变；不能引用旧 EXE 的检查代替此 EXE。主代理另提供 10 图标帧逐字节验证 JSON，本轮未独立重做视觉或资源检查。

候选元数据仍为 `installationTested=false`、`codeSigned=false`。真实首次安装、升级/回滚、重启、标准用户 Apps 卸载/UAC、SCM 停止与待删除、生产 HKLM 私有产品 ACL 创建、卸载后重装及完整业务闭环均未验收。本轮已证明维护接线与隔离环境恢复机制，后续真实安装验收仍需独立记录。
