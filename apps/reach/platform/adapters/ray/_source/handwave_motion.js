/* Presentation-only input modality and popover origins; no application actions. */
(() => {
  'use strict';
  const root = document.documentElement;
  if (root.dataset.hwMotionReady === '1') return;
  root.dataset.hwMotionReady = '1';
  root.dataset.hwMotion = 'keyboard';
  document.addEventListener('pointerdown', event => {
    const mode = event.pointerType === 'mouse' ? 'pointer' : 'touch';
    if (root.dataset.hwMotion !== mode) root.dataset.hwMotion = mode;
  }, {capture:true, passive:true});
  document.addEventListener('keydown', () => {
    if (root.dataset.hwMotion !== 'keyboard') root.dataset.hwMotion = 'keyboard';
  }, {capture:true, passive:true});
  for (const [menuID, triggerID] of [['modelMenu','modelTrigger'],['accountMenu','accountTrigger'],['attachMenu','btnAttach']]) {
    const menu = document.getElementById(menuID);
    const trigger = document.getElementById(triggerID);
    if (!menu || !trigger) continue;
    new MutationObserver(() => {
      if (menu.classList.contains('hide')) return;
      const anchor = trigger.getBoundingClientRect();
      const left = Number.parseFloat(menu.style.left);
      const top = Number.parseFloat(menu.style.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) return;
      const x = Math.max(0, Math.min(menu.offsetWidth, anchor.left + anchor.width / 2 - left));
      const y = top < anchor.top ? menu.offsetHeight : 0;
      menu.style.transformOrigin = `${x}px ${y}px`;
    }).observe(menu, {attributes:true, attributeFilter:['class']});
  }
})();
