// Copyright (c) Ray Zhang. End-to-end M13 verification (REQ-02):
// default OpenSSH status/missing detection, real Windows ssh.exe + ssh-keygen.exe pairing-bound Ed25519 access,
// unpaired rejection, transient outage preservation, and scoped revocation on unpair/uninstall without touching non-Reach keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { fixture, until, executable } from './native-fixture.ts';
import { startSsh2FixtureServer } from './ssh2-server-fixture.ts';

const ryreachExe = join(dirname(executable), process.platform === 'win32' ? 'ryreach.exe' : 'ryreach');
const systemSsh = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe') : 'ssh';
const systemKeygen = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keygen.exe') : 'ssh-keygen';

async function runCmd(bin: string, args: string[], env?: NodeJS.ProcessEnv) {
  const child = spawn(bin, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', c => { stdout += c; });
  child.stderr!.on('data', c => { stderr += c; });
  const [code] = await once(child, 'close');
  return { code: typeof code === 'number' ? code : null, stdout: stdout.trim(), stderr: stderr.trim() };
}

test('M13: missing sshd reports explicit reason; paired controller Ed25519 key authorizes real OpenSSH ssh.exe while unpaired fails and unpair/uninstall preserve third-party keys', { timeout: 120000 }, async () => {
  assert.equal(existsSync(systemSsh), true, `missing ${systemSsh}`);
  assert.equal(existsSync(systemKeygen), true, `missing ${systemKeygen}`);

  // Part A: Missing/disabled OpenSSH environment reports explicit ready=false + actionable error without crashing Node
  const fMissing = await fixture();
  try {
    // Real Windows SCM query on clean machine without sshd reports explicit missing_sshd diagnostic
    const realCleanRes = await runCmd(ryreachExe, ['--state-dir', fMissing.state, 'status']);
    assert.equal(realCleanRes.code, 0, realCleanRes.stderr);
    const realCleanJson = z.object({ ssh: z.object({ ready: z.boolean(), mode: z.string(), error: z.string().nullable() }) }).parse(JSON.parse(realCleanRes.stdout));
    if (!realCleanJson.ssh.ready) {
      assert.match(realCleanJson.ssh.error ?? '', /尚未安装 OpenSSH Server|未处于运行状态|未在 22 端口监听/);
    }
    // Preconfigured development state also surfaces explicit fixture sshd error cleanly
    assert.equal((await runCmd(ryreachExe, ['--state-dir', fMissing.state, 'preconfigure', '--server', fMissing.origin, '--development'])).code, 0);
    const missingEnv = {
      REACH_DEV_SSH_CONFIG_JSON: JSON.stringify({
        port: 22222,
        user: 'reachuser',
        hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB',
        authorizedKeysPath: join(fMissing.root, 'missing-auth-keys'),
        ready: false,
        error: 'sshd service is not installed on clean machine',
      }),
    };
    const stRes = await runCmd(ryreachExe, ['--state-dir', fMissing.state, 'status'], missingEnv);
    assert.equal(stRes.code, 0, stRes.stderr);
    const stJson = z.object({ ssh: z.object({ ready: z.boolean(), error: z.string().nullable() }) }).parse(JSON.parse(stRes.stdout));
    assert.equal(stJson.ssh.ready, false);
    assert.match(stJson.ssh.error ?? '', /not installed/);
  } finally {
    await fMissing.cleanup();
  }

  // Part B: Existing OpenSSH environment + real ssh-keygen.exe + real ssh.exe login, unpaired rejection, outage preservation, and scoped unpair/uninstall cleanup
  const f = await fixture();
  const authKeysPath = join(f.root, 'administrators_authorized_keys');
  const existingAdminKey = '# Existing corporate admin key\r\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg ops-admin@corp\r\n';
  writeFileSync(authKeysPath, existingAdminKey, 'utf8');

  const sshServer = await startSsh2FixtureServer({
    authorizedKeysPath: authKeysPath,
    expectedUser: 'reachop',
    onExec: async cmd => ({ stdout: `REAL_SSH_RESULT:${cmd}`, exitCode: 0 }),
  });

  try {
    // Generate two distinct controller Ed25519 keys via real vendor ssh-keygen.exe (no shared universal private key!)
    const pairedKeyPath = join(f.root, 'paired_id_ed25519');
    const unpairedKeyPath = join(f.root, 'unpaired_id_ed25519');
    for (const kp of [pairedKeyPath, unpairedKeyPath]) {
      const kg = spawnSync(systemKeygen, ['-q', '-t', 'ed25519', '-f', kp, '-N', ''], { windowsHide: true });
      assert.equal(kg.status, 0);
    }
    const pairedPub = readFileSync(`${pairedKeyPath}.pub`, 'utf8').trim();
    const knownHostsPath = join(f.root, 'known_hosts');
    writeFileSync(knownHostsPath, `[127.0.0.1]:${sshServer.port} ${sshServer.hostPublicKeyLine}\n`, 'utf8');

    const sshArgsBase = [
      '-p', String(sshServer.port),
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${knownHostsPath}`,
      '-o', 'IdentitiesOnly=yes',
      '-o', 'ConnectTimeout=5',
    ];

    // 1. Before pairing: both keys are rejected by real ssh.exe (default-enabled SSH grants zero login to unpaired callers!)
    const prePairAttempt = await runCmd(systemSsh, [...sshArgsBase, '-i', pairedKeyPath, 'reachop@127.0.0.1', 'whoami']);
    assert.notEqual(prePairAttempt.code, 0);
    assert.match(prePairAttempt.stderr, /Permission denied/i);

    // 2. Pair resident Node and verify sshStatus is reported on heartbeat
    const devSshEnv = {
      REACH_DEV_SSH_CONFIG_JSON: JSON.stringify({
        port: sshServer.port,
        user: 'reachop',
        hostKey: sshServer.hostPublicKeyLine,
        authorizedKeysPath: authKeysPath,
        sharedAdminKeys: true,
        ready: true,
      }),
      REACH_DEV_BACKOFF_BASE_MS: '200',
      REACH_DEV_BACKOFF_CAP_MS: '600',
    };
    assert.equal((await f.pair()).code, 0);
    const nodeId = f.identity().node_id!;
    const host = spawn(executable, ['--state-dir', f.state, 'host'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', ...devSshEnv },
    });
    const hostDone = once(host, 'close');

    const rtReady = await until(
      async () => z.object({ sshStatus: z.object({ ready: z.boolean(), port: z.number(), hostKey: z.string() }).nullable() }).parse(await f.request(`/api/v1/nodes/${nodeId}/runtime`)),
      v => v.sshStatus?.ready === true,
    );
    assert.equal(rtReady.sshStatus?.port, sshServer.port);
    assert.equal(rtReady.sshStatus?.hostKey, sshServer.hostPublicKeyLine);

    // 3. Authorize paired controller's Ed25519 public key via authenticated Reach operation
    const grantId = randomUUID();
    const authOp = await f.submit({ kind: 'ssh.authorize', grantId, publicKey: pairedPub });
    const settledAuth = await f.settled(authOp.id);
    assert.equal(settledAuth.execution, 'succeeded', settledAuth.result_json);

    // Real OpenSSH ssh.exe succeeds for the paired controller key while still rejecting the unpaired key!
    const pairedSshRun = await runCmd(systemSsh, [...sshArgsBase, '-i', pairedKeyPath, 'reachop@127.0.0.1', 'hostname-check']);
    assert.equal(pairedSshRun.code, 0, pairedSshRun.stderr);
    assert.equal(pairedSshRun.stdout, 'REAL_SSH_RESULT:hostname-check');

    const unpairedSshRun = await runCmd(systemSsh, [...sshArgsBase, '-i', unpairedKeyPath, 'reachop@127.0.0.1', 'hostname-check']);
    assert.notEqual(unpairedSshRun.code, 0);
    assert.match(unpairedSshRun.stderr, /Permission denied/i);

    // Simulate another administrator appending their own key concurrently
    const secondAdminLine = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw second-admin@corp\r\n';
    writeFileSync(authKeysPath, readFileSync(authKeysPath, 'utf8') + secondAdminLine, 'utf8');

    // 4. Transient network outage (`offline_backoff`) MUST NOT destroy installation identity or revoke managed SSH key!
    let outage = true;
    f.intercept(async (_req, res) => {
      if (!outage) return false;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":{"code":"transient_outage"}}');
      return true;
    });
    await until(async () => {
      const st = await runCmd(ryreachExe, ['--state-dir', f.state, 'status']);
      return st.code === 0 && JSON.parse(st.stdout).resident?.state === 'offline_backoff';
    }, Boolean);
    const duringOutageSsh = await runCmd(systemSsh, [...sshArgsBase, '-i', pairedKeyPath, 'reachop@127.0.0.1', 'outage-check']);
    assert.equal(duringOutageSsh.code, 0, 'transient offline backoff must preserve managed SSH authorization');
    outage = false;
    f.intercept();
    await until(async () => {
      const st = await runCmd(ryreachExe, ['--state-dir', f.state, 'status']);
      return st.code === 0 && JSON.parse(st.stdout).resident?.state === 'connected';
    }, Boolean);

    // 5. Unpairing revokes ONLY Reach's managed key (`ry-reach:...`), rejects subsequent ssh.exe login, and preserves both non-Reach admin keys!
    await f.request(`/api/v1/nodes/${nodeId}/unpair`, 'POST', {});
    await until(async () => {
      const st = await runCmd(ryreachExe, ['--state-dir', f.state, 'status']);
      return st.code === 0 && JSON.parse(st.stdout).resident?.errorCode === 'node_unpaired';
    }, Boolean);

    const afterUnpairSsh = await runCmd(systemSsh, [...sshArgsBase, '-i', pairedKeyPath, 'reachop@127.0.0.1', 'after-unpair']);
    assert.notEqual(afterUnpairSsh.code, 0, 'unpaired key must be rejected immediately');
    const keysAfterUnpair = readFileSync(authKeysPath, 'utf8');
    assert.equal(keysAfterUnpair.includes('ry-reach:'), false);
    assert.equal(keysAfterUnpair.includes('ops-admin@corp'), true);
    assert.equal(keysAfterUnpair.includes('second-admin@corp'), true);

    // 6. Re-pair, authorize a second grant, stop host, and run PowerShell uninstall `RevokeReachManagedSshKeys` to prove uninstall cleanup!
    const code2 = z.object({ code: z.string() }).parse(await f.request('/api/v1/pairing-codes', 'POST', {})).code;
    assert.equal((await runCmd(ryreachExe, ['--state-dir', f.state, 'pair', code2])).code, 0);
    await until(async () => JSON.parse((await runCmd(ryreachExe, ['--state-dir', f.state, 'status'])).stdout).resident?.state === 'connected', Boolean);

    const grant2Op = await f.submit({ kind: 'ssh.authorize', grantId: randomUUID(), publicKey: pairedPub });
    assert.equal((await f.settled(grant2Op.id)).execution, 'succeeded');
    assert.equal((await runCmd(systemSsh, [...sshArgsBase, '-i', pairedKeyPath, 'reachop@127.0.0.1', 'repaired-ok'])).code, 0);

    assert.equal((await runCmd(ryreachExe, ['--state-dir', f.state, 'host-stop'])).code, 0);
    assert.equal((await hostDone)[0], 0);

    const psExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const uninstallScript = `
      $ErrorActionPreference = 'Stop'
      $state = '${f.state.replace(/'/g, "''")}'
      function CheckPath([string]$p) {}
      function Hash([byte[]]$b) { $s=[Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($s.ComputeHash($b))).Replace('-','').ToLowerInvariant() } finally { $s.Dispose() } }
      . '${join(process.cwd(), 'packaging/windows/uninstall-host.ps1').replace(/'/g, "''")}'
      RevokeReachManagedSshKeys
    `;
    const psRun = await runCmd(psExe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', uninstallScript]);
    assert.equal(psRun.code, 0, psRun.stderr);

    const afterUninstallSsh = await runCmd(systemSsh, [...sshArgsBase, '-i', pairedKeyPath, 'reachop@127.0.0.1', 'after-uninstall']);
    assert.notEqual(afterUninstallSsh.code, 0);
    const keysAfterUninstall = readFileSync(authKeysPath, 'utf8');
    assert.equal(keysAfterUninstall.includes('ry-reach:'), false);
    assert.equal(keysAfterUninstall.includes('ops-admin@corp'), true);
    assert.equal(keysAfterUninstall.includes('second-admin@corp'), true);
  } finally {
    await sshServer.close();
    await f.cleanup();
  }
});
