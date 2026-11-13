# 服务基础实现记录

作者：Ray Zhang（Ray）。日期：2026-11-02。范围：P1 服务端身份与持久投递原型。

## 执行版本

基线 `90f2b1cdd138129e2d331d89a37d70852e849739` 加当前 Reach 未提交工作区。Node v24.21.0，Windows。最终 10 个源码/配置文件的 SHA-256 见 [source-snapshot.json](service-foundation-20261102/source-snapshot.json)。

## 已运行

- `bun install`：退出 0，固定 Zod/TypeScript/Node 类型依赖及 bun.lock。
- `bun run check`：退出 0，TypeScript 无诊断。
- `bun run test`：退出 0，5 个测试通过、0 失败、0 skipped，10.481 秒。

以上为初次验证。独立审查修正未知结果对账和代理限流后，8 项测试通过；随后增加真实进程强杀/重启测试，9 项通过。依赖审计发现初始 Zod 4.1.12 的 GHSA-mrhx-c7xc-m3w5 高危公告，升级到 4.6.6 后在最终快照重跑：

| 最终检查 | 实际结果 |
|---|---|
| `bun run check` | 退出 0，见 [check.txt](service-foundation-20261102/check.txt) |
| `bun run test` | 9 passed、0 failed、0 skipped，18.652 秒，见 [tests.txt](service-foundation-20261102/tests.txt) |
| `bun audit --json` | 退出 0，输出 `{}`；只代表本次 Node 依赖公告扫描，没有替代完整发行许可证审计 |
| Reach Markdown 本地链接 | 57 条，0 断链；随后追加的本批证据链接另行复核 |
| `git diff --check` | 退出 0 |
| 根 `python scripts/verify_bootstrap.py` | 退出 1；38 处既有 Full/Lite/HandWave/历史 D 盘证据断链，本轮 Reach 文件无失败项 |

测试通过真实环回 HTTP 和临时 SQLite，覆盖：配对响应丢失后的原尝试重试；一次性码消费；同请求 ID 输入冲突；六个并发领取只有一个取得原操作；第二 SQLite 连接重开后不重新领取；过期派发保持 uncertain；有序事件、重复上传、内容改变、跳序、迟到 running；取消保持请求状态；解绑后拒新投递但接收原回执；跨账户查询、凭据种类与 CSRF 拒绝。

## 证据边界

当前测试中的 Node 是受控 HTTP 客户端，没有调用真实 Windows 工具。新增 process 测试实际启动普通 main.ts 入口，两次 SIGKILL 后重新启动同一数据目录，验证原会话、配对、已派发操作和最终结果，未发生重新派发。尚无 Rust Node、MCP 控制器、现场文件/进程效果、跨机链路、安装包、桌面、真实模型、管理界面或部署验收。因此不能勾选 C07 或其他完整清单项。

架构已由独立代理 `/root/reach_plan_review` 只读核对，主代理回查 HandWave identity/receipts、ara-lite-host journal 与最新视觉/TaskSet 文档。独立代码审查发现两项 P2（unknown 无结算出口、代理共享限流），均已修复并增加 HTTP 测试；复审无新增高置信缺陷。最后又单独复核实际进程测试、精确子进程清理、临时目录删除边界和 Zod 锁定。审查未冒充执行；实际结果由本页最终检查确认。

仓库要求的 humanizer 技能在项目、全局 skills、Lumen skills 和插件 SKILL.md 清单中未找到；本次使用人工文字审读，保留这个工具缺口，不声称执行过 humanizer。
