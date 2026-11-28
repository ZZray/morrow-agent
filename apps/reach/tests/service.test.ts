// Copyright (c) Ray Zhang. Exercise the HTTP boundary and persistent ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { once } from 'node:events';
import { ReachStore } from '../src/service/store.ts';
import { reachServer } from '../src/service/server.ts';
import type { OperationEvent } from '../src/contracts/protocol.ts';

import { fixture, password } from './service-fixture.ts';

test('paired devices query release updates and authenticated devices or browsers download listed files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reach-release-update-'));
  const manifestPath = join(directory, 'releases.json');
  const assetDir = join(directory, 'assets');
  const tag = 'reach-worker-agent-v0.1.12', name = 'Reach-Worker-Agent-Setup-x64.exe';
  const payload = Buffer.from('test release bytes');
  const asset = { name, kind: 'agent', os: 'windows', arch: 'x64', bytes: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex'), signed: true,
    sources: [{ kind: 'reach', url: `https://example.test/reach/api/v1/releases/files/${tag}/${name}` }] };
  const release = { version: '0.1.12', tag, publishedAt: 1, assets: [asset] };
  const catalog = (entry: unknown) => writeFileSync(manifestPath, JSON.stringify({ releases: [entry] }));
  catalog(release);
  mkdirSync(join(assetDir, tag), { recursive: true });
  writeFileSync(join(assetDir, tag, name), payload);

  const store = new ReachStore(':memory:');
  store.bootstrap('release-test', password);
  const session = store.login('release-test', password);
  const nodeToken = randomBytes(32).toString('base64url');
  const node = store.pair({ attemptId: randomUUID(), code: store.createPairing(session.user.id).code,
    installationId: randomUUID(), installationSecret: nodeToken, name: 'release-node', platform: 'windows', version: '0.1.10' });
  const server = reachServer({ store, publicOrigin: 'http://127.0.0.1', allowInsecureLoopback: true,
    releaseManifest: manifestPath, releaseAssetDir: assetDir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const nodeAuth = { authorization: `Bearer ${nodeToken}` };
  const actorAuth = { authorization: `Bearer ${session.token}` };
  const cookieAuth = { cookie: `reach_session=${session.token}` };
  const nodeFile = `/api/v1/node/update/files/${tag}/${name}`;
  const browserFile = `/api/v1/releases/files/${tag}/${name}`;
  try {
    assert.equal((await fetch(base + '/api/v1/node/update')).status, 401);
    assert.equal((await fetch(base + '/api/v1/node/update', { headers: actorAuth })).status, 401);
    assert.deepEqual(await (await fetch(base + '/api/v1/node/update', { headers: nodeAuth })).json(), { configured: true, releases: [release] });
    assert.equal((await fetch(base + '/api/v1/releases', { headers: nodeAuth })).status, 401);
    assert.equal((await fetch(base + nodeFile)).status, 401);
    assert.equal((await fetch(base + browserFile)).status, 401);
    assert.equal((await fetch(base + nodeFile, { headers: actorAuth })).status, 401);
    assert.equal((await fetch(base + browserFile, { headers: nodeAuth })).status, 401);

    const update = { manifest: Buffer.from('{"schema":2}').toString('base64'), signature: Buffer.alloc(64, 7).toString('base64'),
      url: `https://example.test/reach/api/v1/node/update/files/${tag}/${name}` };
    const updated = { ...release, assets: [{ ...asset, update }] };
    catalog(updated);
    assert.deepEqual(await (await fetch(base + '/api/v1/node/update', { headers: nodeAuth })).json(), { configured: true, releases: [updated] });
    assert.deepEqual(await (await fetch(base + '/api/v1/releases', { headers: cookieAuth })).json(), { configured: true, releases: [updated] });
    const browserRelative = `api/v1/releases/files/${tag}/${name}`;
    const nodeRelative = `api/v1/node/update/files/${tag}/${name}`;
    const localAsset = { ...asset, sources: [{ kind: 'reach', url: browserRelative }], update: { ...update, url: nodeRelative } };
    const localRelease = { ...release, assets: [localAsset] };
    catalog(localRelease);
    assert.deepEqual(await (await fetch(base + '/api/v1/node/update', { headers: nodeAuth })).json(), { configured: true, releases: [localRelease] });
    for (const host of ['bigrayzhang.cn', 'www.bigrayzhang.cn', '192.0.2.1']) {
      assert.equal(new URL(browserRelative, `https://${host}/reach/#/downloads`).href, `https://${host}/reach/${browserRelative}`);
    }
    const invalidSourceUrls = [
      `/api/v1/releases/files/${tag}/${name}`, `../${browserRelative}`, `//example.test/${browserRelative}`,
      `api/v1/releases/files/../${name}`, `api/v1/releases/files/${tag}/../${name}`,
      `api/v1/releases/files/${tag}/%2e%2e`, `${browserRelative}?x=1`, `api/v1/releases/files/other/${name}`, nodeRelative,
    ];
    for (const url of invalidSourceUrls) {
      catalog({ ...release, assets: [{ ...localAsset, sources: [{ kind: 'reach', url }] }] });
      assert.equal((await fetch(base + '/api/v1/node/update', { headers: nodeAuth })).status, 503, `source must reject ${url}`);
    }
    catalog({ ...release, assets: [{ ...localAsset, sources: [{ kind: 'gitee', url: browserRelative }] }] });
    assert.equal((await fetch(base + '/api/v1/node/update', { headers: nodeAuth })).status, 503, 'external source must be HTTPS');
    const invalidUpdateUrls = [
      `/${nodeRelative}`, `../${nodeRelative}`, `//example.test/${nodeRelative}`,
      `api/v1/node/update/files/../${name}`, `api/v1/node/update/files/${tag}/../${name}`,
      `${nodeRelative}#fragment`, `api/v1/node/update/files/other/${name}`, browserRelative,
    ];
    for (const url of invalidUpdateUrls) {
      catalog({ ...release, assets: [{ ...localAsset, update: { ...update, url } }] });
      assert.equal((await fetch(base + '/api/v1/node/update', { headers: nodeAuth })).status, 503, `update must reject ${url}`);
    }
    catalog(localRelease);
    for (const [path, headers] of [[nodeFile, nodeAuth], [browserFile, cookieAuth]] as const) {
      const response = await fetch(base + path, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-length'), String(payload.length));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
    }
    assert.equal((await fetch(base + `/api/v1/node/update/files/${tag}/unknown.exe`, { headers: nodeAuth })).status, 404);
    assert.equal((await fetch(base + `/api/v1/releases/files/${tag}/..%2f${name}`, { headers: cookieAuth })).status, 404);
    writeFileSync(join(assetDir, tag, name), 'wrong size');
    const invalidFile = await fetch(base + browserFile, { headers: cookieAuth });
    assert.equal(invalidFile.status, 503); assert.equal((await invalidFile.json()).error.code, 'release_asset_invalid');
    rmSync(join(assetDir, tag, name));
    const missing = await fetch(base + nodeFile, { headers: nodeAuth });
    assert.equal(missing.status, 503); assert.equal((await missing.json()).error.code, 'release_asset_unavailable');
    for (const invalid of [
      { ...update, signature: Buffer.alloc(63).toString('base64') },
      { ...update, manifest: 'not base64!' },
      { ...update, url: 'http://example.test/setup.exe' },
      { ...update, unexpected: true },
    ]) {
      catalog({ ...release, assets: [{ ...asset, update: invalid }] });
      const response = await fetch(base + '/api/v1/node/update', { headers: nodeAuth });
      assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'release_manifest_invalid');
    }
    catalog(updated);
    store.revoke(session.user.id, node.nodeId);
    assert.equal((await fetch(base + '/api/v1/node/update', { headers: nodeAuth })).status, 401);
    assert.equal((await fetch(base + nodeFile, { headers: nodeAuth })).status, 401);
  } finally {
    await server.shutdown(); rmSync(directory, { recursive: true, force: true });
  }
});
test('pairing retry survives a lost response; consumed code and changed attempt cannot create a second identity', async () => {
  const f = await fixture();
  try {
    const retry = await f.api('/api/v1/node/pair', 'POST', f.pairInput);
    assert.equal(retry.status, 200); assert.equal(retry.data.nodeId, f.nodeId);
    assert.equal((await f.api('/api/v1/node/pair', 'POST', { ...f.pairInput, name: 'changed' })).status, 409);
    assert.equal((await f.api('/api/v1/node/pair', 'POST', { ...f.pairInput, attemptId: randomUUID(), installationId: randomUUID() })).status, 400);
    assert.equal((await f.api('/api/v1/nodes', 'GET', undefined, f.token)).data.nodes.length, 1);
  } finally { await f.cleanup(); }
});

