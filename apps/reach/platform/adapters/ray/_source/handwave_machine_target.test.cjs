'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto');
const code = fs.readFileSync(__dirname + '/handwave_machine_target.js', 'utf8');
const pinned = fs.readFileSync(__dirname + '/testdata/handwave-app-7ae318fe.js');
assert.equal(crypto.createHash('sha256').update(pinned).digest('hex'), '7ae318fe13a6fd35cd652c3fed7ee51134ca7808d14aab8f1be0c18aa44a15b2');
const source = pinned.toString('utf8'); const from = source.indexOf('function onSig(s)'), to = source.indexOf('function onFrame(f)', from); assert(from > 0 && to > from);
function fixture(options = {}) {
  const sent = [], frames = [], notices = {textContent: ''}, header = {textContent: '已连接 · Old', className: 'state on', attrs: {}, setAttribute(k, v) {this.attrs[k] = v;}}, timers = new Map(); let next = 0, closes = 0, binding;
  const c = {window: {}, document: {querySelector: () => notices, getElementById: id => id === 'connState' ? header : null}, curWS: {id: 'w', device_fp: 'old'}, curSess: {id: 's'}, myFP: 'ctl',
    devices: [], paired: options.paired !== false, helloDone: true, localBusy: false, sending: false,
    setTimeout: (fn, delay) => { const id = ++next; timers.set(id, {fn, delay}); return id; }, clearTimeout: id => timers.delete(id), Date,
    sendSig(signal) { sent.push(signal); return options.send !== false; }, newToolId: () => 'switch-' + ++next,
    closePC() { closes++; }, setConnState(text, kind) {header.textContent = text; header.className = 'state ' + kind;}, $: () => ({classList: {add() {}}, disabled: false}), helloTimer: null,
    renderDevices() {}, syncRailDeviceLabels() {}, addBubble() {}, showToast() {}, handleOffer() {}, pendingCands: [], remoteSet: false, pc: null,
    onFrame(frame) { frames.push(frame); if (frame.k === 'node-hello') { c.helloDone = true; c.setConnState('已连接 · ' + (frame.info.hostname || 'remote'), 'on'); binding = () => {c.curWS.device_fp = frame.fp; c.syncRailDeviceLabels();}; if (!options.deferBinding) binding(); } },
    selectSession(s) { c.curSess = s; return Promise.resolve(); }, selectWorkspace(w) {c.curWS = w; c.curSess = null; return Promise.resolve();}
  };
  vm.createContext(c); vm.runInContext(source.slice(from, to), c); vm.runInContext(code, c);
  const device = overrides => ({nid: 'node', fp: 'target', name: 'Target', state: 'approved', by: 'ctl', ...overrides});
  const status = (rows = [device()], caps = ['connect-approved-v1']) => c.onSig({k: 'status', d: JSON.stringify(rows), hub_caps: caps});
  status();
  const select = (d = c.devices[0]) => c.window.HandwaveMachineTarget(d);
  const request = () => sent.findLast(s => s.k === 'connect-approved');
  const ack = overrides => { const r = request(); c.onSig({k: 'connect-approved-result', id: r.id, nid: r.nid, fp: r.fp, msg: 'connected', ...overrides}); };
  const hello = (fp, hostname) => c.onFrame({k: 'node-hello', fp: fp || 'target', info: hostname ? {hostname} : {}});
  const pair = () => c.onSig({k: 'paired'});
  return {c, sent, frames, notices, header, timers, device, status, select, request, ack, hello, pair, bind: () => binding(), closes: () => closes};
}
let count = 0; function test(name, fn) { fn(); console.log('ok ' + ++count + ' - ' + name); }
test('legacy Hub cap absence blocks selection without disconnect or approval', () => {const f = fixture(); f.status([f.device()], []); assert.equal(f.select(), false); assert.equal(f.sent.length, 0); });
test('uses exact online nid/fp and existing controller approval', () => {for (const bad of [{state: 'approved-offline'}, {state: 'pending'}, {by: 'other'}, {exp: new Date(Date.now() - 1000).toISOString()}, {exp: 'bad'}]) {const f = fixture(); f.status([f.device(bad)]); assert.equal(f.select(), false); assert.equal(f.sent.length, 0);} });
test('accepts explicit mine only when by is absent, never contradictory owner', () => {let f = fixture(); f.status([f.device({by: '', mine: true})]); assert.equal(f.select(), true); f = fixture(); f.status([f.device({by: 'other', mine: true})]); assert.equal(f.select(), false); });
test('busy state never disconnects or retargets', () => {const f = fixture(); f.c.localBusy = true; assert.equal(f.select(), false); assert.equal(f.sent.length, 0); });
test('switch sends bye then connect-approved and never ttl/approve', () => {const f = fixture(); assert.equal(f.select(), true); assert.deepEqual(f.sent.map(x => x.k), ['bye', 'connect-approved']); assert.equal(f.request().nid, 'node'); assert.equal(f.request().fp, 'target'); assert.equal(f.request().relay, true); assert(!Object.hasOwn(f.request(), 'ttl')); assert.equal(f.c.paired, false); assert.match(f.notices.textContent, /正在接入/); });
test('connected receipt alone cannot mark success', () => {const f = fixture(); f.select(); f.ack(); assert.match(f.notices.textContent, /正在接入/); assert.equal(f.c.helloDone, false); });
test('pinned paired signal and exact node hello plus receipt complete target', () => {const f = fixture(); f.select(); f.c.onSig({k: 'unpaired'}); f.pair(); f.ack(); f.hello(); assert.equal(f.c.curWS.device_fp, 'target'); assert.match(f.notices.textContent, /已接入 Target/); assert.equal(f.sent.some(x => x.k === 'approve'), false); });
test('fast hello before result waits for exact approval receipt', () => {const f = fixture(); f.select(); f.pair(); f.hello(); assert.doesNotMatch(f.notices.textContent, /已接入 Target/); f.ack(); assert.match(f.notices.textContent, /已接入 Target/); });
test('node hello waits for original workspace PATCH binding acknowledgement', () => {const f = fixture({deferBinding: true}); f.select(); f.pair(); f.ack(); f.hello(); assert.match(f.notices.textContent, /正在确认工作区绑定/); assert.equal(f.c.curWS.device_fp, 'old'); f.bind(); assert.match(f.notices.textContent, /已接入 Target/); });
test('wrong node hello is blocked before original handler can rebind workspace', () => {const f = fixture(); f.select(); f.pair(); f.ack(); f.hello('wrong'); assert.equal(f.frames.length, 0); assert.equal(f.c.curWS.device_fp, 'old'); assert.match(f.notices.textContent, /身份不匹配/); });
test('mismatched/late acknowledgement cannot establish success', () => {const f = fixture(); f.select(); f.ack({id: 'old'}); f.pair(); f.hello(); assert.doesNotMatch(f.notices.textContent, /已接入 Target/); f.ack({msg: 'approval-owner', err: 'not yours'}); assert.match(f.notices.textContent, /not yours/); assert.equal(f.c.paired, false); });
test('timeout fences late handshake and leaves task unsent', () => {const f = fixture(); f.select(); const timeout = [...f.timers.values()].find(t => t.delay === 15000); timeout.fn(); assert.match(f.notices.textContent, /连接超时/); f.pair(); f.hello(); assert.equal(f.frames.length, 0); assert.equal(f.c.curWS.device_fp, 'old'); });
test('session navigation cancels pending switch and fences late original binding', () => {const f = fixture(); f.select(); f.c.selectSession({id: 'new'}); f.pair(); f.hello(); assert.equal(f.frames.length, 0); assert.equal(f.c.curWS.device_fp, 'old'); assert.match(f.notices.textContent, /会话已变化/); });
test('external disconnect supersedes switch without automatic replay', () => {const f = fixture(); f.select(); f.c.sendSig({k: 'bye'}); const count = f.sent.filter(s => s.k === 'connect-approved').length; f.ack(); f.hello(); assert.equal(f.frames.length, 0); assert.equal(f.sent.filter(s => s.k === 'connect-approved').length, count); });
test('socket send failure is explicit and does not claim target connected', () => {const f = fixture({send: false}); assert.equal(f.select(), false); assert.match(f.notices.textContent, /无法断开/); assert.equal(f.sent.some(x => x.k === 'connect-approved'), false); });
test('duplicate action while connecting is rejected and no authorization mutation occurs', () => {const f = fixture(); assert(f.select()); assert.equal(f.select(), false); assert.equal(f.sent.filter(s => s.k === 'connect-approved').length, 1); assert.equal(f.sent.some(s => ['approve', 'setttl', 'revoke', 'deny'].includes(s.k)), false); });
test('persistent existing header uses actual hello name only after receipt and binding', () => {const f = fixture({deferBinding: true}); f.select(); f.pair(); f.hello('target', 'RAYWORK actual'); assert.match(f.header.textContent, /正在接入/); assert.equal(f.header.className, 'state busy'); f.ack(); assert.match(f.header.textContent, /正在接入/); f.bind(); assert.equal(f.header.textContent, '目标 · RAYWORK actual'); assert.equal(f.header.title, '执行目标：RAYWORK actual · target'); assert.equal(f.header.attrs['aria-label'], f.header.title); f.notices.textContent = '计划模式只读'; assert.equal(f.header.textContent, '目标 · RAYWORK actual');});
test('failed handshake clears old target in existing header without claiming rollback', () => {const f = fixture(); f.select(); f.pair(); f.ack(); f.hello('wrong', 'Wrong'); assert.equal(f.header.textContent, '目标未连接'); assert.equal(f.header.className, 'state off'); assert.doesNotMatch(f.header.title, /Old|Wrong/); assert.equal(f.sent.filter(s => s.k === 'connect-approved').length, 1);});
test('bye, unpair and websocket state remove persistent verified target', () => {for (const action of ['bye', 'unpair', 'socket']) {const f = fixture(); f.select(); f.pair(); f.ack(); f.hello('target', 'Verified'); if (action === 'bye') f.c.sendSig({k: 'bye'}); else if (action === 'unpair') f.c.onSig({k: 'unpaired'}); else f.c.setConnState('hub 已断开', 'off'); assert.doesNotMatch(f.header.textContent, /Verified/); assert.doesNotMatch(f.header.title, /Verified/);}});
test('same current target still obtains fresh non-authorizing receipt without disconnect', () => {const f = fixture(); f.select(); f.pair(); f.ack(); f.hello('target', 'Current'); const before = f.sent.length; f.select(); assert.deepEqual(f.sent.slice(before).map(s => s.k), ['connect-approved']); assert.match(f.header.textContent, /正在接入/); f.ack({msg: 'already-connected'}); assert.equal(f.header.textContent, '目标 · Current');});
test('new workspace cannot retain a verified target label from old workspace', () => {const f = fixture(); f.select(); f.pair(); f.ack(); f.hello('target', 'Current'); f.c.selectWorkspace({id: 'other', device_fp: 'different'}); assert.equal(f.header.textContent, '目标未连接'); assert.doesNotMatch(f.header.title, /Current/);});
test('transport cleanup clears handshake timer and target without sending or changing grant', () => {const f = fixture(); f.select(); const count = f.sent.length; assert([...f.timers.values()].some(t => t.delay === 15000)); f.c.window.HandwaveMachineTransportLost(); assert.equal(f.sent.length, count); assert(![...f.timers.values()].some(t => t.delay === 15000)); assert.equal(f.header.textContent, '目标未连接'); assert.equal(f.c.curWS.device_fp, 'old'); assert.equal(f.select(), false); f.status(); assert(f.select());});
(async () => {
  // Execute the actual pinned node-hello handler with the adapter's literal edit
  // table, including a deferred real Promise PATCH acknowledgement.
  const go = fs.readFileSync(__dirname + '/handwave_ui.go', 'utf8');
  const table = go.slice(go.indexOf('func adaptHandWaveNodeBinding('), go.indexOf('// These exact UI-only edits'));
  const edits = [...table.matchAll(/\{("(?:\\.|[^"\\])*")\s*,\s*("(?:\\.|[^"\\])*")\}/g)].map(m => [JSON.parse(m[1]), JSON.parse(m[2])]);
  assert.equal(edits.length, 2); let adapted = source;
  for (const [before, after] of edits) { assert.equal(adapted.split(before).length - 1, 1); adapted = adapted.replace(before, after); }
  const start = adapted.indexOf('function onFrame(f)'), end = adapted.indexOf('function renderDevices()', start);
  let release; let syncs = 0;
  const originalWorkspace = {id: 'a', device_fp: 'old'};
  const c = {curWS: originalWorkspace, curSess: {id: 'a'}, helloDone: false, helloTimer: null, clearTimeout() {}, setConnState() {}, el: () => ({}),
    $: () => ({classList: {remove() {}}, appendChild() {}, innerHTML: ''}), localTasks: new Map(), renderLocalBoard() {}, wsCache: [],
    api: () => new Promise(resolve => {release = resolve;}), syncRailDeviceLabels: () => {syncs++;}
  };
  vm.createContext(c); vm.runInContext(adapted.slice(start, end), c); c.onFrame({k: 'node-hello', fp: 'target', info: {}});
  c.curWS = {id: 'b', device_fp: 'keep'}; c.curSess = {id: 'b'}; release({}); await new Promise(r => setImmediate(r));
  assert.equal(c.curWS.device_fp, 'keep'); assert.equal(syncs, 0); assert.equal(originalWorkspace.device_fp, 'old');
  console.log('ok ' + ++count + ' - pinned deferred node-hello PATCH cannot rebind a newly selected workspace');
  console.log(count + ' machine target checks passed');
})().catch(e => {console.error(e); process.exitCode = 1;});
