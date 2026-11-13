// handwave 工作台 —— 聊天优先；会话落 hub；工具经 DC/中继在远程执行。
'use strict';

const $ = (id) => document.getElementById(id);
const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const enc = new TextEncoder(), dec = new TextDecoder('utf-8');
const MAX_CHUNK = 24 * 1024;

function b32(bytes) {
  let out = '', bits = 0, acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(acc >> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}
function b64enc(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64dec(str) {
  const s = atob(str), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
function loadFP() {
  let fp = localStorage.getItem('hw.ctl.fp');
  if (!fp) {
    fp = b32(crypto.getRandomValues(new Uint8Array(8)));
    localStorage.setItem('hw.ctl.fp', fp);
  }
  return fp;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- 毛玻璃弹窗（替代 alert / prompt） ----------
function uiDialog({ title = '提示', message = '', input = null, okText = '确定', cancelText = '取消', showCancel = false } = {}) {
  return new Promise((resolve) => {
    const root = $('dlg');
    const fieldWrap = $('dlgFieldWrap');
    const inputEl = $('dlgInput');
    $('dlgTitle').textContent = title;
    $('dlgMsg').textContent = message;
    $('dlgOk').textContent = okText;
    $('dlgCancel').textContent = cancelText;
    $('dlgCancel').classList.toggle('hide', !showCancel && input == null);
    if (input != null) {
      fieldWrap.classList.remove('hide');
      inputEl.value = input;
      inputEl.placeholder = '';
    } else {
      fieldWrap.classList.add('hide');
      inputEl.value = '';
    }
    root.classList.remove('hide');
    root.setAttribute('aria-hidden', 'false');
    const finish = (v) => {
      root.classList.add('hide');
      root.setAttribute('aria-hidden', 'true');
      $('dlgOk').onclick = null;
      $('dlgCancel').onclick = null;
      $('dlgClose').onclick = null;
      $('dlgScrim').onclick = null;
      inputEl.onkeydown = null;
      resolve(v);
    };
    $('dlgOk').onclick = () => finish(input != null ? inputEl.value : true);
    $('dlgCancel').onclick = () => finish(input != null ? null : false);
    $('dlgClose').onclick = () => finish(input != null ? null : false);
    $('dlgScrim').onclick = () => finish(input != null ? null : false);
    if (input != null) {
      setTimeout(() => { inputEl.focus(); inputEl.select(); }, 30);
      inputEl.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(inputEl.value); }
        if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      };
    } else {
      setTimeout(() => $('dlgOk').focus(), 30);
    }
  });
}
function uiAlert(message, title = '提示') {
  return uiDialog({ title, message, showCancel: false });
}
function uiPrompt(message, def = '', title = '输入') {
  return uiDialog({ title, message, input: def, showCancel: true });
}
function uiConfirm(message, title = '确认') {
  return uiDialog({ title, message, showCancel: true, okText: '确定', cancelText: '取消' });
}
function showToast(message, type = 'info', duration = 4000) {
  // type: info | success | warn | error
  const colors = { info: 'var(--primary)', success: '#22c55e', warn: '#f59e0b', error: '#ef4444' };
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9000;padding:12px 20px;border-radius:8px;' +
    'background:var(--panel-fill);border:1px solid var(--border);color:var(--text);font-size:13px;' +
    'box-shadow:0 8px 32px rgba(0,0,0,.35);max-width:320px;animation:toastIn .2s ease';
  toast.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;' +
    'background:' + colors[type] + ';margin-right:10px;vertical-align:middle;flex-shrink:0"></span>' +
    '<span style="vertical-align:middle">' + message + '</span>';
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut .2s ease forwards';
    setTimeout(() => toast.remove(), 200);
  }, duration);
}
async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    credentials: 'same-origin',
    headers: opts.body && !(opts.body instanceof FormData)
      ? { 'content-type': 'application/json', ...(opts.headers || {}) }
      : opts.headers,
    ...opts,
  });
  if (r.status === 401) {
    location.href = '/login';
    throw new Error('unauthorized');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

// ---------- 会话离开 / 刷新重登 ----------
let DEV_MODE = false;

async function ensureAuth() {
  try {
    const me = await fetch('/auth/me', { credentials: 'same-origin' });
    const j = await me.json().catch(() => ({}));
    if (j.dev) {
      DEV_MODE = true;
      return true;
    }
    if (!me.ok) {
      location.href = '/login';
      return false;
    }
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav && nav.type === 'reload') {
      await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
      location.href = '/login';
      return false;
    }
    return true;
  } catch (_) {
    location.href = '/login';
    return false;
  }
}

window.addEventListener('pagehide', () => {
  if (DEV_MODE) return;
  try {
    navigator.sendBeacon('/auth/logout');
  } catch (_) {
    fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', keepalive: true });
  }
});

// ---------- 状态 ----------
let ws = null, myFP = loadFP();
let paired = false, helloDone = false;
let pc = null, dc = null, remoteSet = false, pendingCands = [];
let pollTimer = null, helloTimer = null;
let devices = [];
let curWS = null, curSess = null;

// ---------- 思考过程 ----------
let thinkingBuffer = '';
let thinkingTimer = null;
let thinkingPanel = null;
let currentThinkingItem = null;
let thinkingItems = [];

function initThinking() {
  thinkingPanel = $('thinkingContent');
  if (thinkingPanel) {
    thinkingPanel.innerHTML = '';
    thinkingItems = [];
    currentThinkingItem = null;
  }
}

function showThinking() {
  const panel = $('thinkingPanel');
  if (panel) {
    panel.classList.remove('hide');
  }
}

function hideThinking() {
  const panel = $('thinkingPanel');
  if (panel) {
    panel.classList.add('hide');
    initThinking();
  }
}

function clearThinking() {
  initThinking();
}

function processThinkingText(text) {
  if (!thinkingPanel) return;
  thinkingBuffer += text;
  
  // Parse bullet points and lines
  const lines = thinkingBuffer.split('\n');
  const lastLine = lines[lines.length - 1];
  
  // Check for complete items (lines ending with . or :)
  const completePattern = /^[\-\*]\s+(.+)[.:]$/;
  const itemPattern = /^[\-\*]\s+(.+)$/;
  
  // Check if we have a complete new item
  for (let i = thinkingItems.length; i < lines.length - 1; i++) {
    const line = lines[i].trim();
    if (line && (line.startsWith('- ') || line.startsWith('* '))) {
      const content = line.slice(2);
      if (content && !thinkingItems.includes(line)) {
        thinkingItems.push(line);
        addThinkingItem(content);
      }
    }
  }
  
  // Handle current line (not yet complete)
  if (lastLine && (lastLine.startsWith('- ') || lastLine.startsWith('* '))) {
    const content = lastLine.trim().slice(2);
    if (content) {
      if (currentThinkingItem && thinkingItems.includes(thinkingItems[thinkingItems.length - 1])) {
        // Already completed, start new one
        currentThinkingItem = null;
      }
      if (!currentThinkingItem) {
        // Start new thinking item
        currentThinkingItem = content;
        const item = document.createElement('div');
        item.className = 'thinking-item';
        item.id = 'thinking-current';
        item.textContent = content;
        thinkingPanel.appendChild(item);
      } else {
        // Update current item
        const current = $('thinking-current');
        if (current) current.textContent = content;
      }
    }
  }
}

function addThinkingItem(content) {
  if (!thinkingPanel) return;
  // Remove current item if exists
  const current = $('thinking-current');
  if (current) {
    current.id = '';
    current.className = 'thinking-item done';
  }
  currentThinkingItem = null;
}

function finishThinking() {
  // Mark current item as done
  const current = $('thinking-current');
  if (current) {
    current.id = '';
    current.className = 'thinking-item done';
  }
  currentThinkingItem = null;
  thinkingBuffer = '';
  
  // Update header
  const head = $('thinkingPanel');
  if (head) {
    const b = head.querySelector('b');
    if (b) b.textContent = '思考完成';
  }
}
let pendingAttach = [];
let sending = false;
let skillCatalog = [], selectedSkills = [];
let skillMenuOpen = false, skillLoading = false, skillError = '', skillLoadSeq = 0;
let attachMenuOpen = false, editingSkill = null, skillEditSeq = 0, skillSaving = false;
let gatewayPublic = null, cloudModelBusy = false, gatewayDirty = false, skillGenerating = false;
// ---------- Message Queue ----------
let msgQueue = []; // [{id, text, attachments, skills, model, kb_global, kb_project, tools, agents}]
let processingQueue = false;
let currentQueueItem = null;

let queueSeq = 0;
function nextQueueID() { return ++queueSeq; }

function enqueueMessage(payload) {
  const item = {
    id: nextQueueID(),
    text: payload.text,
    attachments: payload.attachments || [],
    skills: payload.skills || [],
    model: payload.model,
    protocol: payload.protocol,
    kb_global: payload.kb_global,
    kb_project: payload.kb_project,
    tools: payload.tools,
    agents: payload.agents,
    status: 'queued', // queued | running | done
  };
  msgQueue.push(item);
  renderQueue();
  processQueue();
  return item;
}

function removeFromQueue(id) {
  msgQueue = msgQueue.filter(item => item.id !== id);
  renderQueue();
}

function moveQueueItemToTop(id) {
  const idx = msgQueue.findIndex(item => item.id === id);
  if (idx <= 0) return;
  const [item] = msgQueue.splice(idx, 1);
  msgQueue.unshift(item);
  renderQueue();
  processQueue();
}

function clearQueue() {
  if (processingQueue) {
    cancelActiveWork();
    if (currentQueueItem) currentQueueItem.status = 'canceled';
  }
  msgQueue = [];
  currentQueueItem = null;
  renderQueue();
}

function renderQueue() {
  const container = $('msgQueue');
  const list = $('queueList');
  const count = $('queueCount');
  if (!container || !list) return;
  
  if (msgQueue.length === 0) {
    container.classList.add('hide');
    return;
  }
  
  container.classList.remove('hide');
  count.textContent = msgQueue.length;
  list.innerHTML = '';
  
  msgQueue.forEach((item, idx) => {
    const el = document.createElement('div');
    el.className = 'queue-item';
    el.dataset.id = item.id;
    
    // Running indicator
    if (item.status === 'running') {
      el.innerHTML += '<span class="q-running"></span>';
    }
    
    // Text preview
    const text = document.createElement('span');
    text.className = 'q-text';
    text.textContent = item.text || '（附件）';
    el.appendChild(text);
    
    // Buttons
    const btns = document.createElement('span');
    btns.className = 'q-btns';
    
    // 立即 (run immediately, only for queued items not currently running)
    if (item.status === 'queued' && !processingQueue) {
      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.className = 'q-btn';
      runBtn.textContent = '立即';
      runBtn.onclick = () => moveQueueItemToTop(item.id);
      btns.appendChild(runBtn);
    }
    
    // Edit (only for first item or running)
    if (idx === 0) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'q-btn';
      editBtn.textContent = '编辑';
      editBtn.onclick = () => editQueueItem(item.id);
      btns.appendChild(editBtn);
    }
    
    // Delete
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'q-btn danger';
    delBtn.textContent = '删除';
    delBtn.onclick = () => removeFromQueue(item.id);
    btns.appendChild(delBtn);
    
    el.appendChild(btns);
    list.appendChild(el);
  });
}

function editQueueItem(id) {
  const item = msgQueue.find(i => i.id === id);
  if (!item) return;
  // Stop current processing if editing first item
  if (msgQueue[0] && msgQueue[0].id === id) {
    cancelActiveWork();
    if (currentQueueItem) currentQueueItem.status = 'canceled';
    processingQueue = false;
  }
  // Put text back to input
  $('input').value = item.text;
  // Remove from queue
  removeFromQueue(id);
  $('input').focus();
}

async function processQueue() {
  if (processingQueue || msgQueue.length === 0) return;
  
  const item = msgQueue[0];
  if (item.status !== 'queued') return;
  
  processingQueue = true;
  currentQueueItem = item;
  item.status = 'running';
  renderQueue();
  
  // Execute the message
  try {
    await executeQueueItem(item);
  } catch (e) {
    console.error('Queue item error:', e);
  }
  
  // Remove completed item and continue
  msgQueue.shift();
  processingQueue = false;
  currentQueueItem = null;
  renderQueue();
  
  // Process next
  if (msgQueue.length > 0) {
    processQueue();
  }
}

async function executeQueueItem(item) {
  if (!curSess) {
    if (!(await ensureChatContext())) return;
  }
  
  const skills = item.skills.map(s => typeof s === 'string' ? s : s.id);
  const skillNames = item.skills.map(s => typeof s === 'string' ? s : s.name);
  addBubble('user', (item.text || '（附件）') + (skillNames.length ? '\n\n技能：' + skillNames.join('、') : ''));
  
  const base = {
    workspace_id: curWS.id,
    session_id: curSess.id,
    model: item.model || 'default',
    protocol: item.protocol || '',
    kb_global: item.kb_global,
    kb_project: item.kb_project,
    tools: item.tools,
    agents: item.agents,
  };
  
  resetAgentRun('pending');
  let stream = null;
  try {
    stream = beginAssistant();
    let asst = await consumeSSE('/chat', Object.assign({ content: item.text, attachments: item.attachments, skills }, base), stream);
    const turnID = asst && asst.turn_id;
    if (turnID) agentRun.turnID = turnID;
    stream.finalize(asst ? asst.content : null);
    stream = null;
    
    if (asst && asst.clarify && asst.clarify.length) {
      pendingClarify = { turnID, options: asst.clarify };
      renderClarifyBar();
      finishAgentRun('completed');
      return;
    }
    
    let guard = 0;
    while (asst && asst.tool_calls && asst.tool_calls.length && guard++ < 8) {
      const toolBase = Object.assign({ turn_id: turnID }, base);
      const results = await runToolCalls(asst.tool_calls, toolBase);
      if (stopRequested) throw new DOMException('Stopped', 'AbortError');
      stream = beginAssistant();
      asst = await consumeSSE('/chat/continue', Object.assign({ turn_id: turnID, tool_results: results }, base), stream);
      stream.finalize(asst ? asst.content : null);
      stream = null;
    }
    refreshSessions();
    finishAgentRun('completed');
  } catch (e) {
    if (stream) stream.finalize(null);
    const stopped = e && e.name === 'AbortError';
    finishAgentRun(stopped ? 'canceled' : 'failed');
    if (stopped) addBubble('system', '已停止。');
    else addBubble('system', '发送失败：' + e.message);
  } finally {
    activeWork.clear();
    setSendUI(false);
  }
}

let pendingClarify = null; // { turnID, options } — set when AI asks for clarification
let projectTree = null; // { path, tree[] } — current project file tree
let projectTreeOpen = new Set(); // expanded dir paths
let applyPendingSSE = null; // EventSource for apply pending events

// ---------- Apply code confirmation dialog（apply_code 确认） ----------
function openApplyPendingSSE() {
  if (applyPendingSSE) {
    applyPendingSSE.close();
    applyPendingSSE = null;
  }
  if (!curWS) return;
  const src = new EventSource('/api/apply/pending?ws=' + curWS.id);
  src.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.tool_call_id) {
      showApplyConfirmDialog(data);
    }
  };
  src.onerror = () => {
    src.close();
    applyPendingSSE = null;
  };
  applyPendingSSE = src;
}

