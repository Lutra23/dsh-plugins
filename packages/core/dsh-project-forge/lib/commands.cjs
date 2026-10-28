'use strict';
const fields={
  ListWorkspaces:'',CreateProject:'name projectName workspace workspaceAlias dir directory root todos todo',ListProjects:'workspace workspaceAlias query includeDeleted',SearchProjects:'workspace workspaceAlias query keyword includeDeleted',
  GetProject:'timeline limit',BindProject:'',UpdateTodos:'add todos done doing pending blocked remove seq title note evidence',SubmitReport:'conclusion summary report content issues status',
  TaskAction:'taskAction taskId expectedRevision nextTaskId nextExpectedRevision requestId evidence note title kind criteria reactivate dependencies expectedOwner targetSessionId',
  DeleteProjects:'projectIds ids',RestoreProjects:'projectIds ids',PurgeProjects:'projectIds ids confirm',
  ReadCode:'path file filePath paths files glob pattern query find search lines showLine showLines lineNumbers context range symbol pick line start end',Outline:'path file filePath paths files glob outlineDepth depth kind kinds',FindSymbol:'name symbol query glob pattern kind exact limit scope',
  References:'name symbol query path file limit budgetMs maxPerFile',
  Memory:'mode memoryId content force',
  Trace:'target traceTarget query glob scope traceMode',
  EditCode:'path file filePath op start end lines target replace content after before expect symbol range pick line mode drift edits revertOnSyntaxError',
  ResolveEdit:'ticketId ticket pick',CreateFile:'path file filePath content overwrite revertOnSyntaxError',RemoveFile:'path file filePath paths files',MoveFile:'from source path to destination target',
  MoveCode:'from source to dest destination path file start end lines symbol target block expect range after before indent pick line mode drift revertOnSyntaxError',CopyCode:'from source to dest destination path file start end lines symbol target block expect range after before indent pick line mode drift revertOnSyntaxError',
  Rollback:'batch batchId node nodeId toNode path file dryRun force',SearchHistory:'path file glob keyword query content byMaid author op opFilter since until batch batchId todo todoId limit',
  GetNodeDiff:'node nodeId batch batchId maxLines'
};
const common='command action projectId project id reason maid todo todoId minify operationId sessionId'.toLowerCase().split(' ');
/** ReadCode 只给 start 时的行号上界哨兵：只要大于任何真实文件行数即可，最终由 parseLineRange 夹到实际总行数。 */
const READ_TO_EOF=1e9;
const writes=new Set('BindProject TaskAction CreateProject UpdateTodos SubmitReport DeleteProjects RestoreProjects PurgeProjects EditCode ResolveEdit CreateFile RemoveFile MoveFile MoveCode CopyCode Rollback'.toLowerCase().split(' '));
function normalize(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('参数必须是对象');
  const a={};for(const[k,v]of Object.entries(raw)){const key=k.toLowerCase();if(key in a&&a[key]!==v)throw new Error('参数大小写冲突：'+k);a[key]=v;}
  if(a.command&&a.action&&String(a.command).trim().toLowerCase()!==String(a.action).trim().toLowerCase())throw new Error('command 与 action 冲突');
  const name=Object.keys(fields).find(k=>k.toLowerCase()===String(a.command||a.action||'').trim().toLowerCase());
  if(!name)throw new Error('未知 command：'+String(a.command||''));
  const allowed=new Set([...common,...fields[name].toLowerCase().split(' ')]);
  for(const k of Object.keys(a))if(!allowed.has(k)&&!(name==='EditCode'&&/^(op|start|end|lines|target|replace|content|after|before|expect|symbol|range|pick|line|reason|todo)\d+$/.test(k)))throw new Error(name+' 不支持参数 '+k);
  for(const[from,to]of [['tracetarget','target'],['outlinedepth','depth'],['opfilter','op'],...(name==='UpdateTodos'?[['todos','add']]:[]),...(name==='SubmitReport'?[['content','conclusion']]:[])]){
    if(a[from]!==undefined){if(a[to]!==undefined&&a[to]!==a[from])throw new Error('参数冲突：'+from+' 与 '+to);a[to]=a[from];delete a[from];}
  }
  // 宿主网关在 execute 之前按声明 schema 校验：evidence 已声明为 string|object（描述引导传对象），
  // 这里把对象折算回引擎要的 JSON 字符串。模型按描述传对象不再被「must be a string」拦在门外。
  if(a.evidence!==undefined&&a.evidence!==null&&typeof a.evidence==='object'&&!Array.isArray(a.evidence))a.evidence=JSON.stringify(a.evidence);
  // taskId/nextTaskId 同理：声明层放宽成 integer|string 后，纯数字字符串在这里折算回 number。
  for(const k of ['taskid','nexttaskid'])if(typeof a[k]==='string'&&/^\d+$/.test(a[k].trim()))a[k]=Number(a[k].trim());
  // ReadCode 的行号有三种写法：lines（原生语法）、path:M-N、以及 schema 里通用的 start/end。
  // start/end 对 EditCode 是行号对，模型读代码时同样会这样传（实测 8 次，最后一次 2026-10-18）。
  // 这里把它们折算成 lines 交给同一个 parseLineRange 解析，不新增第二套语义。
  if(name==='ReadCode'&&(a.lines===undefined||a.lines==='')){
    const text=v=>v===undefined||v===null||v===''?'':String(v).trim();
    const s=text(a.start),e=text(a.end);
    if(s&&e)a.lines=s+'-'+e;
    else if(s)a.lines=s+'-'+READ_TO_EOF; // 只给起点=读到文件末尾；parseLineRange 会把越界 end 夹到真实总行数
    else if(e)a.lines='head:'+e;
  }
  if(['EditCode','CreateFile','MoveCode','CopyCode'].includes(name)&&a.revertonsyntaxerror===undefined)a.revertonsyntaxerror=true;
  for(const alias of ['project','id'])if(a[alias]!==undefined){if(a.projectid!==undefined&&a.projectid!==a[alias])throw new Error('工程参数冲突');a.projectid=a[alias];delete a[alias];}
  if(name==='SearchHistory'){if(a.batchid!==undefined)a.batch=a.batchid;if(a.todoid!==undefined)a.todo=a.todoid;}
  a.command=name;delete a.action;delete a.minify;delete a.operationid;
  return a;
}
module.exports={fields,writes,normalize};
