// Copyright (c) Ray Zhang. 回答的 Agent 面板（参照 HandWave 运行中面板）：运行时显示已用时间和步骤数，可补充引导；
// 回答结束后可以「重新回答」，即用同一条内容、同一执行位置、同样的技能和附件再发一次。
// 引导状态只认服务端回执：queued 已送达等待采纳、applied 已采纳、unapplied 未采纳、unknown 无法确认。
export interface Guidance {messageId:string;text:string;status:string}
export const GUIDANCE_LIMIT=16,GUIDANCE_MAX=16000;
const LABELS:Record<string,string>={sending:'发送中',queued:'已送达，等待采纳',applied:'已采纳',unapplied:'未采纳',unknown:'无法确认是否采纳',failed:'未送达'};

// 合并一条引导事件或本地记录（同一 messageId 合并；回执状态不会被较早的 queued 覆盖）。
export function applyGuidance(list:Guidance[]|undefined,data:{messageId?:unknown;text?:unknown;status?:unknown}):Guidance[]{
  const items=list??[];if(typeof data.messageId!=='string'||!data.messageId||typeof data.status!=='string')return items;
  const text=typeof data.text==='string'?data.text:'',existing=items.find(item=>item.messageId===data.messageId);
  if(!existing)return [...items,{messageId:data.messageId,text,status:data.status}];
  const settled=['applied','unapplied','unknown'].includes(existing.status),status=settled&&['queued','sending'].includes(data.status)?existing.status:data.status;
  return items.map(item=>item===existing?{...item,text:item.text||text,status}:item);
}
export const guidanceLabel=(status:string)=>LABELS[status]??status;
export const guidanceTone=(status:string)=>status==='applied'?'ok':['unapplied','failed'].includes(status)?'bad':status==='unknown'?'warn':'run';

// 「已运行 1 分 05 秒」
export function elapsedLabel(ms:number){const total=Math.max(0,Math.floor(ms/1000)),m=Math.floor(total/60),s=total%60;return m?`${m} 分 ${String(s).padStart(2,'0')} 秒`:`${s} 秒`;}

interface AgentView {live:boolean;createdAt?:number;steps:number;running:number;guidance:Guidance[];canGuide:boolean;canRetry:boolean;showGuideForm?:boolean}
interface Handlers {guide(text:string):Promise<void>;retry():void}
function el<K extends keyof HTMLElementTagNameMap>(tag:K,className='',content?:string){const node=document.createElement(tag);if(className)node.className=className;if(content!==undefined)node.textContent=content;return node;}
function iconSvg(paths:string[]){const ns='http://www.w3.org/2000/svg',node=document.createElementNS(ns,'svg');node.setAttribute('width','13');node.setAttribute('height','13');node.setAttribute('viewBox','0 0 24 24');node.setAttribute('class','ic');node.setAttribute('aria-hidden','true');for(const d of paths){const p=document.createElementNS(ns,'path');p.setAttribute('d',d);node.append(p);}return node;}

// 面板节点只建一次；每次 update 只改文字与列表，输入框里正在写的引导不会被清掉。
export class AgentPanel {
  readonly root:HTMLElement;
  readonly retry:HTMLButtonElement;
  private readonly meta:HTMLElement;private readonly list:HTMLOListElement;private readonly form:HTMLFormElement;private readonly field:HTMLTextAreaElement;private readonly submit:HTMLButtonElement;
  private view:AgentView|null=null;private timer=0;private sending=false;
  constructor(handlers:Handlers){
    this.root=el('div','agent-panel');this.meta=el('div','agent-meta');this.list=el('ol','agent-guidance');
    this.form=el('form','agent-guide');this.field=el('textarea');this.field.rows=1;this.field.maxLength=GUIDANCE_MAX;this.field.placeholder='补充引导：例如「先别改配置，只看日志」';this.field.setAttribute('aria-label','补充引导');
    this.submit=el('button','btn','发送引导');this.submit.type='submit';
    this.form.append(this.field,this.submit);
    this.retry=el('button','msg-act agent-retry');this.retry.type='button';this.retry.title='用同一条消息、同一执行位置再回答一次';
    this.retry.append(iconSvg(['M20 11a8 8 0 1 0-2.3 5.7','M20 5v6h-6']),el('span','','重新回答'));
    this.retry.addEventListener('click',()=>handlers.retry());
    this.field.addEventListener('input',()=>this.paintForm());
    this.field.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();this.form.requestSubmit();}});
    this.form.addEventListener('submit',async event=>{event.preventDefault();const text=this.field.value.trim();if(!text||this.sending)return;this.sending=true;this.paintForm();
      try{await handlers.guide(text);this.field.value='';}finally{this.sending=false;this.paintForm();}});
    this.root.append(this.meta,this.list,this.form,this.retry);
  }
  update(view:AgentView){
    this.view=view;const visible=view.live||view.guidance.length>0||(this.retry.parentElement===this.root&&view.canRetry);this.root.hidden=!visible;
    this.paintMeta();clearInterval(this.timer);if(view.live&&view.createdAt)this.timer=window.setInterval(()=>{if(!this.root.isConnected){clearInterval(this.timer);return;}this.paintMeta();},1000);
    this.list.hidden=!view.guidance.length;
    this.list.replaceChildren(...view.guidance.map(item=>{const row=el('li','agent-guidance-item');row.append(el('span','agent-guidance-text',item.text||'（引导正文未读取）'),el('span','agent-guidance-state '+guidanceTone(item.status),guidanceLabel(item.status)));return row;}));
    this.form.hidden=!(view.canGuide&&view.showGuideForm);this.retry.hidden=!view.canRetry;this.paintForm();
  }
  private paintMeta(){
    const view=this.view;if(!view)return;this.meta.hidden=!view.live;if(!view.live)return;
    const parts=[view.createdAt?'已运行 '+elapsedLabel(Date.now()-view.createdAt):'正在运行',view.steps?`${view.steps} 个步骤`+(view.running?`，${view.running} 个进行中`:''):'尚未调用工具'];
    this.meta.textContent=parts.join(' · ');
  }
  private paintForm(){const full=(this.view?.guidance.length??0)>=GUIDANCE_LIMIT;this.submit.disabled=this.sending||full||!this.field.value.trim();this.submit.textContent=this.sending?'发送中…':full?'引导已达上限':'发送引导';}
}
