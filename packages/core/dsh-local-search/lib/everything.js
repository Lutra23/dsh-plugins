/**
 * dsh-local-search · Everything HTTP 客户端与结果格式化（纯逻辑，不依赖 DSH 宿主）
 *
 * 与 VCP 原版 LocalSearchController 的差别（都是实测逼出来的）：
 *   1. 端口不写死：原版 VCPToolBox 侧无 .env → 硬编码 8025（本机是死的），
 *      VCPDistributedServer 侧 .env 指 80。这里改读 %APPDATA%\Everything\Everything.ini
 *      的 http_server_port，并在连接被拒时清缓存重读一次，实现换端口自愈。
 *   2. 多取两列：size_column / date_modified_column。原版只回路径列表，Agent 拿不到
 *      「该读哪一个」的判据；大小与修改时间正是分诊依据。
 *   3. date_modified 是 FILETIME（100ns 计数，1601 纪元），原版没用这列所以踩不到，
 *      这里必须换算，且换算正确性由 test/smoke.mjs 用 fs.statSync 交叉验证。
 *
 * 实测事实（2026-10-03，Everything HTTP on :80，n=500 不被 http_server_items_per_page=32 截断）：
 *   Content-Type: application/json（无 charset），正文是标准 UTF-8 —— Node 侧 toString('utf8')
 *   即可还原中文路径，无需任何编码修复。热查询端到端 56ms。
 */
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

/** Everything 的配置落点；http_server_port 在这里。 */
export const EVERYTHING_INI = join(process.env.APPDATA || '', 'Everything', 'Everything.ini')

/** Everything HTTP 服务器出厂默认端口。 */
export const DEFAULT_PORT = 80
export const DEFAULT_MAX_RESULTS = 100
/** 上限护栏：单次返回超过这个数对 Agent 没有额外价值，只会烧上下文。 */
export const HARD_MAX_RESULTS = 1000
export const DEFAULT_TIMEOUT_MS = 15000
/** 1601-01-01 → 1970-01-01 的毫秒数。 */
export const FILETIME_EPOCH_DIFF_MS = 11644473600000
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

let portCache = null

export function resetPortCache() {
  portCache = null
}

/**
 * 解析 Everything HTTP 端口：环境变量 > Everything.ini > 默认 80。
 * ini 读不到不是错误路径 —— 未装 Everything 时也要让后续连接错误给出可读诊断。
 */
export function resolvePort() {
  const forced = Number(process.env.DSH_EVERYTHING_PORT)
  if (Number.isInteger(forced) && forced > 0 && forced < 65536) return forced
  if (portCache !== null) return portCache
  let port = DEFAULT_PORT
  try {
    const m = /^http_server_port=(\d+)\s*$/m.exec(readFileSync(EVERYTHING_INI, 'utf8'))
    if (m) {
      const p = Number(m[1])
      if (p > 0 && p < 65536) port = p
    }
  } catch {
    // 读不到 ini：留在默认端口，由 diagnose() 报出准确原因
  }
  portCache = port
  return port
}

export function normalizeMaxResults(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_RESULTS
  return Math.min(Math.floor(n), HARD_MAX_RESULTS)
}

/** 单次 Everything JSON 查询。 */
export function queryEverything(port, query, maxResults, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const reqPath =
      '/?search=' + encodeURIComponent(query) +
      '&json=1&path_column=1&size_column=1&date_modified_column=1' +
      '&n=' + String(maxResults)
    const req = request({ host: '127.0.0.1', port, path: reqPath, method: 'GET' }, (res) => {
      const chunks = []
      let bytes = 0
      res.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('Everything 响应体超过 ' + MAX_RESPONSE_BYTES + ' 字节'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error('Everything HTTP 返回状态码 ' + res.statusCode))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (e) {
          reject(new Error('Everything 响应不是合法 JSON: ' + e.message))
        }
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Everything 查询超时（' + timeoutMs + 'ms）')))
    req.on('error', reject)
    req.end()
  })
}

function isConnError(e) {
  const c = e && e.code
  return c === 'ECONNREFUSED' || c === 'ECONNRESET' || c === 'EHOSTUNREACH' || c === 'ETIMEDOUT'
}

/**
 * 搜索本体。返回 { port, total, rows }；total 是真实命中总数，rows 受 maxResults 截断。
 * 端口自愈：ini 里改过端口时缓存值会让首次请求扑空 —— 重读 ini，只有端口确实变了才重试。
 */
