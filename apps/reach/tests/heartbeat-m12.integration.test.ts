// Copyright (c) Ray Zhang. End-to-end M12 verification (REQ-04):
// decoupled control vs minute-level heartbeat, remote heartbeat config + pending/applied receipts,
// lost config receipt ACK recovery, bounded exponential offline backoff, and zero unknown replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { fixture, until, delay, kill, ps, executable } from './native-fixture.ts';

const ryreachExe = join(dirname(executable), process.platform === 'win32' ? 'ryreach.exe' : 'ryreach');

test('M12: pending receipt failures enter resident backoff and recover without executing the operation again', { timeout: 40000 }, async () => {
  const f = await fixture('', {
    ...process.env,
    NO_PROXY: '127.0.0.1,localhost',
    REACH_DEV_BACKOFF_BASE_MS: '250',
    REACH_DEV_BACKOFF_CAP_MS: '1000',
  });
  let outage = true;
  const attempts: number[] = [];
  try {
    f.intercept(async (req, res, bytes) => {
      if (req.url === '/api/v1/node/events' && outage) {
        const event = z.object({ kind: z.string() }).passthrough().parse(JSON.parse(bytes.toString('utf8')));
        if (event.kind === 'running') {
          attempts.push(Date.now());
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'receipt_outage' } }));
          return true;
        }
      }
      return false;
    });
    assert.equal((await f.pair()).code, 0);
    const host = f.node('host');
    const effect = join(f.root, 'receipt-effect.txt');
    const operation = await f.submit({
      kind: 'command.run',
      command: `Start-Sleep -Milliseconds 700; [IO.File]::AppendAllText(${ps(effect)}, 'once')`,
      timeoutMs: 10000,
    });
    await until(async () => attempts.length, count => count >= 3);
    const state = await until(async () => {
      const result = await runRyreach(f.state, ['config', 'show']);
      assert.equal(result.code, 0, result.stderr);
      return localConfigSchema.parse(JSON.parse(result.stdout)).resident;
    }, value => value.state === 'offline_backoff', 3000);
    assert.ok((state.backoffAttempt ?? 0) >= 2);
    assert.ok((state.nextRetryAtMs ?? 0) > Date.now());
    assert.ok(attempts[1] - attempts[0] >= 200, 'receipt retries must use the bounded scheduler');
    assert.ok(attempts[2] - attempts[1] >= 400, 'receipt retry delay must increase after repeated failures');
    const db = new DatabaseSync(join(f.state, 'node.sqlite'), { readOnly: true });
    try {
      const pending = db.prepare('SELECT COUNT(*) AS count FROM outbox WHERE acknowledged=0').get();
      assert.ok(Number(pending?.count) > 0, 'original receipt remains durable during outage');
    } finally { db.close(); }
    outage = false;
    assert.equal((await f.settled(operation.id)).execution, 'succeeded');
    await until(async () => localConfigSchema.parse(JSON.parse((await runRyreach(f.state, ['config', 'show'])).stdout)).resident.state,
      value => value === 'connected');
    assert.equal(readFileSync(effect, 'utf8'), 'once');
    assert.equal((await runRyreach(f.state, ['host-stop'])).code, 0);
    assert.equal((await host.done).code, 0);
  } finally {
    await f.cleanup();
  }
});

const runtimeViewSchema = z.object({
  id: z.string(),
  epoch: z.number(),
  online: z.boolean(),
  lastHeartbeatAt: z.number().nullable(),
  effectiveHeartbeatSeconds: z.number(),
  effectiveConfigVersion: z.number(),
  desiredConfig: z.object({
    requestId: z.string(),
    targetVersion: z.number(),
    heartbeatIntervalSeconds: z.number(),
    status: z.enum(['pending', 'applied', 'rejected']),
    receipt: z.object({
      requestId: z.string(),
      targetVersion: z.number(),
      status: z.string(),
      effectiveHeartbeatSeconds: z.number(),
    }).nullable(),
  }).nullable(),
  configHistory: z.array(z.object({
    targetVersion: z.number(),
    requestId: z.string(),
    status: z.string(),
  })),
});

const localConfigSchema = z.object({
  heartbeat: z.object({
    savedSeconds: z.number(),
    effectiveSeconds: z.number(),
    effectiveConfigVersion: z.number(),
    acknowledgedConfigVersion: z.number(),
    pendingReceipt: z.unknown().nullable(),
  }),
  resident: z.object({
    state: z.string(),
    backoffAttempt: z.number().optional(),
    nextRetryAtMs: z.number().nullable().optional(),
  }),
});

