// Copyright (c) Ray Zhang. Shared CLI/MCP client; credentials stay local.
import { mkdirSync, readFileSync, existsSync, openSync, closeSync, fsyncSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { submitSchema } from '../contracts/protocol.ts';

const configSchema = z.strictObject({ server: z.string().url(), token: z.string().min(32), development: z.boolean() });
export type ControllerConfig = z.infer<typeof configSchema>;
export function controllerDirectory() {
  return resolve(process.env.REACH_CONTROLLER_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'state'), 'RY', 'Reach', 'controller'));
}
export function protectDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const user = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8' });
    const sid = user.stdout?.match(/S-1-[0-9-]+/)?.[0];
    if (user.status !== 0 || !sid) throw new Error('Cannot determine local credential owner');
    const acl = spawnSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { windowsHide: true, encoding: 'utf8' });
    if (acl.status !== 0) throw new Error('Cannot protect local controller credentials');
  }
}
export function validateOrigin(server: string, development = false) {
  const url = new URL(server);
  if (![url.origin, `${url.origin}/reach`].includes(server) || url.username || url.password || url.search || url.hash) throw new Error('Reach server must be a canonical origin, optionally followed by /reach');
  if (url.protocol !== 'https:' && !(development && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Reach requires HTTPS; explicit development accepts literal loopback only');
  return server;
}
export function saveConfig(input: ControllerConfig, directory = controllerDirectory()) {
  const config = configSchema.parse(input); validateOrigin(config.server, config.development); protectDirectory(directory);
  const path = join(directory, 'session.json');
  const fd = openSync(path, 'w', 0o600);
  try { writeSync(fd, JSON.stringify(config)); fsyncSync(fd); } finally { closeSync(fd); }
}
export function loadConfig(directory = controllerDirectory()): ControllerConfig {
  const value = configSchema.parse(JSON.parse(readFileSync(join(directory, 'session.json'), 'utf8')));
  validateOrigin(value.server, value.development); return value;
}
export class ApiError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string) { super(`Reach HTTP ${status}: ${code}`); this.status = status; this.code = code; }
}
export class ReachClient {
  readonly config: ControllerConfig;
  readonly directory: string;
  constructor(config: ControllerConfig, directory = controllerDirectory()) {
    validateOrigin(config.server, config.development); this.config = config; this.directory = directory;
  }
  async request(route: string, method = 'GET', data?: unknown): Promise<any> {
    let response: Response;
    try {
      response = await fetch(this.config.server + route, { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json', ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
    } catch { throw new Error('Reach transport unavailable; keep the original requestId and query or retry that same request'); }
    const chunks: Uint8Array[] = []; let size = 0;
    if (!response.body) throw new Error('Reach response has no body');
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length; if (size > 2_097_152) { await reader.cancel(); throw new Error('Reach response exceeds 2 MiB; retrieve smaller event or file ranges'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok) throw new ApiError(response.status, value?.error?.code ?? 'request_failed');
    return value;
  }
  async submit(input: unknown) {
    const request = submitSchema.parse(input);
    // Preserve a recoverable submission before contacting the service. A retry
    // of this request ID must retain the exact original command and target.
    const intents = join(this.directory, 'requests'); protectDirectory(intents);
    const path = join(intents, `${request.requestId}.json`);
    const intent = JSON.stringify({ server: this.config.server, request });
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeSync(fd, intent); fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if (readFileSync(path, 'utf8') !== intent) throw new Error('requestId already belongs to different input; original submission retained');
    }
    try { return await this.request('/api/v1/operations', 'POST', request); }
    catch (error) { throw new Error(`${error instanceof Error ? error.message : 'Submission failed'}; requestId=${request.requestId}`); }
  }
  savedRequests() {
    // Reading an original input is explicit; routine discovery never prints it.
    return { directory: join(this.directory, 'requests'), retained: existsSync(join(this.directory, 'requests')) };
  }
}
