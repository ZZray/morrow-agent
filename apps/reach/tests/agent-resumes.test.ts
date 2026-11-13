// Copyright (c) Ray Zhang. Synthetic native attestations over actual local HTTP/SQLite; not native acceptance.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {modelFixture} from './agent-model-fixture.ts';
import {sha256} from '../src/service/store.ts';

async function setup(options:{maxCalls?:number;reserveNext?:boolean}={}){
  const f=await modelFixture({maxRuns:4,maxCalls:options.maxCalls??8,runCallLimit:2,maxSeconds:600});await(await f.model()).text();
  f.store.hello(f.node,'synthetic-schema9',['agent.delegate','agent.resume','file.read']);
  let nextRunId:string|undefined;
  if(options.reserveNext){
    const c=candidate(f,f.runId,1,1,1),r=f.store.reviews.publish(f.node,f.parent.id,{...f.binding,candidate:c,childOperationIds:[]});
    const d=f.store.reviews.decision(f.session.user.id,f.parent.id,{reviewId:randomUUID(),runId:f.runId,basisSha256:r.basisSha256,decision:'continue',feedback:'same Task correction'});nextRunId=d.nextRunId!;f.store.reviews.register(f.node,f.parent.id,{...f.binding,runId:nextRunId});
  }
  f.record(f.dispatch,'unknown',{syntheticLifecycle:true});
  const operation=f.store.submit(f.session.user.id,randomUUID(),f.node.id,{kind:'agent.resume',rootOperationId:f.parent.id,previousExecutionId:f.parent.id,fenceSha256:'a'.repeat(64),instruction:'Synthetic native attestation, never a native test.'}),execution=f.store.claim(f.node)!;assert.equal(execution.operationId,operation.id);f.record(execution,'received');f.record(execution,'running');
  const binding={dispatchId:execution.dispatchId,payloadHash:execution.payloadHash},base=`/api/v1/node/agents/${operation.id}/resume/`,api=(method:string,input:unknown={})=>f.api(base+method,'POST',{...binding,...input as object});
  const planned=await api('plan',{consumedRuns:1,consumedCalls:2});assert.equal(planned.status,200);const plan=JSON.parse(planned.data.planJson),sessionPath=join(f.root,'synthetic-session.json'),deadlineLocalUnixMs=Date.now()+500000;
  const snapshot=await api('snapshot');assert.equal(snapshot.status,200);
  const reviewJson=JSON.stringify({task_id:f.parent.id,session_path:sessionPath,resume_evidence_dir:join(f.root,'synthetic-new-evidence'),fenced_evidence_dir:join(f.root,'synthetic-old-evidence'),fence:{task_id:f.parent.id,authorization_revision:f.parent.payload_hash,max_runs:4,max_calls:f.command.maxCalls,session_path:sessionPath,deadline_unix_ms:deadlineLocalUnixMs},fenced_outcome:null,interrupted_run:null,consumed_runs:1,consumed_calls:2}),reviewSha256=sha256(reviewJson),nativeReceiptJson=JSON.stringify({committed:true,settlement:'Settled',tool_calls:[],evidence:[join(f.root,'synthetic-review.json')]}),ref=(file:string)=>({path:join(f.root,file),sha256:'b'.repeat(64)});
  const reconcile={planSha256:planned.data.planSha256,snapshotSha256:snapshot.data.snapshotSha256,reviewJson,reviewSha256,nativeReceiptJson,nativeReceiptSha256:sha256(nativeReceiptJson),consumption:{receiptId:operation.id,fenceSha256:'a'.repeat(64),reviewSha256,consumedRuns:1,consumedCalls:2,runs:[{runId:f.runId,runNumber:1,effectiveCap:2,calls:2,admission:ref('synthetic-run1-admission.json')}]},originalTask:ref('synthetic-task.json'),review:{path:join(f.root,'synthetic-review.json'),sha256:reviewSha256}};
  const admission=(receiptSha256:string)=>({receiptSha256,runId:plan.runId,fence:ref('synthetic-fence.json'),resume:ref('synthetic-resume.json'),admission:ref('synthetic-run2-admission.json'),nativeAdmission:{task_id:f.parent.id,run_id:plan.runId,run_number:2,criteria_revision:'reach-receipt-integrity-v1',authorization_revision:f.parent.payload_hash,session_path:sessionPath,remaining_calls:Math.min(2,f.command.maxCalls-2),deadline_unix_ms:deadlineLocalUnixMs,max_seconds:400},sessionPath,deadlineLocalUnixMs});
  const commit=()=>api('reconcile',reconcile);
  const admit=async()=>{const r=await commit();assert.equal(r.status,200,JSON.stringify(r));const input=admission(r.data.receiptSha256),a=await api('admit',input);assert.equal(a.status,200,JSON.stringify(a));return{receipt:r.data,input};};
  const model=()=>fetch(f.origin+`/api/v1/node/agents/${operation.id}/model/requests/${randomUUID()}`,{method:'POST',headers:{...f.headers,'x-reach-dispatch-id':execution.dispatchId,'x-reach-payload-hash':execution.payloadHash,'x-reach-run-id':plan.runId},body:JSON.stringify(f.payload())});
  return{f,operation,execution,binding,api,plan,planned,snapshot,reconcile,admission,commit,admit,model,ref,nextRunId};
}
function candidate(f:Awaited<ReturnType<typeof modelFixture>>,runId:string,number:number,runCalls:number,totalCalls:number){return{basis:{task_id:f.parent.id,criteria_revision:'reach-receipt-integrity-v1',authorization_revision:f.parent.payload_hash,run_id:runId,run_number:number,session_path:join(f.root,'synthetic-session.json'),events_path:join(f.root,'synthetic-events.jsonl'),events_sha256:'b'.repeat(64),event_count:3,run_calls:runCalls,total_calls:totalCalls,journal_head_sha256:'c'.repeat(64),raw_start:0,raw_end:2,raw_proof:'journal-v1:'+'d'.repeat(64)},output:'Synthetic service candidate',goal:null};}

