// Protocol fixture processes exercise the Node boundary, not Rust execution or model quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { startTask } from './client.mjs';

const fixture = String.raw`
import { createInterface } from 'node:readline';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const input = createInterface({ input: process.stdin });
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let start, scenario;
async function finish() {
  const outcome = { task_id: start.task.task_id, stop: 'Informational', task_accepted: false,
    runs: 1, observed_calls: 0, fence_presence: 'Released', reconciliation_fence: null };
  const target = path.join(start.task.evidence_dir, 'outcome.json');
  const bytes = JSON.stringify(outcome);
  await fs.writeFile(target, bytes);
  emit({ kind: 'task_result', version: 1, ...outcome, local_callbacks_finished: true,
    outcome_ref: { path: target, sha256: createHash('sha256').update(bytes).digest('hex') } });
  input.close(); process.stdin.destroy();
}
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.kind === 'start_task') {
    start = frame; scenario = JSON.parse(frame.run.objective);
    await fs.mkdir(start.task.evidence_dir);
    if (scenario.waitForGuide) continue;
    emit({ kind: 'event', version: 1, task_id: start.task.task_id, run_id: start.run.run_id,
      seq: 1, event_type: 'message_update', delivery: 'best_effort_not_complete_evidence', ...scenario.frame });
    await finish();
  } else if (frame.kind === 'guide') {
    emit({ kind: 'guidance_ack', version: 1, task_id: start.task.task_id,
      message_id: frame.message_id, status: 'queued', ...scenario.frame });
    await finish();
  } else if (frame.kind === 'cancel') await finish();
}
`;

async function run(t, { frame = {}, waitForGuide = false, optIns = {}, observer } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'morrow-node-events-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'fixture.mjs');
  await fs.writeFile(script, fixture);
  const observed = [];
  const handle = await startTask({ binary: process.execPath, binaryArgs: [script],
    modelToken: 'fixture-only', operationDirectory: path.join(root, 'operations'),
    start: { kind: 'start_task', version: 1, ...optIns,
      task: { task_id: 'events-task', criteria_revision: 'c1', authorization_revision: 'a1',
        evidence_dir: path.join(root, 'evidence'), deadline_unix_ms: Date.now() + 5000 },
      run: { run_id: 'run-1', objective: JSON.stringify({ frame, waitForGuide }), tools: [] } },
    callbacks: { tool() { throw Error('unexpected tool'); }, verify() { throw Error('unexpected verify'); },
      prepare() { throw Error('unexpected continuation'); } },
    onEvent(value) { observed.push(value); return observer?.(value); } });
  t.after(() => { if (!handle.status().closed) handle.forceKill(); });
  if (waitForGuide) await handle.guide('message-1', '请核对来源');
  return { result: await handle.wait(), observed, handle };
}

test('legacy event shape remains readable with and without rich opt-in', async t => {
  for (const optIns of [{}, { event_payloads: true }]) {
    const { result, observed } = await run(t, { optIns });
    assert.equal(result.delivery, 'validated');
    assert.equal(observed.length, 1);
    assert.equal(Object.hasOwn(observed[0], 'payload'), false);
  }
});

test('rich payload preserves text and extensible fields without giving observer control', async t => {
  const payload = { type: 'message_update', delta: '真实资料\nα', metadata: { native_call_id: 'c1' } };
  const { result, observed } = await run(t, { frame: { payload }, optIns: { event_payloads: true },
    observer: async () => { throw Error('observer only'); } });
  assert.equal(result.delivery, 'validated');
  assert.deepEqual(observed[0].payload, payload);
  assert.equal(result.outcome.task_accepted, false);
});

for (const [name, frame, optIns] of [
  ['payload without opt-in', { payload: { type: 'message_update' } }, {}],
  ['payload type mismatch', { payload: { type: 'agent_end' } }, { event_payloads: true }],
  ['nonobject payload', { payload: [] }, { event_payloads: true }],
  ['unknown envelope field', { extra: true }, {}],
  ['wrong Run', { run_id: 'other-run' }, {}],
  ['wrong Task', { task_id: 'other-task' }, {}],
  ['negative sequence', { seq: -1 }, {}],
  ['noninteger sequence', { seq: 1.5 }, {}],
  ['false delivery claim', { delivery: 'complete' }, {}],
]) test(`event refuses ${name}`, async t => {
  const { result, observed } = await run(t, { frame, optIns });
  assert.equal(result.delivery, 'unknown');
  assert.equal(result.fault, 'invalid_stdout_protocol');
  assert.equal(observed.length, 0);
});

test('guidance acknowledgement reaches observer with original message identity', async t => {
  const { result, observed, handle } = await run(t, { waitForGuide: true, optIns: { guidance: true } });
  assert.equal(result.delivery, 'validated');
  assert.deepEqual(observed, [{ kind: 'guidance_ack', version: 1, task_id: 'events-task', message_id: 'message-1', status: 'queued' }]);
  assert.throws(() => handle.guide('late', 'late message'), /task_not_running/);
});

for (const [name, frame] of [
  ['unknown message', { message_id: 'not-sent' }],
  ['invalid status', { status: 'accepted' }],
  ['unexpected field', { run_id: 'run-1' }],
]) test(`guidance acknowledgement refuses ${name}`, async t => {
  const { result, observed } = await run(t, { waitForGuide: true, optIns: { guidance: true }, frame });
  assert.equal(result.fault, 'invalid_stdout_protocol');
  assert.equal(observed.length, 0);
});

