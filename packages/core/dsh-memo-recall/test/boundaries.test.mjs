import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRecallEngine, createUserMessageTracker, lastQuerySource, pickQuerySource } from '../lib/index.js'
import { reconcileMemo } from '../lib/boundaries.js'

class OfflineSession {
  constructor(id = randomUUID(), seed = []) { this.id = id; this.events = []; this.surface = { nodes: [] }; for (const e of seed) this.append(e.type, e.data, e.surfaceOp ? { surfaceOp: e.surfaceOp, sourceEventSeqs: e.sourceEventSeqs } : {}) }
  append(type, data, opts = {}) {
    const event = structuredClone({ type, data, seq: this.events.length, time: Date.now(), ...opts })
    if (opts.surfaceOp === 'append') this.surface.nodes.push(event.seq)
    else if (opts.surfaceOp?.op === 'replace') {
      const start = this.surface.nodes.indexOf(opts.surfaceOp.startSeq), end = this.surface.nodes.indexOf(opts.surfaceOp.endSeq)
      assert.ok(start >= 0 && end >= start)
      this.surface.nodes.splice(start, end - start + 1, event.seq)
    }
    this.events.push(event)
    return event
  }
  get seq() { return this.events.length }
  snapshotEvents() { return this.events.slice() }
  eventAt(seq) { return this.events[seq] }
  deriveMessages() { return this.surface.nodes.map(seq => this.events[seq]).map(e => e.type === 'user/message' ? e.data : e.data.message).filter(m => m && (m.role === 'user' || m.content.length)) }
}

let Session = OfflineSession
if (process.env.DSH_TEST_RUNTIME) {
  const mod = await import(pathToFileURL(process.env.DSH_TEST_RUNTIME + '/dsh-session/lib/index.js'))
  Session = mod.Session
}
const msg = (text = '用户问题', id = randomUUID()) => ({ id, role: 'user', source: { kind: 'user' }, content: text === null ? [{ type: 'image', url: 'data:image/png;base64,AA==' }] : [{ type: 'text', text }] })
const raw = text => `--- (来源: 测试知识, 相关性: 99%(混合))\n[2026-10-07] - test\n[19:00] ${text}\nTag: test`
const memoMessages = session => session.deriveMessages().filter(m => m.source.kind === 'memo-recall')
const todo = (content, status = 'in_progress') => ({ content, status })

function harness(options = {}, seed) {
  const session = seed ? new Session(randomUUID(), seed) : new Session(randomUUID())
  const tracker = createUserMessageTracker()
  const append = session.append.bind(session)
  session.append = (...args) => { const event = append(...args); tracker.observe(session, event); return event }
  if (!seed) session.append('system/message', { message: { id: randomUUID(), role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'SYSTEM_UNCHANGED' }] } }, { surfaceOp: 'append' })
  const calls = [], warnings = []
  const engine = createRecallEngine({ tracker, logger: { warn: s => warnings.push(s) }, ...options,
    config: { timeoutMs: 10, ...options.config },
    callRecall: async query => { calls.push(query); return options.callRecall ? options.callRecall(query) : raw(query) },
  })
  async function step(messages = [], extras = [], signal = new AbortController().signal, decisionKind = 'enter') {
    const decision = await engine.listener({ agent: { session }, messages, signal }, async () => ({ kind: decisionKind, messages: [...messages, ...extras] }))
    if (decision.kind === 'enter' && !signal.aborted) for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' })
    return decision
  }
  return { session, tracker, engine, calls, warnings, step, todos: list => session.append('todo/write', { todos: list }) }
}

test('first accepted user message is recalled before its durable user/message event', async () => {
  const h = harness(); await h.step([msg('第一条')])
  assert.deepEqual(h.calls, ['第一条']); assert.equal(memoMessages(h.session).length, 1); assert.deepEqual(h.warnings, [])
})

