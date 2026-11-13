// Copyright (c) Ray Zhang. Loopback HTTP/model fixture; parent Node receipts are synthetic.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {ServerResponse,IncomingMessage} from 'node:http';
import {once} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ReachStore,sha256} from '../src/service/store.ts';
import {AgentModelBroker} from '../src/service/agent-model.ts';
import {reachServer} from '../src/service/server.ts';
import {delegateSchema} from '../src/contracts/protocol.ts';
export const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export async function until(read:()=>boolean,timeout=5000){const end=Date.now()+timeout;while(!read()){assert.ok(Date.now()<end,'Local condition timed out');await delay(15);}}
export const chunk=(content:string,finish:string|null=null)=>'data: '+JSON.stringify({id:'local-model',model:'local-model',choices:[{index:0,delta:{content},finish_reason:finish}]})+'\n\n';
export const final=chunk('','stop')+'data: [DONE]\n\n';
export async function modelFixture(limits:{maxRuns?:number;maxCalls?:number;runCallLimit?:number;maxSeconds?:number;maxOutput?:number;imageInput?:boolean;organizationToken?:string}={}){
  const root=resolve('work/agent-model-'+randomUUID());mkdirSync(root,{recursive:true});
  const organizationToken=limits.organizationToken??randomBytes(32).toString('base64url'),nodeToken=randomBytes(32).toString('base64url'),upstreamRequests:any[]=[];
  let handler:(request:IncomingMessage,response:ServerResponse,body:any)=>void|Promise<void>=(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end(chunk('local reply')+final);};
  let upstreamError:unknown,upstreamClosed=0;
  const upstream=createServer(async(req,res)=>{res.on('close',()=>{upstreamClosed++;});try{const chunks:Buffer[]=[];for await(const item of req)chunks.push(Buffer.from(item));const body=JSON.parse(Buffer.concat(chunks).toString());assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer '+organizationToken);assert.equal(req.headers.cookie,undefined);const entry={body,headerNames:Object.keys(req.headers),authorizationMatches:true,at:Date.now()};upstreamRequests.push(entry);writeFileSync(join(root,'upstream.json'),JSON.stringify(upstreamRequests,null,2));await handler(req,res,body);}catch(error){upstreamError=error;res.destroy();}});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const a=upstream.address();assert.ok(a&&typeof a!=='string');
  let broker=new AgentModelBroker({endpoint:`http://127.0.0.1:${a.port}/v1`,token:organizationToken,model:'local-model',contextWindow:65536,maxOutput:4096,imageInput:limits.imageInput??false,development:true});
  let store=new ReachStore(join(root,'reach.sqlite'));store.bootstrap('model-test','local-model-fixture-password');const session=store.login('model-test','local-model-fixture-password'),paired=store.pair({attemptId:randomUUID(),code:store.createPairing(session.user.id).code,installationId:randomUUID(),installationSecret:nodeToken,name:'Synthetic model Node',platform:'windows',version:'fixture'}),node=store.node(nodeToken);
  store.hello(node,'fixture',['agent.delegate','file.write','file.read','command.run']);
  const {imageInput:_,organizationToken:_token,...budgets}=limits,command=delegateSchema.parse({kind:'agent.delegate',sessionId:randomUUID(),cwd:root,objective:'Local broker fixture',...budgets}),parent=store.submit(session.user.id,randomUUID(),paired.nodeId,command),dispatch=store.claim(node)!;
  const record=(d:any,kind:any,data:any={})=>store.record(node,{operationId:d.operationId,dispatchId:d.dispatchId,payloadHash:d.payloadHash,eventId:randomUUID(),sequence:store.operation(session.user.id,d.operationId).last_sequence+1,kind,data});record(dispatch,'received');record(dispatch,'running');
  let downstream:ServerResponse|undefined;const observe=(req:IncomingMessage,res:ServerResponse)=>{if(req.url?.includes('/model/requests/'))downstream=res;};
  let server=reachServer({store,agentModel:broker,publicOrigin:'http://127.0.0.1',allowInsecureLoopback:true});server.on('request',observe);server.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();assert.ok(addr&&typeof addr!=='string');let origin=`http://127.0.0.1:${addr.port}`;
  const runId=randomUUID(),binding={dispatchId:dispatch.dispatchId,payloadHash:dispatch.payloadHash};
  const api=async(path:string,method='GET',value?:unknown,token=nodeToken)=>{const result=await fetch(origin+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json',connection:'close'},body:value===undefined?undefined:JSON.stringify(value)});return{status:result.status,data:await result.json() as any};};
  const route=()=>api(`/api/v1/node/agents/${parent.id}/model/route`,'POST',binding);
  const bound=await route();assert.equal(bound.status,200);const routeHash=bound.data.descriptor.routeHash;
  const headers={authorization:'Bearer '+nodeToken,'content-type':'application/json','x-reach-dispatch-id':binding.dispatchId,'x-reach-payload-hash':binding.payloadHash,'x-reach-run-id':runId,'x-reach-model-route':routeHash,connection:'close'};
  const payload=(extra:Record<string,unknown>={})=>({model:'local-model',stream:true,max_tokens:1024,messages:[{role:'user',content:'controlled loopback prompt'}],...extra});
  const model=(requestId=randomUUID(),body:unknown=payload(),extraHeaders:Record<string,string>={})=>fetch(origin+`/api/v1/node/agents/${parent.id}/model/requests/${requestId}`,{method:'POST',headers:{...headers,...extraHeaders},body:typeof body==='string'?body:JSON.stringify(body)});
  const calls=()=>store.db.prepare('SELECT * FROM agent_model_calls WHERE parent_id=? ORDER BY rowid').all(parent.id) as any[];
  const outcome=()=>({taskId:parent.id,sessionId:command.sessionId,taskAccepted:false,status:'awaiting_review',childOperationIds:[]});
  const createTool=(otherRun=runId)=>{const argumentsJson=JSON.stringify({command:{kind:'file.read',path:'local.txt'}});return store.agents.create(node,parent.id,{...binding,runId:otherRun,callId:'fixture-call',tool:'reach_execute',argsSha256:sha256(argumentsJson),argumentsJson});};
  const stopServer=async()=>{await broker.close();await server.shutdown();if(store.isOpen)store.close();};
  return{root,organizationToken,nodeToken,session,node,parent,dispatch,command,runId,routeHash,headers,payload,binding,route,model,api,calls,record,outcome,createTool,upstreamRequests,
    get store(){return store;},get broker(){return broker;},get origin(){return origin;},get upstreamClosed(){return upstreamClosed;},
    downstream(){return{needDrain:downstream?.writableNeedDrain??false,bufferedBytes:downstream?.writableLength??0,highWaterMark:downstream?.writableHighWaterMark??0};},
    handle(value:typeof handler){handler=value;},
    async reopen(newToken=organizationToken){await stopServer();store=new ReachStore(join(root,'reach.sqlite'));broker=new AgentModelBroker({endpoint:`http://127.0.0.1:${a.port}/v1`,token:newToken,model:'local-model',contextWindow:65536,maxOutput:4096,imageInput:limits.imageInput??false,development:true});server=reachServer({store,agentModel:broker,publicOrigin:'http://127.0.0.1',allowInsecureLoopback:true});server.on('request',observe);server.listen(0,'127.0.0.1');await once(server,'listening');const next=server.address();assert.ok(next&&typeof next!=='string');origin=`http://127.0.0.1:${next.port}`;},
    async close(){try{if(store.isOpen)writeFileSync(join(root,'before-close-ledger.json'),JSON.stringify({calls:calls(),parent:store.operation(session.user.id,parent.id),upstreamRequests:upstreamRequests.length,upstreamClosed},null,2));}finally{try{await stopServer();}finally{if(upstream.listening){const ended=once(upstream,'close');upstream.close();upstream.closeAllConnections();await ended;}await until(()=>upstreamClosed>=upstreamRequests.length);}}
      const finalDb=new DatabaseSync(join(root,'reach.sqlite'),{readOnly:true});try{const rows=(table:string)=>finalDb.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table)?finalDb.prepare('SELECT * FROM '+table).all():[];writeFileSync(join(root,'asserted-ledger.json'),JSON.stringify({calls:finalDb.prepare('SELECT * FROM agent_model_calls WHERE parent_id=? ORDER BY rowid').all(parent.id),allModelCalls:rows('agent_model_calls'),parent:finalDb.prepare('SELECT * FROM operations WHERE id=?').get(parent.id),upstreamRequests:upstreamRequests.length,upstreamClosed,modelOwners:rows('agent_model_owners'),serviceInstances:rows('agent_service_instances'),modelStops:rows('agent_model_stops'),afterShutdown:true},null,2));}finally{finalDb.close();}assert.equal(upstreamError,undefined);console.log(JSON.stringify({agentModelEvidence:root}));}
  };
}
