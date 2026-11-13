// Copyright (c) Ray Zhang. Tests the ordinary Rust executable and HTTP service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync, linkSync, writeFileSync, symlinkSync } from 'node:fs';
import { createServer as createPipeServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { fixture, until, launch, kill, delay, digest, ps, executable } from './native-fixture.ts';

test('native pair, single owner, streamed command, duplicate request and file effects', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const rejected = await f.pair('INVALID-CODE'); assert.notEqual(rejected.code, 0);
    assert.equal(f.identity().pending_pair, null);
    assert.equal((await f.pair()).code, 0);
    const binding = f.identity(); assert.ok(binding.node_id);
    const runner = f.node('run');
    await until(() => f.request('/api/v1/nodes'), value => value.nodes.some((n: any) => n.last_seen));
    const second = await f.node('run', '--once').done;
    assert.notEqual(second.code, 0); assert.match(second.stderr, /another Reach process/);
    const path = join(f.root, 'command-effect.txt'); const requestId = randomUUID();
    const command = { kind: 'command.run', command: `[Console]::Out.WriteLine('stream-before-end'); Start-Sleep -Seconds 3; [IO.File]::AppendAllText(${ps(path)},'once')`, timeoutMs: 10000 };
    const op = await f.submit(command, requestId);
    assert.equal((await f.submit(command, requestId)).id, op.id);
    await until(async () => ({ events: await f.events(op.id), operation: await f.operation(op.id), node: runner.logs() }), value => value.events.some(row => row.data.base64 && Buffer.from(row.data.base64, 'base64').toString().includes('stream-before-end')));
    assert.equal((await f.operation(op.id)).execution, 'running'); assert.equal(existsSync(path), false);
    assert.equal((await f.settled(op.id)).execution, 'succeeded'); assert.equal(readFileSync(path, 'utf8'), 'once');
    const linked = join(f.root, 'same-file.txt'); linkSync(path, linked);
    const write = await f.submit({ kind: 'file.write', path, contentBase64: Buffer.from('新内容').toString('base64'), expectedSha256: digest('once') });
    assert.equal((await f.settled(write.id)).execution, 'succeeded'); assert.equal(readFileSync(linked, 'utf8'), '新内容');
    const stale = await f.submit({ kind: 'file.write', path, contentBase64: Buffer.from('wrong').toString('base64'), expectedSha256: digest('once') });
    assert.equal((await f.settled(stale.id)).execution, 'failed'); assert.equal(readFileSync(path, 'utf8'), '新内容');
    const read = await f.submit({ kind: 'file.read', path, offset: 0, length: 65536 });
    const readResult = JSON.parse((await f.settled(read.id)).result_json);
    assert.equal(Buffer.from(readResult.contentBase64, 'base64').toString(), '新内容'); assert.equal(readResult.sha256, digest('新内容'));
    const list = await f.submit({ kind: 'directory.list', path: f.root });
    assert.ok(JSON.parse((await f.settled(list.id)).result_json).entries.some((v: any) => v.name === 'same-file.txt'));
    await kill(runner.child); assert.equal(f.identity().node_id, binding.node_id);
  } finally { await f.cleanup(); }
});

test('lost pairing response retries one persisted binding; rejected expired code can be replaced', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const code = (await f.request('/api/v1/pairing-codes', 'POST', {})).code;
    f.intercept(async (request, response, _bytes, forward) => {
      if (request.url !== '/api/v1/node/pair') return false;
      const accepted = await forward(); assert.equal(accepted.status, 200); await accepted.arrayBuffer(); response.destroy(); return true;
    });
    assert.notEqual((await f.pair(code)).code, 0);
    const pending = f.identity().pending_pair; assert.ok(pending.input.attemptId);
    f.intercept(); assert.equal((await f.pair(code)).code, 0);
    assert.equal(f.identity().secret, pending.input.installationSecret);
    assert.equal((await f.request('/api/v1/nodes')).nodes.length, 1);
  } finally { await f.cleanup(); }
});

test('cancel stops actual Windows descendants and records uncertain effects', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.pair()).code, 0); f.node('run');
    const pidPath = join(f.root, 'descendant.pid');
    const command = `$reachChild=Start-Process -WindowStyle Hidden -PassThru powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 90'; [IO.File]::WriteAllText(${ps(pidPath)},[string]$reachChild.Id); Start-Sleep -Seconds 90`;
    const op = await f.submit({ kind: 'command.run', command, timeoutMs: 120000 });
    await until(async () => existsSync(pidPath), Boolean);
    const pid = Number(readFileSync(pidPath, 'utf8')); assert.ok(pid > 0); process.kill(pid, 0);
    await f.request(`/api/v1/operations/${op.id}/cancel`, 'POST', {});
    const end = await f.settled(op.id); assert.equal(end.execution, 'unknown'); assert.equal(JSON.parse(end.result_json).processTreeStopped, true);
    assert.throws(() => process.kill(pid, 0));
  } finally { await f.cleanup(); }
});

