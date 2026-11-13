'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness(width) {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {
        inert: false, attrs: {},
        classList: { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)), contains: x => classes.has(x) },
        setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; },
        focus() { this.focused = true; },
      });
    }
    return nodes.get(id);
  }
  const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const ctx = vm.createContext({
    $: node, window: { innerWidth: width },
    document: { body: node('body'), activeElement: node('trigger'), querySelector: () => node('chat') },
    closeAttachMenu() {}, closeModelMenu() {}, closeAccountMenu() {},
  });
  vm.runInContext(source.slice(source.indexOf('let sheetReturnFocus'), source.indexOf('function bindSheetSwipe')), ctx);
  return { ctx, node };
}

test('tool drawer opens accessibly and closes without leaving chat inert', () => {
  for (const width of [390, 1280, 1920]) {
    const { ctx, node } = harness(width);
    ctx.openSheet('aside');
    assert.equal(node('asidePanel').inert, false);
    assert.equal(node('asidePanel').attrs['aria-modal'], 'true');
    assert.equal(node('railPanel').inert, true);
    assert.equal(node('chat').inert, true);
    ctx.closeSheets();
    assert.equal(node('asidePanel').inert, true);
    assert.equal(node('chat').inert, false);
    assert.equal(node('btnOpenAside').attrs['aria-expanded'], 'false');
    assert.equal(node('sheetScrim').classList.contains('hide'), true);
    assert.equal(node('trigger').focused, true);
  }
});

test('mobile navigation and desktop collapsed navigation use matching focus state', () => {
  const mobile = harness(390);
  mobile.ctx.openSheet('rail');
  assert.equal(mobile.node('railPanel').inert, false);
  mobile.ctx.closeSheets();
  assert.equal(mobile.node('railPanel').inert, true);
  const desktop = harness(1280);
  desktop.node('body').classList.add('rail-collapsed');
  desktop.ctx.syncRailToggle();
  assert.equal(desktop.node('railPanel').inert, true);
  desktop.node('body').classList.remove('rail-collapsed');
  desktop.ctx.syncRailToggle();
  assert.equal(desktop.node('btnOpenRail').attrs['aria-expanded'], 'true');
});
