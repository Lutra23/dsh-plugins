'use strict';
// GF04（主文档 §6.3 / §6.4）：JEV 传输客户端。只管「发什么、怎么发、怎么死」——
// 语义解释在 goal-judgments/decision-policy，授权与硬门槛永远在代码侧。
// 铁律：
//  * 没配置就是 unavailable：不发请求、不假装有判断（§12 未配置或测试时必须用 mock，不暗中联网）。
//  * 401/422 是配置/契约错误，不盲目重试；429/529/5xx 才退避；本客户端不用 SDK，重试只有这一层（§6.4 不叠加）。
//  * 缺失/非法答案进 unavailable，不能用默认 yes；校验题目集合、类型、选项、有限数值与概率分布（§6.3）。
//  * usage 拿不到就标未知，不伪报零费用（GA36）；概率从不单独构成授权或完成依据。
const DEFAULT_ENDPOINT='https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL='jev-latest';
const RETRYABLE=new Set([408,425,429,500,502,503,504,529]);
const FATAL=new Set([400,401,403,404,422]);
const sha=text=>require('node:crypto').createHash('sha256').update(String(text)).digest('hex');
const redact=key=>!key?'(未配置)':String(key).slice(0,4)+'***'+String(key).slice(-2);
function sleep(ms,signal){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(Object.assign(new Error('已取消'),{code:'CANCELLED'}));
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},ms);
  const onAbort=()=>{clearTimeout(timer);reject(Object.assign(new Error('已取消'),{code:'CANCELLED'}));};
  signal?.addEventListener('abort',onAbort,{once:true});
 });
}
async function httpTransport({url,headers,body,signal}){
 const res=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),signal});
 let json=null,text='';
 try{text=await res.text();json=text?JSON.parse(text):null;}catch{json=null;}
 return {status:res.status,json,text};
}
function withAbort(work,signal){
 return new Promise((resolve,reject)=>{
  const abort=()=>reject(Object.assign(new Error('已取消'),{code:'CANCELLED'}));
  if(signal?.aborted)return abort();
  signal?.addEventListener('abort',abort,{once:true});
  Promise.resolve().then(work).then(resolve,reject).finally(()=>signal?.removeEventListener('abort',abort));
 });
}

