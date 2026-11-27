// Copyright (c) Ray Zhang. Opt-in local real-model verification via CAS_API_KEY in process memory only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { fixture, until, launch, kill } from './native-fixture.ts';
import { ReachClient } from '../src/controller/client.ts';
import { invoke } from '../src/controller/mcp.ts';
import { ReachStore } from '../src/service/store.ts';
import { reachServer } from '../src/service/server.ts';
import { DeskHost } from '../platform/src/host.ts';

const casKey = process.env.CAS_API_KEY?.trim() ?? '';
const casEndpoint = process.env.CAS_BASE_URL?.trim() ?? 'https://cas.ciqtek.com/v1';
const textModel = process.env.CAS_TEXT_MODEL?.trim() ?? 'deepseek-v4.1-flash';
const visionModel = process.env.CAS_VISION_MODEL?.trim() ?? 'gpt-5.6-luna';
const sidecar = process.env.REACH_DESK_SIDECAR;
const nodeBinary = process.env.REACH_NODE_BINARY;
const desktopBinary = process.env.REACH_DESKTOP_BIN;
const desktopPython = process.env.REACH_DESKTOP_PYTHON;

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const walkFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(full) : entry.isFile() ? [full] : [];
  });

function assertZeroSecretLeak(root: string, secretValue: string) {
  assert.ok(secretValue.length >= 16, 'secret guard requires non-trivial secret');
  const needle = Buffer.from(secretValue, 'utf8');
  for (const file of walkFiles(root)) {
    const data = readFileSync(file);
    assert.equal(data.includes(needle), false, `Secret leaked into ${file}`);
  }
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  assert.ok(start >= 0 && end > start, `Expected JSON object in model output: ${raw.slice(0, 240)}`);
  return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
}

const nodesSchema = z.object({
  nodes: z.array(z.object({ id: z.string(), epoch: z.number(), online: z.boolean().optional(), capabilities: z.array(z.string()) })),
});

