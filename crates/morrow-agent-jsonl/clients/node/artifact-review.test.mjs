// Host callbacks exercised through a controlled JSONL child process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { startTask } from './client.mjs';

const fixture = String.raw`
import { createInterface } from 'node:readline';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
const input = createInterface({ input: process.stdin });
let start;
async function finish(cancelled) {
  const outcome = { task_id: start.task.task_id, task_accepted: false, runs: 1, observed_calls: 1,
    stop: cancelled ? 'ReconciliationRequired' : 'AwaitingHostAcceptance',
    fence_presence: cancelled ? 'Present' : 'Released', reconciliation_fence: cancelled ? 'retained' : null };
  const file = path.join(start.task.evidence_dir, 'outcome.json');
  const bytes = Buffer.from(JSON.stringify(outcome));
  await fs.writeFile(file, bytes);
  emit({ kind: 'task_result', version: 1, ...outcome,
    outcome_ref: { path: file, sha256: hash(bytes) }, local_callbacks_finished: true });
  input.close(); process.stdin.destroy();
}
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.kind === 'start_task') {
    start = frame; await fs.mkdir(start.task.evidence_dir);
    if (config.noRequest) { await finish(false); break; }
    const request = config.request;
    await fs.writeFile(path.join(start.task.evidence_dir, 'jsonl-artifact-review-1.json'), JSON.stringify(request.review));
    if (config.reference) {
      const file = path.join(start.task.evidence_dir, config.filename ?? 'jsonl-artifact-review-1.json');
      const bytes = Buffer.from(JSON.stringify(request.review));
      await fs.writeFile(file, bytes);
      request.review_ref = { path: file, sha256: config.badHash ? '0'.repeat(64) : hash(bytes) };
      delete request.review;
    }
    emit(request);
  } else if (frame.kind === 'review_artifacts_reply') {
    await fs.writeFile(path.join(start.task.evidence_dir, 'reply.json'), line);
    await finish(false); break;
  } else if (frame.kind === 'cancel') {
    await fs.writeFile(path.join(start.task.evidence_dir, 'cancel.json'), line);
    await finish(true); break;
  }
}
`;

const baseCallbacks = {
  tool: async () => { throw new Error('unexpected tool'); },
  verify: async () => { throw new Error('unexpected review'); },
  prepare: async () => { throw new Error('unexpected continuation'); },
};
const exists = (file) => fs.access(file).then(() => true, () => false);

async function setup(t, change = () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'morrow-node-artifacts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const start = { kind: 'start_task', version: 1, artifact_review: true,
    task: { task_id: 'task-1', criteria_revision: 'criteria-1', authorization_revision: 'auth-1',
      deadline_unix_ms: Date.now() + 10000, evidence_dir: path.join(root, 'evidence') },
    run: { run_id: 'run-1', session_key: 'session-1', session_path: path.join(root, 'session.json'), tools: [] }, cancel_grace_ms: 1000 };
  const basis = { task_id: 'task-1', session_id: 'session-1', run_id: 'run-1', run_number: 1,
    session_path: start.run.session_path, criteria_revision: 'criteria-1', authorization_revision: 'auth-1' };
  const artifact = { version: 1, artifact_id: 'artifact-1', task_id: 'task-1', session_id: 'session-1',
    run_id: 'run-1', native_call_id: 'call-1', tool: 'write', input_sha256: 'a'.repeat(64),
    output_sha256: 'b'.repeat(64), artifact_ref: 'answer.txt', status: 'candidate', created_at: '2026-11-11' };
  const config = { request: { kind: 'review_artifacts_request', version: 1, rpc_id: 'rpc-1',
    task_id: 'task-1', run_id: 'run-1', review: { basis, artifacts: [artifact] } } };
  await fs.writeFile(start.run.session_path, '{}');
  change({ config, start, artifact, basis });
  const script = path.join(root, 'fixture.mjs');
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(script, fixture);
  await fs.writeFile(configPath, JSON.stringify(config));
  return { root, start, artifact, config, binary: process.execPath, binaryArgs: [script, configPath],
    modelToken: 'artifact-test-secret', operationDirectory: path.join(root, 'operations') };
}

