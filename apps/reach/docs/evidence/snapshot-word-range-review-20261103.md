# Snapshot 词范围循环的独立复核

作者：Ray Zhang（Ray）。日期：2026-11-03（Asia/Hong_Kong）。
独立复核：Codex `/root/reach_plan_review`；诊断与修复执行：`/root`。

## 结论与范围

r2 的真实 Snapshot 超时已有确定的循环证据：UIA provider 对 `Move(TextUnit.Word, 1)` 返回 `1`，但范围起点实际向后移动，原迭代器随后重新遍历相同词范围。最小修复应在共享词范围迭代器内验证每次非零移动后的 Start 严格前进，并让 Snapshot 明确报告受影响词坐标不完整。正常控件信息、已有 `value` 和截图仍应继续返回。

本次复核只读取固定 r2/r4 源码、原始日志和诊断脚本，并作标准库归档/摘要分析；没有执行 UIA、测试、桌面动作、Cargo、安装器、提权或 ACL 修改。前半部分记录已证实原因和修复边界，末节记录随后固定 r4 的源码与主实现执行证据复核；均不代表最终安装包的真实安装验收。

## 固定来源

`work/portable-runtime-r2-build/source.zip`：1,896,032 字节，SHA256 `051882d58875913eb9bda48d80b4a2ec0d29fa59363d10cd7d016d17e85261ff`。其 ZIP comment 为 Git commit `94de2b4a5e1f2c52aad6003d5e60af28f57b8c8b`，与 `desktop/runtime/portable-lock.json` 的固定上游一致。构建脚本以该 Git 对象生成归档。

下列原归档文件、r2-build 解包源码与 r2 安装到 `python/Lib/site-packages/windows_mcp/` 的文件逐字节相同：

| 上游相对路径 | SHA256 |
|---|---|
| `src/windows_mcp/uia/controls.py` | `5e85bddf4c97e42fbda3192244e0b5691155d1d26ecd701be6c2e3041154590d` |
| `src/windows_mcp/uia/patterns.py` | `13daa5dc1558d96b85abc2a4ef5c191dbefc4c33aac1720586f9aae3de9677e8` |
| `src/windows_mcp/tree/service.py` | `a1b324b0bdae191498b04d22754b5cd8316f53528ad213319723fe429c002f39` |
| `src/windows_mcp/tree/budget.py` | `4bfec47e9d0edc38cff01c54f296daf320b3c7e931574712ae75784257a0d8ae` |
| `src/windows_mcp/tree/views.py` | `065fb66f3cbf6461ca9f822c64f3a3c02b9716774b21f27cf1133e7b0ac0df4a` |

因此该循环条件存在于固定上游原实现，不能归因于 Reach 已有补丁改写了词迭代器。r2 的 `desktop/service.py` 已受其他 Reach 补丁修改；构建源码与安装文件相同，不宣称它等同未修改上游。

## 实际失败与诊断证据

[portable-r2-static-native.log](portable-r2-static-native.log) 的 SHA256 为 `526315d7203b54941164e8484ffc426db69dc6e5fdea0f3ede7ed3c368819a38`。六项真实 helper 回归为五过一败；实际捕获/中文输入/点击/身份/进程结算用例在 `tests/desktop.integration.test.ts:85:51` 收到失败 Snapshot，错误明确为 60 秒超时、只读操作、`effectsMayHaveOccurred=false`、空 `snapshotId`、`labelsAvailable=false`。其余五项通过不能覆盖该失败。

第一次直接 Python 诊断目录为 `work/snapshot-diagnostic-37249d74-71a9-4b56-a64b-e5e5527ba520/`。两次 faulthandler 采样都落在：

```text
uia/patterns.py:1648 Move
uia/controls.py:1263 _iter_word_ranges
uia/controls.py:1285 GetAllWordBoundingBoxes
tree/service.py:673 tree_traversal
```