test('CAS real text model completes multi-tool Node delegation, cross-process continue_reviewed, and ToolArtifact provenance', {
  skip: !casKey || !sidecar,
  timeout: 180000,
}, async () => {
  const root = resolve('work/cas-real-node-text-' + randomUUID());
  mkdirSync(root, { recursive: true });
  const config = join(root, 'agent-runtime.json');
  writeFileSync(config, JSON.stringify({ sidecar, sha256: sha(readFileSync(sidecar!)) }));
  const nodeEnv: NodeJS.ProcessEnv = { ...process.env, REACH_AGENT_CONFIG: config, NO_PROXY: '127.0.0.1,localhost,cas.ciqtek.com' };
  delete nodeEnv.CAS_API_KEY;
  for (const k of Object.keys(nodeEnv)) if (k.startsWith('REACH_AGENT_MODEL_')) delete nodeEnv[k];

  const serviceEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NO_PROXY: '127.0.0.1,localhost,cas.ciqtek.com',
    REACH_AGENT_MODEL_URL: casEndpoint,
    REACH_AGENT_MODEL_ID: textModel,
    REACH_AGENT_MODEL_TOKEN: casKey,
    REACH_AGENT_MODEL_CONTEXT: '131072',
    REACH_AGENT_MODEL_MAX_OUTPUT: '4096',
    REACH_AGENT_MODEL_IMAGE_INPUT: '0',
  };
  delete serviceEnv.CAS_API_KEY;

  const f = await fixture('', nodeEnv, root, serviceEnv);
  try {
    assert.equal((await f.pair()).code, 0);
    const runner = f.node('run');
    const rawNodes = await until(
      () => f.request('/api/v1/nodes'),
      v => nodesSchema.parse(v).nodes.some(n => n.capabilities.includes('agent.delegate') && n.capabilities.includes('agent.continue') && n.capabilities.includes('agent.provenance')),
    );
    const nodeId = nodesSchema.parse(rawNodes).nodes[0]!.id;
    const auth = z.object({ token: z.string() }).parse(
      await f.request('/api/v1/auth/login', 'POST', { username: 'native-test', password: 'native-test-fixture-password' }),
    );
    const ctrlDir = join(root, 'ctrl');
    mkdirSync(ctrlDir, { recursive: true });
    const client = new ReachClient({ server: f.origin, token: auth.token, development: true }, ctrlDir);

    const nonce = 'NONCE-' + randomBytes(6).toString('hex').toUpperCase();
    writeFileSync(join(root, 'audit-target.txt'), `audit_token=${nonce}\n`, 'utf8');

    const op1 = await f.submit({
      kind: 'agent.delegate',
      sessionId: randomUUID(),
      cwd: root,
      objective: 'Use reach_execute with file.read to read audit-target.txt in the current directory, then reply with a single JSON object {"nonce":"<exact audit_token value>"} and nothing else.',
      reviewMode: 'cross_process',
      maxRuns: 2,
      maxCalls: 8,
      maxSeconds: 120,
      maxOutput: 4096,
    });
    const settled1 = await f.settled(op1.id);
    assert.equal(settled1.execution, 'succeeded', JSON.stringify({ settled1, logs: runner.logs() }));
    const res1 = z.object({
      outcome: z.object({
        runs: z.number(),
        observed_calls: z.number(),
        last_candidate: z.object({ output: z.string() }),
        artifacts: z.array(z.object({ status: z.string() })),
      }),
    }).parse(JSON.parse(settled1.result_json));
    const parsedOut1 = extractJsonObject(res1.outcome.last_candidate.output);
    assert.equal(parsedOut1.nonce, nonce);
    assert.ok(res1.outcome.artifacts.some(a => a.status === 'verified'));

    const released1Path = join(f.state, 'agents', op1.id, 'evidence', 'released.json');
    const released1Sha = sha(readFileSync(released1Path));

    const contOp = z.object({ id: z.string() }).parse(await invoke(client, 'reach_agent_continue', {
      requestId: randomUUID(),
      nodeId,
      rootOperationId: op1.id,
      previousExecutionId: op1.id,
      releasedSha256: released1Sha,
      feedback: `Use reach_execute with file.write (contentBase64) to write the exact ASCII string "VERIFIED:${nonce}" to summary.txt in the current directory, then reply with {"written":true,"nonce":"${nonce}"}.`,
    }));
    const settled2 = await until(() => f.operation(contOp.id), v => ['succeeded', 'failed', 'unknown', 'cancelled'].includes(v.execution), 90000);
    assert.equal(settled2.execution, 'succeeded', JSON.stringify({ settled2, logs: runner.logs() }));
    assert.equal(readFileSync(join(root, 'summary.txt'), 'utf8').trim(), `VERIFIED:${nonce}`);

    const provOp = z.object({ id: z.string() }).parse(await invoke(client, 'reach_agent_provenance', {
      requestId: randomUUID(),
      nodeId,
      rootOperationIds: [op1.id],
      status: 'verified',
    }));
    const provSettled = await f.settled(provOp.id);
    assert.equal(provSettled.execution, 'succeeded');
    const prov = z.object({ entries: z.array(z.unknown()), scopeErrors: z.array(z.unknown()) }).parse(JSON.parse(provSettled.result_json));
    assert.deepEqual(prov.scopeErrors, []);
    assert.ok(prov.entries.length >= 2);

    writeFileSync(join(root, 'sanitized-summary.json'), JSON.stringify({
      scenario: 'node_real_text_delegation_and_continue_reviewed',
      endpoint: casEndpoint,
      model: textModel,
      rootOperationId: op1.id,
      continueOperationId: contOp.id,
      provenanceOperationId: provOp.id,
      verifiedArtifacts: prov.entries.length,
      nonceMatched: true,
      summaryWritten: true,
      taskAccepted: false,
    }, null, 2));
  } finally {
    await f.cleanup();
  }
  assertZeroSecretLeak(root, casKey);
  console.log(JSON.stringify({ casNodeTextEvidence: root }));
});

