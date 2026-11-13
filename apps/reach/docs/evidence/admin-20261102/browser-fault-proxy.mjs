// Disposable loopback fault proxy for browser acceptance. No production use.
import { createServer } from 'node:http';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve('work/admin-browser');
const flag = name => resolve(root, name);
const take = name => { if (!existsSync(flag(name))) return false; unlinkSync(flag(name)); return true; };
const server = createServer(async (req, res) => {
  const headers = {...req.headers, host: '127.0.0.1:18911'};
  if (headers.origin === 'http://127.0.0.1:18912') headers.origin = 'http://127.0.0.1:18911';
  delete headers['content-length']; delete headers.connection;
  const chunks=[]; for await (const c of req) chunks.push(c);
  if (req.url === '/api/v1/overview' && take('fail-overview-once')) {
    res.writeHead(503, {'content-type':'application/json'}); res.end(JSON.stringify({error:{message:'受控概览故障'}})); return;
  }
  try {
    const response=await fetch('http://127.0.0.1:18911'+req.url,{method:req.method,headers,redirect:'manual',body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)});
    const body=Buffer.from(await response.arrayBuffer());
    if (req.url === '/api/v1/overview' && take('hold-overview-once')) {
      writeFileSync(flag('overview-held'),'held');
      await new Promise(resolveHold=>{ const timer=setInterval(()=>{if(take('release-overview')){clearInterval(timer);resolveHold();}},20);res.on('close',()=>{clearInterval(timer);resolveHold();});});
    }
    if(res.destroyed)return;
    const output=Object.fromEntries(response.headers); delete output['transfer-encoding']; delete output['content-encoding']; output['content-length']=String(body.length);
    res.writeHead(response.status,output);res.end(body);
  } catch {if(!res.destroyed){res.writeHead(502);res.end();}}
});
server.listen(18912,'127.0.0.1',()=>console.log('Disposable browser fault proxy on 127.0.0.1:18912'));
