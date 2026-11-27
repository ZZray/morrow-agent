// Copyright (c) Ray Zhang. Reach 网页控制台：设备、配对、配置、操作与原收据、上线通知、下载和 MCP 接入。
import { ArtifactReader, parseArtifacts } from './artifacts.js';
import { availabilityStrip, barList, donut, lineChart } from './charts.js';
import { Dropdown } from './dropdown.js';
import { consoleSections } from './shell.js';
import { mountDesk } from './desk.js';
import * as M from './model.js';
import type { Device, DeviceEvent, Json, OperationSummary, Release, ReleaseArch, ReleaseAsset, ReleaseOs, Route, Tone, WebKind } from './model.js';
import { accentPresets, currentAccent, currentTheme, defaultAccent, restoreAppearance, setAccent, setTheme } from './theme.js';
import type { ThemeChoice } from './theme.js';

restoreAppearance();

interface User { id: string; username: string; csrf: string; pinIsDefault?: boolean }
interface Operation extends Omit<OperationSummary, 'kind'> { command_json: string; result_json: string | null; last_sequence: number }
interface Receipt { sequence: number; event_id: string; kind: string; data: Json; received_at: number }
interface Page { events: Receipt[]; nextAfter: number; hasMore: boolean }
interface EventPage { events: DeviceEvent[]; nextAfter: number; hasMore: boolean; unreadCount: number }
interface ConfigHistory { targetVersion: number; requestId: string; heartbeatIntervalSeconds: number; status: 'pending' | 'applied' | 'rejected'; createdAt: number; settledAt: number | null; receipt: Json }
type Runtime = Device & { configHistory: ConfigHistory[] };

const app = document.querySelector<HTMLDivElement>('#app')!;
const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content;
const rayLogin = meta('reach-login-provider') === 'ray';
const deskEnabled = meta('reach-desk') === 'enabled';
const REFRESH_MS = 15_000;

let user: User | null = null;
let generation = 0;
let viewGeneration = 0;
let refreshSequence = 0;
let devices: Device[] = [];
let operations: OperationSummary[] = [];
let unresolvedCount = 0;
let updatedAt = 0;
let deviceEvents: DeviceEvent[] = [];
let eventCursor: number | null = null;
let unreadCount = 0;
let eventsAvailable = true;
let route: Route = M.parseRoute(location.hash);
let deviceFilter: M.DeviceFilter = 'all';
let deviceQuery = '';
let operationFilter: M.OperationFilter = 'all';
let operationQuery = '';
let downloadOs: ReleaseOs | null = null;
let downloadArch: 'all' | ReleaseArch = 'all';
let downloadHistoryAll = false;
let notice: HTMLDivElement | null = null;
let top: HTMLElement | null = null;
let main: HTMLElement | null = null;
let refreshTimer = 0;
let pairing: { code: string; expiresAt: number } | null = null;

// ---------- 小工具 ----------
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag); if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
const iconPaths: Record<string, string[]> = {
  devices: ['M3 5h18v11H3z', 'M8 20h8', 'M12 16v4'],
  ops: ['M4 6h16', 'M4 12h10', 'M4 18h13'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  plug: ['M9 3v5', 'M15 3v5', 'M6 8h12v3a6 6 0 0 1-12 0z', 'M12 17v4'],
  bell: ['M6 16V11a6 6 0 0 1 12 0v5l2 2H4z', 'M10 21h4'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4-4'],
  plus: ['M12 5v14', 'M5 12h14'],
  bolt: ['M13 2L4 14h7l-1 8 9-12h-7z'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 5v6h-6'],
  back: ['M15 5l-7 7 7 7'],
  check: ['M5 12l5 5 9-10'],
  chevron: ['M6 9l6 6 6-6'],
  copy: ['M9 9h11v11H9z', 'M5 15V4h11'],
  link: ['M10 14l4-4', 'M8 11l-2 2a3 3 0 0 0 4 4l2-2', 'M16 13l2-2a3 3 0 0 0-4-4l-2 2'],
  play: ['M7 5l12 7-12 7z'],
  pulse: ['M3 12h4l3-7 4 14 3-7h4'],
  shield: ['M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z'],
  key: ['M15 7a4 4 0 1 1-3.5 6L5 19.5V22H2v-3l6.5-6.5A4 4 0 0 1 15 7z'],
  logout: ['M15 4h4v16h-4', 'M10 8l-4 4 4 4', 'M6 12h10'],
  wait: ['M12 7v5l3 2', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'],
  alert: ['M12 8v5', 'M12 16.5v.5', 'M10.3 4l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0z'],
  // 操作类型图标：24 网格、1.5 圆角、统一 2px 内边距，线宽由 .ic 统一控制。
  terminal: ['M4.5 4.5h15A1.5 1.5 0 0 1 21 6v12a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V6a1.5 1.5 0 0 1 1.5-1.5z', 'M7 9.5l3 2.5-3 2.5', 'M12.5 15H17'],
  folder: ['M3 7a1.5 1.5 0 0 1 1.5-1.5h4.3l2 2.2h8.7A1.5 1.5 0 0 1 21 9.2v8.3a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z', 'M3 11h18'],
  file: ['M6.5 3H14l4.5 4.5v12A1.5 1.5 0 0 1 17 21H6.5A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3z', 'M14 3v4.5h4.5', 'M8.5 12.5h7', 'M8.5 16h4.5'],
  'file-edit': ['M12 21H6.5A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3H14l4.5 4.5v3', 'M14 3v4.5h4.5', 'M18.8 13.2a1.5 1.5 0 0 1 2.1 2.1L16 20.2l-2.8.7.7-2.8z'],
  screen: ['M4.5 4h15A1.5 1.5 0 0 1 21 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 14.5v-9A1.5 1.5 0 0 1 4.5 4z', 'M9 20h6', 'M12 16v4', 'M6.5 10c1.4-2 3.3-3 5.5-3s4.1 1 5.5 3c-1.4 2-3.3 3-5.5 3s-4.1-1-5.5-3z', 'M12 10.01v-.02'],
  lock: ['M7.5 11V8a4.5 4.5 0 0 1 9 0v3', 'M6.5 11h11A1.5 1.5 0 0 1 19 12.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-7A1.5 1.5 0 0 1 6.5 11z', 'M12 15v2.5'],
  sparkle: ['M11 3.5l1.7 4.8 4.8 1.7-4.8 1.7L11 16.5l-1.7-4.8L4.5 10l4.8-1.7z', 'M18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z'],
  arrow: ['M7 17L17 7', 'M8 7h9v9'],
  win: ['M4 5.5L10.5 4.6v6.7H4z', 'M12.5 4.3L20 3.2v8.1h-7.5z', 'M4 13h6.5v6.4L4 18.5z', 'M12.5 13H20v7.8l-7.5-1.1z'],
  mac: ['M4 6.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8.5H4z', 'M2 17h20', 'M9 17v1.5h6V17'],
  linux: ['M4 5.5a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z', 'M8 9.5l3 2.5-3 2.5', 'M12.5 15.5h4'],
};
function icon(name: string) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'ic'); svg.setAttribute('aria-hidden', 'true');
  for (const d of iconPaths[name] ?? []) { const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}
function button(label: string, action: () => void | Promise<void>, className = 'btn', iconName?: string) {
  const item = el('button', className); item.type = 'button';
  if (iconName) item.append(icon(iconName));
  if (label) item.append(el('span', '', label));
  item.addEventListener('click', () => { void run(item, action); }); return item;
}
function iconButton(name: string, label: string, action: () => void | Promise<void>, className = 'btn icon') {
  const item = button('', action, className, name); item.setAttribute('aria-label', label); item.title = label; return item;
}
async function run(item: HTMLButtonElement, action: () => void | Promise<void>) {
  const epoch = generation;
  // 禁用按钮会让浏览器把焦点移走，先记下它，原地刷新换上新内容后据此把焦点放回同名按钮。
  if (document.activeElement === item) actionFocus = focusSignature(item, item.closest('main') ?? document.body);
  item.disabled = true; item.setAttribute('aria-busy', 'true');
  // 超过 150ms 才显示按钮内的进行中指示，瞬时完成的操作不闪一下。
  const busy = window.setTimeout(() => item.classList.add('busy'), 150);
  try { await action(); } catch (error) { if (epoch === generation && !(error instanceof StaleRequest)) message(error instanceof Error ? error.message : '操作未完成，请检查连接', 'error'); }
  finally {
    // 操作触发的原地刷新换上新内容前，按钮保持进行中，不出现「按钮已结束、页面还没变」的空档。
    await pendingSwap;
    window.clearTimeout(busy); item.classList.remove('busy'); item.removeAttribute('aria-busy'); item.disabled = false; }
}
function message(text: string, kind: '' | 'error' | 'warn' | 'ok' = '') {
  if (!notice) return;
  const changed = notice.textContent !== text;
  notice.textContent = text; notice.className = `notice${kind ? ` ${kind}` : ''}`;
  notice.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  if (text && changed && !reducedMotion()) notice.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: easeOut });
}
function pill(label: string, tone: Tone, live = false) { const item = el('span', `pill t-${tone}${live ? ' live' : ''}`); item.append(el('i', 'dot'), el('span', '', label)); return item; }
function avatar(content: string, tone: Tone = 'run') { const item = el('span', `av t-${tone}`); if (iconPaths[content]) item.append(icon(content)); else item.textContent = content; return item; }
function thumb(name: string, tone: Tone | 'plain' = 'plain') { const item = el('span', `thumb ${tone === 'plain' ? 'plain' : `t-${tone}`}`); item.append(icon(name)); return item; }
function kvList(entries: [string, string | HTMLElement, boolean?][]) {
  const list = el('dl', 'kv');
  for (const [label, value, mono] of entries) {
    const row = el('div'); const dd = el('dd', mono ? 'mono' : ''); if (typeof value === 'string') dd.textContent = value; else dd.append(value);
    row.append(el('dt', '', label), el('span', 'lead'), dd); list.append(row);
  }
  return list;
}
function arrowLink(target: Route, label: string) { const link = el('a', 'btn icon sm'); link.href = M.routeHash(target); link.setAttribute('aria-label', label); link.title = label; link.append(icon('arrow')); return link; }
function time(value: number | null) { return M.formatTime(value); }
function navigate(next: Route) { const hash = M.routeHash(next); if (location.hash === hash) render(); else location.hash = hash; }
function downloadBlob(blob: Blob, filename: string) { const url = URL.createObjectURL(blob); const link = el('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
async function copy(text: string, done: (ok: boolean) => void) { try { await navigator.clipboard.writeText(text); done(true); } catch { done(false); } }

class StaleRequest extends Error {}
class HttpError extends Error { status: number; code: string; constructor(status: number, code: string, text: string) { super(text); this.status = status; this.code = code; } }
async function api<T>(path: string, method = 'GET', input?: unknown): Promise<T> {
  const epoch = generation;
  let response: Response;
  try { response = await fetch(new URL(`../api/v1${path}`, import.meta.url), { method, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000), headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'x-reach-csrf': user?.csrf ?? '' }) }, body: method === 'GET' ? undefined : JSON.stringify(input ?? {}) }); }
  catch { if (epoch !== generation) throw new StaleRequest(); throw new Error(method === 'GET' ? '连接未完成。已显示的记录可能已过时，请刷新。' : '没有收到确认。请先刷新核对状态；已发生的操作不会自动重试。'); }
  let result: { error?: { code?: string; message?: string } } & Record<string, unknown>;
  try { result = await response.json(); } catch { if (epoch !== generation) throw new StaleRequest(); throw new HttpError(response.status, 'invalid_response', `服务返回了无法识别的内容（${response.status}）`); }
  if (epoch !== generation) throw new StaleRequest();
  if (!response.ok) {
    if (response.status === 401 && result.error?.code === 'ray_login_required') { rememberRoute(); clearSession(); location.assign('/ray/login?next=%2Freach%2F'); throw new StaleRequest(); }
    if (response.status === 401 && result.error?.code === 'reach_session_refresh') { showLogin('Ray 登录仍有效，请重新连接 Reach。若反复出现，请允许此站点保存 Cookie。原操作不会自动重试。'); throw new StaleRequest(); }
    if (response.status === 401 && user) { showLogin('登录已过期，请重新登录。未确认的操作不会自动重试。'); throw new StaleRequest(); }
    throw new HttpError(response.status, result.error?.code ?? 'http_error', result.error?.message ?? `请求失败（${response.status}）`);
  }
  return result as T;
}
function brand() { const item = el('a', 'brand'); item.href = '#/devices'; item.setAttribute('aria-label', 'Reach 首页'); const logo = el('img'); logo.src = 'assets/reach.svg'; logo.alt = ''; logo.width = 28; logo.height = 28; item.append(logo, el('span', '', 'Reach')); return item; }
function reducedMotion() { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
const easeOut = 'cubic-bezier(0.23, 1, 0.32, 1)';
// 弹层原路退场：与入场同方向、更快，结束后移除。
function dismiss(node: HTMLElement) {
  if (node.dataset.leaving) return; node.dataset.leaving = '1';
  if (reducedMotion()) { node.remove(); return; }
  node.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-4px) scale(0.98)' }], { duration: 140, easing: easeOut, fill: 'forwards' }).onfinish = () => node.remove();
}
function closePopovers() { document.querySelectorAll<HTMLElement>('.popover:not([data-leaving])').forEach(dismiss); }
function clearSession() {
  generation++; viewGeneration++; refreshSequence++; user = null; devices = []; operations = []; unresolvedCount = 0; updatedAt = 0; pairing = null;
  deviceEvents = []; eventCursor = null; unreadCount = 0; eventsAvailable = true; top = null; main = null; notice = null;
  clearInterval(refreshTimer); refreshTimer = 0; closePopovers();
  document.querySelectorAll('dialog').forEach(dialog => { dialog.close(); dialog.remove(); });
}

// ---------- 登录 ----------
function field(label: string, name: string, type: string, autocomplete: string) {
  const wrapper = el('label', 'field'); const input = el('input'); input.name = name; input.type = type; input.autocomplete = autocomplete as AutoFill; input.required = true;
  wrapper.append(el('span', '', label), input); return { wrapper, input };
}
// Ray 工作台登录只回到 /reach/，地址里的页面（如 #/desk/<对话>）会丢；跳转前记在本标签页，回来后恢复。
const RETURN_KEY = 'reach.return';
function rememberRoute() { try { if (location.hash && location.hash !== '#/devices') sessionStorage.setItem(RETURN_KEY, location.hash); } catch { /* 存不了就回首页 */ } }
function restoreRoute() {
  let saved: string | null = null; try { saved = sessionStorage.getItem(RETURN_KEY); sessionStorage.removeItem(RETURN_KEY); } catch { saved = null; }
  if (saved && /^#\/[a-z]+(\/[0-9a-f-]{36})?$/i.test(saved) && (!location.hash || location.hash === '#/devices')) history.replaceState(null, '', `${location.pathname}${location.search}${saved}`);
}
function showLogin(reason = '') {
  clearSession(); app.replaceChildren();
  const wrap = el('div', 'login-wrap'); const card = el('main', 'login frame-bg'); card.id = 'main'; wrap.append(card); app.append(wrap);
  notice = el('div', 'notice'); notice.setAttribute('role', 'status');
  if (rayLogin) {
    card.append(brand(), el('h1', '', '从 Ray 工作台继续'), notice, button('继续进入 Reach', () => { rememberRoute(); location.assign('/reach/'); }, 'btn primary'));
    message(reason || '重新连接 Ray 登录状态后，即可继续使用 Reach。', reason ? 'warn' : '');
    return;
  }
  const form = el('form', 'form');
  const input = el('input', 'pin-input'); input.type = 'password'; input.inputMode = 'numeric'; input.autocomplete = 'current-password'; input.maxLength = 12; input.pattern = '\\d{4,12}'; input.required = true; input.placeholder = '••••'; input.setAttribute('aria-label', 'PIN');
  const submit = el('button', 'btn primary', '进入'); submit.type = 'submit';
  form.append(input, submit);
  form.addEventListener('submit', event => { event.preventDefault(); void run(submit, async () => {
    message('');
    try {
      const result = await api<{ csrf: string; pinIsDefault: boolean; user: { id: string; username: string } }>('/auth/pin', 'POST', { pin: input.value });
      input.value = ''; user = { ...result.user, csrf: result.csrf, pinIsDefault: result.pinIsDefault }; generation++;
      await enterConsole();
    } catch (error) { input.value = ''; input.focus(); throw error; }
  }); });
  card.append(brand(), el('h1', '', '输入 PIN'), el('p', 'hint', '连续输错 3 次会锁定 1 小时。'), notice, form, el('footer', '', '忘记 PIN？请联系 Reach 管理员。'));
  if (reason) message(reason, 'warn');
  input.focus();
}

// ---------- 外壳：顶部字标胶囊 + 胶囊导航 + 圆形按钮 ----------
async function enterConsole() {
  if (rayLogin) restoreRoute();
  const query = new URLSearchParams(location.search);
  // 旧的 /desk/ 链接会带 ?next=desk&c=<对话>；统一前端后直接落到对话页并清掉查询串。
  if (query.get('next') === 'desk') {
    const conversation = query.get('c');
    history.replaceState(null, '', `${location.pathname}#/desk${conversation && M.uuidPattern.test(conversation) ? `/${conversation.toLowerCase()}` : ''}`);
  }
  showShell();
  try { await refresh(); } catch (error) { if (!(error instanceof StaleRequest)) message(error instanceof Error ? error.message : '读取失败，请刷新', 'error'); }
  void pollEvents().then(() => { if (route.page === 'devices' && !document.querySelector('dialog[open]') && !document.querySelector('.popover')) render(); });
  clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => { if (document.visibilityState === 'visible' && user) void backgroundRefresh(); }, REFRESH_MS);
}
async function backgroundRefresh() {
  const before = JSON.stringify([devices, operations, unresolvedCount, deviceEvents.length, unreadCount]);
  try { await refresh(false); } catch { return; }
  await pollEvents();
  // 只在列表页且数据有变时重绘，避免打断详情页里的输入。
  if ((route.page === 'devices' || route.page === 'operations') && before !== JSON.stringify([devices, operations, unresolvedCount, deviceEvents.length, unreadCount]) && !document.querySelector('dialog[open]') && !document.querySelector('.popover')) render();
}
function showShell() {
  app.replaceChildren(); closePopovers();
  const shell = el('div', 'app frame-bg'); top = el('header', 'top'); main = el('main', ''); main.id = 'main';
  shell.append(top, main); app.append(shell); render();
}
function drawTop() {
  if (!top || !user) return;
  top.replaceChildren(brand());
  const nav = el('nav', 'nav'); nav.setAttribute('aria-label', 'Reach 导航');
  const section = M.navSection(route);
  for (const entry of consoleSections) {
    const item = el('a', '', entry.label); item.href = entry.href;
    const badge = entry.id === 'operations' ? unresolvedCount : 0;
    if (badge) { const count = el('span', 'n', String(badge)); count.title = `${badge} 项操作结果待核对`; item.append(count); }
    if (entry.id === section) item.setAttribute('aria-current', 'page');
    nav.append(item);
  }
  const actions = el('div', 'top-actions');
  const account = el('button', 'avatar', user.username.slice(0, 1).toUpperCase()); account.type = 'button'; account.title = `${user.username} · 外观与退出`; account.setAttribute('aria-haspopup', 'dialog'); account.setAttribute('aria-label', `${user.username}，外观与退出`);
  account.addEventListener('click', event => { event.stopPropagation(); toggleAccountMenu(account); });
  const fresh = el('button', 'fresh'); fresh.type = 'button'; fresh.append(el('i', 'dot'), el('span'));
  fresh.addEventListener('click', () => { void run(fresh, async () => { await refresh(); await pollEvents(); updateFreshness(); }); });
  actions.append(fresh, bell(), account); queueMicrotask(updateFreshness);
  top.append(nav, actions); placeNavIndicator(nav);
}
let navIndicator: { x: number; w: number } | null = null;
// 选中项的深色底滑到新位置，说明「从哪来、到哪去」；只在切换时移动，尺寸变化时直接对齐。
function placeNavIndicator(nav: HTMLElement) {
  const current = nav.querySelector<HTMLElement>('a[aria-current="page"]');
  const indicator = el('i', 'nav-ind'); indicator.setAttribute('aria-hidden', 'true'); nav.prepend(indicator);
  if (!current) { indicator.hidden = true; navIndicator = null; return; }
  const to = { x: current.offsetLeft, w: current.offsetWidth };
  const set = (p: { x: number; w: number }) => { indicator.style.setProperty('transform', `translateX(${p.x}px)`); indicator.style.setProperty('width', `${p.w}px`); };
  if (navIndicator && (navIndicator.x !== to.x || navIndicator.w !== to.w) && !reducedMotion()) { set(navIndicator); indicator.getBoundingClientRect(); indicator.classList.add('moving'); set(to); }
  else set(to);
  navIndicator = to;
  if (nav.scrollWidth > nav.clientWidth) current.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}
