// Copyright (c) Ray Zhang. Browser evidence consumer: stale pages, corrupted responses and bounded previews.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ArtifactReader, parseArtifacts, digest } from '../src/admin/artifacts.ts';

async function source(bytes: Uint8Array, mimeType = 'text/plain') {
  const operationId = randomUUID();
  const binding = { operationId, nodeId: randomUUID(), epoch: 1, dispatchId: randomUUID(), payloadHash: 'a'.repeat(64) };
  const manifest = { type: 'artifact.manifest', artifactId: randomUUID(), version: 2, mimeType, byteLength: bytes.length, sha256: await digest(bytes), contentIndex: 0,
    chunkBytes: 65536, chunkCount: Math.ceil(bytes.length / 65536), ...(mimeType === 'text/plain' ? { encoding: 'utf-8', characterCount: [...new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)].length } : {}) };
  const raw = { binding, artifacts: [{ ...manifest, complete: true }] };
  const list = parseArtifacts(raw, operationId);
  const response = async (path: string) => {
    const offset = Number(new URL(path, 'http://localhost').searchParams.get('offset')); const part = bytes.slice(offset, offset + 65536);
    return { binding, manifest, offset, length: part.length, nextOffset: offset + part.length, eof: offset + part.length === bytes.length, dataBase64: Buffer.from(part).toString('base64'), sha256: await digest(part) };
  };
  return { raw, list, response, reader: (request = response, current?: () => boolean) => new ArtifactReader(request, list.binding, list.artifacts[0], current) };
}
test('browser previews UTF-8 across chunk boundaries and keeps BOM, CRLF, empty text and binary downloads exact', async () => {
  const text = '\uFEFF' + 'a'.repeat(65530) + '😀中文e\u0301\r\n'.repeat(4000);
  const bytes = new TextEncoder().encode(text), f = await source(bytes), reader = f.reader();
  let preview = '', eof = false;
  while (!eof) { const page = await reader.next(); preview += page.text; eof = page.eof; }
  assert.equal(preview, text); assert.deepEqual(await reader.download(), bytes);
  const empty = (await source(new Uint8Array())).reader(); assert.deepEqual(await empty.next(), { text: '', offset: 0, nextOffset: 0, eof: true });
  assert.equal((await empty.download()).length, 0);
  const binary = new Uint8Array([0, 255, 128, 13, 10]); assert.deepEqual(await (await source(binary, 'application/octet-stream')).reader().download(), binary);
});
test('browser rejects incomplete, foreign, changed, corrupt and malformed artifact evidence', async () => {
  const f = await source(new TextEncoder().encode('original'));
  assert.throws(() => parseArtifacts(f.raw, randomUUID()), /身份/);
  assert.throws(() => parseArtifacts({ ...f.raw, artifacts: [f.raw.artifacts[0], f.raw.artifacts[0]] }, f.raw.binding.operationId), /冲突/);
  assert.throws(() => new ArtifactReader(f.response, f.list.binding, { ...f.list.artifacts[0], complete: false }), /未完整收到/);
  for (const mutate of [
    (v: any) => { v.binding = { ...v.binding, epoch: 2 }; },
    (v: any) => { v.manifest = { ...v.manifest, mimeType: 'application/octet-stream' }; },
    (v: any) => { v.dataBase64 += '\n'; },
    (v: any) => { v.sha256 = 'b'.repeat(64); },
    (v: any) => { v.nextOffset++; },
    (v: any) => { v.eof = false; },
    async (v: any) => { const bytes = new TextEncoder().encode('replaced'); v.dataBase64 = Buffer.from(bytes).toString('base64'); v.sha256 = await digest(bytes); },
  ]) {
    const reader = f.reader(async path => { const value = await f.response(path); await mutate(value); return value; });
    await assert.rejects(reader.download()); await assert.rejects(reader.download());
  }
  const wrongCount = { ...f.list.artifacts[0], characterCount: 2 };
  const badText = new ArtifactReader(async path => { const v = await f.response(path); return { ...v, manifest: { ...v.manifest, characterCount: 2 } }; }, f.list.binding, wrongCount);
  await assert.rejects(badText.download(), /字符数/);
  const invalid = await source(new Uint8Array([255])); await assert.rejects(invalid.reader().download(), /encoded data/);
});
test('browser stops in-flight old-view results before preview or download and permits no overlapping reads', async () => {
  const f = await source(new TextEncoder().encode('old detail'));
  let current = true, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reader = f.reader(async path => { await held; return f.response(path); }, () => current);
  const pending = reader.next(); await assert.rejects(reader.next(), /正在进行/);
  current = false; release(); await assert.rejects(pending, /页面已切换/); await assert.rejects(reader.download(), /页面已切换/);
});
