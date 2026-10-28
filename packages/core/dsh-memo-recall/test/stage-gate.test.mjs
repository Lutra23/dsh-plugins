import test from 'node:test'
import assert from 'node:assert/strict'
import { createStageGate } from '../lib/stage-gate.js'

/** 低阈值配置：economy@2 / strict@4 / finalize@8 / everyN@2，压缩真实节奏便于断言。 */
const CFG = { pulseStageEnabled: true, pulseStageEconomyAt: 2, pulseStageStrictAt: 4, pulseStageFinalizeAt: 8, pulseStageEveryN: 2 }

test('默认关闭：step 恒 null，写步零副作用', () => {
  const gate = createStageGate({ config: { ...CFG, pulseStageEnabled: false } })
  gate.setBoundary('k1')
  for (let i = 0; i < 30; i++) assert.equal(gate.step(), null, `第 ${i + 1} 步不得产卡`)
  assert.equal(gate.snapshot().steps, 0, '关闭时不计数')
})

test('三档节奏：economy 进场单次，strict 进场+每 everyN 步重申，finalize 接管', () => {
  const gate = createStageGate({ config: CFG })
  gate.setBoundary('k1')
  assert.equal(gate.step(), null, '步1 未到经济线')
  const eco = gate.step()
  assert.equal(eco?.stage, 'economy')
  assert.equal(eco?.kind, 'enter')
  assert.equal(eco?.steps, 2)
  assert.equal(gate.step(), null, '步3 economy 档内不重申')
  const strict = gate.step()
  assert.equal(strict?.stage, 'strict')
  assert.equal(strict?.kind, 'enter')
  assert.equal(strict?.steps, 4)
  assert.equal(gate.step(), null, '步5 距上次提醒 1 步，未到周期')
  const remind = gate.step()
  assert.equal(remind?.stage, 'strict')
  assert.equal(remind?.kind, 'remind')
  assert.equal(remind?.remindNo, 1)
  assert.equal(gate.step(), null, '步7 未到周期')
  const fin = gate.step()
  assert.equal(fin?.stage, 'finalize')
  assert.equal(fin?.kind, 'enter')
  assert.equal(fin?.steps, 8)
  const finRemind = (() => { gate.step(); return gate.step() })()
  assert.equal(finRemind?.stage, 'finalize')
  assert.equal(finRemind?.kind, 'remind')
  assert.equal(finRemind?.remindNo, 1)
})

test('stash 让位：顺延拍直接吐卡且不重复计数', () => {
  const gate = createStageGate({ config: { ...CFG, pulseStageEconomyAt: 1 } })
  gate.setBoundary('k1')
  const card = gate.step() // 步1 即 economy enter
  assert.equal(card?.stage, 'economy')
  gate.stash(card) // 引擎侧 carried 撞拍让位
  const again = gate.step() // 顺延拍：吐卡不计数
  assert.deepEqual(again, card, '顺延卡逐字段一致')
  gate.step() // 步2：normal？不——economyAt=1，步2 已在 economy 档内，不重申
  const snap = gate.snapshot()
  assert.equal(snap.steps, 2, '顺延拍不推进计数，之后恢复推进')
  assert.equal(snap.stage, 'economy')
})

test('setBoundary 重置：新边界计数归零、顺延卡清空', () => {
  const gate = createStageGate({ config: { ...CFG, pulseStageEconomyAt: 1, pulseStageStrictAt: 2, pulseStageFinalizeAt: 9, pulseStageEveryN: 2 } })
  gate.setBoundary('k1')
  assert.equal(gate.step()?.stage, 'economy', 'k1 步1 economy enter')
  const strict = gate.step()
  assert.equal(strict?.stage, 'strict', 'k1 步2 strict enter')
  assert.equal(gate.step(), null, 'k1 步3 strict 档内未到周期')
  assert.equal(gate.snapshot().steps, 3)
  gate.stash(strict) // 模拟 carried 撞拍让位
  gate.setBoundary('k2') // 用户消息/Todo 切换
  assert.equal(gate.snapshot().steps, 0, '切换即归零')
  const eco = gate.step()
  assert.equal(eco?.stage, 'economy', 'stash 已清：吐新边界 economy 而非顺延旧 strict 卡')
  assert.equal(eco?.steps, 1, '新边界从步 1 重新计数')
  assert.equal(gate.snapshot().boundaryKey, 'k2')
})

test('配置倒挂钳制：strictAt/finalizeAt 不低于前一档+1', () => {
  const gate = createStageGate({ config: { pulseStageEnabled: true, pulseStageEconomyAt: 5, pulseStageStrictAt: 3, pulseStageFinalizeAt: 1, pulseStageEveryN: 1 } })
  gate.setBoundary('k1')
  for (let i = 0; i < 4; i++) assert.equal(gate.step(), null, '步 1-4 均未到钳制后的经济线 5')
  assert.equal(gate.step()?.stage, 'economy', '步 5 economy（strictAt 已钳到 6）')
  assert.equal(gate.step()?.stage, 'strict', '步 6 strict（finalizeAt 已钳到 7）')
  assert.equal(gate.step()?.stage, 'finalize', '步 7 finalize')
})

test('非法阈值：NaN 回退默认，负数/0 钳下界', () => {
  const gate = createStageGate({ config: { pulseStageEnabled: true, pulseStageEconomyAt: 'x', pulseStageStrictAt: -5, pulseStageFinalizeAt: NaN, pulseStageEveryN: 0 } })
  gate.setBoundary('k1')
  for (let i = 0; i < 13; i++) assert.equal(gate.step(), null, `步 ${i + 1} 未到默认经济线 14`)
  assert.equal(gate.step()?.stage, 'economy', "economyAt='x' 回退默认 14")
  assert.equal(gate.step()?.stage, 'strict', 'strictAt=-5 钳到 economyAt+1=15')
  // finalizeAt=NaN 回退 44：步 16-43 都在 strict 档内按 everyN=1 每步重申，此处不再逐一走满
  assert.equal(gate.step()?.stage, 'strict', 'everyN 钳 1：strict 档内每步重申')
})

test('文案含档名与步数，受 pulseStageMaxChars 截断与下界保护', () => {
  const gate = createStageGate({ config: { ...CFG, pulseStageMaxChars: 20 } })
  gate.setBoundary('k1')
  gate.step()
  const eco = gate.step()
  assert.ok(eco.text.includes('economy'), '文案携带档名')
  const len = Array.from(eco.text).length
  assert.ok(len > 20 && len <= 60, `maxChars=20 被下界钳到 60（实际 ${len}），防止截成废话`)
})
