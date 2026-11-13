# Windows 安装与卸载入口接线

作者：Ray Zhang（Ray）。日期：2026-11-03。

本执行点将 Windows“已安装的应用”入口、受保护恢复脚本、下载 Setup 的 `--uninstall` 和卸载后重装接入同一套维护代码。候选已构建；没有执行生产安装、真实 UAC、SCM、SYSTEM 或机器 PATH 写入。基础清单仍为 0/52，Reach Desk 0/5；线上没有变化。

## 候选与固定来源

- 文件：`outputs/windows-complete-716a23ad70230a1c-93fe5dccdd7f/Reach-Setup-0.1.0-preview-83a2a8e840a43c36.exe`。
- EXE SHA256：`83a2a8e840a43c36a3662d02d0c53a473825bf14cde73c79c5d6a9a9f82a491d`。
- Build source identity：`93fe5dccdd7fdee344180610faaae42a12154ef0d5f07f9279394df00e34b9bf`。
- 内嵌 ZIP 与上一 08a3 候选完全相同：`716a23ad70230a1c4619b83c49569f69257f49ba58e31c6eeb0c0cdf7a82ac63`；6,327 文件，190,316,383 展开字节。Node、helper 和便携运行时沿用此前固定点，本轮只更新维护代码。
- 安装时落地的共享恢复脚本 SHA256：`134bf3659e9d58e36d5771800f6b69fdb02abe2aabdfe41e416072dd784cb0f5`。脚本不包含载荷或自己的 Base64。
- [最终18项来源清单](maintenance-integration-inputs-20261103-r2.json) SHA256：`b374152a9048109cd33d4dc620950ed6a8df99fa899d81eff45bc9c6f2a26be9`。其中只有旧版屏障测试与新增历史夹具区别于[初始17项冻结](maintenance-integration-inputs-20261103.json)，生产代码相同。
- `installationTested=false`、`codeSigned=false`。主代理最终只读查询 `RYReach` 为 absent。

## 实现行为

`install.ps1` 是统一维护入口。卸载跳过安装载荷与调用者 SID 输入校验，仍检查现有可信路径、持有 external→legacy 两把锁并核对已安装部署身份。卸载不依赖在线维护 ACK：同一 SCM 句柄核服务类型、LocalSystem 与精确路径后禁用，停止并等原进程退出，删除后等待实际不存在。

Windows 64 位 Uninstall 的 `RY.Reach` 子键指向系统 PowerShell。启动代码按需 UAC，完整读取受保护脚本并核对摘要，再执行，因此卸载时可移除已加载的脚本。注册存在时必须有匹配的恢复脚本；下载同版本 Setup 可以修复匹配摘要的缺失脚本。下载 Setup 若放在待卸载程序树内会明确拒绝，避免自身锁住文件。

安装 journal 在注册发布前保存旧/新注册和脚本快照。先写脚本、后写注册；失败恢复旧脚本及注册，然后持久化 restored 再重启旧服务。部署记录保存 recovery 元数据。卸载计划同时绑定整个 catalog SHA、原安装记录 SHA、generation、SID、installationId、文件集合、保留集合与注册身份，拒绝陈旧入口或被改动的归属。

卸载终态使用 schema3 journal 和 tombstone，永久保留根目录及 install.lock。重装先持久化 schema4/prepared 接管记录，再置换 catalog 和写 stage；中断恢复保留新尝试已登记的残片。重装失败保留旧 tombstone、原 installationId/SID 和账本，成功获得新的 deploymentGeneration。

## 实际执行与限制

| 检查 | 结果与证据 | 边界 |
|---|---|---|
| 安装主流程及新卸载接线 | [22/22](maintenance-integration-final-r1.log) | 实际生产函数/主流程、文件、锁、原子写、隔离 HKCU；SCM、Node 和生产 ACL 为明确适配 |
| 旧安装事务及 C# 编译 | `work/maintenance-legacy-tests.log` 22/22 | 新 C# 确实编译；服务调用仍是适配 |
| 卸载文件与 PATH | [16/16](maintenance-windows-uninstall-files-final.log) | 真实隔离文件/HKCU |
| 卸载状态机与恢复 | [40/40](maintenance-windows-uninstall-transaction-final-r2.log) | 真实隔离文件/HKCU；SCM、ACL、原子写适配 |
| Setup | [Clippy](maintenance-setup-clippy-r1.log)、[2/2 单测](maintenance-setup-test-r1.log)，fmt 通过 | 实际系统 WinPS 5.1 私有传输及组合恢复脚本解析，不执行安装 |
| 完整 EXE | [构建及内嵌校验](maintenance-complete-build-r1.log) | 实际 EXE 经私有 stdin 校验全部载荷；构建时逐项核16个来源摘要 |
| 图标 | [10档原字节及属性](maintenance-setup-icons.json) | PowerShell 7 只读 PE 资源提取 |
| 独立 bootstrap 探针 | [4/4](maintenance-entry-bootstrap-review-r1.log) | 实际双层命令、中文/空格/单引号路径、自删除、退出码及坏摘要；UAC门和错误框替换 |
| 独立注册 ACL 探针 | [6/6](maintenance-registry-acl-review-r1.log) | 实际 HKLM64 父键只读及内存 ACL；无生产注册写入 |

本轮未改变依赖锁；不把此前依赖审计写成重新执行。独立源码/候选复核由 `/root/reach_plan_review` 完成，[报告](maintenance-integration-review-20261103.md)在冻结范围内无新增确认阻断；主代理已完整回读并回核关键摘要和结果。该结论不扩大为真实系统安装验收。

## 保留的失败与修正

首次真实 HKCU 发布暴露 Windows PowerShell 5.1 的 `Sort-Object name` 未按 Hashtable 的 name 键排序，导致相同注册值被误判不同；改为显式键脚本排序后通过。独立探针还发现共享系统父键的标准权限被误拒绝，以及原始 GENERIC_ALL/GENERIC_WRITE 未计入产品写权限；修正锚点与产品子键的检查范围，并要求产品 DACL 保护。

[第一次40组运行](maintenance-windows-uninstall-transaction-final.log)为39通过、最后一项失败：该项声称检查“旧安装器”，却提取了已支持卸载的新安装器。新增[历史函数夹具](../../tests/fixtures/windows-legacy-install-recovery.ps1)，从上一已固定的 f221fdc3 源逐字符提取，保持旧版拒绝 schema3 的真实断言；r2 40项通过。没有把失败改为跳过。

图标提取辅助脚本首次误用 WinPS 5.1，因辅助脚本依赖 `.NET SHA256.HashData` 失败；改用原要求的 PowerShell 7 后通过，产品源码未改。以上失败不影响已经固定的上一 08a3 候选，旧制品和来源快照均保留。
