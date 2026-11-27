// Copyright (c) Ray Zhang. 网页模型设置：多个 OpenAI 兼容供应商共用一张表，Reach Desk 与现场 Agent 各自从中选定一个模型。
// 令牌只进服务端状态库，读接口只回是否已配置。草稿、测试、启用分开保存；启用时立即替换运行中的模型通道，失败则整次启用回滚。
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ReachStore } from './store.ts';
import { requireCondition } from './errors.ts';

export type ModelPurpose = 'desk' | 'agent';
export const modelPurposes: readonly ModelPurpose[] = ['desk', 'agent'];
export interface ModelConfig { endpoint: string; model: string; token: string; contextWindow?: number; maxOutput?: number; imageInput?: boolean }
export interface RunningModel { generation: number | null; source: 'settings' | 'environment'; endpoint: string; model: string; error?: string }
export interface ProviderModel { id: string; imageInput: boolean; contextWindow: number; maxOutput: number }
interface Row { purpose: ModelPurpose; provider_id: string | null; endpoint: string; model: string; token: string; context_window: number | null; max_output: number | null; image_input: number | null; generation: number; source: string; saved_at: number; test_generation: number | null; test_ok: number | null; test_at: number | null; test_message: string | null; test_latency_ms: number | null; enabled_generation: number | null; enabled_json: string | null; enabled_at: number | null }
interface ProviderRow { id: string; name: string; base_url: string; token: string; models_json: string; models_fetched_at: number | null; created_at: number; updated_at: number }

// 用户口径：上下文默认按 1M 处理；单次输出受 Agent 通道上限 8192 约束。
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const DEFAULT_MAX_OUTPUT = 8192;
const tokenSchema = z.string().trim().min(8, '令牌至少 8 个字符').max(4096).regex(/^[\x21-\x7e]+$/, '令牌只能包含可见 ASCII 字符');
const modelIdSchema = z.string().trim().min(1, '请填写模型 ID').max(256);
const providerInput = z.strictObject({ name: z.string().trim().min(1, '请填写供应商名称').max(60), baseUrl: z.string().trim().max(2048), token: tokenSchema.optional() });
const modelEntry = z.strictObject({ id: modelIdSchema, imageInput: z.boolean().default(false), contextWindow: z.number().int().min(1024).max(10_000_000).default(DEFAULT_CONTEXT_WINDOW), maxOutput: z.number().int().min(1).max(8192).default(DEFAULT_MAX_OUTPUT) })
  .refine(v => v.maxOutput <= v.contextWindow, { message: '单次输出上限不能超过上下文长度', path: ['maxOutput'] });
const modelsInput = z.strictObject({ models: z.array(modelEntry).max(500) });
const selectionInput = z.strictObject({ providerId: z.string().uuid(), model: modelIdSchema });
const enableSchema = z.strictObject({ generation: z.number().int().min(1) });
export const purposeSchema = z.enum(['desk', 'agent']);

// 测试与获取模型都只发一次有界请求，不重试；超时后中止。
const REQUEST_TIMEOUT_MS = 20_000;
const TEST_BODY_BYTES = 64 * 1024, LIST_BODY_BYTES = 1024 * 1024;

// 兼容 OpenAI 接口：地址填到版本路径为止，例如 https://api.example.com/v1；只填域名时补 /v1。
export function checkEndpoint(raw: string, allowLoopback: boolean) {
  let url: URL | undefined;
  try { url = new URL(raw); } catch { url = undefined; }
  requireCondition(url, 400, 'model_endpoint_invalid', '请求地址不是有效 URL');
  requireCondition(!url!.username && !url!.password && !url!.search && !url!.hash, 400, 'model_endpoint_invalid', '请求地址不能包含凭据、参数或锚点');
  const loopback = ['127.0.0.1', '[::1]'].includes(url!.hostname) && url!.protocol === 'http:' && !!url!.port;
  requireCondition(url!.protocol === 'https:' || (allowLoopback && loopback), 400, 'model_https_required', '请求地址须使用 HTTPS');
  const path = url!.pathname.replace(/\/+$/, '');
  requireCondition(!/\/(chat\/completions|models)$/.test(path), 400, 'model_endpoint_invalid', '请求地址只填到 /v1 这一级，不要带 /chat/completions');
  return `${url!.origin}${path || '/v1'}`;
}

