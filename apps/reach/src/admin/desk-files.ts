// Copyright (c) Ray Zhang. 设备工作区目录树（参照 HandWave 项目文件树）：从选中设备的工作目录开始，展开一层读一层。
// 每次展开都是一次真实的 directory.list 设备操作，经原有操作账本下发并留档（在「操作」页可查）；不缓存，可随时刷新。
// 点文件把相对路径插入输入框，方便在消息里指给 Reach 看。
type Api=<T>(path:string,method?:string,body?:unknown)=>Promise<T>;
export interface Entry {name:string;directory:boolean;bytes:number}
export interface Listing {entries:Entry[];truncated:boolean}
export interface WorkspaceTarget {nodeId:string;cwd:string;name?:string;platform?:string}
interface Operation {id:string;execution:string;result_json:string|null}
const FINAL=new Set(['succeeded','failed','cancelled','unknown']),WAIT_MS=20000;

export function parseListing(raw:string|null):Listing|null{
  if(!raw)return null;let value:unknown;try{value=JSON.parse(raw);}catch{return null;}
  for(let depth=0;depth<3&&value&&typeof value==='object';depth++){
    const record=value as Record<string,unknown>;
    if(Array.isArray(record.entries)){
      const entries=record.entries.filter((item):item is Record<string,unknown>=>!!item&&typeof item==='object'&&typeof (item as Record<string,unknown>).name==='string')
        .map(item=>({name:String(item.name),directory:item.directory===true,bytes:typeof item.bytes==='number'?item.bytes:0}));
      return {entries:sortEntries(entries),truncated:record.truncated===true};
    }
    value=record.data??record.result;
  }
  return null;
}
export const sortEntries=(entries:Entry[])=>[...entries].sort((a,b)=>a.directory!==b.directory?(a.directory?-1:1):a.name.localeCompare(b.name,'zh-CN',{numeric:true,sensitivity:'base'}));
export function joinPath(platform:string|undefined,base:string,name:string){const sep=platform==='windows'?'\\':'/';return base.endsWith('/')||base.endsWith('\\')?base+name:base+sep+name;}
export function relativePath(platform:string|undefined,root:string,full:string){
  const norm=(value:string)=>platform==='windows'?value.replace(/\\/g,'/').replace(/\/+$/,''):value.replace(/\/+$/,'');
  const r=norm(root),f=norm(full),same=platform==='windows'?f.toLowerCase().startsWith(r.toLowerCase()+'/'):f.startsWith(r+'/');
  return same?f.slice(r.length+1):f;
}

function el<K extends keyof HTMLElementTagNameMap>(tag:K,className='',content?:string){const node=document.createElement(tag);if(className)node.className=className;if(content!==undefined)node.textContent=content;return node;}
function btn(label:string,run:()=>void,className='btn ghost sm'){const node=el('button',className,label);node.type='button';node.addEventListener('click',run);return node;}
const size=(bytes:number)=>bytes<1024?bytes+' B':bytes<1048576?(bytes/1024).toFixed(1)+' KB':(bytes/1048576).toFixed(1)+' MB';
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

async function list(api:Api,target:WorkspaceTarget,path:string,alive:()=>boolean):Promise<Listing>{
  const submitted=await api<Operation>('operations','POST',{requestId:crypto.randomUUID(),nodeId:target.nodeId,command:{kind:'directory.list',path}});
  const started=Date.now();let op=submitted;
  while(!FINAL.has(op.execution)){
    if(!alive())throw Error('已关闭');if(Date.now()-started>WAIT_MS)throw Error(`设备 ${WAIT_MS/1000} 秒内没有完成读取，可在「操作」页查看原记录 ${op.id}。`);
    await pause(600);op=await api<Operation>('operations/'+encodeURIComponent(op.id));
  }
  if(op.execution!=='succeeded')throw Error({failed:'读取失败',cancelled:'读取已取消',unknown:'读取结果未知'}[op.execution]+'，原记录 '+op.id+'。');
  const listing=parseListing(op.result_json);if(!listing)throw Error('设备返回的目录内容无法识别，原记录 '+op.id+'。');
  return listing;
}

