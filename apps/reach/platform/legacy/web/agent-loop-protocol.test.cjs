'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// 真实 app.js 的两处 agent-loop 发送路径（本机 run 起点 + 本机正忙时的排队回合）在 VM 里跑：
// 只看发出去的 frame 里 model / protocol 是否与模型菜单同源，不镜像样式。
// protocol = '' 表示「这次不带显式协议」，由服务端按已有会话或网关唯一/default 解析。

function appSource() {
  return fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
}

function block(source, from, to, label) {
  const start = source.indexOf(from);
  const end = source.indexOf(to);
  assert.ok(start >= 0 && end > start, 'app.js block not found: ' + label);
  return source.slice(start, end);
}

function element() {
  const classes = new Set();
  return {
    children: [], attributes: {}, textContent: '', value: '', disabled: false, title: '', checked: false,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
    },
    get options() { return this.children; },
    get text() { return this.textContent; },
    replaceChildren() { this.children = []; },
    appendChild(child) { this.children.push(child); },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() {}, addEventListener() {},
  };
}

function catalog() {
  return [
    { id: 'deepseek-v4-flash', owned_by: 'openai-completions,anthropic-messages', protocols: ['openai-completions', 'anthropic-messages'] },
    { id: 'glm-4.6', owned_by: 'openai-completions,openai-responses', protocols: ['openai-completions', 'openai-responses'] },
    { id: 'kimi-k2.6', owned_by: 'openai-completions', protocols: ['openai-completions'] },
  ];
}

function pub(over) {
  return Object.assign({
    configured: true, gateway_root: 'http://127.0.0.1:8787', gateway_token_env: 'HW_GATEWAY_TOKEN',
    default_model: 'deepseek-v4-flash', default_protocol: 'openai-completions',
    allow_loopback: true, has_token: true, models: catalog(),
  }, over || {});
}