test('killed Node retains receipts and never reexecutes a command on restart', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.pair()).code, 0); const runner = f.node('run');
    const path = join(f.root, 'crash-effect.txt');
    const op = await f.submit({ kind: 'command.run', command: `[IO.File]::AppendAllText(${ps(path)},'once'); Start-Sleep -Seconds 90`, timeoutMs: 120000 });
    await until(async () => existsSync(path), Boolean); await kill(runner.child);
    f.node('run'); const end = await f.settled(op.id); assert.equal(end.execution, 'unknown');
    assert.equal(JSON.parse(end.result_json).reason, 'node_process_interrupted');
    await delay(1000); assert.equal(readFileSync(path, 'utf8'), 'once');
  } finally { await f.cleanup(); }
});

test('server claim lost before local admission becomes unknown at the original cursor', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.pair()).code, 0);
    const effect = join(f.root, 'never.txt');
    await f.request('/api/v1/node/poll', 'POST', { version: 'fault-fixture', capabilities: ['command.run'] }, f.identity().secret);
    const op = await f.submit({ kind: 'command.run', command: `[IO.File]::WriteAllText(${ps(effect)},'wrong')`, timeoutMs: 10000 });
    const secret = f.identity().secret;
    const dispatch = (await f.request('/api/v1/node/poll', 'POST', { version: 'fault-fixture', capabilities: ['command.run'] }, secret)).operation;
    // A preceding Node had already uploaded two original receipts; this Node
    // has lost them. Its diagnostic must append at 3, never invent 1 or 2.
    for (const [index, kind] of ['received', 'running'].entries()) await f.request('/api/v1/node/events', 'POST', { eventId: randomUUID(), operationId: op.id, dispatchId: dispatch.dispatchId, payloadHash: dispatch.payloadHash, sequence: index + 1, kind, data: { faultFixture: true } }, secret);
    const runner = f.node('run');
    const end = await f.settled(op.id); assert.equal(end.execution, 'unknown');
    assert.equal(end.last_sequence, 3); assert.equal(JSON.parse(end.result_json).reason, 'local_receipt_missing');
    assert.equal(existsSync(effect), false); await kill(runner.child);
    f.sql(db => db.exec('DELETE FROM outbox; DELETE FROM operations;'));
    f.node('run'); await delay(1500);
    assert.equal((await f.operation(op.id)).last_sequence, 3); assert.equal(existsSync(effect), false);
  } finally { await f.cleanup(); }
});

test('lost server ACK and unavailable uploads replay original events only, even after unpair', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.pair()).code, 0);
    let dropped = false; let block = false; const sent: any[] = [];
    f.intercept(async (request, response, bytes, forward) => {
      if (request.url !== '/api/v1/node/events') return false;
      const event = JSON.parse(bytes.toString()); sent.push(event);
      if (event.kind === 'succeeded') block = true;
      if (block) { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'controlled_outage' } })); return true; }
      if (!dropped) { const accepted = await forward(); assert.equal(accepted.status, 200); await accepted.arrayBuffer(); dropped = true; response.destroy(); return true; }
      return false;
    });
    const runner = f.node('run'); const effect = join(f.root, 'upload-effect.txt');
    const op = await f.submit({ kind: 'command.run', command: `[IO.File]::AppendAllText(${ps(effect)},'once')`, timeoutMs: 10000 });
    await until(async () => block, Boolean);
    await f.request(`/api/v1/nodes/${f.identity().node_id}/unpair`, 'POST', {});
    await kill(runner.child);
    const blockedPair = await f.pair(); assert.notEqual(blockedPair.code, 0); assert.match(blockedPair.stderr, /upload original receipts/); assert.equal(f.identity().pending_pair, null);
    f.intercept(); f.node('run');
    assert.equal((await f.settled(op.id)).execution, 'succeeded'); assert.equal(readFileSync(effect, 'utf8'), 'once');
    assert.ok(sent.length >= 2); assert.deepEqual(sent[0], sent[1]);
    const rows = await f.events(op.id); assert.equal(rows.filter(row => row.kind === 'received').length, 1);
  } finally { await f.cleanup(); }
});

test('pending service outage recovers on the same Node process', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.pair()).code, 0);
    let failures = 0;
    f.intercept(async (request, response) => {
      if (request.url !== '/api/v1/node/pending') return false;
      failures++; response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'controlled_outage' } })); return true;
    });
    const runner = f.node('run'); await until(async () => failures, value => value >= 2);
    assert.equal(runner.child.exitCode, null); f.intercept();
    const path = join(f.root, 'reconnected.txt');
    const op = await f.submit({ kind: 'file.write', path, contentBase64: Buffer.from('same-process').toString('base64') });
    assert.equal((await f.settled(op.id)).execution, 'succeeded'); assert.equal(readFileSync(path, 'utf8'), 'same-process');
    assert.equal(runner.child.exitCode, null);
  } finally { await f.cleanup(); }
});

