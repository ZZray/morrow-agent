// Copyright (c) Ray Zhang. Explicit static routes; never expose source or state directories.
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
const assets = new Map([
  ['/', { path: new URL('../admin/index.html', import.meta.url), type: 'text/html; charset=utf-8' }],
  ['/assets/admin.css', { path: new URL('../admin/admin.css', import.meta.url), type: 'text/css; charset=utf-8' }],
  ['/assets/admin.js', { path: new URL('../../dist/admin/admin.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/artifacts.js', { path: new URL('../../dist/admin/artifacts.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/reach.svg', { path: new URL('../../assets/brand/reach.svg', import.meta.url), type: 'image/svg+xml' }],
]);
export async function serveAdmin(route: string, method: string, response: ServerResponse, rayLogin = false, desk = false) {
  const asset = assets.get(route);
  if (!asset || !['GET', 'HEAD'].includes(method)) return false;
  let content: Buffer;
  try { content = await readFile(asset.path); }
  catch { response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); response.end(method === 'HEAD' ? undefined : 'Reach 管理页尚未构建，请运行 bun run build:admin。'); return true; }
  if (route === '/' && rayLogin) content = Buffer.from(content.toString('utf8').replace('name="reach-login-provider" content="local"', 'name="reach-login-provider" content="ray"'));
  if (route === '/' && desk) content = Buffer.from(content.toString('utf8').replace('name="reach-desk" content="disabled"', 'name="reach-desk" content="enabled"'));
  response.writeHead(200, {
    'content-type': asset.type, 'content-length': content.length, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  response.end(method === 'HEAD' ? undefined : content);
  return true;
}
