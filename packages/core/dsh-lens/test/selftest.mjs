/**
 * dsh-lens 自测：不依赖插件装载，直接驱动查询层。
 * 用法：DSH_LENS_ASAR="<DSH 安装目录>/resources/app.asar" node test/selftest.mjs
 */
import { AsarReader } from '../lib/lens.js'
import { toolVersions, toolList, toolFile, toolGrep } from '../lib/queries.js'

const asarPath = process.env.DSH_LENS_ASAR
if (!asarPath) { console.error('[skip] set DSH_LENS_ASAR=<...>/resources/app.asar'); process.exit(2) }
const reader = new AsarReader(asarPath).open()

let passed = 0
let failed = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}  ${detail}`)
  }
}

// 1) 版本对账：核心包齐、总数像话
const versions = toolVersions(reader, '')
check('versions: core has @deepseek-ai/dsh', versions.core['@deepseek-ai/dsh'] !== undefined, JSON.stringify(versions.core))
check('versions: core has cordis', versions.core['@deepseek-ai/cordis'] !== undefined)
check('versions: total > 200', versions.total > 200, `total=${versions.total}`)
const filtered = toolVersions(reader, 'client-ui-settings')
check('versions: filter works', filtered.packages !== null && filtered.packages.length >= 1, JSON.stringify(filtered.packages?.slice(0, 2)))

// 2) 列目录：短名与全名都能解析，lib 下有 index.js
const listShort = toolList(reader, 'dsh-tools', 'lib')
check('list: short name resolves', !listShort.error && listShort.entries.some((entry) => entry.name === 'index.js'), JSON.stringify(listShort.error || ''))
const listFull = toolList(reader, '@deepseek-ai/dsh-tools', '')
check('list: full name resolves at root', !listFull.error && listFull.entries.some((entry) => entry.name === 'lib'))
const listBad = toolList(reader, 'this-package-does-not-exist', '')
check('list: missing package errors cleanly', listBad.error !== undefined)

// 3) 读文件：行号范围三种形态 + 截断说明
const manifest = toolFile(reader, '@deepseek-ai/dsh', 'package.json', 'head:5')
check('file: head:5 gives 5 numbered lines', !manifest.error && manifest.text.split('\n').length === 5, manifest.text?.slice(0, 80))
check('file: head starts at line 1', manifest.text?.startsWith('1 | '))
const mid = toolFile(reader, '@deepseek-ai/dsh', 'package.json', '2-3')
check('file: M-N returns the requested slice', !mid.error && mid.text?.startsWith('2 | '), mid.text?.slice(0, 60))
const bad = toolFile(reader, '@deepseek-ai/dsh', 'package.json', 'oops')
check('file: bad spec errors cleanly', bad.error !== undefined)
const missing = toolFile(reader, '@deepseek-ai/dsh', 'no-such-file.js', '')
check('file: missing file errors cleanly', missing.error !== undefined)

// 4) grep：今天真实问过的符号 + 空结果干净 + 正则与字面量分叉
const hit = toolGrep(reader, { pattern: 'assertSubagentMaxDepth', package: 'dsh-subagent' })
check('grep: real symbol hits', hit.matches.length >= 1, JSON.stringify(hit.matches.slice(0, 2)))
const none = toolGrep(reader, { pattern: 'this-never-exists-xyzzy', package: 'dsh-tools' })
check('grep: empty result is clean', none.error === undefined && none.totalMatches === 0)
const literal = toolGrep(reader, { pattern: 'Config = z.object', package: 'dsh-web' })
const asRegex = toolGrep(reader, { pattern: 'Config = z\\.object', package: 'dsh-web', regex: true })
check('grep: literal and regex agree on this pattern', literal.totalMatches === asRegex.totalMatches && literal.totalMatches > 0, `${literal.totalMatches} vs ${asRegex.totalMatches}`)
const dotLiteral = toolGrep(reader, { pattern: 'a.b', package: 'dsh-web' })
const dotRegex = toolGrep(reader, { pattern: 'a.b', package: 'dsh-web', regex: true })
check('grep: literal does NOT treat dot as wildcard (regex finds more)', dotRegex.totalMatches > dotLiteral.totalMatches, `${dotLiteral.totalMatches} vs ${dotRegex.totalMatches}`)

console.log(`\n${passed} passed, ${failed} failed  ·  asar=${reader.path} (${reader.countFiles()} files)`)
process.exit(failed ? 1 : 0)
