// Copyright (c) Ray Zhang. End-to-end M07 verification: artifact_review, provenance_query, continue_reviewed, and guidance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { fixture, until, kill, delay } from './native-fixture.ts';
import { ReachClient } from '../src/controller/client.ts';
import { invoke } from '../src/controller/mcp.ts';
import { ReachStore } from '../src/service/store.ts';
import { reachServer } from '../src/service/server.ts';
import { DeskHost } from '../platform/src/host.ts';

const sidecar = process.env.REACH_DESK_SIDECAR;
const nodeBinary = process.env.REACH_NODE_BINARY;
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

interface ProviderMessage {
  role?: string;
  tool_call_id?: string;
  content?: string | { type?: string; text?: string }[];
}
interface ProviderBody {
  messages: ProviderMessage[];
}

const idResultSchema = z.object({ id: z.string() });
const generationSchema = z.object({ generation: z.number() });
const duplicateSchema = z.object({ duplicate: z.boolean() });
const guideReplySchema = z.object({ duplicate: z.boolean(), guidance: z.object({ status: z.string() }) });
const guidanceListSchema = z.object({
  guidance: z.array(z.object({
    messageId: z.string().optional(),
    message_id: z.string().optional(),
    status: z.string(),
    deliveredToNode: z.boolean().optional(),
  })),
});
const nodesResponseSchema = z.object({
  nodes: z.array(z.object({ id: z.string(), capabilities: z.array(z.string()) })),
});
const provenanceResultSchema = z.object({
  taskAccepted: z.boolean().optional(),
  entries: z.array(z.object({
    scope: z.object({ task_id: z.string() }),
    record: z.object({
      kind: z.string(),
      record: z.object({
        status: z.string(),
        host_receipt: z.object({ verifier: z.string() }).optional(),
      }),
    }),
  })),
  scopeErrors: z.array(z.unknown()),
});

const sseText = (value: string, finish: string | null = null) =>
  'data: ' + JSON.stringify({ id: 'm07-local', model: 'm07-local', choices: [{ index: 0, delta: { content: value }, finish_reason: finish }] }) + '\n\n';
const sseFinal = sseText('', 'stop') + 'data: [DONE]\n\n';
const sseTool = (id: string, name: string, args: Record<string, unknown>) =>
  'data: ' + JSON.stringify({
    id: 'm07-local',
    model: 'm07-local',
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }],
  }) + '\n\n' + sseText('', 'tool_calls') + 'data: [DONE]\n\n';

async function nodeSetup(handler: (body: ProviderBody, n: number, res: ServerResponse, root: string) => void | Promise<void>) {
  assert.ok(sidecar);
  const root = resolve('work/agent-m07-node-' + randomUUID());
  mkdirSync(root, { recursive: true });
  const token = randomBytes(32).toString('base64url');
  const requests: ProviderBody[] = [];
  let fault: unknown;
  const provider = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer ' + token);
      const chunks: Buffer[] = [];
      for await (const b of req) chunks.push(Buffer.from(b));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProviderBody;
      requests.push(body);
      writeFileSync(join(root, 'provider-requests.json'), JSON.stringify(requests, null, 2));
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      await handler(body, requests.length, res, root);
    } catch (error) {
      fault = error;
      res.destroy();
    }
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const addr = provider.address();
  assert.ok(addr && typeof addr !== 'string');
  const config = join(root, 'agent-runtime.json');
  writeFileSync(config, JSON.stringify({ sidecar, sha256: sha(readFileSync(sidecar)) }));
  const nodeEnv: NodeJS.ProcessEnv = { ...process.env, REACH_AGENT_CONFIG: config };
  for (const key of Object.keys(nodeEnv)) {
    if (key.startsWith('REACH_AGENT_MODEL_')) delete nodeEnv[key];
  }
  const f = await fixture('', nodeEnv, root, {
    ...process.env,
    REACH_AGENT_MODEL_URL: `http://127.0.0.1:${addr.port}/v1`,
    REACH_AGENT_MODEL_ID: 'm07-local',
    REACH_AGENT_MODEL_TOKEN: token,
    REACH_AGENT_MODEL_CONTEXT: '131072',
    REACH_AGENT_MODEL_MAX_OUTPUT: '1024',
    REACH_AGENT_MODEL_IMAGE_INPUT: '0',
  });
  assert.equal((await f.pair()).code, 0);
  let runner = f.node('run');
  const rawNodes = await until(
    () => f.request('/api/v1/nodes'),
    v => nodesResponseSchema.parse(v).nodes.some(n => n.capabilities.includes('agent.delegate') && n.capabilities.includes('agent.continue') && n.capabilities.includes('agent.provenance')),
  );
  const nodeId = nodesResponseSchema.parse(rawNodes).nodes[0]!.id;
  const loginRes = await f.loginController();
  assert.equal(loginRes.code, 0, loginRes.stderr);
  const authLogin = z.object({ token: z.string() }).parse(
    await f.request('/api/v1/auth/login', 'POST', { username: 'native-test', password: 'native-test-fixture-password' }),
  );
  const controllerDir = join(root, 'controller-sdk');
  mkdirSync(controllerDir, { recursive: true });
  const client = new ReachClient({ server: f.origin, token: authLogin.token, development: true }, controllerDir);
  return {
    f,
    root,
    nodeId,
    client,
    requests,
    get runner() { return runner; },
    restartRunner() { runner = f.node('run'); return runner; },
    async close() {
      await f.cleanup();
      provider.close();
      provider.closeAllConnections();
      await once(provider, 'close');
      assert.equal(fault, undefined, String(fault));
    },
  };
}

