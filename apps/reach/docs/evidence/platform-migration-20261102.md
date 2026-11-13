# Reach Desk 定名与平台源码迁入

作者：Ray Zhang（Ray）。日期：2026-11-02。范围：X01 的源码归属、兼容构建和独立状态启动；不是 X01–X05 的完整验收。

用户确认名称 **Reach Desk**，并要求平台迁入 Reach 内部，不再在旧项目维护。当前维护入口为 [platform/](../../platform/README.md)，程序名 `reach-desk`；默认 Reach 构建、安装和服务入口不加载该子项目。旧线上 HandWave 未停用，本轮没有部署、提交或推送。

## 来源与维护边界

- 固定来源：`https://gitee.com/rzjw/llm-im.git`，提交 `0b9cb7c3eabf1e4d82bfc1d6147786c2d883721c`。只读取该 Git 树，没有修改旧检出中的平台代码或 Ray SSO WIP。
- [平台清单](../../platform/source-manifest.json)：142 个来源文件，包含平台应用、原测试、普通 Web、稳定 Web 快照及许可证。原开发守则、README、两个旧打包脚本归档在 `provenance/`。
- [Ray 清单](../../platform/ray-source-manifest.json)：70 个界面、后端适配及其资产文件，保存在 `adapters/ray/_source/`，尚未提取 Host 接口或加入构建。
- 旧共享 Go 库只制备到忽略的 `work/shared-source/`，515 个文件；构建逐文件核对固定缓存，后续不可在缓存里开发。此兼容依赖不是已接通的 ARA Lite/Harness。
- MIT 原许可证与 `Copyright (c) 2026 老妖怪` 保留；旧内置入网凭据已移除，没有导入生产配置、身份、数据库或会话。

`source_sha256` 是固定 Git blob 的 SHA256。初次 `git archive` 受本机 CRLF 设置影响，其字节哈希保留为 `initial_archive_sha256`；`import_sha256` 保留首次导入快照。后续改名、格式化和状态隔离修复不覆写历史哈希，当前字节见 [最终源码快照](platform-migration-20261102/source-snapshot.json)。后续导出显式固定 LF。

## 实际修复与验证

独立复核者 `/root/reach_plan_review` 发现并复核关闭三项问题：状态路径无效时旧逻辑可能回落其他目录；完整缓存仍先访问 Git 远端；导出换行受主机配置影响。其逐项核验了 142＋70 个原始 Git blob 哈希、515 个共享文件、许可证、旧脚本归档及新增测试；最终复核未发现新的确定性缺陷。主任务执行验证如下：

| 检查 | 实际结果 | 证据 |
|---|---|---|
| `scripts/build.ps1` | 4 项来源制备测试、3 个 Go 包测试、Go vet、46 项 Web 测试通过，Windows 普通程序构建成功 | [构建日志](platform-migration-20261102/build-desk-windows.log) |
| 末次下载页页脚文字更新后 `build.ps1 -SkipTests` | Windows 程序重建成功；前一次 Go/Web 结果是相同逻辑源码，页脚文字变更单独重建与实测 | [末次构建](platform-migration-20261102/build-desk-final.log) |
| `scripts/smoke.py` | 最终 Windows 普通二进制 16 项检查通过；测试服务已停止 | [普通进程结果](platform-migration-20261102/ordinary-binary.json) |
| `build.ps1 -Target Linux -SkipTests` | Linux amd64 普通二进制交叉构建成功；尚未在 Linux 执行 | [Linux 构建](platform-migration-20261102/build-desk-linux.log) |
| 本地浏览器 | 隔离目录、环回地址、开发模式下实际打开页面，标题及左上品牌为 Reach Desk；没有配置模型或发送消息，预览服务已停止 | [截图](platform-migration-20261102/desk-local.png) |

普通进程检查覆盖无参数帮助、版本、拒绝 node/pair/approve/deny、缺失/相对/文件/不可创建状态目录、旧配置哨兵不变、真实健康响应、嵌入登录页品牌、未登录 API 拒绝及隔离进程停止。状态测试另覆盖启动后目录被文件替换，不会读取其他旧配置。运行变量为 `REACH_DESK_STATE_DIR`，必须显式给出可写绝对目录。

活动文档的名称、目录与维护归属已同步。来源文件、历史用户原话、兼容协议、存储键及旧下载命令中的 HandWave 保留其真实含义，没有将未迁移功能冒充新产品。文档验证见 [检查结果](platform-migration-20261102/document-check.json)：Reach 活动文档链接及 57 个唯一任务 ID 检查；全仓 bootstrap 仍失败，报告 38 项既有 Reach 外断链，Reach 断链为 0；`git diff --check` 通过。humanizer 不在已安装技能中，本轮人工审读，不声称执行了该工具。

## 尚未完成

Reach Desk 的统一身份、Reach 设备调用、云端 Lite/Harness Host、真实模型对话、旧历史迁移和 Ray 部署尚未完成。兼容程序仍带旧平台行为及测试材料，旧设备命令不从新 CLI 暴露；Ray 适配源码也尚未运行。基础 52 项与选装 5 项继续分别验收，本次不勾选 X01 或其他完整任务。
