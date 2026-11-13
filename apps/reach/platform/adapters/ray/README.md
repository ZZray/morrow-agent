# Ray 平台 UI 适配来源

作者：Ray Zhang（Ray）。这些原属于 Ray 网关的云端平台界面与对应后端源码，已归入 Reach 平台子项目。后续适配在此处完成，不继续在旧项目修改。

`_source/` 完整保留固定来源的 70 个文件，逐文件哈希见平台根的 ray-source-manifest.json。Go 默认忽略下划线目录；这些文件目前没有加入构建。旧文件仍依赖原 platform/auth/edge 类型、测试辅助函数及 ../../../handwave 路径，启用前必须改为明确的 Host 接口并引用迁入源码，不能用额外旧工作区补齐。

保留范围：handwave_* 适配器、JS/CSS 与测试、模型菜单补丁、cloud_memory/context_links/next_suggestion 与测试、品牌与头像来源、xterm 和许可证、固定 JS 夹具。实际旧头像为 assets/brand/handwave-ai-20261017.png，其余候选图不自动成为新平台品牌。

旧平台来源名可以保留在文件名和出处中；新产品不再使用 HandWave 作为产品名，正式产品名为用户已确认的 Reach Desk。本目录不包含 Ray 登录配置、密钥、会话或生产数据，也不负责通用 Ray 工作台路由。
