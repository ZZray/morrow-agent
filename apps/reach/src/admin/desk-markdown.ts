// Copyright (c) Ray Zhang. 对话输出安全 Markdown 渲染（参照 HandWave render.js）：先转义 HTML 再做行内/块级格式化。

export function escapeHtml(src: string): string {
  return String(src)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHref(raw: string): string | null {
  const unescaped = raw.replace(/&amp;/g, '&').trim();
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(unescaped)) return null;
  return escapeHtml(unescaped);
}

function renderInline(escaped: string): string {
  const spans: string[] = [];
  let text = escaped.replace(/`([^`\n]+)`/g, (_m, code) => {
    const idx = spans.length;
    spans.push(`<code class="ic">${code}</code>`);
    return `\u0000C${idx}\u0000`;
  });
  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (full, label, href) => {
      const safe = safeHref(href);
      return safe ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>` : full;
    });
  return text.replace(/\u0000C(\d+)\u0000/g, (_m, idx) => spans[Number(idx)] ?? '');
}

function renderCodeBlock(lang: string, code: string): string {
  const lines = code.split('\n');
  const nums = lines.map((_l, i) => String(i + 1)).join('\n');
  const label = lang.trim() || 'text';
  return `<pre class="codeblock" data-lang="${escapeHtml(label)}"><div class="code-head"><span>${escapeHtml(label)}</span><button type="button" class="code-copy">复制</button></div><div class="code-body"><span class="code-linenums" aria-hidden="true">${nums}</span><code>${escapeHtml(code)}</code></div></pre>`;
}

const isTableRow = (line: string) => /^\|.*\|$/.test(line.trim());
const isTableSep = (line: string) => /^\|(\s*:?-{3,}:?\s*\|)+$/.test(line.trim());
const splitCells = (line: string) => line.trim().slice(1, -1).split('|').map(c => renderInline(escapeHtml(c.trim())));

export function renderMarkdown(src: string): string {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inCode = false, codeLang = '', codeBuf: string[] = [];
  let listTag: 'ul' | 'ol' | '' = '';
  let para: string[] = [];

  const closePara = () => {
    if (!para.length) return;
    out.push(`<p>${para.map(line => renderInline(escapeHtml(line))).join('<br>')}</p>`);
    para = [];
  };
  const closeList = () => {
    if (!listTag) return;
    out.push(`</${listTag}>`);
    listTag = '';
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (inCode) {
      if (/^```/.test(t)) {
        out.push(renderCodeBlock(codeLang, codeBuf.join('\n')));
        inCode = false; codeLang = ''; codeBuf = [];
      } else codeBuf.push(raw);
      continue;
    }
    if (/^```/.test(t)) {
      closePara(); closeList();
      inCode = true; codeLang = t.slice(3).trim(); codeBuf = [];
      continue;
    }
    if (!t) { closePara(); closeList(); continue; }

    if (isTableRow(t) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closePara(); closeList();
      const headers = splitCells(t);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitCells(lines[i]));
        i++;
      }
      i--;
      const thead = `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>`;
      const tbody = rows.length ? `<tbody>${rows.map(r => `<tr>${headers.map((_h, idx) => `<td>${r[idx] ?? ''}</td>`).join('')}</tr>`).join('')}</tbody>` : '';
      out.push(`<div class="md-table-wrap"><table>${thead}${tbody}</table></div>`);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(t);
    if (heading) {
      closePara(); closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { closePara(); closeList(); out.push('<hr>'); continue; }
    if (/^>\s?/.test(t)) {
      closePara(); closeList();
      const quoteLines = [t.replace(/^>\s?/, '')];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1].trim())) {
        i++;
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
      }
      out.push(`<blockquote>${quoteLines.map(q => renderInline(escapeHtml(q))).join('<br>')}</blockquote>`);
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(t), ol = /^\d+[.)]\s+(.*)$/.exec(t);
    if (ul || ol) {
      closePara();
      const tag = ul ? 'ul' : 'ol';
      if (listTag !== tag) { closeList(); out.push(`<${tag}>`); listTag = tag; }
      out.push(`<li>${renderInline(escapeHtml((ul ?? ol)![1]))}</li>`);
      continue;
    }
    closeList();
    para.push(t);
  }
  if (inCode) out.push(renderCodeBlock(codeLang, codeBuf.join('\n')));
  closePara();
  closeList();
  return out.join('\n');
}
