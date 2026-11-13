/* Recover observation and human drafts. Never replay requests or grant access. */
(() => {
  'use strict';
  if (window.HandwaveRecovery || typeof connectHub !== 'function' || typeof WebSocket === 'undefined') return;
  const input = document.getElementById('input'), scope = () => JSON.stringify([curWS && curWS.id || '', curWS && curWS.device_fp || '', curSess && curSess.id || '', typeof myFP === 'string' ? myFP : '']);
  const node = (tag, cls, value) => { const e = document.createElement(tag); if (cls) e.className = cls; if (value != null) e.textContent = value; return e; };
  const button = value => { const b = node('button', 'hw-memory-button', value); b.type = 'button'; return b; };
  const key = 'handwave.recovery.v1', ttl = 6 * 60 * 60 * 1000, maxEntries = 24, maxStoredBytes = 256 * 1024;
  const byteSize = value => new TextEncoder().encode(value).length;
  let entries = [], storageFailed = false, memoryOnly = false, draftSerial = 0, serial = 0, socket = null, dialTimer = null, retryTimer = null, pulseTimer = null, attempts = 0, lastStatus = 0, phase = 'idle', lastNotice = '', authBlocked = false, interruptedScope = '', interruptedRun = '', submitted = null, reconnectTarget = null, observedPeer = null, autoTargetTried = false, observationBlocked = '', needsObservation = false, recovering = false;
  const batches = new Set(), fences = new WeakMap(), nativeOwners = new Map();
  if (typeof AGENT_STATUS !== 'undefined') AGENT_STATUS.interrupted = '结果待核对';
  let authProbe = null, lastAuthProbe = -Infinity;
  const toast = node('section', 'hw-recovery-toast'); toast.setAttribute('aria-label', '连接与恢复'); toast.hidden = true;
  const message = node('span'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite'); toast.appendChild(message);
  const reconnect = button('重新连接'), restore = button('恢复保留内容'), login = button('前往登录'), dismiss = button('×'); dismiss.className += ' hw-recovery-dismiss'; dismiss.setAttribute('aria-label', '关闭恢复提示');
  const recoveryActions = node('div', 'hw-recovery-actions'); recoveryActions.appendChild(reconnect); recoveryActions.appendChild(restore); recoveryActions.appendChild(login); recoveryActions.appendChild(dismiss); toast.appendChild(recoveryActions);
  const composer = document.querySelector('.composer');
  if (composer && typeof composer.insertBefore === 'function') composer.insertBefore(toast, composer.firstChild); else document.body.appendChild(toast);
  const dialog = node('dialog', 'hw-recovery-dialog'); const title = node('h2', '', '保留的内容'); title.id = 'hwRecoveryTitle'; dialog.setAttribute('aria-labelledby', title.id); dialog.appendChild(title); dialog.appendChild(node('p', 'hw-context-hint', '仅恢复当前操作端、电脑和会话的文字；不会恢复队列、重放请求或确认任务结果。'));
  const list = node('div'); dialog.appendChild(list); const close = button('关闭'); dialog.appendChild(close); document.body.appendChild(dialog);
  function prune() { const now = Date.now(); entries = entries.filter(e => e && typeof e.scope === 'string' && e.scope.length <= 2048 && typeof e.kind === 'string' && e.kind.length <= 100 && typeof e.text === 'string' && e.text && Number.isFinite(e.at) && now - e.at >= 0 && now - e.at <= ttl).slice(-maxEntries); }
  function persist() {
    prune(); const durable = []; let size = 0; memoryOnly = false;
    for (let i = entries.length - 1; i >= 0; i--) { const e = entries[i], bytes = byteSize(JSON.stringify(e)); if (size + bytes > maxStoredBytes) { memoryOnly = true; continue; } durable.unshift(e); size += bytes; }
    try { sessionStorage.setItem(key, JSON.stringify({version: 1, entries: durable})); storageFailed = false; } catch (_) { storageFailed = true; }
  }
  try { const raw = sessionStorage.getItem(key); if (raw && byteSize(raw) <= maxStoredBytes + 4096) { const saved = JSON.parse(raw); if (saved && saved.version === 1 && Array.isArray(saved.entries)) entries = saved.entries; } } catch (_) { storageFailed = true; } prune();
  function remember(kind, value, owner = scope()) { if (typeof value !== 'string' || !value.trim() || typeof owner !== 'string') return; entries = entries.filter(e => !(e.scope === owner && e.kind === kind && e.text === value)); entries.push({id: 'draft-' + (++draftSerial) + '-' + Date.now(), scope: owner, kind, text: value, at: Date.now()}); persist(); render(); }
  function available() { prune(); return entries.filter(e => e.scope === scope()); }
  function render() { restore.hidden = !available().length; login.hidden = !authBlocked; reconnect.hidden = authBlocked; reconnect.disabled = phase === 'connecting'; }
  function tell(reason, text) { if (reason === lastNotice && !toast.hidden) return; lastNotice = reason; message.textContent = text + (storageFailed || memoryOnly ? ' 部分内容仅保留在当前页，刷新后无法保证恢复。' : ''); toast.hidden = false; render(); }
  function heldDrafts() { if (input) remember('输入草稿', input.value); if (submitted && (sending || localBusy)) remember('发送结果待核对的消息', submitted.text, submitted.owner); }
  function interrupted(messageText) { const e = new Error(messageText || '连接中断，操作结果待核对；不会自动重试。'); e.name = 'RecoveryInterrupted'; return e; }
  function checkToolFence(base, card, content) {
    const fence = base && fences.get(base); if (!fence || !authBlocked && (!fence.requiresController || !fence.failed && fence.owner === scope())) return;
    const error = interrupted();
    if (card) { card.setOut((content || '') + '\n\n' + error.message); card.finish(false, '结果待核对'); }
    throw error;
  }
  function settleForeground(reason, emitDisconnect = true) {
    heldDrafts(); for (const fence of batches) if (fence.requiresController) fence.failed = true;
    const hadLocal = typeof localBusy !== 'undefined' && localBusy;
    const invalidate = paired || helloDone || hadLocal || typeof toolSess !== 'undefined' && toolSess.size;
    if (hadLocal || typeof localStream !== 'undefined' && localStream) {
      const originalOwner = nativeOwners.get(localRunID) || '';
      interruptedScope = originalOwner; interruptedRun = typeof localRunID === 'string' ? localRunID : '';
      if (originalOwner && typeof localAnswer === 'string' && localAnswer) remember('部分输出（只读）', localAnswer, originalOwner);
      if (originalOwner && typeof pendingLocalRetry === 'string' && pendingLocalRetry) remember('未重放的重试草稿', pendingLocalRetry, originalOwner);
      if (typeof localStream !== 'undefined' && localStream) { try { localStream.finalize(null); } catch (_) {} localStream = null; }
      localBusy = false; sending = false; localAnswer = ''; pendingLocalRetry = ''; pendingAsk = null; localPhase = '连接中断 · 结果待核对';
      if (typeof stopLocalTick === 'function') stopLocalTick(); if (typeof updateTaskDurations === 'function') updateTaskDurations();
      if (typeof agentRun !== 'undefined') { const local = agentRun.agents && agentRun.agents.get('local'); if (local) { local.status = 'interrupted'; local.detail = reason; } }
      if (window.HandwaveContextInterrupted) window.HandwaveContextInterrupted({owner: originalOwner, run: interruptedRun});
      if (typeof renderAgentDock === 'function') renderAgentDock(); if (typeof setSendUI === 'function') setSendUI(false);
    }
    if (typeof toolSess !== 'undefined') for (const [id, operation] of Array.from(toolSess.entries())) {
      const release = operation.gotReady;
      try { if (operation.settle) operation.settle({id, done: true, code: -1, err: '连接中断，操作效果未知；请先核对电脑状态，不会自动重试。', recovery_interrupted: true}); } catch (_) {}
      toolSess.delete(id); if (typeof activeWork !== 'undefined') activeWork.delete(id); if (release) { try { release(); } catch (_) {} }
    }
    paired = false; helloDone = false; if (typeof closePC === 'function') closePC();
    if (window.HandwaveMachineTransportLost) window.HandwaveMachineTransportLost();
    // Invalidate connection-local queue and permission ledgers through their
    // existing disconnect path. This is not a native task terminal or cancel.
    if (emitDisconnect && invalidate && typeof onSig === 'function') onSig({k: 'unpaired', err: reason, recovery_local: true});
  }
  function clearTimers() { clearTimeout(dialTimer); clearTimeout(retryTimer); clearInterval(pulseTimer); dialTimer = retryTimer = pulseTimer = null; clearInterval(pollTimer); pollTimer = null; }
  function online() { return typeof navigator === 'undefined' || navigator.onLine !== false; }
  function schedule() {
    if (authBlocked || retryTimer || !online()) return;
    const delay = Math.min(20000, 500 * 2 ** Math.min(attempts++, 6)) * (.8 + Math.random() * .4);
    retryTimer = setTimeout(() => { retryTimer = null; connectHub(); }, delay);
  }
  function probeAuthentication(generation, owner) {
    if (authBlocked || authProbe || Date.now() - lastAuthProbe < 15000 || !online()) return;
    const probe = {generation, owner, ctl: new AbortController()}; authProbe = probe; lastAuthProbe = Date.now();
    const timeout = new Promise(resolve => { probe.timer = setTimeout(() => { probe.ctl.abort(); resolve(null); }, 4000); });
    Promise.race([Promise.resolve().then(() => fetch('/handwave/api/workspaces', {method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: {'Accept': 'application/json'}, signal: probe.ctl.signal})), timeout]).then(response => {
      if (authProbe === probe && generation === serial && owner === scope() && response && response.status === 401) authRequired();
    }).catch(() => {}).finally(() => { clearTimeout(probe.timer); if (authProbe === probe) authProbe = null; });
  }
  function lose(current, generation, reason) {
    if (current !== socket || generation !== serial) return;
    socket = null; if (ws === current) ws = null; serial++; clearTimers();
    try { current.close(); } catch (_) {}
    reconnectTarget = observedPeer && observedPeer.owner === scope() && observedPeer.fp === (curWS && curWS.device_fp || '') ? {owner: observedPeer.owner, fp: observedPeer.fp} : null; autoTargetTried = false; observationBlocked = ''; needsObservation = true;
    settleForeground(reason); phase = online() ? 'retrying' : 'offline'; setConnState(online() ? '连接中断 · 正在重连' : '网络离线 · 等待恢复', 'off');
    tell('transport-lost', '连接中断，已保留当前文字和可归属的部分输出。操作结果待核对；重新连接不会重发任务。'); probeAuthentication(serial, scope()); schedule();
  }
  function sendControl(current, generation, packet) {
    try { if (sendSig(packet)) return true; } catch (_) {}
    lose(current, generation, 'Hub 消息发送失败'); return false;
  }
  connectHub = function() {
    if (authBlocked || !online() || socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(retryTimer); retryTimer = null; const generation = ++serial; phase = 'connecting'; setConnState('正在连接 Hub', 'busy'); render();
    let current; try { current = new WebSocket(wsURL(), 'handwave'); } catch (_) { phase = 'retrying'; tell('dial-error', '连接尚未建立，正在重试；未发送任何任务。'); schedule(); return; }
    socket = current; ws = current;
    dialTimer = setTimeout(() => lose(current, generation, '连接建立超时'), 8000);
    current.onopen = () => {
      if (current !== socket || generation !== serial) return; clearTimeout(dialTimer); dialTimer = null; phase = 'hub'; lastStatus = Date.now();
      setConnState('Hub 已连接 · 设备未接入', 'on'); if (!sendControl(current, generation, {k: 'hello', fp: myFP, relay: true}) || !sendControl(current, generation, {k: 'status'})) return;
      pulseTimer = setInterval(() => { if (current !== socket || generation !== serial) return; if (Date.now() - lastStatus >= 20000) { lose(current, generation, 'Hub 心跳未确认'); return; } sendControl(current, generation, {k: 'status'}); }, 5000); render();
    };
    current.onmessage = event => {
      if (current !== socket || generation !== serial) return;
      let packet; try { packet = JSON.parse(event.data); } catch (_) { return; }
      if (packet && packet.k === 'status') { lastStatus = Date.now(); attempts = 0; }
      onSig(packet);
      if (packet && packet.k === 'status') restoreObservation(packet);
    };
    current.onclose = () => lose(current, generation, 'Hub 连接已关闭');
    current.onerror = () => lose(current, generation, 'Hub 连接错误');
  };
  function restoreObservation(packet) {
    const target = reconnectTarget;
    if (!needsObservation || autoTargetTried) return;
    if (!target || target.owner !== scope() || !target.fp) { autoTargetTried = true; tell('manual-device', 'Hub 已连接；当前会话未核验原设备，请从工具与连接重新接入。任务不会自动重发。'); return; }
    if (!Array.isArray(packet.hub_caps) || !packet.hub_caps.includes('connect-approved-v1') || typeof window.HandwaveMachineTarget !== 'function') { autoTargetTried = true; tell('manual-device', 'Hub 已连接；请从工具与连接核对并重新接入原设备，任务不会自动重发。'); return; }
    const device = (typeof devices !== 'undefined' && Array.isArray(devices) ? devices : []).find(d => d.fp === target.fp);
    if (!device) { tell('device-waiting', 'Hub 已连接；原设备尚未出现在列表中，等待上线。请核对设备在线状态与现有授权，任务不会自动重发。'); return; }
    const owned = device.by === myFP || device.mine === true && !device.by;
    const granted = owned && typeof device.exp === 'string' && Number.isFinite(Date.parse(device.exp)) && Date.parse(device.exp) > Date.now();
    if (!granted || !['approved', 'paired', 'approved-offline'].includes(device.state)) { autoTargetTried = true; tell('device-unavailable', 'Hub 已连接；原设备的现有授权无法确认。请在工具与连接核对，任务不会自动重发。'); return; }
    if (device.state === 'approved-offline') { tell('device-waiting', 'Hub 已连接；等待原电脑上线，随后核验既有授权。任务不会自动重发。'); return; }
    if (localBusy || sending) { tell('device-waiting', 'Hub 已连接；当前操作仍在进行，稍后核验原设备的既有授权。任务不会自动重发。'); return; }
    const candidate = JSON.stringify([target.owner, device.nid, device.fp, device.state, device.exp, device.by, device.mine]);
    if (candidate === observationBlocked) return;
    if (window.HandwaveMachineTarget(device)) { autoTargetTried = true; tell('device-observing', 'Hub 已连接，正在核验原设备的既有授权；仅恢复观察，不重发任务。'); }
    else { observationBlocked = candidate; tell('manual-device', 'Hub 已连接；原设备暂未确认接入，请从工具与连接核对。任务不会自动重发。'); }
  }
  function confirmObservation() {
    if (authBlocked || !observedPeer || observedPeer.owner !== scope() || !paired || !helloDone) return;
    needsObservation = false; observationBlocked = '';
    if (!toast.hidden && ['transport-lost', 'device-lost', 'device-unavailable', 'device-waiting', 'device-observing', 'manual-device', 'dial-error', 'offline'].includes(lastNotice)) {
      tell('connection-restored', '设备已重新接入，可发送新任务。此前操作结果仍待核对；不会自动重发。');
    }
  }

  function authRequired() { if (authBlocked) return; heldDrafts(); authBlocked = true; clearTimers(); if (socket) { const old = socket; socket = null; ws = null; serial++; try { old.close(); } catch (_) {} } settleForeground('登录已过期'); phase = 'auth'; setConnState('登录已过期', 'off'); tell('auth', '登录已过期，文字已保留。请完成 Ray 验证后回到当前会话；不会重新发送。'); }
  function streamIncomplete(reason) { heldDrafts(); tell('stream-interrupted', reason || '回复连接提前结束，部分输出已保留；结果未确认，请核对后再决定是否继续。'); return interrupted(reason); }
  const validDone = value => value && typeof value === 'object' && !Array.isArray(value) && typeof value.content === 'string' && typeof value.turn_id === 'string' && !!value.turn_id && (!value.tool_calls || Array.isArray(value.tool_calls)) && (!value.clarify || Array.isArray(value.clarify));
  const receiveFrame = onFrame; onFrame = function(frame) {
    const before = scope(), result = receiveFrame.apply(this, arguments);
    if (frame && frame.k === 'node-hello' && typeof frame.fp === 'string' && frame.fp && before === scope() && paired && helloDone) {
      observedPeer = {fp: frame.fp, owner: JSON.stringify([curWS && curWS.id || '', frame.fp, curSess && curSess.id || '', typeof myFP === 'string' ? myFP : ''])};
      confirmObservation();
    }
    return result;
  };
  if (typeof syncRailDeviceLabels === 'function') { const original = syncRailDeviceLabels; syncRailDeviceLabels = function() { const result = original.apply(this, arguments); confirmObservation(); return result; }; }
  const originalFrame = sendFrame; sendFrame = function(frame) {
    const owner = scope(), result = originalFrame.apply(this, arguments);
    if (result && frame && frame.k === 'agent-loop' && typeof frame.id === 'string') {
      nativeOwners.set(frame.id, owner);
      if (nativeOwners.size > 64) { const oldest = Array.from(nativeOwners.keys()).find(id => id !== localRunID); if (oldest) nativeOwners.delete(oldest); }
      if (submitted && typeof frame.msg === 'string' && submitted.text.trim() === frame.msg.trim()) submitted.owner = owner;
    }
    return result;
  };
  const oldSend = sendChat; sendChat = function() { if (input && input.value.trim()) submitted = {owner: scope(), text: input.value}; return oldSend.apply(this, arguments); };
  if (typeof runToolCalls === 'function') { const original = runToolCalls; runToolCalls = async function(calls, base) { const fence = {owner: scope(), requiresController: calls.some(c => ['exec', 'read_file', 'write_file', 'run_node_task'].includes(c.function && c.function.name)), failed: false}; fences.set(base, fence); batches.add(fence); try { return await original.apply(this, arguments); } finally { batches.delete(fence); } }; }
  const oldSig = onSig; onSig = function(packet) {
    if (packet && ['unpaired', 'pair-fail'].includes(packet.k) && !packet.recovery_local && !recovering) { recovering = true; try { settleForeground(packet.err || '设备连接已结束', false); } finally { recovering = false; } tell('device-lost', '设备连接已结束，当前操作结果待核对；文字已保留，请重新接入原设备。'); }
    return oldSig.apply(this, arguments);
  };
  const oldMeta = typeof liveDockMeta === 'function' ? liveDockMeta : null; if (oldMeta) liveDockMeta = function() { if (interruptedScope === scope() && interruptedRun === localRunID && !localBusy) return '连接中断 · 结果待核对'; return oldMeta.apply(this, arguments); };
  for (const name of ['selectWorkspace', 'selectSession']) { const original = name === 'selectWorkspace' ? selectWorkspace : selectSession; const wrapped = function() { const result = original.apply(this, arguments); render(); return result; }; if (name === 'selectWorkspace') selectWorkspace = wrapped; else selectSession = wrapped; }
  const manual = document.getElementById('btnReconnect'); const reconnectNow = () => { if (authBlocked) { tell('auth', '登录已过期，请先完成 Ray 验证。'); return; } attempts = 0; if (socket) { const old = socket; lose(old, serial, '手动重新连接'); } connectHub(); }; if (manual) { manual.disabled = false; manual.onclick = reconnectNow; } reconnect.addEventListener('click', reconnectNow);
  login.addEventListener('click', () => { heldDrafts(); persist(); location.href = '/ray/login?next=%2Fhandwave%2F'; }); dismiss.addEventListener('click', () => { toast.hidden = true; });
  restore.addEventListener('click', () => {
    list.replaceChildren(); for (const entry of available()) { const section = node('section'); section.appendChild(node('b', '', entry.kind)); section.appendChild(node('pre', '', entry.text)); if (!entry.kind.includes('只读')) { const adopt = button('恢复到输入框'); adopt.disabled = !!(input && input.value); adopt.title = adopt.disabled ? '请先保留当前输入，恢复不会覆盖新草稿。' : '仅填入文字，不自动发送'; adopt.addEventListener('click', () => { if (entry.scope !== scope() || !input || input.value) return; input.value = entry.text; input.dispatchEvent(new Event('input', {bubbles: true})); dialog.close(); input.focus(); }); section.appendChild(adopt); } list.appendChild(section); } dialog.showModal();
  });
  close.addEventListener('click', () => dialog.close()); dialog.addEventListener('cancel', e => { e.preventDefault(); e.stopPropagation(); dialog.close(); }); dialog.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dialog.close(); } else if ((e.ctrlKey || e.metaKey) && ['n', '/'].includes(e.key.toLowerCase())) e.stopPropagation(); });
  window.addEventListener('offline', () => { if (socket) lose(socket, serial, '网络已离线'); else { clearTimeout(retryTimer); retryTimer = null; phase = 'offline'; tell('offline', '网络已离线，等待网络恢复；当前文字已保留。'); heldDrafts(); } });
  window.addEventListener('online', () => { attempts = 0; connectHub(); }); window.addEventListener('pagehide', heldDrafts);
  window.HandwaveRecovery = Object.freeze({authRequired, streamIncomplete, validDone, captureOwner: scope, preserveStream: (text, owner) => remember('部分输出（只读）', text, owner), checkToolFence, checkContinuation: base => checkToolFence(base), rememberQueue(owner, queue) { for (const item of queue.items || []) remember('连接结束时的队列文字（状态待核对）', item.msg, owner); for (const text of queue.steers || []) remember('应用状态待核对的引导草稿', text, owner); remember('队列编辑草稿', queue.edit, owner); remember('未应用的引导草稿', queue.recoverText, owner); remember('入队结果待核对的草稿', queue.pending, owner); }, state: () => ({phase, attempts, authBlocked, storageFailed, memoryOnly, preserved: available().map(e => ({kind: e.kind, text: e.text, scope: e.scope}))})});
  render(); if (available().length) tell('preserved', '此会话有保留的文字，可手动恢复；不会自动重建任务或队列。');
})();
