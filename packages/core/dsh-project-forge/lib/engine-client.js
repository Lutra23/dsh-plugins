import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const clients=new Map()
export function getEngineClient({dataDir=path.join(ROOT,'data'),node=process.execPath,workspaces=()=>null}={}){
  const key=path.resolve(dataDir).toLowerCase()
  if(clients.has(key)){const c=clients.get(key);c.workspaceProvider=workspaces;return c}
  const c={workspaceProvider:workspaces,starting:null,info:null}
  async function discover(){try{const d=JSON.parse(await fs.readFile(path.join(dataDir,'engine.json'),'utf8'));if(d.protocolVersion!==2)return null;const r=await fetch(d.origin+'/rpc',{method:'POST',headers:{'Content-Type':'application/json','X-Forge-Key':d.key},body:JSON.stringify({method:'revision'}),signal:AbortSignal.timeout(1000)});if(!r.ok)return null;const v=await r.json();return v.ok?{...d,capabilities:v.result?.capabilities||{}}:null}catch{return null}}
  c.ensure=async()=>{
    if(c.info){const d=await discover();if(d)return(c.info=d);c.info=null}
    if(c.starting)return c.starting
    c.starting=(async()=>{
      let d=await discover();if(d)return(c.info=d)
      await fs.mkdir(dataDir,{recursive:true})
      const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PF_/i.test(k)))
      Object.assign(env,{PF_DATA_DIR:dataDir,PF_EXTRA_WORKSPACES:JSON.stringify(c.workspaceProvider()||[]),PF_DESKTOP_WORKSPACES_FILE:path.join(os.homedir(),'.dsh','storages','workspace.json')})
      const child=spawn(node,[path.join(ROOT,'lib','server.cjs'),'--daemon'],{cwd:ROOT,windowsHide:true,detached:true,stdio:'ignore',env})
      let launchError;child.once('error',e=>{launchError=e});child.unref()
      for(let i=0;i<80;i++){if(launchError)throw launchError;d=await discover();if(d)return(c.info=d);await new Promise(r=>setTimeout(r,150))}
      throw new Error('工程服务启动失败；请运行 npm run doctor 查看路径、数据库锁和原生依赖。')
    })().finally(()=>{c.starting=null})
    return c.starting
  }
  c.request=async(msg,{signal,timeoutMs=180000}={})=>{
    const d=await c.ensure(),operationId=msg.operationId||randomUUID()
    // Protocol v2 predates the task bridge. Never send new mutations to an old
    // live daemon or spawn a competing owner of its database during an update.
    if(!['revision','status','operations','inspect','cancel'].includes(msg.method)&&
       (d.capabilities.taskPolicy!==1||d.capabilities.flowLock!==1))
      throw Object.assign(new Error('工程服务尚未加载任务/心流接口；请在当前工作结束后重启 DSH 工程服务。普通聊天仍可使用。'),{code:'ENGINE_CAPABILITY_MISMATCH'})
    const relayArgs=msg.args||msg.params?.task||{}
    if(String(msg.method||'').startsWith('goal.')&&(d.capabilities.goalControl!==1||d.capabilities.goalHostProtocol!==2))
      throw Object.assign(new Error('工程服务尚未加载修复后的目标心流；请在任务结束后更新后台服务并重开 DSH。'),{code:'ENGINE_GOAL_MISMATCH'})
    if(msg.source?.channel==='goal-chat'&&d.capabilities.goalChatControl!==1)
      throw Object.assign(new Error('工程服务尚未加载聊天心流入口；请在任务结束后更新后台服务并重开 DSH。'),{code:'ENGINE_GOAL_CHAT_MISMATCH'})
    if(msg.method==='panel'&&['documents.rewrite','documents.restore','documents.versions','documents.version'].includes(msg.action)&&d.capabilities.blueprintVersions!==1)
      throw Object.assign(new Error('工程服务尚未加载施工图版本接口；请在任务结束后安全重载工程服务。'),{code:'ENGINE_CAPABILITY_MISMATCH'})
    if((String(relayArgs.command||'').toLowerCase()==='bindproject'||String(relayArgs.taskaction||relayArgs.taskAction||'').toLowerCase()==='handoff')&&
       (d.capabilities.taskHandoff!==1||d.capabilities.taskSync!==2))
      throw Object.assign(new Error('工程服务尚未加载跨会话接力接口；请在当前工作结束后安全重载服务，不能向旧版本提交交接。'),{code:'ENGINE_HANDOFF_MISMATCH'})
    const payload={...msg,operationId,...(Array.isArray(c.workspaceProvider())?{workspaces:c.workspaceProvider()}: {})}
    const request=async(body,timeout)=>{const r=await fetch(d.origin+'/rpc',{method:'POST',headers:{'Content-Type':'application/json','X-Forge-Key':d.key},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});const v=await r.json();if(!v.ok)throw Object.assign(new Error(v.error),{code:v.code,receipt:v.receipt,...(v.next?{next:v.next}:{})});return v.result}
    if(signal?.aborted)return {receipt:{operationId,status:'cancelled-before-commit'},content:[{type:'text',text:'操作在发送前已取消。'}]}
    let timer,abortListener;const interrupted=new Promise(resolve=>{
      let sent=false;abortListener=async()=>{if(sent)return;sent=true;try{await request({method:'cancel',operationId},2000);const receipt=await request({method:'status',operationId},2000);resolve({receipt,content:[{type:'text',text:'等待已结束；操作状态以回执为准，请勿自动重试。'}]})}catch{resolve({receipt:{operationId,status:'unknown'},content:[{type:'text',text:'结果待核对，请使用 operationId 查询。'}]})}}
      timer=setTimeout(abortListener,timeoutMs);signal?.addEventListener('abort',abortListener,{once:true})
    })
    try{return await Promise.race([request(payload,Math.max(timeoutMs+10000,20000)),interrupted])}
    catch(e){if(!e.receipt)e.receipt={operationId,status:'unknown'};throw e}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abortListener)}
  }
  clients.set(key,c);return c
}
