// Copyright (c) Ray Zhang. Real multi-process verification of M11 (REQ-03 / REQ-05 / REQ-06):
// resident 6-state machine, ryreach interactive init/config, server-switch credential isolation, TLS/offline states, and external preconfigure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { ReachStore } from '../src/service/store.ts';
import { reachServer } from '../src/service/server.ts';
import { fixture, until, executable } from './native-fixture.ts';

const ryreachExe = join(dirname(executable), process.platform === 'win32' ? 'ryreach.exe' : 'ryreach');

const statusSchema = z.object({
  installationId: z.string(),
  nodeId: z.string().nullable(),
  epoch: z.number(),
  server: z.string().nullable(),
  pairingPending: z.boolean(),
  resident: z.object({
    state: z.string(),
    stateLabel: z.string(),
    errorCode: z.string().nullable().optional(),
    errorDetail: z.string().nullable().optional(),
  }),
  config: z.object({
    installationId: z.string(),
    serverUrl: z.string().nullable(),
    paired: z.boolean(),
    serverGeneration: z.number(),
  }),
  host: z.object({
    pid: z.number(),
    phase: z.number(),
    stopping: z.boolean(),
  }).optional(),
});

async function runRyreach(
  stateDir: string,
  args: string[],
  options?: { stdin?: string; env?: Record<string, string> },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(ryreachExe, ['--state-dir', stateDir, ...args], {
    windowsHide: true,
    stdio: [options?.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', ...options?.env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', chunk => { stdout += chunk; });
  child.stderr!.on('data', chunk => { stderr += chunk; });
  if (options?.stdin !== undefined && child.stdin) {
    child.stdin.end(options.stdin);
  }
  const [code] = await once(child, 'close');
  return { code: typeof code === 'number' ? code : null, stdout: stdout.trim(), stderr: stderr.trim() };
}

// Minimal DER X.509 v3 self-signed certificate generator using Node built-in crypto (zero external tools).
function derLen(len: number): Buffer {
  if (len < 128) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function derTag(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
}
function selfSignedTlsCredentials(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const algId = derTag(0x30, derTag(0x06, Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]))); // ecdsa-with-SHA256
  const cnAttr = derTag(0x31, derTag(0x30, Buffer.concat([
    derTag(0x06, Buffer.from([0x55, 0x04, 0x03])),
    derTag(0x0c, Buffer.from('127.0.0.1')),
  ])));
  const name = derTag(0x30, cnAttr);
  const validity = derTag(0x30, Buffer.concat([
    derTag(0x17, Buffer.from('250101000000Z')),
    derTag(0x17, Buffer.from('350101000000Z')),
  ]));
  const tbs = derTag(0x30, Buffer.concat([
    derTag(0xa0, derTag(0x02, Buffer.from([0x02]))),
    derTag(0x02, Buffer.from([0x01])),
    algId,
    name,
    validity,
    name,
    spki,
  ]));
  const signer = createSign('SHA256');
  signer.update(tbs);
  const sig = signer.sign(privateKey);
  const bitString = derTag(0x03, Buffer.concat([Buffer.from([0x00]), sig]));
  const certDer = derTag(0x30, Buffer.concat([tbs, algId, bitString]));
  const pemBody = certDer.toString('base64').match(/.{1,64}/g)!.join('\n');
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${pemBody}\n-----END CERTIFICATE-----\n`,
  };
}

test('M11: resident unconfigured host never blocks stdin, interactive ryreach initializes once, positional pair connects, and server switch isolates credentials', { timeout: 120000 }, async () => {
  assert.equal(existsSync(ryreachExe), true, `missing ${ryreachExe}`);
  const f = await fixture();
  let serverB: ReturnType<typeof reachServer> | undefined;
  let storeB: ReachStore | undefined;
  try {
    // 1. Start resident host with stdin ignored; verify awaiting_initialization & zero outbound polls
    let serverAPolls = 0;
    f.intercept(async req => {
      if (req.url?.startsWith('/api/v1/node/')) serverAPolls++;
      return false;
    });
    const host = f.node('host');
    await until(async () => existsSync(join(f.state, 'control-owner.json')), Boolean);

    const nonInteractive = await runRyreach(f.state, []);
    assert.equal(nonInteractive.code, 0, nonInteractive.stderr);
    const initialStatus = statusSchema.parse(JSON.parse(nonInteractive.stdout));
    assert.equal(initialStatus.resident.state, 'awaiting_initialization');
    assert.equal(initialStatus.resident.stateLabel, '等待初始化');
    assert.equal(initialStatus.server, null);
    assert.equal(serverAPolls, 0);

    // 2. First interactive ryreach run reads server URL from stdin and moves host to awaiting_pairing
    const firstInteractive = await runRyreach(f.state, [], {
      stdin: `${f.origin}\n`,
      env: { REACH_CLI_INTERACTIVE: '1', REACH_CLI_DEVELOPMENT: '1' },
    });
    assert.equal(firstInteractive.code, 0, firstInteractive.stderr);
    assert.match(firstInteractive.stderr, /请输入 Reach 服务器地址/);
    const initReply = z.object({ saved: z.boolean(), verified: z.boolean(), serverUrl: z.string() }).parse(JSON.parse(firstInteractive.stdout));
    assert.equal(initReply.saved, true);
    assert.equal(initReply.verified, true);
    assert.equal(initReply.serverUrl, f.origin);

    // 3. Subsequent interactive ryreach run NEVER prompts again; host stays alive after CLI exits
    const secondInteractive = await runRyreach(f.state, [], {
      stdin: 'https://should-never-be-read.invalid\n',
      env: { REACH_CLI_INTERACTIVE: '1', REACH_CLI_DEVELOPMENT: '1' },
    });
    assert.equal(secondInteractive.code, 0, secondInteractive.stderr);
    assert.doesNotMatch(secondInteractive.stderr, /请输入 Reach 服务器地址/);
    const awaitingPair = statusSchema.parse(JSON.parse(secondInteractive.stdout));
    assert.equal(awaitingPair.resident.state, 'awaiting_pairing');
    assert.equal(awaitingPair.server, f.origin);

    // 4. Positional `ryreach pair <code>` uses configured server URL, connects, and executes remote operation
    const codeResp = z.object({ code: z.string() }).parse(await f.request('/api/v1/pairing-codes', 'POST', {}));
    const pairRun = await runRyreach(f.state, ['pair', codeResp.code]);
    assert.equal(pairRun.code, 0, pairRun.stderr);

    await until(async () => {
      const st = await runRyreach(f.state, ['status']);
      if (st.code !== 0) return false;
      return statusSchema.parse(JSON.parse(st.stdout)).resident.state === 'connected';
    }, Boolean);

    const oldSecret = f.identity().secret;
    const origInstallId = f.identity().installation_id;
    const op = await f.submit({ kind: 'command.run', command: '[Console]::Out.Write("resident-ok")', timeoutMs: 10000 });
    assert.equal((await f.settled(op.id)).execution, 'succeeded');

    // 5. Switch server URL to independent serverB: verify old bearer token is NEVER sent to serverB!
    const seenAuthOnB: string[] = [];
    storeB = new ReachStore(join(f.root, 'service-b.sqlite'));
    storeB.bootstrap('operator-b', 'operator-b-password-123456');
    serverB = reachServer({ store: storeB, publicOrigin: 'http://127.0.0.1:0', allowInsecureLoopback: true });
    const proxyB = createHttpServer((req, res) => {
      if (req.headers.authorization) seenAuthOnB.push(req.headers.authorization);
      serverB!.emit('request', req, res);
    });
    proxyB.listen(0, '127.0.0.1');
    await once(proxyB, 'listening');
    const addrB = proxyB.address();
    assert.ok(addrB && typeof addrB === 'object');
    const urlB = `http://127.0.0.1:${addrB.port}`;

    try {
      const switched = await runRyreach(f.state, ['config', 'set', 'server-url', urlB, '--development']);
      assert.equal(switched.code, 0, switched.stderr);
      const switchJson = z.object({
        saved: z.boolean(),
        serverSwitched: z.boolean(),
        credentialsRotated: z.boolean(),
        installationId: z.string(),
        paired: z.boolean(),
      }).parse(JSON.parse(switched.stdout));
      assert.equal(switchJson.saved, true);
      assert.equal(switchJson.serverSwitched, true);
      assert.equal(switchJson.credentialsRotated, true);
      assert.equal(switchJson.installationId, origInstallId);
      assert.equal(switchJson.paired, false);

      const postSwitch = statusSchema.parse(JSON.parse((await runRyreach(f.state, ['status'])).stdout));
      assert.equal(postSwitch.resident.state, 'awaiting_pairing');
      assert.equal(postSwitch.server, urlB);
      assert.notEqual(f.identity().secret, oldSecret);
      assert.equal(seenAuthOnB.includes(`Bearer ${oldSecret}`), false, 'old server credential must never be sent to new server');
    } finally {
      proxyB.close();
      proxyB.closeAllConnections();
      await once(proxyB, 'close');
    }

    // 6. Server-side unpair transitions connected resident host to auth_or_config_error (not masked as offline_backoff)
    const switchBack = await runRyreach(f.state, ['config', 'set', 'server-url', f.origin, '--development']);
    assert.equal(switchBack.code, 0, switchBack.stderr);
    const code2 = z.object({ code: z.string() }).parse(await f.request('/api/v1/pairing-codes', 'POST', {})).code;
    assert.equal((await runRyreach(f.state, ['pair', code2])).code, 0);
    await until(async () => statusSchema.parse(JSON.parse((await runRyreach(f.state, ['status'])).stdout)).resident.state === 'connected', Boolean);
    const currentNodeId = statusSchema.parse(JSON.parse((await runRyreach(f.state, ['status'])).stdout)).nodeId;
    assert.ok(currentNodeId);
    await f.request(`/api/v1/nodes/${currentNodeId}/unpair`, 'POST', {});
    await until(async () => {
      const st = statusSchema.parse(JSON.parse((await runRyreach(f.state, ['status'])).stdout));
      return st.resident.state === 'auth_or_config_error' && st.resident.errorCode === 'node_unpaired';
    }, Boolean);

    assert.equal((await runRyreach(f.state, ['host-stop'])).code, 0);
    assert.equal((await host.done).code, 0);
  } finally {
    if (serverB) await serverB.shutdown();
    else storeB?.close();
    await f.cleanup();
  }
});

