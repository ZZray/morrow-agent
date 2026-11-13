// Copyright (c) Ray Zhang. Real socket-close interleaving before message admission.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DeskHost} from '../src/host.ts';

test('response closed while awaiting body never admits or starts a Task',{timeout:10000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'reach-desk-closed-'));
  const host=new DeskHost({stateDirectory:root,binary:process.execPath,endpoint:'http://127.0.0.1:12345/v1',model:'never-called',modelToken:'never-used',developmentLoopback:true});
  const conversation=randomUUID();host.store.create('user',conversation,'test',host.routeHash);
  let bodyReady!:()=>void,releaseBody!:(v:unknown)=>void,handled!:()=>void,closed!:()=>void;
  const ready=new Promise<void>(r=>bodyReady=r),body=new Promise(r=>releaseBody=r),done=new Promise<void>(r=>handled=r),gone=new Promise<void>(r=>closed=r);
  const server=createServer((incoming,response)=>{
    response.on('close',closed);
    void host.handle({request:incoming,response,url:new URL(`http://127.0.0.1/api/v1/desk/conversations/${conversation}/messages`),userId:'user',sessionId:'session',sessionValid:()=>true,body:()=>{bodyReady();return body;}}).finally(handled);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a!=='string');
  try{
    const client=request({hostname:'127.0.0.1',port:a.port,path:'/',method:'POST'});client.on('error',()=>{});client.end('{}');
    await ready;client.destroy();await gone;releaseBody({id:randomUUID(),content:'must never execute'});await done;
    assert.equal(host.store.turns('user',conversation).length,0);
  }finally{
    await host.close();server.close();server.closeAllConnections();await once(server,'close');
    assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('reach-desk-closed-'));rmSync(root,{recursive:true,force:true});
  }
});
