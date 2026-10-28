'use strict';
// GF07（主文档 §8.1/§8.3 + §14 GA02/GA13/GA17/GA18/GA19/GA20）：逐项证据判断与目标验收。
// ── 铁律 ──────────────────────────────────────────────────────────────
//  * 任务级 done 只认 accepted：verifying 期间任务仍是 in_progress（§8.1）；
//    旧 complete/advance 走同一闸门（gate），不能从旧入口绕过。
//  * 条件分权（§8.3）：machine 条件由代码判定（引用存在、摘要当前、声明的检查项）；
//    semantic 条件需要判断——阈值未标定（uncalibrated-1）时永不自动通过，只能
//    pending-acceptance，或由主 Agent/人工显式复核（review，带署名与理由）落账。
//  * 验收不是永久布尔：读取时重算引用摘要，文件变了就 invalidated 落账，历史保留。
//  * 空集合不恒真：没有验收条件、或任务未映射任何条件，都显式报缺口，不算满足。
//  * 视觉证据不冒充语义判断：截图类引用一律 pending-review，不声称 JEV 看过截图（GA20）。
//  * fail-closed：闸门自身出错视为未通过并记录原因，绝不 fall through 放行。
const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const OP=require('./operations.cjs');
const fail=(message,code='ACCEPTANCE_POLICY')=>{throw Object.assign(new Error(message),{code});};
const now=()=>new Date().toISOString();
const parse=(v,fb)=>{try{return typeof v==='string'?JSON.parse(v):v??fb;}catch{return fb;}};
const sha=text=>createHash('sha256').update(String(text)).digest('hex');
const DECISIONS=['accepted','pending-acceptance','pending-review','rejected','invalidated'];
const VISUAL=/\.(png|jpe?g|webp|gif|bmp)$/i;
// 判断结论一律落账，绝不把“没有判断”写成“通过”（§6.3：没有解释不生成伪引文）。
class GoalAcceptance {
 constructor({goalStore,evidence=null,policy=null,policyMode='observe'}={}){
  if(!goalStore||!goalStore.db)fail('GoalAcceptance 需要已构造的 GoalStore','ACCEPTANCE_CONFIG');
  this.goals=goalStore;this.db=goalStore.db;this.evidence=evidence;this.policy=policy;this.policyMode=policyMode;
  this.db.exec(`CREATE TABLE IF NOT EXISTS pf_goal_verifications(
    id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,run_id TEXT NOT NULL DEFAULT '',task_id INTEGER NOT NULL,
    activation_id TEXT NOT NULL DEFAULT '',criterion_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'verifying',decision TEXT NOT NULL DEFAULT 'pending-acceptance',
    result TEXT NOT NULL DEFAULT '',evidence TEXT NOT NULL DEFAULT '[]',machine TEXT NOT NULL DEFAULT '{}',
    semantic TEXT NOT NULL DEFAULT '{}',reasons TEXT NOT NULL DEFAULT '[]',reviewed_by TEXT NOT NULL DEFAULT '',
    submitted_by TEXT NOT NULL DEFAULT '',
    evidence_digest TEXT NOT NULL DEFAULT '',submitted_at TEXT NOT NULL,updated_at TEXT NOT NULL,invalidated_at TEXT NOT NULL DEFAULT '',
    UNIQUE(goal_id,task_id,activation_id,evidence_digest));
   CREATE INDEX IF NOT EXISTS pf_goal_verifications_task ON pf_goal_verifications(goal_id,task_id);`);
 }
 // ── 读取与规范化 ──────────────────────────────────────────────────────
 refs(raw){return (Array.isArray(raw)?raw:[]).map(r=>({type:String(r?.type||'file'),path:r?.path?String(r.path):'',
  hash:r?.hash?String(r.hash):'',id:r?.id??null,source:r?.source?String(r.source):'',url:r?.url?String(r.url):'',
  finding:r?.finding?String(r.finding):'',visual:VISUAL.test(String(r?.path||r?.source||''))}));}
 digestOf(refs){return sha(JSON.stringify(refs.map(r=>[r.type,r.path||r.source||String(r.id||''),r.hash]).sort()));}
 criteriaFor(goalId,taskId,criterionIds=null){
  const rows=this.db.prepare('SELECT * FROM pf_goal_criteria WHERE goal_id=? ORDER BY position,id').all(goalId);
  const link=this.db.prepare('SELECT criterion_ids FROM pf_goal_task_links WHERE goal_id=? AND task_id=?').get(goalId,Number(taskId));
  const rawLink=parse(link?.criterion_ids,'[]');
  const linked=new Set((Array.isArray(rawLink)?rawLink:[]).map(String));
  return rows.map(c=>({...c,checks:parse(c.checks,[]),mapped:linked.has(String(c.id))}))
   .filter(c=>(criterionIds?criterionIds.map(String).includes(String(c.id)):c.mapped));
 }
 // 引用新鲜度：文件摘要变了就是变了（§8.3 证据失效）。读不到属于“不可用”，不属于“空”。
 fresh(ref,root){
  if(ref.type!=='file')return {state:'unverifiable',reason:`${ref.type} 引用无法用摘要核对`};
  if(!ref.path)return {state:'unreadable',reason:'引用缺少路径'};
  const abs=path.resolve(root||'.',ref.path);
  try{
   const current=OP.hash(fs.readFileSync(abs));
   if(ref.hash&&current!==ref.hash)return {state:'changed',now:current,was:ref.hash,reason:'引用内容已变化'};
   return {state:'current',hash:current};
   }catch(error){return {state:'unreadable',reason:`引用读不到：${ref.path}（${(error&&error.message)||error}）`};}
 }
 // ── 确定性检查（§8.3 首句：代码可验证的先由代码检查）────────────────────
 machineFor(criterion,refs,root){
  const facts=[],reasons=[];
  for(const check of criterion.checks||[]){
   const type=String(check?.type||'');
   if(type==='ref'||type==='digest'){
    const hit=refs.find(r=>r.type==='file'&&String(r.path||'').replace(/\\/g,'/')===String(check.path||'').replace(/\\/g,'/'));
    if(!hit)reasons.push(`缺少引用：${check.path||'(未指明)'}`);
    else if(type==='digest'&&check.hash&&hit.hash&&check.hash!==hit.hash)reasons.push(`引用摘要与声明不符：${check.path}`);
    else facts.push({check:type,path:check.path,state:'ok'});
   } else if(type==='test'){
    const hit=refs.find(r=>['file','research'].includes(r.type)&&`${r.path??''}${r.source??''}`.replace(/\\/g,'/').includes(String(check.path||check.kind||'test').replace(/\\/g,'/')));
    if(!hit)reasons.push(`缺少测试回执：${check.path||check.kind||'test'}`);
    else facts.push({check:'test',ref:hit.path||hit.source,state:'ok'});
   } else reasons.push(`不认识的检查类型 ${type||'(空)'}：按未通过处理`);
  }
  for(const r of refs){
   const f=this.fresh(r,root);
   if(f.state==='changed')reasons.push(`引用已变化：${r.path}`);
   else if(f.state==='unreadable')reasons.push(f.reason);
  }
  // 空检查表不恒真：声明的 machine 条件必须说清拿什么核对。
  if(criterion.category==='machine'&&!(criterion.checks||[]).length)reasons.push('machine 条件未声明任何检查项：不视为通过（空集合不恒真）');
  return {ok:reasons.length===0,facts,reasons};
 }
 // ── 判定 ──────────────────────────────────────────────────────────────
 decide(criteria,{refs,root,judgments={}}){
  const per=[],reasons=[];
  const visualOnly=refs.length>0&&refs.every(r=>r.visual);
  for(const c of criteria){
   const machine=this.machineFor(c,refs,root);
   const item={criterionId:c.id,requirement:c.requirement,category:c.category,machine};
   if(machine.reasons.length){item.state='rejected';reasons.push(...machine.reasons.map(r=>`#${c.id} ${r}`));per.push(item);continue;}
   if(c.category==='human'){item.state='pending-review';item.note='需要人工确认的条件保持 pending-review';per.push(item);continue;}
   if(c.category==='machine'){item.state='accepted';item.note='确定性检查通过：代码可验证的条件由代码判定';per.push(item);continue;}
   if(visualOnly){item.state='pending-review';item.note='唯一证据是界面截图：不声称 JEV 看过截图，保留视觉核验来源（GA20）';per.push(item);continue;}
   const verdict=this.policy?this.policy.completion(judgments[c.id]||null,{criterion:c,machineChecks:{ok:true}})
    :{verdict:'unavailable',canAccept:false,reason:'没有装配决策策略：语义证据不能自动通过'};
   item.semantic=verdict;
   item.state=verdict.canAccept?'accepted':'pending-acceptance';
   if(!verdict.canAccept)reasons.push(`#${c.id} ${verdict.reason}`);
   per.push(item);
  }
  const overall=per.some(i=>i.state==='rejected')?'rejected'
   :(per.every(i=>i.state==='accepted')?'accepted'
   :(per.some(i=>i.state==='pending-review')?'pending-review':'pending-acceptance'));
  return {overall,per,reasons};
 }
 row(v){return {...v,criterionIds:parse(v.criterion_ids,[]).map(String),evidence:parse(v.evidence,[]),
  machine:parse(v.machine,{}),semantic:parse(v.semantic,{}),reasons:parse(v.reasons,[])};}
 view(v,extra={}){return {verificationId:v.id,goalId:v.goal_id,taskId:v.task_id,status:v.status,decision:v.decision,
  criterionIds:parse(v.criterion_ids,[]).map(String),machine:parse(v.machine,{}),semantic:parse(v.semantic,{}),
  reasons:parse(v.reasons,[]),reviewedBy:v.reviewed_by,submittedBy:v.submitted_by,submittedAt:v.submitted_at,updatedAt:v.updated_at,...extra};}
 // ── submit：结果进入 verifying；未通过前任务仍是 in_progress（§8.1）──────
 submit(run,{taskId=null,criterionIds=null,evidence=[],result='',by='',activationId='',root=null,judgments={}}={}){
  if(!run||!run.goal_id)fail('提交核验需要目标运行');
  if(taskId==null)fail('提交核验需要明确任务');
  // 幂等键属于任务，不属于提交入口：调用方没给 activation 时从任务自身解析，
  // 否则“旧完成入口”与“goal.submit”会各写一行，已复核的结论会被当成新提交重新拦住。
  let act=String(activationId||'');
  if(!act){try{const state=this.db.prepare('SELECT activation_id FROM pf_task_state WHERE task_id=?').get(Number(taskId));act=String(state?.activation_id||'');}catch{act='';}}
  const goalId=run.goal_id,refs=this.refs(evidence);
  // 台账必须留下可比的基准：提交时给缺摘要的文件引用补一次当前摘要，否则“证据变化失效”永远测不出来。
  for(const r of refs){
   if(r.type!=='file'||!r.path||r.hash)continue;
   try{r.hash=OP.hash(fs.readFileSync(path.resolve(root||'.',r.path)));}catch{r.hash='';}
  }
  const digest=this.digestOf(refs);
  const existing=this.db.prepare('SELECT * FROM pf_goal_verifications WHERE goal_id=? AND task_id=? AND activation_id=? AND evidence_digest=?')
   .get(goalId,Number(taskId),act,digest);
  if(existing)return this.view(existing,{reused:true,jurisdiction:'同一份证据重复提交只刷新时间，不新增行（幂等）'});
  const criteria=this.criteriaFor(goalId,taskId,criterionIds);
  const unmapped=criteria.length===0;
  const verdict=unmapped?{overall:'pending-review',per:[],reasons:['该任务未映射任何目标条件：不视为满足，也不阻塞任务本身；请先建立条件映射']}
   :this.decide(criteria,{refs,root,judgments});
  const id='vrf-'+randomUUID().slice(0,12),t=now();
  OP.dbWrite();
  this.db.prepare(`INSERT INTO pf_goal_verifications(id,goal_id,run_id,task_id,activation_id,criterion_ids,status,decision,
   result,evidence,machine,semantic,reasons,reviewed_by,submitted_by,evidence_digest,submitted_at,updated_at,invalidated_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'',?,?,?,?,'')`)
   .run(id,goalId,String(run.id||''),Number(taskId),act,JSON.stringify(criteria.map(c=>c.id)),
    verdict.overall==='accepted'?'accepted':'verifying',verdict.overall,String(result||''),JSON.stringify(refs),
    JSON.stringify({criteria:verdict.per}),JSON.stringify({mode:this.policyMode}),JSON.stringify(verdict.reasons),
    String(by||''),digest,t,t);
  return this.view(this.db.prepare('SELECT * FROM pf_goal_verifications WHERE id=?').get(id),
   {unmapped,checks:verdict.per,machine:verdict.per.map(p=>p.machine),reason:verdict.reasons});
 }
 // ── 复核：主 Agent / 人工的显式判断，必须署名与理由（§8.3）──────────────
 review(verificationId,{by='',verdict='accepted',reason=''}={}){
  if(!String(by||'').trim())fail('复核必须署名：不允许匿名通过');
  if(!String(reason||'').trim())fail('复核必须写明理由');
  if(!['accepted','rejected'].includes(verdict))fail('复核结论只能是 accepted 或 rejected');
  const row=this.db.prepare('SELECT * FROM pf_goal_verifications WHERE id=?').get(verificationId);
  if(!row)fail('核验记录不存在','NOT_FOUND');
  if(row.decision==='invalidated')fail('该核验已因证据变化失效，请用当前证据重新提交');
  OP.dbWrite();
  this.db.prepare('UPDATE pf_goal_verifications SET decision=?,status=?,reviewed_by=?,reasons=?,updated_at=? WHERE id=?')
   .run(verdict,verdict==='accepted'?'accepted':'rejected',String(by),JSON.stringify([`复核 ${verdict}：${reason}`]),now(),verificationId);
  return this.view(this.db.prepare('SELECT * FROM pf_goal_verifications WHERE id=?').get(verificationId),{reviewed:true});
 }
 // ── 完整性重算：验收不是永久布尔（GA13）───────────────────────────────
 validate(goalId,{root=null}={}){
  const rows=this.db.prepare("SELECT * FROM pf_goal_verifications WHERE goal_id=? AND decision='accepted'").all(goalId);
  const invalidated=[];
  for(const row of rows){
   const refs=parse(row.evidence,[]),bad=refs.map(r=>this.fresh(r,root)).filter(f=>['changed','unreadable'].includes(f.state));
   if(!bad.length)continue;
   OP.dbWrite();
   this.db.prepare("UPDATE pf_goal_verifications SET decision='invalidated',status='invalidated',reasons=?,invalidated_at=?,updated_at=? WHERE id=?")
    .run(JSON.stringify(bad.map(b=>b.reason||'引用已变化')),now(),now(),row.id);
   invalidated.push({verificationId:row.id,taskId:row.task_id,reasons:bad.map(b=>b.reason||'引用已变化')});
  }
  return invalidated;
 }
 // ── 逐条核对与缺口（GA17/GA18）────────────────────────────────────────
 checkGoalAccepted(goalId,{root=null}={}){
  const invalidated=this.validate(goalId,{root});
  const criteria=this.db.prepare('SELECT * FROM pf_goal_criteria WHERE goal_id=? ORDER BY position,id').all(goalId);
  if(!criteria.length)return {goalId,accepted:false,reason:'目标没有验收条件：不自动通过（空集合不恒真）',criteria:[],gaps:[],invalidated};
  const all=this.db.prepare('SELECT * FROM pf_goal_verifications WHERE goal_id=?').all(goalId).map(v=>this.row(v));
  const out=[],gaps=[];
  for(const c of criteria){
   const mine=all.filter(v=>v.criterionIds.includes(String(c.id)));
   const accepted=mine.filter(v=>v.decision==='accepted');
   const mapped=this.db.prepare('SELECT COUNT(*) AS n FROM pf_goal_task_links WHERE goal_id=? AND criterion_ids LIKE ?').get(goalId,`%${c.id}%`).n;
   if(accepted.length){out.push({criterionId:c.id,requirement:c.requirement,category:c.category,state:'satisfied',
    by:accepted.map(v=>v.verificationId||v.id),reviewedBy:accepted.map(v=>v.reviewed_by).filter(Boolean),linkedTasks:mapped});continue;}
   const pend=mine.filter(v=>['pending-acceptance','pending-review'].includes(v.decision));
   const state=pend.length?(pend.some(v=>v.decision==='pending-review')?'pending-review':'pending-acceptance'):'absent';
   const reason=pend.length?((pend[0].reasons||[])[0]||'等待判断或复核'):'没有当前有效证据';
   // GA18：条件只要被任一任务覆盖即可，不强迫历史取消项重新 done。
   out.push({criterionId:c.id,requirement:c.requirement,category:c.category,state,reason,linkedTasks:mapped});
   gaps.push({criterionId:c.id,requirement:c.requirement,state,reason,linkedTasks:mapped,
    suggest:`为「${c.requirement}」补当前版本的可核对证据，或由主 Agent/人工复核落账（review 需署名与理由）`});
  }
  const accepted=out.every(o=>o.state==='satisfied');
  return {goalId,accepted,criteria:out,gaps,invalidated,phase:accepted?'completed':'reconciling'};
 }
 // ── 旧完成入口的闸门（§8.1：不能绕过同一验收路径）─────────────────────
 gate({projectId,taskId,evidence=[],result='',activationId='',root=null,owner=''}={}){
  try{
   const goal=this.goals.current(projectId);
   if(!goal)return {required:false,reason:'该工程没有进行中的目标：保持既有任务行为'};
   const linked=this.db.prepare('SELECT 1 AS n FROM pf_goal_task_links WHERE goal_id=? AND task_id=?').get(goal.id,Number(taskId));
   if(!linked)return {required:false,goalId:goal.id,reason:'任务未关联该目标：保持既有任务行为'};
   const run=this.db.prepare("SELECT * FROM pf_goal_runs WHERE goal_id=? ORDER BY started_at DESC").get(goal.id)||{id:'',goal_id:goal.id};
   const out=this.submit(run,{taskId,evidence,result,by:owner,activationId,root});
   if(out.decision==='accepted')return {required:true,allowed:true,goalId:goal.id,...out};
   const reason=[`目标验收未通过（${out.decision}）`,...(out.reasons||[]).slice(0,3)].join('：');
   return {required:true,allowed:false,goalId:goal.id,...out,
    reason:reason+`；先补证据或用 TaskAction submit 走核验，语义条件需主 Agent/人工复核（review 署名）。`};
  }catch(error){
   return {required:true,allowed:false,reason:'验收层核对出错，按未通过处理：'+(error&&error.message||error)};
  }
 }
 state(goalId,{taskId=null}={}){
  const rows=(taskId==null?this.db.prepare('SELECT * FROM pf_goal_verifications WHERE goal_id=? ORDER BY submitted_at DESC').all(goalId)
   :this.db.prepare('SELECT * FROM pf_goal_verifications WHERE goal_id=? AND task_id=? ORDER BY submitted_at DESC').all(goalId,Number(taskId))).map(v=>this.row(v));
  return {goalId,taskId,count:rows.length,verifications:rows.map(v=>this.view(v)),decisions:DECISIONS};
 }
}
module.exports={GoalAcceptance,VISUAL,DECISIONS};
