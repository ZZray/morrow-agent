/* Scoped pipe/PTY console. No model calls, automatic input replay or global keys. */
(() => {
  'use strict';
  const host = document.querySelector('.hw-context-body');
  if (!host || typeof onSig !== 'function' || typeof sendSig !== 'function' || document.documentElement.dataset.hwConsoleReady) return;
  document.documentElement.dataset.hwConsoleReady = '1';
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const button = (label, text) => { const e = el('button', '', text); e.type = 'button'; e.title = label; e.setAttribute('aria-label', label); return e; };
  const links = () => window.HandwaveLinks && window.HandwaveLinks.state() || {};
  const session = () => curWS && curSess ? curWS.id + '/' + curSess.id : '';
  const key = () => JSON.stringify([session(), curWS && curWS.device_fp || '', typeof myFP === 'string' ? myFP : '', links().goal && links().goal.id || '']);
  const connected = () => typeof paired !== 'undefined' && paired && typeof helloDone !== 'undefined' && helloDone;
  const capable = () => (links().capabilities || []).includes('interactive-jobs-v1');
  const terminalCapable = () => (links().capabilities || []).includes('terminal-jobs-v1') && typeof window.Terminal === 'function' && window.FitAddon && typeof window.FitAddon.FitAddon === 'function';
  const ready = () => connected() && capable() && !!session() && !!(curWS && curWS.device_fp) && !!links().goal;
  const mutations = new Set(['input', 'signal', 'resize']);
  const bytes = text => new TextEncoder().encode(text).length;
  let owner = key(), epoch = 0, logGeneration = 0, jobs = [], selected = '', output = '', notice = '', uncertain = null, pause = false, lastList = 0;
  let terminal = null, fit = null, resizeObserver = null, userInputSubscription = null, userSourceReady = false, attached = false, replayTarget = null, replayReady = false, lastResize = '';
  let rawBuffer = '', rawTimer = null, resizeTimer = null, mutationQueue = [];
  const cursors = {stdout: 0, stderr: 0}, pending = new Map();
  const card = el('details', 'hw-context-card hw-console');
  const summary = el('summary', '', '进程控制台'); card.appendChild(summary); host.appendChild(card);
  const body = el('div', 'hw-console-body'); card.appendChild(body);
  const tools = el('div', 'hw-console-tools'); body.appendChild(tools);
  const select = el('select'); select.setAttribute('aria-label', '选择托管进程'); tools.appendChild(select);
  const refresh = button('刷新进程', '↻'), scroll = button('暂停滚动', 'Ⅱ'), attach = button('接入终端', '接入终端'), interrupt = button('中断终端程序', '^C'), stop = button('停止进程树', '□');
  for (const b of [refresh, scroll, attach, interrupt, stop]) tools.appendChild(b);
  const info = el('p', 'hw-context-hint'); info.setAttribute('role', 'status'); body.appendChild(info);
  const log = el('pre', 'hw-console-output'); log.tabIndex = 0; log.setAttribute('aria-label', '进程输出'); body.appendChild(log);
  const terminalHost = el('div', 'hw-console-terminal'); terminalHost.setAttribute('aria-label', '交互终端'); terminalHost.hidden = true; body.appendChild(terminalHost);
  const form = el('form', 'hw-console-input'); body.appendChild(form);
  const input = el('input'); input.type = 'password'; input.autocomplete = 'off'; input.setAttribute('aria-label', '发送至进程的输入'); input.placeholder = '输入至进程'; form.appendChild(input);
  const reveal = button('显示输入', '◉'), send = button('发送一行输入', '↑'), eof = button('关闭标准输入', 'EOF'); send.type = 'submit'; for (const b of [reveal, send, eof]) form.appendChild(b);
  const check = button('核对上次输入结果', '核对输入结果'); body.appendChild(check); check.hidden = true;
  const explanation = el('p', 'hw-context-hint'); body.appendChild(explanation);
  const current = () => jobs.find(j => j.job_id === selected);
  const isTerminal = () => !!(current() && current().terminal);
  const busyMutation = () => [...pending.values()].some(p => mutations.has(p.action));
  const recoveryKey = () => 'hw-console-input-v1:' + owner;
  function rememberInput(value) {
    try {
      if (typeof myFP !== 'string' || !myFP) throw new Error('missing controller');
      sessionStorage.setItem(recoveryKey(), JSON.stringify({owner, job: value.job, id: value.id})); return true;
    } catch (_) { notice = '无法登记输入收据，未发送；请允许此页面使用会话存储。'; return false; }
  }
  function restoreInput() {
    try { const v = JSON.parse(sessionStorage.getItem(recoveryKey()) || 'null'); if (v && v.owner === owner && typeof v.job === 'string' && /^[A-Za-z0-9_-]{1,192}$/.test(v.job) && typeof v.id === 'string' && /^[A-Za-z0-9_-]{1,192}$/.test(v.id)) { uncertain = {job: v.job, id: v.id}; notice = '上次输入结果待核对；不会自动重发。'; } } catch (_) {}
  }
  function forgetInput() { try { sessionStorage.removeItem(recoveryKey()); } catch (_) {} }
  function clearUnsent() {
    rawBuffer = ''; mutationQueue = []; if (rawTimer !== null) clearTimeout(rawTimer); rawTimer = null;
    if (resizeTimer !== null) clearTimeout(resizeTimer); resizeTimer = null;
  }
  function detach() { attached = false; clearUnsent(); input.value = ''; input.type = 'password'; if (terminal) terminal.options.disableStdin = true; }
  function disposeTerminal() {
    detach(); if (resizeObserver) resizeObserver.disconnect(); resizeObserver = null;
    if (userInputSubscription) userInputSubscription.dispose(); userInputSubscription = null; userSourceReady = false;
    if (terminal) terminal.dispose(); terminal = fit = null; terminalHost.replaceChildren(); replayTarget = null; replayReady = false; lastResize = '';
  }
  function resetLog() {
    logGeneration++; for (const [id, p] of pending) if (p.action === 'log') { clearTimeout(p.timer); pending.delete(id); }
    output = ''; log.textContent = ''; cursors.stdout = cursors.stderr = 0; disposeTerminal();
  }
  function reset() {
    owner = key(); epoch++; for (const p of pending.values()) clearTimeout(p.timer); pending.clear();
    jobs = []; selected = ''; notice = ''; uncertain = null; resetLog(); lastList = 0; select.replaceChildren(); restoreInput();
  }
  function sync() { if (owner !== key()) reset(); }
  function authorized() {
    const s = links(), j = current();
    return ready() && j && j.state === 'running' && j.interactive === true && j.stdin_closed === false && (!j.terminal || terminalCapable()) && s.lease && s.lease.allow_jobs === true && s.lease.expires_at > Date.now() / 1000 && ['running', 'yielded', 'waiting_job'].includes(s.goal.status);
  }
  function rawAllowed() { return userSourceReady && card.open && isTerminal() && attached && replayReady && authorized() && (!uncertain || busyMutation()); }
  function writable() { return authorized() && !uncertain && !busyMutation() && !mutationQueue.length && !rawBuffer && (!isTerminal() || attached && replayReady); }
  function themeTerminal() {
    if (!terminal) return;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(card) : null;
    const background = style && style.getPropertyValue('--hw-composer-surface').trim() || '#202329';
    terminal.options.theme = {background, foreground: style && style.color || '#e6e7eb', cursor: '#9697ee', selectionBackground: '#7476b866'};
  }
  function fitTerminal() {
    resizeTimer = null; if (!terminal || !fit || !card.open || !replayReady) return;
    try {
      const d = fit.proposeDimensions(); if (!d || !d.cols || !d.rows) return;
      const cols = Math.max(20, Math.min(500, d.cols)), rows = Math.max(10, Math.min(300, d.rows));
      terminal.resize(cols, rows);
      const size = rows + '/' + cols;
      if (rawAllowed() && size !== lastResize) { lastResize = size; mutationQueue = mutationQueue.filter(p => p.action !== 'resize'); mutationQueue.push({action: 'resize', fields: {job_rows: rows, job_cols: cols}}); pump(); }
    } catch (_) { notice = '终端尺寸暂不可用，请展开后刷新。'; }
  }
  function scheduleFit() { if (resizeTimer !== null) clearTimeout(resizeTimer); resizeTimer = setTimeout(fitTerminal, 160); }
  function ensureTerminal() {
    const enabled = isTerminal() && terminalCapable(); terminalHost.hidden = !enabled; log.hidden = enabled;
    if (!enabled || !card.open || terminal) return;
    const generation = logGeneration;
    const j = current();
    terminal = new window.Terminal({cols: j.cols || 80, rows: j.rows || 24, fontSize: 11, lineHeight: 1.3, scrollback: 1000, convertEol: false, cursorBlink: false, disableStdin: true, allowProposedApi: false});
    fit = new window.FitAddon.FitAddon(); terminal.loadAddon(fit); terminal.open(terminalHost); themeTerminal();
    // Pinned xterm 6.0.0 CoreService emits onUserInput synchronously immediately
    // before onData only for keyboard/clipboard/IME. Protocol/focus responses do
    // not carry this event. See vendor/xterm/README.md; this private adapter must
    // fail closed on upgrades. Node, not the browser, answers terminal queries.
    const source = terminal._core && terminal._core.coreService;
    let userTicket = false;
    if (source && typeof source.onUserInput === 'function') {
      userInputSubscription = source.onUserInput(() => { userTicket = true; }); userSourceReady = true;
      terminal.onData(data => {
        const fromUser = userTicket; userTicket = false;
        if (!fromUser || generation !== logGeneration || !rawAllowed()) return;
        if (data === '\u0003' || data === '\u0004') { flushRaw(); enqueue('signal', {job_signal: data === '\u0003' ? 'interrupt' : 'eof'}); } else queueRaw(data);
      });
      // onBinary is intentionally not connected: no unclassified mouse/report
      // data can bypass the user-origin gate through a second output channel.
    } else notice = '本地终端输入适配器不可用，仅允许观察；请更新页面。';
    if (typeof ResizeObserver === 'function') { resizeObserver = new ResizeObserver(scheduleFit); resizeObserver.observe(terminalHost); }
    scheduleFit();
  }
  function render() {
    sync(); const j = current();
    if (!authorized() || uncertain && !busyMutation()) detach();
    ensureTerminal();
    summary.textContent = '进程控制台' + (jobs.length ? ' · ' + jobs.length : '');
    refresh.disabled = !ready() || [...pending.values()].some(p => p.action === 'list'); select.disabled = !ready();
    stop.disabled = !ready() || !j || j.state !== 'running' || [...pending.values()].some(p => p.action === 'cancel');
    input.disabled = send.disabled = eof.disabled = !writable(); reveal.disabled = input.disabled;
    attach.hidden = interrupt.hidden = !isTerminal(); attach.disabled = !attached && (!authorized() || !userSourceReady || !replayReady || !!uncertain || busyMutation());
    attach.textContent = attached ? '退出输入' : '接入终端'; attach.title = attached ? '退出终端输入' : '接入终端'; attach.setAttribute('aria-label', attach.title);
    interrupt.disabled = !rawAllowed(); eof.title = isTerminal() ? '发送终端 EOF' : '关闭标准输入';
    check.hidden = !uncertain || busyMutation(); check.disabled = !ready() || [...pending.values()].some(p => p.action === 'input_status');
    info.textContent = notice || (!connected() ? '连接电脑后查看进程。' : !capable() ? '这台电脑尚未支持交互进程，请更新被控端。' : !links().goal ? '托管进程属于已授权目标。' : isTerminal() && !terminalCapable() ? '终端能力或本地渲染器不可用，请更新被控端和页面。' : j ? j.state + (j.stdin_closed ? ' · 输入已关闭' : '') + (j.terminal ? attached ? ' · 已接入终端' : replayReady ? ' · 仅观察' : ' · 正在读取终端快照' : '') : '暂无托管进程。');
    explanation.textContent = isTerminal() ? '终端默认仅观察，接入后键盘直接发送。程序可能回显输入；密码是否隐藏由程序的 ECHO 设置决定。' : '管道模式。输入不进入聊天；程序自身可能回显，请留意输出。';
    scroll.title = pause ? '恢复滚动' : '暂停滚动'; scroll.setAttribute('aria-label', scroll.title); scroll.textContent = pause ? '▷' : 'Ⅱ';
    if (terminal) { terminal.options.disableStdin = !rawAllowed(); terminal.options.cursorBlink = attached; }
  }
  function request(action, fields = {}) {
    sync(); if (!ready()) return false;
    const id = 'jc-' + crypto.randomUUID(), p = {id, owner, epoch, action, job: fields.job_id || '', inputID: fields.job_input_id || '', logGeneration, cursor: fields.job_cursor};
    p.timer = setTimeout(() => {
      if (pending.get(id) !== p || p.owner !== key() || p.epoch !== epoch) return;
      pending.delete(id);
      if (mutations.has(action)) { uncertain = {job: p.job, id: p.inputID}; notice = '输入或终端控制结果待核对；不会自动重发。'; detach(); }
      else notice = action === 'cancel' ? '停止结果待确认，请刷新进程。' : '读取超时，请重试查询。';
      render();
    }, 12000);
    pending.set(id, p);
    const frame = {k: 'job-command', command_id: id, goal_id: links().goal.id, session_key: session(), fp: curWS.device_fp, job_action: action, ...fields};
    try { sendSig(frame); } catch (_) { /* Unknown effects: keep ticket until timeout. */ }
    delete frame.job_text; render(); return true;
  }
  function beginMutation(action, fields) {
    if (!authorized() || uncertain || busyMutation()) return false;
    const marker = {job: selected, id: 'ji-' + crypto.randomUUID()}; if (!rememberInput(marker)) { render(); return false; }
    uncertain = marker;
    return request(action, {job_id: selected, job_input_id: marker.id, ...fields});
  }
  function enqueue(action, fields) { if (!rawAllowed()) return; if (mutationQueue.length >= 32) { notice = '终端控制队列已满，本次操作未发送。'; render(); return; } mutationQueue.push({action, fields}); pump(); }
  function pump() {
    if (!rawAllowed() || uncertain || busyMutation() || !mutationQueue.length) return;
    const item = mutationQueue.shift(); if (!beginMutation(item.action, item.fields)) clearUnsent();
  }
  function flushRaw() {
    if (rawTimer !== null) clearTimeout(rawTimer); rawTimer = null;
    if (!rawAllowed()) { rawBuffer = ''; return; }
    let part = '', size = 0; for (const ch of rawBuffer) { const n = bytes(ch); if (size + n > 8192) { mutationQueue.push({action: 'input', fields: {job_text: part}}); part = ''; size = 0; } part += ch; size += n; }
    rawBuffer = ''; if (part) mutationQueue.push({action: 'input', fields: {job_text: part}}); pump();
  }
  function queueRaw(data) {
    if (typeof data !== 'string' || !data || !rawAllowed()) return;
    const queuedBytes = mutationQueue.reduce((n, p) => n + bytes(p.fields.job_text || ''), 0);
    if (bytes(rawBuffer + data) + queuedBytes > 32768) { notice = '终端输入缓冲已满，本次按键未发送；请等待收据。'; render(); return; }
    rawBuffer += data; if (rawTimer === null) rawTimer = setTimeout(flushRaw, 80);
  }
  function load() { if (![...pending.values()].some(p => p.action === 'list')) { lastList = Date.now(); request('list'); } }
  function read() {
    if (!selected) return;
    for (const stream of isTerminal() ? ['stdout'] : ['stdout', 'stderr']) if (![...pending.values()].some(p => p.action === 'log' && p.stream === stream)) {
      if (request('log', {job_id: selected, job_stream: stream, job_cursor: cursors[stream], job_limit: isTerminal() ? 32768 : 8192})) { const p = [...pending.values()].at(-1); p.stream = stream; }
    }
  }
  function choose() { selected = select.value; resetLog(); input.value = ''; input.type = 'password'; notice = uncertain ? '上次输入结果待核对。' : ''; render(); read(); }
  card.addEventListener('toggle', () => { if (card.open) { render(); scheduleFit(); load(); } else { detach(); render(); } });
  select.addEventListener('change', choose); refresh.addEventListener('click', () => { notice = ''; load(); read(); });
  scroll.addEventListener('click', () => { pause = !pause; render(); if (!pause) { if (terminal) terminal.scrollToBottom(); else log.scrollTop = log.scrollHeight; } });
  attach.addEventListener('click', () => { if (attached) detach(); else if (!attach.disabled && terminal) { attached = true; lastResize = ''; render(); fitTerminal(); terminal.focus(); } render(); });
  interrupt.addEventListener('click', () => { flushRaw(); enqueue('signal', {job_signal: 'interrupt'}); });
  reveal.addEventListener('click', () => { input.type = input.type === 'password' ? 'text' : 'password'; reveal.title = input.type === 'password' ? '显示输入' : '隐藏输入'; reveal.setAttribute('aria-label', reveal.title); });
  function write(close) {
    if (!writable() || !close && !input.value) return;
    if (isTerminal()) { if (close) { enqueue('signal', {job_signal: 'eof'}); return; } const text = input.value + '\r'; if (bytes(text) > 8192) { notice = '单次输入最多 8 KiB，请缩短后再发送。'; render(); return; } input.value = ''; input.type = 'password'; enqueue('input', {job_text: text}); return; }
    if (!close && bytes(input.value + '\n') > 8192) { notice = '单次输入最多 8 KiB，请缩短后再发送。'; render(); return; }
    const text = close ? '' : input.value + '\n'; if (beginMutation('input', {job_text: text, job_eof: close})) { input.value = ''; input.type = 'password'; notice = '正在等待进程确认输入…'; }
  }
  form.addEventListener('submit', event => { event.preventDefault(); write(false); }); eof.addEventListener('click', () => write(true));
  stop.addEventListener('click', () => { if (!stop.disabled) { detach(); request('cancel', {job_id: selected}); } });
  check.addEventListener('click', () => { if (uncertain) request('input_status', {job_id: uncertain.job, job_input_id: uncertain.id}); });
  const original = onSig;
  onSig = function(signal) {
    sync(); if (signal && ['paired', 'unpaired', 'pair-fail'].includes(signal.k)) reset();
    const result = original.apply(this, arguments); sync();
    if (signal && signal.k === 'job-command-result') {
      const p = pending.get(signal.command_id);
      if (p && p.owner === key() && p.epoch === epoch && signal.fp === curWS.device_fp && signal.session_key === session() && signal.goal_id === links().goal.id && signal.job_action === p.action && (!p.job || signal.job_id === p.job) && (!p.inputID || signal.job_input_id === p.inputID)) {
        clearTimeout(p.timer); pending.delete(p.id); const data = signal.job_data || {};
        if (signal.err || signal.job_ok !== true) {
          if (mutations.has(p.action)) { uncertain = {job: p.job, id: p.inputID}; detach(); }
          notice = '操作未确认：' + String(signal.err || '未知结果').slice(0, 256);
        } else if (p.action === 'list' && Array.isArray(data.jobs)) {
          jobs = data.jobs.filter(j => j && typeof j.job_id === 'string').slice(0, 32); select.replaceChildren();
          for (const j of jobs) { const o = el('option', '', j.job_id + ' · ' + j.state + (j.terminal ? ' · 终端' : '')); o.value = j.job_id; select.appendChild(o); }
          if (!jobs.some(j => j.job_id === selected)) { selected = jobs[0] && jobs[0].job_id || ''; resetLog(); input.value = ''; }
          select.value = selected; notice = uncertain ? '上次输入或控制结果待核对。' : ''; render(); if (card.open) read();
        } else if (p.action === 'log' && p.job === selected && p.logGeneration === logGeneration && p.cursor === cursors[p.stream] && data.cursor === p.cursor && data.stream === p.stream && Number.isSafeInteger(data.next_cursor) && data.next_cursor >= cursors[p.stream] && typeof data.text === 'string') {
          cursors[p.stream] = data.next_cursor;
          if (isTerminal() && terminal) {
            if (replayTarget === null && Number.isSafeInteger(data.available_bytes) && data.available_bytes >= data.next_cursor) replayTarget = data.available_bytes;
            const target = terminal, generation = logGeneration, viewport = target.buffer.active.viewportY;
            target.write(data.text, () => {
              if (terminal !== target || generation !== logGeneration) return;
              if (pause) target.scrollToLine(viewport);
              if (!replayReady && replayTarget !== null && data.next_cursor >= replayTarget) { replayReady = true; scheduleFit(); }
              render();
              // Drain a finite initial snapshot one parsed chunk at a time;
              // after catching up, observation returns to its quiet polling.
              if (!replayReady && replayTarget !== null && data.next_cursor < replayTarget && card.open && ready() && !document.hidden) read();
            });
          } else { output = (output + (data.text && p.stream === 'stderr' ? '\n[stderr] ' : '') + data.text.slice(0, 32768)).slice(-65536); log.textContent = output; if (!pause) log.scrollTop = log.scrollHeight; }
        } else if (mutations.has(p.action) || p.action === 'input_status') {
          if (data.state === 'written' && !data.effects_unknown) {
            uncertain = null; forgetInput(); const j = jobs.find(j => j.job_id === p.job);
            if (j && !j.terminal && data.eof) j.stdin_closed = true;
            notice = data.kind === 'resize' || p.action === 'resize' ? '' : data.kind === 'signal' || p.action === 'signal' ? '终端按键已发送。' : data.eof ? '标准输入已关闭。' : '已写入进程。';
            render(); pump(); if (isTerminal() && card.open && ready()) read();
          } else { uncertain = {job: p.job, id: p.inputID}; notice = '输入或控制状态：' + String(data.state || 'unknown') + '；仅核对，不自动重发。'; detach(); }
        } else if (p.action === 'cancel') { notice = '停止请求已处理，请以进程状态为准。'; load(); }
      }
    }
    render(); return result;
  };
  if (typeof onFrame === 'function') { const previous = onFrame; onFrame = function() { const result = previous.apply(this, arguments); render(); return result; }; }
  for (const name of ['selectWorkspace', 'selectSession']) {
    const previous = name === 'selectWorkspace' ? selectWorkspace : selectSession;
    const wrapper = function() { reset(); const result = previous.apply(this, arguments); render(); return result; };
    if (name === 'selectWorkspace') selectWorkspace = wrapper; else selectSession = wrapper;
  }
  if (typeof MutationObserver === 'function') new MutationObserver(themeTerminal).observe(document.documentElement, {attributes: true, subtree: true, attributeFilter: ['data-theme']});
  setInterval(() => { sync(); if (!connected()) detach(); render(); if (card.open && ready() && !document.hidden) { if (Date.now() - lastList > 10000) load(); read(); } }, 2000);
  // A live terminal needs prompt echo, while observation retains the quiet poll.
  // read() permits at most one outstanding stdout request, including slow links.
  setInterval(() => { sync(); if (attached && !authorized()) { detach(); render(); } if (rawAllowed() && !document.hidden) read(); }, 150);
  restoreInput(); render();
})();
