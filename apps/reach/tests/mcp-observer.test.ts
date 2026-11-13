// Copyright (c) Ray Zhang. Exercise the real observer without model calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';

test('observer forwards original replies and refuses the seventh model call', { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'reach-observer-'));
  const backend = join(root, 'backend.mjs'), observed = join(root, 'observer.jsonl'), forwarded = join(root, 'forwarded.jsonl');
  const bytes = Buffer.from('opaque image test bytes'), base64 = bytes.toString('base64');
  writeFileSync(backend, `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
const input=createInterface({input:process.stdin});input.on('line',line=>{appendFileSync(${JSON.stringify(forwarded)},line+'\\n');const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{isError:false,content:[{type:'image',mimeType:'image/png',data:${JSON.stringify(base64)}}]}})+'\\n');});`);
  const child = spawn(process.execPath, [resolve('tests/fixtures/mcp-observer.ts'), backend, observed], { windowsHide: true, stdio: 'pipe' });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => stdout += value);
  child.stderr.on('data', value => stderr += value);
  const stopped = once(child, 'exit');
  const abort = () => child.kill();
  t.signal.addEventListener('abort', abort, { once: true });
  try {
    const requests = [{ jsonrpc: '2.0', method: 'notifications/initialized' }, ...Array.from({ length: 7 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'reach_artifact', arguments: { operationId: 'original-operation', artifactId: 'original-image' } } }))];
    child.stdin.end(requests.map(value => JSON.stringify(value)).join('\n') + '\n');
    const [code] = await stopped; assert.equal(code, 0, stderr);
    const replies = stdout.trim().split('\n').map(value => JSON.parse(value));
    assert.equal(replies.length, 7);
    for (let id = 1; id <= 6; id++) assert.deepEqual(replies.find(value => value.id === id)?.result, { isError: false, content: [{ type: 'image', mimeType: 'image/png', data: base64 }] });
    assert.equal(replies.find(value => value.id === 7)?.result.isError, true);
    const downstream = readFileSync(forwarded, 'utf8').trim().split('\n').map(value => JSON.parse(value));
    assert.deepEqual(downstream, requests.slice(0, 7));
    const records = readFileSync(observed, 'utf8').trim().split('\n').map(value => JSON.parse(value));
    assert.equal(records.filter(value => value.event === 'call').length, 6);
    assert.deepEqual(records.find(value => value.event === 'call_budget_exceeded'), { event: 'call_budget_exceeded', attempted: 7, forwarded: 6 });
    const images = records.filter(value => value.event === 'reply').flatMap(value => value.images);
    assert.equal(images.length, 6);
    assert.ok(images.every(value => value.bytes === bytes.length && value.sha256 === createHash('sha256').update(bytes).digest('hex')));
  } finally {
    t.signal.removeEventListener('abort', abort);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await stopped; }
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('reach-observer-'));
    rmSync(root, { recursive: true, force: true });
  }
});
