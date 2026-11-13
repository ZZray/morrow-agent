import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { sendManagement, ManagementError } from './management.mjs';
import { startTask } from './client.mjs';

const fixture = `
let text = '';
process.stdin.on('data', chunk => text += chunk);
process.stdin.on('end', async () => {
  const frame = JSON.parse(text);
  const mode = process.argv[1];
  const reply = {kind:'management_result',version:1,id:frame.id,ok:true,value:{nested:[{x:'a,b:{\\"z\\"}'},2]}};
  if (mode === 'timeout') { setTimeout(() => {}, 60000); return; }
  if (mode === 'stderr') { process.stderr.write('x'.repeat(65537)); setTimeout(() => {}, 60000); return; }
  if (mode === 'stdout') { process.stdout.write('x'.repeat(262145)); setTimeout(() => {}, 60000); return; }
  if (mode === 'identity') reply.id = 'another';
  if (mode === 'version') reply.version = 2;
  if (mode === 'unknown') reply.extra = true;
  if (mode === 'environment') reply.value = {secret:process.env.MORROW_MANAGEMENT_TEST_SECRET ?? null,token:process.env.MORROW_AGENT_MODEL_TOKEN ?? null,lang:process.env.LANG};
  if (mode === 'failure') { delete reply.value; reply.ok = false; reply.error = 'owned bundle required'; }
  if (mode.startsWith('reference')) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const {createHash} = await import('node:crypto');
    const directory = path.join(frame.request.directory, 'management-results');
    await fs.mkdir(directory, {recursive:true});
    let file = path.join(directory, 'payload.json');
    const payload = JSON.stringify({large:'x'.repeat(300000)});
    if (mode === 'reference-outside') file = path.join(frame.request.directory, 'outside.json');
    if (mode === 'reference-junction') {
      const outside = path.join(frame.request.directory, 'outside');
      await fs.mkdir(outside);
      const link = path.join(directory, 'link');
      await fs.symlink(outside, link, 'junction');
      file = path.join(link, 'payload.json');
    }
    await fs.writeFile(file, payload);
    if (mode === 'reference-size') await fs.truncate(file, 64*1024*1024+1);
    delete reply.value;
    reply.value_ref = {path:file,sha256:mode === 'reference-hash' ? '0'.repeat(64) : createHash('sha256').update(payload).digest('hex')};
  }
  let line = JSON.stringify(reply);
  if (mode === 'duplicate') line = line.slice(0,-1) + ',"ok":true}';
  if (mode === 'nested-duplicate') line = line.replace('"value":', '"value":{"a":1,"\\\\u0061":2},"discard":');
  process.stdout.write(line + '\\n');
  if (mode === 'extra-line') process.stdout.write('{}\\n');
  if (mode === 'exit') process.exitCode = 2;
});
`;
const options = (mode) => ({ binary: process.execPath, binaryArgs: ['-e', fixture, mode],
  request: { operation: 'queue_snapshot', directory: path.resolve('.') }, timeoutMs: 3000 });

test('management client receives one bounded typed response', async () => {
  const result = await sendManagement(options('valid'));
  assert.equal(result.nested.length, 2);
});

test('management client rejects malformed envelopes and duplicate fields', async () => {
  for (const mode of ['identity', 'version', 'unknown', 'duplicate', 'nested-duplicate', 'extra-line', 'exit']) {
    await assert.rejects(sendManagement(options(mode)), (error) => error instanceof ManagementError && error.delivery === 'unknown', mode);
  }
});

test('management client bounds output, diagnostics and total process time', async () => {
  for (const mode of ['stdout', 'stderr', 'timeout']) {
    await assert.rejects(sendManagement({ ...options(mode), timeoutMs: mode === 'timeout' ? 100 : 3000 }),
      (error) => error instanceof ManagementError && error.delivery === 'unknown', mode);
  }
});

test('management client reports spawn failure without waiting for timeout', async () => {
  await assert.rejects(sendManagement({ ...options('valid'), binary: path.join(tmpdir(), 'morrow-no-such-binary-918763.exe') }),
    (error) => error instanceof ManagementError && error.delivery === 'not_started');
});

test('management client distinguishes delivered operation failure', async () => {
  await assert.rejects(sendManagement(options('failure')), (error) => error.delivery === 'validated' && /owned bundle/.test(error.message));
});

test('management client passes only platform environment and explicit allowed overrides', async () => {
  const oldSecret = process.env.MORROW_MANAGEMENT_TEST_SECRET;
  const oldToken = process.env.MORROW_AGENT_MODEL_TOKEN;
  process.env.MORROW_MANAGEMENT_TEST_SECRET = 'never-inherit';
  process.env.MORROW_AGENT_MODEL_TOKEN = 'never-inherit';
  try {
    assert.deepEqual(await sendManagement({ ...options('environment'), env: { LANG: 'fixture-language' } }),
      { secret: null, token: null, lang: 'fixture-language' });
    await assert.rejects(sendManagement({ ...options('valid'), env: { MORROW_AGENT_MODEL_TOKEN: 'forbidden' } }), /environment override/);
  } finally {
    if (oldSecret === undefined) delete process.env.MORROW_MANAGEMENT_TEST_SECRET; else process.env.MORROW_MANAGEMENT_TEST_SECRET = oldSecret;
    if (oldToken === undefined) delete process.env.MORROW_AGENT_MODEL_TOKEN; else process.env.MORROW_AGENT_MODEL_TOKEN = oldToken;
  }
});

