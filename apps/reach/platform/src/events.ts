// Copyright (c) Ray Zhang. Fixed Harness evidence reader; display is not Task authority.
import { openSync, readSync, closeSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
export class AnswerEvents {
  private offset=0;
  private pending=Buffer.alloc(0);
  private sequence=0;
  private bytes=0;
  private admitted=false;
  readonly directory:string;readonly taskId:string;readonly runId:string;readonly emit:(text:string,sequence:number)=>void;
  // 工具步骤只用于显示过程，不作任务裁决依据；字段异常时跳过该条，不影响回答文本。
  readonly step?:(kind:StepKind,data:StepEvent,sequence:number)=>void;
  constructor(directory:string,taskId:string,runId:string,emit:(text:string,sequence:number)=>void,step?:(kind:StepKind,data:StepEvent,sequence:number)=>void) {this.directory=directory;this.taskId=taskId;this.runId=runId;this.emit=emit;this.step=step;}
  poll() {
    if(!this.admitted){const p=join(this.directory,'run-1-admission.json');if(!existsSync(p))return;if(statSync(p).size>65536)throw Error('Desk event admission too large');const raw=readFileSync(p,'utf8');if(!raw.endsWith('\n'))return;const a=JSON.parse(raw);if(a.task_id!==this.taskId||a.run_id!==this.runId||a.run_number!==1)throw Error('Desk event admission mismatch');this.admitted=true;}
    const path=join(this.directory,'run-1-events.jsonl');if(!existsSync(path))return;
    const fd=openSync(path,'r');
    try {
      const buffer=Buffer.alloc(65536);
      // Bound each tick; slow UI reads never delay the shared Agent.
      for(let chunk=0;chunk<16;chunk++){
        const n=readSync(fd,buffer,0,buffer.length,this.offset);if(!n)break;this.offset+=n;
        this.pending=Buffer.concat([this.pending,buffer.subarray(0,n)]);
        for(let end=this.pending.indexOf(10);end>=0;end=this.pending.indexOf(10)){
          if(end>1048576)throw Error('Desk event frame too large');
          const line=this.pending.subarray(0,end);this.pending=this.pending.subarray(end+1);
          const envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));
          if(envelope.task_id!==this.taskId||envelope.run_id!==this.runId||envelope.seq!==this.sequence+1)throw Error('Desk event identity or sequence mismatch');
          this.sequence=envelope.seq;
          if(envelope.event?.type==='text_delta'||(envelope.event?.type==='agent_end'&&this.bytes===0&&typeof envelope.event.output==='string'&&envelope.event.output.length>0)){
            const text=envelope.event.output;if(typeof text!=='string')throw Error('Invalid text delta');
            this.bytes+=Buffer.byteLength(text);if(this.bytes>1048576)throw Error('Desk display limit');
            this.emit(text,this.sequence);
          }
          const step=this.step?stepEvent(envelope.event):null;
          if(step)this.step!(step.kind,step.data,this.sequence);
        }
        if(this.pending.length>1048576)throw Error('Desk incomplete event frame too large');
      }
    } finally {closeSync(fd);}
  }
}

// ---------- 工具步骤（显示用）----------
// Morrow 运行事件里的 tool_start / tool_end 摘要成步骤；思考文本 Morrow 不落盘，这里也没有。
export type StepKind='tool_start'|'tool_end';
export interface StepEvent {stepId:string;title:string;status:string;detail?:string;output?:string;effectsUnknown?:boolean}
export interface Step {stepId:string;title:string;status:string;detail:string;output:string;effectsUnknown:boolean;ended:boolean}
export const STEP_TEXT_LIMIT=2000,STEP_LIMIT=200;
const clip=(value:unknown)=>typeof value==='string'?(value.length>STEP_TEXT_LIMIT?value.slice(0,STEP_TEXT_LIMIT)+'…':value):'';
export function stepEvent(event:any):{kind:StepKind;data:StepEvent}|null{
  if(!event||(event.type!=='tool_start'&&event.type!=='tool_end'))return null;
  if(typeof event.step_id!=='string'||!event.step_id||event.step_id.length>200||typeof event.title!=='string'||typeof event.status!=='string')return null;
  const base={stepId:event.step_id,title:clip(event.title),status:clip(event.status)};
  return event.type==='tool_start'
    ?{kind:'tool_start',data:{...base,detail:clip(event.detail)}}
    :{kind:'tool_end',data:{...base,output:clip(event.output),effectsUnknown:event.effects_unknown===true}};
}
// 把按序的开始/结束事件合并成步骤列表（同一 stepId 合并，最多 STEP_LIMIT 步）。
export function foldSteps(events:{kind:string;data:StepEvent}[]):Step[]{
  const steps:Step[]=[],index=new Map<string,Step>();
  for(const {kind,data} of events){
    if(kind!=='tool_start'&&kind!=='tool_end')continue;
    let step=index.get(data.stepId);
    if(!step){if(steps.length>=STEP_LIMIT)continue;step={stepId:data.stepId,title:data.title,status:data.status,detail:'',output:'',effectsUnknown:false,ended:false};index.set(data.stepId,step);steps.push(step);}
    step.title=data.title||step.title;step.status=data.status||step.status;
    if(kind==='tool_start')step.detail=data.detail??step.detail;
    else {step.output=data.output??'';step.effectsUnknown=data.effectsUnknown===true;step.ended=true;}
  }
  return steps;
}
