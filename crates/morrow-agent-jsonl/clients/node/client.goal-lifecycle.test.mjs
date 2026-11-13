import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTask } from './client.mjs';
import { sendManagement } from './management.mjs';

const binary = process.env.MORROW_TEST_BINARY;
const integration = { skip: !binary, timeout: 30000 };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'morrow-goal-lifecycle-'));
  t.diagnostic(`evidence ${root}`);
  let calls = 0;
  let sequence = 0;
  const leases = new Map();
  const server = createServer(async (request, response) => {
    for await (const chunk of request) { void chunk; }
    calls++;
    response.setHeader('Content-Type', 'text/event-stream');
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Source reviewed.' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const session = join(root, 'session.json');
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  async function run(goalId, objective = 'Review the actual source.') {
    const number = ++sequence;
    const evidence = join(root, `evidence-${number}`);
    if (!leases.has(goalId)) leases.set(goalId, { goal_id: goalId, controller: 'host', device: 'host',
      session: 'session', expires_at: Math.floor(Date.now() / 1000) + 30, max_calls: 4, max_slices: 2, allow_jobs: false });
    const start = { kind: 'start_task', version: 1,
      task: { task_id: `task-${number}`, criteria_revision: 'c1', authorization_revision: 'a1', kind: 'Reasoning',
        evidence_dir: evidence, max_runs: 2, max_calls: 4, deadline_unix_ms: Date.now() + 15000 },
      run: { run_id: `run-${number}`, objective, cwd: root, session_path: session, environment_state: join(root, 'environment'),
        device_fp: 'host', session_key: 'session', mode: 'goal', endpoint, model: 'controlled', max_calls: 2, max_seconds: 10,
        max_output: 256, tools: [], model_resolution: { kind: 'host_declared_loopback', capabilities: { context_window: 32000, max_tokens: 4096, input: ['text'] } } },
      goal: { goal_id: goalId, criteria: ['Cite the actual source'], lease: leases.get(goalId) } };
    const handle = await startTask({ binary, modelToken: 'controlled-only', start, operationDirectory: join(root, `client-${number}`),
      callbacks: {
        tool() { throw Error('unexpected external tool'); },
        verify(candidate) { return { basis: candidate.basis, committed: true, settlement: 'Settled', verdict: 'Verified', evidence: ['source-review'] }; },
        prepare() { throw Error('unexpected automatic continuation'); }
      } });
    t.after(() => { if (!handle.status().closed) handle.forceKill(); });
    return { result: await handle.wait(), evidence, runId: start.run.run_id };
  }
  const snapshot = () => sendManagement({ binary, request: { operation: 'goal_snapshot', session, cwd: root } });
  const control = (goal, command, commandId) => sendManagement({ binary, request: {
    operation: 'goal_control', session, cwd: root, goal_id: goal.id, command, command_id: commandId,
    expected_revision: goal.revision, reviewed_run: command === 'accept' ? goal.last_settled_run : ''
  } });
  return { root, session, run, snapshot, control, calls: () => calls };
}

test('Goal Start control commands are rejected before Session changes or task admission', integration, async (t) => {
  const f = await fixture(t);
  const first = await f.run('initial-goal');
  assert.equal(first.result.outcome?.stop, 'AwaitingHostAcceptance', JSON.stringify(first.result));
  const original = await readFile(f.session);
  for (const command of ['status', 'accept', 'pause', 'resume', 'stop']) {
    const attempt = await f.run('initial-goal', ` /goal ${command} initial-goal `);
    assert.equal(attempt.result.delivery, 'unknown');
    assert.match(attempt.result.stderr.preview, /goal_commands_require_management/);
    assert.equal(attempt.result.outcome, null);
    await assert.rejects(stat(attempt.evidence), { code: 'ENOENT' });
    assert.deepEqual(await readFile(f.session), original);
  }
  assert.equal(f.calls(), 1);
  assert.deepEqual((await readdir(f.root)).filter((name) => name.endsWith('.fence.json')), []);
});

for (const terminal of ['accepted', 'canceled']) {
  test(`new explicit Goal after ${terminal} preserves prior history and has its own lease`, integration, async (t) => {
    const f = await fixture(t);
    const first = await f.run('first-goal');
    assert.equal(first.result.outcome?.stop, 'AwaitingHostAcceptance', JSON.stringify(first.result));
    let goal = await f.snapshot();
    assert.equal(goal.id, 'first-goal');
    if (terminal === 'accepted') {
      const budgetBeforePause = structuredClone(goal.budget);
      goal = await f.control(goal, 'pause', 'pause-first');
      assert.equal(goal.status, 'paused');
      goal = await f.control(goal, 'resume', 'resume-first');
      assert.equal(goal.status, 'running');
      assert.deepEqual(goal.budget, budgetBeforePause);
      // Resume changes the status, so obtain a new reviewed slice before acceptance.
      const resumed = await f.run('first-goal');
      assert.equal(resumed.result.outcome?.stop, 'AwaitingHostAcceptance', JSON.stringify(resumed.result));
      goal = await f.snapshot();
      goal = await f.control(goal, 'accept', 'accept-first');
    } else {
      goal = await f.control(goal, 'stop', 'stop-first');
    }
    assert.equal(goal.status, terminal);
    const original = structuredClone(goal);
    assert.deepEqual((await readdir(f.root)).filter((name) => name.endsWith('.fence.json')), []);
    const callsBeforeNewGoal = f.calls();
    const second = await f.run('second-goal');
    assert.equal(second.result.delivery, 'validated', JSON.stringify(second.result));
    assert.equal(second.result.outcome?.stop, 'AwaitingHostAcceptance');
    const session = JSON.parse(await readFile(f.session, 'utf8'));
    assert.deepEqual(session.goal_history, [original]);
    assert.equal(session.goal.id, 'second-goal');
    assert.equal(session.goal.run, second.runId);
    assert.equal(session.goal.budget.lease.goal_id, 'second-goal');
    assert.equal(session.goal.budget.slices_started, 1);
    assert.equal(session.goal.budget.calls_reserved, 1);
    assert.equal(f.calls(), callsBeforeNewGoal + 1);
  });
}

test('a different explicit Goal cannot replace the current unaccepted leased Goal', integration, async (t) => {
  const f = await fixture(t);
  const first = await f.run('first-goal');
  assert.equal(first.result.outcome?.stop, 'AwaitingHostAcceptance');
  const original = JSON.parse(await readFile(f.session, 'utf8'));
  const attempt = await f.run('other-goal');
  assert.notEqual(attempt.result.outcome?.stop, 'AwaitingHostAcceptance');
  const after = JSON.parse(await readFile(f.session, 'utf8'));
  assert.deepEqual(after.goal, original.goal);
  assert.deepEqual(after.goal_history, []);
  assert.equal(f.calls(), 1);
});
