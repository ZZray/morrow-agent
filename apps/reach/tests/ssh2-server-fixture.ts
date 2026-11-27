// Copyright (c) Ray Zhang. Minimal RFC-4253/4252/4254 SSH-2.0 server in pure Node.js crypto/net
// for verifying real Windows OpenSSH `ssh.exe` against Reach-managed `authorized_keys` and Starferry tunnels.
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { once } from 'node:events';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  diffieHellman,
  generateKeyPairSync,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import type { Cipheriv, Decipheriv, KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const BANNER = 'SSH-2.0-ReachOpenSSH_1.0';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const SSH_ED25519_PREFIX = Buffer.from([
  0, 0, 0, 11, 115, 115, 104, 45, 101, 100, 50, 53, 53, 49, 57, 0, 0, 0, 32,
]);

function u32(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}
function sshStr(data: Buffer | string): Buffer {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return Buffer.concat([u32(buf.length), buf]);
}
function sshMpint(raw: Buffer): Buffer {
  let start = 0;
  while (start < raw.length && raw[start] === 0) start++;
  if (start === raw.length) return u32(0);
  const trimmed = raw.subarray(start);
  if ((trimmed[0]! & 0x80) !== 0) {
    return sshStr(Buffer.concat([Buffer.from([0]), trimmed]));
  }
  return sshStr(trimmed);
}

class SshReader {
  private buf: Buffer;
  private pos = 0;
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  byte(): number {
    if (this.pos + 1 > this.buf.length) throw new Error('SSH packet truncated (byte)');
    return this.buf[this.pos++]!;
  }
  bool(): boolean {
    return this.byte() !== 0;
  }
  uint32(): number {
    if (this.pos + 4 > this.buf.length) throw new Error('SSH packet truncated (u32)');
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  bytes(): Buffer {
    const len = this.uint32();
    if (this.pos + len > this.buf.length) throw new Error('SSH packet truncated (string)');
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  str(): string {
    return this.bytes().toString('utf8');
  }
}

function deriveKey(kMpint: Buffer, h: Buffer, letter: string, sessionId: Buffer, needed: number): Buffer {
  const letterBuf = Buffer.from(letter, 'ascii');
  let out = createHash('sha256').update(kMpint).update(h).update(letterBuf).update(sessionId).digest();
  while (out.length < needed) {
    const next = createHash('sha256').update(kMpint).update(h).update(out).digest();
    out = Buffer.concat([out, next]);
  }
  return out.subarray(0, needed);
}

function loadAuthorizedEd25519Blobs(authorizedKeysPath: string): Set<string> {
  const set = new Set<string>();
  if (!existsSync(authorizedKeysPath)) return set;
  const text = readFileSync(authorizedKeysPath, 'utf8').replace(/^\uFEFF/, '');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] !== 'ssh-ed25519' || !parts[1]) continue;
    try {
      const blob = Buffer.from(parts[1], 'base64');
      if (blob.length === 51 && blob.subarray(0, 19).equals(SSH_ED25519_PREFIX)) {
        set.add(blob.toString('base64'));
      }
    } catch {
      // ignore malformed entry
    }
  }
  return set;
}

export interface SshFixtureServer {
  port: number;
  hostPublicKeyLine: string;
  acceptedConnections: number;
  execCount: number;
  close(): Promise<void>;
}