window.addEventListener('resize', () => { const nav = document.querySelector<HTMLElement>('.nav'); const ind = nav?.querySelector<HTMLElement>('.nav-ind'); const current = nav?.querySelector<HTMLElement>('a[aria-current="page"]'); if (!ind || !current) return; ind.classList.remove('moving'); navIndicator = { x: current.offsetLeft, w: current.offsetWidth }; ind.style.setProperty('transform', `translateX(${navIndicator.x}px)`); ind.style.setProperty('width', `${navIndicator.w}px`); });
let lastRouteKey = '';
// 最近一次原地刷新换上新内容的时刻；没有进行中的刷新时为已完成的 Promise。
let pendingSwap: Promise<void> = Promise.resolve();
// 触发当前操作的按钮（键盘或鼠标聚焦时），用于刷新后恢复焦点。
let actionFocus: ReturnType<typeof focusSignature> = null;
let deskHandle: { dispose(): void } | null = null;
// 对话页：占满面板剩余高度；登录、顶栏、主题沿用控制台。
// 是否可对话以服务端实时状态为准：设置页启用模型后切回对话页即可使用，不必刷新整页。
function drawDesk() {
  const host = el('div', 'desk'); main!.append(host);
  const current = viewGeneration;
  const mount = (availability: 'running' | 'unconfigured' | 'unavailable', reason?: string | null) => { if (current !== viewGeneration) return; deskHandle = mountDesk(host, { user: user!, availability, reason: reason ?? undefined, onExpired: reason => showLogin(reason), openSettings: () => navigate({ page: 'settings' }) }); };
  void api<{ deskAvailable: boolean; deskRunning: boolean; deskUnavailable: string | null }>('/settings/models')
    .then(status => mount(status.deskRunning ? 'running' : status.deskAvailable ? 'unconfigured' : 'unavailable', status.deskUnavailable))
    .catch(error => { if (!(error instanceof StaleRequest)) mount(deskEnabled ? 'running' : 'unconfigured'); });
}
function render() {
  if (!main || !user) return;
  route = M.parseRoute(location.hash); viewGeneration++; closePopovers();
  deskHandle?.dispose(); deskHandle = null;
  (document.getElementById('main') ?? main).closest('.app')?.classList.toggle('desk-mode', route.page === 'desk');
  const key = M.routeHash(route), entering = key !== lastRouteKey; lastRouteKey = key;
  drawTop();
  // 已挂在页面上的内容区；上一轮原地刷新尚未换上时，main 可能是还没挂上的缓冲区。
  const live = document.getElementById('main') ?? main;
  if (entering || route.page === 'desk') {
    // 换页：清空后绘制并播放入场。
    main = live; main.replaceChildren(); main.classList.toggle('enter', entering);
    void drawPage();
    return;
  }
  // 同一页刷新（操作完成、后台数据变化、手动刷新）：在离屏缓冲区画完再整体换上，
  // 旧内容一直留在屏上，避免「清空 → 加载中 → 重建」的闪烁与滚动跳动。
  const buffer = el('main', ''); buffer.id = 'main';
  const view = viewGeneration; main = buffer;
  let swapped = false;
  const swap = () => {
    if (swapped || view !== viewGeneration || main !== buffer || !live.isConnected) return;
    swapped = true;
    const focusKey = focusSignature(document.activeElement, live) ?? actionFocus; actionFocus = null;
    const scroll = window.scrollY;
    live.replaceWith(buffer);
    window.scrollTo({ top: scroll });
    restoreFocus(buffer, focusKey);
  };
  // 读取卡住时不让页面一直停在旧内容上。
  pendingSwap = new Promise<void>(resolve => {
    const finish = () => { swap(); resolve(); };
    window.setTimeout(finish, 8000);
    void drawPage().then(finish, finish);
  });
}
// 当前路由页面的绘制；异步页面在数据就绪（或失败提示画好）后才返回。
async function drawPage() {
  switch (route.page) {
    case 'devices': drawDevices(); break;
    case 'device': drawDevice(route.id); break;
    case 'operations': drawOperations(); break;
    case 'operation': await drawOperation(route.id); break;
    case 'stats': drawStats(); break;
    case 'downloads': await drawDownloads(); break;
    case 'mcp': drawMcp(); break;
    case 'settings': await drawSettings(); break;
    case 'desk': drawDesk(); break;
  }
}
// 原地刷新换上新内容后，把焦点放回同一个控件（按钮文字、aria-label、输入名相同者），键盘操作不丢位置。
function focusSignature(active: Element | null, root: HTMLElement) {
  if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
  return { tag: active.tagName, label: active.getAttribute('aria-label') ?? '', text: (active.textContent ?? '').trim(), name: active.getAttribute('name') ?? '' };
}
function restoreFocus(root: HTMLElement, key: ReturnType<typeof focusSignature>) {
  if (!key) return;
  const match = [...root.querySelectorAll<HTMLElement>(key.tag)].find(node => (node.getAttribute('aria-label') ?? '') === key.label && (node.textContent ?? '').trim() === key.text && (node.getAttribute('name') ?? '') === key.name);
  match?.focus({ preventScroll: true });
}
function header(title: string, back: Route | null, ...actions: HTMLElement[]) {
  const head = el('div', 'page-head');
  if (back) head.append(iconButton('back', '返回', () => navigate(back), 'btn icon back'));
  head.append(el('h1', '', title), ...actions);
  notice = el('div', 'notice'); notice.setAttribute('role', 'status');
  const page = el('div', 'page'); page.append(notice);
  if (user?.pinIsDefault && !rayLogin) {
    const tip = el('div', 'notice warn pin-tip'); tip.append(el('span', '', '仍在使用默认 PIN 2026，知道默认值的人都能进入。'), button('修改 PIN', openChangePin, 'btn sm'));
    page.append(tip);
  }
  main!.append(head, page); return page;
}
async function refresh(redraw = true) {
  if (!user) return;
  const epoch = generation; const sequence = ++refreshSequence;
  try {
    const snapshot = await api<{ nodes: Device[]; operations: OperationSummary[]; unresolvedCount: number }>('/overview');
    if (epoch !== generation || sequence !== refreshSequence) return;
    devices = snapshot.nodes; operations = snapshot.operations; unresolvedCount = snapshot.unresolvedCount; updatedAt = Date.now();
    if (redraw) render(); else drawTop();
  } catch (error) { if (epoch === generation && sequence === refreshSequence) throw error; }
}
function segbar(parts: [string, number, 'ink' | 'accent' | 'hatch-part' | 'line'][]) {
  const total = parts.reduce((sum, [, n]) => sum + n, 0); const bar = el('div', 'segbar');
  for (const [label, count, kind] of parts) {
    if (!count) continue;
    const part = el('div', `seg-part ${kind}`); part.style.flexGrow = String(count); part.style.flexBasis = '0';
    part.append(el('small', '', label), el('span', '', `${Math.round(count * 100 / total)}% · ${count}`)); bar.append(part);
  }
  return bar;
}
function bignums(entries: [string, number, string][]) {
  const box = el('div', 'bignums');
  for (const [label, value, name] of entries) { const item = el('div', 'bignum'); const caption = el('small'); caption.append(icon(name), label); item.append(el('b', '', String(value)), caption); box.append(item); }
  return box;
}

// ---------- 设备总览 ----------
function deviceSummary(device: Device) {
  const state = M.deviceState(device); const beat = M.heartbeatView(device);
  return [M.deviceStateLabel[state], device.version, beat.effectiveSeconds && state !== 'waiting' ? `心跳 ${beat.effectiveSeconds} 秒` : ''].filter(Boolean).join(' · ');
}
function drawDevices() {
  const search = finder('搜索名称、Node ID 或版本', deviceQuery, value => { deviceQuery = value; drawDeviceTiles(); });
  const page = header(`你好，${user!.username}`, null, iconButton('refresh', '刷新', () => refresh()), button('连接设备', () => openPairing(null), 'btn primary', 'plus'));
  if (!updatedAt) { page.append(el('p', 'muted', '正在读取设备…')); return; }
  const count = (state: M.DeviceState) => devices.filter(d => M.deviceState(d) === state).length;
  const active = devices.filter(d => !d.revoked).length;
  const hero = el('div', 'hero');
  if (devices.length) hero.append(segbar([['在线', count('online'), 'ink'], ['等 Node 上线', count('waiting'), 'accent'], ['离线', count('offline'), 'hatch-part'], ['已解绑', count('revoked'), 'line']]));
  else hero.append(el('div', 'grow'));
  hero.append(bignums([['已配对', active, 'devices'], ['在线', count('online'), 'pulse'], ['待核对', unresolvedCount, 'alert']]));
  page.append(hero);
  if (!devices.length) { page.append(firstDeviceEmpty()); }
  else {
    const toolbar = el('div', 'toolbar');
    toolbar.append(chips<M.DeviceFilter>([['all', '全部', devices.length], ['online', '在线', count('online')], ['offline', '离线', count('offline')], ['waiting', '等上线', count('waiting')], ['revoked', '已解绑', count('revoked')]], deviceFilter, value => { deviceFilter = value; render(); }), el('span', 'grow'), search.box);
    const tiles = el('div', 'tiles'); tiles.setAttribute('aria-label', '设备');
    page.append(toolbar, tiles); drawDeviceTiles();
    if (deviceQuery) requestAnimationFrame(() => { search.input.focus(); search.input.setSelectionRange(deviceQuery.length, deviceQuery.length); });
  }
  const trendRow = el('div', 'grid');
  const trend = el('section', 'card s8'); trend.append(cardHead('近 7 天操作', '', arrowLink({ page: 'stats' }, '查看统计')));
  const trendBody = el('div'); trendBody.append(el('p', 'hint', '正在汇总…')); trend.append(trendBody);
  trendRow.append(trend, onlineGauge(count('online'), count('offline'), count('waiting'))); page.append(trendRow);
  const trendView = viewGeneration;
  void fetchStats(7).then(stats => { if (trendView === viewGeneration) trendBody.replaceChildren(trendChart(stats, '近 7 天每日操作量')); }).catch(error => { if (trendView === viewGeneration) { trendBody.replaceChildren(); statsFailure(trendBody, error); } });
  const grid = el('div', 'grid');
  const recent = el('section', 'card flush s8'); recent.append(cardHead('最近操作', '', arrowLink({ page: 'operations' }, '查看全部操作')));
  if (!operations.length) { const empty = el('div', 'empty'); empty.append(el('p', '', '从设备详情或本机 MCP 发起操作后，状态和原始回执会出现在这里。')); recent.append(empty); }
  else recent.append(operationRows(operations.slice(0, 6)));
  const side = el('div', 'stack s4'); side.append(notificationCard());
  grid.append(recent, side); page.append(grid);
}
function drawDeviceTiles() {
  const tiles = main?.querySelector<HTMLElement>('.tiles'); if (!tiles) return;
  tiles.replaceChildren();
  const shown = M.filterDevices(devices, deviceFilter, deviceQuery);
  if (!shown.length) { const empty = el('div', 'card empty'); empty.append(el('h2', '', '没有符合条件的设备'), el('p', '', '换个筛选条件或搜索词试试。')); tiles.append(empty); return; }
  for (const device of shown) {
    const state = M.deviceState(device); const tile = el('a', 'tile'); tile.href = M.routeHash({ page: 'device', id: device.id }); tile.title = `${device.name} · ${device.id}`;
    const copyBox = el('span'); copyBox.append(el('b', '', device.name), el('small', '', deviceSummary(device)));
    copyBox.append(el('small', '', `最近联系 ${time(device.last_seen)}`));
    tile.append(thumb('devices', M.deviceStateTone[state] === 'ok' ? 'ok' : M.deviceStateTone[state] === 'warn' ? 'warn' : 'muted'), copyBox);
    tiles.append(tile);
  }
}
function onlineGauge(online: number, offline: number, waiting: number) {
  const card = el('section', 'card s4'); card.append(cardHead('在线率'));
  const total = online + offline + waiting; const ratio = total ? online / total : 0;
  const box = el('div', 'gauge');
  const ns = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 240 140'); svg.setAttribute('aria-hidden', 'true');
  const defs = document.createElementNS(ns, 'defs'); const pattern = document.createElementNS(ns, 'pattern');
  pattern.setAttribute('id', 'hatch'); pattern.setAttribute('width', '7'); pattern.setAttribute('height', '7'); pattern.setAttribute('patternUnits', 'userSpaceOnUse'); pattern.setAttribute('patternTransform', 'rotate(45)');
  const line = document.createElementNS(ns, 'line'); line.setAttribute('x1', '0'); line.setAttribute('y1', '0'); line.setAttribute('x2', '0'); line.setAttribute('y2', '7'); line.setAttribute('stroke', 'currentColor'); line.setAttribute('stroke-width', '1.4');
  pattern.append(line); defs.append(pattern); svg.append(defs); svg.style.color = 'var(--text-3)';
  const arc = (from: number, to: number, cls: string) => {
    if (to - from < 0.001) return;
    const point = (t: number) => { const a = Math.PI * (1 - t); return `${120 + 100 * Math.cos(a)} ${125 - 100 * Math.sin(a)}`; };
    const path = document.createElementNS(ns, 'path'); path.setAttribute('d', `M ${point(from)} A 100 100 0 0 1 ${point(to)}`); path.setAttribute('class', cls); svg.append(path);
  };
  // 在线为强调色，离线为墨色，等上线为斜纹；各段之间留小缝。
  const gap = 0.035; const offRatio = total ? offline / total : 0;
  if (!total) arc(0, 1, 'rest');
  else { arc(0, Math.max(0, ratio - (ratio < 1 ? gap / 2 : 0)), 'fill'); arc(ratio + (ratio > 0 ? gap / 2 : 0), Math.max(ratio, ratio + offRatio - gap / 2), 'track'); arc(ratio + offRatio + gap / 2, 1, 'rest'); }
  const value = el('div', 'gauge-v'); value.append(el('b', '', total ? `${Math.round(ratio * 100)}%` : '—'), el('small', '', total ? `${online} / ${total} 台在线` : '还没有设备'));
  box.append(svg, value);
  const legend = el('div', 'legend');
  for (const [label, cls] of [['在线', 'ok'], ['离线', 'muted'], ['等上线', 'warn']] as const) { const item = el('span'); const dot = el('i', `dot ${cls}`); if (cls === 'ok') dot.style.background = 'var(--accent)'; if (cls === 'muted') dot.style.background = 'var(--ink)'; item.append(dot, label); legend.append(item); }
  card.append(box, legend); return card;
}
function notificationCard() {
  const card = el('section', 'card ink');
  const head = cardHead('上线通知'); const big = el('span', 'big', String(unreadCount)); big.title = `${unreadCount} 条未读`; head.append(big, el('small', '', '未读'));
  card.append(head);
  const list = el('div', 'ink-list');
  if (!eventsAvailable) list.append(el('p', 'ink-empty', '此服务版本尚未提供设备事件接口。'));
  else if (!deviceEvents.length) list.append(el('p', 'ink-empty', '设备首次上线或断线恢复时会出现在这里。'));
  for (const event of [...deviceEvents].reverse().slice(0, 6)) list.append(notificationItem(event, () => undefined));
  card.append(list); return card;
}
function notificationItem(event: DeviceEvent, before: () => void) {
  const item = el('button', 'ink-item'); item.type = 'button';
  const circle = el('span', 'circle'); circle.append(icon(event.kind === 'reconnected' ? 'refresh' : 'pulse'));
  const copyBox = el('span'); copyBox.append(el('b', '', M.eventTitle(event)), el('small', '', M.eventDetail(event)));
  const mark = el('i', `mark${event.read ? '' : ' on'}`); mark.title = event.read ? '已读' : '未读';
  item.append(circle, copyBox, mark);
  item.addEventListener('click', () => {
    before(); navigate({ page: 'device', id: event.nodeId });
    if (!event.read) void api<{ unreadCount: number }>('/device-events/read', 'POST', { sequences: [event.sequence] }).then(result => {
      deviceEvents = deviceEvents.map(e => e.sequence === event.sequence ? { ...e, read: true } : e); unreadCount = result.unreadCount; updateBell();
    }).catch(() => undefined);
  });
  return item;
}
function firstDeviceEmpty() {
  const grid = el('div', 'grid');
  const card = el('section', 'card s8'); card.append(cardHead('让第一台设备连过来'));
  card.append(el('p', 'dl-lead', '在要接入的电脑上准备 Reach，再用一次性配对码连接。首次上报能力后，这里会显示设备在线。'));
  const steps = el('ol', 'steps');
  for (const step of ['打开「下载」，按目标电脑的系统选择包。', '在这里生成配对码，按下载页的步骤在那台电脑上完成配对和启动。']) steps.append(el('li', '', step));
  const actions = el('div', 'page-actions'); actions.append(button('生成配对码', () => openPairing(null), 'btn primary', 'plus'), arrowLinkText({ page: 'downloads' }, '去下载安装包'));
  card.append(steps, actions);
  const accent = el('section', 'card accent s4'); accent.append(cardHead('还没有设备'));
  const big = el('b', '', '0'); big.style.fontSize = '72px'; big.style.fontWeight = '300'; big.style.lineHeight = '1';
  accent.append(big, el('p', '', '配对后，设备的状态、心跳和最近操作都会汇总到这里。'));
  grid.append(card, accent); return grid;
}
function arrowLinkText(target: Route, label: string) { const link = el('a', 'btn'); link.href = M.routeHash(target); link.append(el('span', '', label), icon('arrow')); return link; }

