# Reach 生产桌面接线候选交接

作者：Ray Zhang（Ray）。日期：2026-11-02。

本轮将Node桌面连接切到双向认证管道，保留直接helper开发stdin与内部worker私有stdin。WTS唯一登录选择、暂停进程入Job、生产SCM身份、受保护同版本配置及独立spool已写入候选。普通用户真实管道链路已跑通，生产SYSTEM/安装仍未验收。详见[证据](../evidence/desktop-pipe-20261102.md)及[固定manifest](../evidence/desktop-pipe-20261102.json)。未提交、推送或部署，原WIP均保留。

下一步完成可搬运嵌入式Python运行时和全组件安装包，生产包必须含相对路径desktop-runtime.json，并符合当前受保护目录及python314._pth合同。不要把开发venv复制成安装载荷。现有Node-only安装候选不含helper，仍需按完整package manifest摘要生成新版本目录和回滚记录。

实际SYSTEM安装后验证：普通绑定用户pair/status；唯一活动用户的截图/输入/点击；SCM查询权限；每代spool可写且ledger不可读；无登录/多会话；锁屏/UAC/RDP切换；SCM stop、Node crash及维护停止后的全树退出、原账本和补传。不能用ordinary host替代这些证据。原UAC回复仍待用户，不代点、不重复问。

当前开发路径仍为 `E:\usr\var\cache\rust-target\reach-node\debug\reach.exe` 与 `E:\usr\var\cache\rust-target\reach-desktop\debug\reach-desktop.exe`，运行时继续固定reach.3。最新源码与binary哈希按新manifest读取，上一轮manifest是历史版本。一次只跑一个Cargo；源码冻结后才跑最终原生组，避免重复大回归。

全清单保持active。完整文本artifact、实际Codex MCP加载/模型看图、Reach Desk云端Host及Ray新版仍待接续；LabSlot延期、Reach Desk默认不集成和在Reach内部维护的约束不变。最终独立代理 `/root/reach_plan_review` 核对618/618项及最终PNG/效果，接受普通用户认证管道增量；35/35原生、Node Rust7/7及helper4/4通过。主代理独立核对同一618项。生产WTS/ACL/SCM/安装未验收；当前无测试进程。
