// 脉冲透镜纯函数层测试：分类器 / 报错信号 / 200 字符拼装 / 事件流尾配对。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyToolCall, extractErrorSignal, buildPulseQuery, diffFeatureWords, pickLastToolExchange,
  createPulseGovernor, smellTags, hasSmell, renderPulse, createPulseMessage,
  toolKind, matchGlueWords, boundaryShape, createTrajectoryTracker, pickPulseSource,
  effectiveToolName, strictDiffTags,
} from '../lib/pulse.js'

const textResult = (text, extra = {}) => ({ message: { content: [{ type: 'text', text }], ...extra } })

test('分类器：纯读工具免查', () => {
  for (const name of ['ReadCode', 'Outline', 'FindSymbol', 'Trace', 'lightmemo', 'dailynote_read', 'web_search', 'job_output']) {
    assert.equal(classifyToolCall(name), 'skip', name)
  }
})

test('分类器：写/执行/未知工具可查', () => {
  for (const name of ['EditCode', 'CreateFile', 'pwsh', 'TaskAction', 'dailynote_write', 'SomeBrandNewTool']) {
    assert.equal(classifyToolCall(name), 'pulse', name)
  }
})

test('分类器：空名跳过，extraReadTools 可在配置里扩白名单', () => {
  assert.equal(classifyToolCall(''), 'skip')
  assert.equal(classifyToolCall(undefined), 'skip')
  assert.equal(classifyToolCall('MyCustomRead'), 'pulse')
  assert.equal(classifyToolCall('MyCustomRead', 'Other, MyCustomRead'), 'skip')
})

test('报错信号：宿主 error.info 为权威源', () => {
  const r = extractErrorSignal({
    message: { isError: true, content: [{ type: 'text', text: 'noise' }] },
    error: { info: { name: 'TypeError', message: 'x is not a function' } },
  })
  assert.equal(r.error, true)
  assert.equal(r.core, 'TypeError: x is not a function')
})

test('报错信号：isError 但无 info 时从回执文本抓核心行', () => {
  const r = extractErrorSignal(textResult('[exit code: 1]', { isError: true }))
  assert.equal(r.error, true)
  assert.equal(r.core, '[exit code: 1]')
})

test('报错信号：宿主未标 isError 也能从堆栈行嗅出错误', () => {
  const r = extractErrorSignal(textResult('at foo (a.js:1)\nTypeError: Cannot read properties of undefined (reading x)\n'))
  assert.equal(r.error, true)
  assert.ok(r.core.startsWith('TypeError: Cannot read properties'))
})

test('报错信号：正常回执不误报', () => {
  const r = extractErrorSignal(textResult('All tests passed\n36 passing'))
  assert.equal(r.error, false)
  assert.equal(r.core, '')
})

test('特征词：只取 diff 新增行，忽略删除行', () => {
  const words = diffFeatureWords('-  const removed = 1\n+  if (b) return null\n+  let isRetry = true')
  assert.ok(words.includes('if'))
  assert.ok(words.includes('isRetry'))
  assert.ok(!words.includes('const'), '删除行的 const 不该入选')
})

test('拼装器：报错步=工具名打头+核心错误全额', () => {
  const q = buildPulseQuery(
    { name: 'pwsh', arguments: { command: 'npm test' } },
    { message: { isError: true, content: [{ type: 'text', text: 'boom' }] }, error: { info: { name: 'Error', message: 'exit code 1' } } },
  )
  assert.ok(q.startsWith('pwsh '))
  assert.ok(q.includes('exit code 1'))
  assert.ok(Array.from(q).length <= 200)
})

test('拼装器：写步=参数摘要+diff 特征词', () => {
  const q = buildPulseQuery(
    { name: 'EditCode', arguments: { path: 'lib/a.js', target: 'old' } },
    textResult('Applied.\n+  if (err) return null\n+  let isRetry = true'),
  )
  assert.ok(q.startsWith('EditCode '))
  assert.ok(q.includes('lib/a.js'))
  assert.ok(q.includes('if'))
  assert.ok(q.includes('isRetry'))
})

