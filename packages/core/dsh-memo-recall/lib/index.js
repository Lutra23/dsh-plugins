/** DSH rc.2: user-message / active-Todo boundary-scoped passive recall. */
import { createUserMessageTracker } from './boundaries.js'
import { createBoundaryEngine } from './engine.js'
export { createUserMessageTracker, lastUserMessage, lastQuerySource, pickQuerySource, parseTodoList, activeTodoText } from './boundaries.js'
export { raceTimeout } from './engine.js'

/** 插件版本单一事实源：debug 的 plugin-loaded 行与包版本必须同源，
 *  避免硬编码漂移（实机曾出现日志写 0.3.2 而仓库已 0.3.3，无法当加载判据）。
 *  selftest 断言它与 package.json 的 version 一致，升版漏改直接红灯。 */
export const VERSION = '0.4.13'

export const DEFAULTS = {
  enabled: true,
  // VCP 端点与凭证（远端/分发适配）：解析优先级 = 显式 config > 环境变量
  // （VCP_HOST/VCP_PORT/VCP_HOME/VCP_ADMIN_USER/VCP_ADMIN_PASSWORD）> vcpHome 的 config.env > 默认。
  // vcpHome 仅用于 config.env 兜底与子进程 cwd（目录不存在时 cwd 回退系统临时目录）。
  vcpHost: '127.0.0.1',
  vcpPort: 6005,
  vcpHome: '',        // VCPToolBox 根目录；留空则凭证只走显式配置/环境变量
  adminUser: '',      // 显式 admin 凭证（明文进 patch yml 有泄露风险，优先环境变量）
  adminPass: '',
  // 主人指定的被动召回范围（占位符 [[X日记本::Time::Group::RiverMemo::Truncate0.58]] 的 API 等价配置）
  folders: 'Kerr的知识|DSH工程档案',
  k: 5,               // LightMemo 拉取条数
  topN: 3,            // 阈值过滤后最多注入条数
  minScore: 58,       // 相关性 % 阈值 ≡ 占位符 ::Truncate0.58（LightMemo 相关性% = scoreValue×100）
  timeoutMs: 5000,    // 组装关键路径上的等待预算；超时不注入但后台回填
  ttlMs: 600000,      // 兼容旧配置；边界内固定，不再按 TTL 刷新
  cooldownMs: 300000, // 连续失败后的冷却
  maxFailures: 3,
  maxChars: 1600,     // 注入 section 总字符上限
  maxHitChars: 420,   // 单条正文上限
  queryMaxChars: 200, // 送入 LightMemo 的查询截断
  lensMax: 2,          // 元思考透镜（直觉卡）追加上限：不占 topN 席位，渲染豁免 maxChars 总截断
  // 🌟 联想共现（Associative Discovery）：pluginName 指向 LightMemoAssoc 时可用
  pluginName: 'LightMemo',   // 桥目标插件：LightMemo=原检索；LightMemoAssoc=带共现联想
  associate: false,          // 开启共现联想（种子二次检索 + 多种子共现过滤）
  associateDepth: null,      // 每个种子的二次检索深度；null=取主检索条数
  associateTagBoost: null,   // 联想二次检索的 RiverMemo 源观测强度；null=继承 tag_boost
  associateRatio: 0.4,       // 联想最多占 topN 席位的比例（0~1）；主检索不足时联想才补位
  // 🌟 Rerank+（通道 A 可选的同步精排）：占位符 [[X::Rerank]] / [[X::Rerank+]] 的 API 等价配置。
  //   ''/false/off = 关闭（默认，请求体与 0.4.0 逐字节一致）；true = 纯精排；
  //   'rrf' = ::Rerank+ 语义（RRF 融合，α=0.5）；'rrf0.7' 或 0~1 数字 = 自定义 α。
  //   代价（2026-10-22 实测，VCP 1.6.0 + LightMemoAssoc，k=10）：纯检索 6.3s → Rerank+ 14.7s。
  rerank: '',
  rerankTimeoutMs: 20000,    // 启用 rerank 时的边界等待预算：沿用 timeoutMs=5000 会每边界都 timeout-skip
  // Rerank 分与混合分不是同一把尺：真机（2026-10-22）同一列表里直锚是 0–49%（Rerank）、
  // 联想是 80–96%（混合），用 minScore=58 统一过滤会把直锚整体筛掉、只剩联想。
  // 故 Rerank 命中改用「名次取席」（保留 RRF 顺序），本值只在需要绝对下限时才调高（0=不截断）。
  rerankMinScore: 0,
  // 🌟 RiverMemo V3 诊断门控（Step 2a）：解析命中行自带的 Ω/工况/拓扑+/直锚+。
  //   默认 false = 与旧行为逐字节一致；开启后 collapsed 且无直锚的命中按背景噪音丢弃，
  //   dense 且拓扑+>0 的命中阈值下浮 topologyRelax（0.85 = 阈值打八五折）。
  //   作用域默认只到脉冲透镜（scope=lens）；边界召回要等 A/B 数据再开 scope=all。
  topologyGate: false,
  topologyGateScope: 'lens',
  // 🌟 本地动作流熵（Step 3）：只看最近 N 步在文件/工具间的转移分布。
  //   shadow=true 只写 flow-entropy-shadow 日志、不注入（默认，零行为变化）；
  //   inject=true 才把它接成脉冲源（等阈值标定后再开）。
  flowEntropyShadow: false,
  flowEntropyInject: false,
  flowEntropyWindow: 12,
  flowEntropyMinSteps: 6,
  flowEntropyFullPath: false,
  // PSJD-C：确定性直觉规则（surpriseFlag + stallScore）。默认关，只写 psjd-shadow 观测日志。
  psjdShadow: false,
  psjdStallThreshold: 0.66,
  // 🌟 两级熔断转正（0.4.12 · HarnessPro adapter 熔断移植）：生效前提 psjdShadow:true。
  //   'off'＝纯 shadow（默认）；'l1'＝L1 行为引导卡（本地合成，不查库不吃透镜配额）；
  //   'l2'＝L1 + 强制熔断卡（停滞越过停机线即停机令，每边界一次，发后本边界 psjd 静默）。
  psjdEnforce: 'off',
  psjdHaltStall: 0.85,  // L2 停机线（判据一）：stall 越过即熔断（mode=stall 时）
  psjdHaltAfter: 4,     // L2 停机线（判据二）：同签名报错连续 N 拍即熔断
  psjdL1PerBoundary: 2, // L1 每边界配额（同 mode 只发一次；surprise-red/green/stall 各计一次）
  topologyCollapseOmega: 0.12,
  topologyRelax: 0.85,
  // 🌟 Jev 语义精排（LightMemoAssoc 的 jev 参数）：与 rerank 同语义但走 Jev 结构化决策。
  //   ''/false = 关闭；true = 纯精排；'rrf' = RRF 融合 α=0.5；'rrf0.7'/0~1 = 自定义 α。
  //   LightMemoAssoc 侧按请求预算分档（JevRerankMaxRequestChars），被动召回可安全启用。
  jev: '',
  // 脉冲透镜（通道 B）：工具步后的姿态/摩擦/意图查询，往消息末尾追加一枚直觉卡，用完即沉。
  // 与通道 A（边界召回）各自计数：pulse* 只影响脉冲，不改 folders/topN/lensMax 的边界语义。
  pulseEnabled: true,        // false 关闭整条通道 B（实机若推歪率超线，这是唯一回退开关）
  pulseFolders: '溟月的知识', // 脉冲只查透镜库：长笔记不参与，避免 Top-1 被长文劫持
  pulseK: 5,                 // 脉冲候选条数：只取最像的几枚，不做联想
  pulseThreshold: 75,        // 坏味道（代码字面锚）命中阈值 %
  pulseErrorThreshold: 65,   // 报错步降阈值强制救援（免步冷却，不免时间地板）
  pulseIntentThreshold: 60,  // 自述胶水词（T2 意图通道）
  pulsePostureThreshold: 70, // 动作姿态（T1 轨迹通道）
  pulseStepGap: 3,           // 两次注入之间至少隔几个合格步
  pulseFloorMs: 5000,        // 时间地板：两次注入的最小墙钟间隔
  pulseBudgetPerTodo: 3,     // 每边界（用户消息/Todo 激活）注入配额
  pulseEmptyPerTodo: 8,      // 每边界空手预算：miss/timeout/候选全被同卡挡才算空手
  pulseEmptyBonus: 2,        // 报错破格：本边界出现过 error 查询后，空手预算 +2
  pulseMaxQueriesPerTodo: 12,// 每边界总查询硬顶（8 空手 + 4 注入的物理上限）
  pulseErrorBonus: 1,        // 报错破格：每边界额外 +1 枚
  pulseMaxCardPerSession: 2, // 同一张卡全会话最多出现几次
  pulseTimeoutMs: 5000,      // 脉冲查询竞速预算：异步发射不占关键路径，实测地板≈2s，留足余量
  pulsePendingTtlMs: 120000, // 在途结果死线（防悬挂兜底）：取用窗口由 pulseStepGap/pulseFloorMs 管，
                              // 死线只管语义陈旧——实测单个工具步墙钟可达 30s+，过短会让每条透镜在取用前过期
  // 边界切换时是否携带 error 模式的在途脉冲（19 天实测 dropped 243 次多为这类浪费）
  pulseCarryErrorAcrossBoundary: true,
  pulseMaxChars: 200,        // 单枚脉冲字符上限（≈160 tokens 口径，含防压缩引导语；截断在句边界）
  pulseReadTools: '',        // 追加的只读工具名（逗号/空格分隔），免受脉冲查询
  // 🌟 阶段闸门（WP2 · HarnessPro 三段闸门移植）：边界内写步分档治理，本地合成收敛令
  //   （不查库、不吃透镜配额，source.form=stage-gate 与直觉卡类型隔离）。
  //   economy 进场单次止损；strict/finalize 进场一次 + 每 everyN 步重申。默认关闭零行为变化。
  pulseStageEnabled: false,
  pulseStageEconomyAt: 14,   // 经济线（写步）：越过即单次止损提醒
  pulseStageStrictAt: 26,    // 收敛线：停止探索专注验证 + 周期重申
  pulseStageFinalizeAt: 44,  // 交卷线：基于现有证据总结交卷 + 周期重申
  pulseStageEveryN: 8,       // strict/finalize 重申周期（写步）
  pulseStageMaxChars: 120,   // 收敛令字符上限
  // Deprecated configuration keys retained for old profiles. Official todo/write
  // is authoritative; proposals and LRU eviction no longer affect recall.
  todoTools: 'todo_write',
  maxSessions: 64,
  debug: false,
  debugLog: '',       // 非空则向该路径追加 JSONL 决策日志（pwsh 可读的实机验证通道）
}

