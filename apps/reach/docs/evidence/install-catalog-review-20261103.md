# 安装归属与原子写独立复核

作者：Ray Zhang（Ray）。日期：2026-11-03。独立复核：Codex `/root/reach_plan_review`。

结论：本报告接受下述固定源码的安装归属、临时文件恢复，以及已执行的隔离安装流程。原 Node-only 半文件阻断重试问题已修复；最终范围内未发现新的阻断缺陷。这不是 I06/V03、完整安装或生产卸载验收，基础清单 0/52、Reach Desk 0/5 不变。

复核使用 `ara-git-review` 的只读程序，读取源码、测试、日志和真实夹具；独立执行一次已核摘要候选的 `--inspect`。没有重复运行 PowerShell 测试、Cargo、UAC 或安装，没有改动生产服务、机器 PATH、产品数据或 Git 历史。本文是新增的独立复核记录。humanizer 此前未找到，本报告人工审读，不声称调用该技能。

## 固定范围

仓库为 `E:/repos/ara`，分支 `dev`，基准 HEAD `90f2b1cdd138129e2d331d89a37d70852e849739`。以下实现与测试当时都是未跟踪 WIP；本报告针对工作区精确文件，不是该 HEAD 已提交内容。

| 文件（相对 apps/reach） | SHA256 |
|---|---|
| `packaging/windows/install.ps1` | `f221fdc37835b3be9a400d7e0cc2fcc236ed2374438a99895272b55ba59fdfd6` |
| `packaging/windows/ownership.ps1` | `151a48c0cb5e8bdeab083992be55810c082d0df6ad487d6e2d505cb9f5bde746` |
| `packaging/windows/maintenance-writes.ps1` | `391a6ba705cb99cae16d1e5f5984488059041e97f9435b705a17c1ddc0259f16` |
| `packaging/windows/setup/src/main.rs` | `8364eedd33624613d37cce157a9a8de0e6e5a40c453ced0173881c0c3159e078` |
| `packaging/windows/setup/build.rs` | `4d7c6603b03d57f183eca165ecc7cb37fca40889fc4aebf705610abfa201a903` |
| `packaging/windows/build-complete.ps1` | `f6b572aa140098a75b0b4fd36f8d936b7985d9733cddb64f1ad4534e2a8187cd` |
| `tests/windows-maintenance-writes.test.ps1` | `8482d777310f40604de0d92b3b4bef2e1ea111b69473d2e2933042eef0a4a8b7` |
| `tests/windows-install-catalog.test.ps1` | `65758c4ddee2bc0bf86b22ddf8299dbd79a2d8430220f95b372f65179f3e96d8` |
| `tests/windows-package-stage.test.ps1` | `2e260d833ef27c6617c4f235c11c5cd77c1a9d4fc7c5ac3c3d83dc17d5c30f6d` |

全部上述文件已读。必要依赖另读 `payload.ps1`（`e157371a0ca649dd260a2cdaa3bb426db6eb35a35413a17941b79c7bcb51b57e`）、payload fixture、删除计划和既有安装事务测试。此轮没有重新审查未变化的 Node、桌面运行时或原卸载机制全部实现，也未将它们重新计为本轮交付。

输入/输出清单 [install-catalog-inputs-20261103.json](install-catalog-inputs-20261103.json) 摘要为 `091fb4b723461f6c15fb4977d306c52ab0324a9843da1cc3dbbd50d2fc0f472a`。复核者实际重算其中全部 29 项字节长度与 SHA256，全部相符。另核对 `work/install-catalog-snapshot-0a291496a0be4879a7a1a704b035a3d3` 的 12 份物理副本，包括旧 install 7b82、最终 install f221、两个 catalog 测试版本 ea0f/6575，均匹配；这些副本提供版本保留，不代表重新执行。

## 关键源码结论

