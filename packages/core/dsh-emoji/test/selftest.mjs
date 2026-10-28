/**
 * dsh-emoji · 宿主侧自检。
 *
 * 不依赖 DSH 进程：编解码、缩放、库落盘、路径穿越防护都能独立验证。
 * 库根指向临时目录（DSH_EMOJI_HOME），跑完即删——绝不碰主人的真实库。
 *
 * 用法：node test/selftest.mjs
 */
import { mkdir, mkdtemp, rm, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { PNG } = require('pngjs')
const jpeg = require('jpeg-js')

const results = []
let failed = 0

/** 记一条断言结果。 */
function check(label, ok, detail) {
  results.push({ label, ok, detail })
  if (!ok) failed += 1
}

/** 等值比较并给出可读差异。 */
function eq(label, actual, expected) {
  const ok = actual === expected
  check(label, ok, ok ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

/** 造一张纯色 PNG。 */
function makePng(width, height, rgba = [90, 160, 220, 255]) {
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = rgba[0]
    png.data[i * 4 + 1] = rgba[1]
    png.data[i * 4 + 2] = rgba[2]
    png.data[i * 4 + 3] = rgba[3]
  }
  return PNG.sync.write(png)
}

/** 造一张纯色 JPEG。 */
function makeJpeg(width, height, rgb = [200, 120, 60]) {
  const data = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgb[0]
    data[i * 4 + 1] = rgb[1]
    data[i * 4 + 2] = rgb[2]
    data[i * 4 + 3] = 255
  }
  return jpeg.encode({ data, width, height }, 90).data
}

const home = await mkdtemp(join(tmpdir(), 'dsh-emoji-selftest-'))
process.env.DSH_EMOJI_HOME = home

const codec = await import('../lib/imagecodec.js')
const store = await import('../lib/store.js')
const basePaths = store.pathsOf(store.resolveHome())

const png64 = makePng(64, 48)
const jpg64 = makeJpeg(64, 48)

// ── 1. 文件头取尺寸（不解码像素）
const pngSize = codec.readImageSize(png64, 'png')
eq('readImageSize(PNG).width', pngSize && pngSize.width, 64)
eq('readImageSize(PNG).height', pngSize && pngSize.height, 48)
const jpgSize = codec.readImageSize(jpg64, 'jpeg')
eq('readImageSize(JPEG).width', jpgSize && jpgSize.width, 64)
eq('readImageSize(JPEG).height', jpgSize && jpgSize.height, 48)
eq('readImageSize(垃圾字节)', codec.readImageSize(Buffer.from('not an image at all'), 'png'), undefined)
eq('formatOf(.PNG 大写应归一为小写)', codec.formatOf('A.PNG'), 'png')
eq('formatOf(无扩展名)', codec.formatOf('noext'), undefined)
eq('formatOf(.png)', codec.formatOf('a.png'), 'png')
eq('formatOf(.jpeg)', codec.formatOf('a.jpeg'), 'jpeg')
eq('isDecodable(png)', codec.isDecodable('png'), true)
eq('isDecodable(gif)', codec.isDecodable('gif'), false)

// ── 2. 缩放：比例保持、目标宽精确
const shrunk = codec.resizeToWidth(png64, 'png', 20)
eq('缩小后宽 = 20', shrunk && shrunk.width, 20)
eq('缩小后高 = 15（48*20/64）', shrunk && shrunk.height, 15)
const grew = codec.resizeToWidth(png64, 'png', 128)
eq('放大后宽 = 128', grew && grew.width, 128)
eq('放大后高 = 96', grew && grew.height, 96)
const same = codec.resizeToWidth(png64, 'png', 64)
eq('同宽时原样返回', same && same.width, 64)
check('同宽时返回的是同一个 buffer', same && Buffer.compare(same.buffer, png64) === 0)

// 缩放结果必须能被重新解码，且尺寸一致——只比对数字不算验过。
const redecoded = codec.decode(shrunk.buffer, 'png')
eq('缩放产物可解码且宽一致', redecoded && redecoded.width, 20)
eq('缩放产物可解码且高一致', redecoded && redecoded.height, 15)

// 纯色图缩放后颜色不该漂移（面积平均对恒定色应保持原值）。
const probe = codec.decode(shrunk.buffer, 'png')
check(
  '纯色缩放后颜色保持',
  probe !== undefined && probe.data[0] === 90 && probe.data[1] === 160 && probe.data[2] === 220,
  probe === undefined ? '无法解码' : `实际 rgba(${probe.data[0]},${probe.data[1]},${probe.data[2]},${probe.data[3]})`,
)

// JPEG 源应继续输出 JPEG：转 PNG 会让照片型表情包体积翻数倍。
const jpgShrunk = codec.resizeToWidth(jpg64, 'jpeg', 32)
eq('JPEG 缩小后宽 = 32', jpgShrunk && jpgShrunk.width, 32)
eq('JPEG 保持 jpeg 格式', jpgShrunk && jpgShrunk.format, 'jpeg')
check('JPEG 产物可解码', codec.decode(jpgShrunk.buffer, 'jpeg') !== undefined)

// ── 3. 路径穿越防护
eq('resolveImage(../../etc/passwd)', store.resolveImage(basePaths, '../../etc/passwd'), null)
eq('resolveImage(..)', store.resolveImage(basePaths, '..'), null)
eq('resolveImage(空)', store.resolveImage(basePaths, ''), null)
eq('resolveImage(含反斜杠)', store.resolveImage(basePaths, 'a\\b'), null)
eq('normalizeName(带目录)', store.normalizeName('C:/x/y/开心.png'), '开心')
eq('normalizeName(去掉扩展名)', store.normalizeName('开心.png'), '开心')

// ── 4. 导入与列表
await store.ensureLayout(basePaths)
const initial = await store.resolveLibrary(basePaths, { widths: [], scanDirs: [], activePack: '' })
eq('空库会先落一套包', initial.packs.length, 1)
check('当前套的目录落在 packs/ 下', initial.paths.images.includes('packs'))
// 以下所有落盘断言都跑在这套包里；库根级的 config 与 .trash 仍由 paths 上的同名字段指向
let paths = initial.paths

const first = await store.importImage(paths, '开心.png', png64)
eq('导入后的名字', first.name, '开心')
eq('导入后的宽', first.width, 64)
eq('导入后的高', first.height, 48)
eq('导入后的格式', first.format, 'png')

const second = await store.importImage(paths, '开心.png', png64)
eq('重名导入自动改名', second.file, '开心-2.png')

const jpgEntry = await store.importImage(paths, 'photo.jpg', jpg64)
eq('JPEG 导入格式', jpgEntry.format, 'jpeg')

const items = await store.listEmoji(paths)
eq('列表条目数', items.length, 3)
const happy = items.find((item) => item.name === '开心')
eq('列表里的宽', happy && happy.width, 64)
eq('列表标记可缩放', happy && happy.scalable, true)
const photo = items.find((item) => item.name === 'photo')
eq('JPEG 在列表中的格式', photo && photo.format, 'jpeg')

// 库目录里只该有图片，不该混入临时文件。
const rawFiles = await readdir(paths.images)
eq('images/ 内文件数', rawFiles.length, 3)

// ── 5. 非法内容必须被拒收，而不是入库成坏图
let rejected = false
try {
  await store.importImage(paths, 'fake.png', Buffer.from('definitely not a png, but named as one'))
} catch {
  rejected = true
}
check('伪装扩展名的文件被拒收', rejected)
let rejectedExt = false
try {
  await store.importImage(paths, 'note.txt', Buffer.from('hello'))
} catch {
  rejectedExt = true
}
check('不支持的扩展名被拒收', rejectedExt)

// ── 6. 缓存读写与清空
await store.writeCache(paths, '开心@20.png', shrunk.buffer)
const cached = await store.readCache(paths, '开心@20.png')
check('缓存可读回且字节一致', cached !== undefined && Buffer.compare(cached, shrunk.buffer) === 0)
eq('清空缓存删除数', await store.clearCache(paths), 1)
eq('清空后缓存为空', await store.readCache(paths, '开心@20.png'), undefined)
eq('清缓存不动原图', (await store.listEmoji(paths)).length, 3)

// ── 7. 配置持久化
await store.saveConfig(paths, { widths: [16, 512], scanDirs: ['C:\\pics'] })
const cfg = await store.loadConfig(paths)
eq('配置回读宽度数', cfg.widths.length, 2)
eq('配置回读宽度排序', cfg.widths.join(','), '16,512')
eq('配置回读扫描目录', cfg.scanDirs[0], 'C:\\pics')
await store.saveConfig(paths, { widths: [], scanDirs: [] })
eq('空宽度回落默认档位', (await store.loadConfig(paths)).widths.join(','), '20,28,40,150')

// ── 8. 删除走回收站，且原图真的消失
const movedTo = await store.trashEmoji(paths, '开心')
check('删除后进入 .trash', String(movedTo).includes('.trash'))
check('删除后回收站文件存在', existsSync(movedTo))
eq('删除后列表少一条', (await store.listEmoji(paths)).length, 2)
let deleteMissing = false
try {
  await store.trashEmoji(paths, '开心')
} catch {
  deleteMissing = true
}
check('删除不存在的条目会报错', deleteMissing)

// ── 9. 多套包：id 校验、切换指针、缓存隔离、旧布局收编
eq('isPackId(普通 id)', store.isPackId('deepseek'), true)
eq('isPackId(点开头)', store.isPackId('.hidden'), false)
eq('isPackId(带斜杠)', store.isPackId('a/b'), false)
eq('isPackId(含反斜杠)', store.isPackId('a\\b'), false)
eq('isPackId(含空格)', store.isPackId('a b'), false)
eq('isPackId(上级目录)', store.isPackId('../x'), false)
eq('isPackId(空)', store.isPackId(''), false)

const packB = store.packPaths(basePaths, 'second')
await store.writePackMeta(basePaths, 'second', { name: '第二套' })
await store.importImage(packB, '开心.png', png64)

const packsNow = await store.listPacks(basePaths)
eq('两套包都被列出来', packsNow.length, 2)
const packBMeta = packsNow.find((pack) => pack.id === 'second')
eq('包显示名来自 pack.json', packBMeta && packBMeta.name, '第二套')
eq('包张数只数图', packBMeta && packBMeta.count, 1)

// 同名同宽的两套各存各的缓存：一旦串味，这里会读回另一套的字节
await store.writeCache(initial.paths, '隔离@20.png', Buffer.from('第一套'))
await store.writeCache(packB, '隔离@20.png', Buffer.from('第二套'))
eq('缓存按包隔离（第一套）', String(await store.readCache(initial.paths, '隔离@20.png')), '第一套')
eq('缓存按包隔离（第二套）', String(await store.readCache(packB, '隔离@20.png')), '第二套')

// 切包只写指针，不动图片
const cfgBefore = await store.loadConfig(basePaths)
await store.setActivePack(basePaths, cfgBefore, 'second')
eq('切包后 activePack 落盘', (await store.loadConfig(basePaths)).activePack, 'second')
const resolved = await store.resolveLibrary(basePaths, await store.loadConfig(basePaths))
eq('切包后解析到第二套', resolved.activeId, 'second')
eq('解析出的库目录就是那套的 images', resolved.paths.images, packB.images)
check(
  '切包没有搬动任何文件',
  existsSync(join(packB.images, '开心.png')) && existsSync(join(initial.paths.images, 'photo.jpg')),
)
let missingPack = false
try {
  await store.setActivePack(basePaths, cfgBefore, '没有这套')
} catch {
  missingPack = true
}
check('切到不存在的套会报错', missingPack)

// 旧单库布局：库根直接一个 images/，首次解析就地收编成一套
const legacyHome = await mkdtemp(join(tmpdir(), 'dsh-emoji-legacy-'))
const legacyPaths = store.pathsOf(legacyHome)
await store.ensureLayout(legacyPaths)
await mkdir(legacyPaths.images, { recursive: true })
await writeFile(join(legacyPaths.images, '旧图.png'), png64)
const adopted = await store.resolveLibrary(legacyPaths, { widths: [], scanDirs: [], activePack: '' })
eq('旧布局被收编成一套', adopted.packs.length, 1)
eq('收编后的张数', adopted.packs[0] && adopted.packs[0].count, 1)
check('旧图已搬进 packs/ 下', existsSync(join(adopted.paths.images, '旧图.png')))
check('旧 images/ 里已不再有那张图', !existsSync(join(legacyPaths.images, '旧图.png')))
await rm(legacyHome, { recursive: true, force: true })

// ── 汇总
await rm(home, { recursive: true, force: true })

for (const item of results) {
  const mark = item.ok ? '  ok  ' : ' FAIL '
  console.log(`[${mark}] ${item.label}${item.detail ? ' — ' + item.detail : ''}`)
}
console.log('')
console.log(`自检 ${results.length - failed}/${results.length} 通过`)
if (failed > 0) {
  console.error(`失败 ${failed} 项`)
  process.exit(1)
}
