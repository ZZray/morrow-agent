'use strict';
// 旧 ID-less paused 队列的查看与显式处置（agent-queue-recovery 帧）。
//
// 这些条目没有投递标识、无法证明是否已经执行，所以本机绝不自动重放。这里只做三件事：
//   - list：向已配对的 node 取当前预览（稳定条目 ID / 来源 / 原文 / 原类别是否已知）；
//   - requeue：由操作者**显式**选择 steer 或 follow_up，把这一条变成带投递标识的待投递项；
//   - discard：明确放弃这一条（本机保留处置审计，旧文件与备份不改）。
//
// 只发帧、只读回帧：不新增 HTTP 监听，也不改 Hub 配置；用户文本一律走 textContent。
// app.js 只挂钩两处（另有 index.html 的按钮与容器）：
//   - onFrame 的 `f.k === 'out'` 分支里调用 NodeQueueRecovery.handleOut(f)；
//   - bindLocalAgent 里把 #agentQueueBtn 接到 NodeQueueRecovery.open()。

// queueEntryPlan 决定一条预览条目在界面上怎么显示、能做什么。原类别未知时也必须由操作者
// 显式选择（给出两个选项），绝不预选、绝不默认猜 follow_up。
function queueEntryPlan(entry) {
  const e = entry || {};
  const kind = e.kind || '';
  const known = !!e.kind_known;
  let kindLabel = kind;
  if (!known) kindLabel = '类别未知';
  else if (kind === 'steer') kindLabel = '转向';
  else if (kind === 'follow_up') kindLabel = '稍后';
  return {
    kindLabel: kindLabel,
    known: known,
    actions: [
      { action: 'requeue', kind: 'steer', label: '重排队（转向）' },
      { action: 'requeue', kind: 'follow_up', label: '重排队（稍后）' },
      { action: 'discard', kind: '', label: '放弃' },
    ],
  };
}

// queueAuditLine 把一条处置审计渲染成一行中文说明（只读，来自本机状态文件）。
function queueAuditLine(rec) {
  const r = rec || {};
  const who = r.controller || '未署名控制端';
  const when = r.at || '';
  if (r.action === 'requeue') {
    const kind = r.kind === 'follow_up' ? '稍后' : r.kind === 'steer' ? '转向' : (r.kind || '未知');
    return when + ' ' + who + ' 重排队为' + kind + '（投递标识 ' + (r.delivery_id || '无') + '）';
  }
  if (r.action === 'discard') return when + ' ' + who + ' 放弃这一条';
  return when + ' ' + who + ' ' + (r.action || '未知操作');
}

