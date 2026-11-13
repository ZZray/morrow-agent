# Reach Desk 原图查看与真实截图链路

作者：Ray Zhang（Ray）。日期：2026-11-04（Asia/Hong_Kong）。

本轮只在本机运行，不访问服务器、不探测远端模型、不部署、不安装，也不提交或推送。仓库为 `E:/repos/ara`，分支 `dev`，HEAD `90f2b1cdd138129e2d331d89a37d70852e849739` 加既有 WIP。完整基础清单仍为 **0/52**，Desk 为 **0/5**。

本点验证的是：真实 Reach Node 截取受控窗口，原 PNG 经原操作账本进入 Desk 和共享侧车的实际图片请求，再由浏览器按需预览与下载。[上一轮](desk-images-20261104.md)使用 seeded 设备账本，本轮最终流程使用实际 `desktop.describe` 和 `Screenshot`，两者分开计证。模型端仍是受控 loopback HTTP 服务；没有运行组织视觉模型，也没有证明模型理解随机码或图形。

## 实现与界面

`image-view.ts` 从成功 `reach_image` 收据投影原操作、产物、SHA、大小和尺寸；列表不读 PNG，不暴露 Host 路径。损坏记录保留来源标记。原收据持久化后才写 `device_image` SSE，历史 GET 可独立恢复。

认证接口 `GET /api/v1/desk/messages/:id/images/:callKey` 先核账户与消息，再核该消息的调用、固定 proof/intent、原操作及完整 manifest，最后对缓存原件核同一已读字节、SHA 和 PNG。proof/intent 从同一 fd 有界读取，分别最多 16 MiB/1 MiB。接口使用 `image/png`、精确 Content-Length、no-store、nosniff；不提交设备操作。原图读取不依赖当前配对，也不扫同消息的其他 unknown 调用，不要求后来核对的 operation 整行仍等于旧快照。

浏览器按需读取原图，核长度、SHA 和解码尺寸，下载复用已校验 blob。每次异步返回均检查原卡片、会话和登录代次；paint/退出会 abort 并回收 URL。30 秒计时器保留，摘要完成后和解码前后另查 aborted，避免错过已触发的取消。CSP 精确增加 `img-src 'self' blob:`。

| Before | After | Why |
|---|---|---|
| 原图只存在于工具和原生证据 | 消息内显示设备来源，按需查看、取回原图 | 用户能把图片与原操作对应起来 |
| 读取失败缺少可见原图来源 | 来源与读取状态分开；失败可重新读取同一原件 | 保留取证依据，避免误导用户重新截图 |
| 哈希期间超时可能错过解码取消 | 异步阶段检查取消，按钮恢复可重试 | 消除一直加载的确认缺陷 |
| 390px 下工作区隐式列被撑到 541px | 工作区与图片网格显式 `minmax(0,1fr)` | 长设备信息和原图都能留在窄屏内 |

沿用现有暗色工作台和原生 figure/details，没有新增动效。体贴落在“失败后仍有来源、重试只读取原图”，不把字节校验写成模型已经理解图片。

## 固定输入

最终冻结为 `work/desk-preview-20261104/inputs-r3.json`，SHA `1bc57d7deb1d841a5bca499caf41ab42f8e0dc9cee6ea85f88aa1294eb311ed6`：143 个选定源码及其副本、7 个可执行镜像。r1/r2 保留；r3补入先前清单遗漏的 CSS、HTML、settlement 静态资源和两个 tsconfig，不覆盖旧清单。最终真实测试的 `started-inputs.json` 也单独记录了实际 CSS、浏览器脚本和运行镜像。

- JSONL 沿用上一点的 `0275185113786a971fad17307c4cefcd0de4d2c0666bcb857d9cc20b2e26a344`，不可变副本在 `work/desk-images-20261104/runtime-final/`。
- Node `reach.exe`：`69b14cfebbff4dd63fe755bd870afe5d83e469fb25f5eb260a432c5dc4231727`。
- release `reach-desktop.exe`：`0ea7c0b2c6117b04163614010771d1b1532f7b8dc49fa47af8dda5dc7778eea2`。
- Python 使用 `work/portable-runtime-r4/python/python.exe`；这次核镜像，不声称重新打包或逐文件验证第三方 Python 整树。

没有改 Rust 源码、锁文件或依赖，没有重建或重发安装候选。原 26d9、2f858 侧车及各旧 Task 的原镜像继续保留，旧关闭意图不改。

