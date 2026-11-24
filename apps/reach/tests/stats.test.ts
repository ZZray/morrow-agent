// Copyright (c) Ray Zhang. Console statistics aggregate only real ledger rows, bucket by the browser's local day and expose recorded offline gaps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { ReachStore } from '../src/service/store.ts';
import { reachServer } from '../src/service/server.ts';
import { computeStats } from '../src/service/stats.ts';

const DAY = 86_400_000;

test('daily buckets, outcome split, traffic, durations and availability come from recorded rows only', () => {
  const base = Date.UTC(2026, 10, 20, 2, 0); // 本地 UTC+8 的 11 月 20 日 10:00
  let now = base; const store = new ReachStore(':memory:', () => now);
  store.bootstrap('stats-user', 'disposable-stats-password'); const { user } = store.login('stats-user', 'disposable-stats-password');
  const token = randomBytes(32).toString('base64url');
  const { nodeId } = store.pair({ attemptId: randomUUID(), code: store.createPairing(user.id).code, installationId: randomUUID(), installationSecret: token, name: 'stats-node', platform: 'windows', version: 'test' });
  try {
    store.hello(store.node(token), 'test', ['command.run', 'file.write']);
    const run = (outcome: 'succeeded' | 'failed' | null, after: number) => {
      const op = store.submit(user.id, randomUUID(), nodeId, { kind: 'command.run', command: 'x', timeoutMs: 1000 });
      if (!outcome) return op;
      const claim = store.claim(store.node(token))!; let seq = 0;
      const send = (kind: 'received' | 'running' | 'succeeded' | 'failed', data: { exitCode?: number }) => store.record(store.node(token), { eventId: randomUUID(), operationId: op.id, dispatchId: claim.dispatchId, payloadHash: claim.payloadHash, sequence: ++seq, kind, data });
      send('received', {}); send('running', {}); now += after; send(outcome, { exitCode: outcome === 'succeeded' ? 0 : 1 });
      return op;
    };
    run('succeeded', 1000); run('failed', 3000);
    now = base + DAY; store.hello(store.node(token), 'test', ['command.run', 'file.write']); // 离线约一天后恢复
    run('succeeded', 2000); run(null, 0);
    const stats = computeStats(store, user.id, { days: '7', tz: '480' });
    assert.equal(stats.daily.length, 7);
    const [d1, d2] = stats.daily.slice(-2);
    assert.equal(d1.date, '2026-11-20'); assert.equal(d2.date, '2026-11-21');
    assert.deepEqual([d1.total, d1.succeeded, d1.failed, d2.total, d2.succeeded, d2.active], [2, 1, 1, 2, 1, 1]);
    assert.ok(d1.downlinkBytes > 0 && d1.uplinkBytes > 0 && d1.receipts === 6);
    assert.equal(d2.reconnects, 1);
    assert.equal(stats.totals.operations, 4); assert.equal(stats.totals.terminal, 3); assert.ok(Math.abs(stats.totals.successRate! - 2 / 3) < 1e-9);
    assert.deepEqual([stats.durations.count, stats.durations.p50, stats.durations.p90], [3, 2000, 3000]);
    assert.deepEqual(stats.kinds, [{ kind: 'command.run', count: 4 }]);
    assert.deepEqual(stats.devices.map(d => [d.name, d.total, d.failed]), [['stats-node', 4, 1]]);
    const availability = stats.availability[0];
    assert.equal(availability.offline.length, 1);
    assert.ok(availability.ratio! > 0 && availability.ratio! < 0.05, '离线约一天，在线时间只占很小比例');
    assert.equal(computeStats(store, randomUUID(), {}).totals.operations, 0, '其他账户为空');
    assert.throws(() => computeStats(store, user.id, { days: '9' }));
    assert.equal(computeStats(store, user.id, { node: nodeId }).totals.operations, 4);
    assert.throws(() => computeStats(store, user.id, { node: randomUUID() }), /未找到/);
  } finally { store.close(); }
});

test('stats endpoint requires login', async () => {
  const store = new ReachStore(':memory:');
  const server = reachServer({ store, publicOrigin: 'http://127.0.0.1', allowInsecureLoopback: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/v1/stats`)).status, 401);
    store.bootstrap('stats-http', 'disposable-stats-http-pw'); const session = store.login('stats-http', 'disposable-stats-http-pw');
    const ok = await fetch(`http://127.0.0.1:${address.port}/api/v1/stats?days=30&tz=-300`, { headers: { authorization: `Bearer ${session.token}` } });
    assert.equal(ok.status, 200); const body = await ok.json(); assert.equal(body.daily.length, 30); assert.equal(body.totals.successRate, null);
  } finally { server.close(); server.closeAllConnections(); await once(server, 'close'); store.close(); }
});
