// Copyright (c) Ray Zhang. Real shared Rust sidecar and Reach HTTP; controlled provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ReachStore } from '../../src/service/store.ts';
import { reachServer } from '../../src/service/server.ts';
import { DeskHost } from '../src/host.ts';

const binary=process.env.REACH_DESK_SIDECAR;
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until<T>(read:()=>T|Promise<T>,accept:(value:T)=>boolean){for(let i=0;i<400;i++){const value=await read();if(accept(value))return value;await delay(50);}throw Error('Desk condition timed out');}
const firstDelta='原生流第一段：这是在上游完成之前就应该能看到的原始回答。';
async function fixture(gated=false,tools?:{name:string;arguments:unknown}[]){
  assert.ok(binary);const root=resolve('work/desk-cloud-'+randomUUID());mkdirSync(root,{recursive:true});
  const requests:any[]=[],releases=new Map<number,()=>void>(),finished=new Set<number>();let now=Date.now();
  const provider=createServer(async(request,response)=>{
    try{
      const chunks=[];for await(const chunk of request)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString());
      requests.push(input);appendFileSync(join(root,'provider-requests.jsonl'),JSON.stringify({path:request.url,body:input})+'\n');
      assert.equal(request.url,'/v1/chat/completions');assert.equal(request.headers.authorization,'Bearer controlled-desk-token');
      const number=requests.length;
      const waiting=input.messages.filter((m:any)=>m.role==='user'&&typeof m.content==='string'&&!m.content.startsWith('Fresh Host current-Run budget (')&&!m.content.startsWith('Host-derived working context;')).at(-1)?.content.startsWith('wait ');
      appendFileSync(join(root,'provider-lifecycle.jsonl'),JSON.stringify({number,event:'started',waiting})+'\n');
      response.once('close',()=>appendFileSync(join(root,'provider-lifecycle.jsonl'),JSON.stringify({number,event:'closed',finished:finished.has(number)})+'\n'));
      response.writeHead(200,{'content-type':'text/event-stream'});
      if(number===1&&tools){
        response.write('data: '+JSON.stringify({id:'desk-tools',model:'desk-fixture',choices:[{index:0,delta:{role:'assistant',tool_calls:tools.map((tool,index)=>({index,id:'actual-tool-'+index,type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.arguments)}}))},finish_reason:null}]})+'\n\n');
        response.end('data: '+JSON.stringify({id:'desk-tools',model:'desk-fixture',choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');return;
      }
      const chunk=(content:string|null,finish:string|null)=>response.write('data: '+JSON.stringify({id:'desk-response-'+requests.length,object:'chat.completion.chunk',model:'desk-fixture',choices:[{index:0,delta:content===null?{}:{role:'assistant',content},finish_reason:finish}]})+'\n\n');
      if(input.messages.some((m:any)=>m.role==='system'&&m.content?.startsWith('Summarize the supplied closed conversation'))){
        chunk(JSON.stringify({summary:'Controlled summary of retained original conversation.',candidates:[{kind:'fact',text:'An unadopted summary candidate.',source_ids:['ref-1']}]}),null);chunk(null,'stop');finished.add(number);response.end('data: [DONE]\n\n');return;
      }
      chunk(firstDelta,null);
      if(waiting){await once(response,'close');return;}
      if(gated){let timer:ReturnType<typeof setTimeout>|undefined;await new Promise<void>((resolve,reject)=>{releases.set(number,()=>{appendFileSync(join(root,'provider-lifecycle.jsonl'),JSON.stringify({number,event:'client_saw_delta'})+'\n');resolve();});timer=setTimeout(()=>reject(Error('Client must observe delta before provider finishes')),6000);}).finally(()=>clearTimeout(timer));}
      else await delay(400);
      chunk('回答 '+number,null);chunk(null,'stop');finished.add(number);appendFileSync(join(root,'provider-lifecycle.jsonl'),JSON.stringify({number,event:'finished'})+'\n');response.write('data: [DONE]\n\n');response.end();
    }catch{response.destroy();}
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');const address=provider.address();assert.ok(address&&typeof address!=='string');
  const store=new ReachStore(join(root,'reach.sqlite'),()=>now);store.bootstrap('desk-test','controlled-desk-password');
  const session=store.login('desk-test','controlled-desk-password');
  const config={stateDirectory:join(root,'desk'),binary,endpoint:`http://127.0.0.1:${address.port}/v1`,model:'desk-fixture',modelToken:'controlled-desk-token',developmentLoopback:true,maxSeconds:25};
  const desk=new DeskHost(config),server=reachServer({store,desk,publicOrigin:'http://127.0.0.1',allowInsecureLoopback:true});
  server.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a!=='string');const base=`http://127.0.0.1:${a.port}`;
  const request=(path:string,method='GET',data?:unknown,token=session.token,signal?:AbortSignal)=>fetch(base+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)}),signal});
  const create=async()=>{const id=randomUUID();const response=await request('/api/v1/desk/conversations','POST',{id});assert.equal(response.status,201);return id;};
  return {root,base,requests,finished,release:(n:number)=>releases.get(n)?.(),store,desk,config,session,request,create,expire:()=>{now+=13*60*60*1000;},async close(){await desk.close();server.close();server.closeAllConnections();await once(server,'close');store.close();provider.close();provider.closeAllConnections();await once(provider,'close');console.log(JSON.stringify({deskEvidence:root}));}};
}
async function consume(response:Response,onFrame?:(frame:any)=>void){assert.equal(response.status,200,await(response.status===200?Promise.resolve(''):response.text()));const reader=response.body!.getReader();const decoder=new TextDecoder();let pending='';const events:any[]=[];for(;;){const{value,done}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});for(let p=pending.indexOf('\n\n');p>=0;p=pending.indexOf('\n\n')){const frame=pending.slice(0,p);pending=pending.slice(p+2);const event=frame.split('\n').find(v=>v.startsWith('event: '))?.slice(7),data=frame.split('\n').find(v=>v.startsWith('data: '))?.slice(6);if(data){const item={event,...JSON.parse(data)};events.push(item);onFrame?.(item);}}}return events;}

