'use strict';
// GF08（§6.2/§8.1/§8.2 + GA11/GA26/GA29）：自动选择认领与范围内计划调整（第二阶段）。
// ── 铁律 ──────────────────────────────────────────────────────────────
//  * 只从合法候选选择：授权有效、属于确认范围（有任务↔条件映射）、待办且未被持有、
//    依赖已满足、接收会话无冲突任务、当前快照有效（任务修订未被别人动过）。
//  * 不抢 owner：已有 owner 的任务只走显式 handoff（GF09），选择阶段直接排除。
//  * 不做语义猜测：候选只来自代码给出的清单；JEV 的 next_task/scope_relation 在阈值
//    未标定时只作参考记录（advisory），不代替确定性判据（GA29 允许稳定次序回退）。
//  * 第二阶段才自动认领：mode≠autonomous 时只给建议（suggest），不代执行手续。
//  * 计划修订是独立事务：走 goals.revisePlan 的版本审计（before/after/reason/sourceRefs），
//    越界修改（无关新功能、删要求、降标准、改硬约束）必须真实用户决定，程序直接拒绝落盘。
const fail=(message,code='PLAN_POLICY')=>{throw Object.assign(new Error(message),{code});};
const parse=(v,fb)=>{try{return typeof v==='string'?JSON.parse(v):v??fb;}catch{return fb;}};
const SCOPE_KINDS=['split','reorder','fix','retest','add'];
class GoalPlan {
 constructor({goalStore,advisory=null}={}){
  if(!goalStore||!goalStore.db)fail('GoalPlan 需要已构造的 GoalStore','PLAN_CONFIG');
  this.goals=goalStore;this.db=goalStore.db;this.advisory=advisory;
  this.db.exec(`CREATE TABLE IF NOT EXISTS pf_goal_plan_audit(
    id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,plan_revision INTEGER NOT NULL,kind TEXT NOT NULL DEFAULT 'revise',
    in_scope INTEGER NOT NULL DEFAULT 1,requires_user INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL DEFAULT '',
    applied INTEGER NOT NULL DEFAULT 0,out_of_scope TEXT NOT NULL DEFAULT '[]',source_refs TEXT NOT NULL DEFAULT '[]',
    by TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);`);
 }
 // ── 前提前提（§8.1 六项里可代码判定的部分）────────────────────────────
 authorization(run){
  const row=this.db.prepare('SELECT * FROM pf_goal_authorizations WHERE id=?').get(String(run?.authorization_id||''));
  if(!row)return {ok:false,reason:'运行没有授权记录'};
  const source=parse(row.source,{});
  if(source.kind!=='user'||!source.messageId)return {ok:false,reason:'授权来源不是带 messageId 的真实用户消息'};
  return {ok:true,messageId:source.messageId};
 }
 // 任务行按工程读全量，再按“依赖是否已通过验收”筛选。
 tasksOf(projectId){return (this.goals.tasks?.list(projectId)||[]);}
 linksOf(goalId){return this.db.prepare('SELECT task_id,criterion_ids FROM pf_goal_task_links WHERE goal_id=?').all(goalId)
  .map(l=>({taskId:Number(l.task_id),criterionIds:parse(l.criterion_ids,[]).map(String)}));}
 criteriaOf(goalId){return this.db.prepare('SELECT id,requirement,category,status FROM pf_goal_criteria WHERE goal_id=? ORDER BY position,id').all(goalId);}
 candidates(run,{projectId=null,snapshot=null}={}){
  const goalId=run?.goal_id,g=this.goals.goalRow(goalId);
  const project=g?.project_id||projectId;
  const links=new Map(this.linksOf(goalId).map(l=>[l.taskId,l]));
  const tasks=this.tasksOf(project),byId=new Map(tasks.map(t=>[Number(t.id),t]));
  const snap=new Map(((snapshot&&snapshot.todos)||[]).map(t=>[Number(t.id),t]));
  const list=[],excluded=[];
  for(const [taskId,link] of links){
   const t=byId.get(taskId);
   if(!t){excluded.push({taskId,why:'任务不在本工程（映射已失效）'});continue;}
   if(!link.criterionIds.length){excluded.push({taskId,why:'没有条件映射：不属于目标确认范围'});continue;}
   if(t.owner){excluded.push({taskId,why:`已被 ${t.owner} 持有：只走显式接力（handoff），不抢占`});continue;}
   if(t.status!=='pending'){excluded.push({taskId,why:`状态 ${t.status} 不是待办`});continue;}
   const unmet=(t.dependencies||[]).map(id=>byId.get(Number(id))).filter(d=>!d||d.status!=='done'||!(d.evidence||[]).length);
   if(unmet.length){excluded.push({taskId,why:`依赖未通过验收：#${unmet.map(d=>d?.seq??'?').join('、')}`});continue;}
   const seen=snap.get(taskId);
   if(snapshot&&seen&&Number(seen.revision)!==Number(t.revision)){excluded.push({taskId,why:'快照已过期（修订已变化）'});continue;}
   if(snapshot&&!seen){excluded.push({taskId,why:'快照里没有这项：先核对再认领'});continue;}
   list.push({taskId,seq:t.seq,title:t.title,revision:t.revision,criterionIds:link.criterionIds});
  }
  list.sort((a,b)=>(a.seq??0)-(b.seq??0)||a.taskId-b.taskId); // GA29：稳定次序回退
  return {goalId,projectId:project,candidates:list,excluded};
 }
 // ── 选择 ──────────────────────────────────────────────────────────────
 select(run,{projectId=null,sessionId=null,snapshot=null,judgments={}}={}){
  if(!run)fail('选择需要目标运行');
  const auth=this.authorization(run);
  const {goalId,projectId:project,candidates,excluded}=this.candidates(run,{projectId,snapshot});
  const tasks=this.tasksOf(project);
  const focusRow=sessionId?(this.goals.tasks?.focusOf?.(sessionId)||null):null;
  const mine=(focusRow?.task_id?tasks.find(t=>Number(t.id)===Number(focusRow.task_id)&&t.status==='doing'&&t.owner===sessionId):null)
   ||tasks.find(t=>t.status==='doing'&&t.owner===sessionId);
  const base={goalId,projectId:project,sessionId,candidates:candidates.map(c=>c.taskId),excluded,authorization:auth,
   matrix:{authorized:auth.ok,scope:candidates.length>0,claimed:!!mine,snapshot:snapshot?true:'unverified'}};
  if(!auth.ok)return {...base,action:'hold',reason:`不能自动认领：${auth.reason}`};
  if(mine)return {...base,action:'hold',reason:`接收会话已有进行中任务 #${mine.seq}：不重新认领（问进度后恢复同一项）`,ready:false};
  const links=this.linksOf(goalId);
  if(!links.length)return {...base,action:'plan',reason:'目标没有任务清单：先规划（planning），不凭标题猜关联'};
  if(!candidates.length)return {...base,action:'none',
   reason:`没有合法候选：${excluded.slice(0,3).map(e=>`#${e.taskId} ${e.why}`).join('；')||'清单里的项都不可认领'}`};
  // JEV next_task 只作参考：必须落在代码给出的候选集合内，否则记为无效建议（GA29/§6.2）。
  const want=judgments?.next_task;
  const picked=want&&candidates.find(c=>String(c.taskId)===String(want));
  const advisory=want?(picked?{accepted:true,taskId:picked.taskId,source:'jev'}
   :{accepted:false,rejected:want,reason:'建议不在合法候选集合内：不能选择未提供的任务'}):null;
  const chosen=picked||candidates[0];
  const autonomous=String(run.mode||'assist')==='autonomous';
  return {...base,action:autonomous?'claim':'suggest',candidate:chosen,taskId:chosen.taskId,advisory,
   order:'stable-seq',ready:true,
   reason:autonomous?`自动认领合法候选 #${chosen.seq}（稳定次序${picked?'＋判断一致':'回退'}）`
    :`建议认领 #${chosen.seq}（当前模式 ${run.mode||'assist'}：只建议，不代执行手续）`};
 }
 // ── 范围内计划调整（§8.2）─────────────────────────────────────────────
 classify(run,{tasks=[],reason='',kind='revise'}={}){
  const goalId=run?.goal_id,g=this.goals.goalRow(goalId);
  if(!g)fail('目标不存在');
  if(!String(reason||'').trim())fail('计划调整必须写明原因（审计要能重建决策脉络）');
  const criteria=this.criteriaOf(goalId).filter(c=>c.status!=='superseded');
  const known=new Set(criteria.map(c=>String(c.id)));
  const before=this.linksOf(goalId),beforeIds=new Set(before.map(l=>l.taskId));
  const nextIds=new Set((tasks||[]).map(t=>Number(t.taskId)));
  const outOfScope=[],warnings=[];
  for(const link of tasks||[]){
   const ids=(link.criterionIds||[]).map(String);
   if(!ids.length)outOfScope.push(`任务 ${link.taskId} 没有目标映射：新增无关工作要真实用户决定`);
   for(const id of ids)if(!known.has(id))outOfScope.push(`任务 ${link.taskId} 映射到不存在的条件 ${id}`);
  }
  // 稳定 ID：已在计划里、又不是取消/跳过的项不能凭修订悄悄移除。
  const project=g.project_id,byId=new Map(this.tasksOf(project).map(t=>[Number(t.id),t]));
  for(const id of beforeIds)if(!nextIds.has(id)){
   const t=byId.get(id);
   if(t&&!['cancelled','skipped'].includes(t.status))outOfScope.push(`任务 #${id} 被移出计划但没有取消/跳过：删除要求要真实用户决定`);
   else warnings.push(`任务 #${id} 已取消/跳过，移出计划保留历史`);
  }
  // 已验证条件的覆盖：不能因为改计划让已通过的条件失去覆盖（GF07 台账为准）。
  let accepted=new Set(),coverageKnown=true;
  try{
   accepted=new Set(this.db.prepare("SELECT criterion_ids FROM pf_goal_verifications WHERE goal_id=? AND decision='accepted'")
    .all(goalId).flatMap(v=>parse(v.criterion_ids,[]).map(String)));
  }catch{coverageKnown=false;} // 验收层未装配时按“没有已通过条件”处理，并在下面显式声明降级
  const covered=new Set((tasks||[]).flatMap(t=>(t.criterionIds||[]).map(String)));
  for(const id of accepted)if(!covered.has(id))outOfScope.push(`已通过的条件 ${id} 在新计划里没有覆盖`);
  if(!coverageKnown)warnings.push('验收台账不可用：覆盖检查退化为映射成立性，未核对已通过条件');
  else if(!accepted.size)warnings.push('当前没有已通过的核验：覆盖检查只按映射成立性判定');
  return {goalId,projectId:project,kind,inScope:outOfScope.length===0,outOfScope,warnings,
   criteria:criteria.map(c=>c.id),before:{tasks:before.map(l=>l.taskId)},next:{tasks:[...nextIds]}};
 }
 revise(run,{tasks=[],reason='',sourceRefs=[],by='',kind='revise',advisory=null}={}){
  const cls=this.classify(run,{tasks,reason,kind});
  const t=new Date().toISOString();
  if(!cls.inScope){
   // 越界不落盘：先把“为什么拒绝”写进审计，再让调用方去找真实用户决定。
   this.db.prepare(`INSERT INTO pf_goal_plan_audit(id,goal_id,plan_revision,kind,in_scope,requires_user,reason,applied,out_of_scope,source_refs,by,created_at)
    VALUES(?,?,?,?,0,1,?,0,?,?,?,?)`).run(`plan-${Math.random().toString(36).slice(2,14)}`,cls.goalId,0,kind,reason,
    JSON.stringify(cls.outOfScope),JSON.stringify(sourceRefs),String(by),t);
   return {applied:false,requiresUser:true,outOfScope:cls.outOfScope,warnings:cls.warnings,
    reason:'越界调整需要真实用户决定：新增无关功能、删除要求、降低验收标准或改硬约束都不能由程序代决'};
  }
  const out=this.goals.revisePlan(cls.goalId,reason,tasks,sourceRefs);
  this.db.prepare(`INSERT INTO pf_goal_plan_audit(id,goal_id,plan_revision,kind,in_scope,requires_user,reason,applied,out_of_scope,source_refs,by,created_at)
   VALUES(?,?,?,?,1,0,?,1,'[]',?,?,?)`).run(`plan-${Math.random().toString(36).slice(2,14)}`,cls.goalId,out.planRevision,kind,reason,
   JSON.stringify(sourceRefs),String(by),t);
  return {applied:true,requiresUser:false,planRevision:out.planRevision,warnings:cls.warnings,advisory,
   audit:{kind:'plan',revision:out.planRevision,reason,before:cls.before,after:cls.next}};
 }
 revisions(goalId){
  const versions=this.db.prepare("SELECT revision,reason,before,after,source_refs,created_at FROM pf_goal_plan_versions WHERE goal_id=? AND kind='plan' ORDER BY revision").all(goalId)
   .map(v=>({revision:v.revision,reason:v.reason,before:parse(v.before,[]),after:parse(v.after,[]),sourceRefs:parse(v.source_refs,[]),createdAt:v.created_at}));
  const audit=this.db.prepare('SELECT * FROM pf_goal_plan_audit WHERE goal_id=? ORDER BY created_at').all(goalId)
   .map(a=>({id:a.id,planRevision:a.plan_revision,kind:a.kind,inScope:!!a.in_scope,requiresUser:!!a.requires_user,
    applied:!!a.applied,reason:a.reason,outOfScope:parse(a.out_of_scope,[]),sourceRefs:parse(a.source_refs,[]),by:a.by,createdAt:a.created_at}));
  return {goalId,versions,audit,scopeKinds:SCOPE_KINDS};
 }
}
module.exports={GoalPlan,SCOPE_KINDS};
