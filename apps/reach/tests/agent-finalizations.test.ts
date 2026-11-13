// Copyright (c) Ray Zhang. Synthetic native references over actual HTTP/SQLite; native/process acceptance is separate.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {modelFixture,until} from './agent-model-fixture.ts';
import {agentFinalizeSchema} from '../src/contracts/protocol.ts';
import {sha256} from '../src/service/store.ts';

async function setup(){
 const f=await modelFixture({maxRuns:1,maxCalls:4,runCallLimit:2});await(await f.model()).text();await until(()=>f.store.db.prepare('SELECT phase FROM agent_model_owners WHERE parent_id=?').get(f.parent.id)?.phase==='joined');
 const reference=(name:string)=>({path:join(f.root,'synthetic-'+name),sha256:'b'.repeat(64)}),owner=reference('sidecar-owner.json');f.record(f.dispatch,'output',{type:'agent.process_owner',taskId:f.parent.id,executionId:f.parent.id,processOwner:owner});f.record(f.dispatch,'unknown',{syntheticLifecycle:true});f.store.hello(f.node,'synthetic-finalizer',['agent.delegate','agent.resume','agent.finalize','file.read']);
 const command=agentFinalizeSchema.parse({kind:'agent.finalize',rootOperationId:f.parent.id,previousExecutionId:f.parent.id,sourceExecutionId:f.parent.id,releasedSha256:'a'.repeat(64)}),operation=f.store.submit(f.session.user.id,randomUUID(),f.node.id,command),execution=f.store.claim(f.node)!;assert.equal(execution.operationId,operation.id);f.record(execution,'received');f.record(execution,'running');const binding={dispatchId:execution.dispatchId,payloadHash:execution.payloadHash};
 const api=(method:string,value:unknown={})=>f.api(`/api/v1/node/agents/${operation.id}/finalize/${method}`,'POST',{...binding,...value as object});
 const build=async(stop='AwaitingHostAcceptance',sealedState=stop==='AwaitingHostAcceptance'?'succeeded':'failed')=>{
  const envelope=await api('snapshot');assert.equal(envelope.status,200);assert.equal(envelope.data.ready,true);const released={...reference('released.json'),sha256:'a'.repeat(64)},inspection=reference('inspection.json');
  const basis={task_id:f.parent.id,authorization_revision:f.parent.payload_hash,criteria_revision:'reach-receipt-integrity-v1',run_id:f.runId};
  const result:any={taskId:f.parent.id,sessionId:f.command.sessionId,taskAccepted:false,finalizedReadOnly:true,status:stop==='AwaitingHostAcceptance'?'awaiting_review':'budget_or_feedback_incomplete',childOperationIds:[],outcome:{task_id:f.parent.id,task_accepted:false,fence_presence:'Released',reconciliation_fence:null,runs:1,observed_calls:1,stop,last_receipt:{basis}},finalizationProof:{version:1,sourceExecutionId:f.parent.id,sourceGeneration:1,snapshotSha256:envelope.data.snapshotSha256,released,originalOutcome:reference('outcome.json'),originalTask:reference('task.json'),sourceTask:reference('task.json'),review:reference('review.json'),inspection,inspectionRequestSha256:'c'.repeat(64),leaseId:'x'.repeat(43),inspectorSha256:'d'.repeat(64),sessionStateSha256:'e'.repeat(64),lastRunId:f.runId,consumption:{receiptId:operation.id,released,inspectionSha256:inspection.sha256,consumedRuns:1,consumedCalls:1,runs:[{runId:f.runId,runNumber:1,effectiveCap:2,calls:1,admission:reference('admission.json'),observation:reference('observation.json')}]},process:{kind:'recovered_process_exit',owner,observation:reference('exit-observation.json')},callbackDisposition:'source_owner_exited',nativeTerminalObserved:false}};
  const commitmentJson=JSON.stringify({version:1,taskId:f.parent.id,executionId:operation.id,sourceExecutionId:f.parent.id,sourceGeneration:1,generation:2,dispatchId:execution.dispatchId,payloadHash:execution.payloadHash,nodeId:f.node.id,epoch:f.node.epoch,state:sealedState,result});
  result.finalizationProof.inspectionSeal={version:1,receipt:reference('seal.json'),commitmentJson,commitmentSha256:sha256(commitmentJson)};return result;
 };
 return{f,reference,owner,command,operation,execution,binding,api,build};
}

