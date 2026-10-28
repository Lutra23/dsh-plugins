'use strict';
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const {createHash}=require('node:crypto');
const {JevClient}=require('./jev-client.cjs');
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const cap=(value,fallback,min,max)=>Number.isFinite(Number(value))?Math.min(max,Math.max(min,Math.floor(Number(value)))):fallback;

// Read the existing VCP pool without dotenv.config(), process.env mutation,
// copying credentials to Forge, or depending on the VCP GUI/server being open.
class VcpJevPool {
 constructor({sourceFile,loadVcp=null,disabled=false}={}){
  this.sourceFile=sourceFile;this.loadVcp=loadVcp;this.disabled=disabled;
  this.loaded=null;this.current=null;this.sharedUsage=null;this.info={configured:false,reason:'尚未读取池配置'};
 }
 refresh(){
  if(this.disabled)return this.info={configured:false,reason:'测试环境禁用真实 JEV'};
  try{
   const source=JSON.parse(fs.readFileSync(this.sourceFile,'utf8'));
   if(source.enabled!==true)return this.info={configured:false,reason:'DSH 的 VCP JEV 接入已关闭'};
   const vcpRoot=fs.realpathSync(source.vcpRoot),configFile=path.join(vcpRoot,'config.env');
   if(!this.loaded||this.loaded.root!==vcpRoot){
    const req=createRequire(path.join(vcpRoot,'package.json'));
    const deps=this.loadVcp?this.loadVcp(vcpRoot):{Client:req('./modules/jevClient.js').JevClient,parse:req('dotenv').parse};
    this.loaded={root:vcpRoot,parse:deps.parse,selector:new deps.Client(),wire:new deps.Client()};
   }
   const env=this.loaded.parse(fs.readFileSync(configFile,'utf8'));
   if(!String(env.JEV_API_KEY||'').trim())throw new Error('missing keys');
   const provider=env.JEV_PROVIDER||'typesafe';
   const options={provider,apiKey:env.JEV_API_KEY,
    url:env.JEV_API_URL||(provider==='openrouter'?'https://openrouter.ai/api/alpha/decisions':'https://api.typesafe.ai/v1/systemone'),
    model:env.JEV_MODEL||(provider==='openrouter'?'~typesafe/jev-latest':'jev-latest'),
    proxyUrl:env.JEV_PROXY_URL||'',referer:env.JEV_HTTP_REFERER||'',title:env.JEV_APP_TITLE||'DSH Forge',
    timeoutMs:cap(env.JEV_TIMEOUT_MS,20000,1000,30000),maxRetries:0,retryBaseDelayMs:cap(env.JEV_RETRY_BASE_DELAY_MS,400,1,8000)};
   // Use VCP's own parsing/deduplication and round-robin selector. If that local
   // contract changes, report unavailable rather than silently changing pools.
   const config=this.loaded.selector._resolveConfig(options);
   if(!config.apiKeys?.length||typeof this.loaded.selector._takeNextApiKey!=='function')throw new Error('pool contract');
   const endpoint=new URL(config.url);
   if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search)throw new Error('invalid endpoint');
   const budget=cap(source.maxCalls,200,1,10000),id=digest([vcpRoot,config,budget,env.JEV_MAX_RETRIES]);
   if(!this.current||id!==this.current.id){
    const contexts=new WeakMap(),{selector,wire}=this.loaded;
    const client=new JevClient({config:{apiKey:'vcp-managed-pool',endpoint:config.url,model:config.model,
     timeoutMs:config.timeoutMs,maxRetries:cap(env.JEV_MAX_RETRIES,2,0,3),backoffMs:config.retryBaseDelayMs,
     budget:{maxCalls:budget,maxTokens:null}},transport:async({body,signal})=>{
      if(signal.aborted)throw Object.assign(new Error('cancelled'),{code:'CANCELLED'});
      let key=contexts.get(signal);
      if(!key){key=selector._takeNextApiKey(config.apiKeys);contexts.set(signal,key);}
      try{
       const json=await wire.decide(body.state,body.questions,{...options,apiKey:key,model:body.model,signal,maxRetries:0});
       return {status:200,json};
      }catch(e){
       if(signal.aborted)throw Object.assign(new Error('cancelled'),{code:'CANCELLED'});
       // Never leak provider bodies, keys, headers or proxy credentials into
       // operation receipts; the HTTP status is enough for retry classification.
       return {status:Number(e?.status)||503,json:{error:'VCP JEV 请求失败'}};
      }
     }});
    if(this.sharedUsage)client.usage=this.sharedUsage;else this.sharedUsage=client.usage;
    this.current={id,client};
   }
   return this.info={configured:true,source:'VCPToolBox',sourceFile:configFile,provider:config.provider,
    endpoint:endpoint.origin+endpoint.pathname,model:config.model,keyCount:config.apiKeys.length,
    rotation:'one-key-per-logical-request',cursorScope:'dsh-process',proxyEnabled:!!config.proxyUrl,
    maxCalls:budget,timeoutMs:config.timeoutMs,mode:'observe',usage:{...this.current.client.usage},
    breaker:{...this.current.client.breaker}};
  }catch{return this.info={configured:false,source:'VCPToolBox',reason:'VCP JEV 配置或客户端不可读取；请检查接入文件、config.env 和客户端版本'};}
 }
 status(){return structuredClone(this.refresh());}
 get config(){return this.current?.client.config||{model:''};}
 async evaluate(input){
  if(input?.signal?.aborted)return {status:'cancelled',code:'CANCELLED',attempts:0};
  if(!this.refresh().configured)return {status:'unavailable',code:'VCP_POOL_UNAVAILABLE',reason:this.info.reason,attempts:0};
  return this.current.client.evaluate(input);
 }
}
module.exports={VcpJevPool};
