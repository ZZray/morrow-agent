// Copyright (c) Ray Zhang. Authenticated original-image reads; synthetic device receipt only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdirSync,readFileSync,writeFileSync,truncateSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {ReachStore,digest} from '../../src/service/store.ts';
import {reachServer} from '../../src/service/server.ts';
import {deskDevices} from '../../src/service/desk-devices.ts';
import {DeskHost} from '../src/host.ts';
import {DeviceToolsHost} from '../src/device-tools.ts';
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
test('larger local context declarations stay explicit, bounded and included in route identity',async()=>{
  // Admission hashes the image before rejecting a changed route; this existing file is never executed.
  const root=resolve('work/desk-local-context-'+randomUUID()),base={stateDirectory:join(root,'default'),binary:process.execPath,endpoint:'http://127.0.0.1:1/v1',model:'not-started',modelToken:'local',developmentLoopback:true};
  const standard=new DeskHost(base),larger=new DeskHost({...base,stateDirectory:join(root,'larger'),developmentContextWindow:131072});const reach=new ReachStore(join(root,'reach.sqlite'));reach.bootstrap('route','local-route-password');const session=reach.login('route','local-route-password'),conversation=randomUUID();larger.store.create(session.user.id,conversation,'Original route',standard.routeHash);const server=reachServer({store:reach,desk:larger,publicOrigin:'http://127.0.0.1',allowInsecureLoopback:true});server.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a!=='string');
  try{assert.equal((standard.route as any).modelResolution.capabilities.context_window,32768);assert.equal((larger.route as any).modelResolution.capabilities.context_window,131072);assert.notEqual(standard.routeHash,larger.routeHash);for(const size of [0,32767,131073,NaN,Infinity,32768.5])assert.throws(()=>new DeskHost({...base,developmentContextWindow:size}),/上下文/);assert.throws(()=>new DeskHost({...base,endpoint:'https://fixture.invalid/v1',developmentLoopback:false,developmentContextWindow:131072}),/上下文/);const rejected=await fetch(`http://127.0.0.1:${a.port}/api/v1/desk/conversations/${conversation}/messages`,{method:'POST',headers:{authorization:'Bearer '+session.token,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),content:'Must retain original route'})});assert.equal(rejected.status,409);assert.equal((await rejected.json()).error.code,'desk_route_changed');assert.equal(larger.store.turns(session.user.id,conversation).length,0);}finally{await standard.close();await larger.close();server.close();server.closeAllConnections();await once(server,'close');reach.close();}
});
async function fixture(){
  const root=resolve('work/desk-preview-'+randomUUID());mkdirSync(root,{recursive:true});const reach=new ReachStore(join(root,'reach.sqlite'));reach.bootstrap('preview','local-preview-password');const session=reach.login('preview','local-preview-password');
  reach.db.prepare('INSERT INTO users SELECT ?,?,salt,password_hash FROM users WHERE id=?').run(randomUUID(),'other',session.user.id);const other=reach.login('other','local-preview-password');
  // This fixture calls tools directly; it never starts a sidecar or contacts an endpoint.
  const desk=new DeskHost({stateDirectory:join(root,'desk'),binary:resolve('work/not-started.exe'),endpoint:'http://127.0.0.1:1/v1',model:'not-started',modelToken:'local',developmentLoopback:true});
  const server=reachServer({store:reach,desk,publicOrigin:'http://127.0.0.1',allowInsecureLoopback:true});server.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a!=='string');
  const request=(path:string,token:string|null=session.token)=>fetch(`http://127.0.0.1:${a.port}/api/v1/desk/`+path,{headers:token?{authorization:'Bearer '+token}:{}});
  const secret=randomBytes(32).toString('base64url'),installationId=randomUUID(),bound=reach.pair({attemptId:randomUUID(),code:reach.createPairing(session.user.id).code,installationId,installationSecret:secret,name:'Receipt fixture',platform:'windows',version:'fixture'});
  const node=reach.node(secret);reach.hello(node,'fixture',['file.read']);const access=deskDevices(reach,session.user.id),target=access.target({nodeId:bound.nodeId,epoch:bound.epoch,cwd:'E:\\fixture'});
  const png=new PNG({width:16,height:12});png.data.fill(127);const bytes=PNG.sync.write(png),op=access.submit(randomUUID(),target,{kind:'file.read',path:'fixture.png'}),dispatch=reach.claim(node)!,artifactId=randomUUID();let sequence=0;
  const record=(kind:any,data:any)=>reach.record(node,{operationId:op.id,dispatchId:dispatch.dispatchId,payloadHash:dispatch.payloadHash,eventId:randomUUID(),sequence:++sequence,kind,data});record('received',{});record('running',{});
  record('output',{type:'artifact.manifest',version:1,artifactId,mimeType:'image/png',byteLength:bytes.length,sha256:sha(bytes),contentIndex:0,chunkBytes:65536,chunkCount:1,width:16,height:12});record('output',{type:'artifact.chunk',artifactId,index:0,dataBase64:bytes.toString('base64'),sha256:sha(bytes)});record('output',{type:'artifact.complete',artifactId});const ref={type:'artifact',artifactId,mimeType:'image/png',sha256:sha(bytes),contentIndex:0};record('succeeded',{content:[ref],images:[ref]});
  const conversation=randomUUID();desk.store.create(session.user.id,conversation,'Original image','local');const turn=desk.store.admit(session.user.id,conversation,randomUUID(),'Seeded image','local','local',target).turn;desk.store.running(turn.id);
  const directory=join(root,'desk','tasks',turn.task_id),tools=new DeviceToolsHost(desk.store,turn,access,directory,()=>true,Date.now()+10000),frame={kind:'tool_call',version:1,rpc_id:'rpc-image',task_id:turn.task_id,run_id:turn.run_id,native_call_id:'image',tool_name:'reach_image',arguments:{operationId:op.id,artifactId},args_sha256:digest({operationId:op.id,artifactId})};
  const reply=await tools.invoke(frame,{signal:new AbortController().signal});assert.equal(reply.is_error,false);const call=desk.store.deviceCalls(turn)[0],path=`messages/${turn.id}/images/${call.call_key}`;
  return {root,reach,desk,session,other,request,access,target,turn,tools,reply,call,path,bytes,op,secret,installationId,async close(){await desk.close();server.close();server.closeAllConnections();await once(server,'close');reach.close();console.log(JSON.stringify({deskPreviewEvidence:root}));}};
}
test('original-image API checks login, account, message and call identity without executing another operation',async()=>{
  const f=await fixture();try{
    const response=await f.request(f.path);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(Number(response.headers.get('content-length')),f.bytes.length);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.bytes);
    assert.equal((await f.request(f.path,null)).status,401);assert.equal((await f.request(f.path,f.other.token)).status,404);assert.equal((await f.request(`messages/${randomUUID()}/images/${f.call.call_key}`)).status,404);assert.equal((await f.request(f.path.replace(f.call.call_key,'0'.repeat(64)))).status,404);
    const otherConversation=randomUUID();f.desk.store.create(f.session.user.id,otherConversation,'Other message','local');const otherTurn=f.desk.store.admit(f.session.user.id,otherConversation,randomUUID(),'Other message','local','local',f.target).turn;
    assert.equal((await f.request(`messages/${otherTurn.id}/images/${f.call.call_key}`)).status,404);
    const history=await(await f.request('messages/'+f.turn.id)).json();assert.equal(history.images[0].sha256,sha(f.bytes));assert.equal(history.images[0].recorded,true);assert.equal(JSON.stringify(history.images).includes(f.root),false);assert.equal('path' in history.images[0],false);
    // A different unknown call in this message must not suppress a complete original image.
    f.desk.store.beginDeviceCall(f.turn,{key:sha('unknown'),id:'unknown',runId:f.turn.run_id,tool:'reach_execute',intent:{fixtureOnly:true}});assert.throws(()=>f.tools.review());assert.equal((await f.request(f.path)).status,200);
    // Both terminal reconciliation and a later pairing retain historical evidence ownership.
    f.reach.db.prepare("UPDATE operations SET execution='unknown',cancel_requested=1 WHERE id=?").run(f.op.id);assert.equal((await f.request(f.path)).status,200);
    f.reach.db.prepare("UPDATE operations SET execution='succeeded' WHERE id=?").run(f.op.id);f.reach.revoke(f.session.user.id,f.target.nodeId);assert.throws(()=>f.access.target(f.target));assert.equal((await f.request(f.path)).status,200);
    f.reach.pair({attemptId:randomUUID(),code:f.reach.createPairing(f.session.user.id).code,installationId:f.installationId,installationSecret:f.secret,name:'Re-paired fixture',platform:'windows',version:'fixture'},f.secret);assert.throws(()=>f.access.target(f.target));assert.equal((await f.request(f.path)).status,200);
    f.reach.logout(f.session.token);assert.equal((await f.request(f.path)).status,401);assert.equal(f.reach.operations(f.session.user.id).length,1);
    writeFileSync(join(f.root,'asserted.json'),JSON.stringify({scopes:['login','account','message','call'],unknownSiblingReadable:true,historicalPairingReadable:true,terminalReconciliationReadable:true,operationCount:1,sha256:sha(f.bytes)},null,2));
  }finally{await f.close();}
});
test('altered cache, proof, intent and source are rejected while history retains provenance',async()=>{
  const f=await fixture();try{
    const cache=f.reply.images![0].path,proof=JSON.parse(f.call.receipt_json!).evidenceRef.path,intent=JSON.parse(readFileSync(proof,'utf8')).intentRef.path;
    for(const [path,corrupt] of [[cache,Buffer.alloc(f.bytes.length)],[proof,Buffer.from('{}')],[intent,Buffer.from('{}')]] as const){const original=readFileSync(path);writeFileSync(path,corrupt);assert.equal((await f.request(f.path)).status,409);const view=await(await f.request('messages/'+f.turn.id)).json();assert.equal(view.images[0].recorded,true);assert.equal(view.images[0].sha256,sha(f.bytes));writeFileSync(path,original);}
    // Sparse oversized files are rejected before allocating or parsing their declared contents.
    for(const [path,size] of [[proof,16*1024*1024+1],[intent,1024*1024+1]] as const){const original=readFileSync(path);truncateSync(path,size);assert.equal((await f.request(f.path)).status,409);writeFileSync(path,original);}
    const original=f.call.receipt_json!;f.desk.store.db.prepare('UPDATE device_calls SET receipt_json=? WHERE turn_id=? AND call_key=?').run('{broken',f.turn.id,f.call.call_key);assert.ok((await f.request(f.path)).status>=400);const history=await(await f.request('messages/'+f.turn.id)).json();assert.deepEqual(history.images.map((v:any)=>({key:v.callKey,recorded:v.recorded,op:v.operationId})),[{key:f.call.call_key,recorded:false,op:f.op.id}]);
    f.desk.store.db.prepare('UPDATE device_calls SET receipt_json=? WHERE turn_id=? AND call_key=?').run(original,f.turn.id,f.call.call_key);assert.equal((await f.request(f.path)).status,200);
    // The original ledger manifest must still agree with the saved receipt.
    const access={...f.access,artifacts:(...args:Parameters<typeof f.access.artifacts>)=>{const listed=f.access.artifacts(...args);return {...listed,artifacts:listed.artifacts.map(v=>({...v,sha256:'0'.repeat(64)}))};}};
    const {readImage}=await import('../src/image-preview.ts');assert.throws(()=>readImage(f.desk.store,f.turn,access,join(f.root,'desk','tasks',f.turn.task_id),f.call.call_key),/清单/);assert.equal(f.reach.operations(f.session.user.id).length,1);
    writeFileSync(join(f.root,'asserted.json'),JSON.stringify({rejected:['cache','proof','intent','oversized proof','oversized intent','malformed receipt','manifest mismatch'],provenanceRetained:true,operationCount:1},null,2));
  }finally{await f.close();}
});
