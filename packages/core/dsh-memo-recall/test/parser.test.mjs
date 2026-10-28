import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULTS, parseLightmemo, selectHits, renderRecallSection, titleFromPath } from '../lib/index.js'

// Synthetic LightMemo envelopes only; no personal notes or network requests.
const hit = (body, { score = '90%(混合)', path = 'file:///测试/demo.md', meta = '' } = {}) =>
  `--- (来源: 测试, 相关性: ${score})\n    [路径: ${path}]\n${meta}${body}\n`
const wrap = (...hits) => '[--- LightMemo 轻量回忆 ---]\n' + hits.join('\n') + '[--- 回忆结束 ---]\n'

test('Markdown without any timestamp is parsed and rendered', () => {
  const body = '# 设计说明\n\n- 保留原始证据\n- 检查召回结果'
  const hits = parseLightmemo(wrap(hit(body)))
  assert.equal(hits[0].body, body)
  assert.equal(hits[0].title, 'demo')
  assert.match(renderRecallSection(selectHits(hits, 58, 3), DEFAULTS), /保留原始证据/)
})

test('plain text and CRLF are accepted with no date, timestamp or tags', () => {
  const hits = parseLightmemo(wrap(hit('第一行\n第二行')).replaceAll('\n', '\r\n'))
  assert.equal(hits[0].date, '')
  assert.equal(hits[0].body, '第一行\n第二行')
})

test('a timestamp midway does not discard earlier body text', () => {
  assert.equal(parseLightmemo(hit('前言\n[12:30] 中途记录\n后续内容'))[0].body, '前言\n[12:30] 中途记录\n后续内容')
})

test('diary metadata and known ranking headers are excluded', () => {
  const meta = '    [RiverMemo Topology V3: Ω=0.8/dense, 角色=direct_answer]\n' +
    '    [TagMemo V9.1 + 势能场 增强: 标签]\n[2026-10-08] - test\n'
  const parsed = parseLightmemo(hit('[12:30] 正文\n第二行\nTag: test', { meta }))[0]
  assert.equal(parsed.date, '2026-10-08')
  assert.equal(parsed.body, '[12:30] 正文\n第二行')
})

test('bare date header remains optional for Markdown', () => {
  const parsed = parseLightmemo(hit('[2026-10-08]\n# 无时间戳正文'))[0]
  assert.equal(parsed.date, '2026-10-08')
  assert.equal(parsed.body, '# 无时间戳正文')
})

test('bracketed prose, Markdown date links and internal Tag lines are body', () => {
  const body = '[2026-10-08](./archive.md)\n[说明] 以下是配置\nTag: 示例字段\n' +
    '[路径: 正文中的例子]\n[RiverMemo Topology V3: 示例]\n[--- 普通说明 ---]\n最后一行'
  assert.equal(parseLightmemo(hit(body + '\nTag: trailer'))[0].body, body)
})

for (const fence of ['```', '~~~~']) {
  test(`fenced examples preserve protocol-like lines and indentation (${fence})`, () => {
    const body = `${fence}text\nTag: 示例\n    indented\n` +
      '--- (来源: 示例, 相关性: 99%(混合))\n[路径: file:///example.txt]\n' +
      '[2026-10-01] - example\n[--- 回忆结束 ---]\n' + fence
    const hits = parseLightmemo(wrap(hit(body + '\nTag: trailer'), hit('下一条')))
    assert.equal(hits.length, 2)
    assert.equal(hits[0].body, body)
    assert.equal(hits[1].body, '下一条')
  })
}

test('a shorter fence cannot close a longer fenced block', () => {
  const body = '````text\n```\nTag: 字面内容\n[--- 回忆结束 ---]\n````'
  assert.equal(parseLightmemo(wrap(hit(body)))[0].body, body)
})

test('a chunk ending in an unclosed fence does not swallow the next recall result', () => {
  const body = '# 被截断的代码片段\n```js\nconst value = 1'
  const hits = parseLightmemo(wrap(hit(body), hit('下一条正文')))
  assert.equal(hits.length, 2)
  assert.equal(hits[0].body, body)
  assert.equal(hits[1].body, '下一条正文')
})

test('indented code Tag lines are preserved', () => {
  const body = '# 配置示例\n\n    Tag: literal\n    value: 1'
  assert.equal(parseLightmemo(hit(body + '\nTag: metadata'))[0].body, body)
})

test('mixed records remain separate including an unavailable score', () => {
  const hits = parseLightmemo(wrap(
    hit('[12:30] 日记\nTag: diary'),
    hit('未评分内容', { score: 'N/A' }),
    hit('# Markdown'),
    hit('普通文本'),
  ))
  assert.deepEqual(hits.map(h => h.body), ['[12:30] 日记', '未评分内容', '# Markdown', '普通文本'])
  assert.equal(hits[1].score, 0)
  assert.equal(selectHits(hits, 58, 5).length, 3)
})

test('empty metadata-only records do not consume topN or render a title-only block', () => {
  const empty = hit('[2026-10-08] - test\n\nTag: empty', { score: '99%(混合)', meta: '    [TagMemo V9.1 增强: test]\n' })
  const hits = parseLightmemo(wrap(empty, hit('有用正文')))
  assert.equal(hits[0].body, '')
  assert.equal(selectHits(hits, 58, 1)[0].body, '有用正文')
  assert.equal(renderRecallSection([hits[0], { body: ' \n\t' }], DEFAULTS), '')
  assert.doesNotMatch(renderRecallSection(hits, DEFAULTS), /99%/)
})

test('known cold-knowledge envelopes end records without leaking into body', () => {
  const raw = '[--- TDB 冷知识库检索 ---]\n' + hit('普通知识') + '[--- 知识库检索结束 ---]\n'
  assert.equal(parseLightmemo(raw)[0].body, '普通知识')
})

test('loose text outside result wrappers is never treated as a recall hit', () => {
  assert.deepEqual(parseLightmemo('# 错误响应\n无法检索'), [])
  assert.deepEqual(parseLightmemo('[--- LightMemo 轻量回忆 ---]\n没有找到相关记忆'), [])
})

test('Markdown title extensions and URL encoding are removed', () => {
  assert.equal(titleFromPath('file:///a/%E6%B5%8B%E8%AF%95.MD'), '测试')
  assert.equal(titleFromPath('file:///a/2026-10-08-12_30_00-设计.markdown'), '设计')
})
