// Copyright (c) Ray Zhang. Non-refundable native consumption is separate from actual model reservations.
import {z} from 'zod';
import {delegateSchema,identifier} from '../contracts/protocol.ts';
import {digest} from './store.ts';
import {requireCondition} from './errors.ts';
import type {OperationRow,ReachStore} from './store.ts';

const hash=z.string().regex(/^[a-f0-9]{64}$/),count=z.number().int().min(0).max(32);
const reference=z.strictObject({path:z.string().min(1).max(32768),sha256:hash});
const chargeSchema=z.strictObject({runId:identifier,runNumber:z.number().int().min(1).max(4),effectiveCap:z.number().int().min(1).max(32),calls:count,admission:reference,observation:reference.optional()});
export const nativeConsumptionSchema=z.strictObject({receiptId:identifier,fenceSha256:hash,reviewSha256:hash,consumedRuns:z.number().int().min(0).max(4),consumedCalls:count,runs:z.array(chargeSchema).max(4)});
export const releasedConsumptionSchema=z.strictObject({receiptId:identifier,released:reference,inspectionSha256:hash,consumedRuns:z.number().int().min(0).max(4),consumedCalls:count,runs:z.array(chargeSchema).max(4)});
interface BudgetRow {run_id:string;run_number:number;reserved_cap:number;admitted_cap:number|null;charge_floor:number;closed_for_resume:number;actual:number}

