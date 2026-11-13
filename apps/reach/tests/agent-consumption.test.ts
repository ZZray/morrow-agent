// Copyright (c) Ray Zhang. Real HTTP reservations and SQLite; native-file attestations here are synthetic.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {ReachStore} from '../src/service/store.ts';
import {modelFixture} from './agent-model-fixture.ts';

const source=(name:string)=>({path:'E:/synthetic-native/'+name,sha256:'b'.repeat(64)});
function consumption(runId:string,calls=2,observed=false){return{receiptId:randomUUID(),fenceSha256:'a'.repeat(64),reviewSha256:'c'.repeat(64),consumedRuns:1,consumedCalls:calls,runs:[{runId,runNumber:1,effectiveCap:2,calls,admission:source('run-1-admission.json'),...(observed?{observation:source('run-1-observation.json')}:{})}]};}

test('an unobserved original Run charges its whole cap separately from actual requests and never reopens that Run',async()=>{
  const f=await modelFixture({maxCalls:8,maxRuns:4,runCallLimit:2});try{
    await(await f.model()).text();const actual=f.calls(),parent=f.store.operation(f.session.user.id,f.parent.id),events=f.store.events(f.session.user.id,f.parent.id),input=consumption(f.runId);
    const first=f.store.budgets.recordNativeConsumption(parent,input);assert.equal(first.actualCalls,1);assert.equal(first.chargedCalls,2);assert.equal(first.taskAccepted,false);
    assert.deepEqual(f.calls(),actual);assert.deepEqual(f.store.operation(f.session.user.id,f.parent.id),parent);assert.deepEqual(f.store.events(f.session.user.id,f.parent.id),events);
    assert.deepEqual(f.store.budgets.recordNativeConsumption(parent,input),first);assert.equal(f.store.budgets.summary(parent).chargedCalls,2);
    assert.throws(()=>f.store.budgets.recordNativeConsumption(parent,{...input,reviewSha256:'d'.repeat(64)}),/不能改写/);
    f.store.budgets.recordNativeConsumption(parent,{...input,receiptId:randomUUID()});assert.equal(f.store.budgets.summary(parent).chargedCalls,2);
    const denied=await f.model();assert.equal(denied.status,409);assert.equal((await denied.json() as any).error.code,'agent_run_reconciled');assert.throws(()=>f.createTool(),/不能新增效果/);assert.equal(f.upstreamRequests.length,1);
    await f.reopen();const after=f.store.budgets.summary(parent);assert.equal(after.actualCalls,1);assert.equal(after.chargedCalls,2);assert.equal(after.runs[0]!.reserved_cap,2);assert.equal(after.runs[0]!.admitted_cap,2);assert.equal(after.runs[0]!.closed_for_resume,1);assert.deepEqual(f.calls(),actual);assert.deepEqual(f.store.events(f.session.user.id,f.parent.id),events);
    writeFileSync(join(f.root,'asserted-native-consumption.json'),JSON.stringify({input,first,after,parent,events,models:actual},null,2));
  }finally{await f.close();}
});

test('native consumption cannot refund an actual request, omit an unobserved cap, change admission or lower a persisted floor',async()=>{
  const f=await modelFixture({maxCalls:8,maxRuns:4,runCallLimit:2});try{
    await(await f.model()).text();const input=consumption(f.runId),parent=f.parent;
    for(const value of [consumption(f.runId,0,true),consumption(f.runId,1),{...input,consumedCalls:1},{...input,runs:[{...input.runs[0]!,effectiveCap:3}]},{...input,runs:[{...input.runs[0]!,runId:randomUUID()}]},{...input,consumedRuns:0,consumedCalls:0,runs:[]}])assert.throws(()=>f.store.budgets.recordNativeConsumption(parent,value));
    assert.equal(f.store.budgets.summary(parent).chargedCalls,1);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM agent_budget_reconciliations').get()!.n,0);
    f.store.budgets.recordNativeConsumption(parent,input);assert.throws(()=>f.store.budgets.recordNativeConsumption(parent,consumption(f.runId,1,true)),/不得退款/);assert.equal(f.store.budgets.summary(parent).chargedCalls,2);assert.equal(f.calls().length,1);
  }finally{await f.close();}
});

