# 首版实现接续：服务基础

作者：Ray Zhang（Ray）。日期：2026-11-02。会话：01a19a2e-6694-7a51-a3fb-37a35a8946a6。

## 持续目标

用户已授权按 `docs/task-checklist.md` 的完整 52 项清单实现一个版本，并部署到 Ray 工作台服务器。目标 active，当前阶段为 progress，不是 blocked。未缩减为服务原型或仅部署健康检查；完整清单验收仍 0/52。

## 当前工作区

E:/repos/ara，分支 dev，基线 90f2b1c；进入任务时干净。当前 Reach 修改全部在工作区，未提交或推送。已新增 TypeScript/Node24 服务、Zod合同、SQLite身份/配对/操作事件/显式对账，及相应设计文档。原子claim、配对尝试重试、事件outbox去重、撤销后只补传回执、跨账户隔离和可信代理限流均有服务端测试。

最终 typecheck 通过，9 项测试通过（含普通服务进程两次强杀恢复），Node依赖审计输出空对象；源码哈希、测试原始输出和独立审查边界见 [服务基础证据](../evidence/service-foundation-20261102.md)。所有测试子进程已结束，没有留后台开发服务。未进行部署。

## 下一批直接执行

1. 继续 P0：补安装更新、集成及完整验收合同，D02/D06 固定依赖和后端；保留52项ID。
2. 建立 Reach 独立 Rust workspace / reach.exe。Node 持久保存安装身份、pair attempt、本地操作入场、事件outbox和ack游标；进程锁保证单实例执行。先接 command.run / file.read / file.write / directory.list，再把普通Node和服务做真实跨进程/跨机试验。
3. Windows命令进程需要可验证的子进程树取消。不要用取消请求或只杀父进程冒充已停止；未知效果走原操作对账。服务已提供原dispatch/hash绑定、pending/control/events接口。
4. 接 controller CLI/MCP，再补桌面、安装、管理、委托及产品接入；直接工具调用不用模型，远端Agent必须复用Lite/Harness。所有待验收项继续保持未勾选。
5. 定位 Ray HTTPS 入口的安全接入方式后部署独立 service，再验证真实WindowsNode→公网服务→controller链路。不能用服务API自身测试代替52项最终验收。

## 已确认环境与待确认部署

- ray-dev SSH可用，主机VM-0-9-opencloudos，Node24.20.0，约33GiB磁盘可用，内存约2GiB无swap。
- 现有ray-front管理80/443/8080/8000，入口配置在/etc/ray-front/bridge.json，原二进制/opt/ray-front/bin/ray-front。配置含秘密，未打印其值。
- 现有HandWave环回18080、omp_edge18081、Gateway18799等仍运行；拟Reach环回18910。本轮没有改线上配置或重启现有服务。
- /opt/ray-front和/root有限深度搜索未找到Go源码或可扩展route配置。需要继续找当前部署源码或独立HTTPS方式，不要替换不明版本入口。
- 全局工具按tool-environment存E:/usr；本机Node24.21.0、Bun1.4.3、Rust及C工具存在。Cargo共用主机不能并发大量编译。
- Windows-MCP候选固定94de2b4a5e1f2c52aad6003d5e60af28f57b8c8b，0.8.8要求Python3.14，LICENSE.md已核对MIT。尚未安装、打包、实测。客户不能被要求自行安装开发环境。

## 独立复核与技能

可复用代理 /root/reach_plan_review 做独立只读复核；架构和服务增量已复审。项目要求非平凡设计/实现独立复核，Rust改动继续用ara-git-review/ara-rust-core-review，实际验证与point-delivery-audit匹配范围。

humanizer在已查的项目/全局/插件技能中缺失，使用人工文字审读并记录工具缺口；不因此停止已授权实现。UI开始前读取emil-design-eng和ui-delight，后续按需使用animate。根bootstrap仍因38处既有断链失败，本轮Reach链接检查通过；不要借全量断链失败跳过Reach本身的验证。
