// Copyright (c) Ray Zhang. Ordinary gen1 native completion, distinct from recovery admission.
import {z} from 'zod';
import {identifier} from './protocol.ts';
import {nativeReference,resumeHash} from './agent-resume.ts';
export const nativeClosureSchema=z.strictObject({
  version:z.literal(1),snapshotSha256:resumeHash,lastRunId:identifier,observedCalls:z.number().int().min(1).max(32),
  task:nativeReference,terminal:nativeReference,outcome:nativeReference,processOwner:nativeReference,processOwnerJson:z.string().min(2).max(16384),
  processSettled:nativeReference,processSettledJson:z.string().min(2).max(32768),
});
