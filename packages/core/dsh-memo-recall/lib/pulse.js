// 脉冲透镜：每步动作语义查询的纯函数层。
// 契约来源（宿主 dsh-agent-loop，2026-10 勘察实证）：
//   tool/call   { turn, step, callId, name, arguments }
//   tool/result { turn, step, message: { callId, content: [{type,text}], isError }, error?: { info } }
// 设计约束：
//   - 纯函数、零 IO，全部可离线单测；
//   - 查询预算 200 字符：工具名 ≤15 + 报错核心行 ≤150（报错优先全额）+ 参数/diff 特征词补足；
//   - 注入物 append-only：本模块只生产查询与渲染文本，不触碰任何历史节点。
//     脉冲消息的 source.kind 用独立标识（≠ boundaries.js 的 MEMO_SOURCE），
//     故 reconcileMemo/retire 的替换清单永远扫不到它——append-only 由类型隔离物理保证。

import { randomUUID } from 'node:crypto'

/** 纯读/查询类工具：不产生代码改动与报错，脉冲免查（配置 pulseReadTools 可追加）。 */
const READ_TOOLS = new Set([
  'ReadCode', 'Outline', 'FindSymbol', 'Trace', 'ListWorkspaces', 'ListProjects',
  'GetProject', 'BindProject', 'SearchHistory', 'GetNodeDiff', 'ResolveEdit',
  'forge_blueprint', 'dailynote_read', 'lightmemo', 'lightmemo_read',
  'everything_search', 'code_searcher', 'git_search', 'deepwiki',
  'web_search', 'web_fetch', 'doubao_search', 'firecrawl_dev_search',
  'job_list', 'job_output', 'emoji', 'get_goal', 'ctx_meter',
  'todo_checkpoint', 'task_board_get', 'task_board_list',
])

/**
 * 工具步分类：'skip'（纯读，免查）| 'pulse'（写/执行/未知，可查询）。
 * 未知工具默认 pulse——漏查一次直觉的代价高于多查一次库。
 */
export function classifyToolCall(name, extraReadTools) {
  const n = String(name || '')
  if (!n) return 'skip'
  if (READ_TOOLS.has(n)) return 'skip'
  if (extraReadTools) {
    for (const t of String(extraReadTools).split(/[,\s]+/)) {
      if (t && t === n) return 'skip'
    }
  }
  return 'pulse'
}

/** 执行/验证类工具：跑命令、看输出——轨迹里算一次「验证」。 */
const VERIFY_TOOLS = new Set(['ops_bash', 'pwsh', 'chrome_bridge', 'execute_script'])

/** 壳命令类工具：参数里的 const/if 不代表代码改动，只看回执里的新增行（diff）或报错。 */
const SHELL_TOOLS = new Set(['ops_bash', 'pwsh', 'chrome_bridge', 'execute_script'])

/** 解析 tool/call 的 arguments（宿主事件里是 JSON 串）。 */
export function parseArgs(call) {
  const raw = call?.arguments ?? call?.data?.arguments
  if (typeof raw === 'string') { try { return JSON.parse(raw) } catch { return null } }
  return raw && typeof raw === 'object' ? raw : null
}

/** 有效工具名：project_forge 按 args.command 分派（ReadCode/Outline 是读，EditCode 是写）。 */
export function effectiveToolName(call) {
  const n = String(call?.name || call?.data?.name || '')
  if (n === 'project_forge') {
    const cmd = String(parseArgs(call)?.command || '')
    if (cmd) return cmd
  }
  return n
}

/** 严格 diff 锚点：只扫 + 新增行；没有新增行就返回空（壳命令的输出不算改动）。 */
export function strictDiffTags(result, limit = 8) {
  const added = resultText(result).split('\n').filter(l => /^\s*\+\s?/.test(l) && l.trim() !== '+')
  if (!added.length) return []
  const out = []
  const seen = new Set()
  for (const m of added.join(' ').matchAll(FEATURE_WORDS)) {
    if (seen.has(m[0])) continue
    seen.add(m[0])
    out.push(m[0])
    if (out.length >= limit) break
  }
  return out
}

