# 便携运行时原生来源与 VC 再发行复核

作者：Ray Zhang（Ray）。日期：2026-11-03（Asia/Hong_Kong）。
独立复核：Codex `/root/reach_plan_review`。主实现：`/root`。

## 结论与范围

本次核查接受下列**来源和原文匹配事实**：cryptography 固定 sdist 的完整 registry 锁集合为 32 个 crate，已暂存的 62 份许可原文与原始 crate 逐字节一致；CPython 原生组件的固定来源和补充声明已经取得；拟增加的四个 VC DLL 可以追溯到同一份 Microsoft 签名有效的 14.51.36247 安装包，其普通及延迟导入没有引入另外一个未打包的 VC DLL。

当前 r1d 不是许可已收口的最终发行包。其 `LICENSE.txt` 没有覆盖本报告列出的全部内嵌组件声明；新声明与 VC DLL 尚须由实现者接入新载荷，再核最终包清单。微软分发依据是有效 Visual Studio 许可及其 Distributable List，不能只引用 VC Runtime EULA 的安装使用权。

核查对象：`work/portable-runtime-r1d/python`、`desktop/runtime/notices/cryptography-rust`、`work/vc-redist-14.51.36247` 及固定上游归档。执行了只读归档检查、哈希比较、PE 普通/延迟导入解析、Authenticode 检查和 Windows Installer `OpenDatabase(path, 0)` 的 File 表读取。**未运行 Cargo、测试、候选 Python、安装器或 MSI；未提权、改 ACL、安装或部署。** 工作区仅新增本报告；下载和提取的公开来源/许可只放在获准缓存目录。

这份报告不接受干净机运行、SYSTEM/WTS、完整安装升级卸载或整个 Reach 首版。此前桌面和便携运行证据的边界仍见 [便携运行时独立复核](portable-runtime-review-20261103.md)。

## 1. 固定 CPython 与组件来源

本机缓存根目录为 `E:/usr/var/cache/reach/runtime-license-sources/`。

| 来源 | 固定身份 | 归档 SHA256 |
|---|---|---|
| CPython | `dccefbc14adf6cd13693f3b6b2802945c4e23e01`；缓存 `cpython-dccefbc.tar.gz` | `4fa7baa7777062f0508da83c4e5e8d206254990972640d005d5d9ea7f20e4403` |
| XZ 5.2.5 | cpython-source-deps `c6bc0c612605622aaef101a33a751f9de2ecc193` | `115433c946ee069e857fd04cf41b38a4a74ed45d868a3b2e08ccd4a1f04f39d0` |
| mpdecimal 4.0.0 | cpython-source-deps `48316ec025c1ebe500854c332be0a12c640c7301` | `2db089d12f3467f7ec6cc964e821faa18fb662c467b2fa713e32a39c374441e3` |
| zlib-ng 2.2.4 | cpython-source-deps `a502e047655c31db29601def76ad6539acacf43d` | `bdd663f25d83d29814bd903746392108b7bd5b880d101fc8a07aa3c12dd521f5` |
| Tcl 9.0.4.0 来源中的 LibTomMath | cpython-source-deps `53c758cbf2cc178b359abc03fdd912c5e66ed74f` | `2ec3a0db72d1eb15096940ce67e226bc16a0719e12e554c7feb920eb40bd6f36` |
| mimalloc v2.1.2 | microsoft/mimalloc `43ce4bd7fd34bcc730c1c7471c99995597415488` | `36b20d9bafd4d22260d5c14b8acd858d0ac9a090bf419e4aa7bc507043792d06` |
| HACL* | hacl-star/hacl-star `8ba599b2f6c9701b3dc961db895b0856a2210f76` | `0427f00ff20b6484e59725e2a7d098f075c6b51b671046cff0174bde7df8ecb5` |

