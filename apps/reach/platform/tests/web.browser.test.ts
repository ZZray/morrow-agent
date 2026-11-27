// Copyright (c) Ray Zhang. Local-only browser, Reach HTTP and real shared Rust sidecar.
// 2026-11-24 起对话并入 Reach 控制台（#/desk），登录统一为控制台 PIN；旧 /desk/ 地址只做跳转。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';
import type {RequestListener} from 'node:http';
import {createServer as portServer} from 'node:net';
import {once} from 'node:events';
import {mkdirSync,writeFileSync,appendFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {ReachStore} from '../../src/service/store.ts';
import {reachServer} from '../../src/service/server.ts';
import {DeskHost} from '../src/host.ts';

const binary=process.env.REACH_DESK_SIDECAR,playwrightEntry=process.env.REACH_PLAYWRIGHT_ENTRY;
const prefix='本地测试的原始首段：这一段必须先到达浏览器，才允许上游模型返回结尾。';
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function availablePort(){const server=portServer();server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const port=address.port;await new Promise<void>(r=>server.close(()=>r()));return port;}
async function fixture(pin?:string){
  const root=resolve('work/desk-browser-'+randomUUID());mkdirSync(root,{recursive:true});
  const inputs=['src/admin/desk.ts','src/admin/desk-settlement.ts','src/admin/desk-images.ts','src/admin/desk.css','src/admin/admin.ts','dist/admin/desk.js','dist/admin/admin.js','platform/src/host.ts','platform/src/store.ts','src/service/server.ts','src/service/admin.ts','src/service/desk-extension.ts','src/admin/admin.ts','src/admin/index.html','src/admin/admin.css','dist/admin/admin.js','platform/tests/web.browser.test.ts',binary??process.execPath].map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}));
  writeFileSync(join(root,'started-inputs.json'),JSON.stringify({at:new Date().toISOString(),inputs},null,2));
  const requests:any[]=[],finished=new Set<number>(),releases=new Map<number,()=>void>();
  const provider=httpServer(async(request,response)=>{try{
    const chunks=[];for await(const chunk of request)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString());requests.push(input);const number=requests.length;
    appendFileSync(join(root,'provider-requests.jsonl'),JSON.stringify(input)+'\n');
    const waiting=input.messages.filter((m:any)=>m.role==='user'&&typeof m.content==='string'&&!m.content.startsWith('Fresh Host current-Run budget (')&&!m.content.startsWith('Host-derived working context;')).at(-1)?.content.startsWith('wait ');
    const note=(event:string)=>appendFileSync(join(root,'provider-lifecycle.jsonl'),JSON.stringify({number,event,waiting,finished:finished.has(number)})+'\n');note('started');response.once('close',()=>note('closed'));
    response.writeHead(200,{'content-type':'text/event-stream'});
    const chunk=(content:string|null,finish:string|null)=>response.write('data: '+JSON.stringify({id:'browser-'+number,model:'browser-fixture',choices:[{index:0,delta:content===null?{}:{role:'assistant',content},finish_reason:finish}]})+'\n\n');
    chunk(prefix,null);if(waiting){await once(response,'close');return;}
    let timer:ReturnType<typeof setTimeout>|undefined;
    await new Promise<void>((resolve,reject)=>{releases.set(number,()=>{note('browser_saw_delta');resolve();});timer=setTimeout(()=>reject(Error('Browser did not observe original delta')),12000);}).finally(()=>clearTimeout(timer));
    chunk(`\n尾段 ${number}：<script>window.__deskInjected=1</script>`,null);chunk(null,'stop');finished.add(number);note('finished');response.write('data: [DONE]\n\n');response.end();
  }catch{response.destroy();}});
  provider.listen(0,'127.0.0.1');await once(provider,'listening');const p=provider.address();assert.ok(p&&typeof p!=='string');
  const appPort=await availablePort(),base=`http://127.0.0.1:${appPort}`;
  const store=new ReachStore(join(root,'reach.sqlite'));store.bootstrap('browser-test','local-browser-fixture-password');
  const desk=new DeskHost({stateDirectory:join(root,'desk'),binary:binary??process.execPath,endpoint:`http://127.0.0.1:${p.port}/v1`,model:'browser-fixture',modelToken:'local-controlled-token',developmentLoopback:true,maxSeconds:25});
  const server=reachServer({store,desk,publicOrigin:base,allowInsecureLoopback:true,...(pin?{pinOnly:true,pin:{initial:pin},cookiePath:'/reach/'}:{})});
  if(pin){
    const listener=server.listeners('request')[0] as RequestListener;
    server.removeListener('request',listener);
    server.on('request',(request,response)=>{
      if(!request.url?.startsWith('/reach/')){response.writeHead(404);response.end();return;}
      request.url=request.url.slice('/reach'.length);
      listener.call(server,request,response);
    });
  }
  server.listen(appPort,'127.0.0.1');await once(server,'listening');
  return{root,base,requests,finished,release:(n:number)=>releases.get(n)?.(),desk,store,async close(){await server.shutdown();provider.close();provider.closeAllConnections();await once(provider,'close');}};
}
const DEFAULT_PIN='2026';
// 打开对话页并用控制台 PIN 登录；conversation 给出时直达原对话。
async function signIn(page:any,f:{base:string},conversation?:string){
  await page.goto(f.base+'/#/desk'+(conversation?'/'+conversation:''));
  await page.getByLabel('PIN',{exact:true}).fill(DEFAULT_PIN);await page.getByRole('button',{name:'进入',exact:true}).click();
  await page.locator('.desk').waitFor();
}
// 退出登录在控制台头像菜单里。
async function signOut(page:any){await page.locator('.top .avatar').click();await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByLabel('PIN',{exact:true}).waitFor();}
async function browserFor(f:Awaited<ReturnType<typeof fixture>>,options:Record<string,unknown>={}){
  let context:any;
  try{const{chromium}=await import(pathToFileURL(playwrightEntry!).href);context=await chromium.launchPersistentContext(join(f.root,'chrome-profile'),{executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,...options});context.setDefaultTimeout(10000);const page=await context.newPage();writeFileSync(join(f.root,'browser-runtime.json'),JSON.stringify({version:context.browser()?.version(),playwright:'1.64.1',localOnly:true}));return{context,page};}
  catch(error){await context?.close();await f.close();throw error;}
}

