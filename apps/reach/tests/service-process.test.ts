// Copyright (c) Ray Zhang. Actual service process termination and restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

test('ordinary service process retains pairing, sessions, claimed operation and original result across forced restart', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reach-process-'));
  let child: ChildProcess | undefined;
  let origin = '';
  async function start() {
    child = spawn(process.execPath, ['src/service/main.ts'], {
      cwd: resolve(import.meta.dirname, '..'), windowsHide: true,
      env: { ...process.env, REACH_DATA_DIR: directory, REACH_PORT: '0', REACH_DEVELOPMENT: '1', REACH_PUBLIC_ORIGIN: 'http://127.0.0.1', REACH_BOOTSTRAP_USERNAME: 'process-test', REACH_BOOTSTRAP_PASSWORD: 'process-test-fixture-password', REACH_TRUSTED_PROXY_ADDRESSES: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout! });
    let stderr = '';
    child.stderr!.on('data', data => { stderr = (stderr + String(data)).slice(-8192); });
    const timer = setTimeout(() => child?.kill(), 15000);
    try {
      for await (const line of lines) {
        const data = JSON.parse(line);
        if (data.event === 'reach_listening') { origin = `http://127.0.0.1:${data.port}`; return; }
      }
      throw new Error(`Service exited before listening: ${stderr}`);
    } finally { clearTimeout(timer); lines.close(); }
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
    child = undefined;
  }
  async function api(path: string, method = 'GET', input?: unknown, token?: string) {
    const response = await fetch(origin + path, { method, headers: { ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: input === undefined ? undefined : JSON.stringify(input) });
    const value = await response.json() as any;
    assert.ok(response.ok, JSON.stringify(value)); return value;
  }
  try {
    await start();
    assert.equal((await api('/healthz')).service, 'Reach');
    const session = await api('/api/v1/auth/login', 'POST', { username: 'process-test', password: 'process-test-fixture-password' });
    const code = await api('/api/v1/pairing-codes', 'POST', {}, session.token);
    const token = randomBytes(32).toString('base64url');
    const paired = await api('/api/v1/node/pair', 'POST', { attemptId: randomUUID(), code: code.code, installationId: randomUUID(), installationSecret: token, name: 'process-node', platform: 'windows', version: 'fixture' });
    const hello = { version: 'fixture', capabilities: ['command.run'] };
    await api('/api/v1/node/poll', 'POST', hello, token);
    const op = await api('/api/v1/operations', 'POST', { requestId: randomUUID(), nodeId: paired.nodeId, command: { kind: 'command.run', command: 'fixture-not-executed', timeoutMs: 1000 } }, session.token);
    const claimed = (await api('/api/v1/node/poll', 'POST', hello, token)).operation;
    await stop(); await start();
    assert.equal((await api('/api/v1/node/poll', 'POST', hello, token)).operation, null);
    assert.equal((await api('/api/v1/node/pending', 'GET', undefined, token)).operations[0].id, op.id);
    for (const [index, kind] of ['received', 'running', 'succeeded'].entries()) {
      await api('/api/v1/node/events', 'POST', { eventId: randomUUID(), operationId: op.id, dispatchId: claimed.dispatchId, payloadHash: claimed.payloadHash, sequence: index + 1, kind, data: kind === 'succeeded' ? { fixture: true, exitCode: 0 } : {} }, token);
    }
    await stop(); await start();
    const result = await api(`/api/v1/operations/${op.id}`, 'GET', undefined, session.token);
    assert.equal(result.execution, 'succeeded');
    assert.equal(JSON.parse(result.result_json).fixture, true);
    assert.equal((await api(`/api/v1/operations/${op.id}/events`, 'GET', undefined, session.token)).events.length, 3);
    assert.equal((await api('/api/v1/node/poll', 'POST', hello, token)).operation, null);
  } finally {
    await stop();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('reach-process-'));
    rmSync(directory, { recursive: true, force: true });
  }
});
