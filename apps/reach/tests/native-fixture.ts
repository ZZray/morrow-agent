// Copyright (c) Ray Zhang. Tests the ordinary Rust executable and HTTP service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync, linkSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { createServer as createPipeServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const binary = process.env.REACH_NODE_BINARY;
assert.ok(binary && existsSync(binary), 'Set REACH_NODE_BINARY to the built ordinary reach executable');
const executable: string = binary;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const ps = (text: string) => `'${text.replaceAll("'", "''")}'`;
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 20000): Promise<T> {
  const end = Date.now() + timeout;
  let last: T;
  do { last = await read(); if (accept(last)) return last; await delay(80); } while (Date.now() < end);
  assert.fail(`Condition did not settle: ${JSON.stringify(last)}`);
}
function launch(args: string[], env = process.env, program = executable) {
  const child = spawn(program, args, { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-32768); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-32768); });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }));
  });
  return { child, done, logs: () => ({ stdout, stderr, exitCode: child.exitCode }) };
}
async function kill(child: ChildProcess | undefined) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }
}
type Intercept = (request: IncomingMessage, response: ServerResponse, bytes: Buffer, forward: () => Promise<Response>) => Promise<boolean>;
export async function fixture(prefix = '', nodeEnv = process.env, retainedRoot?: string, serviceEnv = process.env, serviceMain = 'src/service/main.ts') {
  const evidenceRoot=process.env.REACH_NATIVE_EVIDENCE_ROOT;if(evidenceRoot){assert.ok(isAbsolute(evidenceRoot),'Native evidence root must be absolute');mkdirSync(evidenceRoot,{recursive:true});}
  const root = retainedRoot ?? mkdtempSync(join(evidenceRoot??tmpdir(), 'reach-native-'));
  const state = join(root, 'node');
  const serviceHistory:ChildProcess[]=[];
  const spawnService = () => {const child=spawn(process.execPath, [serviceMain], {
    cwd: resolve(import.meta.dirname, '..'), windowsHide: true,
    env: { ...serviceEnv, REACH_DATA_DIR: join(root, 'service'), REACH_PORT: '0', REACH_DEVELOPMENT: '1', REACH_PUBLIC_ORIGIN: 'http://127.0.0.1', REACH_BOOTSTRAP_USERNAME: 'native-test', REACH_BOOTSTRAP_PASSWORD: 'native-test-fixture-password', REACH_TRUSTED_PROXY_ADDRESSES: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });serviceHistory.push(child);return child;};
  let service = spawnService();
  let serviceOrigin = '', serviceErrors = '';
  async function readyService() {
  serviceOrigin = '';
  service.stderr.on('data', value => { serviceErrors += String(value); });
  const lines = createInterface({ input: service.stdout });
  const started = setTimeout(() => service.kill('SIGKILL'), 15000);
  try {
    for await (const line of lines) {
      const item = JSON.parse(line);
      if (item.event === 'reach_listening') { serviceOrigin = `http://127.0.0.1:${item.port}`; break; }
    }
    assert.ok(serviceOrigin, serviceErrors);
  } finally { clearTimeout(started); lines.close(); }
  }
  try { await readyService(); } catch(error) { await kill(service); throw error; }
  let intercept: Intercept | undefined;
  const proxy = createServer(async (request, response) => {
    try {
      if (prefix && !request.url?.startsWith(`${prefix}/`)) { response.writeHead(404); response.end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const forward = () => fetch(serviceOrigin + (request.url ?? '').slice(prefix.length), {
        method: request.method, headers: { 'content-type': 'application/json', ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),...Object.fromEntries(Object.entries(request.headers).filter(([key,value])=>key.startsWith('x-reach-')&&typeof value==='string')) as Record<string,string> },
        ...(bytes.length ? { body: bytes } : {}),
      });
      if (intercept && await intercept(request, response, bytes, forward)) return;
      const upstream = await forward();
      if(upstream.headers.get('content-type')?.startsWith('text/event-stream')){response.writeHead(upstream.status,{'content-type':'text/event-stream',connection:'close'});for await(const bytes of upstream.body!){response.write(bytes);}response.end();return;}
      const payload = await upstream.arrayBuffer();
      response.writeHead(upstream.status, { 'content-type': 'application/json' }); response.end(Buffer.from(payload));
    } catch { response.destroy(); }
  });
  try { proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening'); }
  catch(error) { await kill(service); throw error; }
  const address = proxy.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}${prefix}`;
  let token = '';
  async function request(path: string, method = 'GET', data?: unknown, credential = token) {
    const result = await fetch(serviceOrigin + path, { method, headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
    const value = await result.json() as any;
    assert.ok(result.ok, `${result.status}: ${JSON.stringify(value)}`); return value;
  }
  try { token = (await request('/api/v1/auth/login', 'POST', { username: 'native-test', password: 'native-test-fixture-password' })).token; }
  catch(error) { proxy.close();proxy.closeAllConnections();await once(proxy,'close');await kill(service);throw error; }
  const children: ChildProcess[] = [];
  const node = (...args: string[]) => { const child = launch(['--state-dir', state, ...args], nodeEnv); children.push(child.child); return child; };
  const controllerEnv: NodeJS.ProcessEnv = { ...process.env, REACH_CONTROLLER_DIR: join(root, 'controller') };
  const controllerMain = resolve(import.meta.dirname, '../src/controller/main.ts');
  const controller = (args: string[], env = controllerEnv) => { const child = launch([controllerMain, ...args], env, process.execPath); children.push(child.child); return child; };
  async function pair(code?: string) {
    const pairingCode: string = code ?? (await request('/api/v1/pairing-codes', 'POST', {})).code;
    return node('pair', '--server', origin, '--code', pairingCode, '--name', 'Native test', '--development').done;
  }
  function sql<T>(read: (db: DatabaseSync) => T) {
    const db = new DatabaseSync(join(state, 'node.sqlite')); try { db.exec("PRAGMA busy_timeout=5000"); return read(db); } finally { db.close(); }
  }
  function identity() { return sql(db => JSON.parse((db.prepare("SELECT value FROM config WHERE key='identity'").get() as { value: string }).value)); }
  const operation = (id: string) => request(`/api/v1/operations/${id}`);
  const events = async (id: string) => (await request(`/api/v1/operations/${id}/events`)).events as any[];
  const submit = async (command: { kind: string; [key: string]: unknown }, requestId = randomUUID()) => {
    const nodeId = identity().node_id;
    await until(() => request('/api/v1/nodes'), value => value.nodes.some((n: any) => n.id === nodeId && n.capabilities.includes(command.kind)));
    return request('/api/v1/operations', 'POST', { nodeId, requestId, command });
  };
  async function settled(id: string) { return until(() => operation(id), value => ['succeeded', 'failed', 'unknown', 'cancelled'].includes(value.execution), 30000); }
  return {
    root, state, origin, request, node, pair, sql, identity, operation, events, submit, settled, controller,
    serviceProcesses:()=>serviceHistory.map(child=>({pid:child.pid,exitCode:child.exitCode,signalCode:child.signalCode})),
    async restartService() { await kill(service); service=spawnService(); await readyService(); },
    loginController: () => controller(['login', '--server', origin, '--username', 'native-test', '--development'], { ...controllerEnv, REACH_PASSWORD: 'native-test-fixture-password' }).done,
    mcp() {
      const child = spawn(process.execPath, [controllerMain, 'mcp'], { windowsHide: true, env: controllerEnv, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
      const readers = new Map<number, (value: any) => void>(); let nextId = 0;
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => { const message = JSON.parse(line); readers.get(message.id)?.(message); readers.delete(message.id); });
      return {
        child,
        call(method: string, params: unknown = {}) {
          const id = ++nextId;
          return new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => { readers.delete(id); reject(new Error(`MCP ${method} timed out`)); }, 20000);
            readers.set(id, value => { clearTimeout(timer); resolve(value); });
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
          });
        },
      };
    },
    intercept(value?: Intercept) { intercept = value; },
    async cleanup() {
      for (const child of children) await kill(child);
      proxy.close(); proxy.closeAllConnections(); await once(proxy, 'close'); await kill(service);
      if (evidenceRoot){writeFileSync(join(root,'fixture-exit.json'),JSON.stringify({root,service:{pid:service.pid,exitCode:service.exitCode,signalCode:service.signalCode},serviceHistory:serviceHistory.map(child=>({pid:child.pid,exitCode:child.exitCode,signalCode:child.signalCode})),children:children.map(child=>({pid:child.pid,exitCode:child.exitCode,signalCode:child.signalCode}))},null,2));console.log(JSON.stringify({nativeEvidence:root}));}
      if (retainedRoot||evidenceRoot) return;
      assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('reach-native-'));
      rmSync(root, { recursive: true, force: true });
    },
  };
}


export { until, launch, kill, delay, digest, ps, executable };
