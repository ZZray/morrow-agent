// Copyright (c) Ray Zhang.
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ReachStore } from './store.ts';
import { reachServer } from './server.ts';
import { RayLoginBridge } from './ray-login.ts';
import type { DeskExtension } from './desk-extension.ts';
import {agentModelFromEnvironment} from './agent-model.ts';

export function startReach(desk?: DeskExtension) {
  const host=process.env.REACH_LISTEN_HOST??'127.0.0.1',port=Number(process.env.REACH_PORT??'18910');
  if(!Number.isInteger(port)||port<(process.env.REACH_DEVELOPMENT==='1'?0:1)||port>65535)throw Error('Invalid REACH_PORT');
  const publicOrigin=process.env.REACH_PUBLIC_ORIGIN??`http://127.0.0.1:${port}`,agentModel=agentModelFromEnvironment(process.env);
  let store:ReachStore|undefined,rayLogin:RayLoginBridge|undefined,server:ReturnType<typeof reachServer>|undefined,detachSignals:(()=>void)|undefined;
  try{
    store=new ReachStore(resolve(process.env.REACH_DATA_DIR??'work/service','reach.sqlite'));
    if(process.env.REACH_BOOTSTRAP_USERNAME&&process.env.REACH_BOOTSTRAP_PASSWORD){try{store.bootstrap(process.env.REACH_BOOTSTRAP_USERNAME,process.env.REACH_BOOTSTRAP_PASSWORD);}finally{delete process.env.REACH_BOOTSTRAP_PASSWORD;}}
    rayLogin=process.env.REACH_RAY_SSO_KEY_FILE?new RayLoginBridge(readFileSync(process.env.REACH_RAY_SSO_KEY_FILE),process.env.REACH_RAY_USERNAME??'ray',resolve(process.env.REACH_DATA_DIR??'work/service','ray-auth.sqlite')):undefined;
    server=reachServer({store,publicOrigin,cookiePath:process.env.REACH_COOKIE_PATH,rayLogin,desk,agentModel,allowInsecureLoopback:process.env.REACH_DEVELOPMENT==='1',trustedProxyAddresses:process.env.REACH_TRUSTED_PROXY_ADDRESSES?.split(',').map(v=>v.trim()).filter(Boolean)});
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
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) startReach();
