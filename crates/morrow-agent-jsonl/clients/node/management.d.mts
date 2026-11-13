import type { TaskConfig } from './client.mjs';

export interface LibraryRoots {
  environment_dir: string;
  global_knowledge: string;
  project_knowledge: string;
  global_skills: string;
  project_skills: string;
}
export type SkillScope = 'project' | 'global' | 'builtin';
export interface EvidenceScope { task_id: string; session_id: string; evidence_dir: string }
export interface ProvenanceQuery {
  task_id?: string; session_id?: string; run_id?: string;
  kind?: 'artifact' | 'skill'; artifact_id?: string; skill_name?: string; bundle_hash?: string;
  host_receipt_id?: string; status?: 'candidate' | 'verified' | 'revoked' | 'unknown';
  time_from_ms?: number; time_to_ms?: number;
}
export interface JobReceipt {
  job_id: string; state: string; effects_unknown: boolean;
  finished_at: number | null; started_at: number | null; exit_code: number | null;
  reason: string; process_pid: number | null; worker_pid: number | null;
  terminal: boolean; interactive: boolean; stdin_closed: boolean; rows: number; cols: number;
  stdout_bytes: number; stderr_bytes: number; stdout_sha256: string | null; stderr_sha256: string | null;
  lease_expires_at: number;
}
export interface JobSnapshot { goal_id: string; goal_status: string; device: string; session_id: string; jobs: JobReceipt[] }
export interface QueueTrigger { id: string; revision: string; source_ref: string }
export interface QueueMandate { id: string; revision: string; authorization_ref: string; configuration_sha256: string }
export interface QueueAssignment {
  id: string;
  trigger_id: string;
  mandate_id: string;
  task: TaskConfig;
  session_id: string;
  session_path: string;
  cwd: string;
  configuration_sha256: string;
  options: { budget_stop_review?: 'reject' | 'review_closed_tool_round'; length_stop_review?: 'reject' | 'review_closed_length' };
}
type SkillTarget = { roots: LibraryRoots; scope: SkillScope; name: string };
type SessionTarget = { session: string; cwd: string };
export type ManagementRequest = { id?: string } & (
  | { operation: 'provenance_query'; scopes: EvidenceScope[]; query: ProvenanceQuery }
  | { operation: 'resolve_roots'; state_dir: string; cwd: string; global?: string }
  | { operation: 'skill_catalog'; roots: LibraryRoots; offset?: number; limit?: number }
  | ({ operation: 'skill_verification' } & SkillTarget)
  | ({ operation: 'skill_read'; path?: string; offset?: number; max_bytes?: number } & SkillTarget)
  | ({ operation: 'skill_create'; description: string; instructions: string; resources?: Record<string, string> } & SkillTarget)
  | { operation: 'skill_install'; roots: LibraryRoots; scope: SkillScope; source_dir: string }
  | ({ operation: 'skill_remove'; expected_hash: string } & SkillTarget)
  | ({ operation: 'skill_enable'; expected_hash: string; enabled: boolean } & SkillTarget)
  | ({ operation: 'context_snapshot' } & SessionTarget)
  | ({ operation: 'context_command'; command: string; compact?: boolean } & SessionTarget)
  | ({ operation: 'context_add_reference'; kind: string; text: string; compact?: boolean } & SessionTarget)
  | ({ operation: 'goal_snapshot' } & SessionTarget)
  | ({ operation: 'job_snapshot'; device: string; session_id: string; job_id?: string } & SessionTarget)
  | ({ operation: 'goal_control'; goal_id: string; command: 'status' | 'accept' | 'pause' | 'resume' | 'stop';
      command_id: string; expected_revision: number; reviewed_run: string } & SessionTarget)
  | { operation: 'queue_snapshot'; directory: string }
  | { operation: 'queue_events'; directory: string; after?: number }
  | { operation: 'queue_cancel'; directory: string; assignment_id: string; at_ms: number }
  | { operation: 'queue_watchdog'; directory: string; at_ms: number }
  | { operation: 'queue_enqueue'; directory: string; trigger: QueueTrigger; mandate: QueueMandate; assignment: QueueAssignment; at_ms: number }
);
export interface ManagementOptions {
  binary: string;
  binaryArgs?: string[];
  request: ManagementRequest;
  timeoutMs?: number;
  env?: Record<string, string>;
}
export class ManagementError extends Error {
  delivery: 'not_started' | 'validated' | 'unknown';
}
export function sendManagement<T = unknown>(options: ManagementOptions): Promise<T>;