仅凭这两个调用栈，不能区分单次 COM 阻塞与重复快速调用。该目录 `snapshot.stderr` SHA256 为 `26cfb03f38f03b2a3e114875b81efd2acd84ed1ef5a7cfd2ad1d27c4b359ba2c`。

第二次只读计时诊断目录为 `work/snapshot-diagnostic-6b6ef2ed-4f8b-4d0d-ae00-050305bf1bc2/`。脚本在 `Move` 前 Clone 范围，随后调用原 Move 并比较新旧 Start；不改变原 Move 的结果或遍历决定。复核时 `work/diagnose-snapshot.py` SHA256 为 `279847e1a8fb9f824ad565c67bbca5c7bc769b42038bd3bc159824076db024db`。

| 文件 | 字节 | SHA256 |
|---|---:|---|
| `snapshot.stdout` | 106884 | `4623c5d13474001a7b2d087ab86b8782d573c878dceeb28a1ae31cd7790b46c6` |
| `snapshot.stderr` | 5110 | `9cceedcb2dbf23268e51965a98e1f571f0e12e43d731d5b185aa11eda9f47afe` |
| `result.json` | 22 | `ff1d3d73bc870ceb3bbf9fd4b8a2d27a5fa3f5c5eac003c4c024bf57478bc54d` |

`result.json` 为 `{"timeoutSeconds": 42}`。独立解析 stdout 得到：

- 42 秒内至少执行到第 62,000 次 Move；日志按最初三步、每 100 步和所有非前进步骤采样，共 721 条完成记录。
- 100 次记录同时出现 `reportedMoved=1` 和 `startAdvanced=-1`。第一次为第 1,458 次；后续每次回退精确相隔 606 步，最后记录到第 61,452 次回退。
- 已记录样本最长耗时约 0.842 毫秒。这里是采样统计，不声称逐次记录了全部 62,000 次调用或计算了其逐次平均值。

这证明实际执行存在 provider 向后循环仍声称前进的路径；不必增加 60 秒等待、不必排除 Codex 或其他用户应用，也不应通过改变桌面状态来让原用例避开该路径。

## 原实现为什么未能退出

`uia/controls.py:1240` 的 `_iter_word_ranges` 对每个可见范围 Clone/Expand，然后在 Start 小于可见范围 End 时读取词并 Move。唯一移动后退出条件是 `moved == 0`，没有核对实际端点。实际 provider 返回 `1` 而回退，因此其循环条件反复成立。导航已使用 `waitTime=0`，这里不是旧的默认半秒等待。

`tree/service.py:673` 先调用 `GetAllWordBoundingBoxes()` 完成整个列表，再追加词节点。已有 `TreeElementBudget` 默认 500 个输出元素，实际消耗位于 `_append_word_nodes` 等后续步骤，无法制止这个列表构造期间的无限词迭代。

## 最小修复的接受边界

1. **校验真实移动。** 每一步在调用 Move 之前克隆当前词范围；保留 `moved == 0` 的正常结束语义。若报告移动而 `CompareEndpoints(Start, previous, Start) <= 0`，或出现与向前请求相矛盾的负移动，停止该范围遍历并产生明确的专用错误/不完整状态。检查必须对空白词同样执行，不能只统计成功 yield 的词。
2. **区分 Snapshot 的补充几何与完整词操作。** 共享迭代器默认不应静默把部分列表称为完整。Snapshot 可以捕获专用不完整状态，继续正常控件树；对该控件已收集几何可以明确丢弃，或以有说明的部分结果保留。其他完整词属性调用必须感知失败。不要仅 `break` 后按正常成功返回。
3. **保留原始控件信息。** 原 `metadata['value']` 在几何读取之前取得；保留该顺序和可用内容，不为规避循环而截字符串、禁用 UIA、去掉应用或降低权限。Snapshot 的专用异常处理不能落入现有 `except Exception: pass` 而完全失去说明。
4. **让原因实际到达模型。** 控件元数据可标记 `word_geometry_incomplete`，同时应有本次捕获层面的标记，避免无名称控件或后续树转换使唯一标记丢失。`desktop/service.py:1704` 的 region 过滤会重建 TreeState，需要传播新增状态；`tools/_snapshot_helpers.py` 的最终文本也要渲染说明。现有 `truncated` 文案只表示 N 元素上限，不能拿它谎报词范围错误。输出说明不得让 helper 误判整个 Snapshot 为后端失败；现有标签仍应来自真实保留的节点数组。
5. **预算是附加边界。** 若另加词扫描步数/时间预算，应只用于 Snapshot 的补充词几何，按每次捕获共享，并计入空文本迭代，原因与 provider 非前进分开。固定上游已有元素数量预算可以保留。本次已证实故障的必要修复是实际端点前进守卫，不必为了修它扩展为全面遍历重构。
6. **保留实际失败边界。** 步间时限无法中断已经卡住的 COM 调用；修复回退循环不等于证明所有 provider 均不会阻塞。继续保留现有 60 秒外层超时和 helper 进程树回收。不得把提高超时当修复。

