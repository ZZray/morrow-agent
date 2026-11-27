import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { readCheckedJsonReference } from './client.mjs';

const FRAME_BYTES = 262144;
const STDERR_BYTES = 65536;
const RESULT_BYTES = 64 * 1024 * 1024;
const ENVIRONMENT_KEYS = ['PATH', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL',
  'SystemDrive', 'ProgramData', 'ALLUSERSPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATHEXT', 'ComSpec'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

export class ManagementError extends Error {
  constructor(message, delivery = 'unknown') {
    super(message);
    this.name = 'ManagementError';
    // A transport failure can follow a committed mutation. Inspect the original
    // store before deciding whether to repeat the request.
    this.delivery = delivery;
  }
}

function decode(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!/^[^\r\n]+\r?\n$/.test(text)) throw new ManagementError('management response framing invalid');
  const value = JSON.parse(text);
  // Scan the validated JSON grammar, decoding keys so escaped aliases cannot
  // replace an earlier field. JSON.parse itself accepts duplicate fields.
  const stack = [];
  for (const [token] of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
    if (token === '{') stack.push({ keys: new Set(), key: true });
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && stack.at(-1)) stack.at(-1).key = true;
    else if (token.startsWith('"') && stack.at(-1)?.key) {
      const current = stack.at(-1);
      const key = JSON.parse(token);
      if (current.keys.has(key)) throw new ManagementError('duplicate management response field');
      current.keys.add(key);
      current.key = false;
    }
  }
  return value;
}

