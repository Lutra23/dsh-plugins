import { test } from 'node:test'
import assert from 'node:assert/strict'
import { surpriseFlag, createPsjdShadow } from '../lib/psjd-rules.js'

const ok = { data: { message: { content: [{ type: 'text', text: 'done' }] } } }
const bad = { data: { message: { isError: true, content: [{ type: 'text', text: 'Error: boom' }] } } }
const call = (name, args) => ({ name, arguments: JSON.stringify(args || {}) })
const run = (s, ses, n, c, r, extra = {}) => {
  let v
  for (let i = 0; i < n; i++) v = s.evaluate(ses, { call: c, result: r, assistantText: '', ...extra })
  return v
}

test('意外红灯：自述改好却报错 → -1', () => {
  const v = surpriseFlag({ call: call('ops_bash', {}), result: bad, assistantText: '已经改好了' })
  assert.equal(v.flag, -1)
  assert.equal(v.reason, 'certain_but_failed')
})

test('意外绿灯：上一拍报错、这一拍大幅删改且无错 → +1', () => {
  const c = call('ops_replace', { path: 'a.js', target: 'l1\nl2\nl3\nl4', replace: 'x' })
  const v = surpriseFlag({ call: c, result: ok, assistantText: '', prevError: true })
  assert.equal(v.flag, 1)
  assert.equal(v.reason, 'trial_cut_green')
})

test('意外绿灯：试探词命中 → +1', () => {
  const v = surpriseFlag({ call: call('ops_bash', {}), result: ok, assistantText: '先试试看会怎样', prevError: true })
  assert.equal(v.flag, 1)
  assert.equal(v.reason, 'trial_but_green')
})

test('符合预期 → 0', () => {
  const v = surpriseFlag({ call: call('ops_bash', {}), result: ok, assistantText: '跑一下测试', prevError: false })
  assert.equal(v.flag, 0)
})

test('同一报错连续未翻转：errStreak 累积、stall 抬升', () => {
  const s = createPsjdShadow()
  const v = run(s, {}, 4, call('ops_bash', {}), bad)
  assert.equal(v.errStreak, 4)
  assert.ok(v.stall > 0.5, `stall=${v.stall}`)
})

test('同一报错连撞 5 次即可独立触发（噪声或不能被上限卡死）', () => {
  const s = createPsjdShadow()
  const v = run(s, {}, 5, call('ops_bash', {}), bad)
  assert.equal(v.shouldFire, true)
  assert.equal(v.mode, 'stall')
})

test('报错签名翻转后 errStreak 归零', () => {
  const s = createPsjdShadow()
  const ses = {}
  const bad2 = { data: { message: { isError: true, content: [{ type: 'text', text: 'TypeError: other' }] } } }
  s.evaluate(ses, { call: call('ops_bash', {}), result: bad, assistantText: '' })
  const v = s.evaluate(ses, { call: call('ops_bash', {}), result: bad2, assistantText: '' })
  assert.equal(v.errStreak, 1)
})

test('流熵坍缩计入 stall', () => {
  const s = createPsjdShadow()
  const v = s.evaluate({}, { call: call('ReadCode', { path: 'a.js' }), result: ok, assistantText: '', flowVerdict: { regime: 'collapsed' } })
  assert.equal(v.collapsed, 1)
  assert.ok(v.stall >= 0.4, `stall=${v.stall}`)
})

test('同文件反复改：fileRepeat 达 4 并抬升 stall', () => {
  const s = createPsjdShadow()
  const v = run(s, {}, 4, call('EditCode', { path: 'src/a.js' }), ok)
  assert.equal(v.fileRepeat, 4)
  assert.ok(v.stall >= 0.4, `stall=${v.stall}`)
})

test('project_forge 的 EditCode 也计入文件重复（按 args.command 分派）', () => {
  const s = createPsjdShadow()
  const v = run(s, {}, 3, call('project_forge', { command: 'EditCode', path: 'lib/x.js' }), ok)
  assert.equal(v.fileRepeat, 3)
})

test('shouldFire：意外红灯必触发，平静步不触发', () => {
  const s = createPsjdShadow()
  const a = s.evaluate({}, { call: call('ops_bash', {}), result: bad, assistantText: '搞定了', flowVerdict: { regime: 'healthy' } })
  assert.equal(a.shouldFire, true)
  assert.equal(a.mode, 'surprise-red')
  const b = s.evaluate({}, { call: call('ReadCode', { path: 'a.js' }), result: ok, assistantText: '', flowVerdict: { regime: 'healthy' } })
  assert.equal(b.shouldFire, false)
  assert.equal(b.mode, 'none')
})