四个 cpython-source-deps 缓存名为 `cpython-source-deps-<完整 commit>.tar.gz`；下载地址为 `https://codeload.github.com/python/cpython-source-deps/tar.gz/<完整 commit>`。mimalloc/HACL 缓存使用表中项目名加完整 commit。初次版本归档的 PAX `comment` 指向上述 commit，随后按完整 commit 再取归档并逐文件比较，四个 source-deps 和 mimalloc 的版本归档/commit 归档内容均一致。HACL 的 commit 直接来自固定 CPython `Modules/_hacl/refresh.sh` 的 `expected_hacl_star_rev`。

这些 source-deps commit 是本次对固定 CPython 引用的版本名进行的精确解析，**不把可移动的版本分支当作不可变证据，也不声称已获得 python.org 构建服务器的完整构建证明**。交付物应保存本报告的 commit/归档摘要及实际 Python ZIP 摘要。

实际官方嵌入 ZIP 在 `E:/usr/var/cache/reach/cpython-3.14.7-embed/python-3.14.7-embed-amd64.zip`，SHA256 为 `d297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15`，与 `portable-lock.json` 一致。候选内 `LICENSE.txt`、`libcrypto-3.dll`、`libssl-3.dll`、`libtommath.dll` 均与该 ZIP 原文件逐字节相同。

### 实际构建映射与已确认遗漏

固定 CPython `PCbuild/regen.targets:156–164` 的 Windows LICENSE 聚合输入仅包含 CPython LICENSE、`PC/crtlicense.txt`、bzip2、libffi、zstd、OpenSSL，以及有条件的 Tcl/Tk 声明。实际 r1d `LICENSE.txt` 为 35,407 字节，SHA256 `935cf13e19f8c31b497d20b05d73623431a226b230c3599bc30fa3348979bc68`，保留了这些原有文本，不能覆盖下列额外声明。

| 组件 | 当前源码/二进制依据 | 应带入新载荷的原文和准确边界 |
|---|---|---|
| Expat 2.8.2 | `Modules/expat/expat.h:1095–1097`；`PCbuild/pyexpat.vcxproj:104–107` 编译 vendored Expat | 原 `Modules/expat/COPYING`，MIT，含 1998–2000 与 2001–2025 两组版权；当前聚合 LICENSE 未包含 |
| mpdecimal 4.0.0 | `PCbuild/python.props`、`get_externals.bat`、`_decimal.vcxproj` 明确相应目录及编译单元 | 原 `COPYRIGHT.txt`，2008–2024 Stefan Krah，BSD-2-Clause 的二进制再发行保留要求；当前聚合 LICENSE 未包含 |
| mimalloc | `PC/pyconfig.h:541` 定义 `WITH_MIMALLOC 1`；vendored `mimalloc.h` 的版本标记为 212；`pythoncore.vcxproj` 编译 `Objects/obmalloc.c` | v2.1.2 原 MIT LICENSE；CPython `Doc/license.rst` 也保留此完整条款。这里没有声称 CPython 修改后的 vendored 树与上游所有文件相同 |
| HACL* / Karamel 支持头 | `pythoncore.vcxproj:433–447` 编译哈希/HMAC 源；`refresh.sh` 固定上游 commit | `dist/LICENSE.txt` 的完整 MIT 文本与 CPython HACL 源首部一致。另保留上游根 Apache LICENSE；7 个支持头首部写明 Apache 2.0 和 MIT，不能把整个目录概括成只有一个无版权人的 MIT 标签 |
| zlib-ng 2.2.4 | `python.props`、`get_externals.bat` 和 `pythoncore.vcxproj` 的 `zlib-ng` 项目引用及 `ZLIB_COMPAT` | 原 `LICENSE.md`。不要用普通 zlib 版本号替代实际 zlib-ng 来源；zlib 条款要求保留源码声明，二进制产品致谢本身不是强制要求 |
| XZ 5.2.5 / liblzma | `python.props`、`get_externals.bat`、`liblzma.vcxproj` 的 XZ 源目录 | 原 `COPYING` 清楚说明 liblzma 属公共领域。该声明用于准确说明来源；同一源码包的 GPL 脚本/构建材料不等于 Python 的 liblzma 二进制受 GPL 约束 |
| CPython 其余 incorporated software | 固定 `Doc/license.rst` 包含 SipHash、dtoa、libmpdec、mimalloc、stdlib/Unicode 等声明 | 保留整个原文可避免只保留根 PSF LICENSE 而丢掉内嵌软件致谢；其内容包含文档/测试等来源，不表示每节都链接入本发行二进制 |