test('concurrent claims deliver once, duplicate submission returns original, changed input is rejected', async () => {
  const f = await fixture();
  try {
    const { input, operation } = await f.enqueue();
    const duplicate = await f.api('/api/v1/operations', 'POST', input, f.token);
    assert.equal(duplicate.data.id, operation.id);
    assert.equal((await f.api('/api/v1/operations', 'POST', { ...input, command: { ...input.command, command: 'different' } }, f.token)).status, 409);
    const claims = await Promise.all(Array.from({ length: 6 }, () => f.api('/api/v1/node/poll', 'POST', { version: 'test', capabilities: ['command.run'] }, f.installationSecret)));
    assert.equal(claims.filter(result => result.data.operation).length, 1);
    assert.equal(claims.find(result => result.data.operation)!.data.operation.operationId, operation.id);
    await f.reopen();const second=f.store;
      assert.equal(second.claim(second.node(f.installationSecret)), null);
      assert.equal(second.pending(second.node(f.installationSecret)).length, 1);
      second.now = () => Date.now() + 60000; second.observeStaleClaims();
      assert.equal(second.operation(second.session(f.token).id, operation.id).delivery, 'uncertain');
      assert.equal(second.claim(second.node(f.installationSecret)), null);
  } finally { await f.cleanup(); }
});

