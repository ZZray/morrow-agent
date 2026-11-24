// Copyright (c) Ray Zhang. Device online notifications and release manifest on the real HTTP boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { ReachStore } from '../src/service/store.ts';
import { reachServer } from '../src/service/server.ts';

function paired(store: ReachStore, userId: string, name = 'events-node') {
  const token = randomBytes(32).toString('base64url');
  const binding = store.pair({ attemptId: randomUUID(), code: store.createPairing(userId).code, installationId: randomUUID(), installationSecret: token, name, platform: 'windows', version: 'test' });
  return { token, nodeId: binding.nodeId };
}

test('first online needs a real capability report, is deduplicated per pairing, and reconnect follows the online window', () => {
  let now = 1_000_000; const store = new ReachStore(':memory:', () => now);
  store.bootstrap('events-user', 'disposable-events-password'); const { user } = store.login('events-user', 'disposable-events-password');
  const { token, nodeId } = paired(store, user.id);
  try {
    store.hello(store.node(token), 'test', []);
    assert.equal(store.deviceEvents.list(user.id, {}).events.length, 0, '空能力上报不算上线');
    now += 1000; store.hello(store.node(token), 'test', ['command.run']);
    now += 1000; store.hello(store.node(token), 'test', ['command.run']);
    let page = store.deviceEvents.list(user.id, {});
    assert.deepEqual(page.events.map(e => [e.kind, e.nodeId, e.read]), [['first_online', nodeId, false]]);
    assert.equal(page.unreadCount, 1);
    now += 29_000; store.hello(store.node(token), 'test', ['command.run']);
    assert.equal(store.deviceEvents.list(user.id, {}).events.length, 1, '窗口内的联系不算断线恢复');
    now += 31_000; store.hello(store.node(token), 'test', ['command.run']);
    page = store.deviceEvents.list(user.id, {});
    assert.deepEqual(page.events.map(e => e.kind), ['first_online', 'reconnected']);
    assert.equal(page.events[1].offlineSince, now - 31_000);
    const incremental = store.deviceEvents.list(user.id, { after: String(page.events[0].sequence) });
    assert.deepEqual(incremental.events.map(e => e.kind), ['reconnected']); assert.equal(incremental.hasMore, false);
    assert.equal(store.deviceEvents.list(user.id, { after: String(incremental.nextAfter) }).events.length, 0);
    assert.equal(store.deviceEvents.markRead(user.id, { sequences: [page.events[1].sequence] }).unreadCount, 1);
    assert.deepEqual(store.deviceEvents.list(user.id, {}).events.map(e => e.read), [false, true], '按序号只标记点开的那条');
    assert.equal(store.deviceEvents.markRead(user.id, { upTo: page.events[0].sequence }).unreadCount, 0);
    assert.equal(store.deviceEvents.markRead(user.id, { upTo: page.nextAfter }).unreadCount, 0);
    assert.deepEqual(store.deviceEvents.list(randomUUID(), {}).events, [], '其他账户看不到');
    store.revoke(user.id, nodeId); now += 120_000;
    store.hello(store.node(token, true), 'test', ['command.run']);
    assert.equal(store.deviceEvents.list(user.id, {}).events.length, 2, '解绑后的联系不产生通知');
  } finally { store.close(); }
});

test('existing online devices are seeded as read when the event table is first created', () => {
  const directory = mkdtempSync(join(tmpdir(), 'reach-events-'));
  const file = join(directory, 'reach.sqlite');
  try {
    let store = new ReachStore(file);
    store.bootstrap('seed-user', 'disposable-seeding-password'); const { user } = store.login('seed-user', 'disposable-seeding-password');
    const { token } = paired(store, user.id); store.hello(store.node(token), 'test', ['command.run']);
    store.db.exec('DROP TABLE node_events'); store.close();
    store = new ReachStore(file);
    try {
      const page = store.deviceEvents.list(user.id, {});
      assert.equal(page.events.length, 1); assert.equal(page.events[0].read, true); assert.equal(page.unreadCount, 0);
      store.hello(store.node(token), 'test', ['command.run']);
      assert.equal(store.deviceEvents.list(user.id, {}).events.length, 1);
    } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('device events and releases require login and CSRF; unconfigured and broken manifests are reported as such', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reach-releases-'));
  const manifest = join(directory, 'releases.json');
  const store = new ReachStore(':memory:');
  store.bootstrap('http-events', 'disposable-http-events-pw'); const session = store.login('http-events', 'disposable-http-events-pw');
  const servers = [reachServer({ store, publicOrigin: 'http://127.0.0.1', allowInsecureLoopback: true }), reachServer({ store, publicOrigin: 'http://127.0.0.1', allowInsecureLoopback: true, releaseManifest: manifest })];
  const bases: string[] = [];
  for (const server of servers) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string'); bases.push(`http://127.0.0.1:${address.port}`); }
  const auth = { authorization: `Bearer ${session.token}` };
  try {
    for (const path of ['/api/v1/device-events', '/api/v1/releases']) assert.equal((await fetch(bases[0] + path)).status, 401);
    const cookie = await fetch(bases[0] + '/api/v1/device-events/read', { method: 'POST', headers: { cookie: `reach_session=${session.token}`, 'content-type': 'application/json', origin: 'http://127.0.0.1' }, body: '{"upTo":0}' });
    assert.equal(cookie.status, 403, '浏览器会话必须带 CSRF');
    const read = await fetch(bases[0] + '/api/v1/device-events/read', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"upTo":0}' });
    assert.deepEqual(await read.json(), { unreadCount: 0 });
    assert.deepEqual(await (await fetch(bases[0] + '/api/v1/device-events?limit=500', { headers: auth })).json().then(v => v.error.code), 'invalid_request');
    assert.deepEqual(await (await fetch(bases[0] + '/api/v1/releases', { headers: auth })).json(), { configured: false, releases: [] });
    const missing = await fetch(bases[1] + '/api/v1/releases', { headers: auth }); assert.equal(missing.status, 503);
    writeFileSync(manifest, JSON.stringify({ releases: [{ version: '0.1.0', tag: 'v0.1.0', publishedAt: 1, assets: [{ name: 'a.exe', kind: 'node', arch: 'x64', bytes: 1, sha256: 'a'.repeat(64), signed: true, sources: [{ kind: 'github', url: 'http://insecure.example/a.exe' }] }] }] }));
    assert.equal((await fetch(bases[1] + '/api/v1/releases', { headers: auth })).status, 503, '非 HTTPS 下载源被拒绝');
    const asset = { name: 'Reach-Node-Setup.exe', kind: 'node', arch: 'x64', bytes: 1024, sha256: 'b'.repeat(64), signed: true, sources: [{ kind: 'github', url: 'https://github.com/example/a.exe' }, { kind: 'gitee', url: 'https://gitee.com/example/a.exe' }] };
    writeFileSync(manifest, JSON.stringify({ releases: [{ version: '0.1.0', tag: 'v0.1.0', publishedAt: 1, assets: [asset] }, { version: '0.2.0', tag: 'v0.2.0', publishedAt: 2, assets: [asset] }] }));
    const ok = await (await fetch(bases[1] + '/api/v1/releases', { headers: auth })).json();
    assert.equal(ok.configured, true); assert.deepEqual(ok.releases.map((r: { version: string }) => r.version), ['0.2.0', '0.1.0']);
  } finally {
    for (const server of servers) { server.close(); server.closeAllConnections(); await once(server, 'close'); }
    store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
