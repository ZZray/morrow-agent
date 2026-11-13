// Copyright (c) Ray Zhang. Caller feedback for the exact original Run candidate.
import {z} from 'zod';
import {identifier} from './protocol.ts';
const hash=z.string().regex(/^[a-f0-9]{64}$/),count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const agentReviewBindingSchema=z.strictObject({dispatchId:identifier,payloadHash:hash});
export const agentReviewBasisSchema=z.strictObject({task_id:identifier,criteria_revision:z.literal('reach-receipt-integrity-v1'),authorization_revision:hash,run_id:identifier,run_number:z.number().int().min(1).max(4),session_path:z.string().min(1).max(32768),events_path:z.string().min(1).max(32768),events_sha256:hash,event_count:count,run_calls:count,total_calls:count,journal_head_sha256:hash,raw_start:count,raw_end:count,raw_proof:z.string().regex(/^journal-v1:[a-f0-9]{64}$/)});
export const agentCandidateSchema=z.strictObject({basis:agentReviewBasisSchema,output:z.string().max(262144),goal:z.json().nullable()});
export const agentBudgetSnapshotSchema=z.strictObject({basis:agentReviewBasisSchema,diagnostic_output:z.string().max(262144),goal:z.json().nullable(),termination:z.strictObject({version:z.literal(1),cause:z.literal('call_budget_exhausted'),native_round_closed:z.literal(true),model_final_stop:z.literal(false)})});
export const agentReviewPublishSchema=agentReviewBindingSchema.extend({candidate:agentCandidateSchema.optional(),snapshot:agentBudgetSnapshotSchema.optional(),childOperationIds:z.array(identifier).max(16)}).superRefine((v,c)=>{if((v.candidate===undefined)===(v.snapshot===undefined))c.addIssue({code:'custom',message:'Exactly one native review subject is required'});});
export const agentReviewDecisionSchema=z.strictObject({reviewId:identifier,runId:identifier,basisSha256:hash,decision:z.enum(['continue','return_result']),feedback:z.string().max(32000).default('')}).superRefine((v,c)=>{if((v.decision==='continue'&&!v.feedback.trim())||(v.decision==='return_result'&&v.feedback!==''))c.addIssue({code:'custom',path:['feedback'],message:'continue requires feedback; return_result has no correction'});});
export const agentRunRegistrationSchema=agentReviewBindingSchema.extend({runId:identifier});
