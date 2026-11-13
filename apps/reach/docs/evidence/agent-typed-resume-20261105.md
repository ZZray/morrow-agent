# R06 typed 图片恢复合同：本地分项

作者：Ray Zhang（Ray）。日期：2026-11-05。状态：typed settlement contract implemented and unit/service regression passed; real Windows screenshot crash/recovery remains open.

本点只做本地，不访问服务器/SSH/远端模型，不安装、部署或Git同步。基础0/52、Desk0/5、R06整项不勾选。

## 变化

原生恢复的开放工具回执现在允许 `completed.images`，每张图绑定 `path/sha256/bytes/mime_type/width/height`。Node 只从原 `settled_tool` 的已验证 typed image refs 传递，不重拍，不把路径改成文本。JSONL 严格回执允许旧无 `images` 的 completed 记录，带图时只接受完整字段。Lite Core 在恢复 Session 时重新核文件大小/SHA，将原 PNG bytes 作为 `Content::Image` 写入原 ToolResult；原 Session、tool call ID、Run 和 fence 关系不变。

失败/未知 child 仍不能携带 typed 图；未知效果继续拒绝。图片文件缺失、改写、大小/SHA错误会拒绝恢复。该合同只证明原图字节已被 Host 核对并重新进入模型上下文，不证明模型视觉理解。

## 验证

| 检查 | 结果 |
|---|---|
| Rust Core typed recovery unit | `interrupted_image_settlement_restores_original_png_bytes_without_replay` 1/1，`r6-image-core2.log`；原 PNG bytes、SHA、mime 和 Content::Image 通过，工具执行次数为零 |
| Reach Rust workspace | `r6-tests2.log` 22/22，含 wrapper、失败图、resultRef、typed image 收尾反例 |
| Rust clippy | `r6-clippy.log` all-targets/all-features `-D warnings` 通过 |
| Reach TypeScript | `r6-typecheck2.log` `bun run check` 通过 |
| resume/service regressions | `r6-service2.log` 16/16；旧 completed 无 images 兼容保持 |

完整 `ara-agent-lite-core` all-target 测试为 255 通过、1 既有失败、1 ignored；失败是 `managed_jobs::tests::per_job_input_limits_and_authentication_are_enforced_by_worker` 的 `job is not active; input was not dispatched`，没有进入本点 typed 恢复调用链，原失败日志 `r6-core-all.log` 保留，不能称全 Core 绿。

## 边界

本点没有完成真实 Windows screenshot → Node 强杀 → 服务恢复 → typed 原图重新进入受控模型的端到端流程。现有[跨Run截图](agent-cross-run-images-20261104.md)只证明正常多Run原图传递；旧恢复证据仍明确记录 open image refusal。下一步需使用现有 desktop fixture 的真实 PNG、断线/强杀、原件删除/篡改和服务重启矩阵，再考虑 R06 分项接受。
