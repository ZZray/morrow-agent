// Copyright (c) Ray Zhang. Inspection submission is exact, authenticated and read-only with respect to the original Task.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {modelFixture} from './agent-model-fixture.ts';
import {commandSchema} from '../src/contracts/protocol.ts';

test('inspection requires its own capability and the exact original Task account, Node and epoch',async()=>{
  const f=await modelFixture();try{
    const input={requestId:randomUUID(),nodeId:f.node.id,command:{kind:'agent.inspect',rootOperationId:f.parent.id}};
    assert.equal((await f.api('/api/v1/operations','POST',input,f.session.token)).data.error.code,'capability_unavailable');
    f.store.hello(f.node,'inspection-fixture',['agent.delegate','agent.inspect','file.read']);const parent=f.store.operation(f.session.user.id,f.parent.id),events=f.store.events(f.session.user.id,f.parent.id);
    const a=await f.api('/api/v1/operations','POST',input,f.session.token),b=await f.api('/api/v1/operations','POST',input,f.session.token);assert.equal(a.status,201);assert.equal(a.data.id,b.data.id);
    const secret=randomBytes(32).toString('base64url'),other=f.store.pair({attemptId:randomUUID(),code:f.store.createPairing(f.session.user.id).code,installationId:randomUUID(),installationSecret:secret,name:'another inspection fixture',platform:'windows',version:'fixture'});f.store.hello(f.store.node(secret),'fixture',['agent.inspect']);
    assert.equal((await f.api('/api/v1/operations','POST',{...input,requestId:randomUUID(),nodeId:other.nodeId},f.session.token)).data.error.code,'agent_inspection_binding');
    assert.equal((await f.api('/api/v1/operations','POST',{...input,requestId:randomUUID(),command:{kind:'agent.inspect',rootOperationId:a.data.id}},f.session.token)).data.error.code,'agent_inspection_binding');
    assert.equal((await f.api('/api/v1/operations','POST',{...input,requestId:randomUUID(),command:{kind:'agent.inspect',rootOperationId:randomUUID()}},f.session.token)).status,404);
    assert.equal((await f.api('/api/v1/operations','POST',{...input,requestId:randomUUID()},f.nodeToken)).status,401);
    assert.equal(commandSchema.safeParse({...input.command,endpoint:'http://127.0.0.1:1/v1'}).success,false);
    assert.deepEqual(f.store.operation(f.session.user.id,f.parent.id),parent);assert.deepEqual(f.store.events(f.session.user.id,f.parent.id),events);assert.equal(f.calls().length,0);assert.equal(f.store.executions.projection(f.session.user.id,f.parent.id).generation,1);
  }finally{await f.close();}
});
