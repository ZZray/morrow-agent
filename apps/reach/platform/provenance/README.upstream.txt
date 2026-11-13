# ai-handwave（遥波）

三件套：**hub（信令/中继/AI 网关/工作台）+ node（被控端）+ ctl（CLI）**。
**被控端双击零输入上线，浏览器登录后允许设备，在工作区里与远程主机做 AI 协作**；工具在远端执行，对话与知识库落在 hub。P2P 打不通自动走中继。单个 Go 静态编译 exe。

```
操作端浏览器 ──https──> hub（会话/KB/AI） <──ws── node 被控端
       └────── WebRTC / 中继 DataChannel（工具：exec/读写文件）──────┘
```

## 快速上手

1. **服务器上跑 hub**：
   ```
   handwave token
   handwave hub -listen :8443 -token <根令牌> -node_token <入网令牌>
   ```
2. **目标机**跑被控端（同一个程序，四种用法）：
   - 默认前台：直接运行，或 `handwave node`
   - 安装为服务并开机启动：`handwave node install --hub <地址> --token <入网令牌>`（Windows 管理员 / Linux root）
   - 卸载服务：`handwave node uninstall`
   - 不装服务、只开机启动：`handwave node autostart`，关闭：`handwave node autostart --off`
   - 内置守护：`handwave node --daemon`（脱离终端，进程退出后重新拉起）
   - 服务和内置守护不要同时开
3. **操作机**打开 `http://<hub>/login`，输入根令牌进入**工作台**：
   - 创建工作区与会话
   - 右侧对设备点「允许 / 接入」
   - 中间聊天；可开远程工具、全局/项目知识库
   - **刷新需重新登录**；关闭标签页结束会话

CLI 仍可用：`handwave pair` 交互 shell（`:get`/`:put`/`:ping`）。

### 被控端（轻量执行 Node）

Node 不持有模型密钥、不会自行拉起 pi/OMP；Hub 仍负责模型与总编排。Node 提供受控的 Agent 任务运行时：接收 Hub 规划好的有限步骤，负责本机执行、进度、取消与断连清理。

| 能力 | 说明 |
|------|------|
| 入网 | 连 hub，进「待允许」；授权后自动配对 |
| 通道 | 优先 WebRTC P2P，不通走 hub 中继 |
| 工具 | `exec` / 读文件 / 写文件 |
| Agent 任务 | 最多 8 个顺序步骤；逐步事件、输出限量、超时与主动取消；不在 Node 调模型 |
| 重连 | 断线指数退避重连（封顶 30s，连稳后重置）；断连会终止在跑任务 |
| 常驻 | 默认前台程序。`install --hub --token` / `uninstall` 为系统服务；`autostart` / `autostart --off` 为开机启动；`--daemon` 为内置守护。Windows 与 Linux 同一套命令 |
| 配置目录 | `--config-dir DIR` 显式指定；缺省读 `HW_CONF`（会被解析为绝对路径后再传给子进程），再缺省按 exe 同级 / `~/.handwave` 定位 |

**内置守护 `--daemon` 的运行语义**（详见 [../../docs/knowledge/handwave-node-daemon.md](../../docs/knowledge/handwave-node-daemon.md)）：

- supervisor 持有、异常重启 worker；进程退出后重新拉起。
- 单实例按**配置目录**加锁（`node.lock`：`LockFileEx` / `flock`，贯穿守护整个运行周期）。同一配置目录只能有一个守护所有者；不同配置目录互不影响。持有者进程消失时锁由操作系统释放，不会留下挡住重启的锁文件。
- `node.pid` 只作诊断，不用于判断守护是否在运行。
- Windows：supervisor 把 worker 放进 Job Object，自己被终止（含 `TerminateProcess`）时 worker 一并结束，不留孤儿进程。
- Windows 开机启动项会把 `--config-dir` 写进 Run 值：登录拉起的进程拿不到原终端的环境变量。

## 工作台能力

