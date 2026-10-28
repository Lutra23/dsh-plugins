import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getEngineClient } from './engine-client.js'
import commands from './commands.cjs'
import paramSpec from './param-spec.cjs'
import { installDshPanel } from './dsh-panel.js'
import { installTaskBridge } from './task-bridge.js'
import { taskEvent } from './task-events.js'
import { installHostTools } from './host-tools.cjs'
import { installContextRuntime } from './context-runtime.js'
import { installGoalTools } from './goal-host-tools.cjs'
import { createRequire } from 'node:module'

/** 本进程加载时的包版本：与「磁盘现值」「daemon pluginVersion」三方对账用（见 Version 命令）。 */
const pkg = createRequire(import.meta.url)('../package.json')

/** 补丁形状探测（P0.2）：纯函数，命中才给 advisory，不阻断写入；判据与信号表见 lib/patch-shape.cjs。 */
const { patchShapeHint } = createRequire(import.meta.url)('./patch-shape.cjs')
/** 会引入新代码路径的命令：只有这些才需要 owner-first 提示（读类命令提示是噪声）。 */
const WRITE_COMMANDS = new Set(['EditCode', 'CreateFile', 'MoveCode', 'CopyCode', 'RemoveFile', 'MoveFile'])
/** reason 枚举前缀（P1.1）：每会话只提醒一次的软提示，零阻断；词表与解析见 lib/reason-taxonomy.cjs。 */
const { createReasonReminder } = createRequire(import.meta.url)('./reason-taxonomy.cjs')
/** 进程级单例：提醒状态挂会话 id，跨调用保持（每会话仅一次，避免 3,066 次 EditCode 逐次弹提示）。 */
const reasonReminder = createReasonReminder()
/** 错误导航器（P3.2）：引擎 74 处 throw 零处填 error.next，本模块从文案兜底推断出路。 */
const { suggestNext } = createRequire(import.meta.url)('./error-navigator.cjs')
/** 改动必要性检查（P4.1）：命中 target===replace 的空写时提示，不阻断。 */
const { noChangeHint } = createRequire(import.meta.url)('./change-necessity.cjs')
/** 退役触发器检查（P4.2）：引入 compat/fallback 却未说明何时删时提示，不阻断。 */
const { retirementHint } = createRequire(import.meta.url)('./retirement-trigger.cjs')

/**
 * dsh-project-forge · 工程施工台 + 代码搜索器（DSH 移植版）
 *
 * 把 VCPChat 的 ProjectForge（hybridservice/direct，23 命令）与 VCPToolBox 的
 * CodeSearcher（Rust 原生二进制）移植为 DSH 常驻工具，不再依赖 VCP / VChat 进程。
 *
 * 结构：
 *   project_forge   单个工具承载全部施工命令（command 分发），语义与 VCP 版逐字一致
 *   code_searcher   Rust 二进制直连，按 cwd 搜索（每次调用可指定 root）
 *
 * 引擎侧（lib/server.cjs）以子进程常驻，SQLite 连接与 AST 索引器进程得以在多次调用间存活；
 * vendor/ 内是 VCPChat 原版代码的逐字副本，只替换工作区门面与回收站实现。
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = path.join(ROOT, 'lib', 'server.cjs')
const DATA_DIR = path.join(ROOT, 'data')
// 二进制不随仓库分发（体积 + 许可），从 GitHub Release 下载后放到下列任一目录：
//   1) $DSH_PROJECTFORGE_BIN/CodeSearcher.exe
//   2) <包目录>/tools/CodeSearcher.exe
//   3) ~/.dsh/projectforge/bin/CodeSearcher.exe
const BIN_DIRS = [
  process.env.DSH_PROJECTFORGE_BIN,
  path.join(ROOT, 'tools'),
  path.join(os.homedir(), '.dsh', 'projectforge', 'bin'),
].filter(Boolean)
const SEARCHER_EXE = BIN_DIRS.map((dir) => path.join(dir, 'CodeSearcher.exe')).find(existsSync)
  || path.join(BIN_DIRS[BIN_DIRS.length - 1], 'CodeSearcher.exe')

/**
 * 判断路径是否落在 asar 归档内部。
 * 宿主 Electron 的 fs 打了 asar 补丁，能 stat 到归档里的"文件"；而真实子进程
 * （Windows 内核）看不见这层。这种"宿主可见、子进程不可见"的路径一旦拿去当
 * cwd，spawn 必失败且报错只写可执行名，极易把排查引向错误的嫌疑对象。
 * 注意 `app.asar.unpacked` 是磁盘上的实体目录，不是归档内部，故按段后缀精确判断。
 */
