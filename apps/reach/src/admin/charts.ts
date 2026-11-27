// Copyright (c) Ray Zhang. 控制台图表：手写 SVG/HTML，无依赖。折线带十字线与读数浮层，条形与可用性条带逐项悬停；都附数据表。
export interface Series { name: string; tone: 'a' | 'b'; values: number[]; dashed?: boolean }

// ---------- 纯函数（可单测） ----------
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value)); const f = value / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
}
export function ticks(max: number, count = 4): number[] { const top = niceMax(max); return Array.from({ length: count + 1 }, (_, i) => top * i / count); }
// 单调三次插值（Fritsch–Carlson），曲线平滑且不会冲出数据范围。
export function smoothPath(points: [number, number][]): string {
  if (!points.length) return '';
  if (points.length === 1) return `M${points[0][0]},${points[0][1]}`;
  const n = points.length, d: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((points[i + 1][1] - points[i][1]) / (points[i + 1][0] - points[i][0]));
  m.push(d[0]); for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2); m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) { if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; } const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b; if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; } }
  let path = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < n - 1; i++) { const [x0, y0] = points[i], [x1, y1] = points[i + 1], dx = (x1 - x0) / 3; path += ` C${x0 + dx},${y0 + m[i] * dx} ${x1 - dx},${y1 - m[i + 1] * dx} ${x1},${y1}`; }
  return path;
}
export function nearestIndex(fraction: number, count: number) { return Math.max(0, Math.min(count - 1, Math.round(fraction * (count - 1)))); }

// ---------- DOM ----------
const NS = 'http://www.w3.org/2000/svg';
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; }
function svgNode(tag: string, attrs: Record<string, string>) { const item = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) item.setAttribute(k, v); return item; }
function tableView(caption: string, headers: string[], rows: string[][]) {
  const details = node('details', 'chart-table'); details.append(node('summary', '', '查看数据表'));
  const table = node('table'); const cap = node('caption', 'sr', caption); const head = node('tr'); headers.forEach(h => head.append(node('th', '', h)));
  const thead = node('thead'); thead.append(head); const tbody = node('tbody');
  for (const row of rows) { const tr = node('tr'); row.forEach(cell => tr.append(node('td', '', cell))); tbody.append(tr); }
  table.append(cap, thead, tbody); details.append(table); return details;
}
export function legend(series: Pick<Series, 'name' | 'tone' | 'dashed'>[]) {
  const box = node('div', 'chart-legend');
  for (const s of series) { const item = node('span'); item.append(node('i', `key t-${s.tone}${s.dashed ? ' dashed' : ''}`), document.createTextNode(s.name)); box.append(item); }
  return box;
}

