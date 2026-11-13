// Copyright (c) Ray Zhang. Adversarial Host policy fixtures; no Core acceptance claim.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {reviewEffects} from '../src/settlement.ts';
const root=resolve('work/policy-only'),run='run-new',source={id:'ref-1',kind:'objective',text:'old',status:'active',hash:'source-hash',run:'old-run',version:1};
function fixture(){const context={version:1,scope:'scope',cloud_stamp:null,cloud_migrated:true,watermark:0,summary:null,references:[source],memories:[]},before={context:{kind:'present',snapshot:structuredClone(context)},inputs:[],to_raw:2},after={context:{kind:'present',snapshot:structuredClone(context)},inputs:[],to_raw:2,transcript_closed:true,pending_run:null,unknown_effect_result_indices:[],calls:[],runs:[],head:{metadata:{goal:null,goal_commands:[],goal_history:[]}}},start={run:{run_id:run,objective:'/reference list'}};return {before,after:after as any,start};}
test('context changes without raw growth still reject unrelated mutations and unadmitted Run files',()=>{
  const f=fixture();assert.doesNotThrow(()=>reviewEffects(f.before,f.after,f.start,[],'token'));
  f.after.context.snapshot.references[0].text='changed';assert.throws(()=>reviewEffects(f.before,f.after,f.start,[],'token'),/reference mutation/);
  const g=fixture();g.after.inputs.push({path:join(root,'session.journal','runs','foreign.json'),state:{kind:'file',sha256:'a',bytes:1}});assert.throws(()=>reviewEffects(g.before,g.after,g.start,[],'token'),/unadmitted/);
});
test('unknown read effects and successful proposal receipts without their persisted candidate stay blocked',()=>{
  const f=fixture(),c={call:{id:'call',name:'reference_read',arguments:{id:'ref-1'}},result:{isError:true,content:[]},result_raw_index:3,effects_unknown:true};f.after.calls=[c];const events=[{type:'tool_start',step_id:'call',title:'reference_read'},{type:'tool_end',step_id:'call',title:'reference_read',status:'failed'}];assert.throws(()=>reviewEffects(f.before,f.after,f.start,events,'token'),/unknown read/);
  c.call.name='memory_propose';c.call.arguments={source_ids:['ref-1'],kind:'fact',text:'candidate'} as any;c.result={isError:false,content:[{text:JSON.stringify({id:'mem-9',status:'candidate',adopted:false})}]} as any;c.effects_unknown=false;events.forEach(e=>e.title='memory_propose');events[1].status='completed';assert.throws(()=>reviewEffects(f.before,f.after,f.start,events,'token'),/receipt/);
});
test('source correction matches exact mutation while extra correction or candidate additions are rejected',()=>{
  const f=fixture();f.start.run.objective='/reference correct ref-1 replacement';f.after.context.snapshot.references[0].status='superseded';f.after.context.snapshot.references.push({...source,id:'ref-2',text:'replacement',version:2,supersedes:'ref-1',run});f.after.context.snapshot.watermark=2;assert.doesNotThrow(()=>reviewEffects(f.before,f.after,f.start,[],'token'));
  f.after.context.snapshot.references.push({...f.after.context.snapshot.references[1],id:'ref-3'});assert.throws(()=>reviewEffects(f.before,f.after,f.start,[],'token'),/count/);
});
test('malformed failed proposal can prove absence when the complete memory delta is empty',()=>{
  const f=fixture();f.after.calls=[{call:{id:'bad',name:'memory_propose',arguments:{}},result:{isError:true,content:[]},result_raw_index:3,effects_unknown:false}];const events=[{type:'tool_start',step_id:'bad',title:'memory_propose'},{type:'tool_end',step_id:'bad',title:'memory_propose',status:'failed'}];assert.equal(reviewEffects(f.before,f.after,f.start,events,'token').calls[0].effect,'absent');
});
