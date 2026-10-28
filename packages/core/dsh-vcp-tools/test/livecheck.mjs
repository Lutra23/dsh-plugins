/**
 * dsh-vcp-tools 真实桥端到端自检（需 VCP 服务在跑）。
 * 与 selftest.mjs 分工：selftest 用假 ctx 验「发出去的载荷对不对」（离线、可 CI）；
 * livecheck 用真 child_process 实现 ctx.subprocess，验「真桥回来的形状对不对」——
 * 双层解包、list 文本回切、search 的 notes 形状这些只能实测。
 * 运行：node test/livecheck.mjs        （只读 + 不落盘的拒绝分支）
 *       node test/livecheck.mjs --mutations  （额外验真写：update 同内容自替换须逐字节不变、create 探针删后复查）
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MUTATIONS = process.argv.includes('--mutations')

// @deepseek-ai/dsh-tools 由宿主本体提供，离线跑要给一个 defineTool 透传桩。
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'vcptools-live-'))
fs.mkdirSync(path.join(T, 'node_modules', '@deepseek-ai', 'dsh-tools'), { recursive: true })
fs.writeFileSync(path.join(T, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'), '{"name":"@deepseek-ai/dsh-tools","version":"0.0.0-stub","type":"module","main":"index.js"}')
fs.writeFileSync(path.join(T, 'node_modules', '@deepseek-ai', 'dsh-tools', 'index.js'), 'export const defineTool = (t) => t\n')
const instDir = path.join(T, 'node_modules', '@dsh-external', 'dsh-vcp-tools')
fs.mkdirSync(path.join(instDir, 'lib'), { recursive: true })
fs.copyFileSync(path.join(PKG_DIR, 'lib', 'index.js'), path.join(instDir, 'lib', 'index.js'))
fs.copyFileSync(path.join(PKG_DIR, 'package.json'), path.join(instDir, 'package.json'))
const mod = await import(pathToFileURL(path.join(instDir, 'lib', 'index.js')).href)

/** 真子进程 ctx：stdin 喂数据、同步收 stdout，等价 cordis 的 collected 读法。 */
function makeRealCtx() {
  const tools = []
  return {
    tools,
    ctx: {
      tools: { register(t) { tools.push(t) } },
      fs: {
        async resolve(p) { return p },
        async readText(p) { return fs.promises.readFile(p, 'utf8') },
      },
      subprocess: {
        async resolveExecutable() { return process.execPath },
        spawn(spec) {
          const stdinData = spec.stdio && spec.stdio.stdin && spec.stdio.stdin.data
          const r = spawnSync(spec.argv[0], spec.argv.slice(1), {
            cwd: spec.cwd || undefined,
            env: { ...process.env, ...(spec.env || {}) },
            input: stdinData == null ? '' : String(stdinData),
            encoding: 'utf8',
            timeout: 180000,
            maxBuffer: 64 * 1024 * 1024,
          })
          const text = r.status === 0 ? (r.stdout || '') : ''
          return {
            done: Promise.resolve({ exitCode: r.status == null ? 1 : r.status }),
            collected: {
              stdout: { readFrom: () => ({ text }) },
              stderr: { readFrom: () => ({ text: r.stderr || '' }) },
            },
          }
        },
      },
    },
  }
}

let pass = 0
let fail = 0
const skipped = []
async function test(title, fn) {
  try { await fn(); pass++; console.log('  ok  ' + title) }
  catch (e) {
    if (e && e.code === 'LIVE_SKIP') { skipped.push(title); console.log(' skip ' + title + '  (' + e.message + ')'); return }
    fail++
    console.error('FAIL  ' + title + '\n      ' + (e && e.message ? e.message.split('\n').slice(0, 6).join('\n      ') : e))
  }
}
function skipIfDown(out) {
  if (/日记读取错误|日记写入错误|LightMemo|无法读取 VCP admin|ECONNREFUSED|子进程退出码/.test(String(out).slice(0, 200))) {
    const e = new Error('桥不可用（VCP 未跑或凭证缺失）: ' + String(out).slice(0, 120))
    e.code = 'LIVE_SKIP'
    throw e
  }
}

