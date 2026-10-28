'use strict';
// GF09（§4/§5.2/§10.2 + GA21/GA22）：目标接力与重启恢复。
// ── 铁律 ──────────────────────────────────────────────────────────────
//  * 接力是一次明确操作：必须有带 messageId 的真实用户来源，不能由绑定、查看或模型输出触发。
//  * 一个受控事务里转移运行执行权、任务与记忆焦点，保留目标/计划/进展/预算/重试计数，并废止旧代际。
//  * 仅绑定不续跑：绑定/查看工程既不启动运行，也不隐式继承自动执行权。
//  * 重启恢复默认只到 paused/reconciling：先核对在途回执与执行权；结果不确定的写操作绝不重放。
//  * 自动恢复需要显式启用（RunAuthorization.allowRestartRecovery），且原执行环境、授权、预算都还有效。
const fail=(message,code='RELAY_POLICY')=>{throw Object.assign(new Error(message),{code});};
const OP=require('./operations.cjs');
const parse=(v,fb)=>{try{return typeof v==='string'?JSON.parse(v):v??fb;}catch{return fb;}};
const RESUME_BLOCKERS={terminal:'目标运行已结束',ownership:'执行权已属于其他会话',budget:'预算已耗尽'};
class GoalRelay {
 constructor({goalStore,tasks=null,focus=null,uncertainWrites=null}={}){
  if(!goalStore||!goalStore.db)fail('GoalRelay 需要已构造的 GoalStore','RELAY_CONFIG');
  this.goals=goalStore;this.db=goalStore.db;this.tasks=tasks;this.focus=focus;
  this.uncertainWrites=typeof uncertainWrites==='function'?uncertainWrites:()=>[];
  this.db.exec(`CREATE TABLE IF NOT EXISTS pf_goal_relays(
    id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,run_id TEXT NOT NULL,from_session TEXT NOT NULL DEFAULT '',
    to_session TEXT NOT NULL DEFAULT '',generation_before TEXT NOT NULL DEFAULT '',generation_after TEXT NOT NULL DEFAULT '',
    task_id INTEGER,scope TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL DEFAULT '',source_refs TEXT NOT NULL DEFAULT '[]',
    by TEXT NOT NULL DEFAULT '',task_transfer TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);`);
 }
 authorization(run){
  return this.db.prepare('SELECT * FROM pf_goal_authorizations WHERE id=?').get(String(run?.authorization_id||''))||null;
 }
 // 在途不确定写操作：收到 unknown / needs-reconciliation 时先核对，不自动重发（§5.2）。
 uncertain(){
  try{const rows=this.uncertainWrites()||[];
   if(rows.length)return rows;
   return this.db.prepare("SELECT id,status FROM pf_operations WHERE status IN ('unknown','needs-reconciliation') LIMIT 20").all();
  }catch{return [];}
 }
 // ── 接力（§10.2 受控事务）─────────────────────────────────────────────
 relay(run,{toSessionId=null,messageId=null,by='',reason='',taskId=null}={}){
  if(!run)fail('接力需要目标运行');
  if(!String(toSessionId||'').trim())fail('接力必须指明接收会话');
  if(String(toSessionId)===String(run.executor_session_id))fail('接收会话已经是当前执行会话：不需要接力');
  if(!['running','waiting','paused'].includes(String(run.status)))fail(`运行状态 ${run.status} 不能接力`);
  const auth=this.authorization(run);
  if(!auth)fail('接力缺少授权记录');
  const source=parse(auth.source,{});
  if(source.kind!=='user')fail('接力必须来自真实用户来源：绑定、查看或模型输出都不能触发接力');
  if(!messageId&&!source.messageId)fail('接力必须指明是哪一次用户要求（messageId）：不能凭语气推断');
  const uncertain=this.uncertain();
  if(uncertain.length)fail(`有 ${uncertain.length} 笔在途写操作结果不确定：先核对回执再接力`);
  const other=this.db.prepare("SELECT id FROM pf_goal_runs WHERE executor_session_id=? AND status IN ('running','waiting') AND id!=?")
   .get(String(toSessionId),run.id);
  if(other)fail('接收会话已有在途目标运行：不并行接管');
  // 保留：目标/计划/进展/预算/重试计数一律不动，只换执行权与代际。
  const genBefore=String(run.generation||'');
  const genAfter=`gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
  const t=new Date().toISOString(),id=`relay-${Math.random().toString(36).slice(2,12)}`;
  const task=taskId??this.currentTaskId(run);
  const before=this.db.prepare('SELECT * FROM pf_goal_runs WHERE id=?').get(run.id);
  OP.dbWrite();
  this.db.prepare("UPDATE pf_goal_runs SET executor_session_id=?,generation=?,updated_at=? WHERE id=?")
   .run(String(toSessionId),genAfter,t,run.id);
  const focus=this.transferFocus({run,taskId:task,from:before?.executor_session_id||'',to:String(toSessionId),reason});
  this.db.prepare(`INSERT INTO pf_goal_relays(id,goal_id,run_id,from_session,to_session,generation_before,generation_after,
   task_id,scope,reason,source_refs,by,task_transfer,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
   .run(id,run.goal_id,run.id,String(before?.executor_session_id||''),String(toSessionId),genBefore,genAfter,task,
    'execution+focus',String(reason||''),JSON.stringify([messageId||source.messageId]),String(by||''),
    task!=null?'pending':'not-needed',t);
  return {relayId:id,goalId:run.goal_id,runId:run.id,from:before?.executor_session_id||'',to:String(toSessionId),
   generationBefore:genBefore,generationAfter:genAfter,taskId:task,focus,
   taskTransfer:{required:task!=null,taskId:task,toSessionId:String(toSessionId),via:'TaskAction handoff',
    note:task!=null?'任务交接走既有 handoff 通路，结果记回台账（不重新认领、不改任务修订）':'接力时没有在途任务'},
   preserved:{budgets:parse(before?.budgets,{}),consumed:parse(before?.consumed,{}),status:before?.status,phase:before?.phase},
   note:'旧代际的动作会被 read-set/代际检查判为迟到；目标、计划、进展、预算与重试计数保持不动'};
 }
 currentTaskId(run){
  try{const row=this.db.prepare("SELECT task_id FROM pf_task_state WHERE owner=? AND EXISTS(SELECT 1 FROM todos t WHERE t.id=task_id AND t.status='doing') LIMIT 1")
   .get(run.executor_session_id);return row?.task_id??null;}catch{return null;}
 }
 transferFocus({taskId=null,to='',reason=''}={}){
  if(!this.focus)return {moved:false,reason:'未装配焦点层：记忆焦点未转移（能力位保持不发布）'};
  try{
   const moved=typeof this.focus.relay==='function'?this.focus.relay({taskId,to,reason})
    :{moved:false,reason:'焦点层没有提供 relay：不假装记忆已转移'};
   return moved;
  }catch(error){return {moved:false,reason:`焦点转移失败：${(error&&error.message)||error}`};}
 }
 // ── 重启恢复（§10.2）─────────────────────────────────────────────────
 restartView({projectId=null}={}){
  const rows=this.db.prepare(`SELECT * FROM pf_goal_runs WHERE status IN ('paused','waiting') ORDER BY updated_at DESC`).all()
   .filter(r=>!projectId||this.goals.goalRow(r.goal_id)?.project_id===projectId);
  return rows.map(run=>this.eligibility(run));
 }
 eligibility(run){
  const auth=this.authorization(run),source=parse(auth?.source,{}),budgets=parse(run.budgets,{}),consumed=parse(run.consumed,{});
  const blockers=[];
  if(!auth)blockers.push('没有授权记录');
  else if(source.kind!=='user')blockers.push('授权来源不是真实用户');
  if(auth&&!auth.allow_restart_recovery)blockers.push('授权未启用应用重启恢复（首版默认不自动重启）');
  const left=budgets.maxCalls!=null?Number(budgets.maxCalls)-Number(consumed.calls||0):null;
  if(left!=null&&left<=0)blockers.push(RESUME_BLOCKERS.budget);
  const uncertain=this.uncertain();
  if(uncertain.length)blockers.push(`有 ${uncertain.length} 笔在途写操作结果不确定：先核对，不重放`);
  if(String(run.pause_origin||'')==='user')blockers.push('用户显式暂停：不自动恢复');
  return {runId:run.id,goalId:run.goal_id,status:run.status,phase:run.phase,pauseOrigin:run.pause_origin,
   executorSessionId:run.executor_session_id,generation:run.generation,eligible:blockers.length===0,blockers};
 }
 resume(runId,{by='',reason='',messageId=null}={}){
  const run=this.db.prepare('SELECT * FROM pf_goal_runs WHERE id=?').get(String(runId));
  if(!run)fail('目标运行不存在','NOT_FOUND');
  const view=this.eligibility(run);
  if(!view.eligible)fail(`不能恢复：${view.blockers.join('；')}`);
  if(!String(by||'').trim())fail('恢复必须署名：谁恢复的要能查');
  if(!String(reason||'').trim())fail('恢复必须写明原因');
  const task=this.currentTaskId(run);
  const t=new Date().toISOString(),id=`relay-${Math.random().toString(36).slice(2,12)}`;
  OP.dbWrite();
  this.db.prepare("UPDATE pf_goal_runs SET status='running',phase=?,pause_reason='',pause_origin='',updated_at=? WHERE id=?")
   .run(task?'executing':'planning',t,run.id);
  this.db.prepare(`INSERT INTO pf_goal_relays(id,goal_id,run_id,from_session,to_session,generation_before,generation_after,
   task_id,scope,reason,source_refs,by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
   .run(id,run.goal_id,run.id,run.executor_session_id,run.executor_session_id,String(run.generation||''),String(run.generation||''),
    task,'restart-resume',String(reason),JSON.stringify([messageId||by]),String(by||''),t);
  return {resumed:true,relayId:id,runId:run.id,status:'running',phase:task?'executing':'planning',by,taskId:task,
   note:'恢复的是同一运行与同一代际；没有重放任何不确定写操作'};
 }
 // ── 仅绑定不续跑（§10.2 末句）────────────────────────────────────────
 bind(sessionId,projectId){
  const goal=this.goals.current(projectId);
  const run=goal?this.db.prepare("SELECT * FROM pf_goal_runs WHERE goal_id=? AND status IN ('running','waiting') ORDER BY started_at DESC").get(goal.id):null;
  const owned=run?String(run.executor_session_id)===String(sessionId):false;
  return {sessionId,projectId,goalId:goal?.id??null,runId:run?.id??null,attached:false,resumed:false,
   inheritsExecution:false,owner:run?.executor_session_id??null,
   note:run&&!owned?'该目标有在途运行属于其他会话：绑定只建立绑定，不继承执行权、不续跑；接力要一次明确的用户要求'
    :'绑定只建立绑定，不启动运行'};
  }
  // 任务交接结果必须回填台账：只搬了运行、没搬任务时，回执与台账都要看得出来。
  recordTaskTransfer(relayId,{ok=false,error='',by=''}={}){
   const row=this.db.prepare('SELECT * FROM pf_goal_relays WHERE id=?').get(String(relayId));
   if(!row)fail('接力记录不存在','NOT_FOUND');
   const state=ok?'ok':`failed:${String(error||'未知原因')}`;
   OP.dbWrite();
   this.db.prepare("UPDATE pf_goal_relays SET task_transfer=?,by=COALESCE(NULLIF(?,''),by) WHERE id=?")
    .run(state,String(by||''),String(relayId));
   return {relayId:String(relayId),taskTransfer:state,taskId:row.task_id};
  }
 }
module.exports={GoalRelay};
