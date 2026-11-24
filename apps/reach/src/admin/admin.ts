// Copyright (c) Ray Zhang. Reach 网页控制台：设备、配对、配置、操作与原收据、上线通知、下载和 MCP 接入。
import { ArtifactReader, parseArtifacts } from './artifacts.js';
import { availabilityStrip, barList, donut, lineChart } from './charts.js';
import * as M from './model.js';
import type { Device, DeviceEvent, Json, OperationSummary, Route, Tone, WebKind } from './model.js';
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
interface ReleaseAsset { name: string; kind: 'node' | 'complete'; arch: string; bytes: number; sha256: string; signed: boolean; sources: { kind: 'github' | 'gitee' | 'reach'; url: string }[] }
interface Release { version: string; tag: string; publishedAt: number; notes?: string; assets: ReleaseAsset[] }

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
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 5v6h-6'],
  back: ['M15 5l-7 7 7 7'],
  check: ['M5 12l5 5 9-10'],
  copy: ['M9 9h11v11H9z', 'M5 15V4h11'],
  link: ['M10 14l4-4', 'M8 11l-2 2a3 3 0 0 0 4 4l2-2', 'M16 13l2-2a3 3 0 0 0-4-4l-2 2'],
  play: ['M7 5l12 7-12 7z'],
  pulse: ['M3 12h4l3-7 4 14 3-7h4'],
  shield: ['M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z'],
  key: ['M15 7a4 4 0 1 1-3.5 6L5 19.5V22H2v-3l6.5-6.5A4 4 0 0 1 15 7z'],
  logout: ['M15 4h4v16h-4', 'M10 8l-4 4 4 4', 'M6 12h10'],
  wait: ['M12 7v5l3 2', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'],
  alert: ['M12 8v5', 'M12 16.5v.5', 'M10.3 4l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0z'],
  terminal: ['M4 5h16v14H4z', 'M8 10l3 2-3 2', 'M13 15h3'],
  arrow: ['M7 17L17 7', 'M8 7h9v9'],
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
  item.disabled = true;
  try { await action(); } catch (error) { if (epoch === generation && !(error instanceof StaleRequest)) message(error instanceof Error ? error.message : '操作未完成，请检查连接', 'error'); }
  finally { item.disabled = false; }
}
function message(text: string, kind: '' | 'error' | 'warn' | 'ok' = '') {
  if (!notice) return;
  notice.textContent = text; notice.className = `notice${kind ? ` ${kind}` : ''}`;
  notice.setAttribute('role', kind === 'error' ? 'alert' : 'status');
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
    if (response.status === 401 && result.error?.code === 'ray_login_required') { clearSession(); location.assign('/ray/login?next=%2Freach%2F'); throw new StaleRequest(); }
    if (response.status === 401 && result.error?.code === 'reach_session_refresh') { showLogin('Ray 登录仍有效，请重新连接 Reach。若反复出现，请允许此站点保存 Cookie。原操作不会自动重试。'); throw new StaleRequest(); }
    if (response.status === 401 && user) { showLogin('登录已过期，请重新登录。未确认的操作不会自动重试。'); throw new StaleRequest(); }
    throw new HttpError(response.status, result.error?.code ?? 'http_error', result.error?.message ?? `请求失败（${response.status}）`);
  }
  return result as T;
}
function brand() { const item = el('a', 'brand'); item.href = '#/devices'; item.setAttribute('aria-label', 'Reach 首页'); const logo = el('img'); logo.src = 'assets/reach.svg'; logo.alt = ''; logo.width = 28; logo.height = 28; item.append(logo, el('span', '', 'Reach')); return item; }
function closePopovers() { document.querySelectorAll('.popover').forEach(node => node.remove()); }
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
function showLogin(reason = '') {
  clearSession(); app.replaceChildren();
  const wrap = el('div', 'login-wrap'); const card = el('main', 'login frame-bg'); card.id = 'main'; wrap.append(card); app.append(wrap);
  notice = el('div', 'notice'); notice.setAttribute('role', 'status');
  if (rayLogin) {
    card.append(brand(), el('h1', '', '从 Ray 工作台继续'), notice, button('继续进入 Reach', () => { location.assign('/reach/'); }, 'btn primary'));
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
  showShell();
  try { await refresh(); } catch (error) { if (!(error instanceof StaleRequest)) message(error instanceof Error ? error.message : '读取失败，请刷新', 'error'); }
  void pollEvents().then(() => { if (route.page === 'devices' && !document.querySelector('dialog') && !document.querySelector('.popover')) render(); });
  clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => { if (document.visibilityState === 'visible' && user) void backgroundRefresh(); }, REFRESH_MS);
}
async function backgroundRefresh() {
  const before = JSON.stringify([devices, operations, unresolvedCount, deviceEvents.length, unreadCount]);
  try { await refresh(false); } catch { return; }
  await pollEvents();
  // 只在列表页且数据有变时重绘，避免打断详情页里的输入。
  if ((route.page === 'devices' || route.page === 'operations') && before !== JSON.stringify([devices, operations, unresolvedCount, deviceEvents.length, unreadCount]) && !document.querySelector('dialog') && !document.querySelector('.popover')) render();
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
  const items: [Route, string, number][] = [[{ page: 'devices' }, '设备', 0], [{ page: 'operations' }, '操作', unresolvedCount], [{ page: 'stats' }, '统计', 0], [{ page: 'downloads' }, '下载', 0], [{ page: 'mcp' }, 'MCP 接入', 0]];
  for (const [target, label, badge] of items) {
    const item = el('a', '', label); item.href = M.routeHash(target);
    if (badge) { const count = el('span', 'n', String(badge)); count.title = `${badge} 项操作结果待核对`; item.append(count); }
    if (M.navSection(target) === section) item.setAttribute('aria-current', 'page');
    nav.append(item);
  }
  if (deskEnabled) { const desk = el('a', '', 'Reach Desk'); desk.href = 'desk/'; nav.append(desk); }
  const actions = el('div', 'top-actions');
  const account = el('button', 'avatar', user.username.slice(0, 1).toUpperCase()); account.type = 'button'; account.title = `${user.username} · 外观与退出`; account.setAttribute('aria-haspopup', 'dialog'); account.setAttribute('aria-label', `${user.username}，外观与退出`);
  account.addEventListener('click', event => { event.stopPropagation(); toggleAccountMenu(account); });
  const fresh = el('button', 'fresh'); fresh.type = 'button'; fresh.append(el('i', 'dot'), el('span'));
  fresh.addEventListener('click', () => { void run(fresh, async () => { await refresh(); await pollEvents(); updateFreshness(); }); });
  actions.append(fresh, bell(), account); queueMicrotask(updateFreshness);
  top.append(nav, actions);
}
function render() {
  if (!main || !user) return;
  route = M.parseRoute(location.hash); viewGeneration++; closePopovers();
  drawTop();
  main.replaceChildren();
  switch (route.page) {
    case 'devices': drawDevices(); break;
    case 'device': drawDevice(route.id); break;
    case 'operations': drawOperations(); break;
    case 'operation': void drawOperation(route.id); break;
    case 'stats': drawStats(); break;
    case 'downloads': void drawDownloads(); break;
    case 'mcp': drawMcp(); break;
  }
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
  card.append(el('p', 'dl-lead', '在目标 Windows 上装好 Reach 后，生成一次性配对码并在那台设备上运行配对命令。首次上报能力后，它会在这里显示为在线，并生成上线通知。'));
  const steps = el('ol', 'steps');
  for (const step of ['下载并运行 Windows 安装包，服务会自动注册并启动。', '首次运行 ryreach 时填写本服务地址（安装器已预配置则跳过）。', '在这里生成配对码，到那台设备上运行配对命令。']) steps.append(el('li', '', step));
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
    const circle = el('span', 'circle'); circle.append(icon(op.kind.startsWith('file') || op.kind === 'directory.list' ? 'copy' : 'terminal'));
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
    name.append(avatar(op.kind.startsWith('file') || op.kind === 'directory.list' ? 'copy' : op.kind.startsWith('agent') ? 'pulse' : 'terminal', M.stateTone(op.execution)), copyBox);
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
  if (!M.terminalStates.has(op.execution) && op.delivery !== 'cancelled') setTimeout(() => { if (view === viewGeneration && current() && !document.querySelector('dialog') && !document.querySelector('.popover')) render(); }, 5000);
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
  dialog.addEventListener('close', () => { dialog.remove(); }); return dialog;
}
function openPairing(device: Device | null) {
  if (document.querySelector('dialog')) return;
  const dialog = modal(device ? `重新配对「${device.name}」` : '连接一台设备');
  dialog.append(el('p', '', device ? '在这台设备的终端运行下面的命令。安装身份会保留；原操作须先结算，否则服务会拒绝更换配对。' : '在目标设备的终端运行下面的命令。配对后，这个账户即可完全控制该设备。'));
  const status = el('p', 'hint'); status.setAttribute('role', 'status');
  const body = el('div', 'vstack'); dialog.append(body, status);
  const development = location.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(location.hostname);
  const renderCode = () => {
    body.replaceChildren();
    if (!pairing) { status.textContent = '配对码 10 分钟内有效，只能使用一次。'; return; }
    const command = M.pairCommand(M.serverBase(location.href), pairing.code, development);
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
  if (document.querySelector('dialog')) return;
  const dialog = modal('修改 PIN');
  dialog.append(el('p', '', '网页和本机控制器都用这个 PIN 登录。新 PIN 为 4–12 位数字，不能是默认的 2026。'));
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
    dialog.close(); render(); message('PIN 已修改。下次登录请使用新 PIN。', 'ok');
  }); });
  dialog.append(form); dialog.showModal(); fields[0].focus();
}
function openUnpair(device: Device) {
  if (document.querySelector('dialog')) return;
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
  if (document.querySelector('dialog')) return;
  const candidates = devices.filter(d => !d.revoked && M.availableKinds(d.capabilities).length);
  if (!candidates.length) { message('还没有可从网页发起操作的设备。', 'warn'); return; }
  const dialog = modal('发起操作');
  dialog.append(el('p', '', '操作会投递到所选设备，用该设备已有的能力执行。提交后可在原记录里查看回执与产物。'));
  const form = el('form', 'form');
  const deviceSelect = el('select'); deviceSelect.setAttribute('aria-label', '目标设备');
  for (const device of candidates) { const option = el('option', '', `${device.name}${device.online ? '' : '（当前离线，上线后投递）'}`); option.value = device.id; deviceSelect.append(option); }
  deviceSelect.value = nodeId && candidates.some(d => d.id === nodeId) ? nodeId : candidates[0].id;
  const kindSelect = el('select'); kindSelect.setAttribute('aria-label', '操作类型');
  const fieldsBox = el('div', 'form'); const idLine = el('p', 'hint');
  const status = el('p', 'notice'); status.setAttribute('role', 'status');
  const deviceLabel = el('label', 'field'); deviceLabel.append(el('span', '', '目标设备'), deviceSelect);
  const kindLabelEl = el('label', 'field'); kindLabelEl.append(el('span', '', '操作'), kindSelect);
  const row = el('div', 'form-row'); row.append(deviceLabel, kindLabelEl);
  form.append(row, fieldsBox, idLine, status);
  let requestId = crypto.randomUUID(); let unconfirmed = false;
  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  const resetId = () => { if (unconfirmed) return; requestId = crypto.randomUUID(); idLine.textContent = `请求 ID ${requestId}`; };
  const drawKinds = () => {
    const device = candidates.find(d => d.id === deviceSelect.value)!;
    const previous = kindSelect.value; kindSelect.replaceChildren();
    for (const kind of M.availableKinds(device.capabilities)) { const option = el('option', '', M.kindLabel(kind)); option.value = kind; kindSelect.append(option); }
    if ([...kindSelect.options].some(o => o.value === previous)) kindSelect.value = previous;
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
  deviceSelect.addEventListener('change', () => { drawKinds(); });
  kindSelect.addEventListener('change', drawFields);
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
  if (template && [...kindSelect.options].some(o => o.value === template.kind)) {
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
  const existing = document.querySelector(`.popover[data-id="${id}"]`); closePopovers();
  if (existing) return null;
  const popover = el('div', 'popover'); popover.dataset.id = id; popover.setAttribute('role', 'dialog');
  popover.addEventListener('click', event => event.stopPropagation());
  document.body.append(popover); placePopover(popover, anchor, align);
  anchor.setAttribute('aria-expanded', 'true');
  const close = () => { popover.remove(); anchor.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', close); document.removeEventListener('keydown', escape); window.removeEventListener('resize', close); };
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

// ---------- 下载 ----------
const packageInfo: Record<ReleaseAsset['kind'], { title: string; who: string; lead: string; contents: string[]; tone: string }> = {
  node: { title: 'Reach Node', who: '装在被控 Windows 上', lead: '让这台 Windows 常驻接受 Reach 控制：命令、文件、心跳与受管 SSH。', tone: '', contents: ['Reach Node Windows 服务，开机自启并按退避重连', 'ryreach 配置命令（加入 PATH）', '离线 OpenSSH 载荷与准备脚本，默认启用受管 SSH'] },
  complete: { title: 'Reach 完整包', who: '需要桌面与现场 Agent 时', lead: '在 Node 之外，带上桌面能力与现场 Agent 侧车，可远程查看与操作桌面。', tone: '', contents: ['Reach Node 与 ryreach 配置命令', '桌面能力 helper 与现场 Agent 侧车', '固定版本的便携 Python 运行时', '离线 OpenSSH 载荷'] },
};
const installSteps = ['运行安装程序。它会自动安装、注册 Windows 服务、加入 PATH 并启动服务。', '首次运行 ryreach 时填写本服务地址（安装器已预配置则跳过）。', '回到「设备」生成配对码，在这台设备上运行配对命令。首次上报能力后会收到上线通知。'];
async function drawDownloads() {
  const page = header('下载', null, iconButton('refresh', '刷新', () => render()));
  const view = viewGeneration; const loading = el('p', 'muted', '正在读取发行清单…'); page.append(loading);
  let data: { configured: boolean; releases: Release[] };
  try { data = await api('/releases'); }
  catch (error) {
    if (error instanceof StaleRequest || view !== viewGeneration) return;
    loading.remove();
    message(error instanceof HttpError && error.status === 404 && error.code === 'not_found' ? '此服务版本尚未提供发行清单接口。' : error instanceof Error ? error.message : '发行清单读取失败', 'error');
    page.append(installGuide(null)); return;
  }
  if (view !== viewGeneration) return;
  loading.remove();
  const latest = data.releases[0];
  if (!latest) { page.append(installGuide(data.configured)); return; }
  const dl = el('div', 'dl');
  for (const asset of latest.assets) dl.append(packageCard(latest, asset));
  page.append(dl);
  if (data.releases.length > 1) {
    const history = el('section', 'card'); history.append(cardHead('历史版本'));
    const list = el('ul', 'history');
    for (const release of data.releases.slice(1)) {
      const li = el('li'); li.append(el('b', '', release.version), el('span', 'muted', `${release.tag} · ${time(release.publishedAt)}`), el('span', 'grow'));
      for (const asset of release.assets) for (const source of asset.sources) { const link = el('a', 'btn sm', `${asset.arch} · ${sourceName[source.kind]}`); link.href = source.url; link.rel = 'noopener noreferrer'; li.append(link); }
      list.append(li);
    }
    history.append(list); page.append(history);
  }
}
const sourceName: Record<ReleaseAsset['sources'][number]['kind'], string> = { github: 'GitHub', gitee: 'Gitee', reach: 'Reach 镜像' };
function packageCard(release: Release, asset: ReleaseAsset) {
  const info = packageInfo[asset.kind];
  const card = el('section', 'card dl-card'); card.setAttribute('aria-label', info.title);
  const head = el('header'); const titles = el('span', 'dl-t'); titles.append(el('b', '', info.title), el('small', '', info.who));
  head.append(thumb(asset.kind === 'node' ? 'devices' : 'terminal'), titles, pill(asset.signed ? '已签名' : '未签名', asset.signed ? 'ok' : 'warn'));
  card.append(head, el('p', 'dl-lead', info.lead));
  const get = el('div', 'dl-get'); const meta = el('span'); meta.append(el('b', 'mono', asset.name), el('small', '', `${release.version} · Windows ${asset.arch} · ${M.formatBytes(asset.bytes)} · ${time(release.publishedAt)}`));
  get.append(meta);
  const primary = asset.sources[0]; const link = el('a', 'btn primary'); link.href = primary.url; link.rel = 'noopener noreferrer'; link.append(icon('download'), el('span', '', '下载'));
  get.append(link); card.append(get);
  const hash = el('div', 'dl-get'); const hashMeta = el('span'); hashMeta.append(el('small', '', 'SHA-256'), el('b', 'mono', asset.sha256)); hash.append(hashMeta);
  const hint = el('small', 'hint');
  hash.append(iconButton('copy', '复制 SHA-256', () => copy(asset.sha256, ok => { hint.textContent = ok ? '已复制，可用 Get-FileHash 核对。' : '未能访问剪贴板，请手动选择复制。'; }), 'btn icon sm'));
  card.append(hash, hint);
  card.append(el('h4', '', '包里有什么')); const contents = el('ul', 'bullets'); info.contents.forEach(item => contents.append(el('li', '', item))); card.append(contents);
  card.append(el('h4', '', '怎么装')); const steps = el('ol', 'steps'); installSteps.forEach(item => steps.append(el('li', '', item))); card.append(steps);
  const footer = el('footer');
  for (const source of asset.sources.slice(1)) { const mirror = el('a', 'btn sm', `从 ${sourceName[source.kind]} 下载`); mirror.href = source.url; mirror.rel = 'noopener noreferrer'; footer.append(mirror); }
  if (footer.childElementCount) card.append(footer);
  return card;
}
// 没有已发布签名包时：左侧说明发布状态，右侧给出从安装到上线的完整路径。
function installGuide(configured: boolean | null) {
  const grid = el('div', 'grid');
  const status = el('section', 'card ink s5'); status.append(cardHead('发布状态'));
  const big = el('b', '', '尚无签名包'); big.style.fontSize = '30px'; big.style.fontWeight = '300';
  status.append(big, el('p', 'dl-lead', configured === null ? '发行清单暂时读取不到，下面的安装路径仍然适用。' : configured ? '发行清单里还没有版本。发布后，这里会列出版本、架构、发布日期、SHA-256 以及 GitHub、Gitee、Reach 下载源。' : '这台服务尚未配置发行清单。签名包发布并登记清单后，这里会列出可下载的版本与校验值。'));
  const list = el('ul', 'bullets'); for (const text of ['GitHub 与 Gitee 发布同一提交、同一标签、同一安装包', 'GitHub 不可达时由 Gitee 分发，Reach 服务提供已核验的同版本备用', '每个包都给出 SHA-256，便于下载后核对']) list.append(el('li', '', text));
  status.append(list);
  const guide = el('section', 'card dl-card s7'); guide.append(cardHead('新设备从安装到上线'));
  const steps = el('ol', 'steps'); [...installSteps.slice(0, 2), '在「设备」生成一次性配对码，到那台设备上运行配对命令。', '设备出现在列表中；首次上报能力后显示为在线，并生成上线通知。'].forEach(item => steps.append(el('li', '', item)));
  guide.append(steps);
  const footer = el('footer'); footer.append(arrowLinkText({ page: 'devices' }, '去生成配对码')); guide.append(footer);
  grid.append(status, guide); return grid;
}

// ---------- MCP 接入 ----------
function agentBrief(server: string) {
  return `请帮我在这台电脑上接入 Reach MCP，并按下面的约定使用它。

## 接入
1. 需要 Node.js 24.20+ 和 Reach 源码目录（morrow-agent 仓库的 apps/reach，下称 <Reach 目录>）。在该目录运行 bun install --frozen-lockfile。
2. 提醒我在本机 PowerShell 7 里输入 PIN 并登录。请勿在聊天中索取 PIN：
   $env:REACH_PIN = Read-Host -MaskInput 'Reach PIN'
   try { node src/controller/main.ts login --server ${server} --pin } finally { Remove-Item Env:REACH_PIN }
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
function drawMcp() {
  const page = header('MCP 接入', null);
  const server = M.serverBase(location.href);
  const brief = agentBrief(server);
  const grid = el('div', 'grid');
  const agent = el('section', 'card ink s12');
  const agentHint = el('small', '', '');
  agent.append(cardHead('交给 Agent 配置', '', agentHint, button('复制给 Agent', () => copy(brief, ok => { agentHint.textContent = ok ? '已复制，粘贴给 Codex 等 Agent 即可' : '未能访问剪贴板，请展开后手动复制'; }), 'btn accent', 'copy')));
  agent.append(el('p', 'dl-lead', '把这段说明粘贴给 Codex。它会配置 MCP 并提示你在本机终端输入 PIN。'));
  const preview = el('details', 'chart-table'); preview.append(el('summary', '', '查看要复制的内容'), el('pre', 'codebox', brief)); agent.append(preview);
  const setup = el('section', 'card dl-card s7'); setup.append(cardHead('手动配置'));
  const steps = el('ol', 'steps');
  const login = `$env:REACH_PIN = Read-Host -MaskInput 'Reach PIN'\ntry { node src/controller/main.ts login --server ${server} --pin } finally { Remove-Item Env:REACH_PIN }`;
  const config = `[mcp_servers.reach]\ncommand = "node"\nargs = ["<Reach 目录>/src/controller/main.ts", "mcp"]`;
  for (const text of ['准备 Node.js 24.20+，在 Reach 源码目录运行 bun install --frozen-lockfile。', '在 Reach 目录用 PowerShell 7 安全输入 PIN 并登录，凭据保存在本机。', '把 MCP 配置加入 Codex 的 config.toml，重启客户端。']) steps.append(el('li', '', text));
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
  if (!user || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog')) return;
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