## 候选补丁需要的验证

针对实际迭代器的适配测试应包括：正常词与不连续多个可见范围；正常 Move 返回 0；返回 1 但 Start 不动；返回 1 但 Start 回退；负移动；空白文本循环；首次回退后不再产生重复词。测试必须引用候选实际实现，而不是抄一份迭代器证明自身。

标记传播应覆盖：value 保留；专用错误与一般 provider 错误的区分；无名称/空树情况下仍有说明；region 过滤后的 TreeState；最终 Snapshot 文本和正常标签；无 UI tree 的纯截图不新增虚假不完整标记。若另加预算，补测多个控件共享预算、空词消耗预算、下一控件进入前已耗尽与准确原因。

最后必须在包含原问题应用的真实桌面重复原失败的 native 用例，并在最终候选解释器/helper 与重新打包后固定其摘要。单元适配测试、诊断脚本成功或 `--verify-payload` 均不能替代这一步。r2 的原始失败日志应继续保留。

## 随后 r4 固定实现与实际结果复核

主实现随后交付独立候选 `work/portable-runtime-r4/python`，版本 `windows-mcp 0.8.8+reach.4`。复核者重新读取了此候选的实际模块，逐文件比较 r2/r4 包内全部 Python 源码，以及 r4-build 对应五份源码：没有新增/删除 Python 源文件，仅下表五文件发生预期变化；五份构建源码与包内文件逐字节相同。

| 包内 `windows_mcp/` 相对文件 | r4 SHA256 |
|---|---|
| `uia/controls.py` | `64cf56deeb709ba3d7edb37cc62fa207fc29c8a35d7e579319fd052479625c4f` |
| `tree/service.py` | `0530b64ebeb43463e1f4561e9f0dbd0030027fa642c8e22448e0c4d5d3e487e2` |
| `tree/views.py` | `c5f0e5904e520dfbb9d5a5e4738ac6eb6f39a1657f83514cd0837671c3f41511` |
| `desktop/service.py` | `5b01d7cc21e3ef2360dfcfaa327eaecb71d1b22b7ba7b89495de2576fcbafae7` |
| `tools/_snapshot_helpers.py` | `221c20b037c112dc7c485706485a556d6e7334d21244ff013c236e3b6f0be4dd` |

固定 `desktop/runtime/windows-mcp.patch` 为 36,386 字节，SHA256 `27efa907ee475a4e4afc10df3729d060ec86dce2fede6cc19851f8bfbc3e765e`。实际 `python/reach-provenance/files.json` SHA256 `6cecc584a2c8cb755c277bf8a0a6be4c08403898525d7ef41fb477083ef5af0a`，与锁定候选/构建记录一致。