function verified(artifact) {
  const receipt = Object.fromEntries(['artifact_id','task_id','session_id','run_id','native_call_id','input_sha256','output_sha256']
    .map((key) => [key, artifact[key]]));
  return { ...artifact, status: 'verified', host_receipt: { ...receipt, receipt_id: 'receipt-1',
    verifier: 'test-host', verifier_version: '1', verified_at: '2026-11-11', committed: true, settled: true } };
}

async function execute(t, options, callback) {
  const handle = await startTask({ ...options, callbacks: { ...baseCallbacks, reviewArtifacts: callback } });
  t.after(() => handle.forceKill());
  return handle.wait();
}

test('inline and referenced artifact reviews return exact records and correlation', async (t) => {
  for (const reference of [false, true]) {
    const options = await setup(t, ({ config }) => { config.reference = reference; });
    let calls = 0;
    const result = await execute(t, options, async (review, { signal, frame }) => {
      calls += 1;
      assert.equal(signal.aborted, false);
      assert.equal(frame.rpc_id, 'rpc-1');
      assert.deepEqual(review, options.config.request.review);
      return review.artifacts.map(verified);
    });
    assert.equal(result.delivery, 'validated', result.fault);
    assert.equal(calls, 1);
    const reply = JSON.parse(await fs.readFile(path.join(options.start.task.evidence_dir, 'reply.json'), 'utf8'));
    assert.deepEqual(reply, { kind: 'review_artifacts_reply', version: 1, rpc_id: 'rpc-1',
      task_id: 'task-1', run_id: 'run-1', artifacts: [verified(options.artifact)] });
    assert.equal(await exists(path.join(options.start.task.evidence_dir, 'tool-artifacts.jsonl')), false);
  }
});

test('old omitted and false configurations need no artifact callback', async (t) => {
  for (const enabled of [undefined, false]) {
    const options = await setup(t, ({ config, start }) => {
      config.noRequest = true;
      if (enabled === undefined) delete start.artifact_review;
      else start.artifact_review = enabled;
    });
    const result = await (await startTask({ ...options, callbacks: baseCallbacks })).wait();
    assert.equal(result.delivery, 'validated');
  }
});

test('Session parent aliases accept the original file and reject a different target', async (t) => {
  for (const differentTarget of [false, true]) {
    const options = await setup(t);
    const target = path.join(options.root, 'session-directory');
    const alias = path.join(options.root, 'session-alias');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'session.json'), '{}');
    await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    options.start.run.session_path = path.join(alias, 'session.json');
    const original = differentTarget ? path.join(options.root, 'session.json') : path.join(target, 'session.json');
    options.config.request.review.basis.session_path = await fs.realpath(original);
    await fs.writeFile(options.binaryArgs[1], JSON.stringify(options.config));
    let calls = 0;
    const result = await execute(t, options, async (review) => {
      calls += 1;
      return review.artifacts.map(verified);
    });
    assert.equal(result.delivery, differentTarget ? 'unknown' : 'validated', result.fault);
    assert.equal(calls, differentTarget ? 0 : 1);
    assert.equal(await exists(path.join(options.start.task.evidence_dir, 'reply.json')), !differentTarget);
  }
});

test('opt-in requires a callback and an actual boolean before spawning', async (t) => {
  for (const enabled of [true, 'true', null, 1]) {
    const options = await setup(t, ({ start }) => { start.artifact_review = enabled; });
    await assert.rejects(startTask({ ...options, callbacks: baseCallbacks }));
    assert.equal(await exists(options.operationDirectory), false);
    assert.equal(await exists(options.start.task.evidence_dir), false);
  }
});

