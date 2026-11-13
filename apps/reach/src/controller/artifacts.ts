// Copyright (c) Ray Zhang. Verify original artifact bytes before emitting MCP images.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PNG } from 'pngjs';
import { artifactManifestSchema, validateArtifactText, ARTIFACT_CHUNK_BYTES, ARTIFACT_MAX_PIXELS } from '../contracts/artifacts.ts';
import type { ReachClient } from './client.ts';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function validatePng(bytes: Buffer, width: number, height: number) {
  if (bytes.length < 33 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Invalid PNG signature');
  let offset = 8, header = false, ended = false, palette = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('Truncated PNG chunk');
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset + length + 12 > bytes.length || (!header && type !== 'IHDR')) throw new Error('Invalid PNG chunk bounds');
    if (type === 'IHDR') {
      if (header || offset !== 8 || length !== 13 || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height
        || width < 1 || height < 1 || width * height > ARTIFACT_MAX_PIXELS || bytes[28] !== 0) throw new Error('Unsupported PNG header or interlacing');
      header = true;
    }
    if (type === 'PLTE') {
      if (palette || length < 3 || length > 768 || length % 3) throw new Error('Invalid PNG palette');
      palette = true;
    }
    if ((type === 'tRNS' && length > 256) || (type === 'gAMA' && length !== 4)) throw new Error('Invalid PNG metadata');
    offset += length + 12;
    if (type === 'IEND') { if (length || offset !== bytes.length) throw new Error('Invalid PNG end'); ended = true; break; }
  }
  if (!ended) throw new Error('Missing PNG end');
  // Non-interlaced pngjs decode uses bounded inflate based on the single validated IHDR.
  const decoded = PNG.sync.read(bytes, { checkCRC: true });
  if (decoded.width !== width || decoded.height !== height) throw new Error('Invalid PNG pixels');
}
export async function artifactIdentity(client: ReachClient, operationId: string, artifactId: string) {
  const list = await client.request(`/api/v1/operations/${operationId}/artifacts`);
  if (list.binding?.operationId !== operationId || !Array.isArray(list.artifacts)) throw new Error('Artifact operation binding mismatch');
  const value = list.artifacts.find((v: any) => v.artifactId === artifactId);
  if (!value?.complete) throw new Error('Original artifact is missing or incomplete; do not execute the operation again');
  const { complete: _, ...raw } = value;
  const manifest = artifactManifestSchema.parse(raw);
  return { binding: list.binding, manifest };
}
async function verifiedRange(client: ReachClient, operationId: string, artifactId: string, identity: Awaited<ReturnType<typeof artifactIdentity>>, offset: number, length: number) {
  const { binding, manifest } = identity;
  const response = await client.request(`/api/v1/operations/${operationId}/artifacts/${artifactId}?offset=${offset}&length=${length}`);
  if (!isDeepStrictEqual(response.binding, binding) || !isDeepStrictEqual(artifactManifestSchema.parse(response.manifest), manifest)) throw new Error('Artifact identity changed while reading');
  const bytes = Buffer.from(response.dataBase64 ?? '', 'base64');
  if (bytes.toString('base64') !== response.dataBase64 || bytes.length !== Math.min(length, manifest.byteLength - offset)
    || response.offset !== offset || response.length !== bytes.length || response.nextOffset !== offset + bytes.length
    || response.eof !== (offset + bytes.length === manifest.byteLength) || hash(bytes) !== response.sha256) throw new Error('Artifact range integrity check failed');
  return { response, bytes };
}
export async function readArtifactRange(client: ReachClient, operationId: string, artifactId: string, offset = 0, length = ARTIFACT_CHUNK_BYTES) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > ARTIFACT_CHUNK_BYTES) throw new Error('Invalid artifact range');
  const identity = await artifactIdentity(client, operationId, artifactId);
  if (offset >= identity.manifest.byteLength && !(offset === 0 && identity.manifest.byteLength === 0)) throw new Error('Artifact range starts past the original bytes');
  const { response, bytes } = await verifiedRange(client, operationId, artifactId, identity, offset, length);
  let text: string | undefined;
  if (identity.manifest.mimeType === 'text/plain') {
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { /* Byte range split a UTF-8 character; original base64 remains authoritative. */ }
  }
  return { ...response, ...(text === undefined ? {} : { text }) };
}
export async function downloadArtifact(client: ReachClient, operationId: string, artifactId: string) {
  const identity = await artifactIdentity(client, operationId, artifactId);
  const { manifest } = identity;
  const chunks: Buffer[] = []; let offset = 0;
  while (offset < manifest.byteLength) {
    const { bytes } = await verifiedRange(client, operationId, artifactId, identity, offset, ARTIFACT_CHUNK_BYTES);
    chunks.push(bytes); offset += bytes.length;
  }
  const bytes = Buffer.concat(chunks);
  if (hash(bytes) !== manifest.sha256) throw new Error('Original artifact digest mismatch');
  if (manifest.mimeType === 'image/png') validatePng(bytes, manifest.width, manifest.height);
  validateArtifactText(bytes, manifest);
  return { binding: identity.binding, manifest, bytes };
}
