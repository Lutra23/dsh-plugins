'use strict';
// GF10（§9 末句 + §10.1 + §11 能力位）：压缩接口兼容与容量恢复。
// ── 铁律 ──────────────────────────────────────────────────────────────
//  * 第一阶段保持旧策略：能力握手未通过前，autoResumeAfterCompaction 必须视为 false（实际约束，不是注释）。
//  * 能力位只发布真正可用的能力：压缩侧没暴露握手就不发 capacityResume:1。
//  * 恢复同一 run 需要同时成立：暂停原因是 capacity、压缩事务已提交、容量复测可靠、
//    原 run/goal/执行权未变、期间无用户暂停/停止、预算仍充足。缺任一条件就保持暂停并给原因。
//  * 压缩成功不能恢复用户手动暂停；不能静默改全局压缩策略；摘要不构成新授权、不清零预算或停滞计数。
//  * 保护面（目标/授权/任务焦点/未结束工具/证据引用/待核对回执）必须受保护或能从主记录重建。
const fail=(message,code='CAPACITY_POLICY')=>{throw Object.assign(new Error(message),{code});};
const parse=(v,fb)=>{try{return typeof v==='string'?JSON.parse(v):v??fb;}catch{return fb;}};
// 压缩侧握手要求的字段与语义（不认识的一律当未知，不猜）。
const HANDSHAKE_FIELDS={version:'接口版本',snapshotShape:'快照结构标识',protection:'是否声明受保护字段',
 transaction:'是否提供压缩事务状态（committed/pending/aborted）',measure:'容量复测是否可用',detached:'是否声明不改写会话表面之外的状态'};
const PROTECTED=[['goal','目标定义与修订'],['authorization','运行授权与范围'],['taskFocus','任务焦点与激活'],
 ['openTools','未结束工具调用'],['evidence','证据引用与摘要'],['receipts','待核对回执与在途操作']];
