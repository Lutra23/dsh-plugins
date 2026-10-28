/**
 * 表情包库落盘层。
 *
 * 目录布局（库根默认 ~/.dsh/emoji，可用 DSH_EMOJI_HOME 覆盖）：
 *   packs/<包 id>/images/     一套表情包的原图，唯一真源；删了这个才是真丢
 *   packs/<包 id>/pack.json   那套包的元信息（显示名、建立时间）
 *   cache/<包 id>/<name>@<w>  缩放产物，纯派生，可随时整目录清空重建
 *   .trash/                   删除落地处，可人工捞回
 *   emoji.config.json         宽度档位、扫描目录与当前生效的包（activePack）
 *
 * 三条边界是有意的：cache 与 images 分开，主人的原图任何时候都不该被缩放
 * 逻辑覆盖或清理；images 按包分，切包只改一个指针、不动任何字节，因此
 * **缓存也必须按包分命名空间**——两套包常有同名的图，共用缓存必然串味。
 *
 * 旧的单库布局（库根直接一个 images/）仍能读：packs/ 为空且库根有图时会被
 * 就地收编成 packs/<activePack 或 default>，此后一律走多包布局。
 */
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, resolve, sep } from 'node:path'
import { formatOf, isDecodable, readImageSize } from './imagecodec.js'

/** 默认宽度档位，与参考界面一致（20/28/40/150）。 */
export const DEFAULT_WIDTHS = [20, 28, 40, 150]

/** 单张导入图上限 24 MiB。 */
export const MAX_IMAGE_BYTES = 24 * 1024 * 1024

/** 解析库根。 */
export function resolveHome(config) {
  const configured = config && typeof config.home === 'string' && config.home.trim() !== ''
  if (configured) return resolve(config.home)
  const fromEnv = process.env.DSH_EMOJI_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh', 'emoji')
}

/** 库的面板：各子路径一次性算好，后续调用只传这个对象。 */
export function pathsOf(home) {
  return {
    home,
    packs: join(home, 'packs'),
    images: join(home, 'images'), // 旧单库布局的位置；被收编进 packs/ 后不再使用
    cache: join(home, 'cache'),
    trash: join(home, '.trash'),
    config: join(home, 'emoji.config.json'),
  }
}

/** 确保库骨架存在。各套包自己的目录由它按需创建。 */
export async function ensureLayout(paths) {
  await mkdir(paths.packs, { recursive: true })
  await mkdir(paths.cache, { recursive: true })
  await mkdir(paths.trash, { recursive: true })
  // 面板落在具体某一套上时，那套的 images/ 也要就位——新建的套靠这一句才能收下第一张图
  if (typeof paths.pack === 'string' && paths.pack !== '') await mkdir(paths.images, { recursive: true })
}

/**
 * 包 id 是否是安全的一段路径。
 * 它同时是目录名与缓存路径的一段，所以只认「无分隔符、无空白、无控制字符、
 * 不以点开头」的短标识；中文与空格属于显示名（pack.json 的 name），不在这里。
 */
export function isPackId(value) {
  const id = String(value ?? '').trim()
  if (id === '' || id === '.' || id === '..' || id.length > 48) return false
  if (id.startsWith('.')) return false
  if (id.includes(':')) return false // Windows 盘符 / 数据流写法
  if (/\s/.test(id)) return false
  return !hasForbiddenNameChar(id)
}

/** 一套包的路径面板：images 与 cache 都按包分。 */
export function packPaths(paths, packId) {
  return {
    ...paths,
    pack: packId,
    images: join(paths.packs, packId, 'images'),
    cache: join(paths.cache, packId),
  }
}

/** 一套包的元信息文件位置。 */
function packMetaFile(paths, packId) {
  return join(paths.packs, packId, 'pack.json')
}

/** 读包元信息；缺文件或损坏时以目录名当显示名——元信息坏不该让整套包不可用。 */
export async function readPackMeta(paths, packId) {
  try {
    const parsed = JSON.parse(await readFile(packMetaFile(paths, packId), 'utf8'))
    const name = typeof parsed.name === 'string' && parsed.name.trim() !== '' ? parsed.name.trim() : packId
    return { id: packId, name, createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : null }
  } catch {
    return { id: packId, name: packId, createdAt: null }
  }
}