test('Node + MCP verify ToolArtifact, query provenance across Tasks, continue_reviewed cross-process, and reject tampered released.json', { timeout: 120000, skip: !sidecar }, async () => {
  const t = await nodeSetup((body, n, res) => {
    if (n === 1) {
      res.end(sseTool('write-v1', 'reach_execute', { command: { kind: 'file.write', path: 'draft.txt', contentBase64: Buffer.from('v1\n').toString('base64') } }));
    } else if (n === 2) {
      res.end(sseText('Draft v1 written; ready for offline review.') + sseFinal);
    } else if (n === 3) {
      const flat = JSON.stringify(body.messages);
      assert.match(flat, /Host review feedback/);
      assert.match(flat, /Upgrade draft\.txt to v2/);
      res.end(sseTool('write-v2', 'reach_execute', { command: { kind: 'file.write', path: 'draft.txt', contentBase64: Buffer.from('v2\n').toString('base64') } }));
    } else if (n === 4) {
      res.end(sseText('Upgraded draft.txt to v2.') + sseFinal);
    } else if (n === 5) {
      res.end(sseText('Second Task initial release before tamper test.') + sseFinal);
    } else {
      assert.fail('Unexpected model request ' + n);
    }
  });
  try {
    const sessionId = randomUUID();
    const first = await t.f.submit({
      kind: 'agent.delegate',
      sessionId,
      cwd: t.root,
      objective: 'Create draft.txt and report its receipt.',
      reviewMode: 'cross_process',
      maxRuns: 2,
      maxCalls: 6,
      maxSeconds: 90,
      maxOutput: 1024,
    });
    const settledFirst = await t.f.settled(first.id);
    assert.equal(settledFirst.execution, 'succeeded', JSON.stringify(settledFirst));
    assert.equal(readFileSync(join(t.root, 'draft.txt'), 'utf8'), 'v1\n');

    const released1Path = join(t.f.state, 'agents', first.id, 'evidence', 'released.json');
    const released1Sha = sha(readFileSync(released1Path));
    const outcome1 = z.object({
      runs: z.number(),
      artifacts: z.array(z.object({ status: z.string(), artifact_id: z.string() })),
    }).parse(JSON.parse(readFileSync(released1Path, 'utf8')));
    assert.equal(outcome1.runs, 1);
    assert.equal(outcome1.artifacts.length, 1);
    assert.equal(outcome1.artifacts[0]!.status, 'verified');
    const reachArtifacts1 = z.object({
      artifacts: z.array(z.object({ status: z.string(), host_receipt: z.object({ verifier: z.string() }) })),
    }).parse(JSON.parse(readFileSync(join(t.f.state, 'agents', first.id, 'evidence', 'reach-artifacts-1.json'), 'utf8')));
    assert.equal(reachArtifacts1.artifacts[0]!.host_receipt.verifier, 'reach-node-host');

    const continuedOp = idResultSchema.parse(await invoke(t.client, 'reach_agent_continue', {
      requestId: randomUUID(),
      nodeId: t.nodeId,
      rootOperationId: first.id,
      previousExecutionId: first.id,
      releasedSha256: released1Sha,
      feedback: 'Upgrade draft.txt to v2 and report the new receipt.',
    }));
    const settledCont = await t.f.settled(continuedOp.id);
    assert.equal(settledCont.execution, 'succeeded', JSON.stringify(settledCont));
    assert.equal(readFileSync(join(t.root, 'draft.txt'), 'utf8'), 'v2\n');
    const contResult = z.object({ outcome: z.object({ runs: z.number(), observed_calls: z.number() }) }).parse(JSON.parse(settledCont.result_json));
    assert.equal(contResult.outcome.runs, 2);
    assert.equal(contResult.outcome.observed_calls, 4);

    // Tampered released.json on a second cross_process Task must fail closed with zero extra model calls.
    const second = await t.f.submit({
      kind: 'agent.delegate',
      sessionId: randomUUID(),
      cwd: t.root,
      objective: 'Produce an initial candidate for tamper testing.',
      reviewMode: 'cross_process',
      maxRuns: 2,
      maxCalls: 4,
      maxSeconds: 90,
      maxOutput: 1024,
    });
    assert.equal((await t.f.settled(second.id)).execution, 'succeeded');
    const released2Path = join(t.f.state, 'agents', second.id, 'evidence', 'released.json');
    const originalBytes = Buffer.from(readFileSync(released2Path));
    const originalSha = sha(originalBytes);
    const tampered = Buffer.from(originalBytes);
    tampered[tampered.length - 2] ^= 1;
    writeFileSync(released2Path, tampered);

    const callsBeforeTamper = t.requests.length;
    const tamperedCont = idResultSchema.parse(await invoke(t.client, 'reach_agent_continue', {
      requestId: randomUUID(),
      nodeId: t.nodeId,
      rootOperationId: second.id,
      previousExecutionId: second.id,
      releasedSha256: originalSha,
      feedback: 'Must not execute after released.json tampering.',
    }));
    const tamperedSettled = await t.f.settled(tamperedCont.id);
    assert.equal(tamperedSettled.execution, 'unknown');
    assert.match(tamperedSettled.result_json, /released\.json digest mismatch/);
    assert.equal(t.requests.length, callsBeforeTamper);

    // Restore original released2Path and query cross-Task provenance via real MCP server + CLI subprocess.
    writeFileSync(released2Path, originalBytes);
    const mcp = t.f.mcp();
    await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'm07-test', version: '1.0.0' } });
    const toolsList = z.object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) }).parse(await mcp.call('tools/list'));
    for (const expectedName of ['reach_agent_guide', 'reach_agent_guidance', 'reach_agent_continue', 'reach_agent_provenance']) {
      assert.ok(toolsList.result.tools.some(tl => tl.name === expectedName), 'missing MCP tool ' + expectedName);
    }
    const mcpProvCall = z.object({ result: z.object({ content: z.array(z.object({ text: z.string() })) }) }).parse(
      await mcp.call('tools/call', {
        name: 'reach_agent_provenance',
        arguments: { requestId: randomUUID(), nodeId: t.nodeId, rootOperationIds: [first.id, second.id], status: 'verified' },
      }),
    );
    const provOp = idResultSchema.parse(JSON.parse(mcpProvCall.result.content[0]!.text));
    const provSettled = await t.f.settled(provOp.id);
    assert.equal(provSettled.execution, 'succeeded', JSON.stringify(provSettled));
    const provResult = provenanceResultSchema.parse(JSON.parse(provSettled.result_json));
    assert.equal(provResult.taskAccepted, false);
    assert.deepEqual(provResult.scopeErrors, []);
    assert.equal(provResult.entries.length, 2);
    assert.ok(provResult.entries.every(e => e.scope.task_id === first.id && e.record.kind === 'artifact' && e.record.record.status === 'verified' && e.record.record.host_receipt?.verifier === 'reach-node-host'));

    await kill(mcp.child);
    const cliTask = await t.f.controller(['agent-task', first.id]).done;
    assert.equal(cliTask.code, 0, cliTask.stderr);
    assert.equal(generationSchema.parse(JSON.parse(cliTask.stdout)).generation, 2);
  } finally {
    await t.close();
  }
});