test('lost accepted pair response followed by unpair recovers installation before new pairing', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    assert.notEqual((await f.pair('bad')).code, 0); assert.equal(f.identity().pending_pair, null);
    const installation = f.identity().installation_id;
    const code = (await f.request('/api/v1/pairing-codes', 'POST', {})).code;
    f.intercept(async (request, response, _bytes, forward) => {
      if (request.url !== '/api/v1/node/pair') return false;
      const accepted = await forward(); assert.equal(accepted.status, 200); await accepted.arrayBuffer(); response.destroy(); return true;
    });
    assert.notEqual((await f.pair(code)).code, 0);
    const node = (await f.request('/api/v1/nodes')).nodes[0];
    await f.request(`/api/v1/nodes/${node.id}/unpair`, 'POST', {}); f.intercept();
    const recovered = await f.pair(code); assert.equal(recovered.code, 0, recovered.stderr); assert.equal(f.identity().revoked, true);
    assert.equal((await f.pair()).code, 0); assert.equal(f.identity().node_id, node.id); assert.equal(f.identity().installation_id, installation); assert.equal(f.identity().epoch, 2);
  } finally { await f.cleanup(); }
});

for (const prefix of ['', '/reach']) test(`CLI and MCP control the same real Node and preserve request identity at ${prefix || '/'}`, { timeout: 120000 }, async () => {
  const f = await fixture(prefix);
  try {
    const login = await f.loginController(); assert.equal(login.code, 0, login.stderr); assert.equal(JSON.parse(login.stdout).loggedIn, true); assert.ok(!login.stdout.includes('token'));
    assert.equal((await f.pair()).code, 0); f.node('run');
    await until(() => f.request('/api/v1/nodes'), value => value.nodes[0].capabilities.includes('file.write'));
    const cliNodes = await f.controller(['nodes']).done; assert.equal(cliNodes.code, 0, cliNodes.stderr);
    const mcp = f.mcp();
    const initialized = await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'native-fixture', version: '1' } });
    assert.equal(initialized.result.serverInfo.name, 'ry-reach');
    const listed = await mcp.call('tools/list');
    assert.deepEqual(listed.result.tools.map((tool:any)=>tool.name).sort(),
      ['reach_nodes','reach_protocol','reach_submit','reach_operation','reach_events','reach_cancel','reach_reconcile','reach_artifacts','reach_artifact','reach_artifact_range','reach_desktop_call'].sort());
    const nodes = await mcp.call('tools/call', { name: 'reach_nodes', arguments: {} });
    assert.deepEqual(JSON.parse(nodes.result.content[0].text).nodes.map((n: any) => n.id), JSON.parse(cliNodes.stdout).nodes.map((n: any) => n.id));
    const path = join(f.root, 'mcp-effect.txt');
    const input = { requestId: randomUUID(), nodeId: f.identity().node_id, command: { kind: 'file.write', path, contentBase64: Buffer.from('MCP real effect').toString('base64') } };
    const submitted = await mcp.call('tools/call', { name: 'reach_submit', arguments: input }); assert.notEqual(submitted.result.isError, true);
    const op = JSON.parse(submitted.result.content[0].text); assert.equal((await f.settled(op.id)).execution, 'succeeded'); assert.equal(readFileSync(path, 'utf8'), 'MCP real effect');
    const retried = await mcp.call('tools/call', { name: 'reach_submit', arguments: input }); assert.equal(JSON.parse(retried.result.content[0].text).id, op.id);
    const conflict = await mcp.call('tools/call', { name: 'reach_submit', arguments: { ...input, command: { ...input.command, contentBase64: Buffer.from('changed').toString('base64') } } }); assert.equal(conflict.result.isError, true);
    const cliResult = await f.controller(['operation', op.id]).done; assert.equal(JSON.parse(cliResult.stdout).id, op.id); assert.equal(JSON.parse(cliResult.stdout).execution, 'succeeded');
    await kill(mcp.child); assert.equal((await f.controller(['logout']).done).code, 0);
  } finally { await f.cleanup(); }
});

