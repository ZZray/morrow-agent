// Copyright (c) Ray Zhang. Ordinary Node + fixed JSONL sidecar + local controlled provider.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {ServerResponse} from 'node:http';
import {once} from 'node:events';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fixture,until,kill} from './native-fixture.ts';
const sidecar=process.env.REACH_DESK_SIDECAR,legacy=process.env.REACH_LEGACY_NODE_BINARY;
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const frame=(delta:unknown,finish:string|null=null)=>'data: '+JSON.stringify({id:'guidance-local',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n';
const answer=()=>frame({content:'Original sourced tool receipt verified; Task awaits caller review.'})+frame({},'stop')+'data: [DONE]\n\n';
const tool=(command:unknown)=>frame({tool_calls:[{index:0,id:'skill-write-once',type:'function',function:{name:'reach_execute',arguments:JSON.stringify({command})}}]})+frame({},'tool_calls')+'data: [DONE]\n\n';
const requirements={protocolVersion:1,toolContractVersion:1,platforms:['windows'],capabilities:['file.write']};
function source(text:string,extra:Record<string,unknown>={}){return{id:'original-skill',kind:'skill',source:'fixture://reach-guidance/SKILL.md',revision:'local-exact-v1',text,sha256:sha(text),...extra};}
function guidance(body:any){
  const text=body.messages.flatMap((m:any)=>typeof m.content==='string'?[m.content]:(m.content??[]).filter((v:any)=>v.type==='text').map((v:any)=>v.text)).join('\n');
  for(const line of text.split('\n')){try{const value=JSON.parse(line);if(value.environment&&value.sources)return value;}catch{}}
  assert.fail('Original Task guidance absent from actual model request');
}
async function setup(handler:(body:any,n:number,res:ServerResponse)=>void,start=true){
  assert.ok(sidecar);const root=resolve('work/agent-guidance-native-'+randomUUID());mkdirSync(root,{recursive:true});
  const token=randomBytes(32).toString('base64url'),requests:any[]=[];let fault:unknown;
  const provider=createServer(async(req,res)=>{try{assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer '+token);const chunks:Buffer[]=[];for await(const b of req)chunks.push(Buffer.from(b));const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);writeFileSync(join(root,'provider-requests.json'),JSON.stringify(requests,null,2));res.writeHead(200,{'content-type':'text/event-stream',connection:'close'});handler(body,requests.length,res);}catch(error){fault=error;res.destroy();}});
  provider.listen(0,'127.0.0.1');await once(provider,'listening');const a=provider.address();assert.ok(a&&typeof a!=='string');
  const config=join(root,'agent-runtime.json');writeFileSync(config,JSON.stringify({sidecar,sha256:sha(readFileSync(sidecar)),inspectionLeaseVersion:1}));
  const nodeEnv:NodeJS.ProcessEnv={...process.env,REACH_AGENT_CONFIG:config};delete nodeEnv.REACH_DESKTOP_CONFIG;
  const f=await fixture('',nodeEnv,root,{...process.env,REACH_AGENT_MODEL_URL:`http://127.0.0.1:${a.port}/v1`,REACH_AGENT_MODEL_ID:'guidance-local',REACH_AGENT_MODEL_TOKEN:token,REACH_AGENT_MODEL_CONTEXT:'131072',REACH_AGENT_MODEL_MAX_OUTPUT:'1024',REACH_AGENT_MODEL_IMAGE_INPUT:'0'});
  assert.equal((await f.pair()).code,0);if(start)f.node('host');
  return {f,root,requests,nodeEnv,async ready(){return until(()=>f.request('/api/v1/nodes'),v=>v.nodes.some((n:any)=>n.capabilities.includes('agent.delegate')));},async close(){await f.cleanup();provider.close();provider.closeAllConnections();await once(provider,'close');assert.equal(fault,undefined);console.log(JSON.stringify({agentGuidanceNativeEvidence:root}));}};
}

test('versioned skill and full tool arguments reach the actual model and produce one real source-directed file',{skip:!sidecar,timeout:90000},async()=>{
  const filename='skill-'+randomUUID()+'.txt',bytes='当前来源 '+randomUUID(),original=source(JSON.stringify({filename,contentBase64:Buffer.from(bytes).toString('base64')}),{requirements});
  const t=await setup((body,n,res)=>{const supplied=guidance(body);assert.deepEqual(supplied.sources,[original]);assert.equal(supplied.environment.toolContractVersion,1);
    const variants=body.tools.find((v:any)=>v.function.name==='reach_execute').function.parameters.properties.command.oneOf;assert.equal(variants.length,6);assert.ok(variants.find((v:any)=>v.properties.kind.const==='file.write').required.includes('contentBase64'));
    if(n===1){const task=JSON.parse(supplied.sources[0].text);res.end(tool({kind:'file.write',path:task.filename,contentBase64:task.contentBase64}));}else{assert.equal(n,2);assert.ok(body.messages.some((m:any)=>m.tool_call_id==='skill-write-once'&&/succeeded/.test(m.content)));res.end(answer());}
  });
  try{await t.ready();const op=await t.f.submit({kind:'agent.delegate',sessionId:randomUUID(),cwd:t.root,objective:'Follow the supplied skill to write its named file once, then report original evidence.',sources:[original],maxCalls:3,maxSeconds:60,maxOutput:1024}),end=await t.f.settled(op.id);assert.equal(end.execution,'succeeded',JSON.stringify(end));assert.equal(readFileSync(join(t.root,filename),'utf8'),bytes);assert.equal(JSON.parse(end.result_json).taskAccepted,false);
    const task=JSON.parse(readFileSync(join(t.f.state,'agents',op.id,'task.json'),'utf8'));assert.deepEqual(task.guidance.sources,[original]);assert.equal(task.guidance.toolContractSha256,sha(readFileSync(new URL('../src/node/agent-tool-contract-v1.json',import.meta.url))));
    await until(async()=>t.f.sql(db=>Number(db.prepare('SELECT count(*) AS n FROM outbox WHERE acknowledged=0').get()!.n)),n=>n===0);
    await t.f.restartService();assert.deepEqual(JSON.parse((await t.f.operation(op.id)).command_json).sources,[original]);assert.equal(t.requests.length,2);
    writeFileSync(join(t.root,'asserted.json'),JSON.stringify({parent:end,task,requests:2,file:{path:filename,sha256:sha(bytes)},originalSource:original},null,2));
  }finally{await t.close();}
});

test('Node checks configured capabilities before running even if service hello was stale',{skip:!sidecar,timeout:90000},async()=>{
  const t=await setup(()=>assert.fail('No model may start on incompatible Node'));let held=false,release!:()=>void;const hold=new Promise<void>(r=>{release=r;});
  try{await t.ready();t.f.intercept(async(req,_res,_bytes,forward)=>{if(req.url==='/api/v1/node/poll'&&!held){held=true;await hold;}return false;});await until(async()=>held,Boolean);
    // Simulate a queued Task admitted with a configured desktop, followed by a restart without it.
    const db=new DatabaseSync(join(t.root,'service/reach.sqlite'));try{const caps=JSON.parse(String(db.prepare('SELECT capabilities FROM nodes').get()!.capabilities));db.prepare('UPDATE nodes SET capabilities=?').run(JSON.stringify([...caps,'desktop.call']));}finally{db.close();}
    const original=source('Requires the configured desktop but must not start without it.',{requirements:{...requirements,capabilities:['desktop.call']}}),op=await t.f.submit({kind:'agent.delegate',sessionId:randomUUID(),cwd:t.root,objective:'Check required environment before starting.',sources:[original],maxCalls:2,maxSeconds:45,maxOutput:1024});
    // Preserve the admitted response to exercise Node's own check, independently of service claim guard.
    t.f.intercept(async(req,res,_bytes,forward)=>{if(req.url==='/api/v1/node/poll'){const db=new DatabaseSync(join(t.root,'service/reach.sqlite'));try{const dispatch=t.f.identity(),row=db.prepare('SELECT * FROM operations WHERE id=?').get(op.id)!;if(row.delivery==='queued'){
          // This test adapter only supplies an already-admitted dispatch. Normal service claim is tested separately.
          const id=randomUUID(),now=Date.now();db.prepare("UPDATE operations SET delivery='claimed',dispatch_id=?,claimed_at=?,updated_at=? WHERE id=?").run(id,now,now,op.id);db.prepare('UPDATE agent_tasks SET deadline_unix_ms=? WHERE root_id=?').run(now+45000,op.id);
          res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({operation:{operationId:op.id,nodeId:dispatch.node_id,epoch:dispatch.epoch,dispatchId:id,payloadHash:row.payload_hash,command:JSON.parse(String(row.command_json)),createdAt:row.created_at}}));return true;
        }}finally{db.close();}}return false;});
    release();const end=await t.f.settled(op.id);assert.equal(end.execution,'failed',JSON.stringify(end));const result=JSON.parse(end.result_json);assert.equal(result.reason,'agent_guidance_incompatible');assert.equal(result.started,false);assert.equal(result.issues[0].code,'agent_capability_missing');assert.equal(t.requests.length,0);assert.deepEqual((await t.f.events(op.id)).map(e=>e.kind),['received','failed']);assert.equal(existsSync(join(t.f.state,'agents',op.id)),false);
    writeFileSync(join(t.root,'asserted.json'),JSON.stringify({parent:end,requests:0,agentDirectoryCreated:false,adapter:'supplied already-admitted dispatch to isolate Node guard'},null,2));
  }finally{release();await t.close();}
});

test('new Node resumes a real older Node Task with its exact old tools and source text',{skip:!sidecar||!legacy,timeout:140000},async()=>{
  let originalTools:unknown;const original=source('Original skill revision from the older Node must remain unchanged.');
  const t=await setup((body,n,res)=>{const tools=body.tools;if(n===1){originalTools=tools;assert.equal(tools.find((v:any)=>v.function.name==='reach_execute').function.parameters.properties.command.oneOf,undefined);res.end(tool({kind:'file.write',path:'legacy-effect.txt',contentBase64:'b25jZQ=='}));}else{assert.equal(n,2);assert.deepEqual(tools,originalTools);assert.ok(JSON.stringify(body.messages).includes(original.text));res.end(answer());}},false);
  const old=spawn(legacy!,['--state-dir',t.f.state,'host'],{env:t.nodeEnv,windowsHide:true,stdio:'ignore'});let parentId='',held=false,release=false;
  try{await t.ready();t.f.intercept(async(req,res,bytes,forward)=>{if(req.url==='/api/v1/node/events'){const e=JSON.parse(bytes.toString());if(e.operationId!==parentId&&e.kind==='succeeded'&&!release){const saved=await forward();assert.equal(saved.status,200);await saved.arrayBuffer();held=true;res.writeHead(503);res.end('{}');return true;}}return false;});
    const sessionId=randomUUID(),op=await t.f.submit({kind:'agent.delegate',sessionId,cwd:t.root,objective:'Use original file write once and preserve its original receipt.',sources:[original],maxRuns:4,maxCalls:8,runCallLimit:2,maxSeconds:180,maxOutput:1024});parentId=op.id;await until(async()=>held,Boolean);await kill(old);release=true;t.f.intercept();t.f.node('host');await until(()=>t.f.operation(op.id),v=>v.execution==='unknown');await until(async()=>t.f.sql(db=>Number(db.prepare('SELECT count(*) AS n FROM outbox WHERE acknowledged=0').get()!.n)),n=>n===0);
    const taskPath=join(t.f.state,'agents',op.id,'task.json'),before=sha(readFileSync(taskPath)),oldTask=JSON.parse(readFileSync(taskPath,'utf8')),session=join(t.f.state,'agent-sessions',sessionId),fence=join(session,readdirSync(session).find(v=>v.endsWith('.fence.json'))!);
    const resume=await t.f.submit({kind:'agent.resume',rootOperationId:op.id,previousExecutionId:op.id,fenceSha256:sha(readFileSync(fence)),instruction:'Continue original Task without replacing source or tool definitions.'});
    const reviews=await until(()=>t.f.request(`/api/v1/operations/${op.id}/agent-reviews`),v=>v.reviews.length===1,35000),review=reviews.reviews[0];
    await t.f.request(`/api/v1/operations/${resume.id}/agent-reviews`,'POST',{reviewId:randomUUID(),runId:review.runId,basisSha256:review.basisSha256,decision:'return_result',feedback:''});
    const end=await t.f.settled(resume.id);assert.equal(end.execution,'succeeded',JSON.stringify(end));assert.equal(sha(readFileSync(taskPath)),before);assert.equal(t.requests.length,2);assert.equal(readFileSync(join(t.root,'legacy-effect.txt'),'utf8'),'once');
    const newTask=JSON.parse(readFileSync(join(t.f.state,'agents',op.id,'attempts',resume.id,'task.json'),'utf8'));assert.deepEqual(newTask.start.run.tools,oldTask.start.run.tools);assert.equal(oldTask.guidance,undefined);assert.equal(newTask.guidance,null);assert.equal((await t.f.request(`/api/v1/operations/${op.id}/children`)).calls.length,1);
    writeFileSync(join(t.root,'asserted.json'),JSON.stringify({parent:await t.f.operation(op.id),resume:end,oldTask,newTask,originalTaskSha256:before,requests:2,effects:1},null,2));
  }finally{release=true;await kill(old);await t.close();}
});