| 能力 | 说明 |
|------|------|
| 认证 | 根令牌 → `hwses` 会话 cookie；刷新重登、离开注销 |
| 工作区 / 会话 | 落盘 `data/workspaces/...`（jsonl 消息） |
| 远程连接 | 审批、特征展示、断开/重连（复用原信令） |
| AI 对话 | 经 hub `/v1` 上游；消息写入云端会话 |
| 工具 | `exec` / `read_file` / `write_file` → 已配对 node |
| 智能体协作 | 可关闭；协调者最多并行委派 3 个隔离、无递归工具的轻量 subagent，并可把 2–8 步本机任务交给 Node |
| 过程可视化 | 右上任务坞显示人物名册、总进度、运行数与耗时；点人物查看模型、工具、Node 步骤、输出和错误时间线 |
| 技能 | 保存 Markdown 指令；每条消息显式选择，服务端快照后仅注入该轮请求；可用 hub 自用模型生成草稿 |
| Hub 自用模型 | 左下角「云端模型配置」；Hub 只读**共享网关目录** `{gateway_root}/v1/models`，服务令牌取自环境变量（默认 `HW_GATEWAY_TOKEN`），契约见 [docs/knowledge/cloud-model-omp.md](docs/knowledge/cloud-model-omp.md) |
| 知识库 | 全局 + 项目；文本分块倒排检索，注入提示词 |
| 附件 | 会话小文件/图片上传（文本抽取；图片 data URL 多模态尝试） |

数据目录（`HW_CONF` 或 exe 旁 / `~/.handwave`）：

```
data/workspaces/{id}/meta.json
data/workspaces/{id}/sessions/{sid}.jsonl
data/skills/{id}.json
data/workspaces/{id}/kb/
data/global/kb/
data/uploads/
```

**主题**：`dark`（默认）/ `light`；旧配置值 `glass` / `obsidian` / `default` / `mist` 会自动映射。

### Hub 自用模型与 AI Skills

工作台左下角账户菜单打开「云端模型配置」：

- Hub 只持有三项：网关 root、承载服务令牌的**环境变量名**（默认 `HW_GATEWAY_TOKEN`）、显式默认 `model` / `protocol`。目录读取与协议解析复用共享 `internal/gatewayclient`，Hub 既不解供应商路由，也不自建第二套 HTTP/SSE 解析。
- 令牌值只从环境变量读取，**永不落盘、永不返回给浏览器、永不写日志**；UI 只能看到环境变量名和 `has_token`。多协议模型必须显式选一个协议，缺省或歧义不会被静默兜底。
- 模型清单来自网关目录 `{gateway_root}/v1/models`；目录鉴权失败、超时与被取消会以固定且不含凭据的文案返回，与「模型/协议选择错误」严格区分。
- 网络边界：非 IP 主机名强制 HTTPS；私网 / 链路本地 / 组播 / 未指定地址与内置黑名单前缀一律拒绝；本机回环默认拒绝，需显式打开 `allow_loopback`；保存与每次连接都重新解析 DNS 做防 rebinding 校验，网关重定向一律不跟随。
- **「保存并测试」测的是目录连接**：读取网关目录并解析默认 model/protocol，返回 `{ok, models, model, protocol}`。它**不发起推理请求**，所以「连接测试通过」不代表模型能正常生成内容。
- 真正会调用所选模型的是 Skills 管理器的「AI 生成草稿」：一次真实完成请求，只回填名称、描述和 Markdown 指令，检查后仍需手动点击「保存技能」。
- 选择写入 `gateway.json`（临时文件 + 原子替换；目录 `0700`，文件 Unix `0600`、Windows 仅当前账号与 SYSTEM）。旧 `cloud-model.json` / `upstreams.conf` 只被**检测并提示迁移**，原文件字节保持原样，也绝不会被当作网关使用。

