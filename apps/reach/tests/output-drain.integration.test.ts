// Copyright (c) Ray Zhang. Native command pipes, actual descendants and retained receipts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, until, ps } from './native-fixture.ts';

async function retained(name: string) {
  const root = resolve('work', `output-drain-${name}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const f = await fixture('', process.env, root);
  assert.equal((await f.pair()).code, 0);
  f.node('run');
  return f;
}
async function evidence(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const operation = await f.operation(id), events = await f.events(id);
  await writeFile(join(f.root, 'receipt.json'), JSON.stringify({ operation, events }, null, 2));
  return { operation, events };
}

test('an exited shell with inherited idle output pipes is unknown and the real descendant is reaped', { timeout: 60000 }, async () => {
  const f = await retained('idle');
  try {
    const started = join(f.root, 'descendant.started'), effect = join(f.root, 'descendant.effect'), pidPath = join(f.root, 'descendant.pid');
    const childScript = `[Console]::Out.WriteLine('child-started'); [Console]::Out.Flush(); [IO.File]::WriteAllText(${ps(started)},'ready'); Start-Sleep -Seconds 30; [IO.File]::WriteAllText(${ps(effect)},'escaped')`;
    const encoded = Buffer.from(childScript, 'utf16le').toString('base64');
    const command = `& ${ps(resolve('tests/output-drain-descendant.ps1'))} -EncodedCommand ${ps(encoded)} -PidPath ${ps(pidPath)} -StartedPath ${ps(started)}`;
    const op = await f.submit({ kind: 'command.run', command, timeoutMs: 20000 });
    const result = await f.settled(op.id);
    assert.equal(result.execution, 'unknown');
    const receipt = JSON.parse(result.result_json);
    assert.equal(receipt.reason, 'output_drain_stalled');
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.outputComplete, false);
    assert.equal(receipt.processTreeStopped, true);
    assert.equal(await readFile(started, 'utf8'), 'ready');
    const childPid = Number(await readFile(pidPath, 'utf8'));
    assert.ok(childPid > 0); assert.throws(() => process.kill(childPid, 0));
    assert.equal(existsSync(effect), false);
    const { events } = await evidence(f, op.id);
    const output = events.filter(e => e.data.stream === 'stdout').map(e => Buffer.from(e.data.base64, 'base64').toString()).join('');
    assert.match(output, /child-started/); assert.match(output, /parent-exiting/);
  } finally { await f.cleanup(); }
});

test('both output streams drain completely and preserve the command failure exit code', { timeout: 60000 }, async () => {
  const f = await retained('two-streams');
  try {
    const op = await f.submit({ kind: 'command.run', command: "[Console]::Out.Write(('O' * 32768)); [Console]::Error.Write(('E' * 32768)); exit 7", timeoutMs: 30000 });
    const result = await f.settled(op.id);
    assert.equal(result.execution, 'failed'); assert.equal(JSON.parse(result.result_json).exitCode, 7);
    assert.equal(JSON.parse(result.result_json).processTreeStopped, true);
    const { events } = await evidence(f, op.id);
    for (const [stream, char] of [['stdout', 'O'], ['stderr', 'E']]) {
      const bytes = Buffer.concat(events.filter(e => e.data.stream === stream).map(e => Buffer.from(e.data.base64, 'base64')));
      assert.deepEqual(bytes, Buffer.from(char.repeat(32768)));
    }
  } finally { await f.cleanup(); }
});

test('continuously streaming output remains bounded by the original Node deadline', { timeout: 60000 }, async () => {
  const f = await retained('deadline');
  try {
    const pidPath = join(f.root, 'command.pid');
    const op = await f.submit({ kind: 'command.run', command: `[IO.File]::WriteAllText(${ps(pidPath)},[string]$PID); while($true){[Console]::Out.Write('tick'); Start-Sleep -Milliseconds 150}`, timeoutMs: 4000 });
    await until(async () => (await f.events(op.id)).some(e => e.data.stream === 'stdout'), Boolean);
    assert.equal((await f.operation(op.id)).execution, 'running');
    const result = await f.settled(op.id), receipt = JSON.parse(result.result_json);
    assert.equal(result.execution, 'unknown'); assert.equal(receipt.reason, 'deadline_exceeded'); assert.equal(receipt.processTreeStopped, true);
    const commandPid = Number(await readFile(pidPath, 'utf8')); assert.ok(commandPid > 0); assert.throws(() => process.kill(commandPid, 0));
    await evidence(f, op.id);
  } finally { await f.cleanup(); }
});

test('cancelling a large active output stops the real process and retains the single original effect', { timeout: 90000 }, async () => {
  const f = await retained('cancel');
  try {
    const pidPath = join(f.root, 'command.pid'), effect = join(f.root, 'effect.txt'), ended = join(f.root, 'ended.txt');
    const op = await f.submit({ kind: 'command.run', command: `[IO.File]::WriteAllText(${ps(pidPath)},[string]$PID); [IO.File]::AppendAllText(${ps(effect)},'once'); [Console]::Out.Write(('x' * 8000000)); [IO.File]::WriteAllText(${ps(ended)},'ended')`, timeoutMs: 60000 });
    await until(async () => f.sql(db => Number((db.prepare("SELECT count(*) AS n FROM outbox WHERE operation_id=? AND event_json LIKE '%base64%'").get(op.id) as { n: number }).n)), n => n >= 8);
    const commandPid = Number(await readFile(pidPath, 'utf8')); assert.ok(commandPid > 0); process.kill(commandPid, 0);
    assert.equal(existsSync(ended), false);
    await f.request(`/api/v1/operations/${op.id}/cancel`, 'POST', {});
    const result = await f.settled(op.id), receipt = JSON.parse(result.result_json);
    assert.equal(result.execution, 'unknown'); assert.equal(receipt.reason, 'cancel_requested_or_control_lost');
    assert.equal(receipt.processTreeStopped, true); assert.throws(() => process.kill(commandPid, 0));
    assert.equal(await readFile(effect, 'utf8'), 'once'); assert.equal(existsSync(ended), false);
    await evidence(f, op.id);
  } finally { await f.cleanup(); }
});

test('stdout and stderr share the original 16 MiB cap and persist output_limit before remote upload completes', { timeout: 650000 }, async () => {
  const f = await retained('limit');
  try {
    // This exercises the byte cap, independently of the 4-second deadline case.
    // Full synchronous SQLite persistence can take several minutes on this host.
    const op = await f.submit({ kind: 'command.run', command: "[Console]::Out.Write(('O' * 9437184)); [Console]::Error.Write(('E' * 9437184))", timeoutMs: 600000 });
    const local = await until(async () => f.sql(db => db.prepare('SELECT status FROM operations WHERE id=?').get(op.id) as { status: string } | undefined), row => !!row && ['unknown', 'failed', 'succeeded'].includes(row.status), 610000);
    assert.equal(local!.status, 'unknown');
    const rows = f.sql(db => db.prepare('SELECT event_json FROM outbox WHERE operation_id=? ORDER BY sequence').all(op.id) as { event_json: string }[]);
    const frames = rows.map(row => JSON.parse(row.event_json));
    const terminal = frames.at(-1);
    assert.equal(terminal.kind, 'unknown'); assert.equal(terminal.data.reason, 'output_limit'); assert.equal(terminal.data.processTreeStopped, true);
    const bytes = { stdout: 0, stderr: 0 };
    for (const frame of frames) if (frame.data.stream in bytes) bytes[frame.data.stream as keyof typeof bytes] += Buffer.from(frame.data.base64, 'base64').length;
    assert.equal(bytes.stdout, 9437184); assert.ok(bytes.stderr > 0);
    assert.ok(bytes.stdout + bytes.stderr <= 16 * 1024 * 1024); assert.ok(bytes.stdout + bytes.stderr > 16 * 1024 * 1024 - 8192);
    const commandPid = frames.find(frame => frame.data.processStarted)?.data.pid; assert.ok(commandPid > 0); assert.throws(() => process.kill(commandPid, 0));
    await writeFile(join(f.root, 'receipt.json'), JSON.stringify({ local, terminal, bytes, events: frames.length, remoteUploadCompletionTested: false }, null, 2));
  } finally { await f.cleanup(); }
});
