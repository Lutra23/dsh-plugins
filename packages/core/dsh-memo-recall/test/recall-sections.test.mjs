import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULTS, parseLightmemo, selectHits, renderRecallSection } from '../lib/index.js'

// Synthetic LightMemo envelopes only; no personal notes or network requests.
const envelope = (body, { score = '90%(混合)', file = 'demo.txt', folder = '测试', assoc = null } = {}) =>
  `--- (来源: ${folder}, 相关性: ${score})\n    [路径: file:///测试/${file}]\n` +
  (assoc ? `    [🌟 联想共现: ${assoc.coCount}/${assoc.seedTotal} 个种子共同命中]\n` : '') +
  body + '\n'
const wrap = (...hits) => '[--- LightMemo 轻量回忆 ---]\n' + hits.join('\n') + '[--- 回忆结束 ---]\n'

// 选席与渲染用替身，字段形状与 parseLightmemo 的产物一致。
const hit = (title, body, score, extra = {}) =>
  ({ folder: 'DSH工程档案', score, date: '', title, body, path: '', bodyStarted: true, associate: null, lens: false, ...extra })
const mainHit = (n, score) => hit('主检索' + n, '主' + n, score)
const assocHit = (n, score, co) => hit('联想' + n, '联' + n, score, { associate: { coCount: co, seedTotal: 10 } })
const lensHit = (n, score) => hit('直觉卡·' + n, '透镜' + n, score, { folder: '溟月的知识', lens: true })
const bodies = (sel) => sel.map(h => h.body)

// ── 解析层：来源与透镜身份 ────────────────────────────────────────────────

test('联想共现标记剥离为结构化来源，且不残留正文', () => {
  const h = parseLightmemo(wrap(envelope('正文一\n正文二', { assoc: { coCount: 3, seedTotal: 10 } })))[0]
  assert.deepEqual(h.associate, { coCount: 3, seedTotal: 10 })
  assert.equal(h.body, '正文一\n正文二')
  assert.ok(!h.body.includes('联想共现'))
})

test('来源标记不绑定装饰：无 emoji 前缀同样识别', () => {
  const raw = wrap('--- (来源: 测试, 相关性: 88%(混合))\n    [路径: file:///测试/a.txt]\n    [联想共现: 2/10 个种子共同命中]\n正文\n')
  assert.deepEqual(parseLightmemo(raw)[0].associate, { coCount: 2, seedTotal: 10 })
})

test('正文中途的同名文字保留原文，不当作来源标记', () => {
  const h = parseLightmemo(wrap(envelope('前言\n联想共现: 2/10 只是正文\n后记')))[0]
  assert.equal(h.associate, null)
  assert.match(h.body, /联想共现: 2\/10 只是正文/)
})

test('标题含「直觉卡」即透镜身份，来源库不限', () => {
  const lens = parseLightmemo(wrap(envelope('两句话透镜正文。', { file: '2026-10-12-23_33_03-[工程经验]直觉卡·摘要定位声明.txt' })))[0]
  assert.equal(lens.lens, true)
  assert.equal(lens.title, '[工程经验]直觉卡·摘要定位声明')
  const plain = parseLightmemo(wrap(envelope('普通日记正文。', { file: '2026-10-12-10_00_00-[开发节点]普通日记.txt' })))[0]
  assert.equal(plain.lens, false)
  const foreign = parseLightmemo(wrap(envelope('他库透镜。', { folder: 'Kerr的知识', file: '直觉卡·跨库.txt' })))[0]
  assert.equal(foreign.lens, true)
})

// ── 选席层：三分区席位分配 ───────────────────────────────────────────────

test('无联想无透镜时与旧版行为一致', () => {
  const hits = [mainHit(1, 90), mainHit(2, 85), mainHit(3, 80), mainHit(4, 70)]
  assert.deepEqual(bodies(selectHits(hits, 58, 3, 0.4, 2)), ['主1', '主2', '主3'])
  assert.deepEqual(bodies(selectHits(hits, 58, 9, 0.4, 2)), ['主1', '主2', '主3', '主4'])
})

test('联想最多占 round(topN × ratio) 席，主检索保底', () => {
  const hits = [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => mainHit(i, 95 - i)),
    ...[1, 2, 3, 4, 5].map(i => assocHit(i, 90 - i, 6 - i)),
  ]
  const sel = selectHits(hits, 58, 5, 0.4, 0)
  assert.equal(sel.length, 5)
  assert.equal(sel.filter(h => !h.associate && !h.lens).length, 3)
  assert.equal(sel.filter(h => h.associate && !h.lens).length, 2)
})

