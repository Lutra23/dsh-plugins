'use strict';
// GF05（主文档 §9）：真实用户插话的即时通道与语义分流。
// 固定顺序：
//  ① 代码即时通道（界面停止/暂停）不等待任何判断；
//  ② 真实用户消息到达先阻止新增自动动作（已发出的外部命令不假装撤回）；
//  ③ user_lifecycle 与 user_relation 分开判断、分开消费（同一状态上的两个独立问题）；
//  ④ 停止优先：混合消息（“先停一下”+“做到哪了”）停止照做，同时仍回答状态问题；
//  ⑤ 信息不足时先回答可回答内容并保留目标位置，只有影响下一动作的歧义才澄清。
// 铁律：模型答案不能撤销同时到达的停止请求（compositionPolicy 2）；未标定时不产生语义自动动作。
const {screenText}=require('./goal-evidence.cjs');
const now=()=>new Date().toISOString();
const fail=(message,code='INTERRUPT_POLICY')=>{throw Object.assign(new Error(message),{code});};
const TERMINAL=['stopped','completed'];

class InterruptHandler{
 constructor({goals,scheduler,policy,focus,evidence=null,judgments=null,clock=now}={}){
  if(!scheduler||!policy||!focus)fail('插话处理需要 scheduler、decision policy 与 GoalFocus','INTERRUPT_CONFIG');
  this.goals=goals||null;this.scheduler=scheduler;this.policy=policy;this.focus=focus;
  this.evidence=evidence;this.judgments=judgments;this.clock=clock;
 }

 // ── ① 代码即时通道：不等判断 ───────────────────────────────────────────────
 immediate(sessionId,action,reason){
  if(!['stop','pause'].includes(action))fail('即时通道只处理 stop/pause（其它含义走语义判断）');
  const result=this.scheduler.tick(sessionId,{[action]:true,reason:reason||(action==='stop'?'用户点击停止':'用户点击暂停')});
  return {decision:result.decision,run:result.run||null,source:'code',waitedForJudgment:false,judgmentUsed:false};
 }
 // 外部文档/引用里的“指令”只做标注（GA34），不当生命周期依据。
 screen(text){return screenText(text);}

 // ── ③ 生命周期与关系分开消费 ──────────────────────────────────────────────
 assess({judged={}}={}){
  const lifecycle=this.policy.lifecycle(judged.user_lifecycle);
  const relation=this.policy.relation(judged.user_relation,{lifecycle});
  return {lifecycle,relation,
   judged:{lifecycle:!!judged.user_lifecycle,relation:!!judged.user_relation},
   stopPriority:['stop','pause'].includes(lifecycle.action),
   relationCannotRevokeLifecycle:!!relation.pendingLifecycle,
   note:relation.pendingLifecycle?'关系判断不能撤销同时到达的停止/暂停请求（compositionPolicy 2）':''};
 }
 // 给具备 JEV 调用方的插话问题：两类分开、各自成批（requiredStatePaths 不同就不混批）。
 questions({messageId=null,named={}}={}){
  if(!this.judgments)return {available:false,ids:[],batches:[],skipped:[],reason:'未装配判断规格（GoalJudgments）：本层只做代码侧处理'};
  const items=['user_lifecycle','user_relation'].map(id=>({id,ref:messageId,state:named}));
  const planned=this.judgments.plan(items);
  return {available:true,ids:items.map(i=>i.id),batches:planned.batches||planned,signatures:(planned.batches||[]).map(b=>b.signature),skipped:planned.skipped||[]};
 }
 // 判断记录（分开两条；没有判断就不写伪引文）。
 record(run,questionId,answer,{rule='',reason='',fingerprint=''}={}){
  if(!this.goals||!run)return null;
  const rec=this.policy.recordFor({answer,rule,reason,fingerprint,
   questionVersion:this.judgments?this.judgments.version(questionId):''});
  const id=this.goals.decide(run.id,{questionId,questionVersion:rec.questionVersion,stateFingerprint:rec.stateFingerprint,
   provider:answer?.provider||'',modelVersion:answer?.modelVersion||'',rawAnswer:rec.rawAnswer,usage:answer?.usage||{},
   adoptedRule:rec.adoptedRule,discardedReason:rec.discardedReason});
  return {id,questionId,questionVersion:rec.questionVersion,adoptedRule:rec.adoptedRule,thresholdVersion:rec.thresholdVersion,
   calibrated:rec.calibrated,mode:rec.mode};
 }

