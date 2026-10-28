/**
 * dsh-vcp-tools 离线自检：不经 cordis，用假 ctx + 回放桥响应验证远端化行为面。
 * 运行：node test/selftest.mjs（无 VCP / 无网络，全离线）。
 * 原理：把 lib/index.js 复制进临时 node_modules 结构，stub 掉 @deepseek-ai/dsh-tools，
 *       apply(fakeCtx, config) 后对注册出的工具逐个 execute，断言 spawn 捕获的脚本/stdin/env/cwd。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- 搭临时解析结构：T/node_modules/@deepseek-ai/dsh-tools（stub）+ @dsh-external/dsh-vcp-tools（真码） ----
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'vcptools-test-'))
fs.mkdirSync(path.join(T, 'node_modules', '@deepseek-ai', 'dsh-tools'), { recursive: true })
fs.writeFileSync(path.join(T, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'), '{"name":"@deepseek-ai/dsh-tools","version":"0.0.0-stub","type":"module","main":"index.js"}')
fs.writeFileSync(path.join(T, 'node_modules', '@deepseek-ai', 'dsh-tools', 'index.js'), 'export const defineTool = (t) => t\n')
const instDir = path.join(T, 'node_modules', '@dsh-external', 'dsh-vcp-tools')
fs.mkdirSync(path.join(instDir, 'lib'), { recursive: true })
fs.copyFileSync(path.join(PKG_DIR, 'lib', 'index.js'), path.join(instDir, 'lib', 'index.js'))
fs.copyFileSync(path.join(PKG_DIR, 'package.json'), path.join(instDir, 'package.json'))
const mod = await import(pathToFileURL(path.join(instDir, 'lib', 'index.js')).href)

let pass = 0
let fail = 0
async function test(title, fn) {
  try { await fn(); pass++; console.log('  ok  ' + title) }
  catch (e) { fail++; console.error('FAIL  ' + title + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e)) }
}

/** 假 ctx：tools.register 收集工具；fs 回放两份 config.env；subprocess.spawn 捕获 spec 并回放 canned 队列。 */
function makeFakeCtx({ rootConfigEnv = 'AdminUsername=tu\nAdminPassword=tp', doubaoConfigEnv = 'WEB_SEARCH_API_KEY=k123\n', canned = [] } = {}) {
  const tools = []
  const spawned = []
  const queue = canned.slice()
  return {
    tools, spawned,
    ctx: {
      tools: { register(t) { tools.push(t) } },
      fs: {
        async resolve(p) { return p },
        async readText(p) {
          const s = String(p).replace(/\\/g, '/')
          if (/\/config\.env$/.test(s) && s.includes('DoubaoSearch')) {
            if (doubaoConfigEnv === null) throw new Error('ENOENT ' + p)
            return doubaoConfigEnv
          }
          if (/\/config\.env$/.test(s)) {
            if (rootConfigEnv === null) throw new Error('ENOENT ' + p)
            return rootConfigEnv
          }
          throw new Error('ENOENT ' + p)
        },
      },
      subprocess: {
        async resolveExecutable() { return process.execPath },
        spawn(spec) {
          spawned.push(spec)
          const c = queue.shift() || { stdout: '{"status":"success","result":{"content":[{"type":"text","text":"bridge ok"}]}}' }
          return {
            done: Promise.resolve({ exitCode: c.exitCode ?? 0 }),
            collected: {
              stdout: { readFrom: () => ({ text: c.stdout ?? '' }) },
              stderr: { readFrom: () => ({ text: c.stderr ?? '' }) },
            },
          }
        },
      },
    },
  }
}

const BRIDGE_OK = { stdout: '{"status":"success","result":{"content":[{"type":"text","text":"bridge ok"}]}}' }
const b64 = (u, p) => 'Basic ' + Buffer.from(u + ':' + p, 'utf8').toString('base64')

