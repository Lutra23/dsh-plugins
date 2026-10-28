'use strict';
// GF02（主文档 §5）：唯一调度器。同一 goal run 最多一个调度决策与一个受管轮次在途；
// 本层只做决策与记账，不执行模型调用、不伪造用户消息。
// 决策序（§5.3）：用户停止/暂停 → 归属/状态失效 → 生成代际 → 确定性前提(abort/error/capacity)
//   → 预算硬门槛 → 新用户输入 → 等待登记 → step 记账 → 收尾幂等/read-set → 默认续跑/验收。
// §5.1：Agent 的普通收尾语句不解除运行——默认续跑是规则，不是奖励。
const OP=require('./operations.cjs');
const now=()=>new Date().toISOString();
const parse=(v,fb)=>{try{return typeof v==='string'?JSON.parse(v):v??fb;}catch{return fb;}};

class GoalScheduler {
 constructor(goalStore,{stall=null,evidence=null}={}){
  this.goals=goalStore;this.db=goalStore.db;
  // GF06：停滞层与证据层是可选协作对象——没有装配时行为与 GF02 一致。
  this.stall=stall;this.evidence=evidence;
  // last_stop：收尾幂等键。同一 assistant seq 的重复 turn-stopping 只注入一次（在途不重复）。
  if(!this.db.prepare('PRAGMA table_info(pf_goal_runs)').all().some(c=>c.name==='last_stop'))
   this.db.exec("ALTER TABLE pf_goal_runs ADD COLUMN last_stop TEXT NOT NULL DEFAULT ''");
  this.db.exec('CREATE TABLE IF NOT EXISTS pf_goal_steps(run_id TEXT NOT NULL,step_id TEXT NOT NULL,PRIMARY KEY(run_id,step_id))');
 }
 // 在途：running/waiting，外加“被插话挡住”的挂起 run（回答结束可恢复同一任务，§9）。
 activeRun(sessionId){
  return this.db.prepare("SELECT * FROM pf_goal_runs WHERE executor_session_id=? AND (status IN ('running','waiting') OR (status='paused' AND pause_origin='interrupt')) ORDER BY started_at DESC").get(sessionId)||null;
 }
 // 严格在途：只有 running/waiting。回执采集与观察落账用它——插话问答期间不把用户指令当目标进展（§9）。
 runningRun(sessionId){
  return this.db.prepare("SELECT * FROM pf_goal_runs WHERE executor_session_id=? AND status IN ('running','waiting') ORDER BY started_at DESC").get(sessionId)||null;
 }
 latestRun(sessionId){return this.db.prepare('SELECT * FROM pf_goal_runs WHERE executor_session_id=? ORDER BY started_at DESC,rowid DESC').get(sessionId)||null;}
 budgetStatus(run,{ignoreCalls=false}={}){
  const goal=this.goals.decorate(this.goals.goalRow(run.goal_id));
  const budgets=parse(run.budgets,{}),spent=goal.consumedTotal;
  const first=goal.runs.reduce((n,r)=>Math.min(n,Date.parse(r.started_at)),Date.parse(run.started_at));
  for(const [key,value] of [['maxSteps',Number(spent.steps)||0],['maxCalls',Number(spent.calls)||0],['maxMinutes',(Date.now()-first)/60000]])
   if(!(ignoreCalls&&key==='maxCalls')&&Number(budgets[key])>0&&value>=Number(budgets[key]))return {key,cap:Number(budgets[key]),spent:value};
  return null;
 }
 // §5.2 read-set 指纹：发送前与提交前各算一次，不一致即迟到。
 fingerprint(run,snapshot){
  const todos=snapshot?.todos||[];
  return [run.goal_id,run.goal_revision,run.generation,run.executor_session_id,
   todos.map(t=>`${t.id}:${t.revision}`).join(','),snapshot?.latestUserSeq??''].join('|');
 }
 tick(sessionId,input={},snapshot={}){
  let run=this.activeRun(sessionId);
  if(!run&&(input.stop||input.pause||input.aborted||input.user)){
   const latest=this.latestRun(sessionId);if(latest?.status==='paused')run=latest;
  }
  if(!run)return {decision:'none'};
  const todos=snapshot.todos||[];
  const currentTask=todos.find(t=>t.status==='doing'&&t.owner===sessionId)||null;
  // GF06：把本轮清单/当前项/证据现状交给停滞层——纠偏指令要有具体对象，不按标题猜关联。
  if(this.stall)this.stall.context({todos,current:currentTask,progress:this.evidence?this.evidence.progress(run.id):null});
  const closeStall=(outcome,extra={})=>this.stall?this.stall.closeWindow(run,{taskId:currentTask?.id??null,sessionId,outcome,...extra}):null;
  // 回执里的停滞视图：计数、档位、待处理标记、纠偏动作与指令都摊开（GF06 可审计）。
  const stallView=s=>s?{count:s.state.count,tier:s.state.tier,pendingReview:s.state.pendingReview,action:s.action,
   directive:s.directive,independent:s.independent,effective:s.effective.length,nonProgress:s.nonProgress,counted:s.counted,kind:s.kind}:null;
  const g=this.goals,gen=()=>({expectedGeneration:run.generation});
  let focusRestore=null;
  // 插话恢复结果随任意后续决策一起回执，不吞掉“恢复了哪个焦点”。
  const out=o=>focusRestore?{...o,focusRestore}:o;
  // ① 生成代际：迟到提交不产生任何动作（§5.2——状态已变化或服务重启）。
  if(input.generation&&input.generation!==run.generation)return {decision:'stale',run};
  // ② 用户显式停止/暂停：硬门槛，代码决定，优先级最高（§5.3/§6.3）。origin=user，永不自动恢复（§9）。
  if(input.stop){const s=stallView(closeStall('suspended',{reason:'用户停止：不惩罚停滞计数'}));return {decision:'stopped',run:g.transition(run.id,'stop',{reason:input.reason||'用户停止',origin:'user',...gen()}),...(s?{stall:s}:{})};}
  if(input.pause){
   if(run.status==='paused'){OP.dbWrite();this.db.prepare("UPDATE pf_goal_runs SET pause_origin='user',pause_reason=? WHERE id=?").run(input.reason||'用户暂停',run.id);return {decision:'paused',run:g.runRow(run.id)};}
   const s=stallView(closeStall('suspended',{reason:'用户暂停：不惩罚停滞计数'}));return {decision:'paused',run:g.transition(run.id,'pause',{reason:input.reason||'用户暂停',origin:'user',...gen()}),...(s?{stall:s}:{})};}
  if(input.aborted){closeStall('suspended',{reason:'本轮取消'});return {decision:'stopped',run:g.transition(run.id,'stop',{reason:'用户停止或本轮取消',origin:'user',...gen()})};}
  // ⑥b GF05 插话收回合（§9）：来源是插话挂起 + 用户没有新的停止/暂停要求 + 这一轮已经回答完
  //  → 恢复同一任务并继续；不重新 start/resume 任务、不新建 activation、不重复召回。
  // 位置在“非 running 直接 hold”之前：挂起的 run 必须能走到这里，其余暂停来源仍然 hold。
  if(!input.user&&run.status==='paused'&&run.pause_origin==='interrupt'&&(input.stopping||input.restoreFocus)){
   if(input.lifecycle&&['stop','pause'].includes(String(input.lifecycle)))
    return {decision:'hold',run,reason:'用户仍然要求停止/暂停：不因回答结束而恢复'};
   run=g.transition(run.id,'resume',{reason:'插话已回答：恢复同一任务（不重新认领）',...gen()});
   focusRestore=typeof this.onFocusRestore==='function'?this.onFocusRestore({sessionId,run}):null;
  }
  if(run.status!=='running'&&run.status!=='waiting')return {decision:'hold',run};
  // ③ 归属失效：执行权不再属于本会话的旧提交（§8.1 不自动抢占）。
  if(input.executorSessionId&&input.executorSessionId!==run.executor_session_id)
   {closeStall('suspended',{reason:'执行权已转移'});return {decision:'paused',run:g.transition(run.id,'pause',{reason:'执行权已转移，旧会话动作失效',origin:'ownership',...gen()})};}
  // ④ 确定性前提：取消/错误/容量，均代码裁决（§6.3 程序硬拒优先）。
  if(input.error){closeStall('suspended',{reason:'执行错误'});return {decision:'paused',run:g.transition(run.id,'pause',{reason:'执行错误，请核对后继续',origin:'error',...gen()})};}
  if(input.capacity){closeStall('suspended',{reason:'容量不足'});return {decision:'paused',run:g.transition(run.id,'pause',{reason:String(input.capacity),origin:'capacity',...gen()})};}
  // ⑤ 预算硬门槛：总时限含暂停期间（§4），换 run 不清零（goal 级防绕在 startRun）。
  if(input.step&&this.db.prepare('SELECT 1 FROM pf_goal_steps WHERE run_id=? AND step_id=?').get(run.id,String(input.step)))return out({decision:'hold',run});
  // Calls are reserved when a continuation is scheduled. Its admitted steps
  // must not be rejected merely because that reservation used the final call.
  // Closing a finished task set performs deterministic acceptance, no new work.
  const closing=input.stopping&&todos.length&&todos.every(t=>['done','cancelled','skipped'].includes(t.status));
  const exhausted=closing?null:this.budgetStatus(run,{ignoreCalls:!input.stopping});
  if(exhausted){closeStall('suspended',{reason:`达到 ${exhausted.key} 预算上限`});return {decision:'paused',budget:true,run:g.transition(run.id,'pause',{reason:`达到 ${exhausted.key}=${exhausted.cap} 预算上限`,origin:'budget',...gen()})};}
  // ⑥ 新用户消息优先进入宿主；先停止新增自动动作。origin=interrupt：这是“挂起”而不是用户暂停（§9）。
  if(input.user){closeStall('interrupt',{reason:'新用户输入优先：插话不是无进展窗口'});return {decision:'paused',run:g.transition(run.id,'pause',{reason:input.resumeAfterReply?'插话未改变运行意图，回答后恢复':'用户输入的继续意图尚未确认；回答后保持暂停，可在聊天说“继续心流”',origin:input.resumeAfterReply?'interrupt':'user-input',...gen()})};}
  // ⑦ 等待登记：登记真实条件与截止（§10.2），等待不消耗模型轮次。
  if(input.waitUntil){const s=stallView(closeStall('waiting',{reason:'等待真实结果：不计失败窗口'}));
   return out({decision:'waiting',run:g.transition(run.id,'wait',{nextWakeAt:input.waitUntil,...gen()}),...(s?{stall:s}:{})});}
  // ⑧ step 记账：非收尾路径只累计预算。
  if(input.step){
   if(run.status==='waiting')return out({decision:'hold',run});
   OP.dbWrite();this.db.prepare('INSERT INTO pf_goal_steps(run_id,step_id) VALUES(?,?)').run(run.id,String(input.step));
   g.consume(run.id,{steps:1});return out({decision:'hold',run:this.activeRun(sessionId)});
  }
  if(run.status==='waiting')return out({decision:'hold',run});
  if(!input.stopping)return out({decision:'hold',run});
  // ⑨ 收尾幂等：同一 assistant seq 只注入一次（事件重复投递幂等，§5.1）。
  if(input.stopping===run.last_stop)return out({decision:'hold',run});
  // ⑩ read-set 指纹：发起时指纹与当前不一致 → 迟到，拒绝动作（§5.2）。
  if(input.fingerprint&&input.fingerprint!==this.fingerprint(run,snapshot))return out({decision:'stale',run});
  OP.dbWrite();
  this.db.prepare('UPDATE pf_goal_runs SET last_stop=?,updated_at=? WHERE id=?').run(String(input.stopping),now(),run.id);
  // ⑪ GF06：本窗口结算。等待/插话/挂起都不动计数；真正收尾才按“本窗口有没有有效进展”判定停滞与纠偏档位。
  const stall=closeStall(currentTask?.status==='blocked'?'blocked':'turn-end',{reason:currentTask?.status==='blocked'?'当前任务受阻：不惩罚停滞计数，改走独立任务或阻塞报告':'',stopSeq:String(input.stopping)});
  const withStall=o=>{const v=stallView(stall);return v?{...o,stall:v}:o;};
  // ⑫ 默认续跑前的结构检查：任务清单存在且未全完成。
  if(!todos.length)return out(withStall({decision:'paused',run:g.transition(run.id,'pause',{reason:'目标运行没有任务清单，请先建立计划（planning）',phase:'planning',origin:'planning',...gen()})}));
  if(todos.length&&todos.every(t=>['done','cancelled','skipped'].includes(t.status))){
   // GF07：Todo 全完不等于目标完成——逐条核对目标条件，把缺口带回执（§8.3/GA17）。
   const check=this.acceptance?this.acceptance.checkGoalAccepted(run.goal_id,{root:snapshot.root||input.root||null}):null;
   const gaps=check?(check.gaps||[]).slice(0,5):[];
   const reason=check?(check.accepted?'任务全部完成且目标条件全部满足，进入目标验收（reconciling）'
    :`任务全部完成，但目标条件仍有 ${gaps.length} 项缺口：${gaps.map(x=>x.requirement).join('、')||'（没有验收条件：不自动通过）'}`)
    :'任务全部完成，进入目标验收（reconciling）；验收逻辑归 GF07';
   if(check?.accepted)return out(withStall({decision:'completed',report:{text:'目标验收已通过：所有目标条件都有当前有效证据。'},run:g.transition(run.id,'complete',{reason,phase:'reconciling',...gen()})}));
   return out(withStall({decision:'verify',report:{text:reason+'。请在目标心流中查看验收缺口、提交证据并核对；尚未验收完成。'},acceptance:check?{accepted:check.accepted,phase:check.phase,gaps,
    summary:{criteria:check.criteria.length,satisfied:check.criteria.filter(c=>c.state==='satisfied').length,invalidated:check.invalidated.length}}:null,
    run:g.transition(run.id,'pause',{reason,phase:'reconciling',origin:'reconciling',...gen()})}));
  }
  // ⑬ GF06 有界纠偏第 3 档且没有独立任务：不再硬推，留下阻塞报告（不改授权、不自动完成任何条件）。
  if(stall&&stall.action==='report'){
   const report=this.stall.blockedReport({goalId:run.goal_id,taskId:currentTask?.id??null,taskSeq:currentTask?.seq??null,
    taskTitle:currentTask?.title||'',reason:stall.window?.reason||'',retries:stall.retries,
    progress:this.evidence?this.evidence.progress(run.id):null});
   return out(withStall({decision:'paused',report,run:g.transition(run.id,'pause',{reason:report.text,origin:'stalled',...gen()})}));
  }
  // ⑭ 默认续跑：授权有效（run running）+ 预算余 + 下一步存在 → 继续（§5.1）。纠偏指令随文字下发。
  g.consume(run.id,{calls:1});
  run=this.activeRun(sessionId);
  const current=todos.find(t=>t.status==='doing'&&t.owner===sessionId);
  const pick=stall&&stall.action==='switch'?stall.independent[0]:null;
  // GF08：没有当前任务时由计划层给出合法候选（assist 只建议；autonomous 才可代执行认领手续）。
  const selection=!current&&this.plan&&run?this.plan.select(run,{projectId:g.goalRow(run.goal_id).project_id,sessionId,snapshot}):null;
  const guidance=stall&&stall.directive?`\n${stall.directive}`:'';
  const text=pick
   ?`任务 #${current?.seq??'?'}「${current?.title||'当前项'}」${stall.kind==='blocked'?'受阻':'连续无进展，已标记待处理'}：改做独立任务 #${pick.seq}「${pick.title}」（依赖已满足、无人持有）。认领仍走 TaskAction start；完成后回到原任务核对是否解除。${guidance}`
   :(current
    ?`继续目标运行中的任务 #${current.seq}「${current.title}」。先核对当前状态；有实际进展用 progress 提交；完成以证据 complete/advance；受阻则 block。普通收尾语句不解除目标运行。${guidance}`
    :(selection
     ?`${selection.action==='claim'?`合法候选 #${selection.candidate.seq}「${selection.candidate.title}」可由本会话认领（autonomous）。`
      :selection.action==='suggest'?`建议下一项 #${selection.candidate.seq}「${selection.candidate.title}」：${selection.reason}`
      :selection.action==='plan'?'目标没有任务清单：先规划（planning）。'
      :`没有可认领的合法候选：${selection.reason}`}认领仍走 TaskAction start；不要把 pending 直接完成。${guidance}`
     :`目标运行仍有待办。GetProject 核对后显式 start 下一项任务；不要把 pending 直接完成。${guidance}`));
  // 新窗口：这一轮有机会产出结果，收尾时按同一口径结算（GA04/GA05）。
  if(this.stall&&run)this.stall.openWindow(run,{taskId:pick?.taskId??current?.id??null,sessionId});
  return out(withStall({decision:'continue',run,text,
   ...(selection?{selection:{action:selection.action,taskId:selection.taskId??null,reason:selection.reason,candidates:selection.candidates,advisory:selection.advisory||null}}:{})}));
 }
}
module.exports={GoalScheduler};
