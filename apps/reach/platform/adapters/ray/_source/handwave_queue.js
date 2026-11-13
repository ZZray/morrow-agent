/* Native queue snapshots are authoritative; this presenter owns no scheduler. */
(() => {
  'use strict';
  const input = document.getElementById('input'), composer = document.querySelector('.composer'), send = document.getElementById('btnSend');
  if (!input || !composer || !send || document.documentElement.dataset.hwQueueReady === '1') return;
  document.documentElement.dataset.hwQueueReady = '1';
  const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const button = (label, icon) => { const e = node('button', 'hw-queue-action', icon || label); e.type = 'button'; e.title = label; e.setAttribute('aria-label', label); return e; };
  const identity = () => JSON.stringify([curWS && curWS.id || '', curWS && curWS.device_fp || '', curSess && curSess.id || '', typeof myFP === 'string' ? myFP : '']);
  const session = () => curWS && curSess ? curWS.id + '/' + curSess.id : '';
  const nativeBusy = () => typeof localMode !== 'undefined' && localMode && typeof localBusy !== 'undefined' && localBusy;
  const freshID = () => 'q-' + crypto.randomUUID();
  const bytes = text => new TextEncoder().encode(text).length;
  let owner = identity(), peerEpoch = 0, peerFP = '', caps = [], queueEpoch = '', revision = -1, items = [], active = '', pending = null, uncertain = false, generation = 0, capture = null, edit = null, menuItem = null, menuAnchor = null;
  const sentQueued = new Map(), confirmed = new Set(), started = new Set(), settled = new Set(), retired = new Set(), steering = new Map();
  const panel = node('section', 'hw-queue'); panel.setAttribute('aria-label', '待执行消息'); panel.hidden = true;
  const rows = node('div', 'hw-queue-rows'); panel.appendChild(rows);
  composer.insertBefore(panel, document.querySelector('.composer-box') || composer.firstChild);
  const toast = node('div', 'hw-queue-toast'); toast.hidden = true; const status = node('span'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); toast.appendChild(status);
  const refresh = button('核对队列', '刷新'), restore = button('恢复未应用的引导草稿', '恢复草稿'), dismiss = button('关闭提示', '×'); restore.hidden = true; toast.appendChild(refresh); toast.appendChild(restore); toast.appendChild(dismiss); document.body.appendChild(toast);
  let recoverText = '';
  const more = node('div', 'hw-queue-menu'); more.setAttribute('role', 'menu'); more.hidden = true;
  const editAction = button('编辑', '编辑'), frontAction = button('移到最前', '移到最前'); editAction.setAttribute('role', 'menuitem'); frontAction.setAttribute('role', 'menuitem'); more.appendChild(editAction); more.appendChild(frontAction); document.body.appendChild(more);
  const dialog = node('dialog', 'hw-queue-editor'); dialog.setAttribute('aria-labelledby', 'hwQueueEditorTitle'); const form = node('form'); dialog.appendChild(form);
  const heading = node('h2', '', '编辑队列消息'); heading.id = 'hwQueueEditorTitle'; form.appendChild(heading); const text = node('textarea'); text.setAttribute('aria-label', '队列消息正文'); text.rows = 5; form.appendChild(text);
  const feedback = node('p', 'hw-context-hint'); feedback.setAttribute('role', 'status'); form.appendChild(feedback); const actions = node('div', 'hw-queue-editor-actions'), cancel = button('取消', '取消'), save = button('保存', '保存'); save.type = 'submit'; actions.appendChild(cancel); actions.appendChild(save); form.appendChild(actions); document.body.appendChild(dialog);
  function ready() { return caps.includes('agent-queue-v1') && peerFP && curWS && peerFP === curWS.device_fp && /^[A-Za-z0-9_-]{1,96}\/[A-Za-z0-9_-]{1,96}$/.test(session()) && typeof paired !== 'undefined' && paired && typeof helloDone !== 'undefined' && helloDone; }
  function notice(message) { status.textContent = message; toast.hidden = !message; refresh.disabled = !ready() || !!pending; }
  function closeMore(returnFocus = false) { const anchor = menuAnchor; more.hidden = true; menuItem = null; menuAnchor = null; if (anchor) { anchor.setAttribute('aria-expanded', 'false'); if (returnFocus && anchor.isConnected !== false) anchor.focus(); } }
  function closeEditor() { if (dialog.open) dialog.close(); edit = null; }
  function reset(clearPeer = false) {
    if (window.HandwaveRecovery && window.HandwaveRecovery.rememberQueue) window.HandwaveRecovery.rememberQueue(owner, {items, steers: Array.from(steering.values()).filter(s => !s.noted).map(s => s.msg), edit: edit ? text.value : '', recoverText, pending: pending && pending.op === 'enqueue' ? pending.originalInput : ''});
    if (pending) clearTimeout(pending.timer); pending = null; owner = identity(); queueEpoch = ''; revision = -1; items = []; active = ''; uncertain = false; capture = null;
    sentQueued.clear(); confirmed.clear(); started.clear(); settled.clear(); retired.clear(); steering.clear(); recoverText = ''; restore.hidden = true; closeMore(); closeEditor(); notice('');
    if (clearPeer) { peerEpoch++; caps = []; peerFP = ''; }
    render();
  }
  function sync() { if (owner !== identity()) reset(); }
  function updateButton() {
    if (!nativeBusy()) { send.setAttribute('aria-label', send.title || '发送'); return; }
    const enqueue = !!input.value.trim(); send.title = enqueue ? '加入队列' : '停止'; send.setAttribute('aria-label', send.title); send.classList.toggle('stop', !enqueue);
    send.innerHTML = enqueue ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h10M4 11h10M4 16h6M18 12v8m-3-3 3 3 3-3"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  }
  function render() {
    if (!more.hidden) closeMore();
    rows.replaceChildren(); panel.hidden = !items.length || typeof localMode === 'undefined' || !localMode;
    for (const [index, item] of items.entries()) {
      const row = node('div', 'hw-queue-row'), icon = node('span', 'hw-queue-order'); icon.setAttribute('aria-label', '第 ' + (index + 1) + ' 条'); icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 4v12a2 2 0 0 0 2 2h12M9 7h10M9 11h10M9 15h6"/></svg>'; row.appendChild(icon);
      const copy = node('span', 'hw-queue-copy', item.msg); copy.title = item.msg; row.appendChild(copy);
      const steer = button('引导当前运行', '↪'); steer.className += ' hw-queue-steer'; steer.appendChild(node('span', '', '引导')); steer.disabled = !!pending || uncertain || !active || !ready(); steer.addEventListener('click', () => request('steer', item.id, {target_run_id: active})); row.appendChild(steer);
      const remove = button('删除队列消息'); remove.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6h16M9 6V3h6v3M6 6l1 14h10l1-14M10 10v6M14 10v6"/></svg>'; remove.disabled = !!pending || uncertain || !ready(); remove.addEventListener('click', () => request('remove', item.id)); row.appendChild(remove);
      const toggle = button('更多队列操作', '⋯'); toggle.disabled = !!pending || uncertain || !ready(); toggle.setAttribute('aria-haspopup', 'menu'); toggle.addEventListener('click', () => {
        if (toggle.disabled) return; menuItem = {id: item.id, revision, queueEpoch, owner, peerEpoch}; menuAnchor = toggle; toggle.setAttribute('aria-expanded', 'true'); more.hidden = false;
        if (toggle.getBoundingClientRect) { const r = toggle.getBoundingClientRect(); more.style.left = Math.max(12, Math.min(r.right - 132, window.innerWidth - 144)) + 'px'; more.style.top = Math.max(12, r.top - 78) + 'px'; }
        editAction.focus();
      }); row.appendChild(toggle); rows.appendChild(row);
    }
    save.disabled = !!pending || uncertain || !edit || edit.owner !== identity() || edit.peerEpoch !== peerEpoch || edit.revision !== revision || edit.queueEpoch !== queueEpoch;
    refresh.disabled = !!pending || !ready(); restore.disabled = !!input.value; restore.title = input.value ? '请先保留当前输入，再恢复未应用的引导' : '只填入输入框，由你决定是否发送'; updateButton();
  }
  function request(op, queueID = '', extra = {}) {
    sync(); if (!ready() || pending || op !== 'list' && (uncertain || !queueEpoch || !items.some(i => i.id === queueID))) return false;
    const ticket = {id: freshID(), op, queueID, owner, peerEpoch, revision, queueEpoch, ...extra}; pending = ticket;
    ticket.timer = setTimeout(() => { if (pending !== ticket || ticket.owner !== identity() || ticket.peerEpoch !== peerEpoch) return; pending = null; uncertain = op !== 'list' || uncertain; notice(op === 'list' ? '队列读取超时，请刷新。' : '队列操作结果未知；请刷新核对，不会自动重试。'); if (edit) feedback.textContent = status.textContent; render(); }, 12000);
    if (op === 'steer') steering.set(queueID, {owner, peerEpoch, queueEpoch, target: extra.target_run_id, msg: items.find(i => i.id === queueID).msg, noted: false});
    const sent = sendFrame({k: 'agent-queue', id: ticket.id, queue_op: op, queue_id: queueID, session_key: session(), queue_epoch: queueEpoch, expected_revision: Math.max(0, revision), ...(op !== 'list' ? {target_run_id: active} : {}), ...extra});
    if (!sent) { clearTimeout(ticket.timer); if (pending === ticket) pending = null; if (op === 'steer') steering.delete(queueID); notice('没有连上电脑，队列没有修改；草稿已保留。'); if (edit) feedback.textContent = status.textContent; render(); return false; }
    render(); return true;
  }
  function handover(run) {
    const sent = sentQueued.get(run);
    if (!run || run === localRunID || !settled.has(localRunID) || !confirmed.has(run) || !sent || sent.owner !== identity() || sent.peerEpoch !== peerEpoch || started.has(run)) return;
    const links = window.HandwaveLinks, memory = window.HandwaveMemoryTransport, binding = {fp: peerFP, session_key: session()}, previous = localRunID;
    if (!links || !memory || !links.canAdoptQueuedRun || !memory.canAdoptQueuedRun || !links.canAdoptQueuedRun(run, previous, binding) || !memory.canAdoptQueuedRun(run, previous, binding)) { notice('电脑已启动队列任务；当前页面无法核对运行归属，请刷新队列并检查任务收据。'); return; }
    if (!links.adoptQueuedRun(run, previous, binding) || !memory.adoptQueuedRun(run, previous, binding)) { notice('运行归属已变化，请核对电脑任务；不会重复发送。'); return; }
    retired.add(previous); started.add(run); localRunID = run; localBusy = true; sending = true;
    if (typeof stopRequested !== 'undefined') stopRequested = false; if (typeof localAnswer !== 'undefined') localAnswer = ''; if (typeof localPhase !== 'undefined') localPhase = '准备中'; if (typeof localObjective !== 'undefined') localObjective = sent.msg;
    if (typeof pendingAsk !== 'undefined') pendingAsk = null; if (typeof localTasks !== 'undefined') localTasks.clear();
    if (!sent.noted) { sent.noted = true; if (typeof addBubble === 'function') addBubble('user', sent.msg); if (typeof noteSession === 'function') noteSession('user', sent.msg); }
    if (typeof resetAgentRun === 'function') resetAgentRun(run); if (typeof beginAssistant === 'function') localStream = beginAssistant(); if (typeof startLocalTick === 'function') startLocalTick(); if (typeof setSendUI === 'function') setSendUI(true);
  }
  function acceptSnapshot(frame) {
    if (!ready() || typeof frame.ok !== 'boolean' || frame.session_key !== session() || typeof frame.queue_epoch !== 'string' || !frame.queue_epoch || !Number.isSafeInteger(frame.revision) || frame.revision < 0 || !Array.isArray(frame.items) || frame.items.length > 16 || typeof frame.active_run_id !== 'string') return;
    const correlated = pending && frame.id === pending.id && pending.owner === identity() && pending.peerEpoch === peerEpoch;
    if (frame.ok === false || frame.error) {
      if (correlated) { clearTimeout(pending.timer); if (pending.op === 'enqueue') sentQueued.delete(pending.queueID); pending = null; notice('队列操作被拒绝：' + String(frame.error || '电脑拒绝操作').slice(0, 240)); if (edit) feedback.textContent = status.textContent; render(); }
      return;
    }
    if (!queueEpoch && !(correlated && pending.op === 'list')) return;
    if (queueEpoch && queueEpoch !== frame.queue_epoch || frame.revision < revision) return;
    const seen = new Set(); for (const item of frame.items) { if (!item || typeof item.id !== 'string' || !item.id || bytes(item.id) > 256 || seen.has(item.id) || typeof item.msg !== 'string' || bytes(item.msg) > 8192) return; seen.add(item.id); }
    queueEpoch = frame.queue_epoch; revision = frame.revision; items = frame.items.map(i => ({id: i.id, msg: i.msg})); active = frame.active_run_id;
    for (const item of items) {
      const sent = sentQueued.get(item.id);
      if (sent && sent.owner === identity() && sent.peerEpoch === peerEpoch) {
        confirmed.add(item.id); sent.unresolved = false; sent.msg = item.msg;
        if (sent.generation === generation && input.value === sent.originalInput) { input.value = ''; input.dispatchEvent(new Event('input', {bubbles: true})); }
      }
    }
    if (pending && pending.op === 'enqueue' && (confirmed.has(pending.queueID) && (items.some(i => i.id === pending.queueID) || active === pending.queueID))) {
      const submitted = pending; clearTimeout(submitted.timer); pending = null;
      if (submitted.generation === generation && input.value === submitted.originalInput) { input.value = ''; input.dispatchEvent(new Event('input', {bubbles: true})); }
      notice('');
    } else if (correlated) {
      const submitted = pending; clearTimeout(submitted.timer); pending = null;
      if (frame.ok === false || frame.error) { uncertain = submitted.op !== 'list'; notice('队列操作未确认：' + String(frame.error || '电脑拒绝操作').slice(0, 240)); if (edit) feedback.textContent = status.textContent; }
      else {
        uncertain = Array.from(sentQueued.values()).some(s => s.unresolved);
        if (submitted.op === 'edit') closeEditor(); notice(uncertain ? '消息不在当前队列中，可能已经开始或结束；请核对任务收据，不会重复发送。' : submitted.op === 'steer' ? '引导已提交，等待当前运行回执。' : submitted.op === 'remove' ? '队列消息已删除，未执行。' : submitted.op === 'edit' ? '队列消息已保存，等待执行。' : '');
      }
    }
    handover(active); render();
  }
  editAction.addEventListener('click', () => {
    const m = menuItem; closeMore(); if (!m || m.owner !== identity() || m.peerEpoch !== peerEpoch || m.queueEpoch !== queueEpoch || m.revision !== revision) return;
    const row = items.find(i => i.id === m.id); if (!row) return; edit = m; text.value = row.msg; feedback.textContent = ''; render(); dialog.showModal(); text.focus();
  });
  frontAction.addEventListener('click', () => { const m = menuItem; closeMore(); if (m && m.owner === identity() && m.peerEpoch === peerEpoch && m.queueEpoch === queueEpoch && m.revision === revision) request('front', m.id); });
  form.addEventListener('submit', event => { event.preventDefault(); if (!edit || save.disabled) return; const msg = text.value.trim(); if (!msg || bytes(msg) > 8192) { feedback.textContent = '请输入消息，最多 8 KiB。'; return; } request('edit', edit.id, {msg}); });
  cancel.addEventListener('click', closeEditor); dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); closeEditor(); });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeEditor(); } else if ((event.ctrlKey || event.metaKey) && ['n', '/'].includes(event.key.toLowerCase())) event.stopPropagation(); });
  more.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMore(true); return; }
    if (event.key === 'Tab') { closeMore(true); return; } // Native Tab proceeds from the original trigger.
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const choices = [editAction, frontAction].filter(action => !action.disabled), index = choices.indexOf(document.activeElement);
    if (choices.length) choices[(index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length].focus();
  });
  document.addEventListener('pointerdown', event => { if (!more.hidden && !more.contains(event.target) && !(menuAnchor && menuAnchor.contains(event.target))) closeMore(); });
  dismiss.addEventListener('click', () => notice('')); refresh.addEventListener('click', () => request('list'));
  restore.addEventListener('click', () => { if (!recoverText || input.value || restore.disabled) return; input.value = recoverText; recoverText = ''; restore.hidden = true; input.dispatchEvent(new Event('input', {bubbles: true})); input.focus(); notice('已恢复到输入框；请核对后决定是否发送。'); });
  input.addEventListener('input', () => { generation++; restore.disabled = !!input.value; restore.title = input.value ? '请先保留当前输入，再恢复未应用的引导' : '只填入输入框，由你决定是否发送'; updateButton(); });
  input.addEventListener('keydown', event => { if (!nativeBusy() || typeof isCoarsePointer === 'function' && isCoarsePointer() || event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return; event.preventDefault(); event.stopImmediatePropagation(); if (input.value.trim()) void sendChat(); }, true);
  const oldClick = send.onclick; send.onclick = function(event) { if (nativeBusy() && input.value.trim()) { void sendChat(); return; } if (oldClick) return oldClick.call(this, event); };
  const oldSend = sendChat;
  const oldBubble = typeof addBubble === 'function' ? addBubble : null;
  if (oldBubble) addBubble = function(role, value) { if (capture && (role === 'user' && value === capture.originalInput.trim() || role === 'system' && value === '已交给本机调度：' + capture.originalInput.trim())) return; return oldBubble.apply(this, arguments); };
  const oldNote = typeof noteSession === 'function' ? noteSession : null;
  if (oldNote) noteSession = function(role, value) { if (capture && role === 'user' && value === capture.originalInput.trim()) return; return oldNote.apply(this, arguments); };
  sendChat = function() {
    sync();
    if (typeof localMode !== 'undefined' && localMode && ready() && !nativeBusy() && (!queueEpoch || active && !started.has(active))) { if (!pending && !queueEpoch) request('list'); notice(!queueEpoch ? '正在核对电脑队列，请稍后发送；输入已保留。' : '电脑已有任务，当前页面未取得其运行归属；请从目标控制观察或停止后再发送。'); return; }
    if (!nativeBusy() || !input.value.trim()) return oldSend.apply(this, arguments);
    if (!ready()) { notice('当前节点尚未支持消息队列，请更新被控端后重新接入；输入已保留。'); return; }
    if (pending || uncertain || !queueEpoch) { if (!pending && !queueEpoch) request('list'); notice(uncertain ? '上次操作结果未知，请先刷新核对队列。' : '正在核对队列，请稍后发送；输入已保留。'); return; }
    if (bytes(input.value.trim()) > 8192) { notice('队列消息最多 8 KiB，请缩短后再发送；输入已保留。'); return; }
    const ticket = {owner, peerEpoch, originalInput: input.value, generation}; capture = ticket;
    try { return oldSend.apply(this, arguments); }
    finally { capture = null; if (ticket.owner === identity() && ticket.peerEpoch === peerEpoch && ticket.generation === generation && input.value === '') input.value = ticket.originalInput; updateButton(); }
  };
  const oldSendFrame = sendFrame;
  sendFrame = function(frame) {
    sync(); const enqueue = capture && frame && frame.k === 'agent-loop' && frame.id !== localRunID;
    let ticket = null;
    if (enqueue) {
      ticket = {id: frame.id, queueID: frame.id, op: 'enqueue', ...capture}; pending = ticket;
      sentQueued.set(frame.id, {...capture, msg: frame.msg, unresolved: true});
      ticket.timer = setTimeout(() => { if (pending !== ticket || ticket.owner !== identity() || ticket.peerEpoch !== peerEpoch) return; pending = null; uncertain = true; notice('消息是否入队尚未确认；请刷新核对，不会重复发送。'); render(); }, 12000);
    }
    const sent = oldSendFrame.apply(this, arguments);
    if (ticket && !sent) { clearTimeout(ticket.timer); if (pending === ticket) pending = null; sentQueued.delete(frame.id); notice('消息没有发送，输入已保留。'); }
    if (sent && frame && frame.k === 'agent-loop' && frame.id === localRunID) { started.add(frame.id); if (ready() && !queueEpoch && !pending) request('list'); }
    return sent;
  };
  const oldFrame = onFrame;
  onFrame = function(frame) {
    sync();
    if (frame && frame.k === 'node-hello') { reset(true); peerFP = frame.fp || ''; caps = frame.info && Array.isArray(frame.info.caps) ? frame.info.caps : []; const result = oldFrame.apply(this, arguments); if (ready()) request('list'); return result; }
    if (frame && frame.k === 'agent-queue-state') { acceptSnapshot(frame); return; }
    if (frame && frame.k === 'agent-queue-steer-state') {
      const receipt = steering.get(frame.queue_id);
      if (receipt && receipt.owner === identity() && receipt.peerEpoch === peerEpoch && receipt.queueEpoch === frame.queue_epoch && frame.session_key === session() && receipt.target === frame.target_run_id) {
        const labels = {submitted: '引导已提交，等待当前运行回执。', applied: '引导已加入对应运行的上下文，尚未确认模型读取。', unapplied: '引导未应用；可恢复草稿后重新核对。'};
        if (frame.status === 'applied' && !receipt.noted) { receipt.noted = true; if (oldBubble) oldBubble('user', receipt.msg); if (oldNote) oldNote('user', receipt.msg); }
        if (frame.status === 'unapplied') { recoverText = receipt.msg; restore.hidden = false; restore.disabled = !!input.value; }
        if (labels[frame.status]) notice(labels[frame.status]);
      } return;
    }
    if (frame && ['agent-event', 'out'].includes(frame.k)) {
      if (retired.has(frame.id)) return;
      if (pending && pending.op === 'enqueue' && frame.id === pending.queueID && (frame.k === 'agent-event' && frame.event && frame.event.type === 'agent_end' && ['failed', 'canceled'].includes(frame.event.status) || frame.k === 'out' && frame.done && frame.err)) { clearTimeout(pending.timer); sentQueued.delete(pending.queueID); pending = null; notice('电脑未接纳这条队列消息；原输入已保留。'); render(); return; }
      if (sentQueued.has(frame.id) && !started.has(frame.id)) return;
    }
    const ending = frame && frame.k === 'out' && frame.done && frame.id === localRunID && started.has(frame.id) && ready() ? frame.id : '';
    const result = oldFrame.apply(this, arguments);
    // A cancellation may announce the next active Run before the previous
    // terminal packets drain. Let the legacy owner finalize that stream first.
    if (ending) { settled.add(ending); if (localRunID === ending) handover(active); render(); }
    return result;
  };
  if (typeof onSig === 'function') { const original = onSig; onSig = function(signal) { if (signal && ['paired', 'unpaired', 'pair-fail'].includes(signal.k)) reset(true); return original.apply(this, arguments); }; }
  if (typeof sendSig === 'function') { const original = sendSig; sendSig = function(signal) { if (signal && ['bye', 'hello'].includes(signal.k)) reset(true); return original.apply(this, arguments); }; }
  for (const name of ['selectSession', 'selectWorkspace']) { const original = name === 'selectSession' ? selectSession : selectWorkspace; const wrapped = function() { const result = original.apply(this, arguments); sync(); render(); if (ready()) request('list'); return result; }; if (name === 'selectSession') selectSession = wrapped; else selectWorkspace = wrapped; }
  if (typeof setSendUI === 'function') { const original = setSendUI; setSendUI = function() { const result = original.apply(this, arguments); updateButton(); return result; }; }
  window.HandwaveQueue = Object.freeze({refresh: () => request('list'), state: () => ({owner, peerEpoch, queueEpoch, revision, activeRun: active, items: items.map(i => ({...i})), pending: pending && {id: pending.id, op: pending.op}, uncertain})});
  render();
})();