test('M11: invalid URL rejection, TLS error diagnosis, offline pending config, and external preconfigure idempotency', { timeout: 60000 }, async () => {
  const f = await fixture();
  const tlsCreds = selfSignedTlsCredentials();
  const badTlsServer = createHttpsServer(tlsCreds, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  badTlsServer.listen(0, '127.0.0.1');
  await once(badTlsServer, 'listening');
  const tlsAddr = badTlsServer.address();
  assert.ok(tlsAddr && typeof tlsAddr === 'object');
  const badTlsUrl = `https://127.0.0.1:${tlsAddr.port}`;

  try {
    const host = f.node('host');
    await until(async () => existsSync(join(f.state, 'control-owner.json')), Boolean);

    // 1. Non-HTTPS non-loopback URL rejected without saving
    const badScheme = await runRyreach(f.state, ['config', 'set', 'server-url', 'http://example.invalid']);
    assert.notEqual(badScheme.code, 0);
    assert.equal(statusSchema.parse(JSON.parse((await runRyreach(f.state, ['status'])).stdout)).server, null);

    // 2. Self-signed TLS endpoint fails verification explicitly and puts resident into auth_or_config_error
    const tlsAttempt = await runRyreach(f.state, ['config', 'set', 'server-url', badTlsUrl]);
    assert.notEqual(tlsAttempt.code, 0);
    assert.match(tlsAttempt.stderr, /tls_handshake_failed/);
    const tlsStatus = statusSchema.parse(JSON.parse((await runRyreach(f.state, ['status'])).stdout));
    assert.equal(tlsStatus.server, badTlsUrl);
    assert.equal(tlsStatus.resident.state, 'auth_or_config_error');
    assert.equal(tlsStatus.resident.errorCode, 'tls_handshake_failed');

    // 3. Offline endpoint without --allow-offline fails explicitly; with --allow-offline reports pending_connectivity
    const closedUrl = 'http://127.0.0.1:1';
    const offlineStrict = await runRyreach(f.state, ['config', 'set', 'server-url', closedUrl, '--development']);
    assert.notEqual(offlineStrict.code, 0);
    assert.match(offlineStrict.stderr, /pending_connectivity/);
    const offlineAllowed = await runRyreach(f.state, ['config', 'set', 'server-url', closedUrl, '--development', '--allow-offline']);
    assert.equal(offlineAllowed.code, 0, offlineAllowed.stderr);
    const offlineJson = z.object({ verified: z.boolean(), status: z.string() }).parse(JSON.parse(offlineAllowed.stdout));
    assert.equal(offlineJson.verified, false);
    assert.equal(offlineJson.status, 'pending_connectivity');

    // 4. External installer preconfigure is idempotent and refuses to clobber active pairings
    const state2 = join(f.root, 'preconfig-state');
    const pre1 = await runRyreach(state2, ['preconfigure', '--server', f.origin, '--development']);
    assert.equal(pre1.code, 0, pre1.stderr);
    const pre1Json = z.object({ action: z.string(), alreadyConfigured: z.boolean(), installationId: z.string() }).parse(JSON.parse(pre1.stdout));
    assert.equal(pre1Json.action, 'configured');
    assert.equal(pre1Json.alreadyConfigured, false);

    // Interactive ryreach skips prompt when preconfigured
    const skipPrompt = await runRyreach(state2, [], {
      stdin: 'https://never-used.invalid\n',
      env: { REACH_CLI_INTERACTIVE: '1' },
    });
    assert.equal(skipPrompt.code, 0, skipPrompt.stderr);
    assert.doesNotMatch(skipPrompt.stderr, /请输入 Reach 服务器地址/);
    assert.equal(statusSchema.parse(JSON.parse(skipPrompt.stdout)).server, f.origin);

    // Repeat preconfigure with same URL is a pure idempotent no-op preserving installationId
    const pre2 = await runRyreach(state2, ['preconfigure', '--server', f.origin, '--development']);
    assert.equal(pre2.code, 0, pre2.stderr);
    const pre2Json = z.object({ action: z.string(), alreadyConfigured: z.boolean(), installationId: z.string() }).parse(JSON.parse(pre2.stdout));
    assert.equal(pre2Json.action, 'unchanged');
    assert.equal(pre2Json.alreadyConfigured, true);
    assert.equal(pre2Json.installationId, pre1Json.installationId);

    // Pair state2 to serverA, then verify preconfigure to another server refuses to clobber active binding
    const code = z.object({ code: z.string() }).parse(await f.request('/api/v1/pairing-codes', 'POST', {})).code;
    assert.equal((await runRyreach(state2, ['pair', code])).code, 0);
    const clobber = await runRyreach(state2, ['preconfigure', '--server', 'https://other.example.invalid']);
    assert.notEqual(clobber.code, 0);
    assert.match(clobber.stderr, /already bound/);

    assert.equal((await runRyreach(f.state, ['host-stop'])).code, 0);
    assert.equal((await host.done).code, 0);
  } finally {
    badTlsServer.close();
    badTlsServer.closeAllConnections();
    await once(badTlsServer, 'close');
    await f.cleanup();
  }
});
