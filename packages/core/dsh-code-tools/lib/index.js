import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import os from 'node:os'

/**
 * dsh-code-tools · VCP 代码工具箱移植（DSH 常驻 host 插件）
 *
 * 四个工具直连 VCPToolBox/Plugin 下的原版 stdio 插件进程，零复制、零改写插件源码：
 *   deepwiki             — DeepWikiVCP（MCP over HTTP，仓库文档结构/全文/AI问答/DeepResearch）
 *   git_search           — GitSearch（GitHub/GitLab/Gitee 14 个纯读取命令聚合，支持批量）
 *   git_operator         — GitOperator（repos.json Profile 驱动的本地 Git，含审计与危险操作验证码门）
 *   firecrawl_dev_search — FirecrawlDevSearch（Firecrawl 开发者索引：issue/PR/README/doc 语义检索）
 *
 * 凭证与代理一律取自各插件目录的 config.env（VCP 侧同文件，改一处两边生效）；
 * 本模块不落盘任何密钥，输出沿用插件自身的脱敏逻辑。
 * CodeSearcher/ProjectForge 已在 dsh-project-forge，ServerCodeSearcher 只是其远程变体，不在此重复。
 */

const VCP_ROOT = path.resolve(process.env.DSH_VCP_ROOT || path.join(os.homedir(), 'Desktop', 'VCPToolBox'))
const PLUGIN_ROOT = VCP_ROOT + '\\Plugin'

const PLUGINS = {
  deepwiki: PLUGIN_ROOT + '\\DeepWikiVCP\\DeepWikiVCP.js',
  gitsearch: PLUGIN_ROOT + '\\GitSearch\\GitSearch.js',
  gitop: PLUGIN_ROOT + '\\GitOperator\\GitOperator.js',
  firecrawl: PLUGIN_ROOT + '\\FirecrawlDevSearch\\FirecrawlDevSearch.js',
}

const GITOP_DANGEROUS = new Set(['ForcePush', 'ResetHard', 'BranchDelete', 'Rebase', 'CherryPick'])

