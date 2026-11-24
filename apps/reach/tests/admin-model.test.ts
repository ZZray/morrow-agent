// Copyright (c) Ray Zhang. Console view model: routes, status wording, filters and web-submitted commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../src/admin/model.ts';
import { normalizeAccent, normalizeTheme, onAccent } from '../src/admin/theme.ts';
import { commandSchema } from '../src/contracts/protocol.ts';

const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
function device(patch: Partial<M.Device> = {}): M.Device {
  return { id, name: 'Lab-PC', platform: 'windows', version: '0.1.0', epoch: 1, last_seen: 1, revoked: 0, capabilities: ['command.run'], online: true, ...patch };
}

test('hash routes round-trip and fall back to the device list', () => {
  for (const route of [{ page: 'devices' }, { page: 'device', id }, { page: 'operations' }, { page: 'operation', id }, { page: 'stats' }, { page: 'downloads' }, { page: 'mcp' }] as M.Route[]) {
    assert.deepEqual(M.parseRoute(M.routeHash(route)), route);
  }
  assert.deepEqual(M.parseRoute(`#/devices/${id.toUpperCase()}`), { page: 'device', id });
  for (const hash of ['', '#', '#/unknown', '#/devices/not-a-uuid', '#/downloads/x']) assert.deepEqual(M.parseRoute(hash), { page: 'devices' });
  assert.equal(M.navSection({ page: 'operation', id }), 'operations');
});

test('pairing alone is not online: devices wait for a real capability report', () => {
  assert.equal(M.deviceState(device({ capabilities: [], online: true })), 'waiting');
  assert.equal(M.deviceState(device()), 'online');
  assert.equal(M.deviceState(device({ online: false })), 'offline');
  assert.equal(M.deviceState(device({ revoked: 1 })), 'revoked');
  const list = [device(), device({ id: 'b', name: 'Spare', online: false }), device({ id: 'c', name: 'New', capabilities: [] })];
  assert.deepEqual(M.filterDevices(list, 'offline', '').map(d => d.name), ['Spare']);
  assert.deepEqual(M.filterDevices(list, 'all', 'lab').map(d => d.name), ['Lab-PC']);
  assert.deepEqual(M.filterDevices(list, 'waiting', ' NEW ').map(d => d.name), ['New']);
});

test('operation filters keep unknown results under attention, not done', () => {
  const op = (execution: string, delivery = 'acknowledged'): M.OperationSummary => ({ id: `${execution}-${delivery}`, node_id: id, request_id: 'r', kind: 'command.run', delivery, execution, cancel_requested: 0, created_at: 1, updated_at: 1 });
  const ops = [op('running', 'claimed'), op('succeeded'), op('unknown'), op('not_observed', 'uncertain'), op('cancelled', 'cancelled')];
  assert.deepEqual(M.filterOperations(ops, 'attention', '', () => '').map(o => o.id), ['unknown-acknowledged', 'not_observed-uncertain']);
  assert.deepEqual(M.filterOperations(ops, 'done', '', () => '').map(o => o.id), ['succeeded-acknowledged', 'cancelled-cancelled']);
  assert.deepEqual(M.filterOperations(ops, 'active', '', () => '').map(o => o.id), ['running-claimed', 'not_observed-uncertain']);
  assert.equal(M.filterOperations(ops, 'all', '运行命令', () => '').length, 5);
  assert.equal(M.filterOperations(ops, 'all', 'lab', () => 'Lab-PC').length, 5);
  const track = M.operationTrack({ delivery: 'claimed', execution: 'not_observed', cancel_requested: 1 });
  assert.deepEqual(track.map(s => s.value), ['已投递', '尚未观察到', '未开始', '已请求取消，等设备回执']);
  assert.equal(M.operationTrack({ delivery: 'acknowledged', execution: 'unknown', cancel_requested: 0 })[3].tone, 'warn');
});

test('web commands pass the real protocol schema and reject invalid input before submit', () => {
  const caps = ['command.run', 'directory.list', 'file.read', 'file.read.artifact', 'file.write', 'desktop.describe', 'ssh.status', 'agent.delegate'];
  assert.deepEqual(M.availableKinds(caps), ['command.run', 'directory.list', 'file.read', 'file.write', 'desktop.describe', 'ssh.status']);
  const samples: [M.WebKind, Record<string, string>][] = [
    ['command.run', { command: 'hostname', cwd: '', timeout: '30' }], ['directory.list', { path: 'C:\\' }], ['file.read', { path: 'C:\\a.txt' }],
    ['file.write', { path: 'C:\\a.txt', content: '你好 Reach' }], ['desktop.describe', {}], ['ssh.status', {}],
  ];
  for (const [kind, fields] of samples) assert.ok(commandSchema.safeParse(M.buildCommand(kind, fields, caps)).success, kind);
  assert.deepEqual(M.buildCommand('command.run', { command: 'hostname', timeout: '30' }, caps), { kind: 'command.run', command: 'hostname', timeoutMs: 30000 });
  assert.equal(M.buildCommand('file.read', { path: 'a' }, caps).resultFormat, 'artifact');
  assert.equal(M.buildCommand('file.read', { path: 'a' }, ['file.read']).resultFormat, undefined, '未声明产物能力时不请求产物格式');
  const written = M.buildCommand('file.write', { path: 'a', content: '你好 Reach' }, caps);
  assert.equal(Buffer.from(String(written.contentBase64), 'base64').toString('utf8'), '你好 Reach');
  assert.throws(() => M.buildCommand('command.run', { command: '  ' }, caps), /请填写命令/);
  assert.throws(() => M.buildCommand('command.run', { command: 'x', timeout: '0' }, caps), /超时/);
  assert.throws(() => M.buildCommand('file.read', { path: 'a', length: '2000000' }, caps), /读取长度/);
  assert.throws(() => M.buildCommand('file.write', { path: 'a', content: 'x'.repeat(1_048_577) }, caps), /1 MiB/);
  assert.equal(M.commandSummary({ kind: 'file.write', path: 'C:\\a.txt', contentBase64: 'AAAA' }), '写入文件 · C:\\a.txt');
});