function isAsarPath(p) {
  return String(p).split(/[\\/]+/u).some(seg => seg.toLowerCase().endsWith('.asar'))
}

/** 与 VCP 版一致的命令清单（顺序即语义分组）。 */
const { COMMANDS, slimParams, renderParamHelp, commandSummary } = paramSpec

/** 需要通过 stdin 传大块 content 的命令，避免 JSON 体过大时的命令行限制。 */
const SEARCHER_DEFAULTS = { max_results: 50 }

/**
 * 会读取 `revertOnSyntaxError` 的写命令（小写）。
 * EditCode / MoveCode / CopyCode 经 `editOptions(args)`，CreateFile 自行解析；
 * ResolveEdit 沿用签发票据时的取值，无需在此录入。
 */
const SYNTAX_GUARDED = new Set(['editcode', 'createfile', 'movecode', 'copycode'])

export default {
  name: 'project-forge',
  inject: ['subprocess', 'tools'],
  apply(ctx) {
    let nodePromise = null
    function nodePath() {
      if (nodePromise) return nodePromise
      nodePromise = ctx.subprocess.resolveExecutable('node').catch((error) => {
        nodePromise = null
        throw error
      })
      return nodePromise
    }

    function dshWorkspaces() {
      const registry=ctx.get('workspaceRegistry');
      return registry?.list?.().map(ws=>({id:ws.id,alias:ws.title||path.basename(ws.path),path:ws.path,enabled:ws.enabled!==false}))||null
    }
    let client
    async function engineClient(){return client ||= getEngineClient({node:await nodePath(),dataDir:DATA_DIR,workspaces:dshWorkspaces})}
    const taskBridge=installTaskBridge(ctx,engineClient,defineTool)
    ctx.logger?.info?.('[project-forge] loaded 0.4.0-local.1: session handoff, synchronized Todo, continuation context')
    installDshPanel(ctx,engineClient,taskBridge)
    installHostTools(ctx,engineClient,defineTool,taskBridge)
    installContextRuntime(ctx,engineClient,taskBridge)
    installGoalTools(ctx,engineClient,defineTool,taskBridge)
    async function engineCall(args,timeoutMs,signal,operationId){return (await engineClient()).request({args,operationId},{timeoutMs,signal})}
    function receiptText(r){return r? '\n\n操作回执：'+r.operationId+' · '+r.status+(r.error?' · '+r.error:''):''}
    ctx.tools.register(defineTool({
      name:'forge_panel',description:'打开施工图工程管理窗口，或查询/取消本工程操作。窗口可查看 Markdown、工程待办、报告和差异，并预检单文件回退。',
      parameters:{action:{type:'string',enum:['open','status','cancel'],required:true},operationId:{type:'string',description:'status/cancel 的目标操作回执 ID。status 可省略——省略时改按 projectId 列出该工程最近操作；cancel 必填'},projectId:{type:'string',description:'工程 ID；status 未带 operationId 时用它过滤最近操作列表'}},
      output:{schema:{type:'string'},render(_a,v){return[{type:'text',text:v}]}},isConcurrencySafe(){return true},
      async execute(a){const c=await engineClient();if(a.action==='open'){await c.request({method:'panel.open'});
        return '已请求打开 DSH 内的“施工图”面板，也可直接点击左侧“施工图”。'
      }if(!a.operationId){if(a.action==='status'&&a.projectId)return JSON.stringify(await c.request({method:'operations',projectId:a.projectId}),null,2)+'\n（status 未带 operationId，已改为列出该工程最近操作；查单个回执请带 operationId）';
        throw new Error('需要 operationId（status 可改传 projectId 列出最近操作；cancel 必填 operationId）')}return JSON.stringify(await c.request({method:a.action,operationId:a.operationId}),null,2)}
    }))

    // ==================== 工具 1：project_forge ====================
    ctx.tools.register(defineTool({
      name: 'project_forge',
      description: [
        '工程施工台（ProjectForge）：面向 Agent 的工程化代码施工。',
        `命令（command）：${commandSummary()}。具体命令名见参数 command 的枚举。`,
        '',
        '典型：{"command":"EditCode","projectId":"p1a2b","path":"src/a.js#Store.put","op":"target","target":"旧","replace":"新","reason":"为什么改"}',
        '',
        '坑位（正常用法见 skill `forge-workflow` / `forge-editing`，此处只写会咬人的）：',
        '- 有任务的工程，写操作必带 `reason` + `todo`（显示的序号）；**首次写到该项即自动认领**，不必先 TaskAction start。被别的会话持有的任务不可抢写，走 handoff。',
        '- 行号模式是唯一会静默改错的姿势（陈旧行号会换掉错的那一行且报成功）：必须配 `expect`，同文件多步放同一次调用用串语法。',
        '- `op=target` 只认 `replace`：误传 `content` 会被拒绝（content 属行号模式，此前会照删 target 匹配段）。',
        '- 缺 `command` 之外的所有参数校验失败都在引擎侧返回，报错即含出路；回执 `unknown` 时先用 forge_panel 查询，写操作禁止另起 operationId 重试。',
        '- 路径一律相对工程根；工程根是 `…\\work` 时要带 `dsh-project-forge/` 前缀。',
        '',
        '参数说明：schema 只常驻高频参数的描述；其余冷参数与完整说明用 `command:"Help"`（可带 query 过滤，如 {"command":"Help","query":"pick,force"}）按需取回。版本/路径对账用 `command:"Version"`。',
      ].join('\n'),
      parameters: slimParams(),
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      isConcurrencySafe() { return false },
      async execute(args, exec) {
        const a = args || {}
        const command = String(a.command || '').trim()
        if (!command) return `**错误**：缺少 command。可用：${COMMANDS.join('、')}。`

        // 渐进式披露：冷参数的完整描述不常驻 schema，按需取回（见 lib/param-spec.cjs）。
        if (command.toLowerCase() === 'help') {
          const wanted = String(a.query || a.name || '').split(/[\s,]+/).filter(Boolean)
          const hint = wanted.length ? `（按 ${wanted.join('/')} 过滤）` : ''
          return [
            `# project_forge 参数说明${hint}`,
            '',
            `命令：${COMMANDS.join(' / ')}`,
            '',
            '## 参数（常驻仅给热参数描述；此处为完整描述）',
            renderParamHelp(wanted),
            '',
            '用法：Help 不带参数列全部；带 query（参数名，逗号或空格分隔）只列指定项，更省。',
          ].join('\n')
        }

        // 生命周期自检：改了没反应时先查哪一侧是旧的（宿主侧 index.js 要重启 App；
        // 引擎侧 task-policy/args 要 daemon 重启）。一次调用把「猜」变成「看」。
        if (command.toLowerCase() === 'version') {
          const loaded = pkg.version
          let onDisk = '(读取失败)'
          try { onDisk = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version } catch { /* 读不到就保持 '(读取失败)'——对账本身会显示出来 */ }
          let daemon = null, engineNote = ''
          try {
            const d = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'engine.json'), 'utf8'))
            const r = await fetch(d.origin + '/rpc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Forge-Key': d.key },
              body: JSON.stringify({ method: 'revision' }),
              signal: AbortSignal.timeout(2000),
            })
            const v = await r.json()
            daemon = v.ok ? { ...d, capabilities: v.result?.capabilities || {} } : null
            if (!v.ok) engineNote = `（daemon 应答异常：${v.error}）`
          } catch (e) { engineNote = `（daemon 未运行或不可达：${e.message}）` }
          const same = daemon && daemon.pluginVersion === onDisk
          const hostFresh = loaded === onDisk
          return [
            '# project_forge 版本与路径对账',
            '',
            `- 宿主侧进程加载的包版本：**${loaded}**${hostFresh ? '（与磁盘一致 ✓）' : `——⚠️ 与磁盘不一致：磁盘已是 ${onDisk}，本进程仍在跑旧码，**宿主侧改动需重启 App**（工具描述 / schema / param-spec 等）`}`,
            `- 磁盘上的包版本：${onDisk}`,
            `- 引擎侧 daemon：${daemon ? `pluginVersion **${daemon.pluginVersion}**${same ? '（与磁盘一致 ✓）' : '——⚠️ 与磁盘不一致，**需 daemon 重启**（引擎侧改动：lib/task-policy.cjs、vendor/**/args.js 等）'}｜pid ${daemon.pid}｜protocol v${daemon.protocolVersion}` : `未运行${engineNote}`}`,
            daemon ? `- daemon 能力位：${Object.entries(daemon.capabilities).map(([k, v]) => `${k}=${v}`).join('｜') || '(无)'}` : '',
            '',
            '## 路径',
            `- 包根：${ROOT}`,
            `- 数据目录：${DATA_DIR}`,
            `- 引擎声明文件：${path.join(DATA_DIR, 'engine.json')}`,
            '- 工作区白名单来源：DSH workspaceRegistry 注入（运行中新建的工作区下次调用即可用）；`data/workspaces.json` 只作回落',
            '',
            same && hostFresh
              ? '结论：两侧都在跑磁盘上的最新代码。'
              : '结论：**有旧进程在用旧码**——按上面标 ⚠️ 的那一层重启（宿主侧重启 App；引擎侧走 daemon shutdown，之后任一调用会自动拉起）。',
          ].filter(Boolean).join('\n')
        }

        const payload = commands.normalize(a)
        if(exec?.agent) {
          payload.sessionid=exec.agent.session.id
          if(payload.command==='TaskAction'&&payload.taskaction==='resume') {
            const events=exec.agent.session.snapshotEvents()
            payload.reactivate=(events.findLast(e=>e.type==='user/message'&&e.data.source?.kind==='user')?.seq??-1)>(events.map(taskEvent).findLast(e=>e.type==='forge/task-boundary')?.seq??-1)
          }
        }

        try {
          const result = await engineCall(payload, 180000, exec?.signal, a.operationId)
          let syncWarning=''
          if(exec?.agent)try{await taskBridge.bindAfterTool(exec.agent,payload.command,result.details?.project?.id||payload.projectid,result.receipt?.status)}catch(error){
            syncWarning='\n\n操作回执保持有效；会话显示同步暂未完成，下一步将重试。可用 BindProject 重新同步：'+error.message
          }
          const parts = (result && result.content) || []
          const text = parts.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n')
          // P0.2：写命令且回执成功时附补丁形状提示（纯函数，未命中返回空串，零额外引擎调用）。
          const shapeHint = WRITE_COMMANDS.has(command) && result.receipt?.status === 'committed'
            ? patchShapeHint(a)
            : ''
          // P1.1：reason 缺枚举前缀时，每会话只提醒一次（不阻断，原文照常记录）。
          const reasonHint = WRITE_COMMANDS.has(command) && result.receipt?.status === 'committed'
            ? reasonReminder.build(a, exec?.agent?.session?.id)
            : ''
          // P4.1：改动必要性——target 与 replace 相同时提示（0.40% 频率，不阻断）。
          const necessityHint = result.receipt?.status === 'committed' ? noChangeHint(a) : ''
          // P4.2：退役触发器——引入 compat/fallback 却未说明何时删时提示（1.87% 频率，不阻断）。
          const retireHint = result.receipt?.status === 'committed' ? retirementHint(a) : ''
          if (a.minify) return minify(text)+shapeHint+reasonHint+necessityHint+retireHint+receiptText(result.receipt)+syncWarning
          return (text || `（${command} 未返回内容）`)+shapeHint+reasonHint+necessityHint+retireHint+receiptText(result.receipt)+syncWarning
        } catch (error) {
          const message = error && error.message ? error.message : String(error)
          const receipt = error && error.receipt
          const next = (error && error.next ? String(error.next) : '') || suggestNext(message)
          const guidance = next ? '\n\n下一步：' + next : !receipt
            ? '\n\n未取得操作回执（本操作未进入引擎队列）：排查原因后可用同一 operationId 重发。'
            : receipt.status === 'unknown'
              ? '\n\n下一步：结果未知，先用 forge_panel（action=status, operationId=' + receipt.operationId + '）查询回执再决定；写操作禁止另起 operationId 自动重试。'
              : ''
          return `**${command} 未完成**：${message}`+receiptText(receipt)+guidance
        }
      },
    }))

    /** 压缩长返回：保留标题、diff 与结论，裁掉冗长上下文。 */
    function minify(text) {
      const lines = String(text).split('\n')
      const out = []
      let inFence = false
      for (const line of lines) {
        if (/^```/.test(line)) { inFence = !inFence; out.push(line); continue }
        if (inFence) { out.push(line); continue }
        if (/^#{1,4}\s/.test(line) || /^\s*[-*]\s/.test(line) || /diff|Diff|结论|✅|⚠️|错误|失败/.test(line)) out.push(line)
      }
      return out.slice(0, 120).join('\n') || String(text).slice(0, 2000)
    }

    // ==================== 工具 2：read_image ====================
    // 替换 tool-fs 后唯一的真实缺口：dsh-tool-fs 的 read/write/edit 与 read_image 是同
    // 一行注册的（apply() 里全有或全无，没有开关），而 read_image 需要 attachments 服务
    // 把磁盘图像转成模型可吃的 durable 引用。这里照官方实现复刻：读字节 → saveImage →
    // 渲染成 [text, image] 两个 content block（ImageBlock 形如 {type:'image', attachment}）。
    const IMAGE_MEDIA_TYPES = new Map([
      ['.png', 'image/png'],
      ['.jpg', 'image/jpeg'],
      ['.jpeg', 'image/jpeg'],
      ['.webp', 'image/webp'],
      ['.gif', 'image/gif'],
    ])

    ctx.inject(['attachments'], (imageCtx) => {
      const attachments = imageCtx.get('attachments')
      if (!attachments) return
      imageCtx.tools.register(defineTool({
        name: 'read_image',
        description: '读取 PNG/JPEG/WebP/GIF 图像并返回图像本身（需当前模型支持图像输入）。',
        parameters: {
          file_path: { type: 'string', required: true, description: '图像文件路径。' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              attachment: { type: 'object', additionalProperties: true, required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
          render(_args, value) {
            return [
              { type: 'text', text: `#### ${value.path}（${value.bytes} 字节，${value.width}×${value.height}）` },
              { type: 'image', attachment: value.attachment },
            ]
          },
        },
        isConcurrencySafe() { return true },
        async execute(args, exec) {
          const raw = String((args && args.file_path) || '').trim()
          if (!raw) throw new Error('file_path 不能为空。')
          const ext = path.extname(raw).toLowerCase()
          const mediaType = IMAGE_MEDIA_TYPES.get(ext)
          if (!mediaType) throw new Error(`无法读取「${raw}」：read_image 只接受 PNG/JPEG/WebP/GIF。`)
          if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
            throw new Error(`无法读取「${raw}」：本部署不接受 ${mediaType}。`)
          }
          const abs = path.isAbsolute(raw) ? raw : path.resolve(execCwd() || process.cwd(), raw)
          const data = await fs.readFile(abs)
          const cap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
          if (data.length > cap) throw new Error(`无法读取「${raw}」：${data.length} 字节超过上限 ${cap}。`)
          const ref = await attachments.saveImage({ data, mediaType, name: path.basename(abs) })
          return { path: abs, attachment: ref, bytes: ref.bytes, width: ref.width, height: ref.height }
        },
      }))
    })

    // ==================== 工具 3：code_searcher ====================
    ctx.tools.register(defineTool({
      name: 'code_searcher',
      description: [
        '代码搜索器（CodeSearcher，Rust 原生二进制，VCPToolBox 移植版）：在指定目录下按正则/字面量高速搜索代码，返回带行号与上下文的 Markdown 结果。',
        '',
        '语义：',
        '- root：搜索根目录（默认取当前会话工作目录）。搜索结果路径相对该根。',
        '- query 默认按正则（Rust regex 语法）逐行匹配；分支 a|b、字符类、量词、分组、锚点、内联 (?i) 均支持；不支持环视、反向引用与跨行。',
        '- 非法正则会自动回落为字面量搜索并在结果中提示。含 ( [ . * 等符号的代码片段建议 is_regex=false。',
        '- include 指定后替代扩展名白名单（如 *.rs,*.toml 或 routes/**/*.js,!*.min.js）。',
        '- 上下文行相邻片段会自动合并；结果按文件路径稳定排序，截断时给出总数。',
        '',
        '典型：{"query":"function\\\\s+\\\\w+\\\\(", "root":"C:\\\\proj\\\\src", "include":"*.js", "context_lines":3}',
      ].join('\n'),
      parameters: {
        query: { type: 'string', required: true, description: '要搜索的正则表达式或关键词。' },
        root: { type: 'string', description: '搜索根目录的绝对路径（默认当前会话工作目录）。必须是归档外的实体目录——asar 内部路径宿主可见、子进程不可用。' },
        search_path: { type: 'string', description: '相对 root 的目录或文件路径（默认整个 root）。越界或不存在会报错。' },
        include: { type: 'string', description: '逗号分隔的文件通配符，指定后替代扩展名白名单，如 *.rs,*.toml。' },
        is_regex: { type: 'boolean', description: '是否按正则解析 query，默认 true；false 时按字面文本搜索。' },
        case_sensitive: { type: 'boolean', description: '是否区分大小写，默认 false。' },
        whole_word: { type: 'boolean', description: '是否全词匹配，默认 false。' },
        context_lines: { type: 'integer', description: '匹配行前后额外显示的上下文行数，默认 2，上限 20。' },
        max_results: { type: 'integer', description: '最多展示的匹配行数，默认 50，上限 500。' },
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) { return [{ type: 'text', text: value }] },
      },
      isConcurrencySafe() { return true },
      async execute(args) {
        const a = args || {}
        const query = String(a.query || '').trim()
        if (!query) return '**错误**：缺少 query。'

        const root = a.root || execCwd() || process.cwd()
        const absRoot = path.resolve(root)
        try {
          await fs.stat(absRoot)
        } catch {
          return `**错误**：root 不存在：${absRoot}`
        }
        const base = await projectBaseFor(absRoot)
        // 上面的 fs.stat 走的是宿主 fs，会穿透 asar，因此归档内部路径能过关；
        // 但 cwd 要交给真实子进程，此处按子进程的可见性补一道闸，避免失败被推迟到 spawn。
        const blocked = isAsarPath(base) ? base : (isAsarPath(absRoot) ? absRoot : null)
        if (blocked !== null) {
          const which = base === blocked ? '工作目录' : '搜索根'
          return `**搜索错误**：${which}位于 asar 归档内，外部子进程无法访问：\`${blocked}\``
            + `\n\n宿主 Electron 的 fs 能读到 asar 内部，所以此路径通过了存在性检查；`
            + `但 CodeSearcher 是原生程序，没有 asar 层。请改传归档外的实体目录。`
        }
        const payload = { query }
        if (a.is_regex === false) payload.is_regex = false
        if (a.case_sensitive === true) payload.case_sensitive = true
        if (a.whole_word === true) payload.whole_word = true
        if (a.context_lines !== undefined) payload.context_lines = String(a.context_lines)
        if (a.max_results !== undefined) payload.max_results = Number(a.max_results)
        if (base !== absRoot) {
          // CodeSearcher 把 search_path 按 base（项目根）解析；root 无项目标记被上溯时，用绝对路径锚回 root。
          payload.search_path = a.search_path ? path.resolve(absRoot, String(a.search_path)) : absRoot
        } else if (a.search_path) {
          payload.search_path = String(a.search_path)
        }
        if (a.include) payload.include = String(a.include)

        try {
          const handle = ctx.subprocess.spawn({
            argv: [SEARCHER_EXE],
            cwd: base,
            stdio: {
              stdin: { data: JSON.stringify(payload) },
              stdout: { maxBytes: 8 * 1024 * 1024 },
              stderr: { maxBytes: 64 * 1024 },
            },
            graceMs: 3000,
          })
          const outcome = await handle.done
          const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
          const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
          if (!out.trim()) {
            return `**搜索失败**：无输出（退出码 ${outcome.exitCode}）${err ? '：' + err.trim().slice(0, 400) : ''}`
          }
          let parsed
          try {
            parsed = JSON.parse(out)
          } catch (_e) {
            return `**搜索返回无法解析**：${out.slice(0, 400)}`
          }
          if (parsed.status !== 'success') return `**搜索失败**：${parsed.error || '未知错误'}`
          // 新版二进制自己渲染 Markdown；兼容旧版返回结构化命中数组的情况。
          const content = (parsed.result && parsed.result.content) || null
          if (Array.isArray(content)) {
            return content.filter(b => b && b.type === 'text').map(b => b.text).join('\n') || '（无内容）'
          }
          return renderHits(parsed.result || [], root, query, payload)
        } catch (error) {
          const msg = error && error.message ? error.message : String(error)
          // Node 在 cwd 无效时同样报 "spawn <exe> ENOENT"，且报错里只写可执行文件名。
          // 不说明白，这个 ENOENT 会把人带去查一个完好无损的二进制。
          if (/ENOENT/u.test(msg)) {
            return '**搜索错误**：' + msg + String.fromCharCode(10, 10) + '⚠️ 两种可能：① `' + SEARCHER_EXE + '` 不存在——从 GitHub Release 下载 CodeSearcher.exe 放进该目录，或设 `DSH_PROJECTFORGE_BIN` 指向其所在目录；② cwd 对真实子进程不可用——Node 对两者都报 ENOENT 且只点名可执行文件。本次 cwd：`' + base + '`'
          }
          return `**搜索错误**：${msg}`
        }
      },
    }))

    /**
     * 复刻 CodeSearcher（main.rs find_project_root）的项目根上溯：从 root 向上
     * 最多 5 层找 .git（目录）/ package.json / Cargo.toml，命中即项目根；否则回 root 自身。
     * exe 以 base 为 cwd 起跑时第一层即命中，不再继续上溯——
     * 避免 root 自身不带项目标记时，搜索根被祖先目录（如主目录的 .git）绑架成全量扫描。
     */
    async function projectBaseFor(root) {
      let probe = root
      for (let i = 0; i < 5; i++) {
        if (await hasProjectMark(probe)) return probe
        const parent = path.dirname(probe)
        if (parent === probe) break
        probe = parent
      }
      return root
    }

    async function hasProjectMark(dir) {
      try {
        const stat = await fs.stat(path.join(dir, '.git'))
        if (stat.isDirectory()) return true
      } catch { /* 无 .git 或非目录，继续查其余标记 */ }
      for (const mark of ['package.json', 'Cargo.toml']) {
        try {
          const s = await fs.stat(path.join(dir, mark))
          if (s.isFile()) return true
        } catch { /* 缺该标记，试下一个 */ }
      }
      return false
    }

    /** 当前会话的工作目录（宿主注入）；取不到时回退进程 cwd。 */
    function execCwd() {
      try {
        const agents = ctx.get('agents')
        const agent = agents && typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : null
        const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : null
        return typeof cwd === 'string' && cwd ? cwd : null
      } catch (_e) {
        return null
      }
    }

    /** 把 CodeSearcher 的结构化结果渲染成 Markdown（贴近 VCP 版输出格式）。 */
    function renderHits(hits, root, query, payload) {
      if (!hits.length) {
        return `## 代码搜索结果\n\n- 查询：\`${query}\`\n- 范围：\`${root}\`\n- 命中：0 处`
      }
      const byFile = new Map()
      for (const hit of hits) {
        const file = String(hit.file_path || '').replace(/\\/g, '/')
        if (!byFile.has(file)) byFile.set(file, [])
        byFile.get(file).push(hit)
      }
      const blocks = []
      for (const [file, list] of byFile) {
        const lines = []
        list.sort((x, y) => x.line_number - y.line_number)
        let lastLine = null
        for (const hit of list) {
          const before = hit.context_before || []
          const startLine = hit.line_number - before.length
          if (lastLine !== null && startLine > lastLine + 1) lines.push('--')
          before.forEach((text, i) => {
            const n = startLine + i
            if (lastLine !== null && n <= lastLine) return
            lines.push(`${n}-${text}`)
          })
          lines.push(`${hit.line_number}:${hit.match_column || 1}:${hit.line_content}`)
          let n = hit.line_number
          for (const text of (hit.context_after || [])) {
            n += 1
            lines.push(`${n}-${text}`)
          }
          lastLine = n
        }
        blocks.push(`### \`${file}\`\n${list.length} 行匹配\n\n\`\`\`\n${lines.join('\n')}\n\`\`\``)
      }
      return [
        '## 代码搜索结果',
        '',
        `- 查询：\`${query}\`（${payload.is_regex ? '正则' : '字面量'}；区分大小写：${payload.case_sensitive ? '是' : '否'}）`,
        `- 范围：\`${root}\`${payload.include ? `；文件过滤：\`${payload.include}\`` : ''}`,
        `- 命中 ${byFile.size} 个文件，共 ${hits.length} 行`,
        '',
        blocks.join('\n\n'),
      ].join('\n')
    }
  },
}
