'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadAction() {
  const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const start = src.indexOf('function localComposerAction');
  const end = src.indexOf('function noteSession');
  assert.ok(start >= 0 && end > start);
  const ctx = vm.createContext({});
  vm.runInContext(src.slice(start, end), ctx);
  return ctx.localComposerAction;
}

test('local composer queues a follow-up while a run is busy', () => {
  const action = loadAction();
  assert.equal(action({ localMode: true, sending: true, localBusy: true, text: 'next' }), 'follow');
  assert.equal(action({ localMode: true, sending: false, localBusy: false, text: 'go' }), 'start');
  assert.equal(action({ localMode: true, sending: false, localBusy: false, text: '' }), 'need-text');
  assert.equal(action({ localMode: false, sending: true, localBusy: false, text: 'x' }), 'ignore');
  assert.equal(action({ localMode: false, sending: false, localBusy: false, text: '' }), 'cloud');
});

test('workbench exposes bash start and interrupt controls', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(html, /id="agentBashBtn"/);
  assert.match(html, /id="agentInterruptBtn"/);
  assert.match(html, /id="btnLocalMode"/);
  assert.match(html, /id="agentAsk"/);
  assert.match(html, /id="agentTasks"/);
});

test('local event handler prefers step_id for task board rows', () => {
  const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.match(src, /const id = evt\.step_id \|\| evt\.title \|\| 'task'/);
  assert.match(src, /localTasks\.clear\(\)/);
});
