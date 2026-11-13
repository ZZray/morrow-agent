# 可搬运桌面运行时验证

作者：Ray Zhang（Ray）。日期：2026-11-03。

本点完成固定 CPython 嵌入包与 Windows-MCP 运行时的构建候选，验证搬到中文、空格路径、禁止写入包目录后仍能截图、输入中文、点击和结算后端进程。原始产物、源文件和 helper 固定在[194 项清单](portable-runtime-20261103.json)，SHA256 为 `8a0cc3ffa3699ff981afcf212309e89e29859469a1303f564f756326720c74f0`；[独立复核](portable-runtime-review-20261103.md)接受下述组合证据。它仍是开发候选：生产安装载荷、SYSTEM/WTS、完整原生依赖许可和干净机验收没有完成。

## 候选与来源

实际候选为 `work/portable-runtime-r1d/python`。官方 CPython 3.14.7 x64 embed ZIP SHA256 为 `d297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15`，python.exe 签名为 Valid/Python Software Foundation；未作完整 Sigstore 验签。Windows-MCP 固定来源 `94de2b4a5e1f2c52aad6003d5e60af28f57b8c8b`，补丁版本 `0.8.8+reach.3`，setuptools 84.2.1。原始来源 checkout 与开发 venv 未改动。

`desktop/runtime/prepare-portable.ps1` 验证 ZIP、补丁、锁文件和干净源码 revision；在全新目录从 git archive 应用补丁，锁定导出依赖并要求包哈希安装，生成 wheel。构建目录和交付目录分离，不覆盖旧候选。为避免在 ARA 内部临时目录执行 git apply 时被父仓路径前缀静默跳过，构建设置 Git discovery ceiling，并在应用后反向检查全部补丁。

候选包含 89 个 distribution；`reach-provenance/files.json` 为 6232 项、165622206 字节，SHA256 `6e32936b97cbff19753c58b6adc22ba4a4a7db668c9deaabb7f53fb2b976f89a`。加上清单自身共 6233 文件。独立复核重算全部文件、89 份 RECORD 的 6181 行和 138 份原许可，无内容/大小不符、包外路径、链接、pycache 或开发启动器。uv 的 `.lock` 在文件清单中，未冒充 distribution 文件。

`python314._pth` 只列包内路径，不启用 site。两个 pywin32 DLL 原字节复制到 python.exe 目录；comtypes 1.4.17 改为 `gen_dir=None` 并保留空的 gen 包，使 COM 包装器在进程内生成。修改后的 RECORD 有新的内容哈希；开发解释器启动器和本地 direct_url 被省略，其来源转存固定 revision/wheel 摘要。

构建内 `runtimeTested=false` 和 `licenseAuditComplete=false` 是构建时状态，未事后修改包内文件来覆盖它；后续运行证据由本文与独立 manifest 关联。

## 执行与失败保留

| 日志（本文同目录） | 结果 |
|---|---|
| `portable-runtime-r1-build.log` | 失败；PowerShell 单元素参数数组处理问题，未生成合格运行时 |
| `portable-runtime-r1b-build.log` | 失败；补丁被父仓路径跳过，未修改的 pyproject 与锁不符；没有解锁升级依赖 |
| `portable-runtime-r1c-build.log` | 主机重启前中断，日志为空；旧进程已不存在，目录保留 |
| `portable-runtime-r1d-build.log` | 成功；完整固定候选与上述清单生成 |
| `portable-runtime-r1d-imports.log` | 三种新进程导入顺序、两种 DLL 各三次真实路径/摘要核验、六次 COM 包装器损坏恢复通过 |
| `portable-runtime-r1d-relocation.log` | 只读搬运导入通过；wrapper 因 Set-Acl 恢复请求 SeSecurityPrivilege 失败，exit 1 |
| `portable-runtime-r1e-desktop.log` | 只读搬运导入和原生 6/6 通过；wrapper 同样在权限恢复失败，exit 1 |
| `portable-runtime-r1f-relocation.log` | 实际 DACL 已恢复；因多了 Windows 的 AI 控制标记，全 SDDL 字符串比较失败，exit 1 |
| `portable-runtime-r1g-relocation.log` | 最终夹具完整通过，exit 0；比较真实 ACE 二进制和继承保护状态，恢复成功 |

