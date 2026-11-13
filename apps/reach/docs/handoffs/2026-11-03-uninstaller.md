# 卸载机制接续

作者：Ray Zhang（Ray）。日期：2026-11-03。

继续原完整首版及 Ray 部署目标，未暂停、未完成。ARA 分支 dev，大量 WIP 全部保留；本轮无提交、推送、安装或部署。图标已完成且接入此前完整候选，用户尚未报告实际 UAC 安装结果，不重复请求同一次操作。cwd Lumen 规则不适用于 ARA。

上一完整包及运行时固定点见 [完整候选交接](2026-11-03-complete-installer.md)。候选仍为 `outputs/windows-complete-b09eac1c3c349acd/Reach-Setup-0.1.0-preview-fe1506344bd265a1.exe`；此次新增模块尚未接入该 EXE。不能把上一份 374 项清单继续当新源码证明。

本轮新增 `packaging/windows/uninstall-files.ps1`、`uninstall-transaction.ps1` 和两份同名 Windows 测试。准确范围、源摘要、原始反例及最终 16/40 项输出见 [机制证据](../evidence/uninstaller-mechanisms-20261103.md)。全部在系统 Windows PowerShell 5.1 执行；只真实修改隔离目录/HKCU，生产 SCM/ACL、原子写、UAC、机器 PATH 均未验证。没有 Cargo 或测试进程仍在运行。

复核继续复用 `/root/reach_plan_review`。已修复该代理确认的根/保留目录漏检、伪造空目录归属和 PATH 字符串布尔问题；写前失败和内存假 committed 也已处理。[最终复核](../evidence/uninstaller-mechanism-review-20261103.md) SHA `df5dd625cd31e4627cde4fad58460a3bf3ccf77578cd1b2be149a69358634c49` 已由主代理完整回读并核摘要，只接受固定两个机制模块；复核者独立执行16项，读取40项并另跑写前故障探针，没有重复整组40项。代理当前空闲，下步生产装配仍复用它。

采用的简化设计：根目录和旧 install.lock 永久保留，root/install-journal.json schema3 是唯一事务权威且是旧版屏障，不另写外部 journal。外部锁仍为 `%ProgramData%/RY/Reach.installation.lock`；获取顺序 external→legacy。系统应用列表由系统 PowerShell 在 UAC 后读取受保护的 `%ProgramData%/RY/Reach.maintenance/uninstall.ps1`；下载 Setup 提供同源 `--uninstall`，不新造 uninstall.exe。参考 [设计报告](../evidence/uninstaller-design-review-20261103.md)。

紧接工作是生产装配，而非重复机制测试：

1. catalog 和 deploymentGeneration 持久化；每次成功新部署有独立代次，同包重装也不同，Node installationId/SID 保留。删除计划必须绑定受保护 catalog、canonical 保留集合和原安装记录摘要，不能仅凭 root 或目录名认领。
2. 补真正 host 函数，复用既有可信路径、SCM 和进程句柄规则；卸载使用 SCM stop，不能要求升级专用 maintenance-stop 的在线/空 outbox 门槛。DeleteService 成功还要等待真正不存在。
3. 安装器加入两锁、schema3 恢复/重装分派、外部脚本和64位 Uninstall 注册的事务发布/回滚；再接 Setup 参数和系统PS bootstrap。原 `install.ps1` 尚未改，仍拒绝 schema3。
4. 对装配后的源/候选做新测试与独立复核，再推进真实安装和全清单。保留原 outbox/unknown/账本/桌面 spool，未知文件/同名第三方服务/歧义 PATH 不能顺带删除。

之后还有全文 artifact、真实 Codex MCP 看图、Lite/Harness 云端 Host、Reach Desk 装配及 Ray 最终部署。0/52、0/5 不变。一次一个 Cargo；工具/缓存 E:/usr，中间产物 work，交付 outputs。humanizer 本机未找到，文档人工审读，不声称调用。没有相关 memory 用于项目结论。
