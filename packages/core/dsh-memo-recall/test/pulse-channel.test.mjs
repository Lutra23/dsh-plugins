// 通道 B（脉冲透镜）接线测试：真实 listener 上的双通路、纯读步免查、阈值、节流与 append-only。
// 两拍语义（实测 VCP 侧查询地板 ≈1.6–2.1s，故查询不占关键路径）：发射拍只把查询发出去，
// 下一拍 preStep 取用落定结果——所以每个工具步要驱动两拍才看得到透镜。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRecallEngine, createUserMessageTracker } from '../lib/index.js'

/** 最小离线 Session：只提供 engine 与 tracker 真正用到的面（surface/eventAt/snapshotEvents）。 */
class OfflineSession {
  constructor() { this.id = randomUUID(); this.events = []; this.surface = { nodes: [] } }
  append(type, data, opts = {}) {
    const event = structuredClone({ type, data, seq: this.events.length, time: Date.now(), ...opts })
    if (opts.surfaceOp === 'append') this.surface.nodes.push(event.seq)
    this.events.push(event)
    return event
  }
  get seq() { return this.events.length }
  snapshotEvents() { return this.events.slice() }
  eventAt(seq) { return this.events[seq] }
}

const block = (folder, score, file, body) => [
  '--- (来源: ' + folder + ', 相关性: ' + score + '%(混合))',
  '[路径: file:///C:/kb/' + file + ']',
  '[2026-10-14] - 归档',
  '[01:54] ' + body,
  'Tag: 兼容层, EditCode, if (',
  '[--- LightMemo 轻量回忆 ---]',
].join('\n')

const PLAIN = block('DSH工程档案', 91, '2026-10-01-10_00_00-某档案.txt', '事实快照正文')
const LONG_BODY = '本能想加兼容层时，把眼睛挪到状态的所有权边界。'.repeat(12)
const lens = (n, body) => block('溟月的知识', 82, '2026-10-14-00_27_0' + n + '-直觉卡·第' + n + '枚.txt', body || '本能想加兼容层时，把眼睛挪到状态的所有权边界。')
const userMsg = (text = '把鉴权这里改造一下') => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

function harness(options = {}) {
  const session = new OfflineSession()
  const tracker = createUserMessageTracker()
  const append = session.append.bind(session)
  session.append = (...args) => { const event = append(...args); tracker.observe(session, event); return event }
  const queries = []
  const warnings = []
  const deferreds = [] // manual 模式下挂起的脉冲查询（用于可复现的「在途」断言）
  let cardNo = 0
  let clock = 1000000
  const engine = createRecallEngine({
    tracker,
    logger: { warn: (s) => warnings.push(s) },
    now: () => clock,
    config: { timeoutMs: 50, pulseFloorMs: 0, ...options.config },
    ...(options.debugSink ? { writeDebug: options.debugSink } : {}),
    callRecall: async (query) => {
      const pulse = /^(EditCode|CreateFile|pwsh|ReadCode)/.test(query)
      queries.push({ query, pulse })
      if (!pulse) return PLAIN
      cardNo += 1
      const text = lens(options.sameCard ? 1 : cardNo, options.longCard ? LONG_BODY : undefined)
      if (options.manual) return new Promise(resolve => deferreds.push(() => resolve(text)))
      return text
    },
  })
  // 同一条用户消息全程复用：否则每步都会被 admit 当成新边界，配额与同卡去重会被反复重置。
  const firstUser = userMsg()
  session.append('user/message', firstUser, { surfaceOp: 'append' })

  async function run(messages) {
    const decision = await engine.listener(
      { agent: { session }, messages, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages }),
    )
    return {
      decision,
      pulses: decision.messages.filter(m => m.source?.kind === 'memo-recall-pulse'),
      memos: decision.messages.filter(m => m.source?.kind === 'memo-recall'),
    }
  }

  /** 让出事件循环：在途查询（async callRecall）需要一次宏任务才结算。 */
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))

  /** 只播事件、不驱动 listener：播一个已完结的工具步（call+result 同 callId）。 */
  function play(tool, { args = '{"path":"lib/a.js"}', error = false, text = '我先加个兼容层把它兜底一下' } = {}) {
    const callId = randomUUID()
    session.append('step/start', { turn: 1, step: session.events.length }, { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }] } }, { surfaceOp: 'append' })
    // 与真内核一致：宿主把 tool/call 作为纯日志事件追加（不带 surfaceOp），surface 只承载消息层。
    const call = session.append('tool/call', { callId, name: tool, arguments: args })
    session.append('tool/result', {
      callId,
      message: {
        id: randomUUID(), role: 'tool', callId, isError: error,
        content: [{ type: 'text', text: error ? '[exit code: 1]\nTypeError: x is not a function' : '+  if (err) return null' }],
      },
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    return callId
  }

  /** 播一个工具步并驱动两拍：发射拍（只发查询）+ 取用拍（下一拍取用注入）。 */
  async function step(tool, opts = {}) {
    const { messages = [firstUser], carryMessages, carryDelay = 0 } = opts
    play(tool, opts)
    const issued = await run(messages)
    await settle()
    if (carryDelay) clock += carryDelay
    const carried = await run(carryMessages || messages)
    return { issued, carried, decision: carried.decision, pulses: carried.pulses, memos: carried.memos }
  }

  /** 取用拍单独驱动（不改事件流）：用于「发射后不取用」的时序断言。 */
  async function carry(messages = [firstUser]) { await settle(); return run(messages) }

  return {
    session, engine, queries, warnings, run, step, carry, play, firstUser, userMsg,
    advance: (ms) => { clock += ms },
    releasePulse: () => { for (const resolve of deferreds.splice(0)) resolve() },
    pulseQueries: () => queries.filter(q => q.pulse).length,
  }
}

