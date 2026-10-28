'use strict';
// GF05（主文档 §9）：插话期间的双焦点、边界版本与迟到召回隔离。
// 铁律：
//  * 双焦点分开保存：taskFocus(projectId,taskId,activationId) 与 userFocus(messageId)；
//    插话期间 effectiveFocus 切到 user，任务身份、activation 与缓存原样保留。
//  * 恢复同一任务 ≠ 重新认领：restoreTask 只改焦点行，绝不调用任务 start/resume，也不产生新 activation。
//  * 新 activation 只由新任务、真实交接、目标变更产生；普通进展、定时同步、心跳、压缩都不产生。
//  * 召回结果按请求时的焦点版本回填：版本不匹配、或当前可见焦点不是它 → 只进各自缓存，不覆盖可见焦点。
//  * 可见记忆上下文有上限（条数 + 字符数）：不把两份完整召回无限叠加。
//  * 用户插话焦点必须有真实 messageId：模型输出、工具事件与镜像同步都不构成插话。
const {createHash}=require('node:crypto');
const now=()=>new Date().toISOString();
const fail=(message,code='FOCUS_POLICY')=>{throw Object.assign(new Error(message),{code});};

// §9 记忆边界：只有这三类事件开启新 activation。
const ACTIVATION_KINDS=['new-task','handoff','goal-change'];
const NON_ACTIVATION_KINDS=['progress','sync','heartbeat','compaction','reminder','reread','replan','declaration','summary','interruption'];
const FOCUS_KINDS=['task','user'];
const MEMO_CAPABILITY={dual:'dual-focus',single:'single-focus',unknown:'unknown'};
const DEFAULTS={visibleLimit:3,visibleChars:1200};

class GoalFocus{
 constructor(goalStore,{clock=now,visibleLimit=DEFAULTS.visibleLimit,visibleChars=DEFAULTS.visibleChars}={}){
  if(!goalStore||!goalStore.db)fail('GoalFocus 需要已构造的 GoalStore','FOCUS_CONFIG');
  this.goals=goalStore;this.db=goalStore.db;this.clock=clock;
  this.visibleLimit=visibleLimit;this.visibleChars=visibleChars;
  this.db.exec(`CREATE TABLE IF NOT EXISTS pf_goal_focus(
    owner TEXT PRIMARY KEY,project_id TEXT NOT NULL DEFAULT '',goal_id TEXT NOT NULL DEFAULT '',run_id TEXT NOT NULL DEFAULT '',
    task_id INTEGER,activation_id TEXT NOT NULL DEFAULT '',task_revision INTEGER NOT NULL DEFAULT 0,
    task_focus_version INTEGER NOT NULL DEFAULT 1,user_message_id TEXT NOT NULL DEFAULT '',user_focus_version INTEGER NOT NULL DEFAULT 0,
    effective TEXT NOT NULL DEFAULT 'task',interrupted_at TEXT NOT NULL DEFAULT '',restored_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS pf_goal_focus_goal ON pf_goal_focus(goal_id);
   CREATE TABLE IF NOT EXISTS pf_goal_recall(
    id INTEGER PRIMARY KEY,owner TEXT NOT NULL,focus_kind TEXT NOT NULL,focus_version INTEGER NOT NULL,
    cache_key TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'visible',summary TEXT NOT NULL DEFAULT '',
    truncated INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS pf_goal_recall_owner ON pf_goal_recall(owner,state,id);`);
  // GF05：宿主在拿不到真实消息 id 时会给一个合成边界键——合成键只能定位边界，不能当作“用户决定”的来源。
  if(!this.db.prepare('PRAGMA table_info(pf_goal_focus)').all().some(c=>c.name==='user_focus_synthetic'))
   this.db.exec('ALTER TABLE pf_goal_focus ADD COLUMN user_focus_synthetic INTEGER NOT NULL DEFAULT 0');
 }