> **历史（已退役，当前版本不再读取）**：Hub 曾直接读 hub 运行账号下 `~/.omp/用户.ry_switch` 的 CAS / OpenRouter 密钥，把 provider/model 选择写进 `cloud-model.json`（自定义服务密钥也存该文件），用 `upstreams.conf` 做多供应商直连路由，并支持 `HW_OMP_CONFIG` 覆盖 OMP 配置路径。这些路径已移除，仅在 `detectLegacyModelConfig()` 中作为「检测到旧配置文件」的迁移提示。迁移命令：`handwave migrate-gateway -config-dir DIR -gateway URL -model M`（默认只读预览，`--apply` 才写），见 [docs/knowledge/gateway-migration.md](docs/knowledge/gateway-migration.md)。

## 下载中心（/download）

hub 可直接托管安装包，给使用者一个"网页 + 登录"的下载入口，不需要另搭文件服务器：

- 把 `dist/handwave-<os>-<arch>.zip` 放到 hub 配置目录的 `dist/` 下（或 `hub.conf` 用 `dist=` 指到别处），hub 启动横幅会提示已启用。
- 浏览器访问 `http://<hub>/download` → 跳转登录页 → 输入 **hub 访问令牌** → 校验通过种下 7 天会话 cookie（HttpOnly），列出全部安装包（含大小/sha256/更新时间），点"下载"取包。
- 文件名白名单 `handwave-<os>-<arch>.zip`。下载页把 `handwave-linux-arm64.zip` 显示为 **ARM Linux（Ubuntu）**。包里是同一个被控端程序：直接运行，或 `node install --hub --token` / `node uninstall` / `node autostart` / `node --daemon`。路径穿越一律拒绝；`/dl/file?f=…&sha=1` 可单取校验值；`/logout` 清会话。
- 未启用（无 dist 目录）时相关路由一律 404，行为与之前版本一致。

## 审批模型

| 情形 | 行为 |
|---|---|
| 设备首次上线 | 双击 `handwave node` 即连上 hub，进入**待允许**；未经允许无法被任何操作端接入 |
| 操作端点「允许」 | 可选失效时间（1 小时 / 24 小时 / 7 天 / 永久）；hub 记下 `设备指纹 → 授权方指纹 + 过期时刻`，随即自动配对 |
| 之后重连 | 授权有效期内：设备或操作端任一侧重连，hub **自动配对**，不再询问 |
| 到期 | hub 巡检撤销授权，使用中立即断开并提示"授权已过期" |
| 删除授权 | 操作端「删除授权」（`revoke`）：立即解绑，设备回到待允许 |
| 屏蔽 | 「屏蔽」（`deny`）进黑名单：不再出现在待允许，也不再自动配对；「解除屏蔽」恢复 |
| 谁可审批 | 持有根令牌者（网页控制台或 CLI）；授权记录绑定审批人指纹，列表标注"由本浏览器允许" |
| hub 重启 | `approvals.json` 持久化，授权与黑名单不丢 |

身份密钥：每台机器首次运行生成 `identity.key`/`ctl.key`（ed25519），存于 exe 同目录或 `~/.handwave`。
指纹为公钥前 8 字节的 13 位 base32。设备指纹在待允许列表**直接展示**（取代旧 TOFU 弹窗），审批时肉眼核对；hub 负责授权记账与自动配对。

## 命令一览

```
handwave hub   [-listen :8443] [-token T] [-node_token T2] [-gateway URL] [-model M] [-protocol P] [-cert C -key K]
handwave node  [--hub URL] [--token T] [--daemon] [--config-dir DIR]
                             # 被控端：零输入上线（前台）；--daemon 为内置守护
handwave node install --hub URL --token T   # 安装为系统服务并开机启动（Windows 管理员 / Linux root）
handwave node uninstall
handwave node autostart [--hub URL] [--token T] / autostart --off
handwave node start|stop|status
handwave migrate-gateway [-config-dir DIR] -gateway URL -model M [-protocol P] [-gateway_token_env ENV] [-allow_loopback] [--apply]
                                            # 迁移到共享网关配置（默认只读预览，--apply 才写）
handwave pair  [-dev 指纹前缀] [-ttl 秒] [-relay] [-c "命令"]
handwave status                      # 列出设备、别名、授权状态与失效时间
handwave approve -all [-state pending] [-ttl 秒]   # 批量授权（只第一台立即配对）
handwave deny    -all                              # 批量屏蔽
handwave remove  -all                              # 批量删除记录
handwave rename [-dev 指纹前缀] -name 别名    # 给设备起别名（-name "" 清除）
handwave remove [-dev 指纹前缀]              # 彻底删除设备记录（别名/授权/屏蔽）
handwave token                       # 生成强随机令牌
handwave version
```

