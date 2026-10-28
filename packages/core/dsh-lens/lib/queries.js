/**
 * dsh-lens 查询层：全部接收已打开的 AsarReader，纯读，返回数据对象。
 * 渲染成工具回执文本由 index.js 负责——这里保持可直接单测（selftest 依赖此约定）。
 */
import { KERNEL_SCOPE, packageRoots } from './lens.js'

const TEXT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.json', '.md', '.ts', '.txt', '.yml', '.yaml', '.html', '.css'])
/** 超过 8MB 的单文件跳过（超大的多半是 sourcemap/资产，不是要搜的源码）。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024
/** 单次 grep 的总字节预算，超出即截断并明说。 */
const MAX_TOTAL_BYTES = 160 * 1024 * 1024
/** 单次 file 回执的字符上限。 */
const MAX_OUTPUT_CHARS = 200_000
/** list 回执的条目上限。 */
const MAX_LIST_ENTRIES = 300

const CORE_PACKAGES = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-system-prompt',
]

function extOf(path) {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot).toLowerCase()
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 版本对账：全部内核包 name@version + 核心子集 + 运行时版本。 */
export function toolVersions(reader, filter) {
  const scope = reader.entryFromPath(KERNEL_SCOPE)
  const all = []
  for (const [name, entry] of Object.entries(scope?.files || {})) {
    if (!entry.files || !entry.files['package.json']) continue
    try {
      const manifest = JSON.parse(reader.readEntry(`${KERNEL_SCOPE}/${name}/package.json`, entry.files['package.json']).toString('utf8'))
      all.push({ name: `@deepseek-ai/${name}`, version: manifest.version || '?' })
    } catch {
      /* 坏清单跳过，不让一个包毁掉整个对账 */
    }
  }
  all.sort((a, b) => a.name.localeCompare(b.name))
  const core = Object.fromEntries(all.filter((p) => CORE_PACKAGES.includes(p.name)).map((p) => [p.name, p.version]))
  const runtime = {
    node: process.versions.node,
    electron: process.versions.electron || '',
    chrome: process.versions.chrome || '',
  }
  const needle = String(filter || '').toLowerCase()
  const packages = needle ? all.filter((p) => p.name.toLowerCase().includes(needle)) : null
  return { asar: reader.path, total: all.length, core, runtime, packages }
}

/** 列包内目录。 */
export function toolList(reader, packageName, dir) {
  const roots = packageRoots(reader, packageName)
  if (!roots.length) return { error: `package not found in asar: ${packageName}` }
  const target = dir ? `${roots[0]}/${String(dir).replace(/^\/+/, '')}` : roots[0]
  const entries = reader.listDir(target)
  if (!entries) return { error: `not a directory in asar: ${target}` }
  const truncated = entries.length > MAX_LIST_ENTRIES
  return { path: target, total: entries.length, entries: truncated ? entries.slice(0, MAX_LIST_ENTRIES) : entries, truncated }
}

/** 读包内文件，支持 M-N / head:N / tail:N / N 行号范围。 */
export function toolFile(reader, packageName, file, linesSpec) {
  const roots = packageRoots(reader, packageName)
  const clean = String(file || '').replace(/^\/+/, '')
  for (const root of roots) {
    const full = `${root}/${clean}`
    const text = reader.readText(full)
    if (text === null) continue
    const all = text.split('\n')
    const spec = String(linesSpec || '').trim()
    if (spec) {
      let match
      let pick
      let start
      if ((match = spec.match(/^head:(\d+)$/))) {
        start = 1
        pick = all.slice(0, Number(match[1]))
      } else if ((match = spec.match(/^tail:(\d+)$/))) {
        const n = Number(match[1])
        start = Math.max(1, all.length - n + 1)
        pick = all.slice(-n)
      } else if ((match = spec.match(/^(\d+)-(\d+)$/))) {
        start = Number(match[1])
        pick = all.slice(start - 1, Number(match[2]))
      } else if ((match = spec.match(/^(\d+)$/))) {
        start = Number(match[1])
        pick = [all[start - 1] ?? '']
      } else {
        return { error: `bad lines spec "${spec}" — use M-N / head:N / tail:N / N` }
      }
      return { path: full, totalLines: all.length, startLine: start, text: pick.map((line, i) => `${start + i} | ${line}`).join('\n') }
    }
    if (text.length > MAX_OUTPUT_CHARS) {
      return { path: full, totalLines: all.length, note: `truncated at ${MAX_OUTPUT_CHARS} chars of ${text.length}`, text: clip(text, MAX_OUTPUT_CHARS) }
    }
    return { path: full, totalLines: all.length, text }
  }
  return { error: `file not found in asar: tried ${roots.map((root) => `${root}/${clean}`).join(', ')}` }
}

/** 内核源码搜索：字面量（默认）或正则，限定单包或全内核作用域。 */
export function toolGrep(reader, { pattern, packageName, regex, maxResults }) {
  if (!pattern) return { error: 'pattern is required' }
  let re
  try {
    re = regex ? new RegExp(pattern) : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  } catch (error) {
    return { error: `bad pattern: ${error.message}` }
  }
  const roots = packageName ? packageRoots(reader, packageName) : [KERNEL_SCOPE]
  if (packageName && !roots.length) return { error: `package not found in asar: ${packageName}` }
  const limit = Math.min(Math.max(1, Number(maxResults) || 30), 200)
  const matches = []
  let filesScanned = 0
  let bytesScanned = 0
  let truncated = false
  let totalMatches = 0

  scan:
  for (const root of roots) {
    for (const [path, entry] of reader.walkFiles(root)) {
      if (!TEXT_EXTENSIONS.has(extOf(path))) continue
      if (entry.size > MAX_FILE_BYTES) continue
      if (bytesScanned + entry.size > MAX_TOTAL_BYTES) {
        truncated = true
        break scan
      }
      bytesScanned += entry.size
      filesScanned += 1
      const lines = reader.readEntry(path, entry).toString('utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          totalMatches += 1
          if (matches.length < limit) {
            matches.push({ path: `${path}:${i + 1}`, line: clip(lines[i].trim(), 240) })
          }
        }
      }
    }
  }
  return { matches, totalMatches, filesScanned, bytes: bytesScanned, truncated }
}
