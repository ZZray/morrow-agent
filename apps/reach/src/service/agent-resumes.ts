// Copyright (c) Ray Zhang. Native resume is a reconciliation, an admission, then a final release.
import {randomUUID} from 'node:crypto';
import {resumePlanSchema,resumeReconcileSchema,resumeAdmissionSchema,resumeFinalSchema,nativeResumeReceiptSchema,resumeArgumentsSchema} from '../contracts/agent-resume.ts';
import {finalizationProofSchema} from '../contracts/agent-finalize.ts';
import {modelBindingSchema} from './agent-model-store.ts';
import {digest,sha256} from './store.ts';
import {requireCondition} from './errors.ts';
import type {ReachStore,NodeRow,OperationRow} from './store.ts';
import type {AgentExecutionContext} from './agent-executions.ts';

export class AgentResumes {
  readonly store:ReachStore;
  constructor(store:ReachStore){this.store=store;}
  private rows(table:string,root:string){return this.store.db.prepare('SELECT * FROM '+table+' WHERE parent_id=? ORDER BY rowid').all(root);}
  migrate(version:number){
    requireCondition(!this.store.db.prepare('SELECT c.child_id FROM agent_calls c LEFT JOIN agent_runs r ON r.parent_id=c.parent_id AND r.run_id=c.run_id WHERE r.run_id IS NULL LIMIT 1').get(),409,'agent_resume_migration','原子操作缺少原 Run，不能从效果补造注册');
    // Schema8 never admitted a later execution. Preserve gen1 registration/publication,
    // even when its current pointer already names a failed recovery attempt.
    for(const run of this.store.db.prepare('SELECT * FROM agent_runs ORDER BY rowid').all()){
      const root=this.store.db.prepare('SELECT * FROM agent_executions WHERE execution_id=? AND root_id=? AND generation=1').get(run.parent_id,run.parent_id);
      const budget=this.store.db.prepare('SELECT * FROM agent_run_budgets WHERE parent_id=? AND run_id=?').get(run.parent_id,run.run_id);
      requireCondition(root&&budget,409,'agent_resume_migration','原 Run 或预算没有准确的 Task 归属');
      const origin=this.store.db.prepare('SELECT * FROM agent_run_origins WHERE parent_id=? AND run_id=?').get(run.parent_id,run.run_id);
      if(!origin){requireCondition(version<9,409,'agent_resume_migration','原 Run 注册归属缺失');this.store.db.prepare('INSERT INTO agent_run_origins(parent_id,run_id,registered_execution_id,registered_generation) VALUES(?,?,?,1)').run(run.parent_id,run.run_id,run.parent_id);}
    }
    for(const review of this.store.db.prepare('SELECT * FROM agent_run_reviews ORDER BY rowid').all()){
      const run=this.store.db.prepare('SELECT * FROM agent_run_origins WHERE parent_id=? AND run_id=?').get(review.parent_id,review.run_id);
      requireCondition(run,409,'agent_resume_migration','原复核缺少 Run 注册');
      if(!this.store.db.prepare('SELECT 1 FROM agent_review_executions WHERE parent_id=? AND run_id=?').get(review.parent_id,review.run_id)){
        requireCondition(version<9,409,'agent_resume_migration','原复核发布归属缺失');this.store.db.prepare('INSERT INTO agent_review_executions VALUES(?,?,?,1)').run(review.parent_id,review.run_id,review.parent_id);
      }
    }
    const bad=this.store.db.prepare(`SELECT o.run_id FROM agent_run_origins o LEFT JOIN agent_runs r ON r.parent_id=o.parent_id AND r.run_id=o.run_id LEFT JOIN agent_executions e ON e.execution_id=o.registered_execution_id
      LEFT JOIN agent_executions a ON a.execution_id=o.admitted_execution_id WHERE r.run_id IS NULL OR e.root_id IS NULL OR e.root_id<>o.parent_id OR e.generation<>o.registered_generation
      OR (o.admitted_execution_id IS NULL AND (o.admitted_generation IS NOT NULL OR o.admission_json IS NOT NULL)) OR (o.admitted_execution_id IS NOT NULL AND (a.root_id IS NULL OR a.root_id<>o.parent_id OR a.generation<>o.admitted_generation OR o.admission_json IS NULL)) LIMIT 1`).get();
    const badReview=this.store.db.prepare(`SELECT p.run_id FROM agent_review_executions p LEFT JOIN agent_run_reviews r ON r.parent_id=p.parent_id AND r.run_id=p.run_id LEFT JOIN agent_executions e ON e.execution_id=p.execution_id
      LEFT JOIN agent_run_origins o ON o.parent_id=p.parent_id AND o.run_id=p.run_id WHERE r.run_id IS NULL OR e.root_id IS NULL OR e.root_id<>p.parent_id OR e.generation<>p.generation OR o.run_id IS NULL
      OR (p.generation>1 AND (o.admitted_execution_id IS NULL OR o.admitted_execution_id<>p.execution_id OR o.admitted_generation<>p.generation)) LIMIT 1`).get();
    requireCondition(!bad&&!badReview,409,'agent_resume_migration','原 Run 或复核执行关系冲突');
    requireCondition(this.store.db.prepare('PRAGMA foreign_key_check').all().length===0,409,'agent_resume_migration','恢复账本有缺失的原件关联');
    for(const row of this.store.db.prepare('SELECT * FROM agent_resume_receipts').all()){
      const execution=this.store.executions.resolve(String(this.store.db.prepare('SELECT user_id FROM operations WHERE id=?').get(row.execution_id)!.user_id),String(row.execution_id)),input=resumeReconcileSchema.parse(JSON.parse(String(row.input_json))),receipt=JSON.parse(String(row.receipt_json));
      requireCondition(execution.generation>1&&row.parent_id===execution.op.id&&digest(input)===row.identity_sha256&&sha256(String(row.receipt_json))===row.receipt_sha256&&receipt.executionId===row.execution_id&&receipt.taskId===row.parent_id&&receipt.generation===execution.generation,409,'agent_resume_migration','原恢复回执身份不符');
    }
    for(const row of this.store.db.prepare("SELECT * FROM agent_executions WHERE phase='active' AND generation>1").all())requireCondition(this.receipt(String(row.execution_id))&&this.store.db.prepare('SELECT 1 FROM agent_run_origins WHERE admitted_execution_id=? AND admitted_generation=? LIMIT 1').get(row.execution_id,row.generation),409,'agent_resume_migration','恢复 active 缺少原生准入依据');
    for(const row of this.store.db.prepare('SELECT * FROM agent_task_finishes').all()){
      const operation=this.store.db.prepare('SELECT command_json FROM operations WHERE id=?').get(row.execution_id)!,finalizer=JSON.parse(String(operation.command_json)).kind==='agent.finalize';
      (finalizer?finalizationProofSchema:resumeFinalSchema).parse(JSON.parse(String(row.proof_json)));const event=this.store.db.prepare('SELECT kind,data_json FROM operation_events WHERE operation_id=? AND event_id=?').get(row.execution_id,row.event_id);
      requireCondition(event&&['succeeded','failed'].includes(String(event.kind))&&digest(JSON.parse(String(event.data_json))[finalizer?'finalizationProof':'finalProof'])===digest(JSON.parse(String(row.proof_json))),409,'agent_resume_migration','原释放依据缺少同事务终态事件');
    }
    if(version<9)requireCondition(!this.store.db.prepare('SELECT 1 FROM agent_model_owners WHERE execution_id<>parent_id OR generation<>1 LIMIT 1').get()&&!this.store.db.prepare('SELECT 1 FROM agent_child_executions WHERE execution_id<>root_id OR generation<>1 LIMIT 1').get(),409,'agent_resume_migration','旧版后继执行不能已有原生效果');
  }
  register(parent:OperationRow,runId:string){
    if(this.store.db.prepare('SELECT 1 FROM agent_run_origins WHERE parent_id=? AND run_id=?').get(parent.id,runId))return;
    const c=this.store.executions.resolve(parent.user_id,this.store.executions.current(parent).id);
    this.store.db.prepare('INSERT INTO agent_run_origins(parent_id,run_id,registered_execution_id,registered_generation) VALUES(?,?,?,?)').run(parent.id,runId,c.execution.id,c.generation);
  }
  private context(node:NodeRow,id:string,binding:{dispatchId:string;payloadHash:string},unfinished=true){
    const c=this.store.executions.node(node,id,binding.dispatchId,binding.payloadHash,false),current=this.store.ownedNode(node.user_id,node.id);
    requireCondition(JSON.parse(c.execution.command_json).kind==='agent.resume'&&c.generation>1&&c.task.active_execution_id===id&&c.task.generation===c.generation,409,'agent_resume_superseded','恢复须属于原 Task 当前执行');
    requireCondition(!current.revoked&&current.epoch===node.epoch,409,'agent_parent_inactive','原配对已停止');
    if(unfinished)requireCondition(c.task.requires_reconciliation===1&&!c.execution.cancel_requested&&c.execution.execution==='running'&&c.execution.delivery==='acknowledged'&&c.task.deadline_unix_ms!==null&&this.store.now()<c.task.deadline_unix_ms,409,'agent_parent_inactive','本次恢复已停止或原截止时间已过');
    return c;
  }
  effectSnapshot(root:OperationRow){
    // The snapshot binds original bytes by digest. Large tool results, model usage,
    // review bodies and arguments stay in their original ledgers; never collect
    // them into an unbounded control-plane response.
    return {taskId:root.id,models:this.rows('agent_model_calls',root.id).map(raw=>{
      const {usage_json,...model}=raw,stop=this.store.db.prepare('SELECT receipt_json FROM agent_model_stops WHERE parent_id=? AND request_id=?').get(root.id,raw.request_id);
      return{model,modelSha256:digest(raw),usageSha256:usage_json===null?null:sha256(String(usage_json)),owner:this.store.db.prepare('SELECT o.*,i.lock_identity,i.protocol_version FROM agent_model_owners o LEFT JOIN agent_service_instances i ON i.instance_id=o.instance_id WHERE parent_id=? AND request_id=?').get(root.id,raw.request_id)??null,stopSha256:stop?sha256(String(stop.receipt_json)):null};
    }),children:this.rows('agent_calls',root.id).map(raw=>{
      const {arguments_json,...relation}=raw,operation=this.store.operation(root.user_id,String(raw.child_id)),{command_json,result_json,...op}=operation;
      const events=this.store.db.prepare('SELECT event_id,sequence,kind,data_json FROM operation_events WHERE operation_id=? ORDER BY sequence').all(raw.child_id);
      const eventsProof=sha256(events.map(e=>String(e.event_id)+'\t'+String(e.sequence)+'\t'+String(e.kind)+'\t'+sha256(String(e.data_json))+'\n').join(''));
      return{relation,argumentsBytes:Buffer.byteLength(String(arguments_json)),origin:this.store.db.prepare('SELECT * FROM agent_child_executions WHERE child_id=?').get(raw.child_id),operation:{...op,commandSha256:digest(JSON.parse(command_json)),resultSha256:result_json===null?null:sha256(result_json)},eventCount:events.length,eventsProof};
    }),budgets:this.store.budgets.summary(root),reviews:this.rows('agent_run_reviews',root.id).map(raw=>{
      const{candidate_json,children_json,decision_json,...review}=raw;return{...review,candidateSha256:sha256(String(candidate_json)),childrenSha256:sha256(String(children_json)),decisionSha256:decision_json===null?null:sha256(String(decision_json))};
    }),runOrigins:this.rows('agent_run_origins',root.id)};
  }
  arguments(node:NodeRow,id:string,raw:unknown){
    const input=resumeArgumentsSchema.parse(raw),c=this.context(node,id,input),row=this.store.db.prepare('SELECT arguments_json FROM agent_calls WHERE parent_id=? AND child_id=?').get(c.op.id,input.childId);
    requireCondition(row,404,'agent_resume_child_missing','原子操作不属于原 Task');const bytes=Buffer.from(String(row!.arguments_json));requireCondition(input.offset<=bytes.length,409,'agent_resume_argument_offset','原参数窗口越界');const end=Math.min(bytes.length,input.offset+input.length);
    return{childId:input.childId,offset:input.offset,nextOffset:end,totalBytes:bytes.length,sha256:sha256(String(row!.arguments_json)),dataBase64:bytes.subarray(input.offset,end).toString('base64'),eof:end===bytes.length};
  }

