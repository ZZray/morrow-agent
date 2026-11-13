// Copyright (c) Ray Zhang. Real Node -> HTTP ledger -> Controller MCP -> native desktop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fixture, until, kill, ps, delay } from './native-fixture.ts';

const binary=process.env.REACH_DESKTOP_BIN!, python=process.env.REACH_DESKTOP_PYTHON!;
assert.ok(binary&&python,'Set REACH_DESKTOP_BIN and REACH_DESKTOP_PYTHON to fixed desktop runtime');
const evidence=resolve('work/desktop-chain-'+randomUUID());mkdirSync(evidence,{recursive:true});
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function setup(name:string, pythonPath=python) {
  const root=join(evidence,name);mkdirSync(root,{recursive:true});
  const config=join(root,'desktop.json');
  writeFileSync(config,JSON.stringify({helper:binary,python:pythonPath,config:resolve('desktop/runtime/config.toml')}));
  const f=await fixture('',{...process.env,REACH_DESKTOP_CONFIG:config},root);
  assert.equal((await f.pair()).code,0);assert.equal((await f.loginController()).code,0);
  let runner=f.node('host');
  const mcp=f.mcp();
  const submit=async(name:string,args:any)=>{
    const r=await mcp.call('tools/call',{name,arguments:args});assert.ok(!r.result?.isError,JSON.stringify(r));
    return JSON.parse(r.result.content[0].text);
  };
  const describe=async()=>{
    await until(()=>f.request('/api/v1/nodes'),v=>v.nodes[0]?.capabilities.includes('desktop.describe'));
    const op=await submit('reach_submit',{requestId:randomUUID(),nodeId:f.identity().node_id,command:{kind:'desktop.describe'}});
    const done=await f.settled(op.id);assert.equal(done.execution,'succeeded',JSON.stringify(done));
    const result=JSON.parse(done.result_json);writeFileSync(join(root,`describe-${op.id}.json`),JSON.stringify({operation:done,result},null,2));return result;
  };
  const call=async(info:any,tool:string,args:any={},snapshotId='',wait=true)=>{
    const op=await submit('reach_desktop_call',{requestId:randomUUID(),nodeId:f.identity().node_id,tool,arguments:args,helperGeneration:info.helperGeneration,sessionRef:info.sessionRef,snapshotId});
    if(!wait)return {op};
    const done=await f.settled(op.id),result=JSON.parse(done.result_json);
    writeFileSync(join(root,`${tool}-${op.id}.json`),JSON.stringify({operation:done,result},null,2));return {op,done,result};
  };
  const image=async(op:any,result:any,file:string)=>{
    const ref=result.images[0];assert.ok(ref?.artifactId);
    const response=await mcp.call('tools/call',{name:'reach_artifact',arguments:{operationId:op.id,artifactId:ref.artifactId}});
    assert.ok(!response.result.isError,JSON.stringify(response));
    const part=response.result.content.find((v:any)=>v.type==='image');assert.equal(part.mimeType,'image/png');
    const bytes=Buffer.from(part.data,'base64');assert.equal(sha(bytes),ref.sha256);
    const originals=f.sql(db=>db.prepare("SELECT event_json FROM outbox WHERE operation_id=? ORDER BY sequence").all(op.id).map(v=>JSON.parse(v.event_json as string)).filter(v=>v.data.type==='artifact.chunk').map(v=>Buffer.from(v.data.dataBase64,'base64')));
    assert.deepEqual(bytes,Buffer.concat(originals));writeFileSync(join(root,file),bytes);
    writeFileSync(join(root,file+'.receipt.json'),JSON.stringify({operationId:op.id,artifactId:ref.artifactId,sha256:sha(bytes),bytes:bytes.length,mcpType:part.type}));
  };
  return {...f,root,mcp,describe,call,image,runner:()=>runner,restartNode:async()=>{await kill(runner.child);runner=f.node('host');return runner;},stop:async()=>{const end=await f.node('host-stop').done;assert.equal(end.code,0,JSON.stringify(end));await runner.done;},cleanup:async()=>{writeFileSync(join(root,'node-log.json'),JSON.stringify(runner.logs()));await f.cleanup();}};
}
function labels(result:any) {return result.labels as {name:string,label:number}[];}

