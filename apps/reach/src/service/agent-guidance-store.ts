// Copyright (c) Ray Zhang. Idempotent in-run guidance receipts and cross-process reviewed continuation.
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agentContinueSchema, agentGuidanceInputSchema, delegateSchema, finalStates } from '../contracts/protocol.ts';
import { agentReviewBindingSchema } from '../contracts/agent-review.ts';
import { requireCondition } from './errors.ts';
import type { NodeRow, OperationRow, ReachStore } from './store.ts';

export const guidanceReportSchema = agentReviewBindingSchema.extend({
  acks: z.array(z.strictObject({
    messageId: z.string().min(1).max(256),
    status: z.enum(['queued', 'duplicate', 'applied', 'unapplied', 'unknown']),
  })).max(64).default([]),
  finalMessages: z.array(z.strictObject({
    id: z.string().min(1).max(256).optional(),
    message_id: z.string().min(1).max(256),
    text_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    status: z.enum(['applied', 'unapplied', 'unknown']),
    detail: z.string().max(4096).optional(),
    error: z.string().max(4096).optional(),
  })).max(64).optional(),
});

interface GuidanceRow {
  parent_id: string;
  execution_id: string;
  message_id: string;
  text: string;
  text_sha256: string;
  status: 'queued' | 'applied' | 'unapplied' | 'unknown';
  delivered: number;
  receipt_json: string | null;
  created_at: number;
  updated_at: number;
}

interface ContinuationRow {
  execution_id: string;
  root_id: string;
  previous_execution_id: string;
  expected_released_sha256: string;
  feedback: string;
  run_id: string;
  run_number: number;
  consumed_runs: number;
  consumed_calls: number;
  created_at: number;
}

const textHash = (value: string) => createHash('sha256').update(value).digest('hex');

export class AgentGuidanceStore {
  readonly store: ReachStore;
  constructor(store: ReachStore) {
    this.store = store;
  }

  isContinuationId(executionId: string): boolean {
    return !!this.store.db.prepare('SELECT 1 FROM agent_continuations WHERE execution_id=?').get(executionId);
  }

  isContinuation(op: OperationRow): boolean {
    return JSON.parse(op.command_json).kind === 'agent.continue' || this.isContinuationId(op.id);
  }

  continuation(executionId: string): ContinuationRow | undefined {
    return this.store.db.prepare('SELECT * FROM agent_continuations WHERE execution_id=?').get(executionId) as unknown as ContinuationRow | undefined;
  }

  submit(userId: string, operationId: string, raw: unknown) {
    const input = agentGuidanceInputSchema.parse(raw);
    return this.store.transaction(() => {
      const target = this.store.operation(userId, operationId);
      const root = this.store.executions.root(target);
      delegateSchema.parse(JSON.parse(root.command_json));
      const sha = textHash(input.text);
      const existing = this.store.db.prepare('SELECT * FROM agent_guidance WHERE parent_id=? AND message_id=?').get(root.id, input.messageId) as unknown as GuidanceRow | undefined;
      if (existing) {
        requireCondition(existing.text_sha256 === sha, 409, 'agent_guidance_conflict', '同一引导消息 ID 不能用于不同正文');
        return { parentOperationId: root.id, executionId: existing.execution_id, duplicate: true, taskAccepted: false, guidance: this.present(existing) };
      }
      const totalCount = (this.store.db.prepare('SELECT count(*) AS n FROM agent_guidance WHERE parent_id=?').get(root.id) as { n: number }).n;
      requireCondition(totalCount < 16, 409, 'agent_guidance_capacity', '单次委托的补充引导条数已达上限');
      const context = this.store.executions.resolve(userId, root.id);
      const active = this.store.operation(userId, context.task.active_execution_id);
      requireCondition(
        !active.cancel_requested && ['queued', 'claimed', 'received', 'running'].includes(active.execution === 'not_observed' ? active.delivery : active.execution)
          && !finalStates.has(active.execution)
          && (context.task.deadline_unix_ms === null || this.store.now() < context.task.deadline_unix_ms),
        409,
        'agent_parent_inactive',
        '原委托未处于运行态或已到截止时间，补充引导不会启动新 Run',
      );
      const now = this.store.now();
      this.store.db.prepare('INSERT INTO agent_guidance VALUES(?,?,?,?,?,?,0,NULL,?,?)')
        .run(root.id, active.id, input.messageId, input.text, sha, 'queued', now, now);
      this.store.audit(userId, 'agent.guidance_queued', root.id);
      const inserted = this.store.db.prepare('SELECT * FROM agent_guidance WHERE parent_id=? AND message_id=?').get(root.id, input.messageId) as unknown as GuidanceRow;
      return { parentOperationId: root.id, executionId: active.id, duplicate: false, taskAccepted: false, guidance: this.present(inserted) };
    });
  }

