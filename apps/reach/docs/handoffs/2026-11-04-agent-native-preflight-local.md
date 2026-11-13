# Reach 本地接续：取得真实原fence指纹

作者：Ray Zhang（Ray）。日期：2026-11-04。

继续完整首版目标，仅本地开发测试。禁止服务器/SSH/远端模型、部署、安装、Git同步/提交/推送或清理原WIP。仓库E:/repos/ara、dev、HEAD90f2b1c，不套用Lumen规则。基础0/52、Desk0/5，默认Reach不依赖Desk，LabSlot延期，Goal保持active。

新增agent.inspect：原Node只读核选定原Task/Session/镜像字段并返回真实fenceSHA，结果固定unlocked_readonly/nativeAuthorityVerified=false/taskAccepted=false，不清pending或改原Task。Node有inspect能力，**仍不声明agent.resume，原Task继续执行未接通**。Relay::rebind只完成内部socket原语，未接生产Host。[证据](../evidence/agent-native-preflight-20261104.md)、[合同](../agent-delegation.md)。

最终inputs-r3.json SHA `1a2b4a17bf123796adb380a29d06de3ea8101a1821d273887d1cedc414315f2a`，189源/10目标/4runtime；Node `629506866789d845b557656e5dad3abac61bcf0fe20506bb07af70f41c573e3d`、侧车旧c5b47f…。静态CRT Node构建、fmt/clippy、Rust12/12、实际强杀检查1/1、服务1/1通过，TS仍R2相同字节。R2正常三Run1/1沿Rust inspector-only变更桥，未扩大成全量最终重跑。首次build未用import警告保留，R2/R3冻结与制品不覆盖。

实际原件为agent-native-inspection-cf85743d-02a4-492e-b286-9d520d8203ca及agent-budget-d72cbc44-5ab6-4b16-a350-2144a6f830c7；合计2原Task/4Run/4模型/3child/54全ACK。命令追加只一次，硬杀后Session七文件不变；task.json.sidecarSha256篡改拒绝，不扩写为全字段防篡改。fixture-exit仅直接进程，不是所有子孙PID证明。所有测试句柄已收终态。安装包未更新。

模型为受控环回SSE响应，不是组织模型推理；实际Node/进程/文件效果与模型能力验收分别记录。

主check `checked-r3.json` SHA `e62b30882757560c6bf9127224feb542eac58bef7c3d44b316caec5307d353c1`。独立实现报告work/agent-native-preflight-independent-review-20261104.md SHA `acf2c4cbff912bcec4b2831203de32419fcd543a33e01ec8702b822a5f0c7524`接受限定只读/socket范围，无未关闭发现，不接受R06。主代理完整回读并核42引用，review-checked-r3.json SHA `c04e71d878a2a8578e9d2a3f5791996e158a6401b2d88ad02ea2023cba85b69e`。文档复核使用work/agent-native-preflight-doc-review-20261104.md及JSON；复核后再生成work/agent-native-preflight-20261104/checked-final.json，不覆盖前点。humanizer缺失，文档人工审读。

六文档165本地链接、10源目标空白及根diff通过。根bootstrap退出1/661失败，本轮活动文档0失败，原日志/scope保留；检查发生在本点文档快照生成前，不称全仓已绿。

## 下一步仍是完整原生恢复

已读独立完整接口设计 `work/agent-native-resume-interface-review-20261104.md` SHA `14143ad2ee93a4f739230fd838203a7e3b89528890a2a5abbed0cebb2142e3e5`，22冻结源码输入记录为 `work/agent-native-resume-interface-inputs-20261104.json` SHA `5f5c1a72a39a8dc65b5975bbc3722862051483cdc5945968cd1a7ea47ebe44cd`。该报告是方案，不是运行验收。与[前点服务关系](2026-11-04-agent-executions-local.md)接续：

1. 先完成schema9的immutable恢复receipt，Run注册/admission/review分别归属，以及历史模型逐请求解释；不能只把phase改active。Node仍保留原task.json，attempt证据进独立目录。
2. 计划新Run UUID在start.resume前固定；公开头run_id是这个新Run，不是interrupted_run。Harness已持Session锁并核fence后才发reconcile_request，Host核完整原件、全模型/child/unknown_effects和继承消费，提交服务receipt并保存准确回复后发stdin。
3. previousExecution与实际fence owner可不同；下代沿原fence/evidence链核归属。接管后admission前再崩溃，沿resume.json继承，不重复加消费；无admission预占槽复用原UUID。缺observation全cap扣，actual与charged分栏。
4. 复用exact rebind原endpoint/token，原本地绝对deadline不重算；加入当前serverNow/RTT仅压缩watchdog。镜像、route、工具、Session、cwd和epoch不换。inspect指纹必须在Harness锁内重核，不能作为已验证授权。
5. 新fence/resume.json与run-N-admission原件齐全，首个新模型及tool/verify/terminal入口才幂等服务admit。pending继续挡新Task/re-pair，active效果由准确admission授权；旧模型stop只解释被本恢复receipt逐请求引用的历史项。
6. completed_models须拆成历史效果核验与逻辑消费；verify/prepare/terminal同步改。旧pending review不得当新代反馈，无review崩溃Run的序号空档须由消费proof解释。开放工具按原顺序结算；文本receipt不能冒充typed图恢复，不重放未知效果。
7. 最终proof核Released、完整效果及进程结算，与原operation终态同事务清pending。同Session后续Task才可进入。若native已Released但Node尚未存终态就崩溃，必须只读finalization或原outbox补传；NoFence时不能新造Session/fence再跑。

实测还需真正硬中断→原Task继续、无admission/待prepare/重复崩溃/丢ACK，以及wrong fence/owner活/端口/epoch/route/预算/未知效果拒绝矩阵。R04/R05、真实安装/SCM/SYSTEM/锁屏、旧Desk历史、组织模型/跨机/部署仍开放；服务器暂停不阻碍本地实现，不标Goal complete/paused/blocked。
