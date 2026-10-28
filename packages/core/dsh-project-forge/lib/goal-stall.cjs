'use strict';
// GF06（主文档 §7 + §14 GA03/GA04/GA05/GA06/GA21）：停滞识别与有界纠偏。
// ── 计数口径（§7）─────────────────────────────────────────────────────
//  * 有效进展只认「有来源、可核对」的观察：GF03 已判定 counts_progress=1 的才计数。
//    没改文件但定位到新原因且有来源，同样算进展（GA03）；仅自述“已推进”只算声明。
//  * 刷修订号、改 progress、复述计划、重读同一内容、压缩、续跑消息、重复读、重复改计划
//    都是记录事实，不是进展，不重置停滞计数（GA04）。
//  * 窗口 = 有机会产出结果的执行阶段。等待真实结果的窗口不计失败窗口（GA05）。
//  * 记账口径：结算取“上一个已关闭窗口之后”的有效进展，且不重复计已计过的观察——
//    窗口之间产生的进展（含等待期间完成的工作）不会被漏记成停滞。
//  * 计数与重试落 SQLite：跨会话、跨暂停/接力/重启保留（GA21）。
// ── 有界纠偏（§7，工程策略而非 JEV 阈值）──────────────────────────────
//  第 1 个无进展窗口：指出具体缺口 + 建议动作（例如先跑当前版本检查再核对）。
//  第 2 个：要求换方法或拆小任务；同一操作重试预算耗尽也在这里提示。
//  第 3 个：当前项标记待处理（pendingReview），改做独立任务；没有独立任务就形成阻塞报告。
// ── 重试预算（§7）────────────────────────────────────────────────────
//  失败操作有独立预算；progress 刷屏不能清零，只有该操作的成功回执才清除（noteSuccess）。
// ── JEV 接缝（§7 首段）───────────────────────────────────────────────
//  progress_relevance / progress_novelty 可被提问与记录，但阈值未标定（uncalibrated-1）时
//  只作参考：advisory 永不改动计数、也不产生动作（§6.3 compositionPolicy 6）。
const {createHash}=require('node:crypto');
const OP=require('./operations.cjs');
const fail=(message,code='STALL_POLICY')=>{throw Object.assign(new Error(message),{code});};
const now=()=>new Date().toISOString();
const parse=(v,fb)=>{try{return typeof v==='string'?JSON.parse(v):v??fb;}catch{return fb;}};
const rid=prefix=>prefix+'-'+createHash('sha256').update(prefix+'|'+now()+'|'+Math.random()).digest('hex').slice(0,12);

const WINDOW_OUTCOMES=['open','progress','no-progress','waiting','blocked','suspended'];
const SUSPEND_KINDS=['stop','pause','abort','error','capacity','budget','ownership','interrupt'];
const DEFAULT_POLICY={retryBudget:2,maxTier:3,windowLimit:8};

class GoalStall {
 constructor({goalStore,evidence=null,judgments=null,policy=null,clock=()=>Date.now()}={}){
  if(!goalStore||!goalStore.db)fail('GoalStall 需要已构造的 GoalStore','STALL_CONFIG');
  this.goals=goalStore;this.db=goalStore.db;this.evidence=evidence;this.judgments=judgments;
  this.clock=clock;this.policy={...DEFAULT_POLICY,...(policy||{})};
  this.db.exec(`CREATE TABLE IF NOT EXISTS pf_goal_windows(
    id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,run_id TEXT NOT NULL,task_id INTEGER,
    session_id TEXT NOT NULL DEFAULT '',generation TEXT NOT NULL DEFAULT '',
    opened_at TEXT NOT NULL,closed_at TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL DEFAULT 'open',effective INTEGER NOT NULL DEFAULT 0,
    progress_ids TEXT NOT NULL DEFAULT '[]',stall_count INTEGER NOT NULL DEFAULT 0,
    tier INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL DEFAULT '',stop_seq TEXT NOT NULL DEFAULT '');
   CREATE INDEX IF NOT EXISTS pf_goal_windows_run ON pf_goal_windows(run_id);
   CREATE INDEX IF NOT EXISTS pf_goal_windows_task ON pf_goal_windows(goal_id,task_id);
   CREATE TABLE IF NOT EXISTS pf_goal_stalls(
    goal_id TEXT NOT NULL,task_id INTEGER NOT NULL DEFAULT 0,count INTEGER NOT NULL DEFAULT 0,
    tier INTEGER NOT NULL DEFAULT 0,last_reason TEXT NOT NULL DEFAULT '',last_window_id TEXT NOT NULL DEFAULT '',
    pending_review INTEGER NOT NULL DEFAULT 0,last_report TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL,
    PRIMARY KEY(goal_id,task_id));
   CREATE TABLE IF NOT EXISTS pf_goal_retries(
    goal_id TEXT NOT NULL,task_id INTEGER NOT NULL DEFAULT 0,operation_key TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,budget INTEGER NOT NULL DEFAULT 2,exhausted INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL,
    PRIMARY KEY(goal_id,task_id,operation_key));`);
 }