test('same desktop generation spans original snapshots, Chinese input and single click; outage/restart uploads original MCP image',{timeout:240000},async()=>{
  const f=await setup('interaction'), statePath=join(f.root,'fixture.json'),stopPath=join(f.root,'fixture.stop');
  const form=spawn(join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('tests/desktop-fixture.ps1'),'-StatePath',statePath,'-StopPath',stopPath,'-Title','Reach Desk Remote '+randomUUID().slice(0,8)],{windowsHide:true,stdio:'pipe'});
  let formLog='';form.stderr.on('data',v=>formLog+=String(v));
  try {
    await until(async()=>existsSync(statePath),Boolean);
    const state=()=>JSON.parse(readFileSync(statePath,'utf8'));
    const info=await f.describe();assert.equal(info.processTreeStopped,false);assert.equal(info.helperRetained,true);
    const region=state().region, args={use_vision:true,use_annotation:false,use_ui_tree:true,region};
    const snap=await f.call(info,'Snapshot',args);assert.equal(snap.done.execution,'succeeded',JSON.stringify(snap.result));await f.image(snap.op,snap.result,'before.png');
    const edit=labels(snap.result).find(v=>v.name==='Reach Test Input');assert.ok(edit);
    const text='Reach Desk 远程中文输入 你好世界';
    const typed=await f.call(info,'Type',{label:edit.label,text,clear:true},snap.result.snapshotId);assert.equal(typed.done.execution,'succeeded',JSON.stringify(typed.result));
    await until(async()=>state(),v=>v.text===text);
    const stale=await f.call(info,'Click',{label:edit.label},snap.result.snapshotId);assert.equal(stale.done.execution,'failed');assert.equal(stale.result.reason,'stale_desktop_snapshot');
    const next=await f.call(info,'Snapshot',args);const button=labels(next.result).find(v=>v.name==='Reach Test Commit');assert.ok(button);
    const wrong=await f.call({...info,helperGeneration:randomUUID()},'Click',{label:button.label},next.result.snapshotId);assert.equal(wrong.done.execution,'failed');assert.equal(state().clicks,0);
    const clicked=await f.call(info,'Click',{label:button.label},next.result.snapshotId);assert.equal(clicked.done.execution,'succeeded');
    await until(async()=>state(),v=>v.clicks===1&&v.committed===text);
    let dropped=false,attempts=0;
    f.intercept(async(request,response,bytes,forward)=>{
      if(request.url!=='/api/v1/node/events')return false;
      const event=JSON.parse(bytes.toString());if(event.data?.type!=='artifact.chunk')return false;
      attempts++;if(!dropped){await (await forward()).arrayBuffer();dropped=true;}response.destroy();return true;
    });
    const upload=await f.call(info,'Screenshot',{region},'',false);
    await until(async()=>dropped,Boolean);
    assert.equal((await f.operation(upload.op.id)).execution,'running');
    const list=await f.request(`/api/v1/operations/${upload.op.id}/artifacts`);assert.equal(list.artifacts[0].complete,false);
    await f.restartService();f.intercept();
    const end=await f.settled(upload.op.id);assert.equal(end.execution,'succeeded',JSON.stringify(end));
    const result=JSON.parse(end.result_json);assert.equal(result.helperGeneration,info.helperGeneration);
    await f.image(upload.op,result,'after.png');
    assert.equal((await f.describe()).helperGeneration,info.helperGeneration);
    assert.equal(state().clicks,1);writeFileSync(join(f.root,'effects.json'),JSON.stringify({...state(),lostChunkAck:true,uploadAttempts:attempts},null,2));
    // A second upload survives loss of the Node itself, keeping original outbox bytes.
    dropped=false;
    f.intercept(async(request,response,bytes,forward)=>{
      if(request.url!=='/api/v1/node/events'||JSON.parse(bytes.toString()).data?.type!=='artifact.chunk')return false;
      if(!dropped){await(await forward()).arrayBuffer();dropped=true;}response.destroy();return true;
    });
    const recovered=await f.call(info,'Screenshot',{region},'',false);
    await until(async()=>dropped,Boolean);
    await until(async()=>f.sql(db=>(db.prepare('SELECT status FROM operations WHERE id=?').get(recovered.op.id) as any).status),v=>v==='succeeded');
    await f.restartNode();f.intercept();
    const restored=await f.settled(recovered.op.id);assert.equal(restored.execution,'succeeded');
    await f.image(recovered.op,JSON.parse(restored.result_json),'node-recovered.png');assert.throws(()=>process.kill(info.helperPid,0));
    const replacement=await f.describe();assert.notEqual(replacement.helperGeneration,info.helperGeneration);
    await until(async()=>f.sql(db=>(db.prepare('SELECT count(*) AS n FROM outbox WHERE acknowledged=0').get() as any).n),v=>v===0);
    const maintenance=await f.node('maintenance-stop').done;assert.equal(maintenance.code,0,JSON.stringify(maintenance));await f.runner().done;
    assert.throws(()=>process.kill(replacement.helperPid,0));
    writeFileSync(join(f.root,'maintenance.json'),JSON.stringify({exitCode:maintenance.code,helperStopped:true,recoveredOperation:restored.id}));
  } finally { writeFileSync(stopPath,'stop');await delay(500);await kill(form);writeFileSync(join(f.root,'fixture.log'),formLog);await f.cleanup(); }
});