test('finalizer advances service generation without a native Run; all effect admission APIs remain shut even after deadline',async()=>{
 const t=await setup();try{
  const original=t.f.store.operation(t.f.session.user.id,t.f.parent.id),models=t.f.calls(),budgets=t.f.store.budgets.summary(t.f.parent),now=t.f.store.now;t.f.store.now=()=>original.claimed_at!+700000;
  const context=await t.api('context');assert.equal(context.status,200);assert.equal(context.data.sourceExecutionId,t.f.parent.id);assert.equal(context.data.phase,'finalizing');assert.equal(context.data.parentDeadlineUnixMs,original.claimed_at!+t.f.command.maxSeconds*1000);
  const base=`/api/v1/node/agents/${t.operation.id}`,args=JSON.stringify({command:{kind:'file.read',path:'never.txt'}});
  for(const [route,input]of [['model/route',{}],['runs',{runId:randomUUID()}],['calls',{runId:t.f.runId,callId:'never',tool:'reach_execute',argsSha256:sha256(args),argumentsJson:args}],['resume/plan',{consumedRuns:1,consumedCalls:1}] ] as const){const response=await t.f.api(base+'/'+route,'POST',{...t.binding,...input});assert.equal(response.status,409,JSON.stringify(response));}
  assert.deepEqual(t.f.calls(),models);assert.deepEqual(t.f.store.budgets.summary(t.f.parent),budgets);assert.deepEqual(t.f.store.operation(t.f.session.user.id,t.f.parent.id),original);assert.equal(t.f.store.executions.projection(t.f.session.user.id,t.operation.id).recoveryRequired,true);t.f.store.now=now;
 }finally{await t.f.close();}
});

test('read-only finalization commits one original event and finish atomically, preserving source unknown and original Run owner',async()=>{
 const t=await setup();try{
  const original=t.f.store.operation(t.f.session.user.id,t.f.parent.id),result=await t.build();
  const event={operationId:t.operation.id,...t.binding,eventId:randomUUID(),sequence:t.f.store.operation(t.f.session.user.id,t.operation.id).last_sequence+1,kind:'succeeded' as const,data:result};
  assert.equal(t.f.store.record(t.f.node,event).duplicate,false);assert.equal(t.f.store.record(t.f.node,event).duplicate,true);assert.deepEqual(t.f.store.operation(t.f.session.user.id,t.f.parent.id),original);assert.equal(t.f.store.db.prepare('SELECT registered_execution_id FROM agent_run_origins').get()!.registered_execution_id,t.f.parent.id);assert.equal(t.f.store.budgets.rows(t.f.parent).length,1);assert.equal(t.f.calls().length,1);
  const task=t.f.store.executions.projection(t.f.session.user.id,t.operation.id);assert.equal(task.phase,'finished');assert.equal(task.generation,2);assert.equal(task.recoveryRequired,false);await t.f.reopen();assert.deepEqual(t.f.store.executions.projection(t.f.session.user.id,t.operation.id),task);
  const next=t.f.store.submit(t.f.session.user.id,randomUUID(),t.f.node.id,t.f.command);assert.notEqual(next.id,t.f.parent.id);
 }finally{await t.f.close();}
});

test('wrong proof or failed final transaction cannot clear pending or charge the native prefix',async()=>{
 const t=await setup();try{const data=await t.build(),before=t.f.store.budgets.summary(t.f.parent);assert.throws(()=>t.f.record(t.execution,'succeeded',{...data,finalizationProof:{...data.finalizationProof,released:{...data.finalizationProof.released,sha256:'f'.repeat(64)}}}),/Released/);
  t.f.store.db.exec("CREATE TEMP TRIGGER reject_finish BEFORE INSERT ON agent_task_finishes BEGIN SELECT RAISE(ABORT,'controlled final rollback'); END");assert.throws(()=>t.f.record(t.execution,'succeeded',data),/controlled final rollback/);assert.deepEqual(t.f.store.budgets.summary(t.f.parent),before);assert.equal(t.f.store.db.prepare('SELECT proof_json FROM agent_finalizers').get()!.proof_json,null);assert.equal(t.f.store.executions.projection(t.f.session.user.id,t.operation.id).recoveryRequired,true);t.f.store.db.exec('DROP TRIGGER reject_finish');t.f.record(t.execution,'succeeded',data);assert.equal(t.f.store.executions.projection(t.f.session.user.id,t.operation.id).recoveryRequired,false);
 }finally{await t.f.close();}
});

test('native BudgetExhausted remains a known incomplete result when readonly finalization releases the Session',async()=>{
 const t=await setup();try{const wrong=await t.build('BudgetExhausted','succeeded');assert.throws(()=>t.f.record(t.execution,'succeeded',wrong),/未完成/);t.f.record(t.execution,'failed',await t.build('BudgetExhausted'));assert.equal(t.f.store.executions.projection(t.f.session.user.id,t.operation.id).recoveryRequired,false);assert.equal(t.f.store.operation(t.f.session.user.id,t.operation.id).execution,'failed');}finally{await t.f.close();}
});

