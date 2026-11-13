# 完整 Windows 安装载荷实现复核

作者：Ray Zhang（Ray）。日期：2026-11-03（Asia/Hong_Kong）。
独立复核：Codex `/root/reach_plan_review`；主实现：`/root`。

## 本次结论

对下表固定六个实现文件和三个测试文件的只读复核，未发现可证实的新实现缺陷。已回读 16 项 ZIP 校验、22 项安装事务、4 项普通文件系统暂存的原始日志及对应测试本体，接受其**明确限定的机制证据**。复核者没有重新运行这些测试、Cargo、安装器、服务或实际桌面动作。

这不是完整安装或发行接受：SCM/UAC/SYSTEM、生产 ACL、真实升级/断电恢复、干净机和卸载仍未验收。主实现后续真实 r2 静态 helper 回归为 6 项中 5 过 1 败，Snapshot 在 60 秒超时，记录见 [实际失败日志](portable-r2-static-native.log)。该失败独立保留，不能由本报告的安装载荷机制结论覆盖。已构建的完整包暂不作为可安装验收制品。

此前接受的设计要求见 [完整安装设计复核](full-installer-design-review-20261103.md)；原生依赖和再发行条件见 [原生来源复核](portable-native-source-review-20261103.md)。

## 固定审查对象

下列摘要在本轮审读前后重算一致。行号和实现判断以此版本为准。

| 实现文件 | 字节 | SHA256 |
|---|---:|---|
| `packaging/windows/payload.ps1` | 10117 | `e157371a0ca649dd260a2cdaa3bb426db6eb35a35413a17941b79c7bcb51b57e` |
| `packaging/windows/build-payload.py` | 5794 | `0b4cca840a0ca62bb3919ae2cf983644c8e4809717eec167ed66ba5a7a02cccb` |
| `packaging/windows/install.ps1` | 29718 | `156157eb53206a01b4dd305966409fb6e0a725dc6daeaba00043723c510e4284` |
| `packaging/windows/setup/src/main.rs` | 9702 | `f077e082abad1c5aa6848e863c9e478c1acf28b7ca7f22d5dafc2bf2624e28e8` |
| `packaging/windows/setup/build.rs` | 2416 | `409f97dfbd4e4352f91827d91f177f5e35dd5054dbf27b9ecb3e1b27483578a3` |
| `packaging/windows/build-complete.ps1` | 5175 | `2de4e0d2e1367241fea2af817146366f691a3a74a230de7239613934bc33539b` |

| 测试文件 | 字节 | SHA256 |
|---|---:|---|
| `tests/windows-payload.test.ps1` | 7297 | `43e2da32fd3efcd81784c5de45c5148996226065b1bb16ef61981194f3bfc189` |
| `tests/windows-installer.test.ps1` | 18776 | `d764516c6157778ef87787b5a709bac5b46948a79a0036954cc5cf52ecd0c12f` |
| `tests/windows-package-stage.test.ps1` | 3724 | `b045571e5cfc54b553190cb7e7fee8bf39e1295ac01cd6ddf22702c6376d549a` |

## 实现回查要点

1. ZIP 与逐文件清单是不同的摘要对象。`build-payload.py` 对固定 Node/helper/运行时清单及实际文件作校验，写入完整文件清单，再在 ZIP 写入时复查输入字节；收据分别记录 package、payload manifest、Node、helper、runtime manifest 摘要。相同 Node 而运行时不同会得到不同完整版本目录。
2. `payload.ps1` 在写入前检查数量和展开尺寸、Windows 相对路径、大小写别名、重复项、目录/文件冲突、特殊条目、实际展开字节及 SHA，校验角色摘要、必需组件和三个精确相对运行时路径。已安装目录验证检查每个路径、实际文件集合、清单字节摘要及所有文件摘要。
3. `StageCompletePayload` 在受保护的同卷 staging 完整写入并验证后发布目录；已有目标版本只允许完整一致时复用，不覆盖损坏内容。预检包括临时文件后缀。独立只读测量 r1d/r2 当前文件在默认 `C:/Program Files/RY/Reach/versions/0.1.0-<64位摘要>/desktop/python/` 下的最长正式路径为 218 字符，本轮实际文件没有触发当前长度拒绝条件。其他系统安装路径仍需各自实际验证。
4. 安装记录 schema 2 保留 `sha256` 的 Node 含义，新增整个包及清单身份。`ValidateManifestIdentity(target)` 与准备重新启动的 `ValidateManifest(previous)` 已分离：损坏候选不会仅因缺失运行时文件而阻断旧完整版本恢复；旧版本损坏时不能启动。实际 SCM 路径、进程身份、原始账本和未知/待确认结果仍有独立边界。
5. 保留原安装锁、maintenance ACK、原进程退出、`restored` 先持久化再重启、终态不重复回滚及 PATH 并发保护。保留绑定 owner 的文件位于 `%ProgramData%/RY/Reach.installation.json`，没有占用新空 ledger 目录；`pathOwnership` 可跨版本传递。顶层真实提权安装及该持久元数据的实际恢复还未由本批替身测试证明。
6. setup 继续从私有 stdin 向系统 Windows PowerShell 传递整段脚本。build.rs 跟踪包/摘要/检查脚本输入；`--inspect` 返回内嵌对象摘要；`--verify-payload` 通过同一传输解析实际完整 ZIP，不执行安装入口。构建收据明确 `installationTested=false`、`codeSigned=false`，不能把 inspect/verify 视为安装成功。
7. 本批实现没有卸载入口；当前支持的版本/schema 范围、完整安装、共享产品卸载和干净机接受均继续开放。

