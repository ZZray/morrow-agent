'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const [renderPath, appPath, browserPath] = process.argv.slice(2);
const renderer = fs.readFileSync(renderPath, 'utf8').split('document.addEventListener')[0];
const app = fs.readFileSync(appPath, 'utf8');
function extract(start) { const at = app.indexOf(start); assert.ok(at >= 0); return app.slice(at, app.indexOf('\n}', at) + 2); }
const helpers = extract('function escHtml(s) {') + '\n' + extract("function showToast(message, type = 'info', duration = 4000) {");
const children = [];
function element(tag) { return {tag, style: {}, children: [], appendChild(child) { this.children.push(child); }, set innerHTML(_) { throw new Error('text notification reached an HTML sink'); }}; }
const ctx = vm.createContext({document: {createElement: element, body: {appendChild(child) { children.push(child); }}}, setTimeout() {}});
vm.runInContext(renderer + '\n' + helpers, ctx);
const language = '```x" onclick="window.__security_fixture=1\nhello\n```';
const body = '```text\n// example.txt\n" onclick="window.__security_fixture=2\n```';
const hostname = '<img src=x onerror="window.__security_fixture=3">';
const render = value => vm.runInContext('mdRender(' + JSON.stringify(value) + ')', ctx);
assert.ok(render(language).includes('data-lang="x&quot; onclick=&quot;window.__security_fixture=1"'));
assert.ok(render(body).includes('data-content="// example.txt\n&quot; onclick=&quot;window.__security_fixture=2"'));
vm.runInContext('showToast(' + JSON.stringify(hostname) + ')', ctx);
assert.equal(children.length, 1); assert.equal(children[0].children[1].textContent, hostname);
assert.equal(children[0].children[0].tag, 'span');
assert.ok(render('**bold** [example](https://example.com)').includes('<strong>bold</strong>'));
assert.ok(render('```text\n// example.txt\nconst s = "quoted";\n```').includes('const s = &quot;quoted&quot;;'));
console.log('PASS 5 security regressions: fence, body attributes, hostname text, markdown, quoted code');
const labels = new Map(['myfp', 'accountMenuFp', 'accountAva', 'accountMenuAva'].map(id => [id, {textContent: ''}]));
const identity = vm.createContext({$: id => labels.get(id)});
vm.runInContext('let myFP = "OLD";\n' + extract('function onSig(s) {'), identity);
vm.runInContext('onSig({k:"controller-identity",fp:"ABCDEFGHIJKLMNOP234567ABCDEFGHIJKLMNOP234567ABCDEFGH"});', identity);
assert.equal(labels.get('myfp').textContent, 'ABCDEFGHIJKLMNOP234567ABCDEFGHIJKLMNOP234567ABCDEFGH');
assert.equal(labels.get('accountAva').textContent, 'AB');
vm.runInContext('onSig({k:"controller-identity",fp:"<img src=x onerror=bad>"});', identity);
assert.equal(labels.get('myfp').textContent, 'ABCDEFGHIJKLMNOP234567ABCDEFGHIJKLMNOP234567ABCDEFGH');
console.log('PASS controller identity display accepts authenticated Hub label and rejects markup');
if (browserPath) {
  const script = renderer + '\n' + helpers + '\n' + `
window.__security_fixture = 0;
document.querySelector('#language').innerHTML = mdRender(${JSON.stringify(language)});
document.querySelector('#body').innerHTML = mdRender(${JSON.stringify(body)});
showToast(${JSON.stringify(hostname)}, 'info', 600000);
setTimeout(() => {
  const pre = document.querySelector('#language pre');
  const apply = document.querySelector('#body .code-apply');
  pre.click(); apply.click();
  const unsafe = document.querySelector('[onclick],[onerror],img');
  const source = '// example.txt\\n" onclick="window.__security_fixture=2';
  const ok = window.__security_fixture === 0 && !unsafe && pre.dataset.lang === 'x" onclick="window.__security_fixture=1' && apply.dataset.content === source;
  const result = {ok, marker: window.__security_fixture, unsafeElements: !!unsafe, language: pre.dataset.lang, code: apply.dataset.content, toastText: document.body.lastElementChild.textContent};
  document.querySelector('#result').textContent = JSON.stringify(result, null, 2);
  document.title = ok ? 'PASS - HandWave isolated DOM security' : 'FAIL - HandWave isolated DOM security';
}, 300);`;
  fs.writeFileSync(browserPath, '<!doctype html><meta charset="utf-8"><title>HandWave security fixture</title><h1>Isolated DOM security regression</h1><div id="language"></div><div id="body"></div><pre id="result">Running...</pre><script>' + script.replace(/<\/script/gi, '<\\/script') + '</script>');
}
