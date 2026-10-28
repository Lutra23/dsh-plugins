'use strict';
// GF04（主文档 §6.3 返回值路由 + 判断规格 compositionPolicy）：把独立判断组合成有界动作。
// 铁律：
//  * 程序硬拒绝优先：UI 停止/暂停、代际过期、归属冲突、预算用尽、确定性前提失败都盖过任何模型答案（compositionPolicy 1）。
//  * 生命周期先于关系：同批独立意味着关系判断不能撤销同时到达的暂停请求（compositionPolicy 2）。
//  * 有用进展 = 来源有效 + 相关 + 新颖；中间概率是不确定，不是“半进展”（§6.3/§7）。
//  * 阈值只有标定并版本化后才允许语义自动动作；未标定走 observe/assist + 有界升级（compositionPolicy 6）。
//  * 高概率不等于授权：候选选择、范围关系、语义前提都不授予执行许可（compositionPolicy 5）。
const THRESHOLD_VERSION='uncalibrated-1';
const DEFAULT_THRESHOLDS={
 user_lifecycle:{accept:0.8,escalate:0.35},
 user_relation:{accept:0.7,escalate:0.35},
 progress:{yes:0.7,no:0.3},
 scope_relation:{accept:0.75,escalate:0.35},
 precondition_evidence:{accept:0.8,escalate:0.4},
 completion_evidence:{accept:0.9,escalate:0.4},
 next_task:{accept:0.6,prefer:0.15}
};
const CODE_PRECEDENCE=['user-stop','stale-generation','ownership-conflict','budget-exhausted','failed-precondition','cancelled'];
function mid(noul,t){return noul>=t.yes?'yes':(noul<=t.no?'no':'unresolved');}
class DecisionPolicy{
 constructor({thresholds={},calibrated=false,version=THRESHOLD_VERSION,mode='observe'}={}){
  this.thresholds=structuredClone(DEFAULT_THRESHOLDS);
  for(const [k,v] of Object.entries(thresholds))this.thresholds[k]={...this.thresholds[k],...v};
  this.calibrated=!!calibrated;this.thresholdVersion=version;this.mode=mode;
 }
 // compositionPolicy 1：代码裁决永远第一，返回非空即代表模型答案不参与本次动作。
 codePrecedence(state={}){
  for(const rule of CODE_PRECEDENCE){
   if(rule==='user-stop'&&(state.userStop||state.userPause))
    return {decision:state.userStop?'stopped':'paused',rule,source:'code',overridesModel:true,reason:'用户显式停止/暂停由界面即时通道决定，不等待判断'};
   if(rule==='stale-generation'&&state.staleGeneration)
    return {decision:'discard',rule,source:'code',overridesModel:true,reason:'判断期间状态已变化：旧结果丢弃（§5.2）'};
   if(rule==='ownership-conflict'&&state.ownershipConflict)
    return {decision:'discard',rule,source:'code',overridesModel:true,reason:'执行权不在本会话：不做动作'};
   if(rule==='budget-exhausted'&&state.budgetExhausted)
    return {decision:'paused',rule,source:'code',overridesModel:true,reason:'预算硬门槛已到：高概率不能覆盖'};
   if(rule==='failed-precondition'&&state.failedPrecondition)
    return {decision:'blocked',rule,source:'code',overridesModel:true,reason:'确定性前提失败：只影响依赖动作'};
   if(rule==='cancelled'&&state.cancelled)
    return {decision:'cancelled',rule,source:'code',overridesModel:true,reason:'调用方已取消'};
  }
  return null;
 }
 // 未标定时语义动作的边界：observe 只看不动；assist 只做有界动作且必须能升级；autonomous 仍需标定。
 semanticAllowed(kind){
  if(this.mode==='observe')return {allowed:false,mode:this.mode,kind,reason:`observe 模式只记录判断（${kind}），不产生动作`};
  if(this.mode==='assist')return {allowed:true,mode:this.mode,kind,bounded:true,reason:'assist 模式：动作有界且可升级'};
  if(!this.calibrated)return {allowed:false,mode:this.mode,kind,reason:`autonomous 需要已标定阈值（当前 ${this.thresholdVersion}）：不允许自动验收、目标变更与候选选择`};
  return {allowed:true,mode:this.mode,kind,bounded:false,reason:'已标定'};
 }
 lifecycle(answer){
  if(!answer)return {action:'hold',escalate:true,reason:'没有 lifecycle 判断：先不做新自动动作',rule:'lifecycle/missing'};
  const t=this.thresholds.user_lifecycle,c=Number(answer.confidence??0),v=answer.value;
  if(v==='pause'&&c>=t.accept)return {action:'pause',escalate:false,reason:'用户要求暂时停下',rule:'lifecycle/pause'};
  if(v==='stop'&&c>=t.accept)return {action:'stop',escalate:false,reason:'用户要求结束该运行',rule:'lifecycle/stop'};
  if(v==='resume'&&c>=t.accept)return {action:'resume-candidate',escalate:false,needs:['authorization','budget'],
   reason:'用户表达继续意图：仍需代码校验授权与剩余预算',rule:'lifecycle/resume'};
  if(v==='unchanged'&&c>=t.accept)return {action:'none',escalate:false,reason:'消息未改变生命周期',rule:'lifecycle/unchanged'};
  if(v==='unclear')return {action:'hold',escalate:c<t.escalate,reason:'生命周期意图不明：先留住位置并回答可回答内容',rule:'lifecycle/unclear'};
  return {action:'hold',escalate:c<t.escalate,reason:`低置信生命周期判断（${v}@${c.toFixed(2)}）：不执行，按不确定路径处理`,rule:'lifecycle/low-confidence'};
 }
 relation(answer,{lifecycle=null}={}){
  const t=this.thresholds.user_relation,c=Number(answer?.confidence??0),v=answer?.value;
  const pending=lifecycle&&['pause','stop'].includes(lifecycle.action);
  if(!answer||c<t.accept||v==='unclear')
   return {relation:'unclear',action:'answer-and-preserve',reason:'关系不明：回答可回答内容，保留目标位置',rule:'relation/unclear',
    pendingLifecycle:pending};
  const map={direction_change:'scope-review',task_input:'accept-input',status_question:'answer-status',other:'no-op'};
  return {relation:v,action:map[v]||'no-op',reason:`关系=${v}`,rule:'relation/'+v,pendingLifecycle:pending,
   note:pending?'同时存在暂停/停止请求：关系判断不撤销它（compositionPolicy 2）':''};
 }
 // §7/GA03：来源有效 + 相关 + 新颖 → 有用进展；中间概率是不确定，不折算成“半进展”。
 progress({relevance=null,novelty=null,sourceValid=false}={}){
  if(!sourceValid)return {verdict:'not-useful',reason:'来源无效（无回执/无摘要/仅自述）：不重置停滞计数',rule:'progress/source-invalid'};
  const t=this.thresholds.progress;
  const r=relevance?mid(Number(relevance.value),t):'unresolved',n=novelty?mid(Number(novelty.value),t):'unresolved';
  if(r==='yes'&&n==='yes')return {verdict:'useful',relevance:r,novelty:n,reason:'相关且新颖且有来源',rule:'progress/useful'};
  if(r==='no'||n==='no')return {verdict:'not-useful',relevance:r,novelty:n,reason:r==='no'?'与该条件无关':'相对已知基线没有新信息',rule:'progress/not-useful'};
  return {verdict:'unresolved',relevance:r,novelty:n,reason:'概率落在中间带：按不确定处理，不折算成部分进展，也不据此重置停滞',rule:'progress/unresolved'};
 }
 scope(answer){
  if(!answer)return {relation:'unclear',action:'review-locally',reason:'没有范围判断：由代码与用户决定'};
  const t=this.thresholds.scope_relation,c=Number(answer.confidence??0),v=answer.value;
  if(c<t.accept||v==='unclear')return {relation:'unclear',action:'review-locally',escalate:c<t.escalate,reason:'范围关系不明：不自动改计划',rule:'scope/unclear'};
  if(v==='outside_scope')return {relation:v,action:'blocked-outside-scope',reason:'超出确认范围：需要真实用户决定，不能自动扩大授权',rule:'scope/outside',needsUser:true};
  return {relation:v,action:'plan-revise-candidate',grantsPermission:false,reason:'范围内候选修订：仍要过路径/依赖/预算与审计（§8.2）',rule:'scope/'+v};
 }
 precondition(answer){
  if(!answer)return {verdict:'insufficient',blocksDependent:true,reason:'没有前提判断：依赖动作先不做',rule:'precondition/missing'};
  const t=this.thresholds.precondition_evidence,c=Number(answer.confidence??0),v=answer.value;
  if(c<t.accept&&v!=='insufficient')
   return {verdict:'insufficient',blocksDependent:true,escalate:c<t.escalate,reason:`低置信（${v}@${c.toFixed(2)}）：按证据不足处理`,rule:'precondition/low-confidence'};
  if(v==='supports')return {verdict:'supports',blocksDependent:false,reason:'有当前证据支持该语义前提',rule:'precondition/supports'};
  if(v==='contradicts')return {verdict:'contradicts',blocksDependent:true,reason:'证据与该前提直接冲突：依赖动作停下',rule:'precondition/contradicts'};
  return {verdict:'insufficient',blocksDependent:true,reason:'证据不足或未覆盖：先补证据',rule:'precondition/insufficient'};
 }
 // §8.3：逐条条件判断；未标定不得自动通过，人工确认条件保持 pending-review。
 completion(answer,{criterion={},machineChecks={}}={}){
  const needHuman=criterion.category==='human'||machineChecks.pendingHuman;
  const machineOk=machineChecks.ok!==false;
  if(!answer)return {verdict:'unavailable',canAccept:false,reason:'没有完成证据判断'};
  const t=this.thresholds.completion_evidence,c=Number(answer.confidence??0),v=answer.value;
  if(v==='contradicts'&&c>=t.escalate)return {verdict:'contradicts',canAccept:false,reason:'当前证据显示该条件未满足',rule:'completion/contradicts'};
  if(v==='supports'&&c>=t.accept&&machineOk&&!needHuman){
   const gate=this.semanticAllowed('completion');
   return {verdict:'supports',canAccept:false,pendingAcceptance:true,
    reason:gate.allowed?'证据支持且确定性检查通过：可提交验收，仍由代码落账':'证据支持，但'+gate.reason,rule:'completion/supports'};
  }
  if(v==='supports'&&needHuman)return {verdict:'supports',canAccept:false,pendingReview:true,reason:'需要人工确认的条件保持 pending-review，不为无人值守而删除',rule:'completion/pending-human'};
  if(v==='supports'&&!machineOk)return {verdict:'insufficient',canAccept:false,reason:'语义证据不能绕过机器检查',rule:'completion/machine-check'};
  return {verdict:'insufficient',canAccept:false,reason:`证据不足（${v}@${c.toFixed(2)}）：补证据或检查，达到有界上限才问用户`,rule:'completion/insufficient'};
 }
 // 第二阶段候选选择：只能选代码给出的候选；并列时用稳定次序，不因低置信反复追问（GA29）。
 candidateSelection(answer,{candidates=[],order=null}={}){
  if(!candidates.length)return {chosen:null,action:'none',reason:'没有合法候选：进入本地规划，不发明任务',rule:'next/none-candidates'};
  const gate=this.semanticAllowed('selection');
  const seq=order||candidates.map(c=>c.id??c.taskId);
  if(!answer||!answer.value||answer.value==='none')
   return {chosen:null,action:'review-candidates',reason:'判断为 none 或缺失：回到本地候选复核/有界规划',rule:'next/none'};
  const id=String(answer.value).replace(/^task:/,'');
  const hit=candidates.find(c=>String(c.id??c.taskId)===id);
  if(!hit)return {chosen:null,action:'reject',reason:`答案选择了未提供的候选 ${answer.value}：拒绝`,rule:'next/invalid-candidate'};
  const t=this.thresholds.next_task,conf=Number(answer.confidence??0);
  if(conf<t.accept||!gate.allowed){
   const tie=seq[0];
   return {chosen:candidates.find(c=>String(c.id??c.taskId)===String(tie))||hit,tieBreak:true,action:'deterministic-order',
    reason:gate.allowed?`选择置信度不足（${conf.toFixed(2)}）：回退到提供的稳定次序首位，不打断用户（GA29）`:`${gate.reason}：只保留确定性次序`,rule:'next/low-confidence'};
  }
  return {chosen:hit,action:'select',reason:'从提供的候选中选择',rule:'next/select'};
 }
 // 决策落账载荷（GoalStore.decide 用）；没有解释就不生成“JEV 认为因为……”的伪引文（§6.3）。
 recordFor({answer=null,rule='',reason='',discardedReason='',fingerprint='',questionVersion=''}={}){
  return {questionVersion:questionVersion||answer?.questionVersion||'',stateFingerprint:fingerprint,
   rawAnswer:answer?{type:answer.type,value:answer.value,confidence:answer.confidence??null,probabilities:answer.probabilities??null}:{},
   adoptedRule:rule||answer?.rule||'',discardedReason,
   thresholdVersion:this.thresholdVersion,calibrated:this.calibrated,mode:this.mode,reason};
 }
}
module.exports={DecisionPolicy,DEFAULT_THRESHOLDS,THRESHOLD_VERSION,CODE_PRECEDENCE};
