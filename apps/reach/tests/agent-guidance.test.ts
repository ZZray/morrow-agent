// Copyright (c) Ray Zhang. Service applicability and exact generated tool contract.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {ReachStore} from '../src/service/store.ts';
import {delegateSchema} from '../src/contracts/protocol.ts';
import {agentToolContract} from '../src/contracts/agent-guidance.ts';
import {ReachError} from '../src/service/errors.ts';
const requirements={protocolVersion:1,toolContractVersion:1,platforms:['windows'],capabilities:['file.write']};
function fixture(){
  const root=resolve('work/agent-guidance-service-'+randomUUID());mkdirSync(root,{recursive:true});
  const store=new ReachStore(join(root,'reach.sqlite'));store.bootstrap('guidance-test','guidance-local-test-password');
  const session=store.login('guidance-test','guidance-local-test-password'),secret=randomBytes(32).toString('base64url');
  const pair=store.pair({attemptId:randomUUID(),code:store.createPairing(session.user.id).code,installationId:randomUUID(),installationSecret:secret,name:'Guidance test',platform:'windows',version:'fixture'});
  const node=()=>store.node(secret),caps=['agent.delegate','agent.resume','agent.guidance.v1','file.write'];
  const hello=(value=caps)=>store.hello(node(),'fixture',value);hello();
  const text='Write original bytes only. 此说明仅用于当前任务。';
  const source={id:'test-skill',kind:'skill',source:'fixture://guidance/SKILL.md',revision:'sha-test-v1',text,sha256:createHash('sha256').update(text).digest('hex'),requirements};
  const command=(sources:unknown[]=[source])=>delegateSchema.parse({kind:'agent.delegate',sessionId:randomUUID(),cwd:'E:\\selected',objective:'Use the supplied skill.',sources,maxSeconds:120});
  const submit=(c:ReturnType<typeof command>)=>store.submit(session.user.id,randomUUID(),pair.nodeId,c);
  return {root,store,session,pair,node,caps,hello,source,command,submit,close(){store.close();console.log(JSON.stringify({agentGuidanceServiceEvidence:root}));}};
}
function errorCode(action:()=>unknown,code:string){assert.throws(action,(e:unknown)=>e instanceof ReachError&&e.status===409&&e.code===code);}

test('Rust embedded v1 instructions and complete parameter schema exactly match the service input schema',()=>{
  const embedded=JSON.parse(readFileSync(new URL('../src/node/agent-tool-contract-v1.json',import.meta.url),'utf8'));
  assert.deepEqual(embedded,agentToolContract());
  const variants:any[]=(embedded as any).tools[0].parameters.properties.command.oneOf;
  assert.equal(variants.length,6);
  const read=variants.find((v:any)=>v.properties.kind.const==='file.read');
  assert.deepEqual(read.required,['kind','path']);assert.equal(read.properties.length.maximum,1048576);
  const desktop=variants.find((v:any)=>v.properties.kind.const==='desktop.call');
  for(const field of ['tool','argumentsJson','helperGeneration','sessionRef'])assert.ok(desktop.required.includes(field));
});

test('incompatible source environments reject before persistence, and exact source bytes survive restart',()=>{
  const f=fixture();try{
    const count=()=>Number(f.store.db.prepare('SELECT count(*) AS n FROM operations').get()!.n);
    const cases:[Record<string,unknown>,string][]=[
      [{protocolVersion:2},'agent_protocol_mismatch'],[{toolContractVersion:2},'agent_tool_contract_mismatch'],
      [{platforms:['linux']},'agent_platform_mismatch'],[{capabilities:['desktop.call']},'agent_capability_missing'],
    ];
    for(const [patch,code] of cases){const before=count();errorCode(()=>f.submit(f.command([{...f.source,requirements:{...requirements,...patch}}])),code);assert.equal(count(),before);}
    f.hello(f.caps.filter(c=>c!=='agent.guidance.v1'));errorCode(()=>f.submit(f.command()),'agent_guidance_unavailable');assert.equal(count(),0);
    // Legacy Node and source still work without new metadata.
    const {requirements:_,...legacy}=f.source,legacyOp=f.submit(f.command([legacy]));assert.deepEqual(JSON.parse(legacyOp.command_json).sources,[legacy]);
    f.hello();const op=f.submit(f.command());assert.deepEqual(JSON.parse(op.command_json).sources,[f.source]);
    f.store.close();const reopened=new ReachStore(join(f.root,'reach.sqlite'));try{assert.deepEqual(JSON.parse(reopened.operation(f.session.user.id,op.id).command_json).sources,[f.source]);}finally{reopened.close();}
  }finally{f.close();}
});

