// Copyright (c) Ray Zhang. Organization model credentials stay in this service.
import {createHmac,createHash} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {z} from 'zod';
import {validDesktopArguments} from '../contracts/protocol.ts';
import {ReachError,requireCondition} from './errors.ts';
import {modelRequestBindingSchema} from './agent-model-store.ts';
import type {AgentModelDescriptor,ModelOwnerBinding} from './agent-model-store.ts';
import type {ReachStore,NodeRow} from './store.ts';

export const MODEL_REQUEST_BYTES=32*1024*1024,MODEL_RESPONSE_BYTES=8*1024*1024,MODEL_FRAME_BYTES=2*1024*1024;
const configSchema=z.strictObject({endpoint:z.string().max(2048),token:z.string().min(16).max(4096).regex(/^[\x21-\x7e]+$/),model:z.string().min(1).max(256),contextWindow:z.number().int().min(1024).max(10000000),maxOutput:z.number().int().min(1).max(8192),imageInput:z.boolean(),development:z.boolean().default(false)});
export type AgentModelConfig=z.input<typeof configSchema>;
const requestSchema=z.object({model:z.string(),stream:z.literal(true),messages:z.array(z.unknown()).min(1).max(16384),
  max_tokens:z.number().int().min(1).optional(),max_completion_tokens:z.number().int().min(1).optional(),n:z.literal(1).optional(),
  stream_options:z.strictObject({include_usage:z.boolean()}).optional(),tools:z.array(z.unknown()).optional(),tool_choice:z.unknown().optional(),parallel_tool_calls:z.boolean().optional(),
  temperature:z.number().optional(),top_p:z.number().optional(),presence_penalty:z.number().optional(),frequency_penalty:z.number().optional(),reasoning_effort:z.string().optional(),store:z.literal(false).optional()}).strict();
function failure(code:string,status=502){return new ReachError(status,code,'模型通道未完整结束，原请求保留且不会自动重发');}
function aborted(signal:AbortSignal){if(signal.aborted)throw signal.reason;}
async function guarded<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
  aborted(signal);return new Promise((resolve,reject)=>{const stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop));});
}
async function write(response:ServerResponse,data:string,signal:AbortSignal){
  aborted(signal);if(response.destroyed)throw failure('agent_model_client_closed',499);
  if(response.write(data))return;
  await new Promise<void>((resolve,reject)=>{
    const clean=()=>{response.off('drain',ready);response.off('close',closed);response.off('error',errored);signal.removeEventListener('abort',stop);};
    const ready=()=>{clean();resolve();},closed=()=>{clean();reject(failure('agent_model_client_closed',499));},errored=()=>closed(),stop=()=>{clean();reject(signal.reason);};
    response.once('drain',ready);response.once('close',closed);response.once('error',errored);signal.addEventListener('abort',stop,{once:true});
    if(signal.aborted)stop();else if(response.destroyed)closed();
  });
}