test('interrupted local running state must recover original receipts before re-pair after reconciliation', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.pair()).code, 0); const initial = f.identity(); const runner = f.node('run');
    const path = join(f.root, 'reconcile-effect.txt');
    const op = await f.submit({ kind: 'command.run', command: `[IO.File]::AppendAllText(${ps(path)},'once'); Start-Sleep -Seconds 90`, timeoutMs: 120000 });
    await until(async () => existsSync(path), Boolean);
    await until(async () => f.sql(db => Number(db.prepare('SELECT count(*) AS n FROM outbox WHERE acknowledged=0').get()!.n)), n => n === 0);
    await kill(runner.child); assert.equal(readFileSync(path, 'utf8'), 'once');
    await f.request(`/api/v1/nodes/${initial.node_id}/unpair`, 'POST', {});
    const observed = await f.operation(op.id);
    const reconciliationId = randomUUID();
    await f.request(`/api/v1/operations/${op.id}/reconcile`, 'POST', { reconciliationId, dispatchId: observed.dispatch_id, payloadHash: observed.payload_hash, decision: 'succeeded', evidence: 'Test independently read the original file and verified its content is exactly once.', result: { sha256: digest('once') } });
    const blocked = await f.pair(); assert.notEqual(blocked.code, 0); assert.match(blocked.stderr, /recover interrupted operations/); assert.equal(f.identity().pending_pair, null); assert.equal(f.identity().epoch, 1);
    const recover = f.node('run');
    await until(() => f.events(op.id), rows => rows.at(-1)?.kind === 'unknown');
    const exited = await recover.done; assert.notEqual(exited.code, 0); assert.match(exited.stderr, /node_unpaired/);
    assert.equal(JSON.parse((await f.operation(op.id)).result_json).reconciliationId, reconciliationId);
    const paired = await f.pair(); assert.equal(paired.code, 0, paired.stderr); assert.equal(f.identity().node_id, initial.node_id); assert.equal(f.identity().epoch, 2); assert.equal(readFileSync(path, 'utf8'), 'once');
  } finally { await f.cleanup(); }
});

test('MCP retrieves more than 2 MiB of real output in bounded consecutive pages', { timeout: 180000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.loginController()).code, 0); assert.equal((await f.pair()).code, 0); const runner = f.node('run');
    const op = await f.submit({ kind: 'command.run', command: "[Console]::Out.Write(('x' * 2400000))", timeoutMs: 120000 });
    const completed = await until(async () => { const value = await f.operation(op.id); assert.equal(runner.child.exitCode, null, JSON.stringify(runner.logs())); return value; }, value => ['succeeded', 'failed', 'unknown'].includes(value.execution), 120000);
    assert.equal(completed.execution, 'succeeded', JSON.stringify({result:completed.result_json,runner:runner.logs(),lastEvents:(await f.events(op.id)).slice(-2).map(event=>({kind:event.kind,reason:event.data.reason,dataKeys:Object.keys(event.data)}))}));
    const mcp = f.mcp(); await mcp.call('initialize');
    let after = 0, pages = 0; const content: Buffer[] = [];
    for (;;) {
      const response = await mcp.call('tools/call', { name: 'reach_events', arguments: { operationId: op.id, after, limit: 200 } });
      assert.notEqual(response.result.isError, true, JSON.stringify(response));
      const page = JSON.parse(response.result.content[0].text); pages++;
      assert.ok(Buffer.byteLength(response.result.content[0].text) < 2_097_152);
      for (const event of page.events) {
        assert.equal(event.sequence, ++after);
        if (event.data.stream === 'stdout') content.push(Buffer.from(event.data.base64, 'base64'));
      }
      assert.equal(page.nextAfter, after); if (!page.hasMore) break;
    }
    assert.ok(pages > 1); const bytes = Buffer.concat(content); assert.equal(bytes.length, 2400000); assert.equal(createHash('sha256').update(bytes).digest('hex'), digest('x'.repeat(2400000)));
  } finally { await f.cleanup(); }
});

test('service host waits unpaired, pairs and replaces binding through authenticated IPC without reopening the ledger', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    const host = f.node('host');
    await until(async () => ({ ready: existsSync(join(f.state, 'control-owner.json')), ...host.logs() }), v => v.ready || v.exitCode !== null);
    assert.equal(host.logs().exitCode, null, host.logs().stderr);
    const before = await f.node('status').done; assert.equal(before.code, 0, before.stderr);
    const original = JSON.parse(before.stdout); assert.equal(original.nodeId, null); assert.equal(original.host.foreground, true);
    const firstCode = (await f.request('/api/v1/pairing-codes', 'POST', {})).code;
    const first = await f.pair(firstCode); assert.equal(first.code, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).installationId, original.installationId);
    const repeated = await f.pair(firstCode); assert.equal(repeated.code, 0, repeated.stderr); assert.equal(JSON.parse(repeated.stdout).pairingReplay, true); assert.equal(f.identity().epoch, 1);
    const second = await f.pair(); assert.equal(second.code, 0, second.stderr); assert.equal(f.identity().epoch, 2); assert.equal(f.identity().installation_id, original.installationId);
    const oldReceipt = await f.pair(firstCode); assert.equal(oldReceipt.code, 0, oldReceipt.stderr);
    assert.equal(JSON.parse(oldReceipt.stdout).pairingReceipt.epoch, 1); assert.equal(JSON.parse(oldReceipt.stdout).epoch, 2);
    const stop = await f.node('host-stop').done; assert.equal(stop.code, 0, stop.stderr); assert.equal((await host.done).code, 0);
    const stopped = await f.node('status').done; assert.notEqual(stopped.code, 0); // no fallback to direct state access
    const restart = f.node('host');
    const status = await until(() => f.node('status').done, v => v.code === 0); assert.equal(JSON.parse(status.stdout).epoch, 2);
    assert.equal((await f.node('host-stop').done).code, 0); assert.equal((await restart.done).code, 0);
  } finally { await f.cleanup(); }
});

