// Copyright (c) Ray Zhang. Product Host over the shared JSONL/Harness/Core process.
import { readFileSync, writeFileSync, mkdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DeskContext, DeskExtension } from '../../src/service/desk-extension.ts';
import type { DeskDevices } from '../../src/service/desk-devices.ts';
import { deviceTargetSchema } from '../../src/contracts/device-target.ts';
import { requireCondition, ReachError } from '../../src/service/errors.ts';
import { DeskStore, digest } from './store.ts';
import type { Turn } from './store.ts';
import { AnswerEvents } from './events.ts';
import { serveDesk } from './web.ts';
import { pinRuntime, baseline, prepareSettlement, executeSettlement, recoverCloseOperation, saveProof, toolsForRuntime, hashBytes, isImageRuntime } from './settlement.ts';
import {DeviceToolsHost,deviceToolsFor,checkDeviceOperation} from './device-tools.ts';
import {verifyNativeImages} from './device-images.ts';
import {checkSessionCapacity} from './session-capacity.ts';
import {imageViews,readImage} from './image-preview.ts';

interface LiteHandle { wait():Promise<any>;cancel():void;forceKill():void }
interface Active { turn:Turn; valid:()=>boolean; devices?:DeskDevices;handle?:LiteHandle; promise:Promise<void>; owners:number }
export interface DeskConfig { stateDirectory:string; binary:string; endpoint:string; model:string; modelToken:string; developmentLoopback?:boolean; developmentImageInput?:boolean; developmentContextWindow?:number; maxSeconds?:number; maxCalls?:number; maxOutput?:number }
const id=z.string().uuid();
const createSchema=z.strictObject({id,title:z.string().min(1).max(120).default('新对话')});
const messageSchema=z.strictObject({id,content:z.string().trim().min(1).max(32000),target:deviceTargetSchema.optional()});
const live=(turn:Turn)=>['starting','running','cancelling'].includes(turn.status);
const publicTurn=(turn:Turn)=>({id:turn.id,conversationId:turn.conversation_id,content:turn.content,status:turn.status,output:turn.output,reason:turn.reason,cancelRequested:!!turn.cancel_requested,taskId:turn.task_id,runId:turn.run_id,taskAccepted:false,createdAt:turn.created_at});
const send=(response:DeskContext['response'],status:number,value:unknown)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});response.end(JSON.stringify(value));};
function save(path:string,value:unknown){const fd=openSync(path,'wx');try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}}

