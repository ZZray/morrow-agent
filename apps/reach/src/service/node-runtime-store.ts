// Copyright (c) Ray Zhang. Decoupled minute-level node heartbeats, versioned remote config, and receipt reconciliation (REQ-04).
import { z } from 'zod';
import { identifier, nodeConfigUpdateSchema, nodeHeartbeatSchema } from '../contracts/protocol.ts';
import type { NodeRow, ReachStore } from './store.ts';
import { requireCondition } from './errors.ts';

interface NodeRuntimeRow {
  node_id: string;
  epoch: number;
  last_heartbeat_at: number | null;
  effective_heartbeat_seconds: number;
  effective_config_version: number;
  resident_state: string;
  ssh_status_json: string | null;
  updated_at: number;
}

interface NodeConfigRequestRow {
  node_id: string;
  epoch: number;
  target_version: number;
  request_id: string;
  user_id: string;
  heartbeat_seconds: number;
  status: 'pending' | 'applied' | 'rejected';
  receipt_json: string | null;
  created_at: number;
  settled_at: number | null;
}

export class NodeRuntimeStore {
  readonly store: ReachStore;
  constructor(store: ReachStore) {
    this.store = store;
  }

  desiredForNode(node: NodeRow) {
    if (node.revoked) return null;
    const pending = this.store.db.prepare(
      "SELECT target_version, request_id, heartbeat_seconds FROM node_config_requests WHERE node_id=? AND epoch=? AND status='pending' ORDER BY target_version DESC LIMIT 1",
    ).get(node.id, node.epoch) as unknown as Pick<NodeConfigRequestRow, 'target_version' | 'request_id' | 'heartbeat_seconds'> | undefined;
    if (!pending) return null;
    return {
      targetVersion: pending.target_version,
      requestId: pending.request_id,
      heartbeatIntervalSeconds: pending.heartbeat_seconds,
    };
  }

  recordHeartbeat(node: NodeRow, rawInput: unknown) {
    const input = nodeHeartbeatSchema.parse(rawInput);
    return this.store.transaction(() => {
      const now = this.store.now();
      this.store.hello(node, input.version, input.capabilities);
      const sshJson = input.sshStatus ? JSON.stringify(input.sshStatus) : null;
      this.store.db.prepare(`
        INSERT INTO node_runtime(node_id, epoch, last_heartbeat_at, effective_heartbeat_seconds, effective_config_version, resident_state, ssh_status_json, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
          epoch=excluded.epoch,
          last_heartbeat_at=excluded.last_heartbeat_at,
          effective_heartbeat_seconds=excluded.effective_heartbeat_seconds,
          effective_config_version=excluded.effective_config_version,
          resident_state=excluded.resident_state,
          ssh_status_json=CASE WHEN node_runtime.epoch=excluded.epoch THEN COALESCE(excluded.ssh_status_json, node_runtime.ssh_status_json) ELSE excluded.ssh_status_json END,
          updated_at=excluded.updated_at
      `).run(
        node.id,
        node.epoch,
        now,
        input.effectiveHeartbeatSeconds,
        input.effectiveConfigVersion,
        input.residentState,
        sshJson,
        now,
      );

      let ackVersion = input.effectiveConfigVersion;
      if (input.configReceipt) {
        const receipt = input.configReceipt;
        const reqRow = this.store.db.prepare(
          'SELECT * FROM node_config_requests WHERE node_id=? AND epoch=? AND target_version=? AND request_id=?',
        ).get(node.id, node.epoch, receipt.targetVersion, receipt.requestId) as unknown as NodeConfigRequestRow | undefined;
        if (reqRow) {
          if (reqRow.status === 'pending') {
            this.store.db.prepare(
              'UPDATE node_config_requests SET status=?, receipt_json=?, settled_at=? WHERE node_id=? AND epoch=? AND target_version=?',
            ).run(receipt.status, JSON.stringify(receipt), now, node.id, node.epoch, receipt.targetVersion);
            // Older pending versions superseded by this applied receipt are settled as superseded/rejected.
            if (receipt.status === 'applied') {
              this.store.db.prepare(
                "UPDATE node_config_requests SET status='rejected', receipt_json=?, settled_at=? WHERE node_id=? AND epoch=? AND target_version<? AND status='pending'",
              ).run(JSON.stringify({ reason: 'superseded_by_newer_version', supersededBy: receipt.targetVersion }), now, node.id, node.epoch, receipt.targetVersion);
            }
          }
          ackVersion = Math.max(ackVersion, receipt.targetVersion);
        }
      }

      return {
        accepted: true,
        ackConfigVersion: ackVersion,
        desiredConfig: this.desiredForNode(node),
      };
    });
  }

