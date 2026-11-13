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

export const password = 'local-test-only-password-32-chars';
export async function fixture(trustedProxy = false) {
  const directory = mkdtempSync(join(tmpdir(), 'reach-test-'));
  const database = join(directory, 'reach.sqlite');
  let store = new ReachStore(database);
  store.bootstrap('ray-test', password);
  const makeServer=()=>reachServer({ store, publicOrigin: 'http://127.0.0.1', allowInsecureLoopback: true, trustedProxyAddresses: trustedProxy ? ['127.0.0.1'] : [] });
  let server = makeServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  async function api(path: string, method = 'GET', input?: unknown, token?: string, extra: Record<string, string> = {}) {
    const response = await fetch(base + path, { method, headers: { connection:'close',...(trustedProxy ? { 'x-reach-client-ip': '192.0.2.1' } : {}), ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: input === undefined ? undefined : JSON.stringify(input) });
    return { status: response.status, headers: response.headers, data: await response.json() as any };
  }
  const login = await api('/api/v1/auth/login', 'POST', { username: 'ray-test', password });
  assert.equal(login.status, 200);
  const token: string = login.data.token;
  const code = await api('/api/v1/pairing-codes', 'POST', {}, token);
  const installationSecret = randomBytes(32).toString('base64url');
  const pairInput = { attemptId: randomUUID(), code: code.data.code, installationId: randomUUID(), installationSecret, name: 'test-node', platform: 'windows', version: '0.1.0-test' };
  const paired = await api('/api/v1/node/pair', 'POST', pairInput);
  assert.equal(paired.status, 200);
  const nodeId: string = paired.data.nodeId;
  await api('/api/v1/node/poll', 'POST', { version: 'test', capabilities: ['command.run', 'file.read'] }, installationSecret);
  async function enqueue() {
    const input = { requestId: randomUUID(), nodeId, command: { kind: 'command.run', command: 'test-command', timeoutMs: 1000 } };
    const result = await api('/api/v1/operations', 'POST', input, token);
    assert.equal(result.status, 201);
    return { input, operation: result.data };
  }
  const stop=async()=>{await server.shutdown();};
  const reopen=async()=>{await stop();store=new ReachStore(database);server=makeServer();server.listen(address.port,'127.0.0.1');await once(server,'listening');};
  const cleanup = async () => {
    await stop();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('reach-test-'));
    rmSync(directory, { recursive: true, force: true });
  };
  return { get store(){return store;}, database, api, token, installationSecret, nodeId, pairInput, enqueue, cleanup,stop,reopen };
}
