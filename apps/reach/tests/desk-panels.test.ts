// Copyright (c) Ray Zhang. 对话页补齐项的纯逻辑：忙时排队与工具步骤合并。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, moveFirst, removeItem, QUEUE_LIMIT } from '../src/admin/desk-queue.ts';
import { applyStepEvent, stepTone } from '../src/admin/desk-steps.ts';

test('queue keeps order, trims text, copies the target, caps length and moves an item to the front', () => {
  const target = { nodeId: 'n1', epoch: 2, cwd: '/srv', name: 'NUC' };
  let items = enqueue([], '  第一条  ', null, 'a');
  items = enqueue(items, '第二条', target, 'b');
  items = enqueue(items, '   ', null, 'blank');
  assert.deepEqual(items.map(item => [item.id, item.content]), [['a', '第一条'], ['b', '第二条']]);
  target.cwd = '/changed';
  assert.equal(items[1].target?.cwd, '/srv', 'queued target is a snapshot');
  assert.deepEqual(moveFirst(items, 'b').map(item => item.id), ['b', 'a']);
  assert.deepEqual(moveFirst(items, 'missing'), items);
  assert.deepEqual(removeItem(items, 'a').map(item => item.id), ['b']);
  let full: typeof items = [];
  for (let i = 0; i < QUEUE_LIMIT + 3; i++) full = enqueue(full, 'm' + i, null, 'id' + i);
  assert.equal(full.length, QUEUE_LIMIT);
  assert.equal(enqueue(full, 'over', null), full, 'full queue returns the same list so callers can tell');
});

test('tool steps merge by id, keep start detail after end, and classify status', () => {
  let steps = applyStepEvent(undefined, 'tool_start', { stepId: 's', title: '读取', status: 'running', detail: '{"path":"a"}' });
  assert.equal(stepTone(steps[0]), 'run');
  steps = applyStepEvent(steps, 'tool_end', { stepId: 's', title: '读取', status: 'ok', output: '内容' });
  assert.deepEqual([steps.length, steps[0].detail, steps[0].output, stepTone(steps[0])], [1, '{"path":"a"}', '内容', 'ok']);
  steps = applyStepEvent(steps, 'tool_end', { stepId: 'x', title: '写入', status: 'error', output: '' });
  assert.equal(stepTone(steps[1]), 'bad');
  steps = applyStepEvent(steps, 'tool_end', { stepId: 'y', title: '写入', status: 'error', effectsUnknown: true });
  assert.equal(stepTone(steps[2]), 'warn');
  assert.equal(applyStepEvent(steps, 'delta', { stepId: 'z' }), steps);
  assert.equal(applyStepEvent(steps, 'tool_start', { title: '缺 id' }), steps);
});

test('skill picker helpers: slash trigger, filtering and the selection cap', async () => {
  const { slashQuery, filterSkills, toggleSelection, MAX_SELECTED } = await import('../src/admin/desk-skills.ts');
  assert.equal(slashQuery('/'), '');
  assert.equal(slashQuery('/审查'), '审查');
  assert.equal(slashQuery('/审查 代码'), null, 'a space ends the trigger');
  assert.equal(slashQuery('说说 /审查'), null, 'only at the start of the input');
  const skills = [{ id: 'a', name: '代码审查', description: '规范', updatedAt: 0 }, { id: 'b', name: '日志排查', description: 'nginx 日志', updatedAt: 0 }];
  assert.deepEqual(filterSkills(skills, 'NGINX').map(s => s.id), ['b']);
  assert.deepEqual(filterSkills(skills, '').map(s => s.id), ['a', 'b']);
  let selected: string[] = [];
  for (let i = 0; i < MAX_SELECTED + 2; i++) selected = toggleSelection(selected, 's' + i);
  assert.equal(selected.length, MAX_SELECTED);
  assert.deepEqual(toggleSelection(['x', 'y'], 'x'), ['y']);
});

test('attachment precheck rejects oversized, empty and too many files with actionable reasons', async () => {
  const { precheck, sizeLabel, ATTACHMENT_LIMIT, MAX_ATTACHMENTS } = await import('../src/admin/desk-attachments.ts');
  assert.equal(precheck(10, 0), null);
  assert.match(precheck(ATTACHMENT_LIMIT + 1, 0) ?? '', /1 MB/);
  assert.match(precheck(0, 0) ?? '', /空/);
  assert.match(precheck(10, MAX_ATTACHMENTS) ?? '', /最多/);
  assert.equal(sizeLabel(512), '512 B');
  assert.equal(sizeLabel(2048), '2.0 KB');
});

