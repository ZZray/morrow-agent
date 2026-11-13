// Copyright (c) Ray Zhang. Real loopback model transports; Node lifecycle receipts are synthetic here.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,copyFileSync,writeFileSync,readFileSync,existsSync,linkSync,unlinkSync,symlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {modelFixture,chunk,until,delay} from './agent-model-fixture.ts';
import {ReachStore} from '../src/service/store.ts';
import {ServiceOwner} from '../src/service/owner.ts';
import {AgentModelBroker} from '../src/service/agent-model.ts';
import {reachServer} from '../src/service/server.ts';
import type {DeskExtension} from '../src/service/desk-extension.ts';
import {createServer as createNetServer} from 'node:net';
import {pathToFileURL} from 'node:url';

function input(f:Awaited<ReturnType<typeof modelFixture>>,row:any,owner:any){return{reconciliationId:randomUUID(),...f.binding,requestId:row.request_id,runId:row.run_id,bodySha256:row.body_sha256,ownerInstanceId:owner.instance_id,decision:'transport_stopped',evidence:'Read original local model and operation records; stop only this transport, retain unknown result and budget.'};}
async function failed(){const f=await modelFixture({maxRuns:2,maxCalls:4,runCallLimit:2});try{f.handle((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end(chunk('incomplete original result'));});await(await f.model()).text();await until(()=>f.store.db.prepare("SELECT phase FROM agent_model_owners").get()?.phase==='joined');f.record(f.dispatch,'unknown',{reason:'synthetic_node_observation_failed',replayed:false});return f;}catch(error){await f.close();throw error;}}

test('an exact unknown transport gets one immutable stopped receipt while original model, usage and all admission blocks remain',async()=>{
  const f=await failed();try{const path=`/api/v1/operations/${f.parent.id}/agent-models`,before=f.calls()[0],owner=f.store.db.prepare('SELECT * FROM agent_model_owners').get()!,stop=input(f,before,owner),parent=f.store.operation(f.session.user.id,f.parent.id),events=f.store.events(f.session.user.id,f.parent.id);
    const [a,b]=await Promise.all([f.api(path,'POST',stop,f.session.token),f.api(path,'POST',stop,f.session.token)]);assert.equal(a.status,200);assert.equal(b.status,200);assert.deepEqual(a.data,b.data);assert.equal(a.data.proof.kind,'joined_here');assert.equal(a.data.transportStopped,true);assert.equal(a.data.taskAccepted,false);assert.equal(a.data.usage,null);
    assert.deepEqual(f.calls()[0],before);assert.deepEqual(f.store.operation(f.session.user.id,f.parent.id),parent);assert.deepEqual(f.store.events(f.session.user.id,f.parent.id),events);assert.equal(f.store.models.unsettled(f.parent.id),true);assert.equal(f.store.budgets.summary(f.parent).actualCalls,1);assert.equal(f.store.budgets.summary(f.parent).chargedCalls,1);
    assert.equal((await f.model()).status,409);assert.throws(()=>f.createTool());assert.throws(()=>f.store.reconcile(f.session.user.id,f.parent.id,{reconciliationId:randomUUID(),...f.binding,decision:'succeeded',evidence:'Original transport stopped but model completion is not known.',result:f.outcome()}),/模型请求/);assert.equal(f.upstreamRequests.length,1);
    const listed=await f.api(path,'GET',undefined,f.session.token);assert.equal(listed.status,200);assert.deepEqual(listed.data.requests[0].transportStop,a.data);assert.ok(!JSON.stringify(listed.data).includes(f.organizationToken));
    assert.equal((await f.api(path,'POST',{...stop,evidence:stop.evidence+' changed'},f.session.token)).status,409);assert.equal((await f.api(path,'POST',{...stop,reconciliationId:randomUUID()},f.session.token)).status,409);
    assert.throws(()=>f.store.models.finish(f.parent.id,before.request_id,'stream_complete',{responseBytes:0},String(owner.instance_id)),/实例已退出|停止对账/);assert.deepEqual(f.calls()[0],before);
    await f.reopen();assert.deepEqual(f.calls()[0],before);assert.deepEqual((await f.api(path,'POST',stop,f.session.token)).data,a.data);
    writeFileSync(join(f.root,'asserted-model-stop.json'),JSON.stringify({stop,receipt:a.data,original:before,parent,events,reopenPreserved:true,syntheticNodeLifecycle:true},null,2));
  }finally{await f.close();}
});

