/**
 * 速记渲染器的真实浏览器试验台。
 *
 * 用 node:http 起一个小服务，把 lib/client.js **原样**送到 Chromium，
 * 配一份 mock 的 list 端点与 1x1 PNG，页面把结论写进 document.title 与
 * #result 供外部读取。
 *
 * 为什么需要它：速记渲染器的失效面全在浏览器侧——模块加载、槽位注册、
 * MutationObserver 时序、React 之外的 DOM 变更。这些在 Node 里跑不出来。
 * 尤其要能复现「页面存在常驻 DOM 变更时，防抖被饿死、flush 永不执行」
 * 这类只在真实环境暴露的缺陷。
 *
 * 用法：node test/shortcut-browser/serve.cjs [port]
 *   http://127.0.0.1:<port>/?noise=0   静态页面
 *   http://127.0.0.1:<port>/?noise=1   每 100ms 变更一次 DOM 的干扰源
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const PORT = Number(process.argv[2] || 8931)
const ROOT = __dirname
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..')

/** mock 库内容：含默认宽命中的、带 @ 的、以及用于验证「未知名保持原文」的缺项。 */
const NAMES = ['轻松拿捏', '@_@', '思考', '完工撒花']

/** 1x1 透明 PNG，只为让 <img> 有真实字节可加载。 */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

/** 回一份 JSON。 */
function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** 回一份静态文件。 */
function file(res, abs, type) {
  let buf
  try {
    buf = fs.readFileSync(abs)
  } catch {
    res.writeHead(404)
    res.end('missing: ' + abs)
    return
  }
  res.writeHead(200, { 'content-type': type, 'content-length': buf.length })
  res.end(buf)
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/api/dsh-emoji/list') {
      return json(res, 200, { items: NAMES.map((name) => ({ name })), count: NAMES.length })
    }
    if (url.pathname === '/api/dsh-emoji/image') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PIXEL.length })
      return res.end(PIXEL)
    }
    if (url.pathname === '/lib/client.js') {
      return file(res, path.join(PLUGIN_ROOT, 'lib', 'client.js'), 'text/javascript; charset=utf-8')
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return file(res, path.join(ROOT, 'index.html'), 'text/html; charset=utf-8')
    }
    res.writeHead(404)
    res.end('nope')
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log('harness ready: http://127.0.0.1:' + PORT)
  })
