#!/usr/bin/env node
/**
 * dsh-local-search 冒烟测试 —— 打真实的 Everything HTTP 服务，不 mock。
 *
 * 分两组：
 *   [单元] 纯函数与工具契约，任何机器都能跑。
 *   [实测] 需要 Everything 在运行且 HTTP 服务器已启用；环境不满足时明确 SKIP 并说明原因，
 *          绝不假装通过。本机（2026-10-03）全绿。
 *
 * 最关键的护栏是「FILETIME 换算交叉验证」：Everything 的 date_modified 是 1601 纪元的 100ns
 * 计数，纪元常量或除数写错都会静默给出偏移数年的时间。这里拿 fs.statSync 的真实 mtime 对撞，
 * 并逐字比对格式化出的本地时间字符串。
 */
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import plugin from '../lib/index.js'
import * as E from '../lib/everything.js'

let pass = 0
let fail = 0
let skip = 0

function check(name, fn) {
  try {
    fn()
    pass++
    console.log('  PASS  ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL  ' + name)
    console.log('        ' + String(e && e.message).split('\n').join('\n        '))
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    pass++
    console.log('  PASS  ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL  ' + name)
    console.log('        ' + String(e && e.message).split('\n').join('\n        '))
  }
}

function skipIt(name, why) {
  skip++
  console.log('  SKIP  ' + name + '  （' + why + '）')
}

// ---------------------------------------------------------------- 环境探测
let live = null
try {
  live = await E.search('Everything.exe', { maxResults: 5 })
} catch (e) {
  live = null
  console.log('! Everything HTTP 服务不可达，实测组将 SKIP：' + String(e && e.message))
}

console.log('\n=== [单元] 工具契约 ===')

const registered = []
plugin.apply({ tools: { register(tool) { registered.push(tool) } } })
const tool = registered[0]

check('插件导出 name / inject / apply', () => {
  assert.equal(plugin.name, 'local-search')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')
})

check('apply 恰好注册 1 个工具，且暴露 execute', () => {
  assert.equal(registered.length, 1)
  assert.equal(typeof tool.execute, 'function')
  assert.equal(tool.name, 'everything_search')
})

check('query 在 schema 里必需且为字符串', () => {
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.properties.query.type, 'string')
  assert.deepEqual(tool.parameters.required, ['query'])
})

// 实测（2026-10-03）：defineTool 的存在性与类型校验跑在业务分发之前 —— 缺失或类型不对直接抛
// ToolArgsError，进不到 execute。所以「缺失」归框架兜，「空串 / 纯空白」才是本工具该管的。
// （这里与 dsh-code-tools 那条「改非必填、execute 里手动校验」的教训不冲突：那条是参数
//   在批量模式下合法缺省，而 query 是无条件必需，schema 就该说实话。）
await checkAsync('缺失 / 非字符串的 query 在业务分发前被框架挡下', async () => {
  await assert.rejects(() => tool.execute({}), /missing required property "query"/)
  await assert.rejects(() => tool.execute({ query: null }), /must be a string/)
  await assert.rejects(() => tool.execute({ query: 123 }), /must be a string/)
})

await checkAsync('空串 / 纯空白 query 落到业务层，返回语法提示而非空搜全盘', async () => {
  assert.match(await tool.execute({ query: '' }), /缺少 query/)
  assert.match(await tool.execute({ query: '   ' }), /缺少 query/)
  assert.match(await tool.execute({ query: '\t\n ' }), /缺少 query/)
})

console.log('\n=== [单元] 纯函数 ===')

check('normalizeMaxResults：默认 100，上限 1000，非法值回落', () => {
  assert.equal(E.normalizeMaxResults(undefined), 100)
  assert.equal(E.normalizeMaxResults(0), 100)
  assert.equal(E.normalizeMaxResults(-5), 100)
  assert.equal(E.normalizeMaxResults('abc'), 100)
  assert.equal(E.normalizeMaxResults(NaN), 100)
  assert.equal(E.normalizeMaxResults(7), 7)
  assert.equal(E.normalizeMaxResults(12.9), 12)
  assert.equal(E.normalizeMaxResults(99999), 1000)
})

check('humanBytes 各档位；目录空串返回空串', () => {
  assert.equal(E.humanBytes(''), '')
  assert.equal(E.humanBytes(null), '')
  assert.equal(E.humanBytes(0), '0 B')
  assert.equal(E.humanBytes(512), '512 B')
  assert.equal(E.humanBytes(2048), '2.0 KB')
  assert.equal(E.humanBytes(1783464), '1.7 MB')
  assert.equal(E.humanBytes(2147483648), '2.00 GB')
})

