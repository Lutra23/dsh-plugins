/**
 * dsh-workspace-docs — 把当前工作区的顶层清单与文档文件列表注入 system prompt。
 *
 * 解决的问题：新会话的 system prompt 里只有规则与工具说明，agent 对工作区里
 * 有什么文件一无所知，于是接任务时倾向直接 glob/grep 盲搜，而不是先读项目自带的
 * README、更新日志和工程记录。
 *
 * 做法：注册一个 system prompt section。system prompt 在每次请求前重新 assemble，
 * 本节据此按当前工作目录重新渲染，因此始终反映真实目录内容。
 *
 * 实现约束：section 的 `text` 由同步的 assemble 流程调用，返回 Promise 会被当成
 * 文本，所以这里用同步 fs 读目录；每层只读一项，耗时在毫秒级，并按目录缓存结果。
 *
 * @module dsh-workspace-docs
 */

import { readdirSync, statSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const name = 'dsh-workspace-docs'
export const inject = ['systemPrompt', 'workingDirectory']

/** 本插件注册的运行时上下文名。 */
const CONTEXT_NAME = 'workspace-docs:overview'

/** 文档扩展名：这些文件的文件名值得直接摆给 agent 看。 */
const DOC_EXTENSIONS = ['.md', '.txt', '.markdown', '.rst', '.adoc']

/** 文档名关键词：即使扩展名不在上面，命中这些也算文档。 */
const DOC_NAME_HINTS = ['readme', 'changelog', 'changes', 'history', 'notes', 'todo', 'license', 'contributing']

/** 噪音目录：列目录时直接跳过，不占用清单名额。 */
const DEFAULT_IGNORED = [
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
  '.next', '.nuxt', '.cache', '.turbo', 'coverage', '__pycache__',
  '.venv', 'venv', '.idea', '.vscode', 'quarantine', 'trash',
]

/** 判断一个文件名是否算「文档」。 */
function isDocFile(fileName) {
  const lower = fileName.toLowerCase()
  if (DOC_EXTENSIONS.some((extension) => lower.endsWith(extension))) return true
  return DOC_NAME_HINTS.some((hint) => lower.includes(hint))
}

/** 文档优先级：README / CHANGELOG 这类索引型文档排在零散日志前面。 */
function docRank(fileName) {
  const lower = fileName.toLowerCase()
  if (lower.startsWith('readme')) return 0
  if (lower.includes('changelog') || lower.includes('changes')) return 1
  if (lower.includes('architecture') || lower.includes('design')) return 2
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 3
  return 4
}

/** 按文档优先级排序，保持同优先级内原有顺序。 */
function sortDocs(names) {
  return [...names].sort((left, right) => docRank(left) - docRank(right))
}

/**
 * 按前缀判断是否为噪音目录。
 *
 * 工作区里常有一堆 `_scratch`、`_archive`、`.dsh-xxx` 这类临时/工具目录，
 * 逐个写进忽略名单不现实，统一按前缀排除。
 */
function isIgnoredDir(dirName, ignored) {
  const lower = dirName.toLowerCase()
  if (ignored.has(lower)) return true
  if (lower.startsWith('_')) return true
  return dirName.startsWith('.')
}

/** 按 UTF-8 字节数截断文本，不切坏多字节字符。 */
function truncateToBytes(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) low = mid
    else high = mid - 1
  }
  return text.slice(0, low)
}

/**
 * 列一层目录，按类型分组。
 *
 * 任何异常都当作「这一层读不到」处理，返回空结果，不让扫描失败中断 prompt 组装。
 *
 * @param dir - 绝对路径。
 * @returns `{ dirs: string[], files: string[] }`。
 */
function listOneLevel(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const dirs = []
  const files = []
  for (const entry of entries) {
    if (entry.isDirectory()) dirs.push(entry.name)
    else if (entry.isFile()) files.push(entry.name)
  }
  return { dirs, files }
}

/**
 * 扫描工作区，产出结构化结果。
 *
 * 顶层条目超过上限时只保留前 maxTopLevel 条并记录溢出数量；子目录只下探到
 * 第二层找文档，不再继续深入。
 *
 * @param cwd - 会话工作目录。
 * @param config - 已解析的配置。
 */
