#!/usr/bin/env node
/**
 * dsh-universal-read 冒烟：单元（纯函数）＋ 端到端（真 FileOperator 子进程、真 PDF/docx/xlsx、本地 HTTP 服务器覆盖 URL 两条路）。
 * 不碰外网；WebReadFile 默认落盘与下载目录全部隔离到临时目录，不污染 VCP 侧。
 * 缺失的真机样本（用户文件被移动）明确 SKIP，不装过。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import plugin from '../lib/index.js'
import * as U from '../lib/universal.js'

let pass = 0
let fail = 0
let skip = 0

function check(name, fn) {
  try {
    fn()
    pass++
    console.log('  PASS  ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL  ' + name)
    console.log('        ' + String(e && e.message).split('\n').join('\n        '))
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    pass++
    console.log('  PASS  ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL  ' + name)
    console.log('        ' + String(e && e.message).split('\n').join('\n        '))
  }
}

/* ------------------------------------------------------------------ 单元 */
console.log('\n=== [单元] buildRequest：只产出只读三命令 ===')

check('缺 filePath 又缺 url', () => {
  assert.match(U.buildRequest({}).error, /filePath 或 url/)
})

check('两者都给', () => {
  assert.match(U.buildRequest({ filePath: 'C:\\a.txt', url: 'https://x/y' }).error, /一次只能给一个/)
})

check('相对 filePath 被拒绝', () => {
  assert.match(U.buildRequest({ filePath: 'Plugin\\foo\\bar.txt' }).error, /必须是绝对路径/)
  assert.match(U.buildRequest({ filePath: '..\\x.txt' }).error, /必须是绝对路径/)
})

check('非法 url 与非 http 协议', () => {
  assert.match(U.buildRequest({ url: '不是地址' }).error, /不是合法地址/)
  assert.match(U.buildRequest({ url: 'ftp://x/y.zip' }).error, /只支持 http\/https/)
  assert.match(U.buildRequest({ url: 'file:///C:/x.txt' }).error, /只支持 http\/https/)
})

check('mode 非法', () => {
  assert.match(U.buildRequest({ url: 'https://x/y', mode: 'write' }).error, /只能是 read.*download/)
})

check('本地读透传 lines（含数字）', () => {
  const r = U.buildRequest({ filePath: 'C:\\a\\b.txt', lines: 'head:5' })
  assert.deepEqual(r.request, { command: 'ReadFile', filePath: 'C:\\a\\b.txt', lines: 'head:5' })
  assert.equal(r.kind, 'read')
  assert.equal(r.timeoutMs, U.READ_TIMEOUT_MS)
  const n = U.buildRequest({ filePath: 'C:\\a.txt', lines: 5 })
  assert.equal(n.request.lines, '5')
})

check('url 默认走 WebReadFile', () => {
  const r = U.buildRequest({ url: 'https://x/doc.pdf', lines: '1-10' })
  assert.deepEqual(r.request, { command: 'WebReadFile', url: 'https://x/doc.pdf', lines: '1-10' })
  assert.equal(r.kind, 'webread')
  assert.equal(r.timeoutMs, U.REMOTE_TIMEOUT_MS)
})

check('download 透传目录与改名，并硬化两者', () => {
  const r = U.buildRequest({ url: 'https://x/p.zip', mode: 'download', downloadDir: 'D:\\dl', fileName: 'p2.zip' })
  assert.deepEqual(r.request, { command: 'DownloadFile', url: 'https://x/p.zip', downloadDir: 'D:\\dl', fileName: 'p2.zip' })
  assert.equal(r.kind, 'download')
  assert.match(U.buildRequest({ url: 'https://x/p.zip', mode: 'download', downloadDir: 'dl' }).error, /必须是绝对路径/)
  assert.match(U.buildRequest({ url: 'https://x/p.zip', mode: 'download', fileName: '..\\evil.zip' }).error, /只能是纯文件名/)
  assert.match(U.buildRequest({ url: 'https://x/p.zip', mode: 'download', fileName: 'a/b.zip' }).error, /只能是纯文件名/)
})

