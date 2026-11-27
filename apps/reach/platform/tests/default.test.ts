// Copyright (c) Ray Zhang. Reach 默认带云端对话（2026-11-24 用户决定）。缺少运行组件和模型配置时，基础进程照常启动，并如实报告缺什么。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
test('default Reach process starts without the conversation sidecar or model and reports what is missing',{timeout:15000},async()=>{
  const root=resolve('work/desk-default-'+randomUUID());mkdirSync(root,{recursive:true});
  const env:NodeJS.ProcessEnv={...process.env,REACH_DATA_DIR:join(root,'service'),REACH_PORT:'0',REACH_DEVELOPMENT:'1',REACH_PUBLIC_ORIGIN:'http://127.0.0.1'};
  for(const key of Object.keys(env))if(key.startsWith('REACH_DESK_'))delete (env as NodeJS.ProcessEnv)[key];
  // 指向不存在的运行组件，避免受本机 PATH 影响。
  env.REACH_DESK_SIDECAR=join(root,'missing-sidecar');
  const child=spawn(process.execPath,['src/service/main.ts'],{windowsHide:true,env,stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',v=>errors+=v);const lines=createInterface({input:child.stdout});
  try{
    let port=0;for await(const line of lines){const event=JSON.parse(line);if(event.event==='reach_listening'){port=event.port;break;}}
    assert.ok(port,errors);const base=`http://127.0.0.1:${port}`;
    assert.equal((await fetch(base+'/healthz')).status,200);
    const login=await fetch(base+'/api/v1/auth/pin',{method:'POST',headers:{'content-type':'application/json'},body:'{"pin":"2026"}'});
    const cookie=login.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(base+'/api/v1/desk/conversations',{headers:{cookie}})).status,404,'没有运行时就不开放对话接口');
    const settings=await (await fetch(base+'/api/v1/settings/models',{headers:{cookie}})).json();
    assert.equal(settings.deskRunning,false);assert.equal(settings.deskAvailable,false);assert.match(settings.deskUnavailable,/对话运行组件不存在/);
    assert.match(errors,/reach_desk_unavailable/);
    assert.equal(existsSync(join(root,'service','desk')),false,'没有创建对话运行时就不建状态目录');
    writeFileSync(join(root,'verified.json'),JSON.stringify({health:200,deskRoute:404,deskUnavailable:settings.deskUnavailable,deskState:false}));
  }finally{lines.close();if(child.exitCode===null){const done=once(child,'exit');child.kill();await done;}writeFileSync(join(root,'stderr.log'),errors);console.log(JSON.stringify({defaultEvidence:root}));}
});
