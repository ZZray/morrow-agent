import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startTask } from './client.mjs';
import { sendManagement } from './management.mjs';

const binary = process.env.MORROW_TEST_BINARY ?? process.env.MORROW_AGENT_JSONL_BINARY;
const integration = { skip: !binary, timeout: 30000 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, mode = 'normal') {
  const root = await mkdtemp(path.join(tmpdir(), 'morrow-jsonl-dispatch-'));
  t.diagnostic(`evidence ${root}`);
  const requests = [];
  let entered, release;
  const providerEntered = new Promise(resolve => { entered = resolve; });
  const responseGate = new Promise(resolve => { release = resolve; });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const number = requests.length;
    entered();
    if (mode === 'hold') await responseGate;
    if (mode === 'fail') { response.writeHead(400); response.end('controlled failure'); return; }
    const tool = mode === 'tool' && number === 1;
    response.setHeader('Content-Type', 'text/event-stream');
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'native-effect', type: 'function', function: { name: 'effect', arguments: '{}' } }] }
      : { role: 'assistant', content: 'A source-backed result.' };
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const configuration_sha256 = 'c'.repeat(64);
  const start = { kind: 'start_task', version: 1, event_payloads: true, emit_events: true,
    task: { task_id: 'queued-task', criteria_revision: 'c1', authorization_revision: 'a1', kind: 'Reasoning',
      evidence_dir: path.join(root, 'first'), max_runs: 3, max_calls: 8, deadline_unix_ms: Date.now() + 60000 },
    run: { run_id: 'run-1', objective: 'Inspect the original source.', cwd: root, session_path: path.join(root, 'session.json'),
      environment_state: path.join(root, 'environment'), device_fp: 'controlled-host', session_key: 'controlled-session', mode: 'execute',
      endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'controlled', max_calls: 4, max_seconds: 20, max_output: 256,
      model_resolution: { kind: 'host_declared_loopback', capabilities: { context_window: 32000, max_tokens: 4096, input: ['text'] } },
      tools: mode === 'tool' ? [{ name: 'effect', description: 'Perform the authorized fixture operation.', parameters: { type: 'object', properties: {} } }] : [] },
    orchestration: { directory: path.join(root, 'queue'), assignment_id: 'assignment-1', worker_id: 'worker-1',
      lease_expires_at_ms: Date.now() + 5000, configuration_sha256, attempt_id: 'attempt-1' } };
  const manage = request => sendManagement({ binary, request });
  await manage({ operation: 'queue_enqueue', directory: start.orchestration.directory,
    trigger: { id: 'trigger-1', revision: '1', source_ref: 'host:source' },
    mandate: { id: 'mandate-1', revision: '1', authorization_ref: 'host:approval', configuration_sha256 },
    assignment: { id: 'assignment-1', trigger_id: 'trigger-1', mandate_id: 'mandate-1', task: start.task,
      session_id: start.run.session_key, session_path: start.run.session_path, cwd: root, configuration_sha256, options: {} }, at_ms: Date.now() });
  let clients = 0;
  const callbacks = {
    tool() { throw Error('unexpected external tool'); },
    verify(candidate) { return { basis: candidate.basis, committed: true, settlement: 'Settled', verdict: 'Verified', evidence: ['controlled-review'] }; },
    prepare() { throw Error('unexpected automatic continuation'); },
  };
  const begin = async (frame = start, overrides = {}) => {
    const handle = await startTask({ binary, start: frame, modelToken: 'controlled-only',
      operationDirectory: path.join(root, `client-${++clients}`), callbacks: { ...callbacks, ...overrides } });
    t.after(() => { if (!handle.status().closed) handle.forceKill(); });
    return handle;
  };
  const snapshot = async () => (await manage({ operation: 'queue_snapshot', directory: start.orchestration.directory })).assignments['assignment-1'];
  const recovery = async decision => {
    const assignment = await snapshot();
    const receipt = { assignment_id: 'assignment-1', attempt_id: assignment.attempts.at(-1).intent.attempt_id,
      task_id: start.task.task_id, session_path: assignment.specification.session_path, configuration_sha256,
      committed: true, settled: true, decision };
    const bytes = JSON.stringify(receipt);
    const target = path.join(root, `${decision}.json`);
    await writeFile(target, bytes);
    return { path: target, sha256: hash(bytes) };
  };
  return { root, start, requests, begin, snapshot, manage, recovery, providerEntered };
}

