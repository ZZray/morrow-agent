// Copyright (c) Ray Zhang. 对话改名与删除（列表隐藏）：只改标题或隐藏，不动消息与证据；进行中或待核对时拒绝删除。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DeskStore} from '../src/store.ts';

function fixture(){const root=resolve('work/desk-manage-'+randomUUID());mkdirSync(root,{recursive:true});return new DeskStore(join(root,'desk.sqlite'));}
const code=(fn:()=>unknown)=>{try{fn();return 'ok';}catch(error){return (error as {code?:string}).code??String(error);}};

test('rename changes only the title and stays scoped to the owner',()=>{
  const store=fixture(),id=randomUUID();store.create('user',id,'原标题','route');
  assert.equal(store.rename('user',id,'新标题').title,'新标题');
  assert.equal((store.conversations('user') as {id:string;title:string}[]).find(c=>c.id===id)?.title,'新标题');
  assert.equal(code(()=>store.rename('other',id,'抢改')),'desk_conversation_missing');
  assert.equal(store.conversation('user',id).title,'新标题');
});

test('hide removes a settled conversation from the list but keeps its turns',()=>{
  const store=fixture(),id=randomUUID(),turn=randomUUID();store.create('user',id,'要删的','route');store.admit('user',id,turn,'内容','login','route');
  store.finish(turn,'completed','回答',null,null,false);
  store.hide('user',id);store.hide('user',id);
  assert.equal((store.conversations('user') as {id:string}[]).some(c=>c.id===id),false);
  assert.equal(store.turns('user',id).length,1,'turns stay for audit');
  assert.equal(code(()=>store.hide('other',id)),'desk_conversation_missing');
});

test('hide refuses a conversation with a live turn or an unsettled previous result',()=>{
  const store=fixture(),busy=randomUUID();store.create('user',busy,'进行中','route');store.admit('user',busy,randomUUID(),'内容','login','route');
  store.db.prepare("UPDATE turns SET status='running' WHERE conversation_id=?").run(busy);
  assert.equal(code(()=>store.hide('user',busy)),'desk_conversation_busy');
  const blocked=randomUUID();store.create('user',blocked,'待核对','route');store.db.prepare('UPDATE conversations SET blocked=1 WHERE id=?').run(blocked);
  assert.equal(code(()=>store.hide('user',blocked)),'desk_conversation_unsettled');
  const listed=(store.conversations('user') as {id:string}[]).map(c=>c.id);
  assert.ok(listed.includes(busy)&&listed.includes(blocked));
});

test('workspaces manage device/cwd bindings, scope by owner, and guard deleteWorkspace on live or unsettled turns',()=>{
  const store=fixture();
  try{
    const initial=store.workspaces('user');
    assert.equal(initial.length,1);
    assert.equal(initial[0].name,'默认工作区');
    assert.equal((store.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,3);

    const wsId=randomUUID();
    const created=store.createWorkspace('user',wsId,'后端服务','node-1','E:\\repo\\srv');
    assert.equal(created.name,'后端服务');
    assert.equal(created.node_id,'node-1');
    assert.equal(created.cwd,'E:\\repo\\srv');
    assert.equal(store.createWorkspace('user',wsId,'重复不覆盖').name,'后端服务');
    assert.equal(code(()=>store.createWorkspace('other',wsId,'抢占')),'desk_workspace_missing');
    assert.equal(code(()=>store.updateWorkspace('other',wsId,{name:'抢改'})),'desk_workspace_missing');
    assert.equal(code(()=>store.deleteWorkspace('other',wsId)),'desk_workspace_missing');

    const updated=store.updateWorkspace('user',wsId,{name:'后端排查',nodeId:'node-2',cwd:'/srv/app'});
    assert.deepEqual([updated.name,updated.node_id,updated.cwd],['后端排查','node-2','/srv/app']);

    const cLive=randomUUID();
    store.create('user',cLive,'运行中','route',wsId);
    store.admit('user',cLive,randomUUID(),'工作区消息','login','route');
    assert.equal(code(()=>store.deleteWorkspace('user',wsId)),'desk_conversation_busy');

    const liveTurn=store.turns('user',cLive)[0];
    store.finish(liveTurn.id,'completed','已完成',null,null,false);
    const cBlocked=randomUUID();
    store.create('user',cBlocked,'待核对','route',wsId);
    store.db.prepare('UPDATE conversations SET blocked=1 WHERE id=?').run(cBlocked);
    assert.equal(code(()=>store.deleteWorkspace('user',wsId)),'desk_conversation_unsettled');

    store.db.prepare('UPDATE conversations SET blocked=0 WHERE id=?').run(cBlocked);
    store.deleteWorkspace('user',wsId);
    assert.equal(code(()=>store.workspace('user',wsId)),'desk_workspace_missing');
    const remainingIds=store.conversations('user').map(c=>c.id);
    assert.equal(remainingIds.includes(cLive),false);
    assert.equal(remainingIds.includes(cBlocked),false);
  }finally{
    store.close();
  }
});

test('updateConversationMeta pins conversations first, renames, and moves between workspaces without changing user_version',()=>{
  const store=fixture();
  try{
    const wsA=store.workspaces('user')[0].id;
    const wsB=randomUUID();
    store.createWorkspace('user',wsB,'前端项目',null,'');
    const c1=randomUUID(),c2=randomUUID();
    store.create('user',c1,'第一条','route',wsA);
    store.create('user',c2,'第二条','route',wsA);

    const pinned=store.updateConversationMeta('user',c1,{pinned:true,title:'已置顶对话',workspaceId:wsB});
    assert.equal(pinned.title,'已置顶对话');
    assert.equal(pinned.pinned,1);
    assert.ok(typeof pinned.pinned_at==='number'&&pinned.pinned_at>0);
    assert.equal(pinned.workspace_id,wsB);
    assert.equal(store.conversation('user',c1).title,'已置顶对话');

    const listed=store.conversations('user');
    assert.equal(listed[0].id,c1,'pinned conversation sorts before newer unpinned ones');
    const unpinned=store.updateConversationMeta('user',c1,{pinned:false});
    assert.equal(unpinned.pinned,0);
    assert.equal(unpinned.pinned_at,null);
    assert.equal((store.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,3);
  }finally{
    store.close();
  }
});
