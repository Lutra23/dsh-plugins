/**
 * 阶段闸门（HarnessPro Runtime Hooks 移植 · WP2）：把「边界内写步数」分成
 * economy / strict / finalize 三档，用 append-only 收敛令把长程施工从发散拽回收敛。
 *
 * 与直觉卡（透镜）的三点区别：
 *   1) 来源：阶段卡是本地合成的行为指令，不查 LightMemo、不吃透镜配额；
 *   2) 语义：直觉卡是「勿引用」的视角提示，阶段卡是明确的行为治理（止损/收敛/交卷）；
 *   3) 形态：source.form='stage-gate'（engine 组装），与 pulse-lens 类型隔离，append-only 同源。
 *
 * 节奏对齐 HarnessPro hook.py 三段闸门（TB2-medium 14/26/44、周期 8）：
 *   economy  进场单次提醒（止损复读、收敛优先），档内不重申；
 *   strict   进场一次 + 每 everyN 步重申（停止探索、专注验证）；
 *   finalize 进场一次 + 每 everyN 步重申（基于现有证据强制交卷）。
 *
 * 默认关闭（pulseStageEnabled=false）：与 psjdShadow/flowEntropyShadow 同款家风，
 * 显式开启才注入；关闭时 step() 恒 null，零行为变化。
 * 状态为 engine 级单例（与 createPulseGovernor 同语义），非 per-session。
 */
export function createStageGate({ config = {} } = {}) {
  const enabled = config.pulseStageEnabled === true
  // NaN 防御：Math.floor(Number('x'))=NaN，而 Math.max(1,NaN)=NaN 会令阈值比较永假（闸门静默）。
  // 非法/缺失回退默认值；有限数值再走钳制。与 governor 的宽松解析不同，闸门失聪比闸门缺席更危险。
  const int = (value, fallback) => {
    const n = Math.floor(Number(value))
    return Number.isFinite(n) ? n : fallback
  }
  const economyAt = Math.max(1, int(config.pulseStageEconomyAt, 14))
  const strictAt = Math.max(economyAt + 1, int(config.pulseStageStrictAt, 26))
  const finalizeAt = Math.max(strictAt + 1, int(config.pulseStageFinalizeAt, 44))
  const everyN = Math.max(1, int(config.pulseStageEveryN, 8))
  const maxChars = Math.max(60, int(config.pulseStageMaxChars, 120))

  const cut = (text) => Array.from(String(text || '')).slice(0, maxChars).join('')
  const ENTER = {
    economy: (s) => `【收敛令·economy】本边界已用 ${s} 个写步越过经济线：停止铺开新面，收敛优先，收束当前切口。`,
    strict: (s) => `【收敛令·strict】已 ${s} 步仍在施工：停止探索新方案，专注验证——跑测试/命令核对已改内容，不开新切口。`,
    finalize: (s) => `【收敛令·finalize】已 ${s} 步触及交卷线：立即停止新操作，基于现有证据总结现状、未验项与余险，交还控制权。`,
  }
  const REMIND = {
    strict: (s, n) => `【收敛令·strict·重申${n}】第 ${s} 步：把当前切口的验证收完，准备收卷。`,
    finalize: (s, n) => `【收敛令·finalize·重申${n}】第 ${s} 步：不要再动工具，输出总结与余险清单。`,
  }

  let boundaryKey = ''
  let steps = 0
  let stage = 'normal'
  let remindNo = 0
  let lastRemindStep = 0
  let stashed = null

  return {
    /** 边界锚变化（用户消息/Todo 切换）时由 engine 调用：阶段计数与顺延卡归零。 */
    setBoundary(key) {
      const k = String(key || '')
      if (k === boundaryKey) return
      boundaryKey = k
      steps = 0
      stage = 'normal'
      remindNo = 0
      lastRemindStep = 0
      stashed = null
    },
    /**
     * 每个合格写步推进一次，返回该拍应注入的收敛令（或 null）。
     * @returns {null|{stage:'economy'|'strict'|'finalize', kind:'enter'|'remind', steps:number, remindNo:number, text:string}}
     */
    step() {
      if (!enabled) return null
      if (stashed) { const v = stashed; stashed = null; return v } // 让位顺延：本拍只吐卡不计数
      steps += 1
      const prev = stage
      stage = steps >= finalizeAt ? 'finalize' : steps >= strictAt ? 'strict' : steps >= economyAt ? 'economy' : 'normal'
      if (stage === 'normal') return null
      if (stage !== prev) {
        remindNo = 0
        lastRemindStep = steps
        return { stage, kind: 'enter', steps, remindNo: 0, text: cut(ENTER[stage](steps)) }
      }
      if (stage === 'economy') return null // 单次止损，档内不重申
      if (steps - lastRemindStep >= everyN) {
        remindNo += 1
        lastRemindStep = steps
        return { stage, kind: 'remind', steps, remindNo, text: cut(REMIND[stage](steps, remindNo)) }
      }
      return null
    },
    /** 收敛令与已落定的在途透镜撞拍时让位：卡回槽，下一拍 step() 优先吐出。 */
    stash(verdict) { stashed = verdict || null },
    /** 只读快照（调试与测试用）。 */
    snapshot() { return { boundaryKey, steps, stage, remindNo, pending: Boolean(stashed) } },
  }
}
