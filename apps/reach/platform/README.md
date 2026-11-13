# Reach Desk

作者：Ray Zhang（Ray）。这是 Reach 内部的云端平台子项目。用户已于 2026-11-02 确认正式名称 **Reach Desk**。

此处随 Reach 使用 Morrow Agent 父仓 Git，不建立嵌套仓库。旧 HandWave 和 ARA 仓库仅作为固定历史来源，不再回写。活动 SDK 路径已切为父仓 `morrow-agent-jsonl`；旧固定二进制证明与 Morrow inspection/close/图片协议的差异仍待逐项验收，见[迁移交接](../docs/handoffs/2026-11-13-morrow-subproject.md)。

## 新 Host 候选

`src/main.ts` 已作为 Reach + Reach Desk 的选装入口，通过共享 JSONL 侧车调用 Lite/Harness，原生 Session、聊天记录及取消状态分开保存。从本目录用 `node src/main.ts` 启动；部署方须提供 `REACH_DESK_STATE_DIR`（绝对路径）、`REACH_DESK_SIDECAR`（普通可执行文件绝对路径）、`REACH_DESK_ENDPOINT`、`REACH_DESK_MODEL`、`REACH_DESK_MODEL_TOKEN`，并沿用 Reach 服务配置。显式本地 Relay 另设 `REACH_DESK_LOOPBACK_RELAY=1`；凭据不写进源码、请求或日志。

接口位于 `/api/v1/desk/`，沿用 Reach 登录/CSRF。POST `conversations` 创建带客户端 UUID 的对话；POST `conversations/:id/messages` 提交 `{id,content,target?}` 并读取 SSE；`messages/:id` 查询原结果，`messages/:id/events?after=N` 恢复读取，POST `messages/:id/cancel` 请求取消。新聊天页在 `/desk/`，从 Reach 项目目录运行 `node_modules/.bin/tsc --project platform/tsconfig.web.json` 构建。

选择设备时填写该设备上的绝对工作目录。目标 `{nodeId,epoch,cwd}` 固定到消息，切换只影响下次发送。schema v3 增加原调用/操作映射，复用 Reach 原队列、配对和账本；云端不执行设备命令。文件、命令及原件分页已有本地验证；`reach_image`、消息来源卡片与认证原图 GET 已接通。本机实际截图到受控 provider 图片请求及 Chrome 预览/下载已核同字节，见[原图查看证据](../docs/evidence/desk-image-preview-20261104.md)。真实组织视觉模型、现场 Agent 委托和正式分发仍未完成。

消息原图由 `/api/v1/desk/messages/:id/images/:callKey` 按需读取；未点击前不加载 PNG，重试读取原产物，不重新截图。扩展沿用 Reach 登录，设备解绑或重配不删除原消息证据。开发构造参数 `developmentImageInput` 和 `developmentContextWindow` 仅用于显式 loopback 能力声明，后者默认 32768、可显式设置至 131072 并绑定 routeHash；生产继续从模型 catalog 解析能力，没有新增相应 CLI/env 覆盖。

Host 已接通锁内检查、持久化关闭意图和 Store 版本释放（v3 沿用 v2 三元组）：只对已复核 SHA 的普通侧车及明确的工具配置自动结算。纯云端核对原生引用、候选、摘要、完整事件和进程结束依据；设备配置还核完整原调用、operation 及收据，再关闭原 Task。原消息保持 cancelled，已有文字保留，同一 Session 可继续。管理命令按原 Informational 结果关闭，保留命令输出及非取消状态。缺少依据、旧 unknown、未支持的二进制或旧 cloud 状态继续 blocked，不创建新 Session 代替。见[纯云端证据](../docs/evidence/desk-host-settlement-20261103.md)和[设备接线证据](../docs/evidence/desk-devices-20261104.md)。