test('cancel, Node crash and failed capture retire the actual helper and never replay effects',{timeout:240000},async()=>{
  const f=await setup('failures');
  try {
    let info=await f.describe();
    for(const mode of ['cancel','node-crash'] as const){
      const shot=await f.call(info,'Screenshot',{region:[0,0,32,32]});assert.equal(shot.done.execution,'succeeded');
      const began=join(f.root,mode+'-began.txt'),ended=join(f.root,mode+'-ended.txt');
      const action=await f.call(info,'PowerShell',{command:`[IO.File]::AppendAllText(${ps(began)},'once'); Start-Sleep -Seconds 15; [IO.File]::WriteAllText(${ps(ended)},'ended')`,timeout:30},shot.result.snapshotId,false);
      await until(async()=>existsSync(began),Boolean);
      if(mode==='cancel')await f.request(`/api/v1/operations/${action.op.id}/cancel`,'POST',{});else await f.restartNode();
      const end=await f.settled(action.op.id);assert.equal(end.execution,'unknown');
      await until(async()=>{try{process.kill(info.helperPid,0);return false;}catch{return true;}},Boolean);
      assert.equal(readFileSync(began,'utf8'),'once');assert.equal(existsSync(ended),false);
      if(mode==='cancel')assert.equal(JSON.parse(end.result_json).processTreeStopped,true);
      const old=await f.call(info,'Screenshot',{region:[0,0,32,32]});assert.equal(old.done.execution,'failed');assert.equal(old.result.reason,'desktop_generation_unavailable');
      const previous=info;info=await f.describe();assert.notEqual(info.helperGeneration,previous.helperGeneration);
      writeFileSync(join(f.root,mode+'-effects.json'),JSON.stringify({operation:end,began:readFileSync(began,'utf8'),ended:false,oldGeneration:previous.helperGeneration,newGeneration:info.helperGeneration}));
    }
    // Backend schema rejects the unknown parameter, but only after Rust has verified
    // the exact outer payload hash and parsed the nested Unicode/exponent JSON.
    const probe={region:[0,0,32,32],transportProbe:{'😀':{'中':1e-6,'𐀀':[1e21,1e-8],'\ue000':'原文'}}};
    const wire=await f.call(info,'Screenshot',probe);assert.equal(wire.done.execution,'failed');assert.match(wire.result.error,/Unexpected keyword argument/);
    const raw=f.sql(db=>JSON.parse((db.prepare('SELECT dispatch_json FROM operations WHERE id=?').get(wire.op.id) as any).dispatch_json));
    assert.equal(raw.command.argumentsJson,JSON.stringify(probe));assert.equal(wire.result.processTreeStopped,true);
    writeFileSync(join(f.root,'wire-probe.json'),JSON.stringify({argumentsJson:raw.command.argumentsJson,payloadHash:raw.payloadHash,result:wire.result},null,2));
    info=await f.describe();
    const failure=await f.call(info,'Screenshot',{region:[-999999,-999999,-999998,-999998]});
    assert.equal(failure.done.execution,'failed');assert.equal(failure.result.processTreeStopped,true);assert.equal(failure.result.helperRetained,false);assert.throws(()=>process.kill(info.helperPid,0));
    const replacement=await f.describe();assert.notEqual(replacement.helperGeneration,info.helperGeneration);
    await f.stop();assert.throws(()=>process.kill(replacement.helperPid,0));
  }finally{await f.cleanup();}
});