test('拼装器：超长输入压到 200 字符，空工具名返回空串', () => {
  const long = 'TypeError: ' + 'x'.repeat(500)
  const q = buildPulseQuery({ name: 'pwsh', arguments: {} }, textResult(long, { isError: true }))
  assert.ok(Array.from(q).length <= 200)
  assert.ok(Array.from(q).length > 50)
  assert.equal(buildPulseQuery({}, textResult('ok')), '')
  assert.equal(buildPulseQuery(null, null), '')
})

test('拼装器：无参数无回执也不炸', () => {
  const q = buildPulseQuery({ name: 'pwsh' }, undefined)
  assert.equal(q, 'pwsh')
})

const events = (...list) => list.map((e, i) => ({ seq: i + 1, ...e }))

test('尾配对：取最近一对 call/result', () => {
  const pair = pickLastToolExchange(events(
    { type: 'user/message', data: {} },
    { type: 'tool/call', data: { callId: 'c1', name: 'ReadCode' } },
    { type: 'tool/result', data: { callId: 'c1', message: { content: [] } } },
    { type: 'tool/call', data: { callId: 'c2', name: 'EditCode' } },
    { type: 'tool/result', data: { callId: 'c2', message: { content: [] } } },
  ))
  assert.ok(pair)
  assert.equal(pair.call.name, 'EditCode')
  assert.equal(pair.seq, 5)
})

test('尾配对：尾部无已完结工具交换时返回 null', () => {
  assert.equal(pickLastToolExchange(events({ type: 'tool/call', data: { callId: 'c1' } })), null)
  assert.equal(pickLastToolExchange(events(
    { type: 'tool/call', data: { callId: 'c1' } },
    { type: 'tool/result', data: { callId: 'c1' } },
    { type: 'step/start', data: {} },
  )), null)
  assert.equal(pickLastToolExchange(events({ type: 'user/message', data: {} })), null)
  assert.equal(pickLastToolExchange([]), null)
  assert.equal(pickLastToolExchange(undefined), null)
})

test('拼装器：arguments 为 JSON 串（宿主 tool/call 实际形态）也能取参数摘要', () => {
  const q = buildPulseQuery(
    { name: 'EditCode', arguments: JSON.stringify({ path: 'lib/b.js', replace: '+  if (x) {}' }) },
    textResult('ok'),
  )
  assert.ok(q.includes('lib/b.js'))
  assert.ok(q.startsWith('EditCode '))
  const broken = buildPulseQuery({ name: 'EditCode', arguments: '{not json' }, textResult('ok'))
  assert.ok(broken.startsWith('EditCode '))
})

test('节流器：步冷却 ≥3 合格步，报错免步冷却但受 5s 地板', () => {
  let t = 1_000_000
  const g = createPulseGovernor({ config: { pulseStepGap: 3, pulseFloorMs: 5000, pulseBudgetPerTodo: 9 }, now: () => t })
  g.setBoundary('todo:1')
  assert.equal(g.allowQuery(false), true, '首查必放行')
  g.record('card-a')
  assert.equal(g.allowQuery(false), false, '紧邻下一步：步距不足')
  assert.equal(g.allowQuery(true), false, '报错免步冷却，但 5s 地板未到')
  t += 5000
  assert.equal(g.allowQuery(true), true, '过地板后报错立刻可查')
  assert.equal(g.allowQuery(false), false, '非报错仍要等步距')
  g.tick(); g.tick()
  assert.equal(g.allowQuery(false), false, '2 个合格步还不够')
  g.tick()
  assert.equal(g.allowQuery(false), true, '满 3 个合格步放行')
})

test('节流器：基础配额 3，报错破格 +1 且每边界仅一次', () => {
  const g = createPulseGovernor({ config: { pulseBudgetPerTodo: 3, pulseErrorBonus: 1, pulseStepGap: 1, pulseFloorMs: 0 }, now: () => 0 })
  g.setBoundary('t')
  for (const k of ['a', 'b', 'c']) { g.tick(); assert.equal(g.allowQuery(false), true); g.record(k) }
  assert.equal(g.snapshot().used, 3)
  assert.equal(g.allowQuery(false), false, '基础配额用尽')
  assert.equal(g.allowQuery(true), true, '报错破格仍可查')
  g.tick()
  assert.equal(g.allowInject('d', true), true)
  g.record('d')
  assert.equal(g.snapshot().bonusSpent, true)
  assert.equal(g.allowQuery(true), false, '破格只给一次')
})