// decodeB64Payload 把 out 帧的 base64 负载解成字符串。app.js 的 b64dec 返回的是
// **Uint8Array**，所以必须先按 UTF-8 解码再 JSON.parse——直接 JSON.parse(Uint8Array)
// 对任何正常回包都会失败（中文回包更是如此）。
function decodeB64Payload(b64) {
  const bytes = b64dec(b64 || '');
  if (typeof dec !== 'undefined' && dec) return dec.decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

(function () {
  const PREFIX = 'queue-';
  // REPLY_TIMEOUT_MS 是等待本机回包的上界：断线或丢帧时面板绝不能永远锁住。
  // fixture 可以用 window.NodeQueueRecoveryReplyTimeoutMs 覆盖它。
  const override = Number(window.NodeQueueRecoveryReplyTimeoutMs);
  const REPLY_TIMEOUT_MS = override > 0 ? override : 15000;
  let seq = 0;
  let inflight = null;
  let preview = null;
  let status = '';
  let statusKind = '';

  function panel() { return document.getElementById('agentQueuePanel'); }

  function note(text, kind) { status = text || ''; statusKind = kind || ''; }

  function clearInflight() {
    if (inflight && inflight.timer) clearTimeout(inflight.timer);
    inflight = null;
  }

  // send 只在没有请求在途时发帧：重复点击直接忽略，绝不并发发第二次。
  function send(action, extra) {
    if (inflight) return false;
    if (action !== 'list' && !preview) return false;
    const id = PREFIX + (++seq);
    const frame = Object.assign({ k: 'agent-queue-recovery', id: id, msg: action }, extra || {});
    if (!sendFrame(frame)) {
      note('未接入本机：先完成配对再处置。', 'bad');
      render();
      return false;
    }
    inflight = { id: id, action: action };
    inflight.timer = setTimeout(() => {
      // 有界超时：只清在途状态并提示刷新重试，**绝不自动重发处置**（重放处置必须由
      // 操作者重新确认，更不能猜这一条现在是什么状态）。
      if (!inflight || inflight.id !== id) return;
      const timedOut = inflight.action;
      clearInflight();
      note(timedOut === 'list'
        ? '没有收到本机回包，请刷新重试。'
        : '没有收到本机回包：这一条的状态未知，请刷新后重新确认。', 'bad');
      render();
    }, REPLY_TIMEOUT_MS);
    note(action === 'list' ? '读取本机预览…' : '正在处理…', 'busy');
    render();
    return true;
  }

  function handleOut(f) {
    if (!f || !f.id || String(f.id).indexOf(PREFIX) !== 0 || !f.done) return false;
    // 只认当前在途请求的 id：超时之后才到的旧回包、以及被新请求顶掉的旧回包，
    // 一律忽略（绝不覆盖新请求的预览，也绝不假装处置成功）。
    if (!inflight || inflight.id !== f.id) return false;
    const action = inflight.action;
    clearInflight();
    if (f.err) {
      note('失败：' + f.err, 'bad');
      render();
      return true;
    }
    let payload = null;
    try { payload = JSON.parse(decodeB64Payload(f.b64)); } catch (_) { payload = null; }
    if (!payload || typeof payload !== 'object') {
      note('失败：本机返回的预览无法解析。', 'bad');
      render();
      return true;
    }
    preview = payload;
    if (action === 'list') {
      if (payload.blocked) note('本机状态被阻断，只读：' + payload.blocked, 'bad');
      else if (!(payload.entries || []).length) note('没有需要处置的旧队列条目。', '');
      else note('', '');
    } else if (action === 'requeue') {
      note('已重排队：这一条现在是带投递标识的待投递项（' + (payload.delivery || '无标识') +
        '）。是否真的执行取决于当前回合的投递模式，请到任务板与事件流里核对。', 'ok');
    } else {
      note('已放弃这一条：本机保留处置审计，旧文件与备份未改。', 'ok');
    }
    render();
    return true;
  }

  function render() {
    const box = panel();
    if (!box) return;
    box.textContent = '';
    const head = el('div', 'agent-queue-head');
    head.appendChild(el('b', '', '旧队列处置'));
    const refresh = el('button', 'agent-queue-refresh', '刷新');
    refresh.type = 'button';
    refresh.disabled = !!inflight;
    refresh.onclick = () => send('list');
    head.appendChild(refresh);
    const close = el('button', 'agent-queue-close', '收起');
    close.type = 'button';
    close.onclick = () => box.classList.add('hide');
    head.appendChild(close);
    box.appendChild(head);

    box.appendChild(el('p', 'agent-queue-hint',
      '这些旧条目没有投递标识，本机不会自动执行。重排队会把这一条变成带投递标识的待投递项：' +
      '是否真的执行取决于当前回合的投递模式（等工具结束 / 立即），请到任务板与事件流里核对；' +
      '放弃只是不再尝试投递，本机旧文件与备份不改。'));

    if (status) box.appendChild(el('p', 'agent-queue-status ' + statusKind, status));
    if (!preview) return;

    const entries = preview.entries || [];
    if (!entries.length) box.appendChild(el('p', 'agent-queue-empty', '没有 paused 条目。'));
    entries.forEach((entry) => {
      const plan = queueEntryPlan(entry);
      const row = el('div', 'agent-queue-row');
      const meta = el('div', 'agent-queue-meta');
      meta.appendChild(el('b', 'agent-queue-kind' + (plan.known ? '' : ' unknown'), plan.kindLabel));
      meta.appendChild(el('em', 'agent-queue-source', entry.source || '来源未知'));
      row.appendChild(meta);
      row.appendChild(el('p', 'agent-queue-text', entry.text || ''));
      const acts = el('div', 'agent-queue-actions');
      plan.actions.forEach((a) => {
        const b = el('button', 'agent-queue-act', a.label);
        b.type = 'button';
        b.disabled = !!inflight || !!preview.blocked || !!preview.busy;
        b.onclick = () => send(a.action, { entry: entry.id, kind: a.kind, rev: preview.revision });
        acts.appendChild(b);
      });
      row.appendChild(acts);
      box.appendChild(row);
    });

    const audit = preview.audit || [];
    if (audit.length) {
      const list = el('div', 'agent-queue-audit');
      list.appendChild(el('b', '', '最近处置'));
      audit.slice().reverse().forEach((rec) => list.appendChild(el('p', '', queueAuditLine(rec))));
      box.appendChild(list);
    }
  }

  function open() {
    const box = panel();
    if (!box) return;
    box.classList.remove('hide');
    if (!preview) send('list');
    else render();
  }

  window.NodeQueueRecovery = { open: open, handleOut: handleOut, replyTimeoutMs: REPLY_TIMEOUT_MS };
})();
