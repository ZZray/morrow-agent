// Copyright (c) Ray Zhang. Persistent Desk lock/close-intent races, without a model.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DeskStore,settlementState} from '../src/store.ts';
import type {CloseIntent} from '../src/store.ts';

function fixture(){const root=resolve('work/desk-store-'+randomUUID());mkdirSync(root,{recursive:true});const file=join(root,'desk.sqlite'),store=new DeskStore(file),conversation=randomUUID(),id=randomUUID();store.create('user',conversation,'原会话','route');store.admit('user',conversation,id,'原消息','login','route');console.log(JSON.stringify({deskStoreEvidence:root}));return {root,file,store,conversation,id};}
function intent(root:string):CloseIntent{return {declarationPath:join(root,'declaration.json'),declarationSha256:'a'.repeat(64),binaryPath:process.execPath,binarySha256:'b'.repeat(64)};}
const joined={output:'已保留的片段',reason:'Cancelled',result:{originalStop:'Cancelled',taskAccepted:false}};
function crashedClose(store:DeskStore){store.db.prepare('UPDATE lease SET pid=2147483647').run();store.db.close();}

test('v1 migration preserves legacy blocked and interrupted partial output without inventing a declaration',()=>{
  const root=resolve('work/desk-store-v1-'+randomUUID());mkdirSync(root,{recursive:true});const file=join(root,'desk.sqlite'),db=new DatabaseSync(file);
  db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL,route_hash TEXT NOT NULL,blocked INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    CREATE TABLE turns(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(id),content TEXT NOT NULL,request_hash TEXT NOT NULL,task_id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL UNIQUE,session_hash TEXT NOT NULL,status TEXT NOT NULL,output TEXT NOT NULL DEFAULT '',cancel_requested INTEGER NOT NULL DEFAULT 0,reason TEXT,result_json TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE events(turn_id TEXT NOT NULL REFERENCES turns(id),seq INTEGER NOT NULL,kind TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(turn_id,seq));PRAGMA user_version=1;`);
  const legacy=randomUUID(),active=randomUUID(),id=randomUUID();
  for(const [conversation,blocked] of [[legacy,1],[active,0]] as const)db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?)').run(conversation,'user','保留','route',blocked,1);
  db.prepare('INSERT INTO turns VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'user',active,'原消息','hash','task','run','login','running','原始片段',0,null,null,1);
  db.close();const store=new DeskStore(file);
  try{
    const old=store.conversation('user',legacy);assert.equal(old.blocked,1);assert.equal(old.blocker_task_id,null);assert.equal(old.declaration_sha,null);assert.equal(old.settlement_revision,1);
    assert.throws(()=>store.admit('user',legacy,randomUUID(),'不能误放行','login','route'),/尚未结算/);
    const recovered=store.turn('user',id);assert.equal(recovered.status,'unknown');assert.equal(recovered.output,'原始片段');assert.equal(recovered.task_id,'task');assert.equal(recovered.close_intent_json,null);
    assert.deepEqual(store.pendingSettlements(),[]);assert.equal(store.conversation('user',active).blocker_task_id,'task');
    const event=JSON.parse(store.events('user',id,0).at(-1)!.data_json);assert.deepEqual(event.conversation,settlementState(store.conversation('user',active)));assert.equal(event.sessionBlocked,true);
    writeFileSync(join(root,'verified.json'),JSON.stringify({legacy:old,recovered,event},null,2));console.log(JSON.stringify({deskStoreMigrationEvidence:root}));
  }finally{store.close();}
});

test('close intent survives a real process exit and keeps its revision and attempt budget',()=>{
  const root=resolve('work/desk-store-restart-'+randomUUID());mkdirSync(root,{recursive:true});const file=join(root,'desk.sqlite'),ids={conversation:randomUUID(),id:randomUUID()},decl=intent(root),script=join(root,'child.mjs');
  writeFileSync(script,`import {DeskStore} from ${JSON.stringify(pathToFileURL(resolve('platform/src/store.ts')).href)};const s=new DeskStore(${JSON.stringify(file)});const v=${JSON.stringify(ids)};s.create('user',v.conversation,'同会话','route');s.admit('user',v.conversation,v.id,'原消息','login','route');s.cancel('user',v.id,'user_requested');const t=s.beginSettlement(v.id,${JSON.stringify(decl)},${JSON.stringify(joined)});s.claimSettlement(v.id,t,2);console.log(JSON.stringify({token:t,turn:s.turn('user',v.id)}));`);
  const child=spawnSync(process.execPath,[script],{windowsHide:true,encoding:'utf8'});writeFileSync(join(root,'child-stdout.log'),child.stdout);writeFileSync(join(root,'child-stderr.log'),child.stderr);assert.equal(child.status,0,child.stderr);
  const original=JSON.parse(child.stdout),store=new DeskStore(file);
  try{
    const turn=store.turn('user',ids.id);assert.equal(turn.status,'cancelling');assert.equal(turn.close_attempts,1);assert.equal(turn.output,joined.output);assert.deepEqual(store.settlementToken(turn),original.token);assert.deepEqual(JSON.parse(turn.close_intent_json!),decl);
    assert.throws(()=>new DeskStore(file),/正在使用/);assert.equal((store.db.prepare('PRAGMA user_version').get() as any).user_version,3);
    assert.equal(store.claimSettlement(ids.id,original.token,2),2);assert.equal(store.claimSettlement(ids.id,original.token,2),null);
    assert.deepEqual(store.beginSettlement(ids.id,decl,{...joined,output:'不能覆盖原文'}),original.token);assert.equal(store.turn('user',ids.id).output,joined.output);
    assert.throws(()=>store.beginSettlement(ids.id,{...decl,declarationSha256:'c'.repeat(64)},joined),/已固定/);
    writeFileSync(join(root,'verified.json'),JSON.stringify({original,recovered:turn,final:store.turn('user',ids.id)},null,2));console.log(JSON.stringify({deskStoreRestartEvidence:root}));
  }finally{store.close();}
});

test('release matches Task, revision and declaration together; late old completions cannot alter a newer blocker',()=>{
  const f=fixture();const {store,id,conversation}=f;
  try{
    store.cancel('user',id,'user_requested');const token=store.beginSettlement(id,intent(f.root),joined);
    assert.equal(store.completeSettlement(id,token,{fixture:'unclaimed'}),false);assert.equal(store.claimSettlement(id,token,2),1);
    for(const wrong of [{...token,taskId:randomUUID()},{...token,revision:token.revision+1},{...token,declarationSha256:'c'.repeat(64)}]){
      assert.equal(store.completeSettlement(id,wrong,{fixture:'wrong identity'}),false);assert.equal(store.failSettlement(id,wrong,{}),false);assert.equal(store.claimSettlement(id,wrong,2),null);
    }
    assert.throws(()=>store.finish(id,'cancelled','','wrong path',null,false),/settlement completion/);
    assert.throws(()=>store.admit('user',conversation,randomUUID(),'收尾时不能发送','login','route'),/尚未结算/);
    assert.equal(store.admit('user',conversation,id,'原消息','login','route').fresh,false);
    assert.equal(store.completeSettlement(id,token,{fixture:'validated by Host before this call'}),true);
    const released=store.conversation('user',conversation);assert.equal(released.blocked,0);assert.equal(released.settlement_revision,token.revision+1);assert.equal(store.turn('user',id).status,'cancelled');
    const oldEvents=store.events('user',id,0).length,next=randomUUID();store.admit('user',conversation,next,'后续消息','login','route');store.finish(next,'unknown','','new failure',null,true);
    const newer=store.conversation('user',conversation);assert.ok(newer.settlement_revision>released.settlement_revision);assert.notEqual(newer.blocker_task_id,token.taskId);
    assert.equal(store.completeSettlement(id,token,{fixture:'late duplicate'}),false);assert.equal(store.finish(id,'completed','late old output',null,null,true),false);assert.deepEqual(store.conversation('user',conversation),newer);assert.equal(store.events('user',id,0).length,oldEvents);
    writeFileSync(join(f.root,'verified.json'),JSON.stringify({released,newer,old:store.turn('user',id),events:store.events('user',id,0)},null,2));
  }finally{store.close();}
});

test('exhausted attempts remain blocked after restart and do not invent a successful cancellation',()=>{
  const f=fixture();let store=f.store;
  try{
    store.cancel('user',f.id,'user_requested');const token=store.beginSettlement(f.id,intent(f.root),joined);assert.equal(store.claimSettlement(f.id,token,2),1);assert.equal(store.claimSettlement(f.id,token,2),2);
    crashedClose(store);store=new DeskStore(f.file);assert.equal(store.claimSettlement(f.id,token,2),null);assert.equal(store.turn('user',f.id).close_attempts,2);
    assert.equal(store.failSettlement(f.id,token,{delivery:'unknown'}),true);const failed=store.turn('user',f.id);assert.equal(failed.status,'cancelled');assert.equal(failed.output,joined.output);assert.equal(store.conversation('user',f.conversation).blocked,1);assert.equal(store.pendingSettlements().length,0);
    const terminal=JSON.parse(store.events('user',f.id,0).at(-1)!.data_json);assert.equal(terminal.status,'cancelled');assert.equal(terminal.sessionBlocked,true);assert.equal(terminal.taskAccepted,false);
    crashedClose(store);store=new DeskStore(f.file);assert.equal(store.turn('user',f.id).close_attempts,2);assert.equal(store.conversation('user',f.conversation).blocked,1);assert.deepEqual(store.pendingSettlements(),[]);
  }finally{store.close();}
});

test('settlement and terminal events roll back with conversation and turn updates',()=>{
  const f=fixture();const {store,id,conversation}=f;
  try{
    store.cancel('user',id,'user_requested');const before=store.conversation('user',conversation),events=store.events('user',id,0);
    assert.throws(()=>store.transaction(()=>{store.beginSettlement(id,intent(f.root),joined);throw Error('publication failed');}),/publication failed/);
    assert.deepEqual(store.conversation('user',conversation),before);assert.equal(store.turn('user',id).close_intent_json,null);assert.deepEqual(store.events('user',id,0),events);
    const token=store.beginSettlement(id,intent(f.root),joined);store.claimSettlement(id,token,2);
    assert.throws(()=>store.transaction(()=>{assert.equal(store.completeSettlement(id,token,{}),true);throw Error('commit failed');}),/commit failed/);
    assert.equal(store.turn('user',id).status,'cancelling');assert.equal(store.conversation('user',conversation).blocked,1);assert.notEqual(store.events('user',id,0).at(-1)!.kind,'settled');
    assert.equal(store.completeSettlement(id,token,{}),true);
  }finally{store.close();}
});

test('informational command closure preserves completed status and never invents user cancellation',()=>{
  const f=fixture();
  try{const {store,id,conversation}=f;store.running(id);const token=store.beginSettlement(id,{...intent(f.root),terminalStatus:'completed'},{output:'Memory accepted: mem-1',reason:'Informational',result:{outcome:{stop:'Informational'}}});assert.equal(store.turn('user',id).cancel_requested,0);store.claimSettlement(id,token,2);assert.equal(store.completeSettlement(id,token,{fixture:'Host-validated original command proof'}),true);assert.equal(store.turn('user',id).status,'completed');assert.equal(store.turn('user',id).reason,null);assert.equal(store.conversation('user',conversation).blocked,0);}
  finally{f.store.close();}
});
