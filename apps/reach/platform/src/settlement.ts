// Copyright (c) Ray Zhang. Host-owned evidence policy; Core observations are facts, not settlement.
import { constants, copyFileSync, readFileSync, writeFileSync, mkdirSync, openSync, fsyncSync, closeSync, chmodSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, parse } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CloseIntent, Turn } from './store.ts';
import type {DeviceAudit} from './device-tools.ts';
import {deviceToolsFor,targetDescription,invalidDeviceArguments} from './device-tools.ts';

const SDK = new URL('../../../../crates/morrow-agent-jsonl/clients/node/client.mjs', import.meta.url).href;
// Reviewed ordinary image: fixed local_tools=false, worker=None; no external capabilities.
export const SESSION_ONLY_IMAGE = '2f858a77ba86bd8b201f7184b5afb7a10afc674ad8668cf49354c44174dc8353';
export const IMAGE_INPUT_IMAGE = '0275185113786a971fad17307c4cefcd0de4d2c0666bcb857d9cc20b2e26a344';
// Preserve the reviewed typed-image candidate for its original Tasks as well.
const imageInputs=new Set([IMAGE_INPUT_IMAGE,'26d9e99368a1ab239dcd6fe703a4ecf7f1af44c94bf2e5b069354eb98136ddea']);
export const isImageRuntime=(sha:string)=>imageInputs.has(sha);
const supportedImage=(sha:string)=>sha===SESSION_ONLY_IMAGE||isImageRuntime(sha);
export const toolsForRuntime=(target:unknown,sha:string)=>deviceToolsFor(target).filter(tool=>sha!==SESSION_ONLY_IMAGE||tool.name!=='reach_image');
const tools = new Set(['task_update','history_read','history_search','reference_read','reference_search','memory_propose','experience_propose','experience_search']);
function need(ok:unknown, message:string): asserts ok { if (!ok) throw Error(message); }
export const hashBytes = (bytes:Buffer|string) => createHash('sha256').update(bytes).digest('hex');
const same = (a:unknown,b:unknown) => isDeepStrictEqual(a,b);
const normalized = (p:string) => { const v=p.replace(/^\\\\\?\\UNC\\/i,'\\\\').replace(/^\\\\\?\\/,''); return process.platform==='win32'?resolve(v).toLowerCase():resolve(v); };
const pathSame = (a:string,b:string) => typeof a==='string'&&typeof b==='string'&&normalized(a)===normalized(b);
const within = (root:string,p:string) => { const r=relative(normalized(root),normalized(p)); return r!==''&&r!=='..'&&!r.startsWith('..\\')&&!r.startsWith('../')&&!isAbsolute(r); };
export function saveProof(path:string,value:unknown) { const bytes=JSON.stringify(value)+'\n',fd=openSync(path,'wx'); try { writeFileSync(fd,bytes);fsyncSync(fd); } finally { closeSync(fd); } return {path,sha256:hashBytes(bytes)}; }
function bounded(path:string,limit=64*1024*1024) { need(statSync(path).size<=limit,'evidence byte bound'); const b=readFileSync(path);need(b.length<=limit,'evidence grew');return b; }
function json(path:string,limit?:number) { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bounded(path,limit))); }
function ref(path:string) { return {path,sha256:hashBytes(bounded(path))}; }
export interface RuntimeImage { path:string; sha256:string }
export function pinRuntime(binary:string,state:string):RuntimeImage {
  const bytes=readFileSync(binary),sha256=hashBytes(bytes),directory=join(state,'runtime',sha256);mkdirSync(directory,{recursive:true});
  const path=join(directory,process.platform==='win32'?'morrow-agent-jsonl.exe':'morrow-agent-jsonl');
  try { copyFileSync(binary,path,constants.COPYFILE_EXCL);if(process.platform!=='win32')chmodSync(path,0o700); } catch(e) { if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e; }
  need(hashBytes(readFileSync(path))===sha256,'runtime copy mismatch');return {path,sha256};
}
function request(start:any,from=0,prefix:string|null=null,runs:string[]=[],image?:RuntimeImage) { const modern=!!image&&isImageRuntime(image.sha256);return {session_path:start.run.session_path,cwd:start.run.cwd,from_raw:from,expected_prefix_proof:prefix,expected_runs:runs,require_context:runs.length>0,limits:{max_messages:100000,max_input_bytes:(modern?1024:64)*1024*1024,max_output_bytes:(modern?64:16)*1024*1024}}; }
export async function baseline(image:RuntimeImage,start:any,root:string) {
  if(!supportedImage(image.sha256))return null;
  const p=parse(start.run.session_path),head=join(p.dir,p.name+'.journal','head.json'),from=existsSync(head)?json(head).head.raw_count:0;
  const {inspectSession}=await import(SDK),value=await inspectSession({binary:image.path,request:request(start,from,null,[],image),operationDirectory:join(root,'baseline')});
  need(value.delivery==='validated'&&!value.result.snapshot.fence&&!value.result.snapshot.closing_marker,'baseline unavailable or fenced');
  need(value.result.snapshot.inspection.transcript_closed&&!value.result.snapshot.inspection.pending_run,'baseline interrupted');
  return value;
}
function joined(result:any,turn:Turn) {
  need(result.delivery==='validated'&&result.callbacks_finished===true&&result.process?.closed===true&&result.process.exit_code===0&&result.process.signal===null&&result.process.forced===false&&!result.fault,'original process not joined');
  need(result.outcome?.task_id===turn.task_id&&['Cancelled','Informational'].includes(result.outcome.stop)&&result.outcome.task_accepted===false&&result.terminal?.local_callbacks_finished===true&&result.unknownEffects?.length===0,'original Task not a locally joined stop');
}
function profile(start:any,image:RuntimeImage,turn:Turn,audit?:DeviceAudit) {
  need(supportedImage(image.sha256)&&hashBytes(readFileSync(image.path))===image.sha256,'unsupported or changed runtime');
  const target=turn.target_json?JSON.parse(turn.target_json):null;
  const selected=target?toolsForRuntime(target,image.sha256):[];
  need(start.kind==='start_task'&&start.task.kind==='Reasoning'&&start.task.max_runs===1&&start.run.mode==='execute'&&same(start.run.tools,selected)&&(!target||(audit&&same(audit.tools.filter(tool=>image.sha256!==SESSION_ONLY_IMAGE||tool.name!=='reach_image'),selected)&&audit.targetDescription===targetDescription(target))),'unsupported run profile');
  const allowed=['run_id','objective','cwd','session_path','environment_state','device_fp','session_key','mode','endpoint','model','max_calls','max_seconds','max_output','host_output_ceiling','model_resolution','tools'];
  need(Object.keys(start.run).every(k=>allowed.includes(k))&&Object.keys(start).every(k=>['kind','version','task','run','cancel_grace_ms','emit_events'].includes(k)),'extra capabilities in original start');
}
function originalEvents(root:string,start:any,result:any,audit?:DeviceAudit) {
  const evidence=start.task.evidence_dir,files=readdirSync(evidence),runs=result.outcome.runs;
  need(Number.isInteger(runs)&&runs>=0&&runs<=1,'unsupported Run consumption');
  const admissions=files.filter(n=>/^run-\d+-admission\.json$/.test(n));need(admissions.length===runs,'admission set mismatch');
  const started=json(join(root,'client','client-started.json'));need(started.task_id===start.task.task_id&&started.start_sha256===hashBytes(JSON.stringify(start)),'SDK start mismatch');
  const finished=json(join(root,'client','client-finished.json'));need(finished.delivery==='validated'&&same(finished.process,result.process)&&finished.callbacks_finished===true&&finished.outcome_sha256===hashBytes(JSON.stringify(result.outcome)),'SDK join mismatch');
  const rpcFiles=readdirSync(join(root,'client')).filter(n=>n.startsWith('rpc-'));
  need(rpcFiles.length===2*(audit?.records.length??0),'unexpected or incomplete Host callback');
  for(const record of audit?.records??[]){
    const frame=record.frame,key='rpc-'+hashBytes(frame.rpc_id),startFile=join(root,'client',key+'-started.json'),endFile=join(root,'client',key+'-settled.json'),started=json(startFile),finished=json(endFile);
    const reply={kind:'tool_reply',version:1,rpc_id:frame.rpc_id,task_id:frame.task_id,run_id:frame.run_id,native_call_id:frame.native_call_id,tool_name:frame.tool_name,args_sha256:frame.args_sha256,result:record.reply};
    for(const item of [started,finished])need(item.kind==='tool_call'&&item.task_id===start.task.task_id&&item.run_id===start.run.run_id&&item.rpc_id===frame.rpc_id&&item.request_sha256===hashBytes(JSON.stringify(frame)),'original device RPC identity mismatch');
    need(finished.reply_sha256===hashBytes(JSON.stringify(reply)),'original device reply mismatch');
  }
  if(runs===0){need(result.outcome.observed_calls===0,'zero Run charged calls');return {events:[] as any[],refs:[ref(join(root,'client','client-started.json')),ref(join(root,'client','client-finished.json'))]};}
  const a=json(join(evidence,'run-1-admission.json')),o=json(join(evidence,'run-1-observation.json'));
  need(a.task_id===start.task.task_id&&a.run_id===start.run.run_id&&a.run_number===1&&a.criteria_revision===start.task.criteria_revision&&a.authorization_revision===start.task.authorization_revision&&pathSame(a.session_path,start.run.session_path)&&a.remaining_calls===start.task.max_calls&&a.deadline_unix_ms===start.task.deadline_unix_ms,'original admission mismatch');
  need(o.task_id===a.task_id&&o.run_id===a.run_id&&o.core_joined===true&&o.event_failure===false&&o.observed_calls===result.outcome.observed_calls&&o.total_calls===result.outcome.observed_calls,'Run join/consumption mismatch');
  const bytes=bounded(join(evidence,'run-1-events.jsonl'),64*1024*1024);need(hashBytes(bytes)===o.events_sha256&&(!bytes.length||bytes.at(-1)===10),'event EOF/hash mismatch');
  const lines=new TextDecoder('utf-8',{fatal:true}).decode(bytes).split('\n');lines.pop();
  const events=lines.map((line,n)=>{need(Buffer.byteLength(line)<=1048576,'event frame bound');const e=JSON.parse(line);need(e.task_id===a.task_id&&e.run_id===a.run_id&&e.seq===n+1,'event identity/sequence mismatch');return e.event;});
  need(events.length===o.event_count,'event count mismatch');
  const calls=events.filter(e=>e.type==='model_call');need(calls.length===o.observed_calls&&calls.every((e,n)=>e.call===n+1),'model consumption mismatch');
  return {events,refs:['task.json','task-options.json','run-1-admission.json','run-1-observation.json','run-1-events.jsonl'].map(n=>ref(join(evidence,n))).concat([ref(join(root,'client','client-started.json')),ref(join(root,'client','client-finished.json')),...rpcFiles.map(n=>ref(join(root,'client',n))),...(audit?.evidencePaths??[]).map(p=>ref(p))])};
}
const textResult = (call:any) => call.result?.content?.map((b:any)=>b.text??'').join('\n');
const sourceMatches=(m:any,args:any,context:any) => same(m.source_ids,args.source_ids)&&same(m.sources,args.source_ids.map((id:string)=>({id,hash:context.references.find((r:any)=>r.id===id)?.hash})));

