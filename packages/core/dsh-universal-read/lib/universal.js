/**
 * dsh-universal-read · 纯逻辑层：stdio 桥接 VCP FileOperator.js 的只读三命令 + 输出整形。
 * 不依赖 DSH 宿主（spawn 由调用方注入），以便 smoke 直接测。
 *
 * 为什么是桥接而不是原生重写（与 dsh-local-search 那次相反的结论，理由同样写死）：
 *   1. 价值在解析器，不在传输。pdf-parse / mammoth / exceljs / chardet 四个 npm 包
 *      已经装在 VCPToolBox\node_modules 里且版本与 FileOperator.js 锁死 —— 桥接 = 零安装、
 *      零复刻解析逻辑；重写 = 把 1963 行的坑（OOXML 行尾、CSV 流、图片 dataURI…）再踩一遍。
 *      上次选原生是因为原插件只有 40 行纯 HTTP、零依赖；这次反过来，听证据不听惯性。
 *   2. 安全门复用。isPathAllowed / MAX_FILE_SIZE / 白名单语义全部留在原版里，本包不重写
 *      半吊子护栏 —— 读能力越强，越不能自己造门。
 *   3. 原版 1963 行里只有 ReadFile / WebReadFile / DownloadFile 三个命令是本包要的。
 *      桥接层不设自由 command 参数（调用方连 command 字段都摸不到），写操作在协议层就不可达。
 *
 * 原版 stdio 协议（实测 2026-10-03）：
 *   - stdin 按行喂 JSON（单条 `{command, ...params}`），逐行回 JSON 信封 `{status, result|error}`；
 *   - debugLog 全部走 stderr，stdout 干净，可直接按行 JSON.parse；
 *   - stdin 关闭且事件循环排空后进程自然退出（exit 0），无需 kill；
 *   - chardet 没装也不影响：BOM→chardet→utf8 fallback 三级降级，txt 头里 confidence: fallback 照读。
 */
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'

/** VCPToolBox 根目录：环境变量 DSH_VCP_ROOT 优先（部署口径与 dsh-code-tools 的 VCP_ROOT 一致），
 *  否则默认 ~/Desktop/VCPToolBox。对 universal_read 而言只需 VCPToolBox 的插件文件与 node_modules，
 *  不要求 VCP 服务端在跑。 */
export const VCP_ROOT = process.env.DSH_VCP_ROOT || join(homedir(), 'Desktop', 'VCPToolBox')

/** 原版入口与工作目录：cwd 钉死在这里，require 才能一路向上找到 VCPToolBox\node_modules。 */
export const FO_ENTRY = join(VCP_ROOT, 'Plugin', 'FileOperator', 'FileOperator.js')
export const FO_CWD = join(VCP_ROOT, 'Plugin', 'FileOperator')

/** 读本地文件通常 <1s（实测 825-975ms 含 node 启动）；给足余量但不无限等。 */
export const READ_TIMEOUT_MS = 60000
/** url 两条路都要走网络；DownloadFile 在桥接下是同步落盘（进程退出 = 下载完成），给 300s。 */
export const REMOTE_TIMEOUT_MS = 300000
/** wrapper 内 spawnSync 的 maxBuffer；超过它说明调用方该用 lines 分页而不是全量读。 */
export const MAX_STDOUT_BYTES = 32 * 1024 * 1024
/** 返回给模型的文本上限（字符）。超了就截断并指路分页，烧上下文没有意义。 */
export const MAX_TEXT_CHARS = 40000
export const VALID_MODES = ['read', 'download']

function normStr(v) {
  if (v === undefined || v === null) return ''
  const s = String(v).trim()
  return s
}

/**
 * 工具参数 → 原版请求。只产出三个只读命令之一，永远不透出自由 command 字段。
 * 返回 { request, timeoutMs, kind } 或 { error }。
 */
