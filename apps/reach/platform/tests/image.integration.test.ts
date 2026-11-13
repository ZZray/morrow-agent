// Copyright (c) Ray Zhang. Real Desk/sidecar HTTP path; original device receipts are seeded, no OS capture.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdirSync,writeFileSync,readFileSync,appendFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {ReachStore} from '../../src/service/store.ts';
import {reachServer} from '../../src/service/server.ts';
import {DeskHost} from '../src/host.ts';

const binary=process.env.REACH_DESK_SIDECAR;
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
async function until(read:()=>boolean,ms=60000){const end=Date.now()+ms;while(!read()){assert.ok(Date.now()<end,'local image condition timed out');await new Promise(r=>setTimeout(r,50));}}
function seed(reach:ReachStore,user:string,bytes:Buffer,width:number,height:number){
  const secret=randomBytes(32).toString('base64url'),code=reach.createPairing(user).code,bound=reach.pair({attemptId:randomUUID(),code,installationId:randomUUID(),installationSecret:secret,name:'Seeded image receipt',platform:'windows',version:'fixture'});reach.hello(reach.node(secret),'fixture',['file.read']);
  const op=reach.submit(user,randomUUID(),bound.nodeId,{kind:'file.read',path:'E:\\fixture\\image.png',offset:0,length:65536}),node=reach.node(secret),dispatch=reach.claim(node)!,artifactId=randomUUID();let sequence=0;
  const record=(kind:any,data:any)=>reach.record(node,{operationId:op.id,dispatchId:dispatch.dispatchId,payloadHash:dispatch.payloadHash,eventId:randomUUID(),sequence:++sequence,kind,data});record('received',{});record('running',{});
  record('output',{type:'artifact.manifest',version:1,artifactId,mimeType:'image/png',byteLength:bytes.length,sha256:sha(bytes),contentIndex:0,chunkBytes:65536,chunkCount:Math.ceil(bytes.length/65536),width,height});
  for(let offset=0;offset<bytes.length;offset+=65536){const part=bytes.subarray(offset,offset+65536);record('output',{type:'artifact.chunk',artifactId,index:offset/65536,dataBase64:part.toString('base64'),sha256:sha(part)});}
  record('output',{type:'artifact.complete',artifactId});const ref={type:'artifact',artifactId,mimeType:'image/png',sha256:sha(bytes),contentIndex:0};record('succeeded',{content:[ref],images:[ref]});
  return {operationId:op.id,artifactId,target:{nodeId:bound.nodeId,epoch:bound.epoch,cwd:'E:\\fixture'}};
}
function images(input:any){return input.messages.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((b:any)=>b.type==='image_url').map((b:any)=>Buffer.from(b.image_url.url.split(',')[1],'base64'));}
async function consume(response:Response){assert.equal(response.status,200);return (await response.text()).split('\n').filter(s=>s.startsWith('data: ')).map(s=>JSON.parse(s.slice(6)));}