test('explicit stopping joins the real active SSE transport before publishing its receipt',async()=>{
  const f=await modelFixture();let consume:Promise<unknown>|undefined,otherConsume:Promise<unknown>|undefined;try{f.handle((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(chunk('live original delta'));});const response=await f.model();consume=response.text().catch(()=>{});await until(()=>f.calls()[0]?.state==='streaming');const row=f.calls()[0],owner=f.store.db.prepare('SELECT * FROM agent_model_owners').get()!,stop=input(f,row,owner),path=`/api/v1/operations/${f.parent.id}/agent-models`;
    const other=f.store.submit(f.session.user.id,randomUUID(),f.node.id,{...f.command,sessionId:randomUUID()}),dispatch=f.store.claim(f.node)!;assert.equal(dispatch.operationId,other.id);f.record(dispatch,'received');f.record(dispatch,'running');const otherBinding={dispatchId:dispatch.dispatchId,payloadHash:dispatch.payloadHash},route=await f.api(`/api/v1/node/agents/${other.id}/model/route`,'POST',otherBinding);assert.equal(route.status,200);const otherId=randomUUID();
    const otherResponse=await fetch(f.origin+`/api/v1/node/agents/${other.id}/model/requests/${otherId}`,{method:'POST',headers:{...f.headers,'x-reach-dispatch-id':otherBinding.dispatchId,'x-reach-payload-hash':otherBinding.payloadHash,'x-reach-run-id':randomUUID()},body:JSON.stringify(f.payload())});otherConsume=otherResponse.text().catch(()=>{});await until(()=>f.store.db.prepare('SELECT state FROM agent_model_calls WHERE parent_id=?').get(other.id)?.state==='streaming');
    assert.equal((await f.api(path,'POST',stop,f.session.token)).status,409,'a live parent must first become explicitly unknown');assert.equal(f.upstreamClosed,0);
    f.record(f.dispatch,'unknown',{reason:'synthetic_node_lost_observation',replayed:false});const receipt=await f.broker.stop(f.session.user.id,f.parent.id,stop);await consume;await until(()=>f.upstreamClosed===1);assert.equal(f.store.db.prepare('SELECT phase FROM agent_model_owners WHERE parent_id=?').get(f.parent.id)!.phase,'joined');assert.equal(f.calls()[0].state,'unknown');assert.equal(f.calls()[0].error_code,'agent_model_explicit_stop');assert.equal(receipt.proof.kind,'joined_here');assert.equal(f.upstreamRequests.length,2);assert.equal(f.store.db.prepare('SELECT state FROM agent_model_calls WHERE parent_id=?').get(other.id)!.state,'streaming');
    writeFileSync(join(f.root,'asserted-live-stop.json'),JSON.stringify({stop,receipt,original:f.calls()[0],upstreamClosed:f.upstreamClosed,syntheticNodeLifecycle:true,directStopBeforeMonitor:true,otherParent:other.id,otherRequest:otherId,otherTransportStillStreaming:true},null,2));
  }finally{await f.close();await Promise.allSettled([consume,otherConsume]);}
});