console.log('\n=== [单元] 信封解析 / 截断 / 整形 / 诊断 ===')

check('parseEnvelope 取最后一条有效信封；垃圾进垃圾出', () => {
  const env = U.parseEnvelope('{"status":"error","error":"Invalid request format: x"}\n{"status":"success","result":{"content":[]}}\n')
  assert.equal(env.status, 'success')
  assert.throws(() => U.parseEnvelope('not json at all\n'), /无法解析/)
  assert.throws(() => U.parseEnvelope('   \n  '), /无法解析/)
})

check('truncateText 短文原样、长文行边界断', () => {
  const a = U.truncateText('abc', 100)
  assert.deepEqual([a.text, a.truncated], ['abc', false])
  const long = 'L1\nL2\n' + 'x'.repeat(500)
  const b = U.truncateText(long, 10)
  assert.ok(b.truncated && b.text.startsWith('L1\nL2\n') && /lines 分页/.test(b.text))
  const noNl = 'z'.repeat(500)
  const c = U.truncateText(noNl, 100)
  assert.ok(c.truncated && c.text.length <= 100 + 120)
})

check('shapeOutput 拼文本块、图片块换指引、下载落盘单拎', () => {
  const t = U.shapeOutput({ status: 'success', result: { content: [{ type: 'text', text: '头' }, { type: 'text', text: '正文' }] } }, {})
  assert.equal(t, '头\n正文')
  const img = U.shapeOutput(
    { status: 'success', result: { content: [{ type: 'text', text: '头' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] } },
    { filePath: 'C:\\p.png' }
  )
  assert.match(img, /read_image/)
  assert.ok(!/base64,AAA/.test(img))
  const dl = U.shapeOutput(
    { status: 'success', result: { content: [{ type: 'text', text: 'msg' }], details: { path: 'D:\\dl\\p.zip', renamed: true } } },
    { kind: 'download' }
  )
  assert.match(dl, /落盘路径：`D:\\dl\\p\.zip`.*重名/)
  const web = U.shapeOutput(
    { status: 'success', result: { content: [{ type: 'text', text: 'msg' }], details: { localPath: 'D:\\f\\a.txt' } } },
    { kind: 'webread' }
  )
  assert.match(web, /已存本地：`D:\\f\\a\.txt`/)
  assert.match(U.shapeOutput({ status: 'error', error: 'boom' }, {}), /失败.*boom/)
})

check('diagnose 三类可执行信息', () => {
  assert.match(U.diagnose(new Error('spawnSync ETIMEDOUT killed, timed out after 300000ms')), /lines 分页/)
  assert.match(U.diagnose(new Error('spawn node ENOENT')), /node 或 VCP/)
  assert.match(U.diagnose(new Error('Access denied: Path x')), /ALLOWED_DIRECTORIES/)
  assert.match(U.diagnose(new Error('weird thing')), /weird thing/)
})

/* ------------------------------------------------- 宿主桩：真子进程 */
console.log('\n=== [工具契约] 注册与参数校验（不 spawn 即拦） ===')

let spawnCalls = 0
function stubSpawn(spec) {
  spawnCalls++
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, ...(spec.env || {}) },
    windowsHide: true,
  })
  const outChunks = []
  const errChunks = []
  child.stdout.on('data', (c) => outChunks.push(c))
  child.stderr.on('data', (c) => errChunks.push(c))
  try {
    child.stdin.write(String((spec.stdio && spec.stdio.stdin && spec.stdio.stdin.data) || ''))
    child.stdin.end()
  } catch {
    // 寫 stdin 失敗交給 done 判定
  }
  const done = new Promise((resolve) => {
    child.on('error', () => resolve({ exitCode: 2 }))
    child.on('close', (code) => resolve({ exitCode: code === null || code === undefined ? 2 : code }))
  })
  return {
    done,
    collected: {
      stdout: { readFrom() { return { text: Buffer.concat(outChunks).toString('utf8') } } },
      stderr: { readFrom() { return { text: Buffer.concat(errChunks).toString('utf8') } } },
    },
  }
}

