// Copyright (c) Ray Zhang. Browser-only, read-only consumer of original operation artifacts.
export interface Manifest {
  type: 'artifact.manifest'; artifactId: string; version: number;
  mimeType: 'image/png' | 'text/plain' | 'application/octet-stream';
  byteLength: number; sha256: string; contentIndex: number; chunkBytes: number; chunkCount: number;
  width?: number; height?: number; encoding?: 'utf-8'; characterCount?: number;
}
export interface Artifact extends Manifest { complete: boolean }
export interface Binding { operationId: string; nodeId: string; epoch: number; dispatchId: string | null; payloadHash: string }
export interface ArtifactList { binding: Binding; artifacts: Artifact[] }
export type Request = (path: string) => Promise<unknown>;
const CHUNK = 65_536, MAX_BYTES = 8_388_608;
const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('原始产物格式无效');
  return v as Record<string, unknown>;
}
function canonical(v: unknown): string {
  const obj = record(v);
  return JSON.stringify(Object.keys(obj).sort().map(key => [key, obj[key]]));
}
function manifest(raw: unknown): Manifest {
  const v = record(raw);
  const common = ['type', 'artifactId', 'version', 'mimeType', 'byteLength', 'sha256', 'contentIndex', 'chunkBytes', 'chunkCount'];
  const extra = v.mimeType === 'image/png' ? ['width', 'height'] : v.mimeType === 'text/plain' ? ['encoding', 'characterCount'] : [];
  if (Object.keys(v).length !== common.length + extra.length || Object.keys(v).some(k => ![...common, ...extra].includes(k))
    || v.type !== 'artifact.manifest' || !uuid(v.artifactId) || !hash(v.sha256) || !integer(v.byteLength, 0, MAX_BYTES)
    || !integer(v.contentIndex, 0, 1023) || v.chunkBytes !== CHUNK || v.chunkCount !== Math.ceil(v.byteLength / CHUNK)) throw new Error('原始产物清单无效');
  if (v.mimeType === 'image/png') {
    if (v.version !== 1 || !v.byteLength || !integer(v.width, 1, 8192) || !integer(v.height, 1, 8192) || v.width * v.height > MAX_BYTES) throw new Error('原图尺寸无效');
  } else if (v.mimeType === 'text/plain') {
    if (v.version !== 2 || v.encoding !== 'utf-8' || !integer(v.characterCount, 0, MAX_BYTES)) throw new Error('原始文本清单无效');
  } else if (v.mimeType !== 'application/octet-stream' || v.version !== 2) throw new Error('不支持的产物格式');
  return v as unknown as Manifest;
}
export function parseArtifacts(raw: unknown, operationId: string): ArtifactList {
  const v = record(raw), binding = record(v.binding);
  if (binding.operationId !== operationId || !uuid(binding.operationId) || !uuid(binding.nodeId) || !integer(binding.epoch, 1, Number.MAX_SAFE_INTEGER)
    || !(binding.dispatchId === null || uuid(binding.dispatchId)) || !hash(binding.payloadHash)) throw new Error('原始产物与操作身份不符');
  if (!Array.isArray(v.artifacts) || v.artifacts.length > 8 || (v.artifacts.length && binding.dispatchId === null)) throw new Error('原始产物列表无效');
  const artifacts = v.artifacts.map(raw => {
    const { complete, ...rest } = record(raw);
    if (typeof complete !== 'boolean') throw new Error('原始产物传输状态无效');
    return { ...manifest(rest), complete };
  });
  if (new Set(artifacts.map(v => v.artifactId)).size !== artifacts.length || new Set(artifacts.map(v => v.contentIndex)).size !== artifacts.length
    || artifacts.reduce((n, v) => n + v.byteLength, 0) > 2 * MAX_BYTES
    || artifacts.filter(v => v.mimeType === 'image/png').length > 4 || artifacts.filter(v => v.mimeType !== 'image/png').length > 4) throw new Error('原始产物列表冲突或超过上限');
  return { binding: binding as unknown as Binding, artifacts };
}
export async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), v => v.toString(16).padStart(2, '0')).join('');
}
export class ArtifactReader {
  readonly manifest: Manifest;
  private chunks: Uint8Array[] = [];
  private offset = 0;
  private ended = false;
  private failed = false;
  private busy = false;
  private decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  private characters = 0;
  private request: Request;
  private binding: Binding;
  private current: () => boolean;
  constructor(request: Request, binding: Binding, artifact: Artifact, current: () => boolean = () => true) {
    this.request = request; this.binding = binding; this.current = current;
    if (!artifact.complete) throw new Error('原始产物未完整收到，请刷新记录核对');
    const { complete: _, ...rest } = artifact; this.manifest = manifest(rest);
  }
  private checkCurrent() { if (!this.current()) throw new Error('页面已切换，已停止读取旧操作'); }
  async next(): Promise<{ text?: string; offset: number; nextOffset: number; eof: boolean }> {
    if (this.failed || this.ended || this.busy) throw new Error('读取已结束或正在进行，请重新打开预览');
    this.busy = true;
    try {
      this.checkCurrent();
      const m = this.manifest, offset = this.offset;
      const response = record(await this.request(`/operations/${this.binding.operationId}/artifacts/${m.artifactId}?offset=${offset}&length=${CHUNK}`));
      this.checkCurrent();
      if (canonical(response.binding) !== canonical(this.binding) || canonical(manifest(response.manifest)) !== canonical(m)) throw new Error('原始产物身份在读取时发生变化');
      if (typeof response.dataBase64 !== 'string' || response.dataBase64.length > 87_384) throw new Error('原始产物分段格式无效');
      const binary = atob(response.dataBase64), bytes = Uint8Array.from(binary, v => v.charCodeAt(0));
      const eof = offset + bytes.length === m.byteLength;
      if (btoa(binary) !== response.dataBase64 || bytes.length !== Math.min(CHUNK, m.byteLength - offset)
        || response.offset !== offset || response.length !== bytes.length || response.nextOffset !== offset + bytes.length
        || response.eof !== eof || await digest(bytes) !== response.sha256) throw new Error('原始产物分段校验失败');
      this.checkCurrent();
      this.chunks.push(bytes);
      if (eof && await digest(this.join()) !== m.sha256) throw new Error('原始产物完整性校验失败');
      this.checkCurrent();
      let text: string | undefined;
      if (m.mimeType === 'text/plain') {
        text = this.decoder.decode(bytes, { stream: !eof });
        for (const _character of text) this.characters++;
        if (eof && this.characters !== m.characterCount) throw new Error('原始文本字符数不符');
      }
      this.offset += bytes.length; this.ended = eof;
      return { text, offset, nextOffset: this.offset, eof };
    } catch (error) { this.failed = true; throw error; }
    finally { this.busy = false; }
  }
  private join() {
    const all = new Uint8Array(this.chunks.reduce((n, v) => n + v.length, 0));
    let offset = 0; for (const chunk of this.chunks) { all.set(chunk, offset); offset += chunk.length; }
    return all;
  }
  async download(): Promise<Uint8Array> {
    this.checkCurrent();
    while (!this.ended) await this.next();
    this.checkCurrent();
    if (this.failed) throw new Error('原始产物校验未完成');
    return this.join();
  }
}