console.log('== 注册与端点注入 ==')
await test('五个工具全部注册（含新 dailynote_read）', async () => {
  const f = makeFakeCtx()
  mod.default.apply(f.ctx, {})
  assert.deepEqual(f.tools.map((t) => t.name).sort(), ['chrome_bridge', 'dailynote_read', 'dailynote_write', 'doubao_search', 'lightmemo'])
})
await test('远端端点注入桥脚本：host/port 来自 config，LM_AUTH 来自显式 adminUser/adminPass，cwd=vcpHome', async () => {
  const vcpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vcphome-'))
  const f = makeFakeCtx({ canned: [BRIDGE_OK] })
  mod.default.apply(f.ctx, { vcpHost: '10.0.0.8', vcpPort: 7443, vcpHome, adminUser: 'cu', adminPass: 'cp' })
  const lm = f.tools.find((t) => t.name === 'lightmemo')
  await lm.execute({ query: '测试' })
  const spec = f.spawned[0]
  assert.ok(spec.argv[2].includes('host:"10.0.0.8",port:7443,'), '端点必须注入')
  assert.ok(spec.argv[2].includes('/admin_api/plugins/LightMemo/execute'))
  assert.equal(spec.env.LM_AUTH, b64('cu', 'cp'), '显式 config 凭证最优先')
  assert.equal(spec.cwd, vcpHome, 'vcpHome 存在时作 cwd')
  assert.ok(JSON.parse(spec.stdio.stdin.data).query === '测试')
})
await test('凭证分层：config 缺省时环境变量优先，env 缺省时回落 vcpHome 的 config.env', async () => {
  const vcpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vcphome-'))
  const f1 = makeFakeCtx({ canned: [BRIDGE_OK] })
  const envSave = process.env.VCP_ADMIN_USER
  process.env.VCP_ADMIN_USER = 'eu'; process.env.VCP_ADMIN_PASSWORD = 'ep'
  try {
    mod.default.apply(f1.ctx, { vcpHome })
    await f1.tools.find((t) => t.name === 'lightmemo').execute({ query: 'x' })
    assert.equal(f1.spawned[0].env.LM_AUTH, b64('eu', 'ep'), '环境变量层')
  } finally { delete process.env.VCP_ADMIN_USER; delete process.env.VCP_ADMIN_PASSWORD; if (envSave !== undefined) process.env.VCP_ADMIN_USER = envSave }
  const f2 = makeFakeCtx({ canned: [BRIDGE_OK] })
  mod.default.apply(f2.ctx, { vcpHome })
  await f2.tools.find((t) => t.name === 'lightmemo').execute({ query: 'x' })
  assert.equal(f2.spawned[0].env.LM_AUTH, b64('tu', 'tp'), 'config.env 兜底层')
})
await test('vcpHome 不存在时 spawn cwd 回退系统临时目录', async () => {
  const f = makeFakeCtx({ canned: [BRIDGE_OK] })
  mod.default.apply(f.ctx, { vcpHome: path.join(os.tmpdir(), 'definitely-missing-' + Date.now()) })
  await f.tools.find((t) => t.name === 'lightmemo').execute({ query: 'x' })
  assert.equal(f.spawned[0].cwd, os.tmpdir(), 'cwd 必须回退 tmpdir 而非 ENOENT')
})

console.log('== doubao_search 双路 ==')
await test('桥模式：vcpHome 下无插件文件 → 走 admin_api 桥，本地无 Key 也放行（远端解析）', async () => {
  const vcpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vcphome-')) // 空目录：无 Plugin 子目录
  const f = makeFakeCtx({ canned: [BRIDGE_OK] })
  mod.default.apply(f.ctx, { vcpHome })
  const out = await f.tools.find((t) => t.name === 'doubao_search').execute({ query: '火山引擎' })
  const spec = f.spawned[0]
  assert.ok(spec.argv[2].includes('/admin_api/plugins/DoubaoSearch/execute'), '必须走桥而非 stdio')
  assert.equal(out, 'bridge ok')
  const req = JSON.parse(spec.stdio.stdin.data)
  assert.equal(req.api_key, undefined, '本地无 Key 不得塞空串覆盖远端解析')
})
await test('桥模式：插件级错误嵌一层 result.status=error 也要捕获', async () => {
  const vcpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vcphome-'))
  const f = makeFakeCtx({ canned: [{ stdout: '{"status":"success","result":{"status":"error","error":"额度不足"}}' }] })
  mod.default.apply(f.ctx, { vcpHome })
  const out = await f.tools.find((t) => t.name === 'doubao_search').execute({ query: 'x' })
  assert.ok(out.includes('豆包搜索失败') && out.includes('额度不足'))
})
await test('stdio 模式：插件文件存在 → spawnSync 直连本地插件，Key 取本地 config.env', async () => {
  const vcpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vcphome-'))
  fs.mkdirSync(path.join(vcpHome, 'Plugin', 'DoubaoSearch'), { recursive: true })
  fs.writeFileSync(path.join(vcpHome, 'Plugin', 'DoubaoSearch', 'DoubaoSearch.js'), '// dummy entry\n')
  const f = makeFakeCtx({ canned: [{ stdout: '{"status":"success","result":{"content":[{"type":"text","text":"stdio ok"}]}}' }] })
  mod.default.apply(f.ctx, { vcpHome })
  const out = await f.tools.find((t) => t.name === 'doubao_search').execute({ query: 'x' })
  const spec = f.spawned[0]
  assert.ok(spec.argv[2].includes('spawnSync'), '必须 stdio 直连')
  assert.ok(spec.argv[2].includes(JSON.stringify(path.join(vcpHome, 'Plugin', 'DoubaoSearch', 'DoubaoSearch.js'))), '插件路径来自 vcpHome')
  assert.equal(out, 'stdio ok')
  assert.equal(JSON.parse(spec.stdio.stdin.data).api_key, 'k123', 'Key 取本地 DoubaoSearch config.env')
})
await test('stdio 模式：本地文件在但无任何 Key → 返回配置引导而非硬错误', async () => {
  const vcpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vcphome-'))
  fs.mkdirSync(path.join(vcpHome, 'Plugin', 'DoubaoSearch'), { recursive: true })
  fs.writeFileSync(path.join(vcpHome, 'Plugin', 'DoubaoSearch', 'DoubaoSearch.js'), '// dummy entry\n')
  const f = makeFakeCtx({ doubaoConfigEnv: null })
  mod.default.apply(f.ctx, { vcpHome })
  const out = await f.tools.find((t) => t.name === 'doubao_search').execute({ query: 'x' })
  assert.ok(out.includes('WEB_SEARCH_API_KEY'), '应返回配置引导')
  assert.equal(f.spawned.length, 0, '无 Key 不得起子进程')
})

