# 桌面认证管道与 WTS 启动候选

作者：Ray Zhang（Ray）。日期：2026-11-02。状态：普通用户认证管道已执行真实链路；生产 SYSTEM/WTS 候选已实现，实际安装权限和会话变化未验收。

## 这次改动

Node 不再通过开发 stdin 连接桌面助手，改为随机、单实例、拒绝远程的命名管道。SYSTEM 和目标 logon SID 获得不同访问范围；目标登录只能交换数据，不能创建同名实例。Node 先持有进程和 Job，再验证管道客户端 PID、Session ID、token 用户/logon 身份，最后发送启动 gate。对外的管道属于 supervisor；ready 中的 worker PID 不用于外部认证。

开发 helper 检查实际服务端 PID 与父进程同一用户/logon；生产 helper 检查 SCM 中 RYReach 为运行中的 LocalSystem 独立进程，SCM PID、启动参数和实际管道服务端 PID一致，并在运行时持续核对。两种方式显式区分，生产认证失败不降级。打开管道使用 identification-only SQOS。

双向 pipe 的 writer drop 不等于 stdin EOF。Node 先尝试有界 stop，释放 writer、终止并等待 reader，确认整个连接关闭后再等待所持 Job/进程。原图片账本、补传和不重放合同保持不变。直接运行 helper 的开发 stdin 入口仍保留，私有 worker stdin 也保留，不能把它们当生产认证入口。

生产 Node 仅从受保护的同版本目录读取 desktop-runtime.json，不采纳 REACH_DESKTOP_CONFIG。候选检查 Owner/DACL、祖先及 reparse；路径须相对并留在包内。Python 要求嵌入式 3.14 的隔离 `_pth`，拒绝 venv 和 import site。WTS 按服务配置的绑定 SID 选择唯一活动 logon，暂停创建用户进程，入 Job 后恢复；失败时明确终止并等待 suspended 进程，Drop只作兜底。每代可写 spool 位于独立 ReachDesktop 目录，未放宽操作账本权限。

原 Windows logon 在发送、接收及每250ms等待期间重新核对。没有可用会话且尚未创建 helper 时返回 failed/desktop_session_unavailable/effectsMayHaveOccurred=false；已经启动或动作之后的观察失败仍保留 unknown，不转移到新会话重做。

## 验证与固定版本

仓库基线 `90f2b1cdd138129e2d331d89a37d70852e849739`，`dev` 未提交工作区。源码、二进制、运行时和证据绑定见[manifest](desktop-pipe-20261102.json)。本次未安装、提交、推送或部署。

| 检查 | 已执行结果 |
|---|---|
| 管道版真实链路首轮 | [native-v1](desktop-pipe-native-v1.log) 2/2；实际输入点击、服务及Node重启图片补传、取消/crash/维护停止 |
| Node Rust | [最终测试](desktop-pipe-node-tests-final.log)7/7、无跳过；含真实 named pipe 的错误 client/server PID、鉴权前零payload、SCM非服务拒绝及断开；有界reader另测截断、无效和超限帧。会话不可用测试只证明执行前分类 |
| helper Rust | [测试](desktop-pipe-helper-tests.log)4/4；两项 pipe 测试与Node共用源码，不重复计算独立覆盖 |
| 编译与静态检查 | Node [build](desktop-pipe-node-build-final.log)/[Clippy](desktop-pipe-node-clippy-final.log)、helper [build](desktop-pipe-helper-build-final.log)/[Clippy](desktop-pipe-helper-clippy-v2.log)，fmt均通过 |
| 依赖 | 两个workspace的离线cargo-deny均通过；[Node](desktop-pipe-node-deny.log)、[helper](desktop-pipe-helper-deny.log)；不声称本轮刷新了网络数据库或完成离线发行许可验收 |
| 最终原生回归 | [最终日志](desktop-pipe-native-final.log)：固定binary的35/35通过、0跳过，342.357s；2项远程链路、6项直接Host和27项Node回归全部通过 |

最终远程产物为 `work/desktop-chain-f412670d-bcbb-4c93-a10d-2358d5471c6a`，直接Host产物为 `work/desktop-native-4d303218-f865-4ec9-ba01-abb380305a7e`。主代理已查看补传PNG和状态：中文输入“Reach Desk 远程中文输入 你好世界”、Committed 1，维护停止exitCode=0且helperStopped=true。路径属于忽略的本机证据目录，未作为发行包发送。

独立代理 `/root/reach_plan_review` 已做设计和源码只读复核。其P2发现是零/多活动会话在helper创建前被误标为unknown，已修成明确failed，并保留启动后错误的原处理。最终618/618固定项匹配：127源码、362运行时、18日志、107产物、4个可执行文件；独立代理查看最终PNG、收据和未知效果证据，接受普通用户认证管道增量。主代理另行核对同一618项并查看图片。生产WTS仍只是静态候选。原开发中语法/常量范围及Clippy问题已修正，失败的Clippy日志保留，没有把未通过检查写成通过。

文档检查覆盖40份活动Markdown、284条本地链接和57个唯一任务ID，无断链，git diff --check通过。全仓bootstrap仍失败43项：38项在Reach外，4项是ignored work里的旧上游README，1项在node_modules/pngjs的README无scheme外链；日志为 `desktop-pipe-bootstrap.log`，属于manifest之后的文档检查，不宣称全仓通过。humanizer仍未找到，采用简洁文字自审。

## 仍未证明的行为

本机再次查询没有RYReach服务，原UAC安装未收到完成回复。当前测试从普通用户启动Node；虽然使用与生产相同的管道实现，但没有执行真正的SYSTEM WTSQueryUserToken/CreateProcessAsUser、受保护运行时扫描、生产spool DACL或普通helper对SYSTEM进程/SCM的查询权限。锁屏、安全桌面、断开RDP、登录切换及Session ID复用仍须真实触发。不能据编译和开发管道测试勾选T05或安装任务。

候选仍使用本机开发Python；完整嵌入式运行时、全组件安装包、全文artifact、模型图片接收、Reach Desk云端Host和新版线上发布继续开放。此前Node-only安装候选未被覆盖。源文件和哈希会随下一工作包变化，旧接线manifest保留历史证据，不把旧binary哈希当当前版本。
