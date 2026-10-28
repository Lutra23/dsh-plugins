'use strict';
// GF11（§3 单一主记录 + §11 内嵌面板/快照/短协议）：只读 goal.snapshot 组装层。
// 口径：
//  * 数据全部从既有层读口组装（GoalStore/GoalScheduler/GoalEvidence/GoalAcceptance/GoalStall/GoalRelay/GoalFocus），
//    不另建表、不写库；面板“施工图目标区域”与原生 Todo 同源，都是主记录的投影。
//  * 每个分块自报 avail 状态：known（有当前数据）/absent（无记录）/unavailable（缺依赖或读不到）。
//    读不到不伪装，由调用方按 unavailable 降级展示。
//  * 观察（observe）与自主（autonomous）模式可区分：快照同时给出 run.mode 与 decisionPolicy.mode。
//  * 无新桌面图标：本模块是引擎只读方法，由 task-bridge 的 panel 数据面消费，不注册新工具。
const availOf=(fragment,missing=[])=>fragment?(missing.length?{state:'known',missing}:`known`):'absent';
// declared 缺验证，用块级 try/catch 兜住（GF08 同款：可选依赖不当硬依赖）。
const safe=(fn,fb=null)=>{try{return fn();}catch(e){return {unavailable:true,reason:String(e&&e.message||e),fallback:fb};}};
class GoalSnapshot {
 constructor({goalStore,scheduler,evidence=null,acceptance=null,stall=null,relay=null,focus=null,policy=null}={}){
  if(!goalStore||!scheduler)throw Object.assign(new Error('GoalSnapshot 需要 goalStore 与 scheduler'),{code:'SNAPSHOT_CONFIG'});
  this.goals=goalStore;this.scheduler=scheduler;this.evidence=evidence;this.acceptance=acceptance;
  this.stall=stall;this.relay=relay;this.focus=focus;this.policy=policy;
 }
 // §11：goal/run/task/criteria/nextAction/checkpoint + 各自修订与 known/absent/unavailable。
 assemble({projectId=null,sessionId=null,run=null,root=null}={}){
  const missing=[];
  const goalId=run?.goal_id??null;
  const goal=goalId?safe(()=>this.goals.decorate(this.goals.goalRow(goalId))):null;
  if(!goalId)missing.push('goal：该会话没有目标运行');
  else if(goal&&goal.unavailable)missing.push('goal：目标主记录读不到（'+goal.reason+'）');
  const todos=safe(()=>this.goals.tasks?this.goals.tasks.snapshot?.(projectId,sessionId)?.todos??null:null);
  const todosAv=Array.isArray(todos)?{state:todos.length?'known':'absent',items:todos.map(t=>({id:t.id,seq:t.seq,status:t.status,owner:t.owner??null,revision:t.revision??null}))}
   :(todos&&todos.unavailable?{unavailable:true,reason:todos.reason}:null);
  const taskId=todosAv&&todosAv.state==='known'&&run&&sessionId!=null?safe(()=>{const list=todosAv.items;
   const cur=list.find(t=>t.status==='doing'&&String(t.owner)===String(sessionId));return cur?cur.id:null;},null):null;
  const criteria=safe(()=>goal&&!goal.unavailable?{revision:goal.revision,
   items:(goal.criteria||[]).map(c=>({id:c.id,requirement:c.requirement,category:c.category,status:c.status,position:c.position})),links:goal.links||[]}:null);
  const acceptance=goalId&&this.acceptance?safe(()=>this.acceptance.checkGoalAccepted(goalId,{root})):null;
  const progress=run&&this.evidence?safe(()=>this.evidence.progress(run.id)):null;
  const stallState=goalId&&this.stall?safe(()=>({task:taskId?this.stall.state(goalId,{taskId}):null,goal:this.stall.state(goalId,{taskId:null})})):null;
  const budget=run?safe(()=>{const p=v=>{try{return typeof v==='string'?JSON.parse(v):v??{};}catch{return {};}};
   const allowed=p(run.budgets),consumed=p(run.consumed);
   return {allowed,consumed,left:typeof allowed.maxCalls==='number'?Number(allowed.maxCalls)-Number(consumed.calls||0):null};}):null;
  const boundary=sessionId!=null&&this.focus?safe(()=>this.focus.boundary(sessionId,{})):null;
  const nextAction=run?safe(()=>({decision:run.status,phase:run.phase,
   awaiting:run.status==='waiting'?{reason:run.pause_reason||'',wakeAt:run.next_wake_at??null}:null,
   paused:run.status==='paused'?{origin:run.pause_origin||'',reason:run.pause_reason||''}:null})):null;
  const checkpoint=run?safe(()=>{try{const cp=this.goals.db.prepare('SELECT * FROM pf_goal_checkpoints WHERE run_id=? ORDER BY seq DESC LIMIT 1').get(run.id);
   return cp||null;}catch(e){if(/no such (table|column)/i.test(String(e&&e.message||'')))return null;throw e;}}):null;
  const blocks={goal:goal&&!goal.unavailable?{state:'known',revision:goal.revision,status:goal.status,title:goal.title,
    objective:goal.objective,planRevision:goal.planRevision??null,runs:(goal.runs||[]).length}:availOf(null),
   run:run?{state:'known',id:run.id,revision:run.goal_revision,mode:run.mode,status:run.status,phase:run.phase,
    generation:run.generation??null,executor:run.executor_session_id??null,decisionMode:this.policy?.mode||'observe'}:availOf(null),
   task:todosAv&&!todosAv.unavailable?{state:todosAv.state,current:todosAv.state==='known'?taskId??null:null,items:todosAv.items}:availOf(null),
   criteria:criteria&&!criteria.unavailable?{state:'known',...criteria}:availOf(null),
   acceptance:acceptance&&!acceptance.unavailable?{state:'known',...acceptance}:availOf(null),
   progress:progress&&!progress.unavailable?{state:'known',...progress}:availOf(null),
   stall:stallState&&!stallState.unavailable?{state:'known',...stallState}:availOf(null),
   budget:budget&&!budget.unavailable?{state:'known',...budget}:availOf(null),
   boundary:boundary&&!boundary.unavailable?{state:'known',...boundary}:availOf(null),
   nextAction:nextAction&&!nextAction.unavailable?{state:'known',...nextAction}:availOf(null),
   checkpoint:(!checkpoint||checkpoint.unavailable)?(checkpoint&&checkpoint.unavailable?{unavailable:true,reason:checkpoint.reason}:{state:'absent',data:null}):{state:'known',data:checkpoint}};
  for(const [k,v] of Object.entries(blocks))if(v&&typeof v==='object'&&v.unavailable===true)missing.push(`${k}：读不到（${v.reason}）`);
  for(const [k,v] of Object.entries(blocks))if(typeof v==='string')missing.push(`${k}：无记录`);
  return {goalId,projectId,runId:run?.id??null,blocks,missing,
   note:'短协议：核对目标/当前项 → 执行 → 提交结果与引用 → 缺口补齐。状态由运行时提供，不要求每轮重读手册（§11）。'};
 }
}
module.exports={GoalSnapshot};
