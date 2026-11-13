/* Explicit, device-bound cloud memory management. No automatic extraction/upload. */
(() => {
  'use strict';
  const host = document.querySelector('.hw-context-body');
  if (!host || document.documentElement.dataset.hwMemoryReady === '1') return;
  document.documentElement.dataset.hwMemoryReady = '1';
  const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const identity = () => JSON.stringify([curWS && curWS.id || '', curWS && curWS.device_fp || '', curSess && curSess.id || '']);
  let owner = identity(), epoch = 0, sequence = 0, data = null, loading = false, writing = false, uncertain = false;
  let view = 'memory', memoryScope = 'device';
  let scope = 'device', edit = null, editScope = '', editOwner = '', editEpoch = 0;
  const card = node('details', 'hw-context-card hw-memory-card'); host.appendChild(card);
  card.open = false;
  const cardHeading = node('summary', 'hw-context-heading hw-card-summary', '云端记忆 · 本机 · 未加载'); card.appendChild(cardHeading);
  const body = node('div', 'hw-memory-body'); card.appendChild(body);
  function reveal() { card.open = true; if (host.parentNode && host.parentNode.tagName.toLowerCase() === 'details') host.parentNode.open = true; }
  const refresh = node('button', 'hw-context-refresh', '刷新'); refresh.type = 'button'; body.appendChild(refresh);
  const context = node('p', 'hw-context-hint hw-memory-context'); body.appendChild(context);
  const select = node('select', 'hw-memory-select'); select.setAttribute('aria-label', '记忆范围');
  [['device', '本机'], ['project', '项目'], ['workspace', '全局（Ray 共享）']].forEach(([value, label]) => { const o = node('option', '', label); o.value = value; select.appendChild(o); });
  select.value = scope; body.appendChild(select);
  const message = node('p', 'hw-context-hint'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite'); body.appendChild(message);
  const list = node('div', 'hw-memory-list'); body.appendChild(list);
  const add = node('button', 'hw-memory-button', '添加记忆'); add.type = 'button'; body.appendChild(add);
  const group = node('details', 'hw-memory-group'); group.appendChild(node('summary', '', '共享项目设置')); body.appendChild(group);
  group.appendChild(node('p', 'hw-context-hint', '加入同一项目的电脑共享项目记忆；本机记忆仍按电脑隔离。'));
  const project = node('select', 'hw-memory-select'); project.setAttribute('aria-label', '共享项目'); group.appendChild(project);
  const join = node('button', 'hw-memory-button', '应用项目设置'); join.type = 'button'; group.appendChild(join);
  body.appendChild(node('p', 'hw-context-hint hw-memory-note', '只保存你明确添加的内容。撤销在下次新请求生效；已运行或排队任务不即时中断，历史原件保留。'));
  const dialog = node('dialog', 'hw-memory-dialog'); dialog.setAttribute('aria-labelledby', 'hwMemoryDialogTitle'); document.body.appendChild(dialog);
  const form = node('form', ''); dialog.appendChild(form);
  const heading = node('h2', '', '添加记忆'); heading.id = 'hwMemoryDialogTitle'; form.appendChild(heading);
  const lessonScope = node('select', 'hw-memory-select'); lessonScope.setAttribute('aria-label', '云端经验保存范围'); lessonScope.hidden = true;
  [['device', '本机'], ['project', '项目'], ['workspace', '全局（Ray 共享）']].forEach(([value, label]) => { const o = node('option', '', label); o.value = value; lessonScope.appendChild(o); }); form.appendChild(lessonScope);
  const kinds = {fact: '事实', preference: '偏好', decision: '决策', lesson: '经验', knowledge: '知识'};
  const kind = node('select', 'hw-memory-select'); kind.setAttribute('aria-label', '记忆类型');
  Object.entries(kinds).forEach(([value, text]) => { const o = node('option', '', text); o.value = value; kind.appendChild(o); }); form.appendChild(kind);
  function field(tag, labelText, max) {
    const label = node('label', 'hw-memory-field', labelText), input = node(tag, ''); input.required = true; input.maxLength = max; label.appendChild(input); form.appendChild(label); return input;
  }
  const title = field('input', '标题', 120), text = field('textarea', '内容', 8192); text.rows = 7;
  const dialogNote = node('p', 'hw-context-hint'); dialogNote.setAttribute('role', 'status'); form.appendChild(dialogNote);
  const actions = node('div', 'hw-memory-actions'); form.appendChild(actions);
  const cancel = node('button', 'hw-memory-button', '取消'); cancel.type = 'button'; actions.appendChild(cancel);
  const save = node('button', 'hw-memory-button', '保存'); save.type = 'submit'; actions.appendChild(save);
  function bound() { return !!(curWS && curWS.id && typeof curWS.device_fp === 'string' && curWS.device_fp.trim()); }
  function verified() { return bound() && data && data.binding && data.binding.workspace_id === curWS.id && data.binding.device_fp === curWS.device_fp; }
  function writable() { return verified() && !loading && !writing && !uncertain; }
  function editable() { return writable() && (scope !== 'project' || !!data.binding.project_id); }
  function close() {
    const wasOpen = dialog.open;
    if (wasOpen) dialog.close(); edit = null; title.value = ''; text.value = ''; lessonScope.hidden = true;
    // Rows are rebuilt while writing. Always return to a stable current-card control.
    if (wasOpen) { const target = !refresh.disabled ? refresh : !add.disabled ? add : card; if (target === card) target.setAttribute('tabindex', '-1'); target.focus({preventScroll: true}); }
  }
  function reset() { owner = identity(); epoch++; sequence++; data = null; loading = false; writing = false; uncertain = false; close(); }
  function current(ticket) { return ticket.owner === identity() && ticket.epoch === epoch; }
  function render() {
    const knowledge = view === 'knowledge';
    const scopeLabel = {device: '本机', project: '项目', workspace: '全局'}[scope];
    const rows = verified() && !loading && Array.isArray(data.records) ? data.records.filter(r => r && r.scope === scope && (!knowledge || r.kind === 'knowledge') && (r.status === 'accepted' || r.status === 'active')).slice(0, 256) : null;
    cardHeading.textContent = (knowledge ? '项目知识条目' : '云端记忆') + ' · ' + scopeLabel + ' · ' + (loading ? '读取中' : rows ? rows.length + ' 条' : '未加载');
    select.hidden = knowledge; select.value = scope; add.textContent = knowledge ? '添加知识' : '添加记忆';
    context.textContent = curWS && curWS.id ? '工作区：' + (curWS.name || curWS.id) + ' · ' + (bound() ? '电脑指纹：' + curWS.device_fp : '尚未绑定电脑') : '尚未选择工作区';
    if (knowledge && verified()) context.textContent += data.binding.project_id ? ' · 共享项目：' + data.binding.project_id : ' · 尚未加入共享项目';
    list.replaceChildren(); refresh.disabled = loading || writing || !bound(); select.disabled = writing; lessonScope.disabled = writing;
    add.disabled = !editable(); project.disabled = !verified() || loading || writing || uncertain; join.disabled = project.disabled;
    const empty = !bound() ? (curWS && curWS.id ? '先将工作区绑定到一台电脑，再管理云端记忆。' : '请先选择工作区，再管理对应电脑的云端记忆。') : (loading ? '正在读取云端记忆…' : (!verified() ? '记忆未加载，请刷新。' : ''));
    if (empty && (!bound() || loading || !message.textContent)) message.textContent = empty;
    if (!verified()) return;
    if (scope === 'project' && !data.binding.project_id) { message.textContent = '先在下方选择共享项目，点击“应用项目设置”，再添加项目知识或记忆。'; group.open = true; return; }
    if (loading) return;
    if (!rows) return;
    if (!message.textContent || /正在读取|记忆未加载|先在下方/.test(message.textContent)) message.textContent = rows.length ? rows.length + (knowledge ? ' 条项目知识' : ' 条记忆 · 本次范围') : (knowledge ? '项目知识库还是空的。可以先保存项目约定、架构说明或排障经验。' : '这个范围还没有记忆。');
    rows.forEach(record => {
      const row = node('div', 'hw-memory-row'); row.appendChild(node('b', '', record.title || '未命名记忆'));
      row.appendChild(node('small', '', (kinds[record.kind] || '记忆') + ' · 版本 ' + record.revision));
      row.appendChild(node('p', '', typeof record.text === 'string' ? record.text.slice(0, 160) : ''));
      const buttons = node('div', 'hw-memory-actions'); row.appendChild(buttons);
      [['编辑', false], ['撤销', true]].forEach(([caption, revoke]) => { const b = node('button', 'hw-memory-button', caption); b.type = 'button'; b.disabled = !editable(); b.addEventListener('click', () => open(record, revoke)); buttons.appendChild(b); });
      list.appendChild(row);
    });
  }
  function populateProjects() {
    project.replaceChildren(); const empty = node('option', '', '不加入共享项目'); empty.value = ''; project.appendChild(empty);
    const projects = Array.isArray(data.projects) ? data.projects.slice(0, 256) : [], seen = new Set();
    for (const p of projects.concat([{id: curWS.id, name: (curWS.name || '本工作区') + '项目组'}])) {
      if (!p || typeof p.id !== 'string' || !p.id || seen.has(p.id)) continue; seen.add(p.id);
      const o = node('option', '', typeof p.name === 'string' ? p.name : p.id); o.value = p.id; project.appendChild(o);
    }
    if (data.binding.project_id && !seen.has(data.binding.project_id)) { const o = node('option', '', '当前已加入项目'); o.value = data.binding.project_id; project.appendChild(o); }
    project.value = data.binding.project_id || '';
  }
  async function load() {
    if (owner !== identity()) reset();
    close(); data = null; uncertain = false;
    if (!bound()) { render(); return; }
    const ticket = {owner: identity(), epoch, seq: ++sequence}, selectedScope = scope;
    loading = true; message.textContent = ''; render();
    try {
      const result = await api('/cloud-memory?workspace_id=' + encodeURIComponent(curWS.id) + '&device_fp=' + encodeURIComponent(curWS.device_fp) + '&scope=' + encodeURIComponent(selectedScope));
      if (!current(ticket) || ticket.seq !== sequence || selectedScope !== scope) return;
      data = result;
      if (!verified()) throw new Error('binding mismatch');
      populateProjects(); message.textContent = '';
    } catch (_) {
      if (!current(ticket) || ticket.seq !== sequence) return;
      data = null; message.textContent = '读取失败，请刷新重试。';
    } finally { if (current(ticket) && ticket.seq === sequence) { loading = false; render(); } }
  }
  function open(record, revoke) {
    if (!editable()) return;
    edit = record ? {id: record.id, revision: record.revision, revoke} : null;
    editScope = scope; editOwner = identity(); editEpoch = epoch;
    const label = view === 'knowledge' ? '知识' : '记忆';
    heading.textContent = (revoke ? '撤销' : record ? '编辑' : '添加') + label;
    kind.value = view === 'knowledge' ? 'knowledge' : record && kinds[record.kind] ? record.kind : 'fact'; title.value = record && record.title || ''; text.value = record && record.text || '';
    title.disabled = text.disabled = !!revoke; kind.disabled = !!revoke || view === 'knowledge';
    save.disabled = false; cancel.disabled = false; save.textContent = revoke ? '确认撤销' : '保存';
    dialogNote.textContent = revoke ? '撤销在下次新请求生效；已运行或排队任务不即时中断，历史原件仍保留。' : '请确认内容适合当前选择的共享范围；内容上限 8 KiB（中文约 2700 字）。';
    dialog.showModal();
  }
  async function write(path, payload) {
    if (!(path === '/cloud-memory/project' ? writable() : editable())) return;
    const ticket = {owner: identity(), epoch}; writing = true; save.disabled = true; render();
    try {
      await api(path, {method: 'POST', body: JSON.stringify(Object.assign({workspace_id: curWS.id, device_fp: curWS.device_fp, op_id: crypto.randomUUID()}, payload))});
      if (!current(ticket)) return;
      writing = false; close(); await load();
      if (current(ticket) && verified()) { message.textContent = '已更新云端记忆。'; render(); }
    } catch (error) {
      if (!current(ticket)) return;
      writing = false; uncertain = true;
      const conflict = /409|revision|版本|conflict|stale/i.test(String(error && error.message || ''));
      message.textContent = conflict ? '版本已变化，请刷新后重新核对。' : '操作结果未确认，请刷新核对后再操作。';
      dialogNote.textContent = message.textContent; render(); save.disabled = true;
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (editOwner !== identity() || editEpoch !== epoch || editScope !== scope || !editable()) return;
    if (edit && edit.revoke) { write('/cloud-memory/revoke', {scope, id: edit.id, expected_revision: edit.revision}); return; }
    if (!title.value.trim() || !text.value.trim() || !kinds[kind.value]) { dialogNote.textContent = '请填写标题和内容。'; return; }
    if (new TextEncoder().encode(text.value.trim()).length > 8192) { dialogNote.textContent = '内容超过 8 KiB，请缩短后保存。'; return; }
    const body = {scope, kind: view === 'knowledge' ? 'knowledge' : kind.value, title: title.value.trim(), text: text.value.trim(), expected_revision: edit ? edit.revision : 0};
    if (edit) body.id = edit.id;
    write('/cloud-memory/records', body);
  });
  cancel.addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if ((event.ctrlKey || event.metaKey) && ['n', '/'].includes(event.key.toLowerCase())) event.stopPropagation();
  });
  add.addEventListener('click', () => open(null, false)); refresh.addEventListener('click', load);
  lessonScope.addEventListener('change', () => {
    if (writing || !dialog.open || lessonScope.hidden || editOwner !== identity() || editEpoch !== epoch) return;
    scope = ['device', 'project', 'workspace'].includes(lessonScope.value) ? lessonScope.value : 'device'; editScope = scope; memoryScope = scope;
    save.disabled = !editable(); dialogNote.textContent = scope === 'project' && !data.binding.project_id ? '请先取消，并在共享项目设置中加入项目，再保存项目经验。' : '保存为独立云端副本，撤销各自生效；请核对当前共享范围与内容。'; render();
  });
  select.addEventListener('change', () => { scope = ['device', 'project', 'workspace'].includes(select.value) ? select.value : 'device'; epoch++; load(); });
  join.addEventListener('click', () => { if (!verified() || loading || writing || uncertain) return; write('/cloud-memory/project', {project_id: project.value, expected_revision: data.binding.revision}); });
  window.HandwaveMemory = Object.freeze({
    async openLesson(seed) {
      if (!seed || seed.owner !== identity() || writing || typeof seed.text !== 'string' || new TextEncoder().encode(seed.text).length > 8192) return false;
      reveal();
      const seedOwner = identity();
      view = 'memory'; scope = 'device'; memoryScope = scope; epoch++; await load();
      if (seedOwner !== identity() || !editable()) return false;
      open(null, false); kind.value = 'lesson'; title.value = String(seed.title || '排障经验').slice(0, 120); text.value = seed.text;
      lessonScope.hidden = false; lessonScope.value = scope; dialogNote.textContent = '保存为独立云端副本，撤销各自生效；请审阅经验与适用条件，再选择本机、项目或全局共享。';
      return true;
    },
    // Only presentation changes here; the existing owner/epoch and API remain authoritative.
    setView(next) {
      if (!['memory', 'knowledge'].includes(next)) return false;
      if (next === view) { reveal(); return true; }
      if (writing) return false;
      reveal();
      if (next === 'knowledge') memoryScope = scope;
      view = next; scope = next === 'knowledge' ? 'project' : memoryScope;
      epoch++; load(); return true;
    }
  });
  const oldSession = selectSession;
  selectSession = function() { reset(); const result = oldSession.apply(this, arguments); reset(); load(); return result; };
  const oldWorkspace = selectWorkspace;
  selectWorkspace = function() { reset(); const result = oldWorkspace.apply(this, arguments); reset(); load(); return result; };
  if (typeof syncRailDeviceLabels === 'function') {
    const oldLabels = syncRailDeviceLabels;
    syncRailDeviceLabels = function() {
      const result = oldLabels.apply(this, arguments);
      // Native pairing commits device_fp before refreshing the rail labels.
      // React to that identity transition once, without observing or polling DOM.
      if (owner !== identity()) { reset(); load(); }
      return result;
    };
  }
  load();
})();
