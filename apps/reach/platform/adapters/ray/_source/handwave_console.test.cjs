'use strict';
// Controlled DOM/transport tests. Real process and browser acceptance are separate.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const code = fs.readFileSync(__dirname + '/handwave_console.js', 'utf8');
for (const [file, expected] of [['xterm-6.0.0.js', '14903579ff54664cd72f8e8699e6961a6272c21863ec1c3b118cdc8af5d4a972'], ['xterm-6.0.0.css', '854a7c0fb70e8b1a083c16797ab827299fb18744f5ad34f227b48337e33293c6'], ['addon-fit-0.11.0.js', 'ba3ea256ce0620a0992a197d6c9baea64823fc93d8da07a9e366ca9943c18527']]) {
  assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(__dirname + '/vendor/xterm/' + file)).digest('hex'), expected);
}
class Element {
  constructor(tag) { Object.assign(this, {tagName: tag, children: [], attrs: {}, listeners: {}, value: '', dataset: {}, _text: '', open: false}); }
  appendChild(e) { this.children.push(e); return e; }
  replaceChildren() { this.children = []; this._text = ''; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(e => e.textContent).join(''); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(k, f) { (this.listeners[k] ||= []).push(f); }
  emit(k) { for (const f of this.listeners[k] || []) f({preventDefault() {}}); }
}
const walk = e => [e, ...e.children.flatMap(walk)];
function fixture(caps = ['interactive-jobs-v1'], storage = new Map(), options = {}) {
  const root = new Element('html'), rail = root.appendChild(new Element('div'));
  const doc = {documentElement: root, hidden: false, querySelector: () => rail, createElement: tag => new Element(tag)};
  const sent = [], timers = new Map(), delays = new Map(), terminals = [], observers = []; let id = 0;
  const state = {capabilities: caps, goal: {id: 'g', status: 'running'}, lease: {allow_jobs: true, expires_at: Date.now() / 1000 + 3600}};
  const c = {document: doc, window: {HandwaveLinks: {state: () => state}}, curWS: {id: 'w', device_fp: 'fp'}, curSess: {id: 's'}, myFP: 'controller', paired: true, helloDone: true, crypto: {randomUUID: () => String(++id)}, Date, TextEncoder,
    sessionStorage: {getItem(k) { return storage.get(k) || null; }, setItem(k, v) { storage.set(k, v); }, removeItem(k) { storage.delete(k); }},
    sendSig(s) { sent.push(JSON.parse(JSON.stringify(s))); }, onSig() {}, onFrame() {}, selectWorkspace(w) { c.curWS = w; }, selectSession(s) { c.curSess = s; },
    setTimeout(f, ms) { const n = ++id; timers.set(n, f); delays.set(n, ms); return n; }, clearTimeout(n) { timers.delete(n); delays.delete(n); }, setInterval(f, ms) { if (ms === 150) c.fastTick = f; else c.tick = f; }};
  const dimensions = {cols: 40, rows: 14};
  if (options.terminal) {
    const {Terminal} = require('./vendor/xterm/xterm-6.0.0.js');
    c.window.Terminal = class extends Terminal {
      constructor(settings) { super(settings); terminals.push(this); if (options.missingSource) this._core.coreService.onUserInput = undefined; }
      open() {} loadAddon() {} focus() {}
    };
    c.window.FitAddon = {FitAddon: class {proposeDimensions() { return {...dimensions}; }}};
    c.ResizeObserver = class {constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; }};
  }
  vm.createContext(c); vm.runInContext(code, c);
  const find = label => walk(root).find(e => e.attrs['aria-label'] === label), card = rail.children[0];
  const reply = (request, data, extra = {}) => c.onSig({...request, k: 'job-command-result', job_ok: true, job_data: data, ...extra});
  function open() { card.open = true; card.emit('toggle'); }
  function listed() { open(); reply(sent.find(s => s.job_action === 'list'), {jobs: [{job_id: 'j', state: 'running', interactive: true, stdin_closed: false}]}); }
  const flush = ms => { for (const [n, f] of [...timers]) if (delays.get(n) === ms) { timers.delete(n); delays.delete(n); f(); } };
  return {c, root, state, sent, timers, card, find, reply, open, listed, storage, terminals, observers, dimensions, flush};
}
{
  const f = fixture(); assert.equal(f.card.open, false); assert.equal(f.sent.length, 0); f.listed();
  const input = f.find('发送至进程的输入'); assert.equal(input.type, 'password'); assert.equal(input.disabled, false);
  input.value = 'secret'; walk(f.root).find(e => e.tagName === 'form').emit('submit');
  const req = f.sent.find(s => s.job_action === 'input'); assert.equal(req.job_text, 'secret\n'); assert.equal(input.value, ''); assert(input.disabled);
  f.reply(req, {state: 'written', eof: false, effects_unknown: false}); assert.equal(input.disabled, false);
  const before = f.find('进程输出').textContent; f.reply(req, {state: 'written'}); assert.equal(f.find('进程输出').textContent, before);
  f.find('关闭标准输入').emit('click'); const close = f.sent.filter(s => s.job_action === 'input').at(-1); assert(close.job_eof); assert.equal(close.job_text, '');
  f.reply(close, {state: 'written', eof: true}); assert(input.disabled);
}
{
  const f = fixture(); f.listed(); const input = f.find('发送至进程的输入'); input.value = 'once'; walk(f.root).find(e => e.tagName === 'form').emit('submit');
  for (const callback of [...f.timers.values()]) callback();
  assert.equal(f.sent.filter(s => s.job_action === 'input').length, 1); assert(input.disabled); assert.equal(f.find('核对上次输入结果').hidden, false);
  f.find('核对上次输入结果').emit('click'); const check = f.sent.at(-1); assert.equal(check.job_action, 'input_status'); assert.equal(check.job_text, undefined);
  f.reply(check, {state: 'written', effects_unknown: false}); assert.equal(input.disabled, false);
}
{
  const f = fixture(); f.listed(); const input = f.find('发送至进程的输入'); input.value = 'discard'; f.c.onSig({k: 'unpaired'}); assert.equal(input.value, '');
  const old = f.sent.find(s => s.job_action === 'list'); f.c.selectSession({id: 'other'}); f.reply(old, {jobs: [{job_id: 'leak', state: 'running'}]}); assert(!f.root.textContent.includes('leak'));
  input.value = 'gone'; f.c.paired = false; f.c.tick(); assert.equal(input.value, ''); assert(input.disabled);
}
{
  const f = fixture([]); f.open(); assert.equal(f.sent.length, 0); assert(f.root.textContent.includes('尚未支持'));
}
{
  const f = fixture(); f.listed(); const req = f.sent.find(s => s.job_action === 'log' && s.job_stream === 'stdout');
  f.reply(req, {stream: 'stdout', cursor: 0, next_cursor: 20, text: '<script>literal</script>'}); assert.equal(f.find('进程输出').textContent, '<script>literal</script>');
  f.reply(req, {stream: 'stdout', cursor: 0, next_cursor: 40, text: 'duplicate'}); assert(!f.find('进程输出').textContent.includes('duplicate'));
}
{
  const f = fixture(); f.listed(); f.state.goal.status = 'paused'; f.c.tick(); assert(f.find('发送至进程的输入').disabled);
  f.state.goal.status = 'running'; f.state.lease.expires_at = 0; f.c.tick(); assert(f.find('发送至进程的输入').disabled); assert.equal(f.find('停止进程树').disabled, false);
}
{
  const f = fixture(); f.open(); f.reply(f.sent[0], {jobs: [{job_id: 'a', state: 'running', interactive: true, stdin_closed: false}, {job_id: 'b', state: 'running', interactive: true, stdin_closed: false}]});
  const stale = f.sent.find(s => s.job_action === 'log' && s.job_id === 'a' && s.job_stream === 'stdout');
  const select = f.find('选择托管进程'); select.value = 'b'; select.emit('change'); select.value = 'a'; select.emit('change');
  f.reply(stale, {cursor: 0, next_cursor: 8192, stream: 'stdout', text: 'stale'}); assert.equal(f.find('进程输出').textContent, '');
  const current = f.sent.filter(s => s.job_action === 'log' && s.job_id === 'a' && s.job_stream === 'stdout').at(-1); assert.equal(current.job_cursor, 0);
  f.reply(current, {cursor: 0, next_cursor: 5, stream: 'stdout', text: 'fresh'}); assert.equal(f.find('进程输出').textContent, 'fresh');
}
{
  const f = fixture(); f.listed(); f.find('发送至进程的输入').value = 'never-store-this'; walk(f.root).find(e => e.tagName === 'form').emit('submit');
  assert.equal(f.storage.size, 1); assert(![...f.storage.values()][0].includes('never-store-this'));
  const reloaded = fixture(['interactive-jobs-v1'], f.storage); reloaded.listed(); assert(reloaded.find('发送至进程的输入').disabled);
  reloaded.find('核对上次输入结果').emit('click'); const query = reloaded.sent.at(-1); assert.equal(query.job_action, 'input_status');
  assert.equal(reloaded.sent.filter(s => s.job_action === 'input').length, 0); reloaded.reply(query, {state: 'written'}); assert.equal(reloaded.storage.size, 0); assert.equal(reloaded.find('发送至进程的输入').disabled, false);
  const other = fixture(['interactive-jobs-v1'], f.storage); other.c.myFP = 'different'; other.c.tick(); assert.equal(other.find('核对上次输入结果').hidden, true);
}
console.log('console pipe scoped DOM/transport groups PASS (8)');