export class AgentBudgets {
  readonly store:ReachStore;
  constructor(store:ReachStore){this.store=store;}
  rows(parent:OperationRow):BudgetRow[]{
    return this.store.db.prepare(`SELECT b.*, (SELECT count(*) FROM agent_model_calls m WHERE m.parent_id=b.parent_id AND m.run_id=b.run_id) AS actual
      FROM agent_run_budgets b WHERE b.parent_id=? ORDER BY b.run_number`).all(parent.id) as unknown as BudgetRow[];
  }
  summary(parent:OperationRow){const runs=this.rows(parent);return{runs,actualCalls:runs.reduce((n,r)=>n+r.actual,0),chargedCalls:runs.reduce((n,r)=>n+Math.max(r.actual,r.charge_floor),0)};}
  // Called in the caller's existing immediate transaction. Existing rows never recalculate their first reservation.
  register(parent:OperationRow,runId:string){
    const prior=this.rows(parent).find(r=>r.run_id===runId);if(prior)return prior;
    const command=delegateSchema.parse(JSON.parse(parent.command_json)),runs=this.rows(parent),spent=this.summary(parent).chargedCalls;
    const cap=Math.min(command.runCallLimit??command.maxCalls,command.maxCalls-spent);
    requireCondition(cap>0,409,'agent_model_budget','原 Task 的逻辑消费已用完模型预算');
    this.store.db.prepare('INSERT INTO agent_run_budgets(parent_id,run_id,run_number,reserved_cap) VALUES(?,?,?,?)').run(parent.id,runId,runs.length+1,cap);
    return this.rows(parent).find(r=>r.run_id===runId)!;
  }
  // Older schemas had only actual reservations. Preserve their order and identities; do not fabricate native observations.
  migrate(fromVersion:number){this.store.transaction(()=>{
    for(const row of this.store.db.prepare('SELECT DISTINCT parent_id FROM agent_runs').all()){
      const parent=this.store.db.prepare('SELECT * FROM operations WHERE id=?').get(row.parent_id) as unknown as OperationRow;
      const command=delegateSchema.parse(JSON.parse(parent.command_json));let previousActual=0;
      for(const [index,run] of this.store.db.prepare('SELECT run_id FROM agent_runs WHERE parent_id=? ORDER BY rowid').all(parent.id).entries()){
        const actual=Number(this.store.db.prepare('SELECT count(*) AS n FROM agent_model_calls WHERE parent_id=? AND run_id=?').get(parent.id,run.run_id)!.n),cap=Math.min(command.runCallLimit??command.maxCalls,command.maxCalls-previousActual);
        const existing=this.store.db.prepare('SELECT 1 FROM agent_run_budgets WHERE parent_id=? AND run_id=?').get(parent.id,run.run_id);
        if(!existing){requireCondition(fromVersion<6&&cap>=0&&actual<=cap,409,'agent_budget_migration','原 Run 账本缺失或旧预占与 Task 预算冲突');this.store.db.prepare('INSERT INTO agent_run_budgets(parent_id,run_id,run_number,reserved_cap) VALUES(?,?,?,?)').run(parent.id,run.run_id,index+1,cap);}
        previousActual+=actual;
      }
    }
  });}
  assertWritable(parent:OperationRow,runId:string){const row=this.rows(parent).find(r=>r.run_id===runId);requireCondition(!row?.closed_for_resume,409,'agent_run_reconciled','该原 Run 已记录恢复消费，不能新增效果');}
  // Internal resume primitive, intentionally not an HTTP admission API. The future Host must first
  // verify these exact native files under the Harness Session lock and commit the effect reconciliation.
  // Charging alone does not authorize a new execution, clear unknown effects, or extend the original deadline.
  recordNativeConsumption(parent:OperationRow,raw:unknown){
    return this.recordConsumption(parent,nativeConsumptionSchema.parse(raw));
  }
  recordReleasedConsumption(parent:OperationRow,raw:unknown){return this.recordConsumption(parent,releasedConsumptionSchema.parse(raw));}
  private recordConsumption(parent:OperationRow,input:ReturnType<typeof nativeConsumptionSchema.parse>|ReturnType<typeof releasedConsumptionSchema.parse>){
    const identity=digest(input);
    return this.store.transaction(()=>{
      const prior=this.store.db.prepare('SELECT identity_sha256,receipt_json FROM agent_budget_reconciliations WHERE parent_id=? AND receipt_id=?').get(parent.id,input.receiptId);
      if(prior){requireCondition(prior.identity_sha256===identity,409,'agent_budget_receipt_conflict','原恢复消费依据不能改写');return JSON.parse(String(prior.receipt_json));}
      const command=delegateSchema.parse(JSON.parse(parent.command_json)),rows=this.rows(parent);
      requireCondition(input.runs.length===input.consumedRuns&&input.consumedRuns<=rows.length&&input.consumedRuns<=command.maxRuns,409,'agent_budget_runs','恢复消费须覆盖原准入 Run 的连续前缀');
      let calls=0;
      for(const [i,charge]of input.runs.entries()){
        const row=rows[i]!,effective=Math.min(command.runCallLimit??command.maxCalls,command.maxCalls-calls);
        requireCondition(charge.runId===row.run_id&&charge.runNumber===row.run_number&&charge.runNumber===i+1,409,'agent_budget_run_binding','恢复消费须绑定原 Run 顺序');
        requireCondition(charge.effectiveCap===effective&&effective<=row.reserved_cap&&(row.admitted_cap===null||row.admitted_cap===effective),409,'agent_budget_admission','原生准入额度与原 Task 不符');
        requireCondition(charge.calls>=row.actual&&charge.calls>=row.charge_floor&&charge.calls<=effective&&(charge.observation!==undefined||charge.calls===effective),409,'agent_budget_consumption','未观察 Run 须按原准入全额扣减；实际预占和原消费不得退款');
        calls+=charge.calls;
      }
      requireCondition(calls===input.consumedCalls&&calls<=command.maxCalls&&rows.slice(input.consumedRuns).every(r=>r.actual===0&&r.charge_floor===0&&r.closed_for_resume===0),409,'agent_budget_consumption','恢复累计消费或后继 Run 原件冲突');
      for(const charge of input.runs)this.store.db.prepare('UPDATE agent_run_budgets SET admitted_cap=?,charge_floor=?,closed_for_resume=1 WHERE parent_id=? AND run_id=?').run(charge.effectiveCap,charge.calls,parent.id,charge.runId);
      const receipt={...input,taskId:parent.id,actualCalls:this.summary(parent).actualCalls,chargedCalls:calls,taskAccepted:false};
      this.store.db.prepare('INSERT INTO agent_budget_reconciliations VALUES(?,?,?,?,?,?)').run(parent.id,input.receiptId,identity,JSON.stringify(input),JSON.stringify(receipt),this.store.now());
      this.store.audit(parent.node_id,'agent.native_consumption_recorded',parent.id);return receipt;
    });
  }
}