test('original long desktop text survives lost ACK and both processes restarting without replay', {timeout:240000}, async()=>{
  const f=await setup('full-text');
  try {
    const info=await f.describe();
    const shot=await f.call(info,'Screenshot',{region:[0,0,32,32]});assert.equal(shot.done.execution,'succeeded');
    const effect=join(f.root,'text-action-count.txt');let dropped=false;
    f.intercept(async(request,response,bytes,forward)=>{
      if(request.url!=='/api/v1/node/events'||JSON.parse(bytes.toString()).data?.type!=='artifact.chunk')return false;
      if(!dropped){await(await forward()).arrayBuffer();dropped=true;}response.destroy();return true;
    });
    const unit=Buffer.from('原始全文😀e\u0301\r\n').toString('base64');
    const action=await f.call(info,'PowerShell',{command:`[IO.File]::AppendAllText(${ps(effect)},'once'); $part=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${unit}')); [Console]::Out.Write($part * 18000)`,timeout:30},shot.result.snapshotId,false);
    await until(async()=>dropped,Boolean);
    await until(async()=>f.sql(db=>(db.prepare('SELECT status FROM operations WHERE id=?').get(action.op.id) as any).status),v=>v==='succeeded');
    const partial=await f.request(`/api/v1/operations/${action.op.id}/artifacts`);assert.equal(partial.artifacts[0].complete,false);
    await f.restartNode();await f.restartService();f.intercept();
    const done=await f.settled(action.op.id);assert.equal(done.execution,'succeeded',JSON.stringify(done));
    const result=JSON.parse(done.result_json);const ref=result.artifacts.find((v:any)=>v.mimeType==='text/plain');assert.ok(ref);
    const original=readFileSync(result.details.full_result_path);assert.ok(original.length>65536);assert.ok(original.toString('utf8').includes('原始全文😀'));
    assert.equal(sha(original),result.details.full_result_sha256);assert.equal(original.length,result.details.full_result_bytes);
    const saved=join(f.root,'downloaded-original.txt');const downloaded=await f.controller(['artifact',action.op.id,ref.artifactId,'--output',saved]).done;
    assert.equal(downloaded.code,0,JSON.stringify(downloaded));assert.deepEqual(readFileSync(saved),original);
    const existing=await f.controller(['artifact',action.op.id,ref.artifactId,'--output',saved]).done;assert.notEqual(existing.code,0);assert.deepEqual(readFileSync(saved),original);
    const response=await f.mcp.call('tools/call',{name:'reach_artifact',arguments:{operationId:action.op.id,artifactId:ref.artifactId}});assert.ok(!response.result.isError,JSON.stringify(response));
    const range=JSON.parse(response.result.content[0].text);assert.equal(range.eof,false);assert.deepEqual(Buffer.from(range.dataBase64,'base64'),original.subarray(0,65536));
    const next=await f.mcp.call('tools/call',{name:'reach_artifact_range',arguments:{operationId:action.op.id,artifactId:ref.artifactId,offset:range.nextOffset,length:4096}});assert.ok(!next.result.isError,JSON.stringify(next));
    assert.deepEqual(Buffer.from(JSON.parse(next.result.content[0].text).dataBase64,'base64'),original.subarray(65536,69632));
    assert.equal(readFileSync(effect,'utf8'),'once');assert.throws(()=>process.kill(info.helperPid,0));
    writeFileSync(join(f.root,'full-text-evidence.json'),JSON.stringify({operationId:action.op.id,artifactId:ref.artifactId,sha256:sha(original),bytes:original.length,source:result.details.full_result_path,lostAck:true,nodeRestarted:true,serviceRestarted:true,effectCount:readFileSync(effect,'utf8')},null,2));
    await f.stop();
  }finally{await f.cleanup();}
});

