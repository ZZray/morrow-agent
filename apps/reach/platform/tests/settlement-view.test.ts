// Copyright (c) Ray Zhang. Versioned transport ordering, independent of a DOM.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeSettlement,validSettlement} from '../web/settlement.ts';
const unlocked={blocked:0,blocker_task_id:null,settlement_revision:0,declaration_sha:null};
const closing={blocked:1,blocker_task_id:'old-task',settlement_revision:1,declaration_sha:'a'.repeat(64)};
const released={...unlocked,settlement_revision:2};
const newer={...closing,blocker_task_id:'new-task',settlement_revision:3,declaration_sha:'b'.repeat(64)};
test('older false never releases a newer blocker; older true never reblocks a released Session',()=>{
  assert.deepEqual(mergeSettlement(newer,unlocked),newer);
  assert.deepEqual(mergeSettlement(newer,released),newer);
  assert.deepEqual(mergeSettlement(released,closing),released);
  assert.deepEqual(mergeSettlement(closing,released),released);
  assert.deepEqual(mergeSettlement(released,newer),newer);
});
test('same-version contradiction suspends sends until an authoritative fresh read or later version',()=>{
  const conflict=mergeSettlement(released,{...closing,settlement_revision:2});
  assert.equal(conflict.settlement_conflict,true);
  assert.equal(mergeSettlement(conflict,released).settlement_conflict,true,'ordinary replay cannot clear a conflict');
  assert.equal(mergeSettlement(conflict,unlocked,true).settlement_conflict,true,'older GET cannot clear a conflict');
  assert.deepEqual(mergeSettlement(conflict,released,true),released);
  assert.deepEqual(mergeSettlement(conflict,newer),newer);
});
test('legacy events and malformed settlement tuples cannot become an unlock receipt',()=>{
  for(const value of [null,{},true,{...released,settlement_revision:-1},{...released,settlement_revision:1.5},{...released,blocked:2},{...released,blocker_task_id:'stale'},{...closing,declaration_sha:'bad'}]){
    assert.equal(validSettlement(value),false);assert.equal(mergeSettlement(newer,value).settlement_conflict,true);assert.equal(mergeSettlement(newer,value).blocked,1);
  }
  assert.equal(validSettlement({...closing,blocker_task_id:null,declaration_sha:null}),true,'legacy blocked database rows remain locked');
});
