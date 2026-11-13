/* Session-scoped next-step candidates. Tab fills the composer; it never submits. */
(() => {
  'use strict';
  const input = document.getElementById('input');
  if (!input || input.dataset.hwSuggestReady === '1') return;
  input.dataset.hwSuggestReady = '1';
  let basePlaceholder = input.getAttribute('placeholder') || '输入消息';
  const baseDescription = input.getAttribute('aria-description');
  const selected = () => ({workspace_id: curWS && curWS.id || '', session_id: curSess && curSess.id || '', device_fp: curWS && curWS.device_fp || ''});
  const identity = () => JSON.stringify(selected());
  const surface = typeof window === 'object' ? window : null;
  const preferenceKey = 'handwave-suggestions-v1';
  const preferences = {enabled: true, include_memory: true, tab_accept: true};
  try {
    const saved = surface && surface.localStorage && JSON.parse(surface.localStorage.getItem(preferenceKey));
    for (const key of Object.keys(preferences)) if (saved && typeof saved[key] === 'boolean') preferences[key] = saved[key];
  } catch (_) { /* Storage is optional; no source or summary is persisted. */ }
  let owner = identity(), epoch = 0, request = 0, revision = 0;
  let lastIntent = '', hasAttachments = false, failed = false, dismissed = false, composing = false, runOwner = '', submittedIntent = '';
  let sourceRevision = 0, remoteSequence = 0, hasHistory = false, candidate = null, timer = null, controller = null;
  let loading = false, unavailable = false, awaitingIdle = false, recentStatus = '', lastPublished = '';
  let expiryTimer = null, expiredVersion = -1, expiryRefreshAttempted = false;
  const busy = () => (typeof sending !== 'undefined' && sending) ||
    (typeof localBusy !== 'undefined' && localBusy) ||
    (typeof processingQueue !== 'undefined' && processingQueue) ||
    (typeof msgQueue !== 'undefined' && Array.isArray(msgQueue) && msgQueue.length > 0);
  function abortPending() {
    if (timer != null) clearTimeout(timer);
    timer = null;
    if (controller) controller.abort();
    controller = null; loading = false; remoteSequence++;
  }
  function reset(preserveHistory = false) {
    const previousHistory = hasHistory;
    abortPending(); sourceRevision++;
    if (expiryTimer != null) clearTimeout(expiryTimer);
    expiryTimer = null; expiredVersion = -1; expiryRefreshAttempted = false;
    owner = identity(); epoch++; request++; revision++;
    lastIntent = ''; hasAttachments = false; failed = false; dismissed = false;
    candidate = null; hasHistory = preserveHistory && previousHistory; unavailable = false; runOwner = ''; recentStatus = ''; awaitingIdle = false;
  }
  function syncIdentity() {
    if (owner === identity()) return;
    const previous = JSON.parse(owner), next = selected();
    // Device rebinding changes authorization, not this Web conversation's
    // observed history. Keep only the existence bit; discard all old candidates,
    // observations and requests, and let the server recheck the new binding.
    const sameConversation = !!next.workspace_id && !!next.session_id && previous.workspace_id === next.workspace_id && previous.session_id === next.session_id;
    reset(sameConversation);
    if (sameConversation) schedule();
  }
  const eligible = () => preferences.enabled && !input.value && !input.disabled && !input.readOnly && !busy() && !dismissed && !composing;
  function currentCandidate() {
    return candidate && candidate.owner === identity() && candidate.version === sourceRevision && candidate.expires > Date.now() ? candidate : null;
  }
  function getState() {
    syncIdentity();
    const value = currentCandidate();
    return {enabled: preferences.enabled, include_memory: preferences.include_memory, tab_accept: preferences.tab_accept,
      status: !preferences.enabled ? 'disabled' : (busy() ? 'busy' : (loading ? 'loading' : (value ? 'ready' : (unavailable ? 'unavailable' : 'idle')))),
      summary: value ? value.summary : '', source_ids: value ? value.source_ids.slice() : [], owner: selected(),
      revision: value ? value.revision : '', expires_at: value ? value.expires_at : ''};
  }
  function publish() {
    if (!surface || typeof surface.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
    const value = getState(), encoded = JSON.stringify(value);
    if (encoded !== lastPublished) { lastPublished = encoded; surface.dispatchEvent(new CustomEvent('handwave:suggestion-state', {detail: value})); }
  }
  function canRequest() {
    const selection = selected();
    return eligible() && hasHistory && !!selection.workspace_id && !!selection.session_id && !!selection.device_fp;
  }
  function recentResult() {
    if (runOwner !== identity() || !['completed', 'failed', 'canceled'].includes(recentStatus) || typeof agentRun === 'undefined') return null;
    const run = agentRun.turnID;
    if (typeof run !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(run) || run === 'pending') return null;
    const tools = new Map();
    for (const event of Array.isArray(agentRun.events) ? agentRun.events : []) {
      if (!event || !['tool_start', 'tool_end', 'tool_finish'].includes(event.type)) continue;
      const name = event.title;
      if (typeof name !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(name)) continue;
      const status = ['completed', 'done', 'failed', 'canceled', 'cancelled', 'unknown'].includes(event.status) ? event.status : 'unknown';
      tools.delete(name); tools.set(name, {name, status});
    }
    return {run_id: run, status: recentStatus, tools: Array.from(tools.values()).slice(-4)};
  }
  async function requestCandidate() {
    syncIdentity();
    if (!canRequest()) { render(); return getState(); }
    abortPending();
    const captured = {owner, epoch, version: sourceRevision, seq: remoteSequence, memory: preferences.include_memory};
    controller = new AbortController(); const signal = controller.signal;
    loading = true; unavailable = false; render();
    const recent = recentResult();
    try {
      const result = await api('/next-suggestion', {method: 'POST', signal,
        body: JSON.stringify({...selected(), include_memory: captured.memory, ...(recent ? {recent_result: recent} : {})})});
      if (signal.aborted || captured.owner !== identity() || captured.epoch !== epoch || captured.version !== sourceRevision || captured.seq !== remoteSequence || !canRequest()) return getState();
      const selection = selected(), prompt = result && result.next_prompt;
      const expires = Date.parse(result && result.expires_at);
      if (!result || result.workspace_id !== selection.workspace_id || result.session_id !== selection.session_id || result.device_fp !== selection.device_fp ||
        typeof result.revision !== 'string' || !result.revision || result.revision.length > 256 ||
        typeof prompt !== 'string' || !prompt.trim() || Array.from(prompt).length > 240 || /[\x00-\x1f\x7f]/.test(prompt) || !Number.isFinite(expires) || expires <= Date.now()) throw new Error('invalid suggestion receipt');
      const boundedExpiry = Math.min(expires, Date.now() + 60000);
      candidate = {owner, version: sourceRevision, prompt: prompt.trim(), revision: result.revision, expires: boundedExpiry, expires_at: new Date(boundedExpiry).toISOString(),
        summary: typeof result.summary === 'string' ? Array.from(result.summary).slice(0, 2000).join('') : '',
        source_ids: Array.isArray(result.source_ids) ? result.source_ids.filter(id => typeof id === 'string' && id.length <= 128).slice(0, 32) : []};
      if (expiryTimer != null) clearTimeout(expiryTimer);
      const accepted = candidate;
      expiryTimer = setTimeout(() => {
        expiryTimer = null;
        if (candidate !== accepted || accepted.owner !== identity() || accepted.version !== sourceRevision) return;
        candidate = null; expiredVersion = sourceRevision; expiryRefreshAttempted = false; render();
      }, Math.max(1, boundedExpiry - Date.now()));
    } catch (_) {
      if (!signal.aborted && captured.owner === identity() && captured.epoch === epoch && captured.seq === remoteSequence) unavailable = true;
    } finally {
      if (captured.owner === identity() && captured.epoch === epoch && captured.seq === remoteSequence) { controller = null; loading = false; render(); }
    }
    return getState();
  }
  function schedule() {
    if (timer != null) clearTimeout(timer);
    timer = null;
    if (canRequest() && typeof setTimeout === 'function') timer = setTimeout(() => { timer = null; void requestCandidate(); }, 400);
  }
  function sourceChanged() {
    syncIdentity(); abortPending(); sourceRevision++; candidate = null; unavailable = false; dismissed = false;
    if (expiryTimer != null) clearTimeout(expiryTimer);
    expiryTimer = null; expiredVersion = -1; expiryRefreshAttempted = false;
    schedule(); render();
  }
  function settled() {
    if (awaitingIdle && !busy()) {
      awaitingIdle = false;
      // Native finish sets idle before its noteSession write acknowledges.
      // Its current assistant/system POST, not the idle edge, is our source.
      if (typeof localMode !== 'undefined' && localMode) return;
      hasHistory = true; sourceChanged();
    }
  }
  function setPreferences(update) {
    syncIdentity();
    let generatingChanged = false;
    for (const key of Object.keys(preferences)) if (update && typeof update[key] === 'boolean' && preferences[key] !== update[key]) {
      preferences[key] = update[key]; if (key !== 'tab_accept') generatingChanged = true;
    }
    try { if (surface && surface.localStorage) surface.localStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch (_) { /* Optional browser preference storage. */ }
    if (generatingChanged) sourceChanged(); else render();
    return getState();
  }
  function refresh() {
    syncIdentity(); abortPending(); sourceRevision++; candidate = null; unavailable = false; dismissed = false;
    if (expiryTimer != null) clearTimeout(expiryTimer);
    expiryTimer = null; expiredVersion = -1; expiryRefreshAttempted = false;
    return requestCandidate();
  }
  if (surface) surface.HandwaveSuggestions = {getState, setPreferences, refresh};
  function suggestion() {
    const remote = currentCandidate();
    if (remote) return remote.prompt;
    if (failed) return '查看刚才的错误，先说明原因和下一步检查。';
    const text = lastIntent;
    if (/日志|报错|故障|异常|log\b|error\b|debug/i.test(text)) return '继续检查相关日志，列出证据和下一步排查。';
    if (/记忆|知识库|memory\b/i.test(text)) return '查看已有记忆，说明这次可复用的内容。';
    if (/代码|项目|实现|编译|测试|code\b|build\b|test\b/i.test(text)) return '检查相关代码与测试，给出下一步最小改动。';
    if (/部署|安装|上线|install\b|deploy\b/i.test(text)) return '检查当前安装与运行状态，说明还缺哪一步。';
    const pending = typeof pendingAttach !== 'undefined' && Array.isArray(pendingAttach) && pendingAttach.length;
    if (pending || hasAttachments) return '查看参考资料，提取与当前任务有关的要点。';
    if (text) return '结合当前对话，说明下一步可以做什么。';
    return '先查看当前项目，说明可以从哪里开始。';
  }
  function render() {
    syncIdentity();
    const available = eligible();
    input.placeholder = available ? suggestion() : basePlaceholder;
    if (available) input.setAttribute('aria-description', preferences.tab_accept ? '下一步建议。按 Tab 填入，按 Escape 忽略；填入后仍需手动发送。' : '下一步建议。Tab 正常移动焦点，建议不会自动填入或发送。');
    else if (baseDescription == null) input.removeAttribute('aria-description');
    else input.setAttribute('aria-description', baseDescription);
    publish();
  }
  input.addEventListener('focus', () => {
    syncIdentity();
    const expired = (candidate && candidate.expires <= Date.now()) || expiredVersion === sourceRevision;
    if (expired && !expiryRefreshAttempted && canRequest()) { expiryRefreshAttempted = true; schedule(); }
    render();
  });
  input.addEventListener('input', () => { if (input.value) abortPending(); render(); });
  input.addEventListener('compositionstart', () => { composing = true; abortPending(); render(); });
  input.addEventListener('compositionend', () => { composing = false; render(); });
  input.addEventListener('keydown', event => {
    syncIdentity();
    if (event.key === 'Escape' && !input.value) { dismissed = true; abortPending(); render(); return; }
    if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey ||
      event.defaultPrevented || event.isComposing || event.keyCode === 229 || composing ||
      document.activeElement !== input || !preferences.enabled || !preferences.tab_accept || input.value || input.disabled || input.readOnly || busy() || dismissed) return;
    event.preventDefault();
    input.value = suggestion();
    input.dispatchEvent(new Event('input', {bubbles: true}));
    if (input.setSelectionRange) input.setSelectionRange(input.value.length, input.value.length);
  });
  // Read only user-authored content and attachment presence. Never inspect model
  // reasoning or turn an assistant's claimed success into a suggested action.
  const oldSend = sendChat;
  sendChat = function() {
    syncIdentity();
    abortPending(); candidate = null; sourceRevision++;
    if (input.value.trim()) {
      lastIntent = input.value.slice(0, 2000);
      submittedIntent = lastIntent;
      failed = false; dismissed = false; revision++;
    }
    const result = oldSend.apply(this, arguments);
    render();
    return result;
  };
  const oldAPI = api;
  api = async function(path, options) {
    syncIdentity();
    const expected = curWS && curSess ? '/workspaces/' + curWS.id + '/sessions/' + curSess.id + '/messages' : '';
    const method = String(options && options.method || 'GET').toUpperCase();
    const history = !!expected && path === expected && method === 'GET';
    let body = null;
    if (method === 'POST' && options && typeof options.body === 'string') { try { body = JSON.parse(options.body); } catch (_) {} }
    const note = !!expected && path === expected && method === 'POST' && body && ['assistant', 'system'].includes(body.role) && typeof body.content === 'string' && !!body.content.trim();
    const memory = method === 'POST' && ['/cloud-memory/records', '/cloud-memory/revoke', '/cloud-memory/project'].includes(path) && body &&
      body.workspace_id === (curWS && curWS.id) && body.device_fp === (curWS && curWS.device_fp);
    const scope = owner, generation = epoch, version = revision, sequence = history ? ++request : request;
    const result = await oldAPI.apply(this, arguments);
    if (history && scope === identity() && generation === epoch && sequence === request && version === revision && Array.isArray(result)) {
      const users = result.filter(message => message && message.role === 'user');
      const last = users[users.length - 1];
      lastIntent = last && typeof last.content === 'string' ? last.content.slice(0, 2000) : '';
      hasAttachments = users.some(message => Array.isArray(message.attachments) && message.attachments.length);
      hasHistory = users.some(message => typeof message.content === 'string' && !!message.content.trim()) || result.some(message => message && message.role === 'assistant' && typeof message.content === 'string' && !!message.content.trim());
      sourceChanged();
    }
    if ((note || memory) && scope === identity() && generation === epoch) {
      if (note) hasHistory = true;
      sourceChanged();
    }
    return result;
  };
  const oldSession = selectSession;
  selectSession = function() { submittedIntent = ''; reset(); const result = oldSession.apply(this, arguments); render(); return result; };
  const oldWorkspace = selectWorkspace;
  selectWorkspace = function() { submittedIntent = ''; reset(); const result = oldWorkspace.apply(this, arguments); render(); return result; };
  const oldClear = clearMessages;
  clearMessages = function() {
    const result = oldClear.apply(this, arguments);
    abortPending(); candidate = null; sourceRevision++; hasHistory = false;
    lastIntent = ''; hasAttachments = false; failed = false; revision++; render();
    return result;
  };
  const oldFinish = finishLocalRun;
  finishLocalRun = function(errorText) {
    const scoped = runOwner === identity() && localBusy;
    const result = oldFinish.apply(this, arguments);
    syncIdentity();
    if (scoped) failed = !!errorText && errorText !== 'session busy; follow-up queued';
    render(); return result;
  };
  const oldResetRun = resetAgentRun;
  resetAgentRun = function() {
    syncIdentity();
    abortPending(); candidate = null; sourceRevision++; recentStatus = '';
    // The first send may create its workspace/session before starting the Run.
    // Explicit navigation discards this handoff in the selection wrappers above.
    if (submittedIntent) { lastIntent = submittedIntent; submittedIntent = ''; revision++; }
    runOwner = identity();
    const result = oldResetRun.apply(this, arguments); render(); return result;
  };
  const oldSendUI = setSendUI;
  setSendUI = function(value) {
    const result = oldSendUI.apply(this, arguments);
    if (value) { awaitingIdle = true; abortPending(); candidate = null; sourceRevision++; }
    else settled();
    render(); return result;
  };
  if (typeof renderQueue === 'function') {
    const oldQueue = renderQueue;
    renderQueue = function() { const result = oldQueue.apply(this, arguments); settled(); render(); return result; };
  }
  if (typeof recordAgentEvent === 'function') {
    const oldRecord = recordAgentEvent;
    recordAgentEvent = function(event) {
      const result = oldRecord.apply(this, arguments);
      if (runOwner === identity() && event && event.type === 'agent_end' && ['completed', 'failed', 'canceled'].includes(event.status)) recentStatus = event.status;
      return result;
    };
  }
  const oldAttach = renderAttachBar;
  renderAttachBar = function() { const result = oldAttach.apply(this, arguments); render(); return result; };
  if (typeof syncInputPlaceholder === 'function') {
    const oldPlaceholder = syncInputPlaceholder;
    syncInputPlaceholder = function() {
      const previous = input.placeholder;
      const result = oldPlaceholder.apply(this, arguments);
      // Boot and responsive layout retain ownership of the native fallback.
      // Reapply a suggestion only while the composer is eligible for one.
      if (input.placeholder && input.placeholder !== previous) basePlaceholder = input.placeholder;
      render();
      return result;
    };
  }
  render();
})();