// 只替 UI / 网络宿主；菜单选择、composer 分支与 frame 组装全部跑 app.js 真码。
function harness(models, gatewayPub) {
  const source = appSource();
  const nodes = new Map();
  const sent = [];
  const finished = [];
  const ctx = vm.createContext({
    $: (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    el: (tag, cls, text) => Object.assign(element(), { className: cls || '', textContent: text == null ? '' : text }),
    document: { createElement: () => element(), createElementNS: () => element(), addEventListener() {} },
    console: { warn() {}, log() {}, error() {} },
    setTimeout: () => 0, clearTimeout: () => {},
    closeModelMenu() {},
    sendFrame: (frame) => { sent.push(JSON.parse(JSON.stringify(frame))); return true; },
    newToolId: () => 'run-1',
    api: async (p) => {
      if (p === '/models') return models;
      if (p === '/agent-context') return { brief: 'BRIEF' };
      throw new Error('unexpected path ' + p);
    },
    ensureChatContext: async () => true,
    beginAssistant: () => ({ append() {}, finalize() {} }),
    resetAgentRun() {}, recordAgentEvent() {}, addBubble() {}, noteSession() {},
    setSendUI() {}, startLocalTick() {}, clearPendingAttach() {},
    finishLocalRun: (msg) => { finished.push(msg); },
    localTasks: new Map(), selectedSkills: [], pendingAttach: [],
    curWS: { id: 'ws-1' }, curSess: null,
  });
  const run = (expr) => vm.runInContext(expr, ctx);
  run(block(source, '// ---------- 模型选择（共享网关目录', 'function positionModelMenu() {', 'model menu'));
  run(block(source, '// 读取共享网关配置', '// ---------- 启动 ----------', 'gateway config + catalog'));
  run(block(source, 'function localComposerAction', 'function noteSession', 'composer action'));
  run(block(source, 'async function startLocalRun', 'function bindLocalAgent', 'startLocalRun'));
  run(block(source, 'async function sendChat', 'function cancelActiveWork', 'sendChat'));
  run('gatewayPublic = ' + JSON.stringify(gatewayPub === undefined ? pub() : gatewayPub));
  run("$('modelSel').value = 'default'"); // 与 index.html 的隐藏字段初值一致
  return {
    ctx, run, nodes, sent, finished,
    last() {
      assert.ok(sent.length, '没有发出任何 frame');
      return sent[sent.length - 1];
    },
    // 本机 run 起点：startLocalRun → agent-loop
    async localRun() {
      await run('startLocalRun("目标：把日志读一遍")');
      return this.last();
    },
    // 本机正忙：sendChat 的 follow 分支 → agent-loop（run/queue 由 node 决定，UI 只管把选择带全）
    async busyFollow() {
      run('localMode = true; localBusy = true; sending = false');
      run("$('input').value = '再加一条：写完再报告'");
      await run('sendChat()');
      return this.last();
    },
  };
}

// vm realm 的对象原型与宿主不同，比较一律走 JSON 值。
function assertSelection(frame, model, protocol, label) {
  assert.equal(frame.k, 'agent-loop', label);
  assert.ok('model' in frame, label + '：agent-loop 必须带 model');
  assert.ok('protocol' in frame, label + '：agent-loop 必须带 protocol（空串 = 交服务端解析）');
  assert.deepEqual({ model: frame.model, protocol: frame.protocol }, { model, protocol }, label);
}

function assertLegalProtocol(h, frame) {
  if (frame.model === 'default' || !frame.protocol) return;
  const allowed = JSON.parse(h.run('JSON.stringify(modelProtocols(' + JSON.stringify(frame.model) + '))'));
  assert.ok(allowed.includes(frame.protocol), '协议必须属于该模型的目录条目：' + frame.protocol);
}

async function setup(models, gatewayPub) {
  const h = harness(models, gatewayPub);
  await h.run('loadModels()');
  return h;
}

test('两处 agent-loop 都带当前显式协议与同一 model，run 起点其余字段不变', async () => {
  const h = await setup(catalog());
  h.run('selectModel("deepseek-v4-flash")');
  h.run('modelProtocol = "anthropic-messages"');
  const runFrame = await h.localRun();
  assertSelection(runFrame, 'deepseek-v4-flash', 'anthropic-messages', 'startLocalRun');
  assert.equal(runFrame.id, 'run-1');
  assert.equal(runFrame.msg, '目标：把日志读一遍');
  assert.equal(runFrame.brief, 'BRIEF');
  const followFrame = await h.busyFollow();
  assertSelection(followFrame, 'deepseek-v4-flash', 'anthropic-messages', '忙时排队回合');
  assertLegalProtocol(h, runFrame);
  assertLegalProtocol(h, followFrame);
  assert.equal(h.sent.length, 2);
  assert.equal(h.finished.length, 0, '连上本机时不该走失败收尾');
});

test('Auto 的两处 agent-loop 都不带协议：网关存了默认协议也不算用户显式选择', async () => {
  const h = await setup(catalog());
  h.run('selectModel("glm-4.6")');
  h.run('modelProtocol = "openai-responses"');
  assertSelection(await h.localRun(), 'glm-4.6', 'openai-responses', '回到 Auto 之前');
  h.run('setAuto(true)');
  assert.equal(h.run('modelProtocol'), '', '回到 Auto 时清空显式协议');
  assertSelection(await h.localRun(), 'default', '', 'Auto · run 起点：不带协议，交服务端按会话解析');
  assertSelection(await h.busyFollow(), 'default', '', 'Auto · 忙时排队：不带协议，交服务端按会话解析');
});

test('Auto 且网关没存默认协议时也不带协议，两处口径一致', async () => {
  const h = await setup(catalog(), pub({ default_protocol: '' }));
  assertSelection(await h.localRun(), 'default', '', 'run 起点');
  assertSelection(await h.busyFollow(), 'default', '', '忙时排队');
});

test('换模型不会遗留该模型不支持的协议：菜单换模型取目录值，发送边界也再校验一次', async () => {
  const h = await setup(catalog());
  h.run('selectModel("deepseek-v4-flash")');
  h.run('modelProtocol = "anthropic-messages"');
  assertSelection(await h.localRun(), 'deepseek-v4-flash', 'anthropic-messages', '显式 anthropic');
  h.run('selectModel("kimi-k2.6")'); // 单协议：目录即答案，旧的 anthropic 留不住
  assertSelection(await h.localRun(), 'kimi-k2.6', 'openai-completions', '换单协议模型 · run 起点');
  assertSelection(await h.busyFollow(), 'kimi-k2.6', 'openai-completions', '换单协议模型 · 排队');
  // 下拉值被直接改到另一个多协议模型（目录恢复/外部改值），菜单里的旧协议还没被点掉：
  // 发送口径必须按新模型的目录校验，不合法就留空交服务端解析，绝不带旧值。
  h.run('selectModel("deepseek-v4-flash")');
  h.run('modelProtocol = "anthropic-messages"');
  h.run("$('modelSel').value = 'glm-4.6'");
  h.run('modelAuto = false');
  assert.equal(h.run('modelProtocol'), 'anthropic-messages', '旧显式协议值还留在菜单状态里');
  for (const frame of [await h.localRun(), await h.busyFollow()]) {
    assertSelection(frame, 'glm-4.6', '', '新模型不支持的协议不发送');
    assertLegalProtocol(h, frame);
  }
});

test('app.js 里每个 agent-loop 发送点都同时带 model 与 protocol', () => {
  const sites = appSource().match(/sendFrame\(\{ k: 'agent-loop'[^\n]*\}\)/g) || [];
  assert.equal(sites.length, 2, '本机回路只有 run 起点与忙时排队两处发送点');
  for (const site of sites) {
    assert.match(site, /model: [\w$]+\.model\b/, site);
    assert.match(site, /protocol: [\w$]+\.protocol\b/, site);
    assert.doesNotMatch(site, /modelAuto \? 'default' : currentModelValue\(\)/, site);
  }
});
