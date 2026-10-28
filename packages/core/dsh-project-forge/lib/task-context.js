import {randomUUID,createHash} from 'node:crypto'
const SOURCE='forge-task-context'
// Official user/message replacement is valid before step/start. Never rewrite
// a user's message or another plugin's context, and never request a model here.
export function reconcileTaskContext(session,snapshot) {
 if(!session?.surface?.nodes||typeof session.eventAt!=='function')return null
 if(snapshot.projectId&&!snapshot.continuation?.text)return null
 const text=snapshot.projectId&&snapshot.continuation?.text
  ?'先处理本次用户要求；以下状态不自动恢复施工或授予续跑权限。\n'+snapshot.continuation.text
  :'当前没有绑定的工程；此前工程接力状态不再适用。'
 const nodes=[...session.surface.nodes].map(seq=>({seq,event:session.eventAt(seq)}))
  .filter(({event})=>event?.type==='user/message'&&event.data.source?.kind===SOURCE)
 if(!snapshot.projectId&&!nodes.length)return null
 const key=createHash('sha256').update(text).digest('hex')
 const message=()=>({id:randomUUID(),role:'user',source:{kind:SOURCE,version:1,key,projectId:snapshot.projectId},content:[{type:'text',text}]})
 if(!nodes.length)return message()
 const first=nodes[0]
 if(first.event.data.source.key!==key)session.append('user/message',message(),{surfaceOp:{op:'replace',startSeq:first.seq,endSeq:first.seq},sourceEventSeqs:[first.seq]})
 return null
}
