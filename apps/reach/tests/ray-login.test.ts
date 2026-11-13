// Copyright (c) Ray Zhang. Signed exchange, durable replay rejection and HTTP sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { RayLoginBridge } from '../src/service/ray-login.ts';
import { ReachStore } from '../src/service/store.ts';
import { reachServer } from '../src/service/server.ts';

test('Ray signed assertion is fixed-account, short-lived, one-time and durable across restart', () => {
  const key = randomBytes(32); let now = Date.now();
  const database = join(mkdtempSync(join(tmpdir(), 'reach-ray-nonce-')), 'nonces.sqlite');
  const signed = (input: Record<string, unknown>, signingKey = key) => {
    const payload = Buffer.from(JSON.stringify(input)).toString('base64url');
    return payload + '.' + createHmac('sha256', signingKey).update(payload).digest('hex');
  };
  const input = { audience: 'ry-reach-ray-login-v1', nonce: randomBytes(32).toString('hex'), sessionHash: randomBytes(32).toString('hex'), issuedAt: now, expiresAt: now + 20000 };
  let bridge = new RayLoginBridge(key, 'ray', database, () => now);
  const value = signed(input);
  assert.throws(() => bridge.consume(signed(input, randomBytes(32))));
  assert.throws(() => bridge.consume(signed({ ...input, audience: 'another-app' })));
  assert.throws(() => bridge.consume(signed({ ...input, username: 'browser-selected' })));
  assert.equal(bridge.consume(value).username, 'ray');
  assert.throws(() => bridge.consume(value), /已使用/);
  bridge.close(); bridge = new RayLoginBridge(key, 'ray', database, () => now);
  assert.throws(() => bridge.consume(value), /已使用/);
  now += 40000;
  assert.throws(() => bridge.consume(value), /过期/);
  assert.throws(() => bridge.consume(signed({ ...input, nonce: randomBytes(32).toString('hex'), issuedAt: now + 5001, expiresAt: now + 30000 })), /过期/);
  bridge.close();
});

test('loopback signed exchange creates an existing Reach account session without exposing a bearer; cookie CSRF remains required', async () => {
  const key = randomBytes(32), store = new ReachStore(':memory:');
  store.bootstrap('ray', 'test-only-initial-account-password');
  const bridge = new RayLoginBridge(key, 'ray', ':memory:');
  const server = reachServer({ store, rayLogin: bridge, publicOrigin: 'https://127.0.0.1', cookiePath: '/reach/' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const assertion = (extra = {}) => {
    const encoded = Buffer.from(JSON.stringify({ audience: 'ry-reach-ray-login-v1', nonce: randomBytes(32).toString('hex'), sessionHash: 'b'.repeat(64), issuedAt: Date.now(), expiresAt: Date.now() + 20000, ...extra })).toString('base64url');
    return encoded + '.' + createHmac('sha256', key).update(encoded).digest('hex');
  };
  const exchange = (value: string, extra = {}) => fetch(origin + '/api/v1/auth/ray', { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify({ assertion: value }) });
  try {
    assert.match(await (await fetch(origin)).text(), /reach-login-provider" content="ray"/);
    assert.equal((await exchange(assertion(), { origin: 'https://127.0.0.1' })).status, 401);
    assert.equal((await exchange('forged')).status, 401);
    const proof = assertion(), response = await exchange(proof);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { loggedIn: true });
    const cookies = response.headers.getSetCookie(); assert.equal(cookies.length, 2); assert.match(cookies[0], /Path=\/reach\/;.*HttpOnly.*Secure/);
    const cookie = cookies[0].split(';')[0];
    const token = cookie.slice('reach_session='.length);
    const firstIdentity = await (await fetch(origin + '/api/v1/auth/me', { headers: { cookie } })).json() as { csrf: string };
    assert.equal((await fetch(origin + '/api/v1/auth/me', { headers: { authorization: `Bearer ${token}` } })).status, 401);
    const reused = await exchange(assertion({ reachToken: token })); assert.equal(reused.status, 200); assert.equal(reused.headers.getSetCookie()[0].split(';')[0], cookie);
    const concurrent = await Promise.all([exchange(assertion()), exchange(assertion())]);
    for (const response of concurrent) { assert.equal(response.status, 200); assert.equal(response.headers.getSetCookie()[0].split(';')[0], cookie); }
    const firstPages = await Promise.all([exchange(assertion({ sessionHash: 'd'.repeat(64) })), exchange(assertion({ sessionHash: 'd'.repeat(64) }))]);
    assert.ok(firstPages.every(response => response.status === 200));
    assert.equal(new Set(firstPages.map(response => response.headers.getSetCookie()[0].split(';')[0])).size, 1);
    const oldTabMutation = await fetch(origin + '/api/v1/pairing-codes', { method: 'POST', headers: { cookie, origin: 'https://127.0.0.1', 'x-reach-csrf': firstIdentity.csrf } });
    assert.equal(oldTabMutation.status, 201, 'Opening another page must preserve the existing tab CSRF');
    assert.equal((await exchange(assertion({ reachToken: token, purpose: 'validate' }))).status, 200);
    assert.equal((await exchange(assertion({ reachToken: token, purpose: 'validate', sessionHash: 'c'.repeat(64) }))).status, 401);
    assert.equal((await exchange(assertion({ purpose: 'validate' }))).status, 401);
    assert.equal((await exchange(proof)).status, 401);
    const restored = await fetch(origin + '/api/v1/auth/me', { headers: { cookie } }); assert.equal(restored.status, 200);
    const user = await restored.json() as { username: string; csrf: string }; assert.equal(user.username, 'ray');
    assert.equal((await fetch(origin + '/api/v1/pairing-codes', { method: 'POST', headers: { cookie } })).status, 403);
    const logout = await fetch(origin + '/api/v1/auth/logout', { method: 'POST', headers: { cookie, origin: 'https://127.0.0.1', 'x-reach-csrf': user.csrf } }); assert.equal(logout.status, 200);
    assert.equal((await fetch(origin + '/api/v1/auth/me', { headers: { cookie } })).status, 401);
    assert.equal((await exchange(assertion({ reachToken: token, purpose: 'validate' }))).status, 401);
    const renewed = await exchange(assertion()); assert.equal(renewed.status, 200); assert.equal(renewed.headers.getSetCookie()[0].split(';')[0], cookie);
    assert.equal((await fetch(origin + '/api/v1/auth/me', { headers: { cookie } })).status, 200);
    const native = store.login('ray', 'test-only-initial-account-password');
    assert.equal((await fetch(origin + '/api/v1/auth/me', { headers: { authorization: `Bearer ${native.token}` } })).status, 200);
    assert.equal((await fetch(origin + '/api/v1/auth/me', { headers: { cookie: `reach_session=${native.token}` } })).status, 401);
  } finally { server.close(); server.closeAllConnections(); await once(server, 'close'); bridge.close(); store.close(); }
});
