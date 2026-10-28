'use strict';
// GF03（主文档 §6.1 / §7 / §8.3）：有来源的进展与证据采集。
// 分工：GoalStore 拥有表与写入路径；本模块只做分类、去重、回执核对与证据新鲜度，不做语义判断（语义归 GF04 JEV）。
// 铁律：
//  * 事实与声明分开 —— 只有可核对引用（操作回执 / 内容摘要 / 可复查文件）才记 verified；Agent 自述一律 declared。
//  * 未知回执不重放 —— 在途 / needs-reconciliation / unknown 记 unreconciled：先核对，不重发写操作，不计进展（GA25）。
//  * 失效保留审计 —— 过期只改 status，不删行、不改正文（§8.3 不静默改写原审计）。
//  * 压缩不是进展 —— compaction/续跑/重读/重规划 对授权、预算、停滞计数零影响（§7、§10.1）。
//  * 观察文本只是数据 —— 外部文档、工具输出与引用里的“指令”不构成授权或完成依据（§6.1、GA34）。
// 采集入口：①引擎侧自动——变更类工具回执（带文件证据）由 runtime-api 的 goalIntake 落账；
// ②显式——goal.observe（宿主；Agent 侧提交调查发现的工具面随 GF06/GF07 的缺口处理一起给）。
// 只读工具的调用不自动计进展，避免用“重复读取”刷进展（§7/GA04）。
const fs=require('node:fs');
const {createHash}=require('node:crypto');
const OP=require('./operations.cjs');
const now=()=>new Date().toISOString();
const parse=(v,fb)=>{try{return typeof v==='string'?JSON.parse(v):v??fb;}catch{return fb;}};
const norm=text=>String(text??'').replace(/\s+/g,' ').trim().toLowerCase();
const sha=text=>createHash('sha256').update(String(text)).digest('hex');
const fail=(message,code='EVIDENCE_POLICY')=>{throw Object.assign(new Error(message),{code});};

// §6.1 证据顺序：最新真实用户决定 → 已确认目标/约束 → 实际工具回执与当前文件/检查结果
//  → 有来源的调查记录 → Agent 自述 → 历史摘要。数字越小越优先；冲突保留，不做平均分。
const SOURCE_TIERS=[
 {id:'user-decision',tier:1,label:'最新真实用户决定'},
 {id:'goal-constraint',tier:2,label:'当前已确认目标与约束'},
 {id:'tool-receipt',tier:3,label:'实际工具回执与当前文件/检查结果'},
 {id:'investigation',tier:4,label:'有来源的调查记录'},
 {id:'agent-claim',tier:5,label:'Agent 自述'},
 {id:'history-summary',tier:6,label:'历史摘要（含压缩摘要）'}
];
const TIER_OF=Object.fromEntries(SOURCE_TIERS.map(t=>[t.id,t.tier]));
function tierOf(source){
 if(!source)return 'agent-claim';
 if(typeof source==='string')return TIER_OF[source]?source:'agent-claim';
 const kind=String(source.kind||'');
 // §4：没有 messageId 的“用户消息”不成立——模型输出与文档不能伪装成用户决定。
 if(kind==='user')return source.messageId?'user-decision':'agent-claim';
 if(kind==='goal'||kind==='constraint')return 'goal-constraint';
 if(kind==='receipt'||kind==='tool'||kind==='operation')return 'tool-receipt';
 if(kind==='investigation')return 'investigation';
 if(kind==='summary'||kind==='compaction')return 'history-summary';
 return 'agent-claim';
}

