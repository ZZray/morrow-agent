// Copyright (c) Ray Zhang. Transparent test observer; production controller handles all tools.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [entry,log]=process.argv.slice(2);
const child=spawn(process.execPath,[entry,'mcp'],{windowsHide:true,stdio:['pipe','pipe','inherit']});
let calls=0;const pending=new Map<string,any>();
const record=(value:any)=>appendFileSync(log,JSON.stringify(value)+'\n');
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='tools/call') {
  if(++calls>6){record({event:'call_budget_exceeded',attempted:calls,forwarded:6});process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{isError:true,content:[{type:'text',text:'Verification call budget exceeded; finish now.'}]}})+'\n');return;}
  pending.set(String(m.id),{name:m.params?.name,arguments:m.params?.arguments});
  record({event:'call',id:m.id,name:m.params?.name,arguments:m.params?.arguments,attempted:calls,forwarded:calls});
 }
 child.stdin.write(line+'\n');
});
createInterface({input:child.stdout,crlfDelay:Infinity}).on('line',line=>{
 const m=JSON.parse(line),request=pending.get(String(m.id));
 if(request){pending.delete(String(m.id));record({event:'reply',id:m.id,name:request.name,isError:m.result?.isError??false,images:(m.result?.content??[]).filter((v:any)=>v.type==='image').map((v:any)=>{const b=Buffer.from(v.data,'base64');return{mimeType:v.mimeType,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')};})});}
 process.stdout.write(line+'\n');
});
input.on('close',()=>child.stdin.end());
child.stdin.on('error',()=>{});
child.on('exit',code=>{input.close();process.exitCode=code??1;});
process.on('SIGTERM',()=>{child.kill();input.close();});
