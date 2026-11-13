'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// 只加载 skills-ui.js 的最小 DOM/全局替身：验证 payload、错误与刷新，不镜像样式。
function harness() {
  function element() {
    const classes = new Set();
    return {
      children: [], attributes: {}, textContent: '', focused: false, value: '', disabled: false, checked: false, open: false,
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
      },
      replaceChildren() { this.children = []; },
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener() {},
      showModal() { this.open = true; },
      close() { this.open = false; },
      focus() { this.focused = true; },
    };
  }
  const nodes = new Map();
  const context = vm.createContext({
    $: (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    el: (tag, cls, text) => Object.assign(element(), { className: cls, textContent: text }),
    document: { createElement: () => element() },
    window: { confirm: () => true },
    URL,
    selectedSkills: [], attachMenuOpen: true, skillMenuOpen: true,
    gatewayPublic: null, cloudModelBusy: false, gatewayDirty: false,
    skillSaving: false, editingSkill: null, skillGenerating: false, skillCatalog: [],
    closeAccountMenu() {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'skills-ui.js'), 'utf8'), context);
  // skills-ui.js 里的同名函数声明会覆盖沙箱属性，加载后再打桩。
  context.renderSkills = () => {};
  context.renderSkillManager = () => {};
  context.skillEditorDirty = () => false;
  context.setSkillSaving = () => {};
  const calls = [];
  context.loadModelsCalls = 0;
  context.loadModels = async () => { context.loadModelsCalls += 1; };
  context.api = async (p, opts) => {
    const method = (opts && opts.method) || 'GET';
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path: p, method: method, body: body });
    if (context.__fail) throw new Error(context.__fail);
    return typeof context.__respond === 'function' ? context.__respond(p, { method: method, body: body }) : {};
  };
  return { context, nodes, calls };
}

// ==== 真机 gatewayPublic schema（apps/handwave/gateway.go 的 json tag）====
function publicConfig(over) {
  return Object.assign({
    gateway_root: 'http://127.0.0.1:8787',
    gateway_token_env: 'CUSTOM_HUB_TOKEN',
    default_model: 'deepseek-v4-flash',
    default_protocol: 'openai-completions',
    allow_loopback: true,
    has_token: true,
    configured: true,
    models: [
      { id: 'deepseek-v4-flash', protocols: ['openai-completions', 'anthropic-messages'], name: 'DeepSeek Flash' },
      { id: 'kimi-k2.6', protocols: ['openai-completions'], name: 'Kimi' },
      { id: 'legacy-no-protocols', protocols: [] },
    ],
    migration: ['检测到旧的 cloud-model.json（OMP / 自定义直连模型）。Hub 已不再读取它。'],
  }, over || {});
}

function opened(over) {
  const h = harness();
  h.context.gatewayPublic = publicConfig(over);
  h.context.renderGatewayForm(true);
  return h;
}

test('selection renders the intended skill label and retains its ID', () => {
  const { context, nodes } = harness();
  const skill = { id: 'a'.repeat(32), name: 'engineering-docs', description: '工程文档' };
  context.selectSkill(skill);
  assert.equal(nodes.get('skillBar').children[0].textContent, '@engineering-docs ×');
  assert.equal(context.selectedSkills[0].id, skill.id);
  nodes.get('skillBar').children[0].onclick();
  assert.equal(context.selectedSkills.length, 0);
});

test('selection is capped at eight skills without changing existing selections', () => {
  const { context, nodes } = harness();
  for (let i = 0; i < 9; i++) context.selectSkill({ id: String(i), name: 'skill-' + i });
  assert.equal(context.selectedSkills.length, 8);
  assert.equal(nodes.get('skillBar').children.length, 8);
});