test('主检索不足时联想补位到 topN', () => {
  const sel = selectHits([mainHit(1, 90), ...[1, 2, 3, 4, 5].map(i => assocHit(i, 88 - i, 3))], 58, 5, 0.4, 0)
  assert.equal(sel.length, 5)
  assert.equal(sel.filter(h => h.associate).length, 4)
  assert.equal(sel.filter(h => !h.associate && !h.lens).length, 1)
})

test('联想区内按共现次数降序，同次数按分数降序', () => {
  const sel = selectHits([assocHit(1, 99, 2), assocHit(2, 60, 4), assocHit(3, 80, 3), assocHit(4, 70, 4)], 58, 4, 1, 0)
  assert.deepEqual(bodies(sel), ['联4', '联2', '联3', '联1'])
})

test('透镜按分数取前 lensMax 枚追加在末尾，不占 topN 席位', () => {
  const hits = [mainHit(1, 90), mainHit(2, 85), mainHit(3, 70), lensHit(1, 80), lensHit(2, 60), lensHit(3, 95)]
  const sel = selectHits(hits, 58, 3, 0.4, 2)
  assert.equal(sel.length, 5)
  assert.deepEqual(bodies(sel.slice(0, 3)), ['主1', '主2', '主3'])
  assert.deepEqual(bodies(sel.slice(3)), ['透镜3', '透镜1'])
})

test('主检索充满 topN 时透镜仍全额追加', () => {
  const sel = selectHits([...[1, 2, 3, 4, 5, 6].map(i => mainHit(i, 95 - i)), lensHit(1, 70)], 58, 3, 0.4, 2)
  assert.deepEqual(bodies(sel), ['主1', '主2', '主3', '透镜1'])
})

test('lensMax 缺省与非法值回退 2，显式 0 不追加', () => {
  const hits = [mainHit(1, 90), lensHit(1, 80), lensHit(2, 70), lensHit(3, 60)]
  assert.equal(selectHits(hits, 58, 3, 0.4).filter(h => h.lens).length, 2)
  assert.equal(selectHits(hits, 58, 3, 0.4, 'x').filter(h => h.lens).length, 2)
  assert.equal(selectHits(hits, 58, 3, 0.4, 0).filter(h => h.lens).length, 0)
})

test('associateRatio 越界按 0~1 clamp，非法值回退 0.4，联想至少 1 席', () => {
  const hits = [
    ...[1, 2, 3, 4, 5, 6, 7, 8].map(i => mainHit(i, 95 - i)),
    ...[1, 2, 3, 4, 5].map(i => assocHit(i, 90 - i, 3)),
  ]
  const picks = (ratio) => selectHits(hits, 58, 5, ratio, 0).filter(h => h.associate).length
  assert.equal(picks(2), 5)
  assert.equal(picks(-1), 1)
  assert.equal(picks(null), 1)
  assert.equal(picks('x'), 2)
})

test('同时带联想标记与透镜身份的命中归透镜区，不吃联想配额', () => {
  const dual = { ...assocHit(1, 70, 5), title: '直觉卡·双重身份', lens: true }
  const sel = selectHits([mainHit(1, 90), dual, assocHit(2, 65, 3)], 58, 3, 0.4, 2)
  assert.equal(sel.filter(h => h.lens).length, 1)
  assert.equal(sel.filter(h => h.associate && !h.lens).length, 1)
})

test('阈值过滤与空正文对三类命中一视同仁', () => {
  const sel = selectHits([mainHit(1, 90), mainHit(2, 57), assocHit(1, 57, 9), lensHit(1, 57), lensHit(2, 60)], 58, 5, 0.4, 2)
  assert.deepEqual(bodies(sel), ['主1', '透镜2'])
  const empty = selectHits([
    mainHit(1, 90), { ...mainHit(2, 95), body: '   ' }, { ...assocHit(1, 90, 5), body: '' }, { ...lensHit(1, 95), body: '' },
  ], 58, 3, 0.4, 2)
  assert.deepEqual(bodies(empty), ['主1'])
})

// ── 渲染层：分区与截断 ───────────────────────────────────────────────────

test('联想单独成段：段标题、meta 共现数、正文位于段标题之后', () => {
  const out = renderRecallSection([mainHit(1, 88.3), assocHit(1, 95.9, 3)], DEFAULTS)
  assert.match(out, /^\[被动记忆召回\]/)
  assert.match(out, /【联想共现记忆 \(1条, 多条记忆交叉关联\)】/)
  assert.match(out, /\|联想3\/10\]/)
  assert.ok(out.indexOf('主1') < out.indexOf('【联想共现记忆'))
  assert.ok(out.indexOf('联1') > out.indexOf('【联想共现记忆'))
})