check('group 千分位不依赖 locale', () => {
  assert.equal(E.group(5), '5')
  assert.equal(E.group(71102), '71,102')
  assert.equal(E.group(1234567890), '1,234,567,890')
})

check('formatFiletime 对空值 / 非法值返回空串', () => {
  assert.equal(E.formatFiletime(''), '')
  assert.equal(E.formatFiletime(0), '')
  assert.equal(E.formatFiletime(null), '')
  assert.equal(E.formatFiletime(undefined), '')
  assert.equal(E.formatFiletime('abc'), '')
  assert.equal(E.formatFiletime(-1), '')
})

check('joinPath 容忍根目录的尾部反斜杠', () => {
  assert.equal(E.joinPath('C:\\Users\\a', 'b.txt'), 'C:\\Users\\a\\b.txt')
  assert.equal(E.joinPath('C:\\', 'b.txt'), 'C:\\b.txt')
  assert.equal(E.joinPath('', 'b.txt'), 'b.txt')
})

check('formatResults 空结果给出可操作的语法提示', () => {
  const text = E.formatResults('nope', 0, [])
  assert.match(text, /没有命中任何文件/)
  assert.match(text, /ext:mp4/)
})

check('formatResults 正确标记目录、跳过目录大小、保留反斜杠后缀', () => {
  const rows = [
    { type: 'folder', name: 'sub', path: 'C:\\a', size: '', date_modified: '134335941884898060' },
    { type: 'file', name: 'x.txt', path: 'C:\\a', size: '2048', date_modified: '134335941884898060' },
  ]
  const text = E.formatResults('q', 2, rows)
  assert.match(text, /`C:\\a\\sub\\`/)
  assert.match(text, /目录/)
  assert.match(text, /`C:\\a\\x\.txt` — 2\.0 KB/)
  assert.match(text, /全部返回/)
  const lines = text.split('\n')
  const folderLine = lines.find((l) => l.startsWith('1. '))
  const fileLine = lines.find((l) => l.startsWith('2. '))
  assert.ok(!/\d+(\.\d+)? ?(KB|MB|GB|B)\b/.test(folderLine), '目录行不应带大小：' + folderLine)
  assert.match(fileLine, /2\.0 KB/, '文件行应带大小：' + fileLine)
  assert.match(folderLine, /目录 · /, '目录行应带目录标记与时间：' + folderLine)
})

check('formatResults 截断时给出提示与真实总数', () => {
  const rows = [{ type: 'file', name: 'x', path: 'C:\\a', size: '1', date_modified: '' }]
  const text = E.formatResults('q', 71102, rows)
  assert.match(text, /命中 \*\*71,102\*\* 条/)
  assert.match(text, /返回前 1 条/)
  assert.match(text, /被 `maxResults` 截断/)
})

check('diagnose 把 ECONNREFUSED 翻成排查清单', () => {
  const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:80'), { code: 'ECONNREFUSED' })
  const text = E.diagnose(err)
  assert.match(text, /Everything 是否在运行/)
  assert.match(text, /HTTP服务器/)
  assert.match(text, /Everything\.ini/)
  assert.match(text, /DSH_EVERYTHING_PORT/)
})

check('端口解析：环境变量 DSH_EVERYTHING_PORT 优先', () => {
  const before = E.resolvePort()
  process.env.DSH_EVERYTHING_PORT = '8123'
  E.resetPortCache()
  assert.equal(E.resolvePort(), 8123)
  process.env.DSH_EVERYTHING_PORT = 'not-a-port'
  E.resetPortCache()
  assert.equal(E.resolvePort(), before, '非法环境变量应被忽略而非污染')
  delete process.env.DSH_EVERYTHING_PORT
  E.resetPortCache()
})

check('端口解析：与 Everything.ini 的 http_server_port 一致', () => {
  let iniPort = null
  try {
    const m = /^http_server_port=(\d+)\s*$/m.exec(readFileSync(E.EVERYTHING_INI, 'utf8'))
    if (m) iniPort = Number(m[1])
  } catch { /* 没装 Everything 就跳过这条 */ }
  if (iniPort === null) {
    skip++
    console.log('  SKIP  端口解析（读不到 ' + E.EVERYTHING_INI + '）')
    return
  }
  E.resetPortCache()
  assert.equal(E.resolvePort(), iniPort)
})

