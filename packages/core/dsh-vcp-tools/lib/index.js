import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * dsh-vcp-tools · 持久化 VCP 桥接工具包
 *
 * 把原本会话内动态创建的四个工具固化为常驻 host 插件（desktop/web profile）：
 *   doubao_search   — VCP DoubaoSearch 插件（本地插件文件存在时 stdio 直连；否则走 admin_api 桥）
 *   lightmemo       — VCP LightMemo 插件（admin_api 代理，范围白名单）
 *   dailynote_write — VCP 日记写侧：DailyNote create/update + DailyNoteManager organize（写白名单）
 *   dailynote_read  — VCP 日记读侧：list/read/search/associate（读白名单，update 的先读配套）
 *   chrome_bridge   — VCP ChromeBridge 插件（admin_api 代理）
 *
 * VCP 端点与凭证可配置（远端/分发适配），解析优先级：
 *   profile patch config（vcpHost/vcpPort/vcpHome/adminUser/adminPass）
 *   > 环境变量（VCP_HOST/VCP_PORT/VCP_HOME/VCP_ADMIN_USER/VCP_ADMIN_PASSWORD）
 *   > vcpHome 下 config.env（AdminUsername/AdminPassword）> 默认 http://127.0.0.1:6005。
 * vcpHome 同时决定 doubao stdio 直连的插件文件路径与子进程 cwd；目录缺失时 cwd 回退系统临时目录。
 */

const DEFAULTS = {
  vcpHost: '127.0.0.1',
  vcpPort: 6005,
  vcpHome: '',        // VCPToolBox 根目录：config.env 凭证兜底、doubao stdio 插件路径、子进程 cwd
  adminUser: '',      // 显式 admin 凭证（明文进 patch yml 有泄露风险，优先环境变量）
  adminPass: '',
  // 日记写侧白名单（逗号/竖线分隔）：create/update/organize 只允许落在这些库。
  writeFolders: 'DSH工程档案,溟月的知识,溟月',
  // 日记读侧白名单：dailynote_read 的列/取/搜/联想范围，越界项被忽略。
  readFolders: 'DSH工程档案,溟月的知识,溟月,Nova,小绝,Kerr,Kerr的知识,公共,已整理',
}

/** 跨分隔符路径拼接：vcpHome 以 / 或 \ 结尾皆可。 */
function joinPath(dir, name) {
  const d = String(dir || '').replace(/[\\/]+$/, '')
  return d ? d + '/' + name : name
}

const processEnv = () => (globalThis.process && globalThis.process.env) || {}

/** 白名单解析：支持逗号/中文逗号/分号/竖线分隔，去空去重保序。 */
function splitFolderList(text) {
  const out = []
  for (const part of String(text || '').split(/[,，;；|]/)) {
    const s = part.trim()
    if (s && out.indexOf(s) < 0) out.push(s)
  }
  return out
}

/** 目录名归一到白名单条目：先精确后双向包含（'溟月' → '溟月的知识'）；不命中返回 null。 */
function matchFolderScope(name, scopes) {
  const n = String(name || '').trim()
  if (!n) return null
  for (const w of scopes) if (n === w) return w
  for (const w of scopes) if (n.indexOf(w) >= 0 || w.indexOf(n) >= 0) return w
  return null
}

/** 拆日记 URL 首段目录名：'DSH工程档案/2026-..txt' → 'DSH工程档案'。 */
function folderOfUrl(url) {
  const s = String(url || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const i = s.indexOf('/')
  return i > 0 ? s.slice(0, i) : ''
}

/** 桥接双层解包：外层 {status,result} 包插件层 {status,result}。返回 {ok,data,status} 或 {error}。 */
function unwrapDailyNote(parsed) {
  const outer = parsed || {}
  if (outer.status !== 'success') return { error: outer.error || JSON.stringify(outer) }
  const inner = outer.result
  if (inner && typeof inner === 'object' && (inner.status === 'error' || inner.plugin_error)) {
    return { error: inner.error || inner.plugin_error || JSON.stringify(inner) }
  }
  const data = inner && typeof inner === 'object' && 'result' in inner ? inner.result : inner
  return { ok: true, data: data, status: (inner && inner.status) || 'success' }
}

/** 超长输出截断，保住上下文。 */
function clipText(s, max) {
  const text = String(s || '')
  return text.length <= max ? text : text.slice(0, max) + '\n…（已截断 ' + (text.length - max) + ' 字符；可缩小 folder 或日期范围，或改用 search 精读定位）'
}

/** 与 VCP DailyNote 的 dehydrate 同语义：去空白与反斜杠，全角标点/弯引号/中文句号归半角再小写。
 *  预检若只做逐字比对，会把插件本来能匹配的「排版差异」target 误拦。 */
const DIARY_LOOSE_MAP = {
  '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u201f': '"', '\uff02': '"',
  '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'", '\uff07': "'",
  '\uff08': '(', '\uff09': ')', '\uff0c': ',', '\u3001': ',', '\uff1a': ':',
  '\uff1b': ';', '\uff01': '!', '\uff1f': '?', '\u3002': '.', '\uff0e': '.',
  '\u2026': '...', '\u2014': '-', '\u2013': '-',
}
function diaryLoose(text) {
  let out = ''
  for (const ch of String(text || '')) {
    if (/\s/.test(ch) || ch === '\\') continue
    out += DIARY_LOOSE_MAP[ch] || ch.toLowerCase()
  }
  return out
}

/** 从 target 挑一条最能定位的单行探针（搜索器按行匹配，多行字面量永不命中）。 */
function pickProbeLine(text) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter((s) => s.length >= 15)
  if (!lines.length) return ''
  return lines.sort((x, y) => y.length - x.length)[0].slice(0, 80)
}

/** VCP admin 凭证分层解析：显式 config（adminUser/adminPass）> 环境变量
 *  （VCP_ADMIN_USER/VCP_ADMIN_PASSWORD）> vcpHome 的 config.env（AdminUsername/AdminPassword）。
 *  user/pass 两半独立取最靠前层的值；全缺返回 null。 */
function resolveVcpAuth(cfg, env, configEnvText) {
  const c = cfg || {}
  const e = env || {}
  const u = String(c.adminUser || '').trim() || String(e.VCP_ADMIN_USER || '').trim()
  const p = String(c.adminPass || '').trim() || String(e.VCP_ADMIN_PASSWORD || '').trim()
  if (u && p) return 'Basic ' + Buffer.from(u + ':' + p, 'utf8').toString('base64')
  const txt = String(configEnvText || '')
  const mu = (/^AdminUsername\s*=\s*(\S+)/m.exec(txt) || [])[1] || ''
  const mp = (/^AdminPassword\s*=\s*(\S+)/m.exec(txt) || [])[1] || ''
  if (mu && mp) return 'Basic ' + Buffer.from(mu + ':' + mp, 'utf8').toString('base64')
  return null
}

