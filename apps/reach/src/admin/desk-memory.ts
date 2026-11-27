// Copyright (c) Ray Zhang. 对话记忆与知识库面板（参照 HandWave 知识库侧栏）：我的笔记可增删改；Agent 记下的知识与 Agent 建的技能只读。
// 数据来自用户共享的 Morrow 环境（新对话共用；之前已有独立环境的旧对话不在这里）。
type Api=<T>(path:string,method?:string,body?:unknown)=>Promise<T>;
interface Entry {id:string;title:string;path:string;status:string}
interface NoteMeta {id:string;title:string;updatedAt:number}
interface Note extends NoteMeta {content:string}
interface Overview {entries:Entry[];indexDamaged:boolean;notes:NoteMeta[];agentSkills:{name:string;description:string}[]}

function el<K extends keyof HTMLElementTagNameMap>(tag:K,className='',content?:string){const node=document.createElement(tag);if(className)node.className=className;if(content!==undefined)node.textContent=content;return node;}
function btn(label:string,run:()=>void,className='btn ghost sm'){const node=el('button',className,label);node.type='button';node.addEventListener('click',run);return node;}
const statusLabel:Record<string,[string,string]>={observed:['已核实','t-ok'],draft:['草稿','t-warn'],revoked:['已撤销','']};
export function entryStatus(status:string):[string,string]{return statusLabel[status]??[status,''];}

export async function openMemory(api:Api,showError:(text:string)=>void){
  let data:Overview;
  try{data=await api<Overview>('desk/memory');}catch(error){showError(error instanceof Error?error.message:'记忆读取失败');return;}
  const dialog=el('dialog','memory-panel');document.body.append(dialog);
  const head=el('div','skill-manager-head');head.append(el('h2','','记忆与知识库'),btn('关闭',()=>dialog.close()));
  const lead=el('p','skill-manager-lead','新对话共用这里的记忆：Agent 记下的知识、它建的技能，以及你自己写给它的笔记。Agent 需要时会检索这些内容；它们是参考资料，不是指令。');
  const nav=el('nav','skill-manager-list'),pane=el('section','memory-pane');
  const sections:[string,()=>void][]=[['我的笔记',()=>notes()],['Agent 记下的知识',()=>entries()],['Agent 建的技能',()=>agentSkills()]];
  const select=(index:number)=>{nav.querySelectorAll('button').forEach((node,i)=>node.setAttribute('aria-current',String(i===index)));sections[index][1]();};
  sections.forEach(([label],index)=>nav.append(btn(label,()=>select(index),'skill-manager-item')));
  const reload=async()=>{data=await api<Overview>('desk/memory');};

  function notes(focus?:string){
    pane.replaceChildren();const top=el('div','memory-toolbar');top.append(el('span','hint',`${data.notes.length} 条笔记`),btn('＋ 新笔记',()=>edit(null),'btn primary sm'));pane.append(top);
    if(!data.notes.length)pane.append(el('p','skill-empty','还没有笔记。写下 Agent 应该知道的事，比如常用服务器、部署约定、排查习惯。'));
    const list=el('div','memory-list');for(const note of data.notes){const row=btn(note.title,()=>edit(note.id),'memory-row');if(note.id===focus)row.setAttribute('aria-current','true');list.append(row);}pane.append(list);
  }
  async function edit(id:string|null){
    let note:Note|null=null;
    if(id)try{note=(await api<{note:Note}>('desk/memory/notes/'+id)).note;}catch(error){showError(error instanceof Error?error.message:'笔记读取失败');return;}
    pane.replaceChildren();const form=el('form','skill-form');
    const title=el('input');title.maxLength=120;title.required=true;title.value=note?.title??'';title.placeholder='例如：跳板机与端口';
    const content=el('textarea');content.required=true;content.rows=12;content.value=note?.content??'';content.placeholder='Markdown，单条不超过 32 KB';
    const field=(label:string,control:HTMLElement)=>{const box=el('label','field');box.append(el('span','',label),control);return box;};
    const status=el('p','skill-form-status');status.setAttribute('role','status');
    const actions=el('div','actions');actions.append(btn('返回列表',()=>notes(id??undefined)));
    if(note){const remove=btn('删除',()=>{if(remove.dataset.armed!=='1'){remove.dataset.armed='1';remove.textContent='确认删除';remove.classList.add('solid');return;}
      void api('desk/memory/notes/'+note!.id,'DELETE').then(async()=>{await reload();notes();},error=>{status.textContent=error instanceof Error?error.message:'删除未完成';});},'btn danger');actions.append(remove);}
    const save=el('button','btn primary',note?'保存':'创建');save.type='submit';actions.append(save);
    form.onsubmit=event=>{event.preventDefault();save.disabled=true;status.textContent='';
      const body={title:title.value,content:content.value};
      void (note?api<{note:Note}>('desk/memory/notes/'+note.id,'PUT',body):api<{note:Note}>('desk/memory/notes','POST',body))
        .then(async result=>{note=result.note;await reload();status.textContent='已保存，新对话的 Agent 可以检索到。';save.textContent='保存';})
        .catch(error=>{status.textContent=error instanceof Error?error.message:'保存未完成';}).finally(()=>{save.disabled=false;});};
    form.append(field('标题',title),field('内容（Markdown）',content),status,actions);pane.append(form);title.focus();
  }
  function entries(){
    pane.replaceChildren();
    if(data.indexDamaged)pane.append(el('p','notice warn','知识库索引的受管段落格式异常，Agent 写入知识时会拒绝覆盖。这里不自动修复。'));
    if(!data.entries.length){pane.append(el('p','skill-empty','Agent 还没有记下知识。对话里让它「记下来」，它会用知识库工具写成带来源的笔记。'));return;}
    const list=el('div','memory-list');
    for(const entry of data.entries){const row=el('details','memory-entry');const summary=el('summary');const [label,tone]=entryStatus(entry.status);const pill=el('span',`pill ${tone}`);pill.append(el('i','dot'),document.createTextNode(label));summary.append(el('span','memory-entry-title',entry.title),pill);row.append(summary);
      const body=el('pre','memory-entry-body','读取中…');row.addEventListener('toggle',()=>{if(!row.open||body.dataset.loaded)return;body.dataset.loaded='1';void api<{content:string}>('desk/memory/file?path='+encodeURIComponent(entry.path)).then(r=>{body.textContent=r.content;},error=>{body.textContent=error instanceof Error?error.message:'读取失败';});});
      row.append(body);list.append(row);}
    pane.append(el('p','hint','由 Agent 用知识库工具维护（含来源与修订），这里只读。'),list);
  }
  function agentSkills(){
    pane.replaceChildren();
    if(!data.agentSkills.length){pane.append(el('p','skill-empty','Agent 还没有建技能。它在对话里总结出可复用的做法时，可以存成技能。你自己写的技能在输入框的「技能」里管理。'));return;}
    const list=el('div','memory-list');for(const skill of data.agentSkills){const row=el('div','memory-skill');row.append(el('b','',skill.name),el('small','',skill.description||'没有说明'));list.append(row);}
    pane.append(el('p','hint','Agent 用技能工具维护，这里只读。'),list);
  }
  const body=el('div','skill-manager-body');body.append(nav,pane);dialog.append(head,lead,body);
  dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();select(0);
}