test('form reads the real Go field names and shows only the token env name', () => {
  const { context, nodes } = opened();
  assert.equal(nodes.get('gwRoot').value, 'http://127.0.0.1:8787');
  assert.equal(nodes.get('gwTokenEnv').value, 'CUSTOM_HUB_TOKEN');
  assert.equal(nodes.get('gwModel').value, 'deepseek-v4-flash');
  assert.equal(nodes.get('gwProtocol').value, 'openai-completions');
  assert.equal(nodes.get('cloudAllowLoopback').checked, true);
  const status = nodes.get('gwTokenStatus').textContent;
  assert.match(status, /CUSTOM_HUB_TOKEN/);
  assert.match(status, /已检测到值/);
  // 只报变量名 + 是否存在；不出现值、Bearer 或密钥样式串
  assert.doesNotMatch(status, /Bearer|sk-|api[_ ]?key/i);
  for (const gone of ['cloudAPIKey', 'cloudClearKey', 'cloudProvider', 'cloudBaseURL', 'cloudModelSource', 'cloudModel', 'token_env']) {
    assert.equal(nodes.has(gone), false, gone + ' must not be used any more');
  }
  assert.equal('token_env' in publicConfig(), false, 'fixture must follow the Go schema');
  // 旧配置迁移提示原样可见（textContent）
  assert.equal(nodes.get('gwMigration').classList.contains('hide'), false);
  assert.match(JSON.stringify(nodes.get('gwMigration').children.map((c) => c.textContent.concat(JSON.stringify((c.children || []).map((l) => l.textContent))))), /cloud-model\.json/);
});

test('missing token reports the env var name without claiming readiness', () => {
  const { nodes } = opened({ has_token: false });
  assert.match(nodes.get('gwTokenStatus').textContent, /CUSTOM_HUB_TOKEN/);
  assert.match(nodes.get('gwTokenStatus').textContent, /未检测到值/);
});

test('open -> save -> save+test keeps the non-default env var name', async () => {
  const { context, nodes, calls: savedCalls } = opened();
  context.__calls = savedCalls;
  context.__respond = (p, opts) => (opts.method === 'PUT' ? publicConfig({ default_protocol: opts.body.default_protocol }) : publicConfig());
  await context.openCloudModelDialog();
  assert.equal(nodes.get('gwTokenEnv').value, 'CUSTOM_HUB_TOKEN');
  await context.saveCloudModel(false);
  assert.equal(nodes.get('gwTokenEnv').value, 'CUSTOM_HUB_TOKEN');
  await context.openCloudModelDialog();
  assert.equal(nodes.get('gwTokenEnv').value, 'CUSTOM_HUB_TOKEN');
  await context.saveCloudModel(true);
  assert.equal(nodes.get('gwTokenEnv').value, 'CUSTOM_HUB_TOKEN');
  const status = nodes.get('gwTokenStatus').textContent;
  assert.match(status, /CUSTOM_HUB_TOKEN/);
  assert.match(status, /已检测到值/);
  const saves = context.__calls.filter((c) => c.method === 'PUT');
  assert.equal(saves.length, 2, '两次保存都走同一份 schema');
  for (const save of saves) {
    assert.equal(save.body.gateway_token_env, 'CUSTOM_HUB_TOKEN', '变量名不会被默认值覆盖');
    assert.equal(Object.keys(save.body).sort().join(','), 'allow_loopback,default_model,default_protocol,gateway_root,gateway_token_env');
  }
});

test('PUT payload is exactly the gateway schema and refreshes the chat catalog', async () => {
  const { context, nodes, calls } = opened();
  context.__respond = (p, opts) => (opts.method === 'PUT' ? publicConfig({ default_protocol: opts.body.default_protocol }) : publicConfig());
  await context.saveCloudModel(false);
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.path, '/model-config');
  assert.deepEqual(Object.keys(put.body).sort(),
    ['allow_loopback', 'default_model', 'default_protocol', 'gateway_root', 'gateway_token_env']);
  assert.equal(put.body.gateway_token_env, 'CUSTOM_HUB_TOKEN');
  assert.equal(put.body.default_model, 'deepseek-v4-flash');
  assert.equal(put.body.default_protocol, 'openai-completions');
  assert.equal(context.loadModelsCalls, 1);
  assert.match(nodes.get('cloudModelStatus').textContent, /配置已保存/);
  assert.match(nodes.get('cloudModelStatus').textContent, /openai-completions/);
});