test('service host rejects pairing during execution and cooperatively stops the tree with an unknown receipt', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    const host = f.node('host'); await until(async () => existsSync(join(f.state, 'control-owner.json')), Boolean);
    const paired = await f.pair(); assert.equal(paired.code, 0, paired.stderr);
    const effect = join(f.root, 'service-once.txt');
    const op = await f.submit({kind:'command.run',command:`[IO.File]::AppendAllText(${ps(effect)},'once'); Start-Sleep -Seconds 90`,timeoutMs:120000});
    await until(async () => existsSync(effect), Boolean); assert.equal((await f.operation(op.id)).execution, 'running');
    const blocked = await f.pair(); assert.notEqual(blocked.code, 0); assert.match(blocked.stderr, /busy/); assert.equal(f.identity().epoch, 1); assert.equal(f.identity().pending_pair, null);
    const maintenance = await f.node('maintenance-stop').done; assert.notEqual(maintenance.code, 0); assert.match(maintenance.stderr, /busy/); assert.equal(host.logs().exitCode, null);
    const status = await f.node('status').done; assert.equal(status.code, 0, status.stderr); assert.equal(JSON.parse(status.stdout).host.phase, 1);
    const stop = await f.node('host-stop').done; assert.equal(stop.code, 0, stop.stderr); assert.equal((await host.done).code, 0);
    const local = f.sql(db => db.prepare('SELECT status FROM operations WHERE id=?').get(op.id) as {status:string}); assert.equal(local.status, 'unknown');
    const rows = f.sql(db => db.prepare('SELECT event_json FROM outbox WHERE operation_id=? ORDER BY sequence').all(op.id) as {event_json:string}[]);
    const receipt = JSON.parse(rows.at(-1)!.event_json); assert.equal(receipt.data.reason, 'host_stopping'); assert.equal(receipt.data.processTreeStopped, true);
    const restart = f.node('host'); await until(() => f.node('status').done, v => v.code === 0 && JSON.parse(v.stdout).host.pid === restart.child.pid); const settled = await f.settled(op.id); assert.equal(settled.execution, 'unknown');
    assert.equal(readFileSync(effect,'utf8'), 'once'); assert.equal((await f.node('host-stop').done).code, 0); assert.equal((await restart.done).code, 0);
  } finally { await f.cleanup(); }
});

test('service host owns pairing after IPC client disconnect and replays the durable receipt after restart', { timeout: 90000 }, async () => {
  const f = await fixture(); let release!: () => void;
  try {
    let host = f.node('host'); await until(async () => existsSync(join(f.state, 'control-owner.json')), Boolean);
    const code = (await f.request('/api/v1/pairing-codes','POST',{})).code;
    let accepted = false, calls = 0;
    const gate = new Promise<void>(resolve => {release=resolve;});
    f.intercept(async (request,response,_bytes,forward) => {
      if (request.url !== '/api/v1/node/pair') return false;
      calls++; const upstream=await forward(); const body=Buffer.from(await upstream.arrayBuffer()); accepted=true;
      await gate; response.writeHead(upstream.status, {'content-type':'application/json'}); response.end(body); return true;
    });
    const cli=f.node('pair','--server',f.origin,'--code',code,'--name','Native test','--development');
    await until(async()=>accepted,Boolean); await kill(cli.child); release();
    await until(async()=>f.identity(),v=>v.node_id && v.pending_pair===null);
    assert.equal((await f.node('host-stop').done).code,0); assert.equal((await host.done).code,0);
    host=f.node('host'); await until(()=>f.node('status').done,v=>v.code===0);
    const retried=await f.pair(code); assert.equal(retried.code,0,retried.stderr); assert.equal(JSON.parse(retried.stdout).pairingReplay,true); assert.equal(calls,1); assert.equal(f.identity().epoch,1);
    assert.equal((await f.node('host-stop').done).code,0); assert.equal((await host.done).code,0);
  } finally { release?.(); await f.cleanup(); }
});

