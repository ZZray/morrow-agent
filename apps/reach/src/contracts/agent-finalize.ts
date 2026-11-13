// Copyright (c) Ray Zhang. Read-only native settlement has no Run admission or model/tool authority.
import {z} from 'zod';
import {identifier} from './protocol.ts';
import {agentReviewBindingSchema} from './agent-review.ts';
import {nativeReference,resumeHash} from './agent-resume.ts';
import {releasedConsumptionSchema} from '../service/agent-budgets.ts';
const recovered=z.strictObject({kind:z.literal('recovered_process_exit'),owner:nativeReference,observation:nativeReference});
const normal=z.strictObject({kind:z.literal('normal_join_receipt'),owner:nativeReference,receipt:nativeReference,observation:nativeReference});
const seal=z.strictObject({version:z.literal(1),receipt:nativeReference,commitmentSha256:resumeHash,commitmentJson:z.string().min(2).max(2*1024*1024)});
export const finalizationProofSchema=z.strictObject({version:z.literal(1),sourceExecutionId:identifier,sourceGeneration:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),snapshotSha256:resumeHash,released:nativeReference,originalOutcome:nativeReference,originalTask:nativeReference,sourceTask:nativeReference,review:nativeReference,inspection:nativeReference,inspectionRequestSha256:resumeHash,leaseId:z.string().regex(/^[A-Za-z0-9_-]{43}$/),inspectorSha256:resumeHash,sessionStateSha256:resumeHash,lastRunId:identifier,consumption:releasedConsumptionSchema,process:z.discriminatedUnion('kind',[normal,recovered]),callbackDisposition:z.literal('source_owner_exited'),nativeTerminalObserved:z.boolean(),inspectionSeal:seal});
export const finalizerBindingSchema=agentReviewBindingSchema;