// Hold only frames whose semantic delta ends in a possible credential prefix.
// Normal first deltas pass immediately; an ambiguous prefix waits for lookahead.
class CredentialGuard {
  #token:string; #tails=new Map<string,string>(); #pending:string[]=[]; #bytes=0; #toolArguments=new Map<string,string>();
  constructor(token:string){this.#token=token;}
  #plain(value:unknown){const visit=(v:unknown):void=>{if(typeof v==='string'){if(v.includes(this.#token))throw failure('agent_model_secret_echo');}else if(v&&typeof v==='object'){for(const [key,item]of Object.entries(v)){visit(key);visit(item);}}};visit(value);}
  inspect(value:unknown){
    this.#plain(value);
    const delta=(path:string,value:unknown)=>{if(typeof value!=='string')return;const text=(this.#tails.get(path)??'')+value;if(text.includes(this.#token))throw failure('agent_model_secret_echo');let length=Math.min(this.#token.length-1,text.length);while(length&&!text.endsWith(this.#token.slice(0,length)))length--;if(length)this.#tails.set(path,text.slice(-length));else this.#tails.delete(path);};
    const argument=(path:string,value:unknown)=>{if(typeof value!=='string')return;const text=(this.#toolArguments.get(path)??'')+value;requireCondition(Buffer.byteLength(text)<=MODEL_FRAME_BYTES,502,'agent_model_frame_too_large','工具参数超过 2 MiB');this.#toolArguments.set(path,text);delta(path,value);};
    for(const choice of (value as any)?.choices??[]){const d=choice.delta??{},p=String(choice.index);delta(p+'.content',d.content);delta(p+'.refusal',d.refusal);
      // Fixed rpi 8ec4626 selects the first PRESENT alias, then concatenates one thinking stream.
      const thinking=Object.hasOwn(d,'reasoning_content')?d.reasoning_content:Object.hasOwn(d,'reasoning')?d.reasoning:d.reasoning_text;delta(p+'.thinking',thinking);
      delta(p+'.function_call.name',d.function_call?.name);argument(p+'.function_call.arguments',d.function_call?.arguments);for(const call of d.tool_calls??[]){const index=Number.isSafeInteger(call.index)&&call.index>=0?call.index:0;delta(p+'.tool.'+index+'.id',call.id);delta(p+'.tool.'+index+'.name',call.function?.name);argument(p+'.tool.'+index+'.arguments',call.function?.arguments);}}
  }
  frame(frame:string,terminal=false){this.#pending.push(frame);this.#bytes+=Buffer.byteLength(frame);requireCondition(this.#bytes<=MODEL_FRAME_BYTES,502,'agent_model_secret_lookahead','模型帧待核缓冲超限');
    if(terminal){for(const text of this.#toolArguments.values()){requireCondition(validDesktopArguments(text),502,'agent_model_invalid_tool_arguments','模型工具参数未完整结束');this.#plain(JSON.parse(text));}this.#toolArguments.clear();this.#tails.clear();}
    // Tool arguments have a second JSON decode in rpi; retain their frames until checked as a whole.
    if(this.#tails.size||this.#toolArguments.size)return '';const result=this.#pending.join('');this.#pending=[];this.#bytes=0;return result;}
}

export class AgentModelBroker {
  #url:string; #token:string; #descriptor:AgentModelDescriptor;
  #stopping=false; #closed=false; #closing?:Promise<void>; #store?:ReachStore;
  #active=new Map<string,{controller:AbortController;done:Promise<void>;instanceId:string}>();
  #stops=new Set<Promise<unknown>>();
  constructor(raw:AgentModelConfig){
    const c=configSchema.parse(raw),url=new URL(c.endpoint);
    requireCondition(!url.username&&!url.password&&!url.search&&!url.hash&&/^\/v1\/?$/.test(url.pathname),500,'agent_model_config','模型地址须为不含凭据的 /v1 根路径');
    requireCondition(url.protocol==='https:'||(c.development&&url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)),500,'agent_model_config','模型服务须使用 HTTPS；开发仅允许字面环回 HTTP');
    requireCondition(!c.model.includes(c.token)&&c.maxOutput<=c.contextWindow,500,'agent_model_config','模型配置无效');
    this.#url=url.origin+'/v1/chat/completions';this.#token=c.token;
    const visible={model:c.model,protocol:'openai-completions' as const,capabilitySource:'organization-config' as const,contextWindow:c.contextWindow,maxOutput:c.maxOutput,input:c.imageInput?['text','image'] as ('text'|'image')[]:['text'] as ('text'|'image')[]};
    const routeHash=createHmac('sha256',c.token).update(JSON.stringify({policy:1,url:this.#url,...visible})).digest('hex');this.#descriptor={...visible,routeHash};
  }
  descriptor():AgentModelDescriptor{requireCondition(!this.#stopping,503,'agent_model_stopping','模型通道正在关闭');return structuredClone(this.#descriptor);}
  bind(store:ReachStore){requireCondition(!this.#closed&&(!this.#store||this.#store===store),409,'agent_broker_owned','模型运输实例不能更换状态库');store.bindModelBroker(this,()=>this.#closed);this.#store=store;}
  close(){
    if(this.#closing)return this.#closing;this.#stopping=true;
    this.#closing=(async()=>{while(this.#active.size||this.#stops.size){for(const entry of this.#active.values())entry.controller.abort(failure('agent_model_shutdown',503));await Promise.allSettled([...this.#active.values()].map(e=>e.done).concat([...this.#stops].map(p=>p.then(()=>{}))));}this.#closed=true;})();return this.#closing;
  }
  stop(userId:string,parentId:string,raw:unknown){
    requireCondition(!this.#stopping&&this.#store,503,'agent_model_stopping','模型运输实例未就绪或正在关闭');const store=this.#store;
    const task=(async()=>{const prepared=store.models.prepareStop(userId,parentId,raw);if(prepared.receipt)return prepared.receipt;const key=prepared.parent.id+':'+prepared.input.requestId,entry=this.#active.get(key);
      if(entry){requireCondition(entry.instanceId===prepared.owner!.instance_id,409,'agent_model_owner_changed','原模型运输实例不符');entry.controller.abort(failure('agent_model_explicit_stop',499));await Promise.allSettled([entry.done]);}
      return store.models.recordStopped(userId,parentId,raw);
    })();const done=task.finally(()=>this.#stops.delete(done));this.#stops.add(done);return done;
  }
  stream(store:ReachStore,node:NodeRow,parentId:string,requestId:string,request:IncomingMessage,response:ServerResponse){
    this.descriptor();requireCondition(this.#store===store,503,'agent_model_owner_unbound','模型运输尚未绑定服务实例');store.owner.assertCurrent();
    const context=store.agents.parent(node,parentId,String(request.headers['x-reach-dispatch-id']),String(request.headers['x-reach-payload-hash']));
    const key=context.op.id+':'+requestId;requireCondition(!this.#active.has(key),409,'agent_model_request_used','原模型请求仍由运输实例持有，不能重发');
    const controller=new AbortController(),task=this.#stream(store,node,parentId,requestId,request,response,controller),done=task.finally(()=>this.#active.delete(key));this.#active.set(key,{controller,done,instanceId:store.owner.instanceId});return done;
  }
  async #stream(store:ReachStore,node:NodeRow,parentId:string,requestId:string,request:IncomingMessage,response:ServerResponse,controller:AbortController){
    const {signal}=controller,binding=modelRequestBindingSchema.parse({dispatchId:request.headers['x-reach-dispatch-id'],payloadHash:request.headers['x-reach-payload-hash'],runId:request.headers['x-reach-run-id'],routeHash:request.headers['x-reach-model-route']});
    const rootId=store.agents.parent(node,parentId,binding.dispatchId,binding.payloadHash).op.id;
    const check=()=>{aborted(signal);store.owner.assertCurrent();const current=store.agents.parent(node,parentId,binding.dispatchId,binding.payloadHash);requireCondition(current.op.id===rootId&&binding.routeHash===this.#descriptor.routeHash,409,'agent_model_route_changed','组织模型路由已变化');store.models.checkRoute(rootId,binding.routeHash);};check();
    const closed=()=>{if(!response.writableFinished)controller.abort(failure('agent_model_client_closed',499));},inputClosed=()=>controller.abort(failure('agent_model_client_closed',499));response.once('close',closed);request.once('aborted',inputClosed);
    const monitor=setInterval(()=>{try{check();}catch(error){controller.abort(error);}},50);monitor.unref();
    let reserved=false,responseBytes=0,upstreamStatus:number|undefined,finishReason:string|undefined,usage:unknown,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,upstreamBody:ReadableStream<Uint8Array>|null|undefined,owner:ModelOwnerBinding|undefined;
    try{
      requireCondition(request.headers['content-type']?.split(';')[0]==='application/json',415,'json_required','请求必须使用 JSON');
      const chunks:Buffer[]=[];let bytes=0;const input=request.iterator({destroyOnReturn:false});
      try{for(;;){const item=await guarded(input.next(),signal);if(item.done)break;bytes+=item.value.length;requireCondition(bytes<=MODEL_REQUEST_BYTES,413,'agent_model_request_too_large','模型请求超过 32 MiB');chunks.push(Buffer.from(item.value));}}finally{if(!request.complete)request.destroy();await input.return?.();}
      let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch{throw failure('agent_model_invalid_request',400);}
      requireCondition(validDesktopArguments(text),400,'agent_model_invalid_request','模型请求须为有效有限 JSON 对象');const body=requestSchema.parse(JSON.parse(text));
      requireCondition(body.model===this.#descriptor.model,400,'agent_model_mismatch','须使用组织固定模型');
      requireCondition((body.max_tokens===undefined)!==(body.max_completion_tokens===undefined),400,'agent_model_output_limit','须明确一个输出上限字段');
      const parent=store.agents.parent(node,parentId,binding.dispatchId,binding.payloadHash);
      requireCondition((body.max_tokens??body.max_completion_tokens!)<=Math.min(parent.command.maxOutput,this.#descriptor.maxOutput),400,'agent_model_output_limit','模型输出超过原委托上限');
      for(const message of body.messages as any[]){if(Array.isArray(message?.content))for(const block of message.content)if(block?.type==='image_url')requireCondition(this.#descriptor.input.includes('image'),400,'agent_model_image_unsupported','组织配置未声明图像输入能力');}
      check();owner=Object.freeze(store.models.reserve(node,parentId,requestId,binding,createHash('sha256').update(text).digest('hex'),this.#descriptor).owner);reserved=true;
      const upstream=await fetch(this.#url,{method:'POST',redirect:'manual',signal,headers:{authorization:'Bearer '+this.#token,'content-type':'application/json',accept:'text/event-stream'},body:text});upstreamStatus=upstream.status;upstreamBody=upstream.body;
      if(!upstream.ok){await upstream.body?.cancel().catch(()=>{});throw failure('agent_model_upstream_http');}
      requireCondition(upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase()==='text/event-stream'&&upstream.body,502,'agent_model_upstream_protocol','上游未返回 SSE');
      store.models.streaming(rootId,requestId,owner);response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-accel-buffering':'no'});
      reader=upstream.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true}),guard=new CredentialGuard(this.#token);let pending='',frameLines:string[]=[],frameBytes=0,finished=false,doneMarker=false;
      const frame=async()=>{
        if(!frameLines.length)return;const lines=frameLines;frameLines=[];frameBytes=0;
        const data=lines.filter(line=>line==='data'||line.startsWith('data:')).map(line=>line==='data'?'':line.slice(5).replace(/^ /,'')).join('\n');
        if(!data)return;requireCondition(lines.every(line=>line.startsWith('data:')||line==='data'||line.startsWith(':')||line==='event: message'),502,'agent_model_invalid_frame','不支持的模型事件');
        if(data==='[DONE]'){requireCondition(finished,502,'agent_model_incomplete','模型缺少终态');doneMarker=true;return;}
        let value:any;try{value=JSON.parse(data);}catch{throw failure('agent_model_invalid_frame');}
        requireCondition(validDesktopArguments(data),502,'agent_model_invalid_frame','模型事件须为有效 JSON 对象');guard.inspect(value);
        requireCondition(!Object.hasOwn(value,'error')&&Array.isArray(value.choices)&&value.choices.length<=1,502,'agent_model_upstream_error','上游模型返回错误事件');
        if(value.choices.length){const choice=value.choices[0];requireCondition(choice?.index===0&&choice.delta&&typeof choice.delta==='object'&&!Array.isArray(choice.delta)&&!finished,502,'agent_model_invalid_frame','模型 choice 次序无效');
          if(choice.finish_reason!=null){requireCondition(['stop','end','length','tool_calls','function_call','content_filter'].includes(choice.finish_reason),502,'agent_model_invalid_frame','未知模型终态');finishReason=choice.finish_reason;finished=true;}
        }
        const wireUsage=value.usage??value.choices[0]?.usage;
        if(wireUsage!=null){requireCondition(wireUsage&&typeof wireUsage==='object'&&!Array.isArray(wireUsage),502,'agent_model_invalid_usage','模型 usage 无效');const measured:Record<string,number>={};for(const key of ['prompt_tokens','completion_tokens','total_tokens'])if(wireUsage[key]!==undefined){requireCondition(Number.isSafeInteger(wireUsage[key])&&wireUsage[key]>=0,502,'agent_model_invalid_usage','模型 usage 无效');measured[key]=wireUsage[key];}if(Object.keys(measured).length)usage=measured;}
        // Only decoded, inspected JSON is forwarded. SSE comments/metadata can contain diagnostics.
        await write(response,guard.frame('data: '+JSON.stringify(value)+'\n\n'),signal);
      };
      const consume=async(final=false)=>{
        for(;;){const match=/[\r\n]/.exec(pending);if(!match)break;const i=match.index;if(pending[i]==='\r'&&i+1===pending.length&&!final)break;const line=pending.slice(0,i);const width=pending[i]==='\r'&&pending[i+1]==='\n'?2:1;pending=pending.slice(i+width);
          frameBytes+=Buffer.byteLength(line)+width;requireCondition(frameBytes<=MODEL_FRAME_BYTES,502,'agent_model_frame_too_large','模型单帧超过 2 MiB');if(line==='')await frame();else frameLines.push(line);if(doneMarker)return;
        }
        requireCondition(frameBytes+Buffer.byteLength(pending)<=MODEL_FRAME_BYTES,502,'agent_model_frame_too_large','模型单帧超过 2 MiB');
      };
      for(;;){const next=await guarded(reader.read(),signal);if(next.done){pending+=decoder.decode();await consume(true);requireCondition(!pending&&!frameLines.length&&finished,502,'agent_model_incomplete','模型流在终态前断开');await write(response,guard.frame('',true),signal);break;}
        responseBytes+=next.value.length;requireCondition(responseBytes<=MODEL_RESPONSE_BYTES,502,'agent_model_response_too_large','模型响应超过 8 MiB');pending+=decoder.decode(next.value,{stream:true});await consume();if(doneMarker)break;
      }
      // Cancellation already observed at the terminal boundary wins; Task acceptance is separate.
      await write(response,guard.frame('',true),signal);check();requireCondition(Number(store.models.finish(rootId,requestId,'stream_complete',{upstreamStatus,responseBytes,finishReason,usage},owner))===1,409,'agent_model_owner_changed','模型运输终态未由原实例提交');if(doneMarker)await write(response,'data: [DONE]\n\n',signal);response.end();
    }catch(error){
      const reason=signal.aborted?signal.reason:error,code=reason instanceof ReachError?reason.code:'agent_model_stream_error';
      if(reserved){try{store.models.finish(rootId,requestId,'unknown',{code,upstreamStatus,responseBytes,finishReason,usage},owner!);}catch{response.destroy();throw failure('agent_model_ledger_unavailable');}}
      if(signal.aborted){response.destroy();}
      else if(response.headersSent){if(!response.destroyed)response.end('data: {"error":{"code":"'+code+'","message":"模型通道中断；原请求不会重发"}}\n\n');}
      else throw reason instanceof ReachError||reason instanceof z.ZodError?reason:failure(code);
    }finally{clearInterval(monitor);response.off('close',closed);request.off('aborted',inputClosed);controller.abort();if(!request.complete)request.destroy();if(reader)await reader.cancel().catch(()=>{});else if(upstreamBody)await upstreamBody.cancel().catch(()=>{});if(reserved)store.models.joined(rootId,requestId,owner!);}
  }
}

export function agentModelFromEnvironment(env:NodeJS.ProcessEnv):AgentModelBroker|undefined{
  const token=env.REACH_AGENT_MODEL_TOKEN;delete env.REACH_AGENT_MODEL_TOKEN;
  const fields=[env.REACH_AGENT_MODEL_URL,env.REACH_AGENT_MODEL_ID,token,env.REACH_AGENT_MODEL_CONTEXT,env.REACH_AGENT_MODEL_MAX_OUTPUT,env.REACH_AGENT_MODEL_IMAGE_INPUT];
  if(fields.every(value=>!value))return undefined;
  requireCondition(fields.every(value=>!!value)&&['0','1'].includes(env.REACH_AGENT_MODEL_IMAGE_INPUT!),500,'agent_model_config','组织模型配置须完整，图像能力必须明确为 0 或 1');
  return new AgentModelBroker({endpoint:env.REACH_AGENT_MODEL_URL!,token:token!,model:env.REACH_AGENT_MODEL_ID!,contextWindow:Number(env.REACH_AGENT_MODEL_CONTEXT),maxOutput:Number(env.REACH_AGENT_MODEL_MAX_OUTPUT),imageInput:env.REACH_AGENT_MODEL_IMAGE_INPUT==='1',development:env.REACH_DEVELOPMENT==='1'});
}
