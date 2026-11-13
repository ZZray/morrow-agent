# Windows 安装、更新与卸载

作者：Ray Zhang（Ray）。更新：2026-11-04。范围：D05、C03/C04、I01–I06。状态：服务宿主、桌面及Agent完整载荷、安装/卸载入口候选已实现；真实 UAC/SCM/SYSTEM、升级故障与干净机器安装尚未验收，不能代表 I01–I06 完成。

## 用户动作与安装组成

用户双击安装器，Windows 按需显示系统 UAC；确认后自动校验发行包、安装文件、注册服务、加入机器 PATH、启动服务并退出。产品不增加下一步或完成按钮。安装成功必须确认实际服务进入 running；写入服务注册表但未启动不算成功。未配对的服务保持运行，等待 `reach pair`，不要求模型密钥或业务产品。

首版选择 Windows 自动延迟启动，服务名 `RYReach`，服务账户为 LocalSystem。该启动类型是实现选择，不改写成用户原话。桌面后端运行在明确的交互用户会话中，不能在 Session 0 伪造桌面可用；其打包和登录启动随 T05/I01 接入。

| 内容 | 位置与所有者 |
|---|---|
| 程序与受保护安装记录 | `%ProgramFiles%/RY/Reach`；SYSTEM/Administrators 可修改，普通用户只读执行 |
| CLI | 安装目录的 `bin/`，加入机器 PATH；新终端可直接执行 `reach` |
| 安装身份、账本、未上传收据 | `%ProgramData%/RY/Reach`；服务唯一持有，不随程序升级重建 |
| 配对主体 | 首次安装明确的 Windows 用户 SID；受保护的服务/安装配置及 `%ProgramData%/RY/Reach.installation.json` 保留其归属，后者与账本目录并列 |
| 桌面助手 | 与安装共用版本、许可及配置，运行会话单独记录；不拥有另一套 Node 身份 |

最终发行包含所需桌面运行时，现场用户无需安装 Rust、Node、Python 或开发工具。Reach Desk 是另行选装的云端子项目，不进入默认 Windows 安装依赖。

## 状态与本机身份

服务唯一打开安装账本。普通 `pair/status` 通过 `\\.\pipe\RY.Reach.Control.v1` 访问服务，不回退到 AppData，也不在服务不可用时直接打开账本。生产客户端在发送配对码前查询 SCM 当前 PID，并与已连接管道的实际服务端 PID 比对；身份变化立即失败。

管道拒绝远程客户端。配对主体拥有明确的数据读写访问位，不授予创建同名管道实例的权限；SYSTEM 和管理员负责服务管理。客户端使用 identification-only SQOS，不能被假管道借用其操作权限。此处限制的是谁可以绑定整台机器，不增加工具权限模式或逐次操作审批。

安装器同时验证系统锚点及祖先、产品目录和关键文件的 Windows Owner 与 DACL。只替换 DACL 不足以接管原由其他用户拥有的目录，因为原 Owner 仍能修改权限。候选安装器为新产品目录建立 Administrators Owner 和 SYSTEM/Administrators 写权限；遇到不可信已有目录拒绝，不清空或采用其中的身份。系统锚点允许 TrustedInstaller，保留 ProgramData 正常的创建子目录权限，拒绝不可信主体删除子项、改权限或接管当前目录的授权。共享 RY 父目录只验证，不重写其他产品的 ACL。reparse/junction 路径拒绝。以上写入行为尚未经过真实提权安装验收。

## 配对、断线与停止

配对在没有正在执行操作、未恢复操作或未 ACK 收据时进行。进入配对前停止新领取、完整处理已经发出的 poll，并结束旧身份的上传任务；不能直接丢弃执行 future 来换身份。操作执行中到达的配对请求返回 busy，不排在操作后自动重配。

服务保存网络配对 pending，保留原 attemptId、输入和安装凭据。成功响应中的身份与本机完成收据同事务提交。IPC 客户端断开不取消宿主已接纳的配对；相同输入重试读原收据，并同时显示当前绑定，避免把较早 epoch 的收据当作当前状态。网络结果未知时不新造尝试。