/** FNV-1a 32bit —— 缓存键散列，无需 crypto。 */
export function fnv1a(s) {
  let h = 0x811c9dc5
  const t = String(s)
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** Rerank 参数归一化（对齐 VCP LightMemo 的 _parseRerankOptions 语义）：
 *  ''/false/off/none = 关闭（返回 null，桥请求里根本不出现 rerank 键）；
 *  true/'true'/'on' = 纯精排（无 RRF）；'rrf' = ::Rerank+（RRF 融合，α=0.5）；
 *  'rrf0.7' 或 0~1 数字 = 自定义 RRF α。无法识别的值一律关闭——错配置不该变成付费调用。 */
export function normalizeRerank(value) {
  if (value === true) return true
  if (value === false || value === null || value === undefined) return null
  if (typeof value === 'number') return value > 0 && value <= 1 ? value : null
  const s = String(value).trim().toLowerCase()
  if (!s || s === 'off' || s === 'false' || s === 'none' || s === 'no') return null
  if (s === 'true' || s === 'on' || s === 'yes') return true
  if (/^rrf\d*(?:\.\d+)?$/.test(s)) return s
  const n = Number(s)
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : null
}

/** admin_api 桥入参（纯函数，可离线断言）：与 LightMemo / LightMemoAssoc 的契约逐字对齐。
 *  rerank 归一化后为 null 时**不写该键**——关闭状态下请求体与 0.4.0 逐字节一致。 */
export function buildRecallArgs(query, c) {
  const args = {
    query,
    folder: c.folders,
    k: c.k,
    enginemode: 'rivermemo',
    BM25: true,
    search_all_knowledge_bases: false,
  }
  if (c.associate) {
    args.command = 'associate_search'
    if (c.associateDepth) args.associate_depth = c.associateDepth
    if (c.associateTagBoost !== null && c.associateTagBoost !== undefined) args.associate_tag_boost = c.associateTagBoost
  }
  const rerank = normalizeRerank(c.rerank)
  if (rerank !== null) args.rerank = rerank
  const jev = normalizeRerank(c.jev)
  if (jev !== null) args.jev = jev
  return args
}

/** LightMemo 外层标记分块；正文兼容日记、Markdown 和纯文本，时间戳不是开读条件。
 *  只移除块首已知元信息和块尾 Tag 行；保留正文内同名字段及围栏代码中的示例。 */
export function parseLightmemo(text) {
  const hits = []
  const lines = String(text || '').split(/\r?\n/)
  const fenceLine = raw => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw)
  // Recalled chunks may stop mid-code. Without a later closing fence, keep
  // parsing result boundaries. Suffix maxima avoid repeatedly scanning ahead.
  const laterClosers = { '`': new Uint32Array(lines.length + 1), '~': new Uint32Array(lines.length + 1) }
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const marker of ['`', '~']) laterClosers[marker][i] = laterClosers[marker][i + 1]
    const fm = fenceLine(lines[i])
    if (fm && !fm[2].trim()) laterClosers[fm[1][0]][i] = Math.max(laterClosers[fm[1][0]][i], fm[1].length)
  }
  let cur = null
  let body = []
  let fence = null
  const finalize = () => {
    if (!cur) return
    // Tags are a trailer convention, not an instruction to stop reading midway.
    while (body.length && (!body.at(-1).text.trim() || body.at(-1).tag)) body.pop()
    cur.body = body.map(row => row.text).join('\n')
    cur.bodyStarted = Boolean(cur.body.trim())
    cur.title = titleFromPath(cur.path)
    // 元思考透镜识别：标题（文件名去时间戳）含「直觉卡」即透镜，来源库不限。
    cur.lens = /直觉卡/.test(cur.title || '')
    hits.push(cur)
    cur = null; body = []; fence = null
  }
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const line = rawLine.trim()
    const fm = fenceLine(rawLine)
    if (cur && fence) {
      body.push({ text: rawLine, tag: false })
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length && !fm[2].trim()) fence = null
      continue
    }
    // N/A still begins a separate record; never attach its body to the previous hit.
    const m = /^---\s*\(来源:\s*(.+?),\s*相关性:\s*(?:(\d+(?:\.\d+)?)%(?:\(([^()]*)\))?|N\/A)\s*\)$/.exec(line)
    if (m) {
      finalize()
      cur = { folder: m[1].trim(), score: Number(m[2]) || 0, scoreType: (m[3] || '').trim(), path: '', date: '', title: '', body: '', bodyStarted: false, associate: null }
      continue
    }
    if (!cur) continue
    if (/^\[---\s*(?:LightMemo 轻量回忆|TDB 冷知识库检索|回忆结束|知识库检索结束)\s*---\]$/.test(line)) { finalize(); continue }
    if (!cur.bodyStarted) {
      if (!line) continue
      const pm = /^\[路径:\s*(.+)\]$/.exec(line)
      if (pm && !cur.path) { cur.path = pm[1].trim(); continue }
      const tm = /^\[RiverMemo Topology V[\d.]+:\s*Ω=([\d.]+)\/([\w-]+)(?:,\s*角色=([^,\]]+))?(?:,\s*拓扑([+-][\d.]+))?(?:,\s*直锚([+-][\d.]+))?.*\]$/.exec(line)
      if (tm) {
        cur.topology = {
          omega: Number(tm[1]),
          regime: tm[2],
          role: (tm[3] || '').trim(),
          topologyBonus: Number(tm[4]) || 0,
          anchorBonus: Number(tm[5]) || 0
        }
        continue
      }
      if (/^\[RiverMemo Topology V[\d.]+:.*\]$/.test(line)) continue
      if (/^\[TagMemo V\d+(?:\.\d+)*(?: \+ 势能场)? 增强:.*\]$/.test(line)) continue
      const dm = /^\[(\d{4}-\d{2}-\d{2})\](?:\s*-\s*.*)?$/.exec(line)
      if (dm && !cur.date) { cur.date = dm[1]; continue }
      // 联想共现标记（LightMemoAssoc 渲染在正文首行）：剥离为结构化来源，只认「联想共现: N/M」，
      // 不绑定具体 emoji，避免上游改装饰导致来源丢失。
      const am = /^\[[^\]]*联想共现:\s*(\d+)\s*\/\s*(\d+)/.exec(line)
      if (am) { cur.associate = { coCount: Number(am[1]), seedTotal: Number(am[2]) }; continue }
    }
    cur.bodyStarted = true
    if (fm && laterClosers[fm[1][0]][i + 1] >= fm[1].length &&
        (fm[1][0] !== '`' || !fm[2].includes('`'))) fence = fm[1]
    body.push({ text: rawLine, tag: !fence && /^ {0,3}Tag:/i.test(rawLine) })
  }
  finalize()
  return hits
}

