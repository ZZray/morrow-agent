# 实际文件产物独立复核

作者：Ray Zhang（Ray）。日期：2026-11-03。复核执行者：独立 Codex 子代理 `/root/reach_plan_review`，使用 `ara-git-review`。

**结论：限定执行点通过，先前发现的领取能力缺口已修复，无剩余确认阻断。** 接受实际 `file.read` 范围产物、版本条件、原 outbox 恢复及新候选身份；不接受完整 T01/T06、整文件不可变快照或安装版全生命周期。基础清单仍为 0/52，Reach Desk 0/5。

## 冻结目标与覆盖

目标是 `dev`、HEAD `90f2b1cdd138129e2d331d89a37d70852e849739` 上的未提交 WIP。最终[输入清单](file-artifacts-inputs-20261103-r2.json) SHA256 为 `937f737448022d545e56b1b999d59cb7521c57f41dc790cdf1b6dfcd8340e56c`，sourceIdentity 为 `624346f1cd36be2adc920567f5fda219278d3ca5dde553b9511785349d060c00`；快照为 `work/file-artifacts-source-2a1190c5-5b3f-4f2f-b585-e72b7a54a3bb`。

独立重算清单及 sourceIdentity，并核对当前文件/快照 71/71、普通程序 2/2、执行证据 16/16 的摘要和字节数，全部一致。相对前一文本产物固定点恰有 6 项源码增量，见[逐项输入核对](file-artifacts-review-inputs-20261103.json)。

- **reviewed**：6 项增量 `src/node/worker.rs`、`src/node/desktop.rs` 的能力广告、`src/contracts/protocol.ts`、`src/service/store.ts` 的提交/领取及两个 `file-artifacts` 测试文件；另核 runtime/ledger、服务 artifact/server、Controller client/MCP 的相关调用与大小限制。
- **scope-excluded**：其余 65 项没有重新作全文件语义审计；保持[前一独立复核](text-artifacts-review-20261103.md)所列覆盖边界。完整平台、依赖安全、UI 和安装维护语义不由本轮重复验收。
- **skipped**：复核代理未重跑 Cargo、TS、原生故障场景或完整载荷校验；以下测试由主代理执行，本代理读源码/原日志并独立核原始数据库及文件。

## 修补与实现判断

先前确认的 P2 是：入队时有扩展能力，降级后的旧 Node 仍能领取排队请求，忽略 `resultFormat` 或 `expectedFileVersion`。最终 `claim()` 在事务内重新读取当前 epoch、未撤销节点的能力，筛选支持的 kind 和文件扩展，保留不兼容项为 queued，并继续领取兼容项。新增实际 HTTP 测试分别覆盖 artifact 请求、仅版本条件请求、降级只领取 inline、升级恢复两项。最终 store SHA256 为 `911186001777e9c1cb8c5a1ad78f2a244ae4b9549439125807ad4e8f974f15c8`。

新字段保持 optional，没有向旧请求注入默认键；旧请求哈希及 requestId 重试身份保持。默认 inline 仍支持 1 MiB 原字节；显式 artifact 每次也是至多 1 MiB，不能把通道每项 8 MiB 上限当成本工具的单次长度。

Worker 从同一普通文件句柄读完有界范围，核前后文件身份/元数据后，从同一缓冲计算 SHA 与 64 KiB 分块；首次输出前预检终态。先落 `file.capture` 来源事件，再写 manifest/chunks/complete，最后写带 content/artifacts 引用的原终态，均复用原 outbox。原来源事件在终态落盘失败时仍可追溯。

Windows 以 read-only sharing 排除本次读取期间的普通写入，版本摘要含卷/文件 ID、大小、创建时间、mtime 及 `FILE_BASIC_INFO.ChangeTime`；Unix 使用 dev/ino、大小、mtime/ctime。它是元数据守卫，不是全文件内容哈希，也不承诺跨多个操作的不可变快照或抵御特权时间伪造。

本轮原生执行证据来自 Windows；Unix 分支只作源码检查。已读 versions 测试覆盖同长度改写并恢复 mtime、源文件替换、空文件、不存在及范围越界。

## 执行证据及独立原件核对

