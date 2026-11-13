// Copyright (c) Ray Zhang. MCP stdio transport for local coding agents.
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { identifier, submitSchema, reconciliationSchema, desktopCallSchema } from '../contracts/protocol.ts';
import { ReachClient } from './client.ts';
import { artifactIdentity, downloadArtifact, readArtifactRange } from './artifacts.ts';
import {agentReviewDecisionSchema} from '../contracts/agent-review.ts';
import {agentModelStopSchema} from '../contracts/agent-model-stop.ts';
import {libraryListSchema,libraryProposalSchema,librarySourceSchema,libraryValidationSchema,libraryReviewSchema} from '../contracts/source-library.ts';

const empty = z.strictObject({});
const operation = z.strictObject({ operationId: identifier });
const libraryEntry=z.strictObject({entryId:identifier});
const definitions = [
  { name: 'reach_nodes', description: 'List paired Reach machines and their actual connectivity and implemented capabilities.', schema: empty, readOnly: true },
  { name: 'reach_protocol', description: 'Read versioned command and receipt schemas for this Reach service.', schema: empty, readOnly: true },
  {name:'reach_library_list',description:'List metadata of adopted device-scoped sources by default. No automatic Task injection. Explicit state selects unadopted candidates or revoked history.',schema:libraryListSchema,readOnly:true},
  {name:'reach_library_read',description:'Read an exact source version and its provenance, execution evidence and controller review history. Historical text is not a current adoption grant.',schema:libraryEntry,readOnly:true},
  {name:'reach_library_source',description:'Explicitly retrieve the exact source declaration for a Task. candidate stage is unadopted validation/reference data; adopted stage requires a current adoption. Keep library reference fields intact. No tools are executed.',schema:libraryEntry.extend(librarySourceSchema.shape),readOnly:true},
  {name:'reach_library_propose',description:'Register controller-authored skill or knowledge based on original completed Task evidence. Remains a candidate; one successful Task never adopts it. Keep requestId stable.',schema:libraryProposalSchema,readOnly:false},
  {name:'reach_library_validate',description:'Associate a different real completed Task that explicitly selected this candidate version. Service checks native Released/join and actual child receipts. Execution evidence alone does not prove semantic correctness or adopt knowledge.',schema:libraryEntry.extend(libraryValidationSchema.shape),readOnly:false},
  {name:'reach_library_review',description:'External authenticated controller explicitly adopts an exact candidate and validation receipt with a reason, or revokes it. This records controller review, not proof of human review. Revocation blocks future/queued registered reuse and resumes, preserves history, and does not roll back in-flight effects.',schema:libraryEntry.extend(libraryReviewSchema.shape),readOnly:false},
  { name: 'reach_submit', description: 'Submit a remote action. Generate one UUID requestId and retain it for retries of this exact input. Returns the operation ID; use reach_operation and reach_events to observe effects. Reconnection never means re-executing unknown work.', schema: submitSchema, readOnly: false },
  { name: 'reach_operation', description: 'Read the original operation state and result without executing it again. unknown means effects require reconciliation.', schema: operation, readOnly: true },
  { name: 'reach_agent_reviews', description: 'Read exact Run candidates of a delegated Task. With maxRuns > 1 the original Task waits for caller feedback within its original deadline.', schema: operation, readOnly: true },
  { name: 'reach_agent_models', description: 'Read original model request identities, service-owner evidence and explicit transport-stop receipts. Unknown usage remains unknown.', schema: operation, readOnly: true },
  { name: 'reach_agent_task', description: 'Read original Task identity, fixed deadline, current execution generation and retained historical attempts. reconciling never authorizes model or tool execution.', schema: operation, readOnly: true },
  { name: 'reach_agent_model_stop', description: 'Stop and join one exact unknown model transport of an inactive original Task, then persist an evidence-backed receipt. Keep reconciliationId stable. Does not replay, refund, accept or resume the Task; ownerless legacy requests remain blocked.', schema: operation.extend(agentModelStopSchema.shape), readOnly: false },
  { name: 'reach_agent_review', description: 'Submit feedback for an exact candidate using its runId and basisSha256. continue requires correction feedback; return_result releases the result for review, without accepting the business Task. Retain reviewId for retries; budgets and deadline do not reset.', schema:operation.extend(agentReviewDecisionSchema.shape),readOnly:false },
  { name: 'reach_artifacts', description: 'List original operation artifacts, including whether their bytes are fully uploaded. Incomplete evidence never authorizes replay.', schema: operation, readOnly: true },
  { name: 'reach_artifact', description: 'Read an original artifact. PNG returns a verified MCP image; text and files return metadata and one bounded byte range. Follow nextOffset with reach_artifact_range for further content. Never repeats the original action.', schema: operation.extend({ artifactId: identifier }), readOnly: true },
  { name: 'reach_artifact_range', description: 'Read and verify at most 64 KiB of original artifact bytes. Base64 is exact; optional text is present only when the range has complete UTF-8 characters. Use nextOffset/eof to continue without executing tools again.', schema: operation.extend({ artifactId: identifier, offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), length: z.number().int().min(1).max(65536).default(65536) }), readOnly: true },
  { name: 'reach_desktop_call', description: 'Submit one desktop tool call using the generation/session/snapshot from the original describe or capture receipt. Keep requestId stable; read the operation and fetch referenced artifacts separately. A new action consumes its snapshot.', schema: desktopCallSchema.omit({kind:true,argumentsJson:true}).extend({ requestId:identifier,nodeId:identifier,arguments:z.record(z.string(),z.json()) }), readOnly: false },
  { name: 'reach_events', description: 'Read original ordered receipts after a sequence cursor. Use returned nextAfter and hasMore for further pages. Base64 contains original bytes; pagination never executes tools.', schema: operation.extend({ after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), limit: z.number().int().min(1).max(200).default(64) }), readOnly: true },
  { name: 'reach_cancel', description: 'Request cancellation; inspect the original operation for actual process and effect settlement. A cancellation request is not a rollback.', schema: operation, readOnly: false },
  { name: 'reach_reconcile', description: 'Record an explicit evidence-backed decision for an unknown original action. Does not execute or retry it; preserve dispatchId and payloadHash from that operation.', schema: operation.extend(reconciliationSchema.shape), readOnly: false },
] as const;
export async function invoke(client: ReachClient, name: string, args: unknown) {
  const definition = definitions.find(tool => tool.name === name);
  if (!definition) throw new Error('Unknown Reach tool');
  const input: any = definition.schema.parse(args ?? {});
  switch (name) {
    case 'reach_nodes': return client.request('/api/v1/nodes');
    case 'reach_protocol': return client.request('/api/v1/protocol');
    case 'reach_library_list':return client.request(`/api/v1/library?${new URLSearchParams({nodeId:input.nodeId,epoch:String(input.epoch),state:input.state})}`);
    case 'reach_library_read':return client.request(`/api/v1/library/${input.entryId}`);
    case 'reach_library_propose':return client.request('/api/v1/library','POST',input);
    case 'reach_library_source':
    case 'reach_library_validate':
    case 'reach_library_review':{const {entryId,...body}=input;const action=name.slice('reach_library_'.length);return client.request(`/api/v1/library/${entryId}/${action}`,'POST',body);}
    case 'reach_submit': return client.submit(input);
    case 'reach_operation': return client.request(`/api/v1/operations/${input.operationId}`);
    case 'reach_agent_reviews':return client.request(`/api/v1/operations/${input.operationId}/agent-reviews`);
    case 'reach_agent_models':return client.request(`/api/v1/operations/${input.operationId}/agent-models`);
    case 'reach_agent_task':return client.request(`/api/v1/operations/${input.operationId}/agent-task`);
    case 'reach_agent_model_stop':{const {operationId,...stop}=input;return client.request(`/api/v1/operations/${operationId}/agent-models`,'POST',stop);}
    case 'reach_agent_review':{const {operationId,...review}=input;agentReviewDecisionSchema.parse(review);return client.request(`/api/v1/operations/${operationId}/agent-reviews`,'POST',review);}
    case 'reach_artifacts': return client.request(`/api/v1/operations/${input.operationId}/artifacts`);
    case 'reach_artifact': {
      const identity = await artifactIdentity(client, input.operationId, input.artifactId);
      if (identity.manifest.mimeType !== 'image/png') {
        const range = await readArtifactRange(client, input.operationId, input.artifactId);
        return { content: [{ type: 'text', text: JSON.stringify(range) }] };
      }
      const { binding, manifest, bytes } = await downloadArtifact(client, input.operationId, input.artifactId);
      return { content: [{ type: 'text', text: JSON.stringify({binding,manifest}) }, { type: 'image', mimeType: manifest.mimeType, data: bytes.toString('base64') }] };
    }
    case 'reach_artifact_range': return readArtifactRange(client, input.operationId, input.artifactId, input.offset, input.length);
    case 'reach_desktop_call': {
      const {requestId,nodeId,arguments:args,...command} = input;
      return client.submit({requestId,nodeId,command:{...command,kind:'desktop.call',argumentsJson:JSON.stringify(args)}});
    }
    case 'reach_events': return client.request(`/api/v1/operations/${input.operationId}/events?after=${input.after}&limit=${input.limit}`);
    case 'reach_cancel': return client.request(`/api/v1/operations/${input.operationId}/cancel`, 'POST', {});
    case 'reach_reconcile': {
      const { operationId, ...reconciliation } = input;
      return client.request(`/api/v1/operations/${operationId}/reconcile`, 'POST', reconciliation);
    }
  }
}
export async function serveMcp(client: ReachClient) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  for await (const line of lines) {
    let message: any;
    try {
      if (Buffer.byteLength(line) > 2_097_152) throw new Error('frame too large');
      message = JSON.parse(line);
    } catch { output({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC frame' } }); continue; }
    if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') { output({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } }); continue; }
    if (message.id === undefined) continue;
    const reply = (result: unknown) => output({ jsonrpc: '2.0', id: message.id, result });
    switch (message.method) {
      case 'initialize': reply({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'ry-reach', version: '0.1.0-dev.1' }, instructions: 'Read the target capabilities. Keep request IDs stable across transport retries. unknown results require evidence; never submit a fresh action just to resolve uncertainty.' }); break;
      case 'ping': reply({}); break;
      case 'tools/list': reply({ tools: definitions.map(tool => ({ name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(tool.schema), annotations: { readOnlyHint: tool.readOnly, openWorldHint: true } })) }); break;
      case 'tools/call':
        try { const result = await invoke(client, message.params?.name, message.params?.arguments); reply(message.params?.name === 'reach_artifact' ? result : { content: [{ type: 'text', text: JSON.stringify(result) }] }); }
        catch (error) { reply({ isError: true, content: [{ type: 'text', text: error instanceof z.ZodError ? 'Tool arguments do not match the Reach schema' : error instanceof Error ? error.message : 'Reach call failed' }] }); }
        break;
      default: output({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
}
