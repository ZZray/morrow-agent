// Copyright (c) Ray Zhang. 对话技能（参照 HandWave skills-ui）：输入框「技能」与「/」选择器、已选技能条、技能管理对话框。
// 技能是用户写的 Markdown 指令，按条消息显式选择后随消息发送；服务端做存在、条数与大小校验。
export interface SkillMeta {id:string;name:string;description:string;updatedAt:number}
interface Skill extends SkillMeta {content:string}
type Api=<T>(path:string,method?:string,body?:unknown)=>Promise<T>;
export const MAX_SELECTED=8;

function el<K extends keyof HTMLElementTagNameMap>(tag:K,className='',content?:string){const node=document.createElement(tag);if(className)node.className=className;if(content!==undefined)node.textContent=content;return node;}
function btn(label:string,run:()=>void,className=''){const node=el('button',className,label);node.type='button';node.addEventListener('click',run);return node;}

// 「/查询」：输入框只有一个以 / 开头、不含空白的词时，返回查询词；否则不是技能触发。
export function slashQuery(value:string):string|null{const match=/^\/(\S*)$/.exec(value);return match?match[1]:null;}
export function filterSkills(skills:SkillMeta[],query:string){const q=query.trim().toLowerCase();return q?skills.filter(skill=>skill.name.toLowerCase().includes(q)||skill.description.toLowerCase().includes(q)):skills;}
export function toggleSelection(selected:string[],id:string):string[]{return selected.includes(id)?selected.filter(item=>item!==id):selected.length>=MAX_SELECTED?selected:[...selected,id];}

