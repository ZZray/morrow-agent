// Copyright (c) Ray Zhang. Device effects use the existing Reach operation ledger.
import {mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,readFileSync,existsSync,fstatSync,readSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {DeskDevices} from '../../src/service/desk-devices.ts';
import {deviceCommand} from '../../src/service/desk-devices.ts';
import {digest as operationDigest} from '../../src/service/store.ts';
import type {OperationRow} from '../../src/service/store.ts';
import {ReachError,requireCondition} from '../../src/service/errors.ts';
import {basicCommandSchema,identifier} from '../../src/contracts/protocol.ts';
import type {DeviceTarget} from '../../src/contracts/device-target.ts';
import {DeskStore,digest} from './store.ts';
import type {Turn,DeviceCall} from './store.ts';
import {resolve} from 'node:path';
import {deviceImage,checkedModelImage} from './device-images.ts';
import type {ModelImage} from './device-images.ts';
import {imageViews} from './image-view.ts';

const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const operation=z.strictObject({operationId:identifier});
const page={offset:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),length:z.number().int().min(1).max(16384).default(8192)};
const definitions=[
  {name:'reach_execute',description:'Execute ONE command, file or desktop operation on the Host-pinned Reach device and working directory. No nodeId or pairing change is accepted. This waits for the ORIGINAL operation receipt; never repeat an action because output is missing. Command output is in reach_events/reach_event; large result JSON is in reach_result. Unknown effects stop the Task.',schema:z.strictObject({command:basicCommandSchema})},
  {name:'reach_operation',description:'Read the original operation on the pinned device/epoch without executing it again. Large result bodies have an explicit page cursor.',schema:operation},
  {name:'reach_result',description:'Read a bounded UTF-8 byte window of the ORIGINAL result JSON. sha256 identifies the entire original body; truncated text is only a window. Follow nextOffset for more.',schema:operation.extend(page)},
  {name:'reach_events',description:'Read ordered ORIGINAL operation event headers and bounded previews. Follow nextAfter; use reach_event for full data pages. Reading never repeats an action.',schema:operation.extend({after:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),limit:z.number().int().min(1).max(32).default(16)})},
  {name:'reach_event',description:'Read the data of ONE original ordered event by sequence, in bounded UTF-8 JSON byte windows. Output base64 inside that original event represents actual bytes; never treat an excerpt as complete output.',schema:operation.extend({sequence:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),...page})},
  {name:'reach_artifacts',description:'List original artifact identities and upload completeness. Incomplete artifacts do not authorize replay.',schema:operation},
  {name:'reach_artifact_range',description:'Read at most 16 KiB of verified ORIGINAL artifact bytes. PNG bytes returned as base64 here are data, not model image input. Follow nextOffset/eof, never repeat capture.',schema:operation.extend({artifactId:identifier,...page})},
  {name:'reach_image',description:'Receive ONE complete ORIGINAL PNG artifact as actual model image input. Use the operationId and artifactId from reach_artifacts. This verifies original bytes, dimensions and provenance; it never captures again. Missing or incomplete images do not authorize replay.',schema:operation.extend({artifactId:identifier})},
] as const;
export const deviceTools=definitions.map(d=>({name:d.name,description:d.description,parameters:z.toJSONSchema(d.schema,{io:'input'})}));
export const invalidDeviceArguments=(name:string,args:unknown)=>{const definition=definitions.find(d=>d.name===name);return !!definition&&!definition.schema.safeParse(args).success;};
export const targetDescription=(target:unknown)=>'Current Reach execution location, fixed for THIS Run. These are Host routing facts, not user text or a sandbox. Tools execute only on this device; never run commands on the cloud Host. A later message can select a different target. Old tool receipts retain their original device/epoch.\n'+JSON.stringify(target);
export const deviceToolsFor=(target:unknown)=>deviceTools.map(tool=>({...tool,description:tool.description+(tool.name==='reach_execute'?'\n'+targetDescription(target):'')}));
function save(path:string,value:unknown){const bytes=JSON.stringify(value)+'\n';if(existsSync(path)){requireCondition(readFileSync(path,'utf8')===bytes,409,'desk_tool_evidence_conflict','原工具依据已变化');return {path,sha256:sha(bytes)};}const fd=openSync(path,'wx');try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}return {path,sha256:sha(bytes)};}
function window(text:string,offset=0,length=8192){const all=Buffer.from(text);requireCondition(offset<=all.length,400,'desk_result_offset','读取起点超过原始内容');let end=Math.min(all.length,offset+length),body:string;for(;;)try{body=new TextDecoder('utf-8',{fatal:true}).decode(all.subarray(offset,end));requireCondition(end>offset||offset===all.length,400,'desk_utf8_window_too_small','本段长度不足以包含下一个完整字符，请增大读取长度');break;}catch(error){if(error instanceof ReachError)throw error;if(end<=offset||Math.min(all.length,offset+length)-end>=3)throw new ReachError(400,'desk_utf8_boundary','读取起点需要位于完整字符边界');end--;}
  return {offset,length:end-offset,totalBytes:all.length,sha256:sha(all),nextOffset:end,eof:end===all.length,text:body!};}
