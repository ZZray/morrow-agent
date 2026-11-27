// Copyright (c) Ray Zhang. 对话里的工具调用过程：把服务端转发的 tool_start / tool_end 合并成步骤，并画成可展开的列表。
// 只用于显示过程；回答是否完成仍以 settled 与原记录为准。思考文本 Morrow 不落盘，这里没有。
export interface Step {stepId:string;title:string;status:string;detail:string;output:string;effectsUnknown:boolean;ended:boolean}
interface StepData {stepId?:unknown;title?:unknown;status?:unknown;detail?:unknown;output?:unknown;effectsUnknown?:unknown}
const LIMIT=200;
const text=(value:unknown)=>typeof value==='string'?value:'';

// 收到一条步骤事件后返回新的步骤列表（同一 stepId 合并；字段不合法时原样返回）。
export function applyStepEvent(steps:Step[]|undefined,kind:string,data:StepData):Step[]{
  const list=steps??[];
  if((kind!=='tool_start'&&kind!=='tool_end')||typeof data.stepId!=='string'||!data.stepId)return list;
  const existing=list.find(step=>step.stepId===data.stepId);
  if(!existing&&list.length>=LIMIT)return list;
  const step:Step=existing?{...existing}:{stepId:data.stepId,title:'',status:'',detail:'',output:'',effectsUnknown:false,ended:false};
  step.title=text(data.title)||step.title;step.status=text(data.status)||step.status;
  if(kind==='tool_start')step.detail=text(data.detail)||step.detail;
  else {step.output=text(data.output);step.effectsUnknown=data.effectsUnknown===true;step.ended=true;}
  return existing?list.map(item=>item.stepId===step.stepId?step:item):[...list,step];
}

// 步骤状态归类：进行中 / 成功 / 失败 / 效果未知。
export function stepTone(step:Step):'run'|'ok'|'bad'|'warn'{
  if(!step.ended)return 'run';
  if(step.effectsUnknown)return 'warn';
  return /^(ok|success|succeeded|completed|done)$/i.test(step.status)?'ok':/(error|fail|denied|reject|cancel)/i.test(step.status)?'bad':'ok';
}
const toneLabel:Record<ReturnType<typeof stepTone>,string>={run:'进行中',ok:'完成',bad:'失败',warn:'效果未知'};

function el<K extends keyof HTMLElementTagNameMap>(tag:K,className='',content?:string){const node=document.createElement(tag);if(className)node.className=className;if(content!==undefined)node.textContent=content;return node;}

// 原地更新步骤列表：保留外层与各步骤的展开状态，避免流式更新时折叠被重置。
export function paintSteps(box:HTMLDetailsElement,steps:Step[]|undefined){
  const list=steps??[];
  box.hidden=list.length===0;if(!list.length)return;
  const running=list.filter(step=>!step.ended).length;
  const opened=new Set([...box.querySelectorAll<HTMLDetailsElement>('details.tool-step[open]')].map(node=>node.dataset.step));
  const summary=el('summary','',`工具调用 · ${list.length} 步${running?`（${running} 步进行中）`:''}`);
  const rows=el('ol','tool-step-list');
  for(const step of list){
    const tone=stepTone(step),row=el('details',`tool-step t-${tone}`);row.dataset.step=step.stepId;if(opened.has(step.stepId))row.open=true;
    const head=el('summary');head.append(el('i','dot'),el('span','tool-step-title',step.title||'工具'),el('span','tool-step-state',toneLabel[tone]));
    row.append(head);
    if(step.detail)row.append(el('pre','tool-step-detail',step.detail));
    if(step.ended&&step.output)row.append(el('pre','tool-step-output',step.output));
    if(!step.detail&&!(step.ended&&step.output))row.append(el('p','tool-step-empty',step.ended?'没有输出。':'等待结果…'));
    rows.append(row);
  }
  box.replaceChildren(summary,rows);
}
