'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const OP=require('./operations.cjs'),{assertInside,physical}=require('./path-security.cjs'),{normalize,writes}=require('./commands.cjs');
const {workItems}=require('./workitems.cjs');
function fail(message,code='INVALID_REQUEST'){throw Object.assign(new Error(message),{code});}
function createRuntimeApi({service,workspaces,setWorkspaces,root,goalJev=null}){
 const engineCapabilities={protocolVersion:2,taskPolicy:1,taskHandoff:1,taskSync:2,flowLock:1,blueprintVersions:1,cancel:true,receipts:true,panel:true,traceModes:['static','registry-assisted'],
  // GF05：引擎侧双焦点与插话恢复可用；Memo 插件尚未适配双焦点（保持旧行为并显示降级），所以这里不发布该能力。
  goalFocus:1,memoDualFocus:0,
  // GF06：引擎侧停滞识别、有界纠偏与失败操作重试预算可用（窗口台账落库，跨重启保留）。
  goalStall:1,
  // GF10：容量恢复协定只在压缩侧握手通过后才算可用；没握手时不发布 capacityResume（§11 能力位只发真正可用的能力）。
  capacityResume:0,
  // GF11：调度器与只读快照已可用；taskFocusRestore 仍为 0（Memo 双焦点未适配，不宣称）。
  goalFlow:1,goalControl:1,goalHostProtocol:2,goalChatControl:1,goalSnapshot:1,taskFocusRestore:0,goalJevPool:goalJev?1:0};
 const store=service.getStore(),db=store.db,journal=new OP.OperationJournal(store),previews=new Map();
 const documentVersions=require('./document-versions.cjs').installDocumentVersions(db);
 const flow=new (require('./flow-store.cjs').FlowStore)(store);
 const goal=new (require('./goal-store.cjs').GoalStore)(store); // GF01：构造期迁移与重启语义
 const goalScheduler=new (require('./goal-scheduler.cjs').GoalScheduler)(goal); // GF02：唯一调度器
 const goalEvidence=new (require('./goal-evidence.cjs').GoalEvidence)(goal,{journal}); // GF03：有来源的观察与证据
 // GF04 策略层：当前 mode=observe 且阈值未标定 → 语义自动动作（停止/验收/选任务）一律拒绝，只记录判断。
 const goalPolicy=new (require('./decision-policy.cjs').DecisionPolicy)({mode:'observe'});
 // 判断规格是 design-only（未启用）：读不到就只做代码侧处理，不假装有判断。
 const goalJudgments=(()=>{let M=null;try{M=require('./goal-judgments.cjs');}catch{return null;}
  try{return M.GoalJudgments.load();}catch{return null;}})();
 // Production can supply the VCP pool; tests omit it by default. The policy
 // remains observe: configuring transport is not calibration or authorization.
 if(goalJudgments&&goalJev)goalJudgments.client=goalJev.pool;
 // GF06：停滞识别与有界纠偏。窗口在“允许产出结果的轮次”打开，在收尾/等待/插话/硬门槛时按来源关闭——
 // 等待真实结果与用户插话不算失败窗口；只有有来源的有效进展才把计数归零。
 const goalStall=new (require('./goal-stall.cjs').GoalStall)({goalStore:goal,evidence:goalEvidence,
  judgments:goalJudgments,policy:{retryBudget:2,maxTier:3}});
 goalScheduler.stall=goalStall;goalScheduler.evidence=goalEvidence;
 // GF07：逐项证据判断与目标验收。任务级 done 只认 accepted；旧 complete/advance 走同一闸门（fail-closed）。
 const goalAcceptance=new (require('./goal-acceptance.cjs').GoalAcceptance)({goalStore:goal,evidence:goalEvidence,
  policy:goalPolicy,policyMode:goalPolicy?.mode||'observe'});
 if(store.tasks&&typeof store.tasks==='object')store.tasks.goalGate=payload=>goalAcceptance.gate(payload);
 // GF08：合法候选选择与范围内计划调整（第二阶段自动认领；assist/observe 只给建议）。
 const goalPlan=new (require('./goal-plan.cjs').GoalPlan)({goalStore:goal});
 goalScheduler.plan=goalPlan; // GF08：⑭ 收尾分支在没有当前任务时消费合法候选
 goalScheduler.acceptance=goalAcceptance; // GF07：⑫ verify 分支逐条核对目标条件并把缺口带回执
 const goalFocusStore=new (require('./goal-focus.cjs').GoalFocus)(goal); // GF05：双焦点与迟到召回隔离
 // GF09：接力与重启恢复（受控转移执行权/任务/记忆焦点；重启默认只到 paused，不重放不确定写）。
 const goalRelay=new (require('./goal-relay.cjs').GoalRelay)({goalStore:goal,tasks:store.tasks,focus:goalFocusStore,
  uncertainWrites:()=>{try{return db.prepare("SELECT id,status FROM pf_operations WHERE status IN ('unknown','needs-reconciliation') LIMIT 20").all();}catch{return [];}}});
 // GF10：压缩能力握手、受保护面与容量恢复协定（第一阶段未握手时 autoResumeAfterCompaction 等于关闭）。
 const goalCapacity=new (require('./goal-capacity.cjs').GoalCapacity)({goalStore:goal,relay:goalRelay});
 // GF11：内嵌面板/只读快照/短协议的数据面（从既有层组装，不建表不写库）。
 const goalSnapshot=new (require('./goal-snapshot.cjs').GoalSnapshot)({goalStore:goal,scheduler:goalScheduler,
  evidence:goalEvidence,acceptance:goalAcceptance,stall:goalStall,relay:goalRelay,focus:goalFocusStore,policy:goalPolicy});
 const goalInterrupt=new (require('./goal-interrupt.cjs').InterruptHandler)({goals:goal,scheduler:goalScheduler,
  policy:goalPolicy,focus:goalFocusStore,evidence:goalEvidence,judgments:goalJudgments}); // GF05：插话处理
 // 插话回答结束后由调度器决定恢复：这里只恢复焦点行，绝不 start/resume 任务（§9 不重新认领）。
 goalScheduler.onFocusRestore=({sessionId,run})=>goalFocusStore.restoreTask(sessionId,{
  taskId:currentTaskId(run,sessionId),reason:'插话已回答：恢复同一任务焦点（不重新认领）'});
 store.tasks.onHandoff=({projectId,from,to})=>{
  flow.bind(to,projectId);
  for(const id of [from,to]){const run=flow.state(id).run;if(run?.status==='running')flow.stop(run,'paused','任务已交接，请在接手会话核对后单独启用心流');}
 };
 let revision=0,accepting=true,panelOpenRevision=0;
 service.events.on('changed',()=>revision++);
 db.exec(`CREATE TABLE IF NOT EXISTS pf_blueprints(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,title TEXT NOT NULL,project_id TEXT,revision INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS pf_report_versions(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS pf_workitems(document_id TEXT NOT NULL,item_id TEXT NOT NULL,todo_id INTEGER NOT NULL,PRIMARY KEY(document_id,item_id));`);
 db.exec(`CREATE TABLE IF NOT EXISTS pf_workitems_v2(document_id TEXT NOT NULL,item_id TEXT NOT NULL,project_id TEXT NOT NULL,todo_id INTEGER NOT NULL,PRIMARY KEY(document_id,item_id,project_id));
 INSERT OR IGNORE INTO pf_workitems_v2 SELECT w.document_id,w.item_id,t.project_id,w.todo_id FROM pf_workitems w JOIN todos t ON t.id=w.todo_id;`);
 db.exec(`CREATE TRIGGER IF NOT EXISTS pf_archive_report AFTER UPDATE OF report ON projects
 WHEN OLD.report IS NOT NULL AND OLD.report != NEW.report
 BEGIN INSERT INTO pf_report_versions(project_id,body,created_at) VALUES(OLD.id,OLD.report,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
 CREATE TRIGGER IF NOT EXISTS pf_purge_panel AFTER DELETE ON projects BEGIN
 DELETE FROM pf_report_versions WHERE project_id=OLD.id;
 UPDATE pf_blueprints SET project_id=NULL,revision=revision+1 WHERE project_id=OLD.id; END;`);
 // Explicitly supplied companion documents are registered without creating a project.
 for(const name of ['toolchain-optimization-blueprint.md','forge-panel-blueprint.md','task-memory-unification-proposal.md']){
  const p=path.join(root,'docs',name);if(fs.existsSync(p))db.prepare('INSERT OR IGNORE INTO pf_blueprints(id,path,title) VALUES(?,?,?)').run(OP.hash(p).slice(0,24),p,name.replace('.md',''));
 }
 const roots=(write=true)=>workspaces().filter(w=>!write||w.enabled!==false).map(w=>w.path);
 function access(projectId,write=false,includeDeleted=false){if(!projectId)fail('请先关联工程');const ctx=service.checkAccess(projectId,write,includeDeleted);assertInside(ctx.rootInfo.root,roots(write));return ctx;}
 function projectRevision(id){const data=service.gui.getProject(id);return OP.hash(JSON.stringify(data));}
 function requireRevision(id,expected){access(id,true);if(!expected||expected!==projectRevision(id))fail('工程已被其他操作更新，请比较后重新保存。','REVISION_CONFLICT');}
 function document(id){const d=db.prepare('SELECT * FROM pf_blueprints WHERE id=?').get(id);if(!d)fail('施工图不存在','NOT_FOUND');return d;}
 const companions=new Set(['toolchain-optimization-blueprint.md','forge-panel-blueprint.md','task-memory-unification-proposal.md'].map(n=>physical(path.join(root,'docs',n))));
 function canReadDoc(d){try{return companions.has(physical(d.path))||roots(false).some(r=>{try{return !!assertInside(d.path,[r]);}catch{return false;}});}catch{return false;}}
 function readDoc(id){const d=document(id);if(!canReadDoc(d))fail('文档已移出授权范围','FORBIDDEN');let text;try{const st=fs.statSync(d.path);if(!st.isFile()||st.size>2*1024*1024)fail('仅支持 2MB 内的 Markdown 文件');text=fs.readFileSync(d.path,'utf8');}catch(e){if(e.code==='ENOENT')return {...d,missing:true};throw e;}return {...d,markdown:text,sourceHash:require("./document-versions.cjs").textHash(text),contentHash:OP.hash(text),workItems:[...workItems(text)]};}
 function listProjects(){return service.gui.listProjects().filter(p=>{try{access(p.id);return true;}catch{return false;}});}
 function sessionSnapshot(projectId,sessionId){
  const ctx=access(projectId),state=flow.state(sessionId);
  const snapshot={...store.tasks.snapshot(projectId,sessionId),bindingRevision:state.bindingRevision,run:state.run};
  const docs=db.prepare('SELECT id,path FROM pf_blueprints WHERE project_id=?').all(projectId).filter(canReadDoc);
  return {...snapshot,continuation:require('./continuation.cjs').continuation(snapshot,sessionId,ctx.project,docs)};
 }
 // GF03：工具回执自动采集。只在会话确实持有目标运行时落账；采集失败不得影响工具回执本身。
 const INTAKE_STATES=['completed','committed','failed-before-commit','cancelled-before-commit','needs-reconciliation'];
 // GF06：失败操作有独立重试预算；只有该操作自己的成功回执才清零（“刚又改了 progress”不清零，§7）。
 // 重试身份 = 命令 + 目标路径（失败回执没有 files 时不能再拿 operationId 顶替，否则每次失败都是新身份）。
 const RETRY_KEY=(receipt,args={})=>{
  const r=receipt||{},a=args||{};
  const target=a.path||a.file||a.filepath||((r.files||[])[0]?.path)||r.operationId||'';
  return [r.command||a.command||'op',target].join('|');
 };
 const RECEIPT_FAILED_STATES=['failed-before-commit','cancelled-before-commit'];
 function goalRetryIntake(run,receipt,sessionId,args){
  try{
   const goalId=run.goal_id,taskId=currentTaskId(run,sessionId),operationKey=RETRY_KEY(receipt,args);
   if(RECEIPT_FAILED_STATES.includes(receipt.status))
    return {recorded:true,...goalStall.noteRetry({goalId,taskId,operationKey,error:receipt.error||receipt.status})};
   if(['completed','committed'].includes(receipt.status))return goalStall.noteSuccess({goalId,taskId,operationKey});
  }catch{return null;}
  return null;
 }
 function goalIntake(sessionId,outcome,args={}){
  try{
   const receipt=outcome?.receipt,run=sessionId?goalScheduler.runningRun(sessionId):null;
   if(!run||!receipt||!INTAKE_STATES.includes(receipt.status))return outcome;
   const intake=goalEvidence.fromReceipt(receipt,{runId:run.id,taskId:currentTaskId(run,sessionId),
    finding:`工具回执 ${receipt.command||receipt.operationId} → ${receipt.status}`});
   const goalRetry=goalRetryIntake(run,receipt,sessionId,args);
   return {...outcome,goalEvidence:intake,...(goalRetry?{goalRetry}:{})};
  }catch(e){return outcome;}
 }
 // 观察归属：目标计划内、由本会话正在执行的那一项（与调度器同判据；不按标题猜关联）。
 function currentTaskId(run,sessionId){
  const projectId=goal.goalRow(run.goal_id)?.project_id;
  if(!projectId)return null;
  const linked=new Set(goal.db.prepare('SELECT task_id FROM pf_goal_task_links WHERE goal_id=?').all(run.goal_id).map(r=>Number(r.task_id)));
  const todos=(store.tasks.snapshot(projectId,sessionId)||{}).todos||[];
  const current=todos.find(t=>linked.has(Number(t.id))&&t.status==='doing'&&t.owner===sessionId);
  return current?Number(current.id):null;
 }
 function capabilities(id){let reason='请先选择或关联工程';if(id){try{access(id,true);reason='';}catch(e){reason=e.message;}}
  return {read:true,manage:!reason,cancel:!reason,rollback:!reason,reason};}
 function stamp(){return OP.hash(JSON.stringify([revision,workspaces(),db.prepare('SELECT path FROM pf_blueprints').all().map(d=>{try{const s=fs.statSync(d.path);return [d.path,s.mtimeMs,s.size];}catch{return [d.path,null];}})]));}
 async function panel(method,p){
 if(typeof method==='string'&&method.startsWith('context.'))fail('上下文数据需要宿主进程内的活动会话；请在 DSH 内嵌施工图面板查看','SESSION_NOT_LIVE');
 switch(method){
   case 'bootstrap': return {projects:listProjects(),documents:db.prepare('SELECT * FROM pf_blueprints ORDER BY title').all().filter(canReadDoc),revision:stamp(),capabilities:capabilities(p.projectId)};
   case 'documents.read':return readDoc(p.id);
   case 'documents.register':{if(!/\.md$/i.test(p.path||''))fail('请选择 Markdown 文件');const file=assertInside(p.path,roots());const id=OP.hash(file).slice(0,24);OP.dbWrite();db.prepare('INSERT OR IGNORE INTO pf_blueprints(id,path,title) VALUES(?,?,?)').run(id,file,path.basename(file));return readDoc(id);}
   case 'documents.link':{const d=readDoc(p.id);if(d.revision!==p.expectedRevision)fail('关联已变化','REVISION_CONFLICT');if(p.projectId)access(p.projectId);OP.dbWrite();db.prepare('UPDATE pf_blueprints SET project_id=?,revision=revision+1 WHERE id=?').run(p.projectId||null,p.id);revision++;return document(p.id);}
   case 'projects.get':{access(p.projectId);const data=service.gui.getProject(p.projectId);return {...data,revision:projectRevision(p.projectId),capabilities:capabilities(p.projectId)};}
   case 'tasks.action':{requireRevision(p.projectId,p.expectedRevision);const result=await service.processToolCall(normalize({...p.task,command:'TaskAction',projectId:p.projectId,maid:'本机用户'}));return {result,revision:projectRevision(p.projectId)};}
   case 'tasks.history':access(p.projectId);return {events:db.prepare('SELECT * FROM pf_task_events WHERE project_id=? AND task_id=? ORDER BY id DESC LIMIT 100').all(p.projectId,p.taskId).map(e=>({...e,snapshot:e.snapshot?JSON.parse(e.snapshot):null}))};
   case 'flow.status':access(p.projectId);return {sessions:flow.list(p.projectId)};
   case 'documents.versions':{readDoc(p.id);return {versions:documentVersions.list(p.id)}}
   case 'documents.version':{readDoc(p.id);return documentVersions.get(p.id,p.versionId)}
   case 'documents.restore':
   case 'documents.rewrite':{
    const d=document(p.id);const file=assertInside(d.path,roots(true));if(d.project_id)access(d.project_id,true);
    const md=method==='documents.restore'?documentVersions.get(p.id,p.versionId).markdown:p.markdown;
    const saved=await documentVersions.write(p.id,file,md,p.expectedHash,p.reason);
    revision++;return {...readDoc(p.id),saved};
   }
   case 'documents.open':{const d=readDoc(p.id);if(d.missing)fail('原文件不存在');const child=require('node:child_process').spawn('explorer.exe',[d.path],{windowsHide:true,stdio:'ignore'});child.on('error',()=>{});child.unref();return {opened:true};}
   case 'history.list':access(p.projectId);return {nodes:service.gui.searchHistory({projectId:p.projectId,keyword:String(p.keyword||''),limit:100})};
   case 'nodes.diff':access(p.projectId);return service.gui.getNodeDetail(p.projectId,p.nodeId);
   case 'todos.update':{requireRevision(p.projectId,p.expectedRevision);const patch=p.patch||{};const allowed=new Set(['add','done','doing','pending','blocked','remove','seq','title','note','evidence','reason']);if(Object.keys(patch).some(k=>!allowed.has(k)))fail('无效待办操作');const result=await service.processToolCall(normalize({...patch,command:'UpdateTodos',projectId:p.projectId,maid:'本机用户'}));return {result,revision:projectRevision(p.projectId)};}
   case 'reports.versions':access(p.projectId);return {versions:db.prepare('SELECT id,body,created_at FROM pf_report_versions WHERE project_id=? ORDER BY id DESC LIMIT 50').all(p.projectId)};
   case 'reports.save':{requireRevision(p.projectId,p.expectedRevision);if(typeof p.content!=='string'||!p.content.trim()||p.content.length>200000)fail('报告不能为空或超过 200000 字符');OP.dbWrite();db.transaction(()=>{store.updateProject(p.projectId,{report:p.content,reportBy:'本机用户'});})();revision++;return {revision:projectRevision(p.projectId)};}
   case 'workitems.import':{requireRevision(p.projectId,p.expectedRevision);const d=readDoc(p.documentId);if(d.project_id!==p.projectId||d.contentHash!==p.contentHash)fail('文档或关联已变化','REVISION_CONFLICT');if(!Array.isArray(p.items)||p.items.length>100)fail('条目超限');const candidates=workItems(d.markdown);OP.dbWrite();db.transaction(()=>{for(const id of p.items){if(!candidates.has(id))fail('工作包不在文档中');if(db.prepare('SELECT 1 FROM pf_workitems_v2 WHERE document_id=? AND item_id=? AND project_id=?').get(d.id,id,p.projectId))continue;store.addTodos(p.projectId,[id+' · '+candidates.get(id)],'本机用户');const todo=store.listTodos(p.projectId).at(-1);db.prepare('INSERT INTO pf_workitems_v2 VALUES(?,?,?,?)').run(d.id,id,p.projectId,todo.id);}})();return {revision:projectRevision(p.projectId)};}
   case 'rollback.preview':{
    const ctx=access(p.projectId,true);if(!['before','after'].includes(p.mode))fail('无效回退方向');
    const detail=service.gui.getNodeDetail(p.projectId,p.nodeId),file=assertInside(path.resolve(ctx.rootInfo.root,detail.node.file_path),[ctx.rootInfo.root]);
    const disk=await OP.disk(file),target=p.mode==='before'?detail.node.before_hash:detail.node.after_hash;
    const expected=store.getFileState(p.projectId,detail.node.file_path)??null;
    const conflicts=[];if(disk.hash!==expected)conflicts.push('磁盘有账本之外的新修改');
    if(journal.list(p.projectId).some(o=>o.status==='needs-reconciliation'&&o.files.some(f=>f.path===file)))conflicts.push('该文件有待核对操作');
    const token=crypto.randomBytes(24).toString('hex'),expiresAt=Date.now()+60000;
    for(const[k,v]of previews)if(v.expiresAt<Date.now())previews.delete(k);
    if(previews.size>100)previews.delete(previews.keys().next().value);
    previews.set(token,{projectId:p.projectId,nodeId:p.nodeId,mode:p.mode,file,hash:disk.hash,revision:projectRevision(p.projectId),expiresAt,conflicts});
    const targetBytes=target?store.getBlob(target):null;
    const binary=!!(disk.bytes?.subarray(0,8000).includes(0)||targetBytes?.subarray(0,8000).includes(0));
    return {previewToken:token,expiresAt,file:detail.node.file_path,mode:p.mode,conflicts,laterChanges:detail.laterChanges,
      current:!binary&&disk.bytes?service.decodeBuffer(disk.bytes).slice(0,200000):'',target:!binary&&targetBytes?service.decodeBuffer(targetBytes).slice(0,200000):'',willDelete:target===null,binary};
   }
   case 'rollback.commit':{
    const v=previews.get(p.previewToken);if(!v||v.expiresAt<Date.now())fail('预检已过期，请重新预检','PREVIEW_EXPIRED');
    access(v.projectId,true);if(!String(p.reason||'').trim())fail('请填写回退原因');
    if(v.conflicts.length||v.revision!==projectRevision(v.projectId)||(await OP.disk(v.file)).hash!==v.hash)fail('文件或工程已变化，请重新预检','FILE_CONFLICT');
    previews.delete(p.previewToken);
    // Earlier recorded nodes are intentionally shown in the preview; unrecorded drift was rejected above.
    const result=await service.gui.revertFileChange({projectId:v.projectId,nodeId:v.nodeId,mode:v.mode,signature:'本机用户',reason:p.reason,force:true});
    revision++;return {...result,projectId:v.projectId};
   }
   default:fail('未知面板接口','UNKNOWN_METHOD');
  }
 }
 async function dispatch(msg){
  if(msg.method==='panel.open'){panelOpenRevision=Date.now();return {openRevision:panelOpenRevision};}
  if(msg.method==='panel.entry')return {openRevision:panelOpenRevision};
  if(!accepting&&!['status','operations','inspect','revision','cancel'].includes(msg.method))fail('工程服务正在关闭','SHUTTING_DOWN');
  if(Array.isArray(msg.workspaces))setWorkspaces(msg.workspaces);
  if(msg.method==='goal.control'){
   const result=require('./goal-chat-control.cjs').chatControlTransaction(db,msg,request=>require('./goal-control.cjs').goalControl({goals:goal,scheduler:goalScheduler,flow,acceptance:goalAcceptance,access,snapshot:sessionSnapshot},request));
   if(msg.action!=='status')goalJev?.cancel(msg.sessionId);
   if(msg.action==='resume'&&result.run)result.focusRestore=goalFocusStore.restoreTask(msg.sessionId,{taskId:currentTaskId(result.run,msg.sessionId),reason:'用户确认继续同一目标'});
   if(msg.action!=='status')revision++;
   return msg.action==='status'?{...result,jev:goalJev?.status(msg.sessionId)||{configured:false,reason:'未装配 VCP JEV 池'}}:result;
  }
  if(['task.bind','task.sync','flow.control','flow.tick'].includes(msg.method)) {
   const projectId=msg.method==='task.bind'?msg.projectId:flow.binding(msg.sessionId);
   if(!projectId)return {projectId:null,todos:[],focus:null,run:null};
   const context=access(projectId,msg.method!=='task.sync');
   if(msg.method==='task.bind'){flow.bind(msg.sessionId,projectId);revision++;}
   if(msg.method==='flow.control'){if(msg.projectId!==projectId)fail('会话工程不匹配');
    const latestGoal=goalScheduler.latestRun(msg.sessionId);
    if(['start','resume'].includes(msg.action)&&latestGoal&&!['completed','stopped'].includes(latestGoal.status))fail('该会话已有目标运行；goal 与 legacy 心流互斥，请先停止目标运行','GOAL_FLOW_MUTEX');
    const run=flow.control(msg.sessionId,projectId,msg.action,msg.options);revision++;return {run};}
   const snapshot=sessionSnapshot(projectId,msg.sessionId);
   if(msg.method==='flow.tick'){const result=flow.tick(msg.sessionId,msg.input||{},snapshot,context.rootInfo.root);revision++;return {...snapshot,...result};}
   return {...snapshot,run:flow.state(msg.sessionId).run};
  }
  if(['goal.tick','goal.status','goal.evidence','goal.observe','goal.focus','goal.interrupt','goal.stall','goal.acceptance','goal.submit','goal.review','goal.select','goal.plan','goal.revise','goal.claim','goal.bind','goal.restart','goal.relay','goal.resume','goal.capacity','goal.handshake','goal.capacityResume','goal.snapshot'].includes(msg.method)) {
   if(msg.input?.stop||msg.input?.pause||msg.input?.aborted||msg.input?.error||msg.input?.capacity||['goal.restart','goal.relay','goal.resume','goal.bind','goal.capacityResume'].includes(msg.method))goalJev?.cancel(msg.sessionId);
   const active=goalScheduler.activeRun(msg.sessionId),latest=goalScheduler.latestRun(msg.sessionId);
   const run=active||(latest?.status==='paused'&&((msg.input?.user&&latest.pause_origin==='user-input')||msg.input?.aborted||msg.input?.stop||msg.input?.pause||msg.input?.error)?latest:null);
   if(msg.input?.expectedGeneration&&msg.input.expectedGeneration!==(run||latest)?.generation)fail('运行代际已变化，请重读状态','STALE_GENERATION');
   if(msg.method==='goal.focus'){ // GF05 只读：双焦点、版本与 Memo 降级状态都摊开
    const focusView=owner=>{const recall=goalFocusStore.recallRequest(owner,{focus:msg.focus||'effective'});
     return {boundary:goalFocusStore.boundary(owner,{memo:msg.memo}),visible:goalFocusStore.visible(owner),recall};};
    if(!run)return {run:null,...focusView(msg.sessionId)};
    const focusProjectId=goal.goalRow(run.goal_id).project_id;
    access(focusProjectId,false);
    return {run,goalId:run.goal_id,...focusView(msg.sessionId)};
   }
   if(msg.method==='goal.interrupt'){ // GF05 写入：真实用户消息到达（必须先挡住新增自动动作）
    if(!msg.messageId)fail('插话需要真实用户消息 id（messageId）','NOT_USER_MESSAGE');
    const projectId=run?goal.goalRow(run.goal_id).project_id:msg.projectId||null;
    if(projectId)access(projectId,false);
    const snapshot=projectId&&run?sessionSnapshot(projectId,msg.sessionId):{todos:[]};
    const result=goalInterrupt.handle(msg.sessionId,{messageId:msg.messageId,text:msg.text||'',judged:msg.judged||{},
     memo:msg.memo,snapshot:{todos:snapshot.todos,latestUserSeq:msg.latestUserSeq,
      fingerprint:run?goalScheduler.fingerprint(run,{todos:snapshot.todos,latestUserSeq:msg.latestUserSeq}):''}});
    revision++;
    return result;
   }
   if(msg.method==='goal.status'){const seen=run||goalScheduler.latestRun(msg.sessionId);if(seen)access(goal.goalRow(seen.goal_id).project_id,false);return {run:seen,live:!!run,goal:seen?goal.decorate(goal.goalRow(seen.goal_id)):null,
    jev:goalJev?.status(msg.sessionId)||{configured:false,reason:'未装配 VCP JEV 池'},
    boundary:goalFocusStore.boundary(msg.sessionId,{memo:msg.memo}),
    stall:run?goalStall.state(run.goal_id,{taskId:currentTaskId(run,msg.sessionId)??null}):null,
    goalLevelStall:run?goalStall.state(run.goal_id,{taskId:null}):null};}
   if(msg.method==='goal.stall'){ // GF06 只读：窗口台账、纠偏档位、待处理标记与重试预算都摊开
    // 暂停/重启后 activeRun 为空，但纠偏计数必须仍可审（GA21）：按会话取最近一次运行并标注 live。
    const seen=run||goal.db.prepare('SELECT * FROM pf_goal_runs WHERE executor_session_id=? ORDER BY started_at DESC').get(msg.sessionId)||null;
    if(!seen)return {run:null,live:false,goalId:null,taskId:null,stall:null,goalLevelStall:null};
    const projectId=goal.goalRow(seen.goal_id).project_id;
    access(projectId,false);
    const taskId=currentTaskId(seen,msg.sessionId);
    return {run:seen,live:!!run,goalId:seen.goal_id,taskId,
     stall:goalStall.state(seen.goal_id,{taskId:taskId??null,windowLimit:msg.input?.windowLimit}),
     goalLevelStall:goalStall.state(seen.goal_id,{taskId:null,windowLimit:msg.input?.windowLimit}),
     progress:goalEvidence.progress(seen.id)};
   }
   if(msg.method==='goal.evidence'){ // GF03 只读：来源分类与新鲜度都摊开，不把自述当事实
    if(!run)return {run:null,goalId:null,progress:null,evidence:null,observations:[]};
    const projectId=goal.goalRow(run.goal_id).project_id;
    access(projectId,false);
    const criterionId=msg.input?.criterionId||null;
    return {run,goalId:run.goal_id,progress:goalEvidence.progress(run.id),
     evidence:goalEvidence.evidenceFor(run.goal_id,criterionId),observations:goalEvidence.list(run.id)};
    }
    if(msg.method==='goal.acceptance'){ // GF07 只读：逐条条件状态、缺口与已失效核验都摊开（§8.3）
     const seen=run||goal.db.prepare('SELECT * FROM pf_goal_runs WHERE executor_session_id=? ORDER BY started_at DESC').get(msg.sessionId)||null;
     if(!seen)fail('该会话没有目标运行记录','NO_ACTIVE_RUN');
     const row=goal.goalRow(seen.goal_id),ctx=access(row.project_id,false);
     return {run:seen,goalId:seen.goal_id,live:!!run,
      acceptance:goalAcceptance.checkGoalAccepted(seen.goal_id,{root:ctx.rootInfo.root}),
      verifications:goalAcceptance.state(seen.goal_id,{taskId:msg.input?.taskId??currentTaskId(seen,msg.sessionId)})};
    }
    if(msg.method==='goal.submit'){ // GF07 写入：结果进入 verifying，任务仍是 in_progress（§8.1）
     const candidate=goalScheduler.latestRun(msg.sessionId);
     const live=goalScheduler.runningRun(msg.sessionId)||(candidate?.status==='paused'&&candidate.pause_origin==='reconciling'?candidate:null);
     if(!live)fail('没有在途目标运行：核验不落账，请先启动目标运行','NO_ACTIVE_RUN');
     const row=goal.goalRow(live.goal_id),ctx=access(row.project_id,false);
     const taskId=msg.input?.taskId??currentTaskId(live,msg.sessionId);
     if(!db.prepare('SELECT 1 FROM pf_goal_task_links WHERE goal_id=? AND task_id=?').get(live.goal_id,taskId??-1))fail('只能提交本目标中已关联任务的证据');
     const out=goalAcceptance.submit(live,{taskId:msg.input?.taskId??currentTaskId(live,msg.sessionId),
      evidence:msg.input?.evidence||[],result:msg.input?.result||'',by:msg.sessionId,
      activationId:msg.input?.activationId||'',root:ctx.rootInfo.root,judgments:msg.input?.judgments||{}});
     revision++;
     return {run:live,goalId:live.goal_id,...out};
    }
    if(msg.method==='goal.review'){ // GF07 复核：主 Agent/人工的显式判断，必须署名与理由（§8.3）
     const v=db.prepare('SELECT * FROM pf_goal_verifications WHERE id=?').get(msg.input?.verificationId||'');
     if(!v)fail('核验记录不存在','NOT_FOUND');
     const owner=goalScheduler.latestRun(msg.sessionId);
     if(!owner||owner.goal_id!==v.goal_id)fail('只能复核本会话目标中的核验记录');
     const ctx=access(goal.goalRow(v.goal_id).project_id,true);
     goalAcceptance.validate(v.goal_id,{root:ctx.rootInfo.root});
     const criteria=goalAcceptance.criteriaFor(v.goal_id,v.task_id);
     if(criteria.some(c=>c.category==='human')&&msg.source?.channel!=='goal-panel')fail('人工验收条件只能由用户在面板复核');
     if(msg.input?.verdict==='accepted'&&JSON.parse(v.machine||'{}').criteria?.some(c=>c.machine?.ok===false))fail('确定性检查失败，不能通过复核覆盖；请先提交修复后的证据');
     const out=goalAcceptance.review(msg.input?.verificationId,{by:msg.source?.channel==='goal-panel'?'user:goal-panel':msg.sessionId,verdict:msg.input?.verdict||'accepted',reason:msg.input?.reason||''});
     revision++;
     return out;
    }
    if(msg.method==='goal.select'){ // GF08 只读：合法候选、排除原因与建议动作都摊开（不代执行手续）
     const seen=run||goal.db.prepare('SELECT * FROM pf_goal_runs WHERE executor_session_id=? ORDER BY started_at DESC').get(msg.sessionId)||null;
     if(!seen)fail('该会话没有目标运行记录','NO_ACTIVE_RUN');
     const row=goal.goalRow(seen.goal_id),snap=sessionSnapshot(row.project_id,msg.sessionId);
     const out=goalPlan.select(seen,{projectId:row.project_id,sessionId:msg.sessionId,snapshot:snap,judgments:msg.input?.judgments||{}});
     return {run:seen,goalId:seen.goal_id,live:!!run,...out};
    }
    if(msg.method==='goal.plan'){ // GF08 只读：计划版本、修订审计与当前映射（含被拒绝的越界请求）
     const seen=run||goal.db.prepare('SELECT * FROM pf_goal_runs WHERE executor_session_id=? ORDER BY started_at DESC').get(msg.sessionId)||null;
     if(!seen)fail('该会话没有目标运行记录','NO_ACTIVE_RUN');
     const row=goal.goalRow(seen.goal_id);access(row.project_id,false);
     const snap=goal.snapshot(seen.goal_id);
     return {run:seen,goalId:seen.goal_id,
      links:snap.links.map(l=>({taskId:Number(l.task_id),criterionIds:(()=>{try{return JSON.parse(l.criterion_ids||'[]');}catch{return [];}})()})),
      criteria:snap.criteria,...goalPlan.revisions(seen.goal_id)};
    }
    if(msg.method==='goal.revise'){ // GF08 写入：范围内调整落盘；越界需要真实用户决定，程序直接拒绝
     const live=goalScheduler.runningRun(msg.sessionId);
     if(!live)fail('没有在途目标运行：计划调整不落账，请先启动目标运行','NO_ACTIVE_RUN');
     const row=goal.goalRow(live.goal_id);access(row.project_id,true);
     const out=goalPlan.revise(live,{tasks:msg.input?.tasks||[],reason:msg.input?.reason||'',
      sourceRefs:msg.input?.sourceRefs||[],by:msg.sessionId,kind:msg.input?.kind||'revise'});
     if(out.applied)revision++;
     return {run:live,goalId:live.goal_id,...out};
    }
    if(msg.method==='goal.claim'){ // GF08 写入：autonomous 下代执行认领，走既有 TaskAction 通路（所有权/授权规则不复制）
     const live=goalScheduler.runningRun(msg.sessionId);
     if(!live)fail('没有在途目标运行：不能代执行认领','NO_ACTIVE_RUN');
     const row=goal.goalRow(live.goal_id);access(row.project_id,true);
     const snap=sessionSnapshot(row.project_id,msg.sessionId);
     const out=goalPlan.select(live,{projectId:row.project_id,sessionId:msg.sessionId,snapshot:snap,judgments:msg.input?.judgments||{}});
     if(out.action!=='claim')return {...out,claimed:false};
     const task=store.tasks.get(row.project_id,out.taskId);
     const result=await service.processToolCall(normalize({command:'TaskAction',projectId:row.project_id,maid:'本机用户',sessionId:msg.sessionId,
      taskAction:'start',taskId:out.taskId,expectedRevision:task.revision,reason:msg.input?.reason||out.reason}));
     revision++;
     return {...out,claimed:true,result};
    }
    if(msg.method==='goal.bind'){ // GF09 只读：绑定视角——在途运行属于谁、是否继承执行权（都不继承、不续跑）
     const projectId=msg.projectId||flow.binding(msg.sessionId);
     if(!projectId)return {projectId:null,goalId:null,runId:null,attached:false,resumed:false,inheritsExecution:false,note:'没有已绑定工程'};
     access(projectId,false);
     return goalRelay.bind(msg.sessionId,projectId);
    }
    if(msg.method==='goal.restart'){ // GF09 只读：重启后的恢复资格与阻断原因（首版默认不自动恢复）
     const seen=run||goal.db.prepare('SELECT * FROM pf_goal_runs WHERE executor_session_id=? ORDER BY started_at DESC').get(msg.sessionId)||null;
     const projectId=msg.projectId||(seen?goal.goalRow(seen.goal_id).project_id:flow.binding(msg.sessionId));
     if(projectId)access(projectId,false);
     return {projectId:projectId||null,candidates:goalRelay.restartView({projectId:projectId||null}),
      note:'服务重启先恢复为 paused/reconciling：先核对在途回执与执行权，自动恢复需授权显式启用'};
    }
    if(msg.method==='goal.relay'){ // GF09 写入：一次明确的用户要求才接力（换执行权与代际，保留预算与重试）
     const live=goalScheduler.activeRun(msg.sessionId)||run;
     if(!live)fail('没有可接力的目标运行','NO_ACTIVE_RUN');
     const row=goal.goalRow(live.goal_id);access(row.project_id,true);
     const out=goalRelay.relay(live,{toSessionId:msg.input?.toSessionId||msg.toSessionId,
      messageId:msg.input?.messageId||msg.messageId||null,by:msg.sessionId,reason:msg.input?.reason||''});
     let taskTransferResult=null;
     if(out.taskTransfer&&out.taskTransfer.required){
      try{
       const current=store.tasks.get(row.project_id,out.taskId);
       await service.processToolCall(normalize({command:'TaskAction',projectId:row.project_id,maid:'本机用户',
        taskAction:'handoff',taskId:out.taskId,expectedOwner:current.owner,targetSessionId:String(out.to),
        expectedRevision:current.revision,reason:`接力：${out.to} 接手目标运行执行权`}));
       taskTransferResult=goalRelay.recordTaskTransfer(out.relayId,{ok:true,by:msg.sessionId});
      }catch(error){
       taskTransferResult=goalRelay.recordTaskTransfer(out.relayId,{ok:false,error:(error&&error.message)||String(error),by:msg.sessionId});
      }
     }
     revision++;
     return {goalId:live.goal_id,...out,taskTransferResult};
    }
    if(msg.method==='goal.resume'){ // GF09 写入：显式恢复（署名+理由；资格不够一律拒绝）
     if(!msg.input?.runId)fail('恢复必须指明目标运行');
     const out=goalRelay.resume(msg.input.runId,{by:msg.input?.by||'',reason:msg.input?.reason||'',messageId:msg.input?.messageId||null});
     revision++;
     return out;
    }
    if(msg.method==='goal.snapshot'){ // GF11 只读：面板/短协议共用的单一数据面（与原生 Todo 同源）
     const seen=run||goal.db.prepare('SELECT * FROM pf_goal_runs WHERE executor_session_id=? ORDER BY started_at DESC').get(msg.sessionId)||null;
     const row=seen?goal.goalRow(seen.goal_id):null;
     const ctx=row?access(row.project_id,false):null;
     return {...goalSnapshot.assemble({projectId:row?.project_id??msg.projectId??null,sessionId:msg.sessionId,
      run:seen,root:ctx?.rootInfo?.root??null}),live:!!run,
      capabilities:{goalFlow:1,goalSnapshot:1,memoDualFocus:engineCapabilities.memoDualFocus,
       capacityResume:engineCapabilities.capacityResume,taskFocusRestore:0,
       note:'能力位按真实可用情况发布：taskFocusRestore 需 Memo 双焦点适配后才会打开'}};
    }
    if(msg.method==='goal.capacity'){ // GF10 只读：握手历史、保护面与当前恢复判定（第一阶段默认不恢复）
     const seen=run||goal.db.prepare('SELECT * FROM pf_goal_runs WHERE executor_session_id=? ORDER BY started_at DESC').get(msg.sessionId)||null;
     if(seen)access(goal.goalRow(seen.goal_id).project_id,false);
     return {run:seen,goalId:seen?.goal_id??null,
      handshakes:goalCapacity.state({goalId:seen?.goal_id??null}),
      protection:goalCapacity.protection(seen?.goal_id??null),
      eligibility:seen?goalCapacity.eligible(seen,{compaction:msg.input?.compaction||null,measure:msg.input?.measure||null,
       stoppedByUser:!!msg.input?.stoppedByUser}):null,
      note:'第一阶段沿用现有容量保护与手动恢复：未通过握手前 autoResumeAfterCompaction 等于关闭'};
    }
    if(msg.method==='goal.handshake'){ // GF10 写入：压缩侧能力握手（缺字段一律不认账）
     const out=goalCapacity.handshake(msg.input?.provider||'unknown',msg.input||{});
     if(out.supported)engineCapabilities.capacityResume=1; // 只有真实握手通过才把能力位打开
     revision++;
     return out;
    }
    if(msg.method==='goal.capacityResume'){ // GF10 写入：只有容量协定全绿才恢复同一 run
     const runId=msg.input?.runId||(run&&run.id);
     if(!runId)fail('容量恢复必须指明目标运行');
     const target=goal.db.prepare('SELECT * FROM pf_goal_runs WHERE id=?').get(String(runId));
     if(!target)fail('目标运行不存在','NOT_FOUND');
     access(goal.goalRow(target.goal_id).project_id,true);
     const out=goalCapacity.resume(target,{by:msg.input?.by||'',reason:msg.input?.reason||'',
      compaction:msg.input?.compaction||null,measure:msg.input?.measure||null,stoppedByUser:!!msg.input?.stoppedByUser});
     revision++;
     return out;
    }
    if(msg.method==='goal.observe'){ // GF03 写入：观察必须挂在当前会话持有的运行上（插话挂起期间不落账）
    const live=goalScheduler.runningRun(msg.sessionId);
    if(!live)fail('没有在途目标运行：观察不落账，请先启动目标运行','NO_ACTIVE_RUN');
    if(msg.projectId&&msg.projectId!==goal.goalRow(live.goal_id).project_id)fail('会话工程不匹配');
    const recorded=goalEvidence.record(live.id,msg.input||{});
    if(!recorded.deduped)revision++;
    return {...recorded,progress:goalEvidence.progress(live.id)};
   }
   if(!run)return {decision:'none'};
   const projectId=goal.goalRow(run.goal_id).project_id;
   access(projectId,false);
   const snapshot=sessionSnapshot(projectId,msg.sessionId);
   // GF05：预步的真实用户消息走插话处理器（生命周期/关系分开、切 userFocus、挡住自动动作）。
   if(msg.input?.user){
    const realId=msg.input.messageId?String(msg.input.messageId):null;
    let result=goalInterrupt.handle(msg.sessionId,{messageId:realId||`${msg.sessionId}:${msg.input.latestUserSeq??'live'}`,
     synthetic:!realId,text:msg.input.text||'',judged:msg.input.judged||{},memo:msg.input.memo,
     snapshot:{todos:snapshot.todos,latestUserSeq:msg.input.latestUserSeq,
      fingerprint:goalScheduler.fingerprint(run,{todos:snapshot.todos,latestUserSeq:msg.input.latestUserSeq})}});
    revision++;
    if(realId&&goalJev&&result.run?.status==='paused'&&result.run.pause_origin==='user-input'){
     const original=goal.goalRow(run.goal_id),after=goal.runRow(run.id);
     const fingerprint=goalScheduler.fingerprint(after,{todos:snapshot.todos,latestUserSeq:realId});
     const judgment=await goalJev.interrupt({sessionId:msg.sessionId,run:after,goal:original,
      message:{id:realId,text:msg.input.text||''},dialogueContext:msg.input.dialogueContext||[],fingerprint,
      isFresh:()=>{
       const latest=goalScheduler.latestRun(msg.sessionId);
       return accepting&&latest?.id===after.id&&latest.generation===after.generation&&latest.status==='paused'&&latest.pause_origin==='user-input'&&
        goal.goalRow(run.goal_id).revision===original.revision&&goalFocusStore.userFocus(msg.sessionId)?.messageId===realId&&
        goalScheduler.fingerprint(latest,{todos:sessionSnapshot(projectId,msg.sessionId).todos,latestUserSeq:realId})===fingerprint;
      },apply:judged=>goalInterrupt.handle(msg.sessionId,{messageId:realId,text:msg.input.text||'',judged,memo:msg.input.memo,snapshot:{...snapshot,fingerprint}})});
     if(judgment.applied){result=judgment.applied;revision++;}
     result.jev=judgment.observed||{status:judgment.status,code:judgment.code||null};
    }
    return {...result,snapshot};
   }
   const linked=new Set(db.prepare('SELECT task_id FROM pf_goal_task_links WHERE goal_id=?').all(run.goal_id).map(l=>Number(l.task_id)));
   const result=goalScheduler.tick(msg.sessionId,msg.input||{},{todos:linked.size?snapshot.todos.filter(t=>linked.has(Number(t.id))):snapshot.todos,latestUserSeq:msg.input?.latestUserSeq,
   root:access(goal.goalRow(run.goal_id).project_id,false).rootInfo.root});
   if(result.decision!=='none')revision++;
   return {...result,snapshot};
  }
  if(msg.method==='status'){const s=journal.status(msg.operationId);if(s.projectId)access(s.projectId,false,true);return s;}
  if(msg.method==='operations'){if(msg.projectId)access(msg.projectId,false,true);return journal.list(msg.projectId).filter(s=>{try{if(s.projectId)access(s.projectId,false,true);return true;}catch{return false;}});}
  if(msg.method==='inspect'){const s=journal.status(msg.operationId);if(s.projectId)access(s.projectId,false,true);return journal.inspect(msg.operationId);}
  if(msg.method==='cancel'){const s=journal.status(msg.operationId);if(s.projectId)access(s.projectId,true,true);return journal.cancel(msg.operationId);}
  if(msg.method==='revision')return {revision:stamp(),capabilities:engineCapabilities,pluginVersion:require('../package.json').version};
  if(msg.method&&msg.method!=='panel')fail('未知工程服务接口：'+msg.method,'UNKNOWN_METHOD');
  const panelCall=msg.method==='panel',p=msg.params||{},args=panelCall?{method:msg.action,...p}:normalize(msg.args||msg);
  const projectId=panelCall?(p.projectId||(msg.action==='rollback.commit'?previews.get(p.previewToken)?.projectId:null)):args.projectid;
  const mutation=panelCall?/^(tasks.action|todos.update|reports.save|workitems.import|documents.register|documents.rewrite|documents.restore|documents.link|rollback.commit)$/.test(msg.action):writes.has(args.command.toLowerCase());
  const multiple=!panelCall&&['DeleteProjects','RestoreProjects','PurgeProjects'].includes(args.command);
  const ids=multiple?require('../vendor/VCPDistributedServer/Plugin/ProjectForge/args.js').list(args.projectids??args.projectid??args.ids):projectId?[projectId]:[];
  const initialRoots=roots(mutation).map(physical),projectRoots=new Map(ids.map(id=>[id,physical(access(id,mutation,multiple).rootInfo.root)]));
  let outcome;
  try{outcome=await journal.run({id:msg.operationId,args,projectId:ids.length===1?ids[0]:null,projectRoot:id=>access(id,false,true).rootInfo.root,fault:msg.fault,
    validate:file=>{for(const id of ids){const current=access(id,mutation,multiple);if(physical(current.rootInfo.root)!==projectRoots.get(id))fail('工作区位置已变化，请重新提交','WORKSPACE_CHANGED');}if(file){assertInside(file,initialRoots);assertInside(file,roots(mutation));}}},async()=>{
      let result;
      if(!panelCall&&args.command==='BindProject') {
       if(!args.sessionid||args.sessionid==='panel')fail('BindProject 需要当前执行会话');
       flow.bind(args.sessionid,projectId);
       const snapshot=sessionSnapshot(projectId,args.sessionid);
       result={details:{command:'BindProject',...snapshot},content:[{type:'text',text:snapshot.continuation.text}]};
      } else result=panelCall?await panel(msg.action,p):await service.processToolCall(args,{});
      if(mutation)revision++;
      return result;
    });
  }catch(e){
   // GF06：失败操作同样进重试预算与失败回执落账（journal 把回执挂在 error 上）；工具本身的报错语义不变。
   if(e&&e.receipt)goalIntake(msg.sessionId||args.sessionid,{receipt:e.receipt},args);
   throw e;
  }
  return goalIntake(msg.sessionId||args.sessionid,outcome,args);
 }
 return {dispatch,journal,stopAccepting(){accepting=false;goalJev?.close();},get revision(){return revision;},capabilities:engineCapabilities};
}
module.exports={createRuntimeApi};
