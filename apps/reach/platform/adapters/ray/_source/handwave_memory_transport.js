/* Controller-only snapshot transport. Captured device/selection gates async work. */
(() => {
 'use strict';
 let peer=null, epoch=0, pending=null, activeOwner=null;
 const runOwners=new Map();
 const identity=()=>JSON.stringify([curWS&&curWS.id||'',curSess&&curSess.id||'']);
 const sessionKey=()=>[curWS&&curWS.id||'',curSess&&curSess.id||''].map(String).join('/');
 const hasSessions=()=>!!peer&&peer.caps.includes('session-v1');
 const validKey=key=>/^[A-Za-z0-9_-]{1,96}\/[A-Za-z0-9_-]{1,96}$/.test(key);
 const blocked=()=>{if(typeof addBubble==='function') addBubble('system','当前电脑或会话已变化，任务未发送；请回到原会话或重新发送。');return false;};
 const detach=run=>{
  if(run!==localRunID) return;
  // Do not finalize the old stream or write via dynamic curSess. Its original
  // transcript remains in the node audit; the selected conversation stays clean.
  localAnswer='';localStream=null;localBusy=false;sending=false;pendingLocalRetry='';pendingAsk=null;localPhase='';
  setSendUI(false);stopLocalTick();updateTaskDurations();
 };
 const continuous=t=>!!peer&&helloDone&&paired&&t.fp===peer.fp&&t.epoch===epoch&&t.owner===identity();
 const valid=t=>continuous(t)&&curWS&&curWS.device_fp===t.fp;
 const oldFrame=onFrame;
 onFrame=function(frame) {
  if(frame&&(frame.k==='agent-event'||frame.k==='out')) {
   const t=runOwners.get(frame.id);
   const terminal=(frame.k==='agent-event'&&frame.event&&frame.event.type==='agent_end')||(frame.k==='out'&&frame.done);
   if(t&&!valid(t)) {if(terminal) detach(frame.id);return;}
   // Known Run IDs keep their owner across reconnects, including terminal tails.
   // Do not evict them until a new explicit start replaces the local Run.
  }
  if(frame&&frame.k==='node-hello') {epoch++;peer={fp:frame.fp||'',caps:frame.info&&Array.isArray(frame.info.caps)?frame.info.caps:[]};pending=null;activeOwner=null;}
  return oldFrame.apply(this,arguments);
 };
 const oldSig=onSig;
 onSig=function(signal) {
  if(signal&&['paired','unpaired','pair-fail'].includes(signal.k)) {epoch++;peer=null;pending=null;activeOwner=null;}
  return oldSig.apply(this,arguments);
 };
 const oldSendSig=sendSig;
 sendSig=function(signal) {
  if(signal&&signal.k==='bye') {epoch++;peer=null;pending=null;activeOwner=null;}
  return oldSendSig.apply(this,arguments);
 };
 const oldAPI=api;
 api=async function(path,options) {
  if(path!=='/agent-context') return oldAPI.apply(this,arguments);
  const t={fp:peer&&peer.fp||'',epoch,owner:identity(),run:localRunID,key:hasSessions()?sessionKey():''};
  const memory=!!peer&&peer.caps.includes('cloud-memory-v1');
  pending={...t,ok:false};
  let body;
  try {body=JSON.parse(options.body);}catch(e){throw new Error('上下文请求无效');}
  if(!continuous(t)||body.workspace_id!==(curWS&&curWS.id)) throw new Error('电脑或工作区已变化，请重新发送');
  if(hasSessions()&&!validKey(t.key)) throw new Error('请先建立有效会话再发送');
  // A freshly created workspace has no device binding yet. Bind only an empty
  // workspace to the already paired node; never overwrite a different binding.
  if(!curWS.device_fp) {
   await oldAPI.call(this,'/workspaces/'+body.workspace_id,{method:'PATCH',body:JSON.stringify({device_fp:t.fp})});
   if(!continuous(t)) throw new Error('绑定期间工作区已变化');
   curWS.device_fp=t.fp;
   if(typeof syncRailDeviceLabels==='function') syncRailDeviceLabels();
  }
  if(!valid(t)) throw new Error('请先接入当前工作区绑定的电脑');
  // All failures block this dispatch. The legacy API does not preserve HTTP
  // status, so guessing which failures are safe to downgrade would hide 409s.
  const result=await oldAPI.call(this,path,{...options,body:JSON.stringify({...body,device_fp:t.fp,cloud_memory_v1:memory})});
  if(!valid(t)) throw new Error('电脑或工作区已变化，已丢弃迟到的上下文');
  if(memory&&result.memory_receipt&&(result.workspace_id!==body.workspace_id||result.device_fp!==t.fp)) throw new Error('云端记忆绑定不匹配');
  pending={...t,ok:true};
  return result;
 };
 const oldSendFrame=sendFrame;
 sendFrame=function(frame) {
  if(frame&&frame.k==='agent-loop'&&frame.id===localRunID) {
   if(!pending||!pending.ok||pending.run!==frame.id||!valid(pending)) {
    if(typeof addBubble==='function') addBubble('system','上下文未准备完成或电脑已变化，任务未发送；请刷新后重试。');
    return false;
   }
   const t=pending;pending=null;
   frame={...frame,...(t.key?{session_key:t.key}:{})};
   const sent=oldSendFrame.call(this,frame);
   if(sent) {activeOwner=t;runOwners.set(frame.id,t);}
   return sent;
  }
  if(frame&&['agent-loop','agent-follow','agent-steer','agent-abort','agent-ui'].includes(frame.k)&&hasSessions()) {
   // Busy follow-ups and controls belong to the Run that was actually sent,
   // never whichever conversation happened to be selected after it started.
   if(!activeOwner||!valid(activeOwner)||activeOwner.key!==sessionKey()) return blocked();
   frame={...frame,session_key:activeOwner.key};
   if(frame.k==='agent-follow') frame.id=newToolId();
  }
  const sent=oldSendFrame.call(this,frame);
  if(sent&&frame&&['agent-loop','agent-follow'].includes(frame.k)&&activeOwner) runOwners.set(frame.id,activeOwner);
  return sent;
 };
 // The queue presenter supplies only an ID previously confirmed by the Node's
 // queue snapshot. This second gate requires the original verified transport
 // ownership; a snapshot cannot manufacture a new session or permission.
 const canAdoptQueuedRun=(run,previous,binding)=>{
  const next=runOwners.get(run),before=runOwners.get(previous);
  return !!binding&&run!==previous&&previous===localRunID&&hasSessions()&&peer.caps.includes('agent-queue-v1')&&
   binding.fp===peer.fp&&binding.session_key===sessionKey()&&!!next&&!!before&&valid(next)&&valid(before)&&
   next.key===binding.session_key&&before.key===next.key&&next.fp===before.fp&&next.epoch===before.epoch;
 };
 const publicHost=typeof window==='undefined'?globalThis:window;
 publicHost.HandwaveMemoryTransport=Object.freeze({canAdoptQueuedRun,adoptQueuedRun(run,previous,binding){
  if(!canAdoptQueuedRun(run,previous,binding))return false;
  activeOwner={...runOwners.get(run),run};return true;
 }});
})();
