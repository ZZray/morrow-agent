// Copyright (c) Ray Zhang. Lightweight public provenance, never Host paths or model-understanding claims.
import {z} from 'zod';
import {artifactManifestSchema} from '../../src/contracts/artifacts.ts';
import {requireCondition} from '../../src/service/errors.ts';
import type {DeviceCall} from './store.ts';
export interface ImageView {callKey:string;operationId:string|null;artifactId:string|null;sha256:string|null;byteLength:number|null;width:number|null;height:number|null;recorded:boolean}
const key=z.string().regex(/^[0-9a-f]{64}$/),id=z.string().uuid();
export function imageView(call:DeviceCall):ImageView{
  const reply=JSON.parse(call.receipt_json!).reply,source=reply.value?.source,manifest=artifactManifestSchema.parse(source?.manifest),image=reply.images?.[0];
  requireCondition(reply.settlement==='Settled'&&!reply.is_error&&reply.images.length===1&&manifest.mimeType==='image/png'&&image.mime_type==='image/png'&&image.sha256===manifest.sha256&&image.bytes===manifest.byteLength&&image.width===manifest.width&&image.height===manifest.height&&call.operation_id===source.binding.operationId&&reply.value.artifactId===manifest.artifactId,409,'desk_image_record_invalid','原图记录尚未核对');
  return {callKey:key.parse(call.call_key),operationId:id.parse(call.operation_id),artifactId:manifest.artifactId,sha256:manifest.sha256,byteLength:manifest.byteLength,width:manifest.width,height:manifest.height,recorded:true};
}
/** Reading history does not load PNGs. Damaged records retain a visible source marker. */
export function imageViews(calls:DeviceCall[]):ImageView[]{const result:ImageView[]=[];for(const call of calls){if(call.tool!=='reach_image'||!call.receipt_json)continue;try{const reply=JSON.parse(call.receipt_json).reply;if(reply.is_error||reply.settlement!=='Settled')continue;result.push(imageView(call));}catch{result.push({callKey:call.call_key,operationId:call.operation_id,artifactId:null,sha256:null,byteLength:null,width:null,height:null,recorded:false});}}return result;}
