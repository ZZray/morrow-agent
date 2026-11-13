// Copyright (c) Ray Zhang. Reach management: connection, pairing and original receipts.
import { ArtifactReader, parseArtifacts } from './artifacts.js';
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface User { id: string; username: string; csrf: string }
interface Device { id: string; name: string; platform: string; version: string; epoch: number; last_seen: number | null; revoked: number; capabilities: string[]; online: boolean }
interface OperationSummary { id: string; node_id: string; request_id: string; kind: string; delivery: string; execution: string; cancel_requested: number; created_at: number; updated_at: number }
interface Operation extends Omit<OperationSummary, 'kind'> { command_json: string; result_json: string | null; last_sequence: number }
interface Receipt { sequence: number; event_id: string; kind: string; data: Json; received_at: number }
interface Page { events: Receipt[]; nextAfter: number; hasMore: boolean }
const app = document.querySelector<HTMLDivElement>('#app')!;
const rayLogin = document.querySelector<HTMLMetaElement>('meta[name="reach-login-provider"]')?.content === 'ray';
const deskEnabled = document.querySelector<HTMLMetaElement>('meta[name="reach-desk"]')?.content === 'enabled';
let user: User | null = null;
let generation = 0;
let viewGeneration = 0;
let refreshSequence = 0;
let devices: Device[] = [];
let operations: OperationSummary[] = [];
let unresolvedCount = 0;
let section: 'devices' | 'operations' = 'devices';
let detailId: string | null = null;
let updatedAt = 0;
let notice: HTMLDivElement | null = null;
let content: HTMLElement | null = null;
let pairing: { code: string; expiresAt: number } | null = null;
const stateNames: Record<string, string> = { not_observed: '尚未观察执行', received: '已接收', running: '执行中', succeeded: '已成功', failed: '已失败', cancelled: '已取消', unknown: '结果未知', output: '输出', queued: '待投递', claimed: '已投递', uncertain: '投递结果待核对', acknowledged: '已收到回执' };
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag); item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
function time(value: number | null) { return value === null ? '尚无连接记录' : new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function button(label: string, action: () => void | Promise<void>, className = '') {
  const item = el('button', className, label); item.type = 'button';
  item.addEventListener('click', () => { void run(item, action); }); return item;
}
async function run(item: HTMLButtonElement, action: () => void | Promise<void>) {
  const epoch = generation;
  item.disabled = true;
  try { await action(); } catch (error) { if (epoch === generation) message(error instanceof Error ? error.message : '操作未完成，请检查连接', true); }
  finally { item.disabled = false; }
}
function message(text: string, error = false) {
  if (!notice) return;
  notice.textContent = text; notice.className = `notice${error ? ' error' : ''}`;
  notice.setAttribute('role', error ? 'alert' : 'status');
}
class StaleRequest extends Error {}
async function api<T>(path: string, method = 'GET', input?: unknown): Promise<T> {
  const epoch = generation;
  let response: Response;
  try { response = await fetch(new URL(`../api/v1${path}`, import.meta.url), { method, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000), headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'x-reach-csrf': user?.csrf ?? '' }) }, body: method === 'GET' ? undefined : JSON.stringify(input ?? {}) }); }
  catch { if (epoch !== generation) throw new StaleRequest(); throw new Error(method === 'GET' ? '连接未完成。已显示的记录可能已过时，请刷新。' : '没有收到确认。请先刷新核对状态；已发生的操作不会自动重试。'); }
  const result = await response.json();
  if (epoch !== generation) throw new StaleRequest();
  if (!response.ok) {
    if (response.status === 401 && result.error?.code === 'ray_login_required') { clearSession(); location.assign('/ray/login?next=%2Freach%2F'); throw new StaleRequest(); }
    if (response.status === 401 && result.error?.code === 'reach_session_refresh') { showLogin('Ray 登录仍有效，请重新连接 Reach。若反复出现，请允许此站点保存 Cookie。原操作不会自动重试。'); throw new StaleRequest(); }
    if (response.status === 401 && user) { showLogin('登录已过期，请重新登录。'); throw new StaleRequest(); }
    throw new Error(result.error?.message ?? `请求失败（${response.status}）`);
  }
  return result as T;
}
function brand() { const item = el('div', 'brand'); const icon = el('img', 'mark'); icon.src = 'assets/reach.svg'; icon.alt = ''; icon.width = 32; icon.height = 32; item.append(icon, el('span', '', 'Reach')); return item; }
function field(label: string, name: string, type: string, autocomplete: string) {
  const wrapper = el('div'); const title = el('label', '', label); title.htmlFor = name;
  const input = el('input'); input.id = name; input.name = name; input.type = type; input.autocomplete = autocomplete as AutoFill; input.required = true;
  wrapper.append(title, input); return { wrapper, input };
}
function clearSession() {
  generation++; viewGeneration++; refreshSequence++; user = null; devices = []; operations = []; unresolvedCount = 0; detailId = null; updatedAt = 0; pairing = null;
  document.querySelectorAll('dialog').forEach(dialog => { dialog.close(); dialog.remove(); });
}
function showLogin(reason = '') {
  clearSession(); app.replaceChildren();
  if (rayLogin) {
    const main = el('main', 'login'); main.id = 'main';
    main.append(brand(), el('h1', '', '从 Ray 工作台继续'), el('p', 'muted', reason || '重新连接 Ray 登录状态后，即可继续使用 Reach。'), button('继续进入 Reach', () => { location.assign('/reach/'); }, 'primary'));
    app.append(main); return;
  }
  const main = el('main', 'login'); main.id = 'main';
  main.append(brand(), el('h1', '', '连接你的工作现场'), el('p', 'muted', '登录 Reach，查看设备连接与操作记录。'));
  notice = el('div', 'notice'); notice.setAttribute('role', 'status'); main.append(notice);
  const form = el('form');
  const username = field('账户', 'username', 'text', 'username'); username.input.maxLength = 128;
  const password = field('密码', 'password', 'password', 'current-password'); password.input.maxLength = 1024;
  const submit = el('button', 'primary', '登录 Reach'); submit.type = 'submit';
  form.append(username.wrapper, password.wrapper, submit);
  form.addEventListener('submit', event => { event.preventDefault(); void run(submit, async () => {
    message('');
    const result = await api<{ csrf: string; user: { id: string; username: string } }>('/auth/login', 'POST', { username: username.input.value, password: password.input.value });
    password.input.value = ''; user = { ...result.user, csrf: result.csrf }; generation++;
    showShell(); try { await refresh(); } catch (error) { if (!(error instanceof StaleRequest)) message(error instanceof Error ? error.message : '读取失败，请刷新', true); }
  }); });
  main.append(form, el('footer', '', '独立 Reach 账户 · Ray 工作台应用')); app.append(main);
  if (reason) message(reason, true);
}
function badge(state: string, label = stateNames[state] ?? state) {
  return el('span', `badge ${['online', 'succeeded'].includes(state) ? 'good' : ['unknown', 'uncertain'].includes(state) ? 'warn' : state === 'failed' ? 'bad' : ['running', 'received'].includes(state) ? 'active' : ''}`, label);
}
function showShell() {
  app.replaceChildren(); const shell = el('div', 'shell'); const side = el('aside'); side.append(brand());
  const nav = el('nav'); nav.setAttribute('aria-label', 'Reach 导航');
  for (const [id, label] of [['devices', '设备连接'], ['operations', '操作记录']] as const) {
    const tab = button(label, () => { section = id; detailId = null; viewGeneration++; draw(); }); tab.dataset.nav = id; nav.append(tab);
  }
  const bottom = el('div', 'sidebar-bottom'); bottom.append(el('span', 'user', user!.username), el('small', '', rayLogin ? 'Ray 工作区' : 'Reach · RY'), button(rayLogin ? '退出工作区' : '退出登录', async () => {
    if (rayLogin) { const form = el('form'); form.method = 'POST'; form.action = '/ray/logout'; document.body.append(form); form.submit(); return; }
    await api('/auth/logout', 'POST'); showLogin();
  }, 'ghost'));
  if (deskEnabled) { const deskLink = el('a', '', 'Reach Desk'); deskLink.href = 'desk/'; nav.append(deskLink); }
  side.append(nav, bottom);
  const workspace = el('div', 'workspace'); const bar = el('header', 'topbar'); bar.append(el('span', '', 'RAY / REACH'), el('span', '', '设备与运行管理'));
  content = el('main', 'content'); content.id = 'main'; workspace.append(bar, content); shell.append(side, workspace); app.append(shell); draw();
}
async function refresh() {
  if (!user) return;
  const epoch = generation; const sequence = ++refreshSequence;
  try {
    const snapshot = await api<{ nodes: Device[]; operations: OperationSummary[]; unresolvedCount: number }>('/overview');
    if (epoch !== generation || sequence !== refreshSequence) return;
    devices = snapshot.nodes; operations = snapshot.operations; unresolvedCount = snapshot.unresolvedCount; updatedAt = Date.now();
    if (!detailId) draw();
  } catch (error) { if (epoch === generation && sequence === refreshSequence) throw error; }
}
function heading(title: string, subtitle: string, ...actions: HTMLElement[]) {
  const row = el('div', 'heading'); const copy = el('div'); copy.append(el('h1', '', title), el('p', '', subtitle)); const controls = el('div', 'actions'); controls.append(...actions); row.append(copy, controls); return row;
}
function draw() {
  if (!content || !user) return;
  document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach(tab => { if (tab.dataset.nav === section) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current'); });
  content.replaceChildren(); notice = el('div', 'notice'); notice.setAttribute('role', 'status'); content.append(notice);
  const refreshed = updatedAt ? `最近刷新 ${time(updatedAt)}` : '尚未取得服务记录';
  content.append(heading(section === 'devices' ? '设备连接' : '操作记录', refreshed,
    button('刷新', refresh), ...(section === 'devices' ? [button('连接设备', openPairing, 'primary')] : [])));
  if (!updatedAt) return;
  if (section === 'devices') drawDevices(); else drawOperations();
}
function table(headers: string[]) { const panel = el('div', 'panel table-wrap'); const tab = el('table'); const thead = el('thead'); const row = el('tr'); headers.forEach(label => row.append(el('th', '', label))); thead.append(row); const tbody = el('tbody'); tab.append(thead, tbody); panel.append(tab); return { panel, tbody }; }
function empty(title: string, copy: string, action?: HTMLButtonElement) { const item = el('div', 'panel empty'); item.append(el('h2', '', title), el('p', '', copy)); if (action) item.append(action); return item; }
function drawDevices() {
  const metrics = el('div', 'metrics');
  for (const [label, count] of [['已配对设备', devices.filter(d => !d.revoked).length], ['在线', devices.filter(d => d.online && d.capabilities.length > 0).length], ['待核对操作', unresolvedCount]]) {
    const metric = el('div', 'metric'); metric.append(el('span', 'muted', String(label)), el('strong', '', String(count))); metrics.append(metric);
  }
  content!.append(metrics);
  if (!devices.length) { content!.append(empty('让第一台设备连过来', '生成一次性配对码，在已安装 Reach 的设备上运行配对命令。连接成功后，它会出现在这里。', button('生成配对码', openPairing, 'primary'))); return; }
  const { panel, tbody } = table(['设备', '连接状态', '版本 / 配对', '最近联系', '']);
  for (const device of devices) {
    const row = el('tr'); const name = el('td', 'name'); name.append(el('strong', '', device.name), el('small', 'mono', device.id), el('small', '', device.platform));
    const status = el('td'); status.append(badge(device.revoked ? 'revoked' : device.online && device.capabilities.length ? 'online' : 'offline', device.revoked ? '已解绑' : !device.capabilities.length ? '等待 Node 启动' : device.online ? '在线' : '离线'));
    const version = el('td'); version.append(el('span', '', device.version), el('small', '', `第 ${device.epoch} 次配对 · ${device.capabilities.length} 项能力`));
    const actions = el('td'); if (!device.revoked) actions.append(button('解绑', () => openUnpair(device), 'ghost danger'));
    row.append(name, status, version, el('td', 'time', time(device.last_seen)), actions); tbody.append(row);
  }
  content!.append(panel, el('p', 'muted section', '在线状态基于最近 30 秒的联系；页面展示最近一次刷新的结果。'));
}
function kind(op: Operation | OperationSummary) { if ('kind' in op) return op.kind; try { return String(JSON.parse(op.command_json).kind); } catch { return '未知操作'; } }
function deviceName(id: string) { return devices.find(d => d.id === id)?.name ?? id; }
function drawOperations() {
  const lookup = el('form', 'detail-input'); const input = el('input'); input.placeholder = '按原操作 ID 查找'; input.setAttribute('aria-label', '原操作 ID'); input.required = true;
  const go = el('button', '', '查看记录'); go.type = 'submit'; lookup.append(input, go); lookup.addEventListener('submit', event => { event.preventDefault(); void run(go, () => showDetail(input.value.trim())); }); content!.append(lookup);
  if (!operations.length) { content!.append(empty('还没有操作记录', '本地控制端发起调用后，可以在这里查看状态、原始回执和结果。')); return; }
  const { panel, tbody } = table(['操作', '设备', '执行状态', '发起时间']);
  for (const op of operations) {
    const row = el('tr'); const action = el('td', 'name'); action.append(button(kind(op), () => showDetail(op.id), 'link'), el('small', 'mono', op.id));
    const state = el('td'); state.append(badge(op.execution)); if (op.cancel_requested) state.append(el('small', '', '已请求取消'));
    row.append(action, el('td', 'name', deviceName(op.node_id)), state, el('td', 'time', time(op.created_at))); tbody.append(row);
  }
  content!.append(panel, el('p', 'muted section', '显示最近 200 条操作。更早的记录可通过原操作 ID 查回。'));
}
function modal(title: string) {
  const dialog = el('dialog'); const heading = el('h2', '', title); heading.id = 'dialog-title'; dialog.setAttribute('aria-labelledby', heading.id); dialog.append(heading); document.body.append(dialog);
  dialog.addEventListener('close', () => { dialog.remove(); }); return dialog;
}
async function openPairing() {
  if (document.querySelector('dialog')) return;
  const dialog = modal('连接一台设备'); const description = el('p', '', '在目标设备的终端运行下面的命令。配对后，这个账户即可完全控制设备。'); dialog.append(description);
  const status = el('p'); status.setAttribute('role', 'status'); dialog.append(status);
  const body = el('div'); dialog.append(body);
  const generate = button('生成配对码', async () => {
    const epoch = generation;
    try { const result = await api<{ code: string; expiresAt: number }>('/pairing-codes', 'POST'); if (epoch === generation && dialog.open) { pairing = result; renderCode(); } }
    catch (error) { if (dialog.open && !(error instanceof StaleRequest)) status.textContent = error instanceof Error ? error.message : '生成失败'; }
  }, 'primary');
  const renderCode = () => {
    body.replaceChildren();
    if (!pairing) { status.textContent = '配对码 10 分钟内有效，只能使用一次。'; return; }
    const development = location.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(location.hostname);
    const command = `reach pair --server ${new URL('../', import.meta.url).href.replace(/\/$/, '')} --code ${pairing.code}${development ? ' --development' : ''}`;
    status.textContent = `${Date.now() >= pairing.expiresAt ? '配对码已过期' : '有效期至'} ${time(pairing.expiresAt)}`;
    const code = el('pre', 'codebox', command); body.append(el('div', 'pair-code mono', pairing.code), code, el('p', '', '再次配对也使用这个命令，安装身份会保留。开发版需先停止前台 Node，配对后运行 reach run。'));
    body.append(button('复制命令', async () => { try { await navigator.clipboard.writeText(command); status.textContent = '命令已复制，到目标设备的终端运行。'; } catch { status.textContent = '未能访问剪贴板，请选中上面的命令复制。'; } }));
    generate.textContent = '生成新码';
  };
  const actions = el('div', 'actions'); actions.append(button('关闭', () => dialog.close(), 'ghost'), generate); dialog.append(actions); renderCode(); dialog.showModal();
  const timer = window.setInterval(() => { if (pairing && Date.now() >= pairing.expiresAt) status.textContent = '配对码已过期，请生成新码。'; }, 1000);
  dialog.addEventListener('close', () => { clearInterval(timer); pairing = null; });
}
function openUnpair(device: Device) {
  if (document.querySelector('dialog')) return;
  const dialog = modal('解绑设备'); dialog.append(el('p', '', `解绑「${device.name}」后，停止向这台设备投递新操作。正在执行的操作会收到取消请求；实际结果仍需核对，已发生的效果不会撤销。`));
  const status = el('p'); status.setAttribute('role', 'alert'); dialog.append(status);
  const actions = el('div', 'actions'); actions.append(button('保留连接', () => dialog.close()), button('解绑设备', async () => {
    const epoch = generation;
    try {
      await api(`/nodes/${encodeURIComponent(device.id)}/unpair`, 'POST'); dialog.close(); message('设备已解绑，正在刷新连接记录…');
      try { await refresh(); if (epoch === generation) message('设备已解绑，原操作记录保留。'); }
      catch (error) { if (epoch === generation && !(error instanceof StaleRequest)) message('设备已解绑，但刷新连接记录失败。列表可能已过时，请重新刷新。', true); }
    }
    catch (error) { if (dialog.open && !(error instanceof StaleRequest)) status.textContent = error instanceof Error ? error.message : '解绑未确认'; }
  }, 'danger')); dialog.append(actions); dialog.showModal();
}
function parsed(value: string | null): Json { if (value === null) return null; try { return JSON.parse(value) as Json; } catch { return value; } }
function evidence(title: string, value: Json, filename: string, preview?: string) {
  const box = el('div', 'section'); const header = el('div', 'section-title'); header.append(el('h3', '', title), button('下载原始内容', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const link = el('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }, 'ghost'));
  const text = preview ?? JSON.stringify(value, null, 2); box.append(header, el('pre', 'codebox', text.length > 16000 ? `${text.slice(0, 16000)}\n…预览已截断，下载可查看完整内容。` : text)); return box;
}
function outputPreview(data: Json): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.base64 !== 'string' || !['stdout', 'stderr'].includes(String(data.stream))) return;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(data.base64), value => value.charCodeAt(0))); }
  catch { return '此片段无法单独显示为 UTF-8 文本，请下载原始回执核对。'; }
}
async function showDetail(id: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error('请输入完整的操作 ID');
  const view = ++viewGeneration; const epoch = generation;
  const [op, reconciliations] = await Promise.all([api<Operation>(`/operations/${id}`), api<{ reconciliations: Json[] }>(`/operations/${id}/reconciliations`)]);
  if (epoch !== generation || view !== viewGeneration || !user) return;
  detailId = id; section = 'operations'; draw(); content!.replaceChildren(); notice = el('div', 'notice'); notice.setAttribute('role', 'status'); content!.append(notice);
  content!.append(button('← 返回操作记录', () => { detailId = null; viewGeneration++; draw(); }, 'ghost back'));
  const actions = [button('刷新记录', () => showDetail(id))];
  if (!terminal.has(op.execution) && !op.cancel_requested) actions.push(button('请求取消', async () => { await api(`/operations/${id}/cancel`, 'POST'); if (view === viewGeneration) { await showDetail(id); if (epoch === generation && detailId === id) message('已提交取消请求。请根据回执核对实际停止状态；已有的效果不会撤销。'); } }, 'danger'));
  content!.append(heading(kind(op), `设备：${deviceName(op.node_id)}`, ...actions));
  const panel = el('div', 'panel'); const list = el('dl', 'details');
  for (const [label, value] of [['操作 ID', op.id], ['请求 ID', op.request_id], ['执行状态', stateNames[op.execution] ?? op.execution], ['投递状态', stateNames[op.delivery] ?? op.delivery], ['取消请求', op.cancel_requested ? '已请求（不代表已停止）' : '未请求'], ['发起时间', time(op.created_at)], ['最近更新', time(op.updated_at)]]) { list.append(el('dt', '', label), el('dd', label.endsWith('ID') ? 'mono' : '', value)); }
  panel.append(list); content!.append(panel);
  if (op.execution === 'unknown' || (op.delivery === 'uncertain' && !terminal.has(op.execution))) content!.append(el('p', 'notice section', '原操作的实际结果尚未确定。请结合现场和原始证据核对；Reach 不会重新执行这个操作。'));
  const artifactsPanel = el('section', 'panel section'); content!.append(artifactsPanel);
  void showArtifacts(artifactsPanel, id, () => epoch === generation && view === viewGeneration && detailId === id && !!user);
  content!.append(evidence('原始请求', parsed(op.command_json), `${id}-request.json`));
  if (op.result_json !== null) content!.append(evidence('结果记录', parsed(op.result_json), `${id}-result.json`));
  if (reconciliations.reconciliations.length) content!.append(evidence('独立对账记录', reconciliations.reconciliations, `${id}-reconciliations.json`));
  const eventsPanel = el('section', 'panel section'); const head = el('div', 'panel-head'); head.append(el('h2', '', '原始回执'), el('small', '', '按服务接收顺序 · 不触发重执行'));
  const events = el('div'); const pageStatus = el('span', 'muted'); let after = 0;
  const more = button('读取回执', async () => {
    const page = await api<Page>(`/operations/${id}/events?after=${after}&limit=20`);
    if (epoch !== generation || view !== viewGeneration) return;
    events.replaceChildren();
    for (const event of page.events) {
      const item = el('article', 'event'); const label = el('div', 'event-head'); label.append(el('strong', '', `#${event.sequence} · ${stateNames[event.kind] ?? event.kind}`), el('small', '', time(event.received_at)));
      const preview = outputPreview(event.data);
      item.append(label, el('small', 'mono', event.event_id), evidence(preview === undefined ? '回执内容' : '输出片段', event.data, `${id}-event-${event.sequence}.json`, preview)); events.append(item);
    }
    if (!page.events.length) events.append(el('p', 'event muted', '尚无新回执。可刷新记录继续查询。'));
    const start = page.events[0]?.sequence; after = page.nextAfter;
    pageStatus.textContent = start === undefined ? '0 条回执' : `当前 #${start}–${after}${page.hasMore ? ' · 后面还有' : ' · 已读至当前末尾'}`;
    more.textContent = page.hasMore ? '下一页回执' : '查询新回执';
  });
  const controls = el('div', 'page-actions'); controls.append(more, pageStatus); eventsPanel.append(head, events, controls); content!.append(eventsPanel); more.click();
}
async function showArtifacts(panel: HTMLElement, id: string, current: () => boolean) {
  const head = el('div', 'panel-head'); head.append(el('h2', '', '原始产物'), el('small', '', '从这次操作取回 · 不会重新执行'));
  const state = el('p', 'event muted', '正在读取产物清单…'); state.setAttribute('role', 'status'); panel.append(head, state);
  try {
    const list = parseArtifacts(await api(`/operations/${id}/artifacts`), id);
    if (!current()) return;
    state.remove();
    if (!list.artifacts.length) { panel.append(el('p', 'event muted', '这次操作尚无独立产物。文字输出可在下方原始回执中查看。')); return; }
    for (const artifact of list.artifacts) {
      const item = el('article', 'event');
      const title = el('div', 'event-head');
      const name = artifact.mimeType === 'text/plain' ? '原始文本' : artifact.mimeType === 'image/png' ? '原始图片' : '原始文件';
      title.append(el('strong', '', `${name} · ${artifact.contentIndex + 1}`), badge(artifact.complete ? 'succeeded' : 'unknown', artifact.complete ? '传输完成' : '未完整收到'));
      const metadata = `${artifact.mimeType} · ${artifact.byteLength.toLocaleString()} 字节${artifact.characterCount === undefined ? '' : ` · ${artifact.characterCount.toLocaleString()} 字符`}`;
      const status = el('p', 'muted'); status.setAttribute('role', 'status');
      const actions = el('div', 'actions section'); const preview = el('pre', 'codebox section'); preview.hidden = true;
      item.append(title, el('p', 'muted', metadata), el('small', 'mono', artifact.artifactId));
      if (!artifact.complete) item.append(el('p', 'muted', '可刷新核对接收状态；操作结束后，缺失内容可能无法补齐。原操作不会重跑。'));
      else {
        const request = (path: string) => api(path);
        // Errors and downloads belong to this exact detail view, including refresh/logout races.
        const action = (label: string, task: () => Promise<void>) => button(label, async () => {
          if (!current()) return;
          try { await task(); } catch (error) { if (current()) { status.textContent = error instanceof Error ? error.message : '读取未完成，请重新打开记录'; status.setAttribute('role', 'alert'); } }
        });
        if (artifact.mimeType === 'text/plain') {
          let reader: ArtifactReader | null = null;
          const next = action('预览文本', async () => {
            status.setAttribute('role', 'status'); status.textContent = '正在读取原始文本…';
            reader ??= new ArtifactReader(request, list.binding, artifact, current);
            try {
              const page = await reader.next(); if (!current()) return;
              preview.hidden = false; preview.textContent = page.text || (artifact.byteLength === 0 ? '（空文本）' : '（此段字符将在下一段接续显示）');
              status.textContent = `${page.offset.toLocaleString()}–${page.nextOffset.toLocaleString()} / ${artifact.byteLength.toLocaleString()} 字节 · ${page.eof ? '全文校验通过' : '分段校验通过；跨段字符接续显示'}`;
              next.textContent = page.eof ? '重新预览' : '下一段文本'; if (page.eof) reader = null;
            } catch (error) { reader = null; next.textContent = '重新预览'; throw error; }
          }); actions.append(next);
        }
        actions.append(action('下载原始文件', async () => {
          status.setAttribute('role', 'status'); status.textContent = '正在取回并核验完整文件…';
          const bytes = await new ArtifactReader(request, list.binding, artifact, current).download();
          if (!current()) return;
          const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: artifact.mimeType }));
          const link = el('a'); link.href = url; link.download = `${id}-${artifact.artifactId}.${artifact.mimeType === 'text/plain' ? 'txt' : artifact.mimeType === 'image/png' ? 'png' : 'bin'}`;
          link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
          status.textContent = '完整性校验通过，已交给浏览器下载。';
        }));
        item.append(actions, preview, status);
      }
      panel.append(item);
    }
  } catch (error) { if (current()) { state.textContent = error instanceof Error ? error.message : '产物清单读取失败，请刷新记录'; state.setAttribute('role', 'alert'); } }
}
async function start() {
  try { user = await api<User>('/auth/me'); }
  catch (error) { if (!(error instanceof StaleRequest)) showLogin(error instanceof Error && error.message !== '请先登录 Reach' ? error.message : ''); return; }
  showShell();
  try { await refresh(); } catch (error) { if (!(error instanceof StaleRequest)) message(error instanceof Error ? error.message : '读取失败，请刷新', true); }
}
window.addEventListener('pageshow', event => {
  if (event.persisted) {
    clearSession(); const loading = el('main', 'loading', '正在恢复 Reach 连接…'); loading.id = 'main'; app.replaceChildren(loading); notice = null; content = null;
    void start();
  }
});
void start();
