// Copyright (c) Ray Zhang. Metadata-only capacity checks; no model or device call.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,truncateSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {checkSessionCapacity} from '../src/session-capacity.ts';
import {DeskHost} from '../src/host.ts';
import {ReachStore} from '../../src/service/store.ts';
import {reachServer} from '../../src/service/server.ts';

test('history capacity reserves the next Run and rejects before creating any Task',async()=>{
  const root=resolve('work/desk-capacity-'+randomUUID());mkdirSync(root,{recursive:true});
  const reach=new ReachStore(join(root,'reach.sqlite'));reach.bootstrap('capacity','local-capacity-password');const login=reach.login('capacity','local-capacity-password'),state=join(root,'desk'),desk=new DeskHost({stateDirectory:state,binary:process.execPath,model:'never-called',modelToken:'never-used',endpoint:'http://127.0.0.1:1/v1',developmentLoopback:true}),conversation=randomUUID();desk.store.create(login.user.id,conversation,'Capacity',desk.routeHash);
  const directory=join(state,'sessions',conversation),journal=join(directory,'session.journal');mkdirSync(journal,{recursive:true});const path=join(journal,'sparse-budget-test');writeFileSync(path,'');truncateSync(path,48*1024*1024);
  assert.equal(checkSessionCapacity(directory,false).bytes,48*1024*1024);truncateSync(path,48*1024*1024+1);assert.throws(()=>checkSessionCapacity(directory,false),/检查预算/);assert.ok(checkSessionCapacity(directory,true).bytes<896*1024*1024);
  const server=reachServer({store:reach,desk,publicOrigin:'http://127.0.0.1',allowInsecureLoopback:true});server.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a!=='string');
  try{const submit=()=>fetch(`http://127.0.0.1:${a.port}/api/v1/desk/conversations/${conversation}/messages`,{method:'POST',headers:{authorization:'Bearer '+login.token,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),content:'Must not create a Task'})});const response=await submit();assert.equal(response.status,409);assert.equal((await response.json() as any).error.code,'desk_session_history_limit');truncateSync(path,0);writeFileSync(join(journal,'head.json'),JSON.stringify({head:{raw_count:96001}}));const count=await submit();assert.equal(count.status,409);assert.equal((await count.json() as any).error.code,'desk_session_history_limit');assert.equal(desk.store.turns(login.user.id,conversation).length,0);assert.equal(desk.store.conversation(login.user.id,conversation).blocked,0);writeFileSync(join(root,'asserted.json'),JSON.stringify({scope:'metadata-only sparse history and message-count budget; real HTTP rejection, no sidecar or model',turns:0,blocked:0,sourceRetained:true}));}
  finally{await desk.close();server.close();server.closeAllConnections();await once(server,'close');reach.close();console.log(JSON.stringify({deskCapacityEvidence:root}));}
});