## 16 / 22 / 4 原始日志与准确覆盖

| 原始日志 | 结果 | 字节 | SHA256 |
|---|---|---:|---|
| [full-payload-tests-r3.log](full-payload-tests-r3.log) | 16 项，Windows PowerShell `5.1.26100.9711` | 872 | `16b20cd81a6fa669a24d6e970ac05c9eef167db1997540f918de03c6ea92a07a` |
| [full-installer-transaction-r2.log](full-installer-transaction-r2.log) | 22 项，明确 SCM/UAC/ACL 未执行 | 1659 | `4c751cb7f6481b299e018a360bb5f6be289d694573c393f31980d5cc31a7d27d` |
| [full-package-stage-r1.log](full-package-stage-r1.log) | 4 项，真实普通目录；生产 ACL/UAC 未执行 | 360 | `dc39b07f3ffb4cacc44c15e56e87fcd1c6de13fd0924e56ef768a26c888b5308` |

16 项使用真实 .NET ZIP/stream 对固定生产校验函数执行：正确包；内容/摘要/长度错误；额外/缺失文件；角色摘要；重复名/大小写；manifest 重复/大小写；文件目录冲突；Windows 路径别名/穿越/ADS/设备名；symlink/目录属性；schema/bool/字节数类型；运行时配置及未知字段；损坏 ZIP；流 underflow/overflow。夹具内 PE 内容是简化字节，不能用它证明真正 Node/helper/Python 能启动。

22 项从生产 AST 提取原函数，但用明确的 SCM/进程/ACL 适配替身和隔离 HKCU 注册表项，覆盖安装锁、PATH 类型/原文/并发恢复、维护 ACK 不确定、旧程序恢复及原运行状态、陌生服务拒绝、首次失败保留状态、journal 单次恢复、schema1/schema2 组合、相同 Node 不同整包、坏候选恢复、坏旧包拒绝、未知 schema/路径和文件集合损坏。日志自己明确这不是机器服务操作。本轮对日志和函数的回查不是重新执行。

4 项调用原 `StageCompletePayload` 和包验证函数，在 `work/stage-7c29170b` 的普通文件系统执行新目录发布、相同版本复用不改时间、损坏版本拒绝覆盖、过长路径在写入前拒绝；写文件和 ACL 由普通用户适配替代。不能推导生产受保护目录的 Owner/DACL 生效。

早期 [full-payload-tests-r1.log](full-payload-tests-r1.log) 在路径负面夹具构建阶段收到 .NET `CreateEntry` 的 `Illegal characters in path`，旧预期未接纳该错误，结果失败。后来测试同时直接检查生产路径函数，并接受 ZIP 层更早的路径拒绝；r3 的 16 项通过。旧失败保留，不称为全程一次通过。

## 附：构建中新增 Rust 许可来源的只读核对

随后针对 `packaging/windows/notices/sources.json` 的实际补充项核查：

- `eventsource-stream 0.2.3` 的原 crate `.cargo_vcs_info.json` 指向 `3d46f1c758f9ee4681e9da0427556d24c53f9c01`。固定 Git 归档 SHA256 `a0e3127364232a5a7037d1cc42b72515ae37575fac4d37e23fd5693dcfda6bfc` 确实没有 LICENSE/NOTICE 文件，原 Cargo.toml/README 均明确 `MIT OR Apache-2.0`。暂存两份源文件逐字节相同；选择 Apache 后附官方原文，独立读取官网得到 SHA256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`，与暂存相同。没有伪造 MIT 版权头。
- `jsonschema 0.18.3` 的原 crate VCS 信息指向 `11ebbaaececc1830f093dca229a28c0a5ebdf877`；固定归档 SHA256 `ceab1d355678192fe8d282587e6893cde479beea971ce9bfda954d0f25bdb71b`，根 LICENSE 与暂存逐字节一致。
- rpi-agent/rpi-ai/rpi-telemetry 的锁定 Git 来源为 `8ec462672d90e62712d96074638efef89436cebe`。独立从该 Git 对象读取根 LICENSE/NOTICE，与共享暂存字节一致，SHA 分别为 `0f4200057ab88da0fd0f73d48dea6f3e984b7fadf8aa441befbc578ad9ba13a4`、`374b7bec7bcc27136dc47528e98d3fe32599a97c5ab6768044ce61a32560505e`。

这些是新补充项的来源匹配结果，不是对整个 Rust 依赖集合的重新链接审计，也不意味着最终安装包已完成全部许可、运行与发行接受。
