/* Explicit target selection reuses an existing approval; it never creates one. */
(() => {
  'use strict';
  if (window.HandwaveMachineTarget || typeof sendSig !== 'function' || typeof onSig !== 'function' || typeof onFrame !== 'function') return;
  const oldSig = onSig, oldSend = sendSig, oldFrame = onFrame;
  const oldConnectionState = typeof setConnState === 'function' ? setConnState : null;
  const identity = () => JSON.stringify([curWS && curWS.id || '', curSess && curSess.id || '', typeof myFP === 'string' ? myFP : '']);
  const busy = () => typeof localBusy !== 'undefined' && localBusy || typeof sending !== 'undefined' && sending;
  const status = text => { const e = document.querySelector('.hw-links-status'); if (e) e.textContent = text; };
  let hubCaps = [], pending = null, abandoned = false, seenFP = '', seenName = '', verifiedTarget = null;
  function header(text, kind, description) {
    if (oldConnectionState) oldConnectionState(text, kind);
    const e = typeof document.getElementById === 'function' ? document.getElementById('connState') : null;
    if (e) { e.title = description || text; e.setAttribute('aria-label', description || text); }
  }
  function connecting(p) { header('正在接入 · ' + p.name, 'busy', '正在确认执行目标：' + p.name + ' · ' + p.fp); }
  function targetHeader() {
    if (!verifiedTarget) return;
    if (!curWS || verifiedTarget.workspace !== curWS.id || verifiedTarget.fp !== curWS.device_fp || !paired || !helloDone) { verifiedTarget = null; header('目标未连接', 'off', '当前工作区尚未确认执行目标'); return; }
    header('目标 · ' + verifiedTarget.name, 'on', '执行目标：' + verifiedTarget.name + ' · ' + verifiedTarget.fp);
  }
  if (oldConnectionState) setConnState = function(text, kind) {
    if (pending) { connecting(pending); return; }
    if (kind !== 'on' || !paired || !helloDone) verifiedTarget = null;
    if (verifiedTarget) targetHeader(); else header(text, kind, text);
  };
  function valid(p) { return pending === p && p.owner === identity() && curWS && (curWS.device_fp === p.previousFP || curWS.device_fp === p.fp); }
  function cleanup() { if (pending) clearTimeout(pending.timer); pending = null; }
  // Transport loss invalidates this handshake only. Never send on a replacement
  // socket, cancel native work, change the selected device or renew its grant.
  window.HandwaveMachineTransportLost = function() {
    cleanup(); verifiedTarget = null; abandoned = false; seenFP = ''; seenName = ''; hubCaps = [];
    header('目标未连接', 'off', '连接中断，执行目标等待重新核验');
  };
  function fail(text, disconnect = true) {
    if (!pending) return; cleanup(); abandoned = true; verifiedTarget = null;
    if (disconnect) oldSend({k: 'bye'});
    paired = false; helloDone = false; if (typeof closePC === 'function') closePC();
    header('目标未连接', 'off', '执行目标未连接：' + text);
    status(text + '；任务未发送。可从工具与连接重新接入。');
  }
  function finish() {
    const p = pending; if (!p || !valid(p)) { if (p) fail('工作区或会话已变化，已取消机器切换'); return; }
    if (!p.accepted || !p.hello || !paired || !helloDone) return;
    if (curWS.device_fp !== p.fp) { status('机器握手完成，正在确认工作区绑定…'); return; }
    const name = p.helloName || p.name; verifiedTarget = {fp: p.fp, name, workspace: curWS.id}; cleanup(); abandoned = false; targetHeader(); status('已接入 ' + name + '；发送新任务将在这台机器执行。');
  }
  window.HandwaveMachineTarget = function(selected) {
    if (pending) { status('机器正在连接，请等待当前握手结束。'); return false; }
    if (busy()) { status('当前任务运行中，结束后再切换机器。'); return false; }
    if (!hubCaps.includes('connect-approved-v1')) { status('当前 Hub 尚未支持保留授权的机器切换，请从工具与连接接入。'); return false; }
    if (!curWS || !curWS.id || typeof myFP !== 'string' || !myFP) { status('请先选择工作区并连接操作端。'); return false; }
    const d = (typeof devices !== 'undefined' && Array.isArray(devices) ? devices : []).find(x => selected && x.fp === selected.fp && x.nid === selected.nid);
    if (!d || !d.nid || !['approved', 'paired'].includes(d.state) || !(d.by === myFP || d.mine === true && !d.by)) { status('只能接入当前操作端已授权且在线的机器；请先在设备管理核对授权。'); return false; }
    if (d.exp && (!Number.isFinite(Date.parse(d.exp)) || Date.parse(d.exp) <= Date.now())) { status('这台机器的授权已过期，请在设备管理明确重新授权。'); return false; }
    const sameTarget = paired && helloDone && seenFP === d.fp && curWS.device_fp === d.fp;
    const p = {owner: identity(), previousFP: curWS.device_fp || '', fp: d.fp, nid: d.nid, id: typeof newToolId === 'function' ? newToolId() : crypto.randomUUID(), name: String(d.name || d.hostname || d.fp).slice(0, 160), accepted: false, hello: sameTarget, helloName: sameTarget ? seenName : '', pairSeen: sameTarget, disconnectSent: !!paired && !sameTarget};
    pending = p; abandoned = false; verifiedTarget = null;
    p.timer = setTimeout(() => { if (pending === p) fail('机器连接超时，未确认接入结果'); }, 15000);
    status('正在接入 ' + p.name + '…');
    connecting(p);
    if (paired && !sameTarget && !oldSend({k: 'bye'})) { fail('原连接无法断开', false); return false; }
    if (!sameTarget) { paired = false; helloDone = false; if (typeof closePC === 'function') closePC(); }
    if (!oldSend({k: 'connect-approved', id: p.id, nid: p.nid, fp: p.fp, relay: true})) { fail('Hub 连接不可用', false); return false; }
    return true;
  };
  onSig = function(signal) {
    if (signal && signal.k === 'status') hubCaps = Array.isArray(signal.hub_caps) ? signal.hub_caps : [];
    const p = pending;
    if (p && !valid(p)) { fail('工作区或会话已变化，已取消机器切换'); return; }
    if (signal && signal.k === 'connect-approved-result') {
      if (!p || signal.id !== p.id || signal.nid !== p.nid) return;
      if (signal.fp !== p.fp || !['connected', 'already-connected'].includes(signal.msg) || signal.err) { fail(signal.err ? String(signal.err).slice(0, 160) : '机器未获准接入'); return; }
      p.accepted = true; finish(); return;
    }
    if (p && signal && signal.k === 'paired') p.pairSeen = true;
    if (p && signal && signal.k === 'unpaired') {
      if (p.disconnectSent && !p.pairSeen) p.disconnectSent = false;
      else { fail('机器连接已结束', false); return; }
    }
    if (p && signal && signal.k === 'pair-fail') { fail('机器配对失败'); return; }
    if (abandoned && signal && signal.k === 'paired') { oldSend({k: 'bye'}); return; }
    const result = oldSig.apply(this, arguments); finish(); return result;
  };
  onFrame = function(frame) {
    if (frame && frame.k === 'node-hello') {
      const p = pending;
      if (abandoned) { oldSend({k: 'bye'}); return; }
      if (p && (!valid(p) || frame.fp !== p.fp)) { fail('机器握手身份不匹配，已取消接入'); return; }
      seenFP = frame.fp || ''; seenName = String(frame.info && frame.info.hostname || p && p.name || seenFP).slice(0, 160); if (p) { p.hello = true; p.helloName = seenName; }
    }
    const result = oldFrame.apply(this, arguments); finish(); if (pending) connecting(pending); return result;
  };
  sendSig = function(signal) {
    // A distinct explicit action supersedes the pending target. Never infer an
    // approval from a mention; the old approval button remains its own owner.
    if (pending && signal && ['bye', 'approve', 'hello'].includes(signal.k)) fail('机器选择已被新的连接操作取消', false);
    if (signal && ['bye', 'hello'].includes(signal.k)) { verifiedTarget = null; header(signal.k === 'hello' ? '正在连接 Hub' : '目标未连接', signal.k === 'hello' ? 'busy' : 'off', '尚未确认执行目标'); }
    if (signal && ['approve', 'hello'].includes(signal.k)) abandoned = false;
    return oldSend.apply(this, arguments);
  };
  for (const key of ['selectSession', 'selectWorkspace']) {
    const original = key === 'selectSession' ? selectSession : selectWorkspace;
    const wrapped = function() { const result = original.apply(this, arguments); if (pending && !valid(pending)) fail('工作区或会话已变化，已取消机器切换'); else targetHeader(); return result; };
    if (key === 'selectSession') selectSession = wrapped; else selectWorkspace = wrapped;
  }
  if (typeof syncRailDeviceLabels === 'function') { const original = syncRailDeviceLabels; syncRailDeviceLabels = function() { const result = original.apply(this, arguments); finish(); return result; }; }
})();