test('identity, authentication, CSRF and failed commit cannot manufacture a stopped receipt',async()=>{
  const f=await failed();try{const row=f.calls()[0],owner=f.store.db.prepare('SELECT * FROM agent_model_owners').get()!,stop=input(f,row,owner),path=`/api/v1/operations/${f.parent.id}/agent-models`;
    assert.equal((await f.api(path,'GET',undefined,'')).status,401);assert.equal((await f.api(path,'POST',stop)).status,401);assert.throws(()=>f.store.models.list(randomUUID(),f.parent.id));
    for(const patch of [{dispatchId:randomUUID()},{payloadHash:'f'.repeat(64)},{requestId:randomUUID()},{runId:randomUUID()},{bodySha256:'f'.repeat(64)},{ownerInstanceId:randomUUID()},{evidence:'bad'}])assert.notEqual((await f.api(path,'POST',{...stop,...patch},f.session.token)).status,200);
    const csrf=await fetch(f.origin+path,{method:'POST',headers:{'content-type':'application/json',cookie:'reach_session='+f.session.token,origin:'http://127.0.0.1'},body:JSON.stringify(stop)});assert.equal(csrf.status,403);await csrf.text();assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM agent_model_stops').get()!.n,0);
    f.store.db.exec("CREATE TEMP TRIGGER fail_stop BEFORE INSERT ON agent_model_stops BEGIN SELECT RAISE(ABORT,'stop receipt unavailable'); END");assert.equal((await f.api(path,'POST',stop,f.session.token)).status,500);assert.deepEqual(f.calls()[0],row);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM agent_model_stops').get()!.n,0);f.store.db.exec('DROP TRIGGER fail_stop');assert.equal((await f.api(path,'POST',stop,f.session.token)).status,200);
  }finally{await f.close();}
});

test('explicit failed or cancelled parent reconciliation keeps unknown model history and still permits only its stopped receipt',async()=>{
  for(const decision of ['failed','cancelled']as const){const f=await failed();try{
    const row=f.calls()[0],owner=f.store.db.prepare('SELECT * FROM agent_model_owners').get()!,stop=input(f,row,owner);f.store.reconcile(f.session.user.id,f.parent.id,{reconciliationId:randomUUID(),...f.binding,decision,evidence:'The original execution is explicitly stopped; its model result remains unknown.',result:{state:decision}});
    const parent=f.store.operation(f.session.user.id,f.parent.id),events=f.store.events(f.session.user.id,f.parent.id),response=await f.api(`/api/v1/operations/${f.parent.id}/agent-models`,'POST',stop,f.session.token);assert.equal(response.status,200);assert.equal(response.data.originalState,'unknown');assert.deepEqual(f.store.operation(f.session.user.id,f.parent.id),parent);assert.deepEqual(f.store.events(f.session.user.id,f.parent.id),events);assert.deepEqual(f.calls()[0],row);assert.equal((await f.model()).status,409);assert.equal(f.store.models.unsettled(f.parent.id),true);
  }finally{await f.close();}}
});

test('missing current active-map entry is not join proof but a later participant must hold the same lifetime lock',async()=>{
  const f=await modelFixture();try{const id=randomUUID(),reservation=f.store.models.reserve(f.node,f.parent.id,id,{...f.binding,runId:f.runId,routeHash:f.routeHash},'e'.repeat(64),f.broker.descriptor());f.record(f.dispatch,'unknown',{reason:'synthetic_owner_orphan',replayed:false});const row=f.calls()[0],owner=f.store.db.prepare('SELECT * FROM agent_model_owners').get()!,stop=input(f,row,owner),path=`/api/v1/operations/${f.parent.id}/agent-models`;
    const missing=await f.api(path,'POST',stop,f.session.token);assert.equal(missing.status,409);assert.equal(missing.data.error.code,'agent_model_transport_not_joined');assert.deepEqual(f.calls()[0],row);
    f.store.db.prepare('UPDATE agent_model_owners SET generation=2 WHERE request_id=?').run(id);assert.throws(()=>f.store.models.finish(f.parent.id,id,'stream_complete',{responseBytes:0},reservation.owner),/实例已退出|停止对账/);assert.deepEqual(f.calls()[0],row);f.store.db.prepare('UPDATE agent_model_owners SET generation=1 WHERE request_id=?').run(id);
    await f.reopen();assert.notEqual(f.store.owner.instanceId,owner.instance_id);const stopped=await f.api(path,'POST',stop,f.session.token);assert.equal(stopped.status,200);assert.equal(stopped.data.proof.kind,'previous_owner_exited');assert.equal(stopped.data.originalState,'reserved');assert.deepEqual(f.calls()[0],row);assert.equal(f.upstreamRequests.length,0);
    writeFileSync(join(f.root,'asserted-orphan-stop.json'),JSON.stringify({stop,receipt:stopped.data,original:row,syntheticModelReservation:true,upstreamRequests:0},null,2));
  }finally{await f.close();}
});

