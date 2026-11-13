/* HandWave presentation: sourced references, session-scoped task view and public traces. */
(() => {
  'use strict';
  const root = document.documentElement;
  const main = document.querySelector('.chat-main');
  if (!main || root.dataset.hwContextReady === '1') return;
  root.dataset.hwContextReady = '1';
  const node = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const identity = () => JSON.stringify([curWS && curWS.id || '', curSess && curSess.id || '']);
  const clean = value => typeof value === 'string' ? value.slice(0, 240) : '';
  let epoch = 0, runOwner = '', localTaskOwner = '', process = null;
  let sourceCount = 0, taskCaption = '', runTerminal = '';
  let runSequence = 0, askReceipt = null;
  let attachments = [], kb = {global: null, project: null};
  let status = {messages: '未加载', global: '未加载', project: '先选工作区'};
  const serial = {messages: 0, global: 0, project: 0};
  const history = new WeakMap();
  const rail = node('details', 'hw-context-rail');
  rail.id = 'contextRail';
  const railSummary = node('summary', 'hw-context-summary', '任务与参考资料');
  rail.appendChild(railSummary);
  const railBody = node('div', 'hw-context-body');
  rail.appendChild(railBody);
  main.classList.add('hw-context-host');
  const topbar = main.querySelector('.topbar');
  main.insertBefore(rail, topbar ? topbar.nextSibling : main.firstChild);
  function card(title, open = true) {
    const e = node('details', 'hw-context-card');
    e.open = open;
    e.appendChild(node('summary', 'hw-context-heading hw-card-summary', title));
    railBody.appendChild(e);
    return e;
  }
  const planCard = card('任务规划');
  planCard.classList.add('hw-plan-card');
  planCard.hidden = true;
  const planList = node('ol', 'hw-plan-list');
  const planNote = node('p', 'hw-context-hint hw-plan-note');
  planCard.appendChild(planList); planCard.appendChild(planNote);
  let executeSteps = new Map(), localReceipt = null, goalPlan = null;
  const rosterHandlers = new WeakMap();
  const device = () => curWS && curWS.device_fp || '';
  function localEventOwned(event) {
    return !!localReceipt && localReceipt.owner === identity() && localReceipt.device === device() && localReceipt.epoch === epoch && localReceipt.sequence === runSequence &&
      runOwner === identity() && localTaskOwner === identity() && !runTerminal && typeof localBusy !== 'undefined' && localBusy &&
      typeof localRunID === 'string' && !!localRunID && localReceipt.run === localRunID && agentRun.turnID === localRunID && event.task_id === localRunID;
  }
  function planStep(value, goal) {
    if (!value || typeof value !== 'object') return null;
    const title = goal ? value.name : value.title, id = goal ? '' : value.id;
    const state = value.status === 'in_progress' ? 'running' : value.status;
    if (typeof title !== 'string' || !title.trim() || title.length > (goal ? 256 : 240) || !['pending', 'running', 'done', 'blocked'].includes(state) || !goal && (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id))) return null;
    const evidence = typeof value.evidence === 'string' ? value.evidence.slice(0, 2048).trim() : '';
    return {id, title, status: state === 'done' && !evidence ? 'unverified' : state, evidence};
  }
  function renderPlan() {
    const ownedGoal = goalPlan && goalPlan.owner === identity() && goalPlan.device === device() && goalPlan.epoch === epoch;
    const ownedExecute = localReceipt && localReceipt.owner === identity() && localReceipt.device === device() && localReceipt.epoch === epoch && localReceipt.sequence === runSequence;
    const steps = ownedGoal ? goalPlan.steps : ownedExecute ? Array.from(executeSteps.values()) : [];
    const active = ownedGoal ? goalPlan.status === 'running' && (goalPlan.expires ? goalPlan.expires > Math.floor(Date.now() / 1000) : localReceipt && localEventOwned({task_id: localReceipt.run})) : ownedExecute && !runTerminal && typeof localBusy !== 'undefined' && localBusy;
    planCard.hidden = !steps.length;
    planList.replaceChildren();
    const done = steps.filter(s => s.status === 'done').length;
    planCard.firstChild.textContent = (ownedGoal ? '目标规划' : '任务规划') + ' · ' + done + '/' + steps.length;
    const labels = {pending: '待执行', running: '进行中', done: '已完成', blocked: '受阻', unverified: '完成待核对', unfinished: '未完成', uncertain: '结果待核对'};
    for (const step of steps) {
      const displayState = step.status === 'running' && !active ? /待核对|中断/.test(runTerminal) ? 'uncertain' : 'unfinished' : step.status;
      const row = node('li', 'hw-plan-step hw-plan-' + displayState);
      const mark = node('span', 'hw-plan-mark', step.status === 'done' ? '✓' : step.status === 'blocked' ? '!' : '○'); mark.setAttribute('aria-hidden', 'true');
      row.appendChild(mark); row.appendChild(node('span', 'hw-plan-title', step.title));
      row.appendChild(node('span', 'hw-plan-state', labels[displayState]));
      row.title = step.evidence || labels[displayState];
      if (displayState === 'running') row.setAttribute('aria-current', 'step');
      planList.appendChild(row);
    }
    const state = ownedGoal ? goalPlan.status : runTerminal;
    const states = {running: active ? '按执行收据更新' : '等待状态同步，未完成步骤保留', paused: '已暂停，未完成步骤保留', waiting_authorization: '等待重新授权，未完成步骤保留', awaiting_review: '等待你验收', failed: '执行失败，未完成步骤保留', canceled: '已停止，未完成步骤保留', accepted: '目标已确认完成'};
    planNote.textContent = states[state] || (state ? state + ' · 步骤状态以收据为准' : '按执行收据更新');
  }
  function syncPlanGoal(event) {
    const snapshot = window.HandwaveLinks && window.HandwaveLinks.state(), g = snapshot && snapshot.goal;
    if (!g || typeof g.id !== 'string' || !g.id || !Number.isSafeInteger(g.revision) || g.revision < 1 || !Array.isArray(g.steps) || g.steps.length > 8) return;
    // A mirrored status may arrive after its execution lease expired. Display
    // ownership is separate from permission to accept live tool receipts.
    const lease = snapshot.lease;
    const observed = lease && lease.device === device() && curWS && curSess && lease.session === curWS.id + '/' + curSess.id && lease.goal_id === g.id &&
      Number.isSafeInteger(lease.expires_at) && typeof snapshot.mirrorEpoch === 'string' && !!snapshot.mirrorEpoch;
    const foreground = event && event.type === 'goal_update' && localEventOwned(event) && event.goal === g;
    const retained = goalPlan && !goalPlan.writer && goalPlan.owner === identity() && goalPlan.device === device() && goalPlan.epoch === epoch && goalPlan.object === g;
    if (!observed && !foreground && !retained) return;
    const writer = observed ? snapshot.mirrorEpoch : '';
    if (goalPlan && goalPlan.owner === identity() && goalPlan.device === device() && goalPlan.id === g.id && goalPlan.writer === writer && g.revision <= goalPlan.revision) return;
    const steps = g.steps.map(s => planStep(s, true));
    if (steps.some(s => !s)) return;
    goalPlan = {owner: identity(), device: device(), epoch, id: g.id, revision: g.revision, writer, expires: observed ? lease.expires_at : 0, object: g, status: g.status, steps};
    renderPlan();
  }
  function planEvent(event) {
    syncPlanGoal(event);
    if (event.type !== 'task_update' || !localEventOwned(event)) return;
    const step = planStep({id: event.step_id, title: event.output, status: event.status, evidence: event.evidence}, false);
    if (!step || !executeSteps.has(step.id) && executeSteps.size >= 12) return;
    executeSteps.set(step.id, step); goalPlan = null; renderPlan();
  }
  const taskCard = card('当前任务');
  const taskEmpty = node('p', 'hw-context-hint', '暂无可展示的任务事件');
  taskCard.appendChild(taskEmpty);
  const dock = document.getElementById('agentDock');
  if (dock) taskCard.appendChild(dock);
  const sourceCard = card('参考资料');
  const refresh = node('button', 'hw-context-refresh', '刷新资料');
  refresh.type = 'button';
  refresh.title = '重新读取当前会话附件与知识库目录';
  sourceCard.appendChild(refresh);
  const sources = node('div', 'hw-context-sources');
  sourceCard.appendChild(sources);
  sourceCard.appendChild(node('p', 'hw-context-hint hw-context-source-note', '附件与可用知识库目录；实际引用以回答为准。'));
  const capacityCard = card('上下文 · 未报告');
  capacityCard.classList.add('hw-context-capacity');
  const capacityState = node('p', 'hw-context-capacity-state', '等待本机 Agent 报告'); capacityState.setAttribute('role', 'status'); capacityCard.appendChild(capacityState);
  const capacitySize = node('p', 'hw-context-capacity-size'); capacityCard.appendChild(capacitySize);
  const capacityRequest = node('p', 'hw-context-hint'); capacityCard.appendChild(capacityRequest);
  const capacityDeclaration = node('p', 'hw-context-hint'); capacityCard.appendChild(capacityDeclaration);
  capacityCard.appendChild(node('p', 'hw-context-hint', '工作视图按本地 UTF-8 JSON 字节预算显示，非模型 Token 占用。原始历史保留。'));
  let capacity = null, capacityRun = '', capacityGoalKey = '';
  function goalCapacityOwner() {
    const snapshot = window.HandwaveLinks && window.HandwaveLinks.state(), g = snapshot && snapshot.goal, l = snapshot && snapshot.lease;
    if (!curWS || !curSess || !g || !l || l.device !== curWS.device_fp || l.session !== curWS.id + '/' + curSess.id || l.goal_id !== g.id || !Number.isSafeInteger(l.expires_at) || l.expires_at <= Math.floor(Date.now() / 1000) || typeof snapshot.mirrorEpoch !== 'string' || !snapshot.mirrorEpoch || typeof g.run !== 'string' || !g.run) return null;
    return {goal: g, key: JSON.stringify([identity(), curWS.device_fp, g.id, g.run, snapshot.mirrorEpoch])};
  }
  function syncCapacityGoal() {
    const observed = goalCapacityOwner();
    if (!observed) return;
    if (observed.key !== capacityGoalKey) { capacity = null; capacityRun = observed.goal.run; capacityGoalKey = observed.key; }
    if (capacity && observed.goal.status !== 'running') { capacity.settled = true; capacity.compressing = false; }
    renderCapacity();
  }
  function renderCapacity() {
    if (!capacity) { capacityCard.firstChild.textContent = '上下文 · 未报告'; capacityState.textContent = '等待本机 Agent 报告'; capacitySize.textContent = capacityRequest.textContent = capacityDeclaration.textContent = ''; return; }
    const valid = n => Number.isSafeInteger(n) && n >= 0;
    const bytes = n => (n / 1024).toFixed(1) + ' KiB';
    const measured = valid(capacity.projection_json_bytes) && valid(capacity.projection_limit_bytes) && capacity.projection_limit_bytes > 0;
    const label = capacity.interrupted ? '连接中断 · 数据待核对' : capacity.compressing ? '压缩中' : measured && capacity.near_threshold === true ? '接近本地压缩阈值' : capacity.completed ? '已压缩' : measured ? '工作视图就绪' : '等待工作视图';
    capacityCard.firstChild.textContent = '上下文 · ' + label;
    capacityState.textContent = label + (capacity.settled ? ' · 本次运行已结束' : '');
    capacitySize.textContent = measured ? '工作视图 ' + bytes(capacity.projection_json_bytes) + ' / ' + bytes(capacity.projection_limit_bytes) : '工作视图大小未报告';
    capacityRequest.textContent = valid(capacity.request_json_bytes) && valid(capacity.request_limit_bytes) && capacity.request_limit_bytes > 0 ? '最近完整请求 ' + bytes(capacity.request_json_bytes) + ' / ' + bytes(capacity.request_limit_bytes) : '';
    capacityDeclaration.textContent = valid(capacity.context_window) && capacity.context_window > 0 ? '目录声明窗口 ' + capacity.context_window.toLocaleString() + ' Tokens（容量，非占用）' : '模型窗口未声明';
  }
  function capacityEvent(event) {
    const observed = goalCapacityOwner();
    const goalOwned = observed && observed.goal.status === 'running' && event.task_id === observed.goal.run;
    const localOwned = runOwner === identity() && !runTerminal && typeof localRunID !== 'undefined' && localBusy && localRunID && event.task_id === localRunID && agentRun.turnID === localRunID;
    if (!goalOwned && !localOwned || observed && capacityGoalKey === observed.key && event.task_id !== observed.goal.run) return;
    if (goalOwned && capacityGoalKey !== observed.key) { capacity = null; capacityRun = observed.goal.run; capacityGoalKey = observed.key; }
    else if (!goalOwned) capacityRun = event.task_id;
    const types = ['context_status', 'model_call', 'model_capabilities', 'compact'];
    if (!types.includes(event.type)) return;
    capacity ||= {};
    if (event.type === 'model_capabilities') capacity.context_window = event.declared && event.declared.context_window;
    if (event.type === 'model_call' && event.phase === 'agent') {
      const observation = event.context_observation;
      if (observation && observation.unit === 'utf8_bytes_not_tokens') {
        capacity.request_json_bytes = observation.request_json_bytes; capacity.request_limit_bytes = observation.request_limit_bytes;
      }
    }
    if (event.type === 'context_status' && event.unit === 'utf8_json_bytes_not_tokens' && event.source === 'host_working_projection') {
      capacity.projection_json_bytes = event.projection_json_bytes; capacity.projection_limit_bytes = event.projection_limit_bytes; capacity.near_threshold = event.near_threshold;
      capacity.compressing = event.status === 'compressing';
    }
    if (event.type === 'compact' && event.status === 'completed') { capacity.compressing = false; capacity.completed = true; }
    renderCapacity();
  }
  let mobileOpen = false;
  const wide = window.matchMedia('(min-width: 1180px)');
  function layout() { rail.open = wide.matches || mobileOpen; }
  rail.addEventListener('toggle', () => { if (!wide.matches) mobileOpen = rail.open; else if (!rail.open) rail.open = true; });
  if (wide.addEventListener) wide.addEventListener('change', layout);
  else if (wide.addListener) wide.addListener(layout);
  layout();

  function updateRailSummary() {
    railSummary.textContent = '任务与参考资料' + (taskCaption ? ' · ' + taskCaption : '') + (sourceCount ? ' · ' + sourceCount + ' 份资料' : '');
  }

  function renderSources() {
    sources.replaceChildren();
    const entries = [];
    const seen = new Set();
    function add(a, source) {
      if (!a || typeof a !== 'object') return;
      const name = clean(a.name);
      if (!name) return;
      const key = JSON.stringify([source, name, typeof a.size === 'number' ? a.size : '']);
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({name, source});
    }
    (Array.isArray(pendingAttach) ? pendingAttach : []).forEach(a => add(a, '待发送'));
    attachments.forEach(a => add(a, '会话附件'));
    ['project', 'global'].forEach(scope => {
      const toggle = document.getElementById(scope === 'project' ? 'kbProject' : 'kbGlobal');
      const label = (scope === 'project' ? '项目知识库' : '全局知识库') + (toggle && toggle.checked ? ' · 已启用' : ' · 未启用');
      if (Array.isArray(kb[scope])) kb[scope].forEach(a => add(a, label));
    });
    entries.slice(0, 100).forEach(({name, source}) => {
      const row = node('div', 'hw-context-source');
      row.appendChild(node('span', 'hw-context-file-icon', '▤'));
      row.firstChild.setAttribute('aria-hidden', 'true');
      const copy = node('div', 'hw-context-source-copy');
      const label = node('b', '', name);
      label.title = name;
      copy.appendChild(label);
      copy.appendChild(node('small', '', source));
      row.appendChild(copy);
      sources.appendChild(row);
    });
    if (entries.length > 100) sources.appendChild(node('p', 'hw-context-hint', '另有 ' + (entries.length - 100) + ' 项，可在工具与连接中查看。'));
    if (!entries.length) sources.appendChild(node('p', 'hw-context-hint', '暂无参考资料'));
    [['messages', '会话附件'], ['project', '项目知识库'], ['global', '全局知识库']].forEach(([key, label]) => {
      const value = status[key];
      if (value && value !== '已加载') sources.appendChild(node('p', 'hw-context-load-state', label + ' · ' + value));
    });
    sourceCount = entries.length;
    sourceCard.firstChild.textContent = '参考资料 · ' + sourceCount;
    updateRailSummary();
  }
  function syncTasks() {
    renderPlan();
    const migrated = runOwner === identity() && (localReceipt && localReceipt.owner === identity() && localReceipt.device === device() && localReceipt.epoch === epoch && localReceipt.sequence === runSequence || process && process.chatTrace);
    taskCard.classList.toggle('hw-chat-trace', !!migrated);
    taskCard.classList.toggle('hw-has-plan', !planCard.hidden);
    const roster = document.getElementById('agentRoster');
    if (roster) Array.from(roster.children).forEach(row => {
      if (!migrated) {
        const original = rosterHandlers.get(row);
        if (original) { row.onclick = original.onclick; row.disabled = original.disabled; row.title = original.title; rosterHandlers.delete(row); }
        return;
      }
      if (!rosterHandlers.has(row)) rosterHandlers.set(row, {onclick: row.onclick, disabled: row.disabled, title: row.title});
      row.title = process ? '在聊天中查看执行过程' : '当前会话暂无可展示的执行过程';
      row.disabled = !process;
      row.onclick = () => {
        if (runOwner !== identity() || !process) return;
        process.details.open = true;
        if (process.details.scrollIntoView) process.details.scrollIntoView({block: 'nearest', behavior: 'auto'});
      };
    });
    const owned = runOwner === identity() && !!runOwner;
    const localOwned = owned && localTaskOwner === identity();
    const activeLocal = localOwned && typeof localBusy !== 'undefined' && localBusy;
    const agents = owned && typeof agentRun !== 'undefined' && agentRun.agents ? Array.from(agentRun.agents.values()) : [];
    const ended = owned && !!runTerminal;
    const unsettled = agents.some(a => a.status === 'running' || a.status === 'queued');
    // Native selection clears agentRun for replay, but it does not stop a local
    // Run. Returning to its session must retain the existing stop/confirm controls.
    if (dock && activeLocal) dock.classList.remove('hide');
    const visible = owned && dock && !dock.classList.contains('hide');
    if (dock && !owned) dock.classList.add('hide');
    taskEmpty.textContent = /待核对/.test(runTerminal) ? '连接中断，步骤状态待核对；不会自动重发' : ended ? '执行已结束，步骤状态以收据为准' : (activeLocal && !agents.length ? '本机任务仍在运行，等待新事件' : '暂无可展示的任务事件');
    taskEmpty.hidden = !!visible && !(activeLocal && !agents.length) && !ended;
    ['agentRoster', 'agentDockProgress'].forEach(id => {
      const e = document.getElementById(id);
      if (e) e.classList.toggle('hw-context-unowned', (activeLocal && !agents.length) || (ended && unsettled));
    });
    const currentTurn = typeof agentRun !== 'undefined' ? agentRun.turnID || '' : '';
    const waiting = owned && !ended && askReceipt && askReceipt.owner === identity() && askReceipt.run === runSequence &&
      (!askReceipt.turn || askReceipt.turn === 'pending' || askReceipt.turn === currentTurn) &&
      typeof pendingAsk !== 'undefined' && pendingAsk && pendingAsk.id && pendingAsk.id === askReceipt.id;
    const active = agents.filter(a => a.status === 'running' || a.status === 'queued').length;
    taskCaption = ended ? runTerminal : (waiting ? '等待确认' : (active ? active + ' 项进行中' : (activeLocal ? '本机任务进行中' : '')));
    taskCard.firstChild.textContent = (ended ? '最近任务' : '当前任务') + (taskCaption ? ' · ' + taskCaption : '');
    updateRailSummary();
    const ask = document.getElementById('agentAsk');
    if (ask) ask.classList.toggle('hw-context-unowned', !waiting);
    ['agentCtl', 'agentQueuePanel'].forEach(id => {
      const e = document.getElementById(id);
      if (e) e.classList.toggle('hw-context-unowned', !localOwned);
    });
    ['agentTasks', 'agentBashLine'].forEach(id => {
      const e = document.getElementById(id);
      const unsettledTasks = id === 'agentTasks' && ended && typeof localTasks !== 'undefined' && Array.from(localTasks.values()).some(t => !['done', 'completed', 'failed', 'canceled'].includes(t.status));
      if (e) e.classList.toggle('hw-context-unowned', !localOwned || (ended && id !== 'agentTasks') || unsettledTasks);
    });
  }
  function resetView() {
    epoch++;
    attachments = [];
    kb = {global: null, project: null};
    status = {messages: '未加载', global: '未加载', project: '未加载'};
    process = null;
    executeSteps.clear(); localReceipt = null; goalPlan = null; renderPlan();
    capacity = null; capacityRun = ''; capacityGoalKey = ''; renderCapacity();
    renderSources();
    // Selection functions assign curWS/curSess synchronously before their first await.
    if (dock) dock.classList.add('hide');
    taskEmpty.hidden = false;
    taskCaption = '';
    updateRailSummary();
  }
  const originalAPI = api;
  api = async function(path, opts) {
    const owner = identity(), generation = epoch;
    const isGET = !opts || !opts.method || String(opts.method).toUpperCase() === 'GET';
    let url;
    try { url = new URL(path, 'https://handwave.invalid'); } catch (_) {}
    const messagePath = curWS && curSess ? '/workspaces/' + curWS.id + '/sessions/' + curSess.id + '/messages' : '';
    const isMessages = isGET && url && url.pathname === messagePath;
    const scope = isGET && url && url.pathname === '/kb' ? url.searchParams.get('scope') : '';
    const isKB = scope === 'global' || (scope === 'project' && String(url.searchParams.get('ws') || '') === String(curWS && curWS.id || ''));
    const key = isMessages ? 'messages' : (isKB ? scope : '');
    const requestSeq = key ? ++serial[key] : 0;
    if (key) { status[key] = '加载中'; renderSources(); }
    try {
      const result = await originalAPI.apply(this, arguments);
      // Every history event is tagged, even if its receipt is late, so it cannot
      // subsequently be mistaken for a live task by the legacy history renderer.
      if (isMessages && Array.isArray(result)) result.forEach(message => {
        const group = {owner, generation, requestSeq, view: null};
        if (Array.isArray(message.events)) message.events.forEach(event => { if (event && typeof event === 'object') history.set(event, group); });
      });
      if (owner !== identity() || generation !== epoch || (key && requestSeq !== serial[key])) return result;
      if (isMessages) {
        attachments = Array.isArray(result) ? result.filter(m => m && m.role === 'user').flatMap(m => Array.isArray(m.attachments) ? m.attachments : []) : [];
        status.messages = Array.isArray(result) ? '已加载' : '返回格式异常';
      }
      if (isKB) {
        kb[scope] = Array.isArray(result) ? result : null;
        status[scope] = Array.isArray(result) ? '已加载' : '返回格式异常';
      }
      if (key) renderSources();
      return result;
    } catch (error) {
      if (key && owner === identity() && generation === epoch && requestSeq === serial[key]) { status[key] = '暂不可用'; renderSources(); }
      throw error;
    }
  };
  async function refreshSources() {
    refresh.disabled = true;
    const requests = [api('/kb?scope=global')];
    if (curWS) requests.push(api('/kb?scope=project&ws=' + encodeURIComponent(curWS.id)));
    if (curWS && curSess) requests.push(api('/workspaces/' + curWS.id + '/sessions/' + curSess.id + '/messages'));
    await Promise.allSettled(requests);
    refresh.disabled = false;
  }
  refresh.addEventListener('click', refreshSources);
  const oldSelectSession = selectSession;
  selectSession = function() {
    resetView();
    const result = oldSelectSession.apply(this, arguments);
    syncTasks();
    // Native session selection only reads messages; load both directory receipts once.
    const requests = [api('/kb?scope=global')];
    if (curWS) requests.push(api('/kb?scope=project&ws=' + encodeURIComponent(curWS.id)));
    Promise.allSettled(requests);
    return result;
  };
  const oldSelectWorkspace = selectWorkspace;
  selectWorkspace = function() { resetView(); const result = oldSelectWorkspace.apply(this, arguments); syncTasks(); return result; };
  const oldAttachBar = renderAttachBar;
  renderAttachBar = function() { const result = oldAttachBar.apply(this, arguments); renderSources(); return result; };
  ['kbGlobal', 'kbProject'].forEach(id => { const e = document.getElementById(id); if (e) e.addEventListener('change', renderSources); });
  const oldDock = renderAgentDock;
  renderAgentDock = function() { const result = oldDock.apply(this, arguments); syncTasks(); return result; };
  const oldBoard = renderLocalBoard;
  renderLocalBoard = function() { const result = oldBoard.apply(this, arguments); syncTasks(); return result; };
  const publicLabels = {
    model_request: '请求模型', model_response: '模型响应', model_result: '模型用量回执', agent_start: '开始委派', agent_finish: '委派结束',
    task_start: '接收任务', task_finish: '任务结束', step_start: '开始步骤', step_output: '步骤输出', step_finish: '步骤结束',
    tool_start: '调用工具', tool_end: '工具返回', tool_finish: '工具返回', task_update: '任务更新', goal_update: '目标更新', steer: '调整任务',
    compact: '压缩上下文', retry: '重试模型', bash_start: '开始命令', bash_end: '命令结束', ui_request: '等待确认', agent_end: '执行结束'
  };
  function createProcess(historical) {
    const view = {count: 0, historical, run: '', details: node('details', 'hw-public-process'), summary: node('summary', 'hw-public-process-summary'), list: node('ol', 'hw-public-process-list')};
    view.details.appendChild(view.summary);
    view.details.appendChild(node('p', 'hw-context-hint', '公开工具调用与执行收据，不包含内部思考。'));
    view.details.appendChild(view.list);
    view.summary.textContent = historical ? '历史过程' : '公开过程 · 准备中';
    const messages = document.getElementById('messages');
    if (messages && historical) messages.appendChild(view.details);
    return view;
  }
  function appendEvent(view, event, detailed = false) {
    // Live planning belongs to the rail; chat keeps the execution receipts.
    if (!view.historical && ['task_update', 'goal_update'].includes(event.type)) return;
    const label = publicLabels[event.type];
    if (!label) return;
    view.count++;
    if (view.count <= 120) {
      const row = node('li', '', label + (clean(event.title) ? ' · ' + clean(event.title) : ''));
      // Only public tool/process receipts belong here; model reasoning and
      // arbitrary event fields never become visible details.
      if (detailed && ['tool_start', 'tool_end', 'tool_finish', 'step_output', 'step_finish', 'bash_start', 'bash_end'].includes(event.type)) {
        for (const [field, title] of [['detail', '参数与详情'], ['output', '输出']]) {
          if (typeof event[field] !== 'string' || !event[field]) continue;
          const text = event[field].slice(0, 16384);
          const disclosure = node('details', 'hw-output-disclosure');
          disclosure.appendChild(node('summary', 'hw-card-summary', title + ' · ' + event[field].length + ' 字符'));
          disclosure.appendChild(node('pre', '', text + (text.length < event[field].length ? '\n…界面已截断' : ''))); row.appendChild(disclosure);
        }
      }
      view.list.appendChild(row);
    }
    view.summary.textContent = (view.historical ? '历史过程' : '公开过程') + ' · ' + label + ' · ' + view.count + ' 项';
    if (view.count === 121) view.list.appendChild(node('li', 'hw-context-hint', '更多事件可在任务调用过程中查看。'));
  }
  // The native renderer rebuilds its timeline every second. Reuse disclosures
  // so new events cannot reopen output the user has deliberately folded.
  let timelineView = null;
  let outputViews = new WeakMap();
  if (typeof renderAgentTimeline === 'function') {
    const oldTimeline = renderAgentTimeline;
    renderAgentTimeline = function(agentID) {
      const focused = document.activeElement;
      const result = oldTimeline.apply(this, arguments);
      const box = document.getElementById('agentTimeline');
      if (!box) return result;
      const key = JSON.stringify([identity(), epoch, runSequence, agentID || '']);
      if (!timelineView || timelineView.key !== key) {
        outputViews = new WeakMap();
        timelineView = {key, details: node('details', 'hw-trace-disclosure'), summary: node('summary', 'hw-card-summary'), body: node('div')};
        timelineView.details.appendChild(timelineView.summary);
        timelineView.details.appendChild(timelineView.body);
      }
      const rows = Array.from(box.children).filter(e => e.classList.contains('agent-event'));
      const events = agentRun.events.filter(e => !agentID || agentIdentity(e) === agentID);
      rows.forEach((row, i) => {
        const event = events[i];
        if (!event) return;
        for (const [selector, label] of [['small', '参数与详情'], ['pre', '输出']]) {
          const content = row.querySelector(selector);
          if (!content || selector === 'small' && (content.textContent || '').length <= 160) continue;
          let fields = outputViews.get(event);
          if (!fields) { fields = {}; outputViews.set(event, fields); }
          let disclosure = fields[selector];
          if (!disclosure) {
            disclosure = node('details', 'hw-output-disclosure');
            disclosure.appendChild(node('summary', 'hw-card-summary'));
            fields[selector] = disclosure;
          }
          disclosure.firstChild.textContent = label + ' · ' + (content.textContent || '').length + ' 字符';
          content.parentNode.appendChild(disclosure);
          disclosure.appendChild(content);
          // Replace only the native renderer's content, retaining the open state.
          Array.from(disclosure.children).slice(1, -1).forEach(e => e.remove());
        }
      });
      timelineView.summary.textContent = '调用过程 · ' + rows.length + ' 项';
      timelineView.body.replaceChildren(...rows);
      const head = box.querySelector('.agent-timeline-head');
      if (head) { const title = head.querySelector('b'); if (title) title.hidden = true; }
      box.appendChild(timelineView.details);
      if (focused && box.contains && box.contains(focused) && document.activeElement !== focused) focused.focus({preventScroll: true});
      return result;
    };
  }
  const oldReset = resetAgentRun;
  resetAgentRun = function(turnID) {
    runOwner = identity();
    capacity = null; capacityRun = ''; capacityGoalKey = ''; renderCapacity();
    runTerminal = '';
    runSequence++;
    executeSteps.clear();
    const snapshot = window.HandwaveLinks && window.HandwaveLinks.state();
    if (!snapshot || !snapshot.goal || snapshot.goal.run !== turnID) goalPlan = null;
    askReceipt = null;
    if (typeof localRunID !== 'undefined' && localBusy && turnID === localRunID) localTaskOwner = runOwner;
    else localTaskOwner = '';
    localReceipt = localTaskOwner ? {owner: runOwner, device: device(), epoch, sequence: runSequence, run: turnID} : null;
    const result = oldReset.apply(this, arguments);
    process = createProcess(false);
    process.run = turnID;
    process.chatTrace = !!localReceipt;
    return result;
  };
  const oldBeginAssistant = beginAssistant;
  beginAssistant = function() {
    const stream = oldBeginAssistant.apply(this, arguments);
    // A run is prepared before its user bubble in the legacy send path. Mount
    // only when the assistant row exists, so the disclosure follows the question.
    if (runOwner === identity() && process && !process.details.parentNode && stream && stream.row && stream.row.parentNode) {
      stream.row.parentNode.insertBefore(process.details, stream.row);
    }
    return stream;
  };
  const oldRecord = recordAgentEvent;
  recordAgentEvent = function(event) {
    if (!event || typeof event !== 'object') return oldRecord.apply(this, arguments);
    const saved = history.get(event);
    if (saved) {
      if (saved.owner === identity() && saved.generation === epoch && saved.requestSeq === serial.messages && publicLabels[event.type]) {
        if (!saved.view) saved.view = createProcess(true);
        appendEvent(saved.view, event);
      }
      return; // Historical trace playback is never an active task/control receipt.
    }
    const observedGoal = goalCapacityOwner();
    if (observedGoal && typeof event.task_id === 'string' && event.task_id !== observedGoal.goal.run && !localEventOwned(event)) return;
    const goalOwned = observedGoal && observedGoal.goal.status === 'running' && event.task_id === observedGoal.goal.run;
    if (goalOwned && (!process || process.run !== event.task_id)) {
      process = createProcess(false); process.run = event.task_id; process.chatTrace = true;
      const messages = document.getElementById('messages'); if (messages) messages.appendChild(process.details);
      runOwner = identity(); runTerminal = '';
    }
    const target = process, owner = runOwner, sequence = runSequence;
    // Legacy onFrame may still forward stale frames; a checklist is never
    // authority merely because recordAgentEvent happened to receive it.
    if (event.type === 'task_update' && !localEventOwned(event)) return;
    if (!goalOwned && localReceipt && localReceipt.owner === identity() && localReceipt.device === device() && localReceipt.epoch === epoch && typeof event.task_id === 'string' && event.task_id !== localReceipt.run) return;
    const detailed = localEventOwned(event) || goalOwned;
    planEvent(event);
    capacityEvent(event);
    const result = oldRecord.apply(this, arguments);
    if (owner === identity() && sequence === runSequence && event.type === 'ui_request' && typeof pendingAsk !== 'undefined' &&
      pendingAsk && pendingAsk.id && pendingAsk.id === event.step_id) {
      askReceipt = {owner, run: sequence, turn: agentRun.turnID || '', id: pendingAsk.id};
    }
    if (owner === identity() && target) {
      appendEvent(target, event, detailed);
      if (event.type === 'agent_end') {
        const labels = {completed: '已结束', failed: '失败', canceled: '已停止'};
        const terminal = labels[event.status] || '执行结束';
        target.summary.textContent = '公开过程 · ' + terminal + ' · ' + target.count + ' 项';
        if (target === process && owner === runOwner) { runTerminal = terminal; if (capacity && (!capacityGoalKey || event.task_id === capacityRun)) { capacity.settled = true; capacity.compressing = false; renderCapacity(); } }
      }
    }
    syncTasks();
    if (owner === identity() && sequence === runSequence && event.type === 'ui_request' && askReceipt &&
      typeof pendingAsk !== 'undefined' && pendingAsk && pendingAsk.id === askReceipt.id && !runTerminal) {
      rail.open = true;
      taskCard.open = true;
      if (!wide.matches) mobileOpen = true;
      taskCaption = '等待确认';
      updateRailSummary();
    }
    return result;
  };
  const oldComplete = completeCoordinator;
  completeCoordinator = function(statusValue) {
    const result = oldComplete.apply(this, arguments);
    if (runOwner === identity() && process) {
      const states = {completed: '已结束', failed: '失败', canceled: '已停止', interrupted: '结果待核对'};
      runTerminal = states[statusValue || 'completed'] || '执行结束';
      if (capacity && !capacityGoalKey) { if (statusValue === 'interrupted') capacity.interrupted = true; else capacity.settled = true; capacity.compressing = false; renderCapacity(); }
      process.summary.textContent = '公开过程 · ' + runTerminal + ' · ' + process.count + ' 项';
      syncTasks();
    }
    return result;
  };
  // Observation loss is a frontend state, never a native terminal or Goal state.
  window.HandwaveContextInterrupted = function(receipt) {
    if (!receipt || runOwner !== identity() || !localTaskOwner || localTaskOwner !== identity() || receipt.run !== localRunID || receipt.run !== agentRun.turnID) return;
    let owner; try { owner = JSON.parse(receipt.owner); } catch (_) { return; }
    if (!Array.isArray(owner) || owner[0] !== (curWS && curWS.id || '') || owner[1] !== (curWS && curWS.device_fp || '') || owner[2] !== (curSess && curSess.id || '')) return;
    runTerminal = '连接中断 · 结果待核对'; localTaskOwner = ''; askReceipt = null;
    if (process) process.summary.textContent = '公开过程 · ' + runTerminal + ' · ' + process.count + ' 项';
    if (capacity) { capacity.interrupted = true; capacity.compressing = false; renderCapacity(); }
    syncTasks();
  };
  const oldFinishLocal = finishLocalRun;
  finishLocalRun = function(errorText) {
    const target = process, owner = runOwner;
    const ownedLocal = localBusy && localTaskOwner === owner;
    const result = oldFinishLocal.apply(this, arguments);
    if (owner === identity() && ownedLocal) {
      const terminal = errorText ? '执行中断' : '已结束';
      if (target) target.summary.textContent = '公开过程 · ' + terminal + ' · ' + target.count + ' 项';
      if (target === process && owner === runOwner) { runTerminal = terminal; if (capacity && !capacityGoalKey) { capacity.settled = true; capacity.compressing = false; renderCapacity(); } }
      syncTasks();
    }
    return result;
  };
  const oldDockMeta = liveDockMeta;
  liveDockMeta = function() {
    if (runOwner === identity() && runTerminal) return /待核对/.test(runTerminal) ? runTerminal : '执行已结束 · 步骤状态以收据为准';
    if (localTaskOwner === identity() && localBusy && !agentRun.agents.size) return '本机任务进行中 · 等待新事件';
    return oldDockMeta.apply(this, arguments);
  };
  const oldClear = clearMessages;
  clearMessages = function() { process = null; executeSteps.clear(); renderPlan(); return oldClear.apply(this, arguments); };
  const oldConsume = consumeSSE;
  consumeSSE = async function(path, body) {
    const owner = identity(), generation = epoch;
    const result = await oldConsume.apply(this, arguments);
    if (owner === identity() && generation === epoch && result && body && Array.isArray(body.attachments)) {
      attachments.push(...body.attachments);
      status.messages = '已加载';
      renderSources();
    }
    return result;
  };
  if (typeof onSig === 'function') {
    const original = onSig;
    onSig = function(signal) { const result = original.apply(this, arguments); if (signal && signal.k === 'goal-state') { syncCapacityGoal(); syncPlanGoal(); } return result; };
  }
  renderSources();
  syncTasks();
  // The normal boot/selection calls populate these receipts. A manual refresh is
  // available for errors; no background polling or observer watches chat content.
})();
