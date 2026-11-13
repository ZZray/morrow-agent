# Node委托两次真实截图：本地证据

作者：Ray Zhang（Ray）。日期：2026-11-04。对应R01/R03/R07分项。仅本地普通Windows进程、受控loopback模型端点；没有访问服务器或远端模型，没有部署、安装、提交或推送。基础仍0/52，Desk仍0/5。

## 可观察行为与修补

同一个`agent.delegate`经原Rust Node、Lite/Harness侧车和模型relay，执行一次desktop.describe、两次Screenshot。两个可见测试窗口分别绘制随机码及顺序不同的彩色图形；不截图用户其他窗口。验证区域尺寸和图形中心像素、窗口PID、两次PNG原SHA，再核原Node outbox、服务事件、子操作产物、Task evidence及模型typed输入同字节。受控端点按脚本发工具调用，本轮不证明模型视觉理解或随机码识别。

这次只改变`src/node/agent.rs`并增加`tests/agent-desktop.integration.test.ts`。原`vision-fixture.ps1`、共享Core/Harness/侧车/provider与依赖版本没有在本点改变。

- 原4KiB结果窗口在32768配置下因大桌面描述及多次回执超过Core文字投影预算：第二张截图已保存，但模型只收到第一张图。现按contextWindow/32分配预览，限制256–4096字节；32K为1024，131072为4096。完整原件与SHA/resultRef保留，可继续读取；该字节分配不是token用量估算。
- 非空Session中full_proof覆盖完整历史，raw_proof只覆盖当前Run。原Host误要求二者相等，使成功截图的新Task被拒绝。固定侧车仍在Session锁内验证range_proof、head与原basis；Node核精确basis、当前结果索引范围、原callback/结果集合和每张原图，fresh Session仍要求full_proof等于raw_proof。
- typed模型请求已收到两张图之后，故意改写Task内第二张PNG。父操作成为unknown，保留原fence与原成功子收据，未生成审核成功记录、未重拍；实际桌面helper及测试窗口退出。

## 固定源码与运行时

仓库`E:/repos/ara`，分支dev，HEAD `90f2b1cdd138129e2d331d89a37d70852e849739`加既有WIP；未套用Lumen分支规则。快照`work/agent-desktop-20261104/inputs-r1.json`，SHA `b522f03cb3072dca89e4577c4dc85bfa4425d4ad1c41784d36a751524248f6dc`，168源/副本、3个语义审查目标、4个运行镜像。身份覆盖不等于168个文件都做了新语义审查。

| 镜像 | 固定SHA256 |
|---|---|
| `work/agent-desktop-20261104/runtime-r2/reach.exe` | `230ce49def22fc7e5670e9080e0240f996eec14f7cd89739f50c802ae657e46c` |
| 原侧车`work/desk-images-20261104/runtime-final/ara-agent-lite-jsonl.exe` | `0275185113786a971fad17307c4cefcd0de4d2c0666bcb857d9cc20b2e26a344` |
| 既有`reach-desktop.exe` | `0ea7c0b2c6117b04163614010771d1b1532f7b8dc49fa47af8dda5dc7778eea2` |
| 既有便携`python.exe` | `4942b86a6597e5aee0128daa00050ed79bc21f6e709a78eb19cbfeb0c2f39ac9` |

安装候选没有重发，开发镜像不表示已装配或验收生产安装。

## 执行结果

从`apps/reach/`执行。Cargo使用`CARGO_TARGET_DIR=E:/usr/var/cache/rust-target/reach-static`、单job、`RUSTFLAGS=-C target-feature=+crt-static`、`--target x86_64-pc-windows-msvc --locked --offline`。实际截图测试设置固定Node/sidecar/desktop/python的绝对路径与隔离状态目录，不使用生产配置。