实际桌面流程需要工具 schema、描述和多条收据，本地默认 32768 上下文不足。本轮新增构造参数 `developmentContextWindow`：只有显式 loopback 可声明，安全整数 32768–131072，默认保持 32768；max_tokens 仍 8192，图片硬限额不变，声明进入 routeHash。最终夹具显式声明 131072，不加 CLI/env 开关，不覆盖生产模型 catalog。默认 32k 的完整桌面流程没有因此通过验收。

## 运行结果

命令在 `apps/reach/` 执行；Windows Bun 安装生成的类型检查入口为 `node_modules/.bin/tsc.exe`。

| 检查 | 实际结果与日志 | 版本边界 |
|---|---|---|
| `tsc.exe --project platform/tsconfig.web.json` 与 `tsc.exe --project platform/tsconfig.json --noEmit` | 最终通过，无输出 | 包含最终 UI、上下文配置及两个新测试 |
| `node --test --test-concurrency=1 platform/tests/image-preview.test.ts` | 最终 3/3，13.194s；`work/desk-image-preview-r4.log` | 登录/账户/消息/call 隔离；缓存/proof/intent/manifest 损坏及大文件；解绑/重配、unknown 兄弟调用；routeHash 改变拒绝原会话，零新消息 |
| `node --test --test-concurrency=1 platform/tests/device-tools.test.ts platform/tests/default.test.ts` | 7/7，24.249s；`work/desk-preview-policy.log` | 在新增上下文参数之前运行；调用核验和默认不加载 Desk 的代码没有后续语义变化 |
| `node --test --test-concurrency=1 platform/tests/web.browser.test.ts` | 8/8，136.889s；`work/desk-preview-browser-regression.log` | 在上下文参数及最终窄屏 CSS 修复之前；不是最终源码重跑的 8 组证据 |
| `node --test --test-concurrency=1 platform/tests/desktop-image.integration.test.ts` | 最终 1/1，38.737s；`work/desk-desktop-image-r8.log` | 实际 Node/desktop/共享侧车/Chrome，最终截图与竞态流程 |

真实流程使用 Node 24.21.0、本机 Chrome、Playwright Core 1.64.1。通过环境变量固定 JSONL、Node、release helper、便携 Python 和 Playwright 路径，所有模型请求仅发往 127.0.0.1；预算为最多 8 次模型调用、150 秒。浏览器测试也拦截外部网络请求。

最终根目录：`work/desk-desktop-image-96d69628-0abd-423c-9fe6-9425f7f63363`。

- 5 次实际模型请求、4 次设备工具调用、2 个原设备 operation：describe 加一次 Screenshot。
- Screenshot operation `9af7d38c-c856-4d4b-aaf8-92f633ec5283`，产物 `53bec236-0d57-4102-9769-f7f7761508f2`。
- 原 PNG 9145 字节，656×359，SHA `2bae7a5601ab673c12f2cfd5f8839119cf293ad3e65bc948bd00a9f5f2e47ca2`。
- Node outbox、服务原账本、Task evidence 缓存、provider 实际 `image_url` 块、Chrome 下载原件均核为同字节；共享 `run-1-tool-images.json` 也绑定该摘要。三处实测颜色像素通过，随机码未交给真实模型识别。
- provider 最终回答尚未释放时，持久 `device_image` 已到浏览器并可预览。刷新后来源恢复，未点击前不读取 PNG；失败重试、下载与刷新不增加 operation 或 provider 调用。
- 503 保留来源并可重读；改写响应字节被浏览器 SHA 拒绝，未生成可下载 blob。
- 响应体、哈希、解码各阶段等待后切换会话，旧图片未装载；解码阶段产生的 blob 已回收。哈希/解码挂起后触发原计时器回调，按钮恢复可重试，原件不变。迟到 401 没有清空新登录。
- 窄屏 viewport/scrollWidth 均为 390；无 pageerror。截图为 `preview-desktop.png`、`preview-mobile.png`，原件与下载为 `original.png`、`downloaded.png`。
- Node PID 6264、窗口 PID 10904 正常退出 0；helper PID 21240 已核退出，`processes.json` 无清理异常。

收尾另从 8 轮各自原账本和进程记录取得 22 个已知 PID，`work/desk-preview-20261104/process-postflight.json` 显示全部已不在，包括 r5 原 describe 中补取得的 helper25068。这是后续退出观察，未改写 r5 当时缺 PID 的旧记录。