// 折线：一个 y 轴；十字线吸附最近的日期，读数浮层列出该日全部系列。
export function lineChart(options: { title: string; labels: string[]; fullLabels?: string[]; series: Series[]; format: (n: number) => string; height?: number }) {
  const { labels, series, format } = options; const count = labels.length; const height = options.height ?? 220;
  const wrap = node('figure', 'chart'); wrap.setAttribute('aria-label', options.title);
  const top = Math.max(1, ...series.flatMap(s => s.values)); const scale = ticks(top); const max = scale[scale.length - 1];
  const plot = node('div', 'plot'); plot.style.height = `${height}px`;
  const yAxis = node('div', 'y-axis');
  for (const value of [...scale].reverse()) yAxis.append(node('span', '', format(value)));
  const area = node('div', 'plot-area');
  const svg = svgNode('svg', { viewBox: `0 0 1000 ${height}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  for (const value of scale.slice(1)) { const y = String(height - value / max * height); svg.append(svgNode('line', { x1: '0', x2: '1000', y1: y, y2: y, class: 'grid' })); }
  const x = (i: number) => count === 1 ? 500 : i / (count - 1) * 1000; const y = (v: number) => height - v / max * (height - 6) - 3;
  for (const s of series) {
    const points = s.values.map((v, i) => [x(i), y(v)] as [number, number]);
    if (!s.dashed) svg.append(svgNode('path', { d: `${smoothPath(points)} L1000,${height} L0,${height} Z`, class: `fill t-${s.tone}` }));
    svg.append(svgNode('path', { d: smoothPath(points), pathLength: '1', class: `line t-${s.tone}${s.dashed ? ' dashed' : ''}` }));
  }
  area.append(svg);
  // 直接标注：每条线末端的数值（≤4 个系列时）。
  // 末端标注相距过近时错开，避免叠字。
  const ends = series.map(s => ({ s, top: y(s.values[count - 1] ?? 0) })).sort((p, q) => p.top - q.top);
  for (let i = 1; i < ends.length; i++) if (ends[i].top - ends[i - 1].top < 14) ends[i].top = ends[i - 1].top + 14;
  for (const { s, top } of ends) { const tag = node('span', `end-label t-${s.tone}`, format(s.values[count - 1] ?? 0)); tag.style.top = `${top / height * 100}%`; area.append(tag); }
  const cross = node('div', 'crosshair'); cross.hidden = true; const tip = node('div', 'chart-tip'); tip.hidden = true;
  const dots = series.map(s => { const dot = node('i', `chart-dot t-${s.tone}`); dot.hidden = true; area.append(dot); return dot; });
  area.append(cross, tip);
  const show = (index: number) => {
    const left = x(index) / 10; cross.hidden = false; cross.style.left = `${left}%`;
    series.forEach((s, k) => { dots[k].hidden = false; dots[k].style.left = `${left}%`; dots[k].style.top = `${y(s.values[index]) / height * 100}%`; });
    tip.replaceChildren(node('b', '', (options.fullLabels ?? labels)[index]));
    for (const s of series) { const row = node('span'); row.append(node('i', `key t-${s.tone}${s.dashed ? ' dashed' : ''}`), node('strong', '', format(s.values[index])), node('small', '', s.name)); tip.append(row); }
    tip.hidden = false; tip.style.left = `${left}%`; tip.classList.toggle('flip', left > 70);
  };
  const hide = () => { cross.hidden = true; tip.hidden = true; dots.forEach(d => { d.hidden = true; }); };
  area.tabIndex = 0; area.setAttribute('role', 'img'); area.setAttribute('aria-label', `${options.title}，用左右方向键查看每天的数值`);
  let focus = count - 1;
  area.addEventListener('pointermove', event => { const rect = area.getBoundingClientRect(); focus = nearestIndex((event.clientX - rect.left) / rect.width, count); show(focus); });
  area.addEventListener('pointerleave', hide); area.addEventListener('blur', hide); area.addEventListener('focus', () => show(focus));
  area.addEventListener('keydown', event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); focus = Math.max(0, Math.min(count - 1, focus + (event.key === 'ArrowLeft' ? -1 : 1))); show(focus); } });
  const xAxis = node('div', 'x-axis'); const step = Math.max(1, Math.ceil(count / 8));
  labels.forEach((label, i) => { if (step === 1 || (i % step === 0 && count - 1 - i > step / 2) || i === count - 1) { const tag = node('span', '', label); tag.style.left = `${x(i) / 10}%`; xAxis.append(tag); } });
  plot.append(yAxis, area); wrap.append(legend(series), plot, xAxis, tableView(options.title, ['日期', ...series.map(s => s.name)], labels.map((label, i) => [(options.fullLabels ?? labels)[i], ...series.map(s => format(s.values[i]))])));
  return wrap;
}

// 水平条形：数值写在条外，条的颜色只表达身份，文字保持文字色。
export function barList(title: string, rows: { label: string; value: number; parts?: { value: number; cls: string; name: string }[]; href?: string }[], format: (n: number) => string) {
  const box = node('div', 'bars'); box.setAttribute('aria-label', title);
  const max = Math.max(1, ...rows.map(r => r.value));
  for (const row of rows) {
    const line = row.href ? node('a', 'bar-row') : node('div', 'bar-row'); if (row.href && line instanceof HTMLAnchorElement) line.href = row.href;
    const track = node('span', 'bar-track');
    const parts = row.parts ?? [{ value: row.value, cls: 'a', name: title }];
    for (const part of parts) { if (!part.value) continue; const seg = node('i', `bar-seg ${part.cls}`); seg.style.width = `${part.value / max * 100}%`; seg.title = `${row.label} · ${part.name} ${format(part.value)}`; track.append(seg); }
    line.append(node('span', 'bar-label', row.label), track, node('span', 'bar-value', format(row.value)));
    box.append(line);
  }
  if (!rows.length) box.append(node('p', 'hint', '这段时间没有记录。'));
  const wrap = node('div'); wrap.append(box, tableView(title, ['项目', '数值', ...((rows[0]?.parts ?? []).map(p => p.name))], rows.map(r => [r.label, format(r.value), ...(r.parts ?? []).map(p => format(p.value))])));
  return wrap;
}

// 可用性条带：时间窗内，离线区间画斜纹，首次上线前留空（没有数据）。
export function availabilityStrip(options: { from: number; to: number; since: number | null; offline: [number, number][]; describe: (from: number, to: number) => string }) {
  const { from, to } = options; const span = Math.max(1, to - from); const pct = (t: number) => `${Math.max(0, Math.min(100, (t - from) / span * 100))}%`;
  const strip = node('span', 'avail');
  if (options.since === null) { strip.classList.add('none'); strip.title = '尚无上线记录'; return strip; }
  const known = node('i', 'avail-known'); known.style.left = pct(options.since); known.style.right = `calc(100% - ${pct(to)})`; strip.append(known);
  for (const [a, b] of options.offline) {
    const gap = node('i', 'avail-gap'); gap.style.left = pct(a); gap.style.width = `max(3px, ${(Math.min(b, to) - Math.max(a, from)) / span * 100}%)`; gap.title = options.describe(a, b); gap.tabIndex = 0; gap.setAttribute('aria-label', options.describe(a, b)); strip.append(gap);
  }
  return strip;
}

// 环形占比：各段之间留 2px 缝；颜色为状态色，图例带文字与数值。
export function donut(parts: { label: string; value: number; cls: string }[], center: string, caption: string) {
  const box = node('div', 'donut'); const total = parts.reduce((s, p) => s + p.value, 0);
  const svg = svgNode('svg', { viewBox: '0 0 120 120', 'aria-hidden': 'true' }); const r = 48, c = 2 * Math.PI * r;
  svg.append(svgNode('circle', { cx: '60', cy: '60', r: String(r), class: 'donut-track' }));
  let offset = 0;
  for (const part of parts) {
    if (!part.value || !total) continue; const length = part.value / total * c; const gap = parts.filter(p => p.value).length > 1 ? 3 : 0;
    const arc = svgNode('circle', { cx: '60', cy: '60', r: String(r), class: `donut-seg ${part.cls}`, 'stroke-dasharray': `${Math.max(0.5, length - gap)} ${c}`, 'stroke-dashoffset': String(-offset), transform: 'rotate(-90 60 60)' });
    const title = svgNode('title', {}); title.textContent = `${part.label} ${part.value}`; arc.append(title); svg.append(arc); offset += length;
  }
  const label = node('span', 'donut-v'); label.append(node('b', '', center), node('small', '', caption));
  const ring = node('div', 'donut-ring'); ring.append(svg, label);
  const keys = node('ul', 'donut-keys');
  for (const part of parts) { const li = node('li'); li.append(node('i', `key-dot ${part.cls}`), node('span', '', part.label), node('b', '', String(part.value))); keys.append(li); }
  box.append(ring, keys); return box;
}
