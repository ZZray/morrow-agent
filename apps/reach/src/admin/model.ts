// Copyright (c) Ray Zhang. Reach console view model: routes, status wording, filters and web-submitted commands. No DOM access.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface DesiredConfig { requestId: string; targetVersion: number; heartbeatIntervalSeconds: number; status: 'pending' | 'applied' | 'rejected'; createdAt: number; settledAt: number | null; receipt: Json }
export interface SshStatus { ready: boolean; port?: number; user?: string; hostKey?: string; error?: string | null }
export interface Device {
  id: string; name: string; platform: string; version: string; epoch: number; last_seen: number | null; revoked: number; capabilities: string[]; online: boolean;
  lastHeartbeatAt?: number | null; residentState?: string; effectiveHeartbeatSeconds?: number; effectiveConfigVersion?: number; desiredConfig?: DesiredConfig | null; sshStatus?: SshStatus | null;
}
export interface OperationSummary { id: string; node_id: string; request_id: string; kind: string; delivery: string; execution: string; cancel_requested: number; created_at: number; updated_at: number }
export interface DeviceEvent { sequence: number; nodeId: string; nodeName: string; epoch: number; kind: 'first_online' | 'reconnected'; offlineSince: number | null; at: number; read: boolean }

// ---------- 路由：hash 路由，刷新详情仍能回到原处，不依赖服务端回退 ----------
export type Route =
  | { page: 'devices' } | { page: 'device'; id: string }
  | { page: 'operations' } | { page: 'operation'; id: string }
  | { page: 'stats' } | { page: 'downloads' } | { page: 'mcp' } | { page: 'settings' } | { page: 'desk'; id: string | null };
export const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function parseRoute(hash: string): Route {
  const [, page = '', id = ''] = hash.replace(/^#/, '').split('/');
  if (page === 'devices' && uuidPattern.test(id)) return { page: 'device', id: id.toLowerCase() };
  if (page === 'operations' && uuidPattern.test(id)) return { page: 'operation', id: id.toLowerCase() };
  if (page === 'operations' && !id) return { page: 'operations' };
  if (page === 'stats' && !id) return { page: 'stats' };
  if (page === 'downloads' && !id) return { page: 'downloads' };
  if (page === 'mcp' && !id) return { page: 'mcp' };
  if (page === 'settings' && !id) return { page: 'settings' };
  if (page === 'desk') return { page: 'desk', id: uuidPattern.test(id) ? id.toLowerCase() : null };
  return { page: 'devices' };
}
export function routeHash(route: Route): string {
  switch (route.page) {
    case 'device': return `#/devices/${route.id}`;
    case 'operation': return `#/operations/${route.id}`;
    case 'desk': return route.id ? `#/desk/${route.id}` : '#/desk';
    default: return `#/${route.page}`;
  }
}
export function navSection(route: Route): 'devices' | 'operations' | 'stats' | 'downloads' | 'mcp' | 'settings' | 'desk' {
  return route.page === 'device' ? 'devices' : route.page === 'operation' ? 'operations' : route.page;
}

// ---------- 状态口径 ----------
export type Tone = 'ok' | 'run' | 'warn' | 'bad' | 'muted';
export type DeviceState = 'online' | 'offline' | 'waiting' | 'revoked';
// 配对本身会写 last_seen；未上报能力前一律算「等 Node 上线」，不算在线。
export function deviceState(device: Device): DeviceState {
  if (device.revoked) return 'revoked';
  if (!device.capabilities.length) return 'waiting';
  return device.online ? 'online' : 'offline';
}
export const deviceStateLabel: Record<DeviceState, string> = { online: '在线', offline: '离线', waiting: '等 Node 上线', revoked: '已解绑' };
export const deviceStateTone: Record<DeviceState, Tone> = { online: 'ok', offline: 'muted', waiting: 'warn', revoked: 'muted' };
export const residentLabel: Record<string, string> = { connecting: '正在连接', connected: '已连接', offline_backoff: '离线，按退避重连', auth_or_config_error: '认证或配置错误' };

export const stateNames: Record<string, string> = { not_observed: '尚未观察到执行', received: '设备已接收', running: '执行中', succeeded: '已成功', failed: '已失败', cancelled: '已取消', unknown: '结果未知', output: '输出', queued: '待投递', claimed: '已投递', uncertain: '投递待核对', acknowledged: '设备已确认' };
export const terminalStates = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);
export function stateTone(state: string): Tone {
  if (state === 'succeeded' || state === 'acknowledged') return 'ok';
  if (state === 'running' || state === 'received' || state === 'claimed') return 'run';
  if (state === 'unknown' || state === 'uncertain') return 'warn';
  if (state === 'failed') return 'bad';
  return 'muted';
}
export function needsAttention(op: Pick<OperationSummary, 'execution' | 'delivery'>) {
  return op.execution === 'unknown' || (op.delivery === 'uncertain' && !terminalStates.has(op.execution));
}
export function isActive(op: Pick<OperationSummary, 'execution' | 'delivery'>) {
  return !terminalStates.has(op.execution) && op.delivery !== 'cancelled';
}

