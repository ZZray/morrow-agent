# Reach 交互桌面 Host（开发候选）

作者：Ray Zhang（Ray）。状态：普通交互用户的 Node → 服务 → Controller MCP 图片链路已验证；Node 已改用双向认证管道。生产 SYSTEM/WTS 启动候选已实现，实际安装环境尚未验收。

本组件属于基础 Reach 的现场桌面能力。Reach Desk 是 `../platform/` 中的可选云端对话子项目，两者不混用。

`reach-desktop --development --python <absolute-python.exe> --config <absolute-config.toml> --results <absolute-directory>` 启动开发监督进程。父进程先把 worker 加入 Windows Job，再转发 stdin；worker 收到匹配 `helperGeneration` 和 `sessionRef` 的 `start` 才启动 Windows-MCP。所有消息为一行 UTF-8 JSON，普通开发入口不提供远程监听。

ready 返回 Windows Session ID、用户 SID、logon LUID、WinSta0/Default 和显示信息。`call` 必须带相同身份；除 Snapshot/Screenshot 外还必须带上次有效的 snapshotId。一个动作消耗该快照，下一次动作需重新取景。标签来自固定后端实际数组；Screenshot 不提供标签。显示位置、主屏、DPI、方向或会话变化使旧快照失效。

图片保持原 PNG/base64，附字节数、尺寸、SHA256 和 contentIndex。要求图片却未收到可解码 PNG 的捕获失败；失败、超时、取消、断线后关闭本代后端。动作结果不明确时返回 unknown，不重试。`stop` 表示停止请求；父进程最后的 `desktop_host_exited` / `processTreeEmpty=true` 和进程退出才证明此进程树已停止，不能表示外部程序的已有效果已撤销。

## 固定运行时

- Windows-MCP 来源：<https://github.com/CursorTouch/Windows-MCP>，固定 `94de2b4a5e1f2c52aad6003d5e60af28f57b8c8b`，上游 0.8.8。
- [补丁](runtime/windows-mcp.patch)生成 `0.8.8+reach.4`：导出同源标签、传播明确工具错误、移除 fuzzywuzzy/Levenshtein 依赖；对 UIA 词范围要求实际位置前进，避免 provider 回退循环。Snapshot 保留控件及文本，并明确标记未完成的词坐标。
- [锁文件](runtime/uv.lock)固定 Python 依赖；已验证 CPython 3.14.7。保留[上游许可](runtime/upstream-LICENSE.md)。已安装的 89 个 distribution 的许可元数据见[记录](../docs/evidence/desktop-runtime-licenses-final.json)，其中 certifi 为 MPL-2.0，不能声称全是 MIT。
- [prepare.ps1](runtime/prepare.ps1)要求干净、固定 SHA 的可丢弃源码 checkout、绝对 Python 路径和独立 environment；使用 `uv sync --locked --no-dev --no-editable`。当前是开发运行时，不是离线可搬运发行包，不能复制含本机路径的 venv 充当安装载荷。
- [prepare-portable.ps1](runtime/prepare-portable.ps1)使用固定官方 embed、哈希锁与原生组件声明生成独立目录；不依赖开发解释器路径。静态 helper 和新便携包的真实只读中文路径验证见[完整载荷记录](../docs/evidence/full-installer-runtime-20261103.md)，仍未替代 SYSTEM/WTS 安装验收。

## 验证与剩余接线

`cargo test --manifest-path desktop/Cargo.toml --all-targets` 验证 PNG 和标签边界；`tests/desktop.integration.test.ts` 使用显式 REACH_DESKTOP_BIN / REACH_DESKTOP_PYTHON，操作临时 WinForms 窗口并从窗口状态文件独立核对效果。运行时补丁另有 `tests/desktop-runtime.test.py`。证据及失败历史见[桌面候选记录](../docs/evidence/desktop-host-20261102.md)。

Node 的开发接线要求配对身份带 development，并设置 `REACH_DESKTOP_CONFIG` 为绝对 JSON 路径。配置只包含三个绝对文件路径：`helper`（reach-desktop.exe）、`python`（固定运行时 python.exe）、`config`（Windows-MCP config.toml）。SYSTEM 不加载这个配置。Node 创建随机单实例本机管道，校验连接的监督进程 PID、用户/会话/logon 身份，先装 Job 再放行管道上的启动字节；跨操作保留同一 helper，图片沿原账本上传。直接运行 helper 的开发 stdin 仍保留，不能把它用于生产服务。原链路见[记录](../docs/evidence/desktop-chain-20261102.md)，新传输与生产候选见[管道证据](../docs/evidence/desktop-pipe-20261102.md)。

生产候选仅由 SYSTEM 服务读取同版本目录中的 `desktop-runtime.json`，三个路径必须相对并位于受保护包内；检查 Owner/DACL、祖先和 reparse，要求隔离的嵌入式 Python 3.14 `_pth`，拒绝 venv/开发环境回退。绑定用户由服务配置传入；WTS 只选唯一活动登录，暂停创建监督进程、加入 Job、再恢复。helper 在发帧前核对实际管道服务端 PID 与运行中的 LocalSystem `RYReach` SCM PID，并持续检查服务状态。普通助手的每代 spool 与安装账本隔离；没有扩大账本 DACL。

后续仍须：生产 SYSTEM/WTS 与 SCM 查询权限实测、完整文本 artifact、离线打包及干净机器验收。锁屏、断开 RDP、用户切换、显示热切换尚未在本机实际触发测试；代码存在不代表这些场景已验收。隐藏 `--worker` 使用监督进程持有的私有 stdin，不重新连接服务管道；该参数自身不是认证机制。