`asserted.json` 是可读摘要，主代理另回查 provider JSON、原账本/Task 及实际 PNG，不能仅靠该摘要算验收。

## 保留的失败与限制

1. API 首批 1/2：夹具重新配对缺原凭据；修正夹具、结算其模拟 unknown 后复测通过。后续上下文测试首批 2/3：不存在的假二进制在容量预检先触发 500；改用只哈希不执行的本机 Node 镜像后，真实路由冲突返回 409、零新消息。
2. 桌面 first：Windows 不授予前台焦点；未执行截图。后续保留 foreground 遥测，窗口 TopMost 可见，使用真实像素作为内容准入。
3. r2：12 秒浏览器等待先超时，describe 被取消，未知效果保留。r3：两个实际操作成功，但 32768 声明的文字预算阻止下一模型请求，原 Task/fence 保留。
4. r4/r5：分别在第三/第二模型请求出现本地发送阶段 transport error，provider 无新连接/HTTP 解析错误，根因未定。r6 起受控 provider 显式 `Connection: close`，每次请求独立连接，没有添加自动重试。此项不证明生产连接复用缺陷已解决。r5 的旧 `helperExited:true` 没有 PID，不能当作退出核验；最终测试有实际 PID 证据，夹具也已改为缺 PID 时读本次原 describe，仍无 PID 则记录 null。
5. r6/r7：原图链及下载已通过，窄屏仍 541px；第一次仅约束图片网格不足，随后在独立 DOM 布局诊断确认 workspace 隐式列，补工作区列约束后 r8 为 390px。
6. 早期 Windows 类型检查命令误用 `.cmd`；实际 Bun shim 为 `.exe`。后续增加网络诊断时 `clientError` 的 Duplex 类型缺 bytesRead/bytesWritten，改为明确 Socket 类型后最终检查通过。

全部失败日志、原 operation、Task 与 fence 保留，没有清理或重放旧动作。测试新一轮使用新的隔离服务和窗口。真实视觉模型、组织路由、现场 Agent 委托 R01–R07、旧平台历史完整迁移、跨物理机器、SYSTEM/锁屏/UAC/安装升级卸载、Ray 部署仍未验收；现有安装候选不因本轮代码自动更新。

主代理已运行 `work/desk-preview-20261104/check.mjs`，重新读取143当前源/副本、7镜像、r8启动项、原SQLite/分块/PNG、实际请求、原生proof和退出PID；全部通过。基础清单 `checked-inputs.json` SHA `623a4d90dc01162ce8911be690a3906559b0909fefae3e1ed01bc1507516bfcd`。

独立 reviewer `/root/reach_plan_review` 接受这个限定的本地执行点，范围内没有剩余确认阻断。最终报告 `work/desk-preview-independent-review-20261104.md` SHA `2988c57eb6340a2d2a5884b41e1e259a8a470b47ec010d2c9eadfc2cc4b41e81`；独立原件检查 JSON SHA `25ce8208eb04f13586e8eaeeeeff22b83caf4c1598a971a565d4237e7a7280bd`。主代理完整回读并核正报告任务标识，原 Task 为 `671ad6d4-de6a-43e7-8246-21f39d1c59f7`，原生 stop 为 AwaitingHostAcceptance、task_accepted=false。143文件是哈希覆盖，本轮语义复核针对新增读取/图片UI/调用校验及其调用方；独立复核的3个稳定引用是所选图片缓存、该图片调用proof、对应intent，没有声称重新检查四回执全部8份proof/intent。

主代理回查最终报告、独立JSON、补充退出观察后再次运行原件checker。最终 `work/desk-preview-20261104/checked-final.json` SHA `19c5213edfd5d3e6dc644c81be7e3b0e85a6c4abd49e7169d54a253e46e7837a` 绑定报告、冻结、各层日志和检查脚本。引用该清单的文档不放回摘要，避免循环证明。

6份相关文档110条本地链接通过，`git diff --check`通过（既有CRLF提示保留）；选定10源文件无行尾空白。`python scripts/verify_bootstrap.py`仍以234项既有断链退出1，见`work/desk-preview-bootstrap.log`，没有把全仓检查报绿。humanizer不可用，本轮人工审读。没有重跑无变化的Cargo大矩阵或依赖审计，不将上一点的Core全量失败抹去。