function showApplyConfirmDialog(meta) {
  const overlay = document.createElement('div');
  overlay.className = 'apply-overlay';
  overlay.innerHTML =
    '<div class="apply-dialog">' +
      '<div class="apply-dialog-head">确认文件修改 <span class="apply-dialog-path">' + escHtml(meta.path) + '</span></div>' +
      '<div class="apply-dialog-reason">AI 说明变更原因</div>' +
      '<div class="apply-dialog-diff"><pre>' + escHtml(meta.diff || '(无差异)') + '</pre></div>' +
      '<div class="apply-dialog-acts">' +
        '<button type="button" class="btn ghost" id="applyReject">拒绝</button>' +
        '<button type="button" class="btn primary" id="applyConfirm">确认应用</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  overlay.querySelector('#applyConfirm').onclick = async () => {
    document.body.removeChild(overlay);
    await api('/api/apply/resolve', {
      method: 'POST',
      body: JSON.stringify({ tool_call_id: meta.tool_call_id, workspace_id: meta.workspace_id, confirm: true }),
    });
  };
  overlay.querySelector('#applyReject').onclick = async () => {
    document.body.removeChild(overlay);
    await api('/api/apply/resolve', {
      method: 'POST',
      body: JSON.stringify({ tool_call_id: meta.tool_call_id, workspace_id: meta.workspace_id, confirm: false }),
    });
  };
  overlay.onclick = (e) => { if (e.target === overlay) { document.body.removeChild(overlay); } };
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Code block Apply button — show confirm dialog then call apply API
document.addEventListener('click', (e) => {
  const btn = e.target.closest ? e.target.closest('.code-apply') : null;
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const path = btn.dataset.path;
  const content = btn.dataset.content;
  if (!path || !content) return;
  // Show confirm dialog
  const overlay = document.createElement('div');
  overlay.className = 'apply-overlay';
  // Compute diff (simple: show new file preview)
  const diff = '--- /dev/null\n+++ ' + path + '\n' + content.split('\n').map((l, i) =>
    '@@ -0,0 +' + (i + 1) + ' @@\n' + l).join('\n');
  overlay.innerHTML =
    '<div class="apply-dialog">' +
      '<div class="apply-dialog-head">确认文件修改 <span class="apply-dialog-path">' + escHtml(path) + '</span></div>' +
      '<div class="apply-dialog-reason">此代码块将写入文件</div>' +
      '<div class="apply-dialog-diff"><pre>' + escHtml(diff) + '</pre></div>' +
      '<div class="apply-dialog-acts">' +
        '<button type="button" class="btn ghost" id="applyReject">取消</button>' +
        '<button type="button" class="btn primary" id="applyConfirm">确认应用</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  overlay.querySelector('#applyConfirm').onclick = async () => {
    document.body.removeChild(overlay);
    try {
      const tcID = 'inline_' + Date.now();
      await api('/api/apply/resolve', {
        method: 'POST',
        body: JSON.stringify({ tool_call_id: tcID, workspace_id: curWS && curWS.id, confirm: true, content: content, path: path }),
      });
      await uiAlert('文件已应用: ' + path);
    } catch (err) {
      await uiAlert('应用失败: ' + err.message);
    }
  };
  overlay.querySelector('#applyReject').onclick = () => document.body.removeChild(overlay);
  overlay.onclick = (e2) => { if (e2.target === overlay) document.body.removeChild(overlay); };
});

// ---------- Project tree（项目文件浏览器） ----------
function renderProjectTree() {
  const box = $('projectTree');
  const hint = $('projectTreeHint');
  if (!box) return;
  if (!projectTree || !projectTree.tree || !projectTree.tree.length) {
    box.classList.add('hide');
    hint && hint.classList.remove('hide');
    return;
  }
  box.classList.remove('hide');
  hint && hint.classList.add('hide');
  box.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const entry of projectTree.tree) {
    frag.appendChild(renderTreeEntry(entry, ''));
  }
  box.appendChild(frag);
}

function renderTreeEntry(entry, parentPath) {
  const fullPath = parentPath ? parentPath + '/' + entry.name : entry.name;
  const isDir = entry.type === 'dir';
  const isOpen = projectTreeOpen.has(fullPath);

  const row = el('div', 'project-tree-row' + (isDir ? ' dir' : ''));
  row.dataset.path = fullPath;

  const ico = document.createElement('span');
  ico.className = 'pt-ico';
  ico.innerHTML = isDir
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
  row.appendChild(ico);

  const name = el('span', 'pt-name', entry.name);
  row.appendChild(name);

  if (isDir) {
    row.onclick = () => {
      if (isOpen) projectTreeOpen.delete(fullPath);
      else projectTreeOpen.add(fullPath);
      renderProjectTree();
    };
  } else {
    row.onclick = () => {
      // Double-click to send to input
      const inp = $('input');
      if (inp) {
        inp.value = (inp.value ? inp.value + '\n' : '') + '文件: ' + fullPath;
        inp.focus();
      }
    };
    row.title = '双击将路径发送到输入框';
  }

  // Render kids for non-collapsed dirs (appended to parent box by recursion)
  if (isDir && isOpen && entry.children && entry.children.length) {
    const kids = el('div', 'project-tree-kids');
    for (const child of entry.children) {
      kids.appendChild(renderTreeEntry(child, fullPath));
    }
    // We return a fragment-like container for dirs (row + kids)
    const wrap = el('div');
    wrap.appendChild(row);
    wrap.appendChild(kids);
    return wrap;
  }

  return row;
}

async function loadProjectTree() {
  if (!curWS) return;
  try {
    const tree = await api('/workspaces/' + curWS.id + '/files');
    projectTree = { path: curWS.project_path || '', tree: tree || [] };
    projectTreeOpen.clear();
    renderProjectTree();
    // Show block if has path
    const block = $('projectTreeBlock');
    if (block) block.classList.toggle('hide', !curWS.project_path);
  } catch (_) {
    projectTree = null;
    renderProjectTree();
  }
}

$('btnSetProjectPath').onclick = async () => {
  const path = prompt('输入项目目录路径：', curWS && curWS.project_path ? curWS.project_path : '');
  if (path === null) return;
  if (!curWS) return;
  try {
    await api('/workspaces/' + curWS.id, {
      method: 'PATCH',
      body: JSON.stringify({ project_path: path }),
    });
    curWS.project_path = path;
    await loadProjectTree();
    // Refresh the workspace in cache
    const cached = wsCache.find((x) => x.id === curWS.id);
    if (cached) cached.project_path = path;
  } catch (err) {
    await uiAlert('保存失败：' + err.message);
  }
};

// ---------- Clarify bar（模型主动询问） ----------
function renderClarifyBar() {
  const bar = $('clarifyBar');
  if (!bar) return;
  bar.innerHTML = '';
  if (!pendingClarify || !pendingClarify.options || !pendingClarify.options.length) {
    bar.classList.add('hide');
    return;
  }
  bar.classList.remove('hide');
  bar.setAttribute('aria-label', '请选择：' + pendingClarify.options.map((o) => o.label).join('、'));
  pendingClarify.options.forEach((opt) => {
    const btn = el('button', 'clarify-btn');
    btn.type = 'button';
    btn.textContent = opt.label;
    btn.onclick = () => {
      const turnID = pendingClarify.turnID;
      const value = opt.value;
      pendingClarify = null;
      renderClarifyBar();
      // Inject as user reply and continue the turn
      sendClarifyReply(turnID, value);
    };
    bar.appendChild(btn);
  });
}

/** User clicked a clarify option — send the value as a user message and continue the turn */
async function sendClarifyReply(turnID, value) {
  if (sending) return;
  sending = true;
  setSendUI(true);
  try {
    // Render user reply immediately, then persist via API
    addBubble('user', value);
    await api('/chat/clarify-reply', {
      method: 'POST',
      body: JSON.stringify({
        workspace_id: curWS.id,
        session_id: curSess.id,
        turn_id: turnID,
        content: value,
      }),
    });
    // Continue the chat turn
    resetAgentRun(turnID);
    let stream = beginAssistant();
    const turnSel = chatModelSelection();
    const base = {
      workspace_id: curWS.id,
      session_id: curSess.id,
      model: turnSel.model,
      protocol: turnSel.protocol,
      kb_global: $('kbGlobal').checked,
      kb_project: $('kbProject').checked,
      tools: $('useTools').checked,
      agents: $('useAgents').checked,
    };
    let asst = await consumeSSE('/chat/continue', Object.assign({ turn_id: turnID, tool_results: [] }, base), stream);
    stream.finalize(asst ? asst.content : null);
    stream = null;

    // Nested clarify — pause again
    if (asst && asst.clarify && asst.clarify.length > 0) {
      pendingClarify = { turnID, options: asst.clarify };
      renderClarifyBar();
      finishAgentRun('completed');
      return;
    }

    let guard = 0;
    while (asst && asst.tool_calls && asst.tool_calls.length && guard++ < 8) {
      const toolBase = Object.assign({ turn_id: turnID }, base);
      const results = await runToolCalls(asst.tool_calls, toolBase);
      if (stopRequested) throw new DOMException('Stopped', 'AbortError');
      stream = beginAssistant();
      asst = await consumeSSE('/chat/continue', Object.assign({ turn_id: turnID, tool_results: results }, base), stream);
      stream.finalize(asst ? asst.content : null);
      stream = null;

      // Nested clarify mid-tool-loop
      if (asst && asst.clarify && asst.clarify.length > 0) {
        pendingClarify = { turnID, options: asst.clarify };
        renderClarifyBar();
        finishAgentRun('completed');
        return;
      }
    }
    refreshSessions();
    finishAgentRun('completed');
  } catch (e) {
    if (e && e.name === 'AbortError') {
      addBubble('system', '已停止。');
      finishAgentRun('canceled');
    } else {
      addBubble('system', '继续失败：' + (e && e.message));
      finishAgentRun('failed');
    }
  } finally {
    activeWork.clear();
    sending = false;
    setSendUI(false);
  }
}
const toolSess = new Map();
const activeWork = new Map();
let stopRequested = false;
const agentRun = {
  turnID: '', startedAt: 0, endedAt: 0, agents: new Map(), events: [], expanded: true, timeline: false, timelineAgent: '',
};

$('myfp').textContent = myFP;
(function syncAccountAva() {
  const short = (myFP || '本机').slice(0, 2).toUpperCase();
  const a = $('accountAva');
  const b = $('accountMenuAva');
  if (a) a.textContent = short;
  if (b) b.textContent = short;
  const fp = $('accountMenuFp');
  if (fp) fp.textContent = myFP || '—';
})();

// ---------- 主题 / 账户菜单 ----------
const THEMES = [
  { id: 'dark', name: '暗色玻璃' },
  { id: 'light', name: '亮色玻璃' },
];
const THEME_ALIAS = {
  glass: 'dark', obsidian: 'dark', default: 'dark',
  mist: 'light',
};
let accountMenuOpen = false;

function normalizeTheme(t) {
  const raw = THEME_ALIAS[t] || t;
  return THEMES.some((x) => x.id === raw) ? raw : 'dark';
}
function applyTheme(t) {
  const id = normalizeTheme(t);
  document.documentElement.setAttribute('data-theme', id);
  try { localStorage.setItem('handwave.console.theme', id); } catch (_) {}
  renderThemeList();
}
function renderThemeList() {
  const box = $('themeList');
  if (!box) return;
  const cur = normalizeTheme(document.documentElement.getAttribute('data-theme') || 'dark');
  box.innerHTML = '';
  THEMES.forEach((t) => {
    const btn = el('button', 'account-theme-item' + (t.id === cur ? ' on' : ''));
    btn.type = 'button';
    btn.setAttribute('role', 'menuitemradio');
    btn.setAttribute('aria-checked', t.id === cur ? 'true' : 'false');
    btn.appendChild(el('span', '', t.name));
    const check = el('span', 'model-check', '✓');
    btn.appendChild(check);
    btn.onclick = (e) => {
      e.stopPropagation();
      applyTheme(t.id);
    };
    box.appendChild(btn);
  });
}
function positionAccountMenu() {
  const menu = $('accountMenu');
  const trigger = $('accountTrigger');
  if (!menu || !trigger) return;
  const r = trigger.getBoundingClientRect();
  const pad = 8;
  const w = menu.offsetWidth || 260;
  const h = menu.offsetHeight || 280;
  let left = r.left;
  let top = r.top - h - 8;
  if (top < pad) top = r.bottom + 8;
  if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
  if (left < pad) left = pad;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}
function openAccountMenu() {
  closeAttachMenu();
  closeModelMenu();
  const menu = $('accountMenu');
  if (!menu) return;
  renderThemeList();
  menu.classList.remove('hide');
  accountMenuOpen = true;
  $('accountTrigger').setAttribute('aria-expanded', 'true');
  positionAccountMenu();
}
function closeAccountMenu() {
  const menu = $('accountMenu');
  if (!menu) return;
  menu.classList.add('hide');
  accountMenuOpen = false;
  const t = $('accountTrigger');
  if (t) t.setAttribute('aria-expanded', 'false');
}
function toggleAccountMenu() {
  if (accountMenuOpen) closeAccountMenu();
  else openAccountMenu();
}
function bindAccountMenu() {
  const trigger = $('accountTrigger');
  if (!trigger) return;
  trigger.onclick = (e) => {
    e.stopPropagation();
    toggleAccountMenu();
  };
  document.addEventListener('mousedown', (e) => {
    if (!accountMenuOpen) return;
    const menu = $('accountMenu');
    if (menu.contains(e.target) || trigger.contains(e.target)) return;
    closeAccountMenu();
  });
  window.addEventListener('resize', () => { if (accountMenuOpen) positionAccountMenu(); });
  window.addEventListener('scroll', () => { if (accountMenuOpen) positionAccountMenu(); }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && accountMenuOpen) closeAccountMenu();
  });
  applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');
}

$('btnLogout').onclick = async () => {
  closeAccountMenu();
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  location.href = '/login';
};

// ---------- UI 辅助 ----------
function setConnState(t, cls) {
  const s = $('connState');
  s.textContent = t;
  s.className = 'state ' + cls;
}
function toolLog(line) {
  const box = $('toolLog');
  if (box.classList.contains('note')) {
    box.className = 'tool-well';
    box.textContent = '';
  }
  box.appendChild(el('div', '', line));
  box.scrollTop = box.scrollHeight;
}

