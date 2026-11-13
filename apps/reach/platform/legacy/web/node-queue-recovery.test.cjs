'use strict';
// web/node-queue-recovery.js 的 VM fixture：加载**整个**脚本（含与 app.js 同签名的
// b64dec = Uint8Array、真实 el/document/sendFrame），跑通 open → sendFrame → handleOut
// 的正常 UTF-8（中文）回包，并验证有界超时会释放面板、延迟旧回包被忽略。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// 与 app.js 同签名：b64dec 返回 Uint8Array。
function realB64Dec(str) {
  const s = atob(str), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

function makeEl(tag) {
  const e = { tagName: tag, className: '', children: [], type: '', disabled: false, _text: '', _onclick: null };
  Object.defineProperty(e, 'textContent', {
    get() { return e._text; },
    set(v) { e._text = v == null ? '' : String(v); if (e._text === '') e.children.length = 0; },
  });
  Object.defineProperty(e, 'onclick', { get() { return e._onclick; }, set(fn) { e._onclick = fn; } });
  e.appendChild = (c) => { e.children.push(c); return c; };
  e.classList = {
    _s: new Set(['hide']),
    add(c) { this._s.add(c); },
    remove(c) { this._s.delete(c); },
    contains(c) { return this._s.has(c); },
  };
  return e;
}

function walk(node) {
  let out = typeof node._text === 'string' ? node._text : '';
  for (const c of node.children || []) out += ' | ' + walk(c);
  return out;
}
function findAll(node, pred, acc) {
  const out = acc || [];
  if (pred(node)) out.push(node);
  for (const c of node.children || []) findAll(c, pred, out);
  return out;
}

function loadModule(opts) {
  const src = fs.readFileSync(path.join(__dirname, 'node-queue-recovery.js'), 'utf8');
  const panel = makeEl('div');
  panel.id = 'agentQueuePanel';
  const sent = [];
  const win = {};
  if (opts && opts.replyTimeoutMs) win.NodeQueueRecoveryReplyTimeoutMs = opts.replyTimeoutMs;
  const doc = {
    createElement: makeEl,
    getElementById: (id) => (id === 'agentQueuePanel' ? panel : null),
  };
  const ctx = vm.createContext({
    window: win,
    document: doc,
    // 与 app.js 的 el 同签名。
    el: (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    },
    b64dec: realB64Dec,
    dec: new TextDecoder('utf-8'),
    TextDecoder: TextDecoder,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    console: console,
    sendFrame: (frame) => { sent.push(frame); return true; },
  });
  vm.runInContext(src, ctx);
  return {
    api: win.NodeQueueRecovery,
    panel: panel,
    sent: sent,
    text: () => walk(panel),
    byClass: (cls) => findAll(panel, (e) => String(e.className).split(' ').indexOf(cls) >= 0),
    byText: (t) => findAll(panel, (e) => e._text === t),
  };
}

function reply(id, payload) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return { k: 'out', id: id, done: true, code: 0, err: '', b64: bytes.toString('base64') };
}
function frame(f) { return JSON.parse(JSON.stringify(f)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const previewPayload = () => ({
  action: 'list', revision: 3, busy: false, blocked: '',
  entries: [
    { id: 'pq-1', source: 'agent-loop.json', text: '旧的一条转向：把中文日志读一遍', kind: 'steer', kind_known: true },
    { id: 'pq-2', source: 'agent-loop.json', text: '旧的一条稍后：写完再报告', kind: '', kind_known: false },
  ],
  audit: [{ at: '2026-01-02T03:04:05Z', action: 'discard', entry: 'pq-0', controller: 'fp-ctl' }],
});

test('open → sendFrame → handleOut 的正常 UTF-8 中文回包能解析并渲染', () => {
  const h = loadModule();
  h.api.open();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(frame(h.sent[0]), { k: 'agent-queue-recovery', id: 'queue-1', msg: 'list' });
  assert.equal(h.panel.classList.contains('hide'), false, 'open 必须显示面板');

  // 回包就是 out 帧：b64 是 UTF-8 字节的 base64（app.js 的 b64dec 返回 Uint8Array）。
  assert.equal(h.api.handleOut(reply('queue-1', previewPayload())), true);
  const shown = h.text();
  assert.match(shown, /旧的一条转向：把中文日志读一遍/);
  assert.match(shown, /旧的一条稍后：写完再报告/);
  assert.match(shown, /转向/);
  assert.match(shown, /类别未知/);
  assert.match(shown, /agent-loop\.json/);
  assert.match(shown, /放弃这一条/); // 审计行
  assert.doesNotMatch(shown, /无法解析/);
  // 两个显式选项都在，界面不预选。
  assert.equal(h.byText('重排队（转向）').length, 2);
  assert.equal(h.byText('重排队（稍后）').length, 2);
  assert.equal(h.byText('放弃').length, 2);
});

test('requeue 回包显示投递标识，并只认当前在途请求', () => {
  const h = loadModule();
  h.api.open();
  h.api.handleOut(reply('queue-1', previewPayload()));
  const follow = h.byText('重排队（稍后）')[0]; // 第一条（pq-1）
  assert.ok(follow, '原类别未知也必须给出显式选项');
  follow.onclick();
  assert.deepEqual(frame(h.sent[h.sent.length - 1]),
    { k: 'agent-queue-recovery', id: 'queue-2', msg: 'requeue', entry: 'pq-1', kind: 'follow_up', rev: 3 });
  const done = Object.assign(previewPayload(), { action: 'requeue', delivery: 'd-中文标识', revision: 4 });
  assert.equal(h.api.handleOut(reply('queue-2', done)), true);
  assert.match(h.text(), /d-中文标识/);
});

test('有界超时释放面板：不自动重发处置，刷新可重试', async () => {
  const h = loadModule({ replyTimeoutMs: 40 });
  h.api.open();
  assert.equal(h.sent.length, 1);
  assert.match(h.text(), /读取本机预览/);
  await sleep(150);
  assert.match(h.text(), /没有收到本机回包/, '超时后必须明确提示');
  assert.equal(h.sent.length, 1, '超时绝不自动重发处置');
  const refresh = h.byClass('agent-queue-refresh')[0];
  assert.equal(refresh.disabled, false, '超时后刷新必须可用（面板不再被锁）');
  refresh.onclick();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].id, 'queue-2');
});