test('first configuration works without any catalog', async () => {
  const { context, nodes, calls } = harness();
  context.gatewayPublic = publicConfig({ configured: false, gateway_root: '', gateway_token_env: '', default_model: '', default_protocol: '', has_token: false, models: [], migration: undefined });
  context.renderGatewayForm(true);
  assert.equal(nodes.get('gwModelOptions').children.length, 0, '未配置时不提供任何“候选证明”');
  assert.match(nodes.get('gwModelHint').textContent, /首次配置/);
  nodes.get('gwRoot').value = 'http://127.0.0.1:8787';
  nodes.get('gwTokenEnv').value = 'CUSTOM_HUB_TOKEN';
  nodes.get('gwModel').value = 'brand-new-model';
  assert.equal(context.renderGatewayProtocols(context.gatewayPublic, ''), '');
  assert.match(JSON.stringify(nodes.get('gwProtocol').children.map((o) => o.value)), /ollama-chat/, 'protocol 可选 7 种受支持值');
  assert.equal(context.gatewayValidationError(context.gatewayPayload()), '', '留空 = 由服务器目录唯一解析');
  context.__respond = (p, opts) => (opts.method === 'PUT'
    ? publicConfig({ default_model: 'brand-new-model', default_protocol: '' })
    : (p === '/model-config/test' ? { ok: true, models: 4, model: 'brand-new-model', protocol: 'openai-completions' } : publicConfig()));
  await context.saveCloudModel(true);
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.body.default_model, 'brand-new-model');
  assert.equal(put.body.default_protocol, '');
  assert.ok(calls.some((c) => c.path === '/model-config/test' && c.method === 'POST'), 'save+test 才做实际目录验证');
  assert.match(nodes.get('cloudModelStatus').textContent, /目录鉴权与连通通过/);
  assert.match(nodes.get('cloudModelStatus').textContent, /没有调用模型生成/);
});

test('an untrusted candidate root never inherits the saved catalog protocol constraint', () => {
  const { context, nodes } = opened();
  nodes.get('gwModel').value = 'deepseek-v4-flash';
  assert.match(context.gatewayValidationError(Object.assign(context.gatewayPayload(), { default_protocol: '' })), /多个协议/);
  nodes.get('gwRoot').value = 'http://127.0.0.1:9099'; // 换了候选地址
  context.renderGatewayForm(false); // gwRoot 的 oninput/onchange 就是这个调用
  assert.equal(context.gatewayCatalogTrusted(), false);
  assert.equal(nodes.get('gwModelOptions').children.length, 0, '旧目录不再当候选');
  assert.match(nodes.get('gwModelHint').textContent, /与已保存配置不同/);
  // 无可信目录：候选列表 = 7 种受支持协议 + 留空；保留用户已显式选过的值，不自动改
  assert.equal(context.renderGatewayProtocols(context.gatewayPublic, undefined), 'openai-completions');
  const protoValues = nodes.get('gwProtocol').children.map((o) => o.value);
  assert.equal(protoValues.filter(Boolean).length, 7);
  assert.ok(protoValues.includes(''), '可以留空交给服务器目录唯一解析');
  assert.equal(context.gatewayValidationError(Object.assign(context.gatewayPayload(), { default_protocol: '' })), '');
  assert.equal(context.gatewayValidationError(Object.assign(context.gatewayPayload(), { default_protocol: 'anthropic-messages' })), '');
  assert.equal(nodes.get('gwModel').value, 'deepseek-v4-flash', '用户显式值被保留');
  // 回到已保存地址 → 目录约束恢复，多协议仍然必须显式选
  nodes.get('gwRoot').value = 'http://127.0.0.1:8787';
  context.renderGatewayForm(false);
  assert.equal(context.gatewayCatalogTrusted(), true);
  assert.ok(nodes.get('gwModelOptions').children.length >= 3);
  assert.match(context.gatewayValidationError(Object.assign(context.gatewayPayload(), { default_protocol: '' })), /多个协议/);
});