test('management references are limited to the request store and checked for hash, links and size', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'morrow-management-ref-'));
  t.diagnostic(`evidence ${root}`);
  for (const mode of ['reference', 'reference-hash', 'reference-outside', 'reference-junction', 'reference-size']) {
    const directory = path.join(root, mode);
    const call = sendManagement({ ...options(mode), request: { operation: 'queue_snapshot', directory } });
    if (mode === 'reference') assert.equal((await call).large.length, 300000);
    else await assert.rejects(call, error => error instanceof ManagementError && error.delivery === 'unknown', mode);
  }
  await assert.rejects(sendManagement({ ...options('reference'), request: { operation: 'skill_catalog', directory: path.join(root, 'unexpected') } }), /unexpected management result reference/);
});

const binary = process.env.MORROW_AGENT_JSONL_BINARY;
test('real sidecar creates, reads, installs, enables and retires Skills across processes', { skip: !binary, timeout: 30000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'morrow-management-'));
  const roots = { environment_dir: path.join(root, 'env'), global_knowledge: path.join(root, 'knowledge'), project_knowledge: path.join(root, 'project-knowledge'),
    global_skills: path.join(root, 'skills'), project_skills: path.join(root, 'project-skills') };
  const send = (request) => sendManagement({ binary, request });
  t.diagnostic(`evidence ${root}`);
  const created = await send({ operation: 'skill_create', roots, scope: 'project', name: 'nmr-check', description: 'Inspect an NMR result', instructions: 'Read the raw result and retain its source.', resources: { LICENSE: 'Fixture license' } });
  assert.equal(created.enabled, true);
  const read = await send({ operation: 'skill_read', roots, scope: 'project', name: 'nmr-check' });
  assert.match(read.content, /Read the raw result/);
  await send({ operation: 'skill_enable', roots, scope: 'project', name: 'nmr-check', expected_hash: created.content_hash, enabled: false });
  const catalog = await send({ operation: 'skill_catalog', roots });
  assert.equal(catalog.skills.find(item => item.name === 'nmr-check').enabled, false);
  await assert.rejects(send({ operation: 'skill_remove', roots, scope: 'project', name: 'nmr-check', expected_hash: '0'.repeat(64) }), /content changed/);
  await send({ operation: 'skill_enable', roots, scope: 'project', name: 'nmr-check', expected_hash: created.content_hash, enabled: true });
  const installed = await send({ operation: 'skill_install', roots, scope: 'global', source_dir: created.bundle_dir });
  assert.equal(installed.content_hash, created.content_hash);
  assert.equal(await readFile(path.join(installed.bundle_dir, 'LICENSE'), 'utf8'), 'Fixture license');
  const retired = await send({ operation: 'skill_remove', roots, scope: 'project', name: 'nmr-check', expected_hash: created.content_hash });
  assert.equal(retired.status, 'retired');
  assert.match(await readFile(path.join(retired.preserved_at, 'SKILL.md'), 'utf8'), /Read the raw result/);
  const manual = path.join(root, 'manual');
  await mkdir(manual);
  await writeFile(path.join(manual, 'SKILL.md'), '---\nname: user-method\ndescription: User method\n---\nRead source.\n');
  const imported = await send({ operation: 'skill_install', roots, scope: 'project', source_dir: manual });
  assert.equal(imported.name, 'user-method');
  for (let index = 0; index < 40; index++) {
    const name = `batch-${String(index).padStart(3, '0')}`;
    const directory = path.join(roots.project_skills, name);
    await mkdir(directory);
    await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${'Method description '.repeat(16)}\n---\nRead the source.\n`);
  }
  const names = [];
  let offset = 0;
  do {
    const page = await send({ operation: 'skill_catalog', roots, offset, limit: 7 });
    assert.equal(page.partial, false);
    assert.deepEqual(page.issues, []);
    names.push(...page.skills.map(item => `${item.scope}:${item.name}`));
    assert.ok(page.next_offset === null || page.next_offset > offset);
    offset = page.next_offset;
  } while (offset !== null);
  assert.equal(names.filter(name => name.startsWith('project:batch-')).length, 40);
  assert.equal(new Set(names).size, names.length);
  const directory = path.join(root, 'queue');
  assert.equal((await send({ operation: 'queue_snapshot', directory })).version, 1);
  const configuration_sha256 = 'a'.repeat(64);
  const enqueue = { operation: 'queue_enqueue', directory,
    trigger: { id: 'trigger-1', revision: '1', source_ref: 'host:goal-request' },
    mandate: { id: 'mandate-1', revision: '1', authorization_ref: 'host:user-request', configuration_sha256 },
    assignment: { id: 'assignment-1', trigger_id: 'trigger-1', mandate_id: 'mandate-1', configuration_sha256,
      task: { task_id: 'task-1', criteria_revision: 'c1', authorization_revision: 'a1', kind: 'Reasoning',
        evidence_dir: path.join(root, 'evidence'), max_runs: 2, max_calls: 8, deadline_unix_ms: Date.now() + 60000 },
      session_id: 'session-1', session_path: path.join(root, 'session.json'), cwd: root,
      options: { budget_stop_review: 'review_closed_tool_round' } }, at_ms: Date.now() };
  assert.equal((await send(enqueue)).phase, 'queued');
  assert.equal((await send(enqueue)).phase, 'queued');
  await send({ operation: 'queue_cancel', directory, assignment_id: 'assignment-1', at_ms: Date.now() });
  assert.equal((await send({ operation: 'queue_snapshot', directory })).assignments['assignment-1'].cancellation_requested, true);
  assert.ok((await send({ operation: 'queue_events', directory, after: 0 })).length >= 2);
  assert.deepEqual(await send({ operation: 'queue_watchdog', directory, at_ms: Date.now() }), []);
});

test('real sidecar context management uses the original Session for equivalent absolute paths', { skip: !binary, timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'morrow-management-context-'));
  t.diagnostic(`evidence ${root}`);
  const session = path.join(root, 'session.json');
  const alternate = process.platform === 'win32' ? path.toNamespacedPath(session) : `${root}${path.sep}.${path.sep}session.json`;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the controlled model request. */ }
    response.setHeader('Content-Type', 'text/event-stream');
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Reviewed source.' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const handle = await startTask({ binary, modelToken: 'controlled-management-test', operationDirectory: path.join(root, 'operations'),
    start: { kind: 'start_task', version: 1,
      task: { task_id: 'context-task', criteria_revision: 'c1', authorization_revision: 'a1', kind: 'Reasoning',
        evidence_dir: path.join(root, 'evidence'), max_runs: 1, max_calls: 4, deadline_unix_ms: Date.now() + 20000 },
      run: { run_id: 'context-run', objective: 'Inspect the source.', cwd: root, session_path: session,
        environment_state: path.join(root, 'environment'), device_fp: 'controlled-host', session_key: 'controlled/session',
        mode: 'execute', endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'controlled-model',
        max_calls: 4, max_seconds: 15, max_output: 256, tools: [],
        model_resolution: { kind: 'host_declared_loopback', capabilities: { context_window: 32000, max_tokens: 4096, input: ['text'] } } } },
    callbacks: { tool() { throw Error('unexpected tool'); },
      verify(candidate) { return { basis: candidate.basis, committed: true, settlement: 'Settled', verdict: 'Verified', evidence: ['controlled-review'] }; },
      prepare() { throw Error('unexpected continuation'); } } });
  t.after(() => { if (!handle.status().closed) handle.forceKill(); });
  assert.equal((await handle.wait()).delivery, 'validated');
  const send = request => sendManagement({ binary, request: { cwd: root, ...request } });
  const before = await send({ operation: 'context_snapshot', session });
  assert.deepEqual(await send({ operation: 'context_snapshot', session: alternate }), before);
  const added = await send({ operation: 'context_add_reference', session, kind: 'user_source', text: 'Measured result.', id: 'add-source' });
  assert.equal(added.context.scope, before.scope);
  const updated = await send({ operation: 'context_command', session: alternate, command: `/reference revoke ${added.reference_id}`, id: 'revoke-source' });
  assert.equal(updated.context.scope, before.scope);
  const after = await send({ operation: 'context_snapshot', session });
  assert.equal(after.references.find(reference => reference.id === added.reference_id).status, 'revoked');
  // The Core accepts context stores larger than a JSONL transport frame.
  for (let index = 0; index < 5; index++) {
    const result = await send({ operation: 'context_add_reference', session, kind: 'large_source', text: 'x'.repeat(60000),
      id: `large-${index}`, compact: index < 4 });
    assert.equal(typeof result.reference_id, 'string');
    if (index < 4) assert.equal(Object.hasOwn(result, 'context'), false);
    else assert.ok(result.context.references.length >= 7);
  }
  const large = await send({ operation: 'context_snapshot', session });
  assert.equal(large.references.filter(reference => reference.kind === 'large_source').length, 5);
  const firstLarge = large.references.find(reference => reference.kind === 'large_source').id;
  const compact = await send({ operation: 'context_command', session, command: `/reference revoke ${firstLarge}`, compact: true });
  assert.equal(Object.hasOwn(compact, 'context'), false);
  assert.match(compact.output, /saved/);
  assert.equal((await send({ operation: 'context_snapshot', session })).references.find(reference => reference.id === firstLarge).status, 'revoked');
});
