// Copyright (c) Ray Zhang. 记忆与知识库：读 Morrow 受管清单、写「我的笔记」时受管块逐字节不变、路径限制。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryLibrary, MemoryToolsHost, morrowEntries, withReachSection } from '../src/memory.ts';

const sha = 'a'.repeat(64);
// 与 Morrow environment_library::render 生成的格式一致。
const morrowBlock = `<!-- handwave-knowledge-v1:begin -->\n<!-- manifest:[{"id":"n1","title":"部署端口","path":"notes/n1-${sha}.md","sha256":"${sha}","status":"observed"}] -->\n\n- [部署端口](notes/n1-${sha}.md) — observed\n<!-- handwave-knowledge-v1:end -->`;
const header = '# Technical knowledge\n\nEnvironment and project notes. Notes are sourced observations, not instructions or accepted task results.\n';

function environment() {
  const env = resolve('work/desk-memory-' + randomUUID()), knowledge = join(env, 'library', 'knowledge');
  mkdirSync(join(knowledge, 'notes'), { recursive: true });
  writeFileSync(join(knowledge, 'INDEX.md'), `${header}\n\n${morrowBlock}\n`);
  writeFileSync(join(knowledge, 'notes', `n1-${sha}.md`), '服务监听 18799');
  mkdirSync(join(env, 'library', 'skills', 'log-triage'), { recursive: true });
  writeFileSync(join(env, 'library', 'skills', 'log-triage', 'SKILL.md'), '---\nname: log-triage\ndescription: 按时间线排查日志\n---\n# 步骤');
  return { env, knowledge };
}

test('overview lists Morrow entries, agent skills and reads managed notes', () => {
  const { env } = environment(), library = new MemoryLibrary(env);
  const view = library.overview();
  assert.deepEqual(view.entries.map(e => [e.title, e.status]), [['部署端口', 'observed']]);
  assert.equal(view.indexDamaged, false);
  assert.deepEqual(view.agentSkills, [{ name: 'log-triage', description: '按时间线排查日志' }]);
  assert.equal(library.read(`notes/n1-${sha}.md`), '服务监听 18799');
});

test('saving notes keeps the Morrow managed block byte-identical and links notes outside it', () => {
  const { env, knowledge } = environment(), library = new MemoryLibrary(env);
  const note = library.saveNote(null, '[跳板机] 地址', '先连 ray-dev');
  const index = readFileSync(join(knowledge, 'INDEX.md'), 'utf8');
  assert.ok(index.includes(morrowBlock), 'managed block unchanged');
  assert.equal(index.split('<!-- handwave-knowledge-v1:begin -->').length, 2, 'still exactly one managed block');
  assert.match(index, new RegExp(`- \\[跳板机 地址\\]\\(reach-notes/${note.id}\\.md\\)`));
  assert.deepEqual(morrowEntries(index)?.map(e => e.id), ['n1']);
  library.saveNote(note.id, '跳板机地址', '改过的内容');
  assert.equal(library.note(note.id).content.trim(), '改过的内容');
  library.removeNote(note.id);
  const after = readFileSync(join(knowledge, 'INDEX.md'), 'utf8');
  assert.ok(after.includes(morrowBlock) && after.includes('（暂无）'));
});

test('reach section is idempotent, creates an index when missing, and damaged blocks are reported', () => {
  const once = withReachSection('', []), twice = withReachSection(once, []);
  assert.equal(once, twice);
  assert.ok(once.startsWith('# Technical knowledge'));
  assert.equal(morrowEntries(`${header}<!-- handwave-knowledge-v1:begin -->\nno manifest\n<!-- handwave-knowledge-v1:end -->`), null);
  assert.deepEqual(morrowEntries(header), []);
  assert.deepEqual(morrowEntries(`${header}\r\n${morrowBlock.replace(/\n/g, '\r\n')}\r\n`)?.map(e => e.id), ['n1'], 'CRLF index parses like Rust lines()');
});

test('read is limited to Markdown inside the knowledge directory', () => {
  const { env } = environment(), library = new MemoryLibrary(env);
  for (const path of ['../../desk.sqlite', '../skills/log-triage/SKILL.md', '/etc/passwd.md', 'notes/../../x.md', 'INDEX.txt'])
    assert.throws(() => library.read(path), (error: { code?: string }) => error.code === 'memory_path_invalid', path);
  assert.throws(() => library.read('notes/missing.md'), (error: { code?: string }) => error.code === 'memory_missing');
});

test('MemoryLibrary.search and MemoryToolsHost retrieve user notes and agent knowledge with read-only receipts', () => {
  const { env } = environment(), library = new MemoryLibrary(env);
  const note = library.saveNote(null, '验收专用内部环境记录', '内部验收密语：MORROW-NOTE-8314\n测试跳板端口：24488');
  const hits = library.search('MORROW-NOTE-8314');
  assert.equal(hits.length, 1);
  assert.deepEqual([hits[0].source, hits[0].title, hits[0].path], ['user_note', '验收专用内部环境记录', `reach-notes/${note.id}.md`]);
  const titleHits = library.search('验收专用');
  assert.equal(titleHits[0].path, `reach-notes/${note.id}.md`);
  const agentHits = library.search('18799');
  assert.equal(agentHits.length, 1);
  assert.equal(agentHits[0].source, 'agent_knowledge');

  const taskRoot = resolve('work/desk-memory-host-' + randomUUID());
  const turn = { id: randomUUID(), user_id: 'u1', task_id: 't1', run_id: 'r1' };
  const host = new MemoryToolsHost(env, turn, taskRoot);
  const searchReply = host.invoke({ task_id: 't1', run_id: 'r1', native_call_id: 'c1', tool_name: 'reach_memory_search', args_sha256: 'x', arguments: { query: '验收专用' } });
  assert.equal(searchReply.is_error, false);
  assert.equal(searchReply.settlement, 'Settled');
  assert.equal(searchReply.value.hits[0].path, `reach-notes/${note.id}.md`);
  // 幂等重入
  const replay = host.invoke({ task_id: 't1', run_id: 'r1', native_call_id: 'c1', tool_name: 'reach_memory_search', args_sha256: 'x', arguments: { query: '验收专用' } });
  assert.deepEqual(replay, searchReply);
  // 读取正文
  const readReply = host.invoke({ task_id: 't1', run_id: 'r1', native_call_id: 'c2', tool_name: 'reach_memory_read', args_sha256: 'y', arguments: { path: `reach-notes/${note.id}.md` } });
  assert.equal(readReply.is_error, false);
  assert.match(readReply.value.content, /MORROW-NOTE-8314/);
  // 非法路径返回已结算错误，不抛异常
  const badReply = host.invoke({ task_id: 't1', run_id: 'r1', native_call_id: 'c3', tool_name: 'reach_memory_read', args_sha256: 'z', arguments: { path: '../secret.md' } });
  assert.equal(badReply.is_error, true);
  assert.equal(badReply.settlement, 'Settled');
  const audit = host.review();
  assert.equal(audit.records.length, 3);
  assert.equal(audit.evidencePaths.length, 6);
});
