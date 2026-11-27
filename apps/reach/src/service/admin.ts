// Copyright (c) Ray Zhang. Explicit static routes; never expose source or state directories.
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
const assets = new Map([
  ['/', { path: new URL('../admin/index.html', import.meta.url), type: 'text/html; charset=utf-8' }],
  ['/assets/admin.css', { path: new URL('../admin/admin.css', import.meta.url), type: 'text/css; charset=utf-8' }],
  ['/assets/tokens.css', { path: new URL('../admin/tokens.css', import.meta.url), type: 'text/css; charset=utf-8' }],
  ['/assets/controls.css', { path: new URL('../admin/controls.css', import.meta.url), type: 'text/css; charset=utf-8' }],
  ['/assets/dropdown.js', { path: new URL('../../dist/admin/dropdown.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/shell.js', { path: new URL('../../dist/admin/shell.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/desk.js', { path: new URL('../../dist/admin/desk.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/desk-settlement.js', { path: new URL('../../dist/admin/desk-settlement.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/desk-images.js', { path: new URL('../../dist/admin/desk-images.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/desk-steps.js', { path: new URL('../../dist/admin/desk-steps.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/desk-agent.js', { path: new URL('../../dist/admin/desk-agent.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/desk-files.js', { path: new URL('../../dist/admin/desk-files.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/desk-queue.js', { path: new URL('../../dist/admin/desk-queue.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/desk-skills.js', { path: new URL('../../dist/admin/desk-skills.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/desk-markdown.js', { path: new URL('../../dist/admin/desk-markdown.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/desk-memory.js', { path: new URL('../../dist/admin/desk-memory.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/desk-attachments.js', { path: new URL('../../dist/admin/desk-attachments.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/desk.css', { path: new URL('../admin/desk.css', import.meta.url), type: 'text/css; charset=utf-8' }],
  ['/assets/admin.js', { path: new URL('../../dist/admin/admin.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/model.js', { path: new URL('../../dist/admin/model.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/charts.js', { path: new URL('../../dist/admin/charts.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/theme.js', { path: new URL('../../dist/admin/theme.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/artifacts.js', { path: new URL('../../dist/admin/artifacts.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/assets/outfit.ttf', { path: new URL('../../assets/fonts/Outfit-wght.ttf', import.meta.url), type: 'font/ttf' }],
  ['/assets/reach.svg', { path: new URL('../../assets/brand/reach.svg', import.meta.url), type: 'image/svg+xml' }],
]);
export async function serveAdmin(route: string, method: string, response: ServerResponse, rayLogin = false, desk = false, search = '') {
  // 对话已并入控制台（#/desk）。旧的 /desk/ 链接跳到对话页，保留对话参数。
  if ((route === '/desk' || route === '/desk/') && ['GET', 'HEAD'].includes(method)) {
    const conversation = new URLSearchParams(search).get('c');
    const hash = conversation && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversation) ? `#/desk/${conversation.toLowerCase()}` : '#/desk';
    response.writeHead(308, { location: (route === '/desk' ? './' : '../') + hash, 'cache-control': 'no-store' }); response.end(); return true;
  }
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
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  response.end(method === 'HEAD' ? undefined : content);
  return true;
}
