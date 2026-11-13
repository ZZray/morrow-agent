// Controlled DOM/API checks; native dialog layout and browser behavior need live acceptance.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/handwave_settings.js', 'utf8');
class Element {
  constructor(tag, doc) { this.tagName = tag; this.doc = doc; this.children = []; this.attrs = {}; this.listeners = {}; this.dataset = {}; this._text = ''; this.checked = false; this.disabled = false; this.open = false; this.value = ''; this.parentNode = null; this.classList = {add: value => { this.className = ((this.className || '') + ' ' + value).trim(); }}; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  get nextSibling() { if (!this.parentNode) return null; return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null; }
  get firstChild() { return this.children[0]; }
  appendChild(e) { if (e.parentNode) e.parentNode.children = e.parentNode.children.filter(c => c !== e); this.children.push(e); e.parentNode = this; return e; }
  replaceChildren(...children) { this.children = []; for (const e of children) this.appendChild(e); }
  insertBefore(e, before) { if (e.parentNode) e.parentNode.children = e.parentNode.children.filter(c => c !== e); e.parentNode = this; const n = this.children.indexOf(before); if (n < 0) return this.appendChild(e); this.children.splice(n, 0, e); return e; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); }
  emit(k, extra = {}) { if (this.disabled && k === 'click') return; const e = {defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.immediateStopped = true; }, ...extra}; for (const fn of this.listeners[k] || []) fn(e); return e; }
  focus() { this.doc.activeElement = this; }
  scrollIntoView(opts) { this.scrollOptions = opts; }
  show() { this.open = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
  escape() { const e = this.emit('cancel'); if (!e.defaultPrevented) this.close(); }
}
function all(e) { return [e, ...e.children.flatMap(all)]; }
function fixture(options = {}) {
  const doc = {}; doc.documentElement = new Element('html', doc); doc.body = doc.documentElement.appendChild(new Element('body', doc)); doc.createElement = tag => new Element(tag, doc); doc.createElementNS = (_, tag) => new Element(tag, doc);
  function element(tag, id, cls) { const e = doc.body.appendChild(new Element(tag, doc)); e.id = id; e.className = cls || ''; return e; }
  const trigger = element('button', 'accountTrigger'), menu = options.noMenu ? null : element('div', 'accountMenu');
  if (menu) { const logout = new Element('button', doc); logout.id = 'btnLogout'; menu.appendChild(logout); }
  const rail = element('details', 'contextRail'), memoryHost = element('div', '', 'hw-context-body'); rail.appendChild(memoryHost);
  let card = options.noCard || options.memory ? null : memoryHost.appendChild(new Element('section', doc)); if (card) card.className = 'hw-memory-card';
  const tree = element('div', 'wsTree');
  doc.getElementById = id => all(doc.documentElement).find(e => e.id === id) || null;
  doc.querySelector = selector => all(doc.documentElement).find(e => (e.className || '').split(' ').includes(selector.slice(1))) || null;
  let current = {enabled: true, include_memory: true, tab_accept: true, status: 'idle', summary: '', owner: {workspace_id: 'w', session_id: 's', device_fp: 'fp'}};
  const calls = [], listeners = {}, pending = [], storage = new Map(Object.entries(options.storage || {}));
  const ctx = {TextEncoder, localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)}, applyTheme(theme) { doc.documentElement.setAttribute('data-theme', theme); calls.push({theme}); }, document: doc, curWS: {id: 'w', device_fp: 'fp'}, curSess: {id: 's'}, closeAccountMenu() { calls.push({closeMenu: true}); }};
  ctx.window = {HandwaveSuggestions: options.noAPI ? null : {getState: () => current, setPreferences(p) { calls.push({prefs: p}); current = {...current, ...p}; return current; }, refresh() { calls.push({refresh: true}); return new Promise((resolve, reject) => pending.push({resolve, reject})); }}, addEventListener(k, fn) { (listeners[k] ||= []).push(fn); }};
  const tabMedia = {matches: !!options.mobileTabs, listeners: [], addEventListener(event, fn) { if (event === 'change') this.listeners.push(fn); }};
  ctx.window.matchMedia = query => { assert.equal(query, '(max-width: 680px)'); return tabMedia; };
  vm.createContext(ctx);
  if (options.skills) {
    const manager = element('dialog', 'skillManager');
    for (const id of ['skillName', 'skillDescription', 'skillContent', 'skillEditorTitle', 'skillEditorStatus', 'skillDelete', 'skillManagerSearch', 'skillManagerList', 'skillManagerStatus']) { const e = element('div', id); manager.appendChild(e); }
    element('button', 'btnAttach'); element('button', 'btnSkillManager'); element('button', 'skillManage');
    Object.assign(ctx, {$: doc.getElementById, el: (tag, cls, text) => { const e = doc.createElement(tag); e.className = cls; if (text) e.textContent = text; return e; }, skillCatalog: [{id: 'one', name: 'Review', description: 'Review source'}], skillLoading: false, skillError: '', skillSaving: false, skillGenerating: false, skillEditSeq: 0, editingSkill: null, api: () => new Promise(resolve => pending.push({resolve}))});
    ctx.window.confirm = () => options.discard !== false;
    vm.runInContext(fs.readFileSync(__dirname + '/../../../handwave/web/skills-ui.js', 'utf8'), ctx);
    ctx.loadSkills = () => { calls.push({loadSkills: true}); }; ctx.closeAttachMenu = () => {};
  }
  if (options.memory) {
    Object.assign(ctx, {crypto: {randomUUID: () => 'controlled-op'}, api: (path, options) => { calls.push({path, options}); return new Promise((resolve, reject) => pending.push({resolve, reject})); }, selectSession(s) { ctx.curSess = s; }, selectWorkspace(w) { ctx.curWS = w; ctx.curSess = null; }});
    if (options.unbound) ctx.curWS.device_fp = '';
    if (options.noWorkspace) ctx.curWS = null;
    vm.runInContext(fs.readFileSync(__dirname + '/handwave_memory.js', 'utf8'), ctx);
    card = doc.querySelector('.hw-memory-card');
  }
  vm.runInContext(source, ctx);
  const find = cls => all(doc.documentElement).filter(e => (e.className || '').split(' ').includes(cls));
  const button = text => all(doc.documentElement).find(e => e.tagName === 'button' && e.textContent === text);
  const emit = payload => { for (const fn of listeners['handwave:suggestion-state'] || []) fn({detail: payload}); };
  return {storage, tabMedia, ctx, doc, trigger, menu, rail, card, memoryHost, tree, calls, pending, find, button, emit, state: () => current, set(s) { current = {...current, ...s}; emit(current); }, dialog: doc.getElementById('hwSettingsDialog'), input: key => doc.getElementById('hwSetting_' + key)};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  let count = 0;
  async function test(name, fn) { await fn(); console.log('ok ' + ++count + ' - ' + name); }
  await test('no menu/API leaves page alone', () => { assert.equal(fixture({noMenu: true}).dialog, null); assert.equal(fixture({noAPI: true}).dialog, null); });
  await test('entry reuses account menu and installs once without requests', () => {
    const f = fixture(); vm.runInContext(source, f.ctx); assert.equal(f.find('hw-settings-dialog').length, 1);
    assert.equal(f.menu.children[0].textContent, '设置'); assert.equal(f.menu.children[0].attrs.role, 'menuitem'); assert.equal(f.menu.children[0].attrs['aria-haspopup'], 'dialog'); assert.equal(f.calls.length, 0);
  });
  await test('dialog opens explicitly, focuses selected tab, closes to account trigger', () => {
    const f = fixture(); f.button('设置').emit('click'); assert.equal(f.dialog.open, true); assert.equal(f.doc.activeElement, f.doc.getElementById('hwSettingsTab_general')); assert.equal(f.calls.length, 1);
    assert.equal(f.dialog.attrs['aria-labelledby'], 'hwSettingsTitle'); f.find('hw-settings-close')[0].emit('click'); assert.equal(f.dialog.open, false); assert.equal(f.doc.activeElement, f.trigger);
  });
  await test('native Escape cancel uses protected close and restores focus', () => { const f = fixture(); f.button('设置').emit('click'); f.dialog.escape(); assert.equal(f.dialog.open, false); assert.equal(f.doc.activeElement, f.trigger); });
  await test('each preference invokes exact public API and disabling suggestions gates controls', () => {
    const f = fixture(); for (const key of ['include_memory', 'tab_accept', 'enabled']) { f.input(key).checked = false; f.input(key).emit('change'); assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1).prefs)), {[key]: false}); }
    assert.equal(f.input('include_memory').disabled, true); assert.equal(f.input('tab_accept').disabled, true); assert.equal(f.button('刷新建议').disabled, true);
    assert.match(f.dialog.textContent, /不会关闭 Agent 执行时使用/);
  });
  await test('busy/loading/disabled/unknown/error cannot fabricate summary', () => {
    const f = fixture(); for (const status of ['busy', 'loading', 'disabled', 'missing', 'unavailable', 'idle']) {
      f.set({status, summary: 'must not show'}); assert.equal(f.find('hw-settings-summary')[0].textContent, '');
      assert.doesNotMatch(f.dialog.textContent, /must not show/);
    }
    f.set({status: 'busy'}); assert.match(f.dialog.textContent, /等待当前任务/); assert.equal(f.button('刷新建议').disabled, true);
    f.set({status: 'unavailable'}); assert.match(f.dialog.textContent, /生成失败或暂不可用/);
  });
  await test('ready summary uses text only and delayed event payload is ignored', () => {
    const f = fixture(); const text = '<img src=x onerror=alert(1)>\n公开结果'; f.set({status: 'ready', summary: text});
    assert.equal(f.find('hw-settings-summary')[0].textContent, text); assert.equal(all(f.doc.documentElement).some(e => e.tagName === 'img'), false);
    f.emit({status: 'ready', summary: 'stale event'}); assert.equal(f.find('hw-settings-summary')[0].textContent, text);
  });
  await test('owner mismatch hides old session summary even if state ready', () => {
    const f = fixture(); f.set({status: 'ready', summary: 'old', owner: {workspace_id: 'w', session_id: 'other', device_fp: 'fp'}});
    assert.equal(f.find('hw-settings-summary')[0].textContent, ''); assert.match(f.dialog.textContent, /尚未生成本会话/);
  });
  await test('refresh is explicit, does not submit a task, disables duplicate request and renders API state', async () => {
    const f = fixture(); f.button('设置').emit('click'); f.button('刷新建议').emit('click'); f.button('刷新建议').emit('click');
    assert.equal(f.pending.length, 1); assert.equal(f.button('刷新建议').disabled, true);
    f.set({status: 'ready', summary: '新的公开摘要'}); f.pending[0].resolve(f.state()); await tick();
    assert.equal(f.button('刷新建议').disabled, false); assert.equal(f.find('hw-settings-summary')[0].textContent, '新的公开摘要');
    assert.equal(f.calls.filter(c => c.refresh).length, 1);
  });
  await test('refresh rejection is visible without manufacturing successful content', async () => {
    const f = fixture(); f.button('刷新建议').emit('click'); f.pending[0].reject(new Error('secret transport detail')); await tick();
    assert.match(f.dialog.textContent, /建议未更新/); assert.doesNotMatch(f.dialog.textContent, /secret transport/); assert.equal(f.find('hw-settings-summary')[0].textContent, '');
  });
  await test('cloud memory link stays inside settings and restores the same card on close', () => {
    const f = fixture(), parent = f.card.parentNode; f.button('设置').emit('click');
    assert.equal(f.card.parentNode.className, 'hw-settings-memory-host');
    f.button('管理云端记忆').emit('click'); assert.equal(f.dialog.open, true);
    assert.equal(f.doc.activeElement.id, 'hwSettingsTab_memory'); assert.equal(f.find('hw-memory-card').length, 1);
    f.find('hw-settings-close')[0].emit('click'); assert.equal(f.card.parentNode, parent); assert.equal(f.calls.length, 1);
  });
  await test('missing memory card disables navigation and settings module stores no context', () => {
    const f = fixture({noCard: true}); assert.equal(f.button('管理云端记忆').disabled, true);
    assert.doesNotMatch(source, /sessionStorage|innerHTML/); assert.deepEqual([...f.storage.keys()], []);
  });

  await test('seven panels use roving keyboard tabs and preserve preference values', () => {
    const f = fixture(); f.button('设置').emit('click');
    const general = f.doc.getElementById('hwSettingsTab_general'), appearance = f.doc.getElementById('hwSettingsTab_appearance');
    assert.equal(f.find('hw-settings-tab').length, 7); assert.equal(general.attrs['aria-selected'], 'true');
    general.emit('keydown', {key: 'ArrowDown'}); assert.equal(f.doc.activeElement, appearance); assert.equal(appearance.tabIndex, 0); assert.equal(general.tabIndex, -1);
    assert.equal(f.doc.getElementById('hwSettingsPanel_general').hidden, true);
    appearance.emit('keydown', {key: 'End'}); assert.equal(f.doc.activeElement.id, 'hwSettingsTab_shortcuts');
    f.doc.activeElement.emit('keydown', {key: 'Home'}); assert.equal(f.doc.activeElement, general);
    assert.equal(f.calls.filter(c => c.prefs).length, 0);
  });
  await test('theme uses existing applyTheme and reduced motion persists only one boolean', () => {
    const f = fixture({storage: {'handwave.settings.reduce-motion': 'true'}});
    assert.equal(f.input('reduce_motion').checked, true); assert.equal(f.doc.documentElement.dataset.hwReduceMotion, 'true');
    f.button('亮色').emit('click'); assert.equal(f.doc.documentElement.getAttribute('data-theme'), 'light'); assert.equal(f.button('亮色').attrs['aria-pressed'], 'true');
    f.input('reduce_motion').checked = false; f.input('reduce_motion').emit('change');
    assert.equal(f.doc.documentElement.dataset.hwReduceMotion, 'false'); assert.deepEqual([...f.storage.entries()], [['handwave.settings.reduce-motion', 'false']]);
    assert.equal(f.calls.filter(c => c.prefs).length, 0);
  });
  await test('Escape is stopped before global task abort and uses guarded close', () => {
    const f = fixture(); f.button('设置').emit('click'); const event = f.dialog.emit('keydown', {key: 'Escape'});
    assert.equal(event.stopped, true); assert.equal(event.defaultPrevented, true); assert.equal(f.dialog.open, false);
  });
  await test('old skill entries open same inline node through capture interception', () => {
    const f = fixture({skills: true}), manager = f.doc.getElementById('skillManager');
    assert.equal(manager.parentNode.id, 'hwSettingsPanel_skills'); assert.equal(f.doc.getElementById('btnSkillManager').hidden, true);
    const event = f.doc.getElementById('skillManage').emit('click');
    assert.equal(event.immediateStopped, true); assert.equal(manager.open, true); assert.equal(f.dialog.open, true);
    assert.equal(f.calls.filter(c => c.loadSkills).length, 1);
    f.doc.getElementById('hwSettingsTab_general').emit('click'); f.doc.getElementById('hwSettingsTab_skills').emit('click');
    assert.equal(f.calls.filter(c => c.loadSkills).length, 1); assert.equal(f.doc.getElementById('skillManager'), manager);
  });
  await test('actual skill owner preserves dirty draft across tabs and declined close', () => {
    const f = fixture({skills: true, discard: false}); f.doc.getElementById('skillManage').emit('click');
    f.doc.getElementById('skillName').value = 'unsaved'; f.doc.getElementById('hwSettingsTab_general').emit('click');
    f.find('hw-settings-close')[0].emit('click');
    assert.equal(f.dialog.open, true); assert.equal(f.doc.getElementById('skillManager').open, true); assert.equal(f.doc.getElementById('skillName').value, 'unsaved');
  });
  await test('busy skill save and generation block close and workspace navigation', () => {
    for (const key of ['skillSaving', 'skillGenerating']) {
      const f = fixture({skills: true}); f.doc.getElementById('skillManage').emit('click'); f.ctx[key] = true;
      f.dialog.emit('keydown', {key: 'Escape'}); assert.equal(f.dialog.open, true); assert.match(f.dialog.textContent, /技能正在保存或生成/);
      f.button('管理云端记忆').emit('click'); f.button('选择工作区').emit('click'); assert.equal(f.dialog.open, true); assert.equal(f.rail.open, false);
      f.ctx[key] = false; f.find('hw-settings-close')[0].emit('click'); assert.equal(f.dialog.open, false); assert.equal(f.doc.activeElement, f.trigger);
    }
  });
  await test('actual skill close invalidates delayed detail and restores account focus', async () => {
    const f = fixture({skills: true}); f.doc.getElementById('skillManage').emit('click');
    const manager = f.doc.getElementById('skillManager'), list = f.doc.getElementById('skillManagerList');
    const read = list.children[0].onclick(); assert.equal(f.pending.length, 1);
    f.find('hw-settings-close')[0].emit('click'); assert.equal(manager.open, false); assert.equal(f.dialog.open, false);
    f.pending[0].resolve({id: 'one', name: 'late', description: '', content: 'late content'}); await read;
    assert.equal(f.doc.getElementById('skillName').value, ''); assert.equal(f.doc.activeElement, f.trigger);
  });
  await test('memory tab preserves skill draft; selecting workspace uses existing discard gate', () => {
    const f = fixture({skills: true}); f.doc.getElementById('skillManage').emit('click'); f.doc.getElementById('skillName').value = 'draft';
    f.button('管理云端记忆').emit('click'); assert.equal(f.dialog.open, true); assert.equal(f.doc.getElementById('skillName').value, 'draft');
    f.button('选择工作区').emit('click'); assert.equal(f.dialog.open, false); assert.equal(f.doc.getElementById('skillName').value, '');
    assert.equal(f.doc.activeElement, f.tree); assert.equal(f.card.parentNode, f.memoryHost);
  });
  await test('real memory module is reparented without extra loads and Escape only closes its editor', async () => {
    const f = fixture({memory: true}); f.pending[0].resolve({binding: {workspace_id: 'w', device_fp: 'fp', revision: 1}, projects: [], records: []}); await tick();
    const editor = f.find('hw-memory-dialog').find(d => d !== f.dialog);
    f.button('设置').emit('click'); f.button('管理云端记忆').emit('click');
    assert.equal(f.calls.filter(c => c.path).length, 1); assert.match(f.card.textContent, /工作区：w.*电脑指纹：fp/);
    f.button('添加记忆').emit('click'); assert.equal(editor.open, true);
    const event = editor.emit('keydown', {key: 'Escape'}); assert.equal(event.stopped, true); assert.equal(editor.open, false); assert.equal(f.dialog.open, true);
    assert.equal(f.doc.activeElement, f.button('刷新')); assert.equal(f.card.parentNode.className, 'hw-settings-memory-host');
    f.dialog.emit('keydown', {key: 'Escape'}); assert.equal(f.card.parentNode, f.memoryHost);
  });
  await test('no workspace and unbound workspace show actionable real state without automatic binding', () => {
    for (const options of [{noWorkspace: true}, {unbound: true}]) {
      const f = fixture({memory: true, ...options}); f.button('设置').emit('click'); f.button('管理云端记忆').emit('click');
      assert.match(f.card.textContent, options.noWorkspace ? /尚未选择工作区/ : /尚未绑定电脑/); assert.equal(f.button('添加记忆').disabled, true);
      assert.equal(f.calls.filter(c => c.path).length, 0); f.button('选择工作区').emit('click'); assert.equal(f.doc.activeElement, f.tree);
    }
  });
  await test('memory write pending and unknown outcome survive settings close/reopen without retry', async () => {
    const f = fixture({memory: true}); const data = {binding: {workspace_id: 'w', device_fp: 'fp', revision: 1}, projects: [], records: []}; f.pending[0].resolve(data); await tick();
    f.button('设置').emit('click'); f.button('管理云端记忆').emit('click'); f.button('添加记忆').emit('click');
    const editor = f.find('hw-memory-dialog').find(d => d !== f.dialog), fields = f.find('hw-memory-field'); fields[0].children[0].value = 'fact'; fields[1].children[0].value = 'content'; editor.children[0].emit('submit');
    editor.emit('keydown', {key: 'Escape'}); f.find('hw-settings-close')[0].emit('click'); f.button('设置').emit('click');
    assert.equal(f.button('添加记忆').disabled, true); assert.equal(f.calls.filter(c => c.path).length, 2);
    f.pending[1].reject(new Error('unknown outcome')); await tick(); f.find('hw-settings-close')[0].emit('click'); f.button('设置').emit('click');
    assert.match(f.card.textContent, /操作结果未确认/); assert.equal(f.button('添加记忆').disabled, true); assert.equal(f.calls.filter(c => c.path).length, 2);
  });
  await test('knowledge tab uses the same card, returns to memory on close and preserves skill discard refusal', async () => {
    const f = fixture({memory: true, skills: true, discard: false}); const data = {binding: {workspace_id: 'w', device_fp: 'fp', project_id: 'p', revision: 1}, projects: [], records: []};
    f.pending[0].resolve(data); await tick(); f.doc.getElementById('skillManage').emit('click'); f.doc.getElementById('skillName').value = 'draft';
    f.doc.getElementById('hwSettingsTab_knowledge').emit('click'); f.pending.at(-1).resolve(data); await tick();
    assert.equal(f.card.parentNode.parentNode.id, 'hwSettingsPanel_knowledge'); assert.equal(f.find('hw-memory-card').length, 1); assert.ok(f.button('添加知识'));
    f.find('hw-settings-close')[0].emit('click'); assert.equal(f.dialog.open, true); assert.ok(f.button('添加知识'));
    f.ctx.window.confirm = () => true; f.find('hw-settings-close')[0].emit('click'); assert.equal(f.dialog.open, false); assert.equal(f.card.parentNode, f.memoryHost); assert.ok(f.button('添加记忆'));
  });
  await test('tab semantics follow compact breakpoint without changing selection or fetching', () => {
    for (const mobileTabs of [false, true]) {
      const f = fixture({mobileTabs}), nav = f.find('hw-settings-nav')[0];
      assert.equal(nav.attrs['aria-orientation'], mobileTabs ? 'horizontal' : 'vertical');
      f.button('设置').emit('click'); f.doc.getElementById('hwSettingsTab_knowledge').emit('click');
      const calls = f.calls.length; f.tabMedia.matches = !mobileTabs; for (const fn of f.tabMedia.listeners) fn();
      assert.equal(nav.attrs['aria-orientation'], mobileTabs ? 'vertical' : 'horizontal');
      assert.equal(f.doc.getElementById('hwSettingsTab_knowledge').attrs['aria-selected'], 'true'); assert.equal(f.calls.length, calls);
    }
  });
  console.log(count + ' settings VM checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