// ---------------------------------------------------------------- 实测组
console.log('\n=== [实测] 打真实 Everything HTTP 服务 ===')

if (!live) {
  skipIt('全部实测用例', 'Everything HTTP 服务不可达')
} else {
  check('端口落在 1..65535 且查询成功', () => {
    assert.ok(Number.isInteger(live.port) && live.port > 0 && live.port < 65536)
    assert.ok(live.total > 0)
    assert.ok(live.rows.length > 0)
  })

  check('n 参数不被 http_server_items_per_page(=32) 截断', async () => {
    const wide = await E.search('ext:json', { maxResults: 100 })
    assert.ok(wide.rows.length > 32, '只回了 ' + wide.rows.length + ' 条，n 参数疑似被分页设置截断')
  })

  check('FILETIME 换算与 fs.statSync 的真实 mtime 对撞一致', () => {
    const target = live.rows.find(
      (r) => r.type === 'file' && r.name.toLowerCase() === 'everything.exe' && /Program Files/i.test(r.path)
    )
    assert.ok(target, '实测组前提：结果里应有 C:\\Program Files (x86)\\Everything\\Everything.exe')
    const full = E.joinPath(target.path, target.name)
    const st = statSync(full)
    const converted = Number(target.date_modified) / 10000 - E.FILETIME_EPOCH_DIFF_MS
    assert.ok(
      Math.abs(converted - st.mtimeMs) < 2000,
      'FILETIME 换算偏离 ' + Math.round(converted - st.mtimeMs) + 'ms（纪元常量或除数写错）'
    )
    const p = (x) => String(x).padStart(2, '0')
    const d = st.mtime
    const expected = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    assert.equal(E.formatFiletime(target.date_modified), expected)
  })

  check('中文路径正确解码为 CJK，不是 Latin-1 乱码', async () => {
    const zh = await E.search('日记', { maxResults: 10 })
    if (zh.total === 0) {
      skip++
      console.log('  SKIP  中文路径（本机无匹配「日记」的文件）')
      return
    }
    const names = zh.rows.map((r) => r.name + ' ' + r.path)
    assert.ok(
      names.some((s) => /[\u4e00-\u9fff]/.test(s)),
      '没有任何 CJK 字符，中文被解坏了：' + JSON.stringify(zh.rows[0])
    )
    assert.ok(!names.some((s) => /Ã.|Â.|å.|æ./.test(s)), '出现了 UTF-8 被当 Latin-1 解码的乱码')
    assert.match(E.formatResults('日记', zh.total, zh.rows), /[\u4e00-\u9fff]/)
  })

  check('folder: 限定返回目录，且格式化后带反斜杠后缀', async () => {
    const dirs = await E.search('folder:日记', { maxResults: 5 })
    if (dirs.total === 0) {
      skip++
      console.log('  SKIP  目录标记（本机无匹配目录）')
      return
    }
    assert.ok(dirs.rows.every((r) => r.type === 'folder'))
    const text = E.formatResults('folder:日记', dirs.total, dirs.rows)
    assert.match(text, /目录/)
    assert.match(text, /`[^`]*\\`/)
  })

  await checkAsync('端到端：经工具执行返回可读结果', async () => {
    const out = await tool.execute({ query: 'Everything.exe', maxResults: 3 })
    assert.match(out, /^\*\*本地秒搜 \(Everything\)\*\*/)
    assert.match(out, /Everything\.exe/)
    assert.ok(out.split('\n').length >= 4)
  })

  await checkAsync('端到端：无命中时给出语法提示', async () => {
    const out = await tool.execute({ query: 'zzzz_no_such_file_' + Date.now() })
    assert.match(out, /没有命中任何文件/)
  })

  await checkAsync('端到端：maxResults 生效且不超上限', async () => {
    const few = await tool.execute({ query: 'ext:json', maxResults: 2 })
    const numbered = few.split('\n').filter((l) => /^\d+\. `/.test(l))
    assert.ok(numbered.length <= 2, '返回了 ' + numbered.length + ' 行，超过 maxResults=2')
    const huge = await tool.execute({ query: 'ext:json', maxResults: 999999 })
    const hugeRows = huge.split('\n').filter((l) => /^\d+\. `/.test(l))
    assert.ok(hugeRows.length <= E.HARD_MAX_RESULTS, '突破了硬上限 ' + E.HARD_MAX_RESULTS)
  })
}

console.log('\n=== 汇总 ===')
console.log('PASS ' + pass + '  FAIL ' + fail + '  SKIP ' + skip)
if (fail > 0) process.exit(1)