test('receipt and admission separately gate effects; exact repeats keep one Run and pending survives activation',async()=>{
  const t=await setup();try{
    const before=t.f.store.budgets.summary(t.f.parent);assert.equal(before.chargedCalls,1);assert.equal(before.runs.length,1);
    const early=await t.model();assert.equal(early.status,409);assert.equal((await early.json() as any).error.code,'agent_execution_reconciling');
    const replies=await Promise.all(Array.from({length:5},()=>t.commit()));assert.ok(replies.every(r=>r.status===200&&r.data.receiptSha256===replies[0].data.receiptSha256));assert.equal(t.f.store.budgets.summary(t.f.parent).chargedCalls,2);assert.equal(t.f.store.budgets.rows(t.f.parent).length,2);
    const still=await t.model();assert.equal(still.status,409);await still.text();
    const input=t.admission(replies[0].data.receiptSha256);assert.equal((await t.api('admit',{...input,sessionPath:'wrong'})).status,409);assert.equal((await t.api('admit',{...input,nativeAdmission:{...input.nativeAdmission,remaining_calls:3}})).status,409);
    const activated=await Promise.all(Array.from({length:5},()=>t.api('admit',input)));assert.ok(activated.every(r=>r.status===200));const result=await t.model();assert.equal(result.status,200);await result.text();
    assert.equal(t.f.store.executions.projection(t.f.session.user.id,t.operation.id).recoveryRequired,true);assert.throws(()=>t.f.store.submit(t.f.session.user.id,randomUUID(),t.f.node.id,t.f.command),/尚未结算/);assert.equal(t.f.upstreamRequests.length,2);
    assert.equal((await t.api('admit',input)).status,200);assert.equal(t.f.store.budgets.rows(t.f.parent).length,2);
    assert.equal((await t.api('reconcile',{...t.reconcile,originalTask:{...t.reconcile.originalTask,sha256:'c'.repeat(64)}})).data.error.code,'agent_resume_receipt_conflict');
  }finally{await t.f.close();}
});

test('a failed receipt transaction leaves consumption, planned slot and phase unchanged',async()=>{
  const t=await setup();try{t.f.store.db.exec("CREATE TEMP TRIGGER reject_resume_receipt BEFORE INSERT ON agent_resume_models BEGIN SELECT RAISE(ABORT,'controlled receipt failure'); END");const before=t.f.store.budgets.summary(t.f.parent);assert.equal((await t.commit()).status,500);assert.deepEqual(t.f.store.budgets.summary(t.f.parent),before);assert.equal(t.f.store.db.prepare('SELECT count(*) AS n FROM agent_resume_receipts').get()!.n,0);assert.equal(t.f.store.executions.projection(t.f.session.user.id,t.operation.id).phase,'reconciling');t.f.store.db.exec('DROP TRIGGER reject_resume_receipt');assert.equal((await t.commit()).status,200);}finally{await t.f.close();}
});