test('Node + MCP guidance applies in-run, deduplicates retries, rejects conflicts, and preserves unknown on SIGKILL', { timeout: 120000, skip: !sidecar }, async () => {
  let releaseFirst = () => {};
  let firstWaiting = false;
  let crashWaiting = false;
  let mode: 'normal' | 'crash' = 'normal';
  const t = await nodeSetup(async (body, n, res) => {
    if (mode === 'normal' && n === 1) {
      firstWaiting = true;
      await new Promise<void>(r => { releaseFirst = r; });
      res.end(sseTool('noop-dir', 'reach_execute', { command: { kind: 'directory.list', path: '.' } }));
    } else if (mode === 'normal' && n === 2) {
      assert.match(JSON.stringify(body.messages), /Focus on subsystem zeta/);
      res.end(sseText('Applied guidance for subsystem zeta.') + sseFinal);
    } else if (mode === 'crash') {
      crashWaiting = true;
      await delay(60000);
      res.end(sseText('unreachable') + sseFinal);
    }
  });
  try {
    const op = await t.f.submit({
      kind: 'agent.delegate',
      sessionId: randomUUID(),
      cwd: t.root,
      objective: 'Inspect directory and follow any operator guidance.',
      maxCalls: 4,
      maxSeconds: 60,
      maxOutput: 1024,
    });
    await until(async () => firstWaiting, Boolean);
    const firstGuide = guideReplySchema.parse(await invoke(t.client, 'reach_agent_guide', {
      operationId: op.id,
      messageId: 'guide-1',
      text: 'Focus on subsystem zeta',
    }));
    assert.equal(firstGuide.duplicate, false);
    assert.equal(firstGuide.guidance.status, 'queued');

    const dupGuide = duplicateSchema.parse(await invoke(t.client, 'reach_agent_guide', {
      operationId: op.id,
      messageId: 'guide-1',
      text: 'Focus on subsystem zeta',
    }));
    assert.equal(dupGuide.duplicate, true);

    await assert.rejects(
      invoke(t.client, 'reach_agent_guide', {
        operationId: op.id,
        messageId: 'guide-1',
        text: 'Conflicting guidance body',
      }),
      /agent_guidance_conflict/,
    );

    await until(
      () => invoke(t.client, 'reach_agent_guidance', { operationId: op.id }),
      v => guidanceListSchema.parse(v).guidance[0]?.deliveredToNode === true,
    );
    releaseFirst();
    const settled = await t.f.settled(op.id);
    assert.equal(settled.execution, 'succeeded', JSON.stringify(settled));
    const listed = guidanceListSchema.parse(await invoke(t.client, 'reach_agent_guidance', { operationId: op.id }));
    assert.equal(listed.guidance.length, 1);
    assert.equal(listed.guidance[0]!.status, 'applied');

    // Crash scenario: SIGKILL Node after guidance is delivered; status must become unknown, never applied.
    mode = 'crash';
    const crashOp = await t.f.submit({
      kind: 'agent.delegate',
      sessionId: randomUUID(),
      cwd: t.root,
      objective: 'Wait while crash test runs.',
      maxCalls: 3,
      maxSeconds: 60,
      maxOutput: 1024,
    });
    await until(async () => crashWaiting, Boolean);
    await invoke(t.client, 'reach_agent_guide', {
      operationId: crashOp.id,
      messageId: 'guide-crash',
      text: 'Guidance before SIGKILL',
    });
    await until(
      () => invoke(t.client, 'reach_agent_guidance', { operationId: crashOp.id }),
      v => guidanceListSchema.parse(v).guidance[0]?.deliveredToNode === true,
    );
    await kill(t.runner.child);
    t.restartRunner();
    await until(() => t.f.operation(crashOp.id), v => z.object({ execution: z.string() }).parse(v).execution === 'unknown', 30000);
    const afterCrash = guidanceListSchema.parse(await invoke(t.client, 'reach_agent_guidance', { operationId: crashOp.id }));
    assert.equal(afterCrash.guidance[0]!.status, 'unknown');
  } finally {
    await t.close();
  }
});

