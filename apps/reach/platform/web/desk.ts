// Copyright (c) Ray Zhang. Browser conversation projection; the server owns execution.
export {};
import {mergeSettlement} from './settlement.js';
import type {SettlementView} from './settlement.js';
import {ImageGallery} from './images.js';
import type {ImageView} from './images.js';
interface User {id:string;username:string;csrf:string}
interface Conversation extends SettlementView {id:string;title:string;created_at:number}
interface DeviceNode {id:string;name:string;platform:string;epoch:number;online:boolean;revoked:number}
interface Target {nodeId:string;epoch:number;cwd:string;name?:string;platform?:string}
interface DeviceOperation {operationId:string;nodeId:string;epoch:number;execution:string;delivery:string;cancelRequested:boolean}
interface Turn {id:string;conversationId:string;content:string;status:string;output:string;reason:string|null;cancelRequested:boolean;taskId?:string;runId?:string;observationLost?:boolean;revision?:number;target?:Target|null;deviceCalls?:{operation:DeviceOperation|null}[];operations?:DeviceOperation[];images?:ImageView[]}
interface ConversationState {conversation:Conversation;messages:Turn[]}
interface Stream {turn:Turn;controller:AbortController}
class Stale extends Error {}
class Rejected extends Error {}
const rejectedSubmissionCodes=new Set(['invalid_request','node_not_found','node_pairing_changed','desk_target_cwd_required','desk_message_conflict','desk_conversation_busy','desk_session_unsettled','desk_conversation_missing','desk_route_changed','desk_session_history_limit']);
const app=document.querySelector<HTMLDivElement>('#app')!;
const ray=document.querySelector<HTMLMetaElement>('meta[name="reach-login-provider"]')?.content==='ray';
const apiBase=new URL('../api/v1/',location.href);
const states=new Map<string,ConversationState>(),streams=new Map<string,Stream>(),drafts=new Map<string,string>();
const messageNodes=new Map<string,{body:HTMLElement;status:HTMLElement;record:HTMLButtonElement;operations:HTMLElement;gallery:ImageGallery}>();
const targets=new Map<string,Target|null>();let devices:DeviceNode[]=[],deviceSequence=0;
const settlementReads=new Map<string,object>();
let user:User|null=null,epoch=0,view=0,listSequence=0,selected:string|null=null,conversations:Conversation[]=[],admitting:object|null=null;
let transcript:HTMLElement|null=null,sidebar:HTMLElement|null=null,title:HTMLElement|null=null,notice:HTMLElement|null=null;
let input:HTMLTextAreaElement|null=null,sendButton:HTMLButtonElement|null=null,stopButton:HTMLButtonElement|null=null,latest:HTMLButtonElement|null=null;
let targetSelect:HTMLSelectElement|null=null,cwdInput:HTMLInputElement|null=null,targetHint:HTMLElement|null=null;
let targetBadge:HTMLElement|null=null;
const live=(turn:Turn)=>['submitting','starting','running','cancelling'].includes(turn.status);
function el<K extends keyof HTMLElementTagNameMap>(tag:K,cls='',text?:string):HTMLElementTagNameMap[K]{const item=document.createElement(tag);item.className=cls;if(text!==undefined)item.textContent=text;return item;}
function button(label:string,action:()=>unknown,cls=''){const item=el('button',cls,label);item.type='button';item.addEventListener('click',()=>{void Promise.resolve().then(action).catch(error=>{if(!(error instanceof Stale))showError(error instanceof Error?error.message:'操作未完成，请重试。');});});return item;}
function showError(text:string){if(notice){notice.textContent=text;notice.setAttribute('role','alert');}}
function clearSession(){epoch++;view++;deviceSequence++;for(const stream of streams.values())stream.controller.abort();streams.clear();for(const nodes of messageNodes.values())nodes.gallery.dispose();states.clear();drafts.clear();targets.clear();devices=[];settlementReads.clear();conversations=[];selected=null;user=null;admitting=null;messageNodes.clear();targetSelect=null;cwdInput=null;targetHint=null;app.replaceChildren();}
async function api<T>(path:string,method='GET',body?:unknown):Promise<T>{
  const version=epoch;
  const response=await fetch(new URL(path,apiBase),{method,credentials:'same-origin',headers:{'content-type':'application/json',...(method!=='GET'&&user?{'x-reach-csrf':user.csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json();if(version!==epoch)throw new Stale();
  if(response.status===401){login('登录已过期，请重新连接。');throw new Stale();}
  if(!response.ok)throw Error(value.error?.message??'请求未完成，请稍后重试。');return value;
}
function brand(){const link=el('a','brand');link.href='../';link.setAttribute('aria-label','Reach 设备与连接');const mark=el('img');mark.src='../assets/reach.svg';mark.alt='';link.append(mark,el('span','','Reach Desk'));return link;}
function login(reason=''){
  clearSession();const main=el('main','login');main.id='main';main.append(brand());
  if(ray){main.append(el('h1','','从 Ray 工作台继续'),el('p','',reason||'恢复登录后，继续查看你的对话。'),button('重新连接',()=>location.assign('../'),'primary'));app.append(main);return;}
  main.append(el('h1','','把事情聊清楚'),el('p','','使用 Reach 账户继续，对话和设备共享同一个登录。'));
  const form=el('form'),nameLabel=el('label','','用户名'),name=el('input');name.autocomplete='username';name.required=true;name.name='username';nameLabel.append(name);
  const passwordLabel=el('label','','密码'),password=el('input');password.type='password';password.autocomplete='current-password';password.required=true;password.name='password';passwordLabel.append(password);
  const submit=el('button','primary','进入 Reach Desk');submit.type='submit';const status=el('p','notice',reason);status.setAttribute('role','status');
  form.append(nameLabel,passwordLabel,submit);main.append(form,status);app.append(main);
  form.addEventListener('submit',event=>{event.preventDefault();const version=epoch;submit.disabled=true;
    void(async()=>{let entered=false;try{const response=await fetch(new URL('auth/login',apiBase),{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({username:name.value,password:password.value})});password.value='';const result=await response.json();if(version!==epoch)return;if(!response.ok)throw Error(result.error?.message??'登录未完成');user={...result.user,csrf:result.csrf};shell();entered=true;await load();}catch(error){if(version===epoch){const message=error instanceof Error?error.message:'登录失败';if(entered)showError(message+' 请重新读取对话历史。');else status.textContent=message;}}finally{submit.disabled=false;}})();
  });
}
function shell(){
  app.replaceChildren();const shell=el('div','shell'),side=el('aside','sidebar');
  side.append(brand(),button('＋  新对话',newConversation,'new'));
  sidebar=el('nav','conversation-list');sidebar.setAttribute('aria-label','对话历史');side.append(sidebar);
  const bottom=el('div','sidebar-bottom'),back=el('a','','设备与连接');back.href='../';const account=el('div','account-row');account.append(el('span','',user!.username),button(ray?'退出工作区':'退出登录',async()=>{
    if(ray){clearSession();const form=el('form');form.method='POST';form.action='/ray/logout';document.body.append(form);form.submit();return;}
    await api('auth/logout','POST');login();
  },'quiet'));bottom.append(back,account);side.append(bottom);
  const workspace=el('div','workspace'),bar=el('header','topbar');title=el('h1','','新对话');targetBadge=el('span','context','云端对话');bar.append(title,button('刷新历史',async()=>{await load();},'quiet'),targetBadge);
  transcript=el('main','transcript');transcript.id='main';transcript.setAttribute('aria-label','对话内容');
  const wrap=el('div','composer-wrap'),inner=el('div','composer-inner');notice=el('div','notice');notice.setAttribute('role','status');
  latest=button('↓ 回到最新',()=>{transcript!.scrollTop=transcript!.scrollHeight;latest!.hidden=true;},'latest');latest.hidden=true;
  const composer=el('form','composer');input=el('textarea');input.placeholder='说说你正在处理的事…';input.setAttribute('aria-label','消息');input.maxLength=32000;input.rows=2;
  input.addEventListener('input',()=>{drafts.set(selected??'new',input!.value);composeState();});
  input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();if(!sendButton!.disabled)composer.requestSubmit();}});
  const actions=el('div','composer-actions');actions.append(el('span','composer-hint','Enter 发送 · Shift + Enter 换行'));const controls=el('div','composer-buttons');stopButton=button('停止回答',stop,'stop');stopButton.hidden=true;sendButton=el('button','primary','发送消息');sendButton.type='submit';controls.append(stopButton,sendButton);actions.append(controls);composer.append(input,actions);composer.addEventListener('submit',event=>{event.preventDefault();void send().catch(error=>{if(!(error instanceof Stale))showError(error instanceof Error?error.message:'提交未完成');});});
  const locations=el('div','target-controls'),targetLabel=el('label','','执行位置');targetSelect=el('select');targetSelect.setAttribute('aria-label','执行位置');targetLabel.append(targetSelect);const cwdLabel=el('label','','设备工作目录');cwdInput=el('input');cwdInput.type='text';cwdInput.autocomplete='off';cwdLabel.append(cwdInput);targetHint=el('p','target-hint');targetHint.setAttribute('role','status');locations.append(targetLabel,cwdLabel,button('刷新设备',refreshDevices,'quiet'),targetHint);
  targetSelect.addEventListener('change',()=>{const node=devices.find(n=>n.id+'@'+n.epoch===targetSelect!.value);const previous=currentTarget();targets.set(selected??'new',node?{nodeId:node.id,epoch:node.epoch,cwd:previous?.nodeId===node.id?previous.cwd:'',name:node.name,platform:node.platform}:null);drawTarget();composeState();if(node)cwdInput?.focus();});
  cwdInput.addEventListener('input',()=>{const target=currentTarget();if(target){targets.set(selected??'new',{...target,cwd:cwdInput!.value});composeState();}});
  inner.append(latest,notice,locations,composer,el('p','footnote','回答会自动保存。切换执行位置只影响下一条消息。'));wrap.append(inner);workspace.append(bar,transcript,wrap);shell.append(side,workspace);app.append(shell);paint();void refreshDevices().catch(error=>{if(!(error instanceof Stale))showError('设备列表暂时不可用，请刷新设备。');});
}
function currentTarget(){const key=selected??'new';if(targets.has(key))return targets.get(key)??null;return selected?states.get(selected)?.messages.at(-1)?.target??null:null;}
async function refreshDevices(){const token=++deviceSequence,result=await api<{nodes:DeviceNode[]}>('desk/devices');if(token!==deviceSequence)return;devices=result.nodes;drawTarget();composeState();}
function drawTarget(){if(!targetSelect||!cwdInput||!targetHint)return;const target=currentTarget();targetSelect.replaceChildren();const cloud=el('option','','云端对话');cloud.value='';targetSelect.append(cloud);
  for(const node of devices.filter(n=>!n.revoked)){const option=el('option','',node.name+(node.online?' · 在线':' · 离线'));option.value=node.id+'@'+node.epoch;targetSelect.append(option);}
  const node=target?devices.find(n=>n.id===target.nodeId&&n.epoch===target.epoch&&!n.revoked):null;
  if(target&&!node){const option=el('option','',(target.name??'原设备')+' · 请重新核对配对');option.value=target.nodeId+'@'+target.epoch;targetSelect.append(option);}
  targetSelect.value=target?target.nodeId+'@'+target.epoch:'';cwdInput.value=target?.cwd??'';cwdInput.disabled=!target;cwdInput.placeholder=target?.platform==='windows'?'例如 E:\\项目目录':'例如 /home/user/project';
  if(targetBadge){targetBadge.textContent=target?'下次 · '+(target.name??node?.name??'原设备'):'云端对话';targetBadge.title=target?'下一条消息的执行位置：'+target.cwd:'当前没有选择设备执行目标';}
  targetHint.textContent=!target?'当前只在云端对话。':!node?'设备配对或连接信息已变化，请刷新并重新选择。':node.online?'操作将在这台设备执行，当前消息保留原目标。':'设备离线，操作提交后会等待连接；停止会取消原操作。';
}
function applySettlement(id:string,incoming:unknown,confirmed=false){
  const state=states.get(id),listed=conversations.find(item=>item.id===id),current=state?.conversation??listed;
  const next=mergeSettlement(current,incoming,confirmed);if(state){delete state.conversation.settlement_conflict;Object.assign(state.conversation,next);}if(listed){delete listed.settlement_conflict;Object.assign(listed,next);}
  if(next.settlement_conflict)void resyncSettlement(id);if(selected===id)composeState();return next;
}
async function resyncSettlement(id:string){
  if(settlementReads.has(id))return;const token={},version=epoch;settlementReads.set(id,token);
  try{const result=await api<{conversation:Conversation}>('desk/conversations/'+id);if(version!==epoch||settlementReads.get(id)!==token)return;applySettlement(id,result.conversation,true);if(selected===id){updateNotice();composeState();}}
  catch(error){if(version===epoch&&selected===id&&!(error instanceof Stale))showError('会话状态尚未核对，请刷新历史后再继续。');}
  finally{if(settlementReads.get(id)===token)settlementReads.delete(id);}
}
async function load(){const version=epoch,sequence=++listSequence,viewAtRead=view;const result=await api<{conversations:Conversation[]}>('desk/conversations');if(version!==epoch||sequence!==listSequence)return;conversations=result.conversations.map(item=>({...item,...applySettlement(item.id,item)}));drawSidebar();if(viewAtRead!==view)return;const wanted=new URL(location.href).searchParams.get('c');if(wanted)await open(wanted);else newConversation();}
function drawSidebar(){if(!sidebar)return;sidebar.replaceChildren(el('div','list-label','最近对话'));if(!conversations.length)sidebar.append(el('p','empty-history','第一段对话，从右边开始。'));for(const conversation of conversations){const item=button(conversation.title,()=>open(conversation.id));item.title=conversation.title;if(selected===conversation.id)item.setAttribute('aria-current','page');sidebar.append(item);}}
function address(){const url=new URL(location.href);if(selected)url.searchParams.set('c',selected);else url.searchParams.delete('c');history.replaceState(null,'',url);}
function newConversation(){view++;selected=null;targets.delete('new');address();paint();input?.focus();}
async function open(id:string){
  const token=++view,version=epoch;selected=id;address();paint();
  try{const result=await api<{conversation:Conversation;messages:Turn[]}>('desk/conversations/'+encodeURIComponent(id));if(token!==view||version!==epoch)return;
    const old=states.get(id);for(const active of streams.values())if(active.turn.conversationId===id&&!result.messages.some(turn=>turn.id===active.turn.id))result.messages.push(active.turn);
    result.messages=result.messages.map(turn=>streams.get(turn.id)?.turn??old?.messages.find(existing=>existing.id===turn.id&&existing.status==='submitting')??turn);
    Object.assign(result.conversation,applySettlement(id,result.conversation));states.set(id,result);paint();for(const turn of result.messages)if(!streams.has(turn.id)&&(live(turn)||(!turn.output&&['cancelled','unknown','failed'].includes(turn.status))))void observe(turn).catch(()=>{});
  }catch(error){if(token===view&&!(error instanceof Stale))showError(error instanceof Error?error.message:'对话读取失败');}
}
function paint(){
  if(!transcript||!input||!title)return;for(const nodes of messageNodes.values())nodes.gallery.dispose();messageNodes.clear();transcript.replaceChildren();drawSidebar();notice!.textContent='';latest!.hidden=true;
  const state=selected?states.get(selected):undefined;title.textContent=state?.conversation.title??(selected?'正在读取对话…':'新对话');input.value=drafts.get(selected??'new')??'';
  if(!state?.messages.length){const welcome=el('section','welcome');welcome.append(el('p','eyebrow','REACH DESK'),el('h2','',selected?'从这里继续':'先把想做的事，聊清楚。'),el('p','','整理一个问题，推敲一个想法，或者把复杂的事拆成下一步。'));transcript.append(welcome);}
  else for(const turn of state.messages)appendMessage(turn);
  updateNotice();
  drawTarget();
  composeState();transcript.scrollTop=transcript.scrollHeight;
}
function appendMessage(turn:Turn){
  const userMessage=el('article','message user');userMessage.append(el('div','speaker','你'),el('div','body',turn.content));
  if(turn.target)userMessage.append(el('p','message-target',(turn.target.name??'Reach 设备')+' · '+turn.target.cwd));
  const assistant=el('article','message assistant'),speaker=el('div','speaker');const mark=el('img');mark.src='../assets/reach.svg';mark.alt='';speaker.append(mark,el('span','','Reach Desk'));
  const body=el('div','body',turn.output),status=el('div','message-status'),record=button('查询原记录',()=>query(turn),'quiet'),operations=el('div','device-operations'),images=el('div','device-images');
  const version=epoch,paintView=view;const gallery:ImageGallery=new ImageGallery(images,{deviceName:turn.target?.name??'Reach 设备',current:()=>version===epoch&&paintView===view&&selected===turn.conversationId&&states.get(turn.conversationId)?.messages.find(t=>t.id===turn.id)===turn&&messageNodes.get(turn.id)?.gallery===gallery,fetch:async(image,signal)=>{const response=await fetch(new URL('desk/messages/'+encodeURIComponent(turn.id)+'/images/'+encodeURIComponent(image.callKey),apiBase),{credentials:'same-origin',headers:{accept:'image/png'},signal});if(version!==epoch||paintView!==view)throw new Stale();if(response.status===401){login('登录已过期，请重新连接。');throw new Stale();}return response;}});
  record.hidden=true;assistant.append(speaker,operations,images,body,status,record);transcript!.append(userMessage,assistant);messageNodes.set(turn.id,{body,status,record,operations,gallery});update(turn);
}
function update(turn:Turn){
  if(selected!==turn.conversationId)return;const nodes=messageNodes.get(turn.id);if(!nodes)return;
  const stick=transcript!.scrollHeight-transcript!.scrollTop-transcript!.clientHeight<90;nodes.body.textContent=turn.output;
  const labels:Record<string,string>={submitting:'正在提交消息…',starting:'已接收，正在准备回答…',running:'正在处理…',cancelling:'已请求停止，正在核对结果…',completed:'回答已保存',cancelled:'已停止',failed:'回答未完成，原记录已保留',unknown:'结果尚未确定，原记录已保留',unconfirmed:'连接中断，尚未确认原消息状态',rejected:'本次提交未被接受，消息已保留'};
  nodes.status.textContent=turn.observationLost?'连接中断，请查询原记录。':labels[turn.status]??turn.status;nodes.status.className='message-status'+(['unknown','unconfirmed','cancelled','cancelling'].includes(turn.status)||turn.observationLost?' warn':turn.status==='failed'?' bad':'');nodes.record.hidden=!(['unknown','unconfirmed','failed'].includes(turn.status)||turn.observationLost);
  const operations=new Map((turn.operations??turn.deviceCalls?.map(c=>c.operation).filter((op):op is DeviceOperation=>!!op)??[]).map(op=>[op.operationId,op]));nodes.operations.replaceChildren();
  nodes.gallery.update(turn.images??[]);
  const names:Record<string,string>={not_observed:'等待设备接收',received:'设备已接收',running:'设备执行中',succeeded:'原操作成功',failed:'原操作失败',cancelled:'原操作已取消',unknown:'原操作效果未知'};
  for(const op of operations.values()){const row=el('div','device-operation'),state=el('span','',names[op.execution]??op.execution);row.append(state,el('code','',op.operationId));if(op.cancelRequested&&!['succeeded','failed','cancelled','unknown'].includes(op.execution))row.append(el('span','','已请求停止'));nodes.operations.append(row);}
  updateNotice();
  if(stick)transcript!.scrollTop=transcript!.scrollHeight;else latest!.hidden=false;composeState();
}
function updateNotice(){if(!notice)return;const state=selected?states.get(selected):undefined;if(state?.conversation.settlement_conflict)notice.textContent='正在核对会话状态，原记录和草稿已保留。';else if(state?.conversation.blocked)notice.textContent=state.messages.some(turn=>turn.status==='cancelling')?'正在核对停止后的会话状态，原记录和草稿已保留。':'上一条消息尚未结算，原记录已保留。核对后再继续；也可以另开一段对话。';else if(notice.textContent?.startsWith('正在核对')||notice.textContent?.startsWith('上一条消息尚未结算'))notice.textContent='';}
function composeState(){if(!input||!sendButton||!stopButton)return;const state=selected?states.get(selected):undefined,current=state?.messages.find(live),target=currentTarget(),targetInvalid=!!target&&(!target.cwd.trim()||!devices.some(n=>n.id===target.nodeId&&n.epoch===target.epoch&&!n.revoked));input.disabled=!!state?.conversation.blocked||!!state?.conversation.settlement_conflict;sendButton.disabled=!!admitting||!input.value.trim()||!!current||input.disabled||targetInvalid;stopButton.hidden=!current;stopButton.disabled=!!current?.cancelRequested||current?.status==='cancelling'||current?.status==='submitting';}
async function send(){
  if(!input?.value.trim()||sendButton?.disabled||admitting)return;const content=input.value.trim(),version=epoch,target=currentTarget()?{...currentTarget()!}:null;let conversationId=selected;const token=view;
  const admission={};admitting=admission;composeState();
  try{
  if(!conversationId){conversationId=crypto.randomUUID();const conversation=await api<Conversation>('desk/conversations','POST',{id:conversationId,title:content.slice(0,80)});if(version!==epoch)throw new Stale();listSequence++;states.set(conversationId,{conversation,messages:[]});conversations.unshift(conversation);if(token===view){const followup=drafts.get('new');if(followup!==undefined&&followup.trim()!==content){drafts.set(conversationId,followup);drafts.delete('new');}targets.set(conversationId,currentTarget());selected=conversationId;address();paint();}}
  const state=states.get(conversationId);if(!state)throw Error('对话尚未读取完成，请稍后发送。');
  const turn:Turn={id:crypto.randomUUID(),conversationId,content,status:'submitting',output:'',reason:null,cancelRequested:false,target};state.messages.push(turn);
  for(const key of [conversationId,'new'])if((drafts.get(key)??'').trim()===content)drafts.set(key,'');
  if(selected===conversationId){input!.value=drafts.get(conversationId)??drafts.get('new')??'';if(transcript!.querySelector('.welcome'))transcript!.replaceChildren();appendMessage(turn);}
  const receiving=stream(turn,'desk/conversations/'+conversationId+'/messages',{id:turn.id,content,...(target?{target:{nodeId:target.nodeId,epoch:target.epoch,cwd:target.cwd}}:{})});if(admitting===admission)admitting=null;composeState();await receiving;
  }finally{if(version===epoch&&admitting===admission){admitting=null;composeState();}}
}
async function observe(turn:Turn,recovery=0){const historical=!live(turn);turn.output='';turn.observationLost=false;update(turn);await stream(turn,'desk/messages/'+turn.id+'/events',undefined,recovery,historical);}
async function stream(turn:Turn,path:string,body?:unknown,recovery=0,historical=false){
  if(streams.has(turn.id))return;const controller=new AbortController(),version=epoch;streams.set(turn.id,{turn,controller});let settled=false,readFailed=false;
  try{
    const response=await fetch(new URL(path,apiBase),{method:body?'POST':'GET',credentials:'same-origin',headers:{'content-type':'application/json',...(body?{'x-reach-csrf':user!.csrf}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal});
    if(version!==epoch)throw new Stale();if(response.status===401){login('登录已过期，请重新连接。');throw new Stale();}
    if(!response.ok){const error=await response.json(),message=error.error?.message??'消息未完成';if(body&&response.status>=400&&response.status<500&&rejectedSubmissionCodes.has(error.error?.code))throw new Rejected(message);throw Error(message);}
    const reader=response.body!.getReader(),decoder=new TextDecoder();let pending='',sequence=0;
    for(;;){const{value,done}=await reader.read();if(version!==epoch)throw new Stale();if(done)break;pending+=decoder.decode(value,{stream:true});if(pending.length>2097152)throw Error('回答片段过大，请查询原记录。');
      for(let end=pending.indexOf('\n\n');end>=0;end=pending.indexOf('\n\n')){const lines=pending.slice(0,end).split('\n');pending=pending.slice(end+2);const kind=lines.find(line=>line.startsWith('event: '))?.slice(7),raw=lines.find(line=>line.startsWith('data: '))?.slice(6),id=Number(lines.find(line=>line.startsWith('id: '))?.slice(4));if(!raw)continue;if(!Number.isSafeInteger(id)||id!==sequence+1)throw Error('回答片段顺序不完整，请查询原记录。');sequence=id;const event=JSON.parse(raw);
        if(kind==='admitted'&&!historical)turn.status=event.status;
        if(kind==='delta'){if(!historical)turn.status=turn.cancelRequested?'cancelling':'running';turn.output+=event.text;}
        if(kind==='admitted'&&event.target)turn.target=event.target;
        if(kind==='device_operation'){const operations=turn.operations??turn.deviceCalls?.map(c=>c.operation).filter((op):op is DeviceOperation=>!!op)??[];turn.operations=operations.filter(op=>op.operationId!==event.operation.operationId);turn.operations.push(event.operation);}
        if(kind==='device_image'&&event.image){turn.images=(turn.images??[]).filter(image=>image.callKey!==event.image.callKey);turn.images.push(event.image);}
        if(kind==='cancel_requested'){turn.cancelRequested=true;if(!historical)turn.status='cancelling';}
        if(kind==='settlement_pending')applySettlement(turn.conversationId,event.conversation);
        if(kind==='settled'){turn.status=event.status;turn.reason=event.reason;if(event.output||event.status==='completed')turn.output=event.output;if(event.conversation)applySettlement(turn.conversationId,event.conversation);else if(event.sessionBlocked)applySettlement(turn.conversationId,null);settled=true;}
        turn.revision=(turn.revision??0)+1;
        if(kind==='stream_unavailable'&&selected===turn.conversationId)showError('部分即时内容未能显示。回答结束后会读取保存的原文。');update(turn);
      }
    }
    if(!settled)throw Error('连接已结束，正在查询原消息。');
  }catch(error){
    if(version===epoch&&!(error instanceof Stale)&&!controller.signal.aborted){
      if(error instanceof Rejected){turn.status='rejected';turn.reason=error.message;turn.revision=(turn.revision??0)+1;if(!drafts.get(turn.conversationId))drafts.set(turn.conversationId,turn.content);if(selected===turn.conversationId)input!.value=drafts.get(turn.conversationId)??'';update(turn);if(selected===turn.conversationId)showError(error.message);}
      else{readFailed=!historical;if(historical)turn.observationLost=true;else turn.status='unconfirmed';update(turn);if(selected===turn.conversationId)showError(error instanceof Error?error.message:'连接中断，请查询原消息。');if(!historical)try{await query(turn);}catch{}}
    }
  }finally{if(streams.get(turn.id)?.controller===controller)streams.delete(turn.id);if(version===epoch){composeState();if(readFailed&&live(turn)&&!controller.signal.aborted){if(recovery===0)void observe(turn,1);else{turn.observationLost=true;update(turn);}}}}
}
async function query(turn:Turn){const revision=turn.revision??0,saved=await api<Turn>('desk/messages/'+turn.id);if((turn.revision??0)!==revision||states.get(turn.conversationId)?.messages.find(item=>item.id===turn.id)!==turn)return;const prior=turn.output;Object.assign(turn,saved);delete turn.operations;turn.revision=revision+1;if(!turn.output&&turn.status!=='completed')turn.output=prior;update(turn);if(selected===turn.conversationId&&['unknown','cancelled'].includes(turn.status)){const result=await api<{conversation:Conversation;messages:Turn[]}>('desk/conversations/'+turn.conversationId);applySettlement(turn.conversationId,result.conversation);updateNotice();composeState();}if(live(turn)&&!streams.has(turn.id))void observe(turn,1);}
async function stop(){if(!selected)return;const turn=states.get(selected)?.messages.find(live);if(!turn||turn.cancelRequested)return;turn.cancelRequested=true;turn.status='cancelling';update(turn);try{await api('desk/messages/'+turn.id+'/cancel','POST',{});}catch(error){turn.cancelRequested=false;await query(turn);throw error;}}
async function boot(){const version=epoch;let entered=false;try{const response=await fetch(new URL('auth/me',apiBase),{credentials:'same-origin'});const result=await response.json();if(version!==epoch)return;if(!response.ok){login();return;}user=result;shell();entered=true;await load();}catch(error){if(version===epoch){const message=error instanceof Error?error.message:'暂时无法连接 Reach。';if(entered)showError(message+' 请重新读取对话历史。');else login(message);}}}
window.addEventListener('pagehide',()=>{clearSession();app.append(el('main','loading','正在离开 Reach Desk…'));});
window.addEventListener('pageshow',event=>{if(event.persisted)void boot();});
void boot();