test('Markdown recall is injected, empty hits are counted without leaking text, and the boundary is pinned', async () => {
  const debug = []
  const h = harness({ config: { debug: true, topN: 1 }, writeDebug: line => debug.push(JSON.parse(line)), callRecall: async () =>
    '--- (来源: private-folder, 相关性: 99%(混合))\n[路径: file:///private/empty.md]\nTag: empty\n' +
    '--- (来源: private-folder, 相关性: 90%(混合))\n[路径: file:///private/note.md]\n# SYNTHETIC_MARKDOWN\nuseful body' })
  await h.step([msg('private-query')]); await h.step()
  assert.equal(h.calls.length, 1)
  assert.match(JSON.stringify(memoMessages(h.session)), /SYNTHETIC_MARKDOWN/)
  const parsed = debug.filter(d => d.phase === 'parse-result')
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].parsedHits, 2)
  assert.equal(parsed[0].emptyBodyHits, 1)
  assert.equal(parsed[0].selectedHits, 1)
  assert.doesNotMatch(JSON.stringify(parsed), /private|SYNTHETIC_MARKDOWN|useful body/)
  assert.deepEqual(h.warnings, [])
})

test('metadata-only recall clears the old block without a fetch failure or cooldown', async () => {
  const debug = []
  let empty = false
  const h = harness({ config: { debug: true, maxFailures: 1 }, writeDebug: line => debug.push(JSON.parse(line)), callRecall: async () =>
    empty ? '--- (来源: 测试, 相关性: 99%(混合))\n[2026-10-08] - test\nTag: empty' : raw('VALID_BODY') })
  await h.step([msg('first')]); assert.equal(memoMessages(h.session).length, 1)
  empty = true; await h.step([msg('empty')]); await h.step()
  assert.equal(memoMessages(h.session).length, 0)
  assert.equal(h.calls.length, 2)
  assert.ok(debug.some(d => d.phase === 'parse-result' && d.emptyBodyHits === 1 && d.selectedHits === 0))
  empty = false; await h.step([msg('next')]); assert.equal(memoMessages(h.session).length, 1)
  assert.equal(h.calls.length, 3)
  assert.deepEqual(h.warnings, [])
  assert.ok(!debug.some(d => ['fetch-error', 'cooldown'].includes(d.phase)))
})

test('parser diagnostics are optional and a failing debug sink cannot break recall', async () => {
  const quiet = []
  const h = harness({ writeDebug: line => quiet.push(line) })
  await h.step([msg('quiet')]); assert.deepEqual(quiet, [])
  const throwing = harness({ config: { debug: true }, writeDebug() { throw Error('offline log failure') } })
  await throwing.step([msg('logging failure')]); assert.equal(memoMessages(throwing.session).length, 1)
  assert.deepEqual(throwing.warnings, [])
})

