import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTask } from './client.mjs';
import { inspectSession, closeTask, readCloseOperation } from './management.mjs';

const binary = process.env.MORROW_JSONL_TEST_BINARY || process.env.MORROW_AGENT_JSONL_BIN;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('inspectSession, held seal/release, and idempotent closeTask/readCloseOperation work end-to-end', { skip: !binary, timeout: 45000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'morrow-inspect-close-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionPath = path.join(root, 'session.json');
  const cwd = path.join(root, 'workspace');
  await fs.mkdir(cwd, { recursive: true });

  const makeReq = (fromRaw = 0, prefix = null, runs = []) => ({
    session_path: sessionPath,
    cwd,
    from_raw: fromRaw,
    expected_prefix_proof: prefix,
    expected_runs: runs,
    require_context: runs.length > 0,
    limits: { max_messages: 10000, max_input_bytes: 64 * 1024 * 1024, max_output_bytes: 16 * 1024 * 1024 },
  });

  // 1. Baseline inspection on absent Session
  const base = await inspectSession({
    binary,
    request: makeReq(),
    operationDirectory: path.join(root, 'baseline'),
  });
  assert.equal(base.delivery, 'validated');
  assert.equal(base.result.snapshot.fence, null);
  assert.equal(base.result.snapshot.inspection.absent, true);
  assert.equal(base.result.snapshot.inspection.to_raw, 0);

  // 2. Start a task and cancel it cleanly so it leaves a fenced Cancelled outcome
  let allowFinish;
  const provider = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null }] })}\n\n`);
    await new Promise((resolve) => { allowFinish = resolve; req.once('close', resolve); });
    res.end();
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => provider.close(resolve)));

  const evidenceDir = path.join(root, 'evidence');
  const start = {
    kind: 'start_task',
    version: 1,
    task: {
      task_id: 'task-cancel-1',
      criteria_revision: 'c1',
      authorization_revision: 'a1',
      kind: 'Reasoning',
      evidence_dir: evidenceDir,
      max_runs: 1,
      max_calls: 4,
      deadline_unix_ms: Date.now() + 25000,
    },
    run: {
      run_id: 'run-1',
      objective: 'Wait for cancel.',
      cwd,
      session_path: sessionPath,
      environment_state: path.join(root, 'env'),
      device_fp: 'fp1',
      session_key: 'sk1',
      mode: 'execute',
      endpoint: `http://127.0.0.1:${provider.address().port}/v1`,
      model: 'fixture',
      max_calls: 4,
      max_seconds: 20,
      max_output: 512,
      model_resolution: { kind: 'host_declared_loopback', capabilities: { context_window: 32768, max_tokens: 1024, input: ['text'] } },
      tools: [],
    },
    cancel_grace_ms: 1000,
    emit_events: true,
  };

  const handle = await startTask({
    binary,
    start,
    modelToken: 'controlled-token',
    operationDirectory: path.join(root, 'client'),
    callbacks: {
      tool: async () => { throw new Error('no tools'); },
      verify: async () => { throw new Error('cancelled before verify'); },
      prepare: async () => { throw new Error('no prepare'); },
    },
  });
  while (!allowFinish) await new Promise((r) => setTimeout(r, 20));
  handle.cancel();
  const taskRes = await handle.wait();
  assert.equal(taskRes.delivery, 'validated');
  assert.equal(taskRes.outcome.stop, 'Cancelled');
  assert.equal(taskRes.outcome.fence_presence, 'Present');

  // 3. Post-cancel inspection verifies prefix proof from baseline and observes fence
  const observed = await inspectSession({
    binary,
    request: makeReq(base.result.snapshot.inspection.to_raw, base.result.snapshot.inspection.full_proof, ['run-1']),
    operationDirectory: path.join(root, 'inspection'),
  });
  const snap = observed.result.snapshot;
  assert.ok(snap.fence);
  assert.equal(snap.fence.record.task_id, 'task-cancel-1');
  assert.equal(snap.inspection.transcript_closed, true);

  // 4. Held session_inspect + seal + release over interactive stdio
  const holdDir = path.join(root, 'held-inspect');
  const child = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = createInterface({ input: child.stdout });
  const nextLine = () => new Promise((resolve, reject) => {
    rl.once('line', (l) => resolve(JSON.parse(l)));
    child.once('exit', (code) => reject(new Error(`premature exit ${code}`)));
  });
  child.stdin.write(`${JSON.stringify({
    kind: 'manage',
    version: 1,
    id: 'hold-req-1',
    request: {
      operation: 'session_inspect',
      request: makeReq(0, null, ['run-1']),
      output_directory: holdDir,
      hold: { version: 1, lease_id: 'lease-abc', timeout_ms: 15000 },
    },
  })}\n`);
  const heldInit = await nextLine();
  assert.equal(heldInit.ok, true);
  assert.equal(heldInit.value.lease.lease_id, 'lease-abc');
  const snapSha = heldInit.value.result_ref.sha256;

  // Concurrent lock attempt must fail while held inspector owns the OS Session lock
  await assert.rejects(() => inspectSession({
    binary,
    request: makeReq(),
    operationDirectory: path.join(root, 'contended'),
  }));

  const commitSha = 'c'.repeat(64);
  child.stdin.write(`${JSON.stringify({
    kind: 'manage',
    version: 1,
    id: 'seal-1',
    request: { operation: 'session_inspect_seal', lease_id: 'lease-abc', snapshot_sha256: snapSha, commitment_sha256: commitSha },
  })}\n`);
  const sealed1 = await nextLine();
  assert.equal(sealed1.ok, true);

  // Different commitment_sha256 on same seal must be refused
  child.stdin.write(`${JSON.stringify({
    kind: 'manage',
    version: 1,
    id: 'seal-bad',
    request: { operation: 'session_inspect_seal', lease_id: 'lease-abc', snapshot_sha256: snapSha, commitment_sha256: 'd'.repeat(64) },
  })}\n`);
  const sealedBad = await nextLine();
  assert.equal(sealedBad.ok, false);

  child.stdin.write(`${JSON.stringify({
    kind: 'manage',
    version: 1,
    id: 'rel-1',
    request: { operation: 'session_inspect_release', lease_id: 'lease-abc', snapshot_sha256: snapSha },
  })}\n`);
  const rel = await nextLine();
  assert.equal(rel.ok, true);
  assert.equal(rel.value.kind, 'session_inspection_released');
  rl.close();
  child.stdin.end();
  await new Promise((resolve) => child.once('close', resolve));

  // 5. Settled task close + idempotent second attempt + readCloseOperation recovery
  const closureDir = path.join(root, 'closure');
  await fs.mkdir(closureDir, { recursive: true });
  const spec = JSON.parse(await fs.readFile(path.join(evidenceDir, 'task.json'), 'utf8'));
  const evidenceRefs = [observed.result_ref, base.result_ref];
  const declaration = {
    kind: 'settled_task_close',
    version: 1,
    request: {
      task: { ...spec, evidence_dir: snap.fence.record.evidence_dir },
      session_path: snap.fence.record.session_path,
      cwd: snap.inspection.canonical_cwd,
      expected_fence_sha256: snap.fence.sha256,
      expected_authority_sha256: snap.fence.record.authority.declaration_sha256,
      evidence_dir: closureDir,
    },
    expected: {
      fence: snap.fence.record,
      fenced_outcome: taskRes.outcome,
      interrupted_run: snap.inspection.pending_run,
      consumed_runs: taskRes.outcome.runs,
      consumed_calls: taskRes.outcome.observed_calls,
    },
    receipt: {
      committed: true,
      settlement: 'Settled',
      tool_calls: [],
      evidence: evidenceRefs.map((r) => r.path),
    },
    evidence_refs: evidenceRefs,
    session_inspection_ref: observed.result_ref,
  };
  const declBytes = Buffer.from(`${JSON.stringify(declaration)}\n`);
  const declPath = path.join(closureDir, 'host-declaration.json');
  await fs.writeFile(declPath, declBytes);
  const declRef = { path: declPath, sha256: sha256(declBytes) };

  const closed1 = await closeTask({ binary, declarationRef: declRef, operationDirectory: path.join(root, 'close-1') });
  assert.equal(closed1.delivery, 'validated');
  assert.equal(closed1.result.original_outcome.task_id, 'task-cancel-1');
  assert.equal(closed1.result.task_accepted, false);

  const closed2 = await closeTask({ binary, declarationRef: declRef, operationDirectory: path.join(root, 'close-2') });
  assert.equal(closed2.delivery, 'validated');

  const recovered = await readCloseOperation({ declarationRef: declRef, operationDirectory: path.join(root, 'close-2') });
  assert.equal(recovered.delivery, 'validated');
  assert.equal(recovered.result.original_outcome.stop, 'Cancelled');
});