test('Chrome restores the Reach PIN session for a mounted Desk and returns there after expiry',{skip:!playwrightEntry,timeout:60000},async()=>{
  const pin='927418',f=await fixture(pin);
  const {context,page}=await browserFor(f,{viewport:{width:1280,height:900}});
  const at=f.base+'/reach/';
  const errors:string[]=[];
  page.on('pageerror',(error:Error)=>errors.push(error.message));
  const signIn=async()=>{
    await page.getByLabel('PIN',{exact:true}).fill(pin);
    await page.getByRole('button',{name:'进入',exact:true}).click();
  };
  try{
    await page.goto(at+'desk/');
    await page.waitForURL(at+'#/desk');
    assert.equal(await page.getByLabel('用户名',{exact:true}).count(),0);
    assert.equal(await page.evaluate(async()=>{
      const response=await fetch('api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'browser-test',password:'local-browser-fixture-password'})});
      return response.status;
    }),404);
    await signIn();
    await page.waitForURL(at+'#/desk');
    await page.getByRole('heading',{name:'新对话',exact:true}).waitFor();
    assert.ok((await context.cookies(at)).some((cookie:any)=>cookie.name==='reach_session'&&cookie.path==='/reach/'&&cookie.httpOnly));
    await page.screenshot({path:join(f.root,'desk-pin-authenticated.png')});

    // 同一会话里在控制台各页与对话页之间切换，不再登录。
    await page.getByRole('link',{name:'设备',exact:true}).click();
    await page.waitForURL(at+'#/devices');
    await page.getByRole('link',{name:'对话',exact:true}).click();
    await page.waitForURL(at+'#/desk');
    await page.getByRole('heading',{name:'新对话',exact:true}).waitFor();
    f.store.db.prepare('DELETE FROM sessions').run();
    await page.getByRole('button',{name:'刷新历史',exact:true}).click();
    await page.getByLabel('PIN',{exact:true}).waitFor();
    await signIn();
    await page.locator('.desk').waitFor();
    assert.ok(page.url().startsWith(at+'#/desk'),'登录过期后重新登录仍回到对话页');
    await signOut(page);
    assert.equal(f.requests.length,0);
    assert.deepEqual(errors,[]);
  }finally{await context.close();await f.close();console.log(JSON.stringify({deskPinBrowserEvidence:f.root}));}
});

test('local Chrome verifies Desk submit locking, real deltas, native history, stop, narrow layout and logout',{skip:!binary||!playwrightEntry,timeout:120000},async()=>{
  const f=await fixture();const {context,page}=await browserFor(f,{viewport:{width:1440,height:1000},locale:'zh-CN',colorScheme:'dark',reducedMotion:'reduce'});
  const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));
  let releaseCreate:()=>void=()=>{};
  try{
    await signIn(page,f);
    await page.getByRole('heading',{name:'新对话',exact:true}).waitFor();await page.screenshot({path:join(f.root,'empty-desktop.png')});
    let createCount=0,createStarted!:()=>void;const started=new Promise<void>(r=>createStarted=r),held=new Promise<void>(r=>releaseCreate=r);
    await page.route('**/api/v1/desk/conversations',async(route:any)=>{if(route.request().method()==='POST'){createCount++;createStarted();await held;}await route.continue();});
    await page.getByRole('textbox',{name:'消息',exact:true}).fill('浏览器首轮');await page.getByRole('button',{name:'发送消息',exact:true}).click();await started;
    await page.getByRole('textbox',{name:'消息',exact:true}).fill('后来输入的草稿');assert.equal(await page.getByRole('button',{name:'发送消息',exact:true}).isDisabled(),true);await page.getByRole('textbox',{name:'消息',exact:true}).press('Enter');await pause(100);assert.equal(createCount,1);releaseCreate();
    await page.locator('.message.assistant .body').filter({hasText:prefix}).waitFor();assert.equal(f.finished.has(1),false);assert.equal(await page.getByRole('textbox',{name:'消息',exact:true}).inputValue(),'后来输入的草稿');f.release(1);
    await page.locator('.message-status').filter({hasText:'回答已保存'}).waitFor();assert.equal(f.requests.length,1);assert.equal(await page.evaluate(()=>Boolean((window as any).__deskInjected)),false);assert.ok((await page.locator('.message.assistant .body').innerText()).includes('<script>'));
    await page.screenshot({path:join(f.root,'reply-desktop.png')});
    await page.getByRole('button',{name:'＋  新对话',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'消息',exact:true}).inputValue(),'');await page.getByRole('button',{name:'浏览器首轮',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'消息',exact:true}).inputValue(),'后来输入的草稿');
    await page.getByRole('textbox',{name:'消息',exact:true}).fill('浏览器第二轮');await page.getByRole('button',{name:'发送消息',exact:true}).click();
    await page.locator('.message.assistant .body').nth(1).filter({hasText:prefix}).waitFor();assert.equal(f.finished.has(2),false);f.release(2);
    await page.waitForFunction(()=>document.querySelectorAll('.message-status').length===2&&[...document.querySelectorAll('.message-status')].every(n=>n.textContent==='回答已保存'));
    assert.equal(f.requests.length,2);assert.ok(JSON.stringify(f.requests[1].messages).includes('浏览器首轮'));
    await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.message.assistant').length===2&&[...document.querySelectorAll('.message-status')].every(n=>n.textContent==='回答已保存'));assert.equal(f.requests.length,2);
    await page.getByRole('button',{name:'＋  新对话',exact:true}).click();await page.getByRole('textbox',{name:'消息',exact:true}).fill('wait 浏览器停止');await page.getByRole('button',{name:'发送消息',exact:true}).click();
    await page.locator('.message.assistant .body').filter({hasText:prefix}).waitFor();await page.getByRole('button',{name:'停止回答',exact:true}).click();await page.locator('.message-status').filter({hasText:'已停止'}).waitFor();assert.equal(f.finished.has(3),false);
    await page.waitForFunction(()=>!document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息"]')!.disabled);
    await page.reload();await page.locator('.message.assistant .body').filter({hasText:prefix}).waitFor();await page.locator('.message-status').filter({hasText:'已停止'}).waitFor();assert.equal(f.requests.length,3);
    await page.getByRole('textbox',{name:'消息',exact:true}).fill('停止后继续原会话');await page.getByRole('button',{name:'发送消息',exact:true}).click();
    await page.locator('.message.assistant .body').nth(1).filter({hasText:prefix}).waitFor();assert.equal(f.requests.length,4);assert.ok(JSON.stringify(f.requests[3].messages).includes('wait 浏览器停止'));f.release(4);
    await page.locator('.message-status').filter({hasText:'回答已保存'}).waitFor();
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(f.root,'stopped-mobile.png')});
    const geometry=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}));assert.ok(geometry.width<=geometry.viewport,JSON.stringify(geometry));assert.equal(await page.locator('.top .avatar').isVisible(),true);
    await signOut(page);assert.equal(await page.locator('.message').count(),0);assert.equal(errors.length,0,JSON.stringify(errors));
    writeFileSync(join(f.root,'verified.json'),JSON.stringify({createCount,providerCalls:f.requests.length,realNativeSidecar:true,browserSawDeltaBeforeFinish:true,typedDraftPreserved:true,reloadedHistory:true,cancelledPartialRestored:true,scriptNotExecuted:true,geometry,errors},null,2));
  }finally{releaseCreate();await context.close();await f.close();console.log(JSON.stringify({deskBrowserEvidence:f.root}));}
});

