# 完整安装候选执行点的最终独立核验

作者：Ray Zhang（Ray）。日期：2026-11-03（Asia/Hong_Kong）。
独立复核：Codex `/root/reach_plan_review`；构建与实际验证执行：`/root`。

## 接受结论

**接受本执行点的固定完整载荷候选、词范围循环修复和明确限定的验证证据；没有发现本次证据清单漂移或候选身份不一致。** 这不是 Reach 整体完成、正式发行或实际系统安装验收。基础任务仍为 0/52，Reach Desk 仍为 0/5；卸载器和真实 UAC/SCM/SYSTEM/WTS、机器 PATH、升级恢复、重装及干净机等验收继续开放。

本次只读核对文件字节、SHA256、ZIP 结构/关键角色内容、EXE 中内嵌 ZIP、既有日志和主报告；没有执行候选程序、安装、Cargo、测试、桌面动作、提权或 ACL 修改。只新增本报告，没有改动清单覆盖的三份既有独立 review。

## 374 项证据清单

固定 [full-installer-runtime-20261103.json](full-installer-runtime-20261103.json) 的 SHA256 为：

`1369e4cf964704da49d9e9b488269050e6fda3f35eb2eb8fb2d45e50096b899c`

独立逐项读取所有实际文件并重新计算大小和 SHA256：**374 项、374 个大小写无重复路径、总计 160,556,509 字节；0 缺失、0 大小不符、0 摘要不符**。该清单固定的是本执行点的源码、制品和证据集合，不是每个完整嵌套运行时文件都另占一条的 374 文件产品清单。

三份既有 review 的实际摘要与清单完全一致，保持原字节：

| 文件 | SHA256 |
|---|---|
| [full-installer-implementation-review-20261103.md](full-installer-implementation-review-20261103.md) | `c5c1b6ea82859c09a95b334536b114571bdb8f99f39f6524ea38a15aaf3c2b2f` |
| [portable-native-source-review-20261103.md](portable-native-source-review-20261103.md) | `b2ca94027d40b3ab80ea0b0de1adfd37a89f8522135f75e7140125ab2f33f055` |
| [snapshot-word-range-review-20261103.md](snapshot-word-range-review-20261103.md) | `59ad874cfba65c7f928cc29289c638122b7dc5d883364d651a09e37a3491559d` |

主报告 [full-installer-runtime-20261103.md](full-installer-runtime-20261103.md) 在本轮另行固定：8,627 字节，SHA256 `5ba35c5be4e42f765a760fba3d3ab862be8667f552c657fb91137a4a3e51a0e8`。它没有列入上述 374 项，本报告没有假称清单包含主报告或包含自身。

## 最终 fe15 候选身份

候选路径：`outputs/windows-complete-b09eac1c3c349acd/Reach-Setup-0.1.0-preview-fe1506344bd265a1.exe`。

| 实际对象 | 字节 / SHA256 |
|---|---|
| 安装器 EXE | 75,332,608 / `fe1506344bd265a19fb490df1b42587d5dfe7920e198d2a39a4072c1dc59b238` |
| 完整 payload ZIP | 69,880,158 / `b09eac1c3c349acd54410d31f51964f32c9fcd45c3b4383d0db4353aa425a455` |
| ZIP 内 `payload-manifest.json` | `2bff6d96c13e1959ce29998ae66cb7d4b6ef97c6e8def9e588a43f504b5f3806` |
| ZIP 内 `reach.exe` | 6,111,744 / `5029a53f90e50384c41165e72436185f6834b29bcb116c9ea8d04b4034703dc7` |
| ZIP 内 `desktop/reach-desktop.exe` | 5,202,944 / `0ea7c0b2c6117b04163614010771d1b1532f7b8dc49fa47af8dda5dc7778eea2` |
| ZIP 内运行时 `reach-provenance/files.json` | 951,705 / `6cecc584a2c8cb755c277bf8a0a6be4c08403898525d7ef41fb477083ef5af0a` |

对最终 EXE 作只读内存映射，定位 ZIP 起始偏移 **270,512**，独立计算其连续 **69,880,158** 字节 SHA256，结果仍为上述 `b09eac…`。因此当前 EXE 的实际内嵌 ZIP 与独立包、构建收据及 inspect 记录一致，不仅核对了文件名。

