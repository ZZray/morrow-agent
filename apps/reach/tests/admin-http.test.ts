// Copyright (c) Ray Zhang. Public shell must not expose authenticated data or files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { ReachStore } from '../src/service/store.ts';
import { reachServer } from '../src/service/server.ts';
import { validateOrigin } from '../src/controller/client.ts';

test('built management assets have restrictive headers; arbitrary paths and protected APIs stay private', async () => {
  const store = new ReachStore(':memory:');
  const server = reachServer({ store, publicOrigin: 'http://127.0.0.1', allowInsecureLoopback: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const [path, type, marker] of [['/', 'text/html', 'lang="zh-CN"'], ['/assets/admin.js', 'text/javascript', 'createElement'], ['/assets/artifacts.js', 'text/javascript', 'ArtifactReader'], ['/assets/admin.css', 'text/css', 'focus-visible'], ['/assets/reach.svg', 'image/svg+xml', 'viewBox="0 0 512 512"']]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200); assert.ok(response.headers.get('content-type')?.startsWith(type));
      assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.ok((await response.text()).includes(marker));
    }
    const head = await fetch(base + '/assets/admin.js', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    for (const path of ['/src/service/store.ts', '/.env', '/work/reach.sqlite', '/assets/%2e%2e%2f.env', '/unknown']) assert.equal((await fetch(base + path)).status, 404);
    for (const path of ['/api/v1/nodes', '/api/v1/operations', '/api/v1/overview', '/api/v1/auth/me']) assert.equal((await fetch(base + path)).status, 401);
    assert.equal((await fetch(base + '/', { method: 'POST' })).status, 404);
  } finally { server.close(); server.closeAllConnections(); await once(server, 'close'); store.close(); }
});

test('overview keeps historical unknown counts without transferring large operation payloads or another account', async () => {
  let now = Date.now(); const store = new ReachStore(':memory:', () => now);
  store.bootstrap('overview-test', 'disposable-overview-password'); const session = store.login('overview-test', 'disposable-overview-password');
  const token = randomBytes(32).toString('base64url');
  const binding = store.pair({ attemptId: randomUUID(), code: store.createPairing(session.user.id).code, installationId: randomUUID(), installationSecret: token, name: 'overview-node', platform: 'windows', version: 'test' });
  const node = store.node(token); store.hello(node, 'test', ['file.write', 'command.run']);
  const original = store.submit(session.user.id, randomUUID(), binding.nodeId, { kind: 'command.run', command: 'original', timeoutMs: 1000 });
  const claim = store.claim(node)!;
  store.record(node, { eventId: randomUUID(), operationId: original.id, dispatchId: claim.dispatchId, payloadHash: claim.payloadHash, sequence: 1, kind: 'unknown', data: { reason: 'controlled historical unknown' } });
  for (let i = 0; i < 200; i++) { now++; store.submit(session.user.id, randomUUID(), binding.nodeId, { kind: 'file.write', path: 'fixture-only', contentBase64: i === 199 ? Buffer.alloc(1_000_000).toString('base64') : '' }); }
  const server = reachServer({ store, publicOrigin: 'http://127.0.0.1', allowInsecureLoopback: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/overview`, { headers: { authorization: `Bearer ${session.token}` } });
    assert.equal(response.status, 200); const raw = await response.text(); assert.ok(raw.length < 150_000);
    const summary = JSON.parse(raw); assert.equal(summary.unresolvedCount, 1); assert.equal(summary.operations.length, 200);
    assert.ok(!summary.operations.some((op: { id: string }) => op.id === original.id));
    assert.ok(summary.operations.every((op: Record<string, unknown>) => op.kind === 'file.write' && !('command_json' in op) && !('result_json' in op)));
    assert.deepEqual(store.overview(randomUUID()), { nodes: [], operations: [], unresolvedCount: 0 });
    assert.equal(store.operation(session.user.id, original.id).execution, 'unknown');
  } finally { server.close(); server.closeAllConnections(); await once(server, 'close'); store.close(); }
});

test('cookie management session restores, enforces CSRF, logs out and expires on the actual HTTP boundary', async () => {
  let now = Date.now(); const store = new ReachStore(':memory:', () => now);
  store.bootstrap('browser-test', 'disposable-http-test-password');
  const origin = 'http://127.0.0.1';
  const server = reachServer({ store, publicOrigin: origin, cookiePath: '/reach/', allowInsecureLoopback: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  async function login() {
    const response = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'browser-test', password: 'disposable-http-test-password' }) });
    assert.equal(response.status, 200); const cookie = response.headers.get('set-cookie')!; assert.match(cookie, /Path=\/reach\/; HttpOnly; SameSite=Strict/);
    assert.equal(response.headers.getSetCookie().length, 2); assert.match(response.headers.getSetCookie()[1], /Path=\/;.*Max-Age=0/);
    return { cookie: cookie.split(';')[0], ...(await response.json() as { csrf: string }) };
  }
  try {
    const session = await login();
    const restored = await fetch(base + '/api/v1/auth/me', { headers: { cookie: session.cookie } }); assert.equal(restored.status, 200); assert.equal((await restored.json() as { username: string }).username, 'browser-test');
    assert.equal((await fetch(base + '/api/v1/pairing-codes', { method: 'POST', headers: { cookie: session.cookie, origin } })).status, 403);
    const headers = { cookie: session.cookie, origin, 'x-reach-csrf': session.csrf };
    assert.equal((await fetch(base + '/api/v1/pairing-codes', { method: 'POST', headers })).status, 201);
    const loggedOut = await fetch(base + '/api/v1/auth/logout', { method: 'POST', headers });
    assert.equal(loggedOut.status, 200); assert.match(loggedOut.headers.get('set-cookie')!, /Path=\/reach\/;.*Max-Age=0/);
    assert.equal((await fetch(base + '/api/v1/nodes', { headers: { cookie: session.cookie } })).status, 401);
    const second = await login(); now += 12 * 60 * 60 * 1000 + 1;
    assert.equal((await fetch(base + '/api/v1/auth/me', { headers: { cookie: second.cookie } })).status, 401);
  } finally { server.close(); server.closeAllConnections(); await once(server, 'close'); store.close(); }
});

test('controller accepts only canonical root or Reach mount addresses', () => {
  for (const value of ['https://118.25.103.226', 'https://118.25.103.226/reach', 'https://example.test:8443']) assert.equal(validateOrigin(value), value);
  for (const value of ['https://example.test/reach/', 'https://example.test/reach/../reach', 'https://example.test/%72each', 'https://example.test/other', 'https://user@example.test/reach', 'https://example.test/reach?q=1', 'https://example.test/reach#x', 'http://118.25.103.226/reach']) assert.throws(() => validateOrigin(value));
});