1. 两把持久锁按 external → root/install.lock 获取。建锁直接使用带 ACL 的 `CreateNew`，没有通过依赖已持锁的原子写接口自举。新写入者在持锁后先恢复临时文件；安装 schema4 journal 阻止旧版安装器忽略 catalog 继续写入。
2. `install.lock` 中的 intent 只负责精确临时文件归属，不拥有安装阶段。完整 JSON 与 LF `Flush(true)` 后才创建临时文件；恢复先验证整个日志，再处理已登记的精确路径。未登记的旧 `.new-GUID` 不被认领或删除。
3. 半 header、半尾行不能产生临时文件归属。恢复确认已登记临时文件全部不存在后，才在仍持有的同一锁中截断并 flush；清理被占用文件失败时保留记录。因此已完成写入不会永久消耗 16 MiB 的日志额度。此结论针对进程中断和已执行的文件故障，不是断电、存储设备持久性测试。
4. WinPS 5.1 的 `[IO.File]::Replace(...,$null)` 曾实际失败。最终使用 `[System.Management.Automation.Language.NullString]::Value` 传递 CLR null；r4 实际创建、替换、占用拒绝和重开锁恢复均已执行，不能再把这一层描述为 WriteJson 适配器验证。
5. 完整包及 Node-only 都在建 stage 前持久化精确文件集合，同时登记随机 stage 和最终目录。文件以 `CreateNew` 写入 stage，校验后 Move；Move 两侧中断均有归属记录。回滚只恢复活动身份，不丢弃候选文件的归属。未知既有最终文件摘要不符时拒绝，不覆盖或认领。
6. `previousDeployment` 用 JSON 往返取得独立快照。恢复旧 manifest 后再恢复 catalog 的代次和摘要，持久化 restored 之后才恢复服务运行。相同包重装取得新 deploymentGeneration，Node installationId 与绑定 SID 保留。
7. 旧安装导入只读取可信 current、previous、journal target 指向的记录，不扫描 versions 猜测归属。Node-only 按旧合同导入两个固定文件名；完整旧包分支要求 payload manifest 字节摘要匹配可信记录，再从 manifest 取精确路径。损坏候选的运行字节与其文件归属分开，恢复旧可运行版本不需要先运行坏候选。
8. Setup 嵌入新模块并在 `--inspect` 暴露各自摘要；build.rs 追踪模块变化；完整打包记录 12 个来源摘要、重查构建前后来源并校对内嵌摘要。来源身份加入输出目录，保留上一候选。

原 P2 的具体触发为：Node-only 直接写最终文件，中途退出后重跑在摘要比较处永久失败。最终代码改为随机 stage；catalog 测试实际留下两字节 stage 文件，再次安装得到完整最终文件，旧部分文件仍有归属，没有通过删除未知文件规避问题。

## 执行证据与版本桥接

catalog 共 **12 个不同用例成功**，由 **8 + 2 + 1 + 1** 四段证据组成，不是最终同一文件上的一次全新 12/12 执行。

| 原始日志 | 实际执行及边界 | SHA256 |
|---|---|---|
| [maintenance-writes-r4.log](maintenance-writes-r4.log) | 10/10；真实 FileStream、Replace、Flush、文件占用与独占锁；普通测试用户 ACL | `6f3e8a83d0d6daf88ac7c02cfdfdbdf76127eaf4ddbf3bd19f80c13df4ea90a4` |
| [install-catalog-r2.log](install-catalog-r2.log) | 原 8/8；真实文件、原子写、锁及 HKCU，SCM/进程/Node/生产 ACL 为适配器 | `69d6eac3c7e9e652acf1f5ff392b13b8c9f145bf3a16f2ff4cf9826020b3e895` |
| [install-catalog-additional-r1.log](install-catalog-additional-r1.log) | 两个旧版导入用例通过；随后完整包用例因旧 +37 长度余量失败，保留失败 | `78ed8417fbffcab89b6d45ad3ff6c97b1923bac100f59920fc1c955bd6f4a5fc` |
| [install-catalog-complete-r2.log](install-catalog-complete-r2.log) | 移除已不需要的临时文件余量后，只重跑完整包一项，1/1 | `07f9d0312ff786eb6b475328c6c14339c056355ef35f78080464fee26869277c` |
| [install-catalog-legacy-complete-r1.log](install-catalog-legacy-complete-r1.log) | 追加旧完整包 manifest 导入一项，1/1；当前包和损坏候选各保留精确 9 文件归属 | `f10c4ff556910a31bd07318b8e350a8714476d922efafa437abd16e4049568f8` |
| [installer-catalog-stage-r2.log](installer-catalog-stage-r2.log) | 4/4；真实 stage 文件与目录；metadata WriteJson 和生产 ACL 有适配器 | `9c11c39eccd710fb6e8165937aad1bdb1ead459df3c3d90f75ebc470f7e3f920` |
| [installer-catalog-transaction-r1.log](installer-catalog-transaction-r1.log) | 22/22 既有安装事务回归；并非 22 项真实 SCM/UAC 验证 | `4c751cb7f6481b299e018a360bb5f6be289d694573c393f31980d5cc31a7d27d` |

