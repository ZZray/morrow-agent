# Reach 便携桌面运行时：独立复核

日期：2026-11-03。作者：Ray Zhang（Ray）；独立复核代理：`/root/reach_plan_review`。

## 结论

接受下列有限范围的组合证据：固定 r1d 候选的包内文件与 RECORD 一致性、三种新进程导入顺序、COM 内存包装器故障恢复、迁入带中文和空格的路径并在实际只读 DACL 下运行，以及 r1e 真实桌面的 6 个原生测试。r1g 新鲜执行证明修正后的搬运夹具能够恢复原访问权限并以 0 退出。

这不是一次全部成功的 wrapper 运行：r1d、r1e 在最后恢复 ACL 时失败；r1f 已恢复实际 ACE，却被过严的原始 SDDL 字符串比较判失败。三次 wrapper 的 exit 1 均保留。r1e 的原生 6 项实际通过与该次 wrapper 失败同时成立；r1g 只重跑搬运、导入和恢复，没有重复原生 6 项。

本记录不批准完整发行。原许可缺件、原生库许可与附带模块 VC DLL 边界、干净机、实际安装/UAC/SYSTEM/SCM/WTS、新版 Ray 部署仍未由本点证据证明。配方中的 `licenseAuditComplete=false`、`runtimeTested=false` 是构建时状态，不能把后续部分验收外推为所有交付目标完成。

本代理没有运行构建、原生测试、安装、ACL 修改或桌面动作；独立工作为源码阅读、只读台账/JSON/PE/RECORD 分析、文件哈希重算、ACL 读取和图像目视核对。所有实际执行由主代理完成。

## 固定目标

| 对象 | SHA256 |
|---|---|
| r1d `python/reach-provenance/files.json` | `6e32936b97cbff19753c58b6adc22ba4a4a7db668c9deaabb7f53fb2b976f89a` |
| `desktop/runtime/prepare-portable.ps1` | `53469984390692827fb7b69a85fc90a7e446d238535a382ba800c42692e13b28` |
| `desktop/runtime/inventory-portable.py` | `63a93a76c28179cb5f493bbdfc58213a48f1ffab7835e3b1dbc496fe23ae450c` |
| `desktop/runtime/portable-lock.json` | `bbf8cf1e70871113290193865cf21c0754c7d4e3fdb59f6237b85897c4689d04` |
| `desktop/runtime/windows-mcp.patch` | `86e64b711fbdf539167e5293939e68a56b6aeba7027b498c721a1074ce57c8b2` |
| `desktop/runtime/uv.lock` | `82d284ca678f00e4a46189632ceedaf3ad5a6dee168b6a89180ece3eef808896` |
| `desktop/runtime/comtypes-memory.patch` | `e043bc9f02dca85b9fae1e5974ae4d62c1c801f04b3d829f028d041439972915` |
| r1d 构建 wheel `windows_mcp-0.8.8+reach.3-py3-none-any.whl` | `18a6363cf25366a8798d85611f035376236996551e46575e901a42facc1092b8` |
| `desktop/src/main.rs` | `052c39ab306efc9b0f7239d23b5373557036f7cb29e4f512be3576b05481a16b` |
| `E:/usr/var/cache/rust-target/reach-desktop/debug/reach-desktop.exe` | `6f6980acaae4aa431c783378964fcd605a0a5c87ef69c4042bf36b0aa6986560` |
| `tests/portable-runtime.test.py` | `05c2c33fb8710a91facbc4f42ec6a04b68f82e1472b198aeeb7fc8d98c702dd2` |
| `tests/desktop.integration.test.ts` | `2fe41ba24aecb07d24860d662e830597316733982c37b69aeabc4f0b6e30c0a3` |
| r1g 版 `tests/portable-runtime-relocation.ps1` | `7b36dfbf6c9a1a8bf78cdab693f5c02bae9d681996eeef938526d8f54315bee8` |

固定运行时目录为 `work/portable-runtime-r1d/python`。CPython 为 3.14.7 x64，官方 embedded ZIP 固定摘要 `d297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15`；Windows-MCP 固定源提交 `94de2b4a5e1f2c52aad6003d5e60af28f57b8c8b`，包版本 `0.8.8+reach.3`。以上不是对其他候选目录或后续许可补充版本的自动认可。

## 配方和文件一致性

`prepare-portable.ps1` 要求显式绝对路径、新目的目录、干净且恰为固定提交的源仓库；构建材料与成品目录分开。它核 embedded ZIP、Windows-MCP patch 和 uv.lock 摘要，依赖通过 `uv export --locked` 与 `uv pip install --require-hashes --link-mode copy` 安装。构建日志显示 backend patch 和 comtypes patch 均实际应用成功。