export function buildRequest(a) {
  const args = a || {}
  const filePath = normStr(args.filePath)
  const url = normStr(args.url)
  const lines = args.lines === undefined || args.lines === null ? '' : String(args.lines).trim()
  const mode = normStr(args.mode) || 'read'
  if (!filePath && !url) {
    return { error: '缺少 filePath 或 url：读本地文件给 filePath（绝对路径），读网上文件给 url。二者一次只给一个。' }
  }
  if (filePath && url) {
    return { error: 'filePath 与 url 一次只能给一个：本地读与网上读是两条路。' }
  }
  if (!VALID_MODES.includes(mode)) {
    return { error: `mode 非法：'${mode}'，只能是 read（取回文本）或 download（只存文件，返回落盘路径）。` }
  }
  if (url) {
    let u
    try {
      u = new URL(url)
    } catch {
      return { error: `url 不是合法地址：${url}` }
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { error: `url 只支持 http/https（收到了 ${u.protocol}）：${url}` }
    }
    if (mode === 'download') {
      const dd = normStr(args.downloadDir)
      if (dd && !isAbsolute(dd)) {
        return { error: `downloadDir 必须是绝对路径（收到了相对路径）：${dd}` }
      }
      const fn = normStr(args.fileName)
      if (fn && (/[/\\]/.test(fn) || fn === '.' || fn === '..')) {
        return { error: `fileName 只能是纯文件名，不能含路径（收到了）：${fn}` }
      }
      const req = { command: 'DownloadFile', url }
      if (dd) req.downloadDir = dd
      if (fn) req.fileName = fn
      return { request: req, timeoutMs: REMOTE_TIMEOUT_MS, kind: 'download' }
    }
    const req = { command: 'WebReadFile', url }
    if (lines) req.lines = lines
    return { request: req, timeoutMs: REMOTE_TIMEOUT_MS, kind: 'webread' }
  }
  // 本地读：相对路径会被原版默默解析到 VCPToolBox 根下，极易误读 —— 在本层直接拒绝。
  if (!isAbsolute(filePath)) {
    return { error: `filePath 必须是绝对路径（收到了相对路径，已拒绝，避免被解析到 VCPToolBox 根下）：${filePath}` }
  }
  const req = { command: 'ReadFile', filePath }
  if (lines) req.lines = lines
  return { request: req, timeoutMs: READ_TIMEOUT_MS, kind: 'read' }
}

/**
 * 一次性桥接：起 node -e wrapper，wrapper 内 spawnSync 原版进程（timeout/maxBuffer 受控）。
 * spawnFn 签名 = ctx.subprocess.spawn(spec)；nodeBin = node 可执行文件路径。
 * envExtra 仅供 smoke 做隔离（换 WEB_FILE_DIR/DEFAULT_DOWNLOAD_DIR 到临时目录），生产传 {}。
 */
export async function runBridge(spawnFn, nodeBin, request, timeoutMs, envExtra) {
  const script =
    `const {spawnSync}=require('child_process');` +
    `const plugin=process.env.UR_PLUGIN, cwd=process.env.UR_CWD, t=parseInt(process.env.UR_TIMEOUT,10), max=parseInt(process.env.UR_MAX,10);` +
    `let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{` +
    `const r=spawnSync(process.execPath,[plugin],{input:raw,cwd,encoding:'utf8',timeout:t,maxBuffer:max});` +
    `if(r.error){process.stderr.write(String(r.error.message));process.exit(2);}` +
    `if(r.status!==0){process.stderr.write(String((r.stderr||'')+(r.error?(' '+r.error.message):'')));process.exit(r.status||2);}` +
    `process.stdout.write(r.stdout);});`
  const handle = spawnFn({
    argv: [nodeBin, '-e', script],
    cwd: FO_CWD,
    stdio: {
      stdin: { data: JSON.stringify(request) + '\n' },
      stdout: { maxBytes: 4 * 1024 * 1024, spill: { maxBytes: 64 * 1024 * 1024 } },
      stderr: { maxBytes: 100 * 1024, spill: { maxBytes: 1024 * 1024 } },
    },
    env: {
      ...(envExtra || {}),
      UR_PLUGIN: FO_ENTRY,
      UR_CWD: FO_CWD,
      UR_TIMEOUT: String(timeoutMs),
      UR_MAX: String(MAX_STDOUT_BYTES),
      // config.env 里 DEBUG_MODE=true，stderr 会刷屏；dotenv 不覆盖已有环境变量，这里显式压住。
      DEBUG_MODE: 'false',
    },
    graceMs: 3000,
  })
  const outcome = await handle.done
  const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0) : { text: '' }
  const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0) : { text: '' }
  if (outcome.exitCode !== 0) {
    const tail = String(err.text || '').slice(-500)
    const e = new Error('FileOperator 进程退出码=' + String(outcome.exitCode) + (tail ? ' | ' + tail : ''))
    e.exitCode = outcome.exitCode
    e.stderr = err.text || ''
    throw e
  }
  return out.text || ''
}

