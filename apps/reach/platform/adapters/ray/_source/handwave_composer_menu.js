/* Keep execution choices in the existing attachment menu, away from the draft. */
(() => {
  'use strict';
  const menu = document.getElementById('attachMenu');
  const trigger = document.getElementById('btnAttach');
  if (!menu || !trigger || !window.HandwaveLinks || document.getElementById('hwGoalMenuItem')) return;
  const separator = document.createElement('div');
  separator.className = 'model-sep'; separator.setAttribute('role', 'separator'); menu.appendChild(separator);
  function item(id, icon, title, action) {
    const button = document.createElement('button'); button.id = id; button.type = 'button';
    button.className = 'attach-item'; button.setAttribute('role', 'menuitem');
    const symbol = document.createElement('span'); symbol.textContent = icon; symbol.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.textContent = title;
    button.appendChild(symbol); button.appendChild(label);
    button.addEventListener('click', () => {
      if (button.disabled) return;
      if (typeof closeAttachMenu === 'function') closeAttachMenu();
      action();
    });
    menu.appendChild(button); return button;
  }
  const goal = item('hwGoalMenuItem', '◎', '目标', () => window.HandwaveLinks.openGoalEditor());
  const plan = item('hwPlanMenuItem', '☷', '计划模式', () => window.HandwaveLinks.setMode('plan'));
  function refresh() {
    const state = window.HandwaveLinks.state();
    const busy = typeof localBusy !== 'undefined' && localBusy || typeof sending !== 'undefined' && sending;
    const ready = typeof localMode !== 'undefined' && localMode && state.capabilities.includes('run-modes-v1') && typeof paired !== 'undefined' && paired && typeof helloDone !== 'undefined' && helloDone;
    goal.disabled = !ready || !!busy && !state.goal; plan.disabled = !ready || !!busy;
    goal.title = !ready ? '先接入支持目标模式的本机 Agent' : state.goal ? '查看当前目标' : '编辑目标草稿';
    plan.title = !ready ? '先接入支持计划模式的本机 Agent' : busy ? '任务结束后可切换模式' : '先分析和制定计划，不修改文件或运行命令';
  }
  trigger.title = '添加附件、技能或运行模式'; menu.setAttribute('aria-label', trigger.title);
  menu.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    if (typeof closeAttachMenu === 'function') closeAttachMenu();
    trigger.focus();
  });
  trigger.addEventListener('click', refresh); refresh();
})();
