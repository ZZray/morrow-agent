// Copyright (c) Ray Zhang. Starferry Controller transport merged into Reach (REQ-01).
// Provenance: adapted from ARA `tools/ssh-tunnel` (`controller.go`, `direct.go`, `common.go`, Copyright 2026 Ray Zhang, MIT).
// Provides Ed25519 OpenSSH key generation, UDP direct hole-punching (`RY.Starferry.Direct.v1`),
// Cloud Relay fallback, strict SSH CLI isolation, and zero-auto-replay on mid-stream interruption.
import { createSocket } from 'node:dgram';
import type { Socket as UdpSocket } from 'node:dgram';
import { lookup } from 'node:dns';
import { createServer, isIPv4, isIPv6 } from 'node:net';
import type { Socket as TcpSocket } from 'node:net';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ReachClient } from './client.ts';
import { protectDirectory } from './client.ts';
import { identifier } from '../contracts/protocol.ts';

const MAGIC = Buffer.from('RYSF', 'ascii');
const PKT_HELLO = 1;
const PKT_HELLO_ACK = 2;
const PKT_OPEN = 3;
const PKT_OPEN_ACK = 4;
const PKT_DATA = 5;
const PKT_ACK = 6;
const PKT_EOF = 7;
const PKT_CLOSE = 8;

const HEADER_LEN = 19;
const MAC_LEN = 16;
const MAX_PAYLOAD = 1200;
const MAX_SSH_OUTPUT_BYTES = 2_097_152; // 2 MiB bounded stdout/stderr
const DEFAULT_STUN_SERVERS = ['stun.cloudflare.com:3478', 'stun.l.google.com:19302'];

const SSH_ED25519_PREFIX = Buffer.from([
  0, 0, 0, 11, 115, 115, 104, 45, 101, 100, 50, 53, 53, 49, 57, 0, 0, 0, 32,
]);

function u32be(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}
function u16be(n: number): Buffer {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16BE(n & 0xffff, 0);
  return b;
}
function sshBytes(buf: Buffer | string): Buffer {
  const raw = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return Buffer.concat([u32be(raw.length), raw]);
}

function validatePinnedEd25519HostKey(line: string): string {
  const trimmed = line.trim();
  if (/[\r\n\0]/.test(trimmed)) throw new Error('Invalid SSH host public key');
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2 || parts.length > 3 || parts[0] !== 'ssh-ed25519') {
    throw new Error('Expected ssh-ed25519 host public key without options');
  }
  const blob = Buffer.from(parts[1]!, 'base64');
  if (blob.length !== 51 || !blob.subarray(0, 19).equals(SSH_ED25519_PREFIX)) {
    throw new Error('Invalid Ed25519 host public key wire structure');
  }
  return `ssh-ed25519 ${blob.toString('base64')}`;
}

function validateSafeSshUser(user: string): string {
  if (!/^[A-Za-z0-9._][A-Za-z0-9._@-]{0,127}$/.test(user)) {
    throw new Error('Unsafe SSH target login username rejected');
  }
  return user;
}

export function generateOpenSshEd25519KeyPair(): { publicKeyLine: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
  const pub32 = spki.subarray(spki.length - 32);
  const seed32 = pkcs8.subarray(pkcs8.length - 32);
  const pubBlob = Buffer.concat([SSH_ED25519_PREFIX, pub32]);
  const publicKeyLine = `ssh-ed25519 ${pubBlob.toString('base64')}`;

  const checkInt = randomBytes(4);
  const privPayloadNoPad = Buffer.concat([
    checkInt,
    checkInt,
    sshBytes('ssh-ed25519'),
    sshBytes(pub32),
    sshBytes(Buffer.concat([seed32, pub32])),
    sshBytes('reach-starferry-session'),
  ]);
  const padNeeded = (8 - (privPayloadNoPad.length % 8)) % 8;
  const pad = Buffer.allocUnsafe(padNeeded);
  for (let i = 0; i < padNeeded; i++) pad[i] = i + 1;
  const privSection = Buffer.concat([privPayloadNoPad, pad]);

  const opensshBin = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'ascii'),
    sshBytes('none'),
    sshBytes('none'),
    sshBytes(Buffer.alloc(0)),
    u32be(1),
    sshBytes(pubBlob),
    sshBytes(privSection),
  ]);
  const lines = opensshBin.toString('base64').match(/.{1,70}/g) ?? [];
  const privateKeyPem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
  return { publicKeyLine, privateKeyPem };
}