class GoalCapacity {
 constructor({goalStore,relay=null}={}){
  if(!goalStore||!goalStore.db)fail('GoalCapacity 需要已构造的 GoalStore','CAPACITY_CONFIG');
  this.goals=goalStore;this.db=goalStore.db;this.relay=relay;
  this.db.exec(`CREATE TABLE IF NOT EXISTS pf_goal_capacity(
    id TEXT PRIMARY KEY,goal_id TEXT NOT NULL DEFAULT '',run_id TEXT NOT NULL DEFAULT '',kind TEXT NOT NULL DEFAULT 'handshake',
    provider TEXT NOT NULL DEFAULT '',version TEXT NOT NULL DEFAULT '',supported INTEGER NOT NULL DEFAULT 0,
    fields TEXT NOT NULL DEFAULT '{}',reasons TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL);`);
 }
 // ── 能力握手（不认识就不认账）────────────────────────────────────────
 handshake(provider,{version='',snapshotShape='',protection=false,transaction=null,measure=false,detached=false}={}){
  const reasons=[],fields={version:String(version||''),snapshotShape:String(snapshotShape||''),
   protection:!!protection,transaction:transaction?String(transaction):'',measure:!!measure,detached:!!detached};
  if(!fields.version)reasons.push('没有提供接口版本');
  if(!fields.snapshotShape)reasons.push('没有提供快照结构标识');
  if(!fields.protection)reasons.push('没有声明受保护字段');
  if(!fields.transaction)reasons.push('没有提供压缩事务状态');
  if(!fields.measure)reasons.push('没有提供容量复测能力');
  if(!fields.detached)reasons.push('没有声明不改写会话表面之外的状态');
  const supported=reasons.length===0;
  this.record({kind:'handshake',provider:String(provider||''),version:fields.version,supported,fields,reasons});
  return {provider:String(provider||''),supported,fields,reasons,
   resumePolicy:'autoResumeAfterCompaction',
   effective:supported?{canConsiderResume:true,note:'握手通过只代表可以进入恢复判定，不代表可以恢复'}
    :{canConsiderResume:false,autoResumeAfterCompaction:false,
      note:'第一阶段实际约束：未通过握手前等于关闭（沿用现有容量保护与手动恢复）'},
   requiredFields:Object.keys(HANDSHAKE_FIELDS)};
 }
 // ── 保护面：声明哪些必须受保护或可重建 ────────────────────────────────
 protection(goalId=null){
  const goal=goalId?this.goals.goalRow(goalId):null;
  const run=goal?this.db.prepare("SELECT * FROM pf_goal_runs WHERE goal_id=? ORDER BY started_at DESC").get(goalId):null;
  const items=PROTECTED.map(([key,label])=>{
   if(key==='goal')return {key,label,present:!!goal,rebuildable:true,source:'pf_goals+pf_goal_criteria'};
   if(key==='authorization')return {key,label,present:!!(run&&run.authorization_id),rebuildable:false,source:'pf_goal_authorizations（不能由摘要重建）'};
   if(key==='taskFocus')return {key,label,present:!!goal,rebuildable:true,source:'pf_goal_task_links+焦点版本'};
   if(key==='openTools')return {key,label,present:true,rebuildable:false,source:'pf_operations（在途操作必须核对，不能重放）'};
   if(key==='evidence')return {key,label,present:!!goal,rebuildable:true,source:'pf_goal_observations+pf_goal_verifications'};
   return {key,label,present:true,rebuildable:false,source:'pf_task_receipts+journal 回执'};
  });
  return {goalId:goalId||null,runId:run?.id??null,items,
   missing:items.filter(i=>!i.present&&!i.rebuildable).map(i=>i.label),
   note:'摘要不构成新授权，也不清零预算或停滞计数；受保护项缺失时必须先核对主记录'};
 }
 // ── 容量恢复协定（§10.1 六条件）──────────────────────────────────────
 eligible(run,{compaction=null,measure=null,stoppedByUser=false}={}){
  if(!run)fail('容量恢复判定需要目标运行');
  const blockers=[],facts={};
  facts.pauseReason=String(run.pause_reason||'');
  facts.pauseOrigin=String(run.pause_origin||'');
  // ① 暂停原因必须是 capacity（用户暂停/停止一律不恢复，压缩成功也不行）
  if(facts.pauseOrigin!=='capacity'&&!/capacity|容量/.test(facts.pauseReason))blockers.push('暂停原因不是容量：压缩成功不能恢复用户暂停或其它来源');
  if(stoppedByUser)blockers.push('期间有用户暂停/停止：不因压缩成功恢复');
  // ② 压缩事务必须已提交（pending/aborted/unknown 都不行）
  const state=compaction&&typeof compaction==='object'?String(compaction.state||''):'';
  facts.compaction=state||'unknown';
  if(state!=='committed')blockers.push(state?`压缩事务状态 ${state}：只有 committed 才考虑恢复`:'没有压缩事务回执：不知道压缩是否成功');
  // ③ 容量复测必须可靠
  const measured=measure&&typeof measure==='object'?measure:null;
  facts.measure=measured?{reliable:!!measured.reliable,value:measured.value??null,source:String(measured.source||'')}:'unknown';
  if(!measured)blockers.push('没有容量复测结果：不凭“压缩成功”恢复');
  else if(!measured.reliable)blockers.push(`容量复测不可靠${measured.source?`（来源 ${measured.source}）`:''}`);
  // ④ 原 run/goal/执行权未变
  const current=this.db.prepare('SELECT * FROM pf_goal_runs WHERE id=?').get(run.id);
  if(!current)blockers.push('运行记录已不存在');
  else{
   facts.generation={before:String(run.generation||''),now:String(current.generation||'')};
   facts.executor={before:String(run.executor_session_id||''),now:String(current.executor_session_id||'')};
   if(facts.generation.before!==facts.generation.now)blockers.push('代际已变化：原运行身份变了（可能已接力/重启）');
   if(facts.executor.before!==facts.executor.now)blockers.push('执行权已转移：不是同一个执行会话');
   if(String(current.goal_id)!==String(run.goal_id))blockers.push('目标已变化');
  }
  // ⑤ 授权仍有效且允许容量恢复
  const auth=this.db.prepare('SELECT * FROM pf_goal_authorizations WHERE id=?').get(String(run.authorization_id||''));
  const source=parse(auth?.source,{});
  facts.authorization=auth?{kind:String(source.kind||''),allowCapacityRecovery:!!auth.allow_capacity_recovery}:null;
  if(!auth)blockers.push('没有授权记录');
  else if(source.kind!=='user')blockers.push('授权来源不是真实用户');
  else if(!auth.allow_capacity_recovery)blockers.push('授权未允许容量恢复（allowCapacityRecovery 未启用）');
  // ⑥ 预算仍充足 + 在途写操作必须已核对
  const budgets=parse(run.budgets,{}),consumed=parse(run.consumed,{});
  const left=budgets.maxCalls!=null?Number(budgets.maxCalls)-Number(consumed.calls||0):null;
  facts.budget={left,consumed:consumed.calls??0};
  if(left!=null&&left<=0)blockers.push('预算已耗尽');
  const uncertain=this.relay&&typeof this.relay.uncertain==='function'?this.relay.uncertain():[];
  facts.uncertainWrites=uncertain.length;
  if(uncertain.length)blockers.push(`有 ${uncertain.length} 笔在途写操作结果不确定：先核对回执`);
  return {runId:run.id,goalId:run.goal_id,eligible:blockers.length===0,blockers,facts,
   decision:blockers.length===0?'resume-same-run':'stay-paused'};
 }
 // 恢复：只在协定全绿时把同一 run 放回 running；不改代际、不清零计数、不重放写操作。
 resume(run,{by='',reason='',compaction=null,measure=null,stoppedByUser=false}={}){
  const view=this.eligible(run,{compaction,measure,stoppedByUser});
  this.record({kind:'resume-check',goalId:run.goal_id,runId:run.id,provider:'',version:'',
   supported:view.eligible,fields:view.facts,reasons:view.blockers});
  if(!view.eligible)fail(`不能恢复：${view.blockers.join('；')}`);
  if(!String(by||'').trim())fail('恢复必须署名：谁恢复的要能查');
  if(!String(reason||'').trim())fail('恢复必须写明原因');
  this.db.prepare("UPDATE pf_goal_runs SET status='running',phase=?,pause_reason='',pause_origin='',updated_at=? WHERE id=?")
   .run('executing',new Date().toISOString(),run.id);
  return {resumed:true,runId:run.id,goalId:run.goal_id,by,generation:String(run.generation||''),
   note:'恢复同一 run 与同一代际：预算、停滞计数与授权范围都没有被摘要改写'};
 }
 record({kind='',goalId='',runId='',provider='',version='',supported=false,fields={},reasons=[]}){
  this.db.prepare(`INSERT INTO pf_goal_capacity(id,goal_id,run_id,kind,provider,version,supported,fields,reasons,created_at)
   VALUES(?,?,?,?,?,?,?,?,?,?)`).run(`cap-${Math.random().toString(36).slice(2,12)}`,String(goalId||''),String(runId||''),
   kind,String(provider||''),String(version||''),supported?1:0,JSON.stringify(fields||{}),JSON.stringify(reasons||[]),new Date().toISOString());
  return this;
 }
 state({goalId=null,limit=20}={}){
  const rows=goalId?this.db.prepare('SELECT * FROM pf_goal_capacity WHERE goal_id=? ORDER BY created_at DESC LIMIT ?').all(goalId,limit)
   :this.db.prepare('SELECT * FROM pf_goal_capacity ORDER BY created_at DESC LIMIT ?').all(limit);
  return rows.map(r=>({id:r.id,kind:r.kind,provider:r.provider,version:r.version,supported:!!r.supported,
   fields:parse(r.fields,{}),reasons:parse(r.reasons,[]),runId:r.run_id||null,createdAt:r.created_at}));
 }
}
module.exports={GoalCapacity,HANDSHAKE_FIELDS,PROTECTED};
