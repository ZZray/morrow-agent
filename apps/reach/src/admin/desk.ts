// Copyright (c) Ray Zhang. Reach 对话（Reach Desk）：参照 HandWave 工作台布局与交互，仅对 Reach 接口与主题令牌做适配。
import {mergeSettlement} from './desk-settlement.js';
import type {SettlementView} from './desk-settlement.js';
import {ImageGallery} from './desk-images.js';
import type {ImageView} from './desk-images.js';
import {applyStepEvent,paintSteps,stepTone} from './desk-steps.js';
import {enqueue,removeItem,paintQueue,QUEUE_LIMIT} from './desk-queue.js';
import type {QueueItem} from './desk-queue.js';
import {DeskSkills} from './desk-skills.js';
import {openMemory} from './desk-memory.js';
import {mountWorkspaceTree} from './desk-files.js';
import {DeskAttachments,attachmentList} from './desk-attachments.js';
import type {AttachmentMeta} from './desk-attachments.js';
import {renderMarkdown} from './desk-markdown.js';
import type {Step} from './desk-steps.js';
import {AgentPanel,applyGuidance} from './desk-agent.js';
import type {Guidance} from './desk-agent.js';

interface User {id:string;username:string;csrf:string}
interface Workspace {id:string;name:string;node_id:string|null;cwd:string;created_at:number;updated_at:number}
interface Conversation extends SettlementView {id:string;title:string;created_at:number;workspace_id?:string|null;pinned?:number;pinned_at?:number|null}
interface ProviderModelItem {id:string;imageInput?:boolean;contextWindow?:number;maxOutput?:number}
interface ProviderGroup {id:string;name:string;models:ProviderModelItem[]}
interface ModelSettingsView {providers:ProviderGroup[];desk:{running:{model:string}|null;enabled:{model:string}|null}}
interface DeviceNode {id:string;name:string;platform:string;epoch:number;online:boolean;revoked:number}
interface Target {nodeId:string;epoch:number;cwd:string;name?:string;platform?:string}
interface DeviceOperation {operationId:string;nodeId:string;epoch:number;execution:string;delivery:string;cancelRequested:boolean}
interface Turn {id:string;conversationId:string;content:string;status:string;steps?:Step[];skills?:{id:string;name:string}[];attachments?:AttachmentMeta[];output:string;reason:string|null;cancelRequested:boolean;createdAt?:number;guidance?:Guidance[];taskId?:string;runId?:string;observationLost?:boolean;revision?:number;target?:Target|null;deviceCalls?:{operation:DeviceOperation|null}[];operations?:DeviceOperation[];images?:ImageView[]}
interface ConversationState {conversation:Conversation;messages:Turn[]}
interface Stream {turn:Turn;controller:AbortController}
interface MemoryOverview {entries:{id:string;title:string;status:string}[];notes:{id:string;title:string;updatedAt:number}[];agentSkills:{name:string}[]}
export interface DeskContext {
  user:User;
  availability:'running'|'unconfigured'|'unavailable';
  reason?:string;
  onExpired(reason:string):void;
  openSettings():void;
}
class Stale extends Error {}
class Rejected extends Error {}
const rejectedSubmissionCodes=new Set(['invalid_request','node_not_found','node_pairing_changed','desk_target_cwd_required','desk_message_conflict','desk_conversation_busy','desk_session_unsettled','desk_conversation_missing','desk_route_changed','desk_session_history_limit']);
const apiBase=new URL('../api/v1/',import.meta.url);
const logo=new URL('reach.svg',import.meta.url).href;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CWD_STORE_KEY='reach.desk.nodeCwd';
const COLLAPSED_WS_KEY='reach.desk.collapsedWS';
const RAIL_COLLAPSED_KEY='reach.desk.railCollapsed';
const OPT_MEMORY_KEY='reach.desk.optMemory';
const OPT_TOOLS_KEY='reach.desk.optTools';

const states=new Map<string,ConversationState>(),streams=new Map<string,Stream>(),drafts=new Map<string,string>();
const messageNodes=new Map<string,{body:HTMLElement;status:HTMLElement;record:HTMLButtonElement;copyAnswer:HTMLButtonElement;operations:HTMLElement;gallery:ImageGallery;steps:HTMLDetailsElement;agent:AgentPanel}>();
const targets=new Map<string,Target|null>();let devices:DeviceNode[]=[],deviceSequence=0;
const settlementReads=new Map<string,object>();
let context:DeskContext|null=null,user:User|null=null,epoch=0,view=0,listSequence=0,selected:string|null=null,conversations:Conversation[]=[],admitting:object|null=null;
let workspaces:Workspace[]=[],selectedWorkspaceId:string|null=null,collapsedWS=readCollapsedSet(),railCollapsed=readRailCollapsed(),railQuery='';
let optMemory=readBoolOpt(OPT_MEMORY_KEY,true),optTools=readBoolOpt(OPT_TOOLS_KEY,true);
let deskRoot:HTMLElement|null=null,sidePanel:HTMLElement|null=null,railToggle:HTMLButtonElement|null=null,railSheetOpen=false,railSearchInput:HTMLInputElement|null=null;
let transcript:HTMLElement|null=null,sidebar:HTMLElement|null=null,title:HTMLElement|null=null,notice:HTMLElement|null=null;
let input:HTMLTextAreaElement|null=null,sendButton:HTMLButtonElement|null=null,stopButton:HTMLButtonElement|null=null,latest:HTMLButtonElement|null=null;
let connPill:HTMLButtonElement|null=null,targetPill:HTMLButtonElement|null=null,modelPill:HTMLButtonElement|null=null,modelMenu:HTMLElement|null=null,modelSwitching=false;
let drawerToggle:HTMLButtonElement|null=null,asidePanel:HTMLElement|null=null,asideScrim:HTMLElement|null=null,drawerOpen=false;
let devListBox:HTMLElement|null=null,cwdInput:HTMLInputElement|null=null,treeWrap:HTMLElement|null=null,treeHint:HTMLElement|null=null,treeCwdRow:HTMLElement|null=null;
let treeHandle:{refresh():void;dispose():void}|null=null,treeKey='';
let asideMemoryBox:HTMLElement|null=null,asideToolsBox:HTMLElement|null=null,asideToolsCount:HTMLElement|null=null;
let optMemCheck:HTMLInputElement|null=null,optToolCheck:HTMLInputElement|null=null;
let attachMenu:HTMLElement|null=null,plusButton:HTMLButtonElement|null=null,attachSkillMeta:HTMLElement|null=null;
let ctxMenu:HTMLElement|null=null,ctxTarget:{kind:'ws';ws:Workspace}|{kind:'sess';ws:Workspace;conv:Conversation}|null=null,cwdSaveTimer=0;
const queues=new Map<string,QueueItem[]>();let queueBox:HTMLElement|null=null,currentModelName='';
let skills:DeskSkills|null=null,attachments:DeskAttachments|null=null;
const suggestions=new Map<string,{basis:string;text:string;at:number}>(),suggestionAsked=new Set<string>();
const PLACEHOLDER='说说你正在处理的事…',SUGGESTION_TTL=60000;let suggestionTimer=0;
const live=(turn:Turn)=>['submitting','starting','running','cancelling'].includes(turn.status);

function el<K extends keyof HTMLElementTagNameMap>(tag:K,cls='',text?:string):HTMLElementTagNameMap[K]{const item=document.createElement(tag);if(cls)item.className=cls;if(text!==undefined)item.textContent=text;return item;}
function svg(viewBox:string,paths:string[],size=16,cls='ic'){
  const ns='http://www.w3.org/2000/svg',node=document.createElementNS(ns,'svg');
  node.setAttribute('width',String(size));node.setAttribute('height',String(size));node.setAttribute('viewBox',viewBox);node.setAttribute('aria-hidden','true');if(cls)node.setAttribute('class',cls);
  for(const d of paths){const p=document.createElementNS(ns,'path');p.setAttribute('d',d);node.append(p);}
  return node;
}
function button(label:string,action:()=>unknown,cls=''){const item=el('button',cls,label);item.type='button';item.addEventListener('click',()=>{void Promise.resolve().then(action).catch(error=>{if(!(error instanceof Stale))showError(error instanceof Error?error.message:'操作未完成，请重试。');});});return item;}
function showError(text:string){if(notice){notice.textContent=text;notice.setAttribute('role','alert');}}
function expired(){const current=context;reset();current?.onExpired('登录已过期，请重新登录。未确认的消息不会自动重发。');}

function readNodeCwd(nodeId:string):string{try{const map=JSON.parse(localStorage.getItem(CWD_STORE_KEY)??'{}') as Record<string,string>;return typeof map[nodeId]==='string'?map[nodeId]:'';}catch{return '';}}
function saveNodeCwd(nodeId:string,cwd:string){try{const map=JSON.parse(localStorage.getItem(CWD_STORE_KEY)??'{}') as Record<string,string>;map[nodeId]=cwd;localStorage.setItem(CWD_STORE_KEY,JSON.stringify(map));}catch{}}
function readCollapsedSet():Set<string>{try{const raw=JSON.parse(localStorage.getItem(COLLAPSED_WS_KEY)??'[]');return new Set(Array.isArray(raw)?raw.filter((x):x is string=>typeof x==='string'):[]);}catch{return new Set();}}
function saveCollapsedSet(set:Set<string>){try{localStorage.setItem(COLLAPSED_WS_KEY,JSON.stringify([...set]));}catch{}}
function readRailCollapsed():boolean{try{return localStorage.getItem(RAIL_COLLAPSED_KEY)==='1';}catch{return false;}}
function saveRailCollapsed(value:boolean){try{localStorage.setItem(RAIL_COLLAPSED_KEY,value?'1':'0');}catch{}}
function readBoolOpt(key:string,fallback:boolean):boolean{try{const v=localStorage.getItem(key);return v===null?fallback:v==='1';}catch{return fallback;}}
function saveBoolOpt(key:string,value:boolean){try{localStorage.setItem(key,value?'1':'0');}catch{}}
async function copyText(text:string,done:(ok:boolean)=>void){
  try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);done(true);return;}}catch{}
  try{const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.append(ta);ta.select();const ok=document.execCommand('copy');ta.remove();done(ok);}catch{done(false);}
}

function reset(){
  epoch++;view++;deviceSequence++;
  clearTimeout(cwdSaveTimer);cwdSaveTimer=0;clearTimeout(suggestionTimer);suggestionTimer=0;
  for(const stream of streams.values())stream.controller.abort();streams.clear();
  for(const nodes of messageNodes.values())nodes.gallery.dispose();
  treeHandle?.dispose();treeHandle=null;treeKey='';
  states.clear();drafts.clear();targets.clear();devices=[];settlementReads.clear();conversations=[];workspaces=[];
  selected=null;selectedWorkspaceId=null;user=null;context=null;admitting=null;messageNodes.clear();currentModelName='';drawerOpen=false;railSheetOpen=false;railQuery='';modelSwitching=false;
  ctxTarget=null;ctxMenu=null;deskRoot=null;sidePanel=null;railToggle=null;railSearchInput=null;modelMenu=null;optMemCheck=null;optToolCheck=null;
  transcript=null;sidebar=null;title=null;notice=null;input=null;sendButton=null;stopButton=null;latest=null;
  connPill=null;targetPill=null;modelPill=null;drawerToggle=null;asidePanel=null;asideScrim=null;
  devListBox=null;cwdInput=null;treeWrap=null;treeHint=null;treeCwdRow=null;asideMemoryBox=null;asideToolsBox=null;asideToolsCount=null;
  attachMenu=null;plusButton=null;attachSkillMeta=null;queueBox=null;
}