test('large original PNG reaches the model, survives normal verification, stop/close and archival continuation',{skip:!binary,timeout:240000},async()=>{
  const root=resolve('work/desk-image-'+randomUUID());mkdirSync(root,{recursive:true});
  const png=new PNG({width:1024,height:1536});randomBytes(png.data.length).copy(png.data);const bytes=PNG.sync.write(png,{deflateLevel:0});assert.ok(bytes.length>6*1024*1024&&bytes.length<=8388608);writeFileSync(join(root,'original.png'),bytes);
  const reach=new ReachStore(join(root,'reach.sqlite'));reach.bootstrap('image-test','local-image-password');const session=reach.login('image-test','local-image-password'),original=seed(reach,session.user.id,bytes,png.width,png.height);
  let phase=0,held=false;const requests:any[]=[],seen:{phase:string;sha256:string;bytes:number}[]=[];
  const provider=createServer(async(req,res)=>{try{const chunks=[];for await(const b of req)chunks.push(b);const input=JSON.parse(Buffer.concat(chunks).toString());requests.push(input);appendFileSync(join(root,'provider-requests.jsonl'),JSON.stringify(input)+'\n');
    const summary=JSON.stringify(input.messages).includes('closed_old_messages');let tool:any=null,text='',hold=false;
    if(summary){assert.ok(images(input).some((image:Buffer)=>sha(image)===sha(bytes)));seen.push({phase:'summary',sha256:sha(bytes),bytes:bytes.length});text=JSON.stringify({summary:'The complete original PNG is retained in the original operation. Image input was received; no device effect should be repeated.',candidates:[]});}
    else if(phase===0){phase=1;tool=['first-image','second-in-round','over-image-budget'].map(id=>({id,name:'reach_image',arguments:{operationId:original.operationId,artifactId:original.artifactId}}));}
    else if(phase===1){assert.equal(images(input).length,2);assert.ok(images(input).every((image:Buffer)=>image.equals(bytes)));assert.ok(JSON.stringify(input.messages).includes('desk_image_budget'));seen.push({phase:'normal',sha256:sha(bytes),bytes:bytes.length});phase=2;text='The verified original PNG was received twice; the third read kept its explicit image budget refusal.';}
    else if(phase===2){phase=3;tool={id:'second-image',name:'reach_image',arguments:{operationId:original.operationId,artifactId:original.artifactId}};}
    else if(phase===3){assert.ok(images(input).some((image:Buffer)=>image.equals(bytes)));seen.push({phase:'before-stop',sha256:sha(bytes),bytes:bytes.length});phase=4;text='The original image has arrived. '.repeat(16);hold=true;held=true;}
    else if(phase===4){phase=5;tool={id:'after-large-archive',name:'reach_operation',arguments:{operationId:original.operationId}};}
    else{text='The same original Session continued after the image record was archived.';phase=6;}
    res.writeHead(200,{'content-type':'text/event-stream'});const send=(delta:any,finish:string|null=null)=>res.write('data: '+JSON.stringify({id:'local-image',model:'local-image',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');
    if(tool){send({role:'assistant',tool_calls:(Array.isArray(tool)?tool:[tool]).map((item,index)=>({index,id:item.id,type:'function',function:{name:item.name,arguments:JSON.stringify(item.arguments)}}))});send({},'tool_calls');}
    else{send({role:'assistant',content:text});if(hold){await once(res,'close');return;}send({},'stop');}res.end('data: [DONE]\n\n');
  }catch(error){writeFileSync(join(root,'provider-error.txt'),String(error));res.destroy();}});provider.listen(0,'127.0.0.1');await once(provider,'listening');const p=provider.address();assert.ok(p&&typeof p!=='string');
  const desk=new DeskHost({stateDirectory:join(root,'desk'),binary:binary!,endpoint:`http://127.0.0.1:${p.port}/v1`,model:'local-image',modelToken:'iVBOR',developmentLoopback:true,developmentImageInput:true,maxCalls:8,maxSeconds:150});
  const server=reachServer({store:reach,desk,publicOrigin:'http://127.0.0.1',allowInsecureLoopback:true});server.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a!=='string');const base=`http://127.0.0.1:${a.port}`;
  const request=(path:string,method='GET',body?:unknown)=>fetch(base+path,{method,headers:{authorization:'Bearer '+session.token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  try{const conversation=randomUUID();assert.equal((await request('/api/v1/desk/conversations','POST',{id:conversation})).status,201);const path=`/api/v1/desk/conversations/${conversation}/messages`,first=randomUUID();
    const initial=await consume(await request(path,'POST',{id:first,content:'Read the original image as actual image input.',target:original.target}));assert.equal(initial.at(-1).status,'completed',JSON.stringify(initial));
    const turn=desk.store.turn(session.user.id,first),task=join(root,'desk','tasks',turn.task_id),proof=JSON.parse(readFileSync(join(task,'evidence','run-1-tool-images.json'),'utf8'));assert.equal(proof.calls.find((c:any)=>c.id==='first-image').images[0].sha256,sha(bytes));assert.equal(desk.store.conversation(session.user.id,conversation).blocked,0);
    const second=randomUUID(),reading=consume(await request(path,'POST',{id:second,content:'Read the same original image then wait for stop.',target:original.target}));await until(()=>held);await request('/api/v1/desk/messages/'+second+'/cancel','POST',{});const stopped=await reading;assert.equal(stopped.at(-1).status,'cancelled',JSON.stringify(stopped));assert.equal(desk.store.conversation(session.user.id,conversation).blocked,0);
    const third=await consume(await request(path,'POST',{id:randomUUID(),content:'Continue and query the original operation after archiving.',target:original.target}));assert.equal(third.at(-1).status,'completed',JSON.stringify(third));assert.equal(phase,6);assert.ok(seen.some(v=>v.phase==='summary'));assert.equal(reach.operations(session.user.id).length,1);
    const stoppedTurn=desk.store.turn(session.user.id,second),effects=JSON.parse(readFileSync(join(root,'desk','tasks',stoppedTurn.task_id,'effects-review.json'),'utf8'));assert.equal(effects.effects.calls[0].images[0].sha256,sha(bytes));
    writeFileSync(join(root,'asserted.json'),JSON.stringify({original,bytes:bytes.length,sha256:sha(bytes),seen,providerCalls:requests.length,turns:desk.store.turns(session.user.id,conversation),scope:'real Desk and shared sidecar, seeded original device ledger; no OS capture or real model'},null,2));
  }finally{await desk.close();server.close();server.closeAllConnections();await once(server,'close');reach.close();provider.close();provider.closeAllConnections();await once(provider,'close');console.log(JSON.stringify({deskImageEvidence:root}));}
});
