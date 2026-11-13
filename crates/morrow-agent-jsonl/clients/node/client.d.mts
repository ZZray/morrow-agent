export const VERSION: 1;
export const FRAME_BYTES: 262144;

export interface JsonReference {
  path: string;
  sha256: string;
}

export type Settlement = 'Settled' | 'Unknown';
export type Verdict = 'Verified' | 'Unknown' | { NeedsChanges: { feedback: string } };
export type TaskStop = 'AwaitingHostAcceptance' | 'NeedsChanges' | 'BudgetExhausted'
  | 'Cancelled' | 'GoalWaiting' | 'Informational' | 'ReconciliationRequired';
export type FencePresence = 'Present' | 'Released' | 'Unknown';

export interface GoalLease {
  goal_id: string;
  controller: string;
  device: string;
  session: string;
  expires_at: number;
  max_calls: number;
  max_slices: number;
  allow_jobs: boolean;
}

export interface GoalStart {
  goal_id: string;
  criteria: string[];
  lease: GoalLease;
  expected_revision?: number;
  reviewed_run_id?: string;
}

export interface TaskConfig {
  task_id: string;
  criteria_revision: string;
  authorization_revision: string;
  kind: 'Coding' | 'Reasoning' | 'ReverseAnalysis';
  evidence_dir: string;
  max_runs: number;
  max_calls: number;
  deadline_unix_ms: number;
}

export interface ToolConfig {
  name: string;
  description: string;
  parameters: unknown;
  allow_in_plan?: boolean;
}

export type ModelResolution = { kind: 'catalog' }
  | { kind: 'catalog_capped'; context_window_cap: number }
  | {
      kind: 'host_declared_loopback';
      capabilities: { context_window?: number | null; max_tokens: number; input?: string[] | null };
    };

export interface RunConfig {
  run_id: string;
  objective: string;
  cwd: string;
  session_path: string;
  environment_state: string;
  device_fp: string;
  session_key: string;
  mode: 'plan' | 'execute' | 'goal';
  endpoint: string;
  model: string;
  max_calls: number;
  max_seconds: number;
  max_output: number;
  /** Host-selected absolute executable; job_start additionally requires the Goal lease. */
  worker_executable?: string | null;
  host_output_ceiling?: number | null;
  model_resolution: ModelResolution;
  generation_policy?: 'provider_default' | 'thinking_type_disabled';
  length_recovery?: 'stop' | 'replan_once';
  tools: ToolConfig[];
}

export interface StartTaskFrame {
  kind: 'start_task';
  version: 1;
  task: TaskConfig;
  run: RunConfig;
  budget_stop_review?: 'reject' | 'review_closed_tool_round';
  length_stop_review?: 'reject' | 'review_closed_length';
  cancel_grace_ms?: number;
  emit_events?: boolean;
  artifact_review?: boolean;
  mcp_servers?: Record<string, unknown> | null;
  mcp_options?: {
    required?: string[];
    startup_timeout_ms?: number | null;
    call_timeout_ms?: number | null;
  } | null;
  resume?: { version: 1; fence_sha256: string };
  continue_reviewed?: {
    previous_evidence_dir: string;
    expected_released_sha256: string;
    review?: ReviewReceipt | null;
  };
  orchestration?: {
    directory: string;
    assignment_id: string;
    worker_id: string;
    lease_expires_at_ms: number;
    configuration_sha256: string;
    attempt_id: string;
    recovery_authorization_ref?: JsonReference;
    retry_unadmitted_ref?: JsonReference;
  };
  goal?: GoalStart;
  event_payloads?: boolean;
  guidance?: boolean;
}

export interface GuideFrame {
  kind: 'guide';
  version: 1;
  task_id: string;
  message_id: string;
  text: string;
}

export interface GuidanceAckFrame {
  kind: 'guidance_ack';
  version: 1;
  task_id: string;
  message_id: string;
  /** applied means source saved and admitted to execution context. Model reading is unverified. */
  status: 'queued' | 'duplicate' | 'applied' | 'unapplied' | 'unknown';
}

export interface RpcEnvelope {
  version: 1;
  rpc_id: string;
  task_id: string;
  run_id: string;
}

export interface ToolCallFrame extends RpcEnvelope {
  kind: 'tool_call';
  native_call_id: string;
  tool_name: string;
  args_sha256: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  value: unknown;
  is_error: boolean;
  settlement: Settlement;
  operation_receipt: string;
}

export interface ReviewBasis {
  task_id: string;
  criteria_revision: string;
  authorization_revision: string;
  run_id: string;
  /** Omitted in the ordinary legacy v1 callback projection. */
  session_id?: string;
  run_number: number;
  session_path: string;
  events_path: string;
  events_sha256: string;
  event_count: number;
  run_calls: number;
  total_calls: number;
  journal_head_sha256: string;
  raw_start: number;
  raw_end: number;
  raw_proof: string;
}

export interface Candidate {
  basis: ReviewBasis;
  output: string;
  goal: unknown;
}

