import {randomUUID} from 'node:crypto'
import contextPanel from './context-panel.cjs'
import engineLookup from './context-engine.cjs'
const mounted=new WeakSet()
const presetOf=agent=>agent?.ctx?.get?.('agentPresets')?.composedPreset?.(agent.ctx)??agent?.ctx?.get?.('sessionProjections')?.stateOf?.(agent.session,'agentPreset')??agent?.session?.header?.agentPreset
export const isForgeAgent=agent=>['nova-forge','forge'].includes(presetOf(agent))
export const isContextAgent=agent=>engineLookup.resolveContextEngine(agent?.ctx,agent).info.configured
const automatic=m=>['forge-flowlock','goal-flow'].includes(m.source?.kind)||(m.source?.kind==='goal'&&m.source.round>0)
const userRequestsTidy=messages=>{
 const text=messages.filter(m=>m.source?.kind==='user').flatMap(m=>Array.isArray(m.content)?m.content:[]).map(b=>typeof b?.text==='string'?b.text:'').join('\n').trim()
 if(text.length===0)return false
 // 2026-10-20：旧写法只要命中「压缩/整理」二字就算命令，于是主人每问一次
 // 「压缩插件的原理」都被当成「帮我压缩」——20 万（未到 35 万线）反复弹维护指令。
 // 关键词本身分不清「命令」与「正在讨论这个命令」，所以判据换成句法：
 // 请求语必须**紧邻**动作词。中间隔了字（「现在这个压缩插件」）就不是命令。
 const tidyRequest=/(?:帮我|请你?|麻烦你?|能不能|可以|开始|主动|立刻|马上|现在|赶紧|继续|就|快)?[把将]?(?:压缩|整理)(?:一下|下|上下文|历史|会话|吧|呗|掉|了)/
 const bare=/^(?:主动|手动|现在|立刻|马上|开始|继续)?(?:压缩|整理)(?:一下|上下文|历史|会话)?[。！!～~]?$/
 const english=/^compact[。！!～~]?$/i
 // 「问题/报错/为什么/原理/怎么」这类是在问，不是命令；但仍要求句法成立才放行，
 // 否则「帮我压缩一下这个报错」会被误否决。
 const asking=/问题|报错|为什么|原理|怎么|如何|哪里|哪些|是什么/
 if(english.test(text))return true
 if(bare.test(text.trim()))return true
 if(!tidyRequest.test(text))return false
 if(asking.test(text)&&!/(?:帮我|请你?|麻烦你?|能不能|可以)[^。！？!?]{0,6}(?:压缩|整理)/.test(text))return false
 return !/不要|别|暂停|停止|取消/.test(text)
}
const message=(kind,text,extra={})=>({id:randomUUID(),role:'user',source:{kind,...extra},content:[{type:'text',text}]})
export const summaryRequestMessage=request=>message('forge-context-request','用户从施工图面板请求整理当前会话。使用 forge_context status/candidates，分页读取必要原文，保留用户约束、未决事项和证据后提交 compact。不得把整理当作工程任务完成。',{requestId:request.requestId})
const tidyMessage=tidy=>message('forge-context-auto',`上下文维护代次 ${tidy.view().generation}。先 forge_context status 核对 automatic.phase=active 且 generation 相同。暂停工程写入与 Todo 完成。用 candidates 优先选择体积大的已结束阶段或旧输出；ongoing-stage 须保留当前状态与未决事项。当前上下文中已有的原文不必再全文分页读取，只用 search/read 补读确实缺失或无法确认的细节。文件指纹用 forge_context evidence 只读取得。优先 compact_batch {operationId,items:[{candidateId,summary},...]} 一次提交最多 8 个互不重叠候选；无需手抄 sourceSeqs。每项保留约束、决策、未决项与证据，宿主逐段复测到 workBudget.targetHigh 后自动停止剩余项。完整回执按需用 receipt 查，不重复读回摘要全文。以返回的 automatic 和 hostMeasurement 为准，无需每段额外 status；失败按 failure/remainingOperationIds 修正，禁止口头宣称完成。status.budgetAnalysis 展示保护体积及估算下限；无安全候选或保护内容太多时说明原因等待处理，不为数字达标牺牲约束，不把整理记为工程进展。`,{generation:tidy.view().generation})
export async function measureContext(ctx,agent,signal,pending=[],options={}){
 const mod=await contextPanel.loadPluginModule(),service=mod.getSharedPanelService(),session=agent.session
 const get=name=>agent.ctx?.get?.(name)??ctx.get?.(name)
 let reading
 try{
  const header=session.requestHeader?.(),route=header?.config,meter=get('tokenMeter'),llm=get('llm')
  if(!meter?.measure||!route?.provider||!route?.model||!llm?.resolveModelInfo)throw Error('当前路由或宿主计量不可用')
  const info=await llm.resolveModelInfo(route.provider,route.model,signal)
  signal?.throwIfAborted()
  if(JSON.stringify(session.requestHeader?.()?.config)!==JSON.stringify(route))throw Error('计量期间路由发生变化')
  const measure=meter.measure(session,header)
  // Claimed inbox messages are not in the log yet. Include the host estimate,
  // keeping its provenance visible rather than claiming provider-exact tokens.
  const pendingTokens=pending.reduce((n,m)=>n+(meter.estimateMessage?.(m)??Math.ceil(JSON.stringify(m).length/2)),0)
  reading=mod.readPressure({requestTokens:measure.totalTokens+pendingTokens,windowTokens:info.context?.contextWindow??null,
   outputReserveTokens:route.maxTokens??info.defaultMaxTokens??0,source:`tokenMeter:${measure.baseline?.kind??'unknown'}:${route.provider}/${route.model}${pendingTokens?'+pending-estimate':''}`,routeKey:JSON.stringify(route)})
 }catch(error){if(signal?.aborted)throw error;reading=mod.unavailable(String(error.message||error))}
 service.setPressure(session,reading,!options.deferAutomatic)
 return {mod,service,reading}
}
export function installContextRuntime(ctx,getClient,taskBridge){
 const owner=ctx.root||ctx;if(mounted.has(owner))return;mounted.add(owner)
 const reminders=new Map(),agents=new Map(),timers=new Map(),userTurns=new Map()
 async function pauseFlows(agent,reason){
  const goals=agent.ctx?.get?.('goals')??ctx.get?.('goals')
  if(goals?.get?.(agent)?.activation==='armed')goals.disarm(agent)
  if(taskBridge.needsSync&&!taskBridge.needsSync(agent))return
  const c=await getClient()
  // Both schedulers have a deterministic capacity gate. Never resume them here.
  for(const method of ['flow.tick','goal.tick'])await c.request({method,sessionId:agent.session.id,input:{capacity:reason}})
  await taskBridge.sync(agent)
 }
 const warn=error=>ctx.logger?.warn?.('[forge-context] '+(error.message||error))
 taskBridge.contextRuntime={
  async interrupt(agent,reason){userTurns.delete(agent?.session?.id);const s=await contextPanel.loadService(),t=s.automaticOf(agent.session.id);if(t.active()||t.view().phase==='deferred')t.pause(reason)},
  async guardTool(exec){
   if(!exec.agent?.session||!isContextAgent(exec.agent))return
   const service=await contextPanel.loadService(),tidy=service.automaticOf(exec.agent.session.id)
   exec.signal?.throwIfAborted()
   if(!tidy.allowsTool(exec.name,exec.arguments)){
    const action=exec.name==='forge_context'?exec.arguments?.action:exec.name==='project_forge'?exec.arguments?.command:undefined
    tidy.gateRefused('维护闸门拒绝了当前工具；文件指纹请用 forge_context evidence，历史正文用 read/search。',{tool:exec.name,...(action?{action:String(action)}:{})})
    throw Object.assign(Error('上下文维护中：工程写入、Todo 完成与通用 Shell 暂缓。只读核验请用 forge_context evidence {paths:[文件路径]}；正文用 read/search，整理用 candidates/preview/compact。失败明细见 status 的 automatic.failureHistory；暂停后从面板请求整理。'),{code:'CONTEXT_MAINTENANCE'})
   }
  },
  async stopping(agent,signal){
   userTurns.delete(agent?.session?.id)
   if(!isContextAgent(agent))return false
   const {service}=await measureContext(ctx,agent,signal),tidy=service.automaticOf(agent.session.id)
   if(!tidy.blocksEngineering())return false
   if(!tidy.active()) {await pauseFlows(agent,tidy.view().reason).catch(warn);return true}
   if(agent.inbox?.nextStep?.length||agent.inbox?.nextTurn?.length)return true
   const last=agent.session.snapshotEvents().findLast(e=>e.type==='assistant/message')
   if(tidy.continuation(String(last?.seq??agent.session.seq))){
    signal?.throwIfAborted();agent.inject(tidyMessage(tidy))
   }else if(!tidy.active())await pauseFlows(agent,tidy.view().reason).catch(warn)
   return true
  }
 }
 ctx.effect(()=>()=>{mounted.delete(owner);reminders.clear();agents.clear();userTurns.clear();for(const t of timers.values())clearTimeout(t.timer);timers.clear();delete taskBridge.contextRuntime},'forge context runtime')
 ctx.on('agent/disposed',({agent})=>{
  if(!agent?.session)return
  reminders.delete(agent.session.id);agents.delete(agent.session.id);userTurns.delete(agent.session.id)
  clearTimeout(timers.get(agent.session.id)?.timer);timers.delete(agent.session.id)
  void contextPanel.loadService().then(s=>{const t=s.automaticOf(agent.session.id);if(t.active()||t.view().phase==='deferred')t.pause('会话已关闭；重新打开后请明确请求整理。')}).catch(warn)
 })
 ctx.on('agent/pre-step',async(payload,next)=>{
  const decision=await next(),agent=payload.agent
  if(decision.kind!=='enter'||payload.signal?.aborted||!agent?.session)return decision
  if(!isContextAgent(agent)){
   if(agents.has(agent.session.id)){const s=await contextPanel.loadService();s.automaticOf(agent.session.id).pause('已切换到其他预设。');agents.delete(agent.session.id);userTurns.delete(agent.session.id)}
   const clean=decision.messages.filter(m=>!['forge-context-auto','forge-context-request'].includes(m.source?.kind))
   return decision.messages.length&&!clean.length?{kind:'reject'}:{...decision,messages:clean}
  }
  const previousPreset=agents.get(agent.session.id)?.preset,currentPreset=presetOf(agent)
  agents.set(agent.session.id,{agent,preset:currentPreset})
  const session=agent.session,supplied=payload.messages||[],service=await contextPanel.loadService(),tidy=service.automaticOf(session.id)
  if(previousPreset&&previousPreset!==currentPreset&&(tidy.active()||tidy.view().phase==='deferred')){tidy.pause('会话预设已切换，请核对后重新请求整理。');userTurns.delete(session.id)}
  const user=supplied.some(m=>m.source?.kind==='user'),chatTidy=user&&userRequestsTidy(supplied),wasActive=tidy.active(),wasPaused=tidy.view().phase==='paused'
  if(user&&!chatTidy&&wasActive)tidy.pause('用户新消息优先；核对范围后从面板重新请求整理。')
  if(user&&!chatTidy)userTurns.set(session.id,{turn:payload.turn,steps:0,reason:tidy.view().reason})
  else if(supplied.length||chatTidy)userTurns.delete(session.id)
  const savedTurn=userTurns.get(session.id)
  const inUserTurn=!user&&!supplied.length&&savedTurn!==undefined&&savedTurn.turn===payload.turn&&savedTurn.reason===tidy.view().reason&&savedTurn.steps<6
  if(inUserTurn)savedTurn.steps++
  let pending=service.pendingSummaries(session.id)
  const valid=new Set(pending.map(r=>r.requestId))
  let messages=decision.messages.filter(m=>m.source?.kind!=='forge-context-request'||valid.has(m.source.requestId))
  if(supplied.length&&supplied.every(m=>m.source?.kind==='forge-context-request'&&!valid.has(m.source.requestId)))return {kind:'reject'}
  for(const request of pending)if(!messages.some(m=>m.source?.requestId===request.requestId))messages.push(summaryRequestMessage(request))
  const {mod,reading}=await measureContext(ctx,agent,payload.signal,messages)
  pending=service.pendingSummaries(session.id)
  if(wasPaused&&!user&&!inUserTurn&&!pending.length)return {kind:'reject'}
  if(reading.state==='known'&&reading.value.requestTokens>=reading.value.effectiveBudgetTokens){
   tidy.pause('已达到模型可用输入容量；保留本地查询，请减少输入或切换更大窗口后重试。')
   userTurns.delete(session.id)
   await pauseFlows(agent,tidy.view().reason).catch(warn);return {kind:'reject'}
  }
  // Do not let an old internal maintenance message restart a paused generation.
  const stale=supplied.filter(m=>m.source?.kind==='forge-context-auto'&&(!tidy.active()||m.source.generation!==tidy.view().generation))
  messages=messages.filter(m=>!stale.some(s=>s.id===m.id))
  if(stale.length===supplied.length&&stale.length&&!pending.length)return {kind:'reject'}
  const stepKey=`${payload.turn??session.seq}:${payload.step??session.seq}`
  if(pending.length||chatTidy)tidy.start(true)
  else if(!(user&&wasActive)&&!inUserTurn){
   const todos=mod.readContextSnapshot(session).todos
   tidy.start(false,{unfinishedTask:todos.state==='known'&&todos.value.some(t=>['doing','in_progress'].includes(t.status)),stepKey})
  }
  if(tidy.active()){
   const list=service.handle(session).candidates();tidy.candidates(list.candidates.length)
   tidy.step(stepKey)
   // Account maintenance against the existing goal budget too, without
   // invoking progress/completion decisions or resetting stalled counters.
   try {if(!taskBridge.needsSync||taskBridge.needsSync(agent)){const c=await getClient(),g=await c.request({method:'goal.tick',sessionId:session.id,input:{step:true}});if(g.budget)tidy.pause('原目标运行预算已耗尽。')}}
   catch(error){tidy.pause('无法核对目标运行预算，请检查工程服务。');warn(error)}
   const state=tidy.view(),old=timers.get(session.id)
   if(tidy.active()&&old?.generation!==state.generation){
    clearTimeout(old?.timer)
    const timer=setTimeout(()=>{
     timers.delete(session.id)
     if(!tidy.active()||tidy.view().generation!==state.generation)return
     tidy.pause('整理达到 10 分钟时间上限，请检查后重试。')
     agent.cancel?.({kind:'user'})
     void pauseFlows(agent,tidy.view().reason).catch(warn)
    },Math.max(1,state.startedAt+mod.TIDY_LIMITS.maxMs-Date.now()))
    timer.unref?.();timers.set(session.id,{timer,generation:state.generation})
   }
  }
  const verdict=mod.capacityVerdict(reading)
  if(verdict.action==='pause-flow'||tidy.view().phase==='paused')await pauseFlows(agent,tidy.view().phase==='paused'?tidy.view().reason:verdict.reason).catch(error=>{tidy.pause('暂停工程状态未确认，请检查工程服务。');warn(error)})
  if(tidy.blocksEngineering()){
   messages=messages.filter(m=>!automatic(m))
   const delivered=session.snapshotEvents().some(e=>e.type==='user/message'&&e.data.source?.kind==='forge-context-auto'&&e.data.source.generation===tidy.view().generation&&session.surface.nodes.includes(e.seq))
   if(tidy.active()&&!delivered&&!messages.some(m=>m.source?.kind==='forge-context-auto'&&m.source.generation===tidy.view().generation))messages.push(tidyMessage(tidy))
   if(!tidy.active()&&!pending.length&&supplied.length&&supplied.every(m=>automatic(m)||m.source?.kind==='forge-context-auto'))return {kind:'reject'}
  }
  const key=reading.state==='known'?`${reading.value.routeKey}:${verdict.stage}:${tidy.view().phase}`:''
  if(verdict.stage!=='unknown'&&verdict.stage!=='ok'&&key!==reminders.get(session.id)){
   reminders.set(session.id,key)
   const previous=session.snapshotEvents().findLast(e=>e.type==='user/message'&&e.data.source?.kind==='forge-context-notice'&&session.surface.nodes.includes(e.seq))
   if(previous)session.append('user/message',message('forge-context-retired','上下文计量提示已更新。'),{sourceEventSeqs:[previous.seq],surfaceOp:{op:'replace',startSeq:previous.seq,endSeq:previous.seq}})
   messages.push(message('forge-context-notice',verdict.reason+' '+tidy.view().reason+' 不得将整理记为工程进展；保护内容保持原样。'))
  }
  if(verdict.stage==='ok')reminders.delete(session.id)
  payload.signal?.throwIfAborted()
  const current=new Set(service.pendingSummaries(session.id).map(r=>r.requestId))
  messages=messages.filter(m=>(m.source?.kind!=='forge-context-request'||current.has(m.source.requestId))&&(m.source?.kind!=='forge-context-auto'||(tidy.active()&&m.source.generation===tidy.view().generation)))
  return {...decision,messages}
 })
 ctx.on('session/event',(session,event)=>{
  if(event.type==='tool/result'){
   const callId=event.data?.message?.toolCallId??event.data?.message?.source?.callId;
   if(callId)void contextPanel.loadPluginModule().then(async mod=>{
    if(mod.cleanupCompressionExchange(session,callId,event.seq))await ctx.get?.('sessions')?.flush(session);
   }).catch(warn);
  }
  if(event.type==='turn/end'&&['aborted','error'].includes(event.data?.reason?.kind)){
   void contextPanel.loadService().then(s=>{const t=s.automaticOf(session.id);if(t.active()||t.view().phase==='deferred')t.pause('本轮已取消或出错；请检查后重新请求整理。')}).catch(warn)
  }
  if(event.type!=='user/message'||event.data.source?.kind!=='forge-context-request')return
  void contextPanel.loadService().then(service=>{
   const id=event.data.source.requestId
   if(service.pendingSummaries(session.id).some(r=>r.requestId===id))service.deliverSummary(id)
  }).catch(warn)
 })
}
