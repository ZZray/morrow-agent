// Copyright (c) Ray Zhang. 续写建议：只取最近三轮、清理模型输出，「无」或多行过长一律当作没有建议。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSuggestion, suggestionMessages, SUGGESTION_MAX } from '../src/suggestion.ts';

test('cleanSuggestion keeps one short line and strips quotes', () => {
  assert.equal(cleanSuggestion('“帮我把重试次数改成 3”'), '帮我把重试次数改成 3');
  assert.equal(cleanSuggestion('看看上游日志\n第二行解释'), '看看上游日志');
  assert.equal(cleanSuggestion('无'), null);
  assert.equal(cleanSuggestion('无。'), null);
  assert.equal(cleanSuggestion('   '), null);
  assert.equal(cleanSuggestion('x'.repeat(SUGGESTION_MAX + 1)), null);
  assert.equal(cleanSuggestion(42), null);
});

test('suggestionMessages uses only the last three turns and clips long text', () => {
  const turns = Array.from({ length: 5 }, (_, i) => ({ content: `问题${i}`, output: i === 4 ? 'y'.repeat(3000) : `回答${i}` }));
  const [system, user] = suggestionMessages(turns);
  assert.equal(system.role, 'system');
  assert.ok(!user.content.includes('问题0') && !user.content.includes('问题1') && user.content.includes('问题2') && user.content.includes('问题4'));
  assert.ok(user.content.length < 3000);
});
