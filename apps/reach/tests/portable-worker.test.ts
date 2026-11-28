// Copyright (c) Ray Zhang. Exercise the executable extracted from a native preview archive.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, until } from './native-fixture.ts';

test('portable Worker pairs, comes online, runs a command and returns file receipts', { timeout: 60_000 }, async () => {
  const f = await fixture('/reach');
  try {
    const pair = await f.pair();
    assert.equal(pair.code, 0, pair.stderr);
    const id = f.identity().node_id;
    f.node('run');
    const list = (): Promise<{ nodes: { id: string; last_seen: number | null; platform: string; capabilities: string[] }[] }> =>
      f.request('/api/v1/nodes');
    const online = await until(list, value => value.nodes.some(
      node => node.id === id && node.last_seen && node.capabilities.includes('command.run'),
    ));
    const node = online.nodes.find(node => node.id === id);
    assert.ok(node);
    assert.equal(node.platform, process.platform);
    assert.ok(!node.capabilities.includes('agent.delegate'));
    assert.ok(!node.capabilities.some((capability: string) => capability.startsWith('desktop.')));

    const command = await f.submit({ kind: 'command.run', command: 'printf "%s" worker-ok > command.txt', cwd: f.root });
    assert.equal((await f.settled(command.id)).execution, 'succeeded');
    assert.equal(readFileSync(join(f.root, 'command.txt'), 'utf8'), 'worker-ok');

    const file = join(f.root, '文件.txt');
    const contentBase64 = Buffer.from('Reach Worker').toString('base64');
    const write = await f.submit({ kind: 'file.write', path: file, contentBase64 });
    assert.equal((await f.settled(write.id)).execution, 'succeeded');
    const read = await f.submit({ kind: 'file.read', path: file, offset: 0, length: 128 });
    const receipt = await f.settled(read.id);
    assert.equal(receipt.execution, 'succeeded');
    assert.equal(JSON.parse(receipt.result_json).contentBase64, contentBase64);
  } finally {
    await f.cleanup();
  }
});