const registered = []
const stubCtx = {
  subprocess: {
    resolveExecutable: async () => process.execPath,
    spawn: stubSpawn,
  },
  tools: { register(tool) { registered.push(tool) } },
}
plugin.apply(stubCtx)
const tool = registered[0]

check('插件导出与注册', () => {
  assert.equal(plugin.name, 'universal-read')
  assert.deepEqual(plugin.inject, ['subprocess', 'tools'])
  assert.equal(registered.length, 1)
  assert.equal(typeof tool.execute, 'function')
  assert.equal(tool.name, 'universal_read')
})

await checkAsync('缺参 / 相对路径：不 spawn 即拦', async () => {
  const before = spawnCalls
  assert.match(await tool.execute({}), /缺少 filePath 或 url/)
  assert.match(await tool.execute({ filePath: 'a\\b.txt' }), /必须是绝对路径/)
  assert.match(await tool.execute({ url: 'ftp://x/y' }), /只支持 http\/https/)
  assert.equal(spawnCalls, before, '参数校验应在 spawn 之前，spawn 次数不应增加')
})

await checkAsync('runBridge 非零退出抛错（含 stderr 尾）', async () => {
  const fake = () => ({
    done: Promise.resolve({ exitCode: 2 }),
    collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: 'inner boom' }) } },
  })
  await assert.rejects(() => U.runBridge(fake, process.execPath, { command: 'ReadFile' }, 5000, {}), /退出码=2.*inner boom/)
})

/* ------------------------------------------------------- 端到端：本地 */
console.log('\n=== [实测] 真 FileOperator 进程读真文件 ===')

await checkAsync('txt 分页：头信息 + 行范围 + DEBUG 被压住', async () => {
  const out = await tool.execute({
    filePath: 'C:\\Users\\user\\Desktop\\VCPToolBox\\Plugin\\FileOperator\\config.env',
    lines: 'head:5',
  })
  assert.match(out, /已读取文件 'config\.env'/)
  assert.match(out, /行范围: 1-5\/\d+/)
  assert.match(out, /Copy this file/)
  assert.ok(!/\[DEBUG/.test(out), 'DEBUG_MODE=false 应压住 stderr 刷屏（stdout 无调试行）')
})

await checkAsync('不存在的绝对路径：原版错误被整形成可读文本', async () => {
  const out = await tool.execute({ filePath: 'C:\\Users\\user\\no-such-dir-xyz\\nope.txt' })
  assert.match(out, /universal_read 失败/)
})

const FIX = {
  pdf: 'C:\\Users\\user\\Desktop\\行测资料\\申论\\“一页纸”录取通知书.pdf',
  docx: 'C:\\Users\\user\\.workbuddy\\connectors-marketplace\\connectors\\fazhi-law\\skills\\legal-opinion\\assets\\templates\\01_通用专项法律意见书模板.docx',
  xlsx: 'E:\samples\sample.xlsx',
}

if (!existsSync(FIX.pdf)) {
  skip++
  console.log('  SKIP  pdf 提取（样本文件不在了）')
} else {
  await checkAsync('pdf 提纯文本（147 行）', async () => {
    const out = await tool.execute({ filePath: FIX.pdf, lines: 'head:3' })
    assert.match(out, /录取通知书\.pdf/)
    assert.match(out, /1-3\/147/)
    assert.match(out, /背景介绍/)
  })
}

if (!existsSync(FIX.docx)) {
  skip++
  console.log('  SKIP  docx 提取（样本文件不在了）')
} else {
  await checkAsync('docx 提纯文本（231 行）', async () => {
    const out = await tool.execute({ filePath: FIX.docx, lines: 'head:3' })
    assert.match(out, /法律意见书模板\.docx/)
    assert.match(out, /1-3\/231/)
  })
}

if (!existsSync(FIX.xlsx)) {
  skip++
  console.log('  SKIP  xlsx 提表（样本文件不在了）')
} else {
  await checkAsync('xlsx 按 Sheet 制表', async () => {
    const out = await tool.execute({ filePath: FIX.xlsx, lines: 'head:5' })
    assert.match(out, /Sheet1/)
    assert.match(out, /院校名称/)
  })
}

await checkAsync('图片不贴 base64、转指引 read_image', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ur-img-'))
  try {
    const png = path.join(dir, 'dot.png')
    writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
    const out = await tool.execute({ filePath: png })
    assert.match(out, /read_image/)
    assert.ok(!/data:image\/png;base64,/.test(out), 'base64 字节必须进上下文')
    assert.ok(out.length < 2000, '图片输出应短小（实际 ' + out.length + '）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------- 端到端：URL */
console.log('\n=== [实测] 本地 HTTP 服务器覆盖 WebReadFile + DownloadFile ===')

const srvDir = mkdtempSync(path.join(os.tmpdir(), 'ur-web-'))
const gateDir = mkdtempSync(path.join(os.tmpdir(), 'ur-gate-'))
const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'ur-out-'))
const server = http.createServer((req, res) => {
  if (req.url === '/doc.txt') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('第一行\n第二行\n第三行\n')
  } else if (req.url === '/pkg.bin') {
    const b = Buffer.from('BINARY-PAYLOAD-0123456789')
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': b.length })
    res.end(b)
  } else {
    res.writeHead(404)
    res.end('nope')
  }
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve())
})
const base = 'http://127.0.0.1:' + server.address().port
const gateEnv = { WEB_FILE_DIR: srvDir, DEFAULT_DOWNLOAD_DIR: srvDir, ALLOWED_DIRECTORIES: gateDir }