async function api<T>(path:string,method='GET',body?:unknown):Promise<T>{
  const version=epoch;
  const response=await fetch(new URL(path,apiBase),{method,credentials:'same-origin',headers:{'content-type':'application/json',...(method!=='GET'&&user?{'x-reach-csrf':user.csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json();if(version!==epoch)throw new Stale();
  if(response.status===401){expired();throw new Stale();}
  if(!response.ok)throw Error(value.error?.message??'请求未完成，请稍后重试。');return value;
}

export function mountDesk(root:HTMLElement,next:DeskContext){
  reset();context=next;user=next.user;const version=epoch;
  root.classList.add('desk');
  if(next.availability!=='running'){
    const empty=el('section','desk-empty');
    const detail=next.availability==='unconfigured'
      ?'还没有启用云端对话模型。到设置里添加供应商、选好模型并通过连接测试，启用后回到这里即可对话，对话和设备共用当前登录。'
      :`对话运行时没有加载，暂时不能对话。${next.reason??''}模型可以先在设置里配好，补齐后重启服务即可使用。`;
    empty.append(el('p','eyebrow','REACH 对话'),el('h2','','对话还没有启用'),el('p','',detail),button('去设置模型',()=>next.openSettings(),'primary'));
    root.append(empty);
    return {dispose(){if(epoch===version)reset();}};
  }
  layout(root);void load().catch(error=>{if(!(error instanceof Stale))showError(error instanceof Error?error.message+' 请刷新历史。':'对话历史读取失败，请刷新历史。');});
  return {dispose(){if(epoch===version)reset();}};
}

function layout(root:HTMLElement){
  deskRoot=root;
  deskRoot.classList.toggle('rail-collapsed',railCollapsed&&window.innerWidth>960);

  sidePanel=el('aside','sidebar');sidePanel.setAttribute('aria-label','工作区与会话');
  const actions=el('div','rail-actions');
  const newBtn=el('button','rail-action primary');newBtn.type='button';newBtn.title='新建会话 (Ctrl+N)';
  newBtn.append(svg('0 0 24 24',['M12 5v14','M5 12h14'],14),el('span','','新建会话'),el('kbd','','Ctrl+N'));
  newBtn.addEventListener('click',()=>newConversation());
  const newWsBtn=el('button','rail-action');newWsBtn.type='button';newWsBtn.title='新建工作区';
  newWsBtn.append(svg('0 0 24 24',['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z'],14),el('span','','新建工作区'));
  newWsBtn.addEventListener('click',()=>openCreateWorkspaceDialog());
  actions.append(newBtn,newWsBtn);
  const railSearch=el('div','rail-search');
  railSearchInput=el('input','rail-search-input');railSearchInput.type='search';railSearchInput.placeholder='筛选工作区或对话…';railSearchInput.setAttribute('aria-label','筛选工作区或对话');
  railSearchInput.addEventListener('input',()=>{railQuery=railSearchInput!.value.trim().toLowerCase();drawSidebar();});
  railSearch.append(railSearchInput);
  const railSec=el('div','rail-section grow');
  railSec.append(el('div','rail-bh','工作区'));
  sidebar=el('nav','ws-tree');sidebar.setAttribute('role','tree');sidebar.setAttribute('aria-label','工作区与会话');
  sidebar.addEventListener('scroll',()=>closeCtxMenu());
  railSec.append(sidebar);
  sidePanel.append(actions,railSearch,railSec);

  const workspace=el('div','workspace'),bar=el('header','topbar');
  railToggle=el('button','tb-icon rail-toggle');railToggle.type='button';railToggle.title='展开或收起侧栏';railToggle.setAttribute('aria-label','展开或收起侧栏');
  railToggle.append(svg('0 0 24 24',['M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z','M9 5v14'],15));
  railToggle.setAttribute('aria-expanded',String(window.innerWidth>960?!railCollapsed:railSheetOpen));
  railToggle.addEventListener('click',()=>toggleRail());
  connPill=el('button','conn-pill');connPill.type='button';connPill.title='点击切换执行主机与工作区目录';
  connPill.addEventListener('click',()=>toggleDrawer(true));
  title=el('h1','','新会话');
  const memBtn=button('记忆',()=>openMemory(api,showError),'tb-btn');
  const refreshBtn=el('button','tb-icon');refreshBtn.type='button';refreshBtn.title='刷新历史';refreshBtn.setAttribute('aria-label','刷新历史');
  refreshBtn.append(svg('0 0 24 24',['M3 12a9 9 0 0 1 15.5-6.3L21 8','M21 3v5h-5','M21 12a9 9 0 0 1-15.5 6.3L3 16','M3 21v-5h5'],15));
  refreshBtn.addEventListener('click',()=>{void load().catch(error=>{if(!(error instanceof Stale))showError(error instanceof Error?error.message:'刷新失败');});});
  drawerToggle=el('button','tb-btn drawer-toggle');drawerToggle.type='button';drawerToggle.title='主机、目录、知识库与工具明细';drawerToggle.setAttribute('aria-expanded','false');
  drawerToggle.append(svg('0 0 24 24',['M4 6h16','M4 12h16','M4 18h16','M9 4v4','M15 10v4','M9 16v4'],15),el('span','','工具与连接'));
  drawerToggle.addEventListener('click',()=>toggleDrawer());
  bar.append(railToggle,connPill,title,memBtn,refreshBtn,drawerToggle);

  transcript=el('section','transcript');transcript.setAttribute('aria-label','对话内容');
  transcript.addEventListener('click',event=>{
    const copyBtn=(event.target as Element|null)?.closest?.('.code-copy') as HTMLButtonElement|null;
    if(!copyBtn)return;
    const code=copyBtn.closest('pre.codeblock')?.querySelector('code');if(!code)return;
    void copyText(code.textContent??'',ok=>{copyBtn.textContent=ok?'已复制':'失败';window.setTimeout(()=>{if(copyBtn.isConnected)copyBtn.textContent='复制';},1200);});
  });
  const wrap=el('div','composer-wrap'),inner=el('div','composer-inner');
  notice=el('div','notice');notice.setAttribute('role','status');
  latest=button('↓ 回到最新',()=>{transcript!.scrollTop=transcript!.scrollHeight;latest!.hidden=true;},'latest');latest.hidden=true;
  queueBox=el('section','desk-queue');queueBox.hidden=true;queueBox.setAttribute('aria-label','排队消息');

  const composer=el('form','composer');
  input=el('textarea');input.placeholder=PLACEHOLDER;input.setAttribute('aria-label','消息');input.maxLength=32000;input.rows=2;
  input.addEventListener('input',()=>{drafts.set(selected??'new',input!.value);if(input!.value)hideSuggestion();else showSuggestion();composeState();});
  input.addEventListener('keydown',event=>{const text=input!.dataset.suggestion;if(!text||input!.value)return;if(event.key==='Tab'&&!event.shiftKey){event.preventDefault();input!.value=text;drafts.set(selected??'new',text);hideSuggestion();input!.dispatchEvent(new Event('input',{bubbles:true}));}else if(event.key==='Escape'){event.preventDefault();if(selected)suggestions.delete(selected);hideSuggestion();}});
  input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();if(!sendButton!.disabled)composer.requestSubmit();}});

  skills=new DeskSkills(api,showError,input,composer,()=>composeState());
  attachments=new DeskAttachments(api,input,composer,()=>composeState());
  skills.trigger.hidden=true;attachments.trigger.hidden=true;

  // 底部极简工具栏（对照 HandWave .composer-toolbar）：+ 号、目标胶囊、模型胶囊 | 停止、圆形发送箭头。
  const toolbar=el('div','composer-toolbar'),left=el('div','ct-left'),right=el('div','ct-right');
  plusButton=el('button','ct-icon');plusButton.type='button';plusButton.title='添加附件或技能';plusButton.setAttribute('aria-label','添加附件或技能');plusButton.setAttribute('aria-haspopup','menu');plusButton.setAttribute('aria-expanded','false');
  plusButton.append(svg('0 0 24 24',['M12 5v14','M5 12h14'],17));
  plusButton.addEventListener('click',()=>toggleAttachMenu());

  attachMenu=el('div','attach-menu');attachMenu.hidden=true;attachMenu.setAttribute('role','menu');attachMenu.setAttribute('aria-label','添加附件或技能');
  const addFileItem=el('button','attach-item');addFileItem.type='button';addFileItem.setAttribute('role','menuitem');
  addFileItem.append(svg('0 0 24 24',['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z','M14 2v6h6'],15),el('span','','添加附件'));
  addFileItem.addEventListener('click',()=>{closeAttachMenu();attachments?.pick();});
  const pickSkillItem=el('button','attach-item');pickSkillItem.type='button';pickSkillItem.setAttribute('role','menuitem');
  attachSkillMeta=el('span','attach-item-meta');
  pickSkillItem.append(svg('0 0 24 24',['M12 3l-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z'],15),el('span','','选择技能'),attachSkillMeta);
  pickSkillItem.addEventListener('click',()=>{closeAttachMenu();skills?.openPickerFromMenu();});
  const manageSkillItem=el('button','attach-item');manageSkillItem.type='button';manageSkillItem.setAttribute('role','menuitem');
  manageSkillItem.append(svg('0 0 24 24',['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z','M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.79 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'],15),el('span','','管理技能'));
  manageSkillItem.addEventListener('click',()=>{closeAttachMenu();void skills?.openManager();});
  attachMenu.append(addFileItem,pickSkillItem,manageSkillItem);

  targetPill=el('button','ct-pill');targetPill.type='button';targetPill.title='选择执行设备与工作目录';
  targetPill.addEventListener('click',()=>toggleDrawer(true));
  modelPill=el('button','ct-pill model-pill');modelPill.type='button';modelPill.title='切换对话模型';modelPill.hidden=true;modelPill.setAttribute('aria-haspopup','listbox');modelPill.setAttribute('aria-expanded','false');
  modelPill.addEventListener('click',()=>{void toggleModelMenu();});
  modelMenu=el('div','model-menu');modelMenu.hidden=true;modelMenu.setAttribute('role','dialog');modelMenu.setAttribute('aria-label','切换对话模型');
  left.append(plusButton,targetPill,modelPill);

  stopButton=el('button','ct-stop');stopButton.type='button';stopButton.title='停止回答';stopButton.setAttribute('aria-label','停止回答');stopButton.hidden=true;
  stopButton.append(svg('0 0 24 24',['M7 7h10v10H7z'],14));
  stopButton.addEventListener('click',()=>{void stop().catch(error=>{if(!(error instanceof Stale))showError(error instanceof Error?error.message:'停止未完成');});});
  sendButton=el('button','ct-send');sendButton.type='submit';sendButton.title='发送消息';sendButton.setAttribute('aria-label','发送消息');
  sendButton.append(svg('0 0 24 24',['M12 19V5','M5 12l7-7 7 7'],16));
  right.append(stopButton,sendButton);
  toolbar.append(left,right);
  composer.append(attachMenu,modelMenu,attachments.bar,skills.bar,input,toolbar);
  composer.addEventListener('submit',event=>{event.preventDefault();if(busyNow()){queueInput();return;}void send().catch(error=>{if(!(error instanceof Stale))showError(error instanceof Error?error.message:'提交未完成');});});

  inner.append(latest,notice,queueBox,composer);wrap.append(inner);workspace.append(bar,transcript,wrap);

  // 右侧可展开「工具与连接」抽屉（对照 HandWave #asidePanel）。
  asideScrim=el('div','desk-scrim');asideScrim.hidden=true;asideScrim.addEventListener('click',()=>{toggleDrawer(false);toggleRailSheet(false);});
  asidePanel=el('aside','desk-aside');asidePanel.setAttribute('aria-label','工具与连接');asidePanel.hidden=true;
  const aHead=el('div','drawer-head'),aClose=el('button','q-icon','×');aClose.type='button';aClose.setAttribute('aria-label','关闭工具面板');aClose.addEventListener('click',()=>toggleDrawer(false));
  aHead.append(el('h2','','工具与连接'),aClose);

  // 0. 对话选项
  const optBlock=el('section','aside-block'),optHead=el('div','aside-bh'),optList=el('div','sheet-opts');
  optHead.append(el('span','','对话选项'));
  const makeOpt=(label:string,checked:boolean,onChange:(next:boolean)=>void)=>{
    const wrapOpt=el('label','opt-pill'),box=el('input');box.type='checkbox';box.checked=checked;
    box.addEventListener('change',()=>onChange(box.checked));
    wrapOpt.append(box,el('span','',label));return {wrapOpt,box};
  };
  const memOpt=makeOpt('记忆检索',optMemory,next=>{optMemory=next;saveBoolOpt(OPT_MEMORY_KEY,next);});
  const toolOpt=makeOpt('远程设备工具',optTools,next=>{optTools=next;saveBoolOpt(OPT_TOOLS_KEY,next);drawTarget();composeState();if(selected? !states.get(selected)?.messages.length:true)paint();});
  optMemCheck=memOpt.box;optToolCheck=toolOpt.box;
  optList.append(memOpt.wrapOpt,toolOpt.wrapOpt);optBlock.append(optHead,optList);

  // 1. 远程主机（按机器区分）
  const devBlock=el('section','aside-block'),devHead=el('div','aside-bh');
  const devRefresh=button('刷新',refreshDevices,'link');
  devHead.append(el('span','','远程主机'),devRefresh);
  devListBox=el('div','dev-list');devBlock.append(devHead,devListBox);

  // 2. 设备目录（按机器显示项目文件树）
  const treeBlock=el('section','aside-block'),treeHead=el('div','aside-bh');
  const treeRefresh=button('刷新树',()=>{if(treeHandle)treeHandle.refresh();else drawTreeBlock(true);},'link');
  treeHead.append(el('span','','设备目录'),treeRefresh);
  treeCwdRow=el('div','tree-cwd-row');
  cwdInput=el('input','tree-cwd-input');cwdInput.type='text';cwdInput.autocomplete='off';cwdInput.placeholder='填写该机器上的项目目录';
  const cwdLoadBtn=button('载入',()=>{clearTimeout(cwdSaveTimer);persistActiveWorkspaceBinding(currentTarget());drawTreeBlock(true);},'btn ghost sm');
  cwdInput.addEventListener('input',()=>{
    const target=currentTarget();if(!target)return;
    const next={...target,cwd:cwdInput!.value};targets.set(selected??'new',next);saveNodeCwd(target.nodeId,cwdInput!.value);
    clearTimeout(cwdSaveTimer);cwdSaveTimer=window.setTimeout(()=>persistActiveWorkspaceBinding(next),450);
    drawTarget();composeState();
  });
  cwdInput.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();clearTimeout(cwdSaveTimer);persistActiveWorkspaceBinding(currentTarget());drawTreeBlock(true);}});
  treeCwdRow.append(cwdInput,cwdLoadBtn);
  treeHint=el('p','aside-note','');
  treeWrap=el('div','aside-tree-wrap');
  treeBlock.append(treeHead,treeCwdRow,treeHint,treeWrap);

  // 3. 记忆与知识库
  const memBlock=el('section','aside-block'),memHead=el('div','aside-bh'),memActs=el('span','aside-bh-acts');
  memActs.append(button('+ 笔记',()=>openMemory(api,showError),'link'),button('管理',()=>openMemory(api,showError),'link'));
  memHead.append(el('span','','记忆与知识库'),memActs);
  asideMemoryBox=el('div','aside-memory');memBlock.append(memHead,asideMemoryBox);

  // 4. 工具明细
  const toolBlock=el('section','aside-block'),toolHead=el('div','aside-bh');
  asideToolsCount=el('em','','0 步');toolHead.append(el('span','','工具明细'),asideToolsCount);
  asideToolsBox=el('div','tool-well','尚无工具调用');toolBlock.append(toolHead,asideToolsBox);

  asidePanel.append(aHead,optBlock,devBlock,treeBlock,memBlock,toolBlock);
  ctxMenu=el('div','ctx-menu');ctxMenu.hidden=true;ctxMenu.setAttribute('role','menu');ctxMenu.setAttribute('aria-hidden','true');
  root.append(sidePanel,workspace,asideScrim,asidePanel,ctxMenu);
  paint();void showModel();void refreshDevices().catch(error=>{if(!(error instanceof Stale))showError('设备列表暂时不可用，请刷新设备。');});
}

