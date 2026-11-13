# 实际文件范围产物

作者：Ray Zhang（Ray）。日期：2026-11-03。对应 T01/T06/I01 的局部实现，完整任务不勾选。

`file.read` 已能将实际文件的一个范围保存为二进制产物，附来源、捕获时间和元数据版本。旧 inline 返回与 1 MiB 上限保持。新字段、版本边界和降级领取规则见[工具合同](../tools-tasks.md)。源码基线为 dev / `90f2b1c` 加 WIP；本次没有提交、推送、安装或更新 Ray。

最终[来源清单](file-artifacts-inputs-20261103-r2.json) SHA 为 `937f737448022d545e56b1b999d59cb7521c57f41dc790cdf1b6dfcd8340e56c`，sourceIdentity 为 `624346f1cd36be2adc920567f5fda219278d3ca5dde553b9511785349d060c00`。清单冻结 71 项源码、2 个程序、16 份证据；相对文本固定点修改 4 个生产文件并增加 2 个测试文件。冻结快照位于 `work/file-artifacts-source-2a1190c5-5b3f-4f2f-b585-e72b7a54a3bb`。后续长错误实现不属于这一固定点。

## 实际验证

| 验证 | 实际结果与原记录 |
|---|---|
| Node changed target clippy / 普通程序构建 | 退出 0；`work/file-artifact-clippy-r2.log`、`work/file-artifact-node-build-r2.log` |
| 原产物合同加兼容门控 | 6/6；`work/file-artifact-ts-r1.log` |
| claim 修补后的服务/文件合同 | 12/12；`work/file-artifact-claim-ts-r2.log` |
| 真实 Node 四种场景 | 前三项 47.790s，第四项 7.102s；`work/file-artifact-native-r1.log`、`work/file-artifact-native-partial-r2.log` |
| 最终 claim 后恢复与版本两项重跑 | 2/2，43.039s，是前四项的子集；`work/file-artifact-claim-native-r2.log` |
| 既有 Node 配对/单实例/命令/读写 | 1/1，16.832s；`work/file-artifact-legacy-native-r1.log` |
| TypeScript 类型检查 | `bun run check` 退出 0 |

实际原生案例由 `node --test --test-concurrency=1 tests/file-artifacts.integration.test.ts` 执行，设置 REACH_NODE_BINARY 为本轮普通程序。失败注入使用真实 SQLite trigger 和 HTTP ACK 丢失，不把替身源文件当作客户数据。

- 1 MiB inline 保持。artifact 捕获后丢失 ACK、删除源文件、重启 Node 和服务，CLI/MCP 取回原字节。最终操作 `36361d76-ab47-4db6-9903-5a28859bbba8`，产物 `0243b1e9-97b7-4558-abfd-56b97f2dd245`，1,048,576 bytes，SHA `06b7bbfb7824aa03382051691630eb26de85102d1b08a81e907ec0744cd8a286`。
- 2,400,000 bytes 分三范围读取，拼接 SHA `c66a3654b0ce7d69ef8511dbbd628308f1f7facd80bdfde0f5d56b34d7ef507a`。同长度改写再恢复 mtime、替换文件均被版本守卫拒绝；空文件下载为零字节，缺失路径和超 EOF 明确失败。
- 产物 complete 后，成功终态入账失败使 Node 非零退出。删除源文件并重启后保留 unknown，原 18 bytes 仍可读取，无 succeeded 事件。
- 第二块入账失败时只保留第一块 65,536 bytes，无 complete，下载拒绝。源删除、双重启和原 requestId 重试均不重新捕获，状态 unknown，事件不变。

最终两项原件在 `work/file-artifacts-503a7b67-8010-428a-8f58-dc87564af350`；终态故障在 `work/file-artifacts-2b614c99-2adf-4bb6-8924-23c7f5f34c74/terminal-failure`；部分故障在 `work/file-artifacts-0712ffdd-b2dd-4531-b25a-e91014b0b73e/partial-failure`。

## 候选与复核

完整候选为 `outputs/windows-complete-a409468ed8848393-93fe5dccdd7f/Reach-Setup-0.1.0-preview-04e4505e8316b0ca.exe`，SHA `04e4505e8316b0cad15aef87caa50ef7894d9e13d288bd56c1667ab6c9862b1e`。ZIP SHA `a409468ed884839323d1c0a73940f5dc063192e579f7fbc23cc43416d8e99b65`；payload manifest SHA `9008498daf5c7de35e6538c63ca2a5eee1e2ce18a38bb236130e766fc1697f85`。实际 WinPS 5 私有 stdin 校验 6,327 文件 / 201,868,639 bytes 通过，十档图标和版本核对通过。日志 `work/file-artifact-complete-build-r1.log`，图标记录 [setup-icons](file-artifacts-setup-icons-20261103.json)。未签名、未安装。

独立 `/root/reach_plan_review` 使用 ara-git-review 完成[限定复核](file-artifacts-review-20261103.md)，报告 SHA `f95173e6676a5f9576aa8cee5e3b8c5ba6a403df6f8cee024d5ec202d24227df`。先前确认的降级领取 P2 已修复；主代理完整回读报告并核查来源摘要、原日志和关键实际字节。复核没有重演全部测试，独立查了 Node/服务账本、原产物及实际候选身份。

完整 T01 的搜索等、长 isError、真实模型图片消费、SYSTEM/WTS、真实安装生命周期和 Ray 更新仍开放；本点不是整文件不可变快照或全产品验收。基础 0/52、Reach Desk 0/5。文档人工审读，未调用此前未找到的 humanizer。

主代理收尾重新核对冻结快照 71/71、程序 2/2、证据 16/16、独立报告 SHA、恢复下载实际 SHA，以及 6 份本轮文档的 100 个本地链接；`git diff --check` 通过。全仓 `python scripts/verify_bootstrap.py` 仍因历史、外部路径等断链退出 1，原记录在 `work/file-artifact-bootstrap-doc-check.log`，未宣称全仓文档通过。当前工作区随后出现的长错误 WIP 与冻结来源分开记录。