// §7 进展采集覆盖实现、调查与验证：成功文件操作、当前检查结果、定位到的原因、排除的假设、有引用的新发现。
// 没有文件改动也可能有进展；文件改动与修订号增加也不必然有进展（后者由 countsAsProgress 判定）。
const PROGRESS_KINDS=new Set(['file','test','check','investigation','cause','excluded-hypothesis']);
// §7：压缩、续跑消息、重复读取、重复改计划都不计作工程进展。
const NON_PROGRESS_KINDS=new Set(['compaction','resume','reread','replan','heartbeat','sync','reminder','declaration','summary']);
const VERIFICATIONS=['verified','declared','unreconciled'];
const VALIDITY=['current','expired','unhashed','unreadable','declared'];
const RECEIPT_COMMITTED=['completed','committed'];
const RECEIPT_FAILED=['failed-before-commit','cancelled-before-commit'];
const EFFECTS=counts=>({authorization:'none',budget:'none',stagnation:counts?'progress-evidence':'none'});

const DIRECTIVE_PATTERNS=[
 /忽略(以上|之前|前面|所有)*(的)?(指令|约束|要求|规则|限制)/,
 /无视(以上|之前|前面|所有)*(的)?(指令|约束|规则|限制)/,
 /不用(理会|管|在意)(以上|之前|前面)/,
 /(直接|立即|马上)(完成|通过|结束)(目标|任务|验收)/,
 /ignore\s+(all\s+)?(previous|prior|above)/i,
 /disregard\s+(all\s+)?(previous|prior|above)/i,
 /override\s+(the\s+)?(constraints|instructions)/i,
 /(^|\n)\s*system\s*[:：]/i
];
// §6.1/GA34：命中只做标注，观察文本永远不被当作生命周期、授权或完成依据。
function screenText(text){
 const s=String(text??'');
 const patterns=DIRECTIVE_PATTERNS.filter(re=>re.test(s)).map(re=>String(re));
 return {text:s,instructionLike:patterns.length>0,patterns,
  note:'外部文档、工具输出与引用中的指令只作为待评价数据（§6.1/GA34）'};
}

class GoalEvidence{
 constructor(goalStore,{journal=null,clock=now}={}){
  if(!goalStore||!goalStore.db)throw new Error('GoalEvidence 需要已构造的 GoalStore');
  this.goals=goalStore;this.db=goalStore.db;this.journal=journal;this.clock=clock;
 }