 // ── 焦点行 ────────────────────────────────────────────────────────────────
 ensure(owner,{projectId='',goalId='',runId=''}={}){
  if(!owner)fail('焦点需要 owner（执行会话）');
  this.db.prepare(`INSERT OR IGNORE INTO pf_goal_focus(owner,project_id,goal_id,run_id,task_id,activation_id,
    task_revision,task_focus_version,user_message_id,user_focus_version,effective,interrupted_at,restored_at,updated_at)
   VALUES(?,?,?,?,NULL,'',0,1,'',0,'task','','',?)`).run(owner,String(projectId||''),String(goalId||''),String(runId||''),this.clock());
  const r=this.row(owner);
  // 同一目标换 run 只是记账；目标/工程变化必须先走 claimTask(kind='goal-change')，不在 ensure 里悄悄重置焦点。
  if(goalId&&r.goal_id&&r.goal_id!==goalId)
   fail(`执行会话已持有目标 ${r.goal_id} 的焦点：目标变更需要显式 claimTask(goal-change)`,'FOCUS_GOAL_CONFLICT');
  if(projectId&&r.project_id&&r.project_id!==projectId)
   fail(`执行会话已持有工程 ${r.project_id} 的焦点：跨工程插话不能复用焦点行`,'FOCUS_PROJECT_CONFLICT');
  if(String(r.project_id)!==String(projectId||r.project_id)||String(r.goal_id)!==String(goalId||r.goal_id)||String(r.run_id)!==String(runId||r.run_id))
   this.db.prepare('UPDATE pf_goal_focus SET project_id=?,goal_id=?,run_id=?,updated_at=? WHERE owner=?')
    .run(String(projectId||r.project_id),String(goalId||r.goal_id),String(runId||r.run_id),this.clock(),owner);
  return this.row(owner);
 }
 row(owner){return this.db.prepare('SELECT * FROM pf_goal_focus WHERE owner=?').get(owner)||null;}
 version(owner,kind='task'){
  if(!FOCUS_KINDS.includes(kind))fail('未知焦点类型：'+kind);
  const r=this.row(owner);if(!r)return 0;
  return kind==='task'?Number(r.task_focus_version):Number(r.user_focus_version);
 }
 taskFocus(owner){
  const r=this.row(owner);if(!r||!r.task_id)return null;
  return {projectId:r.project_id,goalId:r.goal_id,runId:r.run_id,taskId:Number(r.task_id),
   activationId:r.activation_id||null,revision:Number(r.task_revision),version:Number(r.task_focus_version)};
 }
 userFocus(owner){
  const r=this.row(owner);if(!r||!r.user_message_id)return null;
  return {messageId:r.user_message_id,version:Number(r.user_focus_version)};
 }
 effectiveFocus(owner){const r=this.row(owner);return r?r.effective:null;}
 // §9：插话期间可以切到 userFocus，任务身份与缓存保留。
 interrupted(owner){const r=this.row(owner);return !!(r&&r.interrupted_at);}

 // ── 边界：activation 只在真实事件上换代 ──────────────────────────────────
 claimTask(owner,{projectId,goalId,runId,taskId,activationId=null,taskRevision=0,kind='new-task',reason=''}={}){
  if(!ACTIVATION_KINDS.includes(kind)&&!NON_ACTIVATION_KINDS.includes(kind))fail('未知记忆边界类型：'+kind,'FOCUS_KIND');
  if(!taskId)fail('任务焦点需要 taskId（不按标题猜关联）');
  const r=this.ensure(owner,{projectId,goalId,runId});
  const boundary=ACTIVATION_KINDS.includes(kind);
  const sameTask=Number(r.task_id)===Number(taskId);
  const first=!r.activation_id;
  // 非边界事件沿用原 activation（普通进展/同步/心跳/压缩都不开启新记忆边界）。
  const nextActivation=boundary?(activationId||this.newActivation(projectId,goalId,taskId,kind))
   :(r.activation_id||activationId||this.newActivation(projectId,goalId,taskId,kind));
  const identityChanged=!sameTask||nextActivation!==r.activation_id;
  const version=identityChanged?Number(r.task_focus_version)+1:Number(r.task_focus_version);
  this.db.prepare(`UPDATE pf_goal_focus SET project_id=?,goal_id=?,run_id=?,task_id=?,activation_id=?,task_revision=?,
    task_focus_version=?,effective='task',interrupted_at='',restored_at='',updated_at=? WHERE owner=?`)
   .run(String(projectId||r.project_id),String(goalId||r.goal_id),String(runId||r.run_id),Number(taskId),nextActivation,
    Number(taskRevision||0),version,this.clock(),owner);
  return {owner,taskId:Number(taskId),activationId:nextActivation,newActivation:boundary,firstEstablishment:!boundary&&first,
   activationKind:kind,identityChanged,taskFocusVersion:version,cacheInvalidated:identityChanged,reclaimed:false,
   reason:reason||(boundary?`${kind} 开启新的记忆边界`:'同一任务：沿用原 activation，不新建边界')};
 }
 newActivation(projectId,goalId,taskId,kind){
  return 'act-'+createHash('sha256').update([projectId,goalId,taskId,kind,this.clock()].join('|')).digest('hex').slice(0,12);
 }