function lenPrefixed(part: string): Buffer {
  const raw = Buffer.from(part, 'utf8');
  return Buffer.concat([u32be(raw.length), raw]);
}

function deriveDirKey(sessionId: string, controllerHex: string, nodeHex: string, dir: 'c2n' | 'n2c'): Buffer {
  return createHash('sha256')
    .update(lenPrefixed('ry-starferry-v1'))
    .update(lenPrefixed(sessionId))
    .update(lenPrefixed(controllerHex.toLowerCase()))
    .update(lenPrefixed(nodeHex.toLowerCase()))
    .update(lenPrefixed(dir))
    .digest();
}

function encodePacket(key: Buffer, pktType: number, streamId: number, seq: number, ack: number, payload: Buffer): Buffer {
  const headerAndBody = Buffer.concat([
    MAGIC,
    Buffer.from([pktType]),
    u32be(streamId),
    u32be(seq),
    u32be(ack),
    u16be(payload.length),
    payload,
  ]);
  const tag = createHmac('sha256', key).update(headerAndBody).digest().subarray(0, MAC_LEN);
  return Buffer.concat([headerAndBody, tag]);
}

function decodePacket(key: Buffer, raw: Buffer): { pktType: number; streamId: number; seq: number; ack: number; payload: Buffer } | null {
  if (raw.length < HEADER_LEN + MAC_LEN || !raw.subarray(0, 4).equals(MAGIC)) return null;
  const pktType = raw[4]!;
  const streamId = raw.readUInt32BE(5);
  const seq = raw.readUInt32BE(9);
  const ack = raw.readUInt32BE(13);
  const len = raw.readUInt16BE(17);
  if (len > MAX_PAYLOAD || raw.length !== HEADER_LEN + len + MAC_LEN) return null;
  const bodyEnd = HEADER_LEN + len;
  const wireTag = raw.subarray(bodyEnd);
  const expectedTag = createHmac('sha256', key).update(raw.subarray(0, bodyEnd)).digest().subarray(0, MAC_LEN);
  if (!timingSafeEqual(wireTag, expectedTag)) return null;
  return { pktType, streamId, seq, ack, payload: Buffer.from(raw.subarray(HEADER_LEN, bodyEnd)) };
}

type Candidate = { host: string; port: number; kind: 'host' | 'srflx' };

function isScopeFreeIpv6(host: string) {
  return isIPv6(host) && host !== '::' && !host.includes('%') && !/^(fe[89ab]|ff|::ffff:)/i.test(host);
}

function gatherLocalCandidates(port: number, includeLoopback: boolean, dualStack: boolean): Candidate[] {
  const ipv4: Candidate[] = [];
  const ipv6: Candidate[] = [];
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const net of entries) {
      if (net.internal) continue;
      const candidate = { host: net.address, port, kind: 'host' as const };
      if (net.family === 'IPv4') {
        ipv4.push(candidate);
      } else if (dualStack && isScopeFreeIpv6(net.address)) {
        ipv6.push(candidate);
      }
    }
  }
  if (includeLoopback) {
    ipv4.unshift({ host: '127.0.0.1', port, kind: 'host' });
    if (dualStack) ipv6.unshift({ host: '::1', port, kind: 'host' });
  }
  // Reserve space in the 16-candidate contract for both families and IPv4 STUN.
  return [...ipv4.slice(0, 8), ...ipv6.slice(0, 7)];
}

