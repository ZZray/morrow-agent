// Copyright (c) Ray Zhang. Exercise both registered production signal handlers together.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
test('simultaneous signal events share one application shutdown',{timeout:15000},async()=>{
  const root=resolve('work/desk-shutdown-'+randomUUID());mkdirSync(root,{recursive:true});
  const script=join(root,'signals.mjs'),count=join(root,'count.txt');
  writeFileSync(script,`import {startReach} from ${JSON.stringify(pathToFileURL(resolve('src/service/main.ts')).href)};import {writeFileSync} from 'node:fs';let n=0;const server=startReach({handle:async()=>{},revoke:()=>{},close:async()=>{writeFileSync(${JSON.stringify(count)},String(++n));await new Promise(r=>setTimeout(r,50));}});server.once('listening',()=>{process.emit('SIGINT');process.emit('SIGTERM');});`);
  const child=spawn(process.execPath,[script],{windowsHide:true,env:{...process.env,REACH_DATA_DIR:join(root,'service'),REACH_PORT:'0',REACH_DEVELOPMENT:'1',REACH_PUBLIC_ORIGIN:'http://127.0.0.1'},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',v=>stderr+=v);
  const [code]=await once(child,'exit');writeFileSync(join(root,'stderr.log'),stderr);assert.equal(code,0,stderr);assert.equal(readFileSync(count,'utf8'),'1');console.log(JSON.stringify({shutdownEvidence:root}));
});
