import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startTask } from './client.mjs';
import { sendManagement } from './management.mjs';

test('reviewed Goal continues in another process with original identity, lease and cumulative budget', {
  skip: !process.env.MORROW_TEST_BINARY, timeout: 30000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'morrow-goal-continuation-'));
  t.diagnostic(`evidence ${root}`);
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.setHeader('Content-Type', 'text/event-stream');
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'A result for Host review.' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const start = {
    kind: 'start_task', version: 1, emit_events: true, event_payloads: true,
    task: { task_id: 'goal-task', criteria_revision: 'c1', authorization_revision: 'a1', kind: 'Reasoning',
      evidence_dir: join(root, 'first'), max_runs: 2, max_calls: 4, deadline_unix_ms: Date.now() + 25000 },
    run: { run_id: 'first-run', objective: 'Research the specified source.', cwd: root,
      session_path: join(root, 'session.json'), environment_state: join(root, 'environment'), device_fp: 'host', session_key: 'session',
      mode: 'goal', endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'controlled',
      max_calls: 2, max_seconds: 10, max_output: 256, tools: [],
      model_resolution: { kind: 'host_declared_loopback', capabilities: { context_window: 32000, max_tokens: 4096, input: ['text'] } } },
    goal: { goal_id: 'research-goal', criteria: ['Cite the actual source'],
      lease: { goal_id: 'research-goal', controller: 'host', device: 'host', session: 'session', expires_at: Math.floor(Date.now() / 1000) + 25,
        max_calls: 4, max_slices: 2, allow_jobs: false } },
  };
  let processNumber = 0;
  async function run(frame) {
    const handle = await startTask({ binary: process.env.MORROW_TEST_BINARY, modelToken: 'controlled-only', start: frame,
      operationDirectory: join(root, `client-${++processNumber}`), callbacks: {
        tool() { throw Error('no external tools'); },
        verify(candidate) { return { basis: candidate.basis, committed: true, settlement: 'Settled', verdict: 'Verified', evidence: ['controlled-structural-review'] }; },
        prepare() { throw Error('no automatic next slice'); },
      } });
    t.after(() => { if (!handle.status().closed) handle.forceKill(); });
    return handle.wait();
  }
  const first = await run(start);
  assert.equal(first.delivery, 'validated', JSON.stringify(first));
  assert.equal(first.outcome.stop, 'AwaitingHostAcceptance');
  assert.equal(first.outcome.task_accepted, false);
  assert.equal(first.outcome.last_candidate.goal.id, 'research-goal');
  assert.equal(first.outcome.last_candidate.goal.run, 'first-run');
  const sourceBudget = structuredClone(first.outcome.last_candidate.goal.budget);
  let goal = first.outcome.last_candidate.goal;
  for (const command of ['pause', 'resume']) {
    goal = await sendManagement({ binary: process.env.MORROW_TEST_BINARY, request: {
      operation: 'goal_control', session: start.run.session_path, cwd: root, goal_id: goal.id,
      command, command_id: `host-${command}`, expected_revision: goal.revision, reviewed_run: ''
    } });
  }
  assert.equal(goal.status, 'running');
  assert.deepEqual(goal.budget, sourceBudget, 'Host controls cannot replenish the original lease');
  const released = await readFile(join(root, 'first', 'released.json'));
  const review = { ...first.outcome.last_receipt, verdict: { NeedsChanges: { feedback: 'Check the source citation again.' } }, evidence: ['host-correction-receipt'] };
  const continuation = { previous_evidence_dir: start.task.evidence_dir,
    expected_released_sha256: createHash('sha256').update(released).digest('hex'), review };
  const next = { ...start, task: { ...start.task, evidence_dir: join(root, 'second') },
    run: { ...start.run, run_id: 'second-run' }, continue_reviewed: continuation };
  const snapshotPath = join(root, 'first', 'run-1-journal-head.json');
  const snapshot = await readFile(snapshotPath);
  const changedSnapshot = JSON.parse(snapshot.toString());
  changedSnapshot.metadata.goal.criteria = ['altered source'];
  await writeFile(snapshotPath, JSON.stringify(changedSnapshot));
  const tamperedSnapshot = await run({ ...next, task: { ...next.task, evidence_dir: join(root, 'tampered-snapshot') } });
  assert.notEqual(tamperedSnapshot.delivery, 'validated');
  await writeFile(snapshotPath, snapshot);
  const journalHeadPath = join(root, 'session.journal', 'head.json');
  const journalHead = await readFile(journalHeadPath);
  const changedHead = JSON.parse(journalHead.toString());
  changedHead.head.metadata.goal.budget.calls_reserved += 1;
  changedHead.checksum = createHash('sha256').update(JSON.stringify(changedHead.head)).digest('hex');
  await writeFile(journalHeadPath, JSON.stringify(changedHead));
  const snapshotWithChangedBudget = await sendManagement({ binary: process.env.MORROW_TEST_BINARY,
    request: { operation: 'goal_snapshot', session: start.run.session_path, cwd: root } });
  assert.equal(snapshotWithChangedBudget.budget.calls_reserved, sourceBudget.calls_reserved + 1);
  const changedMetadata = await run({ ...next, task: { ...next.task, evidence_dir: join(root, 'changed-metadata') } });
  assert.notEqual(changedMetadata.delivery, 'validated', 'unrelated metadata changes cannot hide behind valid Goal controls');
  await writeFile(journalHeadPath, journalHead);
  const eventPath = join(root, 'first', 'run-1-events.jsonl');
  const eventBytes = await readFile(eventPath);
  await writeFile(eventPath, Buffer.concat([eventBytes, Buffer.from(' ')]));
  const changedEvents = await run({ ...next, task: { ...next.task, evidence_dir: join(root, 'changed-events') } });
  assert.notEqual(changedEvents.delivery, 'validated');
  await writeFile(eventPath, eventBytes);
  assert.equal(requests.length, 1, 'tampered evidence is refused before model dispatch');
  const changed = await run({ ...next, task: { ...next.task, max_calls: 5, evidence_dir: join(root, 'changed-budget') } });
  assert.notEqual(changed.delivery, 'validated');
  assert.equal(requests.length, 1, 'changed authority is rejected before model dispatch');
  const second = await run(next);
  assert.equal(second.delivery, 'validated', JSON.stringify(second));
  assert.equal(second.outcome.task_id, first.outcome.task_id);
  assert.equal(second.outcome.runs, 2);
  assert.equal(second.outcome.observed_calls, 2);
  assert.equal(second.outcome.last_candidate.goal.budget.slices_started, 2);
  assert.equal(second.outcome.last_candidate.goal.budget.calls_reserved, 2);
  assert.deepEqual(second.outcome.last_candidate.goal.budget.lease, start.goal.lease);
  assert.ok(JSON.stringify(requests[1]).includes('Check the source citation again.'));
  const duplicate = await run({ ...next, task: { ...next.task, evidence_dir: join(root, 'duplicate') }, run: { ...next.run, run_id: 'duplicate-run' } });
  assert.notEqual(duplicate.delivery, 'validated');
  assert.equal(requests.length, 2, 'one reviewed result authorizes only one successor');
  await writeFile(join(root, 'results.json'), JSON.stringify({ first, tamperedSnapshot, changedMetadata, changedEvents, changed, second, duplicate }, null, 2));
});
