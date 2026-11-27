// Copyright (c) Ray Zhang. Server settlement versions are independent of UI reads.
export interface SettlementState {blocked:number;blocker_task_id:string|null;settlement_revision:number;declaration_sha:string|null}
export interface SettlementView extends SettlementState {settlement_conflict?:boolean}
export function validSettlement(value:unknown):value is SettlementState {
  if(!value||typeof value!=='object')return false;const s=value as SettlementState;
  return (s.blocked===0||s.blocked===1)&&Number.isSafeInteger(s.settlement_revision)&&s.settlement_revision>=0
    &&(s.blocker_task_id===null||typeof s.blocker_task_id==='string')&&(s.declaration_sha===null||/^[0-9a-f]{64}$/.test(s.declaration_sha))
    &&(s.blocked===1||(s.blocker_task_id===null&&s.declaration_sha===null));
}
export function mergeSettlement(current:SettlementView|undefined,incoming:unknown,confirmed=false):SettlementView {
  if(!validSettlement(incoming))return {...(current??{blocked:1,blocker_task_id:null,settlement_revision:0,declaration_sha:null}),settlement_conflict:true};
  const next={blocked:incoming.blocked,blocker_task_id:incoming.blocker_task_id,settlement_revision:incoming.settlement_revision,declaration_sha:incoming.declaration_sha};
  if(!current||next.settlement_revision>current.settlement_revision)return next;
  if(next.settlement_revision<current.settlement_revision)return {...current};
  const same=next.blocked===current.blocked&&next.blocker_task_id===current.blocker_task_id&&next.declaration_sha===current.declaration_sha;
  if(confirmed&&current.settlement_conflict)return next;
  return {...current,...(!same?{settlement_conflict:true}:{})};
}