function toggleAttachMenu(force?:boolean){
  if(!attachMenu||!plusButton)return;
  const open=force??attachMenu.hidden;
  if(open&&attachSkillMeta){const count=skills?.selected().length??0;attachSkillMeta.textContent=count?`已选 ${count}`:'';}
  attachMenu.hidden=!open;plusButton.setAttribute('aria-expanded',String(open));
}
function closeAttachMenu(){toggleAttachMenu(false);}

function toggleRail(){
  if(window.innerWidth<=960){toggleRailSheet();return;}
  railCollapsed=!railCollapsed;saveRailCollapsed(railCollapsed);
  deskRoot?.classList.toggle('rail-collapsed',railCollapsed);
  railToggle?.setAttribute('aria-expanded',String(!railCollapsed));
}
function toggleRailSheet(force?:boolean){
  if(!sidePanel||!asideScrim)return;
  railSheetOpen=force??!railSheetOpen;
  if(railSheetOpen&&drawerOpen)toggleDrawer(false);
  sidePanel.classList.toggle('sheet-open',railSheetOpen);
  asideScrim.hidden=!(drawerOpen||railSheetOpen);
  if(window.innerWidth<=960)railToggle?.setAttribute('aria-expanded',String(railSheetOpen));
}

function toggleDrawer(force?:boolean){
  if(!asidePanel||!asideScrim||!drawerToggle)return;
  drawerOpen=force??!drawerOpen;
  if(drawerOpen&&railSheetOpen)toggleRailSheet(false);
  asidePanel.hidden=!drawerOpen;asideScrim.hidden=!(drawerOpen||railSheetOpen);
  asidePanel.classList.toggle('open',drawerOpen);
  drawerToggle.setAttribute('aria-expanded',String(drawerOpen));
  if(drawerOpen){drawTarget();drawTreeBlock(false);void loadAsideMemory();drawToolLog();}
}

function activeWorkspace():Workspace|undefined{
  return workspaces.find(w=>w.id===selectedWorkspaceId)??workspaces[0];
}
function workspaceDeviceLabel(w:Workspace):string{
  if(!w.node_id)return '云端';
  const node=devices.find(n=>n.id===w.node_id&&!n.revoked);
  return node?node.name:w.node_id.slice(0,8);
}
function workspaceTarget(w:Workspace|undefined):Target|null{
  if(!w||!w.node_id)return null;
  const node=devices.find(n=>n.id===w.node_id&&!n.revoked);
  if(!node)return null;
  return {nodeId:node.id,epoch:node.epoch,cwd:w.cwd||readNodeCwd(node.id),name:node.name,platform:node.platform};
}
function persistActiveWorkspaceBinding(next:Target|null){
  const ws=activeWorkspace();if(!ws)return;
  const nodeId=next?.nodeId??null,cwd=next?.cwd??'';
  if(ws.node_id===nodeId&&ws.cwd===cwd)return;
  ws.node_id=nodeId;ws.cwd=cwd;drawSidebar();
  const version=epoch;
  void api<{workspace:Workspace}>('desk/workspaces/'+encodeURIComponent(ws.id),'PATCH',{nodeId,cwd})
    .then(res=>{if(version!==epoch)return;const idx=workspaces.findIndex(item=>item.id===ws.id);if(idx>=0)Object.assign(workspaces[idx],res.workspace);drawSidebar();})
    .catch(()=>{});
}