// ---------- 设备详情 ----------
function drawDevice(id: string) {
  const device = devices.find(d => d.id === id);
  if (!device) {
    const page = header('设备', { page: 'devices' });
    if (!updatedAt) { page.append(el('p', 'muted', '正在读取设备…')); return; }
    const card = el('section', 'card'); const empty = el('div', 'empty'); empty.append(el('h2', '', '没有找到这台设备'), el('p', '', '它可能属于其他账户，或者链接里的 Node ID 不完整。'), button('返回设备总览', () => navigate({ page: 'devices' }), 'btn'));
    card.append(empty); page.append(card); return;
  }
  const state = M.deviceState(device); const kinds = M.availableKinds(device.capabilities);
  const launch = button('发起操作', () => openSubmit(device.id), 'btn primary', 'play'); launch.title = '发起操作（快捷键 N）';
  if (state === 'revoked' || !kinds.length) { launch.disabled = true; launch.title = state === 'revoked' ? '设备已解绑' : state === 'waiting' ? '等 Node 上线并上报能力后才能发起' : '这台设备尚未声明可从网页发起的能力'; }
  const actions: HTMLElement[] = [iconButton('refresh', '刷新', () => refresh())];
  if (!device.revoked) actions.push(button('重新配对', () => openPairing(device), 'btn'), button('解绑', () => openUnpair(device), 'btn danger'));
  actions.push(launch);
  const page = header(device.name, { page: 'devices' }, ...actions);
  if (state === 'waiting') message('已配对，等这台设备上的 Node 首次上报能力。上线后会收到通知。', 'warn');
  if (state === 'revoked') message('这台设备已解绑，不再接收新操作。原操作记录保留。', 'warn');
  const grid = el('div', 'grid');
  // 左：设备资料卡
  const profile = el('section', 'card s3');
  const head = el('div', 'profile'); head.append(thumb('devices', M.deviceStateTone[state] === 'ok' ? 'ok' : M.deviceStateTone[state] === 'warn' ? 'warn' : 'muted'), el('b', '', device.name), el('small', '', `${device.platform} · ${device.version}`));
  const stateBox = el('div', 'inline'); stateBox.style.marginTop = '8px'; stateBox.append(pill(M.deviceStateLabel[state], M.deviceStateTone[state])); head.append(stateBox);
  profile.append(head, el('h3', 'sub-h', '基本信息'), kvList([
    ['Node ID', device.id.slice(0, 8) + '…', true], ['配对主体', user!.username], ['配对次数', `第 ${device.epoch} 次`],
    ['常驻状态', device.residentState ? M.residentLabel[device.residentState] ?? device.residentState : '尚无上报'], ['最近联系', time(device.last_seen)], ['最近心跳', time(device.lastHeartbeatAt ?? null)],
  ]));
  const idLine = el('p', 'hint mono'); idLine.style.marginTop = '10px'; idLine.append(device.id, copyButton(device.id, '复制 Node ID')); profile.append(idLine);
  profile.append(el('h3', 'sub-h', `能力 · ${device.capabilities.length}`));
  if (!device.capabilities.length) profile.append(el('p', 'hint', 'Node 尚未上报能力。'));
  else { const list = el('div', 'caps'); device.capabilities.forEach(cap => list.append(el('span', 'cap', cap))); profile.append(list); }
  // 中：心跳与 SSH
  const middle = el('div', 'stack s5');
  const heartbeat = el('section', 'card'); drawHeartbeat(heartbeat, device, null);
  const ssh = el('section', 'card'); ssh.append(cardHead('SSH', '随心跳上报'));
  if (!device.sshStatus) ssh.append(el('p', 'hint', '尚未收到 SSH 状态上报。'));
  else {
    const entries: [string, string | HTMLElement, boolean?][] = [['最近一次检查', pill(device.sshStatus.ready ? '就绪' : '未就绪', device.sshStatus.ready ? 'ok' : 'warn')]];
    if (device.sshStatus.port) entries.push(['端口', String(device.sshStatus.port)]);
    if (device.sshStatus.user) entries.push(['用户', device.sshStatus.user]);
    if (device.sshStatus.hostKey) entries.push(['主机密钥', device.sshStatus.hostKey, true]);
    if (device.sshStatus.error) entries.push(['错误', device.sshStatus.error]);
    ssh.append(kvList(entries));
  }
  middle.append(heartbeat, ssh);
  // 右：最近操作（墨色卡）
  const own = operations.filter(op => op.node_id === device.id);
  const recent = el('section', 'card ink s4'); const recentHead = cardHead('最近操作'); recentHead.append(el('span', 'big', String(own.length)));
  recent.append(recentHead);
  const list = el('div', 'ink-list');
  if (!own.length) list.append(el('p', 'ink-empty', '这台设备还没有操作记录。'));
  for (const op of own.slice(0, 8)) {
    const item = el('a', 'ink-item'); item.href = M.routeHash({ page: 'operation', id: op.id });
    const circle = el('span', 'circle'); circle.append(icon(M.kindIcon(op.kind)));
    const copyBox = el('span'); copyBox.append(el('b', '', M.kindLabel(op.kind)), el('small', '', `${M.stateNames[op.execution] ?? op.execution} · ${time(op.created_at)}`));
    const mark = el('i', 'dot'); mark.style.background = M.stateTone(op.execution) === 'ok' ? 'var(--accent)' : M.stateTone(op.execution) === 'warn' || M.stateTone(op.execution) === 'bad' ? 'var(--rose)' : 'var(--ink-2)';
    item.append(circle, copyBox, mark); list.append(item);
  }
  recent.append(list);
  grid.append(profile, middle, recent); page.append(grid);
  const monitor = el('div', 'grid'); const availCard = el('section', 'card s5'); const trendCard = el('section', 'card s7');
  availCard.append(cardHead('近 14 天可用性', '按记录到的断线区间')); trendCard.append(cardHead('近 14 天操作'));
  monitor.append(availCard, trendCard); page.append(monitor);
  const view = viewGeneration;
  void fetchStats(14, device.id).then(stats => {
    if (view !== viewGeneration) return;
    const item = stats.availability[0];
    if (!item || item.since === null) availCard.append(el('p', 'hint', state === 'waiting' ? '等 Node 首次上线后开始记录。' : '还没有上线记录。'));
    else {
      const big = el('b', '', M.percent(item.ratio)); big.style.cssText = ''; big.className = 'bigline';
      const strip = availabilityStrip({ from: stats.from, to: stats.to, since: item.since, offline: item.offline, describe: (a, b) => `离线 ${time(a)} – ${time(b)}（${M.formatDuration(b - a)}）` }); strip.style.marginTop = '14px';
      const axis = el('div', 'inline'); axis.style.justifyContent = 'space-between'; axis.style.marginTop = '6px'; axis.append(el('span', 'hint', time(stats.from)), el('span', 'hint', '现在'));
      availCard.append(big, el('p', 'hint', `自 ${time(item.since)} 起 · 离线 ${item.offline.length} 次`), strip, axis);
    }
    trendCard.append(trendChart(stats, '这台设备近 14 天每日操作量'));
  }).catch(error => { if (view === viewGeneration) statsFailure(availCard, error); });
  void api<Runtime>(`/nodes/${device.id}/runtime`).then(runtime => { if (view === viewGeneration) drawHeartbeat(heartbeat, runtime, runtime.configHistory); })
    .catch(error => { if (view === viewGeneration && !(error instanceof StaleRequest)) heartbeat.append(el('p', 'notice error', error instanceof HttpError && error.status === 404 && error.code === 'not_found' ? '此服务版本尚未提供运行态接口。' : error instanceof Error ? error.message : '运行态读取失败')); });
}
function cardHead(title: string, note = '', ...actions: HTMLElement[]) { const head = el('div', 'card-h'); head.append(el('h2', '', title)); if (note) head.append(el('small', '', note)); head.append(...actions); return head; }
const pendingConfig = new Map<string, { seconds: number; requestId: string }>();
function heartbeatRing(seconds: number | null, last: number | null) {
  const ring = el('div', 'ring'); const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 180 180'); svg.setAttribute('aria-hidden', 'true');
  const tick = document.createElementNS(ns, 'circle'); tick.setAttribute('cx', '90'); tick.setAttribute('cy', '90'); tick.setAttribute('r', '72'); tick.setAttribute('class', 'tick');
  svg.append(tick);
  // 弧长 = 距上次心跳已过去的时间 / 有效间隔（封顶一圈）；没有心跳记录时不画弧。
  if (seconds && last) {
    const fraction = Math.min(1, Math.max(0.02, (Date.now() - last) / (seconds * 1000)));
    const arc = document.createElementNS(ns, 'circle'); arc.setAttribute('cx', '90'); arc.setAttribute('cy', '90'); arc.setAttribute('r', '82'); arc.setAttribute('class', 'arc');
    const length = 2 * Math.PI * 82; arc.setAttribute('stroke-dasharray', `${fraction * length} ${length}`); svg.append(arc);
  }
  const label = el('span'); label.append(el('b', '', seconds ? `${seconds}s` : '—'), el('small', '', last ? `上次心跳 ${time(last)}` : '尚无心跳'));
  ring.append(svg, label); return ring;
}
function drawHeartbeat(card: HTMLElement, device: Device, history: ConfigHistory[] | null) {
  card.replaceChildren(cardHead('心跳'));
  const view = M.heartbeatView(device);
  card.append(heartbeatRing(view.effectiveSeconds, view.lastHeartbeatAt));
  const lines: [string, string | HTMLElement, boolean?][] = [['已生效', view.effectiveSeconds ? `${view.effectiveSeconds} 秒 · v${view.effectiveVersion}` : '—']];
  if (!view.requested) lines.push(['已请求', '尚未从远程调整']);
  else {
    const requested = el('span', 'inline'); requested.style.justifyContent = 'flex-end';
    requested.append(`${view.requested.seconds} 秒 · v${view.requested.version}`, pill(view.requested.label, view.requested.status === 'applied' ? 'ok' : view.requested.status === 'pending' ? 'run' : 'warn', view.requested.status === 'pending'));
    lines.push(['已请求', requested], ['请求 ID', view.requested.requestId.slice(0, 8) + '…', true]);
    if (view.requested.error) lines.push(['设备回执', view.requested.error]);
  }
  card.append(kvList(lines));
  if (!device.revoked) {
    const form = el('form', 'inline'); form.style.marginTop = '16px';
    const input = el('input'); input.type = 'number'; input.min = '30'; input.max = '3600'; input.step = '1'; input.required = true; input.value = String(view.requested?.seconds ?? view.effectiveSeconds ?? 60); input.setAttribute('aria-label', '心跳间隔（秒）');
    const submit = el('button', 'btn primary', '下发新间隔'); submit.type = 'submit';
    const status = el('span', 'hint', '30–3600 秒，设备回执后生效'); status.setAttribute('role', 'status');
    form.append(input, el('span', 'hint', '秒'), submit, status);
    form.addEventListener('submit', event => { event.preventDefault(); void run(submit, async () => {
      const seconds = M.parseHeartbeatSeconds(input.value);
      // 同一数值的重试沿用原请求 ID，服务端据此幂等。
      const prior = pendingConfig.get(device.id); const requestId = prior && prior.seconds === seconds ? prior.requestId : crypto.randomUUID();
      pendingConfig.set(device.id, { seconds, requestId });
      const view = viewGeneration;
      try {
        const runtime = await api<Runtime>(`/nodes/${device.id}/config`, 'POST', { requestId, heartbeatIntervalSeconds: seconds });
        pendingConfig.delete(device.id);
        if (view === viewGeneration) { drawHeartbeat(card, runtime, runtime.configHistory); message(`已请求把心跳改为 ${seconds} 秒，等设备回执后生效。`, 'ok'); }
      } catch (error) { if (!(error instanceof HttpError)) status.textContent = '没有收到确认，再次提交会沿用同一请求 ID。'; else pendingConfig.delete(device.id); throw error; }
    }); });
    card.append(form);
  }
  if (history && history.length) {
    card.append(el('h3', 'sub-h', '调整记录'));
    const list = el('ul', 'history');
    for (const item of history.slice(0, 5)) { const li = el('li'); li.append(el('b', '', `v${item.targetVersion} · ${item.heartbeatIntervalSeconds} 秒`), pill(M.configStatusLabel[item.status], item.status === 'applied' ? 'ok' : item.status === 'pending' ? 'run' : 'warn'), el('span', 'grow'), el('span', 'muted', time(item.createdAt))); list.append(li); }
    card.append(list);
  }
}

// ---------- 操作 ----------
function deviceName(id: string) { return devices.find(d => d.id === id)?.name ?? id.slice(0, 8); }
function operationRows(list: OperationSummary[], withDevice = true) {
  const rows = el('div', `rows ${withDevice ? 'ops' : 'ops-own'}`); const head = el('div', 'rows-h');
  (withDevice ? ['操作', '设备', '执行状态', '投递', '发起时间'] : ['操作', '执行状态', '投递', '发起时间']).forEach((label, i) => head.append(el('span', (withDevice ? i === 1 || i === 3 : i === 2) ? 'hide-sm' : i === (withDevice ? 4 : 3) ? 'end' : '', label)));
  rows.append(head);
  for (const op of list) {
    const row = el('a', 'row'); row.href = M.routeHash({ page: 'operation', id: op.id });
    const name = el('span', 'cell2'); const copyBox = el('span'); copyBox.append(el('b', '', M.kindLabel(op.kind)), el('small', 'mono', op.id));
    name.append(avatar(M.kindIcon(op.kind), M.stateTone(op.execution)), copyBox);
    const state = el('span', 'cell'); state.append(pill(M.stateNames[op.execution] ?? op.execution, M.stateTone(op.execution), op.execution === 'running'));
    if (op.cancel_requested && !M.terminalStates.has(op.execution)) state.append(el('small', '', '已请求取消'));
    row.append(name);
    if (withDevice) row.append(el('span', 'cell hide-sm', deviceName(op.node_id)));
    row.append(state, el('span', 'cell hide-sm muted', M.stateNames[op.delivery] ?? op.delivery), el('span', 'cell muted end', time(op.created_at)));
    rows.append(row);
  }
  return rows;
}
function drawOperations() {
  const search = finder('搜索操作、设备或原操作 ID', operationQuery, value => { operationQuery = value; drawOperationRows(); });
  const launch = button('发起操作', () => openSubmit(null), 'btn primary', 'play');
  if (!devices.some(d => !d.revoked && M.availableKinds(d.capabilities).length)) { launch.disabled = true; launch.title = '还没有可从网页发起操作的设备'; }
  const page = header('操作', null, iconButton('refresh', '刷新', () => refresh()), launch);
  if (!updatedAt) { page.append(el('p', 'muted', '正在读取操作…')); return; }
  const count = (filter: M.OperationFilter) => M.filterOperations(operations, filter, '', deviceName).length;
  const failed = operations.filter(op => op.execution === 'failed' || op.execution === 'cancelled').length;
  const succeeded = operations.filter(op => op.execution === 'succeeded').length;
  const hero = el('div', 'hero');
  if (operations.length) hero.append(segbar([['已成功', succeeded, 'ink'], ['进行中', count('active') - operations.filter(op => M.isActive(op) && M.needsAttention(op)).length, 'accent'], ['失败或取消', failed, 'hatch-part'], ['待核对', count('attention'), 'line']]));
  else hero.append(el('div', 'grow'));
  hero.append(bignums([['最近记录', operations.length, 'ops'], ['进行中', count('active'), 'play'], ['待核对', count('attention'), 'alert']]));
  page.append(hero);
  if (unresolvedCount) message(`${unresolvedCount} 项操作的实际结果尚未确定，请打开原记录核对；Reach 不会重新执行它们。`, 'warn');
  const card = el('section', 'card flush'); card.setAttribute('aria-label', '操作列表');
  const head = cardHead('操作记录');
  head.append(chips<M.OperationFilter>([['all', '全部', operations.length], ['active', '进行中', count('active')], ['attention', '待核对', count('attention')], ['done', '已结束', count('done')]], operationFilter, value => { operationFilter = value; render(); }), search.box);
  const body = el('div', 'op-body');
  card.append(head, body); page.append(card);
  drawOperationRows();
  if (operations.length >= 200) page.append(el('p', 'hint', '这里显示最近 200 条；更早的记录可在搜索里输入完整的原操作 ID 打开。'));
  if (operationQuery) requestAnimationFrame(() => { search.input.focus(); search.input.setSelectionRange(operationQuery.length, operationQuery.length); });
}
function drawOperationRows() {
  const body = main?.querySelector<HTMLElement>('.op-body'); if (!body) return;
  body.replaceChildren();
  const query = operationQuery.trim();
  if (M.uuidPattern.test(query) && !operations.some(op => op.id === query.toLowerCase())) {
    const empty = el('div', 'empty'); empty.append(el('h2', '', '不在最近 200 条里'), el('p', '', '可以直接按原操作 ID 打开它的记录。'), button('打开这条记录', () => navigate({ page: 'operation', id: query.toLowerCase() }), 'btn primary'));
    body.append(empty); return;
  }
  const shown = M.filterOperations(operations, operationFilter, operationQuery, deviceName);
  if (!operations.length) { const empty = el('div', 'empty'); empty.append(el('h2', '', '还没有操作记录'), el('p', '', '从设备详情或本机 MCP 发起操作后，可以在这里查看状态、原始回执和产物。')); body.append(empty); return; }
  if (!shown.length) { const empty = el('div', 'empty'); empty.append(el('h2', '', '没有符合条件的操作'), el('p', '', '换个筛选条件或搜索词试试。')); body.append(empty); return; }
  body.append(operationRows(shown));
}
// ---------- 搜索：从图标原地伸出 ----------
function finder(placeholder: string, value: string, onInput: (value: string) => void) {
  const box = el('div', `find${value ? ' open' : ''}`); const slot = el('span', 'find-slot'); const input = el('input'); input.type = 'search'; input.placeholder = placeholder; input.value = value; input.setAttribute('aria-label', placeholder);
  slot.append(input);
  const toggle = iconButton('search', '搜索', () => {
    if (!box.classList.contains('open')) { box.classList.add('open'); input.focus(); return; }
    if (input.value) { input.value = ''; onInput(''); }
    box.classList.remove('open');
  }, 'btn icon');
  input.addEventListener('input', () => onInput(input.value));
  input.addEventListener('keydown', event => { if (event.key === 'Escape') { input.value = ''; onInput(''); box.classList.remove('open'); toggle.focus(); } });
  input.addEventListener('blur', () => { if (!input.value) box.classList.remove('open'); });
  box.append(toggle, slot); return { box, input };
}
function chips<T extends string>(options: [T, string, number][], current: T, onPick: (value: T) => void) {
  const group = el('div', 'chips'); group.setAttribute('role', 'group');
  for (const [value, label, count] of options) {
    const chip = el('button', 'chip', label); chip.type = 'button'; chip.setAttribute('aria-pressed', String(value === current));
    chip.append(el('span', 'n', String(count)));
    chip.addEventListener('click', () => onPick(value)); group.append(chip);
  }
  return group;
}