function resolveCfg() {
  const c = {}
  if (process.env.VCP_HOST) c.vcpHost = process.env.VCP_HOST
  if (process.env.VCP_PORT) c.vcpPort = Number(process.env.VCP_PORT)
  if (process.env.VCP_ADMIN_USER) c.adminUser = process.env.VCP_ADMIN_USER
  if (process.env.VCP_ADMIN_PASSWORD) c.adminPass = process.env.VCP_ADMIN_PASSWORD
  let home = process.env.VCP_HOME || ''
  if (!home) {
    const guess = path.resolve(os.homedir(), 'Desktop', 'VCPToolBox')
    if (fs.existsSync(path.join(guess, 'config.env'))) home = guess
  }
  if (!home) {
    console.error('找不到 VCP 根目录：请设 VCP_HOME=<VCPToolBox 路径>（凭证与插件文件都从这里解析）')
    process.exit(2)
  }
  c.vcpHome = home
  return c
}

const CFG = resolveCfg()
const f = makeRealCtx()
mod.default.apply(f.ctx, CFG)
const byName = Object.fromEntries(f.tools.map((t) => [t.name, t]))
console.log('已注册工具：' + f.tools.map((t) => t.name).sort().join(', '))
console.log('vcpHome=' + CFG.vcpHome + ' 端点=' + (CFG.vcpHost || '127.0.0.1') + ':' + (CFG.vcpPort || 6005))

let sampleUrl = null
let sampleTarget = null

await test('五个工具全部注册（含新 dailynote_read）', () => {
  assert.deepEqual(f.tools.map((t) => t.name).sort(),
    ['chrome_bridge', 'dailynote_read', 'dailynote_write', 'doubao_search', 'lightmemo'])
})

await test('read list：紧凑目录行 + 篇数与行数一致（证明没把正文吐出来）', async () => {
  const out = await byName.dailynote_read.execute({ action: 'list', folder: 'DSH工程档案', startDate: '2026-10-01', endDate: '2026-10-10' })
  skipIfDown(out)
  const head = /共 (\d+) 篇/.exec(out)
  assert.ok(head, '应报篇数：' + String(out).slice(0, 200))
  const lines = out.split('\n').filter((l) => /^- \[\d{4}-\d{2}-\d{2}\] \S+\.txt/.test(l))
  assert.equal(lines.length, Number(head[1]), '目录行数应等于篇数')
  assert.ok(out.length < Number(head[1]) * 400 + 200, '紧凑行不应夹带正文（总长 ' + out.length + '）')
  sampleUrl = 'DSH工程档案/' + lines[0].split('] ')[1]
})

