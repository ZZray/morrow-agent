// Copyright (c) Ray Zhang. HTTP/SQLite execution relationships; no native Task resume is performed here.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {modelFixture} from './agent-model-fixture.ts';
import {resumeSchema,commandSchema,delegateSchema} from '../src/contracts/protocol.ts';
import {ReachStore,sha256} from '../src/service/store.ts';
import {ReachClient} from '../src/controller/client.ts';
import {invoke} from '../src/controller/mcp.ts';

type Fixture=Awaited<ReturnType<typeof modelFixture>>;
const plain=(v:unknown)=>JSON.parse(JSON.stringify(v));
const enable=(f:Fixture)=>f.store.hello(f.node,'synthetic-resume-fixture',['agent.delegate','agent.resume','file.read','file.write','command.run']);
const resume=(f:Fixture,previous=f.parent.id)=>resumeSchema.parse({kind:'agent.resume',rootOperationId:f.parent.id,previousExecutionId:previous,fenceSha256:'a'.repeat(64),instruction:'Continue the original Task after inspecting its native evidence.'});
const submit=(f:Fixture,command=resume(f),requestId=randomUUID())=>f.api('/api/v1/operations','POST',{requestId,nodeId:f.node.id,command},f.session.token);
const binding=(d:any)=>({dispatchId:d.dispatchId,payloadHash:d.payloadHash});
const snapshot=(f:Fixture)=>plain({parent:f.store.operation(f.session.user.id,f.parent.id),events:f.store.events(f.session.user.id,f.parent.id),models:f.calls(),budgets:f.store.budgets.summary(f.parent),children:f.store.agents.list(f.parent)});
const tool=(runId:string,callId='original-call')=>{const argumentsJson=JSON.stringify({command:{kind:'file.read',path:'original.txt'}});return{runId,callId,tool:'reach_execute',argsSha256:sha256(argumentsJson),argumentsJson};};
function candidate(f:Fixture){return{basis:{task_id:f.parent.id,criteria_revision:'reach-receipt-integrity-v1',authorization_revision:f.dispatch.payloadHash,run_id:f.runId,run_number:1,session_path:join(f.root,'synthetic-session.json'),events_path:join(f.root,'synthetic-events.jsonl'),events_sha256:'b'.repeat(64),event_count:3,run_calls:1,total_calls:1,journal_head_sha256:'c'.repeat(64),raw_start:0,raw_end:2,raw_proof:'journal-v1:'+'d'.repeat(64)},output:'Synthetic service candidate; no native execution or evidence authentication.',goal:null};}
function save(f:Fixture,name:string,extra:unknown={}){
  const rows=(t:string)=>f.store.db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all();
  writeFileSync(join(f.root,'asserted-executions-'+name+'.json'),JSON.stringify({scope:'synthetic Node lifecycle over real local HTTP/SQLite, not native resume',snapshot:snapshot(f),tasks:rows('agent_tasks'),executions:rows('agent_executions'),childExecutions:rows('agent_child_executions'),extra},null,2));
}

test('resume accepts only original linkage and is unavailable to Nodes that do not advertise it',async()=>{
  const f=await modelFixture();try{
    f.record(f.dispatch,'unknown',{fixtureOnly:true});const original=snapshot(f);
    assert.equal((await submit(f)).data.error.code,'capability_unavailable');
    for(const override of [{maxCalls:32},{cwd:'E:\\other'},{sessionId:randomUUID()},{deadline:Date.now()+60000}])assert.equal(commandSchema.safeParse({...resume(f),...override}).success,false);
    assert.equal(resumeSchema.safeParse({...resume(f),instruction:'  '}).success,false);assert.equal(resumeSchema.safeParse({...resume(f),instruction:'bad\ud800'}).success,false);
    assert.deepEqual(snapshot(f),original);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM agent_executions').get()!.n,1);save(f,'capability',{noResumeDispatch:true});
  }finally{await f.close();}
});

