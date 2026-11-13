// Copyright (c) Ray Zhang. Original bytes, HTTP identity, partial upload and decoder faults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { ReachStore } from '../src/service/store.ts';
import { ReachClient } from '../src/controller/client.ts';
import { downloadArtifact, validatePng } from '../src/controller/artifacts.ts';
import { desktopCallSchema } from '../src/contracts/protocol.ts';
import { fixture, password } from './service-fixture.ts';

const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
test('HTTP artifacts bind to original operation, survive reopen, reject corrupt/duplicate chunks and forged references', async () => {
  const f = await fixture();
  try {
    const { operation } = await f.enqueue();
    const dispatch = (await f.api('/api/v1/node/poll', 'POST', { version:'test', capabilities:['command.run'] }, f.installationSecret)).data.operation;
    let seq = 0;
    const event = (kind: string, data: any) => ({eventId:randomUUID(),operationId:operation.id,dispatchId:dispatch.dispatchId,payloadHash:dispatch.payloadHash,sequence:seq+1,kind,data});
    const post = (e: any) => f.api('/api/v1/node/events','POST',e,f.installationSecret);
    async function accept(kind: string, data: any) { const e=event(kind,data); const r=await post(e); assert.equal(r.status,200,JSON.stringify(r.data));seq++;return e; }
    await accept('received',{}); await accept('running',{});
    const png=new PNG({width:200,height:180}); for(let i=0;i<png.data.length;i++)png.data[i]=(i*17+i%239)%256;
    const bytes=PNG.sync.write(png,{deflateLevel:0}); assert.ok(bytes.length>65536);
    const artifactId=randomUUID(), count=Math.ceil(bytes.length/65536);
    const info={type:'artifact.manifest',version:1,artifactId,mimeType:'image/png',byteLength:bytes.length,sha256:hash(bytes),width:200,height:180,contentIndex:0,chunkBytes:65536,chunkCount:count};
    await accept('output',info);
    assert.equal((await post(event('output',{...info,artifactId:randomUUID()}))).status,409);
    const get = (token=f.token) => f.api(`/api/v1/operations/${operation.id}/artifacts/${artifactId}`,'GET',undefined,token);
    assert.equal((await get()).status,409);
    assert.equal((await post(event('output',{type:'artifact.complete',artifactId}))).status,409);
    const block=(index:number)=>{const b=bytes.subarray(index*65536,(index+1)*65536);return {type:'artifact.chunk',artifactId,index,dataBase64:b.toString('base64'),sha256:hash(b)};};
    assert.equal((await post(event('output',block(1)))).status,409);
    assert.equal((await post(event('output',{...block(0),dataBase64:'????'}))).status,400);
    assert.equal((await post(event('output',{...block(0),sha256:'0'.repeat(64)}))).status,409);
    const first=await accept('output',block(0));
    assert.equal((await post(first)).data.duplicate,true);
    assert.equal((await post(event('output',block(0)))).status,409);
    await f.reopen();const reopened=f.store;
    assert.equal(reopened.artifacts(reopened.session(f.token).id,operation.id).artifacts[0].complete,false);
    for(let i=1;i<count;i++)await accept('output',block(i));
    await accept('output',{type:'artifact.complete',artifactId});
    assert.equal((await post(event('succeeded',{content:[],images:[]}))).status,409);
    const ref={type:'artifact',artifactId,mimeType:'image/png',sha256:info.sha256,contentIndex:0};
    assert.equal((await post(event('succeeded',{content:[{...ref,artifactId:randomUUID()}],images:[ref]}))).status,409);
    // Fully uploaded evidence remains readable even when the operation outcome is unknown.
    await accept('unknown',{content:[ref],images:[ref],effectsMayHaveOccurred:true});
    const original=await get();assert.equal(original.status,200);
    const adapter={request:async(route:string)=>{const result=await f.api(route,'GET',undefined,f.token);assert.equal(result.status,200);return result.data;}} as ReachClient;
    assert.deepEqual((await downloadArtifact(adapter,operation.id,artifactId)).bytes,bytes);
    f.store.db.prepare('INSERT INTO users SELECT ?,?,salt,password_hash FROM users LIMIT 1').run(randomUUID(),'other-account');
    const login=await f.api('/api/v1/auth/login','POST',{username:'other-account',password});assert.equal(login.status,200);
    const other=login.data.token;assert.ok(other);
    assert.equal((await get(other)).status,404);
    assert.equal((await f.api(`/api/v1/operations/${operation.id}/artifacts`,'GET',undefined,other)).status,404);
    // A damaged persisted block cannot be served as a new valid range/hash.
    const saved=f.store.db.prepare("SELECT sequence,data_json FROM operation_events WHERE operation_id=? AND json_extract(data_json,'$.type')='artifact.chunk' LIMIT 1").get(operation.id)!;
    const damaged=JSON.parse(saved.data_json as string);damaged.dataBase64=Buffer.alloc(65536).toString('base64');
    f.store.db.prepare('UPDATE operation_events SET data_json=? WHERE operation_id=? AND sequence=?').run(JSON.stringify(damaged),operation.id,saved.sequence!);
    assert.equal((await get()).status,409);
  } finally { await f.cleanup(); }
});

test('PNG decoding rejects second IHDR, interlaced and truncated input before inflate',()=>{
  const image=new PNG({width:2,height:1});image.data.fill(255);const bytes=PNG.sync.write(image);
  validatePng(bytes,2,1);
  const duplicate=Buffer.concat([bytes.subarray(0,33),bytes.subarray(8,33),bytes.subarray(33)]);
  assert.throws(()=>validatePng(duplicate,2,1),/header/);
  const interlaced=Buffer.from(bytes);interlaced[28]=1;
  assert.throws(()=>validatePng(interlaced,2,1),/interlacing/);
  const palette=Buffer.alloc(783);palette.writeUInt32BE(771);palette.write('PLTE',4);
  assert.throws(()=>validatePng(Buffer.concat([bytes.subarray(0,33),palette,bytes.subarray(33)]),2,1),/palette/);
  assert.throws(()=>validatePng(bytes.subarray(0,bytes.length-6),2,1),/Truncated|bounds/);
});

test('argumentsJson preserves Unicode key order and exponent spelling, rejects invalid numbers and Unicode',()=>{
  const base={kind:'desktop.call',tool:'Screenshot',helperGeneration:randomUUID(),sessionRef:{sessionId:1,userSid:'S-1-5-21-1',logonId:'00000000:00000001',windowStation:'WinSta0',desktop:'Default'}};
  const text=' {"😀":{"中":1e-6,"𐀀":[1e21,0.00000001],"\\ue000":"原文"}} ';
  assert.equal(desktopCallSchema.parse({...base,argumentsJson:text}).argumentsJson,text);
  for(const argumentsJson of ['{"a":1e999}','{"a":"\\ud800"}','[]','null']) assert.equal(desktopCallSchema.safeParse({...base,argumentsJson}).success,false);
});
