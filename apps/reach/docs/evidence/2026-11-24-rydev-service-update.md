# RyDev Windows 服务与 Git 双源更新验收

作者为 Ray Zhang（Ray）。日期为 2026-11-24（Asia/Taipei）。任务线程为 `01a20b0e-dd9f-7b02-8151-9404cb5fe93f`。

## 范围与验收标准

Windows 节点和测试服务均使用 Morrow 的 Reach。RyDev 配对前核对实际安装版本和服务配置，关闭安装终端后检查服务仍在运行。强制结束该服务进程，记录 SCM 事件、新旧 PID 和原设备身份。配对后在浏览器查看首次有效心跳及在线状态，通过 Reach 调用 `hostname`，按操作 ID 打开网页回执并核对设备、标准输出和退出码。

GitHub 和 Gitee 每个发行标签指向同一 Git 提交，两个入口的安装器、清单及签名字节应一致。从同一个已核对的旧版分别执行 GitHub 更新和 GitHub 请求失败后的 Gitee 更新。每轮记录实际下载来源、目标版本、运行中二进制的 SHA-256、设备身份、配对和原操作回执。

## 本轮证据

| 检查项 | 结果 |
| --- | --- |
| 开始时的 Git 基线 | GitHub `main` 为 `4f258264405049ace92afba31b0497e21f6057b8`。Gitee 首次同步后核对到同一 `main`。 |
| SCM 隔离验证 | 安装器 22/22，安装目录编排 23/23，卸载事务 40/40，SSH 前置套件通过。原生失败动作声明的 ABI 调用到达 Windows SCM 并返回预期的无效句柄错误。服务真实注册与崩溃重启待验。 |
| 更新与签名 | Rust 更新器测试包含 Git 标签解析、标签及提交绑定、签名校验和来源限制。两端实际公开 Git 标签端点成功读取。发行工具成功签名并检查匹配的 Setup，错误版本号回归通过。两次完整安装目录回归均出现相同类别的间歇性 Windows `File.Replace` 错误，该套件的最终状态见后续记录。 |
| 测试 Web | Node `24.22.3` 上管理端 17 项和 TypeScript 检查通过。Chrome 登录实际测试入口，设备页显示空列表。RyDev 经局域网 SSH 到测试 HTTPS 入口的 `/healthz` 返回 Reach 服务和协议版本。 |
| RyDev 服务安装 | **受阻**。传入并运行 `0.1.19` SCM 验证包的工具调用在启动前被自动审批以 `blocked by policy` 拒绝。随后只读 SSH 核实安装器未传入，安装目录和 `RYReach` 服务均不存在。 |
| RyDev 首次在线和原回执 | 待签名基线在 RyDev 安装及配对。 |
| RyDev 两轮更新 | 待真实服务和签名发行就绪。RyDev 可达 Gitee REST。GitHub REST 返回 HTTP 403、公开额度为 0，因此版本发现使用 Git HTTPS 引用，发行附件走对应标签的下载路径。 |

SCM 进程强杀触发恢复可以在当前系统启动周期验收。微软文档将非零 `SERVICE_STOPPED` 失败恢复标志的生效点定在下次系统启动，单次强杀证据仅覆盖进程崩溃。 [Microsoft SCM 失败标志](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_failure_actions_flag)