test('pending lists keep user memory until a task explicitly starts',async()=>{
 const h=harness();await h.step([msg('user scope')]);h.todos([todo('A','pending'),todo('B','pending')]);await h.step();
 assert.deepEqual(h.calls,['user scope']);h.todos([todo('A'),todo('B','pending')]);await h.step();assert.deepEqual(h.calls,['user scope','A']);
})
test('Forge activation owns memory; mirrors, progress and flow heartbeats never refresh it',async()=>{
 const h=harness();await h.step([msg('user scope')]);
 const boundary=(revision,taskId,activationId,text)=>h.session.append('forge/task-boundary',{projectId:'p',revision,taskId,activationId,text,bound:true});
 boundary(0,null,null,'');await h.step();assert.deepEqual(h.calls,['user scope']);
 boundary(1,1,'a','first');await h.step();
 h.session.append('todo/write',{forge:true,todos:[todo('different display')]});await h.step([{...msg('continue'),source:{kind:'forge-flowlock'}}]);
 boundary(1,1,'a','renamed mirror');await h.step();assert.deepEqual(h.calls,['user scope','first']);
 await h.step([msg('user interruption')]);boundary(1,1,'a','first');await h.step();assert.deepEqual(h.calls,['user scope','first','user interruption']);
 boundary(2,1,'b','first');await h.step();assert.deepEqual(h.calls,['user scope','first','user interruption','first']);
 boundary(1,2,'stale','old');await h.step();assert.equal(h.calls.length,4);
 boundary(3,null,null,'');await h.step();assert.equal(memoMessages(h.session).length,0);
})
test('Forge focus survives turn start and restored Session log',async()=>{
 const h=harness();h.session.append('forge/task-boundary',{projectId:'p',revision:1,taskId:1,activationId:'a',text:'work',bound:true});await h.step();
 h.session.append('turn/start',{turn:2});await h.step();assert.equal(h.calls.length,1);
 const restored=harness({},h.session.snapshotEvents());await restored.step();assert.equal(restored.calls.length,0);assert.equal(memoMessages(restored.session).length,1);
})
test('same message: stable bytes and position through tool steps beyond TTL', async () => {
  let now = 0; const h = harness({ now: () => now, config: { ttlMs: 1 } }); await h.step([msg('A')])
  const initial = h.session.deriveMessages(), count = h.session.snapshotEvents().length
  now = 9999999; for (let i = 0; i < 5; i++) await h.step()
  assert.equal(h.calls.length, 1); assert.equal(h.session.snapshotEvents().length, count); assert.deepEqual(h.session.deriveMessages(), initial)
})
test('new user ID with same text creates a new boundary; raw historical memo remains in audit only', async () => {
  const h = harness(); await h.step([msg('相同')]); const old = memoMessages(h.session)[0]
  await h.step([msg('相同')]); assert.equal(h.calls.length, 2); assert.equal(memoMessages(h.session).length, 1)
  assert.ok(!h.session.deriveMessages().some(m => m.id === old.id)); assert.ok(h.session.snapshotEvents().some(e => e.data.id === old.id))
  assert.equal(h.session.deriveMessages().filter(m => m.source.kind === 'user').length, 2)
})
test('image-only and empty user messages clear old recall without querying an older user', async () => {
  for (const text of ['', null]) {
    const h = harness(); await h.step([msg('old')]); await h.step([msg(text)])
    assert.equal(h.calls.length, 1); assert.equal(memoMessages(h.session).length, 0)
  }
})
test('unrelated Todo updates do not override a newer user message', async () => {
  const h = harness(); h.todos([todo('A'), todo('B', 'pending')]); await h.step(); await h.step([msg('用户插话')])
  h.todos([todo('B', 'completed'), todo('A')]); await h.step()
  assert.deepEqual(h.calls, ['A', '用户插话']); assert.ok(memoMessages(h.session)[0].content[0].text.includes('用户插话'))
})
test('Todo A -> B -> A is three distinct boundaries', async () => {
  const h = harness(); for (const text of ['A', 'B', 'A']) { h.todos([todo(text)]); await h.step() }
  assert.deepEqual(h.calls, ['A', 'B', 'A']); assert.equal(memoMessages(h.session).length, 1)
})
test('full Todo identity is compared before query truncation, and optional IDs distinguish duplicate titles', async () => {
  const h = harness(); for (const t of [todo('x'.repeat(205) + 'A'), todo('x'.repeat(205) + 'B'), { ...todo('same'), id: '1' }, { ...todo('same'), id: '2' }]) { h.todos([t]); await h.step() }
  assert.equal(h.calls.length, 4); assert.equal(h.calls[0], h.calls[1])
})
test('all completed and empty lists clear recall; repeated empty writes do not steal a newer user boundary', async () => {
  for (const list of [[], [todo('A', 'completed')]]) {
    const h = harness(); await h.step([msg('old')]); h.todos([todo('A')]); await h.step(); h.todos(list); await h.step()
    assert.equal(memoMessages(h.session).length, 0); assert.deepEqual(h.calls, ['old', 'A'])
    await h.step([msg('new')]); h.todos(list); await h.step(); assert.deepEqual(h.calls, ['old', 'A', 'new'])
  }
})
test('tool proposals and failed/unexecuted Todo calls cannot change the boundary', async () => {
  const h = harness(); await h.step([msg('real')])
  h.session.append('tool/call', { name: 'todo_write', arguments: { todos: [todo('proposal')] } })
  h.tracker.observe(h.session, { seq: 900, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'todo_write', arguments: { todos: [todo('proposal')] } }] } } })
  await h.step(); assert.deepEqual(h.calls, ['real'])
})
test('cold fold and hot incremental events agree; queued messages are not yet boundaries', async () => {
  const h = harness(); await h.step([msg('U')]); h.todos([todo('A')]); await h.step(); await h.step([msg('V')]); h.todos([todo('A'), todo('B', 'completed')])
  const events = h.session.snapshotEvents(); assert.deepEqual(pickQuerySource(lastQuerySource(events)), pickQuerySource(h.tracker.lastOf(h.session)))
  const before = pickQuerySource(h.tracker.lastOf(h.session))
  h.tracker.observe(h.session, { seq: events.length, type: 'agent/inbox/spliced', data: { inserted: [msg('queued')] } })
  assert.equal(pickQuerySource(h.tracker.lastOf(h.session)), before)
})
test('late response from A cannot overwrite B', async () => {
  let finishA; const h = harness({ callRecall: query => query === 'A' ? new Promise(r => { finishA = r }) : raw('B') })
  await h.step([msg('A')]); await h.step([msg('B')]); const before = memoMessages(h.session)[0]
  finishA(raw('STALE_A')); await sleep(1); await h.step()
  assert.deepEqual(memoMessages(h.session), [before]); assert.deepEqual(h.calls, ['A', 'B'])
})
test('same-boundary timed-out response may fill in once, then stays pinned', async () => {
  let finish; const h = harness({ callRecall: () => new Promise(r => { finish = r }) })
  await h.step([msg('slow')]); assert.equal(memoMessages(h.session).length, 0)
  finish(raw('late')); await sleep(1); await h.step(); const before = h.session.deriveMessages()
  await h.step(); assert.equal(h.calls.length, 1); assert.deepEqual(h.session.deriveMessages(), before)
})
test('empty result and failure are both cached per boundary, including synchronous exceptions', async () => {
  for (const callRecall of [() => '', () => { throw Error('offline') }]) {
    const h = harness({ callRecall }); await h.step([msg('A')]); await h.step(); await h.step()
    assert.equal(h.calls.length, 1); assert.equal(memoMessages(h.session).length, 0)
    await h.step([msg('B')]); assert.equal(h.calls.length, 2)
  }
})
test('other sessions triggering cooldown cannot erase a pinned successful boundary', async () => {
  const owner = harness(); await owner.step([msg('pinned')])
  const engine = createRecallEngine({ config: { maxFailures: 1 }, callRecall: () => { throw Error('offline') } })
  const saved = await engine.resolve(owner.session) // restores the surviving pinned block
  const other = harness(); await other.step([msg('error')]); reconcileMemo(other.session, 'none', '')
  await engine.resolve(other.session); assert.equal((await engine.resolve(owner.session)).text, saved.text)
  const fresh = harness(); fresh.tracker.admit(fresh.session, [msg('cold')]);
  // engine has its own tracker: commit a real user before asking it to resolve.
  fresh.session.append('user/message', msg('cold'), { surfaceOp: 'append' })
  assert.equal((await engine.resolve(fresh.session)).text, '')
})
test('many other sessions do not evict an active boundary', async () => {
  const h = harness({ config: { maxSessions: 1 } }); await h.step([msg('pinned')]); const before = memoMessages(h.session)[0]
  for (let i = 0; i < 4; i++) { const other = harness(); other.session.append('user/message', msg('other'), { surfaceOp: 'append' }); await h.engine.resolve(other.session) }
  await h.step(); assert.equal(h.calls.filter(q => q === 'pinned').length, 1); assert.deepEqual(memoMessages(h.session), [before])
})
test('restore reuses the surviving block without recall, including after a Todo', async () => {
  const h = harness(); await h.step([msg('U')]); h.todos([todo('A')]); await h.step()
  const restored = harness({}, h.session.snapshotEvents()); await restored.step()
  assert.equal(restored.calls.length, 0); assert.deepEqual(memoMessages(restored.session), memoMessages(h.session))
})
test('compaction can remove a block; live boundary reuses its pinned text on reinsertion', async () => {
  const h = harness(); await h.step([msg('A')]); const before = memoMessages(h.session)[0].content
  reconcileMemo(h.session, 'compacted', ''); await h.step()
  assert.equal(h.calls.length, 1); assert.deepEqual(memoMessages(h.session)[0].content, before)
})
test('legacy mixed snapshots lose only memo sections; current other context and tool results remain', async () => {
  const h = harness(); const sections = [{ name: 'time', text: 'TIME_KEEP' }, { name: 'memo-recall', text: 'OLD_MEMO' }]
  h.session.append('user/message', { ...msg('legacy'), source: { kind: 'runtime-context', form: 'snapshot', sections } }, { surfaceOp: 'append' })
  h.session.append('tool/result', { message: { id: randomUUID(), role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1', content: [{ type: 'text', text: 'TOOL_KEEP' }] } }, { surfaceOp: 'append' })
  await h.step([msg('NEW_MEMO')]); const text = JSON.stringify(h.session.deriveMessages())
  assert.ok(text.includes('TIME_KEEP') && text.includes('TOOL_KEEP') && text.includes('SYSTEM_UNCHANGED')); assert.ok(!text.includes('OLD_MEMO'))
  assert.ok(h.session.snapshotEvents().some(e => JSON.stringify(e).includes('OLD_MEMO')))
  assert.deepEqual(h.warnings, [])
})
test('dynamic context changes do not copy or move the dedicated memo block', async () => {
  const h = harness(); await h.step([msg('A')]); const before = memoMessages(h.session)[0]
  for (const text of ['time1', 'time2']) await h.step([], [{ ...msg(text), source: { kind: 'runtime-context', sections: [{ name: 'time', text }] } }])
  assert.deepEqual(memoMessages(h.session), [before]); assert.equal(h.calls.length, 1)
})
test('rejected or canceled pre-step does not clear existing memo or send recall', async () => {
  const h = harness(); await h.step([msg('A')]); const before = h.session.deriveMessages()
  await h.step([msg('rejected')], [], undefined, 'reject'); const controller = new AbortController(); controller.abort()
  await h.step([msg('canceled')], [], controller.signal)
  assert.deepEqual(h.session.deriveMessages(), before); assert.deepEqual(h.calls, ['A'])
})
test('disabling recall clears previous plugin blocks without touching the real user', async () => {
  const h = harness(); await h.step([msg('A')]); const disabled = harness({ config: { enabled: false } }, h.session.snapshotEvents())
  await disabled.step(); assert.equal(memoMessages(disabled.session).length, 0); assert.equal(disabled.calls.length, 0)
  assert.ok(disabled.session.deriveMessages().some(m => m.source.kind === 'user'))
})
test('new turn resets the official Todo but does not resurrect an old user boundary', async () => {
  const h = harness(); await h.step([msg('old')]); h.todos([todo('A')]); await h.step(); h.session.append('turn/start', { turn: 2 }); await h.step()
  assert.equal(memoMessages(h.session).length, 0); assert.deepEqual(h.calls, ['old', 'A'])
})
test('cancel during recall restores the previous admitted boundary; late canceled response is discarded', async () => {
  let finish; const h = harness({ callRecall: query => query === 'cancel' ? new Promise(r => { finish = r }) : raw(query) })
  await h.step([msg('A')]); const before = memoMessages(h.session)
  const controller = new AbortController(); const pending = h.step([msg('cancel')], [], controller.signal)
  await sleep(1); controller.abort(); await pending; finish(raw('canceled')); await sleep(1); await h.step()
  assert.deepEqual(memoMessages(h.session), before); assert.deepEqual(h.calls, ['A', 'cancel'])
})
test('surface replacement of an older real user does not become a new task', async () => {
  const h = harness(); const first = msg('old'); await h.step([first]); await h.step([msg('current')])
  const node = h.session.surface.nodes.find(seq => h.session.eventAt(seq).data.id === first.id)
  h.session.append('user/message', { ...first, content: [{ type: 'text', text: 'compacted old user' }] }, { surfaceOp: { op: 'replace', startSeq: node, endSeq: node }, sourceEventSeqs: [node] })
  await h.step(); assert.deepEqual(h.calls, ['old', 'current'])
})
test('hot steps do not repeatedly scan the full event log', async () => {
  const h = harness(); let scans = 0; const snapshot = h.session.snapshotEvents.bind(h.session)
  h.session.snapshotEvents = () => { scans++; return snapshot() }
  await h.step([msg('A')]); for (let i = 0; i < 5; i++) await h.step()
  assert.equal(scans, 0) // Initial system event already initialized the tracker.
})