test('concurrent exact resume submissions bind one new generation while every effect and success path remains closed',{timeout:25000},async()=>{
  const f=await modelFixture({maxRuns:3,maxCalls:6});try{
    enable(f);await(await f.model()).text();
    const childInput={...f.binding,...tool(f.runId)},child=f.store.agents.create(f.node,f.parent.id,childInput).operation;
    f.record(child,'received');f.record(child,'running');f.record(child,'succeeded',{fixtureOnly:true,content:'original read result'});
    const published=await f.api(`/api/v1/node/agents/${f.parent.id}/reviews`,'POST',{...f.binding,candidate:candidate(f),childOperationIds:[child.operationId]});assert.equal(published.status,200);
    f.record(f.dispatch,'unknown',{fixtureOnly:true,reason:'native execution deliberately not represented'});const original=snapshot(f),requestId=randomUUID(),command=resume(f);
    const submitted=await Promise.all(Array.from({length:6},()=>submit(f,command,requestId)));assert.ok(submitted.every(r=>r.status===201));const op=submitted[0].data;assert.ok(submitted.every(r=>r.data.id===op.id));
    assert.equal((await submit(f)).data.error.code,'agent_resume_superseded');assert.equal((await submit(f,{...command,instruction:command.instruction+' changed'},requestId)).data.error.code,'request_id_conflict');
    assert.deepEqual(snapshot(f),original);
    const taskPath=`/api/v1/operations/${op.id}/agent-task`,projected=(await f.api(taskPath,'GET',undefined,f.session.token)).data;
    assert.equal(projected.taskId,f.parent.id);assert.equal(projected.activeExecutionId,op.id);assert.equal(projected.generation,2);assert.equal(projected.phase,'reconciling');assert.equal(projected.recoveryRequired,true);assert.equal(projected.parentDeadlineUnixMs,original.parent.claimed_at+f.command.maxSeconds*1000);
    const d=f.store.claim(f.node)!;assert.equal(d.operationId,op.id);f.record(d,'received');f.record(d,'running');
    const path=`/api/v1/node/agents/${op.id}`,context=await f.api(path+'/context','POST',binding(d));assert.equal(context.status,200);assert.deepEqual(context.data.rootDispatch,f.dispatch);assert.equal(context.data.descriptor.routeHash,f.routeHash);assert.equal(context.data.executionGeneration,2);assert.ok(!JSON.stringify(context.data).includes(f.organizationToken));
    const denied=[await f.api(path+'/model/route','POST',binding(d)),await f.api(path+'/runs','POST',{...binding(d),runId:randomUUID()}),await f.api(path+'/calls','POST',{...binding(d),...tool(f.runId,'new-effect')}),await f.api(path+'/reviews','POST',{...binding(d),candidate:{...candidate(f),basis:{...candidate(f).basis,run_id:randomUUID(),run_number:2},output:'new publication'},childOperationIds:[child.operationId]})];
    const response=await fetch(f.origin+path+'/model/requests/'+randomUUID(),{method:'POST',headers:{...f.headers,'x-reach-dispatch-id':d.dispatchId,'x-reach-payload-hash':d.payloadHash},body:JSON.stringify(f.payload())});denied.push({status:response.status,data:await response.json() as any});
    writeFileSync(join(f.root,'denied-effects.json'),JSON.stringify(denied,null,2));assert.ok(denied.every(r=>r.status===409&&r.data.error.code==='agent_execution_reconciling'));
    const duplicate=await f.api(path+'/calls','POST',{...binding(d),...tool(f.runId)});assert.equal(duplicate.status,200);assert.equal(duplicate.data.duplicate,true);assert.equal(duplicate.data.evidenceOnly,true);assert.equal(duplicate.data.originExecutionId,f.parent.id);assert.equal(duplicate.data.operation.operationId,child.operationId);
    assert.deepEqual((await f.api(path+'/model/requests/'+f.calls()[0].request_id+'/status','POST',binding(d))).data.state,'stream_complete');
    assert.equal((await f.api(path+'/reviews/'+f.runId,'POST',binding(d))).data.basisSha256,published.data.basisSha256);
    const decision=await f.api(`/api/v1/operations/${f.parent.id}/agent-reviews`,'POST',{reviewId:randomUUID(),runId:f.runId,basisSha256:published.data.basisSha256,decision:'continue',feedback:'Continue only after native reconciliation.'},f.session.token);assert.equal(decision.data.error.code,'agent_execution_reconciling');
    assert.throws(()=>f.record(d,'succeeded',f.outcome()),/恢复尚未/);
    f.record(d,'unknown',{fixtureOnly:true});
    const reconcile={reconciliationId:randomUUID(),...binding(d),decision:'succeeded',evidence:'Synthetic attestation cannot authorize original native recovery.',result:f.outcome()};
    assert.equal((await f.api(`/api/v1/operations/${op.id}/reconcile`,'POST',reconcile,f.session.token)).data.error.code,'agent_execution_reconciling');
    assert.deepEqual(snapshot(f),original);assert.equal(f.upstreamRequests.length,1);
    const retained=(await f.api(taskPath,'GET',undefined,f.session.token)).data;await f.reopen();assert.deepEqual((await f.api(taskPath,'GET',undefined,f.session.token)).data,retained);assert.deepEqual(snapshot(f),original);
    const client=new ReachClient({server:f.origin,token:f.session.token,development:true});assert.deepEqual(await invoke(client,'reach_agent_task',{operationId:f.parent.id}),retained);
    save(f,'concurrency',{submissions:6,operationId:op.id,projection:retained,deniedEffects:denied.length,newNativeRuns:0});
  }finally{await f.close();}
});