test('节流器：长边界内连续空手受空手预算封顶（空手不归还额度）', () => {
  const g = createPulseGovernor({ config: { pulseStepGap: 1, pulseFloorMs: 0, pulseBudgetPerTodo: 9, pulseEmptyPerTodo: 6 }, now: () => 0 })
  g.setBoundary('user:1')
  let allowed = 0
  for (let i = 0; i < 40; i++) { g.tick(); if (g.allowQuery(false)) { allowed++; g.chargeEmpty() } }
  assert.equal(allowed, 6, '同一边界最多 6 次空手查询')
  assert.equal(g.snapshot().empty, 6)
})

test('节流器：同卡每边界一次、全会话 ≤2 次', () => {
  const g = createPulseGovernor({ config: { pulseStepGap: 1, pulseFloorMs: 0, pulseBudgetPerTodo: 9, pulseMaxCardPerSession: 2 }, now: () => 0 })
  g.setBoundary('t1')
  assert.equal(g.allowInject('card-a'), true)
  g.record('card-a')
  assert.equal(g.allowInject('card-a'), false, '本边界内不再给')
  g.setBoundary('t2')
  assert.equal(g.allowInject('card-a'), true, '换边界可再给一次')
  g.record('card-a')
  g.setBoundary('t3')
  assert.equal(g.allowInject('card-a'), false, '全会话 2 次封顶')
})

test('节流器：边界锚变化重置空手预算，同锚重设不重置', () => {
  const g = createPulseGovernor({ config: { pulseStepGap: 1, pulseFloorMs: 0, pulseBudgetPerTodo: 2, pulseEmptyPerTodo: 2, pulseEmptyBonus: 2 }, now: () => 0 })
  g.setBoundary('todo:1')
  g.tick(); assert.equal(g.allowQuery(false), true); g.chargeEmpty()
  g.tick(); assert.equal(g.allowQuery(false), true); g.chargeEmpty()
  assert.equal(g.allowQuery(false), false, '空手预算用尽')
  g.setBoundary('todo:1')
  assert.equal(g.allowQuery(false), false, '同锚不重置')
  g.setBoundary('todo:2')
  assert.equal(g.allowQuery(false), true, '换锚预算恢复')
  assert.equal(g.snapshot().empty, 0, '空手计数随锚重置')
})

test('节流器：报错出现后空手预算 +2（普通 2 → 报错 4）', () => {
  const g = createPulseGovernor({ config: { pulseStepGap: 1, pulseFloorMs: 0, pulseBudgetPerTodo: 9, pulseEmptyPerTodo: 2, pulseEmptyBonus: 2 }, now: () => 0 })
  g.setBoundary('todo:1')
  g.tick(); assert.equal(g.allowQuery(false), true); g.chargeEmpty()
  g.tick(); assert.equal(g.allowQuery(false), true); g.chargeEmpty()
  assert.equal(g.allowQuery(false), false, '普通预算 2 已耗尽')
  g.tick(); assert.equal(g.allowQuery(true), true, '报错查询解锁破格')
  g.chargeEmpty()
  g.tick(); assert.equal(g.allowQuery(false), true, '破格后额度到 4')
  g.chargeEmpty()
  assert.equal(g.allowQuery(false), false, '4 次用尽')
  assert.equal(g.snapshot().sawError, true)
})

test('节流器：budget 与破格双 0 全禁；仅破格时只放报错；快照可读', () => {
  const g = createPulseGovernor({ config: { pulseBudgetPerTodo: 0, pulseErrorBonus: 0 } })
  g.setBoundary('x')
  assert.equal(g.allowQuery(true), false)
  assert.equal(g.allowQuery(false), false)
  const only = createPulseGovernor({ config: { pulseBudgetPerTodo: 0, pulseErrorBonus: 1, pulseFloorMs: 0 }, now: () => 0 })
  only.setBoundary('x')
  assert.equal(only.allowQuery(false), false, '仅报错可查')
  assert.equal(only.allowQuery(true), true)
  const g2 = createPulseGovernor({ config: { pulseBudgetPerTodo: 2 }, now: () => 12345 })
  g2.setBoundary('x')
  assert.equal(g2.allowInject(''), false)
  assert.equal(g2.allowInject(undefined), false)
  g2.record('k')
  assert.deepEqual(g2.snapshot(), { boundaryKey: 'x', used: 1, queried: 0, empty: 0, sawError: false, bonusSpent: false, sinceInject: 0, lastAt: 12345, cards: 1 })
  assert.equal(createPulseGovernor({}).snapshot().lastAt, 0)
})

