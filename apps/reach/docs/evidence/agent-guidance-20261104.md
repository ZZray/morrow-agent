# Reach 能力说明与技能传递：本地执行点

作者：Ray Zhang（Ray）。日期：2026-11-04。状态：本地限定实现点通过独立复核。完整 R04 及首版仍开放；没有访问服务器、调用远端模型、部署、安装或执行 Git 同步/提交/推送。

## 行为与源码

本点在既有 sources 上增加可选适用要求，提交、恢复提交、最新 hello 派发和 Node 启动前分别核对；工具结构从实际服务输入合同生成，说明与启动环境进入模型和原任务记录。旧任务恢复仍用旧工具和原来源。合同权威见[现场委托](../agent-delegation.md#工具说明与任务来源)。

仓库 `E:/repos/ara`，dev，HEAD `90f2b1cdd138129e2d331d89a37d70852e849739` 加保留的工作区。基线副本、日志、普通 EXE、最终快照在 `work/agent-guidance-20261104/`。最终 Node 为 `runtime-r2/reach.exe`，SHA `b69c4bdd8d7630e798a7368c0d9329a36bfb8428e56f4471601f99aacbce008b`；固定 JSONL SHA `d7b4182d74bea47fdf210c54952fe1c33f24cd0379c107636c00035fa9f71439` 未改。旧 Node 来自前点 `agent-dependencies-20261104/runtime-r2/reach.exe`，SHA `5e9837e5fd39d240f37289612a5ab71eaeb451ce6640f37878b543d02ce14904`。

## 实际验证

统一在 `apps/reach` 执行，Cargo 使用 `E:/usr/var/cache/rust-target/reach-static`、单 job、静态 CRT、`--target x86_64-pc-windows-msvc --locked --offline`，未并发 Cargo。

| 检查 | 结果及原日志 |
|---|---|
| Cargo fmt/clippy/test/build | fmt、all-targets/all-features clippy `-D warnings` 通过；16/16 Node 测试通过。`fmt-r2.log`、`clippy-r2.log`、`node-tests-r2.log`、`build-r2.log` |
| Cargo deny | 沿既有 Node policy/lock，advisories/bans/licenses/sources 四项通过；`deny-r1.log`。未改变依赖或新增豁免 |
| 类型 | `bun run check` 通过，含管理页；`typecheck-r5.log` |
| 新来源/派发/恢复服务合同 | 6/6；`service-tests-r6.log`。版本、平台、缺能力、旧声明、原文重启读取、恢复回滚、原ID排队恢复、取消/解绑诊断清理 |
| 既有服务回归 | 47通过、0失败、2既有真实旧库环境项未提供而skip；`service-regression-r1.log`。覆盖service、agent-calls/executions/resumes/reviews及当时4项guidance，不与新6项重复相加。末次解绑诊断清理另由上述新测试覆盖 |
| 最终服务逻辑回归 | `service-final-r1.log` 16/16，含10个既有service与6个新guidance；之后仅明确file.write整文件替换说明，另重跑上行6项与全部3项native |
| 真实普通 Node 链 | 3/3；`native-tests-r4.log`，无skip。下面列明实际边界 |

实际三组：

1. `agent-guidance-native-84f20733-d5d3-41e6-b2a9-952a99adaa67`：技能原文包含随机文件名和原base64字节，受控 provider 从实际收到的模型正文读取它，再发真实 file.write；两次模型请求、一次实际文件效果、原outbox ACK、Task保存和服务重启后同来源核对。提供证据说明真实模型输入/工具链已接通；没有证明真实模型理解能力。
2. `agent-guidance-native-a81228ce-a68c-4580-ab58-7b1987f20df6`：实际 Node 没配桌面。测试适配器供应已准入派发，独立隔离 Node 守门；Node只有received/failed，无running、Agent目录、侧车、模型或工具调用。正常服务的旧hello/能力变化守门由服务测试独立验证，不将适配派发冒充生产领取。
3. `agent-guidance-native-0eb9cb50-c11e-4f81-bdf2-178ff687c820`：真的启动旧5e98 Node，写出一次原文件，在child终态已保存但ACK丢失时强杀；新版Node补传原outbox，再沿原Session/fence恢复。第二次实际模型请求的工具定义与第一次完全相同，保留旧skill原文、原task.json字节、唯一child和文件效果。显式return_result后等待进程join与最终结算；模型结束本身未当作Task接受。

各目录有 provider-requests、SQLite、原Session/证据、asserted.json；不含组织密钥，临时loopback token为测试随机值。它们是本机隔离运行记录，不是生产状态。

冻结 `inputs-r2.json` SHA `74879bb32f72550ba941b03403db49a34b9746321a7f4e637916a3204ad9c340`，包含271当前源码/副本、14项变动、3个真实二进制、日志和三组原运行目录。主代理 `checked-primary-r2.json` 已直接回读全部源/副本及SQLite原件：共47条outbox原事件均已ACK，服务digest/事件正文一致；4次实际模型请求、2个child效果，旧Task原字节/旧工具定义及最终Released/进程join收据相符。r1冻结和9fa1旧Node实跑保留为历史，不拿历史结果代替最终b69c本轮执行。

## 失败保留与复核

`service-tests-r1.log` 保留两个夹具错误：误用anyOf而实际生成oneOf，以及未关闭原服务就重开同库。修正断言和生命周期后通过；`service-tests-r3.log` 保留claim新增ReachError漏import的实现失败，已补齐并重跑。`native-tests-r1.log` 的旧工具断言误读第一个内建工具；`native-legacy-r2.log` 未向真实待复核Run提交return_result而超时。修正夹具后同一Node二进制3/3通过，未放宽产品断言。`typecheck-r1.log` 是不适用的npx启动器失败；r2保留新测试类型错误，修正后Bun项目入口通过。

独立设计复核 `/root/reach_plan_review` 为conditional approval，指出并落实最新hello/旧程序派发守门、原Task恢复、配置能力边界和额外运输限制。设计报告 `work/agent-guidance-design-review-20261104.md` SHA `285f4de6e4b91e821069a0010c2a1cbc66c77c24acf6859086897dfd592a6116`。

[最终独立复核](../../work/agent-guidance-independent-review-r2-20261104.md)接受 `ACCEPTED_LOCAL_R04_GUIDANCE_POINT`：14实现/测试目标全覆盖，0 skipped、无confirmed finding。独立回读271源/副本、8原基线、3二进制、实际4模型请求/2child/47原事件、6个服务fixture库、旧Task/Session及释放/join证据；生成JSON原字节也在新EXE内，`--check`实际退出0。独立执行的是原件核验和生成一致性检查，没有把主代理测试写成再次独立运行，也不重复相加。humanizer未提供，文档人工审读。最终报告、结构化核验、当前源码与定稿文档摘要另封存于本点 `checked-final.json`。

报告 SHA `052ed60a248f9d335622cc32923fd13107d9e37e2a312817a3ebc68ef078cb3a`；结构化JSON SHA `b7bb15a5e67c824462a241f445e3185a6f908761a8c20f42f06567f812398c4c`；独立回读JSON SHA `11702639b0d4c42a8ce237da90b1927c83110c6a1efe92a875f6a49386dc8a6a`。主代理另核271源/副本及47原事件的 `checked-primary-r2.json` SHA `65cfa55b078017b6b6e6ae1f2d25060364c094ca4f35eb9d2697f90d896638d5`。主代理定稿后回读六份文档并封存；状态文字更新不冒充独立回读时的旧文档摘要。

## 保留范围

工具说明全集不是所有工具当前可运行的保证，来源revision不是自动技能仓库核验。没有自动发现/安装技能、知识晋升、产品权限开关或审批。R05、完整R06、typed开放图片恢复、真实模型、Windows安装与最终57项仍开放。基础0/52、Desk0/5，不以本点通过改写完整验收。

当前安装候选仍是[上一点](agent-package-20261104.md)的冻结包，未重打包本点Node，不宣称旧安装包包含新能力。