test('unsolicited, wrong correlation and malformed source requests never invoke the Host', async (t) => {
  const changes = [
    ({ start }) => { delete start.artifact_review; },
    ({ start }) => { start.artifact_review = false; },
    ({ config }) => { config.request.run_id = 'other'; },
    ({ config }) => { config.request.task_id = 'other'; },
    ({ config }) => { config.request.rpc_id = ''; },
    ({ basis }) => { basis.session_id = 'other'; },
    ({ basis }) => { basis.session_path = 'other'; },
    ({ basis }) => { basis.run_id = 'other'; },
    ({ basis }) => { basis.criteria_revision = 'other'; },
    ({ basis }) => { basis.authorization_revision = 'other'; },
    ({ config }) => { config.request.review.extra = true; },
    ({ config }) => { config.request.review.artifacts = {}; },
    ({ artifact }) => { artifact.task_id = 'other'; },
    ({ artifact }) => { artifact.output_sha256 = 'bad'; },
    ({ artifact }) => { artifact.status = 'verified'; },
    ({ config }) => { config.reference = true; config.badHash = true; },
    ({ config }) => { config.reference = true; config.filename = 'another-review.json'; },
    ({ config }) => { config.reference = true; config.filename = '../outside.json'; },
  ];
  for (const change of changes) {
    const options = await setup(t, change);
    let calls = 0;
    const result = await execute(t, options, async () => { calls += 1; return []; });
    assert.equal(result.delivery, 'unknown');
    assert.equal(calls, 0);
    assert.equal(await exists(path.join(options.start.task.evidence_dir, 'reply.json')), false);
  }
});

test('invalid reply records and callback errors retain unknown receipts without replies', async (t) => {
  const invalid = [
    () => ({}),
    (artifact) => [{ ...verified(artifact), status: 'success' }],
    (artifact) => [{ ...verified(artifact), output_sha256: 'bad' }],
    (artifact) => [{ ...verified(artifact), run_id: 'other' }],
    (artifact) => [{ ...verified(artifact), artifact_ref: '../escape' }],
    (artifact) => [{ ...verified(artifact), host_receipt: null }],
    (artifact) => [{ ...verified(artifact), host_receipt: { ...verified(artifact).host_receipt, settled: false } }],
    (artifact) => [{ ...verified(artifact), host_receipt: { ...verified(artifact).host_receipt, input_sha256: 'c'.repeat(64) } }],
    (artifact) => [verified(artifact), verified(artifact)],
    () => { throw new Error('artifact-test-secret must not leak'); },
  ];
  for (const value of invalid) {
    const options = await setup(t);
    const result = await execute(t, options, async () => value(options.artifact));
    assert.equal(result.delivery, 'unknown');
    assert.equal(result.fault, 'host_callback_unknown');
    assert.equal(await exists(path.join(options.start.task.evidence_dir, 'reply.json')), false);
    const files = await fs.readdir(options.operationDirectory);
    assert.ok(files.some((name) => name.endsWith('-unknown.json')));
    for (const file of files) assert.ok(!(await fs.readFile(path.join(options.operationDirectory, file), 'utf8')).includes(options.modelToken));
  }
});

for (const trigger of ['cancel', 'deadline']) {
  test(`${trigger} joins an artifact callback and never publishes its late successful result`, async (t) => {
    const options = await setup(t, ({ start }) => {
      if (trigger === 'deadline') start.task.deadline_unix_ms = Date.now() + 1000;
    });
    let ready;
    let joined = false;
    const entered = new Promise((resolve) => { ready = resolve; });
    const handle = await startTask({ ...options, callbacks: { ...baseCallbacks,
      reviewArtifacts: async (review, { signal }) => {
        ready();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        await new Promise((resolve) => setTimeout(resolve, 25));
        joined = true;
        return review.artifacts.map(verified);
      } } });
    t.after(() => handle.forceKill());
    await entered;
    if (trigger === 'cancel') handle.cancel();
    const result = await handle.wait();
    assert.equal(joined, true);
    assert.equal(result.callbacks_finished, true);
    assert.equal(result.delivery, 'unknown');
    assert.equal(await exists(path.join(options.start.task.evidence_dir, 'reply.json')), false);
  });
}