test('两拍时序：发射拍零注入只发查询，下一拍才取用落下', async () => {
  const h = harness()
  const r = await h.step('EditCode')
  assert.equal(r.issued.pulses.length, 0, '发射拍不得注入：查询不占关键路径')
  assert.equal(h.pulseQueries(), 1, '发射拍恰好发一次脉冲查询')
  assert.equal(r.carried.pulses.length, 1, '下一拍取用落定结果')
})

test('双通路：通道 A 在前、通道 B 追加在最后，原决策数组不被就地改写', async () => {
  const h = harness()
  const before = [userMsg()]
  const r = await h.step('EditCode', { messages: before })
  assert.equal(r.memos.length, 1, '通道 A 语义不变，仍注入边界召回')
  assert.equal(r.pulses.length, 1, '通道 B 出一枚脉冲')
  assert.equal(r.decision.messages.at(-1).source.kind, 'memo-recall-pulse', '脉冲必须在消息最尾部')
  assert.equal(r.decision.messages.at(-2).source.kind, 'memo-recall')
  assert.equal(before.length, 1, '原数组未被就地追加')
  assert.notEqual(r.decision.messages, before, '应返回新数组而非原地改')
  const text = r.pulses[0].content[0].text
  assert.ok(text.startsWith('【直觉闪现·非事实·勿引用·勿保留】'), text)
  assert.ok(text.includes('直觉卡·第1枚'), text)
  assert.deepEqual(h.warnings, [])
})

test('脉冲源用事件日志而非 surface：tool/call 不在 surface 上也能成对', async () => {
  const h = harness()
  const r = await h.step('EditCode')
  const surfaced = h.session.surface.nodes.map(seq => h.session.eventAt(seq).type)
  assert.ok(!surfaced.includes('tool/call'), '前提：真内核里 call 不入 surface，本用例才有意义')
  assert.ok(surfaced.includes('tool/result'))
  assert.equal(r.pulses.length, 1, 'call 是纯日志事件时脉冲仍须成对触发（按 surface 取窗口会一枚都不响）')
})

test('纯读步：不发脉冲查询，也不注入（通道 A 照旧）', async () => {
  const h = harness()
  const r = await h.step('ReadCode')
  assert.equal(r.pulses.length, 0)
  assert.equal(h.pulseQueries(), 0, '读步不得发起脉冲查询')
  assert.equal(h.queries.length, 1, '只剩通道 A 的边界查询')
})

test('阈值未过：查询发生了但不注入', async () => {
  const h = harness({ config: { pulseIntentThreshold: 90 } })
  const r = await h.step('EditCode')
  assert.equal(r.pulses.length, 0)
  assert.equal(h.pulseQueries(), 1, '查了一次，卡分不过线')
})