// 从供应商的模型条目读能力声明：OMP 的 omp.{contextWindow,maxTokens,input}、通用的 context_window/max_tokens/input、CAS 的 input_modalities。
// 缺的项用默认值（上下文 1M、输出 8192、仅文本）补上；单次输出不超过 Agent 通道上限 8192，也不超过上下文。
export function declaredCapabilities(item: Record<string, unknown>): ProviderModel {
  const omp = (item.omp && typeof item.omp === 'object' ? item.omp : {}) as Record<string, unknown>;
  const positive = (...values: unknown[]) => { for (const v of values) if (Number.isSafeInteger(v) && (v as number) > 0) return v as number; return undefined; };
  const list = (...values: unknown[]) => { for (const v of values) if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string'); return undefined; };
  const contextWindow = Math.min(10_000_000, Math.max(1024, positive(omp.contextWindow, item.context_window, item.contextWindow, item.context_length) ?? DEFAULT_CONTEXT_WINDOW));
  const maxOutput = Math.min(DEFAULT_MAX_OUTPUT, contextWindow, positive(omp.maxTokens, item.max_tokens, item.maxTokens, item.max_output_tokens) ?? DEFAULT_MAX_OUTPUT);
  const input = list(omp.input, item.input, item.input_modalities, (item.architecture as Record<string, unknown> | undefined)?.input_modalities);
  return { id: String(item.id), contextWindow, maxOutput, imageInput: !!input?.includes('image') };
}
function redact(text: string, token: string) { return token ? text.split(token).join('[已隐去]') : text; }
async function readCapped(response: Response, limit: number) {
  const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  if (reader) for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > limit) { await reader.cancel(); break; } chunks.push(next.value); }
  return Buffer.concat(chunks).toString('utf8');
}
function upstreamError(status: number, text: string) {
  let body: any; try { body = JSON.parse(text); } catch { body = undefined; }
  const detail = typeof body?.error?.message === 'string' ? body.error.message : typeof body?.message === 'string' ? body.message : text;
  return `HTTP ${status}${detail ? `：${detail.replace(/\s+/g, ' ').trim().slice(0, 240)}` : ''}`;
}
function transportError(error: unknown) {
  if ((error as Error)?.name === 'TimeoutError') return `请求超过 ${REQUEST_TIMEOUT_MS / 1000} 秒未返回`;
  const cause = (error as { cause?: { code?: string } })?.cause?.code;
  return `无法连接请求地址（${cause ?? (error as Error)?.message ?? 'unknown'}）`;
}

export class ModelSettings {
  readonly store: ReachStore;
  readonly allowLoopback: boolean;
  constructor(store: ReachStore, allowLoopback = false) {
    this.store = store; this.allowLoopback = allowLoopback;
    store.db.exec(`CREATE TABLE IF NOT EXISTS model_providers(id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, token TEXT NOT NULL, models_json TEXT NOT NULL DEFAULT '[]', models_fetched_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS model_settings(purpose TEXT PRIMARY KEY CHECK(purpose IN ('desk','agent')), provider_id TEXT, endpoint TEXT NOT NULL, model TEXT NOT NULL, token TEXT NOT NULL,
      context_window INTEGER, max_output INTEGER, image_input INTEGER, generation INTEGER NOT NULL, source TEXT NOT NULL, saved_at INTEGER NOT NULL,
      test_generation INTEGER, test_ok INTEGER, test_at INTEGER, test_message TEXT, test_latency_ms INTEGER, enabled_generation INTEGER, enabled_json TEXT, enabled_at INTEGER)`);
    // 同日早期版本的表没有 provider_id 列，补上即可，原记录保留。
    const columns = store.db.prepare('PRAGMA table_info(model_settings)').all() as { name: string }[];
    if (!columns.some(c => c.name === 'provider_id')) store.db.exec('ALTER TABLE model_settings ADD COLUMN provider_id TEXT');
  }

