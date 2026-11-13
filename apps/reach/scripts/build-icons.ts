// Copyright (c) Ray Zhang. Deterministic SVG -> PNG/Windows ICO assets.
import { readFile, writeFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';

const root = new URL('../assets/brand/', import.meta.url);
const source = await readFile(new URL('reach.svg', root), 'utf8');
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const frames = sizes.map(size => new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng());
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (let i = 0; i < sizes.length; i++) {
  const entry = 6 + 16 * i;
  header[entry] = sizes[i] === 256 ? 0 : sizes[i];
  header[entry + 1] = header[entry];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(frames[i].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += frames[i].length;
}
await writeFile(new URL('reach.ico', root), Buffer.concat([header, ...frames]));
for (const size of [256, 512]) {
  await writeFile(new URL(`reach-${size}.png`, root), new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng());
}
console.log(`Reach icon: ${sizes.join(', ')} px; transparent PNG frames; canonical SVG retained.`);