test('artifact lists use the frame bound and references carry larger source payloads', async (t) => {
  for (const count of [65, 600]) {
    const options = await setup(t, ({ config, artifact }) => {
      config.reference = count === 600;
      config.request.review.artifacts = Array.from({ length: count }, (_, index) => ({
        ...artifact, artifact_id: `artifact-${index}`,
      }));
    });
    const result = await execute(t, options, async (review) => {
      assert.equal(review.artifacts.length, count);
      return count === 65 ? review.artifacts.map(verified) : [];
    });
    assert.equal(result.delivery, 'validated', result.fault);
  }
});

test('a response beyond the existing frame bound cannot become an empty success', async (t) => {
  const options = await setup(t);
  const result = await execute(t, options, async () => Array.from({ length: 512 }, (_, index) => {
    const artifact = verified({ ...options.artifact, artifact_id: `artifact-${index}` });
    return artifact;
  }));
  assert.equal(result.delivery, 'unknown');
  assert.equal(result.fault, 'host_callback_unknown');
  assert.equal(await exists(path.join(options.start.task.evidence_dir, 'reply.json')), false);
});

test('source changes during the artifact callback are refused', async (t) => {
  const options = await setup(t);
  const result = await execute(t, options, async (review) => {
    await fs.writeFile(path.join(options.start.task.evidence_dir, 'jsonl-artifact-review-1.json'), '{}');
    return review.artifacts.map(verified);
  });
  assert.equal(result.delivery, 'unknown');
  assert.equal(result.fault, 'host_callback_unknown');
  assert.equal(await exists(path.join(options.start.task.evidence_dir, 'reply.json')), false);
});

// Set MORROW_JSONL_TEST_BINARY to the freshly built sidecar to exercise Rust,
// loopback HTTP, Host-owned files and the real provenance ledger together.
const binary = process.env.MORROW_JSONL_TEST_BINARY;
const evidenceRoot = process.env.MORROW_JSONL_ARTIFACT_EVIDENCE;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function save(file, value) {
  const handle = await fs.open(file, 'wx');
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}