const AGENT_STATUS = {
  queued: '等待', running: '进行中', completed: '完成', failed: '失败', canceled: '已停止',
};
const AGENT_ROLE = {
  coordinator: '协调者', researcher: '研究员', planner: '规划师', reviewer: '审查员',
  investigator: '调查员', operator: '操作员', builder: '构建员',
};
function resetAgentRun(turnID) {
  agentRun.turnID = turnID || '';
  agentRun.startedAt = Date.now();
  agentRun.endedAt = 0;
  agentRun.agents.clear();
  agentRun.events = [];
  agentRun.expanded = true;
  agentRun.timeline = false;
  agentRun.timelineAgent = '';
  renderAgentDock();
}
function agentIdentity(evt) {
  return evt.agent_id || evt.task_id || 'coordinator';
}
function recordAgentEvent(evt) {
  if (!evt || !evt.type) return;
  if (typeof onLocalAgentEvent === 'function' && onLocalAgentEvent(evt)) return;
  const id = agentIdentity(evt);
  let agent = agentRun.agents.get(id);
  if (!agent) {
    agent = {
      id, name: evt.agent_name || (id === 'coordinator' ? 'Coordinator' : 'Agent'),
      role: evt.agent_role || (id === 'coordinator' ? 'coordinator' : 'operator'),
      status: 'queued', title: '', detail: '', index: 0, total: 0, startedAt: Date.now(), taskID: evt.task_id || '',
    };
    agentRun.agents.set(id, agent);
  }
  if (evt.agent_name) agent.name = evt.agent_name;
  if (evt.agent_role) agent.role = evt.agent_role;
  if (evt.task_id) agent.taskID = evt.task_id;
  if (evt.title) agent.title = evt.title;
  if (evt.detail) agent.detail = evt.detail;
  if (evt.index != null) agent.index = evt.index;
  if (evt.total != null) agent.total = evt.total;
  if (evt.status) agent.status = evt.status;
  if (/^(model_request|agent_start|task_start|step_start|step_output)$/.test(evt.type)) agent.status = 'running';
  agentRun.events.push(evt);
  renderAgentDock();
}
function completeCoordinator(status) {
  const agent = agentRun.agents.get('coordinator');
  if (agent) agent.status = status || 'completed';
  renderAgentDock();
}
function formatElapsed(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return sec + '秒';
  return Math.floor(sec / 60) + '分' + String(sec % 60).padStart(2, '0') + '秒';
}
function agentEventLabel(evt) {
  const names = {
    model_request: '请求模型', model_response: '模型响应', agent_start: '开始委派', agent_finish: '委派结束',
    task_start: 'Node 接收任务', task_finish: 'Node 任务结束', step_start: '开始步骤', step_output: '步骤输出', step_finish: '步骤结束',
    tool_start: '调用工具', tool_finish: '工具返回',
    task_update: '任务', steer: '转向', compact: '压缩上下文', retry: '重试模型',
    bash_start: '旁路命令', bash_end: '命令结束', ui_request: '等待确认', text_delta: '输出',
  };
  return names[evt.type] || evt.type;
}
function renderAgentDock() {
  const dock = $('agentDock');
  const roster = $('agentRoster');
  const timeline = $('agentTimeline');
  if (!dock || !roster || !timeline) return;
  const agents = Array.from(agentRun.agents.values());
  if (!agents.length) { dock.classList.add('hide'); return; }
  dock.classList.remove('hide');
  dock.classList.toggle('collapsed', !agentRun.expanded);
  const dockHead = $('agentDockHead');
  if (dockHead) dockHead.setAttribute('aria-expanded', agentRun.expanded ? 'true' : 'false');
  const completed = agents.filter((a) => ['completed', 'failed', 'canceled'].includes(a.status)).length;
  $('agentDockProgress').textContent = completed + '/' + agents.length;
  $('agentDockMeta').textContent = liveDockMeta();
  roster.innerHTML = '';
  agents.forEach((a) => {
    const row = el('button', 'agent-person ' + a.status);
    row.type = 'button';
    row.setAttribute('aria-label', a.name + '，' + (AGENT_STATUS[a.status] || a.status));
    const avatar = el('span', 'agent-avatar', (a.name || 'A').slice(0, 1).toUpperCase());
    row.appendChild(avatar);
    const copy = el('span', 'agent-person-copy');
    const title = el('span', 'agent-person-title');
    title.appendChild(el('b', '', a.name));
    title.appendChild(el('em', '', AGENT_ROLE[a.role] || a.role));
    copy.appendChild(title);
    copy.appendChild(el('small', '', a.title || a.detail || '准备任务'));
    row.appendChild(copy);
    const prog = a.total ? a.index + '/' + a.total : (AGENT_STATUS[a.status] || a.status);
    row.appendChild(el('span', 'agent-person-state', prog));
    row.onclick = () => { agentRun.timeline = true; agentRun.timelineAgent = a.id; timeline.classList.remove('hide'); renderAgentTimeline(a.id); };
    roster.appendChild(row);
  });
  if (agentRun.timeline) renderAgentTimeline(agentRun.timelineAgent);
  if (typeof renderLocalBoard === 'function') renderLocalBoard();
}
function renderAgentTimeline(agentID) {
  const box = $('agentTimeline');
  if (!box) return;
  box.innerHTML = '';
  const head = el('div', 'agent-timeline-head');
  head.appendChild(el('b', '', '调用过程'));
  const close = el('button', 'agent-timeline-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭调用过程');
  close.onclick = () => { agentRun.timeline = false; agentRun.timelineAgent = ''; box.classList.add('hide'); };
  head.appendChild(close);
  box.appendChild(head);
  const events = agentRun.events.filter((e) => !agentID || agentIdentity(e) === agentID);
  events.forEach((evt) => {
    const item = el('div', 'agent-event ' + (evt.status || ''));
    item.appendChild(el('i', 'agent-event-dot'));
    const copy = el('div', 'agent-event-copy');
    copy.appendChild(el('b', '', agentEventLabel(evt) + (evt.title ? ' · ' + evt.title : '')));
    if (evt.detail) copy.appendChild(el('small', '', evt.detail));
    if (evt.output) copy.appendChild(el('pre', '', evt.output));
    item.appendChild(copy);
    box.appendChild(item);
  });
}
function finishAgentRun(status) {
  if (!agentRun.endedAt) agentRun.endedAt = Date.now();
  completeCoordinator(status);
  for (const agent of agentRun.agents.values()) {
    if (agent.status === 'running' || agent.status === 'queued') agent.status = status || 'completed';
  }
  renderAgentDock();
}
setInterval(() => { if (agentRun.agents.size) renderAgentDock(); }, 1000);
if ($('agentDockHead')) $('agentDockHead').onclick = () => {
  agentRun.expanded = !agentRun.expanded;
  renderAgentDock();
};

function addBubble(role, content, extra) {
  const box = $('messages');
  const row = el('div', 'msg ' + role);
  if (role === 'user') {
    row.appendChild(el('div', 'bubble', content || ''));
  } else if (role === 'assistant') {
    row.appendChild(el('span', 'msg-ava', 'hw'));
    const b = el('div', 'bubble md');
    b.innerHTML = mdRender(content || '');
    row.appendChild(b);
  } else if (role === 'system') {
    row.appendChild(el('div', 'sys-line', content || ''));
  } else if (role === 'tool') {
    const b = el('div', 'bubble tool');
    b.textContent = (extra || 'tool') + '\n' + (content || '');
    row.appendChild(b);
  }
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
  return row;
}
/** 流式 assistant 气泡：累积 delta，节流重渲 markdown */
function beginAssistant() {
  const box = $('messages');
  const row = el('div', 'msg assistant');
  const ava = el('span', 'msg-ava loading');
  ava.textContent = 'hw';
  row.appendChild(ava);
  const b = el('div', 'bubble md streaming');
  row.appendChild(b);
  box.appendChild(row);
  let buf = '';
  let timer = 0;
  const paint = () => {
    timer = 0;
    b.innerHTML = mdRender(buf) + '<span class="caret"></span>';
    box.scrollTop = box.scrollHeight;
  };
  return {
    row,
    append(text) {
      buf += text;
      if (!timer) timer = setTimeout(paint, 50);
    },
    finalize(content) {
      if (timer) { clearTimeout(timer); timer = 0; }
      buf = content != null ? content : buf;
      b.classList.remove('streaming');
      ava.classList.remove('loading');
      b.innerHTML = mdRender(buf);
      box.scrollTop = box.scrollHeight;
    },
    remove() { row.remove(); },
  };
}
let localMode = false;
try { localMode = localStorage.getItem('hw-local') === '1'; } catch (_) {}
let localBusy = false;
let localRunID = '';
let localObjective = '';
let localStream = null;
let localBash = '';
let localAnswer = '';
let pendingAsk = null;
let interruptNow = false;
let pendingLocalRetry = '';
const localTasks = new Map();

function localComposerAction(state) {
  if (state.localMode) {
    if (!state.text) return 'need-text';
    if (state.localBusy) return 'follow';
    if (state.sending) return 'ignore';
    return 'start';
  }
  if (state.sending) return 'ignore';
  return 'cloud';
}

function noteSession(role, content) {
  if (!curWS || !curSess || !content) return;
  api('/workspaces/' + curWS.id + '/sessions/' + curSess.id + '/messages', {
    method: 'POST',
    body: JSON.stringify({ role, content }),
  }).catch((err) => {
    console.warn('note session failed', role, err && err.message);
  });
}

const TERMINAL_TASK = { done: 1, failed: 1, canceled: 1 };
let localPhase = '';
let localTick = 0;

function onLocalAgentEvent(evt) {
  if (evt.type === 'text_delta') {
    localAnswer += evt.output || '';
    localPhase = '输出中';
    if (!localStream) localStream = beginAssistant();
    localStream.append(evt.output || '');
    return true;
  }
  if (evt.type === 'text') {
    localAnswer = evt.output || localAnswer;
    if (!localStream) localStream = beginAssistant();
    localStream.finalize(evt.output || '');
    return false;
  }
  if (evt.type === 'agent_end') {
    localPhase = '';
    finishLocalRun(evt.status === 'failed' ? (evt.detail || 'failed') : '');
    return false;
  }
  if (evt.type === 'task_update') {
    const id = evt.step_id || evt.title || 'task';
    const prev = localTasks.get(id) || {};
    const status = evt.detail || evt.status || prev.status || 'pending';
    const now = Date.now();
    localTasks.set(id, {
      id,
      title: evt.output || prev.title || id,
      status,
      startedAt: prev.startedAt || (status === 'running' ? now : 0),
      endedAt: TERMINAL_TASK[status] ? (prev.endedAt || now) : 0,
    });
    if (status === 'running') localPhase = '执行 ' + (evt.output || prev.title || id);
    else if (TERMINAL_TASK[status]) localPhase = '';
    return false;
  }
  if (evt.type === 'tool_start') {
    localPhase = '调用 ' + (evt.title || '工具');
    return false;
  }
  if (evt.type === 'tool_end' || evt.type === 'retry' || evt.type === 'compact') {
    localPhase = '';
    return false;
  }
  if (evt.type === 'ui_request') {
    localPhase = '等待确认';
    pendingAsk = { id: evt.step_id || '', prompt: evt.output || evt.detail || '请确认' };
    const dock = $('agentDock');
    if (dock) {
      dock.classList.remove('hide');
      dock.classList.remove('collapsed');
      agentRun.expanded = true;
    }
    return false;
  }
  if (evt.type === 'bash_start') {
    localPhase = '旁路命令';
    localBash = evt.output || evt.detail || 'running';
    return false;
  }
  if (evt.type === 'bash_end') {
    localPhase = '';
    localBash = '';
    return false;
  }
  return false;
}

function formatTaskDur(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

function taskDurMs(t, now) {
  if (!t.startedAt) return 0;
  return (t.endedAt || now) - t.startedAt;
}

function updateTaskDurations() {
  const now = Date.now();
  document.querySelectorAll('[data-task-dur]').forEach((node) => {
    const t = localTasks.get(node.getAttribute('data-task-dur'));
    if (!t) return;
    node.textContent = t.startedAt ? formatTaskDur(taskDurMs(t, now)) : '';
  });
  const meta = $('agentDockMeta');
  if (meta) meta.textContent = liveDockMeta();
}

function liveDockMeta() {
  const agents = Array.from(agentRun.agents.values());
  const running = agents.filter((a) => a.status === 'running').length;
  const elapsed = formatElapsed((agentRun.endedAt || Date.now()) - agentRun.startedAt);
  return (localPhase ? localPhase + ' · ' : '') + elapsed + ' · ' + running + ' 运行';
}

function startLocalTick() {
  stopLocalTick();
  localTick = setInterval(updateTaskDurations, 1000);
}

function stopLocalTick() {
  if (localTick) { clearInterval(localTick); localTick = 0; }
}

function renderLocalBoard() {
  const tasks = $('agentTasks');
  if (tasks) {
    tasks.innerHTML = '';
    const now = Date.now();
    for (const t of localTasks.values()) {
      const row = el('div', 'agent-task ' + (t.status || ''));
      row.appendChild(el('i'));
      row.appendChild(el('b', '', t.title || t.id));
      const dur = el('em', 'agent-task-dur', t.startedAt ? formatTaskDur(taskDurMs(t, now)) : '');
      dur.setAttribute('data-task-dur', t.id);
      row.appendChild(dur);
      row.appendChild(el('em', 'agent-task-state', t.status || ''));
      tasks.appendChild(row);
    }
  }
  const bash = $('agentBashLine');
  if (bash) bash.textContent = localBash ? '命令运行中：' + localBash : '';
  const ask = $('agentAsk');
  if (!ask) return;
  ask.innerHTML = '';
  if (!pendingAsk) {
    ask.classList.add('hide');
    return;
  }
  ask.classList.remove('hide');
  ask.appendChild(el('p', '', pendingAsk.prompt));
  const row = el('div', 'agent-ask-row');
  const input = el('input');
  input.type = 'text';
  input.placeholder = '补充说明，可留空';
  input.setAttribute('aria-label', '确认说明');
  const yes = el('button', '', '同意');
  const no = el('button', '', '拒绝');
  yes.type = 'button';
  no.type = 'button';
  yes.onclick = () => resolveAsk(true, input.value);
  no.onclick = () => resolveAsk(false, input.value);
  row.appendChild(input);
  row.appendChild(yes);
  row.appendChild(no);
  ask.appendChild(row);
}

function resolveAsk(ok, text) {
  if (!pendingAsk) return;
  const id = pendingAsk.id;
  pendingAsk = null;
  renderLocalBoard();
  if (!id) {
    addBubble('system', '确认编号缺失，没法回给本机。');
    return;
  }
  if (!sendFrame({ k: 'agent-ui', id, msg: text || '', code: ok ? 0 : 1, err: ok ? '' : 'denied' })) {
    addBubble('system', '未接入本机，确认没发出去。');
  }
}

function sendLocalNote(kind) {
  const input = $('agentSteer');
  const text = input ? input.value.trim() : '';
  if (!text) return;
  if (!sendFrame({ k: kind, msg: text })) {
    addBubble('system', '未接入本机，这条没发出去。');
    return;
  }
  input.value = '';
  addBubble('system', (kind === 'agent-steer' ? '已转向：' : '已排队：') + text);
}

function finishLocalRun(errText) {
  if (!localBusy && !localStream) return;
  const answer = localAnswer;
  localAnswer = '';
  localBusy = false;
  sending = false;
  setSendUI(false);
  stopLocalTick();
  updateTaskDurations();
  if (localStream) {
    localStream.finalize(null);
    localStream = null;
  }
  if (answer) noteSession('assistant', answer);
  if (errText === 'session busy; follow-up queued') {
    addBubble('system', '本机正忙，目标已改排队，当前任务结束后继续。');
  } else if (errText) {
    addBubble('system', '本机任务结束：' + errText);
    noteSession('system', '本机任务结束：' + errText);
  }
  const retryGoal = pendingLocalRetry;
  pendingLocalRetry = '';
  if (retryGoal) {
    startLocalRun(retryGoal);
  }
}

async function startLocalRun(text) {
  localObjective = text;
  localRunID = newToolId();
  localAnswer = '';
  localBusy = true;
  sending = true;
  localTasks.clear();
  pendingAsk = null;
  localBash = '';
  localPhase = '准备中';
  setSendUI(true);
  startLocalTick();
  try {
    if (!(await ensureChatContext())) addBubble('system', '没有会话，这次执行记不下来。');
  } catch (err) {
    addBubble('system', '没能准备会话：' + err.message);
  }
  resetAgentRun(localRunID);
  recordAgentEvent({
    type: 'agent_start', status: 'running', agent_id: 'local', agent_name: '本机',
    agent_role: 'operator', title: text.slice(0, 80),
  });
  addBubble('user', text);
  noteSession('user', text);
  localStream = beginAssistant();
  // 本机回路与云端 chat 同一份 model 口径，协议走 agentLoopModelSelection()：Auto（model=default）不带协议，
  // 只发用户显式点选过的协议，其余交服务端按 fresh grant / 已保存会话解析，绝不夹带旧选择。
  const loopSel = agentLoopModelSelection();
  let brief = '';
  if (curWS) {
    try {
      const r = await api('/agent-context', {
        method: 'POST',
        body: JSON.stringify({
          workspace_id: curWS.id,
          content: text,
          kb_global: $('kbGlobal').checked,
          kb_project: $('kbProject').checked,
          skills: selectedSkills.map((s) => s.id),
        }),
      });
      brief = (r && r.brief) || '';
    } catch (err) {
      console.warn('agent context failed', err && err.message);
    }
  }
  if (!sendFrame({ k: 'agent-loop', id: localRunID, msg: text, model: loopSel.model, protocol: loopSel.protocol, brief })) {
    finishLocalRun('没有连上本机。先在工具里接入。');
  }
}

function bindLocalAgent() {
  const mode = $('btnLocalMode');
  if (mode) {
    mode.classList.toggle('on', localMode);
    mode.setAttribute('aria-pressed', localMode ? 'true' : 'false');
    mode.onclick = () => {
      localMode = !localMode;
      mode.classList.toggle('on', localMode);
      mode.setAttribute('aria-pressed', localMode ? 'true' : 'false');
      try { localStorage.setItem('hw-local', localMode ? '1' : '0'); } catch (_) {}
    };
  }
  const steer = $('agentSteerBtn');
  const follow = $('agentFollowBtn');
  const abort = $('agentAbortBtn');
  const bash = $('agentBashBtn');
  const bashAbort = $('agentBashAbortBtn');
  const interrupt = $('agentInterruptBtn');
  const retry = $('agentRetryBtn');
  const queue = $('agentQueueBtn');
  if (queue) queue.onclick = () => {
    if (typeof NodeQueueRecovery === 'undefined') return;
    NodeQueueRecovery.open();
  };
  if (steer) steer.onclick = () => sendLocalNote('agent-steer');
  if (follow) follow.onclick = () => sendLocalNote('agent-follow');
  if (abort) abort.onclick = () => {
    if (!localRunID || !sendFrame({ k: 'agent-abort', id: localRunID })) {
      addBubble('system', '没有可停止的本机任务。');
      return;
    }
    addBubble('system', '已请求停止。');
  };
  const steerInput = $('agentSteer');
  if (steerInput) {
    steerInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      sendLocalNote(e.shiftKey ? 'agent-follow' : 'agent-steer');
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !localBusy) return;
    if (!localRunID || !sendFrame({ k: 'agent-abort', id: localRunID })) return;
    addBubble('system', '已请求停止。');
  });
  if (bash) bash.onclick = () => {
    const input = $('agentSteer');
    const text = input ? input.value.trim() : '';
    if (!text) {
      addBubble('system', '先写下要在本机跑的命令。');
      return;
    }
    if (!sendFrame({ k: 'agent-bash', cmd: text })) {
      addBubble('system', '未接入本机，命令没发出去。');
      return;
    }
    input.value = '';
    addBubble('system', '已另开命令：' + text);
  };
  if (bashAbort) bashAbort.onclick = () => {
    if (!sendFrame({ k: 'agent-bash-abort' })) addBubble('system', '未接入本机，停不了命令。');
  };
  const paintInterrupt = () => {
    if (!interrupt) return;
    interrupt.textContent = interruptNow ? '立刻打断' : '等工具结束';
    interrupt.classList.toggle('on', interruptNow);
    interrupt.setAttribute('aria-pressed', interruptNow ? 'true' : 'false');
  };
  paintInterrupt();
  if (interrupt) interrupt.onclick = () => {
    interruptNow = !interruptNow;
    paintInterrupt();
    const modeName = interruptNow ? 'immediate' : 'wait';
    if (!sendFrame({ k: 'agent-mode', msg: modeName })) addBubble('system', '未接入本机，打断方式没发出去。');
  };
  if (retry) retry.onclick = () => {
    if (!localObjective) {
      addBubble('system', '还没有可重试的本机目标。');
      return;
    }
    if (localBusy) {
      pendingLocalRetry = localObjective;
      if (!sendFrame({ k: 'agent-abort', id: localRunID })) {
        pendingLocalRetry = '';
        addBubble('system', '没有可停止的本机任务。');
        return;
      }
      addBubble('system', '已请求停止，结束后自动重试。');
      return;
    }
    startLocalRun(localObjective);
  };
  // 重复的 agentSteer keydown 绑定已删除：上面的 handler 已覆盖 Enter / Shift+Enter 两种语义，
  // 同时注册两个会让一次回车发两条转向。快照里此处的重复 const 也使整文件解析失败。
}
bindLocalAgent();