test('control pipe rejects an unexpected server PID before transmitting pairing input', { timeout: 30000 }, async () => {
  const f=await fixture(); const name=`\\\\.\\pipe\\RY.Reach.Dev.${randomUUID()}`; let bytes=0;
  const server=createPipeServer(socket=>socket.on('data',chunk=>{bytes+=chunk.length;}));
  try {
    assert.equal((await f.node('status').done).code,0);
    server.listen(name); await once(server,'listening');
    writeFileSync(join(f.state,'control-owner.json'),JSON.stringify({pid:0,pipe:name}));
    const denied=await f.node('pair','--server',f.origin,'--code','MUST-NOT-LEAK','--development').done;
    assert.notEqual(denied.code,0); assert.match(denied.stderr,/identity mismatch/); assert.equal(bytes,0);
  } finally { server.close(); await once(server,'close'); await f.cleanup(); }
});

test('control pipe DACL rejects a Windows user outside the configured binding identity', { timeout: 30000 }, async () => {
  const f=await fixture();
  try {
    const host=f.node('host','--binding-owner','S-1-5-21-1-2-3-99999');
    await until(async()=>({ready:existsSync(join(f.state,'control-owner.json')),...host.logs()}),v=>v.ready||v.exitCode!==null);
    assert.equal(host.logs().exitCode,null,host.logs().stderr);
    const denied=await f.node('status').done; assert.notEqual(denied.code,0); assert.match(denied.stderr,/os error 5/);
    assert.equal(host.logs().exitCode,null);
  } finally { await f.cleanup(); }
});

test('service host releases execution state after a durable journal failure and can pair after reconciliation', { timeout: 90000 }, async () => {
  const f=await fixture();
  try {
    const host=f.node('host'); await until(async()=>existsSync(join(f.state,'control-owner.json')),Boolean);
    assert.equal((await f.pair()).code,0);
    f.sql(db=>db.exec("CREATE TRIGGER reject_running BEFORE INSERT ON outbox WHEN json_extract(NEW.event_json,'$.kind')='running' BEGIN SELECT RAISE(FAIL,'controlled running journal fault'); END;"));
    const effect=join(f.root,'must-not-run.txt');
    const op=await f.submit({kind:'command.run',command:`[IO.File]::WriteAllText(${ps(effect)},'wrong')`,timeoutMs:10000});
    const result=await f.settled(op.id); assert.equal(result.execution,'unknown'); assert.equal(existsSync(effect),false);
    f.sql(db=>db.exec('DROP TRIGGER reject_running;'));
    const state=await f.node('status').done; assert.equal(state.code,0,state.stderr); assert.equal(JSON.parse(state.stdout).host.phase,0);
    await f.request(`/api/v1/operations/${op.id}/reconcile`,'POST',{reconciliationId:randomUUID(),dispatchId:result.dispatch_id,payloadHash:result.payload_hash,decision:'not_executed',evidence:'Controlled journal fault occurred before worker admission; the expected effect file is absent.',result:{effectObserved:false}});
    const paired=await f.pair(); assert.equal(paired.code,0,paired.stderr); assert.equal(f.identity().epoch,2);
    assert.equal((await f.node('host-stop').done).code,0); assert.equal((await host.done).code,0);
  } finally { await f.cleanup(); }
});

test('service host handles pairing after pending recovery before issuing another old-identity poll', { timeout: 90000 }, async () => {
  const f=await fixture(); let release!:()=>void;
  try {
    assert.equal((await f.pair()).code,0); const oldSecret=f.identity().secret;
    let pending=false, oldPolls=0; const gate=new Promise<void>(resolve=>{release=resolve;});
    f.intercept(async (request,response,_bytes,forward)=>{
      if (request.url==='/api/v1/node/poll' && request.headers.authorization===`Bearer ${oldSecret}`) oldPolls++;
      if(request.url!=='/api/v1/node/pending'||pending) return false;
      const upstream=await forward(); const body=Buffer.from(await upstream.arrayBuffer()); pending=true;
      await gate; response.writeHead(upstream.status,{'content-type':'application/json'}); response.end(body); return true;
    });
    const host=f.node('host'); await until(async()=>pending,Boolean);
    const first=f.pair(); await delay(250);
    const second=await f.pair(); assert.notEqual(second.code,0); assert.match(second.stderr,/busy/);
    release(); const applied=await first; assert.equal(applied.code,0,applied.stderr); assert.equal(oldPolls,0); assert.equal(f.identity().epoch,2);
    assert.equal((await f.node('host-stop').done).code,0); assert.equal((await host.done).code,0);
  } finally {release?.(); await f.cleanup();}
});