配置文件（`HW_CONF` 指定目录 > exe 同目录 > `~/.handwave`），`key=value` 一行一条：

| 文件 | 作用 | 键 / 字段 |
|---|---|---|
| `hub.conf` | hub 主配置 | `listen= token= node_token= gateway= gateway_token_env= model= protocol= dist=` |
| `gateway.json` | 「云端模型配置」写入的模型配置 | `gateway_root` / `gateway_token_env` / `default_model` / `default_protocol` / `allow_loopback`（**不含令牌值**） |
| `approvals.json` | hub 自动维护：设备授权、屏蔽名单与别名 | 重启不丢 |
| `node.conf` | 被控端（可空） | `hub= token=` |
| `ctl.conf` | CLI | `hub= token=` |

环境变量：`HW_HUB` / `HW_TOKEN` / `HW_CONF` / `HW_GATEWAY_TOKEN`（网关服务令牌，默认名）。

> 历史：`upstreams.conf`（多供应商直连）与 `cloud-model.json`（旧模型选择/自定义密钥）当前**不再被读取**，只在检测到时提示迁移，原文件字节不变。

## AI 网关（/v1 → 共享网关透明代理）

hub 的 `/v1/` 是**到共享网关的透明代理**，不再是多上游聚合器：

```
浏览器 / Node ──/v1/chat/completions──> hub ──> 共享网关 {gateway_root} ──> 供应商
```

- **只放行窄白名单**：`/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/messages`；另有两条前缀改写（`/v1/ollama/api/chat` → `/api/chat`，`/v1/gemini/models/...` → `/v1beta/models/...`）。其余路径一律 404，网关管理面不会暴露。
- **凭据双层隔离**：转发前剥掉客户端的一切凭据别名（请求头 `Authorization` / `x-api-key` / `X-Handwave-Upstream` 等，查询串 `token` / `key` / `model_grant` 等），再由 hub 注入唯一的网关服务令牌；响应里的 `Set-Cookie` / `Location` / 逐跳头不会回传给浏览器。
- **授权门**：根令牌，或本次执行的短期 model-grant 码；**入网令牌不能过**。
- 原样透传响应体（SSE 逐块 flush、从不整包缓冲）；网关重定向不跟随；失败只返回固定、无凭据的错误文案（如 `gateway upstream failed`）。
- 因此客户端侧只持有 hub 令牌或 model-grant，**真实供应商密钥只在网关侧**。

> 历史（已退役）：旧版 hub 自己解析 `upstreams.conf` 做多供应商路由，支持 `?up=openrouter` / `X-Handwave-Upstream` 指定上游、`-upstream` / `-upkey` 单上游快捷方式。当前 `upstreams.conf` 只被检测并提示迁移。

## 部署（公网 hub）

裸 ws 可用但不建议：hub 令牌是唯一门禁。推荐 caddy 一行：

```
hub.example.com {
    reverse_proxy 127.0.0.1:8443 {
        transport http { versions 1.1 }   # WebSocket 升级需 HTTP/1.1
    }
}
```

nginx 等价：
```
location / {
    proxy_pass http://127.0.0.1:8443;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}
```
`node.conf`/`ctl.conf` 的 `hub=` 填 `hub.example.com`（自动 https/wss）。

### Linux 服务端（systemd，本仓库推荐部署方式）

