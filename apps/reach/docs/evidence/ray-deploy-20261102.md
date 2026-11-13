# Ray 独立服务部署记录

作者：Ray Zhang（Ray）。日期：2026-11-02。状态：独立服务已启动，公网与工作台卡片未验收。

## 当前事实

- 应用和 HTTPS 入口已分别安装为 reach.service、reach-ingress.service，均为 active。
- 应用监听 127.0.0.1:18910，独立 TLS 入口监听 8443；后者使用维护中的 /var/lib/ray-front/tls/combined.pem。
- 服务器内按正常信任链验证 118.25.103.226 证书成功；健康、匿名拒绝、独立登录/概览/退出均通过。客户端直接连接环回，未保存 Cookie jar，不能代替公网可达性。
- 初始化密码已从生产 service.env 移除，重启后健康仍通过；私有账户交付文件留在本机受保护的 work/ray-deploy-private/credentials.json，不纳入 Git。
- 本机公网 8443 连接超时，443 正常。主机 INPUT 默认 ACCEPT，已检查的云安全链只见 SSH 来源阻断；已请用户处理云端 TCP 8443 放行，尚无完成答复。
- 原 ray-front.service 仍 active，二进制 SHA 保持 72c4eff9bd3f747ff9c111dbdbb53803816683634e4818ab4df453c4ef61a188；没有替换原工作台、启用卡片或在 Reach 公网浏览器登录。

原工作台公开检查：/ 为 303，/ray/login、/healthz、/handwave/healthz、/arena/health 均为 200，8000 的 /api/health 为 200。它们证明当前公开入口和健康检查仍在，不代替各应用的已登录业务流程。

## 版本与执行

工作台来源 https://gitee.com/rzjw/llm-im.git，固定 0b9cb7c3eabf1e4d82bfc1d6147786c2d883721c；本机 E:/workspace/ray-front-reach 的 dev/rust 存在未提交增量。维护源码增加独立 --reach-only 启动模式、双向 Cookie 过滤和可配置卡片；未改 Ray bridge.json 合同。

[版本快照](ray-deploy-20261102/source-snapshot.json) 记录基础 SHA、7 个源/锁输入、候选二进制、发行包与安装脚本哈希。Go 候选二进制为 dd222233d78d425d25be37fa595153edbfb89a3a70da7f7ae5d0e64e2587c36d；发行包 f5bf3af0f0244923a327ff4bd894e34c92bb3c78282f6110955d9e995c6a0956，899 项，无符号/硬链接。实际发布目录 /opt/reach/releases/20261102-f5bf3af0f024。

`scripts/build.ps1 -Target RayFront`：相同源码的目标 Go 测试通过，15.853 秒；最终构建脚本复用该缓存结果，vet 通过，Node 顶层 26/26、0 skip，Linux amd64 CGO=0 构建通过。[最终日志](ray-deploy-20261102/ray-front-build.txt)。Go 的 security 包装测试会用生成的适配资源执行 JS helper；无参数直接启动该 helper 不是有效运行方式。

第一次缺少稀疏检出的 release-web 资源，第二次 JS 准备缺 linkedom、web 资源及 helper 参数，均保留为[资源失败](ray-deploy-20261102/failed-missing-release-fixtures.txt)与[JS 准备失败](ray-deploy-20261102/failed-js-test-setup.txt)。补齐同一源码版本的夹具，固定 linkedom 0.18.12，按 Go 包装入口运行 helper 后通过；没有删除用例或修改原断言。官方 Go 依赖下载使用本机已配置 127.0.0.1:7897 HTTP 代理，保留原 registry 与 go.sum 校验。

## 部署修正与审查

独立复核者 /root/reach_plan_review 接受入口 5 个改动文件的源码范围，0 个确认运行缺陷；明确真实 TLS、普通进程、原应用存活仍需部署证据。初次安装脚本复核发现 tar 根权限 0777，以及失败后开机启用恢复风险。当前 extract_release 在私有 0700 根目录解包并归一所有成员权限，最后显式根 0755 后才建立 current；在服务器暂存目录实际解包 899 项，确认无 group/other 可写。

失败分支使用 disable --now 并记录 cleanup_exit，所有首次写入纳入错误收据，预检拒绝覆盖已有 Reach 单元、配置、账本和链接。独立复核已确认修正；主代理最后为 useradd 增加显式 --user-group，避免依赖发行版默认。安装脚本实际 SHA 为 29eb803678bd2723960f9f24ebaf87fa1640ba6b5f8610143a0c756c84f2d24b。

审查还发现同 IP Cookie 的部署窗口，现先做无 Cookie jar 的原生验证，原工作台双向过滤生效后才开始浏览器登录。现有工作台启动过程与身份文件没有修改。

原始收据：[安装](ray-deploy-20261102/install-receipt.json)、[服务器内 TLS/认证](ray-deploy-20261102/native-local-tls.json)。release 根 0755/root，状态目录 0700/reach，环境 0600/root 已实际检查。账户秘密、会话和配置正文未写入证据。

## 下一步

等待或解决云端 8443 放行，再验证真正公网 TLS、控制器/Node 跨机结果。随后按[部署流程](../deployment-ray.md)备份并切换原工作台候选、启用卡片、验证浏览器与原应用。当前不能称为工作台入口已上线，更不是 52 项首版完成。
