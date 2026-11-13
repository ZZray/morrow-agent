# Windows 维护入口接续

作者：Ray Zhang（Ray）。日期：2026-11-03。

活跃目标仍是按完整任务清单实现首版并部署 Ray，未完成或暂停。分支 dev，大量 WIP 保留，本轮没有提交、推送、生产安装或线上修改。当前 cwd 可能是 Lumen，不套用其 TS-only 或分支约定。图标已完成并接入候选，不重新设计。用户未报告实际 UAC 安装结果，不重复请求同一次操作。

最新结果见[维护接线证据](../evidence/maintenance-integration-20261103.md)。候选：

`outputs/windows-complete-716a23ad70230a1c-93fe5dccdd7f/Reach-Setup-0.1.0-preview-83a2a8e840a43c36.exe`

EXE SHA `83a2a8e840a43c36a3662d02d0c53a473825bf14cde73c79c5d6a9a9f82a491d`。ZIP 与旧08a3候选相同，Node/helper/runtime未改；本轮新包包含统一安装/卸载入口、Windows Apps注册、保护脚本和prepared重装恢复。实际EXE私有stdin校验6327文件通过、十档图标原字节匹配；未签名、未安装。最后只读SCM查询RYReach absent。

核心源码：`install.ps1` 统一入口，新增 `maintenance-entry.ps1` 和 `uninstall-host.ps1`。安装/回滚同步注册、脚本和deployment recovery；下载Setup `--uninstall`不传载荷，落地脚本不带自身Base64。旧安装journal schema1/2兼容，新安装schema4；卸载schema3；record仍schema1/2、账本仍schema1。schema4/prepared必须先于清旧catalog和新stage落盘；恢复保留新stage归属和旧tombstone，避免卸载后重装中断无法再试。

执行：最终22组安装/卸载接线、16文件/PATH、40卸载状态机、22旧安装事务及C#编译；Setup fmt/clippy和2单测；独立bootstrap4、ACL6。真实文件/HKCU/原子写与SCM/Node/生产ACL适配的边界见证据。旧40最后一项最初误读新源码而失败；新增固定历史函数夹具，经独立AST逐字符核对后40项通过。所有原始失败保留。图标辅助读取脚本要pwsh7，首次用WinPS5的HashData失败不涉及产品。

最终18项固定清单 `docs/evidence/maintenance-integration-inputs-20261103-r2.json` SHA `b374152a9048109cd33d4dc620950ed6a8df99fa899d81eff45bc9c6f2a26be9`，快照 `work/maintenance-source-6921cecb3f8b477b95645bc72379a020`。初始17项快照另保留。独立复核复用 `/root/reach_plan_review`，不要新建代理重复同一审查。主代理已回核18项全部一致；生产源码冻结后没有更改。

[独立报告](../evidence/maintenance-integration-review-20261103.md)已完成，最终SHA `c77b94477f27471d3309bbb6fc016d03eda827617d55f50825821c5c7531666f`；主代理完整回读初稿并核对最终唯一覆盖标签修正。限定范围无新增确认阻断。当前没有在运行的Cargo或测试session；复核代理空闲。

下一步：真实UAC/SCM/SYSTEM/WTS、机器PATH、配对、升级/卸载/重装及干净机仍未验收。可继续不依赖用户安装的全文artifact、真实Codex MCP看图、Lite/Harness云端Host及Reach Desk装配；最终再部署Ray。最新线上固定记录仍为 `20261102-sso-stable-05d25e8c84eb`，本轮未改，部署前需重查实时状态。0/52、0/5不变。

一次一个Cargo；工具/缓存E:/usr，中间文件work，交付outputs。humanizer此前本机未找到，文档人工审读，不声称调用。没有相关memory用于本轮结论。
