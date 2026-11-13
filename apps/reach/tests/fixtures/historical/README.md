# 历史服务源码夹具

作者：Ray Zhang（Ray）。日期：2026-11-13。

`schema8/` 是原本地 schema8 服务快照中 `src/service/store.ts` 的相对导入闭包，供 `agent-resumes.test.ts` 实际创建旧数据库并验证迁移。来源及逐文件 SHA256 在 [迁移清单](../../../provenance/migration-20261113.json) 的 `historicalFixtures` 中。

只复制源码，保留原字节；没有复制历史 SQLite、账户、Node 身份、模型配置、请求正文或运行日志。夹具不是活动服务，不修改其历史 schema，不使用当前 Store 伪造旧数据库。原 schema9 原生数据库试验仍需要显式提供原证据，不在本次迁移验收范围内。