test('legacy ownerless requests and copied database owner identities cannot be inferred stopped',async()=>{
  const f=await failed();const row=f.calls()[0],owner=f.store.db.prepare('SELECT * FROM agent_model_owners').get()!,stop=input(f,row,owner);try{
    f.store.db.prepare('DELETE FROM agent_model_owners WHERE request_id=?').run(row.request_id);const result=await f.api(`/api/v1/operations/${f.parent.id}/agent-models`,'POST',stop,f.session.token);assert.equal(result.status,409);assert.equal(result.data.error.code,'agent_model_owner_unproven');f.store.db.prepare('INSERT INTO agent_model_owners VALUES(?,?,?,?,?,?,?,?)').run(owner.parent_id,owner.request_id,owner.instance_id,owner.execution_id,owner.generation,owner.route_hash,owner.phase,owner.joined_at);
  }finally{await f.close();}
  const copied=resolve('work/agent-owner-copy-'+randomUUID());mkdirSync(copied);copyFileSync(join(f.root,'reach.sqlite'),join(copied,'reach.sqlite'));const store=new ReachStore(join(copied,'reach.sqlite'));try{assert.throws(()=>store.models.recordStopped(f.session.user.id,f.parent.id,stop),/归属|推断/);assert.equal(store.db.prepare('SELECT count(*) AS n FROM agent_model_stops').get()!.n,0);writeFileSync(join(copied,'asserted.json'),JSON.stringify({source:f.root,originalOwner:owner.instance_id,currentOwner:store.owner.instanceId,oldLockIdentity:f.store.owner.lockIdentity,newLockIdentity:store.owner.lockIdentity,rejectedCopiedProof:true},null,2));}finally{store.close();}
});

test('a second broker and early Store close cannot release the model owner while shutdown is joining',async()=>{
  const f=await modelFixture();let consume:Promise<unknown>|undefined;try{assert.throws(()=>f.store.close(),/关闭并等待/);const other=new AgentModelBroker({endpoint:'http://127.0.0.1:9/v1',token:'not-a-live-organization-token',model:'other',contextWindow:65536,maxOutput:1024,imageInput:false,development:true});assert.throws(()=>other.bind(f.store),/另一个/);await other.close();
    f.handle((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(chunk('unfinished before close'));});consume=(await f.model()).text().catch(()=>{});const row=f.calls()[0],owner=f.store.db.prepare('SELECT * FROM agent_model_owners').get()!,stop=input(f,row,owner);f.record(f.dispatch,'unknown',{reason:'synthetic_node_closed',replayed:false});const stopping=f.broker.stop(f.session.user.id,f.parent.id,stop);
    const a=f.broker.close(),b=f.broker.close();assert.equal(a,b);assert.throws(()=>f.store.close(),/关闭并等待/);assert.throws(()=>new ReachStore(join(f.root,'reach.sqlite')),/Another Reach service/);const receipt=await stopping;await a;await consume;assert.equal(receipt.transportStopped,true);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM agent_model_stops').get()!.n,1);
    const foreign=new ReachStore(':memory:');try{assert.throws(()=>f.broker.bind(foreign),/状态库/);}finally{foreign.close();}
  }finally{await f.close();await consume;}
});

test('canonical aliases and hard-link database aliases cannot acquire a second service owner',async()=>{
  const f=await modelFixture(),alias=resolve('work/agent-owner-alias-'+randomUUID()),hard=join(f.root,'hard-alias.sqlite');try{
    if(process.platform==='win32'){symlinkSync(f.root,alias,'junction');assert.throws(()=>new ReachStore(join(alias,'reach.sqlite')),/Another Reach service/);}
    linkSync(join(f.root,'reach.sqlite'),hard);try{assert.throws(()=>new ReachStore(hard),/hard-link/);}finally{unlinkSync(hard);}f.store.owner.assertCurrent();
    assert.throws(()=>new ReachStore(join(f.root,'reach.sqlite')),/Another Reach service/);assert.equal(f.store.db.prepare('PRAGMA user_version').get()!.user_version,11);
  }finally{await f.close();}
});