SCM stop/shutdown 立即设置停止信号。服务不再领取新任务，已经启动的工作进程树由 Job 终止并等待确认，随后持久保存 unknown 及实际停止结果；确认未启动的操作可以记录 cancelled。停止不表示撤销已发生效果。未 ACK 的收据留在原账本，重启上传原记录，不重做动作。停止报告须在工作进程和本机传输退出之后发送。

## 更新与恢复合同

1. 校验来源、目标架构、完整性和所有第三方许可，暂存新版本；保持原程序和状态可恢复。
2. 向现有宿主申请 `maintenance-stop`。该请求预占本机变更入口，完整处理已发出的请求，结束旧上传任务后，检查 pending pair、本地 active/outbox 和远端 pending；网络无法确认或未结算时拒绝。通过后原子停止领取并退出，不使用可过期的维护租约。
3. 原宿主完成当前收据落账并停止，确认实际进程退出后切换程序及服务指向。状态数据库使用一致性备份，不能只复制运行中的主文件而遗漏 WAL。
4. 新版启动、查询身份和配对 epoch、验证受保护状态后才宣布成功。兼容升级不创建第二个服务或 installationId。
5. 启动失败恢复旧程序指向和服务。不能恢复一个落后的操作账本来重放已执行动作；数据库不兼容须有明确迁移和回退合同。未知新 schema 版本拒绝打开。

安装器在受保护目录持有跨进程事务锁。升级必须收到明确维护 ACK，再确认 SCM stopped 和原进程句柄退出；ACK 丢失不能据服务已停而继续切换。新程序启动后可能领取工作，若后续验收失败，恢复先合作停止当前进程并保留新产生的 unknown/outbox，不恢复旧数据库。

安装 journal 记录旧/新程序、原运行状态、进程身份和 PATH 变更。恢复旧程序时先将旧路径与 disabled 启动方式一起写入 SCM，恢复 CLI/manifest 后持久化 `restored`，再恢复自动延迟启动及原运行状态。`restored` 的重试不再次停止已恢复的旧程序。`committed` 是不可自动回滚边界；`last-install-result.json` 中的 `validationPassed` 只说明提交前检查通过，必须与相同 SHA 的 committed journal 合看。

PATH 保留未展开文本与 RegistryValueKind。只有明确写入且当前值仍等于本次写入值时才撤销；若中断导致写入归属不明或其他程序已更改 PATH，保留现状，不凭相同路径文本删除他人条目。这种恢复可能留下一个待下次安装核对的 PATH 项。

当前只接受已知程序版本 0.1.0 与 Node schema 1。跨 schema 迁移及一致性备份尚未实现，不允许把当前回滚流程套到新 schema。上述真实安装、升级、断电及故障恢复仍须由 I03/I04 验证。

安装记录另有 schema1（旧 Node-only）和 schema2（完整载荷），两者均保留 `sha256` 表示 Node。schema2 增加整包 SHA、逐文件清单 SHA 与桌面载荷标记，目录以完整包摘要区分；运行时单独更新也生成新目录。回滚先核目标事务身份，恢复旧版本前才要求旧包全部字节完整，避免坏候选本身阻断恢复。安装 schema 的变化不改变账本 schema。

独立的 `payload-manifest.json` 自本轮完整候选使用schema2，要求 `agentBundled:true`、准确agentSha256、包内Agent及相对配置；整数inspectionLeaseVersion固定1。ZIP、已装树和新Setup共同核完整集合与三处摘要绑定。旧payload schema1可作历史验证/回滚，不得夹带Agent保留字段或文件；新完整构建不能省略Agent后降级成schema1。Node识别同目录schema2声明后，缺配置、坏镜像、非法lease或开发覆盖均拒绝；旧无声明/旧schema1保留原可选行为。Agent与配置沿全文件清单进入现有版本归属，不改变install记录、journal或Node账本版本。