function chooseTarget(value:string){
  const node=devices.find(n=>n.id+'@'+n.epoch===value);
  const previous=currentTarget();
  const remembered=node?(previous?.nodeId===node.id?previous.cwd:readNodeCwd(node.id)):'';
  const next:Target|null=node?{nodeId:node.id,epoch:node.epoch,cwd:remembered,name:node.name,platform:node.platform}:null;
  targets.set(selected??'new',next);
  clearTimeout(cwdSaveTimer);persistActiveWorkspaceBinding(next);
  drawTarget();drawTreeBlock(true);composeState();
  if(node&&!remembered)cwdInput?.focus();
}
function currentTarget():Target|null{
  const key=selected??'new';
  if(targets.has(key))return targets.get(key)??null;
  return selected?states.get(selected)?.messages.at(-1)?.target??workspaceTarget(activeWorkspace()):workspaceTarget(activeWorkspace());
}
function effectiveTarget():Target|null{
  return optTools?currentTarget():null;
}
async function refreshDevices(){
  const token=++deviceSequence,result=await api<{nodes:DeviceNode[]}>('desk/devices');
  if(token!==deviceSequence)return;
  devices=result.nodes;
  if(!selected&&!targets.get('new')){const wt=workspaceTarget(activeWorkspace());if(wt)targets.set('new',wt);}
  drawSidebar();drawTarget();if(drawerOpen)drawTreeBlock(false);composeState();
}
function drawTarget(){
  const target=currentTarget();
  const node=target?devices.find(n=>n.id===target.nodeId&&n.epoch===target.epoch&&!n.revoked):null;
  const online=!!node?.online;
  const paused=!!target&&!optTools;
  if(connPill){
    const label=paused?'云端（设备已暂停）':target?(target.name??node?.name??'设备'):'云端对话';
    connPill.replaceChildren(el('i','conn-dot'+(target&&!paused?(online?' on':' off'):'')),el('span','',label));
    connPill.title=paused?'已关闭远程设备工具，本次对话仅在云端执行':target?`${target.name??node?.name??'设备'} · ${target.cwd||'未填写目录'}`:'点击选择远程设备或工作目录';
  }
  if(targetPill){
    const label=paused?'云端（已暂停设备）':target?(target.name??node?.name??'设备'):'云端';
    targetPill.replaceChildren(el('i','conn-dot'+(target&&!paused?(online?' on':' off'):'')),el('span','',label));
    targetPill.title=paused?'远程设备工具已暂停，点此去恢复或切换':target?`执行位置：${target.name??'设备'}${target.cwd?` (${target.cwd})`:''}`:'当前在云端对话，点击切换设备';
  }
  if(devListBox){
    const rows:HTMLElement[]=[];
    const cloud=el('button','dev-row'+(!target?' active':''));cloud.type='button';
    cloud.append(el('span','dev-row-main',),el('span','dev-badge','默认'));
    cloud.firstElementChild!.append(el('b','','云端直接对话'),el('small','','不使用远程设备，仅云端模型与记忆'));
    cloud.addEventListener('click',()=>chooseTarget(''));
    rows.push(cloud);
    for(const n of devices.filter(item=>!item.revoked)){
      const active=target?.nodeId===n.id&&target.epoch===n.epoch;
      const row=el('button','dev-row'+(active?' active':''));row.type='button';
      const main=el('span','dev-row-main'),savedCwd=active?target!.cwd:readNodeCwd(n.id);
      main.append(el('b','',n.name),el('small','',`${n.platform}${savedCwd?' · '+savedCwd:''}`));
      row.append(main,el('span','dev-badge'+(n.online?' ok':''),n.online?'在线':'离线'));
      row.addEventListener('click',()=>chooseTarget(`${n.id}@${n.epoch}`));
      rows.push(row);
    }
    devListBox.replaceChildren(...rows);
  }
  if(cwdInput){
    cwdInput.value=target?.cwd??'';
    cwdInput.disabled=!target;
    cwdInput.placeholder=target?.platform==='windows'?'例如 E:\\项目目录':'例如 /home/user/project';
  }
  if(treeCwdRow)treeCwdRow.hidden=!target;
}

function drawTreeBlock(forceReload:boolean){
  if(!treeWrap||!treeHint)return;
  const target=currentTarget();
  const node=target?devices.find(n=>n.id===target.nodeId&&n.epoch===target.epoch&&!n.revoked):null;
  if(!target||!node){
    treeHandle?.dispose();treeHandle=null;treeKey='';treeWrap.replaceChildren();
    treeHint.hidden=false;treeHint.textContent='在上方选择一台设备后，可按该机器显示并浏览项目目录。';
    return;
  }
  if(!target.cwd.trim()){
    treeHandle?.dispose();treeHandle=null;treeKey='';treeWrap.replaceChildren();
    treeHint.hidden=false;treeHint.textContent=`已选「${node.name}」，填写该机器上的目录路径并点「载入」。`;
    return;
  }
  if(!node.online){
    treeHandle?.dispose();treeHandle=null;treeKey='';treeWrap.replaceChildren();
    treeHint.hidden=false;treeHint.textContent=`设备「${node.name}」当前离线，上线后可点「刷新树」加载目录。`;
    return;
  }
  treeHint.hidden=true;
  const nextKey=`${target.nodeId}@${target.epoch}:${target.cwd}`;
  if(!forceReload&&treeKey===nextKey&&treeHandle)return;
  treeHandle?.dispose();treeKey=nextKey;
  treeHandle=mountWorkspaceTree(treeWrap,api,{nodeId:target.nodeId,cwd:target.cwd,name:node.name,platform:target.platform},insertPath);
}

async function loadAsideMemory(){
  if(!asideMemoryBox)return;
  const version=epoch;asideMemoryBox.textContent='读取中…';
  try{
    const ov=await api<MemoryOverview>('desk/memory');
    if(version!==epoch||!asideMemoryBox)return;
    const box=el('div','aside-mem-list');
    if(ov.notes.length){
      for(const n of ov.notes.slice(0,6)){
        const item=el('button','kb-row');item.type='button';item.append(el('span','',n.title),el('small','','笔记'));
        item.addEventListener('click',()=>openMemory(api,showError));box.append(item);
      }
    }else box.append(el('p','aside-note','暂无「我的笔记」，点右上「管理」可添加。'));
    box.append(el('p','aside-mem-meta',`Agent 知识 ${ov.entries.length} 条 · Agent 技能 ${ov.agentSkills.length} 个`));
    asideMemoryBox.replaceChildren(box);
  }catch{if(asideMemoryBox)asideMemoryBox.textContent='记忆概览读取失败';}
}

