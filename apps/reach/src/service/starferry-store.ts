// Copyright (c) Ray Zhang. Starferry tunnel session signaling, candidate exchange, and bounded cloud relay (REQ-01).
// Merged from tools/ssh-tunnel (Starferry, Copyright Ray Zhang) and aligned to Reach persistent (nodeId, epoch) identity and operation receipts.
import { z } from 'zod';
import {
  identifier,
  starferryCandidateSchema,
} from '../contracts/protocol.ts';
import type { NodeRow, ReachStore } from './store.ts';
import { requireCondition } from './errors.ts';

const MAX_ACTIVE_STREAMS = 16;
const MAX_QUEUED_STREAM_BYTES = 1_048_576; // 1 MiB per direction per stream
const MAX_CHUNK_BASE64_CHARS = 88_000;     // <= 64 KiB binary chunk

export const tunnelCreateInputSchema = z.strictObject({
  requestId: identifier,
  nodeId: identifier,
  tunnelSessionId: identifier,
  grantId: identifier,
  publicKey: z.string().trim().min(40).max(512).refine(v => !/[\r\n\0]/.test(v), 'Expected single-line Ed25519 public key'),
  allowDirect: z.boolean().default(true),
  controllerKeyHex: z.string().regex(/^[0-9a-f]{64}$/),
  controllerCandidates: z.array(starferryCandidateSchema).max(16).default([]),
  ttlSeconds: z.number().int().min(10).max(3600).default(300),
});

export const nodeTunnelReadySchema = z.strictObject({
  operationId: identifier,
  dispatchId: identifier,
  target: z.strictObject({
    address: z.string().min(3).max(256),
    port: z.number().int().min(1).max(65535),
    user: z.string().min(1).max(128),
    hostKey: z.string().min(40).max(512),
    sharedAdminKeys: z.boolean().default(false),
  }),
  nodeKeyHex: z.string().regex(/^[0-9a-f]{64}$/),
  nodeCandidates: z.array(starferryCandidateSchema).max(16).default([]),
  directEnabled: z.boolean(),
});

export const relayFrameSchema = z.strictObject({
  streamId: z.number().int().min(1).max(0x7fffffff),
  kind: z.enum(['open', 'data', 'eof', 'close']),
  dataBase64: z.string().max(MAX_CHUNK_BASE64_CHARS).optional(),
  error: z.string().max(512).optional(),
});

export const relayBatchSchema = z.strictObject({
  frames: z.array(relayFrameSchema).max(64),
});

type RelayFrame = z.infer<typeof relayFrameSchema>;

interface RelayStreamState {
  streamId: number;
  c2nBytes: number;
  n2cBytes: number;
  closed: boolean;
}

interface TunnelRuntimeSession {
  tunnelSessionId: string;
  userId: string;
  nodeId: string;
  epoch: number;
  operationId: string;
  grantId: string;
  allowDirect: boolean;
  controllerKeyHex: string;
  controllerCandidates: z.infer<typeof starferryCandidateSchema>[];
  createdAt: number;
  expiresAt: number;
  closed: boolean;
  closeReason: string | null;
  ready: z.infer<typeof nodeTunnelReadySchema> | null;
  c2nQueue: RelayFrame[];
  n2cQueue: RelayFrame[];
  streams: Map<number, RelayStreamState>;
  relayStreamsOpened: number;
}

interface StarferryTunnelRow {
  tunnel_session_id: string;
  user_id: string;
  node_id: string;
  epoch: number;
  operation_id: string;
  grant_id: string;
  allow_direct: number;
  selected_path: string | null;
  status: string;
  target_json: string | null;
  created_at: number;
  expires_at: number;
  closed_at: number | null;
}

export class StarferryStore {
  readonly store: ReachStore;
  private sessions = new Map<string, TunnelRuntimeSession>();

  constructor(store: ReachStore) {
    this.store = store;
  }