test('root cancellation targets the current attempt and abandoned queued generations can be replaced without releasing the Session',async()=>{
  const f=await modelFixture();try{
    enable(f);f.record(f.dispatch,'unknown',{fixtureOnly:true});const original=snapshot(f);
    const a=(await submit(f)).data;assert.equal(f.store.cancel(f.session.user.id,f.parent.id).id,a.id);assert.equal(f.store.operation(f.session.user.id,a.id).delivery,'cancelled');assert.deepEqual(snapshot(f),original);
    const b=await submit(f,resume(f,a.id));assert.equal(b.status,201);assert.equal(f.store.executions.projection(f.session.user.id,b.data.id).generation,3);
    f.store.cancel(f.session.user.id,a.id);assert.equal(f.store.operation(f.session.user.id,b.data.id).cancel_requested,0);
    f.store.revoke(f.session.user.id,f.node.id);assert.equal(f.store.operation(f.session.user.id,b.data.id).delivery,'cancelled');
    const repairing={attemptId:randomUUID(),code:f.store.createPairing(f.session.user.id).code,installationId:f.node.installation_id,installationSecret:f.nodeToken,name:'same installation',platform:'windows',version:'fixture'};
    assert.throws(()=>f.store.pair(repairing,f.nodeToken),/结算原操作/);
    await f.reopen();assert.throws(()=>f.store.pair(repairing,f.nodeToken),/结算原操作/);
    assert.equal(f.store.executions.projection(f.session.user.id,f.parent.id).recoveryRequired,true);
    save(f,'abandoned',{first:a.id,second:b.data.id,monotonicGeneration:3,repairBlocked:true});
  }finally{await f.close();}
});