function drawToolLog(){
  if(!asideToolsBox||!asideToolsCount)return;
  const state=selected?states.get(selected):undefined;
  const entries:{turnIndex:number;step:Step}[]=[];
  state?.messages.forEach((t,idx)=>{for(const s of t.steps??[])entries.push({turnIndex:idx+1,step:s});});
  asideToolsCount.textContent=`${entries.length} 步`;
  if(!entries.length){asideToolsBox.replaceChildren(el('p','aside-note','尚无工具调用'));return;}
  const list=el('div','tool-log-list');
  const label:Record<string,string>={run:'进行中',ok:'完成',bad:'失败',warn:'效果未知'};
  for(const {turnIndex,step} of [...entries].reverse()){
    const tone=stepTone(step),row=el('details',`tool-log-item t-${tone}`);
    const sum=el('summary');sum.append(el('i','dot'),el('span','tool-log-name',step.title),el('span','tool-log-meta',`#${turnIndex} · ${label[tone]}`));
    row.append(sum);
    if(step.detail)row.append(el('pre','tool-step-detail',step.detail));
    if(step.ended&&step.output)row.append(el('pre','tool-step-output',step.output));
    list.append(row);
  }
  asideToolsBox.replaceChildren(list);
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
function sortConversationsList(){
  conversations.sort((a,b)=>((b.pinned??0)-(a.pinned??0))||((b.pinned_at??0)-(a.pinned_at??0))||(b.created_at-a.created_at));
}
function toggleWSCollapsed(wsId:string){
  if(collapsedWS.has(wsId))collapsedWS.delete(wsId);else collapsedWS.add(wsId);
  saveCollapsedSet(collapsedWS);
  const folder=sidebar?.querySelector(`.ws-folder[data-ws-id="${wsId}"]`);
  if(folder){folder.classList.toggle('collapsed',collapsedWS.has(wsId));folder.setAttribute('aria-expanded',String(!collapsedWS.has(wsId)));}
}
function wantedConversation(){const id=location.hash.replace(/^#\/desk\/?/,'').split(/[/?]/)[0];return uuid.test(id)?id.toLowerCase():null;}
async function load(){
  const version=epoch,sequence=++listSequence,viewAtRead=view;
  const [wsRes,convRes]=await Promise.all([api<{workspaces:Workspace[]}>('desk/workspaces'),api<{conversations:Conversation[]}>('desk/conversations')]);
  if(version!==epoch||sequence!==listSequence)return;
  workspaces=wsRes.workspaces;
  conversations=convRes.conversations.map(item=>({...item,...applySettlement(item.id,item)}));
  sortConversationsList();
  const wanted=wantedConversation();
  const wantedConv=wanted?conversations.find(c=>c.id===wanted):undefined;
  if(wantedConv?.workspace_id&&workspaces.some(w=>w.id===wantedConv.workspace_id))selectedWorkspaceId=wantedConv.workspace_id;
  else if(!selectedWorkspaceId||!workspaces.some(w=>w.id===selectedWorkspaceId))selectedWorkspaceId=workspaces[0]?.id??null;
  if(selectedWorkspaceId)collapsedWS.delete(selectedWorkspaceId);
  drawSidebar();if(viewAtRead!==view)return;
  if(wanted)await open(wanted,selectedWorkspaceId??undefined);else newConversation();
}
function drawSidebar(){
  if(!sidebar)return;
  closeCtxMenu();
  if(!workspaces.length){sidebar.replaceChildren(el('p','empty-history','暂无工作区，点上方「新建工作区」'));return;}
  const defaultWsId=workspaces[0].id;
  const validWsIds=new Set(workspaces.map(w=>w.id));
  const grouped=new Map<string,Conversation[]>();
  for(const w of workspaces)grouped.set(w.id,[]);
  for(const conv of conversations){
    const wsId=conv.workspace_id&&validWsIds.has(conv.workspace_id)?conv.workspace_id:defaultWsId;
    grouped.get(wsId)!.push(conv);
  }
  const nodes:HTMLElement[]=[];
  for(const w of workspaces){
    const allItems=grouped.get(w.id)??[];
    if(railQuery){
      const wsMatches=w.name.toLowerCase().includes(railQuery);
      const matchedItems=allItems.filter(c=>c.title.toLowerCase().includes(railQuery));
      if(!wsMatches&&!matchedItems.length)continue;
      nodes.push(workspaceFolder(w,matchedItems.length||!wsMatches?matchedItems:allItems,true));
    }else nodes.push(workspaceFolder(w,allItems,false));
  }
  if(!nodes.length){sidebar.replaceChildren(el('p','empty-history','没有匹配的工作区或对话。'));return;}
  sidebar.replaceChildren(...nodes);
}
function workspaceFolder(w:Workspace,items:Conversation[],forceExpand:boolean){
  const collapsed=!forceExpand&&collapsedWS.has(w.id);
  const folder=el('div','ws-folder'+(collapsed?' collapsed':''));
  folder.dataset.wsId=w.id;folder.setAttribute('role','treeitem');folder.setAttribute('aria-expanded',String(!collapsed));
  const frow=el('div','ws-folder-row'+(selectedWorkspaceId===w.id&&!selected?' on':''));
  const main=el('button','ws-folder-main');main.type='button';
  const chev=el('span','chev');chev.append(svg('0 0 24 24',['M6 9l6 6 6-6'],13));
  const ico=svg('0 0 24 24',['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z'],14,'ic ws-folder-ico');
  const label=el('span','label',w.name);label.title=w.name;
  const sub=el('span','sub',workspaceDeviceLabel(w));sub.title=w.cwd?`${workspaceDeviceLabel(w)} · ${w.cwd}`:workspaceDeviceLabel(w);
  main.append(chev,ico,label,sub);
  main.addEventListener('click',event=>{
    if((event.target as Element|null)?.closest('.chev')){event.stopPropagation();toggleWSCollapsed(w.id);return;}
    selectWorkspace(w);
  });
  const more=el('button','row-more','⋯');more.type='button';more.title='工作区操作';more.setAttribute('aria-label',`「${w.name}」的操作`);more.setAttribute('aria-haspopup','menu');
  more.addEventListener('click',event=>{event.stopPropagation();const rect=more.getBoundingClientRect();openCtxMenu(rect.right,rect.bottom+4,{kind:'ws',ws:w});});
  frow.addEventListener('contextmenu',event=>{event.preventDefault();event.stopPropagation();openCtxMenu(event.clientX,event.clientY,{kind:'ws',ws:w});});
  frow.append(main,more);
  folder.append(frow);

  const kids=el('div','ws-folder-kids');kids.setAttribute('role','group');
  if(!items.length)kids.append(el('p','ws-empty','暂无会话'));
  else for(const conv of items)kids.append(conversationRow(w,conv));
  folder.append(kids);return folder;
}
function conversationRow(w:Workspace,conversation:Conversation){
  const isLive=!!states.get(conversation.id)?.messages.some(live);
  const row=el('div','ws-sess-row'+(selected===conversation.id?' on':'')+(conversation.pinned?' pinned':'')+(isLive?' live':''));
  row.dataset.convId=conversation.id;
  const main=el('button','ws-sess-main');main.type='button';main.title=conversation.title;
  if(selected===conversation.id)main.setAttribute('aria-current','page');
  main.append(el('span','ws-sess-dot'),el('span','label',conversation.title));
  if(conversation.pinned)main.append(svg('0 0 24 24',['M12 17v5','M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'],12,'ic pin-ico'));
  main.addEventListener('click',()=>{void open(conversation.id,w.id);});
  const more=el('button','row-more','⋯');more.type='button';more.title='更多操作';more.setAttribute('aria-label',`「${conversation.title}」的更多操作`);more.setAttribute('aria-haspopup','menu');
  more.addEventListener('click',event=>{event.stopPropagation();const rect=more.getBoundingClientRect();openCtxMenu(rect.right,rect.bottom+4,{kind:'sess',ws:w,conv:conversation});});
  row.addEventListener('contextmenu',event=>{event.preventDefault();event.stopPropagation();openCtxMenu(event.clientX,event.clientY,{kind:'sess',ws:w,conv:conversation});});
  row.append(main,more);return row;
}
function closeCtxMenu(){if(!ctxMenu)return;ctxMenu.hidden=true;ctxMenu.setAttribute('aria-hidden','true');ctxMenu.replaceChildren();ctxTarget=null;}
function openCtxMenu(x:number,y:number,target:{kind:'ws';ws:Workspace}|{kind:'sess';ws:Workspace;conv:Conversation}){
  if(!ctxMenu)return;
  closeCtxMenu();ctxTarget=target;
  const items:HTMLElement[]=[];
  const mkItem=(label:string,paths:string[],action:()=>unknown,cls='')=>{
    const b=el('button','ctx-item'+(cls?' '+cls:''));b.type='button';b.setAttribute('role','menuitem');
    b.append(svg('0 0 24 24',paths,14),el('span','',label));
    b.addEventListener('click',()=>{void Promise.resolve().then(action).catch(error=>{if(!(error instanceof Stale))showError(error instanceof Error?error.message:'操作未完成');});});
    return b;
  };
  if(target.kind==='ws'){
    const {ws}=target;
    items.push(mkItem('新建会话',['M12 5v14','M5 12h14'],()=>{closeCtxMenu();newConversation(ws.id);}));
    items.push(mkItem('绑定设备与目录',['M4 6h16','M4 12h16','M4 18h16','M9 4v4','M15 10v4','M9 16v4'],()=>{closeCtxMenu();selectWorkspace(ws);toggleDrawer(true);}));
    items.push(mkItem('重命名',['M12 20h9','M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'],()=>{closeCtxMenu();startRenameWorkspace(ws);}));
    items.push(el('div','ctx-sep'));
    const del=mkItem('删除工作区',['M3 6h18','M8 6V4h8v2','M19 6l-1 14H6L5 6'],async()=>{
      if(del.dataset.armed!=='1'){del.dataset.armed='1';del.classList.add('armed');del.querySelector('span')!.textContent='确认删除工作区';return;}
      closeCtxMenu();await removeWorkspace(ws);
    },'danger');
    items.push(del,el('p','ctx-note','删除工作区会隐藏其中的对话记录，服务器端证据仍保留。'));
  }else{
    const {conv}=target;
    const pinLabel=conv.pinned?'取消置顶':'置顶';
    items.push(mkItem(pinLabel,['M12 17v5','M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'],async()=>{
      closeCtxMenu();
      const res=await api<{conversation:Conversation}>('desk/conversations/'+encodeURIComponent(conv.id),'PATCH',{pinned:!conv.pinned});
      const existing=conversations.find(item=>item.id===conv.id);if(existing)Object.assign(existing,res.conversation);
      sortConversationsList();drawSidebar();
    }));
    items.push(mkItem('重命名',['M12 20h9','M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'],()=>{closeCtxMenu();startRename(conv);}));
    items.push(el('div','ctx-sep'));
    const del=mkItem('删除',['M3 6h18','M8 6V4h8v2','M19 6l-1 14H6L5 6'],async()=>{
      if(del.dataset.armed!=='1'){del.dataset.armed='1';del.classList.add('armed');del.querySelector('span')!.textContent='确认删除';return;}
      closeCtxMenu();await removeConversation(conv);
    },'danger');
    items.push(del,el('p','ctx-note','删除只从列表移除，消息记录仍保留在服务器。'));
  }
  ctxMenu.replaceChildren(...items);ctxMenu.hidden=false;ctxMenu.setAttribute('aria-hidden','false');
  const pad=8,mw=ctxMenu.offsetWidth||188,mh=ctxMenu.offsetHeight||160;
  let left=x,top=y;
  if(left+mw>window.innerWidth-pad)left=window.innerWidth-mw-pad;
  if(top+mh>window.innerHeight-pad)top=window.innerHeight-mh-pad;
  if(left<pad)left=pad;if(top<pad)top=pad;
  ctxMenu.style.left=left+'px';ctxMenu.style.top=top+'px';
  (ctxMenu.querySelector('.ctx-item') as HTMLElement|null)?.focus();
}
document.addEventListener('pointerdown',event=>{
  if(ctxMenu&&!ctxMenu.hidden&&!(event.target instanceof Node&&ctxMenu.contains(event.target)))closeCtxMenu();
  if(attachMenu&&!attachMenu.hidden&&event.target instanceof Node&&!attachMenu.contains(event.target)&&!plusButton?.contains(event.target))closeAttachMenu();
  if(modelMenu&&!modelMenu.hidden&&event.target instanceof Node&&!modelMenu.contains(event.target)&&!modelPill?.contains(event.target))closeModelMenu();
});
document.addEventListener('keydown',event=>{
  if(!context)return;
  if(event.key==='Escape'){
    if(ctxMenu&&!ctxMenu.hidden){closeCtxMenu();return;}
    if(attachMenu&&!attachMenu.hidden){closeAttachMenu();plusButton?.focus();return;}
    if(modelMenu&&!modelMenu.hidden){closeModelMenu();modelPill?.focus();return;}
    if(railSheetOpen){toggleRailSheet(false);railToggle?.focus();return;}
    if(drawerOpen){toggleDrawer(false);drawerToggle?.focus();}
    return;
  }
  if((event.ctrlKey||event.metaKey)&&!event.altKey&&(event.key==='n'||event.key==='N')){
    if(document.querySelector('dialog[open]'))return;
    event.preventDefault();newConversation();
  }
});
window.addEventListener('resize',()=>{
  closeCtxMenu();
  if(!context)return;
  if(window.innerWidth>960&&railSheetOpen)toggleRailSheet(false);
  deskRoot?.classList.toggle('rail-collapsed',railCollapsed&&window.innerWidth>960);
  if(railToggle)railToggle.setAttribute('aria-expanded',String(window.innerWidth>960?!railCollapsed:railSheetOpen));
});

function startRename(conversation:Conversation){
  const row=sidebar?.querySelector<HTMLElement>(`.ws-sess-row[data-conv-id="${conversation.id}"]`);
  if(!row)return;
  const field=el('input','conversation-rename');field.value=conversation.title;field.maxLength=120;field.setAttribute('aria-label','对话名称');
  row.replaceChildren(field);field.focus();field.select();let done=false;
  const finish=async(save:boolean)=>{
    if(done)return;done=true;const nextTitle=field.value.trim();
    if(!save||!nextTitle||nextTitle===conversation.title){drawSidebar();return;}
    try{const result=await api<{conversation:Conversation}>('desk/conversations/'+encodeURIComponent(conversation.id),'PATCH',{title:nextTitle});applyTitle(result.conversation.id,result.conversation.title);}
    catch(error){if(!(error instanceof Stale))showError(error instanceof Error?error.message:'改名未完成');drawSidebar();}
  };
  field.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();void finish(true);}else if(event.key==='Escape'){event.preventDefault();void finish(false);}});
  field.addEventListener('blur',()=>{void finish(true);});
}
function startRenameWorkspace(ws:Workspace){
  const row=sidebar?.querySelector<HTMLElement>(`.ws-folder[data-ws-id="${ws.id}"] > .ws-folder-row`);
  if(!row)return;
  const field=el('input','conversation-rename');field.value=ws.name;field.maxLength=80;field.setAttribute('aria-label','工作区名称');
  row.replaceChildren(field);field.focus();field.select();let done=false;
  const finish=async(save:boolean)=>{
    if(done)return;done=true;const nextName=field.value.trim();
    if(!save||!nextName||nextName===ws.name){drawSidebar();return;}
    try{
      const result=await api<{workspace:Workspace}>('desk/workspaces/'+encodeURIComponent(ws.id),'PATCH',{name:nextName});
      Object.assign(ws,result.workspace);paint();
    }catch(error){if(!(error instanceof Stale))showError(error instanceof Error?error.message:'工作区改名未完成');drawSidebar();}
  };
  field.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();void finish(true);}else if(event.key==='Escape'){event.preventDefault();void finish(false);}});
  field.addEventListener('blur',()=>{void finish(true);});
}
function openCreateWorkspaceDialog(){
  const dialog=el('dialog','ws-dialog');dialog.setAttribute('aria-labelledby','wsCreateTitle');
  const titleEl=el('h2','','新建工作区');titleEl.id='wsCreateTitle';
  const lead=el('p','','工作区用来分组会话，并记住它绑定的执行设备与目录。');
  const form=el('form','form');
  const nameField=el('input');nameField.maxLength=80;nameField.required=true;nameField.placeholder='例如：后端排查 / 前端重构';nameField.value='';
  const devSelect=el('select');
  devSelect.append(new Option('云端直接对话（不绑定设备）',''));
  for(const n of devices.filter(item=>!item.revoked))devSelect.append(new Option(`${n.name}（${n.platform} · ${n.online?'在线':'离线'}）`,n.id));
  const cwdField=el('input');cwdField.maxLength=1024;cwdField.placeholder='可选，例如 E:\\repos\\project';cwdField.disabled=true;
  devSelect.addEventListener('change',()=>{
    const id=devSelect.value;cwdField.disabled=!id;
    if(id&&!cwdField.value.trim()){const saved=readNodeCwd(id);if(saved)cwdField.value=saved;}
  });
  const wrapField=(labelText:string,control:HTMLElement)=>{const box=el('label','field');box.append(el('span','',labelText),control);return box;};
  const status=el('p','skill-form-status');status.setAttribute('role','status');
  const acts=el('div','ws-dialog-actions');
  const cancelBtn=button('取消',()=>dialog.close(),'btn ghost');
  const submitBtn=el('button','btn primary','创建工作区');submitBtn.type='submit';
  acts.append(cancelBtn,submitBtn);
  form.append(wrapField('工作区名称',nameField),wrapField('默认执行设备',devSelect),wrapField('默认项目目录',cwdField),status,acts);
  form.addEventListener('submit',event=>{
    event.preventDefault();const name=nameField.value.trim();if(!name){status.textContent='请填写工作区名称';return;}
    submitBtn.disabled=true;status.textContent='';
    const nodeId=devSelect.value||null,cwd=nodeId?cwdField.value.trim():'';
    void api<{workspace:Workspace}>('desk/workspaces','POST',{name,nodeId,cwd})
      .then(res=>{
        if(nodeId&&cwd)saveNodeCwd(nodeId,cwd);
        workspaces.push(res.workspace);
        collapsedWS.delete(res.workspace.id);saveCollapsedSet(collapsedWS);
        dialog.close();selectWorkspace(res.workspace);
      })
      .catch(error=>{status.textContent=error instanceof Error?error.message:'创建工作区失败';})
      .finally(()=>{submitBtn.disabled=false;});
  });
  dialog.addEventListener('close',()=>dialog.remove());
  dialog.append(titleEl,lead,form);document.body.append(dialog);dialog.showModal();nameField.focus();
}
function applyTitle(id:string,value:string){
  for(const item of conversations)if(item.id===id)item.title=value;const state=states.get(id);if(state)state.conversation.title=value;
  drawSidebar();if(selected===id&&title){const ws=activeWorkspace();title.textContent=ws?`${ws.name} · ${value}`:value;}
}
async function removeConversation(conversation:Conversation){
  await api('desk/conversations/'+encodeURIComponent(conversation.id),'DELETE');
  conversations=conversations.filter(item=>item.id!==conversation.id);states.delete(conversation.id);queues.delete(conversation.id);drafts.delete(conversation.id);targets.delete(conversation.id);
  if(selected===conversation.id)newConversation();else drawSidebar();
}
async function removeWorkspace(ws:Workspace){
  await api('desk/workspaces/'+encodeURIComponent(ws.id),'DELETE');
  const removedIds=new Set(conversations.filter(c=>c.workspace_id===ws.id).map(c=>c.id));
  for(const cid of removedIds){states.delete(cid);queues.delete(cid);drafts.delete(cid);targets.delete(cid);}
  conversations=conversations.filter(c=>c.workspace_id!==ws.id);
  workspaces=workspaces.filter(item=>item.id!==ws.id);
  collapsedWS.delete(ws.id);saveCollapsedSet(collapsedWS);
  if(!workspaces.length){await load();return;}
  if(selectedWorkspaceId===ws.id){
    selectedWorkspaceId=workspaces[0].id;
    if(selected&&removedIds.has(selected))newConversation(selectedWorkspaceId);
    else paint();
  }else if(selected&&removedIds.has(selected))newConversation();
  else drawSidebar();
}
function address(){if(!location.hash.startsWith('#/desk'))return;history.replaceState(null,'',`${location.pathname}${location.search}#/desk${selected?'/'+selected:''}`);}
function selectWorkspace(ws:Workspace){
  view++;selected=null;selectedWorkspaceId=ws.id;
  if(collapsedWS.has(ws.id)){collapsedWS.delete(ws.id);saveCollapsedSet(collapsedWS);}
  targets.set('new',workspaceTarget(ws));
  address();paint();toggleRailSheet(false);input?.focus();
}
function newConversation(wsId?:string){
  if(wsId&&workspaces.some(w=>w.id===wsId))selectedWorkspaceId=wsId;
  const ws=activeWorkspace();
  if(ws){collapsedWS.delete(ws.id);saveCollapsedSet(collapsedWS);targets.set('new',workspaceTarget(ws));}
  else targets.delete('new');
  view++;selected=null;address();paint();toggleRailSheet(false);input?.focus();
}
async function open(id:string,explicitWsId?:string){
  const token=++view,version=epoch;selected=id;
  const listed=conversations.find(item=>item.id===id);
  const wsId=explicitWsId??listed?.workspace_id??workspaces[0]?.id??null;
  if(wsId){selectedWorkspaceId=wsId;collapsedWS.delete(wsId);saveCollapsedSet(collapsedWS);}
  address();paint();toggleRailSheet(false);
  try{const result=await api<{conversation:Conversation;messages:Turn[]}>('desk/conversations/'+encodeURIComponent(id));if(token!==view||version!==epoch)return;
    const old=states.get(id);for(const active of streams.values())if(active.turn.conversationId===id&&!result.messages.some(turn=>turn.id===active.turn.id))result.messages.push(active.turn);
    result.messages=result.messages.map(turn=>streams.get(turn.id)?.turn??old?.messages.find(existing=>existing.id===turn.id&&existing.status==='submitting')??turn);
    Object.assign(result.conversation,applySettlement(id,result.conversation));
    if(listed){result.conversation.workspace_id=listed.workspace_id;result.conversation.pinned=listed.pinned;result.conversation.pinned_at=listed.pinned_at;}
    states.set(id,result);paint();for(const turn of result.messages)if(!streams.has(turn.id)&&(live(turn)||(!turn.output&&['cancelled','unknown','failed'].includes(turn.status))))void observe(turn).catch(()=>{});
  }catch(error){if(token===view&&!(error instanceof Stale))showError(error instanceof Error?error.message:'对话读取失败');}
}
function paint(){
  if(!transcript||!input||!title)return;for(const nodes of messageNodes.values())nodes.gallery.dispose();messageNodes.clear();transcript.replaceChildren();drawSidebar();notice!.textContent='';latest!.hidden=true;
  const state=selected?states.get(selected):undefined,ws=activeWorkspace();
  const baseTitle=state?.conversation.title??(selected?'正在读取对话…':'新会话');
  title.textContent=ws?`${ws.name} · ${baseTitle}`:baseTitle;
  input.value=drafts.get(selected??'new')??'';
  if(!state?.messages.length){
    const target=effectiveTarget(),place=target?`设备「${target.name??'已配对设备'}」`:'云端直接对话';
    const sub=ws?`工作区「${ws.name}」· 当前在${place}。点右上「工具与连接」可切换主机、目录、记忆与工具。`:'整理一个问题，推敲一个想法，或者点右上「工具与连接」选中已配对的设备动手。';
    const welcome=el('section','welcome');welcome.append(el('p','eyebrow',greeting()+'，'+(user?.username??'')),el('h2','',selected?'从这里继续':'先把想做的事，聊清楚。'),el('p','',sub),welcomeChips());transcript.append(welcome);
  }
  else for(const turn of state.messages)appendMessage(turn);
  updateNotice();drawTarget();if(drawerOpen){drawTreeBlock(false);drawToolLog();}
  skills?.use(selected??'new');attachments?.use(selected??'new');showSuggestion();composeState();drawQueue();transcript.scrollTop=transcript.scrollHeight;
}
function appendMessage(turn:Turn){
  const userMessage=el('article','message user');userMessage.append(el('div','speaker','你'),el('div','body',turn.content));
  if(turn.target)userMessage.append(el('p','message-target',(turn.target.name??'Reach 设备')+' · '+turn.target.cwd));
  if(turn.attachments?.length)userMessage.append(attachmentList(turn.attachments,id=>new URL('desk/attachments/'+id,apiBase).href));
  if(turn.skills?.length)userMessage.append(el('p','message-skills','技能：'+turn.skills.map(skill=>skill.name||'已删除的技能').join('、')));
  const assistant=el('article','message assistant'),speaker=el('div','speaker');const mark=el('img');mark.src=logo;mark.alt='';speaker.append(mark,el('span','','Reach'));
  const body=el('div','body md'),status=el('div','message-status'),record=button('查询原记录',()=>query(turn),'quiet'),operations=el('div','device-operations'),images=el('div','device-images'),steps=el('details','tool-steps');
  const copyAnswer=el('button','quiet copy-answer','复制回答');copyAnswer.type='button';copyAnswer.hidden=true;
  copyAnswer.addEventListener('click',()=>{void copyText(turn.output,ok=>{copyAnswer.textContent=ok?'已复制':'复制失败';window.setTimeout(()=>{if(copyAnswer.isConnected)copyAnswer.textContent='复制回答';},1200);});});
  const actionsRow=el('div','message-actions');actionsRow.append(copyAnswer,record);
  const version=epoch,paintView=view;const gallery:ImageGallery=new ImageGallery(images,{deviceName:turn.target?.name??'Reach 设备',current:()=>version===epoch&&paintView===view&&selected===turn.conversationId&&states.get(turn.conversationId)?.messages.find(t=>t.id===turn.id)===turn&&messageNodes.get(turn.id)?.gallery===gallery,fetch:async(image,signal)=>{const response=await fetch(new URL('desk/messages/'+encodeURIComponent(turn.id)+'/images/'+encodeURIComponent(image.callKey),apiBase),{credentials:'same-origin',headers:{accept:'image/png'},signal});if(version!==epoch||paintView!==view)throw new Stale();if(response.status===401){expired();throw new Stale();}return response;}});
  const agent=new AgentPanel({guide:text=>guide(turn,text),retry:()=>retry(turn)});
  record.hidden=true;assistant.append(speaker,steps,operations,images,body,status,agent.root,actionsRow);transcript!.append(userMessage,assistant);messageNodes.set(turn.id,{body,status,record,copyAnswer,operations,gallery,steps,agent});update(turn);
}
function update(turn:Turn){
  if(selected!==turn.conversationId)return;const nodes=messageNodes.get(turn.id);if(!nodes)return;
  const stick=transcript!.scrollHeight-transcript!.scrollTop-transcript!.clientHeight<90;
  nodes.body.innerHTML=turn.output?renderMarkdown(turn.output):'';
  nodes.copyAnswer.hidden=!turn.output.trim();
  const labels:Record<string,string>={submitting:'正在提交消息…',starting:'已接收，正在准备回答…',running:'正在处理…',cancelling:'已请求停止，正在核对结果…',completed:'回答已保存',cancelled:'已停止',failed:'回答未完成，原记录已保留',unknown:'结果尚未确定，原记录已保留',unconfirmed:'连接中断，尚未确认原消息状态',rejected:'本次提交未被接受，消息已保留'};
  nodes.status.textContent=turn.observationLost?'连接中断，请查询原记录。':labels[turn.status]??turn.status;nodes.status.className='message-status'+(['unknown','unconfirmed','cancelled','cancelling'].includes(turn.status)||turn.observationLost?' warn':turn.status==='failed'?' bad':'');nodes.record.hidden=!(['unknown','unconfirmed','failed'].includes(turn.status)||turn.observationLost);
  const operations=new Map((turn.operations??turn.deviceCalls?.map(c=>c.operation).filter((op):op is DeviceOperation=>!!op)??[]).map(op=>[op.operationId,op]));nodes.operations.replaceChildren();
  nodes.gallery.update(turn.images??[]);
  paintSteps(nodes.steps,turn.steps);
  {const state=states.get(turn.conversationId),running=live(turn),steps=turn.steps??[];nodes.agent.update({live:running,createdAt:turn.createdAt,steps:steps.length,running:steps.filter(step=>!step.ended).length,guidance:turn.guidance??[],
    canGuide:['starting','running'].includes(turn.status)&&!turn.cancelRequested,canRetry:!running&&['completed','failed','cancelled','rejected'].includes(turn.status)&&state?.messages.at(-1)===turn&&!state.conversation.blocked&&!state.conversation.settlement_conflict,showGuideForm:false});}
  const names:Record<string,string>={not_observed:'等待设备接收',received:'设备已接收',running:'设备执行中',succeeded:'原操作成功',failed:'原操作失败',cancelled:'原操作已取消',unknown:'原操作效果未知'};
  for(const op of operations.values()){const row=el('a','device-operation');row.href='#/operations/'+op.operationId;row.title='查看原操作记录';const state=el('span','',names[op.execution]??op.execution);row.append(state,el('code','',op.operationId));if(op.cancelRequested&&!['succeeded','failed','cancelled','unknown'].includes(op.execution))row.append(el('span','','已请求停止'));nodes.operations.append(row);}
  updateNotice();if(drawerOpen)drawToolLog();
  if(stick)transcript!.scrollTop=transcript!.scrollHeight;else latest!.hidden=false;composeState();
}
function updateNotice(){if(!notice)return;const state=selected?states.get(selected):undefined;if(state?.conversation.settlement_conflict)notice.textContent='正在核对会话状态，原记录和草稿已保留。';else if(state?.conversation.blocked)notice.textContent=state.messages.some(turn=>turn.status==='cancelling')?'正在核对停止后的会话状态，原记录和草稿已保留。':'上一条消息尚未结算，原记录已保留。核对后再继续；也可以另开一段对话。';else if(notice.textContent?.startsWith('正在核对')||notice.textContent?.startsWith('上一条消息尚未结算'))notice.textContent='';}
function composeState(){
  if(!input||!sendButton||!stopButton)return;
  const state=selected?states.get(selected):undefined,current=state?.messages.find(live),target=effectiveTarget(),targetInvalid=!!target&&(!target.cwd.trim()||!devices.some(n=>n.id===target.nodeId&&n.epoch===target.epoch&&!n.revoked));
  input.disabled=!!state?.conversation.blocked||!!state?.conversation.settlement_conflict;
  const queued=queues.get(selected??'')??[];
  sendButton.title=current?'添加到排队列表（可在队列中点立即发送）':'发送消息';
  sendButton.setAttribute('aria-label',current?'添加到排队列表':'发送消息');
  sendButton.disabled=!!admitting||!input.value.trim()||!!attachments?.busy()||input.disabled||targetInvalid||(!!current&&queued.length>=QUEUE_LIMIT);
  stopButton.hidden=!current;stopButton.disabled=!!current?.cancelRequested||current?.status==='cancelling'||current?.status==='submitting';
}

