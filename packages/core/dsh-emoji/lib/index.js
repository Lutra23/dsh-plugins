/**
 * dsh-emoji · 宿主半。
 *
 * 三件事：
 *   1. 认领 /api/dsh-emoji/* 路由（浏览器半与 markdown 渲染都要走它）
 *   2. 注册 emoji 工具，让 Agent 能在回复里真的把表情包发出来
 *   3. 管「多套表情包」：库在 packs/<id>/ 下可以躺好几套，activePack 决定用哪套，
 *      切包只改一个指针，因此工具这边每次调用都重新解析、永远看到当前那套
 *
 * 工具回执给的是**绝对 http URL**。这不是随手选的：DSH 的 markdown 图片
 * 渲染里，imageSource 只对 http/https 无条件放行；本地文件路径与
 * data:/blob: 都得先过 pathImages 重写词汇表，而那份词汇表由宿主注入、
 * 插件拿不到。绝对 URL 是唯一不依赖宿主内部委托、且实测可加载的形态。
 *
 * 宽度写在 URL 的 ?w= 上，于是「发哪张」与「发多大」落在同一次调用里，
 * 不需要预生成任何档位文件。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { makeRoutes } from './routes.js'
import { listEmoji, loadConfig, pathsOf, resolveHome, resolveLibrary, setActivePack } from './store.js'

/** 稳定的 cordis 插件名。 */
export const name = 'emoji'

/** 路由与工具都需要宿主已提供 webServer 与 tools。 */
export const inject = ['webServer', 'tools']

/** 默认显示宽度，沿用 VCP 表情包系统的习惯值。 */
const DEFAULT_WIDTH = 150

/** 工具描述里要交代清楚的取图语义。 */
const TOOL_DESCRIPTION = [
  '表情包库：列出、检索、发送本机的表情包图片，并在多套表情包之间切换。',
  '命令：',
  '  list   — 列出当前这套的全部表情包（名字 / 尺寸 / 体积 / 是否可缩放）',
  '  search — 按关键词模糊检索（query 参数）',
  '  send   — 发送一张指定表情包（name 参数），返回可直接粘贴进回复的 Markdown',
  '  random — 随机发若干张（count 参数）',
  '  packs  — 列出所有可切换的表情包套（当前生效的那套带 * 号）',
  '  use    — 切换到某一套（pack 参数，值取 packs 给出的 id；切换只改指针不动图片）',
  '',
  'width 为显示宽度（像素），默认 150，常用档位 20 / 28 / 40 / 150；',
  '它体现在返回的图片 URL 上，因此同一张图可以随时换尺寸重发，无须任何预生成。',
  'send/random 的返回值就是可直接嵌入回复正文的 Markdown 图片片段——',
  '原样整行粘贴即可，不要改写 URL，也不要用代码块包住它，否则不会渲染成图。',
].join('\n')

/** 把字节数说成人话。 */
function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/**
 * 宿主半装配。
 * @param ctx - 宿主插件上下文。
 * @param config - 插件配置（home 可覆盖库根）。
 */