console.log('== dailynote_write / chrome_bridge ==')
await test('dailynote_write 组装 create 载荷（DSH工程档案 / 溟月 / 分类前缀文件名）', async () => {
  const f = makeFakeCtx({ canned: [BRIDGE_OK] })
  mod.default.apply(f.ctx, { adminUser: 'tu', adminPass: 'tp' })
  await f.tools.find((t) => t.name === 'dailynote_write').execute({ content: '正文', title: '测试标题', category: '开发节点' })
  const spec = f.spawned[0]
  assert.ok(spec.argv[2].includes('/admin_api/plugins/DailyNote/execute'))
  const req = JSON.parse(spec.stdio.stdin.data)
  assert.equal(req.command, 'create')
  assert.equal(req.folder, 'DSH工程档案')
  assert.equal(req.maid, '溟月')
  assert.ok(req.fileName.startsWith('[开发节点]测试标题'))
  assert.ok(req.Content.includes('[开发节点] 正文'))
})
await test('chrome_bridge 附加参数透传进桥载荷', async () => {
  const f = makeFakeCtx({ canned: [BRIDGE_OK] })
  mod.default.apply(f.ctx, { adminUser: 'tu', adminPass: 'tp' })
  await f.tools.find((t) => t.name === 'chrome_bridge').execute({ command: 'open_url', url: 'https://example.com', timeoutMs: 5000 })
  const spec = f.spawned[0]
  assert.ok(spec.argv[2].includes('/admin_api/plugins/ChromeBridge/execute'))
  const req = JSON.parse(spec.stdio.stdin.data)
  assert.equal(req.command, 'open_url')
  assert.equal(req.url, 'https://example.com')
  assert.equal(req.timeoutMs, 5000)
})