test('token env edit also drops the saved catalog authority', () => {
  const { context, nodes } = opened();
  nodes.get('gwTokenEnv').value = 'OTHER_TOKEN';
  context.renderGatewayForm(false);
  assert.equal(context.gatewayCatalogTrusted(), false);
  assert.equal(nodes.get('gwModelOptions').children.length, 0);
});

test('refresh only reads the saved configuration and refuses to verify a candidate', async () => {
  const { context, nodes, calls } = opened();
  nodes.get('gwRoot').value = 'https://gateway.invalid';
  await context.refreshGatewayCatalog();
  assert.equal(calls.length, 0, '未保存的候选地址不能触发 GET 并声称验证');
  assert.match(nodes.get('cloudModelStatus').textContent, /不能验证未保存的候选地址/);
  assert.match(nodes.get('cloudModelStatus').textContent, /保存并测试目录连通/);
  nodes.get('gwRoot').value = 'http://127.0.0.1:8787';
  context.__respond = () => publicConfig({ catalog_error: '网关目录不可用（详情已隐去）', models: [] });
  await context.refreshGatewayCatalog();
  assert.ok(calls.some((c) => c.path === '/model-config' && c.method === 'GET'));
  assert.equal(nodes.get('gwModel').value, 'deepseek-v4-flash', '目录失败保留显式 model id');
  assert.equal(nodes.get('gwCatalogError').classList.contains('hide'), false);
  assert.match(JSON.stringify(nodes.get('gwCatalogError').children.map((c) => c.textContent)), /不会回退/);
  assert.equal(context.loadModelsCalls, 1);
});

test('a model absent from the trusted catalog is kept and reported', () => {
  const { context, nodes } = opened();
  nodes.get('gwModel').value = 'deleted-model';
  context.renderGatewayForm(false);
  assert.equal(nodes.get('gwModel').value, 'deleted-model', '无静默替换');
  assert.match(nodes.get('cloudModelStatus').textContent, /已保留你的选择/);
  // 目录里没有这个 ID：界面不猜协议；显式协议仍受控（未知协议被拒），合法协议交由服务器目录解析
  assert.match(context.gatewayValidationError(Object.assign(context.gatewayPayload(), { default_protocol: 'nope-chat' })), /不是网关支持的协议名/);
  assert.equal(context.gatewayValidationError(Object.assign(context.gatewayPayload(), { default_protocol: 'anthropic-messages' })), '');
  nodes.get('gwModel').value = '';
  assert.match(context.gatewayValidationError(context.gatewayPayload()), /请填写 default_model/);
});

test('payload validation blocks an illegal token env name and a bad root', () => {
  const { context, nodes } = opened();
  nodes.get('gwTokenEnv').value = 'CUSTOM-HUB-TOKEN';
  assert.match(context.gatewayValidationError(context.gatewayPayload()), /环境变量名/);
  nodes.get('gwTokenEnv').value = 'CUSTOM_HUB_TOKEN';
  nodes.get('gwRoot').value = 'http://user:pw@gateway.invalid/v1?x=1';
  assert.match(context.gatewayValidationError(context.gatewayPayload()), /用户名|查询串/);
});

test('save failure surfaces the server wording and claims no success', async () => {
  const { context, nodes, calls } = opened();
  context.__fail = 'gateway target is not allowed';
  await context.saveCloudModel(false);
  const text = nodes.get('cloudModelStatus').textContent;
  assert.match(text, /保存失败/);
  assert.match(text, /HTTPS/);
  assert.match(text, /gateway target is not allowed/);
  assert.doesNotMatch(text, /已保存/);
  assert.equal(context.loadModelsCalls, 0);
  assert.equal(calls.length, 1);
});

test('skill generation error points at the gateway dialog when nothing is configured', async () => {
  const { context } = harness();
  context.__fail = 'gateway is not configured';
  context.$('skillAIPrompt').value = 'Create an incident review skill';
  await context.generateSkillDraft();
  assert.match(context.$('skillAIStatus').textContent, /网关模型配置/);
  assert.match(context.$('skillAIStatus').textContent, /gateway is not configured/);
  assert.doesNotMatch(context.$('skillAIStatus').textContent, /云端模型/);
});
