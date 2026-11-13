# 完整安装载荷与桌面循环修复接续

作者：Ray Zhang（Ray）。日期：2026-11-03。

活跃目标仍是完整任务清单和 Ray 部署，52 基础项与 5 可选项均未整体验收。ARA 分支 dev，大量 WIP 保留；未提交、推送、安装或部署。cwd Lumen 的 TS-only/分支/推送规则不适用于这里。用户已批准独立 Reach、Ray 免二次登录和可选 Reach Desk；LabSlot 延期，旧 HandWave 不再维护。图标已完成、展示并接入，本轮不重复索要同一次 UAC。

最新范围、原始失败和全部摘要见 [完整载荷证据](../evidence/full-installer-runtime-20261103.md)。最新包：`outputs/windows-complete-b09eac1c3c349acd/Reach-Setup-0.1.0-preview-fe1506344bd265a1.exe`，SHA256 `fe1506344bd265a19fb490df1b42587d5dfe7920e198d2a39a4072c1dc59b238`。内嵌 Node 5029a53f、静态 helper 0ea7c0b2、`work/portable-runtime-r4/python`，运行时清单 SHA `6cecc584a2c8cb755c277bf8a0a6be4c08403898525d7ef41fb477083ef5af0a`。包完整，但独立卸载入口仍缺，真实安装未执行。旧 aff5/r2 含快照循环缺陷，不能替代修复候选。

本轮已完成的机制：完整 ZIP 及严格逐文件验证、schema2 全包版本目录、坏候选可恢复旧包、绑定 SID/installationId 兄弟元数据、PATH 添加归属继承；WinPS5 下 16 ZIP + 22 事务 + 4 目录 stage 通过。SCM/ACL 等适配范围有明确标记。setup fmt/clippy/test1/deny 通过；最终实际 70 MB 私有 stdin 和 6,327 文件校验通过，30 个 PE 图标帧匹配。

r2 实际 6 项中 Snapshot 失败。独立诊断证明上游 UIA provider 词范围每 606 步回退却报告成功，造成至少 62,000 次循环。reach.4 补丁以实际 Start 单调前进守卫抛专用异常，Snapshot 保留完整 value/控件并传播独立词坐标不完整标记。7 项机制测试、r4 原生6/6通过，两个实际快照都触发原问题分支并成功，中文输入和 clicks=1 有独立效果文件，11 个 generation 完整结算；主代理已查看 after.png。原测试、诊断失败与 r1d/r2/r3 均保留。

复核者继续复用 `/root/reach_plan_review`。三份报告：原生来源、完整安装实现、snapshot-word-range；最后一份最终 SHA `59ad874cfba65c7f928cc29289c638122b7dc5d883364d651a09e37a3491559d`。没有依据“测试通过”把完整首版标为完成。

最终 [独立包核验](../evidence/full-installer-final-review-20261103.md)另核了 374 项清单和 fe15 EXE 中真实内嵌 ZIP；报告 SHA `07b2f258b0e528bca1e81cb1f6c705587c096407b8f1554475f78edcc205b29e`。主代理已回读报告并核其摘要；只接受完整载荷与已执行的有限机制，不替代后续安装/卸载。

紧接工作：

1. 独立卸载入口及自身删除交接。`install.ps1` 当前只接受 install journal schema2；卸载需要独立 operation/阶段，不能复用旧安装恢复含义。锁文件/正在运行的卸载 exe 不能在持有时递归删。删除失败必须可恢复，不能吞掉报成功。
2. 默认保留 `%ProgramData%/RY/Reach`、兄弟 `Reach.installation.json` 和桌面 spool。SID 必须继承，账本不回滚；PATH 只按明确归属删除，schema1 歧义项保留。未知服务/额外文件不得顺带删除。参照已完成 [设计复核](../evidence/full-installer-design-review-20261103.md)。
3. 完成具体可检视候选后，再落实真实 UAC/SCM/SYSTEM/WTS、机器 PATH、配对、升级/卸载/重装和干净机；不要把普通用户适配当系统证据。首次真实安装尚无用户结果。
4. 继续全文 artifact、实际 Codex MCP 看图、Lite/Harness 云端 Host、Reach Desk 及 Ray 最终部署。Ray 最后只读核实仍为 `20261102-sso-stable-05d25e8c84eb`；本轮无线上变更，不原样复用绑定旧 SHA 的部署脚本。

一次一个 Cargo；工具/缓存 E:/usr，过程产物 work，交付 outputs。所有已启动构建/测试 session 已取到终态，无在跑 Cargo。静态 helper 源码本轮没有变，只更换包内后端。Python/VC 源和 notices 都固定可追溯；本机 VS 存在不等于所有组织许可资格已确认，正式外部分发仍需落实实际终端保护条件。humanizer 本机不存在，文档人工审读，不冒称运行技能。
