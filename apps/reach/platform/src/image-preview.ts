// Copyright (c) Ray Zhang. Account-owned original images, independent of Task acceptance.
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {requireCondition} from '../../src/service/errors.ts';
import type {DeskDevices} from '../../src/service/desk-devices.ts';
import type {DeskStore,Turn} from './store.ts';
import {checkedDeviceCall,checkDeviceOperation} from './device-tools.ts';
import {checkedModelImage} from './device-images.ts';
import {imageView} from './image-view.ts';
export {imageViews} from './image-view.ts';

const key=z.string().regex(/^[0-9a-f]{64}$/);
export function readImage(store:DeskStore,turn:Turn,access:DeskDevices,root:string,callKey:string){
  key.parse(callKey);const call=store.deviceCalls(turn).find(c=>c.call_key===callKey);requireCondition(call?.tool==='reach_image'&&turn.target_json&&call.operation_id,404,'desk_image_missing','未找到这条消息的原图');
  const target=JSON.parse(turn.target_json),{proof}=checkedDeviceCall(turn,call,target,root),image=imageView(call),op=access.operation(target,call.operation_id);checkDeviceOperation(op,proof.intent);
  requireCondition(proof.intent.arguments.artifactId===image.artifactId&&proof.reply.value.operationId===op.id,409,'desk_image_source_mismatch','原图来源不符');
  const listed=access.artifacts(target,op.id),entry=listed.artifacts.find(v=>v.artifactId===image.artifactId);requireCondition(entry?.complete,409,'desk_image_incomplete','原图尚未完整收到');const {complete:_,...manifest}=entry;
  requireCondition(isDeepStrictEqual(listed.binding,proof.reply.value.source.binding)&&isDeepStrictEqual(manifest,proof.reply.value.source.manifest),409,'desk_image_source_mismatch','原图清单与原收据不符');
  const loaded=checkedModelImage(proof.reply.images[0],root);return {view:image,bytes:loaded.bytes};
}
