// Copyright (c) Ray Zhang. Feedback relationships reuse the original operation, Task and budget.
import {randomUUID,createHash} from 'node:crypto';
import {delegateSchema} from '../contracts/protocol.ts';
import {agentReviewBindingSchema,agentReviewPublishSchema,agentReviewDecisionSchema,agentRunRegistrationSchema} from '../contracts/agent-review.ts';
import {requireCondition} from './errors.ts';
import {digest} from './store.ts';
import type {ReachStore,OperationRow,NodeRow} from './store.ts';
interface ReviewRow {parent_id:string;run_id:string;run_number:number;basis_sha256:string;candidate_json:string;children_json:string;decision_json:string|null;published_at:number}
const validText=(s:string)=>!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s);
export class AgentReviews {
  readonly store:ReachStore;
  constructor(store:ReachStore){this.store=store;}
  private rows(parent:string){return this.store.db.prepare('SELECT * FROM agent_run_reviews WHERE parent_id=? ORDER BY run_number').all(parent) as unknown as ReviewRow[];}
  private public(row:ReviewRow){const subject=JSON.parse(row.candidate_json),budget=Object.hasOwn(subject,'termination');return{runId:row.run_id,runNumber:row.run_number,basisSha256:row.basis_sha256,subjectKind:budget?'closed_budget':'candidate',...(budget?{snapshot:subject}:{candidate:subject}),childOperationIds:JSON.parse(row.children_json),decision:row.decision_json?JSON.parse(row.decision_json):null,publishedAt:row.published_at};}
  list(userId:string,parentId:string){const parent=this.store.executions.root(this.store.operation(userId,parentId));delegateSchema.parse(JSON.parse(parent.command_json));return{parentOperationId:parent.id,reviews:this.rows(parent.id).map(row=>this.public(row))};}
  authorizeNewRun(parent:OperationRow,runId:string,existingRuns:number){
    if(existingRuns===0||JSON.parse(parent.command_json).maxRuns===1)return;
    const previous=this.rows(parent.id).at(-1),decision=previous?.decision_json?JSON.parse(previous.decision_json):null;
    requireCondition(decision?.decision==='continue'&&decision.nextRunId===runId,409,'agent_run_feedback_required','新的 Run 须对应原候选的调用方反馈');
  }
  assertRunWritable(parent:OperationRow,runId:string){requireCondition(!this.rows(parent.id).some(row=>row.run_id===runId),409,'agent_run_sealed','该 Run 已发布原候选，不能追加新的模型或工具效果');}
  register(node:NodeRow,parentId:string,raw:unknown){const input=agentRunRegistrationSchema.parse(raw);return this.store.transaction(()=>{const {op,command}=this.store.agents.parent(node,parentId,input.dispatchId,input.payloadHash);this.store.models.assertSettled(op);const budget=this.store.models.reserveRun(op,input.runId,command.maxRuns);return{runId:input.runId,runNumber:budget.run_number,remainingCalls:command.maxCalls-this.store.budgets.summary(op).chargedCalls,runCallLimit:budget.admitted_cap??budget.reserved_cap};});}
  publish(node:NodeRow,parentId:string,raw:unknown){const input=agentReviewPublishSchema.parse(raw),subject=input.candidate??input.snapshot!;requireCondition(Buffer.byteLength(JSON.stringify(subject))<=1048576,413,'agent_candidate_too_large','原复核对象超过 1 MiB');return this.store.transaction(()=>{
    const {op,command}=this.store.agents.parent(node,parentId,input.dispatchId,input.payloadHash,false),basis=subject.basis,basisSha256=digest(basis),previous=this.rows(op.id).find(r=>r.run_id===basis.run_id);
    if(previous){requireCondition(previous.candidate_json===JSON.stringify(subject)&&previous.children_json===JSON.stringify(input.childOperationIds),409,'agent_candidate_conflict','原 Run 复核对象已经发布，不能改写');return this.public(previous);}
    this.store.agents.parent(node,parentId,input.dispatchId,input.payloadHash);this.store.models.assertSettled(op);
    requireCondition(command.maxRuns>1&&basis.task_id===op.id&&basis.authorization_revision===op.payload_hash&&basis.raw_start<=basis.raw_end,409,'agent_review_basis','候选须绑定原 Task 与本次 Run');
    const runs=this.store.db.prepare('SELECT run_id FROM agent_runs WHERE parent_id=? ORDER BY rowid').all(op.id),number=runs.findIndex(r=>r.run_id===basis.run_id)+1;
    requireCondition(number===basis.run_number&&number===this.rows(op.id).length+1,409,'agent_review_run','候选须按原 Run 顺序发布');
    const charged=this.store.budgets.summary(op),run=charged.runs.find(r=>r.run_id===basis.run_id);
    requireCondition(basis.run_calls===(run?Math.max(run.actual,run.charge_floor):0)&&basis.total_calls===charged.chargedCalls,409,'agent_review_calls','候选调用次数与原模型及保守消费账本不符');
    const children=this.store.agents.list(op);requireCondition(children.every(c=>['succeeded','failed','cancelled'].includes(String(c.execution)))&&new Set(input.childOperationIds).size===children.length&&input.childOperationIds.length===children.length&&children.every(c=>input.childOperationIds.includes(String(c.child_id))),409,'agent_review_children','候选须引用完整已结算子操作集合');
    this.store.db.prepare('INSERT INTO agent_run_reviews(parent_id,run_id,run_number,basis_sha256,candidate_json,children_json,published_at) VALUES(?,?,?,?,?,?,?)').run(op.id,basis.run_id,number,basisSha256,JSON.stringify(subject),JSON.stringify(input.childOperationIds),this.store.now());this.store.audit(node.id,'agent.candidate_published',op.id);
    return this.public(this.rows(op.id).at(-1)!);
  });}
  decision(userId:string,parentId:string,raw:unknown){const input=agentReviewDecisionSchema.parse(raw);requireCondition(validText(input.feedback),400,'agent_feedback_invalid','反馈必须是有效 UTF-8 原文');return this.store.transaction(()=>{
    const parent=this.store.executions.root(this.store.operation(userId,parentId)),row=this.rows(parent.id).find(r=>r.run_id===input.runId);requireCondition(row&&row.basis_sha256===input.basisSha256,409,'agent_review_basis','反馈须对应准确的原 Run 候选');
    if(row.decision_json){const original=JSON.parse(row.decision_json);requireCondition(original.reviewId===input.reviewId&&original.decision===input.decision&&original.feedback===input.feedback,409,'agent_review_decided','原候选反馈已经提交，不能替换');return original;}
    const node=this.store.ownedNode(userId,parent.node_id),execution=this.store.executions.current(parent);this.store.agents.parent(node,execution.id,execution.dispatch_id!,execution.payload_hash);requireCondition(this.rows(parent.id).at(-1)?.run_id===input.runId,409,'agent_review_stale','不能为旧 Run 提交新的反馈');
    const decision={...input,nextRunId:input.decision==='continue'?randomUUID():null,feedbackSha256:createHash('sha256').update(input.feedback).digest('hex'),actor:userId,decidedAt:this.store.now(),taskAccepted:false};
    this.store.db.prepare('UPDATE agent_run_reviews SET decision_json=? WHERE parent_id=? AND run_id=? AND decision_json IS NULL').run(JSON.stringify(decision),parent.id,input.runId);this.store.audit(userId,'agent.candidate_feedback',parent.id);return decision;
  });}
  poll(node:NodeRow,parentId:string,runId:string,raw:unknown){const binding=agentReviewBindingSchema.parse(raw);const {op}=this.store.agents.parent(node,parentId,binding.dispatchId,binding.payloadHash,false);const row=this.rows(op.id).find(r=>r.run_id===runId);requireCondition(row,404,'agent_review_missing','原 Run 候选尚未发布');return this.public(row);}
  assertReturn(parent:OperationRow,result:any){if(delegateSchema.parse(JSON.parse(parent.command_json)).maxRuns===1)return;const last=this.rows(parent.id).at(-1),decision=last?.decision_json?JSON.parse(last.decision_json):null;requireCondition(decision?.decision==='return_result'&&result?.outcome?.last_receipt?.basis&&digest(result.outcome.last_receipt.basis)===last!.basis_sha256,409,'agent_review_pending','多 Run 结果须对应调用方返回原候选的决定，仍不代表业务 Task 已接受');}
}
