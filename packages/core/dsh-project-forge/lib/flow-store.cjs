'use strict';
const {randomUUID}=require('node:crypto');
const OP=require('./operations.cjs');
const fail=message=>{throw Object.assign(new Error(message),{code:'FLOW_POLICY'});};
class FlowStore {
 constructor(store) {
  this.store=store;this.db=store.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS pf_session_bindings(session_id TEXT PRIMARY KEY,project_id TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS pf_flow_runs(session_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,generation TEXT NOT NULL,status TEXT NOT NULL,
    reason TEXT NOT NULL,steps INTEGER NOT NULL DEFAULT 0,continuations INTEGER NOT NULL DEFAULT 0,stalls INTEGER NOT NULL DEFAULT 0,
    max_steps INTEGER NOT NULL,max_continuations INTEGER NOT NULL,max_ms INTEGER NOT NULL,started_at INTEGER NOT NULL,
    last_progress TEXT NOT NULL DEFAULT '',last_step TEXT NOT NULL DEFAULT '',last_stop TEXT NOT NULL DEFAULT '');`);
  if(!this.db.prepare('PRAGMA table_info(pf_flow_runs)').all().some(c=>c.name==='scope_tasks'))this.db.exec("ALTER TABLE pf_flow_runs ADD COLUMN scope_tasks TEXT NOT NULL DEFAULT '[]'");
  if(!this.db.prepare('PRAGMA table_info(pf_session_bindings)').all().some(c=>c.name==='revision'))this.db.exec('ALTER TABLE pf_session_bindings ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
  this.db.prepare("UPDATE pf_flow_runs SET status='paused',reason='服务重启，等待手动继续',generation=? WHERE status='running'").run(randomUUID());
 }
 binding(id){return this.db.prepare('SELECT project_id FROM pf_session_bindings WHERE session_id=?').get(id)?.project_id;}
 bind(id,projectId){if(!id)fail('需要执行会话');OP.dbWrite();const previous=this.state(id);if(previous.projectId&&previous.projectId!==projectId&&previous.run?.status==='running')this.stop(previous.run,'paused','会话已切换工程，请核对后重新启用');this.db.prepare('INSERT INTO pf_session_bindings(session_id,project_id) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET project_id=excluded.project_id,revision=pf_session_bindings.revision+1 WHERE pf_session_bindings.project_id!=excluded.project_id').run(id,projectId);return this.state(id);}
 state(id){const r=this.db.prepare('SELECT * FROM pf_flow_runs WHERE session_id=?').get(id)||null;const b=this.db.prepare('SELECT * FROM pf_session_bindings WHERE session_id=?').get(id);return {sessionId:id,projectId:b?.project_id,bindingRevision:b?.revision||0,run:r};}
 list(projectId){return this.db.prepare('SELECT session_id FROM pf_session_bindings WHERE project_id=?').all(projectId).map(r=>this.state(r.session_id));}
 save(r){OP.dbWrite();this.db.prepare(`INSERT INTO pf_flow_runs VALUES(@session_id,@project_id,@generation,@status,@reason,@steps,@continuations,@stalls,@max_steps,@max_continuations,@max_ms,@started_at,@last_progress,@last_step,@last_stop,@scope_tasks)
 ON CONFLICT(session_id) DO UPDATE SET generation=excluded.generation,status=excluded.status,reason=excluded.reason,steps=excluded.steps,continuations=excluded.continuations,stalls=excluded.stalls,max_steps=excluded.max_steps,max_continuations=excluded.max_continuations,max_ms=excluded.max_ms,started_at=excluded.started_at,last_progress=excluded.last_progress,last_step=excluded.last_step,last_stop=excluded.last_stop,project_id=excluded.project_id,scope_tasks=excluded.scope_tasks`).run(r);return r;}
 stop(r,status,reason){return this.save({...r,status,reason,generation:randomUUID()});}
 control(id,projectId,action,options={}) {
  if(this.binding(id)!==projectId)fail('会话尚未绑定此工程；请先让该会话 GetProject 或 CreateProject');
  const r=this.state(id).run;
  if(['pause','stop'].includes(action))return r?this.stop(r,action==='pause'?'paused':'stopped',action==='pause'?'用户暂停':'用户停止'):null;
  if(!['start','resume'].includes(action))fail('未知心流动作');
  if(r?.status==='running')return r;
  const todos=this.store.tasks.list(projectId);if(!todos.length||todos.every(t=>t.status==='done'))fail('工程没有未完成任务，无需启动心流');
  const bounded=(x,d,max)=>Math.min(max,Math.max(1,Number.isSafeInteger(Number(x))?Number(x):d));
  return this.save({session_id:id,project_id:projectId,generation:randomUUID(),status:'running',reason:'',steps:0,continuations:0,stalls:0,
   max_steps:bounded(options.maxSteps,40,200),max_continuations:bounded(options.maxContinuations,6,20),max_ms:bounded(options.maxMinutes,20,120)*60000,
   started_at:Date.now(),last_progress:'',last_step:'',last_stop:'',scope_tasks:JSON.stringify(todos.map(t=>t.id))});
 }
 tick(id,input,snapshot,root) {
  let r=this.state(id).run;if(!r||r.status!=='running')return {run:r,continue:false};
  if(input.generation&&input.generation!==r.generation)return {run:r,continue:false,stale:true};
  if(input.user)return {run:this.stop(r,'paused','新用户输入优先，请核对范围后继续'),continue:false};
  if(input.aborted)return {run:this.stop(r,'stopped','用户停止或本轮取消'),continue:false};
  if(input.error)return {run:this.stop(r,'paused','执行错误，请核对后继续'),continue:false};
  if(input.capacity)return {run:this.stop(r,'paused',String(input.capacity)),continue:false,capacity:true};
  if(snapshot.todos.some(t=>!JSON.parse(r.scope_tasks).includes(t.id)))return {run:this.stop(r,'paused','计划新增任务，请核对范围后继续'),continue:false};
  if(Date.now()-r.started_at>=r.max_ms||r.steps>=r.max_steps)return {run:this.stop(r,'paused','达到总步数或时间预算'),continue:false,budget:true};
  if(input.step&&input.step!==r.last_step){r.steps++;r.last_step=input.step;this.save(r);}
  if(!input.stopping)return {run:r,continue:false};
  if(input.stopping===r.last_stop)return {run:r,continue:false};
  r.last_stop=input.stopping;
  const todos=snapshot.todos;
  if(todos.length&&todos.every(t=>t.status==='done')) {
   try{this.store.tasks.checkAccepted(r.project_id,root);return {run:this.stop(r,'completed','任务证据核对通过；报告另行验收'),continue:false};}
   catch(e){return {run:this.stop(r,'paused',e.message),continue:false};}
  }
  if(!todos.length)return {run:this.stop(r,'paused','工程没有待办，请先建立计划'),continue:false};
  const scope=new Set(JSON.parse(r.scope_tasks));
  const blockedInScope=todos.find(t=>scope.has(t.id)&&['blocked','paused','cancelled','skipped'].includes(t.status));
  if(blockedInScope)return {run:this.stop(r,'paused',`计划内任务 #${blockedInScope.seq} 处于 ${blockedInScope.status}，需要明确处理`),continue:false};
  const progress=JSON.stringify(todos.map(t=>[t.id,t.revision,t.status]));
  r.stalls=progress===r.last_progress?r.stalls+1:0;r.last_progress=progress;
  if(r.stalls>=2||r.continuations>=r.max_continuations)return {run:this.stop(r,'paused',r.stalls>=2?'连续收尾无任务进展':'达到续跑次数预算'),continue:false};
  const f=this.store.tasks.focusOf(id);
  const current=todos.find(t=>t.id===f?.task_id&&t.status==='doing'&&t.owner===id)||todos.find(t=>t.status==='doing'&&t.owner===id);
  const otherBusy=todos.find(t=>scope.has(t.id)&&t.status==='doing'&&t.owner&&t.owner!==id);
  if(otherBusy)return {run:this.stop(r,'paused',`计划内任务 #${otherBusy.seq} 正由会话 ${otherBusy.owner} 执行`),continue:false};
  r.continuations++;this.save(r);
  return {run:r,continue:true,text:current?`继续工程 ${r.project_id} 的 #${current.seq}「${current.title}」。有实际进展请 progress；完成后以证据 complete/advance；受阻则 block。不要批量勾完。`:`工程 ${r.project_id} 仍有待办。GetProject 核对后显式 start 下一项；不要将 pending 直接完成。`};
 }
}
module.exports={FlowStore};