/** 三态工具分类（轨迹用）：read=只看了看 / verify=跑了一把 / write=动了手。 */
export function toolKind(name, extraReadTools) {
  const n = String(name || '')
  if (!n) return 'write' // 无名工具按「动手」处理：漏查一次直觉比多查一次库贵
  if (VERIFY_TOOLS.has(n)) return 'verify'
  return classifyToolCall(n, extraReadTools) === 'skip' ? 'read' : 'write'
}

/** 胶水词表（T2 意图通道）：这些词出现在自述里，是「思想先走偏」的直接证据。
 *  刻意保持短表高精度——宁可漏，不可误报（误报会把我从正确决策上推歪）。 */
const GLUE_WORDS = ['兼容层', '过渡层', '过渡一下', '先绕过', '临时方案', '临时缓存', '兜底',
  '辅助类', '中间层', '包装一层', '再包一层', '先写死', '适配层', '转发一下', '桥接一下', 'workaround', 'hack']

/** 从自述文本里抓胶水词（去重，≤limit）。 */
export function matchGlueWords(text, limit = 3) {
  const t = String(text || '')
  const out = []
  for (const w of GLUE_WORDS) {
    if (t.includes(w) && !out.includes(w)) out.push(w)
    if (out.length >= limit) break
  }
  return out
}

const FIX_HINTS = /(修复|修好|排查|排障|报错|异常|崩溃|回归|失效|不生效|为什么|定位|fix|bug)/i
const FEATURE_HINTS = /(新增|实现|添加|支持|重构|迁移|升级|搭建|接入|从零|初版|草稿|feature)/i

/** Todo 形状（T3 调制器）：同一动作在「修 bug」里可疑、在「做新功能」里正常。 */
export function boundaryShape(text) {
  const t = String(text || '')
  if (FIX_HINTS.test(t)) return 'fix'
  if (FEATURE_HINTS.test(t)) return 'feature'
  return 'unknown'
}

const ERROR_HEAD = /^(?:[A-Za-z$_]*(?:Error|Exception|Panic|Fatal)\b|Error\b|Traceback|Assertion failed)/i
const ERROR_MARK = /(?:exit code\s*[:=]?\s*[1-9]|✗|✘|AssertionError|Cannot read propert|is not a function|is not defined|undefined is not|null pointer|ECONNREFUSED|ENOENT|EPERM|EACCES|syntax error|parse error|failed \d+|failures \d+[1-9])/i

/** 从 tool/result 提取报错信号：宿主 isError 标志优先，其次回执文本核心错误行。 */
export function extractErrorSignal(result) {
  const msg = result?.message || result?.data?.message || result
  const info = result?.error?.info
  const text = Array.isArray(msg?.content)
    ? msg.content.filter(b => b?.type === 'text').map(b => b.text).join('\n')
    : ''
  if (msg?.isError === true || info) {
    const head = info ? `${info.name || 'Error'}: ${info.message || ''}`.trim() : ''
    return { error: true, core: singleLine(head || firstErrorLine(text) || text).slice(0, 150) }
  }
  const line = firstErrorLine(text)
  return line ? { error: true, core: singleLine(line).slice(0, 150) } : { error: false, core: '' }
}

function firstErrorLine(text) {
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (ERROR_HEAD.test(line) || ERROR_MARK.test(line)) return line
  }
  return ''
}

function singleLine(text) { return String(text || '').replace(/\s+/g, ' ').trim() }

/** tool/result（或其 data、或裸 message）的回执文本：text 块拼接。 */
function resultText(result) {
  const msg = result?.message || result?.data?.message || result
  return Array.isArray(msg?.content)
    ? msg.content.filter(b => b?.type === 'text').map(b => b.text).join('\n')
    : ''
}

/** diff/代码文本中的新增行与结构关键字（Nova 淬火锚点同源：EditCode, if (, try {, export function…）。 */
const FEATURE_WORDS = /\b(?:if|else if|else|try|catch|finally|let|const|var|function|export|import|return|await|async|throw|switch|case|for|while|typeof|instanceof)\b|[a-z$_]*(?:Error|Exception)\b|\bis[A-Z]\w*|\bflag\b|\bboolean\b|=== null|!== undefined|=== undefined|!== null|\?\?|\?\.|=>/g