/** 从 file:/// 路径提取人读标题：去时间戳前缀与扩展名。 */
export function titleFromPath(p) {
  if (!p) return ''
  let s = String(p)
  try { s = decodeURIComponent(s) } catch { /* 保留原文 */ }
  s = (s.split(/[\\/]/).pop() || '').replace(/\.(?:txt|md|markdown)$/i, '')
  s = s.replace(/^\d{4}-\d{2}-\d{2}[-_]\d{2}_?\d{2}(_?\d{2})?[-_]/, '')
  return Array.from(s).slice(0, 60).join('')
}

const hasBody = (hit) => Boolean(String(hit?.body || '').trim())

/** RiverMemo V3 诊断门控（Step 2a）：命中行自带 Ω/工况/拓扑+/直锚+ 时，
 *  collapsed 且无直锚 → 背景噪音丢弃；dense 且拓扑+>0 → 阈值下浮。
 *  默认 topologyGate=false，判定恒为「不丢弃、阈值不变」，与旧行为逐字节一致。 */
export function topologyVerdict(hit, threshold, options = {}) {
  const base = Number(threshold)
  const floor = Number.isFinite(base) ? base : 0
  if (!options.topologyGate) return { drop: false, threshold: floor, reason: 'off' }
  const t = hit?.topology
  if (!t) return { drop: false, threshold: floor, reason: 'no-topology' }
  const omega = Number(t.omega)
  const anchor = Number(t.anchorBonus) || 0
  const topo = Number(t.topologyBonus) || 0
  const collapsedLimit = Number(options.topologyCollapseOmega)
  const limit = Number.isFinite(collapsedLimit) ? collapsedLimit : 0.12
  const collapsed = t.regime === 'collapsed' || (Number.isFinite(omega) && omega < limit)
  if (collapsed && anchor <= 0) return { drop: true, threshold: floor, reason: 'collapsed-noise' }
  const dense = t.regime === 'dense' || (Number.isFinite(omega) && omega >= 0.45)
  if (dense && topo > 0) {
    const relax = Number(options.topologyRelax)
    const factor = Number.isFinite(relax) ? relax : 0.85
    return { drop: false, threshold: floor * factor, reason: 'dense-relax' }
  }
  return { drop: false, threshold: floor, reason: 'neutral' }
}