 // ── 用户插话焦点 ──────────────────────────────────────────────────────────
 onUserMessage(owner,{messageId,projectId,goalId,runId,lifecycle=null,relation=null,synthetic=false}={}){
  // §4/§9：没有 messageId 的“用户消息”不成立——模型输出、工具事件、镜像同步都不能伪装成用户插话。
  if(!messageId)fail('用户插话焦点需要真实用户消息（messageId）；模型输出或工具事件不构成插话','NOT_USER_MESSAGE');
  const r=this.ensure(owner,{projectId,goalId,runId});
  if(r.user_message_id===String(messageId)&&r.interrupted_at)
   return {...this.boundary(owner),deduped:true,lifecycle:lifecycle||null,relation:relation||null};
  // synthetic=true 表示这只是宿主合成的边界键：能定位边界，但不算“真实用户决定”的来源。
  this.db.prepare(`UPDATE pf_goal_focus SET user_message_id=?,user_focus_synthetic=?,user_focus_version=user_focus_version+1,
    effective='user',interrupted_at=?,restored_at='',updated_at=? WHERE owner=?`)
   .run(String(messageId),synthetic?1:0,this.clock(),this.clock(),owner);
  return {...this.boundary(owner),deduped:false,lifecycle:lifecycle||null,relation:relation||null};
 }

 // §9：回答结束且目标仍允许继续时恢复相同 taskFocus；不重新 start/resume，不重复召回（版本不变）。
 restoreTask(owner,{reason='',taskId=null,activationId=null}={}){
  const r=this.row(owner);
  if(!r)return {restored:false,reason:'没有焦点行'};
  if(!r.interrupted_at)return {restored:false,reason:'没有待恢复的插话焦点'};
  if(!r.task_id)return {restored:false,reason:'插话期间没有可恢复的任务焦点',effectiveFocus:r.effective};
  if(taskId!=null&&Number(taskId)!==Number(r.task_id))
   return {restored:false,taskChanged:true,reason:`当前任务焦点是 #${r.task_id}，与要恢复的 #${taskId} 不一致：不静默改指向`};
  if(activationId&&String(activationId)!==r.activation_id)
   return {restored:false,taskChanged:true,reason:'activation 已变化：需要新的记忆边界，不能沿用旧焦点'};
  this.db.prepare("UPDATE pf_goal_focus SET effective='task',interrupted_at='',restored_at=?,updated_at=? WHERE owner=?")
   .run(this.clock(),this.clock(),owner);
  return {restored:true,taskFocus:this.taskFocus(owner),effectiveFocus:'task',taskFocusVersion:Number(r.task_focus_version),
   activationId:r.activation_id,newActivation:false,reclaimed:false,reRecall:false,
   reason:reason||'插话已回答：恢复同一任务焦点，不重新认领'};
 }

