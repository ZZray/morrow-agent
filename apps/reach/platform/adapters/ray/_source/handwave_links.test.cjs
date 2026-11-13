// Controlled DOM/transport tests. Real browser and Node acceptance are separate.
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const code = fs.readFileSync(__dirname + '/handwave_links.js', 'utf8');
class Element {
  constructor(tag, doc) { Object.assign(this, {tagName: tag, doc, children: [], attrs: {}, listeners: {}, dataset: {}, value: '', selectionStart: 0, selectionEnd: 0, hidden: false, disabled: false, _text: ''}); }
  appendChild(e) { e.parentNode = this; this.children.push(e); return e; }
  replaceChildren() { this.children.forEach(e => e.parentNode = null); this.children = []; this._text = ''; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(e => e !== this); this.parentNode = null; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(k, fn, capture) { (this.listeners[k] ||= []).push({fn, capture: !!capture}); }
  emit(k, extra = {}) { const e = {type: k, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, stopImmediatePropagation() { this.immediate = true; }, ...extra}; for (const l of [...this.listeners[k] || []].sort((a, b) => b.capture - a.capture)) { l.fn(e); if (e.immediate) break; } return e; }
  dispatchEvent(e) { return this.emit(e.type, e); }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  setRangeText(v, a, b) { this.value = this.value.slice(0, a) + v + this.value.slice(b); this.setSelectionRange(a + v.length, a + v.length); }
  focus() { this.doc.activeElement = this; }
  querySelector(selector) { return walk(this).find(e => selector.startsWith('.') && (e.className || '').split(' ').includes(selector.slice(1))); }
}
function walk(e) { return [e, ...e.children.flatMap(walk)]; }
const hash = 'a'.repeat(64);
function fixture(options = {}) {
  const doc = {}; doc.documentElement = new Element('html', doc); doc.body = doc.documentElement.appendChild(new Element('body', doc));
  const composer = doc.body.appendChild(new Element('div', doc)), input = composer.appendChild(new Element('textarea', doc)); input.id = 'input';
  const rail = doc.body.appendChild(new Element('div', doc)); rail.className = 'hw-context-body'; const task = rail.appendChild(new Element('section', doc)); task.className = 'hw-context-card';
  doc.createElement = tag => new Element(tag, doc); doc.getElementById = id => walk(doc.documentElement).find(e => e.id === id); doc.querySelector = s => doc.documentElement.querySelector(s);
  doc.listeners = {}; doc.addEventListener = (key, fn) => (doc.listeners[key] ||= []).push(fn);
  const calls = [], sent = [], switches = [], drafts = [], signals = []; let run = 0;
  const c = {document: doc, window: {}, TextEncoder, Event: class {constructor(type) { this.type = type; }},
    curWS: {id: 'w', device_fp: 'fp'}, curSess: options.noSession ? null : {id: 'current'}, devices: [{fp: 'fp', name: 'Current', state: 'paired'}, {fp: 'next', name: 'Next', state: 'approved'}, {fp: 'no', name: 'Denied', state: 'denied'}],
    localTasks: new Map(), renderLocalBoard() {}, localBusy: false, sending: false, paired: true, helloDone: true, localMode: true, localRunID: '',
    async api(path, opts) {
      const body = opts && opts.body ? JSON.parse(opts.body) : null; calls.push({path, body});
      if (options.api) { const r = await options.api(path, opts); if (r !== undefined) return r; }
      if (path.endsWith('/sessions') && opts && opts.method === 'POST') return {id: 'new'};
      if (path.startsWith('/reference-sessions?workspace_id=')) return [{id: 'other', title: 'Other'}, {id: 'current', title: 'Current'}, ...Array.from({length: 6}, (_, i) => ({id: 's' + i, title: 'Session ' + i}))];
      if (path === '/agent-context') return {brief: 'verified', workspace_id: 'w', device_fp: 'fp', session_references: (body.reference_sessions || []).map(r => ({...r, title: 'Other', hash, truncated: true})), memory_receipt: {records: [{id: 'm', scope: 'workspace', hash}]}};
      return {};
    },
    sendFrame(frame) { sent.push(frame); return true; }, onFrame() {}, onSig() {}, sendSig(signal) {signals.push(signal); return true;}, setSendUI() {},
    selectSession(s) { switches.push(s.id); c.curSess = s; return Promise.resolve(); }, selectWorkspace(w) { c.curWS = w; c.curSess = null; return Promise.resolve(); },
    async sendChat() {
      const text = input.value; drafts.push(text); c.localRunID = 'run' + ++run; c.localBusy = true; c.sending = true; c.setSendUI(true);
      if (!c.curSess) { const s = await c.api('/workspaces/' + c.curWS.id + '/sessions', {method: 'POST', body: '{}'}); await c.selectSession(s); }
      await c.api('/agent-context', {method: 'POST', body: JSON.stringify({workspace_id: c.curWS.id, content: text})});
      return c.sendFrame({k: 'agent-loop', id: c.localRunID, msg: text});
    }
  };
  vm.createContext(c);
  if (options.real) {
    const crypto = require('node:crypto'), source = fs.readFileSync(__dirname + '/testdata/handwave-app-7ae318fe.js');
    assert.equal(crypto.createHash('sha256').update(source).digest('hex'), '7ae318fe13a6fd35cd652c3fed7ee51134ca7808d14aab8f1be0c18aa44a15b2');
    const original = source.toString('utf8'), part = (a, b) => { const from = original.indexOf(a), to = original.indexOf(b, from); assert(from >= 0 && to > from); return original.slice(from, to); };
    Object.assign(c, {$: id => id === 'input' ? input : {checked: false}, pendingAttach: [], clearPendingAttach() {}, stopRequested: false, localTasks: new Map(), pendingAsk: null,
      startLocalTick() {}, resetAgentRun() {}, recordAgentEvent() {}, addBubble() {}, noteSession() {}, beginAssistant: () => ({append() {}, finalize() {}}),
      agentLoopModelSelection: () => ({model: 'default', protocol: ''}), selectedSkills: [], newToolId: () => 'run' + ++run,
      refreshRailWS: async () => {}, console, onSig() {}, sendSig: () => true, finishLocalRun() {c.localBusy = false;},
    });
    vm.runInContext([part('function localComposerAction(', 'function noteSession('), part('async function ensureChatContext(', '// ---------- 知识库'), part('async function startLocalRun(', 'function bindLocalAgent('), part('async function sendChat(', 'function cancelActiveWork(')].join('\n'), c);
    vm.runInContext(fs.readFileSync(__dirname + '/handwave_memory_transport.js', 'utf8'), c);
  }
  vm.runInContext(code, c);
  const all = () => walk(doc.documentElement), field = label => all().find(e => e.attrs['aria-label'] === label), textButton = text => all().find(e => e.tagName === 'button' && e.textContent === text);
  c.onFrame({k: 'node-hello', fp: 'fp', info: {caps: options.old ? [] : ['run-modes-v1', 'session-v1', 'cloud-memory-v1', ...(options.goals ? ['goal-runner-v1', 'managed-jobs-v1'] : [])]}});
  const setInput = text => { input.value = text; input.setSelectionRange(text.length, text.length); input.emit('input'); };
  const chooseMode = value => { field('执行模式').value = value; field('执行模式').emit('change'); };
  const list = () => all().filter(e => e.attrs.role === 'option');
  const settle = () => { c.localBusy = false; c.sending = false; c.setSendUI(false); };
  return {c, doc, input, calls, sent, switches, drafts, signals, all, field, textButton, setInput, chooseMode, list, settle, state: () => c.window.HandwaveLinks.state()};
}
const tick = () => new Promise(r => setImmediate(r));
(async () => {
  let count = 0; async function test(name, fn) { await fn(); console.log('ok ' + ++count + ' - ' + name); }
  await test('new mode capabilities are required and old node retains execute', () => { const f = fixture({old: true}); f.chooseMode('plan'); assert.equal(f.state().mode, 'execute'); assert(f.field('执行模式').children[1].disabled); });
  await test('plan mode goes to both context and execution wire', async () => { const f = fixture(); f.chooseMode('plan'); f.setInput('inspect logs'); await f.c.sendChat(); assert.equal(f.sent[0].execution_mode, 'plan'); assert.equal(f.calls.find(x => x.path === '/agent-context').body.execution_mode, 'plan'); });
  await test('busy mode changes are rejected', () => { const f = fixture(); f.chooseMode('plan'); f.c.localBusy = true; f.chooseMode('goal'); assert.equal(f.state().mode, 'plan'); assert(f.field('执行模式').disabled); });
  await test('new session creation preserves requested plan but manual selection resets it', async () => { const f = fixture({noSession: true}); f.chooseMode('plan'); f.setInput('inspect'); await f.c.sendChat(); assert.equal(f.sent[0].execution_mode, 'plan'); f.settle(); await f.c.selectSession({id: 'manual'}); assert.equal(f.state().mode, 'execute'); });
  await test('pinned real composer/session creation and snapshot transport carry plan to exact native session', async () => { const f = fixture({real: true, noSession: true}); f.chooseMode('plan'); f.setInput('inspect only'); await f.c.sendChat(); await tick(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].msg, 'inspect only'); assert.equal(f.sent[0].execution_mode, 'plan'); assert.equal(f.sent[0].session_key, 'w/new'); assert.equal(f.input.value, ''); });
  await test('pinned real composer dispatches verified reference and preserves reference session identity', async () => { const f = fixture({real: true}); f.setInput('@Other'); await tick(); f.list()[0].emit('click'); f.setInput('compare'); await f.c.sendChat(); await tick(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].session_key, 'w/current'); assert.equal(f.state().references[0].hash, hash); assert.equal(f.switches.length, 0); });
  await test('goal defaults completion criterion to objective and supports explicit lines', async () => { const f = fixture(); f.chooseMode('goal'); f.setInput('fix report'); await f.c.sendChat(); assert.deepEqual(Array.from(f.sent[0].goal_criteria), ['fix report']); const g = fixture(); g.chooseMode('goal'); g.field('目标完成标准').value = 'tests pass\noutput verified'; g.setInput('fix'); await g.c.sendChat(); assert.deepEqual(Array.from(g.sent[0].goal_criteria), ['tests pass', 'output verified']); });
  await test('UTF8 criterion and entry budgets block before dispatch', async () => { const f = fixture(); f.chooseMode('goal'); f.field('目标完成标准').value = '中'.repeat(342); f.setInput('fix'); await f.c.sendChat(); assert.equal(f.sent.length, 0); f.field('目标完成标准').value = Array(9).fill('x').join('\n'); await f.c.sendChat(); assert.equal(f.sent.length, 0); });
  await test('at-session is a read-only chip and leaves selected session unchanged', async () => { const f = fixture(); f.setInput('@Other'); await tick(); f.list()[0].emit('click'); assert.equal(f.state().references[0].session_id, 'other'); assert.equal(f.c.curSess.id, 'current'); assert.deepEqual(f.switches, []); assert.equal(f.input.value, ''); });
  await test('mentions use only current workspace directory and max four refs', async () => { const f = fixture(); for (let i = 0; i < 5; i++) { f.setInput('@Session '); f.setInput('@Session'); await tick(); f.list()[i].emit('click'); } assert.equal(f.state().references.length, 4); assert(f.calls.filter(c => c.path.startsWith('/reference-sessions?')).every(c => c.path === '/reference-sessions?workspace_id=w') && !f.calls.some(c => /\/workspaces\/.+\/sessions$/.test(c.path))); });
  await test('Arrow/Enter handles mention without submitting; Escape restores input', async () => { const f = fixture(); f.setInput('@Other'); await tick(); const e = f.input.emit('keydown', {key: 'Enter'}); assert(e.defaultPrevented && e.immediate); assert.equal(f.drafts.length, 0); f.setInput('@'); f.input.emit('keydown', {key: 'Escape'}); assert.equal(f.doc.getElementById('hwContextLinks').hidden, true); assert.equal(f.input.value, '@'); });
  await test('Tab closes mention and retains normal focus behavior', async () => { const f = fixture(); f.setInput('@Other'); await tick(); const e = f.input.emit('keydown', {key: 'Tab'}); assert(!e.defaultPrevented); assert.equal(f.state().references.length, 0); });
  await test('IME composition never selects or submits a mention', async () => { const f = fixture(); f.setInput('@Other'); await tick(); f.input.emit('compositionstart'); f.input.emit('keydown', {key: 'Enter', isComposing: true}); assert.equal(f.state().references.length, 0); assert.equal(f.drafts.length, 0); });
  await test('verified references use server hashes and show exact memory receipt', async () => { const f = fixture(); f.setInput('@Other'); await tick(); f.list()[0].emit('click'); f.setInput('compare'); await f.c.sendChat(); assert.equal(f.state().references[0].hash, hash); assert.match(f.doc.body.textContent, /全局（Ray 共享）/); assert.match(f.doc.body.textContent, /已截断/); f.settle(); f.setInput('continue'); await f.c.sendChat(); const body = f.calls.filter(x => x.path === '/agent-context').at(-1).body; assert.equal(body.reference_sessions[0].expected_hash, hash); assert(!Object.hasOwn(body.reference_sessions[0], 'text')); });
  await test('missing reference receipts reject dispatch', async () => { const f = fixture({api: async path => path === '/agent-context' ? {session_references: []} : undefined}); f.setInput('@Other'); await tick(); f.list()[0].emit('click'); f.setInput('compare'); await assert.rejects(f.c.sendChat(), /未完整核验/); assert.equal(f.sent.length, 0); });
  await test('pinned catch-and-continue cannot dispatch after outer reference admission failed', async () => { const f = fixture({real: true, api: async path => path === '/agent-context' ? {brief: 'not admitted', workspace_id: 'w', device_fp: 'fp', session_references: [], memory_receipt: {}} : undefined}); f.setInput('@Other'); await tick(); f.list()[0].emit('click'); f.setInput('compare'); await f.c.sendChat(); await tick(); assert.equal(f.sent.length, 0); });
  await test('pinned first device binding is admitted and retains verified brief', async () => { const f = fixture({real: true}); f.c.curWS.device_fp = ''; f.setInput('inspect'); await f.c.sendChat(); await tick(); assert.equal(f.c.curWS.device_fp, 'fp'); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].brief, 'verified'); });
  await test('pinned busy follow uses prior verified run and does not fabricate a new context', async () => { const f = fixture({real: true}); f.chooseMode('plan'); f.setInput('inspect'); await f.c.sendChat(); await tick(); f.setInput('continue inspection'); await f.c.sendChat(); await tick(); assert.equal(f.sent.length, 2); assert.equal(f.sent[1].execution_mode, 'plan'); assert.equal(f.sent[1].session_key, 'w/current'); assert.equal(f.calls.filter(x => x.path === '/agent-context').length, 1); });
  await test('switching session clears references and rejects late directory results', async () => { let release; const f = fixture({api: path => path.startsWith('/reference-sessions?workspace_id=') ? new Promise(r => {release = r;}) : undefined}); f.setInput('@'); await f.c.selectSession({id: 'new'}); release([{id: 'stale', title: 'stale'}]); await tick(); assert.equal(f.list().length, 0); assert.equal(f.state().references.length, 0); });
  await test('untrusted display strings stay textContent', async () => { const f = fixture({api: async path => path.startsWith('/reference-sessions?workspace_id=') ? [{id: 'x', title: '<img src=x onerror=alert(1)>'}] : undefined}); f.setInput('@'); await tick(); assert.match(f.list()[0].textContent, /<img/); assert.equal(f.all().some(e => e.tagName === 'img'), false); });
  await test('machine hook cannot authorize, switch busy target, or use denied machine', () => { const f = fixture(); let connected = 0; f.c.window.HandwaveMachineTarget = () => { connected++; return true; }; assert.equal(f.c.window.HandwaveLinks.selectMachine('no'), false); f.c.localBusy = true; assert.equal(f.c.window.HandwaveLinks.selectMachine('next'), false); f.c.localBusy = false; assert.equal(f.c.window.HandwaveLinks.selectMachine('next'), true); assert.equal(connected, 1); assert.equal(f.sent.length, 0); });
  await test('no machine owner callback reports unavailable rather than approve', () => { const f = fixture(); assert.equal(f.c.window.HandwaveLinks.selectMachine('next'), false); assert.match(f.doc.body.textContent, /工具与连接/); });
  await test('late old-run goal cannot affect newly selected conversation', async () => { const f = fixture(); f.setInput('task'); await f.c.sendChat(); await f.c.selectSession({id: 'new'}); f.c.onFrame({k: 'agent-event', id: 'run1', event: {type: 'goal_update', goal: {id: 'g', objective: 'OLD', revision: 1, steps: [], status: 'awaiting_review'}}}); assert.equal(f.state().goal, null); });
  await test('new handshake rejects stale goal/candidate events from old peer epoch', async () => { const f = fixture(); f.setInput('task'); await f.c.sendChat(); f.c.onFrame({k: 'node-hello', fp: 'fp', info: {caps: ['run-modes-v1']}}); f.c.onFrame({k: 'agent-event', id: 'run1', event: {type: 'goal_update', goal: {id: 'g', objective: 'OLD', revision: 1, steps: [], status: 'awaiting_review'}}}); assert.equal(f.state().goal, null); });
  await test('older same-owner run cannot replace a new goal or publish its old candidate', async () => { const f = fixture(); f.chooseMode('goal'); f.setInput('first'); await f.c.sendChat(); const event = (run, e) => f.c.onFrame({k: 'agent-event', id: run, event: e}); event('run1', {type: 'goal_update', goal: {id: 'g1', objective: 'first', revision: 1, steps: [], status: 'running'}}); event('run1', {type: 'tool_start', title: 'experience_propose', step_id: 'old', detail: JSON.stringify({lesson: 'old', conditions: 'old', source_ids: []})}); f.settle(); f.setInput('second'); await f.c.sendChat(); event('run2', {type: 'goal_update', goal: {id: 'g2', objective: 'second', revision: 1, steps: [], status: 'running'}}); event('run1', {type: 'goal_update', goal: {id: 'g1', objective: 'first', revision: 99, steps: [], status: 'awaiting_review'}}); event('run1', {type: 'tool_end', title: 'experience_propose', step_id: 'old', status: 'completed', output: JSON.stringify({id: 'old', status: 'candidate', adopted: false})}); assert.equal(f.state().goal.id, 'g2'); assert.equal(f.state().candidate, null); });
  await test('goal stays awaiting review and confirmation carries exact goal id', async () => { const f = fixture(); f.chooseMode('goal'); f.setInput('fix'); await f.c.sendChat(); f.c.onFrame({k: 'agent-event', id: 'run1', event: {type: 'goal_update', goal: {id: 'g1', objective: 'fix', revision: 2, steps: [], status: 'awaiting_review'}}}); assert.equal(f.state().goal.status, 'awaiting_review'); assert(f.textButton('确认完成').disabled); f.settle(); f.input.value = ''; f.textButton('确认完成').emit('click'); await tick(); assert.equal(f.drafts.at(-1), '/goal accept g1'); assert.equal(f.sent.at(-1).goal_id, 'g1'); });
  await test('experience card requires matched successful real tool receipt', async () => { const f = fixture(); f.setInput('fix'); await f.c.sendChat(); const event = e => f.c.onFrame({k: 'agent-event', id: 'run1', event: e}); event({type: 'tool_end', title: 'experience_propose', step_id: 'wrong', status: 'completed', output: JSON.stringify({id: 'm', status: 'candidate', adopted: false})}); assert.equal(f.state().candidate, null); event({type: 'tool_start', title: 'experience_propose', step_id: 't', detail: JSON.stringify({lesson: 'Read errors first', conditions: 'Parser errors', source_ids: ['source']})}); event({type: 'tool_end', title: 'experience_propose', step_id: 't', status: 'completed', output: JSON.stringify({id: 'm', status: 'candidate', adopted: false})}); assert.equal(f.state().candidate.id, 'm'); assert.match(f.doc.body.textContent, /未采纳/); let seed; f.c.window.HandwaveMemory = {openLesson: s => {seed = s; return true;}}; f.textButton('保存云端经验').emit('click'); await tick(); assert.match(seed.text, /独立云端副本/); assert.match(seed.text, /run1/); assert.equal(f.sent.length, 1); });
  await test('busy reference mutations are blocked', async () => { const f = fixture(); f.setInput('@Other'); await tick(); f.c.localBusy = true; f.list()[0].emit('click'); assert.equal(f.state().references.length, 0); });
  await test('375px rules bound menu/chips and maintain touch/text targets', () => { const css = fs.readFileSync(__dirname + '/handwave_links.css', 'utf8'); assert.match(css, /calc\(100vw - 48px\)/); assert.match(css, /max-width:780px/); assert.match(css, /font-size:16px/); assert.match(css, /min-height:44px/); });
  await test('background is explicit and defaults remain 1h 48 calls 8 slices', async () => { const f = fixture({goals: true}); f.chooseMode('goal'); f.setInput('inspect'); await f.c.sendChat(); assert.equal(f.sent[0].goal_policy, undefined); const next = fixture({goals: true, noSession: true}); next.chooseMode('goal'); next.field('允许关闭网页后继续目标').checked = true; next.setInput('inspect'); const before = Math.floor(Date.now()/1000); await next.c.sendChat(); assert.equal(next.sent[0].goal_policy.max_calls, 48); assert.equal(next.sent[0].goal_policy.max_slices, 8); assert.equal(next.sent[0].goal_policy.allow_jobs, false); assert(next.sent[0].goal_policy.expires_at >= before + 3600); });
  await test('trusted goal mirror rejects other device session and old revision', () => { const f = fixture({goals: true}); const mirror = {k: 'goal-state', fp: 'fp', session_key: 'w/current', writer_epoch: 'epoch1', goal_lease: {goal_id: 'g', device: 'fp', session: 'w/current', expires_at: Math.floor(Date.now()/1000)+3600, max_calls:48, max_slices:8}, goal: {id:'g',revision:3,run:'r1',last_settled_run:'r1',status:'awaiting_review',objective:'inspect',steps:[]}}; f.c.onSig({...mirror,fp:'other'}); assert.equal(f.state().goal,null); f.c.onSig({...mirror,session_key:'w/other'}); assert.equal(f.state().goal,null); f.c.onSig(mirror); f.c.onSig({...mirror,writer_epoch:'old',goal:{...mirror.goal,revision:2}}); assert.equal(f.state().goal.revision,3); assert.equal(f.state().mirrorEpoch,'epoch1'); });
  await test('background accept carries exact revision settled run and waits for Node', async () => { const f = fixture({goals:true}); f.c.onSig({k:'goal-state',fp:'fp',session_key:'w/current',writer_epoch:'epoch',goal_lease:{goal_id:'g',device:'fp',session:'w/current',expires_at:Math.floor(Date.now()/1000)+3600,max_calls:48,max_slices:8},goal:{id:'g',revision:4,last_settled_run:'r4',status:'awaiting_review',objective:'inspect',steps:[]}}); f.textButton('确认完成').emit('click'); const s=f.signals.at(-1); assert.equal(s.k,'goal-command');assert.equal(s.expected_revision,4);assert.equal(s.reviewed_run_id,'r4');assert.equal(s.command,'accept');assert.equal(f.state().goal.status,'awaiting_review');assert(f.state().pendingCommand);f.c.onSig({k:'goal-command-result',command_id:s.command_id,err:'stale goal revision'});assert.equal(f.state().pendingCommand,null);assert.match(f.doc.body.textContent,/stale goal revision/); });
  await test('managed jobs require their own explicit selection and preserve new session ownership', async () => { const f = fixture({goals:true,noSession:true}); f.chooseMode('goal'); const background = f.field('允许关闭网页后继续目标'); background.checked = true; background.emit('change'); const jobs = f.field('允许目标托管长进程'); assert.equal(jobs.parentNode.hidden,false); jobs.checked = true; f.setInput('build'); await f.c.sendChat(); assert.equal(f.sent[0].goal_policy.allow_jobs,true); await f.c.selectSession({id:'another'}); assert.equal(jobs.checked,false); });
  await test('leased blocked goals expose exact stop without misleading continue or implicit resume', async () => {
    for (const status of ['running','waiting_job','paused','waiting_authorization','budget_limited','waiting_recovery']) {
      const f=fixture({goals:true});f.chooseMode('goal');
      f.c.onSig({k:'goal-state',fp:'fp',session_key:'w/current',writer_epoch:'epoch',goal_lease:{goal_id:'g',device:'fp',session:'w/current',expires_at:Math.floor(Date.now()/1000)+(status==='paused'?-1:3600),max_calls:48,max_slices:8},goal:{id:'g',revision:7,status,last_settled_run:'settled',objective:'inspect',steps:[]}});
      assert.equal(f.textButton('继续目标'),undefined);const stop=f.textButton('停止目标');assert(stop&&!stop.disabled,status+' has no stop');
      if(['waiting_authorization','budget_limited','waiting_recovery','paused'].includes(status)){f.setInput('continue');await f.c.sendChat();assert.equal(f.sent.length,0,status+' continued despite blocked contract');assert.match(f.doc.body.textContent,/停止此目标/);}
      stop.emit('click');const s=f.signals.at(-1);assert.equal(s.k,'goal-command');assert.equal(s.command,'stop');assert.equal(s.goal_id,'g');assert.equal(s.expected_revision,7);assert.equal(f.state().goal.status,status);assert(f.state().pendingCommand);
    }
  });
  await test('stopped and accepted goals permit explicitly authorized fresh goals without old identity or lease', async () => {
    for(const terminal of ['canceled','accepted']) {
      const f=fixture({goals:true});f.chooseMode('goal');const mirror=(status,revision,id='old')=>({k:'goal-state',fp:'fp',session_key:'w/current',writer_epoch:'epoch',goal_lease:{goal_id:id,device:'fp',session:'w/current',expires_at:Math.floor(Date.now()/1000)+3600,max_calls:48,max_slices:8},goal:{id,revision,status,last_settled_run:'settled',objective:'old objective',steps:[]}});
      f.c.onSig(mirror('running',1));f.field('允许关闭网页后继续目标').checked=true;f.field('允许目标托管长进程').checked=true;f.c.onSig(mirror(terminal,2));
      assert.equal(f.field('允许关闭网页后继续目标').disabled,false);assert.equal(f.field('允许关闭网页后继续目标').checked,false);assert.equal(f.field('允许目标托管长进程').checked,false);assert.equal(f.textButton('停止目标'),undefined);
      f.textButton('新建目标').emit('click');f.field('允许关闭网页后继续目标').checked=true;f.field('允许目标托管长进程').checked=true;f.setInput('new objective');await f.c.sendChat();const sent=f.sent.at(-1);assert.equal(sent.goal_id,undefined);assert(sent.goal_policy);assert.equal(sent.goal_policy.allow_jobs,true);assert.deepEqual(Array.from(sent.goal_criteria),['new objective']);assert.equal(f.state().lease,null);
      f.c.onSig(mirror('running',1,'new'));f.c.onSig(mirror(terminal,999));assert.equal(f.state().goal.id,'new');
    }
  });
  await test('goal evidence folds retain user state and keep exact review controls outside', async () => {
    const f = fixture(); f.chooseMode('goal'); f.setInput('inspect'); await f.c.sendChat();
    const update = (id, revision) => f.c.onFrame({k: 'agent-event', id: 'run1', event: {type: 'goal_update', goal: {id, objective: 'long objective', revision, steps: [{name: 'check', status: 'done', evidence: 'full receipt'}], status: 'awaiting_review'}}});
    update('fold-goal', 1);
    const find = cls => f.all().find(e => (e.className || '').split(' ').includes(cls));
    const detail = find('hw-goal-details'); assert.equal(detail.tagName, 'details'); assert(!detail.open);
    assert.match(detail.textContent, /目标 · 待你验收 · 1\/1/);
    assert.match(detail.textContent, /long objective.*full receipt/);
    assert.notEqual(f.textButton('确认完成').parentNode, detail);
    detail.open = true; update('fold-goal', 2); assert.equal(find('hw-goal-details'), detail); assert(detail.open);
    detail.open = false; update('fold-goal', 3); assert(!detail.open);
    update('new-fold-goal', 4); assert(!detail.open);
    const receipt = find('hw-links-receipts'); assert.equal(receipt.tagName, 'details'); assert(!receipt.open);
  });
  await test('trusted Goal renders saved criteria and its canonical persistent steps', async () => {
    const f = fixture(); f.chooseMode('goal'); f.setInput('inspect'); await f.c.sendChat();
    const update = (revision, steps) => f.c.onFrame({k:'agent-event',id:'run1',event:{type:'goal_update',goal:{id:'native-goal',objective:'native objective',criteria:['actual saved criterion'],criteria_revision:3,revision,status:'running',steps}}});
    update(2,[{name:'inspect',status:'in_progress',evidence:''},{name:'report',status:'pending',evidence:''}]);
    assert.match(f.doc.documentElement.textContent,/完成标准 · 版本 3actual saved criterion/);
    f.field('目标完成标准').value='unsent composer draft';
    update(3,[{name:'verified',status:'done',evidence:'actual receipt'}]);
    assert.match(f.doc.documentElement.textContent,/verified · done · actual receipt/);
    assert.doesNotMatch(f.doc.documentElement.textContent,/report · pending/);
    update(1,[{name:'late stale step',status:'in_progress',evidence:''}]);
    assert.doesNotMatch(f.doc.documentElement.textContent,/late stale step/);
    f.settle(); await f.c.selectSession({id:'other'});
    assert.doesNotMatch(f.doc.documentElement.textContent,/actual saved criterion|actual receipt/);
  });
  await test('goal editor saves a bounded draft without dispatching or granting background authority', async () => {
    const f=fixture({goals:true}); f.setInput('original draft');
    assert.equal(f.c.window.HandwaveLinks.openGoalEditor(),true);
    const editor=f.all().find(e=>e.tagName==='dialog'), advanced=f.all().find(e=>e.className==='hw-goal-advanced');
    assert.equal(editor.attrs.open,''); assert.equal(advanced.open,false);
    f.field('目标正文').value='inspect and repair'; f.field('目标完成标准').value='verified report';
    f.textButton('保存').emit('click'); assert.equal(f.input.value,'original draft'); assert.equal(f.state().goalDraft.text,'inspect and repair'); assert.equal(f.state().mode,'goal'); assert.equal(f.sent.length,0); assert.equal(f.signals.length,0);
    assert.equal(f.field('执行模式').hidden,true);
    const strip=f.all().find(e=>e.className==='hw-goal-strip'); assert.equal(strip.hidden,false); assert.match(strip.textContent,/目标草稿.*inspect and repair/);
    await f.c.sendChat(); assert.equal(f.sent[0].execution_mode,'goal'); assert.equal(f.sent[0].msg,'inspect and repair\n\n本次补充：\noriginal draft'); assert.equal(f.input.value,''); assert.deepEqual(Array.from(f.sent[0].goal_criteria),['verified report']); assert.equal(f.sent[0].goal_policy,undefined);
  });
  await test('editor cancel rolls back advanced permissions and preserves composer plus previous mode', () => {
    const f=fixture({goals:true}); f.c.window.HandwaveLinks.setMode('plan'); f.setInput('keep input');
    f.c.window.HandwaveLinks.openGoalEditor(); f.field('目标正文').value='discard this'; f.field('目标完成标准').value='discard criterion'; f.field('允许关闭网页后继续目标').checked=true; f.field('允许目标托管长进程').checked=true;
    f.textButton('取消').emit('click'); assert.equal(f.state().mode,'plan'); assert.equal(f.input.value,'keep input'); assert.equal(f.field('目标完成标准').value,''); assert.equal(f.field('允许关闭网页后继续目标').checked,false); assert.equal(f.field('允许目标托管长进程').checked,false);
  });
  await test('saved native objective is read-only and strip controls preserve exact revision and human review', () => {
    const f=fixture({goals:true}); f.c.onSig({k:'goal-state',fp:'fp',session_key:'w/current',writer_epoch:'epoch',goal_lease:{goal_id:'g',device:'fp',session:'w/current',expires_at:Math.floor(Date.now()/1000)+3600,max_calls:48,max_slices:8},goal:{id:'g',revision:4,last_settled_run:'r4',status:'running',objective:'native objective',steps:[]}});
    const strip=f.all().find(e=>e.className==='hw-goal-strip'); assert.match(strip.textContent,/native objective.*进行中/); assert.doesNotMatch(strip.textContent,/\d+[smh]/);
    assert.equal(f.c.window.HandwaveLinks.openGoalEditor(),true); assert.equal(f.field('目标正文').readOnly,true); assert.equal(f.textButton('保存').disabled,true);
    f.field('目标正文').value='forged local edit'; f.textButton('保存').emit('click'); assert.equal(f.state().goal.objective,'native objective'); assert.equal(f.signals.length,0);
    f.textButton('暂停目标').emit('click'); assert.equal(f.signals.at(-1).expected_revision,4); assert.equal(f.signals.at(-1).command,'pause'); assert.equal(f.state().goal.status,'running');
  });
  await test('editor cannot leak a draft across session changes or admit oversized objective', async () => {
    const f=fixture({goals:true}); f.c.window.HandwaveLinks.openGoalEditor(); f.field('目标正文').value='中'.repeat(2731); f.textButton('保存').emit('click'); assert.equal(f.input.value,''); assert.match(f.doc.body.textContent,/正文最多/);
    f.field('目标正文').value='old session draft'; await f.c.selectSession({id:'another'}); f.textButton('保存').emit('click'); assert.equal(f.input.value,''); assert.equal(f.state().mode,'execute'); assert.equal(f.sent.length,0);
    const old=fixture({old:true}); assert.equal(old.c.window.HandwaveLinks.openGoalEditor(),false); assert.equal(old.c.window.HandwaveLinks.setMode('plan'),false);
  });
  await test('pinned real composer captures standalone goal with empty input and preserves exact new-session admission', async () => {
    const f=fixture({real:true,noSession:true,goals:true}); f.c.window.HandwaveLinks.openGoalEditor(); f.field('目标正文').value='repair the environment'; f.textButton('保存').emit('click');
    assert.equal(f.input.value,''); assert.equal(f.state().goalDraft.text,'repair the environment');
    await f.c.sendChat(); await tick(); assert.equal(f.sent.length,1); assert.equal(f.sent[0].msg,'repair the environment'); assert.equal(f.sent[0].session_key,'w/new'); assert.deepEqual(Array.from(f.sent[0].goal_criteria),['repair the environment']); assert.equal(f.sent[0].goal_policy,undefined);
  });
  await test('pinned draft admission keeps visible input intact while pending and never clears newer edits', async () => {
    let release; const f=fixture({real:true,goals:true,api:path=>path==='/agent-context'?new Promise(r=>{release=r;}):undefined});
    f.setInput('keep this note'); f.c.window.HandwaveLinks.openGoalEditor(); f.field('目标正文').value='long independent objective'; f.textButton('保存').emit('click');
    assert.equal(f.input.value,'keep this note'); await f.c.sendChat(); await tick(); assert.equal(f.input.value,'keep this note'); assert.equal(f.sent.length,0);
    f.setInput('new unsent edit'); release({brief:'verified',workspace_id:'w',device_fp:'fp',session_references:[],memory_receipt:{records:[]}}); await tick();
    assert.equal(f.sent.length,1); assert.equal(f.sent[0].msg,'long independent objective\n\n本次补充：\nkeep this note'); assert.equal(f.input.value,'new unsent edit');
    assert.equal(f.calls.find(x=>x.path==='/agent-context').body.content,f.sent[0].msg);
  });
  await test('pinned reference rejection and cancellation before dispatch retain original input and independent goal', async () => {
    for(const cancel of [false,true]) {
      let release; const f=fixture({real:true,goals:true,api:path=>path==='/agent-context'?new Promise(r=>{release=r;}):undefined}); f.setInput('original note'); f.c.window.HandwaveLinks.openGoalEditor(); f.field('目标正文').value='independent goal'; f.textButton('保存').emit('click');
      await f.c.sendChat(); await tick(); if(cancel) f.c.stopRequested=true;
      release(cancel?{brief:'verified',workspace_id:'w',device_fp:'fp',session_references:[],memory_receipt:{records:[]}}:{brief:'wrong binding',workspace_id:'wrong',device_fp:'wrong',session_references:[],memory_receipt:{records:[]}}); await tick();
      assert.equal(f.sent.length,0); assert.equal(f.input.value,'original note'); assert.equal(f.state().goalDraft.text,'independent goal');
    }
  });
  await test('draft re-edit cancel and combined byte validation keep composer unchanged, session switch clears draft', async () => {
    const f=fixture({goals:true}); f.setInput('preserve input'); f.c.window.HandwaveLinks.openGoalEditor(); f.field('目标正文').value='saved goal'; f.textButton('保存').emit('click');
    f.textButton('目标草稿').emit('click'); assert.equal(f.field('目标正文').value,'saved goal'); f.field('目标正文').value='discarded goal'; f.textButton('取消').emit('click'); assert.equal(f.state().goalDraft.text,'saved goal'); assert.equal(f.input.value,'preserve input');
    f.setInput('x'.repeat(8192)); await f.c.sendChat(); assert.equal(f.sent.length,0); assert.equal(f.input.value.length,8192); assert.equal(f.state().goalDraft.text,'saved goal');
    await f.c.selectSession({id:'another'}); assert.equal(f.state().goalDraft,null); assert.equal(f.state().mode,'execute');
  });
  await test('goal editor Escape isolates the pinned global task-abort handler and preserves active Goal', () => {
    const f=fixture({goals:true}); const source=fs.readFileSync(__dirname+'/testdata/handwave-app-7ae318fe.js','utf8');
    const start=source.indexOf("  document.addEventListener('keydown', (e) => {\n    if (e.key !== 'Escape' || !localBusy) return;");
    assert(start>=0); const end=source.indexOf('\n  });',start); assert(end>start); vm.runInContext(source.slice(start,end+6),f.c); f.c.addBubble=()=>{};
    f.c.onSig({k:'goal-state',fp:'fp',session_key:'w/current',writer_epoch:'epoch',goal_lease:{goal_id:'g',device:'fp',session:'w/current',expires_at:Math.floor(Date.now()/1000)+3600,max_calls:48,max_slices:8},goal:{id:'g',revision:4,status:'running',objective:'keep working',steps:[]}});
    f.c.localBusy=true; f.c.localRunID='active-run'; f.setInput('preserve draft'); assert.equal(f.c.window.HandwaveLinks.openGoalEditor(),true);
    const editor=f.all().find(e=>e.tagName==='dialog'); const e=editor.emit('keydown',{key:'Escape'});
    if(!e.propagationStopped) for(const handler of f.doc.listeners.keydown||[]) handler(e);
    assert(e.defaultPrevented&&e.propagationStopped); assert.equal(f.sent.length,0); assert.equal(f.signals.length,0); assert.equal(f.state().goal.status,'running'); assert.equal(f.input.value,'preserve draft');
    for(const key of ['n','/']) { f.c.window.HandwaveLinks.openGoalEditor(); assert.equal(editor.emit('keydown',{key,ctrlKey:true}).propagationStopped,true); }
    for(const handler of f.doc.listeners.keydown) handler({key:'Escape'}); assert.equal(f.sent.at(-1).k,'agent-abort','outside-editor original abort behavior remains intact');
  });
  console.log(count + ' context link/mode checks passed');
})().catch(e => {console.error(e); process.exitCode = 1;});