/** 写包元信息（同样走临时名 + 改名，避免半截 JSON）。 */
export async function writePackMeta(paths, packId, meta) {
  if (!isPackId(packId)) throw new Error(`非法的包 id：${packId}`)
  await mkdir(join(paths.packs, packId), { recursive: true })
  const file = packMetaFile(paths, packId)
  const tmp = `${file}.${Date.now().toString(36)}.tmp`
  const payload = JSON.stringify(
    {
      id: packId,
      name: typeof meta?.name === 'string' && meta.name.trim() !== '' ? meta.name.trim() : packId,
      createdAt: typeof meta?.createdAt === 'string' ? meta.createdAt : new Date().toISOString(),
    },
    null,
    2,
  )
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, file)
}

/**
 * 只数张数，不读文件头。
 * 切包器要显示「每套多少张」，但不需要每张图的尺寸——为它开几百次文件不值。
 */
async function countImages(imagesDir) {
  try {
    const entries = await readdir(imagesDir, { withFileTypes: true })
    let total = 0
    for (const entry of entries) {
      if (entry.isFile() && formatOf(entry.name) !== undefined) total += 1
    }
    return total
  } catch {
    return 0
  }
}

/**
 * 扫 packs/ 下所有套。
 * @returns [{id, name, createdAt, count, images}]，按 id 排序；没有 packs/ 时返回空数组。
 */
export async function listPacks(paths) {
  let entries
  try {
    entries = await readdir(paths.packs, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !isPackId(entry.name)) continue
    const pack = packPaths(paths, entry.name)
    const meta = await readPackMeta(paths, entry.name)
    out.push({ ...meta, count: await countImages(pack.images), images: pack.images })
  }
  out.sort((a, b) => a.id.localeCompare(b.id, 'zh-Hans-CN'))
  return out
}

/**
 * 保证至少有一套包：packs/ 为空时把旧单库布局的 images/ 就地收编成一套，
 * 一张图都没有就建一套空的。收编走 rename（同盘原子），只搬图片，别的一概不动。
 * @returns {id, name, moved}，或 null（已经有包了，什么都没做）。
 */
export async function ensureDefaultPack(paths, config) {
  const existing = await listPacks(paths)
  if (existing.length > 0) return null
  const wanted = isPackId(config?.activePack) ? String(config.activePack).trim() : 'default'
  const name = wanted === 'default' ? '默认库' : wanted
  const pack = packPaths(paths, wanted)
  await mkdir(pack.images, { recursive: true })
  let entries = []
  try {
    entries = await readdir(paths.images, { withFileTypes: true })
  } catch {
    entries = []
  }
  let moved = 0
  for (const entry of entries) {
    if (!entry.isFile() || formatOf(entry.name) === undefined) continue
    const target = join(pack.images, entry.name)
    if (existsSync(target)) continue
    await rename(join(paths.images, entry.name), target)
    moved += 1
  }
  await writePackMeta(paths, wanted, { name })
  return { id: wanted, name, moved }
}

/**
 * 解析当前生效的库。
 * activePack 指向哪套就用哪套；指针缺失或指向不存在的套时退回第一套。
 * 旧的单库布局在这里被就地收编，之后所有调用方拿到的都是多包布局的面板。
 * @returns {paths, activeId, activeName, packs, created}
 */
export async function resolveLibrary(paths, config) {
  let packs = await listPacks(paths)
  let created = null
  if (packs.length === 0) {
    created = await ensureDefaultPack(paths, config)
    packs = await listPacks(paths)
  }
  const wanted = isPackId(config?.activePack) ? String(config.activePack).trim() : ''
  const active = packs.find((pack) => pack.id === wanted) ?? packs[0] ?? null
  return {
    paths: active === null ? { ...paths, pack: null } : packPaths(paths, active.id),
    activeId: active === null ? null : active.id,
    activeName: active === null ? null : active.name,
    packs,
    created,
  }
}