`ApplyContainedPatch` 在临时副本父目录设置 `GIT_CEILING_DIRECTORIES`，拒绝已有 GIT_DIR/GIT_WORK_TREE，执行正向 check、apply、反向 check，最终恢复原 ceiling。它解决候选嵌在 ARA 仓库里时 Git 意外按外层仓库解释路径的问题，未修改上游源 checkout。已读实际准备后的 pyproject 和包内文件，版本/依赖移除与 patch 相符。

独立重算 r1d 清单：6232 个唯一文件条目、总计 165622206 字节，无大小或 SHA256 不符。目录实际有 6233 个文件，唯一未被清单递归列入的是清单自身。没有符号链接、junction、pycache、开发解释器 launcher、direct_url.json 或 pyvenv.cfg。

89 份 distribution RECORD 共 6181 行均独立核对实际路径、内容摘要和尺寸；全部路径在候选目录内。89 个空 hash 行恰好为每个 RECORD 自身。comtypes 两个修改文件的新 RECORD 摘要正确，pywin32 两个 DLL 的根目录副本与 distribution 原件相同。唯一没有 distribution RECORD 归属的 site-packages 文件为 uv 的 `.lock`，它已在包级 files 清单中。

`python314._pth` 只列包内 stdlib ZIP、根目录、site-packages、win32、win32/lib 和 pythonwin，不启用 import site。保留的 138 个原 license/notice 文件均存在并与分发清单摘要一致；缺件仍恰为 dnspython、fastmcp-slim。NOTICE 汇总本身明确不是完整原生再分发许可审计。

## 新进程、DLL 与 COM 恢复

已阅读测试实现，逐份核 `work/portable-runtime-r1d-imports/imports-{0,1,2}.stdout` 与 `result.json`，stderr 均为空；复制版本 r1d/r1e/r1f/r1g 的相应原始输出也分别匹配各自汇总。

三种顺序分别先导入 win32api、先导入 pythoncom、先导入 windows_mcp.uia.core。每个进程实际断言 isolated/no-site/no-bytecode，污染的 PYTHONHOME/PYTHONPATH 不进入 sys.path。检查的是两种 DLL `pythoncom314.dll` 和 `pywintypes314.dll` × 三种顺序的 6 次实际加载核验，不是六种不同 DLL。GetModuleHandle/GetModuleFileName 返回候选根目录内的实际 DLL，哈希等于包内 pywin32_system32 原件：

- pythoncom314.dll：`4b22e2098ef244548f7d1b9723eb6d76d359d91ea52215bbef08c0e763a59043`。
- pywintypes314.dll：`e62808f40462f8066c8d19811cebd15467de6992b1cb48be5f5903910f5395f7`。

comtypes 1.4.17 的 client 改为 `gen_dir=None`；原 `_create_module` 的内存分支执行生成源码、登记 sys.modules 和 comtypes.gen 属性。包内 gen 只有 `__init__.py`。每个进程分别生成 UIAutomationCore/IUIAutomation 和 oleacc/IAccessible，再删除必要属性并调用 safe_get_module；返回不同的新模块且必要属性恢复，共六次真实恢复。

上游 safe_get_module 仍使用 TEMP 中的锁文件，并在恢复时清 sys.modules 和尝试清 gen 缓存。测试确认锁在单独 spool 下；实际 gen 只有被跳过的 `__init__.py`，两种恢复均未改变包内容。6233 个文件的集合与字节在这些运行前后保持一致。该证据覆盖故意删除必要属性的恢复场景，不外推到所有 COM 失败。

独立静态解析候选中 141 个 PE 的普通导入，共 82 个 DLL 名，无解析错误；本机可解析全部名称，但没有因此声称干净机完整闭合。附带 Pythonwin 的 dde/win32ui/win32uiole 和 Pythonwin.exe 依赖包内未携带的 mfc140u.dll；附带 MAPI 的 exchange/mapi 依赖通用 msvcp140.dll，本机 System32 提供它们。当前检查的 Windows-MCP、dxcam、comtypes、pyperclip 源码没有调用这些可选模块；Windows-MCP 使用 win32com.shell。延迟导入/动态 LoadLibrary 和全部附带模块并未由这项静态检查完全覆盖。

## Helper 临时目录变更

独立阅读 `desktop/src/main.rs` 及实际使用的 ara-agent-lite-mcp StdioLink：`-B` 与原 `-I` 并用；TEMP/TMP 覆盖为 `results/tmp/<helperGeneration>`。generation 为内部 UUID。创建目录在匹配 start 与当前 session 检查之后、McpSession::connect 之前；创建失败在后端启动前返回。StdioLink 使用 `.envs(env)`，因此该覆盖实际传给子进程；未要求修改共享 Core。

