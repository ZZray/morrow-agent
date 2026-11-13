// Copyright (c) Ray Zhang. Explicit, bounded real Codex/MCP image consumption.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { randomUUID,randomInt,createHash } from 'node:crypto';
import { spawn,spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { fixture,until,kill,delay } from './native-fixture.ts';

test('real Codex loads Reach MCP and identifies pixels unavailable in text receipts',{timeout:240000,skip:process.env.REACH_REAL_CODEX!=='1'},async(t)=>{
 const root=resolve('work/codex-vision-'+randomUUID());mkdirSync(root,{recursive:true});
 const workspace=join(root,'empty-workspace');mkdirSync(workspace);
 const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
 const code=Array.from({length:7},()=>alphabet[randomInt(alphabet.length)]).join('');
 const items=[{shape:'square',color:'red'},{shape:'circle',color:'green'},{shape:'triangle',color:'blue'}];
 for(let i=items.length-1;i>0;i--){const j=randomInt(i+1);[items[i],items[j]]=[items[j],items[i]];}
 const definition=join(root,'expected.json');writeFileSync(definition,JSON.stringify({code,items}));
 const statePath=join(root,'surface.json'),stopPath=join(root,'surface.stop');
 const desktop=join(root,'desktop.json');writeFileSync(desktop,JSON.stringify({helper:process.env.REACH_DESKTOP_BIN,python:process.env.REACH_DESKTOP_PYTHON,config:resolve('desktop/runtime/config.toml')}));
 let form:ReturnType<typeof spawn>|undefined,codex:ReturnType<typeof spawn>|undefined,session:Awaited<ReturnType<typeof fixture>>|undefined;
 let formErrors='',receipt:any,cleanupSession:Promise<void>|undefined;
 const abort=()=>{
  if(codex?.pid&&codex.exitCode===null)spawnSync('taskkill.exe',['/PID',String(codex.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  if(form?.exitCode===null)form.kill();
  if(session){cleanupSession??=session.cleanup();void cleanupSession.catch(()=>{});}
 };
 t.signal.addEventListener('abort',abort,{once:true});
 try {
  const f=await fixture('',{...process.env,REACH_DESKTOP_CONFIG:desktop},root);session=f;
  t.signal.throwIfAborted();
  form=spawn(join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('tests/vision-fixture.ps1'),'-DefinitionPath',definition,'-StatePath',statePath,'-StopPath',stopPath],{windowsHide:true,stdio:'pipe'});
  form.stderr!.on('data',v=>formErrors+=v.toString());
  await until(async()=>{if(existsSync(statePath+'.error'))throw Error(readFileSync(statePath+'.error','utf8'));return existsSync(statePath);},Boolean);
  await until(async()=>JSON.parse(readFileSync(statePath,'utf8')),v=>v.visible&&v.foreground);await delay(400);
  assert.equal((await f.pair()).code,0);assert.equal((await f.loginController()).code,0);
  const runner=f.node('host');
  const described=await f.settled((await f.submit({kind:'desktop.describe'})).id);assert.equal(described.execution,'succeeded');
  const info=JSON.parse(described.result_json),state=JSON.parse(readFileSync(statePath,'utf8'));
  const operation=await f.submit({kind:'desktop.call',tool:'Screenshot',argumentsJson:JSON.stringify({region:state.region}),helperGeneration:info.helperGeneration,sessionRef:info.sessionRef,snapshotId:''});
  const done=await f.settled(operation.id);assert.equal(done.execution,'succeeded',JSON.stringify(done));
  const result=JSON.parse(done.result_json),ref=result.images[0];assert.ok(ref);
  const original=join(root,'captured.png');const download=await f.controller(['artifact',operation.id,ref.artifactId,'--output',original]).done;assert.equal(download.code,0);
  assert.equal(createHash('sha256').update(readFileSync(original)).digest('hex'),ref.sha256);
  const pixels=PNG.sync.read(readFileSync(original));
  t.signal.throwIfAborted();
  const colors:Record<string,number[]>={red:[255,0,0],green:[0,128,0],blue:[0,0,255]};
  for(let i=0;i<3;i++) {
   const at=((state.clientOffset[1]+188)*pixels.width+state.clientOffset[0]+100+200*i)*4;
   assert.deepEqual([...pixels.data.subarray(at,at+3)],colors[items[i].color],'Screenshot must contain the actual challenge before any model request');
  }
  writeFileSync(join(root,'pixel-gate.json'),JSON.stringify({passed:true,sha256:ref.sha256,width:pixels.width,height:pixels.height,visible:state.visible,foreground:state.foreground}));
  // End the surface after capture; model fetches only the immutable original operation.
  writeFileSync(stopPath,'done');await delay(300);
  const schema={type:'object',additionalProperties:false,required:['code','items','operationId','artifactId'],properties:{code:{type:'string',maxLength:16},items:{type:'array',minItems:3,maxItems:3,items:{type:'object',additionalProperties:false,required:['shape','color'],properties:{shape:{type:'string',enum:['square','circle','triangle']},color:{type:'string',enum:['red','green','blue']}}}},operationId:{type:'string'},artifactId:{type:'string'}}};
  const schemaPath=join(root,'answer-schema.json'),answerPath=join(root,'answer.json'),observerLog=join(root,'mcp-observer.jsonl');writeFileSync(schemaPath,JSON.stringify(schema));
  const prompt=`This is one bounded Reach vision verification. Use only the Reach MCP tools; do not use other tools, files, web, subagents, or command execution. Fetch original operation ${operation.id} with reach_operation, then fetch its PNG artifact ${ref.artifactId} with reach_artifact. Read the seven-character code drawn at the top of that image and list the three colored shapes in left-to-right order. The random code and ordering are only in pixels. Preserve the exact operation/artifact IDs. Return the requested JSON. Stop after at most 6 tool calls; do not retry or submit any action. Keep reasoning and output brief.`;
  writeFileSync(join(root,'prompt.txt'),prompt);
  const config=[['project_doc_max_bytes','0'],['features.shell_tool','false'],['features.view_image','false'],['features.apps','false'],['web_search','"disabled"'],['skills.include_instructions','false'],['skills.max_context_tokens','1'],['model_reasoning_effort','"low"'],['model_provider','"openai_http"'],['model_providers.openai_http.name','"OpenAI (HTTP only)"'],['model_providers.openai_http.wire_api','"responses"'],['model_providers.openai_http.requires_openai_auth','true'],['model_providers.openai_http.supports_websockets','false'],['mcp_servers.reach.command',JSON.stringify(process.execPath)],['mcp_servers.reach.args',JSON.stringify([resolve('tests/fixtures/mcp-observer.ts'),resolve('src/controller/main.ts'),observerLog])],['mcp_servers.reach.env.REACH_CONTROLLER_DIR',JSON.stringify(join(root,'controller'))],['mcp_servers.reach.required','true'],['mcp_servers.reach.startup_timeout_sec','30'],['mcp_servers.reach.tool_timeout_sec','30'],['mcp_servers.reach.enabled_tools','["reach_operation","reach_artifacts","reach_artifact"]']];
  const args=['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--json','--color','never','-C',workspace,'-m','gpt-6.1-sol','--sandbox','read-only','--output-schema',schemaPath,'--output-last-message',answerPath,...config.flatMap(([k,v])=>['-c',k+'='+v]),'-'];
  writeFileSync(join(root,'trial.json'),JSON.stringify({model:'gpt-6.1-sol',auth:'existing ChatGPT CLI login; no credentials copied',maxToolCalls:6,timeoutSeconds:180,modelTokenHardLimitAvailable:false,commandArgs:args},null,2));
  t.signal.throwIfAborted();
  codex=spawn(process.env.REACH_CODEX_BINARY??'codex',args,{windowsHide:true,stdio:'pipe'});
  let stdout='',stderr='';codex.stdout!.on('data',v=>{stdout+=v;writeFileSync(join(root,'codex-events.jsonl'),stdout);});codex.stderr!.on('data',v=>{stderr+=v;writeFileSync(join(root,'codex-stderr.log'),stderr);});
  const ended=new Promise<number|null>((resolve,reject)=>{codex!.on('error',reject);codex!.on('exit',resolve);});
  codex.stdin!.end(prompt);
  let timeout:ReturnType<typeof setTimeout>|undefined;
  const exitCode=await Promise.race([ended,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('Codex trial deadline exceeded')),180000);})]).finally(()=>clearTimeout(timeout));
  assert.equal(exitCode,0,stderr.slice(-5000));
  const answer=JSON.parse(readFileSync(answerPath,'utf8'));assert.equal(answer.code,code);assert.deepEqual(answer.items,items);assert.equal(answer.operationId,operation.id);assert.equal(answer.artifactId,ref.artifactId);
  const observed=readFileSync(observerLog,'utf8').trim().split('\n').map(v=>JSON.parse(v));
  assert.ok(!observed.some(v=>v.event==='call_budget_exceeded'),'No call budget overflow attempt is accepted');
  const calls=observed.filter(v=>v.event==='call');assert.ok(calls.length>0&&calls.length<=6);assert.ok(calls.every(v=>['reach_operation','reach_artifacts','reach_artifact'].includes(v.name)));
  const image=observed.flatMap(v=>v.images??[]).find(v=>v.sha256===ref.sha256);assert.ok(image,'real CLI must receive original PNG via MCP');
  const events=stdout.trim().split('\n').filter(Boolean).map(v=>JSON.parse(v));
  assert.ok(!events.some(v=>['command_execution','web_search','collab_tool_call','file_change','image_view'].includes(v.item?.type)));
  assert.equal((await f.operation(operation.id)).execution,'succeeded');
  receipt={model:'gpt-6.1-sol',operationId:operation.id,artifactId:ref.artifactId,image,answer,toolCalls:calls.length,attempted:calls.length,usage:events.find(v=>v.type==='turn.completed')?.usage,realModel:true,realDesktopCapture:true,trialState:'passed',scope:'image consumption only; not delegated task or installer acceptance'};
  let stopTimer:ReturnType<typeof setTimeout>|undefined;
  await Promise.race([(async()=>{assert.equal((await f.node('host-stop').done).code,0);await runner.done;})(),new Promise<never>((_,reject)=>{stopTimer=setTimeout(()=>reject(Error('Host stop deadline exceeded')),20000);})]).finally(()=>clearTimeout(stopTimer));
 } finally {
  if(codex?.pid&&codex.exitCode===null)spawnSync('taskkill.exe',['/PID',String(codex.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  writeFileSync(stopPath,'stop');await delay(250);await kill(form);writeFileSync(join(root,'surface-stderr.log'),formErrors);
  if(session){cleanupSession??=session.cleanup();await cleanupSession;}
  t.signal.removeEventListener('abort',abort);
  console.log(JSON.stringify({codexVisionEvidence:root}));
 }
 t.signal.throwIfAborted();
 writeFileSync(join(root,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({evidence:root,receipt}));
});
