'use strict';
const {GoalJudgments}=require('./goal-judgments.cjs');
// One short request for the two independent interrupt questions. No long
// histories, artifact bodies, API secrets, or implementation prompts in state.
class GoalJevRuntime {
 constructor({pool,judgments=GoalJudgments.load()}={}){this.pool=pool;this.judgments=judgments;this.pending=new Map();this.last=new Map();}
 status(sessionId){return {...this.pool.status(),last:this.last.get(sessionId)||null};}
 cancel(sessionId){const p=this.pending.get(sessionId);if(p){p.abort();this.pending.delete(sessionId);}}
 close(){for(const key of this.pending.keys())this.cancel(key);}
 async interrupt({sessionId,run,goal,message,dialogueContext=[],fingerprint,isFresh,apply}){
  this.cancel(sessionId);
  if(!message?.id||typeof message.text!=='string')return {status:'unavailable',code:'NO_USER_MESSAGE'};
  const last=this.last.get(sessionId);
  if(last?.messageId===message.id&&last.fingerprint===fingerprint)return {...last,deduped:true};
  const state={goal:{id:goal.id,title:goal.title,objective:goal.objective,scope:goal.scope,constraints:goal.constraints},
   run:{id:run.id,status:run.status,generation:run.generation,mode:run.mode},
   latestUser:{id:message.id,text:message.text},dialogueContext};
  if(Buffer.byteLength(JSON.stringify(state),'utf8')>16000)return {status:'unavailable',code:'STATE_TOO_LARGE',reason:'插话判断仅接收 16KB 内的最小状态；超限保持暂停'};
  const controller=new AbortController();this.pending.set(sessionId,controller);
  const questions=Object.fromEntries(['user_lifecycle','user_relation'].map(id=>[id,this.judgments.compile(id)]));
  let r;
  try{r=await this.pool.evaluate({state,questions,fingerprint,signal:controller.signal});}
  catch{r={status:'unavailable',code:'JEV_UNAVAILABLE',reason:'JEV 判断不可用，保留暂停状态'};}
  const current=this.pending.get(sessionId)===controller;
  if(current)this.pending.delete(sessionId);
  if(controller.signal.aborted||!current||!isFresh())return {status:'discarded',code:'STALE_JUDGMENT'};
  const observed={status:r.status,code:r.code||null,model:r.model||null,attempts:r.attempts||0,usage:r.usage||null,
   at:new Date().toISOString(),messageId:message.id,fingerprint,mode:'observe',reason:r.reason||'',fromCache:!!r.fromCache};
  const judged={};
  for(const [id,a] of Object.entries(r.answers||{}))if(questions[id])judged[id]={...a,value:a.choice,
   provider:'vcp-pool',modelVersion:r.model||'',usage:r.usage||{},questionVersion:this.judgments.version(id)};
  observed.answered=Object.keys(judged);
  this.last.set(sessionId,observed);if(this.last.size>200)this.last.delete(this.last.keys().next().value);
  // Current policy may stop/pause but cannot auto-authorize, expand scope or
  // accept evidence. Missing/partial responses retain independent judgments.
  const applied=Object.keys(judged).length?apply(judged):null;
  return {status:r.status,observed,applied};
 }
}
module.exports={GoalJevRuntime};
