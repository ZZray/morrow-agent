// Copyright (c) Ray Zhang. Immutable, operation-bound artifact event contract.
import { z } from 'zod';

export const ARTIFACT_CHUNK_BYTES = 65_536;
export const ARTIFACT_MAX_BYTES = 8_388_608;
export const ARTIFACT_MAX_PIXELS = 8_388_608;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().uuid();
const common = {
  type: z.literal('artifact.manifest'), artifactId: id,
  byteLength: z.number().int().min(0).max(ARTIFACT_MAX_BYTES), sha256: hash,
  contentIndex: z.number().int().min(0).max(1023), chunkBytes: z.literal(ARTIFACT_CHUNK_BYTES),
  chunkCount: z.number().int().min(0).max(ARTIFACT_MAX_BYTES / ARTIFACT_CHUNK_BYTES),
};
export const artifactManifestSchema = z.discriminatedUnion('mimeType', [
  z.strictObject({ ...common, version: z.literal(1), mimeType: z.literal('image/png'),
    byteLength: common.byteLength.min(1), width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192) }),
  z.strictObject({ ...common, version: z.literal(2), mimeType: z.literal('text/plain'), encoding: z.literal('utf-8'),
    characterCount: z.number().int().min(0).max(ARTIFACT_MAX_BYTES) }),
  z.strictObject({ ...common, version: z.literal(2), mimeType: z.literal('application/octet-stream') }),
]).refine(v => v.chunkCount === Math.ceil(v.byteLength / v.chunkBytes)
  && (v.mimeType !== 'image/png' || v.width * v.height <= ARTIFACT_MAX_PIXELS), 'Invalid artifact dimensions or chunk count');
export const artifactChunkSchema = z.strictObject({ type: z.literal('artifact.chunk'), artifactId: id,
  index: z.number().int().min(0).max(127), dataBase64: z.string().min(4).max(87_384), sha256: hash });
export const artifactCompleteSchema = z.strictObject({ type: z.literal('artifact.complete'), artifactId: id });
export const artifactReferenceSchema = z.strictObject({ type: z.literal('artifact'), artifactId: id,
  mimeType: z.enum(['image/png', 'text/plain', 'application/octet-stream']), sha256: hash, contentIndex: z.number().int().min(0).max(1023) });
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
export type ArtifactChunk = z.infer<typeof artifactChunkSchema>;
export function validateArtifactText(bytes: Uint8Array, manifest: ArtifactManifest): string | undefined {
  if (manifest.mimeType !== 'text/plain') return undefined;
  // Preserve a leading BOM as original content, and reject replacement decoding.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let characters = 0; for (const _character of text) characters++;
  if (characters !== manifest.characterCount) throw new Error('Original artifact character count mismatch');
  return text;
}
export function decodeArtifactChunk(input: unknown): { chunk: ArtifactChunk; bytes: Buffer } {
  const chunk = artifactChunkSchema.parse(input);
  const bytes = Buffer.from(chunk.dataBase64, 'base64');
  if (!bytes.length || bytes.length > ARTIFACT_CHUNK_BYTES || bytes.toString('base64') !== chunk.dataBase64) throw new Error('Invalid canonical artifact base64');
  return { chunk, bytes };
}