test('Chrome keeps valid login after history failure and follows a live original message after stream loss',{skip:!binary||!playwrightEntry,timeout:90000},async()=>{
  const f=await fixture();const {context,page}=await browserFor(f,{viewport:{width:1280,height:900}});let originalReader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
    let failHistory=true;
    await page.route('**/api/v1/desk/conversations',async(route:any)=>{if(failHistory&&route.request().method()==='GET'){failHistory=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'本地历史读取故障'}})});}else await route.continue();});
    await signIn(page,f);
    await page.getByRole('alert').filter({hasText:'本地历史读取故障'}).waitFor();assert.equal(await page.getByLabel('PIN',{exact:true}).count(),0);await page.getByRole('button',{name:'刷新历史',exact:true}).click();await page.getByRole('heading',{name:'新对话',exact:true}).waitFor();
    failHistory=true;await page.reload();await page.getByRole('alert').filter({hasText:'本地历史读取故障'}).waitFor();assert.equal(await page.getByLabel('PIN',{exact:true}).count(),0);await page.getByRole('button',{name:'刷新历史',exact:true}).click();
    let submitted=0,observed=0;
    page.on('request',(request:any)=>{if(request.method()==='GET'&&request.url().includes('/messages/')&&request.url().endsWith('/events'))observed++;});
    await page.route('**/api/v1/desk/conversations/*/messages',async(route:any)=>{
      submitted++;const request=route.request();const response=await fetch(request.url(),{method:'POST',headers:await request.allHeaders(),body:request.postData()});assert.equal(response.status,200);originalReader=response.body!.getReader();let partial='';const decoder=new TextDecoder();
      while(!partial.includes('event: delta')){const value=await originalReader.read();assert.equal(value.done,false);partial+=decoder.decode(value.value,{stream:true});}
      // Keep the original owner socket alive to make the immediate read observe running.
      await route.fulfill({status:200,contentType:'text/event-stream',body:partial});
    });
    await page.getByRole('textbox',{name:'消息',exact:true}).fill('浏览器断流恢复');await page.getByRole('button',{name:'发送消息',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.message.assistant .body')?.textContent?.startsWith('本地测试的原始首段'));
    for(let i=0;i<100&&observed===0;i++)await pause(50);assert.equal(observed,1,'live result must reconnect by GET, without a new POST');assert.equal(submitted,1);assert.equal(f.requests.length,1);assert.equal(f.finished.has(1),false);
    f.release(1);const drain=(async()=>{while(!(await originalReader!.read()).done){};})();await page.locator('.message-status').filter({hasText:'回答已保存'}).waitFor();await drain;
    assert.equal(submitted,1);assert.equal(f.requests.length,1);assert.equal(await page.locator('.message.assistant .body').innerText(),prefix+'\n尾段 1：<script>window.__deskInjected=1</script>');
    writeFileSync(join(f.root,'fault-verified.json'),JSON.stringify({historyFailureKeepsLogin:true,restoredLoginKeepsShell:true,originalSubmissions:submitted,getObservers:observed,providerCalls:f.requests.length,recovered:true}));
  }finally{try{await originalReader?.cancel();}catch{}await context.close();await f.close();console.log(JSON.stringify({deskBrowserFaultEvidence:f.root}));}
});