test('the exact empty native prefix retains a pre-reserved UUID without charging or authorizing another Run',async()=>{
  const f=await modelFixture({maxCalls:8,maxRuns:4,runCallLimit:2});try{
    const response=await f.api(`/api/v1/node/agents/${f.parent.id}/runs`,'POST',{...f.binding,runId:f.runId});assert.equal(response.status,200);assert.equal(response.data.runCallLimit,2);
    const input={receiptId:randomUUID(),fenceSha256:'a'.repeat(64),reviewSha256:'b'.repeat(64),consumedRuns:0,consumedCalls:0,runs:[]},receipt=f.store.budgets.recordNativeConsumption(f.parent,input);assert.equal(receipt.chargedCalls,0);assert.equal(receipt.actualCalls,0);
    await f.reopen();assert.equal(f.store.budgets.summary(f.parent).runs[0]!.run_id,f.runId);assert.equal(f.store.budgets.summary(f.parent).runs[0]!.admitted_cap,null);assert.equal(f.store.budgets.summary(f.parent).runs.length,1);
    const next=await f.api(`/api/v1/node/agents/${f.parent.id}/runs`,'POST',{...f.binding,runId:randomUUID()});assert.equal(next.status,409);assert.equal(next.data.error.code,'agent_run_feedback_required');assert.equal(f.upstreamRequests.length,0);
    f.store.budgets.recordNativeConsumption(f.parent,consumption(f.runId,0,true));
    assert.throws(()=>f.store.budgets.recordNativeConsumption(f.parent,{...input,receiptId:randomUUID()}),/累计消费|后继 Run/,'an admitted zero-call Run still consumes its Run slot');
  }finally{await f.close();}
});

test('conservative consumption consumes the Task total before a concurrent next-Run upstream reservation',async()=>{
  const f=await modelFixture({maxCalls:3,maxRuns:2,runCallLimit:2});try{
    await(await f.model()).text();
    const basis={task_id:f.parent.id,criteria_revision:'reach-receipt-integrity-v1',authorization_revision:f.dispatch.payloadHash,run_id:f.runId,run_number:1,session_path:join(f.root,'synthetic-session.json'),events_path:join(f.root,'synthetic-events.jsonl'),events_sha256:'a'.repeat(64),event_count:1,run_calls:1,total_calls:1,journal_head_sha256:'b'.repeat(64),raw_start:0,raw_end:1,raw_proof:'journal-v1:'+'c'.repeat(64)};
    const published=await f.api(`/api/v1/node/agents/${f.parent.id}/reviews`,'POST',{...f.binding,candidate:{basis,output:'Synthetic Node observation for service budget interleaving only.',goal:null},childOperationIds:[]});assert.equal(published.status,200);
    const decision=await f.api(`/api/v1/operations/${f.parent.id}/agent-reviews`,'POST',{reviewId:randomUUID(),runId:f.runId,basisSha256:published.data.basisSha256,decision:'continue',feedback:'Continue under the original Task budget.'},f.session.token);assert.equal(decision.status,200);const next=decision.data.nextRunId;
    const registered=await f.api(`/api/v1/node/agents/${f.parent.id}/runs`,'POST',{...f.binding,runId:next});assert.equal(registered.data.runCallLimit,2);
    f.store.budgets.recordNativeConsumption(f.parent,consumption(f.runId));
    const again=await f.api(`/api/v1/node/agents/${f.parent.id}/runs`,'POST',{...f.binding,runId:next});assert.equal(again.data.runCallLimit,2,'the original reservation is immutable');assert.equal(again.data.remainingCalls,1);
    const responses=await Promise.all([f.model(randomUUID(),f.payload(),{'x-reach-run-id':next}),f.model(randomUUID(),f.payload(),{'x-reach-run-id':next})]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);for(const r of responses)await r.text();
    const over=await f.model(randomUUID(),f.payload(),{'x-reach-run-id':next});assert.equal(over.status,409);assert.equal((await over.json() as any).error.code,'agent_model_budget');assert.equal(f.upstreamRequests.length,2);assert.equal(f.calls().length,2);assert.equal(f.store.budgets.summary(f.parent).chargedCalls,3);
    const response=await f.api(`/api/v1/node/agents/${f.parent.id}/reviews`,'POST',{...f.binding,candidate:{basis:{...basis,run_id:next,run_number:2,run_calls:1,total_calls:3},output:'Charged total is three; actual upstream reservations are two.',goal:null},childOperationIds:[]});assert.equal(response.status,200);
    const prefix={...consumption(f.runId),consumedRuns:2,consumedCalls:3,runs:[consumption(f.runId).runs[0]!,{runId:next,runNumber:2,effectiveCap:1,calls:1,admission:source('run-2-admission.json'),observation:source('run-2-observation.json')}]};
    f.store.budgets.recordNativeConsumption(f.parent,prefix);await f.reopen();const persisted=f.store.budgets.summary(f.parent);assert.equal(persisted.runs[1]!.reserved_cap,2);assert.equal(persisted.runs[1]!.admitted_cap,1);assert.equal(persisted.actualCalls,2);assert.equal(persisted.chargedCalls,3);
    assert.throws(()=>f.store.budgets.recordNativeConsumption(f.parent,{...prefix,receiptId:randomUUID(),runs:[prefix.runs[0],{...prefix.runs[1],effectiveCap:2}]}),/准入额度/);assert.equal(f.upstreamRequests.length,2);
  }finally{await f.close();}
});