async function bridgeDirect(request, env) {
  const text = await U.runBridge(stubSpawn, process.execPath, request, U.REMOTE_TIMEOUT_MS, env)
  return U.shapeOutput(U.parseEnvelope(text), { kind: request.command === 'DownloadFile' ? 'download' : 'webread' })
}

await checkAsync('WebReadFile：取文本 + 落盘隔离到临时目录', async () => {
  const out = await bridgeDirect({ command: 'WebReadFile', url: base + '/doc.txt', lines: 'head:2' }, gateEnv)
  assert.match(out, /第二行/)
  assert.match(out, /已存本地：`/)
  assert.ok(existsSync(path.join(srvDir, 'doc.txt')), '默认落盘应进隔离目录而非 VCPToolBox\\file')
  assert.equal(readFileSync(path.join(srvDir, 'doc.txt'), 'utf8').split('\n')[0], '第一行')
})

await checkAsync('DownloadFile：字节一致 + 重名加序号', async () => {
  const first = await bridgeDirect({ command: 'DownloadFile', url: base + '/pkg.bin', downloadDir: gateDir }, gateEnv)
  assert.match(first, /落盘路径：`/)
  const landed = path.join(gateDir, 'pkg.bin')
  assert.ok(existsSync(landed), '应落盘到指定目录')
  assert.equal(readFileSync(landed, 'utf8'), 'BINARY-PAYLOAD-0123456789')
  const second = await bridgeDirect({ command: 'DownloadFile', url: base + '/pkg.bin', downloadDir: gateDir }, gateEnv)
  assert.match(second, /重名/)
})

await checkAsync('DownloadFile 到门外目录：原版安全门拒绝', async () => {
  const out = await bridgeDirect({ command: 'DownloadFile', url: base + '/pkg.bin', downloadDir: outsideDir }, gateEnv)
  assert.match(out, /access denied|allowed directories/i)
  assert.ok(!existsSync(path.join(outsideDir, 'pkg.bin')), '被拒绝的下载不应落盘')
})

await new Promise((resolve) => server.close(() => resolve()))
rmSync(srvDir, { recursive: true, force: true })
rmSync(gateDir, { recursive: true, force: true })
rmSync(outsideDir, { recursive: true, force: true })

console.log('\n=== 汇总 ===')
console.log('PASS ' + pass + '  FAIL ' + fail + '  SKIP ' + skip)
if (fail > 0) process.exit(1)
