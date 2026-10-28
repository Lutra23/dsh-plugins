/**
 * 本地动作流熵（Step 3）：把「最近 N 步在哪些文件/工具之间转移」看成一张有向边流，
 * 用 RiverMemo V3 的流熵公式判「单边死磕」还是「东一榔头西一棒槌」。
 *
 * 设计约束：
 * 1. 纯本地、零网络、零 IO —— 只消费 engine 已经拿到手的 tool/call 事件。
 * 2. 默认只做 shadow（只记日志不注入），阈值必须用真实分布标定后再启用。
 * 3. 节点键做归一：路径只留 basename（可开关），shell 命令用指纹，避免节点爆炸。
 */

import { effectiveToolName, parseArgs } from './pulse.js'

const EDGE_SEP = '\u0000'

/** FNV-1a 32 位：给 shell 命令做稳定短指纹（同一命令跨会话同键）。 */
function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 动作节点键：文件优先（basename 归一），其次 shell 命令指纹，最后工具名。 */
export function flowNodeKey(call, options = {}) {
  const args = parseArgs(call) ?? {}
  const rawPath = args.path || args.file || args.file_path || args.source || ''
  if (rawPath) {
    const full = String(rawPath)
    const name = options.useFullPath ? full : full.split(/[\/]/).pop()
    return 'file:' + name
  }
  const name = effectiveToolName(call) || 'unknown'
  if (/^(ops_bash|pwsh)$/i.test(name)) {
    const command = String(args.command || args.script_path || '').replace(/\s+/g, ' ').trim()
    return command ? 'bash:' + fnv1a(command).slice(0, 8) : 'bash:empty'
  }
  return name
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1)
}

function debump(map, key) {
  const count = map.get(key) || 0
  if (count <= 1) map.delete(key)
  else map.set(key, count - 1)
}

function newState() {
  return { window: [], edges: new Map(), steps: 0 }
}

export function createFlowEntropyTracker(options = {}) {
  const windowSize = Math.max(4, Number(options.windowSize) || 12)
  const minSteps = Math.max(3, Number(options.minSteps) || 6)
  const useFullPath = options.useFullPath === true
  const thresholds = {
    collapsedEntropy: Number(options.collapsedEntropy ?? 0.35),
    collapsedSelfLoop: Number(options.collapsedSelfLoop ?? 0.5),
    scatteredEntropy: Number(options.scatteredEntropy ?? 0.85),
    scatteredRevisit: Number(options.scatteredRevisit ?? 0.15),
    scatteredMinSteps: Math.max(minSteps, Number(options.scatteredMinSteps) || 8)
  }
  // 会话键可能是对象（真实 session）或字符串（测试/回放），分开存以免泄漏。
  const objectStates = new WeakMap()
  const plainStates = new Map()
  const isObjectKey = key => key !== null && (typeof key === 'object' || typeof key === 'function')
  const stateOf = key => {
    const store = isObjectKey(key) ? objectStates : plainStates
    if (!store.has(key)) store.set(key, newState())
    return store.get(key)
  }

  return {
    windowSize,
    minSteps,
    observe(key, call) {
      const state = stateOf(key)
      const node = flowNodeKey(call, { useFullPath })
      state.window.push(node)
      if (state.window.length >= 2) {
        bump(state.edges, state.window[state.window.length - 2] + EDGE_SEP + node)
      }
      while (state.window.length > windowSize) {
        debump(state.edges, state.window[0] + EDGE_SEP + state.window[1])
        state.window.shift()
      }
      state.steps += 1
      return node
    },
    snapshot(key) {
      const state = stateOf(key)
      const window = state.window.slice()
      const edgeCounts = Array.from(state.edges.entries()).map(([edge, count]) => ({
        edge: edge.split(EDGE_SEP).join('→'),
        count
      }))
      const total = edgeCounts.reduce((sum, item) => sum + item.count, 0)
      const unique = edgeCounts.length
      let entropy = 0
      if (unique > 1 && total > 0) {
        for (const item of edgeCounts) {
          const p = item.count / total
          entropy -= p * Math.log(p)
        }
        entropy /= Math.log(unique)
      }
      let selfLoops = 0
      for (let i = 1; i < window.length; i++) if (window[i] === window[i - 1]) selfLoops += 1
      const visited = new Set()
      let revisits = 0
      for (const node of window) {
        if (visited.has(node)) revisits += 1
        visited.add(node)
      }
      return {
        steps: state.steps,
        windowSize: window.length,
        window,
        edgeCounts,
        omega: Number(entropy.toFixed(4)),
        selfLoopRatio: window.length > 1 ? Number((selfLoops / (window.length - 1)).toFixed(4)) : 0,
        revisitRatio: window.length ? Number((revisits / window.length).toFixed(4)) : 0
      }
    },
    /** 工况判据：collapsed=单边死磕，scattered=乱撞无收敛，healthy=正常推进。 */
    verdict(key) {
      const snap = this.snapshot(key)
      if (snap.windowSize < minSteps) {
        return { ...snap, regime: 'healthy', reason: 'insufficient_steps', actionable: false }
      }
      if (snap.omega < thresholds.collapsedEntropy && snap.selfLoopRatio > thresholds.collapsedSelfLoop) {
        return { ...snap, regime: 'collapsed', reason: 'single_edge_deadlock', actionable: true }
      }
      if (snap.omega > thresholds.scatteredEntropy
        && snap.revisitRatio < thresholds.scatteredRevisit
        && snap.windowSize >= thresholds.scatteredMinSteps) {
        return { ...snap, regime: 'scattered', reason: 'random_walk_no_convergence', actionable: true }
      }
      return { ...snap, regime: 'healthy', reason: 'normal_progress', actionable: false }
    },
    reset(key) {
      const store = isObjectKey(key) ? objectStates : plainStates
      store.delete(key)
    }
  }
}
