'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function classes() {
  const set = new Set();
  return { add: (...xs) => xs.forEach((x) => set.add(x)), remove: (...xs) => xs.forEach((x) => set.delete(x)), toggle: (x, on) => on === undefined ? (set.has(x) ? (set.delete(x), false) : (set.add(x), true)) : (on ? (set.add(x), true) : (set.delete(x), false)), contains: (x) => set.has(x) };
}

function element(tag = 'div', cls = '', text = '') {
  const node = {
    tagName: tag.toUpperCase(), className: cls, textContent: text, children: [], attrs: {}, classList: classes(),
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(k, v) { this.attrs[k] = v; },
    get innerHTML() { return this._innerHTML || ''; },
    set innerHTML(value) { this._innerHTML = value; if (value === '') this.children = []; },
  };
  for (const c of cls.split(/\s+/).filter(Boolean)) node.classList.add(c);
  return node;
}

function harness() {
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const start = source.indexOf('const AGENT_STATUS');
  const end = source.indexOf('function addBubble', start);
  // renderAgentDock 依赖同文件里的 helper；按真实函数名单独取片段，保持 production 不变。
  const helpers = [
    ['function formatElapsed(ms) {', '\nfunction agentEventLabel('],
    ['function liveDockMeta() {', '\nfunction startLocalTick('],
  ];
  const timers = [];
  const ctx = vm.createContext({
    $, el: (tag, cls, text) => element(tag, cls, text),
    Date, Map, Array, Math, String, RegExp,
    setInterval(fn) { timers.push(fn); return 1; },
    agentRun: { turnID: '', startedAt: Date.now(), endedAt: 0, agents: new Map(), events: [], expanded: true, timeline: false, timelineAgent: '' },
  });
  vm.runInContext(source.slice(start, end), ctx);
  for (const [from, to] of helpers) {
    const a = source.indexOf(from);
    const b = source.indexOf(to, a);
    assert.ok(a >= 0 && b > a, 'helper not found in app.js: ' + from);
    vm.runInContext(source.slice(a, b), ctx);
  }
  ctx.localPhase = ''; // app.js 里的 let localPhase 在切片外，按空相位处理
  return { ctx, $, timers };
}

test('agent dock merges lifecycle events into a character roster', () => {
  const { ctx, $ } = harness();
  ctx.resetAgentRun('turn-1');
  ctx.recordAgentEvent({ type: 'agent_start', status: 'running', agent_id: 'a1', agent_name: 'Researcher', agent_role: 'researcher', title: 'Inspect code' });
  ctx.recordAgentEvent({ type: 'agent_finish', status: 'completed', agent_id: 'a1', agent_name: 'Researcher', agent_role: 'researcher', title: 'Inspection complete' });
  const agent = ctx.agentRun.agents.get('a1');
  assert.equal(agent.name, 'Researcher');
  assert.equal(agent.role, 'researcher');
  assert.equal(agent.status, 'completed');
  assert.equal($('agentDockProgress').textContent, '1/1');
  assert.equal($('agentRoster').children.length, 1);
  assert.equal($('agentDock').classList.contains('hide'), false);
});

test('agent timeline remains filtered to the selected character', () => {
  const { ctx, $ } = harness();
  ctx.recordAgentEvent({ type: 'step_start', status: 'running', agent_id: 'a1', agent_name: 'Builder', title: 'Build' });
  ctx.recordAgentEvent({ type: 'step_start', status: 'running', agent_id: 'a2', agent_name: 'Reviewer', title: 'Review' });
  ctx.renderAgentTimeline('a2');
  const rendered = JSON.stringify($('agentTimeline').children);
  assert.match(rendered, /Review/);
  assert.doesNotMatch(rendered, /Build/);
});