function parsed(value: string | null): Json { if (value === null) return null; try { return JSON.parse(value) as Json; } catch { return value; } }
function evidence(title: string, value: Json, filename: string, preview?: string) {
  const box = el('div', 'evidence'); const head = el('div', 'evidence-h');
  head.append(el('h3', '', title), button('下载原始内容', () => downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }), filename), 'btn sm ghost', 'download'));
  const text = preview ?? JSON.stringify(value, null, 2);
  box.append(head, el('pre', 'codebox', text.length > 16000 ? `${text.slice(0, 16000)}\n…预览已截断，下载可查看完整内容。` : text)); return box;
}
function outputPreview(data: Json): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.base64 !== 'string' || !['stdout', 'stderr'].includes(String(data.stream))) return;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(data.base64), value => value.charCodeAt(0))); }
  catch { return '此片段无法单独显示为 UTF-8 文本，请下载原始回执核对。'; }
}
async function drawOperation(id: string) {
  const view = viewGeneration; const epoch = generation;
  let op: Operation, reconciliations: { reconciliations: Json[] };
  try { [op, reconciliations] = await Promise.all([api<Operation>(`/operations/${id}`), api<{ reconciliations: Json[] }>(`/operations/${id}/reconciliations`)]); }
  catch (error) {
    if (error instanceof StaleRequest || view !== viewGeneration) return;
    const page = header('操作', { page: 'operations' }); const card = el('section', 'card'); const empty = el('div', 'empty');
    empty.append(el('h2', '', error instanceof HttpError && error.status === 404 ? '没有找到这次操作' : '记录读取失败'), el('p', '', error instanceof Error ? error.message : '请稍后重试'), button('重试', () => render(), 'btn'));
    card.append(empty); page.append(card); return;
  }
  if (epoch !== generation || view !== viewGeneration || !user) return;
  const command = parsed(op.command_json);
  const kind = command && typeof command === 'object' && !Array.isArray(command) ? String(command.kind) : '未知操作';
  const actions: HTMLElement[] = [iconButton('refresh', '刷新记录', () => render())];
  if (!M.terminalStates.has(op.execution) && !op.cancel_requested && op.delivery !== 'cancelled') actions.push(button('请求取消', async () => {
    await api(`/operations/${id}/cancel`, 'POST');
    render(); message('已提交取消请求。请根据回执核对实际停止状态；已有的效果不会撤销。', 'ok');
  }, 'btn danger'));
  const template = M.commandToFields(command); const target = devices.find(d => d.id === op.node_id);
  if (template && target && !target.revoked && M.availableKinds(target.capabilities).includes(template.kind)) {
    const again = button('以此为模板新建', () => openSubmit(op.node_id, template), 'btn', 'plus'); again.title = '预填同样的内容，提交时生成新的请求 ID，不会重放原操作'; actions.unshift(again);
  }
  const page = header(M.kindLabel(kind), { page: 'operations' }, ...actions);
  if (M.needsAttention(op)) message('原操作的实际结果尚未确定。请结合现场和原始证据核对；Reach 不会重新执行这个操作。', 'warn');
  const track = el('ol', 'track');
  for (const step of M.operationTrack(op)) { const li = el('li', `t-${step.tone}`); li.append(el('small', '', step.label), el('span', '', step.value)); track.append(li); }
  page.append(track);
  const grid = el('div', 'grid');
  const info = el('section', 'card s4'); info.append(cardHead('记录'));
  const deviceLink = el('a', 'link', deviceName(op.node_id)); deviceLink.href = M.routeHash({ page: 'device', id: op.node_id });
  info.append(kvList([['设备', deviceLink], ['内容', M.commandSummary(command)], ['原操作 ID', op.id.slice(0, 8) + '…', true], ['请求 ID', op.request_id.slice(0, 8) + '…', true], ['取消', op.cancel_requested ? '已请求（不代表已停止）' : '未请求'], ['发起时间', time(op.created_at)], ['最近更新', time(op.updated_at)]]));
  const ids = el('p', 'hint mono'); ids.style.marginTop = '12px'; ids.append(op.id, copyButton(op.id, '复制原操作 ID')); info.append(ids);
  const artifactsCard = el('section', 'card s8'); grid.append(info, artifactsCard); page.append(grid);
  const current = () => epoch === generation && view === viewGeneration && !!user;
  void showArtifacts(artifactsCard, id, current);
  const raw = el('section', 'card'); raw.append(cardHead('原始记录', '下载即原样内容'), evidence('原始请求', command, `${id}-request.json`));
  if (op.result_json !== null) raw.append(evidence('结果记录', parsed(op.result_json), `${id}-result.json`));
  if (reconciliations.reconciliations.length) raw.append(evidence('独立对账记录', reconciliations.reconciliations, `${id}-reconciliations.json`));
  page.append(raw);
  const eventsCard = el('section', 'card'); const events = el('div'); const pageStatus = el('span', 'hint'); let after = 0;
  const more = button('读取回执', async () => {
    const result = await api<Page>(`/operations/${id}/events?after=${after}&limit=20`);
    if (!current()) return;
    events.replaceChildren();
    for (const event of result.events) {
      const item = el('article', 'event'); const head = el('div', 'event-h'); head.append(el('strong', '', `#${event.sequence} · ${M.stateNames[event.kind] ?? event.kind}`), el('small', '', time(event.received_at)));
      const preview = outputPreview(event.data);
      item.append(head, el('small', 'mono muted', event.event_id), evidence(preview === undefined ? '回执内容' : '输出片段', event.data, `${id}-event-${event.sequence}.json`, preview)); events.append(item);
    }
    if (!result.events.length) events.append(el('p', 'muted', '尚无新回执。可稍后再查。'));
    const start = result.events[0]?.sequence; after = result.nextAfter;
    pageStatus.textContent = start === undefined ? '0 条回执' : `当前 #${start}–${after}${result.hasMore ? ' · 后面还有' : ' · 已读到当前末尾'}`;
    (more.querySelector('span') ?? more).textContent = result.hasMore ? '下一页回执' : '查询新回执';
  }, 'btn sm');
  const controls = el('div', 'page-actions'); controls.append(more, pageStatus);
  eventsCard.append(cardHead('原始回执', '按服务接收顺序'), events, controls); page.append(eventsCard); more.click();
  // 进行中的操作每 5 秒重读一次原记录；只读，不会重新执行。
  if (!M.terminalStates.has(op.execution) && op.delivery !== 'cancelled') setTimeout(() => { if (view === viewGeneration && current() && !document.querySelector('dialog[open]') && !document.querySelector('.popover')) render(); }, 5000);
}
async function showArtifacts(card: HTMLElement, id: string, current: () => boolean) {
  card.append(cardHead('产物', '从这次操作取回，不会重新执行'));
  const state = el('p', 'muted', '正在读取产物清单…'); state.setAttribute('role', 'status'); card.append(state);
  try {
    const list = parseArtifacts(await api(`/operations/${id}/artifacts`), id);
    if (!current()) return;
    state.remove();
    if (!list.artifacts.length) { card.append(el('p', 'muted', '这次操作没有独立产物。文字输出可在下方原始回执中查看。')); return; }
    for (const artifact of list.artifacts) {
      const item = el('article', 'event'); const title = el('div', 'event-h');
      const name = artifact.mimeType === 'text/plain' ? '文本' : artifact.mimeType === 'image/png' ? '图片' : '文件';
      title.append(el('strong', '', `${name} ${artifact.contentIndex + 1}`), pill(artifact.complete ? '传输完成' : '未完整收到', artifact.complete ? 'ok' : 'warn'));
      const metadata = `${artifact.mimeType} · ${M.formatBytes(artifact.byteLength)}${artifact.characterCount === undefined ? '' : ` · ${artifact.characterCount.toLocaleString()} 字符`}`;
      const status = el('p', 'hint'); status.setAttribute('role', 'status');
      const actions = el('div', 'page-actions'); const preview = el('pre', 'codebox'); preview.hidden = true;
      item.append(title, el('p', 'hint', metadata));
      if (!artifact.complete) item.append(el('p', 'hint', '可稍后刷新核对；操作结束后缺失内容可能无法补齐。原操作不会重跑。'));
      else {
        const request = (path: string) => api(path);
        const action = (label: string, task: () => Promise<void>, iconName?: string) => button(label, async () => {
          if (!current()) return;
          try { await task(); } catch (error) { if (current()) { status.textContent = error instanceof Error ? error.message : '读取未完成，请重新打开记录'; status.setAttribute('role', 'alert'); } }
        }, 'btn sm', iconName);
        if (artifact.mimeType === 'text/plain') {
          let reader: ArtifactReader | null = null;
          const next = action('预览文本', async () => {
            status.setAttribute('role', 'status'); status.textContent = '正在读取原始文本…';
            reader ??= new ArtifactReader(request, list.binding, artifact, current);
            try {
              const pageText = await reader.next(); if (!current()) return;
              preview.hidden = false; preview.textContent = pageText.text || (artifact.byteLength === 0 ? '（空文本）' : '（此段字符将在下一段接续显示）');
              status.textContent = `${pageText.offset.toLocaleString()}–${pageText.nextOffset.toLocaleString()} / ${artifact.byteLength.toLocaleString()} 字节 · ${pageText.eof ? '全文校验通过' : '分段校验通过'}`;
              (next.querySelector('span') ?? next).textContent = pageText.eof ? '重新预览' : '下一段文本'; if (pageText.eof) reader = null;
            } catch (error) { reader = null; (next.querySelector('span') ?? next).textContent = '重新预览'; throw error; }
          }); actions.append(next);
        }
        actions.append(action('下载', async () => {
          status.setAttribute('role', 'status'); status.textContent = '正在取回并核验完整文件…';
          const bytes = await new ArtifactReader(request, list.binding, artifact, current).download();
          if (!current()) return;
          downloadBlob(new Blob([new Uint8Array(bytes)], { type: artifact.mimeType }), `${id}-${artifact.artifactId}.${artifact.mimeType === 'text/plain' ? 'txt' : artifact.mimeType === 'image/png' ? 'png' : 'bin'}`);
          status.textContent = '完整性校验通过，已交给浏览器下载。';
        }, 'download'));
        item.append(actions, preview, status);
      }
      card.append(item);
    }
  } catch (error) { if (current()) { state.textContent = error instanceof Error ? error.message : '产物清单读取失败，请刷新记录'; state.setAttribute('role', 'alert'); } }
}

// ---------- 对话框 ----------
function modal(title: string) {
  const dialog = el('dialog'); const heading = el('h2', '', title); heading.id = `dialog-${crypto.randomUUID()}`; dialog.setAttribute('aria-labelledby', heading.id); dialog.append(heading); document.body.append(dialog);
  dialog.addEventListener('close', () => { setTimeout(() => dialog.remove(), reducedMotion() ? 0 : 200); }); return dialog;
}
function openPairing(device: Device | null) {
  if (document.querySelector('dialog[open]')) return;
  const dialog = modal(device ? `重新配对「${device.name}」` : '连接一台设备');
  dialog.append(el('p', '', device ? '在这台设备的终端运行下面的命令。安装身份会保留；原操作须先结算，否则服务会拒绝更换配对。' : '在目标设备的终端运行下面的命令。配对后，这个账户即可完全控制该设备。'));
  const status = el('p', 'hint'); status.setAttribute('role', 'status');
  const body = el('div', 'vstack'); dialog.append(body, status);
  const server = M.serverBase(location.href);
  const development = M.isDevelopmentServer(server);
  const renderCode = () => {
    body.replaceChildren();
    if (!pairing) { status.textContent = '配对码 10 分钟内有效，只能使用一次。'; return; }
    const command = M.pairCommand(server, pairing.code, development);
    status.textContent = Date.now() >= pairing.expiresAt ? '配对码已过期，请生成新码。' : `有效期至 ${time(pairing.expiresAt)}，只能使用一次。`;
    body.append(el('div', 'pair-code', pairing.code), el('pre', 'codebox', command));
    body.append(button('复制命令', () => copy(command, ok => { status.textContent = ok ? '命令已复制，到目标设备的终端运行。' : '未能访问剪贴板，请选中上面的命令复制。'; }), 'btn sm', 'copy'));
    (generate.querySelector('span') ?? generate).textContent = '生成新码';
  };
  const generate = button('生成配对码', async () => {
    const epoch = generation;
    try { const result = await api<{ code: string; expiresAt: number }>('/pairing-codes', 'POST'); if (epoch === generation && dialog.open) { pairing = result; renderCode(); } }
    catch (error) { if (dialog.open && !(error instanceof StaleRequest)) status.textContent = error instanceof Error ? error.message : '生成失败'; }
  }, 'btn primary');
  const actions = el('div', 'actions'); actions.append(button('关闭', () => dialog.close(), 'btn ghost'), generate); dialog.append(actions); renderCode(); dialog.showModal();
  const timer = window.setInterval(() => { if (pairing && Date.now() >= pairing.expiresAt) status.textContent = '配对码已过期，请生成新码。'; }, 1000);
  dialog.addEventListener('close', () => { clearInterval(timer); pairing = null; void refresh().catch(() => undefined); });
}
function openChangePin() {
  if (document.querySelector('dialog[open]')) return;
  const dialog = modal(rayLogin ? '修改 Controller PIN' : '修改 PIN');
  const note = rayLogin
    ? (user?.pinIsDefault ? '首次设置时，当前 PIN 填 2026。新 PIN 为 4–12 位数字，用于本机 Reach Controller 登录。' : '新 PIN 为 4–12 位数字，用于本机 Reach Controller 登录。')
    : '网页和本机控制器都用这个 PIN 登录。新 PIN 为 4–12 位数字，不能是默认的 2026。';
  dialog.append(el('p', '', note));
  const form = el('form', 'form');
  const fields = ['当前 PIN', '新 PIN', '再输一次新 PIN'].map((label, i) => {
    const wrap = el('label', 'field'); const input = el('input'); input.type = 'password'; input.inputMode = 'numeric'; input.maxLength = 12; input.required = true; input.autocomplete = i ? 'new-password' : 'current-password';
    wrap.append(el('span', '', label), input); form.append(wrap); return input;
  });
  const status = el('p', 'notice'); status.setAttribute('role', 'alert'); form.append(status);
  const submit = el('button', 'btn primary', '保存'); submit.type = 'submit';
  const actions = el('div', 'actions'); actions.append(button('取消', () => dialog.close(), 'btn ghost'), submit); form.append(actions);
  form.addEventListener('submit', event => { event.preventDefault(); void run(submit, async () => {
    const [current, next, again] = fields.map(f => f.value);
    if (!/^\d{4,12}$/.test(next)) { status.className = 'notice error'; status.textContent = '新 PIN 需为 4–12 位数字'; return; }
    if (next !== again) { status.className = 'notice error'; status.textContent = '两次输入的新 PIN 不一致'; return; }
    try { await api('/auth/pin/change', 'POST', { current, next }); }
    catch (error) { if (!(error instanceof StaleRequest)) { status.className = 'notice error'; status.textContent = error instanceof Error ? error.message : '修改未完成'; } return; }
    if (user) user.pinIsDefault = false;
    dialog.close(); render(); message(rayLogin ? 'Controller PIN 已修改。下次从本机 Controller 登录时请使用新 PIN。' : 'PIN 已修改。下次登录请使用新 PIN。', 'ok');
  }); });
  dialog.append(form); dialog.showModal(); fields[0].focus();
}
function openUnpair(device: Device) {
  if (document.querySelector('dialog[open]')) return;
  const dialog = modal('解绑设备');
  dialog.append(el('p', '', `解绑「${device.name}」后，停止向这台设备投递新操作。正在执行的操作会收到取消请求；实际结果仍需核对，已发生的效果不会撤销。`));
  const status = el('p', 'hint'); status.setAttribute('role', 'alert'); dialog.append(status);
  const actions = el('div', 'actions'); actions.append(button('保留连接', () => dialog.close(), 'btn ghost'), button('解绑设备', async () => {
    const epoch = generation;
    try {
      await api(`/nodes/${encodeURIComponent(device.id)}/unpair`, 'POST'); dialog.close();
      try { await refresh(); if (epoch === generation) message('设备已解绑，原操作记录保留。', 'ok'); }
      catch (error) { if (epoch === generation && !(error instanceof StaleRequest)) message('设备已解绑，但刷新失败。列表可能已过时，请重新刷新。', 'error'); }
    } catch (error) { if (dialog.open && !(error instanceof StaleRequest)) status.textContent = error instanceof Error ? error.message : '解绑未确认'; }
  }, 'btn danger solid')); dialog.append(actions); dialog.showModal();
}
const kindFields: Record<WebKind, { name: string; label: string; type: 'text' | 'number' | 'textarea'; placeholder?: string; optional?: boolean }[]> = {
  'command.run': [{ name: 'command', label: '命令', type: 'textarea', placeholder: '例如 Get-ChildItem C:\\ProgramData' }, { name: 'cwd', label: '工作目录', type: 'text', placeholder: '留空使用 Node 默认目录', optional: true }, { name: 'timeout', label: '超时（秒）', type: 'number', placeholder: '60', optional: true }],
  'directory.list': [{ name: 'path', label: '目录路径', type: 'text', placeholder: 'C:\\ProgramData' }],
  'file.read': [{ name: 'path', label: '文件路径', type: 'text', placeholder: 'C:\\ProgramData\\app\\log.txt' }, { name: 'length', label: '读取长度（字节）', type: 'number', placeholder: '65536', optional: true }],
  'file.write': [{ name: 'path', label: '文件路径', type: 'text', placeholder: 'C:\\temp\\note.txt' }, { name: 'content', label: '写入内容（UTF-8，覆盖原文件）', type: 'textarea', optional: true }],
  'desktop.describe': [{ name: 'timeout', label: '超时（秒）', type: 'number', placeholder: '60', optional: true }],
  'ssh.status': [],
};
function openSubmit(nodeId: string | null, template?: { kind: WebKind; fields: Record<string, string> }) {
  if (document.querySelector('dialog[open]')) return;
  const candidates = devices.filter(d => !d.revoked && M.availableKinds(d.capabilities).length);
  if (!candidates.length) { message('还没有可从网页发起操作的设备。', 'warn'); return; }
  const dialog = modal('发起操作');
  dialog.append(el('p', '', '操作会投递到所选设备，用该设备已有的能力执行。提交后可在原记录里查看回执与产物。'));
  const form = el('form', 'form');
  const deviceSelect = new Dropdown('目标设备');
  deviceSelect.setOptions(candidates.map(device => ({ value: device.id, label: device.name, hint: device.online ? undefined : '离线，上线后投递' })), nodeId && candidates.some(d => d.id === nodeId) ? nodeId : candidates[0].id);
  const kindSelect = new Dropdown('操作类型');
  const fieldsBox = el('div', 'form'); const idLine = el('p', 'hint');
  const status = el('p', 'notice'); status.setAttribute('role', 'status');
  const deviceLabel = el('div', 'field'); deviceLabel.append(el('span', '', '目标设备'), deviceSelect.element);
  const kindLabelEl = el('div', 'field'); kindLabelEl.append(el('span', '', '操作'), kindSelect.element);
  const row = el('div', 'form-row'); row.append(deviceLabel, kindLabelEl);
  form.append(row, fieldsBox, idLine, status);
  let requestId = crypto.randomUUID(); let unconfirmed = false;
  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  const resetId = () => { if (unconfirmed) return; requestId = crypto.randomUUID(); idLine.textContent = `请求 ID ${requestId}`; };
  const drawKinds = () => {
    const device = candidates.find(d => d.id === deviceSelect.value)!;
    kindSelect.setOptions(M.availableKinds(device.capabilities).map(kind => ({ value: kind, label: M.kindLabel(kind) })));
    drawFields();
  };
  const drawFields = () => {
    fieldsBox.replaceChildren(); inputs.clear();
    for (const spec of kindFields[kindSelect.value as WebKind] ?? []) {
      const label = el('label', 'field'); const input = spec.type === 'textarea' ? el('textarea') : el('input');
      if (input instanceof HTMLInputElement) input.type = spec.type;
      input.name = spec.name; if (spec.placeholder) input.placeholder = spec.placeholder; if (!spec.optional) input.required = true;
      input.addEventListener('input', resetId);
      label.append(el('span', '', spec.label), input); fieldsBox.append(label); inputs.set(spec.name, input);
    }
    if (kindSelect.value === 'ssh.status') fieldsBox.append(el('p', 'hint', '读取这台设备上受管 OpenSSH 的当前状态，不改变配置。'));
    resetId();
  };
  deviceSelect.onChange = () => drawKinds();
  kindSelect.onChange = () => drawFields();
  const submit = el('button', 'btn primary', '提交'); submit.type = 'submit';
  const actions = el('div', 'actions'); actions.append(button('取消', () => dialog.close(), 'btn ghost'), submit);
  form.append(actions); dialog.append(form);
  form.addEventListener('submit', event => { event.preventDefault(); void run(submit, async () => {
    const device = candidates.find(d => d.id === deviceSelect.value)!;
    const fields = Object.fromEntries([...inputs].map(([name, input]) => [name, input.value]));
    let command: Record<string, Json>;
    try { command = M.buildCommand(kindSelect.value as WebKind, fields, device.capabilities); }
    catch (error) { status.className = 'notice error'; status.textContent = error instanceof Error ? error.message : '填写内容无效'; return; }
    status.className = 'notice'; status.textContent = '正在提交…';
    try {
      const op = await api<{ id: string }>('/operations', 'POST', { requestId, nodeId: device.id, command });
      dialog.close(); await refresh(false).catch(() => undefined); navigate({ page: 'operation', id: op.id });
    } catch (error) {
      if (error instanceof StaleRequest) return;
      if (error instanceof HttpError) { status.className = 'notice error'; status.textContent = error.message; return; }
      // 结果未知：锁定表单内容，只允许以同一请求 ID 重试，避免重复执行。
      unconfirmed = true; deviceSelect.disabled = true; kindSelect.disabled = true; inputs.forEach(input => { input.readOnly = true; });
      status.className = 'notice warn'; status.textContent = '没有收到确认。再次提交会沿用同一请求 ID，服务端不会重复执行；也可以先去操作记录里核对。';
      (submit as HTMLButtonElement).textContent = '以同一请求重试';
    }
  }); });
  drawKinds();
  if (template && kindSelect.has(template.kind)) {
    kindSelect.value = template.kind; drawFields();
    for (const [name, value] of Object.entries(template.fields)) { const input = inputs.get(name); if (input) input.value = value; }
    status.textContent = '已按原操作预填。提交后是一次新操作，使用新的请求 ID。';
  }
  dialog.showModal();
}

