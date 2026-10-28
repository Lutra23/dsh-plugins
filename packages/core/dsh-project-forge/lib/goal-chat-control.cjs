'use strict';
const {BUDGET_PRESETS}=require('./goal-store.cjs');
const {effective}=require('./goal-budget.cjs');
// Explicit chat controls are a code-owned authorization channel. Do not mine
// quotes, documents, questions or old conversation history for permission.
function parseChatControl(text,{hasGoal=false}={}){
 if(typeof text!=='string')return null;
 const value=text.trim();
 if(!value||value.length>600||/[\r\n?？`“”「」"']/.test(value)||/^>/.test(value))return null;
 let action,tail='';
 const slash=/^\/flow\s+(start|resume|pause|stop|status)(?:\s+(.*))?$/i.exec(value);
 if(slash){action=slash[1].toLowerCase();tail=slash[2]||'';}
 else {
  const match=/^(?:请|帮我|你来)?\s*(开启|启动|开始|继续|恢复|暂停|停止|结束|关闭)(?:目标)?心流(?:吧)?(?:[，,；;。！!\s]+(.*)|$)/.exec(value);
  if(match){action=({开启:'start',启动:'start',开始:'start',继续:'resume',恢复:'resume',暂停:'pause',停止:'stop',结束:'stop',关闭:'stop'})[match[1]];tail=match[2]||'';}
  else if(hasGoal&&/^(?:那你|那就|请)?(?:继续|继续吧|接着做)[。！!\s]*$/.test(value))action='resume';
  else if(hasGoal&&/^(?:先)?(?:停一下|暂停一下|暂停)[。！!\s]*$/.test(value))action='pause';
  else if(/^(?:查看|检查|看看)心流(?:状态)?[。！!\s]*$/.test(value))action='status';
 }
 if(!action)return null;
 // Mixed/conditional requests stay in ordinary dialogue for clarification.
 if(/不要|不用|先别|暂不|如果|要是|是否|怎么|如何|什么意思|撤销|比如|例如|示例|测试指令|这句话|这几个字/.test(tail))return null;
 if(['start','resume'].includes(action)&&/停止|暂停|取消|结束心流/.test(tail))return null;
 if(/[-+]\s*\d|\d+\.\d+|(?:最多|上限|预算)\s*[零一二三四五六七八九十百千万两半]|\d+\s*(?:小时|秒|万|k\b)/i.test(tail))return null;
 const budgetOverrides={},budgets={...BUDGET_PRESETS.short};
 const patterns={maxSteps:/(?:最多|上限|预算)?\s*(\d+)\s*步/,maxMinutes:/(?:最多|上限|预算)?\s*(\d+)\s*分钟/,maxCalls:/(?:最多|上限|预算)?\s*(\d+)\s*(?:次续跑|轮续跑)/};
 for(const [key,re] of Object.entries(patterns)){const hits=[...tail.matchAll(new RegExp(re.source,'g'))];if(hits.length>1)return null;if(hits.length){const n=Number(hits[0][1]);if(!Number.isSafeInteger(n)||n<=0||n>BUDGET_PRESETS.long[key])return null;budgets[key]=n;budgetOverrides[key]=n;}}
 return {action,budgets,budgetOverrides,text:value};
}

// Called only with a host-produced record from the current actual user message.
function validateChatSource(source,action,input){
 if(source?.kind!=='user'||source.channel!=='goal-chat'||!source.messageId)throw new Error('需要当前聊天中的用户指令');
 const directive=parseChatControl(source.text,{hasGoal:source.hasGoal===true});
 if(!directive||directive.action!==action)throw new Error('当前用户消息没有授权此心流动作；可在聊天说“开启心流”或“继续心流”');
 return {...input,...(['start','resume'].includes(action)?{budgets:effective(action==='start'?directive.budgets:directive.budgetOverrides,input.budgets||{})}:{})};
}

// One user message cannot authorize another goal, another revision or a second
// resume after a later pause. Save state and receipt in the same transaction.
function chatControlTransaction(db,msg,execute){
 if(msg.source?.channel!=='goal-chat')return execute(msg);
 const input=validateChatSource(msg.source,msg.action,msg.input||{});
 if(msg.action==='status')return execute({...msg,input});
 db.exec('CREATE TABLE IF NOT EXISTS pf_goal_chat_controls(session_id TEXT NOT NULL,message_id TEXT NOT NULL,action TEXT NOT NULL,project_id TEXT NOT NULL,goal_id TEXT NOT NULL,generation TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(session_id,message_id))');
 const prior=db.prepare('SELECT * FROM pf_goal_chat_controls WHERE session_id=? AND message_id=?').get(msg.sessionId,msg.source.messageId);
 if(prior){
  const current=db.prepare('SELECT generation,status FROM pf_goal_runs WHERE goal_id=? ORDER BY started_at DESC,rowid DESC').get(prior.goal_id);
  const goal=db.prepare('SELECT id,revision FROM pf_goals WHERE project_id=? ORDER BY created_at DESC,rowid DESC').get(msg.projectId);
  const saved=JSON.parse(prior.result);
  if(prior.action!==msg.action||prior.project_id!==msg.projectId||!current||current.generation!==prior.generation||goal?.id!==prior.goal_id||goal.revision!==saved.goal.revision||(input.expectedGoalId&&input.expectedGoalId!==prior.goal_id)||current.status!==saved.run.status)throw new Error('这条聊天指令已经使用或运行已变化；请发一条新的心流指令');
  return {...execute({...msg,action:'status',input:{},source:undefined}),replayed:true};
 }
 db.exec('SAVEPOINT goal_chat_control');
 try{
  const result=execute({...msg,input});
  if(result.run)db.prepare('INSERT INTO pf_goal_chat_controls(session_id,message_id,action,project_id,goal_id,generation,result) VALUES(?,?,?,?,?,?,?)').run(msg.sessionId,msg.source.messageId,msg.action,msg.projectId,result.run.goal_id,result.run.generation,JSON.stringify(result));
  db.exec('RELEASE goal_chat_control');return result;
 }catch(e){db.exec('ROLLBACK TO goal_chat_control');db.exec('RELEASE goal_chat_control');throw e;}
}
module.exports={parseChatControl,validateChatSource,chatControlTransaction};