export default {
  name: 'code-tools',
  inject: ['subprocess', 'fs', 'tools'],
  apply(ctx) {
    // ---------- 基础设施 ----------
    let nodePathPromise = null
    function nodePath() {
      if (nodePathPromise) return nodePathPromise
      nodePathPromise = ctx.subprocess.resolveExecutable('node').catch((e) => {
        nodePathPromise = null
        throw e
      })
      return nodePathPromise
    }

    const envCache = new Map()
    /** 解析插件目录 config.env（KEY=VALUE，# 注释），带缓存 */
    async function pluginEnv(name, dir) {
      if (envCache.has(name)) return envCache.get(name)
      let cfg = {}
      try {
        const t = await ctx.fs.resolve(dir + '\\config.env')
        const txt = await ctx.fs.readText(t)
        for (const line of txt.split(/\r?\n/)) {
          const s = line.trim()
          if (!s || s.startsWith('#')) continue
          const eq = s.indexOf('=')
          if (eq > 0) cfg[s.slice(0, eq).trim()] = s.slice(eq + 1).trim()
        }
      } catch (e) {
        console.error('[code-tools] 读取 ' + name + ' config.env 失败: ' + String(e))
      }
      envCache.set(name, cfg)
      return cfg
    }

    /** 通用 stdio 桥：wrapper 进程 spawnSync 插件子进程（超时/缓冲受控），stdin 喂请求 JSON */
    async function runPlugin(pluginPath, request, envExtra, timeoutMs, maxChars) {
      const node = await nodePath()
      const script =
        `const {spawnSync}=require('child_process');` +
        `const plugin=process.env.CT_PLUGIN, cwd=process.env.CT_CWD, t=parseInt(process.env.CT_TIMEOUT,10), max=parseInt(process.env.CT_MAX,10);` +
        `let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{` +
        `const r=spawnSync(process.execPath,[plugin],{input:raw,cwd,encoding:'utf8',timeout:t,maxBuffer:max});` +
        `if(r.error){process.stderr.write(String(r.error.message));process.exit(2);}` +
        `if(r.status!==0){process.stderr.write(String((r.stderr||'')+(r.error?(' '+r.error.message):'')));process.exit(r.status||2);}` +
        `process.stdout.write(r.stdout);});`
      const handle = ctx.subprocess.spawn({
        argv: [node, '-e', script],
        cwd: PLUGIN_ROOT,
        stdio: {
          stdin: { data: JSON.stringify(request) },
          stdout: { maxBytes: 4 * 1024 * 1024, spill: { maxBytes: 64 * 1024 * 1024 } },
          stderr: { maxBytes: 100 * 1024, spill: { maxBytes: 1024 * 1024 } },
        },
        env: {
          ...envExtra,
          CT_PLUGIN: pluginPath,
          CT_CWD: pluginPath.substring(0, pluginPath.lastIndexOf('\\')),
          CT_TIMEOUT: String(timeoutMs),
          CT_MAX: String(maxChars),
        },
        graceMs: 3000,
      })
      const outcome = await handle.done
      const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0) : { text: '' }
      const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0) : { text: '' }
      if (outcome.exitCode !== 0) {
        throw new Error('插件进程退出码=' + String(outcome.exitCode) + (err.text ? ' | ' + err.text : ''))
      }
      return out.text
    }

    /** VCP 插件响应信封 → 展示文本（兼容 result:string / content[] / 结构化对象） */
    function unwrap(parsed, label) {
      if (!parsed || parsed.status === 'error') {
        return '**' + label + ' 失败**: ' + ((parsed && parsed.error) || '未知错误')
      }
      const r = parsed.result
      if (typeof r === 'string') {
        const extra = parsed.messageForAI ? '\n\n> ' + parsed.messageForAI : ''
        return r + extra
      }
      if (r && Array.isArray(r.content)) {
        return r.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') || '(' + label + ' 无文本内容)'
      }
      return JSON.stringify(r, null, 2)
    }

    async function callPlugin(pluginPath, request, envExtra, timeoutMs, maxChars, label) {
      try {
        const text = await runPlugin(pluginPath, request, envExtra || {}, timeoutMs, maxChars || 8 * 1024 * 1024)
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          throw new Error('响应无法解析: ' + String(text).substring(0, 400))
        }
        return unwrap(parsed, label)
      } catch (e) {
        return '**' + label + ' 错误**: ' + String((e && e.message) || e)
      }
    }

    // =====================================================================
    // 1) deepwiki — DeepWikiVCP（公开仓库免鉴权；私有仓库预留 token）
    // =====================================================================
    ctx.tools.register(defineTool({
      name: 'deepwiki',
      description: '通过 DeepWiki 官方 MCP API 获取任意 GitHub 公开仓库的 AI 生成文档（移植自 VCP DeepWikiVCP v2.1）。命令：wiki_structure 文档目录结构 / wiki_content 完整文档（大，慎用）/ wiki_ask AI 定向问答（默认推荐，支持 deep_research 深度研究、repo 逗号分隔多仓库联合查询至多10个）。询问仓库架构、插件流程等设计问题时优先 wiki_ask，不默认拉全文。公开仓库无需配置；凭证与代理读 VCP Plugin/DeepWikiVCP/config.env。',
      parameters: {
        command: { type: 'string', enum: ['wiki_structure', 'wiki_content', 'wiki_ask'], description: '要执行的命令。给了 question 而未给 command 时自动按 wiki_ask 处理。' },
        repo: { type: 'string', required: true, description: '仓库标识，owner/repo 格式（如 lioensky/VCPToolBox），也接受 GitHub/DeepWiki URL。多仓库查询用逗号分隔（最多10个）。' },
        question: { type: 'string', description: 'wiki_ask 的问题，如“插件加载流程是怎么工作的？”' },
        deep_research: { type: 'boolean', description: 'wiki_ask 的深度研究模式：AI 多轮迭代检索（至多5轮），适合复杂架构分析。默认 false。' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args) {
        const a = args || {}
        const repo = String(a.repo || '').trim()
        if (!repo) return '**错误**: 缺少 repo（owner/repo 格式）。'
        const cfg = await pluginEnv('deepwiki', PLUGIN_ROOT + '\\DeepWikiVCP')
        const request = { command: a.command || (a.question ? 'wiki_ask' : 'wiki_structure'), url: repo }
        if (a.question) request.question = String(a.question)
        if (a.deep_research === true || a.deep_research === 'true') request.deep_research = true
        const env = {}
        if (cfg.DEEPWIKI_PROXY) env.DEEPWIKI_PROXY = cfg.DEEPWIKI_PROXY
        if (cfg.DEEPWIKI_GITHUB_TOKEN) env.DEEPWIKI_GITHUB_TOKEN = cfg.DEEPWIKI_GITHUB_TOKEN
        if (cfg.DEEPWIKI_GITLAB_TOKEN) env.DEEPWIKI_GITLAB_TOKEN = cfg.DEEPWIKI_GITLAB_TOKEN
        // 内层 180s（插件自身）+ 代理回退窗口，外层给 200s
        return callPlugin(PLUGINS.deepwiki, request, env, 200000, 8 * 1024 * 1024, 'DeepWiki')
      },
    }))

    // =====================================================================
    // 2) git_search — GitSearch（GitHub/GitLab/Gitee 纯读取聚合，14 命令 + 批量）
    // =====================================================================
    const GS_CMDS = 'repo_get / repo_list_files / repo_list_branches / repo_list_commits / repo_search_code / repo_list_releases / issue_list / issue_get / issue_search / pr_list / pr_get / pr_get_diff / user_get_me / user_search'
    ctx.tools.register(defineTool({
      name: 'git_search',
      description: '聚合 GitHub、GitLab、Gitee 三大代码托管平台的纯读取操作（移植自 VCP GitSearch）。每次调用需 platform + command（' + GS_CMDS + '）。注意：这是平台 API 查询，不是本地 git 操作（本地仓库用 git_operator）。repo_search_code / issue_search 仅 GitHub。支持 calls 参数批量（顺序执行，单条失败不影响其余）。令牌读 VCP Plugin/GitSearch/config.env。',
      parameters: {
        platform: { type: 'string', enum: ['github', 'gitlab', 'gitee'], description: '目标平台（单条调用必需；批量模式写在 calls 每项里）。' },
        command: { type: 'string', description: '统一命令名，见描述列表（单条调用必需）。' },
        repo_owner: { type: 'string', description: '仓库所有者（owner/repo 类命令必需；gitlab 顶层 group）。' },
        repo_name: { type: 'string', description: '仓库名。' },
        path: { type: 'string', description: 'repo_list_files 的文件/目录路径，省略列根目录。' },
        ref: { type: 'string', description: '分支/tag/SHA 限定。' },
        query: { type: 'string', description: '搜索类命令的关键词（repo_search_code 如 "repo:owner/name lang:rust"，issue_search 如 "state:open label:bug"）。' },
        issue_number: { type: 'integer', description: 'issue_get 的 Issue 编号。' },
        pr_number: { type: 'integer', description: 'pr_get / pr_get_diff 的 PR/MR 编号。' },
        state: { type: 'string', description: '列表类命令的状态筛选（open/closed/merged 等）。' },
        page: { type: 'integer', description: '页码（默认1）。' },
        per_page: { type: 'integer', description: '每页条数（默认30，代码搜索至多100）。' },
        calls: { type: 'string', description: '批量模式：JSON 数组字符串，每项为含 platform/command 的请求对象（如 [{"platform":"github","command":"repo_get","repo_owner":"facebook","repo_name":"react"},{"platform":"github","command":"issue_list","repo_owner":"facebook","repo_name":"react"}]），给了 calls 时忽略平铺参数。' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args) {
        const a = args || {}
        const cfg = await pluginEnv('gitsearch', PLUGIN_ROOT + '\\GitSearch')
        const env = {}
        for (const k of ['GITHUB_TOKEN', 'GITLAB_TOKEN', 'GITEE_TOKEN', 'GITLAB_URL', 'MAX_OUTPUT_LENGTH', 'GITHUB_PROXY', 'GITLAB_PROXY', 'GITEE_PROXY']) {
          if (cfg[k]) env[k] = cfg[k]
        }
        let request
        if (a.calls) {
          let arr
          try {
            arr = JSON.parse(String(a.calls))
          } catch {
            return '**错误**: calls 不是合法 JSON 数组。'
          }
          if (!Array.isArray(arr) || arr.length === 0 || arr.length > 10) return '**错误**: calls 须为 1~10 项的数组。'
          request = {}
          arr.forEach((item, i) => {
            const n = i + 1
            for (const [k, v] of Object.entries(item || {})) {
              if (v !== undefined && v !== null) request[k + n] = v
            }
          })
        } else {
          if (!a.platform || !a.command) return '**错误**: 单条调用需 platform 与 command。'
          request = { platform: a.platform, command: a.command }
          for (const k of ['repo_owner', 'repo_name', 'path', 'ref', 'query', 'issue_number', 'pr_number', 'state', 'page', 'per_page']) {
            if (a[k] !== undefined && a[k] !== null && a[k] !== '') request[k] = a[k]
          }
        }
        return callPlugin(PLUGINS.gitsearch, request, env, 35000, 8 * 1024 * 1024, 'GitSearch')
      },
    }))

    // =====================================================================
    // 3) git_operator — GitOperator（Profile 驱动本地 Git：读操作用心，写操作用户点头）
    // =====================================================================
    const GO_CMDS = 'Status / Log / Diff / BranchList / RemoteInfo / StashList / TagList / ProfileList / Add / Commit / Pull / Push / Fetch / BranchCreate / Checkout / Merge / Clone / ProfileAdd / ProfileEdit / ProfileRemove（危险档另需 requireAdmin 验证码）'
    ctx.tools.register(defineTool({
      name: 'git_operator',
      description: 'Profile 驱动的本地 Git 仓库管理器（移植自 VCP GitOperator v1.1）。仓库路径/远程/凭证由 VCP 侧 repos.json 的 Profile 定义，操作前先用 ProfileList 确认路径与白名单（PLUGIN_WORK_PATHS）。暂存、提交、推送是不同动作，有先后依赖时不得并发。危险命令（ForcePush/ResetHard/BranchDelete/Rebase/CherryPick）保留原验证码门禁——本工具绝不代填/补猜 requireAdmin，插件侧还会核验 UserAuth/code.bin。输出全程 token 脱敏。',
      parameters: {
        command: { type: 'string', description: '指令名（单条调用必需）：' + GO_CMDS + '。给了 serial 时可省略。' },
        profile: { type: 'string', description: 'repos.json 的 Profile 名；省略用 defaultProfile。' },
        files: { type: 'string', description: 'Add 的文件，"." = 全部。' },
        message: { type: 'string' },
        branch: { type: 'string', description: 'Checkout/Merge/Log。' },
        branchName: { type: 'string', description: 'BranchCreate/BranchDelete。' },
        startPoint: { type: 'string', description: '默认 HEAD。' },
        target: { type: 'string', description: 'Diff 对比目标 / ResetHard 重置点。' },
        maxCount: { type: 'integer', description: '默认 20。' },
        maxLines: { type: 'integer', description: '默认 200。' },
        source: { type: 'string', enum: ['pull', 'push'], description: 'pull=上游，push=自己。默认 pull。' },
        onto: { type: 'string', description: 'Rebase 目标（危险）。' },
        commitHash: { type: 'string', description: 'CherryPick（危险）。' },
        url: { type: 'string', description: 'Clone 远程 URL。' },
        localPath: { type: 'string', description: 'Clone 目标 / ProfileAdd 仓库路径。' },
        profileName: { type: 'string', description: 'ProfileAdd/Edit/Remove。' },
        pushUrl: { type: 'string' },
        pullUrl: { type: 'string' },
        requireAdmin: { type: 'string', description: '6 位验证码，只能由主人提供，绝不代填。' },
        serial: { type: 'string', description: '串行批量：JSON 数组字符串，每项含 command 及参数，按序执行、遇错即停（如 [{"command":"Status"},{"command":"Add","files":"."},{"command":"Commit","message":"fix: typo"}]）。' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args) {
        const a = args || {}
        let request
        if (a.serial) {
          let arr
          try {
            arr = JSON.parse(String(a.serial))
          } catch {
            return '**错误**: serial 不是合法 JSON 数组。'
          }
          if (!Array.isArray(arr) || arr.length === 0 || arr.length > 8) return '**错误**: serial 须为 1~8 项的数组。'
          request = {}
          arr.forEach((item, i) => {
            const n = i + 1
            if (!item || !item.command) return '**错误**: serial[' + (i + 1) + '] 缺 command。'
            for (const [k, v] of Object.entries(item)) {
              if (v !== undefined && v !== null) request[k === 'command' ? 'command' + n : k + n] = v
            }
          })
        } else {
          const command = String(a.command || '').trim()
          if (!command) return '**错误**: 缺少 command。可用：' + GO_CMDS
          request = { command: command }
          for (const k of ['profile', 'files', 'message', 'branch', 'branchName', 'startPoint', 'target', 'maxCount', 'maxLines', 'source', 'onto', 'commitHash', 'url', 'localPath', 'profileName', 'pushUrl', 'pullUrl', 'requireAdmin']) {
            if (a[k] !== undefined && a[k] !== null && a[k] !== '') request[k] = a[k]
          }
          if (GITOP_DANGEROUS.has(command) && !request.requireAdmin) {
            return '**拒绝**: `' + command + '` 是危险操作，需要主人亲自提供 requireAdmin 验证码。本工具不代生成、不补猜缺失参数。'
          }
        }
        // GitOperator 自读 config.env 与 repos.json，且子进程需要完整系统环境（git 在 PATH）→ 不注入 env
        return callPlugin(PLUGINS.gitop, request, {}, 65000, 8 * 1024 * 1024, 'GitOperator')
      },
    }))

    // =====================================================================
    // 4) firecrawl_dev_search — FirecrawlDevSearch（开发者索引语义检索）
    // =====================================================================
    ctx.tools.register(defineTool({
      name: 'firecrawl_dev_search',
      description: 'Firecrawl Developer Index 语义检索（移植自 VCP FirecrawlDevSearch）：在 GitHub issue / 已合并 PR / README / 官方文档中检索开发者问题答案，与 CodeSearcher（本地源码正则）、GitSearch（平台 API）、web_search（通用网页）不重叠。keyless 可用但限流低；限额提升读 VCP Plugin/FirecrawlDevSearch/config.env 的 FIRECRAWL_API_KEY。',
      parameters: {
        query: { type: 'string', required: true, description: '自然语言问题或搜索短语，如“rust 如何处理迭代器中的错误”。' },
        k: { type: 'integer', description: '返回结果数 1~100，默认 10。' },
        types: { type: 'string', description: '结果类型过滤，逗号分隔：doc,issue,pull_request,readme。默认全类型；传 repos 时须含 issue/pull_request/readme 之一。' },
        repos: { type: 'string', description: '限定仓库（逗号分隔，如 lioensky/VCPToolBox,facebook/react），只匹配已索引仓库的 issue/PR/README。' },
        sources: { type: 'string', description: '限定文档来源域名（逗号分隔，至多20，如 docs.rs,react.dev），须 types 含 doc。' },
        passages: { type: 'integer', description: '每条结果取几个匹配段落，1~5，默认 2。' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args) {
        const a = args || {}
        const query = String(a.query || '').trim()
        if (!query) return '**错误**: 缺少 query。'
        const cfg = await pluginEnv('firecrawl', PLUGIN_ROOT + '\\FirecrawlDevSearch')
        const request = { query: query }
        if (a.k) request.k = a.k
        if (a.passages) request.passages = a.passages
        if (a.types) request.types = a.types
        if (a.repos) request.repos = a.repos
        if (a.sources) request.sources = a.sources
        const env = {}
        if (cfg.FIRECRAWL_API_KEY) env.FIRECRAWL_API_KEY = cfg.FIRECRAWL_API_KEY
        if (cfg.FIRECRAWL_DEV_ENDPOINT) env.FIRECRAWL_DEV_ENDPOINT = cfg.FIRECRAWL_DEV_ENDPOINT
        if (cfg.FIRECRAWL_DEV_TIMEOUT_MS) env.FIRECRAWL_DEV_TIMEOUT_MS = cfg.FIRECRAWL_DEV_TIMEOUT_MS
        return callPlugin(PLUGINS.firecrawl, request, env, 45000, 8 * 1024 * 1024, 'FirecrawlDevSearch')
      },
    }))
  },
}