test('service host removes unexpected explicit ACL entries from protected state and credential files', { timeout: 45000 }, async()=>{
  const f=await fixture();
  try {
    assert.equal((await f.node('status').done).code,0);
    for(const path of [f.state,join(f.state,'node.sqlite')]) {
      const granted=await launch([path,'/grant','*S-1-1-0:F'],process.env,'icacls.exe').done; assert.equal(granted.code,0,granted.stderr);
    }
    const host=f.node('host'); await until(async()=>existsSync(join(f.state,'control-owner.json')),Boolean);
    const state=await f.node('status').done; assert.equal(state.code,0,state.stderr);
    for(const path of [f.state,join(f.state,'node.sqlite')]) {
      const checked=await launch(['-NoProfile','-Command',`([System.IO.${path===f.state ? "Directory" : "File"}]::GetAccessControl(${ps(path)})).Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }`],process.env,'powershell.exe').done;
      assert.equal(checked.code,0,checked.stderr); assert.ok(!checked.stdout.includes('S-1-1-0'),checked.stdout);
    }
    assert.equal((await f.node('host-stop').done).code,0); assert.equal((await host.done).code,0);
  } finally {await f.cleanup();}
});

test('service host refuses a junction state path before changing the destination ACL', { timeout:30000 },async()=>{
  const f=await fixture();
  try {
    assert.equal((await f.node('status').done).code,0);
    const junction=join(f.root,'redirected'); symlinkSync(f.state,junction,'junction');
    const rejected=await launch(['--state-dir',junction,'host']).done;
    assert.notEqual(rejected.code,0); assert.match(rejected.stderr,/reparse point/);
  } finally {await f.cleanup();}
});

test('service host acknowledges stop during pending recovery and never starts a new poll', {timeout:60000}, async()=>{
  const f=await fixture(); let release!:()=>void;
  try {
    assert.equal((await f.pair()).code,0);
    let pending=false, polls=0; const gate=new Promise<void>(resolve=>{release=resolve;});
    f.intercept(async(request,response,_bytes,forward)=>{
      if(request.url==='/api/v1/node/poll') polls++;
      if(request.url!=='/api/v1/node/pending'||pending) return false;
      const upstream=await forward(); const body=Buffer.from(await upstream.arrayBuffer()); pending=true;
      await gate; response.writeHead(upstream.status,{'content-type':'application/json'}); response.end(body); return true;
    });
    const host=f.node('host'); await until(async()=>pending,Boolean);
    const stopping=await f.node('host-stop').done; assert.equal(stopping.code,0,stopping.stderr); assert.equal(JSON.parse(stopping.stdout).stopRequested,true);
    release(); assert.equal((await host.done).code,0); assert.equal(polls,0);
  } finally {release?.(); await f.cleanup();}
});

test('maintenance stop exits an unpaired host and preserves its installation across restart', {timeout:45000}, async()=>{
  const f=await fixture();
  try {
    let host=f.node('host'); await until(()=>f.node('status').done,v=>v.code===0 && JSON.parse(v.stdout).host?.pid===host.child.pid);
    const original=f.identity();
    const stopped=await f.node('maintenance-stop').done; assert.equal(stopped.code,0,stopped.stderr);
    const receipt=JSON.parse(stopped.stdout); assert.equal(receipt.maintenanceStopRequested,true); assert.equal(receipt.installationId,original.installation_id); assert.equal(receipt.epoch,0);
    assert.equal((await host.done).code,0);
    host=f.node('host'); await until(()=>f.node('status').done,v=>v.code===0 && JSON.parse(v.stdout).host?.pid===host.child.pid);
    assert.deepEqual(f.identity(),original); assert.equal((await f.node('host-stop').done).code,0); assert.equal((await host.done).code,0);
  } finally {await f.cleanup();}
});

test('maintenance stop waits for the pending request barrier and never issues a later poll', {timeout:60000}, async()=>{
  const f=await fixture(); let release!:()=>void;
  try {
    assert.equal((await f.pair()).code,0); const original=f.identity();
    let pending=false,polls=0,pendingCalls=0; const gate=new Promise<void>(resolve=>{release=resolve;});
    f.intercept(async(request,response,_bytes,forward)=>{
      if(request.url==='/api/v1/node/poll') polls++;
      if(request.url!=='/api/v1/node/pending') return false;
      pendingCalls++; if(pending) return false;
      const upstream=await forward(); const body=Buffer.from(await upstream.arrayBuffer()); pending=true;
      await gate; response.writeHead(upstream.status,{'content-type':'application/json'}); response.end(body); return true;
    });
    const host=f.node('host'); await until(async()=>pending,Boolean);
    const first=f.node('maintenance-stop'); await delay(250);
    const second=await f.node('maintenance-stop').done; assert.notEqual(second.code,0); assert.match(second.stderr,/busy/); assert.equal(first.logs().exitCode,null);
    release(); const stopped=await first.done; assert.equal(stopped.code,0,stopped.stderr); assert.equal(JSON.parse(stopped.stdout).maintenanceStopRequested,true);
    assert.equal((await host.done).code,0); assert.equal(polls,0); assert.equal(pendingCalls,2); assert.deepEqual(f.identity(),original);
  } finally {release?.(); await f.cleanup();}
});