export class DeskSkills {
  readonly bar:HTMLElement;readonly trigger:HTMLButtonElement;
  private skills:SkillMeta[]=[];private loaded=false;private picker:HTMLElement|null=null;private dialog:HTMLDialogElement|null=null;
  private selections=new Map<string,string[]>();private key='new';
  private readonly api:Api;private readonly showError:(text:string)=>void;private readonly input:HTMLTextAreaElement;private readonly anchor:HTMLElement;private readonly onChange:()=>void;
  constructor(api:Api,showError:(text:string)=>void,input:HTMLTextAreaElement,anchor:HTMLElement,onChange:()=>void){
    this.api=api;this.showError=showError;this.input=input;this.anchor=anchor;this.onChange=onChange;
    this.bar=el('div','skill-bar');this.bar.hidden=true;this.bar.setAttribute('aria-label','本条消息使用的技能');
    this.trigger=btn('技能',()=>{void this.togglePicker('');},'quiet skill-trigger');this.trigger.title='为下一条消息选择技能（也可以在输入框输入 /）';this.trigger.setAttribute('aria-haspopup','listbox');
    input.addEventListener('input',()=>{const query=slashQuery(input.value);if(query!==null)void this.openPicker(query,true);else if(this.picker?.dataset.slash==='1')this.closePicker();});
    input.addEventListener('keydown',event=>{if(this.picker&&event.key==='Escape'){event.preventDefault();this.closePicker();}});
    document.addEventListener('pointerdown',event=>{if(this.picker&&event.target instanceof Node&&!this.picker.contains(event.target)&&!this.trigger.contains(event.target)&&!(event.target instanceof Element&&event.target.closest('.attach-menu')))this.closePicker();});
  }
  openPickerFromMenu(){void this.openPicker('',false);}
  // 切换对话时换成该对话自己的已选技能。
  use(key:string){this.key=key;this.closePicker();this.paintBar();}
  selected(){return this.selections.get(this.key)??[];}
  names(ids:string[]){return ids.map(id=>this.skills.find(skill=>skill.id===id)?.name??'已删除的技能');}
  clear(){this.selections.set(this.key,[]);this.paintBar();}
  private set(ids:string[]){this.selections.set(this.key,ids);this.paintBar();this.onChange();}
  async refresh(){try{const result=await this.api<{skills:SkillMeta[]}>('desk/skills');this.skills=result.skills;this.loaded=true;}catch(error){this.loaded=false;throw error;}
    // 已删除的技能从已选里去掉。
    for(const [key,ids] of this.selections)this.selections.set(key,ids.filter(id=>this.skills.some(skill=>skill.id===id)));this.paintBar();}
  private paintBar(){
    const ids=this.selected();this.bar.hidden=!ids.length;if(!ids.length){this.bar.replaceChildren();return;}
    this.bar.replaceChildren(el('span','skill-bar-label','技能'),...ids.map(id=>{const chip=el('span','skill-chip');chip.append(el('span','',this.names([id])[0]),btn('×',()=>this.set(this.selected().filter(item=>item!==id)),'skill-chip-remove'));(chip.lastElementChild as HTMLElement).setAttribute('aria-label','移除技能');return chip;}));
  }
  private closePicker(){this.picker?.remove();this.picker=null;this.trigger.setAttribute('aria-expanded','false');}
  private async togglePicker(query:string){if(this.picker){this.closePicker();return;}await this.openPicker(query,false);}
  private async openPicker(query:string,slash:boolean){
    if(!this.loaded)try{await this.refresh();}catch(error){this.showError(error instanceof Error?error.message:'技能列表读取失败');return;}
    if(!this.picker){this.picker=el('div','skill-picker');this.picker.setAttribute('role','listbox');this.anchor.append(this.picker);this.trigger.setAttribute('aria-expanded','true');}
    this.picker.dataset.slash=slash?'1':'0';this.paintPicker(query,slash);
  }
  private paintPicker(query:string,slash:boolean){
    if(!this.picker)return;const picker=this.picker;const selected=this.selected();
    const search=el('input','skill-search');search.type='search';search.placeholder='搜索技能';search.value=query;search.setAttribute('aria-label','搜索技能');
    const list=el('div','skill-options');
    const draw=()=>{const items=filterSkills(this.skills,search.value);list.replaceChildren();
      if(!this.skills.length)list.append(el('p','skill-empty','还没有技能。点「管理技能」写一个，比如「代码审查规范」「日志排查步骤」。'));
      else if(!items.length)list.append(el('p','skill-empty','没有匹配的技能。'));
      for(const skill of items){const row=el('label','skill-option');const box=el('input');box.type='checkbox';box.checked=this.selected().includes(skill.id);box.disabled=!box.checked&&this.selected().length>=MAX_SELECTED;
        box.addEventListener('change',()=>{this.set(toggleSelection(this.selected(),skill.id));if(slash){this.input.value='';this.input.dispatchEvent(new Event('input',{bubbles:true}));this.closePicker();this.input.focus();}else draw();});
        const text=el('span','skill-option-text');text.append(el('b','',skill.name),el('small','',skill.description||'没有说明'));row.append(box,text);list.append(row);}
    };
    search.addEventListener('input',draw);
    const foot=el('div','skill-picker-foot');foot.append(el('span','',`已选 ${selected.length}/${MAX_SELECTED}`),btn('管理技能',()=>{this.closePicker();void this.openManager();},'link'));
    picker.replaceChildren(search,list,foot);draw();if(!slash)search.focus();
  }

