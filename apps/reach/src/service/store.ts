// Copyright (c) Ray Zhang. Product identity and receipts belong to Reach Host.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { finalStates } from '../contracts/protocol.ts';
import type { Command, DeliveryState, ExecutionState, OperationEvent, Reconciliation } from '../contracts/protocol.ts';
import { requireCondition, ReachError } from './errors.ts';
import { listArtifacts, readArtifact, validateArtifactEvent } from './artifacts.ts';
import {AgentCalls} from './agent-calls.ts';
import {AgentModels} from './agent-model-store.ts';
import {AgentReviews} from './agent-reviews.ts';
import {AgentBudgets} from './agent-budgets.ts';
import {ServiceOwner} from './owner.ts';
import {AgentExecutions} from './agent-executions.ts';
import {AgentResumes} from './agent-resumes.ts';
import {AgentFinalizations} from './agent-finalizations.ts';
import {AgentClosures} from './agent-closures.ts';
import {SourceLibrary} from './source-library.ts';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown) => sha256(canonical(value));
const secret = () => randomBytes(32).toString('base64url');
interface UserRow { id: string; username: string; salt: string; password_hash: string }
export interface User { id: string; username: string }
export interface NodeRow { id: string; user_id: string; installation_id: string; name: string; platform: string; version: string; epoch: number; token_hash: string | null; capabilities: string; last_seen: number | null; revoked: number }
export interface OperationRow {
  id: string; user_id: string; node_id: string; epoch: number; request_id: string;
  command_json: string; payload_hash: string; delivery: DeliveryState; execution: ExecutionState;
  dispatch_id: string | null; claimed_at: number | null; cancel_requested: number;
  last_sequence: number; result_json: string | null; created_at: number; updated_at: number;
}
export type ControlRow=Pick<OperationRow,'id'|'dispatch_id'|'payload_hash'|'cancel_requested'|'execution'|'last_sequence'>;
interface EventRow { operation_id: string; event_id: string; digest: string; sequence: number; kind: string; data_json: string; received_at: number }