/**
 * 切到某一套。
 * 切换只是写一个指针，不动任何图片字节：两套各自躺在 packs/<id>/ 里、
 * 缓存也各有一份，来回切因此是零代价的（不必复制、不必重建）。
 */
export async function setActivePack(paths, config, packId) {
  const packs = await listPacks(paths)
  const target = packs.find((pack) => pack.id === packId)
  if (target === undefined) throw new Error(`没有这一套表情包：${packId}`)
  await saveConfig(paths, { ...config, activePack: target.id })
  return target
}

/** 读配置，缺失或损坏时回落到默认档位。 */
export async function loadConfig(paths) {
  const fallback = { widths: [...DEFAULT_WIDTHS], scanDirs: [], activePack: '' }
  try {
    const raw = await readFile(paths.config, 'utf8')
    const parsed = JSON.parse(raw)
    const widths = Array.isArray(parsed.widths)
      ? parsed.widths
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n >= 4 && n <= 2048)
          .map((n) => Math.round(n))
      : []
    const scanDirs = Array.isArray(parsed.scanDirs)
      ? parsed.scanDirs.filter((d) => typeof d === 'string' && d.trim() !== '')
      : []
    return {
      widths: widths.length > 0 ? [...new Set(widths)].sort((a, b) => a - b) : [...DEFAULT_WIDTHS],
      scanDirs,
      activePack: isPackId(parsed.activePack) ? String(parsed.activePack).trim() : '',
    }
  } catch {
    return fallback
  }
}

/** 写配置（原子替换：先写临时名再改名，避免半截 JSON）。 */
export async function saveConfig(paths, config) {
  const active = isPackId(config.activePack) ? String(config.activePack).trim() : ''
  const payload = JSON.stringify(
    {
      widths: Array.isArray(config.widths) && config.widths.length > 0 ? config.widths : [...DEFAULT_WIDTHS],
      scanDirs: Array.isArray(config.scanDirs) ? config.scanDirs : [],
      // activePack 没设置就别在文件里留一个空键，免得人手看配置时误判
      ...(active === '' ? {} : { activePack: active }),
    },
    null,
    2,
  )
  const tmp = `${paths.config}.${Date.now().toString(36)}.tmp`
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, paths.config)
}

/**
 * 名字规范化：去掉目录成分与扩展名，只留基名。
 * 一切来自外部的名字都要过这里，它是防穿越的第一道。
 */
export function normalizeName(input) {
  const raw = String(input ?? '').trim()
  if (raw === '') return ''
  const base = basename(raw.replaceAll('\\', '/'))
  const noExt = base.replace(/\.[^.]+$/, '')
  return noExt.trim()
}

/**
 * 名字里是否出现控制字符或路径分隔符。
 * 不用正则表达控制字符范围（no-control-regex 会拦），逐码位判定等价且更直白。
 */
function hasForbiddenNameChar(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
    const ch = value[i]
    if (ch === '/' || ch === '\\') return true
  }
  return false
}

/**
 * 把名字解析为库内 images/ 的绝对路径，并验证确实落在库内。
 * @returns 绝对路径，或 null（非法名字）。
 */
