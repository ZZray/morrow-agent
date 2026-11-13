// Copyright (c) Ray Zhang. Explicit real schema10 copy, no synthetic version downgrade.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {ReachStore} from '../src/service/store.ts';
const previousDatabase=process.env.REACH_LIBRARY_SCHEMA10_DATABASE,previousStore=process.env.REACH_LIBRARY_SCHEMA10_STORE;
const tables=['users','sessions','pairing_codes','pairing_attempts','nodes','operations','operation_events','operation_reconciliations','agent_calls','agent_runs','agent_task_models','agent_run_reviews','agent_run_budgets','agent_budget_reconciliations','agent_model_calls','agent_model_owners','agent_model_stops','agent_tasks','agent_executions','agent_child_executions','agent_run_origins','agent_resume_plans','agent_resume_receipts','agent_resume_models','agent_review_executions','agent_task_finishes','agent_finalizers','audit'];
function domain(db:DatabaseSync){return Object.fromEntries(tables.map(t=>[t,db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()]));}
async function copy(){assert.ok(previousDatabase);const root=resolve('work/source-library-migration-'+randomUUID());mkdirSync(root,{recursive:true});const filename=join(root,'reach.sqlite'),original=new DatabaseSync(previousDatabase,{readOnly:true});try{assert.equal(original.prepare('PRAGMA user_version').get()!.user_version,10);await backup(original,filename);}finally{original.close();}return{root,filename};}
test('real schema10 records migrate to schema11 unchanged, no old task becomes validated knowledge, old service rejects it',{skip:!previousDatabase||!previousStore},async()=>{
  const f=await copy(),db=new DatabaseSync(f.filename);let before:ReturnType<typeof domain>;try{before=domain(db);assert.ok(before.operations.length>0);assert.ok(before.agent_task_finishes.length>0);assert.ok(before.agent_model_calls.length>0);}finally{db.close();}
  let store=new ReachStore(f.filename);try{assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version,11);assert.deepEqual(domain(store.db),before);for(const t of ['source_library','source_library_validations','source_library_reviews','source_library_uses','agent_native_closures'])assert.equal(store.db.prepare('SELECT count(*) AS n FROM '+t).get()!.n,0);}finally{store.close();}
  const old=await import(pathToFileURL(previousStore!).href);assert.throws(()=>new old.ReachStore(f.filename),/newer than/);
  store=new ReachStore(f.filename);try{assert.deepEqual(domain(store.db),before);writeFileSync(join(f.root,'asserted.json'),JSON.stringify({source:previousDatabase,previousStore,from:10,to:11,tables:tables.map(t=>({table:t,rows:before[t]!.length})),oldRecordsPreserved:true,automaticKnowledgeEntries:0,ownerProtocol:10},null,2));}finally{store.close();}console.log(JSON.stringify({sourceLibraryMigrationEvidence:f.root}));
});
test('failed real schema10 migration rolls back all five new structures and preserves the original corrupt evidence',{skip:!previousDatabase},async()=>{
  const f=await copy(),db=new DatabaseSync(f.filename);let before:ReturnType<typeof domain>;try{db.exec('PRAGMA foreign_keys=OFF');const row=db.prepare('SELECT rowid FROM agent_run_origins LIMIT 1').get()!;db.prepare('DELETE FROM agent_run_origins WHERE rowid=?').run(row.rowid);before=domain(db);}finally{db.close();}
  assert.throws(()=>new ReachStore(f.filename),/原 Run 注册归属缺失/);const after=new DatabaseSync(f.filename,{readOnly:true});try{assert.equal(after.prepare('PRAGMA user_version').get()!.user_version,10);assert.deepEqual(domain(after),before);assert.equal(after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'source_library%' OR name='agent_native_closures'").get()!.n,0);}finally{after.close();}console.log(JSON.stringify({sourceLibraryFailedMigrationEvidence:f.root}));
});
test('schema11 with a missing source relationship table is rejected without creating an empty replacement',()=>{
  const root=resolve('work/source-library-missing-'+randomUUID());mkdirSync(root,{recursive:true});const filename=join(root,'reach.sqlite'),store=new ReachStore(filename);store.close();const db=new DatabaseSync(filename);db.exec('DROP TABLE source_library_uses');db.close();assert.throws(()=>new ReachStore(filename),/资料库结构缺失/);const after=new DatabaseSync(filename,{readOnly:true});try{assert.equal(after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='source_library_uses'").get()!.n,0);assert.equal(after.prepare('PRAGMA user_version').get()!.user_version,11);}finally{after.close();}console.log(JSON.stringify({sourceLibraryMissingTableEvidence:root}));
});
