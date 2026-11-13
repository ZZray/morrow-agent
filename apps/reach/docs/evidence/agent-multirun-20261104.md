# 原Task调用方反馈与多Run：本地证据

作者：Ray Zhang（Ray）。日期：2026-11-04。范围：R01/R03/R06普通多Run分项、原收据与Run封存、等待反馈时的图片完整性。本轮未访问服务器或远端模型，未部署、安装、提交或推送。基础仍0/52、Desk仍0/5；原Task恢复和完整清单没有完成。

本文保留该冻结点当时的证据与缺口；后续已补[跨Run实图](agent-cross-run-images-20261104.md)及[固定cap/闭合预算续接](agent-budget-20261104.md)，最新接续见[本地交接](../handoffs/2026-11-04-agent-budget-local.md)。

## 交付行为

显式`maxRuns>1`的委托可以在同一个Task/Session内通过CLI/MCP取得原候选，提交绑定basis的continue修正原文，再经现有Lite/Harness prepare进入下一Run；return_result只返回待复核结果，taskAccepted仍为false。默认单Run行为保留。

新增合同`src/contracts/agent-review.ts`、关联存储`src/service/agent-reviews.ts`与schema4；Node按Run保存证据并切换同一个relay的请求归属。复用现有Core/Harness/JSONL侧车，没有复制循环、改共享Core或新增依赖版本。具体接口与顺序以[现场委托合同](../agent-delegation.md)为准。

候选发布后该Run封存，拒绝新模型或工具效果；读取原收据仍可用。等待决定后、prepare发送前重新核原事件、模型transport和当前Run的Task PNG。预算用尽但已结算的BudgetExhausted/Released返回failed/未完成，与unknown/Present分开。

## 固定版本与实际身份

仓库`E:/repos/ara`、dev、HEAD `90f2b1cdd138129e2d331d89a37d70852e849739`加原WIP。最终快照`work/agent-multirun-20261104/inputs-r2.json` SHA `441abbe167314b5313d7e6d11bd357962e0764ecd5544fb3090949a15b180443`：172源及副本、16个增量语义目标、4镜像；覆盖身份不等于172个文件都做了新语义审查。前一截图快照及本点r1快照保留，不重写历史身份。

Node为`work/agent-multirun-20261104/runtime-r4/reach.exe`，SHA `f32434dbb5ed4e5ebe119893627d0a32cbc9ce2f4fead4cb246762b33cc64dd1`；侧车沿用`0275185113786a971fad17307c4cefcd0de4d2c0666bcb857d9cc20b2e26a344`。desktop/Python仍为前一截图点固定镜像。最终五组Node场景在启动时记录Node/侧车/测试/fixture与关键服务源的SHA；旧normal-r2原件没有补造启动清单。

本点r1→r2只修改两个测试前置：候选等待从默认20秒改为120秒且父先终态立即失败，原截止时间专测用原claimed+30秒；epoch测试先明确结算原父并携带旧凭据真实再配对。产品和Node镜像未在这两版间改变。

## 验证结果

Cargo从`apps/reach/`执行，使用固定Windows目标、静态CRT、单job、locked/offline及既有E盘target缓存。没有联机更新依赖。

| 检查 | 实际结果 | 原始记录 |
|---|---|---|
| `cargo build --target x86_64-pc-windows-msvc --locked --offline` | 最终r4通过，2.89秒 | `work/agent-multirun-build-r4.log` |
| `cargo fmt --all -- --check` | 通过 | `work/agent-multirun-fmt-r1.log` |
| `cargo clippy ... --all-targets --all-features -- -D warnings` | 通过，3.89秒 | `work/agent-multirun-clippy-r1.log` |
| `cargo test ... --all-targets --all-features` | 10/10；构建7.73秒，执行5.78秒 | `work/agent-multirun-rust-tests-r1.log` |
| `node --test --test-concurrency=1 tests/agent-multirun.integration.test.ts` | 最终r4为5/5、0跳过，107.764秒 | `work/agent-multirun-r4.log` |
| 实际desktop的32K与等待反馈篡改负例 | 2/2、0跳过，127.812秒 | `work/agent-multirun-images-r3.log` |
| 5个服务/模型/父子/重启测试文件 | 首批41函数40通过/1夹具失败，223.026秒 | `work/agent-multirun-service-r3.log` |
| `tests/agent-reviews.test.ts`精确复测 | 修正epoch前置后5/5，13.147秒；其他36函数沿用未变证据 | `work/agent-multirun-service-r4.log`；不是一次41/41全量通过 |
| `bun run check` | 最终基础/admin类型通过 | `work/agent-multirun-typecheck-r2.log` |
| 依赖审计 | 沿用既有离线frozen deny，manifest/lock无变化 | `work/agent-node-deny-r1.log`；未重跑或宣称在线最新审计 |

最终五个真实Node场景：

