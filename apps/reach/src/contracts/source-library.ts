// Copyright (c) Ray Zhang. Cross-Task technical sources; no automatic knowledge adoption.
import {z} from 'zod';
import {identifier,sourceRequirementsSchema} from './protocol.ts';
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const wellFormed=(value:string)=>!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const text=z.string().min(1).max(16384).refine(v=>v.trim().length>0&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v),'Expected well-formed original UTF-8 text');
export const libraryListSchema=z.strictObject({nodeId:identifier,epoch:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),state:z.enum(['candidate','adopted','revoked']).default('adopted')});
export const libraryProposalSchema=z.strictObject({requestId:identifier,sourceTaskId:identifier,scope:z.literal('device'),kind:z.enum(['skill','knowledge']),title:z.string().trim().min(1).max(128).refine(wellFormed),revision:z.string().trim().min(1).max(256).refine(wellFormed),text,requirements:sourceRequirementsSchema});
export const librarySourceSchema=z.strictObject({versionSha256:hash,stage:z.enum(['candidate','adopted'])});
export const libraryValidationSchema=z.strictObject({requestId:identifier,versionSha256:hash,validationTaskId:identifier});
export const libraryReviewSchema=z.strictObject({requestId:identifier,versionSha256:hash,decision:z.enum(['adopt','revoke']),validationId:identifier.optional(),reason:text});
