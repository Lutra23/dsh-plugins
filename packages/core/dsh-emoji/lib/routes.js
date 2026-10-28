/**
 * /api/dsh-emoji/* 路由家族。
 *
 * 读端点（list / packs / image / raw / health）供浏览器半与 markdown 渲染取用；
 * 写端点（import / scan / delete / config / clear-cache / pack-switch）会真实改动
 * 磁盘，一律先过回环信任围栏。
 *
 * 两条贯穿全部处理器的约定：
 *   1. **每次请求都重新解析当前生效的包**（resolveLibrary）。切包因此不需要重启、
 *      也不需要重注册路由——指针一变，下一个请求就落在另一套图上。
 *   2. image 端点是「调节大小」的实现本体：按 ?name=<名>&w=<宽> 现算并落缓存。
 *      缓存目录按包分（cache/<包 id>/…），两套包同名不同图也不会串味。
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { formatOf, isDecodable, resizeToWidth } from './imagecodec.js'
import { guardRead, guardWrite, readJsonBody, recentRejections, writeJson } from './fence.js'
import {
  DEFAULT_WIDTHS,
  clearCache,
  importImage,
  listEmoji,
  loadConfig,
  normalizeName,
  pathsOf,
  readCache,
  readImageBuffer,
  resolveImage,
  resolveLibrary,
  saveConfig,
  setActivePack,
  trashEmoji,
  writeCache,
} from './store.js'

/** 路由字面量与浏览器半共享；测试同时断言两侧。 */
export const ROUTES = {
  list: '/api/dsh-emoji/list',
  packs: '/api/dsh-emoji/packs',
  packSwitch: '/api/dsh-emoji/pack-switch',
  image: '/api/dsh-emoji/image',
  raw: '/api/dsh-emoji/raw',
  import: '/api/dsh-emoji/import',
  scan: '/api/dsh-emoji/scan',
  delete: '/api/dsh-emoji/delete',
  config: '/api/dsh-emoji/config',
  clearCache: '/api/dsh-emoji/clear-cache',
  health: '/api/dsh-emoji/health',
  diag: '/api/dsh-emoji/diag',
}

/** 允许的宽度范围。下限 4px 保证仍是一张图，上限 2048 防止一次请求吃满内存。 */
const MIN_WIDTH = 4
const MAX_WIDTH = 2048

