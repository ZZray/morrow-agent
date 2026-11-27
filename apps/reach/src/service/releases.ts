// Copyright (c) Ray Zhang. Published multi-platform installer manifest (Windows / macOS / Linux) for the download page; never invents a release.
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ReachError } from './errors.ts';

const httpsUrl = z.string().url().max(2048).refine(v => v.startsWith('https://'), 'Expected HTTPS download URL');
const assetSchema = z.strictObject({
  name: z.string().min(1).max(256),
  kind: z.enum(['node', 'agent', 'complete']),
  os: z.enum(['windows', 'macos', 'linux']).optional(),
  arch: z.enum(['x64', 'arm64', 'universal']),
  format: z.string().min(1).max(32).optional(),
  bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  signed: z.boolean(),
  sources: z.array(z.strictObject({ kind: z.enum(['github', 'gitee', 'reach']), url: httpsUrl })).min(1).max(3),
}).refine(asset => (asset.os !== 'macos' && asset.os !== 'linux') || asset.kind === 'node',
  'Expected a Worker archive for macOS or Linux');
export const releaseManifestSchema = z.strictObject({
  releases: z.array(z.strictObject({
    version: z.string().min(1).max(64),
    tag: z.string().min(1).max(128),
    publishedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    notes: z.string().max(4000).optional(),
    assets: z.array(assetSchema).min(1).max(24),
  })).max(50),
});
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

// 未配置清单：如实返回 configured=false；清单损坏：报错，不回退成空列表冒充「尚无发布」。
export async function readReleases(manifestPath: string | undefined) {
  if (!manifestPath) return { configured: false as const, releases: [] };
  let raw: string;
  try { raw = await readFile(manifestPath, 'utf8'); }
  catch { throw new ReachError(503, 'release_manifest_unavailable', '发行清单暂时无法读取'); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ReachError(503, 'release_manifest_invalid', '发行清单格式无效'); }
  const result = releaseManifestSchema.safeParse(parsed);
  if (!result.success) throw new ReachError(503, 'release_manifest_invalid', '发行清单格式无效');
  return { configured: true as const, releases: [...result.data.releases].sort((a, b) => b.publishedAt - a.publishedAt) };
}
