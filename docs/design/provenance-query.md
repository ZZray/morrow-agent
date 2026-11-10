# 跨 Task provenance 查询

## 需求

- Q1　Host 显式提供允许查询的 Task、Session 和 evidence 目录。过滤条件只能缩小
  这个集合，查询不发现新的目录。
- Q2　支持按 artifact、Skill、bundle hash、Host receipt、Task、Run、时间和
  状态过滤，返回类型化记录。
- Q3　保留原件路径和实际字节 SHA-256，检查合法状态转移及 Skill 到产物、Host
  receipt 和摘要的关联。缺失或不一致来源必须报告。
- Q4　合法撤销记录可供历史查询。单个 scope 损坏时返回该 scope 的明确错误，
  其余已授权 scope 继续查询。旧 evidence 中没有 provenance 文件时返回空结果。
- Q5　查询从磁盘读取，重启后无须恢复内存索引。并发查询遵守文件锁，查询结果
  仅表达记录及来源状态，业务 Task acceptance 仍由 Host 决定。

## 接口与读取流程

`query_provenance` 接受 `EvidenceScope` 列表和 `ProvenanceQuery`。每个 scope
提供 task_id、session_id 和绝对 evidence_dir。相同 canonical 目录和相同身份
的重复输入去重。库只读取这组目录中的固定 provenance 文件。

每个目录单独持有共享锁，读取合法历史状态和原始文件摘要。目录内记录的 Task
及 Session 必须与 scope 匹配。Skill 的每条 validation receipt 都需与来源
产物的 Host receipt、输入摘要和输出摘要一致。合法的来源撤销通过单独状态
返回。缺失来源、非法转移和不匹配的摘要使该 scope 返回错误。

`ProvenanceQueryReport` 包含记录和逐 scope 错误。每条记录带来源 scope、
类型化产物或 Skill、来源状态以及对应原件的路径和 SHA-256。
原件 SHA 描述本次读取的字节，业务文件和 Skill library 当前内容通过现有 Host
检查与 `verified_skill_provenance` 接口核对。

时间范围采用 Unix 毫秒的 `[from, to)`。产物使用 created_at，Skill 使用
verified_at。解析支持现有原生毫秒字符串和 RFC3339。没有时间过滤时保留旧的
不透明时间字段，启用时间过滤后，无法解析的匹配记录返回明确的 scope 错误。

## 验证任务

- [x] Q1、Q2　多个 Task、Session 和目录的联合查询，以及每项过滤条件。
- [x] Q1　重复目录、路径别名和不匹配身份。
- [x] Q3、Q4　篡改来源摘要、缺失来源、合法撤销、坏 scope 与正常 scope 共存。
- [x] Q2　毫秒与 RFC3339 边界、空区间、倒置区间和不透明历史时间。
- [x] Q4、Q5　旧空目录、进程重启与并发读取。
- [x] Q3　返回原件摘要与实际文件字节一致。
- [x] Q1–Q5　针对性测试、适用回归和独立 diff review。

命令、结果与覆盖范围记录在 [跨 Task 查询验证记录](../evidence/provenance-query-20261111.md)。