test('missing owner or unknown effects stay blocked; cancelled finalizers can form a later readonly generation',async()=>{
 const t=await setup();try{t.f.store.db.prepare("DELETE FROM operation_events WHERE operation_id=? AND kind='output'").run(t.f.parent.id);assert.equal((await t.api('context')).data.error.code,'agent_finalizer_legacy_owner');t.f.record(t.execution,'unknown',{syntheticLifecycle:true});const next=t.f.store.submit(t.f.session.user.id,randomUUID(),t.f.node.id,{...t.command,previousExecutionId:t.operation.id});assert.equal(t.f.store.executions.projection(t.f.session.user.id,next.id).generation,3);assert.equal(t.f.store.executions.projection(t.f.session.user.id,next.id).recoveryRequired,true);assert.throws(()=>t.f.store.submit(t.f.session.user.id,randomUUID(),t.f.node.id,t.f.command),/尚未结算/);
 }finally{await t.f.close();}
});

test('a seal cannot authorize a modified result or a different finalizer generation',async()=>{
 const t=await setup();try{const data=await t.build();data.outcome.last_receipt.note='changed after native seal';assert.throws(()=>t.f.record(t.execution,'succeeded',data),/封存/);assert.equal(t.f.store.executions.projection(t.f.session.user.id,t.operation.id).recoveryRequired,true);assert.equal(t.f.store.db.prepare('SELECT count(*) AS n FROM agent_task_finishes').get()!.n,0);}finally{await t.f.close();}
});

test('cancellation blocks new inspection but cannot strand an exact sealed original terminal event',async()=>{
 const t=await setup();try{const data=await t.build(),models=t.f.calls();t.f.store.cancel(t.f.session.user.id,t.operation.id);assert.equal((await t.api('context')).status,409);assert.equal((await t.api('snapshot')).status,409);assert.throws(()=>t.f.record(t.execution,'succeeded',{...data,status:'modified'}),/封存/);t.f.record(t.execution,'succeeded',data);const task=t.f.store.executions.projection(t.f.session.user.id,t.operation.id);assert.equal(task.recoveryRequired,false);assert.equal(t.f.store.operation(t.f.session.user.id,t.operation.id).cancel_requested,1);assert.deepEqual(t.f.calls(),models);await t.f.reopen();assert.deepEqual(t.f.store.executions.projection(t.f.session.user.id,t.operation.id),task);assert.equal(t.f.store.db.prepare('SELECT count(*) AS n FROM agent_task_finishes').get()!.n,1);}finally{await t.f.close();}
});

test('unpair preserves receipt-only settlement of the exact sealed current-epoch result without reactivating the Node',async()=>{
 const t=await setup();try{const data=await t.build(),models=t.f.calls();t.f.store.revoke(t.f.session.user.id,t.f.node.id);for(const method of ['context','snapshot']){const blocked=await t.api(method);assert.equal(blocked.status,409);assert.equal(blocked.data.error.code,'agent_finalizer_inactive');}assert.equal(t.f.store.operation(t.f.session.user.id,t.operation.id).delivery,'uncertain');const event={operationId:t.operation.id,...t.binding,eventId:randomUUID(),sequence:3,kind:'succeeded',data};const accepted=await t.f.api('/api/v1/node/events','POST',event);assert.equal(accepted.status,200,JSON.stringify(accepted));assert.equal((await t.f.api('/api/v1/node/events','POST',event)).data.duplicate,true);assert.equal(t.f.store.ownedNode(t.f.session.user.id,t.f.node.id).revoked,1);assert.equal(t.f.store.executions.projection(t.f.session.user.id,t.operation.id).recoveryRequired,false);assert.deepEqual(t.f.calls(),models);await t.f.reopen();assert.equal(t.f.store.executions.projection(t.f.session.user.id,t.operation.id).recoveryRequired,false);}finally{await t.f.close();}
});

test('generic reconciliation cannot replace any finalizer terminal or strand its original sealed outbox',async()=>{
 const t=await setup();try{const data=await t.build();t.f.store.revoke(t.f.session.user.id,t.f.node.id);const before=t.f.store.operation(t.f.session.user.id,t.operation.id);for(const decision of ['failed','not_executed','succeeded']){const response=await t.f.api(`/api/v1/operations/${t.operation.id}/reconcile`,'POST',{...t.binding,reconciliationId:randomUUID(),decision,evidence:'Controlled finalizer reconciliation rejection fixture.',result:{synthetic:true}},t.f.session.token);assert.equal(response.status,409);assert.equal(response.data.error.code,'agent_finalizer_outbox_required');assert.deepEqual(t.f.store.operation(t.f.session.user.id,t.operation.id),before);}assert.equal(t.f.store.db.prepare('SELECT count(*) AS n FROM operation_reconciliations WHERE operation_id=?').get(t.operation.id)!.n,0);t.f.record(t.execution,'succeeded',data);assert.equal(t.f.store.executions.projection(t.f.session.user.id,t.operation.id).recoveryRequired,false);}finally{await t.f.close();}
});
