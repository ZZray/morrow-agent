// Copyright (c) Ray Zhang. Reach network boundary.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { pairingSchema, nodeHelloSchema, operationEventSchema, protocolDocument, reconciliationSchema, submitSchema, identifier } from '../contracts/protocol.ts';
import { ReachError, requireCondition } from './errors.ts';
import { ReachStore } from './store.ts';
import { serveAdmin } from './admin.ts';
import type { RayLoginBridge } from './ray-login.ts';
import type { DeskExtension } from './desk-extension.ts';
import { deskDevices } from './desk-devices.ts';
import type {AgentModelBroker} from './agent-model.ts';
import {modelBindingSchema} from './agent-model-store.ts';

interface Options { store: ReachStore; publicOrigin: string; cookiePath?: string; rayLogin?: RayLoginBridge; desk?: DeskExtension; agentModel?:AgentModelBroker; allowInsecureLoopback?: boolean; trustedProxyAddresses?: string[] }
const loginSchema = z.strictObject({ username: z.string().min(1).max(128), password: z.string().min(1).max(1024) });
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" };
function send(response: ServerResponse, status: number, data: unknown, headers: Record<string, string | string[]> = {}) {
  response.writeHead(status, { ...jsonHeaders, ...headers });
  response.end(JSON.stringify(data));
}
async function body(request: IncomingMessage): Promise<unknown> {
  requireCondition(request.headers['content-type']?.split(';')[0] === 'application/json', 415, 'json_required', '请求必须使用 JSON');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    requireCondition(size <= 2_097_152, 413, 'request_too_large', '请求超过 2 MiB，请分段读取或传输');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ReachError(400, 'invalid_json', 'JSON 格式无效'); }
}
function bearer(request: IncomingMessage) {
  const value = request.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice(7) : undefined;
}
function cookieToken(request: IncomingMessage) {
  return request.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('reach_session='))?.slice('reach_session='.length);
}
class RateLimit {
  entries = new Map<string, { count: number; until: number }>();
  take(key: string) {
    const now = Date.now();
    for (const [id, entry] of this.entries) if (entry.until <= now) this.entries.delete(id);
    requireCondition(this.entries.size < 10000 || this.entries.has(key), 429, 'rate_limited', '请求过多，请稍后重试');
    const entry = this.entries.get(key) ?? { count: 0, until: now + 60000 };
    entry.count++;
    this.entries.set(key, entry);
    requireCondition(entry.count <= 10, 429, 'rate_limited', '尝试次数过多，请稍后重试');
  }
}

