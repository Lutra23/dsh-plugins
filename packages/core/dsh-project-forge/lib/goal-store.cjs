'use strict';
// GF01（主文档 §4）：目标 / 运行 / 授权 / 验收条件 / 计划版本 / 观察 / 决策 / 检查点主记录。
// 设计约束的落地点：
//  * 单一目标主记录 —— 同工程最多一条未终态 goal（draft/active），终态后可另建，历史全留。
//  * 预算按 run 持久累计 —— pause/resume/stop 内部转换不清零 consumed；goal 级聚合防"换 run 绕限"。
//  * 目标 / 计划分别版本化 —— pf_goal_plan_versions 以 kind=goal|plan 双轨计数，修订前先存旧版。
//  * 旧表不动 —— 只 CREATE TABLE IF NOT EXISTS 新表，不 ALTER 任何既有表。
//  * 重启不重放 —— 构造期把 running/waiting 的 run 置 paused/reconciling 并换 generation，
//    旧 generation 的迟到状态转换被 expectedGeneration 乐观锁拒绝。
const {randomUUID,createHash}=require('node:crypto');
const OP=require('./operations.cjs');
const fail=(message,code='GOAL_POLICY')=>{throw Object.assign(new Error(message),{code});};
const now=()=>new Date().toISOString();
const stableId=(kind,content)=>kind+'-'+createHash('sha256').update(String(content)).digest('hex').slice(0,12);
const parse=(v,fb)=>{try{return typeof v==='string'?JSON.parse(v):v??fb;}catch{return fb;}};
// §4：第一版预算档位。长任务档位仅在用户明确要求持续施工时由授权启用。
const BUDGET_PRESETS={short:{maxMinutes:20,maxSteps:40,maxCalls:200},long:{maxMinutes:120,maxSteps:200,maxCalls:1000}};
const RUN_STATUSES=['draft','running','waiting','paused','stopped','completed'];
const RUN_PHASES=['planning','executing','verifying','reconciling','responding'];
const GOAL_TERMINAL=['completed','stopped','superseded'];
const MERGE=(a,b)=>{const out={...parse(a,{})};for(const [k,v] of Object.entries(b)){if(typeof v==='number'&&Number.isFinite(v))out[k]=(Number(out[k])||0)+v;else out[k]=v;}return out;};