test('resume creation is atomic and original ownership, browser CSRF and dispatch identity remain mandatory',async()=>{
  const f=await modelFixture();try{
    enable(f);f.record(f.dispatch,'unknown',{fixtureOnly:true});const before=snapshot(f),count=f.store.operations(f.session.user.id).length;
    f.store.db.exec("CREATE TEMP TRIGGER reject_resume BEFORE UPDATE ON agent_tasks WHEN NEW.generation>1 BEGIN SELECT RAISE(ABORT,'fixture rejected CAS'); END");
    assert.equal((await submit(f)).status,500);assert.equal(f.store.operations(f.session.user.id).length,count);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM agent_executions').get()!.n,1);assert.deepEqual(snapshot(f),before);f.store.db.exec('DROP TRIGGER reject_resume');
    const unauthorized=await f.api('/api/v1/operations','POST',{requestId:randomUUID(),nodeId:f.node.id,command:resume(f)},f.nodeToken);assert.equal(unauthorized.status,401);
    const csrf=await fetch(f.origin+'/api/v1/operations',{method:'POST',headers:{'content-type':'application/json',cookie:'reach_session='+f.session.token,origin:f.origin},body:JSON.stringify({requestId:randomUUID(),nodeId:f.node.id,command:resume(f)})});assert.equal(csrf.status,403);await csrf.text();
    const op=(await submit(f)).data,d=f.store.claim(f.node)!;f.record(d,'received');f.record(d,'running');
    assert.equal((await f.api(`/api/v1/node/agents/${op.id}/context`,'POST',{...binding(d),dispatchId:randomUUID()})).status,409);
    f.store.db.prepare('INSERT INTO users SELECT ?,?,salt,password_hash FROM users WHERE id=?').run(randomUUID(),'other-reader',f.session.user.id);const user=f.store.login('other-reader','local-model-fixture-password');assert.equal((await f.api(`/api/v1/operations/${op.id}/agent-task`,'GET',undefined,user.token)).status,404);
    save(f,'atomic',{failedCasLeftNoOperation:true,csrfStatus:403});
  }finally{await f.close();}
});

test('original deadlines and durable Session order reject recovery without changing the original Task',async()=>{
  const f=await modelFixture();try{
    enable(f);f.record(f.dispatch,'failed',{fixtureOnly:true});const before=snapshot(f),now=f.store.now;
    f.store.now=()=>before.parent.claimed_at+f.command.maxSeconds*1000;assert.equal((await submit(f)).data.error.code,'agent_deadline');f.store.now=now;
    // Force the same millisecond. The durable task insertion order must still distinguish successors.
    f.store.now=()=>f.parent.created_at;const next=f.store.submit(f.session.user.id,randomUUID(),f.node.id,f.command),d=f.store.claim(f.node)!;assert.equal(next.created_at,f.parent.created_at);f.record(d,'received');f.record(d,'running');f.record(d,'failed',{fixtureOnly:true});f.store.now=now;
    assert.equal((await submit(f)).data.error.code,'agent_resume_session_changed');assert.deepEqual(snapshot(f),before);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM agent_executions').get()!.n,2);save(f,'deadline-session',{successor:next.id,sameCreatedAt:true});
  }finally{await f.close();}
});

test('late reconciled original success is retained only as history while the new recovery remains blocked',async()=>{
  const f=await modelFixture();try{
    enable(f);const now=f.store.now;f.store.now=()=>Date.now()+31000;f.store.db.prepare("UPDATE operations SET delivery='claimed' WHERE id=?").run(f.parent.id);f.store.observeStaleClaims();f.store.now=now;
    f.store.reconcile(f.session.user.id,f.parent.id,{reconciliationId:randomUUID(),...f.binding,decision:'failed',evidence:'Synthetic lifecycle records an independently attributed failed decision.',result:{fixtureOnly:true}});
    const op=(await submit(f)).data,projection=f.store.executions.projection(f.session.user.id,op.id),original=f.store.operation(f.session.user.id,f.parent.id);
    const late=f.record(f.dispatch,'succeeded',f.outcome());assert.equal(late.reconciled,true);assert.equal(f.store.operation(f.session.user.id,f.parent.id).execution,'failed');assert.equal(f.store.operation(f.session.user.id,f.parent.id).result_json,original.result_json);assert.deepEqual(f.store.executions.projection(f.session.user.id,op.id),projection);assert.equal(f.store.events(f.session.user.id,f.parent.id).at(-1)!.kind,'succeeded');
    assert.throws(()=>f.store.submit(f.session.user.id,randomUUID(),f.node.id,f.command),/尚未结算/);save(f,'late-history',{late,projection});
  }finally{await f.close();}
});