/** 正文非空 + 阈值过滤 + 分区选席，空命中不占席位。
 *  主检索与联想分区竞争（对齐 VCP 语义：联想是额外线索，不与直接命中抢席位）：
 *  联想最多占 round(topN × associateRatio) 席，主检索不够时联想才补位；
 *  完全无联想时与旧版行为逐字节一致。联想区内按共现次数优先排序（对齐 VCP 的 _associateCoCount 排序）。
 *  透镜（直觉卡，title 含「直觉卡」）按分数取前 lensMax 枚追加在末尾、不占 topN 席位——
 *  它是注意力扳手（管「怎么想」），不与「想什么」的记忆抢位置。 */
export function selectHits(hits, minScore, topN, associateRatio, lensMax, options = {}) {
  // 两把尺：Rerank 命中（scoreType 含 Rerank）用 rerankMinScore，其余（混合/拓扑/联想）沿用 minScore。
  const floor = Number(options.rerankMinScore)
  const rerankFloor = Number.isFinite(floor) ? floor : 0
  const isRerank = (h) => /rerank|jev/i.test(String(h?.scoreType || ''))
  const policy = {
    topologyGate: options.topologyGate,
    topologyCollapseOmega: options.topologyCollapseOmega,
    topologyRelax: options.topologyRelax
  }
  const ok = (hits || []).filter((h) => {
    if (!hasBody(h)) return false
    const verdict = topologyVerdict(h, isRerank(h) ? rerankFloor : minScore, policy)
    return !verdict.drop && h.score >= verdict.threshold
  })
  const byScore = (a, b) => b.score - a.score
  // preserveOrder：Rerank+ 的名次由 VCP 侧 RRF 融合决定，再按分数重排等于把它抹掉。
  const main = ok.filter((h) => !h.associate && !h.lens)
  if (!options.preserveOrder) main.sort(byScore)
  const assoc = ok.filter((h) => h.associate && !h.lens).sort((a, b) => {
    const byCo = (b.associate.coCount || 0) - (a.associate.coCount || 0)
    return byCo !== 0 ? byCo : b.score - a.score
  })
  const rawLens = Number(lensMax)
  const lens = ok.filter((h) => h.lens).sort(byScore)
    .slice(0, Number.isFinite(rawLens) ? Math.max(0, rawLens) : 2)
  if (!assoc.length && !lens.length) return main.slice(0, topN)
  const raw = Number(associateRatio)
  const ratio = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0.4
  const quota = Math.max(1, Math.round(topN * ratio))
  const take = Math.max(0, Math.max(quota, topN - main.length))
  const pickedAssoc = assoc.slice(0, take)
  const pickedMain = main.slice(0, Math.max(0, topN - pickedAssoc.length))
  return [...pickedMain, ...pickedAssoc, ...lens]
}

