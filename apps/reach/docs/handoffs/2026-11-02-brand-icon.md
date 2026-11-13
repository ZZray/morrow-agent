# Reach 图标交付与接续

作者：Ray Zhang（Ray）。日期：2026-11-02。

用户对旧安装候选提出“你好歹设计一个现代化的图标”，本轮优先完成图标、三个 Windows 构建入口、管理页品牌和 favicon。独立复核已接受品牌资源接入，具体源码、二进制和检查见[证据](../evidence/brand-icon-20261102.md)。未执行安装/UAC、提交、推送或 Ray 部署。全清单 goal 保持 active。

新 Node-only 安装候选为 `outputs/windows-node-9b721f7cb798ab25/Reach-Node-Setup-0.1.0-preview-007487edce0403cb.exe`，含图标，仍不含桌面运行时。Node 静态 exe SHA256 为 `9b721f7cb798ab25dfe12181985f0fd94a6beb8f596789547b3fab64360549e6`；helper debug 为 `7d15891cbb38db621a5c8f9df03783d814455da119fa7856a382b50a235dafc6`。原 helper debug 和旧静态 Node 在 `work/brand-icon/` 保留副本；旧安装候选不变。Node 普通 debug 缓存未重建。

本轮 Node 静态版回归为26/27，失败项是大于2MiB输出分页；单项复测0/1、84.809秒，同样失败。实际进程 exitCode=0，但 worker 的绝对2秒读管道收尾截止把尚在发送输出的读取线程视作后代占用，返回 `descendant_kept_output_open`；这是待核实的源码原因，不能直接称已修。下一步保留失败证据，区分读取等待与向父进程发送中的背压，再设计修复及受影响验证。不要仅放大测试超时或将 unknown 改成 succeeded。当前没有运行中的构建或测试。

Node lock 重新解析后已按旧安装候选 inventory 恢复全部 Windows 可达 name/version，但与原 lock 仍差14字节，未证明全平台完全恢复。helper/setup 剥离新增 winresource 后与原锁精确相同。应继续处理 Node 锁差异；不要误报只加一个依赖且其余原字节未变。

便携运行时已开始探测，尚无正式配方：官方 CPython3.14.7 embed ZIP 保存在 `E:/usr/var/cache/reach/cpython-3.14.7-embed`，SHA256 `d297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15`，python.exe Authenticode为Valid/PSF；Sigstore元数据下载保留，但未作完整Sigstore验签。`work/portable-python-probe` 由该包解压、固定uv锁安装88依赖及reach.3 wheel组成，不是venv复制。

探测发现无site时win32api缺DLL；把原pywin32_system32的pythoncom314.dll/pywintypes314.dll同字节复制到python.exe目录后导入成功。探测还将comtypes1.4.17的gen_dir改为None并加空gen/__init__.py，UIAutomationCore/oleacc内存wrapper导入成功。上述改动只在ignored探测目录；独立设计复核认为可采用，但尚须固定setuptools84.2.1、保留补丁/manifest、三种导入顺序及DLL真实路径、损坏wrapper恢复、只读包和中文空格重定位、真实截图/输入/点击/清理。helper的Python参数尚未增加-B，TEMP/TMP尚未导向每代spool，不能把探测包用于生产。

许可继续保留真实边界：NumPy wheel含OpenBLAS/LAPACK及GPL-3.0-or-later WITH GCC-exception-3.1材料；Pillow复合notices不可丢；CPython的微软VC runtime、OpenSSL/SQLite/libtommath及cryptography原生依赖需要完整映射。随后继续完整包/安装、全文artifact、实际Codex MCP、Reach Desk云端Host和新版Ray；沿用[桌面管道交接](2026-11-02-desktop-pipe.md)。
