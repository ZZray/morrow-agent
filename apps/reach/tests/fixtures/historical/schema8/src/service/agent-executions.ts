// Copyright (c) Ray Zhang. Original Task authority is separate from each dispatched execution.
import {delegateSchema,resumeSchema} from '../contracts/protocol.ts';
import {digest,sha256} from './store.ts';
import {requireCondition} from './errors.ts';
import type {NodeRow,OperationRow,ReachStore} from './store.ts';

interface TaskRow {root_id:string;active_execution_id:string;generation:number;deadline_unix_ms:number|null;requires_reconciliation:number}
interface ExecutionRow {execution_id:string;root_id:string;previous_execution_id:string|null;generation:number;expected_fence_sha256:string|null;instruction_sha256:string|null;phase:'active'|'reconciling'}
export interface AgentExecutionContext {
  op:OperationRow;command:ReturnType<typeof delegateSchema.parse>;execution:OperationRow;
  task:TaskRow;attempt:ExecutionRow;generation:number;
}

export class AgentExecutions {
  readonly store:ReachStore;
  constructor(store:ReachStore){this.store=store;}
  private task(id:string){return this.store.db.prepare('SELECT * FROM agent_tasks WHERE root_id=?').get(id) as unknown as TaskRow|undefined;}
  private attempt(id:string){return this.store.db.prepare('SELECT * FROM agent_executions WHERE execution_id=?').get(id) as unknown as ExecutionRow|undefined;}
  isAgent(op:OperationRow){return ['agent.delegate','agent.resume'].includes(JSON.parse(op.command_json).kind);}
  addRoot(op:OperationRow){
    const command=delegateSchema.parse(JSON.parse(op.command_json));
    const deadline=op.claimed_at===null?null:op.claimed_at+command.maxSeconds*1000;
    this.store.db.prepare('INSERT INTO agent_tasks VALUES(?,?,1,?,0)').run(op.id,op.id,deadline);
    this.store.db.prepare("INSERT INTO agent_executions VALUES(?,?,NULL,1,NULL,NULL,'active')").run(op.id,op.id);
  }
  migrate(fromVersion:number){
    for(const row of this.store.db.prepare("SELECT * FROM operations WHERE json_extract(command_json,'$.kind')='agent.delegate' ORDER BY rowid").all() as unknown as OperationRow[]){
      if(!this.task(row.id)||!this.attempt(row.id)){
        requireCondition(fromVersion<8&&!this.task(row.id)&&!this.attempt(row.id),409,'agent_execution_migration','原 Task 执行关系缺失，不能推断接管');
        this.addRoot(row);
      }
    }
    for(const row of this.store.db.prepare("SELECT * FROM operations WHERE json_extract(command_json,'$.kind') IN ('agent.delegate','agent.resume')").all() as unknown as OperationRow[])this.resolve(row.user_id,row.id);
    // Historical children belong to the original execution. Do not fabricate native admission.
    for(const row of this.store.db.prepare('SELECT c.parent_id,c.child_id FROM agent_calls c LEFT JOIN agent_child_executions e ON e.child_id=c.child_id WHERE e.child_id IS NULL').all()){
      requireCondition(fromVersion<8,409,'agent_execution_migration','原子操作执行归属缺失');
      this.store.db.prepare('INSERT INTO agent_child_executions VALUES(?,?,?,1)').run(row.child_id,row.parent_id,row.parent_id);
    }
    for(const row of this.store.db.prepare('SELECT root_id FROM agent_tasks').all())this.resolve(String(this.store.db.prepare('SELECT user_id FROM operations WHERE id=?').get(row.root_id)!.user_id),String(row.root_id));
    for(const row of this.store.db.prepare('SELECT execution_id FROM agent_executions').all())this.resolve(String(this.store.db.prepare('SELECT user_id FROM operations WHERE id=?').get(row.execution_id)!.user_id),String(row.execution_id));
    const badChild=this.store.db.prepare(`SELECT e.child_id FROM agent_child_executions e LEFT JOIN agent_calls c ON c.child_id=e.child_id LEFT JOIN agent_executions x ON x.execution_id=e.execution_id
      LEFT JOIN operations child ON child.id=e.child_id LEFT JOIN operations root ON root.id=e.root_id
      WHERE c.child_id IS NULL OR x.execution_id IS NULL OR child.id IS NULL OR root.id IS NULL OR c.parent_id<>e.root_id OR x.root_id<>e.root_id OR x.generation<>e.generation OR child.user_id<>root.user_id OR child.node_id<>root.node_id OR child.epoch<>root.epoch LIMIT 1`).get();
    requireCondition(!badChild,409,'agent_execution_migration','原子操作与执行关系冲突');
  }
  claimed(op:OperationRow){
    if(JSON.parse(op.command_json).kind!=='agent.delegate')return;
    const command=delegateSchema.parse(JSON.parse(op.command_json)),task=this.task(op.id),deadline=op.claimed_at!+command.maxSeconds*1000;
    requireCondition(task&&task.active_execution_id===op.id&&task.generation===1&&(task.deadline_unix_ms===null||task.deadline_unix_ms===deadline),409,'agent_deadline_changed','原 Task 截止时间不能重置');
    this.store.db.prepare('UPDATE agent_tasks SET deadline_unix_ms=? WHERE root_id=? AND deadline_unix_ms IS NULL').run(deadline,op.id);
    this.resolve(op.user_id,op.id);
  }
  resolve(userId:string,id:string):AgentExecutionContext{
    const execution=this.store.operation(userId,id),attempt=this.attempt(id);
    requireCondition(attempt,409,'agent_execution_missing','原现场执行关系缺失');
    const op=this.store.operation(userId,attempt.root_id),command=delegateSchema.parse(JSON.parse(op.command_json)),task=this.task(op.id);
    requireCondition(task&&execution.node_id===op.node_id&&execution.epoch===op.epoch&&digest({nodeId:op.node_id,epoch:op.epoch,command:JSON.parse(op.command_json)})===op.payload_hash&&digest({nodeId:execution.node_id,epoch:execution.epoch,command:JSON.parse(execution.command_json)})===execution.payload_hash,409,'agent_execution_binding','原 Task 与本次执行权威不符');
    if(execution.id===op.id)requireCondition(attempt.generation===1&&attempt.previous_execution_id===null&&attempt.expected_fence_sha256===null&&attempt.instruction_sha256===null&&attempt.phase==='active',409,'agent_execution_binding','初始执行关系不符');
    else{
      const resume=resumeSchema.parse(JSON.parse(execution.command_json)),previous=this.attempt(resume.previousExecutionId);
      requireCondition(resume.rootOperationId===op.id&&attempt.previous_execution_id===resume.previousExecutionId&&previous?.root_id===op.id&&previous.generation+1===attempt.generation&&attempt.expected_fence_sha256===resume.fenceSha256&&attempt.instruction_sha256===sha256(resume.instruction)&&attempt.phase==='reconciling',409,'agent_execution_binding','恢复执行关联或阶段不符');
    }
    const active=this.attempt(task!.active_execution_id);
    requireCondition(active?.root_id===op.id&&active.generation===task!.generation&&Number.isSafeInteger(task!.generation)&&task!.generation>=attempt.generation,409,'agent_execution_binding','原 Task 活跃代关系不符');
    requireCondition(task!.requires_reconciliation===(task!.generation>1?1:0),409,'agent_execution_binding','原 Task 恢复阶段缺失，不能推断已经核清');
    const deadline=op.claimed_at===null?null:op.claimed_at+command.maxSeconds*1000;
    requireCondition(task!.deadline_unix_ms===deadline,409,'agent_deadline_changed','原 Task 截止时间与首次派发不符');
    return {op,command,execution,task:task!,attempt,generation:attempt.generation};
  }
  root(op:OperationRow){return this.isAgent(op)?this.resolve(op.user_id,op.id).op:op;}
  node(node:NodeRow,id:string,dispatchId:string,payloadHash:string,active=true){
    const context=this.resolve(node.user_id,id),{execution,task,attempt}=context;
    requireCondition(execution.node_id===node.id&&execution.epoch===node.epoch,404,'operation_not_found','未找到这次操作');
    requireCondition(execution.dispatch_id===dispatchId&&execution.payload_hash===payloadHash,409,'agent_parent_binding','委托须对应本次原派发');
    if(active){
      const current=this.store.ownedNode(node.user_id,node.id);
      requireCondition(task.active_execution_id===execution.id&&task.generation===attempt.generation,409,'agent_execution_superseded','旧执行不能再新增效果');
      requireCondition(attempt.phase==='active'&&!task.requires_reconciliation,409,'agent_execution_reconciling','恢复执行仍须核对原生会话与全部效果');
      requireCondition(!current.revoked&&current.epoch===node.epoch&&!execution.cancel_requested&&execution.execution==='running'&&execution.delivery==='acknowledged',409,'agent_parent_inactive','本次委托尚未运行或已停止');
      requireCondition(task.deadline_unix_ms!==null&&this.store.now()<task.deadline_unix_ms,409,'agent_deadline','原委托已到截止时间');
    }
    return context;
  }
  addResume(op:OperationRow){
    const input=resumeSchema.parse(JSON.parse(op.command_json)),context=this.resolve(op.user_id,input.previousExecutionId),{op:root,execution:previous,task}=context;
    requireCondition(root.id===input.rootOperationId&&op.node_id===root.node_id&&op.epoch===root.epoch,409,'agent_resume_binding','恢复须沿原 Task、设备及配对');
    requireCondition(task.active_execution_id===previous.id&&task.generation===context.generation,409,'agent_resume_superseded','原执行已被其他恢复取代');
    const abandoned=context.attempt.phase==='reconciling'&&previous.execution==='cancelled'&&previous.delivery==='cancelled'&&previous.dispatch_id===null&&previous.claimed_at===null;
    requireCondition(['unknown','failed','cancelled'].includes(previous.execution)&&((previous.dispatch_id!==null&&previous.claimed_at!==null)||abandoned)&&root.dispatch_id!==null&&root.claimed_at!==null,409,'agent_resume_previous_active','仅可关联已停止或未知的前次执行，未派发的恢复须已明确取消');
    requireCondition(task.deadline_unix_ms!==null&&this.store.now()<task.deadline_unix_ms,409,'agent_deadline','原委托已到截止时间');
    const others=this.store.db.prepare(`SELECT p.id,p.execution,t.rowid AS ordinal FROM agent_tasks t JOIN operations r ON r.id=t.root_id JOIN operations p ON p.id=t.active_execution_id
      WHERE r.node_id=? AND r.epoch=? AND json_extract(r.command_json,'$.sessionId')=? AND r.id<>?`).all(root.node_id,root.epoch,context.command.sessionId,root.id);
    const ordinal=this.store.db.prepare('SELECT rowid AS ordinal FROM agent_tasks WHERE root_id=?').get(root.id)!.ordinal;
    requireCondition(!others.some(row=>Number(row.ordinal)>Number(ordinal)||['not_observed','received','running','unknown'].includes(String(row.execution))),409,'agent_resume_session_changed','原 Session 已有其他任务，须保留原执行证据');
    requireCondition(Number.isSafeInteger(task.generation+1),409,'agent_execution_generation','执行代数超过安全范围');
    const generation=task.generation+1;
    this.store.db.prepare("INSERT INTO agent_executions VALUES(?,?,?,?,?,?,'reconciling')").run(op.id,root.id,previous.id,generation,input.fenceSha256,sha256(input.instruction));
    requireCondition(this.store.db.prepare('UPDATE agent_tasks SET active_execution_id=?,generation=?,requires_reconciliation=1 WHERE root_id=? AND active_execution_id=? AND generation=?').run(op.id,generation,root.id,previous.id,task.generation).changes===1,409,'agent_resume_superseded','原 Task 已被其他执行接续');
  }
  current(op:OperationRow){const context=this.resolve(op.user_id,op.id);return this.store.operation(op.user_id,context.task.active_execution_id);}
  blocks(op:OperationRow){return !this.isAgent(op)||this.resolve(op.user_id,op.id).task.active_execution_id===op.id;}
  projection(userId:string,id:string){
    const context=this.resolve(userId,id),current=this.store.operation(userId,context.task.active_execution_id);
    const executions=this.store.db.prepare('SELECT e.*,o.delivery,o.execution,o.cancel_requested,o.dispatch_id,o.payload_hash FROM agent_executions e JOIN operations o ON o.id=e.execution_id WHERE e.root_id=? ORDER BY e.generation').all(context.op.id);
    return {taskId:context.op.id,taskAccepted:false,sessionId:context.command.sessionId,activeExecutionId:current.id,generation:context.task.generation,phase:this.attempt(current.id)!.phase,execution:current.execution,recoveryRequired:!!context.task.requires_reconciliation,parentDeadlineUnixMs:context.task.deadline_unix_ms,executions};
  }
  context(node:NodeRow,id:string,dispatchId:string,payloadHash:string){
    const context=this.node(node,id,dispatchId,payloadHash,false);
    const route=this.store.db.prepare('SELECT descriptor_json FROM agent_task_models WHERE parent_id=?').get(context.op.id);
    return {...this.projection(node.user_id,id),executionId:id,executionGeneration:context.generation,rootDispatch:this.store.agents.dispatch(context.op),descriptor:route?JSON.parse(String(route.descriptor_json)):null};
  }
}
