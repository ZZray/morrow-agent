// Copyright (c) Ray Zhang. Execution location, separate from tool permissions.
import { z } from 'zod';
import { win32, posix } from 'node:path';
import { requireCondition } from '../service/errors.ts';
export const deviceTargetSchema=z.strictObject({nodeId:z.string().uuid(),epoch:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),cwd:z.string().min(1).max(32768).refine(v=>!v.includes('\0'))});
export type DeviceTarget=z.infer<typeof deviceTargetSchema>;
export function targetPaths(platform:string){return platform==='windows'?win32:posix;}
export function checkTargetDirectory(platform:string,cwd:string){const paths=targetPaths(platform),root=paths.parse(cwd).root;requireCondition(paths.isAbsolute(cwd)&&(platform!=='windows'||(root!=='\\'&&root!=='/')),400,'desk_target_cwd_required','请选择设备上的绝对工作目录');return cwd;}