test('the real process lock precedes business DB creation and a hard exit releases it for a new participant',{timeout:30000},async()=>{
  const root=resolve('work/agent-owner-process-'+randomUUID());mkdirSync(root);const database=join(root,'reach.sqlite'),held=new ServiceOwner(database),helper=resolve('tests/owner-process.ts');
  const blocked=spawn(process.execPath,[helper,database],{windowsHide:true,stdio:['ignore','pipe','pipe']});let error='';blocked.stderr.on('data',b=>error+=b);const [blockedCode]=await once(blocked,'exit');assert.notEqual(blockedCode,0);assert.match(error,/Another Reach service/);assert.equal(existsSync(database),false);held.close();
  const child=spawn(process.execPath,[helper,database],{windowsHide:true,stdio:['ignore','pipe','pipe']}),lines=createInterface({input:child.stdout});let ready:any;try{for await(const line of lines){ready=JSON.parse(line);break;}assert.equal(ready.event,'owner_ready');assert.throws(()=>new ReachStore(database),/Another Reach service/);const exited=once(child,'exit');child.kill('SIGKILL');const [code,signal]=await exited;
    const next=new ReachStore(database);try{assert.notEqual(next.owner.instanceId,ready.instanceId);assert.equal(next.owner.lockIdentity,ready.lockIdentity);writeFileSync(join(root,'asserted-owner-process.json'),JSON.stringify({blocked:{pid:blocked.pid,exitCode:blockedCode},original:{pid:child.pid,instance:ready.instanceId,lockIdentity:ready.lockIdentity,exitCode:code,signal},next:{instance:next.owner.instanceId,lockIdentity:next.owner.lockIdentity}},null,2));}finally{next.close();}
  }finally{lines.close();if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}held.close();}
});

test('shutdown joins active HTTP and Desk continuations before releasing its one owner',{timeout:20000},async()=>{
  const root=resolve('work/agent-owner-shutdown-'+randomUUID());mkdirSync(root);const database=join(root,'reach.sqlite'),store=new ReachStore(database);let releaseHandler!:()=>void,releaseDesk!:()=>void,entered=false,closing=false;
  const handler=new Promise<void>(r=>releaseHandler=r),deskGate=new Promise<void>(r=>releaseDesk=r),desk:DeskExtension={async serveStatic(route){if(route==='/held'){entered=true;await handler;}return false;},async handle(){},revoke(){},async close(){closing=true;await deskGate;}};
  const server=reachServer({store,desk,publicOrigin:'http://127.0.0.1',allowInsecureLoopback:true});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const pending=fetch(`http://127.0.0.1:${address.port}/held`).catch(()=>undefined);
  try{await until(()=>entered);const a=server.shutdown(),b=server.shutdown();assert.equal(a,b);await until(()=>closing);assert.throws(()=>new ReachStore(database),/Another Reach service/);releaseDesk();await delay(10);assert.equal(store.isOpen,true);assert.throws(()=>store.close(),/HTTP/);assert.throws(()=>new ReachStore(database),/Another Reach service/);
    releaseHandler();await a;await pending;assert.equal(store.isOpen,false);const next=new ReachStore(database);try{writeFileSync(join(root,'asserted-shutdown.json'),JSON.stringify({oldOwner:store.owner.instanceId,nextOwner:next.owner.instanceId,httpAndDeskJoined:true},null,2));}finally{next.close();}
  }finally{releaseDesk();releaseHandler();await server.shutdown();await pending;}
});