```
# 1. 二进制
install -m755 handwave /usr/local/bin/handwave
# 2. 配置目录（HW_CONF 环境变量指定；hub.conf 存 token，gateway.json 存共享网关指向）
mkdir -p /etc/handwave /var/lib/handwave
printf 'listen=:8443\ntoken=%s\nnode_token=%s\n' "$(handwave token)" "$(handwave token)" > /etc/handwave/hub.conf
# 2a. 迁移到共享网关配置（默认只读预览，确认无误再加 --apply 真正写入 gateway.json）
handwave migrate-gateway -config-dir /etc/handwave -gateway https://gateway.example -model <默认模型> --apply
# 2b. 网关服务令牌只从环境变量读取、永不落盘到这里，单独放 0600 的 env 文件
printf 'HW_GATEWAY_TOKEN=%s\n' "<网关服务令牌>" > /etc/handwave/gateway.env
chmod 600 /etc/handwave/*.conf /etc/handwave/gateway.env
# 3. systemd
cat > /etc/systemd/system/handwave.service <<'U'
[Unit]
Description=ai-handwave hub
After=network-online.target
[Service]
ExecStart=/usr/local/bin/handwave hub
Environment=HW_CONF=/etc/handwave
EnvironmentFile=/etc/handwave/gateway.env
WorkingDirectory=/var/lib/handwave
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
U
systemctl daemon-reload && systemctl enable --now handwave
```

> 网关令牌随 hub 进程的环境变量提供；`gateway.json` 只记录「用哪个环境变量名」（默认 `HW_GATEWAY_TOKEN`），不保存令牌值。令牌缺失时目录读取会以 `gateway is unavailable` 之类的固定文案失败，而不是回显任何凭据。

> 云主机注意：安全组/防火墙需放行监听端口。若 443 已被占用，可让 hub 直接 `listen=:80`（裸 http/ws，令牌仍是唯一门禁），或反代到 80 后由 nginx/caddy 上 TLS。

## 威胁模型（诚实声明）

- **双令牌分离**：`token`（根令牌）= 根信任，可开控制台审批任意设备、下载包、用 AI 网关，泄露即全面沦陷，只发给操作者；`node_token`（入网令牌）只能让设备上线进「待允许」，**不能审批也不能开控制台**，故可公开编进分发 exe。**真正的信任决策是「点允许」这一步**，由操作者对每台设备逐个做出。
- **未审批设备**：只向 hub 暴露指纹/主机名/用户/系统，不可执行任何命令、不可传文件。
- **指纹核对**：设备指纹在待允许列表行内展示，审批前肉眼比对目标机屏幕上的值（无 TOFU 弹窗，但等价职责在操作端）。
- **P2P 通道**：WebRTC DataChannel 端到端加密（DTLS），hub 只见信令不可见内容。
- **中继模式**：打洞失败时命令/文件走 hub base64 转发——**hub 管理员可见明文**。对抗手段：在远程 shell 里再套 ssh/tls（如 `:put` 加密压缩包）。
- 被控端以当前用户权限执行命令，等同该用户被登录。

## 构建

本应用已迁入 ARA 单根模块，目录为 `apps/handwave`。在 **ARA 仓库根**执行：

```
go build -trimpath -ldflags "-s -w" -o bin/handwave.exe ./apps/handwave
GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o bin/handwave-linux-amd64 ./apps/handwave
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o bin/handwave-linux-arm64 ./apps/handwave
```

`python build_dist.py` 会打出 `handwave-linux-arm64.zip`，放到 hub 的 `dist/` 后，下载页显示为 ARM Linux（Ubuntu）。

或进入本应用目录后按包路径 `.` 构建：

```
cd apps/handwave
go build -trimpath -ldflags "-s -w" -o handwave.exe .
```

发布包：`python build_dist.py`（默认在本应用目录构建、产物写入 `apps/handwave/dist/`；`--check` 可离线校验目标与资源，`--repo` 指 HandWave 应用目录，不再默认指向原仓）。

## 已知限制

- 中继模式大文件传输速度受 base64 + hub 单连接带宽限制（实测 200KB 往返 <1s）。
- 对称 NAT 场景打洞可能失败，自动落中继，功能无损。
- 无多播/会话录制；一台设备同时只服务一个操作端，后来者报"该设备正被占用"。

[pi-portable]: https://gitee.com/rzjw/pi-portable