/**
 * stdout 按行解析信封。正常只有一行；理论上若请求被 stdin 分片送达，原版会先吐一行
 * 'Invalid request format' 再吐真正的响应 —— 取最后一条有效信封即可覆盖两种情形。
 */
export function parseEnvelope(text) {
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  let last = null
  for (const line of lines) {
    try {
      const j = JSON.parse(line)
      if (j && typeof j.status === 'string') last = j
    } catch {
      // 非 JSON 行（理论上不应出现）直接跳过
    }
  }
  if (!last) throw new Error('FileOperator 响应无法解析：' + String(text).slice(0, 300))
  return last
}

/** 超长文本截断：在行边界处断，附总数与分页指路。 */
export function truncateText(text, limit) {
  const s = String(text || '')
  if (s.length <= limit) return { text: s, truncated: false, total: s.length }
  let cut = s.lastIndexOf('\n', limit)
  if (cut < limit * 0.5) cut = limit
  return {
    text: s.slice(0, cut) + `\n\n…（已截断，全文约 ${s.length} 字符。用 lines 分页取：lines='head:N' / 'tail:N' / 'M-N'）`,
    truncated: true,
    total: s.length,
  }
}

/**
 * 信封 → 展示文本。原版的中文头已经是给 Agent 看的，原样保留，只做三件事：
 * 1) image/audio/video 的 dataURI 块不贴字节（动辄 MB），换成指引（图片指到 read_image）；
 * 2) webread/download 把落盘路径单拎出来放末尾；
 * 3) 超长截断。
 */
export function shapeOutput(env, info) {
  const meta = info || {}
  if (!env || env.status === 'error') {
    return '**universal_read 失败**：' + ((env && env.error) || '未知错误')
  }
  const blocks = (env.result && env.result.content) || []
  const parts = []
  for (const b of blocks) {
    if (!b) continue
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text)
    } else if (b.type === 'image_url') {
      const where = meta.filePath || meta.url || '未知文件'
      parts.push('[图片已省略：' + where + ' —— 用 read_image 按该路径查看，不要让模型读 base64]')
    }
  }
  const det = (env.result && env.result.details) || {}
  if (meta.kind === 'download') {
    if (det.path) parts.push('落盘路径：`' + det.path + '`' + (det.renamed ? '（重名，已自动加序号）' : ''))
    if (det.sourceUrl && det.sourceUrl !== meta.url) parts.push('来源：' + det.sourceUrl)
  } else if (meta.kind === 'webread') {
    if (det.localPath) parts.push('已存本地：`' + det.localPath + '`')
  }
  const shaped = truncateText(parts.join('\n'), MAX_TEXT_CHARS)
  return shaped.text
}

/** 底层错误 → 可执行信息。读失败几乎总是三类：太大、被拒、超时。 */
export function diagnose(err) {
  const m = String((err && err.message) || err)
  if (/timed out|timeout/i.test(m)) {
    return '**universal_read 超时**：' + m + '\n读大文件时用 lines 分页（`head:N` / `M-N`）；DownloadFile 的大文件可能超过 300s 上限。注意：超时杀掉的下载可能留下半截文件，读之前先确认大小。'
  }
  if (/ENOENT/i.test(m)) {
    return '**universal_read 失败**：找不到 node 或 VCP 原版进程（VCPToolBox 被移动/删除？）：' + m
  }
  if (/Access denied/i.test(m)) {
    return '**universal_read 被原版安全门拒绝**：' + m + '\n读命令只对绝对路径放行；DownloadFile 的目标目录受 ALLOWED_DIRECTORIES 约束，换 downloadDir 或检查 VCP 侧 config.env。'
  }
  return '**universal_read 失败**：' + m
}
