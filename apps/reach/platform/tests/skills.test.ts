// Copyright (c) Ray Zhang. 对话技能库：校验与上限、按用户隔离、按条消息解析快照、提示格式与 HandWave 同口径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SkillStore, skillPrompt, parseSkillDraft, MAX_SKILL_CONTENT, MAX_SELECTED_SKILLS } from '../src/skills.ts';

function store() { const root = resolve('work/desk-skills-' + randomUUID()); mkdirSync(root, { recursive: true }); return new SkillStore(root); }
const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (error) { return (error as { code?: string }).code ?? String(error); } };

test('create, update, list and delete are scoped per user and trim input', () => {
  const skills = store();
  const created = skills.create('alice', { name: '  代码审查  ', description: '按团队规范审查', content: '# 步骤\n1. 先读 diff' });
  assert.match(created.id, /^[0-9a-f]{32}$/);
  assert.equal(created.name, '代码审查');
  assert.deepEqual(skills.list('alice').map(s => s.name), ['代码审查']);
  assert.deepEqual(skills.list('bob'), []);
  assert.equal(code(() => skills.get('bob', created.id)), 'skill_missing');
  const updated = skills.update('alice', created.id, { name: '代码审查 v2', description: '', content: '新内容' });
  assert.equal(skills.get('alice', created.id).content, '新内容');
  assert.equal(updated.name, '代码审查 v2');
  skills.remove('alice', created.id);
  assert.deepEqual(skills.list('alice'), []);
  assert.equal(code(() => skills.remove('alice', created.id)), 'skill_missing');
  assert.equal(code(() => skills.get('alice', '../../etc/passwd')), 'skill_missing');
});

test('validation rejects empty and oversized skills without writing temp files', () => {
  const skills = store();
  assert.equal(code(() => skills.create('u', { name: ' ', description: '', content: 'x' })), 'skill_invalid');
  assert.equal(code(() => skills.create('u', { name: 'n', description: '', content: '  ' })), 'skill_invalid');
  assert.equal(code(() => skills.create('u', { name: 'n', description: '', content: 'x'.repeat(MAX_SKILL_CONTENT + 1) })), 'skill_too_large');
  skills.create('u', { name: 'ok', description: '', content: 'x' });
  const dir = join(skills.root, readdirSync(skills.root)[0]);
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
});

test('resolve enforces count, uniqueness, existence and snapshots content', () => {
  const skills = store();
  const ids = Array.from({ length: MAX_SELECTED_SKILLS + 1 }, (_, i) => skills.create('u', { name: 's' + i, description: '', content: 'c' + i }).id);
  assert.equal(skills.resolve('u', ids.slice(0, 2)).map(s => s.content).join(','), 'c0,c1');
  assert.equal(code(() => skills.resolve('u', ids)), 'skill_selection_invalid');
  assert.equal(code(() => skills.resolve('u', [ids[0], ids[0]])), 'skill_selection_invalid');
  assert.equal(code(() => skills.resolve('u', ['f'.repeat(32)])), 'skill_missing');
  const snapshot = skills.resolve('u', [ids[0]]);
  skills.update('u', ids[0], { name: 's0', description: '', content: '改过' });
  assert.equal(snapshot[0].content, 'c0', 'snapshot is a copy');
});

test('skill prompt matches the HandWave heading and is empty without skills', () => {
  assert.equal(skillPrompt([]), '');
  const text = skillPrompt([{ id: 'a'.repeat(32), name: '审查', description: '说明', content: '内容', updatedAt: 0 }]);
  assert.match(text, /## 用户为本条消息明确选择的技能/);
  assert.match(text, /### 技能 审查（a{32}）\n说明\n\n内容/);
});

test('parseSkillDraft parses plain or fenced JSON, clamps lengths and rejects invalid drafts', () => {
  assert.deepEqual(
    parseSkillDraft('```json\n{"name":"  事故复盘 ","description":" 排查步骤 ","content":"# 目标\\n先核对证据"}\n```'),
    { name: '事故复盘', description: '排查步骤', content: '# 目标\n先核对证据' },
  );
  assert.equal(parseSkillDraft('{"name":"","content":"x"}'), null);
  assert.equal(parseSkillDraft('not json'), null);
  const clamped = parseSkillDraft(JSON.stringify({ name: 'a'.repeat(200), description: 'b'.repeat(2000), content: 'c'.repeat(MAX_SKILL_CONTENT + 100) }));
  assert.ok(clamped);
  assert.equal(clamped!.name.length, 128);
  assert.equal(clamped!.description.length, 1024);
  assert.ok(Buffer.byteLength(clamped!.content, 'utf8') <= MAX_SKILL_CONTENT);
});