const settleParser = () => new Promise(resolve => setTimeout(resolve, 25));
async function terminalFixture() {
  const f = fixture(['interactive-jobs-v1', 'terminal-jobs-v1'], new Map(), {terminal: true});
  f.open(); f.reply(f.sent[0], {jobs: [{job_id: 'tty', state: 'running', interactive: true, stdin_closed: false, terminal: true, rows: 24, cols: 80}]});
  return f;
}
async function readyTerminal() {
  const f = await terminalFixture(), log = f.sent.find(s => s.job_action === 'log');
  f.reply(log, {stream: 'stdout', cursor: 0, next_cursor: 5, available_bytes: 5, text: 'ready'}); await settleParser();
  f.find('接入终端').emit('click'); const resize = f.sent.at(-1); assert.equal(resize.job_action, 'resize');
  f.reply(resize, {state: 'written', kind: 'resize', rows: 14, cols: 40});
  return f;
}
(async () => {
  {
    const f = await terminalFixture(); assert.equal(f.sent.filter(s => s.job_action === 'log').length, 1); assert.equal(f.sent.at(-1).job_stream, 'stdout');
    const request = f.sent.find(s => s.job_action === 'log'), generated = [];
    f.terminals[0].onData(data => generated.push(data));
    f.reply(request, {stream: 'stdout', cursor: 0, next_cursor: 10, available_bytes: 20, text: 'hello\u001b[6n'});
    // Adversarially remove xterm's own disableStdin protection while parsing:
    // the component's independent replay/attachment gate must still drop DSR.
    f.terminals[0].options.disableStdin = false;
    assert(f.find('接入终端').disabled); await settleParser(); assert(f.find('接入终端').disabled);
    assert(generated.some(data => data.includes('R')));
    assert.equal(f.sent.filter(s => s.job_action === 'log').length, 2); assert.equal(f.sent.at(-1).job_limit, 32768);
    assert.equal(f.sent.filter(s => ['input', 'signal', 'resize'].includes(s.job_action)).length, 0);
    f.find('刷新进程').emit('click'); const next = f.sent.filter(s => s.job_action === 'log').at(-1);
    f.reply(next, {stream: 'stdout', cursor: 10, next_cursor: 20, available_bytes: 20, text: '\rWORLD\u001b[6n'});
    assert(f.find('接入终端').disabled); await settleParser(); assert.equal(f.find('接入终端').disabled, false);
    assert.equal(f.terminals[0].buffer.active.getLine(0).translateToString(true), 'WORLD');
    assert.equal(f.sent.filter(s => ['input', 'signal', 'resize'].includes(s.job_action)).length, 0);
    f.terminals[0].dispose();
  }
  {
    const f = await readyTerminal(), t = f.terminals[0]; assert.equal(t.options.disableStdin, false);
    t.input('a', true); t.input('b', true); f.flush(80); const first = f.sent.at(-1); assert.equal(first.job_action, 'input'); assert.equal(first.job_text, 'ab');
    t.input('c\u001b[A', true); f.flush(80); assert.equal(f.sent.at(-1), first);
    f.reply(first, {state: 'written', kind: 'input'}); const second = f.sent.at(-1); assert.equal(second.job_action, 'input'); assert.equal(second.job_text, 'c\u001b[A'); assert.notEqual(second.job_input_id, first.job_input_id);
    f.reply(second, {state: 'written', kind: 'input'});
    f.find('发送至进程的输入').value = 'line'; walk(f.root).find(e => e.tagName === 'form').emit('submit'); const line = f.sent.at(-1); assert.equal(line.job_text, 'line\r'); f.reply(line, {state: 'written', kind: 'input'});
    t.input('\u0003', true); const interrupt = f.sent.at(-1); assert.equal(interrupt.job_action, 'signal'); assert.equal(interrupt.job_signal, 'interrupt'); f.reply(interrupt, {state: 'written', kind: 'signal'});
    f.find('关闭标准输入').emit('click'); const eof = f.sent.at(-1); assert.equal(eof.job_action, 'signal'); assert.equal(eof.job_signal, 'eof');
    f.reply(eof, {state: 'written', kind: 'signal', signal: 'eof', eof: true}); assert.equal(f.find('发送至进程的输入').disabled, false);
    assert.equal(f.storage.size, 0); t.dispose();
  }
  {
    const f = await readyTerminal(), t = f.terminals[0]; t.input('sent', true); f.flush(80); const original = f.sent.at(-1);
    t.input('queued-secret', true); f.flush(80); f.flush(12000); assert.equal(t.options.disableStdin, true); assert.equal(f.find('核对上次输入结果').hidden, false);
    t.input('after-timeout', true); f.flush(80); assert.equal(f.sent.filter(s => s.job_action === 'input').length, 1);
    f.find('核对上次输入结果').emit('click'); const check = f.sent.at(-1); assert.equal(check.job_action, 'input_status'); assert.equal(check.job_input_id, original.job_input_id);
    f.reply(check, {state: 'written', kind: 'input'}); assert.equal(f.sent.filter(s => s.job_action === 'input').length, 1); assert.equal(t.options.disableStdin, true);
    assert(![...f.storage.values()].join('').includes('secret')); t.dispose();
  }
  {
    const f = await readyTerminal(), t = f.terminals[0];
    f.dimensions.cols = 1; f.dimensions.rows = 1; f.observers[0].callback(); f.flush(160);
    const resize = f.sent.at(-1); assert.equal(resize.job_action, 'resize'); assert.equal(resize.job_cols, 20); assert.equal(resize.job_rows, 10);
    f.dimensions.cols = 999; f.dimensions.rows = 999; f.observers[0].callback(); f.flush(160);
    f.dimensions.cols = 72; f.dimensions.rows = 18; f.observers[0].callback(); f.flush(160);
    assert.equal(f.sent.at(-1), resize); f.reply(resize, {state: 'written', kind: 'resize'}); const final = f.sent.at(-1); assert.equal(final.job_cols, 72); assert.equal(final.job_rows, 18);
    f.reply(final, {state: 'written', kind: 'resize'}); t.input('discard', true); f.state.goal.status = 'paused'; f.c.tick(); f.flush(80); assert.equal(t.options.disableStdin, true); assert.equal(f.sent.filter(s => s.job_action === 'input').length, 0);
    f.c.selectSession({id: 'next'}); assert.equal(f.observers[0].disconnected, true);
  }
  {
    const f = fixture(['interactive-jobs-v1'], new Map(), {terminal: true}); f.open(); f.reply(f.sent[0], {jobs: [{job_id: 'old', state: 'running', interactive: true, stdin_closed: false, terminal: true}]});
    assert.equal(f.terminals.length, 0); assert(f.find('接入终端').disabled); assert(f.find('发送至进程的输入').disabled);
  }
  {
    const f = await readyTerminal(), t = f.terminals[0];
    // Resize ACK triggers an immediate read. Repeated 150 ms ticks cannot overlap it.
    const first = f.sent.filter(s => s.job_action === 'log').at(-1), count = f.sent.filter(s => s.job_action === 'log').length;
    f.c.fastTick(); f.c.fastTick(); assert.equal(f.sent.filter(s => s.job_action === 'log').length, count);
    f.reply(first, {stream: 'stdout', cursor: first.job_cursor, next_cursor: first.job_cursor, available_bytes: first.job_cursor, text: ''}); await settleParser();
    f.c.document.hidden = true; f.c.fastTick(); assert.equal(f.sent.filter(s => s.job_action === 'log').length, count);
    f.c.document.hidden = false; f.c.fastTick(); assert.equal(f.sent.filter(s => s.job_action === 'log').length, count + 1);
    f.find('退出终端输入').emit('click'); const after = f.sent.length; f.c.fastTick(); assert.equal(f.sent.length, after); t.dispose();
  }
  {
    const f = await readyTerminal(), t = f.terminals[0], source = t._core.coreService;
    const log = f.sent.filter(s => s.job_action === 'log').at(-1);
    const queries = '\u001b[6n\u001b[5n\u001b[c\u001b[>c\u001b[?1$p\u001bP$qm\u001b\\\u001b]11;?\u0007\u001b[?1004h';
    f.reply(log, {stream: 'stdout', cursor: log.job_cursor, next_cursor: log.job_cursor + queries.length, available_bytes: log.job_cursor + queries.length, text: queries});
    await settleParser();
    // Color reporting depends on browser theme services; exercise the exact
    // CoreService path used by CoreBrowserTerminal's OSC report callback too.
    source.triggerDataEvent('\u001b]11;rgb:2020/2323/2929\u001b\\'); source.triggerDataEvent('\u001b[I'); source.triggerDataEvent('\u001b[O');
    f.flush(80); assert.equal(f.sent.filter(s => s.job_action === 'input').length, 0); assert.equal(t.options.disableStdin, false);
    t._core.textarea = {value: ''};
    t._core._keyPress({charCode: 65, preventDefault() {}, stopPropagation() {}});
    t._core._keyPressHandled = false;
    t._core._inputEvent({data: '中文输入', inputType: 'insertText', composed: false, preventDefault() {}, stopPropagation() {}});
    t.paste('粘贴\n内容'); f.flush(80); const typed = f.sent.at(-1);
    assert.equal(typed.job_action, 'input'); assert.equal(typed.job_text, 'A中文输入粘贴\r内容');
    f.reply(typed, {state: 'written', kind: 'input'});
    f.find('退出终端输入').emit('click'); t.options.disableStdin = false;
    t.input('dropped-user', true); source.triggerDataEvent('\u001b[1;1R'); f.flush(80);
    assert.equal(f.sent.filter(s => s.job_action === 'input').length, 1);
    f.c.selectSession({id: 'other'}); source.triggerDataEvent('old-user', true); f.flush(80); assert.equal(f.sent.filter(s => s.job_action === 'input').length, 1);
  }
  {
    const f = fixture(['interactive-jobs-v1', 'terminal-jobs-v1'], new Map(), {terminal: true, missingSource: true});
    f.open(); f.reply(f.sent[0], {jobs: [{job_id: 'tty', state: 'running', interactive: true, stdin_closed: false, terminal: true}]});
    const log = f.sent.find(s => s.job_action === 'log'); f.reply(log, {stream: 'stdout', cursor: 0, next_cursor: 0, available_bytes: 0, text: ''}); await settleParser();
    assert(f.find('接入终端').disabled); assert(f.root.textContent.includes('适配器不可用')); f.terminals[0].dispose();
  }
  console.log('console terminal groups PASS (8, actual vendored xterm parser + keyboard/IME-input/clipboard handlers; controlled DOM/transport, no OS acceptance)');
})().catch(error => { console.error(error); process.exitCode = 1; });
