'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// app.js 模型选择区块的 VM fixture：只看 model + protocol 的发送口径与目录失败行为，不镜像样式。
// localStorage 桩：同一个 store 传给两个 harness 即模拟「刷新页面」。
function fakeStorage(store) {
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
}

function harness(store) {
  function element() {
    const classes = new Set();
    return {
      children: [], attributes: {}, textContent: '', value: '', disabled: false, title: '',
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
    };
  }
  const nodes = new Map();
  const ctx = vm.createContext({
    $: (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    el: (tag, cls, text) => Object.assign(element(), { className: cls || '', textContent: text == null ? '' : text }),
    document: { createElement: () => element(), createElementNS: () => element() },
    closeModelMenu() { ctx.__closed += 1; },
    localStorage: fakeStorage(store || new Map()),
  });
  ctx.__closed = 0;
  const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const blocks = [
    ['// ---------- 模型选择（共享网关目录', 'function positionModelMenu() {'],
    ['// 读取共享网关配置', '// ---------- 启动 ----------'],
  ];
  for (const [from, to] of blocks) {
    const start = source.indexOf(from);
    const end = source.indexOf(to);
    assert.ok(start >= 0 && end > start, 'block not found in app.js: ' + from);
    vm.runInContext(source.slice(start, end), ctx);
  }
  const run = (expr) => vm.runInContext(expr, ctx);
  return { ctx, run, nodes };
}

function catalog() {
  return [
    { id: 'deepseek-v4-flash', owned_by: 'openai-completions,anthropic-messages', protocols: ['openai-completions', 'anthropic-messages'] },
    { id: 'glm-4.6', owned_by: 'openai-completions,openai-responses', protocols: ['openai-completions', 'openai-responses'] },
    { id: 'kimi-k2.6', owned_by: 'openai-completions', protocols: ['openai-completions'] },
    { id: 'legacy-no-protocols', owned_by: 'gateway', protocols: [] },
  ];
}

function pub(over) {
  return Object.assign({
    configured: true, gateway_root: 'http://127.0.0.1:8787', gateway_token_env: 'CUSTOM_HUB_TOKEN',
    default_model: 'deepseek-v4-flash', default_protocol: 'openai-completions',
    allow_loopback: true, has_token: true, models: catalog(),
  }, over || {});
}

function setup(models, gatewayPub, store) {
  const h = harness(store);
  h.run('gatewayPublic = ' + JSON.stringify(gatewayPub === undefined ? pub() : gatewayPub));
  h.run("$('modelSel').value = 'default'"); // 与 index.html 的隐藏字段初值一致
  h.ctx.__models = models;
  h.ctx.api = async (p) => {
    if (p !== '/models') throw new Error('unexpected path ' + p);
    if (h.ctx.__throw) throw new Error(h.ctx.__throw);
    if (!Array.isArray(h.ctx.__models)) throw new Error('返回目录格式不正确');
    return h.ctx.__models;
  };
  return h;
}

// vm  realm 里的对象原型与宿主不同，只比较值。
function assertSelection(run, model, protocol) {
  assert.equal(run('JSON.stringify(chatModelSelection())'), JSON.stringify({ model: model, protocol: protocol }));
}

test('Auto sends the saved gateway default model plus its saved default protocol', async () => {
  const { ctx, run, nodes } = setup(catalog());
  await run('loadModels()');
  assertSelection(run, 'default', 'openai-completions');
  assert.equal(nodes.get('modelLabel').textContent, '服务端默认', 'Auto 就是服务端已保存的默认模型，不是分类器智能选型');
  assert.match(nodes.get('modelTrigger').title, /服务端默认 deepseek-v4-flash/);
  assert.equal(ctx.__closed, 0);
});

test('multi-protocol model must be given an explicit protocol before it can send', async () => {
  const { run, nodes } = setup(catalog());
  await run('loadModels()');
  run('selectModel("glm-4.6")');
  assert.match(run('protocolChoiceError()'), /多个协议/);
  assert.equal(run('chatModelSelection()').protocol, '', 'no guessed protocol');
  const chips = nodes.get('modelProtoList').children;
  assert.equal(chips.length, 2);
  chips[1].onclick();
  assertSelection(run, 'glm-4.6', 'openai-responses');
  assert.equal(run('protocolChoiceError()'), '');
  assert.equal(nodes.get('modelLabel').textContent, 'glm-4.6 · responses');
  assert.equal(nodes.get('modelStatus').classList.contains('hide'), true, '提示在协议选定后消失');
});

test('the saved default protocol resolves the saved default model without re-asking', async () => {
  const { run } = setup(catalog());
  await run('loadModels()');
  run('selectModel("deepseek-v4-flash")');
  assert.equal(run('protocolChoiceError()'), '');
  assertSelection(run, 'deepseek-v4-flash', 'openai-completions');
});

test('single-protocol model takes the protocol from the directory and closes the menu', async () => {
  const { ctx, run, nodes } = setup(catalog());
  await run('loadModels()');
  run('selectModel("kimi-k2.6")');
  assertSelection(run, 'kimi-k2.6', 'openai-completions');
  assert.equal(nodes.get('modelProto').classList.contains('hide'), true);
  assert.equal(ctx.__closed, 1);
});

test('legacy directory entry without protocols stays unannotated instead of inventing one', async () => {
  const { run } = setup(catalog());
  await run('loadModels()');
  run('selectModel("legacy-no-protocols")');
  assertSelection(run, 'legacy-no-protocols', '');
});

test('closing Auto without a model never picks the first row', async () => {
  const { run, nodes } = setup(catalog());
  await run('loadModels()');
  run('setAuto(false)');
  assert.equal(run('modelAuto'), true, 'still Auto because no explicit model exists');
  assert.equal(nodes.get('modelSel').value, 'default');
  assert.match(nodes.get('modelStatus').textContent, /不会自动选第一个/);
});

test('refreshing the directory keeps the explicit model and protocol', async () => {
  const { run } = setup(catalog());
  await run('loadModels()');
  run('selectModel("deepseek-v4-flash")');
  run('modelProtocol = "anthropic-messages"');
  await run('loadModels()');
  assert.equal(run('currentModelValue()'), 'deepseek-v4-flash');
  assertSelection(run, 'deepseek-v4-flash', 'anthropic-messages');
  assert.equal(run('modelCatalogError'), '');
});

test('a model that vanished from the directory is reported, not replaced', async () => {
  const { ctx, run, nodes } = setup(catalog());
  await run('loadModels()');
  run('selectModel("deepseek-v4-flash")');
  run('modelProtocol = "anthropic-messages"');
  await run('loadModels()');
  ctx.__models = [{ id: 'kimi-k2.6', owned_by: 'openai-completions', protocols: ['openai-completions'] }];
  await run('loadModels()');
  assert.match(run('modelCatalogError'), /已不在目录中/);
  assert.equal(run('currentModelValue()'), 'deepseek-v4-flash', 'no silent substitution');
  assert.equal(run('modelAuto'), false, 'no silent fallback to Auto');
  assert.match(nodes.get('modelStatus').textContent, /重新选择/);
});

test('a failed directory read keeps the old catalog and the current choice', async () => {
  const { ctx, run } = setup(catalog());
  await run('loadModels()');
  run('selectModel("kimi-k2.6")');
  ctx.__throw = 'HTTP 502';
  await run('loadModels()');
  assert.equal(run('modelCatalog.length'), catalog().length, 'previous catalog retained');
  assertSelection(run, 'kimi-k2.6', 'openai-completions');
  assert.match(run('modelCatalogError'), /模型目录读取失败/);
  assert.match(run('modelCatalogError'), /不会回退/);
});

test('an empty directory is reported instead of falling back to Auto', async () => {
  const { ctx, run } = setup(catalog());
  await run('loadModels()');
  run('selectModel("kimi-k2.6")');
  ctx.__models = [];
  await run('loadModels()');
  assert.match(run('modelCatalogError'), /目录为空/);
  assert.equal(run('currentModelValue()'), 'kimi-k2.6');
  assert.equal(run('modelAuto'), false);
});

test('an unconfigured gateway tells the user where to configure it', async () => {
  const { run, nodes } = setup([], pub({ configured: false, models: [], catalog_error: '' }));
  await run('loadModels()');
  assert.match(nodes.get('modelStatus').textContent, /网关还没配置/);
});

test('an explicit choice survives a page reload with the same model and protocol', async () => {
  const store = new Map();
  const first = setup(catalog(), undefined, store);
  await first.run('loadModels()');
  first.run('selectModel("glm-4.6")');
  first.nodes.get('modelProtoList').children[1].onclick();
  assertSelection(first.run, 'glm-4.6', 'openai-responses');
  assert.ok(store.has('handwave.model.selection'), 'explicit choice is persisted');

  const reloaded = setup(catalog(), undefined, store); // 刷新后的全新页面，共享同一个 localStorage
  assert.equal(reloaded.run('restoreModelSelection()'), true);
  await reloaded.run('loadModels()');
  assert.equal(reloaded.run('modelAuto'), false, 'does not silently fall back to Auto after reload');
  assertSelection(reloaded.run, 'glm-4.6', 'openai-responses');
  assert.equal(reloaded.nodes.get('modelLabel').textContent, 'glm-4.6 · responses');
});

test('going back to Auto clears the persisted choice so a reload starts at the gateway default', async () => {
  const store = new Map();
  const first = setup(catalog(), undefined, store);
  await first.run('loadModels()');
  first.run('selectModel("kimi-k2.6")');
  assert.ok(store.has('handwave.model.selection'));

  first.run('setAuto(true)');
  assert.equal(store.has('handwave.model.selection'), false, 'Auto must not be persisted as a choice');

  const reloaded = setup(catalog(), undefined, store);
  assert.equal(reloaded.run('restoreModelSelection()'), false);
  await reloaded.run('loadModels()');
  assert.equal(reloaded.run('modelAuto'), true);
  assertSelection(reloaded.run, 'default', 'openai-completions');
  assert.equal(reloaded.nodes.get('modelLabel').textContent, '服务端默认');
});

test('a persisted model that vanished from the directory is restored as-is and reported', async () => {
  const store = new Map();
  const first = setup(catalog(), undefined, store);
  await first.run('loadModels()');
  first.run('selectModel("deepseek-v4-flash")');

  const reloaded = setup([{ id: 'kimi-k2.6', owned_by: 'openai-completions', protocols: ['openai-completions'] }], undefined, store);
  assert.equal(reloaded.run('restoreModelSelection()'), true);
  await reloaded.run('loadModels()');
  assert.equal(reloaded.run('currentModelValue()'), 'deepseek-v4-flash', 'no silent substitution on reload');
  assert.equal(reloaded.run('modelAuto'), false, 'no silent fallback to Auto');
  assert.match(reloaded.run('modelCatalogError'), /已不在目录中/);
});

test('a corrupted persisted payload is ignored instead of breaking the picker', async () => {
  const store = new Map([['handwave.model.selection', '{not json']]);
  const { run } = setup(catalog(), undefined, store);
  assert.equal(run('restoreModelSelection()'), false);
  await run('loadModels()');
  assert.equal(run('modelAuto'), true);
  assertSelection(run, 'default', 'openai-completions');
});