test('CAS real vision model captures an isolated WinForms surface via Reach Node and identifies pixel-only code and color order', {
  skip: !casKey || !sidecar || !desktopBinary || !desktopPython,
  timeout: 240000,
}, async () => {
  const root = resolve('work/cas-real-node-vision-' + randomUUID());
  mkdirSync(root, { recursive: true });
  const config = join(root, 'agent-runtime.json');
  const desktopConfig = join(root, 'desktop.json');
  writeFileSync(config, JSON.stringify({ sidecar, sha256: sha(readFileSync(sidecar!)) }));
  writeFileSync(desktopConfig, JSON.stringify({ helper: desktopBinary, python: desktopPython, config: resolve('desktop/runtime/config.toml') }));

  const alphabet = 'ACDEFGHJKLMNPQRTUVWXYZ234679';
  const expectedCode = Array.from({ length: 6 }, () => alphabet[randomBytes(1)[0]! % alphabet.length]).join('');
  const items = [
    { shape: 'triangle', color: 'blue' },
    { shape: 'square', color: 'red' },
    { shape: 'circle', color: 'green' },
  ];
  const defPath = join(root, 'surface-def.json');
  const statePath = join(root, 'surface-state.json');
  const stopPath = join(root, 'surface.stop');
  writeFileSync(defPath, JSON.stringify({ code: expectedCode, items }));

  const form = launch(
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('tests/vision-fixture.ps1'), '-DefinitionPath', defPath, '-StatePath', statePath, '-StopPath', stopPath],
    process.env,
    join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
  );

  const nodeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    REACH_AGENT_CONFIG: config,
    REACH_DESKTOP_CONFIG: desktopConfig,
    NO_PROXY: '127.0.0.1,localhost,cas.ciqtek.com',
  };
  delete nodeEnv.CAS_API_KEY;
  for (const k of Object.keys(nodeEnv)) if (k.startsWith('REACH_AGENT_MODEL_')) delete nodeEnv[k];

  const serviceEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NO_PROXY: '127.0.0.1,localhost,cas.ciqtek.com',
    REACH_AGENT_MODEL_URL: casEndpoint,
    REACH_AGENT_MODEL_ID: visionModel,
    REACH_AGENT_MODEL_TOKEN: casKey,
    REACH_AGENT_MODEL_CONTEXT: '131072',
    REACH_AGENT_MODEL_MAX_OUTPUT: '1024',
    REACH_AGENT_MODEL_IMAGE_INPUT: '1',
  };
  delete serviceEnv.CAS_API_KEY;

  const f = await fixture('', nodeEnv, root, serviceEnv);
  interface RunnerHandle { done: Promise<{ code: number | null; stderr: string }>; logs: () => unknown }
  let runner: RunnerHandle | undefined;
  try {
    const surface = await until(
      async () => {
        try { return JSON.parse(readFileSync(statePath, 'utf8')) as { visible: boolean; region: number[] }; }
        catch { return null; }
      },
      v => Boolean(v?.visible && Array.isArray(v.region) && v.region.length === 4),
      20000,
    );
    assert.equal((await f.pair()).code, 0);
    runner = f.node('host');
    await until(
      () => f.request('/api/v1/nodes'),
      v => nodesSchema.parse(v).nodes.some(n => n.capabilities.includes('agent.delegate') && n.capabilities.includes('desktop.call')),
    );

    const regionJson = JSON.stringify({ region: surface!.region });
    const op = await f.submit({
      kind: 'agent.delegate',
      sessionId: randomUUID(),
      cwd: resolve('work'),
      objective:
        `1) Call reach_execute with {"kind":"desktop.describe"}. ` +
        `2) Using the returned helperGeneration and sessionRef, call reach_execute with {"kind":"desktop.call","tool":"Screenshot","argumentsJson":${JSON.stringify(regionJson)},"helperGeneration":"...","sessionRef":{...},"snapshotId":""} to capture the isolated test window. ` +
        `3) Read the attached PNG image directly (do NOT read any files from disk). Identify the 6-character uppercase alphanumeric code after "CODE " at the top of the image and the colors of the three shapes from left to right (each is "red", "green", or "blue"). ` +
        `Reply ONLY with a JSON object {"code":"<6 chars>","colors":["<left>","<middle>","<right>"]}.`,
      maxRuns: 1,
      maxCalls: 6,
      maxToolCalls: 4,
      maxSeconds: 150,
      maxOutput: 1024,
    });

    const settled = await until(() => f.operation(op.id), v => ['succeeded', 'failed', 'unknown', 'cancelled'].includes(v.execution), 150000);
    assert.equal(settled.execution, 'succeeded', JSON.stringify({ settled, logs: runner.logs() }));
    const res = z.object({
      outcome: z.object({
        observed_calls: z.number(),
        last_candidate: z.object({ output: z.string() }),
        artifacts: z.array(z.object({ status: z.string() })),
      }),
    }).parse(JSON.parse(settled.result_json));
    const answer = z.object({
      code: z.string(),
      colors: z.array(z.string()),
    }).parse(extractJsonObject(res.outcome.last_candidate.output));
    assert.equal(answer.code.trim().toUpperCase(), expectedCode);
    assert.deepEqual(answer.colors.map(c => c.trim().toLowerCase()), items.map(i => i.color));

    const toolImagesProof = z.object({
      kind: z.literal('jsonl-native-images-v1'),
      calls: z.array(z.object({ images: z.array(z.object({ sha256: z.string(), bytes: z.number() })) })),
    }).parse(JSON.parse(readFileSync(join(f.state, 'agents', op.id, 'evidence', 'run-1-tool-images.json'), 'utf8')));
    const imgCount = toolImagesProof.calls.reduce((acc, c) => acc + c.images.length, 0);
    assert.equal(imgCount, 1);

    writeFileSync(join(root, 'sanitized-summary.json'), JSON.stringify({
      scenario: 'node_real_desktop_screenshot_vision_understanding',
      endpoint: casEndpoint,
      model: visionModel,
      operationId: op.id,
      expectedCode,
      recognizedCode: answer.code.trim().toUpperCase(),
      expectedColors: items.map(i => i.color),
      recognizedColors: answer.colors.map(c => c.trim().toLowerCase()),
      nativeImageProofSha256: toolImagesProof.calls.find(c => c.images.length > 0)!.images[0]!.sha256,
      verifiedArtifacts: res.outcome.artifacts.filter(a => a.status === 'verified').length,
      taskAccepted: false,
    }, null, 2));

    const stopped = await f.node('host-stop').done;
    assert.equal(stopped.code, 0, stopped.stderr);
    await runner.done;
  } finally {
    writeFileSync(stopPath, 'done');
    await kill(form.child);
    await f.cleanup();
  }
  assertZeroSecretLeak(root, casKey);
  console.log(JSON.stringify({ casNodeVisionEvidence: root }));
});

