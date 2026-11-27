// Copyright (c) Ray Zhang. Reach 自绘下拉框：控制台与 Reach Desk 共用（Desk 从 ../assets/dropdown.js 动态加载）。
// 按钮 + 列表弹层（popover 顶层，能盖在对话框之上）。键盘：↑↓/Home/End 移动，Enter/空格选中，Esc/Tab 关闭，输入字母跳转。
export interface Choice { value: string; label: string; hint?: string }
const easeOut = 'cubic-bezier(0.23, 1, 0.32, 1)';
const chevronPath = 'M6 9l6 6 6-6', checkPath = 'M5 12l5 5 9-10';
function reducedMotion() { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
}
function icon(d: string, className: string) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', `ic ${className}`); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); svg.append(path); return svg;
}
let dropdownSeq = 0;
// 自绘下拉框：按钮 + 列表弹层（popover 顶层，能盖在对话框之上）。键盘：↑↓/Home/End 移动，Enter/空格选中，Esc/Tab 关闭，输入字母跳转。
export class Dropdown {
  readonly element: HTMLDivElement;
  private readonly trigger: HTMLButtonElement;
  private readonly text: HTMLSpanElement;
  private readonly list: HTMLDivElement;
  private choices: Choice[] = [];
  private current = '';
  private active = -1;
  private typed = ''; private typedAt = 0;
  private placeholder: string;
  onChange?: (value: string) => void;
  constructor(label: string, placeholder = '请选择') {
    this.placeholder = placeholder;
    const id = `dd-${++dropdownSeq}`;
    this.element = el('div', 'dd');
    this.trigger = el('button', 'dd-trigger'); this.trigger.type = 'button';
    this.trigger.setAttribute('role', 'combobox'); this.trigger.setAttribute('aria-haspopup', 'listbox'); this.trigger.setAttribute('aria-expanded', 'false'); this.trigger.setAttribute('aria-controls', id); this.trigger.setAttribute('aria-label', label);
    this.text = el('span', 'dd-text');
    const chevron = icon(chevronPath, 'dd-chevron');
    this.trigger.append(this.text, chevron);
    this.list = el('div', 'dd-list'); this.list.id = id; this.list.setAttribute('role', 'listbox'); this.list.setAttribute('popover', 'manual'); this.list.setAttribute('aria-label', label);
    this.element.append(this.trigger, this.list);
    this.trigger.addEventListener('click', () => this.isOpen ? this.close() : this.open());
    this.trigger.addEventListener('keydown', event => this.key(event));
    this.trigger.addEventListener('blur', () => setTimeout(() => { if (!this.element.contains(document.activeElement)) this.close(); }));
    this.list.addEventListener('pointerdown', event => event.preventDefault());
    this.render();
  }
  get value() { return this.current; }
  set value(next: string) { if (this.choices.some(c => c.value === next)) { this.current = next; this.render(); } }
  has(value: string) { return this.choices.some(c => c.value === value); }
  get disabled() { return this.trigger.disabled; }
  set disabled(next: boolean) { this.trigger.disabled = next; if (next) this.close(); }
  setOptions(choices: Choice[], keep = this.current) {
    this.choices = choices;
    this.current = choices.some(c => c.value === keep) ? keep : choices[0]?.value ?? '';
    this.render();
  }
  private get isOpen() { return this.trigger.getAttribute('aria-expanded') === 'true'; }
  private render() {
    const choice = this.choices.find(c => c.value === this.current);
    this.text.textContent = choice?.label ?? (this.choices.length ? this.placeholder : this.placeholder);
    this.text.classList.toggle('placeholder', !choice);
  }
  private open() {
    if (this.trigger.disabled || !this.choices.length) return;
    this.list.replaceChildren();
    this.choices.forEach((choice, index) => {
      const option = el('div', 'dd-option'); option.id = `${this.list.id}-${index}`; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(choice.value === this.current));
      option.append(el('span', '', choice.label)); if (choice.hint) option.append(el('small', '', choice.hint));
      option.append(icon(checkPath, 'dd-tick'));
      option.addEventListener('pointermove', () => this.highlight(index, false));
      option.addEventListener('click', () => this.pick(index));
      this.list.append(option);
    });
    const rect = this.trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12, up = below < 220 && above > below;
    this.list.classList.toggle('up', up);
    this.list.style.setProperty('left', `${rect.left}px`); this.list.style.setProperty('min-width', `${rect.width}px`);
    this.list.style.setProperty('max-height', `${Math.max(160, Math.min(320, up ? above : below))}px`);
    if (up) { this.list.style.setProperty('top', 'auto'); this.list.style.setProperty('bottom', `${window.innerHeight - rect.top + 6}px`); }
    else { this.list.style.setProperty('bottom', 'auto'); this.list.style.setProperty('top', `${rect.bottom + 6}px`); }
    this.list.showPopover();
    this.trigger.setAttribute('aria-expanded', 'true');
    this.highlight(Math.max(0, this.choices.findIndex(c => c.value === this.current)), true);
    window.addEventListener('scroll', this.closeOnScroll, true); window.addEventListener('resize', this.closeOnScroll);
  }
  private closeOnScroll = (event: Event) => { if (event.target instanceof Node && this.list.contains(event.target)) return; this.close(); };
  close() {
    if (!this.isOpen) return;
    this.trigger.setAttribute('aria-expanded', 'false'); this.trigger.removeAttribute('aria-activedescendant');
    if (this.list.matches(':popover-open')) this.list.hidePopover();
    window.removeEventListener('scroll', this.closeOnScroll, true); window.removeEventListener('resize', this.closeOnScroll);
  }
  private highlight(index: number, scroll: boolean) {
    this.active = index;
    this.list.querySelectorAll('.dd-option').forEach((node, i) => node.classList.toggle('active', i === index));
    const node = this.list.children[index] as HTMLElement | undefined;
    if (node) { this.trigger.setAttribute('aria-activedescendant', node.id); if (scroll) node.scrollIntoView({ block: 'nearest' }); }
  }
  private pick(index: number) {
    const choice = this.choices[index]; this.close(); this.trigger.focus();
    if (!choice || choice.value === this.current) return;
    this.current = choice.value; this.render();
    if (!reducedMotion()) this.text.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: easeOut });
    this.onChange?.(choice.value);
  }
  private key(event: KeyboardEvent) {
    const count = this.choices.length; if (!count) return;
    if (!this.isOpen) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); this.open(); }
      return;
    }
    if (event.key === 'ArrowDown') { event.preventDefault(); this.highlight(Math.min(count - 1, this.active + 1), true); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); this.highlight(Math.max(0, this.active - 1), true); }
    else if (event.key === 'Home') { event.preventDefault(); this.highlight(0, true); }
    else if (event.key === 'End') { event.preventDefault(); this.highlight(count - 1, true); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.pick(this.active); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); }
    else if (event.key === 'Tab') this.close();
    else if (event.key.length === 1) {
      const now = Date.now(); this.typed = (now - this.typedAt > 700 ? '' : this.typed) + event.key.toLowerCase(); this.typedAt = now;
      const found = this.choices.findIndex(c => c.label.toLowerCase().startsWith(this.typed)); if (found >= 0) this.highlight(found, true);
    }
  }
}