主代理执行上述测试；复核者完整回读日志、相关测试代码和真实文件结果，没有重复整组。原 8 项日志中的 `first-install status failure` 实际注入 `before-commit`；最终仅将名称改为 `first-install commit interruption`，原日志保留旧名，不把名称修正算成新执行。

源码桥接进行了可重算核对：

- 将最终 install.ps1 中的两行新注释及 `$target.Length-ge260` 仅在内存逆换成旧注释和 `$target.Length+37-ge260`，SHA256 精确恢复为此前已独立逐行读取的 `7b82ba43b3cd335cd56e02967a6903fd65aabd2636d5dfceb9ae948fb5a48395`。因此旧 8 项及两个 legacy Node 用例的应用路径未变化；受影响的完整 stage 分支另有最终 1 项和 4 项证据。
- 从最终 catalog 测试 6575 仅移除末尾新增的旧完整包用例，精确恢复前一测试文件 `ea0f16d9595467a56707cae9fa62580d051521b3d59caf67d0a5169131b5c9b1`。从 ea0f 逆去 CasePattern、payload fixture 导入、可选 ZipBytes 分支及资源释放、三个新增用例和空选择保护，恢复旧用例名及原单个末尾换行，SHA256 精确恢复为此前读取的 `42d0a3da0c945230c0d083f1998c97c0e1b98652462c601fe3de41522240e56d`。这些是内存中的文本/摘要计算，没有执行重建源码，也没有改写文件。
- `ownership.ps1`、`maintenance-writes.ps1` 与最终原子写测试的固定摘要未变。CasePattern 是显式选择补充用例；不能据单项 RESULT 推导完整测试文件全量重新通过。

实际夹具回查：

- `work/install-catalog-ec079e95211241d09a27ba55a7ffe200` 的 8 个夹具：部分 stage 的 Node 为两字节，最终安装仍 committed；回滚与恢复分别记录 rolled_back/recovered，catalog 的 install.json 摘要相符；故意追加空白的反例确有摘要不符，保留原活动安装。
- `work/install-catalog-2ededd556f304d86a1b7705627bac62b` 的两个 legacy 成功夹具：均保留两个精确 Node 归属组；`ffff.../keep.txt` 仍在且未被认领；损坏的候选字节未被悄悄修复。第三个失败夹具没有产生完整部署。
- `work/install-catalog-16cb24f395374c52b00d740d8459331b` 的完整包夹具：record schema2、9 个 manifest 文件、committed，实际 install.json 摘要与 catalog 相符。这是小型载荷夹具，不是 6,327 文件的真实安装。
- `work/install-catalog-e0569c1350594bf9add74a2707c87930` 的补充旧完整包夹具：去掉新代次字段和 catalog，保留旧 schema2 record/journal 后，从生产流程重新导入；两个 complete 组各有 9 文件。复核者读取实际文件，活动 manifest 摘要与 record 相同，坏候选 `desktop/config.toml` 仍为 `damaged candidate bytes`；导入不要求坏候选通过运行字节完整性验证，损坏内容也未被改写。