test('queued JSONL dispatch persists one actual Task and its outcome before terminal delivery', integration, async t => {
  const f = await fixture(t);
  assert.equal((await f.snapshot()).phase, 'queued');
  const result = await (await f.begin()).wait();
  assert.equal(result.delivery, 'validated', JSON.stringify(result));
  const assignment = await f.snapshot();
  assert.equal(assignment.phase, 'settled');
  assert.equal(assignment.attempts.length, 1);
  assert.equal(assignment.attempts[0].outcome.stop, result.outcome.stop);
  assert.equal(assignment.attempts[0].runs.length, 1);
  assert.equal(result.outcome.task_accepted, false);
  assert.equal(f.requests.length, 1);
});

test('queued assignment rejects changed Task authority before claim or model dispatch', integration, async t => {
  const f = await fixture(t);
  for (const task of [{ ...f.start.task, max_calls: 9 }, { ...f.start.task, evidence_dir: path.join(f.root, 'ungranted-evidence') }]) {
    assert.equal((await (await f.begin({ ...f.start, task })).wait()).delivery, 'unknown');
    assert.equal((await f.snapshot()).phase, 'queued');
  }
  assert.equal(f.requests.length, 0);
});

test('management provenance query binds actual queued tool artifacts to its granted Task and Session', integration, async t => {
  const f = await fixture(t, 'tool');
  const receipt = path.join(f.root, 'actual-tool-receipt.txt');
  const result = await (await f.begin(f.start, { tool: async () => {
    await writeFile(receipt, 'Actual controlled tool result.', { flag: 'wx' });
    return { value: { output: 'Actual controlled tool result.' }, is_error: false, settlement: 'Settled', operation_receipt: receipt };
  } })).wait();
  assert.equal(result.delivery, 'validated', JSON.stringify(result));
  const scope = { task_id: f.start.task.task_id, session_id: f.start.run.session_key, evidence_dir: f.start.task.evidence_dir };
  const report = await f.manage({ operation: 'provenance_query', scopes: [scope], query: { kind: 'artifact' } });
  assert.deepEqual(report.scope_errors, []);
  assert.ok(report.entries.some(entry => entry.record.kind === 'artifact' && entry.record.record.tool === 'effect'));
  assert.ok(report.entries.every(entry => entry.scope.task_id === scope.task_id && entry.scope.session_id === scope.session_id));
  const wrong = await f.manage({ operation: 'provenance_query', scopes: [{ ...scope, task_id: 'another-task' }], query: {} });
  assert.equal(wrong.entries.length, 0);
  assert.ok(wrong.scope_errors.length > 0);
  await assert.rejects(f.manage({ operation: 'provenance_query', scopes: [scope, scope], query: {} }), /one explicit evidence scope/);
});

test('queued dispatch cancellation is durable and joins the original Task', integration, async t => {
  const f = await fixture(t, 'hold');
  const handle = await f.begin();
  await f.providerEntered;
  handle.cancel();
  const result = await handle.wait();
  assert.equal(result.delivery, 'validated', JSON.stringify(result));
  assert.equal(result.outcome.stop, 'Cancelled');
  const assignment = await f.snapshot();
  assert.equal(assignment.cancellation_requested, true);
  assert.equal(assignment.attempts.length, 1);
  assert.equal(assignment.attempts[0].outcome.stop, 'Cancelled');
  assert.equal(f.requests.length, 1);
});

test('failed queued dispatch retains its fence and refuses an ordinary replay', integration, async t => {
  const f = await fixture(t, 'fail');
  const first = await (await f.begin()).wait();
  assert.equal(first.outcome.fence_presence, 'Present');
  assert.equal((await f.snapshot()).phase, 'recovery_required');
  const repeated = await (await f.begin()).wait();
  assert.equal(repeated.delivery, 'unknown');
  assert.equal((await f.snapshot()).attempts.length, 1);
  assert.equal(f.requests.length, 1);
});

