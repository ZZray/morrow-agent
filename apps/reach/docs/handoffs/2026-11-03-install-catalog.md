# 安装器归属与原子写接续

作者：Ray Zhang（Ray）。日期：2026-11-03。

活跃目标仍是完整任务清单及 Ray 部署，未完成或暂停。上一轮卸载机制、本轮实际安装接线都属于具体进展，不是阻塞。分支 dev，大量 WIP 保留，无提交/推送/生产安装/线上修改；cwd Lumen 约定不适用于 ARA。

本轮结果与边界见 [证据](../evidence/install-catalog-20261103.md)。新候选是 `outputs/windows-complete-716a23ad70230a1c-ef23a1806457/Reach-Setup-0.1.0-preview-08a3b066680d4803.exe`，SHA `08a3b066680d4803ab45bfd9dedfa40e57a8d04d89f25ae803a4b74859cd2c4b`。实际内嵌 6,327 文件校验通过，10 档图标匹配。包仍缺生产卸载入口，未签名、未安装。最新只读 SCM 查询 RYReach absent。用户未报告 UAC 安装结果，不重复请求同一次操作。

已接入：`ownership.ps1` 的 deployment.json 当前身份/归属、阶段登记、同包新代次/回滚保留归属；`maintenance-writes.ps1` 的锁内临时文件意图及真实原子写；实际 install.ps1 和 Setup include/inspect、build-complete 的来源摘要。新安装 journal 为 schema4/operation install，旧版拒绝，旧schema1/2仍可恢复/导入；卸载 schema3 尚未由安装器分派。普通安装记录仍schema1/2，不能与journal或账本schema混淆。

关键新发现已修：WinPS5 File.Replace 的 `$null` 会转空字符串，必须 `[NullString]::Value`；Node-only 也必须随机 stage，避免半个正式版本；直接 stage 写不再增加旧临时名37字符余量。失败日志保留。原子写意图先完整 Flush 才 CreateNew；恢复只删精确登记路径，全部临时文件确认无后在持锁状态清空日志，既不猜旧.new-GUID也不累积安装寿命配额。

实际检查：22旧事务、4stage、10原子写、12catalog（8+2+1+1分次）及setup fmt/clippy/test1/deny。旧源码与最终安装器仅路径守卫差异有可重算摘要桥；完整说明见证据。SCM/Node/生产ACL适配，不能说真实系统安装。全部构建/测试已取得退出结果，无在跑 Cargo。一次一个 Cargo。

固定来源：`work/install-catalog-snapshot-0a291496a0be4879a7a1a704b035a3d3`；29项清单 SHA `091fb4b723461f6c15fb4977d306c52ab0324a9843da1cc3dbbd50d2fc0f472a`。上一 fe15 EXE 和所有失败快照保留。[独立最终报告](../evidence/install-catalog-review-20261103.md) SHA `3defb85c61d734566c395037b0ac0563504a4e79c008d6d3380edb625f08dca9` 已完整回读并核摘要；主代理另复核29项全部一致。复核者还重算版本桥并实际inspect新候选，限定范围通过。代理当前空闲，后续仍复用 `/root/reach_plan_review`。

下一步直接完成卸载生产装配：

1. 从当前 deployment.json 及 catalog 建立 programPlan，绑定根目录、SID/installationId、generation、原安装记录摘要、精确服务路径与保留集合。已评审的卸载状态机仍只依赖 host 函数，不能只用测试的三字段比较。
2. 复用实际可信目录、原子写和 external→legacy 两锁；实现真实 SCM disabled/stop/原进程等待/DeleteService/确认1060。当前旧 `ReachSetupNative.Remove()` 会吞 OpenService失败，生产卸载不能直接照用。卸载不用要求在线/空outbox的 maintenance-stop。
3. 安装/回滚 `%ProgramData%/RY/Reach.maintenance/uninstall.ps1` 和自有64位 Uninstall注册；UAC之后完整ReadAllText加载脚本，保留锁/元数据根，不引入独立uninstall.exe自删除问题。
4. 接入 Setup `--uninstall` 与新安装器 schema3恢复/可信tombstone重装，新代次与旧SID/installationId保留同时成立。注册存在时脚本必须完整；注册移除后用下载Setup或新安装器恢复。
5. 新装配源码/制品独立审查和真实环境测试后，继续全文artifact、真实Codex MCP看图、Lite/Harness云端Host、Reach Desk接线及Ray最终部署。0/52、0/5不变。

工具/缓存 E:/usr，中间产物 work，交付 outputs。humanizer 本机缺失，文档人工审读。未使用相关 memory 作项目结论。