[共享 Core 只读状态检查](../docs/evidence/desk-inspect-20261103.md)报告原生事实，不自动声明结算；[Harness/JSONL/SDK](../docs/evidence/desk-wire-20261103.md)保持共享边界。Host 每次使用固定原二进制和声明，最多两次关闭尝试；重启先复核已保存的成功关闭链，再决定是否使用剩余次数。旧事件不能解新锁，同版本矛盾重新查询并保留草稿。关闭不接受业务 Task，也不回滚记忆采纳或其他已发生的效果。

[执行证据](../docs/evidence/desk-host-20261103.md)记录真实 Rust 进程与受控模型测试，以及两次真实模型超时。基础 `../src/service/main.ts` 不导入该候选，不要求模型配置。旧兼容平台和新 Host 不混同，当前未切换线上入口。

## 迁入与当前边界

- 平台应用、99 个 Go 文件（含原测试）、普通 Web 资源、稳定 Web 快照及许可证已从固定 Git 树迁入 `legacy/`。完整文件映射和原始/导入哈希见 `source-manifest.json`。原始哈希对应固定 Git blob；初次导入的 CRLF 变化另有记录，后续维护的当前哈希以验证快照为准。
- 原 Ray 网关中的平台 UI 与对应后端共 70 个文件迁入 `adapters/ray/_source/`，来源见 ray-source-manifest.json；它们等待 Host 接口提取，尚未加入构建，不能把普通 web 编译称为当前线上适配 UI 完成。
- 原始开发守则、README 和旧打包脚本保存在 `provenance/`，仅作历史参考。活动开发规则是本目录 AGENTS.md，构建入口是 scripts/build.ps1。
- 新的普通程序名为 `reach-desk`，无参数仅显示帮助；提供 `serve`/兼容别名 `hub`，不再提供旧 node、pair、approve 等设备命令。现场继续使用 Reach Node。
- 已移除旧源码中的内置入网凭据。没有导入配置、会话、设备身份、数据库或生产数据。运行必须显式设置独立、可写的绝对状态目录；目录无效直接失败，后续目录不可用也不回落旧 HandWave 状态。
- 目前仍是旧平台协议的兼容源码，不是已完成的 Reach 可选扩展。Reach 登录/设备调用和 Lite/Harness 替换按 X01–X05 继续实现；不能把迁入或编译通过当作接入完成。

默认 Reach 安装和部署不包含本目录的运行依赖或产物。旧线上平台目前未切换。

## 独立构建

需要 Go >=1.26.5、Python 3（只用于来源制备）及 Node（Web 合同测试）。在本目录执行：

```powershell
./scripts/build.ps1
./scripts/build.ps1 -Target Linux -SkipTests
```

共享 Go 库按 source.lock.json 固定 Git 提交制备到忽略的 `work/shared-source`，不把 Agent Core 复制到维护源码。首次制备可从远端获取；也可用 `-SourceRepository <已有Git检出>` 只读导出同一固定提交，构建不使用其工作区文件。已制备缓存先检查逐文件哈希，可离线使用；新导出固定 LF，不受主机 Git 换行设置影响。不能在缓存里修改实现。

构建使用迁入的普通 `legacy/web`。`legacy/release-web` 的历史稳定快照单独保留，不能静默覆盖普通源码；实际启用哪套页面须有对应视觉和认证验证。旧四平台 node/ctl 打包脚本不再作为本子项目发布入口。

## 隔离运行示意

显式设置 `REACH_DESK_STATE_DIR` 为新的绝对目录，再运行 `reach-desk serve` 并提供兼容 Hub 的所需配置。运行配置和凭据不得放在源码内，模型连接未配置时不能宣称对话可用。当前兼容入口尚未接入 Reach 身份，不能直接替换线上 `/reach/`。

最终产品合同见 [平台扩展设计](../docs/platform-extension.md)。旧 MIT 许可证保留在 `legacy/LICENSE`；其版权属于原作者，新迁入工具与文档署名 Ray Zhang。
