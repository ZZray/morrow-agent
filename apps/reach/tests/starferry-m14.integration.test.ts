// Copyright (c) Ray Zhang. End-to-end M14 verification (REQ-01):
// Starferry merged into Reach — real Windows OpenSSH `ssh.exe` over UDP Direct (`RY.Starferry.Direct.v1`),
// explicit Cloud Relay (`allowDirect: false`), unreachable-UDP automatic fallback, and mid-stream interruption zero-auto-replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { loadConfig, controllerDirectory, ReachClient } from '../src/controller/client.ts';
import { openStarferryTunnel } from '../src/controller/starferry.ts';
import { fixture, until, kill, executable } from './native-fixture.ts';
import { startSsh2FixtureServer } from './ssh2-server-fixture.ts';

const ryreachExe = join(dirname(executable), process.platform === 'win32' ? 'ryreach.exe' : 'ryreach');
const systemSsh = process.platform === 'win32'
  ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
  : 'ssh';

const mcpExecResultSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'unknown']),
  selectedPath: z.enum(['udp_direct', 'cloud_relay']),
  replayed: z.literal(false),
  exitCode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  tunnelSessionId: z.string(),
  operationId: z.string(),
  targetHostKey: z.string(),
});

const sessionReceiptSchema = z.object({
  tunnelSessionId: z.string(),
  grantId: z.string(),
  directEnabled: z.boolean(),
  directStreams: z.number(),
  relayStreams: z.number(),
  sshKeyRevoked: z.boolean(),
});

