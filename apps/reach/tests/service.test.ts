// Copyright (c) Ray Zhang. Exercise the HTTP boundary and persistent ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { once } from 'node:events';
import { ReachStore } from '../src/service/store.ts';
import { reachServer } from '../src/service/server.ts';
import type { OperationEvent } from '../src/contracts/protocol.ts';

import { fixture, password } from './service-fixture.ts';
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