const singleLine = (s) => String(s || '').replace(/\s+/g, ' ').trim()

/** 渲染注入文本；无命中返回 ''（调用方据此跳过注入）。
 *  context 文本会被 {{变量}} 插值扫描且无逃逸口，字面 {{ 必须拆开消毒。 */
export function renderRecallSection(sel, opts) {
  const list = (sel || []).filter(hasBody)
  if (!list.length) return ''
  const render = (h) => {
    const meta = [h.score + '%', h.folder || '?', h.date || '',
      h.associate ? '联想' + h.associate.coCount + '/' + h.associate.seedTotal : '',
      h.lens ? '透镜' : ''].filter(Boolean).join('|')
    const body = Array.from(singleLine(h.body)).slice(0, opts.maxHitChars).join('')
    return '· [' + meta + '] ' + (h.title || '（无标题）') + '\n  ' + body
  }
  // 分区渲染（对齐 VCP）：直接命中在前，联想共现单独成段；
  // 透镜（直觉卡）附加段豁免 maxChars 总截断——注意力扳手被截掉等于白召回，自身以 maxChars 封顶防爆炸。
  const main = list.filter((h) => !h.associate && !h.lens)
  const assoc = list.filter((h) => h.associate && !h.lens)
  const lens = list.filter((h) => h.lens)
  const parts = main.map(render)
  if (assoc.length) {
    parts.push('', '【联想共现记忆 (' + assoc.length + '条, 多条记忆交叉关联)】')
    parts.push(...assoc.map(render))
  }
  let lensText = ''
  if (lens.length) {
    const lensParts = ['', '【元思考直觉 (' + lens.length + '枚, 注意力扳手而非事实)】',
      '以下透镜只矫正「往哪看」，不陈述「那里有什么」——采纳其方向，勿引用为事实：', ...lens.map(render)]
    lensText = Array.from(lensParts.join('\n')).slice(0, opts.maxChars).join('')
  }
  const rankLabel = opts.rankMode === 'Jev' ? '按 Jev 语义精排名次取席' : 'Rerank+ 融合名次取席'
  const header = opts.rerankRanked
    ? '[被动记忆召回] 以下片段由本地记忆库按当前用户消息或活跃 Todo 自动检索（' + rankLabel + '；联想/透镜另按相关度≥' +
      opts.minScore + '% 过滤）。记忆是写入当时的快照而非现状，引用任何“当前事实”前必须重新核实：'
    : '[被动记忆召回] 以下片段由本地记忆库按当前用户消息或活跃 Todo 自动检索（相关度≥' + opts.minScore +
      '%）。记忆是写入当时的快照而非现状，引用任何“当前事实”前必须重新核实：'
  const raw = header + '\n' + parts.join('\n')
  return (Array.from(raw).slice(0, opts.maxChars).join('') + lensText).split('{{').join('{ {')
}