export async function sendManagement({ binary, binaryArgs = [], request, timeoutMs = 15000, env = {} }) {
  if (typeof binary !== 'string' || !path.isAbsolute(binary) || !object(request)
    || typeof request.operation !== 'string' || !request.operation || !Array.isArray(binaryArgs)
    || binaryArgs.some((argument) => typeof argument !== 'string') || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 120000 || !object(env)) throw new ManagementError('invalid management options', 'not_started');
  const id = request.id ?? randomUUID();
  if (typeof id !== 'string' || !id || id.length > 256 || id.trim() !== id || /[\x00-\x1f\x7f]/.test(id)) {
    throw new ManagementError('invalid management request ID', 'not_started');
  }
  const { id: _id, ...operation } = request;
  const bytes = Buffer.from(`${JSON.stringify({ kind: 'manage', version: 1, id, request: operation })}\n`);
  if (bytes.length > FRAME_BYTES) throw new ManagementError('management frame exceeds protocol bound', 'not_started');
  const childEnv = {};
  for (const key of Object.keys(env)) {
    if (!ENVIRONMENT_KEYS.includes(key) || typeof env[key] !== 'string') throw new ManagementError('unsupported management environment override', 'not_started');
  }
  for (const key of ENVIRONMENT_KEYS) {
    const value = env[key] ?? process.env[key];
    if (typeof value === 'string') childEnv[key] = value;
  }

  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(binary, binaryArgs, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv }); }
    catch { reject(new ManagementError('management sidecar spawn failed', 'not_started')); return; }
    let fault;
    let outputBytes = 0;
    let errorBytes = 0;
    const chunks = [];
    const fail = (message) => {
      fault ??= new ManagementError(message);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => fail('management request timed out; inspect state before retrying'), timeoutMs);
    child.on('error', () => { fault ??= new ManagementError('management sidecar spawn failed', 'not_started'); });
    child.stdin.on('error', () => fail('management request write failed'));
    child.stdout.on('error', () => fail('management response read failed'));
    child.stderr.on('error', () => fail('management diagnostics read failed'));
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > FRAME_BYTES) { fail('management response exceeds protocol bound'); return; }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errorBytes += chunk.length;
      if (errorBytes > STDERR_BYTES) fail('management diagnostics exceed protocol bound');
    });
    child.once('close', async (code, signal) => {
      clearTimeout(timer);
      if (fault) { reject(fault); return; }
      if (code !== 0 || signal) { reject(new ManagementError('management sidecar failed')); return; }
      try {
        const reply = decode(Buffer.concat(chunks, outputBytes));
        if (!object(reply) || reply.kind !== 'management_result' || reply.version !== 1 || reply.id !== id || typeof reply.ok !== 'boolean') {
          throw new ManagementError('management response identity mismatch');
        }
        if (reply.ok) {
          if (exact(reply, ['kind', 'version', 'id', 'ok', 'value'])) resolve(reply.value);
          else if (exact(reply, ['kind', 'version', 'id', 'ok', 'value_ref'])) {
            let directory;
            if (['context_snapshot', 'context_command', 'context_add_reference', 'goal_snapshot', 'goal_control', 'job_snapshot'].includes(request.operation)
              && typeof request.session === 'string' && path.isAbsolute(request.session)) directory = `${request.session}.management`;
            else if (['queue_snapshot', 'queue_events', 'queue_cancel', 'queue_watchdog', 'queue_enqueue'].includes(request.operation)
              && typeof request.directory === 'string' && path.isAbsolute(request.directory)) directory = path.join(request.directory, 'management-results');
            else if (request.operation === 'provenance_query' && Array.isArray(request.scopes) && request.scopes.length === 1
              && typeof request.scopes[0]?.evidence_dir === 'string' && path.isAbsolute(request.scopes[0].evidence_dir)) {
              directory = path.join(request.scopes[0].evidence_dir, 'management-results');
            }
            if (!directory) throw new ManagementError('unexpected management result reference');
            resolve(await readCheckedJsonReference(reply.value_ref, directory, RESULT_BYTES));
          } else throw new ManagementError('invalid management response fields');
        } else {
          if (!exact(reply, ['kind', 'version', 'id', 'ok', 'error']) || typeof reply.error !== 'string' || !reply.error) throw new ManagementError('invalid management error response');
          reject(new ManagementError(reply.error, 'validated'));
        }
      } catch (error) { reject(error instanceof ManagementError ? error : new ManagementError('invalid management response JSON')); }
    });
    child.stdin.end(bytes);
  });
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function writeAtomicExclusive(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const handle = await fs.open(file, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { path: await fs.realpath(file), sha256: sha256(bytes) };
}

export async function inspectSession({ binary, binaryArgs = [], request, operationDirectory, timeoutMs = 15000, env = {} }) {
  if (typeof operationDirectory !== 'string' || !path.isAbsolute(operationDirectory)) {
    throw new ManagementError('inspectSession requires an absolute operationDirectory', 'not_started');
  }
  await fs.mkdir(operationDirectory, { recursive: true });
  const response = await sendManagement({
    binary,
    binaryArgs,
    request: { operation: 'session_inspect', request, output_directory: operationDirectory },
    timeoutMs,
    env,
  });
  if (!object(response) || response.kind !== 'session_inspection_result' || !object(response.result_ref)) {
    throw new ManagementError('invalid session_inspection_result payload');
  }
  const record = await readCheckedJsonReference(response.result_ref, operationDirectory, RESULT_BYTES);
  const envelope = { delivery: 'validated', result: record, result_ref: response.result_ref };
  await writeAtomicExclusive(path.join(operationDirectory, 'client-result.json'), envelope);
  return envelope;
}

export async function closeTask({ binary, binaryArgs = [], declarationRef, operationDirectory, timeoutMs = 15000, env = {} }) {
  if (typeof operationDirectory !== 'string' || !path.isAbsolute(operationDirectory)
    || !exact(declarationRef, ['path', 'sha256']) || typeof declarationRef.path !== 'string'
    || !path.isAbsolute(declarationRef.path) || !/^[0-9a-f]{64}$/.test(declarationRef.sha256)) {
    throw new ManagementError('invalid closeTask options', 'not_started');
  }
  await fs.mkdir(operationDirectory, { recursive: true });
  const declDir = path.dirname(declarationRef.path);
  const decl = await readCheckedJsonReference(declarationRef, declDir, 16 * 1024 * 1024);
  const receiptDir = typeof decl?.request?.evidence_dir === 'string' && path.isAbsolute(decl.request.evidence_dir)
    ? decl.request.evidence_dir
    : declDir;
  const result = await sendManagement({
    binary,
    binaryArgs,
    request: { operation: 'settled_task_close', declaration_ref: declarationRef },
    timeoutMs,
    env,
  });
  if (!object(result) || result.kind !== 'settled_task_closed' || result.task_accepted !== false
    || !object(result.close_receipt_ref)) {
    throw new ManagementError('invalid settled_task_closed response');
  }
  await readCheckedJsonReference(result.close_receipt_ref, receiptDir, 16 * 1024 * 1024);
  const envelope = {
    delivery: 'validated',
    declaration_ref: { path: await fs.realpath(declarationRef.path), sha256: declarationRef.sha256 },
    result,
  };
  await writeAtomicExclusive(path.join(operationDirectory, 'client-result.json'), envelope);
  return envelope;
}

export async function readCloseOperation({ declarationRef, operationDirectory }) {
  if (typeof operationDirectory !== 'string' || !path.isAbsolute(operationDirectory)
    || !exact(declarationRef, ['path', 'sha256'])) {
    throw new ManagementError('invalid readCloseOperation options', 'not_started');
  }
  const resultPath = path.join(operationDirectory, 'client-result.json');
  const raw = await fs.readFile(resultPath);
  const stored = await readCheckedJsonReference(
    { path: resultPath, sha256: sha256(raw) },
    operationDirectory,
    16 * 1024 * 1024,
  );
  const expectedPath = await fs.realpath(declarationRef.path);
  if (!object(stored) || stored.delivery !== 'validated'
    || !object(stored.declaration_ref)
    || stored.declaration_ref.sha256 !== declarationRef.sha256
    || (await fs.realpath(stored.declaration_ref.path)) !== expectedPath
    || !object(stored.result) || stored.result.kind !== 'settled_task_closed'
    || stored.result.task_accepted !== false || !object(stored.result.close_receipt_ref)) {
    throw new ManagementError('stored close operation failed verification');
  }
  const decl = await readCheckedJsonReference({ path: expectedPath, sha256: declarationRef.sha256 }, path.dirname(expectedPath), 16 * 1024 * 1024);
  const receiptDir = typeof decl?.request?.evidence_dir === 'string' && path.isAbsolute(decl.request.evidence_dir)
    ? decl.request.evidence_dir
    : path.dirname(expectedPath);
  await readCheckedJsonReference(stored.result.close_receipt_ref, receiptDir, 16 * 1024 * 1024);
  return stored;
}

export async function queryProvenance({ binary, binaryArgs = [], scopes, query = {}, timeoutMs = 15000, env = {} }) {
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 64 || !object(query)) {
    throw new ManagementError('invalid queryProvenance options', 'not_started');
  }
  const entries = [];
  const scope_errors = [];
  for (const scope of scopes) {
    if (!exact(scope, ['task_id', 'session_id', 'evidence_dir'])
      || typeof scope.task_id !== 'string' || !scope.task_id
      || typeof scope.session_id !== 'string' || !scope.session_id
      || typeof scope.evidence_dir !== 'string' || !path.isAbsolute(scope.evidence_dir)) {
      throw new ManagementError('invalid provenance evidence scope', 'not_started');
    }
    const report = await sendManagement({
      binary,
      binaryArgs,
      request: { operation: 'provenance_query', scopes: [scope], query },
      timeoutMs,
      env,
    });
    if (!object(report) || !Array.isArray(report.entries) || !Array.isArray(report.scope_errors)) {
      throw new ManagementError('invalid provenance_query response');
    }
    entries.push(...report.entries);
    scope_errors.push(...report.scope_errors);
  }
  return { entries, scope_errors };
}