function scanWorkspace(cwd, config) {
  // 记录本次真正列过的目录，供后续变更检测用（目录 mtime 变化 = 增删改名）。
  const scanned = [cwd]
  const top = listOneLevel(cwd)
  const ignored = new Set(config.ignored.map((entry) => entry.toLowerCase()))

  const visibleDirs = top.dirs.filter((dirName) => !isIgnoredDir(dirName, ignored))
  const visibleFiles = top.files
  const totalVisible = visibleDirs.length + visibleFiles.length

  // 目录优先占名额，剩余名额给文件。
  const keptDirs = visibleDirs.slice(0, config.maxTopLevel)
  const remainingSlots = Math.max(0, config.maxTopLevel - keptDirs.length)
  const keptFiles = visibleFiles.slice(0, remainingSlots)
  const overflow = totalVisible - keptDirs.length - keptFiles.length

  const rootDocs = sortDocs(keptFiles.filter(isDocFile))

  const dirDocs = []
  for (const dirName of keptDirs) {
    try {
      const first = listOneLevel(join(cwd, dirName))
      scanned.push(join(cwd, dirName))
      const ownDocs = sortDocs(first.files.filter(isDocFile))
      const nested = []

      const childDirs = first.dirs.filter((child) => !isIgnoredDir(child, ignored))
      for (const child of childDirs.slice(0, config.maxDocsPerDir)) {
        try {
          const second = listOneLevel(join(cwd, dirName, child))
          scanned.push(join(cwd, dirName, child))
          const docs = sortDocs(second.files.filter(isDocFile))
          if (docs.length > 0) {
            nested.push({ dir: `${dirName}/${child}`, docs: docs.slice(0, 4), more: Math.max(0, docs.length - 4) })
          }
        } catch {
          /* 单个孙目录读不到就跳过。 */
        }
      }

      if (ownDocs.length === 0 && nested.length === 0) continue
      dirDocs.push({
        dir: dirName,
        docs: ownDocs.slice(0, config.maxDocsPerDir),
        more: Math.max(0, ownDocs.length - config.maxDocsPerDir),
        nested,
      })
    } catch {
      /* 单个子目录读不到就跳过，不影响其余结果。 */
    }
  }

  return { cwd, dirs: keptDirs, files: keptFiles, rootDocs, dirDocs, overflow, totalVisible, scanned }
}

/** 把扫描结果渲染成注入用的 Markdown 文本。 */
function renderScan(scan, config) {
  const lines = []
  lines.push('当前工作区文件概览（由 dsh-workspace-docs 自动生成，只列文件名，未读内容）：')
  lines.push(`工作目录：${scan.cwd}`)
  lines.push('')

  if (scan.dirs.length > 0) {
    lines.push(`顶层文件夹（${scan.dirs.length} 个）：`)
    for (const dirName of scan.dirs) lines.push(`- ${dirName}/`)
    lines.push('')
  }

  // 已归入「顶层文档」的文件不再重复列一遍。
  const otherFiles = scan.files.filter((fileName) => !scan.rootDocs.includes(fileName))
  if (otherFiles.length > 0) {
    lines.push(`顶层其他文件（${otherFiles.length} 个）：`)
    for (const fileName of otherFiles) lines.push(`- ${fileName}`)
    lines.push('')
  }

  if (scan.rootDocs.length > 0) {
    lines.push('顶层文档（优先读）：')
    for (const docName of scan.rootDocs) lines.push(`- ${docName}`)
    lines.push('')
  }

  if (scan.dirDocs.length > 0) {
    lines.push('各文件夹内的文档文件（优先读）：')
    for (const entry of scan.dirDocs) {
      if (entry.docs.length > 0) {
        lines.push(`- ${entry.dir}/：${entry.docs.join('、')}`)
        if (entry.more > 0) lines.push(`  （该文件夹还有 ${entry.more} 份文档未列出）`)
      }
      for (const child of entry.nested) {
        lines.push(`  - ${child.dir}/：${child.docs.join('、')}`)
        if (child.more > 0) lines.push(`    （该文件夹还有 ${child.more} 份文档未列出）`)
      }
    }
    lines.push('')
  }

  if (scan.overflow > 0) {
    lines.push(`提示：顶层还有 ${scan.overflow} 项未列出（超出单次展示上限）。目标不在上面时，用 glob 或 pwsh 自行查看剩余内容。`)
    lines.push('')
  }

  lines.push('接项目任务时，先按上面的文档清单读 README、更新日志与工程记录，再决定是否搜索代码；清单没覆盖到目标时再用 glob/grep 定位。')

  return truncateToBytes(lines.join('\n'), config.maxBytes)
}

