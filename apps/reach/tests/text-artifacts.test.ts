// Copyright (c) Ray Zhang. Exact UTF-8/binary evidence through the HTTP ledger and MCP consumer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { fixture } from './service-fixture.ts';
import { ReachClient } from '../src/controller/client.ts';
import { downloadArtifact, readArtifactRange } from '../src/controller/artifacts.ts';
import { invoke } from '../src/controller/mcp.ts';
import { ArtifactReader, parseArtifacts } from '../src/admin/artifacts.ts';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function setup() {
  const f = await fixture(); const { operation } = await f.enqueue();
  const dispatch = (await f.api('/api/v1/node/poll', 'POST', { version: 'test', capabilities: ['command.run'] }, f.installationSecret)).data.operation;
  let sequence = 0;
  const post = (kind: string, data: any) => f.api('/api/v1/node/events', 'POST', { eventId: randomUUID(), operationId: operation.id, dispatchId: dispatch.dispatchId, payloadHash: dispatch.payloadHash, sequence: sequence + 1, kind, data }, f.installationSecret);
  const accept = async (kind: string, data: any) => { const r = await post(kind, data); assert.equal(r.status, 200, JSON.stringify(r.data)); sequence++; };
  await accept('received', {}); await accept('running', {});
  const client = { request: async (route: string) => { const r = await f.api(route, 'GET', undefined, f.token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; } } as ReachClient;
  async function upload(bytes: Buffer, index: number, mime: 'text/plain' | 'image/png' | 'application/octet-stream') {
    const artifactId = randomUUID();
    const info = { type: 'artifact.manifest', artifactId, version: mime === 'image/png' ? 1 : 2, mimeType: mime, byteLength: bytes.length, sha256: hash(bytes), contentIndex: index, chunkBytes: 65536, chunkCount: Math.ceil(bytes.length / 65536),
      ...(mime === 'text/plain' ? { encoding: 'utf-8', characterCount: [...bytes.toString('utf8')].length } : mime === 'image/png' ? { width: 2, height: 1 } : {}) };
    await accept('output', info);
    for (let i = 0; i < info.chunkCount; i++) { const b = bytes.subarray(i * 65536, (i + 1) * 65536); await accept('output', { type: 'artifact.chunk', artifactId, index: i, dataBase64: b.toString('base64'), sha256: hash(b) }); }
    return { info, ref: { type: 'artifact', artifactId, mimeType: mime, sha256: info.sha256, contentIndex: index } };
  }
  return { ...f, operation, client, post, accept, upload };
}

test('full Unicode text plus four PNGs retain original bytes, strict references and bounded MCP ranges', async () => {
  const f = await setup();
  try {
    const text = '\uFEFF' + '中文😀e\u0301\r\n'.repeat(18000); const bytes = Buffer.from(text);
    const original = await f.upload(bytes, 0, 'text/plain'); await f.accept('output', { type: 'artifact.complete', artifactId: original.ref.artifactId });
    const image = new PNG({ width: 2, height: 1 }); image.data.fill(255); const png = PNG.sync.write(image);
    const images = [];
    for (let i = 1; i <= 4; i++) { const value = await f.upload(png, i, 'image/png'); await f.accept('output', { type: 'artifact.complete', artifactId: value.ref.artifactId }); images.push(value.ref); }
    const refs = [original.ref, ...images];
    assert.equal((await f.post('succeeded', { content: refs, images: refs, artifacts: refs })).status, 409);
    const wrong = [{ ...original.ref, mimeType: 'image/png' }, ...images];
    assert.equal((await f.post('unknown', { content: wrong, images: wrong, artifacts: wrong })).status, 409);
    await f.accept('unknown', { content: refs, images, artifacts: refs, effectsMayHaveOccurred: true });
    assert.deepEqual((await downloadArtifact(f.client, f.operation.id, original.ref.artifactId)).bytes, bytes);
    const browserList = parseArtifacts(await f.client.request(`/api/v1/operations/${f.operation.id}/artifacts`), f.operation.id);
    const reader = new ArtifactReader(path => f.client.request(`/api/v1${path}`), browserList.binding, browserList.artifacts[0]);
    let preview = ''; let eof = false;
    while (!eof) { const page = await reader.next(); preview += page.text; eof = page.eof; }
    assert.equal(preview, text); assert.deepEqual(Buffer.from(await reader.download()), bytes);
    const split = await readArtifactRange(f.client, f.operation.id, original.ref.artifactId, 4, 2);
    assert.equal(split.text, undefined); assert.deepEqual(Buffer.from(split.dataBase64, 'base64'), bytes.subarray(4, 6));
    const reply: any = await invoke(f.client, 'reach_artifact', { operationId: f.operation.id, artifactId: original.ref.artifactId });
    const range = JSON.parse(reply.content[0].text); assert.equal(range.length, 65536); assert.equal(range.nextOffset, 65536); assert.equal(range.eof, false);
    assert.equal(range.manifest.characterCount, [...text].length);
    const imageReply: any = await invoke(f.client, 'reach_artifact', { operationId: f.operation.id, artifactId: images[0].artifactId });
    assert.equal(imageReply.content[1].type, 'image'); assert.deepEqual(Buffer.from(imageReply.content[1].data, 'base64'), png);
    assert.equal((await f.client.request(`/api/v1/operations/${f.operation.id}`)).execution, 'unknown');
  } finally { await f.cleanup(); }
});

test('empty and binary files are exact, while invalid UTF-8 cannot complete a text artifact', async () => {
  const f = await setup();
  try {
    const empty = await f.upload(Buffer.alloc(0), 0, 'application/octet-stream'); await f.accept('output', { type: 'artifact.complete', artifactId: empty.ref.artifactId });
    assert.equal((await downloadArtifact(f.client, f.operation.id, empty.ref.artifactId)).bytes.length, 0);
    const range = await readArtifactRange(f.client, f.operation.id, empty.ref.artifactId); assert.equal(range.eof, true); assert.equal(range.dataBase64, ''); assert.equal(range.sha256, hash(Buffer.alloc(0)));
    const bytes = Buffer.from([0, 255, 128, 13, 10, 0]); const binary = await f.upload(bytes, 1, 'application/octet-stream'); await f.accept('output', { type: 'artifact.complete', artifactId: binary.ref.artifactId });
    assert.deepEqual((await downloadArtifact(f.client, f.operation.id, binary.ref.artifactId)).bytes, bytes);
    const invalid = await f.upload(Buffer.from([0xff]), 2, 'text/plain'); assert.equal((await f.post('output', { type: 'artifact.complete', artifactId: invalid.ref.artifactId })).status, 409);
    assert.equal((await f.post('succeeded', { content: [empty.ref, binary.ref], artifacts: [empty.ref, binary.ref] })).status, 409);
    await f.accept('failed', { content: [empty.ref, binary.ref], artifacts: [empty.ref, binary.ref], reason: 'invalid_original_text' });
  } finally { await f.cleanup(); }
});
