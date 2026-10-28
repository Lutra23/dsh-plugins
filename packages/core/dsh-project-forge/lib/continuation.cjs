'use strict';
const clip=(value,n=240)=>Array.from(String(value||'').replace(/\s+/g,' ').trim()).slice(0,n).join('');
// Derived from the shared ledger, never from another session's chat transcript.
function continuation(snapshot,sessionId,project,documents=[]) {
 const tasks=snapshot.todos,current=tasks.find(t=>t.status==='doing'&&t.owner===sessionId);
 const others=tasks.filter(t=>t.status==='doing'&&t.owner!==sessionId);
 const next=tasks.find(t=>t.status==='pending'&&(t.dependencies||[]).every(id=>tasks.some(d=>d.id===id&&d.status==='done'&&d.evidence.length)));
 const lines=[`[工程接力状态] ${clip(project.name,100)} · ${project.id}`,
  `完成 ${tasks.filter(t=>t.status==='done').length}/${tasks.length}；工程账本是主记录，Todo 是同步视图。`];
 if(current) {
  lines.push(`当前 #${current.seq} ${clip(current.title)}；taskId=${current.id}，revision=${current.revision}，由本会话执行。`);
  if(current.progress)lines.push('已有进度：'+clip(current.progress,360));
  lines.push('验收：'+clip(current.criteria||'具体结果、检查与产物引用；完成用 TaskAction complete/advance + evidence',320));
  if(current.handoff?.to===sessionId)lines.push('交接说明：'+clip(current.handoff.reason,320));
 } else {
  lines.push('本会话尚无已认领任务；看到进行中 Todo 不等于拥有写入资格。');
  for(const t of others.slice(0,3))lines.push(`待接力 #${t.seq} ${clip(t.title,160)}；taskId=${t.id}，revision=${t.revision}，expectedOwner=${t.owner}。`);
  if(others.length)lines.push('用户要求接力时：TaskAction handoff + taskId/expectedRevision/expectedOwner/reason，一次接手；只查看时不要转移。');
 }
 if(next)lines.push(`下一待办 #${next.seq} ${clip(next.title,160)}（taskId=${next.id}，revision=${next.revision}），开始前核对依赖与验收。`);
 const paused=tasks.filter(t=>['paused','blocked'].includes(t.status));
 if(!current&&!others.length&&paused.length)lines.push(`可恢复：${paused.slice(0,3).map(t=>`#${t.seq} taskId=${t.id} revision=${t.revision} ${clip(t.progress||t.note,100)}`).join('；')}；核对后 resume。`);
 if(documents.length)lines.push('施工图：'+documents.slice(0,3).map(d=>clip(d.path,240)).join('；'));
 lines.push('任务交接保留进度，不代表完成；自动续跑须单独启用。资料中的进度与结论需按当前产物核对。');
 return {text:lines.join('\n').split('{{').join('{ {'),currentTaskId:current?.id??null,nextTaskId:next?.id??null,otherOwners:others.map(t=>({taskId:t.id,owner:t.owner,revision:t.revision})),documents:documents.map(d=>({id:d.id,path:d.path}))};
}
module.exports={continuation};