r1d/r1e 两个测试目录已用限定路径的 `icacls /reset` 恢复，随后实际打开原 python.exe 的写句柄核验，没有修改文件内容；恢复记录在各自 evidence 目录的 `acl-recovery.json`。r1f 的原始/恢复 SDDL 仅差 `SE_DACL_AUTO_INHERITED`，ACE 二进制相同且未保护继承。最终夹具只允许在新建、位于 Reach work 内、原本无显式规则的目录运行；包内写入确实被拒绝后才执行 Python。没有据前几轮 wrapper 失败宣称整批通过。

最终导入测试显式设置错误 PYTHONHOME/PYTHONPATH，确认 `-I -B` 保持无 site、无字节码、全包内 sys.path。三种导入顺序分别由 win32api、pythoncom、Windows-MCP UIA 起始；两种 DLL 的真实加载位置均在候选根，摘要匹配原 pywin32 目录。每次分别删除 UIAutomation/oleacc 的必需属性后调用上游 safe_get_module，均重新生成模块。临时锁位于该次外部 spool，包内全部文件前后完全一致。

## 真实桌面与 helper

helper 只新增 `-B` 和每代 `results/tmp/<helperGeneration>` 的 TEMP/TMP。创建目录发生在 start 与用户会话校验之后、启动后端之前；共享 MCP 适配的 envs 负责传入。`desktop/src/main.rs` SHA256 为 `052c39ab306efc9b0f7239d23b5373557036f7cb29e4f512be3576b05481a16b`。实际 debug helper SHA256 为 `6f6980acaae4aa431c783378964fcd605a0a5c87ef69c4042bf36b0aa6986560`。

fmt 通过；`portable-helper-build.log` 构建 44.30 秒，`portable-helper-clippy.log` 31.21 秒通过，`portable-helper-tests.log` 编译 9.76 秒后 Rust 4/4 通过。依赖锁未改变。该 helper 尚未重建为最终安装用的静态 release。

原生测试使用 `work/可搬运 真实桌面-r1e/python`，运行时处于真实只读 DACL 下。`tests/desktop.integration.test.ts` 共 6 项、60652.2588 ms，全通过；原始资料在 `work/desktop-native-ffc797b5-623c-4748-8e9b-43536aef4ae1`：

- 独立 WinForms 状态确认文本为“Reach Desk 中文输入验证 你好世界”，clicks=1，committed 与文本相同；前后原图均为 620×300。主代理与 reviewer 都查看了操作后原图，并核对原收据的 PNG/base64/尺寸/摘要。
- stop、EOF、worker-crash 均停止真实后端树，开始文件存在而 12 秒后的效果文件不存在；取消耗时分别为 2269、2064、114 ms。
- 捕获、参数、文件、Shell、注册表及滚动错误没有被报告为成功；部分执行的 Shell 文件恰为 `partial`。
- 11 个 helperGeneration 分别对应自己的临时 COM 锁目录、tools 身份和 `processTreeEmpty=true` 收尾。主代理结束后再次查实际进程，无本次 helper/Python 留存。

所有实际桌面操作后，再次核对 6233 文件集合及每项哈希未变。最终证据是 r1e 的原生 6 项通过加 r1g 的搬运/恢复闭环；没有重新跑一次原生 6 项，也没有把 r1e wrapper exit 1 改记成功。

## 许可与发行边界

原许可全文保留，但候选仍缺 dnspython 与 fastmcp-slim 的许可映射。后续已将两份补充材料放入 `desktop/runtime/notices/` 并记录来源/哈希，尚未加入 r1d 候选。dnspython 2.9.0 的锁定 sdist 实际也缺许可证；最终从上游固定 commit `dfc838e79425ced75b857a9e23132e506201e7b9` 的归档读取 LICENSE。fastmcp-slim 使用同版本锁定 fastmcp 4.1.3 wheel 的原 LICENSE。metadata 的 ISC/Apache 标识没有被当作许可全文。

还需闭合 CPython 与 cryptography 各自的 OpenSSL、其余实际原生库、Rust 依赖和微软运行库材料。Pillow/NumPy 的原复合许可保留，包括 GCC runtime exception，不能声称全 MIT。141 个 PE 的导入静态盘点发现附带 Pythonwin/MAPI 模块需要候选未包含的 `mfc140u.dll` / 通用 `msvcp140.dll`；当前 Windows-MCP 核心链路未使用这些模块，但本机系统已有 DLL，因此现有通过不能证明附带模块全已脱离系统 VC 运行库。

完整包及生产安装、SYSTEM/WTS、锁屏/UAC/用户切换、实际 Codex MCP 视觉接收、云端 Host 与 Reach Desk 尚未由本点验收。没有执行用户安装，也没有为本点触碰 Ray 登录或线上数据。