// ---------- 上线通知 ----------
async function pollEvents() {
  if (!user || !eventsAvailable) return;
  const epoch = generation;
  try {
    for (let i = 0; i < 5; i++) {
      const page = await api<EventPage>(eventCursor === null ? '/device-events?limit=50' : `/device-events?after=${eventCursor}&limit=50`);
      if (epoch !== generation) return;
      deviceEvents = M.mergeEvents(deviceEvents, page.events); eventCursor = page.nextAfter; unreadCount = page.unreadCount;
      if (!page.hasMore) break;
    }
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) eventsAvailable = false;
    else if (!(error instanceof StaleRequest)) return;
  }
  updateBell();
}
function updateBell() {
  document.querySelectorAll<HTMLButtonElement>('[data-bell]').forEach(node => {
    node.querySelector('.count')?.remove();
    if (unreadCount) node.append(el('span', 'count', unreadCount > 99 ? '99+' : String(unreadCount)));
    node.setAttribute('aria-label', unreadCount ? `通知，${unreadCount} 条未读` : '通知');
  });
}
function bell() {
  const item = el('button', 'btn icon'); item.type = 'button'; item.dataset.bell = ''; item.title = '上线通知'; item.append(icon('bell'));
  item.addEventListener('click', event => { event.stopPropagation(); toggleNotifications(item); });
  queueMicrotask(updateBell); return item;
}
function placePopover(popover: HTMLElement, anchor: HTMLElement, align: 'right' | 'left-up') {
  const rect = anchor.getBoundingClientRect();
  if (align === 'right') { popover.style.top = `${rect.bottom + 8}px`; popover.style.right = `${Math.max(12, window.innerWidth - rect.right)}px`; }
  else { popover.style.left = `${rect.left}px`; popover.style.bottom = `${window.innerHeight - rect.top + 8}px`; }
}
function openPopover(anchor: HTMLElement, id: string, align: 'right' | 'left-up') {
  const existing = document.querySelector(`.popover[data-id="${id}"]:not([data-leaving])`); closePopovers();
  if (existing) return null;
  const popover = el('div', `popover${align === 'left-up' ? ' up' : ''}`); popover.dataset.id = id; popover.setAttribute('role', 'dialog');
  popover.addEventListener('click', event => event.stopPropagation());
  document.body.append(popover); placePopover(popover, anchor, align);
  anchor.setAttribute('aria-expanded', 'true');
  const close = () => { dismiss(popover); anchor.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', close); document.removeEventListener('keydown', escape); window.removeEventListener('resize', close); };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { close(); anchor.focus(); } };
  setTimeout(() => { document.addEventListener('click', close); document.addEventListener('keydown', escape); window.addEventListener('resize', close); });
  return { popover, close };
}
function toggleNotifications(anchor: HTMLElement) {
  const opened = openPopover(anchor, 'notifications', 'right'); if (!opened) return;
  const { popover, close } = opened; popover.setAttribute('aria-label', '上线通知');
  const draw = () => {
    popover.replaceChildren();
    const head = el('div', 'popover-h'); head.append(el('h2', '', '上线通知'));
    if (unreadCount) head.append(button('全部已读', async () => {
      const result = await api<{ unreadCount: number }>('/device-events/read', 'POST', { upTo: eventCursor ?? 0 });
      deviceEvents = deviceEvents.map(e => ({ ...e, read: true })); unreadCount = result.unreadCount; updateBell(); draw();
    }, 'btn sm'));
    head.append(el('span', 'big', String(unreadCount)), el('small', '', '未读'));
    popover.append(head);
    const list = el('div', 'ink-list');
    if (!eventsAvailable) list.append(el('p', 'ink-empty', '此服务版本尚未提供设备事件接口。'));
    else if (!deviceEvents.length) list.append(el('p', 'ink-empty', '设备首次上线或断线恢复时会出现在这里。'));
    for (const event of [...deviceEvents].reverse()) list.append(notificationItem(event, close));
    popover.append(list);
  };
  draw();
}

// ---------- 账户菜单：主题、强调色、退出 ----------
function toggleAccountMenu(anchor: HTMLElement) {
  const opened = openPopover(anchor, 'account', 'right'); if (!opened) return;
  const { popover } = opened; popover.classList.add('light'); popover.setAttribute('aria-label', '账户与外观'); popover.style.width = '300px';
  const who = el('div', 'popover-h'); who.append(el('h2', '', user!.username), el('small', 'hint', rayLogin ? 'Ray 工作区' : 'Reach 账户'));
  const themeSec = el('div', 'menu-sec'); themeSec.append(el('h3', '', '主题'));
  const seg = el('div', 'seg'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', '主题');
  const drawSeg = () => {
    seg.replaceChildren(); const themeNow = currentTheme();
    for (const [value, label] of [['system', '跟随系统'], ['light', '亮色'], ['dark', '深色']] as [ThemeChoice, string][]) {
      const item = el('button', '', label); item.type = 'button'; item.setAttribute('role', 'radio'); item.setAttribute('aria-checked', String(themeNow === value));
      item.addEventListener('click', () => { setTheme(value); drawSeg(); }); seg.append(item);
    }
  };
  drawSeg(); themeSec.append(seg);
  const colorSec = el('div', 'menu-sec'); colorSec.append(el('h3', '', '强调色'));
  const swatches = el('div', 'swatches'); swatches.setAttribute('role', 'radiogroup'); swatches.setAttribute('aria-label', '强调色');
  const drawSwatches = () => {
    swatches.replaceChildren(); const accent = currentAccent(); const custom = !accentPresets.some(p => p.value === accent);
    for (const preset of accentPresets) {
      const item = el('button', 'swatch'); item.type = 'button'; item.setAttribute('role', 'radio'); item.setAttribute('aria-checked', String(accent === preset.value)); item.setAttribute('aria-label', preset.label); item.title = preset.label;
      item.style.setProperty('--c', preset.value); if (accent === preset.value) item.append(icon('check'));
      item.addEventListener('click', () => { setAccent(preset.value === defaultAccent ? null : preset.value); drawSwatches(); }); swatches.append(item);
    }
    const customBox = el('span', 'swatch custom'); customBox.setAttribute('role', 'radio'); customBox.setAttribute('aria-checked', String(custom)); customBox.title = '自定义颜色';
    if (custom) customBox.style.setProperty('--c', accent);
    customBox.append(icon(custom ? 'check' : 'plus'));
    const picker = el('input'); picker.type = 'color'; picker.value = accent; picker.setAttribute('aria-label', '自定义强调色');
    picker.addEventListener('input', () => { setAccent(picker.value); customBox.style.setProperty('--c', picker.value); });
    picker.addEventListener('change', drawSwatches);
    customBox.append(picker); swatches.append(customBox);
  };
  drawSwatches(); colorSec.append(swatches, el('p', 'hint', '记在本机浏览器，不影响其他人。'));
  const exitSec = el('div', 'menu-sec');
  if (!rayLogin) { const change = el('button', 'menu-item'); change.type = 'button'; change.append(icon('key'), el('span', '', '修改 PIN')); change.addEventListener('click', () => { closePopovers(); openChangePin(); }); exitSec.append(change); }
  const logout = el('button', 'menu-item'); logout.type = 'button'; logout.append(icon('logout'), el('span', '', rayLogin ? '退出工作区' : '退出登录'));
  logout.addEventListener('click', () => { void run(logout, async () => {
    if (rayLogin) { const form = el('form'); form.method = 'POST'; form.action = '/ray/logout'; document.body.append(form); form.submit(); return; }
    await api('/auth/logout', 'POST'); showLogin();
  }); });
  exitSec.append(logout);
  popover.append(who, themeSec, colorSec, exitSec);
}

// ---------- 多平台下载 ----------
const osIcon: Record<ReleaseOs, string> = { windows: 'win', macos: 'mac', linux: 'linux' };
const sourceName: Record<ReleaseAsset['sources'][number]['kind'], string> = { github: 'GitHub', gitee: 'Gitee', reach: 'Reach 镜像' };
const osEnvironmentLead: Record<ReleaseOs, string> = {
  windows: '支持 Windows x64 / ARM64 服务安装程序与离线 OpenSSH',
  macos: '支持 Apple Silicon / Intel 便携 Worker（终端运行）',
  linux: '支持 Linux x64 / ARM64 便携 Worker（终端 / 守护运行）',
};
const packageInfo: Record<ReleaseAsset['kind'], { title: string; who: string; lead: string; contents: string[] }> = {
  node: { title: 'Reach Node', who: '装在被控 Windows 上', lead: '让这台 Windows 常驻接受 Reach 控制：命令、文件、心跳与受管 SSH。', contents: ['Reach Node Windows 服务，开机自启并按退避重连', 'ryreach 配置命令（加入 PATH）', '离线 OpenSSH 载荷与准备脚本，默认启用受管 SSH'] },
  agent: { title: 'Reach Worker + Agent', who: '装在被控 Windows 上', lead: '安装常驻 Worker 与现场 Agent，支持远程任务和按需启用 SSH。', contents: ['Reach Worker Windows 服务与 ryreach 配置命令', 'Morrow Agent 侧车', '离线 OpenSSH 载荷；SSH 按需启用'] },
  complete: { title: 'Reach 完整包', who: '需要桌面与现场 Agent 时', lead: '在 Node 之外，带上桌面能力与现场 Agent 侧车，可远程查看与操作桌面。', contents: ['Reach Node 与 ryreach 配置命令', '桌面能力 helper 与现场 Agent 侧车', '固定版本的便携 Python 运行时', '离线 OpenSSH 载荷'] },
};
const portableInfo = { title: 'Reach Worker', who: '便携预览版', lead: '支持心跳、命令和文件操作。Worker 在终端前台运行。', contents: ['ryreach 命令行程序和使用说明'] };

type StepPart = string | Node;
interface StepCmd { label?: string; text: string }
interface RichStep { lead: StepPart[]; cmds?: StepCmd[] }

function inlineCode(text: string) {
  return el('code', '', text);
}
function inlineRouteLink(target: M.Route, label: string) {
  const link = el('a', 'dl-link', label);
  link.href = M.routeHash(target);
  return link;
}
function commandBox(text: string, label?: string, onCopied?: (ok: boolean, copiedText: string) => void) {
  const wrap = el('div', 'dl-cmd');
  const body = el('div', 'dl-cmd-body');
  if (label) body.append(el('small', 'dl-cmd-label', label));
  body.append(el('code', 'mono dl-cmd-code', text));
  const actionLabel = label || '命令';
  let timer = 0;
  const copyBtn = iconButton('copy', `复制${actionLabel}`, () => {
    copy(text, ok => {
      copyBtn.classList.toggle('copied', ok);
      copyBtn.title = ok ? '已复制' : '未能访问剪贴板';
      copyBtn.setAttribute('aria-label', ok ? `已复制：${actionLabel}` : '未能访问剪贴板，请手动选择复制');
      if (onCopied) onCopied(ok, text);
      else message(ok ? `已复制：${text}` : '未能访问剪贴板，请手动选择复制。', ok ? 'ok' : 'warn');
      if (ok) {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.title = `复制${actionLabel}`;
          copyBtn.setAttribute('aria-label', `复制${actionLabel}`);
        }, 1500);
      }
    });
  }, 'btn icon sm dl-cmd-copy');
  wrap.append(body, copyBtn);
  return wrap;
}
function serverAddressBox(server: string, dev: boolean, onCopied?: (ok: boolean, text: string) => void) {
  const label = dev ? '安装 / 配对填写服务地址（本地 HTTP 测试命令需带 --development）' : '安装 / 配对填写服务地址';
  return commandBox(server, label, onCopied);
}
function renderRichSteps(items: RichStep[], onCopied?: (ok: boolean, text: string) => void) {
  const list = el('ol', 'steps');
  for (const item of items) {
    const li = el('li');
    const lead = el('span', '', '');
    lead.append(...item.lead);
    li.append(lead);
    for (const cmd of item.cmds ?? []) li.append(commandBox(cmd.text, cmd.label, onCopied));
    list.append(li);
  }
  return list;
}
function buildPackageSteps(opts: { os: ReleaseOs; kind: ReleaseAsset['kind']; portable: boolean; assetName: string; verifyCmd: string; server: string; dev: boolean }): RichStep[] {
  const { os, kind, portable, assetName, verifyCmd, server, dev } = opts;
  const bin = portable ? './ryreach' : 'ryreach';
  const configCmd = M.configServerCommand(server, dev, bin);
  const pairCmd = M.pairCommand(server, '<配对码>', dev, bin);
  const devHint = dev ? '（当前为本地 HTTP 测试地址，命令需保留 --development）' : '';
  const addrLabel = dev ? '服务地址（本地 HTTP 测试）' : '服务地址';

  if (portable) {
    const extractCmd = M.archiveExtractCommand(assetName);
    const prepareCmds: StepCmd[] = [{ label: `核对 SHA-256（${os === 'macos' ? 'macOS 终端' : 'Linux Shell'}）`, text: verifyCmd }];
    if (extractCmd) prepareCmds.push({ label: '解压归档并进入含 ryreach 的目录（无权限可执行 chmod +x ./ryreach）', text: extractCmd });
    return [
      { lead: ['下载 ', inlineCode(assetName), ' 后先核对 SHA-256，解压并打开终端进入解压目录：'], cmds: prepareCmds },
      { lead: ['在解压目录执行配置命令写入当前服务地址', devHint, '：'], cmds: [{ label: addrLabel, text: server }, { label: '写入服务地址', text: configCmd }] },
      { lead: ['前往「', inlineRouteLink({ page: 'devices' }, '设备'), '」点击「连接设备」生成配对码，将 ', inlineCode('<配对码>'), ' 替换后运行：'], cmds: [{ label: '配对设备', text: pairCmd }] },
      { lead: ['执行第一条命令启动 Worker 并保持终端开启（按 ', inlineCode('Ctrl+C'), ' 等当前操作完成后退出）；另开终端可执行第二条检查状态：'], cmds: [{ label: '启动前台 Worker', text: './ryreach run' }, { label: '另开终端检查连接状态', text: './ryreach status' }] },
    ];
  }

  const lastCmds: StepCmd[] = [{ label: '检查连接与服务状态', text: 'ryreach status' }];
  if (kind !== 'node') lastCmds.push({ label: '按需启用内置 OpenSSH（管理员终端）', text: 'ryreach ssh enable' });

  return [
    { lead: ['双击运行 ', inlineCode(assetName), ' 完成安装（会自动注册 Reach Windows 服务并把 ', inlineCode('ryreach'), ' 加入 PATH）；安装前可先核对 SHA-256：'], cmds: [{ label: '核对安装包 SHA-256（PowerShell）', text: verifyCmd }] },
    {
      lead: kind === 'node'
        ? ['若安装器未预设或需切换到本控制台，在配置窗口填入下面地址', devHint, '，或直接打开终端执行：']
        : ['安装结束弹出「配置服务地址」窗口时填入下方地址', devHint, '；若已跳过弹窗或需改地址，打开终端执行：'],
      cmds: [{ label: addrLabel, text: server }, { label: '命令行设置服务地址（若弹窗已填可跳过）', text: configCmd }],
    },
    { lead: ['前往「', inlineRouteLink({ page: 'devices' }, '设备'), '」点击「连接设备」生成配对码，将 ', inlineCode('<配对码>'), ' 替换为实际配对码后在此设备终端执行：'], cmds: [{ label: '配对设备', text: pairCmd }] },
    {
      lead: kind === 'node'
        ? ['安装器已自动启动后台服务并启用受管 SSH；首次上报能力后会在「', inlineRouteLink({ page: 'devices' }, '设备'), '」显示在线，执行下条可确认状态：']
        : ['首次上报能力后设备将在「', inlineRouteLink({ page: 'devices' }, '设备'), '」上线；执行状态检查确认运行，如需启用内置离线 OpenSSH 请以管理员身份运行第二条：'],
      cmds: lastCmds,
    },
  ];
}