test('a failed consumption receipt insert rolls back every floor, closure and audit write',async()=>{
  const f=await modelFixture({maxCalls:8,maxRuns:4,runCallLimit:2});try{
    await(await f.model()).text();const before=f.store.budgets.summary(f.parent),audits=f.store.db.prepare('SELECT * FROM audit ORDER BY id').all();
    f.store.db.exec("CREATE TEMP TRIGGER fail_native_receipt BEFORE INSERT ON agent_budget_reconciliations BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END");
    assert.throws(()=>f.store.budgets.recordNativeConsumption(f.parent,consumption(f.runId)),/receipt unavailable/);assert.deepEqual(f.store.budgets.summary(f.parent),before);assert.deepEqual(f.store.db.prepare('SELECT * FROM audit ORDER BY id').all(),audits);
    f.store.db.exec('DROP TRIGGER fail_native_receipt');await(await f.model()).text();assert.equal(f.upstreamRequests.length,2);assert.equal(f.store.budgets.summary(f.parent).actualCalls,2);
  }finally{await f.close();}
});

test('a legacy schema5 database gains persistent caps without changing original operations, events or model reservations',async()=>{
  const f=await modelFixture({maxCalls:8,maxRuns:4,runCallLimit:2});try{
    await(await f.model()).text();const parent=f.store.operation(f.session.user.id,f.parent.id),events=f.store.events(f.session.user.id,f.parent.id),models=f.calls();f.store.db.exec('DROP TABLE agent_budget_reconciliations; DROP TABLE agent_run_budgets; PRAGMA user_version=5');
    await f.reopen();assert.equal(f.store.db.prepare('PRAGMA user_version').get()!.user_version,11);assert.deepEqual(f.store.operation(f.session.user.id,f.parent.id),parent);assert.deepEqual(f.store.events(f.session.user.id,f.parent.id),events);assert.deepEqual(f.calls(),models);const budget=f.store.budgets.summary(parent);assert.equal(budget.actualCalls,1);assert.equal(budget.chargedCalls,1);assert.equal(budget.runs[0]!.reserved_cap,2);assert.equal(budget.runs[0]!.admitted_cap,null);assert.equal(budget.runs[0]!.run_id,f.runId);
  }finally{await f.close();}
});

test('an invalid legacy budget migration rolls back its tables and schema version instead of publishing a partial upgrade',async()=>{
  const f=await modelFixture({maxCalls:8,maxRuns:4,runCallLimit:2});await(await f.model()).text();await(await f.model()).text();await f.close();
  const path=join(f.root,'reach.sqlite'),db=new DatabaseSync(path);try{
    db.exec('DROP TABLE agent_budget_reconciliations; DROP TABLE agent_run_budgets; PRAGMA user_version=5');db.prepare("UPDATE operations SET command_json=json_set(command_json,'$.maxCalls',1,'$.runCallLimit',1) WHERE id=?").run(f.parent.id);const models=db.prepare('SELECT * FROM agent_model_calls').all();
    assert.throws(()=>new ReachStore(path),/预算冲突/);assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,5);assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('agent_run_budgets','agent_budget_reconciliations')").get()!.n,0);assert.deepEqual(db.prepare('SELECT * FROM agent_model_calls').all(),models);
  }finally{db.close();}
});