test('latest Node capabilities, exact epoch and an actually dispatched root are checked before recovery',async()=>{
  const f=await modelFixture();try{
    enable(f);f.record(f.dispatch,'failed',{fixtureOnly:true});
    const otherSecret=randomBytes(32).toString('base64url'),paired=f.store.pair({attemptId:randomUUID(),code:f.store.createPairing(f.session.user.id).code,installationId:randomUUID(),installationSecret:otherSecret,name:'other synthetic Node',platform:'windows',version:'fixture'}),other=f.store.node(otherSecret);f.store.hello(other,'fixture',['agent.resume']);
    const wrongNode=await f.api('/api/v1/operations','POST',{requestId:randomUUID(),nodeId:paired.nodeId,command:resume(f)},f.session.token);assert.equal(wrongNode.data.error.code,'agent_resume_binding');
    assert.throws(()=>f.store.submit(f.session.user.id,randomUUID(),f.node.id,resume(f),f.node.epoch+1),/配对已变化/);
    const untouched=f.store.submit(f.session.user.id,randomUUID(),f.node.id,{...f.command,sessionId:randomUUID()});f.store.cancel(f.session.user.id,untouched.id);
    const unclaimed=await submit(f,{...resume(f),rootOperationId:untouched.id,previousExecutionId:untouched.id});assert.equal(unclaimed.data.error.code,'agent_resume_previous_active');
    const submitted=await submit(f);assert.equal(submitted.status,201);
    f.store.hello(f.node,'older-no-resume',['agent.delegate','file.read']);assert.equal(f.store.claim(f.node),null);assert.equal(f.store.operation(f.session.user.id,submitted.data.id).dispatch_id,null);
    enable(f);const d=f.store.claim(f.node)!;assert.equal(d.operationId,submitted.data.id);f.record(d,'received');f.record(d,'running');
    assert.equal((await f.api(`/api/v1/node/agents/${d.operationId}/context`,'POST',binding(d),otherSecret)).status,404);
    f.record(d,'unknown',{fixtureOnly:true});const failed=await f.api(`/api/v1/operations/${d.operationId}/reconcile`,'POST',{reconciliationId:randomUUID(),...binding(d),decision:'failed',evidence:'This marks the synthetic attempt failed, without settling the original native fence.',result:{fixtureOnly:true}},f.session.token);assert.equal(failed.status,200);
    assert.equal(f.store.executions.projection(f.session.user.id,d.operationId).recoveryRequired,true);assert.throws(()=>f.store.submit(f.session.user.id,randomUUID(),f.node.id,f.command),/尚未结算/);
    save(f,'identity-capabilities',{unclaimed:untouched.id,resume:d.operationId,failedAttemptDoesNotRelease:true});
  }finally{await f.close();}
});

test('schema8 missing execution provenance is rejected on reopen instead of being rebuilt from operations',async()=>{
  const f=await modelFixture();try{
    const child=f.store.agents.create(f.node,f.parent.id,{...f.binding,...tool(f.runId)}).operation;f.record(child,'received');f.record(child,'running');f.record(child,'succeeded',{fixtureOnly:true});
    f.store.db.prepare('DELETE FROM agent_child_executions WHERE child_id=?').run(child.operationId);
    await assert.rejects(f.reopen(),/执行归属缺失/);
    const db=new DatabaseSync(join(f.root,'reach.sqlite'),{readOnly:true});try{assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,11);assert.equal(db.prepare('SELECT count(*) AS n FROM agent_child_executions').get()!.n,0);writeFileSync(join(f.root,'asserted-executions-missing.json'),JSON.stringify({scope:'intentional schema8 child-provenance deletion; no native execution',child,notReconstructed:true},null,2));}finally{db.close();}
  }finally{await f.close();}
});