test('durable ordered event outbox accepts duplicate uploads and rejects mutated, skipped, or late events', async () => {
  const f = await fixture();
  try {
    const { operation } = await f.enqueue();
    const claim = (await f.api('/api/v1/node/poll', 'POST', { version: 'test', capabilities: ['command.run'] }, f.installationSecret)).data.operation;
    const event = (sequence: number, kind: OperationEvent['kind'], data: unknown = {}) => ({ eventId: randomUUID(), operationId: operation.id, dispatchId: claim.dispatchId, payloadHash: claim.payloadHash, sequence, kind, data });
    const received = event(1, 'received');
    assert.equal((await f.api('/api/v1/node/events', 'POST', received, f.installationSecret)).status, 200);
    assert.equal((await f.api('/api/v1/node/events', 'POST', received, f.installationSecret)).data.duplicate, true);
    assert.equal((await f.api('/api/v1/node/events', 'POST', { ...received, data: { altered: true } }, f.installationSecret)).status, 409);
    assert.equal((await f.api('/api/v1/node/events', 'POST', event(3, 'running'), f.installationSecret)).status, 409);
    assert.equal((await f.api('/api/v1/node/events', 'POST', event(2, 'running'), f.installationSecret)).status, 200);
    assert.equal((await f.api('/api/v1/node/events', 'POST', event(3, 'output', { stdout: 'real output fixture' }), f.installationSecret)).status, 200);
    const done = event(4, 'succeeded', { exitCode: 0 });
    assert.equal((await f.api('/api/v1/node/events', 'POST', done, f.installationSecret)).status, 200);
    assert.equal((await f.api('/api/v1/node/events', 'POST', done, f.installationSecret)).data.duplicate, true);
    assert.equal((await f.api('/api/v1/node/events', 'POST', event(5, 'running'), f.installationSecret)).status, 409);
    const events = (await f.api(`/api/v1/operations/${operation.id}/events?after=2`, 'GET', undefined, f.token)).data.events;
    assert.deepEqual(events.map((e: any) => e.sequence), [3, 4]);
  } finally { await f.cleanup(); }
});

test('cancel is a request after claim; unpair rejects new work but lets original receipts settle', async () => {
  const f = await fixture();
  try {
    const { operation } = await f.enqueue();
    const claim = (await f.api('/api/v1/node/poll', 'POST', { version: 'test', capabilities: ['command.run'] }, f.installationSecret)).data.operation;
    await f.api(`/api/v1/operations/${operation.id}/cancel`, 'POST', {}, f.token);
    assert.equal((await f.api(`/api/v1/operations/${operation.id}`, 'GET', undefined, f.token)).data.execution, 'not_observed');
    await f.api(`/api/v1/nodes/${f.nodeId}/unpair`, 'POST', {}, f.token);
    assert.equal((await f.api('/api/v1/node/poll', 'POST', { version: 'test', capabilities: [] }, f.installationSecret)).status, 401);
    const control = await f.api(`/api/v1/node/control/${operation.id}`, 'GET', undefined, f.installationSecret);
    assert.equal(control.data.operation.cancel_requested, 1);
    const event = { eventId: randomUUID(), operationId: operation.id, dispatchId: claim.dispatchId, payloadHash: claim.payloadHash, sequence: 1, kind: 'cancelled', data: { started: false } };
    assert.equal((await f.api('/api/v1/node/events', 'POST', event, f.installationSecret)).status, 200);
    assert.equal((await f.api(`/api/v1/operations/${operation.id}`, 'GET', undefined, f.token)).data.execution, 'cancelled');
  } finally { await f.cleanup(); }
});