 // ── 来源与回执 ────────────────────────────────────────────────────────────
 sourceOf(obs={}){
  const raw=obs.source??(obs.sourceKind?{kind:obs.sourceKind,messageId:obs.messageId}:null);
  const explicit=tierOf(raw);
  // 观察自身的引用就是它的事实级别：有回执或内容摘要=工具回执；有引用的调查=调查记录。
  const inferred=(obs.operationId||obs.contentDigest||obs.afterDigest||obs.path)?'tool-receipt'
   :(obs.sourceRef&&['investigation','cause','excluded-hypothesis'].includes(obs.kind))?'investigation'
   :(obs.kind==='compaction'||obs.kind==='summary'||obs.kind==='resume')?'history-summary':null;
  const id=explicit!=='agent-claim'?explicit:(inferred||explicit);
  return {id,tier:TIER_OF[id],label:SOURCE_TIERS.find(t=>t.id===id).label,
   verifiedUser:!!(raw&&typeof raw==='object'&&raw.kind==='user'&&raw.messageId)};
 }
 receiptOf(operationId){
  const s=this.journal?this.journal.status(operationId):null;
  if(!s)return {operationId,status:'unknown',phase:'no-journal',files:[],error:'本进程没有操作日志可核对'};
  return {...s,files:s.files||[]};
 }
 classify({kind,receipt,obs}){
  if(NON_PROGRESS_KINDS.has(kind))
   return {verification:receipt&&RECEIPT_COMMITTED.includes(receipt.status)?'verified':'declared',countsAsProgress:false,blocked:false,
    reason:'该类观察不计工程进展：压缩、续跑、重读、重规划、心跳、同步与自述都只是动作记录（§7）'};
  if(!PROGRESS_KINDS.has(kind))
   return {verification:receipt&&RECEIPT_COMMITTED.includes(receipt.status)?'verified':'declared',countsAsProgress:false,blocked:false,
    reason:'未登记的观察种类按不计进展处理（fail-closed）'};
  if(receipt){
   if(RECEIPT_COMMITTED.includes(receipt.status))
    return {verification:'verified',countsAsProgress:true,blocked:false,reason:'有工具回执可核对'};
   if(RECEIPT_FAILED.includes(receipt.status))
    return {verification:'verified',countsAsProgress:false,blocked:false,
     reason:'失败回执本身是事实：操作未提交成功，不构成进展，也不允许被自述覆盖（GA19）'};
   return {verification:'unreconciled',countsAsProgress:false,blocked:true,
    reason:receipt.status==='running'?'操作在途：等待回执，不重发写操作'
     :`回执未核对（${receipt.status}）：先 inspect 核对，不重放写操作（GA25）`};
  }
  if(obs.contentDigest||obs.afterDigest)
   return {verification:'verified',countsAsProgress:true,blocked:false,reason:'有内容摘要，可复查新鲜度'};
  // §7/GA03：没改文件但有可核对引用的调查记录（定位到的原因、排除的假设、带引用的新发现）算进展——
  // 引用必须非空（sourceRef 是稳定指针，如 log:build-42、file:x#L10、test:run-7）；重复引用被去重挡住。
  if(obs.sourceRef&&['investigation','cause','excluded-hypothesis'].includes(kind))
   return {verification:'verified',countsAsProgress:true,blocked:false,
    reason:'有可核对引用的调查记录：没有文件改动也算进展；同一引用的重复观察不重复计数（§7/GA03）'};
  return {verification:'declared',countsAsProgress:false,blocked:false,
   reason:'仅 Agent 自述，没有可核对引用：记为声明，不重置停滞计数（§7）'};
 }
 bindingOf(obs,receipt){
  if(receipt&&receipt.files.length){
   // 只绑定已落盘的文件：prepared 行没进磁盘，拿它复查会造出假过期。
   const files=receipt.files.filter(f=>['applied','ledgered'].includes(f.phase))
    .map(f=>({path:f.path,kind:f.kind,phase:f.phase,beforeHash:f.beforeHash??null,afterHash:f.afterHash??null}));
   return {operationId:receipt.operationId,status:receipt.status,files};
  }
  if(receipt)return {operationId:receipt.operationId,status:receipt.status,files:[]};
  const digest=obs.contentDigest||obs.afterDigest||'';
  if(obs.path)return {path:String(obs.path),digest};
  if(digest)return {digest};
  return {};
 }
 dedupKeyOf(kind,obs,receipt,finding){
  return sha([kind,obs.path||obs.sourceRef||receipt?.operationId||'',
   obs.contentDigest||obs.afterDigest||'',norm(finding)].join('|'));
 }
 findDuplicate(run,dedupKey){
  if(!dedupKey)return null;
  // 去重范围是同一目标（跨 run 的重读/续跑同样不该重复计数）。
  return this.db.prepare(`SELECT o.* FROM pf_goal_observations o JOIN pf_goal_runs r ON r.id=o.run_id
   WHERE o.dedup_key=? AND r.goal_id=? ORDER BY o.observed_at LIMIT 1`).get(dedupKey,run.goal_id)||null;
 }

