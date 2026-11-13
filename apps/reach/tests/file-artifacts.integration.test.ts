// Copyright (c) Ray Zhang. Real Windows file captures and original receipts survive transport/source loss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, statSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fixture, until, kill } from './native-fixture.ts';
const evidence = resolve('work/file-artifacts-' + randomUUID()); mkdirSync(evidence, { recursive: true });
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function setup(name: string) {
  const root = join(evidence, name); mkdirSync(root, { recursive: true });
  const f = await fixture('', process.env, root);
  assert.equal((await f.pair()).code, 0); assert.equal((await f.loginController()).code, 0);
  let runner = f.node('run');
  await until(() => f.request('/api/v1/nodes'), v => v.nodes[0]?.capabilities.includes('file.read.artifact'));
  return { ...f, runner: () => runner, restart: async () => { await kill(runner.child); runner = f.node('run'); } };
}
async function download(f: Awaited<ReturnType<typeof setup>>, operationId: string, artifactId: string, name: string) {
  const file = join(f.root, name);
  const result = await f.controller(['artifact', operationId, artifactId, '--output', file]).done;
  assert.equal(result.code, 0, JSON.stringify(result)); return readFileSync(file);
}
test('binary capture survives lost ACK, source deletion and both processes restarting; inline 1 MiB remains compatible', { timeout: 120000 }, async () => {
  const f = await setup('recovery');
  try {
    const bytes = Buffer.alloc(2400000); for (let i=0;i<bytes.length;i++) bytes[i]=(i*31+7)%256;
    const source = join(f.root, '分段 二进制.bin'); writeFileSync(source, bytes);
    const plain = await f.submit({ kind: 'file.read', path: source, length: 1048576 }); const plainDone = await f.settled(plain.id);
    assert.equal(plainDone.execution, 'succeeded'); const inline = JSON.parse(plainDone.result_json);
    assert.deepEqual(Buffer.from(inline.contentBase64, 'base64'), bytes.subarray(0,1048576)); assert.equal(inline.artifacts, undefined);
    let dropped = false;
    f.intercept(async (request,response,payload,forward) => {
      if (request.url !== '/api/v1/node/events' || JSON.parse(payload.toString()).data?.type !== 'artifact.chunk') return false;
      if (!dropped) { await (await forward()).arrayBuffer(); dropped = true; } response.destroy(); return true;
    });
    const operation = await f.submit({ kind: 'file.read', path: source, offset: 0, length: 1048576, resultFormat: 'artifact', expectedFileVersion: inline.fileVersion });
    await until(async()=>dropped, Boolean);
    await until(async()=>f.sql(db=>(db.prepare('SELECT status FROM operations WHERE id=?').get(operation.id) as any).status), v=>v==='succeeded');
    assert.equal((await f.request(`/api/v1/operations/${operation.id}/artifacts`)).artifacts[0].complete, false);
    unlinkSync(source); await f.restart(); await f.restartService(); f.intercept();
    const done = await f.settled(operation.id); assert.equal(done.execution, 'succeeded', JSON.stringify(done));
    const result = JSON.parse(done.result_json), ref = result.artifacts[0];
    assert.equal(result.fileVersion, inline.fileVersion); assert.equal(result.artifactScope, 'file_byte_range');
    assert.equal(result.offset, 0); assert.equal(result.nextOffset, 1048576); assert.equal(result.totalBytes, bytes.length); assert.equal(result.eof, false);
    assert.deepEqual(await download(f, operation.id, ref.artifactId, 'original-range.bin'), bytes.subarray(0,1048576));
    const mcp = f.mcp(); const response = await mcp.call('tools/call',{name:'reach_artifact_range',arguments:{operationId:operation.id,artifactId:ref.artifactId,offset:123,length:4096}});
    assert.ok(!response.result.isError, JSON.stringify(response)); assert.deepEqual(Buffer.from(JSON.parse(response.result.content[0].text).dataBase64,'base64'),bytes.subarray(123,4219));
    const receipts = await f.events(operation.id); assert.equal(receipts.filter(v=>v.data.type==='artifact.manifest').length,1);
    assert.equal(receipts.find(v=>v.data.type==='file.capture').data.fileVersion,inline.fileVersion);
    writeFileSync(join(f.root,'receipt.json'),JSON.stringify({operationId:operation.id,artifactId:ref.artifactId,bytes:1048576,sha256:sha(bytes.subarray(0,1048576)),sourceDeletedBeforeRestart:true,lostAck:true,nodeRestarted:true,serviceRestarted:true,result},null,2));
  } finally { await f.cleanup(); }
});
test('consecutive ranges use source versions, reject replacement and restored mtime, and handle empty/missing files', { timeout:120000 }, async()=>{
  const f = await setup('versions');
  try {
    const source=join(f.root,'large.bin'), bytes=Buffer.alloc(2400000,0xa5); bytes[100]=0; bytes[2000000]=255; writeFileSync(source,bytes);
    let offset=0, version: string|undefined; const chunks:Buffer[]=[]; const operations:string[]=[];
    while(offset<bytes.length){
      const op=await f.submit({kind:'file.read',path:source,offset,length:1048576,resultFormat:'artifact',...(version?{expectedFileVersion:version}:{})});
      const done=await f.settled(op.id);assert.equal(done.execution,'succeeded',JSON.stringify(done));const result=JSON.parse(done.result_json);
      version??=result.fileVersion; assert.equal(result.fileVersion,version);assert.equal(result.offset,offset);
      chunks.push(await download(f,op.id,result.artifacts[0].artifactId,`range-${offset}.bin`));offset=result.nextOffset;operations.push(op.id);
      assert.equal(result.eof,offset===bytes.length);
    }
    assert.deepEqual(Buffer.concat(chunks),bytes);
    const oldTimes=statSync(source);const changed=Buffer.from(bytes);changed[0]^=255;writeFileSync(source,changed);utimesSync(source,oldTimes.atime,oldTimes.mtime);
    const changedOp=await f.submit({kind:'file.read',path:source,resultFormat:'artifact',expectedFileVersion:version});const rejected=await f.settled(changedOp.id);
    assert.equal(rejected.execution,'failed');assert.match(JSON.parse(rejected.result_json).error,/version changed/);
    assert.equal((await f.request(`/api/v1/operations/${changedOp.id}/artifacts`)).artifacts.length,0);
    unlinkSync(source);writeFileSync(source,bytes);const replaced=await f.submit({kind:'file.read',path:source,expectedFileVersion:version});assert.equal((await f.settled(replaced.id)).execution,'failed');
    const emptyPath=join(f.root,'empty.bin');writeFileSync(emptyPath,Buffer.alloc(0));const empty=await f.submit({kind:'file.read',path:emptyPath,resultFormat:'artifact'});
    const emptyDone=await f.settled(empty.id);assert.equal(emptyDone.execution,'succeeded');const emptyResult=JSON.parse(emptyDone.result_json);assert.equal(emptyResult.eof,true);
    assert.equal((await download(f,empty.id,emptyResult.artifacts[0].artifactId,'empty-original.bin')).length,0);
    const past=await f.submit({kind:'file.read',path:emptyPath,offset:1,resultFormat:'artifact'});assert.equal((await f.settled(past.id)).execution,'failed');
    const missing=await f.submit({kind:'file.read',path:join(f.root,'missing.bin'),resultFormat:'artifact'});assert.equal((await f.settled(missing.id)).execution,'failed');
    writeFileSync(join(f.root,'receipt.json'),JSON.stringify({operations,bytes:bytes.length,sha256:sha(bytes),fileVersion:version,restoredMtimeRejected:true,replacementRejected:true,emptyOperation:empty.id},null,2));
  }finally{await f.cleanup();}
});
test('complete file bytes stay retrievable after the success receipt fails and recovery remains unknown', {timeout:90000},async()=>{
  const f=await setup('terminal-failure');
  try{
    const source=join(f.root,'single.bin'),bytes=Buffer.from('original binary\0\u00ff');writeFileSync(source,bytes);
    f.sql(db=>db.exec("CREATE TRIGGER fail_file_success BEFORE INSERT ON outbox WHEN json_extract(NEW.event_json,'$.kind')='succeeded' BEGIN SELECT RAISE(ABORT,'injected terminal write failure'); END;"));
    const op=await f.submit({kind:'file.read',path:source,resultFormat:'artifact'});const crashed=await f.runner().done;assert.notEqual(crashed.code,0);
    f.sql(db=>db.exec('DROP TRIGGER fail_file_success'));unlinkSync(source);await f.restart();
    const done=await f.settled(op.id);assert.equal(done.execution,'unknown');
    const list=await f.request(`/api/v1/operations/${op.id}/artifacts`);assert.equal(list.artifacts.length,1);assert.equal(list.artifacts[0].complete,true);
    assert.deepEqual(await download(f,op.id,list.artifacts[0].artifactId,'recovered.bin'),bytes);
    const receipts=await f.events(op.id);assert.ok(receipts.some(v=>v.data.type==='file.capture'));assert.ok(receipts.some(v=>v.data.type==='artifact.complete'));assert.equal(receipts.filter(v=>v.kind==='succeeded').length,0);
    writeFileSync(join(f.root,'receipt.json'),JSON.stringify({operationId:op.id,artifactId:list.artifacts[0].artifactId,state:done.execution,sha256:sha(bytes),sourceDeletedBeforeRecovery:true,crashCode:crashed.code},null,2));
  }finally{await f.cleanup();}
});
test('failed chunk persistence leaves incomplete evidence and duplicate requests never recapture the source', {timeout:90000},async()=>{
  const f=await setup('partial-failure');
  try{
    const source=join(f.root,'partial.bin');writeFileSync(source,Buffer.alloc(200000,0x81));
    f.sql(db=>db.exec("CREATE TRIGGER fail_file_chunk BEFORE INSERT ON outbox WHEN json_extract(NEW.event_json,'$.data.type')='artifact.chunk' AND json_extract(NEW.event_json,'$.data.index')=1 BEGIN SELECT RAISE(ABORT,'injected chunk write failure'); END;"));
    const requestId=randomUUID(),command={kind:'file.read',path:source,length:200000,resultFormat:'artifact'};
    const op=await f.submit(command,requestId);const done=await f.settled(op.id);assert.equal(done.execution,'unknown');
    const list=await f.request(`/api/v1/operations/${op.id}/artifacts`);assert.equal(list.artifacts.length,1);assert.equal(list.artifacts[0].complete,false);
    const before=await f.events(op.id);assert.equal(before.filter(v=>v.data.type==='artifact.chunk').length,1);assert.equal(before.filter(v=>v.data.type==='artifact.complete').length,0);
    const downloadAttempt=await f.controller(['artifact',op.id,list.artifacts[0].artifactId,'--output',join(f.root,'must-not-exist.bin')]).done;assert.notEqual(downloadAttempt.code,0);
    f.sql(db=>db.exec('DROP TRIGGER fail_file_chunk'));unlinkSync(source);await f.restart();await f.restartService();
    assert.equal((await f.submit(command,requestId)).id,op.id);assert.equal((await f.settled(op.id)).execution,'unknown');
    assert.deepEqual(await f.events(op.id),before);
    writeFileSync(join(f.root,'receipt.json'),JSON.stringify({operationId:op.id,artifactId:list.artifacts[0].artifactId,state:done.execution,complete:false,retainedChunks:1,sourceDeleted:true,duplicateRequestId:requestId,recaptured:false},null,2));
  }finally{await f.cleanup();}
});
test.after(()=>console.log(JSON.stringify({fileArtifactEvidence:evidence})));
