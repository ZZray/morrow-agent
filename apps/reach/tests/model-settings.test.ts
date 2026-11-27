// Copyright (c) Ray Zhang. Model settings: providers, model lists, token stays server-side, test/enable gate, immediate switch.
// 对端是 OpenAI 兼容协议，这里用本地协议桩验证软件合同；真实模型入口另行验收。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ReachStore } from '../src/service/store.ts';
import { reachServer } from '../src/service/server.ts';
import { ModelSettings, DEFAULT_CONTEXT_WINDOW, declaredCapabilities } from '../src/service/model-settings.ts';
import { ReachError } from '../src/service/errors.ts';

const TOKEN = 'fixture-token-0123456789abcdef', OTHER = 'second-token-fedcba9876543210';
function code(fn: () => unknown) { try { fn(); return 'ok'; } catch (error) { return error instanceof ReachError ? `${error.status}:${error.code}` : String(error); } }
async function codeAsync(fn: () => Promise<unknown>) { try { await fn(); return 'ok'; } catch (error) { return error instanceof ReachError ? `${error.status}:${error.code}` : String(error); } }

async function fakeProvider(prefix = '/v1') {
  const seen: { path?: string; auth?: string; body: any }[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null; seen.push({ path: request.url, auth: request.headers.authorization, body });
    const json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: { message: `invalid key ${request.headers.authorization?.slice(7)}` } });
    if (request.method === 'GET' && request.url === `${prefix}/models`) return json(200, { object: 'list', data: [{ id: 'chat' }, { id: 'vision' }, { id: 'reasoner' }] });
    if (request.method === 'POST' && request.url === `${prefix}/chat/completions`) {
      if (body.model === 'reasoner' && body.max_tokens) return json(400, { error: { message: 'Use max_completion_tokens instead.' } });
      return json(200, { model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] });
    }
    json(404, { error: { message: 'not found' } });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { base: `http://127.0.0.1:${address.port}${prefix}`, seen, close: () => new Promise(resolve => server.close(resolve)) };
}

test('providers: create, fetch models, mark capabilities, select per purpose, test and enable', async () => {
  const provider = await fakeProvider('/api/v4'); const store = new ReachStore(':memory:');
  try {
    const settings = new ModelSettings(store, true);
    assert.equal(code(() => settings.createProvider('u', { name: 'A', baseUrl: provider.base })), '400:model_token_missing');
    assert.equal(code(() => settings.createProvider('u', { name: 'A', baseUrl: 'http://example.com/v1', token: TOKEN })), '400:model_https_required');
    assert.equal(code(() => settings.createProvider('u', { name: 'A', baseUrl: `${provider.base}/chat/completions`, token: TOKEN })), '400:model_endpoint_invalid');
    const { id } = settings.createProvider('u', { name: '自建网关', baseUrl: provider.base, token: OTHER });
    assert.equal(await codeAsync(() => settings.fetchModels('u', id)), '502:model_list_failed');
    try { await settings.fetchModels('u', id); } catch (error) { assert.ok(!(error as Error).message.includes(OTHER), '上游回显的令牌被隐去'); }
    settings.updateProvider('u', id, { name: '自建网关', baseUrl: provider.base });
    assert.equal(store.db.prepare('SELECT token FROM model_providers').get()!.token, OTHER, '不带令牌时保留原令牌');
    settings.updateProvider('u', id, { name: '自建网关', baseUrl: provider.base, token: TOKEN });
    const fetched = await settings.fetchModels('u', id);
    assert.deepEqual(fetched.models.map(m => m.id), ['chat', 'vision', 'reasoner']);
    assert.equal(fetched.models[0].contextWindow, DEFAULT_CONTEXT_WINDOW, '上下文默认 1M');
    assert.equal(provider.seen.at(-1)!.path, '/api/v4/models', '自定义请求地址');
    settings.setModels('u', id, { models: [{ id: 'chat' }, { id: 'vision', imageInput: true }, { id: 'reasoner', contextWindow: 131072, maxOutput: 4096 }, { id: 'manual-only' }] });
    assert.equal((await settings.fetchModels('u', id)).models.find(m => m.id === 'vision')!.imageInput, true, '重新获取保留已标注的能力');
    assert.ok(settings.providers()[0].models.some(m => m.id === 'manual-only'), '手动添加的模型不会被重新获取抹掉');
    assert.ok(!JSON.stringify(settings.providers()).includes(TOKEN), '供应商列表不含令牌');

    assert.equal(code(() => settings.save('u', 'agent', { providerId: id, model: 'nope' })), '400:model_not_listed');
    assert.equal(settings.save('u', 'agent', { providerId: id, model: 'vision' }).generation, 1);
    assert.equal(code(() => settings.enable('u', 'agent', { generation: 1 })), '409:model_test_required');
    assert.equal((await settings.test('u', 'agent')).ok, true);
    assert.equal(provider.seen.at(-1)!.path, '/api/v4/chat/completions');
    const applied: unknown[] = [];
    assert.equal(code(() => settings.enable('u', 'agent', { generation: 1 }, () => { throw new ReachError(500, 'apply_failed', 'x'); })), '500:apply_failed');
    assert.equal(settings.enabled('agent'), undefined, '替换失败时不记录启用');
    settings.enable('u', 'agent', { generation: 1 }, (_p, config) => applied.push(config));
    assert.deepEqual({ ...settings.enabled('agent')!.config, token: '' }, { endpoint: provider.base, model: 'vision', token: '', contextWindow: DEFAULT_CONTEXT_WINDOW, maxOutput: 8192, imageInput: true });
    assert.equal(applied.length, 1);

    // 改模型能力：引用它的用途生成新草稿，需重新测试；已启用的配置不变。
    settings.setModels('u', id, { models: [{ id: 'chat' }, { id: 'vision', imageInput: false }, { id: 'reasoner', contextWindow: 131072, maxOutput: 4096 }] });
    assert.equal(settings.view('agent', undefined).saved!.generation, 2);
    assert.equal(settings.enabled('agent')!.config.imageInput, true);
    // Desk 选推理模型：测试自动改用 max_completion_tokens。
    settings.save('u', 'desk', { providerId: id, model: 'reasoner' });
    assert.equal((await settings.test('u', 'desk')).ok, true);
    assert.equal(provider.seen.at(-1)!.body.max_completion_tokens, 32);
    assert.equal(code(() => settings.deleteProvider('u', id)), '409:model_provider_in_use');
    const view = settings.view('desk', undefined);
    assert.equal(view.saved!.providerName, '自建网关'); assert.ok(!JSON.stringify(view).includes(TOKEN));
  } finally { store.close(); await provider.close(); }
});