 // ── 窗口台账 ──────────────────────────────────────────────────────────
 // 窗口在“允许产出结果的轮次”打开，在收尾/等待/挂起时关闭。重复打开是幂等的：
 // 同一 run 同时只允许一个未关闭窗口（事件重复投递不叠加，GA26）。
 openWindow(run,{taskId=null,sessionId=''}={}){
  const live=this.db.prepare("SELECT * FROM pf_goal_windows WHERE run_id=? AND closed_at='' ORDER BY opened_at DESC").get(run.id);
  if(live)return {...live,progress_ids:parse(live.progress_ids,[]),reused:true};
  const id=rid('win');
  OP.dbWrite();
  this.db.prepare(`INSERT INTO pf_goal_windows(id,goal_id,run_id,task_id,session_id,generation,opened_at,closed_at,outcome,effective,progress_ids,stall_count,tier,reason,stop_seq)
   VALUES(?,?,?,?,?,?,?,'','open',0,'[]',0,0,'','')`)
   .run(id,run.goal_id,run.id,taskId==null?null:Number(taskId),String(sessionId||''),String(run.generation||''),now());
  return {...this.db.prepare('SELECT * FROM pf_goal_windows WHERE id=?').get(id),progress_ids:[],reused:false};
 }
 openWindowFor(run,{sessionId=''}={}){
  const live=this.db.prepare("SELECT * FROM pf_goal_windows WHERE run_id=? AND closed_at='' ORDER BY opened_at DESC").get(run.id);
  if(live)return {...live,progress_ids:parse(live.progress_ids,[])};
  // 没有打开过窗口（例如 run 由别处启动）时不丢账：补一个从 run 启动算起的窗口。
  const id=rid('win');
  OP.dbWrite();
  this.db.prepare(`INSERT INTO pf_goal_windows(id,goal_id,run_id,task_id,session_id,generation,opened_at,closed_at,outcome,effective,progress_ids,stall_count,tier,reason,stop_seq)
   VALUES(?,?,?,?,?,?,?,'','open',0,'[]',0,0,'','')`)
   .run(id,run.goal_id,run.id,null,String(sessionId||run.executor_session_id||''),String(run.generation||''),String(run.started_at||now()));
  return {...this.db.prepare('SELECT * FROM pf_goal_windows WHERE id=?').get(id),progress_ids:[],recovered:true};
 }
 // 记账边界：上一个已关闭窗口的关闭时间（没有就用 run 启动时间）。窗口之间产生的有效进展
 // （例如等待期间跑完的检查）归到下一次结算，避免“明明有进展却判停滞”的误罚。
 unattributedSince(run){
  const prev=this.db.prepare("SELECT closed_at FROM pf_goal_windows WHERE run_id=? AND closed_at!='' ORDER BY closed_at DESC LIMIT 1").get(run.id);
  return String(prev?.closed_at||run.started_at||'');
 }
 // 待记账的有效进展：counts_progress=1 且仍有效（GF03 已完成来源与三态判定），且没有被任何窗口计过。
 effectiveObservations(runId,{since='',taskId=null}={}){
  const rows=this.db.prepare(`SELECT id,task_id,kind,source_ref,finding,observed_at FROM pf_goal_observations
   WHERE run_id=? AND counts_progress=1 AND status='active' AND observed_at>=? ORDER BY observed_at`).all(runId,String(since||''));
  const claimed=new Set(this.db.prepare('SELECT progress_ids FROM pf_goal_windows WHERE run_id=?').all(runId)
   .flatMap(r=>parse(r.progress_ids,[])));
  return rows.filter(r=>!claimed.has(r.id)).filter(r=>taskId==null||r.task_id==null||Number(r.task_id)===Number(taskId));
 }
 // 非进展事实留痕：压缩/续跑/重读/复述计划/失败回执等出现多少次都不改计数（GA04）。这是审计痕迹，不参与记账。
 nonProgressCount(runId,since=''){
  return this.db.prepare('SELECT COUNT(*) AS n FROM pf_goal_observations WHERE run_id=? AND counts_progress=0 AND observed_at>=?')
   .get(runId,String(since||'')).n;
 }
 stallRow(goalId,taskId){return this.db.prepare('SELECT * FROM pf_goal_stalls WHERE goal_id=? AND task_id=?').get(goalId,Number(taskId)||0)||null;}
 // 计数是“连续无有效进展窗口数”。只有有效进展才归零；用户的暂停/等待不归零也不加一。
 reset(goalId,taskId=null){
  OP.dbWrite();
  this.db.prepare(`INSERT INTO pf_goal_stalls(goal_id,task_id,count,tier,last_reason,last_window_id,pending_review,last_report,updated_at)
   VALUES(?,?,0,0,'','',0,'',?) ON CONFLICT(goal_id,task_id) DO UPDATE SET count=0,tier=0,pending_review=0,last_reason='',updated_at=excluded.updated_at`)
   .run(goalId,Number(taskId)||0,now());
  return this.stallRow(goalId,taskId);
 }
 bump(goalId,taskId,{reason='',windowId=''}={}){
  const cur=this.stallRow(goalId,taskId),count=(cur?.count||0)+1,tier=Math.min(this.policy.maxTier,count),pending=tier>=this.policy.maxTier?1:(cur?.pending_review||0);
  OP.dbWrite();
  this.db.prepare(`INSERT INTO pf_goal_stalls(goal_id,task_id,count,tier,last_reason,last_window_id,pending_review,last_report,updated_at)
   VALUES(?,?,?,?,?,?,?,'',?) ON CONFLICT(goal_id,task_id) DO UPDATE SET count=excluded.count,tier=excluded.tier,
   last_reason=excluded.last_reason,last_window_id=excluded.last_window_id,pending_review=excluded.pending_review,updated_at=excluded.updated_at`)
   .run(goalId,Number(taskId)||0,count,tier,String(reason||''),String(windowId||''),pending,now());
  return this.stallRow(goalId,taskId);
 }
 // 关闭窗口：这是“本窗口有没有产出”的唯一判定点。
 // outcome：turn-end（默认）| waiting（等真实结果）| blocked | suspended（用户/预算/归属硬门槛）
 closeWindow(run,{taskId=null,sessionId='',outcome='turn-end',reason='',stopSeq=''}={}){
  const w=this.openWindowFor(run,{sessionId});
  const asked=String(outcome||'turn-end');
  if(asked==='open')fail('关闭窗口需要明确的结果类型');
  // turn-end 是“真的收尾”，要结算；waiting/blocked 与各类挂起（用户停止、插话、预算、重启等）只留痕不动计数。
  const kind=SUSPEND_KINDS.includes(asked)?'suspended':asked;
  if(!['turn-end','waiting','blocked','suspended'].includes(kind))fail('未知窗口结果：'+asked);
  const eff=this.effectiveObservations(run.id,{since:this.unattributedSince(run),taskId:taskId??w.task_id});
  const nonProgress=this.nonProgressCount(run.id,this.unattributedSince(run));
  // 等待/挂起/受阻都不是“无进展窗口”：不动计数（GA05），只留痕。
  if(kind!=='turn-end'){
   OP.dbWrite();
   this.db.prepare(`UPDATE pf_goal_windows SET closed_at=?,outcome=?,effective=?,progress_ids=?,stall_count=?,tier=?,reason=?,stop_seq=? WHERE id=? AND closed_at=''`)
    .run(now(),kind,eff.length?1:0,JSON.stringify(eff.map(e=>e.id)),this.stallRow(run.goal_id,taskId)?.count||0,this.stallRow(run.goal_id,taskId)?.tier||0,String(reason||kind),String(stopSeq||''),w.id);
   return this.result(run,{window:{...w,outcome:kind,closed:true},taskId,effective:eff,counted:false,nonProgress,kind,reason,outcome:kind});
  }
  if(eff.length){
   const row=this.reset(run.goal_id,taskId);
   OP.dbWrite();
   this.db.prepare(`UPDATE pf_goal_windows SET closed_at=?,outcome='progress',effective=1,progress_ids=?,stall_count=0,tier=0,reason=?,stop_seq=? WHERE id=? AND closed_at=''`)
    .run(now(),JSON.stringify(eff.map(e=>e.id)),`有效进展 ${eff.length} 条：${[...new Set(eff.map(e=>e.kind))].join('/')}`,String(stopSeq||''),w.id);
   return this.result(run,{window:{...w,outcome:'progress',closed:true},taskId,effective:eff,counted:true,nonProgress,kind:'progress',reset:true,count:row?.count||0,tier:row?.tier||0});
  }
  const row=this.bump(run.goal_id,taskId,{reason:reason||'本窗口没有可核对的有效进展',windowId:w.id});
  OP.dbWrite();
  this.db.prepare(`UPDATE pf_goal_windows SET closed_at=?,outcome='no-progress',effective=0,progress_ids='[]',stall_count=?,tier=?,reason=?,stop_seq=? WHERE id=? AND closed_at=''`)
   .run(now(),row.count,row.tier,String(reason||'本窗口没有可核对的有效进展'),String(stopSeq||''),w.id);
  return this.result(run,{window:{...w,outcome:'no-progress',closed:true},taskId,effective:[],counted:true,nonProgress,kind:'no-progress',count:row.count,tier:row.tier,pendingReview:!!row.pending_review});
 }
 // 纠偏动作与指令：action 决定调度器下一步（correct=继续但带纠偏；switch=改独立任务；report=写阻塞报告）。
 result(run,{window,taskId,effective,counted,nonProgress,kind,reason='',count=null,tier=null,reset=false}={}){
  const row=this.stallRow(run.goal_id,taskId)||{count:0,tier:0,pending_review:0,last_report:''};
  const state={count:count??row.count,tier:tier??row.tier,pendingReview:!!row.pending_review};
  const retries=this.retries(run.goal_id,taskId);
  const exhausted=retries.filter(r=>r.exhausted);
  const linked=new Set(this.db.prepare('SELECT task_id FROM pf_goal_task_links WHERE goal_id=?').all(run.goal_id).map(r=>Number(r.task_id)));
  // kind 是“已记录口径”（no-progress/progress/waiting/blocked/suspended）：第 3 档与受阻才需要独立任务候选。
  const wantsIndependent=kind==='blocked'||(kind==='no-progress'&&counted&&state.tier>=this.policy.maxTier);
  const independent=wantsIndependent
   ?this.independentCandidates({todos:this.lastTodos||[],currentTaskId:taskId,sessionId:run.executor_session_id,
     linked:linked.size?linked:null}):[];
  let action='none';
  if(kind==='no-progress'&&counted&&state.tier>0)action=state.tier>=this.policy.maxTier?(independent.length?'switch':'report'):'correct';
  if(kind==='blocked')action=independent.length?'switch':'report';
  const detail={kind,taskId,taskSeq:this.lastCurrent?.seq??null,taskTitle:this.lastCurrent?.title??'',progress:this.lastProgress||null,effective,state,retries,exhausted,independent,reason};
  const directive=action==='none'?null:this.directive(state.tier,detail);
  return {window,goalId:run.goal_id,taskId:taskId??null,kind,counted,nonProgress,effective,state,retries,exhausted,independent,action,directive,reset};
 }
 // ── 独立任务与阻塞报告（§7 第三级 / GA06）──────────────────────────────
 // 只从“待办、依赖已满足、未被别人持有”的任务里选；按稳定次序（seq）回退，不按标题猜关联。
 independentCandidates({todos=[],currentTaskId=null,linked=null,sessionId=''}={}){
  const done=new Set(todos.filter(t=>t.status==='done').map(t=>Number(t.id)));
  const scope=linked&&linked.size?t=>linked.has(Number(t.id)):()=>true;
  return todos.filter(t=>{
   if(Number(t.id)===Number(currentTaskId))return false;
   if(!scope(t))return false;
   if(t.status!=='pending')return false;
   if(t.owner&&t.owner!==sessionId)return false;            // 不抢别人持有的任务（§8.1）
   const deps=(t.dependencies||[]).map(Number);
   return deps.every(id=>done.has(id))&&!(t.evidence||[]).length;
  }).sort((a,b)=>a.seq-b.seq).map(t=>({taskId:Number(t.id),seq:t.seq,title:t.title,status:t.status}));
 }
 blockedReport({goalId,taskId=null,taskSeq=null,taskTitle='',reason='',retries=[],progress=null}={}){
  const lines=[`阻塞报告：任务${taskSeq?` #${taskSeq}`:' '}「${taskTitle||'当前项'}」连续 ${this.stallRow(goalId,taskId)?.count||0} 个窗口没有有效进展，已标记待处理。`,
   `原因：${reason||'多次尝试后没有可核对的新进展'}`];
  const eff=progress&&Number.isFinite(progress.effective)?`有效证据 ${progress.effective} 条`:'无可核对证据';
  lines.push(`证据现状：${eff}${progress?.lastEffectiveAt?`；最近一条 ${progress.lastEffectiveAt}`:''}`);
  const bad=(retries||[]).filter(r=>r.exhausted);
  if(bad.length)lines.push(`重试预算已耗尽：${bad.map(r=>`${r.operation_key}(${r.attempts}/${r.budget})`).join('、')} —— 不要重复同一操作。`);
  lines.push('需要：换方法/拆任务的具体替代方案，或由用户决定取舍。此报告不改变目标授权，也不自动完成任何条件。');
  const text=lines.join('\n');
  OP.dbWrite();
  this.db.prepare(`INSERT INTO pf_goal_stalls(goal_id,task_id,count,tier,last_reason,last_window_id,pending_review,last_report,updated_at)
   VALUES(?,?,0,0,'','',1,?,?) ON CONFLICT(goal_id,task_id) DO UPDATE SET pending_review=1,last_report=excluded.last_report,updated_at=excluded.updated_at`)
   .run(goalId,Number(taskId)||0,text,now());
  return {text,createdAt:now(),pendingReview:true};
 }
 directive(tier,detail={}){
  const {kind='',taskSeq,taskTitle,effective=[],exhausted=[],independent=[]}=detail;
  // 受阻的任务不是“停滞”：不累计档位，直接给独立任务或阻塞报告（GA06）。
  if(kind==='blocked'){
   const pickBlocked=independent[0];
   return `任务${taskSeq?` #${taskSeq}「${taskTitle}」`:''}受阻：不继续硬推（受阻不计入停滞档位）。`
    +(pickBlocked?`改做独立任务 #${pickBlocked.seq}「${pickBlocked.title}」（依赖已满足、无人持有；认领仍走 TaskAction start）。`
    :'当前计划里没有可独立推进的任务：请形成阻塞报告（缺什么、需要谁决定、可替代方案）。');
  }
  const head=`连续 ${detail.state?.count||tier} 个窗口没有有效进展`;
  const eff=effective.length?`本窗口有效证据 ${effective.length} 条`:'本窗口没有新的可核对证据';
  if(tier<=1)
   return `${head}（任务${taskSeq?` #${taskSeq}「${taskTitle}」`:''}）。${eff}。缺口：先给当前版本的可核对结果。建议动作：① 运行当前版本的检查/测试并把回执落账；② 或提交带来源的新发现（文件摘要、定位到的原因、已排除的假设）——没改文件但有来源同样算进展；③ 若确实在等外部条件，登记等待而不是空转。`;
  if(tier===2){
   const tail=exhausted.length?`同一操作已重试 ${exhausted.map(r=>`${r.operation_key} ${r.attempts}/${r.budget}`).join('、')} 未果：先换方法或写阻塞报告，不要重复同一操作。`:'';
   return `${head}：要求更换方法或拆小任务。可选：① 换实现路径、工具或数据来源；② 把当前任务拆成可独立验证的小步，先做最小复现；③ 定位并排除一个假设（有来源即算进展）。${tail}`;
  }
  const pick=independent[0];
  return `${head}：任务${taskSeq?` #${taskSeq}「${taskTitle}」`:''}已标记待处理（pending-review），不再继续硬推。`
   +(pick?`改做独立任务 #${pick.seq}「${pick.title}」（依赖已满足、无人持有；认领仍走 TaskAction start，不重新认领已完成的项）。`
   :`当前计划里没有可独立推进的任务：请形成阻塞报告（写清缺什么、需要谁决定、替代方案），不要空转重试。`);
 }
 // ── 失败操作重试预算（§7）────────────────────────────────────────────
 noteRetry({goalId,taskId=null,operationKey,error='',budget=null}={}){
  if(!goalId||!operationKey)fail('重试记账需要 goalId 与 operationKey');
  const key=String(operationKey),cap=Number(budget||this.policy.retryBudget),tk=Number(taskId)||0;
  const cur=this.db.prepare('SELECT * FROM pf_goal_retries WHERE goal_id=? AND task_id=? AND operation_key=?').get(goalId,tk,key);
  const attempts=(cur?.attempts||0)+1,exhausted=attempts>=cap?1:0;
  OP.dbWrite();
  this.db.prepare(`INSERT INTO pf_goal_retries(goal_id,task_id,operation_key,attempts,budget,exhausted,last_error,updated_at)
   VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(goal_id,task_id,operation_key) DO UPDATE SET attempts=excluded.attempts,
   budget=excluded.budget,exhausted=excluded.exhausted,last_error=excluded.last_error,updated_at=excluded.updated_at`)
   .run(goalId,tk,key,attempts,cap,exhausted,String(error||''),now());
  return {operationKey:key,attempts,budget:cap,exhausted:!!exhausted,
   reason:exhausted?`同一操作已重试 ${attempts}/${cap} 次：改方法或写阻塞报告，不要重复`:`重试 ${attempts}/${cap}`};
 }
 // 只有该操作自己的成功回执才清零——“刚又改了 progress”不清零（§7）。
 noteSuccess({goalId,taskId=null,operationKey}={}){
  if(!goalId||!operationKey)return {cleared:false,reason:'没有可清理的重试记录'};
  const tk=Number(taskId)||0;
  const cur=this.db.prepare('SELECT * FROM pf_goal_retries WHERE goal_id=? AND task_id=? AND operation_key=?').get(goalId,tk,String(operationKey));
  if(!cur)return {cleared:false,reason:'该操作没有失败记录'};
  OP.dbWrite();
  this.db.prepare('DELETE FROM pf_goal_retries WHERE goal_id=? AND task_id=? AND operation_key=?').run(goalId,tk,String(operationKey));
  return {cleared:true,operationKey:String(operationKey),attempts:cur.attempts};
 }
 retries(goalId,taskId=null){
  const tk=taskId==null?null:Number(taskId)||0;
  const rows=tk==null?this.db.prepare('SELECT * FROM pf_goal_retries WHERE goal_id=? ORDER BY updated_at').all(goalId)
   :this.db.prepare('SELECT * FROM pf_goal_retries WHERE goal_id=? AND task_id=? ORDER BY updated_at').all(goalId,tk);
  return rows.map(r=>({...r,exhausted:!!r.exhausted}));
 }
 // ── 读取面 ────────────────────────────────────────────────────────────
 state(goalId,{taskId=null,windowLimit=null}={}){
  const limit=Number(windowLimit||this.policy.windowLimit);
  const row=this.stallRow(goalId,taskId);
  const windows=this.db.prepare('SELECT * FROM pf_goal_windows WHERE goal_id=? ORDER BY opened_at DESC LIMIT ?').all(goalId,limit)
   .map(w=>({...w,progress_ids:parse(w.progress_ids,[]),effective:!!w.effective}));
  return {goalId,taskId:taskId==null?null:Number(taskId),count:row?.count||0,tier:row?.tier||0,
   pendingReview:!!row?.pending_review,lastReason:row?.last_reason||'',lastReport:row?.last_report||'',
   updatedAt:row?.updated_at||null,windows,retries:this.retries(goalId,taskId),policy:{...this.policy}};
 }
 // 调度器把当前任务清单与进度交给它，纠偏指令才有具体对象（不按标题猜关联）。
 context({todos=null,current=null,progress=null}={}){
  if(Array.isArray(todos))this.lastTodos=todos;
  if(current!==null)this.lastCurrent=current;
  if(progress!==null)this.lastProgress=progress;
  return this;
 }
 // ── JEV 接缝：相关性与新颖性只作参考（阈值未标定不改变计数）────────────
 questionFor(kind,{observation=null,baseline=[],criterion=null,goal=null}={}){
  if(!this.judgments)fail('没有装配判断规格（GoalJudgments）','STALL_JUDGMENT');
  if(!['progress_relevance','progress_novelty'].includes(kind))fail('停滞层只用 progress_relevance / progress_novelty 两类判断');
  // §6.1：没给的必需状态就是 absent，不用 null 顶替成 known（否则会把“读不到”当“已确认没有”）。
  const state=kind==='progress_novelty'?{baselineFindings:baseline,observation}:{observation};
  if(goal!==null&&goal!==undefined)state.goal=goal;
  if(criterion!==null&&criterion!==undefined)state.currentCriterion=criterion;
  const ready=this.judgments.readiness(kind,state);
  if(!ready.ok)return {ok:false,id:kind,state:ready.state,reason:ready.reason};
  return {ok:true,id:kind,version:this.judgments.version(kind),question:this.judgments.compile(kind),state,
   requiredStatePaths:this.judgments.template(kind).requiredStatePaths||[]};
 }
 advisory({run,observationId=null,kind='progress_novelty',judgment=null,policy=null}={}){
  if(!run||!judgment)fail('参考判断需要 run 与 judgment');
  const gate=policy&&typeof policy.semanticAllowed==='function'?policy.semanticAllowed(kind):{allowed:false,reason:'没有决策策略：语义判断不产生动作'};
  const reason=gate.allowed?'已标定：可进入有界纠偏候选':'阈值未标定（uncalibrated-1）：判断只作参考，不改变停滞计数';
  const id=this.goals.decide(run.id,{questionId:kind,questionVersion:judgment.questionVersion||'',
   stateFingerprint:observationId?`obs:${observationId}`:'',provider:judgment.model||'',modelVersion:judgment.model||'',
   rawAnswer:{type:judgment.type,value:judgment.value,noul:judgment.value,probabilities:judgment.probabilities??null},
   usage:{},adoptedRule:'',discardedReason:reason});
  return {recorded:true,id,applied:false,reason};
 }
}
module.exports={GoalStall,WINDOW_OUTCOMES,SUSPEND_KINDS,DEFAULT_POLICY};