 // ── ②④⑤ 真实用户消息到达 ─────────────────────────────────────────────────
 handle(sessionId,{messageId,text='',judged={},memo=null,snapshot={},cancelOperations=false,synthetic=false}={}){
  // §4/§9：没有 messageId 就没有插话——模型输出、工具事件、镜像同步不能伪装成用户消息。
  if(!messageId)fail('插话处理需要真实用户消息（messageId）','NOT_USER_MESSAGE');
  if(cancelOperations)fail('插话不能假装撤回已发出的外部命令：只能阻止新增自动动作','INTERRUPT_CANNOT_CANCEL');
  const seen=this.scheduler.latestRun?.(sessionId);
  const run=this.scheduler.activeRun(sessionId)||(seen?.status==='paused'&&seen.pause_origin==='user-input'?seen:null);
  const {lifecycle,relation,judged:hasJudgment,stopPriority,relationCannotRevokeLifecycle,note}=this.assess({judged});
  const decisions=[];
  if(run){
   if(judged.user_lifecycle)decisions.push(this.record(run,'user_lifecycle',judged.user_lifecycle,{rule:lifecycle.rule,reason:lifecycle.reason,fingerprint:snapshot.fingerprint||''}));
   if(judged.user_relation)decisions.push(this.record(run,'user_relation',judged.user_relation,{rule:relation.rule,reason:relation.reason,fingerprint:snapshot.fingerprint||''}));
  }
  // 焦点先切到 userFocus：任务身份、activation 与缓存保留（§9）。
  const switched=this.focus.onUserMessage(sessionId,{messageId,projectId:snapshot.projectId||null,
   goalId:run?.goal_id||null,runId:run?.id||null,lifecycle:lifecycle.action,relation:relation.relation,synthetic:!!synthetic});
  // Memo 能力上报只影响“是否降级”的显示，不改变焦点的存储语义（§9：旧 Memo 保持旧行为并显示降级）。
  const focus={...switched,memo:this.focus.memoState(memo)};
  // 生命周期落账：语义动作先过模式闸门（未标定的 observe 只记录，不自动停）；否则只挡住新增自动动作。
  const gate=this.policy.semanticAllowed('lifecycle');
   // Lowering autonomy does not need permission to continue. Unknown intent must
   // remain paused; observe-only judgments never authorize automatic restoration.
   const applyLifecycle=['stop','pause'].includes(lifecycle.action);
  let applied='none',resultRun=run||null;
  if(run){
   if(applyLifecycle&&lifecycle.action==='stop'){const r=this.scheduler.tick(sessionId,{stop:true,reason:'用户要求结束该运行（lifecycle/stop）',lifecycle:'stop'});applied='stopped';resultRun=r.run;}
   else if(applyLifecycle&&lifecycle.action==='pause'){const r=this.scheduler.tick(sessionId,{pause:true,reason:'用户要求先停一下（lifecycle/pause）',lifecycle:'pause'});applied='paused';resultRun=r.run;}
   else {const r=this.scheduler.tick(sessionId,{user:true,messageId,lifecycle:lifecycle.action,relation:relation.relation,
    resumeAfterReply:gate.allowed&&lifecycle.action==='none'},snapshot);applied='blocked-new-actions';resultRun=r.run;}
  }
  const wouldAutoContinue=!!resultRun&&!TERMINAL.includes(resultRun.status)&&applied!=='paused'&&applied!=='stopped';
  const lifecycleJudged=!!judged.user_lifecycle;
  // 只有“已经判断过但不确定”的歧义、且它确实影响下一动作时才追问；完全没有判断时按代码路径处理，不追加打断。
  const clarify=lifecycleJudged&&lifecycle.action==='hold'&&!!lifecycle.escalate&&wouldAutoContinue&&relation.action==='answer-and-preserve';
  return {interrupted:true,messageId,judged:hasJudgment.lifecycle||hasJudgment.relation,judgedKinds:hasJudgment,
   // 宿主既有分支按 decision 判断是否撤下自动续跑：停止/暂停都要撤下，插话挂起也撤下（回答期间不自动跑）。
   decision:applied==='stopped'?'stopped':'paused',
   codeScreen:this.screen(text),
   lifecycle,relation,stopPriority,relationCannotRevokeLifecycle,note,applied,run:resultRun,focus,lifecycleGate:gate,
    pendingUserConfirmation:applied==='blocked-new-actions'&&resultRun?.pause_origin==='user-input',
   reply:{answerStatus:relation.action==='answer-status'||relation.relation==='status_question',
    answerAndPreserve:relation.action==='answer-and-preserve'||relation.relation==='unclear',
    clarify,clarifyQuestion:clarify?'这条消息要我先停下当前目标运行，还是继续当前任务？':null,
    reason:clarify?'生命周期意图不明且会影响下一动作：只问这一个问题':
     (!gate.allowed&&['stop','pause'].includes(lifecycle.action)
      ?`判断为 ${lifecycle.action}，但当前模式 ${gate.mode} 不自动执行语义动作（${gate.reason}）：只记录并保留位置，界面停止按钮仍走代码即时通道`
      :(lifecycleJudged?`生命周期=${lifecycle.action}，关系=${relation.relation}`:'没有生命周期判断：按代码路径回答并保留目标位置，不追加打断'))},
   irreversible:{cancelled:false,waitedForJudgment:false,
    note:'已发出的外部命令不能假装撤回；本次只阻止新增自动动作'},
   decisions};
 }

 // ── ⑤ 回答结束：目标仍允许继续才恢复同一任务 ──────────────────────────────
 canRestore(sessionId,{lifecycle=null}={}){
  if(lifecycle&&['stop','pause'].includes(lifecycle))return {restore:false,reason:'用户要求停止/暂停：不自动恢复'};
  const run=this.scheduler.activeRun(sessionId);
  if(!run)return {restore:false,reason:'没有在途目标运行'};
  if(run.status!=='paused'||run.pause_origin!=='interrupt')
   return {restore:false,reason:`运行状态 ${run.status}/${run.pause_origin||'—'} 不是插话挂起：不自动恢复`,run};
  return {restore:true,run,focus:this.focus.taskFocus(sessionId)};
 }
}
module.exports={InterruptHandler};