/** 通用 admin_api 桥接脚本：stdin 读 args JSON → POST /admin_api/plugins/<Name>/execute → stdout 输出响应。
 *  host/port 参数化（远端 VCP / 非默认端口由配置注入，默认回落 127.0.0.1:6005）。 */
function makeBridgeScript(pluginName, host, port) {
  const h = JSON.stringify(String(host || '127.0.0.1')) // 生成带双引号的 JS 字符串字面量
  const p = Number(port) || 6005
  return `const http=require('http');const auth=process.env.LM_AUTH;let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{let args;try{args=JSON.parse(raw||'{}');}catch(e){process.stderr.write('bad args json');process.exit(2);}const body=JSON.stringify({args:args});const req=http.request({host:${h},port:${p},path:'/admin_api/plugins/${pluginName}/execute',method:'POST',headers:{'Content-Type':'application/json; charset=utf-8','Authorization':auth,'Content-Length':Buffer.byteLength(body)},timeout:120000},res=>{let d='';res.setEncoding('utf8');res.on('data',c=>d+=c);res.on('end',()=>{process.stdout.write(d);});});req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',e=>{process.stderr.write(e.message);process.exit(2);});req.write(body);req.end();});`
}

export default {
  name: 'vcp-tools',
  inject: ['subprocess', 'fs', 'tools'],
  apply(ctx, rawConfig) {
    const cfg = { ...DEFAULTS }
    for (const [k, v] of Object.entries(rawConfig || {})) {
      if (v === undefined || v === null) continue
      if (typeof DEFAULTS[k] === 'number') cfg[k] = Number(v) || DEFAULTS[k]
      else if (typeof DEFAULTS[k] === 'boolean') cfg[k] = Boolean(v)
      else if (DEFAULTS[k] !== undefined) cfg[k] = v
    }

    let nodePathPromise = null
    function nodePath() {
      if (nodePathPromise) return nodePathPromise
      nodePathPromise = ctx.subprocess.resolveExecutable('node').catch((e) => {
        nodePathPromise = null
        throw e
      })
      return nodePathPromise
    }

    let authPromise = null
    function loadAuth() {
      if (authPromise) return authPromise
      authPromise = (async () => {
        let configEnvText = ''
        if (cfg.vcpHome) {
          try {
            const t = await ctx.fs.resolve(joinPath(cfg.vcpHome, 'config.env'))
            configEnvText = await ctx.fs.readText(t)
          } catch { /* 目录/文件不存在：凭证靠显式配置或环境变量 */ }
        }
        const auth = resolveVcpAuth(cfg, processEnv(), configEnvText)
        if (!auth) {
          authPromise = null // 不缓存失败：config.env 可能稍后出现
          console.error('[vcp-tools] VCP admin 凭证缺失（config adminUser/adminPass、环境变量 VCP_ADMIN_USER/VCP_ADMIN_PASSWORD、或 vcpHome 下 config.env 的 AdminUsername/AdminPassword）')
        }
        return auth
      })()
      return authPromise
    }

    const builtin = (globalThis.process && globalThis.process.getBuiltinModule)
      ? { fs: globalThis.process.getBuiltinModule('fs'), os: globalThis.process.getBuiltinModule('os') }
      : {}
    /** 子进程 cwd：vcpHome 存在则沿用，否则回退系统临时目录（纯 HTTP/stdio 桥不依赖 cwd，仅防 ENOENT）。 */
    function spawnCwd() {
      try { if (cfg.vcpHome && builtin.fs && builtin.fs.existsSync(cfg.vcpHome)) return cfg.vcpHome } catch { /* 忽略 */ }
      return builtin.os ? builtin.os.tmpdir() : '.'
    }

    /** 运行一个 node 子进程：stdin 喂 stdinData，返回 stdout 文本 */
    async function runNodeScript(script, stdinData, envExtra) {
      const node = await nodePath()
      const handle = ctx.subprocess.spawn({
        argv: [node, '-e', script],
        cwd: spawnCwd(),
        stdio: {
          stdin: stdinData === undefined ? 'ignore' : { data: stdinData },
          stdout: { maxBytes: 4 * 1024 * 1024, spill: { maxBytes: 64 * 1024 * 1024 } },
          stderr: { maxBytes: 100 * 1024, spill: { maxBytes: 1024 * 1024 } },
        },
        env: envExtra || {},
        graceMs: 3000,
      })
      const outcome = await handle.done
      const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0) : { text: '' }
      const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0) : { text: '' }
      if (outcome.exitCode !== 0) {
        throw new Error('子进程退出码=' + String(outcome.exitCode) + (err.text ? ' | ' + err.text : ''))
      }
      return out.text
    }

    /** 调 VCP admin_api 桥，返回解析后的 JSON */
    async function callBridge(pluginName, args) {
      const auth = await loadAuth()
      if (!auth) throw new Error('无法读取 VCP admin 凭证（config.env 的 AdminUsername/AdminPassword）')
      const text = await runNodeScript(makeBridgeScript(pluginName, cfg.vcpHost, cfg.vcpPort), JSON.stringify(args), { LM_AUTH: auth })
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch (e) {
        throw new Error(pluginName + ' 返回无法解析: ' + String(text).substring(0, 400))
      }
      return parsed
    }

    // =====================================================================
    // 1) doubao_search — VCP DoubaoSearch 插件（stdio 直连真实插件进程）
    // =====================================================================
    const DOUBAO_PLUGIN = cfg.vcpHome ? cfg.vcpHome.replace(/[\\/]+$/, '') + '\\Plugin\\DoubaoSearch\\DoubaoSearch.js' : ''
    const DOUBAO_CONFIG_ENV = cfg.vcpHome ? cfg.vcpHome.replace(/[\\/]+$/, '') + '\\Plugin\\DoubaoSearch\\config.env' : ''
    /** 本地 doubao stdio 直连可用性：vcpHome 下插件入口存在才走直连；远端/无本地 VCP 部署走 admin_api 桥。 */
    function doubaoStdioEntry() {
      try { return DOUBAO_PLUGIN && builtin.fs && builtin.fs.existsSync(DOUBAO_PLUGIN) ? DOUBAO_PLUGIN : null } catch { return null }
    }
    let doubaoKeyPromise = null
    function doubaoKey() {
      if (doubaoKeyPromise) return doubaoKeyPromise
      doubaoKeyPromise = (async () => {
        if (!DOUBAO_CONFIG_ENV) return null
        try {
          const t = await ctx.fs.resolve(DOUBAO_CONFIG_ENV)
          const txt = await ctx.fs.readText(t)
          const m = /^WEB_SEARCH_API_KEY\s*=\s*(\S+)/m.exec(txt)
          return m ? m[1].trim() : null
        } catch (e) {
          console.error('[vcp-tools] 读取 DoubaoSearch config.env 失败: ' + String(e))
          return null
        }
      })()
      return doubaoKeyPromise
    }
    const DOUBAO_GUIDE = [
      '豆包搜索需要 API Key（每月 500 次免费额度，次月 1 日重置）。',
      '',
      '【个人用户】',
      '1. 开通: https://console.volcengine.com/search-infinity/web-search',
      '2. 创建 Key: https://console.volcengine.com/search-infinity/api-key',
      '3. 将 Key 填入 VCPToolBox 的 Plugin/DoubaoSearch/config.env 的 WEB_SEARCH_API_KEY（本地 stdio 直连模式），或设环境变量 WEB_SEARCH_API_KEY，或调用时传 api_key 参数（远端桥模式请确保远端 VCP 侧已配 Key）。',
    ].join('\n')
    ctx.tools.register(defineTool({
      name: 'doubao_search',
      description: '调用火山引擎豆包搜索 API（联网搜索），返回网页/图片结果。原为 VCPToolBox 插件，现为持久化动态工具；参数与 VCP 版完全一致，支持 || 分隔多关键词并发搜索。涉及最新/今天/实时信息时优先使用本工具。',
      parameters: {
        query: { type: 'string', required: true, description: '搜索关键词（1~100 字符）。多个关键词用 || 分隔可并发，如：AI 大模型 || 自动驾驶技术。' },
        search_type: { type: 'string', enum: ['web', 'image'], description: '搜索类型：web 网页（默认）/ image 图片。' },
        count: { type: 'integer', description: '每个关键词返回条数。web 最多 50，image 最多 5。默认 10。' },
        time_range: { type: 'string', description: '时间范围：OneDay/OneWeek/OneMonth/OneYear，或日期区间 YYYY-MM-DD..YYYY-MM-DD。' },
        auth_level: { type: 'integer', description: '权威来源过滤：0=全部（默认），1=仅权威来源（gov/edu/官方站）。' },
        query_rewrite: { type: 'boolean', description: '是否开启查询改写优化（口语化长问、结果不稳定时建议开启）。默认 false。' },
        api_key: { type: 'string', description: '（可选）自定义豆包 API Key；本地直连模式缺省读 VCP 插件 config.env 的 WEB_SEARCH_API_KEY，远端桥模式由远端 VCP 侧解析。' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args) {
        const a = args || {}
        const query = String(a.query || '').trim()
        if (!query) return '**错误**: 缺少必需参数 query（搜索关键词）。支持用 || 分隔多个关键词并发搜索。'
        const localEntry = doubaoStdioEntry()
        let key = a.api_key ? String(a.api_key).trim() : ''
        if (!key && localEntry) key = (await doubaoKey()) || '' // 仅 stdio 直连需要本地 Key；桥模式由远端 VCP 侧解析
        if (localEntry && !key) return DOUBAO_GUIDE
        const request = {
          query: query,
          search_type: a.search_type || 'web',
          count: a.count,
          time_range: a.time_range,
          auth_level: a.auth_level,
          query_rewrite: a.query_rewrite,
          api_key: key || undefined,
        }
        try {
          let parsed
          if (localEntry) {
            // 路 A：本地插件文件 stdio 直连（无需 VCP 服务器运行）
            const text = await runNodeScript(
              `const {spawnSync}=require('child_process');let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{const r=spawnSync(process.execPath,[${JSON.stringify(localEntry)}],{input:raw,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});if(r.status!==0){process.stderr.write(String(r.stderr||r.error||''));process.exit(r.status||2);}process.stdout.write(r.stdout);});`,
              JSON.stringify(request),
            )
            try { parsed = JSON.parse(text) } catch (e) { throw new Error('豆包搜索返回无法解析: ' + String(text).substring(0, 400)) }
          } else {
            // 路 B：本地无插件文件（远端/纯桥部署）→ admin_api 桥；Key 由远端 VCP 侧插件自己的 config 解析
            parsed = await callBridge('DoubaoSearch', request)
          }
          if (parsed.status === 'error') return '**豆包搜索失败**: ' + (parsed.error || '未知错误')
          const res = parsed.result || {}
          if (res.plugin_error) return '**豆包搜索失败**: ' + res.plugin_error
          if (res.status === 'error') return '**豆包搜索失败**: ' + (res.error || '未知错误')
          const content = res.content || []
          const out = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
          return out || '**豆包搜索**: 未返回可显示的结果。'
        } catch (e) {
          return '**豆包搜索错误**: ' + String((e && e.message) || e)
        }
      },
    }))

    // =====================================================================
    // 2) lightmemo — VCP LightMemo 插件（admin_api 代理，范围白名单）
    // =====================================================================
    const ALLOWED_SCOPES = ['Nova', '小绝', 'Kerr', 'Kerr的知识', '公共', 'DSH工程档案', '溟月的知识', '溟月']
    function clampScope(input) {
      const parts = String(input || '').split(/[|，,]/).map((s) => s.trim()).filter(Boolean)
      const allowed = parts.filter((p) => ALLOWED_SCOPES.some((w) => p === w || p.indexOf(w) >= 0 || w.indexOf(p) >= 0))
      return (allowed.length ? allowed : ALLOWED_SCOPES.slice()).join('|')
    }

    ctx.tools.register(defineTool({
      name: 'lightmemo',
      description: '调用 VCPToolBox 的 LightMemo 插件（轻量RAG回忆检索），在日记/知识库中搜索相关记忆片段。搜索范围严格限定为 Nova、小绝、Kerr、Kerr的知识、公共知识、DSH工程档案、溟月的知识（不可越界，非白名单范围会被自动忽略）。支持 BM25+向量混合检索（RiverMemo/TagMemo/KNN 内核）。涉及回忆、过往记录、知识库内容时使用。',
      parameters: {
        query: { type: 'string', required: true, description: '检索查询内容。可在其中嵌入时间范围，如 [2025-04-11~2025-05-12] 或 [2026-02-14]。' },
        folder: { type: 'string', description: '搜索范围，限 Nova/小绝/Kerr/Kerr的知识/公共/DSH工程档案/溟月的知识，可用 | 或 , 分隔多个（如 Nova|Kerr的知识）。默认全部；任何非白名单项会被自动忽略。' },
        k: { type: 'integer', description: '返回结果数量，默认 5。' },
        enginemode: { type: 'string', enum: ['rivermemo', 'tagmemo', 'knn'], description: '检索内核：rivermemo（默认，Topology V3 生产管线）/ tagmemo（TagMemo V9.1 向量增强）/ knn（纯向量/BM25 混合）。' },
        tag_boost: { type: 'number', description: '增强强度，默认 0.5。rivermemo 控制降噪源强度；tagmemo 控制 V9.1 增强。' },
        BM25: { type: 'boolean', description: '是否启用 BM25 关键词初筛与混合打分，默认 true。' },
        time_range: { type: 'string', description: '时间范围约束，如 OneMonth 或 [2026-01-01~2026-06-30]（也可直接写在 query 里）。' },
        rerank: { type: 'string', description: 'Rerank 精排，可选 false/true/rrf/rrf0.7 或 0~1 数字。默认 false（需 VCP 配置 Rerank 服务才生效）。' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args) {
        const a = args || {}
        const query = String(a.query || '').trim()
        if (!query) return '**错误**: 缺少必需参数 query。'
        const reqArgs = {
          query: query,
          folder: clampScope(a.folder),
          k: a.k,
          enginemode: a.enginemode || 'rivermemo',
          tag_boost: a.tag_boost,
          BM25: a.BM25,
          time_range: a.time_range,
          rerank: a.rerank,
          search_all_knowledge_bases: false,
        }
        try {
          const parsed = await callBridge('LightMemo', reqArgs)
          if (parsed.status !== 'success') return '**LightMemo 调用失败**: ' + (parsed.error || JSON.stringify(parsed))
          const res = parsed.result
          if (res && res.plugin_error) return '**LightMemo**: ' + res.plugin_error
          const content = (res && res.content) || []
          const text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
          return text || '**LightMemo**: 未返回内容（可能在指定范围内无相关记忆）。'
        } catch (e) {
          return '**LightMemo 错误**: ' + String((e && e.message) || e)
        }
      },
    }))

    // =====================================================================
    // =====================================================================
    // 3) 日记能力面（对齐 VCP DailyNote / DailyNoteManager / DailyNoteSearcher）
    //    dailynote_write：create 新建 / update 修订 / organize 合并归档
    //    dailynote_read ：list 目录 / read 原文 / search 全文 / associate 联想
    //    边界：写只落 writeFolders，读只落 readFolders，越界一律拒绝并说明。
    // =====================================================================
    const WRITE_FOLDERS = splitFolderList(cfg.writeFolders)
    const READ_FOLDERS = splitFolderList(cfg.readFolders)
    const CATEGORIES = ['工程经验', '开发节点', '重要事件']
    const DIARY_MAID = '溟月'
    function pad(n) { return String(n).padStart(2, '0') }
    function todayStr() {
      const x = new Date()
      return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate())
    }

    /** 写侧目录守卫：缺省落白名单首库，越界返回 null。 */
    function guardWriteFolder(input) {
      const want = String(input || '').trim() || WRITE_FOLDERS[0]
      return matchFolderScope(want, WRITE_FOLDERS)
    }
    /** 读侧目录守卫：丢弃越界项，全越界时回退整个白名单。 */
    function guardReadFolders(input) {
      const hit = splitFolderList(input).map((p) => matchFolderScope(p, READ_FOLDERS)).filter(Boolean)
      return hit.length ? hit : READ_FOLDERS.slice()
    }
    /** 挑出归属越界（或无目录前缀）的 URL。 */
    function urlsOutOfScope(urls, scopes) {
      return urls.filter((u) => {
        const f = folderOfUrl(u)
        return !f || !matchFolderScope(f, scopes)
      })
    }
    /** 按换行/分号切 URL 列表（VCP organize 只认换行，这里多容一档）。 */
    function splitUrls(text) {
      return String(text || '').split(/[\n;；]+/).map((s) => s.trim().replace(/^[-*]\s*/, '')).filter(Boolean)
    }
    async function dailyCall(pluginName, args) {
      return unwrapDailyNote(await callBridge(pluginName, args))
    }
    /** 插件返回统一转文本：字符串直用，对象取 message/result，余下 JSON。 */
    function renderPluginData(data, max) {
      const cap = max || 20000
      if (typeof data === 'string') return clipText(data, cap)
      if (data && typeof data === 'object') {
        const t = data.message || data.result || ''
        if (t) return clipText(String(t), cap)
      }
      return clipText(JSON.stringify(data === undefined ? null : data), cap)
    }
    /** 把 DailyNoteManager list 的文本回切成条目（文件名本身含方括号，故贪婪到行末）。 */
    function parseListEntries(text) {
      const entries = []
      let cur = null
      for (const line of String(text || '').split(/\r?\n/)) {
        const m = /^--- \[(.*)\] ---\s*$/.exec(line)
        if (m) {
          if (cur) entries.push(cur)
          cur = { url: m[1], lines: [] }
          continue
        }
        if (cur) cur.lines.push(line)
      }
      if (cur) entries.push(cur)
      return entries.map((e) => {
        const content = e.lines.join('\n').replace(/\s+$/, '')
        const dm = /^(\d{4}-\d{2}-\d{2})-/.exec(folderOfUrl(e.url) ? e.url.slice(folderOfUrl(e.url).length + 1) : e.url)
        const tagLine = (content.split(/\r?\n/).filter((l) => /^\s*Tag:/i.test(l)).pop() || '').trim()
        return { url: e.url, date: dm ? dm[1] : '', content, tagLine, chars: content.length }
      })
    }
    /** 取单篇全文：VCP 无按 URL 读取命令，借 list 同日范围再挑出该篇。 */
    async function readDiaryUrl(url) {
      const folder = folderOfUrl(url)
      const name = url.slice(folder.length + 1)
      const dm = /^(\d{4})-(\d{2})-(\d{2})-/.exec(name)
      if (!dm) return { error: 'URL 文件名未带 YYYY-MM-DD-HH_MM_SS 日期前缀，无法定位（这是 URL 格式问题，不是桥故障）。先 action=list 拿准确 URL。' }
      const date = dm[1] + '-' + dm[2] + '-' + dm[3]
      const r = await dailyCall('DailyNoteManager', { command: 'list', folder: folder, startDate: date, endDate: date })
      if (r.error) return { error: '读取失败: ' + r.error }
      const hit = parseListEntries(r.data).find((e) => e.url === url || e.url.slice(e.url.lastIndexOf('/') + 1) === name)
      if (!hit) return { error: '在 ' + folder + '/' + date + ' 的目录里没找到该篇，URL 可能有误（大小写/后缀）。' }
      return { ok: true, entry: hit }
    }
    /** update 预检：target 必须在指定库内唯一可定位，否则拒绝——放行会让 VCP 兜底扫全库并可能改写他人日记本。 */
    async function precheckTarget(target, folder, url) {
      if (url) {
        const got = await readDiaryUrl(url)
        if (got.ok && (got.entry.content.indexOf(target) >= 0 || diaryLoose(got.entry.content).indexOf(diaryLoose(target)) >= 0)) {
          return { ok: true, where: url }
        }
      }
      const probe = pickProbeLine(target)
      if (!probe) return { error: 'target 里没有可用于定位的长行（需 ≥15 字符的连续文本）。' }
      let s
      try {
        s = await dailyCall('DailyNoteSearcher', { query: probe, folder: folder, max_results: 8, context_lines: 0, preview_length: 40 })
      } catch (e) {
        s = { error: '桥调用异常: ' + String((e && e.message) || e) }
      }
      if (s.error) {
        return { ok: false, unverified: true, why: '定位通道不可用（' + s.error + '）' + (url ? '，且 ' + url + ' 的原文里没有这段 target' : '') }
      }
      const notes = (s.data && s.data.notes) || []
      const join = (n) => (n.folder_name ? n.folder_name + '/' : '') + n.name
      const looseTarget = diaryLoose(target)
      const exact = notes.filter((n) => (n.content || '').indexOf(target) >= 0)
      const loose = notes.filter((n) => (n.content || '').indexOf(target) < 0 && diaryLoose(n.content || '').indexOf(looseTarget) >= 0)
      const located = exact.concat(loose)
      if (located.length > 1) {
        return {
          error: '这段 target 在「' + folder + '」里命中 ' + located.length + ' 篇，无法确定要改哪一篇（VCP 只会改扫描到的第一篇）：\n' +
            located.map((n) => '  - ' + join(n)).join('\n') +
            '\n请加长 target 直到唯一，或带上 url 参数指定目标篇。',
        }
      }
      if (located.length === 1) return { ok: true, where: join(located[0]), loose: loose.length === 1 }
      const near = notes.find((n) => (n.content || '').indexOf(probe) >= 0)
      if (near) return { ok: false, fuzzy: true, where: join(near) }
      return {
        error: '在「' + folder + '」里定位不到这段 target' + (url ? '（也不是 ' + url + ' 的原文）' : '') +
          '。请先 dailynote_read action=search/read 取回原文，逐字复制连续片段再改；' +
          '硬写会让 VCP 兜底扫描其它日记本、有误改他人档案的风险。确认无误可加 force:true 跳过预检。',
      }
    }

    ctx.tools.register(defineTool({
      name: 'dailynote_write',
      description: 'VCP 日记系统写侧（署名溟月，经 DailyNote/DailyNoteManager 的 FIFO 队列与知识库索引协调，写入后后台向量化、lightmemo 可召回）。action=create 新建工程档案（默认）；action=update 修订旧档（target/replace 原文替换，默认先读后写预检）；action=organize 合并多篇旧档并归档到「已整理」。可写目录由白名单限定（默认 DSH工程档案、溟月的知识），越界拒绝。沉淀可复用经验/开发节点/重要事件用 create；改既有结论、补踩坑后续用 update；同一主题多篇零散档案收束成一篇用 organize。',
      parameters: {
        action: { type: 'string', enum: ['create', 'update', 'organize'], description: '写动作，默认 create。' },
        content: { type: 'string', description: 'create/organize 必填：正文。create 时不要写 [日期]/[时间]/Tag 头尾——工具自动补全；organize 时末尾须带 Tag: 行或用 tag 参数。信息密度优先：保留洞察链条、决策脉络、关键实体。' },
        title: { type: 'string', description: 'create 必填：标题（作文件名后缀），简明点题。' },
        category: { type: 'string', enum: CATEGORIES, description: 'create 分类：工程经验（可复用方法论/踩坑）/ 开发节点（里程碑/重要变更）/ 重要事件。默认工程经验。' },
        tags: { type: 'string', description: 'create/organize 标签，逗号分隔。Tag 是有序河道（检索系统按序列曲线逐段读取，顺序即信息）：事件与专名领头、机制与概念居中、泛化归类殿后；每枚 tag 必须在正文有血肉；相邻不同义反复；宁要 3~8 枚短链不要杂草；category 词（工程经验/开发节点/重要事件）不进 tag。create 不提供时默认用 category。' },
        folder: { type: 'string', description: '目标日记库；缺省落白名单首库（DSH工程档案）。只接受写白名单内的目录。' },
        target: { type: 'string', description: 'update 必填：要被替换的旧内容，≥15 字符，必须是从 dailynote_read 取回的逐字连续原文（勿凭记忆复写）。' },
        replace: { type: 'string', description: 'update 必填：替换后的新内容。空串表示删除该片段。' },
        url: { type: 'string', description: 'update 可选：目标篇 URL（来自 list/search 输出），给了可精确定位并加强预检。' },
        force: { type: 'boolean', description: 'update 跳过先读后写预检（自担跨库误改风险），仅在预检通道故障时使用。' },
        urls: { type: 'string', description: 'organize 必填：待合并归档的旧档 URL 列表，换行分隔（来自 dailynote_read action=list）。' },
        Date: { type: 'string', description: 'create/organize 新档日期 YYYY-MM-DD，缺省今天。' },
        fileName: { type: 'string', description: 'organize 可选：新档文件名后缀（create 用 title）。' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args) {
        const a = args || {}
        const action = ['create', 'update', 'organize'].indexOf(String(a.action || '').trim()) >= 0 ? String(a.action).trim() : 'create'
        const wf = guardWriteFolder(a.folder)
        if (!WRITE_FOLDERS.length) return '**拒绝**: 写白名单为空（config.writeFolders 未配置有效目录），为安全起见拒绝一切写入。'
        if (!wf) return '**拒绝**: 目录「' + String(a.folder || '') + '」不在写白名单（' + WRITE_FOLDERS.join('、') + '）。改配置 writeFolders 或换目录。'
        try {
          if (action === 'create') {
            if (!a.content || !String(a.content).trim()) return '**错误**: create 需要 content（正文）。'
            if (!a.title || !String(a.title).trim()) return '**错误**: create 需要 title。'
            const now = new Date()
            const dateStr = a.Date && /^\d{4}-\d{2}-\d{2}$/.test(String(a.Date)) ? String(a.Date) : todayStr()
            const timeStr = pad(now.getHours()) + ':' + pad(now.getMinutes())
            const category = CATEGORIES.indexOf(a.category) >= 0 ? a.category : '工程经验'
            const bodyText = String(a.content).replace(/^\s*\[\d{4}-\d{2}-\d{2}\]\s*-\s*\S+\n?/, '').replace(/\s+$/, '')
            let tagLine = Array.isArray(a.tags) ? a.tags.join(', ') : String(a.tags || '')
            tagLine = tagLine.replace(/^[Tt]ag:\s*/, '').trim()
            // category 词不进 Tag（与本工具 schema 描述一致）。仅当调用方完全没给 tags 时兜底用 category：
            // VCP 核心 DailyNote 的 processTags 在既无 Tag 行、又无外部 Tag 时会直接抛错，故此处必须留一个值。
            if (!tagLine) tagLine = category
            const title = String(a.title).trim().replace(/[\\/:*?"<>|]/g, '_')
            // content 可能自带 Tag 行（调用方把整段草稿连 Tag 一起交进来）。若照旧再拼一行，
            // 磁盘上就会留两行 Tag —— 检索按最后一行取，但审计与人工阅读都会被误导
            // （2026-10-18 16:55 实测：20 行正文里 Tag 行 = 2）。这里先剥掉正文里的 Tag 行，
            // 再由本工具统一追加唯一一行；调用方写与不写 Tag 都得到同一结果。
            const bodyNoTag = bodyText.split(/\r?\n/).filter((line) => !/^\s*Tag:/i.test(line)).join('\n').replace(/\s+$/, '')
            const r = await dailyCall('DailyNote', {
              command: 'create', folder: wf, maid: DIARY_MAID, Date: dateStr,
              fileName: '[' + category + ']' + title,
              Content: '[' + timeStr + '] [' + category + '] ' + bodyNoTag + '\nTag: ' + tagLine,
            })
            if (r.error) return '**日记写入失败**: ' + r.error
            const d = r.data || {}
            return d.message || d.folder
              ? ('✓ 日记已写入: ' + (d.folder || wf) + '/' + (d.fileName || '') + (d.indexStatus ? ' [索引' + d.indexStatus + ']' : ''))
              : ('✓ 写入响应: ' + JSON.stringify(d))
          }
          if (action === 'update') {
            const target = String(a.target || '')
            const repl = typeof a.replace === 'string' ? a.replace : ''
            if (!target) return '**错误**: update 需要 target（要被替换的逐字原文）。'
            if (target.length < 15) return '**错误**: target 至少 15 字符（VCP 安全线），过短极易误替换。'
            const scopeUrl = String(a.url || '').trim()
            if (scopeUrl) {
              const uf = matchFolderScope(folderOfUrl(scopeUrl), WRITE_FOLDERS)
              if (!uf) return '**拒绝**: url 所在库「' + folderOfUrl(scopeUrl) + '」不在写白名单（' + WRITE_FOLDERS.join('、') + '）。'
            }
            let preNote = ''
            if (!a.force) {
              const scopeFolder = scopeUrl ? folderOfUrl(scopeUrl) : wf
              const pre = await precheckTarget(target, scopeFolder, scopeUrl)
              if (pre.error) return '**更新被预检拦截**: ' + pre.error
              if (pre.fuzzy) return '**更新被预检拦截**: target 在「' + pre.where + '」只找到模糊相似段，非逐字原文。请先 dailynote_read action=read 取回原文逐字复制；确认无误可加 force:true。'
              if (pre.unverified) return '**更新被预检拦截**: ' + pre.why + '。定位不可验证时默认不写（避免误改他人档案）；请带上 url 精确指定目标篇，或确认无误后加 force:true。'
              if (pre.where && pre.where !== scopeUrl) preNote = '\n定位到: ' + pre.where + (pre.loose ? '（脱水归一匹配，非逐字）' : '')
            }
            const parsed = await callBridge('DailyNote', {
              // 注意：update 只传 folder、不传 maid——VCP 侧 owner 守卫下带 maid 会把目标库踢出优先队列、
              // 退化成全库顺序扫描（dailynote.js isFolderMatchAllowedByOwner），跨库误改风险反而更大。
              command: 'update', folder: scopeUrl ? folderOfUrl(scopeUrl) : wf, target: target, replace: repl,
            })
            const u = unwrapDailyNote(parsed)
            if (u.error) {
              const inner = parsed && parsed.result
              const fd = inner && inner.result && inner.result.fuzzyDiff
              let msg = '**日记更新失败**: ' + u.error
              if (fd) msg += '\n最接近候选: ' + fd.candidateFile + '\n' + clipText(fd.diff, 4000) + '\n请对照上面 diff 修正 target（逐字复制）后重试。'
              return msg
            }
            const d = u.data || {}
            const loc = d.folder && d.fileName ? d.folder + '/' + d.fileName : wf
            // 事后复核：预检放行后 VCP 仍可能兜底扫全库，实际落库必须在写白名单内。
            if (d.folder && !matchFolderScope(d.folder, WRITE_FOLDERS)) {
              return '⚠ 越库改写告警: 本次更新落在「' + d.folder + '」，已超出写白名单（' + WRITE_FOLDERS.join('、') +
                '）。请立即用同样的 target/replace 反向改回，并检查该篇是否被误改。\n实际目标: ' + loc + preNote
            }
            return '✓ 日记已更新: ' + loc + (d.indexStatus ? ' [索引' + d.indexStatus + ']' : '') + preNote + (d.message ? '\n' + d.message : '')
          }
          // organize
          const list = splitUrls(a.urls)
          if (!list.length) return '**错误**: organize 需要 urls（待合并归档的旧档 URL，换行分隔，来自 dailynote_read action=list）。'
          if (!a.content || !String(a.content).trim()) return '**错误**: organize 需要 content（合并后的新正文）。'
          const bad = urlsOutOfScope(list, WRITE_FOLDERS)
          if (bad.length) return '**拒绝**: 以下 URL 所在库不在写白名单（' + WRITE_FOLDERS.join('、') + '）:\n' + bad.join('\n')
          const r = await dailyCall('DailyNoteManager', {
            command: 'organize', urls: list.join('\n'), folder: wf, maid: DIARY_MAID,
            Date: a.Date && /^\d{4}-\d{2}-\d{2}$/.test(String(a.Date)) ? String(a.Date) : todayStr(),
            Content: String(a.content), Tag: a.tags ? String(a.tags) : undefined, fileName: a.fileName ? String(a.fileName) : undefined,
          })
          if (r.error) return '**日记整理失败**: ' + r.error
          return (r.status === 'partial' ? '⚠ 整理部分完成: ' : '✓ 整理完成: ') + renderPluginData(r.data, 8000)
        } catch (e) {
          return '**日记写入错误**: ' + String((e && e.message) || e)
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'dailynote_read',
      description: 'VCP 日记系统读侧：查目录(list)/取原文(read)/全文搜索(search)/联想关联(associate)，是 update/organize 的先读配套——改档前必须用本工具拿回逐字原文。范围限读白名单（config.readFolders）。list 默认紧凑目录行（日期+标题+Tag），read 按需取整篇，search 走 Rust 引擎全文/正则，associate 用向量语义发现关联档案。',
      parameters: {
        action: { type: 'string', enum: ['list', 'read', 'search', 'associate'], required: true, description: 'list 按日期范围列目录（含每篇 URL）；read 按 URL 取整篇原文；search 全文/正则检索；associate 找语义关联档。' },
        folder: { type: 'string', description: '日记库名，逗号/竖线分隔多个；缺省为整个读白名单。越界项自动忽略。' },
        startDate: { type: 'string', description: 'list 起始日期 YYYY-MM-DD（缺省近 30 天）。' },
        endDate: { type: 'string', description: 'list 结束日期 YYYY-MM-DD（缺省今天）。' },
        url: { type: 'string', description: 'read/associate 必填：日记 URL（来自 list/search 输出，形如 库名/文件名.txt）；read 支持换行分隔多篇。' },
        query: { type: 'string', description: 'search 必填：关键词或正则（配 is_regex）。按行匹配。' },
        is_regex: { type: 'boolean', description: 'search 关键词按正则解析，默认 false（按字面量）。' },
        context_lines: { type: 'integer', description: 'search 命中行前后上下文行数，默认 2。' },
        max_results: { type: 'integer', description: 'search 最多返回文件数，默认 20。' },
        k: { type: 'integer', description: 'associate 返回条数，默认 10。' },
        minScore: { type: 'number', description: 'associate 最低相似度阈值 0~1，默认 0 不过滤。' },
        full: { type: 'boolean', description: 'list 是否直接带每篇全文（默认 false 只出紧凑目录行；全文请逐篇 read）。' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args) {
        const a = args || {}
        const action = String(a.action || '').trim()
        if (['list', 'read', 'search', 'associate'].indexOf(action) < 0) return '**错误**: action 必须是 list/read/search/associate。'
        try {
          if (action === 'list') {
            // 缺省只铺写库（自家两库），显式 folder 才按读白名单铺开——避免 8 库扇出噪声。
            const folders = splitFolderList(a.folder).length ? guardReadFolders(a.folder) : WRITE_FOLDERS
            const end = a.endDate && /^\d{4}-\d{2}-\d{2}$/.test(String(a.endDate)) ? String(a.endDate) : todayStr()
            let start = a.startDate && /^\d{4}-\d{2}-\d{2}$/.test(String(a.startDate)) ? String(a.startDate) : ''
            if (!start) {
              const d = new Date(); d.setDate(d.getDate() - 30)
              start = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
            }
            if (start > end) return '**错误**: startDate 晚于 endDate。'
            const lines = []
            for (const f of folders) {
              const r = await dailyCall('DailyNoteManager', { command: 'list', folder: f, startDate: start, endDate: end })
              if (r.error) { lines.push('「' + f + '」: 失败 - ' + r.error); continue }
              const entries = parseListEntries(r.data)
              if (!entries.length) { lines.push('「' + f + '」: ' + start + '~' + end + ' 无日记'); continue }
              if (a.full) { lines.push(clipText(r.data, 30000)); continue }
              lines.push('「' + f + '」' + start + '~' + end + ' 共 ' + entries.length + ' 篇：')
              for (const e of entries) {
                lines.push('- [' + e.date + '] ' + e.url.split('/').slice(1).join('/') + (e.tagLine ? '  ‹' + clipText(e.tagLine, 120) + '›' : ''))
              }
            }
            return lines.join('\n') || '（无结果）'
          }
          if (action === 'read') {
            const list = splitUrls(a.url)
            if (!list.length) return '**错误**: read 需要 url（来自 list/search）。'
            const bad = urlsOutOfScope(list, READ_FOLDERS)
            if (bad.length) return '**拒绝**: 以下 URL 所在库不在读白名单:\n' + bad.join('\n')
            const out = []
            for (const u of list) {
              const got = await readDiaryUrl(u)
              if (got.error) { out.push('--- [' + u + '] ---\n读取失败: ' + got.error); continue }
              out.push('--- [' + got.entry.url + '] (' + got.entry.chars + ' 字符) ---\n' + clipText(got.entry.content, 30000))
            }
            return out.join('\n\n')
          }
          if (action === 'search') {
            const q = String(a.query || '').trim()
            if (!q) return '**错误**: search 需要 query。'
            const only = splitFolderList(a.folder).filter(Boolean)
            const reqArgs = {
              query: q, is_regex: !!a.is_regex, case_sensitive: false, whole_word: false,
              context_lines: a.context_lines != null ? a.context_lines : 2,
              max_results: a.max_results != null ? a.max_results : 20,
              preview_length: 80,
            }
            if (only.length === 1) reqArgs.folder = only[0]
            else if (only.length > 1) return '**提示**: search 单次只支持一个 folder，请逐库调用。'
            const r = await dailyCall('DailyNoteSearcher', reqArgs)
            if (r.error) return '**日记搜索失败**: ' + r.error
            const d = r.data || {}
            let notes = (d.notes || []).filter((n) => matchFolderScope(n.folder_name, READ_FOLDERS))
            if (only.length === 1) notes = notes.filter((n) => matchFolderScope(n.folder_name, [only[0]]))
            if (!notes.length) return '未命中（' + q + '）。共 ' + ((d.notes || []).length) + ' 条原始结果均在白名单外或不存在。'
            let out = '命中 ' + notes.length + ' 个文件（库内过滤后）：\n'
            for (const n of notes.slice(0, 10)) {
              out += '\n===== ' + n.folder_name + '/' + n.name + '（' + n.last_modified + '）=====\n'
              const ms = (n.matches || []).slice(0, 6)
              if (!ms.length) { out += n.preview + '\n'; continue }
              for (const m of ms) {
                out += (m.context_before || []).map((l) => '  ' + l).join('\n') + '\n'
                out += '> ' + m.line_content + '\n'
                out += (m.context_after || []).map((l) => '  ' + l).join('\n') + '\n'
              }
            }
            if (notes.length > 10) out += '\n…另有 ' + (notes.length - 10) + ' 个文件未展开，可提高 max_results 或换关键词。'
            return clipText(out, 30000)
          }
          // associate
          const u = String(a.url || '').trim()
          if (!u) return '**错误**: associate 需要 url（源档 URL，来自 list/search）。'
          const bad = urlsOutOfScope(splitUrls(u), READ_FOLDERS)
          if (bad.length) return '**拒绝**: 源 URL 所在库不在读白名单:\n' + bad.join('\n')
          const r = await dailyCall('DailyNoteManager', {
            command: 'associate', url: splitUrls(u).join('\n'),
            range: guardReadFolders(a.folder).join(','),
            k: a.k != null ? a.k : 10, minScore: a.minScore != null ? a.minScore : 0,
          })
          if (r.error) return '**联想检索失败**: ' + r.error
          return renderPluginData(r.data, 20000)
        } catch (e) {
          return '**日记读取错误**: ' + String((e && e.message) || e)
        }
      },
    }))

    // =====================================================================
    // 5) chrome_bridge — VCP ChromeBridge 插件（admin_api 代理）
    // =====================================================================
    const CMD_LIST = 'open_url / browser_status / open_chrome / list_tabs / execute_script / get_page_info / cdp_runtime_evaluate / wait / capture_screenshot / query_js / click / switch_tab / keep_chrome_alive / scroll / type / send_keys / get_page_image / cdp_network_query / cdp_get_response_body / cdp_storage_get_cookies / close_managed_tabs / close_tab / cdp_emulation_set_device_metrics_override';
    // 冷门命令(实测 215 个会话中 0 次调用)从常驻清单移出,用 command:'help' 按需查。
    // 动因不是省字符,是收窄选择面:42 选 1 变成 23 选 1。
    const CMD_COLD = 'close_chrome query_html set_value select_option check hover wait_for execute_saved_script page_code_search cdp_start cdp_stop cdp_clear_network cdp_dom_get_document cdp_dom_query_selector cdp_network_set_extra_http_headers cdp_network_set_user_agent_override cdp_emulation_set_timezone_override cdp_emulation_set_locale_override cdp_storage_clear_data_for_origin';

    ctx.tools.register(defineTool({
      name: 'chrome_bridge',
      description: '观察并操作 VCP 托管的 Chrome（ChromeBridge 2.4）。命令：' + CMD_LIST + '。冷门命令（19 个，含 cdp_* 等）用 command:"help" 查，可按前缀过滤。' +
        '页面信息为 Grounded Markdown（含 [图片 IMG*｜描述] 标注，用 get_page_image 查看）。敏感 DOM（password/token/cookie 等）默认脱敏。execute_script/cdp_*/storage 系列为高权限指令，仅作用于 managed Chrome。截图返回会以占位标注（data URL 不嵌入文本）。',
      parameters: {
        // 参数描述只在"名字不自明或有互斥语义"处保留;其余靠 enum 与类型自解释。
        // 47 个命令的逐条说明在 description 的 CMD_LIST 里,不在此重复。
        command: { type: 'string', required: true, description: '命令名，见 description 的命令清单。' },
        target: { type: 'string', description: '元素（vcp-* ID / selector / xpath / 语义文本）或标签页。' },
        text: { type: 'string', description: 'type 文本 / page_code_search 关键词 / execute_script 源码。' },
        url: { type: 'string' },
        keys: { type: 'string', description: '如 Enter / Ctrl+A / ArrowDown。' },
        direction: { type: 'string', enum: ['down', 'up', 'left', 'right', 'bottom', 'top', 'to', 'page_down', 'page_up', 'page_left', 'page_right'] },
        amount: { type: 'number', description: 'scroll 像素数。' },
        query: { type: 'string', description: 'page_code_search 的关键词或正则。' },
        value: { type: 'string', description: 'set_value / select_option 的目标值。' },
        format: { type: 'string', enum: ['png', 'jpeg'] },
        quality: { type: 'integer', description: 'JPEG 1-100。' },
        imageId: { type: 'string', description: 'IMG* 或严格图片 ID。' },
        condition: { type: 'string', enum: ['element', 'visible', 'hidden', 'text', 'url', 'value', 'dom_stable'] },
        timeoutMs: { type: 'number', description: 'wait_for 超时 / open_chrome 等待（毫秒）。' },
        waitMs: { type: 'number', description: '默认 1000。' },
        expression: { type: 'string', description: 'cdp_runtime_evaluate 表达式。' },
        executionWorld: { type: 'string', enum: ['MAIN', 'ISOLATED'], description: '默认 MAIN。' },
        scriptName: { type: 'string', description: 'execute_saved_script 的文件名。' },
        browserTarget: { type: 'string', enum: ['managed', 'user', 'distributed'], description: '默认 managed。' },
        checked: { type: 'boolean', description: 'check 的目标状态，默认 true。' },
        snapshotId: { type: 'string', description: 'strict 时阻止旧句柄。' },
        strict: { type: 'boolean', description: '严格快照校验。' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      async execute(args) {
        const a = args || {}
        const command = String(a.command || '').trim()
        if (!command) return '**错误**: 缺少 command。可用命令：' + CMD_LIST
        if (command === 'help') {
          // 冷门命令的用法按需返回。清单本身来自 CMD_COLD,不重复硬编码。
          const q = String(a.target || a.query || '').trim().toLowerCase();
          const cold = CMD_COLD.split(" ").filter((n) => !q || n.includes(q));
          if (cold.length === 0) return '未匹配。冷门命令：' + CMD_COLD;
          return '冷门命令（' + cold.length + ' 个）：\n' + cold.map((n) => '- ' + n).join('\n')
            + '\n\n常用命令已在 description 清单里，直接调用即可。';
        }
        const reqArgs = { command: command }
        for (const k of Object.keys(a)) {
          if (k === 'command') continue
          if (a[k] === undefined || a[k] === null) continue
          reqArgs[k] = a[k]
        }
        try {
          const parsed = await callBridge('ChromeBridge', reqArgs)
          if (parsed.status !== 'success') return '**ChromeBridge 调用失败**: ' + (parsed.error || JSON.stringify(parsed))
          const res = parsed.result
          if (res && res.plugin_error) return '**ChromeBridge**: ' + res.plugin_error
          const content = (res && res.content) || []
          const texts = content.filter((b) => b && b.type === 'text').map((b) => b.text)
          const images = content.filter((b) => b && (b.type === 'image_url' || (b.image_url && typeof b.image_url === 'object')))
          let out = texts.join('\n')
          if (images.length > 0) {
            out += (out ? '\n\n' : '') + '[含 ' + images.length + ' 张图片 data URL，未嵌入文本；如需查看可用 get_page_image 或单独处理]'
          }
          return out || '**ChromeBridge**: 未返回内容（命令 ' + command + '）。'
        } catch (e) {
          return '**ChromeBridge 错误**: ' + String((e && e.message) || e)
        }
      },
    }))
  },
}