function platformLabel(asset: ReleaseAsset) {
  const os = M.assetOs(asset);
  if (os === 'macos') return { arm64: 'macOS Apple Silicon', x64: 'macOS Intel', universal: 'macOS 通用版' }[asset.arch];
  return `${os === 'linux' ? 'Linux' : 'Windows'} ${asset.arch === 'arm64' ? 'ARM64' : asset.arch}`;
}
function describeAsset(asset: ReleaseAsset) {
  const os = M.assetOs(asset);
  const portable = (os === 'macos' || os === 'linux') && asset.kind === 'node';
  const info = portable ? portableInfo : packageInfo[asset.kind];
  return { os, portable, info, platform: platformLabel(asset) };
}

interface ResolvedAsset { release: Release; asset: ReleaseAsset }

async function drawDownloads() {
  const page = header('下载', null, iconButton('refresh', '刷新', () => render()));
  const view = viewGeneration;
  const server = M.serverBase(location.href);
  const dev = M.isDevelopmentServer(server);
  const detected = M.detectClientPlatform(navigator.userAgent, navigator.platform);
  if (!downloadOs) downloadOs = detected.os;

  const loading = el('p', 'muted', '正在读取多平台发行清单…'); page.append(loading);
  let data: { configured: boolean; releases: Release[] };
  try { data = await api('/releases'); }
  catch (error) {
    if (error instanceof StaleRequest || view !== viewGeneration) return;
    loading.remove();
    message(error instanceof HttpError && error.status === 404 && error.code === 'not_found' ? '此服务版本尚未提供发行清单接口。' : error instanceof Error ? error.message : '发行清单读取失败', 'error');
    page.append(installGuide(null, downloadOs, detected, [], server, dev)); return;
  }
  if (view !== viewGeneration) return;
  loading.remove();

  // 按「平台 + 架构」收集最新可用包，其余旧包归入历史版本（兼容部分发布仅含单平台/单架构的情况）。
  const latestByOs: Record<ReleaseOs, ResolvedAsset[]> = { windows: [], macos: [], linux: [] };
  const shown = new Set<string>();
  const older: { release: Release; assets: ReleaseAsset[] }[] = [];
  for (const release of data.releases) {
    const previous: ReleaseAsset[] = [];
    for (const asset of release.assets) {
      const os = M.assetOs(asset);
      const slot = `${os}:${asset.arch}:${asset.kind}`;
      if (!shown.has(slot)) { shown.add(slot); latestByOs[os].push({ release, asset }); }
      else previous.push(asset);
    }
    if (previous.length) older.push({ release, assets: previous });
  }

  const selectedOs = downloadOs;
  const osEntries = latestByOs[selectedOs];
  const arches = [...new Set(osEntries.map(item => item.asset.arch))];
  if (downloadArch !== 'all' && !arches.includes(downloadArch)) downloadArch = 'all';

  const bar = el('div', 'dl-bar');
  const osTabs = el('div', 'chips dl-os-tabs'); osTabs.setAttribute('role', 'tablist'); osTabs.setAttribute('aria-label', '选择目标操作系统');
  for (const os of M.releaseOperatingSystems) {
    const count = latestByOs[os].length;
    const tab = el('button', 'chip dl-os-tab'); tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(os === selectedOs));
    tab.setAttribute('aria-pressed', String(os === selectedOs));
    tab.append(icon(osIcon[os]), el('span', '', M.osLabel(os)));
    if (os === detected.os) tab.append(el('em', 'dl-here', '本机'));
    tab.append(el('span', `n${count ? '' : ' muted'}`, count ? String(count) : '待发布'));
    tab.addEventListener('click', () => { downloadOs = os; downloadArch = 'all'; render(); });
    osTabs.append(tab);
  }
  bar.append(osTabs);

  const rightBar = el('div', 'dl-bar-meta');
  if (arches.length > 1) {
    const archTabs = el('div', 'chips'); archTabs.setAttribute('aria-label', '按 CPU 架构筛选');
    const archItems: ['all' | ReleaseArch, string][] = [['all', '全部架构'], ...arches.map(a => [a, M.archLabel(a)] as [ReleaseArch, string])];
    for (const [val, label] of archItems) {
      const chip = el('button', 'chip', label); chip.type = 'button';
      chip.setAttribute('aria-pressed', String(downloadArch === val));
      chip.addEventListener('click', () => { downloadArch = val; render(); });
      archTabs.append(chip);
    }
    rightBar.append(archTabs);
  }
  rightBar.append(el('span', 'dl-detected', `当前环境：${M.osLabel(detected.os)} · ${M.archLabel(detected.arch)}`));
  bar.append(rightBar);
  page.append(bar);

  const filtered = downloadArch === 'all' ? osEntries : osEntries.filter(item => item.asset.arch === downloadArch);
  const availablePlatforms = M.releaseOperatingSystems.filter(os => latestByOs[os].length > 0);

  if (!filtered.length) {
    page.append(installGuide(data.configured, selectedOs, detected, availablePlatforms, server, dev));
  } else {
    const recAsset = M.pickRecommendedAsset(filtered.map(item => item.asset), detected.arch) ?? filtered[0].asset;
    const rec = filtered.find(item => item.asset === recAsset) ?? filtered[0];
    const hero = releaseHero(rec.release, rec.asset, selectedOs, server, dev);
    const stage = el('div', 'grid dl-stage');
    if (filtered.length === 1) {
      stage.append(hero, packageCard(filtered[0].release, filtered[0].asset, server, dev, 's7'));
      page.append(stage);
    } else {
      stage.append(hero, quickGuideCard(selectedOs, filtered, server, dev));
      page.append(stage);
      const dl = el('div', 'dl');
      for (const item of filtered) dl.append(packageCard(item.release, item.asset, server, dev));
      page.append(dl);
    }
  }

  if (older.length) page.append(historyCard(older, selectedOs));
}

function releaseHero(release: Release, rec: ReleaseAsset, os: ReleaseOs, server: string, dev: boolean) {
  const details = describeAsset(rec);
  const card = el('section', 'card ink s5 dl-hero');
  const badge = pill(rec.signed ? `已签名 · ${M.osLabel(os)}` : `未签名预览 · ${M.osLabel(os)}`, rec.signed ? 'ok' : 'warn');
  card.append(cardHead(`${M.osLabel(os)} 最新推荐`, '', badge));
  card.append(el('b', 'dl-ver', release.version), el('p', 'dl-sub', `${release.tag} · ${time(release.publishedAt)} · ${osEnvironmentLead[os]}`));
  if (release.notes) card.append(el('p', 'dl-lead', release.notes));

  const fileBox = el('div', 'dl-get'); const meta = el('span');
  meta.append(el('b', 'mono', rec.name), el('small', '', `${details.info.title} · ${details.platform} (${M.assetFormat(rec)}) · ${M.formatBytes(rec.bytes)}`));
  fileBox.append(meta);
  card.append(fileBox);

  const ctaRow = el('div', 'dl-cta-row');
  const primary = rec.sources[0];
  const link = el('a', 'btn accent'); link.href = primary.url; link.rel = 'noopener noreferrer';
  link.append(icon('download'), el('span', '', `下载 ${M.assetFormat(rec)} · ${M.formatBytes(rec.bytes)}`));
  ctaRow.append(link);
  for (const src of rec.sources.slice(1)) {
    const mirror = el('a', 'btn sm', sourceName[src.kind]); mirror.href = src.url; mirror.rel = 'noopener noreferrer';
    ctaRow.append(mirror);
  }
  card.append(ctaRow);

  const verifyStatus = el('small', 'hint dl-verify-status');
  const reportCopy = (ok: boolean, copied: string) => {
    verifyStatus.textContent = ok ? `已复制：${copied}` : '未能访问剪贴板，请手动选择复制。';
  };
  card.append(serverAddressBox(server, dev, reportCopy));

  const verifyRow = el('div', 'dl-verify');
  const verifyCmd = M.verifyCommand({ os, name: rec.name });
  const copyHashBtn = button(`SHA-256 · ${rec.sha256.slice(0, 12)}…`, () => copy(rec.sha256, ok => {
    verifyStatus.textContent = ok ? `已复制完整 SHA-256（${rec.sha256.slice(0, 12)}…）` : '未能访问剪贴板，请下方卡片手动复制。';
  }), 'btn sm', 'copy');
  const copyCmdBtn = button('复制校验命令', () => copy(verifyCmd, ok => {
    verifyStatus.textContent = ok ? `已复制：${verifyCmd}` : '未能访问剪贴板，请手动复制。';
  }), 'btn sm', 'terminal');
  verifyRow.append(copyHashBtn, copyCmdBtn);
  card.append(verifyRow, verifyStatus);
  return card;
}

function quickGuideCard(os: ReleaseOs, entries: ResolvedAsset[], server: string, dev: boolean) {
  const card = el('section', 'card dl-card s7');
  card.append(cardHead(`${M.osLabel(os)} 安装后执行指令`, `共 ${entries.length} 个可用包`));
  const archTips = entries.map(e => `${M.archLabel(e.asset.arch)} (${M.assetFormat(e.asset)})`).join('、');
  const bin = os === 'windows' ? 'ryreach' : './ryreach';
  const sampleName = entries[0]?.asset.name ?? '<下载文件名>';
  const verifyCmd = M.verifyCommand({ os, name: sampleName });
  const configCmd = M.configServerCommand(server, dev, bin);
  const pairCmd = M.pairCommand(server, '<配对码>', dev, bin);
  const hint = el('small', 'hint');
  const devHint = dev ? '（本地 HTTP 测试命令需带 --development）' : '';
  const stepItems: RichStep[] = os === 'windows'
    ? [
        { lead: [`下方按需选择安装包（${archTips}），先核对 SHA-256 再运行安装程序：`], cmds: [{ label: '校验示例（具体文件名见下方卡片）', text: verifyCmd }] },
        { lead: ['安装结束若弹出地址窗口请填入下方服务地址', devHint, '；或直接在终端执行设置命令：'], cmds: [{ label: '服务地址', text: server }, { label: '设置服务地址', text: configCmd }] },
        { lead: ['打开「', inlineRouteLink({ page: 'devices' }, '设备'), '」→「连接设备」获取配对码，替换 ', inlineCode('<配对码>'), ' 后在被控设备运行：'], cmds: [{ label: '配对设备', text: pairCmd }] },
        { lead: ['安装器已自动启动服务；运行下方命令确认已配对且在线（Worker + Agent/完整包如需 SSH 可另行运行 ', inlineCode('ryreach ssh enable'), '）：'], cmds: [{ label: '检查连接状态', text: 'ryreach status' }] },
      ]
    : [
        { lead: [`从下方选择对应架构（${archTips}），核对 SHA-256 后解压并进入含 `, inlineCode('ryreach'), ' 的目录：'], cmds: [{ label: '校验示例（具体文件名见下方卡片）', text: verifyCmd }] },
        { lead: ['在解压目录执行以下命令写入当前服务地址', devHint, '：'], cmds: [{ label: '服务地址', text: server }, { label: '写入服务地址', text: configCmd }] },
        { lead: ['打开「', inlineRouteLink({ page: 'devices' }, '设备'), '」→「连接设备」获取配对码，替换 ', inlineCode('<配对码>'), ' 后运行配对：'], cmds: [{ label: '配对设备', text: pairCmd }] },
        { lead: ['启动前台 Worker 并保持终端开启（按 ', inlineCode('Ctrl+C'), ' 等当前操作完成后退出）；另开终端可执行状态检查：'], cmds: [{ label: '启动前台 Worker', text: './ryreach run' }, { label: '检查连接状态', text: './ryreach status' }] },
      ];
  card.append(renderRichSteps(stepItems, (ok, copied) => { hint.textContent = ok ? `已复制：${copied}` : '未能访问剪贴板，请手动复制。'; }), hint);
  const footer = el('footer');
  footer.append(arrowLinkText({ page: 'devices' }, '去生成配对码'), arrowLinkText({ page: 'mcp' }, '查看 MCP 接入'));
  card.append(footer);
  return card;
}

function packageCard(release: Release, asset: ReleaseAsset, server: string, dev: boolean, spanClass = '') {
  const { os, portable, info, platform } = describeAsset(asset);
  const card = el('section', `card dl-card${spanClass ? ` ${spanClass}` : ''}`); card.setAttribute('aria-label', `${info.title} · ${platform}`);
  const head = el('header'); const titles = el('span', 'dl-t'); titles.append(el('b', '', info.title), el('small', '', portable ? `${platform} · ${info.who}` : info.who));
  head.append(thumb(asset.kind === 'node' && os === 'windows' ? 'devices' : osIcon[os]), titles, pill(asset.signed ? '已签名' : '未签名', asset.signed ? 'ok' : 'warn'));
  card.append(head, el('p', 'dl-lead', info.lead));

  const get = el('div', 'dl-get'); const meta = el('span');
  meta.append(el('b', 'mono', asset.name), el('small', '', `${release.version} · ${platform} · ${M.assetFormat(asset)} · ${M.formatBytes(asset.bytes)} · ${time(release.publishedAt)}`));
  get.append(meta);
  const primary = asset.sources[0]; const link = el('a', 'btn primary'); link.href = primary.url; link.rel = 'noopener noreferrer'; link.append(icon('download'), el('span', '', '下载'));
  get.append(link); card.append(get);

  const hash = el('div', 'dl-get'); const hashMeta = el('span');
  const cmd = M.verifyCommand({ os, name: asset.name });
  hashMeta.append(el('small', '', `SHA-256（核验：${cmd.split(' ')[0]}）`), el('b', 'mono', asset.sha256)); hash.append(hashMeta);
  const hint = el('small', 'hint');
  hash.append(iconButton('copy', '复制 SHA-256', () => copy(asset.sha256, ok => { hint.textContent = ok ? `已复制，可用「${cmd}」核对。` : '未能访问剪贴板，请手动选择复制。'; }), 'btn icon sm'));
  card.append(hash, hint);

  card.append(el('h4', '', '包里有什么')); const contents = el('ul', 'bullets'); info.contents.forEach(item => contents.append(el('li', '', item))); card.append(contents);
  card.append(el('h4', '', '怎么装 · 安装后执行与填写'));
  card.append(renderRichSteps(buildPackageSteps({ os, kind: asset.kind, portable, assetName: asset.name, verifyCmd: cmd, server, dev }), (ok, copied) => {
    hint.textContent = ok ? `已复制：${copied}` : '未能访问剪贴板，请手动复制。';
  }));

  const footer = el('footer');
  footer.append(button('复制校验命令', () => copy(cmd, ok => { hint.textContent = ok ? `已复制校验命令：${cmd}` : '未能访问剪贴板，请手动复制。'; }), 'btn sm', 'terminal'));
  for (const source of asset.sources.slice(1)) { const mirror = el('a', 'btn sm', `从 ${sourceName[source.kind]} 下载`); mirror.href = source.url; mirror.rel = 'noopener noreferrer'; footer.append(mirror); }
  card.append(footer);
  return card;
}

function historyCard(older: { release: Release; assets: ReleaseAsset[] }[], selectedOs: ReleaseOs) {
  const card = el('section', 'card dl-history');
  const filterBar = el('div', 'chips'); filterBar.setAttribute('aria-label', '历史版本筛选');
  for (const [all, label] of [[false, M.osLabel(selectedOs)], [true, '全部平台']] as [boolean, string][]) {
    const b = el('button', 'chip', label); b.type = 'button';
    b.setAttribute('aria-pressed', String(downloadHistoryAll === all));
    b.addEventListener('click', () => { downloadHistoryAll = all; render(); });
    filterBar.append(b);
  }
  card.append(cardHead('历史版本', '保留各平台已签发记录与源站校验入口', filterBar));
  const list = el('ul', 'history');
  let rendered = 0;
  for (const { release, assets } of older) {
    const matched = downloadHistoryAll ? assets : assets.filter(a => M.assetOs(a) === selectedOs);
    if (!matched.length) continue;
    rendered++;
    const li = el('li');
    const left = el('div', 'dl-hist-meta');
    left.append(el('b', '', release.version), el('span', 'muted', `${release.tag} · ${time(release.publishedAt)}`));
    const items = el('div', 'dl-hist-assets');
    for (const asset of matched) {
      const pillRow = el('div', 'dl-hist-asset');
      pillRow.append(el('span', 'dl-hist-tag', `${platformLabel(asset)} · ${M.assetFormat(asset)}`));
      for (const source of asset.sources) {
        const link = el('a', 'btn sm', sourceName[source.kind]); link.href = source.url; link.rel = 'noopener noreferrer'; link.title = asset.name;
        pillRow.append(link);
      }
      pillRow.append(iconButton('copy', `复制 ${asset.name} SHA-256`, () => copy(asset.sha256, ok => message(ok ? `已复制 ${asset.name} 的 SHA-256` : '复制失败，请手动查看。', ok ? 'ok' : 'warn')), 'btn icon sm'));
      items.append(pillRow);
    }
    li.append(left, items);
    list.append(li);
  }
  if (!rendered) card.append(el('p', 'hint', `历史发布中暂无 ${M.osLabel(selectedOs)} 安装包，可切到「全部平台」查看其他系统的历史版本。`));
  else card.append(list);
  return card;
}

