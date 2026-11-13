// Copyright (c) Ray Zhang. Real HTTP model reservations; synthetic Node review observations.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
import {modelFixture} from './agent-model-fixture.ts';
import {fixture as serviceFixture} from './service-fixture.ts';

test('the original Task total and fixed per-Run call limit are checked before any extra upstream reservation',async()=>{const f=await modelFixture({maxRuns:2,maxCalls:3,runCallLimit:1});try{
  const first=await f.model();assert.equal(first.status,200);await first.text();const over=await f.model();assert.equal(over.status,409);assert.equal((await over.json() as any).error.code,'agent_run_model_budget');assert.equal(f.calls().length,1);assert.equal(f.upstreamRequests.length,1);
  assert.throws(()=>f.store.submit(f.session.user.id,randomUUID(),f.node.id,{...f.command,sessionId:randomUUID(),runCallLimit:4}),/单 Run/);assert.equal(f.store.operations(f.session.user.id).length,1);assert.equal(f.calls()[0].usage_json,null);
}finally{await f.close();}});

test('schema4 budget subjects migrate without rewriting original receipts',async()=>{const f=await modelFixture({maxRuns:2,maxCalls:3,runCallLimit:1});try{
  await(await f.model()).text();const snapshot={basis:{task_id:f.parent.id,criteria_revision:'reach-receipt-integrity-v1',authorization_revision:f.dispatch.payloadHash,run_id:f.runId,run_number:1,session_path:join(f.root,'session.json'),events_path:join(f.root,'events.jsonl'),events_sha256:'a'.repeat(64),event_count:3,run_calls:1,total_calls:1,journal_head_sha256:'b'.repeat(64),raw_start:0,raw_end:3,raw_proof:'journal-v1:'+'c'.repeat(64)},diagnostic_output:'Original closed budget diagnostic.',goal:null,termination:{version:1,cause:'call_budget_exhausted',native_round_closed:true,model_final_stop:false}};
  const published=await f.api(`/api/v1/node/agents/${f.parent.id}/reviews`,'POST',{...f.binding,snapshot,childOperationIds:[]});assert.equal(published.status,200);const path=`/api/v1/operations/${f.parent.id}/agent-reviews`,before={parent:f.store.operation(f.session.user.id,f.parent.id),events:f.store.events(f.session.user.id,f.parent.id),models:f.calls(),reviews:(await f.api(path,'GET',undefined,f.session.token)).data};f.store.db.exec('PRAGMA user_version=4');await f.reopen();assert.equal(f.store.db.prepare('PRAGMA user_version').get()!.user_version,11);assert.deepEqual(f.store.operation(f.session.user.id,f.parent.id),before.parent);assert.deepEqual(f.store.events(f.session.user.id,f.parent.id),before.events);assert.deepEqual(f.calls(),before.models);assert.deepEqual((await f.api(path,'GET',undefined,f.session.token)).data,before.reviews);
}finally{await f.close();}});

const previousServiceModule=process.env.REACH_PREVIOUS_SERVICE_MODULE;
test('an explicitly supplied frozen schema4 service rejects the current database',{skip:!previousServiceModule},async()=>{
  assert.ok(previousServiceModule&&isAbsolute(previousServiceModule));assert.equal(createHash('sha256').update(readFileSync(previousServiceModule)).digest('hex'),'ffce8452517461eec645f8559984b383616cde2e50405736c5135a64328223f9','Supply the exact historical schema4 service fixture');
  const f=await serviceFixture();try{const before=f.store.db.prepare('SELECT * FROM users ORDER BY id').all();const Old=await import(pathToFileURL(previousServiceModule).href);assert.throws(()=>new Old.ReachStore(f.database),/newer than/);assert.equal(f.store.db.prepare('PRAGMA user_version').get()!.user_version,11);assert.deepEqual(f.store.db.prepare('SELECT * FROM users ORDER BY id').all(),before);}finally{await f.cleanup();}
});

test('closed-budget review has an exact native subject kind and cannot replace or masquerade as a candidate',async()=>{const f=await modelFixture({maxRuns:2,maxCalls:3,runCallLimit:1});try{
  await(await f.model()).text();const snapshot={basis:{task_id:f.parent.id,criteria_revision:'reach-receipt-integrity-v1',authorization_revision:f.dispatch.payloadHash,run_id:f.runId,run_number:1,session_path:join(f.root,'native-session.json'),events_path:join(f.root,'native-events.jsonl'),events_sha256:'a'.repeat(64),event_count:3,run_calls:1,total_calls:1,journal_head_sha256:'b'.repeat(64),raw_start:0,raw_end:3,raw_proof:'journal-v1:'+'c'.repeat(64)},diagnostic_output:'Controlled Host observation; not a model final answer.',goal:null,termination:{version:1,cause:'call_budget_exhausted',native_round_closed:true,model_final_stop:false}},publish={...f.binding,snapshot,childOperationIds:[]},path=`/api/v1/node/agents/${f.parent.id}/reviews`;
  assert.equal((await f.api(path,'POST',{...publish,snapshot:{...snapshot,termination:{...snapshot.termination,model_final_stop:true}}})).status,400);const ordinary={basis:snapshot.basis,output:'fake ordinary conversion',goal:null};assert.equal((await f.api(path,'POST',{...publish,candidate:ordinary})).status,400);
  const response=await f.api(path,'POST',publish);assert.equal(response.status,200);const review=response.data;assert.equal(review.subjectKind,'closed_budget');assert.equal(review.candidate,undefined);assert.deepEqual(review.snapshot,snapshot);assert.equal((await f.api(path,'POST',{...f.binding,candidate:ordinary,childOperationIds:[]})).status,409);
  const decided=await f.api(`/api/v1/operations/${f.parent.id}/agent-reviews`,'POST',{reviewId:randomUUID(),runId:f.runId,basisSha256:review.basisSha256,decision:'continue',feedback:'Continue from the original closed native round.'},f.session.token);assert.equal(decided.status,200);const next=decided.data.nextRunId;assert.equal((await f.api(`/api/v1/node/agents/${f.parent.id}/runs`,'POST',{...f.binding,runId:next})).status,200);
  const second=await f.model(randomUUID(),f.payload(),{'x-reach-run-id':next});assert.equal(second.status,200);await second.text();assert.equal((await f.model(randomUUID(),f.payload(),{'x-reach-run-id':next})).status,409);assert.equal(f.calls().length,2);assert.equal(f.upstreamRequests.length,2);
}finally{await f.close();}});