  snapshot(node:NodeRow,id:string,raw:unknown){const b=modelBindingSchema.parse(raw),c=this.context(node,id,b),snapshotJson=JSON.stringify(this.effectSnapshot(c.op));return{snapshotJson,snapshotSha256:sha256(snapshotJson)};}
  plan(node:NodeRow,id:string,raw:unknown){const input=resumePlanSchema.parse(raw);return this.store.transaction(()=>{
    const c=this.context(node,id,input),old=this.store.db.prepare('SELECT * FROM agent_resume_plans WHERE execution_id=?').get(id),identity=digest(input);
    if(old){requireCondition(old.identity_sha256===identity,409,'agent_resume_plan_conflict','恢复计划已固定');return JSON.parse(String(old.plan_json));}
    requireCondition(input.consumedRuns<c.command.maxRuns&&input.consumedCalls<c.command.maxCalls,409,'agent_resume_budget','原生恢复不能增加原预算');
    const rows=this.store.budgets.rows(c.op),slot=rows[input.consumedRuns];
    requireCondition(input.consumedRuns<=rows.length&&rows.slice(input.consumedRuns).length<=1&&rows.slice(input.consumedRuns).every(r=>!r.actual&&!r.charge_floor&&!r.closed_for_resume&&r.admitted_cap===null),409,'agent_resume_run_slot','原预占 Run 与恢复消费前缀冲突');
    const reviews=this.rows('agent_run_reviews',c.op.id),last=reviews.at(-1),decision=last?.decision_json?JSON.parse(String(last.decision_json)):null;
    const next=last?.run_number===input.consumedRuns&&decision?.decision==='continue'?decision.nextRunId:null;
    requireCondition(!slot||!next||slot.run_id===next,409,'agent_resume_run_slot','原反馈决定与预占 Run 不符');
    const planJson=JSON.stringify({version:1,taskId:c.op.id,executionId:id,generation:c.generation,runId:slot?.run_id??next??randomUUID(),runNumber:input.consumedRuns+1,consumedRuns:input.consumedRuns,consumedCalls:input.consumedCalls,fenceSha256:c.attempt.expected_fence_sha256,instructionSha256:c.attempt.instruction_sha256,parentDeadlineUnixMs:c.task.deadline_unix_ms,taskAccepted:false}),plan={planJson,planSha256:sha256(planJson)};
    this.store.db.prepare('INSERT INTO agent_resume_plans VALUES(?,?,?,?)').run(id,identity,JSON.stringify(plan),this.store.now());return plan;
  });}
  receipt(id:string){return this.store.db.prepare('SELECT * FROM agent_resume_receipts WHERE execution_id=?').get(id);}
  assertHistoricalModels(snapshot:ReturnType<AgentResumes['effectSnapshot']>,c:AgentExecutionContext){
    for(const {model,modelSha256,owner,stopSha256} of snapshot.models){
      requireCondition(owner&&owner.execution_id!==c.execution.id&&owner.lock_identity===this.store.owner.lockIdentity&&[7,9,10].includes(Number(owner.protocol_version)),409,'agent_resume_model_owner','历史模型缺准确的同锁运输归属');
      const origin=this.store.executions.resolve(c.op.user_id,String(owner!.execution_id));
      requireCondition(origin.op.id===c.op.id&&origin.generation===owner!.generation&&(owner!.protocol_version!==7||origin.generation===1),409,'agent_resume_model_owner','模型执行或旧版 owner 归属不符');
      const exited=owner!.instance_id!==this.store.owner.instanceId,joined=owner!.phase==='joined'&&owner!.joined_at!==null;
      requireCondition(exited||joined,409,'agent_model_transport_not_joined','原模型运输仍须实际结束');
      if(model.state!=='stream_complete'){
        const stop=this.store.db.prepare('SELECT receipt_json FROM agent_model_stops WHERE parent_id=? AND request_id=?').get(c.op.id,model.request_id);const receipt=stop?JSON.parse(String(stop.receipt_json)):null;requireCondition(stop&&sha256(String(stop.receipt_json))===stopSha256,409,'agent_resume_model_unsettled','原停止回执已变化');
        requireCondition(receipt?.transportStopped===true&&receipt.executionId===owner!.execution_id&&receipt.generation===owner!.generation&&receipt.ownerInstanceId===owner!.instance_id&&receipt.runId===model.run_id&&receipt.bodySha256===model.body_sha256&&receipt.routeHash===owner!.route_hash&&receipt.originalStateSha256===modelSha256,409,'agent_resume_model_unsettled','未知原请求须有准确的停止回执，状态与预占不改变');
      }
    }
  }
  reconcile(node:NodeRow,id:string,raw:unknown){const input=resumeReconcileSchema.parse(raw);return this.store.transaction(()=>{
    const c=this.context(node,id,input),identity=digest(input),old=this.receipt(id);
    if(old){requireCondition(old.identity_sha256===identity,409,'agent_resume_receipt_conflict','恢复回执不能替换');return{receiptJson:old.receipt_json,receiptSha256:old.receipt_sha256};}
    const stored=this.store.db.prepare('SELECT plan_json FROM agent_resume_plans WHERE execution_id=?').get(id),envelope=stored?JSON.parse(String(stored.plan_json)):null;
    requireCondition(envelope?.planSha256===input.planSha256,409,'agent_resume_plan','原恢复计划不符');const plan=JSON.parse(envelope.planJson);
    requireCondition(sha256(input.reviewJson)===input.reviewSha256&&input.review.sha256===input.reviewSha256&&sha256(input.nativeReceiptJson)===input.nativeReceiptSha256,409,'agent_resume_hash','锁内原件摘要不符');
    const review=JSON.parse(input.reviewJson),native=nativeResumeReceiptSchema.parse(JSON.parse(input.nativeReceiptJson));
    requireCondition(review.task_id===c.op.id&&review.consumed_runs===plan.consumedRuns&&review.consumed_calls===plan.consumedCalls&&review.fence.task_id===c.op.id&&review.fence.authorization_revision===c.op.payload_hash&&review.fence.max_runs===c.command.maxRuns&&review.fence.max_calls===c.command.maxCalls&&review.fence.session_path===review.session_path,409,'agent_resume_native_review','原生锁内复核与原 Task 不符');
    const snapshot=this.effectSnapshot(c.op);requireCondition(sha256(JSON.stringify(snapshot))===input.snapshotSha256,409,'agent_resume_snapshot_changed','原效果账本已变化，须重新核对');this.assertHistoricalModels(snapshot,c);
    requireCondition(snapshot.children.every(ch=>['succeeded','failed','cancelled'].includes(ch.operation.execution)),409,'agent_resume_child_unsettled','原子操作仍有未知效果');
    const open=review.interrupted_run?.open_tool_calls??[];requireCondition(Array.isArray(open)&&native.tool_calls.length===open.length,409,'agent_resume_open_calls','须按原生顺序核对全部开放工具');
    for(const [i,call]of open.entries()){
      const settlement=native.tool_calls[i]!,child=snapshot.children.find(ch=>ch.relation.run_id===review.interrupted_run.run_id&&ch.relation.call_id===call.id);
      requireCondition(call.name==='reach_execute'&&call.id===settlement.call_id,409,'agent_resume_open_calls','开放工具身份不符');
      if(child)requireCondition(digest(JSON.parse(String(this.store.db.prepare('SELECT arguments_json FROM agent_calls WHERE parent_id=? AND child_id=?').get(c.op.id,child.relation.child_id)!.arguments_json)))===digest(call.arguments)&&settlement.settlement.kind===(child.operation.execution==='succeeded'?'completed':'failed'),409,'agent_resume_tool_result','开放工具与原子操作参数或结果不符');
      else requireCondition(settlement.settlement.kind==='not_executed',409,'agent_resume_tool_result','没有原子操作时只能证明未创建');
    }
    requireCondition(input.consumption.consumedRuns===plan.consumedRuns&&input.consumption.consumedCalls===plan.consumedCalls&&input.consumption.fenceSha256===c.attempt.expected_fence_sha256&&input.consumption.reviewSha256===input.reviewSha256,409,'agent_resume_consumption','锁内消费不符');
    this.store.budgets.recordNativeConsumption(c.op,input.consumption);
    if(!this.store.budgets.rows(c.op).some(r=>r.run_id===plan.runId)){
      this.store.db.prepare('INSERT INTO agent_runs VALUES(?,?)').run(c.op.id,plan.runId);this.store.budgets.register(c.op,plan.runId);this.register(c.op,plan.runId);
    }
    const slot=this.store.budgets.rows(c.op).find(r=>r.run_id===plan.runId);requireCondition(slot?.run_number===plan.runNumber,409,'agent_resume_run_slot','恢复首 Run 不能另占槽');
    const receiptJson=JSON.stringify({version:1,taskId:c.op.id,executionId:id,generation:c.generation,planSha256:input.planSha256,snapshotSha256:input.snapshotSha256,reviewSha256:input.reviewSha256,nativeReceiptSha256:input.nativeReceiptSha256,runId:plan.runId,runNumber:plan.runNumber,consumedRuns:plan.consumedRuns,consumedCalls:plan.consumedCalls,sessionPath:review.session_path,deadlineLocalUnixMs:review.fence.deadline_unix_ms,originalTask:input.originalTask,review:input.review,taskAccepted:false}),receiptSha256=sha256(receiptJson);
    this.store.db.prepare('INSERT INTO agent_resume_receipts VALUES(?,?,?,?,?,?,?)').run(id,c.op.id,identity,JSON.stringify(input),receiptJson,receiptSha256,this.store.now());
    for(const {model,modelSha256,owner,stopSha256}of snapshot.models)this.store.db.prepare('INSERT INTO agent_resume_models VALUES(?,?,?,?,?,?)').run(id,c.op.id,model.request_id,modelSha256,digest(owner),stopSha256);
    return{receiptJson,receiptSha256};
  });}
  admitted(c:AgentExecutionContext){return !this.store.finalizations.isFinalizer(c.execution)&&(c.generation===1||!!this.store.db.prepare('SELECT 1 FROM agent_run_origins WHERE parent_id=? AND admitted_execution_id=? AND admitted_generation=? LIMIT 1').get(c.op.id,c.execution.id,c.generation));}
  assertRun(parent:OperationRow,runId:string){const c=this.store.executions.resolve(parent.user_id,this.store.executions.current(parent).id);if(c.generation===1)return;const r=this.store.db.prepare('SELECT * FROM agent_run_origins WHERE parent_id=? AND run_id=?').get(parent.id,runId);requireCondition(r?.admitted_execution_id===c.execution.id&&r?.admitted_generation===c.generation,409,'agent_resume_run_unadmitted','效果须属于本代真实准入 Run');}
  admit(node:NodeRow,id:string,raw:unknown){const input=resumeAdmissionSchema.parse(raw);return this.store.transaction(()=>{
    const c=this.context(node,id,input),stored=this.receipt(id);requireCondition(stored?.receipt_sha256===input.receiptSha256,409,'agent_resume_receipt','准入前须提交原恢复回执');const receipt=JSON.parse(String(stored!.receipt_json)),a=input.nativeAdmission;
    const rows=this.store.budgets.rows(c.op),slot=rows.find(r=>r.run_id===input.runId),origin=this.store.db.prepare('SELECT * FROM agent_run_origins WHERE parent_id=? AND run_id=?').get(c.op.id,input.runId),remaining=c.command.maxCalls-this.store.budgets.summary(c.op).chargedCalls;
    requireCondition(slot&&origin&&input.sessionPath===receipt.sessionPath&&input.deadlineLocalUnixMs===receipt.deadlineLocalUnixMs&&a.task_id===c.op.id&&a.run_id===input.runId&&a.run_number===slot.run_number&&a.authorization_revision===c.op.payload_hash&&a.session_path===receipt.sessionPath&&a.deadline_unix_ms===receipt.deadlineLocalUnixMs,409,'agent_resume_admission_binding','准入原件须绑定原 Task、Session、deadline 和准确 Run');
    const source=JSON.stringify(input);
    if(origin!.admitted_execution_id){requireCondition(origin!.admitted_execution_id===id&&origin!.admitted_generation===c.generation&&origin!.admission_json===source,409,'agent_resume_admission_conflict','原生准入 owner 不能改写');return{admitted:true,runId:input.runId,generation:c.generation,taskAccepted:false};}
    requireCondition(!slot!.closed_for_resume&&slot!.actual===0&&slot!.charge_floor===0&&a.remaining_calls===Math.min(c.command.runCallLimit??c.command.maxCalls,remaining)&&a.remaining_calls<=slot!.reserved_cap&&a.run_number>=receipt.runNumber,409,'agent_resume_admission_budget','实际准入与原 Run 首次额度不符');
    if(a.run_number!==receipt.runNumber){requireCondition(origin!.registered_execution_id===id&&origin!.registered_generation===c.generation,409,'agent_resume_admission_binding','后继 Run 注册须属于本代');this.store.reviews.authorizeNewRun(c.op,input.runId,a.run_number-1);}
    this.store.db.prepare('UPDATE agent_run_origins SET admitted_execution_id=?,admitted_generation=?,admission_json=? WHERE parent_id=? AND run_id=? AND admitted_execution_id IS NULL').run(id,c.generation,source,c.op.id,input.runId);
    this.store.db.prepare('UPDATE agent_run_budgets SET admitted_cap=? WHERE parent_id=? AND run_id=?').run(a.remaining_calls,c.op.id,input.runId);
    this.store.db.prepare("UPDATE agent_executions SET phase='active' WHERE execution_id=?").run(id);return{admitted:true,runId:input.runId,generation:c.generation,taskAccepted:false};
  });}
  explainsModel(parentId:string,requestId:string,finishedOnly=false,executionId?:string){
    const task=this.store.db.prepare('SELECT active_execution_id FROM agent_tasks WHERE root_id=?').get(parentId);if(!task)return false;
    if(finishedOnly&&!this.store.db.prepare('SELECT 1 FROM agent_task_finishes WHERE root_id=? AND execution_id=?').get(parentId,task.active_execution_id))return false;
    const row=this.store.db.prepare('SELECT * FROM agent_resume_models WHERE execution_id=? AND parent_id=? AND request_id=?').get(executionId??this.store.finalizations.sourceForCurrent(parentId)??task.active_execution_id,parentId,requestId);if(!row)return false;
    const model=this.store.db.prepare('SELECT * FROM agent_model_calls WHERE parent_id=? AND request_id=?').get(parentId,requestId),owner=this.store.db.prepare('SELECT o.*,i.lock_identity,i.protocol_version FROM agent_model_owners o LEFT JOIN agent_service_instances i ON i.instance_id=o.instance_id WHERE parent_id=? AND request_id=?').get(parentId,requestId),stop=this.store.db.prepare('SELECT receipt_json FROM agent_model_stops WHERE parent_id=? AND request_id=?').get(parentId,requestId);
    return !!model&&digest(model)===row.model_sha256&&digest(owner)===row.owner_sha256&&!!stop&&sha256(String(stop.receipt_json))===row.stop_sha256;
  }
  finalSnapshot(node:NodeRow,id:string,raw:unknown){const b=modelBindingSchema.parse(raw),c=this.context(node,id,b,false);requireCondition(this.admitted(c),409,'agent_resume_run_unadmitted','原生恢复尚未准入');const snapshot=this.effectSnapshot(c.op);if(snapshot.models.some(m=>m.owner?.instance_id===this.store.owner.instanceId&&(m.owner.phase!=='joined'||m.owner.joined_at===null)))return{ready:false};const snapshotJson=JSON.stringify(snapshot);return{ready:true,snapshotJson,snapshotSha256:sha256(snapshotJson)};}
  finish(op:OperationRow,state:string,data:any,eventId:string){
    if(!this.store.executions.isAgent(op)||!data?.finalProof)return;
    const c=this.store.executions.resolve(op.user_id,op.id),proof=resumeFinalSchema.parse(data.finalProof),receipt=this.receipt(op.id);
    requireCondition(c.generation>1&&c.task.active_execution_id===op.id&&c.task.requires_reconciliation===1&&this.admitted(c)&&receipt?.receipt_sha256===proof.receiptSha256&&['succeeded','failed'].includes(state),409,'agent_resume_final_binding','释放须属于本代准入与准确终态事件');
    const snapshot=this.effectSnapshot(c.op);requireCondition(sha256(JSON.stringify(snapshot))===proof.snapshotSha256&&snapshot.children.every(ch=>['succeeded','failed','cancelled'].includes(ch.operation.execution))&&!this.store.models.unsettled(c.op.id),409,'agent_resume_final_effects','释放前须核清完整原效果集合');
    requireCondition(snapshot.models.every(m=>m.owner&& (m.owner.instance_id!==this.store.owner.instanceId||(m.owner.phase==='joined'&&m.owner.joined_at!==null))),409,'agent_resume_final_effects','释放前须等待当前模型运输实际 join');
    requireCondition(proof.observedCalls===data.outcome?.observed_calls&&proof.observedCalls===this.store.budgets.summary(c.op).chargedCalls&&data.taskId===c.op.id&&data.sessionId===c.command.sessionId&&data.taskAccepted===false&&['awaiting_review','budget_or_feedback_incomplete'].includes(data.status),409,'agent_resume_final_result','终态及累计消费与原 Task 不符');
    requireCondition(data.outcome?.task_id===c.op.id&&data.outcome.task_accepted===false&&data.outcome.fence_presence==='Released'&&data.outcome.last_receipt?.basis?.run_id===proof.lastRunId&&((state==='succeeded'&&data.status==='awaiting_review'&&data.outcome.stop==='AwaitingHostAcceptance')||(state==='failed'&&data.status==='budget_or_feedback_incomplete'&&['BudgetExhausted','NeedsChanges'].includes(data.outcome.stop))),409,'agent_resume_final_result','原生释放、Run 与终态原因不符');
    this.assertRun(c.op,proof.lastRunId);
    this.store.db.prepare('INSERT INTO agent_task_finishes VALUES(?,?,?,?,?,?)').run(c.op.id,op.id,c.generation,eventId,JSON.stringify(proof),this.store.now());
    requireCondition(this.store.db.prepare('UPDATE agent_tasks SET requires_reconciliation=0 WHERE root_id=? AND active_execution_id=? AND generation=? AND requires_reconciliation=1').run(c.op.id,op.id,c.generation).changes===1,409,'agent_resume_final_binding','释放时本代已变化');
  }
}
