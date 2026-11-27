// Copyright (c) Ray Zhang. RayWorkbench 统一认证下的对话与设置：Ray 桥接会话可用，PIN 会话不能冒充浏览器 Ray 会话。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, createHmac } from 'node:crypto';
import { ReachStore } from '../src/service/store.ts';
import { reachServer } from '../src/service/server.ts';
import { RayLoginBridge } from '../src/service/ray-login.ts';
import type { DeskExtension } from '../src/service/desk-extension.ts';

test('Ray-bridged browser session reaches the conversation and settings APIs; a PIN session cannot', async () => {
  const key = randomBytes(32), store = new ReachStore(':memory:');
  store.bootstrap('ray', 'test-only-initial-account-password');
  const bridge = new RayLoginBridge(key, 'ray', ':memory:');
  const seen: string[] = [];
  // 对话运行时的替身：只记录收到的已认证请求，不涉及模型。
  const desk: DeskExtension = {
    async handle(context) { seen.push(`${context.request.method} ${context.url.pathname} ${context.userId}`); context.response.writeHead(200, { 'content-type': 'application/json' }); context.response.end('{"conversations":[]}'); },
    revoke() {}, async close() {},
  };
  const server = reachServer({ store, rayLogin: bridge, desk, publicOrigin: 'https://127.0.0.1', cookiePath: '/reach/' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const assertion = () => {
    const encoded = Buffer.from(JSON.stringify({ audience: 'ry-reach-ray-login-v1', nonce: randomBytes(32).toString('hex'), sessionHash: 'b'.repeat(64), issuedAt: Date.now(), expiresAt: Date.now() + 20000 })).toString('base64url');
    return encoded + '.' + createHmac('sha256', key).update(encoded).digest('hex');
  };
  try {
    const exchange = await fetch(origin + '/api/v1/auth/ray', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assertion: assertion() }) });
    assert.equal(exchange.status, 200);
    const cookie = exchange.headers.getSetCookie()[0].split(';')[0];
    const me = await (await fetch(origin + '/api/v1/auth/me', { headers: { cookie } })).json() as { id: string; csrf: string };
    assert.equal((await fetch(origin + '/api/v1/desk/conversations', { headers: { cookie } })).status, 200);
    assert.deepEqual(seen, [`GET /api/v1/desk/conversations ${me.id}`]);
    const settings = await (await fetch(origin + '/api/v1/settings/models', { headers: { cookie } })).json();
    assert.equal(settings.deskRunning, true);
    const write = (headers: Record<string, string>) => fetch(origin + '/api/v1/settings/providers', { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ name: 'P', baseUrl: 'https://m.example/v1', token: 'ray-fixture-token-0123456789' }) });
    assert.equal((await write({})).status, 403, '写请求仍需 CSRF');
    assert.equal((await write({ origin: 'https://127.0.0.1', 'x-reach-csrf': me.csrf })).status, 201);
    // PIN 登录得到的浏览器会话不是 Ray 会话，统一认证下不能用来访问对话。
    const pin = await fetch(origin + '/api/v1/auth/pin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"pin":"2026"}' });
    assert.equal(pin.status, 200, 'PIN 接口仍供本机控制器使用');
    const pinCookie = pin.headers.getSetCookie()[0].split(';')[0];
    const denied = await fetch(origin + '/api/v1/desk/conversations', { headers: { cookie: pinCookie } });
    assert.equal(denied.status, 401); assert.equal((await denied.json()).error.code, 'authentication_kind_mismatch');
    assert.equal(seen.length, 1);
    const old = await fetch(origin + '/desk/?c=0f8fad5b-d9cb-469f-a165-70867728950e', { redirect: 'manual' });
    assert.equal(old.headers.get('location'), '../#/desk/0f8fad5b-d9cb-469f-a165-70867728950e');
  } finally { await server.shutdown(); }
});
