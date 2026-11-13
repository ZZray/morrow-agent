// Controlled DOM/API fixture: not real browser or cloud acceptance.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync(__dirname + '/handwave_memory.js', 'utf8');
class Element {
  constructor(tag, doc) { this.tagName = tag; this.doc = doc; this.children = []; this.dataset = {}; this.listeners = {}; this.attrs = {}; this.value = ''; this._text = ''; this.disabled = false; this.open = false; }
  appendChild(e) { e.parentNode = this; this.children.push(e); return e; }
  replaceChildren() { this.children = []; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(e => e.textContent).join(''); }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, extra = {}) { const event = {type, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra}; for (const fn of this.listeners[type] || []) fn(event); return event; }
  focus() { this.doc.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
function walk(e) { return [e, ...e.children.flatMap(walk)]; }
function fixture(bound = true, options = {}) {
  const doc = {}; doc.documentElement = new Element('html', doc); doc.body = doc.documentElement.appendChild(new Element('body', doc));
  const host = doc.body.appendChild(new Element('div', doc)); host.className = 'hw-context-body';
  doc.createElement = tag => new Element(tag, doc); doc.querySelector = () => host;
  const pending = [], calls = [];
  const ctx = {
    window: {}, TextEncoder, document: doc, crypto: {randomUUID: () => 'uuid-' + calls.length},
    curWS: {id: 'w', name: 'Workspace', device_fp: bound ? 'fp' : ''}, curSess: {id: 'a'},
    api(path, options) { calls.push({path, options}); return new Promise((resolve, reject) => pending.push({path, options, resolve, reject})); },
    selectSession(s) { ctx.curSess = s; return Promise.resolve(); },
    selectWorkspace(w) { ctx.curWS = w; ctx.curSess = null; return Promise.resolve(); }
  };
  let labelSyncs = 0;
  if (!options.noDeviceLabels) ctx.syncRailDeviceLabels = function() { labelSyncs++; return 'native labels'; };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  const all = () => walk(doc.documentElement);
  const find = cls => all().filter(e => (e.className || '').split(' ').includes(cls));
  const button = caption => all().find(e => e.tagName === 'button' && e.textContent === caption);
  const label = text => all().find(e => e.attrs['aria-label'] === text);
  const dialog = find('hw-memory-dialog')[0];
  const fields = () => find('hw-memory-field').map(e => e.children[0]);
  return {ctx, doc, pending, calls, find, button, label, dialog, fields, all, labelSyncs: () => labelSyncs};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function result(records = [], projectID = '') { return {binding: {workspace_id: 'w', device_fp: 'fp', project_id: projectID, revision: 2}, projects: [{id: 'p', name: 'Project'}], records}; }
function record(overrides = {}) { return {id: 'r', scope: 'device', scope_id: 'fp', kind: 'fact', title: '设备事实', text: 'Linux', revision: 4, status: 'accepted', ...overrides}; }
async function ready(f, data = result()) { f.pending.at(-1).resolve(data); await tick(); }
(async () => {
  let count = 0;
  async function test(name, fn) { await fn(); count++; console.log('ok ' + count + ' - ' + name); }
  await test('unbound device makes no request and blocks writes', () => {
    const f = fixture(false); assert.equal(f.calls.length, 0); assert.match(f.doc.body.textContent, /先将工作区绑定/); assert.equal(f.button('添加记忆').disabled, true);
  });
  await test('native pairing PATCH followed by rail labels refresh loads newly bound device once', async () => {
    const f = fixture(false); assert.equal(f.calls.length, 0);
    f.ctx.curWS.device_fp = 'fp'; // Native node-hello PATCH.then mutation.
    assert.equal(f.ctx.syncRailDeviceLabels(), 'native labels');
    assert.equal(f.labelSyncs(), 1); assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].path, /device_fp=fp/);
    f.ctx.syncRailDeviceLabels(); assert.equal(f.labelSyncs(), 2); assert.equal(f.calls.length, 1);
    await ready(f, result([record()])); assert.equal(f.button('添加记忆').disabled, false);
    assert.match(f.doc.body.textContent, /设备事实/); assert.doesNotMatch(f.doc.body.textContent, /先将工作区绑定/);
    f.ctx.syncRailDeviceLabels(); assert.equal(f.calls.length, 1);
  });
  await test('device rebinding invalidates old in-flight data and unbinding disables immediately', async () => {
    const f = fixture(); f.ctx.curWS.device_fp = 'new-fp'; f.ctx.syncRailDeviceLabels();
    assert.equal(f.calls.length, 2); assert.match(f.calls[1].path, /device_fp=new-fp/);
    const next = result([record({title: 'new device', scope_id: 'new-fp'})]); next.binding.device_fp = 'new-fp';
    f.pending[1].resolve(next); await tick(); f.pending[0].resolve(result([record({title: 'stale device'})])); await tick();
    assert.match(f.doc.body.textContent, /new device/); assert.doesNotMatch(f.doc.body.textContent, /stale device/);
    f.ctx.curWS.device_fp = ''; f.ctx.syncRailDeviceLabels();
    assert.equal(f.calls.length, 2); assert.equal(f.button('添加记忆').disabled, true); assert.equal(f.button('刷新').disabled, true);
    assert.match(f.doc.body.textContent, /先将工作区绑定/); assert.doesNotMatch(f.doc.body.textContent, /new device/);
  });
  await test('optional rail function can be absent without blocking initialization', () => {
    const f = fixture(false, {noDeviceLabels: true}); assert.equal(f.find('hw-memory-card').length, 1); assert.equal(f.calls.length, 0);
  });
  await test('initial load uses real workspace device fingerprint and bounded active list', async () => {
    const f = fixture(); assert.match(f.calls[0].path, /workspace_id=w&device_fp=fp&scope=device/);
    await ready(f, result([record(), record({id: 'old', status: 'revoked', title: 'hidden'}), record({status: 'candidate', title: 'candidate hidden'}), record({scope: 'workspace', title: 'wrong scope'})]));
    assert.equal(f.find('hw-memory-row').length, 1); assert.doesNotMatch(f.doc.body.textContent, /hidden|wrong scope/);
    assert.equal(f.button('添加记忆').disabled, false);
  });
  await test('server binding mismatch fails closed', async () => {
    const f = fixture(); const data = result(); data.binding.device_fp = 'other'; await ready(f, data);
    assert.equal(f.button('添加记忆').disabled, true); assert.match(f.doc.body.textContent, /读取失败/);
  });
  await test('API error remains visible and can refresh', async () => {
    const f = fixture(); f.pending[0].reject(new Error('offline')); await tick();
    assert.match(f.doc.body.textContent, /读取失败/); f.button('刷新').emit('click'); assert.equal(f.calls.length, 2);
  });
  await test('opening dialog requires explicit action and cancel never posts', async () => {
    const f = fixture(); await ready(f); assert.equal(f.dialog.open, false);
    f.button('添加记忆').emit('click'); assert.equal(f.dialog.open, true); f.button('取消').emit('click');
    assert.equal(f.dialog.open, false); assert.equal(f.calls.length, 1);
  });
  await test('create posts scoped explicit text with revision zero and operation ID', async () => {
    const f = fixture(); await ready(f); f.button('添加记忆').emit('click');
    const [title, text] = f.fields(); title.value = '偏好'; text.value = '简洁回答';
    f.dialog.children[0].emit('submit');
    const call = f.calls.at(-1), body = JSON.parse(call.options.body);
    assert.equal(call.path, '/cloud-memory/records'); assert.equal(call.options.method, 'POST');
    assert.equal(body.workspace_id, 'w'); assert.equal(body.device_fp, 'fp'); assert.equal(body.expected_revision, 0);
    assert.equal(body.scope, 'device'); assert.equal(body.text, '简洁回答'); assert.match(body.op_id, /^uuid-/);
    assert.equal(f.button('保存').disabled, true); f.dialog.children[0].emit('submit'); assert.equal(f.calls.length, 2);
    f.pending.at(-1).resolve({}); await tick(); assert.equal(f.dialog.open, false); assert.match(f.calls.at(-1).path, /^\/cloud-memory\?/);
  });
  await test('edit uses original record ID and revision', async () => {
    const f = fixture(); await ready(f, result([record()])); f.button('编辑').emit('click');
    f.fields()[1].value = 'updated'; f.dialog.children[0].emit('submit');
    const body = JSON.parse(f.calls.at(-1).options.body); assert.equal(body.id, 'r'); assert.equal(body.expected_revision, 4); assert.equal(body.text, 'updated');
  });
  await test('revoke requires its own dialog confirmation and preserves original revision', async () => {
    const f = fixture(); await ready(f, result([record()])); f.button('撤销').emit('click');
    assert.equal(f.calls.length, 1); assert.match(f.dialog.textContent, /历史原件仍保留/);
    f.dialog.children[0].emit('submit'); assert.equal(f.calls.at(-1).path, '/cloud-memory/revoke');
    const body = JSON.parse(f.calls.at(-1).options.body); assert.equal(body.id, 'r'); assert.equal(body.expected_revision, 4); assert.equal(body.scope, 'device'); assert.equal(body.text, undefined);
  });
  await test('project and workspace revocations retain selected scope and delayed-effect notice', async () => {
    for (const scope of ['project', 'workspace']) {
      const f = fixture(); await ready(f, result([], 'p'));
      f.label('记忆范围').value = scope; f.label('记忆范围').emit('change');
      await ready(f, result([record({scope, scope_id: scope === 'project' ? 'p' : 'ray'})], 'p'));
      f.button('撤销').emit('click');
      assert.match(f.dialog.textContent, /下次新请求生效/); assert.match(f.dialog.textContent, /已运行或排队任务不即时中断/);
      f.dialog.children[0].emit('submit');
      assert.equal(f.calls.at(-1).path, '/cloud-memory/revoke');
      assert.equal(JSON.parse(f.calls.at(-1).options.body).scope, scope);
    }
  });
  await test('revision conflict blocks replay until refresh', async () => {
    const f = fixture(); await ready(f); f.button('添加记忆').emit('click'); f.fields()[0].value = 'a'; f.fields()[1].value = 'b'; f.dialog.children[0].emit('submit');
    f.pending.at(-1).reject(new Error('HTTP 409 revision conflict')); await tick();
    assert.match(f.doc.body.textContent, /版本已变化/); assert.equal(f.button('保存').disabled, true);
    f.dialog.children[0].emit('submit'); assert.equal(f.calls.length, 2);
    f.button('取消').emit('click'); f.button('刷新').emit('click'); await ready(f); assert.equal(f.button('添加记忆').disabled, false);
  });
  await test('unknown write outcome blocks replay and requests receipt refresh', async () => {
    const f = fixture(); await ready(f); f.button('添加记忆').emit('click'); f.fields()[0].value = 'a'; f.fields()[1].value = 'b'; f.dialog.children[0].emit('submit');
    f.pending.at(-1).reject(new Error('network lost')); await tick(); assert.match(f.doc.body.textContent, /操作结果未确认/); assert.equal(f.button('添加记忆').disabled, true);
  });
  await test('project scope without membership can explicitly join', async () => {
    const f = fixture(); await ready(f); f.label('记忆范围').value = 'project'; f.label('记忆范围').emit('change'); await ready(f);
    assert.equal(f.button('添加记忆').disabled, true); f.label('共享项目').value = 'p'; f.button('应用项目设置').emit('click');
    assert.equal(f.calls.at(-1).path, '/cloud-memory/project'); const body = JSON.parse(f.calls.at(-1).options.body); assert.equal(body.project_id, 'p'); assert.equal(body.expected_revision, 2);
  });
  await test('joined project can explicitly leave and does not delete records', async () => {
    const f = fixture(); await ready(f, result([], 'p')); f.label('共享项目').value = ''; f.button('应用项目设置').emit('click');
    assert.equal(f.calls.at(-1).path, '/cloud-memory/project'); assert.equal(JSON.parse(f.calls.at(-1).options.body).project_id, '');
  });
  await test('late response after scope switch never enters current list', async () => {
    const f = fixture(); f.label('记忆范围').value = 'workspace'; f.label('记忆范围').emit('change');
    f.pending[1].resolve(result([record({scope: 'workspace', title: 'current'})])); await tick();
    f.pending[0].resolve(result([record({title: 'stale'})])); await tick(); assert.match(f.doc.body.textContent, /current/); assert.doesNotMatch(f.doc.body.textContent, /stale/);
  });
  await test('session navigation closes editor and rejects old scope result', async () => {
    const f = fixture(); await ready(f); f.button('添加记忆').emit('click'); f.fields()[0].value = 'private draft';
    await f.ctx.selectSession({id: 'b'}); assert.equal(f.dialog.open, false); assert.equal(f.fields()[0].value, '');
    assert.equal(f.calls.length, 2);
  });
  await test('markup remains text and list is bounded', async () => {
    const f = fixture(); await ready(f, result(Array.from({length: 300}, (_, i) => record({id: String(i), title: '<script>evil</script>', text: '<img src=x>'}))));
    assert.equal(f.find('hw-memory-row').length, 256); assert.equal(f.all().some(e => e.tagName === 'script' || e.tagName === 'img'), false);
  });
  await test('repeated append does not add card or fetch', () => {
    const f = fixture(); vm.runInContext(code, f.ctx); assert.equal(f.find('hw-memory-card').length, 1); assert.equal(f.calls.length, 1);
  });
  await test('knowledge view fixes project scope, filters kinds and locks explicit writes to knowledge', async () => {
    const f = fixture(); await ready(f, result([], 'p')); assert.equal(f.ctx.window.HandwaveMemory.setView('knowledge'), true);
    assert.match(f.calls.at(-1).path, /scope=project/); await ready(f, result([record({scope: 'project', kind: 'knowledge', title: 'Architecture'}), record({id: 'other', scope: 'project', kind: 'fact', title: 'not knowledge'})], 'p'));
    assert.equal(f.label('记忆范围').hidden, true); assert.match(f.doc.body.textContent, /Architecture/); assert.doesNotMatch(f.doc.body.textContent, /not knowledge/);
    f.button('添加知识').emit('click'); assert.equal(f.label('记忆类型').value, 'knowledge'); assert.equal(f.label('记忆类型').disabled, true);
    f.fields()[0].value = '约定'; f.fields()[1].value = '项目目录规则'; f.dialog.children[0].emit('submit');
    const payload = JSON.parse(f.calls.at(-1).options.body); assert.equal(payload.scope, 'project'); assert.equal(payload.kind, 'knowledge'); assert.equal(payload.expected_revision, 0);
    assert.equal(f.ctx.window.HandwaveMemory.setView('memory'), false); assert.equal(f.calls.length, 3);
  });
  await test('knowledge empty membership requires explicit project application', async () => {
    const f = fixture(); await ready(f); f.ctx.window.HandwaveMemory.setView('knowledge'); await ready(f);
    assert.equal(f.button('添加知识').disabled, true); assert.match(f.doc.body.textContent, /尚未加入共享项目/); assert.equal(f.find('hw-memory-group')[0].open, true);
    assert.equal(f.calls.filter(c => c.options).length, 0); f.label('共享项目').value = 'p'; f.button('应用项目设置').emit('click');
    assert.equal(f.calls.at(-1).path, '/cloud-memory/project'); assert.equal(JSON.parse(f.calls.at(-1).options.body).project_id, 'p');
  });
  await test('rapid view change invalidates same-project stale reads and restores remembered scope', async () => {
    const f = fixture(); await ready(f, result([], 'p')); f.label('记忆范围').value = 'project'; f.label('记忆范围').emit('change'); await ready(f, result([], 'p'));
    f.ctx.window.HandwaveMemory.setView('knowledge'); const old = f.pending.at(-1); f.ctx.window.HandwaveMemory.setView('memory');
    await ready(f, result([record({scope: 'project', kind: 'fact', title: 'current fact'})], 'p')); old.resolve(result([record({scope: 'project', kind: 'knowledge', title: 'stale knowledge'})], 'p')); await tick();
    assert.match(f.doc.body.textContent, /current fact/); assert.doesNotMatch(f.doc.body.textContent, /stale knowledge/); assert.equal(f.label('记忆范围').value, 'project'); assert.equal(f.label('记忆范围').hidden, false);
  });
  await test('UTF-8 content limit matches store bytes before issuing a write', async () => {
    const f = fixture(); await ready(f); f.button('添加记忆').emit('click'); f.fields()[0].value = 'length'; f.fields()[1].value = '中'.repeat(2731); f.dialog.children[0].emit('submit');
    assert.equal(f.calls.length, 1); assert.match(f.dialog.textContent, /超过 8 KiB/);
    f.fields()[1].value = '中'.repeat(2730) + 'ab'; f.dialog.children[0].emit('submit'); assert.equal(f.calls.length, 2); assert.equal(Buffer.byteLength(JSON.parse(f.calls.at(-1).options.body).text), 8192);
  });
  await test('memory editor isolates global new-session and command shortcuts without discarding draft', async () => {
    const f = fixture(); await ready(f); f.button('添加记忆').emit('click'); f.fields()[0].value = 'keep draft';
    for (const extra of [{key: 'n', ctrlKey: true}, {key: 'N', metaKey: true}, {key: '/', ctrlKey: true}, {key: '/', metaKey: true}]) {
      assert.equal(f.dialog.emit('keydown', extra).stopped, true); assert.equal(f.dialog.open, true); assert.equal(f.fields()[0].value, 'keep draft');
    }
    assert.equal(f.dialog.emit('keydown', {key: 'n'}).stopped, undefined); assert.equal(f.calls.length, 1);
  });
  await test('evolution seed uses existing editor with device default and explicit independent-copy notice', async () => {
    const f = fixture(); await ready(f);
    const seeded = f.ctx.window.HandwaveMemory.openLesson({owner: JSON.stringify(['w', 'fp', 'a']), title: '读取错误', text: '适用条件与原始证据'});
    await ready(f, result([], 'p')); assert.equal(await seeded, true); assert.equal(f.dialog.open, true);
    assert.equal(f.label('记忆类型').value, 'lesson'); assert.equal(f.label('云端经验保存范围').value, 'device'); assert.match(f.dialog.textContent, /独立云端副本/);
    f.label('云端经验保存范围').value = 'project'; f.label('云端经验保存范围').emit('change'); f.dialog.children[0].emit('submit');
    const body = JSON.parse(f.calls.at(-1).options.body); assert.equal(body.scope, 'project'); assert.equal(body.kind, 'lesson'); assert.equal(body.text, '适用条件与原始证据');
  });
  await test('evolution seed rejects stale owner and does not silently save', async () => {
    const f = fixture(); await ready(f); assert.equal(await f.ctx.window.HandwaveMemory.openLesson({owner: 'old', title: 'x', text: 'x'}), false);
    assert.equal(f.calls.length, 1); assert.equal(f.dialog.open, false);
    const seeded = f.ctx.window.HandwaveMemory.openLesson({owner: JSON.stringify(['w', 'fp', 'a']), title: 'x', text: 'x'});
    await f.ctx.selectSession({id: 'other'}); f.pending[1].resolve(result()); await tick(); assert.equal(await seeded, false); assert.equal(f.dialog.open, false);
  });
  await test('evolution project promotion requires existing membership and supports explicit global choice', async () => {
    const f = fixture(); await ready(f); const seeded = f.ctx.window.HandwaveMemory.openLesson({owner: JSON.stringify(['w', 'fp', 'a']), title: 'x', text: 'x'}); await ready(f); await seeded;
    f.label('云端经验保存范围').value = 'project'; f.label('云端经验保存范围').emit('change'); assert.equal(f.button('保存').disabled, true);
    f.label('云端经验保存范围').value = 'workspace'; f.label('云端经验保存范围').emit('change'); assert.equal(f.button('保存').disabled, false);
    f.dialog.children[0].emit('submit'); assert.equal(JSON.parse(f.calls.at(-1).options.body).scope, 'workspace');
  });
  await test('memory disclosure retains verified scope/count and normal refresh never reopens it', async () => {
    const f = fixture(); const card = f.find('hw-memory-card')[0];
    assert.equal(card.tagName, 'details'); assert.equal(card.open, false);
    await ready(f, result([record()])); assert.match(card.children[0].textContent, /云端记忆 · 本机 · 1 条/);
    assert.equal(card.open, false); card.open = true; card.open = false;
    f.button('刷新').emit('click'); await ready(f, result([record()])); assert.equal(card.open, false);
    assert.equal(f.ctx.window.HandwaveMemory.setView('memory'), true); assert.equal(card.open, true, 'same-view settings link reopens body');
    card.open = false; f.ctx.window.HandwaveMemory.setView('knowledge'); assert.equal(card.open, true);
    await ready(f, result([record({scope: 'project', kind: 'knowledge'})], 'p'));
    assert.match(card.children[0].textContent, /项目知识条目 · 项目 · 1 条/);
  });
  console.log(count + ' cloud memory UI fixture checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
