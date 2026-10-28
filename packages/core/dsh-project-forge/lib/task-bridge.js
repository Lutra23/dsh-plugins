import {randomUUID,createHash} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import security from './path-security.cjs'
import {taskEvent,appendTaskEvent} from './task-events.js'
import {reconcileTaskContext} from './task-context.js'
import {handleContextPanel,isContextAction} from './context-panel.cjs'
import {parseChatControl} from './goal-chat-control.cjs'

const heartbeat = (text,run) => ({id:randomUUID(),role:'user',content:[{type:'text',text}],source:{kind:'forge-flowlock',generation:run.generation,projectId:run.project_id}})

/**
 * 路由提示（P2.2 · 2026-10-20）：把「该用哪套任务体系」的判断指向 skill 手册。
 *
 * 为什么存在：五套任务体系（todo / TaskAction / task_board / forge_goal / create_goal）
 * 的边界写在 `task-routing` skill 里，但审计实测该 skill 全期只被加载 9 次
 * （274 次 skill 加载中占 3.3%），且拦截文案 0 次指向它——知识在，路没通。
 * 拦截本身已是最好的教学时机（此刻正困惑"为什么被拒"），故不新增入口、
 * 不提前提问，只在拦截文案末尾补一句指向手册。
 */
const ROUTING_HINT = '（体系边界见 skill `task-routing`：todo / TaskAction / 看板 / 心流 / 会话目标各自管什么、何时切换）'
const goalHeartbeat = (text,run) => ({id:randomUUID(),role:'user',content:[{type:'text',text}],source:{kind:'goal-flow',generation:run.generation,goalId:run.goal_id,runId:run.id}})
const goalNotice=(text,run)=>({...goalHeartbeat(`目标心流状态通知（不是新的用户授权）。请向用户说明以下状态；本通知不恢复工程施工。\n${text}`,run),source:{kind:'goal-notice',generation:run.generation,runId:run.id,goalId:run.goal_id}})
const counts = todos => ({pending:todos.filter(t=>t.status==='pending').length,inProgress:todos.filter(t=>t.status==='in_progress').length,completed:todos.filter(t=>t.status==='completed').length})
const latest = (session,type) => type.startsWith('forge/')?session.snapshotEvents().map(taskEvent).findLast(e=>e.type===type):session.snapshotEvents().findLast(e=>e.type===type)
const mounted=new WeakMap()
const fileHash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
export function installTaskBridge(ctx,getClient,defineTool) {
 const owner=ctx.root||ctx
 if(mounted.has(owner))return mounted.get(owner)
 const live=new Map(),timers=new Map(),stepCounts=new Map(),reminders=new Map(),unavailable=new Set(),running=new Set(),goalRunning=new Set()
 const snapshots=new WeakMap()
 const goalTimers=new Map(),notifying=new Set()
 const controlledStops=new Set()
 const manualTurns=new Set()
 // Only pre-step delivery of a real user message can populate this map. It is
 // never rebuilt from history, tool arguments, or generated heartbeat text.
 const chatInputs=new Map()
 const chatHint=(record,text)=>({id:randomUUID(),role:'user',source:{kind:'forge-progress'},content:[{type:'text',text:`心流聊天入口回执（宿主状态，不是新的用户授权）：${text}`}]})
 const withChatHint=(decision,record)=>decision.kind==='enter'&&record?.hint&&!record.hinted
  ?(record.hinted=true,{...decision,messages:[...decision.messages,chatHint(record,record.hint)]}):decision
 const clearGoalTimer=id=>{clearTimeout(goalTimers.get(id));goalTimers.delete(id)}
 const needsSync=agent=>{
  const preset=agent?.ctx?.get?.('agentPresets')?.composedPreset?.(agent.ctx)??agent?.session?.header?.agentPreset
  return !preset||['forge','nova-forge'].includes(preset)||!!snapshots.get(agent)?.projectId||!!latest(agent.session,'forge/task-boundary')?.data.bound
 }
 const call=async msg=>(await getClient()).request(msg)
 const snapshotOf=result=>{
  if(!result||!(result.projectId===null||typeof result.projectId==='string')||!Array.isArray(result.todos)||!Object.hasOwn(result,'run'))
   throw Object.assign(new Error('工程状态尚未确认，请稍后核对；本次不提交任务转换'),{code:'ENGINE_INVALID_SNAPSHOT'})
  return result
 }
 const remember=agent=>{if(agent?.session)live.set(agent.session.id,agent)}
 const clearTimer=id=>{clearTimeout(timers.get(id));timers.delete(id)}
 function mirror(agent,snapshot) {
  // 否决权只属于「本宿主生命周期已接受过的快照」——它拦的是并发迟到的回滚响应。会话日志
  // 水位是跨生命周期的记忆：引擎侧绑定行/任务状态可能被合法重建到更低（工程重置、绑定行
  // 重建），旧世界的日志水位无权否决引擎现状，必须 rebase（接受引擎并重写水位），否则该
  // 会话的 forge_context 整理通道会永久卡死（毒化悬案的根因）。
  const accepted=snapshots.get(agent)
  // 引擎说未绑定时，只有本生命周期接受过快照才否决（拦迟到的 unbound 响应）；
  // 日志里的 bound 标记是旧世界记忆，无权否决——否则绑定行被清理的会话永久卡死。
  if(!snapshot.projectId)return !accepted
  const session=agent.session,focus=snapshot.focus?.project_id===snapshot.projectId?snapshot.focus:null
  if(accepted){
   if((snapshot.bindingRevision??0)<(accepted.bindingRevision??0))return false
   if(accepted.projectId===snapshot.projectId){
    if((snapshot.eventRevision??0)<(accepted.eventRevision??0))return false
    const af=accepted.focus
    // focus 为空是合法空闲态（任务已完成/暂停），不是回滚；仅同任务同激活的焦点修订回退才是迟到响应。
    if(focus&&af&&af.task_id===focus.task_id&&af.activation_id===focus.activation_id&&(focus.revision||0)<(af.revision||0))return false
   }
  }
  const prior=latest(session,'forge/task-boundary')?.data
  const task=focus?.task_id?snapshot.todos.find(t=>t.id===focus.task_id&&t.status==='doing'&&t.owner===session.id&&t.activation_id===focus.activation_id):null
  // A binding snapshot has no active task until an explicit committed activation.
  if(!prior||prior.projectId!==snapshot.projectId||Number(focus?.revision||0)>prior.revision)appendTaskEvent(session,'forge/task-boundary',{
   projectId:snapshot.projectId,taskId:task?.id??null,activationId:task?.activation_id??null,
   revision:focus?.revision||0,text:task?.title||'',bound:true,bindingRevision:snapshot.bindingRevision??0,
  })
  const todos=snapshot.todos.map(t=>({content:`#${t.seq} ${t.title}${t.status==='doing'&&t.owner&&t.owner!==session.id?` [由 ${t.owner} 执行；接力用 handoff]`:''}${['paused','blocked','cancelled','skipped'].includes(t.status)?` [${t.status}]`:''}`,status:t.status==='done'?'completed':t.status==='doing'?'in_progress':'pending'}))
  const old=latest(session,'todo/write'),turn=latest(session,'turn/start')
  const forgeMirror={projectId:snapshot.projectId,bindingRevision:snapshot.bindingRevision??0,eventRevision:snapshot.eventRevision??0}
  const forgeTasks=snapshot.todos.map(t=>({id:t.id,seq:t.seq,status:t.status,revision:t.revision??0,criteria:t.criteria||''}))
  if(JSON.stringify(old?.data.todos)!==JSON.stringify(todos)||JSON.stringify(old?.data.forgeMirror)!==JSON.stringify(forgeMirror)||JSON.stringify(old?.data.forgeTasks)!==JSON.stringify(forgeTasks)||(turn?.seq??-1)>(old?.seq??-1))session.append('todo/write',{todos,forge:true,forgeMirror,forgeTasks})
  return true
 }
 async function sync(agent) {
  remember(agent);const id=agent.session.id;let result=snapshotOf(await call({method:'task.sync',sessionId:id}))
  if(disposed||live.get(id)!==agent)return snapshots.get(agent)||result
  // Recovery must not silently resume automation whose budget could not be checked.
  if(unavailable.has(id)&&result.run?.status==='running')result=snapshotOf(await call({method:'flow.tick',sessionId:id,input:{error:true}}))
  if(!mirror(agent,result)){const accepted=snapshots.get(agent);if(accepted)return accepted;throw new Error('收到过期的工程快照，请重新同步')}
  snapshots.set(agent,result)
  unavailable.delete(id);if(result.run?.status==='running')running.add(id);else {running.delete(id);clearTimer(id)}
  return result
 }
 function degrade(agent,error) {
  const id=agent.session.id;clearTimer(id)
  if(!unavailable.has(id))ctx.logger?.warn?.('[forge] 任务同步暂不可用，自动续跑已暂停：'+error.message)
  unavailable.add(id)
 }
 async function passManual(payload,next) {
  const automatic=m=>['forge-flowlock','goal-flow','goal-notice'].includes(m.source?.kind),messages=payload.messages||[]
  if(payload.signal?.aborted)return {kind:'reject'}
  if((running.has(payload.agent.session.id)||goalRunning.has(payload.agent.session.id)||messages.some(automatic))&&!messages.some(m=>m.source?.kind==='user'))return {kind:'reject'}
  const decision=await next();if(decision.kind!=='enter')return decision
  return {...decision,messages:decision.messages.filter(m=>!automatic(m))}
 }
 function watch(agent,run) {
  clearTimer(agent.session.id)
  if(run?.status!=='running')return
  const generation=run.generation
  const timer=setTimeout(async()=>{
   timers.delete(agent.session.id)
   try{const r=await call({method:'flow.tick',sessionId:agent.session.id,input:{generation}});if(r.budget)agent.cancel({kind:'user'})}catch(e){ctx.logger?.warn?.('[forge] budget: '+e.message)}
  },Math.max(1,run.started_at+run.max_ms-Date.now()))
  timer.unref?.();timers.set(agent.session.id,timer)
 }
 function watchGoal(agent,run){
  clearGoalTimer(agent.session.id)
  if(run?.status!=='running')return
  const raw=typeof run.budgets==='string'?JSON.parse(run.budgets):run.budgets||{}
  if(!raw.maxMinutes)return
  const delay=Math.max(1,Math.min(60000,Date.parse(run.started_at)+Number(raw.maxMinutes)*60000-Date.now()))
  const timer=setTimeout(async()=>{
   try{const r=await call({method:'goal.tick',sessionId:agent.session.id,input:{generation:run.generation}})
    if(r.budget){goalRunning.delete(agent.session.id);controlledStops.add(agent.session.id);agent.cancel({kind:'user'})}
    else if(r.run)watchGoal(agent,r.run)
   }catch(e){goalRunning.delete(agent.session.id);agent.cancel({kind:'user'});ctx.logger?.warn?.('[forge] goal budget: '+e.message)}
  },delay)
  timer.unref?.();goalTimers.set(agent.session.id,timer)
 }
 let polling=false,disposed=false
 async function refreshProject(projectId){
  await Promise.all([...live.values()].filter(a=>needsSync(a)&&(!projectId||!snapshots.get(a)?.projectId||snapshots.get(a)?.projectId===projectId||latest(a.session,'forge/task-boundary')?.data.projectId===projectId))
   .map(a=>sync(a).catch(e=>degrade(a,e))))
 }
 const pollTimer=setInterval(async()=>{if(polling||disposed||!live.size)return;polling=true;try{await refreshProject()}finally{polling=false}},3000)
 pollTimer.unref?.()
 ctx.effect(()=>()=>{disposed=true;clearInterval(pollTimer);for(const id of timers.keys())clearTimer(id);for(const id of goalTimers.keys())clearGoalTimer(id);chatInputs.clear();live.clear();unavailable.clear();running.clear();mounted.delete(owner)},'forge task lifecycle')
 ctx.on('agent/disposed',({agent})=>{if(agent?.session){chatInputs.delete(agent.session.id);clearTimer(agent.session.id);clearGoalTimer(agent.session.id);notifying.delete(agent.session.id);live.delete(agent.session.id);stepCounts.delete(agent.session.id);reminders.delete(agent.session.id);unavailable.delete(agent.session.id);running.delete(agent.session.id);goalRunning.delete(agent.session.id)}})
 async function bind(agent,projectId){if(!agent)return;remember(agent);const s=snapshotOf(await call({method:'task.bind',sessionId:agent.session.id,projectId}));if(mirror(agent,s))snapshots.set(agent,s);return s}
 // Binding follows real work: create/plan/task mutations always rebind, while
 // reading a project binds only when the session has no binding yet — casual
 // inspection of another project must not steal the current execution binding.
 // Read-path sync/bind failures never mask a successful GetProject result.
 async function bindAfterTool(agent,command,projectId,receiptStatus){
  if(!agent||!projectId||!['committed','completed'].includes(String(receiptStatus||'')))return
  if(['CreateProject','BindProject','UpdateTodos','TaskAction'].includes(command)){await bind(agent,projectId);await refreshProject(projectId);return}
  if(command!=='GetProject')return
  let current=null
  try{current=await sync(agent)}catch(_e){current=null}
  if(!current?.projectId||current.projectId===projectId){try{await bind(agent,projectId)}catch(_e){ctx.logger?.warn?.('[forge] 读取工程后绑定失败：'+(_e&&_e.message||_e))}}
 }
 ctx.on('session/event',(session,event)=>{
  if(event.type==='turn/end') {
   chatInputs.delete(session.id)
   stepCounts.delete(session.id)
   notifying.delete(session.id)
   manualTurns.delete(session.id)
   if(['aborted','error'].includes(event.data?.reason?.kind)){
    clearTimer(session.id);clearGoalTimer(session.id);goalRunning.delete(session.id)
    const input={aborted:event.data.reason.kind==='aborted',error:event.data.reason.kind==='error'}
    const controlled=controlledStops.delete(session.id)
    void Promise.all([controlled?null:call({method:'goal.tick',sessionId:session.id,input}),call({method:'flow.tick',sessionId:session.id,input})]).catch(e=>ctx.logger?.warn?.('[forge] stop: '+e.message))
   }
  }
  if(taskEvent(event).type==='forge/task-boundary')reminders.delete(session.id)
 })
 ctx.on('agent/pre-step',async(payload,next)=>{
  const agent=payload.agent;if(!agent?.session)return next()
  remember(agent)
  const messages=payload.messages||[],user=messages.some(m=>m.source?.kind==='user')
  const lastUser=messages.findLast(m=>m.source?.kind==='user')
  if(lastUser){
   const text=(lastUser.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')
   if(!lastUser.id)chatInputs.delete(agent.session.id)
   else if(chatInputs.get(agent.session.id)?.messageId!==lastUser.id){
    const directive=parseChatControl(text),record={messageId:lastUser.id,text,hasGoal:false,projectId:snapshots.get(agent)?.projectId||null,directive}
    if(directive?.action==='start')record.hint='用户要求开启心流。若尚无目标，先绑定本轮工程、建任务并 forge_goal propose，再在本轮 forge_goal start；目标、范围和验收条件须来自用户需求。默认累计预算 20 分钟 / 40 步 / 200 次续跑；以工具回执为准。'
    chatInputs.set(agent.session.id,record)
   }
  }
  const chatRecord=chatInputs.get(agent.session.id)
  if(chatRecord)chatRecord.stepKey=`${payload.turn}:${payload.step}`
  if(!needsSync(agent))return withChatHint(await next(),chatRecord)
  if(user){notifying.delete(agent.session.id);manualTurns.add(agent.session.id);controlledStops.delete(agent.session.id)}
  else if(messages.some(m=>m.source?.kind==='goal-notice'))notifying.add(agent.session.id)
  let s;try{s=await sync(agent)}catch(error){degrade(agent,error);return passManual(payload,next)}
  if(s.projectId) {
   let chatHandled=false
   if(user&&chatRecord){
    try{
     const state=await call({method:'goal.control',action:'status',sessionId:agent.session.id,projectId:s.projectId})
     if(chatInputs.get(agent.session.id)!==chatRecord||payload.signal?.aborted)return {kind:'reject'}
     chatRecord.hasGoal=!!state.goal;chatRecord.projectId??=s.projectId
     chatRecord.directive=parseChatControl(chatRecord.text,{hasGoal:chatRecord.hasGoal})
     const action=chatRecord.directive?.action
     if(action==='status'){chatHandled=true;chatRecord.hint=`当前目标 ${state.goal?.title||'尚无'}；运行 ${state.run?.status||'尚未启动'}。可用 forge_goal status/snapshot 查看细节。`}
     else if(action&&state.goal&&(action==='start'||state.run)){
      const result=await chatGoalControl(agent,action,{},s.projectId)
      chatHandled=true;chatRecord.hint=`${action} 已确认；目标「${result.goal.title}」，运行 ${result.run.status}，预算 ${JSON.stringify(result.run.budgets)}。按 snapshot 核对当前项；暂停/停止时只回答用户，不恢复工程。`
     }
    }catch(error){chatRecord.hint=`本次聊天控制未成功：${error.message}。不得宣称已启动；先核对 forge_goal status。`;ctx.logger?.warn?.('[forge] chat control: '+error.message)}
   }
   if(user&&!chatHandled){
    // GF05：插话处理需要真实用户消息 id 与原文；拿不到 id 时引擎会标注 synthetic，不冒充“用户决定”。
    const lastUser=messages.findLast(m=>m.source?.kind==='user')
    const userText=(lastUser?.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')||''
    // A small immediate dialogue context resolves references without sending the
    // engineering history or tool output to the auxiliary judgment model.
    const dialogueContext=agent.session.snapshotEvents().filter(e=>e.type==='assistant/message').slice(-1).map(e=>({role:'assistant',text:(e.data?.message?.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n').slice(-1600),truncated:true}));
    try{const g=await call({method:'goal.tick',sessionId:agent.session.id,input:{user:true,messageId:lastUser?.id,text:userText,dialogueContext}});
     if(g.decision==='paused'||g.decision==='stopped')goalRunning.delete(agent.session.id)}
    catch(_e){ctx.logger?.warn?.('[forge] goal user 通知失败：'+(_e&&_e.message||_e))}
   }
   if(!user&&!notifying.has(agent.session.id)){
    try{const queued=messages.find(m=>m.source?.kind==='goal-flow');const g=await call({method:'goal.tick',sessionId:agent.session.id,input:{step:`${payload.turn}:${payload.step}`,generation:queued?.source.generation,aborted:payload.signal?.aborted}})
     if(g.budget||g.decision==='stopped'||g.decision==='stale'){clearGoalTimer(agent.session.id);goalRunning.delete(agent.session.id);return {kind:'reject'}}
     if(g.decision==='none'&&!manualTurns.has(agent.session.id)){
      const state=await call({method:'goal.status',sessionId:agent.session.id});if(state.run&&!['completed','stopped'].includes(state.run.status))return {kind:'reject'}
     }
     if(g.run)watchGoal(agent,g.run)
    }catch(e){ctx.logger?.warn?.('[forge] goal step: '+e.message);if(goalRunning.has(agent.session.id)||messages.some(m=>m.source?.kind==='goal-flow'))return {kind:'reject'}}
   }
   let result;try{result=snapshotOf(await call({method:'flow.tick',sessionId:agent.session.id,input:{user,step:`${payload.turn}:${payload.step}`,aborted:payload.signal?.aborted}}))}catch(error){degrade(agent,error);return passManual(payload,next)}
   if(payload.signal?.aborted)return {kind:'reject'}
   if(mirror(agent,result)){snapshots.set(agent,result);s=result}else s=snapshots.get(agent)||s
   if(result.budget){clearTimer(agent.session.id);await bridge.contextRuntime?.interrupt(agent,'原心流运行预算已耗尽。');return {kind:'reject'}}
   watch(agent,result.run)
   // A canceled generation's queued message cannot start a fresh model request.
   const stale=new Set(messages.filter(m=>m.source?.kind==='forge-flowlock'&&(result.run?.status!=='running'||m.source.generation!==result.run.generation)).map(m=>m.id))
   if(messages.some(m=>['goal-flow','goal-notice'].includes(m.source?.kind))){
    try{const gs=await call({method:'goal.status',sessionId:agent.session.id});
     for(const m of messages)if(['goal-flow','goal-notice'].includes(m.source?.kind)&&(!gs.run||m.source.runId!==gs.run.id||m.source.generation!==gs.run.generation||(m.source.kind==='goal-flow'&&gs.run.status!=='running')))stale.add(m.id)
    }catch(_e){for(const m of messages)if(['goal-flow','goal-notice'].includes(m.source?.kind))stale.add(m.id);ctx.logger?.warn?.('[forge] goal.status 不可用：'+(_e&&_e.message||_e))}
   }
   const decision=await next()
   if(decision.kind!=='enter'||payload.signal?.aborted)return decision
   const clean=decision.messages.filter(m=>!stale.has(m.id))
   if(stale.size&&!clean.some(m=>m.source?.kind==='user')&&messages.every(m=>stale.has(m.id)))return {kind:'reject'}
   const context=reconcileTaskContext(agent.session,s)
   if(context)clean.push(context)
   const current=s.todos.find(t=>t.status==='doing'&&t.owner===agent.session.id)
   const count=(stepCounts.get(agent.session.id)||0)+1;stepCounts.set(agent.session.id,count)
   if(current&&count>=8&&!reminders.has(agent.session.id)){
    reminders.set(agent.session.id,true)
    clean.push({id:randomUUID(),role:'user',source:{kind:'forge-progress'},content:[{type:'text',text:`仍在任务 #${current.seq}「${current.title}」。请核对是否应提交 progress、complete/advance 或 block；不要把后续任务都记在本项。`}]})
   }
   return withChatHint({...decision,messages:clean},chatRecord)
  }
  const decision=await next()
  if(decision.kind==='enter'&&!payload.signal?.aborted){const context=reconcileTaskContext(agent.session,s);if(context)return withChatHint({...decision,messages:[...decision.messages,context]},chatRecord)}
  return withChatHint(decision,chatRecord)
 })
 ctx.on('agent/turn-stopping',async({agent,signal})=>{
 if(!agent?.session||signal?.aborted)return
 if(notifying.has(agent.session.id)){notifying.delete(agent.session.id);return}
 if(await bridge.contextRuntime?.stopping(agent,signal))return
 if(!needsSync(agent))return
 const session=agent.session
 try {
  const s=await sync(agent);if(!s.projectId)return
  const last=latest(session,'assistant/message');if(!last)return
  // GF02：goal run 在途 → 唯一调度器决策；收尾幂等与预算硬门槛在引擎侧裁决。
  let g=null
  try{g=await call({method:'goal.tick',sessionId:session.id,input:{stopping:String(last.seq),latestUserSeq:last.seq}})}
  catch(e){ctx.logger?.warn?.('[forge] goal.tick 不可用，回落 legacy：'+e.message)}
  if(g&&g.decision!=='none'){
   if(signal?.aborted)return
   if(g.decision==='continue'&&agent.inbox.nextStep.length===0&&agent.inbox.nextTurn.length===0){goalRunning.add(session.id);watchGoal(agent,g.run);agent.inject(goalHeartbeat(g.text,g.run))}
   // GF06：有界纠偏第 3 档且没有可独立推进的任务 → 引擎给出阻塞报告，这里只投递一次。
   else if(g.report&&agent.inbox.nextStep.length===0&&agent.inbox.nextTurn.length===0){goalRunning.delete(session.id);clearGoalTimer(session.id);agent.inject(goalNotice(g.report.text,g.run))}
   else goalRunning.delete(session.id)
   return
  }
  const gs=await call({method:'goal.status',sessionId:session.id})
  if(gs.run&&!['completed','stopped'].includes(gs.run.status))return
  const r=await call({method:'flow.tick',sessionId:session.id,input:{stopping:String(last.seq),generation:s.run?.generation}})
  if(signal?.aborted)return
  if(r.continue&&agent.inbox.nextStep.length===0&&agent.inbox.nextTurn.length===0)agent.inject(heartbeat(r.text,r.run))
 } catch(error){degrade(agent,error)}
 })
 // Keep official todo_write and its projection. Bound sessions treat it as a
 // compatibility proposal; task mutations must carry persistent IDs/evidence.
 ctx.on('tools/execute',async(exec,next)=>{
  if(notifying.has(exec.agent?.session?.id)){
   const read=(exec.name==='forge_goal'&&['status','snapshot','acceptance','stall'].includes(exec.arguments?.action))||
    (exec.name==='project_forge'&&['GetProject','ReadCode','Outline','FindSymbol','Trace','ListProjects','SearchHistory','GetNodeDiff'].includes(exec.arguments?.command))
   if(!read)throw new Error('当前只转述目标心流通知，工程仍暂停；请等待用户继续。')
  }
  await bridge.contextRuntime?.guardTool(exec)
  if(exec.name!=='todo_write'||!exec.agent)return next()
  const session=exec.agent.session,s=await sync(exec.agent),todos=exec.arguments.todos
  if(s.projectId) {
   const current=latest(session,'todo/write')?.data.todos||[]
   if(todos.length!==current.length||todos.some((t,i)=>t.content!==current[i].content))throw new Error('工程 Todo 不可整表覆盖或按标题猜关联。请保留镜像条目；新增/重排用 project_forge UpdateTodos / TaskAction。')
   const changes=todos.map((t,i)=>({from:current[i].status,to:t.status,task:s.todos[i]})).filter(c=>c.from!==c.to)
   const done=changes.filter(c=>c.from==='in_progress'&&c.to==='completed'),start=changes.filter(c=>c.from==='pending'&&c.to==='in_progress'&&c.task.status==='pending')
   if(done.length>1||start.length>1||done.length+start.length!==changes.length)throw new Error('非法任务转换：未开始项不能直接完成（清单里 pending→completed 是跳步）。正确姿势：先把该项设为 in_progress，做完后用 todo_checkpoint 记录依据，再标 completed；一次只翻一项。若确实要放弃整张清单，用 todo_checkpoint(action:"reset") 并说明原因。'+ROUTING_HINT)
   if(changes.length) {
    const completion=done[0]?.task,nextTask=start[0]?.task,task=completion||nextTask
    const checkpoint=latest(session,'forge/todo-evidence')?.data
    if(completion&&(checkpoint?.taskId!==completion.id||checkpoint?.revision!==completion.revision))throw new Error('请先 todo_checkpoint 提交当前工程任务的完成依据，或用 TaskAction complete/advance + evidence。')
    const args={command:'TaskAction',projectId:s.projectId,sessionId:session.id,taskId:task.id,expectedRevision:task.revision,
     taskAction:completion?(nextTask?'advance':'complete'):'start',...(completion?{evidence:checkpoint.evidence}:{}),...(completion&&nextTask?{nextTaskId:nextTask.id,nextExpectedRevision:nextTask.revision}:{})}
    const result=await (await getClient()).request({args},{signal:exec.signal})
    if(!['committed','completed'].includes(result.receipt?.status))throw new Error('任务操作尚未确认提交，请先核对回执')
    await refreshProject(s.projectId)
   }
   const mirrored=latest(session,'todo/write').data.todos
   return {isError:false,value:{todos:mirrored,counts:counts(mirrored)},content:[]}
  }
  const old=latest(session,'todo/write')?.data.todos||[]
  if(todos.filter(t=>t.status==='in_progress').length>1)throw new Error('当前会话只允许一个进行中任务')
  for(const t of old)if(!todos.some(n=>n.content===t.content))throw new Error('todo_write 不能抹掉已有任务（本清单是完整替换语义，缺项即视为删除）。若只是收尾补写状态，请保留全部条目、只改 status；确实要结束整张清单，用 todo_checkpoint(action:"reset") 并填写原因——历史会保留；要新增或重排长期计划，请用 project_forge 建/绑施工图工程。'+ROUTING_HINT)
  const evidence=latest(session,'forge/todo-evidence')
  for(const t of todos) {
   const previous=old.find(p=>p.content===t.content)
   if(t.status==='completed'&&previous?.status!=='completed') {
    if(previous?.status!=='in_progress')throw new Error('未开始任务不能直接完成：这一项还停在「未开始」，跳过 in_progress 直接标 completed 会让面板显示与实际不符。出路：先用一次 todo_write 把该项置为 in_progress（若其实早已做完，就当作补记，紧接着调 todo_checkpoint 提交依据），再标 completed。'+ROUTING_HINT)
    if(evidence?.data.content!==t.content||evidence.seq<(latest(session,'todo/write')?.seq??0))throw new Error('完成前请用 todo_checkpoint 提交本项结论和检查依据：调 todo_checkpoint({action:"checkpoint", summary:"做成了什么", check:"怎么核对的", reference:"工作区内的产物文件相对路径"})——三者都必填，reference 必须是当前工作区内真实存在的文件（不是目录、不是绝对路径）。')
    if(evidence.data.hash&&fileHash(evidence.data.reference)!==evidence.data.hash)throw new Error('临时 Todo 的产物已变化，请重新检查并提交 todo_checkpoint')
   }
   if(previous?.status==='completed'&&t.status!=='completed')throw new Error('不能静默重置已完成任务，请显式建立后续任务')
  }
  return next()
 })
 ctx.tools.register(defineTool({name:'todo_checkpoint',description:'未绑定施工图的临时 Todo 完成依据。默认完成一项要走两步：先 todo_checkpoint 记录依据，再 todo_write 标 completed；未记录依据就标 completed 会被拦下。省事做法：checkpoint 时加 complete:true，一次调用即「记录依据 + 把本项标完成 + 把下一项置为进行中」，一步顶两步。reset 用于结束整张清单（必须填 summary 说明原因，历史保留）。工程任务请用 project_forge TaskAction。',
  parameters:{action:{type:'string',enum:['checkpoint','reset'],description:'checkpoint=记录依据（默认，配合 complete 可一步完成）；reset=结束旧清单并保留退出原因'},summary:{type:'string',description:'做成了什么（结论）；reset 时写结束原因'},check:{type:'string',description:'怎么核对的：跑了什么命令/看了什么证据、结果如何'},reference:{type:'string',description:'本工作区内真实存在的产物文件相对路径（不是目录、不是绝对路径）；也可以是 http(s) 网址'},complete:{type:'boolean',description:'true=记录依据后直接完成当前项并开始下一项（省掉一次 todo_write）；默认 false 只记录'}},
  output:{schema:{type:'string'},render(_a,v){return[{type:'text',text:v}]}},isConcurrencySafe(){return false},
  async execute(a,exec){if(!exec.agent)throw new Error('需要会话');const session=exec.agent.session,s=await sync(exec.agent);
   if(s.projectId){
    if(a.action==='reset')throw new Error('工程不能清空历史；用 TaskAction cancel/replan')
    const task=s.todos.find(t=>t.status==='doing'&&t.owner===session.id);if(!task)throw new Error('当前会话没有进行中的工程任务：先用 TaskAction start 认领一项（或直接写它，首次写入会自动认领）')
    if(!a.summary.trim()||!a.check?.trim()||!a.reference?.trim())throw new Error('三个字段都必填：summary（做成了什么）、check（怎么核对的）、reference（工作区内产物文件相对路径）。缺哪个补哪个。')
    const ref=/^https?:\/\//.test(a.reference)?{type:'source',url:a.reference,finding:a.summary}:{type:'file',path:a.reference}
    appendTaskEvent(session,'forge/todo-evidence',{taskId:task.id,revision:task.revision,evidence:{summary:a.summary,check:a.check,result:'passed',refs:[ref]}})
    return '完成依据声明已记录；下一次 todo_write 完成/交接时由工程后端核验引用。'
   }
   if(a.action==='reset'){if(!a.summary.trim())throw new Error('结束旧清单必须填写 summary 说明原因（退出原因会与清单一并保留）');appendTaskEvent(session,'forge/todo-reset',{reason:a.summary,todos:latest(session,'todo/write')?.data.todos||[]});session.append('todo/write',{todos:[]});return '旧清单已结束，历史与退出原因保留；可建立新清单。'}
   const list=latest(session,'todo/write')?.data.todos||[]
   const current=list.find(t=>t.status==='in_progress')
   if(!current)throw new Error(list.length?`当前没有进行中任务：先用 todo_write 把要做的那一项置为 in_progress（本清单 ${list.length} 项，全部尚未开始）`:'还没有清单：先用 todo_write 建立清单，把第一项置为 in_progress')
   if(!a.summary.trim()||!a.check?.trim()||!a.reference?.trim())throw new Error('三个字段都必填：summary（做成了什么）、check（怎么核对的）、reference（本工作区内产物文件的相对路径）。缺哪个补哪个；reference 不能是目录或绝对路径。')
   let reference=a.reference,hash=null;if(!/^https?:\/\//.test(reference)){const root=session.header.cwd;if(!root)throw new Error('会话未关联工作目录，无法解析相对路径；请改用 http(s) 网址作 reference');reference=security.assertInside(path.resolve(root,reference),[root]);if(!fs.statSync(reference).isFile())throw new Error('产物不是文件：reference 要指向工作区内的一个真实文件（目录不行）；相对路径按会话工作目录解析');hash=fileHash(reference);}
   const evidence={content:current.content,summary:a.summary,check:a.check,reference,hash,verification:'reference-checked; conclusion-declared'}
   // #19 治本档：依据与状态推进写进同一条事件、同一次调用——省掉紧接着的那次 todo_write。
   if(a.complete===true){
    const next=list.find(t=>t.status==='pending')
    const promoted=list.map(t=>t.content===current.content?{...t,status:'completed'}:t.content===next?.content?{...t,status:'in_progress'}:t)
    session.append('todo/write',{todos:promoted,forge:true,forgeEvent:{type:'forge/todo-evidence',data:evidence}})
    const tail=next?`下一项已置为进行中：${next.content}`:'清单已全部完成'
    return `依据已记录并完成本项：${current.content}。${tail}`
   }
   appendTaskEvent(session,'forge/todo-evidence',evidence)
   return '依据已记录，可完成当前项并将下一项设为 in_progress（或在本次调用加 complete:true 一步完成）。'
  }}))
 async function controlGoal(agent,action,input,projectId,source){
  const r=await call({method:'goal.control',sessionId:agent.session.id,projectId,action,input,source})
  if(['pause','stop','finish'].includes(action)&&r.run?.status!=='running'){
   clearGoalTimer(agent.session.id);goalRunning.delete(agent.session.id)
   if(agent.status!=='idle'&&source?.channel!=='goal-chat'){controlledStops.add(agent.session.id);agent.cancel({kind:'user'},{keepInbox:true})}
  }
  if(['start','resume'].includes(action)){
   if(source?.channel==='goal-chat'){
    const step=chatInputs.get(agent.session.id)?.stepKey
    if(step){await call({method:'goal.tick',sessionId:agent.session.id,input:{generation:r.run.generation,step}});r.run=(await call({method:'goal.control',action:'status',sessionId:agent.session.id,projectId})).run}
   }
   manualTurns.delete(agent.session.id)
   controlledStops.delete(agent.session.id)
   notifying.delete(agent.session.id);if(r.run?.status==='running')goalRunning.add(agent.session.id);else goalRunning.delete(agent.session.id);watchGoal(agent,r.run)
   if(!r.replayed&&source?.channel!=='goal-chat'&&agent.status==='idle'&&!agent.inbox.nextStep.length&&!agent.inbox.nextTurn.length)
    agent.followup(goalHeartbeat('用户已启动目标心流。先 forge_goal snapshot 核对当前项与验收条件，再在既有范围内推进。',r.run))
  }
  return r
 }
 async function chatGoalControl(agent,action,input={},projectId){
  const record=chatInputs.get(agent.session.id)
  if(!record||record.directive?.action!==action)throw new Error('当前真实用户消息未授权此动作；请在聊天说“开启心流”或“继续心流”，不需要面板启动')
  if(record.projectId&&record.projectId!==projectId)throw new Error('聊天指令对应的工程已变化；请在当前工程发一条新的心流指令')
  const state=await call({method:'goal.control',action:'status',sessionId:agent.session.id,projectId})
  if(chatInputs.get(agent.session.id)!==record||disposed)throw new Error('用户消息已变化；旧聊天指令失效')
  record.projectId=projectId
  const request={...input,expectedGoalId:state.goal?.id,expectedRevision:input.expectedRevision??state.goal?.revision,expectedGeneration:input.expectedGeneration??state.run?.generation}
  return controlGoal(agent,action,request,projectId,{kind:'user',channel:'goal-chat',messageId:record.messageId,text:record.text,hasGoal:record.hasGoal})
 }
 const bridge={bind,bindAfterTool,sync,refreshProject,needsSync,goalControl:controlGoal,chatGoalControl,async panel(msg) {
  const p=msg.params||{}
  if(msg.action==='goal.status')return call({method:'goal.control',action:'status',projectId:p.projectId,sessionId:p.sessionId})
  if(['goal.control','goal.acceptance','goal.review'].includes(msg.action)){
   const agent=live.get(p.sessionId);if(!agent)throw new Error('会话未在本机活动，请先在聊天中读取工程')
   const s=await sync(agent);if(s.projectId!==p.projectId)throw new Error('会话绑定工程已变化，请刷新')
   const source={kind:'user',messageId:randomUUID(),channel:'goal-panel'}
   if(msg.action==='goal.control')return controlGoal(agent,p.action,p.input||{},p.projectId,source)
   return call({method:msg.action,sessionId:p.sessionId,input:p.input||{},source})
  }
  if(msg.action==='context.sessions')return {sessions:[...live.values()].map(a=>({sessionId:a.session.id,projectId:snapshots.get(a)?.projectId||null,agentStatus:a.status||'unknown'}))}
  if(isContextAction(msg.action)){const agent=live.get(p.sessionId);if(agent&&needsSync(agent)&&['context.status','context.candidates'].includes(msg.action))await sync(agent).catch(e=>degrade(agent,e));return handleContextPanel(live,msg)}
  if(msg.action==='flow.status'){const result=await call(msg);return {...result,sessions:result.sessions.map(s=>({...s,live:!!live.get(s.sessionId),agentStatus:live.get(s.sessionId)?.status||'offline'})),availableSessions:[...live.values()].map(a=>({sessionId:a.session.id,projectId:snapshots.get(a)?.projectId||null,agentStatus:a.status||'unknown'}))}}
  if(['tasks.action','todos.update','workitems.import'].includes(msg.action)){const result=await call(msg);if(['committed','completed'].includes(result.receipt?.status))await refreshProject(p.projectId);return result}
  if(msg.action!=='flow.control')return call(msg)
  const agent=live.get(p.sessionId);if(!agent)throw new Error('该会话未在本次 DSH 运行中活动；先在对应聊天读取工程，再启动心流')
  if(!['start','resume','pause','stop'].includes(p.action))throw new Error('未知心流动作')
  const r=await call({method:'flow.control',sessionId:p.sessionId,projectId:p.projectId,action:p.action,options:p.options})
  if(['pause','stop'].includes(p.action)){clearTimer(p.sessionId);agent.cancel({kind:'user'},{keepInbox:true})}
  else {watch(agent,r.run);if(agent.status==='idle'&&agent.inbox.nextTurn.length===0&&agent.inbox.nextStep.length===0)agent.followup(heartbeat(`在工程 ${p.projectId} 的既有范围内继续施工。先 GetProject 核对，逐项 start → 执行 → evidence → complete/advance；受阻则暂停。`,r.run))}
  return r
 }}
 mounted.set(owner,bridge)
 return bridge
}
