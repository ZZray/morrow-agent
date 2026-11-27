// Copyright (c) Ray Zhang. Deterministic direct-path nomination and STUN regressions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ReachClient } from '../src/controller/client.ts';
import { generateOpenSshEd25519KeyPair, openStarferryTunnel } from '../src/controller/starferry.ts';

const createdSchema = z.object({
  tunnelSessionId: z.string(), controllerKeyHex: z.string(),
  controllerCandidates: z.array(z.object({ host: z.string(), port: z.number(), kind: z.string() })),
});

test('controller nominates the HELLO_ACK path despite an earlier Node HELLO from a different endpoint', async () => {
  const earlyPath = createSocket('udp4');
  const nominatedPath = createSocket('udp4');
  earlyPath.bind(0, '127.0.0.1');
  nominatedPath.bind(0, '127.0.0.1');
  await Promise.all([once(earlyPath, 'listening'), once(nominatedPath, 'listening')]);
  let nodeKey: Buffer = Buffer.alloc(32);
  let earlyOpens = 0;
  let nominatedOpens = 0;
  let firstProbe = true;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const packet = (type: number, streamId = 0) => {
    const header = Buffer.alloc(19);
    header.write('RYSF'); header[4] = type; header.writeUInt32BE(streamId, 5);
    return Buffer.concat([header, createHmac('sha256', nodeKey).update(header).digest().subarray(0, 16)]);
  };
  earlyPath.on('message', raw => { if (raw[4] === 3) earlyOpens++; });
  nominatedPath.on('message', (raw, remote) => {
    if (raw[4] === 1) {
      if (firstProbe) {
        firstProbe = false;
        earlyPath.send(packet(1), remote.port, remote.address);
        timers.push(setTimeout(() => nominatedPath.send(packet(2), remote.port, remote.address), 30));
      } else {
        nominatedPath.send(packet(2), remote.port, remote.address);
      }
    } else if (raw[4] === 3) {
      nominatedOpens++;
      const streamId = raw.readUInt32BE(5);
      nominatedPath.send(packet(4, streamId), remote.port, remote.address);
      timers.push(setTimeout(() => nominatedPath.send(packet(8, streamId), remote.port, remote.address), 150));
    }
  });
  class FixtureClient extends ReachClient {
    override async request(route: string, _method = 'GET', input?: unknown) {
      if (route === '/api/v1/tunnels') {
        const created = createdSchema.parse(input);
        const nodeHex = randomBytes(32).toString('hex');
        const hash = createHash('sha256');
        for (const part of ['ry-starferry-v1', created.tunnelSessionId, created.controllerKeyHex, nodeHex, 'n2c']) {
          const bytes = Buffer.from(part); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
          hash.update(length).update(bytes);
        }
        nodeKey = hash.digest();
        return { tunnelSessionId: created.tunnelSessionId, operationId: randomUUID(), status: 'ready',
          target: { address: '127.0.0.1', port: 22, user: 'fixture', hostKey: generateOpenSshEd25519KeyPair().publicKeyLine },
          nodeKeyHex: nodeHex, nodeCandidates: [{ host: '127.0.0.1', port: nominatedPath.address().port, kind: 'host' }], directEnabled: true };
      }
      return {};
    }
  }
  const client = new FixtureClient({ server: 'http://127.0.0.1', token: '', development: true });
  const tunnel = await openStarferryTunnel(client, { nodeId: randomUUID(), overrideCandidates: [] });
  try {
    assert.equal(tunnel.currentPath(), 'udp_direct');
    // No SSH backend is served here. The OPEN must go to the acknowledged path.
    const result = await tunnel.execSsh('not-executed', 2000);
    assert.equal(result.status, 'unknown');
    assert.equal(earlyOpens, 0, 'an unsolicited HELLO must not select the OPEN destination');
    assert.ok(nominatedOpens > 0);
  } finally {
    await tunnel.close();
    for (const timer of timers) clearTimeout(timer);
    earlyPath.close(); nominatedPath.close();
  }
});

test('controller publishes same-socket STUN candidate and falls back after an unresponsive STUN endpoint', async () => {
  const stun = createSocket('udp4');
  stun.bind(0, '127.0.0.1'); await once(stun, 'listening');
  let respond = true;
  let observedPort = 0;
  stun.on('message', (request, remote) => {
    observedPort = remote.port;
    if (!respond) return;
    const response = Buffer.alloc(32);
    request.copy(response, 0, 0, 20);
    response.writeUInt16BE(0x0101, 0); response.writeUInt16BE(12, 2);
    response.writeUInt16BE(0x0020, 20); response.writeUInt16BE(8, 22); response[25] = 1;
    response.writeUInt16BE(remote.port ^ 0x2112, 26);
    response.writeUInt32BE((0x7f000001 ^ 0x2112a442) >>> 0, 28);
    response[8] ^= 1;
    stun.send(response, remote.port, remote.address, () => {
      response[8] ^= 1;
      stun.send(response, remote.port, remote.address);
    });
  });
  let candidates: z.infer<typeof createdSchema>['controllerCandidates'] = [];
  class FixtureClient extends ReachClient {
    override async request(route: string, _method = 'GET', input?: unknown) {
      if (route === '/api/v1/tunnels') {
        const created = createdSchema.parse(input); candidates = created.controllerCandidates;
        return { tunnelSessionId: created.tunnelSessionId, operationId: randomUUID(), status: 'ready',
          target: { address: '127.0.0.1', port: 22, user: 'fixture', hostKey: generateOpenSshEd25519KeyPair().publicKeyLine },
          nodeKeyHex: '0'.repeat(64), nodeCandidates: [], directEnabled: false };
      }
      return {};
    }
  }
  const oldStun = process.env.REACH_STUN_SERVER;
  process.env.REACH_STUN_SERVER = `stun:127.0.0.1:${stun.address().port}`;
  const client = new FixtureClient({ server: 'http://127.0.0.1', token: '', development: true });
  try {
    const tunnel = await openStarferryTunnel(client, { nodeId: randomUUID() });
    await tunnel.close();
    assert.deepEqual(candidates.filter(c => c.kind === 'srflx'), [{ host: '127.0.0.1', port: observedPort, kind: 'srflx' }]);
    assert.ok(candidates.some(c => c.kind === 'host' && c.port === observedPort));
    respond = false;
    const started = Date.now();
    const fallback = await openStarferryTunnel(client, { nodeId: randomUUID() });
    assert.equal(fallback.currentPath(), 'cloud_relay');
    await fallback.close();
    assert.equal(candidates.some(c => c.kind === 'srflx'), false);
    assert.ok(Date.now() - started < 2500, 'STUN timeout must leave relay available');
  } finally {
    if (oldStun === undefined) delete process.env.REACH_STUN_SERVER; else process.env.REACH_STUN_SERVER = oldStun;
    stun.close();
  }
});