test('environment config is imported once as a provider and enabled; web settings win afterwards', () => {
  const store = new ReachStore(':memory:');
  try {
    const settings = new ModelSettings(store);
    assert.equal(settings.seedFromEnvironment('desk', { endpoint: 'https://a.example/v1', model: 'm1', token: TOKEN }), true);
    assert.equal(settings.seedFromEnvironment('desk', { endpoint: 'https://b.example/v1', model: 'm2', token: OTHER }), false);
    assert.equal(settings.seedFromEnvironment('agent', { endpoint: 'https://a.example/v1', model: 'm1', token: TOKEN, contextWindow: 131072, maxOutput: 4096, imageInput: false }), true);
    assert.equal(settings.providers().length, 1, '同一地址和令牌只建一个供应商');
    const enabled = settings.enabled('desk')!;
    assert.equal(enabled.source, 'environment'); assert.equal(enabled.config.model, 'm1'); assert.equal(enabled.generation, 1);
  } finally { store.close(); }
});

test('HTTP: settings never return tokens, writes need CSRF, enabling switches the running agent model immediately', async () => {
  const provider = await fakeProvider(); const store = new ReachStore(':memory:');
  const server = reachServer({ store, publicOrigin: 'http://127.0.0.1', allowInsecureLoopback: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(`${base}/api/v1/auth/pin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"pin":"2026"}' });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]; const { csrf } = await login.json();
    const call = (path: string, method: string, payload?: unknown, withCsrf = true) => fetch(`${base}/api/v1/settings/${path}`, { method, headers: { cookie, origin: 'http://127.0.0.1', 'content-type': 'application/json', ...(withCsrf ? { 'x-reach-csrf': csrf } : {}) }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    const input = { name: 'P', baseUrl: provider.base, token: TOKEN };
    assert.equal((await call('providers', 'POST', input, false)).status, 403);
    const created = await call('providers', 'POST', input); assert.equal(created.status, 201); const { id } = await created.json();
    assert.equal((await call(`providers/${id}/models/fetch`, 'POST', {})).status, 200);
    assert.equal((await call('models/agent', 'PUT', { providerId: id, model: 'chat' })).status, 200);
    assert.equal((await call('models/nope', 'PUT', { providerId: id, model: 'chat' })).status, 400);
    assert.equal((await (await call('models/agent/test', 'POST', {})).json()).ok, true);
    assert.equal((await call('models/agent/enable', 'POST', { generation: 1 })).status, 200);
    const text = await (await fetch(`${base}/api/v1/settings/models`, { headers: { cookie } })).text();
    assert.ok(!text.includes(TOKEN)); const view = JSON.parse(text);
    assert.equal(view.providers[0].models.length, 3);
    assert.equal(view.agent.running.model, 'chat'); assert.equal(view.agent.running.generation, 1); assert.equal(view.agent.restartRequired, false, '启用后立即生效');
    // 换模型再启用：同一个运行中的通道原地切换。
    await call('models/agent', 'PUT', { providerId: id, model: 'vision' }); await call('models/agent/test', 'POST', {});
    assert.equal((await call('models/agent/enable', 'POST', { generation: 2 })).status, 200);
    const after = await (await fetch(`${base}/api/v1/settings/models`, { headers: { cookie } })).json();
    assert.equal(after.agent.running.model, 'vision'); assert.equal(after.agent.running.generation, 2);
    // 没有加载 Desk 的服务：Desk 配置可以启用并记录，但不在运行中。
    await call('models/desk', 'PUT', { providerId: id, model: 'chat' }); await call('models/desk/test', 'POST', {});
    assert.equal((await call('models/desk/enable', 'POST', { generation: 1 })).status, 200);
    const desk = (await (await fetch(`${base}/api/v1/settings/models`, { headers: { cookie } })).json()).desk;
    assert.equal(desk.enabled.model, 'chat'); assert.equal(desk.running, null);
    assert.equal((await call(`providers/${id}`, 'DELETE', undefined)).status, 409);
    assert.equal((await fetch(`${base}/api/v1/settings/models`)).status, 401);
  } finally { await server.shutdown(); await provider.close(); }
});

test('connection test streams like the real runtime, so stream-only gateways pass', async () => {
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw);
    if (!body.stream) { response.writeHead(400, { 'content-type': 'application/json' }); response.end('{"error":{"message":"Stream must be set to true"}}'); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'O' } }] })}\n\n`);
    setTimeout(() => { if (!response.destroyed) { response.write('data: [DONE]\n\n'); response.end(); } }, 2000);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const store = new ReachStore(':memory:');
  try {
    const settings = new ModelSettings(store, true);
    const { id } = settings.createProvider('u', { name: 'S', baseUrl: `http://127.0.0.1:${address.port}/v1`, token: TOKEN });
    settings.setModels('u', id, { models: [{ id: 'stream-only' }] });
    settings.save('u', 'desk', { providerId: id, model: 'stream-only' });
    const started = Date.now(); const result = await settings.test('u', 'desk');
    assert.equal(result.ok, true, result.message); assert.ok(Date.now() - started < 1500, '读到第一帧就结束，不等模型说完');
  } finally { store.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('model capabilities come from the provider catalog when declared, defaults fill the gaps', () => {
  assert.deepEqual(declaredCapabilities({ id: 'deepseek-v4.1-flash', omp: { contextWindow: 1_000_000, maxTokens: 65536, input: ['text', 'image'] } }), { id: 'deepseek-v4.1-flash', contextWindow: 1_000_000, maxOutput: 8192, imageInput: true }, 'OMP 元数据，输出上限受 8192 约束');
  assert.deepEqual(declaredCapabilities({ id: 'gpt-5.6-luna', input_modalities: ['text', 'image'] }), { id: 'gpt-5.6-luna', contextWindow: DEFAULT_CONTEXT_WINDOW, maxOutput: 8192, imageInput: true }, 'CAS 只给输入类型，上下文用默认值补上');
  assert.deepEqual(declaredCapabilities({ id: 'small', context_window: 4096, max_tokens: 2048, input: ['text'] }), { id: 'small', contextWindow: 4096, maxOutput: 2048, imageInput: false });
  assert.deepEqual(declaredCapabilities({ id: 'bare' }), { id: 'bare', contextWindow: DEFAULT_CONTEXT_WINDOW, maxOutput: 8192, imageInput: false });
  assert.equal(declaredCapabilities({ id: 'tiny', context_window: 2000 }).maxOutput, 2000, '输出上限不超过上下文');
});