test('透镜单独成段：段标题、引导语与 meta 透镜标记', () => {
  const out = renderRecallSection([mainHit(1, 88), lensHit(1, 75.5)], DEFAULTS)
  assert.match(out, /【元思考直觉 \(1枚, 注意力扳手而非事实\)】/)
  assert.match(out, /以下透镜只矫正「往哪看」，不陈述「那里有什么」/)
  assert.match(out, /\|透镜\]/)
  assert.ok(out.indexOf('主1') < out.indexOf('【元思考直觉'))
})

test('无联想无透镜时不产生任何分区头', () => {
  const out = renderRecallSection([mainHit(1, 88), mainHit(2, 80)], DEFAULTS)
  assert.ok(!out.includes('【联想共现记忆'))
  assert.ok(!out.includes('元思考直觉'))
})

test('透镜段豁免 maxChars 总截断：主段被切，透镜段完整存活', () => {
  const sel = [...Array(6)].map((_, i) => mainHit(i + 1, 90 - i)).concat(lensHit(1, 60))
  const out = renderRecallSection(sel, { ...DEFAULTS, maxChars: 150 })
  assert.ok(!out.includes('主检索6'))
  assert.ok(out.includes('【元思考直觉'))
  assert.ok(out.includes('透镜1'))
  assert.ok(out.length > 150)
})

test('透镜段自身仍以 maxChars 封顶，不是无限豁免', () => {
  const out = renderRecallSection([lensHit(1, 80)], { ...DEFAULTS, maxChars: 40 })
  assert.ok(out.includes('【元思考直觉'))
  assert.ok(!out.includes('透镜1'))
})

test('{{ 插值会被消毒', () => {
  const out = renderRecallSection([{ ...mainHit(1, 90), body: '模板 {{var}} 示例' }], DEFAULTS)
  assert.ok(!out.includes('{{'))
  assert.match(out, /\{ \{var\}\}/)
})

test('空选择与全空正文渲染为空串', () => {
  assert.equal(renderRecallSection([], DEFAULTS), '')
  assert.equal(renderRecallSection([{ ...mainHit(1, 90), body: '' }], DEFAULTS), '')
})

test('单条正文压平换行并受 maxHitChars 限制', () => {
  const out = renderRecallSection([{ ...mainHit(1, 90), body: 'x'.repeat(50) + '\n' + 'y'.repeat(50) }], { ...DEFAULTS, maxHitChars: 60 })
  assert.match(out, /x{50} y{9}/)
  assert.ok(!out.includes('y'.repeat(10)))
})

// ── 端到端：解析 → 选席 → 渲染 ────────────────────────────────────────────

test('端到端：10 主检索 + 5 联想 + 1 透镜', () => {
  const raw = wrap(
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => envelope(`主检索正文${i}`, { score: (95 - i) + '%(混合)', file: `m${i}.txt` })),
    ...[1, 2, 3, 4, 5].map(i => envelope(`联想正文${i}`, { score: (90 - i) + '%(混合)', file: `a${i}.txt`, assoc: { coCount: 2 + (i % 3), seedTotal: 10 } })),
    envelope('透镜正文', { score: '80%(混合)', file: '2026-10-12-23_33_03-[工程经验]直觉卡·测试.txt', folder: '溟月的知识' }),
  )
  const hits = parseLightmemo(raw)
  assert.equal(hits.length, 16)
  assert.equal(hits.filter(h => h.lens).length, 1)
  assert.equal(hits.filter(h => h.associate && !h.lens).length, 5)
  assert.equal(hits.filter(h => !h.associate && !h.lens).length, 10)

  const sel = selectHits(hits, 58, 5, 0.4, 2)
  assert.equal(sel.length, 6)
  assert.deepEqual(sel.map(h => [h.lens ? 'L' : h.associate ? 'A' : 'M']).flat().join(''), 'MMMAAL')

  const out = renderRecallSection(sel, { ...DEFAULTS, maxChars: 4000 })
  assert.match(out, /【联想共现记忆 \(2条, 多条记忆交叉关联\)】/)
  assert.match(out, /【元思考直觉 \(1枚, 注意力扳手而非事实\)】/)
  assert.ok(out.indexOf('联想正文') > out.indexOf('【联想共现记忆'))
  assert.ok(out.indexOf('透镜正文') > out.indexOf('【元思考直觉'))
  assert.ok(!out.includes('{{'))
})
