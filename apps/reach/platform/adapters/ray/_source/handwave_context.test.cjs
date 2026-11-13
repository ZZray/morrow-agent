// Controlled DOM/transport fixture: verifies presentation contracts, not a live browser.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync(__dirname + '/handwave_context.js', 'utf8');
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.className = ''; this.hidden = false; this.open = false; this._text = ''; }
  get classList() { const self = this; return {contains: c => self.className.split(' ').includes(c), add(c) { if (!this.contains(c)) self.className += ' ' + c; }, remove(c) { self.className = self.className.split(' ').filter(v => v !== c).join(' '); }, toggle(c, value) { value ? this.add(c) : this.remove(c); }}; }
  appendChild(e) { if (e.parentNode) e.parentNode.children = e.parentNode.children.filter(v => v !== e); e.parentNode = this; this.children.push(e); return e; }
  insertBefore(e, before) { const i = this.children.indexOf(before); if (i < 0) return this.appendChild(e); e.parentNode = this; this.children.splice(i, 0, e); return e; }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() { if (!this.parentNode) return null; return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(e => e.textContent).join(''); }
  replaceChildren(...children) { this._text = ''; this.children = []; children.forEach(e => this.appendChild(e)); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(e => e !== this); this.parentNode = null; }
  setAttribute(k, v) { this[k] = v; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  querySelector(sel) { return walk(this).find(e => sel[0] === '.' && e.classList.contains(sel.slice(1)) || e.tagName === sel) || null; }
}
function walk(e) { return [e, ...e.children.flatMap(walk)]; }
function fixture(options = {}) {
  const root = new Element('html');
  const main = root.appendChild(new Element('section')); main.className = 'chat-main';
  main.appendChild(new Element('div')).className = 'topbar';
  const ids = {};
  for (const id of ['messages', 'agentDock', 'agentRoster', 'agentTimeline', 'agentTasks', 'agentAsk', 'agentBashLine', 'agentCtl', 'agentQueuePanel', 'kbGlobal', 'kbProject']) { ids[id] = root.appendChild(new Element('div')); ids[id].id = id; }
  ids.agentDock.classList.add('hide');
  const pending = [], records = [], media = {matches: true, addEventListener(type, fn) { this.listener = fn; }};
  const ctx = {
    document: {documentElement: root, querySelector: s => s === '.chat-main' ? main : null, createElement: tag => new Element(tag), getElementById: id => walk(root).find(e => e.id === id) || null},
    window: {matchMedia: () => media}, URL, Promise, console,
    curWS: {id: 'ws'}, curSess: {id: 'a'}, pendingAttach: [], localRunID: '', localBusy: false, agentRun: {agents: new Map(), events: []},
    kbResponse: async () => [],
    api(path) { if (path.startsWith('/kb')) return ctx.kbResponse(path); return new Promise((resolve, reject) => pending.push({path, resolve, reject})); },
    selectSession(s) { ctx.curSess = s; ctx.agentRun.agents.clear(); ctx.renderAgentDock(); return Promise.resolve(); },
    selectWorkspace(w) { ctx.curWS = w; ctx.curSess = null; return Promise.resolve(); },
    renderAttachBar() {}, renderLocalBoard() {},
    agentIdentity: e => e.agent_id || 'local',
    renderAgentTimeline(agentID) {
      const box = ids.agentTimeline; box.replaceChildren();
      const head = box.appendChild(new Element('div')); head.className = 'agent-timeline-head';
      head.appendChild(new Element('b')).textContent = '调用过程';
      const close = head.appendChild(new Element('button')); close.textContent = '×';
      close.onclick = () => { ctx.agentRun.timeline = false; box.classList.add('hide'); };
      ctx.agentRun.events.filter(e => !agentID || ctx.agentIdentity(e) === agentID).forEach(e => {
        const row = box.appendChild(new Element('div')); row.className = 'agent-event';
        const copy = row.appendChild(new Element('div')); copy.appendChild(new Element('b')).textContent = e.title || '';
        if (e.detail) copy.appendChild(new Element('small')).textContent = e.detail;
        if (e.output) copy.appendChild(new Element('pre')).textContent = e.output;
      });
    },
    renderAgentDock() { ids.agentDock.classList.remove('hide'); },
    resetAgentRun(turn) { ctx.agentRun.turnID = turn; ctx.renderAgentDock(); },
    recordAgentEvent(event) { records.push(event); if (event.type === 'ui_request') ctx.pendingAsk = {id: event.step_id || '', prompt: event.title}; ctx.renderAgentDock(); },
    pendingAsk: null, onSig() {},
    completeCoordinator() {}, clearMessages() { ids.messages.replaceChildren(); },
    beginAssistant() { return {row: ids.messages.appendChild(new Element('div'))}; }, finishLocalRun() { ctx.localBusy = false; }, liveDockMeta() { return 'native metadata'; }, localTasks: new Map(),
    consumeSSE: async () => ({content: 'done'})
  };
  vm.createContext(ctx);
  if (options.realFinish) {
    const pinned = fs.readFileSync(__dirname + '/testdata/handwave-app-7ae318fe.js', 'utf8');
    const part = (a, b) => pinned.slice(pinned.indexOf(a), pinned.indexOf(b, pinned.indexOf(a)));
    vm.runInContext([part('const AGENT_STATUS = {', 'const AGENT_ROLE = {'), part('function completeCoordinator(', 'function formatElapsed('), part('function finishAgentRun(', 'setInterval(() => { if (agentRun.agents.size)')].join('\n'), ctx);
    const recovery = fs.readFileSync(__dirname + '/handwave_recovery.js', 'utf8');
    const label = recovery.match(/if \(typeof AGENT_STATUS[^\n]+AGENT_STATUS.interrupted[^\n]+/);
    assert(label); vm.runInContext(label[0], ctx);
  }
  vm.runInContext(code, ctx);
  const find = cls => walk(root).filter(e => e.classList.contains(cls));
  return {ctx, ids, root, main, pending, records, media, find};
}
(async () => {
  const f = fixture();
  assert.equal(f.find('hw-context-rail').length, 1);
  assert(f.ids.agentDock.parentNode.classList.contains('hw-context-card'));
  vm.runInContext(code, f.ctx);
  assert.equal(f.find('hw-context-rail').length, 1, 'idempotent append');
  assert.doesNotMatch(f.root.textContent, /定时任务 · 待集成/);
  assert.equal(f.find('hw-context-rail')[0].open, true);

  const old = f.ctx.api('/workspaces/ws/sessions/a/messages');
  await f.ctx.selectSession({id: 'b'});
  const event = {type: 'task_start', title: 'old running'};
  f.pending[0].resolve([{role: 'user', attachments: [{name: 'old.txt'}], events: [event]}]);
  await old;
  f.ctx.recordAgentEvent(event);
  assert.doesNotMatch(f.root.textContent, /old.txt|old running/);
  assert.equal(f.records.length, 0, 'late history never becomes a live task');

  const first = f.ctx.api('/workspaces/ws/sessions/b/messages');
  const second = f.ctx.api('/workspaces/ws/sessions/b/messages');
  const publicEvent = {type: 'tool_start', title: '<script>task</script>', detail: 'private detail', output: 'private output'};
  f.pending[2].resolve([{role: 'user', attachments: [{name: '<img onerror=evil>', url: 'javascript:evil'}, {name: '<img onerror=evil>', url: 'other'}], events: [publicEvent]}]);
  await second;
  f.pending[1].resolve([{role: 'user', attachments: [{name: 'older-same-session.txt'}]}]);
  await first;
  assert.doesNotMatch(f.root.textContent, /older-same-session/);
  assert.equal(f.find('hw-context-source').length, 1, 'source/name/size deduplication');
  assert.match(f.root.textContent, /<img onerror=evil>/);
  assert.equal(walk(f.root).some(e => e.tagName === 'img' || e.tagName === 'script' || e.href || e.src), false, 'attachments never inject markup or URLs');
  f.ctx.recordAgentEvent(publicEvent);
  assert.match(f.root.textContent, /历史过程/);
  assert.equal(f.records.length, 0, 'historical task_start does not create an active task');
  assert.doesNotMatch(f.root.textContent, /private detail|private output/);

  f.ctx.resetAgentRun('turn');
  assert.equal(f.find('hw-public-process').length, 1, 'new live process stays detached until the assistant row');
  const user = f.ids.messages.appendChild(new Element('div')); user.textContent = 'question';
  const assistant = f.ctx.beginAssistant();
  const details = f.find('hw-public-process').at(-1);
  assert.equal(f.ids.messages.children.indexOf(details), f.ids.messages.children.indexOf(user) + 1);
  assert.equal(details.nextSibling, assistant.row);
  assert.equal(details.open, false, 'new process is collapsed');
  details.open = true;
  f.ctx.recordAgentEvent({type: 'model_request', title: 'DeepSeek', detail: 'secret'});
  f.ctx.recordAgentEvent({type: 'text_delta', output: 'not a trace summary'});
  assert.equal(f.find('hw-public-process').at(-1), details, 'trace updates retain the same DOM');
  assert.equal(details.open, true, 'trace updates retain the user expansion state');
  assert.doesNotMatch(details.textContent, /secret|not a trace/);
  f.ctx.completeCoordinator('failed');
  assert.match(details.textContent, /公开过程 · 失败/);
  f.ctx.recordAgentEvent({type: 'agent_end', status: 'canceled'});
  assert.match(details.textContent, /公开过程 · 已停止/);
  await f.ctx.selectSession({id: 'c'});
  f.ctx.renderAgentDock();
  assert.equal(f.ids.agentDock.classList.contains('hide'), true, 'task card is scoped to the selected session');
  f.ctx.pendingAttach = [{name: 'draft.md'}]; f.ctx.renderAttachBar();
  assert.match(f.root.textContent, /draft.md待发送/);
  await f.ctx.api('/kb?scope=global');
  assert.doesNotMatch(f.root.textContent, /全局知识库 · 暂不可用/);
  f.ctx.kbResponse = async () => [{name: 'rules.md'}];
  await f.ctx.api('/kb?scope=global');
  assert.match(f.root.textContent, /rules.md全局知识库 · 未启用/);
  f.ids.kbGlobal.checked = true; f.ids.kbGlobal.listeners.change();
  assert.match(f.root.textContent, /rules.md全局知识库 · 已启用/);
  f.ctx.kbResponse = async () => { throw new Error('offline'); };
  await assert.rejects(f.ctx.api('/kb?scope=global'));
  assert.match(f.root.textContent, /全局知识库 · 暂不可用/);

  f.ctx.localRunID = 'local-run'; f.ctx.localBusy = true;
  f.ctx.resetAgentRun('local-run'); f.ctx.beginAssistant();
  await f.ctx.selectSession({id: 'other'});
  assert.equal(f.ids.agentDock.classList.contains('hide'), true);
  await f.ctx.selectSession({id: 'c'});
  assert.equal(f.ids.agentDock.classList.contains('hide'), false, 'returning to an active local session restores its existing controls');
  assert.match(f.root.textContent, /本机任务仍在运行，等待新事件/);
  f.media.matches = false; f.media.listener();
  assert.equal(f.find('hw-context-rail')[0].open, false);
  f.ctx.recordAgentEvent({type: 'ui_request', step_id: 'ask-local', title: 'Allow command'});
  assert.equal(f.find('hw-context-rail')[0].open, true, 'approval cannot be hidden by the compact rail');
  assert.match(f.find('hw-context-summary')[0].textContent, /等待确认/);
  f.ctx.agentRun.agents.set('child', {status: 'running'});
  f.ctx.finishLocalRun();
  f.ctx.renderAgentDock();
  assert.match(f.find('hw-context-summary')[0].textContent, /已结束/);
  assert.doesNotMatch(f.find('hw-context-summary')[0].textContent, /进行中/);
  assert.match(f.ctx.liveDockMeta(), /执行已结束/);

  const cloud = fixture();
  cloud.ctx.resetAgentRun('cloud-turn'); cloud.ctx.beginAssistant();
  assert.equal(cloud.ids.agentCtl.classList.contains('hw-context-unowned'), true, 'cloud run hides local control buttons');
  assert.equal(cloud.ids.agentQueuePanel.classList.contains('hw-context-unowned'), true, 'cloud run hides local queue recovery');
  cloud.ctx.recordAgentEvent({type: 'ui_request', step_id: 'cloud-ask', title: 'Allow delegated action'});
  assert.equal(cloud.ids.agentAsk.classList.contains('hw-context-unowned'), false, 'live cloud delegated approval remains visible');
  cloud.ctx.pendingAsk = null; cloud.ctx.renderLocalBoard();
  assert.equal(cloud.ids.agentAsk.classList.contains('hw-context-unowned'), true, 'resolved approval disappears');
  cloud.ctx.recordAgentEvent({type: 'ui_request', step_id: 'stale-ask'});
  cloud.ctx.resetAgentRun('next-cloud-turn');
  assert.equal(cloud.ids.agentAsk.classList.contains('hw-context-unowned'), true, 'new run never restores an old approval');
  const replayAsk = {type: 'ui_request', step_id: 'history-ask'};
  const replayRequest = cloud.ctx.api('/workspaces/ws/sessions/a/messages');
  cloud.pending[0].resolve([{role: 'assistant', events: [replayAsk]}]);
  await replayRequest; cloud.ctx.recordAgentEvent(replayAsk);
  assert.equal(cloud.ids.agentAsk.classList.contains('hw-context-unowned'), true, 'history cannot wake an approval');
  cloud.ctx.recordAgentEvent({type: 'ui_request', step_id: 'turn-ask'});
  cloud.ctx.agentRun.turnID = 'different-turn'; cloud.ctx.renderLocalBoard();
  assert.equal(cloud.ids.agentAsk.classList.contains('hw-context-unowned'), true, 'approval is bound to its original turn');
  const folds = fixture();
  const cards = folds.find('hw-context-card').filter(e => !e.classList.contains('hw-plan-card'));
  assert.equal(cards[0].tagName, 'details'); assert.equal(cards[0].open, true);
  cards[1].open = false;
  folds.ctx.pendingAttach = [{name: 'a-very-long-reference.txt'}]; folds.ctx.renderAttachBar();
  assert.equal(cards[1].open, false, 'source refresh preserves user folding');
  assert.match(cards[1].firstChild.textContent, /参考资料 · 1/);
  cards[0].open = false; folds.ctx.resetAgentRun('fold-run'); folds.ctx.beginAssistant();
  folds.ctx.recordAgentEvent({type: 'ui_request', step_id: 'confirm-folded'});
  assert.equal(cards[0].open, true, 'live approval opens the task disclosure');
  const outputEvent = {agent_id: 'local', title: 'goal_update', detail: 'script arguments '.repeat(600), output: '{"objective":"' + 'long'.repeat(2000) + '"}'};
  folds.ctx.agentRun.events = [outputEvent]; folds.ctx.renderAgentTimeline('local');
  const trace = folds.find('hw-trace-disclosure')[0], args = folds.find('hw-output-disclosure')[0], output = folds.find('hw-output-disclosure')[1];
  assert.equal(args.open, false); assert.equal(args.children[1].textContent, outputEvent.detail); args.open = true;
  assert.equal(trace.open, false); assert.equal(output.open, false);
  assert.equal(output.children[1].textContent, outputEvent.output, 'full original JSON is retained');
  trace.open = true; output.open = true;
  folds.ctx.renderAgentTimeline('local');
  assert.equal(folds.find('hw-trace-disclosure')[0], trace); assert.equal(trace.open, true);
  assert.equal(folds.find('hw-output-disclosure')[1], output); assert.equal(output.open, true); assert.equal(args.open, true);
  assert.equal(output.children.length, 2, 'stream refresh does not duplicate output');
  const close = folds.ids.agentTimeline.firstChild.children[1]; close.onclick();
  assert.equal(folds.ids.agentTimeline.classList.contains('hide'), true, 'original close handler retained');
  folds.ctx.resetAgentRun('fresh-fold-run'); folds.ctx.renderAgentTimeline('local');
  assert.notEqual(folds.find('hw-trace-disclosure')[0], trace);
  assert.equal(folds.find('hw-output-disclosure')[0].open, false, 'new Run never borrows old disclosure state');
  const cap = fixture(), card = cap.find('hw-context-capacity')[0];
  assert.match(card.textContent, /未报告/); assert.doesNotMatch(card.textContent, /0.0 KiB/);
  cap.ctx.localBusy = true; cap.ctx.localRunID = 'cap-run'; cap.ctx.resetAgentRun('cap-run');
  const emit = extra => cap.ctx.recordAgentEvent({task_id: 'cap-run', ...extra});
  emit({type: 'model_capabilities', declared: {context_window: 1000000}});
  emit({type: 'context_status', status: 'ready', source: 'host_working_projection', unit: 'utf8_json_bytes_not_tokens', projection_json_bytes: 850, projection_limit_bytes: 1000, near_threshold: true});
  assert.match(card.textContent, /接近本地压缩阈值/); assert.match(card.textContent, /目录声明窗口 1,000,000 Tokens/);
  emit({type: 'model_call', phase: 'agent', context_observation: {unit: 'utf8_bytes_not_tokens', request_json_bytes: 950, request_limit_bytes: 1200}});
  assert.match(card.textContent, /最近完整请求/); assert.doesNotMatch(card.textContent, /85%/);
  emit({type: 'context_status', status: 'compressing', source: 'host_working_projection', unit: 'utf8_json_bytes_not_tokens', projection_json_bytes: 1100, projection_limit_bytes: 1000});
  assert.match(card.firstChild.textContent, /压缩中/);
  emit({type: 'compact', status: 'completed'}); assert.match(card.firstChild.textContent, /已压缩/);
  emit({type: 'context_status', status: 'ready', source: 'host_working_projection', unit: 'utf8_json_bytes_not_tokens', projection_json_bytes: 300, projection_limit_bytes: 1000, near_threshold: false});
  assert.match(card.textContent, /0.3 KiB/);
  emit({type: 'context_status', status: 'ready', source: 'host_working_projection', unit: 'utf8_json_bytes_not_tokens', projection_json_bytes: 850, projection_limit_bytes: 1000, near_threshold: true});
  assert.match(card.firstChild.textContent, /接近本地压缩阈值/, 'later near threshold is not hidden by a previous successful compression');
  const before = card.textContent;
  cap.ctx.recordAgentEvent({task_id: 'old-run', type: 'context_status', status: 'compressing'});
  assert.equal(card.textContent, before, 'old run cannot change context state');
  cap.ctx.finishLocalRun(); assert.match(card.textContent, /本次运行已结束/);
  emit({type: 'context_status', status: 'compressing'}); assert.doesNotMatch(card.firstChild.textContent, /压缩中/);
  await cap.ctx.selectSession({id: 'elsewhere'}); assert.match(card.firstChild.textContent, /未报告/);
  const oldHistory = cap.ctx.api('/workspaces/ws/sessions/elsewhere/messages');
  const oldCapacity = {task_id: 'cap-run', type: 'context_status', status: 'compressing'};
  cap.pending.at(-1).resolve([{role: 'assistant', events: [oldCapacity]}]); await oldHistory;
  cap.ctx.recordAgentEvent(oldCapacity); assert.match(card.firstChild.textContent, /未报告/, 'replayed telemetry never becomes current capacity');
  cap.ctx.localBusy = true; cap.ctx.localRunID = 'new-cap'; cap.ctx.resetAgentRun('new-cap');
  emit({task_id: 'new-cap', type: 'context_status', status: 'ready', source: 'host_working_projection', unit: 'utf8_json_bytes_not_tokens', projection_json_bytes: null, projection_limit_bytes: 1000});
  assert.match(card.textContent, /大小未报告/); assert.doesNotMatch(card.textContent, /0.0 KiB/);
  const goalCap = fixture(), goalCard = goalCap.find('hw-context-capacity')[0];
  const mirror = {goal: {id: 'g', run: 'slice1', status: 'running'}, lease: {goal_id: 'g', device: 'fp', session: 'ws/a', expires_at: Math.floor(Date.now() / 1000) + 3600}, mirrorEpoch: 'writer'};
  goalCap.ctx.curWS.device_fp = 'fp'; goalCap.ctx.window.HandwaveLinks = {state: () => mirror};
  const goalEmit = (run, bytes) => goalCap.ctx.recordAgentEvent({task_id: run, type: 'context_status', status: 'ready', source: 'host_working_projection', unit: 'utf8_json_bytes_not_tokens', projection_json_bytes: bytes, projection_limit_bytes: 1000});
  goalCap.ctx.onSig({k: 'goal-state'}); goalEmit('slice1', 200); assert.match(goalCard.textContent, /0.2 KiB/);
  goalCap.ctx.recordAgentEvent({task_id: 'slice1', type: 'agent_end', status: 'completed'});
  mirror.goal = {id: 'g', run: 'slice2', status: 'running'}; goalCap.ctx.onSig({k: 'goal-state'}); assert.match(goalCard.firstChild.textContent, /未报告/, 'new verified Goal slice clears previous measurements');
  goalEmit('slice1', 999); assert.match(goalCard.firstChild.textContent, /未报告/, 'old Goal slice is not current');
  goalEmit('slice2', 900); assert.match(goalCard.textContent, /0.9 KiB/, 'fresh mirror-owned Goal slice reports after the browser local run ended');
  goalCap.ctx.recordAgentEvent({task_id: 'slice1', type: 'agent_end', status: 'completed'}); assert.doesNotMatch(goalCard.textContent, /本次运行已结束/, 'old terminal cannot settle fresh slice capacity');
  mirror.goal.status = 'awaiting_review'; goalCap.ctx.onSig({k: 'goal-state'}); assert.match(goalCard.textContent, /本次运行已结束/);
  mirror.goal = {id: 'g', run: 'slice3', status: 'running'}; goalEmit('not-yet-mirrored', 800); assert.match(goalCard.textContent, /0.9 KiB/, 'unmatched pre-mirror telemetry is ignored');
  goalCap.ctx.onSig({k: 'goal-state'}); mirror.lease.device = 'wrong'; goalEmit('slice3', 800); assert.match(goalCard.firstChild.textContent, /未报告/, 'wrong device lease cannot authenticate capacity');
  mirror.lease.device = 'fp'; await goalCap.ctx.selectSession({id: 'b'}); goalEmit('slice3', 800); assert.match(goalCard.firstChild.textContent, /未报告/, 'previous Session mirror cannot authenticate new view');
  const interrupted = fixture({realFinish: true}); interrupted.ctx.resetAgentRun('cloud'); interrupted.ctx.beginAssistant();
  interrupted.ctx.agentRun.agents.set('coordinator', {status: 'running'}); interrupted.ctx.finishAgentRun('interrupted');
  assert.equal(interrupted.ctx.agentRun.agents.get('coordinator').status, 'interrupted');
  assert.equal(vm.runInContext('AGENT_STATUS.interrupted', interrupted.ctx), '结果待核对');
  assert.match(interrupted.root.textContent, /公开过程 · 结果待核对/); assert.doesNotMatch(interrupted.root.textContent, /公开过程 · 执行结束/);
  const lost = fixture({realFinish: true}); lost.ctx.curWS.device_fp = 'fp'; lost.ctx.localRunID = 'native'; lost.ctx.localBusy = true; lost.ctx.resetAgentRun('native'); lost.ctx.beginAssistant();
  lost.ctx.localTasks.set('step', {status: 'running'}); lost.ctx.recordAgentEvent({type: 'context_status',task_id: 'native',status: 'compressing',source: 'host_working_projection',unit: 'utf8_json_bytes_not_tokens',projection_json_bytes: 1100,projection_limit_bytes: 1000});
  const receipt = {owner: JSON.stringify(['ws','fp','a','ctl']), run: 'native'};
  lost.ctx.window.HandwaveContextInterrupted({...receipt, run: 'wrong'}); assert.match(lost.find('hw-context-capacity')[0].firstChild.textContent, /压缩中/);
  lost.ctx.localBusy = false; lost.ctx.window.HandwaveContextInterrupted(receipt);
  assert.match(lost.root.textContent, /公开过程 · 连接中断 · 结果待核对/); assert.match(lost.find('hw-context-capacity')[0].firstChild.textContent, /数据待核对/);
  assert.doesNotMatch(lost.find('hw-context-capacity')[0].textContent, /本次运行已结束/); assert.equal(lost.ctx.localTasks.get('step').status, 'running');
  assert(lost.ids.agentCtl.classList.contains('hw-context-unowned')); assert(lost.ids.agentTasks.classList.contains('hw-context-unowned')); assert.match(lost.ctx.liveDockMeta(), /结果待核对/);
  await lost.ctx.selectSession({id: 'b'}); lost.ctx.window.HandwaveContextInterrupted(receipt); assert.doesNotMatch(lost.find('hw-context-capacity')[0].textContent, /数据待核对/);
  const plan = fixture(), planning = plan.find('hw-plan-card')[0];
  assert.equal(plan.find('hw-context-body')[0].firstChild, planning, 'planning is the first rail card');
  assert.equal(planning.hidden, true, 'simple requests do not invent a checklist');
  plan.ctx.curWS.device_fp = 'pc'; plan.ctx.localBusy = true; plan.ctx.localRunID = 'plan1'; plan.ctx.resetAgentRun('plan1'); plan.ctx.beginAssistant();
  const progress = changes => plan.ctx.recordAgentEvent({type: 'task_update', task_id: 'plan1', step_id: 'inspect', output: 'Inspect logs', status: 'running', ...changes});
  progress(); assert.equal(planning.hidden, false); assert.match(planning.textContent, /进行中/);
  assert.doesNotMatch(plan.find('hw-public-process').at(-1).textContent, /任务更新/, 'live checklist updates do not duplicate the rail in chat');
  planning.open = false; progress({step_id: 'verify', output: 'Verify fix', status: 'pending'}); assert.equal(planning.open, false, 'progress preserves folding');
  progress({status: 'done'}); assert.match(planning.textContent, /完成待核对/); assert.match(planning.firstChild.textContent, /0\/2/);
  progress({status: 'done', evidence: 'log.txt:12 checked'}); assert.match(planning.firstChild.textContent, /1\/2/);
  plan.ctx.recordAgentEvent({type: 'agent_end', task_id: 'plan1', status: 'completed'});
  assert.match(planning.firstChild.textContent, /1\/2/); assert.match(planning.textContent, /待执行/, 'completed Run never checks unfinished steps');
  progress({step_id: 'verify', output: 'late completion', status: 'done', evidence: 'stale'}); assert.doesNotMatch(planning.textContent, /late completion/);
  plan.ctx.localRunID = 'plan2'; plan.ctx.resetAgentRun('plan2'); plan.ctx.beginAssistant();
  progress({status: 'done', evidence: 'old run'}); assert.equal(planning.hidden, true, 'old Run cannot populate next checklist');
  progress({task_id: 'plan2'}); assert.match(planning.textContent, /Inspect logs/);
  plan.ctx.curWS.device_fp = 'different'; progress({task_id: 'plan2', output: 'wrong device'}); assert.doesNotMatch(planning.textContent, /wrong device/);
  plan.ctx.curWS.device_fp = 'pc'; await plan.ctx.selectSession({id: 'b'}); await plan.ctx.selectSession({id: 'a'});
  progress({task_id: 'plan2', output: 'ABA old receipt'}); assert.equal(planning.hidden, true, 'session ABA does not restore old live checklist');
  plan.ctx.localRunID = 'plan3'; plan.ctx.resetAgentRun('plan3'); plan.ctx.beginAssistant();
  const xss = '<img src=x onerror=bad()>', tool = {type: 'tool_start', task_id: 'plan3', title: 'read_file', detail: xss, output: 'a'.repeat(17000)};
  plan.ctx.recordAgentEvent(tool); const liveProcess = plan.find('hw-public-process').at(-1), toolFields = walk(liveProcess).filter(e => e.classList.contains('hw-output-disclosure'));
  assert.equal(toolFields.length, 2); assert.equal(toolFields[0].open, false); assert.match(toolFields[0].textContent, /<img/);
  assert.equal(walk(liveProcess).some(e => e.tagName === 'img'), false); assert.match(toolFields[1].textContent, /界面已截断/);
  toolFields[0].open = true; plan.ctx.recordAgentEvent({type: 'tool_end',task_id:'plan3',title:'read_file',output:'receipt'});
  assert.equal(toolFields[0].open, true, 'new event does not reopen or rebuild existing output');
  plan.ctx.recordAgentEvent({type:'thinking',task_id:'plan3',output:'internal reasoning'}); assert.doesNotMatch(liveProcess.textContent,/internal reasoning/);
  const durable = fixture(), durableCard = durable.find('hw-plan-card')[0]; durable.ctx.curWS.device_fp = 'pc';
  const durableState = {goal: {id: 'goal', revision: 1, run: 's1', status: 'running', steps: [{name:'Find problem',status:'in_progress',evidence:''},{name:'Verify',status:'pending',evidence:''}]}, lease:{goal_id:'goal',device:'pc',session:'ws/a',expires_at:Math.floor(Date.now()/1000)+3600},mirrorEpoch:'writer'};
  durable.ctx.window.HandwaveLinks = {state:()=>durableState}; durable.ctx.onSig({k:'goal-state'}); assert.match(durableCard.firstChild.textContent,/目标规划 · 0\/2/);
  durableState.goal = {...durableState.goal,revision:2,run:'s2',steps:[{name:'Find problem',status:'done',evidence:'real file'},{name:'Verify',status:'in_progress',evidence:''}]}; durable.ctx.onSig({k:'goal-state'});
  assert.match(durableCard.firstChild.textContent,/1\/2/); assert.match(durableCard.textContent,/进行中/, 'durable Goal survives slice transition');
  durableState.goal = {...durableState.goal,revision:1,steps:[{name:'old revision',status:'done',evidence:'old'}]}; durable.ctx.onSig({k:'goal-state'}); assert.doesNotMatch(durableCard.textContent,/old revision/);
  durableState.goal = {...durableState.goal,revision:3,status:'paused',steps:[{name:'Verify',status:'done',evidence:''}]}; durable.ctx.onSig({k:'goal-state'}); assert.match(durableCard.textContent,/完成待核对/); assert.match(durableCard.textContent,/已暂停/);
  durableState.lease.device = 'other'; durableState.goal = {...durableState.goal,revision:4,steps:[{name:'wrong lease',status:'running',evidence:''}]}; durable.ctx.onSig({k:'goal-state'}); assert.doesNotMatch(durableCard.textContent,/wrong lease/);
  const foreground = fixture(); foreground.ctx.curWS.device_fp='pc'; foreground.ctx.localBusy=true; foreground.ctx.localRunID='fg'; foreground.ctx.resetAgentRun('fg');
  const fgGoal = {id:'fg-goal',revision:1,steps:[{name:'Foreground step',status:'in_progress',evidence:''}],status:'running'};
  foreground.ctx.window.HandwaveLinks = {state:()=>({goal:fgGoal,lease:null,mirrorEpoch:''})};
  foreground.ctx.recordAgentEvent({type:'goal_update',task_id:'fg',goal:{...fgGoal}}); assert.equal(foreground.find('hw-plan-card')[0].hidden,true,'unaccepted Goal object is ignored');
  foreground.ctx.recordAgentEvent({type:'goal_update',task_id:'fg',goal:fgGoal}); assert.match(foreground.find('hw-plan-card')[0].textContent,/Foreground step/,'foreground validated Links object works without background lease');
  foreground.ctx.finishLocalRun(); assert.doesNotMatch(foreground.find('hw-plan-card')[0].textContent,/进行中/); assert.match(foreground.find('hw-plan-card')[0].textContent,/未完成/);
  foreground.ctx.localRunID='new-execute'; foreground.ctx.localBusy=true; foreground.ctx.resetAgentRun('new-execute'); assert.equal(foreground.find('hw-plan-card')[0].hidden,true,'new Execute does not inherit a previous foreground Goal');
  const later = fixture(); later.ctx.curWS.device_fp='pc';
  const laterState = {goal:{id:'durable',revision:1,run:'slice1',status:'running',steps:[{name:'Background task',status:'in_progress',evidence:''}]},lease:{goal_id:'durable',device:'pc',session:'ws/a',expires_at:Math.floor(Date.now()/1000)+3600},mirrorEpoch:'writer'};
  later.ctx.window.HandwaveLinks={state:()=>laterState}; later.ctx.onSig({k:'goal-state'});
  later.ctx.recordAgentEvent({type:'tool_start',task_id:'slice1',title:'read_file',detail:'first slice args'});
  const firstSlice=later.find('hw-public-process').at(-1); assert.match(firstSlice.textContent,/first slice args/);
  laterState.goal={...laterState.goal,revision:2,run:'slice2'}; later.ctx.onSig({k:'goal-state'});
  later.ctx.recordAgentEvent({type:'tool_end',task_id:'slice2',title:'read_file',output:'second slice receipt'});
  const secondSlice=later.find('hw-public-process').at(-1); assert.notEqual(secondSlice,firstSlice); assert.match(secondSlice.textContent,/second slice receipt/);
  const frozen = firstSlice.textContent; later.ctx.recordAgentEvent({type:'agent_end',task_id:'slice1',status:'failed'}); assert.equal(firstSlice.textContent,frozen); assert.doesNotMatch(secondSlice.textContent,/失败/,'old slice cannot settle new chat process');
  const rosterButton=later.ids.agentRoster.appendChild(new Element('button')); later.ctx.renderAgentDock(); assert.equal(secondSlice.open,false); rosterButton.onclick(); assert.equal(secondSlice.open,true,'explicit roster click opens chat process');
  secondSlice.open=false; later.ctx.renderAgentDock(); assert.equal(secondSlice.open,false,'periodic render never opens details');
  laterState.lease.expires_at=Math.floor(Date.now()/1000)-1; laterState.goal={...laterState.goal,revision:3,status:'waiting_authorization'}; later.ctx.onSig({k:'goal-state'});
  const laterCard=later.find('hw-plan-card')[0]; assert.match(laterCard.textContent,/等待重新授权/); assert.doesNotMatch(laterCard.textContent,/进行中/); assert.equal(walk(laterCard).some(e=>e['aria-current']==='step'),false,'expired Goal loses active-step treatment');
  later.ctx.recordAgentEvent({type:'tool_end',task_id:'slice2',output:'expired untrusted detail'}); assert.doesNotMatch(secondSlice.textContent,/expired untrusted detail/,'expired lease is read-only status, not live tool authority');
  const css = fs.readFileSync(__dirname + '/handwave_context.css','utf8'); assert.match(css,/#contextRail \.hw-chat-trace #agentTimeline\{display:none!important\}/); assert.match(css,/#contextRail \.hw-has-plan #agentTasks/);
  const cloudTrace=fixture(); cloudTrace.ctx.resetAgentRun('cloud-visible'); cloudTrace.ctx.beginAssistant();
  const cloudRow=cloudTrace.ids.agentRoster.appendChild(new Element('button')); let nativeClicks=0;
  cloudRow.onclick=()=>{nativeClicks++;cloudTrace.ctx.renderAgentTimeline('cloud-agent');};
  cloudTrace.ctx.agentRun.events=[{agent_id:'cloud-agent',title:'read_file',detail:'cloud public args',output:'cloud public output'}];
  cloudTrace.ctx.renderAgentDock(); cloudRow.onclick(); assert.equal(nativeClicks,1,'cloud roster retains native behavior');
  assert.match(cloudTrace.ids.agentTimeline.textContent,/cloud public args/); assert.match(cloudTrace.ids.agentTimeline.textContent,/cloud public output/);
  assert.equal(cloudTrace.ids.agentDock.parentNode.classList.contains('hw-chat-trace'),false,'cloud keeps native detail visible');
  cloudTrace.ctx.localRunID='local-visible';cloudTrace.ctx.localBusy=true;cloudTrace.ctx.resetAgentRun('local-visible');cloudTrace.ctx.beginAssistant();cloudTrace.ctx.renderAgentDock();
  assert.equal(cloudTrace.ids.agentDock.parentNode.classList.contains('hw-chat-trace'),true,'native local trace is migrated');
  cloudTrace.ctx.localBusy=false;cloudTrace.ctx.resetAgentRun('cloud-next');cloudTrace.ctx.beginAssistant();cloudTrace.ctx.renderAgentDock();cloudRow.onclick();
  assert.equal(nativeClicks,2,'returning to cloud restores original roster handler');assert.equal(cloudTrace.ids.agentDock.parentNode.classList.contains('hw-chat-trace'),false);
  plan.media.matches=false; plan.media.listener(); assert.equal(plan.find('hw-context-rail')[0].open,false); assert.match(plan.find('hw-context-summary')[0].textContent,/任务与参考资料/);
  console.log('PASS: 36 context presentation contracts (controlled VM/DOM; no live browser acceptance).');

})().catch(error => { console.error(error); process.exitCode = 1; });
