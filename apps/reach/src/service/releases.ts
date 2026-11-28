// Copyright (c) Ray Zhang. Published multi-platform installer manifest (Windows / macOS / Linux) for the download page; never invents a release.
import { open, readFile, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { ReachError, requireCondition } from './errors.ts';

const httpsUrl = z.string().url().max(2048).refine(v => v.startsWith('https://'), 'Expected HTTPS download URL');
const localBrowserUrl = z.string().regex(/^api\/v1\/releases\/files\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/);
const localNodeUrl = z.string().regex(/^api\/v1\/node\/update\/files\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/);
const base64 = (maxBytes: number, exactBytes?: number) => z.string().min(4).max(Math.ceil(maxBytes / 3) * 4).refine(value => {
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.length <= maxBytes && (exactBytes === undefined || bytes.length === exactBytes)
    && bytes.toString('base64') === value;
}, 'Expected canonical base64');
const assetSchema = z.strictObject({
  name: z.string().min(1).max(256),
  kind: z.enum(['node', 'agent', 'complete']),
  os: z.enum(['windows', 'macos', 'linux']).optional(),
  arch: z.enum(['x64', 'arm64', 'universal']),
  format: z.string().min(1).max(32).optional(),
  bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  signed: z.boolean(),
  sources: z.array(z.strictObject({ kind: z.enum(['github', 'gitee', 'reach']), url: z.union([httpsUrl, localBrowserUrl]) })
    .refine(source => source.kind === 'reach' || source.url.startsWith('https://'), 'Only Reach can provide a local download')).min(1).max(3),
  update: z.strictObject({ manifest: base64(16 * 1024), signature: base64(64, 64), url: z.union([httpsUrl, localNodeUrl]) }).optional(),
}).refine(asset => (asset.os !== 'macos' && asset.os !== 'linux') || asset.kind === 'node',
  'Expected a Worker archive for macOS or Linux');
export const releaseManifestSchema = z.strictObject({
  releases: z.array(z.strictObject({
    version: z.string().min(1).max(64),
    tag: z.string().min(1).max(128),
    publishedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    notes: z.string().max(4000).optional(),
    assets: z.array(assetSchema).min(1).max(24),
  }).superRefine((release, context) => {
    for (const [i, asset] of release.assets.entries()) {
      for (const [j, source] of asset.sources.entries()) {
        if (!source.url.startsWith('https://') && source.url !== `api/v1/releases/files/${release.tag}/${asset.name}`) {
          context.addIssue({ code: 'custom', path: ['assets', i, 'sources', j, 'url'], message: 'Local download must match this release asset' });
        }
      }
      if (asset.update && !asset.update.url.startsWith('https://') && asset.update.url !== `api/v1/node/update/files/${release.tag}/${asset.name}`) {
        context.addIssue({ code: 'custom', path: ['assets', i, 'update', 'url'], message: 'Local update must match this release asset' });
      }
    }
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

// A file must be listed in the current release catalog, and its resolved path
// must remain inside the separately configured release directory.
export async function serveReleaseFile(manifestPath: string | undefined, directory: string | undefined, tag: string, name: string, response: ServerResponse) {
  const component = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  requireCondition(tag.length <= 128 && name.length <= 256 && component.test(tag) && component.test(name), 404, 'release_asset_not_found', '未找到发行文件');
  const releases = await readReleases(manifestPath);
  const asset = releases.releases.find(release => release.tag === tag && release.assets.some(candidate => candidate.name === name))?.assets.find(candidate => candidate.name === name);
  requireCondition(asset, 404, 'release_asset_not_found', '未找到发行文件');
  requireCondition(directory, 503, 'release_asset_unconfigured', '发行文件目录尚未配置');
  let root: string, filename: string;
  try {
    root = await realpath(directory);
    filename = await realpath(join(root, tag, name));
  } catch {
    throw new ReachError(503, 'release_asset_unavailable', '发行文件暂时无法读取');
  }
  const path = relative(root, filename);
  requireCondition(path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path), 503, 'release_asset_invalid', '发行文件路径无效');
  let file;
  try { file = await open(filename, 'r'); }
  catch { throw new ReachError(503, 'release_asset_unavailable', '发行文件暂时无法读取'); }
  try {
    let stat;
    try { stat = await file.stat(); }
    catch { throw new ReachError(503, 'release_asset_unavailable', '发行文件暂时无法读取'); }
    requireCondition(stat.isFile() && stat.size === asset.bytes, 503, 'release_asset_invalid', '发行文件与清单大小不一致');
    response.writeHead(200, {
      'content-type': 'application/octet-stream', 'content-length': stat.size,
      'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    });
    try { await pipeline(file.createReadStream({ autoClose: false }), response); }
    catch (error) {
      console.error(JSON.stringify({ event: 'reach_release_stream_failed', type: error instanceof Error ? error.name : 'UnknownError' }));
      response.destroy();
    }
  } finally {
    await file.close();
  }
}
