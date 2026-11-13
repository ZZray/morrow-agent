// Copyright (c) Ray Zhang. Original Reach artifacts become verified model inputs.
import {mkdirSync,openSync,closeSync,writeFileSync,fsyncSync,readFileSync,readSync,fstatSync,lstatSync,realpathSync,existsSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {artifactManifestSchema,ARTIFACT_CHUNK_BYTES,ARTIFACT_MAX_BYTES} from '../../src/contracts/artifacts.ts';
import {validatePng} from '../../src/controller/artifacts.ts';
import {requireCondition} from '../../src/service/errors.ts';
import type {DeskDevices} from '../../src/service/desk-devices.ts';
import type {DeviceTarget} from '../../src/contracts/device-target.ts';
import type {OperationRow} from '../../src/service/store.ts';
import type {DeviceAudit} from './device-tools.ts';

const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const imageSchema=z.strictObject({path:z.string().max(4096).refine(isAbsolute),sha256:z.string().regex(/^[0-9a-f]{64}$/),bytes:z.number().int().min(1).max(ARTIFACT_MAX_BYTES),mime_type:z.literal('image/png'),width:z.number().int().min(1).max(8192),height:z.number().int().min(1).max(8192)}).refine(v=>v.width*v.height<=8388608);
export type ModelImage=z.infer<typeof imageSchema>;
const inside=(root:string,path:string)=>{const r=relative(root,path);return r!==''&&r!=='..'&&!r.startsWith('..\\')&&!r.startsWith('../')&&!isAbsolute(r);};

export function checkedModelImage(raw:unknown,root:string){
  const image=imageSchema.parse(raw),directory=realpathSync(join(root,'evidence'));
  requireCondition(!lstatSync(image.path).isSymbolicLink()&&inside(directory,realpathSync(image.path)),409,'desk_image_path','图片不属于原任务证据目录');
  const fd=openSync(image.path,'r');let bytes:Buffer;
  try{const stat=fstatSync(fd);requireCondition(stat.isFile()&&stat.size===image.bytes,409,'desk_image_size','原图文件长度已变化');const buffer=Buffer.alloc(image.bytes+1);let size=0,n=0;do{n=readSync(fd,buffer,size,buffer.length-size,null);size+=n;}while(n&&size<buffer.length);bytes=buffer.subarray(0,size);}finally{closeSync(fd);}
  requireCondition(bytes.length===image.bytes&&sha(bytes)===image.sha256,409,'desk_image_integrity','原图文件摘要已变化');
  checkedPng(bytes,image.width,image.height);return {image,bytes};
}
function checkedPng(bytes:Buffer,width:number,height:number){let valid=true;try{validatePng(bytes,width,height);for(let offset=8;offset<bytes.length;offset+=bytes.readUInt32BE(offset)+12)if(bytes.toString('ascii',offset+4,offset+8)==='acTL')valid=false;}catch{valid=false;}requireCondition(valid,409,'desk_image_invalid','原图 PNG 校验失败，请保留原操作，不要重新截图');}

export function deviceImage(access:DeskDevices,target:DeviceTarget,op:OperationRow,artifactId:string,root:string,usedBytes=0){
  const listed=access.artifacts(target,op.id),binding={operationId:op.id,nodeId:op.node_id,epoch:op.epoch,dispatchId:op.dispatch_id,payloadHash:op.payload_hash};
  requireCondition(isDeepStrictEqual(listed.binding,binding),409,'desk_image_binding','图片操作来源不符');
  const entry=listed.artifacts.find(v=>v.artifactId===artifactId);
  requireCondition(entry?.complete,409,'desk_image_incomplete','原图未完整上传，请查询原操作，不要重新截图');
  const {complete:_,...raw}=entry,manifest=artifactManifestSchema.parse(raw);
  requireCondition(manifest.mimeType==='image/png',400,'desk_image_mime','此产物不是 PNG 图片');
  requireCondition(usedBytes+manifest.byteLength<=2*ARTIFACT_MAX_BYTES,413,'desk_image_budget','本次消息的原图总量已达上限，原产物仍可按字节取回');
  const chunks:Buffer[]=[];let offset=0;
  while(offset<manifest.byteLength){
    const part=access.artifact(target,op.id,artifactId,offset,ARTIFACT_CHUNK_BYTES),bytes=Buffer.from(part.dataBase64,'base64');
    requireCondition(isDeepStrictEqual(part.binding,binding)&&isDeepStrictEqual(part.manifest,manifest)
      &&bytes.toString('base64')===part.dataBase64&&bytes.length===Math.min(ARTIFACT_CHUNK_BYTES,manifest.byteLength-offset)
      &&part.offset===offset&&part.length===bytes.length&&part.nextOffset===offset+bytes.length
      &&part.eof===(part.nextOffset===manifest.byteLength)&&sha(bytes)===part.sha256,409,'desk_image_range','原图分段来源、长度或摘要不符');
    chunks.push(bytes);offset+=bytes.length;
  }
  const bytes=Buffer.concat(chunks);requireCondition(bytes.length===manifest.byteLength&&sha(bytes)===manifest.sha256,409,'desk_image_integrity','原图整体摘要不符');checkedPng(bytes,manifest.width,manifest.height);
  const directory=join(root,'evidence','host-images');mkdirSync(directory,{recursive:true});const path=join(directory,manifest.sha256+'.png');
  if(existsSync(path))requireCondition(readFileSync(path).equals(bytes),409,'desk_image_integrity','已保存的原图已变化');
  else{const fd=openSync(path,'wx');try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
  const image:ModelImage={path,sha256:manifest.sha256,bytes:manifest.byteLength,mime_type:'image/png',width:manifest.width,height:manifest.height};
  checkedModelImage(image,root);return {image,source:{binding,manifest}};
}

/** The sidecar produces this proof from native typed blocks under its existing lock. */
export async function verifyNativeImages(frame:any,basis:any,audit:DeviceAudit|undefined,evidence:string){
  const declared=(audit?.records??[]).flatMap(record=>record.reply.images??[]);
  if(!declared.length){requireCondition(!frame.tool_images_ref,409,'desk_unexpected_image_proof','原生图片证明没有对应调用');return null;}
  requireCondition(frame.tool_images_ref,409,'desk_image_proof_missing','缺少原生图片输入证明');
  const {readCheckedJsonReference}=await import(new URL('../../../../crates/morrow-agent-jsonl/clients/node/client.mjs',import.meta.url).href),proof=await readCheckedJsonReference(frame.tool_images_ref,evidence);
  requireCondition(proof.kind==='jsonl-native-images-v1'&&isDeepStrictEqual(proof.basis,basis)&&Array.isArray(proof.calls),409,'desk_image_proof_binding','原生图片证明不属于原任务');
  for(const record of audit!.records){
    const matches=proof.calls.filter((call:any)=>call.id===record.frame.native_call_id&&call.name===record.frame.tool_name);
    requireCondition(matches.length===1,409,'desk_image_proof_call','原生调用与原收据不符');const call=matches[0];
    let text=call.text;if(call.is_error&&text.startsWith('tool error: '))text=text.slice('tool error: '.length);
    requireCondition(isDeepStrictEqual(call.arguments,record.frame.arguments)&&call.is_error===record.reply.is_error
      &&isDeepStrictEqual(JSON.parse(text),record.reply.value)&&call.result_raw_index>=basis.raw_start&&call.result_raw_index<basis.raw_end,409,'desk_image_proof_result','原生结果与原收据不符');
    requireCondition(isDeepStrictEqual(call.images,(record.reply.images??[]).map(image=>({mime_type:image.mime_type,bytes:image.bytes,sha256:image.sha256}))),409,'desk_image_proof_content','模型图片字节与原图不符');
  }
  requireCondition(proof.calls.reduce((n:number,call:any)=>n+(call.images?.length??0),0)===declared.length,409,'desk_image_proof_extra','存在没有对应原收据的图片');return frame.tool_images_ref;
}