/** 读取配置，给出安全默认值并做边界收敛。 */
function resolveConfig(config) {
  const source = config ?? {}
  const positiveInt = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback)
  return {
    maxTopLevel: positiveInt(source.maxTopLevel, 50),
    maxDocsPerDir: positiveInt(source.maxDocsPerDir, 12),
    maxBytes: positiveInt(source.maxBytes, 4000),
    order: Number.isFinite(source.order) ? source.order : 130,
    ignored: Array.isArray(source.ignored) && source.ignored.length > 0
      ? source.ignored.filter((entry) => typeof entry === 'string')
      : DEFAULT_IGNORED,
  }
}

/**
 * 挂载插件：注册一个随每次 prompt 组装重新渲染的 section。
 *
 * @param ctx - 注入了 `systemPrompt` 与 `workingDirectory` 的上下文。
 * @param config - 见 README 的配置表。
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)

  /** 诊断日志：日志通道不可用时静默。 */
  const log = (level, message) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-workspace-docs') : ctx.logger
      const write = logger?.[level]
      if (typeof write === 'function') write.call(logger, message)
    } catch {
      /* 忽略 */
    }
  }

  log('info', `apply() 已调用，order=${resolved.order}, maxTopLevel=${resolved.maxTopLevel}`)

  // 启动自检：直接落盘一行，不依赖日志通道，用来确认 DSH 确实加载了本插件。
  try {
    appendFileSync(
      join(tmpdir(), 'dsh-workspace-docs.log'),
      `${new Date().toISOString()} apply() pid=${process.pid} order=${resolved.order}\n`,
    )
  } catch {
    /* 自检失败不影响功能 */
  }

  /** 缓存上一次扫描结果，以及参与扫描的目录及其 mtime 快照。 */
  let cachedDir
  let cachedText = ''
  let watched = []

  /** 取一组目录的 mtime 快照；任一目录不可读时返回 null（视为已变更）。 */
  function snapshot(paths) {
    const next = []
    for (const path of paths) {
      try {
        next.push({ path, mtimeMs: statSync(path).mtimeMs })
      } catch {
        return null
      }
    }
    return next
  }

  /** 缓存是否仍然有效：目录未变、集合一致。 */
  function unchanged() {
    if (watched.length === 0) return false
    const next = snapshot(watched.map((entry) => entry.path))
    if (next === null || next.length !== watched.length) return false
    for (let i = 0; i < next.length; i += 1) {
      if (next[i].mtimeMs !== watched[i].mtimeMs) return false
    }
    return true
  }

  /**
   * 同步渲染指定目录。
   *
   * 每次请求都先比对目录 mtime：没有任何增删改名就直接复用上次结果，
   * 有变化才重新扫盘，避免清单在会话中途变旧。
   */
  function renderFor(dir) {
    if (dir === cachedDir && unchanged()) return cachedText
    try {
      const scan = scanWorkspace(dir, resolved)
      cachedText = scan.totalVisible === 0 ? '' : renderScan(scan, resolved)
      watched = snapshot(scan.scanned) ?? []
      try {
        appendFileSync(join(tmpdir(), 'dsh-workspace-docs.log'),
          `${new Date().toISOString()} 扫描 ${dir}: ${scan.totalVisible} 项 -> ${Buffer.byteLength(cachedText, 'utf8')} 字节\n`)
      } catch { /* 忽略 */ }
    } catch (error) {
      cachedText = ''
      watched = []
      log('warn', `扫描失败 ${dir}: ${error?.message ?? error}`)
    }
    cachedDir = dir
    return cachedText
  }

  // 注册运行时上下文（routing context）而不是 section：
  // `section()` 进的是 system prompt 正文，部分第三方/代理模型并不据此行动；
  // `context()` 生成的是模型可见的 sourced 运行时快照——官方 working-directory
  // 就是这么注入当前目录的，模型确实会读。每次组装重新求值。
  ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: resolved.order,
    // 文本含文件路径，不做变量插值，避免目录名里的花括号被误解析。
    interpolate: false,
    text: (context) => {
      try {
        // 注意：assembly 上下文里是 context.agent，不是 context.session。
        const session = context?.agent?.session
        if (session === undefined) return ''
        let cwd
        try {
          cwd = ctx.workingDirectory.get(session)
        } catch {
          return ''
        }
        // 只有拿到真实的会话工作目录才注入：回落进程目录会把无关的
        // profile 目录清单塞进别的 prompt，宁可不注入。
        if (typeof cwd !== 'string' || cwd.length === 0) return ''
        return renderFor(cwd)
      } catch (error) {
        try {
          appendFileSync(join(tmpdir(), 'dsh-workspace-docs.log'),
            `${new Date().toISOString()} context 渲染异常: ${error?.message ?? error}\n`)
        } catch { /* 忽略 */ }
        return ''
      }
    },
  })

  log('info', '运行时上下文已注册')
}
