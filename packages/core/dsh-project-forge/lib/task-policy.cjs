'use strict';
// Persistent task identity and transitions shared by the tool and panel.
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const OP = require('./operations.cjs');
const {assertInside} = require('./path-security.cjs');
const fail = (message, next) => { throw Object.assign(new Error(message), {code:'TASK_POLICY', ...(next ? {next} : {})}); };
const parse = (value, fallback) => typeof value === 'string' ? JSON.parse(value) : value ?? fallback;
const seqs = value => String(value ?? '').split(/[,\n]/).filter(Boolean).map(x => Number(x.replace('#','').trim()));
class TaskPolicy {
 constructor(store) {
  this.store=store; this.db=store.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS pf_task_state(
   task_id INTEGER PRIMARY KEY REFERENCES todos(id) ON DELETE CASCADE,
   revision INTEGER NOT NULL DEFAULT 1, owner TEXT, activation_id TEXT, started INTEGER NOT NULL DEFAULT 0,
   kind TEXT NOT NULL DEFAULT 'general', criteria TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '[]',
   progress TEXT NOT NULL DEFAULT '', legacy INTEGER NOT NULL DEFAULT 0);
   INSERT OR IGNORE INTO pf_task_state(task_id,legacy) SELECT id,1 FROM todos;
   CREATE TRIGGER IF NOT EXISTS pf_task_insert AFTER INSERT ON todos BEGIN INSERT INTO pf_task_state(task_id) VALUES(NEW.id); END;
   CREATE TABLE IF NOT EXISTS pf_task_events(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,
    task_id INTEGER,action TEXT NOT NULL,owner TEXT,activation_id TEXT,revision INTEGER,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS pf_task_focus(owner TEXT PRIMARY KEY,project_id TEXT NOT NULL,task_id INTEGER,activation_id TEXT,revision INTEGER NOT NULL DEFAULT 1);
   CREATE TABLE IF NOT EXISTS pf_task_receipts(id TEXT PRIMARY KEY,request TEXT NOT NULL,result TEXT NOT NULL);`);
  if(!this.db.prepare('PRAGMA table_info(pf_task_state)').all().some(c=>c.name==='dependencies'))this.db.exec("ALTER TABLE pf_task_state ADD COLUMN dependencies TEXT NOT NULL DEFAULT '[]'");
  if(!this.db.prepare('PRAGMA table_info(pf_task_events)').all().some(c=>c.name==='snapshot'))this.db.exec('ALTER TABLE pf_task_events ADD COLUMN snapshot TEXT');
  if(!this.db.prepare('PRAGMA table_info(pf_task_state)').all().some(c=>c.name==='handoff'))this.db.exec("ALTER TABLE pf_task_state ADD COLUMN handoff TEXT NOT NULL DEFAULT 'null'");
  // A task list can change without a TaskAction (e.g. importing a work package).
  // One persisted clock covers those writes too, so delayed mirrors cannot undo them.
  this.db.exec(`CREATE TABLE IF NOT EXISTS pf_task_sync_clock(project_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
   INSERT OR IGNORE INTO pf_task_sync_clock SELECT p.id,COALESCE((SELECT MAX(e.id) FROM pf_task_events e WHERE e.project_id=p.id),0) FROM projects p;
   CREATE TRIGGER IF NOT EXISTS pf_task_sync_insert AFTER INSERT ON todos BEGIN
    INSERT INTO pf_task_sync_clock VALUES(NEW.project_id,1) ON CONFLICT(project_id) DO UPDATE SET revision=revision+1; END;
   CREATE TRIGGER IF NOT EXISTS pf_task_sync_update AFTER UPDATE ON todos BEGIN
    INSERT INTO pf_task_sync_clock VALUES(NEW.project_id,1) ON CONFLICT(project_id) DO UPDATE SET revision=revision+1; END;
   CREATE TRIGGER IF NOT EXISTS pf_task_sync_delete AFTER DELETE ON todos BEGIN
    INSERT INTO pf_task_sync_clock VALUES(OLD.project_id,1) ON CONFLICT(project_id) DO UPDATE SET revision=revision+1; END;
   CREATE TRIGGER IF NOT EXISTS pf_task_sync_state AFTER UPDATE ON pf_task_state BEGIN
    INSERT INTO pf_task_sync_clock SELECT project_id,1 FROM todos WHERE id=NEW.task_id
    ON CONFLICT(project_id) DO UPDATE SET revision=revision+1; END;`);
 }
 list(projectId) {return this.db.prepare(`SELECT t.*,s.revision,s.owner,s.activation_id,s.started,s.kind,s.criteria,s.evidence,s.progress,s.legacy,s.dependencies,s.handoff
  FROM todos t JOIN pf_task_state s ON s.task_id=t.id WHERE t.project_id=? ORDER BY t.seq,t.id`).all(projectId).map(t=>({...t,evidence:JSON.parse(t.evidence),dependencies:JSON.parse(t.dependencies),handoff:JSON.parse(t.handoff)}));}
 get(projectId,id) {const t=this.list(projectId).find(t=>t.id===Number(id));if(!t)fail('任务不存在或不属于该工程','先 GetProject <projectId> 取当前 taskId 与 revision，确认该任务属于本工程；不要沿用别的工程或已被删除的任务号。');return t;}
 event(t,action,owner) {this.db.prepare('INSERT INTO pf_task_events(project_id,task_id,action,owner,activation_id,revision,created_at,snapshot) VALUES(?,?,?,?,?,?,?,?)')
  .run(t.project_id,t.id,action,owner,t.activation_id,t.revision,new Date().toISOString(),JSON.stringify(t));}
 focusOf(owner) {return owner?this.db.prepare('SELECT * FROM pf_task_focus WHERE owner=?').get(owner)||null:null;}
 focus(owner,projectId,task) {this.db.prepare(`INSERT INTO pf_task_focus(owner,project_id,task_id,activation_id) VALUES(?,?,?,?)
  ON CONFLICT(owner) DO UPDATE SET project_id=excluded.project_id,task_id=excluded.task_id,activation_id=excluded.activation_id,revision=pf_task_focus.revision+1`)
  .run(owner,projectId,task?.id??null,task?.activation_id??null);}
 snapshot(projectId,owner) {return {projectId,todos:this.list(projectId),focus:this.focusOf(owner),
  eventRevision:this.db.prepare('SELECT revision FROM pf_task_sync_clock WHERE project_id=?').get(projectId)?.revision||0};}
 // Evidence is a declared result plus verifiable references. Semantic claims remain labelled as declarations.
 autoRefs(t,root) {
  // 河流减法C：从任务名下的变动节点自动装配 refs——省的不是校验，是手抄路径与哈希的搬运。
  const rows=this.db.prepare(`SELECT n.id,n.file_path,n.after_hash,n.op FROM nodes n
    JOIN pf_operation_files f ON f.node_id=n.id AND f.phase='ledgered'
    JOIN pf_operations o ON o.id=f.operation_id AND o.status='committed'
   WHERE n.project_id=? AND n.todo_id=? ORDER BY n.id DESC LIMIT 30`).all(t.project_id,t.id);
  const seen=new Set(),refs=[];
  for(const r of rows){
   if(!r.file_path||seen.has(r.file_path))continue;seen.add(r.file_path);
   const file=assertInside(path.resolve(root,r.file_path),[root]);
   const hash=fs.existsSync(file)?OP.hash(fs.readFileSync(file)):null;
   // 节点已被后续改动覆盖或文件已删：不冒充本次证据，跳过（缺失会被下面的空集判据兜住）
   if(hash===null||hash!==r.after_hash)continue;
   refs.push({type:'file',path:r.file_path,hash});
  }
  return refs;
 }
 evidence(t,raw,root) {
  const e=parse(raw,null);
  // 河流减法C：refs 可省略——由任务名下已提交的变动节点自动装配；summary/check 仍是必须的声明
  if(e&&typeof e==='object'&&(e.refs===undefined||e.refs===null)){
   const auto=this.autoRefs(t,root);
   if(!auto.length)fail(`#${t.seq} 无法自动装配证据：该任务名下没有已提交的变动节点（file 引用可手写）。若本次只改了别处的文件，请显式传 refs:[{type:"file",path:"相对路径"}]`,'传 evidence.refs:[{type:"file",path:"相对路径"}]（构建/验证类任务也这样写）；或先在本任务名下做一次 EditCode/CreateFile 产生变动节点，再 complete。');
   e.refs=auto;
  }
  if(!e||typeof e!=='object'||!String(e.summary||'').trim()||!String(e.check||'').trim()||e.result!=='passed')fail(`#${t.seq} 完成需要 evidence：summary、check、result="passed" 和 refs；“已完成”备注不足以验收。`);
  if(!Array.isArray(e.refs)||!e.refs.length||e.refs.length>30)fail('证据必须引用 1–30 个文件、变动节点或调查来源');
  const refs=e.refs.map(ref=>{
   if(ref.type==='file') {const file=assertInside(path.resolve(root,String(ref.path||'')),[root]);const stat=fs.statSync(file);if(!stat.isFile()||stat.size>20*1024*1024)fail('证据文件不存在或超过 20MB');return {type:'file',path:path.relative(root,file),hash:OP.hash(fs.readFileSync(file))};}
   if(ref.type==='node') {const n=this.store.getNode(t.project_id,Number(ref.id));if(!n||n.todo_id!==t.id)fail('变动节点不属于当前任务');
    const r=this.db.prepare("SELECT o.status FROM pf_operation_files f JOIN pf_operations o ON o.id=f.operation_id WHERE f.node_id=? AND f.phase='ledgered'").get(n.id);
    if(r?.status!=='committed')fail('变动节点缺少成功操作回执');
    const file=assertInside(path.resolve(root,n.file_path),[root]);const hash=fs.existsSync(file)?OP.hash(fs.readFileSync(file)):null;
    if(hash!==n.after_hash)fail('节点证据已被后续改动覆盖');return {type:'node',id:n.id,path:n.file_path,hash};}
   if(ref.type==='source'&&t.kind==='research') {const url=new URL(String(ref.url||''));if(!['https:','http:'].includes(url.protocol)||!String(ref.finding||'').trim())fail('调查来源需要 URL 和具体结论');return {type:'source',url:url.href,finding:String(ref.finding),verification:'agent-declared'};}
   fail('不支持的证据引用；调查来源仅用于 research 任务');
  });
  if(t.kind==='code'&&!refs.some(r=>r.type==='file'||r.type==='node'))fail('代码任务需要产物或变动节点证据');
  return {summary:String(e.summary),check:String(e.check),result:'passed',refs,verification:'references-checked; conclusion-declared',taskRevision:t.revision,criteria:t.criteria};
 }
  checkAccepted(projectId,root) {
   const todos=this.list(projectId);
   if(!todos.length)fail('验收前请建立并完成工程任务');
   const drift=[];
   for(const t of todos) {
    if(t.status!=='done')fail(`#${t.seq} 尚未完成（${t.status}），不能设置 accepted`);
    if(!t.evidence.length)fail(`#${t.seq} 没有验收证据；历史完成记录保留，请显式 replan 后重新验收`);
    for(const e of t.evidence)for(const r of e.refs)if(r.type==='file'||r.type==='node') {
     const f=assertInside(path.resolve(root,r.path),[root]);const currentHash=fs.existsSync(f)?OP.hash(fs.readFileSync(f)):null;
     // 证据是「验收那一刻」的史料：文件此后被合法改动，不使当时的验收变得不成立，
     // 只随报告作信息附注（任务完成是事件，不是需要时刻维持有效的水位）。
     if(currentHash!==r.hash)drift.push({seq:t.seq,taskRevision:e.taskRevision??null,path:r.path,recordedHash:r.hash,currentHash});
    }
   }
   return {ok:true,drift};
  }
 action(projectId,input,root) {
  const a={...input},owner=String(a.sessionid||'panel');
  const request=JSON.stringify({projectId,...a});
  if(a.requestid) {const old=this.db.prepare('SELECT * FROM pf_task_receipts WHERE id=?').get(a.requestid);if(old){if(old.request!==request)fail('requestId 已用于不同动作');return JSON.parse(old.result);}}
  return this.store.transaction(()=>{
   const t=this.get(projectId,a.taskid);const action=String(a.taskaction||'');
   // 河流减法E：expectedRevision 可选——没给就按当前实测版本放行（串行场景不必机械搬运），给了才做并发冲突判定
   if(a.expectedrevision!=null&&Number(a.expectedrevision)!==t.revision)fail(`#${t.seq} 修订冲突：当前 revision=${t.revision}，请 GetProject 后再提交`);
   if(t.owner&&t.owner!==owner&&t.status==='doing'&&!['pause','block','cancel','handoff'].includes(action)&&!(t.owner==='panel'&&action==='resume'))fail(`#${t.seq} 已由会话 ${t.owner} 执行；需要接力时用 TaskAction handoff，携带 expectedOwner、expectedRevision 和 reason，无需先到旧会话暂停`);
   let status=t.status, activation=t.activation_id, started=t.started, evidence=t.evidence,kind=t.kind,criteria=t.criteria,progress=t.progress,title=t.title,taskOwner=owner,handoff=t.handoff;
   if(action==='handoff') {
    taskOwner=String(a.targetsessionid||owner).trim();
    if(status!=='doing'||!t.owner||!started)fail('只有已开始且有执行会话的任务可以交接；待办/暂停任务请 start/resume');
    if(!String(a.reason||'').trim())fail('交接需要 reason，说明接力原因与下一步');
    if(String(a.expectedowner||'')!==t.owner)fail('任务归属已变化或未提供 expectedOwner，请 GetProject 核对');
    if(!taskOwner||taskOwner==='panel'||taskOwner===t.owner)fail('请选择不同的真实接手会话');
    if(owner!=='panel'&&owner!==t.owner&&owner!==taskOwner)fail('只能交出自己持有的任务，或接手到当前会话');
    // 河流减法B：接手会话可以已有其他进行中任务——交接本身会把焦点移到新任务，无需先清空
    for(const id of t.dependencies){const dep=this.get(projectId,id);if(dep.status!=='done'||!dep.evidence.length)fail(`前置任务 #${dep.seq} 未通过验收`);}
    OP.dbWrite();this.event(t,'before-handoff',owner);
    activation=randomUUID();
    handoff={from:t.owner,to:taskOwner,reason:String(a.reason).trim(),createdAt:new Date().toISOString(),taskRevision:t.revision+1,activationId:activation};
   } else if(['start','resume'].includes(action)) {
    if(!['pending','doing','paused','blocked'].includes(status))fail('只能开始待办或恢复暂停/受阻任务');
    for(const id of t.dependencies){const dep=this.get(projectId,id);if(dep.status!=='done'||!dep.evidence.length)fail(`前置任务 #${dep.seq} 未通过验收`);}
    const f=this.focusOf(owner);
    if(status==='doing'&&t.owner===owner&&f?.activation_id===activation&&!a.reactivate)return this.snapshot(projectId,owner);
    status='doing';started=1;activation=randomUUID();
   } else if(['complete','advance'].includes(action)) {
    if(status!=='doing'||!started)fail(`#${t.seq} 未显式开始；禁止 pending 直接完成。先 start，再执行，再 complete/advance。`,'先 TaskAction start（带 taskId 与 expectedRevision）把任务置 doing，执行完再 complete/advance；complete 只接受已 started 的任务。');
    const normalized=this.evidence(t,a.evidence,root);
    if(typeof this.goalGate==='function'){
     let gate=null;
     try{gate=this.goalGate({projectId:t.project_id,taskId:t.id,owner,activationId:t.activation_id,evidence:normalized.refs,result:normalized.result,root});}
     catch(error){gate={required:true,allowed:false,reason:'验收层核对出错，按未通过处理：'+((error&&error.message)||error)};}
     if(gate&&gate.required&&!gate.allowed)fail(gate.reason||'目标验收未通过：请先补当前版本的证据，或由主 Agent/人工复核');
     if(gate&&gate.verificationId)a.goalVerification=gate.verificationId;
    }
    evidence=[normalized];status='done';
   } else if(['pause','block','cancel','skip'].includes(action)) {
    const desc=String(a.reason||a.note||'').trim();
    if(!desc)fail(`${action} 需要说明原因（reason 或 note 均可，一句话即可），说明为什么${{pause:'暂停',block:'标为受阻',cancel:'取消',skip:'跳过'}[action]}；它会写进开发脉络。`);
    if(['done','cancelled','skipped'].includes(status))fail(`#${t.seq} 当前 ${status}，已结束的状态不能直接改。请先 replan 说明重排原因（会重置为 pending 并清空历史证据），再 start 重新执行。`);
    status={pause:'paused',block:'blocked',cancel:'cancelled',skip:'skipped'}[action];progress=desc;
   } else if(action==='progress') {
    if(status!=='doing')fail(`只有进行中任务可以提交进度（#${t.seq} 当前 ${status}）。进度只能提交给已 start 的任务；若任务还没开始请先 start，暂停/受阻的任务请 resume，需要改范围或验收条件请 replan。`);
    const desc=String(a.note||a.reason||'').trim();
    if(!desc)fail(`progress 需要一段说明（note 或 reason 均可，一句话），evidence 不能替代它——evidence 是 complete/advance 的验收证据。示例：note:"已定位根因，正在改 task-policy 报错文案"`);
    if(desc===progress)fail('与上一次进度完全相同，没有新进展可记；请描述这一轮新增了什么，或用 pause 说明为何停滞');progress=desc;
   } else if(action==='replan') {
    if(!String(a.reason||'').trim())fail('重排需要原因，历史证据会留在事件记录中');
    if(status==='doing')fail('请先暂停当前任务再重排');
    if(a.kind&&!['general','code','research','document'].includes(a.kind))fail('kind 应为 general/code/research/document');
    kind=a.kind||kind;criteria=a.criteria??criteria;title=a.title??title;if(!String(title).trim())fail('标题不能为空');
    const dependencies=parse(a.dependencies,t.dependencies);if(!Array.isArray(dependencies))fail('dependencies 必须是 taskId 数组');
    const walk=(id,seen=new Set())=>{if(Number(id)===t.id)fail('任务依赖不能形成环');if(seen.has(id))return;seen.add(id);const dep=this.get(projectId,id);for(const next of dep.dependencies)walk(next,seen);};
    for(const id of dependencies)walk(id);
    OP.dbWrite();this.event(t,'before-replan',owner);
    this.db.prepare('UPDATE pf_task_state SET dependencies=? WHERE task_id=?').run(JSON.stringify(dependencies.map(Number)),t.id);
    status='pending';started=0;evidence=[];activation=null;progress=String(a.reason);
   } else fail('未知 taskAction');
   OP.dbWrite();this.store.updateTodo(projectId,t.seq,{status,title,note:progress,updatedBy:owner});
   this.db.prepare(`UPDATE pf_task_state SET revision=revision+1,owner=?,activation_id=?,started=?,kind=?,criteria=?,evidence=?,progress=?,handoff=?,legacy=0 WHERE task_id=?`)
    .run(status==='doing'?taskOwner:null,activation,started,kind,criteria,JSON.stringify(evidence),progress,JSON.stringify(handoff),t.id);
   const updated=this.get(projectId,t.id);this.event(updated,action,owner);
   if(action==='handoff') {
    this.focus(t.owner,projectId,null);
    this.focus(taskOwner,projectId,updated);
    // Runtime attaches binding/flow updates here, in this same SQLite transaction.
    this.onHandoff?.({projectId,task:updated,...handoff});
   } else if(['start','resume'].includes(action))this.focus(owner,projectId,updated);
   else if(status!=='doing') {const focusOwner=t.owner||owner;const f=this.db.prepare('SELECT * FROM pf_task_focus WHERE owner=?').get(focusOwner);if(f?.task_id===t.id)this.focus(focusOwner,projectId,null);}
   if(action==='advance') {const next=this.get(projectId,a.nexttaskid);this.action(projectId,{taskaction:'start',taskid:next.id,expectedrevision:a.nextexpectedrevision,sessionid:owner},root);}
   this.store.touchProject(projectId);
   if(this.store.getProject(projectId).status==='accepted')this.store.updateProject(projectId,{status:'active'});
   const result=this.snapshot(projectId,owner);
   if(a.requestid)this.db.prepare('INSERT INTO pf_task_receipts VALUES(?,?,?)').run(a.requestid,request,JSON.stringify(result));
   return result;
  });
 }
 legacyUpdate(projectId,a,root) {
  return this.store.transaction(()=>{
   const before=this.list(projectId),owner=String(a.sessionid||'panel');
   // Validate the complete proposal before applying any operation; no implicit start-and-complete.
   for(const seq of seqs(a.done)){const t=before.find(t=>t.seq===seq);if(!t||t.status!=='doing'||!t.started)fail(`#${seq} 未开始，禁止整批直接完成`);}
   if(a.remove||a.pending)fail('不能删除历史或直接重置状态；使用 TaskAction cancel / replan 并说明原因');
   if(a.title!==undefined)fail('改标题请使用 TaskAction replan，保留稳定 taskId');
   if(a.add){const titles=String(a.add).split(/[,\n]/).map(x=>x.trim()).filter(Boolean);this.store.addTodos(projectId,titles,owner);}
   for(const [key,action]of [['done','complete'],['blocked','block'],['doing','start']])for(const seq of seqs(a[key])) {
    const t=this.list(projectId).find(t=>t.seq===seq);if(!t)fail(`任务 #${seq} 不存在`);
    this.action(projectId,{taskid:t.id,expectedrevision:t.revision,taskaction:action,sessionid:owner,evidence:a.evidence,reason:a.reason||a.note},root);
   }
   if(a.seq&&a.note!==undefined) {const t=this.list(projectId).find(t=>t.seq===Number(a.seq));if(!t)fail('任务不存在');this.action(projectId,{taskid:t.id,expectedrevision:t.revision,taskaction:'progress',sessionid:owner,note:a.note},root);}
   if(!a.add&&!a.done&&!a.doing&&!a.blocked&&a.note===undefined)fail('UpdateTodos 没有操作');
   return this.snapshot(projectId,owner);
  });
 }
 requireActive(projectId,seq,owner) {
  const todos=this.list(projectId);if(!todos.length)return null;
  const t=todos.find(t=>t.seq===Number(seq));
  if(!t)fail('工程写操作需要明确的 todo 序号（todo 参数），不会把所有改动默认记给第一项');
  // 已被别的会话持有：不抢写（并发护栏，唯一必须保留的硬闸门）
  if(t.status==='doing'&&t.started&&t.owner&&owner&&t.owner!==owner)fail(`#${t.seq} 已由会话 ${t.owner} 执行；需要接力时用 TaskAction handoff（携带 expectedOwner/expectedRevision/reason），或由该会话继续`);
  // 已激活（本人持有或无人持有）：放行
  if(t.status==='doing'&&t.started)return t;
  // 未开始（pending，或历史遗留的 doing 未 started）：首次写到它即认领（许可 = 这一步写操作本身，不是事前仪式）。
  // 复用 start 的落库形状，owner/activation/focus/事件一条不少，账本上看得出这是自动认领。
  if((t.status==='pending'||t.status==='doing')&&!t.started&&!t.owner&&owner) {
   return this.store.transaction(()=>{
    const now=this.list(projectId).find(x=>x.id===t.id);
    if(!now||now.started||now.owner||!['pending','doing'].includes(now.status))fail(`#${t.seq} 状态在认领前已变化，请 GetProject 核对后重试`);
    const activation=randomUUID();
    OP.dbWrite();
    this.store.updateTodo(projectId,now.seq,{status:'doing',note:'首次写入自动认领（写操作即开工许可）',updatedBy:owner});
    this.db.prepare('UPDATE pf_task_state SET revision=revision+1,owner=?,activation_id=?,started=1 WHERE task_id=?').run(owner,activation,now.id);
    const claimed=this.get(projectId,now.id);
    this.focus(owner,projectId,claimed);
    this.event(claimed,'auto-claim',owner);
    this.store.touchProject(projectId);
    if(this.store.getProject(projectId).status==='accepted')this.store.updateProject(projectId,{status:'active'});
    return claimed;
   });
  }
  if(t.status==='paused'||t.status==='blocked')fail(`#${t.seq} 当前 ${t.status}：写操作不自动恢复它。确认要接着做就用 TaskAction resume（它会重新激活并留下记录），或改用别的任务`);
  if(t.status==='done')fail(`#${t.seq} 已完成：如需继续改动，请用 TaskAction replan 说明重排原因（历史证据保留）后再写`);
  if(t.status==='cancelled'||t.status==='skipped')fail(`#${t.seq} 当前 ${t.status}：请用 TaskAction replan 重排后再写`);
  fail(`#${t.seq} 当前 ${t.status}：写操作需要可认领的待办任务（pending）或已激活任务（doing）`);
 }
}
module.exports={TaskPolicy};