/** 参数摘要：取 path/command/files/title 等关键词段，每段截断，最多两段。
 *  宿主 tool/call 的 arguments 实为 JSON 串（事件通路实证），先解析再取键。 */
function argumentDigest(args) {
  if (typeof args === 'string') { try { args = JSON.parse(args) } catch { return args.slice(0, 32) } }
  if (!args || typeof args !== 'object') return ''
  const keys = ['path', 'command', 'target', 'replace', 'files', 'title', 'content', 'query', 'todos']
  const parts = []
  for (const k of keys) {
    const v = args[k]
    if (typeof v === 'string' && v.trim()) parts.push(v.trim())
    if (parts.length >= 2) break
  }
  return parts.map(p => p.split('\n')[0].slice(0, 32)).join(' ')
}

/** 从回执文本提取 diff 新增行（+ 开头）里的特征词序列；非 diff 文本取整体特征词。 */
export function diffFeatureWords(text, limit = 10) {
  const str = String(text || '')
  const addedLines = str.split('\n').filter(l => /^\s*\+\s?/.test(l) && l.trim() !== '+')
  const source = addedLines.length ? addedLines.join(' ') : str
  const seen = new Set()
  const words = []
  for (const m of source.matchAll(FEATURE_WORDS)) {
    const w = m[0]
    if (!seen.has(w)) { seen.add(w); words.push(w) }
    if (words.length >= limit) break
  }
  return words
}

/** 参数文本（JSON 串或对象）中的特征词扫描。 */
function argumentWords(call) {
  const args = call?.arguments ?? call?.data?.arguments
  if (args === undefined || args === null) return []
  const text = typeof args === 'string' ? args : JSON.stringify(args)
  const out = []
  const seen = new Set()
  for (const m of String(text).matchAll(FEATURE_WORDS)) {
    if (!seen.has(m[0])) { seen.add(m[0]); out.push(m[0]) }
  }
  return out
}

/**
 * 前置特征门扫出的字面坏味道标签（去重，≤limit）。
 * 与直觉卡 Tag 里预埋的锚点同源——查询文本显式带上它们，是撞 0.75 阈值的主力。
 */
export function smellTags(call, result, limit = 8) {
  const out = []
  const seen = new Set()
  for (const w of [...diffFeatureWords(resultText(result), 12), ...argumentWords(call)]) {
    if (!seen.has(w)) { seen.add(w); out.push(w) }
    if (out.length >= limit) break
  }
  return out
}

/** 前置特征门：有报错信号，或本地扫出坏味道字面锚 → 值得花一次查询。 */
export function hasSmell(call, result) {
  if (extractErrorSignal(result).error) return true
  if (SHELL_TOOLS.has(effectiveToolName(call))) return strictDiffTags(result).length > 0
  return smellTags(call, result).length > 0
}

/**
 * 拼装脉冲查询（≤ maxChars，默认 200）。
 * 预算：工具名 ≤15；报错步核心行 ≤150 全额优先；非报错步=字面特征标签前置 + 参数摘要。
 * 工具名永远打头——直觉卡 Tag 已预埋工具名锚点，先撞工具名再撞特征。
 */
export function buildPulseQuery(call, result, maxChars = 200) {
  const name = effectiveToolName(call).slice(0, 15)
  if (!name) return ''
  const signal = extractErrorSignal(result)
  let body
  if (signal.error && signal.core) {
    body = signal.core.slice(0, 150)
  } else if (SHELL_TOOLS.has(name)) {
    // 壳命令：只认 + 新增行；不拼参数摘要（路径/命令词是噪音，会把检索拉向长笔记）。
    body = strictDiffTags(result).join(' ').slice(0, 150)
  } else {
    // 前置特征门扫出的字面锚点显式前置——与直觉卡 Tag 同源，是撞 0.75 阈值的主力。
    const args = call?.arguments ?? call?.data?.arguments ?? {}
    const tags = smellTags(call, result)
    body = [tags.join(' '), argumentDigest(args)].filter(Boolean).join(' ').slice(0, 150)
  }
  const query = `${name} ${body}`.replace(/\s+/g, ' ').trim()
  return Array.from(query).slice(0, maxChars).join('')
}

