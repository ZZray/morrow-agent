const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, 'handwave_motion.js'), 'utf8');
const listeners = new Map();
const observers = [];
const menu = {classList:{contains:()=>false},style:{left:'200px',top:'100px'},offsetWidth:300,offsetHeight:80};
const trigger = {getBoundingClientRect:()=>({left:250,top:200,width:40})};
const document = {documentElement:{dataset:{}},addEventListener:(type,fn,opts)=>{
  assert.equal(opts.capture,true);assert.equal(opts.passive,true);listeners.set(type,fn);
},getElementById:id=>id==='modelMenu'?menu:id==='modelTrigger'?trigger:null};
const context = vm.createContext({document, MutationObserver:class{constructor(fn){observers.push(fn)}observe(node,opts){assert.equal(node,menu);assert.deepEqual([...opts.attributeFilter],['class'])}}});
vm.runInContext(script,context);
assert.equal(document.documentElement.dataset.hwMotion,'keyboard');
listeners.get('pointerdown')({pointerType:'mouse'});
assert.equal(document.documentElement.dataset.hwMotion,'pointer');
listeners.get('keydown')({key:'Escape'});
assert.equal(document.documentElement.dataset.hwMotion,'keyboard');
listeners.get('pointerdown')({pointerType:'touch'});
assert.equal(document.documentElement.dataset.hwMotion,'touch');
observers[0]();assert.equal(menu.style.transformOrigin,'70px 80px');
menu.style.top='300px';observers[0]();assert.equal(menu.style.transformOrigin,'70px 0px');
menu.style.left='bad';observers[0]();assert.equal(menu.style.transformOrigin,'70px 0px');
vm.runInContext(script,context);assert.equal(observers.length,1);
// Go's real adaptHandWaveUI tests assert exactly one copy of every embedded
// JS/CSS module and the complete-response CSS gate. This VM checks behavior
// without depending on a separately modified legacy owner application.
console.log('PASS: input modality, anchor origin, missing/invalid nodes, idempotence; no application callbacks');