test('a changed historical ledger invalidates an uncommitted snapshot without charging or activating',async()=>{
  const t=await setup();try{t.f.store.db.prepare('UPDATE agent_model_calls SET error_code=? WHERE parent_id=?').run('controlled-original-observation',t.f.parent.id);assert.equal((await t.commit()).data.error.code,'agent_resume_snapshot_changed');assert.equal(t.f.store.budgets.summary(t.f.parent).chargedCalls,1);assert.equal(t.f.store.budgets.rows(t.f.parent).length,1);}finally{await t.f.close();}
});

test('an unadmitted continue slot keeps its original UUID, ordinal and registration while the effective cap shrinks',async()=>{
  const t=await setup({maxCalls:3,reserveNext:true});try{assert.equal(t.plan.runId,t.nextRunId);const before=t.f.store.db.prepare('SELECT * FROM agent_run_origins WHERE run_id=?').get(t.plan.runId)!;assert.equal(before.registered_execution_id,t.f.parent.id);assert.equal(t.f.store.budgets.rows(t.f.parent)[1]!.reserved_cap,2);await t.admit();const row=t.f.store.db.prepare('SELECT * FROM agent_run_origins WHERE run_id=?').get(t.plan.runId)!;assert.equal(row.registered_execution_id,t.f.parent.id);assert.equal(row.admitted_execution_id,t.operation.id);assert.equal(t.f.store.budgets.rows(t.f.parent)[1]!.reserved_cap,2);assert.equal(t.f.store.budgets.rows(t.f.parent)[1]!.admitted_cap,1);assert.equal(t.f.store.budgets.rows(t.f.parent).length,2);}finally{await t.f.close();}
});

