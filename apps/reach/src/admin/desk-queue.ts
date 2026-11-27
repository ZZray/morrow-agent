// Copyright (c) Ray Zhang. 对话队列（参照 Codex / HandWave 消息队列）：回答进行中时发送默认入队；
// 支持队首或单条「立即发送」直接引导当前运行中的模型（空闲时直接发送），以及放回编辑、删除、清空。
export interface QueueTarget {nodeId:string;epoch:number;cwd:string;name?:string;platform?:string}
export interface QueueItem {id:string;content:string;target:QueueTarget|null;skills:string[];attachments:string[]}
export const QUEUE_LIMIT=20;

export function enqueue(items:QueueItem[],content:string,target:QueueTarget|null,id:string=crypto.randomUUID(),skills:string[]=[],attachments:string[]=[]):QueueItem[]{
  const text=content.trim();if(!text||items.length>=QUEUE_LIMIT)return items;
  return [...items,{id,content:text,target:target?{...target}:null,skills:[...skills],attachments:[...attachments]}];
}
export function removeItem(items:QueueItem[],id:string){return items.filter(item=>item.id!==id);}
export function moveFirst(items:QueueItem[],id:string){const item=items.find(entry=>entry.id===id);return item?[item,...items.filter(entry=>entry.id!==id)]:items;}

interface Handlers {sendNow(id:string):void;edit(id:string):void;remove(id:string):void;clear():void;next?(id:string):void}
function el<K extends keyof HTMLElementTagNameMap>(tag:K,className='',content?:string){const node=document.createElement(tag);if(className)node.className=className;if(content!==undefined)node.textContent=content;return node;}
function svgIcon(pathD:string){const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('width','13');svg.setAttribute('height','13');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','2');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');const path=document.createElementNS(ns,'path');path.setAttribute('d',pathD);svg.append(path);return svg;}
function iconBtn(label:string,title:string,icon:SVGSVGElement|string,run:()=>void,className='q-icon'){
  const node=el('button',className);node.type='button';node.title=title;node.setAttribute('aria-label',label);
  if(typeof icon==='string')node.textContent=icon;else node.append(icon);
  node.addEventListener('click',run);return node;
}

export function paintQueue(box:HTMLElement,items:QueueItem[],handlers:Handlers,statusText='等待发送'){
  box.hidden=items.length===0;if(!items.length){box.replaceChildren();return;}
  const head=el('div','queue-head');
  const title=el('span','queue-title','排队消息'),count=el('span','queue-count',String(items.length)),hint=el('span','queue-hint',statusText);
  const headBtns=el('span','queue-head-actions');
  const sendAll=el('button','queue-send-now','立即发送');sendAll.type='button';sendAll.title='立即将下一条发给模型';sendAll.addEventListener('click',()=>handlers.sendNow(items[0].id));
  const clear=iconBtn('清空队列','清空全部排队消息','×',handlers.clear,'q-icon');
  headBtns.append(sendAll,clear);
  head.append(title,count,hint,headBtns);
  const list=el('ol','queue-list');
  items.forEach(item=>{
    const row=el('li','queue-item');
    const text=el('span','queue-text',item.content);text.title=item.content;
    const tags:string[]=[];
    if(item.target)tags.push(item.target.name??'设备');
    if(item.skills.length)tags.push(`${item.skills.length} 技能`);
    if(item.attachments.length)tags.push(`${item.attachments.length} 附件`);
    const buttons=el('span','queue-buttons');
    buttons.append(
      iconBtn('立即发送给模型','立即发送给模型',svgIcon('M5 12h14M13 6l6 6-6 6'),()=>handlers.sendNow(item.id),'q-icon send'),
      iconBtn('编辑','放回输入框编辑',svgIcon('M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'),()=>handlers.edit(item.id)),
      iconBtn('删除','从队列移除',svgIcon('M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6'),()=>handlers.remove(item.id),'q-icon danger'),
    );
    row.append(text);
    if(tags.length)row.append(el('span','queue-where',tags.join(' · ')));
    row.append(buttons);
    list.append(row);
  });
  box.replaceChildren(head,list);
}