SQLite 的公共领域来源、已保留的 bzip2/libffi/zstd 文本与上述补充项分别处理。本次没有根据包名虚构 SQLite 的强制 NOTICE，也没有因为 XZ 来源中存在 GPL 文本而宣布整个运行时 GPL。

### LibTomMath 的实际边界

r1d 的 `libtommath.dll` 是 95,456 字节，SHA256 `bf18448a56de62e56adb5a50040c08648f0bcf556217de90eca283490ee8c0c3`，确实来自固定官方 embed ZIP。ZIP 不包含 Tcl/Tk/_tkinter 文件；独立解析全部 141 个 PE 的普通和延迟导入表，也没有一个导入 `libtommath.dll`。DLL 没有可用 FileVersion/ProductVersion，不给它编造版本号。

固定 CPython `PCbuild/tcltk.props:22–36` 在 Tcl major 9 路径声明 external TomMath；`PC/layout/main.py:42` 的 Tcl/Tk DLL 排除模式是 `tcl*`、`tk*`、`zlib1`，而第 228–237 行一般 DLL 布局逻辑不会排除 `libtommath`。这解释了其出现在 embed 的来源路径，不能推导为完整 Tk 运行时存在。

已取固定 Tcl 9.0.4.0 来源中的 `libtommath/LICENSE`（Unlicense）用于保留来源说明。它不是 LibTomMath 二进制完整编译谱系或精确版本的证明。若继续携带 DLL，元数据写“来自固定 CPython embed；对应 Tcl source-deps 中 LibTomMath 声明”，不要写未知版本。若实现方选择不携带，应作为另一个载荷变更重新清点和验证；本次没有删除或更改它。

## 2. OpenSSL 两个实际版本

| 载体 | 本次只读二进制字符串 | 固定归档 SHA256 |
|---|---|---|
| Python `libcrypto-3.dll`，另带 `libssl-3.dll` | `OpenSSL 3.5.7 9 Jun 2026` | `openssl-3.5.7.tar.gz`: `d71a811bfbd9153d7b30cbe476263302ee4b04a9a47ffea6e6a782326805c93f` |
| cryptography `hazmat/bindings/_rust.pyd` | `OpenSSL 4.0.3 29 Sep 2026` | `openssl-4.0.3.tar.gz`: `29cbaaabad1f3b0e8f28274eb8445a1cb0c54af21a6f845882ee018763df7159` |

两个归档的 `VERSION.dat` 与上述版本匹配。两个根 `LICENSE.txt` 均为 10,175 字节，SHA256 `7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a`，为 Apache-2.0 原文。可在最终许可索引中指向同一原文，但两个组件来源必须分别记载。旧 `_rust.pyd` SHA256 为 `1d4332a447cab13dec8e3a533ad579e0e562b79e40822c931f33769758fc7156`。

两份源码归档没有根 NOTICE。仅见构建时 Perl Text-Template 的独立 LICENSE 等非运行时材料；不能把它写成已链接入 Python 的组件。抽查源码内附加 BSD 文本时，LPdir、X509 等明确写着 dual-licensed / also available；SEED 文本的源码保留与不背书条款也不能误读成独立二进制强制 NOTICE。这里不声称对每个 OpenSSL 编译单元做了链接级审计。

## 3. cryptography Rust 锁集合与原文

独立重算结果：

