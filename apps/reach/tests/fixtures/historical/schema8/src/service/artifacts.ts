// Copyright (c) Ray Zhang. Uses the original event ledger, not a second upload queue.
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { artifactManifestSchema, artifactCompleteSchema, artifactReferenceSchema, decodeArtifactChunk, validateArtifactText, ARTIFACT_CHUNK_BYTES, ARTIFACT_MAX_BYTES } from '../contracts/artifacts.ts';
import type { ArtifactManifest } from '../contracts/artifacts.ts';
import { requireCondition, ReachError } from './errors.ts';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function entries(db: DatabaseSync, op: string, type: string, id?: string) {
  const sql = `SELECT data_json FROM operation_events WHERE operation_id=? AND kind='output' AND json_extract(data_json,'$.type')=?${id ? " AND json_extract(data_json,'$.artifactId')=?" : ''} ORDER BY sequence`;
  return db.prepare(sql).all(...(id ? [op, type, id] : [op, type])).map(row => JSON.parse(row.data_json as string));
}
function manifest(db: DatabaseSync, op: string, id: string): ArtifactManifest {
  const rows = entries(db, op, 'artifact.manifest', id);
  requireCondition(rows.length === 1, 404, 'artifact_not_found', '未找到这次操作的产物');
  return artifactManifestSchema.parse(rows[0]);
}
export function listArtifacts(db: DatabaseSync, op: string) {
  const complete = new Set(entries(db, op, 'artifact.complete').map(v => v.artifactId));
  return entries(db, op, 'artifact.manifest').map(value => ({ ...artifactManifestSchema.parse(value), complete: complete.has(value.artifactId) }));
}
export function validateArtifactEvent(db: DatabaseSync, op: string, kind: string, data: any) {
  if (['succeeded', 'failed', 'unknown', 'cancelled'].includes(kind)) {
    const refs = Array.isArray(data?.content) ? data.content.filter((v: any) => v?.type === 'artifact') : [];
    const manifests = listArtifacts(db, op);
    const seen = new Set();
    for (const raw of refs) {
      const ref = artifactReferenceSchema.parse(raw), info = manifests.find(v => v.artifactId === ref.artifactId);
      requireCondition(info?.complete && info.sha256 === ref.sha256 && info.mimeType === ref.mimeType && info.contentIndex === ref.contentIndex
        && data.content[ref.contentIndex] === raw && !seen.has(ref.artifactId), 409, 'artifact_reference_invalid', '产物引用必须对应这次操作的完整原始内容');
      seen.add(ref.artifactId);
    }
    const images = refs.filter((v: any) => v.mimeType === 'image/png');
    if (images.length || data?.images !== undefined) {
      requireCondition(Array.isArray(data.images) && data.images.length === images.length
        && data.images.every((v: any, i: number) => { const ref = artifactReferenceSchema.parse(v); return JSON.stringify(ref) === JSON.stringify(artifactReferenceSchema.parse(images[i])); }),
      409, 'artifact_reference_invalid', '图片清单与原内容引用不符');
    }
    if (refs.some((v: any) => v.mimeType !== 'image/png') || data?.artifacts !== undefined) {
      requireCondition(Array.isArray(data.artifacts) && data.artifacts.length === refs.length
        && data.artifacts.every((v: any, i: number) => JSON.stringify(artifactReferenceSchema.parse(v)) === JSON.stringify(artifactReferenceSchema.parse(refs[i]))),
      409, 'artifact_reference_invalid', '产物清单与原内容引用不符');
    }
    if (kind === 'succeeded') requireCondition(manifests.every(v => v.complete && seen.has(v.artifactId)), 409, 'artifact_incomplete', '成功回执须包含已完整上传的产物引用');
    return;
  }
  if (kind !== 'output' || typeof data?.type !== 'string' || !data.type.startsWith('artifact.')) return;
  if (data.type === 'artifact.manifest') {
    const next = artifactManifestSchema.parse(data), previous = listArtifacts(db, op);
    requireCondition(!previous.some(v => v.artifactId === next.artifactId), 409, 'artifact_id_conflict', '产物 ID 不能重复定义');
    requireCondition(!previous.some(v => v.contentIndex === next.contentIndex), 409, 'artifact_index_conflict', '原内容位置不能对应多个产物');
    requireCondition(previous.length < 8
      && previous.filter(v => (v.mimeType === 'image/png') === (next.mimeType === 'image/png')).length < 4
      && previous.reduce((n, v) => n + v.byteLength, next.byteLength) <= 2 * ARTIFACT_MAX_BYTES, 413, 'artifact_limit', '这次操作的产物超过上限');
    return;
  }
  if (data.type === 'artifact.chunk') {
    let decoded;
    try { decoded = decodeArtifactChunk(data); }
    catch { throw new ReachError(400, 'artifact_chunk_invalid', '产物分块格式或 base64 无效'); }
    const { chunk, bytes } = decoded, info = manifest(db, op, chunk.artifactId);
    const count = entries(db, op, 'artifact.chunk', chunk.artifactId).length;
    requireCondition(!entries(db, op, 'artifact.complete', chunk.artifactId).length && chunk.index === count && count < info.chunkCount, 409, 'artifact_chunk_order', '产物分块不连续或已完成');
    requireCondition(bytes.length === Math.min(info.chunkBytes, info.byteLength - count * info.chunkBytes) && sha(bytes) === chunk.sha256, 409, 'artifact_chunk_mismatch', '产物分块长度或哈希不符');
    return;
  }
  requireCondition(data.type === 'artifact.complete', 400, 'artifact_event_invalid', '产物事件类型无效');
  const { artifactId } = artifactCompleteSchema.parse(data), info = manifest(db, op, artifactId);
  requireCondition(!entries(db, op, 'artifact.complete', artifactId).length, 409, 'artifact_already_complete', '产物已有完成记录');
  verifiedChunks(db, op, info);
}
function verifiedChunks(db: DatabaseSync, op: string, info: ArtifactManifest) {
  const chunks = entries(db, op, 'artifact.chunk', info.artifactId).map(decodeArtifactChunk);
  requireCondition(chunks.length === info.chunkCount, 409, 'artifact_incomplete', '产物分块未完成');
  requireCondition(chunks.every((v, i) => v.chunk.index === i && v.bytes.length === Math.min(info.chunkBytes, info.byteLength - i * info.chunkBytes) && sha(v.bytes) === v.chunk.sha256), 409, 'artifact_chunk_mismatch', '原始产物分块损坏');
  const bytes = Buffer.concat(chunks.map(v => v.bytes));
  requireCondition(bytes.length === info.byteLength && sha(bytes) === info.sha256, 409, 'artifact_digest_mismatch', '产物整体哈希不符');
  try { validateArtifactText(bytes, info); }
  catch { throw new ReachError(409, 'artifact_text_invalid', '原始文本不是完整 UTF-8 或字符数不符'); }
  return chunks;
}
export function readArtifact(db: DatabaseSync, op: string, id: string, offset: number, length: number) {
  const info = manifest(db, op, id);
  requireCondition(entries(db, op, 'artifact.complete', id).length === 1, 409, 'artifact_incomplete', '原始产物仍未传输完成，不能重新执行操作补取');
  requireCondition(Number.isSafeInteger(offset) && offset >= 0 && (offset < info.byteLength || (offset === 0 && info.byteLength === 0)) && Number.isInteger(length) && length > 0 && length <= ARTIFACT_CHUNK_BYTES, 400, 'artifact_range_invalid', '产物范围无效');
  const chunks = verifiedChunks(db, op, info);
  const start = Math.floor(offset / ARTIFACT_CHUNK_BYTES), end = Math.floor((Math.min(info.byteLength, offset + length) - 1) / ARTIFACT_CHUNK_BYTES);
  const data = Buffer.concat(chunks.slice(start, end + 1).map(v => v.bytes)).subarray(offset % ARTIFACT_CHUNK_BYTES, offset % ARTIFACT_CHUNK_BYTES + length);
  return { manifest: info, offset, length: data.length, nextOffset: offset + data.length, eof: offset + data.length === info.byteLength, sha256: sha(data), dataBase64: data.toString('base64') };
}
