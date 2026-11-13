// Copyright (c) Ray Zhang. Actual A -> candidate -> B validation -> adoption -> restart -> C reuse.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fixture,until} from './native-fixture.ts';
const sidecar=process.env.REACH_DESK_SIDECAR,sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const delta=(value:unknown,finish:string|null=null)=>'data: '+JSON.stringify({id:'library-local',choices:[{index:0,delta:value,finish_reason:finish}]})+'\n\n';
const answer=()=>delta({content:'Original file effect verified; this does not adopt any reusable knowledge.'})+delta({},'stop')+'data: [DONE]\n\n';
function taskGuidance(body:any){for(const m of body.messages){const parts=typeof m.content==='string'?[m.content]:(m.content??[]).filter((x:any)=>x.type==='text').map((x:any)=>x.text);for(const text of parts)for(const line of text.split('\n'))try{const value=JSON.parse(line);if(value.environment&&value.sources)return value;}catch{}}assert.fail('Actual Task guidance missing');}
const requirements={protocolVersion:1,toolContractVersion:1,platforms:['windows'],capabilities:['file.write']};

for(const scenario of ['normal','readonly-finalized','large-finalized'] as const)test((scenario==='large-finalized'?'real large original result survives source deletion and readonly settlement: ':'real separate Sessions preserve candidate provenance, validation and adopted reuse: ')+scenario,{skip:!sidecar,timeout:180000},async()=>{
  assert.ok(sidecar);const root=resolve('work/source-library-native-'+randomUUID());mkdirSync(root,{recursive:true});
  const token=randomBytes(32).toString('base64url'),requests:any[]=[],skill={filename:'reusable-'+randomUUID(),contentBase64:Buffer.from('原技能字节 '+randomUUID()).toString('base64')};let fault:unknown;
  const provider=createServer(async(req,res)=>{try{
    assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer '+token);const chunks:Buffer[]=[];for await(const b of req)chunks.push(Buffer.from(b));const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);writeFileSync(join(root,'provider-requests.json'),JSON.stringify(requests,null,2));
    assert.ok(!body.tools.some((v:any)=>v.function.name.startsWith('reach_library_')),'delegated model cannot approve sources');
    const supplied=taskGuidance(body),objective=body.messages.map((m:any)=>typeof m.content==='string'?m.content:'').join('\n'),phase=objective.includes('Task C:')?'reuse':objective.includes('Task B:')?'validation':'origin';
    const hasTool=body.messages.some((m:any)=>m.role==='tool'&&m.tool_call_id==='library-write');
    res.writeHead(200,{'content-type':'text/event-stream',connection:'close'});
    if(hasTool){assert.ok(body.messages.some((m:any)=>m.tool_call_id==='library-write'&&/succeeded/.test(m.content)));res.end(answer());return;}
    let filename='origin.txt',contentBase64=Buffer.from('source Task actual receipt').toString('base64');
    if(phase!=='origin'){assert.equal(supplied.sources.length,1);const source=supplied.sources[0];assert.equal(source.library.stage,phase==='validation'?'candidate':'adopted');assert.equal(source.sha256,sha(source.text));const fromSource=JSON.parse(source.text);filename=fromSource.filename+'-'+phase+'.txt';contentBase64=fromSource.contentBase64;}
    const command=phase==='origin'&&scenario==='large-finalized'?{kind:'file.read',path:'origin-large.txt',length:240000}:{kind:'file.write',path:filename,contentBase64};res.end(delta({tool_calls:[{index:0,id:'library-write',type:'function',function:{name:'reach_execute',arguments:JSON.stringify({command})}}]})+delta({},'tool_calls')+'data: [DONE]\n\n');
  }catch(error){fault=error;res.destroy();}});
  provider.listen(0,'127.0.0.1');await once(provider,'listening');const address=provider.address();assert.ok(address&&typeof address!=='string');
  const config=join(root,'agent-runtime.json');writeFileSync(config,JSON.stringify({sidecar,sha256:sha(readFileSync(sidecar)),inspectionLeaseVersion:1}));
  const f=await fixture('',{...process.env,REACH_AGENT_CONFIG:config},root,{...process.env,REACH_AGENT_MODEL_URL:`http://127.0.0.1:${address.port}/v1`,REACH_AGENT_MODEL_ID:'library-local',REACH_AGENT_MODEL_TOKEN:token,REACH_AGENT_MODEL_CONTEXT:'131072',REACH_AGENT_MODEL_MAX_OUTPUT:'1024',REACH_AGENT_MODEL_IMAGE_INPUT:'0'});
  let runner:ReturnType<typeof f.node>|undefined;let lateCancel=false,proofFaults=0,closureCut=false;
  try{
    assert.equal((await f.pair()).code,0);runner=f.node('host');await until(()=>f.request('/api/v1/nodes'),v=>v.nodes.some((n:any)=>n.capabilities.includes('agent.delegate')));
    assert.equal((await f.loginController()).code,0);const mcp=f.mcp();await mcp.call('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'source-library-local',version:'1'}});
    const rpc=async(name:string,input:unknown)=>{const result=(await mcp.call('tools/call',{name,arguments:input})).result;assert.equal(result.isError,undefined,JSON.stringify(result));return JSON.parse(result.content[0].text);};
    const rejected=async(name:string,input:unknown,reason:RegExp)=>{const result=(await mcp.call('tools/call',{name,arguments:input})).result;assert.equal(result.isError,true,JSON.stringify(result));assert.match(result.content[0].text,reason);};
    const cli=async(name:string,input:unknown)=>{const file=join(root,'controller-'+randomUUID()+'.json');writeFileSync(file,JSON.stringify(input));const result=await f.controller([name,file]).done;assert.equal(result.code,0,result.stderr);return JSON.parse(result.stdout);};
    const largeInput=Buffer.alloc(240000,65);Buffer.from('actual large original '+randomUUID()+'\n').copy(largeInput);if(scenario==='large-finalized')writeFileSync(join(root,'origin-large.txt'),largeInput);
    const submit=async(label:string,sources:any[]=[])=>{const sessionId=randomUUID(),op=await rpc('reach_submit',{requestId:randomUUID(),nodeId:f.identity().node_id,command:{kind:'agent.delegate',sessionId,cwd:root,objective:`Task ${label}: follow the explicitly supplied sources once and report original evidence.`,sources,maxCalls:3,maxSeconds:70,maxOutput:1024}});let end=await f.settled(op.id);
      if(label==='A'&&scenario!=='normal'){
        assert.equal(end.execution,'unknown');const released=join(f.state,'agents',op.id,'evidence','released.json');
        if(scenario==='large-finalized')unlinkSync(join(root,'origin-large.txt'));
        const finalizer=await f.submit({kind:'agent.finalize',rootOperationId:op.id,previousExecutionId:op.id,sourceExecutionId:op.id,releasedSha256:sha(readFileSync(released))});end=await f.settled(finalizer.id);assert.equal(end.execution,'succeeded',JSON.stringify(end));assert.ok(JSON.parse(end.result_json).finalizationProof);
      }else{assert.equal(end.execution,'succeeded',JSON.stringify(end));assert.ok(JSON.parse(end.result_json).nativeClosure);}
      return{op,end,sessionId};};
    f.intercept(async(req,res,bytes)=>{
      if(req.url?.endsWith('/closure/snapshot')&&scenario!=='normal'&&!closureCut){closureCut=true;res.writeHead(503,{'content-type':'application/json'});res.end('{"error":{"code":"controlled_closure_transport_failure"}}');return true;}
      if(req.url?.endsWith('/closure/snapshot')&&!lateCancel){lateCancel=true;await f.request(`/api/v1/operations/${req.url.split('/')[5]}/cancel`,'POST',{});}
      if(req.url==='/api/v1/node/events'&&!proofFaults){const original=JSON.parse(bytes.toString());if(original.kind==='succeeded'&&original.data.nativeClosure){
        const token=String(req.headers.authorization).slice(7),cases:[(event:any)=>void,RegExp][]=[
          [e=>{e.data.nativeClosure.snapshotSha256='0'.repeat(64);},/agent_closure_effects/],
          [e=>{e.data.nativeClosure.processOwnerJson+=' ';},/agent_closure_hash/],
          [e=>{const p=e.data.nativeClosure,v=JSON.parse(p.processSettledJson);v.normalExit=false;p.processSettledJson=JSON.stringify(v);p.processSettled.sha256=sha(p.processSettledJson);},/agent_closure_join/],
          [e=>{e.data.nativeClosure.lastRunId=randomUUID();},/agent_closure_run/],
          [e=>{e.data.nativeClosure.observedCalls++;},/agent_closure_run/],
          [e=>{const id=randomUUID();e.data.nativeClosure.lastRunId=id;e.data.outcome.last_receipt.basis.run_id=id;},/agent_closure_run/],
          [e=>{e.data.nativeClosure.task.path='C:\\unrelated-task\\task.json';},/agent_closure_reference_scope/],
        ];
        for(const [mutate,expected] of cases){const changed=structuredClone(original);mutate(changed);await assert.rejects(f.request('/api/v1/node/events','POST',changed,token),expected);proofFaults++;}
      }}return false;
    });
    const originMarker={id:'task-only',kind:'context',source:'fixture://task-only',revision:'1',text:'Only this Task',sha256:sha('Only this Task')},a=await submit('A',[originMarker]);
    const proposal={requestId:randomUUID(),sourceTaskId:a.op.id,scope:'device',kind:'skill',title:'Write the original sourced bytes',revision:'fixture-skill-v1',text:JSON.stringify(skill),requirements};
    const entry=await cli('library-propose',proposal);assert.equal(entry.state,'candidate');assert.equal(entry.version.provenance.kind,'controller_authored_from_task_evidence');assert.equal(entry.version.provenance.sourceTask.taskId,a.op.id);
    if(scenario==='large-finalized'){
      const calls=(await f.request(`/api/v1/operations/${a.op.id}/children`)).calls;assert.equal(calls.length,1);const resultPath=join(f.state,'agents',a.op.id,'evidence','result-'+calls[0].child_id+'.json'),original=readFileSync(resultPath),body=JSON.parse(original.toString());assert.equal(sha(Buffer.from(body.result.contentBase64,'base64')),sha(largeInput));assert.equal(existsSync(join(root,'origin-large.txt')),false);assert.equal(requests.length,2);assert.ok(JSON.stringify(requests[1]).includes('resultRef'));writeFileSync(join(root,'asserted-large.json'),JSON.stringify({scenario,a,entry,sourceDeleted:true,readBytes:largeInput.length,inputSha256:sha(largeInput),result:{path:resultPath,sha256:sha(original)},requests:2,effect:'actual file.read with retained original result, no re-read on finalization'},null,2));return;
    }
    const list={nodeId:f.identity().node_id,epoch:f.identity().epoch};assert.deepEqual((await rpc('reach_library_list',list)).entries,[]);
    await rejected('reach_library_review',{entryId:entry.id,requestId:randomUUID(),versionSha256:entry.versionSha256,decision:'adopt',reason:'Not validated yet.'},/library_validation_required/);
    await rejected('reach_library_source',{entryId:entry.id,versionSha256:entry.versionSha256,stage:'adopted'},/library_not_adopted/);
    const candidate=(await rpc('reach_library_source',{entryId:entry.id,versionSha256:entry.versionSha256,stage:'candidate'})).source;
    const wrong=structuredClone(candidate);wrong.requirements.capabilities=['file.read'];
    await rejected('reach_submit',{requestId:randomUUID(),nodeId:list.nodeId,command:{kind:'agent.delegate',sessionId:randomUUID(),cwd:root,objective:'Reject changed requirements.',sources:[wrong]}},/library_version_changed/);
    await rejected('reach_library_validate',{entryId:entry.id,requestId:randomUUID(),versionSha256:entry.versionSha256,validationTaskId:a.op.id},/library_distinct_task_required/);
    const b=await submit('B',[candidate]);assert.notEqual(b.sessionId,a.sessionId);assert.equal(readFileSync(join(root,skill.filename+'-validation.txt')).toString('base64'),skill.contentBase64);
    const validationInput={entryId:entry.id,requestId:randomUUID(),versionSha256:entry.versionSha256,validationTaskId:b.op.id},validated=await rpc('reach_library_validate',validationInput);assert.equal(validated.currentState,'candidate');assert.equal((await rpc('reach_library_validate',validationInput)).validation.id,validated.validation.id);
    const adoption={entryId:entry.id,requestId:randomUUID(),versionSha256:entry.versionSha256,decision:'adopt',validationId:validated.validation.id,reason:'External controller checked the exact skill bytes, B request and actual original file effect.'};
    const adopted=await cli('library-review',adoption);assert.equal(adopted.currentState,'adopted');assert.equal(adopted.review.user_id,(await f.request('/api/v1/auth/me')).id);const {text:taskOnlyBody,...sourceHeader}=originMarker;assert.deepEqual(entry.version.provenance.sources,[sourceHeader]);assert.equal(entry.version.provenance.sources[0].text,undefined);assert.equal(taskOnlyBody,'Only this Task');
    assert.equal((await rpc('reach_library_list',list)).entries.length,1);assert.equal((await rpc('reach_library_review',adoption)).review.id,adopted.review.id);
    await f.restartService();const durable=(await cli('library-source',{entryId:entry.id,versionSha256:entry.versionSha256,stage:'adopted'})).source;assert.equal(durable.text,proposal.text);assert.deepEqual(durable.requirements,requirements);
    const c=await submit('C',[durable]);assert.notEqual(c.sessionId,b.sessionId);assert.notEqual(c.sessionId,a.sessionId);assert.equal(readFileSync(join(root,skill.filename+'-reuse.txt')).toString('base64'),skill.contentBase64);assert.equal(requests.length,6);
    const stopped=await f.node('host-stop').done;assert.equal(stopped.code,0,stopped.stderr);await runner.done;
    const queued=await f.submit({kind:'agent.delegate',sessionId:randomUUID(),cwd:root,objective:'Must stay queued after registered source revocation.',sources:[durable],maxSeconds:30,maxCalls:2,maxOutput:1024});assert.equal((await f.operation(queued.id)).dispatch_id,null);
    const revoke={entryId:entry.id,requestId:randomUUID(),versionSha256:entry.versionSha256,decision:'revoke',reason:'Retire the test source; preserve exact historical evidence.'},revoked=await cli('library-review',revoke);assert.equal(revoked.currentState,'revoked');assert.equal((await rpc('reach_library_review',revoke)).review.id,revoked.review.id);assert.equal((await rpc('reach_library_review',adoption)).currentState,'revoked');
    await rejected('reach_library_source',{entryId:entry.id,versionSha256:entry.versionSha256,stage:'adopted'},/library_not_adopted/);
    await rejected('reach_submit',{requestId:randomUUID(),nodeId:list.nodeId,command:{kind:'agent.delegate',sessionId:randomUUID(),cwd:root,objective:'Reject newly selected revoked registered source.',sources:[durable]}},/library_not_adopted/);
    runner=f.node('host');const waiting=await until(()=>f.operation(queued.id),v=>v.result_json&&JSON.parse(v.result_json).type==='agent_dispatch_blocked');assert.equal(waiting.dispatch_id,null);assert.equal(JSON.parse(waiting.result_json).code,'library_not_adopted');assert.equal(requests.length,6);assert.equal(existsSync(join(f.state,'agent-sessions',JSON.parse(waiting.command_json).sessionId)),false);
    const history=await rpc('reach_library_read',{entryId:entry.id});assert.equal(history.state,'revoked');assert.equal(history.version.text,proposal.text);assert.equal(history.validations.length,1);assert.equal(history.reviews.length,2);assert.deepEqual((await rpc('reach_library_list',list)).entries,[]);assert.equal((await cli('library-propose',proposal)).state,'revoked');await rpc('reach_cancel',{operationId:queued.id});
    const service=new DatabaseSync(join(root,'service/reach.sqlite'),{readOnly:true});let uses:any[],events:any[];try{uses=service.prepare('SELECT * FROM source_library_uses ORDER BY rowid').all();events=service.prepare('SELECT * FROM operation_events ORDER BY received_at,operation_id,sequence').all();assert.equal(service.prepare('PRAGMA user_version').get()!.user_version,11);assert.equal(uses.length,3);}finally{service.close();}
    assert.equal(proofFaults,7);assert.equal(lateCancel,true);assert.equal(closureCut,scenario!=='normal');writeFileSync(join(root,'asserted.json'),JSON.stringify({a,b,c,entry,validated,adopted,revoked,history,queued:waiting,uses,events,requests:6,skill,originMarker,proofFaults,lateCancel,scenario,closureCut},null,2));
  }finally{await f.cleanup();provider.close();provider.closeAllConnections();await once(provider,'close');assert.equal(fault,undefined);console.log(JSON.stringify({sourceLibraryNativeEvidence:root}));}
});