test('Chrome rejects a delayed running snapshot after a newer original receipt completed',{skip:!binary||!playwrightEntry,timeout:60000},async()=>{
  const f=await fixture();const {context,page}=await browserFor(f);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,releaseOld:()=>void=()=>{};
  try{
    await signIn(page,f);await page.getByRole('heading',{name:'新对话',exact:true}).waitFor();
    let queryCount=0,submitted=0,snapshot:any,oldStarted!:()=>void;const oldReady=new Promise<void>(r=>oldStarted=r),holdOld=new Promise<void>(r=>releaseOld=r);
    await page.route('**/api/v1/desk/messages/*',async(route:any)=>{if(route.request().method()!=='GET'){await route.continue();return;}queryCount++;if(queryCount!==1){await route.continue();return;}const response=await route.fetch();snapshot=await response.json();oldStarted();await holdOld;await route.fulfill({response,body:JSON.stringify(snapshot)});});
    await page.route('**/api/v1/desk/conversations/*/messages',async(route:any)=>{submitted++;const request=route.request(),response=await fetch(request.url(),{method:'POST',headers:await request.allHeaders(),body:request.postData()});reader=response.body!.getReader();let partial='';const decoder=new TextDecoder();while(!partial.includes('event: delta')){const value=await reader.read();assert.equal(value.done,false);partial+=decoder.decode(value.value,{stream:true});}await route.fulfill({status:200,contentType:'text/event-stream',body:partial});});
    await page.getByRole('textbox',{name:'消息',exact:true}).fill('浏览器旧查询交叉');await page.getByRole('button',{name:'发送消息',exact:true}).click();await oldReady;assert.equal(snapshot.status,'running');
    f.release(1);while(!(await reader!.read()).done){};
    await page.getByRole('button',{name:'查询原记录',exact:true}).click();await page.locator('.message-status').filter({hasText:'回答已保存'}).waitFor();const finalText=await page.locator('.message.assistant .body').innerText();
    releaseOld();await pause(250);assert.equal(await page.locator('.message-status').innerText(),'回答已保存');assert.equal(await page.locator('.message.assistant .body').innerText(),finalText);assert.equal(submitted,1);assert.equal(f.requests.length,1);
    writeFileSync(join(f.root,'stale-query-verified.json'),JSON.stringify({oldStatus:snapshot.status,finalStatus:'completed',queryCount,submitted,providerCalls:f.requests.length,staleReplyIgnored:true}));
  }finally{releaseOld();try{await reader?.cancel();}catch{}await context.close();await f.close();console.log(JSON.stringify({deskBrowserStaleEvidence:f.root}));}
});

