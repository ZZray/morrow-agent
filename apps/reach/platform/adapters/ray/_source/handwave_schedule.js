/* One-time cloud appointment to resume an existing authorized paused Goal. */
(() => {
  'use strict';
  const host = document.querySelector('.hw-context-body');
  if (!host || document.documentElement.dataset.hwScheduleReady === '1' || typeof onSig !== 'function' || typeof sendSig !== 'function') return;
  document.documentElement.dataset.hwScheduleReady = '1';
  const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const button = text => { const e = node('button', 'hw-memory-button', text); e.type = 'button'; return e; };
  const identity = () => JSON.stringify([curWS && curWS.id || '', curWS && curWS.device_fp || '', curSess && curSess.id || '']);
  const session = () => curWS && curSess ? curWS.id + '/' + curSess.id : '';
  const bound = () => !!session() && !!(curWS && curWS.device_fp);
  const state = () => window.HandwaveLinks && window.HandwaveLinks.state() || {};
  const now = () => Math.floor(Date.now() / 1000);
  let owner = identity(), epoch = 0, items = null, pending = null, notice = '', draft = null, uncertain = false, hubSupported = null;
  const card = node('details', 'hw-context-card hw-schedule-card'); card.open = false;
  const summary = node('summary', 'hw-context-heading hw-card-summary', '定时任务 · 未加载'); card.appendChild(summary); if (host.insertBefore) host.insertBefore(card, host.children[1] || null); else host.appendChild(card);
  const actions = node('div', 'hw-schedule-actions'); card.appendChild(actions);
  const create = button('预约继续目标'), refresh = button('刷新'); actions.appendChild(create); actions.appendChild(refresh);
  const message = node('p', 'hw-context-hint'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite'); card.appendChild(message);
  const list = node('div', 'hw-schedule-list'); card.appendChild(list);
  card.appendChild(node('p', 'hw-context-hint', '仅一次性继续已暂停目标。到时重验授权与剩余预算；不会配对设备或延长授权。'));
  const dialog = node('dialog', 'hw-schedule-dialog'); dialog.setAttribute('aria-labelledby', 'hwScheduleTitle'); document.body.appendChild(dialog);
  const form = node('form'); dialog.appendChild(form); const title = node('h2', '', '预约继续目标'); title.id = 'hwScheduleTitle'; form.appendChild(title);
  const objective = node('p', 'hw-schedule-objective'); form.appendChild(objective);
  const label = node('label', 'hw-schedule-time', '执行时间'); const date = node('input'); date.type = 'datetime-local'; date.required = true; date.setAttribute('aria-label', '预约执行时间'); label.appendChild(date); form.appendChild(label);
  let zone = '本地时区'; try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || zone; } catch (_) {}
  form.appendChild(node('p', 'hw-context-hint', '时区：' + zone + '。预约必须早于目标授权到期；不是每日重复任务。'));
  const feedback = node('p', 'hw-context-hint'); feedback.setAttribute('role', 'status'); form.appendChild(feedback);
  const dialogActions = node('div', 'hw-schedule-actions'); const close = button('取消'), save = button('保存预约'); save.type = 'submit'; dialogActions.appendChild(close); dialogActions.appendChild(save); form.appendChild(dialogActions);
  const statuses = {scheduled: '已预约', paused: '预约已暂停', canceled: '预约已取消', dispatching: '正在请求电脑继续', triggered: '已继续（目标仍需验收）', failed: '未执行', missed: '已错过，不补跑', unknown: '结果未知，不自动重试'};
  function readyGoal() {
    const s = state(), g = s.goal, l = s.lease;
    return hubSupported === true && bound() && g && l && g.status === 'paused' && g.id === l.goal_id && l.device === curWS.device_fp && l.session === session() && Number.isSafeInteger(g.revision) && g.revision > 0 && typeof s.mirrorEpoch === 'string' && s.mirrorEpoch && Number.isSafeInteger(l.expires_at) && l.expires_at > now() && !s.pendingCommand && !(typeof localBusy !== 'undefined' && localBusy) && typeof paired !== 'undefined' && paired && typeof helloDone !== 'undefined' && helloDone ? s : null;
  }
  function closeDialog() { if (dialog.open) dialog.close(); draft = null; create.focus({preventScroll: true}); }
  function sync() {
    if (owner === identity()) return;
    owner = identity(); epoch++; if (pending) clearTimeout(pending.timer); pending = null; items = null; notice = ''; uncertain = false; closeDialog();
  }
  function render() {
    sync(); list.replaceChildren();
    const rows = items && items.filter(r => r.device === (curWS && curWS.device_fp) && r.session === session());
    summary.textContent = '定时任务 · ' + (rows ? rows.length + ' 项' : '未加载');
    create.disabled = !!pending || uncertain || !readyGoal(); refresh.disabled = !!pending || !bound() || hubSupported !== true; save.disabled = !!pending || uncertain || !draft;
    message.textContent = notice || (hubSupported !== true ? (hubSupported === null ? '正在确认云端预约能力。' : '当前服务未支持预约，请更新云端服务。') : pending ? '正在读取云端收据…' : !bound() ? '请先选择已绑定电脑的会话。' : !readyGoal() ? '当前没有可预约的已授权暂停目标。' : rows && !rows.length ? '暂无预约。' : '预约保存在云端；结果以电脑收据为准。');
    (rows || []).slice(0, 64).forEach(row => {
      const item = node('div', 'hw-schedule-row'); item.appendChild(node('b', '', row.goal_id));
      const when = Number.isSafeInteger(row.due_at) ? new Date(row.due_at * 1000).toLocaleString() : '时间未报告';
      item.appendChild(node('p', '', when + ' · ' + (statuses[row.status] || '未知状态')));
      if (typeof row.reason === 'string') item.appendChild(node('small', '', row.reason.slice(0, 240)));
      const controls = node('div', 'hw-schedule-actions'); item.appendChild(controls);
      if (['scheduled', 'paused'].includes(row.status) && row.due_at > now()) {
        if (row.status === 'scheduled') { const pause = button('暂停预约'); pause.disabled = !!pending; pause.addEventListener('click', () => request('schedule-pause', {id: row.id})); controls.appendChild(pause); }
        if (row.status === 'paused') {
          const resume = button('恢复预约'), current = readyGoal();
          resume.disabled = !!pending || uncertain || !current || current.goal.id !== row.goal_id || current.goal.revision !== row.expected_revision || current.mirrorEpoch !== row.writer_epoch || row.due_at >= current.lease.expires_at;
          resume.title = '沿用原目标与时间；到时仍需重新核验';
          resume.addEventListener('click', () => { const s = readyGoal(); if (!s || resume.disabled) return; request('schedule-save', {id: row.id, device: row.device, goal_id: row.goal_id, session: row.session, expected_revision: row.expected_revision, writer_epoch: row.writer_epoch, due_at: row.due_at}); }); controls.appendChild(resume);
        }
        const cancel = button('取消预约'); cancel.disabled = !!pending; cancel.title = '只取消未来预约，不停止已发出的任务'; cancel.addEventListener('click', () => request('schedule-cancel', {id: row.id})); controls.appendChild(cancel);
      }
      list.appendChild(item);
    });
  }
  function request(kind, value) {
    sync(); if (pending || !bound() || hubSupported !== true) return false;
    const ticket = {id: 'sq-' + crypto.randomUUID(), owner: identity(), epoch, kind};
    pending = ticket; notice = '';
    ticket.timer = setTimeout(() => {
      if (pending !== ticket || ticket.owner !== identity() || ticket.epoch !== epoch) return;
      pending = null; if (kind !== 'schedule-list') uncertain = true; notice = kind === 'schedule-list' ? '未收到云端列表，请刷新。' : '操作结果未知，请刷新核对；不会自动重试。';
      if (draft) feedback.textContent = notice; render();
    }, 12000);
    const sent = sendSig({k: kind, id: ticket.id, ...(value ? {schedule: value} : {})});
    if (!sent) { clearTimeout(ticket.timer); pending = null; notice = '云端连接不可用，请连接后刷新。'; if (draft) feedback.textContent = notice; render(); return false; }
    render(); return true;
  }
  function localDate(seconds) { const d = new Date(seconds * 1000); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
  create.addEventListener('click', () => {
    sync(); const s = readyGoal(); if (!s || pending || uncertain) return;
    draft = {id: 'sch-' + crypto.randomUUID(), owner: identity(), epoch, goal: s.goal.id, revision: s.goal.revision, writer: s.mirrorEpoch, expiry: s.lease.expires_at};
    objective.textContent = s.goal.objective || s.goal.id; date.value = localDate(Math.min(now() + 300, s.lease.expires_at - 60)); date.min = localDate(now() + 60); date.max = localDate(s.lease.expires_at - 1); feedback.textContent = '';
    render(); dialog.showModal(); date.focus();
  });
  form.addEventListener('submit', event => {
    event.preventDefault(); sync(); const s = readyGoal(), d = draft; if (!s || !d || pending || uncertain) return;
    if (d.owner !== identity() || d.epoch !== epoch || d.goal !== s.goal.id || d.revision !== s.goal.revision || d.writer !== s.mirrorEpoch) { feedback.textContent = '目标已变化，请关闭后重新预约。'; return; }
    const due = Math.floor(new Date(date.value).getTime() / 1000);
    if (!Number.isSafeInteger(due) || due <= now() || due >= s.lease.expires_at) { feedback.textContent = '请选择未来时间，且早于当前目标授权到期。'; return; }
    request('schedule-save', {id: d.id, device: curWS.device_fp, goal_id: d.goal, session: session(), expected_revision: d.revision, writer_epoch: d.writer, due_at: due});
  });
  close.addEventListener('click', closeDialog); dialog.addEventListener('cancel', e => { e.preventDefault(); e.stopPropagation(); closeDialog(); });
  dialog.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDialog(); } else if ((e.ctrlKey || e.metaKey) && ['n', '/'].includes(e.key.toLowerCase())) e.stopPropagation(); });
  refresh.addEventListener('click', () => request('schedule-list'));
  card.addEventListener('toggle', () => { if (card.open && items === null && !pending) request('schedule-list'); });
  const oldSig = onSig;
  onSig = function(signal) {
    sync(); const result = oldSig.apply(this, arguments);
    if (signal && signal.k === 'status') hubSupported = Array.isArray(signal.hub_caps) && signal.hub_caps.includes('schedule-resume-v1');
    if (signal && signal.k === 'schedule-result' && pending && signal.id === pending.id && pending.owner === identity() && pending.epoch === epoch) {
      const kind = pending.kind; clearTimeout(pending.timer); pending = null;
      if (signal.err) { if (kind !== 'schedule-list') uncertain = true; notice = '预约操作未确认：' + String(signal.err).slice(0, 240); if (draft) feedback.textContent = notice; }
      else if (signal.schedule && Array.isArray(signal.schedule.items)) { uncertain = false; items = signal.schedule.items.filter(r => r && typeof r.id === 'string').slice(0, 64); notice = ''; if (kind === 'schedule-save') closeDialog(); }
      else { if (kind !== 'schedule-list') uncertain = true; notice = '返回格式异常，请刷新核对。'; }
    }
    if (signal && ['paired', 'unpaired', 'pair-fail'].includes(signal.k)) { epoch++; if (pending) clearTimeout(pending.timer); pending = null; items = null; closeDialog(); }
    render(); return result;
  };
  for (const name of ['selectWorkspace', 'selectSession']) {
    const original = name === 'selectWorkspace' ? selectWorkspace : selectSession;
    const wrapped = function() { const result = original.apply(this, arguments); sync(); render(); return result; };
    if (name === 'selectWorkspace') selectWorkspace = wrapped; else selectSession = wrapped;
  }
  render();
})();