function clearMessages() {
  $('messages').innerHTML = '';
}

// ---------- Welcome / 空态 ----------
const WELCOME_CHIPS = [
  { label: '执行命令', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>', text: '在远程主机执行：' },
  { label: '分析日志', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>', text: '读取远程主机日志并分析异常：' },
  { label: '排查故障', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m10.29 3.86-8.47 14.14A2 2 0 0 0 3.53 21h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>', text: '远程主机出现异常，帮我排查：' },
  { label: '查知识库', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>', text: '根据知识库回答：' },
];


function timeGreeting() {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 12) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

function buildWelcome() {
  const g = $('welcomeGreet');
  const s = $('welcomeSub');
  const c = $('welcomeChips');
  if (g) g.textContent = timeGreeting();
  if (s) s.textContent = curWS ? '在「' + curWS.name + '」中选择或创建会话' : '选择或创建一个工作区开始';
  if (c) {
    c.innerHTML = '';
    WELCOME_CHIPS.forEach((chip) => {
      const btn = el('button', 'welcome-chip');
      btn.type = 'button';
      btn.innerHTML = chip.icon;
      btn.appendChild(document.createTextNode(' ' + chip.label));
      btn.onclick = () => {
        const inp = $('input');
        if (inp) { inp.value = chip.text; inp.focus(); }
      };
      c.appendChild(btn);
    });
  }
}

function showWelcome() {
  const w = $('welcome');
  const m = $('messages');
  if (!w) return;
  buildWelcome();
  w.classList.remove('hide');
  if (m) m.classList.add('hide');
}

function hideWelcome() {
  const w = $('welcome');
  const m = $('messages');
  if (w) w.classList.add('hide');
  if (m) m.classList.remove('hide');
}

// ---------- 工作区 / 会话（Cursor 风格树） ----------
const FOLDER_SVG = '<svg class="ws-folder-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';
const CHEV_SVG = '<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>';
const PIN_SVG = '<svg class="pin-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';

let wsCache = [];
let sessByWS = new Map(); // wsId -> sessions[]
let ctxTarget = null; // { kind:'ws'|'sess', ws, sess? }
let railLoadSeq = 0;

function loadCollapsedSet() {
  try {
    const raw = localStorage.getItem('handwave.ws.collapsed');
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (_) {
    return new Set();
  }
}
function saveCollapsedSet(set) {
  try { localStorage.setItem('handwave.ws.collapsed', JSON.stringify([...set])); } catch (_) {}
}
let collapsedWS = loadCollapsedSet();

async function refreshWorkspaces() {
  await refreshRail();
}
async function refreshSessions() {
  // 发完消息后只刷新当前工作区会话，避免整树闪烁
  if (curWS) await refreshRailWS(curWS.id);
  else await refreshRail();
}

/** 全量拉取后一次性重绘（先拉数据，再替换 DOM，避免清空等待造成闪烁） */
async function refreshRail() {
  const box = $('wsTree');
  if (!box) return;
  const seq = ++railLoadSeq;
  let list;
  try {
    list = await api('/workspaces');
  } catch (err) {
    if (seq !== railLoadSeq) return;
    box.replaceChildren(el('div', 'hint', '加载失败'));
    return;
  }
  if (seq !== railLoadSeq) return;
  wsCache = list || [];
  if (!wsCache.length) {
    sessByWS.clear();
    box.replaceChildren(el('div', 'hint', '暂无工作区，点上方「新建工作区」'));
    return;
  }
  const next = new Map();
  await Promise.all(wsCache.map(async (w) => {
    try {
      next.set(w.id, (await api('/workspaces/' + w.id + '/sessions')) || []);
    } catch (_) {
      next.set(w.id, sessByWS.get(w.id) || []);
    }
  }));
  if (seq !== railLoadSeq) return;
  sessByWS = next;
  syncCurSessFromCache();
  paintRail();
}

/** 只刷新某个工作区的会话列表并局部重绘 */
async function refreshRailWS(wsId) {
  if (!wsId) return;
  try {
    const sess = await api('/workspaces/' + wsId + '/sessions');
    sessByWS.set(wsId, sess || []);
  } catch (_) {
    return;
  }
  syncCurSessFromCache();
  const folder = document.querySelector('.ws-folder[data-ws-id="' + wsId + '"]');
  const w = wsCache.find((x) => x.id === wsId);
  if (!folder || !w) {
    paintRail();
    return;
  }
  const kids = folder.querySelector('.ws-folder-kids');
  if (!kids) {
    paintRail();
    return;
  }
  const sessions = sessByWS.get(wsId) || [];
  const frag = document.createDocumentFragment();
  if (!sessions.length) frag.appendChild(el('div', 'hint', '暂无会话'));
  else sessions.forEach((s) => frag.appendChild(renderSessRow(w, s)));
  kids.replaceChildren(frag);
  syncRailSelection();
}

function syncCurSessFromCache() {
  if (!curWS || !curSess) return;
  const updated = (sessByWS.get(curWS.id) || []).find((x) => x.id === curSess.id);
  if (updated) {
    curSess = updated;
    $('chatTitle').textContent = curWS.name + ' · ' + (updated.title || '会话');
  }
}

function paintRail() {
  const box = $('wsTree');
  if (!box) return;
  if (!wsCache.length) {
    box.replaceChildren(el('div', 'hint', '暂无工作区，点上方「新建工作区」'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const w of wsCache) {
    frag.appendChild(renderWSFolder(w, sessByWS.get(w.id) || []));
  }
  box.replaceChildren(frag);
}

/** 仅更新选中态 / 展开态，不重拉不重绘整树 */
function syncRailSelection() {
  if (curWS && collapsedWS.has(curWS.id)) {
    collapsedWS.delete(curWS.id);
    saveCollapsedSet(collapsedWS);
  }
  document.querySelectorAll('.ws-folder').forEach((folder) => {
    const wsId = folder.dataset.wsId;
    const collapsed = collapsedWS.has(wsId);
    folder.classList.toggle('collapsed', collapsed);
    folder.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    const frow = folder.querySelector('.ws-folder-row');
    if (frow) frow.classList.toggle('on', !!(curWS && curWS.id === wsId && !curSess));
    folder.querySelectorAll('.ws-sess-row').forEach((row) => {
      row.classList.toggle('on', !!(curSess && curWS && curWS.id === wsId && row.dataset.sessId === curSess.id));
    });
  });
}

/** 设备列表变化时只改副标题，避免整树闪烁 */
function syncRailDeviceLabels() {
  document.querySelectorAll('.ws-folder').forEach((folder) => {
    const w = wsCache.find((x) => x.id === folder.dataset.wsId);
    if (!w) return;
    const sub = folder.querySelector('.ws-folder-row .sub');
    if (sub) sub.textContent = wsDeviceLabel(w);
  });
}

function renderWSFolder(w, sessions) {
  const folder = el('div', 'ws-folder' + (collapsedWS.has(w.id) ? ' collapsed' : ''));
  folder.dataset.wsId = w.id;
  folder.setAttribute('role', 'treeitem');
  folder.setAttribute('aria-expanded', collapsedWS.has(w.id) ? 'false' : 'true');

  const row = el('button', 'ws-folder-row' + (curWS && curWS.id === w.id && !curSess ? ' on' : ''));
  row.type = 'button';
  row.innerHTML = CHEV_SVG + FOLDER_SVG;
  row.appendChild(el('span', 'label', w.name));
  row.appendChild(el('span', 'sub', wsDeviceLabel(w)));
  row.onclick = (e) => {
    const isChev = e.target.closest && e.target.closest('.chev');
    if (isChev) {
      toggleWSCollapsed(w.id);
      return;
    }
    if (collapsedWS.has(w.id)) {
      collapsedWS.delete(w.id);
      saveCollapsedSet(collapsedWS);
    }
    selectWorkspace(w, { keepMessages: false });
  };
  row.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openRailCtxMenu(e.clientX, e.clientY, { kind: 'ws', ws: w });
  };
  folder.appendChild(row);

  const kids = el('div', 'ws-folder-kids');
  kids.setAttribute('role', 'group');
  if (!sessions.length) kids.appendChild(el('div', 'hint', '暂无会话'));
  else sessions.forEach((s) => kids.appendChild(renderSessRow(w, s)));
  folder.appendChild(kids);
  return folder;
}

function renderSessRow(w, s) {
  const row = el('button', 'ws-sess-row'
    + (s.pinned ? ' pinned' : '')
    + (curSess && curSess.id === s.id && curWS && curWS.id === w.id ? ' on' : ''));
  row.type = 'button';
  row.dataset.wsId = w.id;
  row.dataset.sessId = s.id;
  row.appendChild(el('span', 'ws-sess-dot'));
  row.appendChild(el('span', 'label', s.title || '会话'));
  if (s.pinned) {
    const pin = document.createElement('span');
    pin.innerHTML = PIN_SVG;
    if (pin.firstChild) row.appendChild(pin.firstChild);
  }
  row.onclick = () => selectSessionInWS(w, s);
  row.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openRailCtxMenu(e.clientX, e.clientY, { kind: 'sess', ws: w, sess: s });
  };
  return row;
}

function toggleWSCollapsed(wsId) {
  if (collapsedWS.has(wsId)) collapsedWS.delete(wsId);
  else collapsedWS.add(wsId);
  saveCollapsedSet(collapsedWS);
  const folder = document.querySelector('.ws-folder[data-ws-id="' + wsId + '"]');
  if (folder) {
    folder.classList.toggle('collapsed', collapsedWS.has(wsId));
    folder.setAttribute('aria-expanded', collapsedWS.has(wsId) ? 'false' : 'true');
  }
}

/** 工作区绑定设备展示：别名/主机名优先，其次在线设备表，再退到指纹 */
function wsDeviceLabel(w) {
  if (!w || !w.device_fp) return '未绑定';
  if (w.device_name) return w.device_name;
  const d = (typeof devices !== 'undefined' ? devices : []).find((x) => x.fp === w.device_fp);
  if (d) return d.name || d.hostname || w.device_fp.slice(0, 8);
  return w.device_fp.slice(0, 8);
}

async function selectWorkspace(w, opts = {}) {
  curWS = w;
  curSess = null;
  $('chatTitle').textContent = w.name;
  syncRailSelection();
  await refreshKB();
  await loadProjectTree(); // load project file tree for the workspace
  openApplyPendingSSE(); // subscribe to apply_code confirmations
  if (!opts.keepMessages) {
    clearMessages();
    showWelcome();
  }
  if (window.innerWidth <= 780) closeSheets();
}

// 会话身份由服务端 sessMeta 记录；UI 只做可见同步，改模型请另开会话。
function applySessionBinding(s) {
  sessionBinding = (s && s.model) ? { model: s.model, protocol: s.protocol || '' } : null;
  if (!sessionBinding) { syncModelStatus(); return; }
  const protocols = modelProtocols(sessionBinding.model);
  if (protocols.length) {
    $('modelSel').value = sessionBinding.model;
    modelAuto = false;
    modelProtocol = protocols.includes(sessionBinding.protocol) ? sessionBinding.protocol : (protocols.length === 1 ? protocols[0] : '');
    syncAutoToggle();
    setModelLabel();
    renderModelList();
  }
  syncModelStatus();
}

async function selectSessionInWS(w, s) {
  if (!curWS || curWS.id !== w.id) {
    curWS = w;
    await refreshKB();
  }
  await selectSession(s);
}

async function selectSession(s) {
  curSess = s;
  applySessionBinding(s);
  $('chatTitle').textContent = (curWS ? curWS.name + ' · ' : '') + (s.title || '会话');
  syncRailSelection();
  hideWelcome();
  clearMessages();
  agentRun.agents.clear();
  agentRun.events = [];
  agentRun.timeline = false;
  agentRun.timelineAgent = '';
  $('agentTimeline').classList.add('hide');
  renderAgentDock();
  const msgs = await api('/workspaces/' + curWS.id + '/sessions/' + s.id + '/messages');
  if (msgs.length) {
    const times = msgs.flatMap((m) => Array.isArray(m.events) ? m.events.map((e) => Date.parse(e.ts)).filter(Number.isFinite) : []);
    agentRun.startedAt = times.length ? Math.min(...times) : Date.now();
    agentRun.endedAt = times.length ? Math.max(...times) : 0;
  }
  if (!msgs.length) addBubble('system', '新会话。连接远程主机后可启用工具调用。');
  for (const m of msgs) {
    if (Array.isArray(m.events)) m.events.forEach(recordAgentEvent);
    if (m.role === 'tool') continue;
    if (m.role === 'assistant') {
      if (m.tool_calls && m.tool_calls.length) {
        for (const tc of m.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function && tc.function.arguments || '{}'); } catch (_) {}
          const card = makeToolCard(tc.function && tc.function.name, args);
          const tr = msgs.find((x) => x.role === 'tool' && x.tool_call_id === tc.id);
          card.setOut(tr ? tr.content : '');
          card.finish(!(tr && /错误|未连接|超时/.test(tr.content)), '');
          $('messages').appendChild(card.el);
        }
      }
      if (m.content) addBubble('assistant', m.content);
    } else {
      const skillNames = (m.skills || []).map((skill) => skill.name);
      addBubble(m.role === 'user' ? 'user' : 'system', (m.content || '') + (skillNames.length ? '\n\n技能：' + skillNames.join('、') : ''));
    }
  }
  $('messages').scrollTop = $('messages').scrollHeight;
  if (window.innerWidth <= 780) closeSheets();
}

async function createNewWorkspace() {
  const name = await uiPrompt('给工作区起个名字', '默认工作区', '新建工作区');
  if (name == null) return;
  const w = await api('/workspaces', { method: 'POST', body: JSON.stringify({ name: name.trim() || '默认工作区' }) });
  collapsedWS.delete(w.id);
  saveCollapsedSet(collapsedWS);
  await refreshRail();
  await selectWorkspace(w);
}

async function createNewSession() {
  if (!curWS) { await uiAlert('请先创建或选择工作区'); return; }
  const s = await api('/workspaces/' + curWS.id + '/sessions', { method: 'POST', body: JSON.stringify({}) });
  collapsedWS.delete(curWS.id);
  saveCollapsedSet(collapsedWS);
  await refreshRailWS(curWS.id);
  await selectSession(s);
}

$('btnNewWS').onclick = () => createNewWorkspace();
$('btnNewSess').onclick = () => createNewSession();

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
    e.preventDefault();
    createNewSession();
  }
});

