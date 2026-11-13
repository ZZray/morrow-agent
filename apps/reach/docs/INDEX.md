# 技术文档索引

作者：Ray Zhang（Ray）。

当前阶段：Reach 已于 2026-11-13 迁入 Morrow Agent 的 `apps/reach/`，见[最新交接](handoffs/2026-11-13-morrow-subproject.md)。服务、Node、CLI/MCP 与可选 Desk 仍在本地实施；Ray 443 与统一登录仅有此前上线证据，当前不访问服务器或部署。基础验收仍为 0/52、Desk 为 0/5；旧 ARA 版本的证据不代表 Morrow 版本验收，LabSlot 仍延期。

## 已有文档

| 文档 | 内容 | 状态 |
|---|---|---|
| [会话交接](handoffs/2026-11-02-ara-subproject.md) | 迁入 ARA、当前状态、验证与新会话入口 | 2026-11-02 |
| [项目计划](project-plan.md) | 目标、组件、阶段、依赖、里程碑和文档流程 | 实施中；已纳入独立工作台应用修正 |
| [任务清单](task-checklist.md) | 52 项基础任务及 5 项可选扩展任务 | 唯一任务状态来源；分别 0/52、0/5 |
| [计划 HTML 阅读版](plans/project-plan-20261101/index.html) | 目标、里程碑与全部任务 | 2026-11-01 阅读快照 |
| [产品范围](product-scope.md) | 已确认的产品行为、架构建议与待决事项 | 用户方向已记录；技术细节待讨论 |
| [文档设计](document-design.md) | 文档职责、目录、专项推进顺序与验证流程 | 实施中的文档约定 |
| [知识库索引](knowledge/INDEX.md) | 项目决定与耐久经验的入口 | 已建立 |
| [产品决定及来源](knowledge/product-decisions.md) | 用户要求、修正与生效范围 | 已记录来源；不表示功能已实现 |
| [源码目录说明](../src/README.md) | 组件与源码归属 | 服务、Node、控制器已开始实现 |
| [首版架构](architecture.md) | 组件、数据归属、Windows 会话与部署 | 前台 Node 与 Ray 部署已有证据；完整架构仍在实施 |
| [身份与配对](identity-pairing.md) | 独立账户、幂等配对、再次配对与解绑 | 前台 Node 已验证；安装版 IPC 待完成，LabSlot 延期 |
| [工具与收据](tools-tasks.md) | 协议来源、投递/执行状态与结果上传 | v1 实施中 |
| [复用调查](reuse-map.md) | Lite/Harness/桌面后端的固定来源与缺口 | D02/D06 进行中 |
| [服务基础证据](evidence/service-foundation-20261102.md) | HTTP/SQLite、普通进程重启及验证边界 | 9 项测试通过，独立源码复审通过 |
| [Node/控制器证据](evidence/node-controller-20261102.md) | 真实 Windows 进程、文件、取消/恢复、CLI/MCP、分页及依赖审计 | UI 前固定快照 22 项 TS + 1 项 Rust 通过；基础范围独立复核接受 |
| [最新实现交接](handoffs/2026-11-04-source-library-local.md) | 设备范围资料、真实跨Task验证/复用、普通完结证明及故障收尾 | 本地限定点独立复核通过；完整R05仍开放 |
| [任务资料、候选与复用](source-library.md) | 唯一资料版本/作用域/验证/审核/撤销合同及schema11证据等级 | 本地实现；不自动导入Core候选 |
| [资料闭环本地证据](evidence/source-library-20261104.md) | 新Session跨Task实文件、重启、14坏证明拒绝、真实旧服务与旧库迁移 | 本地受控流程；无真实组织模型/安装/部署 |
| [能力说明传递证据](evidence/agent-guidance-20261104.md) | 来源原文进入模型、真实文件效果、缺能力拒绝与旧工具定义恢复 | 受控loopback；无远端模型或部署 |
| [Agent完整包本地证据](evidence/agent-package-20261104.md) | 四workspace审计、6329文件、包内侧车/坏目录拒绝及旧包升级归属 | 本地包外实跑通过；SCM/UAC及干净机未验收 |
| [只读收尾本地证据](evidence/agent-native-finalize-20261104.md) | 真实 Node 强杀、inspector 中断、ACK 丢失、gen2 source 与实际旧库迁移 | schema10 候选；不代替完整故障矩阵 |
| [typed图片恢复本地证据](evidence/agent-typed-resume-20261105.md) | 原图字节回执、Core Session恢复、JSONL严格合同和失败图拒绝 | Core/JSONL单测通过；真实截图强杀恢复仍开放 |
| [原生续跑本地证据](evidence/agent-native-resume-20261104.md) | 实际强杀恢复、不重复效果、原预算、ACK 丢失及服务重启 | schema9 分项；NoFence finalization、typed 开放图恢复与完整矩阵仍开放 |
| [原生恢复前置证据](evidence/agent-native-preflight-20261104.md) | 非幂等效果一次、原Session七文件不变、I/O错误与原端口拒绝 | actual Node分项；没有resume/activation，不清pending |
| [恢复准备本地证据](evidence/agent-executions-20261104.md) | 同Task新execution、取消/迁移/历史、实际gen1 Node回归 | 服务准备分项；没有Node恢复能力、原生admission或Task接管 |
| [模型owner本地证据](evidence/agent-model-owner-20261104.md) | 实际join、同锁退出、CLI/MCP回执、硬杀及晚写拒绝 | 本地分项通过；停止不清unknown、不退款、不授权Task接管 |
| [保守消费本地证据](evidence/agent-consumption-20261104.md) | 实际预占与charge floor分开、Run槽不退款、原子迁移与旧库零余额槽 | 服务13函数及原生正常路径回归；消费输入为synthetic，非实际崩溃恢复 |
| [闭合预算本地证据](evidence/agent-budget-20261104.md) | 固定 runCallLimit、snapshot 二选一、图片回调、取消/篡改及迁移 | 实际 Node 与受控端点分层验证；完整 R01–R07 未验收 |
| [同Task跨Run实图](evidence/agent-cross-run-images-20261104.md) | 普通候选反馈后原 Session 的两轮截图及 typed 原图连续性 | 131072/32768 两组通过；旧镜像身份与预算点分开 |
| [Node多Run本地证据](evidence/agent-multirun-20261104.md) | CLI/MCP反馈→原Task/Session的下一Run、预算未完成与真实图片重核 | 5项真实Node及2项实图通过；完整R01–R07未验收 |
| [Node委托截图证据](evidence/agent-desktop-20261104.md) | 两个实际桌面窗口→原outbox→typed模型输入，四场景与原件核对 | 本地受控端点；无真实模型视觉理解；完整R01–R07未验收 |
| [普通Node委托证据](evidence/agent-node-20261104.md) | 真实Ledger/outbox、两文件、大结果、ACK、取消、断流、重启与预算 | 历史文件/命令分项；后续截图见新证据，完整R01–R07未验收 |
| [模型通道本地证据](evidence/agent-model-20261104.md) | 固定模型路由、原子预占、SSE/取消/背压/密钥回显及迁移 | 受控loopback；真实组织模型及完整Node Host仍未验收 |
| [Reach Desk 本地页面](evidence/desk-ui-20261103.md) | 同一次登录、发送/历史/停止、断流与旧响应、窄屏 | Chrome5/5与基础16/16；真实多轮/恢复/上线仍开放 |
| [Reach Desk Host 证据](evidence/desk-host-20261103.md) | 共享运行库、持久会话、真实事件流、取消与重启 | 受控流程通过；两次真实模型超时，未上线 |
| [Codex 图片证据](evidence/codex-vision-20261103.md) | 真实 MCP 加载、原 PNG 随机码/图形识别及失败成本 | 局部消费链通过；完整 C07/T06/R07 仍开放 |
| [长错误证据](evidence/error-artifacts-20261103.md) | 调用身份、失败/未知状态、重启取回与大型错误元数据修补 | 最终6组桌面链路通过；完整T06仍开放 |
| [文件产物证据](evidence/file-artifacts-20261103.md) | 实际文件捕获、删除源文件后的恢复、改写/替换及部分入账故障 | 局部链路通过；完整T01/T06仍开放 |
| [原始全文与管理页](evidence/text-artifacts-20261103.md) | 丢失确认/双重启正文取回、真实浏览器下载及新候选 | 局部链路通过；完整T06与真实安装仍开放 |
| [维护接线证据](evidence/maintenance-integration-20261103.md) | 22组实际主流程、HKCU注册与83a2完整候选 | 候选已装配；真实UAC/SCM安装、卸载仍未验收 |
| [安装归属接入](evidence/install-catalog-20261103.md) | 12 组安装主流程、10 组原子写及新08a3完整候选 | 已接入安装脚本；生产安装/卸载未验收 |
| [卸载机制证据](evidence/uninstaller-mechanisms-20261103.md) | 16 项文件/PATH、40 项隔离恢复测试及独立反例修复 | 机制已执行；生产卸载入口未接入 |
| [完整载荷与桌面修复](evidence/full-installer-runtime-20261103.md) | 6,327 文件实际内嵌校验、16/22/4 机制证据与原生桌面六项 | 局部实现已复核；真实安装/卸载仍开放 |
| [完整候选最终复核](evidence/full-installer-final-review-20261103.md) | 374 项实际摘要、fe15 EXE 内嵌 ZIP 及准确接受范围 | 本执行点通过；完整清单不变 |
| [图标交付证据](evidence/brand-icon-20261102.md) | SVG、十档ICO、三个PE原字节资源核对与安装边界 | 品牌资源接入已复核；当时的输出失败保留 |
| [输出收尾修复](evidence/output-drain-20261102.md) | 背压原帧、32身份组合验证、103项清单与修复版安装候选 | 本执行点独立复核通过，完整T02/安装仍开放 |
| [便携运行时验证](evidence/portable-runtime-20261103.md) | 固定嵌入包、只读中文路径、COM恢复、真实桌面及每代临时目录 | 核心链路已复核；原生许可/完整安装/干净机仍开放 |
| [桌面管道候选](evidence/desktop-pipe-20261102.md) | 双向身份、启动gate、pipe关闭、独立spool及SYSTEM边界 | 普通用户管道已验证；生产权限/会话仍待实测 |
| [桌面链路证据](evidence/desktop-chain-20261102.md) | 真实远程输入点击、MCP原图、丢失ACK、服务/Node重启和独立复核 | 开发链路已验证；生产会话及完整清单仍开放 |
| [Node 安装候选交接](handoffs/2026-11-02-node-installer.md) | 维护停止、Node 安装候选与实际安装接续 | UAC/真实 SCM 仍待执行 |
| [桌面候选证据](evidence/desktop-host-20261102.md) | 固定运行时、真实桌面操作、失败状态和进程树结算 | D06/T05 的局部证据，未接完整远程链路 |
| [Windows 宿主证据](evidence/node-service-20261102.md) | 22 项普通进程回归、状态隔离和本机管道 | 普通 host 已验证；SCM/SYSTEM/安装未验收 |
| [安装与更新合同](installation-update.md) | 无引导安装、可信目录、停领、升级与卸载 | Node 候选已实现；完整包和生产安装未验收 |
| [安装候选证据](evidence/node-installer-20261102.md) | 维护停止、隔离事务、打包哈希及独立审查 | 普通进程与候选制品证据，真实 UAC/SCM 尚未执行 |
| [工作台及产品接入](integrations.md) | 443 路径、独立身份、Cookie 和可选产品合同 | 已按用户端口修正更新 |
| [Ray 部署与恢复](deployment-ray.md) | 首次安装、入口切换与账本保留 | 实际结果另记部署证据 |
| [443 入口证据](evidence/ray-path-20261102.md) | 端口迁移、真实跨机文件效果及原操作查询 | 已执行；保留历史发布快照 |
| [Ray 统一登录证据](evidence/ray-sso-20261102.md) | 单次登录、多标签会话、原生回归和最新部署 | 已上线；生产退出手工验证及故障回滚实测边界单列 |
| [Reach Desk 扩展](platform-extension.md) | 默认不集成、Ray 可选的云端直接对话及旧产品迁移 | 名称与归属确定；源码已迁入，接线及 X01–X05 验收未完成 |
| [原会话关闭候选](evidence/desk-close-20261103.md) | 旧 Task 结算、精确释放与同 Session 后续准入 | 共享机制历史证据；当前产品接线见Host本地结算 |
| [Desk 会话状态与恢复](evidence/desk-versioned-state-20261103.md) | Store v2、版本化阻挡和旧事件隔离 | 本地24组历史证据；不等于当时已有Host结算 |
| [Desk 原生状态检查](evidence/desk-inspect-20261103.md) | 全历史、context、候选/经验和原件指纹 | Core分项54函数历史证据；协议及Host分别验收 |
| [Desk 共享观察与关闭复核](evidence/desk-wire-20261103.md) | Harness锁、JSONL完整快照、SDK及关闭同锁复核 | 本地63函数及Node/Bun普通进程历史证据 |
| [Desk Host 本地结算](evidence/desk-host-settlement-20261103.md) | 固定侧车、完整效果核对、两次关闭与重启、停止后原会话续聊 | 本地受控流程通过；保留失败与复测，组织模型和上线未验证 |
| [Desk 设备工具本地接线](evidence/desk-devices-20261104.md) | 固定消息目标、真实 Node 文件/命令、原收据、UTF-8分页及A/B选择 | 本轮53不同函数有成功证据，保留首批失败与UI补丁版本；不是清单完成数，图片/现场委托未完成 |
| [Desk 原图输入本地分项](evidence/desk-images-20261104.md) | 公共typed PNG、原图校验、独立预算、摘要/停止/归档续聊 | 受控大图链通过；seeded账本与真实截图分开，完整X03/R07仍开放 |
| [Desk 真实截图与原图查看](evidence/desk-image-preview-20261104.md) | Node原图到模型请求与Chrome同字节、来源卡片、预览下载、取消与窄屏 | 本机实际截图链通过；无真实视觉模型理解，完整X03/R07仍开放 |
| [现场 Agent 委托合同](agent-delegation.md) | 原操作父子关系、模型relay、普通/预算复核、Run cap和恢复边界 | 普通Node及闭合预算已有本地分项；组织模型/完整恢复仍开放 |
| [委托服务与本地传输证据](evidence/agent-calls-20261104.md) | 创建/claim原子性、取消/对账、v2迁移、真实基本Node及传输回归 | 限定服务合同通过；seeded子PNG不等于实际委托截图 |
| [Reach Desk 迁入证据](evidence/platform-migration-20261102.md) | 源码归属、构建、状态隔离和本地品牌验证 | 已验证兼容迁入；扩展接线及上线未完成 |

## 尚未编写的专项文档

[安装升级合同](installation-update.md)已建立，真实安装和完整验收专项仍待完成；产品集成已有合同，登记接口与真实产品接入待实现。已写文件与已验收功能分别记录，不为尚不存在的文件建立链接。

当前已有开发版 reach.exe、控制器、独立管理页及真实跨机/浏览器测试，Ray 部署已完成本次入口和统一登录接线；安装包、桌面和模型委托仍待完成。

[独立管理页证据](evidence/admin-20261102.md)：后续 UI 快照 25/25 回归、实际配对/取消/分页及受控浏览器故障记录。