test.after(()=>console.log(JSON.stringify({desktopChainEvidence:evidence})));

test('long MCP isError text survives restart while snapshot fails and actions stay unknown', {timeout:240000}, async()=>{
  const f=await setup('error-text');
  try {
    const receipts:any[]=[];
    for(const tool of ['Screenshot','PowerShell']) {
      const info=await f.describe();
      const shot=tool==='PowerShell'?await f.call(info,'Screenshot',{region:[0,0,32,32]}):undefined;
      if(shot)assert.equal(shot.done.execution,'succeeded');
      // Real Windows-MCP schema error: its diagnostic includes the entire key.
      const key='原始错误😀e\u0301'.repeat(6000);
      const args={...(tool==='Screenshot'?{region:[0,0,32,32]}:{command:'Write-Output unused'}),[key]:true};
      const requestId=randomUUID();
      const command={kind:'desktop.call',tool,argumentsJson:JSON.stringify(args),helperGeneration:info.helperGeneration,sessionRef:info.sessionRef,snapshotId:shot?.result.snapshotId??''};
      let dropped=false;
      f.intercept(async(request,response,bytes,forward)=>{
        if(request.url!=='/api/v1/node/events'||JSON.parse(bytes.toString()).data?.type!=='artifact.chunk')return false;
        if(!dropped){await(await forward()).arrayBuffer();dropped=true;}response.destroy();return true;
      });
      const op=await f.submit(command,requestId),expected=tool==='Screenshot'?'failed':'unknown';
      await until(async()=>dropped,Boolean);
      await until(async()=>f.sql(db=>(db.prepare('SELECT status FROM operations WHERE id=?').get(op.id) as any).status),v=>v===expected);
      await f.restartNode();await f.restartService();f.intercept();
      const done=await f.settled(op.id);assert.equal(done.execution,expected,JSON.stringify(done));
      const result=JSON.parse(done.result_json);assert.equal(result.backendIsError,true);assert.equal(result.snapshotId,'');
      assert.equal(result.processTreeStopped,true);assert.equal(result.effectsMayHaveOccurred,tool==='PowerShell');
      assert.ok(result.error.includes('characters omitted'));assert.equal(result.helperGeneration,info.helperGeneration);
      const ref=result.artifacts.find((v:any)=>v.mimeType==='text/plain');assert.ok(ref,JSON.stringify(result));
      const original=readFileSync(result.details.full_result_path);assert.ok(original.toString('utf8').includes(key));
      assert.equal(sha(original),result.details.full_result_sha256);
      const file=join(f.root,tool+'-error.txt');const download=await f.controller(['artifact',op.id,ref.artifactId,'--output',file]).done;
      assert.equal(download.code,0,JSON.stringify(download));assert.deepEqual(readFileSync(file),original);
      const response=await f.mcp.call('tools/call',{name:'reach_artifact_range',arguments:{operationId:op.id,artifactId:ref.artifactId,offset:65000,length:4096}});
      assert.ok(!response.result.isError,JSON.stringify(response));
      assert.deepEqual(Buffer.from(JSON.parse(response.result.content[0].text).dataBase64,'base64'),original.subarray(65000,69096));
      const before=await f.events(op.id);assert.ok(!before.some(v=>v.kind==='succeeded'));
      assert.equal((await f.submit(command,requestId)).id,op.id);assert.deepEqual(await f.events(op.id),before);
      assert.throws(()=>process.kill(info.helperPid,0));
      receipts.push({operationId:op.id,artifactId:ref.artifactId,status:expected,bytes:original.length,sha256:sha(original),result,lostAck:true,bothRestarted:true,requestRetryUnchanged:true});
    }
    writeFileSync(join(f.root,'error-receipts.json'),JSON.stringify(receipts,null,2));
    await f.stop();
  } finally { await f.cleanup(); }
});