test('immediate shutdown waits asynchronous listen and a retired owner cannot listen again',{timeout:20000},async()=>{
  const root=resolve('work/agent-owner-listen-'+randomUUID());mkdirSync(root);const database=join(root,'reach.sqlite'),store=new ReachStore(database),server=reachServer({store,publicOrigin:'http://127.0.0.1',allowInsecureLoopback:true});let port=0;
  server.once('listening',()=>{const address=server.address();assert.ok(address&&typeof address!=='string');port=address.port;});server.listen(0,'localhost');assert.throws(()=>store.close(),/HTTP/);
  const a=server.shutdown();assert.equal(a,server.shutdown());await a;assert.ok(port>0);assert.equal(server.listening,false);assert.equal(store.isOpen,false);assert.throws(()=>server.listen(0,'127.0.0.1'),/重新监听/);assert.equal(await fetch(`http://localhost:${port}/healthz`).catch(()=>undefined),undefined);
  const next=new ReachStore(database),never=reachServer({store:next,publicOrigin:'http://127.0.0.1',allowInsecureLoopback:true});await never.shutdown();assert.throws(()=>never.listen(0,'127.0.0.1'),/重新监听/);writeFileSync(join(root,'asserted-listen.json'),JSON.stringify({port,oldOwner:store.owner.instanceId,nextOwner:next.owner.instanceId,pendingBindJoined:true,relistenRejected:true},null,2));
});

test('failed fixture reinitialization still closes its new Store and upstream',async()=>{
  const f=await modelFixture();try{await assert.rejects(f.reopen('short'));}finally{await f.close();}const reopened=new ReachStore(join(f.root,'reach.sqlite'));reopened.close();
});

test('actual service bootstrap and listen failures exit without leaving a lifetime owner',{timeout:30000},async()=>{
  for(const mode of ['bootstrap','listen']){const root=resolve('work/agent-owner-start-'+mode+'-'+randomUUID());mkdirSync(root);const blocker=createNetServer();let port=0;if(mode==='listen'){blocker.listen(0,'127.0.0.1');await once(blocker,'listening');const a=blocker.address();assert.ok(a&&typeof a!=='string');port=a.port;}
    const env={...process.env,REACH_DATA_DIR:root,REACH_PORT:String(port),REACH_LISTEN_HOST:'127.0.0.1',REACH_DEVELOPMENT:'1',REACH_PUBLIC_ORIGIN:'http://127.0.0.1',REACH_BOOTSTRAP_USERNAME:'failure-test',REACH_BOOTSTRAP_PASSWORD:mode==='bootstrap'?'short':'local-failure-test-password',REACH_RAY_SSO_KEY_FILE:''};for(const key of Object.keys(env))if(key.startsWith('REACH_AGENT_MODEL_'))delete env[key as keyof typeof env];
    const child=spawn(process.execPath,['src/service/main.ts'],{windowsHide:true,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    try{const [code,signal]=await once(child,'exit');assert.notEqual(code,0);assert.ok(!stdout.includes('reach_listening'));const next=new ReachStore(join(root,'reach.sqlite'));try{writeFileSync(join(root,'asserted-start-failure.json'),JSON.stringify({mode,pid:child.pid,exitCode:code,signal,nextOwner:next.owner.instanceId,stdout,stderr},null,2));}finally{next.close();}}
    finally{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}if(blocker.listening){const closed=once(blocker,'close');blocker.close();await closed;}}
  }
});

const previous6=process.env.REACH_SCHEMA6_SERVICE_MODULE;
test('the explicitly supplied frozen schema6 Store rejects ownership schema7',{skip:!previous6},async()=>{
  assert.ok(previous6);assert.equal(createHash('sha256').update(readFileSync(previous6)).digest('hex'),'3c2f8c2c75f29279ccd314a62bb4d7aab1fa7f50c028584e0cb40143b0ccf613');const f=await modelFixture();try{const Old=await import(pathToFileURL(previous6).href),before=f.calls();assert.throws(()=>new Old.ReachStore(join(f.root,'reach.sqlite')),/newer than/);assert.equal(f.store.db.prepare('PRAGMA user_version').get()!.user_version,11);assert.deepEqual(f.calls(),before);}finally{await f.close();}
});