test('Desk streams actual native output, deduplicates POST and retains one Session across two tasks',{skip:!binary,timeout:60000},async()=>{
  const f=await fixture(true);
  try{
    const conversation=await f.create(),id=randomUUID(),path=`/api/v1/desk/conversations/${conversation}/messages`,input={id,content:'First native message'};
    let liveDelta=false;
    const first=await f.request(path,'POST',input);
    const a=consume(first,item=>{if(item.event==='delta'&&item.text===firstDelta){assert.ok(!f.finished.has(1));liveDelta=true;f.release(1);}});
    const b=consume(await f.request(path,'POST',input));
    const [one,two]=await Promise.all([a,b]);
    assert.equal(f.requests.length,1);assert.ok(liveDelta,'text must arrive before native Task settlement');
    assert.equal(one.at(-1).status,'completed',JSON.stringify(one));assert.equal(two.at(-1).output,firstDelta+'回答 1');
    assert.equal(f.desk.store.turn(f.session.user.id,id).cancel_requested,0,'normal stream completion must not cancel the Task');
    assert.equal((await f.request(path,'POST',{...input,content:'changed'})).status,409);
    const secondId=randomUUID(),second=await consume(await f.request(path,'POST',{id:secondId,content:'Second native message'}),item=>{if(item.event==='delta'&&item.text===firstDelta){assert.ok(!f.finished.has(2));f.release(2);}});
    assert.equal(second.at(-1).status,'completed',JSON.stringify(second));assert.equal(f.requests.length,2);
    const users=f.requests[1].messages.filter((m:any)=>m.role==='user');
    assert.ok(JSON.stringify(users).includes('First native message'));assert.ok(JSON.stringify(users).includes('Second native message'));
    assert.equal(users.filter((m:any)=>m.content==='First native message').length,1,'history must not be replayed as a new prompt');
    for(const request of f.requests)assert.deepEqual(request.tools.map((tool:any)=>tool.function.name).sort(),['task_update','history_read','history_search','reference_read','reference_search','memory_propose','experience_propose','experience_search'].sort(),'only Core Session tools; no cloud local or device execution tools');
    const original=await (await f.request('/api/v1/desk/messages/'+id)).json();assert.equal((original as any).output,firstDelta+'回答 1');
    writeFileSync(join(f.root,'asserted.json'),JSON.stringify({first:one,second,liveDelta,providerCalls:f.requests.length},null,2));
  }finally{await f.close();}
});