await test('read read：按 URL 取回整篇原文', async () => {
  const window = await byName.dailynote_read.execute({ action: 'list', folder: 'DSH工程档案', startDate: '2026-10-05', endDate: '2026-10-06' })
  if (/无日记/.test(window)) { const e = new Error('该窗口无样本'); e.code = 'LIVE_SKIP'; throw e }
  const m = /^- \[\d{4}-\d{2}-\d{2}\] (\S+\.txt)/m.exec(window)
  assert.ok(m, window.slice(0, 200))
  sampleUrl = 'DSH工程档案/' + m[1]
  const out = await byName.dailynote_read.execute({ action: 'read', url: sampleUrl })
  skipIfDown(out)
  assert.ok(out.startsWith('--- [' + sampleUrl + '] ('), '头部应回显 URL 与字数：' + out.slice(0, 160))
  assert.match(out, /\n\[\d{4}-\d{2}-\d{2}\] - /, '正文应以 VCP 日记首行开头')
  assert.ok(out.length > 300, '整篇原文不该是空壳')
  sampleTarget = out.split('\n').map((s) => s.trim()).find((s) => s.length >= 40 && !/^-{3}|^\[|^\d+\./.test(s))
})

await test('read search：Rust 全文命中带 库名/文件名 与上下文', async () => {
  const out = await byName.dailynote_read.execute({ action: 'search', query: '溟月', folder: 'DSH工程档案', max_results: 3, context_lines: 1 })
  skipIfDown(out)
  assert.match(out, /^命中 \d+ 个文件/, String(out).slice(0, 160))
  assert.match(out, /===== DSH工程档案\/.+\.txt/, '应给出库名/文件名')
})

await test('read associate：向量联想返回相似度条目', async () => {
  if (!sampleUrl) { const e = new Error('缺样本 URL'); e.code = 'LIVE_SKIP'; throw e }
  const out = await byName.dailynote_read.execute({ action: 'associate', url: sampleUrl, folder: 'DSH工程档案', k: 3, minScore: 0.2 })
  skipIfDown(out)
  assert.ok(!/联想检索失败/.test(out), out.slice(0, 200))
  assert.match(out, /找到 \d+ 条与|未找到与/, out.slice(0, 200))
})

await test('读白名单：越界库的 URL 被拒绝', async () => {
  const out = await byName.dailynote_read.execute({ action: 'read', url: '时政资料/2026-01-01-00_00_00.txt' })
  assert.match(out, /\*\*拒绝\*\*:.*读白名单/, out)
})

await test('写白名单：越界目录 create 被拒绝（不触桥）', async () => {
  const out = await byName.dailynote_write.execute({ action: 'create', folder: 'Nova的知识', title: 'x', content: 'y' })
  assert.match(out, /\*\*拒绝\*\*:.*不在写白名单/, out)
})

await test('update 先读后写：编造 target 被预检拦截', async () => {
  const out = await byName.dailynote_write.execute({
    action: 'update', folder: 'DSH工程档案',
    target: '这段文字是 livecheck 临时编造的占位串，绝不可能出现在真实日记里 zzq', replace: '不该被写入',
  })
  skipIfDown(out)
  assert.match(out, /\*\*更新被预检拦截\*\*/, String(out).slice(0, 300))
  assert.match(out, /dailynote_read|逐字/, '应指回去读姿势')
})

await test('update 正例：真实原文自替换前后 sha256 不变（需 --mutations）', async () => {
  if (!MUTATIONS) { const e = new Error('未开 --mutations'); e.code = 'LIVE_SKIP'; throw e }
  if (!sampleTarget) { const e = new Error('无真实原文样本'); e.code = 'LIVE_SKIP'; throw e }
  const abs = path.join(CFG.vcpHome, 'dailynote', sampleUrl.replace(/\//g, path.sep))
  if (!fs.existsSync(abs)) { const e = new Error('样本文件不在预期路径: ' + abs); e.code = 'LIVE_SKIP'; throw e }
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
  const before = sha(abs)
  try {
    const out = await byName.dailynote_write.execute({ action: 'update', url: sampleUrl, target: sampleTarget, replace: sampleTarget })
    skipIfDown(out)
    assert.ok(!out.includes('被预检拦截'), '真实原文应通过预检：' + String(out).slice(0, 240))
    assert.match(out, /✓ 日记已更新/, String(out).slice(0, 200))
    assert.equal(sha(abs), before, '同内容自替换必须逐字节不变——若变化说明 VCP 走了脱水匹配且替换区间与 target 不一致')
  } catch (e) {
    if (fs.existsSync(abs) && sha(abs) !== before) console.error('!! 警告: ' + sampleUrl + ' 内容发生变化，原 sha256=' + before)
    throw e
  }
})

await test('create 端到端真写 + 探针自动清理（仅 --mutations）', async () => {
  if (!MUTATIONS) { const e = new Error('未开 --mutations'); e.code = 'LIVE_SKIP'; throw e }
  const stamp = 'livecheck-' + Date.now()
  const out = await byName.dailynote_write.execute({ action: 'create', title: '探针 ' + stamp, content: '端到端验证载荷。', category: '工程经验', tags: 'livecheck' })
  assert.match(out, /✓ 日记已写入/, String(out).slice(0, 200))
  const dir = path.join(CFG.vcpHome, 'dailynote', 'DSH工程档案')
  const find = () => fs.readdirSync(dir).filter((nm) => nm.includes(stamp))
  assert.equal(find().length, 1, '应按标题找到刚写入的探针：' + JSON.stringify(find()))
  // 已知 VCP 行为：create 后短时间窗（>12s 实测）内删除会被索引链路重建复活，1 分钟后删除不复活。
  // 这是环境行为而非被测工具缺陷，故此处尽力清理并如实报告，不作为断言失败；测试后需手工收尾。
  for (const nm of find()) fs.rmSync(path.join(dir, nm))
  await new Promise((r) => setTimeout(r, 2000))
  const residue = find()
  if (residue.length) {
    console.log('      ⚠ 探针在 VCP 索引窗口内复活（已知现象，非工具缺陷）：' + residue.join(', ') + ' —— 测试后手工删除')
  } else {
    console.log('      探针已删除并复查通过: ' + stamp)
  }
})

fs.rmSync(T, { recursive: true, force: true })
console.log('')
console.log('PASS ' + pass + ' / FAIL ' + fail + ' / SKIP ' + skipped.length + (MUTATIONS ? '（含真写）' : '（只读；--mutations 开真写）'))
process.exit(fail ? 1 : 0)