 // ── 召回：版本化请求 + 迟到隔离 ───────────────────────────────────────────
 recallRequest(owner,{focus='effective',query=''}={}){
  const r=this.ensure(owner);
  const kind=focus==='effective'?r.effective:focus;
  if(!FOCUS_KINDS.includes(kind))fail('未知召回焦点：'+focus);
  const version=this.version(owner,kind);
  return {owner,focusKind:kind,focusVersion:version,cacheKey:`${owner}|${kind}|${version}`,
   effectiveFocus:r.effective,query:String(query||'')};
 }
 // §9：迟到结果只能填充其匹配缓存，不能覆盖当前可见焦点。
 acceptRecall(owner,result={}){
  const r=this.ensure(owner);
  const kind=String(result.focusKind||'');
  if(!FOCUS_KINDS.includes(kind))fail('召回结果需要 focusKind=task|user');
  if(!Number.isInteger(Number(result.focusVersion)))fail('召回结果需要请求时的 focusVersion');
  const asked=Number(result.focusVersion),current=this.version(owner,kind);
  const summary=this.text(result);
  const base={owner,focusKind:kind,focusVersion:asked,currentVersion:current,cacheKey:result.cacheKey||`${owner}|${kind}|${asked}`};
  if(asked!==current){
   const id=this.record(owner,kind,asked,base.cacheKey,'late',summary,false);
   return {...base,id,applied:false,late:true,visible:false,
    reason:'召回结果属于旧焦点版本：只填充其匹配缓存，不覆盖当前可见焦点'};
  }
  if(r.effective!==kind){
   const id=this.record(owner,kind,asked,base.cacheKey,'cached',summary,false);
   return {...base,id,applied:false,late:false,cached:true,visible:false,
    reason:'当前可见焦点不是它：先填充各自的缓存，恢复该焦点后再显示'};
  }
  const bound=this.boundText(summary);
  // 同一个缓存键重复到达只刷新，不叠加；不同键累积但受条数与字符上限约束（§9 一份有上限的可见上下文）。
  const same=this.db.prepare("SELECT id FROM pf_goal_recall WHERE owner=? AND cache_key=? AND state='visible'").get(owner,base.cacheKey);
  let id=0;
  if(same){
   this.db.prepare('UPDATE pf_goal_recall SET summary=?,truncated=?,focus_version=?,created_at=? WHERE id=?')
    .run(bound.text,bound.truncated?1:0,asked,this.clock(),same.id);
   id=Number(same.id);
  } else id=this.record(owner,kind,asked,base.cacheKey,'visible',bound.text,bound.truncated);
  const trimmed=this.trim(owner,kind);
  return {...base,id,applied:true,late:false,visible:true,refreshed:!!same,truncated:bound.truncated,
   visibleCount:trimmed.count,visibleChars:trimmed.chars,superseded:trimmed.superseded,
   reason:'焦点版本匹配且当前可见：填入可见记忆上下文（有上限）'};
 }
 // §9：保持一份有上限的可见记忆上下文——只算当前 effectiveFocus 那一份，另一焦点留在缓存里。
 visible(owner){
  const r=this.ensure(owner),kind=r.effective==='user'?'user':'task';
  const rows=this.db.prepare("SELECT * FROM pf_goal_recall WHERE owner=? AND focus_kind=? AND state='visible' ORDER BY id DESC").all(owner,kind);
  const chars=rows.reduce((n,x)=>n+String(x.summary||'').length,0);
  const cached={};
  for(const k of FOCUS_KINDS)cached[k]=this.db.prepare("SELECT COUNT(*) AS n FROM pf_goal_recall WHERE owner=? AND focus_kind=? AND state!='visible'").get(owner,k).n;
  return {owner,effectiveFocus:r.effective,focusKind:kind,items:rows.map(x=>({id:x.id,focusKind:x.focus_kind,
    focusVersion:x.focus_version,summary:x.summary,truncated:!!x.truncated,createdAt:x.created_at})),
   count:rows.length,chars,limit:this.visibleLimit,charLimit:this.visibleChars,
   bounded:rows.length>=this.visibleLimit||chars>=this.visibleChars,cached};
 }
 trim(owner,kind){
  const rows=this.db.prepare("SELECT * FROM pf_goal_recall WHERE owner=? AND focus_kind=? AND state='visible' ORDER BY id DESC").all(owner,kind);
  let chars=0,superseded=0;
  for(let i=0;i<rows.length;i++){
   const len=String(rows[i].summary||'').length;
   // 最新一条始终保留（已在 boundText 内截断），其余超过条数/字符上限的退为 superseded。
   if(i>=this.visibleLimit||(i>0&&chars+len>this.visibleChars)){
    this.db.prepare("UPDATE pf_goal_recall SET state='superseded' WHERE id=?").run(rows[i].id);superseded++;continue;
   }
   chars+=len;
  }
  const kept=this.db.prepare("SELECT COUNT(*) AS n FROM pf_goal_recall WHERE owner=? AND focus_kind=? AND state='visible'").get(owner,kind).n;
  return {count:kept,chars,superseded};
 }
 record(owner,kind,version,key,state,summary,truncated){
  const info=this.db.prepare(`INSERT INTO pf_goal_recall(owner,focus_kind,focus_version,cache_key,state,summary,truncated,created_at)
   VALUES(?,?,?,?,?,?,?,?)`).run(owner,kind,version,String(key||''),state,String(summary||''),truncated?1:0,this.clock());
  this.prune(owner);
  return Number(info.lastInsertRowid);
 }
 // 缓存行有上限：迟到的旧版本结果不能无限堆积。
 prune(owner,limit=40){
  const extra=this.db.prepare("SELECT id FROM pf_goal_recall WHERE owner=? AND state!='visible' ORDER BY id DESC LIMIT -1 OFFSET ?").all(owner,limit);
  for(const x of extra)this.db.prepare('DELETE FROM pf_goal_recall WHERE id=?').run(x.id);
 }
 text(result){
  if(typeof result.summary==='string'&&result.summary.trim())return result.summary.trim();
  const items=Array.isArray(result.items)?result.items:[];
  return items.map(x=>typeof x==='string'?x:String(x?.text??x?.summary??'')).filter(Boolean).join(' / ');
 }
 boundText(text){
  const s=String(text||'');
  if(s.length<=this.visibleChars)return {text:s,truncated:false};
  return {text:s.slice(0,this.visibleChars),truncated:true};
 }

