'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
const code=fs.readFileSync(__dirname+'/handwave_memory_transport.js','utf8');
function fixture() {
 const calls=[],sent=[];let nextID=0;
 const c={curWS:{id:'wa',device_fp:'A'},curSess:{id:'sa'},paired:true,helloDone:true,localRunID:'r1',
  api:async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});return path==='/agent-context'?{brief:'cloud',workspace_id:'wa',device_fp:'A',memory_receipt:{}}:{};},
  onFrame:()=>{},onSig:()=>{},sendSig:()=>true,sendFrame:f=>{sent.push(f);return true;},newToolId:()=>`follow-${++nextID}`,addBubble:()=>{}};
 vm.createContext(c);vm.runInContext(code,c);c.onFrame({k:'node-hello',fp:'A',info:{caps:['cloud-memory-v1']}});
 return {c,calls,sent,request:()=>c.api('/agent-context',{method:'POST',body:JSON.stringify({workspace_id:c.curWS.id})}),send:()=>c.sendFrame({k:'agent-loop',id:c.localRunID})};
}

// Exercise the real upstream persistence/event functions, rather than a mirror
// of their behavior. Only DOM rendering, network and the native hello UI are
// stubbed. A selector change must never redirect late assistant persistence.
const upstreamBytes=fs.readFileSync(process.env.RAY_DEPLOYED_APP_FIXTURE||__dirname+'/testdata/handwave-app-7ae318fe.js');
assert.equal(crypto.createHash('sha256').update(upstreamBytes).digest('hex'),'7ae318fe13a6fd35cd652c3fed7ee51134ca7808d14aab8f1be0c18aa44a15b2','reviewed upstream fixture changed');
const upstream=upstreamBytes.toString('utf8');
function upstreamPart(start,end) {
 const from=upstream.indexOf(start),to=upstream.indexOf(end,from);
 assert(from>=0&&to>from,`upstream fixture anchors changed: ${start}`);
 return upstream.slice(from,to);
}
function eventFixture(sessions=true) {
 const calls=[],sent=[];let nextID=0,finalized=0,stopped=0;
 const c={curWS:{id:'wa',device_fp:'A'},curSess:{id:'sa'},localRunID:'r1',paired:true,helloDone:true,
  localBusy:false,localAnswer:'',localPhase:'',pendingLocalRetry:'',pendingAsk:null,localStream:null,sending:false,
  agentRun:{agents:new Map(),events:[]},localTasks:new Map(),toolSess:new Map(),TERMINAL_TASK:{done:1,failed:1,canceled:1},
  api:async(path,options)=>{calls.push({path,body:options&&options.body?JSON.parse(options.body):null});return {brief:'legacy data',workspace_id:c.curWS.id,device_fp:'A',memory_receipt:{}};},
  setSendUI(){},stopLocalTick(){stopped++;},updateTaskDurations(){},renderAgentDock(){},
  beginAssistant:()=>({append(){},finalize(){finalized++;}}),
  onSig(){},sendSig:()=>true,sendFrame:f=>{sent.push(f);return true;},newToolId:()=>`follow-${++nextID}`,addBubble(){},console};
 vm.createContext(c);
 vm.runInContext([
  upstreamPart('function noteSession(', 'const TERMINAL_TASK'),
  upstreamPart('function onLocalAgentEvent(', 'function formatTaskDur('),
  upstreamPart('function finishLocalRun(', 'async function startLocalRun('),
  upstreamPart('function agentIdentity(', 'function completeCoordinator('),
  upstreamPart('function onFrame(', 'function renderDevices('),
  `const nativeOnFrame=onFrame;onFrame=function(frame){if(frame.k!=='node-hello')return nativeOnFrame(frame);};`,
 ].join('\n'),c);
 vm.runInContext(code,c);
 c.onFrame({k:'node-hello',fp:'A',info:{caps:['cloud-memory-v1',...(sessions?['session-v1']:[])]}});
 const start=async(id='r1')=>{
  c.localRunID=id;c.localBusy=true;c.sending=true;c.localAnswer='';c.localStream=c.beginAssistant();
  await c.api('/agent-context',{body:JSON.stringify({workspace_id:c.curWS.id})});
  assert(c.sendFrame({k:'agent-loop',id}));
 };
 const event=(id,type,output='')=>c.onFrame({k:'agent-event',id,event:{type,output,status:'completed'}});
 const posts=()=>calls.filter(x=>/\/messages$/.test(x.path));
 return {c,calls,sent,start,event,posts,finalized:()=>finalized,stopped:()=>stopped};
}

