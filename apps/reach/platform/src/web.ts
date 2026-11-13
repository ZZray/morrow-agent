// Copyright (c) Ray Zhang. Optional static assets; source and state are never served.
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
const assets = new Map([
  ['/desk/', {path:new URL('../web/index.html',import.meta.url),type:'text/html; charset=utf-8'}],
  ['/desk/assets/desk.css', {path:new URL('../web/desk.css',import.meta.url),type:'text/css; charset=utf-8'}],
  ['/desk/assets/desk.js', {path:new URL('../dist/desk.js',import.meta.url),type:'text/javascript; charset=utf-8'}],
  ['/desk/assets/settlement.js', {path:new URL('../dist/settlement.js',import.meta.url),type:'text/javascript; charset=utf-8'}],
  ['/desk/assets/images.js', {path:new URL('../dist/images.js',import.meta.url),type:'text/javascript; charset=utf-8'}],
]);
export async function serveDesk(route:string,method:string,response:ServerResponse,rayLogin:boolean){
  if(!['GET','HEAD'].includes(method))return false;
  if(route==='/desk'){response.writeHead(308,{location:'desk/','cache-control':'no-store'});response.end();return true;}
  const asset=assets.get(route);if(!asset)return false;
  let content:Buffer;
  try{content=await readFile(asset.path);}catch{response.writeHead(503,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});response.end(method==='HEAD'?undefined:'Reach Desk 页面尚未构建。');return true;}
  if(route==='/desk/'&&rayLogin)content=Buffer.from(content.toString('utf8').replace('name="reach-login-provider" content="local"','name="reach-login-provider" content="ray"'));
  response.writeHead(200,{'content-type':asset.type,'content-length':content.length,'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"});
  response.end(method==='HEAD'?undefined:content);return true;
}