独立读取 ZIP 目录和内部清单：实际 6,328 条目、无重复名；集合恰为清单列出的 6,327 个载荷文件加清单自身，载荷清单合计 190,316,383 展开字节。上述 Node/helper/运行时清单及 `desktop-runtime.json` 已直接从 ZIP 读取并重算摘要，与内部清单相符。配置仅为三个包内相对路径：

```json
{"helper":"desktop/reach-desktop.exe","python":"desktop/python/python.exe","config":"desktop/config.toml"}
```

本轮没有重复主实现已经执行的 6,321 个运行时文件和 6,327 个 ZIP 文件的全量逐项校验；核对的是固定整体 ZIP 摘要、嵌套清单身份、条目集合/尺寸及关键角色内容。主实现该全量验证与真实 `--verify-payload` 的边界在主报告中保持明确。

## inspect / verify 与执行证据的准确范围

输出目录中现存文件都包含在 374 项重新计算通过的集合内：

| 文件 | SHA256 |
|---|---|
| `package.json` | `2e02ad47bf2249755a6cd22d77bf0b3b4bc0757287fb7dcef5b64dc17f6842cb` |
| `inspect.txt` | `9640a886123c4af8bae8e5efc6349b19560e5f45519655bc223973f067ef93ea` |
| `verify-payload.txt` | `2f5112ece18734131ccdc04402e464d5679495543a9e1e1c8ac12c1b62fae6f2` |

`package.json` 和 inspect 的脚本/检查脚本/notice/Node/ZIP/内部清单摘要一致；实际脚本和 ZIP 的重新计算也一致。verify 原始输出为 `verified_files=6327; bytes=190316383; powershell=5.1.26100.9711`。复核已读取构建配方：它直接执行构建出的固定候选 `--inspect`、`--verify-payload`，检查退出结果和摘要后写入这些文件。本轮只读这些现存结果，没有再启动候选。`package.json` 明确 `codeSigned=false`、`installationTested=false`。

主报告正确区分了：16 项真实 ZIP/stream 机制、22 项使用 SCM/进程/ACL 适配的事务函数、4 项普通文件系统暂存；setup 的 Clippy/1 项私有 stdin 测试/deny 等构建检查；7 项实际 Python 模块加 Range 适配测试；以及 6 项真实 helper 桌面回归。适配测试没有被写成生产安装或真实 UIA 全覆盖。旧 r2 Snapshot 超时和 word-range 测试 r1 夹具错误均保留，不把后续通过改写成一次全过。

本次回读 r4 relocation 记录，确认其目录为 `work/portable-r4 中文 只读/python`，明确记录 python.exe 写入、COM wrapper 文件写入与创建缓存均被拒绝，测试结束后恢复；`process-check.json` 记录 remainingHelpers=0。此前独立复核已读两次真实 Snapshot 的不完整提示、输入后的完整中文值、fixture 的 clicks=1 和 11 份 `processTreeEmpty=true` 结算。本轮这些证据和 `after.png` 的实际 SHA256 均通过 374 项检查。图片视觉检查由主实现完成，本次不冒称又进行了独立视觉审查。

图标证据 `full-installer-icons-r4.json` 的实际 SHA256 为 `ca0d336cf839d67ad17ba2dc36c5770f3ac05ae83de1c51bea23317a7307aa82`。其中三个 EXE 身份对应本轮核定的 Node/helper/setup；三个各 10 帧表一致，共 30 帧。本轮回读并核对该清单，没有重跑主实现的 PE 图标资源提取，也不以清单替代原资源提取记录。

## 尚未接受的交付项

主报告将以下边界保持为开放，准确且应继续保留：独立卸载、自身文件删除交接、中断恢复；真实 UAC/SCM/SYSTEM/WTS、生产 ACL 与机器 PATH；实际配对、升级/回滚/卸载/重装及干净机；完整 artifact、实际 Codex MCP、Lite/Harness、Reach Desk 接线和 Ray 最终部署。

当前 `word_geometry_incomplete` 证明已识别并处理实际回退循环，不意味着任意 UIA provider 的单次 COM 调用永不阻塞，也没有新增任意长文本的时间预算。现有 60 秒外层失败边界和进程树回收继续承担相应限制。

本报告只接受上述固定摘要对应的本执行点。后续修改源码、补丁、运行时或安装包都需建立新的证据对应关系；不得复用 fe15 或本报告去宣称不同制品、卸载或正式系统安装已经通过。
