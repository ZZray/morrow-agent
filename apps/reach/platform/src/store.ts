// Copyright (c) Ray Zhang. Desk owns conversations, never Reach identities or devices.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { requireCondition } from '../../src/service/errors.ts';
import type { DeviceTarget } from '../../src/contracts/device-target.ts';

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type Status = 'starting' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export interface Turn {
  id: string; user_id: string; conversation_id: string; content: string; request_hash: string;
  task_id: string; run_id: string; session_hash: string; status: Status; output: string;
  cancel_requested: number; reason: string | null; result_json: string | null; created_at: number;
  close_intent_json: string | null; close_revision: number | null; close_attempts: number; close_result_json: string | null;
  target_json: string|null;
}
export interface DeviceCall {turn_id:string;call_key:string;call_id:string;run_id:string;tool:string;intent_json:string;operation_id:string|null;receipt_json:string|null;status:string}
export interface SettlementState { blocked: number; blocker_task_id: string | null; settlement_revision: number; declaration_sha: string | null }
export interface Conversation extends SettlementState { id: string; user_id: string; title: string; route_hash: string; created_at: number }
export interface Workspace { id: string; user_id: string; name: string; node_id: string | null; cwd: string; created_at: number; updated_at: number }
export interface ListedConversation extends Conversation { workspace_id: string | null; pinned: number; pinned_at: number | null }
export interface CloseIntent { declarationPath: string; declarationSha256: string; binaryPath: string; binarySha256: string; terminalStatus?:'completed' }
export interface SettlementToken { taskId: string; revision: number; declarationSha256: string }
export interface TurnContinuation {
  turn_id: string;
  source_turn_id: string;
  native_task_id: string;
  run_number: number;
  max_runs: number;
  deadline_unix_ms: number;
  previous_evidence_dir: string;
  expected_released_sha256: string;
  feedback: string;
  created_at: number;
}
export interface TurnGuidance {
  turn_id: string;
  message_id: string;
  text: string;
  text_sha256: string;
  status: 'queued' | 'applied' | 'unapplied' | 'unknown';
  receipt_json: string | null;
  created_at: number;
  updated_at: number;
}
export const settlementState = (conversation: Conversation): SettlementState => ({blocked:conversation.blocked,blocker_task_id:conversation.blocker_task_id,settlement_revision:conversation.settlement_revision,declaration_sha:conversation.declaration_sha});
export class DeskStore {
  readonly db: DatabaseSync;
  readonly owner = randomUUID();
  private transactionDepth=0;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true }); this.db = new DatabaseSync(file);
    const version = (this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
    if (version > 3) { this.db.close(); throw Error('Newer Reach Desk database'); }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL,route_hash TEXT NOT NULL,blocked INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(id),content TEXT NOT NULL,request_hash TEXT NOT NULL,task_id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL UNIQUE,session_hash TEXT NOT NULL,status TEXT NOT NULL,output TEXT NOT NULL DEFAULT '',cancel_requested INTEGER NOT NULL DEFAULT 0,reason TEXT,result_json TEXT,created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_live_turn ON turns(conversation_id) WHERE status IN ('starting','running','cancelling');
      -- 用户在对话列表里删除的对话：只从列表隐藏，消息、事件与证据原样保留。独立表、不升 user_version，旧版本回滚时忽略它即可。
      CREATE TABLE IF NOT EXISTS conversation_hidden(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),hidden_at INTEGER NOT NULL);
      -- 每条消息发送时所选技能的快照（名称、说明、内容），供任务目标与回放使用；同为独立表，不升 user_version。
      CREATE TABLE IF NOT EXISTS turn_skills(turn_id TEXT PRIMARY KEY REFERENCES turns(id),skills_json TEXT NOT NULL);
      -- 每条消息引用的附件元数据快照（含已抽取文本）；独立表，不升 user_version。
      CREATE TABLE IF NOT EXISTS turn_attachments(turn_id TEXT PRIMARY KEY REFERENCES turns(id),attachments_json TEXT NOT NULL);
      -- 工作区与对话置顶/归属元数据：独立表、不升 user_version，旧版本回滚时忽略即可。
      CREATE TABLE IF NOT EXISTS desk_workspaces(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,node_id TEXT,cwd TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_meta(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),workspace_id TEXT REFERENCES desk_workspaces(id) ON DELETE SET NULL,pinned INTEGER NOT NULL DEFAULT 0,pinned_at INTEGER);
      CREATE TABLE IF NOT EXISTS events(turn_id TEXT NOT NULL REFERENCES turns(id),seq INTEGER NOT NULL,kind TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(turn_id,seq));
      CREATE TABLE IF NOT EXISTS turn_task_meta(turn_id TEXT PRIMARY KEY REFERENCES turns(id),native_task_id TEXT NOT NULL,run_number INTEGER NOT NULL,max_runs INTEGER NOT NULL,deadline_unix_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS turn_continuations(turn_id TEXT PRIMARY KEY REFERENCES turns(id),source_turn_id TEXT NOT NULL REFERENCES turns(id),native_task_id TEXT NOT NULL,run_number INTEGER NOT NULL,max_runs INTEGER NOT NULL,deadline_unix_ms INTEGER NOT NULL,previous_evidence_dir TEXT NOT NULL,expected_released_sha256 TEXT NOT NULL,feedback TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS turn_guidance(turn_id TEXT NOT NULL REFERENCES turns(id),message_id TEXT NOT NULL,text TEXT NOT NULL,text_sha256 TEXT NOT NULL,status TEXT NOT NULL,receipt_json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(turn_id,message_id));`);
    try {
      this.transaction(() => {
        const lease = this.db.prepare('SELECT * FROM lease').get() as {pid:number}|undefined;
        let alive = false;
        if (lease) { try { process.kill(lease.pid, 0); alive = true; } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }
        requireCondition(!alive, 503, 'desk_already_running', '该 Reach Desk 状态目录正在使用');
        this.db.prepare('INSERT INTO lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,pid=excluded.pid').run(this.owner, process.pid);
        if(version<2)this.db.exec(`
          ALTER TABLE conversations ADD COLUMN blocker_task_id TEXT;
          ALTER TABLE conversations ADD COLUMN settlement_revision INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE conversations ADD COLUMN declaration_sha TEXT;
          ALTER TABLE turns ADD COLUMN close_intent_json TEXT;
          ALTER TABLE turns ADD COLUMN close_revision INTEGER;
          ALTER TABLE turns ADD COLUMN close_attempts INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE turns ADD COLUMN close_result_json TEXT;
          UPDATE conversations SET settlement_revision=1 WHERE blocked=1;
          PRAGMA user_version=2;`);
        if(version<3)this.db.exec(`ALTER TABLE turns ADD COLUMN target_json TEXT;
          CREATE TABLE device_calls(turn_id TEXT NOT NULL REFERENCES turns(id),call_key TEXT NOT NULL,call_id TEXT NOT NULL,run_id TEXT NOT NULL,tool TEXT NOT NULL,intent_json TEXT NOT NULL,operation_id TEXT,receipt_json TEXT,status TEXT NOT NULL DEFAULT 'intent',PRIMARY KEY(turn_id,call_key));
          PRAGMA user_version=3;`);
        const interrupted = this.db.prepare("SELECT * FROM turns WHERE status IN ('starting','running','cancelling')").all() as unknown as Turn[];
        for (const turn of interrupted) {
          const conversation=this.conversation(turn.user_id,turn.conversation_id);
          if(turn.status==='cancelling'&&turn.close_intent_json&&this.matches(conversation,turn,this.token(turn)))continue;
          this.db.prepare("UPDATE turn_guidance SET status='unknown',updated_at=? WHERE turn_id=? AND status='queued'").run(Date.now(), turn.id);
          this.finish(turn.id, 'unknown', turn.output, 'host_interrupted', turn.result_json?JSON.parse(turn.result_json):null, true);
        }
      });
    } catch(error) { this.db.close(); throw error; }
  }
  transaction<T>(f:()=>T):T {
    const depth=this.transactionDepth++,savepoint=`desk_${depth}`;
    try{this.db.exec(depth?`SAVEPOINT ${savepoint}`:'BEGIN IMMEDIATE');try{const result=f();this.db.exec(depth?`RELEASE ${savepoint}`:'COMMIT');return result;}catch(error){this.db.exec(depth?`ROLLBACK TO ${savepoint}`:'ROLLBACK');if(depth)this.db.exec(`RELEASE ${savepoint}`);throw error;}}
    finally{this.transactionDepth--;}
  }
  conversation(userId:string,id:string):Conversation {
    const row=this.db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(id,userId) as unknown as Conversation|undefined;
    requireCondition(row,404,'desk_conversation_missing','对话不存在');return row;
  }
  workspace(userId:string,id:string):Workspace {
    const row=this.db.prepare('SELECT * FROM desk_workspaces WHERE id=? AND user_id=?').get(id,userId) as unknown as Workspace|undefined;
    requireCondition(row,404,'desk_workspace_missing','工作区不存在');return row;
  }
  workspaces(userId:string):Workspace[] {
    return this.transaction(()=>{
      const rows=this.db.prepare('SELECT * FROM desk_workspaces WHERE user_id=? ORDER BY created_at ASC, id ASC').all(userId) as unknown as Workspace[];
      if(rows.length)return rows;
      const now=Date.now(),id=randomUUID();
      this.db.prepare('INSERT INTO desk_workspaces(id,user_id,name,node_id,cwd,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,userId,'默认工作区',null,'',now,now);
      return [this.workspace(userId,id)];
    });
  }
  createWorkspace(userId:string,id:string,name:string,nodeId:string|null=null,cwd=''):Workspace {
    return this.transaction(()=>{
      const existing=this.db.prepare('SELECT * FROM desk_workspaces WHERE id=?').get(id) as unknown as Workspace|undefined;
      if(existing){requireCondition(existing.user_id===userId,404,'desk_workspace_missing','工作区不存在');return existing;}
      const now=Date.now();
      this.db.prepare('INSERT INTO desk_workspaces(id,user_id,name,node_id,cwd,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,userId,name,nodeId,cwd,now,now);
      return this.workspace(userId,id);
    });
  }
  updateWorkspace(userId:string,id:string,patch:{name?:string;nodeId?:string|null;cwd?:string}):Workspace {
    return this.transaction(()=>{
      const current=this.workspace(userId,id);
      const nextName=patch.name??current.name;
      const nextNodeId=patch.nodeId!==undefined?patch.nodeId:current.node_id;
      const nextCwd=patch.cwd!==undefined?patch.cwd:current.cwd;
      this.db.prepare('UPDATE desk_workspaces SET name=?,node_id=?,cwd=?,updated_at=? WHERE id=? AND user_id=?').run(nextName,nextNodeId,nextCwd,Date.now(),id,userId);
      return this.workspace(userId,id);
    });
  }
  deleteWorkspace(userId:string,id:string) {
    this.transaction(()=>{
      this.workspace(userId,id);
      const owned=this.db.prepare('SELECT c.* FROM conversations c JOIN conversation_meta m ON m.conversation_id=c.id WHERE c.user_id=? AND m.workspace_id=? AND c.id NOT IN (SELECT conversation_id FROM conversation_hidden)').all(userId,id) as unknown as Conversation[];
      const now=Date.now();
      for(const conv of owned){
        const live=this.db.prepare("SELECT 1 FROM turns WHERE conversation_id=? AND status IN ('submitting','starting','running','cancelling') LIMIT 1").get(conv.id);
        requireCondition(!live,409,'desk_conversation_busy','该工作区有回答正在进行，停止或等结束后再删除');
        requireCondition(!conv.blocked,409,'desk_conversation_unsettled','该工作区有对话仍在核对结果，核对完成后再删除');
      }
      for(const conv of owned)this.db.prepare('INSERT INTO conversation_hidden(conversation_id,hidden_at) VALUES(?,?) ON CONFLICT(conversation_id) DO NOTHING').run(conv.id,now);
      this.db.prepare('DELETE FROM desk_workspaces WHERE id=? AND user_id=?').run(id,userId);
    });
  }
  create(userId:string,id:string,title:string,routeHash:string,workspaceId?:string|null) {
    return this.transaction(()=>{
      if(workspaceId)this.workspace(userId,workspaceId);
      const existing=this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as unknown as Conversation|undefined;
      if(existing){requireCondition(existing.user_id===userId,404,'desk_conversation_missing','对话不存在');return existing;}
      this.db.prepare('INSERT INTO conversations(id,user_id,title,route_hash,created_at) VALUES(?,?,?,?,?)').run(id,userId,title,routeHash,Date.now());
      if(workspaceId)this.db.prepare('INSERT INTO conversation_meta(conversation_id,workspace_id,pinned,pinned_at) VALUES(?,?,0,NULL) ON CONFLICT(conversation_id) DO UPDATE SET workspace_id=COALESCE(conversation_meta.workspace_id,excluded.workspace_id)').run(id,workspaceId);
      return this.conversation(userId,id);
    });
  }
  conversations(userId:string):ListedConversation[] {
    return this.db.prepare(`SELECT c.*, m.workspace_id AS workspace_id, COALESCE(m.pinned,0) AS pinned, m.pinned_at AS pinned_at
      FROM conversations c LEFT JOIN conversation_meta m ON m.conversation_id=c.id
      WHERE c.user_id=? AND c.id NOT IN (SELECT conversation_id FROM conversation_hidden)
      ORDER BY COALESCE(m.pinned,0) DESC, COALESCE(m.pinned_at,0) DESC, c.created_at DESC LIMIT 200`).all(userId) as unknown as ListedConversation[];
  }
  // 改名只改显示标题，不影响任务、路由与证据。
  rename(userId:string,id:string,title:string) {
    return this.transaction(()=>{this.conversation(userId,id);this.db.prepare('UPDATE conversations SET title=? WHERE id=? AND user_id=?').run(title,id,userId);return this.conversation(userId,id);});
  }
  updateConversationMeta(userId:string,id:string,patch:{title?:string;pinned?:boolean;workspaceId?:string|null}):ListedConversation {
    return this.transaction(()=>{
      this.conversation(userId,id);
      if(patch.title!==undefined)this.db.prepare('UPDATE conversations SET title=? WHERE id=? AND user_id=?').run(patch.title,id,userId);
      if(patch.workspaceId!==undefined&&patch.workspaceId!==null)this.workspace(userId,patch.workspaceId);
      const existing=this.db.prepare('SELECT workspace_id,pinned,pinned_at FROM conversation_meta WHERE conversation_id=?').get(id) as {workspace_id:string|null;pinned:number;pinned_at:number|null}|undefined;
      const nextWorkspaceId=patch.workspaceId!==undefined?patch.workspaceId:(existing?.workspace_id??null);
      const nextPinned=patch.pinned!==undefined?(patch.pinned?1:0):(existing?.pinned??0);
      const nextPinnedAt=patch.pinned===true?(existing?.pinned&&existing.pinned_at?existing.pinned_at:Date.now()):patch.pinned===false?null:(existing?.pinned_at??null);
      this.db.prepare('INSERT INTO conversation_meta(conversation_id,workspace_id,pinned,pinned_at) VALUES(?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET workspace_id=excluded.workspace_id,pinned=excluded.pinned,pinned_at=excluded.pinned_at').run(id,nextWorkspaceId,nextPinned,nextPinnedAt);
      return {...this.conversation(userId,id),workspace_id:nextWorkspaceId,pinned:nextPinned,pinned_at:nextPinnedAt};
    });
  }
  // 删除＝从列表隐藏。回答进行中或上一次结果仍在核对时拒绝，避免把未结束的任务藏起来。
  hide(userId:string,id:string) {
    this.transaction(()=>{
      const conversation=this.conversation(userId,id);
      const live=this.db.prepare("SELECT 1 FROM turns WHERE conversation_id=? AND status IN ('submitting','starting','running','cancelling') LIMIT 1").get(id);
      requireCondition(!live,409,'desk_conversation_busy','回答还在进行，停止或等它结束后再删除');
      requireCondition(!conversation.blocked,409,'desk_conversation_unsettled','这段对话还在核对上一次的结果，核对完成后再删除');
      this.db.prepare('INSERT INTO conversation_hidden(conversation_id,hidden_at) VALUES(?,?) ON CONFLICT(conversation_id) DO NOTHING').run(id,Date.now());
    });
  }
  turn(userId:string,id:string):Turn {const row=this.db.prepare('SELECT * FROM turns WHERE id=? AND user_id=?').get(id,userId) as unknown as Turn|undefined;requireCondition(row,404,'desk_turn_missing','消息不存在');return row;}
  turns(userId:string,id:string) {this.conversation(userId,id);return this.db.prepare('SELECT * FROM turns WHERE conversation_id=? ORDER BY created_at,id').all(id) as unknown as Turn[];}
  admit(userId:string,conversationId:string,id:string,content:string,sessionHash:string,routeHash:string,target:(DeviceTarget&{name:string;platform:string})|null=null,maxRuns=1) {
    return this.transaction(()=>{
      const conversation=this.conversation(userId,conversationId),requestHash=digest({conversationId,content,...(target?{target:{nodeId:target.nodeId,epoch:target.epoch,cwd:target.cwd}}:{}),...(maxRuns!==1?{maxRuns}:{})});
      const previous=this.db.prepare('SELECT * FROM turns WHERE id=?').get(id) as unknown as Turn|undefined;
      if(previous){requireCondition(previous.user_id===userId,404,'desk_turn_missing','消息不存在');requireCondition(previous.request_hash===requestHash,409,'desk_message_conflict','同一消息 ID 的内容发生变化');return {turn:previous,fresh:false};}
      requireCondition(!conversation.blocked,409,'desk_session_unsettled','原会话尚未结算，请先核对原任务');
      requireCondition(conversation.route_hash===routeHash,409,'desk_route_changed','该对话的模型配置已变化，请保留原记录并新建对话');
      requireCondition(!this.db.prepare("SELECT 1 FROM turns WHERE conversation_id=? AND status IN ('starting','running','cancelling')").get(conversationId),409,'desk_conversation_busy','上一条消息仍在处理');
      this.db.prepare('INSERT INTO turns(id,user_id,conversation_id,content,request_hash,task_id,run_id,session_hash,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,userId,conversationId,content,requestHash,randomUUID(),randomUUID(),sessionHash,'starting',Date.now());
      if(target)this.db.prepare('UPDATE turns SET target_json=? WHERE id=?').run(JSON.stringify(target),id);
      this.event(id,'admitted',{id,status:'starting',target});return {turn:this.turn(userId,id),fresh:true};
    });
  }
  recordTaskMeta(turnId: string, nativeTaskId: string, runNumber: number, maxRuns: number, deadlineUnixMs: number) {
    this.db.prepare('INSERT OR REPLACE INTO turn_task_meta VALUES(?,?,?,?,?)').run(turnId, nativeTaskId, runNumber, maxRuns, deadlineUnixMs);
  }
  taskMeta(turnId: string): { native_task_id: string; run_number: number; max_runs: number; deadline_unix_ms: number } | undefined {
    return this.db.prepare('SELECT native_task_id,run_number,max_runs,deadline_unix_ms FROM turn_task_meta WHERE turn_id=?').get(turnId) as { native_task_id: string; run_number: number; max_runs: number; deadline_unix_ms: number } | undefined;
  }
  continuation(turnId: string): TurnContinuation | undefined {
    return this.db.prepare('SELECT * FROM turn_continuations WHERE turn_id=?').get(turnId) as unknown as TurnContinuation | undefined;
  }
  admitContinuation(userId: string, id: string, sourceTurnId: string, expectedReleasedSha256: string, feedback: string, previousEvidenceDir: string, sessionHash: string, routeHash: string) {
    return this.transaction(() => {
      const source = this.turn(userId, sourceTurnId);
      const conversation = this.conversation(userId, source.conversation_id);
      const requestHash = digest({ sourceTurnId, expectedReleasedSha256, feedback });
      const previous = this.db.prepare('SELECT * FROM turns WHERE id=?').get(id) as unknown as Turn | undefined;
      if (previous) {
        requireCondition(previous.user_id === userId, 404, 'desk_turn_missing', '消息不存在');
        requireCondition(previous.request_hash === requestHash, 409, 'desk_message_conflict', '同一续作消息 ID 的内容发生变化');
        return { turn: previous, fresh: false };
      }
      requireCondition(!conversation.blocked, 409, 'desk_session_unsettled', '原会话尚未结算，请先核对原任务');
      requireCondition(conversation.route_hash === routeHash, 409, 'desk_route_changed', '该对话的模型配置已变化，请保留原记录并新建对话');
      requireCondition(!this.db.prepare("SELECT 1 FROM turns WHERE conversation_id=? AND status IN ('starting','running','cancelling')").get(conversation.id), 409, 'desk_conversation_busy', '上一条消息仍在处理');
      requireCondition(source.status === 'completed', 409, 'desk_continue_not_settled', '仅可对已完成释放的消息发起已审核续作');
      requireCondition(!this.db.prepare('SELECT 1 FROM turn_continuations WHERE source_turn_id=?').get(source.id), 409, 'desk_continue_claimed', '该原释放结果已被后续续作认领');
      const meta = this.taskMeta(source.id);
      requireCondition(meta && meta.run_number < meta.max_runs, 409, 'desk_continue_budget', '原任务没有剩余可续作的 Run 额度');
      requireCondition(Date.now() < meta!.deadline_unix_ms, 409, 'desk_continue_deadline', '原任务截止时间已过');
      const now = Date.now(), nextRunNumber = meta!.run_number + 1;
      this.db.prepare('INSERT INTO turns(id,user_id,conversation_id,content,request_hash,task_id,run_id,session_hash,status,target_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, userId, conversation.id, source.content, requestHash, randomUUID(), randomUUID(), sessionHash, 'starting', source.target_json, now);
      this.db.prepare('INSERT INTO turn_continuations VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, source.id, meta!.native_task_id, nextRunNumber, meta!.max_runs, meta!.deadline_unix_ms, previousEvidenceDir, expectedReleasedSha256, feedback, now);
      this.recordTaskMeta(id, meta!.native_task_id, nextRunNumber, meta!.max_runs, meta!.deadline_unix_ms);
      this.event(id, 'admitted', { id, status: 'starting', continuedFrom: source.id, runNumber: nextRunNumber });
      return { turn: this.turn(userId, id), fresh: true };
    });
  }
  addGuidance(userId: string, turnId: string, messageId: string, text: string) {
    return this.transaction(() => {
      const turn = this.turn(userId, turnId);
      const textSha256 = createHash('sha256').update(text).digest('hex');
      const existing = this.db.prepare('SELECT * FROM turn_guidance WHERE turn_id=? AND message_id=?').get(turn.id, messageId) as unknown as TurnGuidance | undefined;
      if (existing) {
        requireCondition(existing.text_sha256 === textSha256, 409, 'desk_guidance_conflict', '同一引导消息 ID 的正文不一致');
        return { record: existing, duplicate: true };
      }
      requireCondition(['starting', 'running'].includes(turn.status) && !turn.cancel_requested, 409, 'desk_turn_not_running', '仅可向运行中的原任务发送补充引导');
      const count = (this.db.prepare('SELECT count(*) AS n FROM turn_guidance WHERE turn_id=?').get(turn.id) as { n: number }).n;
      requireCondition(count < 16, 409, 'desk_guidance_capacity', '单条消息的补充引导数量已达上限');
      const now = Date.now();
      this.db.prepare('INSERT INTO turn_guidance VALUES(?,?,?,?,?,?,?,?)').run(turn.id, messageId, text, textSha256, 'queued', null, now, now);
      const record = this.db.prepare('SELECT * FROM turn_guidance WHERE turn_id=? AND message_id=?').get(turn.id, messageId) as unknown as TurnGuidance;
      this.event(turn.id, 'guidance', { messageId, text, status: 'queued' });
      return { record, duplicate: false };
    });
  }
  ackGuidance(turnId: string, messageId: string, status: 'queued' | 'applied' | 'unapplied' | 'unknown', receipt?: unknown) {
    const now = Date.now();
    if (status === 'queued') {
      this.db.prepare("UPDATE turn_guidance SET updated_at=? WHERE turn_id=? AND message_id=? AND status='queued'").run(now, turnId, messageId);
      return;
    }
    const updated = this.db.prepare("UPDATE turn_guidance SET status=?,receipt_json=COALESCE(receipt_json,?),updated_at=? WHERE turn_id=? AND message_id=? AND status='queued'")
      .run(status, receipt === undefined ? null : JSON.stringify(receipt), now, turnId, messageId);
    if (updated.changes > 0) this.event(turnId, 'guidance', { messageId, status });
  }
  finalizeGuidance(turnId: string, messages: { message_id: string; status: string }[] | null, interrupted: boolean) {
    this.transaction(() => {
      const now = Date.now();
      if (Array.isArray(messages)) {
        for (const item of messages) {
          if (['applied', 'unapplied', 'unknown'].includes(item.status)) {
            this.db.prepare("UPDATE turn_guidance SET status=?,receipt_json=?,updated_at=? WHERE turn_id=? AND message_id=? AND status='queued'")
              .run(item.status, JSON.stringify(item), now, turnId, item.message_id);
          }
        }
      }
      const fallback = interrupted ? 'unknown' : 'unapplied';
      this.db.prepare("UPDATE turn_guidance SET status=?,updated_at=? WHERE turn_id=? AND status='queued'").run(fallback, now, turnId);
    });
  }
  guidance(userId: string, turnId: string): TurnGuidance[] {
    const turn = this.turn(userId, turnId);
    if (!['starting', 'running', 'cancelling'].includes(turn.status)) {
      this.db.prepare("UPDATE turn_guidance SET status='unknown',updated_at=? WHERE turn_id=? AND status='queued'").run(Date.now(), turn.id);
    }
    return this.db.prepare('SELECT * FROM turn_guidance WHERE turn_id=? ORDER BY created_at,rowid').all(turn.id) as unknown as TurnGuidance[];
  }
  event(id:string,kind:string,data:unknown) {
    const seq=(this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM events WHERE turn_id=?').get(id) as {n:number}).n;
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(id,seq,kind,JSON.stringify(data));return seq;
  }
  events(userId:string,id:string,after:number) {this.turn(userId,id);return this.db.prepare('SELECT seq,kind,data_json FROM events WHERE turn_id=? AND seq>? ORDER BY seq LIMIT 100').all(id,after) as {seq:number;kind:string;data_json:string}[];}
  // 只在首次接收时写入；同一消息重试沿用第一次的快照。
  saveTurnSkills(turnId:string,skills:unknown[]){if(skills.length)this.db.prepare('INSERT INTO turn_skills(turn_id,skills_json) VALUES(?,?) ON CONFLICT(turn_id) DO NOTHING').run(turnId,JSON.stringify(skills));}
  saveTurnAttachments(turnId:string,items:unknown[]){if(items.length)this.db.prepare('INSERT INTO turn_attachments(turn_id,attachments_json) VALUES(?,?) ON CONFLICT(turn_id) DO NOTHING').run(turnId,JSON.stringify(items));}
  turnAttachments<T=unknown>(turnId:string):T[]{const row=this.db.prepare('SELECT attachments_json FROM turn_attachments WHERE turn_id=?').get(turnId) as {attachments_json:string}|undefined;return row?JSON.parse(row.attachments_json):[];}
  turnSkills<T=unknown>(turnId:string):T[]{const row=this.db.prepare('SELECT skills_json FROM turn_skills WHERE turn_id=?').get(turnId) as {skills_json:string}|undefined;return row?JSON.parse(row.skills_json):[];}
  // 该用户是否有进行中的回答（记忆写入前检查）。
  userBusy(userId:string){return !!this.db.prepare("SELECT 1 FROM turns WHERE user_id=? AND status IN ('submitting','starting','running','cancelling') LIMIT 1").get(userId);}
  stepEvents(id:string){return (this.db.prepare("SELECT kind,data_json FROM events WHERE turn_id=? AND kind IN ('tool_start','tool_end') ORDER BY seq").all(id) as {kind:string;data_json:string}[]).map(row=>({kind:row.kind,data:JSON.parse(row.data_json)}));}
  deviceCalls(turn:Turn){return this.db.prepare('SELECT * FROM device_calls WHERE turn_id=? ORDER BY rowid').all(turn.id) as unknown as DeviceCall[];}
  interruptedDeviceTurns(){return this.db.prepare("SELECT t.* FROM turns t JOIN conversations c ON c.id=t.conversation_id WHERE c.blocked=1 AND c.blocker_task_id=t.task_id AND t.target_json IS NOT NULL AND EXISTS(SELECT 1 FROM device_calls WHERE turn_id=t.id)").all() as unknown as Turn[];}
  beginDeviceCall(turn:Turn,call:{key:string;id:string;runId:string;tool:string;intent:unknown}){
    return this.transaction(()=>{const previous=this.deviceCalls(turn).find(row=>row.call_key===call.key),intent=JSON.stringify(call.intent);
      if(previous){requireCondition(previous.intent_json===intent&&previous.run_id===call.runId&&previous.tool===call.tool,409,'desk_tool_identity_conflict','原工具调用的内容已变化');return previous;}
      const current=this.turn(turn.user_id,turn.id);requireCondition(['running','cancelling'].includes(current.status),409,'desk_tool_stopped','原消息已停止');
      this.db.prepare('INSERT INTO device_calls(turn_id,call_key,call_id,run_id,tool,intent_json) VALUES(?,?,?,?,?,?)').run(turn.id,call.key,call.id,call.runId,call.tool,intent);
      return this.deviceCalls(turn).find(row=>row.call_key===call.key)!;
    });
  }
  bindDeviceOperation(turn:Turn,key:string,id:string){return this.transaction(()=>{const call=this.deviceCalls(turn).find(row=>row.call_key===key);requireCondition(call&&(!call.operation_id||call.operation_id===id),409,'desk_tool_operation_conflict','原工具操作绑定已变化');this.db.prepare("UPDATE device_calls SET operation_id=?,status=CASE WHEN receipt_json IS NULL THEN 'waiting' ELSE status END WHERE turn_id=? AND call_key=?").run(id,turn.id,key);});}
  finishDeviceCall(turn:Turn,key:string,receipt:unknown){const encoded=JSON.stringify(receipt);return this.transaction(()=>{const call=this.deviceCalls(turn).find(row=>row.call_key===key);requireCondition(call,409,'desk_tool_intent_missing','原工具调用依据不存在');requireCondition(!call.receipt_json||call.receipt_json===encoded,409,'desk_tool_receipt_conflict','原工具回执已固定');this.db.prepare('UPDATE device_calls SET receipt_json=?,status=? WHERE turn_id=? AND call_key=?').run(encoded,(receipt as any).reply?.settlement==='Settled'?'settled':'unknown',turn.id,key);});}
  cancel(userId:string,id:string,reason:string) {
    const turn=this.turn(userId,id);
    if(['starting','running','cancelling'].includes(turn.status)&&!turn.cancel_requested){this.db.prepare("UPDATE turns SET cancel_requested=1,status='cancelling',reason=? WHERE id=?").run(reason,id);this.event(id,'cancel_requested',{reason});}
  }
  running(id:string) {this.db.prepare("UPDATE turns SET status='running' WHERE id=? AND status='starting'").run(id);}
  finish(id:string,status:Status,output:string,reason:string|null,result:unknown,blocked:boolean) {
    return this.transaction(()=>{
      const turn=this.db.prepare('SELECT * FROM turns WHERE id=?').get(id) as unknown as Turn|undefined;
      requireCondition(turn,404,'desk_turn_missing','消息不存在');
      // Late completion of an old Task must never alter a newer conversation lock.
      if(!['starting','running','cancelling'].includes(turn.status))return false;
      requireCondition(!['starting','running','cancelling'].includes(status),500,'desk_terminal_required','消息尚未结束');
      const conversation=this.conversation(turn.user_id,turn.conversation_id);
      if(turn.close_intent_json&&this.matches(conversation,turn,this.token(turn)))throw Error('Use settlement completion for a closing Task');
      this.db.prepare('UPDATE turns SET status=?,output=?,reason=?,result_json=? WHERE id=?').run(status,output,reason,result===null?null:JSON.stringify(result),id);
      if(blocked&&!conversation.blocked)this.db.prepare('UPDATE conversations SET blocked=1,blocker_task_id=?,settlement_revision=settlement_revision+1,declaration_sha=NULL WHERE id=?').run(turn.task_id,turn.conversation_id);
      this.terminalEvent(this.turn(turn.user_id,id));return true;
    });
  }
  private terminalEvent(turn:Turn){const conversation=this.conversation(turn.user_id,turn.conversation_id);this.event(turn.id,'settled',{status:turn.status,output:turn.output,reason:turn.reason,sessionBlocked:!!conversation.blocked,conversation:settlementState(conversation),taskAccepted:false});}
  private token(turn:Turn):SettlementToken {
    const intent=JSON.parse(turn.close_intent_json!) as CloseIntent;
    return {taskId:turn.task_id,revision:turn.close_revision!,declarationSha256:intent.declarationSha256};
  }
  private matches(conversation:Conversation,turn:Turn,token:SettlementToken){return !!conversation.blocked&&conversation.blocker_task_id===turn.task_id&&token.taskId===turn.task_id&&conversation.settlement_revision===token.revision&&turn.close_revision===token.revision&&conversation.declaration_sha===token.declarationSha256;}
  beginSettlement(id:string,intent:CloseIntent,joined:{output:string;reason:string;result:unknown}):SettlementToken {
    requireCondition(isAbsolute(intent.declarationPath)&&isAbsolute(intent.binaryPath)&&/^[0-9a-f]{64}$/.test(intent.declarationSha256)&&/^[0-9a-f]{64}$/.test(intent.binarySha256),500,'desk_close_intent_invalid','原任务结算依据不完整');
    return this.transaction(()=>{
      const turn=this.db.prepare('SELECT * FROM turns WHERE id=?').get(id) as unknown as Turn|undefined;
      requireCondition(turn,404,'desk_turn_missing','消息不存在');
      if(turn.close_intent_json){requireCondition(digest(JSON.parse(turn.close_intent_json))===digest(intent),409,'desk_close_intent_conflict','原任务结算依据已固定');return this.token(turn);}
      const informational=intent.terminalStatus==='completed'&&!turn.cancel_requested&&turn.status==='running'&&(joined.result as any)?.outcome?.stop==='Informational';
      requireCondition(informational||(intent.terminalStatus===undefined&&turn.cancel_requested===1&&turn.status==='cancelling'),409,'desk_close_not_cancelled','原消息尚未停止');
      const conversation=this.conversation(turn.user_id,turn.conversation_id);
      requireCondition(!conversation.blocked||(conversation.blocker_task_id===turn.task_id&&!conversation.declaration_sha),409,'desk_close_blocker_conflict','原会话已有待核对任务');
      const revision=conversation.settlement_revision+1;
      this.db.prepare('UPDATE conversations SET blocked=1,blocker_task_id=?,settlement_revision=?,declaration_sha=? WHERE id=?').run(turn.task_id,revision,intent.declarationSha256,turn.conversation_id);
      this.db.prepare("UPDATE turns SET status='cancelling',close_intent_json=?,close_revision=?,output=?,reason=?,result_json=? WHERE id=?").run(JSON.stringify(intent),revision,joined.output,joined.reason,JSON.stringify(joined.result),id);
      this.event(id,'settlement_pending',{status:'cancelling',conversation:settlementState(this.conversation(turn.user_id,turn.conversation_id))});
      return {taskId:turn.task_id,revision,declarationSha256:intent.declarationSha256};
    });
  }
  pendingSettlements(){return this.db.prepare("SELECT * FROM turns WHERE status='cancelling' AND close_intent_json IS NOT NULL ORDER BY created_at,id").all() as unknown as Turn[];}
  settlementToken(turn:Turn){requireCondition(turn.close_intent_json&&turn.close_revision!==null,409,'desk_close_intent_missing','原任务结算依据不存在');return this.token(turn);}
  claimSettlement(id:string,token:SettlementToken,maxAttempts:number):number|null {
    requireCondition(Number.isSafeInteger(maxAttempts)&&maxAttempts>0&&maxAttempts<=10,500,'desk_close_attempts_invalid','结算重试次数无效');
    return this.transaction(()=>{
      const turn=this.db.prepare('SELECT * FROM turns WHERE id=?').get(id) as unknown as Turn|undefined;
      if(!turn||turn.status!=='cancelling'||!turn.close_intent_json||turn.close_attempts>=maxAttempts||!this.matches(this.conversation(turn.user_id,turn.conversation_id),turn,token))return null;
      this.db.prepare('UPDATE turns SET close_attempts=close_attempts+1 WHERE id=?').run(id);return turn.close_attempts+1;
    });
  }
  completeSettlement(id:string,token:SettlementToken,result:unknown):boolean {
    return this.transaction(()=>{
      const turn=this.db.prepare('SELECT * FROM turns WHERE id=?').get(id) as unknown as Turn|undefined;
      if(!turn||turn.status!=='cancelling'||!turn.close_intent_json||!turn.close_attempts||!this.matches(this.conversation(turn.user_id,turn.conversation_id),turn,token))return false;
      this.db.prepare('UPDATE conversations SET blocked=0,blocker_task_id=NULL,declaration_sha=NULL,settlement_revision=settlement_revision+1 WHERE id=?').run(turn.conversation_id);
      const status=JSON.parse(turn.close_intent_json).terminalStatus==='completed'?'completed':'cancelled';
      this.db.prepare('UPDATE turns SET status=?,reason=?,close_result_json=? WHERE id=?').run(status,status==='completed'?null:turn.reason,JSON.stringify(result),id);
      this.terminalEvent(this.turn(turn.user_id,id));return true;
    });
  }
  failSettlement(id:string,token:SettlementToken,result:unknown):boolean {
    return this.transaction(()=>{
      const turn=this.db.prepare('SELECT * FROM turns WHERE id=?').get(id) as unknown as Turn|undefined;
      if(!turn||turn.status!=='cancelling'||!turn.close_intent_json||!this.matches(this.conversation(turn.user_id,turn.conversation_id),turn,token))return false;
      const status=JSON.parse(turn.close_intent_json).terminalStatus==='completed'?'unknown':'cancelled';
      this.db.prepare('UPDATE turns SET status=?,close_result_json=? WHERE id=?').run(status,JSON.stringify(result),id);
      this.terminalEvent(this.turn(turn.user_id,id));return true;
    });
  }
  close() {this.db.prepare('DELETE FROM lease WHERE owner=?').run(this.owner);this.db.close();}
}