const previous7=process.env.REACH_SCHEMA7_SERVICE_MODULE;
test('different concurrent recovery requests cannot fork the current generation',async()=>{
  const f=await modelFixture();try{
    enable(f);f.record(f.dispatch,'unknown',{fixtureOnly:true});const original=snapshot(f);
    const results=await Promise.all(Array.from({length:6},()=>submit(f)));assert.equal(results.filter(r=>r.status===201).length,1);assert.ok(results.filter(r=>r.status!==201).every(r=>r.status===409&&r.data.error.code==='agent_resume_superseded'));
    const winner=results.find(r=>r.status===201)!.data;assert.equal(f.store.executions.projection(f.session.user.id,f.parent.id).activeExecutionId,winner.id);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM agent_executions WHERE root_id=?').get(f.parent.id)!.n,2);assert.deepEqual(snapshot(f),original);save(f,'different-cas',{winner:winner.id,concurrentDistinctRequests:6,accepted:1,rejected:5});
  }finally{await f.close();}
});
test('offline dangling child execution and operation targets cannot silently reopen schema8',async()=>{
  for(const mode of ['execution','operation']){
    const f=await modelFixture();let closed=false,reopened:ReachStore|undefined;
    try{
      const child=f.store.agents.create(f.node,f.parent.id,{...f.binding,...tool(f.runId)}).operation;f.record(child,'received');f.record(child,'running');f.record(child,'succeeded',{fixtureOnly:true});await f.close();closed=true;
      const filename=join(f.root,'reach.sqlite'),db=new DatabaseSync(filename);db.exec('PRAGMA foreign_keys=OFF');
      try{if(mode==='execution')db.prepare('UPDATE agent_child_executions SET execution_id=? WHERE child_id=?').run(randomUUID(),child.operationId);else db.prepare('INSERT INTO agent_child_executions VALUES(?,?,?,1)').run(randomUUID(),f.parent.id,f.parent.id);writeFileSync(join(f.root,'offline-dangling-input.json'),JSON.stringify({mode,rows:db.prepare('SELECT * FROM agent_child_executions').all(),scope:'intentional offline FK corruption, not a normal API mutation'},null,2));}finally{db.close();}
      assert.throws(()=>{reopened=new ReachStore(filename);},/执行关系冲突/);
      writeFileSync(join(f.root,'asserted-executions-dangling.json'),JSON.stringify({mode,rejected:true,noNativeResume:true},null,2));
    }finally{reopened?.close();if(!closed)await f.close();}
  }
});
async function legacy(){
  assert.ok(previous7);assert.equal(createHash('sha256').update(readFileSync(previous7)).digest('hex'),'5b8b130b2dae52583af0866dee29f49cb1b5df721c51ed147fb54b42569d02af');
  const Old=await import(pathToFileURL(previous7).href),root=resolve('work/agent-executions-legacy-'+randomUUID());mkdirSync(root,{recursive:true});const filename=join(root,'reach.sqlite');let store=new Old.ReachStore(filename);
  store.bootstrap('legacy-resume','local-legacy-resume-password');const user=store.login('legacy-resume','local-legacy-resume-password'),secret=randomBytes(32).toString('base64url');store.pair({attemptId:randomUUID(),code:store.createPairing(user.user.id).code,installationId:randomUUID(),installationSecret:secret,name:'legacy fixture',platform:'windows',version:'schema7'});const node=store.node(secret);store.hello(node,'schema7',['agent.delegate','file.read']);
  const command=delegateSchema.parse({kind:'agent.delegate',sessionId:randomUUID(),cwd:root,objective:'Retain exact legacy authority',maxCalls:4,maxRuns:3,runCallLimit:1,maxSeconds:600}),op=store.submit(user.user.id,randomUUID(),node.id,command),d=store.claim(node),record=(dispatch:any,kind:string,data:unknown={})=>store.record(node,{operationId:dispatch.operationId,...binding(dispatch),eventId:randomUUID(),sequence:store.operation(user.user.id,dispatch.operationId).last_sequence+1,kind,data});record(d,'received');record(d,'running');
  const runId=randomUUID(),child=store.agents.create(node,op.id,{...binding(d),...tool(runId)});record(child.operation,'received');record(child.operation,'running');record(child.operation,'succeeded',{fixtureOnly:true});record(d,'unknown',{fixtureOnly:true});
  const original=plain({operations:store.operations(user.user.id),events:store.events(user.user.id,op.id),budgets:store.budgets.summary(op),children:store.agents.list(op)});store.close();return{Old,root,filename,user,node,op,d,runId,original};
}
test('the explicitly supplied real schema7 Store migrates original identities and rejects the resulting schema8',{skip:!previous7},async()=>{
  const t=await legacy();let store:ReachStore|undefined;try{
    store=new ReachStore(t.filename);assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version,11);
    assert.deepEqual(plain({operations:store.operations(t.user.user.id),events:store.events(t.user.user.id,t.op.id),budgets:store.budgets.summary(t.op),children:store.agents.list(t.op)}),t.original);
    const projection=store.executions.projection(t.user.user.id,t.op.id);assert.equal(projection.generation,1);assert.equal(projection.recoveryRequired,false);assert.equal(projection.parentDeadlineUnixMs,store.operation(t.user.user.id,t.op.id).claimed_at!+600000);
    assert.equal(store.executions.context(t.node,t.op.id,t.d.dispatchId,t.d.payloadHash).descriptor,null);assert.equal(store.db.prepare('SELECT count(*) AS n FROM agent_task_models').get()!.n,0);
    const child=store.db.prepare('SELECT * FROM agent_child_executions').get()!;assert.equal(child.execution_id,t.op.id);assert.equal(child.generation,1);assert.equal(store.db.prepare('SELECT admitted_cap FROM agent_run_budgets').get()!.admitted_cap,null);
    writeFileSync(join(t.root,'asserted-migration.json'),JSON.stringify({scope:'actual frozen schema7 service Store, synthetic Node lifecycle; no native resume',original:t.original,projection,child},null,2));store.close();store=undefined;
    assert.throws(()=>new t.Old.ReachStore(t.filename),/newer than/);store=new ReachStore(t.filename);assert.deepEqual(store.executions.projection(t.user.user.id,t.op.id),projection);
  }finally{store?.close();console.log(JSON.stringify({agentExecutionMigration:t.root}));}
});
test('failed schema7 migration rolls back the new tables and version without manufacturing native authority',{skip:!previous7},async()=>{
  const t=await legacy();const db=new DatabaseSync(t.filename);db.prepare('UPDATE operations SET payload_hash=? WHERE id=?').run('f'.repeat(64),t.op.id);db.close();
  try{
    assert.throws(()=>new ReachStore(t.filename),/权威不符/);assert.throws(()=>new ReachStore(t.filename),/权威不符/);
    const check=new DatabaseSync(t.filename,{readOnly:true});try{assert.equal(check.prepare('PRAGMA user_version').get()!.user_version,7);assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('agent_tasks','agent_executions','agent_child_executions')").get()!.n,0);assert.equal(check.prepare('SELECT payload_hash FROM operations WHERE id=?').get(t.op.id)!.payload_hash,'f'.repeat(64));writeFileSync(join(t.root,'asserted-rollback.json'),JSON.stringify({schema:7,noNewTables:true,source:'intentional persisted payload corruption',original:t.original},null,2));}finally{check.close();}
  }finally{console.log(JSON.stringify({agentExecutionRollback:t.root}));}
});
