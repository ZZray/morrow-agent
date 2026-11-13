// Copyright (c) Ray Zhang. Real helper + Windows-MCP + independent WinForms effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const binary = process.env.REACH_DESKTOP_BIN!;
const python = process.env.REACH_DESKTOP_PYTHON!;
const root = resolve('work', `desktop-native-${randomUUID()}`);
async function until<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeout = 15000): Promise<T> {
  const end = Date.now() + timeout;
  let last: unknown;
  do { try { const value = await fn(); if (predicate(value)) return value; last = value; } catch(e) { last=e; } await delay(100); } while(Date.now()<end);
  throw new Error(`condition timed out: ${String(last)}`);
}
async function host(name: string) {
  const dir=join(root,name); await mkdir(dir,{recursive:true});
  const child=spawn(binary,['--development','--python',python,'--config',resolve('desktop/runtime/config.toml'),'--results',dir],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const frames:any[]=[]; let stderr='';
  child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-64000)});
  child.stdin.on('error',()=>{}); // A deliberately crashed worker may close its pipe first.
  const exited=new Promise<number|null>(r=>child.once('exit',r));
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{ frames.push(JSON.parse(line)); });
  const next=async()=>until(async()=>frames.shift(),v=>v!==undefined,80000);
  const ready=await next(); assert.equal(ready.event,'desktop_host_ready',stderr);
  const raw=(v:any)=>child.stdin.write(JSON.stringify(v)+'\n');
  const send=(v:any)=>raw({id:randomUUID(),helperGeneration:ready.helperGeneration,sessionRef:ready.sessionRef,...v});
  send({method:'start'}); const started=await next(); assert.equal(started.status,'succeeded',stderr);
  await writeFile(join(dir,'tools.json'),JSON.stringify(started,null,2));
  const call=async(tool:string,args:any={},snapshotId='')=>{
    send({method:'call',tool,arguments:args,snapshotId});
    const result=await next();
    await writeFile(join(dir,`${tool}-${result.id}.json`),JSON.stringify(result));
    return result;
  };
  const finish=async(expectedCode=0)=>{
    const code=await Promise.race([exited,delay(20000,undefined,{ref:false}).then(()=>{if(child.exitCode===null)child.kill();throw new Error('desktop host did not exit')})]);
    await writeFile(join(dir,'stderr.log'),stderr);
    assert.equal(code,expectedCode,stderr);
    const settled=await until(async()=>frames.find(v=>v.event==='desktop_host_exited'),v=>!!v,3000);
    assert.equal(settled.processTreeEmpty,true);
    await writeFile(join(dir,'settlement.json'),JSON.stringify(settled));
  };
  const stop=async()=>{
    if(child.exitCode===null&&!frames.some(v=>v.event==='desktop_host_exited')){send({method:'stop'});child.stdin.end();}
    await finish();
  };
  return {child,ready,started,call,send,next,exited,stop,finish,dir,frames};
}
function labels(snapshot:any) {
  const text=snapshot.content.filter((v:any)=>v.type==='text').map((v:any)=>v.text).join('\n');
  const match=text.match(/Reach UI Labels: ([^\r\n]+)/);
  assert.ok(match,'snapshot must expose exact backend labels');
  return JSON.parse(match[1]) as any[];
}
async function image(snapshot:any,path:string) {
  assert.equal(snapshot.status,'succeeded',JSON.stringify(snapshot));
  assert.equal(snapshot.images.length,1);
  const info=snapshot.images[0], part=snapshot.content[info.contentIndex];
  const bytes=Buffer.from(part.data,'base64');
  assert.equal(part.mimeType,'image/png'); assert.equal(info.bytes,bytes.length);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),info.sha256);
  assert.equal(bytes.readUInt32BE(16),info.width); assert.equal(bytes.readUInt32BE(20),info.height);
  await writeFile(path,bytes);
}

test('actual Windows capture, Chinese input, click, identity guards and process settlement',{timeout:240000},async()=>{
  assert.ok(binary&&python,'explicit REACH_DESKTOP_BIN and REACH_DESKTOP_PYTHON required');
  await mkdir(root,{recursive:true});
  const statePath=join(root,'fixture.json'),stopPath=join(root,'fixture.stop');
  const fixture=spawn(join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('tests/desktop-fixture.ps1'),'-StatePath',statePath,'-StopPath',stopPath,'-Title',`Reach Verification ${randomUUID().slice(0,8)}`],{windowsHide:true,stdio:'pipe'});
  let fixtureError=''; fixture.stderr.on('data',b=>fixtureError+=b.toString());
  const fixtureExited=new Promise(r=>fixture.once('exit',r));
  const state=async()=>JSON.parse(await readFile(statePath,'utf8'));
  let h:Awaited<ReturnType<typeof host>>|undefined;
  try {
    const initial=await until(state,v=>v.clicks===0);
    h=await host('interaction');
    const args={use_vision:true,use_annotation:false,use_ui_tree:true,region:initial.region};
    let snap=await h.call('Snapshot',args); await image(snap,join(root,'before.png'));
    const edit=labels(snap).find(v=>v.name==='Reach Test Input'); assert.ok(edit,'fixture input not in UI tree');
    const text='Reach Desk 中文输入验证 你好世界';
    const staleId=snap.snapshotId;
    const typed=await h.call('Type',{label:edit.label,text,clear:true},snap.snapshotId); assert.equal(typed.status,'succeeded',JSON.stringify(typed));
    await until(state,v=>v.text===text);
    const stale=await h.call('Click',{label:edit.label},staleId); assert.equal(stale.reason,'stale_desktop_snapshot'); assert.equal(stale.effectsMayHaveOccurred,false);
    snap=await h.call('Snapshot',args); const commit=labels(snap).find(v=>v.name==='Reach Test Commit'); assert.ok(commit);
    h.send({method:'call',tool:'Click',arguments:{label:commit.label},snapshotId:snap.snapshotId,helperGeneration:randomUUID()});
    assert.equal((await h.next()).reason,'desktop_identity_mismatch');
    h.send({method:'call',tool:'Click',arguments:{label:commit.label},snapshotId:snap.snapshotId,sessionRef:{...h.ready.sessionRef,logonId:'wrong-logon'}});
    assert.equal((await h.next()).reason,'desktop_identity_mismatch');
    assert.equal((await state()).clicks,0);
    const clicked=await h.call('Click',{label:commit.label},snap.snapshotId); assert.equal(clicked.status,'succeeded',JSON.stringify(clicked));
    await until(state,v=>v.clicks===1&&v.committed===text);
    const shot=await h.call('Screenshot',{region:initial.region}); await image(shot,join(root,'after.png'));
    assert.equal(shot.labelsAvailable,false);
    const invalidLabel=await h.call('Click',{label:commit.label},shot.snapshotId); assert.equal(invalidLabel.reason,'stale_desktop_snapshot');
    const final=await state(); assert.equal(final.clicks,1); assert.equal(final.committed,text);
    await writeFile(join(root,'effects.json'),JSON.stringify(final,null,2));
    await h.stop(); h=undefined;
    console.log(JSON.stringify({evidence:root,actualInput:text,actualClickCount:final.clicks}));
  } finally {
    if(h) await h.stop();
    await writeFile(stopPath,'stop'); await Promise.race([fixtureExited,delay(5000)]);
    if(fixture.exitCode===null)fixture.kill();
    await writeFile(join(root,'fixture-stderr.log'),fixtureError);
  }
});

