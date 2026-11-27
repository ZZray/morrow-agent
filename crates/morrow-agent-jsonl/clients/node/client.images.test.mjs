import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { runTask, readCheckedJsonReference, reconcileReplyFor } from './client.mjs';

const VALID_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const binary = process.env.MORROW_JSONL_TEST_BINARY || process.env.MORROW_AGENT_JSONL_BIN;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('reconcileReplyFor accepts completed PNG images and rejects failed or relative images', () => {
  const frame = { version: 1, rpc_id: 'rpc-1', task_id: 'task-1', run_id: 'run-2' };
  const absPng = path.resolve(os.tmpdir(), 'settled-shot.png');
  const img = { path: absPng, sha256: 'a'.repeat(64), bytes: 68, mime_type: 'image/png', width: 1, height: 1 };
  const ok = reconcileReplyFor(frame, {
    committed: true,
    settlement: 'Settled',
    tool_calls: [{ call_id: 'c1', settlement: { kind: 'completed', output: 'done', images: [img] } }],
    evidence: ['r1'],
  });
  assert.equal(ok.kind, 'reconcile_reply');
  assert.equal(ok.receipt.tool_calls[0].settlement.images.length, 1);

  assert.throws(() => reconcileReplyFor(frame, {
    committed: true,
    settlement: 'Settled',
    tool_calls: [{ call_id: 'c1', settlement: { kind: 'failed', output: 'err', images: [img] } }],
    evidence: ['r1'],
  }), /reconcile_receipt_invalid/);

  assert.throws(() => reconcileReplyFor(frame, {
    committed: true,
    settlement: 'Settled',
    tool_calls: [{ call_id: 'c1', settlement: { kind: 'completed', output: 'done', images: [{ ...img, path: 'rel.png' }] } }],
    evidence: ['r1'],
  }), /reconcile_receipt_invalid/);
});

test('real sidecar delivers typed PNG tool images to vision model and emits tool_images_ref proof', { skip: !binary, timeout: 30000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'morrow-jsonl-images-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pngBytes = Buffer.from(VALID_PNG_B64, 'base64');
  const pngPath = path.join(root, 'capture.png');
  await fs.writeFile(pngPath, pngBytes);
  const pngSha = sha256(pngBytes);

  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const first = requests.length === 1;
    const delta = first
      ? { tool_calls: [{ index: 0, id: 'shot-1', type: 'function', function: { name: 'capture', arguments: JSON.stringify({ region: 'full' }) } }] }
      : { content: 'Verified image.' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [part, finish] of [[{ role: 'assistant' }, null], [delta, null], [{}, first ? 'tool_calls' : 'stop']]) {
      res.write(`data: ${JSON.stringify({ id: 'vision-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const evidenceDir = path.join(root, 'evidence');
  const start = {
    kind: 'start_task',
    version: 1,
    task: {
      task_id: 'vision-task-1',
      criteria_revision: 'c-v1',
      authorization_revision: 'a-v1',
      kind: 'Reasoning',
      evidence_dir: evidenceDir,
      max_runs: 1,
      max_calls: 4,
      deadline_unix_ms: Date.now() + 25000,
    },
    run: {
      run_id: 'run-1',
      objective: 'Capture screen and inspect.',
      cwd: root,
      session_path: path.join(root, 'session.json'),
      environment_state: path.join(root, 'env'),
      device_fp: 'dev-1',
      session_key: 'sess-1',
      mode: 'execute',
      endpoint: `http://127.0.0.1:${server.address().port}/v1`,
      model: 'vision-loopback',
      max_calls: 4,
      max_seconds: 20,
      max_output: 512,
      model_resolution: {
        kind: 'host_declared_loopback',
        capabilities: { context_window: 32768, max_tokens: 4096, input: ['text', 'image'] },
      },
      tools: [{
        name: 'capture',
        description: 'Capture PNG.',
        parameters: { type: 'object', properties: { region: { type: 'string' } }, required: ['region'], additionalProperties: false },
      }],
    },
    cancel_grace_ms: 1000,
  };

  let verifiedProof = null;
  // Use 'iVBOR' as modelToken to verify PNG base64 is never corrupted by credential redaction!
  const result = await runTask({
    binary,
    start,
    modelToken: 'iVBOR',
    operationDirectory: path.join(root, 'ops'),
    callbacks: {
      tool: async () => ({
        value: { captured: true, note: 'token=iVBOR' },
        is_error: false,
        settlement: 'Settled',
        operation_receipt: path.join(root, 'op-receipt.json'),
        images: [{ path: pngPath, sha256: pngSha, bytes: pngBytes.length, mime_type: 'image/png', width: 1, height: 1 }],
      }),
      verify: async (candidate, { frame }) => {
        assert.ok(frame.tool_images_ref, 'verify_request must include tool_images_ref');
        verifiedProof = await readCheckedJsonReference(frame.tool_images_ref, evidenceDir);
        return { basis: candidate.basis, committed: true, settlement: 'Settled', verdict: 'Verified', evidence: ['ok-1'] };
      },
      prepare: async () => { throw new Error('unexpected prepare'); },
    },
  });

  assert.equal(result.delivery, 'validated');
  assert.equal(result.outcome.stop, 'AwaitingHostAcceptance');
  assert.equal(requests.length, 2);
  const secondBody = JSON.stringify(requests[1]);
  assert.ok(secondBody.includes(`data:image/png;base64,${VALID_PNG_B64}`), 'model received exact uncorrupted PNG base64');
  assert.equal(verifiedProof.kind, 'jsonl-native-images-v1');
  assert.deepEqual(verifiedProof.basis, result.outcome.last_receipt.basis);
  assert.equal(verifiedProof.calls.length, 1);
  assert.deepEqual(verifiedProof.calls[0].images, [{ mime_type: 'image/png', bytes: pngBytes.length, sha256: pngSha }]);
});
