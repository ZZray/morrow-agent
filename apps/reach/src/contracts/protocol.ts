// Copyright (c) Ray Zhang. Reach protocol v1; namespace RY.
import { z } from 'zod';
import { artifactManifestSchema } from './artifacts.ts';

export const PROTOCOL_VERSION = 1;
export const identifier = z.string().uuid();
const path = z.string().min(1).max(32768).refine(v => !v.includes('\0'), 'NUL in path');
const timeout = z.number().int().min(100).max(3_600_000);
export const desktopSessionSchema = z.strictObject({
  sessionId: z.number().int().min(1).max(0xffffffff), userSid: z.string().regex(/^S-1-[0-9-]+$/).max(184),
  logonId: z.string().regex(/^[a-f0-9]{8}:[a-f0-9]{8}$/), windowStation: z.literal('WinSta0'), desktop: z.literal('Default'),
});
export function validDesktopArguments(text: string): boolean {
  const valid = (v: unknown, depth: number): boolean => {
    if (depth > 64) return false;
    if (typeof v === 'string') return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v);
    if (typeof v === 'number') return Number.isFinite(v);
    if (Array.isArray(v)) return v.every(item => valid(item, depth + 1));
    if (v && typeof v === 'object') return Object.entries(v).every(([key, item]) => valid(key, depth + 1) && valid(item, depth + 1));
    return true;
  };
  try { const value = JSON.parse(text); return value !== null && typeof value === 'object' && !Array.isArray(value) && valid(value, 0); }
  catch { return false; }
}
export const desktopCallSchema = z.strictObject({ kind: z.literal('desktop.call'),
  tool: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/), argumentsJson: z.string().max(1_048_576).refine(validDesktopArguments, 'Expected a finite, well-formed JSON object'),
  helperGeneration: identifier, sessionRef: desktopSessionSchema, snapshotId: z.union([identifier, z.literal('')]).default(''),
  timeoutMs: timeout.default(60000),
});
export const basicCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('command.run'), command: z.string().min(1).max(65536), cwd: path.optional(), timeoutMs: timeout.default(60000) }),
  z.strictObject({ kind: z.literal('file.read'), path, offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(1_048_576).default(65536),
    resultFormat: z.literal('artifact').optional(), expectedFileVersion: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  z.strictObject({ kind: z.literal('file.write'), path, contentBase64: z.string().max(1_398_104), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  z.strictObject({ kind: z.literal('directory.list'), path }),
  z.strictObject({ kind: z.literal('desktop.describe'), timeoutMs: timeout.default(60000) }),
  desktopCallSchema,
]);
export const sourceRequirementsSchema=z.strictObject({
  protocolVersion:z.number().int().min(1).max(65535),
  toolContractVersion:z.number().int().min(1).max(65535),
  platforms:z.array(z.enum(['windows','linux','darwin'])).min(1).max(3),
  capabilities:z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/)).max(32),
});
export const libraryReferenceSchema=z.strictObject({id:identifier,versionSha256:z.string().regex(/^[a-f0-9]{64}$/),stage:z.enum(['candidate','adopted'])});
export const sourceSchema=z.strictObject({id:z.string().min(1).max(128),kind:z.enum(['context','skill','knowledge']),source:z.string().min(1).max(2048),revision:z.string().min(1).max(256),sha256:z.string().regex(/^[a-f0-9]{64}$/),text:z.string().max(16384),requirements:sourceRequirementsSchema.optional(),library:libraryReferenceSchema.optional()});
export const delegateSchema=z.strictObject({kind:z.literal('agent.delegate'),sessionId:identifier,cwd:path,objective:z.string().trim().min(1).max(32000),sources:z.array(sourceSchema).max(32).default([]),maxRuns:z.number().int().min(1).max(4).default(1),maxCalls:z.number().int().min(1).max(32).default(8),runCallLimit:z.number().int().min(1).max(32).optional(),maxToolCalls:z.number().int().min(1).max(16).default(8),maxSeconds:z.number().int().min(5).max(600).default(120),maxOutput:z.number().int().min(1).max(8192).default(4096)});
export const resumeSchema=z.strictObject({kind:z.literal('agent.resume'),rootOperationId:identifier,previousExecutionId:identifier,fenceSha256:z.string().regex(/^[a-f0-9]{64}$/),instruction:z.string().min(1).max(16000).refine(v=>v.trim().length>0&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v),'Expected original well-formed recovery instruction')});
export const agentInspectSchema=z.strictObject({kind:z.literal('agent.inspect'),rootOperationId:identifier});
export const agentFinalizeSchema=z.strictObject({kind:z.literal('agent.finalize'),rootOperationId:identifier,previousExecutionId:identifier,sourceExecutionId:identifier,releasedSha256:z.string().regex(/^[a-f0-9]{64}$/)});
export const commandSchema=z.discriminatedUnion('kind',[...basicCommandSchema.options,delegateSchema,resumeSchema,agentInspectSchema,agentFinalizeSchema]);
export const delegatedCallSchema=z.strictObject({dispatchId:identifier,payloadHash:z.string().regex(/^[a-f0-9]{64}$/),runId:identifier,callId:z.string().min(1).max(256),tool:z.literal('reach_execute'),argsSha256:z.string().regex(/^[a-f0-9]{64}$/),argumentsJson:z.string().max(1048576).refine(validDesktopArguments,'Expected original finite tool arguments')});
export type Command = z.infer<typeof commandSchema>;
export const submitSchema = z.strictObject({ requestId: identifier, nodeId: identifier, command: commandSchema });
export const pairingSchema = z.strictObject({ attemptId: identifier, code: z.string().min(8).max(32), installationId: identifier, installationSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/), name: z.string().min(1).max(128), platform: z.enum(['windows', 'linux', 'darwin']), version: z.string().min(1).max(64) });
export const nodeHelloSchema = z.strictObject({ version: z.string().min(1).max(64), capabilities: z.array(z.string().min(1).max(128)).max(128) });
export const operationEventSchema = z.strictObject({
  eventId: identifier,
  operationId: identifier,
  dispatchId: identifier,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  kind: z.enum(['received', 'running', 'output', 'succeeded', 'failed', 'cancelled', 'unknown']),
  data: z.json(),
});
export type OperationEvent = z.infer<typeof operationEventSchema>;
export const reconciliationSchema = z.strictObject({
  reconciliationId: identifier,
  dispatchId: identifier,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['succeeded', 'failed', 'cancelled', 'not_executed']),
  evidence: z.string().min(10).max(16000),
  result: z.json(),
});
export type Reconciliation = z.infer<typeof reconciliationSchema>;
export type ExecutionState = 'not_observed' | 'received' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export type DeliveryState = 'queued' | 'claimed' | 'uncertain' | 'acknowledged' | 'cancelled';
export const finalStates = new Set<ExecutionState>(['succeeded', 'failed', 'cancelled', 'unknown']);
export function protocolDocument() {
  return { version: PROTOCOL_VERSION, submit: z.toJSONSchema(submitSchema), event: z.toJSONSchema(operationEventSchema), pairing: z.toJSONSchema(pairingSchema), reconciliation: z.toJSONSchema(reconciliationSchema), artifact: z.toJSONSchema(artifactManifestSchema) };
}