| 主代理执行 | 结果与边界 |
|---|---|
| 初轮 TS | `file-artifact-ts-r1.log`，6/6；发生在 claim 修补前 |
| 最终提交/领取与 service 回归 | `file-artifact-claim-ts-r2.log`，12/12，包含新增降级窗口反例 |
| 原生文件场景 | 初轮 3/3，追加 partial 1/1；共 4 个不同场景 |
| 最终 service 重跑 | `file-artifact-claim-native-r2.log`，recovery/versions 2/2，43.039 秒；是上述 4 项的子集，不叠加报成 6 项 |
| 旧命令/文件原生回归 | `file-artifact-legacy-native-r1.log`，1/1 |
| Node 构建与 Clippy | r2 日志均通过；helper 沿用前一已核程序，没有重建 |

r1→r2 冻结源码只变了 store 与 HTTP 测试；Worker、Node 程序、原生测试、原事件账本及上传消费者未变。两项落盘故障的证据沿用修补前真实执行，**不是最后服务版本重新运行的两项故障测试**。最终两项原生重跑重新跨过修补后的领取路径。

[独立原件核对](file-artifacts-originals-review-20261103.json)记录只读 SQLite/文件探针。最新目录 `work/file-artifacts-503a7b67-8010-428a-8f58-dc87564af350` 中，Node/service 原事件 ID、种类、数据、连续序号一致且全部 ACK：

- recovery：22 条事件、16 块、1,048,576 字节；源文件已删除，原 outbox、服务、CLI 下载及测试定义的原字节一致，SHA `06b7bbfb7824aa03382051691630eb26de85102d1b08a81e907ec0744cd8a286`。
- versions：三操作分别 22/22/11 条事件，16/16/5 块，取回 1,048,576 + 1,048,576 + 302,848 字节；原范围、下载文件与测试原始 2,400,000 字节一致，各范围的 fileVersion 相同。
- 先前 terminal-failure：7 条事件，完整 18 字节证据可取回，终态 unknown、无 succeeded，源已删除；没有因证据完整改写动作状态。
- 先前 partial-failure：6 条事件，仅 1 块 65,536 字节，无 complete，终态 unknown；源文件和失败下载目标均不存在。测试验证同 requestId 重试后事件不变、不重读源文件。

复核代理没有重演 ACK 丢失或重启时序；这些时序由已读测试体及主代理执行日志证明，独立探针验证其保留的原事件和真实字节。

## 新候选身份

候选为 `outputs/windows-complete-a409468ed8848393-93fe5dccdd7f/Reach-Setup-0.1.0-preview-04e4505e8316b0ca.exe`。独立运行实际 EXE `--inspect`、计算 EXE/ZIP 摘要、流式核 ZIP 中两 EXE 和 payload manifest，全部对应冻结目标；16 项安装器 sourceInputs 也全部一致。见[候选核对](file-artifacts-candidate-review-20261103.json)及[实际 inspect](file-artifacts-candidate-inspect-review-20261103.log)。

| 对象 | SHA256 |
|---|---|
| Setup EXE | `04e4505e8316b0cad15aef87caa50ef7894d9e13d288bd56c1667ab6c9862b1e` |
| ZIP | `a409468ed884839323d1c0a73940f5dc063192e579f7fbc23cc43416d8e99b65` |
| Node：11,924,480 字节 | `69b14cfebbff4dd63fe755bd870afe5d83e469fb25f5eb260a432c5dc4231727` |
| helper：10,942,464 字节 | `cf03b5d14e55e613a2d2b2a1682a97b2bc492c59200155074b41573198e4a9b1` |
| payload manifest | `9008498daf5c7de35e6538c63ca2a5eee1e2ce18a38bb236130e766fc1697f85` |

ZIP 有 6,328 entries（含清单）。主代理实际 WinPS 5.1 完整校验为 6,327 载荷文件、201,868,639 字节，十档图标检查通过；本复核读其原记录，不冒称独立重跑全载荷或全部 PE 资源提取。维护源 identity 仍为 `93fe5dccdd7fdee344180610faaae42a12154ef0d5f07f9279394df00e34b9bf`。仅 Node 换新，helper/维护源未变；service 的 claim 修补不属于安装包载荷。

复核第一次 PowerShell 直接捕获 stdout 出现管道关闭 `os error 232`，不计成功；改用隐藏进程、等待退出并重定向到文件后，实际 inspect 退出 0、stderr 为空。保留该失败边界，不把它写成成功执行。

候选仍未签名、未安装。本点没有执行真实 UAC/SCM/SYSTEM/WTS、升级卸载、干净机、真实 Codex 模型消费、长 `isError` 原文保存或 Ray 部署。helper/共享 MCP 长错误接口留待后续执行点；本报告不扩大 T01/T06 验收。文档为人工审读，未调用缺失的 humanizer。