export function resolveImage(paths, name) {
  const clean = normalizeName(name)
  if (clean === '' || clean === '.' || clean === '..') return null
  if (hasForbiddenNameChar(clean)) return null
  const imagesRoot = resolve(paths.images)
  for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']) {
    const candidate = resolve(imagesRoot, clean + ext)
    // 前缀校验兜底：即使上面的字符过滤被绕过，也不许逃出 images/。
    if (candidate !== imagesRoot && !candidate.startsWith(imagesRoot + sep)) return null
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** 找一个尚未占用的文件名，重名时补 -2 / -3 …。 */
async function freeName(paths, name, ext) {
  const imagesRoot = resolve(paths.images)
  for (let i = 1; i < 1000; i += 1) {
    const candidate = i === 1 ? `${name}${ext}` : `${name}-${i}${ext}`
    if (!existsSync(resolve(imagesRoot, candidate))) return candidate
  }
  throw new Error(`名字 ${name} 的重名副本过多`)
}

/**
 * 导入一张图片。
 * @param paths - 库路径面板。
 * @param fileName - 源文件名（用于推格式与默认名）。
 * @param buffer - 原始字节。
 * @param options - name 指定名字，onConflict 为 "rename"（默认）或 "overwrite"。
 * @returns 入库的条目。
 */
export async function importImage(paths, fileName, buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('导入内容为空')
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`单张图片不得超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB`)
  }
  const format = formatOf(fileName)
  if (format === undefined) throw new Error(`不支持的图片格式：${extname(fileName) || '(无扩展名)'}`)
  const size = readImageSize(buffer, format)
  if (size === undefined) {
    // 头部读不出宽高：文件要么损坏，要么是伪装的扩展名。拒收而非入库。
    throw new Error(`不是有效的 ${format.toUpperCase()} 图片（无法读取尺寸）`)
  }

  await ensureLayout(paths)
  const requested = normalizeName(options.name ?? fileName)
  const name = requested === '' ? 'emoji' : requested
  const ext = extname(fileName).toLowerCase()
  const imagesRoot = resolve(paths.images)

  let targetName
  if (options.onConflict === 'overwrite') {
    const existing = resolveImage(paths, name)
    if (existing !== null) await unlink(existing)
    targetName = name + ext
  } else {
    targetName = await freeName(paths, name, ext)
  }

  const target = resolve(imagesRoot, targetName)
  if (!target.startsWith(imagesRoot + sep)) throw new Error('目标路径越出库范围')
  await writeFile(target, buffer)

  return {
    name: normalizeName(targetName),
    file: targetName,
    format,
    bytes: buffer.length,
    width: size.width,
    height: size.height,
  }
}

/**
 * 扫描库内全部表情包，附带尺寸与体积。
 * @param paths - 库路径面板。
 * @returns 条目数组，按名字排序。
 */
export async function listEmoji(paths) {
  let entries
  try {
    entries = await readdir(paths.images, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const format = formatOf(entry.name)
    if (format === undefined) continue
    const abs = join(paths.images, entry.name)
    let info
    try {
      info = await stat(abs)
    } catch {
      continue
    }
    let size
    try {
      // 只读头部字节即可拿到宽高，不整文件载入。
      const handle = await open(abs, 'r')
      try {
        const head = Buffer.alloc(Math.min(65536, info.size))
        await handle.read(head, 0, head.length, 0)
        size = readImageSize(head, format)
      } finally {
        await handle.close()
      }
    } catch {
      size = undefined
    }
    out.push({
      name: normalizeName(entry.name),
      file: entry.name,
      format,
      bytes: info.size,
      mtime: info.mtimeMs,
      width: size ? size.width : null,
      height: size ? size.height : null,
      scalable: isDecodable(format),
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  return out
}

/** 把一个表情包移入 .trash（可恢复删除，不 unlink）。 */
export async function trashEmoji(paths, name) {
  const target = resolveImage(paths, name)
  if (target === null) throw new Error(`表情包不存在：${name}`)
  await mkdir(paths.trash, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(paths.trash, `${stamp}-${basename(target)}`)
  await rename(target, dest)
  return dest
}

/** 清空缩放缓存目录（只动 cache/，永不碰 images/）。 */
export async function clearCache(paths) {
  let removed = 0
  try {
    const entries = await readdir(paths.cache, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      try {
        await unlink(join(paths.cache, entry.name))
        removed += 1
      } catch {
        /* 单个文件删不掉不影响其余 */
      }
    }
  } catch {
    return 0
  }
  return removed
}

/** 读缓存文件字节。 */
export async function readCache(paths, key) {
  try {
    return await readFile(join(paths.cache, key))
  } catch {
    return undefined
  }
}

/** 写缓存文件。 */
export async function writeCache(paths, key, buffer) {
  try {
    await ensureLayout(paths)
    await writeFile(join(paths.cache, key), buffer)
  } catch {
    /* 缓存写失败不影响本次响应，下次重算即可 */
  }
}

/** 读原图字节。 */
export async function readImageBuffer(paths, name) {
  const target = resolveImage(paths, name)
  if (target === null) return undefined
  try {
    return { buffer: await readFile(target), file: basename(target), format: formatOf(target) }
  } catch {
    return undefined
  }
}