const previous=process.env.REACH_SCHEMA5_SERVICE_MODULE;
test('the explicitly supplied frozen schema5 service refuses the new persistent budget semantics',{skip:!previous},async()=>{
  assert.ok(previous&&isAbsolute(previous));assert.equal(createHash('sha256').update(readFileSync(previous)).digest('hex'),'54194ddb997e601044a2b3290a602d51795258672131ab15e77a4059acd7fb04');
  const f=await modelFixture();try{const old=await import(pathToFileURL(previous).href),before=f.calls();assert.throws(()=>new old.ReachStore(join(f.root,'reach.sqlite')),/newer than/);assert.equal(f.store.db.prepare('PRAGMA user_version').get()!.user_version,11);assert.deepEqual(f.calls(),before);}finally{await f.close();}
});

test('the actual frozen schema5 service can leave a zero-balance reserved Run and migration preserves its original UUID',{skip:!previous},async()=>{
  assert.ok(previous&&isAbsolute(previous));assert.equal(createHash('sha256').update(readFileSync(previous)).digest('hex'),'54194ddb997e601044a2b3290a602d51795258672131ab15e77a4059acd7fb04');
  const f=await modelFixture({maxCalls:1,maxRuns:2,runCallLimit:1});try{
    f.store.db.exec('DROP TABLE agent_budget_reconciliations; DROP TABLE agent_run_budgets; PRAGMA user_version=5');const Old=await import(pathToFileURL(previous).href),old=new Old.ReachStore(join(f.root,'reach.sqlite'));let next:string;
    try{
      const id=randomUUID(),descriptor=f.broker.descriptor();old.models.reserve(f.node,f.parent.id,id,{...f.binding,runId:f.runId,routeHash:f.routeHash},'d'.repeat(64),descriptor);old.models.finish(f.parent.id,id,'stream_complete',{responseBytes:0});
      const basis={task_id:f.parent.id,criteria_revision:'reach-receipt-integrity-v1',authorization_revision:f.dispatch.payloadHash,run_id:f.runId,run_number:1,session_path:join(f.root,'legacy-session.json'),events_path:join(f.root,'legacy-events.jsonl'),events_sha256:'a'.repeat(64),event_count:1,run_calls:1,total_calls:1,journal_head_sha256:'b'.repeat(64),raw_start:0,raw_end:1,raw_proof:'journal-v1:'+'c'.repeat(64)};
      const published=old.reviews.publish(f.node,f.parent.id,{...f.binding,candidate:{basis,output:'Synthetic historical service receipt, not native execution.',goal:null},childOperationIds:[]}),decision=old.reviews.decision(f.session.user.id,f.parent.id,{reviewId:randomUUID(),runId:f.runId,basisSha256:published.basisSha256,decision:'continue',feedback:'Exact historical zero-balance reservation probe.'});next=decision.nextRunId;
      const registered=old.reviews.register(f.node,f.parent.id,{...f.binding,runId:next});assert.equal(registered.runNumber,2);assert.equal(registered.remainingCalls,0);assert.equal(old.db.prepare('SELECT count(*) AS n FROM agent_model_calls WHERE run_id=?').get(next).n,0);
    }finally{old.close();}
    await f.reopen();const budgets=f.store.budgets.summary(f.parent);assert.equal(budgets.runs.length,2);assert.equal(budgets.runs[1]!.run_id,next!);assert.equal(budgets.runs[1]!.reserved_cap,0);assert.equal(budgets.runs[1]!.admitted_cap,null);assert.equal(budgets.actualCalls,1);assert.equal(budgets.chargedCalls,1);
    const denied=await f.model(randomUUID(),f.payload(),{'x-reach-run-id':next!});assert.equal(denied.status,409);assert.equal((await denied.json() as any).error.code,'agent_model_budget');assert.equal(f.upstreamRequests.length,0);
    writeFileSync(join(f.root,'asserted-legacy-zero-slot.json'),JSON.stringify({schema:7,originalNextRun:next!,budgets,syntheticHistoricalReservations:true,upstreamRequests:0},null,2));
  }finally{await f.close();}
});
