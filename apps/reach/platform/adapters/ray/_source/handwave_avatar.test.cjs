'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
// Optional fixture dependency; caller supplies an existing linkedom installation.
const {parseHTML} = require(process.env.HW_DOM_MODULE || 'linkedom');
const {document, Event} = parseHTML('<!doctype html><html><head><link rel="icon" href="data:image/svg+xml,old" type="image/svg+xml" sizes="any"><link rel="manifest" href="/unchanged.webmanifest"></head><body><div class="brand"><span class="mark">hw</span>handwave <small>工作台</small></div><span id="accountMark">R</span></body></html>').window;
const context = vm.createContext({document, el(tag, cls, text) {
  const node = document.createElement(tag); node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}});
vm.runInContext(fs.readFileSync(__dirname+'/handwave_avatar.js','utf8').replaceAll('@AVATAR_PATH@','/ray/assets/handwave-ai-d2f42225668b.png'), context);
const brand = document.querySelector('.brand .mark');
assert(brand.classList.contains('hw-brand-mark'));
assert.equal(brand.getAttribute('aria-hidden'),'true');
assert.equal(brand.getAttribute('role'),null);
assert.equal(document.querySelector('.brand small').textContent,'工作台');
assert.equal(document.querySelector('#accountMark').textContent,'R');
assert.equal(brand.querySelector('img').getAttribute('src'),'/ray/assets/handwave-ai-d2f42225668b.png');
assert.equal(document.querySelector('link[rel="icon"]').getAttribute('href'),'/ray/assets/handwave-ai-d2f42225668b.png');
assert.equal(document.querySelector('link[rel="icon"]').getAttribute('type'),'image/png');
assert.equal(document.querySelector('link[rel="icon"]').getAttribute('sizes'),null);
assert.equal(document.querySelector('link[rel="manifest"]').getAttribute('href'),'/unchanged.webmanifest');
context.syncHandWaveBrand();
assert.equal(document.querySelector('.brand .mark'),brand);
brand.querySelector('img').dispatchEvent(new Event('error'));
assert.equal(brand.querySelector('img'),null);
assert.equal(brand.querySelector('.hw-avatar-fallback').hidden,false);
assert.equal(brand.textContent,'hw');
for (const cls of ['msg-ava','msg-ava loading','agent-avatar']) {
  const avatar = context.makeHandWaveAssistantAvatar(cls);
  assert.equal(avatar.className, cls+' hw-assistant-avatar');
  assert.equal(avatar.getAttribute('role'), 'img');
  assert.equal(avatar.getAttribute('aria-label'), '机械姬助手');
  const image = avatar.querySelector('img');
  const fallback = avatar.querySelector('.hw-avatar-fallback');
  assert.equal(image.getAttribute('src'), '/ray/assets/handwave-ai-d2f42225668b.png');
  assert.equal(fallback.textContent,'hw');
  image.dispatchEvent(new Event('load')); assert.equal(fallback.hidden,true);
  if (cls.includes('loading')) { avatar.classList.remove('loading'); assert(avatar.querySelector('img')); }
  const broken = context.makeHandWaveAssistantAvatar(cls);
  broken.querySelector('img').dispatchEvent(new Event('error'));
  assert.equal(broken.querySelector('img'),null);
  assert.equal(broken.querySelector('.hw-avatar-fallback').hidden,false);
}
const empty = parseHTML('<!doctype html><html><body></body></html>').document;
vm.runInNewContext(fs.readFileSync(__dirname+'/handwave_avatar.js','utf8'),{document:empty});
console.log('PASS: brand/favicon identity and idempotence; account preserved; historical, streaming, roster avatars; accessibility, load/error fallback and loading removal');