// ---------- 侧栏右键菜单 ----------
function openRailCtxMenu(x, y, target) {
  const menu = $('railCtxMenu');
  if (!menu) return;
  ctxTarget = target;
  const scope = target.kind;
  menu.querySelectorAll('[data-scope]').forEach((node) => {
    const scopes = (node.getAttribute('data-scope') || '').split(/\s+/);
    node.classList.toggle('hide', !scopes.includes(scope));
  });
  const pinBtn = menu.querySelector('[data-act="pin"] [data-label]');
  if (pinBtn && target.sess) pinBtn.textContent = target.sess.pinned ? '取消置顶' : '置顶';
  menu.classList.remove('hide');
  menu.setAttribute('aria-hidden', 'false');
  const pad = 8;
  const mw = menu.offsetWidth || 168;
  const mh = menu.offsetHeight || 120;
  let left = x;
  let top = y;
  if (left + mw > window.innerWidth - pad) left = window.innerWidth - mw - pad;
  if (top + mh > window.innerHeight - pad) top = window.innerHeight - mh - pad;
  if (left < pad) left = pad;
  if (top < pad) top = pad;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}
function closeRailCtxMenu() {
  const menu = $('railCtxMenu');
  if (!menu) return;
  menu.classList.add('hide');
  menu.setAttribute('aria-hidden', 'true');
  ctxTarget = null;
}
async function patchSession(wsId, sessId, body) {
  return api('/workspaces/' + wsId + '/sessions/' + sessId, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}
async function patchWorkspace(wsId, body) {
  return api('/workspaces/' + wsId, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}
(function bindRailCtxMenu() {
  const menu = $('railCtxMenu');
  if (!menu) return;
  menu.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || !ctxTarget) return;
    const act = btn.getAttribute('data-act');
    const target = ctxTarget;
    closeRailCtxMenu();
    try {
      if (target.kind === 'sess') {
        const { ws, sess } = target;
        if (act === 'pin') {
          const updated = await patchSession(ws.id, sess.id, { pinned: !sess.pinned });
          if (curSess && curSess.id === sess.id) curSess = updated;
          await refreshRailWS(ws.id);
        } else if (act === 'rename') {
          const name = await uiPrompt('会话名称', sess.title || '', '重命名会话');
          if (name == null) return;
          const updated = await patchSession(ws.id, sess.id, { title: name.trim() || sess.title });
          if (curSess && curSess.id === sess.id) {
            curSess = updated;
            $('chatTitle').textContent = (curWS ? curWS.name + ' · ' : '') + (updated.title || '会话');
          }
          await refreshRailWS(ws.id);
        } else if (act === 'delete') {
          const ok = await uiConfirm('确定删除会话「' + (sess.title || '会话') + '」？', '删除会话');
          if (!ok) return;
          await api('/workspaces/' + ws.id + '/sessions/' + sess.id, { method: 'DELETE' });
          if (curSess && curSess.id === sess.id) {
            curSess = null;
            clearMessages();
            if (curWS) addBubble('system', '工作区「' + curWS.name + '」。创建或选择会话开始对话。');
          }
          await refreshRailWS(ws.id);
        }
      } else if (target.kind === 'ws') {
        const { ws } = target;
        if (act === 'newSess') {
          const sess = await api('/workspaces/' + ws.id + '/sessions', {
            method: 'POST',
            body: JSON.stringify({ title: '' }),
          });
          selectWorkspace(ws, { keepMessages: false });
          selectSessionInWS(ws, sess);
          await refreshRailWS(ws.id);
        } else if (act === 'rename') {
          const name = await uiPrompt('工作区名称', ws.name || '', '重命名工作区');
          if (name == null) return;
          const trimmed = name.trim();
          if (!trimmed) return;
          const updated = await patchWorkspace(ws.id, { name: trimmed });
          const idx = wsCache.findIndex((x) => x.id === ws.id);
          if (idx >= 0) wsCache[idx] = updated;
          if (curWS && curWS.id === ws.id) {
            curWS = updated;
            $('chatTitle').textContent = curSess
              ? updated.name + ' · ' + (curSess.title || '会话')
              : updated.name;
          }
          const label = document.querySelector('.ws-folder[data-ws-id="' + ws.id + '"] .ws-folder-row .label');
          if (label) label.textContent = updated.name;
          else await refreshRail();
        } else if (act === 'delete') {
          const ok = await uiConfirm('确定删除工作区「' + (ws.name || '') + '」及其全部会话？', '删除工作区');
          if (!ok) return;
          await api('/workspaces/' + ws.id, { method: 'DELETE' });
          if (curWS && curWS.id === ws.id) {
            curWS = null;
            curSess = null;
            clearMessages();
            addBubble('system', '工作区已删除。可新建或选择其他工作区。');
          }
          await refreshRail();
        }
      }
    } catch (err) {
      await uiAlert(err.message || String(err));
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (!menu.classList.contains('hide') && !menu.contains(e.target)) closeRailCtxMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeRailCtxMenu();
  });
  window.addEventListener('resize', () => closeRailCtxMenu());
  window.addEventListener('scroll', () => closeRailCtxMenu(), true);
})();

/** 贴图/发送前确保有工作区与会话；缺会话时自动新建 */
async function ensureChatContext() {
  if (!curWS) {
    const list = await api('/workspaces');
    if (list && list.length) {
      await selectWorkspace(list[0]);
    } else {
      const w = await api('/workspaces', { method: 'POST', body: JSON.stringify({ name: '默认工作区' }) });
      await refreshRail();
      await selectWorkspace(w);
    }
  }
  if (!curSess) {
    const s = await api('/workspaces/' + curWS.id + '/sessions', { method: 'POST', body: JSON.stringify({}) });
    await refreshRailWS(curWS.id);
    await selectSession(s);
  }
  return !!(curWS && curSess);
}

// ---------- 知识库 ----------
async function refreshKB() {
  const fill = async (elId, scope) => {
    const box = $(elId);
    box.innerHTML = '';
    const q = scope === 'global' ? '/kb?scope=global' : '/kb?scope=project&ws=' + encodeURIComponent(curWS ? curWS.id : '');
    if (scope === 'project' && !curWS) {
      box.appendChild(el('div', 'hint', '先选工作区'));
      return;
    }
    const docs = await api(q);
    if (!docs.length) {
      box.appendChild(el('div', 'hint', '空'));
      return;
    }
    for (const d of docs) {
      const row = el('div', 'kb-row');
      row.appendChild(el('b', '', d.name));
      row.appendChild(el('span', '', d.chunk_n + ' 块'));
      const del = el('button', 'iconbtn sm', '×');
      del.onclick = async () => {
        await api('/kb/' + d.id + '?scope=' + scope + '&ws=' + (curWS ? curWS.id : ''), { method: 'DELETE' });
        refreshKB();
      };
      row.appendChild(del);
      box.appendChild(row);
    }
  };
  await fill('kbGlob', 'global');
  await fill('kbProj', 'project');
}
async function uploadKB(scope, file) {
  if (!file) return;
  if (scope === 'project' && !curWS) { await uiAlert('请先选择工作区'); return; }
  const fd = new FormData();
  fd.append('file', file);
  const q = scope === 'global' ? '/kb?scope=global' : '/kb?scope=project&ws=' + curWS.id;
  await api(q, { method: 'POST', body: fd });
  refreshKB();
}
$('kbGlobFile').onchange = (e) => { uploadKB('global', e.target.files[0]); e.target.value = ''; };
$('kbProjFile').onchange = (e) => { uploadKB('project', e.target.files[0]); e.target.value = ''; };

// ---------- 连接 hub / 设备 ----------
function wsURL() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return proto + location.host + '/ws?role=ctl';
}
function sendSig(o) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(o));
  return true;
}
function sendFrame(o) {
  const js = JSON.stringify(o);
  if (dc && dc.readyState === 'open') {
    try { dc.send(js); return true; } catch (_) {}
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ k: 'dc', d: b64enc(enc.encode(js)) }));
  return true;
}
function connectHub() {
  if (ws) return;
  setConnState('连接 hub…', 'busy');
  ws = new WebSocket(wsURL(), 'handwave');
  ws.onopen = () => {
    setConnState('已连 hub', 'on');
    sendSig({ k: 'hello', fp: myFP, relay: true });
    sendSig({ k: 'status' });
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (ws) sendSig({ k: 'status' }); }, 5000);
  };
  ws.onmessage = (e) => { try { onSig(JSON.parse(e.data)); } catch (_) {} };
  ws.onclose = () => {
    ws = null; paired = false; closePC();
    setConnState('hub 已断开', 'off');
    clearInterval(pollTimer);
  };
  ws.onerror = () => setConnState('hub 连接失败', 'off');
}
function closePC() {
  if (pc) { try { pc.close(); } catch (_) {} }
  pc = null; dc = null; remoteSet = false; pendingCands = [];
}
function ensurePC() {
  if (pc) return pc;
  pc = new RTCPeerConnection({ iceServers: STUN });
  pc.onicecandidate = (e) => {
    if (e.candidate) sendSig({ k: 'cand', cand: JSON.stringify(e.candidate.toJSON()) });
  };
  pc.ondatachannel = (ev) => {
    const ch = ev.channel;
    ch.binaryType = 'arraybuffer';
    ch.onmessage = (m) => {
      const txt = typeof m.data === 'string' ? m.data : dec.decode(m.data);
      try { onFrame(JSON.parse(txt)); } catch (_) {}
    };
    ch.onclose = () => { if (dc === ch) dc = null; };
    dc = ch;
  };
  return pc;
}
async function handleOffer(sdp) {
  try {
    const p = ensurePC();
    await p.setRemoteDescription({ type: 'offer', sdp });
    remoteSet = true;
    for (const c of pendingCands) { try { await p.addIceCandidate(c); } catch (_) {} }
    pendingCands = [];
    const ans = await p.createAnswer();
    await p.setLocalDescription(ans);
    sendSig({ k: 'sdp', sdp: ans.sdp });
  } catch (_) {}
}
function onSig(s) {
  switch (s.k) {
    case 'paired':
      paired = true; helloDone = false;
      setConnState('配对中…', 'busy');
      $('btnDisconnectDev').disabled = false;
      $('btnReconnect').disabled = false;
      clearTimeout(helloTimer);
      helloTimer = setTimeout(() => {
        if (paired && !helloDone) {
          addBubble('system', '目标机长时间无响应');
          sendSig({ k: 'bye' });
          paired = false;
        }
      }, 60000);
      break;
    case 'unpaired':
      paired = false; helloDone = false; closePC();
      setConnState('已连 hub · 未配对', 'on');
      $('feat-card') && null;
      $('devFeat').classList.add('hide');
      addBubble('system', '配对已结束' + (s.err ? '：' + s.err : ''));
      break;
    case 'pair-fail':
      addBubble('system', '接入失败：' + (s.err || ''));
      break;
    case 'status':
      try {
        const oldDevices = devices.slice();
        devices = JSON.parse(s.d || '[]');
        renderDevices();
        syncRailDeviceLabels();
        // Toast notification for new pending devices
        const newPending = devices.filter(n => n.state === 'pending' &&
          !oldDevices.some(o => o.nid === n.nid && o.state === 'pending'));
        if (newPending.length > 0) {
          for (const n of newPending) {
            showToast('设备接入请求: ' + (n.hostname || n.fp), 'info', 6000);
          }
        }
      } catch (_) {}
      break;
    case 'sdp': if (s.sdp) handleOffer(s.sdp); break;
    case 'cand':
      try {
        const init = JSON.parse(s.cand);
        if (remoteSet && pc) pc.addIceCandidate(init).catch(() => {});
        else pendingCands.push(init);
      } catch (_) {}
      break;
    case 'dc':
      if (s.d) {
        try { onFrame(JSON.parse(dec.decode(b64dec(s.d)))); } catch (_) {}
      }
      break;
  }
}
function onFrame(f) {
  if (f.k === 'node-hello') {
    clearTimeout(helloTimer);
    helloDone = true;
    const i = f.info || {};
    setConnState('已连接 · ' + (i.hostname || 'remote'), 'on');
    const feat = $('devFeat');
    feat.classList.remove('hide');
    feat.innerHTML = '';
    feat.appendChild(el('div', '', (i.user || '?') + '@' + (i.hostname || '?')));
    feat.appendChild(el('div', 'muted', (i.os || '?') + '/' + (i.arch || '?') + ' · node ' + (i.version || '?')));
    feat.appendChild(el('div', 'muted mono', '设备 ' + (f.fp || '')));
    const caps = Array.isArray(i.caps) ? i.caps : [];
    feat.appendChild(el('div', 'muted', caps.includes('agent-loop') ? '本机 Agent · 任务板 · 转向/确认' : (caps.includes('agent-task') ? 'Agent 任务 · 进度事件 · 主动取消' : '命令与文件工具')));
    if (typeof localTasks !== 'undefined') {
      localTasks.clear();
      if (typeof renderLocalBoard === 'function') renderLocalBoard();
    }
    if (curWS && f.fp) {
      const dname = i.hostname || '';
      api('/workspaces/' + curWS.id, {
        method: 'PATCH',
        body: JSON.stringify({ device_fp: f.fp, device_name: dname }),
      }).then(() => {
        curWS.device_fp = f.fp;
        if (dname) curWS.device_name = dname;
        const cached = wsCache.find((x) => x.id === curWS.id);
        if (cached) {
          cached.device_fp = f.fp;
          if (dname) cached.device_name = dname;
        }
        syncRailDeviceLabels();
      }).catch(() => {});
    }
    return;
  }
  if (f.k === 'agent-event' && f.event) {
    recordAgentEvent(f.event);
    return;
  }
  if (f.k === 'out') {
    if (f.done && localRunID && f.id === localRunID && !toolSess.get(f.id)) finishLocalRun(f.err || '');
    // 旧队列处置（agent-queue-recovery）的回帧：交给 web/node-queue-recovery.js。
    if (typeof NodeQueueRecovery !== 'undefined' && NodeQueueRecovery.handleOut(f)) return;
    const s = toolSess.get(f.id);
    if (!s) return;
    if (f.b64) {
      const raw = b64dec(f.b64);
      if (s.chunks) s.chunks.push(raw);
      else if (s.onData) s.onData(raw);
    }
    if (!f.done && s.ack) sendFrame({ k: 'ack', id: f.id });
    if (f.done) s.settle(f);
  }
  if (f.k === 'ack') {
    const s = toolSess.get(f.id);
    if (s && s.gotReady) s.gotReady();
  }
}