async function runRyreach(stateDir: string, args: string[]) {
  const child = spawn(ryreachExe, ['--state-dir', stateDir, ...args], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', chunk => { stdout += chunk; });
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  return { code: typeof code === 'number' ? code : null, stdout: stdout.trim(), stderr: stderr.trim() };
}

test('M12: decoupled control vs minute-level heartbeat, remote config pending/applied, lost receipt recovery, bounded backoff, and zero unknown replay', { timeout: 120000 }, async () => {
  const f = await fixture();
  let mcpChild: ReturnType<typeof f.mcp> | undefined;
  try {
    let heartbeats = 0;
    let polls = 0;
    let outage = false;
    let dropHeartbeatResponseOnce = false;
    let dropPollClaimOnce = false;
    const outageAttemptTimes: number[] = [];

    f.intercept(async (req, res, _bytes, forward) => {
      if (outage && req.url?.startsWith('/api/v1/node/')) {
        outageAttemptTimes.push(Date.now());
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'simulated_network_outage' } }));
        return true;
      }
      if (req.url === '/api/v1/node/heartbeat') {
        heartbeats++;
        if (dropHeartbeatResponseOnce) {
          dropHeartbeatResponseOnce = false;
          const upstream = await forward();
          assert.equal(upstream.status, 200);
          await upstream.arrayBuffer();
          res.destroy();
          return true;
        }
      }
      if (req.url === '/api/v1/node/poll') {
        polls++;
        if (dropPollClaimOnce) {
          const upstream = await forward();
          const bodyBytes = Buffer.from(await upstream.arrayBuffer());
          const bodyJson = z.object({ operation: z.unknown().nullable() }).passthrough().parse(JSON.parse(bodyBytes.toString('utf8')));
          if (bodyJson.operation !== null) {
            dropPollClaimOnce = false;
            outage = true;
            res.destroy();
            return true;
          }
          res.writeHead(upstream.status, { 'content-type': 'application/json' });
          res.end(bodyBytes);
          return true;
        }
      }
      return false;
    });

    assert.equal((await f.loginController()).code, 0);
    assert.equal((await f.pair()).code, 0);
    const nodeId = f.identity().node_id;
    assert.ok(nodeId);

    const host = spawn(executable, ['--state-dir', f.state, 'host'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NO_PROXY: '127.0.0.1,localhost',
        REACH_DEV_BACKOFF_BASE_MS: '250',
        REACH_DEV_BACKOFF_CAP_MS: '750',
      },
    });
    const hostDone = once(host, 'close');

    // 1. Initial connection sends 1 heartbeat, then stays quiet on heartbeat channel while executing immediate commands via poll
    await until(async () => {
      const rt = runtimeViewSchema.parse(await f.request(`/api/v1/nodes/${nodeId}/runtime`));
      return rt.lastHeartbeatAt !== null && rt.effectiveHeartbeatSeconds === 60;
    }, Boolean);
    const initialHeartbeats = heartbeats;
    assert.equal(initialHeartbeats, 1);

    const t0 = Date.now();
    const fastOp = await f.submit({ kind: 'command.run', command: '[Console]::Out.Write("instant-control")', timeoutMs: 10000 });
    assert.equal((await f.settled(fastOp.id)).execution, 'succeeded');
    assert.ok(Date.now() - t0 < 5000, 'immediate command must not wait for 60s heartbeat');
    await delay(1500);
    assert.equal(heartbeats, 1, 'minute-level heartbeat must not fire repeatedly during short poll intervals');
    assert.ok(polls >= 2);

    // 2. Remote heartbeat config update via MCP applies within <2s and records verified receipt
    mcpChild = f.mcp();
    await mcpChild.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'm12-test', version: '1' } });
    const req1Id = randomUUID();
    const cfg1Call = await mcpChild.call('tools/call', {
      name: 'reach_node_config',
      arguments: { nodeId, requestId: req1Id, heartbeatIntervalSeconds: 120 },
    });
    assert.notEqual(cfg1Call.result.isError, true);

    const applied1 = await until(async () => {
      const rtCall = await mcpChild!.call('tools/call', { name: 'reach_node_runtime', arguments: { nodeId } });
      return runtimeViewSchema.parse(JSON.parse(rtCall.result.content[0].text));
    }, rt => rt.effectiveConfigVersion === 1 && rt.effectiveHeartbeatSeconds === 120 && rt.desiredConfig?.status === 'applied');
    assert.equal(applied1.desiredConfig?.receipt?.requestId, req1Id);

    // Idempotent retry of same requestId returns current state without creating version 2
    const cfg1Dup = await mcpChild.call('tools/call', {
      name: 'reach_node_config',
      arguments: { nodeId, requestId: req1Id, heartbeatIntervalSeconds: 120 },
    });
    assert.equal(runtimeViewSchema.parse(JSON.parse(cfg1Dup.result.content[0].text)).effectiveConfigVersion, 1);

    // 3. Controlled outage + lost poll claim + offline config update:
    //    - Lost claim must NEVER execute on reconnect (settles as unknown with replayed: false)
    //    - Dispatched config while offline MUST stay 'pending' (never masquerade as effective!)
    //    - Reconnect scheduler obeys bounded backoff (no tight flood) while keeping resident host alive
    const neverEffect = join(f.root, 'must-never-execute.txt');
    dropPollClaimOnce = true;
    const lostOp = await f.submit({
      kind: 'command.run',
      command: `[IO.File]::WriteAllText(${ps(neverEffect)}, 'executed')`,
      timeoutMs: 30000,
    });

    await until(async () => outage && outageAttemptTimes.length >= 2, Boolean);
    const offlineLocal = localConfigSchema.parse(JSON.parse((await runRyreach(f.state, ['config', 'show'])).stdout));
    assert.equal(offlineLocal.resident.state, 'offline_backoff');
    assert.ok((offlineLocal.resident.backoffAttempt ?? 0) >= 1);

    // Dispatch config v2 while Node is offline!
    const req2Id = randomUUID();
    const offlineDispatched = runtimeViewSchema.parse(
      await f.request(`/api/v1/nodes/${nodeId}/config`, 'POST', { requestId: req2Id, heartbeatIntervalSeconds: 45 }),
    );
    assert.equal(offlineDispatched.effectiveConfigVersion, 1, 'dispatched config while offline must NOT update effectiveConfigVersion');
    assert.equal(offlineDispatched.effectiveHeartbeatSeconds, 120, 'dispatched config while offline must NOT update effectiveHeartbeatSeconds');
    assert.equal(offlineDispatched.desiredConfig?.targetVersion, 2);
    assert.equal(offlineDispatched.desiredConfig?.status, 'pending');

    await delay(1600);
    // In 1600ms with base=250ms, cap=750ms, total attempts during this window cannot flood (must be <= 8)
    assert.ok(outageAttemptTimes.length <= 10, `expected bounded backoff attempts, got ${outageAttemptTimes.length}`);

    // 4. Restore network, drop the FIRST configReceipt HTTP response, and verify automatic receipt reconciliation + zero replay!
    dropHeartbeatResponseOnce = true;
    outage = false;

    const settledLost = await f.settled(lostOp.id);
    assert.equal(settledLost.execution, 'unknown');
    const lostData = z.object({ reason: z.string(), replayed: z.boolean() }).parse(JSON.parse(settledLost.result_json));
    assert.equal(lostData.reason, 'local_receipt_missing');
    assert.equal(lostData.replayed, false);
    assert.equal(existsSync(neverEffect), false, 'lost claim must never be executed on reconnect');

    const convergedService = await until(
      async () => runtimeViewSchema.parse(await f.request(`/api/v1/nodes/${nodeId}/runtime`)),
      rt => rt.effectiveConfigVersion === 2 && rt.effectiveHeartbeatSeconds === 45 && rt.desiredConfig?.status === 'applied',
    );
    assert.equal(convergedService.desiredConfig?.receipt?.requestId, req2Id);

    const convergedLocal = await until(
      async () => localConfigSchema.parse(JSON.parse((await runRyreach(f.state, ['config', 'show'])).stdout)),
      cfg => cfg.heartbeat.acknowledgedConfigVersion === 2 && cfg.heartbeat.pendingReceipt === null && cfg.resident.state === 'connected',
    );
    assert.equal(convergedLocal.heartbeat.effectiveSeconds, 45);

    assert.equal((await runRyreach(f.state, ['host-stop'])).code, 0);
    const [exitCode] = await hostDone;
    assert.equal(exitCode, 0);
  } finally {
    if (mcpChild) {
      mcpChild.child.stdin?.end();
      await kill(mcpChild.child);
    }
    await f.cleanup();
  }
});
