// Copyright (c) Ray Zhang. HTTP contract faults against explicit copies of real completed native evidence.
// These tests add no model/tool execution; the baseline is produced by source-library.integration.test.ts.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {once} from 'node:events';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {ReachStore} from '../src/service/store.ts';
import {reachServer} from '../src/service/server.ts';
import {delegateSchema} from '../src/contracts/protocol.ts';
const baseline=process.env.REACH_LIBRARY_NATIVE_BASELINE,sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const requirements={protocolVersion:1,toolContractVersion:1,platforms:['windows'],capabilities:['file.write']};
async function fixture(){
  assert.ok(baseline);const root=resolve('work/source-library-contract-'+randomUUID());mkdirSync(root,{recursive:true});const filename=join(root,'reach.sqlite'),original=new DatabaseSync(baseline,{readOnly:true});try{await backup(original,filename);}finally{original.close();}
  const assertion=JSON.parse(readFileSync(join(dirname(dirname(baseline)),'asserted.json'),'utf8'));
  const store=new ReachStore(filename),session=store.login('native-test','native-test-fixture-password'),nodeId=assertion.a.op.node_id,node=store.ownedNode(session.user.id,nodeId);
  const nativeDb=new DatabaseSync(join(dirname(dirname(baseline)),'node/node.sqlite'),{readOnly:true});let identity:any;try{identity=JSON.parse(String(nativeDb.prepare("SELECT value FROM config WHERE key='identity'").get()!.value));}finally{nativeDb.close();}
  const server=reachServer({store,publicOrigin:'http://127.0.0.1',allowInsecureLoopback:true});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
  const api=async(path:string,method='GET',input?:unknown,credential=session.token)=>{const response=await fetch(`http://127.0.0.1:${address.port}${path}`,{method,headers:{authorization:'Bearer '+credential,'content-type':'application/json',connection:'close'},body:input===undefined?undefined:JSON.stringify(input)});return{status:response.status,data:await response.json() as any};};
  const proposal=(extra:Record<string,unknown>={})=>({requestId:randomUUID(),sourceTaskId:assertion.a.op.id,scope:'device',kind:'knowledge',title:'Copied actual receipt reference',revision:'contract-v1',text:'Use exact original evidence; this is still unadopted.',requirements,...extra});
  const create=async()=>{const p=proposal(),r=await api('/api/v1/library','POST',p);assert.equal(r.status,200,JSON.stringify(r));return{entry:r.data,input:p};};
  return{root,filename,assertion,store,session,node,identity,api,proposal,create,async close(){await server.shutdown();store.close();console.log(JSON.stringify({sourceLibraryContractEvidence:root}));}};
}