test('配置：DEFAULTS 封顶脉冲长度，profile 覆盖可放宽', async () => {
  const a = await harness({ longCard: true }).step('EditCode')
  assert.equal(a.pulses.length, 1)
  assert.ok(a.pulses[0].content[0].text.length <= 201, 'DEFAULTS.pulseMaxChars=200 未生效（句边界截断 ≤ 预算+1）: ' + a.pulses[0].content[0].text.length)
  const b = await harness({ longCard: true, config: { pulseMaxChars: 150 } }).step('EditCode')
  assert.ok(b.pulses[0].content[0].text.length > 100 && b.pulses[0].content[0].text.length <= 150, 'profile 覆盖未生效')
})

test('append-only：脉冲只在返回值里，引擎不往会话历史写任何东西', async () => {
  const h = harness()
  const eventsBefore = h.session.events.length
  await h.step('EditCode')
  assert.equal(h.session.events.length, eventsBefore + 4, '引擎自身不得追加事件（4 条是本用例播的工具步）')
  const dumped = JSON.stringify(h.session.events)
  assert.ok(!dumped.includes('memo-recall-pulse'))
  assert.ok(!dumped.includes('直觉闪现'), '脉冲文本不得落进历史（否则缓存分叉）')
})

test('关键路径零额外时延：查询永不结算也不阻塞本拍（异步发射的硬断言）', async () => {
  const h = harness({ manual: true }) // manual 模式：脉冲查询挂起，永不 resolve
  h.play('EditCode')
  const outcome = await Promise.race([
    h.run([h.firstUser]).then(r => ({ blocked: false, r })),
    new Promise(resolve => setTimeout(() => resolve({ blocked: true }), 1000)),
  ])
  assert.equal(outcome.blocked, false, '查询挂起时 listener 仍须当拍返回（把 await 加回来这条就红）')
  assert.equal(outcome.r.pulses.length, 0, '未结算自然无脉冲')
  assert.equal(outcome.r.memos.length, 1, '通道 A 照常在拍内到位，不被挂起的脉冲查询拖累')
})

test('每会话至多一处在途：上一拍未结算时不再发射新查询，结算后仍能取用', async () => {
  const h = harness({ manual: true })
  h.play('EditCode')
  await h.run([h.firstUser]) // 发射拍：查询挂起（manual 模式不自动结算）
  h.play('EditCode')
  await h.run([h.firstUser]) // 仍在途：不得叠加第二条查询
  assert.equal(h.pulseQueries(), 1, '每会话至多一处在途，防子进程堆积')
  h.releasePulse() // 挂起的查询结算
  const carried = await h.carry()
  assert.equal(carried.pulses.length, 1, '结算后下一拍取用（在途闸门不吞结果）')
})

test('边界变了：在途结果作废，不注入（透镜属于旧局面）', async () => {
  const h = harness()
  h.play('EditCode')
  const issued = await h.run([h.firstUser])
  assert.equal(issued.pulses.length, 0, '发射拍不注入')
  const next = h.userMsg('换个话题：调整日志格式')
  h.session.append('user/message', next, { surfaceOp: 'append' })
  await new Promise(resolve => setTimeout(resolve, 0)) // 在途查询结算（此时边界已换）
  const carried = await h.run([next]) // 按新边界认领
  assert.equal(carried.pulses.length, 0, '边界已变：旧边界的在途透镜必须丢弃')
  assert.equal(carried.memos.length, 1, '通道 A 照常按新边界召回，未被作废的脉冲牵连')
})

test('真实节拍：落定后隔一个完整工具步（30s）仍须取用（实机回归）', async () => {
  // 实机实证：相邻两拍 preStep 的间隔 = 模型思考 + 命令执行，重启后生产测得 29s。
  // 死线若按 8s 设，每条透镜都会在取用前过期——异步改造在生产里等于全废（日志：issued→ready 2487ms，下一拍 29s 后判 pulse-expired）。
  const h = harness()
  const r = await h.step('EditCode', { carryDelay: 30000 })
  assert.equal(r.issued.pulses.length, 0, '发射拍不注入')
  assert.equal(r.pulses.length, 1, '等一个完整工具步（30s）后取用仍须成功：死线只管语义陈旧，不管物理等待')
})

