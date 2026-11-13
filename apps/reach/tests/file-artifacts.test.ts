// Copyright (c) Ray Zhang. Preserve old request identities and gate new file evidence semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { commandSchema } from '../src/contracts/protocol.ts';
import { digest } from '../src/service/store.ts';
import { fixture } from './service-fixture.ts';
test('old inline requests keep identity; artifact and version requests require the new capability', async () => {
  const f = await fixture();
  try {
    const old = { kind: 'file.read', path: 'old-file.bin', offset: 0, length: 1048576 };
    assert.deepEqual(commandSchema.parse(old), old);
    const input = { requestId: randomUUID(), nodeId: f.nodeId, command: old };
    const first = await f.api('/api/v1/operations', 'POST', input, f.token); assert.equal(first.status, 201);
    assert.equal(first.data.payload_hash, digest({ nodeId: f.nodeId, epoch: 1, command: old }));
    for (const extension of [{ resultFormat: 'artifact' }, { expectedFileVersion: 'a'.repeat(64) }]) {
      const r = await f.api('/api/v1/operations', 'POST', { ...input, requestId: randomUUID(), command: { ...old, ...extension } }, f.token);
      assert.equal(r.status, 409); assert.equal(r.data.error.code, 'capability_unavailable');
    }
    await f.api('/api/v1/node/poll', 'POST', { version: 'legacy-offline', capabilities: [] }, f.installationSecret);
    const retry = await f.api('/api/v1/operations', 'POST', input, f.token); assert.equal(retry.status, 201); assert.equal(retry.data.id, first.data.id);
    await f.api('/api/v1/node/poll', 'POST', { version: 'evidence-node', capabilities: ['file.read', 'file.read.artifact'] }, f.installationSecret);
    const next = await f.api('/api/v1/operations', 'POST', { ...input, requestId: randomUUID(), command: { ...old, resultFormat: 'artifact', expectedFileVersion: 'a'.repeat(64) } }, f.token);
    assert.equal(next.status, 201); assert.equal(JSON.parse(next.data.command_json).expectedFileVersion, 'a'.repeat(64));
  } finally { await f.cleanup(); }
});
test('a downgraded poll cannot claim queued extended reads and does not block compatible work', async()=>{
  const f=await fixture();
  try{
    const hello=(capabilities:string[])=>f.api('/api/v1/node/poll','POST',{version:'capability-transition',capabilities},f.installationSecret);
    await hello(['file.read','file.read.artifact']);
    const enqueue=async(extension:object)=>{
      const r=await f.api('/api/v1/operations','POST',{requestId:randomUUID(),nodeId:f.nodeId,command:{kind:'file.read',path:'queued-file',...extension}},f.token);
      assert.equal(r.status,201);return r.data;
    };
    const artifact=await enqueue({resultFormat:'artifact'}), guarded=await enqueue({expectedFileVersion:'b'.repeat(64)});
    const legacy=await enqueue({});
    const claimed=await hello(['file.read']);assert.equal(claimed.data.operation.operationId,legacy.id);
    assert.equal((await hello(['file.read'])).data.operation,null);
    for(const op of [artifact,guarded]){const r=await f.api(`/api/v1/operations/${op.id}`,'GET',undefined,f.token);assert.equal(r.data.delivery,'queued');assert.equal(r.data.execution,'not_observed');}
    const recovered=[];for(let i=0;i<2;i++)recovered.push((await hello(['file.read','file.read.artifact'])).data.operation.operationId);
    assert.deepEqual(recovered.sort(),[artifact.id,guarded.id].sort());
  }finally{await f.cleanup();}
});