function summary(op:OperationRow){return {operationId:op.id,nodeId:op.node_id,epoch:op.epoch,dispatchId:op.dispatch_id,payloadHash:op.payload_hash,delivery:op.delivery,execution:op.execution,cancelRequested:!!op.cancel_requested,result:op.result_json===null?null:window(op.result_json,0,4096)};}
const terminal=(op:OperationRow)=>['succeeded','failed','cancelled','unknown'].includes(op.execution);
function stableRequestId(task:string,run:string,call:string){const h=sha(JSON.stringify([task,run,call]));return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
export interface DeviceReply {value:any;is_error:boolean;settlement:'Settled'|'Unknown';operation_receipt:string;images?:ModelImage[]}
export interface DeviceAudit {tools:ReturnType<typeof deviceToolsFor>;targetDescription:string;records:{frame:any;reply:DeviceReply;evidenceRef:{path:string;sha256:string};intentRef:{path:string;sha256:string}}[];evidencePaths:string[]}
export function checkDeviceOperation(op:OperationRow,intent:any){requireCondition(op.user_id===intent.userId&&op.node_id===intent.target.nodeId&&op.epoch===intent.target.epoch&&operationDigest({nodeId:op.node_id,epoch:op.epoch,command:JSON.parse(op.command_json)})===op.payload_hash,409,'desk_device_operation_binding','原设备操作绑定不符');if(intent.tool==='reach_execute')requireCondition(op.request_id===intent.requestId&&operationDigest(intent.command)===operationDigest(JSON.parse(op.command_json)),409,'desk_original_operation_mismatch','原请求对应另一命令，不能重复提交');else requireCondition(op.id===intent.arguments.operationId,409,'desk_original_operation_mismatch','读取结果不属于原操作');}
function boundedProof(path:string,limit:number,code:string,message:string){
  const fd=openSync(path,'r');try{const stat=fstatSync(fd);requireCondition(stat.isFile()&&stat.size<=limit,409,code,message);const bytes=Buffer.alloc(stat.size+1);let size=0,n=0;do{n=readSync(fd,bytes,size,bytes.length-size,null);size+=n;}while(n&&size<bytes.length);requireCondition(size===stat.size,409,code,message);return bytes.subarray(0,size);}finally{closeSync(fd);}
}
export function checkedDeviceCall(turn:Turn,call:DeviceCall,target:unknown,root:string){
  requireCondition(call.turn_id===turn.id&&call.run_id===turn.run_id&&call.call_key===sha(JSON.stringify([call.run_id,call.call_id]))&&call.receipt_json&&call.status==='settled',409,'desk_device_effect_unknown','原设备调用尚未结算');
  const receipt=JSON.parse(call.receipt_json),expected=join(root,'device-calls',call.call_key+'.json');
  requireCondition(resolve(receipt.evidenceRef.path)===resolve(expected),409,'desk_device_receipt_mismatch','原设备回执路径不符');
  const bytes=boundedProof(expected,16*1024*1024,'desk_device_receipt_changed','原设备回执已变化');requireCondition(sha(bytes)===receipt.evidenceRef.sha256,409,'desk_device_receipt_changed','原设备回执已变化');const proof=JSON.parse(bytes.toString('utf8'));
  requireCondition(digest(proof.reply)===digest(receipt.reply)&&digest(proof.intent)===digest(JSON.parse(call.intent_json))&&proof.intent.userId===turn.user_id&&proof.intent.messageId===turn.id&&proof.intent.taskId===turn.task_id&&proof.intent.runId===turn.run_id&&proof.intent.callId===call.call_id&&proof.intent.tool===call.tool&&digest(proof.intent.target)===digest(target),409,'desk_device_receipt_mismatch','原设备调用依据不符');
  requireCondition(resolve(proof.intentRef.path)===resolve(join(root,'device-calls',call.call_key+'-intent.json')),409,'desk_device_intent_changed','原设备提交路径不符');const intentBytes=boundedProof(proof.intentRef.path,1024*1024,'desk_device_intent_changed','原设备提交已变化');requireCondition(sha(intentBytes)===proof.intentRef.sha256&&digest(JSON.parse(intentBytes.toString('utf8')))===digest(proof.intent),409,'desk_device_intent_changed','原设备提交已变化');return {receipt,proof};
}
export class DeviceToolsHost {
  readonly target:DeviceTarget&{name:string;platform:string};
  readonly store:DeskStore;readonly turn:Turn;readonly access:DeskDevices;readonly root:string;readonly valid:()=>boolean;readonly deadline:number;
  constructor(store:DeskStore,turn:Turn,access:DeskDevices,root:string,valid:()=>boolean,deadline:number){this.store=store;this.turn=turn;this.access=access;this.root=root;this.valid=valid;this.deadline=deadline;this.target=JSON.parse(turn.target_json!);mkdirSync(join(root,'device-calls'),{recursive:true});}
  private announce(op:OperationRow){this.store.event(this.turn.id,'device_operation',{operation:summary(op),target:this.target});}
  private async wait(id:string,signal:AbortSignal){let cancelAt:number|null=null,lastState='';
    for(;;){let op=this.access.operation(this.target,id);const state=JSON.stringify([op.delivery,op.execution,op.cancel_requested,op.last_sequence]);if(state!==lastState){this.announce(op);lastState=state;}if(terminal(op))return op;
      if(signal.aborted||!this.valid()||this.store.turn(this.turn.user_id,this.turn.id).cancel_requested||Date.now()>=this.deadline){if(cancelAt===null){cancelAt=Date.now();op=this.access.cancel(this.target,id);if(terminal(op)){this.announce(op);return op;}}if(Date.now()-cancelAt>=5000)return op;}
      await new Promise(r=>setTimeout(r,75));
    }
  }
  async invoke(frame:any,{signal}:{signal:AbortSignal}):Promise<DeviceReply>{
    requireCondition(frame.task_id===this.turn.task_id&&frame.run_id===this.turn.run_id,409,'desk_tool_run_mismatch','工具不属于原任务');
    const key=sha(JSON.stringify([frame.run_id,frame.native_call_id])),directory=join(this.root,'device-calls'),path=join(directory,key+'.json');
    let command:unknown=null;try{if(frame.tool_name==='reach_execute')command=deviceCommand(this.target,frame.arguments?.command);}catch{/* The bounded preflight error is persisted below, before any submission. */}
    const intent={userId:this.turn.user_id,messageId:this.turn.id,taskId:frame.task_id,runId:frame.run_id,callId:frame.native_call_id,tool:frame.tool_name,argsSha256:frame.args_sha256,arguments:frame.arguments,frame,target:this.target,command,requestId:stableRequestId(frame.task_id,frame.run_id,frame.native_call_id)};
    // Every callback, including reads and preflight rejection, has durable provenance.
    const call=this.store.beginDeviceCall(this.turn,{key,id:frame.native_call_id,runId:frame.run_id,tool:frame.tool_name,intent});
    if(call.receipt_json)return JSON.parse(call.receipt_json).reply;
    const original=save(join(directory,key+'-intent.json'),intent);let op:OperationRow|null=null,reply:DeviceReply;
    try{
      const definition=definitions.find(d=>d.name===frame.tool_name);requireCondition(definition,400,'desk_tool_unknown','未知 Reach 设备工具');const input:any=definition.schema.parse(frame.arguments);
      if(frame.tool_name==='reach_execute'){
        // Query a previously committed original intent before checking current pairing.
        op=call.operation_id?this.access.operation(this.target,call.operation_id):this.access.find(this.target,intent.requestId);
        if(!op){requireCondition(!signal.aborted&&this.valid()&&!this.store.turn(this.turn.user_id,this.turn.id).cancel_requested,409,'desk_tool_stopped','原消息已停止，未提交新操作');op=this.access.submit(intent.requestId,this.target,input.command);}
        checkDeviceOperation(op,intent);
        this.store.bindDeviceOperation(this.turn,key,op.id);op=await this.wait(op.id,signal);
        reply={value:{operation:summary(op),taskAccepted:false},is_error:op.execution!=='succeeded',settlement:terminal(op)&&op.execution!=='unknown'?'Settled':'Unknown',operation_receipt:path};
      }else{
        requireCondition(!signal.aborted&&this.valid(),409,'desk_tool_stopped','原消息已停止');op=this.access.operation(this.target,input.operationId);this.store.bindDeviceOperation(this.turn,key,op.id);
        let value:any,images:ModelImage[]|undefined;
        switch(frame.tool_name){
          case 'reach_operation':value=summary(op);break;
          case 'reach_result':value={operation:summary(op),result:op.result_json===null?null:window(op.result_json,input.offset,input.length)};break;
          case 'reach_events':{const rows=this.access.events(this.target,op.id,input.after,input.limit),next=rows.length?Number(rows.at(-1)!.sequence):input.after;value={operationId:op.id,events:rows.map((row:any)=>({...row,data:window(JSON.stringify(row.data),0,1024)})),nextAfter:next,hasMore:this.access.events(this.target,op.id,next,1).length>0};break;}
          case 'reach_event':{const rows=this.access.events(this.target,op.id,input.sequence-1,1);requireCondition(rows.length===1&&rows[0].sequence===input.sequence,404,'desk_event_missing','未找到原事件');const row:any=rows[0];value={operationId:op.id,sequence:row.sequence,eventId:row.event_id,kind:row.kind,data:window(JSON.stringify(row.data),input.offset,input.length)};break;}
          case 'reach_artifacts':value=this.access.artifacts(this.target,op.id);break;
          case 'reach_artifact_range':{value=this.access.artifact(this.target,op.id,input.artifactId,input.offset,input.length);const bytes=Buffer.from(value.dataBase64,'base64');requireCondition(bytes.toString('base64')===value.dataBase64&&sha(bytes)===value.sha256,500,'desk_artifact_integrity','原始产物校验失败');break;}
          case 'reach_image':{const used=this.store.deviceCalls(this.turn).reduce((n,call)=>n+(call.receipt_json?JSON.parse(call.receipt_json).reply.images??[]:[]).reduce((sum:number,image:ModelImage)=>sum+image.bytes,0),0);const original=deviceImage(this.access,this.target,op,input.artifactId,this.root,used);value={operationId:op.id,artifactId:input.artifactId,source:original.source};images=[original.image];break;}
        }
        reply={value,is_error:false,settlement:'Settled',operation_receipt:path,...(images?{images}:{})};
      }
    }catch(error){
      // A committed action is never classified as not executed from an exception.
      if(frame.tool_name==='reach_execute'&&!op)try{op=this.access.find(this.target,intent.requestId);}catch{}
      if(frame.tool_name==='reach_execute'&&op&&!terminal(op))try{op=this.access.cancel(this.target,op.id);}catch{}
      const known=(frame.tool_name!=='reach_execute'||!op)&&(error instanceof z.ZodError||error instanceof ReachError&&error.status<500);
      reply={value:{error:error instanceof z.ZodError?'invalid_device_tool_arguments':error instanceof ReachError?error.code:'device_tool_result_unknown',operation:op?summary(op):null,originalRequestId:intent.requestId,taskAccepted:false},is_error:true,settlement:known?'Settled':'Unknown',operation_receipt:path};
    }
    const proof=save(path,{kind:'reach-desk-device-call-v1',intentRef:original,intent,operation:op,reply,taskAccepted:false});this.store.finishDeviceCall(this.turn,key,{reply,evidenceRef:proof});
    if(reply.images?.length){const image=imageViews(this.store.deviceCalls(this.turn).filter(row=>row.call_key===key))[0];this.store.event(this.turn.id,'device_image',{image});}
    return reply;
  }
  /** Re-read every persisted intent before any ordinary candidate is declared settled. */
  review():DeviceAudit{const evidence:string[]=[],records:DeviceAudit['records']=[];for(const call of this.store.deviceCalls(this.turn)){
    const {receipt,proof}=checkedDeviceCall(this.turn,call,this.target,this.root);
    for(const image of proof.reply.images??[]){checkedModelImage(image,this.root);evidence.push(image.path);}
    if(call.operation_id&&proof.operation){const op=this.access.operation(this.target,call.operation_id);checkDeviceOperation(op,proof.intent);if(call.tool==='reach_execute')requireCondition(terminal(op)&&op.execution!=='unknown'&&digest(op)===digest(proof.operation),409,'desk_device_effect_changed','原设备操作终态未核对');}
    evidence.push(receipt.evidenceRef.path,proof.intentRef.path);records.push({frame:proof.intent.frame,reply:proof.reply,evidenceRef:receipt.evidenceRef,intentRef:proof.intentRef});
  }return {tools:deviceToolsFor(this.target),targetDescription:targetDescription(this.target),records,evidencePaths:evidence};}
}