class GoalStore {
 constructor(store){
  this.store=store;this.db=store.db;this.tasks=store.tasks;
  this.db.exec(`CREATE TABLE IF NOT EXISTS pf_goals(
    id TEXT PRIMARY KEY,project_id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,objective TEXT NOT NULL,scope TEXT NOT NULL DEFAULT '',
    constraints TEXT NOT NULL DEFAULT '',source_refs TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS pf_goals_project ON pf_goals(project_id);
   CREATE TABLE IF NOT EXISTS pf_goal_criteria(
    id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES pf_goals(id) ON DELETE CASCADE,
    requirement TEXT NOT NULL,category TEXT NOT NULL DEFAULT 'semantic',
    checks TEXT NOT NULL DEFAULT '[]',evidence TEXT NOT NULL DEFAULT 'null',
    status TEXT NOT NULL DEFAULT 'pending',position INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS pf_goal_authorizations(
    id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES pf_goals(id) ON DELETE CASCADE,
    run_id TEXT,source TEXT NOT NULL,allowed TEXT NOT NULL DEFAULT '{}',
    budgets TEXT NOT NULL DEFAULT '{}',allow_capacity_recovery INTEGER NOT NULL DEFAULT 0,
    allow_restart_recovery INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS pf_goal_runs(
    id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES pf_goals(id) ON DELETE CASCADE,
    goal_revision INTEGER NOT NULL,mode TEXT NOT NULL DEFAULT 'observe',
    executor_session_id TEXT,generation TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'running',
    phase TEXT NOT NULL DEFAULT 'planning',pause_reason TEXT NOT NULL DEFAULT '',
    authorization_id TEXT NOT NULL,budgets TEXT NOT NULL DEFAULT '{}',
    consumed TEXT NOT NULL DEFAULT '{}',started_at TEXT NOT NULL,next_wake_at INTEGER,
    updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS pf_goal_runs_goal ON pf_goal_runs(goal_id);
   CREATE TABLE IF NOT EXISTS pf_goal_plan_versions(
    id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES pf_goals(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'plan',revision INTEGER NOT NULL,reason TEXT NOT NULL DEFAULT '',
    before TEXT NOT NULL DEFAULT 'null',after TEXT NOT NULL DEFAULT 'null',
    source_refs TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS pf_goal_observations(
    id TEXT PRIMARY KEY,run_id TEXT NOT NULL,task_id INTEGER,kind TEXT NOT NULL,
    source_ref TEXT NOT NULL DEFAULT '',before_digest TEXT NOT NULL DEFAULT '',
    after_digest TEXT NOT NULL DEFAULT '',finding TEXT NOT NULL DEFAULT '',
    observed_at TEXT NOT NULL,verification TEXT NOT NULL DEFAULT 'declared');
   CREATE TABLE IF NOT EXISTS pf_goal_decisions(
    id TEXT PRIMARY KEY,run_id TEXT NOT NULL,question_id TEXT NOT NULL,
    question_version TEXT NOT NULL DEFAULT '',state_fingerprint TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',model_version TEXT NOT NULL DEFAULT '',
    raw_answer TEXT NOT NULL DEFAULT '{}',usage TEXT NOT NULL DEFAULT '{}',
    adopted_rule TEXT NOT NULL DEFAULT '',discarded_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS pf_goal_checkpoints(
    id TEXT PRIMARY KEY,run_id TEXT NOT NULL,seq INTEGER NOT NULL,payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,UNIQUE(run_id,seq));
   CREATE TABLE IF NOT EXISTS pf_goal_task_links(
    goal_id TEXT NOT NULL REFERENCES pf_goals(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL,criterion_ids TEXT NOT NULL DEFAULT '[]',
    UNIQUE(goal_id,task_id));`);
  // GF03：观察表补列（去重键、失效状态、证据绑定、写时进展判定）。幂等 ALTER，不改既有列。
  for(const [name,ddl] of [['dedup_key',"TEXT NOT NULL DEFAULT ''"],['status',"TEXT NOT NULL DEFAULT 'active'"],
   ['binding',"TEXT NOT NULL DEFAULT '{}'"],['counts_progress',"INTEGER NOT NULL DEFAULT 0"]])
   if(!this.db.prepare('PRAGMA table_info(pf_goal_observations)').all().some(c=>c.name===name))
    this.db.exec(`ALTER TABLE pf_goal_observations ADD COLUMN ${name} ${ddl}`);
  this.db.exec('CREATE INDEX IF NOT EXISTS pf_goal_obs_dedup ON pf_goal_observations(dedup_key)');
  // GF05：暂停来源。user=显式停止/暂停（永不自动恢复）；interrupt=插话挡住自动动作（回答结束可恢复同一任务）；
  // 其余来源（capacity/error/ownership/budget/planning/reconciling/restart）都是代码裁决，不随插话结束而解除。
  if(!this.db.prepare('PRAGMA table_info(pf_goal_runs)').all().some(c=>c.name==='pause_origin'))
   this.db.exec("ALTER TABLE pf_goal_runs ADD COLUMN pause_origin TEXT NOT NULL DEFAULT ''");
  // 服务重启：运行中的 goal run 一律 paused/reconciling + 新 generation。
  // 不自动恢复、不重放写操作；旧 generation 的迟到提交被拒（§10.2）。
  this.db.prepare("UPDATE pf_goal_runs SET status='paused',phase='reconciling',pause_origin='restart',pause_reason='服务重启，等待核对后手动继续',generation=?,updated_at=? WHERE status IN ('running','waiting')").run(randomUUID(),now());
 }

 goalRow(id){return this.db.prepare('SELECT * FROM pf_goals WHERE id=?').get(id);}
 current(projectId){
  const rows=this.db.prepare('SELECT * FROM pf_goals WHERE project_id=? ORDER BY created_at').all(projectId);
  return rows.find(g=>!GOAL_TERMINAL.includes(g.status))||null;
 }
 get(projectId){
  const g=this.current(projectId);
  if(!g)return {projectId,goal:null};
  return {projectId,goal:this.decorate(g)};
 }
 decorate(g){
  const criteria=this.db.prepare('SELECT * FROM pf_goal_criteria WHERE goal_id=? ORDER BY position').all(g.id)
   .map(c=>({...c,checks:parse(c.checks,[]),evidence:parse(c.evidence,null)}));
  const runs=this.db.prepare('SELECT * FROM pf_goal_runs WHERE goal_id=? ORDER BY started_at').all(g.id).map(this.decorateRun,this);
  const consumed=runs.reduce((acc,r)=>MERGE(JSON.stringify(acc),parse(r.consumed,{})),{});
  const planRevision=this.db.prepare("SELECT MAX(revision) AS r FROM pf_goal_plan_versions WHERE goal_id=? AND kind='plan'").get(g.id).r||0;
  const links=this.db.prepare('SELECT * FROM pf_goal_task_links WHERE goal_id=?').all(g.id)
   .map(l=>({taskId:l.task_id,criterionIds:parse(l.criterion_ids,[])}));
  return {...g,sourceRefs:parse(g.source_refs,[]),criteria,runs,planRevision,links,consumedTotal:consumed};
 }
 decorateRun(r){return {...r,budgets:parse(r.budgets,{}),consumed:parse(r.consumed,{}),next_wake_at:r.next_wake_at??null};}