  private gc(now: number) {
    for (const [id, sess] of this.sessions) {
      if (now >= sess.expiresAt + 30_000 || (sess.closed && now >= sess.createdAt + 60_000)) {
        this.sessions.delete(id);
      }
    }
  }

  createSession(userId: string, rawInput: unknown) {
    const input = tunnelCreateInputSchema.parse(rawInput);
    const now = this.store.now();
    this.gc(now);

    requireCondition(this.sessions.size < 128, 429, 'starferry_session_limit', '活跃隧道会话数已达上限');
    return this.store.transaction(() => {
      const existingRow = this.store.db.prepare(
        'SELECT * FROM starferry_tunnels WHERE tunnel_session_id=?',
      ).get(input.tunnelSessionId) as unknown as StarferryTunnelRow | undefined;

      if (existingRow) {
        requireCondition(
          existingRow.user_id === userId && existingRow.node_id === input.nodeId && existingRow.grant_id === input.grantId,
          409,
          'starferry_session_conflict',
          '同一隧道会话 ID 已绑定其他请求',
        );
        return this.readForController(userId, input.tunnelSessionId);
      }

      const op = this.store.submit(userId, input.requestId, input.nodeId, {
        kind: 'starferry.session',
        tunnelSessionId: input.tunnelSessionId,
        grantId: input.grantId,
        publicKey: input.publicKey,
        allowDirect: input.allowDirect,
        controllerKeyHex: input.controllerKeyHex,
        controllerCandidates: input.controllerCandidates,
        ttlSeconds: input.ttlSeconds,
      });

      const expiresAt = now + input.ttlSeconds * 1000;
      this.store.db.prepare(`
        INSERT INTO starferry_tunnels(tunnel_session_id, user_id, node_id, epoch, operation_id, grant_id, allow_direct, selected_path, status, target_json, created_at, expires_at, closed_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, NULL, 'negotiating', NULL, ?, ?, NULL)
      `).run(input.tunnelSessionId, userId, input.nodeId, op.epoch, op.id, input.grantId, input.allowDirect ? 1 : 0, now, expiresAt);

      this.sessions.set(input.tunnelSessionId, {
        tunnelSessionId: input.tunnelSessionId,
        userId,
        nodeId: input.nodeId,
        epoch: op.epoch,
        operationId: op.id,
        grantId: input.grantId,
        allowDirect: input.allowDirect,
        controllerKeyHex: input.controllerKeyHex,
        controllerCandidates: input.controllerCandidates,
        createdAt: now,
        expiresAt,
        closed: false,
        closeReason: null,
        ready: null,
        c2nQueue: [],
        n2cQueue: [],
        streams: new Map(),
        relayStreamsOpened: 0,
      });

      return this.readForController(userId, input.tunnelSessionId);
    });
  }

  nodeReady(node: NodeRow, tunnelSessionId: string, rawInput: unknown) {
    const validId = identifier.parse(tunnelSessionId);
    const input = nodeTunnelReadySchema.parse(rawInput);
    const now = this.store.now();
    this.gc(now);
    const sess = this.sessions.get(validId);
    requireCondition(sess && !sess.closed && !node.revoked && now < sess.expiresAt, 404, 'starferry_session_not_found', '隧道会话不存在、已过期或设备已解绑');
    requireCondition(
      sess.nodeId === node.id && sess.epoch === node.epoch && sess.operationId === input.operationId,
      409,
      'starferry_binding_mismatch',
      '隧道会话与当前节点配对不一致',
    );
    const opRow = this.store.db.prepare('SELECT dispatch_id FROM operations WHERE id=?').get(input.operationId) as { dispatch_id: string | null } | undefined;
    requireCondition(opRow?.dispatch_id === input.dispatchId, 409, 'starferry_dispatch_mismatch', '隧道操作投递凭据不一致');

    sess.ready = input;
    this.store.db.prepare(
      "UPDATE starferry_tunnels SET status='ready', target_json=? WHERE tunnel_session_id=?",
    ).run(JSON.stringify(input.target), validId);

    return {
      accepted: true,
      allowDirect: sess.allowDirect,
      controllerKeyHex: sess.controllerKeyHex,
      controllerCandidates: sess.controllerCandidates,
      expiresAt: sess.expiresAt,
    };
  }