/** Full context delta review, including pre-model commands, proposals and compaction. */
export function reviewEffects(before:any,after:any,start:any,events:any[],token:string,audit?:DeviceAudit) {
  const b=before.context.kind==='present'?before.context.snapshot:null,a=after.context.kind==='present'?after.context.snapshot:null,run=start.run.run_id;
  need(after.transcript_closed&&!after.pending_run&&after.unknown_effect_result_indices.every((n:number)=>after.calls.some((c:any)=>c.result_raw_index===n&&['memory_propose','experience_propose'].includes(c.call.name))),'unfinished native effects');
  const metadata=after.head?.metadata;need(!metadata?.goal&&!metadata?.goal_history?.length&&!metadata?.goal_commands?.length,'Goal state not supported by this profile');
  const oldRuns=before.inputs.filter((i:any)=>/[\\/]runs[\\/]/.test(i.path));
  for(const old of oldRuns)need(after.inputs.some((i:any)=>pathSame(i.path,old.path)&&same(i.state,old.state)),'old Run index changed');
  const addedIndices=after.inputs.filter((i:any)=>/[\\/]runs[\\/]/.test(i.path)&&i.state.kind==='file'&&!oldRuns.some((old:any)=>pathSame(old.path,i.path)));
  need(addedIndices.every((i:any)=>after.runs.some((r:any)=>r.id===run&&r.index&&pathSame(r.index.path,i.path))),'unadmitted Run appeared');
  if(!a){need(!b&&after.calls.length===0,'context disappeared');return {calls:[],context:'absent'};}
  need(a.cloud_stamp===null&&a.cloud_migrated===true&&(!b||(b.cloud_stamp===null&&b.cloud_migrated===true))&&a.version===1&&(!b||a.scope===b.scope),'unexpected or legacy context origin');
  const objective=start.run.objective.replaceAll(token,'[redacted grant]'),command=objective.trim().match(/^\/(reference|memory)\s+(list|correct|revoke|accept)(?:\s+([\s\S]*))?$/u);
  const refs=b?.references??[],memories=b?.memories??[],newRefs=a.references.filter((r:any)=>!refs.some((old:any)=>old.id===r.id));
  const parts=command?.[3]?.trim()??'',cmdId=parts.split(/\s/u)[0],correction=parts.match(/^\S+\s([\s\S]*)$/u)?.[1];
  need(newRefs.length===(command?(command[1]==='reference'&&command[2]==='correct'?1:0):after.runs.length?1:0),'reference effect count mismatch');
  for(const old of refs){const current=a.references.find((r:any)=>r.id===old.id);need(current,'old reference missing');const expected={...old};if(command?.[1]==='reference'&&cmdId===old.id&&['correct','revoke'].includes(command[2]))expected.status=command[2]==='correct'?'superseded':'revoked';need(same(current,expected),'unexplained reference mutation');}
  for(const r of newRefs){
    need(r.run===run&&r.status==='active','unowned reference');
    if(command?.[1]==='reference'&&command[2]==='correct'){const old=refs.find((x:any)=>x.id===cmdId);need(old&&r.text===correction&&r.kind===old.kind&&r.version===old.version+1&&r.supersedes===old.id,'correction mismatch');}
    else if(r.kind==='objective')need(!command&&r.text===objective,'objective source mismatch');
    else need(false,'unexplained new reference');
  }
  for(const old of memories){const current=a.memories.find((m:any)=>m.id===old.id);need(current,'old memory missing');const expected={...old};if(command?.[1]==='memory'&&cmdId===old.id&&['accept','revoke'].includes(command[2])){expected.status=command[2]==='accept'?'accepted':'revoked';if(command[2]==='accept'){need(current.adoption?.run===run&&current.adoption.command===objective.trim()&&Number.isSafeInteger(current.adoption.timestamp_ms),'adoption receipt mismatch');expected.adoption=current.adoption;}}need(same(current,expected),'unexplained memory mutation');}
  if(command&&command[2]!=='list')need(after.to_raw===before.to_raw&&a.watermark===(command[2]==='accept'?b?.watermark:before.to_raw),'command history boundary mismatch');
  else need(a.watermark===(b?.watermark??0),'unexplained watermark change');
  if(a.summary&&!same(a.summary,b?.summary)){
    const compact=events.filter(e=>e.type==='compact');
    need(a.summary.run===run&&compact.at(-1)?.covered_prefix===a.summary.prefix_end&&events.some(e=>e.type==='model_result'&&e.phase==='summary'&&e.status==='received'),'summary source not observed');
    for(const c of compact){const position=events.indexOf(c),received=events.slice(0,position).findLastIndex(e=>e.type==='model_result'&&e.phase==='summary'&&e.status==='received');need(received>=0&&events.slice(0,received).some(e=>e.type==='model_call'&&e.phase==='summary'),'summary reservation/commit order mismatch');}
  }
  if(b?.summary&&!a.summary)need(!!command&&command[2]!=='accept'&&command[2]!=='list','summary removed without command');
  const additions=a.memories.filter((m:any)=>!memories.some((old:any)=>old.id===m.id)),assigned=new Set<string>(),summarized=!!a.summary&&a.summary.run===run&&!same(a.summary,b?.summary),reviews=[];
  need(!command||additions.length===0,'management command introduced a candidate');
  for(const m of additions)need(m.run===run&&m.status==='candidate'&&m.adoption===null&&m.cloud_stamp===null&&m.sources.length>0&&new Set(m.source_ids).size===m.source_ids.length&&same(m.source_ids,m.sources.map((s:any)=>s.id))&&m.sources.every((s:any)=>a.references.some((r:any)=>r.id===s.id&&r.hash===s.hash&&r.status==='active')),'unadopted candidate policy violated');
  const starts=events.filter(e=>e.type==='tool_start'),ends=events.filter(e=>e.type==='tool_end');
  need(starts.length===after.calls.length&&ends.length===after.calls.length,'native/event tool set mismatch');
  for(const c of after.calls){
    const external=audit?.records.find(record=>record.frame.native_call_id===c.call.id&&record.frame.tool_name===c.call.name);
    const rejected=!!audit&&!external&&c.result?.isError&&!c.effects_unknown&&invalidDeviceArguments(c.call.name,c.call.arguments);
    need((tools.has(c.call.name)||external||rejected)&&c.result&&c.result_raw_index!==null,'unsupported or unfinished tool');
    const s=starts.filter(e=>e.step_id===c.call.id),e=ends.filter(e=>e.step_id===c.call.id);
    need(s.length===1&&e.length===1&&s[0].title===c.call.name&&e[0].title===c.call.name&&e[0].status===(c.result.isError?'failed':'completed'),'tool event mismatch');
    if(rejected){reviews.push({id:c.call.id,name:c.call.name,effect:'core-schema-rejection-no-host-callback'});continue;}
    if(external){let native=textResult(c);if(c.result.isError){need(native.startsWith('tool error: '),'device error wrapper mismatch');native=native.slice('tool error: '.length);}need(!c.effects_unknown&&external.reply.settlement==='Settled'&&same(external.frame.arguments,c.call.arguments)&&external.reply.is_error===c.result.isError&&same(JSON.parse(native),external.reply.value),'device call native result mismatch');
      const pictures=c.result.content.filter((b:any)=>b.type==='image'),images=external.reply.images??[];need(pictures.length===images.length,'device image count mismatch');
      for(let i=0;i<images.length;i++){const bytes=Buffer.from(pictures[i].data??'','base64');need(pictures[i].mimeType===images[i].mime_type&&bytes.toString('base64')===pictures[i].data&&bytes.length===images[i].bytes&&hashBytes(bytes)===images[i].sha256,'device native image mismatch');}
      reviews.push({id:c.call.id,name:c.call.name,effect:'original-device-receipt',receipt:external.evidenceRef,images:images.map(image=>({sha256:image.sha256,bytes:image.bytes,width:image.width,height:image.height}))});continue;}
    if(!['memory_propose','experience_propose'].includes(c.call.name)){need(!c.effects_unknown,'unknown read/checklist effect');reviews.push({id:c.call.id,name:c.call.name,effect:'native-receipt'});continue;}
    const args=c.call.arguments;
    if(c.result.isError&&(!args||typeof args!=='object'||!Array.isArray(args.source_ids))){need(additions.length===0,'malformed proposal has unexplained additions');reviews.push({id:c.call.id,name:c.call.name,effect:'absent',candidateId:null});continue;}
    need(args&&typeof args==='object'&&!Array.isArray(args)&&Array.isArray(args.source_ids),'proposal arguments unavailable');
    const matches=additions.filter((m:any)=>!assigned.has(m.id)&&m.kind===(c.call.name==='experience_propose'?'lesson':args.kind)&&m.text===(c.call.name==='experience_propose'?args.lesson:args.text)?.replaceAll(token,'[redacted grant]')&&sourceMatches(m,args,a)&&
      (c.call.name!=='experience_propose'||m.experience?.conditions===args.conditions.replaceAll(token,'[redacted grant]')));
    let candidate:any;
    if(!c.result.isError){const output=JSON.parse(textResult(c));candidate=matches.find((m:any)=>m.id===output.id);need(candidate&&output.status==='candidate'&&output.adopted===false,'proposal receipt does not match persisted candidate');}
    else {need(matches.length<=1&&!summarized&&!after.calls.some((other:any)=>other!==c&&['memory_propose','experience_propose'].includes(other.call.name)&&same(other.call.arguments,args)),'ambiguous failed proposal');candidate=matches[0];}
    if(candidate)assigned.add(candidate.id);
    reviews.push({id:c.call.id,name:c.call.name,effect:candidate?'persisted-candidate':'absent',candidateId:candidate?.id??null});
  }
  const unassigned=additions.filter((m:any)=>!assigned.has(m.id));need(unassigned.length===0||(summarized&&unassigned.length<=8*events.filter(e=>e.type==='model_result'&&e.phase==='summary').length&&unassigned.every((m:any)=>!m.experience)),'unexplained candidate additions');
  need(!audit||audit.records.every(record=>after.calls.filter((c:any)=>c.call.id===record.frame.native_call_id&&c.call.name===record.frame.tool_name).length===1),'device intent not bound to one native call');
  return {calls:reviews,context:{references:newRefs.map((r:any)=>r.id),candidates:additions.map((m:any)=>m.id),summaryChanged:!same(a.summary,b?.summary??null),command:command?objective.trim():null}};
}

