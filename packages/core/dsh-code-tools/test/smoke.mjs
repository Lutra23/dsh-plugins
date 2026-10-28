import fs from 'node:fs'
import { spawn } from 'node:child_process'
import plugin from '../lib/index.js'

/**
 * dsh-code-tools 端到端冒烟：不依赖 cordis 运行时，用 stub ctx 复刻
 * subprocess.spawn / fs.resolve+readText / tools.register 三个注入面，
 * 真实调用 VCP 插件子进程，验证四个工具的参数规整、信封解析与安全门。
 */

function makeBufferedText(later) { return { readFrom: () => ({ text: later() ?? '' }) } }

const ctx = {
  fs: {
    async resolve(p) { return p },
    async readText(p) { return fs.readFileSync(p, 'utf8') },
  },
  subprocess: {
    async resolveExecutable() { return process.execPath },
    spawn(opts) {
      let stdinData = ''
      if (opts.stdio && opts.stdio.stdin && typeof opts.stdio.stdin.data === 'string') stdinData = opts.stdio.stdin.data
      const child = spawn(opts.argv[0], opts.argv.slice(1), {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (c) => { out += c })
      child.stderr.on('data', (c) => { err += c })
      const done = new Promise((resolve) => {
        child.on('close', (code) => resolve({ exitCode: code }))
        child.stdin.on('error', () => {})
        child.stdin.end(stdinData)
      })
      return { done, collected: { stdout: makeBufferedText(() => out), stderr: makeBufferedText(() => err) } }
    },
  },
  tools: { registered: [], register(t) { this.registered.push(t) } },
}

plugin.apply(ctx)

const tools = Object.fromEntries(ctx.tools.registered.map((t) => [t.name, t]))

function check(label, text, expect) {
  const ok = typeof expect === 'function' ? expect(text) : String(text).includes(expect)
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | ' + String(text).replace(/\s+/g, ' ').slice(0, 160))
  return ok
}

async function main() {
  const results = []

  results.push(check('注册工具数=4', ctx.tools.registered.map((t) => t.name).join(','), (s) => s.split(',').length === 4))

  // firecrawl：types 非法值应被插件拦截
  const fcBad = await tools.firecrawl_dev_search.execute({ query: 'x', types: 'blog' })
  results.push(check('firecrawl types 校验', fcBad, (s) => s.includes('非法') || s.includes('types')))

  // firecrawl：真实检索
  const fc = await tools.firecrawl_dev_search.execute({ query: 'how to configure express trust proxy', k: 2, types: 'doc', passages: 1 })
  results.push(check('firecrawl 检索出结果', fc, (s) => !s.includes('错误') && !s.includes('失败') && s.length > 80))

  // git_search：缺参
  const gsBad = await tools.git_search.execute({})
  results.push(check('git_search 缺参提示', gsBad, '单条调用需 platform 与 command'))

  // git_search：单条真实调用
  const gs = await tools.git_search.execute({ platform: 'github', command: 'repo_get', repo_owner: 'facebook', repo_name: 'react' })
  results.push(check('git_search repo_get', gs, 'Repository: react/react'))

  // git_search：批量
  const gsb = await tools.git_search.execute({ calls: '[{"platform":"github","command":"repo_get","repo_owner":"facebook","repo_name":"react"},{"platform":"github","command":"issue_list","repo_owner":"facebook","repo_name":"react","per_page":2,"state":"open"}]' })
  results.push(check('git_search 批量', gsb, (s) => s.includes('Repository') && !s.includes('❌')))

  // git_search：calls 非法 JSON
  const gsBadCalls = await tools.git_search.execute({ calls: '{bad json' })
  results.push(check('git_search calls 校验', gsBadCalls, '不是合法 JSON 数组'))

  // git_operator：ProfileList 读 VCP repos.json
  const goList = await tools.git_operator.execute({ command: 'ProfileList' })
  results.push(check('git_operator ProfileList', goList, 'VCPToolBox'))

  // git_operator：危险操作无验证码 → 本工具层直接拒绝（不触插件）
  const goDanger = await tools.git_operator.execute({ command: 'ResetHard' })
  results.push(check('git_operator 危险门', goDanger, '验证码'))

  // git_operator：真实只读 git 操作
  const goStatus = await tools.git_operator.execute({ command: 'Status', profile: 'VCPToolBox' })
  results.push(check('git_operator Status', goStatus, (s) => (s.includes('On branch') || s.includes('status')) && !s.includes('ghp_')))

  // git_operator：串行批量
  const goSerial = await tools.git_operator.execute({ serial: '[{"command":"TagList","profile":"VCPToolBox"},{"command":"RemoteInfo","profile":"VCPToolBox"}]' })
  results.push(check('git_operator 串行', goSerial, (s) => s.includes('RemoteInfo') && s.includes('origin')))

  // git_operator：路径越界 profile（白名单验证）
  const goEsc = await tools.git_operator.execute({ command: 'ProfileAdd', profileName: 'evil-test', localPath: 'C:\\Windows\\System32' })
  results.push(check('git_operator ProfileAdd 建档', goEsc, 'ProfileAdd'))
  const goSt = await tools.git_operator.execute({ command: 'Status', profile: 'evil-test' })
  results.push(check('git_operator 白名单', goSt, (s) => s.includes('安全限制') || s.includes('不在允许')))
  const goClean = await tools.git_operator.execute({ command: 'ProfileRemove', profileName: 'evil-test' })
  results.push(check('git_operator 清理', goClean, (s) => s.includes('ProfileRemove')))

  // deepwiki：结构（公开仓库）
  const dw = await tools.deepwiki.execute({ command: 'wiki_structure', repo: 'lioensky/VCPToolBox' })
  results.push(check('deepwiki 结构', dw, (s) => !s.includes('失败') && !s.includes('错误') && s.length > 60))

  const pass = results.filter(Boolean).length
  console.log('TOTAL ' + pass + '/' + results.length)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2) })