function installStatusCopy(configured: boolean | null, selectedOs: ReleaseOs, detectedOs: ReleaseOs, availablePlatforms: ReleaseOs[]) {
  const hasOther = availablePlatforms.length > 0;
  if (configured === null) {
    return {
      hasOther,
      badge: '读取失败',
      heading: '暂时无法读取',
      lead: '发行清单暂时读取不到，请刷新页面重试；也可按下方或右侧说明从源码编译与配对。',
    };
  }
  if (hasOther) {
    return {
      hasOther,
      badge: '该平台待发布',
      heading: `暂未发布 ${M.osLabel(selectedOs)} 安装包`,
      lead: `当前发行清单仅包含 ${availablePlatforms.map(M.osLabel).join('、')} 发行包；${M.osLabel(selectedOs)} 归档或安装包将在验证后列入同一清单。`,
    };
  }
  if (configured) {
    return {
      hasOther,
      badge: '暂无可下载的包',
      heading: '暂无可下载的包',
      lead: `发行清单里还没有版本。发布后将按 ${M.osLabel(detectedOs)} / macOS / Linux 分类列出版本、架构、SHA-256 与三源下载链接。`,
    };
  }
  return {
    hasOther,
    badge: '暂无可下载的包',
    heading: '暂无可下载的包',
    lead: '这台服务尚未配置发行清单。各平台安装包或便携归档发布并登记后，这里将自动按系统呈现。',
  };
}

function installGuide(configured: boolean | null, selectedOs: ReleaseOs, detected: { os: ReleaseOs; arch: 'x64' | 'arm64' }, availablePlatforms: ReleaseOs[], server: string, dev: boolean) {
  const grid = el('div', 'grid');
  const status = el('section', 'card ink s5 dl-hero');
  const info = installStatusCopy(configured, selectedOs, detected.os, availablePlatforms);
  status.append(cardHead(`${M.osLabel(selectedOs)} 发布状态`, '', pill(info.badge, 'warn')));
  const big = el('b', 'dl-ver', info.heading);
  status.append(big, el('p', 'dl-lead', info.lead));
  if (info.hasOther) {
    const jumps = el('div', 'dl-cta-row');
    for (const other of availablePlatforms) {
      jumps.append(button(`切换到 ${M.osLabel(other)} 下载`, () => { downloadOs = other; downloadArch = 'all'; render(); }, 'btn accent', osIcon[other]));
    }
    status.append(jumps);
  }
  const statusHint = el('small', 'hint dl-verify-status');
  status.append(serverAddressBox(server, dev, (ok, copied) => {
    statusHint.textContent = ok ? `已复制服务地址：${copied}` : '未能访问剪贴板，请手动复制。';
  }), statusHint);
  const list = el('ul', 'bullets');
  for (const text of ['GitHub 与 Gitee 同步同一提交、标签与各平台构建产物', 'GitHub 不可达时由 Gitee 分发，Reach 镜像提供同摘要备用源', '每个安装包与便携归档均提供 SHA-256 与原生校验命令']) list.append(el('li', '', text));
  status.append(list);

  const guide = el('section', 'card dl-card s7');
  guide.append(cardHead(`在 ${M.osLabel(selectedOs)} 上构建与接入`));
  const platBullets = el('ul', 'bullets');
  const platFacts = selectedOs === 'macos'
    ? ['Reach Worker 源码（Rust src/node）原生支持 Darwin Apple Silicon / Intel', '支持通过便携 ./ryreach 在终端前台完成配对并执行命令与文件操作', '本机控制端 CLI 与 MCP 基于 Node.js 24，直接在 macOS 运行']
    : selectedOs === 'linux'
      ? ['Reach Worker 源码（Rust src/node）原生编译 Linux x64 / ARM64 目标', '服务端 deploy/build-release.mjs 与控制端 MCP 均可直接在 Linux 运行', '支持配合 systemd / 后台会话与无头 SSH 进行设备排查']
      : ['Windows 安装器位于 packaging/windows/（含延迟自启服务与离线 OpenSSH）', '签名正式包内置 Get-FileHash 与 Ed25519 自更新验签', '开发或预览验证可直接从 apps/reach 编译 reach.exe 与 ryreach.exe'];
  for (const text of platFacts) platBullets.append(el('li', '', text));
  guide.append(platBullets);

  const buildCmd = 'cargo build --release --bin reach --bin ryreach';
  const buildBox = el('div', 'dl-get'); const buildMeta = el('span');
  buildMeta.append(el('small', '', `${M.osLabel(selectedOs)} 从源码编译（在 apps/reach 目录）`), el('b', 'mono', buildCmd));
  buildBox.append(buildMeta, iconButton('copy', '复制编译命令', () => copy(buildCmd, ok => message(ok ? '已复制编译命令' : '复制失败，请手动复制。', ok ? 'ok' : 'warn')), 'btn icon sm'));
  guide.append(buildBox);

  const srcBin = selectedOs === 'windows' ? '.\\target\\release\\ryreach.exe' : './target/release/ryreach';
  const devHint = dev ? '（当前为本地 HTTP 测试地址，命令需保留 --development）' : '';
  const guideHint = el('small', 'hint');
  const srcSteps: RichStep[] = [
    { lead: ['若从源码运行，先写入下方服务地址', devHint, '（若已通过安装包安装到 PATH，把命令前缀改为 ', inlineCode('ryreach'), ' 即可）：'], cmds: [{ label: '当前服务地址', text: server }, { label: '写入服务地址', text: M.configServerCommand(server, dev, srcBin) }] },
    { lead: ['前往「', inlineRouteLink({ page: 'devices' }, '设备'), '」点击「连接设备」生成配对码，替换 ', inlineCode('<配对码>'), ' 后执行配对：'], cmds: [{ label: '配对设备', text: M.pairCommand(server, '<配对码>', dev, srcBin) }] },
    { lead: ['启动 Worker 并保持运行（按 ', inlineCode('Ctrl+C'), ' 等当前操作结束后停止）；另开终端可执行状态检查，上线后设备会出现在「', inlineRouteLink({ page: 'devices' }, '设备'), '」：'], cmds: [{ label: '启动 Worker', text: `${srcBin} run` }, { label: '查看连接状态', text: `${srcBin} status` }] },
  ];
  guide.append(renderRichSteps(srcSteps, (ok, copied) => { guideHint.textContent = ok ? `已复制：${copied}` : '未能访问剪贴板，请手动复制。'; }), guideHint);
  const footer = el('footer'); footer.append(arrowLinkText({ page: 'mcp' }, '查看 MCP 跨平台接入'), arrowLinkText({ page: 'devices' }, '去生成配对码')); guide.append(footer);
  grid.append(status, guide); return grid;
}

// ---------- MCP 接入 ----------
function agentBrief(server: string) {
  return `请帮我在这台电脑上接入 Reach MCP，并按下面的约定使用它。

## 接入
1. 需要 Node.js 24 和 Reach 源码目录（morrow-agent 仓库的 apps/reach，下称 <Reach 目录>）。不确定目录在哪时先问我。
2. 在 <Reach 目录> 里登录一次。PIN 由我提供，只通过环境变量传入，不要写进文件、日志或命令历史：
   $env:REACH_PIN = '<PIN>'
   node src/controller/main.ts login --server ${server} --pin
3. 把下面的段落写进 Codex 的 ~/.codex/config.toml（已有 [mcp_servers.reach] 时只更新它），然后提醒我重启 Codex：
   [mcp_servers.reach]
   command = "node"
   args = ["<Reach 目录>/src/controller/main.ts", "mcp"]
4. 重启后调用 reach_nodes，确认能看到已配对的设备。

## 使用约定
- 先用 reach_nodes 看设备是否在线、声明了哪些能力；只提交设备已声明的能力。
- 调用 reach_submit 前生成一个 UUID 作为 requestId 并记住；同一输入重试时沿用同一个 requestId，服务端据此不会重复执行。
- 提交后用 reach_operation 看状态，reach_events 分页读原始回执，reach_artifacts / reach_artifact 取产物；这些读取都不会重新执行操作。
- 结果为 unknown 时只根据回执和现场证据核对，不要为了确认而再提交一次同样的操作。
- reach_cancel 只是请求取消，不等于撤销已经发生的效果。
- 远程调整心跳用 reach_node_config，设备回执后才算生效。`;
}
interface ModelSettingsResponse { deskAvailable: boolean; deskRunning: boolean; deskUnavailable: string | null; providers: M.ModelProvider[]; desk: M.ModelSettingView; agent: M.ModelSettingView }
async function drawSettings() {
  const page = header('设置', null);
  const current = viewGeneration;
  const grid = el('div', 'grid'); page.append(grid);
  const loading = el('section', 'card s12'); loading.append(el('p', 'hint', '正在读取模型设置…')); grid.append(loading);
  let data: ModelSettingsResponse;
  try { data = await api<ModelSettingsResponse>('/settings/models'); }
  catch (error) { if (error instanceof StaleRequest || current !== viewGeneration) return; loading.replaceChildren(cardHead('模型设置'), el('p', 'notice error', error instanceof Error ? error.message : '读取失败')); return; }
  if (current !== viewGeneration) return;
  grid.replaceChildren(
    modelCard(data.desk, data, 'Reach Desk 云端对话', '网页里直接对话时使用，也负责把任务委派给设备上的 Agent。'),
    modelCard(data.agent, data, '现场 Agent 模型', '设备上的 Agent 执行任务时经服务端代理调用，令牌不下发到设备。'),
    providersCard(data),
    otherSettings());
}
function capabilityText(model: M.ProviderModel) { return `上下文 ${M.formatTokens(model.contextWindow)} · 输出 ${M.formatTokens(model.maxOutput)}${model.imageInput ? ' · 图片识别' : ''}`; }
function modelCard(view: M.ModelSettingView, all: ModelSettingsResponse, title: string, lead: string) {
  const agent = view.purpose === 'agent';
  const card = el('section', 'card s6 model-card');
  const state = M.modelSettingState(view);
  card.append(cardHead(title, '', pill(state.label, state.tone)));
  card.append(el('p', 'dl-lead', lead));
  if (!agent && !all.deskAvailable) card.append(el('p', 'notice warn', `对话运行时没有加载：${all.deskUnavailable ?? '原因未知，请查看服务日志。'}模型可以先保存、测试和启用。`));
  const live = view.running;
  const rows: [string, string | HTMLElement, boolean?][] = [
    ['当前运行', live && live.generation !== null ? `${live.model}（第 ${live.generation} 版${live.source === 'environment' ? '，来自环境变量' : ''}）` : '未运行'],
    ['已启用', view.enabled ? `${view.enabled.model}（第 ${view.enabled.generation} 版，${time(view.enabled.enabledAt)}）` : '尚未启用'],
  ];
  if (view.test) rows.push(['最近测试', `${view.test.ok ? '通过' : '未通过'} · 第 ${view.test.generation} 版 · ${time(view.test.at)} · ${M.formatMs(view.test.latencyMs)}`]);
  card.append(kvList(rows));
  if (live?.error) card.append(el('p', 'notice error', `已启用的配置没能生效：${live.error}`));

  const form = el('form', 'form model-form');
  const select = (label: string, placeholder: string) => { const wrap = el('div', 'field'); const box = new Dropdown(label, placeholder); wrap.append(el('span', '', label), box.element); form.append(wrap); return box; };
  const providerBox = select('供应商', '先在下方添加供应商'), modelBox = select('模型', '—');
  const caps = el('p', 'hint model-caps'); form.append(caps);
  providerBox.setOptions(all.providers.map(p => ({ value: p.id, label: p.name, hint: `${p.models.length} 个模型` })), view.saved?.providerId ?? undefined);
  providerBox.disabled = !all.providers.length;
  const fillModels = (keep?: string) => {
    const provider = all.providers.find(p => p.id === providerBox.value);
    modelBox.setOptions((provider?.models ?? []).map(m => ({ value: m.id, label: m.id, hint: m.imageInput ? '图片' : undefined })), keep);
    modelBox.disabled = !provider?.models.length;
  };
  const showCaps = () => {
    const provider = all.providers.find(p => p.id === providerBox.value), model = provider?.models.find(m => m.id === modelBox.value);
    caps.textContent = model ? capabilityText(model) : provider ? '这个供应商还没有模型，先获取或手动添加' : '';
  };
  fillModels(view.saved?.model); showCaps();
  providerBox.onChange = () => { fillModels(); showCaps(); };
  modelBox.onChange = showCaps;

  const status = el('p', 'notice'); status.setAttribute('role', 'status'); form.append(status);
  const say = (text: string, kind: '' | 'error' | 'ok' | 'warn' = '') => { status.textContent = text; status.className = `notice${kind ? ` ${kind}` : ''}`; };
  const saved = view.saved;
  if (view.test && saved && view.test.generation === saved.generation) say(view.test.message, view.test.ok ? 'ok' : 'error');
  else if (saved && view.enabled && saved.generation !== view.enabled.generation) say('供应商或模型能力有变化，测试通过并启用后才会替换运行中的配置。', 'warn');

  const save = el('button', 'btn primary', '保存选择'); save.type = 'submit';
  save.disabled = !all.providers.length;
  const test = button('测试连接', async () => {
    say('正在向模型发送一次测试请求…');
    try { const result = await api<{ ok: boolean; message: string; recorded: boolean }>(`/settings/models/${view.purpose}/test`, 'POST', {}); if (!result.recorded) { say('测试期间配置已被修改，结果未记录。', 'warn'); return; } render(); }
    catch (error) { if (!(error instanceof StaleRequest)) say(error instanceof Error ? error.message : '测试未完成', 'error'); }
  }, 'btn', 'bolt');
  test.disabled = !saved; if (!saved) test.title = '先保存选择';
  const enable = button('启用', async () => {
    try { await api(`/settings/models/${view.purpose}/enable`, 'POST', { generation: saved!.generation }); render(); message(`${agent ? '现场 Agent' : 'Reach Desk'} 已切换到 ${saved!.model}。新任务立即使用；按旧配置开始的任务不会改用新模型。`, 'ok'); }
    catch (error) { if (!(error instanceof StaleRequest)) say(error instanceof Error ? error.message : '启用未完成', 'error'); }
  }, 'btn accent');
  enable.disabled = !M.canEnableModel(view);
  enable.title = enable.disabled ? (view.enabled?.generation === saved?.generation && saved ? '当前版本已启用' : '当前版本通过连接测试后才能启用') : '立即切换到这一版';
  const actions = el('div', 'actions'); actions.append(test, enable, save); form.append(actions);
  form.addEventListener('submit', event => { event.preventDefault(); void run(save, async () => {
    if (!providerBox.value || !modelBox.value) { say('请选择供应商和模型', 'error'); return; }
    try { await api(`/settings/models/${view.purpose}`, 'PUT', { providerId: providerBox.value, model: modelBox.value }); render(); message('已保存。测试通过后点「启用」即可切换。', 'ok'); }
    catch (error) { if (!(error instanceof StaleRequest)) say(error instanceof Error ? error.message : '保存未完成', 'error'); }
  }); });
  card.append(form);
  if (!agent && all.deskRunning) { const open = el('a', 'btn', '打开对话'); open.href = 'desk/'; card.append(open); }
  return card;
}
function providersCard(all: ModelSettingsResponse) {
  const card = el('section', 'card s12 providers-card');
  card.append(cardHead('模型供应商', '兼容 OpenAI 接口，可添加多个', button('添加供应商', () => openProvider(null), 'btn sm', 'plus')));
  if (!all.providers.length) { card.append(el('p', 'dl-lead', '还没有供应商。添加请求地址和令牌后，点「获取模型」拉取模型列表，再给两个用途分别选择模型。')); return card; }
  const users = (id: string) => (['desk', 'agent'] as const).filter(p => all[p].saved?.providerId === id).map(p => p === 'desk' ? 'Reach Desk' : '现场 Agent');
  for (const provider of all.providers) {
    const block = el('div', 'provider');
    const head = el('div', 'provider-h');
    const info = el('div', 'provider-info');
    const name = el('strong', '', provider.name); info.append(name, el('code', '', provider.baseUrl));
    const meta = el('small', '', `${provider.models.length} 个模型${provider.modelsFetchedAt ? ` · ${time(provider.modelsFetchedAt)}获取` : ''}${users(provider.id).length ? ` · 用于 ${users(provider.id).join('、')}` : ''}`);
    info.append(meta);
    const status = el('p', 'notice'); status.setAttribute('role', 'status');
    const say = (text: string, kind: '' | 'error' | 'ok' = '') => { status.textContent = text; status.className = `notice${kind ? ` ${kind}` : ''}`; };
    const fetchButton = button('获取模型', async () => {
      say('正在请求模型列表…');
      try { const result = await api<{ models: M.ProviderModel[] }>(`/settings/providers/${provider.id}/models/fetch`, 'POST', {}); render(); message(`${provider.name}：获取到 ${result.models.length} 个模型。`, 'ok'); }
      catch (error) { if (!(error instanceof StaleRequest)) say(error instanceof Error ? error.message : '获取未完成', 'error'); }
    }, 'btn sm', 'download');
    const edit = button('编辑', () => openProvider(provider), 'btn sm ghost');
    const remove = button('删除', () => {
      if (document.querySelector('dialog[open]')) return;
      const dialog = modal('删除供应商');
      dialog.append(el('p', '', `删除「${provider.name}」后，它的令牌和模型列表一起删除，不能恢复。正在使用它的用途需要先改选其他模型。`));
      const note = el('p', 'hint'); note.setAttribute('role', 'alert'); dialog.append(note);
      const actions = el('div', 'actions'); actions.append(button('保留', () => dialog.close(), 'btn ghost'), button('删除供应商', async () => {
        try { await api(`/settings/providers/${provider.id}`, 'DELETE'); dialog.close(); render(); message(`已删除供应商「${provider.name}」。`, 'ok'); }
        catch (error) { if (!(error instanceof StaleRequest)) note.textContent = error instanceof Error ? error.message : '删除未完成'; }
      }, 'btn danger solid')); dialog.append(actions); dialog.showModal();
    }, 'btn sm ghost');
    head.append(info, fetchButton, edit, remove);
    block.append(head, status, modelTable(provider, say));
    card.append(block);
  }
  return card;
}
// 模型表：逐个标注图片识别、上下文与输出上限；未获取到的模型可以手动添加。
function modelTable(provider: M.ModelProvider, say: (text: string, kind?: '' | 'error' | 'ok') => void) {
  const details = el('details', 'model-table');
  details.append(el('summary', '', provider.models.length ? `模型能力（${provider.models.length}）` : '手动添加模型'));
  const rows: { id: string; image: HTMLInputElement; context: HTMLInputElement; output: HTMLInputElement; row: HTMLElement }[] = [];
  const table = el('div', 'mt-rows');
  const headRow = el('div', 'mt-row mt-head'); for (const text of ['模型 ID', '图片识别', '上下文', '输出上限', '']) headRow.append(el('span', '', text));
  table.append(headRow);
  const addRow = (model: M.ProviderModel) => {
    const row = el('div', 'mt-row');
    const image = el('input'); image.type = 'checkbox'; image.checked = model.imageInput; image.setAttribute('aria-label', `${model.id} 支持图片识别`);
    const context = el('input'); context.type = 'number'; context.min = '1024'; context.max = '10000000'; context.value = String(model.contextWindow); context.setAttribute('aria-label', `${model.id} 上下文`);
    const output = el('input'); output.type = 'number'; output.min = '1'; output.max = '8192'; output.value = String(model.maxOutput); output.setAttribute('aria-label', `${model.id} 输出上限`);
    const drop = iconButton('close', `移除 ${model.id}`, () => { row.remove(); rows.splice(rows.findIndex(r => r.row === row), 1); }, 'btn icon sm ghost');
    const imageWrap = el('label', 'check'); imageWrap.append(image);
    row.append(el('code', '', model.id), imageWrap, context, output, drop);
    rows.push({ id: model.id, image, context, output, row }); table.append(row);
  };
  for (const model of provider.models) addRow(model);
  const adder = el('form', 'mt-add');
  const newId = el('input'); newId.placeholder = '模型 ID，例如 gpt-4.1'; newId.setAttribute('aria-label', '新模型 ID');
  const add = el('button', 'btn sm', '添加'); add.type = 'submit';
  adder.append(newId, add);
  adder.addEventListener('submit', event => { event.preventDefault(); const id = newId.value.trim(); if (!id) return; if (rows.some(r => r.id === id)) { say('这个模型 ID 已在列表里', 'error'); return; } addRow({ id, imageInput: false, contextWindow: 1_000_000, maxOutput: 8192 }); newId.value = ''; });
  const save = button('保存模型能力', async () => {
    const models = rows.map(r => ({ id: r.id, imageInput: r.image.checked, contextWindow: Number(r.context.value), maxOutput: Number(r.output.value) }));
    try { await api(`/settings/providers/${provider.id}/models`, 'PUT', { models }); render(); message(`${provider.name}：模型能力已保存。正在使用的用途会生成新版本，测试并启用后生效。`, 'ok'); }
    catch (error) { if (!(error instanceof StaleRequest)) say(error instanceof Error ? error.message : '保存未完成', 'error'); }
  }, 'btn sm primary');
  const foot = el('div', 'mt-foot'); foot.append(adder, save);
  details.append(table, foot);
  return details;
}
function openProvider(provider: M.ModelProvider | null) {
  if (document.querySelector('dialog[open]')) return;
  const dialog = modal(provider ? `编辑供应商 · ${provider.name}` : '添加供应商');
  dialog.append(el('p', '', '任何兼容 OpenAI 接口的服务都可以。请求地址填到版本路径为止，例如 https://api.openai.com/v1；只填域名时自动补 /v1。'));
  const form = el('form', 'form');
  const input = (label: string, value: string, attrs: Partial<HTMLInputElement>) => { const wrap = el('label', 'field'); const box = el('input'); box.value = value; Object.assign(box, attrs); wrap.append(el('span', '', label), box); form.append(wrap); return box; };
  const name = input('名称', provider?.name ?? '', { required: true, maxLength: 60, placeholder: '例如 OpenAI、DeepSeek、公司网关' });
  const baseUrl = input('请求地址', provider?.baseUrl ?? '', { type: 'url', required: true, placeholder: 'https://api.openai.com/v1', spellcheck: false });
  const token = input('令牌（API Key）', '', { type: 'password', autocomplete: 'off', required: !provider, placeholder: provider ? '已配置；留空则保留原令牌' : 'sk-…' });
  const status = el('p', 'notice'); status.setAttribute('role', 'alert'); form.append(status);
  const submit = el('button', 'btn primary', provider ? '保存' : '添加'); submit.type = 'submit';
  const actions = el('div', 'actions'); actions.append(button('取消', () => dialog.close(), 'btn ghost'), submit); form.append(actions);
  form.addEventListener('submit', event => { event.preventDefault(); void run(submit, async () => {
    const payload: Record<string, string> = { name: name.value.trim(), baseUrl: baseUrl.value.trim() };
    if (token.value.trim()) payload.token = token.value.trim();
    try {
      if (provider) await api(`/settings/providers/${provider.id}`, 'PUT', payload);
      else {
        const created = await api<{ id: string }>('/settings/providers', 'POST', payload);
        // 新供应商顺手拉一次模型列表；失败不影响已添加的供应商。
        try { await api(`/settings/providers/${created.id}/models/fetch`, 'POST', {}); } catch (error) { if (error instanceof StaleRequest) return; dialog.close(); render(); message(`供应商已添加，但获取模型没有成功：${error instanceof Error ? error.message : ''}。可以稍后重试或手动添加模型。`, 'warn'); return; }
      }
      token.value = ''; dialog.close(); render(); message(provider ? '供应商已更新。' : '供应商已添加，模型列表已获取。', 'ok');
    } catch (error) { if (!(error instanceof StaleRequest)) { status.className = 'notice error'; status.textContent = error instanceof Error ? error.message : '保存未完成'; } }
  }); });
  dialog.append(form); dialog.showModal(); name.focus();
}
function otherSettings() {
  const card = el('section', 'card s12');
  card.append(cardHead('账户与设备'));
  const list = el('div', 'settings-links');
  const item = (iconName: string, title: string, note: string, action: HTMLElement) => { const row = el('div', 'settings-link'); const text = el('div'); text.append(el('strong', '', title), el('small', '', note)); row.append(thumb(iconName), text, action); list.append(row); };
  if (rayLogin) item('key', 'Controller PIN', user?.pinIsDefault ? '首次从本机 Controller 登录前需要设置私有 PIN' : '用于本机 Reach Controller 登录', button('修改 PIN', openChangePin, 'btn sm'));
  else item('key', '登录 PIN', user?.pinIsDefault ? '仍在使用默认 PIN 2026' : '网页和本机控制器共用', button('修改 PIN', openChangePin, 'btn sm'));
  item('plus', '配对设备', '生成一次性配对码，在设备上执行', button('配对', () => openPairing(null), 'btn sm'));
  item('download', '安装包', '版本和摘要来自正式发行清单', arrowLinkText({ page: 'downloads' }, '下载'));
  item('copy', 'MCP 接入', '让本机 Agent 通过 Reach 调用设备', arrowLinkText({ page: 'mcp' }, '查看'));
  card.append(list); return card;
}
function drawMcp() {
  const page = header('MCP 接入', null);
  const server = M.serverBase(location.href);
  const brief = agentBrief(server);
  const grid = el('div', 'grid');
  const agent = el('section', 'card ink s12');
  const agentHint = el('small', '', '');
  agent.append(cardHead('交给 Agent 配置', '', agentHint, button('复制给 Agent', () => copy(brief, ok => { agentHint.textContent = ok ? '已复制，粘贴给 Codex 等 Agent 即可' : '未能访问剪贴板，请展开后手动复制'; }), 'btn accent', 'copy')));
  agent.append(el('p', 'dl-lead', '复制一段完整说明，里面有登录、写入 MCP 配置、自检和使用约定。粘贴给 Codex，它会自己完成接入；PIN 由你在它询问时提供。'));
  const preview = el('details', 'chart-table'); preview.append(el('summary', '', '查看要复制的内容'), el('pre', 'codebox', brief)); agent.append(preview);
  const setup = el('section', 'card dl-card s7'); setup.append(cardHead('手动配置'));
  const steps = el('ol', 'steps');
  const login = `$env:REACH_PIN = '<你的 PIN>'\nnode src/controller/main.ts login --server ${server} --pin`;
  const config = `[mcp_servers.reach]\ncommand = "node"\nargs = ["<Reach 目录>/src/controller/main.ts", "mcp"]`;
  for (const text of ['准备 Node.js 24 与 Reach 源码目录（当前开发入口，正式安装版控制器待发布）。', '在 Reach 目录用 PIN 登录一次，凭据保存在本机。', '把 MCP 配置加入 Codex 的 config.toml，重启客户端。']) steps.append(el('li', '', text));
  setup.append(steps);
  for (const [label, text] of [['登录命令', login], ['MCP 配置', config]] as const) {
    const box = el('div', 'evidence'); box.style.marginTop = '16px'; const head = el('div', 'evidence-h'); const hint = el('small', 'hint');
    head.append(el('h3', '', label), hint, button('复制', () => copy(text, ok => { hint.textContent = ok ? '已复制' : '请手动选择复制'; }), 'btn sm', 'copy'));
    box.append(head, el('pre', 'codebox', text)); setup.append(box);
  }
  const side = el('div', 'stack s5');
  const status = el('section', 'card'); status.append(cardHead('登录方式'));
  status.append(kvList([['网页控制台', 'PIN'], ['本机控制器', '同一个 PIN'], ['对应账户', user!.username]]));
  status.append(el('p', 'dl-lead', '网页和本机控制器用同一个 PIN 登录同一账户，看到的是同一批已配对设备。PIN 连续输错 3 次锁定 1 小时，网页和控制器共用这个计数。'));
  const tools = el('section', 'card'); tools.append(cardHead('常用工具'));
  const list = el('ul', 'bullets');
  for (const [name, text] of [['reach_nodes', '列出已配对设备及其实际连接状态与能力'], ['reach_submit', '提交操作；同一输入重试时沿用同一 requestId'], ['reach_operation', '读取原操作状态与结果，不会重新执行'], ['reach_events', '按序号分页读取原始回执'], ['reach_node_config', '远程调整心跳间隔，设备回执后生效']] as const) {
    const li = el('li'); li.append(el('code', '', name), ` ${text}`); list.append(li);
  }
  tools.append(list, el('p', 'dl-lead', '结果未知的操作只核对、不重放；取消请求不等于撤销已发生的效果。'));
  side.append(status, tools);
  grid.append(agent, setup, side); page.append(grid);
}