test('Desk reconciles actual candidate persistence, failed proposal and Session reads before continuing',{skip:!binary,timeout:60000},async()=>{
  const f=await fixture(false,[{name:'memory_propose',arguments:{kind:'fact',text:'This is an unadopted local candidate.',source_ids:['ref-1']}},{name:'memory_propose',arguments:{kind:'fact',text:'Must not persist without a source.',source_ids:['ref-missing']}},{name:'reference_read',arguments:{id:'ref-1'}},{name:'history_search',arguments:{query:'proposal'}}]);
  try{
    const conversation=await f.create(),id=randomUUID(),path=`/api/v1/desk/conversations/${conversation}/messages`;
    const reading=consume(await f.request(path,'POST',{id,content:'wait proposal receipt then cancellation'}));
    await until(()=>f.desk.store.events(f.session.user.id,id,0),rows=>rows.some(row=>row.kind==='delta'));
    await f.request('/api/v1/desk/messages/'+id+'/cancel','POST',{});const events=await reading;assert.equal(events.at(-1).status,'cancelled');
    const turn=f.desk.store.turn(f.session.user.id,id);assert.equal(f.desk.store.conversation(f.session.user.id,conversation).blocked,0);
    const root=join(f.config.stateDirectory,'tasks',turn.task_id),review=JSON.parse(readFileSync(join(root,'effects-review.json'),'utf8'));
    assert.deepEqual(review.effects.calls.map((c:any)=>c.effect),['persisted-candidate','absent','native-receipt','native-receipt']);
    const context=JSON.parse(readFileSync(join(f.config.stateDirectory,'sessions',conversation,'session.context.json'),'utf8'));
    assert.equal(context.memories.length,1);assert.equal(context.memories[0].status,'candidate');assert.equal(context.memories[0].adoption,null);
    const adopt=await consume(await f.request(path,'POST',{id:randomUUID(),content:'/memory accept mem-1'}));assert.equal(adopt.at(-1).status,'completed');assert.equal(f.requests.length,2);
    const corrected=await consume(await f.request(path,'POST',{id:randomUUID(),content:'/reference correct ref-1 Replacement source from the user.'}));assert.equal(corrected.at(-1).status,'completed');assert.equal(f.requests.length,2);
    const afterCommandId=randomUUID(),afterCommand=consume(await f.request(path,'POST',{id:afterCommandId,content:'wait after management effects'}));
    await until(()=>f.requests.length,n=>n===3);await f.request('/api/v1/desk/messages/'+afterCommandId+'/cancel','POST',{});await afterCommand;
    assert.equal(f.desk.store.conversation(f.session.user.id,conversation).blocked,0,'already accepted memory and corrected source survive a later cancellation');
    const next=await consume(await f.request(path,'POST',{id:randomUUID(),content:'Continue using the original receipt history.'}));
    assert.equal(next.at(-1).status,'completed');assert.equal(f.requests.length,4);assert.ok(JSON.stringify(f.requests[3].messages).includes('Replacement source from the user.'));
    writeFileSync(join(f.root,'proposal-asserted.json'),JSON.stringify({review,next,providerCalls:f.requests.length},null,2));
  }finally{await f.close();}
});

test('Desk disconnect and explicit stop reconcile native effects and continue the original Session',{skip:!binary,timeout:60000},async()=>{
  const f=await fixture();
  try{
    const conversation=await f.create(),id=randomUUID(),controller=new AbortController();
    const response=await f.request(`/api/v1/desk/conversations/${conversation}/messages`,'POST',{id,content:'wait until stopped'},f.session.token,controller.signal);
    const reading=consume(response).catch(()=>[]);
    await until(()=>f.desk.store.events(f.session.user.id,id,0),rows=>rows.some(row=>row.kind==='delta'));
    controller.abort();await reading;
    const done=await until(()=>f.desk.store.turn(f.session.user.id,id),turn=>!['starting','running','cancelling'].includes(turn.status));
    assert.equal(done.cancel_requested,1);assert.equal(done.status,'cancelled');assert.equal(f.requests.length,1);
    assert.equal(f.desk.store.conversation(f.session.user.id,conversation).blocked,0);
    assert.ok(done.close_intent_json);assert.ok(done.close_result_json);assert.ok(done.output.includes(firstDelta));
    const next=await consume(await f.request(`/api/v1/desk/conversations/${conversation}/messages`,'POST',{id:randomUUID(),content:'continue the original session'}));
    assert.equal(next.at(-1).status,'completed');assert.equal(f.requests.length,2);
    assert.ok(JSON.stringify(f.requests[1].messages).includes('wait until stopped'),'the next Task uses original native history');
    const retry=await consume(await f.request(`/api/v1/desk/conversations/${conversation}/messages`,'POST',{id,content:'wait until stopped'}));assert.equal(retry.at(-1).status,'cancelled');assert.equal(f.requests.length,2);
    const other=await f.create(),otherId=randomUUID(),otherResponse=await f.request(`/api/v1/desk/conversations/${other}/messages`,'POST',{id:otherId,content:'wait explicit cancel'}),otherReading=consume(otherResponse);
    await until(()=>f.requests.length,n=>n===3);
    assert.equal((await f.request('/api/v1/desk/messages/'+otherId+'/cancel','POST',{})).status,202);
    assert.equal((await otherReading).at(-1).status,'cancelled');
    assert.equal(f.desk.store.conversation(f.session.user.id,other).blocked,0);
    writeFileSync(join(f.root,'cancel-asserted.json'),JSON.stringify({first:done,originalRequests:f.requests.length},null,2));
  }finally{await f.close();}
});

