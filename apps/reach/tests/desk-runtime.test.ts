// Copyright (c) Ray Zhang. Reach ships with cloud conversation: sidecar discovery, env import and default state directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { prepareDesk, locateSidecar, SIDECAR_NAME } from '../src/service/desk-runtime.ts';

const TOKEN = 'desk-runtime-fixture-token-0123';

test('sidecar comes from REACH_DESK_SIDECAR or PATH, and missing pieces are reported plainly', () => {
  const root = mkdtempSync(join(tmpdir(), 'reach-desk-runtime-'));
  try {
    const binary = join(root, process.platform === 'win32' ? `${SIDECAR_NAME}.exe` : SIDECAR_NAME); writeFileSync(binary, '');
    assert.deepEqual(locateSidecar({ REACH_DESK_SIDECAR: binary }), { path: binary });
    assert.match((locateSidecar({ REACH_DESK_SIDECAR: 'relative/sidecar' }) as { unavailable: string }).unavailable, /绝对路径/);
    assert.match((locateSidecar({ REACH_DESK_SIDECAR: join(root, 'missing') }) as { unavailable: string }).unavailable, /不存在/);
    assert.deepEqual(locateSidecar({ PATH: ['relative', join(root, 'nope'), root].join(delimiter) }), { path: binary });
    assert.match((locateSidecar({ PATH: join(root, 'nope') }) as { unavailable: string }).unavailable, new RegExp(SIDECAR_NAME));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('environment model is imported once, the token is removed, and partial settings are rejected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reach-desk-runtime-'));
  try {
    const missing = { REACH_DESK_ENDPOINT: 'https://m.example/v1', REACH_DESK_MODEL: 'm', REACH_DESK_MODEL_TOKEN: TOKEN, PATH: '' } as NodeJS.ProcessEnv;
    const result = await prepareDesk(missing, root);
    assert.equal(result.composition, undefined); assert.match(result.unavailable!, /找不到对话运行组件/);
    assert.equal('REACH_DESK_MODEL_TOKEN' in missing, false, '找不到运行组件时也移除令牌');
    await assert.rejects(prepareDesk({ REACH_DESK_ENDPOINT: 'https://m.example/v1' }, root), /must be set together/);

    const binary = join(root, 'sidecar.bin'); writeFileSync(binary, '');
    const env = { REACH_DESK_SIDECAR: binary, REACH_DESK_ENDPOINT: 'https://m.example/v1', REACH_DESK_MODEL: 'm', REACH_DESK_MODEL_TOKEN: TOKEN } as NodeJS.ProcessEnv;
    const ready = await prepareDesk(env, join(root, 'data'));
    assert.equal(ready.unavailable, undefined);
    assert.deepEqual(ready.composition!.environment, { endpoint: 'https://m.example/v1', model: 'm', token: TOKEN });
    assert.equal(existsSync(join(root, 'data', 'desk')), false, '只有真正创建对话运行时才建状态目录');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('creating the runtime makes the default state directory under the data directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reach-desk-runtime-'));
  try {
    const binary = join(root, 'sidecar.bin'); writeFileSync(binary, '');
    const { composition } = await prepareDesk({ REACH_DESK_SIDECAR: binary }, join(root, 'data'));
    const desk = composition!.create({ endpoint: 'https://m.example/v1', model: 'm', token: TOKEN });
    try { assert.equal(existsSync(join(root, 'data', 'desk', 'desk.sqlite')), true); }
    finally { await desk.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a release without the Desk code still starts and says what is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reach-desk-runtime-'));
  try {
    const binary = join(root, 'sidecar.bin'); writeFileSync(binary, '');
    const result = await prepareDesk({ REACH_DESK_SIDECAR: binary }, root, async () => { throw new Error("Cannot find module '../../platform/src/host.ts'"); });
    assert.equal(result.composition, undefined); assert.match(result.unavailable!, /发行包缺少对话运行时代码/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loopback model endpoints declare the configured capabilities; HTTPS endpoints keep catalog resolution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reach-desk-runtime-'));
  try {
    const binary = join(root, 'sidecar.bin'); writeFileSync(binary, '');
    const { composition } = await prepareDesk({ REACH_DESK_SIDECAR: binary, REACH_MODEL_LOOPBACK: '1' }, join(root, 'data'));
    const desk = composition!.create({ endpoint: 'http://127.0.0.1:18799/v1', model: 'deepseek-v4.1-flash', token: TOKEN, contextWindow: 1_000_000, maxOutput: 8192, imageInput: true }) as unknown as { route: any; reconfigure(m: unknown): void; close(): Promise<void> };
    try {
      assert.deepEqual(desk.route.modelResolution, { kind: 'host_declared_loopback', capabilities: { context_window: 1_000_000, max_tokens: 8192, input: ['text', 'image'] } }, '本机网关按设置声明上下文与图片能力');
      desk.reconfigure({ endpoint: 'https://cas.example/v1', model: 'gpt-5.6-luna', token: TOKEN, capabilities: { contextWindow: 1_000_000, maxTokens: 8192, imageInput: false } });
      assert.deepEqual(desk.route.modelResolution, { kind: 'catalog' }, '外部 HTTPS 端点仍读供应商目录，开启本机开关不排斥 HTTPS');
      assert.throws(() => desk.reconfigure({ endpoint: 'http://127.0.0.1:18799/v1', model: 'm', token: TOKEN, capabilities: { contextWindow: 512, maxTokens: 8192, imageInput: false } }), /模型能力声明无效/);
      assert.throws(() => desk.reconfigure({ endpoint: 'http://10.0.0.5/v1', model: 'm', token: TOKEN }), /HTTPS|loopback/);
    } finally { await desk.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