// ---------- 筛选与搜索 ----------
export type DeviceFilter = 'all' | DeviceState;
export function filterDevices(devices: Device[], filter: DeviceFilter, query: string): Device[] {
  const needle = query.trim().toLowerCase();
  return devices.filter(device => (filter === 'all' || deviceState(device) === filter)
    && (!needle || [device.name, device.id, device.platform, device.version].some(value => value.toLowerCase().includes(needle))));
}
export type OperationFilter = 'all' | 'active' | 'attention' | 'done';
export function filterOperations(operations: OperationSummary[], filter: OperationFilter, query: string, deviceName: (id: string) => string): OperationSummary[] {
  const needle = query.trim().toLowerCase();
  return operations.filter(op => (filter === 'all'
      || (filter === 'active' && isActive(op))
      || (filter === 'attention' && needsAttention(op))
      || (filter === 'done' && terminalStates.has(op.execution) && !needsAttention(op)))
    && (!needle || [op.id, op.request_id, op.kind, kindLabel(op.kind), deviceName(op.node_id)].some(value => value.toLowerCase().includes(needle))));
}

// ---------- 时间文案：今天 14:00 / 昨天 09:12 / 11月3日 14:00 ----------
export function formatTime(value: number | null, now = Date.now()): string {
  if (value === null || !value) return '尚无记录';
  const date = new Date(value), today = new Date(now);
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(today) - dayStart(date)) / 86_400_000);
  if (days === 0) return `今天 ${hm}`;
  if (days === 1) return `昨天 ${hm}`;
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
}
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟`;
  if (s < 86_400) return `${Math.round(s / 360) / 10} 小时`;
  return `${Math.round(s / 8640) / 10} 天`;
}
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

// ---------- 心跳：「已请求」与「已生效」分开显示 ----------
export const configStatusLabel: Record<DesiredConfig['status'], string> = { pending: '等设备确认', applied: '已生效', rejected: '设备未采用' };
export function heartbeatView(device: Device) {
  const desired = device.desiredConfig ?? null;
  const receiptError = desired && desired.receipt && typeof desired.receipt === 'object' && !Array.isArray(desired.receipt)
    ? (typeof desired.receipt.error === 'string' ? desired.receipt.error : desired.receipt.reason === 'superseded_by_newer_version' ? '已被更新的请求取代' : null)
    : null;
  return {
    effectiveSeconds: device.effectiveHeartbeatSeconds ?? null,
    effectiveVersion: device.effectiveConfigVersion ?? 0,
    lastHeartbeatAt: device.lastHeartbeatAt ?? null,
    requested: desired ? { seconds: desired.heartbeatIntervalSeconds, status: desired.status, label: configStatusLabel[desired.status], requestId: desired.requestId, version: desired.targetVersion, error: receiptError } : null,
  };
}
export function parseHeartbeatSeconds(input: string): number {
  const value = Number(input.trim());
  if (!Number.isInteger(value) || value < 30 || value > 3600) throw new Error('心跳间隔需为 30–3600 之间的整数秒');
  return value;
}

// ---------- 网页发起操作：只开放现有合同覆盖、表单能完整表达的命令 ----------
export const webKinds = ['command.run', 'directory.list', 'file.read', 'file.write', 'desktop.describe', 'ssh.status'] as const;
export type WebKind = typeof webKinds[number];
const kindNames: Record<string, string> = {
  'command.run': '运行命令', 'directory.list': '列出目录', 'file.read': '读取文件', 'file.write': '写入文件', 'desktop.describe': '查看桌面', 'desktop.call': '桌面操作',
  'ssh.status': 'SSH 状态', 'ssh.authorize': '授权 SSH 公钥', 'ssh.revoke': '撤销 SSH 公钥', 'starferry.session': 'Starferry 通道',
  'agent.delegate': '委托现场 Agent', 'agent.resume': '恢复 Agent', 'agent.continue': '继续 Agent', 'agent.inspect': '检查 Agent', 'agent.provenance': '查询 Agent 来源', 'agent.finalize': '结算 Agent',
};
export function kindLabel(kind: string) { return kindNames[kind] ?? kind; }
// 操作类型对应的图标名：同一类动作用同一个图形，未知类型回落到通用终端。
export function kindIcon(kind: string): string {
  if (kind === 'command.run') return 'terminal';
  if (kind === 'directory.list') return 'folder';
  if (kind === 'file.read') return 'file';
  if (kind === 'file.write') return 'file-edit';
  if (kind.startsWith('desktop.')) return 'screen';
  if (kind.startsWith('ssh.') || kind === 'starferry.session') return 'lock';
  if (kind.startsWith('agent.')) return 'sparkle';
  if (kind.startsWith('config.') || kind.startsWith('node.')) return 'pulse';
  return 'terminal';
}
export function availableKinds(capabilities: string[]): WebKind[] { return webKinds.filter(kind => capabilities.includes(kind)); }

const MAX_WRITE_BYTES = 1_048_576;
function required(fields: Record<string, string>, name: string, label: string) {
  const value = (fields[name] ?? '').trim();
  if (!value) throw new Error(`请填写${label}`);
  if (value.includes('\0')) throw new Error(`${label}不能包含 NUL 字符`);
  return value;
}
function seconds(fields: Record<string, string>, name: string, fallback: number) {
  const raw = (fields[name] ?? '').trim();
  if (!raw) return fallback * 1000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 3600) throw new Error('超时需为 1–3600 之间的整数秒');
  return value * 1000;
}
function base64(bytes: Uint8Array) {
  let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
export function buildCommand(kind: WebKind, fields: Record<string, string>, capabilities: string[]): Record<string, Json> {
  switch (kind) {
    case 'command.run': {
      const cwd = (fields.cwd ?? '').trim();
      return { kind, command: required(fields, 'command', '命令'), ...(cwd ? { cwd } : {}), timeoutMs: seconds(fields, 'timeout', 60) };
    }
    case 'directory.list': return { kind, path: required(fields, 'path', '目录路径') };
    case 'file.read': {
      const length = (fields.length ?? '').trim() ? Number(fields.length) : 65536;
      if (!Number.isInteger(length) || length < 1 || length > 1_048_576) throw new Error('读取长度需为 1–1048576 字节');
      return { kind, path: required(fields, 'path', '文件路径'), offset: 0, length, ...(capabilities.includes('file.read.artifact') ? { resultFormat: 'artifact' } : {}) };
    }
    case 'file.write': {
      const bytes = new TextEncoder().encode(fields.content ?? '');
      if (bytes.length > MAX_WRITE_BYTES) throw new Error('网页写入内容不能超过 1 MiB');
      return { kind, path: required(fields, 'path', '文件路径'), contentBase64: base64(bytes) };
    }
    case 'desktop.describe': return { kind, timeoutMs: seconds(fields, 'timeout', 60) };
    case 'ssh.status': return { kind };
  }
}
// 命令摘要：列表与确认里显示「做了什么」，不展示 base64 等原始载荷。
export function commandSummary(command: Json): string {
  if (!command || typeof command !== 'object' || Array.isArray(command)) return '未知操作';
  const kind = String(command.kind ?? '');
  const target = typeof command.command === 'string' ? command.command : typeof command.path === 'string' ? command.path : '';
  return target ? `${kindLabel(kind)} · ${target.length > 120 ? `${target.slice(0, 120)}…` : target}` : kindLabel(kind);
}

// ---------- 上线通知 ----------
export function mergeEvents(existing: DeviceEvent[], incoming: DeviceEvent[], cap = 200): DeviceEvent[] {
  const bySequence = new Map(existing.map(event => [event.sequence, event]));
  for (const event of incoming) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence).slice(-cap);
}
export function eventTitle(event: DeviceEvent): string {
  if (event.kind === 'reconnected') return `${event.nodeName} 恢复连接`;
  return event.epoch > 1 ? `${event.nodeName} 重新配对后上线` : `${event.nodeName} 首次上线`;
}
export function eventDetail(event: DeviceEvent, now = Date.now()): string {
  const when = formatTime(event.at, now);
  if (event.kind === 'reconnected' && event.offlineSince) return `${when} · 此前离线约 ${formatDuration(event.at - event.offlineSince)}`;
  return `${when} · 设备首次上报能力`;
}

// ---------- 配对命令：服务地址末尾无斜杠，与 Node 配置口径一致 ----------
export function serverBase(pageUrl: string): string { return new URL('./', pageUrl).href.replace(/\/$/, ''); }
export function pairCommand(server: string, code: string, development: boolean) {
  return `ryreach pair ${code} --server ${server}${development ? ' --development' : ''}`;
}

// ---------- 操作进度：投递、设备接收、执行、执行结果分开显示 ----------
export interface TrackStep { label: string; value: string; tone: Tone }
export function operationTrack(op: Pick<OperationSummary, 'delivery' | 'execution' | 'cancel_requested'>): TrackStep[] {
  const delivery: Record<string, [string, Tone]> = { queued: ['待投递', 'muted'], claimed: ['已投递', 'run'], acknowledged: ['设备已确认', 'ok'], uncertain: ['投递待核对', 'warn'], cancelled: ['已撤回投递', 'muted'] };
  const received = op.execution !== 'not_observed';
  const finished = terminalStates.has(op.execution);
  const [deliveryText, deliveryTone] = delivery[op.delivery] ?? [op.delivery, 'muted'];
  return [
    { label: '投递', value: deliveryText, tone: deliveryTone },
    { label: '设备接收', value: received ? '已接收' : '尚未观察到', tone: received ? 'ok' : 'muted' },
    { label: '执行', value: op.execution === 'running' ? '执行中' : finished ? '已结束' : received ? '准备执行' : '未开始', tone: op.execution === 'running' ? 'run' : finished ? 'ok' : 'muted' },
    { label: '执行结果', value: finished ? stateNames[op.execution] ?? op.execution : op.cancel_requested ? '已请求取消，等设备回执' : '等待结果', tone: finished ? stateTone(op.execution) : op.cancel_requested ? 'warn' : 'muted' },
  ];
}

// ---------- 以原操作为模板新建：把原请求映射回表单字段（新操作会用新的请求 ID） ----------
export function commandToFields(command: Json): { kind: WebKind; fields: Record<string, string> } | null {
  if (!command || typeof command !== 'object' || Array.isArray(command)) return null;
  const kind = String(command.kind) as WebKind;
  const text = (v: Json | undefined) => typeof v === 'string' ? v : '';
  const secs = (v: Json | undefined) => typeof v === 'number' ? String(Math.round(v / 1000)) : '';
  switch (kind) {
    case 'command.run': return { kind, fields: { command: text(command.command), cwd: text(command.cwd), timeout: secs(command.timeoutMs) } };
    case 'directory.list': return { kind, fields: { path: text(command.path) } };
    case 'file.read': return { kind, fields: { path: text(command.path), length: typeof command.length === 'number' ? String(command.length) : '' } };
    case 'file.write': {
      let content = '';
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(text(command.contentBase64)), c => c.charCodeAt(0))); } catch { return null; }
      return { kind, fields: { path: text(command.path), content } };
    }
    case 'desktop.describe': return { kind, fields: { timeout: secs(command.timeoutMs) } };
    case 'ssh.status': return { kind, fields: {} };
    default: return null;
  }
}

// ---------- 统计口径 ----------
export function shortDate(isoDate: string) { const [, m, d] = isoDate.split('-'); return `${Number(m)}/${Number(d)}`; }
export function longDate(isoDate: string) { const [, m, d] = isoDate.split('-'); return `${Number(m)}月${Number(d)}日`; }
export function percent(value: number | null) { return value === null ? '—' : `${Math.round(value * 1000) / 10}%`; }
export function formatMs(ms: number | null) {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} 毫秒`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} 秒`;
  return formatDuration(ms);
}

// ---------- 模型设置：把保存、测试、启用、运行四层状态收成一句话 ----------
export interface ModelSettingView {
  purpose: 'desk' | 'agent';
  saved: { endpoint: string; model: string; contextWindow?: number; maxOutput?: number; imageInput?: boolean; providerId: string | null; providerName: string | null; tokenConfigured: boolean; generation: number; source: string; savedAt: number } | null;
  test: { generation: number; ok: boolean; at: number; message: string; latencyMs: number } | null;
  enabled: { endpoint: string; model: string; generation: number; enabledAt: number } | null;
  running: { generation: number | null; source: 'settings' | 'environment'; endpoint: string; model: string; error?: string } | null;
  restartRequired: boolean;
}
export function modelSettingState(view: ModelSettingView): { label: string; tone: Tone } {
  const { saved, test, enabled, running } = view;
  if (!saved) return { label: '未配置', tone: 'muted' };
  if (running?.error) return { label: '启用的配置未能生效', tone: 'bad' };
  const testedDraft = test?.generation === saved.generation ? test : null;
  if (enabled && saved.generation !== enabled.generation) return testedDraft?.ok ? { label: '修改已测试，待启用', tone: 'run' } : testedDraft ? { label: '修改未通过测试', tone: 'bad' } : { label: '有修改，待测试', tone: 'warn' };
  if (enabled && view.restartRequired) return { label: '已启用，未在运行', tone: 'warn' };
  if (enabled) return { label: '运行中', tone: 'ok' };
  if (testedDraft?.ok) return { label: '测试通过，待启用', tone: 'run' };
  if (testedDraft) return { label: '测试未通过', tone: 'bad' };
  return { label: '已保存，待测试', tone: 'muted' };
}
export interface ProviderModel { id: string; imageInput: boolean; contextWindow: number; maxOutput: number }
export interface ModelProvider { id: string; name: string; baseUrl: string; tokenConfigured: boolean; models: ProviderModel[]; modelsFetchedAt: number | null; updatedAt: number }
// 1000000 → 1M，131072 → 128K；用于上下文与输出上限的简写。
export function formatTokens(value: number) {
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1024 && value % 1024 === 0) return `${value / 1024}K`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}
// 启用只针对当前草稿，且须本代测试通过、尚未启用。
export function canEnableModel(view: ModelSettingView) {
  return !!view.saved && view.test?.generation === view.saved.generation && view.test.ok && view.enabled?.generation !== view.saved.generation;
}
