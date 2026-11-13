// Copyright (c) Ray Zhang. Delegation relationships reuse Reach operations and receipts.
import {randomUUID,createHash} from 'node:crypto';
import {basicCommandSchema,delegateSchema,delegatedCallSchema,finalStates} from '../contracts/protocol.ts';
import {checkTargetDirectory} from '../contracts/device-target.ts';
import {deviceCommand} from './desk-devices.ts';
import {requireCondition} from './errors.ts';
import {digest} from './store.ts';
import type {ReachStore,OperationRow,NodeRow,ControlRow} from './store.ts';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export class AgentCalls {
  readonly store:ReachStore;
  constructor(store:ReachStore){this.store=store;}
  validate(command:ReturnType<typeof delegateSchema.parse>,node:NodeRow){
    requireCondition((command.runCallLimit??command.maxCalls)<=command.maxCalls,400,'agent_run_call_limit','单 Run 调用上限不能超过原 Task 总预算');
    checkTargetDirectory(node.platform,command.cwd);let bytes=0;const ids=new Set<string>();for(const source of command.sources){requireCondition(!ids.has(source.id)&&hash(source.text)===source.sha256&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(source.text),400,'agent_source_invalid','任务来源标识、原文或摘要不符');ids.add(source.id);bytes+=Buffer.byteLength(source.text);}requireCondition(bytes<=65536,413,'agent_sources_too_large','任务来源原文合计超过 64 KiB');
    const busy=this.store.db.prepare("SELECT p.id FROM agent_tasks t JOIN operations r ON r.id=t.root_id JOIN operations p ON p.id=t.active_execution_id WHERE r.node_id=? AND r.epoch=? AND json_extract(r.command_json,'$.sessionId')=? AND (t.requires_reconciliation=1 OR p.execution IN ('not_observed','received','running','unknown')) LIMIT 1").get(node.id,node.epoch,command.sessionId);
    requireCondition(!busy,409,'agent_session_unsettled','原现场会话尚未结算，请核对原任务');
    const uncertain=this.store.db.prepare("SELECT c.child_id FROM agent_calls c JOIN operations p ON p.id=c.parent_id JOIN operations child ON child.id=c.child_id WHERE p.node_id=? AND p.epoch=? AND json_extract(p.command_json,'$.sessionId')=? AND child.execution IN ('not_observed','received','running','unknown') LIMIT 1").get(node.id,node.epoch,command.sessionId);
    requireCondition(!uncertain,409,'agent_session_unsettled','原现场会话仍有未结算子操作');
    const modelUnsettled=this.store.db.prepare("SELECT 1 FROM agent_model_calls c JOIN operations p ON p.id=c.parent_id WHERE p.node_id=? AND p.epoch=? AND json_extract(p.command_json,'$.sessionId')=? AND c.state<>'stream_complete' LIMIT 1").get(node.id,node.epoch,command.sessionId);requireCondition(!modelUnsettled,409,'agent_session_unsettled','原现场会话仍有在途或未知模型请求');
  }
  parent(node:NodeRow,id:string,dispatchId:string,payloadHash:string,active=true){
    return this.store.executions.node(node,id,dispatchId,payloadHash,active);
  }
  list(parent:OperationRow){const root=this.store.executions.root(parent);return this.store.db.prepare('SELECT c.run_id,c.call_id,c.tool,c.args_sha256,c.command_sha256,c.child_id,o.dispatch_id,o.payload_hash,o.execution,o.delivery FROM agent_calls c JOIN operations o ON o.id=c.child_id WHERE c.parent_id=? ORDER BY c.rowid').all(root.id);}
  create(node:NodeRow,parentId:string,raw:unknown){
    const input=delegatedCallSchema.parse(raw);requireCondition(hash(input.argumentsJson)===input.argsSha256,400,'agent_arguments_hash','原工具参数摘要不符');const args=JSON.parse(input.argumentsJson);requireCondition(Object.keys(args).length===1&&Object.hasOwn(args,'command'),400,'agent_arguments_invalid','委托工具只接收一个 command');const rawCommand=basicCommandSchema.parse(args.command);
    return this.store.transaction(()=>{
      const {op:parent,command:task,execution,generation}=this.parent(node,parentId,input.dispatchId,input.payloadHash,false),key=hash(JSON.stringify([input.runId,input.callId]));
      const previous=this.store.db.prepare('SELECT * FROM agent_calls WHERE parent_id=? AND call_key=?').get(parent.id,key) as {tool:string;args_sha256:string;arguments_json:string;child_id:string}|undefined;
      if(previous){
        requireCondition(previous.tool===input.tool&&previous.args_sha256===input.argsSha256&&previous.arguments_json===input.argumentsJson,409,'agent_call_conflict','原工具调用内容已变化');
        const origin=this.store.db.prepare('SELECT * FROM agent_child_executions WHERE child_id=?').get(previous.child_id);
        requireCondition(origin&&origin.root_id===parent.id,409,'agent_execution_binding','原子操作执行归属不符');
        const owner=this.store.executions.resolve(parent.user_id,String(origin.execution_id)),child=this.store.operation(parent.user_id,previous.child_id);
        requireCondition(owner.op.id===parent.id&&owner.generation===origin.generation&&child.node_id===parent.node_id&&child.epoch===parent.epoch,409,'agent_execution_binding','原子操作须属于准确的历史执行');
        return {operation:this.dispatch(child),current:child,duplicate:true,evidenceOnly:origin.execution_id!==execution.id,originExecutionId:origin.execution_id,originGeneration:origin.generation,parentDeadlineUnixMs:parent.claimed_at!+task.maxSeconds*1000};
      }
      this.parent(node,parentId,input.dispatchId,input.payloadHash);
      this.store.reviews.assertRunWritable(parent,input.runId);
      this.store.budgets.assertWritable(parent,input.runId);
      this.store.models.assertSettled(parent);
      requireCondition(this.list(parent).length<task.maxToolCalls,409,'agent_tool_budget','原委托已用完工具次数');
      this.store.models.reserveRun(parent,input.runId,task.maxRuns);
      const deadline=parent.claimed_at!+task.maxSeconds*1000,remaining=deadline-this.store.now();requireCondition(remaining>=100,409,'agent_deadline','原委托剩余时间不足，未创建子操作');
      const command=deviceCommand({nodeId:parent.node_id,epoch:parent.epoch,cwd:task.cwd,platform:node.platform},rawCommand),requestId=randomUUID();if(command.kind==='command.run'||command.kind==='desktop.call'||command.kind==='desktop.describe')command.timeoutMs=Math.min(command.timeoutMs,remaining);
      const child=this.store.submit(parent.user_id,requestId,parent.node_id,command,parent.epoch),dispatchId=randomUUID();
      this.store.db.prepare("UPDATE operations SET delivery='claimed',dispatch_id=?,claimed_at=?,updated_at=? WHERE id=? AND delivery='queued'").run(dispatchId,this.store.now(),this.store.now(),child.id);
      this.store.db.prepare('INSERT INTO agent_calls(parent_id,call_key,run_id,call_id,tool,args_sha256,arguments_json,command_sha256,child_id) VALUES(?,?,?,?,?,?,?,?,?)').run(parent.id,key,input.runId,input.callId,input.tool,input.argsSha256,input.argumentsJson,digest(command),child.id);this.store.audit(node.id,'agent.child_claimed',child.id);
      this.store.db.prepare('INSERT INTO agent_child_executions VALUES(?,?,?,?)').run(child.id,parent.id,execution.id,generation);
      const current=this.store.operation(parent.user_id,child.id);return {operation:this.dispatch(current),current,duplicate:false,parentDeadlineUnixMs:deadline};
    });
  }
  dispatch(op:OperationRow){return {operationId:op.id,nodeId:op.node_id,epoch:op.epoch,dispatchId:op.dispatch_id,payloadHash:op.payload_hash,command:JSON.parse(op.command_json),createdAt:op.created_at};}
  control(node:NodeRow,op:ControlRow):ControlRow&{parentOperationId?:string;parentDeadlineUnixMs?:number}{
    const relation=this.store.db.prepare('SELECT c.parent_id,e.execution_id,e.generation FROM agent_calls c LEFT JOIN agent_child_executions e ON e.child_id=c.child_id WHERE c.child_id=?').get(op.id);
    if(!relation)return op;
    requireCondition(relation.execution_id,409,'agent_execution_missing','原子操作执行归属缺失');
    const context=this.store.executions.resolve(node.user_id,String(relation.execution_id)),parent=context.execution,deadline=context.task.deadline_unix_ms;
    requireCondition(context.op.id===relation.parent_id&&context.generation===relation.generation,409,'agent_execution_binding','原子操作所属执行不符');
    return {...op,cancel_requested:op.cancel_requested||parent.cancel_requested||parent.execution!=='running'||context.task.active_execution_id!==parent.id||context.attempt.phase!=='active'||context.task.requires_reconciliation||deadline===null||this.store.now()>=deadline?1:0,parentOperationId:context.op.id,parentDeadlineUnixMs:deadline??0};
  }
  cancelChildren(op:OperationRow){
    if(!this.store.executions.isAgent(op))return;
    for(const row of this.store.db.prepare('SELECT child_id FROM agent_child_executions WHERE execution_id=?').all(op.id)){const child=this.store.operation(op.user_id,String(row.child_id));if(!finalStates.has(child.execution))this.store.cancel(op.user_id,child.id);}
  }
  settle(op:OperationRow,state:string,data:unknown,historicalEvidence=false){
    if(!this.store.executions.isAgent(op))return;
    const context=this.store.executions.resolve(op.user_id,op.id),root=context.op;
    if(state==='succeeded'){
      requireCondition(context.attempt.phase==='active'&&((context.task.active_execution_id===op.id&&!context.task.requires_reconciliation)||historicalEvidence),409,'agent_execution_reconciling','恢复尚未核清原生会话，不能声明成功');
      this.store.models.assertSettled(root);
      this.store.reviews.assertReturn(root,data);
      const result=data as any;requireCondition(result?.taskAccepted===false&&result?.taskId===root.id&&result?.sessionId===context.command.sessionId&&result?.status==='awaiting_review',409,'agent_result_invalid','委托完成须保留原 Task 与待复核状态');
      const children=this.list(root);requireCondition(children.every(c=>['succeeded','failed','cancelled'].includes(String(c.execution))),409,'agent_children_unsettled','仍有未结算或未知的子操作');
      requireCondition(Array.isArray(result.childOperationIds)&&result.childOperationIds.length===children.length&&new Set(result.childOperationIds).size===children.length&&children.every(c=>result.childOperationIds.includes(c.child_id)),409,'agent_child_set_mismatch','委托结果必须引用完整原子操作集合');
    }
  }
}
