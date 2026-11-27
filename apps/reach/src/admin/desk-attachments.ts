// Copyright (c) Ray Zhang. 对话附件（参照 HandWave 附件条）：「附件」按钮、粘贴图片、拖放到输入框；上传后作为下一条消息的附件。
// 单个 ≤ 1 MB。文本附件会随消息交给模型；图片暂只保存与显示（服务端在任务目标里如实说明）。
type Api=<T>(path:string,method?:string,body?:unknown)=>Promise<T>;
export interface AttachmentMeta {id:string;name:string;mime:string;size:number;kind:'text'|'image'|'file'}
interface Pending {key:string;name:string;mime:string;preview:string|null;state:'uploading'|'ready'|'failed';meta?:AttachmentMeta;error?:string}
export const ATTACHMENT_LIMIT=1024*1024,MAX_ATTACHMENTS=6;

function el<K extends keyof HTMLElementTagNameMap>(tag:K,className='',content?:string){const node=document.createElement(tag);if(className)node.className=className;if(content!==undefined)node.textContent=content;return node;}
export function sizeLabel(bytes:number){return bytes<1024?`${bytes} B`:bytes<1048576?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1048576).toFixed(2)} MB`;}
// 上传前在浏览器里挡掉过大或过多的文件，给出可操作的原因。
export function precheck(size:number,count:number):string|null{if(count>=MAX_ATTACHMENTS)return `每条消息最多 ${MAX_ATTACHMENTS} 个附件`;if(size>ATTACHMENT_LIMIT)return '单个附件不超过 1 MB；大文件请放到设备上，让 Agent 在设备上读取';if(size===0)return '附件是空的';return null;}
async function base64(file:Blob){const buffer=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<buffer.length;i+=0x8000)binary+=String.fromCharCode(...buffer.subarray(i,i+0x8000));return btoa(binary);}

export class DeskAttachments {
  readonly bar:HTMLElement;readonly trigger:HTMLButtonElement;private readonly picker:HTMLInputElement;
  private readonly api:Api;private readonly onChange:()=>void;
  private lists=new Map<string,Pending[]>();private key='new';private seq=0;
  constructor(api:Api,input:HTMLTextAreaElement,dropZone:HTMLElement,onChange:()=>void){
    this.api=api;this.onChange=onChange;
    this.bar=el('div','attachment-bar');this.bar.hidden=true;this.bar.setAttribute('aria-label','下一条消息的附件');
    this.picker=el('input');this.picker.type='file';this.picker.multiple=true;this.picker.hidden=true;
    this.picker.addEventListener('change',()=>{for(const file of this.picker.files??[])void this.add(file);this.picker.value='';});
    this.trigger=el('button','quiet attachment-trigger','附件');this.trigger.type='button';this.trigger.title='添加附件：文本文件会随消息交给模型，单个不超过 1 MB；也可以粘贴图片或拖放文件';
    this.trigger.addEventListener('click',()=>this.picker.click());
    dropZone.append(this.picker);
    input.addEventListener('paste',event=>{const files=[...event.clipboardData?.files??[]];if(!files.length)return;event.preventDefault();for(const file of files)void this.add(file);});
    dropZone.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files')){event.preventDefault();dropZone.classList.add('dropping');}});
    dropZone.addEventListener('dragleave',()=>dropZone.classList.remove('dropping'));
    dropZone.addEventListener('drop',event=>{dropZone.classList.remove('dropping');const files=[...event.dataTransfer?.files??[]];if(!files.length)return;event.preventDefault();for(const file of files)void this.add(file);});
  }
  pick(){this.picker.click();}
  use(key:string){this.key=key;this.paint();}
  private list(){return this.lists.get(this.key)??[];}
  busy(){return this.list().some(item=>item.state==='uploading');}
  ready(){return this.list().filter(item=>item.state==='ready'&&item.meta).map(item=>item.meta!);}
  clear(){for(const item of this.list())if(item.preview)URL.revokeObjectURL(item.preview);this.lists.set(this.key,[]);this.paint();}
  private async add(file:File){
    const key=this.key,list=this.lists.get(key)??[];
    const problem=precheck(file.size,list.filter(item=>item.state!=='failed').length);
    const item:Pending={key:`a${++this.seq}`,name:file.name||'粘贴的图片',mime:file.type||'application/octet-stream',preview:file.type.startsWith('image/')?URL.createObjectURL(file):null,state:problem?'failed':'uploading',error:problem??undefined};
    this.lists.set(key,[...list,item]);this.paint();this.onChange();if(problem)return;
    try{const result=await this.api<{attachment:AttachmentMeta}>('desk/attachments','POST',{name:item.name,mime:item.mime,data:await base64(file)});item.meta=result.attachment;item.state='ready';}
    catch(error){item.state='failed';item.error=error instanceof Error?error.message:'上传未完成';}
    this.paint();this.onChange();
  }
  private remove(key:string){const list=this.list(),item=list.find(entry=>entry.key===key);if(item?.preview)URL.revokeObjectURL(item.preview);this.lists.set(this.key,list.filter(entry=>entry.key!==key));this.paint();this.onChange();}
  private paint(){
    const list=this.list();this.bar.hidden=!list.length;
    this.bar.replaceChildren(...list.map(item=>{
      const chip=el('span',`attachment-chip s-${item.state}`);
      if(item.preview){const img=el('img');img.src=item.preview;img.alt='';chip.append(img);}else chip.append(el('i','attachment-icon','▤'));
      const text=el('span','attachment-text');text.append(el('b','',item.name),el('small','',item.state==='uploading'?'上传中…':item.state==='failed'?(item.error??'上传未完成'):item.meta?`${sizeLabel(item.meta.size)} · ${item.meta.kind==='text'?'文本会交给模型':item.meta.kind==='image'?'图片仅保存，模型暂看不到':'仅保存'}`:''));
      chip.title=item.state==='failed'?(item.error??''):item.name;
      const close=el('button','attachment-remove','×');close.type='button';close.setAttribute('aria-label',`移除附件 ${item.name}`);close.addEventListener('click',()=>this.remove(item.key));
      chip.append(text,close);return chip;
    }));
  }
}

// 消息上的附件：图片显示缩略图并可点开原图，其他类型给下载链接。
export function attachmentList(items:AttachmentMeta[],url:(id:string)=>string){
  const box=el('div','message-attachments');
  for(const item of items){
    const link=el('a',`message-attachment k-${item.kind}`);link.href=url(item.id);link.target='_blank';link.rel='noopener';link.title=`${item.name} · ${sizeLabel(item.size)}`;
    if(item.kind==='image'){const img=el('img');img.src=url(item.id);img.alt=item.name;img.loading='lazy';link.append(img);}
    else link.append(el('i','attachment-icon','▤'),el('span','',item.name));
    box.append(link);
  }
  return box;
}
