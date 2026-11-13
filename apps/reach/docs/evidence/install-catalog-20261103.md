# 安装归属、代次与原子写接入

作者：Ray Zhang（Ray）。日期：2026-11-03。状态：已接入实际安装源码并构建新候选；生产安装/卸载尚未验收。

本执行点接在[卸载机制](uninstaller-mechanisms-20261103.md)之后。新增 `ownership.ps1`、`maintenance-writes.ps1` 已由 Setup 嵌入，并被 `install.ps1` 的实际流程调用；不是仅存在于测试中的辅助模块。原卸载事务模块尚未接入生产入口，本次候选仍无可用 `--uninstall` 或 Windows 应用列表入口。

## 可检查的结果

新候选：`outputs/windows-complete-716a23ad70230a1c-ef23a1806457/Reach-Setup-0.1.0-preview-08a3b066680d4803.exe`。

| 内容 | SHA256 |
|---|---|
| EXE | `08a3b066680d4803ab45bfd9dedfa40e57a8d04d89f25ae803a4b74859cd2c4b` |
| 内嵌 ZIP | `716a23ad70230a1c4619b83c49569f69257f49ba58e31c6eeb0c0cdf7a82ac63` |
| 逐文件清单 | `2bff6d96c13e1959ce29998ae66cb7d4b6ef97c6e8def9e588a43f504b5f3806` |
| 构建来源集合 | `ef23a1806457331aaad77233b439764eb57d8014ab73349130afb648c27ed828` |

通过实际 EXE 的私有 stdin → 系统 Windows PowerShell 5.1 验证 6,327 个载荷文件、190,316,383 展开字节。封装 ZIP 为 68,738,709 字节，封装摘要与 fe15 旧候选不同；逐文件清单摘要相同。Node、helper、Python 和后端内容没有因本次安装器改造改变，不将旧桌面测试重复计作本轮执行。

Setup 的 `--inspect` 新增 ownership 和 maintenance-writes 摘要；构建脚本核对实际内嵌值，记录 12 个来源文件摘要并在结束时复核未改变。输出目录加入来源摘要，保留旧候选。主代理还用 LoadLibraryEx 的 DATAFILE/IMAGE_RESOURCE 模式只读提取新 EXE，10 档图标逐字节与原 ICO 相同，产品/作者属性通过，见 [资源收据](install-catalog-setup-resources.json)。

本机只读 SCM 查询结果为 `RYReach` 不存在。没有运行安装器的安装入口、UAC、真实 SCM 或机器 PATH 写入。候选未签名，`installationTested=false`、`codeSigned=false` 保留。

## 实际安装流程的改变

- 先取得数据父目录外部锁，再取得永久保留的 `install.lock`。两者均安全 CreateNew/独占打开，不通过会替换锁文件的普通写入函数创建。
- `deployment.json` 合并当前安装身份和明确文件归属。只从可信 current/previous/journal 记录及对应完整包清单导入，不扫描相似版本目录认领。坏历史候选的程序字节不必可执行，但完整清单本身仍须匹配安装记录摘要。
- 完整包和 Node-only 都先登记精确 stage/final 文件列表，再在随机 stage 用 CreateNew/Flush 写入；验证后同卷 Move。部分 stage 保留归属，后续尝试使用新的 stage，不把半个文件当正式版本。
- 每次成功部署产生新 generation，即使包和最终目录相同；SID、installationId 与原账本保留。回滚只恢复旧当前记录/代次，保留新候选和 partial stage 的归属，避免丢掉后续清理依据。首次启动已取得的 installationId 不因首次安装回滚清回空值。
- 新安装 journal 使用 schema4/operation=install，旧安装器拒绝该协议；schema1/2 历史安装可恢复/导入。当前安装记录摘要与 catalog 不符时拒绝继续，不默默采用旧 writer 或外部改写。
- 临时元数据文件仍使用随机 `.new-GUID`，但必须先向已持有的 `install.lock` 追加完整归属意图并 Flush，再 CreateNew。恢复只清明确登记的临时路径，不猜测旧后缀。所有登记临时文件确认不存在后，在同一锁内清空意图日志；它仅证明临时文件归属，不是第二个安装事务 journal。
- magic header 拒绝不明锁内容；未写完的尾部记录没有创建临时文件的授权。非法完整记录保持原样并报错，忙文件的归属不会提前丢弃。

## 验证与准确覆盖

