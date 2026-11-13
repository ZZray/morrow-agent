# Reach Desk contributor rules

作者：Ray Zhang（Ray）。本目录是 Reach 内部的平台子项目，正式产品名为 Reach Desk，命令名为 reach-desk，用户已确认。

- 遵循 Reach 与 Morrow Agent 父目录规则。平台后续在此维护，不回写旧 HandWave 或 ARA 项目。
- 默认 Reach 安装、启动和构建不加载此子项目；可选 Ray 接入按扩展清单验收。
- `legacy/` 是迁入的平台兼容源码，现阶段保留原协议和测试以支持完整迁移；不表示已接通 Reach 身份/设备或已替换线上平台。旧 node/ctl 不再通过平台命令入口提供，现场设备只采用 Reach Node。
- 旧共享 Go 库仅按 source.lock.json 固定版本制备到忽略的构建缓存，不复制进维护源码；不得更新标记或在缓存中开发。新扩展 Agent Host 使用 ARA Lite/Harness。
- `provenance/` 中的原始守则和说明仅用于来源核对，不是本目录的活动开发指令。保留原许可证和第三方作者；新增内容署名 Ray Zhang。
- 任何兼容性削减须在迁移清单记录，不能以隐藏旧功能当作完成。旧数据、凭据与生产状态不导入 Git；历史兼容包不进入默认 Reach 发布物。
