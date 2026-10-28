import { createUserMessageTracker, pickQuerySource, retainedMemo, reconcileMemo } from './boundaries.js'
import {
  createPulseGovernor, createPulseMessage, createTrajectoryTracker, effectiveToolName, pickLastToolExchange,
  pickPulseSource, renderPulse, toolKind, actionLabel, trajectoryPrefix,
} from './pulse.js'
import { createFlowEntropyTracker } from './flow-entropy.js'
import { createStageGate } from './stage-gate.js'
import { createPsjdShadow } from './psjd-rules.js'

const TIMEOUT = Symbol('memo-recall-timeout')
export function raceTimeout(promise, ms) {
  let timer
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(TIMEOUT), ms) })])
    .finally(() => clearTimeout(timer))
}

export function createBoundaryEngine({ callRecall, config: cfg, render, parseLens, logger, now = Date.now, writeDebug, tracker }) {
  const track = tracker || createUserMessageTracker()
  // 本地动作流熵（Step 3）：默认只做 shadow，阈值用真实分布标定后再启用注入。
  const flowEntropy = cfg.flowEntropyShadow === true || cfg.flowEntropyInject === true
    ? createFlowEntropyTracker({
      windowSize: cfg.flowEntropyWindow,
      minSteps: cfg.flowEntropyMinSteps,
      useFullPath: cfg.flowEntropyFullPath === true
    })
    : null
  // PSJD-C：确定性规则观测器（shadow，不注入）。enforce 开启后升级为两级熔断执行臂（WP3）。
  const psjdShadow = cfg.psjdShadow === true
    ? createPsjdShadow({
      stallThreshold: cfg.psjdStallThreshold,
      enforce: cfg.psjdEnforce, haltStall: cfg.psjdHaltStall,
      haltAfter: cfg.psjdHaltAfter, l1PerBoundary: cfg.psjdL1PerBoundary,
    })
    : null
  // 每会话最近 3 个动作标签（去连续重复），供脉冲查询拼成有序曲线前缀。
  const recentLabels = new WeakMap()
  function pushActionLabel(session, label) {
    if (!label) return trajectoryPrefix(recentLabels.get(session) || [])
    const list = recentLabels.get(session) || []
    // 同类别连续动作合并（跑命令 → 跑命令✗ 只留最新一条），避免 ✗ 标记造成重复占位。
    const base = value => String(value).replace(/✗$/, '')
    if (list.length && base(list.at(-1)) === base(label)) list[list.length - 1] = label
    else list.push(label)
    while (list.length > 3) list.shift()
    recentLabels.set(session, list)
    return trajectoryPrefix(list)
  }
  const governor = createPulseGovernor({ config: cfg, now })
  const stageGate = createStageGate({ config: cfg })
  const trajectory = createTrajectoryTracker(cfg.pulseReadTools)
  const cache = new WeakMap() // One pinned boundary per live Session; no TTL/LRU eviction.
  let failures = 0
  let failUntil = 0
  function debug(data) {
    if (cfg.debug && writeDebug) { try { writeDebug(JSON.stringify({ ts: now(), ...data })) } catch {} }
  }
  const current = (session, entry) => cache.get(session) === entry && pickQuerySource(track.lastOf(session))?.key === entry.key

  async function resolve(session) {
    const boundary = pickQuerySource(track.lastOf(session))
    const key = boundary?.key || 'none'
    if (!cfg.enabled) return { key, text: '' }
    let entry = cache.get(session)
    if (!entry || entry.key !== key) {
      entry = { key, text: '', done: false, promise: null }
      cache.set(session, entry)
      const restored = retainedMemo(session, key)
      if (restored !== null) { entry.text = restored; entry.done = true }
    }
    if (entry.done) {
      debug({ sessionId: session.id, phase: 'boundary-hit', kind: boundary?.kind, key, chars: entry.text.length })
      return entry
    }
    const query = Array.from(String(boundary?.text || '').replace(/\s+/g, ' ').trim()).slice(0, cfg.queryMaxChars).join('')
    if (!query || now() < failUntil) {
      entry.done = true
      debug({ sessionId: session.id, phase: query ? 'cooldown' : 'empty-boundary', key })
      return entry
    }
    if (!entry.promise) {
      entry.promise = Promise.resolve().then(() => callRecall(query, cfg)).then(raw => {
        if (!current(session, entry)) { debug({ sessionId: session.id, phase: 'stale-discard', key }); return }
        entry.text = render(raw)
        entry.done = true
        failures = 0
        debug({ sessionId: session.id, phase: 'fetched', key, chars: entry.text.length })
      }).catch(error => {
        if (!current(session, entry)) return
        entry.done = true // A failed lookup is also pinned until the next boundary.
        failures++
        if (failures >= cfg.maxFailures) { failUntil = now() + cfg.cooldownMs; failures = 0 }
        logger?.warn('[memo-recall] 召回失败，本边界跳过: ' + String(error?.message || error))
        debug({ sessionId: session.id, phase: 'fetch-error', key })
      })
    }
    if (await raceTimeout(entry.promise, cfg.timeoutMs) === TIMEOUT) debug({ sessionId: session.id, phase: 'timeout-skip', key })
    return current(session, entry) ? entry : null
  }

  /** 通道 B 的取值窗口：会话日志尾部最近若干事件（seq 递减 + eventAt，不做全量拷贝）。
   *  必须走日志而非 surface：宿主把 tool/call 作为纯日志事件追加（不带 surfaceOp），
   *  surface 只承载消息层（user/assistant/tool-result）——按 surface 取窗口永远配不上 call↔result。 */
  function recentEvents(session, limit = 40) {
    const out = []
    const known = Number(session.seq)
    const last = Number.isFinite(known) ? known - 1 : session.snapshotEvents().length - 1
    for (let seq = last; seq >= 0 && out.length < limit; seq--) {
      const event = session.eventAt(seq)
      if (event) out.push(event)
    }
    return out.reverse()
  }

  /** 上一拍模型自述的尾部（T2 意图通道原料；跨轮即停，不回溯到用户消息之前）。 */
  function lastAssistantText(events, maxChars = 120) {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type === 'user/message') break
      if (event?.type !== 'assistant/message') continue
      const content = event.data?.message?.content
      if (!Array.isArray(content)) return ''
      const text = content.filter(b => b?.type === 'text').map(b => b.text).join(' ').replace(/\s+/g, ' ').trim()
      return Array.from(text).slice(-maxChars).join('')
    }
    return ''
  }

  const PULSE_THRESHOLDS = { pulseThreshold: 75, pulseErrorThreshold: 65, pulseIntentThreshold: 60, pulsePostureThreshold: 70 }
  const pulseThreshold = (key) => {
    const v = Number(cfg[key])
    return Number.isFinite(v) ? v : PULSE_THRESHOLDS[key]
  }

  /** 脉冲查询参数：只查透镜库、不做联想，k 收窄——脉冲要的是「最像的那一枚」。 */
  function pulseQueryConfig() {
    // rerank 只在通道 A 生效：脉冲是异步发射＋下一拍取用，精排耗时会把透镜全拖成超时。
    return { ...cfg, folders: cfg.pulseFolders || cfg.folders, k: Number(cfg.pulseK) || 5, associate: false, rerank: '', jev: '' }
  }

  /** 通道 B 的两拍状态（实测 VCP 侧查询地板 ≈1.6–2.1s，同步等待会拖垮每个工具步）：
   *  发射后即返回，结果落定留待下一拍 preStep 取用——关键路径零额外时延，透镜晚约一拍到达。
   *  - pending：每会话至多一处在途（防子进程堆积），带死线防悬挂，超死线即丢弃。
   *  - observed：已入账的最后一个工具步 callId——同一工具步只 observe/查询一次，
   *    既防轨迹重复计数把姿态信号灌虚，也防取用后对同一交换重发查询。 */
  const pendings = new WeakMap()
  const observed = new WeakMap()

  /** 发射查询：不 await；落定后写进 per-session 槽位等下一拍取用。 */
  function issuePulse(session, pick, callId, key, isError) {
    const state = {
      callId, mode: pick.mode, key, isError, issuedAt: now(),
      status: 'inflight', card: null, threshold: pulseThreshold(pick.thresholdKey),
    }
    pendings.set(session, state)
    // 查询原文入账：准确率与「本地候选 vs 远端选卡」一致率都以它为分母，缺了就只能猜。
    debug({ sessionId: session.id, phase: 'pulse-issued', mode: state.mode, key, query: String(pick.query || '').slice(0, 600) })
    const promise = Promise.resolve()
      .then(() => callRecall(pick.query, pulseQueryConfig()))
      .catch((error) => {
        state.status = 'error' // 已在下面记过相位：别让结算拍把它误记成超时
        if (state.key === governor.currentBoundary()) governor.chargeEmpty()
        debug({ sessionId: session.id, phase: 'pulse-fetch-error', mode: state.mode, error: String(error?.message || error).slice(0, 120) })
        return null
      })
    Promise.resolve(raceTimeout(promise, Number(cfg.pulseTimeoutMs) || 5000)).then((raw) => {
      if (pendings.get(session) !== state || state.status !== 'inflight') return // 槽位已换：本次结果作废
      state.readyAt = now() // 死线从落定起算：查询耗时与结果新鲜度无关
      const sameBoundary = state.key === governor.currentBoundary()
      if (raw === TIMEOUT || raw === null || raw === undefined) {
        state.status = 'timeout'
        if (sameBoundary) governor.chargeEmpty()
        debug({ sessionId: session.id, phase: 'pulse-timeout', mode: state.mode, key })
        return
      }
      const hits = parseLens ? parseLens(raw, state.threshold) : []
      // k 个候选里顺延：跳过本边界/全会话已达上限的卡，取第一张分值达标的可用卡。
      const cardKeyOf = (h) => String(h?.path || h?.title || '')
      const best = hits.find(h => governor.isCardAllowed(cardKeyOf(h), state.isError))
      if (!best) {
        state.status = 'miss'
        if (sameBoundary) governor.chargeEmpty()
        debug({ sessionId: session.id, phase: hits.length ? 'pulse-card-throttled' : 'pulse-miss', mode: state.mode, key, threshold: state.threshold, candidates: hits.length })
        return
      }
      state.card = best
      state.status = 'ready'
      debug({ sessionId: session.id, phase: 'pulse-ready', mode: state.mode, key, score: best.score, card: best.title })
    }).catch(() => {})
  }

  /**
   * 取用上一拍落定的结果。
   *
   * 边界切换时不再无条件丢弃：error 模式的卡讲的是「怎么排查这类错」，与用户新说了
   * 什么无关，只要没过死线就继续携带（实测 19 天 dropped 243 次，全是这类浪费）；
   * intent / posture / smell 依赖边界文本，边界一换就作废，维持原丢弃语义。
   */
  function carryPulse(session, key) {
    const state = pendings.get(session)
    if (!state || state.status === 'inflight') return null
    pendings.delete(session)
    const sameBoundary = state.key === key
    const crossBoundary = !sameBoundary && state.mode === 'error' && cfg.pulseCarryErrorAcrossBoundary !== false
    if (!sameBoundary && !crossBoundary) {
      debug({ sessionId: session.id, phase: 'pulse-dropped', reason: 'boundary', mode: state.mode, card: state.card ? state.card.title : undefined, score: state.card ? state.card.score : undefined })
      return null
    }
    const settledAt = Number.isFinite(state.readyAt) ? state.readyAt : state.issuedAt
    if (now() - settledAt > (Number(cfg.pulsePendingTtlMs) || 120000)) {
      debug({ sessionId: session.id, phase: 'pulse-expired', mode: state.mode, key, card: state.card ? state.card.title : undefined, score: state.card ? state.card.score : undefined })
      return null
    }
    if (state.status !== 'ready' || !state.card) return null // miss/timeout 已在结算时记过相位
    const best = state.card
    const cardKey = String(best.path || best.title || '')
    if (!governor.allowInject(cardKey, state.isError)) {
      debug({ sessionId: session.id, phase: 'pulse-card-throttled', mode: state.mode, card: best.title })
      return null
    }
    const text = renderPulse({ title: best.title, body: best.body }, cfg)
    if (!text) return null
    governor.record(cardKey)
    debug({
      sessionId: session.id,
      phase: crossBoundary ? 'pulse-carried-across' : 'pulse-carried',
      mode: state.mode, key, score: best.score, card: best.title, chars: text.length,
      ...(crossBoundary ? { fromKey: state.key } : {}),
    })
    return createPulseMessage(text, { cardKey, boundaryKey: key })
  }

  /** 通道 B：每工具步的姿态/摩擦/意图查询 → 下一拍 append-only 注入一枚透镜。失败一律静默。 */
  function pulseStep(session) {
    if (cfg.pulseEnabled === false) return null
    const boundary = pickQuerySource(track.lastOf(session))
    const key = boundary?.key || 'none'
    governor.setBoundary(key)
    trajectory.setBoundary(key)
    stageGate.setBoundary(key)
    psjdShadow?.setBoundary(session, key)
    const carried = carryPulse(session, key) // 先取用上一拍的在途结果
    const events = recentEvents(session)
    const exchange = pickLastToolExchange(events)
    if (!exchange) return carried
    const callId = exchange.call?.callId
    if (!callId || observed.get(session) === callId) return carried // 同一工具步只入账/查询一次
    observed.set(session, callId)
    trajectory.observe(exchange.call, exchange.result)
    // 流熵观测放在读步早退之前：读步也是动作流的一段，否则「查→查→查」会被漏掉。
    let flowVerdict = null
    if (flowEntropy) {
      flowEntropy.observe(session, exchange.call)
      flowVerdict = flowEntropy.verdict(session)
      if (cfg.flowEntropyShadow === true && flowVerdict.actionable) {
        debug({
          sessionId: session.id, phase: 'flow-entropy-shadow',
          regime: flowVerdict.regime, reason: flowVerdict.reason,
          omega: flowVerdict.omega, selfLoop: flowVerdict.selfLoopRatio,
          revisit: flowVerdict.revisitRatio, steps: flowVerdict.steps, window: flowVerdict.windowSize
        })
      }
    }
    // 读步也要进轨迹：查证→改码→跑测试 的方向性由读步起头，免查不等于免记录。
    const trajectoryText = pushActionLabel(session, actionLabel(exchange.call, exchange.result))
    if (toolKind(effectiveToolName(exchange.call), cfg.pulseReadTools) === 'read') return carried // 纯读步免查：不产生无声错误，也不撞红灯
    const inflight = pendings.get(session)
    if (inflight && inflight.status === 'inflight') return carried // 上一拍未结算：不叠加子进程（每会话至多一处在途）
    governor.tick()
    const assistantText = lastAssistantText(events)
    // PSJD 两级熔断（WP3）：异常拍（意外/停滞）优先级最高——先于收敛令与透镜当拍注入本地合成卡；
    // 异常拍接受丢弃在途 carried 卡（时效 > 上一拍查询成果），psjd-l1 / psjd-l2 相位入 debug。
    let psjdVerdict = null
    if (psjdShadow) {
      psjdVerdict = psjdShadow.evaluate(session, {
        call: exchange.call, result: exchange.result, assistantText, flowVerdict,
      })
      if (psjdVerdict.enforce) {
        debug({ sessionId: session.id, phase: `psjd-${psjdVerdict.enforce.level}`, mode: psjdVerdict.mode, flagReason: psjdVerdict.flagReason, stall: psjdVerdict.stall, errStreak: psjdVerdict.errStreak, fileRepeat: psjdVerdict.fileRepeat, chars: Array.from(psjdVerdict.enforce.text).length, key })
        return createPulseMessage(psjdVerdict.enforce.text, { cardKey: `psjd:${psjdVerdict.enforce.level}:${psjdVerdict.mode}`, boundaryKey: key, form: `psjd-${psjdVerdict.enforce.level}` })
      }
    }
    // 阶段闸门（WP2 · HarnessPro 三段闸门移植）：写步预算治理，本地合成收敛令。
    // 与已落定透镜撞拍时让位顺延（不浪费查询成果）；收敛令拍直接返回，不再发新查询。
    const gate = stageGate.step()
    if (gate) {
      if (carried) {
        stageGate.stash(gate)
      } else {
        debug({ sessionId: session.id, phase: 'stage-gate', stage: gate.stage, kind: gate.kind, steps: gate.steps, remindNo: gate.remindNo, chars: Array.from(gate.text).length, key })
        return createPulseMessage(gate.text, { cardKey: `stage:${gate.stage}`, boundaryKey: key, form: 'stage-gate' })
      }
    }
    const pick = pickPulseSource({
      call: exchange.call, result: exchange.result,
      assistantText, trajectory, boundaryText: boundary?.text,
      trajectoryText,
    })
    if (psjdVerdict) {
      debug({
        sessionId: session.id, phase: 'psjd-shadow', key, ...psjdVerdict,
        legacyMode: pick?.mode || 'none',
        diverge: Boolean(psjdVerdict.shouldFire) !== Boolean(pick),
      })
    }
    if (!pick) return carried
    const isError = pick.mode === 'error'
    if (!governor.allowQuery(isError)) {
      debug({ sessionId: session.id, phase: 'pulse-throttled', mode: pick.mode, key, ...governor.snapshot() })
      return carried
    }
    issuePulse(session, pick, callId, key, isError)
    return carried
  }

  return {
    tracker: track,
    resolve,
    async listener(payload, next) {
      const decision = await next()
      if (decision.kind !== 'enter' || payload.signal?.aborted) return decision
      const session = payload.agent?.session
      if (!session?.surface || typeof session.append !== 'function') return decision
      let messages = decision.messages
      try {
        // 通道 A：边界召回（用户消息 / Forge 任务激活锚）——原语义不变，走可变槽位 replace。
        // The raw claimed inputs exist before user/message is committed. Read
        // them here, so the first model step uses the new user's boundary too.
        const previous = track.checkpoint(session)
        const boundary = track.admit(session, payload.messages)
        const result = await resolve(session)
        if (payload.signal?.aborted) { track.rollback(session, previous, boundary); return decision }
        if (result && pickQuerySource(track.lastOf(session)) === boundary) {
          const message = reconcileMemo(session, result.key, result.text)
          if (message) {
            debug({ sessionId: session.id, phase: 'injected', key: result.key, chars: result.text.length })
            messages = [...messages, message]
          }
        }
      } catch (error) {
        logger?.warn('[memo-recall] 上下文维护失败: ' + String(error?.message || error))
      }
      try {
        // 通道 B：脉冲透镜——只往消息尾部追加，永不 replace、永不回收。
        const pulse = await pulseStep(session)
        if (pulse) messages = [...messages, pulse]
      } catch (error) {
        logger?.warn('[memo-recall] 脉冲透镜失败: ' + String(error?.message || error))
      }
      return messages === decision.messages ? decision : { ...decision, messages }
    },
  }
}