| 组 | 实际结果与来源 | 边界 |
|---|---|---|
| 原安装事务 | [22/22](installer-catalog-transaction-r1.log) | 旧版本/完整包回滚回归，SCM/ACL 等适配 |
| 完整包 stage | [4/4](installer-catalog-stage-r2.log) | 实际目录、文件、CreateNew 和 Move；catalog 原子写在该组适配 |
| 原子写 | [10/10](maintenance-writes-r4.log) | 实际锁、FileStream、WriteThrough/Flush、Replace、失败残留/重启恢复；测试用户 ACL |
| 安装 catalog 主流程 | [8/8](install-catalog-r2.log) | 实际安装尾部、文件/锁/原子写/HKCU；SCM/进程/Node status/生产 ACL 适配 |
| 旧 Node 记录导入 | [2 项通过后另项失败的原日志](install-catalog-additional-r1.log) | 两项确实通过；后续完整夹具失败未抹掉 |
| 新完整载荷安装 | [1/1](install-catalog-complete-r2.log) | 修正长度守卫后执行完整包安装及同包新代次 |
| 旧完整载荷导入 | [1/1](install-catalog-legacy-complete-r1.log) | schema2 current 与损坏的 schema2 历史候选，两份可信 9 文件清单导入 |
| Setup | [clippy](install-catalog-setup-clippy.log)、[test 1/1](install-catalog-setup-test.log)、[deny](install-catalog-setup-deny-r2.log) | fmt 检查通过；普通私有传输测试，无安装提权 |
| 新 EXE | [构建及实际载荷验证](install-catalog-build-r1.log) | release 4.09 秒；完整载荷校验通过；非实际安装 |

catalog 共 **12 个不同测试组，按 8+2+1+1 执行**，不是最终测试文件一次全量运行。前 8 项的旧测试名 `first-install status failure` 实际注入 before-commit，最终仅将名称改正为 commit interruption。后来增加筛选参数、完整 ZIP 夹具分支和四个用例；不将其称为前 8 项全量重跑。

前 8 项执行时安装源码为 `7b82ba43b3cd335cd56e02967a6903fd65aabd2636d5dfceb9ae948fb5a48395`。最终 `f221fdc3…` 仅移除了完整包文件已不使用的临时名 37 字符余量，并更新注释；主代理和复核者均逆变换该精确差异，重新计算出完整旧摘要。Node-only 8 项相关代码未变。最终新完整包及 4 项 stage 在修正代码上重新执行。

独立复核读取测试源码、原输出与实际夹具，不把模拟的 `running=false` 当真实服务停止，不把标记字符串 `node.sqlite` 当 SQLite/outbox 结算。本测试阶段真实对象为普通文件、进程内锁句柄、.NET 原子替换和隔离 HKCU；断电/硬件持久性不由一次 Flush 调用证明。

## 保留的失败与修复

1. [原子写 r1](maintenance-writes-r1.log) 揭示真实 WinPS5 行为：`File.Replace(...,$null)` 把备份参数转为空字符串，报非法路径。改为 `[NullString]::Value` 后真实替换与占用失败恢复通过。原安装器先前适配测试没有暴露此问题，本次不把旧候选称为已完成实际安装。
2. 原子写 r2/r3 是测试夹具错误：Case 作用域重新赋锁对象、以及数组中未括起字符串相加。修正夹具后 r4 为 10/10；生产期望没有放宽。
3. 独立源码复核发现 Node-only 原先直写 final，在写到一半退出后会被完整摘要检查永久拒绝。改为与完整包一样的随机 stage；catalog 用例实际留下两字节文件后重试成功，残片仍有归属。
4. 完整包追加测试因深夹具路径加旧 `.new-GUID` 余量而失败。新 stage 直接写文件，因此改为检查实际 final 长度。当前系统默认 ProgramFiles 下真实 6,327 文件最长路径为 218 字符，保留 MAX_PATH 拒绝。
5. [deny 首次调用](install-catalog-setup-deny.log) 的 `--config` 参数位置错误，未执行审计；纠正为全局参数后 r2 advisories/bans/licenses/sources 均通过。仅有共用 policy 中本小依赖图未遇到部分许可的提示。

## 固定材料与未完成项

[29 项输入/输出清单](install-catalog-inputs-20261103.json) SHA256：`091fb4b723461f6c15fb4977d306c52ab0324a9843da1cc3dbbd50d2fc0f472a`。来源快照在 `work/install-catalog-snapshot-0a291496a0be4879a7a1a704b035a3d3`，其中历史安装器逆变换文件与旧摘要完全一致；最终 catalog 测试另存 `tests/windows-install-catalog-final.test.ps1`，SHA `65758c4ddee2bc0bf86b22ddf8299dbd79a2d8430220f95b372f65179f3e96d8`。

独立 [最终复核报告](install-catalog-review-20261103.md) 由 `/root/reach_plan_review` 完成，SHA256 `3defb85c61d734566c395037b0ac0563504a4e79c008d6d3380edb625f08dca9`。复核者核对 29 项实际摘要、12 个构建来源、真实夹具与两段可重算版本桥，并实际执行新候选 `--inspect`。主代理完整回读报告、核其摘要，并再次直接核对 29 项输入输出全部相符。只接受此固定安装机制范围，不用旧的 374 项完整候选清单或卸载纯机制报告代替本次新增代码的证据。

仍需实现：生产卸载 host 对 catalog/原记录的完整绑定、schema3 分派与卸载后重装、64 位 Uninstall 注册和受保护脚本的安装/回滚、系统 PS/UAC 入口及 Setup `--uninstall`。还需真实 UAC/SCM/SYSTEM/WTS、机器 PATH、配对、完整卸载/重装和干净机。其他清单及 Reach Desk/最终 Ray 部署继续开放，基础 0/52、扩展 0/5 不变。