test('超死线：落定后来不及取用即丢弃', async () => {
  const h = harness()
  const r = await h.step('EditCode', { carryDelay: 130000 }) // 落定后等 130s 才取用（超防悬挂兜底 120s）
  assert.equal(r.issued.pulses.length, 0)
  assert.equal(r.pulses.length, 0, 'pulsePendingTtlMs=120000 之外的在途结果不得注入')
})

test('慢查询不算过期：死线从落定起算，不从发射起算', async () => {
  const h = harness({ manual: true })
  h.play('EditCode')
  await h.run([h.firstUser]) // 发射
  h.advance(30000) // 查询慢：发射后 30s 才落定（远超 TTL）
  h.releasePulse()
  const carried = await h.carry()
  assert.equal(carried.pulses.length, 1, '查询耗时与结果新鲜度无关：落定后仍在死线内就该注入')
})

test('配额：每边界 3 枚封顶，报错破格给第 4 枚', async () => {
  const h = harness()
  let total = 0
  for (let i = 0; i < 12; i++) total += (await h.step('EditCode')).pulses.length
  assert.equal(total, 3, '基础配额 3（首枚立即给，其后每 3 个合格步一枚）')
  for (let i = 0; i < 3; i++) total += (await h.step('EditCode')).pulses.length
  assert.equal(total, 3, '配额耗尽后即使步距够也不再注入')
  total += (await h.step('pwsh', { error: true })).pulses.length
  assert.equal(total, 4, '报错破格 +1（免步冷却）')
})

test('同卡去重：同一边界内同一张卡只注入一次', async () => {
  const h = harness({ sameCard: true })
  let total = 0
  for (let i = 0; i < 9; i++) total += (await h.step('EditCode')).pulses.length
  assert.equal(total, 1, '同边界同卡只给一次')
  assert.ok(h.pulseQueries() >= 2, '后续仍查库，只是被 allowInject 拦下')
})

test('报错破格免步冷却，但不免时间地板（被拦下时不发查询）', async () => {
  const h = harness({ config: { pulseFloorMs: 5000 } })
  assert.equal((await h.step('pwsh', { error: true })).pulses.length, 1, '首查放行（尚未注入过）')
  assert.equal((await h.step('pwsh', { error: true })).pulses.length, 0, '同一时刻第二次被时间地板拦下')
  assert.equal(h.pulseQueries(), 1, '被拦下时不发查询，省的是子进程')
  h.advance(5000)
  assert.equal((await h.step('pwsh', { error: true })).pulses.length, 1, '过地板后无需 3 个合格步即可注入')
  assert.deepEqual(h.warnings, [])
})

// —— 0.4.9 跨边界携带：error 卡的语义是「怎么排查这类错」，不该因为用户换了句话就作废 ——
/** 轮询等待在途查询落定（callRecall → raceTimeout → 状态机，单次宏任务不够）。 */
async function settled() {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 1))
}

test('跨边界携带：error 模式在途结果换边界后仍注入', async () => {
  const h = harness({ manual: true })
  h.play('EditCode', { args: '{"path":"lib/a.js"}', error: true })
  await h.run([h.firstUser])   // 发射拍：查询挂起
  h.releasePulse()             // 结果落定到 pendings
  await settled()
  const second = h.userMsg('顺便把日志也看一下')
  h.session.append('user/message', second, { surfaceOp: 'append' })
  const carried = await h.run([h.firstUser, second])
  assert.equal(carried.pulses.length, 1, 'error 卡应跨边界携带，不再被 boundary 丢弃')
})

test('跨边界携带可关闭：配置关闭后 error 卡按原语义丢弃', async () => {
  const h = harness({ manual: true, config: { pulseCarryErrorAcrossBoundary: false } })
  h.play('EditCode', { args: '{"path":"lib/a.js"}', error: true })
  await h.run([h.firstUser])
  h.releasePulse()
  await settled()
  const second = h.userMsg('顺便把日志也看一下')
  h.session.append('user/message', second, { surfaceOp: 'append' })
  const carried = await h.run([h.firstUser, second])
  assert.equal(carried.pulses.length, 0, '关闭开关后跨边界结果作废')
})