test('enabled management entry opens Reach Desk with the existing browser login',{skip:!binary||!playwrightEntry,timeout:30000},async()=>{
  const f=await fixture();const {context,page}=await browserFor(f);
  try{
    await page.goto(f.base+'/');await page.getByLabel('PIN',{exact:true}).fill(DEFAULT_PIN);await page.getByRole('button',{name:'进入',exact:true}).click();
    await page.getByRole('link',{name:'对话',exact:true}).click();await page.getByRole('heading',{name:'新对话',exact:true}).waitFor();assert.equal(await page.getByLabel('PIN',{exact:true}).count(),0);
    await page.getByRole('link',{name:'设备',exact:true}).click();await page.waitForURL(f.base+'/#/devices');assert.equal(await page.locator('.desk').count(),0);assert.equal(await page.getByLabel('PIN',{exact:true}).count(),0);assert.equal(f.requests.length,0);
    writeFileSync(join(f.root,'entry-verified.json'),JSON.stringify({managementToDesk:true,deskToManagement:true,sameLogin:true,providerCalls:0}));
  }finally{await context.close();await f.close();console.log(JSON.stringify({deskEntryEvidence:f.root}));}
});

test('old terminal event replay cannot unlock a currently blocked conversation',{skip:!binary||!playwrightEntry,timeout:30000},async()=>{
  const f=await fixture();const {context,page}=await browserFor(f);let releaseOld:()=>void=()=>{};
  try{
    const user=(f.store.db.prepare('SELECT id FROM users LIMIT 1').get() as {id:string}).id,conversation=randomUUID(),first=randomUUID(),second=randomUUID();
    f.desk.store.create(user,conversation,'历史终态交叉',f.desk.routeHash);f.desk.store.admit(user,conversation,first,'旧消息','fixture-session',f.desk.routeHash);f.desk.store.finish(first,'cancelled','','cancelled_before_start',null,false);f.desk.store.admit(user,conversation,second,'新消息','fixture-session',f.desk.routeHash);f.desk.store.finish(second,'unknown','','fixture_unknown',null,true);
    let oldStarted!:()=>void;const held=new Promise<void>(r=>releaseOld=r),started=new Promise<void>(r=>oldStarted=r);
    await page.route('**/api/v1/desk/messages/'+first+'/events',async(route:any)=>{const response=await route.fetch();oldStarted();await held;await route.fulfill({response});});
    await signIn(page,f,conversation);await started;
    await page.locator('.message-status').filter({hasText:'结果尚未确定'}).waitFor();assert.equal(await page.getByRole('textbox',{name:'消息',exact:true}).isDisabled(),true);releaseOld();await page.locator('.message-status').filter({hasText:'已停止'}).waitFor();assert.equal(await page.getByRole('textbox',{name:'消息',exact:true}).isDisabled(),true);assert.equal(f.requests.length,0);
    writeFileSync(join(f.root,'blocked-replay-verified.json'),JSON.stringify({oldReceiptBlocked:false,currentConversationBlocked:true,inputRemainedDisabled:true,providerCalls:0,scope:'seeded receipt ordering fixture, not native execution proof'}));
  }finally{releaseOld();await context.close();await f.close();console.log(JSON.stringify({deskBlockedReplayEvidence:f.root}));}
});