export interface ReviewReceipt {
  basis: ReviewBasis;
  committed: boolean;
  settlement: Settlement;
  verdict: Verdict;
  evidence: string[];
}

export interface Continuation<T = Candidate> {
  previous: T;
  receipt: ReviewReceipt;
  next_run_number: number;
  remaining_calls: number;
  deadline_unix_ms: number;
}

export interface PreparedContinuation {
  run_id_next: string;
  objective: string;
}

export interface BudgetStopSnapshot {
  basis: ReviewBasis;
  diagnostic_output: string;
  goal: unknown;
  termination: {
    version: 1;
    cause: 'call_budget_exhausted';
    native_round_closed: true;
    model_final_stop: false;
  };
}

export type StopEvidence = {
  cause: 'length';
  version: number;
  native_round_closed: boolean;
  model_final_stop: boolean;
  source_raw_index: number;
  source_sha256: string;
  effective_output_tokens: number;
} | {
  cause: 'no_progress';
  version: number;
  native_round_closed: boolean;
  model_final_stop: boolean;
  rule: 'repeated_call' | 'repeated_error' | 'repeated_observation';
  count: number;
  threshold: number;
  native_call_ids: string[];
} | {
  cause: 'summary_budget_exhausted';
  version: number;
  run_calls: number;
  run_max_calls: number;
};

export interface StopSnapshot {
  basis: ReviewBasis;
  diagnostic_output: string;
  goal: unknown;
  evidence: StopEvidence;
  truncated: {
    raw_index: number;
    typed_sha256: string;
    journal_proof: string;
    effective_output_tokens: number;
  } | null;
}

export interface ArtifactReceiptRef {
  artifact_id: string;
  artifact_ref: string;
  task_id: string;
  session_id: string;
  run_id: string;
  native_call_id: string;
  input_sha256: string;
  output_sha256: string;
  status: 'candidate' | 'verified' | 'revoked' | 'unknown';
}

export interface HostArtifactReceipt {
  receipt_id: string;
  artifact_id: string;
  task_id: string;
  session_id: string;
  run_id: string;
  native_call_id: string;
  input_sha256: string;
  output_sha256: string;
  verifier: string;
  verifier_version: string;
  verified_at: string;
  committed: true;
  settled: true;
}

export interface ToolArtifact extends ArtifactReceiptRef {
  version: 1;
  tool: string;
  created_at: string;
  host_receipt?: HostArtifactReceipt | null;
}

export interface ArtifactReview {
  basis: ReviewBasis;
  artifacts: ToolArtifact[];
}

export interface UnknownEffectRecord {
  run_id: string;
  native_call_id: string;
  tool: string;
  receipt_ref: {
    evidence: { kind: 'journal'; session_path: string; raw_index: number; message_sha256: string }
      | { kind: 'event'; events_path: string; seq: number };
    host_receipt?: JsonReference;
  };
}

/** The standalone parser checks the receipt container and preserves its contents. */
export interface ParsedUnknownEffectRecord {
  run_id: string;
  native_call_id: string;
  tool: string;
  receipt_ref: Record<string, unknown> & { evidence: Record<string, unknown> };
}

export interface TaskOutcome {
  task_id: string;
  stop: TaskStop;
  runs: number;
  observed_calls: number;
  last_candidate: Candidate | null;
  last_receipt: ReviewReceipt | null;
  detail: string;
  task_accepted: false;
  reconciliation_fence: string | null;
  fence_presence: FencePresence;
  unknown_effects?: UnknownEffectRecord[];
  budget_stop?: { trigger: 'compaction_summary'; task_max_calls: number; total_calls: number };
  artifacts?: ArtifactReceiptRef[];
}

export interface ResumeReview {
  task_id: string;
  session_path: string;
  resume_evidence_dir: string;
  fenced_evidence_dir: string;
  fence: unknown;
  fenced_outcome: TaskOutcome | null;
  interrupted_run: {
    run_id: string;
    open_tool_calls: { id: string; name: string; arguments: unknown }[];
    raw_count: number;
  } | null;
  consumed_runs: number;
  consumed_calls: number;
}

export interface ResumeReceipt {
  committed: boolean;
  settlement: Settlement;
  tool_calls: {
    call_id: string;
    settlement: { kind: 'not_executed' } | { kind: 'completed' | 'failed'; output: string };
  }[];
  evidence: string[];
}

export type PayloadFrame<K extends string, P extends string, T> = RpcEnvelope & { kind: K }
  & ({ [Key in P]: T } | { [Key in `${P}_ref`]: JsonReference });

export interface CallbackContext<F> {
  signal: AbortSignal;
  frame: F;
}

type Awaitable<T> = T | Promise<T>;
export type ReconcileFrame = PayloadFrame<'reconcile_request', 'review', ResumeReview>;
export type ReconcileCallback = (
  review: ResumeReview, context: CallbackContext<ReconcileFrame>
) => Awaitable<ResumeReceipt>;

