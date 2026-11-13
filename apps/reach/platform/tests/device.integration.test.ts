// Copyright (c) Ray Zhang. Actual Reach Node + shared sidecar; loopback model only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createServer as portServer} from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,appendFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {ReachStore} from '../../src/service/store.ts';
import {reachServer} from '../../src/service/server.ts';
import {DeskHost} from '../src/host.ts';
const binary=process.env.REACH_DESK_SIDECAR,nodeBinary=process.env.REACH_NODE_BINARY;
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until<T>(read:()=>T|Promise<T>,accept:(v:T)=>boolean,ms=30000){const end=Date.now()+ms;while(Date.now()<end){const v=await read();if(accept(v))return v;await delay(75);}throw Error('Local device condition timed out');}
function child(args:string[]){const proc=spawn(nodeBinary!,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',errors='';proc.stdout.on('data',b=>output+=b);proc.stderr.on('data',b=>errors+=b);const done=new Promise<{code:number|null;output:string;errors:string}>((resolve,reject)=>{proc.once('error',reject);proc.once('close',code=>resolve({code,output,errors}));});return {proc,done};}
async function kill(c:ReturnType<typeof child>|undefined){if(c&&c.proc.exitCode===null&&c.proc.signalCode===null)c.proc.kill();if(c)await c.done;}
type ModelReply={text?:string;tools?:{id:string;name:string;arguments:unknown}[];hold?:boolean};
async function fixture(model:(input:any,index:number)=>ModelReply|Promise<ModelReply>){
  const root=resolve('work/desk-device-'+randomUUID());mkdirSync(root,{recursive:true});
  const requests:any[]=[],provider=createServer(async(req,res)=>{try{const chunks=[];for await(const b of req)chunks.push(b);const input=JSON.parse(Buffer.concat(chunks).toString());requests.push(input);appendFileSync(join(root,'provider-requests.jsonl'),JSON.stringify(input)+'\n');const reply=await model(input,requests.length);res.writeHead(200,{'content-type':'text/event-stream'});
    const send=(delta:any,finish:string|null=null)=>res.write('data: '+JSON.stringify({id:'local-device',model:'device-fixture',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');
    if(reply.tools){send({role:'assistant',tool_calls:reply.tools.map((c,index)=>({index,id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.arguments)}}))});send({},'tool_calls');}
    else{send({role:'assistant',content:reply.text??'Local device reply.'});if(reply.hold){await once(res,'close');return;}send({},'stop');}
    res.end('data: [DONE]\n\n');
  }catch{res.destroy();}});provider.listen(0,'127.0.0.1');await once(provider,'listening');const p=provider.address();assert.ok(p&&typeof p!=='string');
  const reach=new ReachStore(join(root,'reach.sqlite'));reach.bootstrap('device-test','local-device-test-password');const session=reach.login('device-test','local-device-test-password');
  const config={stateDirectory:join(root,'desk'),binary:binary!,endpoint:`http://127.0.0.1:${p.port}/v1`,model:'device-fixture',modelToken:'local-device-token',developmentLoopback:true,maxSeconds:60,maxCalls:8};
  const probe=portServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const available=probe.address();assert.ok(available&&typeof available!=='string');const port=available.port;await new Promise<void>(r=>probe.close(()=>r()));
  const base=`http://127.0.0.1:${port}`,desk=new DeskHost(config),server=reachServer({store:reach,desk,publicOrigin:base,allowInsecureLoopback:true});server.listen(port,'127.0.0.1');await once(server,'listening');const children:ReturnType<typeof child>[]=[];
  const request=(path:string,method='GET',data?:unknown)=>fetch(base+path,{method,headers:{authorization:'Bearer '+session.token,'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
  async function node(name:string){const state=join(root,'node-'+name),cwd=join(root,'remote-'+name);mkdirSync(cwd);const code=reach.createPairing(session.user.id).code;const paired=await child(['--state-dir',state,'pair','--server',base,'--code',code,'--name',name,'--development']).done;assert.equal(paired.code,0,paired.errors);const runner=child(['--state-dir',state,'run']);children.push(runner);const target:any=await until(()=>reach.nodes(session.user.id).find((n:any)=>n.name===name),(n:any)=>n?.online&&n.capabilities.includes('command.run'));return {state,cwd,runner,target:{nodeId:target.id,epoch:target.epoch,cwd}};}
  async function conversation(){const id=randomUUID();assert.equal((await request('/api/v1/desk/conversations','POST',{id})).status,201);return id;}
  async function repair(original:Awaited<ReturnType<typeof node>>,name:string){await kill(original.runner);const code=reach.createPairing(session.user.id).code,paired=await child(['--state-dir',original.state,'pair','--server',base,'--code',code,'--name',name,'--development']).done;assert.equal(paired.code,0,paired.errors);const runner=child(['--state-dir',original.state,'run']);children.push(runner);const current:any=await until(()=>reach.nodes(session.user.id).find((n:any)=>n.id===original.target.nodeId),(n:any)=>n?.online&&n.epoch>original.target.epoch&&n.capabilities.includes('command.run'));return {...original,runner,target:{nodeId:current.id,epoch:current.epoch,cwd:original.cwd}};}
  return {root,reach,session,desk,config,base,requests,request,node,repair,conversation,async close(){await desk.close();for(const c of children)await kill(c);server.close();server.closeAllConnections();await once(server,'close');reach.close();provider.close();provider.closeAllConnections();await once(provider,'close');console.log(JSON.stringify({deskDeviceEvidence:root}));}};
}
async function consume(response:Response){assert.equal(response.status,200);const text=await response.text();return text.split('\n').filter(s=>s.startsWith('data: ')).map(s=>JSON.parse(s.slice(6)));}

test('Desk routes real file and command tools to the selected Node and preserves the original Session',{skip:!binary||!nodeBinary,timeout:120000},async()=>{
  const f=await fixture((_input,index)=>index===1?{tools:[{id:'write',name:'reach_execute',arguments:{command:{kind:'file.write',path:'written.txt',contentBase64:Buffer.from('现场 UTF-8 文件').toString('base64')}}},{id:'command',name:'reach_execute',arguments:{command:{kind:'command.run',command:"[IO.File]::AppendAllText('effect.txt','once');[Console]::WriteLine('onsite-stdout')",timeoutMs:10000}}}]}:index===2?{tools:[{id:'read',name:'reach_execute',arguments:{command:{kind:'file.read',path:'written.txt',length:16384}}},{id:'list',name:'reach_execute',arguments:{command:{kind:'directory.list',path:'.'}}}]}:{text:'The original device receipts were received; Task acceptance remains with the user.'});
  try{
    const node=await f.node('A'),conversation=await f.conversation(),id=randomUUID(),path=`/api/v1/desk/conversations/${conversation}/messages`;
    const one=await consume(await f.request(path,'POST',{id,content:'Apply device operations using the selected target.',target:node.target}));
    assert.equal(one.at(-1).status,'completed',JSON.stringify(one));assert.equal(readFileSync(join(node.cwd,'written.txt'),'utf8'),'现场 UTF-8 文件');assert.equal(readFileSync(join(node.cwd,'effect.txt'),'utf8'),'once');
    const turn=f.desk.store.turn(f.session.user.id,id),calls=f.desk.store.deviceCalls(turn);assert.equal(calls.length,4);assert.ok(calls.every(c=>c.status==='settled'&&c.operation_id));
    const ops=calls.map(c=>f.reach.operation(f.session.user.id,c.operation_id!));assert.ok(ops.every(op=>op.node_id===node.target.nodeId&&op.epoch===node.target.epoch&&op.execution==='succeeded'));
    assert.equal(existsSync(join(f.config.stateDirectory,'sessions',conversation,'workspace','effect.txt')),false,'cloud workspace must never execute the device command');
    const second=await consume(await f.request(path,'POST',{id:randomUUID(),content:'Continue without a device target.'}));assert.equal(second.at(-1).status,'completed');assert.equal(f.requests.length,4);assert.ok(JSON.stringify(f.requests[3].messages).includes('onsite-stdout')||JSON.stringify(f.requests[3].messages).includes(ops[0].id));assert.ok(!f.requests[3].tools.some((t:any)=>t.function.name==='reach_execute'));
    const duplicate=await consume(await f.request(path,'POST',{id,content:'Apply device operations using the selected target.',target:node.target}));assert.equal(duplicate.at(-1).status,'completed');assert.equal(f.reach.operations(f.session.user.id).length,4);
    writeFileSync(join(f.root,'asserted.json'),JSON.stringify({operations:ops,calls,providerCalls:f.requests.length,nodeBinarySha256:createHash('sha256').update(readFileSync(nodeBinary!)).digest('hex')},null,2));
  }finally{await f.close();}
});

test('joined device effect then cancellation closes the original Task and continues without repeating the action',{skip:!binary||!nodeBinary,timeout:90000},async()=>{
  const f=await fixture((_input,index)=>index===1?{tools:[{id:'persist',name:'reach_execute',arguments:{command:{kind:'file.write',path:'once.txt',contentBase64:Buffer.from('one committed write').toString('base64')}}}]}:index===2?{text:'The device receipt is saved. '.repeat(24),hold:true}:{text:'Continue the original Session using the saved device receipt.'});
  try{const node=await f.node('A'),conversation=await f.conversation(),id=randomUUID(),path=`/api/v1/desk/conversations/${conversation}/messages`,input={id,content:'Write once then wait for cancellation.',target:node.target},reading=consume(await f.request(path,'POST',input));
    await until(()=>f.requests.length,n=>n===2);await f.request('/api/v1/desk/messages/'+id+'/cancel','POST',{});const frames=await reading;assert.equal(frames.at(-1).status,'cancelled');assert.equal(f.desk.store.conversation(f.session.user.id,conversation).blocked,0);
    const turn=f.desk.store.turn(f.session.user.id,id);assert.ok(turn.close_intent_json);const review=JSON.parse(readFileSync(join(f.config.stateDirectory,'tasks',turn.task_id,'effects-review.json'),'utf8'));assert.equal(review.effects.calls[0].effect,'original-device-receipt');
    assert.equal((await consume(await f.request(path,'POST',{id:randomUUID(),content:'Continue without executing the action again.',target:node.target}))).at(-1).status,'completed');
    await consume(await f.request(path,'POST',input));assert.equal(f.reach.operations(f.session.user.id).length,1);assert.equal(readFileSync(join(node.cwd,'once.txt'),'utf8'),'one committed write');writeFileSync(join(f.root,'close-asserted.json'),JSON.stringify({review,turn,providerCalls:f.requests.length},null,2));
  }finally{await f.close();}
});

test('running command cancellation keeps unknown effects blocked and never replays the committed prefix',{skip:!binary||!nodeBinary,timeout:90000},async()=>{
  const f=await fixture((_input,index)=>index===1?{tools:[{id:'running',name:'reach_execute',arguments:{command:{kind:'command.run',command:"[IO.File]::AppendAllText('started.txt','once');[Console]::WriteLine('started');Start-Sleep -Seconds 90;[IO.File]::WriteAllText('finished.txt','should not exist')",timeoutMs:120000}}}]}:{text:'The original operation needs reconciliation.'});
  try{const node=await f.node('A'),conversation=await f.conversation(),id=randomUUID(),path=`/api/v1/desk/conversations/${conversation}/messages`,input={id,content:'Run until explicitly stopped.',target:node.target},reading=consume(await f.request(path,'POST',input));await until(()=>existsSync(join(node.cwd,'started.txt')),Boolean);
    await f.request('/api/v1/desk/messages/'+id+'/cancel','POST',{});const frames=await reading;assert.ok(['cancelled','unknown'].includes(frames.at(-1).status));assert.equal(f.desk.store.conversation(f.session.user.id,conversation).blocked,1);
    const op:any=await until(()=>f.reach.operations(f.session.user.id)[0],(op:any)=>op?.execution==='unknown');assert.equal(JSON.parse(op.result_json).processTreeStopped,true);assert.equal(readFileSync(join(node.cwd,'started.txt'),'utf8'),'once');assert.equal(existsSync(join(node.cwd,'finished.txt')),false);
    await consume(await f.request(path,'POST',input));assert.equal((await f.request(path,'POST',{id:randomUUID(),content:'must remain blocked',target:node.target})).status,409);assert.equal(f.reach.operations(f.session.user.id).length,1);writeFileSync(join(f.root,'unknown-asserted.json'),JSON.stringify({op,frames,providerCalls:f.requests.length},null,2));
  }finally{await f.close();}
});

test('re-pairing rejects a pinned old target before enqueue and duplicate old messages retain their original Run',{skip:!binary||!nodeBinary,timeout:90000},async()=>{
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>started=r);
  const f=await fixture(async(_input,index)=>{if(index===1){started();await gate;return {tools:[{id:'stale-target',name:'reach_execute',arguments:{command:{kind:'file.write',path:'wrong-epoch.txt',contentBase64:Buffer.from('must not execute').toString('base64')}}}]};}return {text:'The selected pairing changed; no operation was submitted.'};});
  try{const node=await f.node('A'),conversation=await f.conversation(),id=randomUUID(),path=`/api/v1/desk/conversations/${conversation}/messages`,input={id,content:'Use the originally selected pairing.',target:node.target},reading=consume(await f.request(path,'POST',input));await ready;const repaired=await f.repair(node,'A');assert.ok(repaired.target.epoch>node.target.epoch);release();const frames=await reading;assert.equal(frames.at(-1).status,'completed');assert.equal(f.reach.operations(f.session.user.id).length,0);assert.equal(existsSync(join(node.cwd,'wrong-epoch.txt')),false);
    const turn=f.desk.store.turn(f.session.user.id,id),call=f.desk.store.deviceCalls(turn)[0];assert.equal(JSON.parse(call.receipt_json!).reply.settlement,'Settled');assert.equal(JSON.parse(call.receipt_json!).reply.value.error,'node_pairing_changed');
    await consume(await f.request(path,'POST',input));assert.equal(f.requests.length,2);assert.equal((await f.request(path,'POST',{id:randomUUID(),content:'new message with stale target',target:node.target})).status,409);assert.equal((await f.request(path,'POST',{...input,target:repaired.target})).status,409);writeFileSync(join(f.root,'pairing-asserted.json'),JSON.stringify({old:node.target,current:repaired.target,call,frames},null,2));
  }finally{release();await f.close();}
});

test('missing capability is a settled rejection and malformed Core tool calls need no manufactured Host intent',{skip:!binary||!nodeBinary,timeout:90000},async()=>{
  const f=await fixture((_input,index)=>index===1?{tools:[{id:'unsupported',name:'reach_execute',arguments:{command:{kind:'desktop.describe'}}},{id:'invalid',name:'reach_execute',arguments:{command:{kind:'file.read',path:null}}}]}:index===2?{text:'The original capability rejection is retained. '.repeat(24),hold:true}:{text:'Continue after a known rejection.'});
  try{const node=await f.node('A'),conversation=await f.conversation(),id=randomUUID(),path=`/api/v1/desk/conversations/${conversation}/messages`,reading=consume(await f.request(path,'POST',{id,content:'Check unavailable capability and invalid input.',target:node.target}));await until(()=>f.requests.length,n=>n===2);await f.request('/api/v1/desk/messages/'+id+'/cancel','POST',{});const frames=await reading;assert.equal(frames.at(-1).status,'cancelled');assert.equal(f.desk.store.conversation(f.session.user.id,conversation).blocked,0);assert.equal(f.reach.operations(f.session.user.id).length,0);
    const turn=f.desk.store.turn(f.session.user.id,id),calls=f.desk.store.deviceCalls(turn);assert.equal(calls.length,1);assert.equal(JSON.parse(calls[0].receipt_json!).reply.value.error,'capability_unavailable');const review=JSON.parse(readFileSync(join(f.config.stateDirectory,'tasks',turn.task_id,'effects-review.json'),'utf8'));assert.ok(review.effects.calls.some((c:any)=>c.effect==='core-schema-rejection-no-host-callback'));writeFileSync(join(f.root,'rejection-asserted.json'),JSON.stringify({calls,review},null,2));
  }finally{await f.close();}
});

test('Chrome switches only the next message target and restores real device receipts after refresh',{skip:!binary||!nodeBinary||!process.env.REACH_PLAYWRIGHT_ENTRY,timeout:120000},async()=>{
  const f=await fixture((_input,index)=>index===1||index===3?{tools:[{id:'switch-'+index,name:'reach_execute',arguments:{command:{kind:'command.run',command:`[IO.File]::AppendAllText('switch.txt','${index===1?'A':'B'}');Start-Sleep -Milliseconds 800;[Console]::WriteLine('device done')`,timeoutMs:10000}}}]}:{text:'Saved original device operation '+index});
  const {chromium}=await import(pathToFileURL(process.env.REACH_PLAYWRIGHT_ENTRY!).href);let context:any;
  try{const a=await f.node('A'),b=await f.node('B');context=await chromium.launchPersistentContext(join(f.root,'chrome'),{executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,viewport:{width:1380,height:1000}});const page=await context.newPage();page.setDefaultTimeout(15000);const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.goto(f.base+'/desk/');await page.getByLabel('用户名',{exact:true}).fill('device-test');await page.getByLabel('密码',{exact:true}).fill('local-device-test-password');await page.getByRole('button',{name:'进入 Reach Desk',exact:true}).click();await page.getByRole('heading',{name:'新对话',exact:true}).waitFor();await page.getByLabel('执行位置',{exact:true}).selectOption(a.target.nodeId+'@'+a.target.epoch);await page.getByLabel('设备工作目录',{exact:true}).fill(a.cwd);
    await page.getByRole('textbox',{name:'消息',exact:true}).fill('请在 A 执行');await page.getByRole('button',{name:'发送消息',exact:true}).click();await page.locator('.device-operation').filter({hasText:'设备执行中'}).waitFor();
    await page.getByLabel('执行位置',{exact:true}).selectOption(b.target.nodeId+'@'+b.target.epoch);await page.getByLabel('设备工作目录',{exact:true}).fill(b.cwd);await page.locator('.message-status').filter({hasText:'回答已保存'}).waitFor();assert.equal(readFileSync(join(a.cwd,'switch.txt'),'utf8'),'A');assert.equal(existsSync(join(b.cwd,'switch.txt')),false);
    await page.getByRole('textbox',{name:'消息',exact:true}).fill('现在在 B 执行');await page.getByRole('button',{name:'发送消息',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.message-status').length===2&&[...document.querySelectorAll('.message-status')].every(n=>n.textContent==='回答已保存'));
    assert.equal(readFileSync(join(a.cwd,'switch.txt'),'utf8'),'A');assert.equal(readFileSync(join(b.cwd,'switch.txt'),'utf8'),'B');assert.equal(f.reach.operations(f.session.user.id).length,2);await page.screenshot({path:join(f.root,'targets-desktop.png')});
    await page.reload();await page.locator('.device-operation').filter({hasText:'原操作成功'}).first().waitFor();assert.equal(await page.locator('.device-operation').count(),2);assert.equal(await page.getByLabel('设备工作目录',{exact:true}).inputValue(),b.cwd);assert.equal(await page.getByLabel('执行位置',{exact:true}).inputValue(),b.target.nodeId+'@'+b.target.epoch);assert.equal(await page.locator('.message-target').count(),2);
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(f.root,'targets-mobile.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('button',{name:'进入 Reach Desk',exact:true}).waitFor();assert.equal(await page.getByLabel('执行位置',{exact:true}).count(),0);assert.deepEqual(errors,[]);writeFileSync(join(f.root,'browser-asserted.json'),JSON.stringify({a:a.target,b:b.target,providerCalls:f.requests.length,operations:2,errors},null,2));
  }finally{await context?.close();await f.close();}
});
