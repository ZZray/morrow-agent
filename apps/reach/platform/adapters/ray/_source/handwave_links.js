/* Bounded context links. Browser selection is never an execution permission. */
(() => {
  'use strict';
  const input = document.getElementById('input');
  const rail = document.querySelector('.hw-context-body');
  if (!input || !rail || document.documentElement.dataset.hwLinksReady === '1') return;
  document.documentElement.dataset.hwLinksReady = '1';
  const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const button = text => { const e = node('button', '', text); e.type = 'button'; return e; };
  const identity = () => JSON.stringify([curWS && curWS.id || '', curWS && curWS.device_fp || '', curSess && curSess.id || '']);
  const busy = () => typeof localBusy !== 'undefined' && localBusy || typeof sending !== 'undefined' && sending;
  const bytes = text => new TextEncoder().encode(text).length;
  const idOK = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(id);
  let owner = identity(), epoch = 0, peerEpoch = 0, caps = [], peerFP = '', mode = 'execute', composing = false;
  let references = [], sessions = [], sessionRequest = 0, sessionsPending = false, menuItems = [], menuIndex = 0, mention = null;
  let goal = null, candidate = null, dispatch = null, lastReceipt = null, createdSession = null, verifiedContext = null;
  let contextSequence = 0, runSequence = 0, activeRunSequence = 0;
  let lease = null, mirrorEpoch = '', pendingCommand = null;
  const runOwners = new Map(), proposals = new Map();
  const controls = node('div', 'hw-links');
  const toolbar = document.querySelector('.composer-toolbar .ct-left');
  (toolbar || input.parentNode).appendChild(controls);
  const modeSelect = node('select'); modeSelect.setAttribute('aria-label', '执行模式'); controls.appendChild(modeSelect);
  modeSelect.hidden = true;
  for (const [value, label] of [['execute', '执行'], ['plan', '计划 · 只读'], ['goal', '目标']]) { const o = node('option', '', label); o.value = value; modeSelect.appendChild(o); }
  const at = button('@'); at.setAttribute('aria-label', '引用会话或选择机器'); at.title = '引用会话或选择机器'; controls.appendChild(at);
  const modeBadge = button('计划模式 ×'); modeBadge.className = 'hw-links-mode'; modeBadge.hidden = true; modeBadge.setAttribute('aria-label', '退出计划模式'); controls.appendChild(modeBadge);
  const chips = node('div', 'hw-links-chips'); controls.appendChild(chips);
  const criteriaLabel = node('label', 'hw-links-criteria', '完成标准（每行一条，最多 8 条；留空使用本次目标）');
  const criteria = node('textarea'); criteria.rows = 2; criteria.setAttribute('aria-label', '目标完成标准'); criteriaLabel.appendChild(criteria); controls.appendChild(criteriaLabel);
  const backgroundLabel = node('label', 'hw-links-criteria');
  const background = node('input'); background.type = 'checkbox'; background.setAttribute('aria-label', '允许关闭网页后继续目标'); backgroundLabel.appendChild(background); backgroundLabel.appendChild(node('span', '', '关闭网页后继续 · 最多 1 小时 / 48 次模型调用 / 8 片')); controls.appendChild(backgroundLabel);
  backgroundLabel.appendChild(node('small', 'hw-context-hint', '需兼容的新会话或已固定模型的会话；实际到期时间以设备授权期限为上限。'));
  const jobsLabel = node('label', 'hw-links-criteria'); const allowJobs = node('input'); allowJobs.type = 'checkbox'; allowJobs.setAttribute('aria-label', '允许目标托管长进程'); jobsLabel.appendChild(allowJobs); jobsLabel.appendChild(node('span', '', '允许托管编译、下载等长进程 · 受目标授权期限约束')); controls.appendChild(jobsLabel);
  background.addEventListener('change', () => { if (!background.checked) allowJobs.checked = false; render(); });
  const status = node('p', 'hw-links-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.hidden = true; document.body.appendChild(status);
  const editor = node('dialog', 'hw-goal-editor'); editor.setAttribute('aria-labelledby', 'hwGoalEditorTitle'); document.body.appendChild(editor);
  const editorHeader = node('header', 'hw-goal-editor-header'); const editorTitle = node('h2', '', '编辑目标'); editorTitle.id = 'hwGoalEditorTitle'; editorHeader.appendChild(editorTitle); const editorClose = button('×'); editorClose.setAttribute('aria-label', '关闭目标编辑器'); editorHeader.appendChild(editorClose); editor.appendChild(editorHeader);
  const editorActions = node('div', 'hw-goal-editor-actions'); const editorHint = node('span', 'hw-context-hint'); editorActions.appendChild(editorHint); const editorCancel = button('取消'); const editorSave = button('保存'); editorCancel.className = 'hw-memory-button'; editorSave.className = 'hw-memory-button'; editorActions.appendChild(editorCancel); editorActions.appendChild(editorSave); editor.appendChild(editorActions);
  const objective = node('textarea', 'hw-goal-objective'); objective.setAttribute('aria-label', '目标正文'); objective.placeholder = '希望完成什么？'; objective.rows = 6; editor.appendChild(objective);
  const advanced = node('details', 'hw-goal-advanced'); advanced.appendChild(node('summary', '', '高级设置')); advanced.appendChild(criteriaLabel); advanced.appendChild(backgroundLabel); advanced.appendChild(jobsLabel); editor.appendChild(advanced);
  let editorOwner = '', editorReadOnly = false, editorReturnFocus = null, editorSnapshot = null, goalDraft = null;
  const goalStrip = node('section', 'hw-goal-strip'); goalStrip.setAttribute('aria-label', '当前目标'); goalStrip.hidden = true;
  const composer = document.querySelector('.composer');
  if (composer && composer.insertBefore) composer.insertBefore(goalStrip, composer.firstChild); else input.parentNode.appendChild(goalStrip);
  const menu = node('div', 'hw-links-menu'); menu.id = 'hwContextLinks'; menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', '上下文引用'); menu.hidden = true; controls.appendChild(menu);
  input.setAttribute('aria-controls', menu.id);
  const receiptCard = node('details', 'hw-context-card hw-links-receipts');
  const receiptSummary = node('summary', 'hw-context-heading hw-card-summary', '本次上下文 · 0'); receiptCard.appendChild(receiptSummary); rail.appendChild(receiptCard);
  const receiptRows = node('div'); receiptCard.appendChild(receiptRows);
  const goalHost = node('section', 'hw-goal');
  const goalDetails = node('details', 'hw-goal-details');
  const goalSummary = node('summary', 'hw-context-heading hw-card-summary');
  const goalBody = node('div', 'hw-goal-body');
  goalDetails.appendChild(goalSummary); goalDetails.appendChild(goalBody);
  let disclosedGoal = '';
  const taskCard = rail.querySelector && rail.querySelector('.hw-context-card');
  (taskCard || rail).appendChild(goalHost);
  const evolution = node('section', 'hw-context-card hw-evolution'); evolution.hidden = true; rail.appendChild(evolution);
  function supportsModes() { return caps.includes('run-modes-v1') && peerFP === (curWS && curWS.device_fp) && typeof paired !== 'undefined' && paired && typeof helloDone !== 'undefined' && helloDone; }
  function notice(text) { status.textContent = text; status.hidden = !text; }
  function closeGoalEditor(restore = true) {
    if (restore && editorSnapshot) { criteria.value = editorSnapshot.criteria; background.checked = editorSnapshot.background; allowJobs.checked = editorSnapshot.allowJobs; mode = editorSnapshot.mode; }
    if (typeof editor.close === 'function') editor.close(); else editor.hidden = true;
    editor.removeAttribute('open'); editorSnapshot = null; editorReadOnly = false; render();
    if (editorReturnFocus && editorReturnFocus.focus) editorReturnFocus.focus();
  }
  function openGoalEditor() {
    sync(); if (busy() && !goal) { notice('当前任务运行中，结束后再设置目标。'); return false; }
    if (!supportsModes()) { notice('请先接入支持目标模式的本机 Agent。'); return false; }
    editorOwner = identity(); editorReadOnly = !!goal && !goalEnded(); editorReturnFocus = document.activeElement;
    editorTitle.textContent = editorReadOnly ? '查看目标' : '编辑目标';
    editorSnapshot = {criteria: criteria.value, background: !!background.checked, allowJobs: !!allowJobs.checked, mode};
    objective.value = editorReadOnly ? goal.objective : goalDraft ? goalDraft.text : ''; objective.readOnly = editorReadOnly;
    editorSave.disabled = editorReadOnly; advanced.hidden = editorReadOnly;
    editorHint.textContent = editorReadOnly ? '当前目标已启动；停止后可创建新目标。' : '保存为草稿，发送后开始。';
    advanced.open = false; mode = editorReadOnly ? mode : 'goal'; render();
    if (typeof editor.showModal === 'function') { if (!editor.open) editor.showModal(); } else { editor.hidden = false; editor.setAttribute('open', ''); }
    objective.focus(); return true;
  }
  function setMode(next) {
    sync(); if (!['execute', 'plan', 'goal'].includes(next) || busy() || next !== 'execute' && !supportsModes()) return false;
    if (next === 'goal') return openGoalEditor();
    if (goalDraft) { criteria.value = ''; background.checked = false; allowJobs.checked = false; }
    mode = next; goalDraft = null; notice(''); render(); input.focus(); return true;
  }
  editorClose.addEventListener('click', () => closeGoalEditor()); editorCancel.addEventListener('click', () => closeGoalEditor());
  editor.addEventListener('cancel', event => { event.preventDefault(); closeGoalEditor(); });
  editor.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeGoalEditor(); return; }
    if ((event.ctrlKey || event.metaKey) && ['n', '/'].includes(event.key.toLowerCase())) event.stopPropagation();
  });
  editorSave.addEventListener('click', () => {
    if (editorOwner !== identity() || editorReadOnly || !!goal && !goalEnded() || busy() || !supportsModes()) { closeGoalEditor(); return; }
    const text = objective.value.trim(), standards = criteria.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (!text || bytes(text) > 8192 || standards.length > 8 || standards.some(s => bytes(s) > 1024)) { editorHint.textContent = '请填写目标；正文最多 8 KiB，完成标准最多 8 条、每条 1024 字节。'; return; }
    if (!standards.length && bytes(text) > 1024) { advanced.open = true; editorHint.textContent = '长目标请在高级设置填写简短完成标准，每条最多 1024 字节。'; criteria.focus(); return; }
    goalDraft = {text}; mode = 'goal'; closeGoalEditor(false); notice(''); render(); input.focus();
  });
  modeBadge.addEventListener('click', () => setMode('execute'));
  function closeMenu() { menu.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); mention = null; }
  function reset() {
    if (editorSnapshot) { editorSnapshot = null; closeGoalEditor(false); }
    owner = identity(); epoch++; sessionRequest++; contextSequence++; verifiedContext = null; activeRunSequence = 0; sessionsPending = false; references = []; sessions = []; menuItems = []; menu.replaceChildren(); lastReceipt = null; goal = null; lease = null; mirrorEpoch = ''; pendingCommand = null; background.checked = false; allowJobs.checked = false; candidate = null; dispatch = null; proposals.clear(); criteria.value = ''; mode = 'execute'; goalDraft = null; closeMenu(); notice(''); render();
  }
  function sync() { if (owner !== identity()) reset(); }
  function goalEnded() { return !!goal && ['accepted', 'canceled'].includes(goal.status); }
  function goalBlockReason() {
    if (!lease || goalEnded()) return '';
    if (lease.expires_at <= Math.floor(Date.now() / 1000) || goal.status === 'waiting_authorization') return '后台授权已到期或需要重新核验。先停止此目标，再新建目标并明确授权。';
    const budget = goal.budget;
    if (goal.status === 'budget_limited' || goal.status === 'exhausted' || budget && (budget.calls_reserved >= lease.max_calls || budget.slices_started >= lease.max_slices)) return '当前目标预算已用尽。先停止此目标，再填写新目标并选择新的授权。';
    if (goal.status === 'waiting_recovery') return '执行结果尚需核验；请先检查日志和实际效果。停止此目标后可新建目标，未知操作不会自动重放。';
    return '';
  }
  function render() {
    modeSelect.value = mode; modeSelect.disabled = busy();
    modeBadge.hidden = mode !== 'plan'; modeBadge.disabled = busy();
    for (const o of modeSelect.children) o.disabled = o.value !== 'execute' && !supportsModes();
    criteriaLabel.hidden = mode !== 'goal'; criteria.disabled = busy() || editorReadOnly;
    backgroundLabel.hidden = mode !== 'goal' || !caps.includes('goal-runner-v1'); background.disabled = busy() || !!lease && !goalEnded();
    jobsLabel.hidden = backgroundLabel.hidden || !background.checked || !caps.includes('managed-jobs-v1'); allowJobs.disabled = busy() || !!lease && !goalEnded();
    chips.replaceChildren();
    references.forEach(r => { const chip = node('span', 'hw-links-chip'); chip.appendChild(node('span', '', '@' + r.title)); const remove = button('×'); remove.disabled = busy(); remove.setAttribute('aria-label', '移除会话引用 ' + r.title); remove.addEventListener('click', () => { if (busy()) return; references = references.filter(x => x !== r); lastReceipt = null; render(); input.focus(); }); chip.appendChild(remove); chips.appendChild(chip); });
    receiptRows.replaceChildren();
    receiptSummary.textContent = '本次上下文 · ' + (lastReceipt ? lastReceipt.references.length + lastReceipt.memories.length : 0);
    if (!lastReceipt) receiptRows.appendChild(node('p', 'hw-context-hint', references.length ? '已选择会话；发送前由云端核验并读取。' : '发送时按相关性选择记忆；这里只展示服务端返回的上下文。'));
    if (lastReceipt) {
      for (const r of lastReceipt.references) { const p = node('p'); p.appendChild(node('b', '', r.title || r.session_id || '会话引用')); p.appendChild(node('small', '', ' · ' + (r.hash || '').slice(0, 12) + (r.truncated ? ' · 已截断' : ''))); receiptRows.appendChild(p); }
      for (const r of lastReceipt.memories) receiptRows.appendChild(node('p', 'hw-context-hint', (r.scope === 'workspace' ? '全局（Ray 共享）' : r.scope === 'project' ? '项目' : '本机') + ' · ' + (r.title || r.id || '记忆') + ' · ' + (r.hash || '').slice(0, 12)));
      if (!lastReceipt.references.length && !lastReceipt.memories.length) receiptRows.appendChild(node('p', 'hw-context-hint', '本次未附加会话引用或记忆。'));
    }
    renderGoal(); renderCandidate();
  }
  function renderGoal() {
    goalStrip.replaceChildren(); goalStrip.hidden = !goal && !(goalDraft && mode === 'goal');
    if ((!goal || goalEnded()) && goalDraft && mode === 'goal') {
      const draft = button('目标草稿'); draft.className = 'hw-goal-strip-title'; draft.title = goalDraft.text; draft.disabled = busy(); draft.addEventListener('click', openGoalEditor); goalStrip.appendChild(draft);
      goalStrip.appendChild(node('span', 'hw-goal-strip-objective', goalDraft.text));
      const clear = button('取消目标草稿'); clear.setAttribute('aria-label', '取消目标草稿'); clear.setAttribute('data-icon', '×'); clear.disabled = busy(); clear.addEventListener('click', () => setMode('execute')); goalStrip.appendChild(clear);
      if (goalEnded()) return;
    }
    if (!goal) { goalHost.replaceChildren(); return; }
    Array.from(goalHost.children).filter(e => e !== goalDetails).forEach(e => e.remove());
    const labels = {running: '进行中', awaiting_review: '待你验收', paused: '已暂停', accepted: '已确认完成', blocked: '受阻', waiting_authorization: '等待重新授权', waiting_job: '等待长进程结果', waiting_recovery: '需核验执行结果', yielded: '等待下一片', budget_limited: '预算已用尽', exhausted: '预算已用尽', canceled: '已停止', stopped: '已停止', failed: '执行失败'};
    const stripTitle = button('目标'); stripTitle.className = 'hw-goal-strip-title'; stripTitle.setAttribute('aria-label', '查看目标'); stripTitle.addEventListener('click', openGoalEditor); goalStrip.appendChild(stripTitle);
    const stripText = node('span', 'hw-goal-strip-objective', goal.objective); stripText.title = goal.objective; goalStrip.appendChild(stripText);
    goalStrip.appendChild(node('span', 'hw-goal-strip-state', labels[goal.status] || goal.status));
    const stripAction = (text, icon, action, disabled) => { const b = button(text); b.setAttribute('aria-label', text); b.title = text; b.setAttribute('data-icon', icon); b.disabled = disabled; b.addEventListener('click', action); goalStrip.appendChild(b); return b; };
    if (disclosedGoal !== owner + '/' + goal.id) { goalDetails.open = false; disclosedGoal = owner + '/' + goal.id; }
    const steps = goal.steps || [];
    goalSummary.textContent = '目标 · ' + (labels[goal.status] || goal.status) + (steps.length ? ' · ' + steps.filter(s => ['done', 'completed'].includes(s.status)).length + '/' + steps.length : '');
    goalBody.replaceChildren(); goalBody.appendChild(node('p', '', goal.objective));
    const savedCriteria = Array.isArray(goal.criteria) ? goal.criteria : null;
    if (savedCriteria && savedCriteria.length) {
      goalBody.appendChild(node('h4', 'hw-context-heading', '完成标准 · ' + (Number.isSafeInteger(goal.criteria_revision) ? '版本 ' + goal.criteria_revision : '版本待同步')));
      const criteriaList = node('ol'); savedCriteria.forEach(text => criteriaList.appendChild(node('li', '', text))); goalBody.appendChild(criteriaList);
    } else goalBody.appendChild(node('p', 'hw-context-hint', '后端完成标准待同步；不使用输入框内容代替。'));
    if (goalDetails.parentNode !== goalHost) goalHost.appendChild(goalDetails);
    if (lease) goalBody.appendChild(node('p', 'hw-context-hint', '后台授权至 ' + new Date(lease.expires_at * 1000).toLocaleTimeString() + ' · ' + lease.max_calls + ' 次调用 / ' + lease.max_slices + ' 片上限'));
    if (pendingCommand) { goalBody.appendChild(node('p', 'hw-context-hint', '正在等待电脑确认操作…')); stripAction('重试同一操作', '↻', () => { if (pendingCommand && pendingCommand.signal && typeof sendSig === 'function') sendSig(pendingCommand.signal); }, false); }
    const list = node('ol'); for (const step of goal.steps || []) list.appendChild(node('li', '', step.name + ' · ' + step.status + (step.evidence ? ' · ' + step.evidence : ''))); goalBody.appendChild(list);
    const goalID = goal.id;
    if (goal.status === 'awaiting_review') stripAction('确认完成', '✓', () => lease ? goalCommand('accept') : management('/goal accept ' + goalID), busy() || !!pendingCommand);
    const blocked = goalBlockReason(); if (blocked) goalHost.appendChild(node('p', 'hw-context-hint', blocked));
    if (goalEnded()) stripAction('新建目标', '+', () => { mode = 'goal'; criteria.value = ''; openGoalEditor(); }, busy() || !!pendingCommand);
    else if (!lease || goal.status === 'paused' && !blocked) stripAction(goal.status === 'paused' ? '恢复目标' : '继续目标', '▷', () => { if (!goal || goal.id !== goalID) return; if (goal.status === 'paused') lease ? goalCommand('resume') : management('/goal resume ' + goalID); else { mode = 'goal'; render(); input.focus(); notice('补充下一步要求后发送，将继续当前目标。'); } }, busy() || !!pendingCommand);
    if (lease && goal.status === 'running') stripAction('暂停目标', 'Ⅱ', () => goalCommand('pause'), !!pendingCommand);
    if (lease && !goalEnded()) stripAction('停止目标', '□', () => goalCommand('stop'), !!pendingCommand);
    goalBody.appendChild(node('p', 'hw-context-hint', '步骤完成是 Agent 的进展记录；只有你确认后才算目标完成。'));
  }
  function sessionKey() { return curWS && curSess ? curWS.id + '/' + curSess.id : ''; }
  function goalCommand(command) {
    if (!goal || !lease || pendingCommand || typeof sendSig !== 'function') return;
    const commandID = 'gc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14);
    const signal = {k: 'goal-command', command_id: commandID, goal_id: goal.id, session_key: sessionKey(), fp: curWS.device_fp, command, expected_revision: goal.revision, reviewed_run_id: command === 'accept' ? goal.last_settled_run : ''};
    pendingCommand = {id: commandID, revision: goal.revision, signal}; sendSig(signal); render();
  }
  function management(command) {
    if (busy() || !supportsModes() || input.value.trim()) { notice('请先完成或保留当前输入，再发送目标管理命令。'); return; }
    input.value = command; input.dispatchEvent(new Event('input', {bubbles: true})); void sendChat();
  }
  function renderCandidate() {
    evolution.replaceChildren(); evolution.hidden = !candidate; if (!candidate) return;
    evolution.appendChild(node('h2', 'hw-context-heading', '经验候选 · 未采纳'));
    evolution.appendChild(node('p', '', candidate.lesson)); evolution.appendChild(node('p', 'hw-context-hint', '适用条件：' + candidate.conditions));
    evolution.appendChild(node('p', 'hw-context-hint', '保存为独立云端副本，撤销各自生效。原会话经验不会自动采纳。'));
    const save = button('保存云端经验'); save.className = 'hw-memory-button';
    save.addEventListener('click', async () => {
      if (!candidate || candidate.owner !== identity() || !window.HandwaveMemory || !window.HandwaveMemory.openLesson) return;
      const c = candidate;
      const ok = await window.HandwaveMemory.openLesson({owner: c.owner, title: c.lesson.slice(0, 100), text: c.lesson + '\n\n适用条件：' + c.conditions + '\n\n来源 Run：' + c.run + '\n候选：' + c.id + '\n原始来源：' + c.sources.join(', ') + '\n\n这是用户审阅后保存的独立云端副本；撤销各自生效。'});
      if (!ok && candidate === c) notice('云端记忆尚未就绪，请先在设置中选择工作区并刷新记忆。');
    }); evolution.appendChild(save);
  }
  function token() {
    const end = input.selectionStart == null ? input.value.length : input.selectionStart;
    const before = input.value.slice(0, end); const match = /(?:^|\s)@([^\s@]{0,80})$/.exec(before);
    return match ? {start: end - match[1].length - 1, end, query: match[1].toLowerCase()} : null;
  }
  async function loadSessions() {
    if (!curWS || !idOK(curWS.id) || sessionsPending) return;
    const ticket = {owner: identity(), epoch, request: ++sessionRequest};
    sessionsPending = true;
    try { const result = await api('/reference-sessions?workspace_id=' + encodeURIComponent(curWS.id)); if (ticket.owner !== identity() || ticket.epoch !== epoch || ticket.request !== sessionRequest) return; sessions = Array.isArray(result) ? result.filter(s => s && idOK(s.id)).slice(0, 200) : []; if (!menu.hidden) showMenu(); }
    catch (_) { if (ticket.owner === identity() && ticket.epoch === epoch) notice('会话目录读取失败，可重试 @ 引用。'); }
    finally { if (ticket.epoch === epoch && ticket.request === sessionRequest) sessionsPending = false; }
  }
  function showMenu() {
    sync(); if (composing) return closeMenu();
    mention = token(); if (!mention) return closeMenu();
    const query = mention.query; menuItems = [];
    for (const s of sessions) if (s.id !== (curSess && curSess.id) && (s.title || s.id).toLowerCase().includes(query)) menuItems.push({kind: 'session', id: s.id, title: String(s.title || s.id).slice(0, 160)});
    for (const d of typeof devices !== 'undefined' && Array.isArray(devices) ? devices : []) if (d && typeof d.fp === 'string' && String(d.name || d.hostname || d.fp).toLowerCase().includes(query)) menuItems.push({kind: 'machine', id: d.fp, title: String(d.name || d.hostname || d.fp).slice(0, 160), state: d.state});
    menuItems = menuItems.slice(0, 40); menuIndex = Math.min(menuIndex, Math.max(0, menuItems.length - 1)); menu.replaceChildren();
    let previous = '';
    menuItems.forEach((item, i) => { if (item.kind !== previous) { menu.appendChild(node('div', 'hw-links-menu-heading', item.kind === 'session' ? '会话 · 只读参考' : '机器 · 执行目标')); previous = item.kind; } const row = button(item.title); row.id = 'hwMention_' + i; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', i === menuIndex ? 'true' : 'false'); if (item.kind === 'machine') row.appendChild(node('small', '', busy() ? '任务运行中，暂不能切换' : item.state === 'approved' || item.state === 'paired' ? '已授权 · 选择后接入' : '未授权或离线')); row.addEventListener('mousedown', e => e.preventDefault()); row.addEventListener('click', () => choose(i)); menu.appendChild(row); });
    if (!menuItems.length) menu.appendChild(node('p', 'hw-context-hint', '没有匹配项。会话仅列出当前工作区。'));
    menu.hidden = false; input.setAttribute('aria-expanded', 'true'); if (menuItems.length) input.setAttribute('aria-activedescendant', 'hwMention_' + menuIndex);
  }
  function removeToken() { if (!mention) return; const start = mention.start; input.value = input.value.slice(0, start) + input.value.slice(mention.end); input.setSelectionRange(start, start); input.dispatchEvent(new Event('input', {bubbles: true})); }
  function choose(index) {
    const item = menuItems[index]; if (!item) return;
    if (item.kind === 'session') {
      if (busy()) return notice('任务运行中，结束后再调整会话引用。');
      if (references.length >= 4 && !references.some(r => r.session_id === item.id)) return notice('最多引用 4 个会话。');
      if (!references.some(r => r.session_id === item.id)) references.push({workspace_id: curWS.id, session_id: item.id, title: item.title});
      removeToken(); closeMenu(); lastReceipt = null; render(); input.focus();
    } else if (window.HandwaveLinks.selectMachine(item.id)) { removeToken(); closeMenu(); input.focus(); }
  }
  at.addEventListener('click', () => { input.focus(); const atPos = input.selectionStart == null ? input.value.length : input.selectionStart; const prefix = atPos && !/\s$/.test(input.value.slice(0, atPos)) ? ' @' : '@'; input.setRangeText(prefix, atPos, input.selectionEnd == null ? atPos : input.selectionEnd, 'end'); showMenu(); void loadSessions(); });
  input.addEventListener('compositionstart', () => { composing = true; closeMenu(); });
  input.addEventListener('compositionend', () => { composing = false; showMenu(); });
  input.addEventListener('input', () => { showMenu(); if (mention && !sessions.length) void loadSessions(); if (goalDraft) renderGoal(); });
  input.addEventListener('keydown', event => {
    if (menu.hidden || composing || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(event.key)) {
      if (event.key === 'Tab') { closeMenu(); return; }
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Escape') { closeMenu(); return; }
      if (event.key === 'Enter') { choose(menuIndex); return; }
      menuIndex = (menuIndex + (event.key === 'ArrowDown' ? 1 : -1) + Math.max(1, menuItems.length)) % Math.max(1, menuItems.length); showMenu();
    }
  }, true);
  modeSelect.addEventListener('change', () => { if (busy() || modeSelect.value !== 'execute' && !supportsModes()) { render(); return; } mode = ['execute', 'plan', 'goal'].includes(modeSelect.value) ? modeSelect.value : 'execute'; notice(mode === 'plan' ? '计划模式仅允许只读工具；执行修改请切回执行或目标。' : mode === 'goal' ? '目标与完成标准由本机会话保存，结束后仍需你验收。' : ''); render(); });
  const oldAPI = api;
  api = async function(path, options) {
    if (path !== '/agent-context') {
      const creation = dispatch && !dispatch.session && curWS && path === '/workspaces/' + curWS.id + '/sessions' && options && options.method === 'POST' ? {owner: identity(), epoch, workspace: curWS.id, dispatch, mode, references: references.map(r => ({...r})), criteria: criteria.value, goalDraft} : null;
      const result = await oldAPI.apply(this, arguments);
      if (creation && creation.owner === identity() && creation.epoch === epoch && result && idOK(result.id)) createdSession = {...creation, id: result.id};
      return result;
    }
    sync(); verifiedContext = null;
    const ticket = {owner: identity(), epoch, peerEpoch, run: localRunID, sequence: ++contextSequence, workspace: curWS && curWS.id || '', session: curSess && curSess.id || '', fp: curWS && curWS.device_fp || ''}; const body = JSON.parse(options.body);
    if (dispatch && dispatch.epoch === epoch && !dispatch.session && dispatch.workspace === (curWS && curWS.id || '') && dispatch.fp === (curWS && curWS.device_fp || '')) dispatch.owner = identity();
    const selected = references.map(r => ({workspace_id: r.workspace_id, session_id: r.session_id, ...(r.hash ? {expected_hash: r.hash} : {})}));
    const result = await oldAPI.call(this, path, {...options, body: JSON.stringify({...body, execution_mode: dispatch && dispatch.mode || mode, reference_sessions: selected})});
    const firstBinding = !ticket.fp && ticket.workspace === (curWS && curWS.id) && ticket.session === (curSess && curSess.id || '') && peerFP && (curWS && curWS.device_fp) === peerFP && result.workspace_id === ticket.workspace && result.device_fp === peerFP;
    if ((ticket.owner !== identity() && !firstBinding) || ticket.epoch !== epoch || ticket.peerEpoch !== peerEpoch || ticket.sequence !== contextSequence || ticket.run !== localRunID) throw new Error('会话已变化，已丢弃迟到的引用。');
    if (firstBinding) { owner = identity(); if (dispatch && dispatch.owner === ticket.owner) { dispatch.owner = owner; dispatch.fp = peerFP; } }
    const received = Array.isArray(result.session_references) ? result.session_references.slice(0, 4) : [];
    if (selected.length && received.length !== selected.length) throw new Error('会话引用未完整核验，请重新选择后发送。');
    for (const r of received) { const selectedRef = references.find(s => s.workspace_id === r.workspace_id && s.session_id === r.session_id); if (!selectedRef || typeof r.hash !== 'string' || !/^[a-f0-9]{64}$/.test(r.hash)) throw new Error('会话引用收据无效。'); selectedRef.hash = r.hash; }
    verifiedContext = {owner: identity(), epoch, peerEpoch, run: ticket.run};
    lastReceipt = {references: received, memories: result.memory_receipt && Array.isArray(result.memory_receipt.records) ? result.memory_receipt.records.slice(0, 32) : []}; render(); return result;
  };
  const oldSend = sendChat;
  sendChat = function() {
    sync(); closeMenu();
    if (typeof localMode === 'undefined' || !localMode) { if (mode !== 'execute' || references.length) { notice('会话引用与执行模式需要先启用本机 Agent。'); return; } return oldSend.apply(this, arguments); }
    if (mode !== 'execute' && !supportsModes()) { notice('当前节点尚未支持计划和目标模式，请升级并重新接入。'); return; }
    if (mode === 'goal' && goalBlockReason()) { notice(goalBlockReason()); return; }
    const initialDraft = mode === 'goal' && goalDraft && (!goal || goalEnded());
    if (initialDraft && busy()) { notice('目标正在启动，请等待电脑接收后再补充要求。'); return; }
    const originalInput = input.value;
    const text = initialDraft ? goalDraft.text + (originalInput.trim() ? '\n\n本次补充：\n' + originalInput.trim() : '') : originalInput.trim();
    const standards = criteria.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (mode === 'goal' && (!goal || goalEnded()) && !standards.length) standards.push(initialDraft ? goalDraft.text : text);
    if (standards.length > 8 || standards.some(s => !s || bytes(s) > 1024) || mode === 'goal' && bytes(text) > 8192) { notice('完成标准最多 8 条，每条不超过 1024 字节；目标与补充要求合计不超过 8 KiB。'); return; }
    const submission = initialDraft ? {originalInput, text, sent: false} : null;
    dispatch = {owner: identity(), epoch, workspace: curWS && curWS.id || '', fp: curWS && curWS.device_fp || '', session: curSess && curSess.id || '', mode, background: background.checked, allowJobs: allowJobs.checked, criteria: standards, goalID: mode === 'goal' && goal && !goalEnded() ? goal.id : '', submission};
    // The pinned composer captures input synchronously before its first await.
    // Never leave the long objective in the visible input while context loads.
    if (submission) input.value = text;
    try { return oldSend.apply(this, arguments); }
    finally { if (submission && !submission.sent && (input.value === '' || input.value === text)) input.value = originalInput; }
  };
  const oldFrameSend = sendFrame;
  sendFrame = function(frame) {
    if (!frame || frame.k !== 'agent-loop') return oldFrameSend.apply(this, arguments);
    sync(); const d = dispatch || {owner: identity(), mode, criteria: [], goalID: ''};
    if (d.owner !== identity() || d.mode !== 'execute' && !supportsModes()) { notice('电脑或模式已变化，任务未发送。'); return false; }
    if (d.submission && !d.submission.sent && (frame.msg !== d.submission.text || typeof stopRequested !== 'undefined' && stopRequested)) { notice('目标启动已取消或正文已变化，任务未发送；原输入已保留。'); return false; }
    const active = runOwners.get(localRunID);
    const follow = frame.id !== localRunID && typeof localBusy !== 'undefined' && localBusy && active && active.owner === identity() && active.epoch === epoch && active.peerEpoch === peerEpoch && active.verified;
    if (!follow && (!verifiedContext || verifiedContext.owner !== identity() || verifiedContext.epoch !== epoch || verifiedContext.peerEpoch !== peerEpoch || verifiedContext.run !== frame.id)) { notice('上下文未完整核验，任务未发送；请重新选择引用后重试。'); return false; }
    if (follow && d.mode !== active.mode) { notice('跟进任务必须沿用当前运行模式，任务未发送。'); return false; }
    const startingAfterEnd = d.mode === 'goal' && !d.goalID && goalEnded();
    const enriched = {...frame, execution_mode: d.mode, ...(d.mode === 'goal' ? {goal_criteria: d.criteria, ...(d.goalID ? {goal_id: d.goalID} : {}), ...(d.background && caps.includes('goal-runner-v1') && (!lease || goalEnded()) ? {goal_policy: {expires_at: Math.floor(Date.now() / 1000) + 3600, max_calls: 48, max_slices: 8, allow_jobs: !!d.allowJobs && caps.includes('managed-jobs-v1')}} : {})} : {})};
    const sent = oldFrameSend.call(this, enriched); if (sent) { if (d.submission) { d.submission.sent = true; if (input.value === d.submission.originalInput || input.value === d.submission.text) input.value = ''; } if (startingAfterEnd) { goal = null; lease = null; mirrorEpoch = ''; } const sequence = ++runSequence; if (!follow) activeRunSequence = sequence; runOwners.set(frame.id, {owner: identity(), epoch, peerEpoch, mode: d.mode, sequence, verified: true}); if (runOwners.size > 64) runOwners.delete(runOwners.keys().next().value); } return sent;
  };
  const oldFrame = onFrame;
  onFrame = function(frame) {
    if (frame && frame.k === 'node-hello') { peerEpoch++; verifiedContext = null; caps = frame.info && Array.isArray(frame.info.caps) ? frame.info.caps : []; peerFP = frame.fp || ''; proposals.clear(); }
    const receipt = frame && runOwners.get(frame.id);
    if (frame && frame.k === 'agent-event' && receipt && receipt.owner === identity() && receipt.epoch === epoch && receipt.peerEpoch === peerEpoch && receipt.sequence >= activeRunSequence) {
      activeRunSequence = receipt.sequence;
      const event = frame.event || {};
      if (!lease && event.type === 'goal_update' && event.goal && typeof event.goal.id === 'string' && event.goal.id.length <= 128 && Array.isArray(event.goal.steps) && event.goal.steps.length <= 8 && (!goal || goal.id !== event.goal.id || event.goal.revision >= goal.revision)) { goal = event.goal; goalDraft = null; }
      if (event.type === 'tool_start' && event.title === 'experience_propose' && typeof event.detail === 'string' && event.detail.length <= 16384) { try { const args = JSON.parse(event.detail); if (typeof args.lesson === 'string' && bytes(args.lesson) <= 2048 && typeof args.conditions === 'string' && bytes(args.conditions) <= 1024 && Array.isArray(args.source_ids)) proposals.set(frame.id + '/' + event.step_id, args); } catch (_) {} }
      if (event.type === 'tool_end' && event.title === 'experience_propose') { const key = frame.id + '/' + event.step_id, args = proposals.get(key); proposals.delete(key); if (args && event.status === 'completed') { try { const result = JSON.parse(event.output); if (result.status === 'candidate' && result.adopted === false && typeof result.id === 'string') candidate = {owner: identity(), id: result.id, lesson: args.lesson, conditions: args.conditions, sources: args.source_ids.filter(x => typeof x === 'string').slice(0, 16), run: frame.id}; } catch (_) {} } }
    }
    const result = oldFrame.apply(this, arguments); sync(); render(); return result;
  };
  function inspectGoals() { if (typeof sendSig === 'function' && sessionKey() && curWS.device_fp) sendSig({k: 'goal-inspect', session_key: sessionKey(), fp: curWS.device_fp}); }
  if (typeof onSig === 'function') {
    const original = onSig;
    onSig = function(signal) {
      sync();
      if (signal && signal.k === 'goal-state' && signal.fp === (curWS && curWS.device_fp) && signal.session_key === sessionKey() && signal.goal_lease && signal.goal_lease.device === signal.fp && signal.goal_lease.session === sessionKey() && signal.goal && typeof signal.goal.id === 'string' && Number.isSafeInteger(signal.goal.revision) && signal.goal.revision > 0 && Array.isArray(signal.goal.steps) && signal.goal.steps.length <= 8 && (!goal || signal.goal.id === goal.id && (signal.goal.revision > goal.revision || !lease && signal.goal.revision === goal.revision) || signal.goal.id !== goal.id && (!lease || goalEnded()))) {
        goal = signal.goal; lease = signal.goal_lease; mirrorEpoch = signal.writer_epoch; if (!goalEnded()) goalDraft = null;
        if (goalEnded()) { background.checked = false; allowJobs.checked = false; }
        if (pendingCommand && goal.revision > pendingCommand.revision) pendingCommand = null;
      }
      if (signal && ['goal-command', 'goal-command-result'].includes(signal.k) && pendingCommand && signal.command_id === pendingCommand.id) {
        if (signal.err) { pendingCommand = null; notice('目标操作未确认：' + signal.err); }
        else inspectGoals();
      }
      if (signal && ['paired', 'unpaired', 'pair-fail'].includes(signal.k)) { peerEpoch++; caps = []; peerFP = ''; proposals.clear(); }
      const result = original.apply(this, arguments); if (signal && signal.k === 'paired') inspectGoals(); render(); return result;
    };
  }
  if (typeof sendSig === 'function') { const original = sendSig; sendSig = function(signal) { if (signal && signal.k === 'bye') { peerEpoch++; caps = []; peerFP = ''; proposals.clear(); } const result = original.apply(this, arguments); render(); return result; }; }
  for (const name of ['selectSession', 'selectWorkspace']) {
    const original = name === 'selectSession' ? selectSession : selectWorkspace;
    const wrapped = function() {
      const preserve = name === 'selectSession' && createdSession && createdSession.epoch === epoch && createdSession.workspace === (curWS && curWS.id) && arguments[0] && arguments[0].id === createdSession.id ? createdSession : null;
      createdSession = null; const result = original.apply(this, arguments); reset();
      if (preserve) { mode = preserve.mode; goalDraft = preserve.goalDraft; references = preserve.references; criteria.value = preserve.criteria; background.checked = !!preserve.dispatch.background; allowJobs.checked = !!preserve.dispatch.allowJobs; dispatch = {...preserve.dispatch, owner: identity(), epoch, session: curSess && curSess.id || ''}; render(); }
      inspectGoals(); return result;
    };
    if (name === 'selectSession') selectSession = wrapped; else selectWorkspace = wrapped;
  }
  if (typeof setSendUI === 'function') { const original = setSendUI; setSendUI = function() { const result = original.apply(this, arguments); render(); return result; }; }
  window.HandwaveLinks = Object.freeze({
    canAdoptQueuedRun(run, previous, binding) {
      const next = runOwners.get(run), before = runOwners.get(previous);
      return !!binding && run !== previous && previous === localRunID && caps.includes('agent-queue-v1') &&
        binding.fp === peerFP && binding.session_key === sessionKey() && !!next && !!before &&
        next.owner === identity() && before.owner === next.owner && next.epoch === epoch && before.epoch === epoch &&
        next.peerEpoch === peerEpoch && before.peerEpoch === peerEpoch && next.verified && before.verified && next.mode === before.mode;
    },
    adoptQueuedRun(run, previous, binding) {
      if (!window.HandwaveLinks.canAdoptQueuedRun(run, previous, binding)) return false;
      activeRunSequence = runOwners.get(run).sequence; return true;
    },
    openGoalEditor,
    setMode,
    // Main owner enables this only after the execution-target interaction is agreed.
    selectMachine(fp) {
      sync(); if (busy()) { notice('当前任务运行中，结束后再切换机器。'); return false; }
      const d = (typeof devices !== 'undefined' && Array.isArray(devices) ? devices : []).find(x => x.fp === fp);
      if (!d || !['approved', 'paired'].includes(d.state)) { notice('请选择已授权且在线的机器；新机器请先从设备管理授权。'); return false; }
      if (typeof window.HandwaveMachineTarget !== 'function') { notice('请先从工具与连接接入这台机器，再发送任务。'); return false; }
      return window.HandwaveMachineTarget(d) === true;
    },
    state: () => ({mode, references: references.map(r => ({...r})), goal, goalDraft: goalDraft && {...goalDraft}, candidate, capabilities: [...caps], lease, pendingCommand, mirrorEpoch})
  });
  render();
})();
