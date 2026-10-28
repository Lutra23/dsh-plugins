import { randomUUID } from 'node:crypto'

export const MEMO_SOURCE = 'memo-recall'
const singleLine = (text) => String(text || '').replace(/\s+/g, ' ').trim()
const userText = (data) => singleLine((data?.content || []).filter(b => b?.type === 'text').map(b => b.text).join(' '))

export function parseTodoList(raw) {
  if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { return [] } }
  if (!Array.isArray(raw?.todos)) return []
  return raw.todos.filter(t => typeof t?.content === 'string' && t.content.trim()).map(t => ({
    content: t.content.trim(), status: String(t.status || 'pending'),
    ...(typeof t.id === 'string' ? { id: t.id } : {}),
  }))
}

function activeTodo(todos) {
  return todos.find(t => t.status === 'in_progress')
}
export function activeTodoText(todos) { return activeTodo(todos || [])?.content || '' }

function emptyRecord() { return { current: null, activeTodo: '', lastUserId: '', cursor: -1, forgeProject:null, forgeRevision:-1, forgeBindingRevision:0 } }
function acceptUser(rec, message, seq, committed = true) {
  if (message?.source?.kind !== 'user') return
  const id = message.id || `seq:${seq}`
  if (rec.lastUserId === id) {
    // Admission and later durable append are one boundary; resolve its log seq.
    if (committed && rec.current?.key === `user:${id}`) rec.current.seq = seq
    return
  }
  rec.lastUserId = id
  rec.current = { kind: 'user', key: `user:${id}`, seq, text: userText(message) }
}

function fold(rec, event) {
  if (!event || event.seq <= rec.cursor) return
  rec.cursor = event.seq
  // Current Forge persists extension metadata on native Todo snapshots;
  // retained legacy extension events still replay after format repair.
  const extension=event.type==='todo/write'&&event.data?.forge===true?event.data.forgeEvent:null
  if(extension?.type==='forge/task-boundary')event={...event,type:extension.type,data:extension.data}
  if (event.type === 'user/message' && event.surfaceOp === 'append') acceptUser(rec, event.data, event.seq)
  if(event.type==='forge/task-boundary') {
    const data=event.data
    if((data.bindingRevision??0)<rec.forgeBindingRevision)return
    if(rec.forgeProject===data.projectId&&data.revision<=rec.forgeRevision)return
    const hadTask=['forge','todo'].includes(rec.current?.kind)
    rec.forgeProject=data.projectId;rec.forgeRevision=data.revision;rec.activeTodo=''
    rec.forgeBindingRevision=data.bindingRevision??0
    if(data.activationId&&data.taskId)rec.current={kind:'forge',key:`forge:${data.projectId}:${data.taskId}:${data.activationId}`,seq:event.seq,text:data.text||''}
    else if(hadTask)rec.current={kind:'none',key:`forge-clear:${event.seq}`,seq:event.seq,text:''}
  }
  // Only the validated todo/write event changes Todo state. Tool proposals do not.
  if (event.type === 'todo/write' && !event.data?.forge && !rec.forgeProject && Array.isArray(event.data?.todos)) {
    const todo = activeTodo(parseTodoList(event.data))
    const identity = todo ? JSON.stringify([todo.id || '', todo.content]) : ''
    if (identity === rec.activeTodo) return
    rec.activeTodo = identity
    rec.current = { kind: todo ? 'todo' : 'none', key: `todo:${event.seq}`, seq: event.seq, text: todo?.content || '' }
  }
  // The official Todo projection resets at turn/start; mirror that transition.
  if (event.type === 'turn/start' && rec.activeTodo) {
    rec.activeTodo = ''
    if (rec.current?.kind === 'todo') rec.current = { kind: 'none', key: `turn:${event.seq}`, seq: event.seq, text: '' }
  }
}

export function lastQuerySource(events) {
  const rec = emptyRecord()
  for (const event of events || []) fold(rec, event)
  return rec
}
export function pickQuerySource(record) { return record?.current || null }
export function lastUserMessage(events) {
  const event = (events || []).findLast(e => e?.type === 'user/message' && e.data?.source?.kind === 'user')
  return event ? { seq: event.seq, text: userText(event.data) } : null
}

export function createUserMessageTracker() {
  const records = new WeakMap()
  function ensure(session) {
    if (!records.has(session)) records.set(session, lastQuerySource(session.snapshotEvents()))
    return records.get(session)
  }
  return {
    observe(session, event) { if (session && event) fold(ensure(session), event) },
    admit(session, messages) {
      const rec = ensure(session)
      for (const message of messages || []) acceptUser(rec, message, rec.cursor + 1, false)
      return rec.current
    },
    checkpoint(session) { return { ...ensure(session) } },
    rollback(session, previous, boundary) {
      const rec = ensure(session)
      if (rec.current === boundary && previous.current !== boundary) {
        rec.current = previous.current
        rec.lastUserId = previous.lastUserId
      }
    },
    lastOf: ensure,
  }
}

const textOf = message => (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
export function retainedMemo(session, key) {
  for (const seq of [...session.surface.nodes].reverse()) {
    const event = session.eventAt(seq)
    if (event?.type === 'user/message' && event.data.source?.kind === MEMO_SOURCE &&
        event.data.source.version === 1 && event.data.source.boundaryKey === key) return textOf(event.data)
  }
  return null
}

function retire(session, seq) {
  // pre-step runs BEFORE step/start. Developer nodes are illegal here even
  // with correct turn/step coordinates. Like the host's runtime-context clear,
  // use a nonempty, plugin-owned user snapshot; never impersonate a real user.
  session.append('user/message', {
    id: randomUUID(), role: 'user', content: [{ type: 'text', text: '此处的旧记忆快照已失效。' }],
    source: { kind: 'memo-recall-retired', form: 'retired' },
  }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
}

/** Only edit plugin-owned nodes, or our named section in legacy mixed snapshots. */
export function reconcileMemo(session, key, text) {
  let kept = false
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const message = event.data
    if (message.source?.kind === MEMO_SOURCE) {
      if (!kept && text && message.source.version === 1 && message.source.boundaryKey === key && textOf(message) === text) kept = true
      else retire(session, seq)
    } else if (message.source?.kind === 'runtime-context' && Array.isArray(message.source.sections) &&
               message.source.sections.some(s => s.name === MEMO_SOURCE)) {
      const sections = message.source.sections.filter(s => s.name !== MEMO_SOURCE)
      if (!sections.length) retire(session, seq)
      else session.append('user/message', {
        ...message, id: randomUUID(), source: { ...message.source, sections },
        content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n' + sections.map(s => s.text).join('\n\n') }],
      }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
    }
  }
  if (kept || !text) return null
  return {
    id: randomUUID(), role: 'user', content: [{ type: 'text', text }],
    source: { kind: MEMO_SOURCE, form: 'boundary-snapshot', version: 1, boundaryKey: key },
  }
}