test('M14: Starferry real ssh.exe over UDP Direct, explicit Cloud Relay, unreachable-UDP fallback, and mid-stream interruption zero auto-replay', { timeout: 150000 }, async () => {
  assert.equal(existsSync(systemSsh), true, `missing ${systemSsh}`);
  // This suite isolates host-candidate transport. STUN has dedicated UDP fixtures.
  const oldStun = process.env.REACH_STUN_SERVER;
  process.env.REACH_STUN_SERVER = '';
  const f = await fixture();
  const authKeysPath = join(f.root, 'starferry_authorized_keys');
  const baseKeys = '# Existing non-Reach key\r\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg keep@host\r\n';
  writeFileSync(authKeysPath, baseKeys, 'utf8');

  const executedCommands: string[] = [];
  let onMidExecHook: (() => Promise<void>) | null = null;

  const sshServer = await startSsh2FixtureServer({
    authorizedKeysPath: authKeysPath,
    expectedUser: 'sfoperator',
    onExec: async cmd => {
      executedCommands.push(cmd);
      if (cmd === 'slow-midstream-op' && onMidExecHook) {
        await onMidExecHook();
      }
      return { stdout: `SF_OUT:${cmd}`, exitCode: 0 };
    },
  });

  let mcpChild: ReturnType<typeof f.mcp> | undefined;
  let host: ReturnType<typeof spawn> | undefined;
  let hostDone: Promise<unknown[]> | undefined;

  try {
    assert.equal((await f.loginController()).code, 0);
    assert.equal((await f.pair()).code, 0);
    const nodeId = f.identity().node_id!;

    const devSshEnv = {
      REACH_DEV_SSH_CONFIG_JSON: JSON.stringify({
        port: sshServer.port,
        user: 'sfoperator',
        hostKey: sshServer.hostPublicKeyLine,
        authorizedKeysPath: authKeysPath,
        sharedAdminKeys: false,
        ready: true,
      }),
    };
    host = spawn(executable, ['--state-dir', f.state, 'host'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', ...devSshEnv },
    });
    hostDone = once(host, 'close');

    await until(async () => {
      const nodes = z.object({ nodes: z.array(z.object({ id: z.string(), capabilities: z.array(z.string()) })) }).parse(await f.request('/api/v1/nodes'));
      return nodes.nodes.some(n => n.id === nodeId && n.capabilities.includes('starferry.session'));
    }, Boolean);

    mcpChild = f.mcp();
    await mcpChild.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'm14-starferry', version: '1' } });

    // 1. Real `reach_ssh_exec` over UDP Direct (`allowDirect: true`)
    const directCall = await mcpChild.call('tools/call', {
      name: 'reach_ssh_exec',
      arguments: {
        requestId: randomUUID(),
        nodeId,
        command: 'uname-direct-check',
        allowDirect: true,
        timeoutMs: 20000,
      },
    });
    assert.notEqual(directCall.result.isError, true, JSON.stringify(directCall.result));
    const directRes = mcpExecResultSchema.parse(JSON.parse(directCall.result.content[0].text));
    assert.equal(directRes.status, 'succeeded');
    assert.equal(directRes.selectedPath, 'udp_direct');
    assert.equal(directRes.exitCode, 0);
    assert.equal(directRes.stdout, 'SF_OUT:uname-direct-check');
    assert.equal(directRes.targetHostKey, sshServer.hostPublicKeyLine);

    const directOpSettled = await f.settled(directRes.operationId);
    assert.equal(directOpSettled.execution, 'succeeded');
    const directReceipt = sessionReceiptSchema.parse(JSON.parse(directOpSettled.result_json));
    assert.equal(directReceipt.directStreams, 1);
    assert.equal(directReceipt.relayStreams, 0);
    assert.equal(directReceipt.sshKeyRevoked, true);
    assert.equal(readFileSync(authKeysPath, 'utf8').includes('ry-reach:'), false, 'ephemeral Starferry session key must be revoked on close');
    assert.equal(readFileSync(authKeysPath, 'utf8').includes('keep@host'), true);

    // 2. Explicit `allowDirect: false` routes real `ssh.exe` over Cloud Relay (`selectedPath: 'cloud_relay'`)
    const relayCall = await mcpChild.call('tools/call', {
      name: 'reach_ssh_exec',
      arguments: {
        requestId: randomUUID(),
        nodeId,
        command: 'uname-relay-check',
        allowDirect: false,
        timeoutMs: 20000,
      },
    });
    assert.notEqual(relayCall.result.isError, true, JSON.stringify(relayCall.result));
    const relayRes = mcpExecResultSchema.parse(JSON.parse(relayCall.result.content[0].text));
    assert.equal(relayRes.status, 'succeeded');
    assert.equal(relayRes.selectedPath, 'cloud_relay');
    assert.equal(relayRes.exitCode, 0);
    assert.equal(relayRes.stdout, 'SF_OUT:uname-relay-check');

    const relayOpSettled = await f.settled(relayRes.operationId);
    assert.equal(relayOpSettled.execution, 'succeeded');
    const relayReceipt = sessionReceiptSchema.parse(JSON.parse(relayOpSettled.result_json));
    assert.equal(relayReceipt.directStreams, 0);
    assert.equal(relayReceipt.relayStreams, 1);
    assert.equal(relayReceipt.sshKeyRevoked, true);

    // 3. Mid-Stream UDP Direct Interruption:
    //    - Stream 1 starts over `udp_direct`, UDP is severed mid-stream -> settles as `unknown` with ZERO auto-replay!
    //    - Subsequent Stream 2 on the SAME tunnel session automatically falls back to `cloud_relay` and succeeds!
    const ctrlDir = join(f.root, 'controller');
    const client = new ReachClient(loadConfig(ctrlDir), controllerDirectory());
    const tunnel = await openStarferryTunnel(client, { nodeId, allowDirect: true, ttlSeconds: 120 });
    try {
      assert.equal(tunnel.currentPath(), 'udp_direct');

      // First verify normal stream on this multi-stream tunnel
      const s0 = await tunnel.execSsh('pre-sever-stream');
      assert.equal(s0.status, 'succeeded', JSON.stringify(s0));
      assert.equal(s0.selectedPath, 'udp_direct');
      assert.equal(s0.stdout, 'SF_OUT:pre-sever-stream');

      const s1 = await tunnel.execSsh('second-normal-stream');
      assert.equal(s1.status, 'succeeded', JSON.stringify(s1));
      assert.equal(s1.selectedPath, 'udp_direct');
      assert.equal(s1.stdout, 'SF_OUT:second-normal-stream');

      // Sever only after the SSH server received the command. Its effect is real,
      // but the client cannot receive the result and must not replay it on relay.
      const countBefore = executedCommands.filter(c => c === 'slow-midstream-op').length;
      onMidExecHook = async () => { tunnel.severDirectForTest(); };
      const broken = await tunnel.execSsh('slow-midstream-op', 6000);
      assert.equal(broken.status, 'unknown');
      assert.equal(broken.selectedPath, 'udp_direct');
      assert.equal(broken.replayed, false);
      const countAfter = executedCommands.filter(c => c === 'slow-midstream-op').length;
      assert.equal(countAfter, countBefore + 1, 'executed command must NEVER auto-replay on cloud_relay');

      // Subsequent new stream on the same tunnel automatically uses Cloud Relay fallback!
      assert.equal(tunnel.currentPath(), 'cloud_relay');
      const fallbackStream = await tunnel.execSsh('post-sever-relay-stream', 20000);
      assert.equal(fallbackStream.status, 'succeeded');
      assert.equal(fallbackStream.selectedPath, 'cloud_relay');
      assert.equal(fallbackStream.stdout, 'SF_OUT:post-sever-relay-stream');
    } finally {
      await tunnel.close();
    }

    // Wait for tunnel operation to settle and confirm all temporary SSH keys are cleaned
    const settledMulti = await f.settled(tunnel.operationId);
    assert.equal(settledMulti.execution, 'succeeded');
    await sleep(100);
    assert.equal(readFileSync(authKeysPath, 'utf8').includes('ry-reach:'), false);
    assert.equal(readFileSync(authKeysPath, 'utf8').includes('keep@host'), true);

    // Advertise unreachable candidates at both ends, so negotiation really times
    // out before a fresh command executes successfully through Cloud Relay.
    const blackhole = createSocket('udp4');
    blackhole.bind(0, '127.0.0.1');
    await once(blackhole, 'listening');
    const unreachable = [{ host: '127.0.0.1', port: blackhole.address().port, kind: 'host' as const }];
    f.intercept(async (request, response, _bytes, forward) => {
      if (!/^\/api\/v1\/tunnels(?:\/[^/]+)?$/.test(request.url ?? '')) return false;
      const upstream = await forward();
      const body = await upstream.json();
      response.writeHead(upstream.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...body, nodeCandidates: unreachable }));
      return true;
    });
    try {
      const unavailable = await openStarferryTunnel(client, { nodeId, overrideCandidates: unreachable, directNegotiationTimeoutMs: 200 });
      f.intercept();
      try {
        assert.equal(unavailable.currentPath(), 'cloud_relay');
        const result = await unavailable.execSsh('unreachable-udp-relay');
        assert.equal(result.status, 'succeeded', JSON.stringify(result));
        assert.equal(result.selectedPath, 'cloud_relay');
        assert.equal(result.stdout, 'SF_OUT:unreachable-udp-relay');
      } finally { await unavailable.close(); }
      const receipt = sessionReceiptSchema.parse(JSON.parse((await f.settled(unavailable.operationId)).result_json));
      assert.equal(receipt.directStreams, 0);
      assert.equal(receipt.relayStreams, 1);
      assert.equal(receipt.sshKeyRevoked, true);
    } finally {
      f.intercept();
      blackhole.close();
    }

    const stopChild = spawn(ryreachExe, ['--state-dir', f.state, 'host-stop'], { windowsHide: true, stdio: 'ignore' });
    const [stopCode] = await once(stopChild, 'close');
    assert.equal(stopCode, 0);
    const [hostCode] = await hostDone;
    assert.equal(hostCode, 0);
  } finally {
    onMidExecHook = null;
    if (mcpChild) {
      mcpChild.child.stdin?.end();
      await kill(mcpChild.child);
    }
    await kill(host);
    await sshServer.close();
    await f.cleanup();
    if (oldStun === undefined) delete process.env.REACH_STUN_SERVER; else process.env.REACH_STUN_SERVER = oldStun;
  }
});