 // ── Memo 能力与降级（§9：旧 Memo 保持旧行为并显示降级） ──────────────────
 memoState(report=null){
  const dual=!!report&&report.dualFocus===true;
  const known=!!report&&typeof report.dualFocus==='boolean';
  const capability=dual?MEMO_CAPABILITY.dual:(known?MEMO_CAPABILITY.single:MEMO_CAPABILITY.unknown);
  return {capability,dualFocus:dual,degraded:!dual,source:report?.source||null,version:report?.version||null,
   behavior:dual?'插话期间切到 userFocus，回答结束后恢复同一 taskFocus；召回按焦点版本回填':'旧行为：单一焦点，插话期间不保留任务焦点',
   note:dual?'已收到 Memo 双焦点能力上报':(known
    ?'Memo 报告没有双焦点能力：保持旧行为并显示降级，不宣称插话记忆恢复已实现'
    :'未收到 Memo 双焦点能力上报：按旧行为处理并显示降级（不可只修改心流就宣称插话记忆恢复已实现）')};
 }
 // 快照/面板用的结构化边界状态（GF11 直接消费）。
 boundary(owner,{memo=null}={}){
  const r=this.row(owner),memoState=this.memoState(memo);
  if(!r)return {owner,projectId:null,goalId:null,runId:null,effectiveFocus:null,taskFocus:null,userFocus:null,
   versions:{task:0,user:0},interrupted:false,interruptedAt:null,restoredAt:null,cacheKey:null,memo:memoState};
  const kind=r.effective==='user'?'user':'task';
  const version=kind==='task'?Number(r.task_focus_version):Number(r.user_focus_version);
  return {owner,projectId:r.project_id||null,goalId:r.goal_id||null,runId:r.run_id||null,effectiveFocus:r.effective,
   taskFocus:r.task_id?{projectId:r.project_id,taskId:Number(r.task_id),activationId:r.activation_id||null,
    revision:Number(r.task_revision),version:Number(r.task_focus_version)}:null,
   userFocus:r.user_message_id?{messageId:r.user_message_id,version:Number(r.user_focus_version),synthetic:!!r.user_focus_synthetic}:null,
   versions:{task:Number(r.task_focus_version),user:Number(r.user_focus_version)},
   interrupted:!!r.interrupted_at,interruptedAt:r.interrupted_at||null,restoredAt:r.restored_at||null,
   cacheKey:`${owner}|${kind}|${version}`,memo:memoState};
 }
}
module.exports={GoalFocus,ACTIVATION_KINDS,NON_ACTIVATION_KINDS,FOCUS_KINDS,MEMO_CAPABILITY,DEFAULTS};