  recordSelectedPath(userId: string, tunnelSessionId: string, selectedPath: 'udp_direct' | 'cloud_relay') {
    const validId = identifier.parse(tunnelSessionId);
    const row = this.store.db.prepare(
      'SELECT * FROM starferry_tunnels WHERE tunnel_session_id=? AND user_id=?',
    ).get(validId, userId) as unknown as StarferryTunnelRow | undefined;
    requireCondition(row, 404, 'starferry_session_not_found', '未找到该隧道会话');
    this.store.db.prepare(
      'UPDATE starferry_tunnels SET selected_path=? WHERE tunnel_session_id=?',
    ).run(selectedPath, validId);
    return { updated: true, selectedPath };
  }

  readForController(userId: string, tunnelSessionId: string) {
    const validId = identifier.parse(tunnelSessionId);
    const row = this.store.db.prepare(
      'SELECT * FROM starferry_tunnels WHERE tunnel_session_id=? AND user_id=?',
    ).get(validId, userId) as unknown as StarferryTunnelRow | undefined;
    requireCondition(row, 404, 'starferry_session_not_found', '未找到该隧道会话');
    const sess = this.sessions.get(validId);
    return {
      tunnelSessionId: row.tunnel_session_id,
      nodeId: row.node_id,
      epoch: row.epoch,
      operationId: row.operation_id,
      grantId: row.grant_id,
      allowDirect: Boolean(row.allow_direct),
      selectedPath: row.selected_path,
      status: sess?.closed ? 'closed' : row.status,
      target: row.target_json ? JSON.parse(row.target_json) : null,
      nodeKeyHex: sess?.ready?.nodeKeyHex ?? null,
      nodeCandidates: sess?.ready?.nodeCandidates ?? [],
      directEnabled: sess?.ready?.directEnabled ?? false,
      expiresAt: row.expires_at,
      closedAt: row.closed_at,
    };
  }

  controllerRelayExchange(userId: string, tunnelSessionId: string, rawInput: unknown) {
    const validId = identifier.parse(tunnelSessionId);
    const batch = relayBatchSchema.parse(rawInput);
    const sess = this.sessions.get(validId);
    requireCondition(sess && sess.userId === userId, 404, 'starferry_session_not_found', '隧道会话不存在或已过期');
    const node = this.store.ownedNode(userId, sess.nodeId);
    if (node.revoked || this.store.now() >= sess.expiresAt) {
      sess.closed = true;
      sess.closeReason = node.revoked ? 'node_unpaired' : 'expired';
    }
    requireCondition(!sess.closed, 409, 'starferry_session_closed', `隧道会话已结束: ${sess.closeReason ?? 'closed'}`);

    for (const frame of batch.frames) {
      this.enqueueFrame(sess, 'c2n', frame);
    }
    const outbound = sess.n2cQueue.splice(0, 64);
    for (const frame of outbound) {
      if (frame.kind === 'data' && frame.dataBase64) {
        const st = sess.streams.get(frame.streamId);
        if (st) st.n2cBytes = Math.max(0, st.n2cBytes - Math.floor((frame.dataBase64.length * 3) / 4));
      }
    }
    return { closed: sess.closed, frames: outbound };
  }