新跟踪部署使用 schema4/operation=install 的安装 journal，阻止旧安装器忽略 generation/catalog 后继续写入；旧 schema1/2 journal 可先恢复再导入。`deployment.json` 保存当前记录摘要、独立 deploymentGeneration 和明确的版本/stage 文件名单。每次成功部署都换新代次，同包也不例外；失败恢复旧代次，但保留已登记候选的文件归属。账本的 installationId、绑定 SID 与未上传收据保持原样。源码接入及准确验证范围见[安装归属证据](evidence/install-catalog-20261103.md)，不能据此视为真实系统安装已验收。

维护操作先取得数据父目录的外部锁，再取得原程序根目录的永久 install.lock。后者附带临时原子写的归属意图：完整记录 Flush 后才创建随机临时文件，恢复只清确切登记路径，清理确认完成后在持锁状态退休这些记录。它不替代安装 journal，也不授权按 `.new-GUID` 后缀删除旧未知文件。完整包与 Node-only 均先登记 stage/final 名单，再写随机 stage，校验后发布。卸载 schema3 分派已接入候选，实际系统安装尚未验收。

## 安装候选的构建与证据

[完整打包脚本](../packaging/windows/build-complete.ps1)接收已验证Node、静态helper、Agent侧车、固定便携Python及各自摘要。逐文件ZIP覆盖所有执行文件、配置、许可与provenance；版本不可原地混装。Node/helper/Agent/setup核系统运行库依赖，Python原生依赖使用固定来源的包内DLL。构建先调用[独立依赖审计](../packaging/windows/audit-dependencies.ps1)：Node/Setup用Reach策略，Desktop用自己的策略，JSONL用既有Lite策略；锁和策略不变，并核rpi三包固定来源。原始许可收集涵盖四个实际Rust依赖图和包内Python/桌面声明。旧[Node-only配方](../packaging/windows/build.ps1)保留为历史入口。

`--inspect`无需提权，返回包、Node、Agent、清单、检查脚本及声明摘要；`--verify-payload`通过实际私有stdin和系统WinPS5.1验证完整ZIP及必需Agent，仍不执行安装。新候选的原件与本地执行见[Agent完整包](evidence/agent-package-20261104.md)，历史桌面包证据仍保留在[完整载荷记录](evidence/full-installer-runtime-20261103.md)。

setup 从当前 Windows token 获取绑定 SID，通过系统 UAC 提权，使用 Windows API 定位系统 PowerShell。完整脚本通过私有 stdin 一次解析，不执行用户临时目录中的脚本。具体错误由提权子进程显示一次。候选尚未签名，普通 host、事务函数测试及制品检查的范围见[安装候选证据](evidence/node-installer-20261102.md)。

## 卸载与共存

卸载先停止服务并等待工作进程结算，再移除本安装的服务、程序和 PATH 项。默认保留安装身份、账本和证据，便于重新安装恢复原配对；永久清除数据须用户明确选择，不能由某个可选产品卸载顺带执行。PATH 按完整路径比较和去重，不覆盖用户其他条目。

Windows“已安装的应用”与下载 Setup `--uninstall` 使用同源维护入口。系统应用列表通过系统 PowerShell 按需 UAC，核摘要后完整加载 `%ProgramData%/RY/Reach.maintenance/uninstall.ps1`，再执行卸载；不是另一个被控端。注册和脚本随安装事务发布与恢复。卸载保留根目录和永久锁，以 schema3 journal 为唯一事务权威。重新安装先持久化 schema4/prepared 接管记录，再切换 catalog；中断可以重试，不删除已归属的新 stage。每次成功安装获得新部署代次，原设备身份及账本保留。具体执行证据见[维护接线](evidence/maintenance-integration-20261103.md)。

多个业务产品共用同一基础 Node。单个产品仅取消自己的能力登记，不卸载仍被使用的基础服务。最终包的引用记录、占用判断和卸载行为由 I05/P05 验收。

## 验收门槛

普通用户前台 host 使用随机独立管道和临时状态，可验证本机协议、配对、进程清理与故障恢复；它不能证明 SCM 生命周期、SYSTEM 权限、可信 Owner、UAC、机器 PATH、桌面登录会话或干净机器安装。最终 I06/V03 必须补足这些真实环境证据，并记录安装版本、更新前后身份、进程树、原收据及回退结果。
