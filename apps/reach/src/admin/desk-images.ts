// Copyright (c) Ray Zhang. Verified originals; image reads never create device operations.
export interface ImageView {callKey:string;operationId:string|null;artifactId:string|null;sha256:string|null;byteLength:number|null;width:number|null;height:number|null;recorded:boolean}
interface Options {current:()=>boolean;fetch:(image:ImageView,signal:AbortSignal)=>Promise<Response>;deviceName:string}
const make=<K extends keyof HTMLElementTagNameMap>(tag:K,cls='',text?:string)=>{const node=document.createElement(tag);node.className=cls;if(text!==undefined)node.textContent=text;return node;};
const hash=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),b=>b.toString(16).padStart(2,'0')).join('');
class ImageCard {
  readonly element=make('figure','device-image');
  readonly image:ImageView;readonly identity:string;
  private options:Options;private current:()=>boolean;private disposed=false;private controller?:AbortController;
  private url:string|null=null;private pendingUrl:string|null=null;private picture=make('img','device-image-picture');private status=make('p','image-read-status');
  private preview=make('button','quiet','查看原图');private download=make('button','quiet','取回原图');private expanded=false;
  constructor(image:ImageView,options:Options,current:()=>boolean){
    this.image=image;this.identity=JSON.stringify(image);this.options=options;this.current=()=>!this.disposed&&options.current()&&current();
    const caption=make('figcaption','image-caption'),heading=make('div','image-heading');heading.append(make('strong','','设备原图'),make('span','',image.recorded?`${image.width} × ${image.height} · ${Math.max(1,Math.round((image.byteLength??0)/1024))} KB`:'记录待核对'));caption.append(heading,make('p','image-origin',options.deviceName));
    this.picture.alt=`来自${options.deviceName}的原始 PNG 图片`;this.picture.hidden=true;this.picture.decoding='async';
    const actions=make('div','image-actions');this.preview.type=this.download.type='button';this.preview.disabled=this.download.disabled=!image.recorded;actions.append(this.preview,this.download);this.status.setAttribute('aria-live','polite');
    const details=make('details','image-source');details.append(make('summary','','来源信息'));const sources:[string,string|null][]=[['源操作',image.operationId],['原图标识',image.artifactId],['SHA256',image.sha256]];for(const [label,value]of sources){const row=make('div');row.append(make('span','',label),make('code','',value??'待核对'));details.append(row);}
    this.element.append(caption,this.picture,actions,this.status,details);if(!image.recorded)this.status.textContent='原图记录暂时无法核对，来源标记已保留。';
    this.preview.onclick=()=>void this.show();this.download.onclick=()=>void this.save();
  }
  private async load(){
    if(this.url)return true;if(this.controller||!this.current())return false;
    const ref=this.image,length=ref.byteLength;if(!ref.recorded||typeof length!=='number'||!Number.isSafeInteger(length)||length<1||length>8388608||!ref.sha256||!/^[0-9a-f]{64}$/.test(ref.sha256))return false;
    const controller=new AbortController();this.controller=controller;this.preview.disabled=this.download.disabled=true;this.status.textContent='正在读取与校验原图…';let staged:string|null=null;
    const timer=setTimeout(()=>controller.abort(),30000);
    try{
      const response=await this.options.fetch(ref,controller.signal);if(!this.current())return false;
      if(!response.ok){let message='原图暂时无法取回，原操作和来源已保留。';try{message=(await response.json()).error?.message??message;}catch{}throw Error(message);}
      if(response.headers.get('content-type')?.split(';')[0]!=='image/png'||Number(response.headers.get('content-length'))!==ref.byteLength)throw Error('原图长度或格式不符，未显示图片。');
      const reader=response.body?.getReader();if(!reader)throw Error('原图响应不完整。');const parts:Uint8Array[]=[];let size=0;
      for(;;){const {value,done}=await reader.read();if(!this.current()){await reader.cancel();return false;}if(done)break;size+=value.length;if(size>ref.byteLength!){await reader.cancel();throw Error('原图超过声明长度，已停止读取。');}parts.push(value);}
      if(size!==ref.byteLength)throw Error('原图传输未完成，请重新读取原图。');const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}
      const actual=await hash(bytes);if(!this.current())return false;if(controller.signal.aborted)throw Error('原图读取已停止，请重新读取。');if(actual!==ref.sha256)throw Error('原图摘要不符，未显示图片；来源已保留。');
      staged=URL.createObjectURL(new Blob([bytes],{type:'image/png'}));this.pendingUrl=staged;const decoded=new Image();decoded.src=staged;
      await Promise.race([decoded.decode(),new Promise<never>((_,reject)=>{const stopped=()=>reject(Error('原图读取已停止，请重新读取。'));if(controller.signal.aborted)stopped();else controller.signal.addEventListener('abort',stopped,{once:true});})]);
      if(!this.current())return false;if(controller.signal.aborted)throw Error('原图读取已停止，请重新读取。');if(decoded.naturalWidth!==ref.width||decoded.naturalHeight!==ref.height)throw Error('原图尺寸不符，未显示图片。');
      this.url=staged;this.pendingUrl=null;this.picture.src=staged;this.status.textContent='原图已取回，字节校验通过。';return true;
    }catch(error){if(this.current())this.status.textContent=error instanceof Error?error.message:'原图取回失败，来源已保留。';return false;}
    finally{clearTimeout(timer);if(staged&&this.pendingUrl===staged){URL.revokeObjectURL(staged);this.pendingUrl=null;}if(this.controller===controller)this.controller=undefined;if(this.current()){this.preview.disabled=this.download.disabled=false;this.preview.textContent=this.url?(this.expanded?'收起原图':'查看原图'):'重新读取原图';}}
  }
  private async show(){if(!(await this.load())||!this.current())return;this.expanded=!this.expanded;this.picture.hidden=!this.expanded;this.preview.textContent=this.expanded?'收起原图':'查看原图';this.preview.setAttribute('aria-expanded',String(this.expanded));}
  private async save(){if(!(await this.load())||!this.current()||!this.url)return;const a=make('a');a.href=this.url;a.download='reach-'+this.image.artifactId+'.png';document.body.append(a);a.click();a.remove();}
  dispose(){this.disposed=true;this.controller?.abort();if(this.url)URL.revokeObjectURL(this.url);if(this.pendingUrl&&this.pendingUrl!==this.url)URL.revokeObjectURL(this.pendingUrl);this.url=this.pendingUrl=null;this.element.remove();}
}
export class ImageGallery {
  private cards=new Map<string,ImageCard>();private container:HTMLElement;private options:Options;
  constructor(container:HTMLElement,options:Options){this.container=container;this.options=options;}
  update(images:ImageView[]){const wanted=new Set(images.map(image=>image.callKey));for(const [key,card]of this.cards)if(!wanted.has(key)){card.dispose();this.cards.delete(key);}for(const image of images){let card=this.cards.get(image.callKey);if(card&&card.identity!==JSON.stringify(image)){card.dispose();this.cards.delete(image.callKey);card=undefined;}if(!card){const created:ImageCard=new ImageCard(image,this.options,()=>this.cards.get(image.callKey)===created);this.cards.set(image.callKey,created);this.container.append(created.element);}}}
  dispose(){for(const card of this.cards.values())card.dispose();this.cards.clear();}
}