console.log('== 日记守卫（拒绝不触桥 / 放行带正确载荷） ==')
await test('写白名单：越界目录拒绝且零子进程', async () => {
  const f = makeFakeCtx()
  mod.default.apply(f.ctx, { adminUser: 'tu', adminPass: 'tp' })
  const out = await f.tools.find((t) => t.name === 'dailynote_write').execute({ action: 'create', folder: 'Nova的知识', title: 'x', content: 'y' })
  assert.match(out, /\*\*拒绝\*\*: 目录「Nova的知识」不在写白名单/)
  assert.equal(f.spawned.length, 0, '拒绝必须发生在桥之前')
})
await test('写白名单：别名「溟月」归一到「溟月的知识」放行', async () => {
  const f = makeFakeCtx({ canned: [BRIDGE_OK] })
  mod.default.apply(f.ctx, { adminUser: 'tu', adminPass: 'tp' })
  await f.tools.find((t) => t.name === 'dailynote_write').execute({ action: 'create', folder: '溟月', title: 't', content: 'c' })
  assert.equal(JSON.parse(f.spawned[0].stdio.stdin.data).folder, '溟月的知识')
})
await test('写白名单为空时 fail-closed（拒绝一切写入）', async () => {
  const f = makeFakeCtx()
  mod.default.apply(f.ctx, { adminUser: 'tu', adminPass: 'tp', writeFolders: ' ,' })
  const out = await f.tools.find((t) => t.name === 'dailynote_write').execute({ action: 'create', title: 'x', content: 'y' })
  assert.match(out, /写白名单为空/, out)
  assert.equal(f.spawned.length, 0)
})
await test('update 载荷只带 folder 不带 maid（保 VCP 优先队列）', async () => {
  const target = '这是一段超过十五个字符的逐字原文目标串zz'
  const note = { folder_name: 'DSH工程档案', name: '2026-10-09-00_00_00.txt', content: '前缀文字' + target + '后缀文字' }
  const searcher = { stdout: JSON.stringify({ status: 'success', result: { content: 'x', notes: [note], total: 1 } }) }
  const bridge = { stdout: JSON.stringify({ status: 'success', result: { status: 'success', result: { message: '已更新', folder: 'DSH工程档案', fileName: 'a.txt', indexStatus: 'queued' } } }) }
  const f2 = makeFakeCtx({ canned: [searcher, bridge] })
  mod.default.apply(f2.ctx, { adminUser: 'tu', adminPass: 'tp' })
  const out = await f2.tools.find((t) => t.name === 'dailynote_write').execute({ action: 'update', target, replace: target })
  const req = JSON.parse(f2.spawned[1].stdio.stdin.data)
  assert.equal(req.command, 'update')
  assert.equal(req.folder, 'DSH工程档案')
  assert.ok(!('maid' in req), 'update 不得带 maid，否则 owner 守卫踢目标库出优先队列')
  assert.match(out, /✓ 日记已更新: DSH工程档案\/a\.txt/)
})
await test('update 越库落盘触发告警（事后复核）', async () => {
  const target = '这是一段超过十五个字符的逐字原文目标串zz'
  const note = { folder_name: 'DSH工程档案', name: '2026-10-09-00_00_00.txt', content: '前缀文字' + target + '后缀文字' }
  const searcher = { stdout: JSON.stringify({ status: 'success', result: { content: 'x', notes: [note], total: 1 } }) }
  const bridge = { stdout: JSON.stringify({ status: 'success', result: { status: 'success', result: { message: '已更新', folder: 'Nova的知识', fileName: 'b.txt' } } }) }
  const f = makeFakeCtx({ canned: [searcher, bridge] })
  mod.default.apply(f.ctx, { adminUser: 'tu', adminPass: 'tp' })
  const out = await f.tools.find((t) => t.name === 'dailynote_write').execute({ action: 'update', target, replace: target })
  assert.match(out, /⚠ 越库改写告警/, out)
  assert.match(out, /反向改回/, out)
})
await test('update 造假 target 被预检拦截（定位不到）', async () => {
  const searcher = { stdout: JSON.stringify({ status: 'success', result: { content: '无', notes: [], total: 0 } }) }
  const f = makeFakeCtx({ canned: [searcher] })
  mod.default.apply(f.ctx, { adminUser: 'tu', adminPass: 'tp' })
  const out = await f.tools.find((t) => t.name === 'dailynote_write').execute({ action: 'update', target: '这段文字绝不可能出现在任何日记里zzzz', replace: 'x' })
  assert.match(out, /\*\*更新被预检拦截\*\*: 在「DSH工程档案」里定位不到/, out)
  assert.equal(f.spawned.length, 1, '只打了一次 searcher，没有落 DailyNote 桥')
})
await test('update 多命中被拦截（无法确定改哪篇）', async () => {
  const mk = (nm) => ({ folder_name: 'DSH工程档案', name: nm, content: '这是一段超过十五个字符的逐字原文目标串zz' })
  const searcher = { stdout: JSON.stringify({ status: 'success', result: { content: 'x', notes: [mk('2026-10-09-00_00_00.txt'), mk('2026-10-08-00_00_00.txt')], total: 2 } }) }
  const f = makeFakeCtx({ canned: [searcher] })
  mod.default.apply(f.ctx, { adminUser: 'tu', adminPass: 'tp' })
  const out = await f.tools.find((t) => t.name === 'dailynote_write').execute({ action: 'update', target: '这是一段超过十五个字符的逐字原文目标串zz', replace: 'x' })
  assert.match(out, /命中 2 篇/, out)
  assert.equal(f.spawned.length, 1)
})
await test('update 预检通道故障默认拒绝（给带 url/force 出口）', async () => {
  const f = makeFakeCtx({ canned: [{ exitCode: 2, stderr: 'ECONNREFUSED' }] })
  mod.default.apply(f.ctx, { adminUser: 'tu', adminPass: 'tp' })
  const out = await f.tools.find((t) => t.name === 'dailynote_write').execute({ action: 'update', target: '这是一段超过十五个字符的逐字原文目标串zz', replace: 'x' })
  assert.match(out, /默认不写/, out)
  assert.match(out, /force:true/, out)
})
await test('update VCP 定位失败带 fuzzyDiff 回显', async () => {
  const note = { folder_name: 'DSH工程档案', name: '2026-10-09-00_00_00.txt', content: '这是一段超过十五个字符的逐字原文目标串zz' }
  const searcher = { stdout: JSON.stringify({ status: 'success', result: { content: 'x', notes: [note], total: 1 } }) }
  const bridge = { stdout: JSON.stringify({ status: 'success', result: { status: 'error', error: 'Target content not found', result: { fuzzyDiff: { candidateFile: 'c.txt', diff: '--- a\n+++ b' } } } }) }
  const f = makeFakeCtx({ canned: [searcher, bridge] })
  mod.default.apply(f.ctx, { adminUser: 'tu', adminPass: 'tp' })
  const out = await f.tools.find((t) => t.name === 'dailynote_write').execute({ action: 'update', target: '这是一段超过十五个字符的逐字原文目标串zz', replace: 'x' })
  assert.match(out, /\*\*日记更新失败\*\*/, out)
  assert.match(out, /最接近候选: c\.txt/, out)
})
await test('organize 越界 URL 拒绝且零子进程', async () => {
  const f = makeFakeCtx()
  mod.default.apply(f.ctx, { adminUser: 'tu', adminPass: 'tp' })
  const out = await f.tools.find((t) => t.name === 'dailynote_write').execute({ action: 'organize', urls: 'DSH工程档案/2026-10-09-00_00_00.txt\nNova的知识/2026-10-09-00_00_00.txt', content: '合并正文' })
  assert.match(out, /\*\*拒绝\*\*: 以下 URL 所在库不在写白名单/, out)
  assert.equal(f.spawned.length, 0)
})