  private row(purpose: ModelPurpose) { return this.store.db.prepare('SELECT * FROM model_settings WHERE purpose=?').get(purpose) as unknown as Row | undefined; }
  private provider(id: string) {
    const row = this.store.db.prepare('SELECT * FROM model_providers WHERE id=?').get(id) as unknown as ProviderRow | undefined;
    requireCondition(row, 404, 'model_provider_missing', '供应商不存在或已删除');
    return row!;
  }
  private models(row: ProviderRow) { return JSON.parse(row.models_json) as ProviderModel[]; }
  private config(row: Row): ModelConfig { return { endpoint: row.endpoint, model: row.model, token: row.token, ...(row.context_window !== null ? { contextWindow: row.context_window, maxOutput: row.max_output!, imageInput: !!row.image_input } : {}) }; }

  // ---------- 供应商 ----------
  providers() {
    const rows = this.store.db.prepare('SELECT * FROM model_providers ORDER BY created_at, rowid').all() as unknown as ProviderRow[];
    return rows.map(row => ({ id: row.id, name: row.name, baseUrl: row.base_url, tokenConfigured: !!row.token, models: this.models(row), modelsFetchedAt: row.models_fetched_at, updatedAt: row.updated_at }));
  }
  createProvider(userId: string, raw: unknown) {
    const input = providerInput.parse(raw);
    requireCondition(input.token, 400, 'model_token_missing', '新供应商需要填写令牌');
    const id = randomUUID(), now = this.store.now();
    this.store.db.prepare('INSERT INTO model_providers(id,name,base_url,token,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, input.name, checkEndpoint(input.baseUrl, this.allowLoopback), input.token!, now, now);
    this.store.audit(userId, 'model_provider.created', id);
    return { id };
  }
  // 不带令牌时保留原令牌。引用这个供应商的用途会生成新草稿，需要重新测试并启用；运行中的配置不变。
  updateProvider(userId: string, id: string, raw: unknown) {
    const input = providerInput.parse(raw);
    return this.store.transaction(() => {
      const row = this.provider(id);
      this.store.db.prepare('UPDATE model_providers SET name=?,base_url=?,token=?,updated_at=? WHERE id=?').run(input.name, checkEndpoint(input.baseUrl, this.allowLoopback), input.token ?? row.token, this.store.now(), id);
      this.store.audit(userId, input.token ? 'model_provider.updated_with_token' : 'model_provider.updated', id);
      this.resync(id);
      return { id };
    });
  }
  deleteProvider(userId: string, id: string) {
    return this.store.transaction(() => {
      this.provider(id);
      const used = (this.store.db.prepare('SELECT purpose FROM model_settings WHERE provider_id=?').all(id) as { purpose: string }[]).map(r => r.purpose === 'desk' ? 'Reach Desk' : '现场 Agent');
      requireCondition(!used.length, 409, 'model_provider_in_use', `${used.join('、')} 正在使用这个供应商，请先改选其他模型`);
      this.store.db.prepare('DELETE FROM model_providers WHERE id=?').run(id);
      this.store.audit(userId, 'model_provider.deleted', id);
      return { deleted: true };
    });
  }
  // 从供应商的 GET /models 拉取模型列表；已标注的图片能力、上下文和输出上限按模型 ID 保留。
  async fetchModels(userId: string, id: string) {
    const row = this.provider(id);
    let text = '', status = 0, failure: string | undefined;
    try {
      const response = await fetch(`${row.base_url}/models`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { authorization: `Bearer ${row.token}`, accept: 'application/json' } });
      status = response.status; text = await readCapped(response, LIST_BODY_BYTES);
    } catch (error) { failure = transportError(error); }
    if (!failure && (status < 200 || status >= 300)) failure = status >= 300 && status < 400 ? `HTTP ${status}：请求地址返回重定向，请填写最终地址` : upstreamError(status, text);
    requireCondition(!failure, 502, 'model_list_failed', redact(failure ?? '', row.token));
    let ids: string[] = []; const declared = new Map<string, ProviderModel>();
    try {
      const body = JSON.parse(text);
      const list: unknown[] = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : [];
      ids = list.map(m => typeof m === 'string' ? m : (m as { id?: unknown })?.id).filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256);
      for (const item of list) if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') declared.set((item as { id: string }).id, declaredCapabilities(item as Record<string, unknown>));
    } catch { ids = []; }
    requireCondition(ids.length, 502, 'model_list_empty', '供应商没有返回可识别的模型列表，可以手动添加模型 ID');
    return this.store.transaction(() => {
      const current = this.provider(id), known = new Map(this.models(current).map(m => [m.id, m]));
      // 已有条目保留用户在设置页的配置；新模型采用供应商声明的能力，缺的项用默认值补上。
      const merged = [...new Set(ids)].slice(0, 500).map(model => known.get(model) ?? { ...declared.get(model)!, id: model });
      // 手动添加、但供应商列表里没有的模型保留在末尾，避免一次拉取抹掉手工配置。
      for (const manual of known.values()) if (!ids.includes(manual.id)) merged.push(manual);
      const now = this.store.now();
      this.store.db.prepare('UPDATE model_providers SET models_json=?,models_fetched_at=?,updated_at=? WHERE id=?').run(JSON.stringify(merged), now, now, id);
      this.store.audit(userId, 'model_provider.models_fetched', id);
      this.resync(id);
      return { models: merged };
    });
  }
  setModels(userId: string, id: string, raw: unknown) {
    const { models } = modelsInput.parse(raw);
    requireCondition(new Set(models.map(m => m.id)).size === models.length, 400, 'model_duplicate', '模型 ID 重复');
    return this.store.transaction(() => {
      this.provider(id);
      this.store.db.prepare('UPDATE model_providers SET models_json=?,updated_at=? WHERE id=?').run(JSON.stringify(models), this.store.now(), id);
      this.store.audit(userId, 'model_provider.models_updated', id);
      this.resync(id);
      return { models };
    });
  }
  // 供应商或模型能力变化后，引用它的用途按新值生成新草稿（需重新测试并启用）；模型被移除时保留原草稿，等待改选。
  private resync(providerId: string) {
    const provider = this.provider(providerId);
    for (const row of this.store.db.prepare('SELECT * FROM model_settings WHERE provider_id=?').all(providerId) as unknown as Row[]) {
      const entry = this.models(provider).find(m => m.id === row.model);
      if (!entry) continue;
      const next = this.resolve(row.purpose, provider, entry);
      if (JSON.stringify(next) !== JSON.stringify(this.config(row))) this.write(row.purpose, providerId, next, row.generation + 1, 'web');
    }
  }
  private resolve(purpose: ModelPurpose, provider: ProviderRow, entry: ProviderModel): ModelConfig {
    // 两个用途都带上模型能力：供应商目录缺上下文等信息时，由这份配置补上。
    return { endpoint: provider.base_url, model: entry.id, token: provider.token, contextWindow: entry.contextWindow, maxOutput: entry.maxOutput, imageInput: entry.imageInput };
  }
  private write(purpose: ModelPurpose, providerId: string | null, config: ModelConfig, generation: number, source: string) {
    this.store.db.prepare(`INSERT INTO model_settings(purpose,provider_id,endpoint,model,token,context_window,max_output,image_input,generation,source,saved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(purpose) DO UPDATE SET provider_id=excluded.provider_id,endpoint=excluded.endpoint,model=excluded.model,token=excluded.token,context_window=excluded.context_window,max_output=excluded.max_output,image_input=excluded.image_input,generation=excluded.generation,source=excluded.source,saved_at=excluded.saved_at`)
      .run(purpose, providerId, config.endpoint, config.model, config.token, config.contextWindow ?? null, config.maxOutput ?? null, config.imageInput === undefined ? null : Number(config.imageInput), generation, source, this.store.now());
  }

  // ---------- 环境迁移 ----------
  // 某用途在库里还没有记录时，把环境配置导入为供应商和第 1 版已启用配置；之后以网页设置为准。
  seedFromEnvironment(purpose: ModelPurpose, config: ModelConfig | undefined) {
    if (!config || this.row(purpose)) return false;
    return this.store.transaction(() => {
      const now = this.store.now(), endpoint = config.endpoint.replace(/\/+$/, '');
      let provider = this.store.db.prepare('SELECT * FROM model_providers WHERE base_url=? AND token=?').get(endpoint, config.token) as unknown as ProviderRow | undefined;
      if (!provider) {
        const id = randomUUID();
        this.store.db.prepare('INSERT INTO model_providers(id,name,base_url,token,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, '环境变量导入', endpoint, config.token, now, now);
        provider = this.provider(id);
      }
      const models = this.models(provider);
      if (!models.some(m => m.id === config.model)) {
        models.push({ id: config.model, imageInput: !!config.imageInput, contextWindow: config.contextWindow ?? DEFAULT_CONTEXT_WINDOW, maxOutput: config.maxOutput ?? DEFAULT_MAX_OUTPUT });
        this.store.db.prepare('UPDATE model_providers SET models_json=?,updated_at=? WHERE id=?').run(JSON.stringify(models), now, provider.id);
      }
      const resolved = { ...config, endpoint };
      this.write(purpose, provider.id, resolved, 1, 'environment');
      this.store.db.prepare('UPDATE model_settings SET enabled_generation=1,enabled_json=?,enabled_at=? WHERE purpose=?').run(JSON.stringify({ ...resolved, source: 'environment' }), now, purpose);
      this.store.audit('system', 'model_settings.imported', purpose);
      return true;
    });
  }

  // ---------- 用途：选择、测试、启用 ----------
  enabled(purpose: ModelPurpose): { generation: number; source: 'settings' | 'environment'; config: ModelConfig } | undefined {
    const row = this.row(purpose);
    if (!row?.enabled_json) return undefined;
    const { source, ...config } = JSON.parse(row.enabled_json) as ModelConfig & { source?: string };
    return { generation: row.enabled_generation!, source: source === 'environment' ? 'environment' : 'settings', config };
  }

  view(purpose: ModelPurpose, running: RunningModel | undefined) {
    const row = this.row(purpose);
    const enabled = this.enabled(purpose)?.config;
    const providerName = row?.provider_id ? (this.store.db.prepare('SELECT name FROM model_providers WHERE id=?').get(row.provider_id) as { name: string } | undefined)?.name ?? null : null;
    const visible = (c: ModelConfig) => ({ endpoint: c.endpoint, model: c.model, ...(c.contextWindow !== undefined ? { contextWindow: c.contextWindow, maxOutput: c.maxOutput, imageInput: c.imageInput } : {}) });
    return {
      purpose,
      saved: row ? { ...visible(this.config(row)), providerId: row.provider_id, providerName, tokenConfigured: !!row.token, generation: row.generation, source: row.source, savedAt: row.saved_at } : null,
      test: row?.test_generation ? { generation: row.test_generation, ok: !!row.test_ok, at: row.test_at, message: row.test_message, latencyMs: row.test_latency_ms } : null,
      enabled: enabled && row ? { ...visible(enabled), generation: row.enabled_generation, enabledAt: row.enabled_at } : null,
      running: running ?? null,
      restartRequired: !!row?.enabled_generation && running?.generation !== row.enabled_generation,
    };
  }

  save(userId: string, purpose: ModelPurpose, raw: unknown) {
    const input = selectionInput.parse(raw);
    return this.store.transaction(() => {
      const provider = this.provider(input.providerId);
      const entry = this.models(provider).find(m => m.id === input.model);
      requireCondition(entry, 400, 'model_not_listed', '这个模型不在供应商的模型列表里，请先获取或手动添加');
      const generation = (this.row(purpose)?.generation ?? 0) + 1;
      this.write(purpose, provider.id, this.resolve(purpose, provider, entry!), generation, 'web');
      this.store.audit(userId, 'model_settings.saved', purpose);
      return { generation };
    });
  }

  // 用当前草稿发一次有界请求，验证地址、令牌和模型 ID；返回脱敏后的真实错误。
  async test(userId: string, purpose: ModelPurpose) {
    const row = this.row(purpose);
    requireCondition(row, 404, 'model_settings_missing', '还没有为这一用途选择模型');
    const started = Date.now();
    const attempt = async (limitField: 'max_tokens' | 'max_completion_tokens') => {
      // 与对话和现场 Agent 的实际调用一致，用流式请求；读到第一帧有效回答即结束，不等模型说完。
      const response = await fetch(`${row!.endpoint}/chat/completions`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { authorization: `Bearer ${row!.token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ model: row!.model, stream: true, messages: [{ role: 'user', content: 'Reply with OK.' }], [limitField]: 32 }),
      });
      const streaming = response.ok && (response.headers.get('content-type') ?? '').includes('text/event-stream');
      if (!streaming) return { status: response.status, text: await readCapped(response, TEST_BODY_BYTES), frame: undefined };
      const reader = response.body!.getReader(), decoder = new TextDecoder(); let pending = '', bytes = 0, frame: any;
      try {
        while (!frame) {
          const next = await reader.read(); if (next.done) break;
          bytes += next.value.length; if (bytes > TEST_BODY_BYTES) break;
          pending += decoder.decode(next.value, { stream: true });
          for (const line of pending.split('\n').slice(0, -1)) { const data = line.trim().replace(/^data:\s*/, ''); if (!line.trim().startsWith('data:') || data === '[DONE]') continue; try { const value = JSON.parse(data); if (Array.isArray(value?.choices) || value?.error) { frame = value; break; } } catch { /* 跨块的帧等下一块 */ } }
          pending = pending.slice(pending.lastIndexOf('\n') + 1);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      return { status: response.status, text: frame?.error ? JSON.stringify(frame) : '', frame };
    };
    let ok = false, message: string;
    try {
      let result = await attempt('max_tokens');
      // 部分推理模型只接受 max_completion_tokens；这是同一次测试里的参数改写，不是重试失败的请求。
      if (result.status === 400 && /max_completion_tokens/.test(result.text)) result = await attempt('max_completion_tokens');
      let body: any = result.frame; if (!body) { try { body = JSON.parse(result.text); } catch { body = undefined; } }
      if (result.status >= 200 && result.status < 300 && Array.isArray(body?.choices)) { ok = true; message = `模型 ${body.model ?? row.model} 已响应`; }
      else if (result.status >= 200 && result.status < 300 && body?.error) message = upstreamError(result.status, JSON.stringify(body));
      else if (result.status >= 200 && result.status < 300) message = '模型返回了空的流，没有收到回答';
      else if (result.status >= 300 && result.status < 400) message = `HTTP ${result.status}：请求地址返回重定向，请填写最终地址`;
      else message = upstreamError(result.status, result.text);
    } catch (error) { message = transportError(error); }
    message = redact(message, row.token);
    const latency = Date.now() - started;
    // 只有测试期间配置未被改动时才记录结果，避免旧测试结果挂到新配置上。
    const recorded = this.store.db.prepare('UPDATE model_settings SET test_generation=?,test_ok=?,test_at=?,test_message=?,test_latency_ms=? WHERE purpose=? AND generation=?')
      .run(row.generation, Number(ok), this.store.now(), message, latency, purpose, row.generation).changes === 1;
    this.store.audit(userId, ok ? 'model_settings.test_passed' : 'model_settings.test_failed', purpose);
    return { generation: row.generation, ok, message, latencyMs: latency, recorded };
  }

  // apply 在同一事务里先替换运行中的模型通道；它抛错时不写入启用记录，原启用配置保持不变。
  enable(userId: string, purpose: ModelPurpose, raw: unknown, apply?: (purpose: ModelPurpose, config: ModelConfig, generation: number) => void) {
    const { generation } = enableSchema.parse(raw);
    return this.store.transaction(() => {
      const row = this.row(purpose);
      requireCondition(row, 404, 'model_settings_missing', '还没有为这一用途选择模型');
      requireCondition(row!.generation === generation, 409, 'model_settings_changed', '配置已被修改，请刷新后重新测试');
      requireCondition(row!.test_generation === generation && row!.test_ok === 1, 409, 'model_test_required', '这份配置还没有通过连接测试');
      apply?.(purpose, this.config(row!), generation);
      const now = this.store.now();
      this.store.db.prepare('UPDATE model_settings SET enabled_generation=?,enabled_json=?,enabled_at=? WHERE purpose=?').run(generation, JSON.stringify({ ...this.config(row!), source: 'web' }), now, purpose);
      this.store.audit(userId, 'model_settings.enabled', purpose);
      return { generation, enabledAt: now };
    });
  }
}