/**
 * 从事件流尾部取最近一对 tool/call + tool/result（同 callId 关联）。
 * 事件按 seq 升序传入（session.snapshotEvents / surface 遍历后的数组）。
 * 返回 { call, result, seq } 或 null（尾部没有已完结的工具交换）。
 */
export function pickLastToolExchange(events) {
  const list = Array.isArray(events) ? events : []
  let resultIdx = -1
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i]
    if (e?.type === 'tool/result') { resultIdx = i; break }
    if (e?.type === 'step/start' || e?.type === 'user/message') break // 跨步/跨轮即停
  }
  if (resultIdx < 0) return null
  const result = list[resultIdx]
  const callId = result?.data?.callId ?? result?.callId
  for (let i = resultIdx - 1; i >= 0; i--) {
    const e = list[i]
    if (e?.type === 'tool/call') {
      const id = e?.data?.callId ?? e?.callId
      if (!callId || !id || id === callId) return { call: e.data || e, result: result.data || result, seq: result.seq }
    }
    if (e?.type === 'turn/start') break
  }
  return null
}

/**
 * 脉冲注入节流器（会话内状态机；时间源可注入，便于离线单测）。
 * 拍板语义（2026-10-14 定案）：
 *   - 注入配额：每边界基础 pulseBudgetPerTodo=3 枚；报错步可破格 +pulseErrorBonus=1（每边界仅一次，合计 ≤4）；
 *   - 空手预算：每边界 pulseEmptyPerTodo=8 次；miss/timeout/候选全被同卡挡才算空手（命中不扣）；
 *     本边界出现过 error 查询后预算 +pulseEmptyBonus=2；
 *   - 总查询硬顶：每边界 pulseMaxQueriesPerTodo=12 次（空手 8 + 注入 4 的物理上限），注入配额满即停查；
 *   - 冷却：距上次注入 ≥pulseStepGap=3 个合格步（步进式，与工具循环节奏解耦）+ pulseFloorMs=5s 时间地板（防连发）；
 *     报错步免步冷却（撞红灯立刻救援），但仍受时间地板与配额约束；
 *   - 同卡：每边界至多一次 + 全会话 ≤pulseMaxCardPerSession=2 次（不终身封禁）；
 *   - 与开工海图（Todo 边界被动召回）不互斥：本器只统计脉冲通路。
 * 调用契约：接线层对每个「非读步」（写/执行工具步）调 tick()；真实查询前调 allowQuery()（通过即计一次），
 *   查询回调里用 isCardAllowed() 在 k 个候选里顺延，无可用卡时 chargeEmpty()；真实注入成功后调 record()。
 */
