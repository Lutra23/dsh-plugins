/**
 * 回环信任围栏。
 *
 * 分两档，因为读端点和写端点的风险根本不同：
 *
 *   write（导入 / 扫描 / 删除 / 配置 / 清缓存）——真的改磁盘，用完整判据：
 *     1. socket.remoteAddress 落在 127/8 或 ::1（含 IPv4-mapped）
 *     2. Host 头解析出的主机名同样是回环字面量（挡 DNS rebinding）
 *     3. 浏览器同源标记：sec-fetch-site 不得为 cross-site；Origin 若存在必须同源
 *
 *   read（出图 / 列表 / 健康 / 诊断）——只吐 images/ 里已有的图，用前两条：
 *     socket 回环 + Host 回环。
 *
 * 读端点为什么不能带上第三条：页面里的 <img> 与 fetch 会带 sec-fetch-site，
 * 而它与页面自身的来源强相关。GUI 可能以 localhost 提供、也可能由 Electron
 * 用 file:// 承载，这时请求 127.0.0.1 就是 cross-site，第三条会把自家界面
 * 的图片请求一起挡掉——第一版就是这么把图片拦成「无法预览」的。
 * 去掉它不削弱真正的边界：socket 回环是硬约束，外部机器根本连不上；
 * 而图片即使被本机某个网页取走，也只是 <img> 的 no-cors 加载，跨源读不到像素。
 *
 * X-Forwarded-For 永不采信——它可被伪造，socket 地址不能。
 */

/** IPv4 127/8 判定：四段十进制，首段为 127，各段 0-255。 */
function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/** socket 远端地址是否属于回环范围（127/8、::1、IPv4-mapped）。 */
function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = String(address).toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/** 规范化后的 URL 主机名是否为回环权威。 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * 第一档：socket 与 Host 都是回环。读端点的判据。
 * @param request - 入站 HTTP 请求。
 * @returns 是否来自本机回环。
 */
export function isLoopbackPeer(request) {
  if (!isLoopbackAddress(request.socket && request.socket.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  try {
    return isLoopbackHostname(new URL('http://' + host).hostname)
  } catch {
    return false
  }
}

/**
 * 第二档：在第一档之上再加浏览器同源标记。写端点的判据。
 * @param request - 入站 HTTP 请求。
 * @returns 该请求是否被允许。
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackPeer(request)) return false
  const host = request.headers.host
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** 最近被拒的请求摘要（环形缓冲），供 /api/dsh-emoji/diag 排查。 */
const rejections = []
const MAX_REJECTIONS = 24

/**
 * 记一条拒绝。诊断端点存在的意义是：围栏一旦误伤，不必猜、也不必重启第二次。
 */
function recordRejection(request, stage) {
  rejections.push({
    at: new Date().toISOString(),
    method: request.method,
    url: String(request.url || '').slice(0, 200),
    stage,
    remote: (request.socket && request.socket.remoteAddress) || null,
    headers: {
      host: request.headers.host ?? null,
      origin: request.headers.origin ?? null,
      secFetchSite: request.headers['sec-fetch-site'] ?? null,
      secFetchMode: request.headers['sec-fetch-mode'] ?? null,
      secFetchDest: request.headers['sec-fetch-dest'] ?? null,
      referer: request.headers.referer ?? null,
      userAgent: String(request.headers['user-agent'] || '').slice(0, 90),
    },
  })
  if (rejections.length > MAX_REJECTIONS) rejections.shift()
}

/** 读取最近的拒绝记录（新→旧）。 */
export function recentRejections() {
  return [...rejections].reverse()
}

/** 清空拒绝记录。 */
export function clearRejections() {
  rejections.length = 0
}

/** 默认 JSON 请求体上限：16 MiB。导入的图片走 base64 时会膨胀 4/3，故给足余量。 */
export const DEFAULT_JSON_BODY_MAX_BYTES = 16 * 1024 * 1024

/**
 * 有界地读取并解析 JSON 请求体。空体、非法 JSON 或超过上限一律返回 null
 * （超限时销毁请求而不是继续读取，调用方此后不得再读）。
 * @param req - 入站请求。
 * @param opts - maxBytes 上限、objectOnly 是否只接受 JSON 对象。
 * @returns 解析结果，或 null。
 */
export async function readJsonBody(req, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_JSON_BODY_MAX_BYTES
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      req.destroy()
      return null
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    const parsed = JSON.parse(text)
    if (opts.objectOnly === true && !isJsonObject(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/** 值是否为 JSON 对象：typeof object、非 null、非数组。 */
export function isJsonObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 家族统一的 JSON 响应头。 */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
}

/** 写一个 JSON 响应。调用方 headers 可追加或覆盖默认值。 */
export function writeJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, ...headers })
  res.end(payload)
}

/** 共用的守卫骨架：判定放行、方法校验、拒绝记录。 */
function runGuard(req, res, method, level) {
  const allowed = level === 'write' ? isLoopbackRequest(req) : isLoopbackPeer(req)
  if (!allowed) {
    recordRejection(req, level)
    writeJson(res, 403, { error: 'forbidden: loopback-only', level })
    return false
  }
  if (req.method !== method) {
    writeJson(res, 405, { error: `method not allowed: ${req.method}` })
    return false
  }
  return true
}

/**
 * 只读端点守卫：socket + Host 回环即可。
 * @param req - 入站请求。
 * @param res - 响应。
 * @param method - 要求的 HTTP 方法。
 * @returns 是否放行。
 */
export function guardRead(req, res, method = 'GET') {
  return runGuard(req, res, method, 'read')
}

/**
 * 写端点守卫：在只读判据之上再加浏览器同源标记。
 * @param req - 入站请求。
 * @param res - 响应。
 * @param method - 要求的 HTTP 方法。
 * @returns 是否放行。
 */
export function guardWrite(req, res, method = 'POST') {
  return runGuard(req, res, method, 'write')
}
