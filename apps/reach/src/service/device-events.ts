// Copyright (c) Ray Zhang. Device online notifications: first-online and reconnect transitions observed from real Node contact.
import { z } from 'zod';
import type { NodeRow, ReachStore } from './store.ts';

export type DeviceEventKind = 'first_online' | 'reconnected';
interface DeviceEventRow { sequence: number; node_id: string; epoch: number; kind: DeviceEventKind; offline_since: number | null; at: number; read_at: number | null; name: string }

const pageSchema = z.strictObject({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const sequence = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const markReadSchema = z.union([z.strictObject({ upTo: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }), z.strictObject({ sequences: z.array(sequence).min(1).max(200) })]);

// 与 NodeRuntimeStore.enrichNodeSummary 的在线窗口保持同一口径。
export function onlineWindowMs(lastHeartbeatAt: number | null, effectiveHeartbeatSeconds: number) {
  return lastHeartbeatAt ? Math.max(30_000, effectiveHeartbeatSeconds * 2_500) : 30_000;
}

export class DeviceEvents {
  readonly store: ReachStore;
  constructor(store: ReachStore) {
    this.store = store;
    const existed = !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='node_events'").get();
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS node_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL REFERENCES users(id),node_id TEXT NOT NULL REFERENCES nodes(id),epoch INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('first_online','reconnected')),offline_since INTEGER,at INTEGER NOT NULL,read_at INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS node_events_first_online ON node_events(node_id,epoch) WHERE kind='first_online';
      CREATE INDEX IF NOT EXISTS node_events_user ON node_events(user_id,sequence);
    `);
    // 新建表时，已上报过能力的现有设备视为早已上线：补一条已读记录，避免升级后批量误报「首次上线」。
    if (!existed) store.db.prepare("INSERT OR IGNORE INTO node_events(user_id,node_id,epoch,kind,offline_since,at,read_at) SELECT user_id,id,epoch,'first_online',NULL,COALESCE(last_seen,0),? FROM nodes WHERE capabilities<>'[]' AND revoked=0").run(store.now());
  }

  // 在 hello() 更新 last_seen 之前调用：只依据库内当前记录判断状态变化，不信任请求开始时读到的节点快照。
  observeContact(node: NodeRow, capabilities: string[]) {
    if (!capabilities.length) return;
    const current = this.store.db.prepare('SELECT user_id,epoch,last_seen,revoked FROM nodes WHERE id=?').get(node.id) as { user_id: string; epoch: number; last_seen: number | null; revoked: number } | undefined;
    if (!current || current.revoked || current.epoch !== node.epoch) return;
    const now = this.store.now();
    const first = this.store.db.prepare("INSERT OR IGNORE INTO node_events(user_id,node_id,epoch,kind,offline_since,at) VALUES(?,?,?,'first_online',NULL,?)").run(current.user_id, node.id, node.epoch, now);
    if (first.changes) { this.store.audit(current.user_id, 'node.first_online', node.id); return; }
    const runtime = this.store.db.prepare('SELECT last_heartbeat_at,effective_heartbeat_seconds FROM node_runtime WHERE node_id=? AND epoch=?').get(node.id, node.epoch) as { last_heartbeat_at: number | null; effective_heartbeat_seconds: number } | undefined;
    const lastActivity = Math.max(current.last_seen ?? 0, runtime?.last_heartbeat_at ?? 0);
    if (!lastActivity || now - lastActivity < onlineWindowMs(runtime?.last_heartbeat_at ?? null, runtime?.effective_heartbeat_seconds ?? 60)) return;
    this.store.db.prepare("INSERT INTO node_events(user_id,node_id,epoch,kind,offline_since,at) VALUES(?,?,?,'reconnected',?,?)").run(current.user_id, node.id, node.epoch, lastActivity, now);
    this.store.audit(current.user_id, 'node.reconnected', node.id);
  }

  // after 省略时返回最近 limit 条；给出 after 时按序号向后增量读取，浏览器重连后接着读原事件。
  list(userId: string, query: unknown) {
    const input = pageSchema.parse(query);
    const select = 'SELECT e.sequence,e.node_id,e.epoch,e.kind,e.offline_since,e.at,e.read_at,n.name FROM node_events e JOIN nodes n ON n.id=e.node_id WHERE e.user_id=?';
    const rows = (input.after === undefined
      ? (this.store.db.prepare(`${select} ORDER BY e.sequence DESC LIMIT ?`).all(userId, input.limit) as unknown as DeviceEventRow[]).reverse()
      : this.store.db.prepare(`${select} AND e.sequence>? ORDER BY e.sequence LIMIT ?`).all(userId, input.after, input.limit) as unknown as DeviceEventRow[]);
    const nextAfter = rows.length ? Number(rows.at(-1)!.sequence) : input.after ?? Number((this.store.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM node_events WHERE user_id=?').get(userId) as { n: number }).n);
    const more = this.store.db.prepare('SELECT 1 FROM node_events WHERE user_id=? AND sequence>? LIMIT 1').get(userId, nextAfter);
    return {
      events: rows.map(row => ({ sequence: Number(row.sequence), nodeId: row.node_id, nodeName: row.name, epoch: row.epoch, kind: row.kind, offlineSince: row.offline_since, at: row.at, read: row.read_at !== null })),
      nextAfter, hasMore: !!more, unreadCount: this.unread(userId),
    };
  }

  markRead(userId: string, input: unknown) {
    const parsed = markReadSchema.parse(input);
    if ('upTo' in parsed) this.store.db.prepare('UPDATE node_events SET read_at=? WHERE user_id=? AND sequence<=? AND read_at IS NULL').run(this.store.now(), userId, parsed.upTo);
    else this.store.transaction(() => { const mark = this.store.db.prepare('UPDATE node_events SET read_at=? WHERE user_id=? AND sequence=? AND read_at IS NULL'); for (const value of new Set(parsed.sequences)) mark.run(this.store.now(), userId, value); });
    return { unreadCount: this.unread(userId) };
  }

  unread(userId: string) {
    return Number((this.store.db.prepare('SELECT COUNT(*) AS n FROM node_events WHERE user_id=? AND read_at IS NULL').get(userId) as { n: number }).n);
  }
}