export function createPulseGovernor({ config = {}, now = Date.now } = {}) {
  const budget = Math.max(0, Math.floor(Number(config.pulseBudgetPerTodo ?? 3)))
  const errorBonus = Math.max(0, Math.floor(Number(config.pulseErrorBonus ?? 1)))
  const emptyBudget = Math.max(0, Math.floor(Number(config.pulseEmptyPerTodo ?? 8)))
  const emptyBonus = Math.max(0, Math.floor(Number(config.pulseEmptyBonus ?? 2)))
  const maxQueries = Math.max(1, Math.floor(Number(config.pulseMaxQueriesPerTodo ?? 12)))
  const stepGap = Math.max(1, Math.floor(Number(config.pulseStepGap ?? 3)))
  const floorMs = Math.max(0, Number(config.pulseFloorMs ?? 5000))
  const maxCardSession = Math.max(1, Math.floor(Number(config.pulseMaxCardPerSession ?? 2)))
  const cardTotals = new Map()
  let inBoundary = new Set()
  let lastAt = -Infinity // 尚未注入过 ⇒ 首查永远放行
  let boundaryKey = ''
  let used = 0        // 已注入枚数（注入配额）
  let queried = 0     // 已发查询次数（总查询硬顶）
  let empty = 0       // 空手次数（miss/timeout/候选全被同卡挡）
  let sawError = false
  let bonusSpent = false
  let sinceInject = stepGap

  const quota = (isError) => budget + (isError && !bonusSpent ? errorBonus : 0)
  const emptyQuota = (isError) => emptyBudget + ((sawError || isError) ? emptyBonus : 0)

  return {
    /** 合格步打卡：推进步冷却计数（每个写/执行步且过特征门都该调一次）。 */
    tick() { if (sinceInject < stepGap) sinceInject++ },
    /** 边界锚变化时重置配额/破格/本边界同卡去重；全会话同卡计数保留。 */
    setBoundary(key) {
      const k = String(key || '')
      if (k === boundaryKey) return
      boundaryKey = k
      used = 0
      queried = 0
      empty = 0
      sawError = false
      bonusSpent = false
      inBoundary = new Set()
      sinceInject = stepGap
    },
    /** 当前边界锚：查询回调据此判断结果是否已跨边界（跨了就不记账）。 */
    currentBoundary() { return boundaryKey },
    /** 查询闸门：注入配额未满 + 空手预算未耗尽 + 总查询硬顶 + 冷却。 */
    allowQuery(isError) {
      if (used >= quota(isError)) return false
      if (queried >= maxQueries) return false
      if (empty >= emptyQuota(isError)) return false
      if (now() - lastAt < floorMs) return false
      if (!isError && sinceInject < stepGap) return false
      queried++
      if (isError) sawError = true
      return true
    },
    /** 候选卡可用性：供查询回调在 k 个候选里顺延；被同卡闸挡住的候选不算可用。 */
    isCardAllowed(cardKey, isError) {
      const k = String(cardKey || '')
      if (!k || used >= quota(isError)) return false
      if (inBoundary.has(k)) return false
      return (cardTotals.get(k) || 0) < maxCardSession
    },
    /** 空手记账：查询发出但没拿到可用卡（miss/timeout/候选全被同卡挡）。 */
    chargeEmpty() { empty++ },
    /** 注入闸门：注入配额 + 同卡（本边界一次 / 全会话上限）。 */
    allowInject(cardKey, isError) {
      const k = String(cardKey || '')
      if (!k || used >= quota(isError)) return false
      if (inBoundary.has(k)) return false
      return (cardTotals.get(k) || 0) < maxCardSession
    },
    /** 仅在真实注入成功后调用：记同卡、扣注入配额、刷新冷却窗。 */
    record(cardKey) {
      const k = String(cardKey || '')
      if (k) { inBoundary.add(k); cardTotals.set(k, (cardTotals.get(k) || 0) + 1) }
      if (used >= budget) bonusSpent = true // 本次吃的是报错破格额度
      used++
      lastAt = now()
      sinceInject = 0
    },
    /** 只读快照（调试与测试用）。 */
    snapshot() {
      return {
        boundaryKey, used, queried, empty, sawError, bonusSpent, sinceInject,
        lastAt: Number.isFinite(lastAt) ? lastAt : 0,
        cards: cardTotals.size,
      }
    },
  }
}

/**
 * 渲染一枚脉冲透镜：≤ pulseMaxChars（默认 140 字符 ≈ 80 tokens 量级）。
 * 自带防压缩引导语——透镜不是事实、不是待办，用完即沉，勿被摘要器收编为约束。
 * 标题剥掉类目前缀（[工程经验] 一类），只留卡名与首句。
 */