console.log('== dailynote_read 四动作 ==')
await test('read list 紧凑目录行：篇数==行数（不吐正文）', async () => {
  const body = '--- [DSH工程档案/2026-10-09-00_00_00-a.txt] ---\n[2026-10-09] - 溟月\n正文一行\nTag: 测试\n\n--- [DSH工程档案/2026-10-09-01_00_00-b.txt] ---\n[2026-10-09] - 溟月\n另一篇\nTag: 测试2'
  const f = makeFakeCtx({ canned: [
    { stdout: JSON.stringify({ status: 'success', result: { status: 'success', result: body } }) },
    { stdout: JSON.stringify({ status: 'success', result: { status: 'success', result: '在「溟月的知识」文件夹中无日记。' } }) },
  ] })
  mod.default.apply(f.ctx, { adminUser: 'tu', adminPass: 'tp' })
  const out = await f.tools.find((t) => t.name === 'dailynote_read').execute({ action: 'list', startDate: '2026-10-09', endDate: '2026-10-09' })
  assert.match(out, /共 2 篇/, out)
  assert.ok(!out.includes('正文一行'), '紧凑行不得夹带正文')
  assert.match(out, /‹Tag: 测试›/, out)
})
await test('read 白名单外 URL 拒绝', async () => {
  const f = makeFakeCtx()
  mod.default.apply(f.ctx, { adminUser: 'tu', adminPass: 'tp' })
  const out = await f.tools.find((t) => t.name === 'dailynote_read').execute({ action: 'read', url: '时政资料/2026-01-01-00_00_00.txt' })
  assert.match(out, /\*\*拒绝\*\*:.*读白名单/, out)
  assert.equal(f.spawned.length, 0)
})
await test('search 白名单外 notes 被过滤', async () => {
  const notes = [
    { folder_name: 'DSH工程档案', name: 'a.txt', last_modified: 't', preview: 'p', matches: [] },
    { folder_name: '时政资料', name: 'b.txt', last_modified: 't', preview: 'p', matches: [] },
  ]
  const f = makeFakeCtx({ canned: [{ stdout: JSON.stringify({ status: 'success', result: { content: 'x', notes, total: 2 } }) }] })
  mod.default.apply(f.ctx, { adminUser: 'tu', adminPass: 'tp' })
  const out = await f.tools.find((t) => t.name === 'dailynote_read').execute({ action: 'search', query: 'k' })
  assert.match(out, /命中 1 个文件/, out)
  assert.match(out, /DSH工程档案\/a\.txt/, out)
  assert.ok(!out.includes('时政资料'), '白名单外命中不得出现')
})

fs.rmSync(T, { recursive: true, force: true })
console.log('')
console.log('PASS ' + pass + ' / FAIL ' + fail)
process.exit(fail ? 1 : 0)
