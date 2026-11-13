# 完整 Windows 载荷与词坐标循环修复

作者：Ray Zhang（Ray）。日期：2026-11-03。

已生成包含 Node、静态桌面 helper、固定 Python、桌面后端及原文声明的完整载荷候选。安装器实际私有 stdin → Windows PowerShell 5.1 → ZIP 校验通过；普通用户的真实桌面 6 项通过。真实 UAC/SCM/SYSTEM/WTS、卸载与干净机仍未验收，基础清单保持 0/52、Reach Desk 0/5。未提交、推送、部署或安装。

## 固定候选

| 对象 | SHA256 |
|---|---|
| `outputs/windows-complete-b09eac1c3c349acd/Reach-Setup-0.1.0-preview-fe1506344bd265a1.exe` | `fe1506344bd265a19fb490df1b42587d5dfe7920e198d2a39a4072c1dc59b238` |
| 完整 ZIP | `b09eac1c3c349acd54410d31f51964f32c9fcd45c3b4383d0db4353aa425a455` |
| ZIP 内逐文件清单 | `2bff6d96c13e1959ce29998ae66cb7d4b6ef97c6e8def9e588a43f504b5f3806` |
| Node | `5029a53f90e50384c41165e72436185f6834b29bcb116c9ea8d04b4034703dc7` |
| 静态 release helper | `0ea7c0b2c6117b04163614010771d1b1532f7b8dc49fa47af8dda5dc7778eea2` |
| `work/portable-runtime-r4/python/reach-provenance/files.json` | `6cecc584a2c8cb755c277bf8a0a6be4c08403898525d7ef41fb477083ef5af0a` |
| Windows-MCP 补丁 | `27efa907ee475a4e4afc10df3729d060ec86dce2fede6cc19851f8bfbc3e765e` |

ZIP 为 69,880,158 字节，清单列出 6,327 个文件、190,316,383 个展开字节，另有清单自身。Python 运行时清单列出 6,321 个文件，另有清单自身。后端版本 `0.8.8+reach.4`；仍固定原上游 `94de2b4a5e1f2c52aad6003d5e60af28f57b8c8b`，未解锁升级依赖。安装器未签名，`installationTested=false`。

[本执行点证据清单](full-installer-runtime-20261103.json)固定 374 项当前来源、产物与原始结果，SHA256 `1369e4cf964704da49d9e9b488269050e6fda3f35eb2eb8fb2d45e50096b899c`。主代理另按运行时与 ZIP 清单重读了上述全部文件，不把仅有目录或摘要字段当成包完整性证明。

构建配方是 `packaging/windows/build-complete.ps1`。最终 buildDirectory 和全部组件摘要见输出目录的 `package.json`；`inspect.txt` 与 `verify-payload.txt` 来自实际候选执行。Node/helper/setup 的 30 个图标帧与原 ICO 字节相同，见 [图标资源清单](full-installer-icons-r4.json)。

## 安装事务的限定证据

完整版本目录以整个 ZIP 的 SHA 命名，安装记录 schema 2 保留 `sha256` 的 Node 含义，增加包和清单摘要；账本仍为 schema 1。生产 `desktop-runtime.json` 只有三个包内相对路径。先检查整个包，再于新目录写入、复核、同卷发布；相同包可以复用，损坏或多出文件则拒绝覆盖。

回滚将目标事务身份与可启动版本字节分开核验：坏候选不会阻止恢复完整旧包；坏旧包不会启动。恢复保留账本、unknown 和未上传收据。绑定 SID 及 Node installationId 由受保护的 `%ProgramData%/RY/Reach.installation.json` 保留，不在首次启动前污染空账本目录。PATH 添加归属随安装记录保留，卸载入口尚未实现。

已执行：

- [16 项真实 ZIP/stream 校验](full-payload-tests-r3.log)，含缺件、改字节、错误摘要/大小、大小写重复、路径穿越、设备名、链接属性、集合冲突和截断。Windows PowerShell 5.1.26100.9711。
- [22 项事务函数](full-installer-transaction-r2.log)，含 schema1/2 组合、仅运行时更新、坏候选/旧包、PATH 并发和 restored 恢复；SCM/ACL/进程均有明确替身，不是系统安装。
- [4 项真实普通目录暂存](full-package-stage-r1.log)，含原子发布、复用不改字节、拒绝损坏目录和写入前长度检查；ACL 使用普通用户适配。
- setup [Clippy](full-setup-clippy-r1.log)、[1/1 私有 stdin 单测](full-setup-tests-r1.log)、fmt 与 [deny](full-setup-deny-r2.log)通过。最终重新打包只更换 Python 载荷，Rust 源码未变；最终真实大小的 6,327 文件校验见 [构建日志](full-installer-build-r4.log)。

