// Copyright (c) Ray Zhang.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { starferryCandidateSchema } from '../src/contracts/protocol.ts';
import { loadConfig, ReachClient } from '../src/controller/client.ts';
import { openStarferryTunnel } from '../src/controller/starferry.ts';
import { tunnelCreateInputSchema } from '../src/service/starferry-store.ts';
import { fixture, until } from './native-fixture.ts';
import { startSsh2FixtureServer } from './ssh2-server-fixture.ts';

test('Starferry carries OpenSSH over a single advertised UDP address family', { timeout: 120_000 }, async t => {
  const priorStun = process.env.REACH_STUN_SERVER;
  process.env.REACH_STUN_SERVER = '';
  t.after(() => {
    if (priorStun === undefined) delete process.env.REACH_STUN_SERVER;
    else process.env.REACH_STUN_SERVER = priorStun;
  });
  const workerEnv: NodeJS.ProcessEnv = { ...process.env, NO_PROXY: '127.0.0.1,::1,localhost' };
  const f = await fixture('', workerEnv);
  t.after(() => f.cleanup());
  const authorizedKeysPath = join(f.root, 'starferry_authorized_keys');
  const sshServer = await startSsh2FixtureServer({ authorizedKeysPath, expectedUser: 'sfoperator' });
  t.after(() => sshServer.close());
  const unrelatedKey = sshServer.hostPublicKeyLine + ' unrelated-fixture-key';
  writeFileSync(authorizedKeysPath, unrelatedKey + '\n');
  workerEnv.REACH_DEV_SSH_CONFIG_JSON = JSON.stringify({
    port: sshServer.port, user: 'sfoperator', hostKey: sshServer.hostPublicKeyLine,
    authorizedKeysPath, sharedAdminKeys: false, ready: true,
  });
  assert.equal((await f.loginController()).code, 0);
  assert.equal((await f.pair()).code, 0);
  const nodeId: string = f.identity().node_id;
  f.node('host');
  const nodesSchema = z.object({ nodes: z.array(z.object({ id: z.string(), capabilities: z.array(z.string()) })) });
  await until(async () => nodesSchema.parse(await f.request('/api/v1/nodes')),
    list => list.nodes.some(node => node.id === nodeId && node.capabilities.includes('starferry.session')));

  const directory = join(f.root, 'controller');
  const config = loadConfig(directory);
  for (const [family, loopback] of [['IPv6', '::1'], ['IPv4', '127.0.0.1']] as const) {
    await t.test(family + ' loopback direct SSH', async () => {
      // Preserve each real transport socket's port and discard all other paths at signaling time.
      class SingleFamilyClient extends ReachClient {
        override async request(route: string, method = 'GET', data?: unknown) {
          const creating = route === '/api/v1/tunnels' && method === 'POST';
          if (creating) {
            const input = tunnelCreateInputSchema.parse(data);
            const candidates = input.controllerCandidates.filter(c => c.kind === 'host' && c.host === loopback);
            assert.ok(candidates.length, `Controller did not advertise ${loopback}`);
            data = { ...input, controllerCandidates: candidates };
          }
          const response = await super.request(route, method, data);
          if ((creating || (method === 'GET' && /^\/api\/v1\/tunnels\/[^/]+$/.test(route))) && response.status === 'ready') {
            const advertised = z.array(starferryCandidateSchema).parse(response.nodeCandidates);
            if (family === 'IPv4') {
              assert.ok(advertised.every(c => isIP(c.host) === 4), 'IPv4-only controller received IPv6 candidates');
            }
            const candidates = advertised.filter(c => c.kind === 'host' && c.host === loopback);
            assert.ok(candidates.length, `Worker did not advertise ${loopback}`);
            return { ...response, nodeCandidates: candidates };
          }
          return response;
        }
      }
      const client = new SingleFamilyClient(config, directory);
      const tunnel = await openStarferryTunnel(client, { nodeId, allowDirect: true, ttlSeconds: 45 });
      const command = 'echo-' + family;
      const executedBefore = sshServer.execCount;
      try {
        assert.equal(tunnel.currentPath(), 'udp_direct');
        assert.match(readFileSync(authorizedKeysPath, 'utf8'), /ry-reach:/);
        const result = await tunnel.execSsh(command, 15_000);
        assert.equal(result.status, 'succeeded', result.stderr);
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, 'SSH_EXEC_OK:' + command);
        assert.equal(result.targetHostKey, sshServer.hostPublicKeyLine);
        assert.equal(result.selectedPath, 'udp_direct');
        assert.equal(result.directAddressFamily, family);
        assert.equal(result.replayed, false);
        assert.equal(sshServer.execCount, executedBefore + 1);
      } finally {
        await tunnel.close();
      }
      const operation = await f.settled(tunnel.operationId);
      assert.equal(operation.execution, 'succeeded', operation.result_json);
      const receipt = z.object({
        tunnelSessionId: z.literal(tunnel.tunnelSessionId), directStreams: z.literal(1),
        relayStreams: z.literal(0), sshKeyRevoked: z.literal(true),
      });
      receipt.parse(JSON.parse(operation.result_json));
      assert.deepEqual(readFileSync(authorizedKeysPath, 'utf8').trim().split(/\r?\n/), [unrelatedKey]);
    });
  }
});