 // ── 采集 ──────────────────────────────────────────────────────────────────
 record(runId,obs={}){
  const run=this.goals.runRow(runId);if(!run)fail('观察需要有效的 runId');
  const kind=String(obs.kind||'').trim();if(!kind)fail('观察需要 kind');
  const finding=String(obs.finding||'').trim();if(!finding)fail('观察需要 finding 正文（事实或声明都要有可读文本）');
  const screen=screenText(finding);
  const receipt=obs.operationId?this.receiptOf(obs.operationId):null;
  const source=this.sourceOf(obs);
  const verdict=this.classify({kind,receipt,obs});
  const dedupKey=this.dedupKeyOf(kind,obs,receipt,finding);
  const dup=this.findDuplicate(run,dedupKey);
  if(dup)return {id:dup.id,deduped:true,verification:dup.verification,countsAsProgress:false,blocked:verdict.blocked,
   validity:this.validity(dup.id).state,source,instructionLike:screen.instructionLike,effects:EFFECTS(false),
   reason:'重复观察：来源与内容指纹相同，不新增行、不计进展、不影响停滞计数（§7）'};
  const id=this.goals.observe(runId,{taskId:obs.taskId,kind,
   sourceRef:obs.sourceRef||(obs.path?'file:'+obs.path:''),
   beforeDigest:obs.beforeDigest||receipt?.files?.[0]?.beforeHash||'',
   afterDigest:obs.afterDigest||receipt?.files?.[0]?.afterHash||'',
   finding,verification:verdict.verification,dedupKey,binding:this.bindingOf(obs,receipt),
   countsProgress:verdict.countsAsProgress,status:'active'});
  return {id,deduped:false,verification:verdict.verification,countsAsProgress:verdict.countsAsProgress,
   blocked:verdict.blocked,validity:this.validity(id).state,source,instructionLike:screen.instructionLike,
   effects:EFFECTS(verdict.countsAsProgress),reason:verdict.reason};
 }
 // 工具回执 → 观察。失败的、未核对的回执同样落账（事实/待核对），但都不计进展。
 fromReceipt(receipt,{runId,taskId=null,kind='file',finding=''}={}){
  if(!receipt||!receipt.status)fail('需要操作回执（receipt）');
  const recorded=[];
  if(RECEIPT_COMMITTED.includes(receipt.status)){
   for(const f of receipt.files||[]){
    if(!['applied','ledgered'].includes(f.phase))continue;
    const r=this.record(runId,{taskId,kind,operationId:receipt.operationId,path:f.path,
     contentDigest:f.afterHash||'',finding:finding||`${kind} 回执：${f.path}`});
    recorded.push(r);
   }
  } else {
   const r=this.record(runId,{taskId,kind,operationId:receipt.operationId,
    finding:finding||`操作回执 ${receipt.operationId} 状态 ${receipt.status}${receipt.error?'：'+receipt.error:''}`});
   recorded.push(r);
  }
  const blocked=recorded.some(r=>r.blocked);
  return {status:receipt.status,recorded:recorded.map(r=>r.id),deduped:recorded.filter(r=>r.deduped).length,
   blocked,progress:recorded.filter(r=>r.countsAsProgress).length,
   reason:blocked?'存在未核对回执：先 inspect 核对，不重放写操作（GA25）'
    :(recorded.every(r=>!r.countsAsProgress)?'该回执不构成工程进展':'已采集回执来源的观察')};
 }