六个实现文件和上述 16/22/4 的限定范围已有[独立复核](full-installer-implementation-review-20261103.md)，没有据此接受完整安装。

## 原生组件与许可来源

四个未修改 VC DLL 固定来自 Microsoft 签名有效的 14.51.36247.0 redistributable；`extract-vc.ps1` 只展开固定 CAB，不执行安装。固定锁与真实提取见 `desktop/runtime/vc-runtime-lock.json` 和 [日志](portable-vc-extraction-r2.log)。CPython 原声明、11 份原生补充、cryptography 锁内 32 crates 的 62 份原文及 dnspython/fastmcp 原文已纳入新运行时。32 crates 包含构建依赖，不表示全部链接进 wheel。

完整 Rust 声明集合为 252 个可达包，包含构建依赖。eventsource-stream 固定源码没有 LICENSE/NOTICE，原 Cargo/README 提供 MIT OR Apache-2.0；选择 Apache 并保留官方条款和原始授权文字。jsonschema 及三个 rpi 包使用固定 Git 原文。没有伪造 MIT 版权头，也没有把 Microsoft DLL 标为 MIT。

来源与分发条件见[原生来源复核](portable-native-source-review-20261103.md)。有效 VS 许可及 Distributable List 是再发行依据，Runtime EULA 是安装使用条款；终端保护与发行条件仍应随正式交付落实。本地候选和来源核查不等于所有组织的许可资格或完整发行接受。

## 真实失败与修复

r2 候选的静态 helper 原生回归为 5/6，通过项和 [Snapshot 60 秒超时](portable-r2-static-native.log)都保留。直接 Python 诊断两次超时于 42 秒，第一次保留 15/30 秒堆栈；第二次每 100 步加全部异常步采样，至少观察到 62,000 次 Move，100 次返回 1 但 Start 实际回退，回退间隔 606 步。不能把已采样调用耗时说成所有调用均测量。

固定上游 `_iter_word_ranges` 只检查 Move 返回 0，导致 provider 循环时无界扫描。新补丁在 Move 前 Clone，保留返回 0 的正常结束；对负移动或 Start 未严格前进抛专用错误。Snapshot 丢弃该控件未完成的词几何，保留完整 value 和控件；node、TreeState、区域过滤及最终文本传播 `word_geometry_incomplete`。显式逐词调用仍报错，不伪装部分结果为完整。没有提高 60 秒超时、排除用户应用或增加权限开关。

[7 项候选实际模块测试](word-range-tests-r2.log)覆盖正常/多范围、正常 Move=0、回退、不动、负移动、空词循环、value/区域/响应标记。range 为测试适配，不能当作真实 UIA 覆盖。r1 测试构造 BoundingBox 时遗漏 width/height 的失败日志保留；修正只涉及测试数据。

r4 的[真实只读中文路径回归](portable-r4-static-native.log)为 6/6，60.619 秒，无跳过；同一静态 release helper。三种新进程导入顺序包括 Pythonwin/MAPI，六种 DLL 共 18 次实际加载路径/摘要验证、六次 COM 恢复通过。目录实际拒绝写文件和创建 COM 缓存，操作后所有包文件不变，最后 DACL 恢复完整通过。

[循环故障和固定 r4 的独立复核](snapshot-word-range-review-20261103.md)已读取候选五个变更源文件、7 项机制测试、两次真实带提示的快照、独立效果和进程结算；在该限定修复范围未发现可证实的新缺陷。

真实证据目录 `work/desktop-native-83478e11-137f-4824-855c-4e2105a92333`：输入与提交均为“Reach Desk 中文输入验证 你好世界”，clicks=1；主代理查看了 620×300 的 after.png。两次实际 Snapshot 均成功且确实含词坐标不完整提示，因此不是避开故障应用取得通过。11 个 helper generation 的 settlement 均 `processTreeEmpty=true`，随后也检查没有残留 helper。

r2 失败后目录 DACL 亦已恢复，原 ACE 字节和实际可写句柄检查在 `work/portable-r2-static-native/acl-after-native-failure.json`；没有用重启或删除失败记录替代回收证据。

## 保留与下一步

r1d/r2/r3 均保留原包。r3 是补齐全局提示之前的中间候选，未用它宣称真实测试通过；此前 r2 完整安装候选 aff5 不能代替本次修复版 fe15。变更前配方分别保存在 `work/pre-complete-installer-20261103` 和 `work/pre-word-range-repair`。旧证据 manifest 中的 live source 路径不会自动代表当前新源码。

尚须实现独立卸载、自身文件删除交接及中断恢复，再执行真实 UAC/SCM/SYSTEM/WTS、机器 PATH、配对、升级/卸载/重装和干净机。全文 artifact、实际 Codex MCP、Lite/Harness、Reach Desk 及 Ray 最终部署仍在完整任务清单内。本轮没有再次触发 UAC 或退出 Ray 登录。
