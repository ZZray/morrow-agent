// Copyright (c) Ray Zhang. Explicit opt-in trial through an existing operator model route.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {DeskHost} from '../src/host.ts';
import {ReachStore} from '../../src/service/store.ts';
import {reachServer} from '../../src/service/server.ts';

test('Reach Desk completes two bounded real replies in the same native Session through Ray operator route',{skip:process.env.REACH_REAL_DESK!=='1',timeout:150000},async t=>{
  const root=resolve('work/desk-real-'+randomUUID());mkdirSync(root,{recursive:true});
  const organization=process.env.REACH_DESK_REAL_ROUTE==='omp';
  const remotePort=organization?18799:18803;
  // Credential is read through the existing SSH authorization into process memory.
  // Never print it or save it with the trial, input frame, or model directory.
  let modelToken='reach-desk-local-verification';
  if(organization){try{modelToken=execFileSync('ssh',['ray-dev','python3','-'],{input:"import pathlib,subprocess,sys\npid=subprocess.check_output(['systemctl','show','handwave.service','--property=MainPID','--value'],text=True).strip()\nenv=dict(x.split('=',1) for x in pathlib.Path('/proc/'+pid+'/environ').read_text().split('\\0') if '=' in x)\nsys.stdout.write(env['HW_GATEWAY_TOKEN'])\n",encoding:'utf8',windowsHide:true,timeout:15000,stdio:['pipe','pipe','ignore']});}catch{throw Error('Operator model credential retrieval failed');}}
  assert.ok(modelToken.length>0,'operator model credential unavailable');
  const pinned=['platform/src/host.ts','platform/src/store.ts','platform/src/events.ts','src/service/server.ts','src/service/main.ts','platform/tests/real-model.integration.test.ts',process.env.REACH_DESK_SIDECAR!].map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}));
  writeFileSync(join(root,'started-inputs.json'),JSON.stringify({at:new Date().toISOString(),pinned},null,2));
  const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const a=reserve.address();assert.ok(a&&typeof a!=='string');const port=a.port;await new Promise<void>(r=>reserve.close(()=>r()));
  const tunnel=spawn('ssh',['-N','-T','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=10','-L',`127.0.0.1:${port}:127.0.0.1:${remotePort}`,'ray-dev'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let tunnelError='';tunnel.stderr.on('data',v=>{tunnelError+=v;writeFileSync(join(root,'tunnel-stderr.log'),tunnelError);});
  let desk:DeskHost|undefined,store:ReachStore|undefined,server:ReturnType<typeof reachServer>|undefined,receipt:unknown;
  const abort=()=>{tunnel.kill();void desk?.close();};t.signal.addEventListener('abort',abort,{once:true});
  try{
    const endpoint=`http://127.0.0.1:${port}/v1`;let directory:any;
    for(let i=0;i<100;i++){t.signal.throwIfAborted();try{const response=await fetch(endpoint+'/models',{headers:{authorization:'Bearer '+modelToken},signal:AbortSignal.timeout(1000)});if(response.ok){directory=await response.json();break;}}catch{}await new Promise(r=>setTimeout(r,100));}
    const model=process.env.REACH_DESK_REAL_MODEL??(organization?'deepseek-v4.1-flash':'opencode/mimo-v2.6-flash-free');assert.ok(directory?.data?.some((v:any)=>v.id===model),tunnelError);
    writeFileSync(join(root,'model-directory.json'),JSON.stringify(directory,null,2));
    const nonce=randomBytes(4).toString('hex'),expected={nonce,sum:42},prompt=`这是 Reach Desk 接线验证。本对话的校验码为 ${nonce}。请计算 37 + 5，仅返回一个 JSON 对象，恰含 nonce 和 sum 两个字段：nonce 是上述校验码，sum 是计算结果的数字。不要代码围栏、解释或工具调用。`;
    writeFileSync(join(root,'trial.json'),JSON.stringify({model,protocol:'OpenAI Chat through SSH-forwarded existing Ray '+(organization?'OMP gateway':'opencode2api'),maxTaskCalls:1,maxRuns:1,maxOutput:512,maxTaskSeconds:60,maxTasks:2,maxTotalLogicalCalls:2,maxTotalTaskSeconds:120,expected,prompt,credentials:organization?'existing operator gateway credential held in memory only':'non-secret placeholder for loopback route; no account credential read'},null,2));
    desk=new DeskHost({stateDirectory:join(root,'desk'),binary:process.env.REACH_DESK_SIDECAR!,endpoint,model,modelToken,developmentLoopback:true,maxCalls:1,maxOutput:512,maxSeconds:60});
    store=new ReachStore(join(root,'reach.sqlite'));store.bootstrap('real-desk','disposable-real-desk-password');const session=store.login('real-desk','disposable-real-desk-password');
    server=reachServer({store,desk,publicOrigin:'http://127.0.0.1',allowInsecureLoopback:true});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
    const request=(path:string,data:unknown)=>fetch(`http://127.0.0.1:${address.port}${path}`,{method:'POST',headers:{authorization:'Bearer '+session.token,'content-type':'application/json'},body:JSON.stringify(data),signal:t.signal});
    const conversation=randomUUID(),id=randomUUID();assert.equal((await request('/api/v1/desk/conversations',{id:conversation})).status,201);
    const response=await request(`/api/v1/desk/conversations/${conversation}/messages`,{id,content:prompt});assert.equal(response.status,200);
    const raw=await response.text();writeFileSync(join(root,'sse.txt'),raw);
    const turn=desk.store.turn(session.user.id,id);writeFileSync(join(root,'turn.json'),JSON.stringify(turn,null,2));
    assert.equal(turn.status,'completed');assert.deepEqual(JSON.parse(turn.output),expected);
    const result=JSON.parse(readFileSync(join(root,'desk/tasks',turn.task_id,'result.json'),'utf8'));
    assert.equal(result.delivery,'validated');assert.equal(result.outcome.observed_calls,1);assert.equal(result.outcome.task_accepted,false);assert.equal(result.outcome.fence_presence,'Released');
    const nextId=randomUUID(),nextPrompt='现在从当前对话记住的内容取回刚才的校验码，再计算 8 × 7。仍仅返回 JSON 对象，恰含 nonce 和 sum 两个字段，不要代码围栏、解释或工具调用。';
    const nextResponse=await request(`/api/v1/desk/conversations/${conversation}/messages`,{id:nextId,content:nextPrompt});assert.equal(nextResponse.status,200);
    writeFileSync(join(root,'second-sse.txt'),await nextResponse.text());
    const nextTurn=desk.store.turn(session.user.id,nextId);writeFileSync(join(root,'second-turn.json'),JSON.stringify(nextTurn,null,2));
    assert.equal(nextTurn.status,'completed');assert.deepEqual(JSON.parse(nextTurn.output),{nonce,sum:56});
    const nextResult=JSON.parse(readFileSync(join(root,'desk/tasks',nextTurn.task_id,'result.json'),'utf8'));
    assert.equal(nextResult.delivery,'validated');assert.equal(nextResult.outcome.observed_calls,1);assert.equal(nextResult.outcome.task_accepted,false);assert.equal(nextResult.outcome.fence_presence,'Released');
    const originalStart=JSON.parse(readFileSync(join(root,'desk/tasks',turn.task_id,'request.json'),'utf8')),nextStart=JSON.parse(readFileSync(join(root,'desk/tasks',nextTurn.task_id,'request.json'),'utf8'));
    assert.equal(originalStart.run.session_path,nextStart.run.session_path);assert.notEqual(turn.task_id,nextTurn.task_id);assert.notEqual(turn.run_id,nextTurn.run_id);assert.ok(!nextPrompt.includes(nonce));
    receipt={passed:true,model,replies:[{output:turn.output,taskId:turn.task_id,runId:turn.run_id},{output:nextTurn.output,taskId:nextTurn.task_id,runId:nextTurn.run_id}],nativeSession:originalStart.run.session_path,observedCalls:result.outcome.observed_calls+nextResult.outcome.observed_calls,scope:'two real cloud responses with native Session recall; not device delegation or production deployment'};
  }finally{
    await desk?.close();if(server){server.close();server.closeAllConnections();await once(server,'close');}store?.close();
    if(tunnel.exitCode===null&&tunnel.signalCode===null){const done=once(tunnel,'exit');tunnel.kill();await done;}t.signal.removeEventListener('abort',abort);console.log(JSON.stringify({deskRealEvidence:root}));
  }
  t.signal.throwIfAborted();writeFileSync(join(root,'receipt.json'),JSON.stringify(receipt,null,2));
});
