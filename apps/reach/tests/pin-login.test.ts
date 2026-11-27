// Copyright (c) Ray Zhang. PIN login: default 2026, three wrong attempts lock for one hour globally, change and reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ReachStore } from '../src/service/store.ts';
import { reachServer } from '../src/service/server.ts';
import { PinLogin, PIN_LOCK_MS } from '../src/service/pin-login.ts';
import { ReachError } from '../src/service/errors.ts';

function code(fn: () => unknown) { try { fn(); return 'ok'; } catch (error) { return error instanceof ReachError ? `${error.status}:${error.code}` : String(error); } }

test('default PIN logs in the owner; three wrong attempts lock for an hour and the lock expires', () => {
  let now = 1_000_000; const store = new ReachStore(':memory:', () => now);
  try {
    const pin = new PinLogin(store);
    const session = pin.login('2026');
    assert.equal(session.user.username, 'reach', '没有账户时创建只能用 PIN 登录的所有者');
    assert.equal(store.session(session.token).id, session.user.id);
    assert.equal(pin.isDefault(session.user.id), true);
    assert.equal(code(() => pin.login('1111')), '401:invalid_pin');
    assert.equal(code(() => pin.login('abc')), '401:invalid_pin');
    assert.equal(code(() => pin.login('2222')), '429:pin_locked', '第三次错误立即锁定');
    assert.equal(code(() => pin.login('2026')), '429:pin_locked', '锁定期间正确 PIN 也不放行');
    now += PIN_LOCK_MS - 1; assert.equal(code(() => pin.login('2026')), '429:pin_locked');
    now += 2; assert.equal(code(() => pin.login('2026')), 'ok', '一小时后解锁');
    assert.equal(code(() => pin.login('1111')), '401:invalid_pin'); assert.equal(code(() => pin.login('2026')), 'ok'); assert.equal(code(() => pin.login('1111')), '401:invalid_pin');
    assert.equal(code(() => pin.login('1112')), '401:invalid_pin', '成功登录会清零失败计数');
  } finally { store.close(); }
});

test('PIN belongs to the first existing account, can be changed, and a reset restores the configured PIN', () => {
  const store = new ReachStore(':memory:');
  try {
    store.bootstrap('ray', 'disposable-pin-test-password');
    const owner = store.login('ray', 'disposable-pin-test-password').user;
    const pin = new PinLogin(store, '482913');
    assert.equal(pin.login('482913').user.id, owner.id);
    assert.equal(pin.isDefault(owner.id), false);
    assert.equal(code(() => pin.change(owner.id, { current: '000000', next: '135790' })), '400:invalid_pin');
    assert.equal(code(() => pin.change(owner.id, { current: '482913', next: '2026' })), '400:pin_default_rejected');
    assert.throws(() => pin.change(owner.id, { current: '482913', next: '12' }), /4–12/);
    assert.equal(code(() => pin.change(owner.id, { current: '482913', next: '135790' })), 'ok');
    assert.equal(code(() => pin.login('482913')), '401:invalid_pin');
    assert.equal(pin.login('135790').user.id, owner.id);
    assert.equal(code(() => new PinLogin(store, '777777').login('135790')), 'ok', '再次启动不覆盖已改过的 PIN');
    assert.equal(new PinLogin(store, '777777', true).login('777777').user.id, owner.id, '显式重置后恢复为配置的 PIN 并解锁');
  } finally { store.close(); }
});

test('HTTP: PIN sets a session cookie, /auth/me reports the default PIN, change requires CSRF', async () => {
  const store = new ReachStore(':memory:');
  const server = reachServer({ store, publicOrigin: 'http://127.0.0.1', allowInsecureLoopback: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const wrong = await fetch(`${base}/api/v1/auth/pin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"pin":"9999"}' });
    assert.equal(wrong.status, 401); assert.match((await wrong.json()).error.message, /还可以再试 2 次/);
    const ok = await fetch(`${base}/api/v1/auth/pin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"pin":"2026"}' });
    assert.equal(ok.status, 200); const session = await ok.json(); assert.equal(session.pinIsDefault, true);
    const cookie = ok.headers.get('set-cookie')!.split(';')[0];
    const me = await (await fetch(`${base}/api/v1/auth/me`, { headers: { cookie } })).json(); assert.equal(me.pinIsDefault, true);
    const noCsrf = await fetch(`${base}/api/v1/auth/pin/change`, { method: 'POST', headers: { cookie, origin: 'http://127.0.0.1', 'content-type': 'application/json' }, body: JSON.stringify({ current: '2026', next: '246810' }) });
    assert.equal(noCsrf.status, 403);
    const changed = await fetch(`${base}/api/v1/auth/pin/change`, { method: 'POST', headers: { cookie, origin: 'http://127.0.0.1', 'x-reach-csrf': me.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ current: '2026', next: '246810' }) });
    assert.equal(changed.status, 200);
    assert.equal((await (await fetch(`${base}/api/v1/auth/me`, { headers: { cookie } })).json()).pinIsDefault, false);
    const bearer = await fetch(`${base}/api/v1/auth/pin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"pin":"246810"}' });
    const token = (await bearer.json()).token;
    assert.equal((await fetch(`${base}/api/v1/nodes`, { headers: { authorization: `Bearer ${token}` } })).status, 200, '本机控制器用同一 PIN 取得的令牌可访问同一账户');
  } finally { server.close(); server.closeAllConnections(); await once(server, 'close'); store.close(); }
});
