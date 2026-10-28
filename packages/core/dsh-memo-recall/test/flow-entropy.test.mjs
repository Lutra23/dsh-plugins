import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFlowEntropyTracker, flowNodeKey } from '../lib/flow-entropy.js'

const fileCall = p => ({ name: 'EditCode', arguments: { path: p } })
const bashCall = c => ({ name: 'ops_bash', arguments: { command: c } })

test('步数不足 → healthy(insufficient_steps)，不误报', () => {
  const t = createFlowEntropyTracker({ windowSize: 12, minSteps: 6 })
  for (let i = 0; i < 3; i++) t.observe('s', fileCall('a.js'))
  const v = t.verdict('s')
  assert.equal(v.regime, 'healthy')
  assert.equal(v.reason, 'insufficient_steps')
  assert.equal(v.actionable, false)
})

test('同一文件连续 10 步 → collapsed(单边死磕)', () => {
  const t = createFlowEntropyTracker({ minSteps: 6 })
  for (let i = 0; i < 10; i++) t.observe('s', fileCall('a.js'))
  const v = t.verdict('s')
  assert.equal(v.regime, 'collapsed')
  assert.equal(v.omega, 0)
  assert.ok(v.selfLoopRatio > 0.8)
})

test('多文件轮转有回访 → healthy', () => {
  const t = createFlowEntropyTracker({ minSteps: 6 })
  const files = ['a.js', 'b.js', 'c.js']
  for (let i = 0; i < 12; i++) t.observe('s', fileCall(files[i % 3]))
  const v = t.verdict('s')
  assert.equal(v.regime, 'healthy')
  assert.ok(v.omega > 0)
  assert.ok(v.revisitRatio > 0.15)
})

test('一路新文件、零回访 → scattered', () => {
  const t = createFlowEntropyTracker({ minSteps: 6 })
  for (let i = 0; i < 12; i++) t.observe('s', fileCall(`f${i}.js`))
  const v = t.verdict('s')
  assert.equal(v.regime, 'scattered')
  assert.equal(v.revisitRatio, 0)
  assert.ok(v.omega > 0.85)
})

test('路径只留 basename：不同目录同名文件算同一节点', () => {
  assert.equal(flowNodeKey(fileCall('src/a.js')), flowNodeKey(fileCall('test/a.js')))
  assert.notEqual(flowNodeKey(fileCall('src/a.js')), flowNodeKey(fileCall('src/b.js')))
  assert.equal(flowNodeKey(fileCall('src/a.js'), { useFullPath: true }), 'file:src/a.js')
})

test('shell 命令用指纹：同命令同键、不同命令不同键', () => {
  const a = flowNodeKey(bashCall('node --test'))
  const b = flowNodeKey(bashCall('node --test'))
  const c = flowNodeKey(bashCall('npm run build'))
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^bash:[0-9a-f]{8}$/)
})

test('窗口滑出后边计数与窗口长度同步（无幽灵边）', () => {
  const t = createFlowEntropyTracker({ windowSize: 4, minSteps: 3 })
  for (let i = 0; i < 10; i++) t.observe('s', fileCall(`f${i}.js`))
  const snap = t.snapshot('s')
  assert.equal(snap.windowSize, 4)
  const totalEdges = snap.edgeCounts.reduce((sum, e) => sum + e.count, 0)
  assert.equal(totalEdges, 3, '窗口 4 个节点最多 3 条边')
  assert.equal(snap.edgeCounts.length, 3)
})

test('对象会话键与字符串键互不干扰', () => {
  const t = createFlowEntropyTracker({ minSteps: 3 })
  const obj = {}
  for (let i = 0; i < 5; i++) t.observe(obj, fileCall('a.js'))
  for (let i = 0; i < 5; i++) t.observe('obj', fileCall('b.js'))
  assert.equal(t.verdict(obj).regime, 'collapsed')
  assert.equal(t.verdict('obj').regime, 'collapsed')
  t.reset(obj)
  assert.equal(t.verdict(obj).reason, 'insufficient_steps')
})

// —— 真实事件形状回归（宿主 tool/call 的 arguments 是 JSON 串）——
const jsonCall = (name, args) => ({ callId: 'c', name, arguments: JSON.stringify(args) })

test('JSON 串 arguments：不同 shell 命令必须不同节点', () => {
  assert.notEqual(
    flowNodeKey(jsonCall('ops_bash', { command: 'echo a' })),
    flowNodeKey(jsonCall('ops_bash', { command: 'echo b' }))
  )
  assert.equal(flowNodeKey(jsonCall('ops_bash', {})), 'bash:empty')
})

test('JSON 串 arguments：带 path 的工具按文件归键', () => {
  assert.equal(flowNodeKey(jsonCall('EditCode', { path: 'src/a.js' })), 'file:a.js')
  assert.equal(flowNodeKey(jsonCall('EditCode', { path: 'test/a.js' })), 'file:a.js')
  assert.equal(flowNodeKey(jsonCall('EditCode', { path: 'src/b.js' })), 'file:b.js')
})

test('JSON 串 arguments：project_forge 按 command 分派节点', () => {
  assert.equal(flowNodeKey(jsonCall('project_forge', { command: 'EditCode', path: 'a.js' })), 'file:a.js')
  assert.notEqual(
    flowNodeKey(jsonCall('project_forge', { command: 'ReadCode' })),
    flowNodeKey(jsonCall('project_forge', { command: 'Grep' }))
  )
})

test('JSON 串 arguments：多命令轮转不塌成 collapsed', () => {
  const t = createFlowEntropyTracker({ windowSize: 8, minSteps: 4 })
  const cmds = ['echo a', 'echo b', 'echo c', 'echo d', 'echo e', 'echo f', 'echo g', 'echo h']
  for (const c of cmds) t.observe('s', jsonCall('ops_bash', { command: c }))
  const v = t.verdict('s')
  assert.equal(v.selfLoopRatio, 0)
  assert.ok(v.omega > 0.85, `omega=${v.omega} 应接近 1`)
  assert.equal(v.regime, 'scattered')
})