/** Query truncation never determines boundary identity. */
export function makeQuery(text, maxChars) {
  return Array.from(singleLine(text)).slice(0, maxChars).join('')
}

export function createRecallEngine(options) {
  const config = { ...DEFAULTS, ...options.config }
  return createBoundaryEngine({ ...options, config,
    // 通道 B（脉冲）走结构化取卡：只要「直觉卡」且正文非空、分数过阈值，按分数降序把最好的一枚交给 engine。
    parseLens: (raw, threshold) => {
      const min = Number(threshold)
      const base = Number.isFinite(min) ? min : 0
      const policy = {
        topologyGate: config.topologyGate,
        topologyCollapseOmega: config.topologyCollapseOmega,
        topologyRelax: config.topologyRelax
      }
      const lensHits = parseLightmemo(raw).filter(h => h.lens && hasBody(h))
      const gated = lensHits.filter(h => topologyVerdict(h, base, policy).drop).length
      if (gated && config.debug && options.writeDebug) {
        // 只记数量，不记卡片内容与查询。
        try { options.writeDebug(JSON.stringify({ ts: (options.now || Date.now)(), phase: 'lens-gated', dropped: gated, total: lensHits.length })) } catch {}
      }
      return lensHits
        .filter(h => {
          const verdict = topologyVerdict(h, base, policy)
          return !verdict.drop && h.score >= verdict.threshold
        })
        .sort((a, b) => b.score - a.score)
    },
    render: raw => {
      const hits = parseLightmemo(raw)
      const rerankOn = normalizeRerank(config.rerank) !== null
      const jevOn = normalizeRerank(config.jev) !== null
      const rankOn = rerankOn || jevOn
      const topologyPolicy = {
        topologyGate: config.topologyGate && config.topologyGateScope === 'all',
        topologyCollapseOmega: config.topologyCollapseOmega,
        topologyRelax: config.topologyRelax
      }
      const selected = selectHits(hits, config.minScore, config.topN, config.associateRatio, config.lensMax,
        { preserveOrder: rankOn, rerankMinScore: config.rerankMinScore, ...topologyPolicy })
      if (config.debug && options.writeDebug) {
        // Counts only: no query, memory text, file path or folder in parse diagnostics.
        try { options.writeDebug(JSON.stringify({ ts: (options.now || Date.now)(), phase: 'parse-result', rerank: rerankOn, jev: jevOn,
          parsedHits: hits.length, emptyBodyHits: hits.filter(h => !hasBody(h)).length, selectedHits: selected.length,
          topologyGated: hits.filter(h => topologyVerdict(h, config.minScore, topologyPolicy).drop).length,
          topologyRelaxed: hits.filter(h => topologyVerdict(h, config.minScore, topologyPolicy).reason === 'dense-relax').length })) } catch {}
      }
      return renderRecallSection(selected, { ...config, rerankRanked: rankOn, rankMode: jevOn ? 'Jev' : (rerankOn ? 'Rerank+' : '') })
    },
  })
}