test('特征门：无坏味道无报错不发查询，有则给出字面标签', () => {
  assert.equal(hasSmell({ name: 'EditCode', arguments: { path: 'a.js' } }, textResult('ok')), false)
  assert.equal(hasSmell({ name: 'EditCode', arguments: { path: 'a.js' } }, textResult('+  if (x) return')), true)
  assert.equal(hasSmell({ name: 'pwsh', arguments: '{"command":"npm test"}' }, textResult('[exit code: 1]')), true)
  const tags = smellTags({ name: 'EditCode', arguments: JSON.stringify({ replace: '+ let isBusy = true' }) }, textResult('done'))
  assert.ok(tags.includes('let'))
  assert.ok(tags.includes('isBusy'))
})

test('特征门：壳命令参数里的代码词不再单独触发，只有 diff/报错才查', () => {
  assert.equal(hasSmell({ name: 'ops_bash', arguments: JSON.stringify({ command: 'node -e "const x=1"' }) }, textResult('ok')), false)
  assert.equal(hasSmell({ name: 'ops_bash', arguments: '{}' }, textResult('Applied.\n+  if (err) return null')), true)
  assert.equal(hasSmell({ name: 'ops_bash', arguments: '{}' }, textResult('boom', { isError: true })), true)
})

test('工具名分派：project_forge 按 command 归一，读命令不触发脉冲', () => {
  assert.equal(effectiveToolName({ name: 'project_forge', arguments: JSON.stringify({ command: 'ReadCode' }) }), 'ReadCode')
  assert.equal(effectiveToolName({ name: 'project_forge', arguments: JSON.stringify({ command: 'EditCode' }) }), 'EditCode')
  assert.equal(effectiveToolName({ name: 'EditCode' }), 'EditCode')
  assert.equal(toolKind(effectiveToolName({ name: 'project_forge', arguments: '{"command":"ReadCode"}' })), 'read')
})

test('拼装器：壳命令只带严格 diff 锚点，不带路径摘要', () => {
  const q = buildPulseQuery(
    { name: 'ops_bash', arguments: JSON.stringify({ command: 'cd C:/Users/user/Desktop/code/work' }) },
    textResult('Applied.\n+  if (err) return null'),
  )
  assert.ok(q.startsWith('ops_bash '), q)
  assert.ok(q.includes('if'))
  assert.ok(!q.includes('Users'), '路径噪音不进查询')
  assert.deepEqual(strictDiffTags(textResult('no diff here')), [])
})

test('拼装器：特征标签前置（工具名后紧跟字面锚，路径退后）', () => {
  const q = buildPulseQuery(
    { name: 'EditCode', arguments: JSON.stringify({ path: 'lib/a.js' }) },
    textResult('+  if (err) return null'),
  )
  assert.ok(q.startsWith('EditCode if '), q)
  assert.ok(q.indexOf('if') < q.indexOf('lib/a.js'), '字面锚必须在参数摘要之前')
})

test('注入渲染：带防压缩引导语、剥类目前缀、按字符封顶', () => {
  const text = renderPulse({ title: '[工程经验]直觉卡·连猜两次不中就加探针', body: '同一问题连改两次没进展时停手。' })
  assert.ok(text.includes('非事实'))
  assert.ok(text.includes('直觉卡·连猜两次不中就加探针'))
  assert.ok(!text.includes('[工程经验]'))
  const long = renderPulse({ title: '直觉卡·x', body: '很长'.repeat(300) })
  assert.ok(Array.from(long).length <= 201, '兜底口径与 DEFAULTS.pulseMaxChars 同为 200（无句读退化硬切 +1 省略号）')
  assert.equal(Array.from(renderPulse({ title: '直觉卡·x', body: '很长'.repeat(300) }, { pulseMaxChars: 60 })).length, 61, '显式配置优先：60 预算硬切 + 1 省略号')
})

