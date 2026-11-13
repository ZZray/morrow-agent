// Controlled DOM/signalling fixture, no real cloud or timer execution.
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/handwave_schedule.js', 'utf8');
class Element {
  constructor(tag, doc) { this.tagName = tag; this.className = ''; this.doc = doc; this.children = []; this.listeners = {}; this.dataset = {}; this.attrs = {}; this.open = false; this.disabled = false; this.value = ''; this._text = ''; }
  appendChild(e) { e.parentNode = this; this.children.push(e); return e; }
  replaceChildren() { this.children = []; this._text = ''; }
  set textContent(s) { this._text = String(s); this.children = []; } get textContent() { return this._text + this.children.map(e => e.textContent).join(''); }
  addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); }
  emit(k, extra = {}) { const e = {preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra}; for (const fn of this.listeners[k] || []) fn(e); return e; }
  setAttribute(k, v) { this.attrs[k] = v; } focus() { this.doc.activeElement = this; } showModal() { this.open = true; } close() { this.open = false; }
}
const walk = e => [e, ...e.children.flatMap(walk)];
function fixture(options = {}) {
  const doc = {}; doc.documentElement = new Element('html', doc); doc.body = doc.documentElement.appendChild(new Element('body', doc));
  const rail = doc.body.appendChild(new Element('div', doc)); rail.className = 'hw-context-body'; doc.querySelector = () => rail; doc.createElement = tag => new Element(tag, doc);
  const sent = [], timers = new Map(); let seq = 0;
  const link = {goal: {id: 'goal-a', revision: 2, status: 'paused', objective: '<img>排查'}, lease: {goal_id: 'goal-a', device: 'fp', session: 'w/a', expires_at: Math.floor(Date.now() / 1000) + 3600}, mirrorEpoch: 'writer1'};
  const ctx = {document: doc, window: {HandwaveLinks: {state: () => link}}, Intl, Date, Number, crypto: {randomUUID: () => 'unique-' + ++seq},
    setTimeout(fn) { const key = ++seq; timers.set(key, fn); return key; }, clearTimeout(key) { timers.delete(key); },
    curWS: {id: 'w', device_fp: 'fp'}, curSess: {id: 'a'}, paired: true, helloDone: true, localBusy: false,
    sendSig(signal) { sent.push(signal); return ctx.online; }, online: true, onSig() {},
    selectSession(s) { ctx.curSess = s; }, selectWorkspace(s) { ctx.curWS = s; ctx.curSess = null; }};
  vm.createContext(ctx); vm.runInContext(source, ctx); if (!options.noStatus) ctx.onSig({k: 'status', ...(options.oldHub ? {} : {hub_caps: ['schedule-resume-v1']})});
  const all = () => walk(doc.documentElement), find = cls => all().find(e => (e.className || '').split(' ').includes(cls));
  const button = text => all().find(e => e.tagName === 'button' && e.textContent === text);
  const result = (items, err) => ctx.onSig({k: 'schedule-result', id: sent.at(-1).id, ...(err ? {err} : {schedule: {items}})});
  const open = () => button('预约继续目标').emit('click');
  return {ctx, doc, link, sent, timers, find, button, all, result, open};
}
const row = (overrides = {}) => ({id: 's1', device: 'fp', goal_id: 'goal-a', session: 'w/a', expected_revision: 2, writer_epoch: 'writer1', due_at: Math.floor(Date.now() / 1000) + 300, status: 'scheduled', ...overrides});
(() => {
  let n = 0; const test = (name, fn) => { fn(); console.log('ok ' + ++n + ' - ' + name); };
  test('one compact card, no request on boot, no duplicate initialization', () => {
    const f = fixture(); assert.equal(f.find('hw-schedule-card').open, false); assert.equal(f.sent.length, 0); vm.runInContext(source, f.ctx); assert.equal(f.all().filter(e => e.className.includes('hw-schedule-card')).length, 1);
  });
  test('Hub capability is required, missing old-Hub declaration sends nothing, pairing preserves Hub capability', () => {
    for (const options of [{noStatus: true}, {oldHub: true}]) { const f = fixture(options); const card = f.find('hw-schedule-card'); card.open = true; card.emit('toggle'); f.button('刷新').emit('click'); f.open(); assert.equal(f.sent.length, 0); assert.equal(f.button('刷新').disabled, true); assert.equal(f.button('预约继续目标').disabled, true); }
    const old = fixture({oldHub: true}); assert.match(old.find('hw-schedule-card').textContent, /当前服务未支持预约/);
    const f = fixture(); f.ctx.onSig({k: 'paired'}); f.button('刷新').emit('click'); assert.equal(f.sent.length, 1);
    f.result([]); f.ctx.onSig({k: 'status', hub_caps: []}); f.button('刷新').emit('click'); assert.equal(f.sent.length, 1);
  });
  test('opening requests actual list; only current machine and session are counted', () => {
    const f = fixture(), card = f.find('hw-schedule-card'); card.open = true; card.emit('toggle'); assert.equal(f.sent[0].k, 'schedule-list');
    f.result([row(), row({id: 'other-device', device: 'fp2'}), row({id: 'other-session', session: 'w/b'})]); assert.match(card.children[0].textContent, /1 项/);
  });
  test('create dialog snapshots paused goal, sends datetime-local as UNIX seconds and no prompt', () => {
    const f = fixture(); f.open(); assert.equal(f.find('hw-schedule-dialog').open, true); assert.match(f.find('hw-schedule-objective').textContent, /<img>/);
    f.find('hw-schedule-dialog').children[0].emit('submit'); const signal = f.sent[0];
    assert.equal(signal.k, 'schedule-save'); assert.equal(signal.schedule.goal_id, 'goal-a'); assert.equal(signal.schedule.session, 'w/a'); assert.equal(signal.schedule.expected_revision, 2); assert.equal(signal.schedule.writer_epoch, 'writer1'); assert.ok(Number.isSafeInteger(signal.schedule.due_at)); assert.equal(signal.schedule.prompt, undefined);
    f.result([row({id: signal.schedule.id})]); assert.equal(f.find('hw-schedule-dialog').open, false);
  });
  test('running goal, missing lease, expired grant and pending command cannot create', () => {
    for (const mutate of [f => f.link.goal.status = 'running', f => f.link.lease = null, f => f.link.lease.expires_at = 1, f => f.link.pendingCommand = {id: 'cmd'}, f => f.ctx.paired = false]) {
      const f = fixture(); mutate(f); f.ctx.onSig({k: 'goal-state'}); assert.equal(f.button('预约继续目标').disabled, true); f.open(); assert.equal(f.find('hw-schedule-dialog').open, false);
    }
  });
  test('future/lease and changed revision gates precede send', () => {
    const f = fixture(); f.open(); const date = f.all().find(e => e.type === 'datetime-local'), form = f.find('hw-schedule-dialog').children[0]; date.value = '2001-01-01T00:00'; form.emit('submit'); assert.equal(f.sent.length, 0);
    date.value = '2099-01-01T00:00'; form.emit('submit'); assert.equal(f.sent.length, 0); f.link.goal.revision++; form.emit('submit'); assert.match(form.textContent, /目标已变化/);
  });
  test('pause/cancel operate only on future appointment and never send abort', () => {
    const f = fixture(); f.button('刷新').emit('click'); f.result([row()]); f.button('暂停预约').emit('click'); assert.equal(f.sent.at(-1).k, 'schedule-pause'); assert.deepEqual(JSON.parse(JSON.stringify(f.sent.at(-1).schedule)), {id: 's1'});
    f.result([row({status: 'paused'})]); f.button('取消预约').emit('click'); assert.equal(f.sent.at(-1).k, 'schedule-cancel'); assert.equal(f.sent.some(x => /abort|goal-command/.test(x.k)), false);
  });
  test('paused appointment restores only original unchanged payload and stale goal cannot restore', () => {
    const f = fixture(); f.button('刷新').emit('click'); f.result([row({status: 'paused'})]); f.button('恢复预约').emit('click');
    const s = f.sent.at(-1); assert.equal(s.k, 'schedule-save'); assert.equal(s.schedule.id, 's1'); assert.equal(s.schedule.expected_revision, 2);
    f.result([row({status: 'paused'})]); f.link.goal.revision = 3; f.ctx.onSig({k: 'goal-state'}); assert.equal(f.button('恢复预约').disabled, true);
  });
  test('unknown/triggered are truthful and have no retry controls', () => {
    const f = fixture(); f.button('刷新').emit('click'); f.result([row({status: 'unknown'}), row({id: 's2', status: 'triggered'})]); assert.match(f.find('hw-schedule-card').textContent, /结果未知，不自动重试/); assert.match(f.find('hw-schedule-card').textContent, /已继续（目标仍需验收）/); assert.equal(f.button('暂停预约'), undefined); assert.equal(f.button('重试'), undefined);
  });
  test('late correlated response after session change cannot populate selected view', () => {
    const f = fixture(); f.button('刷新').emit('click'); const id = f.sent[0].id; f.ctx.selectSession({id: 'b'}); f.ctx.onSig({k: 'schedule-result', id, schedule: {items: [row()]}}); assert.match(f.find('hw-schedule-card').children[0].textContent, /未加载/);
  });
  test('wrong correlation cannot settle write and timeout does not resend', () => {
    const f = fixture(); f.open(); f.find('hw-schedule-dialog').children[0].emit('submit'); f.ctx.onSig({k: 'schedule-result', id: 'wrong', schedule: {items: []}}); assert.equal(f.button('保存预约').disabled, true);
    [...f.timers.values()][0](); assert.equal(f.sent.length, 1); assert.match(f.find('hw-schedule-card').textContent, /结果未知/); assert.equal(f.button('保存预约').disabled, true); f.find('hw-schedule-dialog').children[0].emit('submit'); assert.equal(f.sent.length, 1);
    f.button('刷新').emit('click'); f.result([row()]); assert.equal(f.sent.length, 2);
  });
  test('offline send failure is visible; no local schedule is fabricated', () => {
    const f = fixture(); f.ctx.online = false; f.button('刷新').emit('click'); assert.match(f.find('hw-schedule-card').textContent, /云端连接不可用/); assert.match(f.find('hw-schedule-card').children[0].textContent, /未加载/);
  });
  test('Escape and task shortcuts stay inside dialog', () => {
    const f = fixture(); f.open(); const dialog = f.find('hw-schedule-dialog'); assert.equal(dialog.emit('keydown', {key: 'n', ctrlKey: true}).stopped, true); const e = dialog.emit('keydown', {key: 'Escape'}); assert.equal(e.stopped, true); assert.equal(dialog.open, false); assert.equal(f.sent.length, 0);
  });
  console.log(n + ' appointment UI checks passed (controlled DOM/signalling only).');
})();