test('pulse-issued 记录查询原文：准确率与本地一致率的分母', async () => {
  const lines = []
  const h = harness({ config: { debug: true }, debugSink: (line) => lines.push(JSON.parse(line)) })
  await h.step('EditCode', { error: true })
  const issued = lines.find(e => e.phase === 'pulse-issued')
  assert.ok(issued, '必须发出 pulse-issued 相位')
  assert.equal(typeof issued.query, 'string')
  assert.ok(issued.query.includes('EditCode'), '查询原文应含工具名，实得: ' + issued.query)
  assert.ok(issued.query.length <= 600, '原文截断到 600 字，实得 ' + issued.query.length)
})

// —— 0.4.11 阶段闸门（WP2 · HarnessPro 三段闸门移植）：本地合成收敛令，不查库不吃透镜配额 ——
test('阶段闸门：写步越过经济线即拍注入收敛令，form=stage-gate 且不发透镜查询', async () => {
  const lines = []
  const h = harness({
    config: {
      debug: true,
      pulseStageEnabled: true, pulseStageEconomyAt: 1, pulseStageStrictAt: 3, pulseStageFinalizeAt: 5, pulseStageEveryN: 1,
      pulseBudgetPerTodo: 0, pulseEmptyPerTodo: 0, pulseMaxQueriesPerTodo: 0, // 关死透镜配额：出现的卡只能是阶段卡
    },
    debugSink: (line) => lines.push(JSON.parse(line)),
  })
  const r = await h.step('EditCode') // 第 1 个写步即 economy enter
  assert.equal(r.issued.pulses.length, 1, '发射拍即注入：阶段卡本地合成，无两拍时序')
  assert.equal(r.issued.pulses[0].source?.form, 'stage-gate', 'form 与透镜（pulse-lens）类型隔离')
  assert.ok(String(r.issued.pulses[0].content?.[0]?.text || '').includes('收敛令'), '收敛令文案')
  assert.equal(h.pulseQueries(), 0, '阶段卡不查 LightMemo（透镜配额已关死，查询数必为 0）')
  const gate = lines.find(e => e.phase === 'stage-gate')
  assert.ok(gate, 'stage-gate 相位入 debug 供审计（WP4 对接点）')
  assert.equal(gate.stage, 'economy')
  assert.equal(gate.steps, 1)
  assert.ok(Number.isFinite(gate.chars) && gate.chars > 0, 'chars 入账：ΔW 统计的注入体积基本量')
})

// —— 0.4.12 PSJD 两级熔断（WP3 · HarnessPro adapter 熔断移植）：异常拍优先级最高 ——
test('PSJD L1：意外红灯当拍注入行为引导卡，优先于透镜查询', async () => {
  const lines = []
  const h = harness({
    config: {
      debug: true,
      psjdShadow: true, psjdEnforce: 'l1',
      pulseBudgetPerTodo: 0, pulseEmptyPerTodo: 0, pulseMaxQueriesPerTodo: 0, // 关死透镜配额：出现的卡只能是 psjd 卡
    },
    debugSink: (line) => lines.push(JSON.parse(line)),
  })
  const r = await h.step('EditCode', { error: true, text: '已经改好了，收工' }) // 自述完成 + 工具报错 = 意外红灯
  assert.equal(r.issued.pulses.length, 1, '异常拍当拍注入（优先于收敛令与透镜）')
  assert.equal(r.issued.pulses[0].source?.form, 'psjd-l1')
  assert.ok(String(r.issued.pulses[0].content?.[0]?.text || '').includes('PSJD-L1'), '行为引导文案')
  assert.equal(h.pulseQueries(), 0, 'psjd 卡优先：本拍不发透镜查询')
  const l1 = lines.find(e => e.phase === 'psjd-l1')
  assert.ok(l1, 'psjd-l1 相位入 debug 供审计（WP4 对接点）')
  assert.equal(l1.mode, 'surprise-red')
  assert.equal(l1.flagReason, 'certain_but_failed', 'flagReason 入账：审计能区分触发类型')
  assert.ok(Number.isFinite(l1.chars) && l1.chars > 0, 'chars 入账：ΔW 统计的注入体积基本量')
})