function applyImpl(ctx, config) {
  const home = resolveHome(config)
  const basePaths = pathsOf(home)
  const logger = { warn: (error) => ctx.logger.warn(error) }

  const routes = makeRoutes(ctx, { resolvedHome: home, logger })
  ctx.effect(
    () => {
      const disposers = routes.map((route) => ctx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'dsh-emoji: routes',
  )

  /** 图片的可加载基址：端口取实际监听值，端口为 0 时也成立。 */
  function baseUrl() {
    const port = ctx.webServer.port
    const host = ctx.webServer.host || '127.0.0.1'
    return `http://${host}:${port}`
  }

  /**
   * 拉取**当前生效那套**的内容与配置。
   * 每次实时解析，设置页或工具刚切完包，下一次调用就落在新的那套上。
   */
  async function snapshot() {
    const cfg = await loadConfig(basePaths)
    const lib = await resolveLibrary(basePaths, cfg)
    const items = await listEmoji(lib.paths)
    return { items, cfg, lib }
  }

  ctx.tools.register(
    defineTool({
      name: 'emoji',
      description: TOOL_DESCRIPTION,
      parameters: {
        command: {
          type: 'string',
          required: true,
          enum: ['list', 'search', 'send', 'random', 'packs', 'use'],
          description: '要执行的命令。',
        },
        name: { type: 'string', description: 'send 的表情包名（支持模糊匹配）。' },
        query: { type: 'string', description: 'search 的关键词。' },
        width: { type: 'integer', description: `显示宽度像素，默认 ${DEFAULT_WIDTH}。` },
        count: { type: 'integer', description: 'random 的张数，默认 1，最多 6。' },
        pack: { type: 'string', description: 'use 的目标套 id（也接受显示名），取值见 packs 命令。' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: value }]
        },
      },
      async execute(args) {
        const a = args || {}
        const command = String(a.command || '').trim()
        const widthRaw = Number(a.width)
        const width = Number.isFinite(widthRaw) && widthRaw >= 4 && widthRaw <= 2048 ? Math.round(widthRaw) : DEFAULT_WIDTH

        try {
          const { items, cfg, lib } = await snapshot()

          if (command === 'packs') {
            if (lib.packs.length === 0) return '库里还没有任何一套表情包。'
            return [
              `共 ${lib.packs.length} 套表情包，当前生效：${lib.activeName}（${lib.activeId}）`,
              '',
              ...lib.packs.map(
                (pack) => `${pack.id === lib.activeId ? '*' : '-'} ${pack.id}（${pack.name} · ${pack.count} 张）`,
              ),
              '',
              '切包：{ command: "use", pack: "<id>" }，或让主人在「设置 → 表情包」里点。',
              '同名不同套的表情是同一个角色的不同版本，切过去就会换一张脸；只有一套里有的名字，在另一套里不存在。',
            ].join('\n')
          }

          if (command === 'use') {
            const wanted = String(a.pack || '').trim()
            if (wanted === '') {
              return [
                '**错误**：use 需要 pack 参数。可用的 id：',
                '',
                ...lib.packs.map((pack) => `- ${pack.id}（${pack.name} · ${pack.count} 张）`),
              ].join('\n')
            }
            const target =
              lib.packs.find((pack) => pack.id === wanted) ?? lib.packs.find((pack) => pack.name === wanted)
            if (target === undefined) return `没有这一套表情包：${wanted}。可用 packs 查看全部 id。`
            await setActivePack(basePaths, cfg, target.id)
            const after = await snapshot()
            return [
              `已切到「${after.lib.activeName}」（${after.lib.activeId} · ${after.items.length} 张）。`,
              '库内清单与出图立即按这套生效；浏览器里的速记名单最迟 60 秒（下一次轮询）跟上。',
            ].join('\n')
          }

          if (items.length === 0) {
            return [
              `当前这套「${lib.activeName}」还是空的。`,
              '',
              `库目录：${lib.paths.images}`,
              '请主人在「设置 → 表情包」里导入图片，或用 emoji 的 packs 命令切到另一套。',
            ].join('\n')
          }

          /** 图片的绝对可加载 URL。 */
          const imageUrl = (item, w) =>
            `${baseUrl()}/api/dsh-emoji/image?name=${encodeURIComponent(item.name)}&w=${w}`

          if (command === 'list') {
            const lines = items.map(
              (item) =>
                `- ${item.name}（${item.width ?? '?'}×${item.height ?? '?'}，${humanBytes(item.bytes)}${item.scalable ? '' : '，不可缩放'}${item.format === 'gif' ? '，动图' : ''}）`,
            )
            return [
              `共 ${items.length} 个表情包，当前是「${lib.activeName}」这套，库目录 ${lib.paths.images}`,
              `可用宽度档位：${cfg.widths.join(' / ')}`,
              '',
              ...lines,
            ].join('\n')
          }

          if (command === 'search') {
            const q = String(a.query || '').trim().toLowerCase()
            if (q === '') return '**错误**：search 需要 query 参数。'
            const hits = items.filter((item) => item.name.toLowerCase().includes(q))
            if (hits.length === 0) return `没有名字包含「${a.query}」的表情包，共 ${items.length} 个可检索。`
            return [`匹配「${a.query}」的表情包 ${hits.length} 个：`, '', ...hits.map((item) => `- ${item.name}`)].join('\n')
          }

          if (command === 'send') {
            const wanted = String(a.name || '').trim()
            if (wanted === '') return '**错误**：send 需要 name 参数。'
            const lower = wanted.toLowerCase()
            let hit = items.find((item) => item.name.toLowerCase() === lower)
            if (hit === undefined) {
              const partial = items.filter((item) => item.name.toLowerCase().includes(lower))
              if (partial.length === 1) {
                hit = partial[0]
              } else if (partial.length > 1) {
                const preview = partial.slice(0, 20).map((item) => `- ${item.name}`)
                return [
                  `「${wanted}」匹配到 ${partial.length} 个表情包，请挑一个确切的名字重发：`,
                  '',
                  ...preview,
                  partial.length > 20 ? `…另有 ${partial.length - 20} 个，可用 search 缩小范围。` : '',
                ]
                  .filter(Boolean)
                  .join('\n')
              }
            }
            if (hit === undefined) {
              return `没找到「${wanted}」。可用 search 或 list 查看现有表情包；若那名字属于另一套，先 packs 看一眼再 use 切过去。`
            }
            const markdown = `![${hit.name}](${imageUrl(hit, width)})`
            return [
              markdown,
              '',
              `（${hit.name} · 显示宽度 ${width}px${hit.scalable ? '' : ' · 该格式不支持缩放，宽度参数被忽略'}）`,
            ].join('\n')
          }

          if (command === 'random') {
            const countRaw = Number(a.count)
            const count = Number.isFinite(countRaw) ? Math.min(Math.max(Math.round(countRaw), 1), 6) : 1
            const pool = [...items]
            const picked = []
            for (let i = 0; i < count && pool.length > 0; i += 1) {
              const index = Math.floor(Math.random() * pool.length)
              picked.push(pool.splice(index, 1)[0])
            }
            return picked.map((item) => `![${item.name}](${imageUrl(item, width)})`).join('\n\n')
          }

          return `**错误**：未知命令 ${command}。可用：list / search / send / random / packs / use`
        } catch (error) {
          return `**emoji 错误**：${error instanceof Error ? error.message : String(error)}`
        }
      },
    }),
  )
}

export function apply(ctx, config) {
  applyImpl(ctx, config)
}