| 检查 | 实际结果 | 本地原始记录 |
|---|---|---|
| `cargo build` | 最终r2通过，3.15秒 | `work/agent-desktop-build-r2.log` |
| `cargo fmt --all -- --check` | 通过 | `work/agent-desktop-fmt-r1.log` |
| `cargo clippy --all-targets -- -D warnings` | 通过，2.59秒 | `work/agent-desktop-clippy-r1.log` |
| `cargo test --all-targets --all-features` | 10/10，0忽略；构建4.85秒、执行1.95秒 | `work/agent-desktop-rust-tests-r1.log` |
| `node --test --test-concurrency=1 tests/agent-desktop.integration.test.ts` | 最终r3四函数4/4，121.682秒 | `work/agent-desktop-r3.log` |
| `node --test --test-concurrency=1 --test-name-pattern='real Node waits\|a large original child result' tests/agent-node.integration.test.ts` | 受影响文件流程2/2，31.112秒 | `work/agent-desktop-files-regression-r1.log` |
| `bun run check` | 基础/admin类型通过 | `work/agent-desktop-typecheck-r1.log` |
| 依赖审计 | 沿用前点已执行离线frozen deny；Cargo.toml/lock身份未变 | `work/agent-node-deny-r1.log`；不是本轮重新审计或在线最新数据库 |

四个最终截图场景分别是131072配置、32768配置、新Task沿原非空Session接续、消费后篡改原图。前三个父结果succeeded但taskAccepted:false/awaiting_review；负例父unknown，三个child仍succeeded。完整路径在日志和快照scenarios中，不靠目录时间推断执行结果。

主代理`work/agent-desktop-20261104/check.mjs`读取实际SQLite、每个原事件和PNG，核4场景、12个子操作、16个当前Task模型请求、175条原Node事件、12个typed图片块。原Session前Task的1次模型请求不混入本Task16次。`checked-r1.json` SHA `0ab9b7f78b99a86a97402d781a8cafeaad0b0ecf5194797a8aab470baf8eab7b`。非空Session实际范围为[2,10)，其full_proof与raw_proof不同；其余为[0,8)。每张图均有独立artifactId、contentIndex=1及complete事件。负例保留原成功图片传输，仅Task图片副本被故意改写。

## 保留的失败与证据限制

`agent-desktop-r1.log`记录开发桌面配置未提供绝对存在路径，Node没有声明能力；修正测试配置后r2单函数通过。随后`agent-desktop-32k-r1.log`记录32K文字预算失败，`agent-desktop-retained-before.log`记录非空Session证明误比失败。中间`agent-desktop-build-r1.log`记录修补中一次Rust语法编译失败；最终r2修正后构建。所有失败保留，没有改旧Task或把它们统计为成功。

主代理原件检查脚本初稿误把child状态从agent_calls直接取、把complete当作终态引用字段；已改为关联operations及检查原artifact.complete事件，没有修改产品代码或原任务，也没有重跑任务掩盖检查错误。

独立复核者`/root/reach_plan_review`接受声明的本地截图执行点，无未关闭阻断；报告`work/agent-desktop-independent-review-20261104.md` SHA `2668f1b5aba680d0e68075e71840abbb93cba4f4720059554623a8309630a001`。独立核168源/副本、4镜像、四场景原件及原生journal逐条hash/chain；另执行一次公共只读inspectSession，核原非空Session的[2,10)及不同full/range证明，29个不同原PID均退出。没有重跑截图矩阵，主代理已完整回读报告并回查其原件与SHA。

独立原件审计`work/agent-desktop-independent-check-20261104.json` SHA `979e142699e1319fd2941488fb1a0e8cd7e7e390da9c3d454698d7ee2e9a916d`；独立冻结核对`work/agent-desktop-independent-freeze-20261104.json` SHA `86bfa1ec215033156064bf3d6e30d52ebb9de74da553c9ad9aaf678490e1a0ab`。主代理两文件回归原库核对`regression-checked-r1.json` SHA `a446e149ffe803ba2a05bcc314468e5ae1c485163e3008a7201358b28b307170`。独立审计初稿也曾漏关联operations的字段，已核原schema修正，不修改产品或任务原件。

6份当前文档136条本地链接及4个目标文件空白检查通过，根git diff检查通过；范围见`work/agent-desktop-20261104/docs-checked-r1.json`，最终来源清单为同目录`checked-final.json`，不宣称全仓历史文档或完整产品通过。humanizer未安装，本文已人工审读。未改UI，不重跑无变化浏览器矩阵；没有以本地受控端点替代真实组织模型、跨物理机器或生产安装验证。

下一步是多Run prepare、原Task显式恢复及剩余预算、R04/R05技能/来源/经验、旧Desk历史迁移。SCM/SYSTEM、锁屏/切用户、干净机安装升级卸载、真实组织视觉模型和Ray上线仍开放，远端操作等待用户明确恢复。