 // ── 新鲜度与失效 ──────────────────────────────────────────────────────────
 fileDigest(file){
  try{
   const st=fs.statSync(file);
   if(!st.isFile())return {state:'unreadable',reason:'不是普通文件'};
   return {state:'known',hash:OP.hash(fs.readFileSync(file))};
  }catch(e){return e.code==='ENOENT'?{state:'missing',reason:'文件不存在'}:{state:'unreadable',reason:e.code||e.message};}
 }
 row(id){return this.db.prepare('SELECT * FROM pf_goal_observations WHERE id=?').get(id)||null;}
 validity(idOrRow){
  const row=typeof idOrRow==='string'?this.row(idOrRow):idOrRow;
  if(!row)return {state:'unreadable',reason:'观察记录不存在'};
  if(row.status!=='active')return {state:'expired',reason:'已被后续变化显式失效（审计保留）'};
  if(row.verification==='declared')return {state:'declared',reason:'仅 Agent 自述，没有可核对引用'};
  if(row.verification==='unreconciled')return {state:'unreadable',reason:'回执未核对：先 inspect 再继续，不重放写操作'};
  const b=parse(row.binding,{});
  for(const f of b.files||[]){
   const cur=this.fileDigest(f.path);
   if(cur.state==='missing')return {state:'expired',path:f.path,reason:'回执记录的文件已不存在'};
   if(cur.state==='unreadable')return {state:'unreadable',path:f.path,reason:cur.reason};
   if(cur.hash!==f.afterHash)return {state:'expired',path:f.path,reason:'文件内容已变化，该证据失效'};
  }
  if(b.path&&b.digest){
   const cur=this.fileDigest(b.path);
   if(cur.state==='missing')return {state:'expired',path:b.path,reason:'文件已不存在'};
   if(cur.state==='unreadable')return {state:'unreadable',path:b.path,reason:cur.reason};
   if(cur.hash!==b.digest)return {state:'expired',path:b.path,reason:'文件内容已变化，该证据失效'};
   return {state:'current'};
  }
  if(b.status&&RECEIPT_COMMITTED.includes(b.status))return {state:'current'};
  if(b.operationId)return {state:'current',reason:'操作回执本身是当前事实；是否构成进展由 verification 表达'};
  if(b.digest)return {state:'current'};
  if(row.source_ref)return {state:'current'};
  return {state:'unhashed',reason:'没有记录内容摘要，无法复查新鲜度'};
 }
 // 复查整条运行：确定的矛盾标 expired（保留行），读不到只报告不判死。
 refresh(runId){
  const rows=this.db.prepare("SELECT * FROM pf_goal_observations WHERE run_id=? AND status='active'").all(runId);
  const expired=[],unavailable=[];
  for(const row of rows){
   const v=this.validity(row);
   if(v.state==='expired'){OP.dbWrite();this.db.prepare("UPDATE pf_goal_observations SET status='expired' WHERE id=?").run(row.id);
    expired.push({id:row.id,reason:v.reason});}
   else if(v.state==='unreadable'||v.state==='unhashed')unavailable.push({id:row.id,validity:v.state,reason:v.reason});
  }
  return {checked:rows.length,expired,unavailable};
 }
 expire({goalId=null,runId=null,path:file=null,operationId=null,reason=''}={}){
  if(!goalId&&!runId&&!file&&!operationId)fail('失效需要 goalId / runId / path / operationId 至少一项');
  const rows=this.db.prepare(`SELECT o.* FROM pf_goal_observations o JOIN pf_goal_runs r ON r.id=o.run_id
   WHERE o.status='active' AND (? IS NULL OR r.goal_id=?) AND (? IS NULL OR o.run_id=?)`)
   .all(goalId||null,goalId||null,runId||null,runId||null);
  const hit=rows.filter(row=>{
   const b=parse(row.binding,{});
   if(operationId&&b.operationId===operationId)return true;
   if(file){if(b.path===file)return true;if((b.files||[]).some(f=>f.path===file))return true;if(row.source_ref==='file:'+file)return true;}
   return !file&&!operationId;
  });
  if(hit.length){OP.dbWrite();for(const row of hit)this.db.prepare("UPDATE pf_goal_observations SET status='expired' WHERE id=?").run(row.id);}
  return {expired:hit.map(r=>r.id),reason:String(reason||'后续变化使相关证据失效（§8.3）')};
 }