实现符合上述针对循环的最小边界：正常零移动结束；负移动或 Start 不严格前进抛出 `WordRangeTraversalError`；Snapshot 专门捕获并丢弃该控件未完成的全部词坐标列表，保留已有 value 与正常控件路径；每次捕获重置并传播 `word_geometry_incomplete`。控件说明和全局说明都明确原因，region 过滤也保留该字段，未冒充元素上限截断。最终说明位于 `Reach UI Labels` 之前，没有破坏 Rust helper 依赖末尾完整 JSON 的标签解析，也不匹配其 `Error capturing ` 的整体失败判定。本次没有增加预算、放大超时、排除应用或调整权限。

固定新增测试 `tests/word-range.test.py` 为 4,964 字节，SHA256 `a392e094d8195bb1866a12a18fd1f699f0b474de06c3d3524b8291ec80e70cbd`。它导入候选实际模块，使用明确 Range/Pattern 适配对象覆盖正常多范围、零移动、向后循环且不重复 yield、原地/负移动、空词循环、完整 value/说明渲染、空树 region 重建/最终响应说明与空标签。复核者读取了测试和以下日志，没有重跑。

- [word-range-tests-r2.log](word-range-tests-r2.log)：7 项通过，SHA256 `e0370495dbeb5a07f33fa4527bf6550497dd04b3be052d613ff1b05440bfc205`。
- [word-range-tests-r1.log](word-range-tests-r1.log)：保留原失败，SHA256 `f08aa3b60210de91e49399f941423a4babcfbbef4a61bd61b736b5d49c7980e5`。失败原因是测试构造 BoundingBox 漏掉必需的 width/height，随后补齐；不能称为七项一次全过。

七项是实际代码加适配对象的机制验证，不是所有真实 UIA provider 的覆盖。实际桌面证据来自 [portable-r4-static-native.log](portable-r4-static-native.log)，最终 SHA256 `603ea0ff127a37f8c53b4dd281cca938c7ca31f3e99891ed076620a95402156c`：

- 3 组导入顺序、18 个 DLL 校验、6 个 wrapper 恢复，初始 packageUnchanged 为 true；真实动作结束后日志再次确认运行时未改变。
- 原六项真实 helper 回归 **6 过 / 0 败 / 0 跳过**，总计 60,619.3184 毫秒；原失败的捕获/中文输入/点击/身份/进程结算用例为 15,196.9402 毫秒。
- stop、EOF、worker-crash、捕获/参数错误以及真实文件/shell/注册表/scroll 失败路径均通过，原失败记录保留。

独立回读 `work/desktop-native-83478e11-137f-4824-855c-4e2105a92333/` 实际收据进一步确认：

| `interaction/` 收据 | SHA256 | 关键事实 |
|---|---|---|
| `Snapshot-eca7293f-1e68-4170-a704-5ac317b27340.json` | `ed3307822be89f110d0ab91191c3c3840a790adba229871c7d5fdcb12080a6cf` | 初始捕获 succeeded、19 个标签、1 张图，实际出现词坐标不完整标记 |
| `Snapshot-243a4acb-e025-4ef4-8694-9dd7b905721d.json` | `67f429de9f11c75c71755c85bc7c2ea939c48e271c526c68fce2ea42f486e715` | 输入后捕获 succeeded、19 个标签、1 张图，同样有不完整标记，并包含完整中文输入值 |

两次真实 Snapshot 都实际触发了不完整标记，所以这次通过不能解释为单纯避开了原 provider 路径。独立 fixture 的 `effects.json` 确认 `text` 和 `committed` 均为 `Reach Desk 中文输入验证 你好世界`，`clicks=1`。读取的 11 个 helper `settlement.json` 全部 `processTreeEmpty=true`；stop/EOF/crash 的独立 effects 均 `began=true, ended=false`。

**本范围结论：** 固定 r4 修复与七项机制测试未发现可证实的新缺陷，原实际循环失败在对应真实 native 路径得到修复且输出诚实标记。该结论不证明单次 COM 永不阻塞，不证明任何任意超长但始终向前的文本都有额外时间预算，也不代替 SCM/UAC/SYSTEM、生产 ACL、实际升级/恢复、干净机或卸载验收。完整包构建记录仍明确 `installationTested=false`。
