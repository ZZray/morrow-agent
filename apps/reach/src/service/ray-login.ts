// Copyright (c) Ray Zhang. One-time Ray-to-Reach login assertions, never OTP access.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ReachError, requireCondition } from './errors.ts';

const assertion = z.strictObject({ audience: z.literal('ry-reach-ray-login-v1'), purpose: z.enum(['login', 'validate']).default('login'), nonce: z.string().regex(/^[a-f0-9]{64}$/), sessionHash: z.string().regex(/^[a-f0-9]{64}$/), issuedAt: z.number().int().safe(), expiresAt: z.number().int().safe(), reachToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional() });
const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
export class RayLoginBridge {
  readonly db: DatabaseSync;
  readonly key: Buffer;
  readonly username: string;
  readonly now: () => number;
  constructor(key: Buffer, username: string, database: string, now = Date.now) {
    if (key.length !== 32 || !username || username.length > 128) throw new Error('Invalid Ray login bridge configuration');
    this.key = key; this.username = username; this.now = now;
    this.db = new DatabaseSync(database);
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 1) { this.db.close(); throw new Error('Newer Ray login nonce schema'); }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS nonces(nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS ray_sessions(token_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, expires_at INTEGER NOT NULL); PRAGMA user_version=1;');
  }
  close() { this.db.close(); }
  tokenForSession(sessionHash: string) { return createHmac('sha256', this.key).update(JSON.stringify(['reach-browser-session-v1', this.username, sessionHash])).digest('base64url'); }
  bind(token: string, sessionHash: string, expiresAt: number) { this.db.prepare('INSERT INTO ray_sessions VALUES(?,?,?) ON CONFLICT(token_hash) DO UPDATE SET session_hash=excluded.session_hash,expires_at=excluded.expires_at').run(tokenHash(token), sessionHash, expiresAt); }
  isRayToken(token: string) { return !!this.db.prepare('SELECT 1 FROM ray_sessions WHERE token_hash=?').get(tokenHash(token)); }
  reusable(token: string, sessionHash: string) {
    return this.db.prepare('SELECT expires_at FROM ray_sessions WHERE token_hash=? AND session_hash=? AND expires_at>?').get(tokenHash(token), sessionHash, this.now()) as { expires_at: number } | undefined;
  }
  consume(value: unknown) {
    requireCondition(typeof value === 'string' && value.length < 4096, 401, 'ray_assertion_invalid', 'Ray 登录校验失败');
    const parts = value.split('.'); const [encoded, signature] = parts;
    requireCondition(parts.length === 2 && /^[A-Za-z0-9_-]+$/.test(encoded) && /^[a-f0-9]{64}$/.test(signature ?? ''), 401, 'ray_assertion_invalid', 'Ray 登录校验失败');
    const expected = createHmac('sha256', this.key).update(encoded).digest();
    requireCondition(timingSafeEqual(expected, Buffer.from(signature, 'hex')), 401, 'ray_assertion_invalid', 'Ray 登录校验失败');
    let input: z.infer<typeof assertion>;
    try { input = assertion.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))); }
    catch { throw new ReachError(401, 'ray_assertion_invalid', 'Ray 登录校验失败'); }
    const now = this.now();
    requireCondition(input.issuedAt <= now + 5000 && input.issuedAt >= now - 30000 && input.expiresAt > now, 401, 'ray_assertion_expired', 'Ray 登录已过期');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM nonces WHERE expires_at < ?').run(now);
      const accepted = this.db.prepare('INSERT OR IGNORE INTO nonces VALUES(?,?)').run(input.nonce, input.issuedAt + 35000);
      requireCondition(accepted.changes === 1, 401, 'ray_assertion_replayed', 'Ray 登录请求已使用');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { username: this.username, expiresAt: Math.min(input.expiresAt, now + 12 * 60 * 60 * 1000), sessionHash: input.sessionHash, reachToken: input.reachToken, purpose: input.purpose };
  }
}