test('CAS real model drives Reach Desk multi-turn Session recall and paired Node device file + PNG inspection', {
  skip: !casKey || !sidecar || !nodeBinary,
  timeout: 240000,
}, async () => {
  const root = resolve('work/cas-real-desk-' + randomUUID());
  mkdirSync(root, { recursive: true });

  // Local in-memory forwarder keeps CAS_API_KEY exclusively in this process's closure;
  // DeskHost and morrow-agent-jsonl receive only a disposable loopback grant token.
  const loopbackGrant = 'disposable-desk-loopback-' + randomBytes(8).toString('hex');
  const forwarder = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, 'Bearer ' + loopbackGrant);
      const chunks: Buffer[] = [];
      for await (const b of req) chunks.push(Buffer.from(b));
      const upstream = await fetch(casEndpoint + (req.url?.replace(/^\/v1/, '') ?? ''), {
        method: req.method ?? 'POST',
        headers: {
          authorization: 'Bearer ' + casKey,
          'content-type': 'application/json',
          accept: req.headers.accept ?? 'text/event-stream',
        },
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
        connection: 'close',
      });
      if (upstream.body) {
        for await (const part of upstream.body) res.write(part);
      }
      res.end();
    } catch {
      res.destroy();
    }
  });
  forwarder.listen(0, '127.0.0.1');
  await once(forwarder, 'listening');
  const fa = forwarder.address();
  assert.ok(fa && typeof fa !== 'string');

  const store = new ReachStore(join(root, 'reach.sqlite'));
  store.bootstrap('cas-desk', 'disposable-cas-desk-password');
  const session = store.login('cas-desk', 'disposable-cas-desk-password');
  const desk = new DeskHost({
    stateDirectory: join(root, 'desk'),
    binary: sidecar!,
    endpoint: `http://127.0.0.1:${fa.port}/v1`,
    model: visionModel,
    modelToken: loopbackGrant,
    developmentLoopback: true,
    developmentImageInput: true,
    developmentContextWindow: 131072,
    maxCalls: 8,
    maxOutput: 1024,
    maxSeconds: 120,
  });
  const server = reachServer({ store, desk, publicOrigin: 'http://127.0.0.1', allowInsecureLoopback: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const sa = server.address();
  assert.ok(sa && typeof sa !== 'string');
  const base = `http://127.0.0.1:${sa.port}`;

  const childEnv: NodeJS.ProcessEnv = { ...process.env, NO_PROXY: '127.0.0.1,localhost,cas.ciqtek.com' };
  delete childEnv.CAS_API_KEY;
  const nodeState = join(root, 'node');
  const nodeCwd = join(root, 'remote');
  mkdirSync(nodeCwd, { recursive: true });
  const deviceSecretNote = 'DEVICE-NOTE-' + randomBytes(4).toString('hex').toUpperCase();
  writeFileSync(join(nodeCwd, 'note.txt'), deviceSecretNote + '\n', 'utf8');

  const pairCode = store.createPairing(session.user.id).code;
  const pairProc = spawn(nodeBinary!, ['--state-dir', nodeState, 'pair', '--server', base, '--code', pairCode, '--name', 'CasDeskNode', '--development'], {
    env: childEnv,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [pairExit] = await once(pairProc, 'close');
  assert.equal(pairExit, 0);

  const nodeProc = spawn(nodeBinary!, ['--state-dir', nodeState, 'run'], {
    env: childEnv,
    windowsHide: true,
    stdio: 'ignore',
  });

  try {
    const onlineNodeSchema = z.object({ id: z.string(), epoch: z.number(), online: z.boolean().optional() });
    const rawNode = await until(
      () => Promise.resolve(store.nodes(session.user.id)[0]),
      v => v !== undefined && Boolean(onlineNodeSchema.parse(v).online),
    );
    const parsedNode = onlineNodeSchema.parse(rawNode);
    const target = { nodeId: parsedNode.id, epoch: parsedNode.epoch, cwd: nodeCwd };

    const req = (path: string, method = 'GET', body?: unknown) =>
      fetch(base + path, {
        method,
        headers: { authorization: 'Bearer ' + session.token, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const convId = randomUUID();
    assert.equal((await req('/api/v1/desk/conversations', 'POST', { id: convId })).status, 201);

    // Turn 1: pure cloud math + nonce
    const nonce = randomBytes(4).toString('hex');
    const t1Id = randomUUID();
    await (await req(`/api/v1/desk/conversations/${convId}/messages`, 'POST', {
      id: t1Id,
      content: `Remember verification code ${nonce} and compute 37 + 5. Reply ONLY with JSON {"nonce":"${nonce}","sum":42} without fences or tool calls.`,
    })).text();
    const t1 = desk.store.turn(session.user.id, t1Id);
    assert.equal(t1.status, 'completed', JSON.stringify(t1));
    assert.deepEqual(extractJsonObject(t1.output), { nonce, sum: 42 });

    // Turn 2: native Session recall without repeating nonce
    const t2Id = randomUUID();
    await (await req(`/api/v1/desk/conversations/${convId}/messages`, 'POST', {
      id: t2Id,
      content: 'Recall the verification code from the previous message and compute 8 * 7. Reply ONLY with JSON {"nonce":"<recalled>","sum":56} without fences or tool calls.',
    })).text();
    const t2 = desk.store.turn(session.user.id, t2Id);
    assert.equal(t2.status, 'completed', JSON.stringify(t2));
    assert.deepEqual(extractJsonObject(t2.output), { nonce, sum: 56 });

    // Turn 3: paired local Node device file.read via reach_execute + verified ToolArtifact provenance
    const t3Id = randomUUID();
    await (await req(`/api/v1/desk/conversations/${convId}/messages`, 'POST', {
      id: t3Id,
      content: 'Use reach_execute with {"command":{"kind":"file.read","path":"note.txt","offset":0,"length":1024}} to read note.txt on the selected device, decode its base64 contentBase64, and reply ONLY with JSON {"deviceNote":"<decoded trimmed string>"}.',
      target,
    })).text();
    const t3 = desk.store.turn(session.user.id, t3Id);
    assert.equal(t3.status, 'completed', JSON.stringify(t3));
    assert.equal(extractJsonObject(t3.output).deviceNote, deviceSecretNote);

    const prov = z.object({
      entries: z.array(z.object({ record: z.object({ record: z.object({ status: z.string(), host_receipt: z.object({ verifier: z.string() }).optional() }) }) })),
      scopeErrors: z.array(z.unknown()),
    }).parse(await (await req(`/api/v1/desk/conversations/${convId}/provenance?status=verified`)).json());
    assert.deepEqual(prov.scopeErrors, []);
    assert.ok(prov.entries.length >= 1);
    assert.equal(prov.entries[0]!.record.record.host_receipt?.verifier, 'reach-desk-host');

    writeFileSync(join(root, 'sanitized-summary.json'), JSON.stringify({
      scenario: 'desk_real_multiturn_recall_and_paired_device_delegation',
      endpoint: casEndpoint,
      model: visionModel,
      conversationId: convId,
      turns: [t1Id, t2Id, t3Id],
      sessionRecallVerified: true,
      deviceNoteVerified: true,
      verifiedDeskArtifacts: prov.entries.length,
      taskAccepted: false,
    }, null, 2));
  } finally {
    if (nodeProc.pid && nodeProc.exitCode === null) {
      const exited = once(nodeProc, 'close');
      nodeProc.kill('SIGKILL');
      await exited;
    }
    await server.shutdown();
    forwarder.close();
    forwarder.closeAllConnections();
    await once(forwarder, 'close');
  }
  assertZeroSecretLeak(root, casKey);
  console.log(JSON.stringify({ casDeskEvidence: root }));
});