test('Desk reconciles real summary and unadopted summary candidates on cancellation',{skip:!binary,timeout:90000},async()=>{
  const f=await fixture();
  try{
    const conversation=await f.create(),path=`/api/v1/desk/conversations/${conversation}/messages`;
    for(let n=0;n<2;n++){const done=await consume(await f.request(path,'POST',{id:randomUUID(),content:'Original source '+n+' '+String(n).repeat(3400)}));assert.equal(done.at(-1).status,'completed');}
    const id=randomUUID(),reading=consume(await f.request(path,'POST',{id,content:'wait after summary '+ 's'.repeat(3400)}));
    await until(()=>f.desk.store.events(f.session.user.id,id,0),rows=>rows.some(row=>row.kind==='delta'));
    await f.request('/api/v1/desk/messages/'+id+'/cancel','POST',{});await reading;
    const turn=f.desk.store.turn(f.session.user.id,id);assert.equal(f.desk.store.conversation(f.session.user.id,conversation).blocked,0);
    const context=JSON.parse(readFileSync(join(f.config.stateDirectory,'sessions',conversation,'session.context.json'),'utf8'));
    assert.equal(context.summary?.run,turn.run_id);assert.ok(context.memories.length>0);assert.ok(context.memories.every((m:any)=>m.status==='candidate'&&m.adoption===null));
    const review=JSON.parse(readFileSync(join(f.config.stateDirectory,'tasks',turn.task_id,'effects-review.json'),'utf8'));assert.equal(review.effects.context.summaryChanged,true);
    const next=await consume(await f.request(path,'POST',{id:randomUUID(),content:'Continue the compacted original conversation.'}));assert.equal(next.at(-1).status,'completed');
    writeFileSync(join(f.root,'summary-asserted.json'),JSON.stringify({review,summary:context.summary,candidates:context.memories,providerCalls:f.requests.length},null,2));
  }finally{await f.close();}
});

test('Desk cookie CSRF, account ownership, logout and expiry use the Reach session',{skip:!binary,timeout:60000},async()=>{
  const f=await fixture();
  try{
    const conversation=await f.create();
    const user=f.store.db.prepare('SELECT * FROM users LIMIT 1').get() as any;
    f.store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(randomUUID(),'another',user.salt,user.password_hash);
    const foreign=f.store.login('another','controlled-desk-password');
    assert.equal((await f.request('/api/v1/desk/conversations/'+conversation,'GET',undefined,foreign.token)).status,404);
    assert.equal((await f.request(`/api/v1/desk/conversations/${conversation}/messages`,'POST',{id:randomUUID(),content:'not owned'},foreign.token)).status,404);
    const cookieHeaders={cookie:'reach_session='+f.session.token,origin:'http://127.0.0.1','content-type':'application/json'};
    assert.equal((await fetch(f.base+'/api/v1/desk/conversations',{method:'POST',headers:cookieHeaders,body:JSON.stringify({id:randomUUID()})})).status,403);
    const firstId=randomUUID();
    const first=consume(await fetch(f.base+`/api/v1/desk/conversations/${conversation}/messages`,{method:'POST',headers:{...cookieHeaders,'x-reach-csrf':f.session.csrf},body:JSON.stringify({id:firstId,content:'wait logout'})}));
    const secondSession=f.store.login('desk-test','controlled-desk-password'),otherConversation=randomUUID(),secondId=randomUUID();
    assert.equal((await f.request('/api/v1/desk/conversations','POST',{id:otherConversation},secondSession.token)).status,201);
    const second=consume(await f.request(`/api/v1/desk/conversations/${otherConversation}/messages`,'POST',{id:secondId,content:'wait expiry'},secondSession.token));
    await until(()=>f.requests.length,n=>n===2);
    assert.equal((await f.request('/api/v1/auth/logout','POST',{})).status,200);await first;
    const one=await until(()=>f.desk.store.turn(f.session.user.id,firstId),turn=>!['starting','running','cancelling'].includes(turn.status));assert.equal(one.status,'cancelled');
    assert.equal(f.desk.store.turn(f.session.user.id,secondId).cancel_requested,0,'another login of the same account must retain its own running task');
    f.expire();await second;
    const two=await until(()=>f.desk.store.turn(f.session.user.id,secondId),turn=>!['starting','running','cancelling'].includes(turn.status));assert.equal(two.status,'cancelled');
    assert.equal((await f.request('/api/v1/desk/conversations','GET',undefined,secondSession.token)).status,401);
    writeFileSync(join(f.root,'auth-asserted.json'),JSON.stringify({logout:one.status,expiry:two.status,providerCalls:f.requests.length}));
  }finally{await f.close();}
});