export class DeskHost implements DeskExtension {
  serveStatic = serveDesk;
  readonly store:DeskStore;
  readonly config:Required<DeskConfig>;
  readonly route:object;
  readonly routeHash:string;
  private active=new Map<string,Active>();
  private streams=new Map<DeskContext['response'],()=>void>();
  private stopping=false;
  private closing?:Promise<void>;
  private recovering:Promise<void>;
  private deviceFactory?: (userId:string)=>DeskDevices;
  constructor(config:DeskConfig){
    requireCondition(isAbsolute(config.stateDirectory)&&isAbsolute(config.binary)&&!!config.modelToken&&!!config.model,500,'desk_config_invalid','Reach Desk 模型与状态配置不完整');
    const endpoint=new URL(config.endpoint);
    requireCondition(!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash&&endpoint.pathname.replace(/\/$/,'')==='/v1',500,'desk_endpoint_invalid','Reach Desk 模型地址不符合配置合同');
    const local=['127.0.0.1','[::1]'].includes(endpoint.hostname);
    requireCondition(!config.developmentLoopback||(endpoint.protocol==='http:'&&local&&!!endpoint.port),500,'desk_relay_invalid','本地 Relay 必须为显式的 loopback HTTP 地址');
    requireCondition(endpoint.protocol==='https:'||(config.developmentLoopback&&endpoint.protocol==='http:'&&local&&!!endpoint.port),500,'desk_https_required','模型服务必须使用 HTTPS 或显式的本地 Relay');
    this.config={developmentLoopback:false,developmentImageInput:false,developmentContextWindow:32768,maxSeconds:120,maxCalls:4,maxOutput:4096,...config,stateDirectory:resolve(config.stateDirectory)};
    requireCondition(Number.isInteger(this.config.maxSeconds)&&this.config.maxSeconds>=1&&this.config.maxSeconds<=600&&Number.isInteger(this.config.maxCalls)&&this.config.maxCalls>=1&&this.config.maxCalls<=32&&Number.isInteger(this.config.maxOutput)&&this.config.maxOutput>=1&&this.config.maxOutput<=8192,500,'desk_budget_invalid','Reach Desk 运行预算无效');
    requireCondition(!this.config.developmentImageInput||config.developmentLoopback,500,'desk_image_relay_invalid','本地图片声明仅适用于显式 loopback Relay');
    requireCondition((config.developmentContextWindow===undefined||config.developmentLoopback===true)&&Number.isSafeInteger(this.config.developmentContextWindow)&&this.config.developmentContextWindow>=32768&&this.config.developmentContextWindow<=131072,500,'desk_context_relay_invalid','本地上下文声明需要显式 loopback Relay，范围为 32768–131072');
    this.route={endpoint:config.endpoint,model:config.model,modelResolution:config.developmentLoopback?{kind:'host_declared_loopback',capabilities:{context_window:this.config.developmentContextWindow,max_tokens:8192,input:this.config.developmentImageInput?['text','image']:['text']}}:{kind:'catalog'}};
    this.routeHash=digest(this.route);this.store=new DeskStore(join(this.config.stateDirectory,'desk.sqlite'));
    this.recovering=this.recoverSettlements();
  }
  private cancel(turn:Turn,reason:string){this.store.cancel(turn.user_id,turn.id,reason);this.active.get(turn.id)?.handle?.cancel();}
  bindDevices(factory:(userId:string)=>DeskDevices){requireCondition(!this.deviceFactory,500,'desk_devices_already_bound','设备账本已绑定');this.deviceFactory=factory;this.recovering=this.recovering.then(()=>this.recoverDeviceEffects());}
  private present(turn:Turn,access?:DeskDevices){const calls=this.store.deviceCalls(turn);return {...publicTurn(turn),target:turn.target_json?JSON.parse(turn.target_json):null,images:imageViews(calls),deviceCalls:calls.map(call=>{let operation:any=null;if(call.operation_id&&access)try{const op=access.operation(JSON.parse(turn.target_json!),call.operation_id);operation={operationId:op.id,nodeId:op.node_id,epoch:op.epoch,execution:op.execution,delivery:op.delivery,cancelRequested:!!op.cancel_requested};}catch{}return {callId:call.call_id,tool:call.tool,operationId:call.operation_id,status:call.status,operation};})};}
  revoke(sessionId:string){for(const active of this.active.values())if(active.turn.session_hash===sessionId)this.cancel(active.turn,'session_revoked');}
  async handle(c:DeskContext){
    await this.recovering;
    requireCondition(!this.stopping,503,'desk_stopping','Reach Desk 正在停止');
    const method=c.request.method,route=c.url.pathname;
    const image=route.match(/^\/api\/v1\/desk\/messages\/([^/]+)\/images\/([0-9a-f]{64})$/);
    if(image&&method==='GET'){const turn=this.store.turn(c.userId,id.parse(image[1]));requireCondition(c.devices,503,'desk_devices_unavailable','原设备账本暂不可读');const original=readImage(this.store,turn,c.devices,join(this.config.stateDirectory,'tasks',turn.task_id),image[2]);requireCondition(c.sessionValid(),401,'authentication_required','登录已过期');c.response.writeHead(200,{'content-type':'image/png','content-length':original.bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff','content-disposition':'inline; filename="reach-'+original.view.artifactId+'.png"'});c.response.end(original.bytes);return;}
    if(route==='/api/v1/desk/devices'&&method==='GET'){requireCondition(c.devices,503,'desk_devices_unavailable','设备账本尚未连接');return send(c.response,200,{nodes:c.devices.list()});}
    if(route==='/api/v1/desk/conversations'){
      if(method==='GET')return send(c.response,200,{conversations:this.store.conversations(c.userId)});
      if(method==='POST'){const input=createSchema.parse(await c.body());return send(c.response,201,this.store.create(c.userId,input.id,input.title,this.routeHash));}
    }
    const conversation=route.match(/^\/api\/v1\/desk\/conversations\/([^/]+)(?:\/(messages))?$/);
    if(conversation){
      const conversationId=id.parse(conversation[1]);
      if(method==='GET'&&!conversation[2])return send(c.response,200,{conversation:this.store.conversation(c.userId,conversationId),messages:this.store.turns(c.userId,conversationId).map(turn=>this.present(turn,c.devices))});
      if(method==='POST'&&conversation[2]){
        const input=messageSchema.parse(await c.body());requireCondition(c.sessionValid(),401,'authentication_required','登录已过期');
        if(c.request.aborted||c.response.destroyed)return;
        const previous=this.store.db.prepare('SELECT * FROM turns WHERE user_id=? AND id=?').get(c.userId,input.id) as unknown as Turn|undefined;
        if(!previous){this.store.conversation(c.userId,conversationId);checkSessionCapacity(join(this.config.stateDirectory,'sessions',conversationId),isImageRuntime(hashBytes(readFileSync(this.config.binary))));}
        let target=null;
        if(input.target){requireCondition(c.devices,503,'desk_devices_unavailable','设备账本尚未连接');target=previous?{...input.target,...(previous.target_json?JSON.parse(previous.target_json):{name:'',platform:''}),...input.target}:c.devices.target(input.target);}
        const admitted=this.store.admit(c.userId,conversationId,input.id,input.content,c.sessionId,this.routeHash,target);
        if(admitted.fresh){
          const active:Active={turn:admitted.turn,valid:c.sessionValid,devices:c.devices,owners:0,promise:Promise.resolve()};this.active.set(admitted.turn.id,active);
          // Attach the response before asynchronous sidecar admission begins.
          this.stream(c,admitted.turn,0);
          active.promise=this.run(active).finally(()=>this.active.delete(admitted.turn.id));
        }else this.stream(c,admitted.turn,0);
        return;
      }
    }
    const message=route.match(/^\/api\/v1\/desk\/messages\/([^/]+)(?:\/(events|cancel))?$/);
    if(message){const turn=this.store.turn(c.userId,id.parse(message[1]));
      if(method==='GET'&&!message[2])return send(c.response,200,this.present(turn,c.devices));
      if(method==='GET'&&message[2]==='events'){const after=z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(c.url.searchParams.get('after')??0);return this.stream(c,turn,after);}
      if(method==='POST'&&message[2]==='cancel'){this.cancel(turn,'user_requested');return send(c.response,202,this.present(this.store.turn(c.userId,turn.id),c.devices));}
    }
    throw new ReachError(404,'not_found','接口不存在');
  }
  private stream(c:DeskContext,turn:Turn,after:number){
    const {response}=c;let cursor=after,ended=false,timer:ReturnType<typeof setInterval>|undefined;
    const active=this.active.get(turn.id),owner=active?.turn.session_hash===c.sessionId;
    if(response.destroyed||response.writableEnded){if(active&&owner&&active.owners===0)this.cancel(turn,'browser_disconnected');return;}
    if(active&&owner)active.owners++;
    const finish=()=>{if(ended)return;ended=true;clearInterval(timer);this.streams.delete(response);if(active&&owner&&--active.owners===0&&live(this.store.turn(turn.user_id,turn.id)))this.cancel(turn,'browser_disconnected');};
    this.streams.set(response,finish);
    response.once('close',finish);
    response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-accel-buffering':'no','x-content-type-options':'nosniff'});response.flushHeaders();
    const tick=()=>{
      try{
        if(!c.sessionValid()){if(owner)this.cancel(turn,'session_expired');response.end();return;}
        if(response.writableLength>262144){response.destroy();return;}
        const records=this.store.events(c.userId,turn.id,cursor);
        for(const row of records){response.write(`id: ${row.seq}\nevent: ${row.kind}\ndata: ${row.data_json}\n\n`);cursor=row.seq;}
        if(records.length<100&&!live(this.store.turn(c.userId,turn.id)))response.end();
      }catch{response.destroy();}
    };
    timer=setInterval(tick,75);if(response.destroyed)finish();else tick();
  }
  private async run(active:Active){
    const {turn}=active,conversation=join(this.config.stateDirectory,'sessions',turn.conversation_id),root=join(this.config.stateDirectory,'tasks',turn.task_id),evidence=join(root,'evidence');
    let timer:ReturnType<typeof setInterval>|undefined,observer:AnswerEvents|undefined,streamFailed=false;
    try{
      mkdirSync(conversation,{recursive:true});mkdirSync(root,{recursive:true});mkdirSync(join(conversation,'workspace'),{recursive:true});
      const route=this.route as {endpoint:string;model:string;modelResolution:unknown};
      const target=turn.target_json?JSON.parse(turn.target_json):null;
      const image=pinRuntime(this.config.binary,this.config.stateDirectory);save(join(root,'runtime.json'),image);
      const start={kind:'start_task',version:1,task:{task_id:turn.task_id,criteria_revision:'reach-desk-text-v1',authorization_revision:digest({user:turn.user_id,conversation:turn.conversation_id,target}),kind:'Reasoning',evidence_dir:evidence,max_runs:1,max_calls:this.config.maxCalls,deadline_unix_ms:Date.now()+this.config.maxSeconds*1000},run:{run_id:turn.run_id,objective:turn.content,cwd:join(conversation,'workspace'),session_path:join(conversation,'session.json'),environment_state:join(conversation,'environment'),device_fp:'reach-desk-cloud',session_key:turn.conversation_id,mode:'execute',endpoint:route.endpoint,model:route.model,max_calls:this.config.maxCalls,max_seconds:this.config.maxSeconds,max_output:this.config.maxOutput,host_output_ceiling:this.config.maxOutput,model_resolution:route.modelResolution,tools:target?toolsForRuntime(target,image.sha256):[]},cancel_grace_ms:1000,emit_events:true};
      save(join(root,'request.json'),start);
      const base=await baseline(image,start,root);
      const devices=target?new DeviceToolsHost(this.store,turn,active.devices!,root,active.valid,start.task.deadline_unix_ms):undefined;
      const callbacks={
        tool:async(frame:any,options:{signal:AbortSignal})=>{requireCondition(devices,409,'desk_target_required','本次消息没有设备执行目标');return devices.invoke(frame,options);},
        verify:async(candidate:any,{signal,frame}:{signal:AbortSignal;frame:any})=>{
          requireCondition(!signal.aborted&&active.valid(),401,'session_expired','会话已停止');
          requireCondition(candidate.basis.task_id===turn.task_id&&candidate.basis.run_id===turn.run_id&&typeof candidate.output==='string'&&candidate.output.trim().length>0,500,'desk_candidate_invalid','原回答证据不完整');
          let deviceEvidence:string[]=[],externalTools=0;
          try{const audit=devices?.review();deviceEvidence=audit?.evidencePaths??[];externalTools=audit?.records.length??0;const native=await verifyNativeImages(frame,candidate.basis,audit,evidence);if(native)deviceEvidence.push(native.path);}catch(error){saveProof(join(root,'reply-review-rejected.json'),{reason:error instanceof Error?error.message:'device_effect_review_failed'});throw error;}
          const path=join(root,'reply-review.json');save(path,{basis:candidate.basis,outputHash:digest(candidate.output),purpose:'reply received and persisted; factual correctness and business task acceptance are not asserted',externalTools,coreSessionTools:true,deviceEvidence});
          return {basis:candidate.basis,committed:true,settlement:'Settled',verdict:'Verified',evidence:[path,...deviceEvidence]};
        },
        prepare:async()=>{throw Error('No automatic feedback continuation for cloud conversation');},
      };
      const {startTask}=await import(new URL('../../../../crates/morrow-agent-jsonl/clients/node/client.mjs',import.meta.url).href);
      if(this.store.turn(turn.user_id,turn.id).cancel_requested||!active.valid()||active.owners===0){
        this.store.finish(turn.id,'cancelled','','cancelled_before_start',null,false);return;
      }
      active.handle=await startTask({binary:image.path,start,modelToken:this.config.modelToken,operationDirectory:join(root,'client'),callbacks});
      this.store.running(turn.id);
      observer=new AnswerEvents(evidence,turn.task_id,turn.run_id,(text,seq)=>this.store.event(turn.id,'delta',{text,sourceSeq:seq}));
      const poll=()=>{
        if(!active.valid())this.cancel(turn,'session_expired');
        if(this.store.turn(turn.user_id,turn.id).cancel_requested)active.handle?.cancel();
        if(!streamFailed)try{observer!.poll();}catch{streamFailed=true;this.store.event(turn.id,'stream_unavailable',{reason:'original_event_stream_unavailable'});}
      };
      timer=setInterval(poll,75);poll();
      const result=await active.handle!.wait();clearInterval(timer);poll();
      save(join(root,'result.json'),result);
      const unknown=result.delivery!=='validated'||result.reconciliation_required||!result.callbacks_finished;
      const completed=!unknown&&result.outcome?.stop==='AwaitingHostAcceptance';
      const cancelled=result.outcome?.stop==='Cancelled';
      const output=result.outcome?.last_candidate?.output||this.partial(turn);
      if(cancelled||result.outcome?.stop==='Informational'){
        // Deadline cancellation is also an explicit terminal stop to the Store.
        if(cancelled)this.store.cancel(turn.user_id,turn.id,this.store.turn(turn.user_id,turn.id).reason??'run_cancelled');
        try{
          const intent=await prepareSettlement(image,start,base,result,turn,root,this.config.modelToken,devices?.review());
          const token=this.store.beginSettlement(turn.id,intent,{output,reason:result.outcome.stop,result});
          await this.settle(this.store.turn(turn.user_id,turn.id),token);return;
        }catch(error){
          if(this.store.turn(turn.user_id,turn.id).close_intent_json)throw Error('settlement already persisted');
          saveProof(join(root,'settlement-rejected.json'),{reason:error instanceof Error?error.message:'original_effects_not_proven'});
          this.store.event(turn.id,'settlement_unavailable',{reason:'original_effects_not_proven'});
        }
      }
      this.store.transaction(()=>this.store.finish(turn.id,completed?'completed':cancelled?'cancelled':unknown?'unknown':'failed',output,completed?null:result.outcome?.stop??'host_result_unknown',{delivery:result.delivery,outcome:result.outcome,process:result.process},unknown));
    }catch{
      active.handle?.cancel();if(active.handle)try{await active.handle.wait();}catch{}
      const current=this.store.turn(turn.user_id,turn.id);
      if(current.close_intent_json)this.store.failSettlement(turn.id,this.store.settlementToken(current),{delivery:'unknown',reason:'host_close_failed'});
      else this.store.transaction(()=>this.store.finish(turn.id,'unknown',this.partial(turn),'host_failed',null,true));
    }finally{clearInterval(timer);}
  }
  private partial(turn:Turn){return (this.store.db.prepare("SELECT data_json FROM events WHERE turn_id=? AND kind='delta' ORDER BY seq").all(turn.id) as {data_json:string}[]).map(row=>JSON.parse(row.data_json).text).join('');}
  private async settle(turn:Turn,token:ReturnType<DeskStore['settlementToken']>){
    const root=join(this.config.stateDirectory,'tasks',turn.task_id),intent=JSON.parse(turn.close_intent_json!);
    let last:unknown={delivery:'unknown',reason:'close_attempt_budget_exhausted'};
    // Read original joined proof before spending another attempt, including after attempt 2.
    for(let attempt=turn.close_attempts;attempt>0;attempt--)try{
      const prior=await recoverCloseOperation(intent,root,attempt);
      if(prior.result.original_outcome?.task_id===turn.task_id&&prior.result.original_outcome.stop===(intent.terminalStatus==='completed'?'Informational':'Cancelled')&&this.store.completeSettlement(turn.id,token,prior))return;
    }catch{/* Missing or incomplete original proof never substitutes for a validated close. */}
    for(;;){
      const attempt=this.store.claimSettlement(turn.id,token,2);if(attempt===null)break;
      try{last=await executeSettlement(intent,root,attempt);}catch{last={delivery:'unknown',reason:'original_close_inputs_unavailable'};}
      saveProof(join(root,'close-attempt-'+attempt+'.json'),last);
      if((last as any).delivery==='validated'){
        const result=(last as any).result;
        if(result.original_outcome?.task_id===turn.task_id&&result.original_outcome.stop===(intent.terminalStatus==='completed'?'Informational':'Cancelled')&&result.task_accepted===false&&this.store.completeSettlement(turn.id,token,last))return;
      }
    }
    this.store.failSettlement(turn.id,token,last);
  }
  private async recoverSettlements(){for(const turn of this.store.pendingSettlements()){
    const token=this.store.settlementToken(turn);
    try{await this.settle(turn,token);}catch{this.store.failSettlement(turn.id,token,{delivery:'unknown',reason:'original_close_recovery_failed'});}
  }}
  private async recoverDeviceEffects(){for(const turn of this.store.interruptedDeviceTurns()){
    const access=this.deviceFactory!(turn.user_id),target=JSON.parse(turn.target_json!),root=join(this.config.stateDirectory,'tasks',turn.task_id);mkdirSync(root,{recursive:true});
    for(const call of this.store.deviceCalls(turn))if(call.tool==='reach_execute'){
      const intent=JSON.parse(call.intent_json);let op:any=null,reason:string|null=null;
      try{op=call.operation_id?access.operation(target,call.operation_id):access.find(target,intent.requestId);if(op){checkDeviceOperation(op,intent);this.store.bindDeviceOperation(turn,call.call_key,op.id);if(!['succeeded','failed','cancelled','unknown'].includes(op.execution))op=access.cancel(target,op.id);}}catch{reason='original_device_operation_unavailable';}
      saveProof(join(root,'device-recovery-'+call.call_key+'-'+randomUUID()+'.json'),{taskId:turn.task_id,callId:call.call_id,requestId:intent.requestId,operation:op,reason,resubmitted:false,taskAccepted:false});
    }
  }}
  close(){return this.closing??=this.stop();}
  private async stop(){this.stopping=true;for(const active of this.active.values())this.cancel(active.turn,'host_stopping');await this.recovering;await Promise.all([...this.active.values()].map(value=>value.promise));for(const [response,finish] of this.streams){finish();response.destroy();}this.store.close();}
}