  private settleInterrupted(rootId: string) {
    const queued = this.store.db.prepare("SELECT * FROM agent_guidance WHERE parent_id=? AND status='queued'").all(rootId) as unknown as GuidanceRow[];
    for (const row of queued) {
      const exec = this.store.db.prepare('SELECT execution FROM operations WHERE id=?').get(row.execution_id) as { execution: string } | undefined;
      if (exec && finalStates.has(exec.execution as Parameters<typeof finalStates.has>[0])) {
        const fallback = exec.execution === 'unknown' ? 'unknown' : (row.delivered ? 'unknown' : 'unapplied');
        const receipt = JSON.stringify({ message_id: row.message_id, status: fallback, reason: exec.execution === 'unknown' ? 'delivery_unknown_after_interruption' : 'execution_ended_before_guidance_report' });
        this.store.db.prepare('UPDATE agent_guidance SET status=?,receipt_json=COALESCE(receipt_json,?),updated_at=? WHERE parent_id=? AND message_id=?')
          .run(fallback, receipt, this.store.now(), rootId, row.message_id);
      }
    }
  }

  private present(row: GuidanceRow) {
    return {
      messageId: row.message_id,
      executionId: row.execution_id,
      textSha256: row.text_sha256,
      status: row.status,
      deliveredToNode: !!row.delivered,
      receipt: row.receipt_json ? JSON.parse(row.receipt_json) as unknown : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(userId: string, operationId: string) {
    return this.store.transaction(() => {
      const root = this.store.executions.root(this.store.operation(userId, operationId));
      delegateSchema.parse(JSON.parse(root.command_json));
      this.settleInterrupted(root.id);
      const rows = this.store.db.prepare('SELECT * FROM agent_guidance WHERE parent_id=? ORDER BY created_at,rowid').all(root.id) as unknown as GuidanceRow[];
      return { parentOperationId: root.id, taskAccepted: false, guidance: rows.map(r => this.present(r)) };
    });
  }

  poll(node: NodeRow, executionId: string, raw: unknown) {
    const binding = agentReviewBindingSchema.parse(raw);
    return this.store.transaction(() => {
      const c = this.store.executions.node(node, executionId, binding.dispatchId, binding.payloadHash, true);
      const rows = this.store.db.prepare("SELECT * FROM agent_guidance WHERE parent_id=? AND execution_id=? AND status='queued' AND delivered=0 ORDER BY created_at,rowid")
        .all(c.op.id, executionId) as unknown as GuidanceRow[];
      if (rows.length > 0) {
        const now = this.store.now();
        for (const r of rows) {
          this.store.db.prepare('UPDATE agent_guidance SET delivered=1,updated_at=? WHERE parent_id=? AND message_id=?').run(now, c.op.id, r.message_id);
        }
      }
      return { messages: rows.map(r => ({ messageId: r.message_id, text: r.text })) };
    });
  }

  report(node: NodeRow, executionId: string, raw: unknown) {
    const input = guidanceReportSchema.parse(raw);
    return this.store.transaction(() => {
      const c = this.store.executions.node(node, executionId, input.dispatchId, input.payloadHash, false);
      const now = this.store.now();
      for (const ack of input.acks) {
        const mapped = ack.status === 'duplicate' ? 'queued' : ack.status;
        if (mapped === 'queued') {
          this.store.db.prepare("UPDATE agent_guidance SET delivered=1,updated_at=? WHERE parent_id=? AND execution_id=? AND message_id=? AND status='queued'")
            .run(now, c.op.id, executionId, ack.messageId);
        } else {
          this.store.db.prepare("UPDATE agent_guidance SET status=?,receipt_json=COALESCE(receipt_json,?),updated_at=? WHERE parent_id=? AND execution_id=? AND message_id=? AND status='queued'")
            .run(mapped, JSON.stringify(ack), now, c.op.id, executionId, ack.messageId);
        }
      }
      if (input.finalMessages) {
        for (const item of input.finalMessages) {
          this.store.db.prepare("UPDATE agent_guidance SET status=?,receipt_json=?,updated_at=? WHERE parent_id=? AND execution_id=? AND message_id=? AND status='queued'")
            .run(item.status, JSON.stringify(item), now, c.op.id, executionId, item.message_id);
        }
        this.store.db.prepare("UPDATE agent_guidance SET status='unapplied',updated_at=? WHERE parent_id=? AND execution_id=? AND status='queued'")
          .run(now, c.op.id, executionId);
      }
      return { recorded: true, taskAccepted: false };
    });
  }

  addContinue(op: OperationRow) {
    return this.store.transaction(() => {
      const input = agentContinueSchema.parse(JSON.parse(op.command_json));
      const context = this.store.executions.resolve(op.user_id, input.previousExecutionId);
      const { op: root, execution: previous, task, command } = context;
      this.store.agents.validateRequirements(command, this.store.db.prepare('SELECT * FROM nodes WHERE id=?').get(root.node_id) as unknown as NodeRow);
      requireCondition(root.id === input.rootOperationId && op.node_id === root.node_id && op.epoch === root.epoch, 409, 'agent_continue_binding', '续作须沿原 Task、设备及配对');
      requireCondition(task.active_execution_id === previous.id && task.generation === context.generation, 409, 'agent_continue_superseded', '原执行已被其他后续执行取代');
      requireCondition(previous.execution === 'succeeded' && task.requires_reconciliation === 0, 409, 'agent_continue_not_released', '仅可对已正常释放且无需恢复对账的原结果发起跨进程续作');
      requireCondition(!this.store.db.prepare('SELECT 1 FROM agent_continuations WHERE root_id=? AND previous_execution_id=?').get(root.id, previous.id), 409, 'agent_continue_claimed', '该原释放结果已被认领');
      requireCondition(task.deadline_unix_ms === null || this.store.now() < task.deadline_unix_ms, 409, 'agent_deadline', '原委托已到截止时间');
      const summary = this.store.budgets.summary(root);
      const consumedRuns = summary.runs.length;
      const consumedCalls = summary.chargedCalls;
      requireCondition(consumedRuns >= 1 && consumedRuns < command.maxRuns && consumedCalls < command.maxCalls, 409, 'agent_continue_budget', '原 Task 已无剩余可续作的 Run 或模型调用预算');
      const others = this.store.db.prepare(`SELECT p.id,p.execution,t.rowid AS ordinal FROM agent_tasks t JOIN operations r ON r.id=t.root_id JOIN operations p ON p.id=t.active_execution_id
        WHERE r.node_id=? AND r.epoch=? AND json_extract(r.command_json,'$.sessionId')=? AND r.id<>?`).all(root.node_id, root.epoch, command.sessionId, root.id) as Record<string, unknown>[];
      const ordinalRow = this.store.db.prepare('SELECT rowid AS ordinal FROM agent_tasks WHERE root_id=?').get(root.id) as { ordinal: number };
      requireCondition(!others.some(row => Number(row.ordinal) > Number(ordinalRow.ordinal) || ['not_observed', 'received', 'running', 'unknown'].includes(String(row.execution))), 409, 'agent_continue_session_changed', '原 Session 已有后续任务，不能覆盖历史顺序');
      const generation = task.generation + 1;
      const runId = randomUUID();
      const runNumber = consumedRuns + 1;
      const cap = Math.min(command.runCallLimit ?? command.maxCalls, command.maxCalls - consumedCalls);
      const now = this.store.now();
      this.store.db.prepare("INSERT INTO agent_executions VALUES(?,?,?,?,NULL,?,'active')").run(op.id, root.id, previous.id, generation, textHash(input.feedback));
      this.store.db.prepare('INSERT INTO agent_runs VALUES(?,?)').run(root.id, runId);
      this.store.db.prepare('INSERT INTO agent_run_budgets(parent_id,run_id,run_number,reserved_cap,admitted_cap,charge_floor,closed_for_resume) VALUES(?,?,?,?,?,0,0)')
        .run(root.id, runId, runNumber, cap, cap);
      this.store.db.prepare('INSERT INTO agent_run_origins(parent_id,run_id,registered_execution_id,registered_generation,admitted_execution_id,admitted_generation,admission_json) VALUES(?,?,?,?,?,?,?)')
        .run(root.id, runId, op.id, generation, op.id, generation, JSON.stringify({ kind: 'continue_reviewed', executionId: op.id, generation, runId, runNumber, expectedReleasedSha256: input.releasedSha256 }));
      this.store.db.prepare('INSERT INTO agent_continuations VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(op.id, root.id, previous.id, input.releasedSha256, input.feedback, runId, runNumber, consumedRuns, consumedCalls, now);
      this.store.db.prepare('DELETE FROM agent_task_finishes WHERE root_id=?').run(root.id);
      requireCondition(
        this.store.db.prepare('UPDATE agent_tasks SET active_execution_id=?,generation=?,requires_reconciliation=0 WHERE root_id=? AND active_execution_id=? AND generation=?')
          .run(op.id, generation, root.id, previous.id, task.generation).changes === 1,
        409,
        'agent_continue_superseded',
        '原 Task 已被其他执行接续',
      );
    });
  }

  plan(node: NodeRow, executionId: string, raw: unknown) {
    const binding = agentReviewBindingSchema.parse(raw);
    return this.store.transaction(() => {
      const c = this.store.executions.node(node, executionId, binding.dispatchId, binding.payloadHash, false);
      const row = this.continuation(executionId);
      requireCondition(row && row.root_id === c.op.id, 409, 'agent_continue_missing', '续作计划不存在');
      const children = this.store.agents.list(c.op).map(entry => String(entry.child_id));
      return {
        taskId: c.op.id,
        executionId,
        generation: c.generation,
        previousExecutionId: row!.previous_execution_id,
        expectedReleasedSha256: row!.expected_released_sha256,
        feedback: row!.feedback,
        runId: row!.run_id,
        runNumber: row!.run_number,
        consumedRuns: row!.consumed_runs,
        consumedCalls: row!.consumed_calls,
        parentDeadlineUnixMs: c.task.deadline_unix_ms,
        childOperationIds: children,
        taskAccepted: false,
      };
    });
  }
}
