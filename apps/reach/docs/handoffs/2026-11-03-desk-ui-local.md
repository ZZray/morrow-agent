# 本地 Reach Desk 页面接续

作者：Ray Zhang（Ray）。日期：2026-11-03。

**当前只做本地开发/测试。用户已明确服务器将关机备案，要求“你先本地测试先不部署”。不要SSH、远端模型探测或部署，等待用户明确恢复。** goal仍为完整首版，基础0/52、Desk0/5；这不是停止本地工作。dev、HEAD90f2b1c、大量WIP，不套Lumen规则，不提交/推送。无用户UAC结果，不重复安装请求。

新页面已在platform/web落地，选装serveDesk白名单提供/desk/资源，管理页启用时加入口，同一次Reach Cookie。新增Web编译配置platform/tsconfig.web.json，`node_modules/.bin/tsc --project platform/tsconfig.web.json`生成platform/dist；管理页仍bun run build:admin。默认基础无平台依赖。无新产品运行依赖；测试Playwright-core1.64.1在E:/usr/opt/playwright-core-1.64.1，Chrome156.0.8078.80。

[证据](../evidence/desk-ui-20261103.md)记录最终Chrome5/5、83.241s（work/desk-browser-r4.log），基础16/16、20.294s，三份TS检查通过。五个目录运行前各15项源码/EXE pin全部匹配。主场景有提交锁、后输入草稿切走再回来、首段到达后才放finish、同原生Session两Task、刷新不重投、取消partial恢复、XSS纯文本、390px退出；另有history503保登录、GET断流恢复、晚到running不能覆盖completed、管理页往返同Cookie、旧false终态不能解新blocked（seeded排序fixture）。没有真人模型用于这五组。

冻结115来源/3生成JS/1EXE/555原件，清单SHA cd3b7efb2fb07a932f682aafdbd40b468487c7fd62efeab35166d55a3a8115f6；sourceIdentity6c19381033d991ff4501b9f425e3bea5410d3f624d491e39af0b5a518f277463。快照work/desk-ui-source-116eebc5-e706-4fb7-a54e-44499ea03025。Chrome profiles不入清单，DB/WAL成对，见[清单](../evidence/desk-ui-inputs-20261103.json)。之前desk-host冻结保留父版本；不能拿旧104输入摘要说当前全部相同。

原sidecar未重编译，SHA9684d0e970234fd0e9a63b870994bfafd31f8b0ef792ca85734a13c0189acf2e，E:/usr/var/cache/rust-target/reach-static/x86_64-pc-windows-msvc/debug/ara-agent-lite-jsonl.exe。完整安装候选仍60a6，图标不重做。当前无本点测试/SSH/Cargo在跑；各自fixture/browser已关闭。18912是早前已停的故障代理，不要误当新Desk预览或生产故障。

用户暂缓前两次组织OMP试验都未整体通过：r3单条真实Task已completed/Released，但空格违反测试格式，work/desk-real-2accc59a-f495-44ac-a5ac-39cc3e3c603a；r4首条JSON正确，第二Task60s无正文unknown，work/desk-real-ec3eea8d-e37b-4d7c-be7a-a344ec7cab38。原日志desk-real-model-r3-omp/r4-omp.log。暂停后不得重连取token。当前错误脱敏修补只有本地源码复核，未重跑远端。前两次free代理失败亦保留在desk-host证据。

下一步继续本地：实现/验收取消后同一原生Session的结算释放与续聊（现max_runs1 fence阻止，只能显式新对话，不能把它当最终交付）；设备目标/工具与Node Host、委托和完整通用工具；实际Windows安装边界仍待用户UAC/干净机。页面是现有后端候选投影，不能绕过原fence、清unknown或复制Agent循环。后续恢复远端后再核模型路由和Ray长连接/发布。

独立复核继续/root/reach_plan_review，见[报告](../evidence/desk-ui-review-20261103.md)。原[Host交接](2026-11-03-desk-host.md)保留历史固定点。服务器现状未在用户暂停后复核；不要把旧release或参考gateway源码当最新运行证明。一次一个Cargo，缓存E:/usr，work中间产物，outputs交付。

最终报告SHA b9edb46922cea6c39c48ea65c16db7de1fe3f54c7992f681e1e6b3cfdf22f570，主代理已完整回读并接受限定结论。直接校验全部摘要/75启动pin及五Task，work/desk-ui-final-check.json；10文档123本地链接全过、diff-check0。全仓bootstrap仍失败，work/desk-ui-bootstrap-final.log；不得称全仓通过。本点无活跃tool session，当前源码/JS无需重编或重跑这五组，后续按新增改动验证。