class JevClient{
 constructor({transport=null,config={},clock=()=>Date.now(),logger=null}={}){
  this.config={endpoint:DEFAULT_ENDPOINT,model:DEFAULT_MODEL,apiKey:'',timeoutMs:20000,maxRetries:2,backoffMs:400,maxBackoffMs:8000,jitter:0.25,
   breaker:{failures:3,cooldownMs:60000},budget:{maxCalls:200,maxTokens:null},cacheLimit:200,...config};
  this.config.breaker={failures:3,cooldownMs:60000,...config.breaker};
  this.config.budget={maxCalls:200,maxTokens:null,...config.budget};
  this.transport=transport||httpTransport;this.clock=clock;this.logger=logger;
  this.breaker={state:'closed',failures:0,openedAt:0};
  // usage：tokens 拿不到就是 null（未知），不写 0 冒充实测（GA36）。
  this.usage={calls:0,retries:0,transientFailures:0,fatalErrors:0,inputTokens:null,outputTokens:null,usageKnown:false,lastModel:null,lastAt:null};
  this.cache=new Map();
  this.pendingTokens=0;this.unknownTokenUsage=false;
 }
 get configured(){return !!this.config.apiKey;}
 status(){
  return {configured:this.configured,key:redact(this.config.apiKey),endpoint:this.config.endpoint,model:this.config.model,
   breaker:{...this.breaker,retryAt:this.breaker.openedAt?this.breaker.openedAt+this.config.breaker.cooldownMs:null},
   usage:{...this.usage,cost:'unknown',note:'费用只有可靠计量时才算实测；此处只报 token 未知/已知状态'},
   cache:{entries:this.cache.size,limit:this.config.cacheLimit}};
 }
 breakerOpen(){
  if(this.breaker.state!=='open')return false;
  if(this.clock()-this.breaker.openedAt>=this.config.breaker.cooldownMs){this.breaker.state='half-open';this.breaker.failures=0;return false;}
  return true;
 }
 noteTransient(){this.usage.transientFailures++;this.breaker.failures++;
  if(this.breaker.failures>=this.config.breaker.failures){this.breaker.state='open';this.breaker.openedAt=this.clock();}}
 noteSuccess(){this.breaker={state:'closed',failures:0,openedAt:0};}
 // §6.3 校验：题目集合、类型、合法选项、有限数值、概率范围与分布。缺失/非法 → unavailable，不给默认 yes。
 validateAnswers(questions,payload){
  const answers={},invalid=[],out=payload?.answers;
  if(!out||typeof out!=='object')return {answers,invalid:[{id:'*',reason:'响应缺少 answers 映射'}]};
  for(const [id,q] of Object.entries(questions||{})){
   const a=out[id];
   if(!a){invalid.push({id,reason:'响应缺少该题的答案'});continue;}
   if(a.type&&a.type!==q.type){invalid.push({id,reason:`答案类型不匹配：期望 ${q.type}，收到 ${a.type}`});continue;}
   if(q.type==='noul'){
    if(typeof a.noul!=='number'||!Number.isFinite(a.noul)||a.noul<0||a.noul>1){invalid.push({id,reason:'noul 不是 0..1 的有限数值'});continue;}
    answers[id]={type:'noul',noul:a.noul};continue;
   }
   const options=Object.keys(q.criteria||{});
   if(typeof a.choice!=='string'||!options.includes(a.choice)){invalid.push({id,reason:'choice 不在本问题定义的选项内'});continue;}
   const probs=a.probabilities;
   if(!probs||typeof probs!=='object'){invalid.push({id,reason:'缺少 probabilities'});continue;}
   const keys=Object.keys(probs);
   const missing=options.filter(o=>!keys.includes(o)),extra=keys.filter(k=>!options.includes(k));
   if(missing.length||extra.length){invalid.push({id,reason:`probabilities 与选项不匹配（缺 ${missing.join('|')||'-'}；多 ${extra.join('|')||'-'}）`});continue;}
   let sum=0,ok=true;
   for(const o of options){const p=probs[o];if(typeof p!=='number'||!Number.isFinite(p)||p<0||p>1){ok=false;break;}sum+=p;}
   if(!ok){invalid.push({id,reason:'概率存在非 0..1 的有限数值'});continue;}
   if(Math.abs(sum-1)>0.02){invalid.push({id,reason:`概率分布不合（合计 ${sum.toFixed(4)}）`});continue;}
   if(typeof a.confidence!=='number'||!Number.isFinite(a.confidence)||a.confidence<0||a.confidence>1){invalid.push({id,reason:'confidence 不是 0..1 的有限数值'});continue;}
   answers[id]={type:'choice',choice:a.choice,probabilities:Object.fromEntries(options.map(o=>[o,probs[o]])),confidence:a.confidence};
  }
  const unexpected=Object.keys(out).filter(id=>!(id in (questions||{})));
  return {answers,invalid,unexpected};
 }
 async evaluate({state,questions,fingerprint='',signal=null,cacheable=true}={}){
  if(signal?.aborted)return {status:'cancelled',code:'CANCELLED',reason:'调用方取消'};
  const ctl=new AbortController();let timedOut=false;
  const abort=()=>ctl.abort();signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;ctl.abort();},Math.max(1,Number(this.config.timeoutMs)||20000));
  try{
   // Snapshot both values: a caller cannot mutate the in-flight request or cache key.
   const input=structuredClone({state,questions});
   const result=await this.evaluateRequest({...input,fingerprint,signal:ctl.signal,cacheable});
   if(timedOut)return {status:'unavailable',code:'TIMEOUT',reason:'JEV 总请求时限已到，传输与重试已取消'};
   return result;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 async evaluateRequest({state,questions,fingerprint='',signal=null,cacheable=true}={}){
  if(!questions||!Object.keys(questions).length)return {status:'unavailable',code:'NO_QUESTIONS',reason:'没有要判断的问题'};
  if(!this.configured)return {status:'unavailable',code:'NOT_CONFIGURED',reason:'未配置 JEV：不发送请求，也不把缺失当默认 yes（§6.3/§12）'};
  const key=sha(JSON.stringify([this.config.endpoint,this.config.model,fingerprint,state,questions]));
  if(signal?.aborted)return {status:'cancelled',code:'CANCELLED',reason:'调用方取消'};
  if(cacheable&&this.cache.has(key)){const hit=this.cache.get(key);return {...structuredClone(hit),fromCache:true,attempts:0,usage:null};}
  if(this.breakerOpen())return {status:'unavailable',code:'CIRCUIT_OPEN',reason:'熔断中：连续临时失败后暂停调用，稍后重试',breaker:{...this.breaker}};
  if(Number(this.config.budget.maxCalls)&&this.usage.calls>=Number(this.config.budget.maxCalls))
   return {status:'unavailable',code:'BUDGET_EXHAUSTED',reason:`JEV 调用预算已用尽（maxCalls=${this.config.budget.maxCalls}）`};
  const deadline=this.clock()+this.config.timeoutMs;
  let attempt=0,lastReason='';
  while(attempt<=this.config.maxRetries){
   if(signal?.aborted)return {status:'cancelled',code:'CANCELLED',attempts:attempt,reason:'调用方取消'};
   if(Number(this.config.budget.maxCalls)>0&&this.usage.calls>=Number(this.config.budget.maxCalls))
    return {status:'unavailable',code:'BUDGET_EXHAUSTED',attempts:attempt,reason:'JEV 调用预算已用尽，重试同样计入预算'};
   const tokenCap=Number(this.config.budget.maxTokens)||0;
   // Conservative admission estimate; actual provider usage remains authoritative.
   const reserve=tokenCap?Buffer.byteLength(JSON.stringify({state,questions}),'utf8')+Object.keys(questions).length*256:0;
   if(tokenCap&&(this.unknownTokenUsage||(this.usage.inputTokens||0)+(this.usage.outputTokens||0)+this.pendingTokens+reserve>tokenCap))
    return {status:'unavailable',code:'TOKEN_BUDGET_EXHAUSTED',attempts:attempt,reason:this.unknownTokenUsage?'上次请求用量未知，不能证明仍有 token 预算':'剩余 token 预算不足以预留本次请求（包含重试）'};
   this.pendingTokens+=reserve;
   this.usage.calls++;if(attempt)this.usage.retries++;
   let res;
   try{
    res=await withAbort(()=>this.transport({url:this.config.endpoint,headers:{Authorization:'Bearer '+this.config.apiKey,'Content-Type':'application/json'},
     body:{state,model:this.config.model,questions},signal}),signal);
   }catch(e){
    if(e?.code==='CANCELLED'||signal?.aborted)return {status:'cancelled',code:'CANCELLED',attempts:attempt+1,reason:'调用方取消'};
    lastReason=`传输错误：${e?.message||e}`;this.noteTransient();
   }finally{
    this.pendingTokens-=reserve;
    const u=res?.json?.usage;
    if(reserve&&(!Number.isFinite(u?.input_tokens)||!Number.isFinite(u?.output_tokens)))this.unknownTokenUsage=true;
   }
   if(res){
    if(FATAL.has(res.status)){this.usage.fatalErrors++;this.noteSuccess();
     return {status:'rejected',code:'CONFIG_OR_CONTRACT',httpStatus:res.status,attempts:attempt+1,
      reason:res.status===401?'鉴权失败（401）：密钥无效或缺失，不重试':'请求未通过校验（'+res.status+'）：契约或字段错误，不重试',
      detail:res.json?.error||res.json?.message||res.text||null};}
    if(RETRYABLE.has(res.status)){lastReason=`服务暂时不可用（HTTP ${res.status}）`;this.noteTransient();}
    else if(res.status>=200&&res.status<300){
     const model=typeof res.json?.model==='string'?res.json.model:this.config.model;
     this.usage.lastModel=model;this.usage.lastAt=new Date(this.clock()).toISOString();
     const tokens=res.json?.usage;
     if(tokens&&Number.isFinite(tokens.input_tokens)&&Number.isFinite(tokens.output_tokens)){
      this.usage.usageKnown=true;
      this.usage.inputTokens=(this.usage.inputTokens||0)+tokens.input_tokens;
      this.usage.outputTokens=(this.usage.outputTokens||0)+tokens.output_tokens;
     }
     const {answers,invalid,unexpected}=this.validateAnswers(questions,res.json);
     const valid=Object.keys(answers).length;
     const status=valid===0?'unavailable':(invalid.length?'partial':'ok');
     const result={status,model,answers,invalid,unexpected,attempts:attempt+1,usage:tokens??null,fromCache:false,
      reason:status==='ok'?'':(status==='partial'?`部分答案非法，已丢弃：${invalid.map(i=>i.id).join(',')}`:`全部答案非法：${invalid.map(i=>i.id+':'+i.reason).join('; ')}`),
      questionVersions:null};
     this.noteSuccess();
     if(status!=='unavailable'&&cacheable)this.storeCache(key,result);
     return result;
    } else {this.usage.fatalErrors++;this.noteSuccess();
     return {status:'rejected',code:'UNEXPECTED_STATUS',httpStatus:res.status,attempts:attempt+1,reason:`未预期的响应状态 ${res.status}`};}
   }
   attempt++;
   if(attempt>this.config.maxRetries)break;
   const base=Math.min(this.config.maxBackoffMs,this.config.backoffMs*Math.pow(2,attempt-1));
   const jitter=1+this.config.jitter*(Math.random()*2-1);
   const wait=Math.round(base*jitter);
   if(this.clock()+wait>deadline)break;
   try{await sleep(wait,signal);}catch{return {status:'cancelled',code:'CANCELLED',attempts:attempt,reason:'调用方取消'};}
  }
  return {status:'unavailable',code:'RETRY_EXHAUSTED',attempts:attempt,reason:`重试预算用尽：${lastReason||'未知原因'}（预算照计，不能据此通过验收）`};
 }
 storeCache(key,result){
  if(this.cache.size>=this.config.cacheLimit)this.cache.delete(this.cache.keys().next().value);
  this.cache.set(key,{...structuredClone(result),fromCache:false,cachedAt:new Date(this.clock()).toISOString()});
 }
 clearCache(){this.cache.clear();}
}
// 离线 mock：按脚本或函数返回响应；默认回归绝不联网（§14）。找不到脚本时返回 500 而不是猜答案。
class MockTransport{
 constructor(script={}){this.script=script;this.calls=[];}
 payloadFor(body){
  if(typeof this.script==='function')return this.script(body,this.calls.length);
  const answers={};let answered=0;
  for(const [id,q] of Object.entries(body.questions||{})){
   const planned=this.script[id]!==undefined?this.script[id]:this.script[String(id).split(':')[0]];
   if(planned===undefined)continue;
   answers[id]=q.type==='noul'?{type:'noul',noul:planned}
    :{type:'choice',choice:planned.choice??planned,probabilities:planned.probabilities??this.spread(q,planned.choice??planned),confidence:planned.confidence??0.9};
   answered++;
  }
  return answered?{model:'mock-jev-1',answers,usage:{input_tokens:0,output_tokens:0}}:null;
 }
 spread(q,choice){const keys=Object.keys(q.criteria||{}),out={};const rest=keys.length>1?0.05/(keys.length-1):0;for(const k of keys)out[k]=k===choice?0.95:rest;return out;}
 async send({body}){
  this.calls.push(body);
  const payload=this.payloadFor(body);
  if(!payload)return {status:500,json:{error:'mock 未给出该问题的答案'}};
  return {status:200,json:payload};
 }
}
module.exports={JevClient,MockTransport,httpTransport,DEFAULT_ENDPOINT,DEFAULT_MODEL,RETRYABLE,FATAL,redact};
