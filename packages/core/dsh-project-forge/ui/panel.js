'use strict';
const $=id=>document.getElementById(id);
const state={csrf:'',library:'projects',documents:[],projects:[],document:null,projectId:'',project:null,tab:'plan',revision:0,connected:false,generation:0,flowSessions:[],availableSessions:[],history:[],operations:[],preview:null,drafts:new Map(),reports:new Map(),context:null,ctxSession:'',ctxQuery:''};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={running:'运行中',completed:'查询完成',committed:'已提交',unknown:'结果未知','cancelled-before-commit':'已取消，未提交','failed-before-commit':'提交前失败','needs-reconciliation':'结果待核对'};
const statuses={pending:'待办',doing:'进行中',done:'完成',blocked:'受阻',paused:'暂停',cancelled:'取消',skipped:'跳过'};
function notice(text,error=false){$('notice').textContent=text;$('notice').classList.toggle('error',error);}
function dirty(){return state.drafts.size||state.reports.size;}
function connection(ok){const was=state.connected;state.connected=ok;$('connection').textContent=ok?'已连接本机 Forge':'连接中断 · 当前为缓存';$('connection').classList.toggle('error',!ok);if(!ok)document.querySelectorAll('[data-action],[data-cancel],[data-preview],#commit-rollback,#link-project,#register,#open-source').forEach(b=>b.disabled=true);else if(!was)notice('');}
async function request(msg){
 const operationId=msg.operationId||crypto.randomUUID();
 let response;
 try{
  response=await fetch('api',{method:'POST',headers:{'Content-Type':'application/json','X-Forge-CSRF':state.csrf},body:JSON.stringify({...msg,operationId}),signal:AbortSignal.timeout(180000)});
 }catch(e){connection(false);e.message+='；若刚才是保存或回退，请先查询操作记录：'+operationId;throw e;}
 let body;
 try{body=await response.json();}catch{connection(false);const error=new Error('响应无法解析');error.operationId=operationId;throw error;}
 if(!body.ok){const error=new Error(body.error||'操作失败');error.code=body.code;error.receipt=body.receipt;throw error;}
 connection(true);return body.result;
}
const panel=(action,params={})=>request({method:'panel',action,params});
function inline(s){return String(s).split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g).map(v=>{if(v.startsWith('`')&&v.endsWith('`'))return '<code>'+esc(v.slice(1,-1))+'</code>';if(v.startsWith('**')&&v.endsWith('**'))return '<strong>'+esc(v.slice(2,-2))+'</strong>';const m=/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(v);return m?'<a href="'+esc(m[2])+'" target="_blank" rel="noopener noreferrer">'+esc(m[1])+'</a>':esc(v);}).join('');}
function markdown(source){
 const lines=String(source||'').split(/\r?\n/);let output='',fenced=false,code=[],table=[];
 const flush=()=>{if(!table.length)return;const rows=table.filter(l=>!/^\|[\s:|-]+\|$/.test(l));output+='<div class="table-wrap"><table>'+rows.map((l,i)=>'<tr>'+l.replace(/^\||\|$/g,'').split('|').map(c=>`<${i?'td':'th'}>${inline(c.trim())}</${i?'td':'th'}>`).join('')+'</tr>').join('')+'</table></div>';table=[];};
 for(const line of lines){if(/^```/.test(line)){flush();if(fenced){output+='<pre><code>'+esc(code.join('\n'))+'</code></pre>';code=[];}fenced=!fenced;continue;}if(fenced){code.push(line);continue;}if(/^\|/.test(line)){table.push(line);continue;}flush();const h=/^(#{1,6})\s+(.+)/.exec(line);if(h){output+=`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;continue;}if(/^\s*[-*]\s+/.test(line)||/^\d+\.\s+/.test(line)){output+='<p>'+inline(line)+'</p>';continue;}if(line.trim())output+='<p>'+inline(line)+'</p>';}
 flush();if(code.length)output+='<pre><code>'+esc(code.join('\n'))+'</code></pre>';return output;
}
function canManage(){return state.connected&&state.project?.capabilities?.manage;}
const projectStatuses={active:'进行中',review:'待验收',accepted:'已验收'};
function documentTitle(d){return {'forge-panel-blueprint':'施工图面板设计','toolchain-optimization-blueprint':'锻造工具链优化施工图'}[d.title]||d.title;}
function renderSidebar(){
 const q=$('filter').value.toLowerCase(),projects=state.library==='projects';
 document.querySelectorAll('[data-library]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.library===state.library)));
 $('add-document').hidden=projects;
 $('library-hint').textContent=projects?`${state.projects.length} 个可访问工程 · 包含 AI 创建的工程，点击直接查看`:`${state.documents.length} 份已登记文档 · 独立 Markdown 文件`;
 $('documents').innerHTML=projects?state.projects.filter(p=>(p.name+' '+p.id+' '+p.root).toLowerCase().includes(q)).map(p=>`<button class="document" data-project="${esc(p.id)}" aria-pressed="${state.projectId===p.id}"><span>${esc(p.name)}</span><span class="muted">${esc(projectStatuses[p.status]||p.status)} · 待办 ${esc(p.progress?.text||'0/0')}<br>${esc(p.workspace_alias||'')} · ${esc(p.id)}</span></button>`).join('')||'<p class="empty">没有匹配的工程。这里只显示当前工作区可访问且未删除的工程。</p>':state.documents.filter(d=>(documentTitle(d)+' '+d.path).toLowerCase().includes(q)).map(d=>`<button class="document" data-document="${esc(d.id)}" aria-pressed="${state.document?.id===d.id}"><span>${esc(documentTitle(d))}</span><span class="muted">${d.project_id?'已关联工程':'未关联工程'}</span></button>`).join('')||'<p class="empty">没有匹配的文档</p>';
}
function renderHead(){
 $('register').disabled=!state.connected;
 $('review-drafts').hidden=!(state.reports.has(state.projectId)||[...state.drafts.keys()].some(k=>k.startsWith(state.projectId+':')));
 $('title').textContent=state.document?documentTitle(state.document):state.project?.project.name||'AI 创建的工程';$('document-meta').textContent=state.document?.path||state.project?.project.root||'点击左侧工程，查看已有待办、报告和变动历史';
 $('projects').innerHTML='<option value="">选择工程</option>'+state.projects.map(p=>`<option value="${esc(p.id)}" ${p.id===state.projectId?'selected':''}>${esc(p.name)} · ${esc(p.id)}</option>`).join('');
 $('project-status').textContent=state.project?`${state.project.project.progress.text} · ${state.project.capabilities.reason||'工程管理可用'}`:'选择已有工程后可查看待办、报告和变动';
 $('open-source').disabled=!state.document||!state.connected||state.document.missing;
 $('open-source').hidden=!state.document;
 $('link-project').hidden=state.library!=='documents';
 $('link-project').disabled=!state.document||!state.connected;
 $('permission-details').textContent=canManage()?'可查看、保存待办/报告、请求取消与预检回退。':state.project?.capabilities?.reason||'当前仅查看施工图；请关联可管理的工程。';
 document.querySelectorAll('[data-tab]').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.tab===state.tab));if(b.dataset.tab==='plan')b.textContent=state.library==='projects'?'工程概览':'施工图文档';});
}
function diffHtml(before,after,left='改动前',right='改动后'){return `<div class="diff-columns"><section><h3>${esc(left)}</h3><pre>${esc(before)}</pre></section><section><h3>${esc(right)}</h3><pre>${esc(after)}</pre></section></div>`;}
function render(){
 renderSidebar();renderHead();renderFlow();const disabled=canManage()?'':'disabled';
 if(state.tab==='plan'){
  if(state.library==='projects'){
   if(!state.project){$('content').innerHTML='<p class="empty">从左侧选择已有工程。AI 通过 project_forge 创建的工程会自动出现在这里，无需添加文档或手动关联。</p>';return;}
   const p=state.project.project,summary=state.projects.find(row=>row.id===p.id)||{},docs=state.documents.filter(d=>d.project_id===p.id);
   $('content').innerHTML=`<section class="project-overview"><h2>工程施工记录</h2><p>这是已有工程的待办、报告和历史，可直接查看和管理。</p><div class="overview-stats"><div><strong>${esc(p.progress?.text||summary.progress?.text||'0/0')}</strong><span>待办完成</span></div><div><strong>${esc(summary.stats?.nodeCount||0)}</strong><span>变动记录</span></div><div><strong>${esc(projectStatuses[p.status]||p.status)}</strong><span>工程状态</span></div></div><div class="actions"><button data-tab="todos">查看待办</button><button data-tab="history">查看变动与差异</button><button data-tab="report">查看验收报告</button></div><h3>已有待办</h3>${state.project.todos.length?'<ul>'+state.project.todos.slice(0,8).map(t=>`<li>${esc(statuses[t.status]||t.status)} · ${esc(t.title)}</li>`).join('')+'</ul>':'<p class="muted">当前没有待办，可在“待办”页添加。</p>'}<h3>关联文档</h3>${docs.length?docs.map(d=>`<button data-document="${esc(d.id)}">${esc(documentTitle(d))}</button>`).join(' '):'<p class="muted">此工程没有关联独立 Markdown 文档，不影响查看待办、报告和历史。若 AI 另外写过文件，可到左侧“文档”添加。</p>'}<p class="muted">“变动脉络”包含原有文件历史；“操作记录”从启用操作回执后开始记录。</p></section>`;return;
  }
  if(!state.document){$('content').innerHTML='<p class="empty">选择施工图，或添加已有 Markdown 文件。</p>';return;}
  if(state.document.missing){$('content').innerHTML='<p class="error">原文件已不存在，请核对路径后重新登记。</p>';return;}
  const items=(state.document.workItems||[]).map(([id,title])=>[null,id,title]);
  const importBox=items.length&&state.document.project_id===state.projectId?`<details class="workitems"><summary>选择工作包导入工程待办</summary>${items.map(m=>`<label><input type="checkbox" data-item="${esc(m[1])}">${esc(m[1]+' · '+m[2].trim())}</label>`).join('')}<button data-action="import-items" ${disabled}>导入所选工作包</button><p class="muted">重复导入会跳过已有引用，不重置任务进度。</p></details>`:'';
  $('content').innerHTML='<div class="actions"><button data-action="blueprint-versions">版本与回退</button></div>'+importBox+'<details class="toc"><summary>章节目录</summary><div id="chapters"></div></details><article class="markdown">'+markdown(state.document.markdown)+'</article>';
  $('chapters').innerHTML=[...document.querySelectorAll('.markdown h1,.markdown h2,.markdown h3')].map((h,i)=>{h.id='chapter-'+i;return '<a href="#chapter-'+i+'">'+esc(h.textContent)+'</a>';}).join('');return;
 }
 if(state.tab==='context'){renderContext();return;}
 if(!state.projectId||!state.project){$('content').innerHTML='<p class="empty">请先选择一个工程。阅读施工图不需要创建工程。</p>';return;}
 if(state.tab==='todos'){
  $('content').innerHTML=state.project.todos.map(t=>`<section class="task" data-seq="${t.seq}"><div class="task-top"><strong>#${t.seq} · ${esc(t.title)}</strong><span class="pill st-${t.status}">${esc(statuses[t.status]||t.status)}</span><span class="muted">修订 ${t.revision}${t.legacy?' · 历史记录':''}</span></div><p>${esc(t.criteria||'验收：提交具体结论、检查结果及引用')}</p><p class="muted">${esc(t.progress||t.note||'尚无进度记录')}</p>${t.owner?'<p class="muted">执行会话：'+esc(t.owner)+'</p>':''}${t.handoff?'<p class="muted">最近交接：'+esc(t.handoff.from+' → '+t.handoff.to+' · '+t.handoff.reason)+'</p>':''}<div class="actions">${(t.status==='pending'?['start','replan','cancel']:t.status==='doing'?['progress','handoff','complete','advance','pause','block']:['paused','blocked'].includes(t.status)?['resume','replan','cancel']:['replan']).map(a=>`<button data-task="${a}" data-task-id="${t.id}" ${disabled}>${({start:'开始',resume:'恢复',handoff:'交给其他会话',progress:'记录进度',complete:'完成并核验',advance:'完成并推进下一项',pause:'暂停',block:'受阻',cancel:'取消',replan:'调整计划'})[a]}</button>`).join('')}</div><button data-task-history="${t.id}">任务记录</button>${t.evidence?.length?'<details><summary>完成依据</summary><pre>'+esc(JSON.stringify(t.evidence,null,2))+'</pre></details>':''}</section>`).join('')+`<div class="actions"><label>新增待办<input id="new-todo" placeholder="待办标题" ${disabled}></label><button data-action="add-todo" ${disabled}>新增</button></div>`;
 }else if(state.tab==='report'){
  const content=state.reports.get(state.projectId)?.content??state.project.project.report??'';
  $('content').innerHTML=`<label>验收报告<textarea id="report-text" class="report-editor" ${disabled}>${esc(content)}</textarea></label><div class="actions"><span class="muted">报告单独保存，不自动完成待办。旧版本保留在账本。</span><button data-action="report-versions">查看旧报告</button><button data-action="save-report" ${disabled}>保存报告</button></div>`;
 }else if(state.tab==='history'){
  $('content').innerHTML='<div class="actions"><label>检索脉络<input id="history-query" placeholder="原因、路径、摘要"></label><button data-action="search-history">搜索</button></div>'+ (state.history.length?state.history.map(n=>`<section class="operation"><div class="actions"><strong>${esc(n.file_path)}</strong><span>${esc(n.op)} · n${n.id} / b${n.batch_id}</span><button data-node="${n.id}">查看差异</button></div><p>${esc(n.effective_reason||n.summary||'')}</p><p class="muted">${esc(n.maid||'未署名')} · ${esc(n.created_at)}</p></section>`).join(''):'<p class="empty">还没有匹配的变动记录。</p>');
 }else{
  $('content').innerHTML=state.operations.length?state.operations.map(o=>`<section class="operation"><div class="actions"><strong>${esc(o.command)}</strong><span class="status-label pill op-${o.status}">${esc(labels[o.status]||o.status)}</span>${o.status==='running'?`<button data-cancel="${esc(o.operationId)}" ${disabled}>请求取消</button>`:''}<button data-inspect="${esc(o.operationId)}">核对详情</button></div><p class="muted">${esc(o.updatedAt)}</p>${o.error?'<p class="error">'+esc(o.error)+'</p>':''}<details><summary>操作身份与文件</summary><pre>${esc(JSON.stringify(o,null,2))}</pre></details></section>`).join(''):'<p class="empty">当前工程没有操作记录。</p>';
 }
}
function renderFlow(){
 $('flow').hidden=!state.projectId;const select=$('flow-session'),old=select.value;
 select.innerHTML=state.flowSessions.map(s=>`<option value="${esc(s.sessionId)}">${esc(s.sessionId)} · ${s.live?'在线':'离线'}</option>`).join('')||'<option value="">先在聊天中读取此工程</option>';
 if(state.flowSessions.some(s=>s.sessionId===old))select.value=old;
 const selected=state.flowSessions.find(s=>s.sessionId===select.value),r=selected?.run;
 const current=state.project?.todos.find(t=>t.status==='doing'&&t.owner===select.value);
 $('flow-state').textContent=(r?({running:'运行中',paused:'已暂停',stopped:'已停止',completed:'任务核验通过'}[r.status]||r.status)+' · '+(r.reason||'')+' · 步骤 '+r.steps+'/'+r.max_steps+' · 续跑 '+r.continuations+'/'+r.max_continuations:'尚未启动')+(current?' · 当前 #'+current.seq+' '+current.title:'');
 renderGoal();
}
function renderGoal(){
 const box=$('goal-box');if(!box)return;box.hidden=!state.projectId;
 const v=state.goalView,g=v?.goal,r=v?.run,j=v?.jev,sessionId=$('flow-session').value;
 const local=state.availableSessions.some(s=>s.sessionId===sessionId),enabled=canManage()&&local&&g&&(!r||r.executor_session_id===sessionId);
 const buttons=[['finish','核对完成',!!r&&!['completed','stopped'].includes(r.status)]];
 box.innerHTML=`<div class="actions"><strong>目标心流</strong>${buttons.map(([id,label,available])=>`<button data-goal="${id}" ${enabled&&available?'':'disabled'}>${label}</button>`).join('')}<button data-goal="acceptance" ${enabled&&r?'':'disabled'}>验收记录</button></div>`+
  (g?`<p><strong>${esc(g.title)}</strong> · ${esc(({running:'运行中',paused:'已暂停',waiting:'等待中',stopped:'已停止',completed:'已完成'})[r?.status]||'待启动')} / ${esc(({planning:'规划',executing:'施工',verifying:'验收',reconciling:'核对',responding:'回答用户'})[r?.phase]||'目标提案')}</p><p>${esc(g.objective)}</p><p>${esc(r?.pause_reason||'')}</p><details><summary>范围、约束与验收条件</summary><p>${esc(g.scope)}</p><p>${esc(g.constraints)}</p><ol>${g.criteria.map(c=>`<li>${esc(c.requirement)} · ${esc(({machine:'机器检查',semantic:'语义复核',human:'用户确认'})[c.category]||c.category)}</li>`).join('')}</ol></details><p class="muted">步骤 ${esc(r?.consumed?.steps||0)} / ${esc(r?.budgets?.maxSteps||'待授权')}；续跑 ${esc(r?.consumed?.calls||0)} / ${esc(r?.budgets?.maxCalls||'待授权')}；时间上限 ${esc(r?.budgets?.maxMinutes||'待授权')} 分钟。继续保留累计预算；聊天中指定启动预算。插话后说“继续心流”恢复。</p>`:
   `<p class="muted">${esc(state.goalError||'在聊天中说“开启心流”，Agent 会建立目标、任务与验收条件并启动。')}</p>`)+
  `<p class="muted">JEV：${j?.configured?`${esc(j.source)} · ${esc(j.keyCount)} 个 Key 轮询 · ${esc(j.model)} · 观察模式 · 已调用 ${esc(j.usage?.calls||0)} / ${esc(j.maxCalls)} 次${j.last?` · 最近 ${esc(j.last.status)}，${esc(j.last.attempts)} 次请求`:''}`:esc(j?.reason||'尚未读取配置')}。语义判断不替代用户授权或目标验收。</p>`;
}
async function loadGoal(){
 const sessionId=$('flow-session').value,projectId=state.projectId,generation=state.generation;
 state.goalView=null;state.goalError='';
 if(!sessionId||!projectId){renderGoal();return;}
 try{const v=await panel('goal.status',{sessionId,projectId});if(generation!==state.generation||sessionId!==$('flow-session').value)return;state.goalView=v;}
 catch(e){if(generation!==state.generation)return;state.goalError='目标心流暂不可用：'+e.message;}
 renderGoal();
}
function renderContext(){
 const c=state.context;
 const sessions=[...new Map([...state.flowSessions,...state.availableSessions].map(s=>[s.sessionId,s])).values()];
 if(!sessions.length){$('content').innerHTML='<p class="empty">没有本机活动会话。打开聊天并发送消息后，这里会出现它的上下文；日常任务无需绑定工程。</p>';return;}
 const select=`<div class="actions"><label>会话<select id="ctx-session">${sessions.map(s=>`<option value="${esc(s.sessionId)}"${s.sessionId===state.ctxSession?' selected':''}>${esc(s.sessionId)} · ${esc(s.agentStatus||'')}</option>`).join('')}</select></label><button data-action="ctx-refresh">刷新</button></div>`;
 if(!state.ctxSession||!sessions.some(s=>s.sessionId===state.ctxSession)){$('content').innerHTML=select+'<p class="empty">选择一个会话查看上下文压力、候选与已压缩原文。</p>';return;}
 if(!c||c.sessionId!==state.ctxSession){$('content').innerHTML=select+'<p class="empty">正在读取上下文…</p>';return;}
 const st=c.status,verdict=st.verdict,budget=st.workBudget,tidy=st.automatic;
 const phaseNames={idle:'就绪',deferred:'收尾缓冲',active:'整理中',completed:'已达目标',paused:'已暂停'};
 const stageNames={current:'进行中',finished:'已结束',upcoming:'未开始',halted:'受阻'};
 const classNames={'ongoing-stage':'进行中阶段','closed-stage':'已结束阶段','halted-stage':'受阻阶段','stale-output':'旧输出'};
 const stageLine=Object.entries(st.stageCounts).map(([k,v])=>`${stageNames[k]||k} ${v}`).join(' · ');
 const prot=st.protectionCounts.map(p=>`${p.reason}×${p.count}`).join('、')||'无';
 const hitsHtml=c.hits&&c.hits.hits.length?c.hits.hits.map(h=>`<li><code>${esc(h.blockId)}</code> ${esc(h.kind)}${h.onSurface?'':'（已压缩）'} — ${esc(h.preview.slice(0,160))}… <button data-action="ctx-open" data-block="${esc(h.blockId)}">查看</button></li>`).join(''):'';
 $('content').innerHTML=select+`
 <div class="ctx-grid">
  <section class="ctx-card"><h3>压力与裁决</h3><p>${esc(verdict.reason)}</p><p class="muted">${st.pressure.state==='known'?`请求 ${st.pressure.value.requestTokens} / 窗口 ${st.pressure.value.windowTokens}（来源 ${esc(st.pressure.value.source)}，${esc(st.pressure.value.measuredAt)}）`:'压力未接入或不可用：'+esc(st.pressure.state==='unavailable'?st.pressure.reason:'')}</p></section>
  <section class="ctx-card"><h3>工作预算与自动整理</h3>${budget?`<p>模型容量 ${st.pressure.value.windowTokens.toLocaleString()} · 可用输入 ${st.pressure.value.effectiveBudgetTokens.toLocaleString()} tokens</p><p>工作上限 <strong>${budget.limit.toLocaleString()}</strong> tokens</p><p class="muted">提醒 ${budget.remind.toLocaleString()} → 安排整理 ${budget.autoTidy.toLocaleString()} → 必须整理 ${budget.preferTidy.toLocaleString()} → 停止自主续跑 ${budget.stop.toLocaleString()}</p><p>目标 ${budget.targetLow.toLocaleString()}–${budget.targetHigh.toLocaleString()} tokens</p>`:'<p class="muted">窗口未知时只观察，不猜测容量。</p>'}${tidy?`<p><strong>${esc(phaseNames[tidy.phase]||tidy.phase)}</strong> · ${esc(tidy.reason)}</p><p class="muted">步骤 ${tidy.steps}/48 · 已确认 ${tidy.commits} 次 · 宿主请求净减少 ${(tidy.measuredRequestReductionTokens??tidy.reclaimedTokens).toLocaleString()} tokens · 失败 ${tidy.failures}/3</p>${tidy.deferral?`<p class="muted">收尾 ${tidy.deferral.steps}/${tidy.deferral.maxSteps} 步 · 截止 ${esc(new Date(tidy.deferral.expiresAt).toLocaleTimeString())}</p>`:""}${tidy.failureHistory?.length?`<div class="ctx-failures"><p>失败明细（${tidy.failureHistory.length}）</p><ul>${tidy.failureHistory.map(f=>`<li>${esc(new Date(f.at).toLocaleTimeString())} · ${esc(f.code||"")} ${esc(f.tool||"")} ${esc(f.action||"")}：${esc(f.reason)}</li>`).join("")}</ul></div>`:""}<div class="actions"><button data-action="ctx-pause-tidy">暂停整理</button><button data-action="ctx-request-summary">请求整理 / 重试</button></div>`:''}<p class="muted">整理前有进行中任务可收尾最多 3 步 / 2 分钟；达到必须整理阈值不再延后。整理最多 10 分钟；无安全候选会暂停。已暂停的工程须手动继续。原文检索不调用模型。</p></section>
  ${st.recommendation?`<section class="ctx-card"><h3>整理建议</h3><p>${esc(st.recommendation.reason)}</p>${st.recommendation.candidate?`<p>建议候选 <code>${esc(st.recommendation.candidate.candidateId)}</code> · 正文约 ${st.recommendation.candidate.estimatedSpanTokens} tokens · 目标摘要约 ${st.recommendation.candidate.summaryTargetTokens} tokens</p>`:`<p>暂无安全候选</p>`}<p class="muted">${esc(st.recommendation.strategy)} 自动计数只包含本轮维护，直接 compact 不计入。</p></section>`:""}
  <section class="ctx-card"><h3>阶段与保护</h3><p>${esc(stageLine)}${st.bound?'':' · <span class="error">未绑定任务</span>'}</p><p class="muted">保护：${esc(prot)}</p><div class="actions"><label>固定用途<input id="ctx-purpose" placeholder="为什么保留这段"></label></div><p class="muted">固定：${st.pinned.length?st.pinned.map(p=>`#${p.seq}（${esc(p.purpose)}）`).join('、'):'无'}</p></section>
  ${st.budgetAnalysis?`<section class="ctx-card"><h3>批量整理与可达性估算</h3><p>受保护正文约 ${esc(st.budgetAnalysis.protectedTokens)} tokens · 可整理正文约 ${esc(st.budgetAnalysis.compressibleTokens)} tokens</p><p>建议一批 ${esc(st.budgetAnalysis.batchSize)} 段，预计节省约 ${esc(st.budgetAnalysis.estimatedBatchSavingTokens)} tokens；整理后请求约 ${esc(st.budgetAnalysis.estimatedRequestAfterBatch??'待计量')} tokens。</p><p>${esc(st.budgetAnalysis.advice)}</p><p class="muted">${esc(st.budgetAnalysis.estimateNote)} 保护正文只是正文下限；实际请求还包含工具定义、媒体和摘要。</p><p class="muted">当前上下文已有的内容不必全文重读。原生手动 /compact 仍可在会话空闲时使用；批量整理与手动压缩由同一服务协调。</p></section>`:''}
  <section class="ctx-card"><h3>可整理候选（${c.candidates.candidates.length}）</h3>${c.candidates.candidates.length?'<ul>'+c.candidates.candidates.map(k=>`<li><code>${esc(k.candidateId)}</code> · ${esc(classNames[k.classification]||k.classification)} · 约 ${k.estimatedTokens} tokens${k.stageRefs.length?' · 任务 '+k.stageRefs.map(r=>'#'+r.taskId+'('+esc(r.status)+')').join('、'):''}${k.protectionReasons.length?`<br><span class="muted">边界保护：${esc(k.protectionReasons.join('、'))}</span>`:''}</li>`).join('')+'</ul>':'<p class="muted">暂无可整理候选；提交压缩由会话内的 Agent 执行，面板只展示。</p>'}</section>
  <section class="ctx-card"><h3>原文检索</h3><div class="actions"><label>关键词<input id="ctx-query" value="${esc(state.ctxQuery)}" placeholder="空格分词，同时命中"></label><button data-action="ctx-search">搜索</button></div>${hitsHtml?'<ul class="ctx-hits">'+hitsHtml+'</ul>':(c.hits?'<p class="muted">没有命中；已压缩的原文也在检索范围内。</p>':'')}
  <details><summary>全部块（${c.blocks.blocks.length}）</summary><ul class="ctx-blocks">${c.blocks.blocks.slice(0,100).map(b=>`<li><code>${esc(b.blockId)}</code> ${esc(b.kind)} · ${b.chars} 字${b.onSurface?'':' · <span class="muted">已压缩'+(b.shadowedBy?`（摘要 sb:${b.shadowedBy}）`:'')+'</span>'} <button data-action="ctx-open" data-block="${esc(b.blockId)}">查看</button>${b.onSurface&&b.kind!=='system'?` <button data-action="ctx-pin" data-seq="${esc(b.blockId.slice(2))}">固定</button>`:''}${b.onSurface?` <button data-action="ctx-unpin" data-seq="${esc(b.blockId.slice(2))}">解除</button>`:''}</li>`).join('')}</ul></details></section>
  <section class="ctx-card"><h3>整理请求</h3><p class="muted">这里可手动请求整理；忙碌时排队、送达前可取消。正在整理可用“暂停整理”停止后续操作。</p>${c.requests.length?'<ul>'+c.requests.map(r=>`<li><code>${esc(r.requestId)}</code> · ${esc(r.createdAt)} <button data-action="ctx-cancel-summary" data-request="${esc(r.requestId)}">取消</button></li>`).join('')+'</ul>':''}<div class="actions"><button data-action="ctx-request-summary">请求 Agent 整理</button></div></section>
 </div>`;
}
async function loadContext(force=false){
 const known=(state.availableSessions||[]).map(s=>s.sessionId);
 let sessionId=$('ctx-session')?.value||state.ctxSession||known[0];
 if(!known.includes(sessionId))sessionId=known[0]||'';
 if(!sessionId){state.context=null;render();return;}
 state.ctxSession=sessionId;
 const generation=state.generation;
 const [status,candidates,blocks,requests]=await Promise.all([
  panel('context.status',{sessionId}),panel('context.candidates',{sessionId}),
  panel('context.blocks',{sessionId}),panel('context.pending-summaries',{sessionId})]);
 if(generation!==state.generation)return;
 state.context={sessionId,status,candidates,blocks,requests:requests.requests,hits:force?null:(state.context&&state.context.sessionId===sessionId?state.context.hits:null)};
 render();
}
function openTask(id,action){
 const t=state.project.todos.find(t=>t.id===id);state.taskEdit={id,action,revision:t.revision,expectedOwner:t.owner,projectId:state.projectId,projectRevision:state.project.revision};
 const completion=['complete','advance'].includes(action),replan=action==='replan',handoff=action==='handoff';
 const sessions=[...new Map([...state.flowSessions,...state.availableSessions].map(s=>[s.sessionId,s])).values()].filter(s=>s.sessionId!==t.owner);
 $('diff-title').textContent='#'+t.seq+' '+t.title;
 $('diff-body').innerHTML=`<p>${handoff?'跨会话接力':esc(action)} · 当前修订 ${t.revision}。${completion?'结论由提交者声明；引用由服务端核对。':''}</p>
 ${handoff?'<p>当前执行会话：<code>'+esc(t.owner)+'</code></p><p>保留任务、进度与证据，旧心流暂停；接手会话同步 Todo 和交接说明，不自动启动模型。</p><label>接手会话 ID<input id="task-target" list="handoff-sessions" placeholder="选择或粘贴目标会话 ID"></label><datalist id="handoff-sessions">'+sessions.map(s=>'<option value="'+esc(s.sessionId)+'">'+esc(s.agentStatus||'已登记')+'</option>').join('')+'</datalist>':''}
 <label>${handoff?'交接原因与下一步':completion?'完成结论':'进度或原因'}<textarea id="task-note"></textarea></label>
 ${completion?'<label>检查方式与通过结果<input id="task-check"></label><label>产物相对路径或调查 URL<input id="task-reference"></label>':''}
 ${replan?'<label>任务标题<input id="task-title" value="'+esc(t.title)+'"></label><label>类型<select id="task-kind"><option value="general">通用</option><option value="code">代码</option><option value="research">调查</option><option value="document">文档</option></select></label><label>验收条件<input id="task-criteria" value="'+esc(t.criteria)+'"></label><label>前置任务 ID 数组<input id="task-dependencies" value="'+esc(JSON.stringify(t.dependencies||[]))+'"></label>':''}
 ${action==='advance'?'<label>下一任务<select id="task-next">'+state.project.todos.filter(n=>n.id!==id&&['pending','paused','blocked'].includes(n.status)).map(n=>'<option value="'+n.id+'">#'+n.seq+' '+esc(n.title)+'</option>').join('')+'</select></label>':''}
 <button id="task-submit">${handoff?'确认交接并同步':'提交'}</button>`;$('diff-dialog').showModal();
}
async function submitTask(){
 const e=state.taskEdit;if(!e||e.projectId!==state.projectId)throw new Error('工程已切换，请重新打开任务');
 const note=$('task-note').value.trim(),task={taskAction:e.action,taskId:e.id,expectedRevision:e.revision,sessionId:$('flow-session').value||'panel',note,reason:note};
 if(e.action==='handoff'){
  const target=$('task-target').value.trim();if(!target||target===e.expectedOwner||target==='panel')throw new Error('请选择不同的接手会话');if(!note)throw new Error('请说明交接原因与下一步');
  task.sessionId='panel';task.expectedOwner=e.expectedOwner;task.targetSessionId=target;
 }
 if(['complete','advance'].includes(e.action)){const ref=$('task-reference').value.trim();task.evidence=JSON.stringify({summary:note,check:$('task-check').value,result:'passed',refs:[/^https?:\/\//.test(ref)?{type:'source',url:ref,finding:note}:{type:'file',path:ref}]});}
 if(e.action==='advance'){const n=state.project.todos.find(t=>t.id===Number($('task-next').value));if(!n)throw new Error('请选择下一任务');task.nextTaskId=n.id;task.nextExpectedRevision=n.revision;}
 if(e.action==='replan'){task.dependencies=$('task-dependencies').value||'[]';task.title=$('task-title').value;task.kind=$('task-kind').value;task.criteria=$('task-criteria').value;}
 const r=await panel('tasks.action',{projectId:e.projectId,expectedRevision:e.projectRevision,task});$('diff-dialog').close();await afterMutation(r);
}
async function loadSelected(){
 const generation=++state.generation,projectId=state.projectId,docId=state.document?.id;
 const [doc,project]=await Promise.all([docId?panel('documents.read',{id:docId}):null,projectId?panel('projects.get',{projectId}):null]);
 if(generation!==state.generation)return;
 state.document=doc;state.project=project;
 if(projectId){const f=await panel('flow.status',{projectId});if(generation!==state.generation)return;state.flowSessions=f.sessions;state.availableSessions=f.availableSessions||[];}else {state.flowSessions=[];state.availableSessions=[];}
 const local=await panel('context.sessions');if(generation!==state.generation)return;state.availableSessions=local.sessions;
 renderFlow();await loadGoal();if(generation!==state.generation)return;
 if(state.tab==='context'){await loadContext();return;}
 if(state.tab==='history'&&projectId){const r=await panel('history.list',{projectId});if(generation!==state.generation)return;state.history=r.nodes;}
 if(state.tab==='operations'&&projectId){const r=await request({method:'operations',projectId});if(generation!==state.generation)return;state.operations=r;}
 render();$('sync-time').textContent='最近同步 '+new Date().toLocaleTimeString();
}
async function refresh(initial=false){
 const b=await panel('bootstrap');state.documents=b.documents;state.projects=b.projects;state.revision=b.revision;
 if(initial){
  let saved;try{saved=JSON.parse(localStorage.getItem('forge-panel-selection')||'null');}catch{}
  state.library=saved?.library==='documents'?'documents':'projects';
  state.document=state.library==='documents'?(b.documents.find(d=>d.id===saved?.id)||b.documents[0]||null):null;
  state.projectId=state.library==='documents'?(state.document?.project_id||''):(b.projects.find(p=>p.id===saved?.id)||b.projects[0])?.id||'';
 }
 if(state.projectId&&!b.projects.some(p=>p.id===state.projectId)){state.projectId='';state.project=null;}
 await loadSelected();
}
function rememberSelection(){try{localStorage.setItem('forge-panel-selection',JSON.stringify({library:state.library,id:state.library==='projects'?state.projectId:state.document?.id}));}catch{}}
async function selectProject(id){state.library='projects';state.document=null;state.project=null;state.projectId=id;state.tab='plan';rememberSelection();await loadSelected();}
async function selectDocument(id){const doc=state.documents.find(d=>d.id===id);if(!doc)return;state.library='documents';state.document=doc;state.projectId=doc.project_id||'';state.project=null;state.tab='plan';rememberSelection();await loadSelected();}
async function run(fn){try{await fn();}catch(e){notice(e.message+(e.receipt?' · '+(labels[e.receipt.status]||e.receipt.status)+' · '+e.receipt.operationId:''),true);}}
async function afterMutation(result){if(result.receipt&&!['committed','completed'].includes(result.receipt.status))throw Object.assign(new Error('操作结果需要检查'),{receipt:result.receipt});notice('已保存');await refresh();}
document.addEventListener('click',event=>{const b=event.target.closest('button');if(!b||b.disabled)return;run(async()=>{
 if(b.dataset.action==='blueprint-versions'){
  const id=state.document.id,r=await panel('documents.versions',{id});
  if(state.document?.id!==id)return;
  $('diff-title').textContent='施工图历史版本';
  $('diff-body').innerHTML=r.versions.map(v=>`<section><p>${esc(v.created_at)} · ${esc(v.reason)} · ${esc(labels[v.state]||({prepared:'写入结果待核对'})[v.state]||v.state)}</p><button data-blueprint-version="${esc(v.id)}" data-document-id="${esc(id)}">比较此操作前的正文</button></section>`).join('')||'<p>尚无版本化精简记录。以后的精简和回退会保留修改前正文。</p>';
  $('diff-dialog').showModal();return;
 }
 if(b.dataset.blueprintVersion){
  const id=b.dataset.documentId,versionId=b.dataset.blueprintVersion;
  const [current,old]=await Promise.all([panel('documents.read',{id}),panel('documents.version',{id,versionId})]);
  state.blueprintRestore={id,versionId,expectedHash:current.sourceHash};
  $('diff-title').textContent='比较施工图版本';
  $('diff-body').innerHTML=diffHtml(current.markdown,old.markdown,'当前正文','将恢复的旧正文')+'<label>回退原因<input id="blueprint-restore-reason"></label><button data-action="blueprint-restore">恢复此版本</button><p class="muted">提交时再次核对当前正文；回退前的版本也会保存。</p>';return;
 }
 if(b.dataset.action==='blueprint-restore'){
  const target=state.blueprintRestore,reason=$('blueprint-restore-reason').value.trim();if(!target||!reason)throw new Error('请填写回退原因');
  const result=await panel('documents.restore',{...target,reason});$('diff-dialog').close();state.blueprintRestore=null;await afterMutation(result);return;
 }
 if(b.dataset.goal){
  const action=b.dataset.goal,sessionId=$('flow-session').value,projectId=state.projectId,v=state.goalView;
  if(action==='acceptance'){
   const r=await panel('goal.acceptance',{sessionId,projectId});state.goalAcceptance=r;
   $('diff-title').textContent='目标验收记录';$('diff-body').innerHTML=`<pre>${esc(JSON.stringify(r.acceptance,null,2))}</pre>`+r.verifications.verifications.map(x=>`<details><summary>${esc(x.verificationId)} · ${esc(x.decision)}</summary><pre>${esc(JSON.stringify(x,null,2))}</pre><label>复核理由<textarea id="review-${esc(x.verificationId)}"></textarea></label><button data-goal-review="${esc(x.verificationId)}" data-verdict="accepted">用户确认通过</button><button data-goal-review="${esc(x.verificationId)}" data-verdict="rejected">拒绝</button></details>`).join('');$('diff-dialog').showModal();return;
  }
  if(action!=='finish')throw new Error('请在聊天中控制心流');
  const input={expectedRevision:v?.goal?.revision,expectedGeneration:v?.run?.generation};
  const r=await panel('goal.control',{sessionId,projectId,action,input});await afterMutation(r);return;
 }
 if(b.dataset.goalReview){
  const verificationId=b.dataset.goalReview,reason=$('review-'+verificationId).value.trim();if(!reason)throw new Error('请填写实际核验依据');
  await panel('goal.review',{sessionId:$('flow-session').value,projectId:state.projectId,input:{verificationId,verdict:b.dataset.verdict,reason}});$('diff-dialog').close();await loadGoal();return;
 }
 if(b.dataset.taskHistory){const r=await panel('tasks.history',{projectId:state.projectId,taskId:Number(b.dataset.taskHistory)});$('diff-title').textContent='任务状态与证据历史';$('diff-body').innerHTML='<pre>'+esc(JSON.stringify(r.events,null,2))+'</pre>';$('diff-dialog').showModal();return;}
 if(b.dataset.task){openTask(Number(b.dataset.taskId),b.dataset.task);return;}
 if(b.id==='task-submit'){await submitTask();return;}
 if(b.dataset.library){$('filter').value='';if(b.dataset.library==='projects')await selectProject(state.projectId||state.projects[0]?.id||'');else{state.library='documents';state.document=null;state.project=null;state.projectId='';state.tab='plan';if(state.documents[0])await selectDocument(state.documents[0].id);else render();}return;}
 if(b.dataset.project){await selectProject(b.dataset.project);return;}
 if(b.dataset.document){await selectDocument(b.dataset.document);return;}
 if(String(b.dataset.action||'').startsWith('ctx-')){
  const sessionId=state.ctxSession;
  if(b.dataset.action==='ctx-refresh'){await loadContext(true);return;}
  if(!sessionId){notice('先选择会话',true);return;}
  if(b.dataset.action==='ctx-search'){
   const q=$('ctx-query').value.trim();state.ctxQuery=q;if(!q){notice('搜索词不能为空',true);return;}
   const hits=await panel('context.search',{sessionId,query:q});
   if(state.context)state.context.hits=hits;render();return;}
  if(b.dataset.action==='ctx-open'){
   const r=await panel('context.readFull',{sessionId,blockId:b.dataset.block});
   $('diff-title').textContent='原文 '+b.dataset.block;$('diff-body').innerHTML='<pre>'+esc(r.text||'(空)')+'</pre>'+(r.invalid?'<p class="error">'+esc(r.invalid.reason)+'</p>':'')+'<p class="muted">人读视图；不调用模型，不消耗预算。</p>';
   $('diff-dialog').showModal();return;}
  if(b.dataset.action==='ctx-pin'||b.dataset.action==='ctx-unpin'){
   const seq=Number(b.dataset.seq);
   if(b.dataset.action==='ctx-pin'){const purpose=($('ctx-purpose')?.value||'').trim()||'面板固定';await panel('context.pin',{sessionId,seq,purpose});}
   else await panel('context.unpin',{sessionId,seq});
   await loadContext();return;}
  if(b.dataset.action==='ctx-request-summary'){await panel('context.request-summary',{sessionId});await loadContext();return;}
  if(b.dataset.action==='ctx-pause-tidy'){await panel('context.pause-tidy',{sessionId});await loadContext();return;}
  if(b.dataset.action==='ctx-cancel-summary'){await panel('context.cancel-summary',{sessionId,requestId:b.dataset.request});await loadContext();return;}
  return;
 }
 if(b.dataset.tab){state.tab=b.dataset.tab;notice('');await loadSelected();return;}
 if(b.dataset.close){$(b.dataset.close).close();return;}
 if(b.dataset.node){const r=await panel('nodes.diff',{projectId:state.projectId,nodeId:Number(b.dataset.node)});$('diff-title').textContent=r.node.file_path+' · n'+r.node.id;
  $('diff-body').innerHTML=diffHtml(r.before.binary?'[二进制]':r.before.text,r.after.binary?'[二进制]':r.after.text)+`<p class="muted">历史前后版本；预检将重新读取当前磁盘。后续已有 ${r.laterChanges} 次记录。</p><div class="actions"><button data-preview="before" data-node-id="${r.node.id}" ${canManage()?'':'disabled'}>撤销此变动</button><button data-preview="after" data-node-id="${r.node.id}" ${canManage()?'':'disabled'}>恢复到此版本</button></div>`;$('diff-dialog').showModal();return;}
 if(b.dataset.preview){const p=await panel('rollback.preview',{projectId:state.projectId,nodeId:Number(b.dataset.nodeId),mode:b.dataset.preview});state.preview=p;$('diff-dialog').close();$('preview-title').textContent=p.file+' · 回退预检';$('preview-body').innerHTML=`<p>${p.willDelete?'将文件移到回收站':'恢复指定历史版本'} · 署名：本机用户</p>`+diffHtml(p.binary?'[二进制]':p.current,p.binary?'[二进制]':p.target,'当前磁盘','将恢复的目标')+p.conflicts.map(c=>'<p class="error">'+esc(c)+'</p>').join('');$('rollback-reason').value='';$('commit-rollback').disabled=true;$('preview-status').textContent='预检有效期 60 秒；提交时再次核对文件。';$('preview-dialog').showModal();return;}
 if(b.dataset.cancel){const r=await request({method:'cancel',operationId:b.dataset.cancel});notice(r.requested?'已请求取消，等待最终状态':labels[r.status]||r.status);await loadSelected();return;}
 if(b.dataset.inspect){const r=await request({method:'inspect',operationId:b.dataset.inspect});$('diff-title').textContent='操作核对';$('diff-body').innerHTML='<pre>'+esc(JSON.stringify(r,null,2))+'</pre>';$('diff-dialog').showModal();return;}
 if(b.dataset.rebase){const c=state.comparison;if(!c||c.projectId!==state.projectId)throw new Error('工程已切换，请重新比较');for(const[k,v]of state.drafts)if(k.startsWith(c.projectId+':'))v.baseRevision=c.revision;const r=state.reports.get(c.projectId);if(r)r.revision=c.revision;$('diff-dialog').close();notice('已采用所比较的版本为基线；草稿保留，请继续编辑并保存。');return;}
 const action=b.dataset.action;
 if(action==='report-versions'){const r=await panel('reports.versions',{projectId:state.projectId});$('diff-title').textContent='报告历史版本';$('diff-body').innerHTML=r.versions.map(v=>'<details><summary>'+esc(v.created_at)+'</summary><pre>'+esc(v.body)+'</pre></details>').join('')||'<p>尚无历史版本。</p>';$('diff-dialog').showModal();}
 if(action==='save-todo'){const seq=Number(b.closest('[data-seq]').dataset.seq),key=state.projectId+':'+seq,d=state.drafts.get(key);if(!d){notice('没有未保存改动');return;}const r=await panel('todos.update',{projectId:state.projectId,expectedRevision:d.baseRevision,patch:{seq:String(seq),title:d.title,note:d.note||'',[d.status]:String(seq)}});state.drafts.delete(key);await afterMutation(r);}
 if(action==='add-todo'){const title=$('new-todo').value.trim();if(!title)throw new Error('请填写待办标题');await afterMutation(await panel('todos.update',{projectId:state.projectId,expectedRevision:state.project.revision,patch:{add:title}}));}
 if(action==='save-report'){const text=$('report-text').value;const r=await panel('reports.save',{projectId:state.projectId,expectedRevision:state.reports.get(state.projectId)?.revision||state.project.revision,content:text});state.reports.delete(state.projectId);await afterMutation(r);}
 if(action==='search-history'){const r=await panel('history.list',{projectId:state.projectId,keyword:$('history-query').value});state.history=r.nodes;render();}
 if(action==='import-items'){const items=[...document.querySelectorAll('[data-item]:checked')].map(i=>i.dataset.item);if(!items.length)throw new Error('请先选择工作包');await afterMutation(await panel('workitems.import',{projectId:state.projectId,expectedRevision:state.project.revision,documentId:state.document.id,contentHash:state.document.contentHash,items}));}
});});
document.addEventListener('input',event=>{
 const input=event.target,task=input.closest('[data-seq]');
 if(task){const seq=Number(task.dataset.seq),key=state.projectId+':'+seq,d={baseRevision:state.project.revision,...(state.drafts.get(key)||state.project.todos.find(t=>t.seq===seq))};d[input.dataset.field]=input.value;state.drafts.set(key,d);}
 if(input.id==='report-text')state.reports.set(state.projectId,{content:input.value,revision:state.reports.get(state.projectId)?.revision||state.project.revision});
 if(input.id==='rollback-reason')$('commit-rollback').disabled=!canManage()||!input.value.trim()||!state.preview||state.preview.conflicts.length>0||Date.now()>state.preview.expiresAt;
 $('review-drafts').hidden=!dirty();
});
$('review-drafts').addEventListener('click',()=>run(async()=>{const p=await panel('projects.get',{projectId:state.projectId});state.comparison={projectId:state.projectId,revision:p.revision};const local={todos:[...state.drafts.entries()].filter(([k])=>k.startsWith(state.projectId+':')).map(([,v])=>v),report:state.reports.get(state.projectId)?.content};$('diff-title').textContent='比较本地草稿与服务器版本';$('diff-body').innerHTML=diffHtml(JSON.stringify(local,null,2),JSON.stringify({todos:p.todos,report:p.project.report},null,2),'本地未保存草稿','服务器当前版本')+'<p>请确认草稿已包含需要保留的服务器改动，再采用此版本为保存基线。</p><button data-rebase="true">采用此版本为基线，保留草稿</button>';$('diff-dialog').showModal();}));
$('projects').addEventListener('change',()=>run(async()=>{state.projectId=$('projects').value;state.project=null;rememberSelection();await loadSelected();}));
$('flow-session').addEventListener('change',()=>{renderFlow();run(()=>loadGoal());});
document.addEventListener('change',event=>{if(event.target?.id==='ctx-session')run(()=>loadContext());});
$('filter').addEventListener('input',renderSidebar);
$('refresh').addEventListener('click',()=>run(()=>refresh()));
$('sidebar-toggle').addEventListener('click',()=>{document.body.classList.toggle('hide-sidebar');$('sidebar-toggle').setAttribute('aria-expanded',String(!document.body.classList.contains('hide-sidebar')));});
$('permissions-toggle').addEventListener('click',()=>{$('permissions').hidden=!$('permissions').hidden;$('permissions-toggle').setAttribute('aria-expanded',String(!$('permissions').hidden));});
$('register').addEventListener('click',()=>run(async()=>{const d=await panel('documents.register',{path:$('document-path').value.trim()});state.library='documents';state.document=d;state.projectId=d.project_id||'';state.tab='plan';rememberSelection();await refresh();}));
$('link-project').addEventListener('click',()=>run(async()=>{await panel('documents.link',{id:state.document.id,projectId:state.projectId,expectedRevision:state.document.revision});await refresh();notice('施工图关联已更新');}));
$('open-source').addEventListener('click',()=>run(()=>panel('documents.open',{id:state.document.id})));
$('commit-rollback').addEventListener('click',()=>run(async()=>{const p=state.preview;if(!p||Date.now()>p.expiresAt)throw new Error('预检已过期，请重新预检');$('commit-rollback').disabled=true;const r=await panel('rollback.commit',{previewToken:p.previewToken,reason:$('rollback-reason').value});if(r.receipt?.status!=='committed'&&r.status!=='noop')throw Object.assign(new Error('回退结果待检查'),{receipt:r.receipt});$('preview-dialog').close();notice(r.status==='noop'?'文件已是目标版本':'回退已完成；已新增历史记录');await loadSelected();}));
window.addEventListener('beforeunload',e=>{if(dirty()){e.preventDefault();e.returnValue='';}});
let checking=false;
setInterval(async()=>{if(document.hidden||state.tab!=='operations'||!state.projectId||!state.connected)return;try{const ops=await request({method:'operations',projectId:state.projectId});if(JSON.stringify(ops)!==JSON.stringify(state.operations)){state.operations=ops;render();}}catch{connection(false);}},2000);
setInterval(async()=>{if(document.hidden||checking)return;checking=true;const wasConnected=state.connected;try{const r=await request({method:'revision'});if(!wasConnected||r.revision!==state.revision){if(dirty()&&wasConnected){notice('工程有更新；本地草稿已保留，保存时将检查冲突。');const b=await panel('bootstrap');state.projects=b.projects;if(!b.projects.some(p=>p.id===state.projectId)){connection(false);}else{const p=await panel('projects.get',{projectId:state.projectId});state.project.capabilities=p.capabilities;if(!p.capabilities.manage)connection(false);}}else await refresh();}}catch{connection(false);}finally{checking=false;}},3000);
run(async()=>{const r=await fetch('session');if(!r.ok)throw new Error('会话失效，请重新打开施工图窗口');state.csrf=(await r.json()).csrf;await refresh(true);});
