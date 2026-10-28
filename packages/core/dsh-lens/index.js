/**
 * dsh-lens — 内核透镜插件（host 半）。
 *
 * 把 app.asar 里的内核包变成四个可直读的工具：
 *   kernel_versions  全部 @deepseek-ai/* 包版本 + 运行时对账
 *   kernel_list      列内核包内某目录的文件
 *   kernel_file      读内核包内某个文件（支持行号范围）
 *   kernel_grep      在内核源码里按字面量/正则搜索
 *
 * 动机：内核 300+ 个包封装在单文件 asar 归档里，AST 索引器与外部子进程
 * 都看不见（code_searcher 对归档路径直接拒绝）；每次内核考古都要重写
 * 一遍 asar 头解析器（2026-10-04 的 _asar-research 脚本、2026-10-26 的
 * asarver/asartool 系列，都是同一件事的重复劳动）。把它固化成工具，
 * 单次调查从「写脚本 + 多次 bash 往返」降到一次调用。
 *
 * 稳定性纪律：asar 定位失败只让当次工具调用报错，绝不让插件启动失败；
 * 读取全部只读；reader 惰性建立、进程内单例复用。
 *
 * 方言备忘：本内核 defineTool 必带 output.render（execute 返回值经它
 * 封成 {title, content} 信封，L842 直接解构 options.output）。
 *
 * @module dsh-lens
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { AsarReader, resolveAsarPath } from './lib/lens.js'
import { toolVersions, toolList, toolFile, toolGrep } from './lib/queries.js'

export const name = 'dsh-lens'
export const inject = ['tools']

export const Config = z.object({
  /** 空 = 自动定位（DSH_LENS_ASAR > resourcesPath > execPath 同级）。 */
  asarPath: z.string().default(''),
})