async function fillDirectory(box:HTMLElement,api:Api,target:WorkspaceTarget,path:string,depth:number,alive:()=>boolean,onPick:(rel:string)=>void){
  box.replaceChildren(el('li','files-note','正在读取…'));
  let listing:Listing;
  try{listing=await list(api,target,path,alive);}
  catch(error){
    if(!alive())return;
    const note=el('li','files-note bad',error instanceof Error?error.message:'读取失败');
    note.append(' ',btn('重试',()=>void fillDirectory(box,api,target,path,depth,alive,onPick),'quiet'));
    box.replaceChildren(note);return;
  }
  if(!alive())return;
  const rows=listing.entries.map(entry=>{
    const full=joinPath(target.platform,path,entry.name),item=el('li','files-item');
    item.setAttribute('role','treeitem');item.style.setProperty('--depth',String(depth));
    const row=el('button','files-row'+(entry.directory?' dir':''));row.type='button';
    row.append(el('span','files-caret',entry.directory?'▸':''),el('span','files-name',entry.name),el('span','files-size',entry.directory?'':size(entry.bytes)));
    if(entry.directory){
      const children=el('ul','files-tree');children.hidden=true;item.setAttribute('aria-expanded','false');let loaded=false;
      row.addEventListener('click',()=>{
        const expand=children.hidden;children.hidden=!expand;item.setAttribute('aria-expanded',String(expand));
        row.querySelector('.files-caret')!.textContent=expand?'▾':'▸';
        if(expand&&!loaded){loaded=true;void fillDirectory(children,api,target,full,depth+1,alive,onPick);}
      });
      item.append(row,children);
    }else{
      row.title='把相对路径插入输入框';
      row.addEventListener('click',()=>onPick(relativePath(target.platform,target.cwd,full)));
      item.append(row);
    }
    return item;
  });
  if(!rows.length)rows.push(el('li','files-note','（空目录）'));
  if(listing.truncated)rows.push(el('li','files-note warn','只显示前 1000 项。'));
  box.replaceChildren(...rows);
}

// 内嵌到右侧「工具与连接」抽屉的设备目录树（按机器区分）。
export function mountWorkspaceTree(container:HTMLElement,api:Api,target:WorkspaceTarget,insert:(path:string)=>void){
  let open=true;const alive=()=>open;
  const root=el('ul','files-tree inline-tree');root.setAttribute('role','tree');
  container.replaceChildren(root);
  void fillDirectory(root,api,target,target.cwd,0,alive,insert);
  return {
    refresh(){void fillDirectory(root,api,target,target.cwd,0,alive,insert);},
    dispose(){open=false;},
  };
}

export function openWorkspace(api:Api,target:WorkspaceTarget,insert:(path:string)=>void){
  const dialog=el('dialog','memory-panel files-panel');document.body.append(dialog);let open=true;const alive=()=>open;
  const head=el('div','skill-manager-head');head.append(el('h2','',`工作区 · ${target.name??'Reach 设备'}`),btn('关闭',()=>dialog.close()));
  const lead=el('p','skill-manager-lead','从本次执行目录开始逐层读取。每次展开都会在设备上执行一次目录读取，并记在「操作」里。点文件把它的相对路径放进输入框。');
  const root=el('ul','files-tree');root.setAttribute('role','tree');
  const rootPath=el('code','files-root',target.cwd);
  dialog.append(head,lead,rootPath,root);
  dialog.addEventListener('close',()=>{open=false;dialog.remove();});
  const onPick=(rel:string)=>{insert(rel);dialog.close();};
  head.insertBefore(btn('刷新',()=>void fillDirectory(root,api,target,target.cwd,0,alive,onPick)),head.lastChild);
  dialog.showModal();void fillDirectory(root,api,target,target.cwd,0,alive,onPick);
}