function renderDevices() {
  const box = $('devList');
  box.innerHTML = '';
  if (!devices.length) {
    box.appendChild(el('div', 'hint', '暂无设备。目标机运行 handwave node。'));
    return;
  }
  for (const n of devices) {
    const row = el('div', 'dev-row');
    const name = n.name || n.hostname || n.fp;
    const st = n.state || '';
    row.appendChild(el('b', '', name));
    let badge = 'off', label = st;
    if (st === 'pending') { badge = 'wait'; label = '待允许'; }
    else if (st === 'paired') { badge = 'info'; label = '使用中'; }
    else if (st === 'approved' || st === 'approved-offline') { badge = 'ok'; label = st === 'approved' ? '已授权' : '已授权·离线'; }
    else if (st.indexOf('denied') >= 0) { badge = 'no'; label = '已屏蔽'; }
    row.appendChild(el('span', 'badge ' + badge, label));
    row.appendChild(el('div', 'muted mono',
      (n.user || '') + ' · ' + (n.os || '') + '/' + (n.arch || '') + ' · ' + (n.fp || '').slice(0, 10)));
    const acts = el('div', 'dev-acts');
    if (st === 'pending') {
      const b = el('button', 'btn primary', '允许');
      b.onclick = () => sendSig({ k: 'approve', nid: n.nid, ttl: 86400 });
      acts.appendChild(b);
    } else if (st === 'approved' || st === 'paired') {
      const b = el('button', 'btn primary', st === 'paired' ? '已接入' : '接入');
      b.disabled = st === 'paired';
      b.onclick = () => sendSig({ k: 'approve', nid: n.nid, ttl: 86400 });
      acts.appendChild(b);
    }
    row.appendChild(acts);
    box.appendChild(row);
  }
}

$('btnDisconnectDev').onclick = () => {
  if (paired) sendSig({ k: 'bye' });
  paired = false; closePC();
  setConnState('已连 hub · 未配对', 'on');
};
$('btnReconnect').onclick = () => {
  if (paired) sendSig({ k: 'bye' });
  paired = false; closePC();
  sendSig({ k: 'hello', fp: myFP, relay: true });
  sendSig({ k: 'status' });
  const fp = curWS && curWS.device_fp;
  const n = devices.find((d) => d.fp === fp) || devices.find((d) => d.state === 'approved' || d.state === 'paired');
  if (n && n.id) setTimeout(() => sendSig({ k: 'approve', nid: n.id, ttl: 86400 }), 300);
};

// ---------- 远程工具执行 ----------
function newToolId() {
  return b32(crypto.getRandomValues(new Uint8Array(6)));
}
function execRemote(cmd, cwd, timeout) {
  return new Promise((resolve) => {
    if (!paired) {
      resolve({ content: '错误：未连接远程主机', code: -1 });
      return;
    }
    const id = newToolId();
    let text = '';
    const settle = (f) => {
      toolSess.delete(id);
      activeWork.delete(id);
      resolve({ content: text || (f.err || ''), code: f.code || 0, err: f.err });
    };
    toolSess.set(id, {
      ack: true,
      onData: (raw) => { text += dec.decode(raw); },
      settle,
    });
    activeWork.set(id, { kind: 'exec', cancel: () => sendFrame({ k: 'cancel', id }) });
    sendFrame({ k: 'exec', id, cmd, cwd: cwd || '', timeout: timeout || 60 });
    setTimeout(() => {
      if (toolSess.has(id)) {
        toolSess.delete(id);
        activeWork.delete(id);
        sendFrame({ k: 'cancel', id });
        resolve({ content: text || '超时', code: -1 });
      }
    }, ((timeout || 60) + 5) * 1000);
  });
}
function getRemote(path) {
  return new Promise((resolve) => {
    if (!paired) { resolve({ content: '未连接远程', err: true }); return; }
    const id = newToolId();
    const chunks = [];
    toolSess.set(id, {
      chunks,
      ack: true,
      settle: (f) => {
        toolSess.delete(id);
        if (f.err) resolve({ content: f.err, err: true });
        else {
          const total = chunks.reduce((n, c) => n + c.length, 0);
          const u8 = new Uint8Array(total);
          let o = 0;
          for (const c of chunks) { u8.set(c, o); o += c.length; }
          resolve({ content: dec.decode(u8), err: false });
        }
      },
    });
    sendFrame({ k: 'get', id, path });
  });
}
function putRemote(path, content) {
  return new Promise(async (resolve) => {
    if (!paired) { resolve({ content: '未连接远程', err: true }); return; }
    const id = newToolId();
    const data = enc.encode(content);
    let ready;
    const readyP = new Promise((r) => { ready = r; });
    toolSess.set(id, {
      gotReady: () => ready(),
      settle: (f) => {
        toolSess.delete(id);
        resolve({ content: f.err || 'ok', err: !!f.err });
      },
    });
    sendFrame({ k: 'put', id, path, size: data.length });
    await readyP;
    for (let i = 0; i < data.length; i += MAX_CHUNK) {
      const slice = data.subarray(i, Math.min(i + MAX_CHUNK, data.length));
      const done = i + slice.length >= data.length;
      let acked;
      const ackP = new Promise((r) => { acked = r; });
      toolSess.get(id).gotReady = () => acked();
      sendFrame({ k: 'chunk', id, b64: b64enc(slice), done });
      if (!done) await ackP;
    }
  });
}

function runNodeTask(args, agentID) {
  return new Promise((resolve) => {
    if (!paired) { resolve({ content: 'Node is not connected', code: -1, err: 'not connected' }); return; }
    const id = newToolId();
    let text = '';
    const task = {
      id, agent_id: agentID || id, name: args.name || 'Node Agent', role: args.role || 'operator',
      objective: args.objective || '', steps: Array.isArray(args.steps) ? args.steps : [],
    };
    const encodedTask = enc.encode(JSON.stringify({ k: 'agent-task', id, task }));
    if (encodedTask.length > 48 * 1024) {
      resolve({ content: 'Node task payload is too large', code: -1, err: 'payload too large' });
      return;
    }
    recordAgentEvent({ type: 'task_start', status: 'running', task_id: id, agent_id: task.agent_id, agent_name: task.name, agent_role: task.role, title: task.objective, total: task.steps.length, ts: new Date().toISOString() });
    activeWork.set(id, { kind: 'node', cancel: () => sendFrame({ k: 'cancel', id }) });
    toolSess.set(id, {
      task: true,
      onData: (raw) => { text += dec.decode(raw); },
      settle: (f) => {
        toolSess.delete(id);
        activeWork.delete(id);
        resolve({ content: text || f.err || '', code: f.code || 0, err: f.err || '' });
      },
    });
    if (!sendFrame({ k: 'agent-task', id, task })) {
      toolSess.delete(id);
      activeWork.delete(id);
      resolve({ content: 'Failed to send Node task', code: -1, err: 'send failed' });
    }
  });
}

async function runDelegateAgent(args, agentID, base) {
  const id = agentID || newToolId();
  const body = Object.assign({}, base, {
    turn_id: base.turn_id,
    agent_id: id,
    name: args.name || 'Delegate', role: args.role || 'researcher', task: args.task || '',
  });
  const ctl = new AbortController();
  activeWork.set(id, { kind: 'delegate', cancel: () => ctl.abort() });
  try {
    const resp = await fetch('/api/agents/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal,
    });
    if (!resp.ok || !resp.body) {
      let message = 'HTTP ' + resp.status;
      try { const j = await resp.json(); if (j.error) message = j.error; } catch (_) {}
      throw new Error(message);
    }
    const reader = resp.body.getReader();
    const tdec = new TextDecoder('utf-8');
    let buf = '', event = '', result = null;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      buf += tdec.decode(part.value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        event = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            if (event === 'trace') { try { recordAgentEvent(JSON.parse(payload)); } catch (_) {} }
            else if (event === 'done') { try { result = JSON.parse(payload); } catch (_) {} }
            else if (event === 'error') {
              let msg = 'Delegate failed'; try { msg = JSON.parse(payload).error || msg; } catch (_) {}
              throw new Error(msg);
            }
          }
        }
      }
    }
    return result || { agent_id: id, name: body.name, role: body.role, content: '' };
  } finally {
    activeWork.delete(id);
  }
}

async function runOneToolCall(tc, base) {
  const name = tc.function && tc.function.name;
  let args = {};
  try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) {}
  const card = makeToolCard(name, args);
  const eventStart = agentRun.events.length;
  $('messages').appendChild(card.el);
  $('messages').scrollTop = $('messages').scrollHeight;
  toolLog('→ ' + name + ' ' + JSON.stringify(args));
  const agentID = name === 'delegate_agent' ? ('delegate-' + (tc.id || newToolId())) : (name === 'run_node_task' ? ('node-' + (tc.id || newToolId())) : 'coordinator');
  recordAgentEvent({ type: 'tool_start', status: 'running', agent_id: agentID, agent_name: args.name || (agentID === 'coordinator' ? 'Coordinator' : 'Agent'), agent_role: args.role || (agentID === 'coordinator' ? 'coordinator' : 'operator'), title: name, detail: toolSummary(name, args), ts: new Date().toISOString() });
  let content = '', ok = true;
  try {
    if (name === 'exec') {
      const r = await execRemote(args.cmd, args.cwd, args.timeout);
      content = (r.content || '') + (r.code != null ? '\n[exit ' + r.code + ']' : ''); ok = r.code === 0;
    } else if (name === 'read_file') {
      const r = await getRemote(args.path); content = r.content; ok = !r.err;
    } else if (name === 'write_file') {
      const r = await putRemote(args.path, args.content || ''); content = r.err ? r.content : 'written ' + args.path; ok = !r.err;
    } else if (name === 'delegate_agent') {
      const r = await runDelegateAgent(args, agentID, base); content = r.content || ''; ok = true;
    } else if (name === 'run_node_task') {
      const r = await runNodeTask(args, agentID); content = r.content || ''; ok = !r.err && r.code === 0;
    } else {
      content = '未知工具: ' + name; ok = false;
    }
  } catch (err) {
    content = err && err.message ? err.message : String(err); ok = false;
  }
  card.setOut(content);
  card.finish(ok, ok ? '' : '失败');
  toolLog('← ' + name + ' (' + Math.min(content.length, 200) + ' chars)');
  recordAgentEvent({ type: 'tool_finish', status: ok ? 'completed' : 'failed', agent_id: agentID, agent_name: args.name || (agentID === 'coordinator' ? 'Coordinator' : 'Agent'), agent_role: args.role || (agentID === 'coordinator' ? 'coordinator' : 'operator'), title: name, detail: ok ? Math.min(content.length, 200) + ' chars' : content.slice(0, 200), ts: new Date().toISOString() });
  return {
    role: 'tool', tool_call_id: tc.id, name, content,
    events: agentRun.events.slice(eventStart).filter((e) => agentIdentity(e) === agentID),
  };
}

async function runToolCalls(calls, base) {
  setSendUI(true);
  const indexed = calls.map((tc, index) => ({ tc, index }));
  const delegates = [];
  const serial = [];
  const byIndex = new Map();
  for (const item of indexed) {
    const name = item.tc.function && item.tc.function.name;
    if (name === 'delegate_agent') {
      if (delegates.length < 3) delegates.push(item);
      else byIndex.set(item.index, { role: 'tool', tool_call_id: item.tc.id, name, content: 'Delegate limit reached (max 3 per round).' });
    } else serial.push(item);
  }
  if (delegates.length) {
    const values = await Promise.all(delegates.map((item) => runOneToolCall(item.tc, base)));
    delegates.forEach((item, i) => byIndex.set(item.index, values[i]));
  }
  if (!stopRequested) {
    for (const item of serial) {
      if (stopRequested) break;
      byIndex.set(item.index, await runOneToolCall(item.tc, base));
    }
  }
  return indexed.map((item) => byIndex.get(item.index)).filter(Boolean);
}

// ---------- 聊天附件（预览 + 粘贴） ----------
function isImageAttach(a) {
  const m = (a.mime || a.type || '').toLowerCase();
  if (m.startsWith('image/')) return true;
  const n = (a.name || '').toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(n);
}

function attachPreviewURL(a) {
  if (a.previewURL) return a.previewURL;
  if (a.data_url) return a.data_url;
  if (a.url) return a.url;
  return '';
}

function renderAttachBar() {
  const bar = $('attachBar');
  bar.innerHTML = '';
  if (!pendingAttach.length) {
    bar.classList.add('hide');
    return;
  }
  bar.classList.remove('hide');
  pendingAttach.forEach((a, i) => {
    if (isImageAttach(a) && attachPreviewURL(a)) {
      const wrap = el('div', 'attach-thumb');
      const img = document.createElement('img');
      img.src = attachPreviewURL(a);
      img.alt = a.name || 'image';
      wrap.appendChild(img);
      const x = el('button', 'attach-x', '×');
      x.type = 'button';
      x.title = '移除';
      x.onclick = () => removeAttach(i);
      wrap.appendChild(x);
      bar.appendChild(wrap);
    } else {
      const wrap = el('div', 'attach-file');
      wrap.appendChild(el('b', '', a.name || 'file'));
      const x = el('button', 'attach-x', '×');
      x.type = 'button';
      x.title = '移除';
      x.onclick = () => removeAttach(i);
      wrap.appendChild(x);
      bar.appendChild(wrap);
    }
  });
}

