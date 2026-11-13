// Copyright (c) Ray Zhang. A finalizer advances service generation but never admits a native Run.
import {agentFinalizeSchema} from '../contracts/protocol.ts';
import {finalizationProofSchema,finalizerBindingSchema} from '../contracts/agent-finalize.ts';
import {digest,sha256} from './store.ts';
import {requireCondition} from './errors.ts';
import type {ReachStore,OperationRow,NodeRow} from './store.ts';
import type {AgentExecutionContext} from './agent-executions.ts';

export class AgentFinalizations{
 readonly store:ReachStore;
 constructor(store:ReachStore){this.store=store;}
 isFinalizer(op:OperationRow){return JSON.parse(op.command_json).kind==='agent.finalize';}
 row(id:string){return this.store.db.prepare('SELECT * FROM agent_finalizers WHERE execution_id=?').get(id);}
 source(c:AgentExecutionContext){
  const input=agentFinalizeSchema.parse(JSON.parse(c.execution.command_json)),row=this.row(c.execution.id),source=this.store.executions.resolve(c.op.user_id,input.sourceExecutionId);
  requireCondition(row&&row.root_id===c.op.id&&row.source_execution_id===source.execution.id&&row.source_generation===source.generation&&row.expected_released_sha256===input.releasedSha256&&source.op.id===c.op.id&&source.generation<c.generation&&!this.isFinalizer(source.execution),409,'agent_finalizer_source','结算须绑定准确的原生执行来源');return{input,row,source};
 }
 private assertNoSuccessorEffects(root:OperationRow,sourceGeneration:number){
  const db=this.store.db;
  const newer=[
   db.prepare('SELECT 1 FROM agent_model_owners WHERE parent_id=? AND generation>? LIMIT 1').get(root.id,sourceGeneration),
   db.prepare('SELECT 1 FROM agent_child_executions WHERE root_id=? AND generation>? LIMIT 1').get(root.id,sourceGeneration),
   db.prepare('SELECT 1 FROM agent_run_origins WHERE parent_id=? AND (registered_generation>? OR admitted_generation>?) LIMIT 1').get(root.id,sourceGeneration,sourceGeneration),
   db.prepare('SELECT 1 FROM agent_review_executions WHERE parent_id=? AND generation>? LIMIT 1').get(root.id,sourceGeneration),
   db.prepare('SELECT 1 FROM agent_resume_receipts r JOIN agent_executions e ON e.execution_id=r.execution_id WHERE r.parent_id=? AND e.generation>? LIMIT 1').get(root.id,sourceGeneration),
  ];requireCondition(newer.every(row=>!row),409,'agent_finalizer_source_superseded','来源之后已有原生权威或效果，不能据旧 Released 结算');
 }
 add(op:OperationRow){
  const input=agentFinalizeSchema.parse(JSON.parse(op.command_json)),previous=this.store.executions.resolve(op.user_id,input.previousExecutionId),source=this.store.executions.resolve(op.user_id,input.sourceExecutionId),{op:root,task}=previous;
  requireCondition(!this.store.db.prepare('SELECT 1 FROM agent_task_finishes WHERE root_id=?').get(root.id),409,'agent_resume_finished','原 Task 已完成生命周期结算');
  requireCondition(root.id===input.rootOperationId&&source.op.id===root.id&&op.node_id===root.node_id&&op.epoch===root.epoch&&!this.isFinalizer(source.execution)&&source.generation<=previous.generation,409,'agent_finalizer_source','须沿原 Task、配对和真实原生执行');
  requireCondition(task.active_execution_id===previous.execution.id&&task.generation===previous.generation&&Number.isSafeInteger(task.generation+1),409,'agent_resume_superseded','原 Task 当前执行已变化');
  const abandoned=previous.execution.execution==='cancelled'&&previous.execution.delivery==='cancelled'&&previous.execution.dispatch_id===null&&previous.execution.claimed_at===null&&previous.attempt.phase==='reconciling';
  requireCondition(['unknown','failed','cancelled'].includes(previous.execution.execution)&&((previous.execution.dispatch_id!==null&&previous.execution.claimed_at!==null)||abandoned)&&root.dispatch_id!==null&&root.claimed_at!==null&&source.execution.dispatch_id!==null&&source.execution.claimed_at!==null,409,'agent_finalizer_previous_active','只可结算已停止或未知的原执行');
  this.assertNoSuccessorEffects(root,source.generation);
  const ordinal=this.store.db.prepare('SELECT rowid AS ordinal FROM agent_tasks WHERE root_id=?').get(root.id)!.ordinal;
  const others=this.store.db.prepare(`SELECT p.execution,t.rowid AS ordinal FROM agent_tasks t JOIN operations r ON r.id=t.root_id JOIN operations p ON p.id=t.active_execution_id WHERE r.node_id=? AND r.epoch=? AND json_extract(r.command_json,'$.sessionId')=? AND r.id<>?`).all(root.node_id,root.epoch,previous.command.sessionId,root.id);
  requireCondition(!others.some(r=>Number(r.ordinal)>Number(ordinal)||['not_observed','received','running','unknown'].includes(String(r.execution))),409,'agent_resume_session_changed','原 Session 已有后续任务，不能据旧原件结算');
  const generation=task.generation+1;
  this.store.db.prepare("INSERT INTO agent_executions VALUES(?,?,?,?,NULL,NULL,'reconciling')").run(op.id,root.id,previous.execution.id,generation);
  this.store.db.prepare('INSERT INTO agent_finalizers VALUES(?,?,?,?,?,NULL)').run(op.id,root.id,source.execution.id,source.generation,input.releasedSha256);
  requireCondition(this.store.db.prepare('UPDATE agent_tasks SET active_execution_id=?,generation=?,requires_reconciliation=1 WHERE root_id=? AND active_execution_id=? AND generation=?').run(op.id,generation,root.id,previous.execution.id,task.generation).changes===1,409,'agent_resume_superseded','原 Task 已由另一结算接续');
 }
 private context(node:NodeRow,id:string,binding:{dispatchId:string;payloadHash:string},sealedFinish=false){
  const c=this.store.executions.node(node,id,binding.dispatchId,binding.payloadHash,false);requireCondition(this.isFinalizer(c.execution)&&c.task.active_execution_id===id&&c.task.generation===c.generation&&c.task.requires_reconciliation===1&&(sealedFinish||!c.execution.cancel_requested)&&c.execution.execution==='running'&&(c.execution.delivery==='acknowledged'||(sealedFinish&&c.execution.delivery==='uncertain')),409,'agent_finalizer_inactive','只读结算已停止或被后代取代');
  const current=this.store.ownedNode(node.user_id,node.id);requireCondition((sealedFinish||!current.revoked)&&current.epoch===node.epoch,409,'agent_parent_inactive','原配对已停止');this.source(c);return c;
 }
 private ownerEvent(source:OperationRow){
  const events=this.store.db.prepare("SELECT event_id,sequence,data_json FROM operation_events WHERE operation_id=? AND kind='output' AND json_extract(data_json,'$.type')='agent.process_owner' ORDER BY sequence").all(source.id);
  requireCondition(events.length===1,409,'agent_finalizer_legacy_owner','旧原生执行缺少唯一的持久进程归属，不能推断已退出');const event=events[0]!,data=JSON.parse(String(event.data_json));
  requireCondition(data.executionId===source.id&&data.processOwner?.path&&data.processOwner?.sha256,409,'agent_finalizer_process_owner','原进程归属事件不符');return{eventId:event.event_id,sequence:event.sequence,...data};
 }
 contextReply(node:NodeRow,id:string,raw:unknown){const binding=finalizerBindingSchema.parse(raw),c=this.context(node,id,binding),{source,input}=this.source(c);return{...this.store.executions.context(node,id,binding.dispatchId,binding.payloadHash),sourceExecutionId:source.execution.id,sourceGeneration:source.generation,sourceDispatch:this.store.agents.dispatch(source.execution),sourceOwnerEvent:this.ownerEvent(source.execution),expectedReleasedSha256:input.releasedSha256};}
 sourceForCurrent(root:string){const current=this.store.db.prepare('SELECT active_execution_id FROM agent_tasks WHERE root_id=?').get(root);if(!current)return null;const finalizer=this.row(String(current.active_execution_id));return finalizer?String(finalizer.source_execution_id):null;}
 snapshot(node:NodeRow,id:string,raw:unknown,sealedFinish=false){const b=finalizerBindingSchema.parse(raw),c=this.context(node,id,b,sealedFinish),{source}=this.source(c);this.assertNoSuccessorEffects(c.op,source.generation);const snapshot=this.store.resumes.effectSnapshot(c.op);if(snapshot.models.some(m=>m.owner?.instance_id===this.store.owner.instanceId&&(m.owner.phase!=='joined'||m.owner.joined_at===null)))return{ready:false};const snapshotJson=JSON.stringify({...snapshot,sourceExecutionId:source.execution.id,sourceGeneration:source.generation,sourceOwnerEvent:this.ownerEvent(source.execution)});return{ready:true,snapshotJson,snapshotSha256:sha256(snapshotJson)};}
 finish(op:OperationRow,state:string,data:any,eventId:string){
  if(!this.isFinalizer(op))return;if(!data?.finalizationProof){requireCondition(state!=='succeeded',409,'agent_finalizer_proof_required','只读结算成功须有原件证明');return;}requireCondition(['succeeded','failed'].includes(state),409,'agent_finalizer_proof_required','只读结算证明须对应明确结果');
  const proof=finalizationProofSchema.parse(data.finalizationProof),node=this.store.ownedNode(op.user_id,op.node_id),c=this.context(node,op.id,{dispatchId:op.dispatch_id!,payloadHash:op.payload_hash},true),{input,source}=this.source(c);
  requireCondition(proof.sourceExecutionId===source.execution.id&&proof.sourceGeneration===source.generation&&proof.released.sha256===input.releasedSha256&&proof.consumption.receiptId===op.id&&digest(proof.consumption.released)===digest(proof.released)&&proof.consumption.inspectionSha256===proof.inspection.sha256,409,'agent_finalizer_binding','只读结算与原 Released、检查或消费来源不符');
  const committedResult=structuredClone(data);delete committedResult.finalizationProof.inspectionSeal;
  const commitment={version:1,taskId:c.op.id,executionId:op.id,sourceExecutionId:source.execution.id,sourceGeneration:source.generation,generation:c.generation,dispatchId:op.dispatch_id,payloadHash:op.payload_hash,nodeId:op.node_id,epoch:op.epoch,state,result:committedResult};
  requireCondition(sha256(proof.inspectionSeal.commitmentJson)===proof.inspectionSeal.commitmentSha256&&digest(JSON.parse(proof.inspectionSeal.commitmentJson))===digest(commitment),409,'agent_finalizer_seal','持锁封存必须绑定本代准确的最终结果');
  const snapshot=this.snapshot(node,op.id,{dispatchId:op.dispatch_id!,payloadHash:op.payload_hash},true);requireCondition(snapshot.ready&&snapshot.snapshotSha256===proof.snapshotSha256,409,'agent_finalizer_snapshot_changed','原效果集合或 owner 已变化，不能提交过时结算');
  const full=this.store.resumes.effectSnapshot(c.op);this.store.resumes.assertHistoricalModels(full,c);this.assertNoSuccessorEffects(c.op,source.generation);requireCondition(!this.store.models.unsettled(c.op.id)&&full.children.every(ch=>['succeeded','failed','cancelled'].includes(ch.operation.execution)),409,'agent_finalizer_effects_unknown','原模型或子操作仍有未知效果');
  const ownerEvent=this.ownerEvent(source.execution);requireCondition(digest(proof.process.owner)===digest(ownerEvent.processOwner),409,'agent_finalizer_process_owner','进程退出证明须沿原已 ACK 的归属事件');
  const outcome=data.outcome,basis=outcome?.last_receipt?.basis;
  requireCondition(data.taskId===c.op.id&&data.sessionId===c.command.sessionId&&data.taskAccepted===false&&data.finalizedReadOnly===true&&outcome?.task_id===c.op.id&&outcome.task_accepted===false&&outcome.fence_presence==='Released'&&outcome.reconciliation_fence===null&&outcome.runs===proof.consumption.consumedRuns&&outcome.observed_calls===proof.consumption.consumedCalls&&basis?.task_id===c.op.id&&basis.authorization_revision===c.op.payload_hash&&basis.criteria_revision==='reach-receipt-integrity-v1'&&basis.run_id===proof.lastRunId,409,'agent_finalizer_result','原生释放、Task/Run 和消费不符');
  const origin=this.store.db.prepare('SELECT * FROM agent_run_origins WHERE parent_id=? AND run_id=?').get(c.op.id,proof.lastRunId);requireCondition(origin&&(source.generation===1?origin.registered_execution_id===c.op.id:origin.admitted_execution_id===source.execution.id&&origin.admitted_generation===source.generation),409,'agent_finalizer_run_owner','最终原生 Run 不能借用其他执行归属');
  requireCondition((state==='succeeded'&&data.status==='awaiting_review'&&outcome.stop==='AwaitingHostAcceptance')||(state==='failed'&&data.status==='budget_or_feedback_incomplete'&&['BudgetExhausted','NeedsChanges'].includes(outcome.stop)),409,'agent_finalizer_result','未完成的原生结果不能改成成功');
  if(state==='succeeded')this.store.reviews.assertReturn(c.op,data,source.execution.id);
  const children=full.children.map(ch=>String(ch.operation.id));requireCondition(Array.isArray(data.childOperationIds)&&data.childOperationIds.length===children.length&&new Set(data.childOperationIds).size===children.length&&children.every(id=>data.childOperationIds.includes(id)),409,'agent_child_set_mismatch','结算须覆盖完整原子操作集合');
  this.store.budgets.recordReleasedConsumption(c.op,proof.consumption);
  requireCondition(this.store.budgets.summary(c.op).chargedCalls===outcome.observed_calls,409,'agent_finalizer_consumption','原预算不得退款、扩额或遗漏');
  this.store.db.prepare('UPDATE agent_finalizers SET proof_json=? WHERE execution_id=? AND proof_json IS NULL').run(JSON.stringify(proof),op.id);
  this.store.db.prepare('INSERT INTO agent_task_finishes VALUES(?,?,?,?,?,?)').run(c.op.id,op.id,c.generation,eventId,JSON.stringify(proof),this.store.now());
  requireCondition(this.store.db.prepare('UPDATE agent_tasks SET requires_reconciliation=0 WHERE root_id=? AND active_execution_id=? AND generation=? AND requires_reconciliation=1').run(c.op.id,op.id,c.generation).changes===1,409,'agent_resume_superseded','原 Task 当前结算已变化');
 }
 migrate(version:number){
  for(const row of this.store.db.prepare("SELECT * FROM operations WHERE json_extract(command_json,'$.kind')='agent.finalize'").all() as unknown as OperationRow[]){requireCondition(version>=10&&this.row(row.id),409,'agent_finalizer_migration','旧版本不能已有 finalizer，必需的原关系不得补造');const c=this.store.executions.resolve(row.user_id,row.id);this.source(c);}
  for(const row of this.store.db.prepare('SELECT * FROM agent_finalizers').all()){const op=this.store.db.prepare('SELECT * FROM operations WHERE id=?').get(row.execution_id) as unknown as OperationRow|undefined;requireCondition(op&&this.isFinalizer(op),409,'agent_finalizer_migration','只读结算缺少原操作');if(row.proof_json!==null){finalizationProofSchema.parse(JSON.parse(String(row.proof_json)));const finish=this.store.db.prepare('SELECT * FROM agent_task_finishes WHERE root_id=? AND execution_id=?').get(row.root_id,row.execution_id);requireCondition(finish&&digest(JSON.parse(String(finish.proof_json)))===digest(JSON.parse(String(row.proof_json))),409,'agent_finalizer_migration','原结算证明与同事务释放记录冲突');}}
 }
}