test('reviewed queue continuation preserves the original Task across sidecar processes', integration, async t => {
  const f = await fixture(t);
  const first = await (await f.begin()).wait();
  const previous = await readFile(path.join(f.start.task.evidence_dir, 'released.json'));
  const continued = { ...f.start, task: { ...f.start.task, evidence_dir: path.join(f.root, 'continued') },
    run: { ...f.start.run, run_id: 'run-2' }, orchestration: { ...f.start.orchestration, attempt_id: 'attempt-2', worker_id: 'worker-2', lease_expires_at_ms: Date.now() + 5000 },
    continue_reviewed: { previous_evidence_dir: f.start.task.evidence_dir, expected_released_sha256: hash(previous),
      review: { ...first.outcome.last_receipt, verdict: { NeedsChanges: { feedback: 'Check the source once more.' } }, evidence: ['host-review'] } } };
  const second = await (await f.begin(continued)).wait();
  assert.equal(second.delivery, 'validated', JSON.stringify(second));
  assert.equal(second.outcome.runs, 2);
  const assignment = await f.snapshot();
  assert.equal(assignment.phase, 'settled');
  assert.equal(assignment.attempts.length, 2);
  assert.equal(assignment.attempts[1].outcome.runs, 2);
  assert.equal(f.requests.length, 2);
});

test('unadmitted dispatch retries only its original intent after an explicit Host receipt', integration, async t => {
  const f = await fixture(t);
  await mkdir(f.start.task.evidence_dir);
  const failed = await (await f.begin()).wait();
  assert.equal(failed.delivery, 'unknown');
  assert.equal((await f.snapshot()).attempts[0].admission_failed, true);
  assert.equal(f.requests.length, 0);
  await rmdir(f.start.task.evidence_dir);
  const reference = await f.recovery('never_admitted');
  const retry = { ...f.start, orchestration: { ...f.start.orchestration, worker_id: 'worker-2',
    lease_expires_at_ms: Date.now() + 5000, retry_unadmitted_ref: reference } };
  const result = await (await f.begin(retry)).wait();
  assert.equal(result.delivery, 'validated', JSON.stringify(result));
  assert.equal((await f.snapshot()).attempts.length, 1);
  assert.equal(f.requests.length, 1);
});

test('a crashed queue worker resumes with settled tool receipts and never replays its original effect', integration, async t => {
  const f = await fixture(t, 'tool');
  let effectEntered, effects = 0;
  const entered = new Promise(resolve => { effectEntered = resolve; });
  const effectFile = path.join(f.root, 'business-effect.txt');
  const tool = async (_frame, { signal }) => {
    effects++;
    await writeFile(effectFile, 'original committed effect', { flag: 'wx' });
    effectEntered();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { value: 'interrupted', is_error: true, settlement: 'Unknown', operation_receipt: effectFile };
  };
  const first = await f.begin(f.start, { tool });
  await entered;
  first.forceKill();
  assert.equal((await first.wait()).delivery, 'unknown');
  const expired = await f.manage({ operation: 'queue_watchdog', directory: f.start.orchestration.directory, at_ms: f.start.orchestration.lease_expires_at_ms + 1 });
  assert.deepEqual(expired, ['assignment-1']);
  const original = await f.snapshot();
  assert.equal(original.phase, 'recovery_required');
  const fence = (await readdir(f.root)).find(name => name.endsWith('.fence.json'));
  assert.ok(fence);
  const reference = await f.recovery('continue_after_reconciliation');
  const resumed = { ...f.start, task: { ...f.start.task, evidence_dir: path.join(f.root, 'resumed') },
    run: { ...f.start.run, run_id: 'run-2' }, resume: { version: 1, fence_sha256: hash(await readFile(path.join(f.root, fence))) },
    orchestration: { ...f.start.orchestration, worker_id: 'worker-2', attempt_id: 'attempt-2',
      lease_expires_at_ms: Date.now() + 5000, recovery_authorization_ref: reference } };
  let settlements = 0;
  const second = await f.begin(resumed, { tool, reconcileResume: async review => {
    settlements++;
    assert.equal(await readFile(effectFile, 'utf8'), 'original committed effect');
    return { committed: true, settlement: 'Settled', tool_calls: review.interrupted_run.open_tool_calls.map(call => ({ call_id: call.id,
      settlement: { kind: 'completed', output: 'Original effect confirmed by Host receipt.' } })), evidence: [effectFile] };
  } });
  const result = await second.wait();
  assert.equal(result.delivery, 'validated', JSON.stringify(result));
  assert.equal(result.outcome.stop, 'AwaitingHostAcceptance');
  assert.equal(effects, 1);
  assert.equal(settlements, 1);
  const recovered = await f.snapshot();
  assert.equal(recovered.phase, 'settled');
  assert.equal(recovered.attempts.length, 2);
  assert.ok(recovered.lease.generation > original.lease.generation);
});