test('延迟旧回包被忽略：不覆盖新请求，也不假装成功', async () => {
  const h = loadModule({ replyTimeoutMs: 40 });
  h.api.open();
  await sleep(150);
  // 超时之后才到的旧回包：忽略。
  assert.equal(h.api.handleOut(reply('queue-1', previewPayload())), false);
  assert.doesNotMatch(h.text(), /旧的一条转向/);
  assert.match(h.text(), /没有收到本机回包/);
  // 新请求在途时，旧回包同样不能把它顶掉。
  h.byClass('agent-queue-refresh')[0].onclick();
  assert.equal(h.sent[h.sent.length - 1].id, 'queue-2');
  assert.equal(h.api.handleOut(reply('queue-1', previewPayload())), false);
  assert.doesNotMatch(h.text(), /旧的一条转向/);
  // 当前请求的回包照常生效。
  assert.equal(h.api.handleOut(reply('queue-2', previewPayload())), true);
  assert.match(h.text(), /旧的一条转向/);
});

test('helper：原类别照实显示，未知类别绝不预选', () => {
  const src = fs.readFileSync(path.join(__dirname, 'node-queue-recovery.js'), 'utf8');
  const start = src.indexOf('function queueEntryPlan');
  const end = src.indexOf('// decodeB64Payload');
  assert.ok(start >= 0 && end > start);
  const ctx = vm.createContext({});
  vm.runInContext(src.slice(start, end), ctx);
  assert.equal(ctx.queueEntryPlan({ kind: 'steer', kind_known: true }).kindLabel, '转向');
  assert.equal(ctx.queueEntryPlan({ kind: 'follow_up', kind_known: true }).kindLabel, '稍后');
  const unknown = ctx.queueEntryPlan({ kind: '', kind_known: false });
  assert.equal(unknown.kindLabel, '类别未知');
  assert.equal(unknown.known, false);
  assert.equal(unknown.actions.map((a) => a.action + ':' + a.kind).join('|'),
    'requeue:steer|requeue:follow_up|discard:');
  assert.match(ctx.queueAuditLine({ action: 'requeue', kind: 'follow_up', delivery_id: 'd-1', controller: 'fp-ctl' }),
    /重排队为稍后.*d-1/);
  assert.match(ctx.queueAuditLine({ action: 'discard', controller: 'fp-ctl' }), /放弃这一条/);
});
