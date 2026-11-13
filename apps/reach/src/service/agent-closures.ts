// Copyright (c) Ray Zhang. Node-authenticated proof bound to original effects; not Task acceptance.
import {nativeClosureSchema} from '../contracts/agent-closure.ts';
import {modelBindingSchema} from './agent-model-store.ts';
import {digest,sha256} from './store.ts';
import {requireCondition} from './errors.ts';
import {targetPaths} from '../contracts/device-target.ts';
import type {ReachStore,NodeRow,OperationRow} from './store.ts';
export class AgentClosures{
  readonly store:ReachStore;
  constructor(store:ReachStore){this.store=store;}
  snapshot(node:NodeRow,id:string,raw:unknown){
    const b=modelBindingSchema.parse(raw),c=this.store.executions.node(node,id,b.dispatchId,b.payloadHash,false);
    requireCondition(c.generation===1&&c.op.id===id&&c.task.active_execution_id===id&&c.task.generation===1&&c.execution.execution==='running',409,'agent_closure_binding','此只读完结证明须属于准确的原始执行');
    const snapshot=this.store.resumes.effectSnapshot(c.op);
    if(snapshot.models.some(m=>!m.owner||m.owner.phase!=='joined'||m.owner.joined_at===null))return{ready:false};
    this.store.models.assertSettled(c.op);
    const snapshotJson=JSON.stringify(snapshot);return{ready:true,snapshotJson,snapshotSha256:sha256(snapshotJson)};
  }
  finish(op:OperationRow,state:string,data:any,eventId:string,reconciled:boolean){
    if(!data?.nativeClosure)return;
    // Original late evidence still settles its outbox after explicit reconciliation.
    // Historical transport records do not obtain new validation eligibility.
    if(reconciled)return;
    const c=this.store.executions.resolve(op.user_id,op.id),p=nativeClosureSchema.parse(data.nativeClosure);
    requireCondition(!reconciled&&c.generation===1&&c.op.id===op.id&&c.task.active_execution_id===op.id&&['succeeded','failed'].includes(state),409,'agent_closure_binding','完结证明须由原 Node 的准确原始终态入账');
    const snapshot=this.store.resumes.effectSnapshot(c.op);
    requireCondition(p.snapshotSha256===sha256(JSON.stringify(snapshot))&&snapshot.children.every(ch=>['succeeded','failed','cancelled'].includes(ch.operation.execution))&&!this.store.models.unsettled(c.op.id)&&snapshot.models.every(m=>m.owner?.phase==='joined'&&m.owner.joined_at!==null),409,'agent_closure_effects','完结前须等待全部效果和模型运输实际结算');
    const ownerEvents=this.store.db.prepare("SELECT data_json FROM operation_events WHERE operation_id=? AND kind='output' AND json_extract(data_json,'$.type')='agent.process_owner'").all(op.id);
    requireCondition(ownerEvents.length===1&&digest(JSON.parse(String(ownerEvents[0]!.data_json)).processOwner)===digest(p.processOwner),409,'agent_closure_owner','须绑定启动前保存的准确进程归属');
    const platform=this.store.ownedNode(op.user_id,op.node_id).platform,paths=targetPaths(platform),normalize=(path:string)=>{requireCondition(!path.includes('\0')&&paths.isAbsolute(path),409,'agent_closure_reference_scope','原件须为设备绝对路径');let value=paths.normalize(path);if(platform==='windows'){if(value.startsWith('\\\\?\\'))value=value.slice(4);value=value.toLowerCase();}return value;};
    const directory=paths.dirname(p.processOwner.path),same=(path:string,name:string)=>normalize(path)===normalize(paths.join(directory,name));
    requireCondition(same(p.processOwner.path,'sidecar-owner.json')&&same(p.task.path,'task.json')&&same(p.terminal.path,'terminal.json')&&same(p.processSettled.path,'process-settled.json')&&same(p.outcome.path,'evidence/released.json'),409,'agent_closure_reference_scope','完结原件须属于已登记进程的准确 Task 目录');
    requireCondition(sha256(p.processOwnerJson)===p.processOwner.sha256&&sha256(p.processSettledJson)===p.processSettled.sha256,409,'agent_closure_hash','进程原件正文与摘要不符');
    let owner:any,settled:any;try{owner=JSON.parse(p.processOwnerJson);settled=JSON.parse(p.processSettledJson);}catch{requireCondition(false,400,'agent_closure_json','进程原件不是有效 JSON');}
    requireCondition(owner.version===1&&owner.taskId===op.id&&owner.executionId===op.id&&owner.dispatchId===op.dispatch_id&&owner.payloadHash===op.payload_hash&&owner.nodeId===op.node_id&&owner.epoch===op.epoch,409,'agent_closure_owner','进程原件不属于本次派发');
    requireCondition(settled.version===1&&settled.kind==='normal_join_receipt'&&settled.normalExit===true&&settled.sidecarWaited===true&&settled.jobTerminated===true&&settled.jobEmpty===true&&digest(settled.processOwner)===digest(p.processOwner)&&settled.observation?.sidecar?.originalAlive===false&&settled.observation?.job?.activeProcesses===0,409,'agent_closure_join','没有准确原进程正常 join 与空 Job 证明');
    const n=data.outcome,b=n?.last_receipt?.basis;
    const budgets=this.store.budgets.summary(c.op),last=budgets.runs.at(-1),origin=this.store.db.prepare('SELECT * FROM agent_run_origins WHERE parent_id=? AND run_id=?').get(op.id,p.lastRunId),run=this.store.db.prepare('SELECT * FROM agent_runs WHERE parent_id=? AND run_id=?').get(op.id,p.lastRunId);
    requireCondition(run&&origin?.registered_execution_id===op.id&&origin.registered_generation===1&&last?.run_id===p.lastRunId&&last.run_number===b?.run_number&&n.runs===budgets.runs.length&&b.criteria_revision==='reach-receipt-integrity-v1'&&b.run_calls===last.actual&&b.total_calls===p.observedCalls,409,'agent_closure_run','原生最后 Run、顺序、调用预算和复核合同须对应原 Task 的实际登记');
    requireCondition(data.taskId===op.id&&data.sessionId===c.command.sessionId&&data.taskAccepted===false&&n?.task_id===op.id&&n.task_accepted===false&&n.fence_presence==='Released'&&n.observed_calls===p.observedCalls&&p.observedCalls===this.store.budgets.summary(c.op).chargedCalls&&b?.run_id===p.lastRunId&&b.task_id===op.id&&b.authorization_revision===op.payload_hash,409,'agent_closure_outcome','原生释放、原 Run、派发及消费不符');
    requireCondition((state==='succeeded'&&data.status==='awaiting_review'&&n.stop==='AwaitingHostAcceptance')||(state==='failed'&&data.status==='budget_or_feedback_incomplete'&&['BudgetExhausted','NeedsChanges'].includes(n.stop)),409,'agent_closure_outcome','终态不是准确的闭合结果');
    this.store.db.prepare('INSERT INTO agent_native_closures VALUES(?,?,?,?)').run(op.id,eventId,digest(p),this.store.now());
  }
}