test('Chrome ignores an older blocked terminal after a versioned release',{skip:!binary||!playwrightEntry,timeout:30000},async()=>{
  const f=await fixture();const {context,page}=await browserFor(f);let releaseOld=()=>{};
  try{
    const user=(f.store.db.prepare('SELECT id FROM users LIMIT 1').get() as {id:string}).id,conversation=randomUUID(),id=randomUUID();
    f.desk.store.create(user,conversation,'已核对的会话',f.desk.routeHash);f.desk.store.admit(user,conversation,id,'旧消息','fixture-session',f.desk.routeHash);f.desk.store.cancel(user,id,'fixture_cancel');
    const token=f.desk.store.beginSettlement(id,{declarationPath:join(f.root,'fixture-declaration.json'),declarationSha256:'a'.repeat(64),binaryPath:binary!,binarySha256:'b'.repeat(64)},{output:'',reason:'Cancelled',result:{scope:'store/browser fixture only'}});
    const blocked=f.desk.store.conversation(user,conversation);f.desk.store.claimSettlement(id,token,2);assert.equal(f.desk.store.completeSettlement(id,token,{scope:'store/browser fixture only'}),true);
    let oldStarted!:()=>void;const held=new Promise<void>(r=>releaseOld=r),started=new Promise<void>(r=>oldStarted=r);
    await page.route('**/api/v1/desk/messages/'+id+'/events',async(route:any)=>{oldStarted();await held;await route.fulfill({status:200,contentType:'text/event-stream',body:'id: 1\nevent: settled\ndata: '+JSON.stringify({status:'cancelled',output:'旧停止事件',reason:'Cancelled',sessionBlocked:true,conversation:blocked,taskAccepted:false})+'\n\n'});});
    await signIn(page,f,conversation);await started;
    const input=page.getByRole('textbox',{name:'消息',exact:true});assert.equal(await input.isEnabled(),true);await input.fill('释放后的草稿');releaseOld();await page.locator('.message.assistant .body').filter({hasText:'旧停止事件'}).waitFor();assert.equal(await input.isEnabled(),true);assert.equal(await input.inputValue(),'释放后的草稿');assert.equal(f.requests.length,0);
    writeFileSync(join(f.root,'released-replay-verified.json'),JSON.stringify({oldVersion:blocked.settlement_revision,releasedVersion:f.desk.store.conversation(user,conversation).settlement_revision,enabledAfterOldTrue:true,draftPreserved:true,providerCalls:0,scope:'seeded Store/browser ordering, no Core settlement'}));
  }finally{releaseOld();await context.close();await f.close();console.log(JSON.stringify({deskReleasedReplayEvidence:f.root}));}
});

