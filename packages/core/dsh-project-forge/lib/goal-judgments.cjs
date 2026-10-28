'use strict';
// GF04（主文档 §6.1/§6.2 + 判断规格 JSON）：把 8 类规格实例化成可发送的问题与可消费的答案。
// 契约来源：docs/goal-flow-jev-judgments.json（design-1.0；插话两题已接入 observe）。本模块只做编译与校验：
//  * compileRules：每题都带完整 commonInstructions + 该模板 instructions；只发最小命名 state；
//    同批问题互相看不到答案；动态 Choice 从候选构造并必带 none；seedCases 只作夹具，不当标定结果。
//  * readinessPolicy：known 用真值；absent 只对可选字段；unavailable 不许用空数组/false/旧结果顶替。
//  * §6.1：每个字段保留 known / absent / unavailable 区别——已查明不存在与未能读取不是同一件事。
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const sha=text=>createHash('sha256').update(String(text)).digest('hex');
const fail=(message,code='JUDGMENT_CONTRACT')=>{throw Object.assign(new Error(message),{code});};
const DEFAULT_SPEC=path.join(__dirname,'..','docs','goal-flow-jev-judgments.json');
const MAX_QUESTIONS_PER_BATCH=12;

// §6.1 三态：调用方可以给裸值（视为 known），也可以给 {state,value|reason} 显式标注。
function marker(value){
 if(value&&typeof value==='object'&&typeof value.state==='string'&&['known','absent','unavailable'].includes(value.state))return value;
 return null;
}
function unwrap(value){const m=marker(value);return m?(m.state==='known'?m.value:undefined):value;}
function hasPath(named,pathText){
 const parts=String(pathText).split('.');
 let cur=named;
 for(const p of parts){if(cur==null||typeof cur!=='object'||!(p in cur))return false;cur=cur[p];}
 return true;
}
function readPath(named,pathText){
 const parts=String(pathText).split('.');let cur=named;
 for(const p of parts){if(cur==null||typeof cur!=='object'||!(p in cur))return undefined;cur=cur[p];}
 const m=marker(cur);return m?(m.state==='known'?m.value:undefined):cur;
}
function stateOf(named,pathText){
 if(!hasPath(named,pathText))return 'absent';
 const m=marker(readRaw(named,pathText));return m?m.state:'known';
}
function readRaw(named,pathText){
 const parts=String(pathText).split('.');let cur=named;
 for(const p of parts){if(cur==null||typeof cur!=='object'||!(p in cur))return undefined;cur=cur[p];}
 return cur;
}

