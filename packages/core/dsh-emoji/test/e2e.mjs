/**
 * dsh-emoji · 端到端自检（不依赖 DSH 进程）。
 *
 * 用一个最小 mock 顶替宿主：webServer.register 收集路由、tools.register 收集工具、
 * effect 立即执行并返回 disposer、logger 吞掉告警。然后把收集到的路由真挂到
 * 一个 node:http 服务器上，用真实 HTTP 请求走完整条链路：
 *
 *   emoji 工具返回的 markdown → 抽出 URL → 真请求那个 URL → 解码回来的 PNG
 *
 * 这样「Agent 发出去的东西浏览器能不能按指定宽度显示」这件事，在重启 App 之前
 * 就已经被证过了，而不是等重启后靠肉眼看。
 *
 * 用法：node test/e2e.mjs
 */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { PNG } = require('pngjs')

const results = []
let failed = 0

/** 记一条断言。 */
function check(label, ok, detail) {
  results.push({ label, ok, detail })
  if (!ok) failed += 1
}

/** 等值断言。 */
function eq(label, actual, expected) {
  const ok = actual === expected
  check(label, ok, ok ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

/** 造一张指定尺寸的纯色 PNG（默认蓝；换色用于区分两套包里的同名图）。 */
function makePng(width, height, rgb = [30, 140, 210]) {
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = rgb[0]
    png.data[i * 4 + 1] = rgb[1]
    png.data[i * 4 + 2] = rgb[2]
    png.data[i * 4 + 3] = 255
  }
  return PNG.sync.write(png)
}

const home = await mkdtemp(join(tmpdir(), 'dsh-emoji-e2e-'))
process.env.DSH_EMOJI_HOME = home

const codec = await import('../lib/imagecodec.js')
const store = await import('../lib/store.js')
const plugin = await import('../lib/index.js')

// ── 造两套包：甲套（开心 512×512 蓝 + 无语 JPEG），乙套（同名 开心 红 + 仅乙有 绿）
// 同名不同色是刻意的——「切包之后取到的是另一套的图」这件事必须能被字节级证伪。
const basePaths = store.pathsOf(store.resolveHome())
await store.ensureLayout(basePaths)
const jpegBytes = (() => {
  const require2 = createRequire(import.meta.url)
  const jpeg = require2('jpeg-js')
  const data = Buffer.alloc(64 * 64 * 4, 200)
  for (let i = 0; i < 64 * 64; i += 1) data[i * 4 + 3] = 255
  return jpeg.encode({ data, width: 64, height: 64 }, 90).data
})()
await store.writePackMeta(basePaths, 'alpha', { name: '甲套' })
await store.importImage(store.packPaths(basePaths, 'alpha'), '开心.png', makePng(512, 512))
await store.importImage(store.packPaths(basePaths, 'alpha'), '无语.jpg', jpegBytes)
await store.writePackMeta(basePaths, 'beta', { name: '乙套' })
await store.importImage(store.packPaths(basePaths, 'beta'), '开心.png', makePng(512, 512, [220, 60, 60]))
await store.importImage(store.packPaths(basePaths, 'beta'), '仅乙有.png', makePng(40, 40, [90, 200, 120]))
await store.setActivePack(basePaths, await store.loadConfig(basePaths), 'alpha')

// ── mock 宿主
const routes = []
const tools = []
const ctx = {
  webServer: {
    host: '127.0.0.1',
    port: 0,
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  tools: {
    register(tool) {
      tools.push(tool)
    },
  },
  effect(fn) {
    const disposer = fn()
    return disposer
  },
  logger: { warn() {} },
}

eq('插件名', plugin.name, 'emoji')
eq('注入服务', (plugin.inject || []).join(','), 'webServer,tools')

plugin.apply(ctx, {})

check('注册了路由', routes.length > 0, `实际 ${routes.length} 条`)
eq('注册了工具数', tools.length, 1)
eq('工具名', tools[0] && tools[0].name, 'emoji')

// ── 把路由挂到真实 HTTP 服务器
const exact = new Map()
for (const route of routes) {
  if (route.kind === 'exact') exact.set(route.path, route.handler)
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const handler = exact.get(url.pathname)
  if (handler === undefined) {
    res.writeHead(404)
    res.end('no route')
    return
  }
  Promise.resolve(handler(req, res)).catch(() => {
    try {
      res.writeHead(500)
      res.end('handler threw')
    } catch {
      /* 头已发出 */
    }
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
ctx.webServer.port = port
const base = `http://127.0.0.1:${port}`

try {
  // ── 1. list 端点
  const listRes = await fetch(`${base}/api/dsh-emoji/list`)
  eq('list HTTP 状态', listRes.status, 200)
  const listJson = await listRes.json()
  eq('list 条目数', listJson.count, 2)
  eq('list 默认宽度档位', (listJson.widths || []).join(','), '20,28,40,150')
  const happy = (listJson.items || []).find((item) => item.name === '开心')
  eq('list 报出 512 宽', happy && happy.width, 512)

  // ── 2. 工具的 list 命令
  const listOut = await tools[0].execute({ command: 'list' })
  check('工具 list 提到条目', typeof listOut === 'string' && listOut.includes('开心'))
  check('工具 list 报出总数', typeof listOut === 'string' && listOut.includes('共 2 个'))

  // ── 3. 工具的 send 命令：拿到可直接粘贴的 markdown
  const sent = await tools[0].execute({ command: 'send', name: '开心' })
  check('send 返回 markdown 图片', typeof sent === 'string' && /^!\[开心\]\(http/.test(sent), sent.split('\n')[0])
  const match = /!\[[^\]]*\]\((http[^)]+)\)/.exec(sent)
  check('send 的 URL 指向本插件路由', match !== null && match[1].includes('/api/dsh-emoji/image'))
  check('send 的 URL 带 w=150', match !== null && /[?&]w=150\b/.test(match[1]))

  // ── 4. 真请求那个 URL，验证返回的图确实被缩到 150 宽
  const imgRes = await fetch(match[1])
  eq('image HTTP 状态', imgRes.status, 200)
  eq('image Content-Type', imgRes.headers.get('content-type'), 'image/png')
  const imgBuf = Buffer.from(await imgRes.arrayBuffer())
  const size150 = codec.readImageSize(imgBuf, 'png')
  eq('返回图宽 = 150', size150 && size150.width, 150)
  eq('返回图高 = 150（原图正方形）', size150 && size150.height, 150)
  check('返回图不是原图（512 字节级差异）', imgBuf.length !== 512)

  // ── 5. 同一张图换宽度：证明「调节大小」真的生效
  const w20 = await fetch(`${base}/api/dsh-emoji/image?name=${encodeURIComponent('开心')}&w=20`)
  const size20 = codec.readImageSize(Buffer.from(await w20.arrayBuffer()), 'png')
  eq('w=20 时返回图宽 = 20', size20 && size20.width, 20)
  const w300 = await fetch(`${base}/api/dsh-emoji/image?name=${encodeURIComponent('开心')}&w=300`)
  const size300 = codec.readImageSize(Buffer.from(await w300.arrayBuffer()), 'png')
  eq('w=300 时返回图宽 = 300', size300 && size300.width, 300)
  check('三档互不相同', size20.width !== size150.width && size150.width !== size300.width)

  // ── 6. 缩放缓存确实落盘：第二次请求应命中缓存且字节一致
  const again = await fetch(match[1])
  const againBuf = Buffer.from(await again.arrayBuffer())
  check('二次请求字节一致（命中缓存）', Buffer.compare(againBuf, imgBuf) === 0)

  // ── 7. JPEG 源直出不报错
  const jpgRes = await fetch(`${base}/api/dsh-emoji/raw?name=${encodeURIComponent('无语')}`)
  eq('raw JPEG 状态', jpgRes.status, 200)
  eq('raw JPEG 类型', jpgRes.headers.get('content-type'), 'image/jpeg')

  // ── 8. 参数校验与 404
  const badW = await fetch(`${base}/api/dsh-emoji/image?name=${encodeURIComponent('开心')}&w=99999`)
  eq('超范围 w 返回 400', badW.status, 400)
  const missing = await fetch(`${base}/api/dsh-emoji/image?name=${encodeURIComponent('不存在')}`)
  eq('不存在的名字返回 404', missing.status, 404)
  const traversal = await fetch(`${base}/api/dsh-emoji/image?name=${encodeURIComponent('../../config.env')}`)
  eq('路径穿越被拒（404）', traversal.status, 404)

  // ── 9. 信任围栏分两档：读端点放行 cross-site（GUI 的 <img> 从 localhost 页面
  //     请求 127.0.0.1 必然 cross-site，上一版在此 403，正是「图片无法预览」的根因），
  //     写端点仍三重严格
  const crossSiteRead = await fetch(`${base}/api/dsh-emoji/list`, { headers: { 'sec-fetch-site': 'cross-site' } })
  eq('读端点 cross-site 放行 200', crossSiteRead.status, 200)
  const crossSiteImage = await fetch(`${base}/api/dsh-emoji/image?name=${encodeURIComponent('开心')}&w=150`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  })
  eq('出图端点 cross-site 放行 200', crossSiteImage.status, 200)
  const crossSiteWrite = await fetch(`${base}/api/dsh-emoji/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ name: '开心' }),
  })
  eq('写端点 cross-site 被拒 403', crossSiteWrite.status, 403)
  const foreignOriginWrite = await fetch(`${base}/api/dsh-emoji/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ name: '开心' }),
  })
  eq('写端点异源 Origin 被拒 403', foreignOriginWrite.status, 403)
  const sameOriginWrite = await fetch(`${base}/api/dsh-emoji/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ widths: [20, 28, 40, 150] }),
  })
  eq('写端点同源 Origin 放行 200', sameOriginWrite.status, 200)

  // ── 9b. diag 端点回放刚才的拒绝：围栏若再误伤，不必重启靠猜
  const diagRes = await fetch(`${base}/api/dsh-emoji/diag`)
  const diagJson = await diagRes.json()
  const rejections = diagJson.rejections || []
  check('diag 记录了两条写端点拒绝', rejections.length >= 2, `实际 ${rejections.length}`)
  check(
    'diag 记录含被拒请求的判据头',
    rejections[0] !== undefined &&
      (rejections[0].headers.origin === 'http://evil.example' || rejections[0].headers.secFetchSite === 'cross-site'),
    JSON.stringify(rejections[0] && rejections[0].headers),
  )

  // ── 10. 写路由：方法守卫与删除
  const wrongMethod = await fetch(`${base}/api/dsh-emoji/delete`, { method: 'GET' })
  eq('写路由 GET 返回 405', wrongMethod.status, 405)
  const delRes = await fetch(`${base}/api/dsh-emoji/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '开心' }),
  })
  eq('删除 HTTP 状态', delRes.status, 200)
  const delJson = await delRes.json()
  eq('删除后剩 1 条', delJson.count, 1)
  const afterDelete = await fetch(`${base}/api/dsh-emoji/list`)
  eq('删除后 list 只剩 1 条', (await afterDelete.json()).count, 1)

  // ── 11. 导入端点：base64 进、图进库
  const importRes = await fetch(`${base}/api/dsh-emoji/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: [{ name: '新表情.png', dataBase64: makePng(80, 40).toString('base64') }] }),
  })
  eq('导入 HTTP 状态', importRes.status, 200)
  const importJson = await importRes.json()
  eq('导入成功数', (importJson.imported || []).length, 1)
  eq('导入后总数', importJson.count, 2)

  // 拒绝非图片内容——前端把裸文本当图片传来时必须被挡住
  const badImport = await fetch(`${base}/api/dsh-emoji/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: [{ name: '假的.png', dataBase64: Buffer.from('not an image').toString('base64') }] }),
  })
  const badJson = await badImport.json()
  eq('伪图被拒（imported 为空）', (badJson.imported || []).length, 0)
  check('伪图被拒并给出原因', (badJson.errors || []).length === 1)

  // ── 12. 配置端点：宽度档位持久化
  const cfgRes = await fetch(`${base}/api/dsh-emoji/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ widths: [20, 28, 40, 150, 240], scanDirs: [] }),
  })
  eq('配置 HTTP 状态', cfgRes.status, 200)
  const cfgJson = await cfgRes.json()
  eq('配置回读档位数', (cfgJson.widths || []).length, 5)
  const badCfg = await fetch(`${base}/api/dsh-emoji/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ widths: [1, 2] }),
  })
  eq('非法档位全被过滤时返回 400', badCfg.status, 400)

  // ── 13. random 命令张数
  const rand = await tools[0].execute({ command: 'random', count: 2 })
  const randCount = (rand.match(/!\[/g) || []).length
  eq('random count=2 出 2 张', randCount, 2)

  // ── 14. search 命令
  const searchOut = await tools[0].execute({ command: 'search', query: '新' })
  check('search 命中新表情', typeof searchOut === 'string' && searchOut.includes('新表情'))
  const searchMiss = await tools[0].execute({ command: 'search', query: 'zzz不存在' })
  check('search 未命中给提示', typeof searchMiss === 'string' && searchMiss.includes('没有名字包含'))

  // ── 15. 多套包：列表 / 切换 / 同名不同图 / 独有名字随包来去
  // 第 10 节把甲套的「开心」删掉了，这里补回来，好让两套有真正的同名图可比
  await fetch(`${base}/api/dsh-emoji/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: [{ name: '开心.png', dataBase64: makePng(512, 512).toString('base64') }] }),
  })

  const packsRes = await fetch(`${base}/api/dsh-emoji/packs`)
  eq('packs HTTP 状态', packsRes.status, 200)
  const packsJson = await packsRes.json()
  eq('packs 报出两套', packsJson.count, 2)
  eq('packs 标出当前生效的套', packsJson.activePack, 'alpha')
  eq(
    '包列表带显示名 / 张数 / active 标记',
    (packsJson.packs || []).map((p) => `${p.id}:${p.name}:${p.count}:${p.active}`).join(','),
    'alpha:甲套:3:true,beta:乙套:2:false',
  )

  const alphaRes = await fetch(`${base}/api/dsh-emoji/image?name=${encodeURIComponent('开心')}&w=150`)
  const alphaBuf = Buffer.from(await alphaRes.arrayBuffer())
  const alphaPixel = codec.decode(alphaBuf, 'png')
  check('甲套的同名图是蓝的', alphaPixel !== undefined && alphaPixel.data[0] === 30 && alphaPixel.data[1] === 140)

  const beforeJson = await (await fetch(`${base}/api/dsh-emoji/list`)).json()
  check('切换前 list 里有甲套独有的「无语」', (beforeJson.items || []).some((item) => item.name === '无语'))

  const switchRes = await fetch(`${base}/api/dsh-emoji/pack-switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'beta' }),
  })
  eq('pack-switch HTTP 状态', switchRes.status, 200)
  const switchJson = await switchRes.json()
  eq('切换回执报出新套', switchJson.activePack, 'beta')
  eq('切换回执带新套的清单', switchJson.count, 2)
  check('新套里没有甲套独有的「无语」', !(switchJson.items || []).some((item) => item.name === '无语'))
  check('新套里有乙套独有的「仅乙有」', (switchJson.items || []).some((item) => item.name === '仅乙有'))
  eq(
    '回执把 active 标记也换了',
    (switchJson.packs || []).filter((p) => p.active).map((p) => p.id).join(','),
    'beta',
  )

  const betaRes = await fetch(`${base}/api/dsh-emoji/image?name=${encodeURIComponent('开心')}&w=150`)
  const betaBuf = Buffer.from(await betaRes.arrayBuffer())
  const betaPixel = codec.decode(betaBuf, 'png')
  check('乙套的同名图是红的（切包真的换了图）', betaPixel !== undefined && betaPixel.data[0] === 220 && betaPixel.data[1] === 60)
  check('两套同名图字节不同', Buffer.compare(alphaBuf, betaBuf) !== 0)

  const goneRes = await fetch(`${base}/api/dsh-emoji/image?name=${encodeURIComponent('无语')}`)
  eq('切走后甲套独有的图 404', goneRes.status, 404)

  // 工具的 packs / use 与 HTTP 侧同源
  const packsOut = await tools[0].execute({ command: 'packs' })
  check('工具 packs 报出两套', typeof packsOut === 'string' && packsOut.includes('甲套') && packsOut.includes('乙套'))
  check('工具 packs 标出当前生效的套', typeof packsOut === 'string' && /\*\s*beta/.test(packsOut))
  const useOut = await tools[0].execute({ command: 'use', pack: 'alpha' })
  check('工具 use 切回甲套', typeof useOut === 'string' && useOut.includes('甲套'))
  const useBad = await tools[0].execute({ command: 'use', pack: '没有这套' })
  check('工具 use 拒绝不存在的套', typeof useBad === 'string' && useBad.includes('没有这一套'))
  const healthJson = await (await fetch(`${base}/api/dsh-emoji/health`)).json()
  eq('health 报出当前生效的套', healthJson.activePack, 'alpha')

  // 新路由同样受写围栏保护，参数校验也不放水
  const crossSiteSwitch = await fetch(`${base}/api/dsh-emoji/pack-switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ id: 'beta' }),
  })
  eq('pack-switch 的 cross-site 被拒 403', crossSiteSwitch.status, 403)
  const badSwitch = await fetch(`${base}/api/dsh-emoji/pack-switch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '没有这套' }),
  })
  eq('切到不存在的套返回 404', badSwitch.status, 404)
} finally {
  await new Promise((resolve) => server.close(resolve))
  await rm(home, { recursive: true, force: true })
}

for (const item of results) {
  const mark = item.ok ? '  ok  ' : ' FAIL '
  console.log(`[${mark}] ${item.label}${item.detail ? ' — ' + item.detail : ''}`)
}
console.log('')
console.log(`端到端自检 ${results.length - failed}/${results.length} 通过`)
if (failed > 0) {
  console.error(`失败 ${failed} 项`)
  process.exit(1)
}
