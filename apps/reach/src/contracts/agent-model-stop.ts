// Copyright (c) Ray Zhang. Explicit evidence-backed stopping of one original model transport.
import {z} from 'zod';
import {identifier} from './protocol.ts';
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const agentModelStopSchema=z.strictObject({reconciliationId:identifier,dispatchId:identifier,payloadHash:hash,requestId:identifier,runId:identifier,bodySha256:hash,ownerInstanceId:identifier,decision:z.literal('transport_stopped'),evidence:z.string().min(10).max(16000).refine(s=>!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s),'Expected valid original evidence text')});
