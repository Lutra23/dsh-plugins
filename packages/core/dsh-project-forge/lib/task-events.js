// DSH rc.2 append cannot set the top-level ignorable extension flag. Keep
// task metadata on the official Todo snapshot instead of unknown event types.
export function taskEvent(event) {
 const extension=event?.type==='todo/write'&&event.data?.forge===true?event.data.forgeEvent:null
 return extension&&['forge/task-boundary','forge/todo-evidence','forge/todo-reset'].includes(extension.type)
  ?{...event,type:extension.type,data:extension.data}:event
}
export function appendTaskEvent(session,type,data) {
 const previous=session.snapshotEvents().findLast(e=>e.type==='todo/write')?.data||{todos:[]}
 return session.append('todo/write',{...previous,forge:true,forgeEvent:{type,data}})
}