test('Chrome disables on same-version conflict and clears the reused state after fresh GET confirmation',{skip:!binary||!playwrightEntry,timeout:30000},async()=>{
  const f=await fixture();const {context,page}=await browserFor(f);let releaseEvent=()=>{},releaseGet=()=>{};
  try{
    const user=(f.store.db.prepare('SELECT id FROM users LIMIT 1').get() as {id:string}).id,conversation=randomUUID(),id=randomUUID();
    f.desk.store.create(user,conversation,'冲突后继续',f.desk.routeHash);f.desk.store.admit(user,conversation,id,'旧消息','fixture-session',f.desk.routeHash);f.desk.store.finish(id,'cancelled','','cancelled_before_start',null,false);
    let eventStarted!:()=>void,getStarted!:()=>void;const eventGate=new Promise<void>(r=>releaseEvent=r),getGate=new Promise<void>(r=>releaseGet=r),started=new Promise<void>(r=>eventStarted=r),checking=new Promise<void>(r=>getStarted=r);let reads=0;
    await page.route('**/api/v1/desk/conversations/'+conversation,async(route:any)=>{reads++;if(reads>1){getStarted();await getGate;}await route.continue();});
    await page.route('**/api/v1/desk/messages/'+id+'/events',async(route:any)=>{eventStarted();await eventGate;await route.fulfill({status:200,contentType:'text/event-stream',body:'id: 1\nevent: settled\ndata: '+JSON.stringify({status:'cancelled',output:'同版本矛盾事件',reason:'Cancelled',sessionBlocked:true,conversation:{blocked:1,blocker_task_id:'conflicting-task',settlement_revision:0,declaration_sha:null},taskAccepted:false})+'\n\n'});});
    await signIn(page,f,conversation);await started;
    const input=page.getByRole('textbox',{name:'消息',exact:true});await input.fill('核对期间保留草稿');releaseEvent();await checking;assert.equal(await input.isDisabled(),true);await page.getByText('正在核对会话状态，原记录和草稿已保留。',{exact:true}).waitFor();releaseGet();await page.waitForFunction(()=>!document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息"]')!.disabled);
    assert.equal(await input.inputValue(),'核对期间保留草稿');assert.equal(await page.getByRole('button',{name:'发送消息',exact:true}).isEnabled(),true);assert.equal(f.requests.length,0);await page.screenshot({path:join(f.root,'conflict-recovered.png')});
    writeFileSync(join(f.root,'conflict-verified.json'),JSON.stringify({sameVersionConflict:true,disabledUntilFreshRead:true,reusedObjectCleared:true,draftPreserved:true,reads,providerCalls:0,scope:'controlled conflicting SSE, no Core settlement'}));
  }finally{releaseEvent();releaseGet();await context.close();await f.close();console.log(JSON.stringify({deskConflictEvidence:f.root}));}
});

test('Chrome distinguishes a known target rejection and preserves both the original message and later draft',{skip:!binary||!playwrightEntry,timeout:45000},async()=>{
  const f=await fixture();const {context,page}=await browserFor(f);let release=()=>{};
  try{const user=(f.store.db.prepare('SELECT id FROM users LIMIT 1').get() as {id:string}).id,secret='d'.repeat(43),paired=f.store.pair({attemptId:randomUUID(),installationId:randomUUID(),installationSecret:secret,code:f.store.createPairing(user).code,name:'拒绝夹具设备',platform:'windows',version:'fixture-only'});f.store.hello(f.store.node(secret),'fixture-only',['command.run']);let reads=0;page.on('request',(r:any)=>{if(r.method()==='GET'&&r.url().includes('/desk/messages/'))reads++;});
    await signIn(page,f);await page.getByRole('combobox',{name:'执行位置',exact:true}).click();await page.getByRole('option',{name:/拒绝夹具设备/}).click();await page.getByLabel('设备工作目录',{exact:true}).fill('not an absolute path');
    const input=page.getByRole('textbox',{name:'消息',exact:true});await input.fill('保留这条未提交的消息');await page.getByRole('button',{name:'发送消息',exact:true}).click();await page.locator('.message-status').filter({hasText:'本次提交未被接受'}).waitFor();assert.equal(await input.inputValue(),'保留这条未提交的消息');assert.equal(reads,0);assert.equal(f.requests.length,0);assert.equal((f.desk.store.db.prepare('SELECT COUNT(*) AS n FROM turns').get() as any).n,0);
    let started!:()=>void;const ready=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);await page.route('**/api/v1/desk/conversations/*/messages',async(route:any)=>{const response=await route.fetch();assert.equal(response.status(),400);started();await gate;await route.fulfill({response});});
    await page.getByRole('button',{name:'发送消息',exact:true}).click();await ready;await input.fill('等待拒绝期间输入的新草稿');release();await page.waitForFunction(()=>[...document.querySelectorAll('.message-status')].filter(n=>n.textContent?.includes('本次提交未被接受')).length===2);assert.equal(await input.inputValue(),'等待拒绝期间输入的新草稿');assert.equal(reads,0);assert.equal(f.requests.length,0);assert.equal(await page.getByRole('button',{name:'查询原记录',exact:true}).count(),0);writeFileSync(join(f.root,'rejected-verified.json'),JSON.stringify({knownRejection:true,originalMessageRestored:true,laterDraftPreserved:true,originalQueries:reads,providerCalls:f.requests.length,scope:'real HTTP validation with seeded pairing, no device process'}));
  }finally{release();await context.close();await f.close();console.log(JSON.stringify({deskRejectionEvidence:f.root}));}
});
