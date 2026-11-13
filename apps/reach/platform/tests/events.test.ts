// Copyright (c) Ray Zhang. Original event file visibility and identity boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,appendFileSync,rmSync } from 'node:fs';
import { join,dirname,resolve,basename } from 'node:path';
import { tmpdir } from 'node:os';
import { AnswerEvents } from '../src/events.ts';
test('event reader waits for complete admission and UTF-8 frames, ignores full text and rejects wrong identity',()=>{
  const root=mkdtempSync(join(tmpdir(),'reach-desk-events-')),values:string[]=[];
  try{
    const reader=new AnswerEvents(root,'task','run',text=>values.push(text)),admission=join(root,'run-1-admission.json'),events=join(root,'run-1-events.jsonl');
    writeFileSync(admission,'{"task_id":');reader.poll();assert.deepEqual(values,[]);
    writeFileSync(admission,JSON.stringify({task_id:'task',run_id:'run',run_number:1})+'\n');
    const frame=(seq:number,event:unknown)=>JSON.stringify({task_id:'task',run_id:'run',seq,event})+'\n';
    const bytes=Buffer.from(frame(1,{type:'text_delta',output:'中文流'})),split=bytes.indexOf(Buffer.from('中文'))+1;
    writeFileSync(events,bytes.subarray(0,split));reader.poll();assert.deepEqual(values,[]);
    appendFileSync(events,bytes.subarray(split));reader.poll();assert.deepEqual(values,['中文流']);
    appendFileSync(events,frame(2,{type:'text',text:'中文流'}));reader.poll();assert.deepEqual(values,['中文流']);
    appendFileSync(events,JSON.stringify({task_id:'other-task',run_id:'run',seq:3,event:{type:'text_delta',output:'wrong'}})+'\n');assert.throws(()=>reader.poll(),/identity/);
  }finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('reach-desk-events-'));rmSync(root,{recursive:true,force:true});}
});

test('management agent_end displays its original output once when no deltas were emitted',()=>{
  const root=mkdtempSync(join(tmpdir(),'reach-desk-events-')),values:string[]=[];
  try{writeFileSync(join(root,'run-1-admission.json'),JSON.stringify({task_id:'task',run_id:'run',run_number:1})+'\n');writeFileSync(join(root,'run-1-events.jsonl'),JSON.stringify({task_id:'task',run_id:'run',seq:1,event:{type:'agent_end',status:'completed',output:'Memory accepted: mem-1'}})+'\n');const reader=new AnswerEvents(root,'task','run',text=>values.push(text));reader.poll();reader.poll();assert.deepEqual(values,['Memory accepted: mem-1']);}
  finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('reach-desk-events-'));rmSync(root,{recursive:true,force:true});}
});