test('Desk process crash preserves original task identity and restart never resubmits it',{skip:!binary,timeout:90000},async()=>{
  const f=await fixture();let child:ReturnType<typeof spawn>|undefined;
  const environment={...process.env,REACH_PORT:'0',REACH_DEVELOPMENT:'1',REACH_LISTEN_HOST:'127.0.0.1',REACH_PUBLIC_ORIGIN:'http://127.0.0.1',REACH_DATA_DIR:join(f.root,'process-reach'),REACH_BOOTSTRAP_USERNAME:'process-desk',REACH_BOOTSTRAP_PASSWORD:'controlled-process-password',REACH_DESK_STATE_DIR:join(f.root,'process-desk'),REACH_DESK_SIDECAR:binary!,REACH_DESK_ENDPOINT:f.config.endpoint,REACH_DESK_MODEL:'desk-fixture',REACH_DESK_MODEL_TOKEN:'controlled-desk-token',REACH_DESK_LOOPBACK_RELAY:'1'};
  async function launch(){
    child=spawn(process.execPath,['platform/src/main.ts'],{cwd:resolve('.'),windowsHide:true,env:environment,stdio:['ignore','pipe','pipe']});
    let errors='';child.stderr!.on('data',chunk=>{errors+=chunk;writeFileSync(join(f.root,'process-stderr.log'),errors);});
    const lines=createInterface({input:child.stdout!});let base='';const deadline=setTimeout(()=>child?.kill(),15000);
    try{for await(const line of lines){const event=JSON.parse(line);if(event.event==='reach_listening'){base=`http://127.0.0.1:${event.port}`;break;}}}finally{clearTimeout(deadline);lines.close();}
    assert.ok(base,errors);return base;
  }
  async function crash(){if(child&&child.exitCode===null){const stopped=once(child,'exit');if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill('SIGKILL');await stopped;}}
  try{
    let base=await launch();
    const login=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'process-desk',password:'controlled-process-password'})});assert.equal(login.status,200);const token=(await login.json() as any).token;
    const request=(path:string,method='GET',data?:unknown)=>fetch(base+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
    const conversation=randomUUID(),id=randomUUID(),path=`/api/v1/desk/conversations/${conversation}/messages`,input={id,content:'wait crash'};
    assert.equal((await request('/api/v1/desk/conversations','POST',{id:conversation})).status,201);
    const original=consume(await request(path,'POST',input)).catch(()=>[]);
    await until(()=>f.requests.length,n=>n===1);const before=await(await request('/api/v1/desk/messages/'+id)).json() as any;
    await crash();await original;base=await launch();
    const after=await(await request('/api/v1/desk/messages/'+id)).json() as any;assert.equal(after.status,'unknown');assert.equal(after.taskId,before.taskId);assert.equal(after.runId,before.runId);
    const retry=await consume(await request(path,'POST',input));assert.equal(retry.at(-1).status,'unknown');assert.equal(f.requests.length,1);
    assert.equal((await request(path,'POST',{id:randomUUID(),content:'blocked original session'})).status,409);
    const freshConversation=randomUUID();assert.equal((await request('/api/v1/desk/conversations','POST',{id:freshConversation})).status,201);
    const fresh=await consume(await request(`/api/v1/desk/conversations/${freshConversation}/messages`,'POST',{id:randomUUID(),content:'fresh explicit conversation'}));assert.equal(fresh.at(-1).status,'completed');assert.equal(f.requests.length,2);
    writeFileSync(join(f.root,'process-asserted.json'),JSON.stringify({before,after,providerCalls:f.requests.length},null,2));
  }finally{await crash();await f.close();}
});

