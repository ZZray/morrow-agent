// Copyright (c) Ray Zhang. Base process starts with no platform tree or model configuration.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {cpSync,mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
test('base Reach process runs without Desk sources, state or model configuration',{timeout:15000},async()=>{
  const root=resolve('work/desk-default-'+randomUUID());mkdirSync(join(root,'src'),{recursive:true});
  cpSync('src/service',join(root,'src/service'),{recursive:true});cpSync('src/contracts',join(root,'src/contracts'),{recursive:true});
  const env={...process.env,REACH_DATA_DIR:join(root,'service'),REACH_PORT:'0',REACH_DEVELOPMENT:'1',REACH_PUBLIC_ORIGIN:'http://127.0.0.1'};
  for(const key of Object.keys(env))if(key.startsWith('REACH_DESK_'))delete (env as NodeJS.ProcessEnv)[key];
  const child=spawn(process.execPath,[join(root,'src/service/main.ts')],{windowsHide:true,env,stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',v=>errors+=v);const lines=createInterface({input:child.stdout});
  try{
    let port=0;for await(const line of lines){const event=JSON.parse(line);if(event.event==='reach_listening'){port=event.port;break;}}
    assert.ok(port,errors);const base=`http://127.0.0.1:${port}`;
    assert.equal((await fetch(base+'/healthz')).status,200);assert.equal((await fetch(base+'/api/v1/desk/conversations')).status,404);
    assert.equal(existsSync(join(root,'platform')),false);assert.equal(existsSync(join(root,'desk.sqlite')),false);
    writeFileSync(join(root,'verified.json'),JSON.stringify({health:200,deskRoute:404,platformTree:false,deskConfiguration:false}));
  }finally{lines.close();if(child.exitCode===null){const done=once(child,'exit');child.kill();await done;}writeFileSync(join(root,'stderr.log'),errors);console.log(JSON.stringify({defaultEvidence:root}));}
});
