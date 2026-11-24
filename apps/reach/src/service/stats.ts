// Copyright (c) Ray Zhang. 控制台统计：只从操作账本、回执和设备事件聚合，不估算、不补点。
import { z } from 'zod';
import { identifier } from '../contracts/protocol.ts';
import type { ReachStore } from './store.ts';

const DAY = 86_400_000;
export const statsQuerySchema = z.strictObject({
  days: z.coerce.number().int().refine(v => v === 7 || v === 14 || v === 30, '统计范围只支持 7、14、30 天').default(14),
  // 浏览器本地时区相对 UTC 的分钟数（即 -Date#getTimezoneOffset()），用于按本地自然日分桶。
  tz: z.coerce.number().int().min(-840).max(840).default(0),
  node: identifier.optional(),
});
export interface DailyStat { day: number; total: number; succeeded: number; failed: number; cancelled: number; unknown: number; active: number; uplinkBytes: number; downlinkBytes: number; receipts: number }

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export function computeStats(store: ReachStore, userId: string, rawQuery: unknown) {
  const { days, tz, node: nodeFilter } = statsQuerySchema.parse(rawQuery);
  // 可选按设备过滤；参数放进 SQL 绑定，不拼接值。
  const only = (column: string) => nodeFilter ? ` AND ${column}=?` : '';
  const bind = (...values: (string | number)[]) => nodeFilter ? [...values, nodeFilter] : values;
  if (nodeFilter) store.ownedNode(userId, nodeFilter);
  const now = store.now(); const shift = tz * 60_000;
  const today = Math.floor((now + shift) / DAY);
  const firstDay = today - days + 1;
  const start = firstDay * DAY - shift;
  const daily = new Map<number, DailyStat>();
  for (let d = firstDay; d <= today; d++) daily.set(d, { day: d, total: 0, succeeded: 0, failed: 0, cancelled: 0, unknown: 0, active: 0, uplinkBytes: 0, downlinkBytes: 0, receipts: 0 });
  const db = store.db;
  const dayOf = (column: string) => `CAST((${column} + ${shift}) / ${DAY} AS INTEGER)`;

  for (const row of db.prepare(`SELECT ${dayOf('created_at')} AS d, execution, COUNT(*) AS n, SUM(LENGTH(command_json)) AS b FROM operations WHERE user_id=? AND created_at>=?${only('node_id')} GROUP BY d, execution`).all(...bind(userId, start)) as { d: number; execution: string; n: number; b: number }[]) {
    const bucket = daily.get(Number(row.d)); if (!bucket) continue;
    const n = Number(row.n);
    bucket.total += n; bucket.downlinkBytes += Number(row.b);
    if (row.execution === 'succeeded' || row.execution === 'failed' || row.execution === 'cancelled' || row.execution === 'unknown') bucket[row.execution] += n; else bucket.active += n;
  }
  for (const row of db.prepare(`SELECT ${dayOf('e.received_at')} AS d, COUNT(*) AS n, SUM(LENGTH(e.data_json)) AS b FROM operation_events e JOIN operations o ON o.id=e.operation_id WHERE o.user_id=? AND e.received_at>=?${only('o.node_id')} GROUP BY d`).all(...bind(userId, start)) as { d: number; n: number; b: number }[]) {
    const bucket = daily.get(Number(row.d)); if (!bucket) continue;
    bucket.receipts += Number(row.n); bucket.uplinkBytes += Number(row.b);
  }

  const kinds = (db.prepare(`SELECT json_extract(command_json,'$.kind') AS kind, COUNT(*) AS n FROM operations WHERE user_id=? AND created_at>=?${only('node_id')} GROUP BY kind ORDER BY n DESC, kind`).all(...bind(userId, start)) as { kind: string; n: number }[])
    .map(row => ({ kind: String(row.kind), count: Number(row.n) }));
  const devices = (db.prepare(`SELECT o.node_id AS nodeId, n.name AS name, COUNT(*) AS total, SUM(o.execution='succeeded') AS succeeded, SUM(o.execution IN ('failed','cancelled')) AS failed, SUM(o.execution='unknown') AS unknown FROM operations o JOIN nodes n ON n.id=o.node_id WHERE o.user_id=? AND o.created_at>=?${only('o.node_id')} GROUP BY o.node_id ORDER BY total DESC, name`).all(...bind(userId, start)) as Record<string, string | number>[])
    .map(row => ({ nodeId: String(row.nodeId), name: String(row.name), total: Number(row.total), succeeded: Number(row.succeeded), failed: Number(row.failed), unknown: Number(row.unknown) }));
  // 时长 = 发起到最后一次状态更新；只统计已有终态的操作。
  const durations = (db.prepare(`SELECT updated_at - created_at AS ms FROM operations WHERE user_id=? AND created_at>=?${only('node_id')} AND execution IN ('succeeded','failed','cancelled') ORDER BY ms`).all(...bind(userId, start)) as { ms: number }[]).map(row => Math.max(0, Number(row.ms)));
  const terminal = [...daily.values()].reduce((sum, d) => sum + d.succeeded + d.failed + d.cancelled + d.unknown, 0);
  const succeeded = [...daily.values()].reduce((sum, d) => sum + d.succeeded, 0);

  // 可用性：只依据已记录的断线恢复区间与当前离线区间；首次上线前及事件表建立前没有数据，不计入。
  const availability = store.nodes(userId).filter(node => !Number((node as Record<string, unknown>).revoked) && (!nodeFilter || (node as Record<string, unknown>).id === nodeFilter)).map(raw => {
    const node = raw as unknown as { id: string; name: string; epoch: number; online: boolean; capabilities: string[]; last_seen: number | null; lastHeartbeatAt: number | null };
    const first = db.prepare("SELECT at FROM node_events WHERE node_id=? AND epoch=? AND kind='first_online'").get(node.id, node.epoch) as { at: number } | undefined;
    if (!first || !node.capabilities.length) return { nodeId: node.id, name: node.name, since: null, ratio: null, offline: [] as [number, number][] };
    const since = Math.max(start, Number(first.at));
    const offline: [number, number][] = [];
    for (const row of db.prepare("SELECT offline_since, at FROM node_events WHERE node_id=? AND epoch=? AND kind='reconnected' AND at>? ORDER BY sequence").all(node.id, node.epoch, since) as { offline_since: number; at: number }[]) {
      offline.push([Math.max(since, Number(row.offline_since)), Number(row.at)]);
    }
    if (!node.online) { const last = Math.max(node.last_seen ?? 0, node.lastHeartbeatAt ?? 0); if (last && now > Math.max(since, last)) offline.push([Math.max(since, last), now]); }
    const span = now - since; const down = offline.reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0);
    return { nodeId: node.id, name: node.name, since, ratio: span > 0 ? Math.max(0, 1 - down / span) : null, offline };
  });
  const events = Object.fromEntries((db.prepare(`SELECT ${dayOf('at')} AS d, COUNT(*) AS n FROM node_events WHERE user_id=? AND kind='reconnected' AND at>=?${only('node_id')} GROUP BY d`).all(...bind(userId, start)) as { d: number; n: number }[]).map(row => [Number(row.d), Number(row.n)]));

  return {
    days, tz, from: start, to: now,
    daily: [...daily.values()].map(d => ({ ...d, date: new Date(d.day * DAY).toISOString().slice(0, 10), reconnects: events[d.day] ?? 0 })),
    totals: { operations: [...daily.values()].reduce((s, d) => s + d.total, 0), succeeded, terminal, successRate: terminal ? succeeded / terminal : null, uplinkBytes: [...daily.values()].reduce((s, d) => s + d.uplinkBytes, 0), downlinkBytes: [...daily.values()].reduce((s, d) => s + d.downlinkBytes, 0), receipts: [...daily.values()].reduce((s, d) => s + d.receipts, 0) },
    durations: { count: durations.length, p50: percentile(durations, 0.5), p90: percentile(durations, 0.9) },
    kinds, devices, availability,
  };
}
