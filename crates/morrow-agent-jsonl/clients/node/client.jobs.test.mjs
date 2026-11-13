import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startTask } from './client.mjs';
import { sendManagement } from './management.mjs';

const binary = process.env.MORROW_TEST_BINARY;
const worker = process.env.MORROW_TEST_JOB_WORKER;
const integration = { skip: !binary || !worker, timeout: 30000 };

async function fixture(t, allowJobs, selectedWorker = worker) {
  const root = await mkdtemp(path.join(tmpdir(), 'morrow-jsonl-jobs-'));
  t.diagnostic(`evidence ${root}`);
  const requests = [];
  const receipts = [];
  const args = { op_id: 'native-once', language: 'python', timeout: 10,
    script: "from pathlib import Path; p = Path('job-effect.txt'); p.write_text(str(int(p.read_text()) + 1) if p.exists() else '1')" };
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const tools = body.tools.map(tool => tool.function.name);
      assert.equal(tools.includes('job_start'), allowJobs);
      for (const tool of ['exec', 'read', 'write', 'run_script', 'web_fetch']) assert.equal(tools.includes(tool), false);
      let call;
      if (allowJobs) {
        const last = body.messages.filter(message => message.role === 'tool').at(-1);
        let receipt;
        if (last) {
          const content = typeof last.content === 'string' ? last.content : last.content.map(part => part.text ?? '').join('');
          receipt = JSON.parse(content);
          receipts.push(receipt);
        }
        if (requests.length <= 2) call = { name: 'job_start', arguments: JSON.stringify(args) };
        else if (requests.length === 3 || receipt.state !== 'succeeded') {
          assert.ok(receipt.job_id, 'native Job receipt must carry its stable identity');
          await new Promise(resolve => setTimeout(resolve, 80));
          call = { name: 'job_status', arguments: JSON.stringify({ job_id: receipt.job_id }) };
        }
      }
      const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `job-call-${requests.length}`, type: 'function', function: call }] }
        : { role: 'assistant', content: 'Native worker result observed.' };
      response.setHeader('Content-Type', 'text/event-stream');
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) {
      response.writeHead(400); response.end('controlled fixture assertion failed');
      t.diagnostic(error.stack ?? String(error));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const start = { kind: 'start_task', version: 1,
    task: { task_id: 'job-task', criteria_revision: 'c1', authorization_revision: 'a1', kind: 'Reasoning',
      evidence_dir: path.join(root, 'evidence'), max_runs: 3, max_calls: 16, deadline_unix_ms: Date.now() + 25000 },
    run: { run_id: 'job-run', objective: 'Use the authorized native Job and inspect its receipt.', cwd: root,
      session_path: path.join(root, 'session.json'), environment_state: path.join(root, 'environment'),
      device_fp: 'job-host', session_key: 'job-session', mode: 'goal',
      endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'controlled', max_calls: 16, max_seconds: 20, max_output: 256,
      worker_executable: selectedWorker, tools: [],
      model_resolution: { kind: 'host_declared_loopback', capabilities: { context_window: 32000, max_tokens: 4096, input: ['text'] } } },
    goal: { goal_id: 'job-goal', criteria: ['Observe the original Job effect exactly once.'], lease: {
      goal_id: 'job-goal', controller: 'controlled-host', device: 'job-host', session: 'job-session',
      expires_at: Math.floor(Date.now() / 1000) + 30, max_calls: 16, max_slices: 3, allow_jobs: allowJobs } } };
  const callbacks = {
    tool() { throw Error('Job must execute in the Rust runtime'); },
    verify(candidate) { return { basis: candidate.basis, committed: true, settlement: 'Settled', verdict: 'Verified', evidence: ['controlled-observation'] }; },
    prepare() { throw Error('no automatic continuation'); },
  };
  const handle = await startTask({ binary, start, modelToken: 'controlled-only', operationDirectory: path.join(root, 'operations'), callbacks });
  t.after(() => { if (!handle.status().closed) handle.forceKill(); });
  let result = await handle.wait();
  if (allowJobs && result.outcome?.stop === 'GoalWaiting') {
    const session = JSON.parse(await readFile(start.run.session_path, 'utf8'));
    const native = session.messages.find(message => message.role === 'toolResult' && message.toolName === 'job_start');
    const submitted = JSON.parse(native.content.map(part => part.text ?? '').join(''));
    assert.equal(result.outcome.fence_presence, 'Present');
    const request = { operation: 'job_snapshot', session: start.run.session_path, cwd: root,
      device: start.run.device_fp, session_id: start.run.session_key };
    await assert.rejects(sendManagement({ binary, request: { ...request, device: 'wrong-device' } }), /owner differs/);
    const deadline = Date.now() + 10000;
    let snapshot, receipt;
    do {
      snapshot = await sendManagement({ binary, request });
      assert.equal(snapshot.goal_id, start.goal.goal_id);
      assert.equal(snapshot.goal_status, 'waiting_job');
      receipt = snapshot.jobs.find(job => job.job_id === submitted.job_id);
      assert.ok(receipt);
      assert.equal(Object.hasOwn(receipt, 'worker_nonce'), false);
      if (receipt.finished_at !== null) break;
      assert.ok(Date.now() < deadline, 'controlled Worker did not publish a terminal receipt');
      await new Promise(resolve => setTimeout(resolve, 40));
    } while (true);
    assert.equal(receipt.state, 'succeeded');
    const selected = await sendManagement({ binary, request: { ...request, job_id: receipt.job_id } });
    assert.equal(selected.jobs.length, 1);
    const receiptPath = path.join(root, 'job-observation.json');
    await writeFile(receiptPath, JSON.stringify(snapshot), { flag: 'wx' });
    const fence = await readFile(result.outcome.reconciliation_fence);
    const next = { ...start, task: { ...start.task, evidence_dir: path.join(root, 'resumed') },
      run: { ...start.run, run_id: 'job-run-2' }, resume: { version: 1, fence_sha256: createHash('sha256').update(fence).digest('hex') } };
    const resumed = await startTask({ binary, start: next, modelToken: 'controlled-only', operationDirectory: path.join(root, 'resumed-operations'),
      callbacks: { ...callbacks, reconcileResume(review) {
        assert.equal(review.interrupted_run?.open_tool_calls?.length ?? 0, 0);
        return { committed: true, settlement: 'Settled', tool_calls: [], evidence: [receiptPath] };
      } } });
    t.after(() => { if (!resumed.status().closed) resumed.forceKill(); });
    result = await resumed.wait();
  }
  return { root, result, requests, receipts };
}