export function renderPulse(hit, config = {}) {
  // 兜底与 DEFAULTS.pulseMaxChars 同值，避免两套默认口径
  const maxChars = Math.max(48, Number(config.pulseMaxChars ?? 200))
  const title = String(hit?.title || hit?.tag || '').replace(/^\s*\[[^\]]*\]\s*/, '').trim()
  // 检索元数据头（[时间] [分类]）对注入无信息量，剥掉把字数留给正文
  const body = String(hit?.body || '').replace(/\s+/g, ' ').trim().replace(/^(?:\[[^\]]*\]\s*)+/, '')
  const head = '【直觉闪现·非事实·勿引用·勿保留】'
  const text = `${head}${title}${body ? ' — ' + body : ''}`
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  // 句边界截断：在预算内回退到最后一个完整句读（。！？；…），不斩半句；
  // 无句读的长文退化硬切（保显示量），末尾补省略号提示有下文（不计入预算，总长 ≤ maxChars+1）
  const cut = chars.slice(0, maxChars).join('')
  let end = -1
  for (const mark of ['。', '！', '？', '；', '…']) {
    const i = cut.lastIndexOf(mark)
    if (i + 1 > end) end = i + 1
  }
  const floor = Array.from(head).length + 8 // 保底：前缀 + 标题开头，防止无句读时切到只剩前缀
  if (end < floor) end = maxChars
  return cut.slice(0, end) + '…'
}

/**
 * 脉冲注入消息工厂：新节点、独立 source.kind，只增不改。
 * kind ≠ boundaries.js 的 MEMO_SOURCE，故边界退休/调和逻辑永远扫不到它——
 * append-only 由类型隔离保证（KV 前缀零分叉的物理前提）。
 */
export function createPulseMessage(text, meta = {}, id = randomUUID()) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: String(text || '') }],
    source: {
      kind: 'memo-recall-pulse',
      form: String(meta.form || 'pulse-lens'),
      card: String(meta.cardKey || ''),
      boundaryKey: String(meta.boundaryKey || ''),
    },
  }
}

/**
 * 动作轨迹状态机（T1 姿态通道）：只看已完结的工具交换，记步数、读写比与验证间隔。
 * 纯事件流事实，不依赖模型肯不肯自述——三条通道里最稳的一条。
 */
export function createTrajectoryTracker(readTools = '') {
  const empty = () => ({ writes: 0, verifies: 0, searches: 0, sinceVerifyWrites: 0, sawError: false, wroteAfterError: false, firstWriteSearches: null, firstWriteTool: '' })
  let boundaryKey = ''
  let state = empty()
  const spent = new Set()

  return {
    setBoundary(key) {
      const k = String(key || '')
      if (k === boundaryKey) return
      boundaryKey = k
      state = empty()
      spent.clear()
    },
    observe(call, result) {
      const kind = toolKind(effectiveToolName(call), readTools)
      if (kind === 'write') {
        if (state.firstWriteSearches === null) { state.firstWriteSearches = state.searches; state.firstWriteTool = String(call?.name || '') }
        if (state.sawError) state.wroteAfterError = true
        state.writes++
        state.sinceVerifyWrites++
      } else {
        if (kind === 'verify') state.verifies++
        else state.searches++
        state.sinceVerifyWrites = 0
      }
      if (extractErrorSignal(result).error) state.sawError = true
    },
    snapshot() { return { ...state, boundaryKey } },
    /** 取一个姿态信号（取走即置位：每边界每类只给一次，防唠叨退化成正确废话）。 */
    takePostureSignal(shape) {
      const fire = (id, reason) => { if (spent.has(id)) return null; spent.add(id); return { id, reason } }
      // 逐条试探而非短路：某类信号已被消费（spent）时，不该把后面几类一起闷死。
      const ladder = [
        state.wroteAfterError ? ['after-error', '撞红灯后继续改而未回查'] : null,
        state.sinceVerifyWrites >= 3 ? ['no-verify', `连续 ${state.sinceVerifyWrites} 次改动未验证`] : null,
        state.firstWriteSearches === 0 && state.writes <= 2 ? ['blind-first-cut', '首次动刀前未做任何检索/引用检查'] : null,
        shape === 'fix' && state.firstWriteTool === 'CreateFile' ? ['fix-new-file', '修复型任务里首次动手就是新建文件'] : null,
      ]
      for (const step of ladder) {
        if (!step) continue
        const signal = fire(step[0], step[1])
        if (signal) return signal
      }
      return null
    },
  }
}