test('Reach Desk verifies device ToolArtifact, queries provenance, continues reviewed turns, rejects tampered released.json, and settles guided turns', { timeout: 120000, skip: !sidecar || !nodeBinary }, async () => {
  const root = resolve('work/desk-m07-' + randomUUID());
  mkdirSync(root, { recursive: true });
  let releaseGate = () => {};
  let gated = false;
  const requests: ProviderBody[] = [];
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const b of req) chunks.push(Buffer.from(b));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProviderBody;
    requests.push(body);
    const n = requests.length;
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    if (n === 1) {
      gated = true;
      await new Promise<void>(r => { releaseGate = r; });
      res.end(sseTool('desk-write', 'reach_execute', { command: { kind: 'file.write', path: 'desk-m07.txt', contentBase64: Buffer.from('desk-v1\n').toString('base64') } }));
    } else if (n === 2) {
      assert.match(JSON.stringify(body.messages), /Desk operator note alpha/);
      res.end(sseText('Desk Run 1 completed with guidance.') + sseFinal);
    } else if (n === 3) {
      assert.match(JSON.stringify(body.messages), /Host review feedback/);
      assert.match(JSON.stringify(body.messages), /Append v2 note/);
      res.end(sseText('Desk Run 2 reviewed continuation completed.') + sseFinal);
    } else {
      res.end(sseText('Extra reply') + sseFinal);
    }
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const pa = provider.address();
  assert.ok(pa && typeof pa !== 'string');

  const store = new ReachStore(join(root, 'reach.sqlite'));
  store.bootstrap('desk-m07', 'controlled-desk-m07-password');
  const session = store.login('desk-m07', 'controlled-desk-m07-password');
  const desk = new DeskHost({
    stateDirectory: join(root, 'desk'),
    binary: sidecar!,
    endpoint: `http://127.0.0.1:${pa.port}/v1`,
    model: 'm07-local',
    modelToken: 'controlled-desk-token',
    developmentLoopback: true,
    maxCalls: 6,
    maxSeconds: 60,
  });
  const server = reachServer({ store, desk, publicOrigin: 'http://127.0.0.1', allowInsecureLoopback: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const sa = server.address();
  assert.ok(sa && typeof sa !== 'string');
  const base = `http://127.0.0.1:${sa.port}`;
  const req = (path: string, method = 'GET', data?: unknown) =>
    fetch(base + path, {
      method,
      headers: { authorization: 'Bearer ' + session.token, 'content-type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });

  const nodeState = join(root, 'node');
  const nodeCwd = join(root, 'remote');
  mkdirSync(nodeCwd, { recursive: true });
  const pairCode = store.createPairing(session.user.id).code;
  const pairProc = spawn(nodeBinary!, ['--state-dir', nodeState, 'pair', '--server', base, '--code', pairCode, '--name', 'DeskM07Node', '--development'], {
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let pairErr = '';
  pairProc.stderr.on('data', b => { pairErr += String(b); });
  const [pairCodeExit] = await once(pairProc, 'close');
  assert.equal(pairCodeExit, 0, pairErr);
  const nodeProc = spawn(nodeBinary!, ['--state-dir', nodeState, 'run'], {
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' },
    windowsHide: true,
    stdio: 'ignore',
  });

  try {
    const nodeEntrySchema = z.object({ id: z.string(), epoch: z.number(), online: z.boolean(), capabilities: z.array(z.string()) });
    const rawTargetNode = await until(
      () => Promise.resolve(store.nodes(session.user.id)[0]),
      v => v !== undefined && nodeEntrySchema.parse(v).online && nodeEntrySchema.parse(v).capabilities.includes('file.write'),
    );
    const parsedNode = nodeEntrySchema.parse(rawTargetNode);
    const target = { nodeId: parsedNode.id, epoch: parsedNode.epoch, cwd: nodeCwd };
    const convId = randomUUID();
    assert.equal((await req('/api/v1/desk/conversations', 'POST', { id: convId })).status, 201);

    const turn1Id = randomUUID();
    const postPromise = req(`/api/v1/desk/conversations/${convId}/messages`, 'POST', {
      id: turn1Id,
      content: 'Write desk-m07.txt on the paired device.',
      target,
      maxRuns: 3,
    }).then(r => r.text());

    await until(async () => gated, Boolean);
    const g1 = await req(`/api/v1/desk/messages/${turn1Id}/guidance`, 'POST', { messageId: 'dg-1', text: 'Desk operator note alpha' });
    assert.equal(g1.status, 202);
    const gDup = await req(`/api/v1/desk/messages/${turn1Id}/guidance`, 'POST', { messageId: 'dg-1', text: 'Desk operator note alpha' });
    assert.equal(gDup.status, 200);
    assert.equal(duplicateSchema.parse(await gDup.json()).duplicate, true);
    const gConflict = await req(`/api/v1/desk/messages/${turn1Id}/guidance`, 'POST', { messageId: 'dg-1', text: 'Conflict' });
    assert.equal(gConflict.status, 409);

    await delay(200);
    releaseGate();
    const sse1 = await postPromise;
    assert.match(sse1, /"status":"completed"/);
    assert.equal(readFileSync(join(nodeCwd, 'desk-m07.txt'), 'utf8'), 'desk-v1\n');

    const gList = guidanceListSchema.parse(await (await req(`/api/v1/desk/messages/${turn1Id}/guidance`)).json());
    assert.equal(gList.guidance[0]!.status, 'applied');

    const prov = provenanceResultSchema.parse(await (await req(`/api/v1/desk/conversations/${convId}/provenance?status=verified`)).json());
    assert.deepEqual(prov.scopeErrors, []);
    assert.equal(prov.entries.length, 1);
    assert.equal(prov.entries[0]!.record.record.status, 'verified');
    assert.equal(prov.entries[0]!.record.record.host_receipt?.verifier, 'reach-desk-host');

    const turn1 = desk.store.turn(session.user.id, turn1Id);
    const released1Path = join(root, 'desk', 'tasks', turn1.task_id, 'evidence', 'released.json');
    const released1Sha = sha(readFileSync(released1Path));

    const turn2Id = randomUUID();
    const sse2 = await (await req(`/api/v1/desk/messages/${turn1Id}/continue`, 'POST', {
      id: turn2Id,
      expectedReleasedSha256: released1Sha,
      feedback: 'Append v2 note in response.',
    })).text();
    assert.match(sse2, /"status":"completed"/);

    // Tampered released.json on turn2 must fail closed without calling the provider.
    const turn2 = desk.store.turn(session.user.id, turn2Id);
    const released2Path = join(root, 'desk', 'tasks', turn2.task_id, 'evidence', 'released.json');
    const orig2 = Buffer.from(readFileSync(released2Path));
    const orig2Sha = sha(orig2);
    const bad2 = Buffer.from(orig2);
    bad2[bad2.length - 2] ^= 1;
    writeFileSync(released2Path, bad2);
    const reqsBefore = requests.length;
    const turn3Id = randomUUID();
    const res3 = await req(`/api/v1/desk/messages/${turn2Id}/continue`, 'POST', {
      id: turn3Id,
      expectedReleasedSha256: orig2Sha,
      feedback: 'Should be rejected due to tampered released.json',
    });
    assert.equal(res3.status, 409);
    assert.equal(desk.store.conversation(session.user.id, convId).blocked, 0);
    assert.equal(requests.length, reqsBefore);
  } finally {
    if (nodeProc.pid && nodeProc.exitCode === null) {
      const exited = once(nodeProc, 'close');
      spawnSync('taskkill.exe', ['/PID', String(nodeProc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await exited;
    }
    await server.shutdown();
    provider.close();
    provider.closeAllConnections();
    await once(provider, 'close');
  }
});