for (const scenario of ['applied', 'unapplied', 'conflict']) test(`real Rust guidance ${scenario} preserves message identity and receipts`, {
  skip: !process.env.MORROW_TEST_BINARY, timeout: 20000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'morrow-real-events-'));
  t.diagnostic(`evidence ${root}`);
  let entered, release, acknowledge, reviewed, finishReview, duplicated;
  const providerEntered = new Promise(resolve => { entered = resolve; });
  const respond = new Promise(resolve => { release = resolve; });
  const acknowledged = new Promise(resolve => { acknowledge = resolve; });
  const reviewEntered = new Promise(resolve => { reviewed = resolve; });
  const reviewReleased = new Promise(resolve => { finishReview = resolve; });
  const duplicateAcknowledged = new Promise(resolve => { duplicated = resolve; });
  const bodies = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    entered();
    await respond;
    response.setHeader('Content-Type', 'text/event-stream');
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Controlled result.' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    release(); finishReview(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const observed = [];
  const handle = await startTask({ binary: process.env.MORROW_TEST_BINARY,
    modelToken: 'controlled-only', operationDirectory: path.join(root, 'operations'),
    start: { kind: 'start_task', version: 1, event_payloads: true, emit_events: true, guidance: true,
      task: { task_id: 'real-event-task', criteria_revision: 'c1', authorization_revision: 'a1',
        kind: 'Reasoning', evidence_dir: path.join(root, 'evidence'), max_runs: 1, max_calls: 4,
        deadline_unix_ms: Date.now() + 15000 },
      run: { run_id: 'real-event-run', objective: 'Answer the question.', cwd: root,
        session_path: path.join(root, 'session.json'), environment_state: path.join(root, 'environment'),
        device_fp: 'controlled-host', session_key: 'controlled/session', mode: 'execute',
        endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'controlled-model',
        max_calls: 4, max_seconds: 10, max_output: 256, tools: [],
        model_resolution: { kind: 'host_declared_loopback', capabilities: { context_window: 32000, max_tokens: 4096, input: ['text'] } } } },
    callbacks: { tool() { throw Error('unexpected tool'); },
      async verify(candidate) {
        reviewed();
        if (scenario === 'unapplied') await reviewReleased;
        return { basis: candidate.basis, committed: true, settlement: 'Settled', verdict: 'Verified', evidence: ['controlled-review'] };
      },
      prepare() { throw Error('unexpected continuation'); } },
    onEvent(frame) {
      observed.push(frame);
      if (frame.kind === 'guidance_ack' && frame.status === 'queued') acknowledge(frame);
      if (frame.kind === 'guidance_ack' && frame.status === 'duplicate') duplicated(frame);
    } });
  t.after(() => { if (!handle.status().closed) handle.forceKill(); });
  // Wait until the actual Rust runtime is executing the controlled model call.
  await providerEntered;
  if (scenario === 'unapplied') { release(); await reviewEntered; }
  await handle.guide('real-message', 'Keep the source reference.');
  const ack = await acknowledged;
  assert.equal(ack.message_id, 'real-message');
  assert.equal(ack.status, 'queued'); // Queued is not proof that the model applied it.
  if (scenario === 'applied') {
    await handle.guide('real-message', 'Keep the source reference.');
    assert.equal((await duplicateAcknowledged).message_id, 'real-message');
    release();
  } else if (scenario === 'unapplied') finishReview();
  else await handle.guide('real-message', 'Conflicting text must be rejected.');
  const result = await handle.wait();
  assert.equal(result.delivery, 'validated', JSON.stringify(result));
  const receipts = JSON.parse(await fs.readFile(path.join(root, 'evidence', 'jsonl-guidance.json'), 'utf8'));
  assert.equal(receipts.task_id, 'real-event-task');
  assert.equal(receipts.messages.length, 1);
  assert.equal(receipts.messages[0].message_id, 'real-message');
  assert.equal(receipts.messages[0].input_sha256.length, 64);
  const expectedStatus = scenario === 'applied' ? 'applied' : 'unapplied';
  assert.equal(receipts.messages[0].status, expectedStatus);
  assert.equal(observed.filter(frame => frame.kind === 'guidance_ack').at(-1).status, expectedStatus);
  if (scenario === 'applied') {
    const source = 'Keep the source reference.';
    assert.ok(bodies.some(body => JSON.stringify(body).includes(source)));
    const session = JSON.parse(await fs.readFile(path.join(root, 'session.json'), 'utf8'));
    const context = JSON.parse(await fs.readFile(path.join(root, 'session.context.json'), 'utf8'));
    assert.equal(session.messages.filter(message => message.role === 'user' && message.content === source).length, 1);
    assert.equal(context.references.filter(reference => reference.kind === 'steering' && reference.text === source).length, 1);
  }
  if (scenario === 'conflict') {
    assert.equal(receipts.failure_category, 'guidance_identity_conflict');
    assert.equal(result.outcome.stop, 'Cancelled');
    assert.ok(bodies.every(body => !JSON.stringify(body).includes('Conflicting text')));
  }
  const events = observed.filter(frame => frame.kind === 'event');
  assert.ok(events.length > 0);
  assert.ok(events.every(frame => frame.payload.type === frame.event_type));
  await fs.writeFile(path.join(root, 'observed-frames.json'), JSON.stringify(observed, null, 2));
});