test('Host-selected native worker executes one idempotent Job with local tools disabled', integration, async t => {
  const f = await fixture(t, true);
  assert.equal(f.result.delivery, 'validated', JSON.stringify(f.result));
  assert.equal(await readFile(path.join(f.root, 'job-effect.txt'), 'utf8'), '1');
  assert.ok(f.receipts.some(receipt => receipt.state === 'succeeded'));
  assert.equal(new Set(f.receipts.map(receipt => receipt.job_id)).size, 1);
  assert.equal(f.result.outcome.task_accepted, false);
});

test('a worker path cannot grant Job creation when the Goal lease denies it', integration, async t => {
  const f = await fixture(t, false);
  assert.equal(f.result.delivery, 'validated', JSON.stringify(f.result));
  assert.equal(f.requests.length, 1);
  await assert.rejects(stat(path.join(f.root, 'job-effect.txt')), { code: 'ENOENT' });
});

test('relative or absent worker files are refused before model dispatch', integration, async t => {
  for (const selected of ['relative-worker.exe', path.join(tmpdir(), 'morrow-no-such-worker-818177.exe')]) {
    const f = await fixture(t, true, selected);
    assert.equal(f.result.delivery, 'unknown');
    assert.equal(f.requests.length, 0);
    await assert.rejects(stat(path.join(f.root, 'evidence')), { code: 'ENOENT' });
  }
});
