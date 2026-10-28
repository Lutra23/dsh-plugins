/**
 * PSJD-C：确定性直觉规则（第一刀终审后的收敛形态）。
 *
 * 为什么不是 12 维相空间几何：12,619 对回放的判决是——差分在安静步必然共线
 * （EWMA 的 ΔΦ = (1-α)(u - Φ)，无事件时精确等于 -c·Φ），半波整流虽把负回声
 * 清零却又让 35% 的步彻底失明。连续几何在这个特征空间没有出路，留下的是三条
 * 站得住的规则：
 *
 *   1) surpriseFlag：预期违背（意外红灯 / 意外绿灯）——传统四模式完全抓不到 +1
 *   2) stallScore：停滞度（报错签名不翻转 + 同文件反复改 + 流熵坍缩）
 *   3) 只做 shadow 观测：不改 pickPulseSource，先用分歧率证伪
 *
 * 判据来源：DSH工程档案 2026-10-22 PSJD 三份回放报告。
 */
import { extractErrorSignal, effectiveToolName, parseArgs } from './pulse.js'

/** 高确信收尾词：出现这类自述却拿到报错 → 意外红灯。 */
const CERTAIN = ['改好', '修好', '完成了', '搞定', '应该没问题', '收工', '好了', '就这样', '没问题了']
/** 试探/怀疑词：上一拍还在报错、这一拍试探后却全绿 → 意外绿灯。 */
const DOUBT = ['试试', '先删', '排除一下', '看看会不会', '不确定', '可能', '也许']
/** 能产生「文件」语义的工具（按 effectiveToolName 分派后的名字）。 */
const FILE_WRITE = /^(EditCode|CreateFile|ops_replace|ResolveEdit|MoveCode|CopyCode)$/

const lineCount = (s) => (s ? String(s).split('\n').length : 0)

/**
 * 预期违背三态位。
 * @returns {{flag: -1|0|1, reason: string}}
 *   -1 意外红灯：自述「改好了/收工」却 isError
 *   +1 意外绿灯：上一拍报错、这一拍试探或大幅删改却无错
 *    0 符合预期
 */
export function surpriseFlag({ call, result, assistantText, prevError, err }) {
  const isErr = err === undefined ? Boolean(extractErrorSignal(result)?.error) : err
  const text = String(assistantText || '')
  if (isErr && CERTAIN.some(w => text.includes(w))) {
    return { flag: -1, reason: 'certain_but_failed' }
  }
  if (!isErr && prevError) {
    const args = parseArgs(call) || {}
    const added = String(args.replace || args.content || '')
    const removed = String(args.target || '')
    const bigCut = lineCount(removed) >= 3 && lineCount(added) <= lineCount(removed) / 2
    if (bigCut) return { flag: 1, reason: 'trial_cut_green' }
    if (DOUBT.some(w => text.includes(w))) return { flag: 1, reason: 'trial_but_green' }
  }
  return { flag: 0, reason: '' }
}

/**
 * 会话级停滞度观测器。纯本地、无 IO、按 session 建 WeakMap 状态。
 * 只做观测，不注入。
 */
