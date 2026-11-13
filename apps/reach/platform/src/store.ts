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
export interface CloseIntent { declarationPath: string; declarationSha256: string; binaryPath: string; binarySha256: string; terminalStatus?:'completed' }
export interface SettlementToken { taskId: string; revision: number; declarationSha256: string }
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
      CREATE TABLE IF NOT EXISTS events(turn_id TEXT NOT NULL REFERENCES turns(id),seq INTEGER NOT NULL,kind TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(turn_id,seq));`);
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
  create(userId:string,id:string,title:string,routeHash:string) {
    return this.transaction(()=>{
      const existing=this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as unknown as Conversation|undefined;
      if(existing){requireCondition(existing.user_id===userId,404,'desk_conversation_missing','对话不存在');return existing;}
      this.db.prepare('INSERT INTO conversations(id,user_id,title,route_hash,created_at) VALUES(?,?,?,?,?)').run(id,userId,title,routeHash,Date.now());
      return this.conversation(userId,id);
    });
  }
  conversations(userId:string) {return this.db.prepare('SELECT * FROM conversations WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(userId);}
  turn(userId:string,id:string):Turn {const row=this.db.prepare('SELECT * FROM turns WHERE id=? AND user_id=?').get(id,userId) as unknown as Turn|undefined;requireCondition(row,404,'desk_turn_missing','消息不存在');return row;}
  turns(userId:string,id:string) {this.conversation(userId,id);return this.db.prepare('SELECT * FROM turns WHERE conversation_id=? ORDER BY created_at,id').all(id) as unknown as Turn[];}
  admit(userId:string,conversationId:string,id:string,content:string,sessionHash:string,routeHash:string,target:(DeviceTarget&{name:string;platform:string})|null=null) {
    return this.transaction(()=>{
      const conversation=this.conversation(userId,conversationId),requestHash=digest({conversationId,content,...(target?{target:{nodeId:target.nodeId,epoch:target.epoch,cwd:target.cwd}}:{})});
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
  event(id:string,kind:string,data:unknown) {
    const seq=(this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM events WHERE turn_id=?').get(id) as {n:number}).n;
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(id,seq,kind,JSON.stringify(data));return seq;
  }
  events(userId:string,id:string,after:number) {this.turn(userId,id);return this.db.prepare('SELECT seq,kind,data_json FROM events WHERE turn_id=? AND seq>? ORDER BY seq LIMIT 100').all(id,after) as {seq:number;kind:string;data_json:string}[];}
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
