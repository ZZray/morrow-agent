// Copyright (c) Ray Zhang. 对话附件（参照 HandWave apiUpload / nativeUserMessage）：上传后按条消息引用。
// - 文本类（UTF-8 可解码、常见文本扩展名或 text/* 类型）：抽取文本，随消息接到任务目标后面，模型可读。
// - 图片：保存并在消息上显示；Morrow 目前只接受工具结果里的图片，用户图片还不能直接交给模型，目标里如实说明。
// - 其他类型：只保存并在目标里标注文件名与类型。
// 单个附件 ≤ 1 MB（现有 JSON 请求上限 2 MiB，base64 后仍在限内）；每用户一目录，文件名用随机 ID。
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { requireCondition, ReachError } from '../../src/service/errors.ts';
import { validatePng } from '../../src/controller/artifacts.ts';
import { checkedModelImage } from './device-images.ts';
import type { ModelImage } from './device-images.ts';

export const ATTACHMENT_LIMIT = 1024 * 1024, MAX_ATTACHMENTS = 6, TEXT_PROMPT_LIMIT = 96 * 1024;
export interface Attachment { id: string; name: string; mime: string; size: number; kind: 'text' | 'image' | 'file'; text?: string }
const ID = /^[0-9a-f]{32}$/;
const TEXT_EXT = /\.(txt|md|markdown|log|csv|tsv|json|jsonl|yaml|yml|toml|ini|cfg|conf|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|c|cc|cpp|h|hpp|cs|sh|ps1|bat|sql|diff|patch)$/i;
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/;

