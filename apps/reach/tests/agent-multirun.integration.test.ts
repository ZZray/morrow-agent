// Copyright (c) Ray Zhang. Ordinary Node, original Task/Session, live caller feedback and loopback model.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fixture,until,delay} from './native-fixture.ts';
const sidecar=process.env.REACH_DESK_SIDECAR;
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const delta=(value:unknown,finish:string|null=null)=>'data: '+JSON.stringify({id:'local-multirun',model:'local-multirun',choices:[{index:0,delta:value,finish_reason:finish}]})+'\n\n';
const answer=(text:string)=>delta({content:text})+delta({},'stop')+'data: [DONE]\n\n';
const tool=(id:string,command:unknown)=>delta({tool_calls:[{index:0,id,type:'function',function:{name:'reach_execute',arguments:JSON.stringify({command})}}]})+delta({},'tool_calls')+'data: [DONE]\n\n';
async function setup(reply:(n:number,body:any)=>string){
  assert.ok(sidecar);const root=resolve('work/agent-multirun-'+randomUUID());mkdirSync(root,{recursive:true});const token=randomBytes(32).toString('base64url'),requests:any[]=[];let fault:unknown;
  writeFileSync(join(root,'started-inputs.json'),JSON.stringify([process.env.REACH_NODE_BINARY!,sidecar,resolve('tests/agent-multirun.integration.test.ts'),resolve('tests/native-fixture.ts'),resolve('src/service/store.ts'),resolve('src/service/server.ts'),resolve('src/service/agent-reviews.ts'),resolve('src/service/agent-model-store.ts'),resolve('src/service/agent-calls.ts'),resolve('src/contracts/agent-review.ts')].map(path=>({path,sha256:sha(readFileSync(path))})),null,2));
  const provider=createServer(async(req,res)=>{try{assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer '+token);const chunks:Buffer[]=[];for await(const b of req)chunks.push(Buffer.from(b));const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);writeFileSync(join(root,'provider-requests.json'),JSON.stringify(requests,null,2));const result=reply(requests.length,body);res.writeHead(200,{'content-type':'text/event-stream',connection:'close'});res.end(result);}catch(error){fault=error;res.destroy();}});
  provider.listen(0,'127.0.0.1');await once(provider,'listening');const address=provider.address();assert.ok(address&&typeof address!=='string');
  const config=join(root,'agent-runtime.json');writeFileSync(config,JSON.stringify({sidecar,sha256:sha(readFileSync(sidecar))}));const nodeEnv={...process.env,REACH_AGENT_CONFIG:config};for(const key of Object.keys(nodeEnv))if(key.startsWith('REACH_AGENT_MODEL_'))delete nodeEnv[key as keyof typeof nodeEnv];
  const f=await fixture('',nodeEnv,root,{...process.env,REACH_AGENT_MODEL_URL:`http://127.0.0.1:${address.port}/v1`,REACH_AGENT_MODEL_ID:'local-multirun',REACH_AGENT_MODEL_TOKEN:token,REACH_AGENT_MODEL_CONTEXT:'131072',REACH_AGENT_MODEL_MAX_OUTPUT:'1024',REACH_AGENT_MODEL_IMAGE_INPUT:'0'});assert.equal((await f.pair()).code,0);const runner=f.node('host');await until(()=>f.request('/api/v1/nodes'),v=>v.nodes.some((n:any)=>n.capabilities.includes('agent.delegate')));
  const review=(id:string,number:number)=>until(async()=>{const value=await f.request(`/api/v1/operations/${id}/agent-reviews`);if(value.reviews.length!==number){const parent=await f.operation(id);assert.ok(!['succeeded','failed','unknown','cancelled'].includes(parent.execution),'Parent ended before expected candidate: '+JSON.stringify({execution:parent.execution,result:parent.result_json}));}return value;},v=>v.reviews.length===number,120000).then(v=>v.reviews.at(-1));
  const decide=(id:string,r:any,decision:'continue'|'return_result',feedback='')=>f.request(`/api/v1/operations/${id}/agent-reviews`,'POST',{reviewId:randomUUID(),runId:r.runId,basisSha256:r.basisSha256,decision,feedback});
  return{f,root,requests,runner,review,decide,async close(){await f.cleanup();provider.close();provider.closeAllConnections();await once(provider,'close');assert.equal(fault,undefined);console.log(JSON.stringify({agentMultirunEvidence:root}));}};
}

test('caller feedback continues the same real Task and Session, with CLI/MCP and cumulative original receipts',{skip:!sidecar,timeout:150000},async()=>{
  const feedback='Do not write again. Read effect.txt and include the original receipt.';
  const t=await setup((n,body)=>{if(n===1)return tool('write-original',{kind:'file.write',path:'effect.txt',contentBase64:Buffer.from('once\n').toString('base64')});if(n===2)return answer('The file was written; await caller review.');if(n===3){assert.ok(JSON.stringify(body.messages).includes(feedback));assert.ok(body.messages.some((m:any)=>m.tool_call_id==='write-original'));return tool('read-original',{kind:'file.read',path:'effect.txt',length:64});}assert.equal(n,4);assert.ok(JSON.stringify(body.messages).includes('b25jZQo='));return answer('The original file was read; evidence awaits caller acceptance.');});
  try{
    const op=await t.f.submit({kind:'agent.delegate',sessionId:randomUUID(),cwd:t.root,objective:'Write effect.txt once and provide verified evidence.',maxRuns:2,maxCalls:6,maxToolCalls:4,maxSeconds:130,maxOutput:1024});
    const first=await t.review(op.id,1);assert.equal((await t.f.operation(op.id)).execution,'running');assert.equal(t.requests.length,2);assert.equal(first.decision,null);await delay(350);assert.equal(t.requests.length,2,'waiting for review must not spend another model call');
    assert.equal((await t.f.loginController()).code,0);const listed=await t.f.controller(['agent-reviews',op.id]).done;assert.equal(listed.code,0,listed.stderr);assert.equal(JSON.parse(listed.stdout).reviews[0].basisSha256,first.basisSha256);
    const mcp=t.f.mcp();await mcp.call('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'local-multirun-test',version:'1'}});
    const decision={operationId:op.id,reviewId:randomUUID(),runId:first.runId,basisSha256:first.basisSha256,decision:'continue',feedback};
    const submitted=await mcp.call('tools/call',{name:'reach_agent_review',arguments:decision});assert.equal(submitted.result.isError,undefined);const original=JSON.parse(submitted.result.content[0].text);assert.equal(original.feedbackSha256,sha(feedback));
    const second=await t.review(op.id,2);assert.notEqual(first.runId,second.runId);assert.equal(second.runId,original.nextRunId);assert.equal(second.candidate.basis.raw_start,first.candidate.basis.raw_end);assert.equal(second.childOperationIds.length,2);assert.equal(first.childOperationIds.length,1);
    const duplicate=await mcp.call('tools/call',{name:'reach_agent_review',arguments:decision});assert.deepEqual(JSON.parse(duplicate.result.content[0].text),original);
    const file=join(t.root,'return-result.json');writeFileSync(file,JSON.stringify({operationId:op.id,reviewId:randomUUID(),runId:second.runId,basisSha256:second.basisSha256,decision:'return_result'}));const returned=await t.f.controller(['agent-review',file]).done;assert.equal(returned.code,0,returned.stderr);
    const end=await t.f.settled(op.id);assert.equal(end.execution,'succeeded',JSON.stringify(end));const result=JSON.parse(end.result_json);assert.equal(result.taskAccepted,false);assert.equal(result.status,'awaiting_review');assert.equal(result.outcome.runs,2);assert.equal(result.outcome.observed_calls,4);assert.equal(result.outcome.fence_presence,'Released');assert.equal(readFileSync(join(t.root,'effect.txt'),'utf8'),'once\n');assert.equal(t.requests.length,4);
    const children=(await t.f.request(`/api/v1/operations/${op.id}/children`)).calls;assert.equal(children.length,2);assert.equal(new Set(children.map((c:any)=>c.run_id)).size,2);const task=join(t.f.state,'agents',op.id),run1=JSON.parse(readFileSync(join(task,'run-1.json'),'utf8')),run2=JSON.parse(readFileSync(join(task,'run-2.json'),'utf8'));assert.equal(run1.runId,first.runId);assert.equal(run2.runId,second.runId);assert.equal(run2.remainingCalls,4);
    const service=new DatabaseSync(join(t.root,'service/reach.sqlite'),{readOnly:true});try{const modelRuns=service.prepare('SELECT run_id,count(*) AS n FROM agent_model_calls WHERE parent_id=? GROUP BY run_id').all(op.id);assert.equal(modelRuns.length,2);assert.ok(modelRuns.every(r=>r.n===2));}finally{service.close();}
    const stopped=await t.f.node('host-stop').done;assert.equal(stopped.code,0,stopped.stderr);await t.runner.done;writeFileSync(join(t.root,'asserted.json'),JSON.stringify({parent:end,first,second,children,modelCalls:4,originalTask:true,originalSession:true,cliMcp:true,taskAccepted:false},null,2));
  }finally{await t.close();}
});

test('last-Run correction ends as a settled incomplete result, without a false recovery fence or automatic Task acceptance',{skip:!sidecar,timeout:90000},async()=>{
  const t=await setup(n=>answer('Local Run '+n+' candidate.'));
  try{const sessionId=randomUUID(),op=await t.f.submit({kind:'agent.delegate',sessionId,cwd:t.root,objective:'Exercise the original two-Run bound.',maxRuns:2,maxCalls:4,maxSeconds:70,maxOutput:1024});const first=await t.review(op.id,1);await t.decide(op.id,first,'continue','Need a second original Run.');const second=await t.review(op.id,2);await t.decide(op.id,second,'continue','Still needs changes, but no more Runs are authorized.');const end=await t.f.settled(op.id);assert.equal(end.execution,'failed',JSON.stringify(end));const result=JSON.parse(end.result_json);assert.equal(result.taskAccepted,false);assert.equal(result.outcome.stop,'BudgetExhausted');assert.equal(result.outcome.fence_presence,'Released');assert.equal(t.requests.length,2);const directory=join(t.f.state,'agent-sessions',sessionId);assert.equal(readdirSync(directory).filter(n=>n.endsWith('.fence.json')).length,0);
    const next=await t.f.submit({kind:'agent.delegate',sessionId,cwd:t.root,objective:'A new Task may use the already-settled original Session.',maxCalls:2,maxSeconds:30,maxOutput:1024});assert.equal((await t.f.settled(next.id)).execution,'succeeded');assert.equal(t.requests.length,3);writeFileSync(join(t.root,'asserted.json'),JSON.stringify({parent:end,nextTaskId:next.id,requests:3,runLimit:2,knownIncomplete:true},null,2));
  }finally{await t.close();}
});

test('cancellation while awaiting caller feedback preserves the one real effect and the original native fence',{skip:!sidecar,timeout:90000},async()=>{
  const t=await setup(n=>n===1?tool('one-effect',{kind:'file.write',path:'effect.txt',contentBase64:Buffer.from('once\n').toString('base64')}):answer('Candidate before cancellation.'));
  try{const sessionId=randomUUID(),op=await t.f.submit({kind:'agent.delegate',sessionId,cwd:t.root,objective:'Write once and wait for caller feedback.',maxRuns:2,maxCalls:5,maxSeconds:60,maxOutput:1024});const first=await t.review(op.id,1);await t.f.request(`/api/v1/operations/${op.id}/cancel`,'POST',{});const end=await t.f.settled(op.id);assert.equal(end.execution,'unknown');assert.equal(readFileSync(join(t.root,'effect.txt'),'utf8'),'once\n');assert.equal(t.requests.length,2);assert.equal(readdirSync(join(t.f.state,'agent-sessions',sessionId)).filter(n=>n.endsWith('.fence.json')).length,1);const reviews=await t.f.request(`/api/v1/operations/${op.id}/agent-reviews`);assert.equal(reviews.reviews[0].decision,null);writeFileSync(join(t.root,'asserted.json'),JSON.stringify({parent:end,first,requests:2,effect:'once',fencePreserved:true},null,2));
  }finally{await t.close();}
});

test('cancellation after reserving the next Run cannot release prepare or spend its first model request',{skip:!sidecar,timeout:90000},async()=>{
  const t=await setup(()=>answer('Candidate awaiting an exact continuation.'));let release!:()=>void;const gate=new Promise<void>(r=>release=r);let reserved=false;
  try{const sessionId=randomUUID(),op=await t.f.submit({kind:'agent.delegate',sessionId,cwd:t.root,objective:'Exercise the prepared Run cancellation boundary.',maxRuns:2,maxCalls:4,maxSeconds:60,maxOutput:1024}),first=await t.review(op.id,1);
    t.f.intercept(async(request,response,bytes,forward)=>{if(request.url?.endsWith(`/agents/${op.id}/runs`)&&JSON.parse(bytes.toString()).runId!==first.runId){const result=await forward(),body=await result.json();assert.equal(result.status,200);reserved=true;await gate;response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(body));return true;}return false;});
    await t.decide(op.id,first,'continue','Continue only within the original Task.');await until(async()=>reserved,Boolean);await t.f.request(`/api/v1/operations/${op.id}/cancel`,'POST',{});await delay(400);release();const end=await t.f.settled(op.id);assert.equal(end.execution,'unknown');assert.equal(t.requests.length,1);
    const service=new DatabaseSync(join(t.root,'service/reach.sqlite'),{readOnly:true});try{assert.equal(service.prepare('SELECT count(*) AS n FROM agent_runs WHERE parent_id=?').get(op.id)!.n,2);assert.equal(service.prepare('SELECT count(*) AS n FROM agent_model_calls WHERE parent_id=?').get(op.id)!.n,1);}finally{service.close();}
    assert.equal(readdirSync(join(t.f.state,'agent-sessions',sessionId)).filter(n=>n.endsWith('.fence.json')).length,1);writeFileSync(join(t.root,'asserted.json'),JSON.stringify({parent:end,reservedRuns:2,modelCalls:1,secondRunNoModel:true,fencePreserved:true},null,2));
  }finally{release();await t.close();}
});

test('the original deadline stops waiting for feedback without inventing verification or another Run',{skip:!sidecar,timeout:60000},async()=>{
  const t=await setup(()=>answer('Candidate that receives no caller feedback.'));
  try{const sessionId=randomUUID(),op=await t.f.submit({kind:'agent.delegate',sessionId,cwd:t.root,objective:'Keep the original thirty-second deadline while waiting for feedback.',maxRuns:2,maxCalls:3,maxSeconds:30,maxOutput:1024}),first=await t.review(op.id,1),end=await t.f.settled(op.id);assert.equal(end.execution,'unknown');assert.equal(t.requests.length,1);assert.equal(first.decision,null);assert.ok(end.updated_at>=end.claimed_at+30000&&end.updated_at<end.claimed_at+40000,'original deadline was extended or ignored');assert.equal(readdirSync(join(t.f.state,'agent-sessions',sessionId)).filter(n=>n.endsWith('.fence.json')).length,1);writeFileSync(join(t.root,'asserted.json'),JSON.stringify({parent:end,first,requests:1,originalDeadline:true,noAutomaticVerification:true},null,2));
  }finally{await t.close();}
});