test('resume rechecks original source requirements and rolls back operation and generation on mismatch',()=>{
  const f=fixture();try{
    const root=f.submit(f.command()),dispatch=f.store.claim(f.node())!;
    for(const [i,kind] of ['received','running','unknown'].entries())f.store.record(f.node(),{operationId:root.id,dispatchId:dispatch.dispatchId,payloadHash:dispatch.payloadHash,eventId:randomUUID(),sequence:i+1,kind:kind as 'received'|'running'|'unknown',data:{}});
    const before=f.store.executions.projection(f.session.user.id,root.id),count=f.store.db.prepare('SELECT count(*) AS n FROM operations').get()!.n;
    f.hello(f.caps.filter(c=>c!=='file.write'));
    const resume={kind:'agent.resume' as const,rootOperationId:root.id,previousExecutionId:root.id,fenceSha256:'a'.repeat(64),instruction:'Continue the same original Task.'};
    errorCode(()=>f.store.submit(f.session.user.id,randomUUID(),f.pair.nodeId,resume),'agent_capability_missing');
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM operations').get()!.n,count);
    assert.deepEqual(f.store.executions.projection(f.session.user.id,root.id),before);
    f.hello();const next=f.store.submit(f.session.user.id,randomUUID(),f.pair.nodeId,resume);
    assert.equal(f.store.executions.projection(f.session.user.id,root.id).activeExecutionId,next.id);
  }finally{f.close();}
});

test('latest hello blocks queued guidance on old Node, lets unrelated work through, then claims the same original ID',()=>{
  const f=fixture();try{
    const root=f.submit(f.command()),staleNode=f.node();f.hello(f.caps.filter(c=>c!=='agent.guidance.v1'));
    const basic=f.store.submit(f.session.user.id,randomUUID(),f.pair.nodeId,{kind:'file.write',path:'E:\\selected\\ordinary.txt',contentBase64:'eA=='});
    assert.equal(f.store.claim(staleNode)!.operationId,basic.id);
    let waiting=f.store.operation(f.session.user.id,root.id);assert.equal(waiting.dispatch_id,null);assert.equal(waiting.execution,'not_observed');assert.equal(waiting.delivery,'queued');assert.equal(JSON.parse(waiting.result_json!).code,'agent_guidance_unavailable');
    f.hello(f.caps.filter(c=>c!=='file.write'));assert.equal(f.store.claim(staleNode),null);waiting=f.store.operation(f.session.user.id,root.id);assert.equal(JSON.parse(waiting.result_json!).code,'agent_capability_missing');
    f.hello();const original=f.store.claim(staleNode)!;assert.equal(original.operationId,root.id);assert.equal(f.store.operation(f.session.user.id,root.id).result_json,null);
  }finally{f.close();}
});

test('queued resume uses original requirements without changing original state or clearing recovery ownership',()=>{
  const f=fixture();try{
    const root=f.submit(f.command()),dispatch=f.store.claim(f.node())!;
    for(const [i,kind] of ['received','running','unknown'].entries())f.store.record(f.node(),{operationId:root.id,dispatchId:dispatch.dispatchId,payloadHash:dispatch.payloadHash,eventId:randomUUID(),sequence:i+1,kind:kind as 'received'|'running'|'unknown',data:{}});
    const original=f.store.operation(f.session.user.id,root.id),resume=f.store.submit(f.session.user.id,randomUUID(),f.pair.nodeId,{kind:'agent.resume',rootOperationId:root.id,previousExecutionId:root.id,fenceSha256:'b'.repeat(64),instruction:'Keep all original effects and source requirements.'}),projection=f.store.executions.projection(f.session.user.id,root.id);
    f.hello(f.caps.filter(c=>c!=='agent.guidance.v1'));assert.equal(f.store.claim(f.node()),null);
    assert.equal(JSON.parse(f.store.operation(f.session.user.id,resume.id).result_json!).code,'agent_guidance_unavailable');
    assert.deepEqual(f.store.operation(f.session.user.id,root.id),original);assert.deepEqual(f.store.executions.projection(f.session.user.id,root.id),projection);assert.equal(projection.recoveryRequired,true);
    f.hello();assert.equal(f.store.claim(f.node())!.operationId,resume.id);assert.deepEqual(f.store.operation(f.session.user.id,root.id),original);
  }finally{f.close();}
});

test('cancelling or unpairing a waiting operation clears the temporary dispatch blocker',()=>{
  for(const action of ['cancel','unpair']){const f=fixture();try{
    const root=f.submit(f.command());f.hello(f.caps.filter(c=>c!=='agent.guidance.v1'));assert.equal(f.store.claim(f.node()),null);assert.ok(f.store.operation(f.session.user.id,root.id).result_json);
    if(action==='cancel')f.store.cancel(f.session.user.id,root.id);else f.store.revoke(f.session.user.id,f.pair.nodeId);
    const end=f.store.operation(f.session.user.id,root.id);assert.equal(end.execution,'cancelled');assert.equal(end.result_json,null);assert.equal(end.dispatch_id,null);
  }finally{f.close();}}
});