test('ownership, auth kinds, CSRF, and schema reject untrusted requests', async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.api('/api/v1/node/update', 'GET', undefined, f.installationSecret)).data, { configured: false, releases: [] });
    const { operation } = await f.enqueue();
    assert.equal((await f.api('/api/v1/nodes', 'GET', undefined, f.installationSecret)).status, 401);
    assert.equal((await f.api('/api/v1/node/pending', 'GET', undefined, f.token)).status, 401);
    assert.equal((await f.api('/api/v1/operations', 'POST', { nodeId: f.nodeId, requestId: randomUUID(), command: { kind: 'command.run', command: 'a', unexpected: true } }, f.token)).status, 400);
    assert.equal((await f.api('/api/v1/pairing-codes', 'POST', {}, undefined, { cookie: `reach_session=${f.token}`, origin: 'https://evil.example' })).status, 403);
    assert.equal((await f.api('/api/v1/auth/login', 'POST', { username: 'ray-test', password }, undefined, { origin: 'https://evil.example' })).status, 403);
    // A separate authenticated account must not gain device/receipt access.
    const id = randomUUID();
    f.store.db.prepare('INSERT INTO users SELECT ?,?,?,password_hash FROM users LIMIT 1').run(id, 'second-user', 'dummy-salt');
    const firstUser = f.store.session(f.token).id;
    f.store.db.prepare('UPDATE sessions SET user_id=? WHERE user_id=?').run(id, firstUser);
    assert.equal((await f.api(`/api/v1/operations/${operation.id}`, 'GET', undefined, f.token)).status, 404);
    assert.equal((await f.api(`/api/v1/nodes/${f.nodeId}/unpair`, 'POST', {}, f.token)).status, 404);
    assert.equal((await f.api('/api/v1/operations', 'GET', undefined, f.token)).data.operations.length, 0);
  } finally { await f.cleanup(); }
});

test('explicit reconciliation preserves unknown history and permits re-pairing without re-execution', async () => {
  const f = await fixture();
  try {
    const { operation } = await f.enqueue();
    const claim = (await f.api('/api/v1/node/poll', 'POST', { version: 'test', capabilities: ['command.run'] }, f.installationSecret)).data.operation;
    const unknown = { eventId: randomUUID(), operationId: operation.id, dispatchId: claim.dispatchId, payloadHash: claim.payloadHash, sequence: 1, kind: 'unknown', data: { reason: 'process_interrupted' } };
    assert.equal((await f.api('/api/v1/node/events', 'POST', unknown, f.installationSecret)).status, 200);
    const code = (await f.api('/api/v1/pairing-codes', 'POST', {}, f.token)).data.code;
    const retryPair = { ...f.pairInput, attemptId: randomUUID(), code, installationSecret: randomBytes(32).toString('base64url') };
    assert.equal((await f.api('/api/v1/node/pair', 'POST', retryPair, f.installationSecret)).status, 409);
    const reconciliation = { reconciliationId: randomUUID(), dispatchId: claim.dispatchId, payloadHash: claim.payloadHash, decision: 'not_executed', evidence: 'Inspected original node journal and process tree: operation never started.', result: { started: false } };
    assert.equal((await f.api(`/api/v1/operations/${operation.id}/reconcile`, 'POST', { ...reconciliation, dispatchId: randomUUID() }, f.token)).status, 409);
    assert.equal((await f.api(`/api/v1/operations/${operation.id}/reconcile`, 'POST', reconciliation, f.token)).data.execution, 'cancelled');
    assert.equal((await f.api(`/api/v1/operations/${operation.id}/reconcile`, 'POST', reconciliation, f.token)).status, 200);
    assert.equal((await f.api(`/api/v1/operations/${operation.id}/events`, 'GET', undefined, f.token)).data.events[0].kind, 'unknown');
    assert.equal((await f.api(`/api/v1/operations/${operation.id}/reconciliations`, 'GET', undefined, f.token)).data.reconciliations.length, 1);
    assert.equal((await f.api('/api/v1/node/poll', 'POST', { version: 'test', capabilities: ['command.run'] }, f.installationSecret)).data.operation, null);
    assert.equal((await f.api('/api/v1/node/pair', 'POST', retryPair, f.installationSecret)).status, 200);
    assert.equal((await f.api('/api/v1/node/pending', 'GET', undefined, f.installationSecret)).status, 401);
  } finally { await f.cleanup(); }
});

test('trusted proxy client buckets are independent; untrusted source headers cannot bypass throttling', async () => {
  for (const trusted of [true, false]) {
    const f = await fixture(trusted);
    try {
      const payload = { username: 'ray-test', password: 'wrong' };
      for (let index = 0; index < 10; index++) await f.api('/api/v1/auth/login', 'POST', payload, undefined, { 'x-reach-client-ip': '192.0.2.1' });
      const same = await f.api('/api/v1/auth/login', 'POST', payload, undefined, { 'x-reach-client-ip': '192.0.2.1' });
      const other = await f.api('/api/v1/auth/login', 'POST', { username: 'ray-test', password }, undefined, { 'x-reach-client-ip': '192.0.2.2' });
      assert.equal(same.status, 429);
      assert.equal(other.status, trusted ? 200 : 429);
      if (trusted) assert.equal((await f.api('/api/v1/auth/login', 'POST', payload, undefined, { 'x-reach-client-ip': 'spoofed, 192.0.2.2' })).status, 503);
    } finally { await f.cleanup(); }
  }
});