test('a new unknown request is never covered by a previous execution reconciliation',async()=>{
  const t=await setup();try{await t.admit();t.f.handle((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"unfinished":true}\n\n');});const response=await t.model();await response.text();assert.equal(t.f.calls().at(-1).state,'unknown');assert.equal(t.f.store.models.unsettled(t.f.parent.id),true);assert.equal(t.f.store.resumes.explainsModel(t.f.parent.id,t.f.calls().at(-1).request_id),false);assert.throws(()=>t.f.store.models.assertSettled(t.f.parent),/未知模型/);}finally{await t.f.close();}
});

test('final proof failure rolls back the original terminal event; exact committed outbox replay releases only once',async()=>{
  const t=await setup();try{
    const admitted=await t.admit(),response=await t.model();assert.equal(response.status,200);await response.text();
    const c=candidate(t.f,t.plan.runId,2,1,3),review=t.f.store.reviews.publish(t.f.node,t.operation.id,{...t.binding,candidate:c,childOperationIds:[]});t.f.store.reviews.decision(t.f.session.user.id,t.operation.id,{reviewId:randomUUID(),runId:t.plan.runId,basisSha256:review.basisSha256,decision:'return_result',feedback:''});
    const snap=await t.api('final-snapshot'),result={taskId:t.f.parent.id,sessionId:t.f.command.sessionId,taskAccepted:false,status:'awaiting_review',childOperationIds:[],outcome:{task_id:t.f.parent.id,task_accepted:false,stop:'AwaitingHostAcceptance',runs:2,observed_calls:3,fence_presence:'Released',last_receipt:{basis:c.basis}},finalProof:{receiptSha256:admitted.receipt.receiptSha256,snapshotSha256:snap.data.snapshotSha256,terminal:t.ref('synthetic-terminal.json'),outcome:t.ref('synthetic-released.json'),lastRunId:t.plan.runId,observedCalls:3,fencePresence:'Released',localCallbacksFinished:true,sidecarJoined:true,ownedProcessesEmpty:true}};
    result.finalProof=Object.fromEntries(Object.entries(result.finalProof).sort(([a],[b])=>a.localeCompare(b))) as typeof result.finalProof; // Ordinary Rust Value emits keys in sorted order.
    const event={operationId:t.operation.id,...t.binding,eventId:randomUUID(),sequence:t.f.store.operation(t.f.session.user.id,t.operation.id).last_sequence+1,kind:'succeeded' as const,data:result};
    assert.throws(()=>t.f.store.record(t.f.node,{...event,data:{...result,finalProof:{...result.finalProof,snapshotSha256:'f'.repeat(64)}}}),/释放前/);assert.equal(t.f.store.executions.projection(t.f.session.user.id,t.operation.id).recoveryRequired,true);assert.equal(t.f.store.db.prepare('SELECT count(*) AS n FROM agent_task_finishes').get()!.n,0);
    assert.equal(t.f.store.record(t.f.node,event).duplicate,false);assert.equal(t.f.store.record(t.f.node,event).duplicate,true);assert.equal(t.f.store.executions.projection(t.f.session.user.id,t.operation.id).recoveryRequired,false);assert.equal(t.f.store.db.prepare('SELECT count(*) AS n FROM agent_task_finishes').get()!.n,1);
    writeFileSync(join(t.f.root,'asserted-schema9-release.json'),JSON.stringify({scope:'synthetic native proof, real service transaction',event,proofRows:t.f.store.db.prepare('SELECT * FROM agent_task_finishes').all()},null,2));await t.f.reopen();assert.equal(t.f.store.executions.projection(t.f.session.user.id,t.operation.id).recoveryRequired,false);
  }finally{await t.f.close();}
});

test('final snapshot waits for the actual owner join transition before freezing its proof',async()=>{
  const t=await setup();try{await t.admit();const response=await t.model();assert.equal(response.status,200);await response.text();const current=t.f.calls().at(-1),owner=t.f.store.db.prepare('SELECT * FROM agent_model_owners WHERE parent_id=? AND request_id=?').get(t.f.parent.id,current.request_id)!;
    // Materialize the real broker window: stream_complete is durable before joined.
    t.f.store.db.prepare("UPDATE agent_model_owners SET phase='admitted',joined_at=NULL WHERE parent_id=? AND request_id=?").run(t.f.parent.id,current.request_id);
    assert.deepEqual((await t.api('final-snapshot')).data,{ready:false});t.f.store.models.joined(t.f.parent.id,current.request_id,{instanceId:String(owner.instance_id),executionId:t.operation.id,generation:2,routeHash:t.f.routeHash,runId:t.plan.runId,bodySha256:current.body_sha256});const a=await t.api('final-snapshot');assert.equal(a.data.ready,true);assert.deepEqual((await t.api('final-snapshot')).data,a.data);
  }finally{await t.f.close();}
});

test('schema9 rejects a deleted original Run instead of reconstructing it from child effects',async()=>{
  const t=await setup();try{const args=JSON.stringify({command:{kind:'file.read',path:'synthetic.txt'}});await t.admit();const child=t.f.store.agents.create(t.f.node,t.operation.id,{...t.binding,runId:t.plan.runId,callId:'new-call',tool:'reach_execute',argsSha256:sha256(args),argumentsJson:args});t.f.record(child.operation,'received');t.f.record(child.operation,'running');t.f.record(child.operation,'succeeded',{synthetic:true});
    t.f.store.db.exec('PRAGMA foreign_keys=OFF');t.f.store.db.prepare('DELETE FROM agent_run_origins WHERE parent_id=? AND run_id=?').run(t.f.parent.id,t.plan.runId);t.f.store.db.prepare('DELETE FROM agent_run_budgets WHERE parent_id=? AND run_id=?').run(t.f.parent.id,t.plan.runId);t.f.store.db.prepare('DELETE FROM agent_runs WHERE parent_id=? AND run_id=?').run(t.f.parent.id,t.plan.runId);await assert.rejects(t.f.reopen(),/缺少原 Run/);
  }finally{await t.f.close();}
});

test('a later execution model stop binds the original generation and really joins the broker transport',async()=>{
  const t=await setup();try{await t.admit();let reached=false;t.f.handle((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"id":"late-model","choices":[{"index":0,"delta":{"content":"in flight"},"finish_reason":null}]}\n\n');reached=true;});const response=await t.model(),reader=response.body!.getReader();await reader.read();assert.equal(reached,true);t.f.record(t.execution,'unknown',{syntheticLifecycle:true});const current=t.f.calls().at(-1),owner=t.f.store.db.prepare('SELECT * FROM agent_model_owners WHERE parent_id=? AND request_id=?').get(t.f.parent.id,current.request_id)!;
    const stopped=await t.f.api(`/api/v1/operations/${t.operation.id}/agent-models`,'POST',{...t.binding,reconciliationId:randomUUID(),requestId:current.request_id,runId:t.plan.runId,bodySha256:current.body_sha256,ownerInstanceId:owner.instance_id,decision:'transport_stopped',evidence:'Synthetic parent stop while the real local model SSE transport is active; wait for its actual join.'},t.f.session.token);assert.equal(stopped.status,200,JSON.stringify(stopped));assert.equal(stopped.data.executionId,t.operation.id);assert.equal(stopped.data.generation,2);assert.equal(stopped.data.transportStopped,true);assert.equal(t.f.calls().at(-1).state,'unknown');assert.equal(t.f.store.db.prepare('SELECT phase FROM agent_model_owners WHERE parent_id=? AND request_id=?').get(t.f.parent.id,current.request_id)!.phase,'joined');await reader.cancel().catch(()=>{});
  }finally{await t.f.close();}
});

test('the saved schema8 implementation migrates gen1 Run ownership even when a queued gen2 already exists',async()=>{
  const module=pathToFileURL(join(import.meta.dirname,'fixtures/historical/schema8/src/service/store.ts')).href,Old=await import(module),f=await modelFixture();let legacy:any;
  try{
    const filename=join(f.root,'actual-schema8.sqlite');legacy=new Old.ReachStore(filename);legacy.bootstrap('old-eight','schema8-local-password');const user=legacy.login('old-eight','schema8-local-password'),secret='schema8-installation-secret-value',paired=legacy.pair({attemptId:randomUUID(),code:legacy.createPairing(user.user.id).code,installationId:randomUUID(),installationSecret:secret,name:'synthetic old Node',platform:'windows',version:'schema8'}),node=legacy.node(secret);legacy.hello(node,'schema8',['agent.delegate','agent.resume','file.read']);
    const op=legacy.submit(user.user.id,randomUUID(),paired.nodeId,{...f.command,sessionId:randomUUID()}),d=legacy.claim(node),record=(dispatch:any,kind:string,data:unknown={})=>legacy.record(node,{operationId:dispatch.operationId,dispatchId:dispatch.dispatchId,payloadHash:dispatch.payloadHash,eventId:randomUUID(),sequence:legacy.operation(user.user.id,dispatch.operationId).last_sequence+1,kind,data});record(d,'received');record(d,'running');
    const args=JSON.stringify({command:{kind:'file.read',path:'synthetic.txt'}}),runId=randomUUID(),child=legacy.agents.create(node,op.id,{dispatchId:d.dispatchId,payloadHash:d.payloadHash,runId,callId:'legacy-call',tool:'reach_execute',argumentsJson:args,argsSha256:sha256(args)}).operation;record(child,'received');record(child,'running');record(child,'succeeded',{synthetic:true});record(d,'unknown',{synthetic:true});
    const attempt=legacy.submit(user.user.id,randomUUID(),paired.nodeId,{kind:'agent.resume',rootOperationId:op.id,previousExecutionId:op.id,fenceSha256:'a'.repeat(64),instruction:'Queued schema8 recovery without native admission.'});assert.equal(legacy.db.prepare('PRAGMA user_version').get().user_version,8);const original=JSON.parse(JSON.stringify(legacy.operations(user.user.id)));legacy.close();legacy=undefined;
    const Current=(await import('../src/service/store.ts')).ReachStore,store=new Current(filename);try{assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version,11);assert.deepEqual(JSON.parse(JSON.stringify(store.operations(user.user.id))),original);const origin=store.db.prepare('SELECT * FROM agent_run_origins WHERE parent_id=? AND run_id=?').get(op.id,runId)!;assert.equal(origin.registered_execution_id,op.id);assert.equal(origin.registered_generation,1);assert.equal(origin.admitted_execution_id,null);assert.equal(store.executions.projection(user.user.id,op.id).activeExecutionId,attempt.id);assert.equal(store.executions.projection(user.user.id,op.id).recoveryRequired,true);}finally{store.close();}assert.throws(()=>new Old.ReachStore(filename),/newer than/);
  }finally{legacy?.close();await f.close();}
});