class GoalJudgments{
 constructor({spec,client=null,clock=()=>Date.now()}={}){
  if(!spec||!spec.templates)fail('缺少判断规格（templates）');
  this.spec=spec;this.client=client;this.clock=clock;
  this.common=(spec.commonInstructions||[]).slice();
  this.compileRules=(spec.compileRules||[]).slice();
  this.compositionPolicy=(spec.compositionPolicy||[]).slice();
  this.readinessPolicy=spec.readinessPolicy||{};
 }
 static load(file=DEFAULT_SPEC){return new GoalJudgments({spec:JSON.parse(fs.readFileSync(file,'utf8'))});}
 static fromSpec(spec){return new GoalJudgments({spec});}
 get ids(){return Object.keys(this.spec.templates);}
 template(id){const t=this.spec.templates[id];if(!t)fail('未知判断类型：'+id);return t;}
 // 问题契约版本：instructions + criteria 变了就是新版本（缓存与阈值都要跟着失效）。
 version(id,criteria){
  const t=this.template(id),q=t.question;
  return 'qv-'+sha([this.common.join('\n'),q.instructions,JSON.stringify(criteria??q.criteria??null),q.type].join('|')).slice(0,12);
 }
 instructionsFor(id){return [this.common.join('\n'),this.template(id).question.instructions].join('\n\n');}
 // compileRule 1+4：完整 commonInstructions + 模板 instructions；动态 Choice 的 criteria 由候选构造。
 compile(id,{criteria=null}={}){
  const t=this.template(id),q=t.question;
  const crit=criteria??q.criteria??null;
  if(q.type==='choice'){if(!crit||!Object.keys(crit).length)fail(`Choice 需要 criteria（${id}）`);}
  const question={type:q.type,instructions:this.instructionsFor(id)};
  if(q.type==='choice')question.criteria=crit;
  else if(crit)question.criteria=crit;
  return question;
 }
 // next_task：动态候选构造，keyRule task:<stable taskId>，必带 none，永不含未提供的任务。
 nextTaskCriteria(candidates=[]){
  const fields=['id','title','criteriaIds','currentProgress','expectedContribution'];
  const crit={none:this.template('next_task').question.criteria.none};
  for(const c of candidates){
   const id=c.id??c.taskId;
   if(id==null)fail('候选缺少稳定 ID');
   const desc=fields.filter(f=>c[f]!==undefined&&f!=='id').map(f=>`${f}=${typeof c[f]==='object'?JSON.stringify(c[f]):c[f]}`).join('；');
   crit[`task:${id}`]=`taskId=${id}${desc?'；'+desc:''}`;
  }
  return crit;
 }
 candidateFromOption(key,candidates=[]){
  if(key==='none')return {chosen:null,reason:'none：无候选与未满足条件相关'};
  const id=String(key).replace(/^task:/,'');
  const hit=candidates.find(c=>String(c.id??c.taskId)===id);
  if(!hit)return {chosen:null,invalid:true,reason:`答案选择了未提供的候选 ${key}：拒绝（§6.2）`};
  return {chosen:hit};
 }
 // readiness：requiredStatePaths 逐条判定 known/absent/unavailable；缺必需字段就不发（readinessPolicy）。
 readiness(id,named={}){
  const req=this.template(id).requiredStatePaths||[];
  const missing=[],unavailable=[];
  for(const p of req){
   const state=stateOf(named,p);
   if(state==='absent')missing.push(p);else if(state==='unavailable')unavailable.push(p);
  }
  if(missing.length)return {ok:false,state:'absent',reason:`必需状态缺失：${missing.join(',')}（不以空值顶替推理）`,missing,unavailable};
  if(unavailable.length)return {ok:false,state:'unavailable',reason:`必需状态读不到：${unavailable.join(',')}（属不可用，不属于空）`,missing,unavailable};
  return {ok:true,state:'known'};
 }
 // compileRule 2+3：同签名问题成批，只发这批需要的最小命名状态。
 // 能同批的前提是「必需状态的取值也相同」——两条不同的 observation 不能共用一个 state，否则答案会串。
 plan(items=[]){
  const batches=new Map(),skipped=[];
  for(const it of items){
   if(!it||!it.id)fail('判断项缺少 id');
   const t=this.template(it.id);
   const ready=this.readiness(it.id,it.state||{});
   if(!ready.ok){skipped.push({id:it.id,ref:it.ref??null,state:ready.state,reason:ready.reason});continue;}
   const paths=t.requiredStatePaths||[];
   const sig=paths.join('|')+'#'+sha(JSON.stringify(paths.map(p=>[p,readRaw(it.state||{},p)])));
   if(!batches.has(sig))batches.set(sig,{paths:paths.slice(),items:[]});
   batches.get(sig).items.push(it);
  }
  const out=[];
  for(const [sig,b] of batches){
   for(let i=0;i<b.items.length;i+=MAX_QUESTIONS_PER_BATCH){
    const chunk=b.items.slice(i,i+MAX_QUESTIONS_PER_BATCH);
    const state={},questions={},refs={};
    for(const p of b.paths)state[p]=readPath(chunk[0].state||{},p);
    for(const it of chunk){
     const criteria=it.criteria??null;
     let key=it.key||(it.ref!=null?`${it.id}:${it.ref}`:it.id);
     if(key in questions)key=`${key}#${Object.keys(questions).length}`;
     questions[key]=this.compile(it.id,{criteria});
     refs[key]={id:it.id,ref:it.ref??null,version:this.version(it.id,criteria)};
    }
    out.push({signature:sig,paths:b.paths,state,questions,refs,count:chunk.length});
   }
  }
  return {batches:out,skipped};
 }
 // 发送一批问题；答案按 refs 还原成 {类型化答案 + 问题版本}。非法/缺失答案只进 unavailable。
 async run(items,{signal=null,fingerprint='',cacheable=true,maxBatches=4}={}){
  if(!this.client)fail('没有装配 JevClient');
  const {batches,skipped}=this.plan(items);
  const results={},unavailable=[...skipped],usage={calls:0,inputTokens:null,outputTokens:null,known:false},models=new Set();
  let executed=0;
  for(const b of batches){
   if(executed>=maxBatches)break;
   const contract=sha(JSON.stringify([JSON.stringify(b.questions),this.common.join('\n')])).slice(0,16);
   const r=await this.client.evaluate({state:b.state,questions:b.questions,signal,
    fingerprint:[fingerprint,contract].filter(Boolean).join('|'),cacheable});
   models.add(r.model||this.client.config.model);
   usage.calls+=Number(r.attempts||0)||0;
   if(r.usage&&Number.isFinite(r.usage.input_tokens)){usage.known=true;usage.inputTokens=(usage.inputTokens||0)+r.usage.input_tokens;usage.outputTokens=(usage.outputTokens||0)+r.usage.output_tokens;}
   if(r.status==='cancelled')return {status:'cancelled',reason:r.reason,answers:results,unavailable,usage,models:[...models]};
   if(r.status==='rejected')return {status:'rejected',reason:r.reason,detail:r.detail??null,answers:results,unavailable,usage,models:[...models]};
   if(r.status==='unavailable'||r.status==='partial'){
    for(const inv of r.invalid||[])unavailable.push({key:inv.id,id:b.refs[inv.id]?.id??null,ref:b.refs[inv.id]?.ref??null,state:'unavailable',reason:inv.reason});
    if(r.status==='unavailable'){for(const [key,meta] of Object.entries(b.refs))if(!(key in (r.answers||{})))unavailable.push({key,id:meta.id,ref:meta.ref,state:'unavailable',reason:r.reason||'整批不可用'});}
   }
   for(const [key,a] of Object.entries(r.answers||{})){
    const meta=b.refs[key]||{};
    results[key]={id:meta.id,ref:meta.ref,questionVersion:meta.version,type:a.type,
     value:a.type==='noul'?a.noul:a.choice,probabilities:a.probabilities??null,confidence:a.confidence??null,
     model:r.model,fromCache:!!r.fromCache};
   }
   executed++;
  }
  const answered=Object.keys(results).length;
  return {status:answered?'ok':'unavailable',answers:results,unavailable,usage,models:[...models],
   batches:batches.length,executed,
   reason:answered?'':(unavailable[0]?.reason||'没有可执行的问题批次')};
 }
}
module.exports={GoalJudgments,marker,unwrap,stateOf,readPath,hasPath,MAX_QUESTIONS_PER_BATCH,DEFAULT_SPEC};