test('注入渲染（0.4.13）：剥检索元数据头、句边界截断不斩半句', () => {
  const stripped = renderPulse({ title: '直觉卡·被挡住先分类别再加力', body: '[01:21] [工程经验] 操作被挡住时，第一刀不是重试，而是先枚举阻挡来源。' })
  assert.ok(!stripped.includes('[01:21]') && !stripped.includes('[工程经验]'), '时间戳/分类是检索元数据，注入时剥掉')
  assert.ok(stripped.includes('操作被挡住时'), '正文从实质内容起头')
  const sentence = renderPulse({ title: '直觉卡·x', body: ('短句。').repeat(80) }, { pulseMaxChars: 100 })
  assert.ok(sentence.endsWith('…'), '超预算补省略号提示有下文')
  assert.ok(/[。！？；…]…$/.test(sentence), '断点回退到最后一个完整句读，不斩半句：' + sentence.slice(-8))
  assert.ok(sentence.length <= 101, '总长 ≤ 预算+1')
})

test('注入消息：独立 source.kind（append-only 类型隔离），id 可注入便于断言', () => {
  const msg = createPulseMessage('lens', { cardKey: 'k1', boundaryKey: 'b1' }, 'fixed-id')
  assert.equal(msg.id, 'fixed-id')
  assert.equal(msg.role, 'user')
  assert.equal(msg.source.kind, 'memo-recall-pulse')
  assert.notEqual(msg.source.kind, 'memo-recall', '不得与边界召回同 kind，否则会被 retire 扫到')
  assert.equal(msg.source.card, 'k1')
  assert.equal(msg.content[0].text, 'lens')
  const auto = createPulseMessage('x')
  assert.equal(typeof auto.id, 'string')
  assert.ok(auto.id.length > 8)
})

// ---------------------------------------------------------------------------
// 接线前置层：工具三态 / 意图通道 / 形状调制 / 动作轨迹 / 查询源优先级
// ---------------------------------------------------------------------------

test('工具三态：读=read、执行类=verify、动手=write（未知工具按动手算）', () => {
  for (const n of ['ReadCode', 'FindSymbol', 'lightmemo', 'dailynote_read']) assert.equal(toolKind(n), 'read', n)
  for (const n of ['ops_bash', 'pwsh', 'chrome_bridge', 'execute_script']) assert.equal(toolKind(n), 'verify', n)
  for (const n of ['EditCode', 'CreateFile', 'TaskAction', 'SomeBrandNewTool']) assert.equal(toolKind(n), 'write', n)
  assert.equal(toolKind(''), 'write', '无名工具按动手算：漏查一次比多查一次贵')
  assert.equal(toolKind('MyCustomRead', 'MyCustomRead'), 'read', 'pulseReadTools 扩展生效')
})

test('意图通道：胶水词去重限量，普通自述不误报；形状区分修复与新功能', () => {
  assert.deepEqual(matchGlueWords('先加个兼容层把它兜底一下'), ['兼容层', '兜底'])
  assert.deepEqual(matchGlueWords('兼容层兜底兼容层兜底'), ['兼容层', '兜底'], '去重')
  assert.deepEqual(matchGlueWords('兼容层兜底临时缓存', 2), ['兼容层', '临时缓存'], 'limit 截断按词表顺序（表序即优先级），不是文本出现顺序')
  assert.deepEqual(matchGlueWords('重构状态机并补测试'), [], '普通自述不得误报')
  assert.deepEqual(matchGlueWords(''), [])
  assert.equal(boundaryShape('修复登录报错'), 'fix')
  assert.equal(boundaryShape('新增导出功能'), 'feature')
  assert.equal(boundaryShape('看看这段代码'), 'unknown')
  assert.equal(boundaryShape(''), 'unknown')
})

