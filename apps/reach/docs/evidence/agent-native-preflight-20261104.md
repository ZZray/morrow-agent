# 原生恢复前置：本地只读检查与地址重绑

作者：Ray Zhang（Ray）。日期：2026-11-04。仅本地开发测试；没有服务器、SSH、远端模型、安装、部署或Git同步/提交/推送。基础0/52、Desk0/5保持，**原Task继续执行及R06仍未完成**。

本轮模型响应均来自受控环回SSE提供方，不是组织模型推理或真实任务理解；Node、命令效果、进程强杀和原账本为实际执行。

## 用户能做的事

通过原operations API提交 `{kind:'agent.inspect',rootOperationId}`，可在原Node返回已结束或结果未知Task的fence指纹，不必读取含本地relay令牌的task.json。仍需本账户、同Node/epoch及独立agent.inspect能力；原Task必须是agent.delegate，不能检查另一台Node、其他账户或把inspect操作当root。CLI/MCP沿原通用提交/查询入口使用；本轮未另跑其stdio/CLI提交进程。

Node核本地原Dispatch、Task/Session、原预算与本地deadline、固定侧车路径/SHA和实际镜像字节。它只核选定字段，**不是完整native authority或所有task.json字段防篡改证明**。返回taskId、Node/epoch、Session、观测时点、fencePresent和expectedFenceSha256；固定标记unlocked_readonly、nativeAuthorityVerified=false、taskAccepted=false。原fence、Session、operation及模型/child/Run账本不改；检查失败作为该inspect操作的unknown保留，不改变原Task。

该指纹只是恢复前的expected值，最终必须由Harness在Session锁内重新核验。fence缺失不表示Task可接受、旧效果已结算或pending可清除；本轮实际流程覆盖存在的原fence，未以已释放Task验证缺失分支。R3用try_exists传播I/O错误，不能把不可读误报为不存在。

另实现Relay::rebind内部原语：严格原127.0.0.1地址、非零端口、路径和原43字符令牌；占用拒绝，不换端口。真实socket测试验证同地址/令牌重绑及拒绝矩阵。它尚未接生产恢复Host，Node不声明agent.resume，没有activation或新原生准入。

## 固定输入与执行

最终 `work/agent-native-preflight-20261104/inputs-r3.json` SHA `1a2b4a17bf123796adb380a29d06de3ea8101a1821d273887d1cedc414315f2a`：189源/副本、10语义目标、4runtime。新Node SHA `629506866789d845b557656e5dad3abac61bcf0fe20506bb07af70f41c573e3d`，侧车仍 `c5b47fea1ab97745d93f7918b8c6ec2f6e246cc122201a25fab2e76a4ee5101f`。测试镜像另存runtime-r3/reach-tests.exe，SHA `dd77639d763f7afd402db5c1ecc6f6412f89046b80f360cb352f3bb614e2dd1b`；不把它当普通Node镜像。

| work/日志 | 实际结果 |
|---|---|
| agent-native-preflight-build-r3.log | 静态CRT Node构建通过，2.76秒 |
| agent-native-preflight-fmt-r3.log / clippy-r3.log | fmt及Clippy -D warnings通过 |
| agent-native-preflight-rust-tests-r3.log | 12/12，0忽略；编译2.66秒、执行3.29秒，含I/O负例与实际socket重绑 |
| agent-native-preflight-native-r3.log | 实际Node强杀/只读检查1/1，零skip，15.484秒 |
| agent-native-preflight-service-r3.log | 身份、能力、原root及去重1/1，零skip，1.935秒；Node生命周期为synthetic |
| agent-native-preflight-budget-regression-r2.log | 实际Node正常三Run1/1，22.762秒；R3仅检查模块I/O处理与新unit变化，正常Task不调用该模块，沿准确源码桥 |
| agent-native-preflight-typecheck-r2.log | 基础/admin类型通过；最终全部TS字节不变 |

Cargo使用Reach独立workspace、单job、缓存reach-static、目标x86_64-pc-windows-msvc、locked/offline；RUSTFLAGS为`-C target-feature=+crt-static`。执行build、fmt --check、clippy/test --all-targets --all-features。依赖及lock未改，沿用既有依赖审计，不称本轮重新在线审计。新Native入口为 `node --test --test-concurrency=1 tests/agent-inspection.integration.test.ts`；显式设置固定REACH_NODE_BINARY、REACH_DESK_SIDECAR与绝对REACH_NATIVE_EVIDENCE_ROOT。无这些候选时该native测试默认skip，本机已启用零skip。

首次构建曾有未用import警告，R2冻结前移除；R2本地检查/真实Node/Rust11项通过。R3仅把exists改为try_exists并增加I/O负例，重建后重跑受影响Rust12项、真实Node与服务组；R2日志和制品保留。

## 实际效果与原件

R3强杀根 `work/agent-native-inspection-cf85743d-02a4-492e-b286-9d520d8203ca`：真实命令已非幂等追加once换行，child终态已提交服务，但代理故意用503阻断原ACK；实际SIGKILL Node后重启，只补传原回执，再执行inspect。原文件仍只有一行、模型仍1请求、child仍1；指纹等于原fence原字节SHA，7个Session文件的前后及当前SHA完全一致，原Task仍unknown/gen1。

两个inspect操作分别成功和unknown；后者仅验证原task.json的sidecarSha256被改写时拒绝，原始与篡改候选分别保留，finally恢复原字节。不据此声称所有字段篡改均可检测。结果无组织密钥、relay令牌或本机状态路径。没有新Task/Run或工具重放。

正常三Run根 `work/agent-budget-d72cbc44-5ab6-4b16-a350-2144a6f830c7` 是R2新Node执行，2次文件效果、3模型、3native admission、两个预算snapshot后普通候选，Released/taskAccepted=false。两根合计2Task/4Run/4模型/3child/54全ACK事件；不当成崩溃恢复成功。两根保留fixture-exit.json，覆盖服务及fixture直接启动的进程；侧车/工具子孙不构成逐PID完整审计。

主原件检查 `work/agent-native-preflight-20261104/checked-r3.json` SHA `e62b30882757560c6bf9127224feb542eac58bef7c3d44b316caec5307d353c1`。独立实现报告 `work/agent-native-preflight-independent-review-20261104.md` SHA `acf2c4cbff912bcec4b2831203de32419fcd543a33e01ec8702b822a5f0c7524`，接受只读检查及socket原语，无未关闭发现，不接受原Task恢复。主代理完整回读，核其链接及42份冻结/原件引用，`review-checked-r3.json` SHA `c04e71d878a2a8578e9d2a3f5791996e158a6401b2d88ad02ea2023cba85b69e`。

六文档165本地链接、10源目标空白及根diff检查通过。根bootstrap原样执行退出1、661失败，本轮六活动文档0失败；原日志及scope记录保留，不清理快照或报告全仓已绿，检查时尚未生成本点文档快照。文档复核路径为 `work/agent-native-preflight-doc-review-20261104.md` 及同名JSON，复核后再生成 `work/agent-native-preflight-20261104/checked-final.json`。humanizer缺失，文字人工审读。

完整恢复仍须服务receipt、锁内Host结算、真实native admission与最终释放三阶段。见[合同](../agent-delegation.md)及[下一步交接](../handoffs/2026-11-04-agent-native-preflight-local.md)。
