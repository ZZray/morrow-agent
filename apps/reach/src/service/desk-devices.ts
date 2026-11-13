// Copyright (c) Ray Zhang. Current authenticated account over the original Reach ledger.
import type { ReachStore, OperationRow } from './store.ts';
import { requireCondition } from './errors.ts';
import { commandSchema } from '../contracts/protocol.ts';
import { deviceTargetSchema,checkTargetDirectory,targetPaths } from '../contracts/device-target.ts';
import type { DeviceTarget } from '../contracts/device-target.ts';
export function deviceCommand(bound:DeviceTarget&{platform:string},raw:unknown){
  const command=commandSchema.parse(raw),paths=targetPaths(bound.platform);
  if(command.kind==='command.run'){
    requireCondition(command.cwd===undefined||paths.normalize(command.cwd)===paths.normalize(bound.cwd),400,'desk_command_cwd_mismatch','命令工作目录须与本次执行目标一致');command.cwd=bound.cwd;
  }else if(['file.read','file.write','directory.list'].includes(command.kind)){
    const file=command as {path:string};requireCondition(bound.platform!=='windows'||!/^[A-Za-z]:(?![\\/])/u.test(file.path),400,'desk_drive_relative_path','请使用相对工作目录的路径或完整绝对路径');file.path=paths.resolve(bound.cwd,file.path);
  }else if(command.kind==='agent.delegate'){
    requireCondition(paths.normalize(command.cwd)===paths.normalize(bound.cwd),400,'desk_command_cwd_mismatch','委托工作目录须与本次执行目标一致');command.cwd=bound.cwd;
  }
  return command;
}
export function deskDevices(store:ReachStore,userId:string){
  function target(raw:unknown){const value=deviceTargetSchema.parse(raw),node=store.ownedNode(userId,value.nodeId);requireCondition(!node.revoked&&node.epoch===value.epoch,409,'node_pairing_changed','设备配对已变化，请重新选择执行目标');checkTargetDirectory(node.platform,value.cwd);return {...value,name:node.name,platform:node.platform};}
  function operation(binding:DeviceTarget,id:string):OperationRow{const row=store.operation(userId,id);requireCondition(row.node_id===binding.nodeId&&row.epoch===binding.epoch,409,'desk_operation_target_mismatch','这次操作属于另一执行目标');return row;}
  return {
    list:()=>store.nodes(userId),target,
    submit:(requestId:string,binding:DeviceTarget,raw:unknown)=>{
      const bound=target({nodeId:binding.nodeId,epoch:binding.epoch,cwd:binding.cwd}),command=deviceCommand(bound,raw);
      // submit repeats ownership/epoch/capability checks in its enqueue transaction.
      return store.submit(userId,requestId,bound.nodeId,command,bound.epoch);
    },
    operation,
    find:(binding:DeviceTarget,requestId:string)=>{const row=store.db.prepare('SELECT id FROM operations WHERE user_id=? AND request_id=?').get(userId,requestId) as {id:string}|undefined;return row?operation(binding,row.id):null;},
    cancel:(binding:DeviceTarget,id:string)=>{operation(binding,id);return store.cancel(userId,id);},
    events:(binding:DeviceTarget,id:string,after=0,limit=64)=>{operation(binding,id);return store.events(userId,id,after,limit);},
    artifacts:(binding:DeviceTarget,id:string)=>{operation(binding,id);return store.artifacts(userId,id);},
    artifact:(binding:DeviceTarget,id:string,artifactId:string,offset:number,length:number)=>{operation(binding,id);return store.artifact(userId,id,artifactId,offset,length);},
  };
}
export type DeskDevices=ReturnType<typeof deskDevices>;