export function classify(name: string, mime: string, data: Buffer): Pick<Attachment, 'kind' | 'text'> {
  if (IMAGE_MIME.test(mime)) return { kind: 'image' };
  if (mime.startsWith('text/') || TEXT_EXT.test(name) || mime === 'application/json') {
    try { return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(data) }; } catch { /* 不是 UTF-8 文本，按普通文件处理 */ }
  }
  return { kind: 'file' };
}
const cleanName = (name: string) => name.replace(/[\\/\r\n\t<>:"|?*]/g, '_').trim().slice(0, 120) || '附件';

export class AttachmentStore {
  readonly root: string;
  constructor(stateDirectory: string) { this.root = join(stateDirectory, 'attachments'); }
  private dir(userId: string) { return join(this.root, createHash('sha256').update(userId).digest('hex').slice(0, 32)); }
  save(userId: string, name: string, mime: string, base64: string): Attachment {
    const data = Buffer.from(base64, 'base64');
    requireCondition(data.length > 0, 400, 'attachment_empty', '附件是空的');
    requireCondition(data.length <= ATTACHMENT_LIMIT, 413, 'attachment_too_large', '单个附件不超过 1 MB；大文件请放到设备上，让 Agent 在设备上读取');
    const cleanMime = /^[a-z]+\/[a-z0-9.+-]+$/i.test(mime) ? mime.toLowerCase() : 'application/octet-stream';
    const attachment: Attachment = { id: randomBytes(16).toString('hex'), name: cleanName(name), mime: cleanMime, size: data.length, ...classify(name, cleanMime, data) };
    const dir = this.dir(userId); mkdirSync(dir, { recursive: true });
    const temp = join(dir, `${attachment.id}.${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(temp, data); renameSync(temp, join(dir, `${attachment.id}.bin`));
    writeFileSync(join(dir, `${attachment.id}.json`), JSON.stringify(attachment) + '\n');
    return attachment;
  }
  meta(userId: string, id: string): Attachment {
    requireCondition(ID.test(id), 404, 'attachment_missing', '附件不存在');
    const path = join(this.dir(userId), `${id}.json`); requireCondition(existsSync(path), 404, 'attachment_missing', '附件不存在');
    return JSON.parse(readFileSync(path, 'utf8')) as Attachment;
  }
  bytes(userId: string, id: string): { meta: Attachment; data: Buffer } { const meta = this.meta(userId, id); return { meta, data: readFileSync(join(this.dir(userId), `${id}.bin`)) }; }
  resolve(userId: string, ids: string[]): Attachment[] {
    requireCondition(ids.length <= MAX_ATTACHMENTS && new Set(ids).size === ids.length, 400, 'attachment_selection_invalid', `每条消息最多 ${MAX_ATTACHMENTS} 个附件`);
    return ids.map(id => this.meta(userId, id));
  }
}

// 与 HandWave nativeUserMessage 同口径：文本附件接到消息后面；PNG 图片通过只读宿主工具查看原图，其他图片/文件如实说明。
export function attachmentPrompt(attachments: Attachment[]): string {
  let text = '', budget = TEXT_PROMPT_LIMIT;
  for (const item of attachments) {
    if (item.kind === 'text' && item.text !== undefined) {
      const body = item.text.length > budget ? item.text.slice(0, Math.max(0, budget)) + '\n…（附件过长，后面部分未附上）' : item.text;
      budget -= Math.min(item.text.length, budget);
      text += `\n\n[附件 ${item.name}]\n${body}`;
    } else if (item.kind === 'image' && item.mime === 'image/png') {
      text += `\n\n[图片附件 ${item.name}（id: ${item.id}，PNG）：如需查看图片内容，可调用 reach_attachment_image(attachment_id="${item.id}") 读取原图]`;
    } else if (item.kind === 'image') {
      text += `\n\n[图片附件 ${item.name}（${item.mime}）：当前视觉工具仅支持 PNG 原图；请结合文字说明处理，必要时请用户转为 PNG 上传]`;
    } else text += `\n\n[附件 ${item.name}：类型 ${item.mime}，未提取文本]`;
  }
  return text;
}

// ---------- 只读图片附件宿主工具（将本条消息的 PNG 附件经原生图片通道交给视觉模型） ----------
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const attachmentDefinitions = [
  {
    name: 'reach_attachment_image',
    description: 'Read a PNG image attached by the user to this message (read-only) and pass the verified pixels to the vision model.',
    schema: z.strictObject({ attachment_id: z.string().regex(ID) }),
  },
] as const;
export const attachmentTools = attachmentDefinitions.map(d => ({ name: d.name, description: d.description, parameters: z.toJSONSchema(d.schema, { io: 'input' }) }));
export const isAttachmentTool = (name: string) => attachmentDefinitions.some(d => d.name === name);
export const invalidAttachmentArguments = (name: string, args: unknown) => {
  const def = attachmentDefinitions.find(d => d.name === name);
  return !!def && !def.schema.safeParse(args).success;
};

function writeAttachmentProofOnce(path: string, value: unknown) {
  const bytes = JSON.stringify(value) + '\n';
  if (existsSync(path)) {
    requireCondition(readFileSync(path, 'utf8') === bytes, 409, 'desk_attachment_evidence_conflict', '原附件工具依据已变化');
    return { path, sha256: sha(bytes) };
  }
  const fd = openSync(path, 'wx');
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  return { path, sha256: sha(bytes) };
}

function checkedAttachmentPng(bytes: Buffer): { width: number; height: number } {
  requireCondition(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 400, 'attachment_png_invalid', '附件不是有效的 PNG 图片');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  try {
    validatePng(bytes, width, height);
    for (let offset = 8; offset < bytes.length; offset += bytes.readUInt32BE(offset) + 12) {
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') throw Error('APNG unsupported');
    }
  } catch (error) {
    throw new ReachError(400, 'attachment_png_invalid', error instanceof Error ? error.message : 'PNG 校验失败');
  }
  return { width, height };
}

export interface AttachmentReply { value: any; is_error: boolean; settlement: 'Settled'; operation_receipt: string; images?: ModelImage[] }
export interface AttachmentAuditRecord { frame: any; reply: AttachmentReply; evidenceRef: { path: string; sha256: string }; intentRef: { path: string; sha256: string } }

export class AttachmentToolsHost {
  readonly store: AttachmentStore;
  readonly userId: string;
  readonly allowed: Map<string, Attachment>;
  readonly turn: { id: string; user_id: string; task_id: string; run_id: string };
  readonly dir: string;
  readonly root: string;
  private readonly keys: string[] = [];
  constructor(store: AttachmentStore, userId: string, attachments: Attachment[], turn: { id: string; user_id: string; task_id: string; run_id: string }, root: string) {
    this.store = store; this.userId = userId;
    this.allowed = new Map(attachments.map(item => [item.id, item]));
    this.turn = turn; this.root = root; this.dir = join(root, 'attachment-calls');
    mkdirSync(this.dir, { recursive: true });
  }
  invoke(frame: any): AttachmentReply {
    requireCondition(frame.task_id === this.turn.task_id && frame.run_id === this.turn.run_id, 409, 'desk_tool_run_mismatch', '工具不属于原任务');
    const key = sha(JSON.stringify([frame.run_id, frame.native_call_id]));
    const intentPath = join(this.dir, `${key}-intent.json`), receiptPath = join(this.dir, `${key}.json`);
    if (existsSync(receiptPath)) {
      if (!this.keys.includes(key)) this.keys.push(key);
      return JSON.parse(readFileSync(receiptPath, 'utf8')).reply;
    }
    const intent = { userId: this.turn.user_id, messageId: this.turn.id, taskId: frame.task_id, runId: frame.run_id, callId: frame.native_call_id, tool: frame.tool_name, argsSha256: frame.args_sha256, arguments: frame.arguments, frame };
    const intentRef = writeAttachmentProofOnce(intentPath, intent);
    let reply: AttachmentReply;
    try {
      requireCondition(frame.tool_name === 'reach_attachment_image', 400, 'desk_tool_unknown', '未知附件工具');
      const args = attachmentDefinitions[0].schema.parse(frame.arguments);
      const item = this.allowed.get(args.attachment_id);
      requireCondition(item, 404, 'attachment_not_on_turn', '该附件不属于当前消息');
      requireCondition(item.kind === 'image' && item.mime === 'image/png', 400, 'attachment_not_png', '仅支持读取 PNG 图片附件');
      const { data } = this.store.bytes(this.userId, item.id);
      const { width, height } = checkedAttachmentPng(data);
      const hash = sha(data);
      const imgDir = join(this.root, 'evidence', 'host-images'); mkdirSync(imgDir, { recursive: true });
      const path = join(imgDir, `${hash}.png`);
      if (existsSync(path)) requireCondition(readFileSync(path).equals(data), 409, 'desk_image_integrity', '已保存的原图已变化');
      else { const fd = openSync(path, 'wx'); try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); } }
      const image: ModelImage = { path, sha256: hash, bytes: data.length, mime_type: 'image/png', width, height };
      checkedModelImage(image, this.root);
      reply = { value: { attachmentId: item.id, name: item.name, mimeType: 'image/png', width, height, bytes: data.length, sha256: hash }, is_error: false, settlement: 'Settled', operation_receipt: receiptPath, images: [image] };
    } catch (error) {
      const code = error instanceof z.ZodError ? 'invalid_attachment_tool_arguments' : error instanceof ReachError ? error.code : 'attachment_read_failed';
      const message = error instanceof Error ? error.message : '附件图片读取失败';
      reply = { value: { error: code, message, taskAccepted: false }, is_error: true, settlement: 'Settled', operation_receipt: receiptPath };
    }
    writeAttachmentProofOnce(receiptPath, { kind: 'reach-desk-attachment-call-v1', intentRef, intent, reply, taskAccepted: false });
    if (!this.keys.includes(key)) this.keys.push(key);
    return reply;
  }
  review(): { records: AttachmentAuditRecord[]; evidencePaths: string[] } {
    const records: AttachmentAuditRecord[] = [], evidencePaths: string[] = [];
    for (const key of this.keys) {
      const intentPath = join(this.dir, `${key}-intent.json`), receiptPath = join(this.dir, `${key}.json`);
      const intentBytes = readFileSync(intentPath), receiptBytes = readFileSync(receiptPath);
      const proof = JSON.parse(receiptBytes.toString('utf8'));
      requireCondition(sha(intentBytes) === proof.intentRef?.sha256, 409, 'desk_attachment_intent_changed', '原附件工具提交已变化');
      evidencePaths.push(receiptPath, intentPath);
      records.push({ frame: proof.intent.frame, reply: proof.reply, evidenceRef: { path: receiptPath, sha256: sha(receiptBytes) }, intentRef: proof.intentRef });
    }
    return { records, evidencePaths };
  }
}