export async function search(query, opts = {}) {
  const maxResults = normalizeMaxResults(opts.maxResults)
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS
  let port = resolvePort()
  let data
  try {
    data = await queryEverything(port, query, maxResults, timeoutMs)
  } catch (e) {
    if (!isConnError(e)) throw e
    resetPortCache()
    const again = resolvePort()
    if (again === port) throw e
    port = again
    data = await queryEverything(port, query, maxResults, timeoutMs)
  }
  return {
    port,
    total: Number(data.totalResults) || 0,
    rows: Array.isArray(data.results) ? data.results : [],
  }
}

/** FILETIME（100ns @1601）→ 本地时间 `YYYY-MM-DD HH:MM`；无效值返回空串。 */
export function formatFiletime(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n / 10000 - FILETIME_EPOCH_DIFF_MS)
  if (Number.isNaN(d.getTime())) return ''
  const p = (x) => String(x).padStart(2, '0')
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  )
}

/** 字节数说成人话。目录的 size 是空串，返回空串让调用方跳过。 */
export function humanBytes(raw) {
  const n = Number(raw)
  if (raw === '' || raw === null || raw === undefined || !Number.isFinite(n)) return ''
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}

/** 千分位分组，不依赖 locale。 */
export function group(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** path + name → 完整路径，容忍 Everything 给根目录时的尾部反斜杠。 */
export function joinPath(dir, name) {
  if (!dir) return name || ''
  return (dir.endsWith('\\') ? dir : dir + '\\') + (name || '')
}

/** 结果 → Agent 可读文本。 */
export function formatResults(query, total, rows) {
  if (rows.length === 0) {
    return '**本地秒搜 (Everything)** `' + query + '` — 没有命中任何文件。\n' +
      '换个写法试试：`ext:mp4`、`path:D:\\videos`、`*.pdf size:>10mb`、`dm:thisyear`、`"完整短语"`。'
  }
  const lines = [
    '**本地秒搜 (Everything)** `' + query + '`',
    '命中 **' + group(total) + '** 条' +
      (rows.length < total ? '，返回前 ' + rows.length + ' 条' : '，全部返回') + '：',
    '',
  ]
  rows.forEach((r, i) => {
    const isDir = r.type === 'folder'
    const full = joinPath(r.path, r.name)
    const bits = []
    if (isDir) bits.push('目录')
    else {
      const size = humanBytes(r.size)
      if (size) bits.push(size)
    }
    const time = formatFiletime(r.date_modified)
    if (time) bits.push(time)
    lines.push(
      (i + 1) + '. `' + (isDir && !full.endsWith('\\') ? full + '\\' : full) + '`' +
      (bits.length ? ' — ' + bits.join(' · ') : '')
    )
  })
  if (rows.length < total) {
    lines.push('')
    lines.push('> 结果被 `maxResults` 截断：调大它（上限 ' + HARD_MAX_RESULTS + '），或用 `path:` / `ext:` 收窄。')
  }
  return lines.join('\n')
}

/** 把底层错误翻成可执行的排查清单 —— 这个工具的失败几乎全是运维问题，不是逻辑问题。 */
export function diagnose(error) {
  const e = error || {}
  const message = String(e.message || e)
  const head = '**Everything 查询失败**: ' + message
  if (e.code === 'ECONNREFUSED') {
    const port = resolvePort()
    return head + '\n\n' + [
      '排查清单（代价从低到高）：',
      '1. Everything 是否在运行（托盘里的放大镜图标）；',
      '2. 工具 → 选项 → HTTP服务器 → 勾选「启用 HTTP 服务器」，端口须与 `' + EVERYTHING_INI + '` 的 `http_server_port` 一致（当前读到 **' + port + '**）；',
      '3. 改过端口不必重启 DSH —— 连接被拒时本工具会重读 ini 自愈；',
      '4. 也可用环境变量 `DSH_EVERYTHING_PORT` 直接钉死端口。',
    ].join('\n')
  }
  if (message.includes('超时')) {
    return head + '\n\nEverything 索引通常毫秒级返回，超时多半是查询过宽（空关键词会命中全盘）。' +
      '收窄关键词，或调大 `DSH_EVERYTHING_TIMEOUT_MS`（当前 ' + DEFAULT_TIMEOUT_MS + 'ms 为默认）。'
  }
  return head
}