export async function startSsh2FixtureServer(options: {
  authorizedKeysPath: string;
  expectedUser: string;
  onExec?: (command: string) => Promise<{ stdout: string; stderr?: string; exitCode: number }>;
}): Promise<SshFixtureServer> {
  const { publicKey: hostPub, privateKey: hostPriv } = generateKeyPairSync('ed25519');
  const hostSpki = hostPub.export({ type: 'spki', format: 'der' });
  const rawHostPub32 = hostSpki.subarray(hostSpki.length - 32);
  const hostKeyBlob = Buffer.concat([SSH_ED25519_PREFIX, rawHostPub32]);
  const hostPublicKeyLine = `ssh-ed25519 ${hostKeyBlob.toString('base64')}`;

  let acceptedConnections = 0;
  let execCount = 0;
  const activeSockets = new Set<Socket>();

  const server: Server = createServer(socket => {
    acceptedConnections++;
    activeSockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => activeSockets.delete(socket));
    handleSshConnection(socket, hostPriv, hostKeyBlob, options, () => { execCount++; }).catch(() => {
      socket.destroy();
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('SSH fixture failed to bind');

  return {
    port: addr.port,
    hostPublicKeyLine,
    get acceptedConnections() { return acceptedConnections; },
    get execCount() { return execCount; },
    async close() {
      for (const s of activeSockets) s.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}

async function handleSshConnection(
  socket: Socket,
  hostPriv: KeyObject,
  hostKeyBlob: Buffer,
  options: {
    authorizedKeysPath: string;
    expectedUser: string;
    onExec?: (command: string) => Promise<{ stdout: string; stderr?: string; exitCode: number }>;
  },
  recordExec: () => void,
) {
  socket.setNoDelay(true);
  socket.write(`${BANNER}\r\n`);

  let recvBuf: Buffer = Buffer.alloc(0);
  let clientBanner: string | null = null;
  let clientKexInitPayload: Buffer | null = null;
  let serverKexInitPayload: Buffer | null = null;
  let sessionId: Buffer | null = null;
  let authenticated = false;

  let sendSeq = 0;
  let recvSeq = 0;
  let cipher: Cipheriv | null = null;
  let decipher: Decipheriv | null = null;
  let sendMacKey: Buffer | null = null;
  let recvMacKey: Buffer | null = null;
  let decryptedHeader: Buffer | null = null;

  let pendingKeys: {
    c2sIv: Buffer; s2cIv: Buffer; c2sKey: Buffer; s2cKey: Buffer; c2sMac: Buffer; s2cMac: Buffer;
  } | null = null;

  const sendPacket = (payload: Buffer) => {
    const blockSize = cipher ? 16 : 8;
    const unpadded = 4 + 1 + payload.length;
    let padLen = blockSize - (unpadded % blockSize);
    if (padLen < 4) padLen += blockSize;
    const pktLen = 1 + payload.length + padLen;
    const plain = Buffer.concat([u32(pktLen), Buffer.from([padLen]), payload, randomBytes(padLen)]);
    const seq = sendSeq >>> 0;
    sendSeq = (sendSeq + 1) >>> 0;
    if (cipher && sendMacKey) {
      const mac = createHmac('sha256', sendMacKey).update(u32(seq)).update(plain).digest();
      const enc = cipher.update(plain);
      socket.write(Buffer.concat([enc, mac]));
    } else {
      socket.write(plain);
    }
  };

  const buildKexInit = (): Buffer => {
    const nl = (items: string[]) => sshStr(items.join(','));
    return Buffer.concat([
      Buffer.from([20]),
      randomBytes(16),
      nl(['curve25519-sha256']),
      nl(['ssh-ed25519']),
      nl(['aes256-ctr']),
      nl(['aes256-ctr']),
      nl(['hmac-sha2-256']),
      nl(['hmac-sha2-256']),
      nl(['none']),
      nl(['none']),
      nl([]),
      nl([]),
      Buffer.from([0]),
      u32(0),
    ]);
  };

  let processing = false;
  const pump = async () => {
    if (processing) return;
    processing = true;
    try {
      while (!socket.destroyed) {
        if (!clientBanner) {
          const nlIdx = recvBuf.indexOf(0x0a);
          if (nlIdx === -1) {
            if (recvBuf.length > 1024) { socket.destroy(); return; }
            break;
          }
          const line = recvBuf.subarray(0, nlIdx).toString('utf8').replace(/\r$/, '');
          recvBuf = recvBuf.subarray(nlIdx + 1);
          if (!line.startsWith('SSH-2.0-')) continue;
          clientBanner = line;
          serverKexInitPayload = buildKexInit();
          sendPacket(serverKexInitPayload);
          continue;
        }

        let payload: Buffer;
        if (!decipher || !recvMacKey) {
          if (recvBuf.length < 8) break;
          const pktLen = recvBuf.readUInt32BE(0);
          if (pktLen < 5 || pktLen > 262144) { socket.destroy(); return; }
          const total = 4 + pktLen;
          if (recvBuf.length < total) break;
          const padLen = recvBuf[4]!;
          payload = Buffer.from(recvBuf.subarray(5, 4 + pktLen - padLen));
          recvBuf = recvBuf.subarray(total);
          recvSeq = (recvSeq + 1) >>> 0;
        } else {
          if (!decryptedHeader) {
            if (recvBuf.length < 16) break;
            decryptedHeader = decipher.update(recvBuf.subarray(0, 16));
          }
          const pktLen = decryptedHeader.readUInt32BE(0);
          if (pktLen < 5 || pktLen > 262144) { socket.destroy(); return; }
          const cipherTotal = 4 + pktLen;
          const macLen = 32;
          if (recvBuf.length < cipherTotal + macLen) break;
          const restPlain = cipherTotal > 16 ? decipher.update(recvBuf.subarray(16, cipherTotal)) : Buffer.alloc(0);
          const fullPlain = Buffer.concat([decryptedHeader, restPlain]);
          decryptedHeader = null;
          const wireMac = recvBuf.subarray(cipherTotal, cipherTotal + macLen);
          recvBuf = recvBuf.subarray(cipherTotal + macLen);
          const seq = recvSeq >>> 0;
          recvSeq = (recvSeq + 1) >>> 0;
          const expectedMac = createHmac('sha256', recvMacKey).update(u32(seq)).update(fullPlain).digest();
          if (!expectedMac.equals(wireMac)) { socket.destroy(); return; }
          const padLen = fullPlain[4]!;
          payload = Buffer.from(fullPlain.subarray(5, 4 + pktLen - padLen));
        }

        if (payload.length === 0) continue;
        const msgType = payload[0]!;
        const r = new SshReader(payload.subarray(1));

        if (msgType === 2 || msgType === 4) {
          // IGNORE / DEBUG
          continue;
        } else if (msgType === 1) {
          // DISCONNECT
          socket.end();
          return;
        } else if (msgType === 20) {
          // KEXINIT
          clientKexInitPayload = payload;
        } else if (msgType === 30) {
          // KEX_ECDH_INIT (curve25519-sha256)
          if (!clientKexInitPayload || !serverKexInitPayload) { socket.destroy(); return; }
          const qc = r.bytes();
          if (qc.length !== 32) { socket.destroy(); return; }
          const { publicKey: ephPub, privateKey: ephPriv } = generateKeyPairSync('x25519');
          const ephSpki = ephPub.export({ type: 'spki', format: 'der' });
          const qs = ephSpki.subarray(ephSpki.length - 32);
          const clientPubKey = createPublicKey({
            key: Buffer.concat([X25519_SPKI_PREFIX, qc]),
            format: 'der',
            type: 'spki',
          });
          const sharedRaw = diffieHellman({ privateKey: ephPriv, publicKey: clientPubKey });
          const kMpint = sshMpint(sharedRaw);
          const h = createHash('sha256')
            .update(sshStr(clientBanner))
            .update(sshStr(BANNER))
            .update(sshStr(clientKexInitPayload))
            .update(sshStr(serverKexInitPayload))
            .update(sshStr(hostKeyBlob))
            .update(sshStr(qc))
            .update(sshStr(qs))
            .update(kMpint)
            .digest();
          if (!sessionId) sessionId = h;
          const hostSig = sign(null, h, hostPriv);
          const sigBlob = Buffer.concat([sshStr('ssh-ed25519'), sshStr(hostSig)]);
          sendPacket(Buffer.concat([Buffer.from([31]), sshStr(hostKeyBlob), sshStr(qs), sshStr(sigBlob)]));
          sendPacket(Buffer.from([21])); // NEWKEYS
          pendingKeys = {
            c2sIv: deriveKey(kMpint, h, 'A', sessionId, 16),
            s2cIv: deriveKey(kMpint, h, 'B', sessionId, 16),
            c2sKey: deriveKey(kMpint, h, 'C', sessionId, 32),
            s2cKey: deriveKey(kMpint, h, 'D', sessionId, 32),
            c2sMac: deriveKey(kMpint, h, 'E', sessionId, 32),
            s2cMac: deriveKey(kMpint, h, 'F', sessionId, 32),
          };
          cipher = createCipheriv('aes-256-ctr', pendingKeys.s2cKey, pendingKeys.s2cIv);
          sendMacKey = pendingKeys.s2cMac;
        } else if (msgType === 21) {
          // Client NEWKEYS
          if (!pendingKeys) { socket.destroy(); return; }
          decipher = createDecipheriv('aes-256-ctr', pendingKeys.c2sKey, pendingKeys.c2sIv);
          recvMacKey = pendingKeys.c2sMac;
        } else if (msgType === 5) {
          // SERVICE_REQUEST
          const svc = r.str();
          if (svc !== 'ssh-userauth') { socket.destroy(); return; }
          sendPacket(Buffer.concat([Buffer.from([6]), sshStr(svc)]));
        } else if (msgType === 50) {
          // USERAUTH_REQUEST
          const user = r.str();
          const svc = r.str();
          const method = r.str();
          const failAuth = () => sendPacket(Buffer.concat([Buffer.from([51]), sshStr('publickey'), Buffer.from([0])]));
          if (user !== options.expectedUser || svc !== 'ssh-connection' || method !== 'publickey' || !sessionId) {
            failAuth();
            continue;
          }
          const hasSig = r.bool();
          const alg = r.str();
          const pkBlob = r.bytes();
          const accepted = loadAuthorizedEd25519Blobs(options.authorizedKeysPath);
          if (alg !== 'ssh-ed25519' || pkBlob.length !== 51 || !accepted.has(pkBlob.toString('base64'))) {
            failAuth();
            continue;
          }
          if (!hasSig) {
            sendPacket(Buffer.concat([Buffer.from([60]), sshStr('ssh-ed25519'), sshStr(pkBlob)]));
            continue;
          }
          const sigOuter = r.bytes();
          const sr = new SshReader(sigOuter);
          const sigAlg = sr.str();
          const sigBytes = sr.bytes();
          if (sigAlg !== 'ssh-ed25519' || sigBytes.length !== 64) {
            failAuth();
            continue;
          }
          const signedData = Buffer.concat([
            sshStr(sessionId),
            Buffer.from([50]),
            sshStr(user),
            sshStr(svc),
            sshStr('publickey'),
            Buffer.from([1]),
            sshStr('ssh-ed25519'),
            sshStr(pkBlob),
          ]);
          const clientEdPub = createPublicKey({
            key: Buffer.concat([ED25519_SPKI_PREFIX, pkBlob.subarray(19)]),
            format: 'der',
            type: 'spki',
          });
          if (!verify(null, signedData, clientEdPub, sigBytes)) {
            failAuth();
            continue;
          }
          authenticated = true;
          sendPacket(Buffer.from([52])); // USERAUTH_SUCCESS
        } else if (msgType === 80) {
          // GLOBAL_REQUEST
          r.str();
          const wantReply = r.bool();
          if (wantReply) sendPacket(Buffer.from([82])); // REQUEST_FAILURE
        } else if (msgType === 90 && authenticated) {
          // CHANNEL_OPEN
          const chanType = r.str();
          const senderChan = r.uint32();
          const initWin = r.uint32();
          const maxPkt = r.uint32();
          if (chanType !== 'session') {
            sendPacket(Buffer.concat([Buffer.from([92]), u32(senderChan), u32(1), sshStr('prohibited'), sshStr('')]));
            continue;
          }
          sendPacket(Buffer.concat([Buffer.from([91]), u32(senderChan), u32(0), u32(initWin || 1048576), u32(maxPkt || 32768)]));
        } else if (msgType === 98 && authenticated) {
          // CHANNEL_REQUEST
          const recipientChan = r.uint32();
          const reqType = r.str();
          const wantReply = r.bool();
          if (reqType === 'exec') {
            const cmd = r.str();
            if (wantReply) sendPacket(Buffer.concat([Buffer.from([99]), u32(recipientChan)]));
            recordExec();
            const execRes = options.onExec
              ? await options.onExec(cmd)
              : { stdout: `SSH_EXEC_OK:${cmd}\n`, exitCode: 0 };
            if (execRes.stdout.length > 0) {
              sendPacket(Buffer.concat([Buffer.from([94]), u32(recipientChan), sshStr(execRes.stdout)]));
            }
            if (execRes.stderr && execRes.stderr.length > 0) {
              sendPacket(Buffer.concat([Buffer.from([95]), u32(recipientChan), u32(1), sshStr(execRes.stderr)]));
            }
            sendPacket(Buffer.concat([
              Buffer.from([98]),
              u32(recipientChan),
              sshStr('exit-status'),
              Buffer.from([0]),
              u32(execRes.exitCode),
            ]));
            sendPacket(Buffer.concat([Buffer.from([96]), u32(recipientChan)])); // EOF
            sendPacket(Buffer.concat([Buffer.from([97]), u32(recipientChan)])); // CLOSE
          } else {
            // env / pty-req / etc.
            if (wantReply) sendPacket(Buffer.concat([Buffer.from([100]), u32(recipientChan)]));
          }
        } else if (msgType === 97) {
          // CHANNEL_CLOSE
          socket.end();
          return;
        }
      }
    } finally {
      processing = false;
    }
  };

  socket.on('data', (chunk: Buffer) => {
    recvBuf = Buffer.concat([recvBuf, chunk]);
    void pump();
  });
}