 // ── 计数与读取 ────────────────────────────────────────────────────────────
 progress(runId,{recheck=false}={}){
  const refreshed=recheck?this.refresh(runId):null;
  const rows=this.db.prepare('SELECT kind,verification,status,counts_progress,observed_at FROM pf_goal_observations WHERE run_id=? ORDER BY observed_at').all(runId);
  const out={total:rows.length,effective:0,declared:0,failed:0,unreconciled:0,expired:0,nonProgress:0,
   lastEffectiveAt:null,byKind:{},refreshed};
  for(const row of rows){
   if(row.status!=='active'){out.expired++;continue;}
   if(row.verification==='unreconciled'){out.unreconciled++;continue;}
   if(!PROGRESS_KINDS.has(row.kind)){out.nonProgress++;continue;}
   if(row.counts_progress){out.effective++;out.byKind[row.kind]=(out.byKind[row.kind]||0)+1;out.lastEffectiveAt=row.observed_at;}
   else if(row.verification==='declared')out.declared++;
   else out.failed++; // verified 但未计进展：失败回执等
  }
  return out;
 }
 list(runId,{status='active'}={}){
  const rows=(status?this.db.prepare('SELECT * FROM pf_goal_observations WHERE run_id=? AND status=? ORDER BY observed_at').all(runId,status)
   :this.db.prepare('SELECT * FROM pf_goal_observations WHERE run_id=? ORDER BY observed_at').all(runId));
  return rows.map(row=>({...row,binding:parse(row.binding,{}),countsProgress:!!row.counts_progress,
   validity:this.validity(row).state}));
 }
 // §8.3 完成条件：逐条验收条件看证据结构状态。known / absent / unavailable 三态分开（§6.1）。
 evidenceFor(goalId,criterionId=null){
  const links=this.db.prepare('SELECT task_id,criterion_ids FROM pf_goal_task_links WHERE goal_id=?').all(goalId);
  const scoped=links.filter(l=>!criterionId||parse(l.criterion_ids,[]).includes(criterionId));
  const taskIds=[...new Set(scoped.map(l=>Number(l.task_id)))];
  const rows=taskIds.length?this.db.prepare(`SELECT o.* FROM pf_goal_observations o JOIN pf_goal_runs r ON r.id=o.run_id
   WHERE r.goal_id=? AND o.task_id IN (${taskIds.map(()=>'?').join(',')}) ORDER BY o.observed_at`).all(goalId,...taskIds):[];
  const current=[],invalid=[];
  const reasons={missing:0,declared:0,expired:0,unreadable:0,unhashed:0,nonProgress:0};
  for(const row of rows){
   const v=this.validity(row);
   if(v.state==='current'&&row.counts_progress){
    current.push({id:row.id,kind:row.kind,taskId:row.task_id,verification:row.verification,
     countsProgress:true,sourceRef:row.source_ref,finding:row.finding,observedAt:row.observed_at});
    continue;
   }
   // 当前但非进展：已知失败回执、压缩/续跑记录等——是事实，不是正面证据，也不能算“缺失”。
   const reason=v.state==='current'?'nonProgress':v.state;
   reasons[reason]=(reasons[reason]||0)+1;
   invalid.push({id:row.id,kind:row.kind,validity:v.state,verification:row.verification,
    reason:v.state==='current'?'该观察是事实但不构成进展（如失败回执、压缩记录）':v.reason});
  }
  const state=current.length?'known':(reasons.unreadable||reasons.unhashed)?'unavailable':'absent';
  return {goalId,criterionId:criterionId||null,state,linkedTasks:taskIds,current,invalid,reasons,
   note:'结构层区分（缺失/过期/仅自述/未核对）；“来源不支持 / 事实相反”属语义层，由 GF04 的 completion_evidence 判断'};
 }
 // §6.1 证据顺序解析：取最高优先级；同级冲突保留冲突，不做平均分。
 resolve(candidates=[]){
  const rows=candidates.map((c,i)=>({id:c.id??`cand-${i}`,claim:c.claim??c.value??null,
   tier:Number.isFinite(c.tier)?Number(c.tier):TIER_OF[tierOf(c.source)]}));
  if(!rows.length)return {chosen:null,tier:null,conflicts:[],overridden:[],rule:'evidence-precedence'};
  const top=Math.min(...rows.map(r=>r.tier));
  const at=rows.filter(r=>r.tier===top);
  const distinct=[...new Set(at.map(r=>norm(JSON.stringify(r.claim))))];
  const chosen=distinct.length===1?at[0]:null;
  return {chosen:chosen?{id:chosen.id,claim:chosen.claim,tier:chosen.tier}:null,tier:top,
   conflicts:distinct.length>1?at.map(r=>({id:r.id,claim:r.claim,tier:r.tier})):[],
   overridden:rows.filter(r=>r.tier>top).map(r=>({id:r.id,claim:r.claim,tier:r.tier,
    reason:'被更高优先级来源覆盖；不通过平均分掩盖冲突（§6.1）'})),
   rule:'evidence-precedence'};
 }
}
module.exports={GoalEvidence,SOURCE_TIERS,PROGRESS_KINDS,NON_PROGRESS_KINDS,VERIFICATIONS,VALIDITY,screenText,tierOf};