for(const mode of ['stop','eof','worker-crash'] as const) test(`in-flight ${mode} closes the real backend tree without completing delayed effects`,{timeout:90000},async()=>{
  const h=await host(mode);
  const began=join(h.dir,'began.txt'),ended=join(h.dir,'ended.txt');
  const ps=(s:string)=>"'"+s.replaceAll("'","''")+"'";
  try {
    const shot=await h.call('Screenshot',{region:[0,0,32,32]}); assert.equal(shot.status,'succeeded');
    const id=randomUUID();
    h.send({method:'call',id,tool:'PowerShell',snapshotId:shot.snapshotId,arguments:{command:`[IO.File]::WriteAllText(${ps(began)},'began'); Start-Sleep -Seconds 12; [IO.File]::WriteAllText(${ps(ended)},'ended')`,timeout:30}});
    await until(()=>readFile(began,'utf8'),v=>v==='began');
    const start=Date.now();
    if(mode==='stop')h.send({method:'stop'});
    else if(mode==='eof')h.child.stdin.end();
    else process.kill(h.ready.pid);
    if(mode!=='worker-crash'){
      const result=await h.next(); assert.equal(result.id,id); assert.equal(result.status,'unknown'); assert.equal(result.effectsMayHaveOccurred,true);
      await writeFile(join(h.dir,'interrupted.json'),JSON.stringify(result));
    }
    await h.finish(mode==='worker-crash'?1:0);
    assert.ok(Date.now()-start<10000,'cancellation waited for the 12-second action');
    await assert.rejects(readFile(ended));
    await writeFile(join(h.dir,'effects.json'),JSON.stringify({began:true,ended:false,elapsedMs:Date.now()-start,mode}));
  }finally{ if(h.child.exitCode===null)await h.stop(); }
});

test('capture and backend parameter errors retire the helper without a success receipt',{timeout:90000},async()=>{
  const invalid=await host('capture-error');
  const capture=await invalid.call('Screenshot',{region:[-999999,-999999,-999998,-999998]});
  assert.equal(capture.status,'failed'); assert.equal(capture.snapshotId,'');
  await invalid.finish();
  const h=await host('parameter-error');
  const shot=await h.call('Screenshot',{region:[0,0,32,32]});
  const error=await h.call('Clipboard',{mode:'set'},shot.snapshotId); // Rejected before clipboard mutation.
  assert.equal(error.status,'unknown'); assert.ok(error.error); await h.finish();
});

test('real file, shell, registry and scroll failures are never successful tool receipts',{timeout:120000},async()=>{
  for(const mode of ['write-directory','delete-missing','shell-partial','registry-missing','scroll-axis'] as const){
    const h=await host(mode);
    try {
      const shot=await h.call('Screenshot',{region:[0,0,32,32]});
      let tool:string, args:any;
      const marker=join(h.dir,'partial.txt');
      if(mode==='write-directory'){tool='FileSystem';args={mode:'write',path:h.dir,content:'cannot overwrite directory'};}
      else if(mode==='delete-missing'){tool='FileSystem';args={mode:'delete',path:join(h.dir,'does-not-exist')};}
      else if(mode==='shell-partial'){tool='PowerShell';args={command:`[IO.File]::WriteAllText('${marker.replaceAll("'","''")}','partial'); exit 7`};}
      else if(mode==='registry-missing'){tool='Registry';args={mode:'get',path:`HKCU:\\Software\\RYReachTestMissing-${randomUUID()}`,name:'missing'};}
      else{tool='Scroll';args={type:'vertical',direction:'left'};}
      const result=await h.call(tool,args,shot.snapshotId);
      assert.equal(result.status,'unknown',JSON.stringify(result)); assert.ok(result.error);
      await h.finish();
      if(mode==='shell-partial')assert.equal(await readFile(marker,'utf8'),'partial');
    } finally { if(h.child.exitCode===null)await h.stop(); }
  }
});
