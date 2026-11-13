# Node 桌面与原图链路验证

作者：Ray Zhang（Ray）。日期：2026-11-02。范围：普通交互用户的开发 Node、真实 HTTP 服务和 Controller MCP。生产 SYSTEM/WTS、锁屏/UAC、安装、管理页看图、模型看图和 Reach Desk 云端对话不在本次范围。

## 交付行为与版本

Node 持续持有桌面 helper，不按每次操作重启。describe 返回代次、会话和实际工具；call 绑定原代次、快照和 dispatchId。Node 在放行 helper 启动前先安装外层 Job，正常成功保留实例，取消、失败和维护停止等待进程树清空。图片保留原字节，沿同一 SQLite outbox 传输，完整后终态才引用。Controller 校验来源、范围、SHA 和 PNG 结构后返回 MCP image。

源码、普通二进制、Python/JS 运行时、日志及产物的固定输入见[manifest](desktop-chain-20261102.json)。仓库基线 `90f2b1cdd138129e2d331d89a37d70852e849739`，分支 `dev`，均为未提交工作区。本次未部署服务器或替换安装包。Python/Windows-MCP 沿用已验证的 3.14.7 / `0.8.8+reach.3`，固定上游 `94de2b4a5e1f2c52aad6003d5e60af28f57b8c8b`，80 个 Python 源文件与[上一候选](desktop-host-20261102.json)逐字节核对。

## 实际执行

| 检查 | 结果与证据 |
|---|---|
| 最终 Node→服务→MCP 和直接 Host | [最终日志](desktop-chain-native-final.log)，8/8、无跳过，114.334s；前两项是新远程链路，后六项是直接 Host 回归 |
| artifact HTTP / PNG / JSON 合同 | [最终日志](desktop-chain-artifacts-final.log)，3/3，2.764s；含跨账户拒绝、损坏块、部分上传、重复 ACK、伪引用、重复 IHDR/交错 PNG/超长调色板 |
| 原 service 合同 | [日志](desktop-chain-artifacts-v2.log)，原 service 10 项全部通过；同批 artifact 3 项随后补了调色板断言并定向重跑 |
| Node、CLI、管理 API、Ray SSO、service 进程 | [首轮](desktop-chain-regression-v1.log)34 项中32通过、2失败；两处旧工具数量断言已更新为10个精确工具名，[定向复跑](desktop-chain-controller-regression-v2.log)2/2，19.088s。其余32函数及生产源码不变，不写成首轮34/34 |
| Rust Node | [Clippy](desktop-chain-node-clippy.log)通过；[测试](desktop-chain-node-tests.log)2/2；fmt通过 |
| Rust desktop | [Clippy](desktop-chain-helper-clippy-v2.log)通过；[测试](desktop-chain-helper-tests.log)2/2；fmt通过 |
| 依赖 | Node [代理重试](desktop-chain-node-deny-proxy.log)与desktop [离线审计](desktop-chain-helper-deny.log)均 advisories/bans/licenses/sources ok；重复版本和未使用许可 allowance 警告保留。不是完整发行包许可验收 |
| TypeScript | [最终类型检查](desktop-chain-types-final.log)通过；新增 pngjs 7.0.0（MIT），其解码前边界另有故障测试 |

普通最终二进制分别来自 Node [build-v3](desktop-chain-node-build-v3.log)和 desktop [build-v2](desktop-chain-helper-build-v2.log)。两包均为 binary crate，没有单独 doctest 目标；本轮没有模型调用。

文档检查覆盖38份活动Markdown、266条本地链接及57个唯一任务ID，无断链；`git diff --check`通过。[全仓bootstrap](desktop-chain-bootstrap.log)仍报43项：38项在Reach外，4项是ignored work里的旧上游README，1项为新安装pngjs第三方README的无scheme外链。没有修改第三方依赖正文或把全仓检查写成通过。本机未找到humanizer Skill，文案已作人工式简洁审读，不宣称运行了该Skill。

最终远程产物位于 `work/desktop-chain-f078dd98-1fdb-4caa-b8e1-77f8fc574a08`；直接 Host 产物位于 `work/desktop-native-b94d3d20-947f-465e-81be-0c83b77555e1`。这些是被忽略的本机证据，不包含在默认发行中。

远程受控 WinForms 窗口实际输入“Reach Desk 远程中文输入 你好世界”，按钮计数为1。before/after/node-recovered PNG 均从真正的 MCP image 解码，并逐字节比对 Node 原 outbox。丢失第一个分块 ACK 后分别重启服务和 Node，原 operation 完成、原图保留，没有再次截图。维护停止确认前 helper PID 已不存在。取消和 Node 崩溃后的文件仅有 `once`，延迟终点文件不存在；旧代次拒绝，新 describe 创建不同代次。

跨语言用例经真实 Controller 提交嵌套 astral/private-use/中文键与 `1e+21`、`1e-8`。Node 校验外层哈希并保存完全相同 argumentsJson 后，Windows-MCP 对额外参数给出真实 schema 错误；测试要求失败而非伪造截图成功。

## 失败历史与独立复核

- artifact 首轮测试误用仅初始化首账户的 bootstrap 创建第二账户，且提取旧 fixture 时漏导出 password。修正测试夹具后13/13通过；未修改账户隔离规则。
- 链路 v1 把传输探针混入正常截图参数，后端正确拒绝，1/2通过。探针改成独立的预期拒绝用例，链路v2为2/2。
- 旧 CLI 测试仍要求7个工具，新增3个后出现10!=7；改为完整精确名称集合，原请求身份与文件效果断言全部保留并通过。
- helper 新gate比较触发 Clippy byte_char_slices；等义修复并重建，最终8项全部使用新 binary重跑。
- 首次 Node deny 的直连 Cargo fetch 超时，保留[日志](desktop-chain-node-deny.log)。只终止该检查的 fetch/deny进程后用已核实的本机代理完成；不能把被中断的检查记为通过。

独立复核由 Codex 子代理 `/root/reach_plan_review` 执行，只读检查 TS/Rust 状态、持久顺序、身份、PNG分配边界和原始产物。发现并修复：重复 IHDR/交错 PNG、超长 PLTE、捕获失败被误当作执行前拒绝、图片持久化失败时的 helper收尾顺序。最终独立核验622/622项匹配：125源码、362运行时、24日志、107产物、4个可执行文件；无缺失、哈希漂移或组内重复。主代理独立复验同一622项并查看最终PNG/状态。复核接受普通用户开发链路增量，完整任务清单保持开放。

## 未完成边界

生产服务不加载 development stdin。WTS/CreateProcessAsUser、认证 pipe、真实会话切换以及完整离线运行时仍待完成。超长桌面文本只保留本机后端文件和摘录，尚未接全文 artifact；单图/像素超限如实失败。PNG取回与模型实际理解图片分开。D06/T05/T06、安装和 Reach Desk 的 X01–X05 继续未勾选，既有线上443/SSO版未因本次本地测试改变。