test('candidate versions bind all source fields, do not auto-adopt, and cannot borrow unrelated validation',{skip:!baseline},async()=>{
  const f=await fixture();try{
    assert.equal((await f.api('/api/v1/library','POST',f.proposal({revision:'\ud800'}))).status,400);
    const {entry,input}=await f.create(),retried=await f.api('/api/v1/library','POST',input);assert.equal(retried.data.id,entry.id);
    assert.equal((await f.api('/api/v1/library','POST',{...input,text:input.text+' changed'})).data.error.code,'library_request_conflict');
    assert.equal((await f.api(`/api/v1/library?nodeId=${f.node.id}&epoch=${f.node.epoch}`)).data.entries.length,0);
    const selected=await f.api(`/api/v1/library/${entry.id}/source`,'POST',{versionSha256:entry.versionSha256,stage:'candidate'});assert.equal(selected.status,200);
    const source=selected.data.source,variants=[{...source,text:'changed',sha256:sha('changed')},{...source,revision:'other'},{...source,kind:'skill'},{...source,requirements:{...requirements,platforms:['linux']}},{...source,library:{...source.library,versionSha256:'0'.repeat(64)}}];
    for(const bad of variants){const result=await f.api('/api/v1/operations','POST',{requestId:randomUUID(),nodeId:f.node.id,command:{kind:'agent.delegate',sessionId:randomUUID(),cwd:f.root,objective:'Reject changed source version.',sources:[bad]}});assert.equal(result.status,409);assert.equal(result.data.error.code,'library_version_changed');}
    const missing=structuredClone(source);delete missing.library;assert.equal((await f.api('/api/v1/operations','POST',{requestId:randomUUID(),nodeId:f.node.id,command:{kind:'agent.delegate',sessionId:randomUUID(),cwd:f.root,objective:'Reject missing registry identity.',sources:[missing]}})).data.error.code,'library_reference_required');
    assert.equal((await f.api(`/api/v1/library/${entry.id}/review`,'POST',{requestId:randomUUID(),versionSha256:entry.versionSha256,decision:'adopt',reason:'No validation.'})).data.error.code,'library_validation_required');
    assert.equal((await f.api(`/api/v1/library/${entry.id}/validate`,'POST',{requestId:randomUUID(),versionSha256:entry.versionSha256,validationTaskId:f.assertion.a.op.id})).data.error.code,'library_distinct_task_required');
    assert.equal((await f.api(`/api/v1/library/${entry.id}/validate`,'POST',{requestId:randomUUID(),versionSha256:entry.versionSha256,validationTaskId:f.assertion.b.op.id})).data.error.code,'library_validation_input_required');
    const revoke={requestId:randomUUID(),versionSha256:entry.versionSha256,decision:'revoke',reason:'Never adopt this test draft.'};assert.equal((await f.api(`/api/v1/library/${entry.id}/review`,'POST',revoke)).data.currentState,'revoked');assert.equal((await f.api('/api/v1/library','POST',input)).data.state,'revoked');
    assert.equal((await f.api(`/api/v1/library/${entry.id}/review`,'POST',{...revoke,requestId:randomUUID(),decision:'adopt',validationId:f.assertion.validated.validation.id})).status,409);
    writeFileSync(join(f.root,'asserted.json'),JSON.stringify({entryId:entry.id,versionSha256:entry.versionSha256,changedFieldsRejected:variants.length,copiedBaseline:baseline,noNewNativeEffects:true},null,2));
  }finally{await f.close();}
});

test('registered sources isolate accounts, nodes and real replacement pairing epochs; historical text stays readable',{skip:!baseline},async()=>{
  const f=await fixture();try{
    const {entry}=await f.create(),selected=(await f.api(`/api/v1/library/${entry.id}/source`,'POST',{versionSha256:entry.versionSha256,stage:'candidate'})).data.source;
    const foreignId=randomUUID();f.store.db.prepare('INSERT INTO users SELECT ?,?,salt,password_hash FROM users WHERE id=?').run(foreignId,'foreign-contract',f.session.user.id);const foreign=f.store.login('foreign-contract','native-test-fixture-password');assert.equal((await f.api(`/api/v1/library/${entry.id}`,'GET',undefined,foreign.token)).status,404);
    const secret=randomBytes(32).toString('base64url'),other=f.store.pair({attemptId:randomUUID(),code:f.store.createPairing(f.session.user.id).code,installationId:randomUUID(),installationSecret:secret,name:'Other fixture node',platform:'windows',version:'fixture'});f.store.hello(f.store.node(secret),'fixture',['agent.delegate','agent.guidance.v1','file.write']);
    const submit=(nodeId:string)=>f.api('/api/v1/operations','POST',{requestId:randomUUID(),nodeId,command:{kind:'agent.delegate',sessionId:randomUUID(),cwd:f.root,objective:'Check exact source scope.',sources:[selected]}});assert.equal((await submit(other.nodeId)).data.error.code,'library_scope_changed');
    const replacement=f.store.pair({attemptId:randomUUID(),code:f.store.createPairing(f.session.user.id).code,installationId:f.identity.installation_id,installationSecret:f.identity.secret,name:'Same installation replaced',platform:'windows',version:'fixture'},f.identity.secret);assert.equal(replacement.nodeId,f.node.id);assert.equal(replacement.epoch,f.node.epoch+1);f.store.hello(f.store.node(f.identity.secret),'fixture',['agent.delegate','agent.guidance.v1','file.write']);
    assert.equal((await submit(f.node.id)).data.error.code,'library_scope_changed');assert.equal((await f.api(`/api/v1/library/${entry.id}/source`,'POST',{versionSha256:entry.versionSha256,stage:'candidate'})).data.error.code,'library_scope_changed');assert.equal((await f.api(`/api/v1/library/${entry.id}`)).data.version.text,entry.version.text);
  }finally{await f.close();}
});