 define(projectId,spec){
  if(!projectId||!spec||!String(spec.title||'').trim()||!String(spec.objective||'').trim())
   fail('目标需要 projectId、title 与 objective');
  if(this.current(projectId))fail('该工程已有未完结目标；请先 revise 或停止当前目标');
  OP.dbWrite();
  const id='goal-'+createHash('sha256').update(projectId+'|'+now()+'|'+randomUUID()).digest('hex').slice(0,12);
  const t=now();
  const goal={id,project_id:projectId,revision:1,title:String(spec.title),objective:String(spec.objective),
   scope:String(spec.scope||''),constraints:String(spec.constraints||''),source_refs:JSON.stringify(spec.sourceRefs||[]),
   status:'draft',created_at:t,updated_at:t};
  this.db.prepare('INSERT INTO pf_goals VALUES(@id,@project_id,@revision,@title,@objective,@scope,@constraints,@source_refs,@status,@created_at,@updated_at)').run(goal);
  for(let i=0;i<(spec.criteria||[]).length;i++)this.upsertCriterion(id,spec.criteria[i],i);
  this.version(goal.id,'goal',1,'初始定义',null,this.snapshot(id));
  return this.decorate(this.goalRow(id));
 }
 upsertCriterion(goalId,c,position){
  const requirement=String(c.requirement||c.text||'').trim();
  if(!requirement)fail('验收条件需要 requirement 正文');
  const category=['machine','semantic','human'].includes(c.category)?c.category:'semantic';
 const checks=Array.isArray(c.checks)?c.checks:[];
 for(const chk of checks){const type=String(chk?.type||'');
  if(!['ref','digest','test'].includes(type))fail(`验收检查类型不被核验引擎认识：${type||'(空)'}；只认 ref/digest/test（goal-acceptance machineFor 白名单）`);}
 if(category==='machine'&&!checks.length)fail('machine 条件必须至少声明一个检查项（空检查表核验时不恒真）');
 const id=c.id||stableId('c',goalId+'|'+requirement+'|'+category);
  const existing=this.db.prepare('SELECT goal_id FROM pf_goal_criteria WHERE id=?').get(id);
  if(existing&&existing.goal_id!==goalId)fail('验收条件 ID 已属于其他目标，请换一个 ID');
  OP.dbWrite();
  this.db.prepare(`INSERT INTO pf_goal_criteria(id,goal_id,requirement,category,checks,evidence,status,position,updated_at)
   VALUES(?,?,?,?,?,?,'pending',?,?)
   ON CONFLICT(id) DO UPDATE SET checks=excluded.checks,position=excluded.position,updated_at=excluded.updated_at`)
   .run(id,goalId,requirement,category,JSON.stringify(checks),JSON.stringify(c.evidence??null),position,now());
  return id;
 }
 snapshot(goalId){
  const g=this.goalRow(goalId);
  const criteria=this.db.prepare('SELECT id,requirement,category,status FROM pf_goal_criteria WHERE goal_id=? ORDER BY position').all(goalId);
  const links=this.db.prepare('SELECT task_id,criterion_ids FROM pf_goal_task_links WHERE goal_id=?').all(goalId);
  return {title:g.title,objective:g.objective,scope:g.scope,constraints:g.constraints,status:g.status,criteria,links};
 }
 version(goalId,kind,revision,reason,before,after,sourceRefs){
  OP.dbWrite();
  this.db.prepare('INSERT INTO pf_goal_plan_versions(id,goal_id,kind,revision,reason,before,after,source_refs,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
   .run(randomUUID(),goalId,kind,revision,String(reason||''),JSON.stringify(before??null),JSON.stringify(after??null),JSON.stringify(sourceRefs||[]),now());
 }

 revise(goalId,expectedRevision,patch,reason,sourceRefs){
  const g=this.goalRow(goalId);if(!g)fail('目标不存在');
  if(g.revision!==Number(expectedRevision))fail(`目标修订冲突：当前 ${g.revision}`, 'REVISION_CONFLICT');
  if(GOAL_TERMINAL.includes(g.status))fail('目标已完结，不能修订');
  OP.dbWrite();
  const before=this.snapshot(goalId);
  const next={...g,title:patch.title??g.title,objective:patch.objective??g.objective,
   scope:patch.scope??g.scope,constraints:patch.constraints??g.constraints,
   source_refs:JSON.stringify(patch.sourceRefs??parse(g.source_refs,[])),
   revision:g.revision+1,updated_at:now()};
  if(patch.criteria){ // 全量替换语义：未出现在新清单的旧条件标记 superseded，新的 upsert。
   const keep=new Set();
   patch.criteria.forEach((c,i)=>{const id=this.upsertCriterion(goalId,c,i);keep.add(id);});
   this.db.prepare('SELECT id FROM pf_goal_criteria WHERE goal_id=?').all(goalId)
    .filter(c=>!keep.has(c.id)).forEach(c=>this.db.prepare("UPDATE pf_goal_criteria SET status='superseded',updated_at=? WHERE id=?").run(now(),c.id));
  }
  this.db.prepare('UPDATE pf_goals SET title=?,objective=?,scope=?,constraints=?,source_refs=?,revision=?,updated_at=? WHERE id=?')
   .run(next.title,next.objective,next.scope,next.constraints,next.source_refs,next.revision,next.updated_at,next.id);
  this.version(goalId,'goal',next.revision,reason,before,this.snapshot(goalId),sourceRefs);
  return this.decorate(this.goalRow(goalId));
 }
 revisePlan(goalId,reason,tasks,sourceRefs){
  const g=this.goalRow(goalId);if(!g)fail('目标不存在');
  if(GOAL_TERMINAL.includes(g.status))fail('目标已完结，不能调整计划');
  const projectId=g.project_id;
  const known=new Set((this.tasks?.list(projectId)||[]).map(t=>t.id));
  for(const link of tasks||[])if(!known.has(Number(link.taskId)))fail(`任务 ${link.taskId} 不属于该工程，不能挂入目标计划`);
  OP.dbWrite();
  const prev=this.db.prepare("SELECT MAX(revision) AS r FROM pf_goal_plan_versions WHERE goal_id=? AND kind='plan'").get(goalId).r||0;
  const before=this.db.prepare('SELECT task_id,criterion_ids FROM pf_goal_task_links WHERE goal_id=?').all(goalId);
  this.db.prepare('DELETE FROM pf_goal_task_links WHERE goal_id=?').run(goalId);
  for(const link of tasks||[])this.db.prepare('INSERT INTO pf_goal_task_links(goal_id,task_id,criterion_ids) VALUES(?,?,?)')
   .run(goalId,Number(link.taskId),JSON.stringify((link.criterionIds||[]).map(String)));
  this.version(goalId,'plan',prev+1,reason,before,tasks,sourceRefs);
  return {planRevision:prev+1};
 }

 // §4 RunAuthorization：模型输出和普通文档不能生成授权——入口只接受带 messageId 的真实用户来源。
 authorize(goalId,source,options={}){
  const g=this.goalRow(goalId);if(!g)fail('目标不存在');
  const s=source||{};
  if(s.kind!=='user'||!s.messageId)fail('授权只能来自真实用户消息（kind=user 且带 messageId）；模型输出与文档不构成授权');
  const budgets=require('./goal-budget.cjs').limits(options.budgets||{});
  OP.dbWrite();
  const id='auth-'+createHash('sha256').update(goalId+'|'+s.messageId+'|'+now()).digest('hex').slice(0,12);
  this.db.prepare('INSERT INTO pf_goal_authorizations(id,goal_id,source,allowed,budgets,allow_capacity_recovery,allow_restart_recovery,created_at) VALUES(?,?,?,?,?,?,?,?)')
   .run(id,goalId,JSON.stringify(s),JSON.stringify(options.allowed||{}),JSON.stringify(budgets),
    options.allowCapacityRecovery?1:0,options.allowRestartRecovery?1:0,now());
  return this.db.prepare('SELECT * FROM pf_goal_authorizations WHERE id=?').get(id);
 }
 runRow(id){return this.db.prepare('SELECT * FROM pf_goal_runs WHERE id=?').get(id);}
 startRun(goalId,{authorizationId,mode='observe',executorSessionId,budgets}){
  const g=this.goalRow(goalId);if(!g)fail('目标不存在');
  const auth=authorizationId?this.db.prepare('SELECT * FROM pf_goal_authorizations WHERE id=? AND goal_id=?').get(authorizationId,goalId):null;
  if(!auth)fail('运行需要有效授权记录（先 authorize）');
  if(!['observe','assist','autonomous'].includes(mode))fail('未知运行模式：'+mode);
  const active=this.db.prepare("SELECT id FROM pf_goal_runs WHERE goal_id=? AND (status IN ('running','waiting') OR (status='paused' AND pause_origin='interrupt'))").get(goalId);
  if(active)fail('该目标已有在途运行（含插话挂起）：'+active.id);
  const other=this.db.prepare("SELECT id FROM pf_goal_runs WHERE executor_session_id=? AND (status IN ('running','waiting') OR (status='paused' AND pause_origin='interrupt'))").get(executorSessionId||'');
  if(other)fail('该会话已有在途目标运行：'+other.id);
  budgets=require('./goal-budget.cjs').effective(parse(auth.budgets,{}),budgets||{});
  const cap=parse(auth.budgets,{});const spent=this.decorate(g).consumedTotal;
  for(const [capKey,spentKey] of [['maxSteps','steps'],['maxCalls','calls']])
   if(Number(cap[capKey])&&Number(spent[spentKey]||0)>=Number(cap[capKey]))
    fail(`目标累计预算已达上限（${capKey}=${cap[capKey]}），换新 run 不能绕过限制`);
  const first=this.db.prepare('SELECT MIN(started_at) AS at FROM pf_goal_runs WHERE goal_id=?').get(goalId).at;
  if(first&&Number(cap.maxMinutes)&&(Date.now()-Date.parse(first))/60000>=Number(cap.maxMinutes))
   fail('目标累计时限已达上限，换新 run 不能绕过限制');
  OP.dbWrite();
  const run={id:'run-'+createHash('sha256').update(goalId+'|'+now()+'|'+randomUUID()).digest('hex').slice(0,12),
   goal_id:goalId,goal_revision:g.revision,mode,executor_session_id:executorSessionId||null,
   generation:randomUUID(),status:'running',phase:'planning',pause_reason:'',authorization_id:authorizationId,
   budgets:JSON.stringify(budgets||{}),consumed:'{}',started_at:now(),next_wake_at:null,updated_at:now()};
  this.db.prepare(`INSERT INTO pf_goal_runs(id,goal_id,goal_revision,mode,executor_session_id,generation,status,phase,pause_reason,authorization_id,budgets,consumed,started_at,next_wake_at,updated_at)
   VALUES(@id,@goal_id,@goal_revision,@mode,@executor_session_id,@generation,@status,@phase,@pause_reason,@authorization_id,@budgets,@consumed,@started_at,@next_wake_at,@updated_at)`).run(run);
  this.db.prepare('UPDATE pf_goal_authorizations SET run_id=? WHERE id=?').run(run.id,authorizationId);
  return this.decorateRun(this.runRow(run.id));
 }
 transition(runId,action,{reason,expectedGeneration,nextWakeAt,phase,origin}={}){
  const r=this.runRow(runId);if(!r)fail('运行不存在');
  if(expectedGeneration&&expectedGeneration!==r.generation)fail('运行代际已失效（状态已变化或服务重启），请重读后再操作','STALE_GENERATION');
  const status=action==='pause'?'paused':action==='wait'?'waiting':action==='resume'?'running':action==='stop'?'stopped':action==='complete'?'completed':null;
  if(!status||!RUN_STATUSES.includes(status))fail('未知运行动作：'+action);
  if(action==='pause'&&r.status!=='running'&&r.status!=='waiting')fail('只有运行/等待中的 run 可暂停');
  if(action==='wait'&&r.status!=='running')fail('只有运行中的 run 可登记等待');
  if(action==='resume'&&r.status!=='paused'&&r.status!=='waiting')fail('只有暂停/等待中的 run 可恢复');
  if(action==='resume'&&r.pause_reason==='服务重启，等待核对后手动继续'&&!reason)fail('重启后的恢复需要核对说明（reason）');
  if((action==='stop'||action==='complete')&&GOAL_TERMINAL.includes(r.status))fail('运行已终结');
  OP.dbWrite();
  const gen=['stop','complete'].includes(action)?randomUUID():r.generation;
  // GF05：只有明确传 interrupt 的暂停才是“插话挂起”；默认 user，绝不因为没写来源而被当成可自动恢复。
  const pauseOrigin=['pause','stop'].includes(action)?String(origin||'user'):(action==='resume'?'':r.pause_origin);
  const next={...r,status,generation:gen,pause_origin:pauseOrigin,
   pause_reason:action==='pause'||action==='stop'?String(reason||''):'',
   next_wake_at:action==='wait'?(nextWakeAt??null):r.next_wake_at,phase:phase||r.phase,updated_at:now()};
  this.db.prepare('UPDATE pf_goal_runs SET status=?,generation=?,pause_reason=?,pause_origin=?,next_wake_at=?,phase=?,updated_at=? WHERE id=?')
   .run(next.status,next.generation,next.pause_reason,next.pause_origin,next.next_wake_at,next.phase,next.updated_at,next.id);
  if(action==='complete')this.db.prepare("UPDATE pf_goals SET status='completed',updated_at=? WHERE id=?").run(now(),r.goal_id);
  if(action==='stop')this.db.prepare("UPDATE pf_goals SET status='active',updated_at=? WHERE id=?").run(now(),r.goal_id);
  return this.decorateRun(this.runRow(runId));
 }
 consume(runId,delta){
  const r=this.runRow(runId);if(!r)fail('运行不存在');
  if(r.status!=='running'&&r.status!=='waiting')fail('只有运行/等待中的 run 累计预算消耗（当前 '+r.status+'）');
  const merged=MERGE(r.consumed,delta||{});
  OP.dbWrite();
  this.db.prepare('UPDATE pf_goal_runs SET consumed=?,updated_at=? WHERE id=?').run(JSON.stringify(merged),now(),runId);
  return this.decorateRun(this.runRow(runId));
 }
 observe(runId,{taskId,kind,sourceRef,beforeDigest,afterDigest,finding,verification,dedupKey,binding,countsProgress,status}){
  if(!runId||!kind||!String(finding||'').trim())fail('观察需要 runId、kind 与 finding');
  OP.dbWrite();
  const id='obs-'+createHash('sha256').update(runId+'|'+kind+'|'+finding+'|'+now()).digest('hex').slice(0,12);
  // GF03：事实与声明分开——verified（有可核对引用）/ declared（仅自述）/ unreconciled（回执未核对）。
  const level=['verified','declared','unreconciled'].includes(verification)?verification:'declared';
  this.db.prepare(`INSERT INTO pf_goal_observations(id,run_id,task_id,kind,source_ref,before_digest,after_digest,finding,observed_at,verification,dedup_key,status,binding,counts_progress)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
   .run(id,runId,taskId??null,kind,String(sourceRef||''),String(beforeDigest||''),String(afterDigest||''),String(finding),now(),
    level,String(dedupKey||''),String(status||'active'),typeof binding==='string'?binding:JSON.stringify(binding||{}),countsProgress?1:0);
  return id;
 }
 decide(runId,{questionId,questionVersion,stateFingerprint,provider,modelVersion,rawAnswer,usage,adoptedRule,discardedReason}){
  if(!runId||!questionId)fail('决策记录需要 runId 与 questionId');
  OP.dbWrite();
  const id='dec-'+createHash('sha256').update(runId+'|'+questionId+'|'+now()).digest('hex').slice(0,12);
  this.db.prepare(`INSERT INTO pf_goal_decisions(id,run_id,question_id,question_version,state_fingerprint,provider,
   model_version,raw_answer,usage,adopted_rule,discarded_reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
   .run(id,runId,String(questionId),String(questionVersion||''),String(stateFingerprint||''),String(provider||''),
    String(modelVersion||''),JSON.stringify(rawAnswer??{}),JSON.stringify(usage??{}),String(adoptedRule||''),String(discardedReason||''),now());
  return id;
 }
 checkpoint(runId,payload){
  const r=this.runRow(runId);if(!r)fail('运行不存在');
  OP.dbWrite();
  const seq=(this.db.prepare('SELECT MAX(seq) AS s FROM pf_goal_checkpoints WHERE run_id=?').get(runId).s||0)+1;
  const id='ck-'+createHash('sha256').update(runId+'|'+seq+'|'+now()).digest('hex').slice(0,12);
  this.db.prepare('INSERT INTO pf_goal_checkpoints VALUES(?,?,?,?,?)').run(id,runId,seq,JSON.stringify(payload??{}),now());
  return {id,seq};
 }
}
module.exports={GoalStore,BUDGET_PRESETS,RUN_STATUSES,RUN_PHASES};