async function incomingPersistenceChecks() {
 let f=eventFixture();await f.start();f.c.curSess={id:'sb'};
 f.event('r1','text_delta','ANSWER_FROM_A');f.event('r1','text','ANSWER_FROM_A');f.event('r1','agent_end');
 f.c.onFrame({k:'out',id:'r1',done:true});
 assert.deepEqual(f.posts(),[]);assert.equal(f.c.localBusy,false);assert.equal(f.finalized(),0);
 assert.equal(f.c.localStream,null);assert.equal(f.c.localAnswer,'');

 f=eventFixture();await f.start();f.event('r1','text_delta','PARTIAL_A');f.c.curSess={id:'sb'};
 f.c.onFrame({k:'out',id:'r1',done:true,err:'A failed'});
 assert.deepEqual(f.posts(),[]);assert.equal(f.c.localBusy,false);assert.equal(f.finalized(),0);

 f=eventFixture();await f.start();f.c.curSess={id:'sb'};await f.start('r2');
 f.c.localAnswer='LIVE_B';const streamB=f.c.localStream;
 f.event('r1','text_delta','STALE_A');f.event('r1','agent_end');f.c.onFrame({k:'out',id:'r1',done:true});
 assert.equal(f.c.localBusy,true);assert.equal(f.c.localRunID,'r2');assert.equal(f.c.localAnswer,'LIVE_B');
 assert.equal(f.c.localStream,streamB);assert.equal(f.stopped(),0);assert.deepEqual(f.posts(),[]);
 f.event('r2','text_delta','_TAIL');f.event('r2','agent_end');
 assert.equal(f.posts().length,1);assert.equal(f.posts()[0].path,'/workspaces/wa/sessions/sb/messages');
 assert.equal(f.posts()[0].body.content,'LIVE_B_TAIL');

 f=eventFixture();await f.start();assert(f.c.sendFrame({k:'agent-follow',msg:'next'}));
 const followID=f.sent.at(-1).id;assert.equal(typeof followID,'string');assert(followID);
 f.c.curSess={id:'sb'};f.event(followID,'text_delta','FOLLOW_A');f.event(followID,'agent_end');
 f.c.onFrame({k:'out',id:followID,done:true});assert.deepEqual(f.posts(),[]);

 f=eventFixture();await f.start();assert(f.c.sendFrame({k:'agent-loop',id:'queued-a',msg:'queued'}));
 f.c.curSess={id:'sb'};f.event('queued-a','text_delta','QUEUED_A');f.event('queued-a','agent_end');
 assert.deepEqual(f.posts(),[]);

 // Legacy peers keep their original wire shape and same-owner persistence.
 f=eventFixture(false);await f.start();assert.equal(f.sent[0].session_key,undefined);
 f.event('r1','text_delta','LEGACY_OK');f.event('r1','agent_end');
 assert.equal(f.posts().length,1);assert.equal(f.posts()[0].path,'/workspaces/wa/sessions/sa/messages');
 assert.equal(f.posts()[0].body.content,'LEGACY_OK');
 console.log('PASS: actual upstream event/persistence chain rejects cross-session delta/end/out, preserves new run, binds follow/queue, and keeps legacy flow');
}
(async()=>{
 let f=fixture();await f.request();assert(f.send());assert.equal(f.calls[0].body.device_fp,'A');assert.equal(f.calls[0].body.cloud_memory_v1,true);
 assert.equal(f.sent[0].session_key,undefined); // Legacy peers keep the original native path.
 f=fixture();f.c.onFrame({k:'node-hello',fp:'A',info:{caps:['cloud-memory-v1','session-v1']}});await f.request();assert(f.send());assert.equal(f.sent[0].session_key,'wa/sa');
 assert(f.c.sendFrame({k:'agent-loop',id:'queued',msg:'follow'}));assert.equal(f.sent[1].session_key,'wa/sa');
 assert(f.c.sendFrame({k:'agent-follow',msg:'follow'}));assert.equal(f.sent[2].session_key,'wa/sa');
 f.c.curSess={id:'sb'};
 for(const k of ['agent-loop','agent-follow','agent-steer','agent-abort','agent-ui']) assert.equal(f.c.sendFrame({k,id:'other'}),false);
 assert.equal(f.sent.length,3);
 await f.request();assert(f.send());assert.equal(f.sent[3].session_key,'wa/sb');
 f=fixture();f.c.onFrame({k:'node-hello',fp:'A',info:{caps:['session-v1']}});f.c.curSess.id='../bad';await assert.rejects(f.request());assert.equal(f.send(),false);
 f=fixture();f.c.onFrame({k:'node-hello',fp:'A',info:{caps:['session-v1']}});await f.request();f.c.curSess.id='sb';assert.equal(f.send(),false);
 f=fixture();f.c.curWS.device_fp='B';await assert.rejects(f.request());assert.equal(f.send(),false);assert.equal(f.sent.length,0);
 f=fixture();f.c.curWS.device_fp='';await f.request();assert.equal(f.calls[0].path,'/workspaces/wa');assert(f.send());
 f=fixture();let release;f.c.api; // Capture a pending native API before wrapping in a second fixture.
 const stale={curWS:{id:'wa',device_fp:'A'},curSess:{id:'sa'},paired:true,helloDone:true,localRunID:'r',
 api:()=>new Promise(r=>release=r),onFrame:()=>{},onSig:()=>{},sendSig:()=>true,sendFrame:()=>{throw Error('must not send')},addBubble:()=>{}};
 vm.createContext(stale);vm.runInContext(code,stale);stale.onFrame({k:'node-hello',fp:'A',info:{caps:['cloud-memory-v1']}});
 let pending=stale.api('/agent-context',{body:JSON.stringify({workspace_id:'wa'})});stale.onFrame({k:'node-hello',fp:'B',info:{caps:[]}});release({brief:'A secret'});await assert.rejects(pending);assert.equal(stale.sendFrame({k:'agent-loop',id:'r'}),false);
 const denied={...stale,curWS:{id:'wa',device_fp:'A'},curSess:{id:'sa'},api:async()=>{throw Error('409')},onFrame:()=>{},onSig:()=>{},sendSig:()=>true,sendFrame:()=>{throw Error('must not send')},addBubble:()=>{}};
 vm.createContext(denied);vm.runInContext(code,denied);denied.onFrame({k:'node-hello',fp:'A',info:{caps:['cloud-memory-v1']}});await assert.rejects(denied.api('/agent-context',{body:JSON.stringify({workspace_id:'wa'})}));assert.equal(denied.sendFrame({k:'agent-loop',id:'r'}),false);
 console.log('PASS: controller snapshot request, bound device, empty workspace bind, late peer, and failure dispatch gates');
 await incomingPersistenceChecks();
})().catch(e=>{console.error(e);process.exitCode=1});