test('accepted pairing receipt remains recoverable after unpair without reactivating old binding', async () => {
  const f = await fixture();
  try {
    await f.api(`/api/v1/nodes/${f.nodeId}/unpair`, 'POST', {}, f.token);
    const recovered = await f.api('/api/v1/node/pair', 'POST', f.pairInput);
    assert.equal(recovered.status, 200); assert.equal(recovered.data.nodeId, f.nodeId); assert.equal(recovered.data.revoked, true);
    assert.equal((await f.api('/api/v1/node/poll', 'POST', { version: 'test', capabilities: [] }, f.installationSecret)).status, 401);
    const code = (await f.api('/api/v1/pairing-codes', 'POST', {}, f.token)).data.code;
    const fresh = await f.api('/api/v1/node/pair', 'POST', { ...f.pairInput, code, attemptId: randomUUID(), installationSecret: randomBytes(32).toString('base64url') }, f.installationSecret);
    assert.equal(fresh.status, 200); assert.equal(fresh.data.nodeId, f.nodeId); assert.equal(fresh.data.epoch, recovered.data.epoch + 1);
  } finally { await f.cleanup(); }
});

test('late original receipts remain readable after explicit reconciliation without changing its decision', async () => {
  const f = await fixture();
  try {
    const { operation } = await f.enqueue();
    const claim = (await f.api('/api/v1/node/poll', 'POST', { version: 'test', capabilities: ['command.run'] }, f.installationSecret)).data.operation;
    const event = (sequence: number, kind: string) => ({ eventId: randomUUID(), operationId: operation.id, dispatchId: claim.dispatchId, payloadHash: claim.payloadHash, sequence, kind, data: { source: 'original-node' } });
    for (const [i, kind] of ['received', 'running'].entries()) assert.equal((await f.api('/api/v1/node/events', 'POST', event(i + 1, kind), f.installationSecret)).status, 200);
    await f.api(`/api/v1/nodes/${f.nodeId}/unpair`, 'POST', {}, f.token);
    const reconciliation = { reconciliationId: randomUUID(), dispatchId: claim.dispatchId, payloadHash: claim.payloadHash, decision: 'succeeded', evidence: 'Controlled fixture: operator independently inspected the original output.', result: { inspection: true } };
    assert.equal((await f.api(`/api/v1/operations/${operation.id}/reconcile`, 'POST', reconciliation, f.token)).status, 200);
    assert.equal((await f.api('/api/v1/node/events', 'POST', event(3, 'output'), f.installationSecret)).status, 200);
    const terminal = event(4, 'unknown');
    assert.equal((await f.api('/api/v1/node/events', 'POST', terminal, f.installationSecret)).status, 200);
    assert.equal((await f.api('/api/v1/node/events', 'POST', terminal, f.installationSecret)).data.duplicate, true);
    const result = (await f.api(`/api/v1/operations/${operation.id}`, 'GET', undefined, f.token)).data;
    assert.equal(result.execution, 'succeeded'); assert.equal(JSON.parse(result.result_json).reconciliationId, reconciliation.reconciliationId);
    assert.equal((await f.api(`/api/v1/operations/${operation.id}/events`, 'GET', undefined, f.token)).data.events.at(-1).kind, 'unknown');
    assert.equal((await f.api('/api/v1/node/events', 'POST', event(5, 'running'), f.installationSecret)).status, 409);
  } finally { await f.cleanup(); }
});

test('a newer persistent schema is rejected without silently downgrading its version', async () => {
  const f = await fixture();
  try {
    f.store.db.exec('PRAGMA user_version=12');await f.stop();
    assert.throws(() => new ReachStore(f.database), /newer than/);
    const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(f.database,{readOnly:true});try{assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version,12);}finally{db.close();}
  } finally { await f.cleanup(); }
});

