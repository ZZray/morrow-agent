// Copyright (c) Ray Zhang. Create signed Reach update assets from a verified Windows Setup.
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const [setup, version, commit, directory, expectedPublicKey] = process.argv.slice(2);
if (!setup || !directory || !expectedPublicKey || process.argv.length !== 7
    || !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){2}$/.test(version)
    || version.split('.').some(part => Number(part) > 65535)
    || !/^[0-9a-f]{40}$/.test(commit)
    || !/^[0-9a-f]{64}$/.test(expectedPublicKey)) {
  throw new Error('Usage: release-assets SETUP.exe VERSION COMMIT OUTPUT_DIR PUBLIC_KEY_HEX. Supply the base64 PKCS#8 Ed25519 key on stdin.');
}
if (!setup.endsWith('.exe')) throw new Error('Expected a Reach Setup executable');
const bytes = readFileSync(setup);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const build = JSON.parse(readFileSync(join(dirname(setup), 'package.json'), 'utf8'));
const workerAgent = build.schema === 2 && build.kind === 'complete-installer-preview'
  && build.agentBundled === true && build.desktopBundled === false;
const legacy = build.kind === 'node-installer-preview' && basename(setup).startsWith('Reach-Node-Setup-');
const nodeSha256 = workerAgent ? build.payload?.nodeSha256 : build.nodeSha256;
if ((!workerAgent && !legacy) || build.version !== version || build.installerName !== basename(setup)
    || build.installerSha256 !== sha256 || !/^[0-9a-f]{64}$/.test(nodeSha256)
    || (workerAgent && (!/^[0-9a-f]{64}$/.test(build.agentSha256) || !Number.isSafeInteger(build.payload?.files)
      || build.updateChannel?.source !== 'bound-reach' || build.updateChannel.publicKey !== expectedPublicKey))) {
  throw new Error('Setup must match its installer build record and requested release version');
}
const installer = workerAgent ? 'Reach-Worker-Agent-Setup-x64.exe' : 'Reach-Node-Setup-x64.exe';
const manifest = Buffer.from(JSON.stringify({
  schema: workerAgent ? 2 : 1,
  tag: (workerAgent ? 'reach-worker-agent-v' : 'reach-v') + version,
  version,
  commit,
  platform: 'windows-x64',
  installer,
  size: bytes.length,
  sha256,
  ...(workerAgent ? { agent_sha256: build.agentSha256 } : {}),
}) + '\n');
const encodedKey = readFileSync(0);
const keyBytes = Buffer.from(encodedKey.toString('ascii').trim(), 'base64');
const key = createPrivateKey({ key: keyBytes, type: 'pkcs8', format: 'der' });
keyBytes.fill(0);
encodedKey.fill(0);
const publicKey = createPublicKey(key);
const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
if (publicKey.asymmetricKeyType !== 'ed25519' || rawPublicKey !== expectedPublicKey) {
  throw new Error('Signing key does not match the key pinned in Reach Node');
}
const signature = sign(null, manifest, key);
if (signature.length !== 64 || !verify(null, manifest, publicKey, signature)) {
  throw new Error('Reach release signature verification failed');
}
const output = resolve(directory);
const parent = dirname(output);
mkdirSync(parent, { recursive: true });
const staging = mkdtempSync(join(parent, '.reach-release-'));
try {
  const stagedInstaller = join(staging, installer);
  writeFileSync(stagedInstaller, bytes);
  const inspection = execFileSync(stagedInstaller, ['--inspect'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const report = inspection.split(/\r?\n/);
  if (!report.includes('Reach setup ' + version) || !report.includes('node_sha256=' + nodeSha256)
      || !report.includes('desktop_bundled=false') || !report.includes('agent_bundled=' + workerAgent)
      || (workerAgent && (!report.includes('agent_sha256=' + build.agentSha256) || !report.includes('auto_update_worker_agent=true')))) {
    throw new Error('Setup inspection did not confirm the expected Worker and Agent payload');
  }
  if (workerAgent) {
    const verification = execFileSync(stagedInstaller, ['--verify-payload'], { encoding: 'utf8', timeout: 120000, windowsHide: true });
    if (!verification.split(/\r?\n/).some(line => line.startsWith(`verified_files=${build.payload.files};`))) {
      throw new Error('Setup did not verify the expected Worker + Agent archive inventory');
    }
  }
  writeFileSync(join(staging, 'reach-update.json'), manifest, { flag: 'wx' });
  writeFileSync(join(staging, 'reach-update.sig'), signature, { flag: 'wx' });
  renameSync(staging, output);
} finally {
  rmSync(staging, { force: true, recursive: true });
}
process.stdout.write(manifest);