function removeAttach(i) {
  const a = pendingAttach[i];
  if (a && a.previewURL) URL.revokeObjectURL(a.previewURL);
  pendingAttach.splice(i, 1);
  renderAttachBar();
}

function clearPendingAttach() {
  pendingAttach.forEach((a) => {
    if (a.previewURL) URL.revokeObjectURL(a.previewURL);
  });
  pendingAttach.length = 0;
  renderAttachBar();
}

async function uploadFile(f) {
  if (!(await ensureChatContext())) return null;
  const fd = new FormData();
  fd.append('file', f);
  const a = await api('/upload?ws=' + curWS.id + '&session=' + curSess.id, { method: 'POST', body: fd });
  if (f.type && f.type.startsWith('image/')) {
    a.previewURL = URL.createObjectURL(f);
    a.mime = a.mime || f.type;
  } else if (!a.mime && f.type) {
    a.mime = f.type;
  }
  return a;
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return;
  for (const f of files) {
    try {
      const a = await uploadFile(f);
      if (a) pendingAttach.push(a);
    } catch (err) {
      await uiAlert('上传失败：' + (err.message || err));
    }
  }
  renderAttachBar();
}

$('btnAttach').onclick = () => attachMenuOpen ? closeAttachMenu() : openAttachMenu();
$('fileInput').onchange = async (e) => {
  const files = e.target.files;
  e.target.value = '';
  await addFiles(files);
};
$('queueClear').onclick = clearQueue;

$('input').addEventListener('paste', async (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files = [];
  for (const it of items) {
    if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (!files.length) return;
  e.preventDefault();
  await addFiles(files);
});

let stopCtl = null;
function setSendUI(busy) {
  const btn = $('btnSend');
  btn.classList.toggle('stop', busy);
  btn.title = busy ? '停止' : '发送';
  btn.innerHTML = busy
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
}
/** 消费一条 SSE 流；返回 done 里的 assistant 消息或 null（被停止/出错已处理） */
async function consumeSSE(path, body, stream) {
  const ctl = new AbortController();
  stopCtl = ctl;
  setSendUI(true);
  try {
    const resp = await fetch('/api' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!resp.ok || !resp.body) {
      let msg = 'HTTP ' + resp.status;
      try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }
    const reader = resp.body.getReader();
    const tdec = new TextDecoder('utf-8');
    let buf = '', event = '';
    let asst = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += tdec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            if (event === 'delta') {
              try {
                const text = JSON.parse(payload).text || '';
                stream.append(text);
                // Show thinking panel for reasoning content
                if (text.includes('•') || text.includes('- ') || text.includes('* ') || text.match(/^\d+\./)) {
                  showThinking();
                  processThinkingText(text);
                }
              } catch (_) {}
            } else if (event === 'trace') {
              try { recordAgentEvent(JSON.parse(payload)); } catch (_) {}
            } else if (event === 'done') {
              try { asst = JSON.parse(payload); } catch (_) {}
              finishThinking();
              hideThinking();
            } else if (event === 'error') {
              let msg = '上游错误';
              try { msg = JSON.parse(payload).error || msg; } catch (_) {}
              throw new Error(msg);
            }
          }
        }
      }
    }
    return asst;
  } finally {
    stopCtl = null;
    setSendUI(false);
  }
}
async function sendChat() {
  const text = $('input').value.trim();
  const action = localComposerAction({ localMode, sending, localBusy, text });
  if (action === 'ignore') return;
  stopRequested = false;
  if (action === 'need-text') {
    addBubble('system', '本机执行需要一段文字目标。');
    return;
  }
  if (action === 'follow' || action === 'start') {
    $('input').value = '';
    if (pendingAttach.length) {
      clearPendingAttach();
      addBubble('system', '本机执行不带附件，附件已忽略。');
    }
    if (action === 'follow') {
      // 调度决策归后端：忙时仍发 agent-loop，由 node 的 sess.Busy() 单点决定 run/queue。
      // 不走 startLocalRun，避免抹掉进行中的任务板；被排队回合的事件挂在原 run 事件流下。
      const followSel = agentLoopModelSelection(); // 与 run 起点同一包装：Auto 不带协议，交服务端按会话解析
      if (!sendFrame({ k: 'agent-loop', id: newToolId(), msg: text, model: followSel.model, protocol: followSel.protocol })) {
        addBubble('system', '未接入本机，这条没发出去。');
      } else {
        addBubble('user', text);
        noteSession('user', text);
        addBubble('system', '已交给本机调度：' + text);
      }
      return;
    }
    startLocalRun(text);
    return;
  }
  if (!text && !pendingAttach.length) return;
  const missingProtocol = protocolChoiceError();
  if (missingProtocol) {
    addBubble('system', missingProtocol);
    openModelMenu();
    return;
  }
  const queuedSel = chatModelSelection();
  
  // If already processing or queue has items, queue this message
  if (sending || processingQueue || msgQueue.length > 0) {
    const skills = selectedSkills.map((s) => ({ id: s.id, name: s.name }));
    const attachments = pendingAttach.map(({ previewURL, ...rest }) => rest);
    enqueueMessage({
      text,
      attachments,
      skills,
      model: queuedSel.model,
      protocol: queuedSel.protocol,
      kb_global: $('kbGlobal').checked,
      kb_project: $('kbProject').checked,
      tools: $('useTools').checked,
      agents: $('useAgents').checked,
    });
    closeAttachMenu();
    $('input').value = '';
    clearPendingAttach();
    return;
  }
  
  sending = true;
  try {
    if (!(await ensureChatContext())) { sending = false; return; }
  } catch (err) {
    sending = false;
    await uiAlert('无法创建会话：' + err.message);
    return;
  }
  const skills = selectedSkills.map((s) => s.id);
  const skillNames = selectedSkills.map((s) => s.name);
  closeAttachMenu();
  $('btnSend').disabled = false;
  $('input').value = '';
  addBubble('user', (text || '（附件）') + (skillNames.length ? '\n\n技能：' + skillNames.join('、') : ''));
  const attachments = pendingAttach.map(({ previewURL, ...rest }) => rest);
  clearPendingAttach();
  const base = {
    workspace_id: curWS.id,
    session_id: curSess.id,
    model: queuedSel.model,
    protocol: queuedSel.protocol,
    kb_global: $('kbGlobal').checked,
    kb_project: $('kbProject').checked,
    tools: $('useTools').checked,
    agents: $('useAgents').checked,
  };
  resetAgentRun('pending');
  let stream = null;
  try {
    stream = beginAssistant();
    let asst = await consumeSSE('/chat', Object.assign({ content: text, attachments, skills }, base), stream);
    const turnID = asst && asst.turn_id;
    if (turnID) agentRun.turnID = turnID;
    if (asst) {
      selectedSkills = selectedSkills.filter((s) => !skills.includes(s.id));
      renderSelectedSkills();
    }
    stream.finalize(asst ? asst.content : null);
    stream = null;

    // Handle clarify — pause and show options, do not continue tool loop
    if (asst && asst.clarify && asst.clarify.length > 0) {
      pendingClarify = { turnID, options: asst.clarify };
      renderClarifyBar();
      finishAgentRun('completed');
      return;
    }

    let guard = 0;
    while (asst && asst.tool_calls && asst.tool_calls.length && guard++ < 8) {
      const toolBase = Object.assign({ turn_id: turnID }, base);
      const results = await runToolCalls(asst.tool_calls, toolBase);
      if (stopRequested) throw new DOMException('Stopped', 'AbortError');
      stream = beginAssistant();
      asst = await consumeSSE('/chat/continue', Object.assign({ turn_id: turnID, tool_results: results }, base), stream);
      stream.finalize(asst ? asst.content : null);
      stream = null;
    }
    refreshSessions();
    finishAgentRun('completed');
  } catch (e) {
    if (stream) stream.finalize(null);
    const stopped = e && e.name === 'AbortError';
    finishAgentRun(stopped ? 'canceled' : 'failed');
    if (stopped) addBubble('system', '已停止。');
    else addBubble('system', '发送失败：' + e.message);
  } finally {
    activeWork.clear();
    sending = false;
    setSendUI(false);
    $('input').focus();
  }
}
function cancelActiveWork() {
  stopRequested = true;
  if (stopCtl) stopCtl.abort();
  for (const work of activeWork.values()) {
    try { work.cancel(); } catch (_) {}
  }
  if (localBusy && localRunID) sendFrame({ k: 'agent-abort', id: localRunID });
}
$('btnSend').onclick = () => {
  if (sending) { cancelActiveWork(); return; }
  sendChat();
};
function isCoarsePointer() {
  try { return window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(max-width: 780px)').matches; }
  catch (_) { return window.innerWidth <= 780; }
}
$('input').addEventListener('keydown', (e) => {
  // 手机：Enter 换行，点发送键提交；桌面：Enter 发送，Shift+Enter 换行
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    if (isCoarsePointer()) return;
    e.preventDefault();
    sendChat();
  }
});
// 手机输入框聚焦时滚到底，避免被键盘挡住
$('input').addEventListener('focus', () => {
  setTimeout(() => {
    const box = $('messages');
    if (box) box.scrollTop = box.scrollHeight;
  }, 320);
});

// ---------- 模型选择（共享网关目录 + 显式协议；Cursor 风格悬浮不变） ----------
let modelCatalog = [];
let modelAuto = true;
let modelMenuOpen = false;
let modelTipTimer = 0;
let modelProtocol = '';      // 多协议模型的显式协议选择，Hub 不替用户猜
let modelCatalogError = '';  // 目录读取失败原因；失败时保留旧目录与当前选择
let sessionBinding = null;   // 服务端 sessMeta 已绑定的 { model, protocol }

const modelSelectionKey = 'handwave.model.selection';

// 刷新页面后选择含义不变：只把**用户显式点选**的 (model, protocol) 落 localStorage，
// Auto 不落盘。目录本身不缓存，目录变化仍由 loadModels 校验并明确报错。
function persistModelSelection() {
  try {
    if (modelAuto || currentModelValue() === 'default') {
      localStorage.removeItem(modelSelectionKey);
      return;
    }
    localStorage.setItem(modelSelectionKey, JSON.stringify({ model: currentModelValue(), protocol: modelProtocol }));
  } catch (_) {}
}

// 恢复上次显式选择，返回是否恢复成功。模型已不在目录时仍恢复原值——由 loadModels
// 报「已不在目录中」并让用户重新点选，绝不静默换成别的模型或退回 Auto。
function restoreModelSelection() {
  let raw = '';
  try { raw = localStorage.getItem(modelSelectionKey) || ''; } catch (_) { return false; }
  if (!raw) return false;
  let saved = null;
  try { saved = JSON.parse(raw); } catch (_) { return false; }
  if (!saved || typeof saved.model !== 'string' || saved.model === 'default') return false;
  $('modelSel').value = saved.model;
  modelProtocol = typeof saved.protocol === 'string' ? saved.protocol : '';
  modelAuto = false;
  return true;
}

const protocolShort = {
  'openai-completions': 'chat', 'openai-responses': 'responses', 'anthropic-messages': 'anthropic',
  'azure-openai-responses': 'azure', 'openrouter-chat': 'openrouter', 'google-generative-ai': 'gemini',
  'ollama-chat': 'ollama',
};

function currentModelValue() {
  return ($('modelSel') && $('modelSel').value) || 'default';
}

function gatewayDefaultModel() { return (gatewayPublic && gatewayPublic.default_model) || ''; }
function gatewayDefaultProtocol() { return (gatewayPublic && gatewayPublic.default_protocol) || ''; }

function modelProtocols(modelID) {
  const hit = modelCatalog.find((m) => m && m.id === modelID);
  return (hit && Array.isArray(hit.protocols) && hit.protocols) || [];
}

// 每次 chat / continue 都带上 model + protocol；Auto = 服务端已保存的默认模型 + 默认协议。
function chatModelSelection() {
  if (modelAuto || currentModelValue() === 'default') return { model: 'default', protocol: gatewayDefaultProtocol() };
  const id = currentModelValue();
  const protocols = modelProtocols(id);
  if (protocols.length <= 1) return { model: id, protocol: protocols[0] || '' };
  if (protocols.includes(modelProtocol)) return { model: id, protocol: modelProtocol };
  if (id === gatewayDefaultModel() && protocols.includes(gatewayDefaultProtocol())) return { model: id, protocol: gatewayDefaultProtocol() };
  return { model: id, protocol: '' };
}

// 本机 agent-loop 的 model/protocol 口径：model 沿用云端 chatModelSelection()，但 Auto（model=default）
// 一律不带协议——浏览器缓存的 gatewayDefaultProtocol 不是用户显式选择；协议由 Node 的 fresh Hub grant 按
// 显式协议 > 已保存 session hint > Hub 默认 解析，免得覆盖续接语义。云端 chat 不用这个包装。
function agentLoopModelSelection() {
  const sel = chatModelSelection();
  return sel.model === 'default' ? { model: 'default', protocol: '' } : sel;
}

function protocolChoiceError() {
  if (modelAuto || currentModelValue() === 'default') return '';
  const protocols = modelProtocols(currentModelValue());
  if (protocols.length > 1 && !chatModelSelection().protocol) {
    return '模型 ' + currentModelValue() + ' 支持多个协议，请在模型菜单里显式选择协议（不会自动挑一个）。';
  }
  return '';
}

function effectiveSelection() {
  const sel = chatModelSelection();
  if (sel.model !== 'default') return sel;
  return { model: gatewayDefaultModel() || 'default', protocol: sel.protocol };
}

function setModelLabel() {
  const sel = chatModelSelection();
  const label = $('modelLabel');
  if (label) {
    // Auto 只是「服务端已保存的默认模型 + 默认协议」，不是分类器智能选型；文案按实际含义显示。
    label.textContent = sel.model === 'default' ? '服务端默认' : (sel.protocol ? sel.model + ' \u00b7 ' + (protocolShort[sel.protocol] || sel.protocol) : sel.model);
  }
  const trigger = $('modelTrigger');
  if (trigger) {
    trigger.title = '模型：' + (sel.model === 'default' ? ('服务端默认 ' + (gatewayDefaultModel() || '（未配置）')) : sel.model)
      + ' · 协议：' + (sel.protocol || (sel.model === 'default' ? '服务端默认' : '未选择'));
  }
  renderProtocolRow();
}

function modelStatusText() {
  if (gatewayPublic && gatewayPublic.configured === false) {
    return '网关还没配置：在账户菜单「网关模型配置」里保存 gateway_root 与默认模型后，目录才会出现。';
  }
  if (modelCatalogError) return modelCatalogError;
  if (gatewayPublic && gatewayPublic.catalog_error) return '模型目录不可用：' + gatewayPublic.catalog_error;
  const choice = protocolChoiceError();
  if (choice) return choice;
  if (sessionBinding) {
    const eff = effectiveSelection();
    if (eff.model !== sessionBinding.model || (sessionBinding.protocol && eff.protocol !== sessionBinding.protocol)) {
      return '本会话服务端已绑定 ' + sessionBinding.model + (sessionBinding.protocol ? ' \u00b7 ' + sessionBinding.protocol : '')
        + '；换模型请另开会话，旧历史不会被静默改写。';
    }
  }
  return '';
}

function syncModelStatus() {
  const box = $('modelStatus');
  if (!box) return;
  const text = modelStatusText();
  box.textContent = text;
  box.classList.toggle('hide', !text);
}

