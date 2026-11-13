// Copyright (c) Ray Zhang. Migrate copies of accepted, actual schema9 Node journals.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,backup} from 'node:sqlite';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {ReachStore} from '../src/service/store.ts';

const accepted=resolve('work/agent-native-resume-20261104/checked-r6.json');
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const tables=['operations','operation_events','agent_tasks','agent_executions','agent_calls','agent_child_executions','agent_runs','agent_run_origins','agent_run_budgets','agent_budget_reconciliations','agent_task_models','agent_model_calls','agent_model_owners','agent_model_stops','agent_run_reviews','agent_review_executions','agent_resume_plans','agent_resume_receipts','agent_resume_models','agent_task_finishes'];
function snapshot(db:DatabaseSync){return Object.fromEntries(tables.map(name=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]));}

for(const scenario of ['happy','unknown_model_stopped'])test('actual schema9 to 10 preserves native finish, Run, review and model authority: '+scenario,async()=>{
 const checked=readFileSync(accepted);assert.equal(sha(checked),'24e0f1652aa08cd4b811a5834ef588c57cd2bcd1fa31b14a123ab2f0491b0f75');
 const source=JSON.parse(checked.toString()).results.find((r:any)=>r.scenario===scenario);assert.ok(source);
 const root=resolve('work/agent-finalize-migration-'+randomUUID());mkdirSync(root);const filename=join(root,'copy.sqlite');
 const sourcePath=join(source.root,'service','reach.sqlite'),beforeSourceSha=sha(readFileSync(sourcePath));
 const original=new DatabaseSync(sourcePath,{readOnly:true});
 try{assert.equal(original.prepare('PRAGMA user_version').get()!.user_version,9);assert.equal(original.prepare('SELECT count(*) AS n FROM agent_task_finishes').get()!.n,1);await backup(original,filename);}finally{original.close();}
 let current=new ReachStore(filename);let expected;
 try{
  assert.equal(current.db.prepare('PRAGMA user_version').get()!.user_version,11);const sourceDb=new DatabaseSync(sourcePath,{readOnly:true});try{expected=snapshot(sourceDb);}finally{sourceDb.close();}
  assert.deepEqual(snapshot(current.db),expected);assert.equal(current.db.prepare('SELECT count(*) AS n FROM agent_finalizers').get()!.n,0);
 }finally{current.close();}
 const oldModule=pathToFileURL(resolve('work/agent-native-resume-20261104/source-r6/apps/reach/src/service/store.ts')).href;
 const Old=await import(oldModule);assert.throws(()=>new Old.ReachStore(filename),/newer than/);
 current=new ReachStore(filename);try{assert.deepEqual(snapshot(current.db),expected);}finally{current.close();}
 assert.equal(sha(readFileSync(sourcePath)),beforeSourceSha,'read-only source database must remain byte-identical');
 writeFileSync(join(root,'asserted-schema9-migration.json'),JSON.stringify({scope:'copies of actual accepted schema9 native Node data; no server, models, tools or new native Tasks',scenario,sourcePath,beforeSourceSha,afterSourceSha:sha(readFileSync(sourcePath)),target:filename,from:9,to:10,tables,unchanged:expected,oldVersionRejected:true,reopened:true},null,2));
 console.log(JSON.stringify({finalizeMigration:root,scenario}));
});
