// handwave 渲染层 —— Markdown 子集 + 工具调用卡片（开源 AI 聊天风格）。
// 先转义后替换，防 HTML 注入；代码块带语言标签与复制按钮。
'use strict';

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, (m, c) => '<code class="ic">' + c + '</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function mdCodeBlock(lang, code) {
  const lines = code.split('\n');
  const lineNums = lines.map((_, i) => String(i + 1)).join('\n');
  // Detect if this looks like a file: first line starts with // path, # path, or is a filepath
  const firstLine = lines[0] || '';
  const pathMatch = firstLine.match(/^(?:\/\/|<!--|#)\s+(.+)$/) ||
    firstLine.match(/^\/(?:[^\/\s]+\/)*[^\/\s]+(?:\.[a-zA-Z0-9]+)?$/);
  const fileHint = pathMatch ? pathMatch[1] : '';
  const applyBtn = fileHint
    ? '<button type="button" class="code-apply" data-path="' + escHtml(fileHint) + '" data-content="' + escHtml(code) + '">应用</button>'
    : '';
  return '<pre class="codeblock" data-lang="' + escHtml(lang) + '"><div class="code-head"><span>' +
    escHtml(lang || 'text') + '</span><button type="button" class="code-copy">复制</button>' + applyBtn + '</div>' +
    '<div class="code-body"><span class="code-linenums">' + escHtml(lineNums) + '</span><code>' +
    escHtml(code) + '</code></div></pre>';
}
function mdRender(src) {
  const lines = String(src || '').split('\n');
  const out = [];
  let inCode = false, codeLang = '', codeBuf = [];
  let inList = false, listTag = '';
  let para = [];
  const closePara = () => { if (para.length) { out.push('<p>' + mdInline(escHtml(para.join(' '))) + '</p>'); para = []; } };
  const closeList = () => { if (inList) { out.push('</' + listTag + '>'); inList = false; } };
  for (const line of lines) {
    if (inCode) {
      if (/^```/.test(line.trim())) {
        out.push(mdCodeBlock(codeLang, codeBuf.join('\n')));
        inCode = false; codeBuf = []; codeLang = '';
      } else codeBuf.push(line);
      continue;
    }
    const t = line.trim();
    if (/^```/.test(t)) { closePara(); closeList(); inCode = true; codeLang = t.slice(3).trim(); continue; }
    if (!t) { closePara(); closeList(); continue; }
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closePara(); closeList(); const n = h[1].length; out.push('<h' + n + '>' + mdInline(escHtml(h[2])) + '</h' + n + '>'); continue; }
    if (/^(-{3,}|\*{3,})$/.test(t)) { closePara(); closeList(); out.push('<hr>'); continue; }
    if (/^>\s?/.test(t)) { closePara(); closeList(); out.push('<blockquote>' + mdInline(escHtml(t.replace(/^>\s?/, ''))) + '</blockquote>'); continue; }
    const ul = t.match(/^[-*]\s+(.*)$/);
    const ol = t.match(/^\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      closePara();
      const tag = ul ? 'ul' : 'ol';
      if (!inList || listTag !== tag) { closeList(); out.push('<' + tag + '>'); inList = true; listTag = tag; }
      out.push('<li>' + mdInline(escHtml((ul || ol)[1])) + '</li>');
      continue;
    }
    closeList();
    para.push(t);
  }
  if (inCode) out.push(mdCodeBlock(codeLang, codeBuf.join('\n')));
  closePara(); closeList();
  return out.join('\n');
}

// 代码块复制：事件委托，动态内容也生效。
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('.code-copy') : null;
  if (!btn) return;
  const pre = btn.closest('pre.codeblock');
  const code = pre && pre.querySelector('code');
  if (!code) return;
  const done = (txt) => { btn.textContent = txt; setTimeout(() => { btn.textContent = '复制'; }, 1200); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code.textContent).then(() => done('已复制'), () => done('失败'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = code.textContent;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done('已复制'); } catch (_) { done('失败'); }
    ta.remove();
  }
});

// ---------- 工具调用卡片 ----------
// 状态：run（转动图标）→ ok / fail；头部单行摘要，点击展开参数与输出。
function toolSummary(name, args) {
  if (name === 'exec') return args.cmd || '';
  if (name === 'read_file') return args.path || '';
  if (name === 'write_file') return args.path || '';
  if (name === 'delegate_agent') return (args.name ? args.name + ' · ' : '') + (args.task || '');
  if (name === 'run_node_task') return (args.name ? args.name + ' · ' : '') + (args.objective || '');
  try { return JSON.stringify(args); } catch (_) { return ''; }
}
function makeToolCard(name, args) {
  const card = el('div', 'toolcard run');
  const head = el('button', 'toolcard-head');
  head.type = 'button';
  const icon = el('span', 'toolcard-ic');
  icon.innerHTML =
    '<svg class="spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>' +
    '<svg class="ok" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' +
    '<svg class="fail" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  head.appendChild(icon);
  head.appendChild(el('span', 'toolcard-name', name || 'tool'));
  const sum = el('span', 'toolcard-sum', toolSummary(name, args || {}));
  sum.title = sum.textContent;
  head.appendChild(sum);
  const chev = el('span', 'toolcard-chev', '▸');
  head.appendChild(chev);
  card.appendChild(head);
  const body = el('div', 'toolcard-body');
  const argPre = el('pre', 'toolcard-args');
  argPre.textContent = safeJSON(args);
  body.appendChild(el('div', 'toolcard-label', '参数'));
  body.appendChild(argPre);
  const outLabel = el('div', 'toolcard-label', '输出');
  const outPre = el('pre', 'toolcard-out');
  outPre.textContent = '…';
  body.appendChild(outLabel);
  body.appendChild(outPre);
  card.appendChild(body);
  head.onclick = () => card.classList.toggle('open');
  const api = {
    el: card,
    appendOut(text) {
      if (outPre.textContent === '…') outPre.textContent = '';
      outPre.textContent += text;
    },
    setOut(text) { outPre.textContent = text == null || text === '' ? '（无输出）' : text; },
    finish(ok, note) {
      card.classList.remove('run');
      card.classList.add(ok ? 'ok' : 'fail');
      if (note) {
        const n = el('span', 'toolcard-note', note);
        head.insertBefore(n, chev);
      }
    },
  };
  return api;
}
function safeJSON(v) {
  try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
}