for (const mode of ['ordinary', 'needs-changes', 'budget', 'length', 'omitted', 'false', 'legacy-large', 'wrong-run', 'exception', 'tamper', 'cancel']) {
  test(`actual sidecar artifact review ${mode}`, { skip: !binary, timeout: 45000 }, async (t) => {
    let root;
    if (evidenceRoot) {
      await fs.mkdir(evidenceRoot, { recursive: true });
      root = await fs.mkdtemp(path.join(evidenceRoot, `${mode}-`));
    } else {
      root = await fs.mkdtemp(path.join(os.tmpdir(), `morrow-node-native-${mode}-`));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
    }
    const requests = [];
    let catalogRequests = 0;
    const server = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        catalogRequests += 1;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'jsonl-fixture', protocols: ['openai-completions'],
          context_window: 1000000, max_tokens: 4096, omp: { supportsTools: true, input: ['text'], reasoning: false } }] }));
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const number = requests.length;
      const tool = number % 2 === 1;
      const content = ['needs-changes', 'legacy-large'].includes(mode) && number === 1 ? 'wrong' : 'correct';
      const delta = tool ? { tool_calls: [{ index: 0, id: `write-${number}`, type: 'function',
        function: { name: 'write_answer', arguments: JSON.stringify({ content }) } }] }
        : { content: mode === 'legacy-large' ? '\\'.repeat(140000) : 'Submitted.' };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [part, finish] of [[{ role: 'assistant' }, null], [delta, null],
        [{}, tool ? 'tool_calls' : mode === 'length' ? 'length' : 'stop']]) {
        response.write(`data: ${JSON.stringify({ id: 'controlled-only', object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
    const start = { kind: 'start_task', version: 1, artifact_review: true,
      task: { task_id: 'node-artifact-task', criteria_revision: 'file-v1', authorization_revision: 'owned-v1',
        kind: 'Coding', evidence_dir: path.join(root, 'harness'), max_runs: 2, max_calls: 4,
        deadline_unix_ms: Date.now() + 30000 },
      run: { run_id: 'run-1', objective: 'Write the answer file, then submit.', cwd: root,
        session_path: path.join(root, 'session.json'), environment_state: path.join(root, 'environment'),
        device_fp: 'node-artifact-fixture', session_key: 'artifact/session', mode: 'execute', endpoint,
        model: 'jsonl-fixture', max_calls: 4, max_seconds: 25, max_output: 512,
        model_resolution: { kind: 'catalog' }, tools: [{ name: 'write_answer', description: 'Write the answer file.',
          parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } }] },
      cancel_grace_ms: 1000, emit_events: false };
    if (mode === 'omitted') delete start.artifact_review;
    if (['false', 'legacy-large'].includes(mode)) start.artifact_review = false;
    if (mode === 'budget') {
      start.budget_stop_review = 'review_closed_tool_round';
      start.run.max_calls = 1; start.task.max_calls = 1;
    }
    if (mode === 'length') start.length_stop_review = 'review_closed_length';
    await save(path.join(root, 'identity.json'), { binary, binary_sha256: hash(await fs.readFile(binary)) });
    await save(path.join(root, 'start.json'), start);
    const counts = { writes: 0, reviews: 0, artifactReviews: 0, prepares: 0, callbackJoined: false };
    let signalEntered;
    const entered = new Promise((resolve) => { signalEntered = resolve; });
    const callbacks = {
      async tool(frame) {
        counts.writes += 1;
        await fs.writeFile(path.join(root, 'answer.txt'), frame.arguments.content);
        const receipt = path.join(root, `write-${counts.writes}.json`);
        await save(receipt, { frame, answer_sha256: hash(await fs.readFile(path.join(root, 'answer.txt'))) });
        return { value: { written: true }, is_error: false, settlement: 'Settled', operation_receipt: receipt };
      },
      async verify(subject) {
        counts.reviews += 1;
        assert.equal(Object.hasOwn(subject.basis, 'session_id'), !!start.artifact_review);
        const sourceKind = mode === 'budget' ? 'budget-snapshot' : mode === 'length' ? 'stop-snapshot' : 'candidate';
        const original = JSON.parse(await fs.readFile(path.join(start.task.evidence_dir,
          `run-${subject.basis.run_number}-${sourceKind}.json`), 'utf8'));
        assert.equal(original.basis.session_id, start.run.session_key);
        const correct = await fs.readFile(path.join(root, 'answer.txt'), 'utf8') === 'correct';
        const receipt = path.join(root, `review-${counts.reviews}.json`);
        await save(receipt, { basis: subject.basis, correct });
        return { basis: subject.basis, committed: true, settlement: 'Settled',
          verdict: correct ? 'Verified' : { NeedsChanges: { feedback: 'Write correct to the answer file.' } }, evidence: [receipt] };
      },
      async prepare(continuation) {
        counts.prepares += 1;
        assert.deepEqual(continuation.previous.basis, continuation.receipt.basis);
        assert.equal(Object.hasOwn(continuation.previous.basis, 'session_id'), !!start.artifact_review);
        return { run_id_next: `run-${continuation.next_run_number}`, objective: 'Repair the answer file.' };
      },
    };
    if (mode === 'budget') {
      callbacks.verify_budget_snapshot = callbacks.verify;
      callbacks.prepare_budget_stop_continuation = callbacks.prepare;
    }
    if (mode === 'length') {
      callbacks.verifyStopSnapshot = callbacks.verify;
      callbacks.prepareStopContinuation = callbacks.prepare;
    }
    if (start.artifact_review) callbacks.reviewArtifacts = async (review, { signal }) => {
      counts.artifactReviews += 1;
      const correct = await fs.readFile(path.join(root, 'answer.txt'), 'utf8') === 'correct';
      assert.equal(correct, mode !== 'needs-changes' || review.basis.run_number > 1);
      const records = review.artifacts.map((artifact) => {
        const record = verified(artifact);
        record.host_receipt.receipt_id = `receipt-${review.basis.run_number}-${artifact.artifact_id}`;
        record.host_receipt.verifier = 'node-file-host';
        return record;
      });
      await save(path.join(root, `host-artifacts-${review.basis.run_number}.json`), { basis: review.basis, records });
      if (mode === 'wrong-run') records[0].run_id = 'other-run';
      if (mode === 'exception') throw new Error('private Host diagnostic');
      if (mode === 'tamper') await fs.writeFile(path.join(start.task.evidence_dir,
        `jsonl-artifact-review-${review.basis.run_number}.json`), '{}');
      if (mode === 'cancel') {
        signalEntered();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        await new Promise((resolve) => setTimeout(resolve, 25));
        counts.callbackJoined = true;
      }
      return records;
    };
    const handle = await startTask({ binary, start, callbacks, modelToken: 'controlled-artifact-no-provider-grant',
      operationDirectory: path.join(root, 'operations') });
    t.after(() => handle.forceKill());
    if (mode === 'cancel') { await entered; handle.cancel(); }
    const result = await handle.wait();
    await save(path.join(root, 'result.json'), result);
    await save(path.join(root, 'counts.json'), { ...counts, modelCalls: requests.length, catalogRequests });
    await save(path.join(root, 'provider-requests.json'), requests);
    assert.equal(await fs.readFile(path.join(root, 'answer.txt'), 'utf8'), 'correct');
    assert.equal(counts.writes, ['needs-changes', 'legacy-large'].includes(mode) ? 2 : 1);
    assert.equal(requests.length, mode === 'budget' ? 1 : ['needs-changes', 'legacy-large'].includes(mode) ? 4 : 2);
    assert.equal(result.callbacks_finished, true);
    const rejected = ['wrong-run','exception','tamper','cancel'].includes(mode);
    if (rejected) {
      assert.equal(result.delivery, 'unknown');
      assert.equal(result.outcome.fence_presence, 'Present');
      assert.deepEqual(result.outcome.artifacts ?? [], []);
      assert.equal(await exists(path.join(start.task.evidence_dir, 'run-1-artifacts.json')), false);
      if (mode === 'cancel') assert.equal(counts.callbackJoined, true);
    } else {
      assert.equal(result.delivery, 'validated', result.fault);
      assert.equal(result.outcome.stop, 'AwaitingHostAcceptance');
      assert.equal(result.outcome.task_accepted, false);
      if (start.artifact_review) {
        const runNumber = mode === 'needs-changes' ? 2 : 1;
        const manifest = JSON.parse(await fs.readFile(path.join(start.task.evidence_dir, `run-${runNumber}-artifacts.json`), 'utf8'));
        assert.deepEqual(result.outcome.artifacts, manifest.artifacts);
        assert.equal(result.outcome.artifacts[0].status, 'verified');
        assert.equal(result.outcome.artifacts[0].run_id, `run-${runNumber}`);
        const rows = (await fs.readFile(path.join(start.task.evidence_dir, 'tool-artifacts.jsonl'), 'utf8'))
          .trim().split('\n').map((line) => JSON.parse(line));
        assert.equal(rows.at(-1).host_receipt.verifier, 'node-file-host');
        assert.equal(counts.artifactReviews, runNumber);
      } else {
        assert.deepEqual(result.outcome.artifacts ?? [], []);
        assert.equal(counts.artifactReviews, 0);
        assert.equal(await exists(path.join(start.task.evidence_dir, 'jsonl-artifact-review-1.json')), false);
        if (mode === 'legacy-large') {
          const projected = JSON.parse(await fs.readFile(path.join(start.task.evidence_dir, 'jsonl-candidate-1.json'), 'utf8'));
          assert.equal(Object.hasOwn(projected.basis, 'session_id'), false);
          const continuation = JSON.parse(await fs.readFile(path.join(start.task.evidence_dir, 'jsonl-continuation-2.json'), 'utf8'));
          assert.deepEqual(continuation.previous, projected);
        }
      }
    }
  });
}
