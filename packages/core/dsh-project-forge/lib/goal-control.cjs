'use strict';
const {BUDGET_PRESETS}=require('./goal-store.cjs');
const fail=(message,code='GOAL_CONTROL')=>{throw Object.assign(new Error(message),{code});};
function goalControl({goals,scheduler,flow,acceptance,access,snapshot},msg){
 const {sessionId,projectId,action}=msg;
 const input=msg.source?.channel==='goal-chat'?require('./goal-chat-control.cjs').validateChatSource(msg.source,action,msg.input||{}):(msg.input||{});
 if(!sessionId||!projectId)fail('目标操作需要活动会话与工程');
 const context=access(projectId,action!=='status');
 let goal=goals.current(projectId);
 if(!goal)goal=goals.db.prepare('SELECT * FROM pf_goals WHERE project_id=? ORDER BY created_at DESC,rowid DESC').get(projectId)||null;
 const run=goal?goals.db.prepare('SELECT * FROM pf_goal_runs WHERE goal_id=? ORDER BY started_at DESC,rowid DESC').get(goal.id):null;
 const view=()=>({goal:goal?goals.decorate(goals.goalRow(goal.id)):null,run:run?goals.decorateRun(goals.runRow(run.id)):null});
 if(action==='status')return view();
 if(action==='propose'){
  const spec=input.spec||{};
  if(!Array.isArray(spec.criteria)||!spec.criteria.length||!Array.isArray(input.links)||!input.links.length)fail('目标需要验收条件与 taskId/criterionIds 映射');
  goals.db.exec('SAVEPOINT goal_propose');
  try{
   const made=goals.define(projectId,spec);
   const ids=new Set(made.criteria.map(c=>c.id));
   if(input.links.some(l=>!Array.isArray(l.criterionIds)||!l.criterionIds.length||l.criterionIds.some(id=>!ids.has(id))))fail('任务映射必须引用本目标中已定义的条件 ID');
   goals.revisePlan(made.id,'目标提案',input.links,[]);
   goals.db.exec('RELEASE goal_propose');
   return {goal:goals.decorate(goals.goalRow(made.id)),run:null,requiresUserStart:true};
  }catch(e){goals.db.exec('ROLLBACK TO goal_propose');goals.db.exec('RELEASE goal_propose');throw e;}
 }
 if(!goal)fail('该工程还没有目标；先让 Agent 用 forge_goal propose 提交目标与验收条件');
 if(input.expectedGoalId&&input.expectedGoalId!==goal.id)fail('当前目标已变化，请重新核对','REVISION_CONFLICT');
 if(input.expectedRevision!=null&&Number(input.expectedRevision)!==goal.revision)fail('目标已变化，请刷新后操作','REVISION_CONFLICT');
 if(run&&run.executor_session_id!==sessionId)fail('目标由其他会话持有；请先走接力，不能从控制按钮抢占');
 if(run&&input.expectedGeneration!==run.generation)fail('运行已变化，请刷新状态后操作','STALE_GENERATION');
 if(action==='revise'){
  if(run&&run.status==='running')fail('运行中不能修订目标；请先 pause 再 revise','GOAL_RUNNING');
  if(input.expectedRevision==null)fail('revise 必须携带 expectedRevision 乐观锁','REVISION_CONFLICT');
  goals.db.exec('SAVEPOINT goal_revise');
  try{
   goals.revise(goal.id,input.expectedRevision,input.spec||{},input.reason||'修订目标定义');
   const alive=new Set(goals.db.prepare("SELECT id FROM pf_goal_criteria WHERE goal_id=? AND status!='superseded'").all(goal.id).map(r=>r.id));
   const broken=goals.db.prepare('SELECT task_id,criterion_ids FROM pf_goal_task_links WHERE goal_id=?').all(goal.id)
    .flatMap(l=>JSON.parse(l.criterion_ids||'[]').filter(id=>!alive.has(id)).map(id=>`任务${l.task_id}→${id}`));
   if(broken.length)fail('任务映射引用了被替换掉的条件：'+broken.join('、')+'；requirement/category 不变则条件 ID 稳定，请保留这些条件或先停止目标');
   goals.db.exec('RELEASE goal_revise');
   return view();
  }catch(e){goals.db.exec('ROLLBACK TO goal_revise');goals.db.exec('RELEASE goal_revise');throw e;}
 }
 if(['start','resume'].includes(action)){
  // The host creates this from actual chat input or a legacy panel action.
  if(msg.source?.kind!=='user'||!msg.source.messageId||!['goal-chat','goal-panel'].includes(msg.source.channel))fail('启动/继续需要真实用户授权；请在聊天说“开启心流”或“继续心流”');
  if(input.expectedRevision!==goal.revision)fail('启动前须核对当前目标修订','REVISION_CONFLICT');
  if(flow.state(sessionId).run?.status==='running')fail('原心流正在运行，请先停止原心流','GOAL_FLOW_MUTEX');
  if(['completed','superseded','stopped'].includes(goal.status))fail('目标已结束，请新建目标');
  if(action==='start'){
   if(run)fail('已有运行记录，请选择继续；不能重建运行清空预算');
   const budgets=require('./goal-budget.cjs').effective(BUDGET_PRESETS.long,input.budgets||BUDGET_PRESETS.short);
   const auth=goals.authorize(goal.id,msg.source,{budgets});
   const started=goals.startRun(goal.id,{authorizationId:auth.id,mode:'assist',executorSessionId:sessionId});
   goals.db.prepare("UPDATE pf_goals SET status='active' WHERE id=?").run(goal.id);
   flow.bind(sessionId,projectId);
   return {goal:goals.decorate(goals.goalRow(goal.id)),run:started};
  }
  if(!run||!['paused','waiting'].includes(run.status))fail('只有暂停/等待中的运行可以继续；停止的运行需新目标');
  const resumeBudgets=require('./goal-budget.cjs').effective(typeof run.budgets==='string'?JSON.parse(run.budgets):run.budgets,input.budgets||{});
  if(scheduler.budgetStatus({...run,budgets:resumeBudgets}))fail('目标运行预算已耗尽，不能通过继续清零');
  const competing=scheduler.activeRun(sessionId);
  if(competing&&competing.id!==run.id)fail('会话已有另一个在途目标');
  const next=goals.transition(run.id,'resume',{reason:msg.source.channel==='goal-chat'?'用户在聊天中继续心流':'用户继续目标心流',expectedGeneration:run.generation});
  // Explicit recovery invalidates messages queued before the pause, without
  // changing the task activation or resetting progress and budgets.
  next.generation=require('node:crypto').randomUUID();
  goals.db.prepare('UPDATE pf_goal_runs SET generation=?,budgets=? WHERE id=?').run(next.generation,JSON.stringify(resumeBudgets),run.id);
  next.budgets=resumeBudgets;
  flow.bind(sessionId,projectId);
  return {...view(),run:next};
 }
 if(!run)fail('目标还没有运行记录');
 if(action==='pause'||action==='stop'){
  if(action==='stop'&&run.status==='stopped'){goals.db.prepare("UPDATE pf_goals SET status='stopped' WHERE id=?").run(goal.id);return view();}
  if(action==='pause'&&run.status==='paused'){
   goals.db.prepare("UPDATE pf_goal_runs SET pause_origin='user',pause_reason='用户暂停' WHERE id=?").run(run.id);
   return view();
  }
  const next=goals.transition(run.id,action,{reason:input.reason||'用户/Agent 请求暂停自动推进',origin:'user',expectedGeneration:run.generation});
  if(action==='stop')goals.db.prepare("UPDATE pf_goals SET status='stopped' WHERE id=?").run(goal.id);
  return {...view(),run:next};
 }
 if(action==='finish'){
  const check=acceptance.checkGoalAccepted(goal.id,{root:context.rootInfo.root});
  const linked=new Set(goals.decorate(goal).links.map(l=>Number(l.taskId)));
  const unfinished=snapshot(projectId,sessionId).todos.filter(t=>linked.has(Number(t.id))&&!['done','cancelled','skipped'].includes(t.status));
  if(!check.accepted||unfinished.length)return {...view(),finished:false,acceptance:check,unfinished:unfinished.map(t=>({id:t.id,status:t.status}))};
  return {...view(),finished:true,run:goals.transition(run.id,'complete',{expectedGeneration:run.generation,phase:'reconciling'}),acceptance:check};
 }
 fail('未知目标控制动作');
}
module.exports={goalControl};