export interface HostCallbacks {
  tool(frame: ToolCallFrame, context: { signal: AbortSignal }): Awaitable<ToolResult>;
  verify(candidate: Candidate, context: CallbackContext<PayloadFrame<'verify_request', 'candidate', Candidate>>): Awaitable<ReviewReceipt>;
  prepare(continuation: Continuation, context: CallbackContext<PayloadFrame<'prepare_request', 'continuation', Continuation>>): Awaitable<PreparedContinuation>;
  reviewArtifacts?(review: ArtifactReview, context: CallbackContext<PayloadFrame<'review_artifacts_request', 'review', ArtifactReview>>): Awaitable<ToolArtifact[]>;
  verify_budget_snapshot?(snapshot: BudgetStopSnapshot, context: CallbackContext<PayloadFrame<'verify_budget_request', 'snapshot', BudgetStopSnapshot>>): Awaitable<ReviewReceipt>;
  prepare_budget_stop_continuation?(continuation: Continuation<BudgetStopSnapshot>, context: CallbackContext<PayloadFrame<'prepare_budget_request', 'budget_continuation', Continuation<BudgetStopSnapshot>>>): Awaitable<PreparedContinuation>;
  verifyStopSnapshot?(snapshot: StopSnapshot, context: CallbackContext<PayloadFrame<'verify_stop_request', 'snapshot', StopSnapshot>>): Awaitable<ReviewReceipt>;
  prepareStopContinuation?(continuation: Continuation<StopSnapshot>, context: CallbackContext<PayloadFrame<'prepare_stop_request', 'stop_continuation', Continuation<StopSnapshot>>>): Awaitable<PreparedContinuation>;
  reconcileResume?: ReconcileCallback;
}

export type HostEvent = {
  kind: 'event';
  version: 1;
  task_id: string;
  run_id: string;
  seq: number;
  event_type: string;
  /** Present only after event_payloads opt-in; never a complete evidence stream. */
  payload?: Record<string, unknown> & { type: string };
  delivery: 'best_effort_not_complete_evidence';
} | {
  kind: 'mcp_status';
  version: 1;
  task_id: string;
  servers: Record<string, unknown>;
  excluded: unknown[];
} | GuidanceAckFrame;

export interface TerminalFrame {
  kind: 'task_result';
  version: 1;
  task_id: string;
  stop: TaskStop;
  task_accepted: false;
  runs: number;
  observed_calls: number;
  fence_presence: FencePresence;
  reconciliation_fence: string | null;
  outcome_ref: JsonReference;
  local_callbacks_finished: boolean;
  budget_review_ref?: JsonReference;
}

export interface TaskResult {
  delivery: 'unknown' | 'validated';
  reconciliation_required: boolean;
  terminal: TerminalFrame | null;
  outcome: TaskOutcome | null;
  unknownEffects: readonly Readonly<ParsedUnknownEffectRecord>[] | null;
  process: { exit_code: number | null; signal: string | null; forced: boolean; closed: boolean };
  callbacks_finished: boolean;
  fault: string | null;
  stderr: { bytes: number; sha256: string; preview: string };
  operation_directory: string;
}

export interface TaskHandle {
  wait(): Promise<TaskResult>;
  cancel(): void;
  guide(messageId: string, text: string): Promise<void>;
  forceKill(): void;
  status(): {
    phase: 'running' | 'terminal_received' | 'finished';
    cancelled: boolean;
    forced: boolean;
    closed: boolean;
    pending_callbacks: number;
    pid: number | null;
  };
}

export interface StartTaskOptions {
  binary: string;
  start: StartTaskFrame;
  modelToken: string;
  operationDirectory: string;
  callbacks: HostCallbacks;
  onEvent?: (frame: HostEvent) => Awaitable<void>;
  env?: Record<string, string | undefined>;
  binaryArgs?: string[];
}

export interface BudgetReviewRecord {
  version: 1;
  kind: 'closed_budget_snapshot_review';
  snapshot: JsonReference;
  receipt: ReviewReceipt;
}

export function startTask(options: StartTaskOptions): Promise<TaskHandle>;
export function runTask(options: StartTaskOptions): Promise<TaskResult>;
export function readCheckedJsonReference(ref: JsonReference, evidenceDirectory: string, maxBytes?: number): Promise<unknown>;
export function parseUnknownEffects(outcome: unknown): readonly Readonly<ParsedUnknownEffectRecord>[];
export function reconcileReplyFor(frame: RpcEnvelope, receipt: ResumeReceipt): RpcEnvelope & { kind: 'reconcile_reply'; receipt: ResumeReceipt };
export function settleReconcile(reconcileResume: ReconcileCallback, frame: ReconcileFrame, review: ResumeReview, signal: AbortSignal): Promise<RpcEnvelope & { kind: 'reconcile_reply'; receipt: ResumeReceipt }>;
export function readBudgetReviewReference(reference: JsonReference, evidenceDirectory: string, task: TaskConfig, outcome: TaskOutcome): Promise<BudgetReviewRecord>;
