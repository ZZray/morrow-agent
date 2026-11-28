// Copyright (c) Ray Zhang.
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ReachStore } from './store.ts';
import { reachServer } from './server.ts';
import { RayLoginBridge } from './ray-login.ts';
import type { DeskExtension } from './desk-extension.ts';
import {AgentModelBroker,agentModelConfigFromEnvironment} from './agent-model.ts';
import {ModelSettings} from './model-settings.ts';
import type {ModelConfig,ModelPurpose,RunningModel} from './model-settings.ts';
import {prepareDesk} from './desk-runtime.ts';
import type {DeskComposition} from './desk-runtime.ts';
export type {DeskComposition} from './desk-runtime.ts';

// Reach 默认带云端对话：服务入口先用 startDefaultReach 准备对话运行时；测试或嵌入方可以直接传入自己的扩展。
export function startReach(composition?: DeskExtension | DeskComposition, deskUnavailable?: string) {
  if(deskUnavailable)console.error(JSON.stringify({event:'reach_desk_unavailable',message:deskUnavailable}));
  const host=process.env.REACH_LISTEN_HOST??'127.0.0.1',port=Number(process.env.REACH_PORT??'18910');
  if(!Number.isInteger(port)||port<(process.env.REACH_DEVELOPMENT==='1'?0:1)||port>65535)throw Error('Invalid REACH_PORT');
  const pinOnly=process.env.REACH_PIN_ONLY==='1';
  const rawRetention = process.env.REACH_OPERATION_RETENTION_DAYS?.trim();
  const operationRetentionDays = rawRetention === undefined || rawRetention === '' ? undefined : Number(rawRetention);
  if (operationRetentionDays !== undefined && (!Number.isInteger(operationRetentionDays) || operationRetentionDays < 0 || operationRetentionDays > 3650)) {
    throw Error('Invalid REACH_OPERATION_RETENTION_DAYS');
  }
  const publicOrigin=process.env.REACH_PUBLIC_ORIGIN??`http://127.0.0.1:${port}`,agentEnvironment=agentModelConfigFromEnvironment(process.env),development=process.env.REACH_DEVELOPMENT==='1';
  const deskComposition=composition&&'create' in composition?composition:undefined;
  let desk=deskComposition?undefined:composition as DeskExtension|undefined,agentModel:AgentModelBroker|undefined;
  let store:ReachStore|undefined,rayLogin:RayLoginBridge|undefined,server:ReturnType<typeof reachServer>|undefined,detachSignals:(()=>void)|undefined;
  try{
    store=new ReachStore(resolve(process.env.REACH_DATA_DIR??'work/service','reach.sqlite'));
    if(!pinOnly&&process.env.REACH_BOOTSTRAP_USERNAME&&process.env.REACH_BOOTSTRAP_PASSWORD){try{store.bootstrap(process.env.REACH_BOOTSTRAP_USERNAME,process.env.REACH_BOOTSTRAP_PASSWORD);}finally{delete process.env.REACH_BOOTSTRAP_PASSWORD;}}
    const modelLoopback=development||process.env.REACH_DESK_LOOPBACK_RELAY==='1'||process.env.REACH_MODEL_LOOPBACK==='1';
    const settings=new ModelSettings(store,modelLoopback),modelRuntime:Partial<Record<ModelPurpose,RunningModel>>={};
    // 启用的配置无效时保留服务和设置页，记录真实原因，等待在网页上修正。
    const resolveModel=<T>(purpose:ModelPurpose,environment:ModelConfig|undefined,build:(config:ModelConfig)=>T)=>{
      settings.seedFromEnvironment(purpose,environment);const enabled=settings.enabled(purpose);if(!enabled)return undefined;
      const running={generation:enabled.generation,source:enabled.source,endpoint:enabled.config.endpoint,model:enabled.config.model};
      try{const built=build(enabled.config);modelRuntime[purpose]=running;console.log(JSON.stringify({event:'reach_model_enabled',purpose,generation:enabled.generation,source:enabled.source,model:enabled.config.model}));return built;}
      catch(error){const message=error instanceof Error?error.message:'unknown';modelRuntime[purpose]={...running,generation:null,error:message};console.error(JSON.stringify({event:'reach_model_rejected',purpose,generation:enabled.generation,message}));return undefined;}
    };
    agentModel=resolveModel('agent',agentEnvironment,config=>new AgentModelBroker({endpoint:config.endpoint,token:config.token,model:config.model,contextWindow:config.contextWindow!,maxOutput:config.maxOutput!,imageInput:!!config.imageInput,development:development||process.env.REACH_MODEL_LOOPBACK==='1'}));
    if(deskComposition)desk=resolveModel('desk',deskComposition.environment,config=>deskComposition.create(config));
    rayLogin=!pinOnly&&process.env.REACH_RAY_SSO_KEY_FILE?new RayLoginBridge(readFileSync(process.env.REACH_RAY_SSO_KEY_FILE),process.env.REACH_RAY_USERNAME??'ray',resolve(process.env.REACH_DATA_DIR??'work/service','ray-auth.sqlite')):undefined;
    server=reachServer({store,publicOrigin,pinOnly,releaseManifest:process.env.REACH_RELEASE_MANIFEST,pin:{initial:process.env.REACH_PIN||undefined,reset:process.env.REACH_PIN_RESET==='1'},cookiePath:process.env.REACH_COOKIE_PATH,rayLogin,desk,agentModel,modelSettings:settings,modelRuntime,deskAvailable:!!composition,deskUnavailable,createDesk:deskComposition?.create,allowInsecureLoopback:process.env.REACH_DEVELOPMENT==='1',modelLoopback,trustedProxyAddresses:process.env.REACH_TRUSTED_PROXY_ADDRESSES?.split(',').map(v=>v.trim()).filter(Boolean),operationRetentionDays});
    const runtime=server;
    const signalStop=()=>{void runtime.shutdown().then(()=>process.exit(0),()=>process.exit(1));};
    for(const signal of ['SIGINT','SIGTERM']as const)process.once(signal,signalStop);
    detachSignals=()=>{for(const signal of ['SIGINT','SIGTERM']as const)process.removeListener(signal,signalStop);};
    runtime.once('close',detachSignals);
    runtime.once('error',()=>{console.error(JSON.stringify({event:'reach_listen_failed'}));void runtime.shutdown().then(()=>{detachSignals?.();process.exitCode=1;},()=>{detachSignals?.();process.exitCode=1;console.error(JSON.stringify({event:'reach_shutdown_failed'}));});});
    runtime.listen(port,host,()=>{const address=runtime.address();console.log(JSON.stringify({event:'reach_listening',host,port:address&&typeof address!=='string'?address.port:port}));});
    return runtime;
  }catch(error){
    const cleanup=server?server.shutdown():(async()=>{await Promise.all([desk?.close(),agentModel?.close()]);rayLogin?.close();store?.close();})();
    void cleanup.finally(()=>detachSignals?.()).catch(()=>{console.error(JSON.stringify({event:'reach_start_cleanup_failed'}));process.exitCode=1;});throw error;
  }
}
export async function startDefaultReach() {
  const desk=await prepareDesk(process.env,resolve(process.env.REACH_DATA_DIR??'work/service'));
  return startReach(desk.composition,desk.unavailable);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await startDefaultReach();