test('gen1 completion snapshot is read-only after original deadline and cancellation and cannot settle a Task',{skip:!baseline},async()=>{
  const f=await fixture();try{
    let clock=Date.now();f.store.now=()=>clock;const command=delegateSchema.parse({kind:'agent.delegate',sessionId:randomUUID(),cwd:f.root,objective:'Synthetic transport state; no model or tool execution.',maxSeconds:5}),op=f.store.submit(f.session.user.id,randomUUID(),f.node.id,command),dispatch=f.store.claim(f.node)!;
    for(const [i,kind] of ['received','running'].entries())f.store.record(f.node,{operationId:op.id,dispatchId:dispatch.dispatchId,payloadHash:dispatch.payloadHash,eventId:randomUUID(),sequence:i+1,kind:kind as 'received'|'running',data:{syntheticTransportOnly:true}});
    clock+=6000;f.store.cancel(f.session.user.id,op.id);const before=f.store.operation(f.session.user.id,op.id),response=await f.api(`/api/v1/node/agents/${op.id}/closure/snapshot`,'POST',{dispatchId:dispatch.dispatchId,payloadHash:dispatch.payloadHash},f.identity.secret);assert.equal(response.status,200,JSON.stringify(response));assert.equal(response.data.ready,true);assert.deepEqual(f.store.operation(f.session.user.id,op.id),before);assert.equal(before.execution,'running');
    assert.equal((await f.api('/api/v1/library','POST',f.proposal({sourceTaskId:op.id}))).data.error.code,'library_task_unsettled');
  }finally{await f.close();}
});

test('legacy success and changed effect ledgers cannot become source validation evidence',{skip:!baseline},async()=>{
  const f=await fixture();try{
    const id=f.assertion.a.op.id,original=f.store.operation(f.session.user.id,id),result=JSON.parse(original.result_json!);delete result.nativeClosure;
    // Explicit copied-DB fault: emulate a historical success without new proof. This is not a real Node run.
    f.store.db.prepare('UPDATE operations SET result_json=? WHERE id=?').run(JSON.stringify(result),id);f.store.db.prepare("UPDATE operation_events SET data_json=? WHERE operation_id=? AND kind='succeeded'").run(JSON.stringify(result),id);
    assert.equal((await f.api('/api/v1/library','POST',f.proposal())).data.error.code,'library_native_proof_required');
    const full=JSON.parse(original.result_json!);f.store.db.prepare('UPDATE operations SET result_json=? WHERE id=?').run(original.result_json,id);f.store.db.prepare("UPDATE operation_events SET data_json=? WHERE operation_id=? AND kind='succeeded'").run(JSON.stringify(full),id);
    const child=f.store.db.prepare('SELECT child_id FROM agent_calls WHERE parent_id=? LIMIT 1').get(id)!;f.store.db.prepare('UPDATE operations SET result_json=? WHERE id=?').run('{"copiedDbFault":"changed original effect"}',child.child_id);
    assert.equal((await f.api('/api/v1/library','POST',f.proposal())).data.error.code,'library_native_evidence_changed');
  }finally{await f.close();}
});