// ---------------------------------------------------------------------------
// 宿主装配
// ---------------------------------------------------------------------------

/** 跨分隔符路径拼接：vcpHome 以 / 或 \ 结尾皆可。 */
function joinPath(dir, name) {
  const d = String(dir || '').replace(/[\\/]+$/, '')
  return d ? d + '/' + name : name
}

/** VCP admin 凭证分层解析（纯函数，可离线单测）：
 *  显式 config（adminUser/adminPass）> 环境变量（VCP_ADMIN_USER/VCP_ADMIN_PASSWORD）>
 *  vcpHome 的 config.env（AdminUsername/AdminPassword）。user/pass 两半独立取最靠前层的值，
 *  任一层凑齐即组 Basic 头；全缺返回 null。 */
export function resolveVcpAuth(cfg, env, configEnvText) {
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

/** 与 @dsh-external/dsh-vcp-tools 相同的 admin_api 桥接协议（实测形态，勿改协议）。
 *  host/port 参数化：远端 VCP 或非默认端口由配置注入，默认回落 127.0.0.1:6005。 */
export function bridgeScript(host, port, pluginName) {
  const h = JSON.stringify(String(host || '127.0.0.1'))
  const p = Number(port) || 6005
  const pluginPath = JSON.stringify('/admin_api/plugins/' + String(pluginName || 'LightMemo') + '/execute')
  return 'const http=require(\'http\');const auth=process.env.LM_AUTH;let raw=\'\';process.stdin.setEncoding(\'utf8\');process.stdin.on(\'data\',c=>raw+=c);process.stdin.on(\'end\',()=>{let args;try{args=JSON.parse(raw||\'{}\');}catch(e){process.stderr.write(\'bad args json\');process.exit(2);}const body=JSON.stringify({args:args});const req=http.request({host:' + h + ',port:' + p + ',path:' + pluginPath + ',method:\'POST\',headers:{\'Content-Type\':\'application/json; charset=utf-8\',\'Authorization\':auth,\'Content-Length\':Buffer.byteLength(body)},timeout:120000},res=>{let d=\'\';res.setEncoding(\'utf8\');res.on(\'data\',c=>d+=c);res.on(\'end\',()=>{process.stdout.write(d);});});req.on(\'timeout\',()=>req.destroy(new Error(\'timeout\')));req.on(\'error\',e=>{process.stderr.write(e.message);process.exit(2);});req.write(body);req.end();});'
}

const inject = ['subprocess', 'fs']
const name = 'memo-recall'

function apply(ctx, rawConfig) {
  const cfg = { ...DEFAULTS }
  for (const [k, v] of Object.entries(rawConfig || {})) {
    if (v === undefined || v === null) continue
    if (typeof DEFAULTS[k] === 'number') cfg[k] = Number(v) || DEFAULTS[k]
    else if (typeof DEFAULTS[k] === 'boolean') cfg[k] = Boolean(v)
    else cfg[k] = v
  }

  let nodePathPromise = null
  function nodePath() {
    if (nodePathPromise) return nodePathPromise
    nodePathPromise = ctx.subprocess.resolveExecutable('node').catch((e) => { nodePathPromise = null; throw e })
    return nodePathPromise
  }

  const processEnv = () => (globalThis.process && globalThis.process.env) || {}

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
        authPromise = null
        throw new Error('VCP admin 凭证缺失（config 的 adminUser/adminPass、环境变量 VCP_ADMIN_USER/VCP_ADMIN_PASSWORD、或 vcpHome 下 config.env 的 AdminUsername/AdminPassword，任选其一）')
      }
      return auth
    })()
    return authPromise
  }

  const builtin = (globalThis.process && globalThis.process.getBuiltinModule)
    ? { fs: globalThis.process.getBuiltinModule('fs'), os: globalThis.process.getBuiltinModule('os') }
    : {}
  /** 子进程 cwd：vcpHome 存在则沿用（兼容本地老行为），否则回退系统临时目录
   *  （node -e 纯 HTTP 桥不依赖 cwd，回退只为避免目录不存在时 spawn ENOENT）。 */
  function spawnCwd() {
    try { if (cfg.vcpHome && builtin.fs && builtin.fs.existsSync(cfg.vcpHome)) return cfg.vcpHome } catch { /* 忽略 */ }
    return builtin.os ? builtin.os.tmpdir() : '.'
  }

  async function runNode(script, stdinData, envExtra) {
    const node = await nodePath()
    const handle = ctx.subprocess.spawn({
      argv: [node, '-e', script],
      cwd: spawnCwd(),
      stdio: {
        stdin: { data: stdinData },
        stdout: { maxBytes: 4 * 1024 * 1024, spill: { maxBytes: 64 * 1024 * 1024 } },
        stderr: { maxBytes: 100 * 1024, spill: { maxBytes: 1024 * 1024 } },
      },
      env: envExtra || {},
      graceMs: 3000,
    })
    const outcome = await handle.done
    const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0) : { text: '' }
    const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0) : { text: '' }
    if (outcome.exitCode !== 0) throw new Error('bridge 子进程退出码=' + String(outcome.exitCode) + (err.text ? ' | ' + err.text : ''))
    return out.text
  }

  async function callRecall(query, c) {
    const auth = await loadAuth()
    const args = buildRecallArgs(query, c)
    const text = await runNode(bridgeScript(c.vcpHost, c.vcpPort, c.pluginName), JSON.stringify(args), { LM_AUTH: auth })
    let parsed
    try { parsed = JSON.parse(text) } catch { throw new Error((c.pluginName || 'LightMemo') + ' 返回无法解析: ' + String(text).substring(0, 200)) }
    if (parsed.status !== 'success') throw new Error((c.pluginName || 'LightMemo') + ' status=' + parsed.status + ' ' + (parsed.error || ''))
    const res = parsed.result || {}
    if (res.plugin_error) throw new Error((c.pluginName || 'LightMemo') + ' plugin_error: ' + res.plugin_error)
    const content = Array.isArray(res.content) ? res.content : []
    return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
  }

  const debugSink = cfg.debugLog ? (line) => appendLine(cfg.debugLog, line) : null
  const tracker = createUserMessageTracker({ todoTools: cfg.todoTools })
  // 同步精排会把边界等待从秒级拉到十秒级：启用 rerank 时换用独立预算，纯检索仍走 timeoutMs。
  const rerank = normalizeRerank(cfg.rerank)
  const jev = normalizeRerank(cfg.jev)
  const rankEnabled = rerank !== null || jev !== null
  const boundaryTimeoutMs = rankEnabled
    ? (Number(cfg.rerankTimeoutMs) || DEFAULTS.rerankTimeoutMs)
    : cfg.timeoutMs
  const engine = createRecallEngine({ callRecall, config: { ...cfg, timeoutMs: boundaryTimeoutMs }, logger: ctx.logger, writeDebug: debugSink, tracker })
  ctx.on('session/event', (session, event) => tracker.observe(session, event))
  ctx.on('agent/pre-step', engine.listener)
  if (cfg.debug && debugSink) debugSink(JSON.stringify({ ts: Date.now(), phase: 'plugin-loaded', version: VERSION, mode: 'user-forge-activation-boundary', pulse: cfg.pulseEnabled !== false, rerank: rerank === null ? false : rerank, jev: jev === null ? false : jev, timeoutMs: boundaryTimeoutMs }))
}

/** 追加一行 JSONL 决策日志；失败静默（日志绝不影响组装）。 */
function appendLine(path, line) {
  try {
    const fs = globalThis.process.getBuiltinModule('fs')
    if (fs) fs.appendFileSync(path, line + '\n', 'utf8')
  } catch { /* 决策日志失败不影响组装 */ }
}

export default { name, inject, apply }
