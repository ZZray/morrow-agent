# 工作台入口与可选产品集成

作者：Ray Zhang（Ray）。日期：2026-11-02。状态：首版接入合同；实际部署另记证据。

Reach 自持账户、配对、操作和证据。用户随后要求 Ray 登录后无需再次登录 Reach：工作台浏览器身份经服务端桥接到固定 Reach 账户，客户端与 Node 仍独立认证。LabSlot 登录与机器记录集成继续延期。

## Ray 工作台

用户提供的维护源码为 `https://gitee.com/rzjw/llm-im.git`，`dev/rust`，固定基线 `0b9cb7c3eabf1e4d82bfc1d6147786c2d883721c`。本机隔离检出位于 `E:/workspace/ray-front-reach`。入口卡片位于 `apps/provider/cmd/ray_front/web.go` 的 portalTemplate，启动及路由在 main.go；现有 shift_ingress.go 作为职责划分参考，不复用其身份注入。

用户在公网 8443 不通后要求更换端口。当前选择复用已开放的 443，Reach 基址为 `https://118.25.103.226/reach`，管理/API 服务仍独立监听 `127.0.0.1:18910`。ray_front 的 primary 入口在 Ray 身份桥接前分发 `/reach/`，只剥离一次前缀，Reach 独立认证。原 8443 模式保留作历史恢复参考，切换后停止并禁用其独立入口服务。Node 和 controller 同时支持根 origin 与精确 `/reach` 基址；不接受任意路径、query 或内嵌凭据。

入口双向过滤 Cookie：Reach 只转发 reach_session，其他应用请求/响应剔除 reach_session；不把 Ray 会话、OMP Cookie 或桥接 token 送入 Reach。Reach Cookie Path 为 `/reach/`，登录/退出同时清除历史根路径 Cookie，切换时失效旧测试会话。Reach 保留原 Origin、X-Reach-CSRF 和 Authorization，服务继续校验自己的会话、精确 Origin 与 CSRF。代理根据实际远端地址覆盖 X-Reach-Client-IP，服务只信任明确配置的环回代理地址。

443 路径部署与其他工作台页面共享浏览器 origin。其他同源应用脚本可以请求 Reach API 并读取 CSRF；Cookie Path 和转发过滤不能隔离同源脚本。此方案将整站脚本放在同一浏览器信任边界内，只保证账户、进程、数据和代理身份不互相代用；如需浏览器来源隔离，应使用独立域名和有效证书。

工作台卡片由独立环境变量 REACH_PORTAL_ORIGIN 启用，不修改旧 bridge.json 字段。先验收 Reach HTTPS 入口，再启用卡片。回滚分别恢复应用 current 链接、工作台二进制及环境 drop-in；不覆盖 Ray auth_state，也不以回滚程序为由回滚操作账本。数据库较新时旧程序拒绝启动。

## Ray 浏览器登录合同

浏览器入口由 Ray 校验真实平台会话；未登录时进入原 Ray 验证码页面。根页加载通过独立共享密钥签署一次性声明，包含固定 audience、随机 nonce、毫秒签发/到期时间和已验证 Ray 会话哈希，不接受浏览器指定账户。Reach 在独立 ray-auth.sqlite 中原子消费 nonce，再在既有账户库建立会话；两库不是联合事务，失败时拒绝进入，不能假定已成功。

同一 Ray 会话使用专用密钥、固定账户和会话哈希派生稳定 Reach token。根页即使没有 Cookie，也复用该会话下已有的有效 session 与 CSRF，避免并发首次打开两个标签时互相失效；过期后仍须重新建立有效主库会话和侧库绑定。每个浏览器 API 请求由 Ray 重新验证自身会话，并用仅验证用途的签名交换核对 Reach Cookie 与 Ray 会话绑定。Cookie 缺失、过期或绑定不符时返回重连状态，不创建新会话或重放原操作；页面提供回到根页的单次重连动作。浏览器退出按钮提交原 Ray 的工作区退出流程。

SSO token 类型与绑定保存在独立侧库；这些 token 不可改用原生 Bearer。原生分流要求无浏览器 Origin/Fetch-Metadata、非空 Bearer，或原生无 Cookie 的登录/首次配对接口；分流后删除所有 Cookie，凭据完全交给 Reach 验证。固定 JS/CSS 静态资源公开，不因会话在页面加载期间过期而失去恢复代码。公网拒绝内部换票地址及伪造桥接头。

两个服务分别持有独立权限的同一专用随机密钥文件，不读取 OTP 种子、不复用平台桥接秘密、不扩大服务用户组。首次启用 SSO 时统一失效旧 Reach 会话，保留 Node 身份和原操作，旧原生控制器需要重新登录。后续稳定会话修正仅失效侧库标记的旧 SSO 会话，保留原生会话和 Ray 登录。回退到不识别 SSO token 的旧程序前也须失效会话，不能只关闭代理校验。

## 产品能力

Reach Desk 是可选的云端对话入口扩展，不属于被控端产品工具。默认不加载，Ray 可选装；统一身份、部署关闭行为、对话/设备调用和旧入口迁移由[扩展设计](platform-extension.md)维护。它复用本页 Ray 登录合同，不能把旧 HandWave 的共享 token 当作 Reach 用户身份。

产品关联是可选配置。没有关联时，通用连接、文件、命令和桌面能力仍应可用。产品继续拥有自己的 API/MCP、业务登录、机器主数据和运行结果，Reach 不复制业务后端。

后续登记合同至少包括产品实例 ID、产品类型/版本、现有 API 或 MCP 入口、能力说明来源及版本、引用的资产来源系统/记录 ID/查询时间。凭据由相应产品连接配置持有，不放入模型工具参数或证据公开字段。名称不是安装身份，不以机器名自动合并记录。当前尚未实现产品登记接口，最终字段须进入版本化协议后才可对接。

产品安装器调用同一基础包；移除某一产品关联不能卸载其他产品仍在使用的 Reach 服务或删除原操作记录。真实 QSpin 与第二产品入口尚未取得，这些验收保持开放。受控替身只能验证协议，不替代真实产品接入。
