// Copyright (c) Ray Zhang. Host-owned cross-Task sources; Core Session memories remain separate.
import {randomUUID} from 'node:crypto';
import {delegateSchema,sourceSchema} from '../contracts/protocol.ts';
import {libraryListSchema,libraryProposalSchema,librarySourceSchema,libraryValidationSchema,libraryReviewSchema} from '../contracts/source-library.ts';
import {digest,sha256} from './store.ts';
import {requireCondition} from './errors.ts';
import type {ReachStore,NodeRow,OperationRow} from './store.ts';
type Entry={id:string;user_id:string;request_id:string;request_sha256:string;node_id:string;epoch:number;source_task_id:string;version_sha256:string;version_json:string;state:'candidate'|'adopted'|'revoked';created_at:number};
type Delegate=ReturnType<typeof delegateSchema.parse>;
export class SourceLibrary{
  readonly store:ReachStore;
  constructor(store:ReachStore){this.store=store;}
  migrate(){
    for(const name of ['source_library','source_library_validations','source_library_reviews','source_library_uses','agent_native_closures'])requireCondition(!this.store.db.prepare('PRAGMA foreign_key_check('+name+')').get(),409,'library_migration','资料库原关系不完整，拒绝补造验证或采用');
    for(const marker of this.store.db.prepare('SELECT * FROM agent_native_closures').all()){
      const event=this.store.db.prepare('SELECT kind,data_json FROM operation_events WHERE operation_id=? AND event_id=?').get(marker.operation_id,marker.event_id),data=event?JSON.parse(String(event.data_json)):null;
      requireCondition(event&&['succeeded','failed'].includes(String(event.kind))&&data?.nativeClosure&&digest(data.nativeClosure)===marker.proof_sha256&&data.taskId===marker.operation_id&&data.taskAccepted===false,409,'library_migration','原完结证明与服务校验标记不符');
    }
    for(const raw of this.store.db.prepare('SELECT id,user_id FROM source_library').all()){
      const {row,version}=this.entry(String(raw.user_id),String(raw.id)),last=this.store.db.prepare('SELECT * FROM source_library_reviews WHERE entry_id=? ORDER BY rowid DESC LIMIT 1').get(row.id);
      requireCondition((row.state==='candidate'&&!last)||(row.state==='adopted'&&last?.decision==='adopt')||(row.state==='revoked'&&last?.decision==='revoke'),409,'library_migration','资料状态缺少对应审核，不能推断已采用');
      requireCondition(digest(version.provenance.sourceTask)===digest(this.evidence(row.user_id,row.source_task_id))&&version.scope.kind==='device'&&version.sha256===sha256(version.text),409,'library_migration','原候选来源或正文不完整');
    }
    for(const validation of this.store.db.prepare('SELECT * FROM source_library_validations').all()){
      const {row,version}=this.entry(String(validation.user_id),String(validation.entry_id)),receipt=JSON.parse(String(validation.evidence_json));
      const use=this.store.db.prepare("SELECT * FROM source_library_uses WHERE task_id=? AND entry_id=? AND version_sha256=? AND stage='candidate'").get(validation.task_id,row.id,row.version_sha256);
      requireCondition(validation.version_sha256===row.version_sha256&&validation.task_id!==row.source_task_id&&use&&receipt.entryId===row.id&&receipt.versionSha256===row.version_sha256&&digest(receipt.scope)===digest(version.scope)&&digest(receipt.task)===digest(this.evidence(row.user_id,String(validation.task_id))),409,'library_migration','原验证缺少准确资料使用或执行依据');
    }
    for(const review of this.store.db.prepare('SELECT * FROM source_library_reviews').all()){
      const {row}=this.entry(String(review.user_id),String(review.entry_id));
      const validation=review.validation_id===null?null:this.store.db.prepare('SELECT * FROM source_library_validations WHERE id=? AND user_id=? AND entry_id=? AND version_sha256=?').get(review.validation_id,review.user_id,review.entry_id,review.version_sha256);
      requireCondition(row.version_sha256===review.version_sha256&&String(review.reason).trim().length>0&&((review.decision==='adopt'&&validation)||(review.decision==='revoke'&&review.validation_id===null)),409,'library_migration','原审核缺少匹配的验证或撤销依据');
    }
    for(const use of this.store.db.prepare('SELECT * FROM source_library_uses').all()){
      const root=this.store.db.prepare('SELECT * FROM operations WHERE id=?').get(use.task_id) as unknown as OperationRow|undefined;
      requireCondition(root,409,'library_migration','资料使用缺少原任务');const {row,version}=this.entry(root.user_id,String(use.entry_id));
      const original=delegateSchema.parse(JSON.parse(root.command_json)).sources.find(s=>s.id===use.source_id);
      requireCondition(row.node_id===root.node_id&&row.epoch===root.epoch&&row.version_sha256===use.version_sha256&&original&&digest(original)===digest(this.asSource(row,version,use.stage as 'candidate'|'adopted')),409,'library_migration','资料使用与原任务输入不符');
    }
    const missing=this.store.db.prepare("SELECT o.id FROM operations o,json_each(o.command_json,'$.sources') s LEFT JOIN source_library_uses u ON u.task_id=o.id AND u.source_id=json_extract(s.value,'$.id') WHERE json_extract(o.command_json,'$.kind')='agent.delegate' AND json_extract(s.value,'$.library') IS NOT NULL AND u.task_id IS NULL LIMIT 1").get();requireCondition(!missing,409,'library_migration','原任务的资料关系缺失，不得补造来源');
  }
  private entry(user:string,id:string){
    const row=this.store.db.prepare('SELECT * FROM source_library WHERE id=? AND user_id=?').get(id,user) as Entry|undefined;
    requireCondition(row,404,'library_entry_not_found','未找到该资料版本');
    const version=JSON.parse(row.version_json);requireCondition(digest(version)===row.version_sha256&&version.id===row.id&&version.scope.nodeId===row.node_id&&version.scope.epoch===row.epoch,409,'library_version_corrupt','资料版本原件不一致');
    return{row,version};
  }
  private scope(user:string,nodeId:string,epoch:number){
    const node=this.store.ownedNode(user,nodeId);requireCondition(!node.revoked&&node.epoch===epoch,409,'library_scope_changed','资料只适用于原设备配对；重新配对不能自动继承');return node;
  }
  private evidence(user:string,taskId:string){
    const c=this.store.executions.resolve(user,taskId);requireCondition(c.op.id===taskId,400,'library_root_required','须提供原 root Task ID');
    const current=this.store.operation(user,c.task.active_execution_id);
    requireCondition(current.execution==='succeeded'&&!c.task.requires_reconciliation,409,'library_task_unsettled','验证须为已闭合的成功任务；模型结束不是任务接受');
    requireCondition(!this.store.db.prepare('SELECT 1 FROM operation_reconciliations WHERE operation_id=?').get(current.id),409,'library_native_proof_required','普通对账成功不能代替原 Node 完结证明');
    const event=this.store.db.prepare("SELECT * FROM operation_events WHERE operation_id=? AND kind='succeeded' ORDER BY sequence DESC LIMIT 1").get(current.id);
    requireCondition(event,409,'library_native_proof_required','缺少原 Node 成功终态事件');
    const data=JSON.parse(String(event.data_json));requireCondition(digest(data)===digest(JSON.parse(current.result_json!))&&data.taskAccepted===false,409,'library_native_proof_required','原 Node 终态与当前结果不符');
    let proof:unknown;
    if(current.id===taskId){const marker=this.store.db.prepare('SELECT * FROM agent_native_closures WHERE operation_id=? AND event_id=?').get(current.id,event.event_id);requireCondition(data.nativeClosure&&marker?.proof_sha256===digest(data.nativeClosure),409,'library_native_proof_required','历史成功结果没有经过准确服务校验的原进程 join/Released 证明，不能补造验证');proof=data.nativeClosure;}
    else{const finish=this.store.db.prepare('SELECT * FROM agent_task_finishes WHERE root_id=? AND execution_id=? AND event_id=?').get(taskId,current.id,event.event_id),original=JSON.parse(current.command_json).kind==='agent.finalize'?data.finalizationProof:data.finalProof;requireCondition(finish&&original&&digest(JSON.parse(String(finish.proof_json)))===digest(original),409,'library_native_proof_required','恢复或只读结算缺少准确原终态证明');proof=original;}
    this.store.models.assertSettled(c.op);
    const effects=this.store.resumes.effectSnapshot(c.op),effectsSha256=sha256(JSON.stringify(effects)),children=effects.children;
    // Read-only finalization records released consumption after validating its
    // snapshot. That expected budget change is already sealed by task_finishes.
    if(current.id===taskId)requireCondition((proof as any).snapshotSha256===effectsSha256,409,'library_native_evidence_changed','原生完结证明与完整效果账本已不一致');
    requireCondition(children.length>0&&children.some(ch=>ch.operation.execution==='succeeded')&&children.every(ch=>['succeeded','failed','cancelled'].includes(ch.operation.execution)),409,'library_validation_effect_required','验证须有原 Task 的真实成功子操作，所有效果均已结算');
    const receipts=children.map(ch=>{const terminal=this.store.db.prepare("SELECT event_id,digest,kind,sequence FROM operation_events WHERE operation_id=? AND kind IN ('succeeded','failed','cancelled') ORDER BY sequence DESC LIMIT 1").get(ch.operation.id);requireCondition(terminal&&terminal.kind===ch.operation.execution,409,'library_validation_effect_required','子操作缺少准确原终态事件');return{operationId:ch.operation.id,payloadHash:ch.operation.payload_hash,resultSha256:ch.operation.resultSha256,...terminal};});
    return {taskId,executionId:current.id,sessionId:c.command.sessionId,nodeId:c.op.node_id,epoch:c.op.epoch,payloadHash:c.op.payload_hash,eventId:event.event_id,eventDigest:event.digest,resultSha256:sha256(current.result_json!),proofSha256:digest(proof),effectsSha256,children:receipts};
  }
  private metadata(row:Entry,version:any){return{id:row.id,state:row.state,kind:version.kind,title:version.title,revision:version.revision,sha256:version.sha256,versionSha256:row.version_sha256,scope:version.scope,createdAt:row.created_at};}
  list(user:string,raw:unknown){const input=libraryListSchema.parse(raw);this.scope(user,input.nodeId,input.epoch);return{entries:(this.store.db.prepare('SELECT * FROM source_library WHERE user_id=? AND node_id=? AND epoch=? AND state=? ORDER BY created_at,id').all(user,input.nodeId,input.epoch,input.state) as Entry[]).map(row=>{const e=this.entry(user,row.id);return this.metadata(e.row,e.version);})};}
  read(user:string,id:string){const {row,version}=this.entry(user,id);return{...this.metadata(row,version),version,validations:this.store.db.prepare('SELECT * FROM source_library_validations WHERE entry_id=? ORDER BY created_at,id').all(id).map(v=>({...v,evidence:JSON.parse(String(v.evidence_json)),evidence_json:undefined})),reviews:this.store.db.prepare('SELECT * FROM source_library_reviews WHERE entry_id=? ORDER BY created_at,id').all(id)};}
  private asSource(row:Entry,version:any,stage:'candidate'|'adopted'){
    return sourceSchema.parse({id:'reach-library:'+row.id,kind:version.kind,source:'reach-library://'+row.id,revision:version.revision,sha256:version.sha256,text:version.text,requirements:version.requirements,library:{id:row.id,versionSha256:row.version_sha256,stage}});
  }
  source(user:string,id:string,raw:unknown){const input=librarySourceSchema.parse(raw),{row,version}=this.entry(user,id);this.scope(user,row.node_id,row.epoch);requireCondition(row.version_sha256===input.versionSha256,409,'library_version_changed','须取回准确资料版本');requireCondition(row.state!=='revoked'&&(input.stage==='candidate'||row.state==='adopted'),409,'library_not_adopted','该资料已撤销或尚未采用');return{source:this.asSource(row,version,input.stage),status:input.stage==='candidate'?'unadopted_reference':'explicitly_adopted_source',validationIsNotTaskAcceptance:true};}
  checkSources(command:Delegate,node:NodeRow){
    for(const source of command.sources){const ref=source.library;
      if(!ref){requireCondition(!source.id.startsWith('reach-library:')&&!source.source.startsWith('reach-library://'),400,'library_reference_required','注册资料必须携带准确版本引用');continue;}
      const {row,version}=this.entry(node.user_id,ref.id);
      requireCondition(row.node_id===node.id&&row.epoch===node.epoch,409,'library_scope_changed','不能跨设备配对复用资料');
      requireCondition(row.state!=='revoked'&&(ref.stage==='candidate'||row.state==='adopted'),409,'library_not_adopted','该资料已撤销或尚未采用');
      requireCondition(ref.versionSha256===row.version_sha256&&digest(source)===digest(this.asSource(row,version,ref.stage)),409,'library_version_changed','正文、版本、来源或适用要求不是原资料版本');
    }
  }
  recordUses(op:OperationRow){const command=delegateSchema.parse(JSON.parse(op.command_json));for(const s of command.sources)if(s.library)this.store.db.prepare('INSERT INTO source_library_uses VALUES(?,?,?,?,?)').run(op.id,s.library.id,s.library.versionSha256,s.library.stage,s.id);}
  propose(user:string,raw:unknown){const input=libraryProposalSchema.parse(raw);return this.store.transaction(()=>{
    const old=this.store.db.prepare('SELECT id,request_sha256 FROM source_library WHERE user_id=? AND request_id=?').get(user,input.requestId);
    if(old){requireCondition(old.request_sha256===digest(input),409,'library_request_conflict','同一请求不能改变候选资料');return this.read(user,String(old.id));}
    const evidence=this.evidence(user,input.sourceTaskId);this.scope(user,evidence.nodeId,evidence.epoch);
    const origin=this.store.executions.resolve(user,input.sourceTaskId).command,id=randomUUID();
    const sourceHeaders=origin.sources.map(source=>{const {text,...header}=source;return header;});
    const version={id,kind:input.kind,title:input.title,revision:input.revision,text:input.text,sha256:sha256(input.text),requirements:input.requirements,scope:{kind:'device',nodeId:evidence.nodeId,epoch:evidence.epoch},provenance:{kind:'controller_authored_from_task_evidence',sourceTask:evidence,objectiveSha256:sha256(origin.objective),sources:sourceHeaders}};
    this.store.db.prepare("INSERT INTO source_library VALUES(?,?,?,?,?,?,?,?,?,'candidate',?)").run(id,user,input.requestId,digest(input),evidence.nodeId,evidence.epoch,input.sourceTaskId,digest(version),JSON.stringify(version),this.store.now());
    this.store.audit(user,'library.candidate_created',id);return this.read(user,id);
  });}
  validate(user:string,id:string,raw:unknown){const input=libraryValidationSchema.parse(raw);return this.store.transaction(()=>{
    const {row,version}=this.entry(user,id),old=this.store.db.prepare('SELECT * FROM source_library_validations WHERE user_id=? AND request_id=?').get(user,input.requestId);
    if(old){requireCondition(old.entry_id===id&&old.request_sha256===digest(input),409,'library_request_conflict','同一请求不能改变验证依据');return{validation:old,currentState:row.state};}
    requireCondition(row.state==='candidate'&&row.version_sha256===input.versionSha256,409,'library_version_changed','只可验证准确的未采用候选');this.scope(user,row.node_id,row.epoch);
    requireCondition(input.validationTaskId!==row.source_task_id,409,'library_distinct_task_required','来源任务的一次成功不能作为自身推广验证');
    const use=this.store.db.prepare("SELECT * FROM source_library_uses WHERE task_id=? AND entry_id=? AND version_sha256=? AND stage='candidate'").get(input.validationTaskId,id,row.version_sha256);
    requireCondition(use,409,'library_validation_input_required','验证 Task 提交时须已明确选入此候选原版本');
    const evidence=this.evidence(user,input.validationTaskId);requireCondition(evidence.nodeId===row.node_id&&evidence.epoch===row.epoch,409,'library_scope_changed','验证须属于原设备配对');
    const c=this.store.executions.resolve(user,input.validationTaskId);this.checkSources(c.command,this.store.ownedNode(user,row.node_id));
    const receipt={kind:'actual_execution_evidence_not_semantic_acceptance',entryId:id,versionSha256:row.version_sha256,scope:version.scope,task:evidence},validationId=randomUUID();
    this.store.db.prepare('INSERT INTO source_library_validations VALUES(?,?,?,?,?,?,?,?,?)').run(validationId,user,input.requestId,digest(input),id,row.version_sha256,input.validationTaskId,JSON.stringify(receipt),this.store.now());
    this.store.audit(user,'library.execution_validated',id);return{validation:this.store.db.prepare('SELECT * FROM source_library_validations WHERE id=?').get(validationId),currentState:row.state};
  });}
  review(user:string,id:string,raw:unknown){const input=libraryReviewSchema.parse(raw);return this.store.transaction(()=>{
    const {row}=this.entry(user,id),old=this.store.db.prepare('SELECT * FROM source_library_reviews WHERE user_id=? AND request_id=?').get(user,input.requestId);
    if(old){requireCondition(old.entry_id===id&&old.request_sha256===digest(input),409,'library_request_conflict','同一请求不能改变审核');return{review:old,currentState:row.state};}
    requireCondition(row.version_sha256===input.versionSha256&&row.state!=='revoked',409,'library_version_changed','资料已撤销或版本不符；不能重新激活');
    if(input.decision==='adopt'){
      requireCondition(row.state==='candidate'&&input.validationId,409,'library_validation_required','采用前须有独立任务验证回执');this.scope(user,row.node_id,row.epoch);
      const v=this.store.db.prepare('SELECT * FROM source_library_validations WHERE id=? AND entry_id=? AND version_sha256=?').get(input.validationId,id,row.version_sha256);
      requireCondition(v,409,'library_validation_required','验证回执不属于此候选原版本');
      const receipt=JSON.parse(String(v.evidence_json));requireCondition(digest(receipt.task)===digest(this.evidence(user,String(v.task_id))),409,'library_validation_changed','原验证效果已变化，不能采用旧依据');
    }else requireCondition(input.validationId===undefined,400,'library_revoke_input','撤销不接受替代验证依据');
    const reviewId=randomUUID(),state=input.decision==='adopt'?'adopted':'revoked';
    this.store.db.prepare('INSERT INTO source_library_reviews VALUES(?,?,?,?,?,?,?,?,?,?)').run(reviewId,user,input.requestId,digest(input),id,row.version_sha256,input.decision,input.validationId??null,input.reason,this.store.now());
    this.store.db.prepare('UPDATE source_library SET state=? WHERE id=?').run(state,id);this.store.audit(user,'library.'+state,id);
    return{review:this.store.db.prepare('SELECT * FROM source_library_reviews WHERE id=?').get(reviewId),currentState:state};
  });}
}
