// Copyright (c) Ray Zhang. Original HTTP/store feedback relationships, not a native runtime fixture.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {modelFixture} from './agent-model-fixture.ts';

async function reviewed(){
  const f=await modelFixture({maxRuns:3,maxCalls:6}),parentPath=`/api/v1/node/agents/${f.parent.id}`,reviewsPath=`/api/v1/operations/${f.parent.id}/agent-reviews`;
  assert.equal((await f.api(parentPath+'/runs','POST',{...f.binding,runId:f.runId})).status,200);await(await f.model()).text();
  const basis={task_id:f.parent.id,criteria_revision:'reach-receipt-integrity-v1',authorization_revision:f.dispatch.payloadHash,run_id:f.runId,run_number:1,session_path:join(f.root,'session.json'),events_path:join(f.root,'events.jsonl'),events_sha256:'a'.repeat(64),event_count:3,run_calls:1,total_calls:1,journal_head_sha256:'b'.repeat(64),raw_start:0,raw_end:2,raw_proof:'journal-v1:'+'c'.repeat(64)},candidate={basis,output:'Controlled store candidate, not native evidence.',goal:null},publication={...f.binding,candidate,childOperationIds:[]};
  const publish=()=>f.api(parentPath+'/reviews','POST',publication),published=await publish();assert.equal(published.status,200);const row=published.data;
  const input={reviewId:randomUUID(),runId:f.runId,basisSha256:row.basisSha256,decision:'continue',feedback:'Read the original result and correct the conclusion.'};
  const decide=(value:any=input,token=f.session.token)=>f.api(reviewsPath,'POST',value,token);
  return{f,parentPath,reviewsPath,basis,publication,publish,row,input,decide};
}

test('candidate feedback commits once under concurrency, survives reopen and reserves the next original Run',{timeout:20000},async()=>{const t=await reviewed(),{f}=t;try{
  assert.equal((await t.publish()).data.basisSha256,t.row.basisSha256);assert.equal((await f.api(t.parentPath+'/reviews','POST',{...t.publication,candidate:{...t.publication.candidate,output:'changed'}})).status,409);
  const early=await f.api(t.parentPath+'/runs','POST',{...f.binding,runId:randomUUID()});assert.equal(early.data.error.code,'agent_run_feedback_required');
  const results=await Promise.all(Array.from({length:6},()=>t.decide()));assert.ok(results.every(r=>r.status===200));const decision=results[0].data;assert.ok(results.every(r=>JSON.stringify(r.data)===JSON.stringify(decision)));assert.equal(decision.taskAccepted,false);assert.equal((await t.decide({...t.input,reviewId:randomUUID()})).status,409);
  await f.reopen();const listed=await f.api(t.reviewsPath,'GET',undefined,f.session.token);assert.equal(listed.data.reviews.length,1);assert.deepEqual(listed.data.reviews[0].decision,decision);assert.deepEqual((await t.decide()).data,decision);
  const binding={...f.binding,runId:decision.nextRunId},registered=await f.api(t.parentPath+'/runs','POST',binding);assert.equal(registered.status,200);assert.equal(registered.data.runNumber,2);assert.equal(registered.data.remainingCalls,5);assert.deepEqual((await f.api(t.parentPath+'/runs','POST',binding)).data,registered.data);
  assert.equal((await f.api(t.parentPath+'/runs','POST',{...f.binding,runId:randomUUID()})).status,409);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM agent_runs WHERE parent_id=?').get(f.parent.id)!.n,2);assert.equal(f.calls().length,1);
  writeFileSync(join(f.root,'asserted-reviews.json'),JSON.stringify({concurrentDecisions:6,decision,registered:registered.data,source:'store/HTTP fixture; not native execution'},null,2));
}finally{await f.close();}});

test('review account, exact basis, cancellation, epoch and deadline gates prevent new continuation decisions',{timeout:20000},async()=>{const t=await reviewed(),{f}=t;try{
  assert.equal((await t.decide({...t.input,basisSha256:'0'.repeat(64)})).status,409);assert.equal((await t.decide({...t.input,feedback:''})).status,400);assert.equal((await t.decide({...t.input,feedback:'\ud800'})).status,400);assert.equal((await t.decide(t.input,f.nodeToken)).status,401);
  const otherId=randomUUID();f.store.db.prepare('INSERT INTO users SELECT ?,?,salt,password_hash FROM users WHERE id=?').run(otherId,'other-reviewer',f.session.user.id);const other=f.store.login('other-reviewer','local-model-fixture-password');assert.equal((await t.decide(t.input,other.token)).status,404);
  const now=f.store.now;f.store.now=()=>now()+700000;assert.equal((await t.decide()).data.error.code,'agent_deadline');f.store.now=now;
  f.store.cancel(f.session.user.id,f.parent.id);assert.equal((await t.decide()).data.error.code,'agent_parent_inactive');assert.equal((await f.api(t.reviewsPath,'GET',undefined,f.session.token)).data.reviews[0].decision,null);
  f.store.revoke(f.session.user.id,f.node.id);assert.equal((await t.decide()).status,409);const original=await f.api(t.parentPath+'/reviews/'+f.runId,'POST',f.binding);assert.equal(original.status,200);assert.equal(original.data.decision,null);assert.equal(f.calls().length,1);
}finally{await f.close();}});

