// Controlled composer/transport fixture; this does not establish browser acceptance.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const code = fs.readFileSync(__dirname + '/handwave_suggest.js', 'utf8');
const native = fs.readFileSync(__dirname + '/testdata/handwave-app-7ae318fe.js', 'utf8');
assert.equal(crypto.createHash('sha256').update(native).digest('hex'), '7ae318fe13a6fd35cd652c3fed7ee51134ca7808d14aab8f1be0c18aa44a15b2');
function nativeFunction(start, end) {
  const begin = native.indexOf(start), finish = native.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin); return native.slice(begin, finish);
}
function fixture(options = {}) {
  const listeners = {}, attrs = {placeholder: '输入消息'};
  const input = {
    dataset: {}, value: '', disabled: false, readOnly: false,
    getAttribute: key => attrs[key] == null ? null : attrs[key],
    setAttribute: (key, value) => { attrs[key] = value; },
    removeAttribute: key => { delete attrs[key]; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(event) { for (const fn of listeners[event.type] || []) fn(event); },
    setSelectionRange(start, end) { this.selection = [start, end]; }
  };
  const pending = [], sent = [], stateEvents = [], timers = new Map(), storage = new Map();
  let now = Date.parse('2026-10-16T00:00:00Z'), timerID = 0;
  if (options.preferences) storage.set('handwave-suggestions-v1', JSON.stringify(options.preferences));
  class ClockDate extends Date { constructor(value) { super(arguments.length ? value : now); } static now() { return now; } }
  const ctx = {
    document: {getElementById: id => id === 'input' ? input : null, activeElement: input},
    Event: class Event { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    window: {localStorage: {getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value)}, dispatchEvent: event => stateEvents.push(event)},
    CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    Date: ClockDate, AbortController,
    setTimeout(fn, delay) { const id = ++timerID; timers.set(id, {fn, at: now + delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    curWS: {id: 'w', ...(options.remote ? {device_fp: 'fp'} : {})}, curSess: {id: 'a'}, sending: false, localBusy: false, localMode: !!options.localMode, processingQueue: false, msgQueue: [], pendingAttach: [],
    agentRun: {turnID: '', events: [], agents: new Map()},
    api(path, options) { return new Promise((resolve, reject) => pending.push({path, options, resolve, reject})); },
    sendChat() { sent.push(input.value); input.value = ''; },
    selectSession(s) { ctx.curSess = s; ctx.clearMessages(); return Promise.resolve(); },
    selectWorkspace(w) { ctx.curWS = w; ctx.curSess = null; ctx.clearMessages(); return Promise.resolve(); },
    clearMessages() {}, finishLocalRun() { ctx.localBusy = false; ctx.sending = false; },
    resetAgentRun(turn) { ctx.agentRun.turnID = turn || ''; ctx.agentRun.events = []; },
    recordAgentEvent(event) { ctx.agentRun.events.push(event); },
    setSendUI() {}, renderAttachBar() {}, renderQueue() {},
    syncInputPlaceholder() { if (!options.nativePlaceholderNoop) input.placeholder = '移动端输入'; return 'native result'; }
  };
  vm.createContext(ctx);
  if (options.nativeLocalFinish) {
    Object.assign(ctx, {localAnswer: '', localStream: null, pendingLocalRetry: '', stopLocalTick() {}, updateTaskDurations() {}, addBubble() {}});
    vm.runInContext(nativeFunction('function noteSession(role, content)', '\nconst TERMINAL_TASK') + '\n' +
      nativeFunction('function finishLocalRun(errText)', '\nasync function startLocalRun'), ctx);
  }
  vm.runInContext(code, ctx);
  function emit(type, options = {}) {
    const event = {type, key: '', prevented: false, preventDefault() { this.prevented = this.defaultPrevented = true; }, ...options};
    input.dispatchEvent(event); return event;
  }
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      const next = Array.from(timers.entries()).filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    now = target; for (let i = 0; i < 5; i++) await Promise.resolve();
  }
  return {ctx, input, attrs, pending, sent, emit, advance, storage, stateEvents,
    suggestionCalls: () => pending.filter(p => p.path === '/next-suggestion'),
    receipt: (overrides = {}) => ({workspace_id: ctx.curWS.id, session_id: ctx.curSess.id, device_fp: ctx.curWS.device_fp,
      revision: 'revision-1', summary: '当前上下文摘要', next_prompt: '检查相关测试，说明下一步。', source_ids: ['message-1'],
      expires_at: new Date(now + 60000).toISOString(), ...overrides}),
    state: () => ctx.window.HandwaveSuggestions.getState()};
}
async function loadHistory(f, messages = [{role: 'user', content: '检查代码'}, {role: 'assistant', content: '已经回复，但未验证'}]) {
  const p = f.ctx.api('/workspaces/' + f.ctx.curWS.id + '/sessions/' + f.ctx.curSess.id + '/messages');
  f.pending.at(-1).resolve(messages); await p;
}
async function receiveCandidate(f, overrides = {}) {
  f.suggestionCalls().at(-1).resolve(f.receipt(overrides)); await f.advance(0);
}
function hint(f, pattern) { assert.match(f.input.placeholder, pattern); }
(async () => {
  let count = 0;
  const run = async (name, fn) => { await fn(); count++; console.log('ok ' + count + ' - ' + name); };
  await run('default hint and Tab fills without send', () => {
    const f = fixture(); hint(f, /当前项目/); assert.doesNotMatch(f.input.placeholder, /Tab/);
    assert.equal(f.emit('keydown', {key: 'Tab'}).prevented, true);
    assert.equal(f.input.value, '先查看当前项目，说明可以从哪里开始。');
    assert.equal(f.sent.length, 0); assert.equal(f.input.placeholder, '输入消息');
    assert.equal(f.input.selection[0], f.input.value.length);
  });
  await run('modified Tab and previously handled event preserve navigation', () => {
    const f = fixture();
    for (const key of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey', 'defaultPrevented']) {
      assert.equal(f.emit('keydown', {key: 'Tab', [key]: true}).prevented, false);
      assert.equal(f.input.value, '');
    }
  });
  await run('IME composition and legacy 229 never accept', () => {
    const f = fixture(); f.emit('compositionstart');
    assert.equal(f.emit('keydown', {key: 'Tab'}).prevented, false);
    assert.equal(f.input.placeholder, '输入消息');
    f.emit('compositionend');
    assert.equal(f.emit('keydown', {key: 'Tab', isComposing: true}).prevented, false);
    assert.equal(f.emit('keydown', {key: 'Tab', keyCode: 229}).prevented, false);
  });
  await run('existing and whitespace drafts are never overwritten', () => {
    const f = fixture();
    for (const draft of ['自己的草稿', ' ']) {
      f.input.value = draft; f.emit('input');
      assert.equal(f.emit('keydown', {key: 'Tab'}).prevented, false);
      assert.equal(f.input.value, draft); assert.equal(f.input.placeholder, '输入消息');
    }
  });
  await run('busy states suppress both hint and acceptance', () => {
    const f = fixture();
    for (const flag of ['sending', 'localBusy', 'processingQueue']) {
      f.ctx[flag] = true; f.emit('focus');
      assert.equal(f.input.placeholder, '输入消息');
      assert.equal(f.emit('keydown', {key: 'Tab'}).prevented, false);
      f.ctx[flag] = false;
    }
    f.ctx.localBusy = true; // Busy can change after the hint was painted.
    assert.equal(f.emit('keydown', {key: 'Tab'}).prevented, false);
  });
  await run('Escape dismissal persists through focus and allows Tab out', () => {
    const f = fixture(); f.emit('keydown', {key: 'Escape'}); f.emit('focus');
    assert.equal(f.input.placeholder, '输入消息');
    assert.equal(f.emit('keydown', {key: 'Tab'}).prevented, false);
    assert.equal(f.attrs['aria-description'], undefined);
  });
  await run('unfocused, disabled and readonly inputs never accept', () => {
    const f = fixture(); f.ctx.document.activeElement = {};
    assert.equal(f.emit('keydown', {key: 'Tab'}).prevented, false);
    f.ctx.document.activeElement = f.input;
    for (const flag of ['disabled', 'readOnly']) {
      f.input[flag] = true; assert.equal(f.emit('keydown', {key: 'Tab'}).prevented, false); f.input[flag] = false;
    }
  });
  await run('local submitted intent chooses log and code hints', () => {
    const f = fixture();
    f.input.value = '分析日志'; f.ctx.sendChat(); hint(f, /相关日志/);
    f.input.value = '实现代码功能'; f.ctx.sendChat(); hint(f, /代码与测试/);
    assert.deepEqual(f.sent, ['分析日志', '实现代码功能']);
  });
  await run('pending attachments choose references hint without reading contents', () => {
    const f = fixture(); f.ctx.pendingAttach = [{name: 'notes.md', content: 'secret'}]; f.ctx.renderAttachBar();
    hint(f, /参考资料/); assert.doesNotMatch(f.input.placeholder, /secret/);
  });
  await run('history uses latest user intent and ignores private model reasoning', async () => {
    const f = fixture(), p = f.ctx.api('/workspaces/w/sessions/a/messages');
    f.pending[0].resolve([{role: 'user', content: '安装服务'}, {role: 'assistant', content: '日志', privateThinking: 'secret'}]);
    await p; hint(f, /安装与运行状态/); assert.doesNotMatch(f.input.placeholder, /secret/);
  });
  await run('late history after switch never supplies a previous session hint', async () => {
    const f = fixture(), p = f.ctx.api('/workspaces/w/sessions/a/messages');
    await f.ctx.selectSession({id: 'b'});
    f.pending[0].resolve([{role: 'user', content: '分析日志'}]); await p;
    hint(f, /当前项目/);
  });
  await run('A to B to A rejects old epoch even with matching identity', async () => {
    const f = fixture(), p = f.ctx.api('/workspaces/w/sessions/a/messages');
    await f.ctx.selectSession({id: 'b'}); await f.ctx.selectSession({id: 'a'});
    f.pending[0].resolve([{role: 'user', content: '分析日志'}]); await p; hint(f, /当前项目/);
  });
  await run('new live intent wins over in-flight history', async () => {
    const f = fixture(), p = f.ctx.api('/workspaces/w/sessions/a/messages');
    f.input.value = '检查代码'; f.ctx.sendChat();
    f.pending[0].resolve([{role: 'user', content: '分析日志'}]); await p; hint(f, /代码与测试/);
  });
  await run('newest same-session history request wins', async () => {
    const f = fixture(), p = f.ctx.api('/workspaces/w/sessions/a/messages'), q = f.ctx.api('/workspaces/w/sessions/a/messages');
    f.pending[1].resolve([{role: 'user', content: '查看记忆'}]); await q;
    f.pending[0].resolve([{role: 'user', content: '分析日志'}]); await p; hint(f, /已有记忆/);
  });
  await run('workspace switch resets suggestion and Escape dismissal', async () => {
    const f = fixture(); f.input.value = '分析日志'; f.ctx.sendChat(); f.emit('keydown', {key: 'Escape'});
    await f.ctx.selectWorkspace({id: 'new'}); hint(f, /当前项目/);
  });
  await run('background local failure cannot change a different session', async () => {
    const f = fixture(); f.ctx.resetAgentRun('r'); await f.ctx.selectSession({id: 'b'});
    f.ctx.finishLocalRun('error'); hint(f, /当前项目/);
    f.ctx.resetAgentRun('r2'); f.ctx.localBusy = true; f.ctx.finishLocalRun('error'); hint(f, /刚才的错误/);
  });
  await run('first send retains intent when native context creation assigns a session', () => {
    const f = fixture(); f.ctx.curSess = null; f.emit('focus');
    f.input.value = '分析日志'; f.ctx.sendChat();
    f.ctx.curSess = {id: 'created'}; f.ctx.resetAgentRun('r'); hint(f, /相关日志/);
  });
  await run('native boot/resize placeholder sync retains eligible suggestion and return value', () => {
    const f = fixture();
    assert.equal(f.ctx.syncInputPlaceholder(), 'native result'); hint(f, /当前项目/);
    f.input.value = '分析日志'; f.ctx.sendChat(); f.ctx.syncInputPlaceholder(); hint(f, /相关日志/);
    assert.equal(f.sent.length, 1);
  });
  await run('native responsive placeholder remains fallback for dismissal, draft and busy', () => {
    const f = fixture(); f.emit('keydown', {key: 'Escape'}); f.ctx.syncInputPlaceholder();
    assert.equal(f.input.placeholder, '移动端输入');
    assert.equal(f.emit('keydown', {key: 'Tab'}).prevented, false);
    const draft = fixture(); draft.input.value = '草稿'; draft.ctx.syncInputPlaceholder();
    assert.equal(draft.input.placeholder, '移动端输入'); assert.equal(draft.input.value, '草稿');
    const busy = fixture(); busy.ctx.sending = true; busy.ctx.syncInputPlaceholder();
    assert.equal(busy.input.placeholder, '移动端输入'); assert.equal(busy.emit('keydown', {key: 'Tab'}).prevented, false);
  });
  await run('native no-op never promotes the current suggestion into fallback', () => {
    const f = fixture({nativePlaceholderNoop: true}); f.ctx.syncInputPlaceholder(); hint(f, /当前项目/);
    f.emit('keydown', {key: 'Escape'}); assert.equal(f.input.placeholder, '输入消息');
  });
  await run('append is idempotent and does not duplicate listeners', () => {
    const f = fixture(); vm.runInContext(code, f.ctx);
    f.input.value = '分析日志'; f.ctx.sendChat(); assert.equal(f.sent.length, 1);
    assert.equal(f.emit('keydown', {key: 'Tab'}).prevented, true);
    assert.equal(f.sent.length, 1);
  });
  await run('history completion debounces one candidate, renders it and Tab only fills', async () => {
    const f = fixture({remote: true}); await loadHistory(f);
    await f.advance(399); assert.equal(f.suggestionCalls().length, 0);
    await f.advance(1); assert.equal(f.suggestionCalls().length, 1); assert.equal(f.state().status, 'loading');
    const body = JSON.parse(f.suggestionCalls()[0].options.body);
    assert.equal(body.workspace_id, 'w'); assert.equal(body.session_id, 'a'); assert.equal(body.device_fp, 'fp'); assert.equal(body.include_memory, true);
    assert.equal(body.messages, undefined); assert.equal(body.recent_result, undefined);
    await receiveCandidate(f); hint(f, /检查相关测试/); assert.equal(f.state().status, 'ready');
    assert.equal(f.state().summary, '当前上下文摘要');
    assert.equal(f.emit('keydown', {key: 'Tab'}).prevented, true); assert.equal(f.input.value, '检查相关测试，说明下一步。'); assert.equal(f.sent.length, 0);
    assert.ok(f.stateEvents.some(event => event.type === 'handwave:suggestion-state' && event.detail.status === 'ready'));
  });
  await run('typing and clearing reuse only a current candidate without requests per key', async () => {
    const f = fixture({remote: true}); await loadHistory(f); await f.advance(400); await receiveCandidate(f);
    for (const draft of ['测', '测试', '测试草稿', '']) { f.input.value = draft; f.emit('input'); await f.advance(20); }
    hint(f, /检查相关测试/); assert.equal(f.suggestionCalls().length, 1);
    assert.equal(f.sent.length, 0);
  });
  await run('draft aborts in-flight request and clearing does not admit its late result', async () => {
    const f = fixture({remote: true}); await loadHistory(f); await f.advance(400); const call = f.suggestionCalls()[0];
    f.input.value = 'draft'; f.emit('input'); assert.equal(call.options.signal.aborted, true);
    f.input.value = ''; f.emit('input'); call.resolve(f.receipt({next_prompt: '迟到候选'})); await f.advance(1000);
    assert.doesNotMatch(f.input.placeholder, /迟到候选/); assert.equal(f.suggestionCalls().length, 1);
  });
  await run('late session result is rejected even after returning A to B to A', async () => {
    const f = fixture({remote: true}); await loadHistory(f); await f.advance(400); const call = f.suggestionCalls()[0];
    await f.ctx.selectSession({id: 'b'}); await f.ctx.selectSession({id: 'a'});
    call.resolve(f.receipt({next_prompt: '旧会话候选'})); await f.advance(0);
    assert.doesNotMatch(f.input.placeholder, /旧会话候选/); assert.equal(f.state().summary, ''); assert.equal(call.options.signal.aborted, true);
  });
  await run('device change rejects late candidate and updates exposed owner', async () => {
    const f = fixture({remote: true}); await loadHistory(f); await f.advance(400); const call = f.suggestionCalls()[0], old = f.receipt({next_prompt: '旧电脑候选'});
    f.ctx.curWS.device_fp = 'other'; f.emit('focus'); call.resolve(old); await f.advance(0);
    assert.doesNotMatch(f.input.placeholder, /旧电脑候选/); assert.equal(f.state().owner.device_fp, 'other'); assert.equal(f.state().summary, '');
  });
  await run('first pairing preserves same-conversation history and explicit refresh requests the new device', async () => {
    const f = fixture(); await loadHistory(f); await f.advance(500); assert.equal(f.suggestionCalls().length, 0);
    f.ctx.curWS.device_fp = 'newfp'; f.emit('focus');
    const refresh = f.ctx.window.HandwaveSuggestions.refresh(); assert.equal(f.suggestionCalls().length, 1);
    assert.equal(JSON.parse(f.suggestionCalls()[0].options.body).device_fp, 'newfp');
    await receiveCandidate(f); assert.equal((await refresh).status, 'ready'); await f.advance(500); assert.equal(f.suggestionCalls().length, 1);
  });
  await run('rebinding invalidates the old candidate but debounces one new-device request without reselecting', async () => {
    const f = fixture({remote: true}); await loadHistory(f); await f.advance(400); await receiveCandidate(f, {next_prompt: '旧设备建议'});
    f.ctx.curWS.device_fp = 'newfp'; f.emit('focus'); assert.equal(f.state().summary, ''); assert.doesNotMatch(f.input.placeholder, /旧设备建议/);
    await f.advance(400); assert.equal(f.suggestionCalls().length, 2); assert.equal(JSON.parse(f.suggestionCalls()[1].options.body).device_fp, 'newfp');
    await receiveCandidate(f, {next_prompt: '新设备建议'}); hint(f, /新设备建议/);
    f.emit('focus'); await f.advance(500); assert.equal(f.suggestionCalls().length, 2);
  });
  await run('new conversation does not inherit a history existence bit during device change', async () => {
    const f = fixture({remote: true}); await loadHistory(f);
    f.ctx.curSess = {id: 'new-empty'}; f.ctx.curWS.device_fp = 'newfp'; f.emit('focus');
    await f.ctx.window.HandwaveSuggestions.refresh(); await f.advance(500); assert.equal(f.suggestionCalls().length, 0);
  });
  await run('Escape aborts and persists dismissal until a real source changes', async () => {
    const f = fixture({remote: true}); await loadHistory(f); await f.advance(400); const call = f.suggestionCalls()[0];
    f.emit('keydown', {key: 'Escape'}); assert.equal(call.options.signal.aborted, true); call.resolve(f.receipt()); await f.advance(0);
    f.emit('focus'); await f.advance(1000); assert.equal(f.suggestionCalls().length, 1); assert.equal(f.emit('keydown', {key: 'Tab'}).prevented, false);
    const p = f.ctx.api('/cloud-memory/records', {method: 'POST', body: JSON.stringify({workspace_id: 'w', device_fp: 'fp'})}); f.pending.at(-1).resolve({}); await p;
    await f.advance(400); assert.equal(f.suggestionCalls().length, 2);
  });
  await run('IME aborts without requesting on composition-end or accepting late text', async () => {
    const f = fixture({remote: true}); await loadHistory(f); await f.advance(400); const call = f.suggestionCalls()[0];
    f.emit('compositionstart'); assert.equal(call.options.signal.aborted, true); f.emit('compositionend');
    call.resolve(f.receipt({next_prompt: '迟到拼音候选'})); await f.advance(500);
    assert.doesNotMatch(f.input.placeholder, /迟到拼音候选/); assert.equal(f.suggestionCalls().length, 1);
  });
  await run('busy and queued composer cannot request or accept a candidate', async () => {
    const f = fixture({remote: true}); f.ctx.sending = true; f.ctx.setSendUI(true); await loadHistory(f); await f.advance(1000);
    assert.equal(f.suggestionCalls().length, 0); assert.equal(f.state().status, 'busy');
    f.ctx.sending = false; f.ctx.msgQueue.push({status: 'queued'}); f.ctx.setSendUI(false); await f.advance(500); assert.equal(f.suggestionCalls().length, 0);
    f.ctx.msgQueue.length = 0; f.ctx.renderQueue(); await f.advance(400); assert.equal(f.suggestionCalls().length, 1);
    await receiveCandidate(f); f.ctx.localBusy = true; assert.equal(f.emit('keydown', {key: 'Tab'}).prevented, false);
  });
  await run('native idle waits for assistant persistence acknowledgement', async () => {
    const f = fixture({remote: true, localMode: true}); await loadHistory(f); await f.advance(400); await receiveCandidate(f);
    f.ctx.localBusy = f.ctx.sending = true; f.ctx.setSendUI(true); f.ctx.resetAgentRun('run-native');
    f.ctx.localBusy = f.ctx.sending = false; f.ctx.setSendUI(false); await f.advance(1000); assert.equal(f.suggestionCalls().length, 1);
    const note = f.ctx.api('/workspaces/w/sessions/a/messages', {method: 'POST', body: JSON.stringify({role: 'assistant', content: '模型回复'})});
    await f.advance(500); assert.equal(f.suggestionCalls().length, 1);
    f.pending.at(-1).resolve({}); await note; await f.advance(400); assert.equal(f.suggestionCalls().length, 2);
  });
  await run('pinned native finishLocalRun idle-before-note sequence waits for its actual POST acknowledgement', async () => {
    const f = fixture({remote: true, localMode: true, nativeLocalFinish: true}); await loadHistory(f);
    f.ctx.localBusy = f.ctx.sending = true; f.ctx.setSendUI(true); f.ctx.resetAgentRun('real-native-sequence');
    f.ctx.localAnswer = 'native answer'; f.ctx.finishLocalRun('');
    assert.equal(f.ctx.localBusy, false); assert.equal(f.ctx.sending, false);
    const note = f.pending.at(-1); assert.equal(note.path, '/workspaces/w/sessions/a/messages'); assert.equal(note.options.method, 'POST');
    assert.equal(JSON.parse(note.options.body).role, 'assistant'); await f.advance(1000); assert.equal(f.suggestionCalls().length, 0);
    note.resolve({}); await f.advance(0); await f.advance(400); assert.equal(f.suggestionCalls().length, 1);
  });
  await run('native failed-note acknowledgement is a source without claiming verified success', async () => {
    const f = fixture({remote: true, localMode: true}); await loadHistory(f); f.ctx.localBusy = true; f.ctx.resetAgentRun('run-failed');
    f.ctx.recordAgentEvent({type: 'tool_end', title: 'read_file', status: 'failed', output: 'PRIVATE OUTPUT', privateThinking: 'PRIVATE THOUGHT'});
    f.ctx.recordAgentEvent({type: 'agent_end', status: 'failed'}); f.ctx.finishLocalRun('failure');
    const note = f.ctx.api('/workspaces/w/sessions/a/messages', {method: 'POST', body: JSON.stringify({role: 'system', content: '本机任务结束：failure'})});
    f.pending.at(-1).resolve({}); await note; await f.advance(400);
    const raw = f.suggestionCalls().at(-1).options.body, body = JSON.parse(raw);
    assert.equal(body.recent_result.run_id, 'run-failed'); assert.equal(body.recent_result.status, 'failed');
    assert.equal(body.recent_result.tools[0].name, 'read_file'); assert.equal(body.recent_result.tools[0].status, 'failed');
    assert.doesNotMatch(raw, /PRIVATE|verified|本机任务结束/);
  });
  await run('only current-owner public tool name/status receipts enter bounded recent_result', async () => {
    const f = fixture({remote: true, localMode: true}); await loadHistory(f); f.ctx.localBusy = true; f.ctx.resetAgentRun('run-real');
    for (let i = 0; i < 8; i++) f.ctx.recordAgentEvent({type: 'tool_finish', title: 'tool_' + i, status: i === 7 ? 'invented-success' : 'completed', detail: 'SECRET ARGS', output: 'SECRET OUTPUT'});
    f.ctx.recordAgentEvent({type: 'agent_end', status: 'completed'}); f.ctx.finishLocalRun('');
    const p = f.ctx.api('/workspaces/w/sessions/a/messages', {method: 'POST', body: JSON.stringify({role: 'assistant', content: '模型自述成功'})}); f.pending.at(-1).resolve({}); await p; await f.advance(400);
    const raw = f.suggestionCalls().at(-1).options.body, recent = JSON.parse(raw).recent_result;
    assert.equal(recent.tools.length, 4); assert.equal(recent.tools[3].status, 'unknown'); assert.doesNotMatch(raw, /SECRET|模型自述|verified/);
    await f.ctx.selectSession({id: 'b'}); await loadHistory(f); await f.advance(400); assert.equal(JSON.parse(f.suggestionCalls().at(-1).options.body).recent_result, undefined);
  });
  await run('successful same-scope memory changes invalidate candidate and debounce fresh request', async () => {
    for (const path of ['/cloud-memory/records', '/cloud-memory/revoke', '/cloud-memory/project']) {
      const f = fixture({remote: true}); await loadHistory(f); await f.advance(400); await receiveCandidate(f);
      const p = f.ctx.api(path, {method: 'POST', body: JSON.stringify({workspace_id: 'w', device_fp: 'fp'})});
      f.pending.at(-1).resolve({}); await p; assert.equal(f.state().summary, ''); assert.doesNotMatch(f.input.placeholder, /检查相关测试/);
      await f.advance(400); assert.equal(f.suggestionCalls().length, 2);
    }
  });
  await run('failed or other-device memory writes do not create a new source', async () => {
    const f = fixture({remote: true}); await loadHistory(f); await f.advance(400); await receiveCandidate(f);
    const wrong = f.ctx.api('/cloud-memory/records', {method: 'POST', body: JSON.stringify({workspace_id: 'w', device_fp: 'different'})}); f.pending.at(-1).resolve({}); await wrong;
    const failed = f.ctx.api('/cloud-memory/revoke', {method: 'POST', body: JSON.stringify({workspace_id: 'w', device_fp: 'fp'})}); f.pending.at(-1).reject(new Error('409'));
    await assert.rejects(failed); await f.advance(400); assert.equal(f.suggestionCalls().length, 1); assert.equal(f.state().status, 'ready');
  });
  await run('preferences persist only booleans and include_memory changes abort old work', async () => {
    const f = fixture({remote: true}); await loadHistory(f); await f.advance(400); const old = f.suggestionCalls()[0];
    const state = f.ctx.window.HandwaveSuggestions.setPreferences({include_memory: false}); assert.equal(state.include_memory, false); assert.equal(old.options.signal.aborted, true);
    old.resolve(f.receipt({next_prompt: '旧记忆候选'})); await f.advance(400);
    assert.equal(f.suggestionCalls().length, 2); assert.equal(JSON.parse(f.suggestionCalls()[1].options.body).include_memory, false);
    await receiveCandidate(f); const saved = JSON.parse(f.storage.get('handwave-suggestions-v1'));
    assert.deepEqual(Object.keys(saved).sort(), ['enabled', 'include_memory', 'tab_accept']); assert.equal(saved.include_memory, false); assert.doesNotMatch(JSON.stringify(saved), /summary|当前上下文|检查相关测试/);
  });
  await run('disabled suggestions use native placeholder and tab_accept false preserves navigation', async () => {
    const f = fixture({remote: true, preferences: {enabled: false, include_memory: true, tab_accept: false}}); await loadHistory(f); await f.advance(1000);
    assert.equal(f.suggestionCalls().length, 0); assert.equal(f.input.placeholder, '输入消息'); assert.equal(f.state().status, 'disabled');
    f.ctx.window.HandwaveSuggestions.setPreferences({enabled: true}); await f.advance(400); await receiveCandidate(f);
    hint(f, /检查相关测试/); assert.doesNotMatch(f.input.placeholder, /Tab/); assert.equal(f.emit('keydown', {key: 'Tab'}).prevented, false);
    f.ctx.window.HandwaveSuggestions.setPreferences({tab_accept: true}); assert.equal(f.emit('keydown', {key: 'Tab'}).prevented, true);
  });
  await run('malformed, cross-scope and expired receipts silently retain local fallback', async () => {
    for (const invalid of [{device_fp: 'other'}, {workspace_id: 'other'}, {session_id: 'other'}, {next_prompt: '两行\n文本'}, {next_prompt: 'x'.repeat(241)}, {revision: ''}, {expires_at: '2000-01-01T00:00:00Z'}]) {
      const f = fixture({remote: true}); await loadHistory(f); await f.advance(400); await receiveCandidate(f, invalid);
      hint(f, /相关代码与测试/); assert.equal(f.state().status, 'unavailable'); assert.equal(f.state().summary, '');
      await f.advance(1000); assert.equal(f.suggestionCalls().length, 1);
    }
  });
  await run('network failure falls back without retrying or surfacing raw error', async () => {
    const f = fixture({remote: true}); await loadHistory(f); await f.advance(400); f.suggestionCalls()[0].reject(new Error('PRIVATE NETWORK RESPONSE')); await f.advance(0);
    assert.equal(f.state().status, 'unavailable'); hint(f, /相关代码与测试/); assert.doesNotMatch(JSON.stringify(f.state()), /PRIVATE NETWORK/);
    f.emit('focus'); await f.advance(5000); assert.equal(f.suggestionCalls().length, 1);
  });
  await run('candidate expires within sixty seconds without automatic regeneration; focus refreshes once', async () => {
    const f = fixture({remote: true}); await loadHistory(f); await f.advance(400); await receiveCandidate(f, {expires_at: '2026-10-17T00:00:00Z'});
    await f.advance(60000); assert.equal(f.state().summary, ''); assert.equal(f.suggestionCalls().length, 1); hint(f, /相关代码与测试/);
    f.emit('focus'); f.emit('focus'); await f.advance(400); assert.equal(f.suggestionCalls().length, 2);
    f.suggestionCalls()[1].reject(new Error('unavailable')); await f.advance(0); f.emit('focus'); await f.advance(400); assert.equal(f.suggestionCalls().length, 2);
  });
  await run('explicit refresh obeys draft/busy/history gates and returns a state Promise', async () => {
    const f = fixture({remote: true}); const api = f.ctx.window.HandwaveSuggestions;
    await api.refresh(); assert.equal(f.suggestionCalls().length, 0);
    await loadHistory(f); f.input.value = '草稿'; f.emit('input'); await api.refresh(); assert.equal(f.suggestionCalls().length, 0);
    f.input.value = ''; f.emit('input'); f.ctx.sending = true; await api.refresh(); assert.equal(f.suggestionCalls().length, 0);
    f.ctx.sending = false; const p = api.refresh(); assert.equal(f.suggestionCalls().length, 1); await receiveCandidate(f); assert.equal((await p).status, 'ready');
  });
  await run('empty history and missing binding keep local hints without remote requests', async () => {
    const empty = fixture({remote: true}); await loadHistory(empty, []); await empty.advance(500); assert.equal(empty.suggestionCalls().length, 0);
    const noDevice = fixture(); await loadHistory(noDevice); await noDevice.advance(500); assert.equal(noDevice.suggestionCalls().length, 0);
  });
  console.log(count + ' composer suggestion fixture checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