// —— 0.4.12 两级熔断转正（WP3 · HarnessPro adapter 熔断移植）——
test('enforce 默认 off：shouldFire 也不出卡（纯 shadow 语义不变）', () => {
  const s = createPsjdShadow()
  const v = s.evaluate({}, { call: call('ops_bash', {}), result: bad, assistantText: '搞定了' })
  assert.equal(v.shouldFire, true)
  assert.equal(v.enforce, null)
  assert.equal(v.enforceSuppressed, undefined)
})

test('L1 意外红灯：enforce=l1 时当拍出行为引导卡', () => {
  const s = createPsjdShadow({ enforce: 'l1' })
  const v = s.evaluate({}, { call: call('ops_bash', {}), result: bad, assistantText: '已经改好了' })
  assert.equal(v.enforce?.level, 'l1')
  assert.equal(v.enforce?.mode, 'surprise-red')
  assert.ok(v.enforce.text.includes('PSJD-L1'))
})

test('L1 同 mode 去重：第二次同 mode 不再发，suppressed 标记可审计', () => {
  const s = createPsjdShadow({ enforce: 'l1' })
  const ses = {}
  const v1 = s.evaluate(ses, { call: call('ops_bash', {}), result: bad, assistantText: '已经改好了' })
  assert.equal(v1.enforce?.mode, 'surprise-red')
  const v2 = s.evaluate(ses, { call: call('ops_bash', {}), result: bad, assistantText: '收工' })
  assert.equal(v2.shouldFire, true)
  assert.equal(v2.enforce, null)
  assert.equal(v2.enforceSuppressed, 'l1-mode-dedup')
})

test('L2 独立判据：同签名报错连续 haltAfter 拍即停机，不等 shouldFire', () => {
  const s = createPsjdShadow({ enforce: 'l2', haltAfter: 4 })
  const ses = {}
  let v
  for (let i = 0; i < 3; i++) v = s.evaluate(ses, { call: call('ops_bash', {}), result: bad, assistantText: '' })
  assert.equal(v.enforce, null, 'errStreak=3：stall=0.6 未过观察阈值且未到停机线，无卡')
  v = s.evaluate(ses, { call: call('ops_bash', {}), result: bad, assistantText: '' })
  assert.equal(v.errStreak, 4)
  assert.equal(v.shouldFire, false, 'stall=0.64：shouldFire 仍为假')
  assert.equal(v.enforce?.level, 'l2', 'l2Hit 独立于 shouldFire：第 4 拍直接停机')
  assert.ok(v.enforce.text.includes('PSJD-L2'))
  const v5 = s.evaluate(ses, { call: call('ops_bash', {}), result: bad, assistantText: '' })
  assert.equal(v5.enforce, null, '本边界已熔断：静默')
  assert.equal(v5.enforceSuppressed, 'l2-sent')
})

test('enforce=l1 时 L2 判据命中：只标记不出停机卡', () => {
  const s = createPsjdShadow({ enforce: 'l1', haltAfter: 4 })
  const ses = {}
  let v
  for (let i = 0; i < 4; i++) v = s.evaluate(ses, { call: call('ops_bash', {}), result: bad, assistantText: '' })
  assert.equal(v.enforce, null, 'shouldFire=false 走不进 L1 分支')
  assert.equal(v.enforceSuppressed, 'l2-hit-but-l1')
})

test('setBoundary 复位：干预配额随边界清零，停滞观测跨边界连续', () => {
  const s = createPsjdShadow({ enforce: 'l2', haltAfter: 4 })
  const ses = {}
  let v
  for (let i = 0; i < 4; i++) v = s.evaluate(ses, { call: call('ops_bash', {}), result: bad, assistantText: '' })
  assert.equal(v.enforce?.level, 'l2')
  s.setBoundary(ses, 'k2') // 用户消息/Todo 切换
  v = s.evaluate(ses, { call: call('ops_bash', {}), result: bad, assistantText: '' })
  assert.equal(v.errStreak, 5, '观测状态跨边界连续')
  assert.equal(v.enforce?.level, 'l2', 'l2Sent 已复位：新边界可再熔断')
})