test('operations pagination supports limit, offset, filters, Chinese/UUID search, and protects linked or non-terminal operations on delete', async () => {
  const f = await fixture();
  try {
    const baseTime = Date.now() - 60_000;
    const createOp = async (command: Record<string, unknown>, at: number) => {
      const res = await f.api('/api/v1/operations', 'POST', { requestId: randomUUID(), nodeId: f.nodeId, command }, f.token);
      assert.equal(res.status, 201);
      f.store.db.prepare('UPDATE operations SET created_at=? WHERE id=?').run(at, res.data.id);
      return res.data;
    };

    const dirOp = await createOp({ kind: 'file.read', path: 'C:\\test.txt', offset: 0, length: 64 }, baseTime);
    f.store.db.prepare("UPDATE operations SET delivery='acknowledged', execution='failed' WHERE id=?").run(dirOp.id);

    const unknownTarget = await createOp({ kind: 'command.run', command: 'cmd-unknown', timeoutMs: 1000 }, baseTime + 1000);
    const claimUnknown = (await f.api('/api/v1/node/poll', 'POST', { version: 'test', capabilities: ['command.run'] }, f.installationSecret)).data.operation;
    assert.equal(claimUnknown.operationId, unknownTarget.id);
    assert.equal((await f.api('/api/v1/node/events', 'POST', { eventId: randomUUID(), operationId: unknownTarget.id, dispatchId: claimUnknown.dispatchId, payloadHash: claimUnknown.payloadHash, sequence: 1, kind: 'unknown', data: { reason: 'interrupted' } }, f.installationSecret)).status, 200);

    const cancelTarget = await createOp({ kind: 'command.run', command: 'cmd-cancel', timeoutMs: 1000 }, baseTime + 2000);
    const claimCancel = (await f.api('/api/v1/node/poll', 'POST', { version: 'test', capabilities: ['command.run'] }, f.installationSecret)).data.operation;
    assert.equal(claimCancel.operationId, cancelTarget.id);
    assert.equal((await f.api('/api/v1/node/events', 'POST', { eventId: randomUUID(), operationId: cancelTarget.id, dispatchId: claimCancel.dispatchId, payloadHash: claimCancel.payloadHash, sequence: 1, kind: 'unknown', data: { reason: 'lost' } }, f.installationSecret)).status, 200);
    assert.equal((await f.api(`/api/v1/operations/${cancelTarget.id}/reconcile`, 'POST', { reconciliationId: randomUUID(), dispatchId: claimCancel.dispatchId, payloadHash: claimCancel.payloadHash, decision: 'not_executed', evidence: 'verified stopped', result: { started: false } }, f.token)).status, 200);

    const protectedOp = await createOp({ kind: 'command.run', command: 'cmd-protected', timeoutMs: 1000 }, baseTime + 3000);
    f.store.db.prepare("UPDATE operations SET delivery='acknowledged', execution='succeeded' WHERE id=?").run(protectedOp.id);
    f.store.db.prepare('INSERT INTO agent_runs(parent_id, run_id) VALUES (?, ?)').run(protectedOp.id, 'run-protect-1');

    const unknownOp = await createOp({ kind: 'command.run', command: 'cmd-running', timeoutMs: 1000 }, baseTime + 4000);
    f.store.db.prepare("UPDATE operations SET delivery='claimed', execution='running' WHERE id=?").run(unknownOp.id);

    for (let i = 0; i < 19; i++) {
      const doneOp = await createOp({ kind: 'command.run', command: `cmd-done-${i}`, timeoutMs: 1000 }, baseTime + (5 + i) * 1000);
      f.store.db.prepare("UPDATE operations SET delivery='acknowledged', execution='succeeded' WHERE id=?").run(doneOp.id);
    }

    const page1 = await f.api('/api/v1/operations?limit=20&offset=0', 'GET', undefined, f.token);
    assert.equal(page1.status, 200);
    assert.equal(page1.data.total, 24);
    assert.equal(page1.data.operations.length, 20);
    assert.deepEqual(page1.data.counts, { all: 24, active: 1, attention: 1, done: 22 });
    assert.deepEqual(page1.data.summary, { succeeded: 20, activeOnly: 1, failedCancelled: 2, attention: 1 });
    assert.equal(page1.data.operations.find((o: any) => o.id === unknownOp.id)?.protected, true);

    const page2 = await f.api('/api/v1/operations?limit=20&offset=20', 'GET', undefined, f.token);
    assert.equal(page2.status, 200);
    assert.equal(page2.data.operations.length, 4);
    const page1Ids = new Set(page1.data.operations.map((o: any) => o.id));
    for (const o of page2.data.operations) assert.equal(page1Ids.has(o.id), false);

    const cnSearch = await f.api(`/api/v1/operations?filter=done&q=${encodeURIComponent('读取文件')}`, 'GET', undefined, f.token);
    assert.equal(cnSearch.data.total, 1);
    assert.equal(cnSearch.data.operations[0].id, dirOp.id);
    assert.equal((await f.api('/api/v1/operations?q=test-node', 'GET', undefined, f.token)).data.total, 24);
    assert.equal((await f.api(`/api/v1/operations?q=${encodeURIComponent(dirOp.id.slice(0, 8))}`, 'GET', undefined, f.token)).data.total, 1);
    assert.equal((await f.api(`/api/v1/operations?q=${encodeURIComponent('test%_none')}`, 'GET', undefined, f.token)).data.total, 0);

    // CSRF rejection on cookie-authenticated DELETE.
    assert.equal((await f.api(`/api/v1/operations/${cancelTarget.id}`, 'DELETE', undefined, undefined, { cookie: `reach_session=${f.token}`, origin: 'https://evil.example' })).status, 403);
    // Active / unknown / Agent-linked operations remain protected (409).
    const activeDel = await f.api(`/api/v1/operations/${unknownOp.id}`, 'DELETE', undefined, f.token);
    assert.equal(activeDel.status, 409);
    assert.equal(activeDel.data.error.code, 'operation_protected');
    assert.equal((await f.api(`/api/v1/operations/${unknownTarget.id}`, 'DELETE', undefined, f.token)).status, 409);
    assert.equal((await f.api(`/api/v1/operations/${protectedOp.id}`, 'DELETE', undefined, f.token)).status, 409);

    // Deleting a reconciled standalone operation succeeds, removes children & deducts counts + stats.
    const statsBefore = (await f.api('/api/v1/stats', 'GET', undefined, f.token)).data.totals.operations;
    const deleted = await f.api(`/api/v1/operations/${cancelTarget.id}`, 'DELETE', undefined, f.token);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.data.deleted, true);
    assert.equal((await f.api(`/api/v1/operations/${cancelTarget.id}`, 'GET', undefined, f.token)).status, 404);
    assert.equal((await f.api('/api/v1/operations?limit=20&offset=0', 'GET', undefined, f.token)).data.total, 23);
    assert.equal((await f.api('/api/v1/stats', 'GET', undefined, f.token)).data.totals.operations, statsBefore - 1);

    // Separate user must see 404, not delete.
    const uid = randomUUID();
    f.store.db.prepare('INSERT INTO users SELECT ?,?,?,password_hash FROM users LIMIT 1').run(uid, 'other-op-user', 'salt');
    f.store.db.prepare('UPDATE sessions SET user_id=? WHERE user_id=?').run(uid, f.store.session(f.token).id);
    assert.equal((await f.api(`/api/v1/operations/${dirOp.id}`, 'DELETE', undefined, f.token)).status, 404);
  } finally { await f.cleanup(); }
});

