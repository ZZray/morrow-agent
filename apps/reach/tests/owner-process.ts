// Copyright (c) Ray Zhang. Local child-process fixture for the real service lifetime lock.
import {ReachStore} from '../src/service/store.ts';
const store=new ReachStore(process.argv[2]);
console.log(JSON.stringify({event:'owner_ready',instanceId:store.owner.instanceId,lockIdentity:store.owner.lockIdentity}));
const timer=setInterval(()=>{},1000);
for(const signal of ['SIGINT','SIGTERM']as const)process.once(signal,()=>{clearInterval(timer);store.close();process.exit(0);});