test('heartbeat shows requested and effective separately', () => {
  const view = M.heartbeatView(device({ effectiveHeartbeatSeconds: 60, effectiveConfigVersion: 2, lastHeartbeatAt: 5, desiredConfig: { requestId: id, targetVersion: 3, heartbeatIntervalSeconds: 300, status: 'rejected', createdAt: 1, settledAt: 2, receipt: { error: 'interval rejected' } } }));
  assert.equal(view.effectiveSeconds, 60); assert.equal(view.requested?.seconds, 300); assert.equal(view.requested?.label, '设备未采用'); assert.equal(view.requested?.error, 'interval rejected');
  assert.equal(M.heartbeatView(device()).requested, null);
  assert.equal(M.parseHeartbeatSeconds(' 120 '), 120);
  for (const bad of ['29', '3601', '1.5', 'abc']) assert.throws(() => M.parseHeartbeatSeconds(bad));
});

test('time wording, notifications merge and pairing command', () => {
  const now = new Date(2026, 10, 24, 15, 0).getTime();
  assert.equal(M.formatTime(new Date(2026, 10, 24, 9, 5).getTime(), now), '今天 09:05');
  assert.equal(M.formatTime(new Date(2026, 10, 23, 23, 0).getTime(), now), '昨天 23:00');
  assert.equal(M.formatTime(new Date(2026, 2, 3, 8, 0).getTime(), now), '3月3日 08:00');
  assert.equal(M.formatTime(new Date(2025, 2, 3, 8, 0).getTime(), now), '2025年3月3日 08:00');
  assert.equal(M.formatTime(null, now), '尚无记录');
  const event = (sequence: number, patch: Partial<M.DeviceEvent> = {}): M.DeviceEvent => ({ sequence, nodeId: id, nodeName: 'Lab-PC', epoch: 1, kind: 'first_online', offlineSince: null, at: now, read: false, ...patch });
  assert.deepEqual(M.mergeEvents([event(2), event(1)], [event(2, { read: true }), event(3)]).map(e => [e.sequence, e.read]), [[1, false], [2, true], [3, false]]);
  assert.equal(M.mergeEvents([], [event(1), event(2), event(3)], 2).length, 2);
  assert.equal(M.eventTitle(event(1)), 'Lab-PC 首次上线');
  assert.equal(M.eventTitle(event(1, { epoch: 2 })), 'Lab-PC 重新配对后上线');
  assert.match(M.eventDetail(event(1, { kind: 'reconnected', offlineSince: now - 600_000 }), now), /离线约 10 分钟/);
  assert.equal(M.serverBase('https://nmrkit.ciqtek.com/reach/#/devices'), 'https://nmrkit.ciqtek.com/reach');
  assert.equal(M.serverBase('http://127.0.0.1:18910/'), 'http://127.0.0.1:18910');
  assert.equal(M.pairCommand('https://nmrkit.ciqtek.com/reach', 'ABCD-1234', false), 'ryreach pair ABCD-1234 --server https://nmrkit.ciqtek.com/reach');
});

test('appearance preferences only accept known values', () => {
  assert.equal(normalizeAccent('#ABCDEF'), '#abcdef');
  for (const bad of ['red', '#abc', 'url(x)', null]) assert.equal(normalizeAccent(bad), null);
  assert.equal(onAccent('#f6d454'), '#1f1f22'); assert.equal(onAccent('#2a2a8a'), '#ffffff');
  assert.equal(normalizeTheme('dark'), 'dark'); assert.equal(normalizeTheme('light'), 'light'); assert.equal(normalizeTheme('neon'), 'system');
});

test('an original command maps back into the web form for a new operation', () => {
  const caps = ['command.run', 'file.write', 'file.read', 'file.read.artifact'];
  for (const [kind, fields] of [['command.run', { command: 'hostname', cwd: 'C:\\', timeout: '30' }], ['file.write', { path: 'a.txt', content: '你好' }], ['file.read', { path: 'a', length: '100' }]] as [M.WebKind, Record<string, string>][]) {
    const built = M.buildCommand(kind, fields, caps);
    const back = M.commandToFields(built)!;
    assert.equal(back.kind, kind);
    assert.deepEqual(M.buildCommand(back.kind, back.fields, caps), built, kind);
  }
  assert.equal(M.commandToFields({ kind: 'agent.delegate' }), null, '网页表单不覆盖的命令不提供模板');
  assert.equal(M.commandToFields({ kind: 'file.write', path: 'a', contentBase64: '/w==' }), null, '非 UTF-8 内容不能放回文本框');
  assert.equal(M.percent(2 / 3), '66.7%'); assert.equal(M.percent(null), '—');
  assert.equal(M.formatMs(850), '850 毫秒'); assert.equal(M.formatMs(2500), '2.5 秒'); assert.equal(M.shortDate('2026-11-05'), '11/5');
});