`portable-helper-build.log` 构建 44.30 秒；`portable-helper-clippy.log` 31.21 秒；`portable-helper-tests.log` 4/4。它们是主代理执行的构建/检查证据，本代理只核日志和目标哈希。

## 只读中文路径搬运及失败保留

运行时复制到带中文和空格的新目录，并施加实际 DACL：当前用户仅 ReadAndExecute，SYSTEM FullControl。夹具通过真实打开写句柄/新建文件尝试，证明 python.exe、comtypes/gen/__init__.py 和 gen 新文件创建被拒绝；没有只凭文件的只读属性作结论。

| 运行 | 已成功部分 | wrapper 结论 |
|---|---|---|
| `portable-runtime-r1d-relocation` | 三种导入、六次 DLL 核验/恢复；文件未变 | exit 1：Set-Acl 恢复需要 SeSecurityPrivilege；保留 `restoredAfterTest=false`，另有 icacls 恢复收据 |
| `portable-runtime-r1e-desktop` | 同上，另有原生 6/6 和操作后全包哈希检查 | exit 1：同一 ACL 恢复失败；`acl-recovery.json` 明确 nativePassed=6、wrapperExitCode=1、另行恢复 |
| `portable-runtime-r1f-relocation` | 导入/恢复通过，icacls 已恢复实际权限 | exit 1：原 SDDL D: 与恢复后 D:AI 的全字符串比较不等 |
| `portable-runtime-r1g-relocation` | 新鲜搬运、三种导入、六次 DLL 核验/恢复、拒写检查和自动恢复 | 主代理取得 exit 0；最终 `relocation-acl.json` 为 restoredAfterTest=true、desktopTested=false |

本代理对 r1d/r1e/r1f/r1g 各自运行目录重新计算全部清单字节及文件集合，均为原 `6e32936b…` 清单、6233 个文件、零不符；没有将 ACL 修复理解为包内容修复。

r1g 夹具只对全新、位于 work 内、原权限全部继承且未保护的目录操作，finally 使用 icacls /reset。新判定比较 RawSecurityDescriptor.DiscretionaryAcl 的实际二进制和继承保护状态，允许 Windows 重新计算时增加 SE_DACL_AUTO_INHERITED。独立读取 r1f 和 r1g 的实际 ACL 及各自留存的 original-access.sddl：两者均 ACE 二进制一致、Protected=false、显式规则 0，原始 SDDL 字符串不等；r1f 差异确为 DiscretionaryAclAutoInherited 标记。这支持夹具修正，不把 r1f 原失败改记成功。

最终 r1g 的目标为 `work/可搬运 权限核验-r1g/python`，实际桌面 r1e 的目标为 `work/可搬运 真实桌面-r1e/python`。旧失败与新鲜恢复是分开的证据来源。

## r1e 真实桌面 6 项和 11 代 spool

`portable-runtime-r1e-desktop.log`：6/6，0 skipped，60652.2588 ms。收据目录为 `work/desktop-native-ffc797b5-623c-4748-8e9b-43536aef4ae1`。

| 原生测试 | 独立核对 |
|---|---|
| 实际截图、中文输入、点击、身份检查与收尾 | Type/Click 成功收据；两份 stale_desktop_snapshot 拒绝；fixture/effects 均为指定中文文本且 clicks=1；前后图像与收据对应 |
| in-flight stop | began 存在，ended 不存在；unknown/desktop_stop_requested、effectsMayHaveOccurred=true；2269 ms 内收尾 |
| in-flight eof | began 存在，ended 不存在；unknown/desktop_parent_disconnected_or_invalid_frame；2064 ms 内收尾 |
| in-flight worker-crash | began 存在，ended 不存在；workerExitCode=1；114 ms 内收尾；不伪造该 worker 的成功操作收据 |
| capture 与 backend 参数失败 | 无效 capture 为 failed、无有效图片；缺失 Clipboard text 为 unknown/error；均退出 helper |
| file/shell/registry/scroll 实际失败 | write-directory、delete-missing、shell-partial、registry-missing、scroll-axis 均为 unknown/error；shell partial.txt 实际恰为 partial，没有把部分效果报成功 |