async function send(item?:QueueItem){
  if(!item&&(!input?.value.trim()||sendButton?.disabled))return;if(admitting)return;
  const skillIds=item?item.skills:skills?.selected()??[],fileMetas=item?[]:attachments?.ready()??[],fileIds=item?item.attachments:fileMetas.map(meta=>meta.id),content=item?item.content:input!.value.trim(),version=epoch,target=item?(item.target?{...item.target}:null):effectiveTarget()?{...effectiveTarget()!}:null;
  let conversationId=selected;const token=view;
  const admission={};admitting=admission;composeState();
  try{
  if(!conversationId){
    const wsId=activeWorkspace()?.id;
    conversationId=crypto.randomUUID();
    const conversation=await api<Conversation>('desk/conversations','POST',{id:conversationId,title:content.slice(0,80),...(wsId?{workspaceId:wsId}:{})});
    if(version!==epoch)throw new Stale();listSequence++;states.set(conversationId,{conversation,messages:[]});conversations.unshift(conversation);sortConversationsList();
    if(token===view){const followup=drafts.get('new');if(followup!==undefined&&followup.trim()!==content){drafts.set(conversationId,followup);drafts.delete('new');}targets.set(conversationId,currentTarget());selected=conversationId;address();paint();}
  }
  const state=states.get(conversationId);if(!state)throw Error('对话尚未读取完成，请稍后发送。');
  const turn:Turn={id:crypto.randomUUID(),conversationId,content,status:'submitting',output:'',reason:null,cancelRequested:false,createdAt:Date.now(),target,skills:skillIds.map((id,index)=>({id,name:skills?.names(skillIds)[index]??''})),attachments:fileMetas};state.messages.push(turn);if(!item){skills?.clear();attachments?.clear();}
  if(!item)for(const key of [conversationId,'new'])if((drafts.get(key)??'').trim()===content)drafts.set(key,'');
  if(selected===conversationId){if(!item)input!.value=drafts.get(conversationId)??drafts.get('new')??'';if(transcript!.querySelector('.welcome'))transcript!.replaceChildren();appendMessage(turn);const previous=state.messages.at(-2);if(previous)update(previous);}
  const receiving=stream(turn,'desk/conversations/'+conversationId+'/messages',{id:turn.id,content,...(target?{target:{nodeId:target.nodeId,epoch:target.epoch,cwd:target.cwd}}:{}),...(skillIds.length?{skills:skillIds}:{}),...(fileIds.length?{attachments:fileIds}:{}),...(optMemory?{}:{options:{memory:false}})});if(admitting===admission)admitting=null;composeState();await receiving;
  }finally{if(version===epoch&&admitting===admission){admitting=null;composeState();}}
}
async function observe(turn:Turn,recovery=0){const historical=!live(turn);turn.output='';turn.steps=[];turn.observationLost=false;update(turn);await stream(turn,'desk/messages/'+turn.id+'/events',undefined,recovery,historical);}
async function stream(turn:Turn,path:string,body?:unknown,recovery=0,historical=false){
  if(streams.has(turn.id))return;const controller=new AbortController(),version=epoch;streams.set(turn.id,{turn,controller});let settled=false,readFailed=false;
  try{
    const response=await fetch(new URL(path,apiBase),{method:body?'POST':'GET',credentials:'same-origin',headers:{'content-type':'application/json',...(body?{'x-reach-csrf':user!.csrf}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal});
    if(version!==epoch)throw new Stale();if(response.status===401){expired();throw new Stale();}
    if(!response.ok){const error=await response.json(),message=error.error?.message??'消息未完成';if(body&&response.status>=400&&response.status<500&&rejectedSubmissionCodes.has(error.error?.code))throw new Rejected(message);throw Error(message);}
    const reader=response.body!.getReader(),decoder=new TextDecoder();let pending='',sequence=0;
    for(;;){const{value,done}=await reader.read();if(version!==epoch)throw new Stale();if(done)break;pending+=decoder.decode(value,{stream:true});if(pending.length>2097152)throw Error('回答片段过大，请查询原记录。');
      for(let end=pending.indexOf('\n\n');end>=0;end=pending.indexOf('\n\n')){const lines=pending.slice(0,end).split('\n');pending=pending.slice(end+2);const kind=lines.find(line=>line.startsWith('event: '))?.slice(7),raw=lines.find(line=>line.startsWith('data: '))?.slice(6),id=Number(lines.find(line=>line.startsWith('id: '))?.slice(4));if(!raw)continue;if(!Number.isSafeInteger(id)||id!==sequence+1)throw Error('回答片段顺序不完整，请查询原记录。');sequence=id;const event=JSON.parse(raw);
        if(kind==='admitted'&&!historical)turn.status=event.status;
        if(kind==='delta'){if(!historical)turn.status=turn.cancelRequested?'cancelling':'running';turn.output+=event.text;}
        if(kind==='admitted'&&event.target)turn.target=event.target;
        if(kind==='device_operation'){const operations=turn.operations??turn.deviceCalls?.map(c=>c.operation).filter((op):op is DeviceOperation=>!!op)??[];turn.operations=operations.filter(op=>op.operationId!==event.operation.operationId);turn.operations.push(event.operation);}
        if(kind==='device_image'&&event.image){turn.images=(turn.images??[]).filter(image=>image.callKey!==event.image.callKey);turn.images.push(event.image);}
        if(kind==='tool_start'||kind==='tool_end')turn.steps=applyStepEvent(turn.steps,kind,event);
        if(kind==='guidance')turn.guidance=applyGuidance(turn.guidance,event);
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
  }finally{if(streams.get(turn.id)?.controller===controller)streams.delete(turn.id);if(version===epoch){composeState();drawQueue();if(!live(turn))queueMicrotask(()=>{drainQueue();void requestSuggestion();});if(readFailed&&live(turn)&&!controller.signal.aborted){if(recovery===0)void observe(turn,1);else{turn.observationLost=true;update(turn);}}}}
}
async function query(turn:Turn){const revision=turn.revision??0,saved=await api<Turn>('desk/messages/'+turn.id);if((turn.revision??0)!==revision||states.get(turn.conversationId)?.messages.find(item=>item.id===turn.id)!==turn)return;const prior=turn.output;Object.assign(turn,saved);delete turn.operations;turn.revision=revision+1;if(!turn.output&&turn.status!=='completed')turn.output=prior;update(turn);if(selected===turn.conversationId&&['unknown','cancelled'].includes(turn.status)){const result=await api<{conversation:Conversation;messages:Turn[]}>('desk/conversations/'+turn.conversationId);applySettlement(turn.conversationId,result.conversation);updateNotice();composeState();}if(live(turn)&&!streams.has(turn.id))void observe(turn,1);}
async function stop(){if(!selected)return;const turn=states.get(selected)?.messages.find(live);if(!turn||turn.cancelRequested)return;turn.cancelRequested=true;turn.status='cancelling';update(turn);try{await api('desk/messages/'+turn.id+'/cancel','POST',{});}catch(error){turn.cancelRequested=false;await query(turn);throw error;}}

function greeting(){const h=new Date().getHours();return h<6?'夜深了':h<12?'早上好':h<14?'中午好':h<18?'下午好':'晚上好';}
const chips:[string,string][]=[['在设备上执行','在已选设备上执行：'],['分析日志','读取日志并分析异常：'],['排查故障','出现了问题，帮我排查：'],['理清思路','帮我把这件事理清楚：']];
function welcomeChips(){const row=el('div','welcome-chips');for(const [label,text] of chips){const chip=button(label,()=>{if(!input)return;input.value=text;drafts.set(selected??'new',text);input.focus();input.setSelectionRange(text.length,text.length);composeState();},'chip');row.append(chip);}return row;}
function busyNow(){const state=selected?states.get(selected):undefined;return !!state?.messages.some(live);}
function queueInput(){
  if(!selected||!input)return;const content=input.value.trim();if(!content)return;
  const chosen=skills?.selected()??[],files=attachments?.ready().map(item=>item.id)??[],before=queues.get(selected)??[],after=enqueue(before,content,effectiveTarget(),crypto.randomUUID(),chosen,files);
  if(after===before){showError('排队最多 '+QUEUE_LIMIT+' 条，请等当前回答结束。');return;}
  queues.set(selected,after);input.value='';drafts.set(selected,'');skills?.clear();attachments?.clear();drawQueue();composeState();input.focus();
}
// Codex / HandWave 队列操作：点击「立即发送」或单条箭头 → 若当前运行中则立刻作为引导发给模型，空闲时直接发下一轮。
function sendQueueNow(id:string){
  const key=selected??'';const items=queues.get(key)??[];const item=items.find(entry=>entry.id===id);
  if(!item||!selected)return;
  const state=states.get(selected);
  const runningTurn=state?.messages.find(turn=>['starting','running'].includes(turn.status)&&!turn.cancelRequested);
  if(runningTurn){
    queues.set(key,removeItem(items,id));drawQueue();composeState();
    void guide(runningTurn,item.content).catch(error=>{if(!(error instanceof Stale))showError(error instanceof Error?error.message:'立即发送未完成');});
    return;
  }
  if(!busyNow()&&!state?.conversation.blocked&&!state?.conversation.settlement_conflict&&!admitting){
    queues.set(key,removeItem(items,id));drawQueue();composeState();
    void send(item).catch(error=>{if(!(error instanceof Stale)){queues.set(key,[item,...(queues.get(key)??[])]);drawQueue();showError(error instanceof Error?error.message:'立即发送未完成');}});
    return;
  }
  showError('当前正在收尾或等待结算，请稍后再立即发送。');
}
function drawQueue(){
  if(!queueBox)return;const key=selected??'';const items=queues.get(key)??[];
  const statusText=busyNow()?'回答运行中 · 点「→」或「立即发送」直发模型':'等待发送';
  paintQueue(queueBox,items,{
    sendNow:id=>sendQueueNow(id),
    edit:id=>{const item=(queues.get(key)??[]).find(entry=>entry.id===id);if(!item||!input)return;queues.set(key,removeItem(queues.get(key)??[],id));input.value=item.content;drafts.set(key,item.content);drawQueue();composeState();input.focus();},
    remove:id=>{queues.set(key,removeItem(queues.get(key)??[],id));drawQueue();composeState();},
    clear:()=>{queues.set(key,[]);drawQueue();composeState();},
  },statusText);
}
function drainQueue(){
  if(!selected||admitting)return;const state=states.get(selected);if(!state||state.messages.some(live)||state.conversation.blocked||state.conversation.settlement_conflict)return;
  const items=queues.get(selected)??[];if(!items.length)return;const [item,...rest]=items;queues.set(selected,rest);drawQueue();
  void send(item).catch(error=>{if(!(error instanceof Stale)){queues.set(state.conversation.id,[item,...(queues.get(state.conversation.id)??[])]);drawQueue();showError((error instanceof Error?error.message:'提交未完成')+' 排队的消息已放回队首。');}});
}
async function showModel(){
  const version=epoch;
  try{const data=await api<ModelSettingsView>('settings/models');if(version!==epoch||!modelPill)return;
    const model=data.desk.running?.model??data.desk.enabled?.model;currentModelName=model??'';
    if(!model){modelPill.hidden=true;return;}
    modelPill.replaceChildren(el('span','',model),svg('0 0 24 24',['M6 9l6 6 6-6'],12));modelPill.hidden=false;
  }catch{if(modelPill)modelPill.hidden=true;}
}
function closeModelMenu(){if(!modelMenu||!modelPill)return;modelMenu.hidden=true;modelMenu.replaceChildren();modelPill.setAttribute('aria-expanded','false');}
async function toggleModelMenu(force?:boolean){
  if(!modelMenu||!modelPill)return;
  const open=force??modelMenu.hidden;
  if(!open){closeModelMenu();return;}
  closeAttachMenu();
  const version=epoch;
  modelMenu.hidden=false;modelPill.setAttribute('aria-expanded','true');
  modelMenu.replaceChildren(el('p','model-menu-status','正在读取可用模型…'));
  try{
    const data=await api<ModelSettingsView>('settings/models');
    if(version!==epoch||!modelMenu||modelMenu.hidden)return;
    paintModelMenu(data);
  }catch(error){
    if(version===epoch&&modelMenu&&!modelMenu.hidden)modelMenu.replaceChildren(el('p','model-menu-status',error instanceof Error?error.message:'模型列表读取失败'));
  }
}
function paintModelMenu(data:ModelSettingsView){
  if(!modelMenu)return;
  const active=data.desk.running?.model??data.desk.enabled?.model??currentModelName;
  const search=el('input','model-menu-search');search.type='search';search.placeholder='搜索模型或供应商';search.setAttribute('aria-label','搜索模型');
  const status=el('div','model-menu-status');status.setAttribute('role','status');
  const list=el('div','model-menu-list');
  const renderList=()=>{
    const q=search.value.trim().toLowerCase();
    const nodes:HTMLElement[]=[];
    for(const p of data.providers){
      const matched=p.models.filter(m=>!q||m.id.toLowerCase().includes(q)||p.name.toLowerCase().includes(q));
      if(!matched.length)continue;
      nodes.push(el('div','model-group-h',p.name));
      for(const m of matched){
        const isCur=m.id===active;
        const row=el('button','model-item'+(isCur?' active':''));row.type='button';row.disabled=modelSwitching;
        row.append(el('span','',m.id));
        if(m.imageInput)row.append(el('em','model-badge','视觉'));
        if(isCur)row.append(svg('0 0 24 24',['M5 12l5 5 9-10'],13));
        row.addEventListener('click',()=>{if(isCur){closeModelMenu();return;}void switchModel(p.id,m.id,status);});
        nodes.push(row);
      }
    }
    if(!nodes.length)nodes.push(el('p','skill-empty','没有匹配的模型。'));
    list.replaceChildren(...nodes);
  };
  search.addEventListener('input',renderList);
  const foot=el('div','model-menu-foot');
  foot.append(el('span','','新建会话生效'),button('管理供应商与模型…',()=>{closeModelMenu();context?.openSettings();},'link'));
  modelMenu.replaceChildren(search,status,list,foot);
  renderList();search.focus();
}
async function switchModel(providerId:string,model:string,statusEl:HTMLElement){
  if(modelSwitching)return;
  modelSwitching=true;statusEl.textContent=`正在测试「${model}」连通性…`;
  try{
    const saved=await api<{generation:number}>('settings/models/desk','PUT',{providerId,model});
    const test=await api<{ok:boolean;message:string}>('settings/models/desk/test','POST',{});
    if(!test.ok){statusEl.textContent=`测试未通过：${test.message}`;return;}
    await api('settings/models/desk/enable','POST',{generation:saved.generation});
    currentModelName=model;
    if(modelPill)modelPill.replaceChildren(el('span','',model),svg('0 0 24 24',['M6 9l6 6 6-6'],12));
    closeModelMenu();
    if(notice)notice.textContent=selected?`已切换为 ${model}，新建会话将使用新模型（当前已有对话仍保持原模型）。`:`已切换为 ${model}。`;
  }catch(error){
    statusEl.textContent=error instanceof Error?error.message:'切换模型未完成';
  }finally{
    modelSwitching=false;
  }
}

function hideSuggestion(){if(!input)return;delete input.dataset.suggestion;input.placeholder=PLACEHOLDER;input.classList.remove('has-suggestion');}
function showSuggestion(){
  hideSuggestion();if(!input||!selected||input.value)return;
  const entry=suggestions.get(selected),last=states.get(selected)?.messages.at(-1);
  if(!entry||!last||entry.basis!==last.id||Date.now()-entry.at>SUGGESTION_TTL)return;
  input.dataset.suggestion=entry.text;input.placeholder=entry.text+'　· Tab 采纳';input.classList.add('has-suggestion');
  clearTimeout(suggestionTimer);suggestionTimer=window.setTimeout(()=>{showSuggestion();},SUGGESTION_TTL-(Date.now()-entry.at)+50);
}
async function requestSuggestion(){
  const id=selected;if(!id||admitting)return;const state=states.get(id),last=state?.messages.at(-1);
  if(!state||!last||last.status!=='completed'||state.messages.some(live)||(queues.get(id)??[]).length||suggestionAsked.has(last.id))return;
  suggestionAsked.add(last.id);
  try{const result=await api<{suggestion:string|null;basis?:string}>('desk/conversations/'+encodeURIComponent(id)+'/suggestion','POST',{});
    if(result.suggestion&&result.basis===last.id){suggestions.set(id,{basis:last.id,text:result.suggestion,at:Date.now()});if(selected===id)showSuggestion();}
  }catch{}
}

async function guide(turn:Turn,text:string){
  const messageId=crypto.randomUUID();turn.guidance=applyGuidance(turn.guidance,{messageId,text,status:'sending'});update(turn);
  try{const result=await api<{guidance?:{message_id:string;text:string;status:string}}>('desk/messages/'+encodeURIComponent(turn.id)+'/guidance','POST',{messageId,text});
    if(result.guidance)turn.guidance=applyGuidance(turn.guidance,{messageId,text:result.guidance.text,status:result.guidance.status});}
  catch(error){turn.guidance=applyGuidance(turn.guidance,{messageId,status:'failed'});update(turn);showError(error instanceof Error?error.message:'引导未送达');throw error;}
  update(turn);
}
function retry(turn:Turn){
  const state=states.get(turn.conversationId);if(!state||state.messages.some(live)||admitting||state.messages.at(-1)!==turn)return;
  const target=turn.target?{...turn.target}:null;
  void send({id:crypto.randomUUID(),content:turn.content,target,skills:(turn.skills??[]).filter(skill=>skill.name).map(skill=>skill.id),attachments:(turn.attachments??[]).map(file=>file.id)}).catch(error=>showError(error instanceof Error?error.message:'重新回答未能发送'));
}
function insertPath(path:string){
  if(!input||input.disabled)return;const start=input.selectionStart??input.value.length,end=input.selectionEnd??start,before=input.value.slice(0,start),after=input.value.slice(end);
  const text=(before&&!/\s$/.test(before)?' ':'')+path+(after&&!/^\s/.test(after)?' ':'');
  input.value=before+text+after;input.focus();input.selectionStart=input.selectionEnd=before.length+text.length;input.dispatchEvent(new Event('input',{bubbles:true}));
}