/**
 * 脉冲查询源选择（单查询模型 + 模式优先级）：每步最多一条查询。
 * 优先级：报错（事实）> 胶水意图（思想证据）> 姿态（间接征候）> 坏味道（字面锚）。
 * 各模式走不同阈值键（%口径，与 minScore 一致）；姿态信号在此消费，取走即置位。
 */
export function pickPulseSource({ call, result, assistantText, trajectory, boundaryText, trajectoryText }) {
  const name = effectiveToolName(call).slice(0, 15)
  if (!name) return null
  // 3 步微轨迹前缀：让查询带上「查→改→跑」的方向性，而不是单步词袋。
  const prefix = Array.from(String(trajectoryText || '').trim()).slice(0, 60).join('')
  // 工具名必须留在第一位：VCP 侧与测试都按「首个 token 是工具名」识别脉冲查询，
  // 轨迹前缀插在工具名之后，既保留方向性又不破坏既有契约。
  const withTrail = text => {
    const raw = String(text || '')
    if (!prefix) return cut(raw, 200)
    const m = /^(\S+)\s*([\s\S]*)$/.exec(raw)
    return cut(m ? m[1] + ' ' + prefix + ' ' + m[2] : prefix + ' ' + raw, 200)
  }
  const signal = extractErrorSignal(result)
  if (signal.error) return { mode: 'error', thresholdKey: 'pulseErrorThreshold', query: withTrail(buildPulseQuery(call, result)) }
  const head = Array.from(String(boundaryText || '').replace(/\s+/g, ' ').trim()).slice(0, 60).join('')
  const glue = matchGlueWords(assistantText)
  if (glue.length) {
    return { mode: 'intent', thresholdKey: 'pulseIntentThreshold', query: withTrail(cut(`${name} ${glue.join(' ')} ${head}`, 200)) }
  }
  const posture = trajectory?.takePostureSignal?.(boundaryShape(boundaryText))
  if (posture) {
    return { mode: 'posture', thresholdKey: 'pulsePostureThreshold', reason: posture.reason, query: withTrail(cut(`${name} ${posture.reason} ${head}`, 200)) }
  }
  if (hasSmell(call, result)) return { mode: 'smell', thresholdKey: 'pulseThreshold', query: withTrail(buildPulseQuery(call, result)) }
  return null
}

const ACTION_KINDS = [
  [/^(ReadCode|ops_inspect_local_file|ops_grep|ops_glob|everything_search|universal_read|code_searcher|web_fetch|web_search)$/i, '查证'],
  [/^(EditCode|CreateFile|RemoveFile|MoveFile|MoveCode|CopyCode|ops_replace)$/i, '改码'],
  [/^(forge_context|project_forge)$/i, '记账']
];
const SHELL_ACTION = /^(ops_bash|pwsh)$/i;
const TEST_CMD = /(?:^|[\s;&|])(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|node\s+--test|vitest|jest/i;

/** 单步动作标签：只保留「动作类别 + 成败」，不拼路径与命令词（那些是霸王卡噪音源）。 */
export function actionLabel(call, result) {
  const name = effectiveToolName(call)
  if (!name) return ''
  const failed = Boolean(extractErrorSignal(result)?.error)
  const mark = failed ? '✗' : ''
  if (SHELL_ACTION.test(name)) {
    const args = call?.arguments ?? call?.data?.arguments ?? {}
    const cmd = String(args.command || args.script_path || '')
    return (TEST_CMD.test(cmd) ? '跑测试' : '跑命令') + mark
  }
  for (const [re, label] of ACTION_KINDS) if (re.test(name)) return label + mark
  return name.slice(0, 12) + mark
}

/** 有序曲线前缀：查证→改码→跑测试✗ 这种方向性，是单步词袋里没有的信号。 */
export function trajectoryPrefix(labels, maxChars = 40) {
  const list = (labels || []).filter(Boolean)
  if (!list.length) return ''
  return Array.from(list.join('→')).slice(0, maxChars).join('')
}

function cut(text, maxChars) { return Array.from(String(text || '')).slice(0, maxChars).join('') }