export function createPsjdShadow(options = {}) {
  const threshold = Number(options.stallThreshold ?? 0.66)
  // 两级熔断（WP3 · HarnessPro adapter 熔断移植）：
  //   L1 行为引导卡：shouldFire 且同 mode 未发过、配额未尽（l1PerBoundary，默认 2）。
  //   L2 强制熔断卡：mode==='stall' 且（stall≥haltStall 或 errStreak≥haltAfter），
  //     每边界一次；发出后本边界 psjd 干预全静默——但透镜/收敛令通道不受影响，
  //     边界切换自然复位（逃生闭环：熔断不是状态锁，排障与恢复通道照常工作）。
  const enforceLevel = options.enforce === 'l1' || options.enforce === 'l2' ? options.enforce : 'off'
  const haltStall = Number.isFinite(Number(options.haltStall)) ? Number(options.haltStall) : 0.85
  const haltAfter = Number.isFinite(Number(options.haltAfter)) ? Math.max(2, Math.floor(Number(options.haltAfter))) : 4
  const l1PerBoundary = Number.isFinite(Number(options.l1PerBoundary)) ? Math.max(1, Math.floor(Number(options.l1PerBoundary))) : 2
  const MAX_CHARS = 160 // L2 三行总结指令需要空间；与直觉卡 100 / 收敛令 120 三档递增
  const cut = (t) => Array.from(String(t || '')).slice(0, MAX_CHARS).join('')
  const L1_TEXT = {
    'surprise-red': () => cut('【行为引导·PSJD-L1·意外红灯】上一拍自述已完成，工具却仍报错——证据链断了：回到报错原文核对，复验通过前禁止宣称修好。'),
    'surprise-green': () => cut('【行为引导·PSJD-L1·意外绿灯】报错后的试探性修改全绿——绿灯可能是巧合不是因果：复跑一次验证命令，确认不是掩蔽性通过。'),
    'stall': (stall2, errStreak2, fileRepeat2) => cut(`【行为引导·PSJD-L1·停滞】停滞度 ${stall2}：报错签名连续 ${errStreak2} 拍未翻转、近4写步同文件 ${fileRepeat2} 次——先复述当前假设，再换下一刀的位置，别在同一处继续磨。`),
  }
  const L2_TEXT = (stall2, errStreak2) => cut(`【强制熔断·PSJD-L2】停滞 ${stall2} 越过停机线（同签名报错 ${errStreak2} 拍）：立即停止重试——输出「已试路径、当前假设、未验项」三行总结，把控制权交还主人；新边界内再继续。`)
  const state = new WeakMap()
  const get = (session) => {
    if (!state.has(session)) {
      state.set(session, { errStreak: 0, lastErr: '', prevError: false, files: [], boundaryKey: '', l1Sent: new Set(), l2Sent: false })
    }
    return state.get(session)
  }

  return {
    /** 边界锚变化时由 engine 调用：干预配额复位；停滞观测状态保留（会话级连续性）。 */
    setBoundary(session, key) {
      const st = get(session)
      const k = String(key || '')
      if (k === st.boundaryKey) return
      st.boundaryKey = k
      st.l1Sent = new Set()
      st.l2Sent = false
    },
    /** 观察一步并给出该步的规则判定（不改变任何既有行为）。 */
    evaluate(session, { call, result, assistantText, flowVerdict } = {}) {
      const st = get(session)
      const signal = extractErrorSignal(result)
      const err = Boolean(signal?.error)
      const core = err ? String(signal.core || '') : ''

      // 报错签名连续未翻转 → 停滞的主证据
      if (err) st.errStreak = (core && core === st.lastErr) ? st.errStreak + 1 : 1
      else st.errStreak = 0
      st.lastErr = core

      // 同文件反复改 → 死磕的次证据（只看近 4 次写入）
      const args = parseArgs(call) || {}
      const p = String(args.path || args.file || args.file_path || args.source || '')
      const name = effectiveToolName(call) || ''
      if (FILE_WRITE.test(name) && p) {
        st.files.push(p.split(/[\\/]/).pop())
        while (st.files.length > 4) st.files.shift()
      }
      const counts = st.files.reduce((m, f) => { m[f] = (m[f] || 0) + 1; return m }, {})
      const fileRepeat = st.files.length ? Math.max(...Object.values(counts)) : 0

      const flagRes = surpriseFlag({ call, result, assistantText, prevError: st.prevError, err })
      st.prevError = err

      const collapsed = flowVerdict?.regime === 'collapsed' ? 1 : 0
      // 噪声或合成：三条证据彼此独立，任一条足够强就能触发。
      // 线性加权下报错项上限只有 0.45，会让「同一报错连撞二十次」也够不到阈值。
      const se = st.errStreak / (st.errStreak + 1)
      const sf = fileRepeat / 4
      const stall = Math.min(1, 1 - (1 - 0.8 * se) * (1 - 0.5 * sf) * (1 - 0.5 * collapsed))

      const shouldFire = flagRes.flag !== 0 || stall >= threshold
      const mode = flagRes.flag === -1 ? 'surprise-red'
        : flagRes.flag === 1 ? 'surprise-green'
          : (stall >= threshold ? 'stall' : 'none')

      // —— 两级熔断转正（WP3）：观测照旧先行；enforce 开启时按 mode 配额出本地合成卡 ——
      let enforce = null
      let enforceSuppressed
      // L2 独立判据：同签名报错连续 haltAfter 拍或 stall 越过停机线即停机，
      // 不等综合分过观察阈值——haltAfter=4 时 stall 仅 0.64，若要求先过 0.66 的
      // shouldFire 门，停机线永远够不着（HarnessPro「连续 deny 即 halt」同语义）。
      const l2Hit = stall >= haltStall || st.errStreak >= haltAfter
      if (enforceLevel !== 'off' && (shouldFire || l2Hit)) {
        if (st.l2Sent) {
          enforceSuppressed = 'l2-sent' // 本边界已熔断过：静默到边界切换（透镜/收敛令通道不受影响）
        } else if (l2Hit && enforceLevel === 'l2') {
          st.l2Sent = true
          enforce = { level: 'l2', mode, text: L2_TEXT(stall, st.errStreak) }
        } else if (shouldFire && !st.l1Sent.has(mode) && st.l1Sent.size < l1PerBoundary) {
          st.l1Sent.add(mode)
          enforce = { level: 'l1', mode, text: L1_TEXT[mode] ? L1_TEXT[mode](stall, st.errStreak, fileRepeat) : '' }
        } else {
          enforceSuppressed = !shouldFire ? 'l2-hit-but-l1' : (st.l1Sent.has(mode) ? 'l1-mode-dedup' : 'l1-quota')
        }
      }

      return {
        flag: flagRes.flag,
        flagReason: flagRes.reason,
        stall: Math.round(stall * 1000) / 1000,
        errStreak: st.errStreak,
        fileRepeat,
        collapsed,
        shouldFire,
        mode,
        enforce,
        ...(enforceSuppressed ? { enforceSuppressed } : {}),
      }
    },
  }
}
