// Copyright (c) Ray Zhang. Delegation relationships reuse Reach operations and receipts.
import {randomUUID,createHash} from 'node:crypto';
import {basicCommandSchema,delegateSchema,delegatedCallSchema,finalStates} from '../contracts/protocol.ts';
import {checkTargetDirectory} from '../contracts/device-target.ts';
import {deviceCommand} from './desk-devices.ts';
import {requireCondition} from './errors.ts';
import {digest} from './store.ts';
import {AGENT_TOOL_CONTRACT_VERSION,AGENT_GUIDANCE_CAPABILITY} from '../contracts/agent-guidance.ts';
import {PROTOCOL_VERSION} from '../contracts/protocol.ts';
import type {ReachStore,OperationRow,NodeRow,ControlRow} from './store.ts';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export class AgentCalls {
  readonly store:ReachStore;
  constructor(store:ReachStore){this.store=store;}
  validate(command:ReturnType<typeof delegateSchema.parse>,node:NodeRow){
    requireCondition((command.runCallLimit??command.maxCalls)<=command.maxCalls,400,'agent_run_call_limit','单 Run 调用上限不能超过原 Task 总预算');
    checkTargetDirectory(node.platform,command.cwd);let bytes=0;const ids=new Set<string>();for(const source of command.sources){requireCondition(!ids.has(source.id)&&hash(source.text)===source.sha256&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(source.text),400,'agent_source_invalid','任务来源标识、原文或摘要不符');ids.add(source.id);bytes+=Buffer.byteLength(source.text);}requireCondition(bytes<=65536,413,'agent_sources_too_large','任务来源原文合计超过 64 KiB');
    this.validateRequirements(command,node);
    const busy=this.store.db.prepare("SELECT p.id FROM agent_tasks t JOIN operations r ON r.id=t.root_id JOIN operations p ON p.id=t.active_execution_id WHERE r.node_id=? AND r.epoch=? AND json_extract(r.command_json,'$.sessionId')=? AND (t.requires_reconciliation=1 OR p.execution IN ('not_observed','received','running','unknown')) LIMIT 1").get(node.id,node.epoch,command.sessionId);
    requireCondition(!busy,409,'agent_session_unsettled','原现场会话尚未结算，请核对原任务');
    const uncertain=this.store.db.prepare("SELECT c.child_id FROM agent_calls c JOIN operations p ON p.id=c.parent_id JOIN operations child ON child.id=c.child_id WHERE p.node_id=? AND p.epoch=? AND json_extract(p.command_json,'$.sessionId')=? AND child.execution IN ('not_observed','received','running','unknown') LIMIT 1").get(node.id,node.epoch,command.sessionId);
    requireCondition(!uncertain,409,'agent_session_unsettled','原现场会话仍有未结算子操作');
    const modelUnsettled=this.store.db.prepare("SELECT c.parent_id,c.request_id FROM agent_model_calls c JOIN operations p ON p.id=c.parent_id WHERE p.node_id=? AND p.epoch=? AND json_extract(p.command_json,'$.sessionId')=? AND c.state<>'stream_complete'").all(node.id,node.epoch,command.sessionId).some(row=>!this.store.resumes.explainsModel(String(row.parent_id),String(row.request_id),true));requireCondition(!modelUnsettled,409,'agent_session_unsettled','原现场会话仍有在途或未知模型请求');
  }
  validateRequirements(command:ReturnType<typeof delegateSchema.parse>,node:NodeRow){
    this.store.library.checkSources(command,node);
    const capabilities=JSON.parse(node.capabilities) as string[];
    for(const source of command.sources){const r=source.requirements;if(!r)continue;
      requireCondition(capabilities.includes(AGENT_GUIDANCE_CAPABILITY),409,'agent_guidance_unavailable',`来源 ${source.id} 需要支持能力说明 v1 的 Node`);
      requireCondition(r.protocolVersion===PROTOCOL_VERSION,409,'agent_protocol_mismatch',`来源 ${source.id} 的协议版本不匹配`);
      requireCondition(r.toolContractVersion===AGENT_TOOL_CONTRACT_VERSION,409,'agent_tool_contract_mismatch',`来源 ${source.id} 的工具说明版本不匹配`);
      requireCondition(r.platforms.includes(node.platform as 'windows'|'linux'|'darwin'),409,'agent_platform_mismatch',`来源 ${source.id} 不适用目标平台 ${node.platform}`);
      const missing=r.capabilities.filter(c=>!capabilities.includes(c));
      requireCondition(missing.length===0,409,'agent_capability_missing',`来源 ${source.id} 缺少能力：${missing.join(', ')}`);
    }
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
      this.store.resumes.assertRun(parent,input.runId);
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
    return {...op,cancel_requested:op.cancel_requested||parent.cancel_requested||parent.execution!=='running'||context.task.active_execution_id!==parent.id||context.attempt.phase!=='active'||!this.store.resumes.admitted(context)||deadline===null||this.store.now()>=deadline?1:0,parentOperationId:context.op.id,parentDeadlineUnixMs:deadline??0};
  }
  cancelChildren(op:OperationRow){
    if(!this.store.executions.isAgent(op))return;
    for(const row of this.store.db.prepare('SELECT child_id FROM agent_child_executions WHERE execution_id=?').all(op.id)){const child=this.store.operation(op.user_id,String(row.child_id));if(!finalStates.has(child.execution))this.store.cancel(op.user_id,child.id);}
  }
  settle(op:OperationRow,state:string,data:unknown,historicalEvidence=false){
    if(!this.store.executions.isAgent(op))return;
    const context=this.store.executions.resolve(op.user_id,op.id),root=context.op;
    if(this.store.finalizations.isFinalizer(op)){if(state==='succeeded')requireCondition(!historicalEvidence&&(data as any)?.finalizationProof,409,'agent_finalizer_proof_required','只读结算须有准确原 Node 终态证明');return;}
    if(state==='succeeded'){
      requireCondition(context.attempt.phase==='active'&&((context.task.active_execution_id===op.id&&this.store.resumes.admitted(context))||historicalEvidence),409,'agent_execution_reconciling','恢复尚未核清原生会话，不能声明成功');
      requireCondition(historicalEvidence||context.generation===1||(data as any)?.finalProof,409,'agent_resume_final_binding','恢复成功须携带原生释放与进程退出原件');
      if(historicalEvidence){
        const historical=this.store.db.prepare('SELECT m.request_id,m.state,o.generation FROM agent_model_calls m LEFT JOIN agent_model_owners o ON o.parent_id=m.parent_id AND o.request_id=m.request_id WHERE m.parent_id=?').all(root.id).filter(m=>Number(m.generation)<=context.generation);
        requireCondition(historical.every(m=>m.state==='stream_complete'||this.store.resumes.explainsModel(root.id,String(m.request_id),false,op.id)),409,'agent_model_unsettled','原执行仍有未知模型请求，历史证据不能借用后代回执');
      }else this.store.models.assertSettled(root);
      this.store.reviews.assertReturn(root,data,historicalEvidence?op.id:undefined);
      const result=data as any;requireCondition(result?.taskAccepted===false&&result?.taskId===root.id&&result?.sessionId===context.command.sessionId&&result?.status==='awaiting_review',409,'agent_result_invalid','委托完成须保留原 Task 与待复核状态');
      const children=this.list(root).filter(c=>!historicalEvidence||Number(this.store.db.prepare('SELECT generation FROM agent_child_executions WHERE child_id=?').get(c.child_id)?.generation)<=context.generation);requireCondition(children.every(c=>['succeeded','failed','cancelled'].includes(String(c.execution))),409,'agent_children_unsettled','仍有未结算或未知的子操作');
      requireCondition(Array.isArray(result.childOperationIds)&&result.childOperationIds.length===children.length&&new Set(result.childOperationIds).size===children.length&&children.every(c=>result.childOperationIds.includes(c.child_id)),409,'agent_child_set_mismatch','委托结果必须引用完整原子操作集合');
    }
  }
}
