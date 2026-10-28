/**
 * dsh-memo-recall 自检：解析器 / 选择 / 渲染 / 桥协议 / 凭证解析。
 * 用户消息、Todo 边界和上下文替换见 boundaries.test.mjs。
 * 运行：node test/selftest.mjs（无 VCP / 无 cordis 依赖，全离线）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DEFAULTS, VERSION, parseLightmemo, titleFromPath, selectHits, renderRecallSection,
  bridgeScript, resolveVcpAuth, normalizeRerank, buildRecallArgs, topologyVerdict,
} from '../lib/index.js'
import { actionLabel, trajectoryPrefix, pickPulseSource } from '../lib/pulse.js'

let pass = 0
let fail = 0
async function test(title, fn) {
  try { await fn(); pass++; console.log('  ok  ' + title) }
  catch (e) { fail++; console.error('FAIL  ' + title + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e)) }
}

// —— LightMemo 真实输出样本（2026-10-04 实机抓取格式，含中文与 file:/// 路径） ——
const SAMPLE = [
  '[--- LightMemo 轻量回忆 ---]',
  '[查询内容: "dsh-memo-recall 插件 记忆注入 system-prompt"]',
  '[搜索范围: Nova的知识, DSH工程档案]',
  '',
  '[找到 5 条相关记忆片段:]',
  '--- (来源: Nova的知识, 相关性: 86.5%(混合))',
  '    [路径: file:///Nova的知识/2026-10-02-20_03_35-提示词工程核心心法_消融注意力接缝与神态内化.txt]',
  '    [RiverMemo Topology V3: Ω=0.855/dense, 角色=direct_answer, 拓扑+0.0067, 直锚+0.1000]',
  '[2026-10-02] - Nova',
  '[20:03] 由主人现场校准所结晶的 System Prompt 设计四条底层心法与工程铁律。',
  '一、 核心命题与认知升维',
  'Tag: 提示词工程, 消除注意力接缝',
  '--- (来源: Nova的知识, 相关性: 73.3%(混合))',
  '    [路径: file:///Nova的知识/2026-08-15-13_39_50-DSH极简模式神区二象性与跨平台环境闭环.txt]',
  '[2026-08-15] - Nova',
  '[13:40] 追踪并结晶 DeepSeek Harness (DSH) 开源后 72 小时内引发的底层机制。',
  'Tag: DeepSeek-Harness, 极简模式',
  '--- (来源: DSH工程档案, 相关性: 83.3%(混合))',
  '    [路径: file:///DSH工程档案/2026-10-03-14_00_22-[工程经验]清单进提示词先选最薄载体.txt]',
  '[2026-10-03] - Nova',
  '[14:00] [工程经验] 表情包清单进提示词走了两次弯路才对。',
  'Tag: 工程经验, AGENTS.md注入',
  '[--- 回忆结束 ---]',
  '',
].join('\n')

console.log('== parseLightmemo ==')
await test('解析出 3 个命中块（含末块被 [--- 回忆结束 ---] 收口）', () => {
  const hits = parseLightmemo(SAMPLE)
  assert.equal(hits.length, 3)
})
await test('分数/文件夹/日期逐项正确', () => {
  const hits = parseLightmemo(SAMPLE)
  assert.equal(hits[0].score, 86.5)
  assert.equal(hits[0].folder, 'Nova的知识')
  assert.equal(hits[0].date, '2026-10-02')
  assert.equal(hits[2].folder, 'DSH工程档案')
  assert.equal(hits[2].date, '2026-10-03')
})
await test('保留日记时间戳与正文，排除末尾 Tag 和协议标记', () => {
  const hits = parseLightmemo(SAMPLE)
  assert.ok(hits[0].body.startsWith('[20:03] 由主人现场校准'))
  assert.ok(hits[0].body.includes('一、 核心命题与认知升维'))
  assert.ok(!hits[0].body.includes('Tag:'))
  assert.ok(!hits[2].body.includes('回忆结束'))
})
await test('空结果 / 纯错误文本返回空数组', () => {
  assert.deepEqual(parseLightmemo(''), [])
  assert.deepEqual(parseLightmemo('[--- LightMemo ---]\n未找到相关记忆'), [])
})

console.log('== titleFromPath ==')
await test('去时间戳前缀与 .txt，保留中文标题', () => {
  assert.equal(titleFromPath('file:///DSH工程档案/2026-10-03-14_00_22-[工程经验]清单进提示词先选最薄载体.txt'), '[工程经验]清单进提示词先选最薄载体')
})
await test('URL 编码与空值', () => {
  assert.equal(titleFromPath('file:///a/%E6%B5%8B%E8%AF%95.txt'), '测试')
  assert.equal(titleFromPath(''), '')
})

console.log('== selectHits / renderRecallSection ==')
await test('阈值 75 过滤掉 73.3，降序排列', () => {
  const hits = parseLightmemo(SAMPLE)
  const sel = selectHits(hits, 75, 5)
  assert.equal(sel.length, 2) // 86.5 与 83.3
  assert.equal(sel[0].score, 86.5)
  assert.equal(sel[1].score, 83.3)
})
await test('topN 截断', () => {
  assert.equal(selectHits(parseLightmemo(SAMPLE), 0, 2).length, 2)
})
await test('渲染含快照警示与元信息；无命中返回空串', () => {
  const sel = selectHits(parseLightmemo(SAMPLE), 75, 5)
  const text = renderRecallSection(sel, DEFAULTS)
  assert.ok(text.startsWith('[被动记忆召回]'))
  assert.ok(text.includes('快照'))
  assert.ok(text.includes('86.5%|Nova的知识|2026-10-02]'))
  assert.equal(renderRecallSection([], DEFAULTS), '')
})
await test('maxHitChars 截断生效且不撕裂代理对', () => {
  const text = renderRecallSection(parseLightmemo(SAMPLE).map((h) => ({ ...h, score: 99 })), { ...DEFAULTS, maxHitChars: 20 })
  assert.ok(text.length > 0 && text.length < 400)
  for (const line of text.split('\n')) {
    const last = line.charCodeAt(line.length - 1)
    if (line.length >= 20) assert.ok(last < 0xd800 || last > 0xdbff, '尾部不得是孤立高代理')
  }
})
await test('{{ 消毒：渲染结果不含任何 {{ 序列（插值扫描安全）', () => {
  const tpl = SAMPLE + '\n--- (来源: X, 相关性: 99%(混合))\n    [路径: file:///X/tpl.txt]\n[X] - N\n[00:00] Jinja 模板 {{ name }} 与残留 {{ 均会消毒\nTag: t'
  const text = renderRecallSection(parseLightmemo(tpl).map((h) => ({ ...h, score: 99 })), DEFAULTS)
  assert.ok(text.includes('{ {'), '消毒形态存在')
  assert.ok(!text.includes('{{'), '渲染结果不得残留 {{ 序列')
})

console.log('== VCP 端点与凭证（远端化/分发） ==')
await test('DEFAULTS 端点中性：默认本机回环，无任何用户路径烙印', () => {
  assert.equal(DEFAULTS.vcpHost, '127.0.0.1')
  assert.equal(DEFAULTS.vcpPort, 6005)
  assert.equal(DEFAULTS.vcpHome, '')
  assert.equal(DEFAULTS.adminUser, '')
  assert.equal(DEFAULTS.adminPass, '')
})
await test('bridgeScript 参数化：host/port 注入子脚本，默认回落本机端点', () => {
  const s = bridgeScript('10.0.0.8', 7443)
  assert.ok(s.includes('host:"10.0.0.8",port:7443,'), '端点必须注入生成的子脚本')
  assert.ok(!s.includes('127.0.0.1'), '指定端点后不得残留默认回环地址')
  assert.ok(bridgeScript().includes('host:"127.0.0.1",port:6005,'), '无参调用回落默认')
})
await test('resolveVcpAuth 分层：显式 config > 环境变量 > config.env 文本；全缺返回 null', () => {
  const b = (u, p) => 'Basic ' + Buffer.from(u + ':' + p, 'utf8').toString('base64')
  const envFull = { VCP_ADMIN_USER: 'eu', VCP_ADMIN_PASSWORD: 'ep' }
  const fileText = 'AdminUsername=fu\nAdminPassword=fp'
  assert.equal(resolveVcpAuth({ adminUser: 'cu', adminPass: 'cp' }, envFull, fileText), b('cu', 'cp'), '显式 config 最优先')
  assert.equal(resolveVcpAuth({}, envFull, fileText), b('eu', 'ep'), '环境变量次之')
  assert.equal(resolveVcpAuth({}, {}, fileText), b('fu', 'fp'), 'config.env 文本兜底')
  assert.equal(resolveVcpAuth({}, {}, ''), null, '全缺返回 null')
  assert.equal(resolveVcpAuth({ adminUser: 'cu' }, { VCP_ADMIN_PASSWORD: 'ep' }, ''), b('cu', 'ep'), 'user/pass 两半可跨层拼合')
})

console.log('== 版本同源 ==')
await test('VERSION 与 package.json 一致，且 plugin-loaded 日志引用同一常量（不硬编码）', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, pkg.version, 'lib 的 VERSION 必须等于 package.json.version（升版漏改即红灯）')
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const line = src.split('\n').find(l => l.includes("phase: 'plugin-loaded'"))
  assert.ok(line, 'plugin-loaded 行必须存在')
  assert.ok(line.includes('version: VERSION'), 'plugin-loaded 必须引用 VERSION 常量，不得硬编码字面量')
  assert.ok(!/version: '\d/.test(line), 'plugin-loaded 不得出现硬编码版本字面量')
})

console.log('== Rerank（::Rerank / ::Rerank+）==')
await test('normalizeRerank 关闭态：空串/false/off/无意义值一律 null（不下发）', () => {
  for (const v of ['', 'off', 'false', 'none', false, null, undefined, 'bogus', 0, 1.5]) {
    assert.equal(normalizeRerank(v), null, String(v))
  }
})
await test('normalizeRerank 开启态：true / rrf / rrf0.7 / α 数字按 LightMemo 语义透传', () => {
  assert.equal(normalizeRerank(true), true)
  assert.equal(normalizeRerank('on'), true)
  assert.equal(normalizeRerank('rrf'), 'rrf')
  assert.equal(normalizeRerank('RRF0.7'), 'rrf0.7')
  assert.equal(normalizeRerank(0.7), 0.7)
  assert.equal(normalizeRerank('0.6'), 0.6)
})
await test('buildRecallArgs：关闭时不出现 rerank 键，开启时按 ::Rerank+ 语义下发', () => {
  const base = buildRecallArgs('q', { ...DEFAULTS, folders: 'A|B', k: 7 })
  assert.ok(!('rerank' in base))
  assert.deepEqual(Object.keys(base).sort(), ['BM25', 'enginemode', 'folder', 'k', 'query', 'search_all_knowledge_bases'])
  assert.equal(base.enginemode, 'rivermemo')
  assert.equal(base.BM25, true)
  const on = buildRecallArgs('q', { ...DEFAULTS, rerank: 'rrf', associate: true, associateDepth: 9 })
  assert.equal(on.rerank, 'rrf')
  assert.equal(on.command, 'associate_search')
  assert.equal(on.associate_depth, 9)
})
await test('VERSION 与 package.json 同源', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, pkg.version)
})

console.log('== Rerank 选席（双量纲 / 名次保序）==')
const hit = (score, type) => ({ folder: 'X', score, scoreType: type, path: 'p', title: 't' + score, body: 'b', bodyStarted: true, associate: null, lens: false })
await test('parseLightmemo 保留相关性类型（混合 / Rerank）', () => {
  assert.equal(parseLightmemo(SAMPLE)[0].scoreType, '混合')
})
await test('双量纲：Rerank 命中过 rerankMinScore，混合命中仍受 minScore 约束', () => {
  const picked = selectHits([hit(14.1, 'Rerank'), hit(14.1, '混合')], 58, 5, 0.4, 0, { rerankMinScore: 0 })
  assert.equal(picked.length, 1)
  assert.equal(picked[0].scoreType, 'Rerank')
})
await test('preserveOrder 保留 RRF 名次；默认仍按分数降序', () => {
  const hits = [hit(10, 'Rerank'), hit(90, 'Rerank'), hit(50, 'Rerank')]
  const kept = selectHits(hits, 58, 3, 0.4, 0, { rerankMinScore: 0, preserveOrder: true })
  assert.deepEqual(kept.map(h => h.score), [10, 90, 50])
  const sorted = selectHits(hits, 58, 3, 0.4, 0, { rerankMinScore: 0 })
  assert.deepEqual(sorted.map(h => h.score), [90, 50, 10])
})
await test('Rerank+ 头部如实说明名次取席，不再声称单一阈值', () => {
  const selected = selectHits([hit(90, 'Rerank')], 58, 3, 0.4, 0, { rerankMinScore: 0, preserveOrder: true })
  const out = renderRecallSection(selected, { ...DEFAULTS, rerankRanked: true })
  assert.match(out, /Rerank\+ 融合名次取席/)
})


console.log('== RiverMemo V3 诊断门控（Step 2a） ==')
await test('解析命中行自带的 Ω/工况/角色/拓扑+/直锚+', () => {
  const hit = parseLightmemo(SAMPLE)[0]
  assert.equal(hit.topology.omega, 0.855)
  assert.equal(hit.topology.regime, 'dense')
  assert.equal(hit.topology.role, 'direct_answer')
  assert.equal(hit.topology.topologyBonus, 0.0067)
  assert.equal(hit.topology.anchorBonus, 0.1)
})
const collapsed = { score: 76, scoreType: '混合', body: 'x', title: 't', topology: { omega: 0.08, regime: 'collapsed', topologyBonus: 0, anchorBonus: 0 } }
const collapsedAnchored = { score: 76, scoreType: '混合', body: 'x', title: 't', topology: { omega: 0.08, regime: 'collapsed', topologyBonus: 0, anchorBonus: 0.1 } }
const denseBridge = { score: 52, scoreType: '混合', body: 'x', title: 't', topology: { omega: 0.5, regime: 'dense', topologyBonus: 0.02, anchorBonus: 0 } }
await test('门控默认关闭：坍缩命中照常保留（与旧行为一致）', () => {
  assert.equal(DEFAULTS.topologyGate, false)
  assert.equal(topologyVerdict(collapsed, 58, {}).drop, false)
  assert.deepEqual(selectHits([collapsed], 58, 3, 0.4, 0, {}).map(h => h.title), ['t'])
})
await test('门控开启：collapsed 且无直锚 → 丢弃；带直锚 → 保留', () => {
  const policy = { topologyGate: true }
  assert.equal(topologyVerdict(collapsed, 58, policy).drop, true)
  assert.equal(topologyVerdict(collapsedAnchored, 58, policy).drop, false)
  assert.equal(selectHits([collapsed, collapsedAnchored], 58, 3, 0.4, 0, policy).length, 1)
})
await test('门控开启：dense + 拓扑+ 阈值下浮，52% 桥接卡放行', () => {
  const policy = { topologyGate: true }
  const v = topologyVerdict(denseBridge, 58, policy)
  assert.equal(v.reason, 'dense-relax')
  assert.ok(v.threshold < 52)
  assert.equal(selectHits([denseBridge], 58, 3, 0.4, 0, policy).length, 1)
  assert.equal(selectHits([denseBridge], 58, 3, 0.4, 0, {}).length, 0)
})

console.log('== 3 步动作微轨迹（Step 2b） ==')
const errResult = { message: { isError: true, content: [{ type: 'text', text: 'TypeError: boom' }] } }
const okResult = { message: { content: [{ type: 'text', text: 'ok' }] } }
await test('动作标签只保留类别与成败，不拼路径/命令词', () => {
  assert.equal(actionLabel({ name: 'EditCode' }, okResult), '改码')
  assert.equal(actionLabel({ name: 'ReadCode' }, okResult), '查证')
  assert.equal(actionLabel({ name: 'ops_bash', arguments: { command: 'node --test' } }, okResult), '跑测试')
  assert.equal(actionLabel({ name: 'ops_bash', arguments: { command: 'npm run build' } }, okResult), '跑命令')
  assert.equal(actionLabel({ name: 'ops_bash', arguments: { command: 'node --test' } }, errResult), '跑测试✗')
})
await test('轨迹前缀按发生顺序用箭头串起，并受字符上限约束', () => {
  assert.equal(trajectoryPrefix(['查证', '改码', '跑测试✗']), '查证→改码→跑测试✗')
  assert.equal(Array.from(trajectoryPrefix(['查证', '改码', '跑测试✗'], 4)).length, 4)
})
await test('脉冲查询带上轨迹前缀，且总长仍 ≤200 字符', () => {
  const pick = pickPulseSource({
    call: { name: 'ops_bash', arguments: { command: 'node --test' } }, result: errResult,
    assistantText: '', trajectory: null, boundaryText: '修复召回', trajectoryText: '查证→改码'
  })
  assert.equal(pick.mode, 'error')
  assert.ok(pick.query.startsWith('ops_bash '))
  assert.ok(pick.query.includes('查证→改码'))
  assert.ok(Array.from(pick.query).length <= 200)
})
console.log('== DEFAULTS ==')
await test('默认值类型健全（数字为正、rerankMinScore 允许 0=不设下限、布尔为布尔）', () => {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (typeof v === 'number') {
      assert.ok(Number.isFinite(v), k)
      assert.ok(v > 0 || (k === 'rerankMinScore' && v === 0), k)
    }
  }
  assert.equal(typeof DEFAULTS.enabled, 'boolean')
})

console.log('')
console.log('PASS ' + pass + ' / FAIL ' + fail)
process.exit(fail ? 1 : 0)