11 个 helper 为 interaction、stop、eof、worker-crash、capture-error、parameter-error、write-directory、delete-missing、shell-partial、registry-missing、scroll-axis。独立检查每个 tools.json 的 generation/session 与留存完整响应一致，每个目录恰有自己的 `tmp/<generation>/comtypes-gen-*.lock`；11 个 generation 全部唯一。所有 settlement 均为 desktop_host_exited/processTreeEmpty=true；worker-crash 为 exit 1，其余为 exit 0。这些结合原测试等待真实 host 退出的断言作为清理证据，没有用更晚的 PID 不存在替代原运行证明。

有图像的 12 份留存响应均独立解码 base64、核 PNG MIME、字节数、SHA256 和 PNG 实际宽高。主交互图像均为 620×300：

- before.png：10837 字节，`ff86f8d3eaefdef6da9d7eb585ac4eb3ac7296e395b486e3957e9618ebd2bc41`。
- after.png：16225 字节，`6c3f90da3866ba39389f97fa03106dbf7e44b847ee32b6dcad69759a3586c556`。

本代理已实际查看这两张图：初图输入框为空；后图输入框和 Committed 1 均显示 `Reach Desk 中文输入验证 你好世界`。effects.json 与独立 WinForms fixture.json 内容一致，clicks 恰为 1。错 generation/logon 两次拒绝有本次测试源码断言和通过日志，但没有单独落盘响应，因此不宣称独立读取过这两份未保存的原始响应。

## 最终 manifest、文档与补充许可材料

独立逐项重算 `docs/evidence/portable-runtime-20261103.json` 的 194 个文件：194 个唯一位置、合计 13989625 字节，无缺失、尺寸或 SHA256 不符。主清单自身 SHA256 为 `8a0cc3ffa3699ff981afcf212309e89e29859469a1303f564f756326720c74f0`；它通过固定 `6e32936b…` 包内清单关联 6233 个运行时文件，并分别记录 native 6/6、nativeWrapperExitCode=1、finalRelocationWrapperExitCode=0 和保留 r1d/r1e/r1f 失败。已阅读生成脚本，但没有执行写清单脚本。

人工审读 `docs/evidence/portable-runtime-20261103.md` 与 `docs/handoffs/2026-11-03-portable-runtime.md`，其便携候选范围、组合证据、三次 wrapper 失败、两种 DLL 的六次核验和未完成发行边界与独立复核一致。当前 ARA 分支为 dev，任务清单仍为基础 0/52、选装 0/5。新 Node-only package.json 的版本摘要与交接一致，desktopBundled/codeSigned/installationTested 均为 false；本次没有重新执行安装器或独立重查 Ray 线上状态，不能据文档审读扩大这些验收。

两份后续许可材料现已在 `desktop/runtime/notices/` 暂存，来源记录明确为 `staged-not-yet-bundled`，未修改固定 r1d 候选：

- dnspython 2.9.0：1526 字节，SHA256 `c3ea3ff5654b329c19d3bc5f7481af623c3dded4a6145585499f843ad3d741cd`。独立读取本地固定 commit 归档 `dnspython-dfc838e.tar.gz`，归档 SHA256 为 `daf10bef676e3c79593fc18b98e37f244f51ded60aef092aca48702b91e057d0`，其 `dnspython-dfc838e79425ced75b857a9e23132e506201e7b9/LICENSE` 与暂存文件逐字节一致，dns/version.py 对应 2.9.0 final。另查锁定 sdist（SHA256 `b44dc6b18f07a8b1c56676a19fbfdb5209415b046a9cece286baafa87ff3f7f1`）确无 LICENSE/NOTICE/COPYING 等文件，不能沿用“sdist 可补全文”的先前推断。
- fastmcp-slim 4.1.3：11356 字节，SHA256 `43070e2d4e532684de521b885f385d0841030efa2b1a20bafb76133a5e1379c1`，与已锁定安装的 fastmcp 4.1.3 原 LICENSE 摘要和字节一致。暂存不等于已纳入该候选的分发映射或最终许可闭合。

## 未闭合边界

- 138 个既有许可文件的保留不等于全部 native 组件的许可映射完成。dnspython 与 fastmcp-slim 的补充材料已取回并完成上述暂存来源核对，但尚未进入 r1d；候选内的许可映射缺件仍开放。不能从 METADATA、材料暂存或包名推定发行许可已闭合。
- Pythonwin/MAPI 附带模块的通用 VC DLL 依赖和原生分发授权需后续处理；当前核心真实桌面成功不等于全部附带模块在无 VC 运行库的干净机可用。
- 这次真实桌面使用 ordinary-user development helper，在当前交互 session 运行。没有验证实际安装、提权、安全桌面、多用户/WTS 切换、生产 SYSTEM/SCM 或远端 Ray 新版发布。
- 本点可作为便携核心链路与只读搬运候选的证据；最终发行与上述剩余边界保持开放。