export function reachServer(options: Options) {
  const origin = new URL(options.publicOrigin);
  requireCondition(origin.origin === options.publicOrigin, 500, 'invalid_public_origin', 'PUBLIC_ORIGIN must be an origin without a path');
  requireCondition(origin.protocol === 'https:' || (options.allowInsecureLoopback && ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname)), 500, 'https_required', 'Public deployments require HTTPS');
  const { store } = options;
  options.desk?.bindDevices?.(userId=>deskDevices(store,userId));
  const rate = new RateLimit();
  const secure = origin.protocol === 'https:';
  const cookiePath = options.cookiePath ?? '/';
  requireCondition(['/', '/reach/'].includes(cookiePath), 500, 'invalid_cookie_path', 'Cookie path must be / or /reach/');
  function sessionCookies(token: string, maxAge: number) {
    const cookie = `reach_session=${token}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
    return cookiePath === '/' ? [cookie] : [cookie, `reach_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`];
  }
  function clientAddress(request: IncomingMessage) {
    const remote = request.socket.remoteAddress ?? 'unknown';
    if (!options.trustedProxyAddresses?.includes(remote)) return remote;
    // The configured ingress must replace this header, never append/pass it through.
    const forwarded = request.headers['x-reach-client-ip'];
    requireCondition(typeof forwarded === 'string' && isIP(forwarded), 503, 'proxy_source_missing', '入口代理未提供有效客户端地址');
    return forwarded;
  }
  function actor(request: IncomingMessage, mutation = false) {
    const token = bearer(request) ?? cookieToken(request);
    requireCondition(token, 401, 'authentication_required', '请先登录 Reach');
    if (options.rayLogin) requireCondition(bearer(request) ? !options.rayLogin.isRayToken(token) : options.rayLogin.isRayToken(token), 401, 'authentication_kind_mismatch', '登录凭据不能切换浏览器与原生客户端用途');
    const user = store.session(token);
    if (mutation && !bearer(request)) {
      requireCondition(request.headers.origin === origin.origin && request.headers['x-reach-csrf'] === user.csrf, 403, 'csrf_rejected', '页面登录状态已变化，请刷新后重试');
    }
    return { ...user, token };
  }
  options.agentModel?.bind(store);
  let stopping=false,extensionsClosed=!options.desk,shutdownPromise:Promise<void>|undefined,listenPending=false,listenDone:Promise<void>|undefined;
  const active=new Set<Promise<void>>();
  const server = createServer(async (request, response) => {
    let finished!:()=>void;const done=new Promise<void>(resolve=>finished=resolve);active.add(done);
    try {
      if(stopping)return send(response,503,{error:{code:'service_stopping',message:'服务正在关闭，原操作记录保留'}});
      store.owner.assertCurrent();
      const url = new URL(request.url ?? '/', origin.origin);
      const route = url.pathname;
      const method = request.method ?? 'GET';
      if (await options.desk?.serveStatic?.(route, method, response, !!options.rayLogin)) return;
      if (await serveAdmin(route, method, response, !!options.rayLogin, !!options.desk)) return;
      if (method === 'GET' && route === '/healthz') return send(response, 200, { service: 'Reach', version: '0.1.0-dev.1', protocol: 1 });
      if (method === 'POST' && route === '/api/v1/auth/ray') {
        requireCondition(options.rayLogin && request.socket.remoteAddress === '127.0.0.1' && !request.headers.origin, 401, 'ray_bridge_required', '需要可信 Ray 登录入口');
        const signed = z.strictObject({ assertion: z.string().max(4096) }).parse(await body(request));
        const identity = options.rayLogin.consume(signed.assertion);
        const candidateToken = identity.purpose === 'login' ? options.rayLogin.tokenForSession(identity.sessionHash) : identity.reachToken;
        if (candidateToken) {
          const prior = options.rayLogin.reusable(candidateToken, identity.sessionHash);
          if (prior) {
            let username: string | undefined;
            try { username = store.session(candidateToken).username; } catch (error) { if (!(error instanceof ReachError) || error.status !== 401) throw error; }
            if (username === identity.username) return send(response, 200, { loggedIn: true }, { 'set-cookie': sessionCookies(candidateToken, Math.max(1, Math.floor((prior.expires_at - Date.now()) / 1000))) });
          }
        }
        requireCondition(identity.purpose === 'login', 401, 'reach_session_refresh', '请重新连接 Reach 会话');
        const session = store.loginFromRay(identity.username, identity.expiresAt, identity.sessionHash, candidateToken!);
        options.rayLogin.bind(session.token, identity.sessionHash, identity.expiresAt);
        return send(response, 200, { loggedIn: true }, { 'set-cookie': sessionCookies(session.token, Math.max(1, Math.floor((identity.expiresAt - Date.now()) / 1000))) });
      }
      if (method === 'GET' && route === '/api/v1/protocol') { actor(request); return send(response, 200, protocolDocument()); }
      if (method === 'POST' && route === '/api/v1/auth/login') {
        requireCondition(!request.headers.origin || request.headers.origin === origin.origin, 403, 'origin_rejected', '登录来源不匹配');
        rate.take(`login:${clientAddress(request)}`);
        const input = loginSchema.parse(await body(request));
        const result = store.login(input.username, input.password);
        return send(response, 200, result, { 'set-cookie': sessionCookies(result.token, 43200) });
      }
      if (method === 'GET' && route === '/api/v1/auth/me') { const user = actor(request); return send(response, 200, { id: user.id, username: user.username, csrf: user.csrf }); }
      if(route==='/api/v1/library'&&method==='POST'){const user=actor(request,true);return send(response,200,store.library.propose(user.id,await body(request)));}
      if(route==='/api/v1/library'&&method==='GET'){const user=actor(request);return send(response,200,store.library.list(user.id,{nodeId:url.searchParams.get('nodeId'),epoch:Number(url.searchParams.get('epoch')),state:url.searchParams.get('state')??'adopted'}));}
      const library=route.match(/^\/api\/v1\/library\/([^/]+)(?:\/(source|validate|review))?$/);
      if(library){const user=actor(request,method!=='GET'),id=identifier.parse(library[1]);if(method==='GET'&&!library[2])return send(response,200,store.library.read(user.id,id));if(method==='POST'){const input=await body(request);if(library[2]==='source')return send(response,200,store.library.source(user.id,id,input));if(library[2]==='validate')return send(response,200,store.library.validate(user.id,id,input));if(library[2]==='review')return send(response,200,store.library.review(user.id,id,input));}}
      if (method === 'POST' && route === '/api/v1/auth/logout') { const user = actor(request, true); store.logout(user.token); options.desk?.revoke(createHash('sha256').update(user.token).digest('hex')); return send(response, 200, { loggedOut: true }, { 'set-cookie': sessionCookies('', 0) }); }
      if (options.desk && route.startsWith('/api/v1/desk/')) {
        const user = actor(request, method !== 'GET');
        return await options.desk.handle({ request, response, url, userId: user.id, sessionId: createHash('sha256').update(user.token).digest('hex'),
          sessionValid: () => { try { return store.session(user.token).id === user.id; } catch { return false; } }, body: () => body(request),devices:deskDevices(store,user.id) });
      }
      if (method === 'POST' && route === '/api/v1/pairing-codes') { const user = actor(request, true); return send(response, 201, store.createPairing(user.id)); }
      if (method === 'POST' && route === '/api/v1/node/pair') {
        requireCondition(!request.headers.origin, 403, 'native_client_required', '配对需要使用本机 Reach CLI');
        rate.take(`pair:${clientAddress(request)}`);
        const input = pairingSchema.parse(await body(request));
        return send(response, 200, store.pair(input, bearer(request)));
      }
      if (route.startsWith('/api/v1/node/')) {
        const credential = bearer(request);
        requireCondition(credential, 401, 'node_authentication_required', '需要节点身份');
        const receiptOnly = route === '/api/v1/node/events' || route === '/api/v1/node/pending' || route.startsWith('/api/v1/node/control/') || route.startsWith('/api/v1/node/agents/');
        const node = store.node(credential, receiptOnly);
        if(method==='GET'&&route==='/api/v1/node/agent-model')return send(response,200,options.agentModel?{configured:true,descriptor:options.agentModel.descriptor()}:{configured:false});
        const agentContext=route.match(/^\/api\/v1\/node\/agents\/([^/]+)\/context$/);
        if(method==='POST'&&agentContext){const binding=modelBindingSchema.parse(await body(request));return send(response,200,store.executions.context(node,identifier.parse(agentContext[1]),binding.dispatchId,binding.payloadHash));}
        const agentFinalize=route.match(/^\/api\/v1\/node\/agents\/([^/]+)\/finalize\/(context|snapshot)$/);
        if(method==='POST'&&agentFinalize){const id=identifier.parse(agentFinalize[1]),input=await body(request);return send(response,200,agentFinalize[2]==='context'?store.finalizations.contextReply(node,id,input):store.finalizations.snapshot(node,id,input));}
        const agentResume=route.match(/^\/api\/v1\/node\/agents\/([^/]+)\/resume\/(plan|snapshot|arguments|reconcile|admit|final-snapshot)$/);
        if(method==='POST'&&agentResume){const id=identifier.parse(agentResume[1]),input=await body(request);switch(agentResume[2]){case 'plan':return send(response,200,store.resumes.plan(node,id,input));case 'snapshot':return send(response,200,store.resumes.snapshot(node,id,input));case 'arguments':return send(response,200,store.resumes.arguments(node,id,input));case 'reconcile':return send(response,200,store.resumes.reconcile(node,id,input));case 'admit':return send(response,200,store.resumes.admit(node,id,input));case 'final-snapshot':return send(response,200,store.resumes.finalSnapshot(node,id,input));}}
        const agentReviews=route.match(/^\/api\/v1\/node\/agents\/([^/]+)\/reviews(?:\/([^/]+))?$/),agentRuns=route.match(/^\/api\/v1\/node\/agents\/([^/]+)\/runs$/);
        if(method==='POST'&&agentRuns)return send(response,200,store.reviews.register(node,identifier.parse(agentRuns[1]),await body(request)));
        if(method==='POST'&&agentReviews)return send(response,200,agentReviews[2]?store.reviews.poll(node,identifier.parse(agentReviews[1]),identifier.parse(agentReviews[2]),await body(request)):store.reviews.publish(node,identifier.parse(agentReviews[1]),await body(request)));
        const modelStatus=route.match(/^\/api\/v1\/node\/agents\/([^/]+)\/model\/requests\/([^/]+)\/status$/);
        if(method==='POST'&&modelStatus)return send(response,200,store.models.status(node,identifier.parse(modelStatus[1]),identifier.parse(modelStatus[2]),await body(request)));
        const modelRoute=route.match(/^\/api\/v1\/node\/agents\/([^/]+)\/model\/route$/),modelRequest=route.match(/^\/api\/v1\/node\/agents\/([^/]+)\/model\/requests\/([^/]+)$/);
        if(method==='POST'&&(modelRoute||modelRequest)){
          requireCondition(options.agentModel,503,'agent_model_unconfigured','组织尚未配置现场委托模型');
          if(modelRoute)return send(response,200,{...store.models.bind(node,identifier.parse(modelRoute[1]),await body(request),options.agentModel.descriptor()),nativeClosureVersion:1});
          return await options.agentModel.stream(store,node,identifier.parse(modelRequest![1]),identifier.parse(modelRequest![2]),request,response);
        }
        const closure=route.match(/^\/api\/v1\/node\/agents\/([^/]+)\/closure\/snapshot$/);
        if(closure&&method==='POST')return send(response,200,store.closures.snapshot(node,identifier.parse(closure[1]),await body(request)));
        const agent=route.match(/^\/api\/v1\/node\/agents\/([^/]+)\/calls$/);
        if(agent&&method==='POST')return send(response,200,store.agents.create(node,identifier.parse(agent[1]),await body(request)));
        if (method === 'POST' && route === '/api/v1/node/poll') {
          const input = nodeHelloSchema.parse(await body(request));
          store.hello(node, input.version, input.capabilities);
          store.observeStaleClaims();
          // The initial protocol uses bounded short polls. Never repeat a claim.
          return send(response, 200, { operation: store.claim(node), pollAfterMs: 1000 });
        }
        if (method === 'GET' && route === '/api/v1/node/pending') return send(response, 200, { revoked: !!node.revoked, operations: store.pending(node) });
        if (method === 'GET' && route.startsWith('/api/v1/node/control/')) return send(response, 200, { revoked: !!node.revoked, operation: store.control(node, identifier.parse(route.slice('/api/v1/node/control/'.length))) });
        if (method === 'POST' && route === '/api/v1/node/events') return send(response, 200, store.record(node, operationEventSchema.parse(await body(request))));
        throw new ReachError(404, 'not_found', '接口不存在');
      }
      if (method === 'GET' && route === '/api/v1/nodes') return send(response, 200, { nodes: store.nodes(actor(request).id) });
      if (method === 'GET' && route === '/api/v1/overview') return send(response, 200, store.overview(actor(request).id));
      const revoke = route.match(/^\/api\/v1\/nodes\/([^/]+)\/unpair$/);
      if (method === 'POST' && revoke) { store.revoke(actor(request, true).id, identifier.parse(revoke[1])); return send(response, 200, { unpaired: true }); }
      if (method === 'POST' && route === '/api/v1/operations') {
        const user = actor(request, true);
        const input = submitSchema.parse(await body(request));
        return send(response, 201, store.submit(user.id, input.requestId, input.nodeId, input.command));
      }
      if (method === 'GET' && route === '/api/v1/operations') return send(response, 200, { operations: store.operations(actor(request).id) });
      const artifact = route.match(/^\/api\/v1\/operations\/([^/]+)\/artifacts(?:\/([^/]+))?$/);
      if (method === 'GET' && artifact) {
        const user = actor(request), op = identifier.parse(artifact[1]);
        if (!artifact[2]) return send(response, 200, store.artifacts(user.id, op));
        const offset = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(url.searchParams.get('offset') ?? 0);
        const length = z.coerce.number().int().min(1).max(65536).parse(url.searchParams.get('length') ?? 65536);
        return send(response, 200, store.artifact(user.id, op, identifier.parse(artifact[2]), offset, length));
      }
      const operation = route.match(/^\/api\/v1\/operations\/([^/]+)(?:\/(events|cancel|reconcile|reconciliations))?$/);
      if (operation) {
        const user = actor(request, method === 'POST');
        const id = identifier.parse(operation[1]);
        if (method === 'GET' && !operation[2]) return send(response, 200, store.operation(user.id, id));
        if (method === 'GET' && operation[2] === 'events') {
          const after = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(url.searchParams.get('after') ?? 0);
          const limit = z.coerce.number().int().min(1).max(200).parse(url.searchParams.get('limit') ?? 64);
          const events = store.events(user.id, id, after, limit);
          const nextAfter = events.length ? Number(events.at(-1)!.sequence) : after;
          return send(response, 200, { events, nextAfter, hasMore: store.events(user.id, id, nextAfter, 1).length > 0 });
        }
        if (method === 'POST' && operation[2] === 'cancel') return send(response, 200, store.cancel(user.id, id));
        if (method === 'GET' && operation[2] === 'reconciliations') return send(response, 200, { reconciliations: store.reconciliations(user.id, id) });
        if (method === 'POST' && operation[2] === 'reconcile') return send(response, 200, store.reconcile(user.id, id, reconciliationSchema.parse(await body(request))));
      }
      const children=route.match(/^\/api\/v1\/operations\/([^/]+)\/children$/);
      const task=route.match(/^\/api\/v1\/operations\/([^/]+)\/agent-task$/);
      if(task&&method==='GET')return send(response,200,store.executions.projection(actor(request).id,identifier.parse(task[1])));
      const models=route.match(/^\/api\/v1\/operations\/([^/]+)\/agent-models$/);
      if(models&&['GET','POST'].includes(method)){const user=actor(request,method==='POST'),id=identifier.parse(models[1]);if(method==='GET')return send(response,200,store.models.list(user.id,id));const input=await body(request);return send(response,200,options.agentModel?await options.agentModel.stop(user.id,id,input):store.models.recordStopped(user.id,id,input));}
      const reviews=route.match(/^\/api\/v1\/operations\/([^/]+)\/agent-reviews$/);
      if(reviews&&['GET','POST'].includes(method)){const user=actor(request,method==='POST'),id=identifier.parse(reviews[1]);return send(response,200,method==='GET'?store.reviews.list(user.id,id):store.reviews.decision(user.id,id,await body(request)));}
      if(children&&method==='GET'){const user=actor(request),parent=store.operation(user.id,identifier.parse(children[1]));return send(response,200,{parentOperationId:parent.id,calls:store.agents.list(parent)});}
      throw new ReachError(404, 'not_found', '接口不存在');
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof ReachError) return send(response, error.status, { error: { code: error.code, message: error.message } });
      if (error instanceof z.ZodError) return send(response, 400, { error: { code: 'invalid_request', message: '请求字段不符合 Reach 协议', fields: error.issues.map(issue => ({ path: issue.path, code: issue.code })) } });
      // Never expose request bodies, credentials, SQL statements, or stack traces.
      console.error(JSON.stringify({ event: 'request_failed', type: error instanceof Error ? error.name : 'UnknownError' }));
      send(response, 500, { error: { code: 'internal_error', message: '服务处理失败，原操作记录保留' } });
    }finally{active.delete(done);finished();}
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const listen=server.listen;
  server.listen=function(...args:unknown[]){
    requireCondition(!stopping,503,'service_stopping','已关闭的服务实例不能重新监听');
    store.owner.assertCurrent();
    if(server.listening||listenPending)return Reflect.apply(listen,server,args);
    listenPending=true;let bound!:()=>void;listenDone=new Promise<void>(resolve=>bound=resolve);
    const settled=()=>{listenPending=false;server.off('listening',settled);server.off('error',settled);bound();};
    server.once('listening',settled);server.once('error',settled);
    try{return Reflect.apply(listen,server,args);}catch(error){settled();throw error;}
  }as typeof server.listen;
  store.bindHttpOwner(server,()=>!server.listening&&!listenPending&&active.size===0&&extensionsClosed);
  const shutdown=()=>{
    if(shutdownPromise)return shutdownPromise;stopping=true;let complete!:()=>void,failed!:(error:unknown)=>void;
    shutdownPromise=new Promise<void>((resolve,reject)=>{complete=resolve;failed=reject;});
    void(async()=>{const startClose=(close:()=>Promise<void>|undefined)=>{try{return close();}catch(error){return Promise.reject(error);}};
      const modelClosed=startClose(()=>options.agentModel?.close()),deskClosed=startClose(()=>options.desk?.close());
      const httpClosed=(async()=>{if(listenPending)await listenDone;await new Promise<void>((resolve,reject)=>{if(!server.listening)return resolve();server.close(error=>error?reject(error):resolve());server.closeAllConnections();});})();
      await Promise.all([httpClosed,modelClosed,deskClosed]);extensionsClosed=true;while(active.size)await Promise.allSettled([...active]);options.rayLogin?.close();store.close();
    })().then(complete,failed);return shutdownPromise;
  };
  return Object.assign(server,{shutdown});
}
