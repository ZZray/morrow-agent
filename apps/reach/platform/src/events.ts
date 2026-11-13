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
  constructor(directory:string,taskId:string,runId:string,emit:(text:string,sequence:number)=>void) {this.directory=directory;this.taskId=taskId;this.runId=runId;this.emit=emit;}
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
        }
        if(this.pending.length>1048576)throw Error('Desk incomplete event frame too large');
      }
    } finally {closeSync(fd);}
  }
}
