// Copyright (c) Ray Zhang. Opt-in Reach + Desk composition; base main never imports this file.
import { startReach } from '../../src/service/main.ts';
import { DeskHost } from './host.ts';
const required=(name:string)=>{const value=process.env[name];if(!value)throw Error(`Missing ${name}`);return value;};
const desk=new DeskHost({stateDirectory:required('REACH_DESK_STATE_DIR'),binary:required('REACH_DESK_SIDECAR'),endpoint:required('REACH_DESK_ENDPOINT'),model:required('REACH_DESK_MODEL'),modelToken:required('REACH_DESK_MODEL_TOKEN'),developmentLoopback:process.env.REACH_DESK_LOOPBACK_RELAY==='1'});
delete process.env.REACH_DESK_MODEL_TOKEN;
try {startReach(desk);}catch(error){await desk.close();throw error;}