相关合同见[安装与更新](../installation-update.md#git-自更新与-windows-服务恢复)。正式产品台账见[任务清单](../task-checklist.md)。

## 签名候选与分发状态

从提交 `a94da1f0ab11380e964e8fc8110da0de9edae404` 导出的源码构建 Windows x64 Node-only 安装包。GitHub 和 Gitee 的 `codex/reach-rydev` 均已核对到该提交，签名清单也绑定该提交。

| 版本 | Setup SHA-256 | 嵌入 Node SHA-256 | 分发 |
| --- | --- | --- | --- |
| 0.1.0 | `cc928275d1dd51ed2f20f477c5ba8f8af7437a03771d0ac0866c3a1fdaa854a1` | `f3960349babca3e87de35e99616aeacc9497db3e3733ab38658eaa30597f47f3` | 两端标签均已核对。GitHub 预览发行的安装包、清单及签名通过公开下载后的字节核对，Gitee 附件待上传。 |
| 0.1.1 | `4f54b9cd30f54fb7aa317fc982037b7f7811daa2b0a314facebe39855443e19e` | `eedfbecd2c497c06e30772443daca3b220d524c95e56c8bf1aa007ff50b5db98` | 已构建、检查并签名。等 RyDev 完成 0.1.0 基线验收后开放下载，避免设备启动后提前跨过基线。 |

[GitHub 0.1.0 预览版](https://github.com/ZZray/morrow-agent/releases/tag/reach-v0.1.0) · [Gitee 标签](https://gitee.com/rzjw/morrow-agent/tags)

Gitee 创建设定已选中 `reach-v0.1.0` 和预览类型。Chrome 扩展在添加本地文件时要求启用文件网址访问，Gitee 发行表单尚未提交。

在 RyDev 下载 0.1.0 后，从下载目录运行以下命令。测试 HTTPS 地址通过本轮专用 SSH 转发提供。

```powershell
./Reach-Node-Setup-x64.exe --server-url https://127.0.0.1:43143
```

安装退出后，保留原安装日志。接下来核对 `sc.exe qc RYReach`、`sc.exe qfailure RYReach`、`sc.exe qfailureflag RYReach`、实际服务 PID 和二进制摘要。真机证据仍待补齐。安装目录完整回归三次在不同用例遇到 `File.Replace`，两个已定位失败用例分别单独通过。 [完整回归日志](../../work/signed-update-version-smoke/catalog-sequential.txt)


## 双击安装修订

RyDev 用户双击 0.1.0 后看到安装失败和回滚提示。窗口中的状态为 `awaiting_initialization`，`serverUrl` 为空，并包含乱码。用旧 Node 实际输出和 Windows PowerShell 5.1 复现，同一份 UTF-8 状态在 CP936 下使 `ConvertFrom-Json` 抛出 `ArgumentException`，指定 UTF-8 后正确解析。

Setup 现在以 UTF-8 收发私有 PowerShell 脚本和进程输出。无参数双击安装时，事务提交后由发起安装的用户进程检查服务端地址。未设置时弹出空白输入框，保存调用已安装的 `ryreach config set server-url`。已有地址时跳过，关闭窗口或选择「稍后」会保留已完成的安装。网络检查失败时保留输入，并提示地址是否已保存。

0.1.2 是仅供 RyDev 重试的本地 x64 候选。源码以 `a94da1f0ab11380e964e8fc8110da0de9edae404` 为基线，叠加本轮安装器和构建文件。具体路径与 SHA-256 见[构建来源](../../outputs/rydev-double-click/source-identity.json)。Setup SHA-256 为 `4853230e86b2063c1ad5fd6d6b8ed2ffd910185d71fb15884444a70981255cdb`，内嵌地址窗口脚本 SHA-256 为 `2751f3d26a5c2b0fcf91917a49534580c95e8081c16a1fd3e0b63620c52f2f71`。

- 交付快照的 Setup 原生测试 3/3，通过包含中文状态与错误输出的 Windows PowerShell 5.1 私有通道验证。
- 同一包 Node 可执行文件的 M11 集成测试 2/2，覆盖初次地址、改地址、TLS 拒绝和离线状态。安装脚本的 22 项隔离测试通过。
- WinForms 夹具使用实际地址窗口和模拟 `ryreach`。验证首次输入留空、非 HTTPS 地址拒绝、连通性失败后保留输入、重试关闭以及已有地址跳过。真实 RyDev 的双击、UAC、SCM 注册和弹窗尚待用户重试。
- `https://127.0.0.1:43143` 仅用作本轮测试。尝试恢复 RyDev SSH 回环转发的调用被自动审批拒绝。重试包通过 Morrow 本地文件交付，双源发布及更新验收继续暂停。


### RyDev 双击重试结果

2026-11-24，用户在 RyDev 双击 0.1.2，安装完成后出现服务端地址窗口。输入 `https://127.0.0.1:43143` 后，窗口提示地址已保存、尚未连通。 [RyDev 操作截图](../../outputs/rydev-double-click/rydev-setup-address.png)

同次只读核验确认 RyDev（CAN00）的 `RYReach` 处于 Running，PID 为 2816，启动类型为自动，`DelayedAutoStart=1`。安装收据版本为 0.1.2，`validationPassed=true`，安装事务为 `committed`，运行中的 Node SHA-256 与安装收据及重试包一致。 `ryreach config show` 返回已保存的测试地址和 `offline_pending`。检查时两端 43143 均无监听。双击安装、服务注册和首次地址输入已在 RyDev 验证，连接、配对、故障恢复与双源更新仍待验。


## RyDev 配对、网页上线和命令回执

2026-11-24，使用既有测试服务和 SSH 回环转发恢复 `https://127.0.0.1:43143`。在 RyDev 实际请求 `/healthz` 得到 Reach 与协议 1。RyDev 主机为 CAN00，沿用已安装的 0.1.2 和 `RYReach` 服务 PID 2816。

| 验证 | 实测 |
| --- | --- |
| 配对 | 通过测试账户的一次性码执行本机 `ryreach pair`，命名为 RyDev。Node ID 为 `ced7fbd3-b2ff-4d3f-beae-14130b51a0b1`，配对 epoch 为 1。 |
| 设备上线 | Chrome 设备详情显示在线、版本 0.1.2，并显示最近心跳。服务运行状态返回 `online=true`、末次心跳有值、间隔 60 秒。 |
| `hostname` | 从 Chrome 的 RyDev 设备详情提交一次。原操作 ID 为 `79544e3c-ebcf-47bd-a10e-8b127c098cfe`。网页回执显示输出 `CAN00`、退出码 0。原记录状态为 `succeeded`，收据共 6 条。按设备和命令检索，匹配的操作有 1 条。 |
| 隧道收尾 | RyDev 的 43143 仍在监听，HTTPS 健康检查通过，设备保持配对。双源更新继续暂停。 |

[设备在线截图](../../outputs/rydev-goal/rydev-online.jpg) · [网页 hostname 回执截图](../../outputs/rydev-goal/rydev-hostname-receipt.jpg) · [服务端原操作与事件](../../outputs/rydev-goal/rydev-pair-online-hostname.json) · [RyDev 隧道与配对记录](../../outputs/rydev-goal/rydev-tunnel-pair-witness.json)


## RyDev 强制结束服务后的自动恢复

2026-11-24 12:41:46（Asia/Taipei），RyDev（CAN00）上运行的是 0.1.2 的 `RYReach`，测试服务与隧道正常。结束前已确认 PID 2816 指向预期的 Node 二进制，设备在线，且没有进行中或待结算的操作。

| 检查 | 实测结果 |
| --- | --- |
| 结束进程 | 对 PID 2816 执行一次 `Stop-Process -Force`。134 ms 后观测到服务为 Stopped，PID 为 0。 |
| Windows 自动恢复 | SCM 系统事件 7031（记录 25608）明确记载意外终止及 5000 ms 后重启。约 5.207 秒观察到新 PID 30028 进入 Start Pending，约 5.869 秒进入 Running。新进程文件摘要与原 0.1.2 一致。 |
| 网页在线 | 服务端在结束旧进程约 6.969 秒后收到新心跳，Chrome 刷新设备页后显示在线。页面采样在恢复后，心跳间隔仍为 60 秒。 |
| 配对保留 | 前后安装 ID 和 Node ID 一致，epoch 保持 1。RyDev 查询显示仍已配对且常驻状态为 connected。 |
| 原 `hostname` 回执 | Chrome 刷新原操作 `79544e3c-ebcf-47bd-a10e-8b127c098cfe` 仍显示 `CAN00` 和退出码 0。服务端前后 6 条事件逐条一致，查询匹配的 `hostname` 操作仍只有 1 条。 |

[Windows SCM 原始事件和 PID 序列](../../outputs/rydev-goal/rydev-scm-restart.json) · [重启前设备和回执](../../outputs/rydev-goal/rydev-scm-web-before.json) · [重启后设备和回执](../../outputs/rydev-goal/rydev-scm-web-after.json) · [RyDev 配对复核](../../outputs/rydev-goal/rydev-scm-pair-after.json) · [重启后设备在线截图](../../outputs/rydev-goal/rydev-scm-online-after.jpg) · [重启后原回执截图](../../outputs/rydev-goal/rydev-scm-receipt-after.jpg)

## 双源更新续验

从已包含双击安装修订的 `aaebd6b776aa47ace0be0bdbc63878cd62338aa0` 构建两个版本。GitHub 和 Gitee 的 `codex/reach-rydev` 已分别查询到同一提交。两个版本使用同一枚内嵌测试公钥。独立校验读取了安装包、签名和清单的实际字节，确认 Ed25519 签名、清单中的版本与提交、安装包大小与 SHA-256 一致。签名覆盖更新清单，清单绑定 Setup 摘要。

| 版本 | Setup SHA-256 | 内嵌 Node SHA-256 | 分发状态 |
| --- | --- | --- | --- |
| 0.1.3 基线 | `14dfc49356f78e1e7421818a88b988f264e769b13cadbb9347fcc6a2fbbcb8cc` | `7c092114f9e432a2004fe2285cd05073dc4d186454910e3eb986bed94667afcf` | 两端 `reach-v0.1.3` 标签已核对。GitHub 已发布三份附件，均下载完整并逐个比对 SHA-256。清单和签名使用公开地址，Setup 使用 `gh release download`。Gitee 待上传。 |
| 0.1.4 目标 | `093bcec65518787f7c04c5f8cf4a1679e01ae27076ff030656ea453368c7f875` | `5eef0a860b16c65c6a265cd04d715b9cf0f98d857e97c1a122d8914af387525b` | 构建和签名已完成，等待真机基线确认后发布。 |

RyDev 实际仍运行 0.1.2，PID 30028。测试服务显示设备在线、原配对 epoch 为 1，原 `hostname` 回执的 `CAN00`、退出码 0 和 6 条事件仍可查询。该构建未内嵌更新公钥，需要先用 0.1.3 Setup 覆盖安装。RyDev 请求 GitHub 公开 Setup 下载地址得到 HTTP 200，55 秒内收到 687,932 字节后超时，未拿到完整的 16,691,200 字节。Gitee 0.1.3 发行表单已核对标签，Chrome 扩展拒绝读取本地附件，Gitee 公开发行列表为空。两轮自更新与更新后的状态均待验。

冻结源码的 Node 测试通过 32 项，Setup 测试通过 3 项。另行运行的 GitHub 和 Gitee 公开 HTTPS Git 标签测试通过。独立复核确认两轮应使用同一个 0.1.3 安装包，并用实际 `attempt-*.json`、下载文件摘要、安装事务与运行中 Node 文件验证来源和结果。第二轮仅对 Reach 服务的 GitHub 请求模拟断连，以真机回执记录为准。

[GitHub 0.1.3 发行](https://github.com/ZZray/morrow-agent/releases/tag/reach-v0.1.3) · [GitHub 发行附件摘要](../../outputs/rydev-dual-source/github-0.1.3-release-assets.json) · [Gitee 标签](https://gitee.com/rzjw/morrow-agent/tags) · [RyDev 0.1.2 实际运行](../../outputs/rydev-dual-source/rydev-0.1.2-preflight.json) · [原配对和回执复核](../../outputs/rydev-dual-source/rydev-0.1.2-original-pair-and-operation.json)

## 0.1.3 首次安装 OpenSSH 写入失败

用户双击安装后，Setup 报 `Atomic write target is outside owned maintenance paths`。从 `reach-v0.1.3` 导出源码，用原打包 OpenSSH ZIP 和 Windows PowerShell 5.1 复现。机器缺少 `sshd` 时，安装器需要写入共享的 OpenSSH 文件和默认配置。0.1.3 通过 Reach 维护记录写入器创建这些文件，该入口拒绝其固定允许列表之外的路径。此前 RyDev 复用了已运行的 OpenSSH，原测试也替换了实际写入器。

安装器现在使用已核对的 Program Files 和 ProgramData 锚点准备共享 OpenSSH。新文件在受检目录内独占创建临时文件，按需设置 ACL，写入并刷盘后无覆盖移动。已有共享文件与配置继续检查并保留。Reach 维护记录的写入允许列表保持原范围。

修复前后由独立复核确认。Windows PowerShell 5.1 回归覆盖未知目标拒绝、真实 ZIP 解包、已存在目标拒绝覆盖、配置保留、重试、写入 ACL 和原子写入恢复。原包用实际写入校验稳定报错，修复候选通过。维护写入 10 项、安装脚本 22 项、安装编排 24 项与 Setup 单测 3 项通过。安装编排首次运行触发长工作目录的 260 字符限制，缩短夹具目录后通过。真实空机双击、UAC 和 SCM 注册等待用户复试。

0.1.5 本地 x64 重试包构建基线为 `aaebd6b776aa47ace0be0bdbc63878cd62338aa0`，叠加本次两个安装脚本修订。Setup SHA-256 为 `a86a8c31494ab0c88b222d6eda08866b567f8d0127795c5acacdd88c01d87690`。公开下载继续提供 0.1.3。

[原包失败复现](../../outputs/worker-openssh-retest/0.1.3-clean-ssh-failure.txt) · [修复后 SSH 验证](../../outputs/worker-openssh-retest/windows-ssh-preparation.test.ps1.txt) · [打包检查](../../outputs/worker-openssh-retest/inspect-0.1.5.txt)

## 0.1.5 首次安装 SSH 监听检查失败

用户在另一台新 Windows 测试机双击 0.1.5，Setup 报 `sshd is not listening on port 22`。现场缺少 SSH 服务和端口日志，具体原因待验。OpenSSH 的 Windows 服务入口进入 Running 后才执行 `sshd_main`，而 0.1.5 在 Running 后只查询一次端口。用冻结的 0.1.5 脚本和延迟一次采样的监听夹具重现了同一报错。[OpenSSH 服务入口](https://github.com/PowerShell/openssh-portable/blob/b8c08ef9da9450a94a9c5ef717d96a7bd83f3332/contrib/win32/win32compat/wmain_sshd.c#L257-L265)

0.1.6 在 6 秒采样窗口内重复读取服务状态、进程 PID 和 TCP 22 监听归属。服务处于 Running 且 PID 与监听归属一致时继续安装。最终检查失败时显示查询错误、服务状态与退出码、端口占用 PID 或未监听超时。

Windows PowerShell 5.1 回归覆盖延迟监听、其他进程占用、端口不符、查询错误和服务停止。另用真实 `127.0.0.1:22` 监听验证第二次采样可从 Windows TCP 表识别匹配 PID，SCM 状态使用夹具。安装编排通过 24 项，覆盖实际文件、锁、原子写入和 HKCU，SCM 使用适配器。独立复核通过。新机双击、真实 `sshd` 启动、配对和上线等待现场复试。

[0.1.6 Windows x64 重试包](../../outputs/ssh-ready-retest/Reach-Node-Setup-0.1.6-preview-8afba0fadb605af8.exe) 暂供本机交付，继承 0.1.5 基线和 OpenSSH 写入修订。Setup SHA-256 为 `8afba0fadb605af80a0baca4ff13f9a3b4ee2aeb5618a2ebf01e57660b4ddec9`。实查 Setup 及 Node 均为 0.1.6，内嵌 SSH 脚本摘要与冻结源码一致。

[旧版失败复现](../../outputs/ssh-ready-retest/0.1.5-delayed-listener.txt) · [SSH 回归](../../outputs/ssh-ready-retest/windows-ssh-preparation.test.ps1.txt) · [真实环回监听记录](../../outputs/ssh-ready-retest/actual-loopback-listener.txt) · [安装编排结果](../../outputs/ssh-ready-retest/windows-install-catalog.test.ps1.txt) · [交付包检查](../../outputs/ssh-ready-retest/inspect-delivery-0.1.6.txt)

### 新测试机 0.1.6 复试

2026-11-24，用户发回安装失败截图 `codex-clipboard-49811cfc-c2a4-459a-84f5-d32ef113e46c.png`。0.1.6 报 `sshd did not listen on TCP port 22 within 6 seconds (state=Running, service PID=3432, exit code=0)`。按交付包内脚本，最后一次检查从服务查询读到该状态，并从 Windows TCP 查询得到空的 22 端口监听列表。安装停在 SSH 准备阶段，尚未注册本次 Reach Node 或进入地址弹窗。新机没有可用的诊断连接，实际监听地址、端口和启动日志待取回。

对照同一归档中的供应商脚本，两个入口注册相同的 `sshd.exe` 路径形式与服务特权。Reach 保留既有 SSH 配置，且不执行供应商脚本中的事件提供程序注册、`ssh-agent` 注册等步骤。目前无法由注册差异确定失败原因。下一次采样应获取实际服务路径及 PID，按 22 和服务 PID 查询 TCP 表，用 `netstat -ano` 交叉检查，再读取 OpenSSH 事件。诊断命令已用 Windows PowerShell 5.1 验证，实际临时 `127.0.0.1:22` 监听在两种查询中显示同一 PID。此次没有可用于确认新机根因的现场日志。

用户随后从同一台新机回传 PowerShell 输出。`sshd` 仍为 Running、PID `3432`、退出码 `0`，以 `LocalSystem` 运行 `C:\Program Files\RY\OpenSSH-10.0.0.0p2\sshd.exe`，启动命令未传其他参数。TCP 查询没有列出 22 或归属该 PID 的监听行，`netstat` 和 OpenSSH 事件查询亦无输出。失败以相同 PID 持续到安装器退出后的现场采样，单纯加长安装时等待缺乏依据。按实际二进制执行 `sshd -T -e` 可核对有效端口、监听地址和配置检查错误。该检查会在开始监听前退出。若配置有效，仍需服务进程启动诊断才能定位卡点。[OpenSSH 配置测试和监听顺序](https://github.com/PowerShell/openssh-portable/blob/b8c08ef9da9450a94a9c5ef717d96a7bd83f3332/sshd.c#L1720-L1806)

新机 `sshd -T -e` 返回 0，有效配置为 `port 22`、`addressfamily any`、`0.0.0.0:22` 和 `[::]:22`、`syslogfacility AUTH`。没有返回现有 `sshd.log` 内容。0.1.6 对 Running 的共享 `sshd` 直接检查端口，重跑安装器不会重启 PID 3432。下一步在测试机单独重启该服务一次，比较新 PID 与监听归属。若新 PID 开始监听，可用原包复试安装。若再次出现 Running 但无监听，仍需采集实际服务启动日志。重启结果待现场回传。

新机执行 `Restart-Service -Name sshd`，等待 8 秒后服务为 Running，PID 已从 `3432` 变为 `9580`，退出码为 `0`，TCP 22 监听表仍为空。重启无法恢复，0.1.6 首装仍失败。下一次取证使用同一二进制的前台 `-ddd -e`，以独立配置仅尝试回环地址 `127.0.0.1:22`，并禁用登录。该检查可以区分二进制在前台也绑定失败与只在当前服务启动条件下失败。前台管理员和 Windows 服务的 LocalSystem 账户是两个运行条件，结果仍待现场回传。[Win32 OpenSSH 调试方法](https://github.com/PowerShell/Win32-OpenSSH/wiki/Troubleshooting-Steps)

用户回传前台日志。随包二进制成功读取本机主机密钥并报告 `Server listening on 127.0.0.1 port 22.`。`lookup_sid() failed: 1332` 出现在成功监听之前，不能据此认定监听失败原因。这个测试证明二进制、端口和回环地址在管理员前台与独立配置下可用，实际服务失败仍需以 LocalSystem、原配置和正常启动模式取证。

[服务启动取证脚本](../../outputs/ssh-ready-retest/Reach-SSH-Startup-Trace.ps1) 只匹配现场确认的随包 `sshd`，临时用 `-E` 和 `LogLevel=DEBUG3` 输出启动日志，采样进程与监听后恢复启动命令并重启回原模式。Windows PowerShell 5.1 模拟验证覆盖采样成功、首次重启失败后恢复及拒绝其他 SSH 服务路径。脚本尚未在新机运行。真实服务日志、原因和修复均待核对。

新机运行第一版取证脚本。Windows 在第一条 `Restart-Service` 处返回 `CouldNotStopService`，原启动命令随后恢复，日志文件未生成。带日志参数的新进程没有启动。该结果说明此次采样失败，仍没有实际启动日志。

[第二版服务取证脚本](../../outputs/ssh-ready-retest/Reach-SSH-Startup-Trace-v2.ps1) 先打印 Windows 停服返回码，等服务 Stopped 且原进程退出后才加日志参数。停止已受理但卡住时，用户可以确认结束同一个无 TCP 套接字、无子进程的随包 `sshd`。脚本再次核对 PID、启动时间和服务身份，最后回读恢复后的启动命令和运行状态。Windows PowerShell 5.1 模拟验证通过 8 项，包括停服正常、确认与取消、子进程或 TCP 拦截、PID 复用、权限拒绝及诊断启动失败后的恢复。独立复核通过，真实停启和日志仍待新机复试。[模拟结果](../../outputs/ssh-ready-retest/startup-trace-v2-fixture.txt)

新机第二版取证返回 `StopService(WMI)=8`，服务仍为 Running、PID `9112`，启动命令为原随包 `sshd.exe`，没有生成启动日志。WMI 8 是通用错误，无法由它判定 Windows 服务控制管理器拒绝的原因。[Win32_Service.StopService 返回值](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/stopservice-method-in-class-win32-service#return-value)

[第三版取证脚本](../../outputs/ssh-ready-retest/Reach-SSH-Startup-Trace-v3.ps1) 改用系统 `sc.exe` 发送停止请求和显示 Win32 返回码。拒绝访问、存在运行中的依赖服务或未知错误会报告原始码。可接受的控制拒绝或超时仍需核对服务和进程，再由现场用户确认是否结束 PID。Windows PowerShell 5.1 模拟验证通过 12 项，另用系统 `sc.exe` 查询不存在的服务验证 PowerShell 能收到完整的原生返回码 1060。新机原生码及带日志服务的启动结果待取证。[模拟结果](../../outputs/ssh-ready-retest/startup-trace-v3-fixture.txt)

第三版在新机返回 `[SC] ControlService` 错误 `109`，表示控制管道已结束。最终 `sshd` 处于 Running，PID `15736`，与前一轮的 `9112` 不同，原启动命令保留。没有带日志的启动。两次采样的 PID 不同，尚无法只从返回码判断第三版停服时哪个进程先退出，或是否随后又被启动。[Win32 109 定义](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--0-499-)

[第四版取证脚本](../../outputs/ssh-ready-retest/Reach-SSH-Startup-Trace-v4.ps1) 在 109 后等 SCM 报告 Stopped，并确认旧进程退出后才启动日志取证。停服未证实就回显旧、当前 PID 与状态，该分支无强制终止。Windows PowerShell 5.1 的 19 项模拟覆盖控制管道关闭后停止成功、旧进程仍在、PID 更换、SCM 先报 Stopped、恢复期两种结果及既有故障分支。第四版待现场运行。[模拟结果](../../outputs/ssh-ready-retest/startup-trace-v4-fixture.txt)

### 新机 LocalSystem 拒绝主机私钥

新机执行第四版。两次 `ControlService` 都返回 109，但各次原进程确实退出，取证脚本完成了带日志启动和原启动命令恢复。诊断进程 PID 为 `14456`，恢复后的 PID 为 `21076`。LocalSystem 日志逐一报告三个默认主机私钥 `Bad owner` 和 `bad permissions`，全部拒载，最终 `sshd: no hostkeys available -- exiting.`。先前管理员前台和 `sshd -T` 通过，覆盖的是交互用户的密钥访问。

0.1.7 在随包 OpenSSH 的首次生成之后和旧版半装重试时检查默认主机私钥。所有者不可信或权限不合规时，应用 `BUILTIN\Administrators` 所有者和仅允许 Administrators、SYSTEM 的受保护 ACL，保留私钥原字节。已正常监听的服务继续运行。对默认配置的随包服务，连续等待后仍无主动连接、监听或子进程时，尝试正常停止，核实原进程退出后重新启动。外部 OpenSSH、自定义配置及其他 SSH 文件继续沿用原安装处理。[随包 OpenSSH 权限工具说明](https://github.com/PowerShell/Win32-OpenSSH/wiki/OpenSSH-utility-scripts-to-fix-file-permissions)

[0.1.7 Windows x64 本地重试包](../../outputs/ssh-hostkey-retest/Reach-Node-Setup-0.1.7-preview-0f474fa011b415ae.exe) 的 SHA-256 为 `0f474fa011b415aed48be023fd38cdfa65e4c1a8838044e9c9f4a784771f4f55`。Windows PowerShell 5.1 回归覆盖默认私钥 ACL 修复调用、私钥字节保留、旧服务复用、半装恢复和真实 `sshd -T`。另核对了安装器构造的实际安全描述符，SCM 和 `Set-Acl` 的平台副作用使用适配器。双击、真实改 Owner、LocalSystem 监听、地址弹窗和配对上线待新机复试。[SSH 回归](../../outputs/ssh-hostkey-retest/windows-ssh-preparation.test.ps1.txt) · [ACL 描述符](../../outputs/ssh-hostkey-retest/host-key-acl-descriptor.txt) · [交付包检查](../../outputs/ssh-hostkey-retest/inspect-delivery-0.1.7.txt)

安装编排首次运行遇到 `File.Replace` 无法移除被替换文件。在新夹具状态复跑通过 24 项，未修改维护事务。独立复核确认修复范围，当前验证未覆盖其他管理员生成且限制访问的主机私钥在新机改 Owner 的权限行为。[首次编排输出](../../outputs/ssh-hostkey-retest/windows-install-catalog.test.ps1.txt) · [编排复测](../../outputs/ssh-hostkey-retest/windows-install-catalog.retest.txt)

现场复核确认 Reach 的常驻协议有独立的 Agent 委派与 Starferry SSH 路径。用户最终选择必装 Worker 和 Agent，OpenSSH 随包按需启用。旧 Starferry 的 `192.168.3.199` 是跳板场景的可选下游目标。直接运行于被控机的 Worker 连接安装后填写的 Reach 服务端。[Starferry 跳板与本机目标](../starferry-reach-workflows.md)

## 0.1.8 Worker 和 Agent 首装预览

本地 x64 预览包供此前因 SSH 首装失败的新测试机复试。包内有 Worker、Morrow Agent 和固定的离线 OpenSSH。安装事务先注册并启动 `RYReach`，完成后弹出服务端地址输入框。由管理员或已配对且具备维护权限的 Agent 执行 `ryreach ssh enable`，才调用随包 SSH 准备流程。执行后可读取 `%ProgramFiles%\RY\Reach\last-ssh-preparation.json`，以实际状态和错误为准。

- Setup SHA-256 为 `eab89de14407e534f2c58435389c7fa5ad2cbdbe829caf2fc1a673b8b5c59cf7`，清单内的 Worker、Agent 和离线 OpenSSH 字节已核对。Setup 的 Windows PowerShell 5.1 内嵌验证通过 5 项。[安装包](../../outputs/agent-first/Reach-Setup-0.1.8-preview-eab89de14407e534.exe) · [包清单](../../outputs/agent-first/package-0.1.8.json) · [Setup 检查](../../outputs/agent-first/verify-payload-0.1.8.txt)
- RAYWORK 在前台运行解包出的 Worker 和相对路径 Agent。测试前后均无 `sshd` 服务与 TCP 22 监听。本机 Reach 测试服务完成配对，实际 Agent 写入一次测试文件，测试服务重启后按原操作 ID 查询仍为成功。模型请求使用受控本机响应。单次集成运行通过 6 项。[运行结果](../../outputs/agent-first/packaged-agent-0.1.8.txt) · [SSH 状态](../../outputs/agent-first/runtime-ssh-after.json)
- 独立复核核对了冻结输入、首装和按需启用路径。安装编排全量运行两次分别出现既有 `File.Replace` 文件替换错误，相关用例单独复跑通过。新机双击、UAC、LocalSystem 服务、正式配对和经 Agent 启用 SSH 待真机验收。预览包未签名、未发布，完整包的 Git 自动更新待实现并单独验收。

## 2026-11-27 RyDev 升级和 Ray Controller 登录复验

- 在 CAN00 上核对安装器 SHA-256 后运行 0.1.8 `--silent`，退出码为 1。安装事务记录为 `rolled_back`，目标为 0.1.8，原 0.1.2 收据仍有效，`RYReach` 和 `sshd` 均在运行。RyDev 仍绑定旧回环地址。检查时两端 43143 都未监听，测试 CA 已过期。0.1.2 的维护停止要求先向原服务确认无待结算操作。旧服务账本只有一条该设备的 `acknowledged`、`succeeded` 操作。安装器本次只保留退出码和事务状态，具体错误文本未取得。
- Ray 上的 Reach 发行版为 `20261127-a0d6bd039365`。公开健康路由返回 200，Controller 首次登录的 `POST /reach/api/v1/auth/pin` 和 `POST /reach/api/v1/auth/login` 均在 Ray 入口返回 401。Ray 入口二进制 `15ce10c…00d3f` 的路由要求原生 API 请求已有 Bearer，而官方 Controller 两种首次登录请求均无 Bearer。已登录的 Ray 网页仍能进入设备列表。RyDev 配对、Agent 能力、派单和原始回执仍待验证。

- 核对旧账本后，以 0.1.2 的 `config set server-url` 切换到 Ray，再用一次性码配对。Ray 节点 `716322c7-de35-4a4a-8c7d-d28b6087870a`，epoch 1。重试 0.1.8 后安装事务 `committed`，LocalSystem PID 6648 持续连接，安装 ID 和当前配对保留。实际 Worker SHA-256 `d30f4dfe…3dad`，Morrow `23349e02…7fc7`，均与预览包匹配。Ray 心跳已记录 `agent.delegate`，现场 Agent 模型在运行。
- Reach 先上线私有 PIN 和 Ray 固定账户绑定检查，发行目录 `20261127-native-controller-pin-f877d3e8`，升级前后 Reach 和 Desk 的账本计数一致。随后仅重启 `ray-front`，运行二进制 SHA-256 `82072b62…388c`。Reach 62 项测试、RayWorkbench `scripts/check.ps1` 和独立鉴权复核通过。公网原生 PIN 登录已到达 Reach，在私有 PIN 尚未设置时返回 `403 private_pin_required`。浏览器登录、匿名 API 拒绝以及跨站 PIN 拒绝的入口状态通过核对。完成私有 PIN 初始化后，仍需从 Codex 获取原生会话，派单并读取原始回执。
- Ray 模式原先隐藏 PIN 表单。发行 `20261127-native-controller-pin-settings-c38fd34b` 只增加「设置 → 账户与设备」的 Controller PIN 操作并沿用已有表单和 CSRF 校验，更新前后两套账本计数一致。公网浏览器以原 Ray 账户打开表单。服务器实际 `admin.js` 与制品 SHA-256 `b54d618f…7957` 一致。私有 PIN 由用户亲自设置。
- 用户完成本机 Controller 登录后，Codex 从原生 CLI 单次提交 `agent.delegate`，请求 `91f92818-b2f8-4523-b346-a741e26a542b`。RyDev 准确返回 `REACH-RYDEV-E2862148CFFB`，1 个 Run、1 次完成的实际模型请求、0 个子操作，测试目录仍为空。投递为 `acknowledged`，执行为 `succeeded`。从服务记录接单到终态为 1.953 秒。原生结果为 `Verified`，执行锁已释放，业务任务状态仍为 `awaiting_review`。[原操作和回执](https://bigrayzhang.cn/reach/#/operations/a5bc46d5-610b-4ba5-a5ae-1f20408f262f)
- Ray 的 `operation_events` 与 RyDev 的本地 outbox 共 14 条原始事件。逐条核对序号、事件 ID、类型和 `data` 原字节 SHA-256，全部一致，RyDev 全部收到 ACK。终态事件 `a4a74f90-9197-4204-b7c5-7f70c28759bc` 的原数据 SHA-256 为 `2d5e03fdedf0c028e9eee0c51081fe2ba32bb845396c2f283a7e84be16340f45`。原生结算记录显示侧车正常退出，Windows Job 已空。

<a id="rydev-019-preview-20261127"></a>
## 2026-11-27 RyDev 0.1.9 预览版升级

从提交 `46691c5` 的原始字节构建 Worker 和 Morrow Agent，后续到 `87af0a7` 的差异仅为许可文件 Git 属性。安装器 SHA-256 为 `41fc956066c8dff4b385649ecf9e8c00ac716afe11b9cac54e074be9c2f4cea5`；内嵌 Worker 为 `ef0b03dd2ac7718cd34bad4cd841ab8d46d113957f76378666c8ada85fd77077`，Agent 为 `6151f157e7ce12a3fed5a60c6ca30c2e8c4bc89df9cab98c8e764f28a0663d19`。依赖审计和安装器内嵌载荷校验通过，解包后的真实进程及错误路径回归 6 项通过。

RyDev 使用 `--silent` 从 0.1.8 升级，安装事务为 `committed`、验证通过，原安装 ID、Ray 节点和 epoch 1 保留。服务和既有 SSH 保持运行，实际 Worker 与 Agent 摘要匹配。Codex 新提交的操作 `05524317-b916-4dbe-81db-a8fb3a3a8763` 为 `acknowledged/succeeded`，真实模型调用返回 HTTP 200，输出与指定标记一致。Ray 与 RyDev 的 13 条事件在序号、事件 ID、类型和原始数据摘要上逐条一致，全部 ACK；原生结算为 `Verified/Settled`，业务任务仍为 `awaiting_review`。

首次打包因离线缓存缺少锁定依赖失败；补齐后第三方许可原文因 Windows Git 归档换行转换导致摘要不符。已用 Git 属性保持原始字节，默认归档六份原文的摘要均通过。QBuild 本次因远端沙箱权限错误未进入编译，本机使用固定源码和锁文件完成 Windows 构建。完整包的自动更新和双源发行附件仍待实现或核验。