test('operations cleanup previews and removes matching standalone terminal operations while skipping protected rows', async () => {
  const f = await fixture();
  try {
    const DAY = 86_400_000;
    const now = Date.now();
    const created: any[] = [];
    for (let i = 0; i < 5; i++) created.push((await f.enqueue()).operation);
    const [failedRecent, cancelledOld, succeededOld, protectedVeryOld, uncertainOld] = created;
    f.store.db.prepare("UPDATE operations SET delivery='acknowledged', execution='failed', created_at=? WHERE id=?").run(now - 2 * DAY, failedRecent.id);
    f.store.db.prepare("UPDATE operations SET delivery='cancelled', execution='cancelled', created_at=? WHERE id=?").run(now - 10 * DAY, cancelledOld.id);
    f.store.db.prepare("UPDATE operations SET delivery='acknowledged', execution='succeeded', created_at=? WHERE id=?").run(now - 10 * DAY, succeededOld.id);
    f.store.db.prepare("UPDATE operations SET delivery='acknowledged', execution='succeeded', created_at=? WHERE id=?").run(now - 40 * DAY, protectedVeryOld.id);
    f.store.db.prepare("UPDATE operations SET delivery='uncertain', execution='not_observed', created_at=? WHERE id=?").run(now - 40 * DAY, uncertainOld.id);
    f.store.db.prepare('INSERT INTO agent_runs(parent_id, run_id) VALUES (?, ?)').run(protectedVeryOld.id, 'run-protect-cleanup');

    const pFail = await f.api('/api/v1/operations/cleanup?scope=failed_cancelled', 'GET', undefined, f.token);
    assert.equal(pFail.status, 200);
    assert.deepEqual(pFail.data, { scope: 'failed_cancelled', matched: 2, deletable: 2, skippedProtected: 0, alwaysKept: 1 });

    const p7 = await f.api('/api/v1/operations/cleanup?scope=older_7d', 'GET', undefined, f.token);
    assert.deepEqual(p7.data, { scope: 'older_7d', matched: 3, deletable: 2, skippedProtected: 1, alwaysKept: 1 });

    const p30 = await f.api('/api/v1/operations/cleanup?scope=older_30d', 'GET', undefined, f.token);
    assert.deepEqual(p30.data, { scope: 'older_30d', matched: 1, deletable: 0, skippedProtected: 1, alwaysKept: 1 });

    assert.equal((await f.api('/api/v1/operations/cleanup', 'POST', { scope: 'failed_cancelled' }, undefined, { cookie: `reach_session=${f.token}`, origin: 'https://evil.example' })).status, 403);

    const cleanFail = await f.api('/api/v1/operations/cleanup', 'POST', { scope: 'failed_cancelled' }, f.token);
    assert.equal(cleanFail.status, 200);
    assert.deepEqual(cleanFail.data, { scope: 'failed_cancelled', matched: 2, deleted: 2, skippedProtected: 0 });

    const cleanDone = await f.api('/api/v1/operations/cleanup', 'POST', { scope: 'done' }, f.token);
    assert.equal(cleanDone.status, 200);
    assert.deepEqual(cleanDone.data, { scope: 'done', matched: 2, deleted: 1, skippedProtected: 1 });

    const remaining = await f.api('/api/v1/operations', 'GET', undefined, f.token);
    assert.deepEqual(remaining.data.operations.map((o: any) => o.id).sort(), [protectedVeryOld.id, uncertainOld.id].sort());
  } finally { await f.cleanup(); }
});