  nodeRelayExchange(node: NodeRow, tunnelSessionId: string, rawInput: unknown) {
    const validId = identifier.parse(tunnelSessionId);
    const batch = relayBatchSchema.parse(rawInput);
    const sess = this.sessions.get(validId);
    if (!sess || sess.nodeId !== node.id || sess.epoch !== node.epoch) {
      return { closed: true, closeReason: 'session_absent', frames: [] };
    }
    if (node.revoked || this.store.now() >= sess.expiresAt) {
      sess.closed = true;
      sess.closeReason = node.revoked ? 'node_unpaired' : 'expired';
    }
    if (!sess.closed) {
      for (const frame of batch.frames) {
        this.enqueueFrame(sess, 'n2c', frame);
      }
    }
    const inbound = sess.c2nQueue.splice(0, 64);
    for (const frame of inbound) {
      if (frame.kind === 'data' && frame.dataBase64) {
        const st = sess.streams.get(frame.streamId);
        if (st) st.c2nBytes = Math.max(0, st.c2nBytes - Math.floor((frame.dataBase64.length * 3) / 4));
      }
    }
    return {
      closed: sess.closed,
      closeReason: sess.closeReason,
      relayStreamsOpened: sess.relayStreamsOpened,
      frames: inbound,
    };
  }

  private enqueueFrame(sess: TunnelRuntimeSession, dir: 'c2n' | 'n2c', frame: RelayFrame) {
    const queue = dir === 'c2n' ? sess.c2nQueue : sess.n2cQueue;
    requireCondition(queue.length < 512, 429, 'relay_queue_full', '中转帧队列已达上限');
    let st = sess.streams.get(frame.streamId);
    if (frame.kind === 'open') {
      requireCondition(dir === 'c2n', 400, 'invalid_relay_open', '仅控制端可发起目标流');
      requireCondition(!st, 409, 'duplicate_relay_stream_id', `流 ${frame.streamId} 已使用`);
      requireCondition(sess.streams.size < 64, 429, 'starferry_session_stream_budget', '单次隧道会话累计流数已达上限 64');
      const activeCount = [...sess.streams.values()].filter(s => !s.closed).length;
      requireCondition(activeCount < MAX_ACTIVE_STREAMS, 429, 'starferry_stream_limit', '并发流数量已达上限 16');
      st = { streamId: frame.streamId, c2nBytes: 0, n2cBytes: 0, closed: false };
      sess.streams.set(frame.streamId, st);
      sess.relayStreamsOpened++;
    }
    if (!st) {
      if (frame.kind === 'close') return;
      requireCondition(false, 400, 'unknown_relay_stream', `未知流 ${frame.streamId}`);
    }
    if (st.closed) {
      if (frame.kind === 'close') return;
      requireCondition(false, 409, 'closed_relay_stream', `流 ${frame.streamId} 已关闭`);
    }
    if (frame.kind === 'data' && frame.dataBase64) {
      const byteEst = Math.max(1, Math.floor((frame.dataBase64.length * 3) / 4));
      if (dir === 'c2n') {
        requireCondition(st.c2nBytes + byteEst <= MAX_QUEUED_STREAM_BYTES, 429, 'relay_backpressure', '控制端到节点中转缓冲已满');
        st.c2nBytes += byteEst;
      } else {
        requireCondition(st.n2cBytes + byteEst <= MAX_QUEUED_STREAM_BYTES, 429, 'relay_backpressure', '节点到控制端中转缓冲已满');
        st.n2cBytes += byteEst;
      }
    }
    if (frame.kind === 'close') {
      st.closed = true;
    }
    queue.push(frame);
  }

  closeSession(userId: string, tunnelSessionId: string) {
    const validId = identifier.parse(tunnelSessionId);
    const row = this.store.db.prepare(
      'SELECT * FROM starferry_tunnels WHERE tunnel_session_id=? AND user_id=?',
    ).get(validId, userId) as unknown as StarferryTunnelRow | undefined;
    requireCondition(row, 404, 'starferry_session_not_found', '未找到该隧道会话');
    const now = this.store.now();
    const sess = this.sessions.get(validId);
    if (sess) {
      sess.closed = true;
      sess.closeReason = 'controller_closed';
    }
    this.store.db.prepare(
      "UPDATE starferry_tunnels SET status='closed', closed_at=COALESCE(closed_at, ?) WHERE tunnel_session_id=?",
    ).run(now, validId);
    return { closed: true, tunnelSessionId: validId, operationId: row.operation_id };
  }
}
