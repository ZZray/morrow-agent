// Copyright (c) Ray Zhang. Real Node crash, once-only command effect and read-only native fence observation.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fixture,until,kill} from './native-fixture.ts';
const sidecar=process.env.REACH_DESK_SIDECAR,sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const frame=(delta:unknown,finish:string|null=null)=>'data: '+JSON.stringify({id:'inspection-model',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n';
const tree=(root:string):any[]=>readdirSync(root).sort().flatMap(name=>{const path=join(root,name);return statSync(path).isDirectory()?tree(path):[{path,sha256:sha(readFileSync(path))}];});

test('after a real Node hard exit inspection returns the exact retained fence without replaying its original command',{skip:!sidecar,timeout:150000},async()=>{
  assert.ok(sidecar);const root=resolve('work/agent-native-inspection-'+randomUUID());mkdirSync(root,{recursive:true});const token=randomBytes(32).toString('base64url'),requests:any[]=[];let providerError:unknown;
  const effect=join(root,'effect.txt'),command=`[IO.File]::AppendAllText('${effect.replaceAll("'","''")}','once'+[Environment]::NewLine)`;
  const provider=createServer(async(req,res)=>{try{assert.equal(req.headers.authorization,'Bearer '+token);const chunks:Buffer[]=[];for await(const bytes of req)chunks.push(Buffer.from(bytes));requests.push(JSON.parse(Buffer.concat(chunks).toString()));writeFileSync(join(root,'provider-requests.json'),JSON.stringify(requests,null,2));res.writeHead(200,{'content-type':'text/event-stream',connection:'close'});assert.equal(requests.length,1,'inspection cannot initiate another model request');res.end(frame({tool_calls:[{index:0,id:'append-once',type:'function',function:{name:'reach_execute',arguments:JSON.stringify({command:{kind:'command.run',command,cwd:root,timeoutMs:30000}})}}]})+frame({},'tool_calls')+'data: [DONE]\n\n');}catch(error){providerError=error;res.destroy();}});
  provider.listen(0,'127.0.0.1');await once(provider,'listening');const address=provider.address();assert.ok(address&&typeof address!=='string');const config=join(root,'agent-runtime.json');writeFileSync(config,JSON.stringify({sidecar,sha256:sha(readFileSync(sidecar))}));
  writeFileSync(join(root,'started-inputs.json'),JSON.stringify([process.env.REACH_NODE_BINARY!,sidecar,resolve('tests/agent-inspection.integration.test.ts'),resolve('tests/native-fixture.ts'),resolve('src/node/agent_resume.rs'),resolve('src/node/agent_relay.rs'),resolve('src/node/runtime.rs'),resolve('src/node/protocol.rs'),resolve('src/service/store.ts'),resolve('src/contracts/protocol.ts')].map(path=>({path,sha256:sha(readFileSync(path))})),null,2));
  let f:Awaited<ReturnType<typeof fixture>>|undefined;
  try{
    f=await fixture('',{...process.env,REACH_AGENT_CONFIG:config},root,{...process.env,REACH_AGENT_MODEL_URL:`http://127.0.0.1:${address.port}/v1`,REACH_AGENT_MODEL_ID:'inspection-model',REACH_AGENT_MODEL_TOKEN:token,REACH_AGENT_MODEL_CONTEXT:'131072',REACH_AGENT_MODEL_MAX_OUTPUT:'1024',REACH_AGENT_MODEL_IMAGE_INPUT:'0'});assert.equal((await f.pair()).code,0);const runner=f.node('host');
    const capabilities=await until(()=>f!.request('/api/v1/nodes'),v=>v.nodes.some((n:any)=>n.capabilities.includes('agent.inspect')));assert.ok(capabilities.nodes[0].capabilities.includes('agent.resume'));
    let held=false,release=false,parentId='';
    f.intercept(async(req,res,bytes,forward)=>{
      if(req.url==='/api/v1/node/events'){const event=JSON.parse(bytes.toString());if(event.kind==='succeeded'&&event.operationId!==parentId&&!release){const upstream=await forward();await upstream.arrayBuffer();held=true;res.writeHead(503,{'content-type':'application/json'});res.end('{"error":{"code":"controlled_ack_loss_after_commit"}}');return true;}}
      return false;
    });
    const sessionId=randomUUID(),parent=await f.submit({kind:'agent.delegate',sessionId,cwd:root,objective:'Append one line once; preserve the original command receipt.',maxRuns:3,maxCalls:6,runCallLimit:2,maxSeconds:300,maxOutput:1024});parentId=parent.id;
    await until(async()=>held,Boolean);assert.equal(readFileSync(effect,'utf8'),'once\r\n');assert.equal(requests.length,1);await kill(runner.child);release=true;f.intercept();
    f.node('host');await until(()=>f!.operation(parent.id),v=>v.execution==='unknown');await until(async()=>f!.sql(db=>Number(db.prepare('SELECT count(*) AS n FROM outbox WHERE acknowledged=0').get()!.n)),v=>v===0);
    const original=await f.operation(parent.id),originalEvents=await f.events(parent.id),models=await f.request(`/api/v1/operations/${parent.id}/agent-models`),children=await f.request(`/api/v1/operations/${parent.id}/children`),task=await f.request(`/api/v1/operations/${parent.id}/agent-task`);
    assert.equal(children.calls.length,1);assert.equal(models.requests.length,1);assert.equal(models.requests[0].state,'stream_complete');assert.equal(task.generation,1);assert.equal(task.activeExecutionId,parent.id);
    const session=join(root,'node/agent-sessions',sessionId),nativeBefore=tree(session),fence=nativeBefore.find(row=>row.path.endsWith('.fence.json'));assert.ok(fence);const nativeFence=JSON.parse(readFileSync(fence.path,'utf8'));assert.equal(nativeFence.task_id,parent.id);assert.equal(nativeFence.state,'active_or_unknown');
    const taskPath=join(root,'node/agents',parent.id,'task.json'),originalTask=readFileSync(taskPath),requestId=randomUUID();
    const observationOp=await f.submit({kind:'agent.inspect',rootOperationId:parent.id},requestId),observed=await f.settled(observationOp.id);assert.equal(observed.execution,'succeeded');const result=JSON.parse(observed.result_json);assert.equal(result.expectedFenceSha256,fence.sha256);assert.equal(result.fencePresent,true);assert.equal(result.nativeAuthorityVerified,false);assert.equal(result.taskAccepted,false);assert.equal(result.taskId,parent.id);assert.equal(result.inspectionOperationId,observationOp.id);
    assert.equal((await f.submit({kind:'agent.inspect',rootOperationId:parent.id},requestId)).id,observationOp.id);
    const tampered=JSON.parse(originalTask.toString());tampered.sidecarSha256='0'.repeat(64);writeFileSync(join(root,'task-original.json'),originalTask);writeFileSync(join(root,'task-tampered.json'),JSON.stringify(tampered));writeFileSync(taskPath,JSON.stringify(tampered));
    try{const invalid=await f.submit({kind:'agent.inspect',rootOperationId:parent.id}),rejected=await f.settled(invalid.id);assert.equal(rejected.execution,'unknown');assert.ok(!JSON.parse(rejected.result_json).expectedFenceSha256);}finally{writeFileSync(taskPath,originalTask);}
    assert.deepEqual(tree(session),nativeBefore);assert.deepEqual(await f.operation(parent.id),original);assert.deepEqual(await f.events(parent.id),originalEvents);assert.deepEqual(await f.request(`/api/v1/operations/${parent.id}/agent-models`),models);assert.deepEqual(await f.request(`/api/v1/operations/${parent.id}/children`),children);assert.deepEqual(await f.request(`/api/v1/operations/${parent.id}/agent-task`),task);assert.equal(readFileSync(effect,'utf8'),'once\r\n');assert.equal(requests.length,1);
    assert.ok(!JSON.stringify(result).includes(token));assert.ok(!JSON.stringify(result).includes(JSON.parse(originalTask.toString()).relayToken));assert.ok(!JSON.stringify(result).includes(root));
    writeFileSync(join(root,'asserted-native-inspection.json'),JSON.stringify({scope:'actual Node SIGKILL after one effect and before original tool ACK; inspection only, no Task resume',parent:original,parentEvents:originalEvents,models,children,task,result,nativeBefore,nativeAfter:tree(session),effect:'once\r\n',modelRequests:requests.length},null,2));
  }finally{if(f)await f.cleanup();provider.close();provider.closeAllConnections();await once(provider,'close');assert.equal(providerError,undefined);console.log(JSON.stringify({agentNativeInspection:root}));}
});
