// Copyright (c) Ray Zhang. Independent local controller command.
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { identifier } from '../contracts/protocol.ts';
import { controllerDirectory, loadConfig, saveConfig, validateOrigin, ReachClient } from './client.ts';
import { serveMcp } from './mcp.ts';
import { downloadArtifact, readArtifactRange } from './artifacts.ts';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { server: { type: 'string' }, username: { type: 'string' }, development: { type: 'boolean', default: false }, after: { type: 'string', default: '0' }, limit: { type: 'string', default: '64' }, output: { type: 'string' }, offset: { type: 'string', default: '0' }, length: { type: 'string', default: '65536' } } });
  const [command, argument] = positionals;
  const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  if (command === 'request-id') { print({ requestId: randomUUID() }); return; }
  if (command === 'login') {
    if (!values.server || !values.username || !process.env.REACH_PASSWORD) throw new Error('login requires --server, --username and REACH_PASSWORD in the process environment');
    const config = { server: validateOrigin(values.server, values.development), token: '', development: values.development };
    const response = await new ReachClient(config).request('/api/v1/auth/login', 'POST', { username: values.username, password: process.env.REACH_PASSWORD });
    saveConfig({ ...config, token: response.token }); print({ loggedIn: true, server: config.server }); return;
  }
  if (!command || command === 'help') {
    process.stdout.write('Reach controller: login --server ORIGIN --username NAME [--development] (REACH_PASSWORD env), logout, nodes, pair-code, protocol, request-id, call INPUT.json, operation ID, agent-task ID, agent-reviews ID, agent-review INPUT.json, agent-models ID, agent-model-stop INPUT.json, events ID [--after N], artifacts OPERATION_ID, artifact OPERATION_ID ARTIFACT_ID --output NEW_FILE, artifact-range OPERATION_ID ARTIFACT_ID [--offset N --length N], cancel ID, unpair NODE_ID, reconcile INPUT.json, library-list/read/source/propose/validate/review INPUT.json, mcp\n'); return;
  }
  const directory = controllerDirectory(); const client = new ReachClient(loadConfig(directory), directory);
  switch (command) {
    case 'mcp': await serveMcp(client); return;
    case 'nodes': print(await client.request('/api/v1/nodes')); return;
    case 'protocol': print(await client.request('/api/v1/protocol')); return;
    case 'library-list':
    case 'library-read':
    case 'library-source':
    case 'library-propose':
    case 'library-validate':
    case 'library-review':{if(!argument)throw Error(command+' requires an input JSON file');const {invoke}=await import('./mcp.ts');print(await invoke(client,'reach_'+command.replaceAll('-','_'),JSON.parse(readFileSync(argument,'utf8'))));return;}
    case 'pair-code': print(await client.request('/api/v1/pairing-codes', 'POST', {})); return;
    case 'call': if (!argument) throw new Error('call requires an input JSON file'); print(await client.submit(JSON.parse(readFileSync(argument, 'utf8')))); return;
    case 'operation': print(await client.request(`/api/v1/operations/${identifier.parse(argument)}`)); return;
    case 'agent-reviews':print(await client.request(`/api/v1/operations/${identifier.parse(argument)}/agent-reviews`));return;
    case 'agent-models':print(await client.request(`/api/v1/operations/${identifier.parse(argument)}/agent-models`));return;
    case 'agent-task':print(await client.request(`/api/v1/operations/${identifier.parse(argument)}/agent-task`));return;
    case 'agent-model-stop':{if(!argument)throw Error('agent-model-stop requires an input JSON file');const {invoke}=await import('./mcp.ts');print(await invoke(client,'reach_agent_model_stop',JSON.parse(readFileSync(argument,'utf8'))));return;}
    case 'agent-review':{if(!argument)throw Error('agent-review requires an input JSON file');const {invoke}=await import('./mcp.ts');print(await invoke(client,'reach_agent_review',JSON.parse(readFileSync(argument,'utf8'))));return;}
    case 'artifacts': print(await client.request(`/api/v1/operations/${identifier.parse(argument)}/artifacts`)); return;
    case 'artifact': {
      if (!values.output) throw new Error('artifact requires --output NEW_FILE');
      const { binding, manifest, bytes } = await downloadArtifact(client, identifier.parse(argument), identifier.parse(positionals[2]));
      const output = resolve(values.output); writeFileSync(output, bytes, { flag: 'wx' });
      print({ binding, manifest, output, bytesWritten: bytes.length }); return;
    }
    case 'artifact-range': print(await readArtifactRange(client, identifier.parse(argument), identifier.parse(positionals[2]), Number(values.offset), Number(values.length))); return;
    case 'events': {
      const after = Number(values.after); if (!Number.isSafeInteger(after) || after < 0) throw new Error('after must be a nonnegative sequence');
      const limit = Number(values.limit); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be 1 to 200');
      print(await client.request(`/api/v1/operations/${identifier.parse(argument)}/events?after=${after}&limit=${limit}`)); return;
    }
    case 'cancel': print(await client.request(`/api/v1/operations/${identifier.parse(argument)}/cancel`, 'POST', {})); return;
    case 'unpair': print(await client.request(`/api/v1/nodes/${identifier.parse(argument)}/unpair`, 'POST', {})); return;
    case 'reconcile': {
      if (!argument) throw new Error('reconcile requires an input JSON file');
      const { invoke } = await import('./mcp.ts'); print(await invoke(client, 'reach_reconcile', JSON.parse(readFileSync(argument, 'utf8')))); return;
    }
    case 'logout': await client.request('/api/v1/auth/logout', 'POST', {}); unlinkSync(join(directory, 'session.json')); print({ loggedOut: true }); return;
    default: throw new Error('Unknown controller command; run help');
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Reach controller failed'); process.exitCode = 1; });