const human = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)}MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`)

/** output 块：schema 声明 string，render 把 execute 返回值封成 content 数组（形状照抄本机现役 vcp-tools）。 */
const out = () => ({
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
})

export function apply(ctx, config) {
  const log = ctx.logger(name)
  let reader = null

  const getReader = () => {
    if (!reader) {
      reader = new AsarReader(resolveAsarPath(config.asarPath)).open()
      log.info('lens ready: %s (%d files)', reader.path, reader.countFiles())
    }
    return reader
  }

  ctx.effect(() => {
    const disposers = []

    disposers.push(ctx.tools.register(defineTool({
      name: 'kernel_versions',
      description: 'Read the installed kernel\'s package versions straight from app.asar: core @deepseek-ai packages (dsh, cordis, dsh-tools, dsh-agent, dsh-subagent, dsh-llm, dsh-session, dsh-web…) plus node/electron/chrome runtime. Use it for "which kernel version is this / is package X present / version reconciliation" — one call replaces hand-writing an asar parser.',
      parameters: {
        filter: { type: 'string', description: 'Optional substring: only list packages whose name contains it (case-insensitive), e.g. "ui-settings". Omit for a compact core summary.' },
      },
      output: out('kernel_versions'),
      async execute(args) {
        const result = toolVersions(getReader(), args.filter || '')
        const core = Object.entries(result.core).map(([pkg, version]) => `${pkg.replace('@deepseek-ai/', '')}@${version}`).join(' · ')
        const lines = [
          `asar: ${result.asar}`,
          `runtime: node ${result.runtime.node}${result.runtime.electron ? ` · electron ${result.runtime.electron}` : ''}${result.runtime.chrome ? ` · chrome ${result.runtime.chrome}` : ''}`,
          `core: ${core}`,
          `@deepseek-ai/* packages: ${result.total}`,
        ]
        if (result.packages) {
          lines.push('')
          if (!result.packages.length) lines.push(`(no package name contains "${args.filter}")`)
          for (const pkg of result.packages) lines.push(`${pkg.name}@${pkg.version}`)
        }
        return lines.join('\n')
      },
    })))

    disposers.push(ctx.tools.register(defineTool({
      name: 'kernel_list',
      description: 'List the files of one kernel package inside app.asar (directories first, name-sorted, sizes shown). Accepts "@deepseek-ai/dsh-tools" or short "dsh-tools"; optional dir like "lib". Use it before kernel_file to discover real paths.',
      parameters: {
        package: { type: 'string', required: true, description: 'Kernel package name, e.g. "@deepseek-ai/dsh-tools" or "dsh-tools".' },
        dir: { type: 'string', description: 'Optional subdirectory inside the package (e.g. "lib"); omit to list the package root.' },
      },
      output: out('kernel_list'),
      async execute(args) {
        const result = toolList(getReader(), args.package, args.dir || '')
        if (result.error) throw new Error(result.error)
        const rows = result.entries.map((entry) => (entry.dir ? `  d ${entry.name}/` : `  - ${entry.name}  ${human(entry.size)}`))
        return [`${result.path} · ${result.total} entries${result.truncated ? ' (truncated)' : ''}`, ...rows].join('\n')
      },
    })))

    disposers.push(ctx.tools.register(defineTool({
      name: 'kernel_file',
      description: 'Read one file of a kernel package straight from app.asar (package.json, lib/index.js, README.md…). Optional lines spec: "M-N" / "head:N" / "tail:N" / "N" (numbered like ReadCode). Whole-file output is truncated at 200KB with a note. Use it when AST/Read tools cannot see the archive.',
      parameters: {
        package: { type: 'string', required: true, description: 'Kernel package name, e.g. "@deepseek-ai/dsh-web" or "dsh-web".' },
        file: { type: 'string', required: true, description: 'File path inside the package, e.g. "lib/index.js" or "package.json".' },
        lines: { type: 'string', description: 'Optional line range: "M-N" / "head:N" / "tail:N" / single line number N.' },
      },
      output: out('kernel_file'),
      async execute(args) {
        const result = toolFile(getReader(), args.package, args.file, args.lines || '')
        if (result.error) throw new Error(result.error)
        const header = `${result.path} · ${result.totalLines} lines${result.note ? ` · ${result.note}` : ''}`
        return `${header}\n\n${result.text}`
      },
    })))

    disposers.push(ctx.tools.register(defineTool({
      name: 'kernel_grep',
      description: 'Search kernel source inside app.asar for a literal (default) or regex pattern. Scope to one package via package ("dsh-subagent"), or omit it to scan all @deepseek-ai/* (~100MB, takes seconds). Returns "path:line: text" matches with scan totals. Use it for "which kernel package mentions/defines X" — the AST tools cannot see inside the archive.',
      parameters: {
        pattern: { type: 'string', required: true, description: 'What to search: literal text by default; set regex:true to treat it as a RegExp.' },
        package: { type: 'string', description: 'Optional kernel package to scope the scan, e.g. "dsh-tools". Omit to scan the whole @deepseek-ai scope.' },
        regex: { type: 'boolean', description: 'Parse pattern as a RegExp instead of a literal. Default false.' },
        max_results: { type: 'number', description: 'Maximum matches returned (default 30, hard cap 200). Total count is reported regardless.' },
      },
      output: out('kernel_grep'),
      async execute(args) {
        const result = toolGrep(getReader(), args)
        if (result.error) throw new Error(result.error)
        const shorten = (path) => path.replace(/^node_modules\/@deepseek-ai\//, '')
        const lines = [
          `${result.totalMatches} match(es) in ${result.filesScanned} files · ${human(result.bytes)} scanned${result.truncated ? ' · TRUNCATED (byte budget hit — narrow the package)' : ''}`,
          '(path prefix node_modules/@deepseek-ai/ omitted)',
          '',
          ...result.matches.map((match) => `${shorten(match.path)}: ${match.line}`),
        ]
        if (!result.matches.length) lines.push('(no match)')
        return lines.join('\n')
      },
    })))

    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}
