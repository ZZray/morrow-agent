// Copyright (c) Ray Zhang. Model reservations share the original Reach task ledger.
import {z} from 'zod';
import {identifier} from '../contracts/protocol.ts';
import {digest,sha256} from './store.ts';
import type {ReachStore,NodeRow,OperationRow} from './store.ts';
import {requireCondition} from './errors.ts';
import {agentModelStopSchema} from '../contracts/agent-model-stop.ts';

export const modelBindingSchema=z.strictObject({dispatchId:identifier,payloadHash:z.string().regex(/^[a-f0-9]{64}$/)});
export const modelRequestBindingSchema=modelBindingSchema.extend({runId:identifier,routeHash:z.string().regex(/^[a-f0-9]{64}$/)});
export interface AgentModelDescriptor {
  model:string; protocol:'openai-completions'; capabilitySource:'organization-config';
  contextWindow:number; maxOutput:number; input:('text'|'image')[]; routeHash:string;
}
export interface ModelOwnerBinding {instanceId:string;executionId:string;generation:number;routeHash:string;runId:string;bodySha256:string}
export class AgentModels {
  readonly store:ReachStore;
  constructor(store:ReachStore){this.store=store;}
  reserveRun(parent:OperationRow,runId:string,maxRuns:number){
    const runs=this.store.db.prepare('SELECT run_id FROM agent_runs WHERE parent_id=?').all(parent.id);
    requireCondition(runs.some(r=>r.run_id===runId)||runs.length<maxRuns,409,'agent_run_budget','原委托已用完 Run 次数');
    if(!runs.some(r=>r.run_id===runId))this.store.reviews.authorizeNewRun(parent,runId,runs.length);
    this.store.db.prepare('INSERT OR IGNORE INTO agent_runs(parent_id,run_id) VALUES(?,?)').run(parent.id,runId);
    return this.store.budgets.register(parent,runId);
  }
  bind(node:NodeRow,parentId:string,raw:unknown,descriptor:AgentModelDescriptor){
    const binding=modelBindingSchema.parse(raw);
    return this.store.transaction(()=>{
      const {op,command}=this.store.agents.parent(node,parentId,binding.dispatchId,binding.payloadHash);
      const previous=this.store.db.prepare('SELECT route_hash,descriptor_json FROM agent_task_models WHERE parent_id=?').get(op.id);
      requireCondition(!previous||previous.route_hash===descriptor.routeHash,409,'agent_model_route_changed','原 Task 的模型路由已变化，须核对原任务');
      if(!previous)this.store.db.prepare('INSERT INTO agent_task_models VALUES(?,?,?,?)').run(op.id,descriptor.routeHash,JSON.stringify(descriptor),this.store.now());
      return {descriptor,taskId:op.id,sessionId:command.sessionId,parentDeadlineUnixMs:op.claimed_at!+command.maxSeconds*1000,serverNowUnixMs:this.store.now(),maxRuns:command.maxRuns,maxCalls:command.maxCalls,maxOutput:Math.min(command.maxOutput,descriptor.maxOutput)};
    });
  }
  checkRoute(parentId:string,routeHash:string){
    const row=this.store.db.prepare('SELECT route_hash FROM agent_task_models WHERE parent_id=?').get(parentId);
    requireCondition(row&&row.route_hash===routeHash,409,'agent_model_route_changed','模型请求须使用原 Task 的固定路由');
  }
  reserve(node:NodeRow,parentId:string,requestId:string,raw:unknown,bodySha:string,descriptor:AgentModelDescriptor){
    const binding=modelRequestBindingSchema.parse(raw);identifier.parse(requestId);
    return this.store.transaction(()=>{
      const {op,command,execution,generation}=this.store.agents.parent(node,parentId,binding.dispatchId,binding.payloadHash);
      requireCondition(binding.routeHash===descriptor.routeHash,409,'agent_model_route_changed','组织模型配置已变化');this.checkRoute(op.id,binding.routeHash);
      const identity=digest({binding,bodySha});
      const previous=this.store.db.prepare('SELECT identity_sha256,state FROM agent_model_calls WHERE parent_id=? AND request_id=?').get(op.id,requestId);
      if(previous){requireCondition(previous.identity_sha256===identity,409,'agent_model_request_conflict','原模型请求内容已变化');requireCondition(false,409,'agent_model_request_used','原请求已预占，不能重发模型请求');}
      this.store.reviews.assertRunWritable(op,binding.runId);
      this.store.budgets.assertWritable(op,binding.runId);
      requireCondition(!this.unsettled(op.id),409,'agent_model_unsettled','原模型请求仍在途或结果未知，不能继续调用');
      requireCondition(this.store.budgets.summary(op).chargedCalls<command.maxCalls,409,'agent_model_budget','原委托已用完模型调用次数');
      const runCount=Number(this.store.db.prepare('SELECT count(*) AS n FROM agent_model_calls WHERE parent_id=? AND run_id=?').get(op.id,binding.runId)!.n);
      const runBudget=this.reserveRun(op,binding.runId,command.maxRuns);
      requireCondition(runCount<(runBudget.admitted_cap??runBudget.reserved_cap),409,'agent_run_model_budget','该 Run 已用完首次固定的模型调用次数');
      this.store.db.prepare("INSERT INTO agent_model_calls(parent_id,request_id,run_id,identity_sha256,body_sha256,state,reserved_at) VALUES(?,?,?,?,?,'reserved',?)").run(op.id,requestId,binding.runId,identity,bodySha,this.store.now());
      this.store.db.prepare("INSERT INTO agent_model_owners VALUES(?,?,?,?,?,?,'admitted',NULL)").run(op.id,requestId,this.store.owner.instanceId,execution.id,generation,binding.routeHash);
      this.store.audit(node.id,'agent.model_reserved',requestId);
      return {op,command,owner:{instanceId:this.store.owner.instanceId,executionId:execution.id,generation,routeHash:binding.routeHash,runId:binding.runId,bodySha256:bodySha}};
    });
  }
  private writableOwner(parentId:string,requestId:string,expected:ModelOwnerBinding|string){
    this.store.owner.assertCurrent();const owner=this.store.db.prepare('SELECT * FROM agent_model_owners WHERE parent_id=? AND request_id=?').get(parentId,requestId);
    const row=this.store.db.prepare('SELECT run_id,body_sha256 FROM agent_model_calls WHERE parent_id=? AND request_id=?').get(parentId,requestId),route=this.store.db.prepare('SELECT route_hash FROM agent_task_models WHERE parent_id=?').get(parentId);
    const binding=typeof expected==='string'?{instanceId:expected,executionId:parentId,generation:1,routeHash:route?.route_hash,runId:row?.run_id,bodySha256:row?.body_sha256}:expected;
    requireCondition(binding.instanceId===this.store.owner.instanceId&&owner?.instance_id===binding.instanceId&&owner.execution_id===binding.executionId&&owner.generation===binding.generation&&owner.route_hash===binding.routeHash&&row?.run_id===binding.runId&&row?.body_sha256===binding.bodySha256&&owner.phase==='admitted'&&!this.store.db.prepare('SELECT 1 FROM agent_model_stops WHERE parent_id=? AND request_id=?').get(parentId,requestId),409,'agent_model_owner_changed','原模型运输实例已退出或已完成停止对账');return owner;
  }
  streaming(parentId:string,requestId:string,expected:ModelOwnerBinding|string=this.store.owner.instanceId){this.store.transaction(()=>{this.writableOwner(parentId,requestId,expected);this.store.db.prepare("UPDATE agent_model_calls SET state='streaming' WHERE parent_id=? AND request_id=? AND state='reserved'").run(parentId,requestId);});}
  finish(parentId:string,requestId:string,state:'stream_complete'|'unknown',details:{code?:string;upstreamStatus?:number;responseBytes:number;finishReason?:string;usage?:unknown},expected:ModelOwnerBinding|string=this.store.owner.instanceId){
    return this.store.transaction(()=>{this.writableOwner(parentId,requestId,expected);return this.store.db.prepare("UPDATE agent_model_calls SET state=?,finished_at=?,error_code=?,upstream_status=?,response_bytes=?,finish_reason=?,usage_json=? WHERE parent_id=? AND request_id=? AND state IN ('reserved','streaming')").run(state,this.store.now(),details.code??null,details.upstreamStatus??null,details.responseBytes,details.finishReason??null,details.usage==null?null:JSON.stringify(details.usage),parentId,requestId).changes;});
  }
  joined(parentId:string,requestId:string,expected:ModelOwnerBinding|string){this.store.transaction(()=>{const owner=this.writableOwner(parentId,requestId,expected);this.store.db.prepare("UPDATE agent_model_owners SET phase='joined',joined_at=? WHERE parent_id=? AND request_id=? AND instance_id=? AND phase='admitted'").run(this.store.now(),parentId,requestId,owner.instance_id);});}
  list(userId:string,parentId:string){const parent=this.store.executions.root(this.store.operation(userId,parentId));return{taskId:parent.id,taskAccepted:false,requests:this.store.db.prepare('SELECT * FROM agent_model_calls WHERE parent_id=? ORDER BY rowid').all(parent.id).map(row=>({requestId:row.request_id,runId:row.run_id,bodySha256:row.body_sha256,state:row.state,usage:row.usage_json?JSON.parse(String(row.usage_json)):null,owner:this.store.db.prepare('SELECT instance_id,execution_id,generation,route_hash,phase,joined_at FROM agent_model_owners WHERE parent_id=? AND request_id=?').get(parent.id,row.request_id)??null,transportStop:this.stopReceipt(parent.id,String(row.request_id))}))};}
  private stopReceipt(parentId:string,requestId:string){const row=this.store.db.prepare('SELECT receipt_json FROM agent_model_stops WHERE parent_id=? AND request_id=?').get(parentId,requestId);return row?JSON.parse(String(row.receipt_json)):null;}
  prepareStop(userId:string,parentId:string,raw:unknown){
    this.store.owner.assertCurrent();const input=agentModelStopSchema.parse(raw),parent=this.store.operation(userId,parentId);
    requireCondition(parent.dispatch_id===input.dispatchId&&parent.payload_hash===input.payloadHash,409,'agent_model_stop_binding','停止对账须绑定原委托派发');
    const original=this.store.db.prepare('SELECT * FROM agent_model_calls WHERE parent_id=? AND request_id=?').get(parent.id,input.requestId);requireCondition(original&&original.run_id===input.runId&&original.body_sha256===input.bodySha256,409,'agent_model_stop_binding','停止对账须绑定准确的原模型请求');
    const existing=this.store.db.prepare('SELECT identity_sha256,receipt_json FROM agent_model_stops WHERE parent_id=? AND request_id=?').get(parent.id,input.requestId),identity=digest(input);
    if(existing){requireCondition(existing.identity_sha256===identity,409,'agent_model_stop_conflict','原模型停止对账已经提交，不能改写');return{input,parent,original,receipt:JSON.parse(String(existing.receipt_json)),owner:null};}
    requireCondition(['unknown','failed','cancelled'].includes(parent.execution),409,'agent_model_stop_parent_active','停止对账仅适用于已停止且不再接受效果的原委托');
    requireCondition(original.state!=='stream_complete',409,'agent_model_stop_not_required','原模型流已完整结束，无需未知运输对账');
    const owner=this.store.db.prepare('SELECT o.*,i.lock_identity,i.protocol_version FROM agent_model_owners o JOIN agent_service_instances i ON i.instance_id=o.instance_id WHERE o.parent_id=? AND o.request_id=?').get(parent.id,input.requestId);
    requireCondition(owner&&owner.instance_id===input.ownerInstanceId&&owner.execution_id===parent.id&&owner.generation===1&&owner.protocol_version===7&&owner.lock_identity===this.store.owner.lockIdentity,409,'agent_model_owner_unproven','旧请求没有可证明的同锁服务实例归属，不能推断运输已停止');
    return{input,parent,original,owner,receipt:null};
  }
  recordStopped(userId:string,parentId:string,raw:unknown){return this.store.transaction(()=>{
    const prepared=this.prepareStop(userId,parentId,raw);if(prepared.receipt)return prepared.receipt;const {input,parent,original,owner}=prepared;
    const here=owner!.instance_id===this.store.owner.instanceId;requireCondition(!here||(owner!.phase==='joined'&&owner!.joined_at!==null),409,'agent_model_transport_not_joined','当前服务仍须实际停止并等待该原请求结束');
    const receipt={taskId:parent.id,requestId:input.requestId,runId:input.runId,bodySha256:input.bodySha256,ownerInstanceId:input.ownerInstanceId,executionId:owner!.execution_id,generation:owner!.generation,routeHash:owner!.route_hash,originalState:original.state,originalStateSha256:digest(original),usage:original.usage_json?JSON.parse(String(original.usage_json)):null,transportStopped:true,proof:{kind:here?'joined_here':'previous_owner_exited',currentInstanceId:this.store.owner.instanceId,lockIdentity:this.store.owner.lockIdentity},reconciliationId:input.reconciliationId,actor:userId,evidence:input.evidence,evidenceSha256:sha256(input.evidence),at:this.store.now(),taskAccepted:false};
    this.store.db.prepare('INSERT INTO agent_model_stops VALUES(?,?,?,?,?,?,?)').run(parent.id,input.requestId,input.reconciliationId,digest(input),JSON.stringify(input),JSON.stringify(receipt),this.store.now());this.store.audit(userId,'agent.model_transport_stopped',input.requestId);return receipt;
  });}
  unsettled(parentId:string){return !!this.store.db.prepare("SELECT 1 FROM agent_model_calls WHERE parent_id=? AND state<>'stream_complete' LIMIT 1").get(parentId);}
  assertSettled(parent:OperationRow){requireCondition(!this.unsettled(parent.id),409,'agent_model_unsettled','原委托有在途或未知模型请求，不能声明成功');}
  hasCalls(parent:OperationRow){return !!this.store.db.prepare('SELECT 1 FROM agent_model_calls WHERE parent_id=? LIMIT 1').get(parent.id);}
  status(node:NodeRow,parentId:string,requestId:string,raw:unknown){
    const binding=modelBindingSchema.parse(raw);identifier.parse(requestId);const {op}=this.store.agents.parent(node,parentId,binding.dispatchId,binding.payloadHash,false);
    const row=this.store.db.prepare('SELECT request_id,run_id,body_sha256,state,error_code FROM agent_model_calls WHERE parent_id=? AND request_id=?').get(op.id,requestId);
    requireCondition(row,404,'agent_model_request_missing','原模型预占不存在');const stop=this.stopReceipt(op.id,requestId);return stop?{...row,transportStop:stop}:row;
  }
}