test('maintenance stop refuses unacknowledged receipts without stopping the host', {timeout:60000}, async()=>{
  const f=await fixture();
  try {
    const host=f.node('host'); await until(async()=>existsSync(join(f.state,'control-owner.json')),Boolean); assert.equal((await f.pair()).code,0);
    f.intercept(async(request,response)=>{
      if(request.url!=='/api/v1/node/events') return false;
      response.writeHead(503,{'content-type':'application/json'});response.end(JSON.stringify({error:{code:'controlled_outage'}}));return true;
    });
    const effect=join(f.root,'maintenance-once.txt');
    const op=await f.submit({kind:'file.write',path:effect,contentBase64:Buffer.from('once').toString('base64')});
    await until(async()=>f.sql(db=>db.prepare('SELECT status FROM operations WHERE id=?').get(op.id)),v=>v?.status==='succeeded');
    const denied=await f.node('maintenance-stop').done; assert.notEqual(denied.code,0); assert.match(denied.stderr,/busy|receipts/); assert.equal(host.logs().exitCode,null);
    f.intercept(); assert.equal((await f.settled(op.id)).execution,'succeeded');
    await until(async()=>f.sql(db=>Number(db.prepare('SELECT count(*) AS n FROM outbox WHERE acknowledged=0').get()!.n)),n=>n===0);
    const stopped=await f.node('maintenance-stop').done;assert.equal(stopped.code,0,stopped.stderr);assert.equal((await host.done).code,0);assert.equal(readFileSync(effect,'utf8'),'once');
  } finally {await f.cleanup();}
});

test('maintenance stop refuses an unresolved remote unknown but accepts the original reconciliation', {timeout:90000}, async()=>{
  const f=await fixture();
  try {
    let host=f.node('host');await until(async()=>existsSync(join(f.state,'control-owner.json')),Boolean);assert.equal((await f.pair()).code,0);
    const original=f.identity(),effect=join(f.root,'maintenance-unknown.txt');
    const op=await f.submit({kind:'command.run',command:`[IO.File]::AppendAllText(${ps(effect)},'once'); Start-Sleep -Seconds 90`,timeoutMs:120000});
    await until(async()=>existsSync(effect),Boolean);assert.equal((await f.node('host-stop').done).code,0);assert.equal((await host.done).code,0);
    host=f.node('host');await until(()=>f.node('status').done,v=>v.code===0 && JSON.parse(v.stdout).host?.pid===host.child.pid);
    const unknown=await f.settled(op.id);assert.equal(unknown.execution,'unknown');
    await until(async()=>f.sql(db=>Number(db.prepare('SELECT count(*) AS n FROM outbox WHERE acknowledged=0').get()!.n)),n=>n===0);
    const denied=await f.node('maintenance-stop').done;assert.notEqual(denied.code,0);assert.match(denied.stderr,/reconcile original remote/);assert.equal(host.logs().exitCode,null);
    await f.request(`/api/v1/operations/${op.id}/reconcile`,'POST',{reconciliationId:randomUUID(),dispatchId:unknown.dispatch_id,payloadHash:unknown.payload_hash,decision:'succeeded',evidence:'The original file was read independently; exactly one append remains after process-tree stop.',result:{sha256:digest('once')}});
    const stopped=await f.node('maintenance-stop').done;assert.equal(stopped.code,0,stopped.stderr);assert.equal((await host.done).code,0);assert.deepEqual(f.identity(),original);assert.equal(readFileSync(effect,'utf8'),'once');
  } finally {await f.cleanup();}
});

test('maintenance stop fails closed on remote outage and leaves the original host usable', {timeout:60000}, async()=>{
  const f=await fixture();
  try {
    assert.equal((await f.pair()).code,0); const original=f.identity(); let calls=0;
    f.intercept(async(request,response)=>{
      if(request.url!=='/api/v1/node/pending') return false;calls++;
      response.writeHead(503,{'content-type':'application/json'});response.end(JSON.stringify({error:{code:'controlled_maintenance_outage'}}));return true;
    });
    const host=f.node('host');await until(async()=>calls>0,Boolean);
    const denied=await f.node('maintenance-stop').done;assert.notEqual(denied.code,0);assert.match(denied.stderr,/503/);assert.equal(host.logs().exitCode,null);
    assert.equal((await f.node('status').done).code,0); assert.deepEqual(f.identity(),original);
    f.intercept();const stopped=await f.node('maintenance-stop').done;assert.equal(stopped.code,0,stopped.stderr);assert.equal((await host.done).code,0);
  } finally {await f.cleanup();}
});