test('Desk close joins an active reply, closes its SSE and is idempotent',{skip:!binary,timeout:45000},async()=>{
  const f=await fixture();
  try{
    const conversation=await f.create(),id=randomUUID();const response=await f.request(`/api/v1/desk/conversations/${conversation}/messages`,'POST',{id,content:'wait shutdown'}),reading=consume(response).catch(()=>[]);
    await until(()=>f.requests.length,n=>n===1);
    await Promise.all([f.desk.close(),f.desk.close()]);await reading;
    assert.equal((await f.request('/api/v1/desk/conversations')).status,503);
  }finally{await f.close();}
});

test('Desk restarts after joined second close before database release without resetting attempt budget',{skip:!binary,timeout:90000},async()=>{
  const f=await fixture();let child:ReturnType<typeof spawn>|undefined;
  const script=join(f.root,'crash-after-close.mjs'),state=join(f.root,'restart-desk');
  writeFileSync(script,`import {DeskHost} from ${JSON.stringify(pathToFileURL(resolve('platform/src/host.ts')).href)};
import {ReachStore} from ${JSON.stringify(pathToFileURL(resolve('src/service/store.ts')).href)};
import {reachServer} from ${JSON.stringify(pathToFileURL(resolve('src/service/server.ts')).href)};
const desk=new DeskHost(${JSON.stringify({...f.config,stateDirectory:state})});
if(process.env.LOCAL_CRASH_CAS==='1')desk.store.completeSettlement=(id)=>{const t=desk.store.db.prepare('SELECT close_attempts FROM turns WHERE id=?').get(id);if(t.close_attempts===2)process.exit(37);return false;};
const store=new ReachStore(${JSON.stringify(join(f.root,'restart-reach.sqlite'))});store.bootstrap('restart-test','local-restart-password');
const server=reachServer({store,desk,publicOrigin:'http://127.0.0.1',allowInsecureLoopback:true});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));`);
  async function launch(crash:boolean){child=spawn(process.execPath,[script],{windowsHide:true,env:{...process.env,LOCAL_CRASH_CAS:crash?'1':'0'},stdio:['ignore','pipe','pipe']});let errors='';child.stderr!.on('data',b=>{errors+=b;writeFileSync(join(f.root,'restart-stderr.log'),errors);});const lines=createInterface({input:child.stdout!});const timeout=setTimeout(()=>child?.kill(),15000);try{for await(const line of lines){const v=JSON.parse(line);if(v.port)return `http://127.0.0.1:${v.port}`;}throw Error(errors||'restart process unavailable');}finally{clearTimeout(timeout);lines.close();}}
  try{
    let base=await launch(true);const login=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'restart-test',password:'local-restart-password'})});const token=(await login.json() as any).token;
    const request=(path:string,method='GET',body?:unknown)=>fetch(base+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const conversation=randomUUID(),id=randomUUID(),path=`/api/v1/desk/conversations/${conversation}`;
    assert.equal((await request('/api/v1/desk/conversations','POST',{id:conversation})).status,201);
    const reading=consume(await request(path+'/messages','POST',{id,content:'wait until joined close before CAS'})).catch(()=>[]);
    await until(()=>f.requests.length,n=>n===1);const exited=once(child!,'exit');await request('/api/v1/desk/messages/'+id+'/cancel','POST',{});const[code]=await exited;assert.equal(code,37);await reading;
    base=await launch(false);const restored=await(await request(path)).json() as any;
    assert.equal(restored.conversation.blocked,0);assert.equal(restored.messages[0].status,'cancelled');assert.equal(restored.messages[0].taskAccepted,false);
    const taskId=restored.messages[0].taskId,operation=JSON.parse(readFileSync(join(state,'tasks',taskId,'close-2','client-result.json'),'utf8'));assert.equal(operation.delivery,'validated');
    const result=await consume(await request(path+'/messages','POST',{id:randomUUID(),content:'continue after process recovery'}));assert.equal(result.at(-1).status,'completed');assert.equal(f.requests.length,2);
    writeFileSync(join(f.root,'restart-asserted.json'),JSON.stringify({exitCode:code,restored,secondOperation:operation,providerCalls:f.requests.length},null,2));
  }finally{if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}await f.close();}
});
