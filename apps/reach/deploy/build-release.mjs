#!/usr/bin/env node
// Copyright (c) Ray Zhang. 生成 Ray 发行包：从服务入口与 Desk Host 出发按引用链收集文件，避免手工拼装漏文件。
// 用法（在 apps/reach 下，先 bun run build:admin）：
//   node deploy/build-release.mjs --sidecar <Linux 版 morrow-agent-jsonl> --out <输出目录> [--name reach-YYYYMMDD-x]
// 产物：<out>/<name>.tar.gz，内含 morrow/apps/reach、morrow/crates/morrow-agent-jsonl/clients/node、bin/morrow-agent-jsonl；
// 部署脚本 deploy/update-unified.py 在服务器上另建 service → morrow/apps/reach 软链接。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { sidecar: { type: 'string' }, out: { type: 'string' }, name: { type: 'string' } } });
if (!values.sidecar || !values.out) throw Error('usage: --sidecar <path> --out <dir> [--name <name>]');
const app = resolve(import.meta.dirname, '..'), repo = resolve(app, '../..');
const name = values.name ?? `reach-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
const stage = resolve(values.out, name);
const entries = ['src/service/main.ts', 'platform/src/host.ts', 'platform/src/main.ts'].map(p => join(app, p));
// 运行时按路径读取、不经 import 的文件（页面、样式、字体、图标）和第三方依赖。
const extras = ['src/admin', 'dist/admin', 'assets/fonts/Outfit-wght.ttf', 'assets/fonts/Outfit-OFL.txt', 'assets/brand/reach.svg', 'package.json', 'bun.lock'];
const packages = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).dependencies ?? {};

const patterns = [/(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]/g, /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g, /new URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g, /^import\s+['"](\.[^'"]+)['"]/gm];
const seen = new Set(), bare = new Set();
function visit(file) {
  if (seen.has(file)) return; seen.add(file);
  if (!/\.(ts|mjs|js)$/.test(file)) return;
  const text = readFileSync(file, 'utf8');
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    const target = resolve(dirname(file), match[1]);
    // 浏览器端拼接的接口地址（如 ../api/v1）不是文件。
    if (existsSync(target)) visit(target);
  }
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^.'"/][^'"]*)['"]/g)) if (!match[1].startsWith('node:')) bare.add(match[1].split('/')[0]);
}
for (const entry of entries) visit(entry);
for (const dependency of bare) if (!(dependency in packages)) throw Error(`third-party import ${dependency} is not a declared dependency`);
if (!existsSync(join(app, 'dist/admin/admin.js'))) throw Error('dist/admin missing; run bun run build:admin first');

rmSync(stage, { recursive: true, force: true });
const copy = (source) => { const target = join(stage, 'morrow', relative(repo, source)); mkdirSync(dirname(target), { recursive: true }); cpSync(source, target, { recursive: true }); };
for (const file of seen) if (existsSync(file) && statSync(file).isFile()) {
  if (!file.startsWith(repo)) throw Error('import outside repository: ' + file);
  copy(file);
}
for (const extra of extras) copy(join(app, extra));
for (const dependency of bare) copy(join(app, 'node_modules', dependency));
mkdirSync(join(stage, 'bin'), { recursive: true });
cpSync(resolve(values.sidecar), join(stage, 'bin/morrow-agent-jsonl'));

const archive = resolve(values.out, `${name}.tar.gz`);
rmSync(archive, { force: true });
// Windows 上的 GNU tar 会把 C: 当成远程主机，需要 --force-local。
execFileSync('tar', [...(process.platform === 'win32' ? ['--force-local'] : []), '-czf', archive, '-C', stage, '.'], { stdio: 'inherit' });
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const manifest = { name, archive, archiveSha256: sha(archive), sidecarSha256: sha(join(stage, 'bin/morrow-agent-jsonl')), sourceFiles: seen.size, dependencies: [...bare].sort() };
writeFileSync(resolve(values.out, `${name}.json`), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