export class ReachStore {
  db!: DatabaseSync;
  now: () => number;
  readonly agents:AgentCalls;
  readonly models:AgentModels;
  readonly reviews:AgentReviews;
  readonly budgets:AgentBudgets;
  readonly executions:AgentExecutions;
  readonly resumes:AgentResumes;
  readonly finalizations:AgentFinalizations;
  readonly closures:AgentClosures;
  readonly library:SourceLibrary;
  readonly owner:ServiceOwner;
  private closed=false;
  private broker?:{identity:object;closed:()=>boolean};
  private httpOwners=new Map<object,()=>boolean>();
  private transactionDepth=0;
  constructor(filename: string, now = Date.now) {
    this.owner=new ServiceOwner(filename);
    try{
    this.db = new DatabaseSync(this.owner.filename);
    this.owner.bindDatabase();
    this.now = now;
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 11) {
      this.db.close();
      throw new Error('Database schema is newer than this Reach service; restore the matching binary');
    }
    if(version.user_version===11)requireCondition(this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('source_library','source_library_validations','source_library_reviews','source_library_uses','agent_native_closures')").get()!.n===5,409,'library_schema_missing','资料库结构缺失，不能自动重建为新空库');
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec('BEGIN IMMEDIATE');this.transactionDepth=1;
    try{this.db.exec(`
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pairing_codes(code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, consumed_at INTEGER);
      CREATE TABLE IF NOT EXISTS pairing_attempts(id TEXT PRIMARY KEY, digest TEXT NOT NULL, node_id TEXT NOT NULL, epoch INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), installation_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL, version TEXT NOT NULL, epoch INTEGER NOT NULL, token_hash TEXT UNIQUE, capabilities TEXT NOT NULL DEFAULT '[]', last_seen INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), node_id TEXT NOT NULL REFERENCES nodes(id), epoch INTEGER NOT NULL, request_id TEXT NOT NULL, command_json TEXT NOT NULL, payload_hash TEXT NOT NULL, delivery TEXT NOT NULL, execution TEXT NOT NULL, dispatch_id TEXT, claimed_at INTEGER, cancel_requested INTEGER NOT NULL DEFAULT 0, last_sequence INTEGER NOT NULL DEFAULT 0, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(user_id, request_id));
      CREATE TABLE IF NOT EXISTS operation_events(operation_id TEXT NOT NULL REFERENCES operations(id), event_id TEXT NOT NULL, digest TEXT NOT NULL, sequence INTEGER NOT NULL, kind TEXT NOT NULL, data_json TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY(operation_id, event_id), UNIQUE(operation_id, sequence));
      CREATE TABLE IF NOT EXISTS operation_reconciliations(id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id), digest TEXT NOT NULL, actor TEXT NOT NULL, evidence_json TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS operation_queue ON operations(node_id, epoch, delivery, created_at);
      CREATE TABLE IF NOT EXISTS agent_calls(parent_id TEXT NOT NULL REFERENCES operations(id),call_key TEXT NOT NULL,run_id TEXT NOT NULL,call_id TEXT NOT NULL,tool TEXT NOT NULL,args_sha256 TEXT NOT NULL,arguments_json TEXT NOT NULL,command_sha256 TEXT NOT NULL,child_id TEXT NOT NULL UNIQUE REFERENCES operations(id),PRIMARY KEY(parent_id,call_key),UNIQUE(parent_id,run_id,call_id));
      CREATE TABLE IF NOT EXISTS agent_runs(parent_id TEXT NOT NULL REFERENCES operations(id),run_id TEXT NOT NULL,PRIMARY KEY(parent_id,run_id));
      CREATE TABLE IF NOT EXISTS agent_task_models(parent_id TEXT PRIMARY KEY REFERENCES operations(id),route_hash TEXT NOT NULL,descriptor_json TEXT NOT NULL,bound_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_model_calls(parent_id TEXT NOT NULL REFERENCES operations(id),request_id TEXT NOT NULL,run_id TEXT NOT NULL,identity_sha256 TEXT NOT NULL,body_sha256 TEXT NOT NULL,state TEXT NOT NULL,reserved_at INTEGER NOT NULL,finished_at INTEGER,error_code TEXT,upstream_status INTEGER,response_bytes INTEGER,finish_reason TEXT,usage_json TEXT,PRIMARY KEY(parent_id,request_id),FOREIGN KEY(parent_id,run_id) REFERENCES agent_runs(parent_id,run_id));
      CREATE TABLE IF NOT EXISTS agent_run_reviews(parent_id TEXT NOT NULL REFERENCES operations(id),run_id TEXT NOT NULL,run_number INTEGER NOT NULL,basis_sha256 TEXT NOT NULL,candidate_json TEXT NOT NULL,children_json TEXT NOT NULL,decision_json TEXT,published_at INTEGER NOT NULL,PRIMARY KEY(parent_id,run_id),UNIQUE(parent_id,run_number));
      CREATE TABLE IF NOT EXISTS agent_run_budgets(parent_id TEXT NOT NULL,run_id TEXT NOT NULL,run_number INTEGER NOT NULL,reserved_cap INTEGER NOT NULL,admitted_cap INTEGER,charge_floor INTEGER NOT NULL DEFAULT 0,closed_for_resume INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(parent_id,run_id),UNIQUE(parent_id,run_number),FOREIGN KEY(parent_id,run_id) REFERENCES agent_runs(parent_id,run_id));
      CREATE TABLE IF NOT EXISTS agent_budget_reconciliations(parent_id TEXT NOT NULL REFERENCES operations(id),receipt_id TEXT NOT NULL,identity_sha256 TEXT NOT NULL,source_json TEXT NOT NULL,receipt_json TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(parent_id,receipt_id));
      CREATE TABLE IF NOT EXISTS agent_service_instances(instance_id TEXT PRIMARY KEY,lock_identity TEXT NOT NULL,protocol_version INTEGER NOT NULL,started_at INTEGER NOT NULL,closed_at INTEGER);
      CREATE TABLE IF NOT EXISTS agent_model_owners(parent_id TEXT NOT NULL,request_id TEXT NOT NULL,instance_id TEXT NOT NULL REFERENCES agent_service_instances(instance_id),execution_id TEXT NOT NULL REFERENCES operations(id),generation INTEGER NOT NULL,route_hash TEXT NOT NULL,phase TEXT NOT NULL,joined_at INTEGER,PRIMARY KEY(parent_id,request_id),FOREIGN KEY(parent_id,request_id) REFERENCES agent_model_calls(parent_id,request_id));
      CREATE TABLE IF NOT EXISTS agent_model_stops(parent_id TEXT NOT NULL,request_id TEXT NOT NULL,reconciliation_id TEXT NOT NULL,identity_sha256 TEXT NOT NULL,input_json TEXT NOT NULL,receipt_json TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(parent_id,request_id),UNIQUE(parent_id,reconciliation_id),FOREIGN KEY(parent_id,request_id) REFERENCES agent_model_calls(parent_id,request_id));
      CREATE TABLE IF NOT EXISTS agent_tasks(root_id TEXT PRIMARY KEY REFERENCES operations(id),active_execution_id TEXT NOT NULL UNIQUE REFERENCES operations(id),generation INTEGER NOT NULL CHECK(generation>0),deadline_unix_ms INTEGER,requires_reconciliation INTEGER NOT NULL DEFAULT 0 CHECK(requires_reconciliation IN (0,1)));
      CREATE TABLE IF NOT EXISTS agent_executions(execution_id TEXT PRIMARY KEY REFERENCES operations(id),root_id TEXT NOT NULL REFERENCES agent_tasks(root_id),previous_execution_id TEXT REFERENCES agent_executions(execution_id),generation INTEGER NOT NULL CHECK(generation>0),expected_fence_sha256 TEXT,instruction_sha256 TEXT,phase TEXT NOT NULL CHECK(phase IN ('active','reconciling')),UNIQUE(root_id,generation));
      CREATE TABLE IF NOT EXISTS agent_child_executions(child_id TEXT PRIMARY KEY REFERENCES operations(id),root_id TEXT NOT NULL REFERENCES agent_tasks(root_id),execution_id TEXT NOT NULL REFERENCES agent_executions(execution_id),generation INTEGER NOT NULL CHECK(generation>0));
      CREATE TABLE IF NOT EXISTS agent_resume_plans(execution_id TEXT PRIMARY KEY REFERENCES agent_executions(execution_id),identity_sha256 TEXT NOT NULL,plan_json TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_resume_receipts(execution_id TEXT PRIMARY KEY REFERENCES agent_executions(execution_id),parent_id TEXT NOT NULL REFERENCES agent_tasks(root_id),identity_sha256 TEXT NOT NULL,input_json TEXT NOT NULL,receipt_json TEXT NOT NULL,receipt_sha256 TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_resume_models(execution_id TEXT NOT NULL REFERENCES agent_resume_receipts(execution_id),parent_id TEXT NOT NULL,request_id TEXT NOT NULL,model_sha256 TEXT NOT NULL,owner_sha256 TEXT NOT NULL,stop_sha256 TEXT,PRIMARY KEY(execution_id,request_id),FOREIGN KEY(parent_id,request_id) REFERENCES agent_model_calls(parent_id,request_id));
      CREATE TABLE IF NOT EXISTS agent_run_origins(parent_id TEXT NOT NULL,run_id TEXT NOT NULL,registered_execution_id TEXT NOT NULL REFERENCES agent_executions(execution_id),registered_generation INTEGER NOT NULL,admitted_execution_id TEXT REFERENCES agent_executions(execution_id),admitted_generation INTEGER,admission_json TEXT,PRIMARY KEY(parent_id,run_id),FOREIGN KEY(parent_id,run_id) REFERENCES agent_runs(parent_id,run_id));
      CREATE TABLE IF NOT EXISTS agent_review_executions(parent_id TEXT NOT NULL,run_id TEXT NOT NULL,execution_id TEXT NOT NULL REFERENCES agent_executions(execution_id),generation INTEGER NOT NULL,PRIMARY KEY(parent_id,run_id),FOREIGN KEY(parent_id,run_id) REFERENCES agent_run_reviews(parent_id,run_id));
      CREATE TABLE IF NOT EXISTS agent_task_finishes(root_id TEXT PRIMARY KEY REFERENCES agent_tasks(root_id),execution_id TEXT NOT NULL UNIQUE REFERENCES agent_executions(execution_id),generation INTEGER NOT NULL,event_id TEXT NOT NULL,proof_json TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_finalizers(execution_id TEXT PRIMARY KEY REFERENCES agent_executions(execution_id),root_id TEXT NOT NULL REFERENCES agent_tasks(root_id),source_execution_id TEXT NOT NULL REFERENCES agent_executions(execution_id),source_generation INTEGER NOT NULL,expected_released_sha256 TEXT NOT NULL,proof_json TEXT);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_library(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,node_id TEXT NOT NULL REFERENCES nodes(id),epoch INTEGER NOT NULL,source_task_id TEXT NOT NULL REFERENCES operations(id),version_sha256 TEXT NOT NULL,version_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('candidate','adopted','revoked')),created_at INTEGER NOT NULL,UNIQUE(user_id,request_id));
      CREATE TABLE IF NOT EXISTS source_library_validations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,entry_id TEXT NOT NULL REFERENCES source_library(id),version_sha256 TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES operations(id),evidence_json TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(user_id,request_id));
      CREATE TABLE IF NOT EXISTS source_library_reviews(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,entry_id TEXT NOT NULL REFERENCES source_library(id),version_sha256 TEXT NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('adopt','revoke')),validation_id TEXT REFERENCES source_library_validations(id),reason TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(user_id,request_id));
      CREATE TABLE IF NOT EXISTS source_library_uses(task_id TEXT NOT NULL REFERENCES agent_tasks(root_id),entry_id TEXT NOT NULL REFERENCES source_library(id),version_sha256 TEXT NOT NULL,stage TEXT NOT NULL CHECK(stage IN ('candidate','adopted')),source_id TEXT NOT NULL,PRIMARY KEY(task_id,source_id));
      CREATE TABLE IF NOT EXISTS agent_native_closures(operation_id TEXT PRIMARY KEY REFERENCES operations(id),event_id TEXT NOT NULL,proof_sha256 TEXT NOT NULL,at INTEGER NOT NULL,FOREIGN KEY(operation_id,event_id) REFERENCES operation_events(operation_id,event_id) DEFERRABLE INITIALLY DEFERRED);
      `);
    this.agents=new AgentCalls(this);
    this.models=new AgentModels(this);
    this.reviews=new AgentReviews(this);
    this.budgets=new AgentBudgets(this);
    this.executions=new AgentExecutions(this);
    this.resumes=new AgentResumes(this);
    this.finalizations=new AgentFinalizations(this);
    this.closures=new AgentClosures(this);
    this.library=new SourceLibrary(this);
    if(version.user_version<8)this.db.exec('INSERT OR IGNORE INTO agent_runs SELECT DISTINCT parent_id,run_id FROM agent_calls');
    this.budgets.migrate(version.user_version);
    this.executions.migrate(version.user_version);
    this.resumes.migrate(version.user_version);
    this.finalizations.migrate(version.user_version);
    this.library.migrate();
    this.db.prepare('INSERT INTO agent_service_instances VALUES(?,?,10,?,NULL)').run(this.owner.instanceId,this.owner.lockIdentity,this.now());
    this.db.exec('PRAGMA user_version=11; COMMIT');
    }catch(error){try{this.db.exec('ROLLBACK');}finally{this.db.close();}throw error;}finally{this.transactionDepth=0;}
    }catch(error){try{this.db?.close();}catch{}this.owner.close();throw error;}
  }
  get isOpen(){return !this.closed;}
  bindModelBroker(identity:object,closed:()=>boolean){requireCondition(!this.closed&&!this.owner.closed,503,'agent_owner_closed','服务实例已关闭');requireCondition(!this.broker||this.broker.identity===identity,409,'agent_broker_owned','该状态库已绑定另一个模型运输实例');this.broker={identity,closed};}
  bindHttpOwner(identity:object,drained:()=>boolean){this.owner.assertCurrent();this.httpOwners.set(identity,drained);}
  close() {
    if(this.closed)return;
    requireCondition(!this.broker||this.broker.closed(),409,'agent_broker_active','先关闭并等待模型运输，再释放服务实例');
    requireCondition([...this.httpOwners.values()].every(drained=>drained()),409,'agent_http_active','先关闭并等待 HTTP 处理结束，再释放服务实例');
    let failure:unknown;try{this.owner.assertCurrent();this.db.prepare('UPDATE agent_service_instances SET closed_at=? WHERE instance_id=? AND closed_at IS NULL').run(this.now(),this.owner.instanceId);}catch(error){failure=error;}
    this.db.close();this.closed=true;this.owner.close();
    if(failure)throw failure;
  }
  transaction<T>(fn: () => T): T {
    this.owner.assertCurrent();
    const depth=this.transactionDepth++,savepoint='reach_nested_'+depth;
    try{this.db.exec(depth?'SAVEPOINT '+savepoint:'BEGIN IMMEDIATE');try{const result=fn();this.db.exec(depth?'RELEASE '+savepoint:'COMMIT');return result;}catch(error){this.db.exec(depth?'ROLLBACK TO '+savepoint:'ROLLBACK');if(depth)this.db.exec('RELEASE '+savepoint);throw error;}}finally{this.transactionDepth--;}
  }
  audit(actor: string, kind: string, subject: string) {
    this.db.prepare('INSERT INTO audit(at, actor, kind, subject) VALUES(?,?,?,?)').run(this.now(), actor, kind, subject);
  }
  bootstrap(username: string, password: string): boolean {
    requireCondition(username.length >= 1 && username.length <= 128 && password.length >= 16 && password.length <= 1024, 400, 'invalid_bootstrap', 'Bootstrap requires a username and a password of 16–1024 characters');
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    return this.transaction(() => {
      if (this.db.prepare('SELECT id FROM users LIMIT 1').get()) return false;
      const id = randomUUID();
      this.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id, username, salt, hash);
      this.audit(id, 'account.created', id);
      return true;
    });
  }
  login(username: string, password: string) {
    requireCondition(username.length <= 128 && password.length <= 1024, 401, 'invalid_credentials', '登录信息不正确');
    const user = this.db.prepare('SELECT * FROM users WHERE username=?').get(username) as unknown as UserRow | undefined;
    const hash = scryptSync(password, user?.salt ?? 'reach-unknown-user-dummy-salt', 64);
    requireCondition(user && timingSafeEqual(hash, Buffer.from(user.password_hash, 'hex')), 401, 'invalid_credentials', '登录信息不正确');
    return this.createSession(user, this.now() + 12 * 60 * 60 * 1000);
  }
  loginFromRay(username: string, expiresAt: number, sessionHash: string, token: string) {
    const user = this.db.prepare('SELECT id,username FROM users WHERE username=?').get(username) as unknown as User | undefined;
    requireCondition(user && expiresAt > this.now(), 401, 'ray_account_unavailable', 'Reach 的 Ray 账户映射不可用');
    return this.transaction(() => {
      // A Ray session has one token even when two first-page loads race.
      // The caller derives it server-side; native login tokens remain random.
      this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(token));
      const session = this.createSession(user, expiresAt, token);
      this.audit(user.id, 'session.ray', sessionHash);
      return session;
    });
  }
  private createSession(user: User, expiresAt: number, token = secret()) {
    const csrf = secret();
    this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(this.now());
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(sha256(token), user.id, csrf, expiresAt);
    this.audit(user.id, 'session.created', user.id);
    return { token, csrf, expiresAt, user: { id: user.id, username: user.username } };
  }
  session(token: string) {
    const row = this.db.prepare('SELECT users.id, users.username, sessions.csrf FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?').get(sha256(token), this.now()) as unknown as (User & { csrf: string }) | undefined;
    requireCondition(row, 401, 'authentication_required', '请先登录 Reach');
    return row;
  }
  logout(token: string) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(token)); }
  createPairing(userId: string) {
    const code = randomBytes(10).toString('hex').toUpperCase();
    const expiresAt = this.now() + 10 * 60 * 1000;
    this.db.prepare('DELETE FROM pairing_codes WHERE expires_at<=?').run(this.now());
    this.db.prepare('INSERT INTO pairing_codes VALUES(?,?,?,NULL)').run(sha256(code), userId, expiresAt);
    this.audit(userId, 'pairing.created', 'one-time-code');
    return { code, expiresAt };
  }
  pair(input: { attemptId: string; code: string; installationId: string; installationSecret: string; name: string; platform: string; version: string }, previousToken?: string) {
    return this.transaction(() => {
      const attemptDigest = digest(input);
      const priorAttempt = this.db.prepare('SELECT * FROM pairing_attempts WHERE id=?').get(input.attemptId) as { digest: string; node_id: string; epoch: number } | undefined;
      if (priorAttempt) {
        requireCondition(priorAttempt.digest === attemptDigest, 409, 'pairing_attempt_conflict', '同一配对尝试内容发生变化');
        const current = this.db.prepare('SELECT epoch,revoked FROM nodes WHERE id=?').get(priorAttempt.node_id) as { epoch: number; revoked: number };
        requireCondition(current.epoch === priorAttempt.epoch, 409, 'pairing_superseded', '配对已被新安装凭据替换');
        // An accepted receipt remains recoverable after unpairing. Returning
        // it recovers installation ownership without reactivating the binding.
        return { nodeId: priorAttempt.node_id, epoch: priorAttempt.epoch, revoked: !!current.revoked };
      }
      const codeHash = sha256(input.code.toUpperCase());
      const code = this.db.prepare('SELECT user_id FROM pairing_codes WHERE code_hash=? AND expires_at>? AND consumed_at IS NULL').get(codeHash, this.now()) as { user_id: string } | undefined;
      requireCondition(code, 400, 'invalid_pairing_code', '配对码无效或已过期');
      const existing = this.db.prepare('SELECT * FROM nodes WHERE installation_id=?').get(input.installationId) as unknown as NodeRow | undefined;
      if (existing) {
        requireCondition(previousToken && existing.token_hash === sha256(previousToken), 409, 'installation_owned', '已有安装需要原节点凭据才能更换配对');
        const active = (this.db.prepare("SELECT * FROM operations WHERE node_id=? AND execution IN ('not_observed','received','running','unknown') AND delivery<>'cancelled'").all(existing.id) as unknown as OperationRow[]).some(op=>this.executions.blocks(op));
        const recovering=this.db.prepare('SELECT 1 FROM agent_tasks t JOIN operations r ON r.id=t.root_id WHERE r.node_id=? AND t.requires_reconciliation=1 LIMIT 1').get(existing.id);
        requireCondition(!active&&!recovering, 409, 'operations_unsettled', '请先核对并结算原操作，再更换配对');
      }
      // Node persists this random 256-bit credential and attempt before sending.
      // A lost pairing response can therefore be retried without losing identity.
      const token = input.installationSecret;
      const id = existing?.id ?? randomUUID();
      const epoch = (existing?.epoch ?? 0) + 1;
      this.db.prepare(`INSERT INTO nodes(id,user_id,installation_id,name,platform,version,epoch,token_hash,last_seen) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,name=excluded.name,platform=excluded.platform,version=excluded.version,epoch=excluded.epoch,token_hash=excluded.token_hash,last_seen=excluded.last_seen,revoked=0,capabilities='[]'`).run(id, code.user_id, input.installationId, input.name, input.platform, input.version, epoch, sha256(token), this.now());
      this.db.prepare('UPDATE pairing_codes SET consumed_at=? WHERE code_hash=?').run(this.now(), codeHash);
      this.db.prepare('INSERT INTO pairing_attempts VALUES(?,?,?,?)').run(input.attemptId, attemptDigest, id, epoch);
      this.audit(code.user_id, existing ? 'node.repaired' : 'node.paired', id);
      return { nodeId: id, epoch, revoked: false };
    });
  }
  node(token: string, receiptOnly = false): NodeRow {
    const node = this.db.prepare('SELECT * FROM nodes WHERE token_hash=?').get(sha256(token)) as unknown as NodeRow | undefined;
    requireCondition(node, 401, 'node_authentication_required', '节点身份无效');
    requireCondition(receiptOnly || !node.revoked, 401, 'node_unpaired', '设备已解绑');
    return node;
  }
  ownedNode(userId: string, id: string): NodeRow {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id=? AND user_id=?').get(id, userId) as unknown as NodeRow | undefined;
    requireCondition(row, 404, 'node_not_found', '未找到这台设备');
    return row;
  }
  nodes(userId: string) {
    return (this.db.prepare('SELECT id,name,platform,version,epoch,last_seen,revoked,capabilities FROM nodes WHERE user_id=? ORDER BY name').all(userId)).map(row => ({ ...row, capabilities: JSON.parse(row.capabilities as string), online: !row.revoked && row.last_seen !== null && this.now() - Number(row.last_seen) < 30000 }));
  }
  revoke(userId: string, id: string) {
    return this.transaction(() => {
      this.ownedNode(userId, id);
      // Keep the credential digest as proof of installation ownership for re-pairing.
      this.db.prepare('UPDATE nodes SET revoked=1 WHERE id=?').run(id);
      this.db.prepare("UPDATE operations SET delivery='cancelled',execution='cancelled',cancel_requested=1,result_json=NULL,updated_at=? WHERE node_id=? AND delivery='queued'").run(this.now(), id);
      this.db.prepare("UPDATE operations SET delivery='uncertain',cancel_requested=1,updated_at=? WHERE node_id=? AND execution IN ('not_observed','received','running') AND delivery<>'cancelled'").run(this.now(), id);
      this.audit(userId, 'node.revoked', id);
    });
  }
  hello(node: NodeRow, version: string, capabilities: string[]) {
    this.db.prepare('UPDATE nodes SET last_seen=?,version=?,capabilities=? WHERE id=? AND epoch=? AND revoked=0').run(this.now(), version, JSON.stringify([...new Set(capabilities)]), node.id, node.epoch);
  }
  submit(userId: string, requestId: string, nodeId: string, command: Command, expectedEpoch?:number) {
    return this.transaction(() => {
      const node = this.ownedNode(userId, nodeId);
      requireCondition(!node.revoked, 409, 'node_unpaired', '设备已解绑');
      requireCondition(expectedEpoch===undefined||(Number.isSafeInteger(expectedEpoch)&&expectedEpoch===node.epoch),409,'node_pairing_changed','设备配对已变化，请重新选择执行目标');
      const previous = this.db.prepare('SELECT * FROM operations WHERE user_id=? AND request_id=?').get(userId, requestId) as unknown as OperationRow | undefined;
      const payloadHash = digest({ nodeId, epoch: node.epoch, command });
      if (previous) {
        requireCondition(previous.payload_hash === payloadHash, 409, 'request_id_conflict', '同一请求 ID 不能用于不同操作');
        return previous;
      }
      if(command.kind==='agent.delegate')this.agents.validate(command,node);
      if(command.kind==='agent.inspect'){const root=this.operation(userId,command.rootOperationId);requireCondition(JSON.parse(root.command_json).kind==='agent.delegate'&&root.node_id===nodeId&&root.epoch===node.epoch,409,'agent_inspection_binding','检查须对应同一设备配对的原 Task');}
      requireCondition((JSON.parse(node.capabilities) as string[]).includes(command.kind), 409, 'capability_unavailable', '节点尚未声明这项能力');
      if (command.kind === 'file.read' && (command.resultFormat !== undefined || command.expectedFileVersion !== undefined)) {
        requireCondition((JSON.parse(node.capabilities) as string[]).includes('file.read.artifact'), 409, 'capability_unavailable', '节点尚未声明文件产物与版本核对能力');
      }
      const id = randomUUID();
      this.db.prepare("INSERT INTO operations(id,user_id,node_id,epoch,request_id,command_json,payload_hash,delivery,execution,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'queued','not_observed',?,?)").run(id, userId, nodeId, node.epoch, requestId, JSON.stringify(command), payloadHash, this.now(), this.now());
      if(command.kind==='agent.delegate'){const op=this.operation(userId,id);this.executions.addRoot(op);this.library.recordUses(op);}
      if(command.kind==='agent.resume')this.executions.addResume(this.operation(userId,id));
      if(command.kind==='agent.finalize')this.finalizations.add(this.operation(userId,id));
      this.audit(userId, 'operation.queued', id);
      return this.operation(userId, id);
    });
  }
  operation(userId: string, id: string): OperationRow {
    const row = this.db.prepare('SELECT * FROM operations WHERE id=? AND user_id=?').get(id, userId) as unknown as OperationRow | undefined;
    requireCondition(row, 404, 'operation_not_found', '未找到这次操作');
    return row;
  }
  operations(userId: string) { return this.db.prepare('SELECT * FROM operations WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(userId); }
  overview(userId: string) {
    const operations = this.db.prepare("SELECT id,node_id,request_id,json_extract(command_json,'$.kind') AS kind,delivery,execution,cancel_requested,created_at,updated_at FROM operations WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 200").all(userId);
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE user_id=? AND (execution='unknown' OR (delivery='uncertain' AND execution NOT IN ('succeeded','failed','cancelled','unknown')))").get(userId)!;
    return { nodes: this.nodes(userId), operations, unresolvedCount: Number(count.count) };
  }
  events(userId: string, id: string, after = 0, limit = 64) {
    this.operation(userId, id);
    const result: Record<string, unknown>[] = []; let bytes = 0;
    for (const row of this.db.prepare('SELECT sequence,event_id,kind,data_json,received_at FROM operation_events WHERE operation_id=? AND sequence>? ORDER BY sequence LIMIT ?').iterate(id, after, limit)) {
      const event = { ...row, data: JSON.parse(row.data_json as string), data_json: undefined };
      const size = Buffer.byteLength(JSON.stringify(event));
      if (result.length && bytes + size > 1_900_000) break;
      result.push(event); bytes += size;
    }
    return result;
  }
  artifacts(userId: string, id: string) {
    const op = this.operation(userId, id);
    return { binding: { operationId: op.id, nodeId: op.node_id, epoch: op.epoch, dispatchId: op.dispatch_id, payloadHash: op.payload_hash }, artifacts: listArtifacts(this.db, id) };
  }
  artifact(userId: string, id: string, artifactId: string, offset: number, length: number) {
    const { binding } = this.artifacts(userId, id); // Ownership is checked before any artifact lookup.
    return { binding, ...readArtifact(this.db, id, artifactId, offset, length) };
  }
  claim(node: NodeRow) {
    return this.transaction(() => {
      // hello() may have changed the advertised capabilities since authentication
      // read `node`. In particular an older binary must not ignore queued read guards.
      const current = this.db.prepare('SELECT * FROM nodes WHERE id=? AND epoch=? AND revoked=0').get(node.id, node.epoch) as unknown as NodeRow | undefined;
      if (!current) return null;
      const rows = this.db.prepare(`SELECT * FROM operations WHERE node_id=? AND epoch=? AND delivery='queued'
        AND json_extract(command_json,'$.kind') IN (SELECT value FROM json_each(?))
        AND (json_extract(command_json,'$.kind')<>'file.read'
          OR (json_extract(command_json,'$.resultFormat') IS NULL AND json_extract(command_json,'$.expectedFileVersion') IS NULL)
          OR 'file.read.artifact' IN (SELECT value FROM json_each(?)))
        ORDER BY created_at,id`).all(node.id, node.epoch, current.capabilities, current.capabilities) as unknown as OperationRow[];
      for(const row of rows){
        const kind=JSON.parse(row.command_json).kind;
        if(kind==='agent.delegate'||kind==='agent.resume'){
          try{this.agents.validateRequirements(this.executions.resolve(row.user_id,row.id).command,current);}
          catch(error){
            if(!(error instanceof ReachError))throw error;
            const blocker=JSON.stringify({type:'agent_dispatch_blocked',code:error.code,message:error.message,started:false,taskAccepted:false});
            if(row.result_json!==blocker)this.db.prepare('UPDATE operations SET result_json=?,updated_at=? WHERE id=?').run(blocker,this.now(),row.id);
            continue;
          }
        }
      const dispatchId = randomUUID();
      this.db.prepare("UPDATE operations SET delivery='claimed',dispatch_id=?,claimed_at=?,updated_at=?,result_json=NULL WHERE id=? AND delivery='queued'").run(dispatchId, this.now(), this.now(), row.id);
      if(this.executions.isAgent(row))this.executions.claimed(this.operation(row.user_id,row.id));
      return { operationId: row.id, nodeId: node.id, epoch: node.epoch, dispatchId, payloadHash: row.payload_hash, command: JSON.parse(row.command_json), createdAt: row.created_at };
      }
      return null;
    });
  }
  // Startup and stale transport observations never requeue claimed work.
  observeStaleClaims() {
    this.db.prepare("UPDATE operations SET delivery='uncertain',updated_at=? WHERE delivery='claimed' AND claimed_at<?").run(this.now(), this.now() - 30000);
  }
  pending(node: NodeRow) {
    return this.db.prepare("SELECT id,dispatch_id,payload_hash,delivery,execution,cancel_requested,last_sequence FROM operations WHERE node_id=? AND epoch=? AND dispatch_id IS NOT NULL AND execution NOT IN ('succeeded','failed','cancelled') ORDER BY created_at").all(node.id, node.epoch);
  }
  control(node: NodeRow, id: string):ControlRow&{parentOperationId?:string;parentDeadlineUnixMs?:number} {
    const row = this.db.prepare('SELECT id,dispatch_id,payload_hash,cancel_requested,execution,last_sequence FROM operations WHERE id=? AND node_id=? AND epoch=?').get(id, node.id, node.epoch) as unknown as ControlRow|undefined;
    requireCondition(row, 404, 'operation_not_found', '未找到这次操作');
    this.db.prepare('UPDATE nodes SET last_seen=? WHERE id=? AND epoch=? AND revoked=0').run(this.now(), node.id, node.epoch);
    return this.agents.control(node,row);
  }
  cancel(userId: string, id: string) {
    return this.transaction(() => {
      let op = this.operation(userId, id);
      if(JSON.parse(op.command_json).kind==='agent.delegate')op=this.executions.current(op);
      this.agents.cancelChildren(op);
      if (finalStates.has(op.execution)) return op;
      if (op.delivery === 'queued') this.db.prepare("UPDATE operations SET delivery='cancelled',execution='cancelled',cancel_requested=1,result_json=NULL,updated_at=? WHERE id=?").run(this.now(), op.id);
      else this.db.prepare('UPDATE operations SET cancel_requested=1,updated_at=? WHERE id=?').run(this.now(), op.id);
      this.audit(userId, 'operation.cancel_requested', op.id);
      return this.operation(userId, op.id);
    });
  }
  reconciliations(userId: string, id: string) {
    this.operation(userId, id);
    return this.db.prepare('SELECT id,actor,evidence_json,at FROM operation_reconciliations WHERE operation_id=? ORDER BY at,id').all(id).map(row => ({ ...row, evidence: JSON.parse(row.evidence_json as string), evidence_json: undefined }));
  }
  reconcile(userId: string, id: string, input: Reconciliation) {
    return this.transaction(() => {
      const op = this.operation(userId, id);
      requireCondition(op.dispatch_id === input.dispatchId && op.payload_hash === input.payloadHash, 409, 'operation_binding_mismatch', '对账须对应原操作');
      requireCondition(!this.finalizations.isFinalizer(op),409,'agent_finalizer_outbox_required','只读结算仅由准确原 Node 终态事件提交，通用对账不能替代原回执');
      const inputDigest = digest({ operationId: id, ...input });
      const previous = this.db.prepare('SELECT digest FROM operation_reconciliations WHERE id=?').get(input.reconciliationId) as { digest: string } | undefined;
      if (previous) {
        requireCondition(previous.digest === inputDigest, 409, 'reconciliation_conflict', '原对账内容已变更');
        return op;
      }
      requireCondition(op.execution === 'unknown' || (op.delivery === 'uncertain' && !finalStates.has(op.execution)), 409, 'reconciliation_not_required', '仅对原结果未知的操作进行对账');
      const execution = input.decision === 'not_executed' ? 'cancelled' : input.decision;
      if(this.executions.isAgent(op)&&input.decision==='not_executed'){const root=this.executions.root(op);requireCondition(this.agents.list(root).length===0&&!this.models.hasCalls(root)&&!this.executions.resolve(userId,op.id).task.requires_reconciliation,409,'agent_effects_present','原委托已有子操作、模型请求或未核对恢复，不能声明未执行');}
      this.agents.settle(op,execution,input.result);
      this.db.prepare('INSERT INTO operation_reconciliations VALUES(?,?,?,?,?,?)').run(input.reconciliationId, id, inputDigest, userId, JSON.stringify(input), this.now());
      this.db.prepare("UPDATE operations SET delivery='acknowledged',execution=?,result_json=?,updated_at=? WHERE id=?").run(execution, JSON.stringify({ reconciled: true, reconciliationId: input.reconciliationId, result: input.result }), this.now(), id);
      this.audit(userId, 'operation.reconciled', id);
      return this.operation(userId, id);
    });
  }
  record(node: NodeRow, event: OperationEvent) {
    return this.transaction(() => {
      const op = this.db.prepare('SELECT * FROM operations WHERE id=? AND node_id=? AND epoch=?').get(event.operationId, node.id, node.epoch) as unknown as OperationRow | undefined;
      requireCondition(op && op.dispatch_id === event.dispatchId && op.payload_hash === event.payloadHash, 409, 'operation_binding_mismatch', '回执与原操作不匹配');
      const eventDigest = digest(event);
      const previous = this.db.prepare('SELECT * FROM operation_events WHERE operation_id=? AND event_id=?').get(op.id, event.eventId) as unknown as EventRow | undefined;
      if (previous) {
        requireCondition(previous.digest === eventDigest, 409, 'event_id_conflict', '同一事件 ID 内容发生变化');
        return { accepted: true, duplicate: true, sequence: previous.sequence };
      }
      requireCondition(event.sequence === op.last_sequence + 1, 409, 'event_sequence_conflict', '请按顺序补传原始回执');
      const reconciled = !!this.db.prepare('SELECT 1 FROM operation_reconciliations WHERE operation_id=? LIMIT 1').get(op.id);
      const original = reconciled ? this.db.prepare("SELECT kind FROM operation_events WHERE operation_id=? AND kind<>'output' ORDER BY sequence DESC LIMIT 1").get(op.id)?.kind as ExecutionState | undefined : op.execution;
      const observed = original ?? 'not_observed';
      requireCondition(!finalStates.has(observed), 409, 'operation_already_settled', '原节点已有终态回执');
      if (event.kind === 'received') requireCondition(observed === 'not_observed', 409, 'invalid_transition', '不能重复进入已接收状态');
      if (event.kind === 'running') requireCondition(observed === 'received', 409, 'invalid_transition', '运行前须保存接收回执');
      if (event.kind === 'output' || event.kind === 'succeeded') requireCondition(observed === 'running', 409, 'invalid_transition', '输出或成功须关联已运行操作');
      const execution = event.kind === 'output' ? observed : event.kind;
      if(event.kind==='succeeded')this.agents.settle(op,event.kind,event.data,reconciled);
      if(event.kind!=='output'&&finalStates.has(event.kind))this.closures.finish(op,event.kind,event.data,event.eventId,reconciled);
      if(!reconciled&&event.kind!=='output'&&finalStates.has(event.kind))this.resumes.finish(op,event.kind,event.data,event.eventId);
      if(!reconciled&&event.kind!=='output'&&finalStates.has(event.kind))this.finalizations.finish(op,event.kind,event.data,event.eventId);
      validateArtifactEvent(this.db, op.id, event.kind, event.data);
      const result = finalStates.has(execution) ? JSON.stringify(event.data) : op.result_json;
      this.db.prepare('INSERT INTO operation_events VALUES(?,?,?,?,?,?,?)').run(op.id, event.eventId, eventDigest, event.sequence, event.kind, JSON.stringify(event.data), this.now());
      if (reconciled) {
        // Preserve late original evidence without replacing the independently
        // attributed reconciliation or allowing the original action to replay.
        this.db.prepare('UPDATE operations SET last_sequence=?,updated_at=? WHERE id=?').run(event.sequence, this.now(), op.id);
      } else this.db.prepare("UPDATE operations SET delivery='acknowledged',execution=?,last_sequence=?,result_json=?,updated_at=? WHERE id=?").run(execution, event.sequence, result, this.now(), op.id);
      return { accepted: true, duplicate: false, sequence: event.sequence, reconciled };
    });
  }
}