- `cryptography-50.0.2.tar.gz`：`7b46165bb56eb4704e2eaaf86f3c940d19154535d9b0ca7d6d590b04060e00d5`。
- sdist `Cargo.lock` 与暂存 `cryptography-rust/Cargo.lock` 均为 `98778208027ce05bfff0db88c290f28355eb20e685f0c728775359fb91a1a4c4`。
- 32 个 registry `(name, version)` 与暂存清单完全相同，无遗漏和额外项；每个原 crate SHA 同时匹配 Cargo.lock checksum 与 `sources.json`。
- 62 份文件逐个核查源归档路径、实际字节、长度和 SHA256，全部匹配；每个 crate 的 `Cargo.toml` license 字段也与清单一致。
- `desktop/runtime/notices/cryptography-rust/sources.json`：`d638f937656e5f019dd34b904cc646bf4c53c3488234d74d16e26532fba7926e`。
- 8 个本地 workspace crate 的许可引用归 cryptography 原 LICENSE/APACHE/BSD；候选 dist-info 中这三份文本已分别与固定 sdist 原文比较，一致。

该集合的正确说明是 **“完整锁定的 registry 依赖集合，包含构建时组件；不是全部已链接依赖集合”**。没有运行 Cargo，也没有通过本报告推断实际 wheel 的 feature/link map。

必须保留原许可表达式：`self_cell` 是 `Apache-2.0 OR GPL-2.0-only`，可使用 Apache 分支，不能因此宣布整包 GPL；`unicode-ident` 的 `(MIT OR Apache-2.0) AND Unicode-3.0` 包含额外 Unicode 文本；`target-lexicon` 的 Apache LLVM exception 和 pyo3 嵌套 runtime 的许可均已在 62 份原文中。不能把这些统称为“全部 MIT”。

本次接受的是暂存原文匹配。它们尚未因目录存在而自动成为 r1d 或任何新安装器的已携带内容。

## 4. Microsoft VC 14.51.36247 来源与闭合

缓存 EXE `vc_redist.x64-20261103.exe` 为 18,731,856 字节，SHA256 `843068991daaa1f73ad9f6239bce4d0f6a07a51f18c37ea2a867e9beca71295c`。本次 `Get-AuthenticodeSignature` 返回 `Valid`，签名主体为 `CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US`。

独立确认两个缓存 CAB 与 EXE 中 offset 479744/630000 的原始字节相同。Burn XML 声明的六个 payload 的 SHA1 和长度全部匹配缓存；`a1` 是 x64 Minimum MSI、`a2` 是 x64 Additional MSI，`a4/a5` 分别是其 CAB。MSI 只读 File 表确认下表四个文件名、长度、版本及 ID。四个提取 DLL 均为 Microsoft `Valid` 签名，未使用 System32 的任意 DLL。

| 文件 / 提取来源 | 字节 | SHA256 |
|---|---:|---|
| `mfc140u.dll` / `additional/mfc140u.dll_amd64` | 5597112 | `fc5848eb58982e193cdfe73f1f26cd04fce4e196f717f42b89ae27315cd52f6f` |
| `msvcp140.dll` / `minimum/msvcp140.dll_amd64` | 643512 | `7c26614e1d733892c2deac7e245ce115504b1d80592dd0a01b08e3e5a55f89ca` |
| `vcruntime140.dll` / `minimum/vcruntime140.dll_amd64` | 178616 | `d1f4225df2cd877dbf130d5668a021dce3f94118455ff5ec952061c30afc9ce7` |
| `vcruntime140_1.dll` / `minimum/vcruntime140_1.dll_amd64` | 50112 | `a7146c08f89fe5b04541ab507cdb59ff7b44534d4ba3c668a426c6450a03434e` |

版本全部为 `14.51.36247.0`。这是源容器、MSI 元数据及 Microsoft 签名内容的一致性检查；本复核没有重新展开 CAB，也没有运行任何 MSI 安装动作。