async function bindDirectUdp(type: 'udp4' | 'udp6'): Promise<UdpSocket> {
  const socket = createSocket({ type, ipv6Only: false });
  try {
    socket.bind(0, type === 'udp6' ? '::' : '0.0.0.0');
    await once(socket, 'listening');
    return socket;
  } catch (error) {
    try { socket.close(); } catch {}
    throw error;
  }
}

function queryStunCandidate(udp: UdpSocket, server: string, dualStack: boolean): Promise<Candidate | null> {
  return new Promise(resolve => {
    const match = /^(?:stun:)?([^:/\s]+):(\d+)$/.exec(server);
    const port = Number(match?.[2]);
    if (!match || port < 1 || port > 65535) { resolve(null); return; }
    const transactionId = randomBytes(12);
    let settled = false;
    let serverAddress = '';
    const finish = (candidate: { host: string; port: number; kind: 'srflx' } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      udp.off('message', onMessage);
      resolve(candidate);
    };
    const onMessage = (raw: Buffer, remote: { address: string; port: number }) => {
      if (remote.address !== serverAddress || remote.port !== port || raw.length < 20
        || raw.readUInt16BE(0) !== 0x0101 || raw.readUInt32BE(4) !== 0x2112a442
        || !raw.subarray(8, 20).equals(transactionId)) return;
      const end = 20 + raw.readUInt16BE(2);
      if (end !== raw.length) return;
      for (let pos = 20; pos + 4 <= end;) {
        const type = raw.readUInt16BE(pos);
        const length = raw.readUInt16BE(pos + 2);
        pos += 4;
        if (pos + length > end) return;
        if (type === 0x0020 && length === 8 && raw[pos + 1] === 1) {
          const mappedPort = raw.readUInt16BE(pos + 2) ^ 0x2112;
          const ip = (raw.readUInt32BE(pos + 4) ^ 0x2112a442) >>> 0;
          if (mappedPort) finish({ host: [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.'), port: mappedPort, kind: 'srflx' });
          return;
        }
        pos += (length + 3) & ~3;
      }
    };
    const timer = setTimeout(() => finish(null), 500);
    udp.on('message', onMessage);
    lookup(match[1]!, { family: 4 }, (error, address) => {
      if (settled) return;
      if (error) { finish(null); return; }
      serverAddress = dualStack ? `::ffff:${address}` : address;
      const request = Buffer.concat([Buffer.from('000100002112a442', 'hex'), transactionId]);
      udp.send(request, port, serverAddress, error => { if (error) finish(null); });
    });
  });
}

const tunnelStateSchema = z.object({
  tunnelSessionId: identifier,
  operationId: identifier,
  status: z.string(),
  target: z.object({
    address: z.string(),
    port: z.number().int().min(1).max(65535),
    user: z.string().min(1).max(128),
    hostKey: z.string().min(40).max(512),
    sharedAdminKeys: z.boolean().optional(),
  }).nullable(),
  nodeKeyHex: z.string().regex(/^[0-9a-fA-F]{64}$/).nullable(),
  nodeCandidates: z.array(z.object({ host: z.string(), port: z.number(), kind: z.string() })),
  directEnabled: z.boolean(),
});

const relayReplySchema = z.object({
  closed: z.boolean(),
  frames: z.array(z.object({
    streamId: z.number(),
    kind: z.enum(['open', 'data', 'eof', 'close']),
    dataBase64: z.string().optional(),
    error: z.string().optional(),
  })),
});

export interface StarferryExecResult {
  status: 'succeeded' | 'failed' | 'unknown';
  selectedPath: 'udp_direct' | 'cloud_relay';
  directAddressFamily: 'IPv4' | 'IPv6' | null;
  replayed: false;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  tunnelSessionId: string;
  operationId: string;
  targetHostKey: string;
}

export interface StarferryControllerTunnel {
  readonly tunnelSessionId: string;
  readonly operationId: string;
  readonly target: NonNullable<z.infer<typeof tunnelStateSchema>['target']>;
  currentPath(): 'udp_direct' | 'cloud_relay';
  severDirectForTest(): void;
  execSsh(command: string, timeoutMs?: number): Promise<StarferryExecResult>;
  close(): Promise<void>;
}

export async function openStarferryTunnel(
  client: ReachClient,
  options: {
    nodeId: string;
    requestId?: string;
    allowDirect?: boolean;
    includeLoopbackCandidate?: boolean;
    overrideCandidates?: Candidate[];
    directNegotiationTimeoutMs?: number;
    ttlSeconds?: number;
  },
): Promise<StarferryControllerTunnel> {
  const tunnelSessionId = randomUUID();
  const grantId = randomUUID();
  const requestId = options.requestId ?? randomUUID();
  const allowDirect = options.allowDirect ?? true;
  const controllerKeyHex = randomBytes(32).toString('hex');
  const { publicKeyLine, privateKeyPem } = generateOpenSshEd25519KeyPair();

  let udp: UdpSocket | null = null;
  let dualStack = false;
  let controllerCandidates: Candidate[] = [];
  if (allowDirect) {
    udp = await bindDirectUdp('udp6').catch(() => bindDirectUdp('udp4'));
    dualStack = udp.address().family === 'IPv6';
    const port = udp.address().port;
    controllerCandidates = options.overrideCandidates?.filter(cand =>
      isIPv4(cand.host) || (dualStack && isScopeFreeIpv6(cand.host)),
    ) ?? gatherLocalCandidates(port, options.includeLoopbackCandidate ?? client.config.development, dualStack);
    if (!options.overrideCandidates) {
      const servers = process.env.REACH_STUN_SERVER === undefined
        ? DEFAULT_STUN_SERVERS : [process.env.REACH_STUN_SERVER.trim()];
      for (const server of servers) {
        const candidate = await queryStunCandidate(udp, server, dualStack);
        if (candidate) { controllerCandidates.push(candidate); break; }
      }
    }
  }

  const keyDir = mkdtempSync(join(tmpdir(), 'reach-sf-'));
  let closed = false;
  try {
    protectDirectory(keyDir);
    const privKeyPath = join(keyDir, 'id_ed25519');
    writeFileSync(privKeyPath, privateKeyPem, { mode: 0o600 });

    const created = tunnelStateSchema.parse(await client.request('/api/v1/tunnels', 'POST', {
      requestId,
      nodeId: options.nodeId,
      tunnelSessionId,
      grantId,
      publicKey: publicKeyLine,
      allowDirect,
      controllerKeyHex,
      controllerCandidates,
      ttlSeconds: options.ttlSeconds ?? 300,
    }));

    let readyInfo = created;
    const readyDeadline = Date.now() + 15_000;
    while (readyInfo.status !== 'ready' || !readyInfo.target || !readyInfo.nodeKeyHex) {
      if (Date.now() >= readyDeadline) {
        throw new Error('Starferry tunnel session timed out waiting for Node readiness');
      }
      await sleep(80);
      readyInfo = tunnelStateSchema.parse(await client.request(`/api/v1/tunnels/${tunnelSessionId}`));
    }

    const rawTarget = readyInfo.target;
    const verifiedUser = validateSafeSshUser(rawTarget.user);
    const verifiedHostKey = validatePinnedEd25519HostKey(rawTarget.hostKey);
    const target = { ...rawTarget, user: verifiedUser, hostKey: verifiedHostKey };

    const nodeKeyHex = readyInfo.nodeKeyHex;
    const c2nKey = deriveDirKey(tunnelSessionId, controllerKeyHex, nodeKeyHex, 'c2n');
    const n2cKey = deriveDirKey(tunnelSessionId, controllerKeyHex, nodeKeyHex, 'n2c');

    let directHealthy = false;
    let directPeer: { host: string; port: number } | null = null;
    let directSeveredForTest = false;
    const sendDirect = (packet: Buffer, peer: { host: string; port: number }) => {
      // A send error is a lost datagram. The ACK deadlines handle path failure.
      udp?.send(packet, peer.port, peer.host, () => {});
    };

    interface DirectClientStream {
      opened: boolean;
      expectedInSeq: number;
      highestAcked: number;
      onOpenAck?: () => void;
      onData: (bytes: Buffer) => void;
      onEof: () => void;
      onClose: () => void;
    }
    const directStreams = new Map<number, DirectClientStream>();

    const nodePeers = readyInfo.nodeCandidates.flatMap(({ host, port }) => {
      if (isIPv4(host)) return [{ host: dualStack ? `::ffff:${host}` : host, port }];
      return dualStack && isScopeFreeIpv6(host) ? [{ host, port }] : [];
    });
    if (udp && allowDirect && readyInfo.directEnabled && nodePeers.length > 0) {
      let negotiating = true;
      udp.on('message', (msg: Buffer, rinfo) => {
        if (directSeveredForTest) return;
        const decoded = decodePacket(n2cKey, msg);
        if (!decoded) return;
        // Node HELLO opens NAT mappings. Only its ACK of our HELLO confirms
        // the nominated path; simultaneous HELLOs may use different NICs.
        if (!directPeer) {
          if (!negotiating) return;
          if (decoded.pktType === PKT_HELLO) {
            const hello = encodePacket(c2nKey, PKT_HELLO, 0, 0, 0, Buffer.from('ctrl-hello'));
            sendDirect(hello, { host: rinfo.address, port: rinfo.port });
            return;
          }
          if (decoded.pktType !== PKT_HELLO_ACK) return;
          directPeer = { host: rinfo.address, port: rinfo.port };
          directHealthy = true;
          return;
        }
        if (directPeer.host !== rinfo.address || directPeer.port !== rinfo.port) return;
        const st = directStreams.get(decoded.streamId);
        if (!st) return;
        if (decoded.pktType === PKT_OPEN_ACK) {
          st.opened = true;
          st.onOpenAck?.();
        } else if (decoded.pktType === PKT_ACK) {
          if (decoded.ack > st.highestAcked) st.highestAcked = decoded.ack;
        } else if (decoded.pktType === PKT_DATA) {
          if (decoded.seq === st.expectedInSeq) {
            st.expectedInSeq += 1;
            st.onData(decoded.payload);
          }
          if (decoded.seq < st.expectedInSeq && directPeer) {
            const ackPkt = encodePacket(c2nKey, PKT_ACK, decoded.streamId, 0, st.expectedInSeq - 1, Buffer.alloc(0));
            sendDirect(ackPkt, directPeer);
          }
        } else if (decoded.pktType === PKT_EOF) {
          if (decoded.seq === st.expectedInSeq) {
            st.onEof();
          }
        } else if (decoded.pktType === PKT_CLOSE) {
          directStreams.delete(decoded.streamId);
          st.onClose();
        }
      });

      const negDeadline = Date.now() + (options.directNegotiationTimeoutMs ?? 2500);
      while (!directHealthy && Date.now() < negDeadline) {
        for (const peer of nodePeers) {
          const hello = encodePacket(c2nKey, PKT_HELLO, 0, 0, 0, Buffer.from('ctrl-hello'));
          sendDirect(hello, peer);
        }
        await sleep(80);
      }
      negotiating = false;
    }

    const initialPath: 'udp_direct' | 'cloud_relay' = directHealthy ? 'udp_direct' : 'cloud_relay';
    await client.request(`/api/v1/tunnels/${tunnelSessionId}/path`, 'POST', { selectedPath: initialPath });

    let nextStreamId = 1;
    const systemSsh = process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
      : 'ssh';

    const bridgeViaDirect = async (streamId: number, sock: TcpSocket): Promise<{ interrupted: boolean }> => {
      if (!udp || !directPeer) return { interrupted: true };
      let streamBrokenMidFlight = false;
      let openResolved = false;

      const st: DirectClientStream = {
        opened: false,
        expectedInSeq: 1,
        highestAcked: 0,
        onOpenAck: () => { openResolved = true; },
        onData: chunk => {
          if (!sock.destroyed) sock.write(chunk);
        },
        onEof: () => {
          if (!sock.destroyed) sock.end();
        },
        onClose: () => {
          if (!sock.destroyed) sock.destroy();
        },
      };
      directStreams.set(streamId, st);

      for (let i = 0; i < 15 && !openResolved && !directSeveredForTest; i++) {
        const openPkt = encodePacket(c2nKey, PKT_OPEN, streamId, 0, 0, Buffer.alloc(0));
        sendDirect(openPkt, directPeer);
        await sleep(60);
      }
      if (!openResolved) {
        directStreams.delete(streamId);
        directHealthy = false;
        await client.request(`/api/v1/tunnels/${tunnelSessionId}/path`, 'POST', { selectedPath: 'cloud_relay' }).catch(() => {});
        sock.destroy();
        return { interrupted: true };
      }

      let outSeq = 1;
      let pumpChain = Promise.resolve();

      const sendOrdered = async (chunk: Buffer) => {
        sock.pause();
        try {
          for (let off = 0; off < chunk.length; off += 1024) {
            const slice = chunk.subarray(off, Math.min(off + 1024, chunk.length));
            const seqNow = outSeq;
            outSeq += 1;
            const pkt = encodePacket(c2nKey, PKT_DATA, streamId, seqNow, 0, slice);
            let acked = false;
            for (let attempt = 0; attempt < 15; attempt++) {
              if (!directSeveredForTest && directPeer && udp) {
                sendDirect(pkt, directPeer);
              }
              const waitEnd = Date.now() + 80;
              while (Date.now() < waitEnd) {
                if (st.highestAcked >= seqNow) { acked = true; break; }
                await sleep(10);
              }
              if (acked) break;
            }
            if (!acked) {
              streamBrokenMidFlight = true;
              directHealthy = false;
              await client.request(`/api/v1/tunnels/${tunnelSessionId}/path`, 'POST', { selectedPath: 'cloud_relay' }).catch(() => {});
              sock.destroy();
              return;
            }
          }
        } finally {
          if (!sock.destroyed) sock.resume();
        }
      };

      sock.on('data', (chunk: Buffer) => {
        pumpChain = pumpChain.then(() => sendOrdered(chunk));
      });
      sock.on('end', () => {
        pumpChain = pumpChain.then(async () => {
          if (!directSeveredForTest && directPeer && udp) {
            sendDirect(encodePacket(c2nKey, PKT_EOF, streamId, outSeq, 0, Buffer.alloc(0)), directPeer);
          }
        });
      });
      await once(sock, 'close').catch(() => {});
      await pumpChain;
      if (!directSeveredForTest && directPeer && udp && directStreams.has(streamId)) {
        sendDirect(encodePacket(c2nKey, PKT_CLOSE, streamId, outSeq, 0, Buffer.alloc(0)), directPeer);
      }
      directStreams.delete(streamId);
      return { interrupted: streamBrokenMidFlight };
    };

    const bridgeViaRelay = async (streamId: number, sock: TcpSocket): Promise<{ interrupted: boolean }> => {
      const pendingFrames: { streamId: number; kind: 'open' | 'data' | 'eof' | 'close'; dataBase64?: string }[] = [
        { streamId, kind: 'open' },
      ];
      let remoteClosed = false;
      let relayBroken = false;
      sock.on('data', (chunk: Buffer) => {
        if (pendingFrames.length > 64) sock.pause();
        for (let off = 0; off < chunk.length; off += 16384) {
          pendingFrames.push({
            streamId,
            kind: 'data',
            dataBase64: chunk.subarray(off, Math.min(off + 16384, chunk.length)).toString('base64'),
          });
        }
      });
      sock.on('end', () => {
        pendingFrames.push({ streamId, kind: 'eof' });
      });

      try {
        while (!closed && !remoteClosed && (!sock.destroyed || pendingFrames.length > 0)) {
          const batch = pendingFrames.splice(0, 24);
          if (pendingFrames.length <= 16 && !sock.destroyed) sock.resume();
          const reply = relayReplySchema.parse(
            await client.request(`/api/v1/tunnels/${tunnelSessionId}/relay`, 'POST', { frames: batch }),
          );
          for (const f of reply.frames) {
            if (f.streamId !== streamId) continue;
            if (f.kind === 'data' && f.dataBase64 && !sock.destroyed) {
              sock.write(Buffer.from(f.dataBase64, 'base64'));
            } else if (f.kind === 'eof' && !sock.destroyed) {
              sock.end();
            } else if (f.kind === 'close') {
              remoteClosed = true;
              if (!sock.destroyed) sock.destroy();
            }
          }
          if (reply.closed) break;
          await sleep(batch.length > 0 || reply.frames.length > 0 ? 15 : 50);
        }
      } catch {
        relayBroken = true;
        if (!sock.destroyed) sock.destroy();
      }
      if (!closed && !remoteClosed && !relayBroken) {
        await client.request(`/api/v1/tunnels/${tunnelSessionId}/relay`, 'POST', {
          frames: [{ streamId, kind: 'close' }],
        }).catch(() => {});
      }
      return { interrupted: relayBroken };
    };

    return {
      tunnelSessionId,
      operationId: readyInfo.operationId,
      target,
      currentPath: () => (directHealthy ? 'udp_direct' : 'cloud_relay'),
      severDirectForTest: () => {
        directSeveredForTest = true;
      },
      async execSsh(command: string, timeoutMs = 20_000): Promise<StarferryExecResult> {
        const streamId = nextStreamId++;
        const chosenPath: 'udp_direct' | 'cloud_relay' = directHealthy ? 'udp_direct' : 'cloud_relay';
        const host = chosenPath === 'udp_direct' ? directPeer?.host : undefined;
        const directAddressFamily = host
          ? (isIPv4(host) || host.startsWith('::ffff:') ? 'IPv4' : 'IPv6')
          : null;
        let streamInterrupted = false;
        let bridgeDone = Promise.resolve();
        let acceptedOnce = false;

        const localTcp = createServer(sock => {
          if (acceptedOnce) {
            sock.destroy();
            return;
          }
          acceptedOnce = true;
          // Stop accepting any second local connection immediately.
          localTcp.close();
          sock.setNoDelay(true);
          sock.on('error', () => sock.destroy());
          const runBridge = chosenPath === 'udp_direct'
            ? bridgeViaDirect(streamId, sock)
            : bridgeViaRelay(streamId, sock);
          bridgeDone = runBridge.then(r => {
            if (r.interrupted) streamInterrupted = true;
          }).catch(() => {
            streamInterrupted = true;
            sock.destroy();
          });
        });
        localTcp.maxConnections = 1;
        localTcp.listen(0, '127.0.0.1');
        await once(localTcp, 'listening');
        const localAddr = localTcp.address();
        if (!localAddr || typeof localAddr !== 'object') throw new Error('local SSH listener failed');

        const knownHostsFile = join(keyDir, `known_hosts_${streamId}`);
        writeFileSync(knownHostsFile, `[127.0.0.1]:${localAddr.port} ${target.hostKey}\n`, 'utf8');

        const sshEnv: NodeJS.ProcessEnv = { ...process.env };
        delete sshEnv.SSH_AUTH_SOCK;
        delete sshEnv.SSH_AGENT_PID;

        try {
          const sshProc = spawn(systemSsh, [
            '-F', 'none',
            '-p', String(localAddr.port),
            '-i', privKeyPath,
            '-l', target.user,
            '-o', 'BatchMode=yes',
            '-o', 'StrictHostKeyChecking=yes',
            '-o', `UserKnownHostsFile="${knownHostsFile}"`,
            '-o', 'GlobalKnownHostsFile=none',
            '-o', 'IdentitiesOnly=yes',
            '-o', 'ForwardAgent=no',
            '-o', 'IdentityAgent=none',
            '-o', 'ClearAllForwardings=yes',
            '-o', `ConnectTimeout=${Math.max(2, Math.floor(timeoutMs / 1000))}`,
            '--',
            '127.0.0.1',
            command,
          ], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: sshEnv,
          });
          let stdout = '';
          let stderr = '';
          sshProc.stdout!.setEncoding('utf8');
          sshProc.stderr!.setEncoding('utf8');
          sshProc.stdout!.on('data', (c: string) => {
            if (stdout.length < MAX_SSH_OUTPUT_BYTES) stdout += c.slice(0, MAX_SSH_OUTPUT_BYTES - stdout.length);
          });
          sshProc.stderr!.on('data', (c: string) => {
            if (stderr.length < MAX_SSH_OUTPUT_BYTES) stderr += c.slice(0, MAX_SSH_OUTPUT_BYTES - stderr.length);
          });

          let timedOut = false;
          const killer = setTimeout(() => {
            timedOut = true;
            sshProc.kill();
          }, timeoutMs);
          const [exitCode] = await once(sshProc, 'close');
          clearTimeout(killer);
          await bridgeDone;

          const numCode = typeof exitCode === 'number' ? exitCode : null;
          // REQ-01.2: NEVER auto-replay an already-attempted SSH command if transport broke or timed out mid-flight!
          if (streamInterrupted || timedOut || numCode === 255 || numCode === null) {
            if (chosenPath === 'udp_direct') {
              directHealthy = false;
              await client.request(`/api/v1/tunnels/${tunnelSessionId}/path`, 'POST', { selectedPath: 'cloud_relay' }).catch(() => {});
            }
            return {
              status: 'unknown',
              selectedPath: chosenPath,
              directAddressFamily,
              replayed: false,
              exitCode: numCode,
              stdout: stdout.trim(),
              stderr: stderr.trim() || 'stream_interrupted_no_replay',
              tunnelSessionId,
              operationId: readyInfo.operationId,
              targetHostKey: target.hostKey,
            };
          }

          return {
            status: numCode === 0 ? 'succeeded' : 'failed',
            selectedPath: chosenPath,
            directAddressFamily,
            replayed: false,
            exitCode: numCode,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            tunnelSessionId,
            operationId: readyInfo.operationId,
            targetHostKey: target.hostKey,
          };
        } finally {
          try { localTcp.close(); } catch {}
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        if (udp) {
          try { udp.close(); } catch {}
          udp = null;
        }
        await client.request(`/api/v1/tunnels/${tunnelSessionId}/close`, 'POST', {}).catch(() => {});
        rmSync(keyDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    closed = true;
    if (udp) {
      try { udp.close(); } catch {}
    }
    rmSync(keyDir, { recursive: true, force: true });
    throw err;
  }
}

export const sshExecMcpInputSchema = z.strictObject({
  requestId: identifier,
  nodeId: identifier,
  command: z.string().min(1).max(16384),
  allowDirect: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
});

export async function runSshExecOnce(
  client: ReachClient,
  rawInput: unknown,
): Promise<StarferryExecResult> {
  const input = sshExecMcpInputSchema.parse(rawInput);
  const tunnel = await openStarferryTunnel(client, {
    nodeId: input.nodeId,
    requestId: input.requestId,
    allowDirect: input.allowDirect,
    ttlSeconds: Math.max(30, Math.ceil(input.timeoutMs / 1000) + 30),
  });
  try {
    return await tunnel.execSsh(input.command, input.timeoutMs);
  } finally {
    await tunnel.close();
  }
}