test('long MCP error with an unavailable results directory remains failed without complete evidence', {timeout:120000}, async()=>{
  const f=await setup('error-save-failure');
  try {
    const info=await f.describe();
    const directory=join(f.state,'desktop-results','results',info.helperGeneration);
    // This known empty fixture directory is replaced by a file; production source is untouched.
    rmdirSync(directory);writeFileSync(directory,'injected non-directory');
    const failed=await f.call(info,'Screenshot',{region:[0,0,32,32],['错误'.repeat(7000)]:true});
    assert.equal(failed.done.execution,'failed');assert.equal(failed.result.backendIsError,true);
    assert.equal(failed.result.details.truncated,true);assert.equal(failed.result.snapshotId,'');
    assert.match(failed.result.evidenceError,/not saved/);assert.ok(failed.result.error.includes('characters omitted'));
    assert.equal((await f.request(`/api/v1/operations/${failed.op.id}/artifacts`)).artifacts.length,0);
    assert.equal(failed.result.processTreeStopped,true);assert.equal(readFileSync(directory,'utf8'),'injected non-directory');
    writeFileSync(join(f.root,'save-failure.json'),JSON.stringify(failed,null,2));
    await f.stop();
  } finally { await f.cleanup(); }
});

test('large structured MCP error crosses the actual helper and ledger without overflowing terminal metadata', {timeout:120000}, async()=>{
  // Isolated stdio fault server with the fixed Python interpreter; no runtime mutation.
  const runtime=join(evidence,'structured-error-runtime');mkdirSync(join(runtime,'windows_mcp'),{recursive:true});
  for(const file of ['python.exe','python314.dll','python314.zip','vcruntime140.dll','vcruntime140_1.dll'])copyFileSync(join(dirname(python),file),join(runtime,file));
  writeFileSync(join(runtime,'python314._pth'),'python314.zip\n.\n');
  writeFileSync(join(runtime,'windows_mcp','__init__.py'),'');
  copyFileSync(resolve('tests/fixtures/error-mcp.py'),join(runtime,'windows_mcp','__main__.py'));
  const f=await setup('structured-error',join(runtime,'python.exe'));
  try {
    const receipts:any[]=[];
    for (const mode of ['structured','labels']) {
    const info=await f.describe();
    const failed=await f.call(info,'Screenshot',{mode});
    assert.equal(failed.done.execution,'failed',JSON.stringify(failed.result));
    assert.equal(failed.result.backendIsError,true);assert.equal(failed.result.snapshotId,'');
    assert.equal(failed.result.details.structuredContent,undefined);
    assert.equal(failed.result.labels,null);
    assert.ok(Buffer.byteLength(JSON.stringify(failed.result))<40000);
    const original=Buffer.from(mode==='structured'?'structuredContent: '+JSON.stringify({message:'结构😀\r\n'.repeat(90000)}):'诊断\nReach UI Labels: '+JSON.stringify([{name:'x'.repeat(1_100_000)}]));
    const ref=failed.result.artifacts[0];assert.ok(ref);
    const file=join(f.root,mode+'-original.txt');const download=await f.controller(['artifact',failed.op.id,ref.artifactId,'--output',file]).done;
    assert.equal(download.code,0,JSON.stringify(download));assert.deepEqual(readFileSync(file),original);
    assert.equal(sha(original),ref.sha256);
    assert.equal(failed.result.processTreeStopped,true);
    receipts.push({operationId:failed.op.id,artifactId:ref.artifactId,mode,bytes:original.length,sha256:sha(original),status:'failed',backend:'controlled stdio fault server',result:failed.result});
    }
    assert.equal(readFileSync(join(runtime,'calls.log'),'utf8').trim().split('\n').length,2);
    writeFileSync(join(f.root,'structured-receipt.json'),JSON.stringify({receipts,calls:2},null,2));
    await f.stop();
  } finally { await f.cleanup(); }
});