/** 从 URL 取首个查询参数（已解码）。 */
function queryParam(url, name) {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** 把宽度解析为合法整数，非法时返回 undefined。 */
function parseWidth(raw) {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  const rounded = Math.round(n)
  if (rounded < MIN_WIDTH || rounded > MAX_WIDTH) return undefined
  return rounded
}

/** 构造一条图片响应的缓存与内容头。 */
function imageHeaders(contentType, etag) {
  return {
    'content-type': contentType,
    'cache-control': 'private, max-age=0, must-revalidate',
    etag,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  }
}

/**
 * 构建全部路由。
 * @param ctx - 宿主上下文；读 ctx.webServer 与 ctx.logger。
 * @param config - 解析后的插件配置。
 * @returns 供 ctx.webServer.register 使用的路由数组。
 */
export function makeRoutes(ctx, config) {
  const home = (config && config.home) || undefined
  const basePaths = pathsOf((config && config.resolvedHome) || home || '')
  const logger = config && config.logger ? config.logger : { warn: () => {} }

  /** 同键并发去重：同一 name@w 被同时要好几次时只算一次。 */
  const inFlight = new Map()

  /**
   * 解析本次请求要用的库面板。
   * 每次实时读配置与 packs/ 目录，切包因此在下一个请求就生效。
   * @returns {cfg, paths, activeId, activeName, packs, created}
   */
  async function library() {
    const cfg = await loadConfig(basePaths)
    const resolved = await resolveLibrary(basePaths, cfg)
    return { cfg, ...resolved }
  }

  /** 包列表的对外形状（带 active 标记）。 */
  function packsView(lib) {
    return lib.packs.map((pack) => ({
      id: pack.id,
      name: pack.name,
      count: pack.count,
      active: pack.id === lib.activeId,
    }))
  }

  /** 给浏览器半的配置视图（含当前生效的包）。 */
  function configView(lib) {
    return {
      home: basePaths.home,
      imagesDir: lib.paths.images,
      widths: lib.cfg.widths,
      scanDirs: lib.cfg.scanDirs,
      defaultWidths: [...DEFAULT_WIDTHS],
      activePack: lib.activeId,
      activePackName: lib.activeName,
      packs: packsView(lib),
    }
  }

  /**
   * 取一张按宽度缩放后的图（命中缓存则直出）。
   * @param paths - 已解析到某一套包的库面板。
   * @returns {buffer, contentType, tag}，取不到时 undefined。
   */
  async function scaledImage(paths, name, width) {
    const source = await readImageBuffer(paths, name)
    if (source === undefined) return undefined
    const format = source.format
    const effectiveWidth = width === undefined ? null : width

    // 未指定宽度，或格式不支持缩放：直出原图。
    if (effectiveWidth === null || !isDecodable(format)) {
      const contentType = format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'application/octet-stream'
      return { buffer: source.buffer, contentType, tag: `${source.buffer.length}-orig` }
    }

    const outFormat = format === 'jpeg' ? 'jpg' : 'png'
    const key = `${normalizeName(name)}@${effectiveWidth}.${outFormat}`
    const cached = await readCache(paths, key)
    if (cached !== undefined) {
      return {
        buffer: cached,
        contentType: outFormat === 'jpg' ? 'image/jpeg' : 'image/png',
        tag: `${cached.length}-${effectiveWidth}`,
      }
    }

    if (inFlight.has(key)) return inFlight.get(key)
    const task = (async () => {
      try {
        const result = resizeToWidth(source.buffer, format, effectiveWidth)
        if (result === undefined) {
          // 解码失败（损坏或伪扩展名）：退回原图，至少不让页面开天窗。
          const contentType = format === 'png' ? 'image/png' : 'image/jpeg'
          return { buffer: source.buffer, contentType, tag: `${source.buffer.length}-orig` }
        }
        await writeCache(paths, key, result.buffer)
        return {
          buffer: result.buffer,
          contentType: result.format === 'jpeg' ? 'image/jpeg' : 'image/png',
          tag: `${result.buffer.length}-${effectiveWidth}`,
        }
      } finally {
        inFlight.delete(key)
      }
    })()
    inFlight.set(key, task)
    return task
  }

  /** 图片端点的公共实现（image 与 raw 只差是否传入宽度）。 */
  function imageHandler(useWidth) {
    return async (req, res) => {
      if (!guardRead(req, res, 'GET')) return
      try {
        const lib = await library()
        const paths = lib.paths
        const url = new URL(req.url ?? '/', 'http://x')
        const name = queryParam(url, 'name')
        if (name === undefined || normalizeName(name) === '') {
          writeJson(res, 400, { error: 'expected ?name=<表情包名>' })
          return
        }
        if (resolveImage(paths, name) === null) {
          writeJson(res, 404, { error: `表情包不存在：${normalizeName(name)}` })
          return
        }
        let width
        if (useWidth) {
          const raw = queryParam(url, 'w')
          width = parseWidth(raw)
          if (raw !== undefined && width === undefined) {
            writeJson(res, 400, { error: `w 必须是 ${MIN_WIDTH}-${MAX_WIDTH} 的整数` })
            return
          }
        }
        const result = await scaledImage(paths, name, width)
        if (result === undefined) {
          writeJson(res, 404, { error: `表情包不存在：${normalizeName(name)}` })
          return
        }
        const etag = `"${result.tag}"`
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { etag, 'cache-control': 'private, max-age=0, must-revalidate' })
          res.end()
          return
        }
        res.writeHead(200, { ...imageHeaders(result.contentType, etag), 'content-length': result.buffer.length })
        res.end(result.buffer)
      } catch (error) {
        logger.warn(error)
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  return [
    {
      kind: 'exact',
      path: ROUTES.list,
      handler: async (req, res) => {
        if (!guardRead(req, res, 'GET')) return
        try {
          const lib = await library()
          const items = await listEmoji(lib.paths)
          writeJson(res, 200, { ...configView(lib), items, count: items.length })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.packs,
      handler: async (req, res) => {
        if (!guardRead(req, res, 'GET')) return
        try {
          const lib = await library()
          writeJson(res, 200, {
            ok: true,
            home: basePaths.home,
            imagesDir: lib.paths.images,
            activePack: lib.activeId,
            activePackName: lib.activeName,
            packs: packsView(lib),
            count: lib.packs.length,
          })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.packSwitch,
      handler: async (req, res) => {
        if (!guardWrite(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { objectOnly: true })
          const id = typeof body?.id === 'string' ? body.id.trim() : ''
          if (id === '') {
            writeJson(res, 400, { error: 'expected { id }' })
            return
          }
          await setActivePack(basePaths, await loadConfig(basePaths), id)
          const lib = await library()
          const items = await listEmoji(lib.paths)
          // 回执形状与 list 对齐：浏览器半切换后可以照原样套用，省一次往返。
          writeJson(res, 200, { ok: true, ...configView(lib), items, count: items.length })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logger.warn(error)
          writeJson(res, /没有这一套/.test(message) ? 404 : 500, { error: message })
        }
      },
    },
    { kind: 'exact', path: ROUTES.image, handler: imageHandler(true) },
    { kind: 'exact', path: ROUTES.raw, handler: imageHandler(false) },
    {
      kind: 'exact',
      path: ROUTES.import,
      handler: async (req, res) => {
        if (!guardWrite(req, res, 'POST')) return
        try {
          const { paths } = await library()
          const body = await readJsonBody(req, { objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const files = Array.isArray(body.files) ? body.files : []
          if (files.length === 0) {
            writeJson(res, 400, { error: 'expected { files: [{ name, dataBase64 }] }' })
            return
          }
          const imported = []
          const errors = []
          for (const file of files) {
            const fileName = typeof file?.name === 'string' ? file.name : ''
            const data = typeof file?.dataBase64 === 'string' ? file.dataBase64 : ''
            if (fileName === '' || data === '') {
              errors.push({ name: fileName || '(未命名)', error: '缺少 name 或 dataBase64' })
              continue
            }
            let buffer
            try {
              buffer = Buffer.from(data, 'base64')
            } catch {
              errors.push({ name: fileName, error: 'base64 解码失败' })
              continue
            }
            if (buffer.length === 0) {
              // 空解码结果几乎总是前端把裸 data URL 前缀一起去掉了。
              errors.push({ name: fileName, error: '解码后为空（非图片 base64？）' })
              continue
            }
            try {
              const entry = await importImage(paths, fileName, buffer, {
                name: typeof body.rename === 'string' ? undefined : undefined,
                onConflict: body.onConflict === 'overwrite' ? 'overwrite' : 'rename',
              })
              imported.push(entry)
            } catch (error) {
              errors.push({ name: fileName, error: error instanceof Error ? error.message : String(error) })
            }
          }
          const items = await listEmoji(paths)
          writeJson(res, 200, { ok: errors.length === 0, imported, errors, items, count: items.length })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.scan,
      handler: async (req, res) => {
        if (!guardWrite(req, res, 'POST')) return
        try {
          const { paths, cfg } = await library()
          const body = await readJsonBody(req, { objectOnly: true })
          const dirs = Array.isArray(body?.dirs)
            ? body.dirs.filter((d) => typeof d === 'string' && d.trim() !== '')
            : cfg.scanDirs
          if (dirs.length === 0) {
            writeJson(res, 400, { error: '未配置扫描目录：请先在设置页添加一个目录' })
            return
          }
          const imported = []
          const errors = []
          const skipped = []
          for (const dir of dirs) {
            let entries
            try {
              entries = await readdir(dir, { withFileTypes: true })
            } catch (error) {
              errors.push({ name: dir, error: `目录不可读：${error instanceof Error ? error.message : String(error)}` })
              continue
            }
            for (const entry of entries) {
              if (!entry.isFile()) continue
              const format = formatOf(entry.name)
              if (format === undefined) continue
              // 已在库中的同名文件不重复导入，扫描应当是幂等的。
              if (resolveImage(paths, normalizeName(entry.name)) !== null) {
                skipped.push(entry.name)
                continue
              }
              try {
                const buffer = await readFile(join(dir, entry.name))
                imported.push(await importImage(paths, entry.name, buffer))
              } catch (error) {
                errors.push({ name: entry.name, error: error instanceof Error ? error.message : String(error) })
              }
            }
          }
          const items = await listEmoji(paths)
          writeJson(res, 200, {
            ok: errors.length === 0,
            imported,
            errors,
            skipped: skipped.length,
            items,
            count: items.length,
          })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.delete,
      handler: async (req, res) => {
        if (!guardWrite(req, res, 'POST')) return
        try {
          const { paths } = await library()
          const body = await readJsonBody(req, { objectOnly: true })
          const name = typeof body?.name === 'string' ? body.name : ''
          if (name === '') {
            writeJson(res, 400, { error: 'expected { name }' })
            return
          }
          const moved = await trashEmoji(paths, name)
          const items = await listEmoji(paths)
          writeJson(res, 200, { ok: true, name: normalizeName(name), moved, items, count: items.length })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          writeJson(res, /不存在/.test(message) ? 404 : 500, { error: message })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.config,
      handler: async (req, res) => {
        if (!guardWrite(req, res, 'POST')) return
        try {
          const { cfg } = await library()
          const body = await readJsonBody(req, { objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          if (Array.isArray(body.widths)) {
            const widths = body.widths
              .map((n) => Number(n))
              .filter((n) => Number.isFinite(n) && n >= MIN_WIDTH && n <= MAX_WIDTH)
              .map((n) => Math.round(n))
            if (widths.length === 0) {
              writeJson(res, 400, { error: `宽度档位至少要有一个，范围 ${MIN_WIDTH}-${MAX_WIDTH}` })
              return
            }
            cfg.widths = [...new Set(widths)].sort((a, b) => a - b)
          }
          if (Array.isArray(body.scanDirs)) {
            cfg.scanDirs = body.scanDirs.filter((d) => typeof d === 'string' && d.trim() !== '')
          }
          // cfg 里带着 activePack：改宽度档位不该顺手把当前包重置掉，所以写的是 basePaths。
          await saveConfig(basePaths, cfg)
          const lib = await library()
          writeJson(res, 200, { ok: true, ...configView(lib) })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.clearCache,
      handler: async (req, res) => {
        if (!guardWrite(req, res, 'POST')) return
        try {
          const { paths } = await library()
          const removed = await clearCache(paths)
          writeJson(res, 200, { ok: true, removed })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.health,
      handler: async (req, res) => {
        if (!guardRead(req, res, 'GET')) return
        try {
          const lib = await library()
          const items = await listEmoji(lib.paths)
          writeJson(res, 200, {
            ok: true,
            plugin: 'dsh-emoji',
            home: basePaths.home,
            activePack: lib.activeId,
            packs: packsView(lib),
            count: items.length,
          })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.diag,
      handler: async (req, res) => {
        if (!guardRead(req, res, 'GET')) return
        writeJson(res, 200, { ok: true, rejections: recentRejections() })
      },
    },
  ]
}