范围注意：前两个 legacy 用例的安装 record 均为 schema1 Node-only；journal schema2 不代表完整包 record schema2。最后单独追加的用例才执行旧完整包 record schema2 的 manifest 摘要导入分支。两类现均有隔离运行证据，均不等于实机迁移验收。

保留的故障包括 maintenance-writes-r1 的真实 Replace 非法路径、r2 的测试作用域关闭句柄、r3 的测试输入拼接问题、catalog-r1 的测试 SCM 初态问题，以及 additional-r1 的长度失败。最终证据不覆盖或删除这些失败。Replace 与 Node-only stage 两项产品修正分别由真实替换和部分 stage 重试证据支撑。

## 新候选核对

候选目录：`outputs/windows-complete-716a23ad70230a1c-ef23a1806457`。

| 对象 | 实际摘要 |
|---|---|
| `Reach-Setup-0.1.0-preview-08a3b066680d4803.exe` | `08a3b066680d4803ab45bfd9dedfa40e57a8d04d89f25ae803a4b74859cd2c4b` |
| 构建 ZIP | `716a23ad70230a1c4619b83c49569f69257f49ba58e31c6eeb0c0cdf7a82ac63` |
| ZIP manifest | `2bff6d96c13e1959ce29998ae66cb7d4b6ef97c6e8def9e588a43f504b5f3806` |
| `package.json` | `855c1dd89037201f8c641389310b115d0370958ba15183549e0273f64228ed96` |

复核者重算实际 EXE、ZIP 和 12 个 `sourceInputs` 文件摘要，全部匹配。随后直接执行该已核 EXE 的 `--inspect`，核对 install、ownership、maintenance-writes、payload 和 manifest 摘要，均匹配；该分支在 UAC/安装入口之前返回。没有执行普通安装参数。

主代理构建日志记录 `--verify-payload` 实际成功：6,327 文件、190,316,383 字节、Windows PowerShell 5.1.26100.9711。复核者回读 [构建日志](install-catalog-build-r1.log)（`fae2a388867c3da9f5cef0ac893dec7b6e0739eaed0e2622127aeebecb546fdf`）和候选 `verify-payload.txt`，没有重复全部载荷验证。另回读 Setup clippy 成功和 1/1 普通原生身份/私有脚本传输测试；它们不执行安装。

Setup deny-r2 日志为 advisories/bans/licenses/sources 全部通过，存在未使用许可 allow 项的警告；r1 的 `--config` 参数位置错误保留，不计为审计成功。新候选资源记录 [install-catalog-setup-resources.json](install-catalog-setup-resources.json)（`10365699c5c572b9b585d09f9cbcae9a131dc8e7b84f04331fbcb572112ca9f9`）声明实际读取 10 个 ICO 帧及 Reach Setup/Ray Zhang 资源；记录的 EXE 摘要与复核者重算一致。复核者读取该记录，没有再运行资源提取工具。

`package.json` 的 `installationTested=false`、`codeSigned=false` 与本报告一致。新候选不属于此前 fe15 的 374 项清单；此前固定报告不被改写成新候选证明。

## 仍开放的边界

- 真实 SYSTEM/SCM、UAC、生产 Owner/DACL、机器 PATH、登录会话、升级/重装和完整卸载没有由本轮隔离证据验收。
- 当前 Setup 还没有生产卸载分派，安装器仍拒绝 schema3 卸载 journal。此次 catalog/intent 是后续生产装配基础，不能宣布卸载入口已可用。
- 保留数据库、unknown/outbox、安装身份和桌面 spool 的产品合同仍需在真实生命周期中验收；适配器返回的固定 Node ID 不是实际 Node 启动证明。
- 本报告接受范围限于固定实现与明确列出的成功路径和故障路径；没有将文档、源码、隔离执行、候选内嵌校验和实机安装合并为同一种证据。
