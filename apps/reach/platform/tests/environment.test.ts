// Copyright (c) Ray Zhang. 对话环境目录选择：新对话按用户共享，旧对话保留独立目录，选择一经写下不再改变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chooseEnvironment, sharedEnvironment } from '../src/environment.ts';

const root = () => { const dir = resolve('work/desk-environment-' + randomUUID()); mkdirSync(dir, { recursive: true }); return dir; };

test('new conversations use the per-user shared environment and the choice sticks', () => {
  const state = root(), shared = sharedEnvironment(state, 'alice'), conversation = join(state, 'sessions', 'c1');
  assert.equal(chooseEnvironment(conversation, shared), shared);
  // 第一次运行后对话目录里有了 session.json，选择仍然是共享目录。
  writeFileSync(join(conversation, 'session.json'), '{}');
  assert.equal(chooseEnvironment(conversation, shared), shared);
  assert.equal(readFileSync(join(conversation, 'environment-path.txt'), 'utf8').trim(), shared);
  assert.notEqual(sharedEnvironment(state, 'alice'), sharedEnvironment(state, 'bob'), 'users do not share');
});

test('conversations that already ran keep their own environment', () => {
  const state = root(), shared = sharedEnvironment(state, 'alice');
  const ranBefore = join(state, 'sessions', 'old');mkdirSync(ranBefore, { recursive: true });writeFileSync(join(ranBefore, 'session.json'), '{}');
  assert.equal(chooseEnvironment(ranBefore, shared), join(ranBefore, 'environment'));
  const withLibrary = join(state, 'sessions', 'lib');mkdirSync(join(withLibrary, 'environment'), { recursive: true });
  assert.equal(chooseEnvironment(withLibrary, shared), join(withLibrary, 'environment'));
});