// ---------- 统计与监控 ----------
interface DailyStat { day: number; date: string; total: number; succeeded: number; failed: number; cancelled: number; unknown: number; active: number; uplinkBytes: number; downlinkBytes: number; receipts: number; reconnects: number }
interface Stats {
  days: number; from: number; to: number; daily: DailyStat[];
  totals: { operations: number; succeeded: number; terminal: number; successRate: number | null; uplinkBytes: number; downlinkBytes: number; receipts: number };
  durations: { count: number; p50: number | null; p90: number | null };
  kinds: { kind: string; count: number }[];
  devices: { nodeId: string; name: string; total: number; succeeded: number; failed: number; unknown: number }[];
  availability: { nodeId: string; name: string; since: number | null; ratio: number | null; offline: [number, number][] }[];
}
let statsDays: 7 | 14 | 30 = 14;
function fetchStats(days: number, node?: string) { return api<Stats>(`/stats?days=${days}&tz=${-new Date().getTimezoneOffset()}${node ? `&node=${node}` : ''}`); }
const countFormat = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(1);
function trendChart(stats: Stats, title: string) {
  return lineChart({ title, labels: stats.daily.map(d => M.shortDate(d.date)), fullLabels: stats.daily.map(d => M.longDate(d.date)), format: countFormat, height: 200,
    series: [{ name: '操作', tone: 'a', values: stats.daily.map(d => d.total) }, { name: '未成功（失败、取消、未知）', tone: 'b', dashed: true, values: stats.daily.map(d => d.failed + d.cancelled + d.unknown) }] });
}
function trafficChart(stats: Stats) {
  return lineChart({ title: '数据流量', labels: stats.daily.map(d => M.shortDate(d.date)), fullLabels: stats.daily.map(d => M.longDate(d.date)), format: n => M.formatBytes(Math.round(n)), height: 200,
    series: [{ name: '设备回传（回执与产物）', tone: 'a', values: stats.daily.map(d => d.uplinkBytes) }, { name: '下发指令', tone: 'b', values: stats.daily.map(d => d.downlinkBytes) }] });
}
function availabilityRows(stats: Stats, link = true) {
  const box = el('div', 'avail-list');
  for (const item of stats.availability) {
    const row = link ? el('a', 'avail-row') : el('div', 'avail-row'); if (row instanceof HTMLAnchorElement) row.href = M.routeHash({ page: 'device', id: item.nodeId });
    row.append(el('span', '', item.name), availabilityStrip({ from: stats.from, to: stats.to, since: item.since, offline: item.offline, describe: (a, b) => `离线 ${time(a)} – ${time(b)}（${M.formatDuration(b - a)}）` }), el('b', '', item.since === null ? '无记录' : M.percent(item.ratio)));
    box.append(row);
  }
  if (!stats.availability.length) box.append(el('p', 'hint', '还没有已配对的设备。'));
  const axis = el('div', 'avail-axis'); const scale = el('span'); scale.append(el('span', '', time(stats.from)), el('span', '', '现在'));
  axis.append(el('span'), scale, el('span'));
  box.append(axis);
  return box;
}
function statsFailure(card: HTMLElement, error: unknown) {
  if (error instanceof StaleRequest) return;
  card.append(el('p', 'notice error', error instanceof HttpError && error.status === 404 && error.code === 'not_found' ? '此服务版本尚未提供统计接口。' : error instanceof Error ? error.message : '统计读取失败'));
}
function drawStats() {
  const page = header('统计', null, iconButton('refresh', '刷新', () => render()));
  const range = el('div', 'toolbar');
  range.append(chips<string>([['7', '近 7 天', 0], ['14', '近 14 天', 0], ['30', '近 30 天', 0]].map(([v, l]) => [v, l, 0] as [string, string, number]), String(statsDays), value => { statsDays = Number(value) as 7 | 14 | 30; render(); }));
  range.querySelectorAll('.chip .n').forEach(n => n.remove());
  const view = viewGeneration; const body = el('div', 'page'); body.append(el('p', 'muted', '正在汇总…'));
  page.append(range, body);
  void fetchStats(statsDays).then(stats => {
    if (view !== viewGeneration) return;
    body.replaceChildren();
    const figures = el('section', 'card'); const row = el('div', 'figures');
    for (const [label, value, note] of [
      ['操作', String(stats.totals.operations), `${stats.totals.receipts} 条回执`], ['成功率', M.percent(stats.totals.successRate), `${stats.totals.terminal} 项已有结果`],
      ['中位耗时', M.formatMs(stats.durations.p50), `P90 ${M.formatMs(stats.durations.p90)}`], ['设备回传', M.formatBytes(stats.totals.uplinkBytes), `下发 ${M.formatBytes(stats.totals.downlinkBytes)}`],
      ['断线恢复', String(stats.daily.reduce((s, d) => s + d.reconnects, 0)), '次'],
    ] as const) { const fig = el('div', 'figure'); fig.append(el('small', '', label), el('b', '', value), el('span', '', note)); row.append(fig); }
    figures.append(row); body.append(figures);
    const grid = el('div', 'grid');
    const trend = el('section', 'card s8'); trend.append(cardHead('操作量', '按发起日'), trendChart(stats, '每日操作量'));
    const outcome = el('section', 'card s4'); outcome.append(cardHead('结果构成'));
    const totals = stats.daily.reduce((a, d) => ({ ok: a.ok + d.succeeded, bad: a.bad + d.failed + d.cancelled, unknown: a.unknown + d.unknown, active: a.active + d.active }), { ok: 0, bad: 0, unknown: 0, active: 0 });
    outcome.append(donut([{ label: '成功', value: totals.ok, cls: 'ok' }, { label: '失败或取消', value: totals.bad, cls: 'bad' }, { label: '结果未知', value: totals.unknown, cls: 'warn' }, { label: '进行中', value: totals.active, cls: 'muted' }], M.percent(stats.totals.successRate), '成功率'));
    const traffic = el('section', 'card s8'); traffic.append(cardHead('数据流量', '按服务端收到的原始内容计'), trafficChart(stats));
    const kinds = el('section', 'card s4'); kinds.append(cardHead('操作类型'), barList('操作类型', stats.kinds.map(k => ({ label: M.kindLabel(k.kind), value: k.count })), countFormat));
    const avail = el('section', 'card s12'); avail.append(cardHead('设备可用性', '绿色为在线，斜纹为离线；按记录到的断线区间计算'), availabilityRows(stats));
    const ranking = el('section', 'card s12'); ranking.append(cardHead('设备操作排行'), barList('设备操作排行', stats.devices.map(d => ({ label: d.name, value: d.total, href: M.routeHash({ page: 'device', id: d.nodeId }), parts: [{ value: d.succeeded, cls: 'ok', name: '成功' }, { value: d.failed, cls: 'bad', name: '失败或取消' }, { value: d.unknown, cls: 'warn', name: '结果未知' }, { value: d.total - d.succeeded - d.failed - d.unknown, cls: 'b', name: '进行中' }] })), countFormat));
    grid.append(trend, outcome, traffic, kinds, avail, ranking); body.append(grid);
  }).catch(error => { if (view === viewGeneration) { body.replaceChildren(); statsFailure(body, error); } });
}

// ---------- 易用性：快捷键、刷新时间、复制 ----------
function copyButton(text: string, label: string) {
  const item = iconButton('copy', label, () => copy(text, ok => { item.title = ok ? '已复制' : '未能访问剪贴板'; message(ok ? `${label}：已复制` : '未能访问剪贴板，请手动选择复制。', ok ? 'ok' : 'warn'); }), 'btn icon sm copy-btn');
  return item;
}
function updateFreshness() {
  const item = document.querySelector<HTMLButtonElement>('.fresh'); if (!item) return;
  const age = updatedAt ? Date.now() - updatedAt : null;
  item.classList.toggle('stale', age === null || age > REFRESH_MS * 3);
  const text = age === null ? '尚未同步' : age < 10_000 ? '刚刚同步' : `${M.formatDuration(age)}前同步`;
  (item.querySelector('span') ?? item).textContent = text; item.title = `每 ${REFRESH_MS / 1000} 秒自动同步，点击立即刷新`;
}
setInterval(updateFreshness, 5000);
document.addEventListener('keydown', event => {
  if (!user || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]')) return;
  const target = event.target as HTMLElement | null;
  if (target && (target.closest('input, textarea, select, [contenteditable="true"]'))) return;
  if (event.key === '/') { const toggle = main?.querySelector<HTMLButtonElement>('.find > .btn'); if (toggle) { event.preventDefault(); if (!toggle.parentElement!.classList.contains('open')) toggle.click(); else toggle.parentElement!.querySelector('input')?.focus(); } }
  if (event.key === 'n' || event.key === 'N') { event.preventDefault(); openSubmit(route.page === 'device' ? route.id : null); }
});

// ---------- 启动 ----------
async function start() {
  try { user = await api<User>('/auth/me'); }
  catch (error) { if (!(error instanceof StaleRequest)) showLogin(error instanceof Error && error.message !== '请先登录 Reach' ? error.message : ''); return; }
  await enterConsole();
}
window.addEventListener('hashchange', () => { if (user && main) render(); });
window.addEventListener('pageshow', event => {
  if (event.persisted) {
    clearSession(); const loading = el('main', 'loading', '正在恢复 Reach 连接…'); loading.id = 'main'; app.replaceChildren(loading);
    void start();
  }
});
void start();