test('7-day rolling retention prunes expired standalone terminal records on startup and timer while keeping recent and protected rows', async () => {
  const f = await fixture();
  let extraServer: ReturnType<typeof reachServer> | undefined;
  try {
    const DAY = 86_400_000;
    const now = Date.now();
    const created: any[] = [];
    for (let i = 0; i < 6; i++) created.push((await f.enqueue()).operation);
    const [expiredOk, expiredFail, expiredLinked, expiredUncertain, expiredUnknown, recentOk] = created;
    f.store.db.prepare("UPDATE operations SET delivery='acknowledged', execution='succeeded', created_at=?, updated_at=? WHERE id=?").run(now - 8 * DAY, now - 8 * DAY, expiredOk.id);
    f.store.db.prepare("UPDATE operations SET delivery='acknowledged', execution='failed', created_at=?, updated_at=? WHERE id=?").run(now - 9 * DAY, now - 9 * DAY, expiredFail.id);
    f.store.db.prepare("UPDATE operations SET delivery='acknowledged', execution='succeeded', created_at=?, updated_at=? WHERE id=?").run(now - 10 * DAY, now - 10 * DAY, expiredLinked.id);
    f.store.db.prepare(
      'INSERT INTO starferry_tunnels(tunnel_session_id,user_id,node_id,epoch,operation_id,grant_id,allow_direct,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(randomUUID(), f.store.session(f.token).id, f.nodeId, 1, expiredLinked.id, randomUUID(), 1, 'closed', now - 10 * DAY, now + 60_000);
    f.store.db.prepare("UPDATE operations SET delivery='uncertain', execution='succeeded', created_at=?, updated_at=? WHERE id=?").run(now - 10 * DAY, now - 10 * DAY, expiredUncertain.id);
    f.store.db.prepare("UPDATE operations SET delivery='acknowledged', execution='unknown', created_at=?, updated_at=? WHERE id=?").run(now - 10 * DAY, now - 10 * DAY, expiredUnknown.id);
    f.store.db.prepare("UPDATE operations SET delivery='acknowledged', execution='succeeded', created_at=?, updated_at=? WHERE id=?").run(now - 6 * DAY, now - 6 * DAY, recentOk.id);

    // Stop initial server and reopen the same database so startup + rolling timer run against pre-existing data.
    await f.stop();
    const store2 = new ReachStore(f.database);
    let currentTime = now;
    store2.now = () => currentTime;
    extraServer = reachServer({
      store: store2,
      publicOrigin: 'http://127.0.0.1',
      allowInsecureLoopback: true,
      operationRetentionDays: 7,
      operationPruneIntervalMs: 20,
    });

    const idsAfterStart = (store2.db.prepare('SELECT id FROM operations').all() as { id: string }[]).map(r => r.id).sort();
    assert.deepEqual(idsAfterStart, [expiredLinked.id, expiredUncertain.id, expiredUnknown.id, recentOk.id].sort());

    // Advance virtual clock past 7 days for recentOk and wait for rolling interval execution.
    currentTime = now + 2 * DAY;
    await new Promise(resolve => setTimeout(resolve, 90));
    const idsAfterTick = (store2.db.prepare('SELECT id FROM operations').all() as { id: string }[]).map(r => r.id).sort();
    assert.deepEqual(idsAfterTick, [expiredLinked.id, expiredUncertain.id, expiredUnknown.id].sort());
  } finally {
    await extraServer?.shutdown();
    await f.cleanup();
  }
});