export async function prepareSettlement(image:RuntimeImage,start:any,base:any,result:any,turn:Turn,root:string,token:string,audit?:DeviceAudit):Promise<CloseIntent> {
  profile(start,image,turn,audit);joined(result,turn);need(base?.delivery==='validated','original baseline absent');
  const original=json(join(root,'request.json'));need(same(original,start)&&start.task.task_id===turn.task_id&&start.run.run_id===turn.run_id,'original request identity mismatch');
  const {events,refs}=originalEvents(root,start,result,audit),before=base.result.snapshot.inspection;
  if(result.outcome.stop==='Informational')need(/^\/(reference|memory)\s/u.test(start.run.objective.trim())&&result.outcome.observed_calls===0,'unsupported informational outcome');
  const {inspectSession}=await import(SDK),observed=await inspectSession({binary:image.path,request:request(start,before.to_raw,before.full_proof,result.outcome.runs?[turn.run_id]:[],image),operationDirectory:join(root,'inspection')});
  need(observed.delivery==='validated','final inspection unavailable');const snapshot=observed.result.snapshot,after=snapshot.inspection,fence=snapshot.fence?.record;
  need(!snapshot.closing_marker&&fence&&pathSame(snapshot.fence.path,result.outcome.reconciliation_fence)&&fence.task_id===turn.task_id&&pathSame(fence.session_path,start.run.session_path)&&pathSame(fence.evidence_dir,start.task.evidence_dir),'original fence mismatch');
  need(pathSame(before.canonical_session_path,after.canonical_session_path)&&pathSame(before.canonical_cwd,after.canonical_cwd),'baseline path mismatch');
  if(result.outcome.runs===0)need(same(before.inputs,after.inputs)&&same(before.context,after.context),'zero-Run native state changed');
  const effects=reviewEffects(before,after,start,events,token,audit);
  const closurePath=join(root,'closure'),closure=process.platform==='win32'&&fence.session_path.startsWith('\\\\?\\')?'\\\\?\\'+closurePath:closurePath;mkdirSync(closure);
  const originals=[ref(join(root,'request.json')),ref(join(root,'result.json')),...refs];
  const proof=saveProof(join(root,'effects-review.json'),{kind:'reach-desk-session-effects-v1',taskId:turn.task_id,runId:turn.run_id,image,process:result.process,callbacks_finished:result.callbacks_finished,baseline:base.result_ref,inspection:observed.result_ref,originals,effects,task_accepted:false});
  const spec=json(join(start.task.evidence_dir,'task.json'));need(same(spec,start.task),'original Task specification mismatch');
  const evidenceRefs=[proof,observed.result_ref,base.result_ref,...originals];
  const declaration={kind:'settled_task_close',version:1,request:{task:{...spec,evidence_dir:fence.evidence_dir},session_path:fence.session_path,cwd:after.canonical_cwd,expected_fence_sha256:snapshot.fence.sha256,expected_authority_sha256:fence.authority.declaration_sha256,evidence_dir:closure},expected:{fence,fenced_outcome:result.outcome,interrupted_run:after.pending_run,consumed_runs:result.outcome.runs,consumed_calls:result.outcome.observed_calls},receipt:{committed:true,settlement:'Settled',tool_calls:[],evidence:evidenceRefs.map(r=>r.path)},evidence_refs:evidenceRefs,session_inspection_ref:observed.result_ref};
  const declarationRef=saveProof(join(closure,'host-declaration.json'),declaration);return {declarationPath:declarationRef.path,declarationSha256:declarationRef.sha256,binaryPath:image.path,binarySha256:image.sha256,...(result.outcome.stop==='Informational'?{terminalStatus:'completed' as const}:{})};
}
export async function executeSettlement(intent:CloseIntent,root:string,attempt:number) {
  need(within(root,intent.declarationPath)&&within(join(resolve(root,'../..'),'runtime'),intent.binaryPath),'settlement path outside original roots');
  need(hashBytes(readFileSync(intent.binaryPath))===intent.binarySha256&&supportedImage(intent.binarySha256)&&hashBytes(bounded(intent.declarationPath))===intent.declarationSha256,'immutable close inputs changed');
  const {closeTask}=await import(SDK);return closeTask({binary:intent.binaryPath,declarationRef:{path:intent.declarationPath,sha256:intent.declarationSha256},operationDirectory:join(root,'close-'+attempt),timeoutMs:15000});
}
export async function recoverCloseOperation(intent:CloseIntent,root:string,attempt:number) {
  need(within(root,intent.declarationPath)&&hashBytes(bounded(intent.declarationPath))===intent.declarationSha256,'original declaration changed');
  const {readCloseOperation}=await import(new URL('../../../../crates/morrow-agent-jsonl/clients/node/close.mjs',import.meta.url).href);
  return readCloseOperation({declarationRef:{path:intent.declarationPath,sha256:intent.declarationSha256},operationDirectory:join(root,'close-'+attempt)});
}