  updateConfig(userId: string, nodeId: string, rawInput: unknown) {
    const input = nodeConfigUpdateSchema.parse(rawInput);
    const validNodeId = identifier.parse(nodeId);
    return this.store.transaction(() => {
      const node = this.store.ownedNode(userId, validNodeId);
      requireCondition(!node.revoked, 409, 'node_unpaired', '设备已解绑，无法下发远程配置');

      const priorByReq = this.store.db.prepare(
        'SELECT * FROM node_config_requests WHERE user_id=? AND request_id=?',
      ).get(userId, input.requestId) as unknown as NodeConfigRequestRow | undefined;
      if (priorByReq) {
        requireCondition(
          priorByReq.node_id === node.id && priorByReq.epoch === node.epoch && priorByReq.heartbeat_seconds === input.heartbeatIntervalSeconds,
          409,
          'config_request_conflict',
          '同一配置 requestId 不能用于不同节点或参数',
        );
        return this.readRuntime(userId, node.id);
      }

      const maxRow = this.store.db.prepare(
        'SELECT COALESCE(MAX(target_version), 0) AS max_ver FROM node_config_requests WHERE node_id=? AND epoch=?',
      ).get(node.id, node.epoch) as unknown as { max_ver: number };
      const rtRow = this.store.db.prepare(
        'SELECT effective_config_version FROM node_runtime WHERE node_id=? AND epoch=?',
      ).get(node.id, node.epoch) as unknown as { effective_config_version: number } | undefined;
      const targetVersion = Math.max(Number(maxRow.max_ver), rtRow?.effective_config_version ?? 0) + 1;

      // REQ-04.1: Dispatched config stays 'pending' until the Node sends an authenticated
      // configReceipt; effective_config_version and effective_heartbeat_seconds are NOT mutated here.
      this.store.db.prepare(`
        INSERT INTO node_config_requests(node_id, epoch, target_version, request_id, user_id, heartbeat_seconds, status, receipt_json, created_at, settled_at)
        VALUES(?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)
      `).run(node.id, node.epoch, targetVersion, input.requestId, userId, input.heartbeatIntervalSeconds, this.store.now());

      this.store.audit(userId, 'node.config_requested', `${node.id}:v${targetVersion}`);
      return this.readRuntime(userId, node.id);
    });
  }

  enrichNodeSummary(row: Record<string, unknown>) {
    const nodeId = String(row.id);
    const epoch = Number(row.epoch);
    const revoked = Boolean(row.revoked);
    const lastSeen = row.last_seen === null || row.last_seen === undefined ? null : Number(row.last_seen);
    const rt = this.store.db.prepare(
      'SELECT * FROM node_runtime WHERE node_id=? AND epoch=?',
    ).get(nodeId, epoch) as unknown as NodeRuntimeRow | undefined;
    const latestReq = this.store.db.prepare(
      'SELECT * FROM node_config_requests WHERE node_id=? AND epoch=? ORDER BY target_version DESC LIMIT 1',
    ).get(nodeId, epoch) as unknown as NodeConfigRequestRow | undefined;

    const effectiveSeconds = rt?.effective_heartbeat_seconds ?? 60;
    const onlineWindowMs = rt?.last_heartbeat_at ? Math.max(30_000, effectiveSeconds * 2_500) : 30_000;
    const latestActivity = Math.max(lastSeen ?? 0, rt?.last_heartbeat_at ?? 0);
    const online = !revoked && latestActivity > 0 && (this.store.now() - latestActivity) < onlineWindowMs;

    const { token_hash: _omittedTokenHash, ...publicRow } = row;
    return {
      ...publicRow,
      capabilities: JSON.parse(String(row.capabilities)),
      online,
      lastHeartbeatAt: rt?.last_heartbeat_at ?? null,
      residentState: rt?.resident_state ?? (online ? 'connected' : 'offline_backoff'),
      effectiveHeartbeatSeconds: effectiveSeconds,
      effectiveConfigVersion: rt?.effective_config_version ?? 0,
      desiredConfig: latestReq
        ? {
            requestId: latestReq.request_id,
            targetVersion: latestReq.target_version,
            heartbeatIntervalSeconds: latestReq.heartbeat_seconds,
            status: latestReq.status,
            createdAt: latestReq.created_at,
            settledAt: latestReq.settled_at,
            receipt: latestReq.receipt_json ? JSON.parse(latestReq.receipt_json) : null,
          }
        : null,
      sshStatus: rt?.ssh_status_json ? JSON.parse(rt.ssh_status_json) : null,
    };
  }

  readRuntime(userId: string, nodeId: string) {
    const validNodeId = identifier.parse(nodeId);
    const node = this.store.ownedNode(userId, validNodeId);
    const summary = this.enrichNodeSummary(node as unknown as Record<string, unknown>);
    const history = (this.store.db.prepare(
      'SELECT target_version, request_id, heartbeat_seconds, status, receipt_json, created_at, settled_at FROM node_config_requests WHERE node_id=? AND epoch=? ORDER BY target_version DESC LIMIT 20',
    ).all(node.id, node.epoch) as unknown as Omit<NodeConfigRequestRow, 'node_id' | 'epoch' | 'user_id'>[]).map(r => ({
      targetVersion: r.target_version,
      requestId: r.request_id,
      heartbeatIntervalSeconds: r.heartbeat_seconds,
      status: r.status,
      createdAt: r.created_at,
      settledAt: r.settled_at,
      receipt: r.receipt_json ? JSON.parse(r.receipt_json) : null,
    }));
    const rawSummary = summary as Record<string, unknown>;
    delete rawSummary.token_hash;
    return {
      ...rawSummary,
      configHistory: history,
    };
  }
}

export const nodeConfigMcpInputSchema = z.strictObject({
  nodeId: identifier,
  requestId: identifier,
  heartbeatIntervalSeconds: z.number().int().min(30).max(3600),
});