test('轨迹：记账读写与验证间隔，读步不累计未验证改动', () => {
  const t = createTrajectoryTracker()
  t.setBoundary('b1')
  t.observe({ name: 'EditCode' }, textResult('+ if (x) return null'))
  t.observe({ name: 'EditCode' }, textResult('+ let y = 1'))
  t.observe({ name: 'EditCode' }, textResult('+ if (z) return null'))
  assert.equal(t.snapshot().writes, 3)
  assert.equal(t.snapshot().sinceVerifyWrites, 3)
  assert.equal(t.takePostureSignal('unknown').id, 'no-verify')
  assert.equal(t.takePostureSignal('unknown'), null, '同类信号每边界只给一次')
  t.observe({ name: 'ReadCode' }, textResult('ok'))
  t.observe({ name: 'pwsh' }, textResult('ok'))
  assert.equal(t.snapshot().searches, 1)
  assert.equal(t.snapshot().verifies, 1)
  assert.equal(t.snapshot().sinceVerifyWrites, 0, '检索/执行都清零未验证计数')
})

test('姿态阶梯：某类信号已消费时不闷死后续几类（短路回归）', () => {
  const t = createTrajectoryTracker()
  t.setBoundary('b1')
  t.observe({ name: 'EditCode' }, textResult('[exit code: 1]'))
  t.observe({ name: 'EditCode' }, textResult('+ if (x) return null'))
  assert.equal(t.takePostureSignal('unknown').id, 'after-error')
  assert.equal(t.takePostureSignal('unknown').id, 'blind-first-cut', 'after-error 已消费，不该再挡住后面几类')
  t.observe({ name: 'EditCode' }, textResult('+ a'))
  t.observe({ name: 'EditCode' }, textResult('+ b'))
  assert.equal(t.takePostureSignal('unknown').id, 'no-verify')
  assert.equal(t.takePostureSignal('unknown'), null, '本边界四类都消费完')
})

test('修复型首建文件：先检索过才报，新功能型里同动作不报', () => {
  const t = createTrajectoryTracker()
  t.setBoundary('b2')
  t.observe({ name: 'ReadCode' }, textResult('ok'))
  t.observe({ name: 'CreateFile' }, textResult('written'))
  assert.equal(t.takePostureSignal('fix').id, 'fix-new-file')
  assert.equal(t.takePostureSignal('feature'), null, '新功能型里新建文件是正常动作')
})

test('查询源优先级：报错 > 胶水意图 > 姿态 > 坏味道；无信号不发查询', () => {
  const call = { name: 'EditCode', arguments: JSON.stringify({ replace: '+ if (err) return null' }) }
  const err = pickPulseSource({ call, result: textResult('[exit code: 1]\nTypeError: x is not a function'), assistantText: '先加个兼容层兜底', trajectory: null, boundaryText: '修复登录' })
  assert.equal(err.mode, 'error')
  assert.equal(err.thresholdKey, 'pulseErrorThreshold')
  const intent = pickPulseSource({ call, result: textResult('committed'), assistantText: '我先加个兼容层兜底', trajectory: null, boundaryText: '修复登录' })
  assert.equal(intent.mode, 'intent')
  assert.equal(intent.thresholdKey, 'pulseIntentThreshold')
  assert.ok(intent.query.startsWith('EditCode 兼容层'), intent.query)
  const t = createTrajectoryTracker()
  t.setBoundary('b')
  for (const line of ['+ a', '+ b', '+ c']) t.observe({ name: 'EditCode' }, textResult(line))
  const posture = pickPulseSource({ call, result: textResult('committed'), assistantText: '', trajectory: t, boundaryText: '看看这里' })
  assert.equal(posture.mode, 'posture')
  assert.equal(posture.thresholdKey, 'pulsePostureThreshold')
  const smell = pickPulseSource({ call, result: textResult('+ if (err) return null'), assistantText: '', trajectory: null, boundaryText: '' })
  assert.equal(smell.mode, 'smell')
  assert.equal(smell.thresholdKey, 'pulseThreshold')
  const clean = { name: 'EditCode', arguments: JSON.stringify({ path: 'lib/a.js' }) }
  assert.equal(pickPulseSource({ call: clean, result: textResult('committed'), assistantText: '', trajectory: null, boundaryText: '' }), null, '无坏味道、无报错、无自述时不发查询')
  assert.equal(pickPulseSource({ call: { name: '' }, result: textResult('committed'), assistantText: '兼容层' }), null)
})