  // ---------- 技能管理对话框 ----------
  async openManager(focusId?:string){
    try{await this.refresh();}catch(error){this.showError(error instanceof Error?error.message:'技能列表读取失败');return;}
    this.dialog?.remove();const dialog=el('dialog','skill-manager');this.dialog=dialog;document.body.append(dialog);
    const list=el('nav','skill-manager-list'),form=el('form','skill-form');
    const head=el('div','skill-manager-head');head.append(el('h2','','技能'),btn('＋ 新技能',()=>{void edit(null);},'btn primary sm'),btn('关闭',()=>dialog.close(),'btn ghost sm'));
    const lead=el('p','skill-manager-lead','技能是你写给 Agent 的 Markdown 指令。发消息前在输入框选上，它只用于那一条消息，不会自动执行脚本或扩大权限。');
    const drawList=(active:string|null)=>{list.replaceChildren();if(!this.skills.length)list.append(el('p','skill-empty','还没有技能。'));
      for(const skill of this.skills){const item=btn(skill.name,()=>{void edit(skill.id);},'skill-manager-item');if(skill.id===active)item.setAttribute('aria-current','true');list.append(item);}};
    const edit=async(id:string|null)=>{
      let skill:Skill|null=null;
      if(id)try{skill=(await this.api<{skill:Skill}>('desk/skills/'+id)).skill;}catch(error){this.showError(error instanceof Error?error.message:'技能读取失败');return;}
      drawList(id);form.replaceChildren();
      const name=el('input');name.maxLength=128;name.required=true;name.value=skill?.name??'';name.placeholder='例如：代码审查规范';
      const description=el('input');description.maxLength=1024;description.value=skill?.description??'';description.placeholder='一句话说明什么时候用';
      const content=el('textarea');content.required=true;content.rows=12;content.value=skill?.content??'';content.placeholder='# 目标\n\n# 步骤\n1. …';
      const aiBox=el('div','skill-ai-box');
      const aiPrompt=el('textarea');aiPrompt.rows=2;aiPrompt.maxLength=8192;aiPrompt.placeholder='用一句话描述想让 AI 帮你生成的技能，例如：审查事故日志并按严重度给出排查建议';
      const aiRow=el('div','skill-ai-row');
      const aiStatus=el('span','skill-form-status');aiStatus.setAttribute('role','status');
      const aiBtn=el('button','btn ghost sm','AI 生成草稿');aiBtn.type='button';
      aiBtn.addEventListener('click',()=>{
        const prompt=aiPrompt.value.trim();
        if(!prompt){aiStatus.textContent='先描述想创建的技能';aiPrompt.focus();return;}
        if((name.value.trim()||content.value.trim())&&aiBtn.dataset.armed!=='1'){
          aiBtn.dataset.armed='1';aiStatus.textContent='当前编辑器已有内容，再次点击确认覆盖为 AI 草稿';return;
        }
        delete aiBtn.dataset.armed;
        aiBtn.disabled=true;aiStatus.textContent='正在用当前对话模型生成草稿…';
        void this.api<{draft:{name:string;description:string;content:string}}>('desk/skills/generate','POST',{prompt})
          .then(res=>{
            name.value=res.draft.name;description.value=res.draft.description;content.value=res.draft.content;
            aiStatus.textContent='草稿已回填，请检查后点击下方保存。';content.focus();
          })
          .catch(error=>{aiStatus.textContent=error instanceof Error?error.message:'生成未完成';})
          .finally(()=>{aiBtn.disabled=false;});
      });
      aiPrompt.addEventListener('input',()=>{delete aiBtn.dataset.armed;});
      aiRow.append(aiBtn,aiStatus);
      aiBox.append(el('span','skill-ai-label','让 AI 创建技能'),aiPrompt,aiRow);
      const field=(label:string,control:HTMLElement)=>{const box=el('label','field');box.append(el('span','',label),control);return box;};
      const status=el('p','skill-form-status');status.setAttribute('role','status');
      const actions=el('div','actions');
      const save=el('button','btn primary',skill?'保存':'创建');save.type='submit';
      if(skill){const remove=btn('删除',()=>{if(remove.dataset.armed!=='1'){remove.dataset.armed='1';remove.textContent='确认删除';remove.classList.add('solid');return;}
        void this.api('desk/skills/'+skill!.id,'DELETE').then(async()=>{await this.refresh();this.onChange();drawList(null);form.replaceChildren(el('p','skill-empty','已删除。'));},error=>{status.textContent=error instanceof Error?error.message:'删除未完成';});},'btn danger');actions.append(remove);}
      actions.append(save);
      form.onsubmit=event=>{event.preventDefault();save.disabled=true;status.textContent='';
        const body={name:name.value,description:description.value,content:content.value};
        void (skill?this.api<{skill:Skill}>('desk/skills/'+skill.id,'PUT',body):this.api<{skill:Skill}>('desk/skills','POST',body))
          .then(async result=>{await this.refresh();this.onChange();status.textContent=skill?'已保存。':'已创建，可以在输入框选用了。';skill=result.skill;drawList(result.skill.id);save.textContent='保存';})
          .catch(error=>{status.textContent=error instanceof Error?error.message:'保存未完成';}).finally(()=>{save.disabled=false;});};
      form.append(aiBox,field('名称',name),field('说明',description),field('内容（Markdown）',content),status,actions);name.focus();
    };
    const body=el('div','skill-manager-body');body.append(list,form);dialog.append(head,lead,body);
    dialog.addEventListener('close',()=>{dialog.remove();if(this.dialog===dialog)this.dialog=null;});
    dialog.showModal();drawList(null);
    if(focusId)await edit(focusId);else if(this.skills[0])await edit(this.skills[0].id);else await edit(null);
  }
}