function syncAutoToggle() {
  const tog = $('modelAutoToggle');
  if (!tog) return;
  tog.classList.toggle('on', modelAuto);
  tog.setAttribute('aria-checked', modelAuto ? 'true' : 'false');
}

function setAuto(on) {
  if (!on && currentModelValue() === 'default') {
    // 目录不自动挑第一个：保持 Auto，提示用户显式点选模型。
    modelAuto = true;
    syncAutoToggle();
    renderModelList();
    const box = $('modelStatus');
    if (box) { box.textContent = '请先在列表里点选一个模型；关闭 Auto 不会自动选第一个。'; box.classList.remove('hide'); }
    return;
  }
  modelAuto = !!on;
  if (modelAuto) {
    $('modelSel').value = 'default';
    modelProtocol = '';
  }
  syncAutoToggle();
  setModelLabel();
  renderModelList();
  syncModelStatus();
  persistModelSelection();
}

function selectModel(modelID) {
  $('modelSel').value = modelID;
  modelAuto = false;
  const protocols = modelProtocols(modelID);
  if (!protocols.includes(modelProtocol)) modelProtocol = protocols.length === 1 ? protocols[0] : '';
  syncAutoToggle();
  setModelLabel();
  renderModelList($('modelSearch') ? $('modelSearch').value : '');
  syncModelStatus();
  persistModelSelection();
  if (protocols.length > 1) {
    const box = $('modelStatus');
    if (box) { box.textContent = '该模型有多个协议，请点选下面一个协议。'; box.classList.remove('hide'); }
    return; // 协议未定 → 菜单保持打开，避免半截选择被发出去
  }
  closeModelMenu();
}

function renderProtocolRow() {
  const wrap = $('modelProto');
  const list = $('modelProtoList');
  if (!wrap || !list) return;
  list.replaceChildren();
  const protocols = modelAuto ? [] : modelProtocols(currentModelValue());
  wrap.classList.toggle('hide', protocols.length < 2);
  if (protocols.length < 2) return;
  for (const protocol of protocols) {
    const btn = el('button', 'model-proto-item' + (modelProtocol === protocol ? ' on' : ''), protocolShort[protocol] || protocol);
    btn.type = 'button';
    btn.title = protocol;
    btn.setAttribute('aria-pressed', modelProtocol === protocol ? 'true' : 'false');
    btn.onclick = () => {
      modelProtocol = protocol;
      setModelLabel();
      renderModelList($('modelSearch') ? $('modelSearch').value : '');
      syncModelStatus();
      persistModelSelection();
    };
    list.appendChild(btn);
  }
}

function renderModelList(filter = '') {
  const list = $('modelList');
  if (!list) return;
  const q = (filter || '').trim().toLowerCase();
  list.replaceChildren();
  const rows = modelCatalog.filter((m) => {
    if (!q) return true;
    const protocols = Array.isArray(m.protocols) ? m.protocols.join(' ') : '';
    return (m.id || '').toLowerCase().includes(q) || (m.owned_by || '').toLowerCase().includes(q) || protocols.toLowerCase().includes(q);
  });
  if (!rows.length) {
    list.appendChild(el('div', 'model-empty', modelCatalog.length
      ? (q ? '无匹配模型' : '网关模型目录为空')
      : '网关模型目录为空或不可用：不会自动回退到 auto 或第一个模型。'));
    renderProtocolRow();
    return;
  }
  const sel = chatModelSelection();
  for (const m of rows) {
    const on = !modelAuto && sel.model === m.id;
    const protocols = Array.isArray(m.protocols) ? m.protocols : [];
    const row = el('button', 'model-item' + (on ? ' on' : ''));
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', on ? 'true' : 'false');
    row.appendChild(el('span', 'model-name', m.id || ''));
    row.appendChild(el('span', 'model-meta', protocols.length ? protocols.join(' / ') : (m.owned_by || 'gateway')));
    if (on) row.appendChild(el('span', 'model-check', sel.protocol ? '\u2713 ' + (protocolShort[sel.protocol] || sel.protocol) : '\u2713'));
    row.title = (m.name ? m.name + ' \u00b7 ' : '') + m.id + '：' + (protocols.join(' / ') || '目录未标注协议（服务端按 chat 处理）');
    row.onclick = () => selectModel(m.id);
    list.appendChild(row);
  }
  renderProtocolRow();
}

function positionModelMenu() {
  const menu = $('modelMenu');
  const trigger = $('modelTrigger');
  if (!menu || !trigger) return;
  const r = trigger.getBoundingClientRect();
  const pad = 8;
  menu.style.visibility = 'hidden';
  menu.classList.remove('hide');
  const mw = menu.offsetWidth || 280;
  const mh = menu.offsetHeight || 320;
  let left = r.left;
  let top = r.top - mh - 8;
  if (top < pad) top = r.bottom + 8;
  if (left + mw > window.innerWidth - pad) left = window.innerWidth - mw - pad;
  if (left < pad) left = pad;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.style.visibility = '';
}

function openModelMenu() {
  if (modelMenuOpen) return;
  closeAttachMenu();
  closeAccountMenu();
  modelMenuOpen = true;
  hideModelTip();
  $('modelTrigger').setAttribute('aria-expanded', 'true');
  $('modelSearch').value = '';
  renderModelList();
  syncModelStatus();
  positionModelMenu();
  $('modelMenu').classList.remove('hide');
  setTimeout(() => $('modelSearch').focus(), 0);
}

function closeModelMenu() {
  if (!modelMenuOpen) return;
  modelMenuOpen = false;
  $('modelMenu').classList.add('hide');
  $('modelTrigger').setAttribute('aria-expanded', 'false');
}

function toggleModelMenu() {
  if (modelMenuOpen) closeModelMenu();
  else openModelMenu();
}

function showModelTip() {
  if (modelMenuOpen) return;
  let tip = $('modelTip');
  if (!tip) {
    tip = el('div', 'model-tip hide');
    tip.id = 'modelTip';
    tip.innerHTML = '<div class="model-tip-row"><span>选择模型</span><span class="kbd"><i>Ctrl</i><i>/</i></span></div>';
    document.body.appendChild(tip);
  }
  const r = $('modelTrigger').getBoundingClientRect();
  tip.classList.remove('hide');
  const tw = tip.offsetWidth || 180;
  const th = tip.offsetHeight || 40;
  let left = r.left;
  let top = r.top - th - 8;
  if (top < 8) top = r.bottom + 8;
  if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function hideModelTip() {
  const tip = $('modelTip');
  if (tip) tip.classList.add('hide');
}

function bindModelPicker() {
  if (!$('modelTrigger')) return;
  $('modelTrigger').onclick = (e) => {
    e.stopPropagation();
    toggleModelMenu();
  };
  $('modelTrigger').addEventListener('mouseenter', () => {
    clearTimeout(modelTipTimer);
    modelTipTimer = setTimeout(showModelTip, 220);
  });
  $('modelTrigger').addEventListener('mouseleave', () => {
    clearTimeout(modelTipTimer);
    hideModelTip();
  });
  $('modelAutoToggle').onclick = (e) => {
    e.stopPropagation();
    setAuto(!modelAuto);
  };
  $('modelSearch').addEventListener('input', () => renderModelList($('modelSearch').value));
  $('modelSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModelMenu();
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (!modelMenuOpen) return;
    const menu = $('modelMenu');
    if (menu.contains(e.target) || $('modelTrigger').contains(e.target)) return;
    closeModelMenu();
  });
  window.addEventListener('resize', () => { if (modelMenuOpen) positionModelMenu(); });
  window.addEventListener('scroll', () => { if (modelMenuOpen) positionModelMenu(); }, true);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      closeAccountMenu();
      toggleModelMenu();
    }
  });
  // 有上次显式选择就恢复（loadModels 随后按目录校验），否则保持服务端默认。
  if (restoreModelSelection()) {
    syncAutoToggle();
    setModelLabel();
    renderModelList();
    syncModelStatus();
  } else {
    setAuto(true);
  }
}

// 读取共享网关配置（默认 model / protocol、has_token、migration、catalog_error）。
async function loadGatewayConfig() {
  try {
    gatewayPublic = await api('/model-config');
    modelCatalogError = '';
  } catch (err) {
    gatewayPublic = null;
    modelCatalogError = '网关配置读取失败：' + err.message + '；聊天仍按上一次的选择发送。';
  }
  setModelLabel();
  syncModelStatus();
  return gatewayPublic;
}

// 目录来源：GET /api/models → [{ id, owned_by, protocols[] }]
async function loadModels() {
  const keepModel = currentModelValue();
  const keepProtocol = modelProtocol;
  let list;
  try {
    list = await api('/models');
    if (!Array.isArray(list)) throw new Error('返回目录格式不正确');
  } catch (err) {
    modelCatalogError = '模型目录读取失败：' + err.message + '；保留上次目录与当前选择，不会回退到 auto 或第一个模型。';
    renderModelList();
    setModelLabel();
    syncModelStatus();
    return;
  }
  modelCatalog = list;
  if (!list.length) {
    modelCatalogError = '网关模型目录为空：请在「网关模型配置」里确认 gateway_root 与令牌后点「刷新已保存配置的目录」重试；当前选择保持不变。';
  } else if (keepModel !== 'default' && !list.some((m) => m && m.id === keepModel)) {
    modelCatalogError = '上次选择的模型 ' + keepModel + ' 已不在目录中；请重新选择，不会自动换成别的模型。';
  } else {
    modelCatalogError = '';
  }
  if (keepModel !== 'default') {
    $('modelSel').value = keepModel; // 显式选择优先于目录变化
    modelAuto = false;
    const protocols = modelProtocols(keepModel);
    modelProtocol = protocols.includes(keepProtocol) ? keepProtocol : (protocols.length === 1 ? protocols[0] : '');
  }
  syncAutoToggle();
  renderModelList();
  setModelLabel();
  syncModelStatus();
}

// ---------- 启动 ----------
let sheetReturnFocus = null;
function syncRailToggle() {
  const visible = window.innerWidth <= 780
    ? $('railPanel').classList.contains('sheet-open')
    : !document.body.classList.contains('rail-collapsed');
  $('railPanel').inert = !visible;
  $('btnOpenRail').setAttribute('aria-expanded', String(visible));
}
function closeSheets() {
  document.body.classList.remove('sheet-rail', 'sheet-aside');
  const rail = $('railPanel');
  const aside = $('asidePanel');
  const scrim = $('sheetScrim');
  if (rail) rail.classList.remove('sheet-open');
  if (aside) {
    aside.classList.remove('sheet-open');
    aside.inert = true;
    aside.setAttribute('aria-hidden', 'true');
    aside.removeAttribute('aria-modal');
  }
  $('btnOpenAside').setAttribute('aria-expanded', 'false');
  if (scrim) { scrim.classList.add('hide'); scrim.setAttribute('aria-hidden', 'true'); }
  document.querySelector('.chat-main').inert = false;
  syncRailToggle();
  if (sheetReturnFocus) { sheetReturnFocus.focus(); sheetReturnFocus = null; }
}
function openSheet(which) {
  closeSheets();
  closeAttachMenu();
  closeModelMenu();
  closeAccountMenu();
  sheetReturnFocus = document.activeElement;
  const scrim = $('sheetScrim');
  if (which === 'rail') {
    document.body.classList.add('sheet-rail');
    $('railPanel').classList.add('sheet-open');
  } else {
    document.body.classList.add('sheet-aside');
    $('asidePanel').classList.add('sheet-open');
    $('asidePanel').inert = false;
    $('asidePanel').setAttribute('aria-hidden', 'false');
    $('asidePanel').setAttribute('aria-modal', 'true');
    $('btnOpenAside').setAttribute('aria-expanded', 'true');
  }
  syncRailToggle();
  document.querySelector('.chat-main').inert = true;
  if (which === 'aside') $('railPanel').inert = true;
  (which === 'aside' ? $('btnCloseAside') : $('btnNewSess')).focus();
  if (scrim) { scrim.classList.remove('hide'); scrim.setAttribute('aria-hidden', 'false'); }
}
function bindSheetSwipe(el, closeDir) {
  if (!el) return;
  let x0 = 0, y0 = 0, t0 = 0;
  el.addEventListener('touchstart', (e) => {
    if (!e.touches || !e.touches[0]) return;
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
    t0 = Date.now();
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (!e.changedTouches || !e.changedTouches[0]) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    const dt = Date.now() - t0;
    if (dt > 500 || Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    if (closeDir === 'left' && dx < -56) closeSheets();
    if (closeDir === 'right' && dx > 56) closeSheets();
  }, { passive: true });
}
function bindVisualViewport() {
  const vv = window.visualViewport;
  const apply = () => {
    const h = vv ? vv.height : window.innerHeight;
    const offset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    document.documentElement.style.setProperty('--app-h', h + 'px');
    document.documentElement.style.setProperty('--kb-offset', offset + 'px');
  };
  apply();
  if (vv) {
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
  }
  window.addEventListener('resize', apply);
}
function syncInputPlaceholder() {
  const ta = $('input');
  if (!ta) return;
  const mob = isCoarsePointer();
  const ph = ta.getAttribute(mob ? 'data-ph-mobile' : 'data-ph-desktop');
  if (ph) ta.placeholder = ph;
}
function bindMobileChrome() {
  const railBtn = $('btnOpenRail');
  const asideBtn = $('btnOpenAside');
  const scrim = $('sheetScrim');
  if (railBtn) railBtn.onclick = () => {
    if (window.innerWidth > 780) {
      document.body.classList.toggle('rail-collapsed');
      syncRailToggle();
    } else if ($('railPanel').classList.contains('sheet-open')) closeSheets();
    else openSheet('rail');
  };
  $('btnTheme').onclick = () => applyTheme(normalizeTheme(document.documentElement.getAttribute('data-theme')) === 'dark' ? 'light' : 'dark');
  syncRailToggle();
  if (asideBtn) asideBtn.onclick = () => {
    if ($('asidePanel').classList.contains('sheet-open')) closeSheets();
    else openSheet('aside');
  };
  document.querySelectorAll('[data-close-sheet]').forEach((btn) => {
    btn.onclick = (e) => { e.preventDefault(); closeSheets(); };
  });
  // 蒙层 / 滑动关闭即可，不再保留多余关闭按钮
  if (scrim) scrim.onclick = () => closeSheets();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheets();
  });
  window.addEventListener('resize', () => {
    syncInputPlaceholder();
    if (window.innerWidth > 780 && document.body.classList.contains('sheet-rail')) closeSheets();
    syncRailToggle();
    if (document.body.classList.contains('sheet-aside')) $('railPanel').inert = true;
  });
  bindSheetSwipe($('railPanel'), 'left');
  bindSheetSwipe($('asidePanel'), 'right');
  bindVisualViewport();
  syncInputPlaceholder();
  document.querySelectorAll('[data-sync]').forEach((el) => {
    const id = el.getAttribute('data-sync');
    const primary = $(id);
    if (!primary) return;
    el.checked = primary.checked;
    el.onchange = () => { primary.checked = el.checked; primary.dispatchEvent(new Event('change')); };
    primary.addEventListener('change', () => { el.checked = primary.checked; });
  });
}

async function boot() {
  if (!(await ensureAuth())) return;
  bindAccountMenu();
  bindMobileChrome();
  bindModelPicker();
  bindSkillPicker();
  await loadGatewayConfig();
  await loadModels();
  await refreshWorkspaces();
  await refreshKB();
  connectHub();
  showWelcome();
}
boot();
