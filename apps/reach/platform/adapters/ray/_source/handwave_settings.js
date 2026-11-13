/* Workbench settings. Preferences stay local; context remains ephemeral; skill CRUD stays with its existing owner. */
(() => {
  'use strict';
  const menu = document.getElementById('accountMenu');
  if (!menu || !window.HandwaveSuggestions || document.documentElement.dataset.hwSettingsReady === '1') return;
  document.documentElement.dataset.hwSettingsReady = '1';
  const api = window.HandwaveSuggestions;
  const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const button = (cls, text) => { const e = node('button', cls, text); e.type = 'button'; return e; };
  const entry = button('account-item', '设置'); entry.id = 'btnHandwaveSettings';
  entry.setAttribute('role', 'menuitem'); entry.setAttribute('aria-haspopup', 'dialog'); entry.setAttribute('aria-controls', 'hwSettingsDialog');
  menu.insertBefore(entry, document.getElementById('btnLogout'));
  const dialog = node('dialog', 'hw-memory-dialog hw-settings-dialog'); dialog.id = 'hwSettingsDialog'; dialog.setAttribute('aria-labelledby', 'hwSettingsTitle');
  document.body.appendChild(dialog);
  const layout = node('div', 'hw-settings-layout'); dialog.appendChild(layout);
  const sidebar = node('aside', 'hw-settings-sidebar'); layout.appendChild(sidebar);
  const heading = node('h2', '', '设置'); heading.id = 'hwSettingsTitle'; sidebar.appendChild(heading);
  const nav = node('div', 'hw-settings-nav'); nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', '设置分类'); nav.setAttribute('aria-orientation', 'vertical'); sidebar.appendChild(nav);
  const compactTabs = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 680px)') : null;
  function syncTabOrientation() { nav.setAttribute('aria-orientation', compactTabs && compactTabs.matches ? 'horizontal' : 'vertical'); }
  syncTabOrientation();
  if (compactTabs) {
    if (typeof compactTabs.addEventListener === 'function') compactTabs.addEventListener('change', syncTabOrientation);
    else if (typeof compactTabs.addListener === 'function') compactTabs.addListener(syncTabOrientation);
  }
  sidebar.appendChild(node('p', 'hw-settings-local-note', '按你的习惯，安排工作方式。'));
  const content = node('div', 'hw-settings-content'); layout.appendChild(content);
  const close = button('hw-settings-close', '×'); close.setAttribute('aria-label', '关闭设置'); dialog.appendChild(close);
  const panels = {}, tabs = {}, fields = {};
  let active = 'general', refreshing = false, failure = '', returnToAccount = true;
  const categories = [['general', '常规', '建议与输入', 'sliders'], ['appearance', '外观', '熟悉的界面，舒适的节奏', 'sun'], ['context', '上下文', '让下一步接得上当前工作', 'layers'], ['memory', '云端记忆', '保存值得留到下一次的事实、偏好和经验', 'layers'], ['knowledge', '项目知识库', '让项目约定和经验跟着工作走', 'layers'], ['skills', '技能', '将常用工作流程保存为可复用的技能', 'spark'], ['shortcuts', '快捷键', '少一点切换，多一点顺手', 'keyboard']];
  const paths = {sliders: 'M4 7h16M4 17h16M8 4v6M16 14v6', sun: 'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0', layers: 'm12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5', spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z', keyboard: 'M3 5h18v14H3V5ZM7 9h.01M11 9h.01M15 9h.01M7 13h.01M11 13h.01M15 13h.01M7 16h10'};
  for (const [id, label, subtitle, icon] of categories) {
    const tab = button('hw-settings-tab'); tab.id = 'hwSettingsTab_' + id; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'hwSettingsPanel_' + id);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[icon]); svg.appendChild(path); tab.appendChild(svg); tab.appendChild(node('span', '', label)); nav.appendChild(tab); tabs[id] = tab;
    const panel = node('section', 'hw-settings-panel'); panel.id = 'hwSettingsPanel_' + id; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); panel.tabIndex = 0;
    panel.appendChild(node('h3', 'hw-settings-page-title', label)); panel.appendChild(node('p', 'hw-settings-subtitle', subtitle)); content.appendChild(panel); panels[id] = panel;
    tab.addEventListener('click', () => selectTab(id));
    tab.addEventListener('keydown', event => {
      const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End']; if (!keys.includes(event.key)) return;
      event.preventDefault(); const ids = categories.map(c => c[0]), index = ids.indexOf(id);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (index + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
      selectTab(ids[next]); tabs[active].focus();
    });
  }
  function group(parent, title) { parent.appendChild(node('h4', 'hw-settings-section-title', title)); const e = node('div', 'hw-settings-group'); parent.appendChild(e); return e; }
  function row(parent, title, detail) {
    const e = node('div', 'hw-settings-row'), copy = node('div', 'hw-settings-copy');
    copy.appendChild(node('b', '', title)); if (detail) copy.appendChild(node('small', '', detail)); e.appendChild(copy); parent.appendChild(e); return e;
  }
  function toggle(parent, key, title, detail, changed) {
    const e = row(parent, title, detail), input = node('input', 'hw-settings-switch'); input.type = 'checkbox'; input.id = 'hwSetting_' + key; input.setAttribute('aria-label', title); input.setAttribute('role', 'switch');
    e.firstChild.id = input.id + 'Hint'; input.setAttribute('aria-describedby', e.firstChild.id); e.appendChild(input); fields[key] = input;
    input.addEventListener('change', () => {
      try { if (changed) changed(input.checked); else api.setPreferences({[key]: input.checked}); failure = ''; }
      catch (_) { failure = '设置未更新，请重试。'; }
      render();
    }); return input;
  }
  const general = group(panels.general, '输入与建议');
  toggle(general, 'enabled', '下一步建议', '在空输入框中提供一条建议，按需采用。');
  toggle(general, 'tab_accept', 'Tab 填入建议', '填入后可以修改，再由你发送；Escape 忽略本条建议。');
  panels.general.appendChild(node('p', 'hw-settings-footnote', '这些偏好仅保存在此浏览器，修改后立即生效。'));
  const appearance = group(panels.appearance, '界面');
  const themeRow = row(appearance, '主题', '与工作台使用相同的亮色和暗色主题。'), themes = node('div', 'hw-settings-segment'); themes.setAttribute('role', 'group'); themes.setAttribute('aria-label', '主题'); themeRow.appendChild(themes);
  const themeButtons = {};
  for (const [id, label] of [['light', '亮色'], ['dark', '暗色']]) { const b = button('', label); themes.appendChild(b); themeButtons[id] = b; b.addEventListener('click', () => { if (typeof applyTheme === 'function') applyTheme(id); render(); }); }
  let reducedMotion = false;
  try { reducedMotion = localStorage.getItem('handwave.settings.reduce-motion') === 'true'; } catch (_) {}
  function applyMotion() { document.documentElement.dataset.hwReduceMotion = String(reducedMotion); }
  applyMotion();
  toggle(appearance, 'reduce_motion', '减少动画', '缩短工作台的过渡效果；系统的减少动态偏好始终受尊重。', value => { reducedMotion = value; applyMotion(); try { localStorage.setItem('handwave.settings.reduce-motion', String(value)); } catch (_) {} });
  panels.appearance.appendChild(node('p', 'hw-settings-footnote', '外观偏好仅影响此浏览器。'));
  const memoryGroup = group(panels.context, '建议使用的上下文');
  toggle(memoryGroup, 'include_memory', '参考云端记忆', '仅影响候选建议；不会关闭 Agent 执行时使用的云端记忆。');
  const section = node('section', 'hw-settings-context'); panels.context.appendChild(section);
  section.appendChild(node('h4', 'hw-settings-section-title', '本会话上下文摘要'));
  section.appendChild(node('p', 'hw-context-hint', '由当前会话的公开消息与结果派生，用于生成下一步建议，不是模型的私有思考。'));
  const status = node('p', 'hw-context-hint'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); section.appendChild(status);
  const summary = node('p', 'hw-settings-summary'); section.appendChild(summary);
  const actions = node('div', 'hw-memory-actions hw-settings-actions'); section.appendChild(actions);
  const refresh = button('hw-memory-button', '刷新建议'); actions.appendChild(refresh);
  const memoryRow = row(group(panels.context, '云端记忆'), '管理记忆', '设备记忆默认隔离；项目与工作区记忆可按需共享。');
  const memory = button('hw-memory-button', '管理云端记忆'); memoryRow.appendChild(memory);
  panels.memory.appendChild(node('p', 'hw-settings-footnote', '记忆由你明确保存，供后续任务参考；上下文摘要仅服务当前会话的下一步建议。'));
  const chooseWorkspace = button('hw-memory-button hw-settings-workspace', '选择工作区'); panels.memory.appendChild(chooseWorkspace);
  const memoryHost = node('div', 'hw-settings-memory-host'); panels.memory.appendChild(memoryHost);
  panels.knowledge.appendChild(node('p', 'hw-settings-footnote', '保存共享项目的短文本知识：项目约定、架构说明、排障经验。Agent 新请求按相关性和预算参考，原始条目保留在云端。'));
  const chooseKnowledgeWorkspace = button('hw-memory-button hw-settings-workspace', '选择工作区'); panels.knowledge.appendChild(chooseKnowledgeWorkspace);
  const knowledgeHost = node('div', 'hw-settings-memory-host'); panels.knowledge.appendChild(knowledgeHost);
  let memoryCard = null, memoryParent = null, memoryNext = null;
  function mountMemory() {
    if (memoryCard) return;
    const card = document.querySelector('.hw-memory-card');
    if (!card) { memoryHost.textContent = '云端记忆暂不可用，请重新加载工作台。'; return; }
    memoryCard = card; memoryParent = card.parentNode; memoryNext = card.nextSibling;
    memoryHost.textContent = ''; memoryHost.appendChild(card);
  }
  function restoreMemory() {
    if (!memoryCard || !memoryParent) return;
    memoryParent.insertBefore(memoryCard, memoryNext && memoryNext.parentNode === memoryParent ? memoryNext : null);
    memoryCard = memoryParent = memoryNext = null;
  }
  const shortcutGroup = group(panels.shortcuts, '会话输入');
  for (const [name, detail, keys] of [['发送消息', '桌面键盘；手机请点发送按钮。', 'Enter'], ['输入框换行', '保留消息分段。', 'Shift + Enter'], ['采用下一步建议', '需要开启 Tab 填入，且输入框为空。', 'Tab'], ['忽略当前建议', '输入框聚焦时生效。', 'Esc']]) { row(shortcutGroup, name, detail).appendChild(node('kbd', '', keys)); }
  panels.shortcuts.appendChild(node('p', 'hw-settings-footnote', '这里展示当前快捷键，不修改系统或浏览器快捷键。'));
  const feedback = node('p', 'hw-settings-feedback'); feedback.setAttribute('role', 'status'); content.appendChild(feedback);
  // Keep the original dialog node and .open contract: its CRUD, dirty checks and async sequence belong to skills-ui.js.
  const manager = document.getElementById('skillManager');
  if (manager) { panels.skills.appendChild(manager); manager.classList.add('hw-settings-skills'); manager.setAttribute('role', 'group'); }
  else panels.skills.appendChild(node('p', 'hw-context-hint', '技能管理暂不可用，请重新加载工作台。'));
  function openSkills() {
    if (!manager || manager.open || typeof renderSkillManager !== 'function' || typeof loadSkills !== 'function') return;
    manager.show(); renderSkillManager(); loadSkills();
  }
  function selectTab(id) {
    if (dialog.open && (id === 'memory' || id === 'knowledge')) {
      if (window.HandwaveMemory && !window.HandwaveMemory.setView(id === 'knowledge' ? 'knowledge' : 'memory')) { failure = '正在更新云端内容，请完成后再切换。'; render(); return false; }
      if (memoryCard) (id === 'knowledge' ? knowledgeHost : memoryHost).appendChild(memoryCard);
    }
    active = id;
    for (const [key, tab] of Object.entries(tabs)) { const selected = key === id; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; panels[key].hidden = !selected; }
    content.scrollTop = 0;
    if (dialog.open && id === 'skills') openSkills();
    render();
  }
  function state() { try { return api.getState() || {}; } catch (_) { return {}; } }
  function owns(s) {
    if (!s.owner || typeof curWS === 'undefined' || typeof curSess === 'undefined' || !curWS || !curSess) return false;
    return s.owner.workspace_id === curWS.id && s.owner.session_id === curSess.id && s.owner.device_fp === curWS.device_fp;
  }
  function render() {
    const s = state(), local = owns(s), busy = refreshing || s.status === 'loading' || s.status === 'busy';
    for (const key of ['enabled', 'include_memory', 'tab_accept']) fields[key].checked = s[key] === true;
    fields.reduce_motion.checked = reducedMotion;
    fields.include_memory.disabled = fields.tab_accept.disabled = !fields.enabled.checked;
    refresh.disabled = !fields.enabled.checked || busy;
    memory.disabled = !document.querySelector('.hw-memory-card');
    for (const [id, b] of Object.entries(themeButtons)) { b.setAttribute('aria-pressed', String((document.documentElement.getAttribute('data-theme') || 'dark') === id)); b.disabled = typeof applyTheme !== 'function'; }
    const messages = {disabled: '已关闭下一步建议。', idle: '尚未生成摘要；有会话内容后可刷新建议。', busy: '等待当前任务结束后生成建议。', loading: '正在整理本会话上下文…', ready: '本次候选使用的派生摘要', unavailable: '建议生成失败或暂不可用；可以稍后重试。'};
    status.textContent = local || s.status === 'disabled' ? (messages[s.status] || '摘要状态未知，请刷新建议。') : '尚未生成本会话摘要。';
    summary.textContent = local && s.status === 'ready' && typeof s.summary === 'string' ? s.summary.slice(0, 8000) : ''; summary.hidden = !summary.textContent;
    feedback.textContent = failure; feedback.hidden = !failure;
  }
  function restoreFocus() { const trigger = document.getElementById('accountTrigger'); if (trigger) trigger.focus(); }
  function requestClose() {
    if (manager && manager.open) {
      // The existing close operation owns busy protection, discard confirmation, sequence invalidation and editor reset.
      if (typeof closeSkillManager !== 'function') return false;
      const focused = document.activeElement;
      closeSkillManager();
      if (manager.open) { failure = (typeof skillSaving !== 'undefined' && skillSaving) || (typeof skillGenerating !== 'undefined' && skillGenerating) ? '技能正在保存或生成，请完成后再关闭。' : ''; render(); if (focused) focused.focus(); return false; }
    }
    if (window.HandwaveMemory && !window.HandwaveMemory.setView('memory')) { failure = '正在更新云端内容，请完成后再关闭。'; render(); return false; }
    dialog.close(); return true;
  }
  function open(id) {
    if (typeof closeAccountMenu === 'function') closeAccountMenu();
    if (typeof closeAttachMenu === 'function') closeAttachMenu();
    failure = ''; returnToAccount = true;
    if (!dialog.open) { mountMemory(); dialog.showModal(); } selectTab(id || active); tabs[active].focus();
  }
  entry.addEventListener('click', () => open());
  // Capture remains effective if asynchronous boot installs the original onclick handlers afterwards.
  for (const id of ['btnSkillManager', 'skillManage']) { const legacy = document.getElementById(id); if (legacy) legacy.addEventListener('click', event => { event.preventDefault(); event.stopImmediatePropagation(); open('skills'); }, true); }
  const oldAccountSkills = document.getElementById('btnSkillManager'); if (oldAccountSkills) oldAccountSkills.hidden = true;
  close.addEventListener('click', requestClose);
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
  dialog.addEventListener('close', () => { restoreMemory(); if (returnToAccount) restoreFocus(); });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); requestClose(); return; } if ((event.ctrlKey || event.metaKey) && ['n', '/'].includes(event.key.toLowerCase())) event.stopPropagation(); });
  refresh.addEventListener('click', async () => {
    if (refresh.disabled) return;
    refreshing = true; failure = ''; render();
    try { await api.refresh(); } catch (_) { failure = '建议未更新，请稍后重试。'; }
    finally { refreshing = false; render(); }
  });
  memory.addEventListener('click', () => { selectTab('memory'); tabs[active].focus(); });
  function chooseCurrentWorkspace() {
    returnToAccount = false;
    if (!requestClose()) { returnToAccount = true; return; }
    const toggle = document.getElementById('btnOpenRail');
    if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    const tree = document.getElementById('wsTree');
    if (tree) { tree.setAttribute('tabindex', '-1'); tree.scrollIntoView({block: 'nearest'}); tree.focus({preventScroll: true}); }
    else restoreFocus();
  }
  chooseWorkspace.addEventListener('click', chooseCurrentWorkspace);
  chooseKnowledgeWorkspace.addEventListener('click', chooseCurrentWorkspace);
  window.addEventListener('handwave:suggestion-state', render);
  selectTab(active);
})();
