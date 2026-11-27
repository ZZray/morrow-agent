// Copyright (c) Ray Zhang. 控制台 PIN 登录：单一所有者 PIN，默认 2026；连续错误 3 次锁定 1 小时（全局计数，防止换 IP 穷举）。
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ReachStore } from './store.ts';
import { ReachError, requireCondition } from './errors.ts';

export const DEFAULT_PIN = '2026';
export const MAX_PIN_ATTEMPTS = 3;
export const PIN_LOCK_MS = 60 * 60 * 1000;
export const pinSchema = z.string().regex(/^\d{4,12}$/, 'PIN 需为 4–12 位数字');
interface PinRow { user_id: string | null; salt: string; hash: string; is_default: number; failures: number; locked_until: number | null }

function digest(pin: string, salt: string) { return scryptSync(pin, salt, 32).toString('hex'); }

export class PinLogin {
  readonly store: ReachStore;
  // initialPin 只在首次建表时生效；reset=true 时把 PIN 重置为 initialPin 并解除锁定（用于忘记 PIN）。
  constructor(store: ReachStore, initialPin = DEFAULT_PIN, reset = false, requirePrivate = false) {
    this.store = store;
    const pin = pinSchema.parse(initialPin);
    store.transaction(() => {
      store.db.exec('CREATE TABLE IF NOT EXISTS pin_auth(id INTEGER PRIMARY KEY CHECK(id=1), user_id TEXT REFERENCES users(id), salt TEXT NOT NULL, hash TEXT NOT NULL, is_default INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER, updated_at INTEGER NOT NULL)');
      const existing = store.db.prepare('SELECT is_default FROM pin_auth WHERE id=1').get();
      if (existing && !reset) {
        requireCondition(!requirePrivate || existing.is_default === 0, 500, 'private_pin_required', '独立 PIN 登录必须使用私有 PIN');
        return;
      }
      requireCondition(!requirePrivate || pin !== DEFAULT_PIN, 500, 'private_pin_required', '独立 PIN 登录必须使用私有 PIN');
      // 所有者在首次 PIN 登录时绑定（见 owner()），这里不建账户，避免抢在账户初始化之前。
      const salt = randomBytes(16).toString('hex');
      store.db.prepare('INSERT INTO pin_auth(id,user_id,salt,hash,is_default,failures,locked_until,updated_at) VALUES(1,NULL,?,?,?,0,NULL,?) ON CONFLICT(id) DO UPDATE SET salt=excluded.salt,hash=excluded.hash,is_default=excluded.is_default,failures=0,locked_until=NULL,updated_at=excluded.updated_at')
        .run(salt, digest(pin, salt), pin === DEFAULT_PIN ? 1 : 0, store.now());
      store.audit('system', reset && existing ? 'pin.reset' : 'pin.initialized', 'pin');
    });
  }

  private row() { return this.store.db.prepare('SELECT * FROM pin_auth WHERE id=1').get() as unknown as PinRow; }

  // PIN 归属第一个账户；还没有账户时建一个所有者账户，它的密码随机且不对外，只能用 PIN 登录。
  private owner(row: PinRow): string {
    if (row.user_id) return row.user_id;
    return this.store.transaction(() => {
      let owner = this.store.db.prepare('SELECT id FROM users ORDER BY rowid LIMIT 1').get() as { id: string } | undefined;
      if (!owner) {
        const id = randomUUID(), salt = randomBytes(16).toString('hex');
        this.store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id, 'reach', salt, scryptSync(randomBytes(32), salt, 64).toString('hex'));
        this.store.audit(id, 'account.created', id); owner = { id };
      }
      this.store.db.prepare('UPDATE pin_auth SET user_id=? WHERE id=1').run(owner.id);
      return owner.id;
    });
  }

  login(rawPin: unknown, rayUsername?: string) {
    const now = this.store.now();
    const row = this.row();
    if (rayUsername !== undefined) {
      const owner = row.user_id && this.store.db.prepare('SELECT username FROM users WHERE id=?').get(row.user_id);
      requireCondition(row.is_default === 0 && owner && owner.username === rayUsername, 403, 'private_pin_required', '请先在已登录的 Ray 控制台设置私有 Reach PIN');
    }
    if (row.locked_until && row.locked_until > now) throw new ReachError(429, 'pin_locked', `PIN 连续输错 ${MAX_PIN_ATTEMPTS} 次，已锁定，约 ${Math.ceil((row.locked_until - now) / 60000)} 分钟后再试`);
    const pin = typeof rawPin === 'string' && /^\d{1,12}$/.test(rawPin) ? rawPin : '';
    const ok = timingSafeEqual(Buffer.from(digest(pin, row.salt), 'hex'), Buffer.from(row.hash, 'hex'));
    if (!ok) {
      const failures = row.failures + 1;
      if (failures >= MAX_PIN_ATTEMPTS) {
        this.store.db.prepare('UPDATE pin_auth SET failures=0, locked_until=? WHERE id=1').run(now + PIN_LOCK_MS);
        this.store.audit(row.user_id ?? 'system', 'pin.locked', 'pin');
        throw new ReachError(429, 'pin_locked', `PIN 连续输错 ${MAX_PIN_ATTEMPTS} 次，已锁定 1 小时`);
      }
      this.store.db.prepare('UPDATE pin_auth SET failures=?, locked_until=NULL WHERE id=1').run(failures);
      throw new ReachError(401, 'invalid_pin', `PIN 不正确，还可以再试 ${MAX_PIN_ATTEMPTS - failures} 次`);
    }
    this.store.db.prepare('UPDATE pin_auth SET failures=0, locked_until=NULL WHERE id=1').run();
    return this.store.issueSession(this.owner(row));
  }

  change(userId: string, input: unknown) {
    const { current, next } = z.strictObject({ current: z.string().max(12), next: pinSchema }).parse(input);
    return this.store.transaction(() => {
      const row = this.row();
      requireCondition(this.owner(row) === userId, 403, 'pin_owner_required', '只有 PIN 所有者可以修改 PIN');
      requireCondition(timingSafeEqual(Buffer.from(digest(current, row.salt), 'hex'), Buffer.from(row.hash, 'hex')), 400, 'invalid_pin', '当前 PIN 不正确');
      requireCondition(next !== DEFAULT_PIN, 400, 'pin_default_rejected', '新 PIN 不能是默认 PIN');
      const salt = randomBytes(16).toString('hex');
      this.store.db.prepare('UPDATE pin_auth SET salt=?, hash=?, is_default=0, failures=0, locked_until=NULL, updated_at=? WHERE id=1').run(salt, digest(next, salt), this.store.now());
      this.store.audit(userId, 'pin.changed', 'pin');
      return { changed: true };
    });
  }

  isDefault(userId: string) {
    const row = this.row();
    const owner = row.user_id ?? (this.store.db.prepare('SELECT id FROM users ORDER BY rowid LIMIT 1').get() as { id: string } | undefined)?.id;
    return owner === userId && !!row.is_default;
  }
}
