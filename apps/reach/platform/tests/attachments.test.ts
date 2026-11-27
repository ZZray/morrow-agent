// Copyright (c) Ray Zhang. 对话附件：分类与文本抽取、大小与条数上限、按用户隔离、提示格式与 HandWave 同口径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { AttachmentStore, AttachmentToolsHost, attachmentPrompt, classify, ATTACHMENT_LIMIT, MAX_ATTACHMENTS, TEXT_PROMPT_LIMIT } from '../src/attachments.ts';

function store() { const root = resolve('work/desk-attachments-' + randomUUID()); mkdirSync(root, { recursive: true }); return new AttachmentStore(root); }
const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (error) { return (error as { code?: string }).code ?? String(error); } };
const b64 = (text: string | Buffer) => Buffer.from(text).toString('base64');

test('classify extracts UTF-8 text, keeps images and treats binary or SVG as files', () => {
  assert.deepEqual(classify('error.log', 'application/octet-stream', Buffer.from('第一行\n')), { kind: 'text', text: '第一行\n' });
  assert.equal(classify('a.png', 'image/png', Buffer.from([0x89, 0x50])).kind, 'image');
  assert.equal(classify('logo.svg', 'image/svg+xml', Buffer.from('<svg/>')).kind, 'file', 'SVG is never inline');
  assert.equal(classify('blob.bin', 'application/octet-stream', Buffer.from([0xff, 0xfe, 0x00])).kind, 'file');
  assert.equal(classify('x.txt', 'text/plain', Buffer.from([0xff, 0xfe])).kind, 'file', 'invalid UTF-8 is not text');
});

test('save enforces size, sanitizes names and stays per user', () => {
  const attachments = store();
  const saved = attachments.save('alice', '../../etc/passwd.log', 'text/plain', b64('hello'));
  assert.match(saved.id, /^[0-9a-f]{32}$/);
  assert.equal(saved.name, '.._.._etc_passwd.log');
  assert.equal(attachments.bytes('alice', saved.id).data.toString(), 'hello');
  assert.equal(code(() => attachments.meta('bob', saved.id)), 'attachment_missing');
  assert.equal(code(() => attachments.save('alice', 'big.bin', 'application/octet-stream', b64(Buffer.alloc(ATTACHMENT_LIMIT + 1)))), 'attachment_too_large');
  assert.equal(code(() => attachments.save('alice', 'e.txt', 'text/plain', '')), 'attachment_empty');
  assert.equal(attachments.save('alice', 'x', 'not a mime', b64('x')).mime, 'application/octet-stream');
});

test('resolve caps count and rejects duplicates or unknown ids', () => {
  const attachments = store(); const ids = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => attachments.save('u', `f${i}.txt`, 'text/plain', b64('t' + i)).id);
  assert.equal(attachments.resolve('u', ids.slice(0, 2)).length, 2);
  assert.equal(code(() => attachments.resolve('u', ids)), 'attachment_selection_invalid');
  assert.equal(code(() => attachments.resolve('u', [ids[0], ids[0]])), 'attachment_selection_invalid');
  assert.equal(code(() => attachments.resolve('u', ['0'.repeat(32)])), 'attachment_missing');
});

test('prompt appends text, instructs PNG vision tool lookup and caps total text', () => {
  const prompt = attachmentPrompt([
    { id: 'a', name: 'err.log', mime: 'text/plain', size: 3, kind: 'text', text: '502' },
    { id: 'b', name: 'shot.png', mime: 'image/png', size: 9, kind: 'image' },
    { id: 'w', name: 'pic.webp', mime: 'image/webp', size: 9, kind: 'image' },
    { id: 'c', name: 'data.bin', mime: 'application/octet-stream', size: 9, kind: 'file' },
  ]);
  assert.match(prompt, /\[附件 err\.log\]\n502/);
  assert.match(prompt, /reach_attachment_image\(attachment_id="b"\)/);
  assert.match(prompt, /\[图片附件 pic\.webp（image\/webp）：当前视觉工具仅支持 PNG 原图/);
  assert.match(prompt, /\[附件 data\.bin：类型 application\/octet-stream，未提取文本\]/);
  const long = attachmentPrompt([{ id: 'x', name: 'big.txt', mime: 'text/plain', size: 0, kind: 'text', text: 'x'.repeat(TEXT_PROMPT_LIMIT + 10) }]);
  assert.ok(long.length < TEXT_PROMPT_LIMIT + 200 && long.includes('附件过长'));
});

test('AttachmentToolsHost validates PNG attachments, emits verifiable ModelImage and replays idempotently', () => {
  const root = resolve('work/desk-attach-host-' + randomUUID());
  mkdirSync(root, { recursive: true });
  const attachments = new AttachmentStore(root);
  const png = new PNG({ width: 1, height: 1 });
  png.data[0] = 255; png.data[3] = 255;
  const pngBytes = PNG.sync.write(png);
  const savedPng = attachments.save('alice', 'shot.png', 'image/png', pngBytes.toString('base64'));
  const savedTxt = attachments.save('alice', 'note.txt', 'text/plain', b64('plain text'));
  const otherPng = attachments.save('bob', 'other.png', 'image/png', pngBytes.toString('base64'));

  const taskRoot = join(root, 'task');
  const turn = { id: 'm1', user_id: 'alice', task_id: 't1', run_id: 'r1' };
  const host = new AttachmentToolsHost(attachments, 'alice', [savedPng, savedTxt], turn, taskRoot);

  const frameOk = { task_id: 't1', run_id: 'r1', native_call_id: 'c1', rpc_id: 'rpc1', tool_name: 'reach_attachment_image', args_sha256: 'h1', arguments: { attachment_id: savedPng.id } };
  const reply1 = host.invoke(frameOk);
  assert.equal(reply1.is_error, false);
  assert.equal(reply1.settlement, 'Settled');
  assert.equal(reply1.images?.length, 1);
  assert.equal(reply1.images![0].width, 1);
  assert.equal(reply1.images![0].height, 1);
  assert.equal(reply1.images![0].bytes, pngBytes.length);

  const replay = host.invoke(frameOk);
  assert.deepEqual(replay, reply1);

  const replyText = host.invoke({ task_id: 't1', run_id: 'r1', native_call_id: 'c2', rpc_id: 'rpc2', tool_name: 'reach_attachment_image', args_sha256: 'h2', arguments: { attachment_id: savedTxt.id } });
  assert.equal(replyText.is_error, true);
  assert.equal(replyText.settlement, 'Settled');
  assert.equal(replyText.images, undefined);

  const replyForeign = host.invoke({ task_id: 't1', run_id: 'r1', native_call_id: 'c3', rpc_id: 'rpc3', tool_name: 'reach_attachment_image', args_sha256: 'h3', arguments: { attachment_id: otherPng.id } });
  assert.equal(replyForeign.is_error, true);
  assert.equal(replyForeign.settlement, 'Settled');

  const review = host.review();
  assert.equal(review.records.length, 3);
  assert.equal(review.evidencePaths.length, 6);
});