test('failed decision transaction retains the pending candidate and no next Run is invented',{timeout:20000},async()=>{const t=await reviewed(),{f}=t;try{
  f.store.db.exec("CREATE TEMP TRIGGER fail_review_decision BEFORE UPDATE OF decision_json ON agent_run_reviews BEGIN SELECT RAISE(ABORT,'controlled decision commit failure'); END");assert.equal((await t.decide()).status,500);assert.equal((await f.api(t.reviewsPath,'GET',undefined,f.session.token)).data.reviews[0].decision,null);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM agent_runs WHERE parent_id=?').get(f.parent.id)!.n,1);f.store.db.exec('DROP TRIGGER fail_review_decision');assert.equal((await t.decide()).status,200);
  const original={operation:f.store.operation(f.session.user.id,f.parent.id),events:f.store.events(f.session.user.id,f.parent.id),reviews:(await f.api(t.reviewsPath,'GET',undefined,f.session.token)).data};await f.reopen();assert.deepEqual(f.store.operation(f.session.user.id,f.parent.id),original.operation);assert.deepEqual(f.store.events(f.session.user.id,f.parent.id),original.events);assert.deepEqual((await f.api(t.reviewsPath,'GET',undefined,f.session.token)).data,original.reviews);assert.equal(f.store.db.prepare('PRAGMA user_version').get()!.user_version,11);
  writeFileSync(join(f.root,'asserted-reviews.json'),JSON.stringify({rollback:true,originalReceiptsPreserved:true,reviewPreserved:true},null,2));
}finally{await f.close();}});

test('published Run candidates seal new model and tool effects before and after the continuation decision',{timeout:20000},async()=>{const t=await reviewed(),{f}=t;try{
  for(const stage of ['pending','continue']){
    if(stage==='continue')assert.equal((await t.decide()).status,200);
    const blocked=await f.model();assert.equal(blocked.status,409);assert.equal((await blocked.json() as any).error.code,'agent_run_sealed');assert.throws(()=>f.createTool(),/已发布原候选/);assert.equal(f.calls().length,1);assert.equal(f.store.agents.list(f.parent).length,0);assert.equal(f.upstreamRequests.length,1);
  }
  const next=(await t.decide()).data.nextRunId;assert.equal((await f.api(t.parentPath+'/runs','POST',{...f.binding,runId:next})).status,200);const response=await f.model(randomUUID(),f.payload(),{'x-reach-run-id':next});assert.equal(response.status,200);await response.text();assert.equal(f.calls().length,2);
  const nextCandidate={...t.publication,candidate:{basis:{...t.basis,run_id:next,run_number:2,run_calls:1,total_calls:2,raw_start:2,raw_end:4},output:'next store candidate',goal:null}},published=await f.api(t.parentPath+'/reviews','POST',nextCandidate);assert.equal(published.status,200);const returned=await t.decide({reviewId:randomUUID(),runId:next,basisSha256:published.data.basisSha256,decision:'return_result'});assert.equal(returned.status,200);
  const blocked=await f.model(randomUUID(),f.payload(),{'x-reach-run-id':next});assert.equal(blocked.status,409);assert.equal(f.calls().length,2);assert.equal(f.upstreamRequests.length,2);assert.equal((await f.model()).status,409);
}finally{await f.close();}});

test('pairing again does not let the new epoch decide an older pending Run candidate',{timeout:20000},async()=>{const t=await reviewed(),{f}=t;try{
  const original=(await f.api(t.reviewsPath,'GET',undefined,f.session.token)).data;
  f.record(f.dispatch,'failed',{fixtureOnly:true,reason:'Explicitly settled old attempt before re-pair; original pending review remains historical'});
  const paired=f.store.pair({attemptId:randomUUID(),code:f.store.createPairing(f.session.user.id).code,installationId:f.node.installation_id,installationSecret:f.nodeToken,name:'Paired again',platform:'windows',version:'local-review-test'},f.nodeToken);assert.equal(paired.epoch,f.node.epoch+1);const decision=await t.decide();assert.equal(decision.status,404);assert.equal(decision.data.error.code,'operation_not_found');assert.deepEqual((await f.api(t.reviewsPath,'GET',undefined,f.session.token)).data,original);assert.equal(f.calls().length,1);
}finally{await f.close();}});