独立 PE32+ 解析覆盖旧候选 141 个 PE 及这四个 DLL 的普通和 delay-load 导入。泛名 VC 引用为 `mfc140u.dll`、`msvcp140.dll`、`vcruntime140.dll`、`vcruntime140_1.dll`；四个目标 DLL 对 VC 的传递引用在该集合内。旧 numpy/rapidfuzz 自带的哈希命名 `msvcp140-a4c2229bdc2a2a630acdc095b4d86008.dll` 仍是 wheel 的独立原文件，不能用泛名 DLL 替换其 RECORD 内容。其余被核查导入包含 Windows/UCRT API sets；MFC 的延迟导入包含系统 shell/wininet/oleacc/odbc 等。

“导入集合闭合”仅适用于上述已读取 PE 的显式普通/延迟导入，**不证明动态 LoadLibrary 的所有场景，也不证明干净机兼容性**。最终包仍需实际 import/桌面链路及声明支持 Windows 环境的验收。

### 许可授权来源和必须保留的条件

已核官方 [Visual Studio 2026 redistribution list](https://learn.microsoft.com/en-us/visualstudio/releases/vs18/redistribution)。它将自身定义为 Enterprise/Professional/Community/Build Tools 许可中的 Distributable List；Visual C++ Runtime Files 段允许按产品条款随应用分发 `VC/redist` 下未修改的文件，并明确同一官方下载渠道取得的 runtime package、merge modules 和 individual binaries 仅限许可有效的 Visual Studio 用户分发。`debug_nonredist` 等排除目录不能纳入。

已下载 [Visual Studio Community 2026 英文许可原 DOCX](https://visualstudio.microsoft.com/wp-content/uploads/2025/10/Visual_Studio_2026-License-Community_ENU.docx)，本机也实际存在 `C:/Program Files/Microsoft Visual Studio/18/Community` 安装。安装存在不能单独证明任一组织的许可资格；本报告不虚构组织规模、营收或开放源码属性。原条款区分个人自有应用、组织允许用途、非 enterprise 最多 5 名并发用户和 enterprise 的适用限制。

Community 的 **DISTRIBUTABLE CODE** 段明确允许复制分发 list 中对象代码，并列出实际条件：

1. 应用向该代码增加显著的主要功能。
2. 要求分发者及外部终端用户同意至少同等保护 Distributable Code 的条款。
3. 规定与应用分发/使用有关的 Microsoft indemnify/defend/hold harmless 条款及其仅基于 Distributable Code 的例外。
4. 不分发 unreleased components 或依赖它们的相应未发布软件，不使用 Microsoft 商标暗示来源/背书，不把 Distributable Code 源码改成受 Excluded License 支配。

这说明四个**未修改的正式版运行时 DLL**有可引用的 Visual Studio 再发行路径，无须凭空设想另一份“VC DLL 单独购买授权”。发行材料应准确列明 Microsoft 组件及终端保护条款；不能把整个 Reach 的所有内容标为同一个开源许可。

另读 `Visual-C-V14-License-Redistributable_and_Runtime_ENU.docx`：其 INSTALLATION AND USE RIGHTS 允许任意数量安装使用，但 SCOPE OF LICENSE 明确不允许 share/publish/distribute。因此单独附该 EULA **不是发行方分发许可的完整依据**；它与 Community/Distributable List 的分发权不得混淆。CPython 已附 `PC/crtlicense.txt` 也明确重申终端保护要求。这是实际许可文本要求，本次没有据此增加产品权限模式、安装引导或重复请求用户批准。

| 缓存许可材料 | 字节 | SHA256 |
|---|---:|---|
| `vs2026-redistribution.html` | 48844 | `32532f7b81918db91db11967176ca165c92f49195d282d54d387f0fa7a248cfa` |
| `vs2026-community-license.html` | 235983 | `3e52504176ebeedcae92172ba6d7c0a5c33e4563bb4ca745b3ca2b1c88a5158a` |
| `Visual_Studio_2026-License-Community_ENU.docx` | 69066 | `02ac07637f4a513a807cd3721c7620433fc483bc049d25784b0c10c54b05e1fb` |
| `Visual-C-V14-License-Redistributable_and_Runtime_ENU.docx` | 39553 | `08651651a7602fc7c0e2763de0fde1ff9f868df2780597cd1775ee9d6441c783` |

## 5. 可接入的原文缓存

下列 11 份文件已从上述固定归档按原始字节提取到 `E:/usr/var/cache/reach/runtime-license-sources/native-original-notices/`。同目录 `source-map.json` 保存逐份归档名、归档 SHA、成员路径、长度和原文 SHA；其 SHA256 为 `f2ff17c3c6c0bea855e784d65515b885cb7585a59b07a0d5225eaaff8d84af02`。这里没有修改项目 notices 或 r1d。

| 文件 | 字节 | SHA256 |
|---|---:|---|
| `CPython-3.14.7-licenses-and-acknowledgements.rst` | 60039 | `cd6f471c0bfdb099efefc25ddff9b3df8bf62e10428987f1f05e6f2f9e35d563` |
| `expat-2.8.2-COPYING` | 1144 | `31b15de82aa19a845156169a17a5488bf597e561b2c318d159ed583139b25e87` |
| `xz-5.2.5-COPYING` | 2775 | `bcb02973ef6e87ea73d331b3a80df7748407f17efdb784b61b47e0e610d3bb5c` |
| `mpdecimal-4.0.0-COPYRIGHT.txt` | 1285 | `2713324211652ce4a60e6e21e54f9dc3004299e591b0933a352f1a89c5fb53c2` |
| `zlib-ng-2.2.4-LICENSE.md` | 867 | `6c9f0d975b41afaa34d22f55bb8986ce69e5cb7ad327cb2b28820cd425edf5ee` |
| `libtommath-from-tcl-9.0.4.0-LICENSE` | 1257 | `2fa64b163659f41965c9815882a8296d3d03ff546b76153e11445f9bdecf955a` |
| `mimalloc-2.1.2-LICENSE` | 1096 | `19c99805e7a44a34b297a75d1edea9985e300066dfc024d5c99d4236d4573b5d` |
| `HACL-star-source-LICENSE-APACHE` | 11356 | `c5accbbd8546e94c34aed24afe689a617627d18eed5a6c48277e48db57c23851` |
| `HACL-star-distribution-LICENSE-MIT` | 1207 | `998ce04fb8ad9dedb0bc1b44938f8c3dcf1089780fa105ce1c8c30fb5554d78c` |
| `OpenSSL-3.5.7-LICENSE.txt` | 10175 | `7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a` |
| `OpenSSL-4.0.3-LICENSE.txt` | 10175 | `7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a` |

两份先前暂存的 dnspython/fastmcp 补充声明仍按其独立来源记录保留，本报告不把已有暂存状态改写成已纳入发行包。

## 6. 剩余实际工作

1. 将上面的原文、cryptography 62 份 notices、dnspython/fastmcp 补充及 Microsoft 来源/适用条款纳入新候选，按载荷实际文件生成逐项摘要；旧 r1d 的接受证据不自动接受新载荷。
2. 用官方来源四个同版本 VC DLL 完成包内运行依赖，保留源 EXE、签名/摘要及组件映射，不从 System32 任取 DLL；核安装包最终字节与来源相同。
3. 最终许可索引区分实际原生组件、全 lock 构建依赖集合、源码/文档参考材料与 Microsoft 专有再发行代码，保留双许可选择和 Unicode/LLVM 例外，不用单个 SPDX 标签掩盖完整原文。
4. 按最终候选执行运行时、实际安装与干净环境验证，再记录发行接受结论。当前报告仅关闭本次已说明的来源核查项。

网络获取过程中保留事实：GitHub `git ls-remote` 连接超时、匿名 API 查询遇到 rate limit；之后通过 codeload 版本归档 PAX commit 再取精确 commit，完成独立内容比较。`aka.ms/vs/18/redistribution` HEAD 成功转到上述官方列表；额外 VC EXE locator HEAD 遇到 TLS EOF，没有据此声称重新下载过 EXE，二进制核查使用已有签名有效的固定缓存。没有把失败尝试算成新运行证据。
