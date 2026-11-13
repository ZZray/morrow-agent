// Copyright (c) Ray Zhang. Refuse a new message before consuming the native history budget.
import {existsSync,lstatSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {requireCondition} from '../../src/service/errors.ts';

export function checkSessionCapacity(directory:string,modern:boolean){
  const maximum=(modern?1024:64)*1024*1024,reserve=(modern?128:16)*1024*1024;let bytes=0,entries=0,rawMessages=0;
  const head=join(directory,'session.journal','head.json');
  if(existsSync(head)){requireCondition(lstatSync(head).isFile()&&lstatSync(head).size<=4*1024*1024,409,'desk_session_history_limit','会话原始索引无法核验');
    try{rawMessages=JSON.parse(readFileSync(head,'utf8')).head.raw_count;}catch{rawMessages=-1;}
    requireCondition(Number.isSafeInteger(rawMessages)&&rawMessages>=0&&rawMessages<=96000,409,'desk_session_history_limit','会话原始消息数已达到本地检查预算，未创建新任务');}
  const scan=(path:string)=>{if(!existsSync(path))return;const stat=lstatSync(path);requireCondition(!stat.isSymbolicLink(),409,'desk_session_history_limit','会话原始记录路径无法核验，请保留原记录');
    requireCondition(++entries<=14000,409,'desk_session_history_limit','会话原始记录已达到本地检查上限，请保留原会话记录');
    if(stat.isDirectory()){for(const name of readdirSync(path))scan(join(path,name));}else{requireCondition(stat.isFile(),409,'desk_session_history_limit','会话原始记录格式无法核验');bytes+=stat.size;requireCondition(bytes<=maximum-reserve,409,'desk_session_history_limit','会话原始记录已达到本地检查预算，未创建新任务；原记录保留');}
  };
  for(const name of ['session.json','session.context.json','session.journal'])scan(join(directory,name));
  return {bytes,maximum,reserve,entries,rawMessages};
}
