// Copyright (c) Ray Zhang. Actual ordinary Node crash AFTER native release, with no model or tool replay during finalization.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,watch,statSync} from 'node:fs';
import type {FSWatcher} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fixture,until,kill} from './native-fixture.ts';
const sourceSidecar=process.env.REACH_FINALIZE_SOURCE_SIDECAR??process.env.REACH_DESK_SIDECAR,inspector=process.env.REACH_DESK_SIDECAR,sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const frame=(delta:unknown,finish:string|null=null)=>'data: '+JSON.stringify({id:'readonly-finalize',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n';
function tree(root:string):Array<{path:string;sha256:string}>{return readdirSync(root).sort().flatMap(name=>{const path=join(root,name);return statSync(path).isDirectory()?tree(path):[{path,sha256:sha(readFileSync(path))}];});}
async function settledTree(root:string){return until(async()=>{try{return tree(root);}catch(error:any){if(error.code==='EBUSY'||error.code==='EPERM')return null;throw error;}},v=>v!==null,5000);}

for(const scenario of ['happy','wrong_released','inspector_killed','final_ack_lost','budget','sealed_cancel','sealed_unpair'] as const)test('actual Released-without-terminal read-only finalization: '+scenario,{skip:!inspector||!sourceSidecar,timeout:150000},async()=>{
 assert.ok(sourceSidecar);assert.ok(inspector);const root=resolve('work/agent-native-finalize-'+scenario+'-'+randomUUID());mkdirSync(root,{recursive:true});const token=randomBytes(32).toString('base64url'),requests:any[]=[];let fault:unknown,modelsGo!:()=>void;const modelsReady=new Promise<void>(resolve=>{modelsGo=resolve;});const expectedCalls=scenario==='budget'?1:2,expectedState=scenario==='budget'?'failed':'succeeded';
 const effect=join(root,'effect.txt'),command=`[IO.File]::AppendAllText('${effect.replaceAll("'","''")}','once'+[Environment]::NewLine)`;
 const provider=createServer(async(req,res)=>{try{assert.equal(req.headers.authorization,'Bearer '+token);const chunks=[];for await(const bytes of req)chunks.push(Buffer.from(bytes));const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);writeFileSync(join(root,'provider-requests.json'),JSON.stringify(requests,null,2));assert.ok(requests.length<=expectedCalls,'finalization cannot make another model request');await modelsReady;res.writeHead(200,{'content-type':'text/event-stream',connection:'close'});
  if(requests.length===1)res.end(frame({tool_calls:[{index:0,id:'once-original',type:'function',function:{name:'reach_execute',arguments:JSON.stringify({command:{kind:'command.run',command,cwd:root,timeoutMs:30000}})}}]})+frame({},'tool_calls')+'data: [DONE]\n\n');
  else res.end(frame({content:'Original effect has one settled receipt.'})+frame({},'stop')+'data: [DONE]\n\n');
 }catch(error){fault=error;res.destroy();}});provider.listen(0,'127.0.0.1');await once(provider,'listening');const address=provider.address();assert.ok(address&&typeof address!=='string');
 const config=join(root,'agent-runtime.json');writeFileSync(config,JSON.stringify({sidecar:sourceSidecar,sha256:sha(readFileSync(sourceSidecar))}));let cleanupFixture:Awaited<ReturnType<typeof fixture>>|undefined,watcher:FSWatcher|undefined;
 try{
  const f=await fixture('',{...process.env,REACH_AGENT_CONFIG:config},root,{...process.env,REACH_AGENT_MODEL_URL:`http://127.0.0.1:${address.port}/v1`,REACH_AGENT_MODEL_ID:'readonly-finalize',REACH_AGENT_MODEL_TOKEN:token,REACH_AGENT_MODEL_CONTEXT:'131072',REACH_AGENT_MODEL_MAX_OUTPUT:'1024',REACH_AGENT_MODEL_IMAGE_INPUT:'0'});cleanupFixture=f;assert.equal((await f.pair()).code,0);const host=f.node('host'),sessionId=randomUUID();
  const parent=await f.submit({kind:'agent.delegate',sessionId,cwd:root,objective:'Append exactly once and preserve the original command receipt.',maxRuns:scenario==='budget'?1:2,maxCalls:6,runCallLimit:scenario==='budget'?1:2,maxSeconds:180,maxOutput:1024}),records=join(f.state,'agents',parent.id),evidence=join(records,'evidence');
  await until(async()=>existsSync(evidence),Boolean);
  let cut=false,cutError:unknown;let signal!:()=>void;const cutPromise=new Promise<void>(resolve=>{signal=resolve;});
  watcher=watch(evidence,(_kind,name)=>{if(String(name)!=='released.json'||cut)return;try{const released=JSON.parse(readFileSync(join(evidence,'released.json'),'utf8'));if(released.fence_presence!=='Released')return;
    assert.equal(existsSync(join(records,'terminal.json')),false,'the test must cut before Node terminal persistence');cut=true;host.child.kill('SIGKILL');signal();
   }catch(error:any){if(error.code==='ENOENT'||error instanceof SyntaxError)return;cutError=error;signal();}});
  modelsGo();if(scenario!=='budget'){
   const reviewSet=await until(()=>f.request(`/api/v1/operations/${parent.id}/agent-reviews`),v=>v.reviews.length===1,45000).catch(error=>{writeFileSync(join(root,'source-host-logs.json'),JSON.stringify(host.logs(),null,2));throw error;}),review=reviewSet.reviews[0];assert.equal(readFileSync(effect,'utf8'),'once\r\n');
   await f.request(`/api/v1/operations/${parent.id}/agent-reviews`,'POST',{reviewId:randomUUID(),runId:review.runId,basisSha256:review.basisSha256,decision:'return_result',feedback:''});
  }
  let cutTimer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([cutPromise,new Promise((_,reject)=>{cutTimer=setTimeout(()=>reject(Error('real release/crash window was not observed')),15000);})]);}finally{clearTimeout(cutTimer);}watcher.close();watcher=undefined;assert.equal(cutError,undefined);assert.equal(cut,true);await kill(host.child);
  assert.equal(existsSync(join(records,'terminal.json')),false);assert.equal(existsSync(join(records,'process-settled.json')),false);assert.ok(existsSync(join(records,'sidecar-owner.json')));
  const session=join(f.state,'agent-sessions',sessionId);assert.equal(readdirSync(session).some(n=>n.endsWith('.fence.json')),false);const beforeSession=await settledTree(session),beforeEvidence=tree(evidence),originalTaskSha=sha(readFileSync(join(records,'task.json'))),releasedSha=sha(readFileSync(join(evidence,'released.json')));
  writeFileSync(config,JSON.stringify({sidecar:inspector,sha256:sha(readFileSync(inspector)),inspectionLeaseVersion:1}));let recoveryHost=f.node('host');await until(()=>f.operation(parent.id),v=>v.execution==='unknown');await until(async()=>f.sql(db=>Number(db.prepare('SELECT count(*) AS n FROM outbox WHERE acknowledged=0').get()!.n)),n=>n===0);
  const original=await f.operation(parent.id),models=await f.request(`/api/v1/operations/${parent.id}/agent-models`),children=await f.request(`/api/v1/operations/${parent.id}/children`);
  let previous=parent.id,failedAttempt:any,inspectorKilled=false,heldAck=false,allowAck=false,submittedEvent:any;
  const finalizeCommand=(released=releasedSha)=>({kind:'agent.finalize',rootOperationId:parent.id,previousExecutionId:previous,sourceExecutionId:parent.id,releasedSha256:released});
  if(scenario==='inspector_killed')f.intercept(async(req,res,_bytes,forward)=>{
   if(req.url?.endsWith('/finalize/snapshot')&&!inspectorKilled){
    const attemptId=req.url.split('/')[5],ownerPath=join(records,'attempts',attemptId,'inspector-owner.json'),owner=JSON.parse(readFileSync(ownerPath,'utf8'));
    assert.equal(owner.executionId,attemptId);assert.equal(owner.sidecarSha256,sha(readFileSync(inspector)));
    const script=`$targetProcess=[Diagnostics.Process]::GetProcessById(${owner.sidecar.pid}); if($targetProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne '${owner.sidecar.creationTime}'){throw 'inspector identity changed'}; $targetProcess.Kill(); $targetProcess.WaitForExit();`;
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000});inspectorKilled=true;
    const saved=await forward();res.writeHead(saved.status,{'content-type':'application/json'});res.end(Buffer.from(await saved.arrayBuffer()));return true;
   }return false;
  });
  if(scenario==='wrong_released'||scenario==='inspector_killed'){
   failedAttempt=await f.submit(finalizeCommand(scenario==='wrong_released'?'0'.repeat(64):releasedSha));const failed=await f.settled(failedAttempt.id);assert.equal(failed.execution,'unknown',JSON.stringify(failed));
   assert.match(JSON.parse(failed.result_json).error,scenario==='wrong_released'?/released bytes changed/:/lease ended/);assert.equal((await f.request(`/api/v1/operations/${parent.id}/agent-task`)).recoveryRequired,true);assert.equal(existsSync(join(records,'attempts',failedAttempt.id,'sealed-result.json')),false);assert.equal(requests.length,2);f.intercept();previous=failedAttempt.id;
  }
  if(scenario==='final_ack_lost'||scenario==='sealed_cancel'||scenario==='sealed_unpair')f.intercept(async(req,res,bytes,forward)=>{
   if(req.url==='/api/v1/node/events'){const event=JSON.parse(bytes.toString());if(event.data?.finalizationProof&&!allowAck){
    if(submittedEvent)assert.deepEqual(event,submittedEvent);else submittedEvent=event;if(scenario==='final_ack_lost'){const saved=await forward();assert.equal(saved.status,200);await saved.arrayBuffer();}heldAck=true;res.writeHead(503,{'content-type':'application/json'});res.end('{"error":{"code":"controlled_final_ack_loss"}}');return true;
   }}return false;
  });
  const inspect=await f.submit({kind:'agent.inspect',rootOperationId:parent.id}),observed=JSON.parse((await f.settled(inspect.id)).result_json);assert.equal(observed.nativeAuthorityVerified,false);assert.equal(observed.resumeRuntimeMatches,false);assert.ok(observed.finalizationCandidates.some((c:any)=>c.sourceExecutionId===parent.id&&c.releasedSha256===releasedSha));assert.equal(JSON.stringify(observed).includes(records),false);
  const finalize=await f.submit(finalizeCommand());let cancelledOutbox:string|undefined;
  if(scenario==='sealed_cancel'||scenario==='sealed_unpair'){
   await until(async()=>heldAck,Boolean);assert.equal((await f.operation(finalize.id)).execution,'running');assert.equal((await f.request(`/api/v1/operations/${parent.id}/agent-task`)).recoveryRequired,true);
   cancelledOutbox=String(f.sql(db=>db.prepare("SELECT event_json FROM outbox WHERE operation_id=? AND json_extract(event_json,'$.kind')='succeeded'").get(finalize.id)!.event_json));assert.deepEqual(JSON.parse(cancelledOutbox),submittedEvent);const seal=submittedEvent.data.finalizationProof.inspectionSeal;assert.equal(sha(readFileSync(seal.receipt.path)),seal.receipt.sha256);
   if(scenario==='sealed_cancel')await f.request(`/api/v1/operations/${finalize.id}/cancel`,'POST',{});else{await f.request(`/api/v1/nodes/${f.identity().node_id}/unpair`,'POST',{});const uncertain=await f.operation(finalize.id);assert.equal(uncertain.delivery,'uncertain');for(const decision of ['failed','not_executed','succeeded'])await assert.rejects(()=>f.request(`/api/v1/operations/${finalize.id}/reconcile`,'POST',{reconciliationId:randomUUID(),dispatchId:uncertain.dispatch_id,payloadHash:uncertain.payload_hash,decision,evidence:'Exact original sealed Node event is still waiting for upload.',result:{fixture:true}}),/409:.*agent_finalizer_outbox_required/);}assert.equal((await f.operation(finalize.id)).cancel_requested,1);await kill(recoveryHost.child);allowAck=true;f.intercept();recoveryHost=f.node('host');
  }
  const end=await f.settled(finalize.id);assert.equal(end.execution,expectedState,JSON.stringify(end));if(scenario==='sealed_cancel'||scenario==='sealed_unpair'){assert.equal(end.cancel_requested,1);assert.equal(f.sql(db=>db.prepare("SELECT event_json FROM outbox WHERE operation_id=? AND json_extract(event_json,'$.kind')='succeeded'").get(finalize.id)!.event_json),cancelledOutbox);if(scenario==='sealed_unpair')assert.equal((await f.request('/api/v1/nodes')).nodes.find((n:any)=>n.id===f.identity().node_id).revoked,1);}
  if(scenario==='final_ack_lost'){
   await until(async()=>heldAck,Boolean);const exactOutbox=f.sql(db=>db.prepare("SELECT event_json FROM outbox WHERE operation_id=? AND json_extract(event_json,'$.kind')='succeeded'").get(finalize.id)!.event_json);assert.deepEqual(JSON.parse(String(exactOutbox)),submittedEvent);await kill(recoveryHost.child);allowAck=true;f.intercept();recoveryHost=f.node('host');
   await until(async()=>f.sql(db=>Number(db.prepare('SELECT count(*) AS n FROM outbox WHERE acknowledged=0').get()!.n)),n=>n===0);assert.equal(f.sql(db=>db.prepare("SELECT event_json FROM outbox WHERE operation_id=? AND json_extract(event_json,'$.kind')='succeeded'").get(finalize.id)!.event_json),exactOutbox);
  }
  const result=JSON.parse(end.result_json);assert.equal(result.finalizedReadOnly,true);assert.equal(result.taskAccepted,false);assert.equal(result.outcome.stop,scenario==='budget'?'BudgetExhausted':'AwaitingHostAcceptance');if(scenario==='budget')assert.equal(result.outcome.last_candidate,null);assert.equal(result.finalizationProof.process.kind,'recovered_process_exit');assert.equal(result.finalizationProof.nativeTerminalObserved,false);assert.equal(result.finalizationProof.sourceExecutionId,parent.id);assert.equal(result.finalizationProof.sourceGeneration,1);const seal=result.finalizationProof.inspectionSeal;assert.equal(sha(readFileSync(seal.receipt.path)),seal.receipt.sha256);assert.equal(sha(seal.commitmentJson),seal.commitmentSha256);assert.equal(JSON.parse(readFileSync(seal.receipt.path,'utf8')).commitment_sha256,seal.commitmentSha256);
  const terminalEvents=(await f.events(finalize.id)).filter(event=>['succeeded','failed','cancelled','unknown'].includes(event.kind));assert.equal(terminalEvents.length,1);assert.equal(terminalEvents[0].kind,expectedState);
  const task=await f.request(`/api/v1/operations/${parent.id}/agent-task`);assert.equal(task.phase,'finished');assert.equal(task.recoveryRequired,false);assert.equal(task.activeExecutionId,finalize.id);assert.equal(task.generation,failedAttempt?3:2);assert.deepEqual(await f.operation(parent.id),original);assert.deepEqual(await f.request(`/api/v1/operations/${parent.id}/agent-models`),models);assert.deepEqual(await f.request(`/api/v1/operations/${parent.id}/children`),children);assert.deepEqual(await settledTree(session),beforeSession);assert.deepEqual(tree(evidence),beforeEvidence);assert.equal(sha(readFileSync(join(records,'task.json'))),originalTaskSha);assert.equal(requests.length,expectedCalls);assert.equal(readFileSync(effect,'utf8'),'once\r\n');
  await until(async()=>f.sql(db=>Number(db.prepare('SELECT count(*) AS n FROM outbox WHERE acknowledged=0').get()!.n)),n=>n===0);await f.restartService();assert.deepEqual(await f.request(`/api/v1/operations/${parent.id}/agent-task`),task);
  writeFileSync(join(root,'asserted-native-finalize.json'),JSON.stringify({scope:'actual Node hard exit observed after native Released and before terminal/process-settled; new inspector image reads only',scenario,failedAttempt,inspectorKilled,heldAck,submittedEvent,original,end,result,task,models,children,beforeSession,afterSession:tree(session),beforeEvidence,afterEvidence:tree(evidence),originalTaskSha,releasedSha,modelRequests:requests.length,effect:'once\r\n'},null,2));
 }finally{watcher?.close();if(cleanupFixture)await cleanupFixture.cleanup();provider.close();provider.closeAllConnections();await once(provider,'close');assert.equal(fault,undefined);console.log(JSON.stringify({nativeFinalization:root}));}
});