1. 原Task先写一次文件，CLI读取候选，MCP提交原文反馈，第二Run读取原文件，再由CLI请求返回结果。四次模型请求归属两个Run；完整两child、同Session、总预算及原SHA可核，文件仍为`once\n`。最终succeeded/awaiting_review，taskAccepted:false。
2. 第二Run仍需修改但Run预算已用尽：failed、BudgetExhausted、Released；没有假恢复fence。之后新的Task可沿已结算Session执行，不把该新Task称为旧Task恢复。
3. 一次真实文件效果后等待反馈时取消：父unknown，原成功child与文件保留，两个模型请求，无重复写入，原fence保留。
4. 服务已预占第二Run、Node已持久保存planned prepare_reply，但故意延迟服务响应并取消：原Task unknown，服务保留2个Run预占、仅1次模型；第二Run没有实际prepare_reply、native admission或模型请求，不退款或伪报已发送。
5. 普通候选发布后不反馈，原claimed+30秒到达：父unknown、原fence保留、仅1次模型，没有自动Verified或追加Run。终态在原截止后的10秒内，不从候选发布时间重给30秒。

主代理`work/agent-multirun-20261104/check.mjs`直接核5组实际SQLite、所有原outbox/服务digest、Task/Run/候选/决定、原文件及模型intent/transport：6个Task（含第2例后续新Task）、3个child、11次模型、7个review、9次Run预占、113条原事件全部ACK。`checked-r2.json` SHA `76c03aadbef992aab2edce3a6f442fafb400b555774e0bc6e96ea54c298d48fe`。

服务精确测试覆盖并发相同决定只提交一次、原响应重取、改原文/ID/basis拒绝、真实服务重开、账户/取消/旧epoch/截止时间、提交失败回滚及发布Run封存。服务夹具的父生命周期是合成收据，不冒充真正Node或工具执行。

## 已修复的独立发现与保留失败

独立复核发现等待窗口图片校验缺口：旧r2只在进入等待前核PNG，等待时改写原件仍能Released。`agent-multirun-image-before-fix-r2.log`真实两次截图后实测succeeded，负例因此失败；修后`agent-multirun-images-r3.log`同一判据为unknown/Agent reference changed，原fence及成功子收据保留，零重拍。第一次before-fix日志停在默认20秒候选等待前置，没有被当成漏洞复现。

独立服务探针还复现了已发布Run仍能追加一个模型和一个child的问题；修后pending、已决定continue、下一Run已登记三阶段均拒绝旧Run新效果，新授权Run仍可执行。原件在`work/agent-multirun-review-sealed-run-20261104.*`与`...-after-20261104.*`，探针child只被claim、未在现场执行，不夸大为工具副作用复现。

早期r1：MCP测试误用夹具request而非call，另一个服务测试用了错误的本地fixture密码；修正测试后正常单函数r2通过。第一次构建r1缺少caller_review的可变Ledger引用，后续构建修正。所有日志保留。

原生五函数首批r3为2通过/3失败：三个都在20秒等待内没有候选；原8秒截止例其实已经unknown/Agent stopped，不能说产品未按8秒停止。两截图在并行时分别66.7/61.0秒，先检查原账本，再调整测试阶段等待并单独复测，不推断未经证明的唯一超时根因。服务r3的唯一失败是再配对夹具没有旧凭据、也未先结算原父，修正后真实进入新epoch；没有绕过配对规则。

## 边界与下一步

独立复核者`/root/reach_plan_review`接受声明的本地多Run执行点，无未关闭确认阻断；报告`work/agent-multirun-independent-review-20261104.md` SHA `c401ed0dbc7a496809bc1f745b6c57860e8ec599d837399b1602333695ff0277`。独立核172源/副本、4镜像、16语义目标及七组实际原件：8Task、196条原outbox全ACK、19次模型、4PNG。另核五个服务夹具及其6次模型，两类计数不混用；38个原进程身份在复核时均退出。没有重跑测试矩阵。

主代理完整回读报告，核其10份审计脚本/结果SHA、七组原件摘要和退出清单，保存`work/agent-multirun-20261104/review-checked-r2.json`。进程检查以原退出记录及复核时点为准；Windows可复用PID，主回查排除了检查器自身复用旧PID的情形，没有停止任何进程。6文档142条本地链接、16增量目标空白及根diff检查通过，见`docs-checked-r2.json`；最终来源清单为同目录`checked-final.json`，不把全仓历史断链或整个产品报告为通过。

没有访问服务器、真实组织模型或跨物理机器，也没有更新安装候选。默认Reach仍不加载Desk，LabSlot延期；完整清单不因本地分项通过勾选。当前普通两Run为文件/文本正例，跨Run图片消费完整正例仍待补齐，不以等待反馈篡改负例替代。

下一步先补跨Run图片正例，再推进原Task显式恢复：固定首次per-Run cap、原root Task预算、新恢复operation、原endpoint/token与fence、模型unknown显式核对。普通prepare与已结算Session的新Task都不等于恢复。闭合预算停止续接、R04/R05、旧Desk历史、SYSTEM/SCM/锁屏/安装升级卸载及部署继续开放。humanizer未安装，本文人工审读。