test('guidance merges by message id and a receipt is not rolled back by a replayed queued event', async () => {
  const { applyGuidance, guidanceLabel, guidanceTone, elapsedLabel } = await import('../src/admin/desk-agent.ts');
  let list = applyGuidance(undefined, { messageId: 'g1', text: '只看日志', status: 'sending' });
  list = applyGuidance(list, { messageId: 'g1', status: 'queued' });
  assert.deepEqual(list, [{ messageId: 'g1', text: '只看日志', status: 'queued' }]);
  list = applyGuidance(list, { messageId: 'g1', status: 'applied' });
  list = applyGuidance(list, { messageId: 'g1', text: '只看日志', status: 'queued' });
  assert.equal(list[0].status, 'applied');
  list = applyGuidance(list, { messageId: 'g2', text: '换个思路', status: 'unapplied' });
  assert.deepEqual(list.map(g => guidanceTone(g.status)), ['ok', 'bad']);
  assert.equal(applyGuidance(list, { status: 'queued' }), list, 'missing id keeps the list');
  assert.equal(guidanceLabel('unknown'), '无法确认是否采纳');
  assert.equal(elapsedLabel(5_400), '5 秒');
  assert.equal(elapsedLabel(65_000), '1 分 05 秒');
});

test('workspace listing parser, ordering and path helpers', async () => {
  const { parseListing, joinPath, relativePath } = await import('../src/admin/desk-files.ts');
  const raw = JSON.stringify({ data: { path: '/srv', entries: [{ name: 'b.txt', directory: false, bytes: 3 }, { name: 'src', directory: true, bytes: 0 }, { name: 'A.md', directory: false, bytes: 1 }, { bad: 1 }], truncated: true } });
  assert.deepEqual(parseListing(raw), { entries: [{ name: 'src', directory: true, bytes: 0 }, { name: 'A.md', directory: false, bytes: 1 }, { name: 'b.txt', directory: false, bytes: 3 }], truncated: true });
  assert.equal(parseListing('{"path":"/x"}'), null);
  assert.equal(parseListing('not json'), null);
  assert.equal(parseListing(null), null);
  assert.equal(joinPath('windows', 'E:\\proj', 'src'), 'E:\\proj\\src');
  assert.equal(joinPath('linux', '/srv/', 'a'), '/srv/a');
  assert.equal(relativePath('windows', 'E:\\Proj', 'e:\\proj\\src\\main.ts'), 'src/main.ts');
  assert.equal(relativePath('linux', '/srv', '/srv/a/b'), 'a/b');
  assert.equal(relativePath('linux', '/srv', '/other/x'), '/other/x');
});

test('renderMarkdown escapes HTML, protects inline code, renders codeblocks with line numbers and safe links/tables', async () => {
  const { renderMarkdown } = await import('../src/admin/desk-markdown.ts');
  const html = renderMarkdown([
    '# 标题 <script>alert(1)</script>',
    '',
    '用 `**不是粗体**` 和 **真粗体** 还有 [安全](https://example.com/a?x=1&y=2) 与 [危险](javascript:alert(1))。',
    '',
    '| 项 | 值 |',
    '| --- | --- |',
    '| 端口 | `18921` |',
    '',
    '```ts',
    'const x = 1;',
    'const y = "<tag>";',
    '```',
  ].join('\n'));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<h1>标题 &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h1>/);
  assert.match(html, /<code class="ic">\*\*不是粗体\*\*<\/code>/);
  assert.match(html, /<strong>真粗体<\/strong>/);
  assert.match(html, /<a href="https:\/\/example\.com\/a\?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">安全<\/a>/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /<table><thead><tr><th>项<\/th><th>值<\/th><\/tr><\/thead><tbody><tr><td>端口<\/td><td><code class="ic">18921<\/code><\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<button type="button" class="code-copy">复制<\/button>/);
  assert.match(html, /<span class="code-linenums" aria-hidden="true">1\n2<\/span>/);
  assert.match(html, /const y = &quot;&lt;tag&gt;&quot;;/);
});

test('context menu positioning preserves cursor coordinates, flips cleanly near viewport edges, and falls back on keyboard contextmenu', async () => {
  const { placeFloatingMenu, contextMenuPoint } = await import('../src/admin/desk-menu.ts');
  assert.deepEqual(
    placeFloatingMenu({ x: 180, y: 210, width: 200, height: 180, viewportWidth: 1280, viewportHeight: 860 }),
    { left: 180, top: 210, flipX: false, flipY: false },
  );
  assert.deepEqual(
    placeFloatingMenu({ x: 190, y: 810, width: 200, height: 180, viewportWidth: 1280, viewportHeight: 860 }),
    { left: 190, top: 630, flipX: false, flipY: true },
  );
  assert.deepEqual(
    placeFloatingMenu({ x: 300, y: 833, width: 200, height: 180, viewportWidth: 390, viewportHeight: 860, flipLeftFrom: 300, flipUpFrom: 801 }),
    { left: 100, top: 621, flipX: true, flipY: true },
  );
  assert.deepEqual(
    placeFloatingMenu({ x: -12, y: 40, width: 200, height: 180, viewportWidth: 180, viewportHeight: 160 }),
    { left: 8, top: 8, flipX: false, flipY: false },
  );
  assert.deepEqual(
    contextMenuPoint({ clientX: 165, clientY: 224 }, { left: 40, top: 200, bottom: 232 }),
    { x: 165, y: 224 },
  );
  assert.deepEqual(
    contextMenuPoint({ clientX: 0, clientY: 0 }, { left: 40, top: 200, bottom: 232 }),
    { x: 64, y: 236, flipUpFrom: 196 },
  );
});
